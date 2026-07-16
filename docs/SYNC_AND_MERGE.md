# Events, BLE Sync, And Merge

This guide explains what the app sends and how every phone calculates the same
board. It is written for report authors as well as developers.

## 1. Important Terms

**Object** is something visible on the canvas. A stroke and a text label are
objects.

**Event** is one immutable description of a completed action. Creating,
moving, resizing, recoloring, deleting, renaming, and clearing all create
events. Existing events are not edited in place.

**Operation** is the stored and transmitted form of one event. In Tremola it
adds the board ID, author feed ID, per-author sequence, encryption data, and
signature.

**BLE frame** is one MTU-sized part of a larger protocol message. A long
operation needs several frames.

**Frontier** is the highest uninterrupted sequence a phone has for each author.
If it has sequences 1, 2, and 4, its frontier for that author is 2 because 3 is
missing.

**WANT range** is a request such as "send author A sequences 3 through 6".

**Merge** means keeping all valid operations and applying deterministic rules.
It does not mean choosing one phone as the correct master copy.

## 2. Event Types

Every event has a unique `id`, a board ID `r`, a Lamport order `l`, a timestamp
`ts`, and usually a display name `u`. Type `k` defines the action:

| Type | Meaning | Main fields |
| --- | --- | --- |
| `s` | Create stroke | color `c`, width `w`, ordered points `p` |
| `t` | Create text | color `c`, position `x/y`, encoded text `s` |
| `m` | Move or resize | target ID `t`, offset `dx/dy`, scale `sc` |
| `k` | Recolor | target ID `t`, color `c` |
| `d` | Delete object | target ID `t` |
| `c` | Clear board | no target; hides older visible objects |
| `n` | Rename board | board name `b` |
| `x` | Legacy cancel | old compatibility event; not created now |

Source: [`../miniApps/collabboard/src/collabboard.js`](../miniApps/collabboard/src/collabboard.js).

## 3. One Stroke, Step By Step

1. The user touches the canvas in Draw mode.
2. The phone samples logical canvas coordinates, not physical screen pixels.
3. A point is kept only after the finger moved at least three logical units.
4. The line is drawn locally as immediate visual feedback. Nothing is sent yet.
5. When the finger is released, the points are simplified to at most 160.
6. JavaScript creates one `s` event with a unique ID, color, width, and points.
7. The event receives the board ID, display label, and next Lamport order.
8. The local reducer applies it immediately, so the stroke cannot disappear
   while transport is still pending.
9. Android stores and sends the operation in the Tremola build. The tinySSB
   adapter publishes it as a signed `WBD` feed event in the tinySSB build.

An incoming stroke may contain at most 512 validated points. Coordinates must
stay inside the finite 1800 x 2400 board.

## 4. Other Actions

Text creates one `t` event only after the text is placed. Moving and resizing do
not resend the original object. They create an `m` event that names the target
object and stores an absolute offset and scale relative to the original.
Recolor and Delete also refer to the target ID. Clear creates one small `c`
event and does not transmit an empty image.

This explains an old failure: if a move arrived but its original stroke did
not, there was temporarily nothing to draw. The current reducer keeps the move;
when recovery supplies the original stroke, the transform becomes visible.

## 5. Tremola Operation Creation

After JavaScript calls the Android bridge:

1. Android checks that the local feed is an authorized board member.
2. It reads the highest stored sequence for that author and assigns the next
   number.
3. The clear JSON payload is limited to 8192 bytes.
4. Deflate compression is used when it saves at least 16 bytes.
5. A random 12-byte nonce is created.
6. AES-256-GCM encrypts the payload. Authenticated data binds room ID, author,
   sequence, operation ID, and compression flag.
7. The author's Ed25519 feed identity signs the canonical wire values.
8. Room stores the operation before BLE delivery is trusted.
9. A copy is also appended to Tremola's signed custom-app log.
10. The operation is queued for every authenticated board peer.

The Room primary key is `(room_id, operation_id)`. A second unique index on
`(room_id, author_id, author_seq)` prevents two different operations from using
one author sequence.

Sources: [`BoardProtocol.kt`](../app/src/main/java/nz/scuttlebutt/tremola/ssb/peering/ble/BoardProtocol.kt),
[`BoardOperation.kt`](../app/src/main/java/nz/scuttlebutt/tremola/ssb/db/entities/BoardOperation.kt),
and [`BoardOperationDAO.kt`](../app/src/main/java/nz/scuttlebutt/tremola/ssb/db/daos/BoardOperationDAO.kt).

## 6. Tremola BLE Delivery

The board-specific messages are:

| Message | Purpose |
| --- | --- |
| `bh` | Authenticated board hello and member identity |
| `bm` | Signed member admission for older invitation-style boards |
| `bf` | Per-author contiguous frontier |
| `bw` | WANT request for missing sequence ranges |
| `bo` | One encrypted and signed board operation |
| `ba` | Acknowledgement of a complete operation |
| `br` | Rejection such as Board full |

Delivery works as follows:

1. BLE discovery creates a GATT client or server route between nearby phones.
2. Phones negotiate an MTU, preferring 247 bytes and falling back to 23.
3. A signed `bh` message proves the feed identity and matching board access.
4. The sender serializes a `bo` message and compresses the outer JSON when
   useful.
5. It splits the message into frames. Each frame has an 8-byte header containing
   version, encoding kind, message ID, frame number, and total frame count.
