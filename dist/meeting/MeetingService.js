"use strict";
// realtime-modules/src/meeting/MeetingService.ts
//
// The `meeting` WS service: raised hands and breakout rooms for a call that
// already runs on LVS. See ./types.ts for the wire contract and
// docs/design/meeting-rooms.md for the shape.
//
// Concurrency: every mutation of one meeting runs on that meeting's promise
// chain, read-modify-write against the store, so two organizers clicking at
// once cannot lose each other's change inside one process.
Object.defineProperty(exports, "__esModule", { value: true });
exports.MeetingService = void 0;
const MeetingStateStore_1 = require("./MeetingStateStore");
const lobby_1 = require("./lobby");
const types_1 = require("./types");
const DEFAULT_MAX_ROOMS = 50;
const DEFAULT_MAX_TIMER_MS = 4 * 60 * 60 * 1000;
const MAX_CLOSING_GRACE_MS = 5 * 60 * 1000;
const DEFAULT_RATE_BURST = 20;
const DEFAULT_RATE_PER_SECOND = 5;
const NOOP_LOGGER = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
};
class MeetingError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
/** A shared store refused a write: another replica committed first. */
class StaleWrite extends Error {
}
/** Re-read-and-apply attempts before a write gives up with CONFLICT. */
const MAX_WRITE_ATTEMPTS = 5;
class MeetingService {
    router;
    logger;
    store;
    isOrganizerHook;
    maxRooms;
    maxTimerMs;
    closingGraceMs;
    now;
    onChange;
    rate;
    /** Token buckets per `meetingId\u0000userId`. */
    buckets = new Map();
    clients = new Map();
    chains = new Map();
    timers = new Map();
    roomSeq = 0;
    /** Last state this process read or wrote per meeting, for the synchronous lobby check. */
    mirror = new Map();
    /** Last organizer verdict per `meetingId\u0000userId`, for the synchronous lobby check. */
    organizerVerdicts = new Map();
    /** Stops `store.watch`, when the store offers it. */
    unwatch;
    constructor(opts) {
        if (!opts || !opts.router)
            throw new Error('MeetingService: router is required');
        const config = opts.config ?? {};
        this.router = opts.router;
        this.logger = opts.logger ?? NOOP_LOGGER;
        this.store = config.store ?? new MeetingStateStore_1.InMemoryMeetingStateStore();
        this.isOrganizerHook = config.isOrganizer ?? null;
        this.maxRooms = config.maxRooms ?? DEFAULT_MAX_ROOMS;
        this.maxTimerMs = config.maxTimerMs ?? DEFAULT_MAX_TIMER_MS;
        const grace = Number(config.closingGraceMs ?? 0);
        this.closingGraceMs = Number.isFinite(grace) ? Math.min(MAX_CLOSING_GRACE_MS, Math.max(0, Math.round(grace))) : 0;
        this.now = config.now ?? Date.now;
        this.onChange = config.onChange ?? null;
        const rl = config.rateLimit;
        this.rate = rl === false ? null : {
            burst: Math.max(1, Math.round(rl?.burst ?? DEFAULT_RATE_BURST)),
            perMs: Math.max(0.001, rl?.perSecond ?? DEFAULT_RATE_PER_SECOND) / 1000,
        };
        this.unwatch = this.store.watch ? this.store.watch((state) => this.onRemoteState(state)) : null;
    }
    // ── WsService ────────────────────────────────────────────────────────────
    async handleAction(clientId, action, data) {
        const meetingId = typeof data?.meetingId === 'string' ? data.meetingId : null;
        try {
            if (!types_1.MEETING_ACTIONS.has(action)) {
                throw new MeetingError('INVALID_ACTION', `Unknown meeting action: ${action}`);
            }
            if (!meetingId || !types_1.MEETING_ID_PATTERN.test(meetingId)) {
                throw new MeetingError('INVALID_PAYLOAD', 'meetingId is required');
            }
            // A meeting whose id contains the separator would be read as a
            // breakout lobby of ANOTHER meeting by parseBreakoutLobby, and a
            // lobby guard would judge its media by that meeting's rooms.
            if (meetingId.includes(lobby_1.BREAKOUT_LOBBY_SEPARATOR)) {
                throw new MeetingError('INVALID_PAYLOAD', `meetingId may not contain ${lobby_1.BREAKOUT_LOBBY_SEPARATOR}`);
            }
            const verb = action;
            if (verb === 'subscribe')
                return await this.subscribe(clientId, meetingId);
            if (verb === 'unsubscribe')
                return await this.unsubscribe(clientId, meetingId);
            await this.mutate(clientId, meetingId, verb, data);
        }
        catch (err) {
            if (err instanceof MeetingError) {
                this.sendError(clientId, meetingId, action, err.code, err.message);
                return;
            }
            this.logger.error('meeting action failed', { action, meetingId, error: String(err) });
            this.sendError(clientId, meetingId, action, 'CONFLICT', 'The meeting could not be updated');
        }
    }
    onClientConnect(_clientId) {
        // State is per meeting, not per connection.
    }
    async onClientDisconnect(clientId) {
        const entry = this.clients.get(clientId);
        this.clients.delete(clientId);
        if (!entry)
            return;
        if (!entry.userId) {
            for (const meetingId of entry.meetings)
                await this.releaseIfIdle(meetingId).catch(() => undefined);
            return;
        }
        for (const meetingId of entry.meetings) {
            if (this.userHasOtherClient(entry.userId, meetingId, clientId))
                continue;
            // The last connection of a user in this meeting is gone: their hand
            // goes down. Breakout placement stays — they may reconnect.
            const userId = entry.userId;
            await this.serial(meetingId, async () => {
                const state = await this.store.get(meetingId);
                if (!state || !state.hands.some((h) => h.userId === userId))
                    return;
                const next = this.bump(state);
                next.hands = next.hands.filter((h) => h.userId !== userId);
                await this.commit({ state: next, hands: true }, 'hand.lower', userId);
            }).catch((err) => this.logger.warn('meeting disconnect cleanup failed', { meetingId, error: String(err) }));
        }
        for (const meetingId of entry.meetings) {
            await this.releaseIfIdle(meetingId).catch((err) => this.logger.warn('meeting release failed', { meetingId, error: String(err) }));
        }
    }
    // ── Host-facing reads ─────────────────────────────────────────────────────
    /** The meeting's state, or null when nobody has subscribed yet. */
    async getState(meetingId) {
        await this.expireIfDue(meetingId);
        const state = await this.store.get(meetingId);
        if (state)
            this.mirror.set(meetingId, state);
        return state;
    }
    /**
     * Whether `userId` may sit in `lobby` right now, for a host's LVS lobby
     * guard. Non-breakout lobbies return null (not this service's question).
     * Organizers may enter any open room; everyone else only the open room
     * they belong in (in self-select mode, any open room).
     */
    async admitsBreakoutLobby(userId, lobby) {
        const parsed = (0, lobby_1.parseBreakoutLobby)(lobby);
        if (!parsed)
            return null;
        const state = await this.getState(parsed.meetingId);
        const verdict = admitsRoom(state, parsed.roomId, userId);
        if (verdict !== 'organizer-only')
            return verdict;
        return this.organizerByUser(state, userId);
    }
    /**
     * The same answer from this process's last-known state, synchronously —
     * for `calls({ lobbyGuard })`, which cannot await. A meeting this process
     * has not seen refuses. Without an `isOrganizer` hook the creator is the
     * organizer on every replica that follows the meeting (0.127.0); with a
     * hook, an organizer is recognised once this process has resolved them
     * (any subscribe or write of theirs here).
     */
    admitsBreakoutLobbySync(userId, lobby) {
        const parsed = (0, lobby_1.parseBreakoutLobby)(lobby);
        if (!parsed)
            return null;
        const state = this.mirror.get(parsed.meetingId) ?? null;
        if (state?.breakout.endsAt && state.breakout.phase === 'open' && Date.parse(state.breakout.endsAt) <= this.now())
            return false;
        const verdict = admitsRoom(state, parsed.roomId, userId);
        if (verdict !== 'organizer-only')
            return verdict;
        // Without an isOrganizer hook the organizer is whoever created the
        // meeting, which the mirrored state carries, so every replica can
        // answer (0.127.0) — not only the one the organizer has used. A hook's
        // verdict is only known where it ran; for those, use the async
        // admitsBreakoutLobby on replicas the organizer may not have touched.
        if (!this.isOrganizerHook)
            return state.createdBy !== null && state.createdBy === userId;
        return this.organizerVerdicts.get(`${parsed.meetingId}\u0000${userId}`) === true;
    }
    /**
     * Drop a meeting's state once nobody in this process is subscribed and it
     * holds nothing live (no raised hand, no breakout session). Without this a
     * long-running gateway keeps every meeting it ever saw. A meeting with
     * rooms (draft or open) is kept so an organizer who reconnects finds them.
     */
    async releaseIfIdle(meetingId) {
        for (const e of this.clients.values())
            if (e.meetings.has(meetingId))
                return;
        await this.serial(meetingId, async () => {
            for (const e of this.clients.values())
                if (e.meetings.has(meetingId))
                    return;
            const state = await this.store.get(meetingId);
            if (state && (state.hands.length > 0 || state.breakout.phase !== 'none'))
                return;
            // A shared store may hold subscribers on other replicas: deleting
            // would restart the version at 1 under their clients, which then
            // drop every frame as stale. Its own expiry reaps the state.
            if (!this.store.shared)
                await this.store.delete(meetingId);
            this.mirror.delete(meetingId);
            const prefix = `${meetingId}\u0000`;
            for (const k of this.organizerVerdicts.keys())
                if (k.startsWith(prefix))
                    this.organizerVerdicts.delete(k);
            const t = this.timers.get(meetingId);
            if (t)
                clearTimeout(t);
            this.timers.delete(meetingId);
            for (const k of this.buckets.keys())
                if (k.startsWith(prefix))
                    this.buckets.delete(k);
        });
    }
    /** One token from this person's bucket in this meeting, or false when it is empty. */
    take(meetingId, userId) {
        if (!this.rate)
            return true;
        const key = `${meetingId}\u0000${userId}`;
        const now = this.now();
        const b = this.buckets.get(key) ?? { tokens: this.rate.burst, at: now };
        b.tokens = Math.min(this.rate.burst, b.tokens + (now - b.at) * this.rate.perMs);
        b.at = now;
        if (b.tokens < 1) {
            this.buckets.set(key, b);
            return false;
        }
        b.tokens -= 1;
        if (this.buckets.size > 50_000 && !this.buckets.has(key))
            this.buckets.clear();
        this.buckets.set(key, b);
        return true;
    }
    /** Stop every breakout timer (tests, shutdown). */
    dispose() {
        this.unwatch?.();
        for (const t of this.timers.values())
            clearTimeout(t);
        this.timers.clear();
    }
    // ── subscribe / unsubscribe ────────────────────────────────────────────────
    async subscribe(clientId, meetingId) {
        const channel = (0, types_1.meetingChannel)(meetingId);
        if (this.router.subscribeToChannel) {
            const ok = await this.router.subscribeToChannel(clientId, channel);
            if (ok === false)
                throw new MeetingError('FORBIDDEN', 'Not allowed in this meeting');
        }
        else if (this.router.checkChannel) {
            const ok = await this.router.checkChannel('subscribe', clientId, channel);
            if (ok === false)
                throw new MeetingError('FORBIDDEN', 'Not allowed in this meeting');
        }
        const userId = this.userIdOf(clientId);
        const entry = this.clients.get(clientId) ?? { userId, meetings: new Set() };
        entry.userId = userId;
        entry.meetings.add(meetingId);
        this.clients.set(clientId, entry);
        await this.expireIfDue(meetingId);
        const state = await this.serial(meetingId, async () => {
            const existing = await this.store.get(meetingId);
            const state = existing ?? this.freshState(meetingId, userId);
            if (!existing && !(await this.write(state, 0)))
                throw new StaleWrite();
            this.mirror.set(meetingId, state);
            return state;
        });
        const organizer = userId ? await this.organizer(state, userId, clientId) : false;
        await this.send(clientId, {
            type: 'meeting',
            action: 'meeting.snapshot',
            meetingId,
            data: { ...state, you: { userId, organizer } },
            timestamp: this.iso(),
        });
    }
    async unsubscribe(clientId, meetingId) {
        const entry = this.clients.get(clientId);
        entry?.meetings.delete(meetingId);
        await this.router.unsubscribeFromChannel?.(clientId, (0, types_1.meetingChannel)(meetingId));
        await this.send(clientId, {
            type: 'meeting',
            action: 'meeting.unsubscribed',
            meetingId,
            data: {},
            timestamp: this.iso(),
        });
        if (entry && entry.userId && !this.userHasOtherClient(entry.userId, meetingId, clientId)) {
            // Leaving the meeting lowers your hand, like a disconnect.
            const userId = entry.userId;
            await this.serial(meetingId, async () => {
                const state = await this.store.get(meetingId);
                if (!state || !state.hands.some((h) => h.userId === userId))
                    return;
                const next = this.bump(state);
                next.hands = next.hands.filter((h) => h.userId !== userId);
                await this.commit({ state: next, hands: true }, 'hand.lower', userId);
            });
        }
        await this.releaseIfIdle(meetingId);
    }
    // ── mutations ─────────────────────────────────────────────────────────────
    async mutate(clientId, meetingId, verb, data) {
        const entry = this.clients.get(clientId);
        if (!entry || !entry.meetings.has(meetingId)) {
            throw new MeetingError('NOT_SUBSCRIBED', 'Subscribe to the meeting first');
        }
        const userId = this.userIdOf(clientId);
        if (!userId)
            throw new MeetingError('UNAUTHENTICATED', 'A signed-in user is required');
        if (!this.take(meetingId, userId)) {
            throw new MeetingError('RATE_LIMITED', 'Too many changes too quickly; wait a moment');
        }
        await this.expireIfDue(meetingId);
        await this.serial(meetingId, async () => {
            const state = await this.store.get(meetingId);
            if (!state)
                throw new MeetingError('NOT_FOUND', 'No such meeting');
            const isOrganizer = await this.organizer(state, userId, clientId);
            const lowersOther = verb === 'hand.lower' && typeof data.userId === 'string' && data.userId !== userId;
            if ((types_1.ORGANIZER_ACTIONS.has(verb) || lowersOther) && !isOrganizer) {
                throw new MeetingError('FORBIDDEN', 'Only an organizer can do that');
            }
            const mutation = this.apply(this.bump(state), verb, data, userId, clientId, isOrganizer);
            if (!mutation)
                return;
            await this.commit(mutation, verb, userId);
        });
    }
    /** Pure state transition. Returns null for a no-op (nothing is broadcast). */
    apply(next, verb, data, userId, clientId, isOrganizer) {
        const b = next.breakout;
        switch (verb) {
            case 'hand.raise': {
                if (next.hands.some((h) => h.userId === userId))
                    return null;
                next.hands = [...next.hands, { userId, displayName: this.displayNameOf(clientId, data), raisedAt: this.iso() }];
                return { state: next, hands: true };
            }
            case 'hand.lower': {
                const target = typeof data.userId === 'string' ? data.userId : userId;
                if (!next.hands.some((h) => h.userId === target))
                    return null;
                next.hands = next.hands.filter((h) => h.userId !== target);
                return { state: next, hands: true };
            }
            case 'hand.lowerAll': {
                if (next.hands.length === 0)
                    return null;
                next.hands = [];
                return { state: next, hands: true };
            }
            case 'breakout.configure': {
                if (b.phase === 'open')
                    throw new MeetingError('CONFLICT', 'Close the rooms before reconfiguring them');
                const rooms = this.parseRooms(data.rooms, b.rooms);
                // Absent keeps the current value; present but malformed is refused,
                // as the event-catalog schema refuses it (0.131.0). These were
                // silently ignored, so a typo'd mode left the old one in place.
                if (data.mode !== undefined && parseMode(data.mode) === null) {
                    throw new MeetingError('INVALID_PAYLOAD', 'mode must be "assigned" or "self-select"');
                }
                if (data.allowReturnToMain !== undefined && typeof data.allowReturnToMain !== 'boolean') {
                    throw new MeetingError('INVALID_PAYLOAD', 'allowReturnToMain must be a boolean');
                }
                const mode = parseMode(data.mode) ?? b.mode;
                const allowReturnToMain = typeof data.allowReturnToMain === 'boolean'
                    ? data.allowReturnToMain
                    : b.settings.allowReturnToMain;
                next.breakout = {
                    ...b,
                    phase: rooms.length > 0 ? 'draft' : 'none',
                    mode,
                    rooms,
                    returned: [],
                    endsAt: null,
                    closing: false,
                    announcement: null,
                    settings: { allowReturnToMain },
                };
                return { state: next, breakout: true };
            }
            case 'breakout.addRoom': {
                // Allowed in any phase: Teams adds a room while the others are open.
                // The new room starts closed; open it with `breakout.open { roomIds }`.
                if (b.rooms.length >= this.maxRooms)
                    throw new MeetingError('CONFLICT', `At most ${this.maxRooms} rooms`);
                let id = typeof data.id === 'string' ? data.id : '';
                if (id && !types_1.BREAKOUT_ROOM_ID_PATTERN.test(id))
                    throw new MeetingError('INVALID_PAYLOAD', `Invalid room id: ${id}`);
                if (id && b.rooms.some((r) => r.id === id))
                    throw new MeetingError('CONFLICT', `Duplicate room id: ${id}`);
                if (!id)
                    id = this.mintRoomId();
                const name = data.name === undefined || data.name === null
                    ? nextRoomName(b.rooms)
                    : parseRoomName(data.name);
                next.breakout = {
                    ...b,
                    phase: b.phase === 'none' ? 'draft' : b.phase,
                    rooms: [...b.rooms, { id, name, state: 'closed', members: [] }],
                };
                return { state: next, breakout: true };
            }
            case 'breakout.rename': {
                const roomId = typeof data.roomId === 'string' ? data.roomId : '';
                const room = b.rooms.find((r) => r.id === roomId);
                if (!room)
                    throw new MeetingError('NOT_FOUND', 'No such room');
                const name = parseRoomName(data.name);
                if (name === room.name)
                    return null;
                next.breakout = { ...b, rooms: b.rooms.map((r) => (r.id === roomId ? { ...r, name } : r)) };
                return { state: next, breakout: true };
            }
            case 'breakout.assign': {
                const assignments = data.assignments;
                if (!assignments || typeof assignments !== 'object' || Array.isArray(assignments)) {
                    throw new MeetingError('INVALID_PAYLOAD', 'assignments must be an object of userId → roomId | null');
                }
                const rooms = b.rooms.map((r) => ({ ...r, members: [...r.members] }));
                for (const [who, roomId] of Object.entries(assignments)) {
                    if (!who)
                        continue;
                    if (roomId !== null && (typeof roomId !== 'string' || !rooms.some((r) => r.id === roomId))) {
                        throw new MeetingError('INVALID_PAYLOAD', `Unknown room: ${String(roomId)}`);
                    }
                    placeUser(rooms, who, roomId);
                }
                next.breakout = { ...b, rooms, returned: b.returned.filter((u) => !(u in assignments)) };
                return { state: next, breakout: true };
            }
            case 'breakout.autoAssign': {
                if (b.rooms.length === 0)
                    throw new MeetingError('CONFLICT', 'Create rooms first');
                const userIds = Array.isArray(data.userIds)
                    ? [...new Set(data.userIds.filter((u) => typeof u === 'string' && u.length > 0))]
                    : [];
                const rooms = b.rooms.map((r) => ({ ...r, members: [] }));
                userIds.forEach((u, i) => rooms[i % rooms.length].members.push(u));
                next.breakout = { ...b, rooms, returned: [] };
                return { state: next, breakout: true };
            }
            case 'breakout.open':
            case 'breakout.close': {
                if (b.rooms.length === 0)
                    throw new MeetingError('CONFLICT', 'Create rooms first');
                const ids = parseIds(data.roomIds);
                if (verb === 'breakout.close' && !ids) {
                    const graced = this.startClosing(b, data);
                    if (graced) {
                        next.breakout = graced;
                        return { state: next, breakout: true };
                    }
                }
                const target = verb === 'breakout.open' ? 'open' : 'closed';
                const rooms = b.rooms.map((r) => (!ids || ids.has(r.id) ? { ...r, state: target } : r));
                const anyOpen = rooms.some((r) => r.state === 'open');
                next.breakout = {
                    ...b,
                    rooms,
                    phase: anyOpen ? 'open' : 'draft',
                    returned: anyOpen ? b.returned : [],
                    // Opening anything cancels a closing countdown (and the deadline it set).
                    endsAt: anyOpen && !(verb === 'breakout.open' && b.closing) ? b.endsAt : null,
                    // Closing a few rooms by id during the countdown keeps it running.
                    closing: verb === 'breakout.close' && anyOpen ? b.closing === true : false,
                };
                return { state: next, breakout: true };
            }
            case 'breakout.timer': {
                const raw = data.durationMs;
                if (raw === null || raw === undefined) {
                    if (b.endsAt === null)
                        return null;
                    next.breakout = { ...b, endsAt: null, closing: false };
                    return { state: next, breakout: true };
                }
                if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0 || raw > this.maxTimerMs) {
                    throw new MeetingError('INVALID_PAYLOAD', `durationMs must be between 1 and ${this.maxTimerMs}`);
                }
                if (b.phase !== 'open')
                    throw new MeetingError('CONFLICT', 'Open the rooms before starting a timer');
                next.breakout = { ...b, endsAt: new Date(this.now() + raw).toISOString(), closing: false };
                return { state: next, breakout: true };
            }
            case 'breakout.broadcast': {
                const message = typeof data.message === 'string' ? data.message.trim() : '';
                if (!message || message.length > types_1.MAX_ANNOUNCEMENT_LENGTH) {
                    throw new MeetingError('INVALID_PAYLOAD', `message must be 1–${types_1.MAX_ANNOUNCEMENT_LENGTH} characters`);
                }
                const announcement = {
                    message,
                    fromUserId: userId,
                    fromDisplayName: this.displayNameOf(clientId, data),
                    at: this.iso(),
                };
                next.breakout = {
                    ...b,
                    announcement,
                    announcements: [...(b.announcements ?? []), announcement].slice(-types_1.MAX_ANNOUNCEMENT_HISTORY),
                };
                return { state: next, breakout: true, announcement: true };
            }
            case 'breakout.join': {
                const roomId = typeof data.roomId === 'string' ? data.roomId : '';
                const room = b.rooms.find((r) => r.id === roomId);
                if (!room)
                    throw new MeetingError('NOT_FOUND', 'No such room');
                if (b.phase !== 'open' || room.state !== 'open')
                    throw new MeetingError('CONFLICT', 'That room is closed');
                if (b.closing)
                    throw new MeetingError('CONFLICT', 'The rooms are closing');
                const assigned = room.members.includes(userId);
                // Organizers may visit any room.
                if (b.mode === 'assigned' && !assigned && !isOrganizer) {
                    throw new MeetingError('FORBIDDEN', 'You were not assigned to that room');
                }
                if (assigned && !b.returned.includes(userId))
                    return null;
                const rooms = b.rooms.map((r) => ({ ...r, members: [...r.members] }));
                placeUser(rooms, userId, roomId);
                next.breakout = { ...b, rooms, returned: b.returned.filter((u) => u !== userId) };
                return { state: next, breakout: true };
            }
            case 'breakout.leave': {
                if ((0, lobby_1.breakoutRoomFor)(b, userId) === null)
                    return null;
                if (!b.settings.allowReturnToMain && !isOrganizer) {
                    throw new MeetingError('FORBIDDEN', 'The organizer has not allowed returning to the main meeting');
                }
                if (b.mode === 'self-select') {
                    const rooms = b.rooms.map((r) => ({ ...r, members: r.members.filter((u) => u !== userId) }));
                    next.breakout = { ...b, rooms };
                }
                else {
                    next.breakout = { ...b, returned: [...b.returned, userId] };
                }
                return { state: next, breakout: true };
            }
            case 'breakout.end': {
                if (b.phase === 'none')
                    return null;
                const graced = this.startClosing(b, data);
                if (graced) {
                    next.breakout = graced;
                    return { state: next, breakout: true };
                }
                next.breakout = closeAll(b);
                return { state: next, breakout: true };
            }
            default:
                throw new MeetingError('INVALID_ACTION', `Unknown meeting action: ${verb}`);
        }
    }
    async commit(mutation, verb, userId) {
        const { state } = mutation;
        if (!(await this.write(state, state.version - 1)))
            throw new StaleWrite();
        this.mirror.set(state.meetingId, state);
        this.scheduleTimer(state);
        const channel = (0, types_1.meetingChannel)(state.meetingId);
        const ts = this.iso();
        if (mutation.hands) {
            await this.router.sendToChannel(channel, {
                type: 'meeting', action: 'hands.changed', meetingId: state.meetingId,
                data: { version: state.version, hands: state.hands }, timestamp: ts,
            });
        }
        if (mutation.breakout) {
            await this.router.sendToChannel(channel, {
                type: 'meeting', action: 'breakout.changed', meetingId: state.meetingId,
                data: { version: state.version, breakout: state.breakout }, timestamp: ts,
            });
        }
        if (mutation.announcement && state.breakout.announcement) {
            await this.router.sendToChannel(channel, {
                type: 'meeting', action: 'breakout.announcement', meetingId: state.meetingId,
                data: state.breakout.announcement, timestamp: ts,
            });
        }
        if (this.onChange) {
            try {
                this.onChange({ meetingId: state.meetingId, action: verb, userId, state });
            }
            catch (err) {
                this.logger.warn('meeting onChange threw', { error: String(err) });
            }
        }
    }
    /**
     * The closing countdown for a whole-session close, or null to close now:
     * no grace configured, rooms not open, `immediate`, or already closing
     * (a second close means now).
     */
    startClosing(b, data) {
        if (this.closingGraceMs <= 0 || b.phase !== 'open' || b.closing || data.immediate === true)
            return null;
        const graceEnd = this.now() + this.closingGraceMs;
        const current = b.endsAt ? Date.parse(b.endsAt) : Infinity;
        return { ...b, closing: true, endsAt: new Date(Math.min(current, graceEnd)).toISOString() };
    }
    // ── timers ────────────────────────────────────────────────────────────────
    scheduleTimer(state) {
        const existing = this.timers.get(state.meetingId);
        if (existing)
            clearTimeout(existing);
        this.timers.delete(state.meetingId);
        const endsAt = state.breakout.endsAt;
        if (!endsAt || state.breakout.phase !== 'open')
            return;
        const delay = Math.max(0, Date.parse(endsAt) - this.now());
        const t = setTimeout(() => {
            this.timers.delete(state.meetingId);
            void this.expireIfDue(state.meetingId, true).catch((err) => this.logger.warn('meeting timer close failed', { meetingId: state.meetingId, error: String(err) }));
        }, delay);
        t.unref?.();
        this.timers.set(state.meetingId, t);
    }
    /** Close every room when the timer has run out (on the timer, and lazily on any access). */
    async expireIfDue(meetingId, fromTimer = false) {
        await this.serial(meetingId, async () => {
            const state = await this.store.get(meetingId);
            const endsAt = state?.breakout.endsAt;
            if (!state || !endsAt || state.breakout.phase !== 'open')
                return;
            if (Date.parse(endsAt) > this.now() && !fromTimer)
                return;
            if (Date.parse(endsAt) > this.now() + 5) {
                // A timer that fired early (clock skew in tests) reschedules.
                this.scheduleTimer(state);
                return;
            }
            const next = this.bump(state);
            next.breakout = closeAll(state.breakout);
            await this.commit({ state: next, breakout: true }, 'breakout.end', 'system');
        });
    }
    // ── helpers ───────────────────────────────────────────────────────────────
    /**
     * Run `fn` after every earlier write for this meeting in this process. A
     * write another replica beat (StaleWrite) re-runs `fn`, which re-reads the
     * state, so the mutation applies on top of theirs instead of over it.
     */
    serial(meetingId, fn) {
        const prev = this.chains.get(meetingId) ?? Promise.resolve();
        const attempt = async () => {
            for (let n = 1;; n++) {
                try {
                    return await fn();
                }
                catch (err) {
                    if (!(err instanceof StaleWrite))
                        throw err;
                    if (n >= MAX_WRITE_ATTEMPTS)
                        throw new MeetingError('CONFLICT', 'The meeting is changing too fast; try again');
                }
            }
        };
        const run = prev.catch(() => undefined).then(attempt);
        const tail = run.catch(() => undefined);
        this.chains.set(meetingId, tail);
        void tail.then(() => {
            if (this.chains.get(meetingId) === tail)
                this.chains.delete(meetingId);
        });
        return run;
    }
    async organizer(state, userId, clientId) {
        let ok;
        if (this.isOrganizerHook) {
            try {
                ok = (await this.isOrganizerHook({ meetingId: state.meetingId, userId, clientId, state })) === true;
            }
            catch {
                ok = false;
            }
        }
        else {
            ok = state.createdBy !== null && state.createdBy === userId;
        }
        const key = `${state.meetingId}\u0000${userId}`;
        if (this.organizerVerdicts.size > 10_000 && !this.organizerVerdicts.has(key))
            this.organizerVerdicts.clear();
        this.organizerVerdicts.set(key, ok);
        return ok;
    }
    async organizerByUser(state, userId) {
        const clientId = [...this.clients.entries()].find(([, e]) => e.userId === userId)?.[0] ?? '';
        return this.organizer(state, userId, clientId);
    }
    parseRooms(raw, previous) {
        if (!Array.isArray(raw))
            throw new MeetingError('INVALID_PAYLOAD', 'rooms must be an array');
        if (raw.length > this.maxRooms)
            throw new MeetingError('INVALID_PAYLOAD', `At most ${this.maxRooms} rooms`);
        const seen = new Set();
        return raw.map((r, i) => {
            if (!r || typeof r !== 'object' || Array.isArray(r)) {
                throw new MeetingError('INVALID_PAYLOAD', `Room ${i + 1} must be an object`);
            }
            const rec = r;
            if (rec.name !== undefined && rec.name !== null && typeof rec.name !== 'string') {
                throw new MeetingError('INVALID_PAYLOAD', `Room ${i + 1}: name must be a string`);
            }
            if (rec.members !== undefined && (!Array.isArray(rec.members) || rec.members.some((m) => typeof m !== 'string'))) {
                throw new MeetingError('INVALID_PAYLOAD', `Room ${i + 1}: members must be an array of userIds`);
            }
            const name = typeof rec.name === 'string' && rec.name.trim() ? rec.name.trim().slice(0, types_1.MAX_ROOM_NAME_LENGTH) : `Room ${i + 1}`;
            let id = typeof rec.id === 'string' ? rec.id : '';
            if (id && !types_1.BREAKOUT_ROOM_ID_PATTERN.test(id))
                throw new MeetingError('INVALID_PAYLOAD', `Invalid room id: ${id}`);
            if (!id)
                id = this.mintRoomId();
            if (seen.has(id))
                throw new MeetingError('INVALID_PAYLOAD', `Duplicate room id: ${id}`);
            seen.add(id);
            const kept = previous.find((p) => p.id === id);
            const members = Array.isArray(rec.members)
                ? rec.members.filter((m) => typeof m === 'string' && m.length > 0)
                : kept?.members ?? [];
            return { id, name, state: 'closed', members };
        }).map((room, _i, all) => {
            // A user is in at most one room: the first listing wins.
            const earlier = all.slice(0, all.indexOf(room)).flatMap((r) => r.members);
            return { ...room, members: [...new Set(room.members)].filter((m) => !earlier.includes(m)) };
        });
    }
    mintRoomId() {
        this.roomSeq = (this.roomSeq + 1) % 1_000_000;
        return `r${this.now().toString(36)}${this.roomSeq.toString(36)}`;
    }
    /** Compare-and-set when the store offers it, else last-write-wins. */
    async write(state, expectedVersion) {
        if (this.store.putIfVersion)
            return this.store.putIfVersion(state, expectedVersion);
        await this.store.put(state);
        return true;
    }
    /**
     * A state committed by any replica (`store.watch`). Only meetings this
     * process already follows are mirrored, so a busy cluster does not fill
     * every replica with every meeting; an older version never replaces a
     * newer one. Arming the timer here is what keeps a breakout timer alive
     * when the replica that set it goes away.
     */
    onRemoteState(state) {
        const held = this.mirror.get(state.meetingId);
        if (!held || held.version >= state.version)
            return;
        this.mirror.set(state.meetingId, state);
        this.scheduleTimer(state);
    }
    freshState(meetingId, createdBy) {
        return {
            meetingId,
            createdBy,
            version: 1,
            hands: [],
            breakout: (0, types_1.cloneState)(types_1.EMPTY_BREAKOUT),
            updatedAt: this.iso(),
        };
    }
    bump(state) {
        const next = (0, types_1.cloneState)(state);
        next.version += 1;
        next.updatedAt = this.iso();
        return next;
    }
    userIdOf(clientId) {
        const fromRouter = this.router.getUserIdForClient?.(clientId);
        if (fromRouter)
            return fromRouter;
        const ctx = this.router.getClientData?.(clientId)?.userContext;
        return typeof ctx?.userId === 'string' && ctx.userId ? ctx.userId : null;
    }
    /** The auth context's display name; the frame's only when the context has none. */
    displayNameOf(clientId, data) {
        const ctx = this.router.getClientData?.(clientId)?.userContext;
        const fromCtx = typeof ctx?.displayName === 'string' ? ctx.displayName : '';
        const fromFrame = typeof data.displayName === 'string' ? data.displayName : '';
        const name = (fromCtx || fromFrame || this.userIdOf(clientId) || 'Someone').trim();
        return name.slice(0, types_1.MAX_DISPLAY_NAME_LENGTH);
    }
    userHasOtherClient(userId, meetingId, exceptClientId) {
        for (const [cid, e] of this.clients) {
            if (cid !== exceptClientId && e.userId === userId && e.meetings.has(meetingId))
                return true;
        }
        return false;
    }
    async send(clientId, frame) {
        try {
            await this.router.sendToClient(clientId, frame);
        }
        catch (err) {
            this.logger.warn('meeting send failed', { clientId, error: String(err) });
        }
    }
    sendError(clientId, meetingId, requestAction, code, message) {
        void this.send(clientId, {
            type: 'meeting',
            action: 'error',
            meetingId,
            error: { code, message, requestAction },
            timestamp: this.iso(),
        });
    }
    iso() {
        return new Date(this.now()).toISOString();
    }
}
exports.MeetingService = MeetingService;
// ── pure helpers ──────────────────────────────────────────────────────────────
function parseMode(raw) {
    return raw === 'assigned' || raw === 'self-select' ? raw : null;
}
function parseIds(raw) {
    if (!Array.isArray(raw))
        return null;
    return new Set(raw.filter((x) => typeof x === 'string'));
}
/** Shared by the async and sync lobby checks. */
function admitsRoom(state, roomId, userId) {
    if (!state || state.breakout.phase !== 'open')
        return false;
    const room = state.breakout.rooms.find((r) => r.id === roomId);
    if (!room || room.state !== 'open')
        return false;
    if ((0, lobby_1.breakoutRoomFor)(state.breakout, userId) === room.id)
        return true;
    if (state.breakout.mode === 'self-select')
        return true;
    return 'organizer-only';
}
function placeUser(rooms, userId, roomId) {
    for (const r of rooms)
        r.members = r.members.filter((m) => m !== userId);
    if (roomId)
        rooms.find((r) => r.id === roomId)?.members.push(userId);
}
function closeAll(b) {
    return {
        ...b,
        phase: b.rooms.length > 0 ? 'draft' : 'none',
        rooms: b.rooms.map((r) => ({ ...r, state: 'closed' })),
        returned: [],
        endsAt: null,
        closing: false,
    };
}
/** A room name from a client: trimmed, 1–MAX_ROOM_NAME_LENGTH characters, refused otherwise. */
function parseRoomName(raw) {
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (!name || name.length > types_1.MAX_ROOM_NAME_LENGTH) {
        throw new MeetingError('INVALID_PAYLOAD', `name must be 1–${types_1.MAX_ROOM_NAME_LENGTH} characters`);
    }
    return name;
}
/** `Room N` for the first N past the room count that no room is already called. */
function nextRoomName(rooms) {
    const taken = new Set(rooms.map((r) => r.name));
    let n = rooms.length + 1;
    while (taken.has(`Room ${n}`))
        n += 1;
    return `Room ${n}`;
}
//# sourceMappingURL=MeetingService.js.map