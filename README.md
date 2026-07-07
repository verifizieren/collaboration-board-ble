# Collaboration Board

A simple whiteboard for Tremola.

You can:

- draw
- add text
- clear the board
- share changes with nearby phones over BLE

This project was inspired by the
[tinySSB Android app](https://github.com/tinySSB/android-app).

## What This App Is

This is not a separate whiteboard app.

It is a Tremola Android app with the whiteboard included.

So the final APK is:

- Tremola
- plus the Collaboration Board mini-app
- plus BLE sync

You install this APK on the phone.

Then the whiteboard is opened from inside Tremola.

For submission, include the whole branch.

Do not submit only the whiteboard folder.

The Android code is needed because BLE sync is inside the Android app.

## Android Setup

Use Android for the real test.

You need:

- Android Studio
- Android SDK
- JDK 11
- one Android phone for normal testing
- two Android phones for BLE testing

Use JDK 11. Newer Java versions can break the Android build.

On this Mac, JDK 11 is here:

```text
/opt/homebrew/opt/openjdk@11/libexec/openjdk.jdk/Contents/Home
```

## Build

Run this from the repo folder:

```bash
JAVA_HOME=/opt/homebrew/opt/openjdk@11/libexec/openjdk.jdk/Contents/Home \
ANDROID_HOME=$HOME/Library/Android/sdk \
ANDROID_SDK_ROOT=$HOME/Library/Android/sdk \
./gradlew assembleDebug
```

The APK will be here:

```text
app/build/outputs/apk/debug/app-debug.apk
```

## Install On Phone

Connect your phone with USB.

Enable USB debugging.

Then run:

```bash
$HOME/Library/Android/sdk/platform-tools/adb install -r \
  app/build/outputs/apk/debug/app-debug.apk
```

## Open The Board

On the phone:

1. Open Tremola.
2. Allow Bluetooth and location.
3. Tap the mini-apps button.
4. Tap Collaboration Board.
5. Draw, add text, or clear the board.

## Test BLE Sync

Use two Android phones.

On both phones:

- install the same APK
- enable Bluetooth
- enable location
- open Tremola
- open Collaboration Board
- keep the app open

Then test:

1. Draw on phone A.
2. Check if it appears on phone B.
3. Draw on phone B.
4. Check if it appears on phone A.
5. Try editing while phones are apart.
6. Bring phones close again.
7. Check if changes sync.

Useful log command:

```bash
adb logcat -s BleSync FrontendRequest CMD
```

## Browser Preview

Use this only for quick UI testing.

It does not test Android or real BLE.

Run:

```bash
./start.sh
```

Or:

```bash
python3 -m http.server 8000
```

Then open:

```text
http://localhost:8000
```

Open Alice and Bob in two browser tabs.

Then:

1. Tap mini-apps.
2. Open Collaboration Board.
3. Draw in one tab.
4. Check the other tab.

## How Sync Works

The board does not send every finger movement.

It sends finished actions:

- one stroke
- one text label
- one clear action

Tremola saves these actions.

Other phones receive them and rebuild the same board.

BLE sends missing actions between nearby phones.

## Project Files

- `app/` - Android app
- `app/src/main/assets/web/` - web files inside the Android app
- `miniApps/collabboard/` - whiteboard mini-app
- `src/` - browser preview code
- `doc/20250327-miniApps.md` - notes

## Current Status

- Android APK builds with JDK 11.
- The board is inside Tremola.
- Browser preview works.
- Mobile layout fits phone screens.
- Real BLE sync still needs two-phone testing.

## Important Notes

- Use JDK 11.
- Use real phones for BLE.
- Keep the app open while testing BLE.
- Emulator is okay for layout, but not for the BLE test.
