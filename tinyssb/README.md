# tinySSB version

- Based on official `ssbc/tinyssb` commit `39896b72`.
- Version `0.6` (`versionCode 6`).
- The board is listed under Productivity.
- Authors: Dehlen Thavarajah, Max Mendes Carvalho, Frédéric Weyssow, Simon Zeugin.
- Whiteboard events use the tinySSB `WBD` app type.
- Complete whiteboard events are shown as soon as tinySSB receives them.
- tinySSB retries missing packets and chunks over BLE.
- The build fixes tinySSB's first-start BLE permission callback.
- The board creator can invite up to eight verified contacts.
- The creator and the first three contacts who accept can edit the board.
- A name is only a label. The signed tinySSB feed ID is the identity.
- A signed invitation carries the exact random board ID. Its code can select
  that received invitation, but cannot create or discover a board.
- Export saves the canvas as JPEG or PDF through Android's file picker.
- Invitations limit the app UI. Public tinySSB events are not encrypted.

## Test

1. Install the same APK on all phones.
2. Allow Nearby devices and Location.
3. Add and verify each contact in tinySSB.
4. Open Productivity > Collaboration Board.
5. Tap `+`, choose contacts, and create a board. Use Invite to add contacts later.
6. On the other phone, open the top-right menu > Invitations and accept. The
   Join form can also select an invitation after it arrives.
7. Test draw, text, move, resize, clear, and Export.
8. Keep Bluetooth and Location on and both apps open while testing.

Sync can take a little time. This is also normal in the other tinySSB apps.

Build with:

```sh
./scripts/build-tinyssb.sh
```

The script applies `integration.patch`, `ble-startup.patch`, and
`whiteboard-export.patch`, adds the shared board files, and writes
`install/tinyssb-collaboration-board-debug.apk` and
`install/tinyssb/whiteboard.apk`.
