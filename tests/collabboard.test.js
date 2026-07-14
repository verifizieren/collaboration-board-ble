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

// Android posts the signed log echo asynchronously. A completed local stroke
// must already be in state before another tap causes a canvas redraw.
const immediateStrokeBoard = loadBoard();
immediateStrokeBoard.cb_tool = "pen";
immediateStrokeBoard.cb_pointer_id = 23;
immediateStrokeBoard.cb_draft = {
    k: "s", c: "#2563eb", w: 2, p: [[8, 8], [18, 18]]
};
immediateStrokeBoard.cb_up({
    pointerId: 23,
    currentTarget: {
        style: {},
        releasePointerCapture: function () {},
        hasPointerCapture: function () { return false; }
    },
    preventDefault: function () {}
});
assert.strictEqual(immediateStrokeBoard.writes.length, 1);
assert.strictEqual(immediateStrokeBoard.cb_tool, "pen");
assert.strictEqual(snapshot(immediateStrokeBoard).length, 1);
apply(immediateStrokeBoard, immediateStrokeBoard.writes[0], "@alice.ed25519");
assert.strictEqual(snapshot(immediateStrokeBoard).length, 1);

// Text uses the same immediate path and remains active for another label.
const immediateTextBoard = loadBoard();
const immediateTextInput = {
    value: "Persistent text",
    style: {},
    focus: function () {}
};
immediateTextBoard.document.getElementById = function (id) {
    if (id === "cb_text") return immediateTextInput;
    if (id === "cb_color") return { value: "#2563eb" };
    return null;
};
immediateTextBoard.cb_tool = "text";
immediateTextBoard.cb_place_text([30, 40]);
assert.strictEqual(immediateTextBoard.writes.length, 1);
assert.strictEqual(immediateTextBoard.cb_tool, "text");
assert.strictEqual(snapshot(immediateTextBoard).length, 1);
apply(immediateTextBoard, immediateTextBoard.writes[0], "@alice.ed25519");
assert.strictEqual(snapshot(immediateTextBoard).length, 1);

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

// The shared board keeps Max's original event format and behavior.
const compatibility = loadBoard();
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
const sharedBoard = loadBoard();
apply(sharedBoard, stroke, alice);
apply(sharedBoard, {
    k: "m", id: "bob-move-1", ts: 400, t: stroke.id,
    dx: 18, dy: 9, sc: 1.4
}, bob);
apply(sharedBoard, {
    k: "k", id: "bob-color-1", ts: 410, t: stroke.id, c: "#12abef"
}, bob);
let sharedSnapshot = snapshot(sharedBoard);
assert.deepStrictEqual(sharedSnapshot[0].transform, { dx: 18, dy: 9, sc: 1.4 });
assert.strictEqual(sharedSnapshot[0].color, "#12abef");

apply(sharedBoard, {
    k: "t", id: "bob-text-1", ts: 420, c: "#7c3aed",
    x: 40, y: 50, s: "SGVsbG8="
}, bob);
assert.deepStrictEqual(
    snapshot(sharedBoard).map(function (item) { return item.id; }),
    [stroke.id, "bob-text-1"]
);

// Clear is shared too: any peer clears the complete board.
apply(sharedBoard, { k: "c", id: "bob-clear-1", ts: 430 }, bob);
assert.deepStrictEqual(snapshot(sharedBoard), []);

// The Android color picker stays unrestricted to valid six-digit hex colors.
const colorBoard = loadBoard();
colorBoard.document.getElementById = function (id) {
    return id === "cb_color" ? { value: "#12abef" } : null;
};
assert.strictEqual(colorBoard.cb_color(), "#12abef");
assert.strictEqual(colorBoard.cb_is_valid_color("#12abef"), true);
assert.strictEqual(colorBoard.cb_is_valid_color("red"), false);

const pickerBoard = loadBoard();
const pickerListeners = {};
const picker = {
    value: "#12abef",
    addEventListener: function (name, handler) { pickerListeners[name] = handler; }
};
const pickerCanvas = {
    addEventListener: function () {}
};
pickerBoard.document.getElementById = function (id) {
    if (id === "cb_canvas") return pickerCanvas;
    if (id === "cb_color") return picker;
    return null;
};
pickerBoard.window.addEventListener = function () {};
pickerBoard.cb_redraw = function () {};
apply(pickerBoard, stroke, alice);
pickerBoard.myId = bob;
pickerBoard.cb_sel = stroke.id;
pickerBoard.cb_tool = "select";
pickerBoard.cb_bind_canvas();
pickerListeners.change();
assert.strictEqual(pickerBoard.writes.length, 1);
assert.strictEqual(pickerBoard.writes[0].k, "k");
assert.strictEqual(pickerBoard.writes[0].c, "#12abef");
assert.strictEqual(snapshot(pickerBoard)[0].color, "#12abef");

// Events from the removed owner/profile experiment no longer enter the board.
const legacy = loadBoard();
apply(legacy, {
    k: "o", a: "s", id: "legacy-owned-1", ts: 20,
    n: "Alice", c: "#2563eb", w: 2, p: [[1, 1], [2, 2]]
}, alice);
apply(legacy, {
    k: "p", id: "legacy-profile-1", ts: 21, n: "Alice", c: "#2563eb"
}, alice);
assert.deepStrictEqual(snapshot(legacy), []);
assert.strictEqual(legacy.cb_state().seen.length, 0);

// Updating removes old owner-only state but keeps the original shared board.
const migration = loadBoard();
migration.tremola.collabboard = {
    objects: [
        Object.assign({ _board: "open" }, stroke),
        {
            _board: "owned", _fid: alice, k: "s", id: "legacy-local-1", ts: 30,
            n: "Alice", c: "#2563eb", w: 2, p: [[3, 3], [4, 4]]
        }
    ],
    clears: [{ _board: "owned", _fid: alice, k: "c", id: "legacy-clear-1", ts: 31 }],
    seen: [],
    mods: [{
        _board: "owned", _fid: alice, k: "m", id: "legacy-move-1", ts: 32,
        t: "legacy-local-1", dx: 1, dy: 1, sc: 1
    }],
    profiles: { "@alice.ed25519": { n: "Alice", c: "#2563eb" } },
    localProfile: { n: "Alice", c: "#2563eb" },
    mode: "owned"
};
const migrated = migration.cb_state();
assert.strictEqual(migrated.schema, 2);
assert.deepStrictEqual(migrated.objects.map(function (item) { return item.id; }), [stroke.id]);
assert.deepStrictEqual(migrated.clears, []);
assert.deepStrictEqual(migrated.mods, []);
assert.strictEqual(Object.prototype.hasOwnProperty.call(migrated, "mode"), false);
assert.strictEqual(Object.prototype.hasOwnProperty.call(migrated, "profiles"), false);

const boardMarkup = fs.readFileSync(
    path.join(root, "miniApps/collabboard/resources/board.html"),
    "utf8"
);
assert.strictEqual(boardMarkup.includes("cb_mode_switch"), false);
assert.strictEqual(boardMarkup.includes("cb_profile"), false);
assert.strictEqual(boardMarkup.includes("type='color'"), true);

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
