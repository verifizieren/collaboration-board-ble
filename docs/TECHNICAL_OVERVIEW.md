# Technical Overview

## Base

- The main APK is the full Uni Basel Tremola Android app with our whiteboard changes.
- The board is a bundled HTML, CSS, and JavaScript mini-app.
- Tremola runs it inside its Android WebView.
- Native Kotlin code handles identity, storage, board access, encryption, and BLE.
- The browser version is only a UI and merge simulator.

There is also a separate APK based on the official tinySSB Android app. It uses
the same board UI, a `WBD` public event type, and tinySSB packet recovery. It is
kept separate because Tremola and tinySSB use different log formats and Android
packages.

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
- `n` - board display name
- `x` - cancel one unconfirmed local operation

The board is a finite 1800 x 2400 logical units. The first view is the original
900 x 1200 area, scaled to the available Tremola width. It does not shrink when
Android opens the keyboard. Different phone sizes therefore use the same shared
positions. The keyboard **Go** action hides the keyboard but keeps Text active.
Two fingers pan or zoom in Draw and Text without creating an object.

## Storage And Identity

- Tremola creates an Ed25519 feed identity on first start.
- Every board operation is signed with that identity.
- Board payloads are compressed before encryption when this saves space.
- AES-256-GCM encrypts board content with a key derived from the board code.
- Operations are stored in Room before BLE transmission.
- Each local operation is also added to the local Tremola custom-app log.
- Named board metadata and known member IDs are stored per board.
- Equal normalized names receive unique local palette indexes, up to eight.
- Closing and reopening a board replays its saved Room operations.
- Replay is batched so the WebView first shows the merged current state instead
  of painting old intermediate states.
- A local dark canvas and full-screen pan/zoom view do not create shared events.
- A local UI-size setting scales controls from 80% to 120% without changing board data.
- A peer ACK removes an operation from the local pending list. On the next load,
  pending edits can be kept or canceled without clearing the full board.

## Board Access

- The mini-app creates a six-digit code for each new board.
- The code selects the board ID and its 256-bit content key.
- A phone can open the board immediately without waiting for its creator.
- A signed BLE hello proves that a peer has the same code.
- Up to four Tremola feed IDs are kept in the board roster.
- Usernames are display names; the feed ID is the stable identity.
- Renaming the same feed does not use another member slot.
- Deleting removes the local board profile and Room operations only.

The code is a simple shared password, not strong access security. Anyone who
knows it can derive the board key. BLE addresses and handshake metadata are not
hidden. The older owner-pairing messages remain readable for old saved boards,
but new boards use direct code access.

## BLE Protocol

The old implementation could lose one large JSON message when one BLE fragment
was missed. Small events such as Clear were more likely to arrive.

The board protocol now uses:

- `bh` - signed and authenticated board hello
- `bf` - contiguous sequence frontier for each author
- `bw` - request for missing sequence ranges
- `bo` - encrypted and signed operation
- `ba` - acknowledgement for a complete operation
- `br` - board full or legacy owner required

Each GATT link has a bounded queue. Frames are written one at a time. The next
frame starts only after `onCharacteristicWrite` or `onNotificationSent`.
Indications are used when available. A complete operation still needs a `ba`
acknowledgement, so a dropped notification causes a retry.

The live build queues a completed operation immediately and retries it until an
acknowledgement arrives. About every five seconds, peers also exchange
frontiers. WANT ranges recover missed and offline operations. Stored operations
can also be relayed by another member.

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
- All members can edit all objects.
- No phone is the master copy.

Concurrent changes converge deterministically. For the same object and action
type, the later Lamport event wins. A clear hides older board objects.

## Late Join And Offline Work

- A finished local action is stored immediately.
- If no peer is nearby, it stays in the Room database.
- Reconnecting phones compare per-author frontiers.
- Missing ranges are requested until the contiguous frontiers match.
- A late member can receive the full board from any peer that has the missing
  operations.

## Android Compatibility

- Package: `nz.scuttlebutt.tremola`
- Version: `0.9.5` (`versionCode 27`)
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
- current-state replay, stable board names, board-list scrolling, and quick resume
- duplicate-name color assignment and zero-size first-View recovery
- stable text and canvas size while the Android keyboard opens
- keyboard Go, immediate text resize, and two-finger edit navigation
- named board catalogue, close, and reopen behavior
- direct six-digit codes, stable identity rename, local deletion, dark view,
  pan, and pinch zoom
- saved board-state migration from the previous UI format
- frontiers, missing ranges, queues, retries, and frame limits
- Android direct-code handshakes, Ed25519, AES-GCM, compression, and tamper rejection
- Android lint, APK build, signature, version, and bundled files
- tinySSB patch application, JavaScript, native build, signature, and assets

The emulator cannot test real BLE radio exchange. Two physical phones are still
required for the final acceptance test.

## Main Files

- `miniApps/collabboard/src/collabboard.js` - board state and UI behavior
- `BoardProtocol.kt` - signing, encryption, board access, and frontier helpers
- `BleSync.kt` - BLE links, frames, ACK, retry, WANT, and relay
- `BoardOperation.kt` and `BoardOperationDAO.kt` - persistent board log
- `WebAppInterface.kt` - WebView bridge
- `tests/collabboard.test.js` - board behavior tests
- `BoardProtocolTest.kt` - protocol unit tests
- `BoardProtocolInstrumentedTest.kt` - Android crypto tests
- `tinyssb/integration.patch` - official tinySSB Android integration
- `scripts/build-tinyssb.sh` - reproducible tinySSB APK build

## References

- [Uni Basel Tremola](https://github.com/cn-uofbasel/tremola)
- [ssbc tinySSB](https://github.com/ssbc/tinyssb)
- [tinySSB Android app](https://github.com/tinySSB/android-app)
- [Android BLE permissions](https://developer.android.com/develop/connectivity/bluetooth/bt-permissions)
- [Android BluetoothGatt](https://developer.android.com/reference/android/bluetooth/BluetoothGatt)
- [Android WebView local content](https://developer.android.com/develop/ui/views/layout/webapps/load-local-content)
