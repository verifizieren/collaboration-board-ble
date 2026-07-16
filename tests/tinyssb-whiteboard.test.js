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
        appendChild: function (child) { child.parentNode = this; },
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
    const snackbars = [];
    const timers = [];
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
        launch_snackbar: function (message) { snackbars.push(message); },
        b2f_local_peer: function () {},
        b2f_ble_disabled: function () {},
        confirm: function () { return true; },
        setTimeout: function (callback) { timers.push(callback); },
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
    context.snackbars = snackbars;
    context.timers = timers;
    context.elements = elements;
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

// The setup plus explains that a board is needed. Inside a board it opens the
// verified-contact invitation flow.
const setupBoard = loadAdapter(owner);
let openedInvites = 0;
setupBoard.whiteboard_invite_contacts = function () { openedInvites += 1; };
assert.strictEqual(setupBoard.wb_current_room(), null);
setupBoard.whiteboard_plus();
assert.strictEqual(openedInvites, 0);
assert.strictEqual(setupBoard.snackbars.pop(), "Create or open a board before inviting someone");
setupBoard.tremola.collabboardRoom = { r: roomId };
setupBoard.whiteboard_plus();
assert.strictEqual(openedInvites, 1);
setupBoard.tremola.collabboardRoom = {
    r: roomId, p: "482913", b: "DPI Board", o: owner, u: "Owner"
};
setupBoard.cb_update_room_bar();
assert.strictEqual(setupBoard.document.getElementById("cb_invite_btn").textContent, "Code 482913");
assert.notStrictEqual(setupBoard.document.getElementById("cb_invite_btn").style.display, "none");

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

// A repeat invite to one contact is ignored by the shared reducer until its
// signed timestamp is at least 30 seconds newer.
const repeatRoom = "wbd-repeat-0123456789abcdef0123456789";
store(board, meta("wc", "repeat-create", repeatRoom, 100000, {
    u: "Owner", b: "Repeat Board", p: "390122", v: 3
}), owner);
store(board, meta("wi", "repeat-first", repeatRoom, 100100, { to: guests[0] }), owner);
store(board, meta("wi", "repeat-too-soon", repeatRoom, 110100, { to: guests[0] }), owner);
store(board, meta("wi", "repeat-later", repeatRoom, 130101, { to: guests[0] }), owner);
const repeatState = board.wb_meta_state(repeatRoom);
assert.strictEqual(repeatState.invitations.length, 2);
assert.strictEqual(repeatState.latestInvitations[0].e.id, "repeat-later");

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

// A newly received invitation schedules an Accept/Decline popup immediately.
const popupRecipient = loadAdapter(guests[1]);
popupRecipient.tremola.contacts[owner] = {
    alias: "Verified Owner", trusted: 2, forgotten: false
};
popupRecipient.whiteboard_new_event({
    header: { fid: owner, ref: "popup-create-ref", seq: 1 },
    public: ["WBD", JSON.stringify(meta("wc", "popup-create", repeatRoom, 1, {
        u: "Owner", b: "Popup Board", p: "390122", v: 3
    }))]
});
const timersBeforeInvite = popupRecipient.timers.length;
popupRecipient.whiteboard_new_event({
    header: { fid: owner, ref: "popup-invite-ref", seq: 2 },
    public: ["WBD", JSON.stringify(meta("wi", "popup-invite", repeatRoom, 2, {
        to: guests[1]
    }))]
});
assert.strictEqual(popupRecipient.snackbars.includes("New whiteboard invitation"), true);
assert.strictEqual(popupRecipient.timers.length, timersBeforeInvite + 1);

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

// Decline is a signed event, so the sender can distinguish it from Waiting.
const decliner = loadAdapter(guests[2]);
decliner.tremola.contacts[owner] = {
    alias: "Verified Owner", trusted: 2, forgotten: false
};
store(decliner, meta("wc", "decline-create", repeatRoom, 1, {
    u: "Owner", b: "Decline Board", p: "390122", v: 3
}), owner);
store(decliner, meta("wi", "decline-invite", repeatRoom, 2, { to: guests[2] }), owner);
decliner.whiteboard_decline_invite("decline-invite");
const declinedEvent = JSON.parse(Buffer.from(
    decliner.commands[decliner.commands.length - 1].slice("whiteboard ".length),
    "base64"
).toString("utf8"));
assert.strictEqual(declinedEvent.k, "wd");
assert.strictEqual(declinedEvent.invite, "decline-invite");

const senderStatus = loadAdapter(owner);
store(senderStatus, meta("wc", "status-create", repeatRoom, 1, {
    u: "Owner", b: "Decline Board", p: "390122", v: 3
}), owner);
store(senderStatus, meta("wi", "status-invite", repeatRoom, 2, { to: guests[2] }), owner);
store(senderStatus, meta("wd", "status-decline", repeatRoom, 3, {
    u: "Carol", invite: "status-invite"
}), guests[2]);
assert.strictEqual(senderStatus.wb_outgoing_invitations()[0].status, "Declined");

