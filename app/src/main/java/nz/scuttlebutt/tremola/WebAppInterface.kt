package nz.scuttlebutt.tremola

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.RectF
import android.graphics.pdf.PdfDocument
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.widget.Toast
import com.google.zxing.integration.android.IntentIntegrator
import nz.scuttlebutt.tremola.ssb.TremolaState
import nz.scuttlebutt.tremola.ssb.db.entities.LogEntry
import nz.scuttlebutt.tremola.ssb.db.entities.Pub
import nz.scuttlebutt.tremola.ssb.peering.RpcInitiator
import nz.scuttlebutt.tremola.ssb.peering.RpcServices
import nz.scuttlebutt.tremola.utils.HelperFunctions.Companion.id2
import nz.scuttlebutt.tremola.utils.getBroadcastAddress
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executors


// pt 3 in https://betterprogramming.pub/5-android-webview-secrets-you-probably-didnt-know-b23f8a8b5a0c

class WebAppInterface(private val act: Activity, val tremolaState: TremolaState, private val webView: WebView) {

    /**
     * Receives commands from the GUI.
     * Note that there is no counterpart to this method in webView, {@see WebAppInterface::eval}
     */
    @JavascriptInterface
    fun onFrontendRequest(s: String) {
        //handle the data captured from webview}
        Log.d(
            "FrontendRequest",
            if (s.startsWith("collabboard:")) s.substringBefore(" ") else s
        )
        if (handleBleRequest(s)) return
        if (handleCollaborationBoardRequest(s)) return
        if (handleCustomAppRequest(s)) return
        val args = s.split(" ")
        when (args[0]) {
            "onBackPressed" -> { // When 'back' is pressed, will close app
                (act as MainActivity)._onBackPressed()
            }
            "ready" -> { // Initialisation, send localID to frontend
                eval("b2f_initialize(\"${tremolaState.idStore.identity.toRef()}\")")
            }
            "reset" -> { // UI reset
                // erase DB content
                eval("b2f_initialize(\"${tremolaState.idStore.identity.toRef()}\")")
            }
            "restream" -> { // Resend all the log of private messages
                for (logEntry in tremolaState.logDAO.getAllAsList())
                    if (logEntry.pri != null) // only private chat msgs
                        sendEventToFrontend(logEntry)
            }
            "qrscan.init" -> { // start scanning the qr code (open the camera)
                val intentIntegrator = IntentIntegrator(act)
                intentIntegrator.setBeepEnabled(false)
                intentIntegrator.setCameraId(0)
                intentIntegrator.setPrompt("SCAN")
                intentIntegrator.setBarcodeImageEnabled(false)
                intentIntegrator.initiateScan()
                return
            }
            "secret:" -> { // import a new ID (is not used)
                if (importIdentity(args[1])) {
                    tremolaState.logDAO.wipe()
                    tremolaState.contactDAO.wipe()
                    tremolaState.pubDAO.wipe()
                    act.finishAffinity()
                }
                return
            }
            "exportSecret" -> { // Show the secret key (both as string and qr code)
                val json = tremolaState.idStore.identity.toExportString()!!
                eval("b2f_showSecret('${json}');")
                val clipboard = tremolaState.context.getSystemService(ClipboardManager::class.java)
                val clip = ClipData.newPlainText("simple text", json)
                clipboard.setPrimaryClip(clip)
                Toast.makeText(
                    act, "secret key was also\ncopied to clipboard",
                    Toast.LENGTH_LONG
                ).show()
            }
            "sync" -> { // add a peer to a pub (never used)
                addPub(args[1])
                return
            }
            "wipe" -> { // Delete all data about the peer, included ID (not revertible)
                tremolaState.logDAO.wipe()
                tremolaState.contactDAO.wipe()
                tremolaState.pubDAO.wipe()
                tremolaState.idStore.setNewIdentity(null) // creates new identity
                // eval("b2f_initialize(\"${tremolaState.idStore.identity.toRef()}\")")
                // FIXME: should kill all active connections, or better then the app
                act.finishAffinity()
            }
            "add:contact" -> { // Add a new contact
                // Only store in database and advertise it to connected peers via SSB event.
                // The peering with the new contact is automatically done by /ssb/peering/PeeringPool::add,
                // Which is called in /ssb/TremolaState::init by a fixed rate scheduled procedure.
                // ID and alias
                tremolaState.addContact(
                    args[1],
                    Base64.decode(args[2], Base64.NO_WRAP).decodeToString()
                )
                val evnt = tremolaState.appendLocalEvent {
                    tremolaState.msgTypes.mkFollow(args[1])
                }
                evnt?.let {
                    tremolaState.peers.newContact(args[1]) // inform online peers via EBT
                }
                return
            }
            "priv:post" -> { // Post a private chat
                // atob(text) recipient1 recipient2 ...
                tremolaState.appendLocalEvent {
                    tremolaState.msgTypes.mkPost(
                        Base64.decode(args[1], Base64.NO_WRAP).decodeToString(),
                        args.slice(2..args.lastIndex)
                    )
                }
                return
            }
            "priv:hash" -> { // Compute the shortname from the public key
                // The second arg is the name of the method to call with the result of the hash
                val shortname = id2(args[1])
                Log.e("SHORT", shortname + ": " + args[1] + " and " + args[2])
                eval("${args[2]}('" + shortname + "', '" + args[1] + "')")
            }
            "invite:redeem" -> { // Join a pub with invite code
                try {
                    val invitation = args[1].split("~") //[pub_mark, invite_code]
                    val id = invitation[0].split(":") // [IP_address, port, pub_SSB_ID]
                    val remoteKey = Base64.decode(id[2].slice(1..-8), Base64.NO_WRAP)
                    val seed = Base64.decode(invitation[1], Base64.NO_WRAP) // invite_code
                    val rpcStream = RpcInitiator(tremolaState, remoteKey)
                    val ex = Executors.newSingleThreadExecutor() // one thread per peer
                    ex?.execute {
                        rpcStream.defineServices(RpcServices(tremolaState))
                        rpcStream.startPeering(id[0], id[1].toInt(), seed)
                    }
                    Toast.makeText(
                        act, "Pub is being contacted ..",
                        Toast.LENGTH_SHORT
                    ).show()
                } catch (e: Exception) {
                    Toast.makeText(
                        act, "Problem parsing invite code",
                        Toast.LENGTH_LONG
                    ).show()
                }
            }
            "look_up" -> { // Start a lookup
                val shortname = args[1]
                try {
                    getBroadcastAddress(act).hostAddress
                    val lookup = (act as MainActivity).lookup
                    val send = lookup!!.prepareQuery(shortname)
                    if (send != null)
                        lookup.sendQuery(send)
                    else
                        Log.d("LOOKUP", "$shortname is already in contacts")
                } catch (e: IOException) {
                    Log.e("BROADCAST", "Failed to obtain broadcast address")
                } catch (e: Exception) {
                    Log.e("BROADCAST", e.stackTraceToString())
                }
            }
            else -> {
                Log.d("onFrontendRequest", "unknown")
            }
        }
        /*
        if (s == "btn:chats") {
            select(listOf("chats","contacts","profile"))
        }
        if (s == "btn:contacts") {
            select(listOf("contacts","chats","profile"))
        }
        if (s == "btn:profile") {
            select(listOf("profile","contacts","chats"))
        }
        */
    }

