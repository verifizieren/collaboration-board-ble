/* Collaboration Board adapter for the official tinySSB Android app. */

"use strict";

var wb_saved_core_height = null;
var wb_saved_core_overflow = null;
var WB_CACHE_LIMIT = 3000;

function wb_hash(value, seed) {
    var hash = (2166136261 ^ (seed || 0)) >>> 0;
    for (var i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 16777619) >>> 0;
    }
    return ('00000000' + hash.toString(16)).slice(-8);
}

function wb_token(code, label, length) {
    var value = '';
    var round = 0;
    while (value.length < length) {
        value += wb_hash(label + ':' + code + ':' + round, round * 2654435761);
        round += 1;
    }
    return value.slice(0, length);
}

function wb_room_from_code(code, username, boardName, creator) {
    var roomId = 'wbd-' + wb_token(code, 'room', 32);
    var known = cb_board_catalog()[roomId];
    var knownRoom = known && known.room ? known.room : null;
    return {
        v: 1,
        r: roomId,
        k: wb_token(code, 'key', 48),
        o: knownRoom && knownRoom.o ? knownRoom.o :
            (creator ? myId : '@whiteboard-' + code + '.ed25519'),
        u: username,
        b: boardName || (knownRoom && knownRoom.b) || ('Board ' + code),
        p: code,
        d: 1
    };
}

function wb_cache() {
    if (!tremola.collabboardTinyEvents ||
        typeof tremola.collabboardTinyEvents !== 'object' ||
        Array.isArray(tremola.collabboardTinyEvents)) {
        tremola.collabboardTinyEvents = {};
    }
    return tremola.collabboardTinyEvents;
}

function wb_room_events(roomId) {
    var cache = wb_cache();
    if (!Array.isArray(cache[roomId])) cache[roomId] = [];
    return cache[roomId];
}

function wb_parse_event(raw) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
    if (typeof raw !== 'string') return null;
    try { return JSON.parse(raw); } catch (_error) { return null; }
}

function wb_event_header(event, header) {
    return {
        fid: header && typeof header.fid === 'string' ? header.fid : '@unknown.ed25519',
        ref: header && typeof header.ref === 'string' ? header.ref : '',
        seq: header && Number(header.seq) > 0 ? Number(header.seq) : 0,
        tst: cb_event_ts(event),
        username: cb_clean_username(event.u)
    };
}

function wb_store_event(event, header) {
    if (!event || typeof event.r !== 'string' || typeof event.id !== 'string') return false;
    var entries = wb_room_events(event.r);
    if (entries.some(function (entry) { return entry && entry.e && entry.e.id === event.id; })) {
        return false;
    }
    entries.push({ e: event, h: wb_event_header(event, header) });
    entries.sort(function (a, b) { return cb_compare_events(a.e, b.e); });
    if (entries.length > WB_CACHE_LIMIT) entries.splice(0, entries.length - WB_CACHE_LIMIT);
    persist();
    return true;
}

function wb_members(roomId) {
    var members = [];
    wb_room_events(roomId).forEach(function (entry) {
        var fid = entry && entry.h && entry.h.fid;
        if (!fid || members.some(function (member) { return member.f === fid; })) return;
        members.push({ f: fid, u: cb_clean_username(entry.e.u) || cb_short_author(fid) });
    });
    return members.slice(0, CB_MAX_MEMBERS);
}

function wb_update_status() {
    var roomId = cb_current_room_id();
    if (!roomId) {
        cb_ble_status('Waiting for nearby device', 0, 0);
        return;
    }
    var members = wb_members(roomId);
    var peerCount = 0;
    if (typeof localPeers === 'object' && localPeers) {
        Object.keys(localPeers).forEach(function (id) {
            var peer = localPeers[id];
            if (peer && peer.type === 'ble' && peer.status === 'connected') peerCount += 1;
        });
    }
    cb_room_status(Math.max(1, members.length), CB_MAX_MEMBERS, members);
    cb_ble_status(peerCount ? 'Syncing nearby' : 'Waiting for nearby device', peerCount, 0);
}

function wb_install_sync_status_hooks() {
    if (typeof b2f_local_peer === 'function' && !b2f_local_peer.wbStatusHook) {
        var originalPeer = b2f_local_peer;
        b2f_local_peer = function () {
            var result = originalPeer.apply(this, arguments);
            wb_update_status();
            return result;
        };
        b2f_local_peer.wbStatusHook = true;
    }
    if (typeof b2f_ble_disabled === 'function' && !b2f_ble_disabled.wbStatusHook) {
        var originalDisabled = b2f_ble_disabled;
        b2f_ble_disabled = function () {
            var result = originalDisabled.apply(this, arguments);
            wb_update_status();
            return result;
        };
        b2f_ble_disabled.wbStatusHook = true;
    }
}

