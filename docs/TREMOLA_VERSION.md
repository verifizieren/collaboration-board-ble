# Tremola Version 1.0

This is the comparison version. It is the full Uni Basel Tremola Android app
with Collaboration Board bundled as a MiniApp. The tinySSB build is the main
submission.

## Download

- APK: [`../install/tremola/whiteboard.apk`](../install/tremola/whiteboard.apk)
- Package: `nz.scuttlebutt.tremola`
- Version: `1.0` (`versionCode 29`)
- Minimum: Android 7.0 / API 24
- Members: up to four stable Tremola feed identities per board

## What A User Does

1. Install the APK and allow the requested Bluetooth permissions.
2. Open **MiniApps > Collaboration Board**.
3. Enter a display name and board name.
4. Tap **Create board**.
5. Tap **Code** to copy the generated six-digit code.
6. Other people enter their own name and that code under **Join**.
7. Everyone may draw, add text, move, resize, recolor, delete, and clear every
   object.
8. Tap **Boards** to leave the canvas without deleting its local copy.
9. Reopen the board later from the board list.

The code may be shared with several people, but the board roster stores only
four distinct feed IDs. The same phone keeps the same identity after a display
name change. A fifth identity is rejected even when another member is offline.

## What Is Stored

Tremola creates an Ed25519 feed identity on the first start. The visible name is
only a label for that identity.

Each completed board action is stored as a separate immutable operation in the
Android Room database. Stored fields include:

- board or room ID
- operation ID
- author feed ID
- increasing sequence number for that author
- event time
- encrypted and signed wire payload
- local receive time

Closing the app does not remove these rows. Opening the board replays all valid
stored operations and calculates the current canvas. Deleting a board from the
board list removes only that phone's local profile and operations.

See [`BoardOperation.kt`](../app/src/main/java/nz/scuttlebutt/tremola/ssb/db/entities/BoardOperation.kt)
and [`BoardOperationDAO.kt`](../app/src/main/java/nz/scuttlebutt/tremola/ssb/db/daos/BoardOperationDAO.kt).

## What Happens To One Action

For example, drawing one line produces one stroke operation after the finger is
released. The mini-app applies it locally at once, then calls the Android bridge.
Android adds an author sequence, compresses the payload when useful, encrypts it
with AES-256-GCM, signs it with the author's Ed25519 feed identity, stores it,
and queues it for authenticated board peers.

The receiver reconstructs the complete BLE message, verifies the room,
signature, author, and encryption tag, stores the operation, acknowledges it,
and passes the decoded event to the JavaScript reducer. The reducer ignores
duplicate IDs and redraws the merged board.

The full canvas image is never transmitted. See
[`SYNC_AND_MERGE.md`](SYNC_AND_MERGE.md) for every step and message type.

## BLE Reliability

- Completed operations are queued immediately.
- GATT frames are sent one at a time and wait for Android callbacks.
- A complete operation needs a board acknowledgement.
- Missing acknowledgement causes retry.
- Every five seconds, peers exchange per-author frontiers.
- A peer requests missing sequence ranges with a WANT message.
- Any authorized peer that has an operation may relay it.
- Offline edits remain stored and can be recovered after reconnection.

No phone is the master copy. Phones converge when they hold the same valid
operation set.

## Access And Security

The six-digit code creates the direct room ID and is used to derive the 256-bit
AES key. SHA-256 makes a correctly sized key, but it does not make six digits a
strong secret. There are only one million codes. Describe it as a shared access
code, not strong authentication.

Payloads are signed and encrypted. BLE addresses and handshake metadata are not
hidden. Share the code privately.

## Main Source Files

- [`../miniApps/collabboard/src/collabboard.js`](../miniApps/collabboard/src/collabboard.js) - UI, events, validation, merge, and rendering
- [`../app/src/main/java/nz/scuttlebutt/tremola/WebAppInterface.kt`](../app/src/main/java/nz/scuttlebutt/tremola/WebAppInterface.kt) - WebView-to-Android bridge
- [`../app/src/main/java/nz/scuttlebutt/tremola/ssb/peering/ble/BoardProtocol.kt`](../app/src/main/java/nz/scuttlebutt/tremola/ssb/peering/ble/BoardProtocol.kt) - code derivation, signing, encryption, and frontier helpers
- [`../app/src/main/java/nz/scuttlebutt/tremola/ssb/peering/ble/BleSync.kt`](../app/src/main/java/nz/scuttlebutt/tremola/ssb/peering/ble/BleSync.kt) - discovery, framing, ACK, retry, WANT, relay, and roster
- [`../tests/collabboard.test.js`](../tests/collabboard.test.js) - reducer and mobile workflow tests
- [`../app/src/test`](../app/src/test) - Android protocol and queue tests

## Test

Follow [`../install/README.md`](../install/README.md). Use two real phones with
Wi-Fi and mobile data off for the BLE acceptance test. The browser and emulator
can verify UI and Android compatibility, but they cannot prove real BLE radio
delivery.
