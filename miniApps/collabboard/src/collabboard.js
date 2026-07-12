/* collabboard.js
 *
 * Collaboration Board miniApp for tremola4chrome.
 *
 * A shared canvas. Pen strokes and text labels are written to the append-only
 * log via writeLogEntry() and replayed on every peer via the
 * "incoming_notification" callback. The log is the single source of truth:
 * the author applies its own change only when it comes back as a notification,
 * so authors and peers stay in sync through the exact same code path.
 *
 * Event payloads (the object passed to writeLogEntry):
 *   stroke: { k:'s', id, c:<color>, w:<width>, p:[[x,y], ...] }
 *   text:   { k:'t', id, c:<color>, x, y, s:<string> }
 *   clear:  { k:'c', id }
 *   modify: { k:'m', id, t:<targetId>, dx, dy, sc } — move/scale an object;
 *           absolute offset+scale relative to the original, last write wins
 *   recolor:{ k:'k', id, t:<targetId>, c:<color> } — last write wins
 *
 * The virtual backend delivers an author's own write twice, so every event
 * carries a unique id and we drop ids we have already applied (cb_state.seen).
 */

"use strict";

// Use a uniquely-named var (not `const globalWindow`): miniApp scripts share
// one global scope, so a const would clash with other apps that declare the
// same name and fail to load.
var cb_root = window.top || window;
if (!cb_root.miniApps) {
    cb_root.miniApps = {};
}

cb_root.miniApps["collabboard"] = {
    handleRequest: function (command, args) {
        switch (command) {
            case "onBackPressed":
                quitApp();
                break;
            case "incoming_notification":
                cb_apply(args && args.args ? args.args[0] : args);
                break;
        }
        return "Response from Collaboration Board";
    }
};

console.log("Collaboration Board loaded");

// 'select' is the default mode: drag empty space to pan the camera, tap an
// object to select it, drag it to move, drag the corner handle to resize.
// Pen and Text are one-shot tools: after a stroke or a placed text the board
// falls back to select mode.
var cb_tool = 'select';
var cb_draft = null;
// Camera: world coordinate shown at the canvas top-left. Objects live in an
// unbounded world plane; panning just moves the camera.
var cb_cam = { x: 0, y: 0 };
var cb_drag = null;
var cb_sel = null; // id of the selected object (select tool)
var CB_MAX_MODS = 2000;
var CB_SEL_PAD = 6;
var CB_HANDLE = 14; // side length of the resize handle square
var cb_bound = false;
var cb_resize_bound = false;
var cb_history_requested = false;
var CB_MIN_POINT_DELTA = 3;
var CB_MAX_STROKE_POINTS = 160;
var CB_MAX_INCOMING_POINTS = 512;
var CB_HISTORY_LIMIT = 2500;
var CB_MAX_OBJECTS = 1500;
var CB_MAX_CLEARS = 8;
var CB_MAX_SEEN = 4000;
// generous bound for the "infinite" world plane; only guards against garbage
var CB_COORD_LIMIT = 1000000;

// --- persisted state -------------------------------------------------------

function cb_state() {
    if (typeof tremola.collabboard == "undefined") {
        tremola.collabboard = { objects: [], clears: [], seen: [], mods: [] };
    }
    if (!Array.isArray(tremola.collabboard.objects)) tremola.collabboard.objects = [];
    if (!Array.isArray(tremola.collabboard.clears)) tremola.collabboard.clears = [];
    if (!Array.isArray(tremola.collabboard.seen)) tremola.collabboard.seen = [];
    if (!Array.isArray(tremola.collabboard.mods)) tremola.collabboard.mods = [];
    return tremola.collabboard;
}

// --- lifecycle (called from manifest "init") -------------------------------

function cb_open() {
    var lst = scenarioDisplay['collabboard-main'];
    display_or_not.forEach(function (d) {
        var el = document.getElementById(d);
        if (el) {
            el.style.display = (lst.indexOf(d) < 0) ? 'none' : null;
        }
    });

    document.getElementById("tremolaTitle").style.display = 'none';
    var c = document.getElementById("conversationTitle");
    c.style.display = null;
    c.innerHTML = "<font size=+1><strong>Collaboration Board</strong></font>";

    cb_bind_canvas();
    cb_set_tool('select');
    cb_fit_canvas();
    cb_redraw();
    if (!cb_history_requested && typeof readLogEntries === "function") {
        cb_history_requested = true;
        readLogEntries(CB_HISTORY_LIMIT);
    }
}

