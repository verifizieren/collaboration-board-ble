# Collaboration Board

A shared whiteboard mini-app inside Tremola for Android.

## Features

- Draw and add text.
- Move, resize, recolor, and delete objects.
- Clear the full board.
- Use one fixed board that scales to the phone screen.
- Name boards and reopen them from a saved-board list.
- Keep board data and membership after closing the board or app.
- Work offline and catch up later.
- Sync nearby phones over Bluetooth Low Energy.
- Use invite-only boards with up to four members.
- Show the creator name when an object is selected.

Every admitted member can edit every object.

## Android APKs

The install folder contains three APK files:

- [`install/tremola-collaboration-board-debug.apk`](install/tremola-collaboration-board-debug.apk)
  is the current live-sync build.
- [`install/whiteboardlive.apk`](install/whiteboardlive.apk) is the same current
  live-sync build.
- [`install/whiteboard5sek.apk`](install/whiteboard5sek.apk) saves locally and
  exchanges new operations in 5-second batches. It is kept as an experiment.

All APKs contain the full Tremola app, the mini-app, local storage, and native
BLE sync. They use the same Android package, so install only one variant at a
time and use the same variant on every test phone.

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
5. Enter a board name and six-digit code, then create the board.
6. Other members use **Join** and enter the same code.
7. Use **Draw**, **Text**, **Edit**, the color picker, **Delete**, or **Clear all**.
8. Tap **Boards** to close it without deleting it. Tap **Open** to return later.

The board owner must be nearby the first time a new member joins. After that,
the member keeps a signed admission and can reconnect through any admitted
member. A board has one owner and at most three other members.

The owner chooses the six-digit code. It stays open for 10 minutes. The real
256-bit board key is created separately and sent only through encrypted BLE
pairing.

## Sync

A finished action is applied and stored immediately. The live build sends it
immediately and retries missing acknowledgements. Every five seconds, peers
also compare frontiers and request anything missing. The full canvas image is
never transmitted.

- no pointer movement is sent while a finger is still moving
- only operations for the active board use the board sync queue
- the 5-second APK uses the same recovery protocol but batches new actions

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
