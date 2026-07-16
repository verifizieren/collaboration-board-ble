# Report Basis

Short notes for the group report. The report itself should stay honest about
what was tested on real phones.

## Current System

- The Collaboration Board is a mini-app inside the full Tremola Android app.
- The main APK supports Android 7.0 and newer.
- Up to four Tremola feed identities are kept for one board.
- Every member can draw, add text, move, resize, recolor, delete, and clear.
- The canvas is finite: 1800 x 2400 logical units.
- Boards, operations, names, and known members are stored locally.
- A finished action is saved first and sent over BLE immediately.
- Peers exchange frontiers every five seconds and request missing operations.
- ACK and retry handle interrupted BLE delivery.
- The same event set always produces the same visible board.
- The browser version is a UI and merge preview. It does not test Android BLE.
- The tinySSB APK is a separate experimental host, not the Tremola submission.

## Six-Digit Code

The code is generated with Web Crypto when available. In the Tremola build:

- the room ID is `code-<six digits>-v1`
- SHA-256 derives a 32-byte board key from a domain string and the code
- AES-256-GCM encrypts each board payload
- Ed25519 signs each operation
- another SHA-256 value checks the code when a local board is deleted

SHA-256 does not make six digits a strong secret. There are only one million
possible codes, and the direct room ID contains the code. Call it a **shared
access code**, not secure authentication or strong end-to-end privacy.

The tinySSB adapter gives every new board a random ID. A signed invitation
contains that exact ID, so typing the same short code cannot create another
board. The Join form may use the code only to select an invitation that has
already arrived. The creator may invite eight verified contacts. The creator
and the first three valid acceptances form the deterministic four-person editor
list. Signed accept and decline events give the sender a reproducible status.
Repeat invites to one contact have a 30-second limit. tinySSB does not encrypt
public `WBD` events.

## Main Data Flow

```text
finished action
  -> JavaScript event
  -> Android bridge
  -> compress, encrypt, and sign
  -> save in Room
  -> split into MTU-safe BLE frames
  -> verify, acknowledge, and save
  -> apply deterministic merge rules
  -> update the peer's board
```

The full canvas image is never sent. Pointer movement is kept local while the
finger is down. One operation is created when the action finishes.

## Methodology Feedback

The current Methodology chapter contains useful architecture, but it mostly
explains **what the system is**. Methodology should also explain **how the team
built and evaluated it**.

Use this order:

1. Requirements and constraints: offline, nearby BLE, Tremola mini-app, Android,
   up to four identities, and eventual convergence.
2. Prototype: Max's Tremola-for-Chrome board for fast UI work.
3. Android integration: WebView bridge, Room storage, identity, and native BLE.
4. Data model: immutable operations and deterministic merge rules.
5. Reliability work: reproduce dropped large messages, then add board-only
   queues, compression, ACK, retry, frontier, and WANT ranges.
6. Validation: automated JavaScript/Kotlin tests, APK checks, emulator launch,
   and the final real-phone BLE test with Wi-Fi and mobile data off.

For every test, write the setup, action, expected result, actual result, and
device/Android version. Do not call a feature successful until it passed on the
real phones.

## Report Corrections

- **Introduction:** replace "two devices" with "up to four identities". Replace
  "real time" with "nearby, offline, operation-based synchronization".
- **Tremola for Chrome:** describe it as the first prototype and test harness,
  not the final Android transport.
- **Mini-App Integration:** the UI is a mini-app, but the project also changes
  Tremola core code for the bridge, Room database, and BLE protocol.
- **Events:** remove `o` (owned) and `p` (profile). Current shared events are
  `s`, `t`, `m`, `k`, `d`, `c`, and `n`. The old `x` event is accepted only for
  compatibility.
- **Identity:** Tremola uses an SSB Ed25519 feed identity. Do not call this a
  tinySSB identity in the main build. Display names are not identities.
- **Security:** Tremola payloads use AES-GCM and signatures, but the short code
  is not strong secrecy. tinySSB `WBD` events are public.
