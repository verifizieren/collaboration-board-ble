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
const deletion = { k: "d", id: "peer-140-1", ts: 140, t: stroke.id };
const text = {
    k: "t", id: "peer-160-1", ts: 160, c: "#000000",
    x: 12, y: 18, s: "SGVsbG8="
};
const cleared = replay([winningMove, text, clear, stroke]);
assert.deepStrictEqual(snapshot(cleared).map(function (item) { return item.id; }), [text.id]);

// A per-object deletion converges even if it arrives before the object.
const deletedForward = replay([stroke, deletion]);
const deletedReverse = replay([deletion, stroke]);
assert.deepStrictEqual(snapshot(deletedForward), []);
assert.deepStrictEqual(snapshot(deletedReverse), []);
assert.strictEqual(deletedForward.cb_state().deletes.length, 1);

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

// A short tap is a valid one-point stroke and must render as a visible dot.
const dotBoard = loadBoard();
const dotCalls = [];
const dotContext = {
    beginPath: function () { dotCalls.push(["begin"]); },
    arc: function (x, y, radius) { dotCalls.push(["arc", x, y, radius]); },
    fill: function () { dotCalls.push(["fill"]); }
};
dotBoard.cb_draw_stroke(dotContext, {
    k: "s", id: "tap-1", ts: 1, c: "#2563eb", w: 2, p: [[12, 18]]
});
assert.deepStrictEqual(dotCalls, [["begin"], ["arc", 12, 18, 1], ["fill"]]);
assert.strictEqual(dotContext.fillStyle, "#2563eb");

// A selected dot remains movable; its larger phone resize target begins
// outside the dot instead of covering the complete tiny object.
const dotGestureBoard = loadBoard();
const dotGestureUi = pointerHarness(dotGestureBoard, "#2563eb");
apply(dotGestureBoard, {
    k: "s", id: "movable-dot", ts: 2, c: "#2563eb", w: 2, p: [[12, 18]]
}, "@alice.ed25519");
dotGestureBoard.cb_set_tool("select");
dotGestureBoard.cb_down(pointerEvent(dotGestureUi.canvas, 24, 12, 18));
dotGestureBoard.cb_up(pointerEvent(dotGestureUi.canvas, 24, 12, 18));
dotGestureBoard.cb_down(pointerEvent(dotGestureUi.canvas, 25, 12, 18));
assert.strictEqual(dotGestureBoard.cb_drag.mode, "move");
dotGestureBoard.cb_cancel(pointerEvent(dotGestureUi.canvas, 25, 12, 18));
const dotBox = dotGestureBoard.cb_bbox(
    dotGestureUi.context,
    dotGestureBoard.cb_state(),
    dotGestureBoard.cb_visible_objects(dotGestureBoard.cb_state())[0]
);
const dotHandle = dotGestureBoard.cb_handle_rect(dotBox);
dotGestureBoard.cb_down(pointerEvent(
    dotGestureUi.canvas,
    26,
    dotHandle.x + dotHandle.w / 2,
    dotHandle.y + dotHandle.h / 2
));
assert.strictEqual(dotGestureBoard.cb_drag.mode, "resize");
dotGestureBoard.cb_cancel(pointerEvent(dotGestureUi.canvas, 26, 0, 0));

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

// Delete uses the same immediate signed-event path as the other board actions.
const immediateDeleteBoard = loadBoard();
apply(immediateDeleteBoard, stroke, "@alice.ed25519");
immediateDeleteBoard.cb_tool = "select";
immediateDeleteBoard.cb_sel = stroke.id;
immediateDeleteBoard.cb_delete_selected();
assert.strictEqual(immediateDeleteBoard.writes.length, 1);
assert.strictEqual(immediateDeleteBoard.writes[0].k, "d");
assert.strictEqual(immediateDeleteBoard.writes[0].t, stroke.id);
assert.deepStrictEqual(snapshot(immediateDeleteBoard), []);
apply(immediateDeleteBoard, immediateDeleteBoard.writes[0], "@alice.ed25519");
assert.deepStrictEqual(snapshot(immediateDeleteBoard), []);

