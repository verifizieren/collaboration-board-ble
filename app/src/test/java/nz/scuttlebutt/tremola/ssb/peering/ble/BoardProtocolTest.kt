package nz.scuttlebutt.tremola.ssb.peering.ble

import nz.scuttlebutt.tremola.ssb.db.entities.BoardOperation
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BoardProtocolTest {
    @Test
    fun frontierStopsAtTheFirstMissingOperationPerAuthor() {
        val operations = listOf(
            operation("alice", 4),
            operation("bob", 2),
            operation("alice", 1),
            operation("bob", 1),
            operation("alice", 3),
            operation("carol", 2)
        )

        assertEquals(
            mapOf("alice" to 1, "bob" to 2, "carol" to 0),
            BoardProtocol.contiguousFrontier(operations)
        )
        assertEquals(
            mapOf("alice" to 4, "bob" to 2, "carol" to 0),
            BoardProtocol.contiguousFrontier(operations + operation("alice", 2))
        )
    }

    @Test
    fun missingRangesAreBoundedAndContinueFromTheLocalFrontier() {
        val ranges = BoardProtocol.missingRanges(
            localFrontier = mapOf("alice" to 1, "bob" to 4),
            remoteFrontier = mapOf("alice" to 100, "bob" to 4, "carol" to 3),
            maxPerRange = 64
        )

        assertEquals(
            listOf(
                BoardSequenceRange("alice", 2, 65),
                BoardSequenceRange("carol", 1, 3)
            ),
            ranges
        )
    }

    @Test
    fun longStrokePayloadCompressesAndRoundTrips() {
        val points = (0 until 160).joinToString(",") { index ->
            "[${100 + index * 2},${200 + (index % 17) * 3}]"
        }
        val clear =
            "{\"k\":\"s\",\"id\":\"stroke-1\",\"r\":\"room-1\",\"p\":[$points]}"
                .encodeToByteArray()
        val compressed = BoardProtocol.compressPayload(clear)

        assertTrue(compressed.size < clear.size / 2)
        assertArrayEquals(clear, BoardProtocol.decompressPayload(compressed))
    }

    @Test
    fun malformedOrOversizedCompressedPayloadIsRejected() {
        assertNull(BoardProtocol.decompressPayload(byteArrayOf(1, 2, 3, 4)))

        val oversized = ByteArray(40_000) { 'a'.code.toByte() }
        assertNull(BoardProtocol.decompressPayload(BoardProtocol.compressPayload(oversized)))
    }

    @Test
    fun pairingCodesAreExactlySixAsciiDigits() {
        assertTrue(BoardProtocol.isValidPairingCode("123456"))
        assertTrue(BoardProtocol.isValidPairingCode("000000"))
        assertEquals(false, BoardProtocol.isValidPairingCode("12345"))
        assertEquals(false, BoardProtocol.isValidPairingCode("1234567"))
        assertEquals(false, BoardProtocol.isValidPairingCode("12 456"))
        assertEquals(false, BoardProtocol.isValidPairingCode("abcdef"))
    }

    private fun operation(author: String, sequence: Int): BoardOperation {
        return BoardOperation(
            operationId = "$author-$sequence",
            roomId = "room",
            authorId = author,
            authorSequence = sequence,
            eventTime = sequence.toLong(),
            wireJson = "{}",
            receivedAt = sequence.toLong()
        )
    }
}
