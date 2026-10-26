"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HangoutPlanValidationError = exports.HANGOUT_PLAN_LIMITS = void 0;
exports.parseHangoutPlanInput = parseHangoutPlanInput;
exports.HANGOUT_PLAN_LIMITS = Object.freeze({ rooms: 50, assignments: 500, roomId: 64, name: 80, memberId: 128 });
class HangoutPlanValidationError extends Error {
    constructor(message) { super(message); this.name = 'HangoutPlanValidationError'; }
}
exports.HangoutPlanValidationError = HangoutPlanValidationError;
/** Structural validation only: no clock, identity provider, network or framework. */
function parseHangoutPlanInput(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input))
        throw new HangoutPlanValidationError('plan must be an object');
    const raw = input;
    if (!Number.isSafeInteger(raw.expectedVersion) || Number(raw.expectedVersion) < 0
        || !Number.isSafeInteger(Number(raw.expectedVersion) + 1)) {
        throw new HangoutPlanValidationError('plan.expectedVersion must be a non-negative safe integer with room for the next version');
    }
    if (raw.mode !== 'assigned' && raw.mode !== 'self-select')
        throw new HangoutPlanValidationError('plan.mode must be assigned or self-select');
    if (typeof raw.allowReturnToMain !== 'boolean')
        throw new HangoutPlanValidationError('plan.allowReturnToMain must be a boolean');
    if (!Array.isArray(raw.rooms) || raw.rooms.length > exports.HANGOUT_PLAN_LIMITS.rooms)
        throw new HangoutPlanValidationError('A saved layout supports up to 50 rooms');
    const ids = new Set(), members = new Set();
    const rooms = [];
    // for..of also checks sparse array entries rather than letting map skip them.
    for (const value of raw.rooms) {
        if (!value || typeof value !== 'object' || Array.isArray(value))
            throw new HangoutPlanValidationError('Invalid room');
        const room = value;
        if (typeof room.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(room.id)
            || room.id.length > exports.HANGOUT_PLAN_LIMITS.roomId || ids.has(room.id))
            throw new HangoutPlanValidationError('Room ids must be unique');
        if (typeof room.name !== 'string' || !room.name.trim() || room.name.trim().length > exports.HANGOUT_PLAN_LIMITS.name)
            throw new HangoutPlanValidationError('Room names must be 1–80 characters');
        if (!Array.isArray(room.members))
            throw new HangoutPlanValidationError('Room members must be an array');
        ids.add(room.id);
        const assigned = [];
        for (const id of room.members) {
            if (typeof id !== 'string' || !/^[A-Za-z0-9:_@.+-]+$/.test(id)
                || id.length > exports.HANGOUT_PLAN_LIMITS.memberId || members.has(id))
                throw new HangoutPlanValidationError('Each person can be assigned to one saved room');
            members.add(id);
            if (members.size > exports.HANGOUT_PLAN_LIMITS.assignments)
                throw new HangoutPlanValidationError('A layout supports up to 500 assignments');
            assigned.push(id);
        }
        rooms.push({ id: room.id, name: room.name.trim(), members: assigned });
    }
    return { expectedVersion: Number(raw.expectedVersion), mode: raw.mode, allowReturnToMain: raw.allowReturnToMain, rooms };
}
//# sourceMappingURL=plan.js.map