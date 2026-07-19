# Collaboration Board

A shared whiteboard for Android phones that synchronizes over Bluetooth Low
Energy, with no server and no internet connection. Several people draw and write
on the same canvas; each phone keeps its own signed append-only log of board
operations and merges the logs deterministically when the phones meet.

Course project for *Distributed Programming and Internet Architecture*, spring
semester 2026, University of Basel, by Max Mendes Carvalho, Dehlen Thavarajah,
Frédéric Weyssow, and Simon Zeugin. The accompanying report describes the design
and the verification status in full.

Two Android builds are included:

| Build | Role | Host | Access model |
| --- | --- | --- | --- |
| **tinySSB** | main submission | official tinySSB Android host, as a mini-app | signed invitation to a verified contact |
| **Tremola** | comparison | full Tremola app with a board-specific BLE transport | shared six-digit board code |

Both builds run the same whiteboard source (`miniApps/collabboard/`). They use
different Android packages and can be installed side by side, but a tinySSB
board and a Tremola board do **not** synchronize with each other - use the same
variant on every phone in one test.

## Features

**Drawing** - freehand strokes and text; move, resize, recolor, and delete any
object; clear the whole board. Every member may edit every object.

**Canvas** - a fixed logical canvas of 1800 x 2400 units, so positions match
across phones with different screen sizes. Full-screen view with pan and pinch
zoom, and a local dark mode. Export as JPEG (follows dark mode) or PDF (always
white).

**Boards** - name boards and reopen them from a saved-board list. Board data and
membership survive closing the board or the app. Up to eight boards may share a
name; they are told apart by eight local label colors. Deleting a board removes
only the local copy on that phone.

**Sync** - works offline and catches up later. A finished action becomes one
compact event; the canvas image itself is never transmitted. After joining, a
phone shows the merged current state rather than replaying old steps on screen.

## Install And Run

The two current version 1.0 APKs:

- [`install/tinyssb/whiteboard.apk`](install/tinyssb/whiteboard.apk) - main submission
- [`install/tremola/whiteboard.apk`](install/tremola/whiteboard.apk) - comparison

Requirements: Bluetooth Low Energy, and BLE advertising support on at least one
phone in each connection. tinySSB needs Android 8.0 (API 26) or newer; Tremola
needs Android 7.0 (API 24) or newer. Two real phones are needed for a BLE test -
an emulator cannot do it.

**[`install/README.md`](install/README.md) has the full install steps, both
workflows, the board controls, and a two-phone BLE test script.** In short:

- **tinySSB** - verify contacts, open **Productivity > Collaboration Board
  (dpi26.15)**, create a board, tap `+` to invite a verified contact. The creator
  may invite up to eight contacts; the creator plus the first three valid
  acceptances become the four editors. The signed invitation carries the random
  board ID, so a six-digit code cannot discover an unknown board on its own.
- **Tremola** - open **MiniApps > Collaboration Board**, create a board, share
  the generated six-digit code. Anyone with the code may join until the
  four-identity limit is reached, and the creator need not stay nearby. The code
  is the actual access mechanism here, so share it as carefully as a password.

The six-digit code means different things in the two builds. In Tremola it grants
access. In tinySSB it is only a convenience selector for an invitation that has
already arrived on that phone - it is not a cryptographic secret and cannot
discover an unknown board.

**Keep both apps in the foreground with the screens unlocked while syncing.** The
upstream host stops BLE in `onPause`, so background synchronization does not
work. Expect delays of roughly 15-30 seconds for some tinySSB exchanges; this is
normal, not a failure. Public `WBD` events are signed but not encrypted.

## How Sync Works

A finished action - stroke, text, move, resize, recolor, delete, clear, or
rename - becomes one immutable event. Nothing is sent while a finger is still
moving.

In **tinySSB**, the event is appended to the author's signed feed. The official
host encodes it as 120-byte packets and requests missing feed entries and chunks
during later replication rounds. In **Tremola**, the board transport sends the
operation immediately, waits for an acknowledgement, and additionally compares
per-author frontiers about every five seconds; only operations for the active
board enter the board sync queue.

Convergence is eventual, not real-time. See
[`docs/SYNC_AND_MERGE.md`](docs/SYNC_AND_MERGE.md) for the complete path from one
sampled stroke to deterministic replay on another phone.

## Documentation

- [`docs/TECHNICAL_OVERVIEW.md`](docs/TECHNICAL_OVERVIEW.md) - architecture
- [`docs/BUILDS.md`](docs/BUILDS.md) - the two builds compared: invitations, storage, transport, security
- [`docs/SYNC_AND_MERGE.md`](docs/SYNC_AND_MERGE.md) - events, BLE delivery, recovery, merge rules
- [`docs/PROJECT_STRUCTURE.md`](docs/PROJECT_STRUCTURE.md) - what each part of the tree is for, and upstream integration
- [`install/README.md`](install/README.md) - install and physical test steps

## Project Layout

- `miniApps/collabboard/` - the shared whiteboard: HTML, CSS, reducer, manifest
- `app/` - the complete Tremola Android host and its native BLE code
- `tinyssb/` - patches, adapter, theme, and icon that integrate the whiteboard
  into the pinned official tinySSB host
- `install/` - the two APKs, checksums, and install instructions
- `scripts/` - build, check, install, and log helpers
- `tests/` - JavaScript tests for board behavior and the tinySSB adapter
- `src/`, `resources/`, `index.html`, `user_*.html` - the browser preview
- `docs/` - project documentation; `docs/upstream/` - inherited tinySSB
  architecture and mini-app documents, kept for reference

The mini-app folder alone is not the project: it has no Android storage,
identity, BLE, permissions, or export.

## Build And Test

Requires JDK 11, the Android SDK, Node.js, and `git` (the tinySSB build clones
the pinned upstream host).

```bash
./scripts/check.sh        # JS tests, Kotlin tests, lint, APK build and checks
```

It also runs Android instrumentation tests when a phone or emulator is attached,
and refreshes `install/tremola/whiteboard.apk`.
[`scripts/build-tinyssb.sh`](scripts/build-tinyssb.sh) checks out the pinned
official tinySSB source, applies the patches, and builds
`install/tinyssb/whiteboard.apk`.

With USB debugging enabled:

```bash
./scripts/android.sh devices
./scripts/android.sh install PHONE_SERIAL
./scripts/android.sh logs PHONE_SERIAL
```

## Browser Preview

```bash
./start.sh
```

This opens the whiteboard in Chrome with simulated peers. It is useful for
checking the UI and the deterministic merge behavior, but it exercises none of
the native layer - no BLE, no invitations, no signing, no Android permissions.

## License

Released under the [MIT License](LICENSE). The project includes modified
MIT-licensed code from tinySSB and Tremola; see
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for the preserved notices and
the upstream revisions.
