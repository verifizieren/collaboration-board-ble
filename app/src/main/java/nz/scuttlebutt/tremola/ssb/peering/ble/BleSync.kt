package nz.scuttlebutt.tremola.ssb.peering.ble

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.BluetoothLeAdvertiser
import android.bluetooth.le.BluetoothLeScanner
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.ParcelUuid
import android.util.Base64
import android.util.Log
import nz.scuttlebutt.tremola.ssb.TremolaState
import nz.scuttlebutt.tremola.ssb.db.entities.BoardOperation
import nz.scuttlebutt.tremola.ssb.db.entities.LogEntry
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.ArrayDeque
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.zip.Deflater
import java.util.zip.Inflater
import kotlin.math.max
import kotlin.math.min

internal data class BleOutboundFrame(
    val value: ByteArray,
    val messageKey: String,
    val completesMessage: Boolean,
    val priority: Boolean
)

/** A bounded per-link queue that keeps retries but coalesces duplicate messages. */
internal class BleOutboundQueue(private val maxFrames: Int) {
    private val priorityFrames = ArrayDeque<BleOutboundFrame>()
    private val normalFrames = ArrayDeque<BleOutboundFrame>()
    private val messageKeys = HashSet<String>()
    private val priorityReserve = min(MAX_PRIORITY_FRAME_RESERVE, maxFrames / 4)

    val size: Int get() = priorityFrames.size + normalFrames.size

    fun isEmpty(): Boolean = priorityFrames.isEmpty() && normalFrames.isEmpty()

    fun isNotEmpty(): Boolean = !isEmpty()

    fun contains(messageKey: String): Boolean = messageKeys.contains(messageKey)

    fun enqueue(
        messageKey: String,
        values: List<ByteArray>,
        priority: Boolean,
        hasInFlightFrame: Boolean
    ): Boolean {
        if (messageKeys.contains(messageKey)) {
            if (priority) promote(messageKey)
            return true
        }
        if (values.isEmpty()) return false
        val pending = size + if (hasInFlightFrame) 1 else 0
        val frameLimit = if (priority) maxFrames else max(1, maxFrames - priorityReserve)
        if (pending < 0 || values.size > frameLimit || pending + values.size > frameLimit) return false

        val wrapped = values.mapIndexed { index, value ->
            BleOutboundFrame(value, messageKey, index == values.lastIndex, priority)
        }
        if (priority) {
            wrapped.forEach { priorityFrames.addLast(it) }
        } else {
            wrapped.forEach { normalFrames.addLast(it) }
        }
        messageKeys.add(messageKey)
        return true
    }

    private fun promote(messageKey: String) {
        val promoted = ArrayList<BleOutboundFrame>()
        val iterator = normalFrames.iterator()
        while (iterator.hasNext()) {
            val frame = iterator.next()
            if (frame.messageKey == messageKey) {
                iterator.remove()
                promoted.add(frame.copy(priority = true))
            }
        }
        promoted.forEach { priorityFrames.addLast(it) }
    }

    fun removeFirst(): BleOutboundFrame {
        return if (priorityFrames.isNotEmpty()) priorityFrames.removeFirst() else normalFrames.removeFirst()
    }

    fun addFirst(frame: BleOutboundFrame) {
        if (frame.priority) priorityFrames.addFirst(frame) else normalFrames.addFirst(frame)
    }

    fun complete(frame: BleOutboundFrame) {
        if (frame.completesMessage) messageKeys.remove(frame.messageKey)
    }

    fun clear() {
        priorityFrames.clear()
        normalFrames.clear()
        messageKeys.clear()
    }

    companion object {
        private const val MAX_PRIORITY_FRAME_RESERVE = 256
    }
}

/**
 * BLE transport for Tremola logs and the Collaboration Board.
 *
 * Board operations use their own encrypted queue, acknowledgements, and
 * per-author frontiers. They are also appended to Tremola's signed log for
 * durable integration with the host app.
 */
