# Collaboration Board

A shared Android whiteboard mini-app. The main submission runs inside the
official tinySSB Android host. A separate Tremola Android build is included for
comparison.

## Features

- Draw and add text.
- Move, resize, recolor, and delete objects.
- Clear the full board.
- Export the canvas as JPEG or PDF.
- Use a large finite board that scales to the phone screen.
- Name boards and reopen them from a saved-board list.
- Distinguish equal board names with eight local label colors.
- Delete a local board copy with its six-digit code.
- Use a full-screen view with pan and pinch zoom.
- Switch the canvas to a local dark view.
- Keep board data and membership after closing the board or app.
- Work offline and catch up later.
- Sync nearby phones over Bluetooth Low Energy.
- Join through a signed invitation in tinySSB, with up to four editors.
- Show the author's current name when an object is selected.
- Open saved boards from the Boards screen and briefly resume the current board
  when returning to the mini-app.
- Show the merged current state after joining, without replaying old steps on
  the visible canvas.

Every member can edit every object.

## Android APKs

The repository keeps only the two current version 1.0 APKs:

- [`install/tinyssb/whiteboard.apk`](install/tinyssb/whiteboard.apk) - main tinySSB submission
- [`install/tremola/whiteboard.apk`](install/tremola/whiteboard.apk) - Tremola comparison

They use different Android packages and can be installed next to each other.
Use the same variant on every phone in one sync test. Tremola and tinySSB boards
do not synchronize with each other.

Requirements:

- tinySSB: Android 8.0 or newer
- Tremola: Android 7.0 or newer
- Bluetooth Low Energy
- BLE advertising support on at least one phone in each connection
- two real Android phones for the final BLE test

See [`install/README.md`](install/README.md) for the install and test steps.

Detailed guides:

- [`docs/TINYSSB_VERSION.md`](docs/TINYSSB_VERSION.md) - main tinySSB workflow and invitations
- [`docs/TREMOLA_VERSION.md`](docs/TREMOLA_VERSION.md) - Tremola comparison workflow
- [`docs/SYNC_AND_MERGE.md`](docs/SYNC_AND_MERGE.md) - strokes, events, BLE delivery, recovery, and merge rules
- [`docs/REPOSITORY_STRUCTURE.md`](docs/REPOSITORY_STRUCTURE.md) - required files, builds, and possible upstream integration

## Main tinySSB Workflow

1. Install the tinySSB APK and allow the requested permissions.
2. Add and verify the other people in **Contacts**.
3. Open **Productivity > Collaboration Board (dpi26.15)**.
4. Enter a display name and create a board.
5. Open the board, tap `+`, and invite a verified contact.
6. The other phone accepts or declines the invitation.
7. Accepted editors open the board from the saved-board list.
8. Keep both phones unlocked and inside tinySSB while BLE synchronizes.

The creator may invite up to eight contacts. The creator and the first three
valid acceptances are the four editors. The signed invitation contains the
random board ID. A six-digit code can select an invitation already received on
that phone, but cannot discover an unknown tinySSB board. Public `WBD` events
are signed but not encrypted.

## Tremola Comparison Workflow

1. Install and open Tremola.
2. Allow Bluetooth and location access when Android asks.
3. Open **MiniApps > Collaboration Board**.
4. Enter a name.
5. Enter a board name and create the board.
6. The app shows a new six-digit code. Share it with the other members.
7. Other members use **Join** and enter the code.
8. Use **Draw**, **Text**, **Edit**, the color picker, **Delete**, **Clear all**, or **Export**.
9. Press the keyboard **Go** button before placing text. Use two fingers to
   move or zoom while **Draw** or **Text** is active.
10. Use **View** to pan and pinch zoom. **Dark** changes only this phone.
11. Tap **Boards** to close it without deleting it. Tap **Open** to return later.

The first visible area matches the original board size. Use two fingers to move
into the larger drawing area. More than three saved boards scroll inside the
board list.

Extra spaces do not create a new board name. Up to eight boards may share one
name; their names and invite codes use different colors on this phone.

The six-digit code directly selects the board. No owner has to stay nearby for
joining. Anyone with the code can open the board until the four-member limit is
reached. Treat the code like a simple shared password.

The top-right **Invitations** screen in tinySSB shows Waiting, Accepted,
Declined, or Board full. A repeat invitation to the same contact is allowed
after 30 seconds.

Both variants export only the finite canvas. JPEG follows the local dark canvas;
PDF always uses a white background. **Clear all** is immediate and has no undo.

Changing the display name does not create another member. The Tremola feed ID
stays the same. Deleting a board removes only its copy on that phone.

## Sync

A finished action becomes one event. The full canvas image is never
transmitted. In tinySSB, the event is appended to the author's signed feed. The
official host exchanges 120-byte packets and requests missing feed entries and
chunks during later replication rounds. In Tremola, the board-specific
transport sends an operation immediately, waits for an acknowledgement, and
also compares per-author frontiers about every five seconds.

- no pointer movement is sent while a finger is still moving
- in Tremola, only operations for the active board use the board sync queue

See [`docs/SYNC_AND_MERGE.md`](docs/SYNC_AND_MERGE.md) for the complete path
from one sampled stroke to deterministic replay on another phone.

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
- `tinyssb/` - pinned patch, adapter, icon, theme, and tinySSB build notes
- `docs/TECHNICAL_OVERVIEW.md` - technical design
- `docs/REPORT_BASIS.md` - short basis for the group report
- `docs/TINYSSB_VERSION.md` - main app guide
- `docs/TREMOLA_VERSION.md` - comparison app guide
- `docs/SYNC_AND_MERGE.md` - detailed protocol and merge guide
- `docs/REPOSITORY_STRUCTURE.md` - what is required for both APKs and upstream integration

## Submission

Submit the full repository and `install/tinyssb/whiteboard.apk` as the main APK.
Keep `install/tremola/whiteboard.apk` as the documented comparison build. The
mini-app folder alone does not include Android storage, identities, or BLE.

Before submission, repeat the real two-phone BLE test with Wi-Fi and mobile data
turned off and record the Android versions and observed delay. A four-phone run
is useful if four devices are available, but the four-editor rule is also
covered by automated tests.