function pointerHarness(board, colorValue) {
    const colorListeners = {};
    const context = {
        save: function () {},
        restore: function () {},
        translate: function () {},
        clearRect: function () {},
        fillRect: function () {},
        beginPath: function () {},
        moveTo: function () {},
        lineTo: function () {},
        stroke: function () {},
        fill: function () {},
        arc: function () {},
        strokeRect: function () {},
        setLineDash: function () {},
        fillText: function () {},
        measureText: function (value) { return { width: String(value).length * 8 }; }
    };
    const canvas = {
        width: 320,
        height: 240,
        style: {},
        captured: null,
        addEventListener: function () {},
        getContext: function () { return context; },
        getBoundingClientRect: function () {
            return { left: 0, top: 0, width: 320, height: 240 };
        },
        setPointerCapture: function (id) { this.captured = id; },
        hasPointerCapture: function (id) { return this.captured === id; },
        releasePointerCapture: function () { this.captured = null; }
    };
    const color = {
        value: colorValue,
        addEventListener: function (name, handler) { colorListeners[name] = handler; }
    };
    const textInput = { value: "", style: {}, focus: function () {} };
    const deleteButton = { disabled: true };
    board.document.getElementById = function (id) {
        if (id === "cb_canvas") return canvas;
        if (id === "cb_color") return color;
        if (id === "cb_text") return textInput;
        if (id === "cb_delete_btn") return deleteButton;
        return null;
    };
    board.window.addEventListener = function () {};
    board.cb_redraw = function () {};
    board.cb_bind_canvas();
    return {
        canvas: canvas,
        color: color,
        colorListeners: colorListeners,
        textInput: textInput,
        deleteButton: deleteButton,
        context: context
    };
}

function pointerEvent(canvas, id, x, y) {
    return {
        currentTarget: canvas,
        pointerId: id,
        isPrimary: true,
        clientX: x,
        clientY: y,
        preventDefault: function () {}
    };
}

// Full phone gesture path: draw -> remote replay -> move -> resize -> recolor.
const gestureSender = loadBoard();
const gestureReceiver = loadBoard();
const gestureUi = pointerHarness(gestureSender, "#e11d48");
gestureSender.cb_set_tool("pen");
gestureSender.cb_down(pointerEvent(gestureUi.canvas, 31, 20, 20));
gestureSender.cb_move(pointerEvent(gestureUi.canvas, 31, 40, 40));
gestureSender.cb_up(pointerEvent(gestureUi.canvas, 31, 40, 40));
assert.strictEqual(gestureSender.writes[0].k, "s");
assert.strictEqual(gestureSender.writes[0].c, "#e11d48");
apply(gestureReceiver, gestureSender.writes[0], "@alice.ed25519");
assert.strictEqual(snapshot(gestureReceiver)[0].color, "#e11d48");

gestureSender.cb_set_tool("select");
gestureSender.cb_down(pointerEvent(gestureUi.canvas, 32, 30, 30));
gestureSender.cb_move(pointerEvent(gestureUi.canvas, 32, 60, 50));
gestureSender.cb_up(pointerEvent(gestureUi.canvas, 32, 60, 50));
assert.strictEqual(gestureSender.writes[1].k, "m");
apply(gestureReceiver, gestureSender.writes[1], "@alice.ed25519");
assert.deepStrictEqual(snapshot(gestureReceiver)[0].transform, { dx: 30, dy: 20, sc: 1 });

const gestureState = gestureSender.cb_state();
const gestureObject = gestureSender.cb_visible_objects(gestureState)[0];
const gestureBox = gestureSender.cb_bbox(gestureUi.context, gestureState, gestureObject);
const gestureHandle = gestureSender.cb_handle_rect(gestureBox);
const handleX = gestureHandle.x + gestureHandle.w / 2;
const handleY = gestureHandle.y + gestureHandle.h / 2;
gestureSender.cb_down(pointerEvent(gestureUi.canvas, 33, handleX, handleY));
gestureSender.cb_move(pointerEvent(gestureUi.canvas, 33, handleX + 24, handleY + 24));
gestureSender.cb_up(pointerEvent(gestureUi.canvas, 33, handleX + 24, handleY + 24));
assert.strictEqual(gestureSender.writes[2].k, "m");
assert.ok(gestureSender.writes[2].sc > 1);
apply(gestureReceiver, gestureSender.writes[2], "@alice.ed25519");
assert.ok(snapshot(gestureReceiver)[0].transform.sc > 1);

