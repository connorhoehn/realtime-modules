import type { ActivityEvent } from './types';
export interface UseActivityReturn {
    events: ActivityEvent[];
    loadHistory: (limit?: number) => void;
    /**
     * Record an activity event.
     *
     * The server stamps `timestamp`, `userId` and `displayName` from the
     * connection's own auth context, so a client cannot publish as somebody
     * else — you supply the type and the detail, and nothing more.
     *
     * The event comes back through the normal broadcast (the publisher is not
     * excluded from it), so `events` updates from the server's copy rather than
     * an optimistic one, and what you see is what everyone else sees.
     *
     * Remember this feed is global: what you publish here reaches every
     * subscriber on every channel, not just this hook's.
     */
    publish: (eventType: string, detail?: Record<string, unknown>) => void;
}
export declare function useActivity(channel: string): UseActivityReturn;
//# sourceMappingURL=useActivity.d.ts.map