// The send action itself blocks immediate repeats and permits a retry after
// 30 seconds without consuming another unique invite slot.
const cooldown = loadAdapter(owner);
cooldown.tremola.contacts[guests[0]] = {
    alias: "Alice", trusted: 2, forgotten: false
};
const cooldownRoom = cooldown.wb_new_room("771204", "Owner", "Cooldown Board");
cooldown.tremola.collabboardRoom = cooldownRoom;
store(cooldown, meta("wc", "cooldown-create", cooldownRoom.r, Date.now() - 1000, {
    u: "Owner", b: "Cooldown Board", p: "771204", v: 3
}), owner);
cooldown.whiteboard_invite_contact(guests[0]);
assert.strictEqual(cooldown.commands.length, 1);
assert.strictEqual(cooldown.document.getElementById("menu_invite_content").innerHTML.includes("Wait "), true);
assert.strictEqual(cooldown.document.getElementById("menu_invite_content").innerHTML.includes("wb_official_invite_button"), true);
cooldown.whiteboard_invite_contact(guests[0]);
assert.strictEqual(cooldown.commands.length, 1);
assert.strictEqual(cooldown.snackbars.some(function (message) {
    return message.indexOf("Wait ") === 0;
}), true);
cooldown.wb_room_events(cooldownRoom.r).filter(function (entry) {
    return entry.e.k === "wi";
})[0].e.ts -= 31000;
cooldown.whiteboard_invite_contact(guests[0]);
assert.strictEqual(cooldown.commands.length, 2);
assert.strictEqual(cooldown.wb_meta_state(cooldownRoom.r).invitees.length, 1);

// New boards use random room IDs. A six-digit display code can never create
// or select a tinySSB board by itself.
const roomA = board.wb_new_room("123456", "Owner", "Board A");
const roomB = board.wb_new_room("123456", "Owner", "Board B");
assert.notStrictEqual(roomA.r, roomB.r);
assert.strictEqual(roomA.v, 3);
assert.strictEqual(roomA.k, board.wb_room_key(roomA.r, "123456", 3));
assert.notStrictEqual(roomA.k, board.wb_room_key(roomA.r, "123456", 2));

// Creating publishes only the signed board event. Contacts are invited later
// with the plus button inside that board.
const creator = loadAdapter(owner);
guests.concat(extras).forEach(function (fid, index) {
    creator.tremola.contacts[fid] = {
        alias: "Contact " + index, trusted: 2, forgotten: false
    };
});
creator.document.getElementById("cb_username").value = "Owner";
creator.document.getElementById("cb_board_name").value = "Shared board";
let activatedRoom = null;
creator.cb_activate_room = function (room) { activatedRoom = room; };
creator.cb_create_board();
const published = creator.commands.map(function (command) {
    const encoded = command.slice("whiteboard ".length);
    return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
});
assert.strictEqual(published[0].k, "wc");
assert.strictEqual(published[0].v, 3);
assert.strictEqual(published.length, 1);
assert.strictEqual(activatedRoom.r, published[0].r);

const integrationPatch = fs.readFileSync(path.join(root, "tinyssb/integration.patch"), "utf8");
assert.strictEqual(integrationPatch.includes("versionCode 8"), true);
assert.strictEqual(integrationPatch.includes("versionName \"0.8\""), true);
assert.strictEqual(integrationPatch.includes("Collaboration Board (dpi26.15)"), true);
assert.strictEqual(integrationPatch.includes("move and resize objects.<br>"), true);
assert.strictEqual(integrationPatch.includes("keep working offline while tinySSB"), false);
assert.strictEqual(integrationPatch.includes("'whiteboard_show_invitations'"), true);
assert.strictEqual(integrationPatch.includes("whiteboard_plus();"), true);
assert.strictEqual(integrationPatch.includes("whiteboard_members_confirmed()"), false);
assert.strictEqual(integrationPatch.includes("whiteboard_members_cancelled()"), false);
assert.strictEqual(integrationPatch.includes("'div:collabboard-main', 'plus'"), true);
assert.strictEqual(integrationPatch.includes('else if (e.public[0] == "WBD")'), true);
assert.strictEqual(adapterSource.includes("menu.parentNode !== core"), true);
assert.strictEqual(adapterSource.includes("kanban_invitation_container light"), true);
assert.strictEqual(adapterSource.includes("wb_official_invite_button"), true);
assert.strictEqual(adapterSource.includes("var WB_META_DECLINE = 'wd';"), true);
assert.strictEqual(adapterSource.includes("WB_INVITE_COOLDOWN_MS = 30000"), true);
assert.strictEqual(adapterSource.includes("Collaboration Board (dpi26.15)"), true);
assert.strictEqual(adapterSource.includes("wb_draft_invites"), false);
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
assert.strictEqual(theme.includes(".wb_code_chip"), true);
assert.strictEqual(theme.includes(".wb_invitation_section"), true);

const exportPatch = fs.readFileSync(path.join(root, "tinyssb/whiteboard-export.patch"), "utf8");
assert.strictEqual(exportPatch.includes("Intent.ACTION_CREATE_DOCUMENT"), true);
assert.strictEqual(exportPatch.includes("PdfDocument"), true);
assert.strictEqual(exportPatch.includes("exportWhiteboard"), true);

console.log("tinySSB whiteboard tests passed");
