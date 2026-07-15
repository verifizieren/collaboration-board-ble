package nz.scuttlebutt.tremola.ssb.peering.ble

import android.util.Base64
import nz.scuttlebutt.tremola.ssb.core.Crypto
import nz.scuttlebutt.tremola.ssb.core.SSBid
import nz.scuttlebutt.tremola.ssb.db.entities.BoardOperation
import nz.scuttlebutt.tremola.utils.HelperFunctions.Companion.deRef
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.zip.Deflater
import java.util.zip.Inflater
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

internal data class BoardRoomConfig(
    val roomId: String,
    val roomKey: ByteArray,
    val roomKeyText: String,
    val ownerId: String,
    val username: String
)

internal data class BoardHello(
    val feedId: String,
    val username: String,
    val replyRequested: Boolean,
    val admissionWire: String?
)

internal data class BoardAdmission(
    val memberId: String,
    val username: String,
    val wireJson: String
)

internal data class DecodedBoardOperation(
    val operation: BoardOperation,
    val payload: JSONObject
)

internal data class BoardSequenceRange(
    val authorId: String,
    val fromSequence: Int,
    val toSequence: Int
)

internal object BoardProtocol {
    private val random = SecureRandom()

    fun parseConfig(json: String): BoardRoomConfig? {
        return try {
            val obj = JSONObject(json)
            val roomId = obj.optString("r", "")
            val keyText = obj.optString("k", "")
            val ownerId = obj.optString("o", "")
            val username = cleanUsername(obj.optString("u", ""))
            val roomKey = decodeUrlBase64(keyText) ?: return null
            if (!isValidRoomId(roomId) || roomKey.size != ROOM_KEY_BYTES ||
                !isValidFeedId(ownerId) || username.isBlank()
            ) return null
            BoardRoomConfig(roomId, roomKey, keyText, ownerId, username)
        } catch (_: Exception) {
            null
        }
    }

    fun configJson(config: BoardRoomConfig): String {
        return JSONObject()
            .put("r", config.roomId)
            .put("k", config.roomKeyText)
            .put("o", config.ownerId)
            .put("u", config.username)
            .toString()
    }

    fun createOperation(
        config: BoardRoomConfig,
        identity: SSBid,
        authorSequence: Int,
        event: JSONObject
    ): DecodedBoardOperation? {
        if (authorSequence <= 0) return null
        val operationId = event.optString("id", "")
        if (!isValidOperationId(operationId)) return null
        event.put("r", config.roomId)
        val payload = event.toString()
        if (payload.encodeToByteArray().size > MAX_EVENT_BYTES) return null

        val authorId = identity.toRef()
        val nonce = ByteArray(GCM_NONCE_BYTES).also { random.nextBytes(it) }
        val nonceText = encodeUrlBase64(nonce)
        val payloadBytes = payload.encodeToByteArray()
        val compressed = compressPayload(payloadBytes)
        val compression = if (compressed.size + COMPRESSION_MIN_SAVING < payloadBytes.size) 1 else 0
        val clearBytes = if (compression == 1) compressed else payloadBytes
        val aad = operationAad(config.roomId, authorId, authorSequence, operationId, compression)
        val cipherText = encrypt(config.roomKey, nonce, aad.encodeToByteArray(), clearBytes)
            ?: return null
        val cipherTextEncoded = encodeUrlBase64(cipherText)
        val canonical = operationCanonical(aad, nonceText, cipherTextEncoded)
        val signature = encodeUrlBase64(identity.sign(canonical.encodeToByteArray()))
        val wire = JSONObject()
            .put("v", VERSION)
            .put("r", config.roomId)
            .put("f", authorId)
            .put("q", authorSequence)
            .put("i", operationId)
            .put("z", compression)
            .put("n", nonceText)
            .put("c", cipherTextEncoded)
            .put("s", signature)
        val eventTime = event.optLong("ts", System.currentTimeMillis())
        val operation = BoardOperation(
            operationId,
            config.roomId,
            authorId,
            authorSequence,
            eventTime,
            wire.toString(),
            System.currentTimeMillis()
        )
        return DecodedBoardOperation(operation, event)
    }