gestureUi.color.value = "#16a34a";
gestureUi.colorListeners.change();
assert.strictEqual(gestureSender.writes[3].k, "k");
apply(gestureReceiver, gestureSender.writes[3], "@alice.ed25519");
assert.strictEqual(snapshot(gestureReceiver)[0].color, "#16a34a");

gestureSender.cb_delete_selected();
assert.strictEqual(gestureSender.writes[4].k, "d");
apply(gestureReceiver, gestureSender.writes[4], "@alice.ed25519");
assert.deepStrictEqual(snapshot(gestureReceiver), []);

// Text has its own color and is also visible immediately on the other board.
gestureUi.color.value = "#7c3aed";
gestureUi.textInput.value = "Shared text";
gestureSender.cb_set_tool("text");
gestureSender.cb_down(pointerEvent(gestureUi.canvas, 34, 90, 80));
assert.strictEqual(gestureSender.cb_pointer_id, null);
gestureSender.cb_up(pointerEvent(gestureUi.canvas, 34, 90, 80));
assert.strictEqual(gestureSender.writes[5].k, "t");
apply(gestureReceiver, gestureSender.writes[5], "@alice.ed25519");
assert.strictEqual(snapshot(gestureReceiver)[0].color, "#7c3aed");

// Repeated drawing keeps each chosen Android color, even with reverse replay.
const multiColorSender = loadBoard();
const multiColorReceiver = loadBoard();
const multiColorUi = pointerHarness(multiColorSender, "#dc2626");
multiColorSender.cb_set_tool("pen");
multiColorSender.cb_down(pointerEvent(multiColorUi.canvas, 41, 15, 15));
multiColorSender.cb_move(pointerEvent(multiColorUi.canvas, 41, 35, 25));
multiColorSender.cb_up(pointerEvent(multiColorUi.canvas, 41, 35, 25));
multiColorUi.color.value = "#0891b2";
multiColorSender.cb_down(pointerEvent(multiColorUi.canvas, 42, 60, 60));
multiColorSender.cb_move(pointerEvent(multiColorUi.canvas, 42, 80, 75));
multiColorSender.cb_up(pointerEvent(multiColorUi.canvas, 42, 80, 75));
assert.strictEqual(multiColorSender.cb_tool, "pen");
assert.strictEqual(multiColorSender.writes.length, 2);
apply(multiColorReceiver, multiColorSender.writes[1], "@alice.ed25519");
apply(multiColorReceiver, multiColorSender.writes[0], "@alice.ed25519");
assert.deepStrictEqual(
    snapshot(multiColorReceiver).map(function (item) { return item.color; }),
    ["#dc2626", "#0891b2"]
);

// Panning changes only the camera. Drawing and editing still use shared world
// coordinates, so another device replays the exact same object and transform.
const worldSender = loadBoard();
const worldReceiver = loadBoard();
const worldUi = pointerHarness(worldSender, "#2563eb");
worldSender.cb_set_tool("select");
worldSender.cb_down(pointerEvent(worldUi.canvas, 51, 100, 100));
worldSender.cb_move(pointerEvent(worldUi.canvas, 51, 70, 80));
worldSender.cb_up(pointerEvent(worldUi.canvas, 51, 70, 80));
assert.deepStrictEqual(JSON.parse(JSON.stringify(worldSender.cb_cam)), { x: 30, y: 20 });
assert.strictEqual(worldSender.writes.length, 0);

worldSender.cb_set_tool("pen");
worldSender.cb_down(pointerEvent(worldUi.canvas, 52, 10, 20));
worldSender.cb_move(pointerEvent(worldUi.canvas, 52, 30, 40));
worldSender.cb_up(pointerEvent(worldUi.canvas, 52, 30, 40));
assert.deepStrictEqual(JSON.parse(JSON.stringify(worldSender.writes[0].p)), [
    [40, 40], [60, 60]
]);
apply(worldReceiver, worldSender.writes[0], "@alice.ed25519");

worldSender.cb_set_tool("select");
worldSender.cb_down(pointerEvent(worldUi.canvas, 53, 20, 20));
worldSender.cb_move(pointerEvent(worldUi.canvas, 53, 50, 45));
worldSender.cb_up(pointerEvent(worldUi.canvas, 53, 50, 45));
assert.strictEqual(worldSender.writes[1].k, "m");
assert.deepStrictEqual(
    { dx: worldSender.writes[1].dx, dy: worldSender.writes[1].dy },
    { dx: 30, dy: 25 }
);
apply(worldReceiver, worldSender.writes[1], "@alice.ed25519");
assert.deepStrictEqual(snapshot(worldReceiver)[0].transform, { dx: 30, dy: 25, sc: 1 });

