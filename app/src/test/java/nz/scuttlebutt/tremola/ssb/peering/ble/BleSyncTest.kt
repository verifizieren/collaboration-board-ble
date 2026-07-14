package nz.scuttlebutt.tremola.ssb.peering.ble

import org.junit.Assert.assertEquals
import org.junit.Test

class BleSyncTest {
    @Test
    fun framePayloadFitsInsideGattValue() {
        // Default BLE MTU: 23 - 3 ATT bytes - 8 frame header bytes.
        assertEquals(12, BleSync.framePayloadSize(23))

        // The preferred MTU is capped at the conservative payload limit.
        assertEquals(180, BleSync.framePayloadSize(247))

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
}