    fun decodeOperation(config: BoardRoomConfig, wireJson: String): DecodedBoardOperation? {
        return try {
            val wire = JSONObject(wireJson)
            if (wire.optInt("v", 0) != VERSION || wire.optString("r") != config.roomId) return null
            val authorId = wire.optString("f", "")
            val sequence = wire.optInt("q", 0)
            val operationId = wire.optString("i", "")
            val compression = wire.optInt("z", 0)
            val nonceText = wire.optString("n", "")
            val cipherTextEncoded = wire.optString("c", "")
            val signature = decodeUrlBase64(wire.optString("s", "")) ?: return null
            if (!isValidFeedId(authorId) || sequence <= 0 || !isValidOperationId(operationId) ||
                compression !in 0..1
            ) return null
            val nonce = decodeUrlBase64(nonceText) ?: return null
            val cipherText = decodeUrlBase64(cipherTextEncoded) ?: return null
            if (nonce.size != GCM_NONCE_BYTES || cipherText.size > MAX_EVENT_BYTES + 32) return null

            val aad = operationAad(config.roomId, authorId, sequence, operationId, compression)
            val canonical = operationCanonical(aad, nonceText, cipherTextEncoded)
            if (!Crypto.verifySignDetached(signature, canonical.encodeToByteArray(), authorId.deRef())) {
                return null
            }
            val encryptedClear = decrypt(config.roomKey, nonce, aad.encodeToByteArray(), cipherText)
                ?: return null
            val clear = if (compression == 1) {
                decompressPayload(encryptedClear) ?: return null
            } else {
                encryptedClear
            }
            if (clear.isEmpty() || clear.size > MAX_EVENT_BYTES) return null
            val event = JSONObject(clear.decodeToString())
            if (event.optString("id") != operationId || event.optString("r") != config.roomId) return null
            val eventTime = event.optLong("ts", 0L)
            DecodedBoardOperation(
                BoardOperation(
                    operationId,
                    config.roomId,
                    authorId,
                    sequence,
                    eventTime,
                    wire.toString(),
                    System.currentTimeMillis()
                ),
                event
            )
        } catch (_: Exception) {
            null
        }
    }

    fun createHello(
        config: BoardRoomConfig,
        identity: SSBid,
        replyRequested: Boolean,
        admissionWire: String?
    ): JSONObject {
        val feedId = identity.toRef()
        val nonce = ByteArray(HELLO_NONCE_BYTES).also { random.nextBytes(it) }
        val nonceText = encodeUrlBase64(nonce)
        val canonical = helloCanonical(
            config.roomId,
            feedId,
            config.ownerId,
            config.username,
            nonceText,
            replyRequested,
            helloAdmissionCanonical(admissionWire)
        )
        val result = JSONObject()
            .put("t", "bh")
            .put("v", VERSION)
            .put("r", config.roomId)
            .put("f", feedId)
            .put("o", config.ownerId)
            .put("u", config.username)
            .put("n", nonceText)
            .put("reply", replyRequested)
            .put("a", encodeUrlBase64(hmac(config.roomKey, canonical.encodeToByteArray())))
            .put("s", encodeUrlBase64(identity.sign(canonical.encodeToByteArray())))
        if (!admissionWire.isNullOrBlank()) result.put("m", JSONObject(admissionWire))
        return result
    }

    fun verifyHello(config: BoardRoomConfig, msg: JSONObject): BoardHello? {
        return try {
            if (msg.optInt("v", 0) != VERSION || msg.optString("r") != config.roomId ||
                msg.optString("o") != config.ownerId
            ) return null
            val feedId = msg.optString("f", "")
            val username = cleanUsername(msg.optString("u", ""))
            val nonce = msg.optString("n", "")
            val reply = msg.optBoolean("reply", false)
            val admissionWire = msg.optJSONObject("m")?.toString()
            if (!isValidFeedId(feedId) || username.isBlank() ||
                decodeUrlBase64(nonce)?.size != HELLO_NONCE_BYTES
            ) return null
            val canonical = helloCanonical(
                config.roomId,
                feedId,
                config.ownerId,
                username,
                nonce,
                reply,
                helloAdmissionCanonical(admissionWire)
            )
            val receivedMac = decodeUrlBase64(msg.optString("a", "")) ?: return null
            val expectedMac = hmac(config.roomKey, canonical.encodeToByteArray())
            if (!MessageDigest.isEqual(receivedMac, expectedMac)) return null
            val signature = decodeUrlBase64(msg.optString("s", "")) ?: return null
            if (!Crypto.verifySignDetached(signature, canonical.encodeToByteArray(), feedId.deRef())) {
                return null
            }
            BoardHello(feedId, username, reply, admissionWire)
        } catch (_: Exception) {
            null
        }
    }

