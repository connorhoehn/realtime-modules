import { type MeetingState } from './types';
import type { MeetingStateStore } from './MeetingStateStore';
export interface MeetingStateRedis {
    get(key: string): Promise<string | null>;
    del(...keys: string[]): Promise<unknown>;
    sendCommand?(args: string[]): Promise<unknown>;
    call?(command: string, ...args: (string | number)[]): Promise<unknown>;
    eval?(script: string, ...args: unknown[]): Promise<unknown>;
    command?(command: string, ...args: (string | number)[]): Promise<unknown>;
}
export interface MeetingStateSubscriber {
    subscribe(channel: string, listener: (message: string) => void): unknown;
    unsubscribe?(channel: string): unknown;
}
export interface RedisMeetingStateStoreOptions {
    /** Key and channel prefix. Default `meeting:`. */
    prefix?: string;
    /** Expiry refreshed on every write. Default 24 h. */
    ttlSeconds?: number;
    /** A dedicated pub/sub connection; without it `watch` is not offered. */
    subscriber?: MeetingStateSubscriber;
}
export declare const MEETING_CAS_SCRIPT = "-- meeting-state-cas-v1\nlocal cur = redis.call('GET', KEYS[1])\nlocal v = 0\nif cur then\n  local ok, d = pcall(cjson.decode, cur)\n  if ok and type(d) == 'table' then v = tonumber(d.version) or 0 end\nend\nif v ~= tonumber(ARGV[2]) then return 0 end\nredis.call('SET', KEYS[1], ARGV[1], 'EX', tonumber(ARGV[3]))\nif ARGV[4] ~= '' then redis.call('PUBLISH', ARGV[4], ARGV[1]) end\nreturn 1";
export declare class RedisMeetingStateStore implements MeetingStateStore {
    private readonly redis;
    readonly shared = true;
    private readonly prefix;
    private readonly ttlSeconds;
    private readonly subscriber;
    private readonly watchers;
    private subscribed;
    constructor(redis: MeetingStateRedis, opts?: RedisMeetingStateStoreOptions);
    /** The key a meeting's state lives under. */
    key(meetingId: string): string;
    /** The channel committed states are published on. */
    get channel(): string;
    get(meetingId: string): Promise<MeetingState | null>;
    /** Unconditional write (single-process callers). The service uses `putIfVersion`. */
    put(state: MeetingState): Promise<void>;
    putIfVersion(state: MeetingState, expectedVersion: number): Promise<boolean>;
    delete(meetingId: string): Promise<void>;
    /** Without a `subscriber` there is nothing to listen on: a no-op. */
    watch(onState: (state: MeetingState) => void): () => void;
    private script;
}
//# sourceMappingURL=RedisMeetingStateStore.d.ts.map