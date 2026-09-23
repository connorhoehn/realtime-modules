import type { PipelineRunTransport } from './usePipelineRunStatus';
import type { CatalogGroupBy, PipelineCatalogDefinition, PipelineCatalogEntry, PipelineCatalogGroup, PipelineDefinitionSummary, PipelineRunRollup } from './catalog';
/** The error a catalog request throws: the server's message with the HTTP status and, for `/generate`, its `detail`. */
export type PipelineCatalogRequestError = Error & {
    status: number;
    code?: string;
    detail?: unknown;
};
/** The list route's answer. `rollup` is absent from a platform that predates it; `normalizeCatalogEntry` fills `null`. */
export interface PipelineCatalogResponse {
    pipelines: Array<PipelineCatalogDefinition & {
        rollup?: PipelineRunRollup | null;
        readOnly?: boolean;
    }>;
}
export declare function normalizeCatalogEntry(raw: PipelineCatalogResponse['pipelines'][number]): PipelineCatalogEntry;
/** `GET {apiBaseUrl}/api/pipelines/defs?include=rollup`, normalised. */
export declare function fetchPipelineCatalog(apiBaseUrl: string, idToken: string | null, init?: {
    signal?: AbortSignal;
}): Promise<PipelineCatalogEntry[]>;
/**
 * What the planner is asked for, as platform-api built it: `draft` writes a
 * draft the caller owns; `run` also publishes it and triggers the first run.
 * (The plan's `action: 'draft' | 'draft-and-run'` is accepted by the route as
 * an alias; this client sends `mode`.)
 */
export type GeneratePipelineMode = 'draft' | 'run';
export interface GeneratePipelineDraftInput {
    /** The `/agent` text, verbatim — `[200k]` / `--model` in it mean what they mean in chat. */
    instruction: string;
    mode: GeneratePipelineMode;
    hints?: string[];
    model?: string;
    contextBudgetTokens?: number;
    /**
     * The idempotency key for this click. Sent as the `Idempotency-Key` header
     * and in the body; a retry with the same key is one planner call, not two.
     * Generated (`newPipelineDraftRequestId`) when absent.
     */
    requestId?: string;
}
export interface GeneratePipelineDraftResponse {
    pipeline: PipelineCatalogDefinition;
    /** Set for `mode: 'run'` when the first run was triggered. */
    runId?: string;
    /** For `mode: 'run'`: the draft was saved and published but the run could not be started — the reason. */
    runError?: string;
    planner: {
        source: 'model' | 'fallback';
        steps: number;
    };
    /** Echo of the key the request carried. */
    requestId: string;
}
/** A fresh idempotency key: a UUID where the runtime has one, else a time-and-random id of the same shape. */
export declare function newPipelineDraftRequestId(): string;
/**
 * `POST {apiBaseUrl}/api/pipelines/defs/generate` — the `/agent` planner on the
 * page. Same shape as `requestPipelineRun`; throws a `PipelineCatalogRequestError`
 * whose `code` is `invalid_instruction` on a 422, `invalid_body` on a 400, and
 * `idempotency_in_progress` on a 409 (the same key is already being planned).
 */
export declare function generatePipelineDraft(apiBaseUrl: string, idToken: string | null, input: GeneratePipelineDraftInput): Promise<GeneratePipelineDraftResponse>;
export interface UsePipelineCatalogOptions {
    /** platform-api origin, e.g. `http://localhost:3001`. */
    apiBaseUrl: string;
    /** Bearer for the list read; `null` leaves the catalog empty (frames still flow once it loads). */
    idToken: string | null;
    /** A host-owned socket. Omit to use the nearest GatewaySocketProvider; `null` disables live frames. */
    transport?: PipelineRunTransport | null;
    /**
     * The host socket's session epoch (`useWebSocket().sessionEpoch`), for a
     * host-owned transport: each increment after the first resubscribes and
     * refreshes once. Read from the gateway context when `transport` is omitted.
     */
    sessionEpoch?: number;
    /** `false` mounts nothing — no read, no subscription. Default true. */
    enabled?: boolean;
}
export interface UsePipelineCatalogResult {
    /** The definitions with their rollups, in the order the platform returned them. */
    entries: readonly PipelineCatalogEntry[];
    /** `entries` flattened for rows. */
    summaries: readonly PipelineDefinitionSummary[];
    /** Grouped and ordered for the page; `by` defaults to work type. */
    groups: (by?: CatalogGroupBy) => PipelineCatalogGroup[];
    /** True until the first read settles (and again during `refresh()` only while nothing is loaded). */
    loading: boolean;
    error?: string;
    /** Re-read the list. Also what a reconnect does, once. */
    refresh: () => void;
}
/** Subscribe / unsubscribe frames for the firehose, as the gateway's pipeline service expects them. */
export declare const PIPELINE_ALL_CHANNEL = "pipeline:all";
/** The firehose's subscribe / unsubscribe frames. */
export declare function pipelineAllSubscribeFrames(): {
    subscribe: Record<string, unknown>;
    unsubscribe: Record<string, unknown>;
};
export declare function usePipelineCatalog(opts: UsePipelineCatalogOptions): UsePipelineCatalogResult;
//# sourceMappingURL=usePipelineCatalog.d.ts.map