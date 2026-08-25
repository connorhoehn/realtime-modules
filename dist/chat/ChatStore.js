"use strict";
// realtime-modules/src/chat/ChatStore.ts
//
// Persistence contract for the chat feature, lifted from gateway's
// chat-service.ts on a conservative basis.
//
// Cut 2 (chat extraction) — see realtime-modules/src/server/stores/ for
// the sibling SnapshotStore / MetadataStore / HotCache pattern this file
// mirrors:
//
//   - Same options-bag-vs-positional ctor convention,
//   - Same "interface here, concrete adapter stays in gateway" split,
//   - Same `InMemory*` fallback so the lifted module is usable in tests
//     and zero-config consumers (no DDB-local required).
//
// Field-shape notes (load-bearing for the gateway adapter):
//
//   - The gateway DDB table uses `channelId` (S) as the partition key and
//     `messageId` (S) as the sort key, with `clientId`, `message`,
//     `timestamp` (ISO string), `metadata` (JSON string), and `ttl` (N,
//     epoch-seconds, +90d). The store contract preserves channel +
//     messageId as the addressing pair; TTL semantics are an adapter
//     concern (InMemoryChatStore keeps everything for the process
//     lifetime). v0.23.0 adds optional `userId` (authenticated sender
//     subject) to the message envelope — adapters must round-trip it
//     verbatim when present (InMemoryChatStore's whole-object clone does).
//
//   - `listMessages` returns chronological order (oldest first), matching
//     `ChatService.getChannelHistory`'s post-`.reverse()` shape. The DDB
//     adapter does `ScanIndexForward: false` + reverse; the in-memory
//     adapter appends to an array and slices.
Object.defineProperty(exports, "__esModule", { value: true });
exports.InMemoryChatStore = void 0;
/**
 * Zero-config in-memory implementation. Intended for:
 *
 *   - unit tests (no DDB-local needed),
 *   - dev mode when shared backing services are off,
 *   - zero-config consumers (embedded use) that don't want AWS.
 *
 * Implementation notes:
 *
 *   - Per-channel arrays kept in insertion (chronological) order. The
 *     gateway's LRU cache inside ChatService still bounds the working set
 *     in front of this store, so unbounded growth here is not a hot path
 *     concern for the tests / dev flows this targets.
 *   - Shallow-clones on put/get so caller mutations don't leak into
 *     storage and vice versa — matches the defensive-copy convention used
 *     in MemorySnapshotStore.
 */
class InMemoryChatStore {
    messages = new Map();
    async putMessage(message) {
        const bucket = this.messages.get(message.channel) ?? [];
        // Shallow clone so caller mutations don't leak into storage.
        bucket.push({ ...message, metadata: message.metadata ? { ...message.metadata } : undefined });
        this.messages.set(message.channel, bucket);
    }
    async listMessages(channel, limit) {
        const bucket = this.messages.get(channel);
        if (!bucket || bucket.length === 0)
            return [];
        const cap = Math.max(0, limit);
        const tail = bucket.slice(-cap);
        return tail.map((m) => ({ ...m, metadata: m.metadata ? { ...m.metadata } : undefined }));
    }
    /** Test helper — clears every channel. Not part of ChatStore. */
    _reset() {
        this.messages.clear();
    }
}
exports.InMemoryChatStore = InMemoryChatStore;
//# sourceMappingURL=ChatStore.js.map