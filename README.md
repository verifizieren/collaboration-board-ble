# Collaboration Board

A shared whiteboard built as a **tremola miniApp**: peers draw pen strokes and
add text labels, and every change syncs over tinySSB's append-only log.

This repo bundles the [tremola4chrome](https://github.com/tinySSB/tremola4chrome)
emulation environment so the board runs entirely in Chrome tabs — no Android
build needed. Each browser tab is one peer; changes propagate between tabs over
the browser's `BroadcastChannel`.

## Quick start (recommended: local web server)

You need Python 3 (preinstalled on macOS/Linux) or any static file server.

```bash
git clone https://github.com/verifizieren/collaboration-board-ble.git
cd collaboration-board-ble
python3 -m http.server 8000
```

Now open these in **Chrome tabs** (normal Chrome, no special flags):

- http://localhost:8000/user_alice.html
- http://localhost:8000/user_bob.html

Open them at roughly the same time. Each tab is one peer (Alice, Bob, Carol).

> Why a server? The miniApp menu loads its app list from `miniApps/apps.json`,
> which a web server returns but a raw `file://` page cannot fetch reliably.
> Serving the folder is the simplest path that "just works".

## Open the Collaboration Board (in each tab)

1. At the bottom of the tab there are three buttons:
   **💬 chats · 🧩 miniApps · 👤 contacts**.
2. Tap the **🧩 miniApps** button (center).
3. Tap **Collaboration Board** in the list.

You're on the board. To leave it, tap the **←** arrow (top-left), which returns
you to the miniApps list; tap **Collaboration Board** again to re-enter.

## Using the board

- **Pen** — draw on the canvas; each finished stroke appears on the other tabs.
- **Text** — type in the field, then tap the canvas to drop the label there.
- **color swatch** — pick a color for new strokes/text.
- **Clear** — empties the board for everyone.

Draw in Alice's tab and watch it show up in Bob's, and vice versa.

## How sync works

The log is the single source of truth. Drawing or typing calls `writeLogEntry()`,
which appends a `CUS` (custom miniApp) entry to the author's log. Every peer —
including the author — receives it back through the `incoming_notification`
callback and applies it the same way, so all tabs converge. Each event carries a
unique id, and peers ignore ids they have already applied.

Event payloads:

| kind   | shape                                           |
|--------|-------------------------------------------------|
| stroke | `{ k:'s', id, c:<color>, w:<width>, p:[[x,y]] }` |
| text   | `{ k:'t', id, c:<color>, x, y, s:<string> }`    |
| clear  | `{ k:'c', id }`                                 |

## Project layout

- `user_*.html` — per-peer entry pages (the emulated backend).
- `src/` — the tremola frontend and virtual backend (vendored from upstream).
- `miniApps/apps.json` — the list of miniApps to load.
- `miniApps/collabboard/` — **this project**: manifest, HTML/CSS, and sync logic
  (`src/collabboard.js`).
- `miniApps/tictactoe/` — upstream example miniApp, kept as a reference.
- `doc/20250327-miniApps.md` — miniApp API and manifest reference.

## Adding another miniApp

Drop its folder under `miniApps/` and add the folder name to
`miniApps/apps.json`. Use `miniApps/tictactoe/` or `miniApps/collabboard/` as a
template. Note: each miniApp's JS shares one global scope, so prefix your
globals (e.g. `cb_…`) to avoid clashing with other apps.

## Known limitations

- Sync is between tabs of one Chrome instance (the emulator), not across machines.
- The emulator does not replay history: a tab only sees events that arrive while
  it is open. State persists per tab via `localStorage`, so reopening the board
  in the same tab restores it, but a freshly opened tab starts empty.

## Alternative: file:// (no server)

You can instead open `user_alice.html` directly as a `file://` URL, but Chrome
must be started with file access enabled (quit Chrome completely first):

```bash
# macOS
open -a "Google Chrome" --args --allow-file-access-from-files
# Linux
google-chrome --allow-file-access-from-files
# Windows (Win+R)
chrome.exe --allow-file-access-from-files
```

The local-server route above is easier and is what we recommend.
