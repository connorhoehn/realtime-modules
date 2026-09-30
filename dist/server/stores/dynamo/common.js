"use strict";
// realtime-modules/src/server/stores/dynamo/common.ts
//
// Pieces every DynamoDB chat store shares: the injected client's shape, the
// retention the tables were created with, and the clock.
Object.defineProperty(exports, "__esModule", { value: true });
exports.CHAT_TTL_SECONDS = void 0;
exports.ttlFrom = ttlFrom;
exports.requireClient = requireClient;
exports.requireTable = requireTable;
/**
 * 90 days — the retention realtime-examples' chat tables are written with
 * (`ttl`, epoch seconds, on chat-messages / chat-conversations / chat-reads).
 * Membership has no TTL: it is not a log.
 */
exports.CHAT_TTL_SECONDS = 90 * 24 * 60 * 60;
function ttlFrom(now, ttlSeconds) {
    return String(Math.floor(now() / 1000) + ttlSeconds);
}
function requireClient(name, client) {
    if (!client || typeof client.send !== 'function') {
        throw new Error(`${name}: client is required (an AWS SDK v3 DynamoDBClient or DynamoDBDocumentClient)`);
    }
    return client;
}
function requireTable(name, tableName) {
    if (typeof tableName !== 'string' || !tableName)
        throw new Error(`${name}: tableName is required`);
    return tableName;
}
//# sourceMappingURL=common.js.map