# Report Basis

This is a short technical basis for the group report. It is not the final
report.

## Goal

Build a collaborative whiteboard inside Tremola. Up to four nearby Android
phones should work without Internet and exchange changes over BLE.

## Result

- The board is integrated as a Tremola mini-app.
- It runs in the full Tremola Android APK.
- A user creates a private board and shares an invite code.
- Each member chooses a display name.
- The owner admits at most three other Tremola identities.
- Every admitted member can edit every object.
- Draw, text, move, resize, color, delete, and clear are supported.
- The fixed board scales to different phone screens.
- Board state survives an app restart.
- Offline and late members recover missing operations.

## Method

The work followed these steps:

1. Inspect the Uni Basel Tremola app and its mini-app bridge.
2. Inspect tinySSB's fixed packets and WANT/CHNK recovery.
3. Reproduce the failed mobile sync path with long fragmented events.
4. Separate whiteboard replication from general Tremola history.
5. Add persistent signed operations, encryption, ACK, retry, and WANT ranges.
6. Add deterministic merge rules for every board action.
7. Test JavaScript behavior, Android crypto, database migration, and APK build.
8. Prepare a two-phone BLE acceptance test.

## Data Flow

```text
finished board action
  -> validate and sign
  -> compress when useful
  -> encrypt with board key
  -> save in Room
  -> split into MTU-safe BLE frames
  -> receive and verify full operation
  -> send operation ACK
  -> save and replay in the mini-app
```

The app sends one event after an action. It does not send every finger position.
In the 5-second experiment, finished actions are stored locally and released
during the next periodic frontier exchange. Only missing operations are sent;
the full board image is never transmitted.

## Why The Old Sync Failed

Long strokes became large Base64 JSON messages with many BLE fragments. If one
fragment was missed, the full event could not be rebuilt. Clear often worked
because it was small and independent.

The new path waits for each Android GATT callback and also requires a complete
operation ACK. Missing author sequences are requested again by frontier and
WANT messages.

## Merge Model

The board is an operation log, not one shared file.

- additions have unique event IDs
- each author has an increasing sequence
- duplicates are ignored
- missing operations are requested again
- transformations can arrive before their object
- concurrent updates use Lamport order and event ID
- all phones rebuild the same visible state

No phone is always correct or always the master. The signed operations are
merged with the same deterministic rules on every phone.

## Security

- Tremola feed IDs identify members.
- The owner signs member admissions.
- The board key authenticates the handshake.
- Board content uses AES-256-GCM encryption.
- Operations use Ed25519 signatures.
- The board is limited to four admitted identities.

The invite code is a secret and must be shared privately. BLE radio metadata is
not encrypted.

## Compatibility

- Android 7.0 and newer are supported by the APK.
- Android 12+ uses the newer Bluetooth runtime permissions.
- Older Android versions use location permission for BLE scanning.
- The same APK should be installed on all test phones.
- The mini-app runs inside Tremola's WebView; Kotlin handles native BLE.

## Test Evidence

Automated tests cover:

- draw, text, move, resize, color, delete, and clear
- different event orders and duplicate replay
- edits made by another member
- logical clocks and clock differences
- finite-board coordinate scaling
- queue limits, GATT retry, frontier, and missing ranges
- encryption, signatures, compression, and tamper rejection on Android
- database migration, lint, APK build, signature, and bundled assets

The last required result is a documented test with two real phones and Wi-Fi
and mobile data off.

## Limits

- The provided APK is debug-signed.
- BLE is designed for the app foreground.
- A new member needs the owner for first admission.
- Member slots are not revoked; create a new board to reset them.
- The invite code does not hide BLE addresses or all handshake metadata.

## Suggested Report Sections

1. Motivation and requirements
2. Tremola and tinySSB background
3. Whiteboard data model
4. Invite and identity model
5. BLE transport and recovery
6. Merge and offline behavior
7. Android integration
8. Tests and results
9. Limits and future work
10. Conclusion

## Sources

- [Uni Basel Tremola](https://github.com/cn-uofbasel/tremola)
- [ssbc tinySSB](https://github.com/ssbc/tinyssb)
- [tinySSB Android app](https://github.com/tinySSB/android-app)
- [Android BLE permissions](https://developer.android.com/develop/connectivity/bluetooth/bt-permissions)
- [Android BLE overview](https://developer.android.com/develop/connectivity/bluetooth/ble/ble-overview)
- [Android WebView local content](https://developer.android.com/develop/ui/views/layout/webapps/load-local-content)
