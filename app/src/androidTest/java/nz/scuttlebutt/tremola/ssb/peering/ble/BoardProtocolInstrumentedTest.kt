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
            username = "Alice",
            boardName = "DPI Project"
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

        val reject = BoardProtocol.createReject(ownerConfig, owner, "full")!!
        assertEquals("full", BoardProtocol.verifyReject(memberConfig, reject))
        assertNull(BoardProtocol.createReject(memberConfig, member, "full"))
        assertNull(
            BoardProtocol.verifyReject(
                memberConfig,
                JSONObject(reject.toString()).put("reason", "owner_required")
            )
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

    @Test
    fun sixDigitPairingTransfersTheBoardKeyAndAdmission() {
        val owner = SSBid()
        val member = SSBid()
        val roomKey = ByteArray(32) { index -> (index * 11 + 5).toByte() }
        val ownerConfig = BoardRoomConfig(
            roomId = "pairing-test-room",
            roomKey = roomKey,
            roomKeyText = Base64.encodeToString(
                roomKey,
                Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING
            ),
            ownerId = owner.toRef(),
            username = "Alice",
            boardName = "DPI Project",
            codeVerifier = BoardProtocol.pairingCodeVerifier("pairing-test-room", "123456")
        )
        assertTrue(BoardProtocol.matchesPairingCode(ownerConfig, "123456"))
        assertFalse(BoardProtocol.matchesPairingCode(ownerConfig, "654321"))
        val persistedConfig = BoardProtocol.configJson(ownerConfig)
        assertFalse(JSONObject(persistedConfig).has("p"))
        assertTrue(JSONObject(persistedConfig).has("h"))
        val plainConfig = JSONObject(persistedConfig).apply {
            remove("h")
            put("p", "123456")
        }
        val parsedFromPlainCode = BoardProtocol.parseConfig(plainConfig.toString())!!
        assertTrue(BoardProtocol.matchesPairingCode(parsedFromPlainCode, "123456"))

        val joinNonce = BoardProtocol.newPairingNonce()
        val probeWire = BoardProtocol.createPairingProbe(member, "Bob", joinNonce)!!
        val probe = BoardProtocol.verifyPairingProbe(probeWire)!!
        val challengeWire = BoardProtocol.createPairingChallenge(owner, probe, 600)!!
        val challenge = BoardProtocol.verifyPairingChallenge(
            challengeWire.message,
            member.toRef(),
            joinNonce
        )!!
        val requestWire = BoardProtocol.createPairingRequest(
            member,
            "Bob",
            "123456",
            challenge
        )!!
        val request = BoardProtocol.verifyPairingRequest(
            requestWire,
            "123456",
            challenge
        )!!
        assertNull(BoardProtocol.verifyPairingRequest(requestWire, "654321", challenge))

        val offer = BoardProtocol.createPairingOffer(
            ownerConfig,
            owner,
            "123456",
            challenge,
            request
        )!!
        val result = BoardProtocol.verifyPairingOffer(
            offer,
            "123456",
            challenge,
            "Bob"
        )!!
        assertTrue(result.config.roomKey.contentEquals(roomKey))
        assertEquals(owner.toRef(), result.config.ownerId)
        assertEquals("DPI Project", result.config.boardName)
        assertTrue(BoardProtocol.matchesPairingCode(result.config, "123456"))
        assertNull(BoardProtocol.verifyPairingOffer(offer, "654321", challenge, "Bob"))

        val tampered = JSONObject(offer.toString()).put("f", owner.toRef())
        assertNull(BoardProtocol.verifyPairingOffer(tampered, "123456", challenge, "Bob"))
    }

    @Test
    fun sixDigitDirectBoardsOpenWithoutAnOwnerHandshake() {
        val alice = SSBid()
        val bob = SSBid()
        val aliceConfig = BoardProtocol.directConfig(
            "482913",
            alice.toRef(),
            "Alice",
            "DPI Project"
        )!!
        val bobConfig = BoardProtocol.directConfig(
            "482913",
            bob.toRef(),
            "Bob",
            ""
        )!!
        val otherBoard = BoardProtocol.directConfig(
            "482914",
            bob.toRef(),
            "Bob",
            ""
        )!!

        assertTrue(aliceConfig.directAccess)
        assertEquals("code-482913-v1", aliceConfig.roomId)
        assertEquals(aliceConfig.roomId, bobConfig.roomId)
        assertTrue(aliceConfig.roomKey.contentEquals(bobConfig.roomKey))
        assertFalse(aliceConfig.roomKey.contentEquals(otherBoard.roomKey))
        assertEquals(alice.toRef(), aliceConfig.ownerId)
        assertEquals(bob.toRef(), bobConfig.ownerId)
        assertEquals("Board 482913", bobConfig.boardName)
        assertTrue(JSONObject(BoardProtocol.configJson(aliceConfig)).getInt("d") == 1)
        assertTrue(BoardProtocol.matchesPairingCode(aliceConfig, "482913"))

        val hello = BoardProtocol.createHello(
            bobConfig,
            bob,
            replyRequested = true,
            admissionWire = null
        )
        val verified = BoardProtocol.verifyHello(aliceConfig, hello)!!
        assertEquals(bob.toRef(), verified.feedId)
        assertEquals("Bob", verified.username)
        assertNull(BoardProtocol.verifyHello(otherBoard, hello))

        val event = JSONObject()
            .put("k", "t")
            .put("id", "direct-text-1")
            .put("ts", 42L)
            .put("s", "SGVsbG8=")
        val operation = BoardProtocol.createOperation(bobConfig, bob, 1, event)!!
        assertEquals(
            "direct-text-1",
            BoardProtocol.decodeOperation(aliceConfig, operation.operation.wireJson)!!.payload
                .getString("id")
        )
    }
}
