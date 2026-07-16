"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
const boardSource = fs.readFileSync(
    path.join(root, "miniApps/collabboard/src/collabboard.js"),
    "utf8"
);
const adapterSource = fs.readFileSync(
    path.join(root, "tinyssb/whiteboard/adapter.js"),
    "utf8"
);

function feed(label) {
    return "@" + (label + "0123456789abcdefghijklmnopqrstuvwxyz").repeat(2).slice(0, 44) +
        ".ed25519";
}

function fakeElement() {
    return {
        style: { display: "none" },
        classList: { toggle: function () {}, add: function () {}, remove: function () {} },
        focus: function () {},
        setAttribute: function () {},
        innerHTML: "",
        textContent: "",
        value: "",
        checked: false,
        disabled: false
    };
}

function loadAdapter(identity) {
    const elements = Object.create(null);
    const commands = [];
    const context = {
        console: { log: function () {} },
        document: {
            getElementById: function (id) {
                if (!elements[id]) elements[id] = fakeElement();
                return elements[id];
            }
        },
        tremola: { contacts: {} },
        myId: identity,
        localPeers: {},
        curr_scenario: "whiteboard",
        overlayIsActive: false,
        persist: function () {},
        backend: function (command) { commands.push(command); },
        setScenario: function () {},
        closeOverlay: function () {},
        launch_snackbar: function () {},
        b2f_local_peer: function () {},
        b2f_ble_disabled: function () {},
        confirm: function () { return true; },
        setTimeout: function () {},
        clearTimeout: function () {},
        btoa: function (value) { return Buffer.from(value, "binary").toString("base64"); },
        atob: function (value) { return Buffer.from(value, "base64").toString("binary"); },
        escapeHTML: function (value) {
            return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;")
                .replace(/>/g, "&gt;").replace(/\"/g, "&quot;");
        }
    };
    context.window = context;
    context.window.top = context;
    vm.createContext(context);
    vm.runInContext(boardSource, context, { filename: "collabboard.js" });
    vm.runInContext(adapterSource, context, { filename: "adapter.js" });
    context.commands = commands;
    return context;
}

function meta(kind, id, roomId, order, values) {
    return Object.assign({
        k: kind,
        id: id,
        r: roomId,
        ts: order,
        l: order,
        u: "User"
    }, values || {});
}

function store(board, event, fid) {
    assert.strictEqual(board.wb_is_valid_meta_event(event), true, event.id);
    board.wb_store_event(event, { fid: fid, tst: event.ts, username: event.u });
}

const owner = feed("owner");
const guests = [feed("alice"), feed("bob"), feed("carol"), feed("dave")];
const extras = [feed("e1"), feed("e2"), feed("e3"), feed("e4"), feed("e5")];
const roomId = "wbd-0123456789abcdef0123456789abcdef";
const board = loadAdapter(owner);

// tinySSB must not confuse the common browser-preview room with a real board.
// The setup plus opens contact selection; an open board uses its Invite flow.
const setupBoard = loadAdapter(owner);
let selectedContacts = 0;
let openedInvites = 0;
setupBoard.whiteboard_select_contacts = function () { selectedContacts += 1; };
setupBoard.whiteboard_invite_contacts = function () { openedInvites += 1; };
assert.strictEqual(setupBoard.wb_current_room(), null);
setupBoard.whiteboard_plus();
assert.strictEqual(selectedContacts, 1);
assert.strictEqual(openedInvites, 0);
setupBoard.tremola.collabboardRoom = { r: roomId };
setupBoard.whiteboard_plus();
assert.strictEqual(selectedContacts, 1);
assert.strictEqual(openedInvites, 1);

// The upstream BLE callback reports "online" and may expose the same tinySSB
// identity under more than one Android BLE address.
let shownPeers = -1;
setupBoard.cb_room_status = function () {};
setupBoard.cb_ble_status = function (_label, peers) { shownPeers = peers; };
setupBoard.localPeers = {
    "AA:00": { type: "ble", status: "online", name: "alice-feed" },
    "BB:00": { type: "ble", status: "online", name: "alice-feed" },
    "CC:00": { type: "ble", status: "offline", name: "bob-feed" }
};
setupBoard.wb_update_status();
assert.strictEqual(shownPeers, 1);

store(board, meta("wc", "create", roomId, 1, {
    u: "Owner", b: "DPI Board", p: "482913"
}), owner);

const invitees = guests.concat(extras);
invitees.forEach(function (fid, index) {
    store(board, meta("wi", "invite-" + index, roomId, 10 + index, { to: fid }), owner);
});
// A non-owner cannot extend the authoritative invitation list.
store(board, meta("wi", "invite-invalid", roomId, 19, { to: feed("outsider") }), guests[0]);

// Store accepts in reverse arrival order. Logical event order still selects
// the same first three guests on every peer.
[3, 2, 1, 0].forEach(function (index) {
    store(board, meta("wa", "accept-" + index, roomId, 30 + index, {
        u: "Guest " + index,
        invite: "invite-" + index
    }), guests[index]);
});

let state = board.wb_meta_state(roomId);
assert.strictEqual(state.managed, true);
assert.strictEqual(state.owner, owner);
assert.strictEqual(state.invitations.length, 8);
assert.deepStrictEqual(JSON.parse(JSON.stringify(state.members)), [
    owner, guests[0], guests[1], guests[2]
]);
assert.strictEqual(board.wb_can_edit(roomId, guests[0]), true);
assert.strictEqual(board.wb_can_edit(roomId, guests[3]), false);
assert.strictEqual(board.wb_can_edit(roomId, feed("outsider")), false);
assert.strictEqual(board.wb_members(roomId).length, 4);

store(board, meta("wp", "profile-alice", roomId, 50, { u: "Alice New" }), guests[0]);
state = board.wb_meta_state(roomId);
assert.strictEqual(state.aliases[guests[0]], "Alice New");
assert.strictEqual(state.members[1], guests[0]);

// Existing pre-invitation tinySSB boards remain readable for compatibility.
assert.strictEqual(board.wb_can_edit("legacy-board", feed("legacy")), true);

const recipient = loadAdapter(guests[0]);
recipient.tremola.contacts[owner] = {
    alias: "Verified Owner", trusted: 2, forgotten: false
};
store(recipient, meta("wc", "recipient-create", roomId, 1, {
    u: "Owner", b: "DPI Board", p: "482913"
}), owner);
store(recipient, meta("wi", "recipient-invite", roomId, 2, { to: guests[0] }), owner);
assert.strictEqual(recipient.wb_pending_invitations().length, 1);
recipient.tremola.contacts[owner].trusted = 1;
assert.strictEqual(recipient.wb_pending_invitations().length, 0);
recipient.tremola.contacts[owner].trusted = 2;

// The six-digit Join form may select an exact signed invitation, but it must
// never derive or invent a room from the code alone.
recipient.document.getElementById("cb_username").value = "Alice";
recipient.document.getElementById("cb_join_code").value = "482913";
let joinedRoom = null;
recipient.cb_activate_room = function (room) { joinedRoom = room; };
recipient.cb_join_board();
assert.strictEqual(joinedRoom.r, roomId);
assert.strictEqual(joinedRoom.o, owner);
const accepted = JSON.parse(Buffer.from(
    recipient.commands[recipient.commands.length - 1].slice("whiteboard ".length),
    "base64"
).toString("utf8"));
assert.strictEqual(accepted.k, "wa");
assert.strictEqual(accepted.r, roomId);
assert.strictEqual(accepted.invite, "recipient-invite");

const noInvite = loadAdapter(guests[1]);
noInvite.document.getElementById("cb_username").value = "Bob";
noInvite.document.getElementById("cb_join_code").value = "482913";
noInvite.cb_join_board();
assert.strictEqual(noInvite.commands.length, 0);
assert.strictEqual(noInvite.wb_current_room(), null);

// New boards use random room IDs. A six-digit display code can never create
// or select a tinySSB board by itself.
const roomA = board.wb_new_room("123456", "Owner", "Board A");
const roomB = board.wb_new_room("123456", "Owner", "Board B");
assert.notStrictEqual(roomA.r, roomB.r);
assert.strictEqual(roomA.v, 3);
assert.strictEqual(roomA.k, board.wb_room_key(roomA.r, "123456", 3));
assert.notStrictEqual(roomA.k, board.wb_room_key(roomA.r, "123456", 2));

// Creating publishes the signed create event first, followed by the selected
// verified-contact invitations for that exact random room.
const creator = loadAdapter(owner);
guests.concat(extras).forEach(function (fid, index) {
    creator.tremola.contacts[fid] = {
        alias: "Contact " + index, trusted: 2, forgotten: false
    };
});
creator.document.getElementById("cb_username").value = "Owner";
creator.document.getElementById("cb_board_name").value = "Shared board";
creator.tremola.collabboardTinyDraftInvites = guests.concat(extras);
let activatedRoom = null;
creator.cb_activate_room = function (room) { activatedRoom = room; };
creator.cb_create_board();
const published = creator.commands.map(function (command) {
    const encoded = command.slice("whiteboard ".length);
    return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
});
assert.strictEqual(published[0].k, "wc");
assert.strictEqual(published[0].v, 3);
assert.strictEqual(published.length, 1 + creator.WB_MAX_INVITES);
assert.strictEqual(published.slice(1).every(function (event) {
    return event.k === "wi" && event.r === published[0].r;
}), true);
assert.strictEqual(activatedRoom.r, published[0].r);
assert.strictEqual(creator.wb_draft_invites().length, 0);

const integrationPatch = fs.readFileSync(path.join(root, "tinyssb/integration.patch"), "utf8");
assert.strictEqual(integrationPatch.includes("'whiteboard_show_invitations'"), true);
assert.strictEqual(integrationPatch.includes("whiteboard_plus();"), true);
assert.strictEqual(integrationPatch.includes("whiteboard_members_confirmed()"), true);
assert.strictEqual(integrationPatch.includes("whiteboard_members_cancelled()"), true);
assert.strictEqual(integrationPatch.includes("'div:collabboard-main', 'plus'"), false);
assert.strictEqual(integrationPatch.includes('else if (e.public[0] == "WBD")'), true);
assert.strictEqual(adapterSource.includes("menu.parentNode !== core"), true);
assert.strictEqual(adapterSource.includes("kanban_invitation_container light"), true);
assert.strictEqual(adapterSource.includes("wb_official_invite_button"), true);
assert.strictEqual(adapterSource.includes("wb_room_from_code"), false);
assert.strictEqual(adapterSource.includes("No signed invitation for this code yet"), true);
assert.strictEqual(adapterSource.includes("Android.exportWhiteboard"), true);

const receivedStroke = {
    k: "s", id: "received-stroke", r: roomId, ts: 90, l: 90,
    u: "Owner", c: "#2563eb", w: 2, p: [[8, 8], [18, 18]]
};
const receivedMessage = {
    header: { fid: owner, ref: "received-ref", seq: 3 },
    public: ["WBD", JSON.stringify(receivedStroke)]
};
const entriesBeforeReceive = recipient.wb_room_events(roomId).length;
recipient.whiteboard_new_event(receivedMessage);
recipient.whiteboard_new_event(receivedMessage);
assert.strictEqual(recipient.wb_room_events(roomId).length, entriesBeforeReceive + 1);

const theme = fs.readFileSync(path.join(root, "tinyssb/whiteboard/theme.css"), "utf8");
assert.strictEqual(theme.includes(".cb_tool.cb_active"), true);
assert.strictEqual(theme.includes(".cb_tool[aria-pressed='true']"), true);
assert.strictEqual(theme.includes(".cb_workspace.cb_dark_canvas #cb_canvas"), true);
assert.strictEqual(theme.includes("background: transparent"), true);
assert.strictEqual(theme.includes("../../img/send.svg"), true);
assert.strictEqual(theme.includes("#wb_export_btn"), true);
assert.strictEqual(theme.includes(".wb_member_row"), true);

const exportPatch = fs.readFileSync(path.join(root, "tinyssb/whiteboard-export.patch"), "utf8");
assert.strictEqual(exportPatch.includes("Intent.ACTION_CREATE_DOCUMENT"), true);
assert.strictEqual(exportPatch.includes("PdfDocument"), true);
assert.strictEqual(exportPatch.includes("exportWhiteboard"), true);

console.log("tinySSB whiteboard tests passed");