// --- toolbar ---------------------------------------------------------------

// clicking an already-active tool button turns it off again (back to select)
function cb_toggle_tool(tool) {
    cb_set_tool(cb_tool === tool ? 'select' : tool);
}

function cb_set_tool(tool) {
    cb_tool = tool;
    var pen = document.getElementById('cb_tool_pen');
    var text = document.getElementById('cb_tool_text');
    if (pen) pen.classList.toggle('cb_active', tool === 'pen');
    if (text) text.classList.toggle('cb_active', tool === 'text');
    var cv = document.getElementById('cb_canvas');
    if (cv) cv.style.cursor = (tool === 'select') ? 'grab' : 'crosshair';
    var inp = document.getElementById('cb_text');
    if (inp) {
        inp.style.display = (tool === 'text') ? null : 'none';
        if (tool === 'text') inp.focus();
    }
    setTimeout(cb_fit_canvas, 0);
}

function cb_color() {
    var el = document.getElementById('cb_color');
    return el ? el.value : '#000000';
}

function cb_clear() {
    var ts = Date.now();
    writeLogEntry(JSON.stringify({ k: 'c', id: cb_id(ts), ts: ts }));
}

// --- pointer input ---------------------------------------------------------

function cb_bind_canvas() {
    var cv = document.getElementById('cb_canvas');
    if (!cv || cb_bound) return;
    cb_bound = true;
    cv.addEventListener('pointerdown', cb_down);
    cv.addEventListener('pointermove', cb_move);
    cv.addEventListener('pointerup', cb_up);
    cv.addEventListener('pointerleave', cb_up);
    var col = document.getElementById('cb_color');
    if (col) {
        // picking a color while an object is selected recolors that object
        col.addEventListener('change', function () {
            if (!cb_sel || cb_tool !== 'select') return;
            var ts = Date.now();
            var ev = { k: 'k', id: cb_id(ts), ts: ts, t: cb_sel, c: col.value };
            writeLogEntry(JSON.stringify(ev));
            cb_apply(ev);
        });
    }
    if (!cb_resize_bound) {
        cb_resize_bound = true;
        window.addEventListener('resize', cb_fit_canvas);
        window.addEventListener('orientationchange', function () {
            setTimeout(cb_fit_canvas, 150);
        });
    }
}

function cb_fit_canvas() {
    var cv = document.getElementById('cb_canvas');
    var main = document.getElementById('div:collabboard-main');
    if (!cv || !main) return;
    var core = document.getElementById('core');
    var top = cv.getBoundingClientRect().top;
    var bottom = core ? core.getBoundingClientRect().bottom : window.innerHeight;
    var maxHeight = Math.max(160, bottom - top - 8);
    var maxWidth = Math.max(160, main.clientWidth - 10);
    var aspect = cv.width / cv.height;
    var cssWidth = Math.min(maxWidth, maxHeight * aspect);
    cv.style.width = Math.round(cssWidth) + 'px';
    cv.style.height = Math.round(cssWidth / aspect) + 'px';
}

// position in canvas pixels (before the camera is applied)
function cb_screen_pos(cv, e) {
    var r = cv.getBoundingClientRect();
    var sx = cv.width / r.width;
    var sy = cv.height / r.height;
    return [Math.round((e.clientX - r.left) * sx), Math.round((e.clientY - r.top) * sy)];
}

// position in world coordinates
function cb_pos(cv, e) {
    var p = cb_screen_pos(cv, e);
    return [p[0] + cb_cam.x, p[1] + cb_cam.y];
}

