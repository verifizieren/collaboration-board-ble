"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(
    path.join(root, "miniApps/collabboard/src/collabboard.js"),
    "utf8"
);

function loadBoard() {
    const writes = [];
    const context = {
        console: { log: function () {} },
        document: { getElementById: function () { return null; } },
        tremola: {},
        myId: "@local-device.ed25519",
        persist: function () {},
        writeLogEntry: function (entry) { writes.push(JSON.parse(entry)); },
        // Android's WebView does not provide a working JavaScript confirm dialog
        // unless the host installs a WebChromeClient.
        confirm: function () { return false; },
        setTimeout: function () {},
        clearTimeout: function () {},
        btoa: function (value) { return Buffer.from(value, "binary").toString("base64"); },
        atob: function (value) { return Buffer.from(value, "base64").toString("binary"); }
    };
    context.window = context;
    context.window.top = context;
    vm.createContext(context);
    vm.runInContext(source, context, { filename: "collabboard.js" });
    context.writes = writes;
    return context;
}

function replay(events) {
    const board = loadBoard();
    events.forEach(function (event) { board.cb_apply(event); });
    return board;
}

function snapshot(board) {
    const state = board.cb_state();
    const value = board.cb_visible_objects(state).map(function (object) {
        return {
            id: object.id,
            transform: board.cb_xf(state, object),
            color: board.cb_eff_color(state, object)
        };
    });
    return JSON.parse(JSON.stringify(value));
}

function apply(board, event, fid) {
    board.cb_apply(event, {
        fid: fid,
        tst: typeof event.ts === "number" ? event.ts : Date.now()
    });
}

function owned(kind, value) {
    return Object.assign({ k: "o", a: kind }, value);
}

const stroke = {
    k: "s", id: "peer-100-1", ts: 100, c: "#2563eb", w: 2,
    p: [[10, 10], [20, 20]]
};
const olderMove = {
    k: "m", id: "peer-200-1", ts: 200, t: stroke.id,
    dx: 5, dy: 7, sc: 1
};
const recolor = {
    k: "k", id: "peer-250-1", ts: 250, t: stroke.id, c: "#ff0000"
};
const winningMove = {
    k: "m", id: "peer-300-1", ts: 300, t: stroke.id,
    dx: 30, dy: -10, sc: 1.25
};

const forward = replay([stroke, olderMove, recolor, winningMove, winningMove]);
const reverse = replay([winningMove, recolor, olderMove, stroke]);
assert.deepStrictEqual(snapshot(forward), snapshot(reverse));
assert.strictEqual(forward.cb_state().mods.length, 2);
assert.strictEqual(forward.cb_state().seen.length, 4);

const clear = { k: "c", id: "peer-150-1", ts: 150 };
const text = {
    k: "t", id: "peer-160-1", ts: 160, c: "#000000",
    x: 12, y: 18, s: "SGVsbG8="
};
const cleared = replay([winningMove, text, clear, stroke]);
assert.deepStrictEqual(snapshot(cleared).map(function (item) { return item.id; }), [text.id]);

// Clear must work in the Android host even when window.confirm returns false.
// A logical timestamp also makes it newer than content from a fast device clock.
const clearSender = loadBoard();
const clearReceiver = loadBoard();
const futureStroke = {
    k: "s", id: "future-stroke-1", ts: Date.now() + 60000, c: "#2563eb", w: 2,
    p: [[5, 5], [15, 15]]
};
apply(clearSender, futureStroke, "@alice.ed25519");
apply(clearReceiver, futureStroke, "@alice.ed25519");
clearSender.cb_clear();
assert.strictEqual(clearSender.writes.length, 1);
assert.strictEqual(clearSender.writes[0].k, "c");
assert.ok(clearSender.writes[0].ts > futureStroke.ts);
assert.deepStrictEqual(snapshot(clearSender), []);
apply(clearReceiver, clearSender.writes[0], "@alice.ed25519");
assert.deepStrictEqual(snapshot(clearReceiver), []);

