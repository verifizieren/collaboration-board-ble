# Install On Android

Current Tremola build: **1.0** (`versionCode 29`).
Current tinySSB build: **1.0** (`versionCode 9`).

Both main downloads use the same simple file name in separate folders:

- [`tremola/whiteboard.apk`](tremola/whiteboard.apk) - Tremola
- [`tinyssb/whiteboard.apk`](tinyssb/whiteboard.apk) - tinySSB

For tinySSB, allow **Nearby devices** and **Location** on first start. Keep
Bluetooth and Location enabled and leave both phones inside the app while
testing. Its gray app entries are disabled upstream demos; use Collaboration
Board or Kanban for a sync test.

Install the same variant on every test phone:

- [`tremola-collaboration-board-debug.apk`](tremola-collaboration-board-debug.apk) - current live build
- [`whiteboardlive.apk`](whiteboardlive.apk) - same current live build
- [`whiteboard5sek.apk`](whiteboard5sek.apk) - older 5-second experiment
- [`tinyssb-collaboration-board-debug.apk`](tinyssb-collaboration-board-debug.apk)
  - separate tinySSB version under **Productivity**

The Tremola APKs need Android 7.0 or newer and share one package. The tinySSB
APK needs Android 8.0 or newer and uses another package, so it can be installed
next to Tremola.

## Direct Install

1. Send the APK to the phone.
2. Open the APK.
3. Allow installation from this source if Android asks.
4. Install and open Tremola.
5. Allow Bluetooth and location access.
6. In Tremola, open **MiniApps > Collaboration Board**.

In the tinySSB APK, open **Productivity > Collaboration Board (dpi26.15)**.

Tremola creates a cryptographic identity automatically. There is no server
account or central login.

## Tremola: Create A Board

1. Enter your name.
2. Enter a board name.
3. Tap **Create board**.
4. The app shows a new six-digit code.
5. Tap **Invite** and send the copied code privately.

## Tremola: Join A Board

1. Enter your name.
2. Enter the six-digit code.
3. Tap **Join board**.

The code opens the same board directly. The creator does not have to be nearby.
Anyone with the code can join until the board has four identities. After
joining once, tap **Boards** to close the board without deleting it. Tap
**Open** in the board list to return without entering the code again.

## tinySSB: Invite And Join

1. Add and verify the contacts on both phones.
2. Open **Productivity > Collaboration Board (dpi26.15)**.
3. Create and open a board.
4. Tap `+` and invite a verified contact.
5. On the other phone, enter a display name in the popup and tap **Accept**.
   The top-right **Invitations** menu keeps the invite and sender status.
6. The creator and the first three contacts who accept can edit.

The tinySSB version joins only through a signed invitation. Its six-digit code
can select a received invitation, but it cannot create or discover a board by
itself. A repeat invite to one contact is available after 30 seconds.

In both variants, **Export** saves only the canvas as JPEG or PDF. JPEG follows
the local dark canvas; PDF is white. **Clear all** takes effect immediately and
has no undo.

Returning from the Tremola MiniApps screen within 30 seconds reopens the active
board. Returning later, or starting Tremola again, opens the Boards screen.
Only three saved board rows are shown at once; scroll that list for more.
Boards with the same name get different local name and code colors. Leading or
trailing spaces do not make a different name. One name can be used eight times.

In **Text**, write the text and press the Android keyboard **Go** button. The
keyboard closes but **Text** stays active. Tap the board to place it. The new
text is selected so it can be moved or resized. In **Draw** and **Text**, use
two fingers to move or zoom the board without creating an object.

The drawing area is finite but larger than the first phone view. There is no
visible page border. Use two fingers to reach the rest of the board.

Use **View** for a full-screen read-only board. Drag to move the view and pinch
to zoom. **Dark** changes only the canvas on the current phone. It does not
change shared board data.

To remove a saved board from one phone, tap **Delete** in the board list and
enter its six-digit code. This does not delete another member's copy.

Each phone stores its own copy. The board survives when everyone closes it. It
is lost on a phone only if the app is uninstalled or its app data is cleared.

## USB Install

Enable USB debugging, connect the phone, and run from the repo folder:

```bash
./scripts/android.sh devices
./scripts/android.sh install PHONE_SERIAL
```

## Two-Phone BLE Test

Use `tremola-collaboration-board-debug.apk` on both phones.

1. Turn off Wi-Fi and mobile data on both phones.
2. Turn on Bluetooth. On Android 7-11, also turn on Location.
3. Keep Tremola open and both screens unlocked.
4. Create a new board on phone A.
5. Join from phone B with the same code.
6. Wait until each phone shows one nearby peer.
7. Wait for **Loading board...** to disappear. Only the merged current state
   should appear.
8. Draw a long stroke on A and check B.
9. Add text on B and check A.
10. Move, resize, recolor, and delete the other member's object.
11. Use **Clear all** and check both phones.
12. Export one JPEG and one PDF and open both files.
13. Turn Bluetooth off on B. Edit on both phones. Turn Bluetooth on again.
14. Wait for both boards to converge.
15. Tap **Boards**, reopen the named board, and confirm its content is present.
16. Close and reopen Tremola and check the Boards screen opens first.
17. Change your display name, reopen the board, and confirm the member count
    does not increase.
18. Test **View** on its first tap, pan, pinch zoom, **Dark**, and local board deletion.
19. Create two boards with the same name and confirm their labels use different colors.

Repeat with a third and fourth identity if available. A fifth identity must be
rejected as **Board is full**.

## Different Android Versions

- Android 7-11: grant location and keep the Location setting on.
- Android 12+: grant Nearby devices permissions.
- Use the same APK version on every phone.
- Some phones cannot advertise BLE. The app reports this. At least one phone in
  a pair must advertise so the other phone can discover it.
- App launch and protocol tests pass on Android 7, 15, and 16 emulators.
- Real BLE still needs two physical phones.

## Logs

Connect a phone by USB and run:

```bash
./scripts/android.sh logs PHONE_SERIAL
```

Useful successful log lines include `board op`, `attempt=`, `accepted`, and a
queue that returns to zero.

## Install Problems

If Android reports an incompatible update, another Tremola APK was signed with
a different key. Back up important Tremola data, uninstall the old build, and
install this APK again.

If no peer appears:

- keep the app in the foreground
- confirm all requested permissions
- turn Bluetooth off and on once
- move the phones close together
- create a fresh board if four member slots were already used

The expected hashes for all APK files are stored in `SHA256SUMS`.

## tinySSB Limit

Only verified contacts can see an invitation in the whiteboard UI. Public
tinySSB events are not encrypted, so this is an app access rule, not private
transport. Use the Tremola APK for the main submission.