function cb_down(e) {
    var cv = e.currentTarget;
    var p = cb_pos(cv, e);
    if (cb_tool === 'text') {
        cb_place_text(p);
        return;
    }
    if (cb_tool === 'select') {
        var st = cb_state();
        var resize = cb_hit_handle(st, p);
        if (resize) {
            var rxf = cb_xf(st, resize);
            cb_drag = { mode: 'resize', target: resize.id, start: p, base: rxf,
                        anchor: cb_resize_anchor(st, resize),
                        xf: { dx: rxf.dx, dy: rxf.dy, sc: rxf.sc } };
            if (cv.setPointerCapture) cv.setPointerCapture(e.pointerId);
            return;
        }
        var hit = cb_hit(st, p);
        if (hit) {
            cb_sel = hit.id;
            var xf = cb_xf(st, hit);
            cb_drag = { mode: 'move', target: hit.id, start: p, base: xf,
                        xf: { dx: xf.dx, dy: xf.dy, sc: xf.sc } };
        } else {
            cb_sel = null;
            cb_drag = { mode: 'pan', last: cb_screen_pos(cv, e) };
            cv.style.cursor = 'grabbing';
        }
        if (cv.setPointerCapture) cv.setPointerCapture(e.pointerId);
        cb_redraw();
        return;
    }
    cb_draft = { k: 's', c: cb_color(), w: 2, p: [p] };
    if (cv.setPointerCapture) cv.setPointerCapture(e.pointerId);
}

function cb_move(e) {
    var cv = e.currentTarget;
    if (cb_drag && cb_drag.mode === 'pan') {
        var s = cb_screen_pos(cv, e);
        cb_cam.x -= s[0] - cb_drag.last[0];
        cb_cam.y -= s[1] - cb_drag.last[1];
        cb_drag.last = s;
        cb_redraw();
        return;
    }
    if (cb_drag && cb_drag.mode === 'move') {
        var q = cb_pos(cv, e);
        cb_drag.xf.dx = cb_drag.base.dx + q[0] - cb_drag.start[0];
        cb_drag.xf.dy = cb_drag.base.dy + q[1] - cb_drag.start[1];
        cb_drag.moved = true;
        cb_redraw();
        return;
    }
    if (cb_drag && cb_drag.mode === 'resize') {
        var q2 = cb_pos(cv, e);
        var a = cb_drag.anchor;
        var d0 = Math.hypot(cb_drag.start[0] - a[0], cb_drag.start[1] - a[1]);
        var d1 = Math.hypot(q2[0] - a[0], q2[1] - a[1]);
        if (d0 > 1) {
            cb_drag.xf.sc = Math.min(20, Math.max(0.05, cb_drag.base.sc * d1 / d0));
            cb_drag.moved = true;
            cb_redraw();
        }
        return;
    }
    if (!cb_draft) return;
    var p = cb_pos(cv, e);
    if (!cb_keep_point(cb_draft.p, p)) return;
    cb_draft.p.push(p);
    // live feedback: draw only the newest segment
    var ctx = cv.getContext('2d');
    ctx.save();
    ctx.translate(-cb_cam.x, -cb_cam.y);
    cb_draw_stroke(ctx, { c: cb_draft.c, w: cb_draft.w, p: cb_draft.p.slice(-2) });
    ctx.restore();
}

function cb_up(e) {
    if (cb_drag) {
        var d = cb_drag;
        cb_drag = null;
        var cv = e && e.currentTarget;
        if (cv && cb_tool === 'select') cv.style.cursor = 'grab';
        if (d.mode !== 'pan' && d.moved) {
            var ts = Date.now();
            var ev = { k: 'm', id: cb_id(ts), ts: ts, t: d.target,
                       dx: Math.round(d.xf.dx), dy: Math.round(d.xf.dy),
                       sc: Math.round(d.xf.sc * 1000) / 1000 };
            writeLogEntry(JSON.stringify(ev));
            // apply locally right away (the echo is deduped by id) so the
            // object does not snap back while the write round-trips
            cb_apply(ev);
        } else {
            cb_redraw();
        }
        return;
    }
    if (!cb_draft) return;
    var d = cb_draft;
    cb_draft = null;
    if (d.p.length < 1) return;
    d.p = cb_simplify_points(d.p, CB_MAX_STROKE_POINTS);
    d.ts = Date.now();
    d.id = cb_id(d.ts);
    writeLogEntry(JSON.stringify(d));
    cb_set_tool('select'); // one-shot: back to the default mode
}

function cb_place_text(p) {
    var inp = document.getElementById('cb_text');
    var s = (inp && inp.value || '').trim();
    if (!s) {
        if (inp) inp.focus();
        return;
    }
    // The f2b command string is space-delimited, so the payload must contain no
    // spaces. Base64-encode the user's text (the only field that can) and decode
    // it again at render time.
    var ts = Date.now();
    writeLogEntry(JSON.stringify({ k: 't', id: cb_id(ts), ts: ts, c: cb_color(), x: p[0], y: p[1], s: cb_enc(s) }));
    inp.value = '';
    cb_set_tool('select'); // one-shot: back to the default mode
}

