# Install On Android

Download and install:

[`tremola-collaboration-board-debug.apk`](tremola-collaboration-board-debug.apk)

The APK contains Tremola, Collaboration Board, and BLE sync. It needs Android
7.0 or newer.

## Direct Install

1. Send the APK to the phone.
2. Open the APK.
3. Allow installation from this source if Android asks.
4. Install and open Tremola.
5. Allow Bluetooth and location access.
6. Open **MiniApps > Collaboration Board**.

Tremola creates its identity automatically. No server login is needed.

## Shared Board

- Everyone can edit every object.
- Use the Android color picker for drawing, text, or recoloring an object.
- No board name or profile is needed.

## USB Install

Enable USB debugging, connect the phone, and run this from the repo folder:

```bash
./scripts/android.sh devices
./scripts/android.sh install
```

If more than one phone is connected:

```bash
./scripts/android.sh install PHONE_SERIAL
```

## Test BLE With Two Phones

Use this APK on both phones. The separate tinySSB Kanban app is a reference and
does not use the same BLE format.

1. Install the same APK on both phones.
2. Enable Bluetooth on both phones.
3. Keep Tremola open on both phones.
4. Open Collaboration Board on both phones.
5. Wait until the board shows a nearby peer.
6. Draw on phone A and check phone B.
7. Add text on phone B and check phone A.
8. Move, resize, and recolor phone A's object on phone B.
9. Disconnect the phones, edit both, reconnect, and check recovery.
10. Test **Clear**. It removes the complete shared board.

If no peer appears:

- Keep Tremola open and both screens unlocked.
- On Android 7-11, also turn on the phone's Location setting.
- Turn Bluetooth off and on once. If both phones show **advertising unsupported**,
  use a phone pair with BLE advertising support.

Show live BLE logs with:

```bash
./scripts/android.sh logs PHONE_SERIAL
```

## Install Problems

If Android reports an incompatible update, another Tremola APK was signed with
a different key. Back up important Tremola data, uninstall the old build, and
install this APK again.

The expected SHA-256 hash is stored in `SHA256SUMS`.
