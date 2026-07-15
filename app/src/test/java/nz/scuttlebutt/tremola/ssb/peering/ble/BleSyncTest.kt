package nz.scuttlebutt.tremola.ssb.peering.ble

import android.bluetooth.BluetoothGattCharacteristic
import org.junit.Assert.assertEquals
import org.junit.Test

class BleSyncTest {
    @Test
    fun framePayloadFitsInsideGattValue() {
        // Default BLE MTU: 23 - 3 ATT bytes - 8 frame header bytes.
        assertEquals(12, BleSync.framePayloadSize(23))

        // The preferred MTU is capped at the conservative payload limit.
        assertEquals(180, BleSync.framePayloadSize(247))
        assertEquals(180, BleSync.framePayloadSize(517))

        // Invalid/small values still leave one byte and cannot underflow.
        assertEquals(1, BleSync.framePayloadSize(3))
    }

    @Test
    fun frameBatchesAreQueuedAtomically() {
        assertEquals(true, BleSync.canQueueFrames(0, 2048))
        assertEquals(true, BleSync.canQueueFrames(2000, 48))
        assertEquals(false, BleSync.canQueueFrames(2000, 49))
        assertEquals(false, BleSync.canQueueFrames(0, 2049))
        assertEquals(false, BleSync.canQueueFrames(0, 0))
    }

    @Test
    fun outboundQueueCoalescesDuplicatesAndPrioritizesControlMessages() {
        val queue = BleOutboundQueue(8)
        val eventFrames = listOf(byteArrayOf(1), byteArrayOf(2), byteArrayOf(3))
        val frontierFrames = listOf(byteArrayOf(8), byteArrayOf(9))

        assertEquals(true, queue.enqueue("event:%one", eventFrames, false, false))
        assertEquals(3, queue.size)

        // Repeated frontier pulses must not append the same long event again.
        repeat(100) {
            assertEquals(true, queue.enqueue("event:%one", eventFrames, false, false))
        }
        assertEquals(3, queue.size)

        // A later move event still has room instead of being starved by copies.
        assertEquals(true, queue.enqueue("event:%move", listOf(byteArrayOf(4)), false, false))
        assertEquals(4, queue.size)

        val eventInFlight = queue.removeFirst()
        assertEquals("event:%one", eventInFlight.messageKey)
        assertEquals(true, queue.enqueue("frontier:true", frontierFrames, true, true))
        assertEquals("frontier:true", queue.removeFirst().messageKey)
        val frontierLast = queue.removeFirst()
        assertEquals(true, frontierLast.completesMessage)
        queue.complete(frontierLast)

        // Completing the control message releases only its own dedupe key.
        assertEquals(true, queue.enqueue("frontier:true", listOf(byteArrayOf(10)), true, true))
        assertEquals(true, queue.contains("event:%one"))
        assertEquals(true, queue.contains("frontier:true"))

        queue.complete(queue.removeFirst())
        queue.complete(eventInFlight)
        queue.complete(queue.removeFirst())
        queue.complete(queue.removeFirst())
        assertEquals(false, queue.contains("event:%one"))
        assertEquals(true, queue.enqueue("event:%one", eventFrames, false, true))
    }

    @Test
    fun aLiveEventAlreadyQueuedAsHistoryIsPromoted() {
        val queue = BleOutboundQueue(8)
        val eventFrames = listOf(byteArrayOf(1), byteArrayOf(2))

        assertEquals(true, queue.enqueue("event:%history", eventFrames, false, false))
        assertEquals(true, queue.enqueue("event:%live", listOf(byteArrayOf(9)), false, false))
        assertEquals(true, queue.enqueue("event:%history", eventFrames, true, false))

        assertEquals("event:%history", queue.removeFirst().messageKey)
        assertEquals("event:%history", queue.removeFirst().messageKey)
        assertEquals("event:%live", queue.removeFirst().messageKey)
    }

    @Test
    fun historyCannotConsumeTheLiveEventReserve() {
        val queue = BleOutboundQueue(8)

        assertEquals(true, queue.enqueue("history:one", List(6) { byteArrayOf(1) }, false, false))
        assertEquals(false, queue.enqueue("history:two", listOf(byteArrayOf(2)), false, false))
        assertEquals(true, queue.enqueue("live:one", List(2) { byteArrayOf(3) }, true, false))
        assertEquals(8, queue.size)
    }