// --- apply incoming events -------------------------------------------------

function cb_apply(obj) {
    if (!cb_is_valid_event(obj)) return;
    var st = cb_state();
    if (st.seen.indexOf(obj.id) >= 0) return; // already applied (incl. self-echo)
    st.seen.push(obj.id);

    if (obj.k === 'c') {
        st.clears.push(obj);
    } else if (obj.k === 'm' || obj.k === 'k') {
        st.mods.push(obj);
    } else {
        if (!st.objects.some(function (o) { return o.id === obj.id; })) {
            st.objects.push(obj);
        }
    }
    cb_prune_state(st);
    persist();
    cb_redraw();
}

// --- rendering -------------------------------------------------------------

function cb_redraw() {
    var cv = document.getElementById('cb_canvas');
    if (!cv) return;
    var ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.save();
    ctx.translate(-cb_cam.x, -cb_cam.y);
    var st = cb_state();
    var visible = cb_visible_objects(st);
    visible.forEach(function (o) {
        var xf = cb_xf(st, o);
        var col = cb_eff_color(st, o);
        if (o.k === 's') cb_draw_stroke(ctx, o, xf, col);
        else if (o.k === 't') cb_draw_text(ctx, o, xf, col);
    });
    if (cb_sel) {
        var selObj = null;
        visible.forEach(function (o) { if (o.id === cb_sel) selObj = o; });
        if (selObj) cb_draw_selection(ctx, st, selObj);
        else cb_sel = null;
    }
    ctx.restore();
}

function cb_visible_objects(st) {
    var clear = cb_latest_clear(st);
    return st.objects
        .filter(function (o) { return !clear || cb_compare_events(o, clear) > 0; })
        .sort(cb_compare_events);
}

function cb_draw_selection(ctx, st, o) {
    var b = cb_bbox(ctx, st, o);
    ctx.save();
    ctx.strokeStyle = '#2563eb';
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(b.x - CB_SEL_PAD, b.y - CB_SEL_PAD,
                   b.w + 2 * CB_SEL_PAD, b.h + 2 * CB_SEL_PAD);
    ctx.setLineDash([]);
    var h = cb_handle_rect(b);
    ctx.fillStyle = '#2563eb';
    ctx.fillRect(h.x, h.y, h.w, h.h);
    ctx.restore();
}

// resize handle sits on the bottom-right corner of the selection box
function cb_handle_rect(b) {
    return { x: b.x + b.w + CB_SEL_PAD - CB_HANDLE / 2,
             y: b.y + b.h + CB_SEL_PAD - CB_HANDLE / 2,
             w: CB_HANDLE, h: CB_HANDLE };
}

function cb_draw_stroke(ctx, o, xf, col) {
    if (!o.p || o.p.length === 0) return;
    xf = xf || { dx: 0, dy: 0, sc: 1 };
    var org = cb_origin(o);
    ctx.strokeStyle = col || o.c || '#000000';
    ctx.lineWidth = (o.w || 2) * xf.sc;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    var p0 = cb_apply_xf(o.p[0], org, xf);
    ctx.moveTo(p0[0], p0[1]);
    for (var i = 1; i < o.p.length; i++) {
        var p = cb_apply_xf(o.p[i], org, xf);
        ctx.lineTo(p[0], p[1]);
    }
    ctx.stroke();
}

function cb_draw_text(ctx, o, xf, col) {
    xf = xf || { dx: 0, dy: 0, sc: 1 };
    ctx.fillStyle = col || o.c || '#000000';
    ctx.font = Math.round(16 * xf.sc) + 'px sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(cb_dec(o.s).slice(0, 160), o.x + xf.dx, o.y + xf.dy);
}

// --- transforms & hit-testing ------------------------------------------------

// effective transform of an object: latest 'm' mod, overridden by a live drag
function cb_xf(st, o) {
    if (cb_drag && cb_drag.mode !== 'pan' && cb_drag.target === o.id && cb_drag.xf) {
        return cb_drag.xf;
    }
    var best = cb_latest_mod(st, o.id, 'm');
    if (!best) return { dx: 0, dy: 0, sc: 1 };
    return { dx: best.dx || 0, dy: best.dy || 0, sc: best.sc || 1 };
}

