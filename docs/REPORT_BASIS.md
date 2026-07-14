# Report Basis

This file is a simple technical basis for the group report. It is not the final
report.

## Project Goal

Build a collaborative whiteboard inside Tremola. Nearby Android phones should
work without Internet and exchange changes over Bluetooth Low Energy.

## Problem

A normal web whiteboard often needs a server and a permanent connection. Our
project should work offline and should recover missing changes when two phones
meet again. Concurrent edits should not destroy the board state.

## Implemented Solution

- Collaboration Board is a Tremola mini-app.
- It runs in the full Tremola Android APK.
- It supports drawing, text, moving, resizing, panning, and clearing.
- It has a simple mobile layout with short controls and a large board area.
- It stores finished actions as signed append-only log events.
- It syncs missing log entries directly between nearby phones over BLE.
- It rebuilds the board by replaying events.
- It works in a browser simulator and on Android.

## Two Collaboration Modes

### Open

- Keeps Max's original event format and behavior.
- No board username is needed.
- Everyone can move, resize, recolor, or clear shared content.

### Protected

- Each person chooses a display name and one of four colors.
- Tremola's signed feed ID is the real owner identity.
- A person can move or resize only objects created by the same feed.
- Foreign objects show the owner's colored name and are view only.
- `Clear` removes only the current person's objects.

Open and Protected content is kept separate. The code stores Protected as
`owned` so existing board data stays compatible.

## Why Signed Events

Tremola already gives every phone a cryptographic feed identity. A board action
can therefore be signed, saved, replayed, and verified with the same system as
other Tremola data. The display name is not used as proof of ownership.

This also supports offline work. An action stays in the local append-only log
until another phone is available.

## Why Event Sync Instead Of Live Pointer Sync

Pointer positions can change many times per second and would create too much
small BLE traffic. The app sends a completed action instead:

- one stroke event after the finger is lifted
- one event after a move or resize is finished
- one event for text, profile, color, or clear

Local events are queued immediately. Every 8 seconds the phones also exchange
feed frontiers and recover anything that was missed.

## BLE Design

- Both phones scan and advertise the same GATT service.
- They exchange the latest known sequence for each feed.
- They send only missing log entries.
- Large entries are divided into small BLE frames.
- Frames are sent one at a time and checked through Android's BLE callbacks.
- Failed or stuck transfers retry or reconnect automatically.
- The receiver verifies the signature and feed chain.
- Duplicate entries are ignored.
- Offline edits arrive on the next contact.

BLE is used while Tremola is open. No server or cloud is required for nearby
board sync.

## Conflict Handling

The board is event based. It does not modify a shared file directly.

- events can arrive in a different order
- duplicate events are ignored
- last-write-wins is used for move, resize, color, and profile updates
- event ID breaks timestamp ties
- Protected edits are accepted only from the object's creator feed
- clears are separated by board mode and author

This is a small CRDT-like operation log. It gives deterministic replay for the
implemented actions, but it is not a general CRDT library.

## Android Integration

- The complete APK is based on Uni Basel Tremola.
- HTML, CSS, and JavaScript are bundled as Android assets.
- Android loads them through a local HTTPS WebView origin.
- A JavaScript bridge writes mini-app actions to Tremola's signed log.
- Native Kotlin code handles BLE.
- Android 7.0 and newer are supported by the build configuration.

The tinySSB Android Kanban app is useful prior work because it also shows an
offline-first collaborative app with BLE. It is a different codebase, so our
project keeps the Uni Basel Tremola host and uses the same general log-sync idea.

## Test Evidence

Automated checks currently cover:

- original Open event compatibility
- replay in different event orders
- duplicate handling
- move, resize, recolor, and clear behavior
- profile names and four allowed colors
- rejection of unsigned Protected events
- rejection of edits signed by a different owner
- per-author clear behavior
- profile fallback and profile updates
- BLE frame sizing, queue limits, retry delay, and reconnect limits
- Android unit tests, lint, APK build, signature, and bundled content

Browser tests also cover 360, 390, and 432 pixel phone widths and Alice/Bob
collaboration. The remaining final test is two physical Android phones using
native BLE.

## Limits To State Honestly

- The committed APK is a debug build, not a Play Store release.
- BLE was fully built and unit tested, but still needs the final two-phone test.
- BLE sync is intended for the foreground while Tremola is open.
- Board events and display names are public to nearby compatible peers.
- Names are not global accounts and do not have to be unique.
- Open last-write-wins can be affected by very different phone clocks.
- Protected mode prevents cross-feed edits; it does not hide the object.

## Suggested Report Structure

1. Motivation and requirements
2. Tremola, SSB logs, and prior tinySSB Kanban work
3. Whiteboard data model
4. Open and Protected collaboration modes
5. Android WebView integration
6. BLE frontier and frame protocol
7. Conflict and offline behavior
8. Tests and results
9. Limits and future work
10. Conclusion

## Useful Future Work

- run and document the two-phone BLE test
- add an optional board invitation or private board encryption
- replace timestamp conflict ordering with a logical clock
- add a foreground service only if background BLE becomes a requirement
- prepare a release-signed APK if distribution beyond the course is needed

## Sources

- [Uni Basel Tremola](https://github.com/cn-uofbasel/tremola)
- [tinySSB Android app and Kanban](https://github.com/tinySSB/android-app)
- [tinySSB MiniApp specification](https://github.com/tinySSB/mini-app-spec)
- [tinySSB specification](https://github.com/tinySSB/tiny-ssb-spec)
- [Android BLE permissions](https://developer.android.com/develop/connectivity/bluetooth/bt-permissions)
- [Android BLE overview](https://developer.android.com/develop/connectivity/bluetooth/ble/ble-overview)
- [Android WebView local content](https://developer.android.com/develop/ui/views/layout/webapps/load-local-content)