function whiteboard_new_event(message) {
    if (!message || !message.public || message.public[0] !== 'WBD') return;
    var event = wb_parse_event(message.public[1]);
    if (!event || !cb_is_valid_event(event)) return;
    var header = wb_event_header(event, message.header || {});
    var inserted = wb_store_event(event, header);
    if (header.fid === myId) cb_board_event_acked(event.id, event.r);

    var entry = cb_board_catalog()[event.r];
    if (event.k === 'n' && entry && entry.room) {
        entry.room.o = header.fid;
        entry.room.b = cb_clean_board_name(event.b) || entry.room.b;
    }
    if (inserted && cb_current_room_id() === event.r) {
        cb_apply(event, header);
        wb_update_status();
    }
}

function wb_replay_current_board() {
    var roomId = cb_current_room_id();
    wb_room_events(roomId).forEach(function (entry) {
        cb_apply(entry.e, entry.h);
    });
    wb_update_status();
    cb_board_replay_complete();
    cb_finish_board_replay();
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
    cb_schedule_fit();
    cb_prepare_board_replay(cb_pending_open_kind || 'saved', wb_replay_current_board);
}

function cb_create_board() {
    var usernameInput = document.getElementById('cb_username');
    var nameInput = document.getElementById('cb_board_name');
    var username = cb_clean_username(usernameInput && usernameInput.value);
    var boardName = cb_clean_board_name(nameInput && nameInput.value);
    if (!username) {
        cb_set_setup_error('Enter a name');
        return;
    }
    if (!boardName) {
        cb_set_setup_error('Enter a board name');
        return;
    }
    if (!cb_board_name_available(boardName)) {
        cb_set_setup_error('This board name is already used 8 times');
        return;
    }
    var code = cb_new_pairing_code();
    var attempts = 0;
    while (cb_board_catalog()[wb_room_from_code(code, username, boardName, true).r] && attempts < 20) {
        code = cb_new_pairing_code();
        attempts += 1;
    }
    tremola.collabboardLastUser = username;
    cb_pending_open_kind = 'create';
    cb_force_publish_name = true;
    cb_pending_pairing_code = code;
    cb_activate_room(wb_room_from_code(code, username, boardName, true));
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
        return;
    }
    tremola.collabboardLastUser = username;
    cb_pending_open_kind = 'join';
    cb_force_publish_name = false;
    var room = wb_room_from_code(code, username, '', false);
    var entry = cb_board_catalog()[room.r];
    cb_activate_room(room, entry && entry.state ? entry.state : null);
}

function cb_write_board_event(event, applyLocal, trackPending) {
    var roomId = cb_current_room_id();
    if (!roomId || cb_native_config_pending) return false;
    var room = cb_current_room();
    event.r = roomId;
    if (room && room.u) event.u = cb_clean_username(room.u);
    if (typeof event.l !== 'number' || !isFinite(event.l) || event.l <= 0) {
        event.l = cb_next_order();
    }
    backend('whiteboard ' + cb_utf8_b64(JSON.stringify(event)));
    if (trackPending !== false) cb_track_pending_event(event);
    if (applyLocal) cb_apply(event, cb_local_header(event.ts));
    return true;
}

function whiteboard_open() {
    wb_install_sync_status_hooks();
    setScenario('whiteboard');
    var core = document.getElementById('core');
    if (core) {
        if (wb_saved_core_height === null) wb_saved_core_height = core.style.height || '';
        if (wb_saved_core_overflow === null) wb_saved_core_overflow = core.style.overflow || '';
        core.style.height = 'calc(100vh - 51pt)';
        core.style.overflow = 'hidden';
    }
    document.getElementById('tremolaTitle').style.display = 'none';
    var title = document.getElementById('conversationTitle');
    title.style.display = null;
    title.innerHTML = '<strong>Collaboration Board</strong>';

    if (tremola.collabboardRoom) {
        cb_remember_room(tremola.collabboardRoom, true);
        delete tremola.collabboardRoom;
        delete tremola.collabboard;
        persist();
    }
    cb_dark_canvas = tremola.collabboardDark === true;
    cb_bind_canvas();
    cb_apply_dark_state();
    var username = document.getElementById('cb_username');
    if (username && !username.value) username.value = cb_clean_username(tremola.collabboardLastUser);
    cb_show_setup(true);
    cb_render_board_list();
    wb_update_status();
}

function wb_restore_layout() {
    var core = document.getElementById('core');
    if (core && wb_saved_core_height !== null) {
        core.style.height = wb_saved_core_height;
        core.style.overflow = wb_saved_core_overflow || '';
    }
    wb_saved_core_height = null;
    wb_saved_core_overflow = null;
}

function whiteboard_back() {
    if (cb_view_mode) {
        cb_exit_view();
        return;
    }
    if (cb_current_room() && tremola.collabboardRoom) {
        cb_close_board();
        return;
    }
    cb_hide_code_help();
    wb_restore_layout();
    setScenario('productivity');
}
