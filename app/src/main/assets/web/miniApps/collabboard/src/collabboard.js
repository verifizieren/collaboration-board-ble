/* collabboard.js
 *
 * Collaboration Board miniApp for Tremola and tremola4chrome.
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
 *   owned:  { k:'o', a:<operation kind>, ...operation fields }
 *   profile:{ k:'p', id, n:<display name>, c:<one of four colors> }
 *
 * Edit all events keep Max's original wire format. Edit own operations use the
 * internal `owned` wrapper, so an older Collaboration Board ignores them instead
 * of showing a partially compatible board. Ownership comes from the verified SSB header,
 * never from the user-supplied display name.
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
                var payload = args && args.args ? args.args[0] : args;
                var header = args && args.header ? args.header :
                    (args && args.args && args.args[1] ? args.args[1] : null);
                cb_apply(payload, header);
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
var cb_board_mode = 'open';
var cb_profile_color = '#2563eb';
var cb_pointer_id = null;
var CB_MAX_MODS = 2000;
var CB_SEL_PAD = 6;
var CB_HANDLE = 12; // visible side length of the resize handle square
var CB_HANDLE_HIT = 32; // larger invisible touch target for phones
var CB_DRAG_THRESHOLD = 3;
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
var CB_MAX_PROFILES = 128;
var CB_PROFILE_COLORS = ['#2563eb', '#dc2626', '#15803d', '#7c3aed'];
// generous bound for the "infinite" world plane; only guards against garbage
var CB_COORD_LIMIT = 1000000;

// --- persisted state -------------------------------------------------------

function cb_state() {
    if (typeof tremola.collabboard == "undefined") {
        tremola.collabboard = {
            objects: [], clears: [], seen: [], mods: [], profiles: {}, mode: 'open'
        };
    }
    if (!Array.isArray(tremola.collabboard.objects)) tremola.collabboard.objects = [];
    if (!Array.isArray(tremola.collabboard.clears)) tremola.collabboard.clears = [];
    if (!Array.isArray(tremola.collabboard.seen)) tremola.collabboard.seen = [];
    if (!Array.isArray(tremola.collabboard.mods)) tremola.collabboard.mods = [];
    if (typeof tremola.collabboard.clock !== 'number' ||
        !isFinite(tremola.collabboard.clock) || tremola.collabboard.clock < 0) {
        tremola.collabboard.clock = 0;
    }
    if (!tremola.collabboard.profiles || Array.isArray(tremola.collabboard.profiles) ||
        typeof tremola.collabboard.profiles !== 'object') {
        tremola.collabboard.profiles = {};
    }
    if (tremola.collabboard.mode !== 'owned') tremola.collabboard.mode = 'open';
    if (tremola.collabboard.localProfile &&
        !cb_is_valid_profile_data(tremola.collabboard.localProfile)) {
        delete tremola.collabboard.localProfile;
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
    cb_board_mode = cb_state().mode === 'owned' ? 'owned' : 'open';
    cb_prepare_profile_form();
    cb_update_mode_ui();
    cb_set_tool('select');
    cb_fit_canvas();
    if (typeof Android === 'undefined') {
        cb_ble_status('Browser preview', 0, 0);
    } else if (typeof bleState !== 'undefined' && bleState) {
        cb_ble_status(bleState.status, bleState.peers, bleState.queued);
    } else {
        cb_ble_status('BLE starting', 0, 0);
    }
    cb_redraw();
    if (!cb_history_requested && typeof readLogEntries === "function") {
        cb_history_requested = true;
        readLogEntries(CB_HISTORY_LIMIT);
    }
}

function cb_ble_status(status, peers, queued) {
    var box = document.getElementById('cb_sync_status');
    var text = document.getElementById('cb_sync_text');
    if (!box || !text) return;

    var label = typeof status === 'string' && status ? status : 'BLE starting';
    var peerCount = Number.isFinite(Number(peers)) ? Number(peers) : 0;
    var queueCount = Number.isFinite(Number(queued)) ? Number(queued) : 0;
    text.textContent = cb_status_label(label, peerCount, queueCount);
    box.title = label + ' | peers ' + peerCount + ' | queue ' + queueCount;

    var lower = label.toLowerCase();
    var stateClass = 'cb_sync_waiting';
    if (/disabled|missing|failed|error|unavailable|unsupported|stopped/.test(lower)) {
        stateClass = 'cb_sync_error';
    } else if (/active|ready|connected|advertising|notifications on/.test(lower) || lower === 'browser preview') {
        stateClass = 'cb_sync_ready';
    }
    box.className = 'cb_sync_status ' + stateClass;
}

function cb_status_label(status, peers, queued) {
    var lower = String(status || '').toLowerCase();
    if (lower === 'browser preview') return 'Preview';
    if (/permission/.test(lower)) return 'Allow Bluetooth';
    if (/disabled/.test(lower)) return 'Bluetooth off';
    if (/unavailable|unsupported|not available/.test(lower)) return 'Bluetooth unavailable';
    if (/stopped/.test(lower)) return 'Sync off';
    if (/failed|error/.test(lower)) return 'Sync problem';
    if (queued > 0) return 'Syncing';
    if (peers > 0) return peers === 1 ? '1 nearby' : peers + ' nearby';
    if (/starting|active|ready|connected|advertising|service/.test(lower)) return 'Looking nearby';
    return 'Starting';
}

// --- board mode and profiles ----------------------------------------------

function cb_set_board_mode(mode) {
    mode = mode === 'owned' ? 'owned' : 'open';
    if (cb_board_mode === mode && cb_state().mode === mode) {
        cb_update_mode_ui();
        return;
    }
    cb_board_mode = mode;
    cb_state().mode = mode;
    cb_sel = null;
    cb_drag = null;
    cb_draft = null;
    cb_cam = { x: 0, y: 0 };
    cb_set_tool('select');
    cb_prepare_profile_form();
    cb_update_mode_ui();
    persist();
    cb_redraw();
    setTimeout(cb_fit_canvas, 0);
}

function cb_update_mode_ui() {
    var main = document.getElementById('div:collabboard-main');
    var open = document.getElementById('cb_mode_open');
    var owned = document.getElementById('cb_mode_owned');
    var profile = document.getElementById('cb_profile');
    var clear = document.getElementById('cb_clear_btn');
    var isOwned = cb_board_mode === 'owned';

    if (main) main.classList.toggle('cb_owned', isOwned);
    if (open) open.setAttribute('aria-pressed', isOwned ? 'false' : 'true');
    if (owned) owned.setAttribute('aria-pressed', isOwned ? 'true' : 'false');
    if (profile) profile.style.display = isOwned ? 'grid' : 'none';
    if (clear) clear.setAttribute('aria-label', isOwned ? 'Clear my work' : 'Clear board');

    cb_update_controls();
    cb_refresh_people();
    cb_update_selection_status();
}

function cb_update_controls() {
    var hasProfile = cb_board_mode !== 'owned' || !!cb_local_profile();
    var pen = document.getElementById('cb_tool_pen');
    var text = document.getElementById('cb_tool_text');
    var clear = document.getElementById('cb_clear_btn');
    if (pen) pen.disabled = !hasProfile;
    if (text) text.disabled = !hasProfile;
    if (clear) clear.disabled = !hasProfile;
}

function cb_prepare_profile_form() {
    var profile = cb_local_profile();
    var input = document.getElementById('cb_name');
    if (profile) {
        cb_profile_color = profile.c;
        if (input) input.value = profile.n;
    } else {
        cb_profile_color = cb_default_profile_color();
        if (input && !input.value) input.value = '';
    }
    cb_render_profile_color();
}

function cb_pick_profile_color(color) {
    color = String(color || '').toLowerCase();
    if (CB_PROFILE_COLORS.indexOf(color) < 0) return;
    cb_profile_color = color;
    cb_render_profile_color();
}

function cb_render_profile_color() {
    var palette = document.getElementById('cb_palette');
    if (!palette || !palette.querySelectorAll) return;
    Array.prototype.forEach.call(palette.querySelectorAll('.cb_swatch'), function (button) {
        button.setAttribute('role', 'radio');
        button.setAttribute('aria-checked',
            button.getAttribute('data-color') === cb_profile_color ? 'true' : 'false');
    });
}

function cb_save_profile() {
    var input = document.getElementById('cb_name');
    var name = cb_clean_name(input ? input.value : '');
    if (!name) {
        cb_notice('Add a name first');
        if (input) input.focus();
        return false;
    }
    if (CB_PROFILE_COLORS.indexOf(cb_profile_color) < 0) {
        cb_profile_color = cb_default_profile_color();
    }
    var st = cb_state();
    st.localProfile = { n: name, c: cb_profile_color };
    persist();
    var ts = cb_next_ts();
    var profileEvent = { k: 'p', id: cb_id(ts), ts: ts, n: name, c: cb_profile_color };
    writeLogEntry(JSON.stringify(profileEvent));
    cb_update_mode_ui();
    cb_notice('Saved');
    return false;
}

function cb_local_profile() {
    var st = cb_state();
    if (cb_is_valid_profile_data(st.localProfile)) return st.localProfile;
    if (typeof myId === 'string') {
        var event = st.profiles[myId];
        if (event) return { n: event.n, c: event.c };
    }
    return null;
}

function cb_profile_for(fid) {
    var st = cb_state();
    var event = fid ? st.profiles[fid] : null;
    if (event) return { n: event.n, c: event.c };
    if (fid && typeof myId === 'string' && fid === myId) return cb_local_profile();
    var fallback = null;
    st.objects.forEach(function (object) {
        if (cb_event_board(object) === 'owned' && object._fid === fid &&
            cb_clean_name(object.n) === object.n && CB_PROFILE_COLORS.indexOf(object.c) >= 0 &&
            (!fallback || cb_compare_events(object, fallback) > 0)) {
            fallback = object;
        }
    });
    if (fallback) return { n: fallback.n, c: fallback.c };
    return null;
}

function cb_require_profile(showNotice) {
    var profile = cb_local_profile();
    if (profile) return profile;
    if (showNotice !== false) cb_notice('Add a name first');
    var input = document.getElementById('cb_name');
    if (input) input.focus();
    return null;
}

function cb_clean_name(value) {
    if (typeof value !== 'string') return '';
    var name = value.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
    return name.length > 0 && name.length <= 20 ? name : '';
}

function cb_is_valid_profile_data(profile) {
    return !!profile && cb_clean_name(profile.n) === profile.n &&
        CB_PROFILE_COLORS.indexOf(String(profile.c || '').toLowerCase()) >= 0;
}

function cb_default_profile_color() {
    var fid = typeof myId === 'string' ? myId : 'local';
    var hash = 0;
    for (var i = 0; i < fid.length; i++) hash = (hash * 31 + fid.charCodeAt(i)) >>> 0;
    return CB_PROFILE_COLORS[hash % CB_PROFILE_COLORS.length];
}

function cb_refresh_people() {
    var box = document.getElementById('cb_people');
    if (!box) return;
    box.textContent = '';
    if (cb_board_mode !== 'owned') {
        box.style.display = 'none';
        return;
    }

    var fids = {};
    cb_visible_objects(cb_state()).forEach(function (object) {
        if (object._fid) fids[object._fid] = true;
    });
    if (typeof myId === 'string' && cb_local_profile()) fids[myId] = true;
    Object.keys(fids).sort(function (a, b) {
        return cb_profile_name(a).localeCompare(cb_profile_name(b));
    }).forEach(function (fid) {
        var profile = cb_profile_for(fid);
        if (!profile) return;
        var item = document.createElement('span');
        item.className = 'cb_person';
        item.textContent = profile.n;
        item.style.color = profile.c;
        item.title = fid;
        box.appendChild(item);
    });
    box.style.display = box.childNodes && box.childNodes.length ? 'flex' : 'none';
}

function cb_profile_name(fid) {
    var profile = cb_profile_for(fid);
    return profile ? profile.n : 'Unknown';
}

function cb_update_selection_status() {
    var box = document.getElementById('cb_selection_status');
    if (!box) return;
    if (cb_board_mode !== 'owned' || !cb_sel) {
        box.style.display = 'none';
        box.textContent = '';
        return;
    }
    var selected = cb_find_visible_object(cb_sel);
    if (!selected) {
        box.style.display = 'none';
        box.textContent = '';
        return;
    }
    var profile = cb_profile_for(selected._fid);
    box.textContent = cb_profile_name(selected._fid) +
        (cb_is_own_object(selected) ? ' · yours' : ' · view only');
    box.style.color = profile ? profile.c : '#555555';
    box.style.display = 'block';
}

function cb_notice(message) {
    if (typeof launch_snackbar === 'function') launch_snackbar(message);
    else if (typeof console !== 'undefined' && console.log) console.log(message);
}

// --- toolbar ---------------------------------------------------------------

// clicking an already-active tool button turns it off again (back to select)
function cb_toggle_tool(tool) {
    cb_set_tool(cb_tool === tool ? 'select' : tool);
}

function cb_set_tool(tool) {
    if (cb_board_mode === 'owned' && (tool === 'pen' || tool === 'text') &&
        !cb_require_profile(true)) {
        tool = 'select';
    }
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
    if (cb_board_mode === 'owned') {
        var profile = cb_local_profile();
        return profile ? profile.c : cb_profile_color;
    }
    var el = document.getElementById('cb_color');
    return el ? el.value : '#000000';
}

function cb_clear() {
    if (cb_board_mode === 'owned' && !cb_require_profile(true)) return;
    var ts = cb_next_ts();
    cb_sel = null;
    cb_write_board_event({ k: 'c', id: cb_id(ts), ts: ts }, true);
}

// --- pointer input ---------------------------------------------------------

function cb_bind_canvas() {
    var cv = document.getElementById('cb_canvas');
    if (!cv || cb_bound) return;
    cb_bound = true;
    cv.addEventListener('pointerdown', cb_down);
    cv.addEventListener('pointermove', cb_move);
    cv.addEventListener('pointerup', cb_up);
    cv.addEventListener('pointerleave', cb_leave);
    cv.addEventListener('pointercancel', cb_cancel);
    var col = document.getElementById('cb_color');
    if (col) {
        // picking a color while an object is selected recolors that object
        col.addEventListener('change', function () {
            if (cb_board_mode !== 'open' || !cb_sel || cb_tool !== 'select') return;
            var ts = cb_next_ts();
            var ev = { k: 'k', id: cb_id(ts), ts: ts, t: cb_sel, c: col.value };
            cb_write_board_event(ev, true);
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
    var maxHeight = bottom - top - 8;
    var maxWidth = main.clientWidth - 10;
    if (maxHeight <= 0 || maxWidth <= 0) return;
    var canvasWidth = Math.max(120, Math.floor(maxWidth));
    var canvasHeight = Math.max(120, Math.floor(maxHeight));
    var changed = cv.width !== canvasWidth || cv.height !== canvasHeight;
    if (changed) {
        cv.width = canvasWidth;
        cv.height = canvasHeight;
    }
    cv.style.width = canvasWidth + 'px';
    cv.style.height = canvasHeight + 'px';
    cb_clamp_camera(cv);
    if (changed) cb_redraw();
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
    if (e.isPrimary === false || cb_pointer_id !== null) return;
    cb_pointer_id = e.pointerId;
    if (e.preventDefault) e.preventDefault();
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
            if (cb_board_mode === 'open') cb_sync_color_picker(st, hit);
            if (cb_is_own_object(hit)) {
                var xf = cb_xf(st, hit);
                cb_drag = { mode: 'move', target: hit.id, start: p, base: xf,
                            xf: { dx: xf.dx, dy: xf.dy, sc: xf.sc } };
            } else {
                cb_drag = { mode: 'inspect', target: hit.id };
            }
        } else {
            cb_sel = null;
            cb_drag = { mode: 'pan', last: cb_screen_pos(cv, e) };
            cv.style.cursor = 'grabbing';
        }
        if (cv.setPointerCapture) cv.setPointerCapture(e.pointerId);
        cb_redraw();
        setTimeout(cb_fit_canvas, 0);
        return;
    }
    cb_draft = { k: 's', c: cb_color(), w: 2, p: [p] };
    if (cv.setPointerCapture) cv.setPointerCapture(e.pointerId);
}

function cb_move(e) {
    if (e.isPrimary === false || cb_pointer_id === null || e.pointerId !== cb_pointer_id) return;
    if (e.preventDefault) e.preventDefault();
    var cv = e.currentTarget;
    if (cb_drag && cb_drag.mode === 'pan') {
        var s = cb_screen_pos(cv, e);
        cb_cam.x -= s[0] - cb_drag.last[0];
        cb_cam.y -= s[1] - cb_drag.last[1];
        cb_clamp_camera(cv);
        cb_drag.last = s;
        cb_redraw();
        return;
    }
    if (cb_drag && cb_drag.mode === 'move') {
        var q = cb_pos(cv, e);
        var mdx = q[0] - cb_drag.start[0];
        var mdy = q[1] - cb_drag.start[1];
        cb_drag.xf.dx = cb_drag.base.dx + mdx;
        cb_drag.xf.dy = cb_drag.base.dy + mdy;
        if (mdx * mdx + mdy * mdy >= CB_DRAG_THRESHOLD * CB_DRAG_THRESHOLD) {
            cb_drag.moved = true;
        }
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
            if (Math.abs(d1 - d0) >= CB_DRAG_THRESHOLD) cb_drag.moved = true;
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
    if (e && (e.isPrimary === false || cb_pointer_id === null || e.pointerId !== cb_pointer_id)) return;
    if (e && e.preventDefault) e.preventDefault();
    cb_release_pointer(e);
    cb_pointer_id = null;
    if (cb_drag) {
        var d = cb_drag;
        cb_drag = null;
        var cv = e && e.currentTarget;
        if (cv && cb_tool === 'select') cv.style.cursor = 'grab';
        if (d.mode !== 'pan' && d.moved) {
            var ts = cb_next_ts();
            var ev = { k: 'm', id: cb_id(ts), ts: ts, t: d.target,
                       dx: Math.round(d.xf.dx), dy: Math.round(d.xf.dy),
                       sc: Math.round(d.xf.sc * 1000) / 1000 };
            // Apply locally right away (the echo is deduped by id) so the
            // object does not snap back while the write round-trips.
            cb_write_board_event(ev, true);
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
    d.ts = cb_next_ts();
    d.id = cb_id(d.ts);
    cb_write_board_event(d, false);
    cb_set_tool('select'); // one-shot: back to the default mode
}

function cb_leave(e) {
    var cv = e.currentTarget;
    if (cv && cv.hasPointerCapture && cv.hasPointerCapture(e.pointerId)) return;
    cb_up(e);
}

function cb_cancel(e) {
    if (e && cb_pointer_id !== null && e.pointerId !== cb_pointer_id) return;
    if (e && e.preventDefault) e.preventDefault();
    cb_release_pointer(e);
    cb_pointer_id = null;
    cb_drag = null;
    cb_draft = null;
    var cv = e && e.currentTarget;
    if (cv && cb_tool === 'select') cv.style.cursor = 'grab';
    cb_redraw();
}

function cb_release_pointer(e) {
    var cv = e && e.currentTarget;
    if (!cv || !cv.releasePointerCapture || !cv.hasPointerCapture) return;
    if (cv.hasPointerCapture(e.pointerId)) cv.releasePointerCapture(e.pointerId);
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
    var ts = cb_next_ts();
    cb_write_board_event({
        k: 't', id: cb_id(ts), ts: ts, c: cb_color(), x: p[0], y: p[1], s: cb_enc(s)
    }, false);
    inp.value = '';
    cb_set_tool('select'); // one-shot: back to the default mode
}

// --- apply incoming events -------------------------------------------------

function cb_write_board_event(event, applyLocal) {
    var wire = cb_board_mode === 'owned' ? cb_owned_wire(event) : event;
    writeLogEntry(JSON.stringify(wire));
    if (applyLocal) cb_apply(wire, cb_local_header(wire.ts));
}

function cb_owned_wire(event) {
    var wire = {};
    Object.keys(event).forEach(function (key) { wire[key] = event[key]; });
    if (event.k === 's' || event.k === 't') {
        var profile = cb_local_profile();
        if (profile) {
            wire.n = profile.n;
            wire.c = profile.c;
        }
    }
    wire.a = event.k;
    wire.k = 'o';
    return wire;
}

function cb_local_header(ts) {
    return {
        fid: typeof myId === 'string' ? myId : '@local.ed25519',
        tst: typeof ts === 'number' ? ts : Date.now()
    };
}

function cb_normalize_event(raw, header) {
    var obj = raw;
    if (typeof raw === 'string') {
        try { obj = JSON.parse(raw); } catch (e) { return null; }
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;

    var event = {};
    Object.keys(obj).forEach(function (key) {
        if (key !== '_fid' && key !== '_board') event[key] = obj[key];
    });
    var fid = header && typeof header.fid === 'string' ? header.fid : null;
    if (event.k === 'o') {
        if (!fid || typeof event.a !== 'string') return null;
        event.k = event.a;
        delete event.a;
        event._board = 'owned';
        event._fid = fid;
        if (typeof event.c === 'string') event.c = event.c.toLowerCase();
    } else if (event.k === 'p') {
        if (!fid) return null;
        event._board = 'profile';
        event._fid = fid;
        if (typeof event.c === 'string') event.c = event.c.toLowerCase();
    } else {
        event._board = 'open';
        if (fid) event._fid = fid;
    }
    return event;
}

function cb_apply(raw, header) {
    var obj = cb_normalize_event(raw, header);
    if (!cb_is_valid_event(obj)) return;
    var st = cb_state();
    st.clock = Math.max(st.clock, cb_event_ts(obj));
    if (st.seen.indexOf(obj.id) >= 0) return; // already applied (incl. self-echo)
    st.seen.push(obj.id);

    if (obj.k === 'p') {
        var previous = st.profiles[obj._fid];
        if (!previous || cb_compare_events(obj, previous) > 0) {
            st.profiles[obj._fid] = obj;
            if (typeof myId === 'string' && obj._fid === myId) {
                st.localProfile = { n: obj.n, c: obj.c };
                cb_profile_color = obj.c;
            }
        }
    } else if (obj.k === 'c') {
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
    cb_update_controls();
    cb_refresh_people();
    cb_redraw();
    setTimeout(cb_fit_canvas, 0);
}

// --- rendering -------------------------------------------------------------

function cb_redraw() {
    var cv = document.getElementById('cb_canvas');
    if (!cv) return;
    var ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cv.width, cv.height);
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
    cb_update_selection_status();
}

function cb_visible_objects(st) {
    return st.objects
        .filter(function (o) {
            if (cb_event_board(o) !== cb_board_mode) return false;
            var clear = cb_latest_clear_for(st, o);
            return !clear || cb_compare_events(o, clear) > 0;
        })
        .sort(cb_compare_events);
}

function cb_draw_selection(ctx, st, o) {
    var b = cb_bbox(ctx, st, o);
    ctx.save();
    var editable = cb_is_own_object(o);
    ctx.strokeStyle = editable ? '#2563eb' : '#777777';
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(b.x - CB_SEL_PAD, b.y - CB_SEL_PAD,
                   b.w + 2 * CB_SEL_PAD, b.h + 2 * CB_SEL_PAD);
    ctx.setLineDash([]);
    var h = cb_handle_rect(b);
    if (editable) {
        ctx.fillStyle = '#2563eb';
        ctx.fillRect(h.x, h.y, h.w, h.h);
    }
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
    var target = null;
    st.objects.forEach(function (object) {
        if (object.id === targetId) target = object;
    });
    st.mods.forEach(function (m) {
        if (m.t === targetId && m.k === kind && target &&
            cb_event_board(m) === cb_event_board(target) &&
            (cb_event_board(target) !== 'owned' || m._fid === target._fid) &&
            (!best || cb_compare_events(m, best) > 0)) best = m;
    });
    return best;
}

// effective color: latest recolor mod wins over the object's own color
function cb_eff_color(st, o) {
    if (cb_event_board(o) === 'owned') {
        var profile = cb_profile_for(o._fid);
        return profile ? profile.c : (o.c || '#555555');
    }
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
    if (!obj || !cb_is_own_object(obj)) return null;
    var h = cb_handle_rect(cb_bbox(ctx, st, obj));
    var cx = h.x + h.w / 2;
    var cy = h.y + h.h / 2;
    var half = Math.max(h.w, CB_HANDLE_HIT) / 2;
    if (p[0] >= cx - half && p[0] <= cx + half &&
        p[1] >= cy - half && p[1] <= cy + half) return obj;
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

function cb_find_visible_object(id) {
    var found = null;
    cb_visible_objects(cb_state()).forEach(function (object) {
        if (object.id === id) found = object;
    });
    return found;
}

function cb_is_own_object(object) {
    if (!object || cb_event_board(object) !== 'owned') return true;
    return typeof myId === 'string' && object._fid === myId;
}

function cb_event_board(event) {
    return event && event._board === 'owned' ? 'owned' : 'open';
}

// --- helpers ---------------------------------------------------------------

function cb_id(ts) {
    var who = (typeof myId == "string") ? myId.slice(1, 6) : 'x';
    return who + '-' + (ts || Date.now()) + '-' + Math.floor(Math.random() * 1000000);
}

// Wall clocks can differ between phones. New local events therefore advance
// past every event already observed on this board before using Date.now().
function cb_next_ts() {
    var st = cb_state();
    var next = Math.max(Date.now(), st.clock || 0);
    st.objects.forEach(function (event) { next = Math.max(next, cb_event_ts(event)); });
    st.clears.forEach(function (event) { next = Math.max(next, cb_event_ts(event)); });
    st.mods.forEach(function (event) { next = Math.max(next, cb_event_ts(event)); });
    Object.keys(st.profiles).forEach(function (fid) {
        next = Math.max(next, cb_event_ts(st.profiles[fid]));
    });
    st.clock = next + 1;
    return st.clock;
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

function cb_clamp_camera(cv) {
    var maxX = Math.max(0, CB_COORD_LIMIT - cv.width);
    var maxY = Math.max(0, CB_COORD_LIMIT - cv.height);
    cb_cam.x = Math.round(Math.max(-CB_COORD_LIMIT, Math.min(maxX, cb_cam.x)));
    cb_cam.y = Math.round(Math.max(-CB_COORD_LIMIT, Math.min(maxY, cb_cam.y)));
}

function cb_sync_color_picker(st, o) {
    var color = cb_eff_color(st, o);
    var picker = document.getElementById('cb_color');
    if (picker && cb_is_picker_color(color)) picker.value = color;
}

function cb_is_picker_color(c) {
    return typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c);
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
    if (obj._board === 'profile') {
        return obj.k === 'p' && cb_is_valid_fid(obj._fid) &&
            cb_clean_name(obj.n) === obj.n && CB_PROFILE_COLORS.indexOf(obj.c) >= 0;
    }
    if (typeof obj._board !== 'undefined' &&
        obj._board !== 'open' && obj._board !== 'owned') return false;
    if (obj._board === 'owned' && !cb_is_valid_fid(obj._fid)) return false;
    if (obj.k === 'c') return true;
    if (obj.k === 't') {
        return (obj._board !== 'owned' ||
                (cb_clean_name(obj.n) === obj.n && CB_PROFILE_COLORS.indexOf(obj.c) >= 0)) &&
            cb_is_finite_coord(obj.x) && cb_is_finite_coord(obj.y) &&
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
        return (obj._board !== 'owned' ||
                (cb_clean_name(obj.n) === obj.n && CB_PROFILE_COLORS.indexOf(obj.c) >= 0)) &&
            Array.isArray(obj.p) && obj.p.length > 0 && obj.p.length <= CB_MAX_INCOMING_POINTS &&
            (typeof obj.w === 'undefined' || (typeof obj.w === 'number' && isFinite(obj.w) && obj.w > 0 && obj.w <= 16)) &&
            cb_is_valid_color(obj.c) &&
            obj.p.every(function (p) {
                return cb_is_valid_point(p);
            });
    }
    return false;
}

function cb_prune_state(st) {
    st.objects = st.objects.filter(function (object) {
        var clear = cb_latest_clear_for(st, object);
        return !clear || cb_compare_events(object, clear) > 0;
    });
    if (st.objects.length > CB_MAX_OBJECTS) {
        st.objects = st.objects.slice().sort(cb_compare_events).slice(-CB_MAX_OBJECTS);
    }
    // Only the newest clear for Edit all and for each Edit own author is needed.
    var clears = {};
    st.clears.forEach(function (clear) {
        var key = cb_event_board(clear) + ':' +
            (cb_event_board(clear) === 'owned' ? clear._fid : 'all');
        if (!clears[key] || cb_compare_events(clear, clears[key]) > 0) clears[key] = clear;
    });
    st.clears = Object.keys(clears).map(function (key) { return clears[key]; });
    if (st.clears.length > Math.max(CB_MAX_CLEARS, CB_MAX_PROFILES)) {
        st.clears = st.clears.slice().sort(cb_compare_events).slice(-CB_MAX_PROFILES);
    }
    // Keep one candidate per author in Owned mode. This preserves an owner's
    // valid edit even if another feed sends a newer, unauthorized edit first.
    var latest = {};
    st.mods.forEach(function (m) {
        var key = cb_event_board(m) + ':' + m.k + ':' + m.t + ':' +
            (cb_event_board(m) === 'owned' ? m._fid : 'all');
        if (!latest[key] || cb_compare_events(m, latest[key]) > 0) latest[key] = m;
    });
    st.mods = Object.keys(latest).map(function (key) { return latest[key]; });
    if (st.mods.length > CB_MAX_MODS) {
        st.mods = st.mods.slice().sort(cb_compare_events).slice(-CB_MAX_MODS);
    }
    if (st.seen.length > CB_MAX_SEEN) {
        st.seen = st.seen.slice(st.seen.length - CB_MAX_SEEN);
    }
    var profileIds = Object.keys(st.profiles);
    if (profileIds.length > CB_MAX_PROFILES) {
        profileIds.sort(function (a, b) {
            return cb_compare_events(st.profiles[a], st.profiles[b]);
        }).slice(0, profileIds.length - CB_MAX_PROFILES).forEach(function (fid) {
            delete st.profiles[fid];
        });
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
    return typeof c === 'undefined' || cb_is_picker_color(c);
}

function cb_is_valid_fid(fid) {
    return typeof fid === 'string' && fid.length > 0 && fid.length <= 160;
}

function cb_latest_clear(st, board, fid) {
    board = board === 'owned' ? 'owned' : 'open';
    var best = null;
    (st.clears || []).forEach(function (clear) {
        if (cb_event_board(clear) !== board) return;
        if (board === 'owned' && clear._fid !== fid) return;
        if (!best || cb_compare_events(clear, best) > 0) best = clear;
    });
    return best;
}

function cb_latest_clear_for(st, object) {
    var board = cb_event_board(object);
    return cb_latest_clear(st, board, board === 'owned' ? object._fid : null);
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