// Camera bounds reject garbage coordinates at either edge of the world plane.
worldSender.cb_cam.x = 99999999;
worldSender.cb_cam.y = -99999999;
worldSender.cb_clamp_camera(worldUi.canvas);
assert.deepStrictEqual(JSON.parse(JSON.stringify(worldSender.cb_cam)), {
    x: worldSender.CB_COORD_LIMIT - worldUi.canvas.width,
    y: -worldSender.CB_COORD_LIMIT
});

// If pointer capture is unavailable/lost, leaving the canvas still completes a
// valid stroke; secondary touches never start a second simultaneous stroke.
const leaveBoard = loadBoard();
const leaveUi = pointerHarness(leaveBoard, "#2563eb");
leaveBoard.cb_set_tool("pen");
leaveBoard.cb_down(pointerEvent(leaveUi.canvas, 61, 10, 10));
leaveBoard.cb_move(pointerEvent(leaveUi.canvas, 61, 20, 20));
leaveUi.canvas.captured = null;
leaveBoard.cb_leave(pointerEvent(leaveUi.canvas, 61, 25, 25));
assert.strictEqual(leaveBoard.writes.length, 1);
const secondary = pointerEvent(leaveUi.canvas, 62, 30, 30);
secondary.isPrimary = false;
leaveBoard.cb_down(secondary);
assert.strictEqual(leaveBoard.writes.length, 1);

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

// Unicode survives the space-free wire encoding used by the Android bridge.
const unicodeText = "Gr\u00fcezi \ud83d\udc4b \u6f22\u5b57";
const encodedUnicode = validation.cb_enc(unicodeText);
assert.strictEqual(encodedUnicode.includes(" "), false);
assert.strictEqual(validation.cb_dec(encodedUnicode), unicodeText);

// Concurrent last-writer-wins operations also converge when timestamps tie.
const tieMoveA = {
    k: "m", id: "a-tie", ts: 500, t: stroke.id, dx: 5, dy: 5, sc: 1
};
const tieMoveZ = {
    k: "m", id: "z-tie", ts: 500, t: stroke.id, dx: 25, dy: 15, sc: 1.2
};
const tieForward = replay([stroke, tieMoveA, tieMoveZ]);
const tieReverse = replay([tieMoveZ, tieMoveA, stroke]);
assert.deepStrictEqual(snapshot(tieForward), snapshot(tieReverse));
assert.deepStrictEqual(snapshot(tieForward)[0].transform, { dx: 25, dy: 15, sc: 1.2 });

// Persisted board state produces the same result after a WebView/app restart.
const beforeRestart = replay([stroke, olderMove, recolor, text]);
const afterRestart = loadBoard();
afterRestart.tremola.collabboard = JSON.parse(JSON.stringify(beforeRestart.cb_state()));
assert.deepStrictEqual(snapshot(afterRestart), snapshot(beforeRestart));

// Long phone strokes are bounded while keeping their first and final points.
const densePoints = Array.from({ length: 1000 }, function (_, index) {
    return [index, index % 101];
});
const simplePoints = validation.cb_simplify_points(densePoints, 160);
assert.strictEqual(simplePoints.length, 160);
assert.deepStrictEqual(JSON.parse(JSON.stringify(simplePoints[0])), densePoints[0]);
assert.deepStrictEqual(
    JSON.parse(JSON.stringify(simplePoints[simplePoints.length - 1])),
    densePoints[densePoints.length - 1]
);

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

function modeButton() {
    return {
        active: false,
        pressed: "false",
        classList: {
            toggle: function (name, value) {
                if (name === "cb_active") this.owner.active = value;
            },
            owner: null
        },
        setAttribute: function (name, value) {
            if (name === "aria-pressed") this.pressed = value;
        }
    };
}

