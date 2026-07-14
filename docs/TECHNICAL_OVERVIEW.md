# Technical Overview

## Base

- The APK is the full Uni Basel Tremola Android app with our changes.
- Collaboration Board is a bundled HTML, CSS, and JavaScript mini-app.
- Android runs the mini-app inside Tremola's WebView.
- Android 7.0 and newer are supported.
- The browser version is a simulator for quick UI and replay tests.

The separate tinySSB Android app was a useful reference for offline Kanban and
BLE. Our project keeps the Uni Basel Tremola host and its mini-app interface.

## Shared Board

There is one board and one edit rule: every peer can edit every object.

- Draw creates a stroke.
- Text places a text object.
- Draw and Text stay active until their button is tapped again.
- Edit selects an object.
- Drag moves an object.
- The corner handle resizes an object.
- The Android color picker sets the drawing or text color.
- Changing the color while an object is selected recolors that object.
- Delete removes one selected object.
- Clear removes the complete shared board.

There are no board profiles, usernames, or owner locks.

## Data Flow

```text
finished board action
  -> mini-app event
  -> signed Tremola SSB log entry
  -> local Room database
  -> BLE frames
  -> signature and feed-chain check
  -> remote database
  -> mini-app replay
```

The app sends one event after an action is finished. It does not send every
pointer movement. This keeps BLE traffic small.

## Board Events

The board keeps Max's original shared events and adds one delete event:

- `s` - stroke
- `t` - text
- `m` - move or resize
- `k` - color change
- `d` - delete one object
- `c` - clear the board

Temporary profile and owner events from versions 0.4.3 to 0.4.5 are ignored.
Existing events from the original shared board remain available.

## Conflict Rules

- Duplicate event IDs are ignored.
- Events can arrive in any order.
- Move, resize, color, and delete updates converge in any arrival order.
- Each phone advances a logical timestamp past all events it has seen.
- The event ID breaks a timestamp tie.
- State is rebuilt by replaying the signed event log.

The tests replay events in different orders. They also check clock differences,
global clear, and edits made by a different Tremola feed.

## BLE Transport

- Each phone scans and advertises one Tremola GATT service.
- A phone can be both BLE client and GATT server.
- Peers exchange the newest sequence known for each feed.
- Only missing signed log entries are sent.
- A finished local event is queued immediately.
- The local board applies the action immediately before the signed echo returns.
- Frontier recovery runs every 3 seconds.
- A valid event that arrives too early waits for its missing feed entries.
- Large messages are split into MTU-safe frames.
- GATT operations are sent one at a time.
- Failed or stuck operations retry or reconnect.
- Turning Bluetooth off and on restarts BLE sync.
- Signatures and feed-chain links are checked before storage.
- BLE is intended for use while Tremola is open.

Private Tremola chat entries stay encrypted over BLE. Whiteboard events are
public SSB entries.

## WebView

Android loads bundled web files through `WebViewAssetLoader` at a local HTTPS
origin. File access and universal file URL access are disabled. JavaScript is
required because Tremola and its mini-apps use JavaScript. A small native bridge
writes signed log entries and exposes BLE status.

## Compatibility

- Package: `nz.scuttlebutt.tremola`
- App version: `0.4.9`
- Minimum Android: API 24 / Android 7.0
- Target and compile SDK: API 30, matching the Uni Basel base
- Max's stroke, text, move, color, and clear event formats are unchanged
- Existing shared objects remain available after update
- BLE peers should use the same APK
- The tinySSB Kanban app uses a different BLE format

## Checks

`./scripts/check.sh` runs:

- browser and Android mini-app mirror check
- JavaScript syntax and board behavior tests
- Android BLE unit tests
- Android lint
- debug APK build
- APK signature and content check
- SHA-256 checksum generation

The remaining final check is BLE sync between two real Android phones.

## Main Files

- `miniApps/collabboard/` - mini-app source
- `app/src/main/assets/web/miniApps/collabboard/` - APK copy
- `WebAppInterface.kt` - WebView to Tremola bridge
- `TremolaState.kt` - signed-log append and storage
- `BleSync.kt` - BLE discovery, framing, and frontier sync
- `tests/collabboard.test.js` - board tests
- `BleSyncTest.kt` - BLE frame and queue tests

## References

- [Uni Basel Tremola](https://github.com/cn-uofbasel/tremola)
- [tinySSB Android app](https://github.com/tinySSB/android-app)
- [tinySSB MiniApp specification](https://github.com/tinySSB/mini-app-spec)
- [tinySSB specification](https://github.com/tinySSB/tiny-ssb-spec)
- [Android BLE permissions](https://developer.android.com/develop/connectivity/bluetooth/bt-permissions)
- [Android WebView local content](https://developer.android.com/develop/ui/views/layout/webapps/load-local-content)
