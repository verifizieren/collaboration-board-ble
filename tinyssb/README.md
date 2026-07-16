# tinySSB version

- Based on official `ssbc/tinyssb` commit `39896b72`.
- Version `0.4` (`versionCode 4`).
- The board is listed under Productivity.
- Authors: Dehlen Thavarajah, Max Mendes Carvalho, Frédéric Weyssow, Simon Zeugin.
- Whiteboard events use the tinySSB `WBD` app type.
- tinySSB retries missing packets and chunks over BLE.
- The build fixes tinySSB's first-start BLE permission callback.
- The 6-digit code selects a board. It is not encryption.
- The four-member label is not a hard tinySSB access limit.
- The Tremola APK is the private four-person version.

On first start, allow Nearby devices and Location. Keep Bluetooth and Location
enabled, and keep both apps open during a BLE test. Some gray apps in the
official tinySSB Productivity and Games lists are disabled demo placeholders.

Build with:

```sh
./scripts/build-tinyssb.sh
```

The script applies `integration.patch` and `ble-startup.patch`, adds the shared
board files, and writes
`install/tinyssb-collaboration-board-debug.apk` and
`install/tinyssb/whiteboard.apk`.
