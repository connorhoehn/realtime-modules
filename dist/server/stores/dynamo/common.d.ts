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
export declare const CHAT_TTL_SECONDS: number;
export interface DynamoStoreClockOpts {
    /** Seconds from write time to the `ttl` attribute. Default {@link CHAT_TTL_SECONDS}. */
    ttlSeconds?: number;
    /** Epoch-ms clock, for tests. Default `Date.now`. */
    now?: () => number;
}
export declare function ttlFrom(now: () => number, ttlSeconds: number): string;
export declare function requireClient(name: string, client: unknown): DynamoCommandClient;
export declare function requireTable(name: string, tableName: unknown): string;
//# sourceMappingURL=common.d.ts.map