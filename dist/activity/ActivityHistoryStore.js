"use strict";
// realtime-modules/src/activity/ActivityHistoryStore.ts
//
// Persistence contract for the activity feature, lifted from gateway's
// activity-service.ts on a conservative basis (Wave 2 — activity
// extraction). Mirrors the ChatStore split established by Cut 2:
//
//   - Interface here, concrete adapter (Redis-backed in gateway) stays
//     in the gateway wiring layer,
//   - `InMemoryActivityHistoryStore` fallback so the lifted module is
//     usable in tests / zero-config consumers (no Redis required).
//
// Shape notes (load-bearing for the gateway Redis adapter):
//   - Storage key is `activity:history:<channelId>`. The gateway adapter
//     uses LPUSH + LTRIM + EXPIRE; this contract doesn't dictate
//     transport, only the read/write surface.
//   - `list` returns newest-first to match Redis LRANGE 0..N-1 semantics
//     against an LPUSH'd list. Both the in-memory + Redis adapters honour
//     this order.
//   - All methods are best-effort: implementations should swallow
//     transport failures and surface them via logger only — never throw
//     into the WS handler.
Object.defineProperty(exports, "__esModule", { value: true });
exports.InMemoryActivityHistoryStore = void 0;
/**
 * Zero-config in-memory implementation. Intended for unit tests, dev mode
 * with backing services off, and embedded consumers that don't want
 * Redis. Per-channel arrays kept in insertion (newest-first) order, hard-
 * capped by the per-store `maxItems` cap (defaults to 200, matching the
 * gateway constant).
 */
class InMemoryActivityHistoryStore {
    entries = new Map();
    maxItems;
    constructor(maxItems = 200) {
        this.maxItems = Math.max(1, maxItems);
    }
    async append(channelId, event) {
        const bucket = this.entries.get(channelId) ?? [];
        // Newest-first (matches LPUSH semantics in the gateway adapter).
        bucket.unshift({ ...event, detail: event.detail ? { ...event.detail } : {} });
        if (bucket.length > this.maxItems) {
            bucket.length = this.maxItems;
        }
        this.entries.set(channelId, bucket);
    }
    async list(channelId, limit) {
        const bucket = this.entries.get(channelId);
        if (!bucket || bucket.length === 0)
            return [];
        const cap = Math.max(0, limit);
        const head = bucket.slice(0, cap);
        return head.map((e) => ({ ...e, detail: e.detail ? { ...e.detail } : {} }));
    }
    /** Test helper — clears every channel. Not part of ActivityHistoryStore. */
    _reset() {
        this.entries.clear();
    }
}
exports.InMemoryActivityHistoryStore = InMemoryActivityHistoryStore;
//# sourceMappingURL=ActivityHistoryStore.js.map