    fun createAdmission(
        config: BoardRoomConfig,
        identity: SSBid,
        memberId: String,
        username: String
    ): BoardAdmission? {
        if (identity.toRef() != config.ownerId || !isValidFeedId(memberId)) return null
        val cleanName = cleanUsername(username)
        if (cleanName.isBlank()) return null
        val canonical = admissionCanonical(config.roomId, config.ownerId, memberId, cleanName)
        val wire = JSONObject()
            .put("v", VERSION)
            .put("r", config.roomId)
            .put("o", config.ownerId)
            .put("m", memberId)
            .put("u", cleanName)
            .put("s", encodeUrlBase64(identity.sign(canonical.encodeToByteArray())))
        return BoardAdmission(memberId, cleanName, wire.toString())
    }

    fun verifyAdmission(config: BoardRoomConfig, wireJson: String?): BoardAdmission? {
        if (wireJson.isNullOrBlank() || wireJson.length > MAX_ADMISSION_LENGTH) return null
        return try {
            val wire = JSONObject(wireJson)
            if (wire.optInt("v", 0) != VERSION || wire.optString("r") != config.roomId ||
                wire.optString("o") != config.ownerId
            ) return null
            val memberId = wire.optString("m", "")
            val username = cleanUsername(wire.optString("u", ""))
            if (!isValidFeedId(memberId) || username.isBlank()) return null
            val signature = decodeUrlBase64(wire.optString("s", "")) ?: return null
            val canonical = admissionCanonical(config.roomId, config.ownerId, memberId, username)
            if (!Crypto.verifySignDetached(signature, canonical.encodeToByteArray(), config.ownerId.deRef())) {
                return null
            }
            BoardAdmission(memberId, username, wire.toString())
        } catch (_: Exception) {
            null
        }
    }

    fun contiguousFrontier(operations: List<BoardOperation>): Map<String, Int> {
        val result = linkedMapOf<String, Int>()
        operations.sortedWith(compareBy<BoardOperation> { it.authorId }.thenBy { it.authorSequence })
            .forEach { operation ->
                val current = result[operation.authorId] ?: 0
                if (operation.authorSequence == current + 1) result[operation.authorId] = current + 1
                else if (!result.containsKey(operation.authorId)) result[operation.authorId] = 0
            }
        return result
    }

    fun missingRanges(
        localFrontier: Map<String, Int>,
        remoteFrontier: Map<String, Int>,
        maxPerRange: Int
    ): List<BoardSequenceRange> {
        if (maxPerRange <= 0) return emptyList()
        return remoteFrontier.toSortedMap().mapNotNull { (author, remoteSequence) ->
            val localSequence = localFrontier[author] ?: 0
            if (remoteSequence <= localSequence) null else BoardSequenceRange(
                author,
                localSequence + 1,
                minOf(remoteSequence, localSequence + maxPerRange)
            )
        }
    }

    fun cleanUsername(value: String): String {
        return value.trim().replace(Regex("\\s+"), " ").take(MAX_USERNAME_LENGTH)
    }

    private fun isValidRoomId(value: String): Boolean {
        return value.length in 8..64 && value.all {
            it.isLetterOrDigit() || it == '-' || it == '_'
        }
    }

    private fun isValidFeedId(value: String): Boolean {
        if (!value.startsWith("@") || !value.endsWith(".ed25519")) return false
        return try {
            value.deRef().size == 32
        } catch (_: Exception) {
            false
        }
    }

