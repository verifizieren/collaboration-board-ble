# Collaboration Board

A shared whiteboard built as a **tremola miniApp**: peers draw pen strokes and
add text labels, and every change syncs over tinySSB's append-only log.

This repo bundles the [tremola4chrome](https://github.com/tinySSB/tremola4chrome)
emulation environment so the board runs entirely in Chrome tabs — no Android
build needed. Each browser tab is one peer, and changes propagate between tabs
over the browser's `BroadcastChannel`.

## Getting an environment running

1. Clone the repo.
2. Start Chrome with file access from local files enabled:
   - **macOS:** `open -a "Google Chrome" --args --allow-file-access-from-files`
   - **Linux:** `google-chrome --allow-file-access-from-files`
   - **Windows:** `Win`+`R`, then `chrome.exe --allow-file-access-from-files`
   - Quit Chrome completely first, otherwise the flag is ignored.
3. Open one or more peer pages from the repo as `file://` URLs, e.g.
   `file://<repo>/user_alice.html`. Open `user_bob.html` / `user_carol.html`
   in further tabs to simulate more peers.
4. **Open all peer tabs at roughly the same time.** The emulator tracks
   per-peer sequence numbers and will warn if a peer joins out of order. The
   red ⨷ button at the top of a tab restarts all tabs.

## Using the board

1. In a peer tab, open the **MiniApps** section and launch **Collaboration Board**.
2. **Pen** — draw on the canvas; each finished stroke syncs to the other tabs.
3. **Text** — type in the field, then tap the canvas to place the label.
4. Pick a color with the color swatch. **Clear** empties the board for everyone.

## How sync works

The log is the single source of truth. Drawing or typing calls `writeLogEntry()`,
which appends a `CUS` (custom miniApp) entry to the author's log. Every peer —
including the author — receives it back through the `incoming_notification`
callback and applies it the same way, so all tabs converge. Each event carries a
unique id and peers ignore ids they have already applied.

Event payloads:

| kind   | shape                                          |
|--------|------------------------------------------------|
| stroke | `{ k:'s', id, c:<color>, w:<width>, p:[[x,y]] }`|
| text   | `{ k:'t', id, c:<color>, x, y, s:<string> }`   |
| clear  | `{ k:'c', id }`                                |

## Layout

- `user_*.html` — per-peer entry pages (the emulated backend).
- `src/` — the tremola frontend and virtual backend (vendored, upstream).
- `miniApps/collabboard/` — **this project**: manifest, HTML/CSS, and sync logic.
- `miniApps/tictactoe/` — upstream example miniApp, kept as a reference.
- `doc/20250327-miniApps.md` — miniApp API and manifest reference.

## Known limitations

- Sync is between tabs of one Chrome instance (the emulator), not across machines.
- The emulator does not replay history: a tab only sees events that arrive while
  it is open. State persists per tab via `localStorage`, so reopening the board
  in the same tab restores it, but a freshly opened tab starts empty.