// Exercise the exact two-peer path for a completed phone drag and resize:
// pointer-up writes an event, then the other board replays that wire payload.
const transformSender = loadBoard();
const transformReceiver = loadBoard();
apply(transformSender, stroke, "@alice.ed25519");
apply(transformReceiver, stroke, "@alice.ed25519");
const futureTransform = {
    k: "m", id: "future-transform-1", ts: Date.now() + 60000, t: stroke.id,
    dx: 4, dy: 6, sc: 1
};
apply(transformSender, futureTransform, "@alice.ed25519");
apply(transformReceiver, futureTransform, "@alice.ed25519");

function finishTransform(board, transform) {
    board.cb_pointer_id = 17;
    board.cb_drag = {
        mode: transform.mode,
        target: stroke.id,
        moved: true,
        xf: { dx: transform.dx, dy: transform.dy, sc: transform.sc }
    };
    board.cb_up({
        pointerId: 17,
        currentTarget: {
            style: {},
            releasePointerCapture: function () {},
            hasPointerCapture: function () { return false; }
        },
        preventDefault: function () {}
    });
}

finishTransform(transformSender, { mode: "move", dx: 30, dy: -10, sc: 1 });
assert.strictEqual(transformSender.writes[0].k, "m");
assert.ok(transformSender.writes[0].ts > futureTransform.ts);
apply(transformReceiver, transformSender.writes[0], "@alice.ed25519");
assert.deepStrictEqual(snapshot(transformReceiver)[0].transform, { dx: 30, dy: -10, sc: 1 });

finishTransform(transformSender, { mode: "resize", dx: 30, dy: -10, sc: 1.5 });
assert.strictEqual(transformSender.writes[1].k, "m");
apply(transformReceiver, transformSender.writes[1], "@alice.ed25519");
assert.deepStrictEqual(snapshot(transformReceiver)[0].transform, { dx: 30, dy: -10, sc: 1.5 });

const validation = loadBoard();
assert.strictEqual(validation.cb_is_valid_event(stroke), true);
assert.strictEqual(validation.cb_is_valid_event({
    k: "k", id: "bad-color", t: stroke.id, c: "red"
}), false);
assert.strictEqual(validation.cb_is_valid_event({
    k: "m", id: "bad-scale", t: stroke.id, dx: 0, dy: 0, sc: 100
}), false);

validation.cb_pointer_id = 7;
validation.cb_drag = { mode: "move" };
validation.cb_draft = { k: "s" };
validation.cb_cancel({
    pointerId: 7,
    currentTarget: {
        style: {},
        releasePointerCapture: function () {},
        hasPointerCapture: function () { return false; }
    },
    preventDefault: function () {}
});
assert.strictEqual(validation.cb_pointer_id, null);
assert.strictEqual(validation.cb_drag, null);
assert.strictEqual(validation.cb_draft, null);

const statusBoard = loadBoard();
const statusBox = { className: "" };
const statusText = { textContent: "" };
statusBoard.document.getElementById = function (id) {
    if (id === "cb_sync_status") return statusBox;
    if (id === "cb_sync_text") return statusText;
    return null;
};
statusBoard.cb_ble_status("BLE sync active", 1, 3);
assert.strictEqual(statusBox.className, "cb_sync_status cb_sync_ready");
assert.strictEqual(statusText.textContent, "Syncing");
assert.strictEqual(statusBox.title, "BLE sync active | peers 1 | queue 3");
statusBoard.cb_ble_status("Bluetooth disabled", 0, 0);
assert.strictEqual(statusBox.className, "cb_sync_status cb_sync_error");
assert.strictEqual(statusText.textContent, "Bluetooth off");
assert.strictEqual(statusBoard.cb_status_label("Browser preview", 0, 0), "Preview");
assert.strictEqual(statusBoard.cb_status_label("BLE sync active", 1, 0), "1 nearby");
assert.strictEqual(statusBoard.cb_status_label("BLE sync active", 2, 0), "2 nearby");
assert.strictEqual(statusBoard.cb_status_label("Permission required", 0, 0), "Allow Bluetooth");

