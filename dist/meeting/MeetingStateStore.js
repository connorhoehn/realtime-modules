"use strict";
// realtime-modules/src/meeting/MeetingStateStore.ts
//
// Where a meeting's coordination state lives. Async so a shared store
// (Redis, DynamoDB) drops in for a multi-replica gateway. The service
// serialises writes per meeting within a process; across processes a shared
// store provides `putIfVersion`, and the service re-reads and re-applies a
// mutation whose write lost the race (0.125.0).
Object.defineProperty(exports, "__esModule", { value: true });
exports.InMemoryMeetingStateStore = void 0;
const types_1 = require("./types");
class InMemoryMeetingStateStore {
    states = new Map();
    async get(meetingId) {
        const s = this.states.get(meetingId);
        return s ? (0, types_1.cloneState)(s) : null;
    }
    async put(state) {
        this.states.set(state.meetingId, (0, types_1.cloneState)(state));
    }
    async putIfVersion(state, expectedVersion) {
        const current = this.states.get(state.meetingId)?.version ?? 0;
        if (current !== expectedVersion)
            return false;
        this.states.set(state.meetingId, (0, types_1.cloneState)(state));
        return true;
    }
    async delete(meetingId) {
        this.states.delete(meetingId);
    }
    /** Test/inspection helper. */
    get size() {
        return this.states.size;
    }
}
exports.InMemoryMeetingStateStore = InMemoryMeetingStateStore;
//# sourceMappingURL=MeetingStateStore.js.map