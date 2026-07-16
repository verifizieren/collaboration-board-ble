# tinySSB version

- Based on official `ssbc/tinyssb` commit `39896b72`.
- The board is listed under Productivity.
- Whiteboard events use the tinySSB `WBD` app type.
- tinySSB retries missing packets and chunks over BLE.
- The 6-digit code selects a board. It is not encryption.
- The four-member label is not a hard tinySSB access limit.
- The Tremola APK is the private four-person version.

Build with:

```sh
./scripts/build-tinyssb.sh
```

The script applies `integration.patch`, adds the shared board files, and writes
`install/tinyssb-collaboration-board-debug.apk`.