    @Test
    fun compressedEventsRoundTripAndStayCompatibleWithProtocolOne() {
        val raw = ("{\"type\":\"CUS\",\"points\":[[10,20],[11,21],[12,22]]}".repeat(80))
            .encodeToByteArray()
        val compressed = BleSync.compressEvent(raw)

        assertEquals(true, compressed.size < raw.size)
        assertEquals(false, BleSync.shouldUseCompressedEvent(1, raw.size, compressed.size))
        assertEquals(true, BleSync.shouldUseCompressedEvent(2, raw.size, compressed.size))
        assertEquals(true, BleSync.decompressEvent(compressed, raw.size)?.contentEquals(raw))
        assertEquals(null, BleSync.decompressEvent(compressed, 200000))
        assertEquals(null, BleSync.decompressEvent(byteArrayOf(1, 2, 3), raw.size))
    }

    @Test
    fun activeInboundTransfersExpireOnlyAfterTheyStopMakingProgress() {
        assertEquals(false, BleSync.isInboundTransferStale(1_000L, 121_000L))
        assertEquals(true, BleSync.isInboundTransferStale(1_000L, 121_001L))
        assertEquals(false, BleSync.isInboundTransferStale(2_000L, 1_000L))
    }

    @Test
    fun theLocalFeedIsRecoveredBeforeRelayedHistory() {
        assertEquals(0, BleSync.feedPriority("@me", "@me"))
        assertEquals(1, BleSync.feedPriority("@old-peer", "@me"))
    }

    @Test
    fun newPeersCanUseAcknowledgedGattIndications() {
        assertEquals(
            true,
            BleSync.supportsIndications(BluetoothGattCharacteristic.PROPERTY_NOTIFY or
                BluetoothGattCharacteristic.PROPERTY_INDICATE)
        )
        assertEquals(false, BleSync.supportsIndications(BluetoothGattCharacteristic.PROPERTY_NOTIFY))
    }

    @Test
    fun frameRetriesUseBoundedBackoffAndEventuallyReconnect() {
        assertEquals(250L, BleSync.frameRetryDelayMillis(0))
        assertEquals(250L, BleSync.frameRetryDelayMillis(1))
        assertEquals(500L, BleSync.frameRetryDelayMillis(2))
        assertEquals(1000L, BleSync.frameRetryDelayMillis(8))

        assertEquals(false, BleSync.shouldDropLinkAfterFailures(2))
        assertEquals(true, BleSync.shouldDropLinkAfterFailures(3))
    }

    @Test
    fun oneReadyGattDirectionCarriesEachSyncMessage() {
        assertEquals(
            BleSync.ROUTE_CLIENT,
            BleSync.outboundRouteMask(
                hasClient = true,
                clientReady = true,
                hasServer = true,
                serverSubscribed = true
            )
        )
        assertEquals(
            BleSync.ROUTE_SERVER,
            BleSync.outboundRouteMask(
                hasClient = true,
                clientReady = false,
                hasServer = true,
                serverSubscribed = true
            )
        )
        assertEquals(
            BleSync.ROUTE_CLIENT,
            BleSync.outboundRouteMask(
                hasClient = true,
                clientReady = false,
                hasServer = false,
                serverSubscribed = false
            )
        )
        assertEquals(
            BleSync.ROUTE_SERVER,
            BleSync.outboundRouteMask(
                hasClient = false,
                clientReady = false,
                hasServer = true,
                serverSubscribed = false
            )
        )
        assertEquals(
            0,
            BleSync.outboundRouteMask(
                hasClient = false,
                clientReady = false,
                hasServer = false,
                serverSubscribed = false
            )
        )
    }

    @Test
    fun connectedDiscoveryUsesShortInfrequentScanWindows() {
        assertEquals(5000L, BleSync.scanWindowMillis(false))
        assertEquals(7000L, BleSync.scanRestartMillis(false))
        assertEquals(2000L, BleSync.scanWindowMillis(true))
        assertEquals(30000L, BleSync.scanRestartMillis(true))
    }

    @Test
    fun outOfOrderFeedEventsAreBufferedUntilTheirPredecessorArrives() {
        assertEquals(true, BleSync.isNextEvent(null, null, 1, null))
        assertEquals(false, BleSync.isNextEvent(null, null, 2, "%first"))
        assertEquals(true, BleSync.shouldBufferEvent(null, 2))

        assertEquals(true, BleSync.isNextEvent(4, "%four", 5, "%four"))
        assertEquals(false, BleSync.isNextEvent(4, "%four", 5, "%fork"))
        assertEquals(false, BleSync.shouldBufferEvent(4, 5))
        assertEquals(true, BleSync.shouldBufferEvent(4, 6))
        assertEquals(false, BleSync.shouldBufferEvent(4, 4))
        assertEquals(false, BleSync.shouldBufferEvent(4, 3))
    }
}