const paintBoard = loadBoard();
const paintCalls = [];
const paintContext = {
    fillStyle: null,
    clearRect: function (x, y, width, height) {
        paintCalls.push(["clear", x, y, width, height]);
    },
    fillRect: function (x, y, width, height) {
        paintCalls.push(["fill", x, y, width, height]);
    },
    save: function () {},
    translate: function () {},
    restore: function () {}
};
paintBoard.document.getElementById = function (id) {
    if (id === "cb_canvas") {
        return { width: 320, height: 200, getContext: function () { return paintContext; } };
    }
    return null;
};
paintBoard.cb_redraw();
assert.deepStrictEqual(paintCalls, [
    ["clear", 0, 0, 320, 200],
    ["fill", 0, 0, 320, 200]
]);
assert.strictEqual(paintContext.fillStyle, "#ffffff");

// Open mode keeps Max's original event format and behavior.
const compatibility = loadBoard();
compatibility.cb_board_mode = "open";
compatibility.cb_write_board_event({
    k: "s", id: "max-open-1", ts: 10, c: "#2563eb", w: 2,
    p: [[1, 1], [3, 3]]
}, false);
assert.deepStrictEqual(compatibility.writes[0], {
    k: "s", id: "max-open-1", ts: 10, c: "#2563eb", w: 2,
    p: [[1, 1], [3, 3]]
});

const alice = "@alice.ed25519";
const bob = "@bob.ed25519";
const aliceProfile = { k: "p", id: "alice-profile-1", ts: 10, n: "Alice", c: "#2563eb" };
const bobProfile = { k: "p", id: "bob-profile-1", ts: 11, n: "Bob", c: "#dc2626" };
const aliceStroke = owned("s", {
    id: "alice-stroke-1", ts: 20, n: "Alice", c: "#2563eb", w: 2,
    p: [[10, 10], [20, 20]]
});
const bobStroke = owned("s", {
    id: "bob-stroke-1", ts: 21, n: "Bob", c: "#dc2626", w: 2,
    p: [[30, 30], [40, 40]]
});
const aliceMove = owned("m", {
    id: "alice-move-1", ts: 30, t: "alice-stroke-1", dx: 12, dy: 4, sc: 1.2
});
const bobUnauthorizedMove = owned("m", {
    id: "bob-attack-1", ts: 99, t: "alice-stroke-1", dx: 900, dy: 900, sc: 4
});

const protectedBoard = loadBoard();
apply(protectedBoard, aliceProfile, alice);
apply(protectedBoard, bobProfile, bob);
apply(protectedBoard, bobUnauthorizedMove, bob); // can arrive before its target
apply(protectedBoard, aliceMove, alice);
apply(protectedBoard, bobStroke, bob);
apply(protectedBoard, aliceStroke, alice);
protectedBoard.cb_board_mode = "owned";
let ownedSnapshot = snapshot(protectedBoard);
assert.deepStrictEqual(ownedSnapshot.map(function (item) { return item.id; }), ["alice-stroke-1", "bob-stroke-1"]);
assert.deepStrictEqual(ownedSnapshot[0].transform, { dx: 12, dy: 4, sc: 1.2 });
assert.strictEqual(ownedSnapshot[0].color, "#2563eb");
assert.strictEqual(ownedSnapshot[1].color, "#dc2626");
assert.strictEqual(protectedBoard.cb_state().mods.length, 2);

