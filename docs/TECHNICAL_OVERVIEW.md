# Technical Overview

## Base

- The APK is the full Uni Basel Tremola Android app with our whiteboard changes.
- The board is a bundled HTML, CSS, and JavaScript mini-app.
- Tremola runs it inside its Android WebView.
- Native Kotlin code handles identity, storage, invitations, encryption, and BLE.
- The browser version is only a UI and merge simulator.

The tinySSB Android project was used as a design reference. We keep the Uni
Basel Tremola app and use a board-specific replication protocol because the two
projects use different log formats.

## Project Family

- Secure Scuttlebutt is a decentralized system of signed, append-only user feeds.
- Tremola is the Uni Basel Android client and provides identity, storage, and the
  mini-app host.
- Tremola mini-apps are HTML and JavaScript interfaces running inside the app.
- tinySSB is a related compact protocol for small BLE and LoRa packets. Its
  recovery ideas are useful here, but its binary log is not a drop-in Tremola
  replacement.

## Board Operations

The board sends one operation after a user finishes an action:

- `s` - stroke
- `t` - text
- `m` - move or resize
- `k` - color change
- `d` - delete one object
- `c` - clear the board

The board is fixed at 900 x 1200 logical units. CSS scales it to the available
Tremola screen. Different phone sizes therefore use the same shared positions.

## Storage And Identity

- Tremola creates an Ed25519 feed identity on first start.
- Every board operation is signed with that identity.
- Board payloads are compressed before encryption when this saves space.
- AES-256-GCM encrypts board content with the key in the invite code.
- Operations are stored in Room before BLE transmission.
- Each local operation is also added to the local Tremola custom-app log.
- Closing and reopening the app replays the saved board operations.

## Invite-Only Boards

- A random board ID and 256-bit board key are created on the owner's phone.
- The invite code contains the board ID, key, and owner feed ID.
- The owner signs the first admission for each member.
- One owner and three admitted members are allowed.
- An admitted member keeps the signed admission after restarting the app.
- A new member needs the owner nearby for the first admission.
- Usernames are display names; the cryptographic feed ID is the real identity.

The board content is private from nearby devices that do not know the invite
key. BLE addresses and some handshake metadata are not hidden.

## BLE Protocol

The old implementation could lose one large JSON message when one BLE fragment
was missed. Small events such as Clear were more likely to arrive.

The board protocol now uses:

- `bh` - authenticated board hello
- `bm` - owner-signed member admission
- `bf` - contiguous sequence frontier for each author
- `bw` - request for missing sequence ranges
- `bo` - encrypted and signed operation
- `ba` - acknowledgement for a complete operation
- `br` - board full or owner required

Each GATT link has a bounded queue. Frames are written one at a time. The next
frame starts only after `onCharacteristicWrite` or `onNotificationSent`.
Indications are used when available. A complete operation still needs a `ba`
acknowledgement, so a dropped notification causes a retry.

This experiment stores local and relayed operations without sending them
immediately. About every 5 seconds, peers exchange frontiers and transfer the
missing operations as a batch. Failed operations retry on a later batch. WANT
ranges recover missed and offline operations. Stored operations can also be
relayed by another admitted member.

Event payloads are compressed before encryption. This makes long strokes much
smaller than the old Base64 Tremola JSON path. Board traffic is separate from
general Tremola history while a board is active.

## Merge Rules

- Every event has a unique ID.
- Every author has an increasing board sequence.
- Duplicates are ignored.
- Events may arrive in any order.
- Move, resize, color, delete, and clear use Lamport order plus event ID.
- A transform may arrive before its original object and is applied later.
- All admitted members can edit all objects.
- No phone is the master copy after admission.

Concurrent changes converge deterministically. For the same object and action
type, the later Lamport event wins. A clear hides older board objects.

## Late Join And Offline Work

- A finished local action is stored immediately.
- If no peer is nearby, it stays in the Room database.
- Reconnecting phones compare per-author frontiers.
- Missing ranges are requested until the contiguous frontiers match.
- A late admitted member can receive the full board from any admitted peer that
  has the missing operations.

## Android Compatibility

- Package: `nz.scuttlebutt.tremola`
- Version: `0.5.0-5s` (`versionCode 18`)
- Minimum: API 24 / Android 7.0
- Target and compile SDK: API 30, matching the Uni Basel base
- Android 7-11 use location permission for BLE scanning.
- Android 12 and newer also use Scan, Advertise, and Connect permissions.
- Android 7-11 may require the Location setting to be on.
- The same APK and board protocol must be used on all test phones.
- App launch and protocol tests pass on API 24, 35, and 36 emulators.
- Emulator tests do not replace the final two-phone BLE radio test.

## Automated Checks

`./scripts/check.sh` checks:

- browser and Android mini-app copies are equal
- JavaScript syntax and board behavior
- reverse-order replay and duplicate handling
- draw, text, move, resize, color, delete, and clear
- finite-board scaling on different display sizes
- saved board-state migration from the previous UI format
- frontiers, missing ranges, queues, retries, and frame limits
- real Android Ed25519, AES-GCM, compression, and tamper rejection
- Android lint, APK build, signature, version, and bundled files

The emulator cannot test real BLE radio exchange. Two physical phones are still
required for the final acceptance test.

## Main Files

- `miniApps/collabboard/src/collabboard.js` - board state and UI behavior
- `BoardProtocol.kt` - signing, encryption, admissions, and frontier helpers
- `BleSync.kt` - BLE links, frames, ACK, retry, WANT, and relay
- `BoardOperation.kt` and `BoardOperationDAO.kt` - persistent board log
- `WebAppInterface.kt` - WebView bridge
- `tests/collabboard.test.js` - board behavior tests
- `BoardProtocolTest.kt` - protocol unit tests
- `BoardProtocolInstrumentedTest.kt` - Android crypto tests

## References

- [Uni Basel Tremola](https://github.com/cn-uofbasel/tremola)
- [ssbc tinySSB](https://github.com/ssbc/tinyssb)
- [tinySSB Android app](https://github.com/tinySSB/android-app)
- [Android BLE permissions](https://developer.android.com/develop/connectivity/bluetooth/bt-permissions)
- [Android BluetoothGatt](https://developer.android.com/reference/android/bluetooth/BluetoothGatt)
- [Android WebView local content](https://developer.android.com/develop/ui/views/layout/webapps/load-local-content)
