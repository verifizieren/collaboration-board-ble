package nz.scuttlebutt.tremola.ssb.peering.ble

import android.util.Base64
import androidx.test.ext.junit.runners.AndroidJUnit4
import nz.scuttlebutt.tremola.ssb.core.SSBid
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class BoardProtocolInstrumentedTest {
    @Test
    fun admissionAndEncryptedOperationRoundTripOnAndroid() {
        val owner = SSBid()
        val member = SSBid()
        val key = ByteArray(32) { index -> (index * 7 + 3).toByte() }
        val keyText = Base64.encodeToString(
            key,
            Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING
        )
        val ownerConfig = BoardRoomConfig(
            roomId = "android-test-room",
            roomKey = key,
            roomKeyText = keyText,
            ownerId = owner.toRef(),
            username = "Alice"
        )
        val memberConfig = ownerConfig.copy(username = "Bob")

        val admission = BoardProtocol.createAdmission(
            ownerConfig,
            owner,
            member.toRef(),
            "Bob"
        )!!
        assertEquals(
            member.toRef(),
            BoardProtocol.verifyAdmission(ownerConfig, admission.wireJson)?.memberId
        )
        assertNull(
            BoardProtocol.createAdmission(memberConfig, member, member.toRef(), "Mallory")
        )

        val hello = BoardProtocol.createHello(
            memberConfig,
            member,
            replyRequested = true,
            admissionWire = admission.wireJson
        )
        val verifiedHello = BoardProtocol.verifyHello(ownerConfig, hello)!!
        assertEquals(member.toRef(), verifiedHello.feedId)
        assertEquals("Bob", verifiedHello.username)
        assertEquals(admission.wireJson, verifiedHello.admissionWire)

        val points = JSONArray()
        repeat(160) { index ->
            points.put(JSONArray().put(100 + index * 2).put(200 + index % 17))
        }
        val event = JSONObject()
            .put("k", "s")
            .put("id", "android-stroke-1")
            .put("ts", 1234L)
            .put("l", 7)
            .put("u", "Bob")
            .put("c", "#2563eb")
            .put("w", 2)
            .put("p", points)
        val encoded = BoardProtocol.createOperation(memberConfig, member, 1, event)!!
        assertEquals(1, JSONObject(encoded.operation.wireJson).getInt("z"))
        assertFalse(encoded.operation.wireJson.contains("#2563eb"))
        assertFalse(encoded.operation.wireJson.contains("\"p\""))

        val decoded = BoardProtocol.decodeOperation(ownerConfig, encoded.operation.wireJson)!!
        assertEquals(member.toRef(), decoded.operation.authorId)
        assertEquals(1, decoded.operation.authorSequence)
        assertEquals("android-stroke-1", decoded.payload.getString("id"))
        assertEquals(160, decoded.payload.getJSONArray("p").length())

        val tampered = JSONObject(encoded.operation.wireJson)
        val cipherText = tampered.getString("c")
        tampered.put("c", cipherText.dropLast(1) + if (cipherText.last() == 'A') "B" else "A")
        assertNull(BoardProtocol.decodeOperation(ownerConfig, tampered.toString()))

        val wrongKey = ownerConfig.copy(roomKey = ByteArray(32) { 42 })
        assertNull(BoardProtocol.decodeOperation(wrongKey, encoded.operation.wireJson))
    }

    @Test
    fun operationTooLargeForTheFallbackTransportIsRejected() {
        val owner = SSBid()
        val key = ByteArray(32) { 9 }
        val config = BoardRoomConfig(
            roomId = "android-size-room",
            roomKey = key,
            roomKeyText = Base64.encodeToString(
                key,
                Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING
            ),
            ownerId = owner.toRef(),
            username = "Alice"
        )
        val event = JSONObject()
            .put("k", "t")
            .put("id", "oversized")
            .put("s", "x".repeat(9000))

        assertNull(BoardProtocol.createOperation(config, owner, 1, event))
        assertTrue(BoardProtocol.cleanUsername("  Alice   Smith  ") == "Alice Smith")
    }
}
