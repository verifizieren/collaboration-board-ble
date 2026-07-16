/* Collaboration Board adapter for the official tinySSB Android app. */

"use strict";

var wb_saved_core_height = null;
var wb_saved_core_overflow = null;
var WB_CACHE_LIMIT = 3000;
var WB_MAX_INVITES = 8;
var WB_META_CREATE = 'wc';
var WB_META_INVITE = 'wi';
var WB_META_ACCEPT = 'wa';
var WB_META_DECLINE = 'wd';
var WB_META_PROFILE = 'wp';
var WB_INVITE_COOLDOWN_MS = 30000;
var wb_announced_invites = Object.create(null);
var wb_export_busy = false;

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

function wb_legacy_room_from_code(code, username, boardName, creator) {
    var roomId = 'wbd-' + wb_token(code, 'room', 32);
    var known = cb_board_catalog()[roomId];
    var knownRoom = known && known.room ? known.room : null;
    return {
        v: 2,
        r: roomId,
        k: wb_token(code, 'key', 48),
        o: knownRoom && knownRoom.o ? knownRoom.o :
            (creator ? myId : '@whiteboard-' + code + '.ed25519'),
        u: username,
        b: boardName || (knownRoom && knownRoom.b) || ('Board ' + code),
        p: code,
        d: 2
    };
}

function wb_room_key(roomId, code, protocol) {
    return wb_token(protocol >= 3 ? roomId : code, 'key', 48);
}

