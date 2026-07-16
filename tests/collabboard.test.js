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

function loadBoard(options) {
    options = options || {};
    const writes = [];
    const commands = [];
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
    if (options.android) {
        context.Android = {};
        context.backend = function (command) { commands.push(command); };
    }
    context.window = context;
    context.window.top = context;
    vm.createContext(context);
    vm.runInContext(source, context, { filename: "collabboard.js" });
    context.writes = writes;
    context.commands = commands;
    return context;
}

function fakeClassList() {
    const values = new Set();
    return {
        add: function (name) { values.add(name); },
        remove: function (name) { values.delete(name); },
        toggle: function (name, enabled) {
            if (enabled) values.add(name);
            else values.delete(name);
        },
        contains: function (name) { return values.has(name); }
    };
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

function replayNames(events) {
    const board = loadBoard();
    board.tremola.collabboardRoom = {
        r: "named-room", k: "n".repeat(43), o: board.myId,
        u: "Alice", b: "Board", p: "482913"
    };
    events.forEach(function (event) { board.cb_apply(event); });
    return board;
}
const firstName = { k: "n", id: "name-100", ts: 100, l: 100, b: "First name" };
const finalName = { k: "n", id: "name-200", ts: 200, l: 200, b: "DPI Project" };
const namesForward = replayNames([firstName, finalName]);
const namesReverse = replayNames([finalName, firstName]);
assert.strictEqual(namesForward.tremola.collabboardRoom.b, "DPI Project");
assert.strictEqual(namesReverse.tremola.collabboardRoom.b, "DPI Project");
assert.strictEqual(namesForward.cb_state().names.length, 2);

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
    focus: function () {},
    blur: function () {}
};
immediateTextBoard.document.getElementById = function (id) {
    if (id === "cb_text") return immediateTextInput;
    if (id === "cb_color") return { value: "#2563eb" };
    return null;
};
immediateTextBoard.cb_tool = "text";
immediateTextBoard.cb_place_text([30, 40]);
assert.strictEqual(immediateTextBoard.writes.length, 1);
assert.strictEqual(immediateTextBoard.cb_tool, "select");
assert.strictEqual(immediateTextBoard.cb_sel, immediateTextBoard.writes[0].id);
assert.strictEqual(snapshot(immediateTextBoard).length, 1);
apply(immediateTextBoard, immediateTextBoard.writes[0], "@alice.ed25519");
assert.strictEqual(snapshot(immediateTextBoard).length, 1);

// Android's keyboard Go action hides the keyboard without placing the text.
// The next board tap still uses the active text tool.
const textGoBoard = loadBoard();
let textBlurred = 0;
let canvasFocused = 0;
const textGoInput = {
    value: "Place me", style: {}, focus: function () {},
    blur: function () { textBlurred += 1; }
};
textGoBoard.document.getElementById = function (id) {
    if (id === "cb_text") return textGoInput;
    if (id === "cb_canvas") return { focus: function () { canvasFocused += 1; } };
    return null;
};
textGoBoard.cb_tool = "text";
let goPrevented = 0;
textGoBoard.cb_text_keydown({
    key: "Enter",
    preventDefault: function () { goPrevented += 1; }
});
assert.strictEqual(goPrevented, 1);
assert.strictEqual(textBlurred, 1);
assert.strictEqual(canvasFocused, 1);
assert.strictEqual(textGoBoard.cb_tool, "text");
assert.strictEqual(textGoInput.value, "Place me");
assert.strictEqual(textGoBoard.writes.length, 0);

// Shared text is large enough to remain readable after the 900-wide board is
// fitted to a phone screen, and its selection box uses the same dimensions.
const textPaint = loadBoard();
const textPaintContext = {
    font: "",
    fillStyle: "",
    textBaseline: "",
    save: function () {},
    restore: function () {},
    fillText: function () {},
    measureText: function () { return { width: 72 }; }
};
textPaint.cb_draw_text(textPaintContext, text, { dx: 0, dy: 0, sc: 1 }, "#000000");
assert.strictEqual(textPaintContext.font, "36px sans-serif");
assert.strictEqual(textPaint.cb_bbox_for_xf(
    textPaintContext,
    text,
    { dx: 0, dy: 0, sc: 1 }
).h, 42);

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
assert.strictEqual(gestureSender.writes.length, 5);
gestureSender.cb_up(pointerEvent(gestureUi.canvas, 34, 90, 80));
assert.strictEqual(gestureSender.writes[5].k, "t");
assert.strictEqual(gestureSender.cb_tool, "select");
assert.strictEqual(gestureSender.cb_sel, gestureSender.writes[5].id);
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

// Empty-space drags do not move the finite board. Drawing and editing use the
// same fixed coordinates on every device.
const worldSender = loadBoard();
const worldReceiver = loadBoard();
const worldUi = pointerHarness(worldSender, "#2563eb");
worldSender.cb_set_tool("select");
worldSender.cb_down(pointerEvent(worldUi.canvas, 51, 100, 100));
worldSender.cb_move(pointerEvent(worldUi.canvas, 51, 70, 80));
worldSender.cb_up(pointerEvent(worldUi.canvas, 51, 70, 80));
assert.deepStrictEqual(JSON.parse(JSON.stringify(worldSender.cb_cam)), { x: 0, y: 0 });
assert.strictEqual(worldSender.writes.length, 0);