    private fun handleBleRequest(s: String): Boolean {
        if (!s.startsWith("ble:")) return false
        act.runOnUiThread {
            when (s) {
                "ble:start" -> (act as? MainActivity)?.startBleSyncIfPermitted()
                "ble:stop" -> tremolaState.bleSync?.stop()
                "ble:kick" -> {
                    (act as? MainActivity)?.startBleSyncIfPermitted()
                    tremolaState.bleSync?.kick()
                }
                else -> Log.d("BLE request", "unknown $s")
            }
        }
        return true
    }

    private fun handleCustomAppRequest(s: String): Boolean {
        if (s.startsWith("customApp:writeEntry ")) {
            val args = s.split(" ", limit = 3)
            if (args.size < 3) return true
            try {
                tremolaState.appendLocalEvent {
                    tremolaState.msgTypes.mkCustomApp(args[1], args[2])
                }
            } catch (e: Exception) {
                Log.e("customApp:writeEntry", e.stackTraceToString())
            }
            return true
        }

        if (s.startsWith("customApp:readEntries ")) {
            val args = s.split(" ", limit = 3)
            if (args.size < 2) return true
            val appId = args[1]
            val limit = args.getOrNull(2)?.toIntOrNull() ?: Int.MAX_VALUE
            val entries = tremolaState.logDAO.getAllAsList()
                .filter { isCustomAppEntry(it.pub, appId) }
                .sortedWith(compareBy<LogEntry> { it.tst }.thenBy { it.lid }.thenBy { it.lsq })
            val selected = if (limit > 0 && entries.size > limit) entries.takeLast(limit) else entries
            selected.forEach { sendEventToFrontend(it) }
            return true
        }

        return false
    }