function wb_new_room(code, username, boardName) {
    var roomId = '';
    do {
        roomId = 'wbd-' + cb_random_token(24);
    } while (cb_board_catalog()[roomId]);
    return {
        v: 3,
        r: roomId,
        k: wb_room_key(roomId, code, 3),
        o: myId,
        u: username,
        b: boardName,
        p: code,
        d: 3
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

function wb_valid_feed_id(fid) {
    return typeof fid === 'string' && fid.length >= 20 && fid.length <= 96 &&
        fid.charAt(0) === '@' && fid.slice(-8) === '.ed25519';
}

function wb_is_meta_event(event) {
    return !!event && [WB_META_CREATE, WB_META_INVITE, WB_META_ACCEPT,
        WB_META_DECLINE, WB_META_PROFILE].indexOf(event.k) >= 0;
}

function wb_is_valid_meta_event(event) {
    if (!wb_is_meta_event(event) || typeof event.id !== 'string' || event.id.length > 96 ||
        typeof event.r !== 'string' || event.r.length < 8 || event.r.length > 96) return false;
    if (typeof event.u !== 'undefined' &&
        (typeof event.u !== 'string' || !cb_clean_username(event.u) || event.u.length > 24)) return false;
    if (event.k === WB_META_CREATE) {
        return typeof event.b === 'string' && !!cb_clean_board_name(event.b) &&
            cb_valid_pairing_code(event.p) &&
            (typeof event.v === 'undefined' || event.v === 2 || event.v === 3);
    }
    if (event.k === WB_META_INVITE) {
        return wb_valid_feed_id(event.to) && typeof event.invite === 'undefined';
    }
    if (event.k === WB_META_ACCEPT || event.k === WB_META_DECLINE) {
        return typeof event.invite === 'string' && event.invite.length > 0 &&
            event.invite.length <= 96;
    }
    return event.k === WB_META_PROFILE && !!cb_clean_username(event.u);
}

function wb_meta_id(kind) {
    var seed = typeof myId === 'string' ? myId : 'local';
    return kind + '-' + Date.now().toString(36) + '-' +
        wb_hash(seed + ':' + Math.random().toString(36), Date.now()).slice(0, 10);
}

function wb_make_meta(kind, room, values) {
    var now = Date.now();
    var event = {
        k: kind,
        id: wb_meta_id(kind),
        r: room.r,
        ts: now,
        l: now,
        u: cb_clean_username(room.u)
    };
    Object.keys(values || {}).forEach(function (key) { event[key] = values[key]; });
    return event;
}

function wb_publish_meta(event) {
    if (!wb_is_valid_meta_event(event) || typeof myId !== 'string') return false;
    backend('whiteboard ' + cb_utf8_b64(JSON.stringify(event)));
    var inserted = wb_store_event(event, { fid: myId, tst: event.ts, username: event.u });
    if (inserted) wb_after_meta_change(event.r, event.k);
    return inserted;
}

function wb_contact_alias(fid) {
    var contact = tremola.contacts && tremola.contacts[fid];
    return contact ? cb_clean_username(contact.alias) : '';
}

function wb_is_verified_contact(fid) {
    if (fid === myId) return true;
    var contact = tremola.contacts && tremola.contacts[fid];
    return !!contact && Number(contact.trusted) === 2 && !contact.forgotten;
}

function wb_verified_contacts() {
    return Object.keys(tremola.contacts || {}).filter(function (fid) {
        return fid !== myId && wb_is_verified_contact(fid);
    }).sort(function (a, b) {
        return (wb_contact_alias(a) || a).localeCompare(wb_contact_alias(b) || b);
    });
}

function wb_current_room() {
    var room = tremola && tremola.collabboardRoom;
    return room && typeof room.r === 'string' && room.r ? room : null;
}

function wb_current_room_id() {
    var room = wb_current_room();
    return room ? room.r : null;
}

function wb_set_title() {
    var tremolaTitle = document.getElementById('tremolaTitle');
    var title = document.getElementById('conversationTitle');
    if (tremolaTitle) tremolaTitle.style.display = 'none';
    if (title) {
        title.style.display = null;
        title.innerHTML = '<strong>Collaboration Board (dpi26.15)</strong>';
    }
}

function wb_set_plus_visibility(visible) {
    var plus = document.getElementById('plus');
    if (plus) plus.style.display = visible ? null : 'none';
}

function whiteboard_plus() {
    if (wb_current_room()) whiteboard_invite_contacts();
    else {
        cb_set_setup_mode('create');
        launch_snackbar('Create or open a board before inviting someone');
    }
}

function wb_meta_state(roomId) {
    var entries = wb_room_events(roomId).filter(function (entry) {
        return entry && wb_is_valid_meta_event(entry.e) && entry.h && wb_valid_feed_id(entry.h.fid);
    }).slice().sort(function (a, b) { return cb_compare_events(a.e, b.e); });
    var created = null;
    entries.some(function (entry) {
        if (entry.e.k !== WB_META_CREATE) return false;
        created = entry;
        return true;
    });
    if (!created) {
        return {
            managed: false, owner: '', boardName: '', code: '', members: [],
            aliases: {}, invitations: [], latestInvitations: [], invitees: [],
            acceptances: [], declines: [], responses: {}, protocol: 0, roomId: roomId
        };
    }

    var owner = created.h.fid;
    var invitations = [];
    var invitees = [];
    var latestByInvitee = Object.create(null);
    entries.forEach(function (entry) {
        if (entry.e.k !== WB_META_INVITE || entry.h.fid !== owner) return;
        var previous = latestByInvitee[entry.e.to];
        if (!previous && invitees.length >= WB_MAX_INVITES) return;
        if (previous && cb_event_ts(entry.e) - cb_event_ts(previous.e) < WB_INVITE_COOLDOWN_MS) {
            return;
        }
        if (!previous) invitees.push(entry.e.to);
        invitations.push(entry);
        latestByInvitee[entry.e.to] = entry;
    });

    var invitationById = Object.create(null);
    invitations.forEach(function (entry) { invitationById[entry.e.id] = entry; });
    var responses = Object.create(null);
    entries.forEach(function (entry) {
        if ([WB_META_ACCEPT, WB_META_DECLINE].indexOf(entry.e.k) < 0 ||
            responses[entry.e.invite]) return;
        var invitation = invitationById[entry.e.invite];
        if (!invitation || entry.h.fid !== invitation.e.to) return;
        responses[entry.e.invite] = entry;
    });

    var acceptances = [];
    var declines = [];
    Object.keys(responses).forEach(function (inviteId) {
        var response = responses[inviteId];
        if (response.e.k === WB_META_ACCEPT) acceptances.push(response);
        else declines.push(response);
    });
    acceptances.sort(function (a, b) { return cb_compare_events(a.e, b.e); });
    declines.sort(function (a, b) { return cb_compare_events(a.e, b.e); });

    var members = [owner];
    acceptances.forEach(function (entry) {
        if (members.length >= CB_MAX_MEMBERS || members.indexOf(entry.h.fid) >= 0) return;
        members.push(entry.h.fid);
    });

    var aliases = Object.create(null);
    aliases[owner] = cb_clean_username(created.e.u) || wb_contact_alias(owner) || cb_short_author(owner);
    acceptances.forEach(function (entry) {
        if (members.indexOf(entry.h.fid) < 0) return;
        aliases[entry.h.fid] = cb_clean_username(entry.e.u) ||
            wb_contact_alias(entry.h.fid) || cb_short_author(entry.h.fid);
    });
    entries.forEach(function (entry) {
        if (entry.e.k !== WB_META_PROFILE || members.indexOf(entry.h.fid) < 0) return;
        aliases[entry.h.fid] = cb_clean_username(entry.e.u) || aliases[entry.h.fid];
    });
    wb_room_events(roomId).forEach(function (entry) {
        if (!entry || !entry.e || !entry.h || wb_is_meta_event(entry.e) ||
            members.indexOf(entry.h.fid) < 0) return;
        aliases[entry.h.fid] = cb_clean_username(entry.e.u) || aliases[entry.h.fid];
    });

    return {
        managed: true,
        owner: owner,
        boardName: cb_clean_board_name(created.e.b) || ('Board ' + created.e.p),
        code: cb_clean_pairing_code(created.e.p),
        members: members,
        aliases: aliases,
        invitations: invitations,
        latestInvitations: invitees.map(function (fid) { return latestByInvitee[fid]; }),
        invitees: invitees,
        acceptances: acceptances,
        declines: declines,
        responses: responses,
        protocol: Number(created.e.v) >= 3 ? 3 : 2,
        roomId: roomId
    };
}

function wb_members(roomId) {
    var state = wb_meta_state(roomId);
    if (state.managed) {
        return state.members.map(function (fid) {
            return { f: fid, u: state.aliases[fid] || wb_contact_alias(fid) || cb_short_author(fid) };
        });
    }
    var members = [];
    wb_room_events(roomId).forEach(function (entry) {
        var fid = entry && entry.h && entry.h.fid;
        if (!fid || wb_is_meta_event(entry.e)) return;
        var existing = members.filter(function (member) { return member.f === fid; })[0];
        var name = cb_clean_username(entry.e.u) || cb_short_author(fid);
        if (existing) existing.u = name || existing.u;
        else members.push({ f: fid, u: name });
    });
    return members.slice(0, CB_MAX_MEMBERS);
}

function wb_can_edit(roomId, fid) {
    var state = wb_meta_state(roomId);
    return !state.managed || state.members.indexOf(fid) >= 0;
}

function wb_has_acceptance(state, fid) {
    return state.acceptances.some(function (entry) { return entry.h.fid === fid; });
}

function wb_invitation_status(state, invitation) {
    if (!state || !invitation) return 'Waiting';
    var response = state.responses[invitation.e.id];
    if (!response) return state.members.indexOf(invitation.e.to) >= 0 ? 'Accepted' : 'Waiting';
    if (response.e.k === WB_META_DECLINE) return 'Declined';
    return state.members.indexOf(invitation.e.to) >= 0 ? 'Accepted' : 'Board full';
}

function wb_latest_invitation_for(state, fid) {
    if (!state) return null;
    return state.latestInvitations.filter(function (entry) {
        return entry.e.to === fid;
    })[0] || null;
}

function wb_invite_wait_seconds(invitation, now) {
    if (!invitation) return 0;
    var remaining = WB_INVITE_COOLDOWN_MS - ((Number(now) || Date.now()) - cb_event_ts(invitation.e));
    return Math.max(0, Math.min(30, Math.ceil(remaining / 1000)));
}

function wb_declined() {
    if (!tremola.collabboardTinyDeclined ||
        typeof tremola.collabboardTinyDeclined !== 'object' ||
        Array.isArray(tremola.collabboardTinyDeclined)) {
        tremola.collabboardTinyDeclined = {};
    }
    return tremola.collabboardTinyDeclined;
}

function wb_pending_invitations() {
    var result = [];
    Object.keys(wb_cache()).forEach(function (roomId) {
        var state = wb_meta_state(roomId);
        if (!state.managed || !wb_is_verified_contact(state.owner)) return;
        var entry = wb_latest_invitation_for(state, myId);
        if (!entry || wb_declined()[entry.e.id] || wb_has_acceptance(state, myId) ||
            state.responses[entry.e.id]) return;
        result.push({ roomId: roomId, state: state, invitation: entry });
    });
    result.sort(function (a, b) {
        return cb_compare_events(b.invitation.e, a.invitation.e);
    });
    return result;
}

function wb_outgoing_invitations() {
    var result = [];
    Object.keys(wb_cache()).forEach(function (roomId) {
        var state = wb_meta_state(roomId);
        if (!state.managed || state.owner !== myId) return;
        state.latestInvitations.forEach(function (invitation) {
            result.push({
                roomId: roomId,
                state: state,
                invitation: invitation,
                status: wb_invitation_status(state, invitation)
            });
        });
    });
    result.sort(function (a, b) {
        return cb_compare_events(b.invitation.e, a.invitation.e);
    });
    return result;
}

function wb_pending_invitations_for_code(code) {
    return wb_pending_invitations().filter(function (item) {
        return item.state.code === code;
    });
}

function wb_update_status() {
    var roomId = wb_current_room_id();
    if (!roomId) {
        cb_ble_status('Waiting for nearby device', 0, 0);
        return;
    }
    var members = wb_members(roomId);
    var peers = Object.create(null);
    if (typeof localPeers === 'object' && localPeers) {
        Object.keys(localPeers).forEach(function (id) {
            var peer = localPeers[id];
            if (!peer || peer.type !== 'ble' ||
                ['online', 'connected'].indexOf(peer.status) < 0) return;
            peers[peer.name || peer.alias || id] = true;
        });
    }
    var peerCount = Object.keys(peers).length;
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

function wb_fresh_board_state(roomId) {
    return {
        roomId: roomId,
        names: [], objects: [], clears: [], deletes: [], seen: [], mods: [], cancels: [],
        clock: 0, order: 0, schema: CB_STATE_VERSION
    };
}

function wb_rebuild_current_board() {
    var roomId = wb_current_room_id();
    if (!roomId) return;
    tremola.collabboard = wb_fresh_board_state(roomId);
    var wasReplay = cb_replay_active;
    cb_replay_active = true;
    wb_room_events(roomId).forEach(function (entry) {
        if (!entry || wb_is_meta_event(entry.e) || !wb_can_edit(roomId, entry.h.fid)) return;
        cb_apply(entry.e, entry.h);
    });
    cb_replay_active = wasReplay;
    if (wasReplay) return;
    cb_apply_synced_board_name(cb_state());
    cb_remember_room(tremola.collabboardRoom, true);
    persist();
    cb_redraw();
    cb_schedule_fit();
}

function wb_show_new_invitation(roomId) {
    var pending = wb_pending_invitations().filter(function (item) {
        return item.roomId === roomId && !wb_announced_invites[item.invitation.e.id];
    });
    if (!pending.length) return;
    pending.forEach(function (item) { wb_announced_invites[item.invitation.e.id] = true; });
    launch_snackbar('New whiteboard invitation');
    setTimeout(whiteboard_show_invitations, 80);
}

function wb_after_meta_change(roomId, kind) {
    var state = wb_meta_state(roomId);
    if (wb_current_room_id() === roomId && state.managed) {
        if (wb_has_acceptance(state, myId) && state.members.indexOf(myId) < 0) {
            cb_close_board();
            cb_forget_catalog_room(roomId);
            persist();
            cb_render_board_list();
            launch_snackbar('This board already has four members');
            return;
        }
        if (kind === WB_META_ACCEPT && !cb_replay_active) wb_rebuild_current_board();
        wb_update_status();
    }
    if (kind === WB_META_INVITE) {
        wb_show_new_invitation(roomId);
    }
    if (document.getElementById('kanban-invitations-overlay').style.display !== 'none' &&
        curr_scenario === 'whiteboard') {
        whiteboard_show_invitations();
    }
}

function whiteboard_new_event(message) {
    if (!message || !message.public || message.public[0] !== 'WBD') return;
    var event = wb_parse_event(message.public[1]);
    var header = wb_event_header(event || {}, message.header || {});
    if (wb_is_meta_event(event)) {
        if (!wb_is_valid_meta_event(event) || !wb_valid_feed_id(header.fid)) return;
        if (wb_store_event(event, header)) wb_after_meta_change(event.r, event.k);
        return;
    }
    if (!event || !cb_is_valid_event(event)) return;
    var inserted = wb_store_event(event, header);
    if (header.fid === myId) cb_board_event_acked(event.id, event.r);

    var authorized = wb_can_edit(event.r, header.fid);
    var entry = cb_board_catalog()[event.r];
    if (authorized && event.k === 'n' && entry && entry.room) {
        var state = wb_meta_state(event.r);
        entry.room.o = state.managed ? state.owner : header.fid;
        entry.room.b = cb_clean_board_name(event.b) || entry.room.b;
    }
    if (inserted && authorized && wb_current_room_id() === event.r) {
        cb_apply(event, header);
        wb_update_status();
    }
}

function wb_replay_current_board() {
    var roomId = wb_current_room_id();
    wb_room_events(roomId).forEach(function (entry) {
        if (!entry || wb_is_meta_event(entry.e) || !wb_can_edit(roomId, entry.h.fid)) return;
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
    var room = wb_new_room(code, username, boardName);
    tremola.collabboardLastUser = username;
    cb_pending_open_kind = 'create';
    cb_force_publish_name = true;
    wb_publish_meta(wb_make_meta(WB_META_CREATE, room, { b: boardName, p: code, v: 3 }));
    cb_activate_room(room);
}

function cb_join_board() {
    var usernameInput = document.getElementById('cb_username');
    var codeInput = document.getElementById('cb_join_code');
    var username = cb_clean_username(usernameInput && usernameInput.value);
    var code = cb_clean_pairing_code(codeInput && codeInput.value);
    if (!username) {
        cb_set_setup_error('Enter a name');
        if (usernameInput) usernameInput.focus();
        return;
    }
    if (!cb_valid_pairing_code(code)) {
        cb_set_setup_error('Enter a 6-digit code');
        if (codeInput) codeInput.focus();
        return;
    }
    var matches = wb_pending_invitations_for_code(code);
    if (!matches.length) {
        cb_set_setup_error('No signed invitation for this code yet');
        return;
    }
    if (matches.length > 1) {
        cb_set_setup_error('Open Invitations to choose this board');
        return;
    }
    cb_blur_setup_inputs();
    wb_accept_pending_invitation(matches[0], username);
}

function cb_write_board_event(event, applyLocal, trackPending) {
    var roomId = wb_current_room_id();
    if (!roomId || cb_native_config_pending) return false;
    if (!wb_can_edit(roomId, myId)) {
        cb_ble_status('Board access is not active', 0, 0);
        return false;
    }
    var room = wb_current_room();
    event.r = roomId;
    if (room && room.u) event.u = cb_clean_username(room.u);
    if (typeof event.l !== 'number' || !isFinite(event.l) || event.l <= 0) {
        event.l = cb_next_order();
    }
    backend('whiteboard ' + cb_utf8_b64(JSON.stringify(event)));
    var localHeader = cb_local_header(event.ts);
    wb_store_event(event, localHeader);
    if (trackPending !== false) cb_track_pending_event(event);
    if (applyLocal) cb_apply(event, localHeader);
    return true;
}

function wb_html(value) {
    if (typeof escapeHTML === 'function') return escapeHTML(String(value || ''));
    return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function wb_short_feed(fid) {
    if (!fid || fid.length <= 22) return fid || '';
    return fid.slice(0, 11) + '...' + fid.slice(-11);
}

function wb_mount_invite_menu() {
    var core = document.getElementById('core');
    var menu = document.getElementById('div:invite_menu');
    if (core && menu && menu.parentNode !== core) core.appendChild(menu);
}

function whiteboard_invite_contacts() {
    var room = wb_current_room();
    if (!room) {
        cb_set_setup_mode('create');
        var name = document.getElementById('cb_board_name');
        if (name) name.focus();
        launch_snackbar('Create or open a board first');
        return;
    }
    var state = wb_meta_state(room.r);
    if (!state.managed || state.owner !== myId) {
        launch_snackbar('Only the board creator can invite contacts');
        return;
    }
    wb_mount_invite_menu();
    closeOverlay();
    var header = document.getElementById('menu_invite_hdr');
    if (header) header.innerHTML = '<b>Invite contacts</b>';
    var content = document.getElementById('menu_invite_content');
    var contacts = wb_verified_contacts();
    var html = "<div class='wb_invite_intro'>Verified contacts only. Up to eight can be invited; four can join.</div>";
    if (!contacts.length) {
        html += "<div class='wb_invite_empty'>Verify a contact in Contacts first.</div>";
    }
    contacts.forEach(function (fid) {
        var member = state.members.indexOf(fid) >= 0;
        var latest = wb_latest_invitation_for(state, fid);
        var wait = wb_invite_wait_seconds(latest, Date.now());
        var full = !latest && state.invitees.length >= WB_MAX_INVITES;
        var status = member ? 'Member' : (latest ? wb_invitation_status(state, latest) :
            (full ? 'Invite limit reached' : ''));
        if (!member && wait) status += (status ? ' - ' : '') + 'Wait ' + wait + 's';
        var arg = encodeURIComponent(fid);
        html += "<div class='kanban_invitation_container light wb_official_invite'>" +
            "<div class='kanban_invitation_text_container'>" +
            "<div class='wb_official_invite_name'>" +
            wb_html(wb_contact_alias(fid) || cb_short_author(fid)) + "</div>" +
            "<div class='wb_official_invite_detail'>" +
            wb_html(status || wb_short_feed(fid)) + "</div></div>" +
            "<div class='wb_official_invite_actions'>";
        if (!member && !full) {
            html += "<button class='flat passive buttontext wb_official_invite_button' type='button' " +
                "aria-label='Invite contact' title='Invite contact' onclick=\"whiteboard_invite_contact(decodeURIComponent('" +
                arg + "'))\">&nbsp;</button>";
        }
        html += '</div></div>';
    });
    content.innerHTML = html;
    document.getElementById('div:invite_menu').style.display = 'initial';
    document.getElementById('overlay-bg').style.display = 'initial';
    overlayIsActive = true;
}

function whiteboard_invite_contact(fid) {
    var room = wb_current_room();
    var state = room ? wb_meta_state(room.r) : null;
    if (!room || !state || !state.managed || state.owner !== myId || !wb_is_verified_contact(fid)) {
        launch_snackbar('This contact cannot be invited');
        return;
    }
    if (state.members.indexOf(fid) >= 0) {
        launch_snackbar('This contact is already a member');
        return;
    }
    var latest = wb_latest_invitation_for(state, fid);
    var wait = wb_invite_wait_seconds(latest, Date.now());
    if (wait > 0) {
        launch_snackbar('Wait ' + wait + ' seconds before inviting this contact again');
        return;
    }
    if (!latest && state.invitees.length >= WB_MAX_INVITES) {
        launch_snackbar('Eight contacts are already invited');
        return;
    }
    wb_publish_meta(wb_make_meta(WB_META_INVITE, room, { to: fid }));
    launch_snackbar('Invitation sent');
    whiteboard_invite_contacts();
}

function whiteboard_show_invitations() {
    closeOverlay();
    var overlay = document.getElementById('kanban-invitations-overlay');
    var list = document.getElementById('kanban_invitations_list');
    var username = cb_clean_username(tremola.collabboardLastUser) || wb_contact_alias(myId);
    var pending = wb_pending_invitations();
    var outgoing = wb_outgoing_invitations();
    pending.forEach(function (item) { wb_announced_invites[item.invitation.e.id] = true; });
    var html = '';
    if (pending.length) {
        html += "<div class='wb_invitation_section'>Received</div>" +
            "<label class='wb_invitation_name_label' for='wb_invitation_name'>Your whiteboard name</label>" +
            "<input id='wb_invitation_name' class='wb_invitation_name' maxlength='24' value='" +
            wb_html(username) + "' placeholder='Name'>";
    }
    pending.forEach(function (item) {
        var invitation = item.invitation;
        var state = item.state;
        var arg = encodeURIComponent(invitation.e.id);
        var full = state.members.length >= CB_MAX_MEMBERS;
        html += "<div class='wb_invitation_card'><div><strong>" + wb_html(state.boardName) +
            "</strong><span>From " + wb_html(wb_contact_alias(state.owner) || cb_short_author(state.owner)) +
            "</span></div><div class='wb_invitation_actions'>";
        if (full) html += "<span class='wb_invite_status'>Board full</span>";
        else html += "<button class='wb_invitation_accept' type='button' onclick=\"whiteboard_accept_invite(decodeURIComponent('" +
            arg + "'))\">Accept</button>";
        html += "<button class='wb_invitation_decline' type='button' onclick=\"whiteboard_decline_invite(decodeURIComponent('" +
            arg + "'))\">Decline</button></div></div>";
    });
    if (outgoing.length) {
        html += "<div class='wb_invitation_section'>Sent</div>";
        outgoing.forEach(function (item) {
            var invitation = item.invitation;
            html += "<div class='wb_invitation_card'><div><strong>" +
                wb_html(wb_contact_alias(invitation.e.to) || cb_short_author(invitation.e.to)) +
                "</strong><span>" + wb_html(item.state.boardName) + "</span></div>" +
                "<span class='wb_invite_status wb_invite_status_" +
                item.status.toLowerCase().replace(/\s+/g, '_') + "'>" +
                wb_html(item.status) + "</span></div>";
        });
    }
    if (!pending.length && !outgoing.length) {
        html = "<div class='wb_invite_empty'>No whiteboard invitations.</div>";
    }
    list.innerHTML = html;
    overlay.style.display = 'initial';
    document.getElementById('overlay-bg').style.display = 'initial';
    overlayIsActive = true;
}

function wb_find_pending_invitation(inviteId) {
    return wb_pending_invitations().filter(function (item) {
        return item.invitation.e.id === inviteId;
    })[0] || null;
}

function whiteboard_accept_invite(inviteId) {
    var item = wb_find_pending_invitation(inviteId);
    var input = document.getElementById('wb_invitation_name');
    var username = cb_clean_username(input && input.value);
    if (!item) {
        launch_snackbar('Invitation is no longer available');
        return;
    }
    if (!username) {
        launch_snackbar('Enter your whiteboard name');
        if (input) input.focus();
        return;
    }
    wb_accept_pending_invitation(item, username);
}

function wb_accept_pending_invitation(item, username) {
    if (!item || !username) return false;
    if (item.state.members.length >= CB_MAX_MEMBERS) {
        launch_snackbar('This board already has four members');
        return false;
    }
    var room = {
        v: item.state.protocol >= 3 ? 3 : 2,
        r: item.roomId,
        k: wb_room_key(item.roomId, item.state.code, item.state.protocol),
        o: item.state.owner,
        u: username,
        b: item.state.boardName,
        p: item.state.code,
        d: item.state.protocol >= 3 ? 3 : 2
    };
    tremola.collabboardLastUser = username;
    wb_publish_meta(wb_make_meta(WB_META_ACCEPT, room, { invite: item.invitation.e.id }));
    closeOverlay();
    if (curr_scenario !== 'whiteboard') whiteboard_open(true);
    cb_pending_open_kind = 'join';
    cb_force_publish_name = false;
    cb_activate_room(room);
    return true;
}

function whiteboard_decline_invite(inviteId) {
    var item = wb_find_pending_invitation(inviteId);
    if (!item) {
        launch_snackbar('Invitation is no longer available');
        return;
    }
    var room = {
        v: item.state.protocol >= 3 ? 3 : 2,
        r: item.roomId,
        k: wb_room_key(item.roomId, item.state.code, item.state.protocol),
        o: item.state.owner,
        u: cb_clean_username(tremola.collabboardLastUser) || wb_contact_alias(myId) || 'Guest',
        b: item.state.boardName,
        p: item.state.code,
        d: item.state.protocol >= 3 ? 3 : 2
    };
    wb_publish_meta(wb_make_meta(WB_META_DECLINE, room, { invite: item.invitation.e.id }));
    wb_declined()[inviteId] = true;
    persist();
    launch_snackbar('Invitation declined');
    if (wb_pending_invitations().length || wb_outgoing_invitations().length) {
        whiteboard_show_invitations();
    } else {
        closeOverlay();
    }
}

function wb_publish_profile_if_needed() {
    var room = wb_current_room();
    if (!room) return;
    var state = wb_meta_state(room.r);
    var username = cb_clean_username(room.u);
    if (!state.managed || state.members.indexOf(myId) < 0 || !username ||
        state.aliases[myId] === username) return;
    wb_publish_meta(wb_make_meta(WB_META_PROFILE, room, {}));
}

var wb_open_saved_board_base = cb_open_saved_board;
cb_open_saved_board = function (roomId) {
    wb_open_saved_board_base(roomId);
    wb_publish_profile_if_needed();
};

cb_copy_invite = function () {
    var room = wb_current_room();
    if (room && cb_valid_pairing_code(room.p)) cb_copy_text(room.p);
};

var wb_update_room_bar_base = cb_update_room_bar;
cb_update_room_bar = function () {
    wb_update_room_bar_base();
    var room = wb_current_room();
    var code = room && cb_valid_pairing_code(room.p) ? room.p : '';
    var chip = document.getElementById('cb_invite_btn');
    var oldCode = document.getElementById('cb_room_code');
    if (chip) {
        chip.classList.add('wb_code_chip');
        chip.style.display = code ? null : 'none';
        chip.textContent = code ? 'Code ' + code : '';
        chip.setAttribute('aria-label', code ? 'Board code ' + code + '. Tap to copy.' : 'Board code');
        chip.title = code ? 'Tap to copy board code' : '';
    }
    if (oldCode) oldCode.style.display = 'none';
};

var wb_show_setup_base = cb_show_setup;
cb_show_setup = function (show) {
    wb_show_setup_base(show);
    wb_set_plus_visibility(curr_scenario === 'whiteboard');
};

function wb_install_export_button() {
    if (document.getElementById('wb_export_btn')) return;
    var clear = document.getElementById('cb_clear_btn');
    if (!clear || !clear.parentNode || !document.createElement) return;
    var button = document.createElement('button');
    button.id = 'wb_export_btn';
    button.className = 'cb_tool wb_export_btn';
    button.type = 'button';
    button.textContent = 'Export';
    button.setAttribute('aria-label', 'Export board');
    button.onclick = whiteboard_show_export;
    clear.parentNode.appendChild(button);
}

function whiteboard_show_export() {
    if (!wb_current_room()) return;
    wb_mount_invite_menu();
    closeOverlay();
    var header = document.getElementById('menu_invite_hdr');
    var content = document.getElementById('menu_invite_content');
    if (header) header.innerHTML = '<b>Export board</b>';
    content.innerHTML = "<div class='wb_export_intro'>Export only the whiteboard canvas.</div>" +
        "<button class='wb_export_choice' type='button' onclick=\"whiteboard_export('jpeg')\">JPEG image</button>" +
        "<button class='wb_export_choice' type='button' onclick=\"whiteboard_export('pdf')\">PDF document</button>";
    document.getElementById('div:invite_menu').style.display = 'initial';
    document.getElementById('overlay-bg').style.display = 'initial';
    overlayIsActive = true;
}

function wb_export_data_url(format) {
    var width = 1200;
    var scale = width / CB_BOARD_WIDTH;
    var height = Math.round(CB_BOARD_HEIGHT * scale);
    var canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    var ctx = canvas.getContext('2d');
    var originalDark = cb_dark_canvas;
    var exportDark = format === 'jpeg' && originalDark;
    ctx.fillStyle = exportDark ? '#0f1115' : '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.save();
    ctx.scale(scale, scale);
    cb_dark_canvas = exportDark;
    try {
        var state = cb_state();
        cb_visible_objects(state).forEach(function (object) {
            var transform = cb_xf(state, object);
            var color = cb_eff_color(state, object);
            if (object.k === 's') cb_draw_stroke(ctx, object, transform, color);
            else if (object.k === 't') cb_draw_text(ctx, object, transform, color);
        });
    } finally {
        cb_dark_canvas = originalDark;
        ctx.restore();
    }
    return canvas.toDataURL('image/jpeg', 0.92);
}

function whiteboard_export(format) {
    if (wb_export_busy || !wb_current_room()) return;
    wb_export_busy = true;
    closeOverlay();
    try {
        var normalized = format === 'pdf' ? 'pdf' : 'jpeg';
        var dataUrl = wb_export_data_url(normalized);
        var payload = dataUrl.slice(dataUrl.indexOf(',') + 1);
        if (typeof Android !== 'undefined' && typeof Android.exportWhiteboard === 'function') {
            Android.exportWhiteboard(normalized, payload);
        } else if (normalized === 'jpeg') {
            var link = document.createElement('a');
            link.href = dataUrl;
            link.download = 'whiteboard.jpg';
            link.click();
        } else {
            launch_snackbar('PDF export needs the Android app');
        }
    } catch (_error) {
        launch_snackbar('Could not export board');
    }
    setTimeout(function () { wb_export_busy = false; }, 500);
}

function whiteboard_open(suppressInvitationPopup) {
    wb_install_sync_status_hooks();
    wb_mount_invite_menu();
    wb_install_export_button();
    setScenario('whiteboard');
    var core = document.getElementById('core');
    if (core) {
        if (wb_saved_core_height === null) wb_saved_core_height = core.style.height || '';
        if (wb_saved_core_overflow === null) wb_saved_core_overflow = core.style.overflow || '';
        core.style.height = 'calc(100vh - 51pt)';
        core.style.overflow = 'hidden';
    }
    wb_set_title();
    if (document.querySelector) {
        var help = document.querySelector('#cb_code_help p');
        if (help) help.textContent = 'Enter the code from a signed invitation. A code alone cannot open a board.';
    }

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
    if (username && !username.value) {
        username.value = cb_clean_username(tremola.collabboardLastUser) || wb_contact_alias(myId);
    }
    cb_show_setup(true);
    cb_set_setup_mode('create');
    cb_render_board_list();
    wb_update_status();
    if (!suppressInvitationPopup && wb_pending_invitations().length) {
        setTimeout(whiteboard_show_invitations, 80);
    }
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
    if (wb_current_room()) {
        cb_close_board();
        return;
    }
    cb_hide_code_help();
    wb_restore_layout();
    setScenario('productivity');
}
