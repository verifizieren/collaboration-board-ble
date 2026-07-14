# Technical Overview

## Base

- The APK is the full Uni Basel Tremola Android app with our changes.
- The board is a Tremola mini-app written in HTML, CSS, and JavaScript.
- The board is included in the APK and runs inside Tremola's WebView.
- The browser version is a simulator for fast UI and replay tests.
- Android support stays at API 24 or newer, which means Android 7.0 or newer.

The older Uni Basel Tremola repo is the Android host used here. The separate
tinySSB Android app has chat, Kanban, and BLE, but uses a different native
architecture. We used it as a design reference instead of copying its app.

## Data Flow

```text
board action
  -> mini-app event
  -> signed Tremola SSB log entry
  -> local Room database
  -> BLE frames
  -> signature and feed-chain check
  -> remote database
  -> mini-app replay
```

The app does not send every pointer movement. It sends one event after a stroke,
text placement, move, resize, color change, profile change, or clear action is
finished. This keeps BLE traffic small.

## Board Events

Open mode keeps Max's original event format:

- `s` - stroke
- `t` - text
- `m` - move or resize
- `k` - color change
- `c` - clear the Open board

Owned mode uses a wrapper:

```json
{"k":"o","a":"s","id":"...","n":"Alice","c":"#15803d","p":[[10,10],[20,20]]}
```

- `k: "o"` marks an Owned event.
- `a` contains the original action type.
- new strokes and text include the display name and fixed profile color.
- older Max clients ignore the new wrapper and keep working in Open mode.

Profiles use `k: "p"` and contain a name plus one of four colors.

## Identity And Ownership

- Tremola creates an Ed25519 feed identity on the phone.
- Every log event is signed by that identity.
- Android passes the verified feed ID to the mini-app with the event header.
- Owned objects store that verified feed ID as their creator.
- A move or resize is accepted only when its signed feed ID matches the creator.
- Display names are labels only. They are not trusted for ownership.
- Names do not need to be unique.

Open and Owned are separate local views of the same log. Open keeps the old
shared behavior. Owned gives each signed feed control over only its own objects.
Foreign objects can still be selected to show the owner and `view only` state.

Changing a profile color also changes how that person's Owned objects render.
`Clear mine` hides only objects from the same signed feed.

This is an edit rule, not encryption. Board names and public board events can be
read by nearby compatible peers.

## Conflict Rules

- Duplicate event IDs are ignored.
- Events can arrive in any order.
- Move, resize, color, and profile updates use last-write-wins.
- The event timestamp is compared first and the event ID is the tie-breaker.
- Owned edits from a different feed are ignored for the target object.
- Clear events are separate for Open and for each Owned author.
- State is rebuilt by replaying the signed event log.

The test suite replays events in different orders and checks that the same board
state is produced. Large clock differences can still affect Open-mode
last-write-wins decisions.

## BLE Transport

- Each phone advertises and scans for one Tremola GATT service.
- A phone can act as both BLE client and GATT server.
- Peers exchange a frontier: the newest sequence number known for each feed.
- Only missing signed log entries are requested and sent.
- A local completed event is queued immediately.
- Frontier recovery runs every 8 seconds.
- Large JSON messages are split into MTU-safe frames and rebuilt on receipt.
- A complete frame batch is accepted or rejected as one queue operation.
- Signatures and feed-chain links are checked before storage.
- Duplicate or already known entries are ignored.
- BLE is intended for use while Tremola is open.

Private Tremola chat entries remain encrypted when moved over BLE. Collaboration
Board events are public SSB entries.

## WebView

Android loads the bundled web files through `WebViewAssetLoader` at a local HTTPS
origin. File access and universal file URL access are disabled. JavaScript is
required because Tremola's original UI and all mini-apps use JavaScript. The
native bridge accepts a small set of Tremola commands, including signed mini-app
log writes and BLE controls.

## Compatibility

- Package: `nz.scuttlebutt.tremola`
- App version: `0.4.0`
- Minimum Android: API 24 / Android 7.0
- Target and compile SDK: API 30, matching the Uni Basel base
- Open event format: unchanged from Max's implementation
- Owned/profile events: ignored by older board code
- Existing Open objects remain available after update

## Checks

`./scripts/check.sh` performs:

- browser/Android mini-app mirror check
- JavaScript syntax and board behavior tests
- Android BLE unit tests
- Android lint
- debug APK build
- APK signature and content check
- SHA-256 checksum generation

Browser checks cover mobile widths, profile setup, two-peer event delivery, and
the foreign-object lock. The only remaining functional check is native BLE on
two real Android phones.

## Main Files

- `miniApps/collabboard/` - mini-app source
- `app/src/main/assets/web/miniApps/collabboard/` - APK copy
- `WebAppInterface.kt` - WebView to Tremola bridge
- `TremolaState.kt` - safe local signed-log append
- `BleSync.kt` - BLE discovery, framing, and frontier sync
- `tests/collabboard.test.js` - board and ownership tests
- `BleSyncTest.kt` - BLE frame and queue tests

## References

- [Uni Basel Tremola](https://github.com/cn-uofbasel/tremola)
- [tinySSB Android app](https://github.com/tinySSB/android-app)
- [tinySSB MiniApp specification](https://github.com/tinySSB/mini-app-spec)
- [tinySSB specification](https://github.com/tinySSB/tiny-ssb-spec)
- [Android BLE permissions](https://developer.android.com/develop/connectivity/bluetooth/bt-permissions)
- [Android WebView local content](https://developer.android.com/develop/ui/views/layout/webapps/load-local-content)
