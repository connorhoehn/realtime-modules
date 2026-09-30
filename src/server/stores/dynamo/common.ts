// realtime-modules/src/server/stores/dynamo/common.ts
//
// Pieces every DynamoDB chat store shares: the injected client's shape, the
// retention the tables were created with, and the clock.

/**
 * Any AWS SDK v3 DynamoDB client — a `DynamoDBClient` from
 * `@aws-sdk/client-dynamodb` or a `DynamoDBDocumentClient` from
 * `@aws-sdk/lib-dynamodb` (it shares the wrapped client's middleware stack,
 * so the low-level commands these stores send pass through it unchanged).
 * The stores only ever call `send`.
 */
export interface DynamoCommandClient {
    send(command: any): Promise<any>;
}

/** Optional logger. Only `warn`/`error` are used, both optional. */
export interface DynamoStoreLogger {
    warn?: (...args: any[]) => void;
    error?: (...args: any[]) => void;
    info?: (...args: any[]) => void;
}

/**
 * 90 days — the retention realtime-examples' chat tables are written with
 * (`ttl`, epoch seconds, on chat-messages / chat-conversations / chat-reads).
 * Membership has no TTL: it is not a log.
 */
export const CHAT_TTL_SECONDS = 90 * 24 * 60 * 60;

export interface DynamoStoreClockOpts {
    /** Seconds from write time to the `ttl` attribute. Default {@link CHAT_TTL_SECONDS}. */
    ttlSeconds?: number;
    /** Epoch-ms clock, for tests. Default `Date.now`. */
    now?: () => number;
}

export function ttlFrom(now: () => number, ttlSeconds: number): string {
    return String(Math.floor(now() / 1000) + ttlSeconds);
}

export function requireClient(name: string, client: unknown): DynamoCommandClient {
    if (!client || typeof (client as DynamoCommandClient).send !== 'function') {
        throw new Error(`${name}: client is required (an AWS SDK v3 DynamoDBClient or DynamoDBDocumentClient)`);
    }
    return client as DynamoCommandClient;
}

export function requireTable(name: string, tableName: unknown): string {
    if (typeof tableName !== 'string' || !tableName) throw new Error(`${name}: tableName is required`);
    return tableName;
}
