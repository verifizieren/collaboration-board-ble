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
import nz.scuttlebutt.tremola.ssb.db.entities.LogEntry
import org.json.JSONObject
import java.util.ArrayDeque
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.max
import kotlin.math.min

/**
 * BLE transport for Tremola log entries.
 *
 * This deliberately exchanges signed SSB log entries and per-feed frontiers,
 * not live drawing operations. The whiteboard remains a normal Tremola miniApp:
 * drawing creates a signed CUS event, then every available transport can move
 * that raw event to nearby peers.
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
    private val remoteFeedIds = ConcurrentHashMap<String, String>()
    private val connecting = ConcurrentHashMap.newKeySet<String>()
    private val nextMessageId = AtomicInteger(1)

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
        val queue: ArrayDeque<ByteArray> = ArrayDeque()
    )

    private data class ServerLink(
        val address: String,
        val device: BluetoothDevice,
        @Volatile var mtu: Int = DEFAULT_MTU,
        @Volatile var subscribed: Boolean = false,
        var sending: Boolean = false,
        val queue: ArrayDeque<ByteArray> = ArrayDeque()
    )

    private data class InboundMessage(
        val total: Int,
        val createdAt: Long = System.currentTimeMillis(),
        val chunks: MutableMap<Int, ByteArray> = mutableMapOf()
    )

    fun start() {
        if (isRunning) return
        val adapter = bluetoothAdapter
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
        scanner = adapter.bluetoothLeScanner
        advertiser = adapter.bluetoothLeAdvertiser

        openGattServer()
        startAdvertising()
        startScan()

        syncTask?.cancel(false)
        syncTask = worker.scheduleAtFixedRate({
            if (!isRunning) return@scheduleAtFixedRate
            pruneInbound()
            openGattServer()
            startAdvertising()
            startScan()
            sendFrontierToAll()
            reportStatus("BLE sync active")
        }, 2, SYNC_INTERVAL_SECONDS, TimeUnit.SECONDS)
    }

    fun stop(shutdownWorker: Boolean = false) {
        isRunning = false
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
        serverLinks.clear()
        connecting.clear()
        inbound.clear()
        remoteFeedIds.clear()
        reportStatus("BLE stopped")
        if (shutdownWorker) worker.shutdownNow()
    }

    fun kick() {
        if (!isRunning) {
            start()
            return
        }
        worker.execute {
            sendFrontierToAll()
            reportStatus("BLE sync requested")
        }
    }

    fun onLocalLogEntry(entry: LogEntry) {
        worker.execute {
            val msg = JSONObject()
            msg.put("t", "event")
            msg.put("raw", Base64.encodeToString(entry.raw, Base64.NO_WRAP))
            sendJsonToAll(msg)
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
                BluetoothGattCharacteristic.PROPERTY_NOTIFY,
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
        if (!isRunning || isScanning || now - lastScanStartedAt < SCAN_RESTART_MS) return
        val bleScanner = scanner ?: bluetoothAdapter?.bluetoothLeScanner ?: return
        scanner = bleScanner
        val filters = listOf(
            ScanFilter.Builder()
                .setServiceUuid(ParcelUuid(SERVICE_UUID))
                .build()
        )
        val settings = ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
            .build()
        try {
            bleScanner.startScan(filters, settings, scanCallback)
            isScanning = true
            lastScanStartedAt = now
            worker.schedule({
                try {
                    bleScanner.stopScan(scanCallback)
                } catch (_: Exception) {
                }
                isScanning = false
            }, SCAN_WINDOW_SECONDS, TimeUnit.SECONDS)
        } catch (e: Exception) {
            Log.e(TAG, "scan failed ${e.stackTraceToString()}")
            isScanning = false
            reportStatus("BLE scan failed")
        }
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
            clientLinks[address] = ClientLink(address, gatt)
            reportStatus("BLE connecting")
        } catch (e: Exception) {
            connecting.remove(address)
            Log.e(TAG, "connect failed ${e.stackTraceToString()}")
        }
    }

    private val clientCallback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
            val address = gatt.device.address
            if (newState == BluetoothProfile.STATE_CONNECTED) {
                connecting.remove(address)
                val link = clientLinks[address] ?: return
                synchronized(link) {
                    link.ready = false
                    link.servicesRequested = false
                    link.subscribing = false
                    link.characteristic = null
                }
                val requestedMtu = try {
                    gatt.requestMtu(PREFERRED_MTU)
                } catch (_: Exception) {
                    false
                }
                if (!requestedMtu) discoverServices(link)
                worker.schedule(
                    { discoverServices(link) },
                    GATT_OPERATION_TIMEOUT_SECONDS,
                    TimeUnit.SECONDS
                )
                reportStatus("BLE connected")
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                connecting.remove(address)
                clientLinks.remove(address)
                remoteFeedIds.remove(address)
                try {
                    gatt.close()
                } catch (_: Exception) {
                }
                reportStatus("BLE disconnected")
            }
        }

        override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
            clientLinks[gatt.device.address]?.let { link ->
                if (status == BluetoothGatt.GATT_SUCCESS) link.mtu = mtu
                discoverServices(link)
            }
        }

        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            val link = clientLinks[gatt.device.address] ?: return
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
            val link = clientLinks[gatt.device.address] ?: return
            synchronized(link) { link.subscribing = false }
            if (status == BluetoothGatt.GATT_SUCCESS) {
                markClientReady(link)
            } else {
                reportStatus("BLE notification setup failed")
                scheduleSubscription(link)
            }
        }

        override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
            receiveFrame("client:${gatt.device.address}", gatt.device.address, characteristic.value)
        }

        override fun onCharacteristicWrite(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            status: Int
        ) {
            val link = clientLinks[gatt.device.address] ?: return
            synchronized(link) {
                link.writing = false
            }
            drainClient(link)
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
            if (newState == BluetoothProfile.STATE_CONNECTED) {
                serverLinks.putIfAbsent(address, ServerLink(address, device))
                reportStatus("BLE peer connected")
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                serverLinks.remove(address)
                remoteFeedIds.remove(address)
                reportStatus("BLE peer disconnected")
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
            gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, value)
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
            receiveFrame("server:${device.address}", device.address, value)
            if (responseNeeded) {
                gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, null)
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
            val link = serverLinks.getOrPut(device.address) { ServerLink(device.address, device) }
            link.subscribed = value.contentEquals(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
            if (responseNeeded) {
                gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, null)
            }
            if (link.subscribed) {
                sendHello(link.address)
                sendFrontier(link.address)
            }
            reportStatus("BLE notifications ${if (link.subscribed) "on" else "off"}")
        }

        override fun onNotificationSent(device: BluetoothDevice, status: Int) {
            val link = serverLinks[device.address] ?: return
            synchronized(link) {
                link.sending = false
            }
            drainServer(link)
        }
    }

    private fun markClientReady(link: ClientLink) {
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
        sendHello(link.address)
        sendFrontier(link.address)
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
        worker.schedule({
            val retry = synchronized(link) {
                if (!link.ready && link.servicesRequested) {
                    link.servicesRequested = false
                    true
                } else {
                    false
                }
            }
            if (retry) discoverServices(link)
        }, GATT_OPERATION_TIMEOUT_SECONDS, TimeUnit.SECONDS)
    }

    private fun scheduleServiceDiscovery(link: ClientLink) {
        worker.schedule(
            { discoverServices(link) },
            GATT_OPERATION_TIMEOUT_SECONDS,
            TimeUnit.SECONDS
        )
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
                descriptor.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
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
        worker.schedule({
            val retry = synchronized(link) {
                if (!link.ready && link.subscribing) {
                    link.subscribing = false
                    true
                } else {
                    false
                }
            }
            if (retry) subscribeClient(link)
        }, GATT_OPERATION_TIMEOUT_SECONDS, TimeUnit.SECONDS)
    }

    private fun scheduleSubscription(link: ClientLink) {
        worker.schedule(
            { subscribeClient(link) },
            GATT_OPERATION_TIMEOUT_SECONDS,
            TimeUnit.SECONDS
        )
    }

    private fun sendHello(peerAddress: String? = null) {
        val msg = JSONObject()
        msg.put("t", "hello")
        msg.put("v", 1)
        msg.put("fid", tremolaState.idStore.identity.toRef())
        if (peerAddress == null) sendJsonToAll(msg) else sendJsonToPeer(peerAddress, msg)
    }

    private fun sendFrontierToAll() {
        val msg = frontierMessage()
        sendJsonToAll(msg)
    }

    private fun sendFrontier(peerAddress: String) {
        sendJsonToPeer(peerAddress, frontierMessage())
    }

    private fun frontierMessage(): JSONObject {
        val msg = JSONObject()
        msg.put("t", "frontier")
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
                reportStatus("BLE peer ${shortPeer(fid)}")
                sendFrontier(peerAddress)
            }
            "frontier" -> {
                val feeds = msg.optJSONObject("feeds") ?: JSONObject()
                sendMissingEntries(peerAddress, feeds)
            }
            "event" -> {
                val raw = Base64.decode(msg.getString("raw"), Base64.NO_WRAP)
                ingestRawEvent(peerAddress, raw)
            }
        }
    }

    private fun sendMissingEntries(peerAddress: String, remoteFrontier: JSONObject) {
        var sent = 0
        val local = localFrontier()
        for ((lid, localSeq) in local.entries.sortedBy { it.key }) {
            val remoteSeq = max(0, remoteFrontier.optInt(lid, 0))
            if (localSeq <= remoteSeq) continue
            var seq = remoteSeq + 1
            while (seq <= localSeq && sent < MAX_EVENTS_PER_PULSE) {
                val event = tremolaState.logDAO.getEventByLogIdAndSeq(lid, seq) ?: break
                val msg = JSONObject()
                msg.put("t", "event")
                msg.put("raw", Base64.encodeToString(event.raw, Base64.NO_WRAP))
                if (!sendJsonToPeer(peerAddress, msg)) return
                sent += 1
                seq += 1
            }
            if (sent >= MAX_EVENTS_PER_PULSE) break
        }
    }

    private fun ingestRawEvent(peerAddress: String, raw: ByteArray) {
        val body = raw.decodeToString()
        val entry = tremolaState.msgTypes.jsonToLogEntry(body, raw) ?: return
        if (tremolaState.logDAO.getEventByHashId(entry.hid).isNotEmpty()) return

        val latest = tremolaState.logDAO.getMostRecentEventFromLogId(entry.lid)
        val chainOk = if (entry.lsq == 1) {
            latest == null
        } else {
            latest != null && latest.lsq + 1 == entry.lsq && latest.hid == entry.pre
        }
        if (!chainOk) {
            Log.d(TAG, "missing chain before ${entry.lid}/${entry.lsq}, latest=${latest?.lsq}")
            sendFrontier(peerAddress)
            return
        }

        tremolaState.wai.rx_event(entry)
        Log.i(TAG, "accepted event ${entry.lsq} from ${shortPeer(entry.lid)}")
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
        if (client != null && client.ready) {
            return enqueueClient(client, msg)
        }
        if (server != null && server.subscribed) {
            return enqueueServer(server, msg)
        }
        if (client != null) return enqueueClient(client, msg)
        if (server != null) return enqueueServer(server, msg)
        return false
    }

    private fun enqueueClient(link: ClientLink, msg: JSONObject): Boolean {
        val frames = makeFrames(msg, link.mtu)
        val accepted = synchronized(link) {
            enqueueFrames(link.queue, frames)
        }
        if (accepted) drainClient(link)
        return accepted
    }

    private fun drainClient(link: ClientLink) {
        val ch = link.characteristic ?: return
        synchronized(link) {
            if (!link.ready || link.writing || link.queue.isEmpty()) return
            val frame = link.queue.removeFirst()
            link.writing = true
            ch.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
            ch.value = frame
            if (!link.gatt.writeCharacteristic(ch)) {
                link.writing = false
                link.queue.addFirst(frame)
            }
        }
    }

    private fun enqueueServer(link: ServerLink, msg: JSONObject): Boolean {
        if (!link.subscribed) return false
        val frames = makeFrames(msg, link.mtu)
        val accepted = synchronized(link) {
            enqueueFrames(link.queue, frames)
        }
        if (accepted) drainServer(link)
        return accepted
    }

    private fun enqueueFrames(queue: ArrayDeque<ByteArray>, frames: List<ByteArray>): Boolean {
        // Keep each JSON message intact. Dropping individual frames can make
        // the first missing feed entry impossible to reconstruct on a peer.
        if (!canQueueFrames(queue.size, frames.size)) {
            if (frames.size > MAX_QUEUED_FRAMES_PER_LINK) {
                Log.w(TAG, "BLE frame batch too large: ${frames.size}")
            }
            return false
        }
        frames.forEach { queue.add(it) }
        return true
    }

    private fun drainServer(link: ServerLink) {
        val server = gattServer ?: return
        val ch = frameCharacteristic ?: return
        synchronized(link) {
            if (!link.subscribed || link.sending || link.queue.isEmpty()) return
            val frame = link.queue.removeFirst()
            link.sending = true
            ch.value = frame
            if (!server.notifyCharacteristicChanged(link.device, ch, false)) {
                link.sending = false
                link.queue.addFirst(frame)
            }
        }
    }

    private fun makeFrames(msg: JSONObject, mtu: Int): List<ByteArray> {
        val body = msg.toString().encodeToByteArray()
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
            frame[1] = FRAME_KIND_JSON.toByte()
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
        if (frame[1].toInt() != FRAME_KIND_JSON) return
        val msgId = getU16(frame, 2)
        val seq = getU16(frame, 4)
        val total = getU16(frame, 6)
        if (total <= 0 || total > MAX_CHUNKS || seq >= total) return
        val key = "$channelKey:$msgId"
        if (!inbound.containsKey(key) && inbound.size >= MAX_INBOUND_MESSAGES) return
        val acc = inbound.getOrPut(key) { InboundMessage(total) }
        var completed: ByteArray? = null
        synchronized(acc) {
            if (acc.total != total) {
                inbound.remove(key, acc)
                return
            }
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
        completed?.let { body ->
            worker.execute {
                try {
                    handleJsonMessage(peerAddress, JSONObject(body.decodeToString()))
                } catch (e: Exception) {
                    Log.e(TAG, "bad BLE message ${e.stackTraceToString()}")
                }
            }
        }
    }

    private fun pruneInbound() {
        val deadline = System.currentTimeMillis() - INBOUND_TTL_MS
        inbound.entries.removeIf { it.value.createdAt < deadline }
    }

    private fun payloadSize(mtu: Int): Int {
        return framePayloadSize(mtu)
    }

    private fun reportStatus(text: String) {
        val peers = HashSet<String>()
        peers.addAll(clientLinks.keys)
        peers.addAll(serverLinks.keys)
        val queued = clientLinks.values.sumOf { it.queue.size } + serverLinks.values.sumOf { it.queue.size }
        Log.i(TAG, "$text (peers=${peers.size}, queue=$queued)")
        val status = JSONObject.quote(text)
        val js = "if (typeof b2f_ble_status === 'function') " +
            "b2f_ble_status($status, ${peers.size}, $queued);" +
            "if (typeof cb_ble_status === 'function') " +
            "cb_ble_status($status, ${peers.size}, $queued);"
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
        private const val FRAME_VERSION = 1
        private const val FRAME_KIND_JSON = 1
        private const val FRAME_HEADER_SIZE = 8
        private const val DEFAULT_MTU = 23
        private const val PREFERRED_MTU = 247
        private const val MAX_FRAME_PAYLOAD = 180
        private const val MAX_CHUNKS = 1024
        private const val MAX_INBOUND_MESSAGES = 32
        private const val MAX_QUEUED_FRAMES_PER_LINK = 2048
        private const val MAX_EVENTS_PER_PULSE = 24
        private const val SYNC_INTERVAL_SECONDS = 8L
        private const val SCAN_WINDOW_SECONDS = 5L
        private const val SCAN_RESTART_MS = 7000L
        private const val INBOUND_TTL_MS = 30000L
        private const val GATT_OPERATION_TIMEOUT_SECONDS = 2L

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

        val SERVICE_UUID: UUID = UUID.fromString("1d38bfa0-a38d-43f2-bbd4-aad371520001")
        val FRAME_UUID: UUID = UUID.fromString("1d38bfa0-a38d-43f2-bbd4-aad371520002")
        val CCCD_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

        private val API_31_PERMISSIONS = arrayOf(
            "android.permission.BLUETOOTH_SCAN",
            "android.permission.BLUETOOTH_ADVERTISE",
            "android.permission.BLUETOOTH_CONNECT"
        )

        fun missingPermissions(activity: Activity): Array<String> {
            val required = if (Build.VERSION.SDK_INT >= 31) {
                API_31_PERMISSIONS + Manifest.permission.ACCESS_FINE_LOCATION
            } else {
                arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)
            }
            return required.filter {
                activity.checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED
            }.toTypedArray()
        }
    }
}
