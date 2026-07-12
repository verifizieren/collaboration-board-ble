# Install

Install this APK on an Android phone:

```text
tremola-collaboration-board-debug.apk
```

The phone needs Android 7.0 or newer.

## Easy Install

1. Download the APK to the phone.
2. Open the APK on the phone.
3. Allow installation from this source if Android asks.
4. Install the app.
5. Open Tremola.
6. Open the mini-apps view.
7. Open Collaboration Board.

## Install With USB

Connect the phone with USB and run:

```bash
adb install -r install/tremola-collaboration-board-debug.apk
```

## BLE Sync Test

Use two Android phones.

On both phones:

- install the same APK
- enable Bluetooth
- enable location
- allow the app permissions
- open Collaboration Board
- keep the app open

Then draw on one phone and check if it appears on the other phone.
