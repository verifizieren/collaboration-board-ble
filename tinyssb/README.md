# tinySSB version

- Based on official `ssbc/tinyssb` commit `39896b72`.
- Version `1.0` (`versionCode 9`).
- App name: Collaboration Board (dpi26.15).
- The board is listed under Productivity.
- Authors: Dehlen Thavarajah, Max Mendes Carvalho, Frédéric Weyssow, Simon Zeugin.
- Whiteboard events use the tinySSB `WBD` app type.
- Complete whiteboard events are shown as soon as tinySSB receives them.
- tinySSB retries missing packets and chunks over BLE.
- The build fixes tinySSB's first-start BLE permission callback.
- The board creator can invite up to eight verified contacts.
- The creator and the first three contacts who accept can edit the board.
- Accept and decline are signed events. The sender can see their status.
- The same contact can be invited again after 30 seconds.
- A name is only a label. The signed tinySSB feed ID is the identity.
- A signed invitation carries the exact random board ID. Its code can select
  that received invitation, but cannot create or discover a board.
- Export saves the canvas as JPEG or PDF through Android's file picker.
- Clear is immediate and has no undo.
- Invitations limit the app UI. Public tinySSB events are not encrypted.

## Test

1. Install the same APK on all phones.
2. Allow Nearby devices and Location.
3. Add and verify each contact in tinySSB.
4. Open Productivity > Collaboration Board (dpi26.15).
5. Create and open a board, then tap `+` and invite a verified contact.
6. The other phone shows an Accept/Decline popup. Invitations are also in the
   top-right menu. After accepting, the board stays in the board list.
7. Test draw, text, move, resize, clear, and Export.
8. Keep Bluetooth and Location on and both apps open while testing.

Sync can take a little time. This is also normal in the other tinySSB apps.

Build with:

```sh
./scripts/build-tinyssb.sh
```

The script applies `integration.patch`, `ble-startup.patch`, and
`whiteboard-export.patch`, adds the shared board files, and writes
`install/tinyssb/whiteboard.apk`.

See [`../docs/TINYSSB_VERSION.md`](../docs/TINYSSB_VERSION.md) for the full user
workflow and [`../docs/SYNC_AND_MERGE.md`](../docs/SYNC_AND_MERGE.md) for the
event and merge model.
