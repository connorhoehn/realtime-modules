import type { PipelineRunTransport } from '../pipelines/usePipelineRunStatus';
export interface DocumentsLiveOptions {
    /** platform-api origin, e.g. `http://localhost:3001`. */
    apiBaseUrl: string;
    /** Bearer for the REST reads and writes; `null` leaves the hook idle. */
    idToken: string | null;
    /** A host-owned socket. Omit to use the nearest GatewaySocketProvider; `null` disables live frames. */
    transport?: PipelineRunTransport | null;
    /** The host socket's session epoch, for a host-owned transport. Read from the gateway context otherwise. */
    sessionEpoch?: number;
    /** `false` mounts nothing — no read, no subscription. Default true. */
    enabled?: boolean;
}
export interface ResolvedTransport {
    send?: PipelineRunTransport['send'];
    onMessage?: PipelineRunTransport['onMessage'];
    epoch?: number;
}
export declare function useResolvedTransport(transport: PipelineRunTransport | null | undefined, sessionEpoch?: number): ResolvedTransport;
/** Calls `refresh` once per session epoch after the first one seen (a reconnect). */
export declare function useRefreshOnReconnect(epoch: number | undefined, refresh: () => void): void;
//# sourceMappingURL=transport.d.ts.map