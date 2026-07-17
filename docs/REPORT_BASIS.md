# Report Basis

Short, checked notes for the group report. The main submission is the tinySSB
Android version. Tremola is a separate comparison build.

## Correct Project Description

- The Collaboration Board is a mini-app inside the official tinySSB Android host.
- The interface and reducer are HTML, CSS, and JavaScript in an Android WebView.
- The native host provides feed identity, signed local storage, BLE replication,
  permissions, and Android file export.
- Up to eight verified contacts may be invited.
- The creator and the first three valid acceptances are the four editors.
- Every editor may change every object.
- Shared changes are eventual, not guaranteed real-time.
- Public tinySSB `WBD` events are signed but not encrypted.
- The main APK needs Android 8.0 / API 26 or newer.

Do not describe the tinySSB version as a private channel, instant screen sharing,
or a stand-alone browser app.

## One Action From Phone A To Phone B

1. The user finishes a stroke, text, move, resize, recolor, delete, clear, or
   board-name change.
2. JavaScript creates one compact immutable event.
3. The tinySSB adapter publishes it as a public `WBD` entry in the author's
   signed append-only feed.
4. The official host stores the entry and encodes it as 120-byte packets. Larger
   content uses linked side-chain chunks.
5. Nearby phones exchange feed state over BLE.
6. GOSET aligns known feed IDs. WANT and CHNK requests recover missing feed
   entries and chunks in later rounds.
7. Only a complete, verified entry reaches the whiteboard adapter.
8. The adapter checks the board and feed identity, then applies the shared
   deterministic reducer.

The full canvas image and live pointer movement are never transmitted.

## Event And Merge Model

Current event types:

- `s`: stroke
- `t`: text
- `m`: move or resize
- `k`: recolor
- `d`: delete one object
- `c`: clear older board objects
- `n`: rename the board

Every event has an ID, board ID, author label, timestamp, and Lamport order.
Strokes are reduced to at most 160 points before publishing. The logical canvas
is finite at 1800 x 2400 units.

The reducer follows these rules:

- duplicate event IDs are ignored
- creation events remain separate objects
- move, resize, and recolor use the greatest Lamport order and event ID
- a delete hides its target
- the greatest clear hides objects at or before it
- a move or delete may arrive before its target and is applied when the target arrives

Peers with the same accepted event set render the same board. The design is
operation-based and CRDT-inspired. It cannot reconstruct an event that BLE has
not delivered yet.

## Invitations And Identity

The stable identity is the tinySSB feed ID. A display name is only a label.

- `wc`: create board
- `wi`: invite verified contact
- `wa`: accept
- `wd`: decline
- `wp`: update display label

A board has a random internal ID. The six-digit code only selects an invitation
already stored on that phone. It cannot discover an unknown tinySSB board and is
not a cryptographic password.

The first three valid acceptance events join the creator. Their order is
deterministic for a shared event set. Invitation metadata currently starts its
ordering value from the local wall clock, so clock skew can influence which
three contacts win if more than three accept.

## Methodology Structure

Use this order in the report:

1. Inspect the official tinySSB Kanban and game mini-app patterns.
2. Separate the shared UI/reducer from the host-specific adapter.
3. Represent each completed edit as one immutable operation.
4. Integrate the app through three reviewable patches against a pinned upstream
   commit.
5. Reproduce phone problems and add focused JavaScript or adapter tests.
6. Build and inspect the APK, then test BLE on physical phones.
7. Record observed results and remaining limits separately from automated tests.

This is stronger than a Methodology section that only lists system components.

## Verified And Still Open

Verified by automated checks:

- event validation, duplicate handling, reverse-order replay, and merge rules
- draw, text, move, resize, recolor, delete, clear, gestures, and export behavior
- invitation state, eight invitees, four editors, decline, cooldown, and routing
- pinned patch application, JavaScript syntax, APK contents, metadata, and signature

Observed on Galaxy S9 and S10:

- tinySSB BLE synchronization worked
- some exchanges took roughly 15 to 30 seconds
- connections sometimes dropped

Still open before a strong final claim:

- repeat each operation in both directions with Wi-Fi and mobile data disabled
- record exact Android versions and repeated timings
- test disconnect, offline edits, reconnect, and app restart
- test four physical editors; current four-editor evidence is automated only
- add one real synchronized two-phone screenshot to the report if available

The tinySSB app must remain in the foreground because the upstream host stops
BLE in `onPause`.

## Tremola Comparison

The team also implemented a separate Tremola Android APK. It uses the same
whiteboard reducer but a custom board-specific BLE protocol, encrypted Room
operations, acknowledgements, retry, and per-author frontiers. It synchronized
faster in informal tests. The two APKs use different packages and transports and
cannot join the same board.

Tremola is useful as a comparison and fallback, but tinySSB is the main report
and submission focus.

## Main Sources

- [`../miniApps/collabboard/src/collabboard.js`](../miniApps/collabboard/src/collabboard.js): events, reducer, validation, gestures, and rendering
- [`../tinyssb/whiteboard/adapter.js`](../tinyssb/whiteboard/adapter.js): `WBD` routing, invitations, editor list, and filtering
- [`../tinyssb/integration.patch`](../tinyssb/integration.patch): host listing, event route, scenario, and bridge
- [`../tinyssb/ble-startup.patch`](../tinyssb/ble-startup.patch): first-start permissions and BLE restart
- [`../tinyssb/whiteboard-export.patch`](../tinyssb/whiteboard-export.patch): JPEG and PDF export
- [`../scripts/build-tinyssb.sh`](../scripts/build-tinyssb.sh): pinned reproducible build
- [`../tests/collabboard.test.js`](../tests/collabboard.test.js): shared reducer and mobile UI tests
- [`../tests/tinyssb-whiteboard.test.js`](../tests/tinyssb-whiteboard.test.js): invitation and adapter tests
- [`SYNC_AND_MERGE.md`](SYNC_AND_MERGE.md): detailed event and transport walkthrough
- [`TINYSSB_VERSION.md`](TINYSSB_VERSION.md): user workflow and limits
- [`../install/README.md`](../install/README.md): install and physical test procedure

## Writing Rules

- Say eventual convergence, not seamless real-time sync.
- Separate automated checks from physical BLE evidence.
- State that the four-editor rule is not yet proven with four real phones.
- State that public `WBD` payloads are not encrypted.
- Treat 15 to 30 seconds as an informal observation, not a benchmark.
- Disclose every AI tool actually used according to the course rules.
- Do not submit a generated or unrelated image as test evidence.
