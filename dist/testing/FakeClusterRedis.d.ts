import type { RawRedisConnection } from 'distributed-core/cluster/leases';
import type { RealtimeClusterRedis } from '../server/RedisRealtimeRouter';
export declare const isRenew: (args: string[]) => boolean;
export declare const isAcquire: (args: string[]) => boolean;
export declare const isRegister: (args: string[]) => boolean;
export declare class FakeClusterRedis {
    private readonly data;
    private readonly topics;
    private readonly holds;
    readonly sent: string[][];
    private live;
    get(key: string): string | null;
    members(key: string): string[];
    pttl(key: string): number;
    del(key: string): void;
    private set;
    private pexpire;
    private sadd;
    private srem;
    /** Hold the reply of the next command matching `match` (the write commits first). */
    hold(match: (args: string[]) => boolean): {
        reached: Promise<void>;
        release: () => void;
    };
    command(...args: string[]): Promise<unknown>;
    private run;
    private eval;
    publish(topic: string, payload: string): Promise<number>;
    subscribeRaw(topic: string, receive: (payload: string) => void): () => void;
    subscribers(topic: string): number;
    /** A RealtimeClusterRedis port with a fireable connection-loss signal. */
    port(): RealtimeClusterRedis & {
        lose(): void;
        handlers(): number;
    };
    /** node-redis-shaped connections for distributed-core's BoundedRedis. `stall` holds replies on that role. */
    rawConnection(stall: {
        command?: (args: string[]) => boolean;
        publish?: boolean;
    }): RawRedisConnection & {
        destroyed: boolean;
    };
}
//# sourceMappingURL=FakeClusterRedis.d.ts.map