function cb_latest_mod(st, targetId, kind) {
    var best = null;
    st.mods.forEach(function (m) {
        if (m.t === targetId && m.k === kind &&
            (!best || cb_compare_events(m, best) > 0)) best = m;
    });
    return best;
}

// effective color: latest recolor mod wins over the object's own color
function cb_eff_color(st, o) {
    var best = cb_latest_mod(st, o.id, 'k');
    return best ? best.c : o.c;
}

// scale origin: strokes scale about their original top-left, text about (x,y)
function cb_origin(o) {
    if (o.k === 't') return [o.x, o.y];
    var mx = Infinity, my = Infinity;
    o.p.forEach(function (p) {
        if (p[0] < mx) mx = p[0];
        if (p[1] < my) my = p[1];
    });
    return [mx, my];
}

function cb_apply_xf(p, org, xf) {
    return [org[0] + (p[0] - org[0]) * xf.sc + xf.dx,
            org[1] + (p[1] - org[1]) * xf.sc + xf.dy];
}

// transformed bounding box in world coordinates
function cb_bbox(ctx, st, o) {
    var xf = cb_xf(st, o);
    if (o.k === 't') {
        ctx.save();
        ctx.font = Math.round(16 * xf.sc) + 'px sans-serif';
        var w = ctx.measureText(cb_dec(o.s).slice(0, 160)).width;
        ctx.restore();
        return { x: o.x + xf.dx, y: o.y + xf.dy - 9 * xf.sc, w: w, h: 18 * xf.sc };
    }
    var org = cb_origin(o);
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    o.p.forEach(function (p) {
        var q = cb_apply_xf(p, org, xf);
        if (q[0] < x0) x0 = q[0];
        if (q[1] < y0) y0 = q[1];
        if (q[0] > x1) x1 = q[0];
        if (q[1] > y1) y1 = q[1];
    });
    var pad = ((o.w || 2) * xf.sc) / 2;
    return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + 2 * pad, h: y1 - y0 + 2 * pad };
}

// the selected object, if the world point p is on its resize handle
function cb_hit_handle(st, p) {
    if (!cb_sel) return null;
    var cv = document.getElementById('cb_canvas');
    var ctx = cv.getContext('2d');
    var obj = null;
    cb_visible_objects(st).forEach(function (o) { if (o.id === cb_sel) obj = o; });
    if (!obj) return null;
    var h = cb_handle_rect(cb_bbox(ctx, st, obj));
    var pad = 4; // a bit of extra touch slack
    if (p[0] >= h.x - pad && p[0] <= h.x + h.w + pad &&
        p[1] >= h.y - pad && p[1] <= h.y + h.h + pad) return obj;
    return null;
}

// fixed point while resizing: the selection box's top-left corner
function cb_resize_anchor(st, o) {
    var cv = document.getElementById('cb_canvas');
    var b = cb_bbox(cv.getContext('2d'), st, o);
    return [b.x, b.y];
}

// topmost visible object whose (padded) bbox contains the world point p
function cb_hit(st, p) {
    var cv = document.getElementById('cb_canvas');
    var ctx = cv.getContext('2d');
    var hit = null;
    cb_visible_objects(st).forEach(function (o) {
        var b = cb_bbox(ctx, st, o);
        if (p[0] >= b.x - CB_SEL_PAD && p[0] <= b.x + b.w + CB_SEL_PAD &&
            p[1] >= b.y - CB_SEL_PAD && p[1] <= b.y + b.h + CB_SEL_PAD) {
            hit = o;
        }
    });
    return hit;
}

// --- helpers ---------------------------------------------------------------

function cb_id(ts) {
    var who = (typeof myId == "string") ? myId.slice(1, 6) : 'x';
    return who + '-' + (ts || Date.now()) + '-' + Math.floor(Math.random() * 1000000);
}

// Base64 encode/decode (UTF-8 safe) so text payloads stay space-free.
function cb_enc(s) {
    return btoa(unescape(encodeURIComponent(s)));
}

function cb_dec(s) {
    try {
        return decodeURIComponent(escape(atob(s)));
    } catch (e) {
        return s;
    }
}

function cb_keep_point(points, p) {
    if (!points || points.length === 0) return true;
    var last = points[points.length - 1];
    var dx = p[0] - last[0];
    var dy = p[1] - last[1];
    return (dx * dx + dy * dy) >= (CB_MIN_POINT_DELTA * CB_MIN_POINT_DELTA);
}

