# tinySSB Version 1.0

This is a separate build of the same Collaboration Board inside the official
`ssbc/tinyssb` Android host. It is the main submission version. It does not
synchronize with the Tremola comparison APK.

## Download

- APK: [`../install/tinyssb/whiteboard.apk`](../install/tinyssb/whiteboard.apk)
- Package: `nz.scuttlebutt.tremolavossbol`
- Version: `1.0` (`versionCode 9`)
- Minimum: Android 8.0 / API 26
- Invitations: up to eight verified contacts
- Editors: creator plus the first three valid acceptances, four total

## What A User Does

1. Install the APK and allow Nearby devices and Location.
2. Add the other people in tinySSB Contacts and verify them.
3. Open **Productivity > Collaboration Board (dpi26.15)**.
4. Enter a display name and create a board.
5. Open the board and tap `+`.
6. Select a verified contact and send the invitation.
7. The other phone enters a whiteboard name and accepts or declines.
8. Open **Invitations** to see Waiting, Accepted, Declined, or Board full.
9. Accepted editors open the saved board and use the same whiteboard tools as
   the Tremola version.

Only the creator sends invitations. One contact can be invited again after 30
seconds. The creator can invite eight different contacts, but eight invitations
do not create eight editors. The creator occupies the first editor place. The
first three valid acceptance events occupy the remaining places. Later
acceptances are reproducibly treated as Board full.

## Why The Invitation Matters

A new board receives a random board ID. A signed `wc` event announces the board.
The creator then writes signed `wi` invitation events addressed to verified
contact feed IDs. The receiver answers with `wa` for accept or `wd` for decline.
A `wp` event updates a member's display label.

The invitation contains the exact room information. A six-digit code can select
an invitation that is already stored on that phone, but a code by itself cannot
discover a remote tinySSB board.

The adapter builds the editor list deterministically from the creator and the
first three accepted feed IDs. It ignores whiteboard edits from other feeds.

Invitation metadata currently starts its ordering value from the local wall
clock. If more than three recipients accept, clock skew can influence which
three are selected. Peers with the same event set still select the same three.

See [`../tinyssb/whiteboard/adapter.js`](../tinyssb/whiteboard/adapter.js).

## What Happens To One Action

The shared JavaScript UI creates the same stroke, text, move, resize, recolor,
delete, clear, and name events as Tremola. The tinySSB adapter publishes the
event as a public `WBD` application event in the author's signed tinySSB feed.

The official tinySSB host divides feed content into compact packets and linked
chunks. BLE peers exchange feed state and ask again for missing packets or
chunks. Only after the complete signed feed event is available does the adapter
receive it, check board membership, store it in the local cache, and apply the
shared deterministic reducer.

The Tremola-specific `bh`, `bo`, `ba`, `bf`, and `bw` messages are not used by
this APK. Recovery belongs to the tinySSB packet and chunk protocol.

## Security And Limits

Contact verification and signed invitation events are an application access
rule. Public `WBD` events are not encrypted. Do not describe this version as a
private BLE channel.

The app should stay in the foreground during testing. Current observations show
slower synchronization and occasional disconnects compared with Tremola. Record
measured results instead of calling this universally reliable or unreliable.

## Reproducible Integration

The build starts from pinned official tinySSB commit
`39896b72c97b51159d46610c5f11ff7f5a279031` and applies local patches:

- [`../tinyssb/integration.patch`](../tinyssb/integration.patch) - Productivity listing, `WBD` event route, invitation menu, and board bridge
- [`../tinyssb/ble-startup.patch`](../tinyssb/ble-startup.patch) - correct Android permission callback and BLE restart
- [`../tinyssb/whiteboard-export.patch`](../tinyssb/whiteboard-export.patch) - Android JPEG and PDF export
- [`../tinyssb/prepare-tinyssb.js`](../tinyssb/prepare-tinyssb.js) - prepares the official host assets
- [`../scripts/build-tinyssb.sh`](../scripts/build-tinyssb.sh) - checks, builds, signs, and writes the canonical APK

The board UI and reducer still come from
[`../miniApps/collabboard`](../miniApps/collabboard), so both variants use the
same object and merge rules.

## Test

Follow [`../install/README.md`](../install/README.md). Verify contacts before
testing invites. Test up to eight invite targets separately from the four-editor
limit. Use real Android phones for BLE behavior.
