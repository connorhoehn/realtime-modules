"use strict";
// realtime-modules/src/meeting/MeetingStateStore.ts
//
// Where a meeting's coordination state lives. Async so a shared store
// (Redis, DynamoDB) drops in for a multi-replica gateway; the service
// serialises writes per meeting within a process, and a shared store must
// provide its own cross-process ordering (compare `version`).
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