function cb_simplify_points(points, maxPoints) {
    if (!points || points.length <= maxPoints) return points || [];
    var out = [];
    var last = points.length - 1;
    for (var i = 0; i < maxPoints; i++) {
        out.push(points[Math.round(i * last / (maxPoints - 1))]);
    }
    return out;
}

function cb_is_valid_event(obj) {
    if (!obj || typeof obj.id !== 'string' || obj.id.length > 96) return false;
    if (obj.k === 'c') return true;
    if (obj.k === 't') {
        return cb_is_finite_coord(obj.x) && cb_is_finite_coord(obj.y) &&
            typeof obj.s === 'string' && obj.s.length <= 1024 &&
            cb_is_valid_color(obj.c);
    }
    if (obj.k === 'k') {
        return typeof obj.t === 'string' && obj.t.length > 0 && obj.t.length <= 96 &&
            typeof obj.c === 'string' && cb_is_valid_color(obj.c);
    }
    if (obj.k === 'm') {
        return typeof obj.t === 'string' && obj.t.length > 0 && obj.t.length <= 96 &&
            cb_is_finite_coord(obj.dx) && cb_is_finite_coord(obj.dy) &&
            typeof obj.sc === 'number' && isFinite(obj.sc) && obj.sc >= 0.05 && obj.sc <= 20;
    }
    if (obj.k === 's') {
        return Array.isArray(obj.p) && obj.p.length > 0 && obj.p.length <= CB_MAX_INCOMING_POINTS &&
            (typeof obj.w === 'undefined' || (typeof obj.w === 'number' && isFinite(obj.w) && obj.w > 0 && obj.w <= 16)) &&
            cb_is_valid_color(obj.c) &&
            obj.p.every(function (p) {
                return cb_is_valid_point(p);
            });
    }
    return false;
}

function cb_prune_state(st) {
    var clear = cb_latest_clear(st);
    if (clear) {
        st.objects = st.objects.filter(function (o) { return cb_compare_events(o, clear) > 0; });
    }
    if (st.objects.length > CB_MAX_OBJECTS) {
        st.objects = st.objects.slice().sort(cb_compare_events).slice(-CB_MAX_OBJECTS);
    }
    if (st.clears.length > CB_MAX_CLEARS) {
        st.clears = st.clears.slice().sort(cb_compare_events).slice(-CB_MAX_CLEARS);
    }
    // keep only the winning mod per target (older ones can never win again)
    var latest = {};
    st.mods.forEach(function (m) {
        var key = m.k + ':' + m.t;
        if (!latest[key] || cb_compare_events(m, latest[key]) > 0) latest[key] = m;
    });
    st.mods = Object.keys(latest).map(function (key) { return latest[key]; });
    if (st.mods.length > CB_MAX_MODS) {
        st.mods = st.mods.slice().sort(cb_compare_events).slice(-CB_MAX_MODS);
    }
    if (st.seen.length > CB_MAX_SEEN) {
        st.seen = st.seen.slice(st.seen.length - CB_MAX_SEEN);
    }
}

function cb_is_valid_point(p) {
    return Array.isArray(p) && p.length === 2 &&
        cb_is_finite_coord(p[0]) && cb_is_finite_coord(p[1]);
}

function cb_is_finite_coord(n) {
    return typeof n === 'number' && isFinite(n) && Math.abs(n) <= CB_COORD_LIMIT;
}

function cb_is_valid_color(c) {
    return typeof c === 'undefined' || (typeof c === 'string' && c.length <= 32);
}

function cb_latest_clear(st) {
    if (!st.clears || st.clears.length === 0) return null;
    return st.clears.slice().sort(cb_compare_events).pop();
}

function cb_compare_events(a, b) {
    var ats = cb_event_ts(a);
    var bts = cb_event_ts(b);
    if (ats !== bts) return ats - bts;
    var aid = a && a.id ? a.id : '';
    var bid = b && b.id ? b.id : '';
    if (aid < bid) return -1;
    if (aid > bid) return 1;
    return 0;
}

function cb_event_ts(obj) {
    if (obj && typeof obj.ts === 'number' && isFinite(obj.ts)) return obj.ts;
    var id = obj && obj.id ? obj.id : '';
    var parts = id.split('-');
    if (parts.length >= 3) {
        var n = parseInt(parts[1], 10);
        if (isFinite(n)) return n;
    }
    return 0;
}