- **Conflict resolution:** remove Protected Mode and ownership rules. Everyone
  can edit every object. New events use Lamport order and event ID as a tie-break.
- **BLE:** change eight seconds to five seconds. Describe operation ACK, retry,
  frontier, WANT ranges, board-only traffic, and compression. The board path
  verifies operation signatures; it does not verify a complete SSB feed chain
  before showing every BLE operation.
- **Discussion:** include measured results, remaining limits, and the difference
  between automated checks and real BLE tests.
- **Conclusion:** complete it only after the final phone test. Avoid "all
  features sync" unless the test table proves it.

## Problem And Solution

The old Android path sent large signed JSON events as many BLE fragments. One
missing fragment could lose the whole event. Clear often worked because it was
small and did not depend on an earlier object. Move and resize could not be
shown if the original draw or text event was missing.

The current path stores each board operation before sending it. It compresses
large payloads, waits for Android GATT callbacks, requires an operation ACK,
retries delivery, compares per-author frontiers every five seconds, and requests
missing sequence ranges. Only operations for the active board use this queue.
Move and resize can arrive before their target and are applied when the target
is available.

The tinySSB first-start problem had another cause: the upstream Android host
handled the BLE permission result in the wrong callback. The patch requests the
correct Android permissions, starts BLE after approval, and restarts BLE after
Bluetooth is enabled.

## What Changed From Max's Prototype

Kept:

- the Tremola-for-Chrome development setup
- the mini-app manifest and basic board UI
- draw, text, object IDs, drag, resize, and recolor concepts

Added or changed:

- full Tremola Android packaging and native bridge
- finite mobile canvas, pan, pinch zoom, board list, and saved boards
- display names, six-digit codes, and a four-identity roster
- signed and encrypted Room operations
- board-specific BLE ACK, retry, frontier, WANT, and relay
- deterministic shared editing for all objects
- the separate experimental tinySSB build
- verified-contact invitations and Android JPEG/PDF export in the tinySSB build

## Source Map

- `miniApps/collabboard/src/collabboard.js` - UI, events, board state, merge rules
- `miniApps/collabboard/resources/` - HTML and CSS
- `app/src/main/java/nz/scuttlebutt/tremola/WebAppInterface.kt` - WebView bridge
- `app/src/main/java/nz/scuttlebutt/tremola/ssb/peering/ble/BoardProtocol.kt` - code, SHA-256, AES-GCM, Ed25519, frontier helpers
- `app/src/main/java/nz/scuttlebutt/tremola/ssb/peering/ble/BleSync.kt` - BLE frames, ACK, retry, WANT, relay, four-member roster
- `app/src/main/java/nz/scuttlebutt/tremola/ssb/db/entities/BoardOperation.kt` - stored operation
- `app/src/main/java/nz/scuttlebutt/tremola/ssb/db/daos/BoardOperationDAO.kt` - Room queries
- `tests/collabboard.test.js` - merge and UI behavior tests
- `app/src/test/` and `app/src/androidTest/` - Android protocol and crypto tests
- `tinyssb/whiteboard/adapter.js` - public tinySSB `WBD` adapter
- `tinyssb/ble-startup.patch` - tinySSB permission and BLE restart fix
- `tinyssb/whiteboard-export.patch` - Android JPEG and PDF export
- `docs/TECHNICAL_OVERVIEW.md` - detailed design
- `install/README.md` - install and real-phone test steps

## External Sources

- [Uni Basel Tremola](https://github.com/cn-uofbasel/tremola)
- [ssbc tinySSB](https://github.com/ssbc/tinyssb)
- [Android BLE permissions](https://developer.android.com/develop/connectivity/bluetooth/bt-permissions)
- [Android BluetoothGatt](https://developer.android.com/reference/android/bluetooth/BluetoothGatt)
- [Android WebView](https://developer.android.com/develop/ui/views/layout/webapps)
