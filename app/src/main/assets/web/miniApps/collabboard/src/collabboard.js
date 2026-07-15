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
var CB_STATE_VERSION = 4;
var CB_BOARD_WIDTH = 900;
var CB_BOARD_HEIGHT = 1200;
var CB_COORD_LIMIT = 2400;
var CB_MAX_MEMBERS = 4;
var CB_TEXT_SIZE = 36;
var CB_TEXT_LINE_HEIGHT = 42;
var cb_native_config_pending = false;
var cb_pending_pairing_code = '';
var cb_pending_copy_code = '';
var cb_setup_mode = 'create';

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

function cb_clean_board_name(value) {
    return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 40);
}

function cb_board_name(room) {
    return cb_clean_board_name(room && room.b) || 'Board';
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
    room.b = cb_board_name(room);
    var catalog = cb_board_catalog();
    var old = catalog[room.r];
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
        row.appendChild(name);
        row.appendChild(open);
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
    if (show) cb_render_board_list();
}

function cb_create_board() {
    var usernameInput = document.getElementById('cb_username');
    var nameInput = document.getElementById('cb_board_name');
    var codeInput = document.getElementById('cb_create_code');
    var username = cb_clean_username(usernameInput && usernameInput.value);
    var boardName = cb_clean_board_name(nameInput && nameInput.value);
    var code = cb_clean_pairing_code(codeInput && codeInput.value);
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
    if (!cb_valid_pairing_code(code)) {
        cb_set_setup_error('Enter a 6-digit code');
        if (codeInput) codeInput.focus();
        return;
    }
    cb_pending_pairing_code = code;
    tremola.collabboardLastUser = username;
    cb_activate_room({
        v: 1,
        r: cb_random_token(12),
        k: cb_random_token(32),
        o: typeof myId === 'string' ? myId : '@local.ed25519',
        u: username,
        b: boardName,
        p: code
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
    tremola.collabboardLastUser = username;
    persist();
    cb_native_config_pending = true;
    cb_set_setup_error('Looking for board owner...');
    backend('collabboard:join ' + cb_utf8_b64(JSON.stringify({ u: username, c: code })));
}

function cb_open_saved_board(roomId) {
    var entry = cb_board_catalog()[roomId];
    if (!entry || !entry.room) {
        cb_set_setup_error('Board is not available');
        return;
    }
    cb_activate_room(entry.room, !cb_is_android() ? entry.state : null);
}

function cb_activate_room(room, savedState) {
    room.b = cb_board_name(room);
    tremola.collabboardRoom = room;
    tremola.collabboard = savedState && savedState.roomId === room.r ? savedState : {
            roomId: room.r,
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
        cb_show_setup(true);
        cb_set_setup_error('Could not open this board');
        return;
    }
    cb_set_setup_error('');
    cb_show_setup(false);
    if (cb_is_android()) {
        backend('collabboard:read');
        if (cb_pending_pairing_code) {
            var code = cb_pending_pairing_code;
            cb_pending_pairing_code = '';
            backend('collabboard:pairing ' + cb_utf8_b64(code));
        }
    } else {
        cb_ble_status('Browser preview', 0, 0);
    }
}

function cb_board_join_started(accepted) {
    if (accepted) return;
    cb_native_config_pending = false;
    cb_set_setup_error('Could not start joining');
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
        config.b = cb_board_name(config);
        cb_native_config_pending = cb_is_android();
        tremola.collabboardRoom = config;
        tremola.collabboard = {
            roomId: config.r,
            objects: [], clears: [], deletes: [], seen: [], mods: [], clock: 0, order: 0,
            schema: CB_STATE_VERSION
        };
        cb_remember_room(config, true);
        persist();
        cb_set_setup_error('');
        cb_show_setup(false);
        cb_update_room_bar();
        cb_fit_canvas();
        cb_redraw();
        if (cb_is_android()) backend('collabboard:read');
    } catch (e) {
        cb_board_join_failed('Could not open this board');
    }
}

function cb_board_join_failed(message) {
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
    var room = tremola.collabboardRoom;
    if (room) cb_remember_room(room, true);
    if (cb_is_android()) backend('collabboard:close');
    delete tremola.collabboardRoom;
    delete tremola.collabboard;
    cb_members = Object.create(null);
    cb_pending_pairing_code = '';
    cb_pending_copy_code = '';
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
    if (label) label.textContent = room ? cb_board_name(room) : '';
    if (invite) {
        invite.style.display = room && typeof myId === 'string' && room.o === myId ? null : 'none';
    }
}

function cb_room_status(count, maximum, members) {
    var label = document.getElementById('cb_member_count');
    if (label) label.textContent = Math.min(Number(count) || 1, maximum || CB_MAX_MEMBERS) + '/' +
        (maximum || CB_MAX_MEMBERS);
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
    cb_apply(payload, { fid: feedId, tst: Date.now(), username: username });
}

// --- persisted state -------------------------------------------------------

function cb_state() {
    var roomId = cb_current_room_id() || 'closed';
    if (typeof tremola.collabboard == "undefined") {
        tremola.collabboard = {
            roomId: roomId,
            objects: [], clears: [], deletes: [], seen: [], mods: [], clock: 0, order: 0,
            schema: CB_STATE_VERSION
        };
    }
    if (tremola.collabboard.roomId && tremola.collabboard.roomId !== roomId) {
        tremola.collabboard = {
            roomId: roomId,
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

    cb_bind_canvas();
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
    cb_fit_canvas();
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
    setTimeout(cb_fit_canvas, 0);
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
    var name = selected._name || cb_members[selected._fid] || cb_short_author(selected._fid);
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

function cb_fit_canvas() {
    var cv = document.getElementById('cb_canvas');
    var main = document.getElementById('div:collabboard-main');
    if (!cv || !main) return;
    var maxWidth = main.clientWidth - 10;
    if (maxWidth <= 0) return;
    // Android changes the available height when its keyboard opens. Width is
    // stable, so text entry no longer collapses the board to a tiny preview.
    var scale = maxWidth / CB_BOARD_WIDTH;
    scale = Math.max(0.05, scale);
    var canvasWidth = Math.max(1, Math.floor(CB_BOARD_WIDTH * scale));
    var canvasHeight = Math.max(1, Math.floor(CB_BOARD_HEIGHT * scale));
    var changed = cv.width !== CB_BOARD_WIDTH || cv.height !== CB_BOARD_HEIGHT;
    if (changed) {
        cv.width = CB_BOARD_WIDTH;
        cv.height = CB_BOARD_HEIGHT;
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

// position in the shared finite board coordinates
function cb_pos(cv, e) {
    var p = cb_screen_pos(cv, e);
    return [
        Math.max(0, Math.min(CB_BOARD_WIDTH, p[0])),
        Math.max(0, Math.min(CB_BOARD_HEIGHT, p[1]))
    ];
}

function cb_down(e) {
    if (e.isPrimary === false || cb_pointer_id !== null) return;
    cb_pointer_id = e.pointerId;
    if (e.preventDefault) e.preventDefault();
    var cv = e.currentTarget;
    var p = cb_pos(cv, e);
    if (cb_tool === 'text') {
        cb_place_text(p);
        // Text placement finishes on pointer-down. Do not wait for pointer-up:
        // focusing the input can retarget that event in Android WebView and
        // otherwise leave the board locked to the old pointer id.
        cb_pointer_id = null;
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
    cb_write_board_event(d, true);
}

function cb_leave(e) {
    var cv = e.currentTarget;
    if (cv && cv.hasPointerCapture && cv.hasPointerCapture(e.pointerId)) return;
    cb_up(e);
}

function cb_cancel(e) {
    if (e && cb_pointer_id !== null && e.pointerId !== cb_pointer_id) return;
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
    cb_pointer_id = null;
    cb_drag = null;
    cb_draft = null;
    var cv = e && e.currentTarget;
    if (cv && cb_tool === 'select') cv.style.cursor = 'grab';
    cb_redraw();
}

function cb_lost_capture(e) {
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
    cb_write_board_event({
        k: 't', id: cb_id(ts), ts: ts, c: cb_color(), x: p[0], y: p[1], s: cb_enc(s)
    }, true);
    inp.value = '';
    inp.focus();
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
    ctx.fillStyle = '#ffffff';
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
    var strokeColor = col || o.c || '#000000';
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
    ctx.fillStyle = col || o.c || '#000000';
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