6. At the preferred MTU, one frame carries at most 180 message bytes. At the
   23-byte fallback MTU, only 12 bytes remain after ATT and frame headers.
7. Frames are queued per link. The next write or notification starts only after
   Android reports completion for the previous one.
8. The receiver collects frames by message ID. It processes the message only
   after every numbered frame is present.
9. It verifies room, membership, signature, AES-GCM tag, operation ID, and
   payload limits.
10. It stores the operation, sends `ba`, applies it to the WebView, and relays it
    to other authenticated peers.
11. Until `ba` arrives, the sender keeps the operation pending. It retries after
    two seconds, up to 12 direct attempts.
12. Independent anti-entropy continues even after direct retries.

Frame pacing prevents Android's GATT queue from being flooded. Operation ACK
prevents "all frames were handed to Android" from being mistaken for "the peer
stored the complete operation".

Source: [`BleSync.kt`](../app/src/main/java/nz/scuttlebutt/tremola/ssb/peering/ble/BleSync.kt).

## 7. Frontier And WANT Recovery

Every five seconds, each authenticated peer sends a `bf` message. For every
author, it announces the highest contiguous stored sequence.

Example:

```text
Phone A has Alice 1,2,3,4 and Bob 1,2.
Phone B has Alice 1,2,4 and Bob 1,2,3.

A frontier: Alice=4, Bob=2
B frontier: Alice=2, Bob=3

B asks A for Alice sequence 3..4.
A asks B for Bob sequence 3.
Duplicates such as Alice 4 are ignored by operation ID and sequence index.
```

One range contains at most 64 sequences, one WANT contains at most 16 ranges,
and one anti-entropy pulse queues at most 24 operations. Repeated pulses finish
larger catch-ups without filling the BLE queue.

Any authorized member may answer a WANT. Therefore a late phone can recover the
board from another member even when the original author is offline.

## 8. Deterministic Merge Rules

The reducer stores creation objects, transforms, recolors, deletes, clears, and
names as separate sets. It validates every event before use.

1. **Duplicate delivery:** an already seen event ID is ignored.
2. **Concurrent new objects:** both remain because they have different IDs.
3. **Move/resize:** for one target, the greatest `(Lamport order, event ID)`
   pair wins.
4. **Recolor:** the same ordering selects the current color.
5. **Delete:** a later valid delete hides its target.
6. **Clear:** the greatest clear event hides objects ordered at or before it.
   Objects created after that clear remain visible.
7. **Out-of-order dependency:** a transform or delete may arrive before its
   target and is retained until the target arrives.
8. **Board name:** the greatest valid name event is displayed.

Lamport order is advanced beyond every event already observed locally. Event ID
is the stable tie-break when two operations have the same Lamport value. Wall
clock differences between phones therefore do not decide the merge alone.

All accepted members use the same reducer and every member may edit every
object. There is no Protected mode, ownership lock, or master phone.

## 9. tinySSB Delivery

tinySSB uses the same UI events and merge rules but a different transport:

1. The adapter publishes the event as a public `WBD` application entry.
2. The event becomes part of the author's signed append-only tinySSB feed.
3. The official host encodes feed data into compact packets and linked chunks.
4. BLE peers compare feed state and request missing packets or chunks.
5. The adapter is notified only after a complete event is reconstructed.
6. It checks the signed feed author against the deterministic four-editor list.
7. It stores the event locally and applies the shared reducer.

Invitation metadata uses `wc`, `wi`, `wa`, `wd`, and `wp` events. The creator
may invite eight verified contacts, while creator plus first three valid
acceptances form the editor list.

Source: [`../tinyssb/whiteboard/adapter.js`](../tinyssb/whiteboard/adapter.js)
and the pinned official host applied by
[`../scripts/build-tinyssb.sh`](../scripts/build-tinyssb.sh).

## 10. Why The Old Mobile Path Failed

The earlier path sent large signed Tremola JSON entries through many BLE
fragments. A single missing fragment prevented reconstruction of the complete
event. There was no whiteboard-specific complete-operation ACK and no sequence
gap request. Long strokes therefore failed more often than small events.

Clear appeared reliable because it contains almost no data and does not depend
on an earlier object. A move is also small, but it cannot be displayed when its
target stroke or text never arrived.

The current Tremola path addresses this with board-only traffic, point limits,
compression, paced frames, persistent storage, complete-operation ACK, retry,
frontier comparison, WANT ranges, relay, duplicate rejection, and out-of-order
merge handling.

## 11. What Eventual Convergence Means

Phones may temporarily show different boards while disconnected or while BLE
recovery is running. Once they have exchanged the same valid operation set,
the deterministic reducer produces the same visible board.

The correct report claim is **operation-based BLE synchronization with eventual
convergence**. It is not frame-by-frame live screen sharing, and it is not a
guarantee that every operation appears instantly.

## 12. Evidence And Tests

- [`../tests/collabboard.test.js`](../tests/collabboard.test.js) checks event validation, duplicates, reverse-order replay, conflicts, mobile canvas behavior, and export.
- [`../app/src/test`](../app/src/test) checks framing, queue limits, ranges, retries, and protocol helpers.
- [`../app/src/androidTest`](../app/src/androidTest) checks Android cryptography and integration behavior.
- [`../install/README.md`](../install/README.md) contains the physical-phone acceptance procedure.

Automated tests prove the reducer and protocol rules. Only real phones can prove
the complete BLE radio path on the tested Android versions.
