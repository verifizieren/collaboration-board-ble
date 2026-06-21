# Collaboration Board

A shared whiteboard built as a **tremola miniApp**: peers draw pen strokes and
add text labels, and every change syncs over tinySSB's append-only log.

This repo bundles the [tremola4chrome](https://github.com/tinySSB/tremola4chrome)
emulation environment so the board runs entirely in Chrome tabs — no Android
build needed. Each browser tab is one peer; changes propagate between tabs over
the browser's `BroadcastChannel`.

## Quick start

```bash
git clone https://github.com/verifizieren/collaboration-board-ble.git
cd collaboration-board-ble
```

Then pick whichever is easiest — both end up at the same **hub page** that links
to each peer (Alice / Bob / Carol):

**A. One command (recommended).** Starts a local server and opens the hub:

```bash
./start.sh        # macOS / Linux   (Windows: double-click start.bat)
```

**B. Any static server.** If you'd rather run it yourself:

```bash
python3 -m http.server 8000
# then open http://localhost:8000 in Chrome
```

From the hub, click **Alice** and **Bob** (and **Carol**) to open each peer in
its own tab. Open them at roughly the same time. Needs Python 3 (preinstalled on
macOS/Linux) and normal Chrome — no special flags.

> A `file://` launch also works; see "Opening without a server" below.

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
| text   | `{ k:'t', id, c:<color>, x, y, s:<base64 text> }`|
| clear  | `{ k:'c', id }`                                 |

The `f2b` command string is space-delimited, so payloads must contain no spaces;
the text field is therefore base64-encoded (`cb_enc`/`cb_dec`) and decoded at
render time.

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

## Opening without a server (file://)

You can also open the hub straight from disk as a `file://` URL — no server
needed — but Chrome must be started with file access enabled (quit Chrome
completely first, so the flag takes effect):

```bash
# macOS  (replace the path with your clone location)
open -a "Google Chrome" --args --allow-file-access-from-files \
  "file://$PWD/index.html"
# Linux
google-chrome --allow-file-access-from-files "file://$PWD/index.html"
# Windows (Win+R)
chrome.exe --allow-file-access-from-files
```

Then click the peers from the hub as usual. The one-command `./start.sh` route
above is easier and is what we recommend.
