# Report Basis

This is a simple technical basis for the group report. It is not the final
report.

## Project Goal

Build a collaborative whiteboard inside Tremola. Nearby Android phones should
work without Internet and exchange changes over Bluetooth Low Energy.

## Implemented Solution

- Collaboration Board is a Tremola mini-app.
- It runs inside the full Tremola Android APK.
- Everyone can edit every board object.
- It supports drawing, text, moving, resizing, panning, recoloring, and clearing.
- It uses the Android color picker.
- It stores finished actions as signed append-only log events.
- It sends missing log entries directly between nearby phones over BLE.
- It rebuilds the board by replaying events.
- It works in a browser simulator and on Android.

There are no board usernames, profiles, or owner locks.

## Why Signed Events

Tremola gives every phone a cryptographic feed identity. Each board action can
therefore be signed, saved, replayed, and verified with Tremola's existing log.

This also supports offline work. An action stays in the local log until another
phone is available.

## Why Finished Actions Are Sent

A finger can move many times per second. Sending every pointer position would
create unnecessary BLE traffic. The app sends:

- one event after a stroke
- one event after a move or resize
- one event for text, color, or clear

Local events are queued immediately. Every 8 seconds, phones also exchange feed
frontiers and recover anything that was missed.

## BLE Design

- Both phones scan and advertise the same GATT service.
- They exchange the latest known sequence for each feed.
- They send only missing log entries.
- Large entries are split into small BLE frames.
- Frames are sent one at a time through Android BLE callbacks.
- Failed or stuck transfers retry or reconnect.
- The receiver checks the signature and feed chain.
- Duplicate entries are ignored.
- Offline edits arrive after the phones reconnect.

BLE is used while Tremola is open. No server or cloud is required for nearby
whiteboard sync.

## Conflict Handling

The board is event based. It does not modify one shared file directly.

- Events may arrive in a different order.
- Duplicate events are ignored.
- Last-write-wins is used for move, resize, and color changes.
- Each phone advances its logical timestamp past events it has seen.
- Event ID breaks timestamp ties.
- Clear affects the complete shared board.

This is a small CRDT-like operation log. It gives deterministic replay for the
implemented actions, but it is not a general CRDT library.

## Android Integration

- The APK is based on Uni Basel Tremola.
- HTML, CSS, and JavaScript are bundled as Android assets.
- Android loads them through a local HTTPS WebView origin.
- A JavaScript bridge writes mini-app actions to Tremola's signed log.
- Native Kotlin code handles BLE.
- Android 7.0 and newer are supported.

The tinySSB Android Kanban app is useful prior work because it also combines an
offline collaborative app with BLE. Our project keeps the Uni Basel Tremola host
and uses the same general log-sync idea.

## Test Evidence

Automated checks cover:

- Max's original shared event format
- replay in different event orders
- duplicate handling
- drawing, text, move, resize, recolor, and clear
- editing an object created by another Tremola feed
- arbitrary valid colors from the Android color picker
- clock differences between phones
- cleanup of the removed profile/owner experiment
- BLE frame size, queues, retry delay, and reconnect limits
- Android unit tests, lint, APK build, signature, and bundled files

The remaining final test is two physical Android phones using native BLE.

## Limits

- The committed APK is a debug build, not a Play Store release.
- BLE still needs the final two-phone test.
- BLE sync is intended for the foreground while Tremola is open.
- Whiteboard events are public to nearby compatible Tremola peers.
- Concurrent changes use deterministic last-write-wins, so only one change wins.

## Suggested Report Structure

1. Motivation and requirements
2. Tremola, SSB logs, and prior tinySSB Kanban work
3. Whiteboard data model
4. Shared editing workflow
5. Android WebView integration
6. BLE frontier and frame protocol
7. Conflict and offline behavior
8. Tests and results
9. Limits and future work
10. Conclusion

## Useful Future Work

- run and document the two-phone BLE test
- add optional board invitations or private board encryption
- add an optional history or undo feature
- add a foreground service only if background BLE is required
- prepare a release-signed APK for wider distribution

## Sources

- [Uni Basel Tremola](https://github.com/cn-uofbasel/tremola)
- [tinySSB Android app and Kanban](https://github.com/tinySSB/android-app)
- [tinySSB MiniApp specification](https://github.com/tinySSB/mini-app-spec)
- [tinySSB specification](https://github.com/tinySSB/tiny-ssb-spec)
- [Android BLE permissions](https://developer.android.com/develop/connectivity/bluetooth/bt-permissions)
- [Android BLE overview](https://developer.android.com/develop/connectivity/bluetooth/ble/ble-overview)
- [Android WebView local content](https://developer.android.com/develop/ui/views/layout/webapps/load-local-content)