    private fun handleCollaborationBoardRequest(s: String): Boolean {
        if (!s.startsWith("collabboard:")) return false
        when {
            s.startsWith("collabboard:configure ") -> {
                val encoded = s.substringAfter("collabboard:configure ")
                val config = decodeFrontendBase64(encoded)
                (act as? MainActivity)?.startBleSyncIfPermitted()
                val accepted = config != null && tremolaState.bleSync?.configureBoard(config) == true
                eval("if (typeof cb_board_configured === 'function') cb_board_configured($accepted);")
            }
            s.startsWith("collabboard:open-code ") -> {
                val encoded = s.substringAfter("collabboard:open-code ")
                val request = decodeFrontendBase64(encoded)
                (act as? MainActivity)?.startBleSyncIfPermitted()
                val config = request?.let { tremolaState.bleSync?.openBoardByCode(it) }
                val quoted = JSONObject.quote(config ?: "")
                eval(
                    "if (typeof cb_board_code_opened === 'function') " +
                        "cb_board_code_opened($quoted);"
                )
            }
            s.startsWith("collabboard:pairing ") -> {
                val encoded = s.substringAfter("collabboard:pairing ")
                val code = decodeFrontendBase64(encoded)
                (act as? MainActivity)?.startBleSyncIfPermitted()
                val accepted = code != null && tremolaState.bleSync?.startBoardPairing(code) == true
                eval(
                    "if (typeof cb_pairing_started === 'function') " +
                        "cb_pairing_started($accepted, 600);"
                )
            }
            s.startsWith("collabboard:join ") -> {
                val encoded = s.substringAfter("collabboard:join ")
                val request = decodeFrontendBase64(encoded)
                (act as? MainActivity)?.startBleSyncIfPermitted()
                val accepted = request != null && tremolaState.bleSync?.beginBoardJoin(request) == true
                eval(
                    "if (typeof cb_board_join_started === 'function') " +
                        "cb_board_join_started($accepted);"
                )
            }
            s.startsWith("collabboard:write ") -> {
                val encoded = s.substringAfter("collabboard:write ")
                val payload = decodeFrontendBase64(encoded)
                val accepted = payload != null && tremolaState.bleSync?.writeBoardEvent(payload) == true
                if (!accepted) {
                    eval("if (typeof cb_board_write_failed === 'function') cb_board_write_failed();")
                }
            }
            s.startsWith("collabboard:delete ") -> {
                val encoded = s.substringAfter("collabboard:delete ")
                val request = decodeFrontendBase64(encoded)
                val accepted = request != null && tremolaState.bleSync?.deleteBoard(request) == true
                eval(
                    "if (typeof cb_board_delete_started === 'function') " +
                        "cb_board_delete_started($accepted);"
                )
            }
            s == "collabboard:read" -> tremolaState.bleSync?.replayBoardOperations()
            s == "collabboard:close" -> tremolaState.bleSync?.closeBoard()
            s == "collabboard:leave" -> tremolaState.bleSync?.leaveBoard()
            else -> Log.d("CollaborationBoard", "unknown $s")
        }
        return true
    }

    @JavascriptInterface
    fun writeCollaborationBoardEvent(encoded: String): Boolean {
        val payload = decodeFrontendBase64(encoded) ?: return false
        return tremolaState.bleSync?.writeBoardEvent(payload) == true
    }

    @JavascriptInterface
    fun copyCollaborationBoardInvite(encoded: String): Boolean {
        val invite = decodeFrontendBase64(encoded) ?: return false
        if (invite.isBlank() || invite.length > 2048) return false
        act.runOnUiThread {
            val clipboard = act.getSystemService(ClipboardManager::class.java)
            clipboard?.setPrimaryClip(ClipData.newPlainText("Collaboration Board invite", invite))
            Toast.makeText(act, "Invite copied", Toast.LENGTH_SHORT).show()
        }
        return true
    }

