# Collaboration Board

A shared whiteboard mini-app inside Tremola for Android.

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
- Join a board with its six-digit code, with up to four members.
- Show the author's current name when an object is selected.
- Open saved boards from the Boards screen and briefly resume the current board
  when returning from Tremola.
- Show the merged current state after joining, without replaying old steps on
  the visible canvas.

Every member can edit every object.

## Android APKs

The repository keeps only the two current version 1.0 APKs:

- [`install/tremola/whiteboard.apk`](install/tremola/whiteboard.apk) - Tremola version
- [`install/tinyssb/whiteboard.apk`](install/tinyssb/whiteboard.apk) - tinySSB version

They use different Android packages and can be installed next to each other.
Use the same variant on every phone in one sync test. Tremola and tinySSB boards
do not synchronize with each other.

Requirements:

- Android 7.0 or newer
- Bluetooth Low Energy
- BLE advertising support on at least one phone in each connection
- two real Android phones for the final BLE test

The tinySSB APK needs Android 8.0 or newer.

See [`install/README.md`](install/README.md) for the install and test steps.

Detailed guides:

- [`docs/TREMOLA_VERSION.md`](docs/TREMOLA_VERSION.md) - Tremola workflow and implementation
- [`docs/TINYSSB_VERSION.md`](docs/TINYSSB_VERSION.md) - tinySSB workflow and invitations
- [`docs/SYNC_AND_MERGE.md`](docs/SYNC_AND_MERGE.md) - strokes, events, BLE delivery, recovery, and merge rules
- [`docs/REPOSITORY_STRUCTURE.md`](docs/REPOSITORY_STRUCTURE.md) - required files, builds, and possible upstream integration

## Phone Workflow

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

In the tinySSB APK, open **Productivity > Collaboration Board (dpi26.15)**. Add and verify
contacts first. Create a board, open it, and use `+` to invite a contact. The
other phone shows an Accept/Decline popup. The top-right **Invitations** screen
also shows received invites and the sender's Waiting, Accepted, or Declined
status. The signed invitation
contains the exact random board ID, so a six-digit code cannot open a different
board. After that invitation arrives, the Join form can also select it by its
six-digit code. The creator and the first three contacts who accept can edit.
Up to eight contacts may be invited. A repeat invite to the same contact is
allowed after 30 seconds. tinySSB `WBD` events are public and not encrypted.

Both variants export only the finite canvas. JPEG follows the local dark canvas;
PDF always uses a white background. **Clear all** is immediate and has no undo.

Changing the display name does not create another member. The Tremola feed ID
stays the same. Deleting a board removes only its copy on that phone.

## Sync

A finished action is applied and stored immediately. The live build sends it
immediately and retries missing acknowledgements. Every five seconds, peers
also compare frontiers and request anything missing. The full canvas image is
never transmitted.

- no pointer movement is sent while a finger is still moving
- only operations for the active board use the board sync queue

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
- `docs/TREMOLA_VERSION.md` - main app guide
- `docs/TINYSSB_VERSION.md` - alternative app guide
- `docs/SYNC_AND_MERGE.md` - detailed protocol and merge guide
- `docs/REPOSITORY_STRUCTURE.md` - what is required for both APKs and upstream integration
- `docs/Collaboration_Board_Report_Guide.docx` - Word notes for the report team

## Submission

Submit the full repository and the selected APK in `install/`. The mini-app
folder alone does not include Android storage, identities, or BLE.

The remaining acceptance test is a real two-phone BLE run with Wi-Fi and mobile
data turned off.
