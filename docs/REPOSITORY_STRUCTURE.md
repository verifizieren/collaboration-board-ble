# Repository Structure And Integration

The repository contains two complete Android variants, their shared whiteboard,
tests, documentation, and reproducible build material. Only old duplicate APK
files were removed. No source needed by either current APK was removed.

## Current Deliverables

- [`../install/tremola/whiteboard.apk`](../install/tremola/whiteboard.apk) - full Tremola app with Collaboration Board
- [`../install/tinyssb/whiteboard.apk`](../install/tinyssb/whiteboard.apk) - official tinySSB host with Collaboration Board

These APKs use different Android packages and different network logs. They are
two alternatives, not two peers of one board.

## Shared Whiteboard Files

- [`../miniApps/collabboard`](../miniApps/collabboard) contains the main HTML,
  CSS, JavaScript reducer, icon, and manifest.
- [`../tests/collabboard.test.js`](../tests/collabboard.test.js) checks the shared
  board behavior.
- [`../app/src/main/assets/web/miniApps/collabboard`](../app/src/main/assets/web/miniApps/collabboard)
  is the bundled Tremola Android copy. `scripts/check.sh` verifies that it is
  identical to the main mini-app source.

Both Android variants need these shared files.

## Tremola-Specific Files

- [`../app`](../app) is the complete Android host used to build the main APK.
- [`../app/src/main/java/nz/scuttlebutt/tremola/WebAppInterface.kt`](../app/src/main/java/nz/scuttlebutt/tremola/WebAppInterface.kt)
  connects JavaScript to Android.
- [`../app/src/main/java/nz/scuttlebutt/tremola/ssb/peering/ble/BoardProtocol.kt`](../app/src/main/java/nz/scuttlebutt/tremola/ssb/peering/ble/BoardProtocol.kt)
  creates and verifies protected board operations.
- [`../app/src/main/java/nz/scuttlebutt/tremola/ssb/peering/ble/BleSync.kt`](../app/src/main/java/nz/scuttlebutt/tremola/ssb/peering/ble/BleSync.kt)
  contains discovery, framing, acknowledgements, retry, recovery, relay, and
  the four-member roster.
- [`../app/src/main/java/nz/scuttlebutt/tremola/ssb/db`](../app/src/main/java/nz/scuttlebutt/tremola/ssb/db)
  stores the board operation log.
- [`../gradle`](../gradle), [`../build.gradle`](../build.gradle),
  [`../settings.gradle`](../settings.gradle), and [`../gradlew`](../gradlew)
  are required to build the Android app.

Do not submit only `miniApps/collabboard`. That would omit persistence,
identity, BLE, Android permissions, export, and APK packaging.

## tinySSB-Specific Files

- [`../tinyssb/integration.patch`](../tinyssb/integration.patch) adds the app
  listing, `WBD` route, invitation UI, and Android bridge to the official host.
- [`../tinyssb/ble-startup.patch`](../tinyssb/ble-startup.patch) fixes first-run
  BLE permission and restart behavior.
- [`../tinyssb/whiteboard-export.patch`](../tinyssb/whiteboard-export.patch)
  adds JPEG/PDF export.
- [`../tinyssb/whiteboard`](../tinyssb/whiteboard) contains the tinySSB adapter,
  theme, and icon.
- [`../tinyssb/prepare-tinyssb.js`](../tinyssb/prepare-tinyssb.js) prepares the
  official host assets.
- [`../scripts/build-tinyssb.sh`](../scripts/build-tinyssb.sh) checks out the
  pinned official source, applies the patches, adds the shared whiteboard, and
  builds the current APK.
- [`../tests/tinyssb-whiteboard.test.js`](../tests/tinyssb-whiteboard.test.js)
  checks invitations, editor selection, and adapter behavior.

These files are intentionally kept even though the complete generated tinySSB
source tree is not committed. They are the integration layer needed to recreate
the tinySSB APK or apply the work to a later official source version.

## Browser Preview Files

Files such as [`../index.html`](../index.html), `user_alice.html`,
`user_bob.html`, `user_carol.html`, [`../src`](../src), and
[`../resources`](../resources) form the Tremola-for-Chrome preview. They are
useful for fast UI and deterministic merge tests. They do not replace Android
BLE and are not old APK versions.

## Build And Test Scripts

- [`../scripts/check.sh`](../scripts/check.sh) checks and builds Tremola, then
  writes only `install/tremola/whiteboard.apk`.
- [`../scripts/build-tinyssb.sh`](../scripts/build-tinyssb.sh) builds tinySSB,
  then writes only `install/tinyssb/whiteboard.apk`.
- [`../scripts/android.sh`](../scripts/android.sh) installs, launches, and reads
  logs from the Tremola APK.
- [`../install/SHA256SUMS`](../install/SHA256SUMS) identifies the two current
  binary files.

## Possible Upstream Integration

For Tremola, the repository already contains the complete modified host. An
upstream integration can compare this tree with
[`cn-uofbasel/tremola`](https://github.com/cn-uofbasel/tremola) and apply the
mini-app, bridge, Room, BLE, manifest, and activity changes as one reviewed
change set.

For tinySSB, integration is intentionally patch-based. The build script checks
out pinned official commit `39896b72`, applies the three local patches, and adds
the shared whiteboard files. This makes the local modifications visible and
reviewable without committing a second full copy of the official repository.

When updating either upstream base, rerun all automated checks and the physical
two-phone BLE test. An upstream merge can change Android permissions, WebView
callbacks, database schemas, or BLE lifecycle behavior even when the mini-app
JavaScript itself still loads.

## Documentation Map

- [`TREMOLA_VERSION.md`](TREMOLA_VERSION.md) - main app user and technical flow
- [`TINYSSB_VERSION.md`](TINYSSB_VERSION.md) - invitation and tinySSB flow
- [`SYNC_AND_MERGE.md`](SYNC_AND_MERGE.md) - events, frames, recovery, and merge
- [`TECHNICAL_OVERVIEW.md`](TECHNICAL_OVERVIEW.md) - architecture summary
- [`REPORT_BASIS.md`](REPORT_BASIS.md) - report corrections and methodology basis
- [`../install/README.md`](../install/README.md) - install and physical test steps