    private fun isValidOperationId(value: String): Boolean {
        return value.isNotBlank() && value.length <= 96
    }

    private fun operationAad(
        roomId: String,
        feedId: String,
        sequence: Int,
        operationId: String,
        compression: Int
    ): String {
        return "bo\n$VERSION\n$roomId\n$feedId\n$sequence\n$operationId\n$compression"
    }

    private fun operationCanonical(aad: String, nonce: String, cipherText: String): String {
        return "$aad\n$nonce\n$cipherText"
    }

    private fun helloCanonical(
        roomId: String,
        feedId: String,
        ownerId: String,
        username: String,
        nonce: String,
        reply: Boolean,
        admissionWire: String
    ): String {
        return "bh\n$VERSION\n$roomId\n$feedId\n$ownerId\n$username\n$nonce\n" +
            "${if (reply) 1 else 0}\n$admissionWire"
    }

    private fun helloAdmissionCanonical(wireJson: String?): String {
        if (wireJson.isNullOrBlank()) return ""
        return try {
            val wire = JSONObject(wireJson)
            listOf("v", "r", "o", "m", "u", "s").joinToString("\n") { key ->
                wire.optString(key, "")
            }
        } catch (_: Exception) {
            "invalid"
        }
    }

    private fun admissionCanonical(
        roomId: String,
        ownerId: String,
        memberId: String,
        username: String
    ): String {
        return "bm\n$VERSION\n$roomId\n$ownerId\n$memberId\n$username"
    }

    internal fun compressPayload(clear: ByteArray): ByteArray {
        if (clear.isEmpty()) return clear
        val deflater = Deflater(Deflater.BEST_SPEED)
        return try {
            deflater.setInput(clear)
            deflater.finish()
            val output = ByteArrayOutputStream(clear.size)
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

    internal fun decompressPayload(compressed: ByteArray): ByteArray? {
        if (compressed.isEmpty() || compressed.size > MAX_EVENT_BYTES) return null
        val inflater = Inflater()
        return try {
            inflater.setInput(compressed)
            val output = ByteArrayOutputStream(minOf(compressed.size * 4, 8192))
            val buffer = ByteArray(1024)
            while (!inflater.finished()) {
                val count = inflater.inflate(buffer)
                if (count <= 0 || output.size() + count > MAX_EVENT_BYTES) return null
                output.write(buffer, 0, count)
            }
            output.toByteArray()
        } catch (_: Exception) {
            null
        } finally {
            inflater.end()
        }
    }

    private fun encrypt(key: ByteArray, nonce: ByteArray, aad: ByteArray, clear: ByteArray): ByteArray? {
        return try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
            cipher.updateAAD(aad)
            cipher.doFinal(clear)
        } catch (_: Exception) {
            null
        }
    }

    private fun decrypt(key: ByteArray, nonce: ByteArray, aad: ByteArray, encrypted: ByteArray): ByteArray? {
        return try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
            cipher.updateAAD(aad)
            cipher.doFinal(encrypted)
        } catch (_: Exception) {
            null
        }
    }

    private fun hmac(key: ByteArray, input: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        return mac.doFinal(input)
    }

    private fun encodeUrlBase64(value: ByteArray): String {
        return Base64.encodeToString(value, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
    }

    private fun decodeUrlBase64(value: String): ByteArray? {
        if (value.isBlank() || value.length > MAX_BASE64_LENGTH) return null
        return try {
            Base64.decode(value, Base64.URL_SAFE or Base64.NO_WRAP)
        } catch (_: Exception) {
            null
        }
    }

    private const val VERSION = 2
    private const val ROOM_KEY_BYTES = 32
    private const val GCM_NONCE_BYTES = 12
    private const val HELLO_NONCE_BYTES = 16
    private const val MAX_USERNAME_LENGTH = 24
    // This also guarantees that an encrypted operation still fits inside the
    // 1,024-frame fallback when an older phone remains at the 23-byte MTU.
    private const val MAX_EVENT_BYTES = 8192
    private const val MAX_BASE64_LENGTH = 65536
    private const val MAX_ADMISSION_LENGTH = 512
    private const val COMPRESSION_MIN_SAVING = 16
}
