# Install On Android

Current batch test build: **0.5.0-5s** (`versionCode 18`).

Install the same variant on every test phone:

- [`whiteboard5sek.apk`](whiteboard5sek.apk) - 5-second batch experiment
- [`whiteboardlive.apk`](whiteboardlive.apk) - immediate-send reference

The APKs contain the full Tremola app, Collaboration Board, local storage, and
native BLE sync. They need Android 7.0 or newer. Both use the same package and
cannot be installed side by side.

## Direct Install

1. Send the APK to the phone.
2. Open the APK.
3. Allow installation from this source if Android asks.
4. Install and open Tremola.
5. Allow Bluetooth and location access.
6. Open **MiniApps > Collaboration Board**.

Tremola creates a cryptographic identity automatically. There is no server
account or central login.

## Create A Board

1. Enter your name.
2. Tap **Create board**.
3. Tap **Invite**.
4. Send the copied code privately to the other members.
5. Keep the owner's phone nearby while each new member joins for the first time.

## Join A Board

1. Enter your name.
2. Paste the invite code.
3. Tap **Join board**.
4. Wait for **Looking nearby**, **1 nearby**, or **Syncing**.

The board allows one owner and three other identities. After first admission,
a member can reconnect through another admitted member. Closing the app keeps
the board. **Leave** removes the local room setup, so keep the invite code if
you may need it again.

## USB Install

Enable USB debugging, connect the phone, and run from the repo folder:

```bash
./scripts/android.sh devices
./scripts/android.sh install PHONE_SERIAL
```

## Two-Phone BLE Test

Use the same APK on both phones. For the batch experiment, use
`whiteboard5sek.apk` and allow up to 10 seconds for an update and its BLE
transfer.

1. Turn off Wi-Fi and mobile data on both phones.
2. Turn on Bluetooth. On Android 7-11, also turn on Location.
3. Keep Tremola open and both screens unlocked.
4. Create a new board on phone A.
5. Join from phone B while phone A is nearby.
6. Wait until each phone shows one nearby peer.
7. Draw a long stroke on A and check B.
8. Add text on B and check A.
9. Move, resize, recolor, and delete the other member's object.
10. Use **Clear all** and check both phones.
11. Turn Bluetooth off on B. Edit on both phones. Turn Bluetooth on again.
12. Wait for both boards to converge.
13. Close and reopen Tremola. Confirm the board is still present.

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

The expected hashes for both variants are stored in `SHA256SUMS`.