    @JavascriptInterface
    fun exportWhiteboard(format: String, encodedImage: String) {
        try {
            if (encodedImage.length > 16_000_000) throw IllegalArgumentException("Image is too large")
            val image = Base64.decode(encodedImage, Base64.NO_WRAP)
            val normalized = if (format.lowercase(Locale.US) == "pdf") "pdf" else "jpeg"
            val content = if (normalized == "pdf") whiteboardPdf(image) else image
            val stamp = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date())
            val extension = if (normalized == "pdf") "pdf" else "jpg"
            val mime = if (normalized == "pdf") "application/pdf" else "image/jpeg"
            val activity = act as? MainActivity
                ?: throw IllegalStateException("Whiteboard export needs MainActivity")
            activity.beginWhiteboardExport("whiteboard-$stamp.$extension", mime, content)
        } catch (error: Exception) {
            Log.e("WhiteboardExport", "Could not prepare whiteboard export", error)
            act.runOnUiThread {
                Toast.makeText(act, "Could not export whiteboard.", Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun whiteboardPdf(image: ByteArray): ByteArray {
        val bitmap = BitmapFactory.decodeByteArray(image, 0, image.size)
            ?: throw IllegalArgumentException("Invalid whiteboard image")
        val document = PdfDocument()
        try {
            val pageWidth = 900
            val pageHeight = 1200
            val margin = 24f
            val page = document.startPage(
                PdfDocument.PageInfo.Builder(pageWidth, pageHeight, 1).create()
            )
            page.canvas.drawColor(Color.WHITE)
            val availableWidth = pageWidth - 2f * margin
            val availableHeight = pageHeight - 2f * margin
            val scale = minOf(availableWidth / bitmap.width, availableHeight / bitmap.height)
            val width = bitmap.width * scale
            val height = bitmap.height * scale
            val left = (pageWidth - width) / 2f
            val top = (pageHeight - height) / 2f
            page.canvas.drawBitmap(bitmap, null, RectF(left, top, left + width, top + height), null)
            document.finishPage(page)
            return ByteArrayOutputStream().use { output ->
                document.writeTo(output)
                output.toByteArray()
            }
        } finally {
            document.close()
            bitmap.recycle()
        }
    }

    private fun decodeFrontendBase64(value: String): String? {
        return try {
            Base64.decode(value, Base64.NO_WRAP).decodeToString()
        } catch (_: Exception) {
            null
        }
    }

    private fun isCustomAppEntry(publicContent: String?, appId: String): Boolean {
        if (publicContent == null) return false
        try {
            val arr = JSONArray(publicContent)
            return arr.optString(0) == "CUS" && arr.optString(1) == appId
        } catch (_: Exception) {
        }
        try {
            val obj = JSONObject(publicContent)
            return obj.optString("type") == "CUS" && obj.optString("app") == appId
        } catch (_: Exception) {
        }
        return false
    }

    /**
     * Indirectly but automatically calls any method in the frontend.
     * Note that the args must be inside single quotes (') :
     * eval("b2f_local_peer('" + arg + "', 'someText')")
     * OR
     * eval("b2f_local_peer('${arg}', 'someText')")
     */
    fun eval(js: String) { // send JS string to webkit frontend for execution
        webView.post(Runnable {
            webView.evaluateJavascript(js, null)
        })
    }

    /**
     * Only called (but commented out) from tremola.js::menu_import_id,
     * which is never called (Menu item leading to it is commented out)
     */
    private fun importIdentity(secret: String): Boolean {
        Log.d("D/importIdentity", secret)
        if (tremolaState.idStore.setNewIdentity(Base64.decode(secret, Base64.DEFAULT))) {
            // FIXME: remove all decrypted content in the database, try to decode new one
            Toast.makeText(
                act, "Imported of ID worked. You must restart the app.",
                Toast.LENGTH_SHORT
            ).show()
            return true
        }
        Toast.makeText(act, "Import of new ID failed.", Toast.LENGTH_LONG).show()
        return false
    }

    private fun addPub(pubstring: String) {
        Log.d("D/addPub", pubstring)
        val components = pubstring.split(":")
        tremolaState.addPub(
            Pub(
                lid = "@" + components[3] + ".ed25519",
                host = components[1],
                port = components[2].split('~')[0].toInt()
            )
        )
    }

    fun rx_event(entry: LogEntry, bleSourceAddress: String? = null) {
        // when we come here we assume that the event is legit (chaining and signature)
        tremolaState.addLogEntry(entry)       // persist the log entry
        sendEventToFrontend(entry)            // notify the local app
        tremolaState.peers.newLogEntry(entry) // stream it to peers we are currently connected to
        // Relay to other nearby peers, but never echo a BLE event back to the
        // phone that just delivered it.
        tremolaState.bleSync?.onLocalLogEntry(entry, bleSourceAddress)
    }

    fun sendEventToFrontend(evnt: LogEntry) {
        if (tremolaState.bleSync?.consumeBoardLogEntryForFrontend(evnt) == true) return
        // Log.d("MSG added", evnt.ref.toString())
        var hdr = JSONObject()
        hdr.put("ref", evnt.hid)
        hdr.put("fid", evnt.lid)
        hdr.put("seq", evnt.lsq)
        hdr.put("pre", evnt.pre)
        hdr.put("tst", evnt.tst)
        var cmd = "b2f_new_event({header:${hdr.toString()},"
        cmd += "public:" + (if (evnt.pub == null) "null" else evnt.pub) + ","
        cmd += "confid:" + (if (evnt.pri == null) "null" else evnt.pri)
        cmd += "});"
        Log.d("CMD", cmd)
        eval(cmd)
    }
}
