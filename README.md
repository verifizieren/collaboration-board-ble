# Collaboration Board

A shared whiteboard mini-app inside Tremola for Android.

## What It Can Do

- Draw and add text.
- Move and resize objects.
- Delete one selected object or clear the board.
- Choose any color with the Android color picker.
- Pan around the board.
- Use a simple layout that fits normal Android phone screens.
- Work without Internet.
- Sync signed Tremola events between nearby phones over BLE.

There is one shared board. Everyone can edit every object. There are no profiles
or owner locks.

## Android APK

The ready test build is here:

[`install/tremola-collaboration-board-debug.apk`](install/tremola-collaboration-board-debug.apk)

It contains the full Tremola app, the mini-app, and native BLE sync. It is not a
standalone whiteboard.

Requirements:

- Android 7.0 or newer
- Bluetooth Low Energy for nearby sync
- two Android phones for the final BLE test

See [`install/README.md`](install/README.md) for simple install steps.

## First Use

1. Install and open Tremola.
2. Allow Bluetooth and location access.
3. Open the mini-apps view.
4. Open **Collaboration Board**.
5. Use **Draw**, **Text**, **Edit**, the color picker, **Delete**, or **Clear all**.

**Draw** and **Text** stay active for repeated work. Use **Edit** and tap an
object to move, resize, recolor, or delete it.

Tremola creates a local cryptographic identity on first start. There is no
central account or server login.

## Check And Build

Requirements for building:

- JDK 11
- Android SDK
- Node.js

Run:

```bash
./scripts/check.sh
```

This checks the browser and Android copies, runs JavaScript and Kotlin tests,
runs Android lint, builds the APK, verifies its signature and contents, and
updates the file in `install/`.

## Test On Phones

With USB debugging enabled:

```bash
./scripts/android.sh devices
./scripts/android.sh install
./scripts/android.sh logs
```

For the real test, install the same APK on two phones and keep Tremola open on
both. A finished action is sent immediately. Feed frontiers
are also exchanged every 3 seconds so missed events can be recovered.

## Browser Preview

Run:

```bash
./start.sh
```

Open Alice and Bob, then open **MiniApps > Collaboration Board** in both tabs.
The browser checks the UI, offline replay, and collaboration rules. It does not
test native Android BLE.

## Project Files

- `miniApps/collabboard/` - board source
- `app/` - full Tremola Android app and BLE code
- `app/src/main/assets/web/` - web files included in the APK
- `install/` - APK and checksum
- `scripts/` - check, build, install, and log commands
- `docs/TECHNICAL_OVERVIEW.md` - technical design
- `docs/REPORT_BASIS.md` - simple basis for the project report

## Submission

Submit the full repository and the APK in `install/`. The mini-app folder alone
does not contain signed log storage or native BLE transport.

The remaining final check is a real two-phone BLE test.
