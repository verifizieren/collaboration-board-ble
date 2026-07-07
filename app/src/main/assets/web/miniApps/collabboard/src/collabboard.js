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

var cb_tool = 'pen';
var cb_draft = null;
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
var CB_COORD_LIMIT = 10000;

// --- persisted state -------------------------------------------------------

function cb_state() {
    if (typeof tremola.collabboard == "undefined") {
        tremola.collabboard = { objects: [], clears: [], seen: [] };
    }
    if (!Array.isArray(tremola.collabboard.objects)) tremola.collabboard.objects = [];
    if (!Array.isArray(tremola.collabboard.clears)) tremola.collabboard.clears = [];
    if (!Array.isArray(tremola.collabboard.seen)) tremola.collabboard.seen = [];
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
    cb_set_tool('pen');
    cb_fit_canvas();
    cb_redraw();
    if (!cb_history_requested && typeof readLogEntries === "function") {
        cb_history_requested = true;
        readLogEntries(CB_HISTORY_LIMIT);
    }
}

// --- toolbar ---------------------------------------------------------------

function cb_set_tool(tool) {
    cb_tool = tool;
    var pen = document.getElementById('cb_tool_pen');
    var text = document.getElementById('cb_tool_text');
    if (pen) pen.classList.toggle('cb_active', tool === 'pen');
    if (text) text.classList.toggle('cb_active', tool === 'text');
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

function cb_pos(cv, e) {
    var r = cv.getBoundingClientRect();
    var sx = cv.width / r.width;
    var sy = cv.height / r.height;
    return [Math.round((e.clientX - r.left) * sx), Math.round((e.clientY - r.top) * sy)];
}

function cb_down(e) {
    var cv = e.currentTarget;
    var p = cb_pos(cv, e);
    if (cb_tool === 'text') {
        cb_place_text(p);
        return;
    }
    cb_draft = { k: 's', c: cb_color(), w: 2, p: [p] };
    if (cv.setPointerCapture) cv.setPointerCapture(e.pointerId);
}

function cb_move(e) {
    if (!cb_draft) return;
    var cv = e.currentTarget;
    var p = cb_pos(cv, e);
    if (!cb_keep_point(cb_draft.p, p)) return;
    cb_draft.p.push(p);
    // live feedback: draw only the newest segment
    cb_draw_stroke(cv.getContext('2d'), { c: cb_draft.c, w: cb_draft.w, p: cb_draft.p.slice(-2) });
}

function cb_up() {
    if (!cb_draft) return;
    var d = cb_draft;
    cb_draft = null;
    if (d.p.length < 1) return;
    d.p = cb_simplify_points(d.p, CB_MAX_STROKE_POINTS);
    d.ts = Date.now();
    d.id = cb_id(d.ts);
    writeLogEntry(JSON.stringify(d));
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
}

// --- apply incoming events -------------------------------------------------

function cb_apply(obj) {
    if (!cb_is_valid_event(obj)) return;
    var st = cb_state();
    if (st.seen.indexOf(obj.id) >= 0) return; // already applied (incl. self-echo)
    st.seen.push(obj.id);

    if (obj.k === 'c') {
        st.clears.push(obj);
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
    var st = cb_state();
    var clear = cb_latest_clear(st);
    st.objects
        .filter(function (o) { return !clear || cb_compare_events(o, clear) > 0; })
        .sort(cb_compare_events)
        .forEach(function (o) {
        if (o.k === 's') cb_draw_stroke(ctx, o);
        else if (o.k === 't') cb_draw_text(ctx, o);
    });
}

function cb_draw_stroke(ctx, o) {
    if (!o.p || o.p.length === 0) return;
    ctx.strokeStyle = o.c || '#000000';
    ctx.lineWidth = o.w || 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(o.p[0][0], o.p[0][1]);
    for (var i = 1; i < o.p.length; i++) {
        ctx.lineTo(o.p[i][0], o.p[i][1]);
    }
    ctx.stroke();
}

function cb_draw_text(ctx, o) {
    ctx.fillStyle = o.c || '#000000';
    ctx.font = '16px sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(cb_dec(o.s).slice(0, 160), o.x, o.y);
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
