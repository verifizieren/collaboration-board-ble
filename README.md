# Collaboration Board

A shared whiteboard mini-app inside Tremola for Android.

## Features

- Draw and add text.
- Move, resize, recolor, and delete objects.
- Clear the full board.
- Use one fixed board that scales to the phone screen.
- Keep the board after closing the app.
- Work offline and catch up later.
- Sync nearby phones over Bluetooth Low Energy.
- Use invite-only boards with up to four members.
- Show the creator name when an object is selected.

Every admitted member can edit every object.

## Android APK

The ready test build is here:

[`install/tremola-collaboration-board-debug.apk`](install/tremola-collaboration-board-debug.apk)

The APK contains the full Tremola app, the mini-app, local storage, and native
BLE sync. It is not a separate whiteboard app.

Requirements:

- Android 7.0 or newer
- Bluetooth Low Energy
- BLE advertising support on at least one phone in each connection
- two real Android phones for the final BLE test

See [`install/README.md`](install/README.md) for the install and test steps.

## Phone Workflow

1. Install and open Tremola.
2. Allow Bluetooth and location access when Android asks.
3. Open **MiniApps > Collaboration Board**.
4. Enter a name.
5. Create a board or paste an invite code.
6. Use **Draw**, **Text**, **Edit**, the color picker, **Delete**, or **Clear all**.

The board owner must be nearby the first time a new member joins. After that,
the member keeps a signed admission and can reconnect through any admitted
member. A board has one owner and at most three other members.

Keep the invite code private. It contains the board key.

## Reliable Sync

A finished action is saved before it is sent. BLE sends frames one at a time
and waits for Android's callback. The receiver acknowledges the complete board
operation. Missing operations are requested again with board frontiers and
WANT ranges.

- operation retry: about every 2 seconds while connected
- frontier check: about every 5 seconds
- no pointer movement is sent while a finger is still moving
- only operations for the active board use the board sync queue

## Check And Build

Requirements:

- JDK 11
- Android SDK
- Node.js

Run:

```bash
./scripts/check.sh
```

This runs JavaScript tests, Kotlin tests, Android lint, the APK build, APK
checks, and Android instrumentation tests when a phone or emulator is attached.
It then updates the APK in `install/`.

With USB debugging enabled:

```bash
./scripts/android.sh devices
./scripts/android.sh install PHONE_SERIAL
./scripts/android.sh logs PHONE_SERIAL
```

## Browser Preview

Run:

```bash
./start.sh
```

The browser preview checks the UI and merge behavior. It does not test native
Android BLE, invitations, encryption, or Android permissions.

## Project Files

- `miniApps/collabboard/` - mini-app source
- `app/` - full Tremola Android app and native BLE code
- `install/` - ready APK, checksum, and install steps
- `scripts/` - build, install, and log commands
- `docs/TECHNICAL_OVERVIEW.md` - technical design
- `docs/REPORT_BASIS.md` - simple basis for the group report

## Submission

Submit the full repository and the APK in `install/`. The mini-app folder alone
does not include Android storage, identities, admissions, encryption, or BLE.

The remaining acceptance test is a real two-phone BLE run with Wi-Fi and mobile
data turned off.