// Owned creates are self-describing and keep Max's event inside a wrapper.
const ownedWire = loadBoard();
ownedWire.tremola.collabboard = {
    objects: [], clears: [], seen: [], mods: [], profiles: {}, mode: "owned",
    localProfile: { n: "Alice", c: "#2563eb" }
};
ownedWire.cb_board_mode = "owned";
ownedWire.cb_write_board_event({
    k: "s", id: "local-owned-1", ts: 25, c: "#000000", w: 2,
    p: [[1, 1], [2, 2]]
}, false);
assert.deepStrictEqual(ownedWire.writes[0], {
    k: "o", a: "s", id: "local-owned-1", ts: 25,
    n: "Alice", c: "#2563eb", w: 2, p: [[1, 1], [2, 2]]
});

// The object carries enough profile data to render before a profile event arrives.
const profileFallback = loadBoard();
apply(profileFallback, bobStroke, bob);
assert.deepStrictEqual(
    JSON.parse(JSON.stringify(profileFallback.cb_profile_for(bob))),
    { n: "Bob", c: "#dc2626" }
);
apply(profileFallback, bobProfile, bob);
apply(profileFallback, {
    k: "p", id: "bob-profile-2", ts: 40, n: "Bobby", c: "#15803d"
}, bob);
assert.deepStrictEqual(
    JSON.parse(JSON.stringify(profileFallback.cb_profile_for(bob))),
    { n: "Bobby", c: "#15803d" }
);
profileFallback.cb_board_mode = "owned";
assert.strictEqual(snapshot(profileFallback)[0].color, "#15803d");

// A local user may only edit objects signed by the same Tremola feed.
protectedBoard.myId = alice;
assert.strictEqual(protectedBoard.cb_is_own_object(protectedBoard.cb_find_visible_object("alice-stroke-1")), true);
assert.strictEqual(protectedBoard.cb_is_own_object(protectedBoard.cb_find_visible_object("bob-stroke-1")), false);

// Owned clear is per author. Alice's clear leaves Bob's object visible.
apply(protectedBoard, owned("c", { id: "alice-clear-1", ts: 40 }), alice);
ownedSnapshot = snapshot(protectedBoard);
assert.deepStrictEqual(ownedSnapshot.map(function (item) { return item.id; }), ["bob-stroke-1"]);

// Missing verified author metadata is rejected for Owned and profile events.
const unsigned = loadBoard();
unsigned.cb_apply(aliceStroke);
unsigned.cb_apply(aliceProfile);
unsigned.cb_board_mode = "owned";
assert.deepStrictEqual(snapshot(unsigned), []);
assert.strictEqual(Object.keys(unsigned.cb_state().profiles).length, 0);

// The profile palette is intentionally fixed to four colors.
assert.strictEqual(unsigned.cb_is_valid_profile_data({ n: "Alice", c: "#2563eb" }), true);
assert.strictEqual(unsigned.cb_is_valid_profile_data({ n: "Alice", c: "#000000" }), false);
assert.strictEqual(unsigned.cb_clean_name("  Alice   Smith  "), "Alice Smith");

// Mode separation: old/open content never leaks into Owned and vice versa.
const separated = loadBoard();
apply(separated, stroke, alice);
apply(separated, aliceStroke, alice);
separated.cb_board_mode = "open";
assert.deepStrictEqual(snapshot(separated).map(function (item) { return item.id; }), [stroke.id]);
separated.cb_board_mode = "owned";
assert.deepStrictEqual(snapshot(separated).map(function (item) { return item.id; }), ["alice-stroke-1"]);

[
    "manifest.json",
    "resources/board.css",
    "resources/board.html",
    "src/collabboard.js"
].forEach(function (relativePath) {
    const browserCopy = fs.readFileSync(
        path.join(root, "miniApps/collabboard", relativePath),
        "utf8"
    );
    const androidCopy = fs.readFileSync(
        path.join(root, "app/src/main/assets/web/miniApps/collabboard", relativePath),
        "utf8"
    );
    assert.strictEqual(androidCopy, browserCopy, relativePath + " is not mirrored into Android");
});

console.log("Collaboration Board tests passed");
