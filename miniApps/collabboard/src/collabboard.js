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
                cb_apply(args.args[0]);
                break;
        }
        return "Response from Collaboration Board";
    }
};

console.log("Collaboration Board loaded");

var cb_tool = 'pen';
var cb_draft = null;
var cb_bound = false;

// --- persisted state -------------------------------------------------------

function cb_state() {
    if (typeof tremola.collabboard == "undefined") {
        tremola.collabboard = { objects: [], seen: [] };
    }
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
    cb_redraw();
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
}

function cb_color() {
    var el = document.getElementById('cb_color');
    return el ? el.value : '#000000';
}

function cb_clear() {
    writeLogEntry(JSON.stringify({ k: 'c', id: cb_id() }));
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
    cb_draft.p.push(cb_pos(cv, e));
    // live feedback: draw only the newest segment
    cb_draw_stroke(cv.getContext('2d'), { c: cb_draft.c, w: cb_draft.w, p: cb_draft.p.slice(-2) });
}

function cb_up() {
    if (!cb_draft) return;
    var d = cb_draft;
    cb_draft = null;
    if (d.p.length < 1) return;
    d.id = cb_id();
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
    writeLogEntry(JSON.stringify({ k: 't', id: cb_id(), c: cb_color(), x: p[0], y: p[1], s: cb_enc(s) }));
    inp.value = '';
}

// --- apply incoming events -------------------------------------------------

function cb_apply(obj) {
    if (!obj || !obj.id) return;
    var st = cb_state();
    if (st.seen.indexOf(obj.id) >= 0) return; // already applied (incl. self-echo)
    st.seen.push(obj.id);

    if (obj.k === 'c') {
        st.objects = [];
    } else {
        st.objects.push(obj);
    }
    persist();
    cb_redraw();
}

// --- rendering -------------------------------------------------------------

function cb_redraw() {
    var cv = document.getElementById('cb_canvas');
    if (!cv) return;
    var ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);
    cb_state().objects.forEach(function (o) {
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
    ctx.fillText(cb_dec(o.s), o.x, o.y);
}

// --- helpers ---------------------------------------------------------------

function cb_id() {
    var who = (typeof myId == "string") ? myId.slice(1, 6) : 'x';
    return who + '-' + Date.now() + '-' + Math.floor(Math.random() * 1000000);
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