@SuppressLint("MissingPermission")
class BleSync(
    private val activity: Activity,
    private val tremolaState: TremolaState
) {
    private val worker: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor(
        TremolaState.threadFactory("BLE Sync", true)
    )

    private val bluetoothManager =
        activity.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
    private val bluetoothAdapter: BluetoothAdapter? = bluetoothManager.adapter
    private val clientLinks = ConcurrentHashMap<String, ClientLink>()
    private val serverLinks = ConcurrentHashMap<String, ServerLink>()
    private val inbound = ConcurrentHashMap<String, InboundMessage>()
    private val pendingEvents = ConcurrentHashMap<FeedSequence, PendingEvent>()
    private val remoteFeedIds = ConcurrentHashMap<String, String>()
    private val remoteProtocolVersions = ConcurrentHashMap<String, Int>()
    private val authenticatedBoardPeers = ConcurrentHashMap<String, String>()
    private val boardMembers = ConcurrentHashMap<String, String>()
    private val boardAdmissions = ConcurrentHashMap<String, String>()
    private val ownerPairingChallenges = ConcurrentHashMap<PairingChallengeKey, OwnerPairingChallenge>()
    private val joinPairingChallenges = ConcurrentHashMap<String, JoinPairingChallenge>()
    private val pairingReservations = ConcurrentHashMap<String, PairingReservation>()
    private val pairingFailuresByFeed = ConcurrentHashMap<String, Int>()
    private val pendingBoardDeliveries = ConcurrentHashMap<BoardDeliveryKey, PendingBoardDelivery>()
    private val connecting = ConcurrentHashMap.newKeySet<String>()
    private val nextMessageId = AtomicInteger(1)
    private val lifecycleGeneration = AtomicInteger(0)
    private val serverSendLock = Any()
    private val boardConfigLock = Any()
    private val boardWriteLock = Any()
    private val boardPrefs = activity.getSharedPreferences(BOARD_PREFS, Context.MODE_PRIVATE)
    @Volatile private var boardConfig: BoardRoomConfig? =
        BoardProtocol.parseConfig(boardPrefs.getString(BOARD_CONFIG_KEY, "") ?: "")
    @Volatile private var boardPairingSession: BoardPairingSession? = null
    @Volatile private var pendingBoardJoin: PendingBoardJoin? = null
    @Volatile private var pairingFailureCount = 0

    private var scanner: BluetoothLeScanner? = null
    private var advertiser: BluetoothLeAdvertiser? = null
    private var gattServer: BluetoothGattServer? = null
    private var frameCharacteristic: BluetoothGattCharacteristic? = null
    @Volatile private var isRunning = false
    @Volatile private var isScanning = false
    @Volatile private var isAdvertising = false
    @Volatile private var advertisingRequested = false
    @Volatile private var gattServiceReady = false
    @Volatile private var lastScanStartedAt = 0L
    @Volatile private var lastBoardFrontierAt = 0L
    private var activeServerLink: ServerLink? = null
    private var syncTask: ScheduledFuture<*>? = null

    private data class ClientLink(
        val address: String,
        val gatt: BluetoothGatt,
        @Volatile var characteristic: BluetoothGattCharacteristic? = null,
        @Volatile var mtu: Int = DEFAULT_MTU,
        @Volatile var ready: Boolean = false,
        var servicesRequested: Boolean = false,
        var subscribing: Boolean = false,
        var writing: Boolean = false,
        var writeOperationId: Int = 0,
        var writeFailures: Int = 0,
        var inFlightFrame: BleOutboundFrame? = null,
        val queue: BleOutboundQueue = BleOutboundQueue(MAX_QUEUED_FRAMES_PER_LINK)
    )

    private data class ServerLink(
        val address: String,
        val device: BluetoothDevice,
        @Volatile var mtu: Int = DEFAULT_MTU,
        @Volatile var subscribed: Boolean = false,
        @Volatile var useIndications: Boolean = false,
        var sending: Boolean = false,
        var sendOperationId: Int = 0,
        var sendFailures: Int = 0,
        var inFlightFrame: BleOutboundFrame? = null,
        val queue: BleOutboundQueue = BleOutboundQueue(MAX_QUEUED_FRAMES_PER_LINK)
    )

    private data class InboundMessage(
        val total: Int,
        val kind: Int,
        @Volatile var updatedAt: Long = System.currentTimeMillis(),
        val chunks: MutableMap<Int, ByteArray> = mutableMapOf()
    )

    private data class FeedSequence(val feedId: String, val sequence: Int)

    private data class PendingEvent(
        val entry: LogEntry,
        val sourcePeerAddress: String,
        val createdAt: Long = System.currentTimeMillis()
    )

    private data class BoardDeliveryKey(val peerFeedId: String, val operationId: String)

    private data class PairingChallengeKey(
        val peerAddress: String,
        val feedId: String,
        val joinNonce: String
    )

    private data class BoardPairingSession(
        val roomId: String,
        val code: String,
        val expiresAt: Long
    )

    private data class PendingBoardJoin(
        val code: String,
        val username: String,
        val joinNonce: String,
        val startedAt: Long
    )

    private data class OwnerPairingChallenge(
        val challenge: BoardPairingChallenge,
        val message: JSONObject,
        val createdAt: Long,
        @Volatile var acceptedProof: String? = null,
        @Volatile var offer: JSONObject? = null
    )

    private data class JoinPairingChallenge(
        val challenge: BoardPairingChallenge,
        val request: JSONObject,
        val createdAt: Long
    )

    private data class PairingReservation(
        val username: String,
        val expiresAt: Long
    )

    private data class PendingBoardDelivery(
        val operation: BoardOperation,
        @Volatile var lastSentAt: Long = 0L,
        @Volatile var attempts: Int = 0
    )

    private data class OutboundAttempt(
        val frame: BleOutboundFrame,
        val operationId: Int
    )

    init {
        loadBoardProfile()
        restoreBoardPairingSession()
    }

    fun configureBoard(configJson: String): Boolean {
        val requested = BoardProtocol.parseConfig(configJson) ?: return false
        return activateBoard(requested)
    }

    private fun activateBoard(requested: BoardRoomConfig): Boolean {
        val ownFeed = tremolaState.idStore.identity.toRef()
        synchronized(boardConfigLock) {
            val changedRoom = boardConfig?.roomId != requested.roomId ||
                boardConfig?.roomKey?.contentEquals(requested.roomKey) != true
            if (changedRoom) persistBoardProfile()
            boardConfig = requested
            if (changedRoom) {
                authenticatedBoardPeers.clear()
                pendingBoardDeliveries.clear()
                boardMembers.clear()
                boardAdmissions.clear()
                pairingReservations.clear()
                clearBoardPairingSessionLocked()
            }
            loadBoardProfile()
            val loadedVerifier = boardConfig?.codeVerifier.orEmpty()
            val next = requested.copy(
                codeVerifier = requested.codeVerifier.ifBlank { loadedVerifier }
            )
            boardConfig = next
            boardPrefs.edit().putString(BOARD_CONFIG_KEY, BoardProtocol.configJson(next)).apply()
            boardMembers[next.ownerId] = boardMembers[next.ownerId] ?: "Owner"
            boardMembers[ownFeed] = next.username
            persistBoardMembers()
            persistBoardAdmissions()
        }
        executeWorker {
            sendBoardHelloToAll()
            reportStatus("Board ready")
        }
        return true
    }

    fun startBoardPairing(code: String): Boolean {
        val cleanCode = code.trim()
        val config = boardConfig ?: return false
        val ownFeed = tremolaState.idStore.identity.toRef()
        if (ownFeed != config.ownerId || !BoardProtocol.isValidPairingCode(cleanCode)) return false
        synchronized(boardConfigLock) {
            val next = config.copy(
                codeVerifier = BoardProtocol.pairingCodeVerifier(config.roomId, cleanCode)
            )
            boardConfig = next
            boardPrefs.edit().putString(BOARD_CONFIG_KEY, BoardProtocol.configJson(next)).apply()
            persistBoardProfile()
            boardPairingSession = BoardPairingSession(
                config.roomId,
                cleanCode,
                System.currentTimeMillis() + BOARD_PAIRING_SESSION_MS
            )
            ownerPairingChallenges.clear()
            pairingFailuresByFeed.clear()
            pairingFailureCount = 0
            persistBoardPairingSessionLocked()
        }
        reportStatus("Invite code ready for 10 minutes")
        return true
    }

    fun beginBoardJoin(requestJson: String): Boolean {
        val request = try {
            JSONObject(requestJson)
        } catch (_: Exception) {
            return false
        }
        val code = request.optString("c", "").trim()
        val username = BoardProtocol.cleanUsername(request.optString("u", ""))
        if (boardConfig != null || !BoardProtocol.isValidPairingCode(code) || username.isBlank()) {
            return false
        }
        synchronized(boardConfigLock) {
            pendingBoardJoin = PendingBoardJoin(
                code,
                username,
                BoardProtocol.newPairingNonce(),
                System.currentTimeMillis()
            )
            joinPairingChallenges.clear()
        }
        executeWorker {
            sendPairingProbeToAll()
            reportStatus("Looking for board owner")
        }
        return true
    }

    fun closeBoard() {
        synchronized(boardConfigLock) {
            persistBoardProfile()
            boardConfig = null
            boardMembers.clear()
            boardAdmissions.clear()
            authenticatedBoardPeers.clear()
            pendingBoardDeliveries.clear()
            pendingBoardJoin = null
            joinPairingChallenges.clear()
            pairingReservations.clear()
            clearBoardPairingSessionLocked()
            boardPrefs.edit()
                .remove(BOARD_CONFIG_KEY)
                .remove(BOARD_MEMBERS_KEY)
                .remove(BOARD_MEMBERS_ROOM_KEY)
                .remove(BOARD_ADMISSIONS_KEY)
                .remove(BOARD_ADMISSIONS_ROOM_KEY)
                .apply()
        }
        reportStatus("Board closed")
    }

    fun leaveBoard() {
        closeBoard()
    }

    fun deleteBoard(requestJson: String): Boolean {
        val request = try {
            JSONObject(requestJson)
        } catch (_: Exception) {
            return false
        }
        val roomId = request.optString("r", "")
        val code = request.optString("c", "").trim()
        if (!BoardProtocol.isValidPairingCode(code)) return false

        val accepted = synchronized(boardConfigLock) {
            if (boardConfig?.roomId == roomId) return@synchronized false
            val stored = loadBoardConfigFromProfile(roomId) ?: return@synchronized false
            val supplied = request.optJSONObject("config")?.toString()
                ?.let { BoardProtocol.parseConfig(it) }
                ?.takeIf {
                    it.roomId == stored.roomId && it.ownerId == stored.ownerId &&
                        it.roomKey.contentEquals(stored.roomKey)
                }
            val checked = if (stored.codeVerifier.isNotBlank()) stored else supplied
            if (checked == null || !BoardProtocol.matchesPairingCode(checked, code)) {
                return@synchronized false
            }
            val editor = boardPrefs.edit().remove(boardProfileKey(roomId))
            if (boardPrefs.getString(BOARD_MEMBERS_ROOM_KEY, "") == roomId) {
                editor.remove(BOARD_MEMBERS_KEY).remove(BOARD_MEMBERS_ROOM_KEY)
            }
            if (boardPrefs.getString(BOARD_ADMISSIONS_ROOM_KEY, "") == roomId) {
                editor.remove(BOARD_ADMISSIONS_KEY).remove(BOARD_ADMISSIONS_ROOM_KEY)
            }
            if (boardPrefs.getString(BOARD_PAIRING_ROOM_KEY, "") == roomId) {
                editor.remove(BOARD_PAIRING_ROOM_KEY)
                    .remove(BOARD_PAIRING_CODE_KEY)
                    .remove(BOARD_PAIRING_EXPIRES_KEY)
            }
            editor.apply()
            true
        }
        if (!accepted) return false

        executeWorker {
            val deleted = try {
                tremolaState.boardOperationDAO.deleteRoom(roomId)
                true
            } catch (_: Exception) {
                false
            }
            val quotedRoom = JSONObject.quote(roomId)
            try {
                tremolaState.wai.eval(
                    "if (typeof cb_board_deleted === 'function') " +
                        "cb_board_deleted($quotedRoom, $deleted);"
                )
            } catch (_: Exception) {
            }
        }
        return true
    }

    fun writeBoardEvent(payloadJson: String): Boolean {
        val config = boardConfig ?: return false
        val ownFeed = tremolaState.idStore.identity.toRef()
        if (!isAuthorizedBoardMember(ownFeed)) {
            reportStatus("Waiting for board owner")
            return false
        }
        val decoded = synchronized(boardWriteLock) {
            try {
                val event = JSONObject(payloadJson)
                event.put("r", config.roomId)
                val sequence = (tremolaState.boardOperationDAO
                    .getMaxSequence(config.roomId, ownFeed) ?: 0) + 1
                val created = BoardProtocol.createOperation(
                    config,
                    tremolaState.idStore.identity,
                    sequence,
                    event
                ) ?: return@synchronized null
                created.takeIf {
                    tremolaState.boardOperationDAO.insert(it.operation) != -1L
                }
            } catch (_: Exception) {
                null
            }
        } ?: return false

        tremolaState.appendLocalEvent {
            tremolaState.msgTypes.mkCustomApp(COLLAB_BOARD_APP_ID, decoded.operation.wireJson)
        }
        executeWorker { queueBoardOperationForAll(decoded.operation) }
        return true
    }

    fun replayBoardOperations() {
        val config = boardConfig ?: return
        executeWorker {
            tremolaState.boardOperationDAO.getRoomOperations(config.roomId)
                .forEach { operation ->
                    BoardProtocol.decodeOperation(config, operation.wireJson)?.let {
                        deliverBoardOperation(it)
                    }
                }
            reportBoardRoomStatus()
        }
    }

    /** Returns true when a board entry was handled or intentionally hidden. */
    fun consumeBoardLogEntryForFrontend(entry: LogEntry): Boolean {
        if (!isCollaborationBoardEvent(entry)) return false
        val wire = boardWireFromEntry(entry)
        val config = boardConfig
        if (wire == null) return config != null
        if (config == null) return true
        val decoded = BoardProtocol.decodeOperation(config, wire) ?: return true
        if (decoded.operation.authorId != entry.lid) return true
        val ownFeed = tremolaState.idStore.identity.toRef()
        if (decoded.operation.authorId != ownFeed &&
            !isAuthorizedBoardMember(decoded.operation.authorId)
        ) return true
        storeBoardOperation(decoded)
        deliverBoardOperation(decoded)
        return true
    }

    fun start() {
        val adapter = bluetoothAdapter
        if (isRunning) {
            if (adapter != null && adapter.isEnabled && missingPermissions(activity).isEmpty()) return
            stop()
        }
        if (adapter == null) {
            reportStatus("BLE not available")
            return
        }
        if (missingPermissions(activity).isNotEmpty()) {
            reportStatus("BLE permission missing")
            return
        }
        if (!adapter.isEnabled) {
            reportStatus("Bluetooth disabled")
            return
        }

        isRunning = true
        val generation = lifecycleGeneration.incrementAndGet()
        scanner = adapter.bluetoothLeScanner
        advertiser = adapter.bluetoothLeAdvertiser

        openGattServer()
        startAdvertising()
        startScan()

        syncTask?.cancel(false)
        syncTask = worker.scheduleAtFixedRate({
            if (!isRunning || lifecycleGeneration.get() != generation) return@scheduleAtFixedRate
            pruneInbound()
            prunePairingState()
            openGattServer()
            startAdvertising()
            startScan()
            if (boardConfig == null) {
                if (pendingBoardJoin == null) sendFrontierToAll() else sendPairingProbeToAll()
            } else {
                sendBoardHelloToAll(onlyUnauthenticated = true)
                retryBoardDeliveries()
                val now = System.currentTimeMillis()
                if (now - lastBoardFrontierAt >= BOARD_FRONTIER_INTERVAL_MS) {
                    sendBoardFrontierToAll()
                    lastBoardFrontierAt = now
                }
            }
            reportStatus("BLE sync active")
        }, 2, SYNC_INTERVAL_SECONDS, TimeUnit.SECONDS)
    }

    fun stop(shutdownWorker: Boolean = false) {
        isRunning = false
        lifecycleGeneration.incrementAndGet()
        syncTask?.cancel(false)
        syncTask = null
        try {
            scanner?.stopScan(scanCallback)
        } catch (_: Exception) {
        }
        isScanning = false
        lastScanStartedAt = 0L
        try {
            advertiser?.stopAdvertising(advertiseCallback)
        } catch (_: Exception) {
        }
        isAdvertising = false
        advertisingRequested = false
        clientLinks.values.forEach { link ->
            try {
                link.gatt.disconnect()
                link.gatt.close()
            } catch (_: Exception) {
            }
        }
        clientLinks.clear()
        try {
            gattServer?.close()
        } catch (_: Exception) {
        }
        gattServer = null
        frameCharacteristic = null
        gattServiceReady = false
        synchronized(serverSendLock) {
            activeServerLink = null
        }
        serverLinks.clear()
        connecting.clear()
        inbound.clear()
        pendingEvents.clear()
        authenticatedBoardPeers.clear()
        pendingBoardDeliveries.clear()
        ownerPairingChallenges.clear()
        joinPairingChallenges.clear()
        pairingReservations.clear()
        remoteFeedIds.clear()
        remoteProtocolVersions.clear()
        reportStatus("BLE stopped")
        if (shutdownWorker) worker.shutdownNow()
    }

    fun kick() {
        if (!isRunning) {
            start()
            return
        }
        executeWorker {
            if (boardConfig == null) {
                if (pendingBoardJoin == null) sendFrontierToAll() else sendPairingProbeToAll()
            } else {
                sendBoardHelloToAll()
                sendBoardFrontierToAll()
                retryBoardDeliveries(force = true)
            }
            reportStatus("BLE sync requested")
        }
    }

    fun onLocalLogEntry(entry: LogEntry, excludedPeerAddress: String? = null) {
        executeWorker {
            if (isCollaborationBoardEvent(entry)) {
                val wire = boardWireFromEntry(entry)
                val config = boardConfig
                if (wire != null && config != null) {
                    val decoded = BoardProtocol.decodeOperation(config, wire)
                    if (decoded != null && decoded.operation.authorId == entry.lid) {
                        storeBoardOperation(decoded)
                        queueBoardOperationForAll(decoded.operation, excludedPeerAddress)
                    }
                }
                return@executeWorker
            }
            sendEventToAll(entry, excludedPeerAddress, live = true)
            Log.d(TAG, "queued local event ${entry.lsq} from ${shortPeer(entry.lid)}")
        }
    }

    private fun openGattServer() {
        if (gattServer != null) return
        val server = bluetoothManager.openGattServer(activity, serverCallback)
        if (server == null) {
            reportStatus("BLE GATT server failed")
            return
        }
        val service = BluetoothGattService(SERVICE_UUID, BluetoothGattService.SERVICE_TYPE_PRIMARY)
        val characteristic = BluetoothGattCharacteristic(
            FRAME_UUID,
            BluetoothGattCharacteristic.PROPERTY_READ or
                BluetoothGattCharacteristic.PROPERTY_WRITE or
                BluetoothGattCharacteristic.PROPERTY_NOTIFY or
                BluetoothGattCharacteristic.PROPERTY_INDICATE,
            BluetoothGattCharacteristic.PERMISSION_READ or
                BluetoothGattCharacteristic.PERMISSION_WRITE
        )
        val descriptor = BluetoothGattDescriptor(
            CCCD_UUID,
            BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE
        )
        characteristic.addDescriptor(descriptor)
        service.addCharacteristic(characteristic)
        frameCharacteristic = characteristic
        gattServer = server
        gattServiceReady = false
        if (!server.addService(service)) {
            reportStatus("BLE GATT service failed")
            frameCharacteristic = null
            gattServer = null
            try {
                server.close()
            } catch (_: Exception) {
            }
        }
    }

    private fun startAdvertising() {
        if (!isRunning || !gattServiceReady || isAdvertising || advertisingRequested) return
        val adv = advertiser
        if (adv == null) {
            reportStatus("BLE advertising unsupported")
            return
        }
        val settings = AdvertiseSettings.Builder()
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_BALANCED)
            .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM)
            .setConnectable(true)
            .build()
        val data = AdvertiseData.Builder()
            .setIncludeDeviceName(false)
            .addServiceUuid(ParcelUuid(SERVICE_UUID))
            .build()
        try {
            advertisingRequested = true
            adv.startAdvertising(settings, data, advertiseCallback)
        } catch (e: Exception) {
            advertisingRequested = false
            Log.e(TAG, "advertise failed ${e.stackTraceToString()}")
            reportStatus("BLE advertise failed")
        }
    }

    private fun startScan() {
        val now = System.currentTimeMillis()
        val hasPeer = hasUsablePeer()
        val restartAfter = scanRestartMillis(hasPeer)
        if (!isRunning || isScanning || now - lastScanStartedAt < restartAfter) return
        val bleScanner = scanner ?: bluetoothAdapter?.bluetoothLeScanner ?: return
        scanner = bleScanner
        val filters = listOf(
            ScanFilter.Builder()
                .setServiceUuid(ParcelUuid(SERVICE_UUID))
                .build()
        )
        val settings = ScanSettings.Builder()
            .setScanMode(
                if (hasPeer) ScanSettings.SCAN_MODE_BALANCED
                else ScanSettings.SCAN_MODE_LOW_LATENCY
            )
            .build()
        try {
            bleScanner.startScan(filters, settings, scanCallback)
            isScanning = true
            lastScanStartedAt = now
            scheduleWorker(scanWindowMillis(hasPeer)) { stopScanning() }
        } catch (e: Exception) {
            Log.e(TAG, "scan failed ${e.stackTraceToString()}")
            isScanning = false
            reportStatus("BLE scan failed")
        }
    }

    private fun stopScanning() {
        if (!isScanning) return
        try {
            scanner?.stopScan(scanCallback)
        } catch (_: Exception) {
        }
        isScanning = false
    }

    private fun hasUsablePeer(): Boolean {
        return clientLinks.values.any { it.ready } || serverLinks.values.any { it.subscribed }
    }

    private val advertiseCallback = object : AdvertiseCallback() {
        override fun onStartSuccess(settingsInEffect: AdvertiseSettings) {
            advertisingRequested = false
            isAdvertising = true
            reportStatus("BLE advertising")
        }

        override fun onStartFailure(errorCode: Int) {
            advertisingRequested = false
            isAdvertising = false
            reportStatus("BLE advertise error $errorCode")
        }
    }

    private val scanCallback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            connectTo(result.device)
        }

        override fun onBatchScanResults(results: MutableList<ScanResult>) {
            results.forEach { connectTo(it.device) }
        }

        override fun onScanFailed(errorCode: Int) {
            isScanning = false
            reportStatus("BLE scan error $errorCode")
        }
    }

    private fun connectTo(device: BluetoothDevice) {
        val address = device.address ?: return
        if (!isRunning || clientLinks.containsKey(address) || !connecting.add(address)) return
        try {
            val gatt = device.connectGatt(activity, false, clientCallback, BluetoothDevice.TRANSPORT_LE)
            val link = ClientLink(address, gatt)
            clientLinks[address] = link
            scheduleWorker(CLIENT_SETUP_TIMEOUT_MS) {
                if (clientLinks[address] === link && !link.ready) {
                    dropClientLink(link, "BLE reconnecting")
                }
            }
            reportStatus("BLE connecting")
        } catch (e: Exception) {
            connecting.remove(address)
            Log.e(TAG, "connect failed ${e.stackTraceToString()}")
        }
    }

    private fun currentClientLink(gatt: BluetoothGatt): ClientLink? {
        val link = clientLinks[gatt.device.address] ?: return null
        return link.takeIf { it.gatt === gatt }
    }

    private fun closeStaleGatt(gatt: BluetoothGatt) {
        try {
            gatt.disconnect()
        } catch (_: Exception) {
        }
        try {
            gatt.close()
        } catch (_: Exception) {
        }
    }

    private val clientCallback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
            val address = gatt.device.address
            val link = currentClientLink(gatt)
            if (link == null) {
                closeStaleGatt(gatt)
                return
            }
            if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
                connecting.remove(address)
                synchronized(link) {
                    link.ready = false
                    link.servicesRequested = false
                    link.subscribing = false
                    link.characteristic = null
                }
                try {
                    gatt.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH)
                } catch (_: Exception) {
                }
                val requestedMtu = try {
                    gatt.requestMtu(PREFERRED_MTU)
                } catch (_: Exception) {
                    false
                }
                if (!requestedMtu) discoverServices(link)
                scheduleWorker(GATT_OPERATION_TIMEOUT_SECONDS * 1000L) {
                    discoverServices(link)
                }
                reportStatus("BLE connected")
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED || status != BluetoothGatt.GATT_SUCCESS) {
                dropClientLink(
                    link,
                    if (status == BluetoothGatt.GATT_SUCCESS) "BLE disconnected" else "BLE connection failed $status"
                )
            }
        }

        override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
            currentClientLink(gatt)?.let { link ->
                if (status == BluetoothGatt.GATT_SUCCESS) link.mtu = mtu
                discoverServices(link)
            }
        }

        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            val link = currentClientLink(gatt) ?: return
            synchronized(link) { link.servicesRequested = false }
            if (status != BluetoothGatt.GATT_SUCCESS) {
                reportStatus("BLE service discovery failed")
                scheduleServiceDiscovery(link)
                return
            }
            val service = gatt.getService(SERVICE_UUID)
            val characteristic = service?.getCharacteristic(FRAME_UUID)
            if (characteristic == null) {
                reportStatus("BLE service not ready")
                scheduleServiceDiscovery(link)
                return
            }
            link.characteristic = characteristic
            subscribeClient(link)
        }

        override fun onDescriptorWrite(gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
            if (descriptor.uuid != CCCD_UUID) return
            val link = currentClientLink(gatt) ?: return
            synchronized(link) { link.subscribing = false }
            if (status == BluetoothGatt.GATT_SUCCESS) {
                markClientReady(link)
            } else {
                reportStatus("BLE notification setup failed")
                scheduleSubscription(link)
            }
        }

        override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
            if (characteristic.uuid != FRAME_UUID) return
            if (currentClientLink(gatt) == null) return
            receiveFrame("client:${gatt.device.address}", gatt.device.address, characteristic.value)
        }

        override fun onCharacteristicWrite(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            status: Int
        ) {
            if (characteristic.uuid != FRAME_UUID) return
            val link = currentClientLink(gatt) ?: return
            val failures = synchronized(link) {
                val frame = link.inFlightFrame ?: return
                link.writing = false
                link.inFlightFrame = null
                if (status == BluetoothGatt.GATT_SUCCESS) {
                    link.writeFailures = 0
                    link.queue.complete(frame)
                } else {
                    link.queue.addFirst(frame)
                    link.writeFailures += 1
                }
                link.writeFailures
            }
            if (status == BluetoothGatt.GATT_SUCCESS) {
                drainClient(link)
            } else {
                handleClientWriteFailure(link, failures, "BLE write failed $status")
            }
        }
    }

    private val serverCallback = object : BluetoothGattServerCallback() {
        override fun onServiceAdded(status: Int, service: BluetoothGattService) {
            if (service.uuid != SERVICE_UUID) return
            gattServiceReady = status == BluetoothGatt.GATT_SUCCESS
            if (gattServiceReady) {
                reportStatus("BLE service ready")
                startAdvertising()
            } else {
                reportStatus("BLE GATT service failed")
                try {
                    gattServer?.close()
                } catch (_: Exception) {
                }
                gattServer = null
                frameCharacteristic = null
            }
        }

        override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
            val address = device.address ?: return
            if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
                serverLinks.putIfAbsent(address, ServerLink(address, device))
                reportStatus("BLE peer connected")
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED || status != BluetoothGatt.GATT_SUCCESS) {
                val link = serverLinks[address]
                if (link != null) {
                    dropServerLink(
                        link,
                        if (status == BluetoothGatt.GATT_SUCCESS) "BLE peer disconnected" else "BLE peer failed $status",
                        cancelConnection = false
                    )
                }
            }
        }

        override fun onMtuChanged(device: BluetoothDevice, mtu: Int) {
            serverLinks[device.address]?.mtu = mtu
        }

        override fun onCharacteristicReadRequest(
            device: BluetoothDevice,
            requestId: Int,
            offset: Int,
            characteristic: BluetoothGattCharacteristic
        ) {
            val value = "tremola-ble".encodeToByteArray()
            val valid = characteristic.uuid == FRAME_UUID && offset in 0..value.size
            gattServer?.sendResponse(
                device,
                requestId,
                if (valid) BluetoothGatt.GATT_SUCCESS else BluetoothGatt.GATT_FAILURE,
                offset,
                if (valid) value.copyOfRange(offset, value.size) else null
            )
        }

        override fun onCharacteristicWriteRequest(
            device: BluetoothDevice,
            requestId: Int,
            characteristic: BluetoothGattCharacteristic,
            preparedWrite: Boolean,
            responseNeeded: Boolean,
            offset: Int,
            value: ByteArray
        ) {
            val valid = characteristic.uuid == FRAME_UUID && !preparedWrite && offset == 0
            if (valid) receiveFrame("server:${device.address}", device.address, value)
            if (responseNeeded) {
                gattServer?.sendResponse(
                    device,
                    requestId,
                    if (valid) BluetoothGatt.GATT_SUCCESS else BluetoothGatt.GATT_FAILURE,
                    0,
                    null
                )
            }
        }

        override fun onDescriptorWriteRequest(
            device: BluetoothDevice,
            requestId: Int,
            descriptor: BluetoothGattDescriptor,
            preparedWrite: Boolean,
            responseNeeded: Boolean,
            offset: Int,
            value: ByteArray
        ) {
            val enableNotification = value.contentEquals(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
            val enableIndication = value.contentEquals(BluetoothGattDescriptor.ENABLE_INDICATION_VALUE)
            val disable = value.contentEquals(BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE)
            val enable = enableNotification || enableIndication
            val valid = descriptor.uuid == CCCD_UUID && !preparedWrite && offset == 0 && (enable || disable)
            val link = if (valid) {
                serverLinks.getOrPut(device.address) { ServerLink(device.address, device) }
            } else {
                null
            }
            if (link != null) {
                synchronized(link) {
                    link.subscribed = enable
                    link.useIndications = enableIndication
                    if (!enable) link.queue.clear()
                }
            }
            if (responseNeeded) {
                gattServer?.sendResponse(
                    device,
                    requestId,
                    if (valid) BluetoothGatt.GATT_SUCCESS else BluetoothGatt.GATT_FAILURE,
                    0,
                    null
                )
            }
            if (link?.subscribed == true) {
                stopScanning()
                sendHello(link.address)
                sendInitialSync(link.address)
            }
            if (valid) reportStatus("BLE notifications ${if (enable) "on" else "off"}")
        }

        override fun onNotificationSent(device: BluetoothDevice, status: Int) {
            val result = synchronized(serverSendLock) {
                val active = activeServerLink ?: return
                if (active.address != device.address) return
                val failures = synchronized(active) {
                    val frame = active.inFlightFrame ?: return
                    active.sending = false
                    active.inFlightFrame = null
                    if (status == BluetoothGatt.GATT_SUCCESS) {
                        active.sendFailures = 0
                        active.queue.complete(frame)
                    } else {
                        active.queue.addFirst(frame)
                        active.sendFailures += 1
                    }
                    active.sendFailures
                }
                activeServerLink = null
                active to failures
            }
            val (link, failures) = result
            if (status == BluetoothGatt.GATT_SUCCESS) {
                drainNextServer(link)
            } else {
                handleServerSendFailure(link, failures, "BLE notification failed $status")
            }
        }
    }

    private fun dropClientLink(link: ClientLink, status: String) {
        if (!clientLinks.remove(link.address, link)) return
        connecting.remove(link.address)
        if (!serverLinks.containsKey(link.address)) {
            remoteFeedIds.remove(link.address)
            remoteProtocolVersions.remove(link.address)
            authenticatedBoardPeers.remove(link.address)
        }
        synchronized(link) {
            link.ready = false
            link.servicesRequested = false
            link.subscribing = false
            link.writing = false
            link.inFlightFrame = null
            link.queue.clear()
        }
        try {
            link.gatt.disconnect()
        } catch (_: Exception) {
        }
        try {
            link.gatt.close()
        } catch (_: Exception) {
        }
        reportStatus(status)
        executeWorker { startScan() }
    }

    private fun dropServerLink(
        link: ServerLink,
        status: String,
        cancelConnection: Boolean = true
    ) {
        if (!serverLinks.remove(link.address, link)) return
        if (!clientLinks.containsKey(link.address)) {
            remoteFeedIds.remove(link.address)
            remoteProtocolVersions.remove(link.address)
            authenticatedBoardPeers.remove(link.address)
        }
        synchronized(serverSendLock) {
            if (activeServerLink === link) activeServerLink = null
        }
        synchronized(link) {
            link.subscribed = false
            link.useIndications = false
            link.sending = false
            link.inFlightFrame = null
            link.queue.clear()
        }
        if (cancelConnection) {
            try {
                gattServer?.cancelConnection(link.device)
            } catch (_: Exception) {
            }
        }
        reportStatus(status)
        drainNextServer()
        executeWorker { startScan() }
    }

    private fun handleClientWriteFailure(link: ClientLink, failures: Int, status: String) {
        if (!isRunning || clientLinks[link.address] !== link) return
        reportStatus(status)
        if (shouldDropLinkAfterFailures(failures)) {
            dropClientLink(link, "BLE reconnecting")
            return
        }
        scheduleWorker(frameRetryDelayMillis(failures)) { drainClient(link) }
    }

    private fun handleServerSendFailure(link: ServerLink, failures: Int, status: String) {
        if (!isRunning || serverLinks[link.address] !== link) return
        reportStatus(status)
        if (shouldDropLinkAfterFailures(failures)) {
            dropServerLink(link, "BLE peer reconnecting")
            return
        }
        scheduleWorker(frameRetryDelayMillis(failures)) { drainServer(link) }
        drainNextServer(previous = link, exclude = link)
    }

    private fun drainNextServer(previous: ServerLink? = null, exclude: ServerLink? = null) {
        if (!isRunning || synchronized(serverSendLock) { activeServerLink != null }) return
        val candidates = serverLinks.values.filter { link ->
            link !== exclude && synchronized(link) {
                link.subscribed && !link.sending && link.queue.isNotEmpty()
            }
        }
        val next = candidates.firstOrNull { it !== previous } ?: candidates.firstOrNull() ?: return
        drainServer(next)
    }

    private fun scheduleWorker(delayMs: Long, action: () -> Unit) {
        if (!isRunning || worker.isShutdown) return
        val generation = lifecycleGeneration.get()
        try {
            worker.schedule(
                { if (isRunning && lifecycleGeneration.get() == generation) action() },
                delayMs,
                TimeUnit.MILLISECONDS
            )
        } catch (_: RejectedExecutionException) {
            // The activity may be closing while a final Bluetooth callback arrives.
        }
    }

    private fun executeWorker(action: () -> Unit) {
        if (!isRunning || worker.isShutdown) return
        val generation = lifecycleGeneration.get()
        try {
            worker.execute {
                if (isRunning && lifecycleGeneration.get() == generation) action()
            }
        } catch (_: RejectedExecutionException) {
            // The activity may be closing while a final Bluetooth callback arrives.
        }
    }

    private fun markClientReady(link: ClientLink) {
        if (!isRunning || clientLinks[link.address] !== link) return
        val becameReady = synchronized(link) {
            if (link.ready) {
                false
            } else {
                link.ready = true
                link.servicesRequested = false
                link.subscribing = false
                true
            }
        }
        if (!becameReady) return
        stopScanning()
        sendHello(link.address)
        sendInitialSync(link.address)
        drainClient(link)
        reportStatus("BLE client ready")
    }

    private fun discoverServices(link: ClientLink) {
        if (!isRunning || clientLinks[link.address] !== link) return
        val started = synchronized(link) {
            if (link.ready || link.servicesRequested) return
            link.servicesRequested = true
            if (!link.gatt.discoverServices()) {
                link.servicesRequested = false
                false
            } else {
                true
            }
        }
        if (!started) {
            reportStatus("BLE service discovery failed")
            scheduleServiceDiscovery(link)
            return
        }
        scheduleWorker(GATT_OPERATION_TIMEOUT_SECONDS * 1000L) {
            val retry = synchronized(link) {
                if (!link.ready && link.servicesRequested) {
                    link.servicesRequested = false
                    true
                } else {
                    false
                }
            }
            if (retry) discoverServices(link)
        }
    }

    private fun scheduleServiceDiscovery(link: ClientLink) {
        scheduleWorker(GATT_OPERATION_TIMEOUT_SECONDS * 1000L) {
            discoverServices(link)
        }
    }

    private fun subscribeClient(link: ClientLink) {
        if (!isRunning || clientLinks[link.address] !== link) return
        val characteristic = link.characteristic
        if (characteristic == null) {
            scheduleServiceDiscovery(link)
            return
        }
        val descriptor = characteristic.getDescriptor(CCCD_UUID)
        if (descriptor == null) {
            link.characteristic = null
            reportStatus("BLE notification descriptor missing")
            scheduleServiceDiscovery(link)
            return
        }
        val started = synchronized(link) {
            if (link.ready || link.subscribing) return
            link.subscribing = true
            val notificationsEnabled = try {
                link.gatt.setCharacteristicNotification(characteristic, true)
            } catch (_: Exception) {
                false
            }
            if (!notificationsEnabled) {
                link.subscribing = false
                false
            } else {
                descriptor.value = if (supportsIndications(characteristic.properties)) {
                    BluetoothGattDescriptor.ENABLE_INDICATION_VALUE
                } else {
                    BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                }
                val writeStarted = try {
                    link.gatt.writeDescriptor(descriptor)
                } catch (_: Exception) {
                    false
                }
                if (!writeStarted) link.subscribing = false
                writeStarted
            }
        }
        if (!started) {
            reportStatus("BLE notification setup failed")
            scheduleSubscription(link)
            return
        }
        scheduleWorker(GATT_OPERATION_TIMEOUT_SECONDS * 1000L) {
            val retry = synchronized(link) {
                if (!link.ready && link.subscribing) {
                    link.subscribing = false
                    true
                } else {
                    false
                }
            }
            if (retry) subscribeClient(link)
        }
    }

    private fun scheduleSubscription(link: ClientLink) {
        scheduleWorker(GATT_OPERATION_TIMEOUT_SECONDS * 1000L) {
            subscribeClient(link)
        }
    }

    private fun sendHello(peerAddress: String? = null) {
        val msg = JSONObject()
        msg.put("t", "hello")
        msg.put("v", PROTOCOL_VERSION)
        msg.put("fid", tremolaState.idStore.identity.toRef())
        if (peerAddress == null) sendJsonToAll(msg) else sendJsonToPeer(peerAddress, msg)
    }

    private fun sendInitialSync(peerAddress: String) {
        when {
            boardConfig != null -> sendBoardHello(peerAddress)
            pendingBoardJoin != null -> sendPairingProbe(peerAddress)
            else -> sendFrontier(peerAddress)
        }
    }

    private fun restoreBoardPairingSession() {
        val config = boardConfig
        val roomId = boardPrefs.getString(BOARD_PAIRING_ROOM_KEY, "") ?: ""
        val code = boardPrefs.getString(BOARD_PAIRING_CODE_KEY, "") ?: ""
        val expiresAt = boardPrefs.getLong(BOARD_PAIRING_EXPIRES_KEY, 0L)
        val ownFeed = tremolaState.idStore.identity.toRef()
        if (config != null && config.ownerId == ownFeed && roomId == config.roomId &&
            BoardProtocol.isValidPairingCode(code) && expiresAt > System.currentTimeMillis()
        ) {
            boardPairingSession = BoardPairingSession(roomId, code, expiresAt)
        } else {
            clearBoardPairingSessionLocked()
        }
    }

    private fun persistBoardPairingSessionLocked() {
        val session = boardPairingSession ?: return
        boardPrefs.edit()
            .putString(BOARD_PAIRING_ROOM_KEY, session.roomId)
            .putString(BOARD_PAIRING_CODE_KEY, session.code)
            .putLong(BOARD_PAIRING_EXPIRES_KEY, session.expiresAt)
            .apply()
    }

    private fun clearBoardPairingSessionLocked() {
        boardPairingSession = null
        ownerPairingChallenges.clear()
        pairingFailuresByFeed.clear()
        pairingFailureCount = 0
        boardPrefs.edit()
            .remove(BOARD_PAIRING_ROOM_KEY)
            .remove(BOARD_PAIRING_CODE_KEY)
            .remove(BOARD_PAIRING_EXPIRES_KEY)
            .apply()
    }

    private fun activeBoardPairingSession(now: Long = System.currentTimeMillis()): BoardPairingSession? {
        synchronized(boardConfigLock) {
            val session = boardPairingSession ?: return null
            val config = boardConfig
            val ownFeed = tremolaState.idStore.identity.toRef()
            if (config == null || config.roomId != session.roomId || config.ownerId != ownFeed ||
                session.expiresAt <= now
            ) {
                clearBoardPairingSessionLocked()
                return null
            }
            return session
        }
    }

    private fun prunePairingState() {
        val now = System.currentTimeMillis()
        activeBoardPairingSession(now)
        ownerPairingChallenges.entries.removeIf {
            now - it.value.createdAt > BOARD_PAIRING_CHALLENGE_MS
        }
        joinPairingChallenges.entries.removeIf {
            now - it.value.createdAt > BOARD_PAIRING_CHALLENGE_MS
        }
        pairingReservations.entries.removeIf { now >= it.value.expiresAt }
        val pending = pendingBoardJoin
        if (pending != null && now - pending.startedAt > BOARD_PAIRING_JOIN_TIMEOUT_MS) {
            synchronized(boardConfigLock) {
                if (pendingBoardJoin === pending) pendingBoardJoin = null
                joinPairingChallenges.clear()
            }
            notifyBoardJoinFailed("Could not join. Check the code and keep the owner nearby")
            reportStatus("Board join timed out")
        }
    }

    private fun sendPairingProbeToAll() {
        connectedAddresses().forEach { sendPairingProbe(it) }
    }

    private fun sendPairingProbe(peerAddress: String) {
        val pending = pendingBoardJoin ?: return
        if (boardConfig != null) return
        val probe = BoardProtocol.createPairingProbe(
            tremolaState.idStore.identity,
            pending.username,
            pending.joinNonce
        ) ?: return
        sendJsonToPeer(peerAddress, probe)
    }

    private fun handlePairingProbe(peerAddress: String, msg: JSONObject) {
        val session = activeBoardPairingSession() ?: return
        val config = boardConfig ?: return
        val probe = BoardProtocol.verifyPairingProbe(msg) ?: return
        val ownFeed = tremolaState.idStore.identity.toRef()
        if (ownFeed != config.ownerId || probe.feedId == ownFeed) return
        remoteFeedIds[peerAddress] = probe.feedId

        if (!hasPairingCapacityFor(probe.feedId)) {
            reportStatus("Board is full")
            return
        }
        if ((pairingFailuresByFeed[probe.feedId] ?: 0) >= MAX_PAIRING_FAILURES_PER_FEED ||
            pairingFailureCount >= MAX_PAIRING_FAILURES_TOTAL
        ) {
            return
        }

        val key = PairingChallengeKey(peerAddress, probe.feedId, probe.joinNonce)
        val now = System.currentTimeMillis()
        var record = ownerPairingChallenges[key]
        if (record == null || now - record.createdAt > BOARD_PAIRING_CHALLENGE_MS) {
            val remainingSeconds = ((session.expiresAt - now + 999L) / 1000L)
                .toInt()
                .coerceIn(1, BOARD_PAIRING_SESSION_SECONDS)
            val created = BoardProtocol.createPairingChallenge(
                tremolaState.idStore.identity,
                probe,
                remainingSeconds
            ) ?: return
            record = OwnerPairingChallenge(created.challenge, created.message, now)
            ownerPairingChallenges[key] = record
        }
        sendJsonToPeer(peerAddress, record.message)
    }

    private fun handlePairingChallenge(peerAddress: String, msg: JSONObject) {
        val pending = pendingBoardJoin ?: return
        if (boardConfig != null ||
            System.currentTimeMillis() - pending.startedAt > BOARD_PAIRING_JOIN_TIMEOUT_MS
        ) return
        val ownFeed = tremolaState.idStore.identity.toRef()
        val challenge = BoardProtocol.verifyPairingChallenge(msg, ownFeed, pending.joinNonce)
            ?: return
        if (challenge.ownerId == ownFeed) return
        val existing = joinPairingChallenges[peerAddress]
        val request = if (existing != null && existing.challenge == challenge) {
            existing.request
        } else {
            BoardProtocol.createPairingRequest(
                tremolaState.idStore.identity,
                pending.username,
                pending.code,
                challenge
            ) ?: return
        }
        joinPairingChallenges[peerAddress] = JoinPairingChallenge(
            challenge,
            request,
            System.currentTimeMillis()
        )
        sendJsonToPeer(peerAddress, request)
        reportStatus("Checking invite code")
    }

    private fun handlePairingRequest(peerAddress: String, msg: JSONObject) {
        val session = activeBoardPairingSession() ?: return
        val config = boardConfig ?: return
        val feedId = msg.optString("f", "")
        val joinNonce = msg.optString("j", "")
        val key = PairingChallengeKey(peerAddress, feedId, joinNonce)
        val record = ownerPairingChallenges[key] ?: return
        if (System.currentTimeMillis() - record.createdAt > BOARD_PAIRING_CHALLENGE_MS) {
            ownerPairingChallenges.remove(key, record)
            return
        }
        if ((pairingFailuresByFeed[feedId] ?: 0) >= MAX_PAIRING_FAILURES_PER_FEED ||
            pairingFailureCount >= MAX_PAIRING_FAILURES_TOTAL
        ) {
            return
        }
        val proof = msg.optString("a", "")
        if (proof.isNotBlank() && record.acceptedProof == proof && record.offer != null) {
            sendJsonToPeer(peerAddress, record.offer!!)
            return
        }
        val request = BoardProtocol.verifyPairingRequest(msg, session.code, record.challenge)
        if (request == null) {
            pairingFailuresByFeed[feedId] = (pairingFailuresByFeed[feedId] ?: 0) + 1
            pairingFailureCount += 1
            if (pairingFailureCount >= MAX_PAIRING_FAILURES_TOTAL) {
                synchronized(boardConfigLock) { clearBoardPairingSessionLocked() }
                reportStatus("Invite code locked")
            }
            return
        }

        if (verifiedBoardAdmission(request.feedId) == null) {
            if (!hasPairingCapacityFor(request.feedId)) {
                reportStatus("Board is full")
                return
            }
            pairingReservations[request.feedId] = PairingReservation(
                request.username,
                System.currentTimeMillis() + BOARD_PAIRING_RESERVATION_MS
            )
        }
        val offer = BoardProtocol.createPairingOffer(
            config,
            tremolaState.idStore.identity,
            session.code,
            record.challenge,
            request
        ) ?: return
        record.acceptedProof = proof
        record.offer = offer
        sendJsonToPeer(peerAddress, offer)
        reportStatus("Board invite sent")
    }

    private fun hasPairingCapacityFor(feedId: String): Boolean {
        val now = System.currentTimeMillis()
        pairingReservations.entries.removeIf { now >= it.value.expiresAt }
        if (verifiedBoardAdmission(feedId) != null || pairingReservations.containsKey(feedId)) {
            return true
        }
        val reserved = pairingReservations.keys.count { verifiedBoardAdmission(it) == null }
        return authorizedBoardMemberCount() + reserved < MAX_BOARD_MEMBERS
    }

    private fun handlePairingOffer(peerAddress: String, msg: JSONObject) {
        val pending = pendingBoardJoin ?: return
        if (boardConfig != null) return
        val record = joinPairingChallenges[peerAddress] ?: return
        if (System.currentTimeMillis() - record.createdAt > BOARD_PAIRING_CHALLENGE_MS) return
        val result = BoardProtocol.verifyPairingOffer(
            msg,
            pending.code,
            record.challenge,
            pending.username
        ) ?: return

        synchronized(boardConfigLock) {
            if (pendingBoardJoin !== pending) return
            pendingBoardJoin = null
            joinPairingChallenges.clear()
        }
        if (!activateBoard(result.config)) {
            notifyBoardJoinFailed("Could not open this board")
            return
        }
        val configJson = JSONObject.quote(BoardProtocol.configJson(result.config))
        try {
            tremolaState.wai.eval(
                "if (typeof cb_board_joined === 'function') cb_board_joined($configJson);"
            )
        } catch (_: Exception) {
        }
        reportStatus("Board joined")
    }

    private fun notifyBoardJoinFailed(message: String) {
        val quoted = JSONObject.quote(message)
        try {
            tremolaState.wai.eval(
                "if (typeof cb_board_join_failed === 'function') cb_board_join_failed($quoted);"
            )
        } catch (_: Exception) {
        }
    }

    private fun handleBoardReject(msg: JSONObject) {
        val config = boardConfig ?: return
        when (BoardProtocol.verifyReject(config, msg) ?: return) {
            "full" -> {
                val ownFeed = tremolaState.idStore.identity.toRef()
                if (!isAuthorizedBoardMember(ownFeed)) {
                    leaveBoard()
                    val message = JSONObject.quote("Board is full")
                    try {
                        tremolaState.wai.eval(
                            "if (typeof cb_board_access_rejected === 'function') " +
                                "cb_board_access_rejected($message);"
                        )
                    } catch (_: Exception) {
                    }
                } else {
                    reportStatus("Board is full")
                }
            }
            "owner_required" -> reportStatus("Waiting for board owner")
        }
    }

    private fun loadBoardProfile() {
        val config = boardConfig ?: return
        val profile = try {
            val raw = boardPrefs.getString(boardProfileKey(config.roomId), "") ?: ""
            if (raw.isBlank()) null else JSONObject(raw)
        } catch (_: Exception) {
            null
        }
        val storedConfig = profile?.optJSONObject("config")?.toString()
            ?.let { BoardProtocol.parseConfig(it) }
            ?.takeIf {
                it.roomId == config.roomId && it.ownerId == config.ownerId &&
                    it.roomKey.contentEquals(config.roomKey)
            }
        if (storedConfig != null) {
            if (config.codeVerifier.isBlank() && storedConfig.codeVerifier.isNotBlank()) {
                boardConfig = config.copy(codeVerifier = storedConfig.codeVerifier)
            }
            loadBoardMembersFrom(profile.optJSONObject("members"))
            loadBoardAdmissionsFrom(profile.optJSONObject("admissions"), config)
            return
        }
        loadLegacyBoardProfile(config)
    }

    private fun loadLegacyBoardProfile(config: BoardRoomConfig) {
        if (boardPrefs.getString(BOARD_MEMBERS_ROOM_KEY, "") == config.roomId) {
            try {
                loadBoardMembersFrom(
                    JSONObject(boardPrefs.getString(BOARD_MEMBERS_KEY, "{}") ?: "{}")
                )
            } catch (_: Exception) {
            }
        }
        if (boardPrefs.getString(BOARD_ADMISSIONS_ROOM_KEY, "") == config.roomId) {
            try {
                loadBoardAdmissionsFrom(
                    JSONObject(boardPrefs.getString(BOARD_ADMISSIONS_KEY, "{}") ?: "{}"),
                    config
                )
            } catch (_: Exception) {
            }
        }
        persistBoardProfile()
    }

    private fun loadBoardMembersFrom(saved: JSONObject?) {
        saved ?: return
        saved.keys().forEach { feedId ->
            val username = BoardProtocol.cleanUsername(saved.optString(feedId, ""))
            if (username.isNotBlank()) boardMembers[feedId] = username
        }
    }

    private fun loadBoardAdmissionsFrom(saved: JSONObject?, config: BoardRoomConfig) {
        saved ?: return
        saved.keys().forEach { feedId ->
            val admission = BoardProtocol.verifyAdmission(config, saved.optString(feedId, ""))
            if (admission != null && admission.memberId == feedId) {
                boardAdmissions[feedId] = admission.wireJson
                boardMembers.putIfAbsent(feedId, admission.username)
            }
        }
    }

    private fun persistBoardProfile() {
        val config = boardConfig ?: return
        val members = JSONObject()
        boardMembers.toSortedMap().forEach { (feedId, username) -> members.put(feedId, username) }
        val admissions = JSONObject()
        boardAdmissions.toSortedMap().forEach { (feedId, wire) -> admissions.put(feedId, wire) }
        val profile = JSONObject()
            .put("config", JSONObject(BoardProtocol.configJson(config)))
            .put("members", members)
            .put("admissions", admissions)
        boardPrefs.edit()
            .putString(boardProfileKey(config.roomId), profile.toString())
            .apply()
    }

    private fun persistBoardMembers() {
        persistBoardProfile()
    }

    private fun persistBoardAdmissions() {
        persistBoardProfile()
    }

    private fun boardProfileKey(roomId: String): String {
        return BOARD_PROFILE_PREFIX + roomId
    }

    private fun loadBoardConfigFromProfile(roomId: String): BoardRoomConfig? {
        return try {
            val raw = boardPrefs.getString(boardProfileKey(roomId), "") ?: ""
            if (raw.isBlank()) null else JSONObject(raw).optJSONObject("config")?.toString()
                ?.let { BoardProtocol.parseConfig(it) }
                ?.takeIf { it.roomId == roomId }
        } catch (_: Exception) {
            null
        }
    }

    private fun verifiedBoardAdmission(feedId: String): BoardAdmission? {
        val config = boardConfig ?: return null
        val admission = BoardProtocol.verifyAdmission(config, boardAdmissions[feedId]) ?: return null
        return admission.takeIf { it.memberId == feedId }
    }

    private fun isAuthorizedBoardMember(feedId: String): Boolean {
        val config = boardConfig ?: return false
        return feedId == config.ownerId || verifiedBoardAdmission(feedId) != null
    }

    private fun authorizedBoardMemberCount(): Int {
        val config = boardConfig ?: return 0
        return (boardAdmissions.keys.filter { verifiedBoardAdmission(it) != null } + config.ownerId)
            .toSet().size
    }

    private fun boardRoster(): Map<String, String> {
        val config = boardConfig ?: return emptyMap()
        val result = linkedMapOf(config.ownerId to (boardMembers[config.ownerId] ?: "Owner"))
        boardAdmissions.keys.sorted().forEach { feedId ->
            verifiedBoardAdmission(feedId)?.let { admission ->
                result[feedId] = boardMembers[feedId] ?: admission.username
            }
        }
        return result
    }

    private fun sendBoardHelloToAll(onlyUnauthenticated: Boolean = false) {
        if (boardConfig == null) return
        connectedAddresses().forEach { address ->
            if (!onlyUnauthenticated || !authenticatedBoardPeers.containsKey(address)) {
                sendBoardHello(address)
            }
        }
    }

    private fun sendBoardHello(peerAddress: String, replyRequested: Boolean = true) {
        val config = boardConfig ?: return
        val ownFeed = tremolaState.idStore.identity.toRef()
        val msg = BoardProtocol.createHello(
            config,
            tremolaState.idStore.identity,
            replyRequested,
            boardAdmissions[ownFeed]
        )
        sendJsonToPeer(peerAddress, msg)
    }

    private fun handleBoardHello(peerAddress: String, msg: JSONObject) {
        val config = boardConfig ?: return
        val hello = BoardProtocol.verifyHello(config, msg) ?: run {
            Log.w(TAG, "rejected board hello from $peerAddress")
            return
        }
        val ownFeed = tremolaState.idStore.identity.toRef()
        if (hello.feedId == ownFeed) return

        var issuedAdmission: BoardAdmission? = null
        val accepted = synchronized(boardConfigLock) {
            var admission = BoardProtocol.verifyAdmission(config, hello.admissionWire)
                ?.takeIf { it.memberId == hello.feedId }
            val storedAdmission = verifiedBoardAdmission(hello.feedId)
            if (storedAdmission != null) {
                admission = storedAdmission
            } else if (admission != null && authorizedBoardMemberCount() >= MAX_BOARD_MEMBERS) {
                admission = null
            }

            if (hello.feedId != config.ownerId && admission == null && ownFeed == config.ownerId &&
                authorizedBoardMemberCount() < MAX_BOARD_MEMBERS
            ) {
                admission = BoardProtocol.createAdmission(
                    config,
                    tremolaState.idStore.identity,
                    hello.feedId,
                    hello.username
                )
                issuedAdmission = admission
            }

            if (hello.feedId == config.ownerId || admission != null) {
                if (admission != null) {
                    boardAdmissions[hello.feedId] = admission.wireJson
                    boardMembers[hello.feedId] = hello.username
                    pairingReservations.remove(hello.feedId)
                } else {
                    boardMembers[hello.feedId] = hello.username
                }
                authenticatedBoardPeers[peerAddress] = hello.feedId
                remoteFeedIds[peerAddress] = hello.feedId
                persistBoardMembers()
                persistBoardAdmissions()
                true
            } else {
                false
            }
        }
        if (!accepted) {
            val full = ownFeed == config.ownerId && authorizedBoardMemberCount() >= MAX_BOARD_MEMBERS
            if (ownFeed == config.ownerId) {
                BoardProtocol.createReject(
                    config,
                    tremolaState.idStore.identity,
                    if (full) "full" else "owner_required"
                )?.let { sendJsonToPeer(peerAddress, it) }
            }
            reportStatus(if (full) "Board is full" else "Waiting for board owner")
            return
        }

        // Authenticate both directions before sending admission records. A new
        // member otherwise has to discard an admission that arrives first.
        if (hello.replyRequested) sendBoardHello(peerAddress, replyRequested = false)
        issuedAdmission?.let { admission ->
            sendBoardAdmissionToAll(admission)
        }
        sendKnownBoardAdmissions(peerAddress)
        sendBoardFrontier(peerAddress)
        reportStatus("Board peer ${hello.username}")
        reportBoardRoomStatus()
    }

    private fun sendBoardAdmission(peerAddress: String, admission: BoardAdmission) {
        val config = boardConfig ?: return
        if (!authenticatedBoardPeers.containsKey(peerAddress)) return
        val msg = JSONObject()
            .put("t", "bm")
            .put("r", config.roomId)
            .put("f", tremolaState.idStore.identity.toRef())
            .put("a", JSONObject(admission.wireJson))
        sendJsonToPeer(peerAddress, msg)
    }

    private fun sendKnownBoardAdmissions(peerAddress: String) {
        boardAdmissions.keys.sorted().forEach { feedId ->
            verifiedBoardAdmission(feedId)?.let { sendBoardAdmission(peerAddress, it) }
        }
    }

    private fun sendBoardAdmissionToAll(
        admission: BoardAdmission,
        excludedPeerAddress: String? = null
    ) {
        logicalBoardPeerAddresses().values.forEach { address ->
            if (address != excludedPeerAddress) sendBoardAdmission(address, admission)
        }
    }

    private fun handleBoardAdmission(peerAddress: String, msg: JSONObject) {
        val config = boardConfig ?: return
        val peerFeed = authenticatedBoardPeers[peerAddress] ?: return
        if (msg.optString("r") != config.roomId || msg.optString("f") != peerFeed) return
        val admission = BoardProtocol.verifyAdmission(config, msg.optJSONObject("a")?.toString())
            ?: return
        val inserted = synchronized(boardConfigLock) {
            val isNew = boardAdmissions[admission.memberId] != admission.wireJson
            boardAdmissions[admission.memberId] = admission.wireJson
            boardMembers.putIfAbsent(admission.memberId, admission.username)
            persistBoardAdmissions()
            persistBoardMembers()
            isNew
        }
        if (!inserted) return

        sendBoardAdmissionToAll(admission, peerAddress)
        if (admission.memberId == tremolaState.idStore.identity.toRef()) {
            sendBoardHelloToAll()
            try {
                tremolaState.wai.eval(
                    "if (typeof cb_board_access_ready === 'function') cb_board_access_ready();"
                )
            } catch (_: Exception) {
            }
            reportStatus("Board access ready")
        }
        reportBoardRoomStatus()
    }

    private fun connectedAddresses(): Set<String> {
        val addresses = HashSet<String>()
        addresses.addAll(clientLinks.keys)
        addresses.addAll(serverLinks.keys)
        return addresses
    }

    private fun logicalBoardPeerAddresses(): Map<String, String> {
        val ownFeed = tremolaState.idStore.identity.toRef()
        val result = linkedMapOf<String, String>()
        authenticatedBoardPeers.entries
            .filter { it.value != ownFeed }
            .groupBy { it.value }
            .toSortedMap()
            .forEach { (feedId, entries) ->
                val address = entries.map { it.key }.firstOrNull { candidate ->
                    clientLinks[candidate]?.ready == true
                } ?: entries.map { it.key }.firstOrNull { candidate ->
                    serverLinks[candidate]?.subscribed == true
                } ?: entries.first().key
                result[feedId] = address
            }
        return result
    }

    private fun sendBoardFrontierToAll() {
        logicalBoardPeerAddresses().values.forEach { address ->
            // Admissions are small and owner-signed. Repeating them with the
            // anti-entropy pulse makes first join robust to handshake ordering
            // and lets any admitted peer restore a member after reconnecting.
            sendKnownBoardAdmissions(address)
            sendBoardFrontier(address)
        }
    }

    private fun sendBoardFrontier(peerAddress: String) {
        val config = boardConfig ?: return
        if (!authenticatedBoardPeers.containsKey(peerAddress)) return
        val feeds = JSONObject()
        localBoardFrontier(config.roomId).toSortedMap().forEach { (feedId, seq) ->
            feeds.put(feedId, seq)
        }
        val msg = JSONObject()
            .put("t", "bf")
            .put("r", config.roomId)
            .put("f", tremolaState.idStore.identity.toRef())
            .put("feeds", feeds)
        sendJsonToPeer(peerAddress, msg)
    }

    private fun localBoardFrontier(roomId: String): Map<String, Int> {
        return BoardProtocol.contiguousFrontier(
            tremolaState.boardOperationDAO.getRoomSequences(roomId)
        )
    }

    private fun handleBoardFrontier(peerAddress: String, msg: JSONObject) {
        val config = boardConfig ?: return
        val peerFeed = authenticatedBoardPeers[peerAddress] ?: return
        if (msg.optString("r") != config.roomId || msg.optString("f") != peerFeed) return
        val remoteJson = msg.optJSONObject("feeds") ?: return
        val remote = linkedMapOf<String, Int>()
        remoteJson.keys().forEach { feedId ->
            val sequence = remoteJson.optInt(feedId, -1)
            if (sequence >= 0) remote[feedId] = sequence
        }
        val local = localBoardFrontier(config.roomId)
        val missing = BoardProtocol.missingRanges(local, remote, MAX_BOARD_RANGE)
        if (missing.isNotEmpty()) sendBoardWant(peerAddress, missing)

        var sent = 0
        local.toSortedMap().forEach { (authorId, localSequence) ->
            if (sent >= MAX_BOARD_OPERATIONS_PER_PULSE) return@forEach
            val remoteSequence = remote[authorId] ?: 0
            if (localSequence <= remoteSequence) return@forEach
            val operations = tremolaState.boardOperationDAO.getRange(
                config.roomId,
                authorId,
                remoteSequence + 1,
                localSequence,
                MAX_BOARD_OPERATIONS_PER_PULSE - sent
            )
            operations.forEach { operation ->
                queueBoardOperationForPeer(peerAddress, operation)
                sent += 1
            }
        }
    }

    private fun sendBoardWant(peerAddress: String, ranges: List<BoardSequenceRange>) {
        val config = boardConfig ?: return
        val requests = JSONArray()
        ranges.take(MAX_BOARD_WANT_RANGES).forEach { range ->
            requests.put(
                JSONObject()
                    .put("f", range.authorId)
                    .put("a", range.fromSequence)
                    .put("b", range.toSequence)
            )
        }
        val msg = JSONObject()
            .put("t", "bw")
            .put("r", config.roomId)
            .put("f", tremolaState.idStore.identity.toRef())
            .put("w", requests)
        sendJsonToPeer(peerAddress, msg)
    }

    private fun handleBoardWant(peerAddress: String, msg: JSONObject) {
        val config = boardConfig ?: return
        val peerFeed = authenticatedBoardPeers[peerAddress] ?: return
        if (msg.optString("r") != config.roomId || msg.optString("f") != peerFeed) return
        val requests = msg.optJSONArray("w") ?: return
        var sent = 0
        for (index in 0 until min(requests.length(), MAX_BOARD_WANT_RANGES)) {
            if (sent >= MAX_BOARD_OPERATIONS_PER_PULSE) break
            val range = requests.optJSONObject(index) ?: continue
            val authorId = range.optString("f", "")
            val from = max(1, range.optInt("a", 0))
            val to = min(range.optInt("b", 0), from + MAX_BOARD_RANGE - 1)
            if (authorId.isBlank() || to < from) continue
            val operations = tremolaState.boardOperationDAO.getRange(
                config.roomId,
                authorId,
                from,
                to,
                MAX_BOARD_OPERATIONS_PER_PULSE - sent
            )
            operations.forEach { operation ->
                queueBoardOperationForPeer(peerAddress, operation)
                sent += 1
            }
        }
    }

    private fun handleBoardOperation(peerAddress: String, msg: JSONObject) {
        val config = boardConfig ?: return
        if (!authenticatedBoardPeers.containsKey(peerAddress) || msg.optString("r") != config.roomId) return
        val wire = msg.optJSONObject("w")?.toString() ?: return
        val decoded = BoardProtocol.decodeOperation(config, wire) ?: return
        if (!isAuthorizedBoardMember(decoded.operation.authorId)) return
        val inserted = storeBoardOperation(decoded)
        sendBoardAck(peerAddress, decoded.operation.operationId)
        if (inserted) {
            deliverBoardOperation(decoded)
            queueBoardOperationForAll(decoded.operation, peerAddress)
            val frontier = localBoardFrontier(config.roomId)[decoded.operation.authorId] ?: 0
            if (decoded.operation.authorSequence > frontier + 1) sendBoardFrontier(peerAddress)
        }
    }

    private fun sendBoardAck(peerAddress: String, operationId: String) {
        val config = boardConfig ?: return
        val msg = JSONObject()
            .put("t", "ba")
            .put("r", config.roomId)
            .put("f", tremolaState.idStore.identity.toRef())
            .put("i", operationId)
        sendJsonToPeer(peerAddress, msg)
    }

    private fun handleBoardAck(peerAddress: String, msg: JSONObject) {
        val config = boardConfig ?: return
        val peerFeed = authenticatedBoardPeers[peerAddress] ?: return
        if (msg.optString("r") != config.roomId || msg.optString("f") != peerFeed) return
        val operationId = msg.optString("i", "")
        if (operationId.isNotBlank()) pendingBoardDeliveries.remove(BoardDeliveryKey(peerFeed, operationId))
    }

    private fun storeBoardOperation(decoded: DecodedBoardOperation): Boolean {
        if (tremolaState.boardOperationDAO.getById(
                decoded.operation.roomId,
                decoded.operation.operationId
            ) != null
        ) return false
        return tremolaState.boardOperationDAO.insert(decoded.operation) != -1L
    }

    private fun deliverBoardOperation(decoded: DecodedBoardOperation) {
        val payload = JSONObject.quote(decoded.payload.toString())
        val feedId = JSONObject.quote(decoded.operation.authorId)
        val username = JSONObject.quote(boardMembers[decoded.operation.authorId] ?: "Nearby")
        val js = "if (typeof cb_receive_board_operation === 'function') " +
            "cb_receive_board_operation($payload, $feedId, $username);"
        try {
            tremolaState.wai.eval(js)
        } catch (_: Exception) {
        }
    }

    private fun queueBoardOperationForAll(
        operation: BoardOperation,
        excludedPeerAddress: String? = null
    ) {
        val excludedFeed = excludedPeerAddress?.let { authenticatedBoardPeers[it] }
        logicalBoardPeerAddresses().forEach { (peerFeed, address) ->
            if (peerFeed != excludedFeed) queueBoardOperationForPeer(address, operation)
        }
    }

    private fun queueBoardOperationForPeer(peerAddress: String, operation: BoardOperation): Boolean {
        val config = boardConfig ?: return false
        val peerFeed = authenticatedBoardPeers[peerAddress] ?: return false
        if (operation.roomId != config.roomId) return false
        val key = BoardDeliveryKey(peerFeed, operation.operationId)
        val pending = pendingBoardDeliveries.getOrPut(key) { PendingBoardDelivery(operation) }
        val messageKey = "board:operation:${operation.operationId}"
        if (isMessageQueuedForPeer(peerAddress, messageKey)) return true
        val msg = JSONObject()
            .put("t", "bo")
            .put("r", config.roomId)
            .put("w", JSONObject(operation.wireJson))
        val accepted = sendJsonToPeer(peerAddress, msg)
        if (accepted) {
            pending.lastSentAt = System.currentTimeMillis()
            pending.attempts += 1
            Log.d(TAG, "board op ${operation.operationId} to ${shortPeer(peerFeed)} attempt=${pending.attempts}")
        }
        return accepted
    }

    private fun isMessageQueuedForPeer(peerAddress: String, messageKey: String): Boolean {
        val client = clientLinks[peerAddress]
        val server = serverLinks[peerAddress]
        val routes = outboundRouteMask(
            hasClient = client != null,
            clientReady = client?.ready == true,
            hasServer = server != null,
            serverSubscribed = server?.subscribed == true
        )
        if (client != null && routes and ROUTE_CLIENT != 0 &&
            synchronized(client) { client.queue.contains(messageKey) }
        ) return true
        if (server != null && routes and ROUTE_SERVER != 0 &&
            synchronized(server) { server.queue.contains(messageKey) }
        ) return true
        return false
    }

    private fun retryBoardDeliveries(force: Boolean = false) {
        val now = System.currentTimeMillis()
        val routes = logicalBoardPeerAddresses()
        pendingBoardDeliveries.entries.forEach { (key, pending) ->
            if (pending.attempts >= MAX_BOARD_DELIVERY_ATTEMPTS) {
                pendingBoardDeliveries.remove(key, pending)
                return@forEach
            }
            if (!force && now - pending.lastSentAt < BOARD_OPERATION_RETRY_MS) return@forEach
            val address = routes[key.peerFeedId] ?: return@forEach
            queueBoardOperationForPeer(address, pending.operation)
        }
    }

    private fun boardWireFromEntry(entry: LogEntry): String? {
        val content = entry.pub ?: return null
        return try {
            val array = JSONArray(content)
            if (array.optString(0) != "CUS" || array.optString(1) != COLLAB_BOARD_APP_ID) return null
            val payload = array.opt(2)
            when (payload) {
                is JSONObject -> payload.toString()
                is String -> JSONObject(payload).toString()
                else -> null
            }
        } catch (_: Exception) {
            try {
                val obj = JSONObject(content)
                if (obj.optString("type") != "CUS" || obj.optString("app") != COLLAB_BOARD_APP_ID) {
                    null
                } else {
                    obj.optJSONObject("payload")?.toString()
                }
            } catch (_: Exception) {
                null
            }
        }
    }

    private fun reportBoardRoomStatus() {
        val roster = boardRoster()
        val members = JSONArray()
        roster.toSortedMap().forEach { (feedId, username) ->
            members.put(JSONObject().put("f", feedId).put("u", username))
        }
        val js = "if (typeof cb_room_status === 'function') " +
            "cb_room_status(${roster.size}, $MAX_BOARD_MEMBERS, ${members});"
        try {
            tremolaState.wai.eval(js)
        } catch (_: Exception) {
        }
    }

    private fun sendFrontierToAll() {
        val msg = frontierMessage()
        sendJsonToAll(msg)
    }

    private fun sendFrontier(peerAddress: String) {
        sendJsonToPeer(peerAddress, frontierMessage())
    }

    private fun frontierMessage(requestReply: Boolean = true): JSONObject {
        val msg = JSONObject()
        msg.put("t", "frontier")
        msg.put("reply", requestReply)
        val feeds = JSONObject()
        localFrontier().forEach { (lid, seq) -> feeds.put(lid, seq) }
        msg.put("feeds", feeds)
        return msg
    }

    private fun localFrontier(): Map<String, Int> {
        val map = mutableMapOf<String, Int>()
        map[tremolaState.idStore.identity.toRef()] = 0
        for (entry in tremolaState.logDAO.getAllAsList()) {
            val old = map[entry.lid] ?: 0
            if (entry.lsq > old) map[entry.lid] = entry.lsq
        }
        return map
    }

    private fun handleJsonMessage(peerAddress: String, msg: JSONObject) {
        when (msg.optString("t")) {
            "hello" -> {
                val fid = msg.optString("fid", "")
                if (fid.isNotBlank()) remoteFeedIds[peerAddress] = fid
                remoteProtocolVersions[peerAddress] = max(1, msg.optInt("v", 1))
                reportStatus("BLE peer ${shortPeer(fid)}")
                sendInitialSync(peerAddress)
            }
            "frontier" -> {
                if (boardConfig != null) return
                val feeds = msg.optJSONObject("feeds") ?: JSONObject()
                sendMissingEntries(peerAddress, feeds)
                if (msg.optBoolean("reply", false)) {
                    sendJsonToPeer(peerAddress, frontierMessage(false))
                }
            }
            "event" -> {
                if (boardConfig != null) return
                decodeEventMessage(msg)?.let { ingestRawEvent(peerAddress, it) }
            }
            "bp" -> handlePairingProbe(peerAddress, msg)
            "bc" -> handlePairingChallenge(peerAddress, msg)
            "bj" -> handlePairingRequest(peerAddress, msg)
            "bi" -> handlePairingOffer(peerAddress, msg)
            "bh" -> handleBoardHello(peerAddress, msg)
            "bm" -> handleBoardAdmission(peerAddress, msg)
            "bf" -> handleBoardFrontier(peerAddress, msg)
            "bw" -> handleBoardWant(peerAddress, msg)
            "bo" -> handleBoardOperation(peerAddress, msg)
            "ba" -> handleBoardAck(peerAddress, msg)
            "br" -> handleBoardReject(msg)
        }
    }

    private fun sendEventToAll(
        entry: LogEntry,
        excludedPeerAddress: String? = null,
        live: Boolean = false
    ) {
        val peers = HashSet<String>()
        peers.addAll(clientLinks.keys)
        peers.addAll(serverLinks.keys)
        peers.remove(excludedPeerAddress)
        if (boardConfig != null) peers.retainAll(authenticatedBoardPeers.keys)
        peers.forEach { sendEventToPeer(it, entry, live) }
    }

    private fun sendEventToPeer(peerAddress: String, entry: LogEntry, live: Boolean = false): Boolean {
        val msg = JSONObject()
        msg.put("t", "event")
        msg.put("hid", entry.hid)
        if (live) msg.put("live", true)
        val remoteVersion = remoteProtocolVersions[peerAddress] ?: 1
        val compressed = if (remoteVersion >= PROTOCOL_VERSION) compressEvent(entry.raw) else ByteArray(0)
        val useCompression = shouldUseCompressedEvent(
            remoteVersion,
            entry.raw.size,
            compressed.size
        )
        if (useCompression) {
            msg.put("enc", "deflate")
            msg.put("size", entry.raw.size)
            msg.put("raw", Base64.encodeToString(compressed, Base64.NO_WRAP))
        } else {
            msg.put("raw", Base64.encodeToString(entry.raw, Base64.NO_WRAP))
        }
        val accepted = sendJsonToPeer(peerAddress, msg)
        if (live) {
            Log.d(
                TAG,
                "live event ${entry.lsq} to $peerAddress accepted=$accepted " +
                    "raw=${entry.raw.size} compressed=${if (useCompression) compressed.size else 0}"
            )
        }
        return accepted
    }

    private fun decodeEventMessage(msg: JSONObject): ByteArray? {
        val encoded = try {
            Base64.decode(msg.getString("raw"), Base64.NO_WRAP)
        } catch (_: Exception) {
            return null
        }
        if (msg.optString("enc") != "deflate") {
            return encoded.takeIf { it.size <= MAX_RAW_EVENT_BYTES }
        }
        return decompressEvent(encoded, msg.optInt("size", -1))
    }

    private fun sendMissingEntries(peerAddress: String, remoteFrontier: JSONObject) {
        var sent = 0
        val local = localFrontier()
        val ownFeed = tremolaState.idStore.identity.toRef()
        val orderedFeeds = local.entries.sortedWith(
            compareBy<Map.Entry<String, Int>> { feedPriority(it.key, ownFeed) }
                .thenBy { it.key }
        )
        for ((lid, localSeq) in orderedFeeds) {
            val remoteSeq = max(0, remoteFrontier.optInt(lid, 0))
            if (localSeq <= remoteSeq) continue
            var seq = remoteSeq + 1
            while (seq <= localSeq && sent < MAX_EVENTS_PER_PULSE) {
                val event = tremolaState.logDAO.getEventByLogIdAndSeq(lid, seq) ?: break
                if (!sendEventToPeer(peerAddress, event)) return
                sent += 1
                seq += 1
            }
            if (sent >= MAX_EVENTS_PER_PULSE) break
        }
    }

    private fun ingestRawEvent(peerAddress: String, raw: ByteArray) {
        val body = raw.decodeToString()
        val entry = tremolaState.msgTypes.jsonToLogEntry(body, raw) ?: return
        val key = FeedSequence(entry.lid, entry.lsq)
        if (tremolaState.logDAO.getEventByHashId(entry.hid).isNotEmpty()) {
            pendingEvents.remove(key)
            return
        }

        val latest = tremolaState.logDAO.getMostRecentEventFromLogId(entry.lid)
        val chainOk = isNextEvent(latest?.lsq, latest?.hid, entry.lsq, entry.pre)
        if (!chainOk) {
            if (shouldBufferEvent(latest?.lsq, entry.lsq)) {
                val added = rememberPendingEvent(entry, peerAddress)
                if (added && isCollaborationBoardEvent(entry)) {
                    // The detached SSB signature is already valid. Show the
                    // CRDT operation immediately while predecessors continue
                    // to arrive; database insertion still waits for the chain.
                    tremolaState.wai.sendEventToFrontend(entry)
                    Log.i(TAG, "previewed signed board event ${entry.lsq} from ${shortPeer(entry.lid)}")
                }
            }
            Log.d(TAG, "missing chain before ${entry.lid}/${entry.lsq}, latest=${latest?.lsq}")
            sendFrontier(peerAddress)
            return
        }

        acceptVerifiedEvent(entry, peerAddress)
        drainPendingEvents(entry.lid)
    }

    private fun rememberPendingEvent(entry: LogEntry, sourcePeerAddress: String): Boolean {
        val key = FeedSequence(entry.lid, entry.lsq)
        if (pendingEvents.containsKey(key)) return false
        if (pendingEvents.size >= MAX_PENDING_EVENTS) {
            pendingEvents.entries.minByOrNull { it.value.createdAt }?.let {
                pendingEvents.remove(it.key, it.value)
            }
        }
        return pendingEvents.putIfAbsent(key, PendingEvent(entry, sourcePeerAddress)) == null
    }

    private fun acceptVerifiedEvent(entry: LogEntry, sourcePeerAddress: String) {
        if (tremolaState.logDAO.getEventByHashId(entry.hid).isNotEmpty()) return
        tremolaState.wai.rx_event(entry, sourcePeerAddress)
        Log.i(TAG, "accepted event ${entry.lsq} from ${shortPeer(entry.lid)}")
    }

    private fun drainPendingEvents(feedId: String) {
        while (true) {
            val latest = tremolaState.logDAO.getMostRecentEventFromLogId(feedId)
            val nextSequence = (latest?.lsq ?: 0) + 1
            val key = FeedSequence(feedId, nextSequence)
            val pending = pendingEvents.remove(key) ?: return
            val entry = pending.entry
            if (!isNextEvent(latest?.lsq, latest?.hid, entry.lsq, entry.pre)) {
                Log.w(TAG, "discarding forked pending event ${entry.lid}/${entry.lsq}")
                continue
            }
            acceptVerifiedEvent(entry, pending.sourcePeerAddress)
        }
    }

    private fun isCollaborationBoardEvent(entry: LogEntry): Boolean {
        val content = entry.pub ?: return false
        return try {
            val array = JSONArray(content)
            array.optString(0) == "CUS" && array.optString(1) == COLLAB_BOARD_APP_ID
        } catch (_: Exception) {
            try {
                val obj = JSONObject(content)
                obj.optString("type") == "CUS" && obj.optString("app") == COLLAB_BOARD_APP_ID
            } catch (_: Exception) {
                false
            }
        }
    }

    private fun sendJsonToAll(msg: JSONObject) {
        val peers = HashSet<String>()
        peers.addAll(clientLinks.keys)
        peers.addAll(serverLinks.keys)
        peers.forEach { sendJsonToPeer(it, msg) }
    }

    private fun sendJsonToPeer(peerAddress: String, msg: JSONObject): Boolean {
        val client = clientLinks[peerAddress]
        val server = serverLinks[peerAddress]
        val routes = outboundRouteMask(
            hasClient = client != null,
            clientReady = client?.ready == true,
            hasServer = server != null,
            serverSubscribed = server?.subscribed == true
        )
        var accepted = false
        if (client != null && routes and ROUTE_CLIENT != 0) {
            accepted = enqueueClient(client, msg) || accepted
        }
        if (server != null && routes and ROUTE_SERVER != 0) {
            accepted = enqueueServer(server, msg) || accepted
        }
        return accepted
    }

    private fun enqueueClient(link: ClientLink, msg: JSONObject): Boolean {
        val messageKey = messageQueueKey(msg)
        val frames = makeFrames(
            msg,
            link.mtu,
            (remoteProtocolVersions[link.address] ?: 1) >= COMPRESSED_FRAME_PROTOCOL_VERSION
        )
        val accepted = synchronized(link) {
            link.queue.enqueue(messageKey, frames, isPriorityMessage(msg), link.writing)
        }
        if (!accepted) {
            val queued = synchronized(link) { link.queue.size + if (link.writing) 1 else 0 }
            Log.w(TAG, "client queue rejected $messageKey frames=${frames.size} queued=$queued")
        }
        if (accepted) drainClient(link)
        return accepted
    }

    private fun drainClient(link: ClientLink) {
        if (!isRunning || clientLinks[link.address] !== link) return
        val ch = link.characteristic ?: return
        val attempt = synchronized(link) {
            if (!isRunning ||
                clientLinks[link.address] !== link ||
                !link.ready ||
                link.writing ||
                link.queue.isEmpty()
            ) return
            val frame = link.queue.removeFirst()
            link.writing = true
            link.inFlightFrame = frame
            link.writeOperationId += 1
            OutboundAttempt(frame, link.writeOperationId)
        }
        ch.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
        ch.value = attempt.frame.value
        val started = try {
            link.gatt.writeCharacteristic(ch)
        } catch (_: Exception) {
            false
        }
        if (!started) {
            val failures = synchronized(link) {
                if (!link.writing || link.writeOperationId != attempt.operationId) return
                link.writing = false
                link.inFlightFrame = null
                link.queue.addFirst(attempt.frame)
                link.writeFailures += 1
                link.writeFailures
            }
            handleClientWriteFailure(link, failures, "BLE write busy")
            return
        }
        scheduleWorker(FRAME_OPERATION_TIMEOUT_MS) {
            val timedOut = synchronized(link) {
                if (clientLinks[link.address] !== link ||
                    !link.writing ||
                    link.writeOperationId != attempt.operationId
                ) {
                    false
                } else {
                    link.writing = false
                    link.inFlightFrame = null
                    true
                }
            }
            if (timedOut) dropClientLink(link, "BLE write timed out")
        }
    }

    private fun enqueueServer(link: ServerLink, msg: JSONObject): Boolean {
        if (!link.subscribed) return false
        val messageKey = messageQueueKey(msg)
        val frames = makeFrames(
            msg,
            link.mtu,
            (remoteProtocolVersions[link.address] ?: 1) >= COMPRESSED_FRAME_PROTOCOL_VERSION
        )
        val accepted = synchronized(link) {
            link.queue.enqueue(messageKey, frames, isPriorityMessage(msg), link.sending)
        }
        if (!accepted) {
            val queued = synchronized(link) { link.queue.size + if (link.sending) 1 else 0 }
            Log.w(TAG, "server queue rejected $messageKey frames=${frames.size} queued=$queued")
        }
        if (accepted) drainServer(link)
        return accepted
    }

    private fun messageQueueKey(msg: JSONObject): String {
        return when (val type = msg.optString("t", "unknown")) {
            "event" -> {
                val hid = msg.optString("hid", "")
                if (hid.isNotBlank()) "event:$hid" else {
                    val raw = msg.optString("raw", "")
                    "event:${raw.length}:${raw.hashCode()}"
                }
            }
            "frontier" -> "frontier:${msg.optBoolean("reply", false)}"
            "hello" -> "hello"
            "bp" -> "board:pair:probe:${msg.optString("f", "")}:${msg.optString("j", "")}"
            "bc" -> "board:pair:challenge:${msg.optString("c", "")}"
            "bj" -> "board:pair:request:${msg.optString("c", "")}"
            "bi" -> "board:pair:invite:${msg.optString("c", "")}"
            "bh" -> "board:hello"
            "bm" -> "board:member:${msg.optJSONObject("a")?.optString("m", "") ?: ""}"
            "bf" -> "board:frontier"
            "bw" -> "board:want:${msg.toString().hashCode()}"
            "bo" -> "board:operation:${msg.optJSONObject("w")?.optString("i", "") ?: ""}"
            "ba" -> "board:ack:${msg.optString("i", "")}"
            "br" -> "board:reject"
            else -> "$type:${msg.toString().hashCode()}"
        }
    }

    private fun isPriorityMessage(msg: JSONObject): Boolean {
        return isPriorityMessageType(msg.optString("t"), msg.optBoolean("live", false))
    }

    private fun drainServer(link: ServerLink) {
        if (!isRunning || serverLinks[link.address] !== link) return
        val server = gattServer ?: return
        val ch = frameCharacteristic ?: return
        val (current, started) = synchronized(serverSendLock) {
            if (!isRunning || serverLinks[link.address] !== link || activeServerLink != null) return
            val attempt = synchronized(link) {
                if (!link.subscribed || link.sending || link.queue.isEmpty()) {
                    null
                } else {
                    val frame = link.queue.removeFirst()
                    link.sending = true
                    link.inFlightFrame = frame
                    link.sendOperationId += 1
                    OutboundAttempt(frame, link.sendOperationId)
                }
            } ?: return
            activeServerLink = link
            ch.value = attempt.frame.value
            val sendStarted = try {
                server.notifyCharacteristicChanged(link.device, ch, link.useIndications)
            } catch (_: Exception) {
                false
            }
            if (!sendStarted) activeServerLink = null
            attempt to sendStarted
        }
        if (!started) {
            val failures = synchronized(link) {
                if (!link.sending || link.sendOperationId != current.operationId) return
                link.sending = false
                link.inFlightFrame = null
                link.queue.addFirst(current.frame)
                link.sendFailures += 1
                link.sendFailures
            }
            handleServerSendFailure(link, failures, "BLE notification busy")
            return
        }
        scheduleWorker(FRAME_OPERATION_TIMEOUT_MS) {
            var timedOut = false
            synchronized(serverSendLock) {
                if (activeServerLink === link) {
                    timedOut = synchronized(link) {
                        if (!link.sending || link.sendOperationId != current.operationId) {
                            false
                        } else {
                            link.sending = false
                            link.inFlightFrame = null
                            true
                        }
                    }
                    if (timedOut) activeServerLink = null
                }
            }
            if (timedOut) dropServerLink(link, "BLE notification timed out")
        }
    }

    private fun makeFrames(msg: JSONObject, mtu: Int, allowCompression: Boolean): List<ByteArray> {
        val plainBody = msg.toString().encodeToByteArray()
        val compressed = if (allowCompression && plainBody.size >= MIN_COMPRESSED_FRAME_BYTES) {
            compressEvent(plainBody)
        } else {
            ByteArray(0)
        }
        val useCompression = compressed.isNotEmpty() && compressed.size + 16 < plainBody.size
        val body = if (useCompression) compressed else plainBody
        val frameKind = if (useCompression) FRAME_KIND_DEFLATE else FRAME_KIND_JSON
        val payloadSize = payloadSize(mtu)
        val total = max(1, (body.size + payloadSize - 1) / payloadSize)
        if (total > MAX_CHUNKS) {
            Log.w(TAG, "BLE message too large: ${body.size} bytes")
            return emptyList()
        }
        val msgId = nextMessageId.getAndIncrement() and 0xffff
        val frames = ArrayList<ByteArray>(total)
        for (seq in 0 until total) {
            val start = seq * payloadSize
            val end = min(body.size, start + payloadSize)
            val chunkLen = end - start
            val frame = ByteArray(FRAME_HEADER_SIZE + chunkLen)
            frame[0] = FRAME_VERSION.toByte()
            frame[1] = frameKind.toByte()
            putU16(frame, 2, msgId)
            putU16(frame, 4, seq)
            putU16(frame, 6, total)
            body.copyInto(frame, FRAME_HEADER_SIZE, start, end)
            frames.add(frame)
        }
        return frames
    }

    private fun receiveFrame(channelKey: String, peerAddress: String, frame: ByteArray) {
        if (frame.size < FRAME_HEADER_SIZE ||
            frame.size > FRAME_HEADER_SIZE + MAX_FRAME_PAYLOAD ||
            frame[0].toInt() != FRAME_VERSION
        ) return
        val kind = frame[1].toInt()
        if (kind != FRAME_KIND_JSON && kind != FRAME_KIND_DEFLATE) return
        val msgId = getU16(frame, 2)
        val seq = getU16(frame, 4)
        val total = getU16(frame, 6)
        if (total <= 0 || total > MAX_CHUNKS || seq >= total) return
        val key = "$channelKey:$msgId"
        if (!inbound.containsKey(key) && inbound.size >= MAX_INBOUND_MESSAGES) return
        val acc = inbound.getOrPut(key) { InboundMessage(total, kind) }
        var completed: ByteArray? = null
        synchronized(acc) {
            if (acc.total != total || acc.kind != kind) {
                inbound.remove(key, acc)
                return
            }
            acc.updatedAt = System.currentTimeMillis()
            acc.chunks[seq] = frame.copyOfRange(FRAME_HEADER_SIZE, frame.size)
            if (acc.chunks.size == total) {
                val size = acc.chunks.values.sumOf { it.size }
                val body = ByteArray(size)
                var offset = 0
                for (i in 0 until total) {
                    val chunk = acc.chunks[i] ?: return
                    chunk.copyInto(body, offset)
                    offset += chunk.size
                }
                inbound.remove(key, acc)
                completed = body
            }
        }
        completed?.let { encodedBody ->
            executeWorker {
                try {
                    val body = if (kind == FRAME_KIND_DEFLATE) {
                        decompressJson(encodedBody) ?: return@executeWorker
                    } else {
                        encodedBody
                    }
                    handleJsonMessage(peerAddress, JSONObject(body.decodeToString()))
                } catch (e: Exception) {
                    Log.e(TAG, "bad BLE message ${e.stackTraceToString()}")
                }
            }
        }
    }

    private fun pruneInbound() {
        val now = System.currentTimeMillis()
        inbound.entries.removeIf { isInboundTransferStale(it.value.updatedAt, now) }
        val pendingDeadline = System.currentTimeMillis() - PENDING_EVENT_TTL_MS
        pendingEvents.entries.removeIf { it.value.createdAt < pendingDeadline }
    }

    private fun payloadSize(mtu: Int): Int {
        return framePayloadSize(mtu)
    }

    private fun reportStatus(text: String) {
        val ownFeed = tremolaState.idStore.identity.toRef()
        val peerCount = if (boardConfig != null) {
            authenticatedBoardPeers.values.filter { it != ownFeed }.toSet().size
        } else {
            remoteFeedIds.values.filter { it.isNotBlank() && it != ownFeed }.toSet().size
        }
        val queued = clientLinks.values.sumOf { link ->
            synchronized(link) { link.queue.size + if (link.writing) 1 else 0 }
        } + serverLinks.values.sumOf { link ->
            synchronized(link) { link.queue.size + if (link.sending) 1 else 0 }
        } + pendingEvents.size + pendingBoardDeliveries.size
        Log.i(TAG, "$text (peers=$peerCount, queue=$queued)")
        val status = JSONObject.quote(text)
        val js = "if (typeof b2f_ble_status === 'function') " +
            "b2f_ble_status($status, $peerCount, $queued);" +
            "if (typeof cb_ble_status === 'function') " +
            "cb_ble_status($status, $peerCount, $queued);"
        try {
            tremolaState.wai.eval(js)
        } catch (_: Exception) {
        }
    }

    private fun shortPeer(fid: String): String {
        if (fid.length < 14) return "nearby"
        return fid.substring(1, min(fid.length, 9))
    }

    private fun putU16(buf: ByteArray, offset: Int, value: Int) {
        buf[offset] = ((value ushr 8) and 0xff).toByte()
        buf[offset + 1] = (value and 0xff).toByte()
    }

    private fun getU16(buf: ByteArray, offset: Int): Int {
        return ((buf[offset].toInt() and 0xff) shl 8) or (buf[offset + 1].toInt() and 0xff)
    }

    companion object {
        private const val TAG = "BleSync"
        private const val COLLAB_BOARD_APP_ID = "collabboard"
        private const val PROTOCOL_VERSION = 3
        private const val EVENT_COMPRESSION_PROTOCOL_VERSION = 2
        private const val COMPRESSED_FRAME_PROTOCOL_VERSION = 3
        private const val FRAME_VERSION = 1
        private const val FRAME_KIND_JSON = 1
        private const val FRAME_KIND_DEFLATE = 2
        private const val FRAME_HEADER_SIZE = 8
        private const val DEFAULT_MTU = 23
        private const val PREFERRED_MTU = 247
        private const val MAX_FRAME_PAYLOAD = 180
        private const val MAX_CHUNKS = 1024
        private const val MAX_INBOUND_MESSAGES = 64
        private const val MAX_RAW_EVENT_BYTES = 131072
        private const val MAX_JSON_MESSAGE_BYTES = 262144
        private const val MIN_COMPRESSED_FRAME_BYTES = 96
        private const val MAX_PENDING_EVENTS = 512
        private const val MAX_QUEUED_FRAMES_PER_LINK = 2048
        private const val MAX_EVENTS_PER_PULSE = 24
        private const val SYNC_INTERVAL_SECONDS = 2L
        private const val SCAN_WINDOW_SECONDS = 5L
        private const val SCAN_RESTART_MS = 7000L
        private const val CONNECTED_SCAN_WINDOW_MS = 2000L
        private const val CONNECTED_SCAN_RESTART_MS = 30000L
        private const val INBOUND_IDLE_TTL_MS = 120000L
        private const val PENDING_EVENT_TTL_MS = 300000L
        private const val GATT_OPERATION_TIMEOUT_SECONDS = 2L
        private const val FRAME_OPERATION_TIMEOUT_MS = 5000L
        private const val CLIENT_SETUP_TIMEOUT_MS = 15000L
        private const val FRAME_RETRY_BASE_MS = 250L
        private const val MAX_FRAME_OPERATION_FAILURES = 3
        private const val BOARD_PREFS = "collabboard_ble"
        private const val BOARD_CONFIG_KEY = "room_config"
        private const val BOARD_MEMBERS_KEY = "room_members"
        private const val BOARD_MEMBERS_ROOM_KEY = "room_members_id"
        private const val BOARD_ADMISSIONS_KEY = "room_admissions"
        private const val BOARD_ADMISSIONS_ROOM_KEY = "room_admissions_id"
        private const val BOARD_PROFILE_PREFIX = "room_profile_"
        private const val BOARD_PAIRING_ROOM_KEY = "pairing_room"
        private const val BOARD_PAIRING_CODE_KEY = "pairing_code"
        private const val BOARD_PAIRING_EXPIRES_KEY = "pairing_expires"
        private const val MAX_BOARD_MEMBERS = 4
        private const val MAX_BOARD_RANGE = 64
        private const val MAX_BOARD_WANT_RANGES = 16
        private const val MAX_BOARD_OPERATIONS_PER_PULSE = 24
        private const val MAX_BOARD_DELIVERY_ATTEMPTS = 12
        private const val BOARD_OPERATION_RETRY_MS = 2000L
        private const val BOARD_FRONTIER_INTERVAL_MS = 5000L
        private const val BOARD_PAIRING_SESSION_SECONDS = 600
        private const val BOARD_PAIRING_SESSION_MS = BOARD_PAIRING_SESSION_SECONDS * 1000L
        private const val BOARD_PAIRING_CHALLENGE_MS = 30000L
        private const val BOARD_PAIRING_RESERVATION_MS = 60000L
        private const val BOARD_PAIRING_JOIN_TIMEOUT_MS = 60000L
        private const val MAX_PAIRING_FAILURES_PER_FEED = 3
        private const val MAX_PAIRING_FAILURES_TOTAL = 10

        internal fun framePayloadSize(mtu: Int): Int {
            // A GATT value may use MTU - 3 bytes. The frame header is part of
            // that value, so only the remaining bytes carry message data.
            val attPayload = max(FRAME_HEADER_SIZE + 1, mtu - 3)
            return min(MAX_FRAME_PAYLOAD, attPayload - FRAME_HEADER_SIZE)
        }

        internal fun canQueueFrames(queued: Int, batch: Int): Boolean {
            return batch > 0 && batch <= MAX_QUEUED_FRAMES_PER_LINK &&
                queued >= 0 && queued + batch <= MAX_QUEUED_FRAMES_PER_LINK
        }

        internal fun supportsIndications(properties: Int): Boolean {
            return properties and BluetoothGattCharacteristic.PROPERTY_INDICATE != 0
        }

        internal fun shouldUseCompressedEvent(
            remoteProtocolVersion: Int,
            rawSize: Int,
            compressedSize: Int
        ): Boolean {
            return remoteProtocolVersion >= EVENT_COMPRESSION_PROTOCOL_VERSION && rawSize > 0 &&
                compressedSize > 0 && compressedSize + 32 < rawSize
        }

        internal fun compressEvent(raw: ByteArray): ByteArray {
            if (raw.isEmpty()) return raw
            val deflater = Deflater(Deflater.BEST_SPEED)
            return try {
                deflater.setInput(raw)
                deflater.finish()
                val output = ByteArrayOutputStream(raw.size)
                val buffer = ByteArray(1024)
                while (!deflater.finished()) {
                    val count = deflater.deflate(buffer)
                    if (count <= 0) break
                    output.write(buffer, 0, count)
                }
                output.toByteArray()
            } finally {
                deflater.end()
            }
        }

        internal fun decompressEvent(compressed: ByteArray, expectedSize: Int): ByteArray? {
            if (expectedSize !in 1..MAX_RAW_EVENT_BYTES || compressed.isEmpty()) return null
            val inflater = Inflater()
            return try {
                inflater.setInput(compressed)
                val output = ByteArrayOutputStream(min(expectedSize, 8192))
                val buffer = ByteArray(1024)
                while (!inflater.finished()) {
                    val count = inflater.inflate(buffer)
                    if (count <= 0) return null
                    if (output.size() + count > MAX_RAW_EVENT_BYTES) return null
                    output.write(buffer, 0, count)
                }
                output.toByteArray().takeIf { it.size == expectedSize }
            } catch (_: Exception) {
                null
            } finally {
                inflater.end()
            }
        }

        internal fun decompressJson(compressed: ByteArray): ByteArray? {
            if (compressed.isEmpty() || compressed.size > MAX_JSON_MESSAGE_BYTES) return null
            val inflater = Inflater()
            return try {
                inflater.setInput(compressed)
                val output = ByteArrayOutputStream(min(compressed.size * 3, 8192))
                val buffer = ByteArray(1024)
                while (!inflater.finished()) {
                    val count = inflater.inflate(buffer)
                    if (count <= 0) return null
                    if (output.size() + count > MAX_JSON_MESSAGE_BYTES) return null
                    output.write(buffer, 0, count)
                }
                output.toByteArray()
            } catch (_: Exception) {
                null
            } finally {
                inflater.end()
            }
        }

        internal fun isInboundTransferStale(lastProgressAt: Long, now: Long): Boolean {
            return now >= lastProgressAt && now - lastProgressAt > INBOUND_IDLE_TTL_MS
        }

        internal fun feedPriority(feedId: String, ownFeedId: String): Int {
            return if (feedId == ownFeedId) 0 else 1
        }

        internal fun isNextEvent(
            latestSequence: Int?,
            latestHash: String?,
            incomingSequence: Int,
            incomingPrevious: String?
        ): Boolean {
            if (latestSequence == null) return incomingSequence == 1
            return incomingSequence == latestSequence + 1 && incomingPrevious == latestHash
        }

        internal fun shouldBufferEvent(latestSequence: Int?, incomingSequence: Int): Boolean {
            return incomingSequence > (latestSequence ?: 0) + 1
        }

        internal fun frameRetryDelayMillis(failures: Int): Long {
            return min(1000L, max(1, failures) * FRAME_RETRY_BASE_MS)
        }

        internal fun shouldDropLinkAfterFailures(failures: Int): Boolean {
            return failures >= MAX_FRAME_OPERATION_FAILURES
        }

        internal fun scanWindowMillis(hasUsablePeer: Boolean): Long {
            return if (hasUsablePeer) CONNECTED_SCAN_WINDOW_MS else SCAN_WINDOW_SECONDS * 1000L
        }

        internal fun scanRestartMillis(hasUsablePeer: Boolean): Long {
            return if (hasUsablePeer) CONNECTED_SCAN_RESTART_MS else SCAN_RESTART_MS
        }

        internal fun isPriorityMessageType(type: String, live: Boolean): Boolean {
            return when (type) {
                "event" -> live
                "bo" -> false
                else -> true
            }
        }

        internal const val ROUTE_CLIENT = 1
        internal const val ROUTE_SERVER = 2

        internal fun outboundRouteMask(
            hasClient: Boolean,
            clientReady: Boolean,
            hasServer: Boolean,
            serverSubscribed: Boolean
        ): Int {
            // One logical peer needs one transport route. Sending every frame
            // over both directions doubles traffic and creates return storms.
            if (hasClient && clientReady) return ROUTE_CLIENT
            if (hasServer && serverSubscribed) return ROUTE_SERVER
            if (hasClient) return ROUTE_CLIENT
            if (hasServer) return ROUTE_SERVER
            return 0
        }

        val SERVICE_UUID: UUID = UUID.fromString("1d38bfa0-a38d-43f2-bbd4-aad371520001")
        val FRAME_UUID: UUID = UUID.fromString("1d38bfa0-a38d-43f2-bbd4-aad371520002")
        val CCCD_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

        private val API_31_PERMISSIONS = arrayOf(
            "android.permission.BLUETOOTH_SCAN",
            "android.permission.BLUETOOTH_ADVERTISE",
            "android.permission.BLUETOOTH_CONNECT"
        )

        fun missingPermissions(activity: Activity): Array<String> {
            val locationPermissions = arrayOf(
                Manifest.permission.ACCESS_COARSE_LOCATION,
                Manifest.permission.ACCESS_FINE_LOCATION
            )
            val required = if (Build.VERSION.SDK_INT >= 31) {
                API_31_PERMISSIONS + locationPermissions
            } else {
                locationPermissions
            }
            return required.filter {
                activity.checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED
            }.toTypedArray()
        }
    }
}
