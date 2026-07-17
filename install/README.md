# Install On Android

The repository contains two current version 1.0 APKs and no old test builds:

- [`tinyssb/whiteboard.apk`](tinyssb/whiteboard.apk) - main tinySSB submission
- [`tremola/whiteboard.apk`](tremola/whiteboard.apk) - Tremola comparison

Install the same variant on every phone taking part in one test. The variants
use different Android packages and can be installed next to each other, but
they do not synchronize with each other.

## Requirements

| Version | Minimum Android | Access | Board limit |
| --- | --- | --- | --- |
| Tremola | Android 7.0 / API 24 | Six-digit shared board code | Four stable feed identities |
| tinySSB | Android 8.0 / API 26 | Signed invite to a verified contact | Eight invitees, creator plus three editors |

Both versions need Bluetooth Low Energy. Keep the phones close, unlocked, and
inside the app during the final test. Android 7-11 also needs Location
permission and may require the Location setting to be on. Android 12 and newer
ask for Nearby devices permissions.

## Direct Install

1. Download the correct `whiteboard.apk` from one of the folders above.
2. Open the APK on the Android phone.
3. Allow installation from this source if Android asks.
4. Install and open the app.
5. Allow the requested Bluetooth, Nearby devices, and Location permissions.

If Android reports an incompatible update, a build signed with another key is
already installed. Back up important local data, uninstall that old build, and
install the current APK again.

## Tremola Workflow

1. Open **MiniApps > Collaboration Board**.
2. Enter your display name and a board name.
3. Tap **Create board**.
4. Tap **Code** to copy the generated six-digit board code.
5. On another phone, enter a display name and the same code under **Join**.
6. Use **Draw**, **Text**, **Edit**, the color picker, **Delete**, **Clear all**,
   **View**, **Dark**, or **Export**.
7. Tap **Boards** to close the board without deleting its saved local copy.

The roster stores at most four distinct Tremola feed identities. A display name
is only a label, so renaming the same phone does not consume another place. A
fifth identity is rejected even if one of the existing four is currently
offline. Every accepted member may edit every object.

The creator does not need to remain online after the code has been shared. Each
member stores its own operation log. The board survives closing or restarting
the app on that phone.

## tinySSB Workflow

1. Add and verify the other people in tinySSB Contacts.
2. Open **Productivity > Collaboration Board (dpi26.15)**.
3. Enter a display name and create a board.
4. Open the board and tap `+`.
5. Invite a verified contact.
6. The receiver enters a whiteboard name and accepts or declines the popup.
7. Use **Invitations** to see Waiting, Accepted, Declined, or Board full.
8. After acceptance, open the board from the saved board list.

The creator may invite up to eight different verified contacts. This is an
invitation capacity, not an eight-person editor limit. The final editor list is
the creator plus the first three valid acceptances, for four editors total.
Later acceptances cannot edit that board. Only the creator sends invitations,
and one contact can be invited again after 30 seconds.

The signed invitation carries the exact random board ID. The six-digit code can
select an invitation that has already arrived on a phone, but the code alone
cannot discover a tinySSB board.

## Board Controls

- **Draw:** hold one finger down to draw. One stroke event is created when the
  finger is released.
- **Text:** type, press the Android keyboard **Go** button, then tap the board.
- **Edit:** select an object, move it, resize it, recolor it, or delete it.
- **Two fingers:** pan or zoom without creating an object.
- **View:** open a full-screen read-only canvas with pan and pinch zoom.
- **Dark:** change only this phone's canvas background.
- **Clear all:** create one shared clear event immediately. There is no prompt
  and no undo.
- **Export:** save only the finite canvas. JPEG follows the local Dark setting;
  PDF always uses a white background.

The logical canvas is 1800 x 2400 units. Positions therefore stay consistent
across phones with different screen sizes.

## USB Install

Enable USB debugging, connect the phone, and run from the repository root:

```bash
./scripts/android.sh devices
./scripts/android.sh install PHONE_SERIAL
```

The helper installs [`tremola/whiteboard.apk`](tremola/whiteboard.apk). To use
`adb` directly for tinySSB, run:

```bash
adb install -r install/tinyssb/whiteboard.apk
```

## Two-Phone BLE Test

1. Install the same APK variant on both phones.
2. Turn off Wi-Fi and mobile data so the test measures BLE only.
3. Turn on Bluetooth. On Android 7-11, also turn on Location.
4. Keep both apps in the foreground and both screens unlocked.
5. Create and join one Tremola board, or create and accept one tinySSB invite.
6. Wait until board loading finishes.
7. Draw a long stroke from phone A and confirm it appears on B.
8. Add text from B and confirm it appears on A.
9. Move, resize, recolor, and delete objects in both directions.
10. Tap **Clear all** and confirm both boards become empty.
11. Turn Bluetooth off. Create different edits on both phones.
12. Turn Bluetooth on and wait until both boards converge.
13. Close and reopen the apps and confirm the saved current state returns.
14. Export one JPEG and one PDF and open both files.

Repeat the Tremola test with third and fourth identities when possible. A fifth
identity must be rejected. For tinySSB, verify that eight contacts can be
invited but only four identities become editors.

## Logs

Connect a Tremola phone by USB and run:

```bash
./scripts/android.sh logs PHONE_SERIAL
```

Useful successful log messages contain `board op`, `attempt=`, `accepted`, and
a queue that returns to zero.

## Checksums

[`SHA256SUMS`](SHA256SUMS) contains the hashes of exactly the two current APKs.
From this folder, verify them with:

```bash
shasum -a 256 -c SHA256SUMS
```

## More Documentation

- [`../docs/TREMOLA_VERSION.md`](../docs/TREMOLA_VERSION.md) - detailed Tremola guide
- [`../docs/TINYSSB_VERSION.md`](../docs/TINYSSB_VERSION.md) - detailed tinySSB guide
- [`../docs/SYNC_AND_MERGE.md`](../docs/SYNC_AND_MERGE.md) - event, BLE, recovery, and merge walkthrough
- [`../docs/TECHNICAL_OVERVIEW.md`](../docs/TECHNICAL_OVERVIEW.md) - complete architecture

tinySSB invitations restrict the whiteboard UI, but public `WBD` feed events are
not encrypted. Use the tinySSB APK as the main submission build and keep the
Tremola APK as a comparison.
