# The Two Builds

Both Android builds share the whiteboard UI, event model, and reducer from
[`../miniApps/collabboard`](../miniApps/collabboard). They differ in the host
application, the transport, and the access rule. They do not synchronize with
each other.

| | tinySSB (main submission) | Tremola (comparison) |
| --- | --- | --- |
| Host | official `ssbc/tinyssb` Android app | Uni Basel Tremola Android app |
| Package | `nz.scuttlebutt.tremolavossbol` | `nz.scuttlebutt.tremola` |
| Version | `1.0` (`versionCode 9`) | `1.0` (`versionCode 29`) |
| Minimum | Android 8.0 / API 26 | Android 7.0 / API 24 |
| Access | signed invitation to a verified contact | shared six-digit board code |
| Members | creator plus first three acceptances, four total | up to four stable feed identities |
| Transport | tinySSB feed replication | board-specific BLE protocol |
| APK | [`../install/tinyssb/whiteboard.apk`](../install/tinyssb/whiteboard.apk) | [`../install/tremola/whiteboard.apk`](../install/tremola/whiteboard.apk) |

User-facing steps for both builds are in
[`../install/README.md`](../install/README.md).

---

# tinySSB Version

The main submission: the Collaboration Board as a mini-app inside the official
tinySSB Android host.

## Why The Invitation Matters

A new board receives a random board ID. A signed `wc` event announces the board.
The creator then writes signed `wi` invitation events addressed to verified
contact feed IDs. The receiver answers with `wa` for accept or `wd` for decline.
A `wp` event updates a member's display label.

The invitation contains the exact board information. A six-digit code can select
an invitation that is already stored on that phone, but a code by itself cannot
discover a remote tinySSB board.

The adapter builds the editor list deterministically from the creator and the
first three accepted feed IDs. It ignores whiteboard edits from other feeds.

Only the creator sends invitations, and one contact can be invited again after
30 seconds. The creator may invite eight different contacts, but eight
invitations do not create eight editors: the creator occupies the first editor
place and the first three valid acceptance events occupy the rest. Later
acceptances are reproducibly treated as Board full.

Invitation metadata currently starts its ordering value from the local wall
clock. If more than three recipients accept, clock skew can influence which
three are selected. Peers with the same event set still select the same three.

See [`../tinyssb/whiteboard/adapter.js`](../tinyssb/whiteboard/adapter.js).

## What Happens To One Action

The shared JavaScript UI creates the same stroke, text, move, resize, recolor,
delete, clear, and name events as Tremola. The tinySSB adapter publishes the
event as a public `WBD` application event in the author's signed tinySSB feed.

The official tinySSB host divides feed content into compact packets and linked
chunks. BLE peers exchange feed state and ask again for missing packets or
chunks. Only after the complete signed feed event is available does the adapter
receive it, check board membership, store it in the local cache, and apply the
shared deterministic reducer.

The Tremola-specific `bh`, `bo`, `ba`, `bf`, and `bw` messages are not used by
this APK. Recovery belongs to the tinySSB packet and chunk protocol.

## Security And Limits

Contact verification and signed invitation events are an application access
rule. Public `WBD` events are **not encrypted**. Do not describe this version as
a private BLE channel.

The app must stay in the foreground during synchronization, because the upstream
host stops BLE in `onPause`. Observations show slower synchronization and
occasional disconnects compared with Tremola. Record measured results instead of
calling this universally reliable or unreliable.

## Reproducible Integration

The build starts from pinned official tinySSB commit
`39896b72c97b51159d46610c5f11ff7f5a279031` and applies local patches:

- [`../tinyssb/integration.patch`](../tinyssb/integration.patch) - Productivity listing, `WBD` event route, invitation menu, and board bridge
- [`../tinyssb/ble-startup.patch`](../tinyssb/ble-startup.patch) - correct Android permission callback and BLE restart
- [`../tinyssb/whiteboard-export.patch`](../tinyssb/whiteboard-export.patch) - Android JPEG and PDF export
- [`../tinyssb/prepare-tinyssb.js`](../tinyssb/prepare-tinyssb.js) - prepares the official host assets
- [`../scripts/build-tinyssb.sh`](../scripts/build-tinyssb.sh) - checks, builds, signs, and writes the canonical APK

---

# Tremola Version

The comparison build: the full Uni Basel Tremola Android app with Collaboration
Board bundled as a MiniApp.

## What Is Stored

Tremola creates an Ed25519 feed identity on the first start. The visible name is
only a label for that identity, so renaming a phone does not consume another
member place. The roster stores four distinct feed IDs; a fifth identity is
rejected even when another member is offline.

Each completed board action is stored as a separate immutable operation in the
Android Room database. Stored fields include the board ID, operation ID, author
feed ID, an increasing per-author sequence number, the event time, the encrypted
and signed wire payload, and the local receive time.

Closing the app does not remove these rows. Opening the board replays all valid
stored operations and calculates the current canvas. Deleting a board from the
board list removes only that phone's local profile and operations.

See [`BoardOperation.kt`](../app/src/main/java/nz/scuttlebutt/tremola/ssb/db/entities/BoardOperation.kt)
and [`BoardOperationDAO.kt`](../app/src/main/java/nz/scuttlebutt/tremola/ssb/db/daos/BoardOperationDAO.kt).

## What Happens To One Action

Drawing one line produces one stroke operation after the finger is released. The
mini-app applies it locally at once, then calls the Android bridge. Android adds
an author sequence, compresses the payload when useful, encrypts it with
AES-256-GCM, signs it with the author's Ed25519 feed identity, stores it, and
queues it for authenticated board peers.

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
strong secret: there are only one million codes. Describe it as a shared access
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
