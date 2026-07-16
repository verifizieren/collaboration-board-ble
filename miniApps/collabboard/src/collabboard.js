/* collabboard.js
 *
 * Collaboration Board miniApp for Tremola.
 *
 * A shared canvas. Pen strokes and text labels are written to the append-only
 * log via writeLogEntry() and replayed on every peer via the
 * "incoming_notification" callback. Finished local actions are also applied
 * immediately so a WebView redraw cannot hide them while the signed log echo
 * is still on its way. The echo is deduplicated by the event id.
 *
 * Event payloads (the object passed to writeLogEntry):
 *   stroke: { k:'s', id, c:<color>, w:<width>, p:[[x,y], ...] }
 *   text:   { k:'t', id, c:<color>, x, y, s:<string> }
 *   clear:  { k:'c', id }
 *   modify: { k:'m', id, t:<targetId>, dx, dy, sc } — move/scale an object;
 *           absolute offset+scale relative to the original, last write wins
 *   recolor:{ k:'k', id, t:<targetId>, c:<color> } — last write wins
 *   delete: { k:'d', id, t:<targetId> } — removes one object
 *   name:   { k:'n', id, b:<boardName> } — shared board display name
 *
 * Every peer may edit every object. Retired profile/owner events from
 * experimental builds are ignored.
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
                if (cb_view_mode) cb_exit_view();
                else {
                    var roomId = cb_current_room_id();
                    if (roomId) {
                        cb_resume_room_id = roomId;
                        cb_resume_until = Date.now() + CB_QUICK_RESUME_MS;
                    }
                    quitApp();
                }
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

// 'select' is the default mode: tap an object to select it, drag it to move,
// and drag the corner handle to resize.
// Pen and Text stay active until their button is tapped again. This makes
// repeated drawing and text placement predictable on a phone.
var cb_tool = 'select';
var cb_draft = null;
// Kept for old saved/test state. The finite board always fixes it at zero.
var cb_cam = { x: 0, y: 0 };
var cb_drag = null;
var cb_sel = null; // id of the selected object (select tool)
var cb_pointer_id = null;
var cb_state_migrated = false;
var cb_members = Object.create(null);
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
var CB_MAX_DELETES = 2000;
var CB_MAX_SEEN = 4000;
var CB_MAX_NAMES = 8;
var CB_STATE_VERSION = 5;
var CB_INITIAL_VIEW_WIDTH = 900;
var CB_INITIAL_VIEW_HEIGHT = 1200;
var CB_BOARD_WIDTH = 1800;
var CB_BOARD_HEIGHT = 2400;
var CB_COORD_LIMIT = 4800;
var CB_MAX_MEMBERS = 4;
var CB_TEXT_SIZE = 36;
var CB_TEXT_LINE_HEIGHT = 42;
var CB_QUICK_RESUME_MS = 30000;
var CB_REPLAY_LOCAL_QUIET_MS = 100;
var CB_REPLAY_REMOTE_QUIET_MS = 1800;
var cb_native_config_pending = false;
var cb_pending_pairing_code = '';
var cb_pending_copy_code = '';
var cb_setup_mode = 'create';
var cb_delete_room_id = '';
var cb_delete_busy = false;
var cb_view_mode = false;
var cb_dark_canvas = false;
var cb_view = { scale: 1, x: 0, y: 0, minScale: 0.05, maxScale: 4 };
var cb_view_pointers = Object.create(null);
var cb_view_gesture = null;
var cb_view_bound = false;
var cb_edit_view = {
    scale: 0, x: 0, y: 0, fit: 0, minScale: 0.05, maxScale: 4,
    width: 0, height: 0, initialized: false
};
var cb_edit_pointers = Object.create(null);
var cb_edit_gesture = null;
var cb_edit_navigation = false;
var cb_pending_text_point = null;
var cb_pending_open_kind = '';
var cb_force_publish_name = false;
var cb_resume_room_id = '';
var cb_resume_until = 0;
var cb_replay_active = false;
var cb_replay_native_done = false;
var cb_replay_waiting_for_peer = false;
var cb_replay_remote = false;
var cb_replay_timer = null;

function cb_is_android() {
    return typeof Android !== 'undefined' && typeof backend === 'function';
}

function cb_current_room() {
    if (tremola && tremola.collabboardRoom && tremola.collabboardRoom.r) {
        return tremola.collabboardRoom;
    }
    if (!cb_is_android()) {
        return {
            v: 1,
            r: 'browser-preview',
            k: '',
            o: typeof myId === 'string' ? myId : '@browser.ed25519',
            u: 'Preview'
        };
    }
    return null;
}

function cb_current_room_id() {
    var room = cb_current_room();
    return room ? room.r : null;
}

function cb_utf8_b64(value) {
    return btoa(unescape(encodeURIComponent(value)));
}

function cb_random_token(byteCount) {
    var bytes = new Uint8Array(byteCount);
    if (window.crypto && window.crypto.getRandomValues) {
        window.crypto.getRandomValues(bytes);
    } else {
        for (var i = 0; i < byteCount; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    var binary = '';
    for (var j = 0; j < bytes.length; j++) binary += String.fromCharCode(bytes[j]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function cb_clean_username(value) {
    return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 24);
}

function cb_clean_pairing_code(value) {
    return String(value || '').replace(/\D/g, '').slice(0, 6);
}

function cb_valid_pairing_code(value) {
    return /^\d{6}$/.test(String(value || ''));
}

function cb_random_pairing_code() {
    var value;
    if (window.crypto && window.crypto.getRandomValues) {
        var values = new Uint32Array(1);
        window.crypto.getRandomValues(values);
        value = values[0] % 1000000;
    } else {
        value = Math.floor(Math.random() * 1000000);
    }
    return ('000000' + value).slice(-6);
}

function cb_new_pairing_code() {
    var used = Object.create(null);
    var catalog = cb_board_catalog();
    Object.keys(catalog).forEach(function (roomId) {
        var entry = catalog[roomId];
        var code = entry && entry.room ? entry.room.p : '';
        if (cb_valid_pairing_code(code)) used[code] = true;
    });
    var code = '';
    for (var attempt = 0; attempt < 32; attempt++) {
        code = cb_random_pairing_code();
        if (!used[code]) return code;
    }
    var number = parseInt(code || '0', 10);
    do {
        number = (number + 1) % 1000000;
        code = ('000000' + number).slice(-6);
    } while (used[code]);
    return code;
}

function cb_clean_board_name(value) {
    return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 40);
}

function cb_board_name(room) {
    return cb_clean_board_name(room && room.b) || 'Board';
}

function cb_is_default_board_name(name, code) {
    var clean = cb_clean_board_name(name);
    var cleanCode = cb_clean_pairing_code(code);
    return !clean || clean === 'Board' || (cleanCode && clean === 'Board ' + cleanCode);
}

function cb_stable_board_name(incomingRoom, oldRoom) {
    var incoming = cb_board_name(incomingRoom);
    var old = cb_board_name(oldRoom);
    if (cb_is_default_board_name(incoming, incomingRoom && incomingRoom.p) &&
        !cb_is_default_board_name(old, oldRoom && oldRoom.p)) return old;
    return incoming;
}

function cb_blur_setup_inputs() {
    ['cb_username', 'cb_board_name', 'cb_join_code', 'cb_delete_code'].forEach(function (id) {
        var input = document.getElementById(id);
        if (input && input.blur) input.blur();
    });
}

function cb_reset_page_scroll() {
    if (typeof document === 'undefined') return;
    var targets = [document.scrollingElement, document.documentElement, document.body,
        document.getElementById('core'), document.getElementById('div:collabboard-main')];
    targets.forEach(function (target) {
        if (target && typeof target.scrollTop === 'number') target.scrollTop = 0;
        if (target && typeof target.scrollLeft === 'number') target.scrollLeft = 0;
    });
    if (typeof window !== 'undefined' && typeof window.scrollTo === 'function') {
        try { window.scrollTo(0, 0); } catch (_e) {}
    }
}

function cb_schedule_page_reset() {
    cb_reset_page_scroll();
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(cb_reset_page_scroll);
    setTimeout(cb_reset_page_scroll, 80);
    setTimeout(cb_reset_page_scroll, 260);
}

function cb_should_quick_resume(roomId, now) {
    return !!roomId && roomId === cb_resume_room_id &&
        Number(now) <= cb_resume_until;
}

function cb_board_catalog() {
    if (!tremola.collabboardBoards || typeof tremola.collabboardBoards !== 'object' ||
        Array.isArray(tremola.collabboardBoards)) {
        tremola.collabboardBoards = {};
    }
    return tremola.collabboardBoards;
}

function cb_remember_room(room, touch) {
    if (!room || typeof room.r !== 'string' || room.r.length < 8 ||
        typeof room.k !== 'string' || room.k.length < 32 || typeof room.o !== 'string') return;
    var catalog = cb_board_catalog();
    var old = catalog[room.r];
    room.b = cb_stable_board_name(room, old && old.room);
    var entry = {
        room: room,
        updated: touch || !old ? Date.now() : Number(old.updated) || Date.now()
    };
    // Android keeps operations in Room. The browser preview has no native
    // database, so retain its current state with the catalog entry instead.
    if (!cb_is_android() && tremola.collabboard && tremola.collabboard.roomId === room.r) {
        entry.state = tremola.collabboard;
    } else if (!cb_is_android() && old && old.state) {
        entry.state = old.state;
    }
    catalog[room.r] = entry;
}

function cb_forget_catalog_room(roomId) {
    var catalog = cb_board_catalog();
    if (Object.prototype.hasOwnProperty.call(catalog, roomId)) delete catalog[roomId];
}

function cb_set_setup_mode(mode) {
    cb_setup_mode = mode === 'join' ? 'join' : 'create';
    var createTab = document.getElementById('cb_setup_create_tab');
    var joinTab = document.getElementById('cb_setup_join_tab');
    var createPanel = document.getElementById('cb_create_panel');
    var joinPanel = document.getElementById('cb_join_panel');
    if (createTab) {
        createTab.classList.toggle('cb_active', cb_setup_mode === 'create');
        createTab.setAttribute('aria-selected', cb_setup_mode === 'create' ? 'true' : 'false');
    }
    if (joinTab) {
        joinTab.classList.toggle('cb_active', cb_setup_mode === 'join');
        joinTab.setAttribute('aria-selected', cb_setup_mode === 'join' ? 'true' : 'false');
    }
    if (createPanel) createPanel.style.display = cb_setup_mode === 'create' ? null : 'none';
    if (joinPanel) joinPanel.style.display = cb_setup_mode === 'join' ? null : 'none';
    cb_set_setup_error('');
}

function cb_render_board_list() {
    var container = document.getElementById('cb_saved_boards');
    var empty = document.getElementById('cb_saved_empty');
    var catalog = cb_board_catalog();
    var entries = Object.keys(catalog).map(function (roomId) {
        return catalog[roomId];
    }).filter(function (entry) {
        return entry && entry.room && entry.room.r;
    }).sort(function (a, b) {
        return (Number(b.updated) || 0) - (Number(a.updated) || 0);
    });
    if (empty) empty.style.display = entries.length ? 'none' : null;
    if (!container || typeof document.createElement !== 'function') return;
    if (container.classList) container.classList.toggle('cb_saved_boards_scroll', entries.length > 4);
    container.textContent = '';
    entries.forEach(function (entry) {
        var row = document.createElement('div');
        row.className = 'cb_saved_board';
        var name = document.createElement('span');
        name.className = 'cb_saved_board_name';
        name.textContent = cb_board_name(entry.room);
        var open = document.createElement('button');
        open.className = 'cb_saved_open';
        open.type = 'button';
        open.textContent = 'Open';
        open.onclick = function () { cb_open_saved_board(entry.room.r); };
        var remove = document.createElement('button');
        remove.className = 'cb_saved_delete';
        remove.type = 'button';
        remove.textContent = 'Delete';
        remove.onclick = function () { cb_request_delete_board(entry.room.r); };
        row.appendChild(name);
        row.appendChild(open);
        row.appendChild(remove);
        container.appendChild(row);
    });
}

function cb_set_setup_error(message) {
    var el = document.getElementById('cb_setup_error');
    if (el) el.textContent = message || '';
}

function cb_show_setup(show) {
    var setup = document.getElementById('cb_room_setup');
    var workspace = document.getElementById('cb_workspace');
    if (setup) setup.style.display = show ? null : 'none';
    if (workspace) workspace.style.display = show ? 'none' : null;
    if (show) {
        if (cb_view_mode) cb_exit_view();
        cb_render_board_list();
        cb_schedule_page_reset();
    } else {
        cb_blur_setup_inputs();
        cb_schedule_page_reset();
    }
}

function cb_create_board() {
    var usernameInput = document.getElementById('cb_username');
    var nameInput = document.getElementById('cb_board_name');
    var username = cb_clean_username(usernameInput && usernameInput.value);
    var boardName = cb_clean_board_name(nameInput && nameInput.value);
    if (!username) {
        cb_set_setup_error('Enter a name');
        if (usernameInput) usernameInput.focus();
        return;
    }
    if (!boardName) {
        cb_set_setup_error('Enter a board name');
        if (nameInput) nameInput.focus();
        return;
    }
    var code = cb_new_pairing_code();
    cb_blur_setup_inputs();
    cb_pending_open_kind = 'create';
    cb_force_publish_name = true;
    tremola.collabboardLastUser = username;
    persist();
    if (cb_is_android()) {
        cb_native_config_pending = true;
        cb_set_setup_error('Opening board...');
        backend('collabboard:open-code ' + cb_utf8_b64(JSON.stringify({
            u: username, c: code, b: boardName
        })));
        return;
    }
    cb_pending_pairing_code = code;
    cb_activate_room({
        v: 1,
        r: cb_random_token(12),
        k: cb_random_token(32),
        o: typeof myId === 'string' ? myId : '@local.ed25519',
        u: username,
        b: boardName,
        p: code,
        d: 1
    });
}

function cb_join_board() {
    var usernameInput = document.getElementById('cb_username');
    var codeInput = document.getElementById('cb_join_code');
    var username = cb_clean_username(usernameInput && usernameInput.value);
    var code = cb_clean_pairing_code(codeInput && codeInput.value);
    if (!username) {
        cb_set_setup_error('Enter a name');
        return;
    }
    if (!cb_valid_pairing_code(code)) {
        cb_set_setup_error('Enter a 6-digit code');
        if (codeInput) codeInput.focus();
        return;
    }
    if (!cb_is_android()) {
        cb_set_setup_error('Join is available in the Android app');
        return;
    }
    cb_blur_setup_inputs();
    cb_pending_open_kind = 'join';
    cb_force_publish_name = false;
    tremola.collabboardLastUser = username;
    persist();
    cb_native_config_pending = true;
    cb_set_setup_error('Opening board...');
    backend('collabboard:open-code ' + cb_utf8_b64(JSON.stringify({ u: username, c: code })));
}

function cb_open_saved_board(roomId) {
    var entry = cb_board_catalog()[roomId];
    if (!entry || !entry.room) {
        cb_set_setup_error('Board is not available');
        return;
    }
    var usernameInput = document.getElementById('cb_username');
    var username = cb_clean_username(usernameInput && usernameInput.value) ||
        cb_clean_username(tremola.collabboardLastUser) || cb_clean_username(entry.room.u);
    if (!username) {
        cb_set_setup_error('Enter a name');
        if (usernameInput) usernameInput.focus();
        return;
    }
    entry.room.u = username;
    cb_pending_open_kind = 'saved';
    cb_force_publish_name = false;
    tremola.collabboardLastUser = username;
    cb_activate_room(entry.room, !cb_is_android() ? entry.state : null);
}

function cb_request_delete_board(roomId) {
    var entry = cb_board_catalog()[roomId];
    if (!entry || !entry.room) return;
    cb_delete_room_id = roomId;
    cb_delete_busy = false;
    var panel = document.getElementById('cb_delete_panel');
    var name = document.getElementById('cb_delete_name');
    var code = document.getElementById('cb_delete_code');
    var button = document.getElementById('cb_delete_board_btn');
    var error = document.getElementById('cb_delete_error');
    if (panel) panel.style.display = null;
    if (name) name.textContent = cb_board_name(entry.room);
    if (code) {
        code.value = '';
        code.focus();
    }
    if (button) button.disabled = false;
    if (error) error.textContent = '';
}

function cb_cancel_delete_board() {
    cb_delete_room_id = '';
    cb_delete_busy = false;
    var panel = document.getElementById('cb_delete_panel');
    var code = document.getElementById('cb_delete_code');
    var button = document.getElementById('cb_delete_board_btn');
    var error = document.getElementById('cb_delete_error');
    if (panel) panel.style.display = 'none';
    if (code) code.value = '';
    if (button) button.disabled = false;
    if (error) error.textContent = '';
}

function cb_set_delete_error(message) {
    var error = document.getElementById('cb_delete_error');
    if (error) error.textContent = message || '';
}

function cb_confirm_delete_board() {
    if (cb_delete_busy || !cb_delete_room_id) return;
    var entry = cb_board_catalog()[cb_delete_room_id];
    var input = document.getElementById('cb_delete_code');
    var code = cb_clean_pairing_code(input && input.value);
    if (!entry || !entry.room) {
        cb_cancel_delete_board();
        return;
    }
    if (!cb_valid_pairing_code(code)) {
        cb_set_delete_error('Enter the 6-digit code');
        if (input) input.focus();
        return;
    }
    if (!cb_is_android()) {
        if (entry.room.p !== code) {
            cb_set_delete_error('Wrong code');
            return;
        }
        cb_board_deleted(cb_delete_room_id, true);
        return;
    }
    cb_delete_busy = true;
    var button = document.getElementById('cb_delete_board_btn');
    if (button) button.disabled = true;
    cb_set_delete_error('Deleting...');
    backend('collabboard:delete ' + cb_utf8_b64(JSON.stringify({
        r: cb_delete_room_id,
        c: code,
        config: entry.room
    })));
}

function cb_board_delete_started(accepted) {
    if (accepted) return;
    cb_delete_busy = false;
    var button = document.getElementById('cb_delete_board_btn');
    if (button) button.disabled = false;
    cb_set_delete_error('Wrong code or board is open');
}

function cb_board_deleted(roomId, success) {
    if (!success) {
        cb_board_delete_started(false);
        return;
    }
    cb_forget_catalog_room(roomId);
    persist();
    cb_cancel_delete_board();
    cb_render_board_list();
    cb_set_setup_error('Board deleted from this phone');
}

function cb_set_replay_ui(loading) {
    var workspace = document.getElementById('cb_workspace');
    var overlay = document.getElementById('cb_board_loading');
    if (workspace && workspace.classList) {
        workspace.classList.toggle('cb_replay_loading', !!loading);
    }
    if (overlay) overlay.style.display = loading ? null : 'none';
}

function cb_clear_replay_timer() {
    if (cb_replay_timer !== null) clearTimeout(cb_replay_timer);
    cb_replay_timer = null;
}

function cb_begin_board_replay(kind) {
    cb_clear_replay_timer();
    cb_replay_active = true;
    cb_replay_native_done = false;
    cb_replay_waiting_for_peer = kind === 'join';
    cb_replay_remote = kind === 'join' || kind === 'catchup';
    cb_set_replay_ui(true);
}

function cb_schedule_replay_finish(delay) {
    if (!cb_replay_active) return;
    cb_clear_replay_timer();
    cb_replay_timer = setTimeout(cb_finish_board_replay, Math.max(0, Number(delay) || 0));
}

function cb_finish_board_replay() {
    if (!cb_replay_active) return;
    cb_clear_replay_timer();
    cb_replay_active = false;
    cb_replay_native_done = false;
    cb_replay_remote = false;
    cb_pending_open_kind = '';
    cb_set_replay_ui(false);
    var room = cb_current_room();
    if (!room) return;
    var st = cb_state();
    cb_apply_synced_board_name(st);
    cb_remember_room(room, true);
    persist();
    cb_redraw();
    cb_schedule_fit();
}

function cb_stop_board_replay() {
    cb_clear_replay_timer();
    cb_replay_active = false;
    cb_replay_native_done = false;
    cb_replay_waiting_for_peer = false;
    cb_replay_remote = false;
    cb_set_replay_ui(false);
}

function cb_latest_board_name_event(st) {
    var best = null;
    (st.names || []).forEach(function (event) {
        if (!best || cb_compare_events(event, best) > 0) best = event;
    });
    return best;
}

function cb_apply_synced_board_name(st) {
    var event = cb_latest_board_name_event(st);
    var room = cb_current_room();
    var name = cb_clean_board_name(event && event.b);
    if (!room || !name || room.b === name) return;
    room.b = name;
    cb_remember_room(room, false);
    cb_update_room_bar();
    cb_render_board_list();
}

function cb_ensure_board_name_event() {
    var room = cb_current_room();
    if (!room) return;
    var st = cb_state();
    var existing = cb_latest_board_name_event(st);
    if (existing) {
        cb_apply_synced_board_name(st);
        cb_force_publish_name = false;
        return;
    }
    var name = cb_clean_board_name(room.b);
    var shouldPublish = cb_force_publish_name || !cb_is_default_board_name(name, room.p);
    cb_force_publish_name = false;
    if (!name || !shouldPublish || cb_native_config_pending) return;
    var ts = cb_next_ts();
    cb_write_board_event({ k: 'n', id: cb_id(ts), ts: ts, b: name }, true);
}

function cb_board_replay_complete() {
    if (!cb_current_room()) return;
    cb_replay_native_done = true;
    cb_ensure_board_name_event();
    cb_schedule_replay_finish(cb_replay_remote ?
        CB_REPLAY_REMOTE_QUIET_MS : CB_REPLAY_LOCAL_QUIET_MS);
}

function cb_activate_room(room, savedState) {
    cb_reset_edit_view();
    room.b = cb_board_name(room);
    tremola.collabboardRoom = room;
    tremola.collabboard = savedState && savedState.roomId === room.r ? savedState : {
            roomId: room.r, names: [],
            objects: [], clears: [], deletes: [], seen: [], mods: [], clock: 0, order: 0,
            schema: CB_STATE_VERSION
        };
    cb_remember_room(room, true);
    persist();
    cb_native_config_pending = cb_is_android();
    cb_set_setup_error(cb_native_config_pending ? 'Opening board...' : '');
    cb_show_setup(cb_native_config_pending);
    if (cb_is_android()) {
        backend('collabboard:configure ' + cb_utf8_b64(JSON.stringify(room)));
    } else {
        cb_board_configured(true);
    }
    cb_update_room_bar();
    cb_fit_canvas();
    cb_redraw();
}

function cb_board_configured(accepted) {
    cb_native_config_pending = false;
    if (!accepted) {
        cb_stop_board_replay();
        cb_show_setup(true);
        cb_set_setup_error('Could not open this board');
        return;
    }
    cb_begin_board_replay(cb_pending_open_kind || 'saved');
    cb_set_setup_error('');
    cb_show_setup(false);
    cb_schedule_fit();
    if (cb_is_android()) {
        backend('collabboard:read');
        if (cb_pending_pairing_code) {
            var code = cb_pending_pairing_code;
            cb_pending_pairing_code = '';
            backend('collabboard:pairing ' + cb_utf8_b64(code));
        }
    } else {
        cb_ble_status('Browser preview', 0, 0);
        cb_board_replay_complete();
        cb_finish_board_replay();
    }
}

function cb_board_join_started(accepted) {
    if (accepted) return;
    cb_native_config_pending = false;
    cb_set_setup_error('Could not start joining');
}

function cb_board_code_opened(configJson) {
    if (!configJson) {
        cb_board_join_failed('Could not open this board');
        return;
    }
    cb_board_joined(configJson);
}

function cb_board_joined(configJson) {
    try {
        var config = typeof configJson === 'string' ? JSON.parse(configJson) : configJson;
        if (!config || typeof config.r !== 'string' || config.r.length < 8 ||
            typeof config.k !== 'string' || config.k.length < 32 ||
            typeof config.o !== 'string' || !cb_clean_username(config.u)) {
            throw new Error('bad board');
        }
        config.v = 1;
        var oldEntry = cb_board_catalog()[config.r];
        config.b = cb_stable_board_name(config, oldEntry && oldEntry.room);
        cb_reset_edit_view();
        cb_native_config_pending = cb_is_android() && config.d !== 1;
        tremola.collabboardRoom = config;
        tremola.collabboard = {
            roomId: config.r, names: [],
            objects: [], clears: [], deletes: [], seen: [], mods: [], clock: 0, order: 0,
            schema: CB_STATE_VERSION
        };
        cb_remember_room(config, true);
        persist();
        cb_begin_board_replay(cb_pending_open_kind || 'join');
        cb_set_setup_error('');
        cb_show_setup(false);
        cb_update_room_bar();
        cb_schedule_fit();
        cb_redraw();
        if (cb_is_android()) {
            backend('collabboard:read');
            if (config.d === 1) cb_ble_status('Board ready', 1, 0);
        }
    } catch (e) {
        cb_board_join_failed('Could not open this board');
    }
}

function cb_board_join_failed(message) {
    cb_stop_board_replay();
    cb_native_config_pending = false;
    cb_show_setup(true);
    cb_set_setup_error(message || 'Could not join this board');
}

function cb_board_access_rejected(message) {
    var room = tremola.collabboardRoom;
    if (room && room.r) cb_forget_catalog_room(room.r);
    delete tremola.collabboardRoom;
    delete tremola.collabboard;
    cb_members = Object.create(null);
    cb_stop_board_replay();
    cb_native_config_pending = false;
    persist();
    cb_show_setup(true);
    cb_set_setup_error(message || 'Board access was not accepted');
}

function cb_board_access_ready() {
    cb_native_config_pending = false;
    cb_ble_status('Board ready', 1, 0);
}

function cb_pairing_started(accepted, seconds) {
    var copyCode = cb_pending_copy_code;
    cb_pending_copy_code = '';
    if (!accepted) {
        cb_ble_status('Invite failed', 0, 0);
        return;
    }
    if (copyCode) cb_copy_text(copyCode);
    cb_ble_status('Code ready for ' + Math.max(1, Math.round((Number(seconds) || 600) / 60)) +
        ' minutes', 0, 0);
}

function cb_board_write_failed() {
    cb_ble_status('Board write failed', 0, 0);
}

function cb_copy_invite() {
    var room = cb_current_room();
    var code = room && cb_valid_pairing_code(room.p) ? room.p : '';
    if (!room || typeof myId !== 'string' || room.o !== myId) return;
    if (!code) {
        code = cb_random_pairing_code();
        room.p = code;
        cb_remember_room(room, true);
        persist();
    }
    cb_pending_copy_code = code;
    if (room.d === 1) {
        cb_pending_copy_code = '';
        cb_copy_text(code);
        return;
    }
    if (cb_is_android()) {
        backend('collabboard:pairing ' + cb_utf8_b64(code));
        return;
    }
    cb_copy_text(code);
}

function cb_copy_text(code) {
    var finish = function () { cb_ble_status('Invite copied', 0, 0); };
    if (cb_is_android() && typeof Android.copyCollaborationBoardInvite === 'function') {
        if (Android.copyCollaborationBoardInvite(cb_utf8_b64(code))) finish();
        return;
    }
    var fallback = function () {
        var input = document.getElementById('cb_invite_copy');
        if (!input) return;
        input.value = code;
        input.style.display = 'block';
        input.select();
        try { document.execCommand('copy'); finish(); } catch (e) {}
        input.style.display = 'none';
    };
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(code).then(finish, fallback);
        return;
    }
    fallback();
}

function cb_close_board() {
    if (cb_view_mode) cb_exit_view();
    cb_stop_board_replay();
    var room = tremola.collabboardRoom;
    if (room) cb_remember_room(room, true);
    if (cb_is_android()) backend('collabboard:close');
    delete tremola.collabboardRoom;
    delete tremola.collabboard;
    cb_members = Object.create(null);
    cb_reset_edit_view();
    cb_pending_pairing_code = '';
    cb_pending_copy_code = '';
    cb_pending_open_kind = '';
    cb_force_publish_name = false;
    cb_resume_room_id = '';
    cb_resume_until = 0;
    persist();
    cb_show_setup(true);
    cb_set_setup_error('');
}

function cb_leave_board() {
    cb_close_board();
}

function cb_update_room_bar() {
    var room = cb_current_room();
    var label = document.getElementById('cb_room_label');
    var invite = document.getElementById('cb_invite_btn');
    var code = document.getElementById('cb_room_code');
    if (label) label.textContent = room ? cb_board_name(room) : '';
    if (invite) {
        invite.style.display = room && typeof myId === 'string' && room.o === myId ? null : 'none';
    }
    if (code) {
        var showCode = room && typeof myId === 'string' && room.o === myId &&
            cb_valid_pairing_code(room.p);
        code.textContent = showCode ? 'Code ' + room.p : '';
        code.style.display = showCode ? null : 'none';
    }
    cb_apply_dark_state();
}

function cb_room_status(count, maximum, members) {
    var peerCount = Math.min(Number(count) || 1, maximum || CB_MAX_MEMBERS);
    var label = document.getElementById('cb_member_count');
    if (label) label.textContent = peerCount + '/' + (maximum || CB_MAX_MEMBERS);
    if (peerCount > 1 && cb_replay_waiting_for_peer) {
        cb_begin_board_replay('catchup');
        cb_replay_native_done = true;
        cb_schedule_replay_finish(CB_REPLAY_REMOTE_QUIET_MS);
    }
    if (Array.isArray(members)) {
        cb_members = Object.create(null);
        members.forEach(function (member) {
            if (!member || typeof member.f !== 'string') return;
            var name = cb_clean_username(member.u);
            if (name) cb_members[member.f] = name;
        });
        var room = cb_current_room();
        if (room && typeof myId === 'string' && cb_members[myId] &&
            room.u !== cb_members[myId]) {
            room.u = cb_members[myId];
            persist();
            cb_update_room_bar();
        }
        cb_update_selection_controls();
    }
}

function cb_receive_board_operation(payload, feedId, username) {
    var room = cb_current_room();
    if (!room) return;
    if (cb_replay_waiting_for_peer && typeof feedId === 'string' &&
        (typeof myId !== 'string' || feedId !== myId)) {
        cb_begin_board_replay('catchup');
        cb_replay_native_done = true;
    }
    cb_apply(payload, { fid: feedId, tst: Date.now(), username: username });
}

// --- local board view ------------------------------------------------------

function cb_apply_dark_state() {
    var workspace = document.getElementById('cb_workspace');
    var button = document.getElementById('cb_dark_btn');
    if (workspace) workspace.classList.toggle('cb_dark_canvas', cb_dark_canvas);
    if (button) {
        button.classList.toggle('cb_active', cb_dark_canvas);
        button.setAttribute('aria-pressed', cb_dark_canvas ? 'true' : 'false');
    }
}

function cb_toggle_dark() {
    cb_dark_canvas = !cb_dark_canvas;
    tremola.collabboardDark = cb_dark_canvas;
    persist();
    cb_apply_dark_state();
    cb_redraw();
}

function cb_enter_view() {
    if (!cb_current_room() || cb_view_mode) return;
    cb_view_mode = true;
    cb_sel = null;
    cb_drag = null;
    cb_draft = null;
    cb_pointer_id = null;
    cb_view_pointers = Object.create(null);
    cb_view_gesture = null;
    cb_set_tool('select');
    var workspace = document.getElementById('cb_workspace');
    var frame = document.getElementById('cb_canvas_frame');
    if (workspace) workspace.classList.add('cb_view_mode');
    if (frame) {
        frame.style.height = '';
        frame.style.flexBasis = '';
    }
    cb_apply_dark_state();
    cb_redraw();
    setTimeout(cb_reset_view, 0);
}

function cb_exit_view() {
    if (!cb_view_mode) return;
    cb_view_mode = false;
    cb_view_pointers = Object.create(null);
    cb_view_gesture = null;
    var workspace = document.getElementById('cb_workspace');
    var cv = document.getElementById('cb_canvas');
    if (workspace) workspace.classList.remove('cb_view_mode');
    if (cv) cv.style.transform = 'none';
    cb_schedule_fit();
}

function cb_reset_view() {
    if (!cb_view_mode) return;
    var frame = document.getElementById('cb_canvas_frame');
    if (!frame) return;
    var width = frame.clientWidth || (frame.getBoundingClientRect && frame.getBoundingClientRect().width) || 1;
    var height = frame.clientHeight || (frame.getBoundingClientRect && frame.getBoundingClientRect().height) || 1;
    var fit = Math.max(0.05, Math.min(width / CB_BOARD_WIDTH, height / CB_BOARD_HEIGHT));
    cb_view.minScale = Math.max(0.03, fit * 0.5);
    cb_view.maxScale = Math.max(4, fit * 8);
    cb_view.scale = fit;
    cb_view.x = (width - CB_BOARD_WIDTH * fit) / 2;
    cb_view.y = (height - CB_BOARD_HEIGHT * fit) / 2;
    cb_apply_view_transform();
}

function cb_apply_view_transform() {
    if (!cb_view_mode) return;
    var cv = document.getElementById('cb_canvas');
    if (!cv) return;
    cb_clamp_view();
    cv.style.width = CB_BOARD_WIDTH + 'px';
    cv.style.height = CB_BOARD_HEIGHT + 'px';
    cv.style.transform = 'translate3d(' + Math.round(cb_view.x) + 'px,' +
        Math.round(cb_view.y) + 'px,0) scale(' + cb_view.scale + ')';
}

function cb_clamp_view() {
    var frame = document.getElementById('cb_canvas_frame');
    if (!frame) return;
    var width = frame.clientWidth || (frame.getBoundingClientRect && frame.getBoundingClientRect().width) || 1;
    var height = frame.clientHeight || (frame.getBoundingClientRect && frame.getBoundingClientRect().height) || 1;
    cb_view.scale = Math.max(cb_view.minScale, Math.min(cb_view.maxScale, cb_view.scale));
    cb_view.x = cb_clamp_view_axis(cb_view.x, width, CB_BOARD_WIDTH * cb_view.scale);
    cb_view.y = cb_clamp_view_axis(cb_view.y, height, CB_BOARD_HEIGHT * cb_view.scale);
}

function cb_clamp_view_axis(value, viewport, content) {
    if (content <= viewport) return (viewport - content) / 2;
    var visible = Math.min(48, viewport / 3);
    return Math.max(visible - content, Math.min(viewport - visible, value));
}

function cb_view_pointer_values() {
    return Object.keys(cb_view_pointers).map(function (id) { return cb_view_pointers[id]; });
}

function cb_begin_view_gesture() {
    var points = cb_view_pointer_values();
    if (!points.length) {
        cb_view_gesture = null;
        return;
    }
    if (points.length === 1) {
        cb_view_gesture = {
            mode: 'pan', startX: points[0].x, startY: points[0].y,
            baseX: cb_view.x, baseY: cb_view.y
        };
        return;
    }
    var midX = (points[0].x + points[1].x) / 2;
    var midY = (points[0].y + points[1].y) / 2;
    var distance = Math.max(1, Math.hypot(points[1].x - points[0].x,
        points[1].y - points[0].y));
    cb_view_gesture = {
        mode: 'pinch', distance: distance, scale: cb_view.scale,
        worldX: (midX - cb_view.x) / cb_view.scale,
        worldY: (midY - cb_view.y) / cb_view.scale
    };
}

function cb_view_down(e) {
    if (!cb_view_mode || (e.target && e.target.id === 'cb_view_exit')) return;
    if (e.preventDefault) e.preventDefault();
    cb_view_pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
    if (e.currentTarget && e.currentTarget.setPointerCapture) {
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_e) {}
    }
    cb_begin_view_gesture();
}

function cb_view_move(e) {
    if (!cb_view_mode || !cb_view_pointers[e.pointerId]) return;
    if (e.preventDefault) e.preventDefault();
    cb_view_pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
    var points = cb_view_pointer_values();
    var gesture = cb_view_gesture;
    if (!gesture) return;
    if (gesture.mode === 'pan' && points.length === 1) {
        cb_view.x = gesture.baseX + points[0].x - gesture.startX;
        cb_view.y = gesture.baseY + points[0].y - gesture.startY;
    } else if (gesture.mode === 'pinch' && points.length >= 2) {
        var midX = (points[0].x + points[1].x) / 2;
        var midY = (points[0].y + points[1].y) / 2;
        var distance = Math.max(1, Math.hypot(points[1].x - points[0].x,
            points[1].y - points[0].y));
        cb_view.scale = Math.max(cb_view.minScale,
            Math.min(cb_view.maxScale, gesture.scale * distance / gesture.distance));
        cb_view.x = midX - gesture.worldX * cb_view.scale;
        cb_view.y = midY - gesture.worldY * cb_view.scale;
    } else {
        cb_begin_view_gesture();
    }
    cb_apply_view_transform();
}

function cb_view_up(e) {
    if (!cb_view_mode || !Object.prototype.hasOwnProperty.call(cb_view_pointers, e.pointerId)) return;
    if (e.preventDefault) e.preventDefault();
    delete cb_view_pointers[e.pointerId];
    cb_begin_view_gesture();
}

function cb_view_wheel(e) {
    if (!cb_view_mode) return;
    if (e.preventDefault) e.preventDefault();
    var before = cb_view.scale;
    var factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    cb_view.scale = Math.max(cb_view.minScale, Math.min(cb_view.maxScale, before * factor));
    var worldX = (e.clientX - cb_view.x) / before;
    var worldY = (e.clientY - cb_view.y) / before;
    cb_view.x = e.clientX - worldX * cb_view.scale;
    cb_view.y = e.clientY - worldY * cb_view.scale;
    cb_apply_view_transform();
}

// --- persisted state -------------------------------------------------------

function cb_state() {
    var roomId = cb_current_room_id() || 'closed';
    if (typeof tremola.collabboard == "undefined") {
        tremola.collabboard = {
            roomId: roomId, names: [],
            objects: [], clears: [], deletes: [], seen: [], mods: [], clock: 0, order: 0,
            schema: CB_STATE_VERSION
        };
    }
    if (tremola.collabboard.roomId && tremola.collabboard.roomId !== roomId) {
        tremola.collabboard = {
            roomId: roomId, names: [],
            objects: [], clears: [], deletes: [], seen: [], mods: [], clock: 0, order: 0,
            schema: CB_STATE_VERSION
        };
    }
    if (!tremola.collabboard.roomId) tremola.collabboard.roomId = roomId;
    if (!Array.isArray(tremola.collabboard.objects)) tremola.collabboard.objects = [];
    if (!Array.isArray(tremola.collabboard.clears)) tremola.collabboard.clears = [];
    if (!Array.isArray(tremola.collabboard.deletes)) tremola.collabboard.deletes = [];
    if (!Array.isArray(tremola.collabboard.seen)) tremola.collabboard.seen = [];
    if (!Array.isArray(tremola.collabboard.mods)) tremola.collabboard.mods = [];
    if (!Array.isArray(tremola.collabboard.names)) tremola.collabboard.names = [];
    if (typeof tremola.collabboard.clock !== 'number' ||
        !isFinite(tremola.collabboard.clock) || tremola.collabboard.clock < 0) {
        tremola.collabboard.clock = 0;
    }
    if (typeof tremola.collabboard.order !== 'number' ||
        !isFinite(tremola.collabboard.order) || tremola.collabboard.order < 0) {
        tremola.collabboard.order = 0;
    }
    if (tremola.collabboard.schema !== CB_STATE_VERSION) {
        tremola.collabboard.objects = tremola.collabboard.objects.filter(cb_is_shared_state_event);
        tremola.collabboard.clears = tremola.collabboard.clears.filter(cb_is_shared_state_event);
        tremola.collabboard.deletes = tremola.collabboard.deletes.filter(cb_is_shared_state_event);
        tremola.collabboard.mods = tremola.collabboard.mods.filter(cb_is_shared_state_event);
        tremola.collabboard.names = tremola.collabboard.names.filter(cb_is_shared_state_event);
        delete tremola.collabboard.profiles;
        delete tremola.collabboard.localProfile;
        delete tremola.collabboard.mode;
        tremola.collabboard.schema = CB_STATE_VERSION;
        cb_state_migrated = true;
    }
    return tremola.collabboard;
}

function cb_is_shared_state_event(event) {
    return !!event && event._board !== 'owned' && event._board !== 'profile';
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

    cb_dark_canvas = tremola.collabboardDark === true;
    cb_bind_canvas();
    cb_apply_dark_state();
    var lastUser = cb_clean_username(tremola.collabboardLastUser);
    var usernameInput = document.getElementById('cb_username');
    if (usernameInput && !usernameInput.value && lastUser) usernameInput.value = lastUser;
    var room = tremola && tremola.collabboardRoom && tremola.collabboardRoom.r ?
        tremola.collabboardRoom : null;
    if (!room) {
        cb_show_setup(true);
        cb_ble_status('Board setup', 0, 0);
        return;
    }
    if (!cb_should_quick_resume(room.r, Date.now())) {
        cb_remember_room(room, false);
        if (cb_is_android()) backend('collabboard:close');
        delete tremola.collabboardRoom;
        delete tremola.collabboard;
        cb_stop_board_replay();
        persist();
        cb_show_setup(true);
        cb_ble_status('Board setup', 0, 0);
        return;
    }
    cb_resume_room_id = '';
    cb_resume_until = 0;
    cb_pending_open_kind = 'resume';
    cb_force_publish_name = false;
    cb_show_setup(false);
    room.b = cb_board_name(room);
    cb_remember_room(room, false);
    cb_state();
    if (cb_state_migrated) {
        cb_state_migrated = false;
        persist();
    }
    cb_set_tool('select');
    cb_update_room_bar();
    cb_schedule_fit();
    if (typeof Android === 'undefined') {
        cb_ble_status('Browser preview', 0, 0);
    } else if (typeof bleState !== 'undefined' && bleState) {
        cb_ble_status(bleState.status, bleState.peers, bleState.queued);
    } else {
        cb_ble_status('BLE starting', 0, 0);
    }
    cb_redraw();
    if (cb_is_android()) {
        cb_native_config_pending = true;
        backend('collabboard:configure ' + cb_utf8_b64(JSON.stringify(room)));
    } else if (!cb_history_requested && typeof readLogEntries === "function") {
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
    if (/code ready/.test(lower)) return 'Code ready';
    if (/looking for board|checking invite/.test(lower)) return 'Joining';
    if (queued > 0) return 'Syncing';
    if (peers > 0) return peers === 1 ? '1 nearby' : peers + ' nearby';
    if (/starting|active|ready|connected|advertising|service/.test(lower)) return 'Looking nearby';
    return 'Starting';
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
    var edit = document.getElementById('cb_tool_select');
    if (pen) {
        pen.classList.toggle('cb_active', tool === 'pen');
        pen.setAttribute('aria-pressed', tool === 'pen' ? 'true' : 'false');
    }
    if (text) {
        text.classList.toggle('cb_active', tool === 'text');
        text.setAttribute('aria-pressed', tool === 'text' ? 'true' : 'false');
    }
    if (edit) {
        edit.classList.toggle('cb_active', tool === 'select');
        edit.setAttribute('aria-pressed', tool === 'select' ? 'true' : 'false');
    }
    var cv = document.getElementById('cb_canvas');
    if (cv) cv.style.cursor = (tool === 'select') ? 'grab' : 'crosshair';
    var inp = document.getElementById('cb_text');
    if (inp) {
        inp.style.display = (tool === 'text') ? null : 'none';
        if (tool === 'text') inp.focus();
    }
    cb_update_selection_controls();
    cb_schedule_fit();
}

function cb_color() {
    var el = document.getElementById('cb_color');
    return el ? el.value : '#000000';
}

function cb_clear() {
    var ts = cb_next_ts();
    cb_sel = null;
    cb_update_selection_controls();
    cb_write_board_event({ k: 'c', id: cb_id(ts), ts: ts }, true);
}

function cb_delete_selected() {
    if (!cb_sel || cb_tool !== 'select') return;
    var target = cb_sel;
    var ts = cb_next_ts();
    cb_sel = null;
    cb_update_selection_controls();
    cb_write_board_event({ k: 'd', id: cb_id(ts), ts: ts, t: target }, true);
}

function cb_update_selection_controls() {
    var button = document.getElementById('cb_delete_btn');
    if (button) button.disabled = !cb_sel || cb_tool !== 'select';
    var info = document.getElementById('cb_selection_info');
    if (!info) return;
    var selected = null;
    if (cb_sel && cb_tool === 'select') {
        cb_visible_objects(cb_state()).forEach(function (object) {
            if (object.id === cb_sel) selected = object;
        });
    }
    if (!selected) {
        info.hidden = true;
        info.textContent = '';
        info.title = '';
        return;
    }
    var name = cb_members[selected._fid] || selected._name || cb_short_author(selected._fid);
    info.textContent = 'By ' + name;
    info.title = selected._fid || '';
    info.hidden = false;
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
    cv.addEventListener('lostpointercapture', cb_lost_capture);
    var frame = document.getElementById('cb_canvas_frame');
    if (frame && !cb_view_bound) {
        cb_view_bound = true;
        frame.addEventListener('pointerdown', cb_view_down);
        frame.addEventListener('pointermove', cb_view_move);
        frame.addEventListener('pointerup', cb_view_up);
        frame.addEventListener('pointercancel', cb_view_up);
        frame.addEventListener('lostpointercapture', cb_view_up);
        frame.addEventListener('wheel', cb_view_wheel, { passive: false });
    }
    var col = document.getElementById('cb_color');
    if (col) {
        // picking a color while an object is selected recolors that object
        col.addEventListener('change', function () {
            if (!cb_sel || cb_tool !== 'select') return;
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

function cb_schedule_fit() {
    cb_fit_canvas();
    if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(function () {
            requestAnimationFrame(cb_fit_canvas);
        });
    }
    setTimeout(cb_fit_canvas, 80);
    setTimeout(cb_fit_canvas, 260);
}

function cb_reset_edit_view() {
    cb_edit_view.scale = 0;
    cb_edit_view.x = 0;
    cb_edit_view.y = 0;
    cb_edit_view.fit = 0;
    cb_edit_view.width = 0;
    cb_edit_view.height = 0;
    cb_edit_view.initialized = false;
    cb_edit_pointers = Object.create(null);
    cb_edit_gesture = null;
    cb_edit_navigation = false;
    cb_pending_text_point = null;
}

function cb_fit_canvas() {
    var cv = document.getElementById('cb_canvas');
    var main = document.getElementById('div:collabboard-main');
    if (!cv || !main) return;
    var changed = cv.width !== CB_BOARD_WIDTH || cv.height !== CB_BOARD_HEIGHT;
    if (changed) {
        cv.width = CB_BOARD_WIDTH;
        cv.height = CB_BOARD_HEIGHT;
    }
    if (cb_view_mode) {
        cb_apply_view_transform();
        if (changed) cb_redraw();
        return;
    }
    var measuredWidth = Number(main.clientWidth) || 0;
    if (measuredWidth < 120 && main.getBoundingClientRect) {
        measuredWidth = Number(main.getBoundingClientRect().width) || measuredWidth;
    }
    if (measuredWidth < 120 && typeof window !== 'undefined') {
        measuredWidth = Number(window.innerWidth) || measuredWidth;
    }
    var maxWidth = Math.min(CB_INITIAL_VIEW_WIDTH, measuredWidth - 10);
    if (maxWidth <= 0) return;
    // Android changes the available height when its keyboard opens. Width is
    // stable, so text entry no longer collapses the board to a tiny preview.
    var scale = Math.max(0.05, maxWidth / CB_INITIAL_VIEW_WIDTH);
    var canvasWidth = Math.max(1, Math.floor(CB_BOARD_WIDTH * scale));
    var canvasHeight = Math.max(1, Math.floor(CB_BOARD_HEIGHT * scale));
    var frameHeight = Math.max(1, Math.floor(CB_INITIAL_VIEW_HEIGHT * scale));
    var frame = document.getElementById('cb_canvas_frame');
    if (!frame) {
        cv.style.transform = 'none';
        cv.style.width = canvasWidth + 'px';
        cv.style.height = canvasHeight + 'px';
        cb_clamp_camera(cv);
        if (changed) cb_redraw();
        return;
    }
    if (frame.classList) frame.classList.add('cb_edit_navigation');
    frame.style.height = frameHeight + 'px';
    frame.style.flexBasis = frameHeight + 'px';
    if (!cb_edit_view.initialized || Math.abs(cb_edit_view.width - maxWidth) > 2) {
        cb_edit_view.scale = scale;
        cb_edit_view.fit = scale;
        cb_edit_view.minScale = Math.max(0.03, scale * 0.65);
        cb_edit_view.maxScale = Math.max(scale * 5, 2);
        cb_edit_view.width = maxWidth;
        cb_edit_view.height = frameHeight;
        cb_edit_view.x = 0;
        cb_edit_view.y = 0;
        cb_edit_view.initialized = true;
    } else {
        cb_edit_view.height = frameHeight;
    }
    cb_apply_edit_transform();
    cb_clamp_camera(cv);
    if (changed) cb_redraw();
}

function cb_apply_edit_transform() {
    if (cb_view_mode || !cb_edit_view.initialized) return;
    var cv = document.getElementById('cb_canvas');
    if (!cv) return;
    cb_clamp_edit_view();
    cv.style.width = CB_BOARD_WIDTH + 'px';
    cv.style.height = CB_BOARD_HEIGHT + 'px';
    cv.style.transform = 'translate3d(' + Math.round(cb_edit_view.x) + 'px,' +
        Math.round(cb_edit_view.y) + 'px,0) scale(' + cb_edit_view.scale + ')';
}

function cb_clamp_edit_view() {
    var width = cb_edit_view.width || 1;
    var height = cb_edit_view.height || 1;
    cb_edit_view.scale = Math.max(cb_edit_view.minScale,
        Math.min(cb_edit_view.maxScale, cb_edit_view.scale));
    cb_edit_view.x = cb_clamp_view_axis(
        cb_edit_view.x, width, CB_BOARD_WIDTH * cb_edit_view.scale
    );
    cb_edit_view.y = cb_clamp_view_axis(
        cb_edit_view.y, height, CB_BOARD_HEIGHT * cb_edit_view.scale
    );
}

// position in canvas pixels (before the camera is applied)
function cb_screen_pos(cv, e) {
    var r = cv.getBoundingClientRect();
    var sx = cv.width / Math.max(1, r.width);
    var sy = cv.height / Math.max(1, r.height);
    return [Math.round((e.clientX - r.left) * sx), Math.round((e.clientY - r.top) * sy)];
}

// position in the shared finite board coordinates
function cb_pos(cv, e) {
    var p = cb_screen_pos(cv, e);
    return [
        Math.max(0, Math.min(CB_BOARD_WIDTH, p[0])),
        Math.max(0, Math.min(CB_BOARD_HEIGHT, p[1]))
    ];
}

function cb_edit_pointer_values() {
    return Object.keys(cb_edit_pointers).sort().map(function (id) {
        return cb_edit_pointers[id];
    });
}

function cb_edit_frame_point(point) {
    var frame = document.getElementById('cb_canvas_frame');
    var rect = frame && frame.getBoundingClientRect ? frame.getBoundingClientRect() : { left: 0, top: 0 };
    return { x: point.x - (rect.left || 0), y: point.y - (rect.top || 0) };
}

function cb_begin_edit_navigation() {
    var points = cb_edit_pointer_values();
    if (points.length < 2) return;
    if (!cb_edit_view.initialized) cb_fit_canvas();
    cb_edit_navigation = true;
    cb_pointer_id = null;
    cb_pending_text_point = null;
    cb_draft = null;
    cb_drag = null;
    var first = cb_edit_frame_point(points[0]);
    var second = cb_edit_frame_point(points[1]);
    var midX = (first.x + second.x) / 2;
    var midY = (first.y + second.y) / 2;
    var distance = Math.max(1, Math.hypot(second.x - first.x, second.y - first.y));
    cb_edit_gesture = {
        distance: distance,
        scale: cb_edit_view.scale,
        worldX: (midX - cb_edit_view.x) / cb_edit_view.scale,
        worldY: (midY - cb_edit_view.y) / cb_edit_view.scale,
        count: points.length
    };
    cb_redraw();
}

function cb_update_edit_navigation() {
    var points = cb_edit_pointer_values();
    if (!cb_edit_navigation || points.length < 2) return;
    if (!cb_edit_gesture || cb_edit_gesture.count !== points.length) {
        cb_begin_edit_navigation();
        return;
    }
    var first = cb_edit_frame_point(points[0]);
    var second = cb_edit_frame_point(points[1]);
    var midX = (first.x + second.x) / 2;
    var midY = (first.y + second.y) / 2;
    var distance = Math.max(1, Math.hypot(second.x - first.x, second.y - first.y));
    cb_edit_view.scale = Math.max(cb_edit_view.minScale, Math.min(
        cb_edit_view.maxScale,
        cb_edit_gesture.scale * distance / cb_edit_gesture.distance
    ));
    cb_edit_view.x = midX - cb_edit_gesture.worldX * cb_edit_view.scale;
    cb_edit_view.y = midY - cb_edit_gesture.worldY * cb_edit_view.scale;
    cb_apply_edit_transform();
}

function cb_finish_edit_pointer(e) {
    if (e && Object.prototype.hasOwnProperty.call(cb_edit_pointers, e.pointerId)) {
        delete cb_edit_pointers[e.pointerId];
    }
    cb_release_pointer(e);
    var count = cb_edit_pointer_values().length;
    if (count === 0) {
        cb_edit_navigation = false;
        cb_edit_gesture = null;
    } else if (count >= 2) {
        cb_begin_edit_navigation();
    }
}

function cb_down(e) {
    if (cb_view_mode || cb_replay_active) return;
    cb_edit_pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
    if (cb_edit_pointer_values().length >= 2) {
        if (e.preventDefault) e.preventDefault();
        if (e.currentTarget && e.currentTarget.setPointerCapture) {
            try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_e) {}
        }
        cb_begin_edit_navigation();
        return;
    }
    if (cb_edit_navigation) return;
    if (e.isPrimary === false) {
        delete cb_edit_pointers[e.pointerId];
        return;
    }
    if (cb_pointer_id !== null) return;
    cb_pointer_id = e.pointerId;
    if (e.preventDefault) e.preventDefault();
    var cv = e.currentTarget;
    var p = cb_pos(cv, e);
    if (cb_tool === 'text') {
        cb_pending_text_point = p;
        if (cv.setPointerCapture) cv.setPointerCapture(e.pointerId);
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
            cb_sync_color_picker(st, hit);
            var xf = cb_xf(st, hit);
            cb_drag = { mode: 'move', target: hit.id, start: p, base: xf,
                        xf: { dx: xf.dx, dy: xf.dy, sc: xf.sc } };
        } else {
            cb_sel = null;
            cb_drag = null;
            cb_pointer_id = null;
        }
        cb_update_selection_controls();
        if (cb_drag && cv.setPointerCapture) cv.setPointerCapture(e.pointerId);
        cb_redraw();
        setTimeout(cb_fit_canvas, 0);
        return;
    }
    cb_draft = { k: 's', c: cb_color(), w: 2, p: [p] };
    if (cv.setPointerCapture) cv.setPointerCapture(e.pointerId);
}

function cb_move(e) {
    if (Object.prototype.hasOwnProperty.call(cb_edit_pointers, e.pointerId)) {
        cb_edit_pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
    }
    if (cb_edit_navigation) {
        if (e.preventDefault) e.preventDefault();
        cb_update_edit_navigation();
        return;
    }
    if (e.isPrimary === false || cb_pointer_id === null || e.pointerId !== cb_pointer_id) return;
    if (e.preventDefault) e.preventDefault();
    var cv = e.currentTarget;
    if (cb_drag && cb_drag.mode === 'move') {
        var q = cb_pos(cv, e);
        var mdx = q[0] - cb_drag.start[0];
        var mdy = q[1] - cb_drag.start[1];
        cb_drag.xf.dx = cb_drag.base.dx + mdx;
        cb_drag.xf.dy = cb_drag.base.dy + mdy;
        cb_clamp_drag_transform();
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
            cb_clamp_drag_transform();
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
    cb_draw_stroke(ctx, { c: cb_draft.c, w: cb_draft.w, p: cb_draft.p.slice(-2) });
    ctx.restore();
}

function cb_up(e) {
    if (cb_edit_navigation) {
        if (e && e.preventDefault) e.preventDefault();
        cb_finish_edit_pointer(e);
        return;
    }
    if (e && (e.isPrimary === false || cb_pointer_id === null || e.pointerId !== cb_pointer_id)) {
        cb_finish_edit_pointer(e);
        return;
    }
    if (e && e.preventDefault) e.preventDefault();
    cb_release_pointer(e);
    if (e) delete cb_edit_pointers[e.pointerId];
    cb_pointer_id = null;
    if (cb_pending_text_point) {
        var textPoint = cb_pending_text_point;
        cb_pending_text_point = null;
        if (cb_tool === 'text') cb_place_text(textPoint);
        return;
    }
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
    cb_write_board_event(d, true);
}

function cb_leave(e) {
    var cv = e.currentTarget;
    if (cv && cv.hasPointerCapture && cv.hasPointerCapture(e.pointerId)) return;
    cb_up(e);
}

function cb_cancel(e) {
    if (cb_edit_navigation) {
        if (e && e.preventDefault) e.preventDefault();
        cb_finish_edit_pointer(e);
        return;
    }
    if (e && (cb_pointer_id === null || e.pointerId !== cb_pointer_id)) {
        cb_finish_edit_pointer(e);
        return;
    }
    var hasStroke = cb_draft && Array.isArray(cb_draft.p) && cb_draft.p.length > 0;
    var hasTransform = cb_drag && cb_drag.mode !== 'pan' && cb_drag.moved;
    if (cb_pointer_id !== null && (hasStroke || hasTransform)) {
        // Android WebView can cancel capture during a completed-looking touch.
        // Keep the visible work by finishing the event instead of discarding it.
        cb_up(e);
        return;
    }
    if (e && e.preventDefault) e.preventDefault();
    cb_release_pointer(e);
    if (e) delete cb_edit_pointers[e.pointerId];
    cb_pointer_id = null;
    cb_pending_text_point = null;
    cb_drag = null;
    cb_draft = null;
    var cv = e && e.currentTarget;
    if (cv && cb_tool === 'select') cv.style.cursor = 'grab';
    cb_redraw();
}

function cb_lost_capture(e) {
    if (e && Object.prototype.hasOwnProperty.call(cb_edit_pointers, e.pointerId)) {
        cb_up(e);
        return;
    }
    if (cb_pointer_id !== null && e && e.pointerId === cb_pointer_id) cb_up(e);
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
    var event = {
        k: 't', id: cb_id(ts), ts: ts, c: cb_color(), x: p[0], y: p[1], s: cb_enc(s)
    };
    cb_write_board_event(event, true);
    inp.value = '';
    if (inp.blur) inp.blur();
    cb_sel = event.id;
    cb_set_tool('select');
    cb_redraw();
}

function cb_text_keydown(e) {
    if (!e || (e.key !== 'Enter' && e.keyCode !== 13)) return;
    if (e.preventDefault) e.preventDefault();
    var inp = document.getElementById('cb_text');
    if (inp && inp.blur) inp.blur();
    var cv = document.getElementById('cb_canvas');
    if (cv && cv.focus) {
        try { cv.focus({ preventScroll: true }); } catch (_e) { cv.focus(); }
    }
    cb_schedule_fit();
}

// --- apply incoming events -------------------------------------------------

function cb_write_board_event(event, applyLocal) {
    var roomId = cb_current_room_id();
    if (!roomId || cb_native_config_pending) return;
    var room = cb_current_room();
    event.r = roomId;
    if (room && room.u) event.u = cb_clean_username(room.u);
    if (typeof event.l !== 'number' || !isFinite(event.l) || event.l <= 0) {
        event.l = cb_next_order();
    }
    if (cb_is_android()) {
        var encoded = cb_utf8_b64(JSON.stringify(event));
        if (typeof Android.writeCollaborationBoardEvent === 'function') {
            if (!Android.writeCollaborationBoardEvent(encoded)) {
                cb_board_write_failed();
                return;
            }
        } else {
            backend('collabboard:write ' + encoded);
        }
    } else {
        writeLogEntry(JSON.stringify(event));
    }
    if (applyLocal) cb_apply(event, cb_local_header(event.ts));
}

function cb_local_header(ts) {
    var room = cb_current_room();
    return {
        fid: typeof myId === 'string' ? myId : '@local.ed25519',
        tst: typeof ts === 'number' ? ts : Date.now(),
        username: room ? room.u : ''
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
        if (key !== '_fid' && key !== '_board' && key !== '_name') event[key] = obj[key];
    });
    var roomId = cb_current_room_id();
    if (!event.r && roomId) event.r = roomId;
    if (roomId && event.r !== roomId) return null;
    var fid = header && typeof header.fid === 'string' ? header.fid : null;
    if (event.k === 'o' || event.k === 'p') return null;
    event._board = 'open';
    if (fid) event._fid = fid;
    var trustedName = header && typeof header.username === 'string' ?
        cb_clean_username(header.username) : '';
    var payloadName = cb_clean_username(event.u);
    var name = trustedName || payloadName || (fid && cb_members[fid]) || '';
    if (name) event._name = name;
    return event;
}

function cb_apply(raw, header) {
    var obj = cb_normalize_event(raw, header);
    if (!cb_is_valid_event(obj)) return;
    var st = cb_state();
    st.clock = Math.max(st.clock, cb_event_ts(obj));
    st.order = Math.max(st.order, cb_event_order(obj));
    if (st.seen.indexOf(obj.id) >= 0) return; // already applied (incl. self-echo)
    st.seen.push(obj.id);

    if (obj.k === 'c') {
        st.clears.push(obj);
    } else if (obj.k === 'n') {
        st.names.push(obj);
    } else if (obj.k === 'm' || obj.k === 'k') {
        st.mods.push(obj);
    } else if (obj.k === 'd') {
        st.deletes.push(obj);
    } else {
        if (!st.objects.some(function (o) { return o.id === obj.id; })) {
            st.objects.push(obj);
        }
    }
    cb_prune_state(st);
    if (cb_replay_active) {
        if (cb_replay_native_done) {
            cb_schedule_replay_finish(cb_replay_remote ?
                CB_REPLAY_REMOTE_QUIET_MS : CB_REPLAY_LOCAL_QUIET_MS);
        }
        return;
    }
    cb_apply_synced_board_name(st);
    cb_remember_room(tremola.collabboardRoom, true);
    persist();
    cb_redraw();
    setTimeout(cb_fit_canvas, 0);
}

// --- rendering -------------------------------------------------------------

function cb_redraw() {
    var cv = document.getElementById('cb_canvas');
    if (!cv) return;
    var ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.fillStyle = cb_dark_canvas ? '#0f1115' : '#ffffff';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.save();
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
    cb_update_selection_controls();
    ctx.restore();
}

function cb_visible_objects(st) {
    var clear = cb_latest_clear(st);
    var latestDeletes = Object.create(null);
    (st.deletes || []).forEach(function (deletion) {
        if (!latestDeletes[deletion.t] ||
            cb_compare_events(deletion, latestDeletes[deletion.t]) > 0) {
            latestDeletes[deletion.t] = deletion;
        }
    });
    return st.objects
        .filter(function (o) {
            if (clear && cb_compare_events(o, clear) <= 0) return false;
            var deletion = latestDeletes[o.id];
            return !deletion || cb_compare_events(o, deletion) > 0;
        })
        .sort(cb_compare_events);
}

function cb_draw_selection(ctx, st, o) {
    var b = cb_bbox(ctx, st, o);
    ctx.save();
    ctx.strokeStyle = cb_dark_canvas ? '#ffffff' : '#2563eb';
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(b.x - CB_SEL_PAD, b.y - CB_SEL_PAD,
                   b.w + 2 * CB_SEL_PAD, b.h + 2 * CB_SEL_PAD);
    ctx.setLineDash([]);
    var h = cb_handle_rect(b);
    ctx.fillStyle = cb_dark_canvas ? '#ffffff' : '#2563eb';
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
    var strokeColor = cb_display_color(col || o.c || '#000000');
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = (o.w || 2) * xf.sc;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    var p0 = cb_apply_xf(o.p[0], org, xf);
    if (o.p.length === 1) {
        ctx.fillStyle = strokeColor;
        ctx.arc(p0[0], p0[1], Math.max(1, ctx.lineWidth / 2), 0, Math.PI * 2);
        ctx.fill();
        return;
    }
    ctx.moveTo(p0[0], p0[1]);
    for (var i = 1; i < o.p.length; i++) {
        var p = cb_apply_xf(o.p[i], org, xf);
        ctx.lineTo(p[0], p[1]);
    }
    ctx.stroke();
}

function cb_draw_text(ctx, o, xf, col) {
    xf = xf || { dx: 0, dy: 0, sc: 1 };
    ctx.fillStyle = cb_display_color(col || o.c || '#000000');
    ctx.font = Math.round(CB_TEXT_SIZE * xf.sc) + 'px sans-serif';
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

// transformed bounding box in shared board coordinates
function cb_bbox(ctx, st, o) {
    return cb_bbox_for_xf(ctx, o, cb_xf(st, o));
}

function cb_bbox_for_xf(ctx, o, xf) {
    if (o.k === 't') {
        ctx.save();
        ctx.font = Math.round(CB_TEXT_SIZE * xf.sc) + 'px sans-serif';
        var w = ctx.measureText(cb_dec(o.s).slice(0, 160)).width;
        ctx.restore();
        return {
            x: o.x + xf.dx,
            y: o.y + xf.dy - (CB_TEXT_LINE_HEIGHT / 2) * xf.sc,
            w: w,
            h: CB_TEXT_LINE_HEIGHT * xf.sc
        };
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

function cb_clamp_drag_transform() {
    if (!cb_drag || !cb_drag.target || !cb_drag.xf) return;
    var cv = document.getElementById('cb_canvas');
    if (!cv) return;
    var st = cb_state();
    var object = null;
    cb_visible_objects(st).forEach(function (candidate) {
        if (candidate.id === cb_drag.target) object = candidate;
    });
    if (!object) return;
    var ctx = cv.getContext('2d');
    if (cb_drag.mode === 'resize') {
        var unit = cb_bbox_for_xf(ctx, object, { dx: 0, dy: 0, sc: 1 });
        var maxScale = Math.min(
            unit.w > 0 ? CB_BOARD_WIDTH / unit.w : 20,
            unit.h > 0 ? CB_BOARD_HEIGHT / unit.h : 20,
            20
        );
        cb_drag.xf.sc = Math.max(0.05, Math.min(cb_drag.xf.sc, maxScale));
    }
    var box = cb_bbox_for_xf(ctx, object, cb_drag.xf);
    if (box.x < 0) cb_drag.xf.dx -= box.x;
    if (box.y < 0) cb_drag.xf.dy -= box.y;
    box = cb_bbox_for_xf(ctx, object, cb_drag.xf);
    if (box.x + box.w > CB_BOARD_WIDTH) cb_drag.xf.dx += CB_BOARD_WIDTH - box.x - box.w;
    if (box.y + box.h > CB_BOARD_HEIGHT) cb_drag.xf.dy += CB_BOARD_HEIGHT - box.y - box.h;
}

// the selected object, if the world point p is on its resize handle
function cb_hit_handle(st, p) {
    if (!cb_sel) return null;
    var cv = document.getElementById('cb_canvas');
    var ctx = cv.getContext('2d');
    var obj = null;
    cb_visible_objects(st).forEach(function (o) { if (o.id === cb_sel) obj = o; });
    if (!obj) return null;
    var b = cb_bbox(ctx, st, obj);
    var h = cb_handle_rect(b);
    var cx = h.x + h.w / 2;
    var cy = h.y + h.h / 2;
    var half = Math.max(h.w, CB_HANDLE_HIT) / 2;
    // Keep the generous phone touch target outside the object's own box. For
    // a tiny dot or short stroke, an unrestricted 32 px target would cover the
    // whole object and make moving it impossible after it was selected.
    var left = Math.max(cx - half, b.x + b.w);
    var top = Math.max(cy - half, b.y + b.h);
    if (p[0] >= left && p[0] <= cx + half &&
        p[1] >= top && p[1] <= cy + half) return obj;
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

// Wall clocks can differ between phones. New local events therefore advance
// past every event already observed on this board before using Date.now().
function cb_next_ts() {
    var st = cb_state();
    var next = Math.max(Date.now(), st.clock || 0);
    st.objects.forEach(function (event) { next = Math.max(next, cb_event_ts(event)); });
    st.clears.forEach(function (event) { next = Math.max(next, cb_event_ts(event)); });
    st.deletes.forEach(function (event) { next = Math.max(next, cb_event_ts(event)); });
    st.mods.forEach(function (event) { next = Math.max(next, cb_event_ts(event)); });
    st.clock = next + 1;
    return st.clock;
}

// Lamport ordering is independent of the wall clocks on different phones.
// Legacy events did not have `l`, so their timestamp is used during migration.
function cb_next_order() {
    var st = cb_state();
    var next = st.order || 0;
    st.objects.forEach(function (event) { next = Math.max(next, cb_event_order(event)); });
    st.clears.forEach(function (event) { next = Math.max(next, cb_event_order(event)); });
    st.deletes.forEach(function (event) { next = Math.max(next, cb_event_order(event)); });
    st.mods.forEach(function (event) { next = Math.max(next, cb_event_order(event)); });
    st.order = next + 1;
    return st.order;
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
    cb_cam.x = 0;
    cb_cam.y = 0;
}

function cb_sync_color_picker(st, o) {
    var color = cb_eff_color(st, o);
    var picker = document.getElementById('cb_color');
    if (picker && cb_is_picker_color(color)) picker.value = color;
}

function cb_is_picker_color(c) {
    return typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c);
}

function cb_display_color(color) {
    if (!cb_dark_canvas || !cb_is_picker_color(color)) return color;
    var red = parseInt(color.slice(1, 3), 16);
    var green = parseInt(color.slice(3, 5), 16);
    var blue = parseInt(color.slice(5, 7), 16);
    var luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    return luminance < 105 ? '#ffffff' : color;
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
    if (typeof obj._board !== 'undefined' && obj._board !== 'open') return false;
    if (typeof obj.l !== 'undefined' &&
        (typeof obj.l !== 'number' || !isFinite(obj.l) || obj.l <= 0)) return false;
    if (typeof obj.u !== 'undefined' &&
        (typeof obj.u !== 'string' || !cb_clean_username(obj.u) || obj.u.length > 24)) return false;
    if (obj.k === 'c') return true;
    if (obj.k === 'n') {
        return typeof obj.b === 'string' && obj.b.length <= 40 &&
            !!cb_clean_board_name(obj.b);
    }
    if (obj.k === 't') {
        return cb_is_board_coord(obj.x, CB_BOARD_WIDTH) &&
            cb_is_board_coord(obj.y, CB_BOARD_HEIGHT) &&
            typeof obj.s === 'string' && obj.s.length <= 1024 &&
            cb_is_valid_color(obj.c);
    }
    if (obj.k === 'k') {
        return typeof obj.t === 'string' && obj.t.length > 0 && obj.t.length <= 96 &&
            typeof obj.c === 'string' && cb_is_valid_color(obj.c);
    }
    if (obj.k === 'd') {
        return typeof obj.t === 'string' && obj.t.length > 0 && obj.t.length <= 96;
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
    st.clears = st.clears.slice().sort(cb_compare_events).slice(-CB_MAX_CLEARS);
    st.names = (st.names || []).slice().sort(cb_compare_events).slice(-CB_MAX_NAMES);

    var latestDeletes = Object.create(null);
    st.deletes.forEach(function (deletion) {
        if (clear && cb_compare_events(deletion, clear) <= 0) return;
        if (!latestDeletes[deletion.t] ||
            cb_compare_events(deletion, latestDeletes[deletion.t]) > 0) {
            latestDeletes[deletion.t] = deletion;
        }
    });
    st.deletes = Object.keys(latestDeletes).map(function (target) {
        return latestDeletes[target];
    });
    if (st.deletes.length > CB_MAX_DELETES) {
        st.deletes = st.deletes.slice().sort(cb_compare_events).slice(-CB_MAX_DELETES);
    }

    st.objects = st.objects.filter(function (object) {
        if (clear && cb_compare_events(object, clear) <= 0) return false;
        var deletion = latestDeletes[object.id];
        return !deletion || cb_compare_events(object, deletion) > 0;
    });
    if (st.objects.length > CB_MAX_OBJECTS) {
        st.objects = st.objects.slice().sort(cb_compare_events).slice(-CB_MAX_OBJECTS);
    }
    var latest = Object.create(null);
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
        cb_is_board_coord(p[0], CB_BOARD_WIDTH) &&
        cb_is_board_coord(p[1], CB_BOARD_HEIGHT);
}

function cb_is_finite_coord(n) {
    return typeof n === 'number' && isFinite(n) && Math.abs(n) <= CB_COORD_LIMIT;
}

function cb_is_board_coord(n, maximum) {
    return typeof n === 'number' && isFinite(n) && n >= 0 && n <= maximum;
}

function cb_is_valid_color(c) {
    return typeof c === 'undefined' || cb_is_picker_color(c);
}

function cb_latest_clear(st) {
    var best = null;
    (st.clears || []).forEach(function (clear) {
        if (!best || cb_compare_events(clear, best) > 0) best = clear;
    });
    return best;
}

function cb_compare_events(a, b) {
    var ats = cb_event_order(a);
    var bts = cb_event_order(b);
    if (ats !== bts) return ats - bts;
    var aid = a && a.id ? a.id : '';
    var bid = b && b.id ? b.id : '';
    if (aid < bid) return -1;
    if (aid > bid) return 1;
    return 0;
}

function cb_event_order(obj) {
    if (obj && typeof obj.l === 'number' && isFinite(obj.l) && obj.l > 0) return obj.l;
    return cb_event_ts(obj);
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

function cb_short_author(feedId) {
    if (typeof feedId !== 'string' || feedId.length < 10) return 'Unknown';
    return feedId.slice(1, 9);
}
