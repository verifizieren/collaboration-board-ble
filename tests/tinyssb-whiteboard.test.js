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
        value: ""
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

const integrationPatch = fs.readFileSync(path.join(root, "tinyssb/integration.patch"), "utf8");
assert.strictEqual(integrationPatch.includes("'whiteboard_show_invitations'"), true);
assert.strictEqual(integrationPatch.includes("whiteboard_invite_contacts();"), true);
assert.strictEqual(integrationPatch.includes("'div:collabboard-main', 'plus'"), true);

const theme = fs.readFileSync(path.join(root, "tinyssb/whiteboard/theme.css"), "utf8");
assert.strictEqual(theme.includes(".cb_tool.cb_active"), true);
assert.strictEqual(theme.includes(".cb_tool[aria-pressed='true']"), true);
assert.strictEqual(theme.includes(".cb_workspace.cb_dark_canvas #cb_canvas"), true);
assert.strictEqual(theme.includes("background: transparent"), true);

console.log("tinySSB whiteboard tests passed");
