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
class MeetingService {
    router;
    logger;
    store;
    isOrganizerHook;
    maxRooms;
    maxTimerMs;
    now;
    onChange;
    clients = new Map();
    chains = new Map();
    timers = new Map();
    roomSeq = 0;
    /** Last state this process read or wrote per meeting, for the synchronous lobby check. */
    mirror = new Map();
    /** Last organizer verdict per `meetingId\u0000userId`, for the synchronous lobby check. */
    organizerVerdicts = new Map();
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
        this.now = config.now ?? Date.now;
        this.onChange = config.onChange ?? null;
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
        if (!entry || !entry.userId)
            return;
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
     * has not seen refuses; an organizer is recognised once the service has
     * resolved them (any subscribe or write of theirs).
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
        return this.organizerVerdicts.get(`${parsed.meetingId}\u0000${userId}`) === true;
    }
    /** Stop every breakout timer (tests, shutdown). */
    dispose() {
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
            if (!existing)
                await this.store.put(state);
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
                    announcement: null,
                    settings: { allowReturnToMain },
                };
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
                const target = verb === 'breakout.open' ? 'open' : 'closed';
                const rooms = b.rooms.map((r) => (!ids || ids.has(r.id) ? { ...r, state: target } : r));
                const anyOpen = rooms.some((r) => r.state === 'open');
                next.breakout = {
                    ...b,
                    rooms,
                    phase: anyOpen ? 'open' : 'draft',
                    returned: anyOpen ? b.returned : [],
                    endsAt: anyOpen ? b.endsAt : null,
                };
                return { state: next, breakout: true };
            }
            case 'breakout.timer': {
                const raw = data.durationMs;
                if (raw === null || raw === undefined) {
                    if (b.endsAt === null)
                        return null;
                    next.breakout = { ...b, endsAt: null };
                    return { state: next, breakout: true };
                }
                if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0 || raw > this.maxTimerMs) {
                    throw new MeetingError('INVALID_PAYLOAD', `durationMs must be between 1 and ${this.maxTimerMs}`);
                }
                if (b.phase !== 'open')
                    throw new MeetingError('CONFLICT', 'Open the rooms before starting a timer');
                next.breakout = { ...b, endsAt: new Date(this.now() + raw).toISOString() };
                return { state: next, breakout: true };
            }
            case 'breakout.broadcast': {
                const message = typeof data.message === 'string' ? data.message.trim() : '';
                if (!message || message.length > types_1.MAX_ANNOUNCEMENT_LENGTH) {
                    throw new MeetingError('INVALID_PAYLOAD', `message must be 1–${types_1.MAX_ANNOUNCEMENT_LENGTH} characters`);
                }
                next.breakout = {
                    ...b,
                    announcement: {
                        message,
                        fromUserId: userId,
                        fromDisplayName: this.displayNameOf(clientId, data),
                        at: this.iso(),
                    },
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
                next.breakout = closeAll(b);
                return { state: next, breakout: true };
            }
            default:
                throw new MeetingError('INVALID_ACTION', `Unknown meeting action: ${verb}`);
        }
    }
    async commit(mutation, verb, userId) {
        const { state } = mutation;
        await this.store.put(state);
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
    serial(meetingId, fn) {
        const prev = this.chains.get(meetingId) ?? Promise.resolve();
        const run = prev.catch(() => undefined).then(fn);
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
            const rec = (r && typeof r === 'object' ? r : {});
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
    };
}
//# sourceMappingURL=MeetingService.js.map