worldSender.cb_set_tool("pen");
worldSender.cb_down(pointerEvent(worldUi.canvas, 52, 10, 20));
worldSender.cb_move(pointerEvent(worldUi.canvas, 52, 30, 40));
worldSender.cb_up(pointerEvent(worldUi.canvas, 52, 30, 40));
assert.deepStrictEqual(JSON.parse(JSON.stringify(worldSender.writes[0].p)), [
    [10, 20], [30, 40]
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

// The removed camera remains fixed even when old state contains bad values.
worldSender.cb_cam.x = 99999999;
worldSender.cb_cam.y = -99999999;
worldSender.cb_clamp_camera(worldUi.canvas);
assert.deepStrictEqual(JSON.parse(JSON.stringify(worldSender.cb_cam)), { x: 0, y: 0 });

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

// Android WebView may cancel or lose pointer capture after visible movement.
// Completed-looking work is committed instead of disappearing without a log.
const cancelBoard = loadBoard();
const cancelUi = pointerHarness(cancelBoard, "#2563eb");
cancelBoard.cb_set_tool("pen");
cancelBoard.cb_down(pointerEvent(cancelUi.canvas, 63, 10, 10));
cancelBoard.cb_move(pointerEvent(cancelUi.canvas, 63, 30, 30));
cancelBoard.cb_cancel(pointerEvent(cancelUi.canvas, 63, 30, 30));
assert.strictEqual(cancelBoard.writes.length, 1);
assert.strictEqual(cancelBoard.writes[0].k, "s");

const lostCaptureBoard = loadBoard();
const lostCaptureUi = pointerHarness(lostCaptureBoard, "#2563eb");
lostCaptureBoard.cb_set_tool("pen");
lostCaptureBoard.cb_down(pointerEvent(lostCaptureUi.canvas, 64, 10, 10));
lostCaptureBoard.cb_move(pointerEvent(lostCaptureUi.canvas, 64, 20, 20));
lostCaptureBoard.cb_lost_capture(pointerEvent(lostCaptureUi.canvas, 64, 20, 20));
assert.strictEqual(lostCaptureBoard.writes.length, 1);

const cancelMoveBoard = loadBoard();
const cancelMoveUi = pointerHarness(cancelMoveBoard, "#2563eb");
apply(cancelMoveBoard, {
    k: "s", id: "cancel-move", ts: 3, c: "#2563eb", w: 2, p: [[20, 20], [40, 40]]
}, "@alice.ed25519");
cancelMoveBoard.cb_set_tool("select");
cancelMoveBoard.cb_down(pointerEvent(cancelMoveUi.canvas, 65, 25, 25));
cancelMoveBoard.cb_move(pointerEvent(cancelMoveUi.canvas, 65, 40, 35));
cancelMoveBoard.cb_cancel(pointerEvent(cancelMoveUi.canvas, 65, 40, 35));
assert.strictEqual(cancelMoveBoard.writes.length, 1);
assert.strictEqual(cancelMoveBoard.writes[0].k, "m");

// Two fingers navigate in every editing tool. Starting the gesture cancels the
// unfinished one-finger action so it cannot leave an accidental dot or label.
const editNavBoard = loadBoard();
const editNavUi = pointerHarness(editNavBoard, "#2563eb");
const editNavFrame = {
    style: {}, clientWidth: 320, clientHeight: 240,
    getBoundingClientRect: function () {
        return { left: 0, top: 0, width: 320, height: 240 };
    }
};
const editNavLookup = editNavBoard.document.getElementById;
editNavBoard.document.getElementById = function (id) {
    if (id === "cb_canvas_frame") return editNavFrame;
    return editNavLookup(id);
};
editNavBoard.cb_edit_view = {
    scale: 1 / 3, x: 10, y: 0, fit: 1 / 3,
    minScale: 0.1, maxScale: 2, width: 320, height: 240, initialized: true
};
editNavBoard.cb_set_tool("pen");
editNavBoard.cb_down(pointerEvent(editNavUi.canvas, 71, 90, 90));
assert.ok(editNavBoard.cb_draft);
const secondNavDown = pointerEvent(editNavUi.canvas, 72, 190, 90);
secondNavDown.isPrimary = false;
editNavBoard.cb_down(secondNavDown);
assert.strictEqual(editNavBoard.cb_draft, null);
assert.strictEqual(editNavBoard.cb_edit_navigation, true);
const secondNavMove = pointerEvent(editNavUi.canvas, 72, 260, 90);
secondNavMove.isPrimary = false;
editNavBoard.cb_move(secondNavMove);
assert.ok(editNavBoard.cb_edit_view.scale > 1 / 3);
editNavBoard.cb_up(secondNavMove);
editNavBoard.cb_up(pointerEvent(editNavUi.canvas, 71, 90, 90));
assert.strictEqual(editNavBoard.writes.length, 0);
assert.strictEqual(editNavBoard.cb_edit_navigation, false);

editNavUi.textInput.value = "Do not place";
editNavBoard.cb_set_tool("text");
editNavBoard.cb_down(pointerEvent(editNavUi.canvas, 73, 80, 80));
const textNavSecond = pointerEvent(editNavUi.canvas, 74, 180, 80);
textNavSecond.isPrimary = false;
editNavBoard.cb_down(textNavSecond);
editNavBoard.cb_up(textNavSecond);
editNavBoard.cb_up(pointerEvent(editNavUi.canvas, 73, 80, 80));
assert.strictEqual(editNavBoard.writes.length, 0);

editNavBoard.cb_set_tool("pen");
editNavBoard.cb_down(pointerEvent(editNavUi.canvas, 75, 80, 80));
const lostNavSecond = pointerEvent(editNavUi.canvas, 76, 180, 80);
lostNavSecond.isPrimary = false;
editNavBoard.cb_down(lostNavSecond);
editNavBoard.cb_lost_capture(lostNavSecond);
editNavBoard.cb_lost_capture(pointerEvent(editNavUi.canvas, 75, 80, 80));
assert.strictEqual(editNavBoard.cb_edit_navigation, false);
assert.strictEqual(editNavBoard.writes.length, 0);

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

// Lamport order wins even when phone wall clocks disagree. Arrival order does
// not change the result, and a later local event advances past remote order.
const skewedObject = {
    k: "s", id: "skew-object", ts: 900000, l: 10, c: "#2563eb", w: 2,
    p: [[10, 10], [20, 20]]
};
const skewedClear = { k: "c", id: "skew-clear", ts: 1, l: 11 };
assert.deepStrictEqual(snapshot(replay([skewedObject, skewedClear])), []);
assert.deepStrictEqual(snapshot(replay([skewedClear, skewedObject])), []);

const lamportSender = loadBoard();
apply(lamportSender, {
    k: "s", id: "remote-order", ts: 2, l: 75, c: "#2563eb", w: 2,
    p: [[1, 1], [2, 2]]
}, "@alice.ed25519");
lamportSender.cb_clear();
assert.strictEqual(lamportSender.writes[0].l, 76);

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

// Initial Room/BLE replay is reduced to current state before the canvas is
// shown. Old objects hidden by Clear never flash on screen.
const replayBatchBoard = loadBoard({ android: true });
replayBatchBoard.tremola.collabboardRoom = {
    r: "batch-room", k: "b".repeat(43), o: replayBatchBoard.myId,
    u: "Alice", b: "Batch board", p: "482913"
};
const replayWorkspace = { classList: fakeClassList() };
const replayOverlay = { style: { display: "none" } };
replayBatchBoard.document.getElementById = function (id) {
    if (id === "cb_workspace") return replayWorkspace;
    if (id === "cb_board_loading") return replayOverlay;
    return null;
};
let replayRedraws = 0;
let replayPersists = 0;
replayBatchBoard.cb_redraw = function () { replayRedraws += 1; };
replayBatchBoard.persist = function () { replayPersists += 1; };
replayBatchBoard.cb_begin_board_replay("join");
replayBatchBoard.cb_replay_native_done = true;
replayBatchBoard.cb_apply(stroke);
replayBatchBoard.cb_apply({ k: "c", id: "batch-clear", ts: 150, l: 150 });
replayBatchBoard.cb_apply(text);
assert.strictEqual(replayRedraws, 0);
assert.strictEqual(replayPersists, 0);
assert.strictEqual(replayWorkspace.classList.contains("cb_replay_loading"), true);
replayBatchBoard.cb_finish_board_replay();
assert.strictEqual(replayRedraws, 1);
assert.strictEqual(replayPersists, 1);
assert.deepStrictEqual(snapshot(replayBatchBoard).map(function (item) {
    return item.id;
}), [text.id]);
assert.strictEqual(replayWorkspace.classList.contains("cb_replay_loading"), false);
assert.strictEqual(replayOverlay.style.display, "none");

// Android's keyboard changes the available height, but not the width. The
// canvas keeps a useful stable size instead of collapsing while typing.
const fitBoard = loadBoard();
const fitCanvas = {
    width: 340,
    height: 460,
    style: {},
    getBoundingClientRect: function () { return { top: 182 }; }
};
const fitFrame = {
    style: {}, classList: fakeClassList(), clientWidth: 790, clientHeight: 620,
    getBoundingClientRect: function () { return { width: 790, height: 620 }; }
};
let fitRedraws = 0;
fitBoard.document.getElementById = function (id) {
    if (id === "cb_canvas") return fitCanvas;
    if (id === "cb_canvas_frame") return fitFrame;
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
    { width: 1800, height: 2400 }
);
assert.strictEqual(fitFrame.style.height, "");
assert.strictEqual(fitFrame.style.flexBasis, "");
assert.strictEqual(fitBoard.cb_edit_view.height, 620);
assert.strictEqual(fitCanvas.style.width, "1800px");
assert.strictEqual(fitCanvas.style.height, "2400px");
assert.strictEqual(fitCanvas.style.transform.includes("scale(0.877"), true);
assert.strictEqual(fitRedraws, 1);
fitCanvas.getBoundingClientRect = function () { return { top: 250 }; };
fitBoard.cb_fit_canvas();
assert.strictEqual(fitFrame.style.height, "");

// Panning stops exactly at the finite canvas edge. No dead strip outside the
// drawable area can be exposed in edit or full-board view.
assert.strictEqual(fitBoard.cb_clamp_view_axis(20, 300, 600), 0);
assert.strictEqual(fitBoard.cb_clamp_view_axis(-500, 300, 600), -300);
assert.strictEqual(fitBoard.cb_clamp_view_axis(-120, 300, 600), -120);
assert.strictEqual(fitBoard.cb_clamp_view_axis(0, 600, 300), 150);

// Two differently sized phones map the same relative touch to the same shared
// finite-board coordinate.
const scaleBoard = loadBoard();
const smallCanvas = {
    width: 1800, height: 2400,
    getBoundingClientRect: function () { return { left: 0, top: 0, width: 600, height: 800 }; }
};
const largeCanvas = {
    width: 1800, height: 2400,
    getBoundingClientRect: function () { return { left: 0, top: 0, width: 900, height: 1200 }; }
};
assert.deepStrictEqual(
    JSON.parse(JSON.stringify(scaleBoard.cb_screen_pos(smallCanvas, { clientX: 150, clientY: 200 }))),
    [450, 600]
);
assert.deepStrictEqual(
    JSON.parse(JSON.stringify(scaleBoard.cb_screen_pos(largeCanvas, { clientX: 225, clientY: 300 }))),
    [450, 600]
);

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

// Every local operation receives board, author-name, and Lamport metadata.
const compatibility = loadBoard();
compatibility.cb_write_board_event({
    k: "s", id: "max-open-1", ts: 10, c: "#2563eb", w: 2,
    p: [[1, 1], [3, 3]]
}, false);
assert.deepStrictEqual(compatibility.writes[0], {
    k: "s", id: "max-open-1", ts: 10, c: "#2563eb", w: 2,
    p: [[1, 1], [3, 3]], r: "browser-preview", u: "Preview", l: 1
});

// Android sends the same compact event through the native board bridge.
const androidBoard = loadBoard({ android: true });
androidBoard.tremola.collabboardRoom = {
    v: 1, r: "android-room", k: "room-key", o: "@owner.ed25519", u: "Dehlen"
};
androidBoard.cb_native_config_pending = false;
androidBoard.cb_write_board_event({
    k: "t", id: "android-text", ts: 20, c: "#2563eb", x: 10, y: 20, s: "SGk="
}, true);
assert.strictEqual(androidBoard.commands.length, 1);
assert.strictEqual(androidBoard.commands[0].startsWith("collabboard:write "), true);
const androidPayload = JSON.parse(Buffer.from(
    androidBoard.commands[0].slice("collabboard:write ".length), "base64"
).toString("utf8"));
assert.strictEqual(androidPayload.r, "android-room");
assert.strictEqual(androidPayload.u, "Dehlen");
assert.strictEqual(androidPayload.l, 1);
assert.strictEqual(snapshot(androidBoard).length, 1);

// Android uses the native clipboard so invite copy also works on old WebViews.
const inviteBoard = loadBoard({ android: true });
inviteBoard.tremola.collabboardRoom = {
    v: 1, r: "invite-room", k: "invite-room-key",
    o: inviteBoard.myId, u: "Alice", p: "123456"
};
let copiedInvite = "";
inviteBoard.Android.copyCollaborationBoardInvite = function (encoded) {
    copiedInvite = Buffer.from(encoded, "base64").toString("utf8");
    return true;
};
inviteBoard.cb_copy_invite();
assert.strictEqual(copiedInvite, "");
assert.strictEqual(inviteBoard.commands.length, 1);
assert.strictEqual(inviteBoard.commands[0].startsWith("collabboard:pairing "), true);
assert.strictEqual(Buffer.from(
    inviteBoard.commands[0].slice("collabboard:pairing ".length), "base64"
).toString("utf8"), "123456");
inviteBoard.cb_pairing_started(true, 600);
assert.strictEqual(copiedInvite, "123456");

const directInviteBoard = loadBoard({ android: true });
directInviteBoard.tremola.collabboardRoom = {
    v: 1, r: "code-654321-v1", k: "direct-room-key",
    o: directInviteBoard.myId, u: "Alice", p: "654321", d: 1
};
let copiedDirectCode = "";
directInviteBoard.Android.copyCollaborationBoardInvite = function (encoded) {
    copiedDirectCode = Buffer.from(encoded, "base64").toString("utf8");
    return true;
};
directInviteBoard.cb_copy_invite();
assert.strictEqual(copiedDirectCode, "654321");
assert.strictEqual(directInviteBoard.commands.length, 0);

const uniqueCodeBoard = loadBoard();
uniqueCodeBoard.tremola.collabboardBoards = {
    one: { room: { p: "123456" }, updated: 1 }
};
let codeAttempt = 0;
uniqueCodeBoard.cb_random_pairing_code = function () {
    codeAttempt += 1;
    return codeAttempt === 1 ? "123456" : "654321";
};
assert.strictEqual(uniqueCodeBoard.cb_new_pairing_code(), "654321");

// Reopening through the six-digit code must not replace a known board name
// with the generated direct-access fallback.
const stableNameBoard = loadBoard();
stableNameBoard.tremola.collabboardBoards = {
    "code-482913-v1": {
        room: {
            r: "code-482913-v1", k: "k".repeat(43), o: stableNameBoard.myId,
            u: "Alice", b: "DPI Project", p: "482913"
        },
        updated: 1
    }
};
stableNameBoard.cb_remember_room({
    r: "code-482913-v1", k: "k".repeat(43), o: stableNameBoard.myId,
    u: "Alice", b: "Board 482913", p: "482913"
}, true);
assert.strictEqual(
    stableNameBoard.tremola.collabboardBoards["code-482913-v1"].room.b,
    "DPI Project"
);

// Three saved boards remain fixed. The fourth enables a visible scroll area.
const boardList = loadBoard();
const listClass = fakeClassList();
const listShellClass = fakeClassList();
const listElement = {
    classList: listClass,
    clientHeight: 180,
    scrollHeight: 366,
    scrollTop: 0,
    children: [],
    appendChild: function (child) { this.children.push(child); }
};
const listShell = { classList: listShellClass };
const listTrack = { clientHeight: 166, style: {} };
const listThumb = { style: {} };
Object.defineProperty(listElement, "textContent", {
    set: function () { this.children = []; }
});
boardList.tremola.collabboardBoards = {};
for (let boardIndex = 0; boardIndex < 4; boardIndex += 1) {
    const roomId = "saved-room-" + boardIndex;
    boardList.tremola.collabboardBoards[roomId] = {
        room: { r: roomId, b: "Board " + boardIndex }, updated: boardIndex
    };
}
boardList.document.getElementById = function (id) {
    if (id === "cb_saved_boards") return listElement;
    if (id === "cb_saved_boards_shell") return listShell;
    if (id === "cb_saved_scrollbar") return listTrack;
    if (id === "cb_saved_scroll_thumb") return listThumb;
    return null;
};
boardList.document.createElement = function () {
    return {
        appendChild: function () {},
        className: "",
        textContent: "",
        type: "",
        onclick: null
    };
};
boardList.cb_render_board_list();
assert.strictEqual(listClass.contains("cb_saved_boards_scroll"), true);
assert.strictEqual(listShellClass.contains("cb_saved_boards_has_scroll"), true);
assert.strictEqual(listElement.children.length, 4);
assert.strictEqual(listTrack.style.display, "block");
assert.strictEqual(listThumb.style.height, "82px");
assert.strictEqual(listThumb.style.transform, "translateY(0px)");
listElement.scrollTop = 186;
boardList.cb_update_board_scrollbar();
assert.strictEqual(listThumb.style.transform, "translateY(84px)");
delete boardList.tremola.collabboardBoards["saved-room-3"];
boardList.cb_render_board_list();
assert.strictEqual(listClass.contains("cb_saved_boards_scroll"), false);
assert.strictEqual(listShellClass.contains("cb_saved_boards_has_scroll"), false);
assert.strictEqual(listTrack.style.display, "none");

// Equal board names ignore surrounding and collapsed whitespace. Their
// local labels receive all eight palette colors once before creation is full.
const boardColors = loadBoard();
boardColors.tremola.collabboardBoards = {};
for (let colorIndex = 0; colorIndex < 8; colorIndex += 1) {
    const roomId = "same-name-room-" + colorIndex;
    const names = ["DPI Project", "  DPI Project  ", "DPI   Project"];
    boardColors.tremola.collabboardBoards[roomId] = {
        room: { r: roomId, b: names[colorIndex % names.length] },
        updated: colorIndex + 1
    };
}
assert.strictEqual(boardColors.cb_reconcile_board_colors(), true);
const assignedColorIndexes = Object.keys(boardColors.tremola.collabboardBoards).map(function (id) {
    return boardColors.tremola.collabboardBoards[id].colorIndex;
});
assert.strictEqual(new Set(assignedColorIndexes).size, 8);
assert.strictEqual(boardColors.cb_reconcile_board_colors(), false);
assert.strictEqual(boardColors.cb_board_name_available(" DPI   Project "), false);
assert.strictEqual(boardColors.cb_board_name_available("Another board"), true);

const blockedNameBoard = loadBoard({ android: true });
blockedNameBoard.tremola.collabboardBoards = {};
for (let usedIndex = 0; usedIndex < 8; usedIndex += 1) {
    const roomId = "used-name-room-" + usedIndex;
    blockedNameBoard.tremola.collabboardBoards[roomId] = {
        room: { r: roomId, b: "Project" }, updated: usedIndex + 1
    };
}
let blockedNameFocus = 0;
const blockedNameError = { textContent: "" };
blockedNameBoard.document.getElementById = function (id) {
    if (id === "cb_username") return { value: "Alice", focus: function () {} };
    if (id === "cb_board_name") {
        return { value: "  Project  ", focus: function () { blockedNameFocus += 1; } };
    }
    if (id === "cb_setup_error") return blockedNameError;
    return null;
};
blockedNameBoard.cb_create_board();
assert.strictEqual(blockedNameBoard.commands.length, 0);
assert.strictEqual(blockedNameFocus, 1);
assert.strictEqual(blockedNameError.textContent, "This board name is already used 8 times");

// Only the board identity text uses its local palette color.
const identityColorBoard = loadBoard();
const identityRoom = {
    r: "identity-color-room", k: "c".repeat(43), o: identityColorBoard.myId,
    u: "Alice", b: "DPI Project", p: "482913"
};
identityColorBoard.tremola.collabboardRoom = identityRoom;
identityColorBoard.tremola.collabboardBoards = {
    "identity-color-room": { room: identityRoom, updated: 1, colorIndex: 3 }
};
const identityLabel = { style: {}, textContent: "" };
const identityCode = { style: {}, textContent: "" };
identityColorBoard.document.getElementById = function (id) {
    if (id === "cb_room_label") return identityLabel;
    if (id === "cb_room_code") return identityCode;
    return null;
};
identityColorBoard.cb_update_room_bar();
assert.strictEqual(identityLabel.style.color, "#7c3aed");
assert.strictEqual(identityCode.style.color, "#7c3aed");
assert.strictEqual(identityCode.textContent, "Code 482913");

const resumeBoard = loadBoard();
resumeBoard.cb_resume_room_id = "resume-room";
resumeBoard.cb_resume_until = 31000;
assert.strictEqual(resumeBoard.cb_should_quick_resume("resume-room", 1000), true);
assert.strictEqual(resumeBoard.cb_should_quick_resume("resume-room", 31001), false);
assert.strictEqual(resumeBoard.cb_should_quick_resume("another-room", 1000), false);

// Creating generates a six-digit code and asks Android to open its deterministic
// room directly. There is no owner-pairing wait.
const createBoard = loadBoard({ android: true });
const createName = { value: "Alice", focus: function () {} };
const createBoardName = { value: "DPI Project", focus: function () {} };
createBoard.cb_random_pairing_code = function () { return "482913"; };
createBoard.document.getElementById = function (id) {
    if (id === "cb_username") return createName;
    if (id === "cb_board_name") return createBoardName;
    return null;
};
createBoard.cb_create_board();
assert.strictEqual(createBoard.commands[0].startsWith("collabboard:open-code "), true);
const createRequest = JSON.parse(Buffer.from(
    createBoard.commands[0].slice("collabboard:open-code ".length), "base64"
).toString("utf8"));
assert.deepStrictEqual(createRequest, { u: "Alice", c: "482913", b: "DPI Project" });
assert.strictEqual(createBoard.cb_current_room(), null);
createBoard.cb_board_code_opened(JSON.stringify({
    r: "code-482913-v1", k: "a".repeat(43), o: createBoard.myId,
    u: "Alice", b: "DPI Project", p: "482913", d: 1
}));
const generatedCode = createBoard.tremola.collabboardRoom.p;
assert.strictEqual(generatedCode, "482913");
assert.strictEqual(createBoard.tremola.collabboardRoom.b, "DPI Project");
assert.strictEqual(createBoard.cb_native_config_pending, false);
const createdRoomId = createBoard.tremola.collabboardRoom.r;
assert.strictEqual(
    createBoard.tremola.collabboardBoards[createdRoomId].room.b,
    "DPI Project"
);
assert.strictEqual(createBoard.commands.includes("collabboard:read"), true);
assert.strictEqual(createBoard.commands.some(function (command) {
    return command.startsWith("collabboard:pairing ");
}), false);
createBoard.cb_board_replay_complete();
createBoard.cb_finish_board_replay();
const nameWrite = createBoard.commands.find(function (command) {
    return command.startsWith("collabboard:write ");
});
assert.ok(nameWrite);
assert.strictEqual(JSON.parse(Buffer.from(
    nameWrite.slice("collabboard:write ".length), "base64"
).toString("utf8")).b, "DPI Project");
assert.strictEqual(createBoard.cb_state().names.length, 1);
createBoard.cb_close_board();
assert.strictEqual(createBoard.tremola.collabboardRoom, undefined);
assert.strictEqual(createBoard.tremola.collabboard, undefined);
assert.strictEqual(createBoard.commands.includes("collabboard:close"), true);
assert.strictEqual(createBoard.tremola.collabboardBoards[createdRoomId].room.b, "DPI Project");
createBoard.cb_open_saved_board(createdRoomId);
assert.strictEqual(createBoard.tremola.collabboardRoom.r, createdRoomId);
assert.strictEqual(createBoard.tremola.collabboardRoom.b, "DPI Project");
const createdOwner = createBoard.tremola.collabboardRoom.o;
const createdKey = createBoard.tremola.collabboardRoom.k;
createBoard.cb_close_board();
createName.value = "Alicia";
createBoard.cb_open_saved_board(createdRoomId);
assert.strictEqual(createBoard.tremola.collabboardRoom.u, "Alicia");
assert.strictEqual(createBoard.tremola.collabboardRoom.o, createdOwner);
assert.strictEqual(createBoard.tremola.collabboardRoom.k, createdKey);
const renamedConfig = JSON.parse(Buffer.from(
    createBoard.commands.filter(function (command) {
        return command.startsWith("collabboard:configure ");
    }).slice(-1)[0].slice("collabboard:configure ".length),
    "base64"
).toString("utf8"));
assert.strictEqual(renamedConfig.u, "Alicia");

// Deleting a saved board is local and requires the code used for pairing.
const deleteBoard = loadBoard();
deleteBoard.cb_activate_room({
    v: 1, r: "delete-room-1", k: "d".repeat(43),
    o: deleteBoard.myId, u: "Alice", b: "Delete me", p: "135790"
});
deleteBoard.cb_close_board();
const deletePanel = { style: {} };
const deleteName = { textContent: "" };
const deleteCode = { value: "", focus: function () {} };
const deleteButton = { disabled: false };
const deleteError = { textContent: "" };
deleteBoard.document.getElementById = function (id) {
    if (id === "cb_delete_panel") return deletePanel;
    if (id === "cb_delete_name") return deleteName;
    if (id === "cb_delete_code") return deleteCode;
    if (id === "cb_delete_board_btn") return deleteButton;
    if (id === "cb_delete_error") return deleteError;
    return null;
};
deleteBoard.cb_request_delete_board("delete-room-1");
deleteCode.value = "000000";
deleteBoard.cb_confirm_delete_board();
assert.strictEqual(deleteError.textContent, "Wrong code");
assert.ok(deleteBoard.tremola.collabboardBoards["delete-room-1"]);
deleteCode.value = "135790";
deleteBoard.cb_confirm_delete_board();
assert.strictEqual(deleteBoard.tremola.collabboardBoards["delete-room-1"], undefined);

const nativeDeleteBoard = loadBoard({ android: true });
nativeDeleteBoard.tremola.collabboardBoards = {
    "native-delete-room": {
        room: {
            v: 1, r: "native-delete-room", k: "n".repeat(43),
            o: nativeDeleteBoard.myId, u: "Alice", b: "Native", p: "246802"
        },
        updated: 1
    }
};
nativeDeleteBoard.document.getElementById = deleteBoard.document.getElementById;
nativeDeleteBoard.cb_request_delete_board("native-delete-room");
deleteCode.value = "246802";
nativeDeleteBoard.cb_confirm_delete_board();
const deleteCommand = nativeDeleteBoard.commands[0];
assert.strictEqual(deleteCommand.startsWith("collabboard:delete "), true);
assert.deepStrictEqual(JSON.parse(Buffer.from(
    deleteCommand.slice("collabboard:delete ".length), "base64"
).toString("utf8")).c, "246802");

// The browser preview has no Android Room database, so it keeps each board's
// state in the local board catalog and restores it when the board is reopened.
const browserSavedBoard = loadBoard();
browserSavedBoard.cb_activate_room({
    v: 1, r: "browser-saved-room", k: "k".repeat(43),
    o: browserSavedBoard.myId, u: "Alice", b: "Saved board", p: "482913"
});
apply(browserSavedBoard, {
    k: "t", id: "saved-text", ts: 30, c: "#2563eb",
    x: 20, y: 30, s: "U2F2ZWQ="
}, "@alice.ed25519");
browserSavedBoard.cb_close_board();
assert.strictEqual(browserSavedBoard.tremola.collabboard, undefined);
browserSavedBoard.cb_open_saved_board("browser-saved-room");
assert.deepStrictEqual(snapshot(browserSavedBoard).map(function (item) {
    return item.id;
}), ["saved-text"]);

const joinBoard = loadBoard({ android: true });
const joinName = { value: "Bob", focus: function () {} };
const joinCode = { value: "482913", focus: function () {} };
joinBoard.document.getElementById = function (id) {
    if (id === "cb_username") return joinName;
    if (id === "cb_join_code") return joinCode;
    return null;
};
joinBoard.cb_join_board();
assert.strictEqual(joinBoard.commands.length, 1);
assert.strictEqual(joinBoard.commands[0].startsWith("collabboard:open-code "), true);
assert.deepStrictEqual(JSON.parse(Buffer.from(
    joinBoard.commands[0].slice("collabboard:open-code ".length), "base64"
).toString("utf8")), { u: "Bob", c: "482913" });
assert.strictEqual(joinBoard.cb_current_room(), null);
joinBoard.cb_board_code_opened(JSON.stringify({
    r: "code-482913-v1", k: "a".repeat(43), o: joinBoard.myId, u: "Bob",
    b: "Board 482913", p: "482913", d: 1
}));
assert.strictEqual(joinBoard.tremola.collabboardRoom.r, "code-482913-v1");
assert.strictEqual(joinBoard.tremola.collabboardRoom.b, "Board 482913");
assert.strictEqual(joinBoard.tremola.collabboardBoards["code-482913-v1"].room.b, "Board 482913");
assert.strictEqual(joinBoard.tremola.collabboardRoom.p, "482913");
assert.strictEqual(joinBoard.commands.includes("collabboard:read"), true);
assert.strictEqual(joinBoard.cb_native_config_pending, false);
joinBoard.cb_board_replay_complete();
joinBoard.cb_receive_board_operation(JSON.stringify({
    k: "n", id: "owner-name-1", ts: 40, l: 40, b: "DPI Project"
}), "@alice.ed25519", "Alice");
joinBoard.cb_finish_board_replay();
assert.strictEqual(joinBoard.tremola.collabboardRoom.b, "DPI Project");
assert.strictEqual(
    joinBoard.tremola.collabboardBoards["code-482913-v1"].room.b,
    "DPI Project"
);
joinBoard.cb_board_access_rejected("Board is full");
assert.strictEqual(joinBoard.tremola.collabboardRoom, undefined);
assert.strictEqual(joinBoard.tremola.collabboard, undefined);

const invalidJoin = loadBoard({ android: true });
invalidJoin.document.getElementById = function (id) {
    if (id === "cb_username") return { value: "Bob", focus: function () {} };
    if (id === "cb_join_code") return { value: "12345", focus: function () {} };
    return null;
};
invalidJoin.cb_join_board();
assert.strictEqual(invalidJoin.commands.length, 0);

const waitingBoard = loadBoard({ android: true });
waitingBoard.tremola.collabboardRoom = {
    v: 1, r: "waiting-room", k: "room-key", o: "@owner.ed25519", u: "Guest"
};
waitingBoard.cb_native_config_pending = false;
waitingBoard.Android.writeCollaborationBoardEvent = function () { return false; };
waitingBoard.cb_write_board_event({
    k: "c", id: "blocked-clear", ts: 21
}, true);
assert.strictEqual(waitingBoard.commands.length, 0);
assert.strictEqual(waitingBoard.cb_state().seen.length, 0);

// Operations from another room are ignored before they can pollute state.
const isolatedBoard = loadBoard();
apply(isolatedBoard, Object.assign({}, stroke, { id: "wrong-room", r: "another-room" }),
    "@alice.ed25519");
assert.strictEqual(isolatedBoard.cb_state().seen.length, 0);

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

// Four participants converge even when their drawing, move, recolor and text
// operations arrive in different orders on every phone.
const fourPeerEvents = [
    { event: {
        k: "s", id: "alice-four-stroke", ts: 500, l: 500,
        c: "#2563eb", w: 2, p: [[20, 20], [60, 70]]
    }, fid: alice },
    { event: {
        k: "m", id: "bob-four-move", ts: 510, l: 510,
        t: "alice-four-stroke", dx: 30, dy: 15, sc: 1.2
    }, fid: bob },
    { event: {
        k: "k", id: "carol-four-color", ts: 520, l: 520,
        t: "alice-four-stroke", c: "#16a34a"
    }, fid: "@carol.ed25519" },
    { event: {
        k: "t", id: "dave-four-text", ts: 530, l: 530,
        c: "#7c3aed", x: 100, y: 120, s: "Rm91ciBwZWVycyE="
    }, fid: "@dave.ed25519" }
];
const fourPeerOrders = [
    [0, 1, 2, 3], [3, 2, 1, 0], [1, 3, 0, 2], [2, 0, 3, 1]
];
const fourPeerSnapshots = fourPeerOrders.map(function (order) {
    const board = loadBoard();
    order.forEach(function (index) {
        const item = fourPeerEvents[index];
        apply(board, item.event, item.fid);
    });
    return snapshot(board);
});
fourPeerSnapshots.slice(1).forEach(function (value) {
    assert.deepStrictEqual(value, fourPeerSnapshots[0]);
});
assert.deepStrictEqual(fourPeerSnapshots[0][0].transform, { dx: 30, dy: 15, sc: 1.2 });
assert.strictEqual(fourPeerSnapshots[0][0].color, "#16a34a");

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

// Selecting an object reveals the authenticated board username and feed id.
const authorBoard = loadBoard();
const authorInfo = { hidden: true, textContent: "", title: "" };
const authorDelete = { disabled: true };
authorBoard.document.getElementById = function (id) {
    if (id === "cb_selection_info") return authorInfo;
    if (id === "cb_delete_btn") return authorDelete;
    return null;
};
authorBoard.cb_apply(stroke, { fid: alice, tst: stroke.ts, username: "Alice" });
authorBoard.cb_sel = stroke.id;
authorBoard.cb_tool = "select";
authorBoard.cb_update_selection_controls();
assert.strictEqual(authorInfo.hidden, false);
assert.strictEqual(authorInfo.textContent, "By Alice");
assert.strictEqual(authorInfo.title, alice);
assert.strictEqual(authorDelete.disabled, false);
authorBoard.cb_members[alice] = "Alicia";
authorBoard.cb_update_selection_controls();
assert.strictEqual(authorInfo.textContent, "By Alicia");

// Dark canvas is local. Very dark ink becomes white so it remains visible.
const darkBoard = loadBoard();
const darkWorkspace = { classList: fakeClassList() };
const darkButton = {
    classList: fakeClassList(),
    setAttribute: function (name, value) { this[name] = value; }
};
darkBoard.document.getElementById = function (id) {
    if (id === "cb_workspace") return darkWorkspace;
    if (id === "cb_dark_btn") return darkButton;
    return null;
};
darkBoard.cb_redraw = function () {};
darkBoard.cb_toggle_dark();
assert.strictEqual(darkBoard.tremola.collabboardDark, true);
assert.strictEqual(darkWorkspace.classList.contains("cb_dark_canvas"), true);
assert.strictEqual(darkButton["aria-pressed"], "true");
assert.strictEqual(darkBoard.cb_display_color("#000000"), "#ffffff");
assert.strictEqual(darkBoard.cb_display_color("#f5d90a"), "#f5d90a");

// Full-board view fits the finite canvas and supports local two-finger zoom.
const viewBoard = loadBoard();
const viewCanvas = { style: {} };
const viewFrame = {
    id: "cb_canvas_frame",
    clientWidth: 390,
    clientHeight: 780,
    setPointerCapture: function () {},
    getBoundingClientRect: function () { return { width: 390, height: 780 }; }
};
viewBoard.document.getElementById = function (id) {
    if (id === "cb_canvas") return viewCanvas;
    if (id === "cb_canvas_frame") return viewFrame;
    return null;
};
viewBoard.cb_view_mode = true;
viewBoard.cb_reset_view();
const fittedScale = viewBoard.cb_view.scale;
assert.ok(fittedScale > 0);
viewBoard.cb_view_down({
    pointerId: 1, clientX: 100, clientY: 200, currentTarget: viewFrame,
    target: viewFrame, preventDefault: function () {}
});
viewBoard.cb_view_down({
    pointerId: 2, clientX: 200, clientY: 200, currentTarget: viewFrame,
    target: viewFrame, preventDefault: function () {}
});
viewBoard.cb_view_move({
    pointerId: 2, clientX: 300, clientY: 200, currentTarget: viewFrame,
    preventDefault: function () {}
});
assert.ok(viewBoard.cb_view.scale > fittedScale);
assert.ok(viewCanvas.style.transform.includes("scale("));

// Android may report a zero-sized frame on the first View tap. The window
// fallback still produces a visible transform, and later scheduled fits refine it.
const earlyViewBoard = loadBoard();
earlyViewBoard.innerWidth = 390;
earlyViewBoard.innerHeight = 780;
const earlyViewCanvas = { style: {} };
const earlyViewFrame = {
    style: {}, clientWidth: 0, clientHeight: 0,
    getBoundingClientRect: function () { return { width: 0, height: 0 }; }
};
const earlyViewWorkspace = { classList: fakeClassList(), style: {} };
const earlyViewExit = { style: {} };
earlyViewBoard.document.getElementById = function (id) {
    if (id === "cb_canvas") return earlyViewCanvas;
    if (id === "cb_canvas_frame") return earlyViewFrame;
    if (id === "cb_workspace") return earlyViewWorkspace;
    if (id === "cb_view_exit") return earlyViewExit;
    return null;
};
earlyViewBoard.cb_redraw = function () {};
earlyViewBoard.cb_enter_view();
assert.strictEqual(earlyViewWorkspace.classList.contains("cb_view_mode"), true);
assert.ok(earlyViewBoard.cb_view.scale > 0);
assert.ok(earlyViewCanvas.style.transform.includes("scale("));
assert.strictEqual(earlyViewWorkspace.style.top, "0");
assert.strictEqual(earlyViewFrame.style.bottom, "0");
assert.strictEqual(earlyViewExit.style.display, "block");
assert.strictEqual(earlyViewExit.style.right, "14px");
earlyViewBoard.cb_exit_view();
assert.strictEqual(earlyViewWorkspace.style.position, "");
assert.strictEqual(earlyViewExit.style.display, "");

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
assert.strictEqual(migrated.schema, 5);
assert.deepStrictEqual(migrated.objects.map(function (item) { return item.id; }), [stroke.id]);
assert.deepStrictEqual(migrated.clears, []);
assert.deepStrictEqual(migrated.mods, []);
assert.strictEqual(Object.prototype.hasOwnProperty.call(migrated, "mode"), false);
assert.strictEqual(Object.prototype.hasOwnProperty.call(migrated, "profiles"), false);
assert.strictEqual(migrated.deletes.length, 0);
assert.strictEqual(migrated.names.length, 0);

const boardMarkup = fs.readFileSync(
    path.join(root, "miniApps/collabboard/resources/board.html"),
    "utf8"
);
assert.strictEqual(boardMarkup.includes("cb_mode_switch"), false);
assert.strictEqual(boardMarkup.includes("cb_profile"), false);
assert.strictEqual(boardMarkup.includes("type='color'"), true);
assert.strictEqual(boardMarkup.includes("cb_tool_select"), true);
assert.strictEqual(boardMarkup.includes("cb_delete_btn"), true);
assert.strictEqual(boardMarkup.includes("cb_room_setup"), true);
assert.strictEqual(boardMarkup.includes("cb_saved_boards"), true);
assert.strictEqual(boardMarkup.includes("cb_board_name"), true);
assert.strictEqual(boardMarkup.includes("cb_create_code"), false);
assert.strictEqual(boardMarkup.includes("cb_join_code"), true);
assert.strictEqual(boardMarkup.includes("maxlength='6'"), true);
assert.strictEqual(boardMarkup.includes("cb_delete_panel"), true);
assert.strictEqual(boardMarkup.includes("cb_view_btn"), true);
assert.strictEqual(boardMarkup.includes("cb_dark_btn"), true);
assert.strictEqual(boardMarkup.includes("cb_view_exit"), true);
assert.strictEqual(boardMarkup.includes("cb_invite_input"), false);
assert.strictEqual(boardMarkup.includes("cb_selection_info"), true);
assert.strictEqual(boardMarkup.includes("cb_board_loading"), true);
assert.strictEqual(boardMarkup.includes("width='1800' height='2400'"), true);

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