const modeBoard = loadBoard();
const penButton = modeButton();
const textButton = modeButton();
const editButton = modeButton();
penButton.classList.owner = penButton;
textButton.classList.owner = textButton;
editButton.classList.owner = editButton;
modeBoard.document.getElementById = function (id) {
    if (id === "cb_tool_pen") return penButton;
    if (id === "cb_tool_text") return textButton;
    if (id === "cb_tool_select") return editButton;
    return null;
};
modeBoard.cb_set_tool("pen");
assert.strictEqual(penButton.active, true);
assert.strictEqual(penButton.pressed, "true");
assert.strictEqual(editButton.active, false);
modeBoard.cb_toggle_tool("pen");
assert.strictEqual(modeBoard.cb_tool, "select");
assert.strictEqual(penButton.active, false);
assert.strictEqual(editButton.active, true);
assert.strictEqual(editButton.pressed, "true");

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

// The canvas must fit Tremola even in a short split-screen/landscape WebView.
const fitBoard = loadBoard();
const fitCanvas = {
    width: 340,
    height: 460,
    style: {},
    getBoundingClientRect: function () { return { top: 182 }; }
};
let fitRedraws = 0;
fitBoard.document.getElementById = function (id) {
    if (id === "cb_canvas") return fitCanvas;
    if (id === "div:collabboard-main") return { clientWidth: 800 };
    if (id === "core") {
        return { getBoundingClientRect: function () { return { bottom: 293 }; } };
    }
    return null;
};
fitBoard.cb_redraw = function () { fitRedraws += 1; };
fitBoard.cb_fit_canvas();
assert.deepStrictEqual(
    { width: fitCanvas.width, height: fitCanvas.height },
    { width: 790, height: 103 }
);
assert.strictEqual(fitCanvas.style.width, "790px");
assert.strictEqual(fitCanvas.style.height, "103px");
assert.ok(182 + fitCanvas.height <= 293 - 8);
assert.strictEqual(fitRedraws, 1);

// State growth is bounded for long-running boards and repeated BLE replay.
const boundedBoard = loadBoard();
const boundedState = boundedBoard.cb_state();
boundedState.objects = Array.from({ length: 1505 }, function (_, index) {
    return { k: "s", id: "object-" + index, ts: index, p: [[index, 0]], c: "#2563eb" };
});
boundedState.deletes = Array.from({ length: 2005 }, function (_, index) {
    return { k: "d", id: "delete-" + index, ts: index, t: "deleted-" + index };
});
boundedState.mods = Array.from({ length: 2005 }, function (_, index) {
    return { k: "m", id: "mod-" + index, ts: index, t: "target-" + index, dx: 0, dy: 0, sc: 1 };
});
boundedState.seen = Array.from({ length: 4005 }, function (_, index) {
    return "seen-" + index;
});
boundedBoard.cb_prune_state(boundedState);
assert.strictEqual(boundedState.objects.length, boundedBoard.CB_MAX_OBJECTS);
assert.strictEqual(boundedState.deletes.length, boundedBoard.CB_MAX_DELETES);
assert.strictEqual(boundedState.mods.length, boundedBoard.CB_MAX_MODS);
assert.strictEqual(boundedState.seen.length, boundedBoard.CB_MAX_SEEN);
assert.strictEqual(boundedState.objects[0].id, "object-5");
assert.strictEqual(boundedState.seen[0], "seen-5");

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

// Any peer may delete an object created by another feed.
apply(sharedBoard, { k: "d", id: "bob-delete-1", ts: 425, t: stroke.id }, bob);
assert.deepStrictEqual(
    snapshot(sharedBoard).map(function (item) { return item.id; }),
    ["bob-text-1"]
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
assert.strictEqual(migrated.schema, 3);
assert.deepStrictEqual(migrated.objects.map(function (item) { return item.id; }), [stroke.id]);
assert.deepStrictEqual(migrated.clears, []);
assert.deepStrictEqual(migrated.mods, []);
assert.strictEqual(Object.prototype.hasOwnProperty.call(migrated, "mode"), false);
assert.strictEqual(Object.prototype.hasOwnProperty.call(migrated, "profiles"), false);
assert.strictEqual(migrated.deletes.length, 0);

const boardMarkup = fs.readFileSync(
    path.join(root, "miniApps/collabboard/resources/board.html"),
    "utf8"
);
assert.strictEqual(boardMarkup.includes("cb_mode_switch"), false);
assert.strictEqual(boardMarkup.includes("cb_profile"), false);
assert.strictEqual(boardMarkup.includes("type='color'"), true);
assert.strictEqual(boardMarkup.includes("cb_tool_select"), true);
assert.strictEqual(boardMarkup.includes("cb_delete_btn"), true);

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
