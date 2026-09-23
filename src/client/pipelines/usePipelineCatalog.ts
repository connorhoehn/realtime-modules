// realtime-modules/src/client/pipelines/usePipelineCatalog.ts
//
// The pipelines directory, read through one hook: the definitions with their
// last-run rollups from platform-api (`GET /api/pipelines/defs?include=rollup`),
// kept current by the run lifecycle frames the gateway already fans out on
// `pipeline:all`. No polling: a `pipeline.run.completed` frame updates the
// row's rollup in place with the same merge rule the platform applies
// (`applyRunEvent`), so the two converge without a refetch.
//
// The transport is the seam `usePipelineRunStatus` uses — `{ send, onMessage }`
// — so a host that owns its socket hands in its `useWebSocket` handle; an
// rm-native host under GatewaySocketProvider passes nothing. A reconnect is a
// NEW server-side connection that has subscribed to nothing and may have
// missed frames: on every session epoch after the first, the hook resubscribes
// and refreshes once.
//
// The REST helpers are pure (no React) so scripts and SSR can read the
// catalog and generate a draft with the same code the page uses.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useGatewayOptional } from '../GatewaySocketProvider';
import type { PipelineRunTransport } from './usePipelineRunStatus';
import { acquireChannelSubscription } from '../documents/work';
import {
  groupCatalog,
  mergeRunEvent,
  runEventFromFrame,
  summarizeAll,
} from './catalog';
import type {
  CatalogGroupBy,
  PipelineCatalogDefinition,
  PipelineCatalogEntry,
  PipelineCatalogGroup,
  PipelineDefinitionSummary,
  PipelineRunRollup,
} from './catalog';

// ---------------------------------------------------------------------------
// REST helpers (pure — no React)
// ---------------------------------------------------------------------------

/** The error a catalog request throws: the server's message with the HTTP status and, for `/generate`, its `detail`. */
export type PipelineCatalogRequestError = Error & { status: number; code?: string; detail?: unknown };

async function errorFrom(res: Response, fallback: string): Promise<PipelineCatalogRequestError> {
  const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string; detail?: unknown };
  const message = body.message || (typeof body.detail === 'string' ? body.detail : undefined) || body.error || `${fallback} (${res.status})`;
  return Object.assign(new Error(message), {
    status: res.status,
    ...(body.error ? { code: body.error } : {}),
    ...(body.detail !== undefined ? { detail: body.detail } : {}),
  });
}

function authHeaders(idToken: string | null): Record<string, string> {
  return idToken ? { Authorization: `Bearer ${idToken}` } : {};
}

/** The list route's answer. `rollup` is absent from a platform that predates it; `normalizeCatalogEntry` fills `null`. */
export interface PipelineCatalogResponse {
  pipelines: Array<PipelineCatalogDefinition & { rollup?: PipelineRunRollup | null; readOnly?: boolean }>;
}

export function normalizeCatalogEntry(raw: PipelineCatalogResponse['pipelines'][number]): PipelineCatalogEntry {
  const rollup = raw.rollup && typeof raw.rollup === 'object' ? raw.rollup : null;
  return { ...raw, rollup, ...(raw.readOnly === true ? { readOnly: true } : {}) };
}

/** `GET {apiBaseUrl}/api/pipelines/defs?include=rollup`, normalised. */
export async function fetchPipelineCatalog(
  apiBaseUrl: string,
  idToken: string | null,
  init?: { signal?: AbortSignal },
): Promise<PipelineCatalogEntry[]> {
  const res = await fetch(`${apiBaseUrl}/api/pipelines/defs?include=rollup`, {
    headers: authHeaders(idToken),
    ...(init?.signal ? { signal: init.signal } : {}),
  });
  if (!res.ok) throw await errorFrom(res, 'Could not read the pipelines');
  const body = (await res.json()) as Partial<PipelineCatalogResponse>;
  const list = Array.isArray(body.pipelines) ? body.pipelines : [];
  return list.filter((p) => p && typeof p === 'object' && typeof p.id === 'string').map(normalizeCatalogEntry);
}

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
  planner: { source: 'model' | 'fallback'; steps: number };
  /** Echo of the key the request carried. */
  requestId: string;
}

/** A fresh idempotency key: a UUID where the runtime has one, else a time-and-random id of the same shape. */
export function newPipelineDraftRequestId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const hex = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  return `${hex()}${hex()}-${hex()}-4${hex().slice(1)}-${hex()}-${hex()}${hex()}${hex()}`;
}

/**
 * `POST {apiBaseUrl}/api/pipelines/defs/generate` — the `/agent` planner on the
 * page. Same shape as `requestPipelineRun`; throws a `PipelineCatalogRequestError`
 * whose `code` is `invalid_instruction` on a 422, `invalid_body` on a 400, and
 * `idempotency_in_progress` on a 409 (the same key is already being planned).
 */
export async function generatePipelineDraft(
  apiBaseUrl: string,
  idToken: string | null,
  input: GeneratePipelineDraftInput,
): Promise<GeneratePipelineDraftResponse> {
  const requestId = input.requestId || newPipelineDraftRequestId();
  const body = { ...input, requestId };
  const res = await fetch(`${apiBaseUrl}/api/pipelines/defs/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': requestId, ...authHeaders(idToken) },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await errorFrom(res, 'Could not plan the pipeline');
  const json = (await res.json()) as Omit<GeneratePipelineDraftResponse, 'requestId'> & { requestId?: string };
  return { ...json, requestId: json.requestId || requestId };
}

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

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
export const PIPELINE_ALL_CHANNEL = 'pipeline:all';

/** The firehose's subscribe / unsubscribe frames. */
export function pipelineAllSubscribeFrames(): { subscribe: Record<string, unknown>; unsubscribe: Record<string, unknown> } {
  return {
    subscribe: { service: 'pipeline', action: 'subscribe', channel: PIPELINE_ALL_CHANNEL },
    unsubscribe: { service: 'pipeline', action: 'unsubscribe', channel: PIPELINE_ALL_CHANNEL },
  };
}

export function usePipelineCatalog(opts: UsePipelineCatalogOptions): UsePipelineCatalogResult {
  const { apiBaseUrl, idToken, transport } = opts;
  const enabled = opts.enabled !== false;

  // Hooks cannot be conditional, so the context is always read; it is only
  // USED when the host handed in no transport of its own.
  const gateway = useGatewayOptional();
  const send: PipelineRunTransport['send'] | undefined =
    transport === null ? undefined : transport ? transport.send : gateway?.sendMessage as PipelineRunTransport['send'] | undefined;
  const onMessage: PipelineRunTransport['onMessage'] | undefined =
    transport === null ? undefined : transport ? transport.onMessage : gateway?.onMessage as PipelineRunTransport['onMessage'] | undefined;
  const epoch = opts.sessionEpoch ?? (transport === undefined ? gateway?.sessionEpoch : undefined);

  const [entries, setEntries] = useState<readonly PipelineCatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [tick, setTick] = useState(0);
  const alive = useRef(true);
  const loaded = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  // The durable read — on mount, on every refresh.
  useEffect(() => {
    if (!enabled) { setLoading(false); return; }
    if (!idToken) { setLoading(false); return; }
    let cancelled = false;
    if (!loaded.current) setLoading(true);
    void (async () => {
      try {
        const list = await fetchPipelineCatalog(apiBaseUrl, idToken);
        if (cancelled || !alive.current) return;
        loaded.current = true;
        setEntries(list);
        setError(undefined);
      } catch (err) {
        if (cancelled || !alive.current) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled && alive.current) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [enabled, apiBaseUrl, idToken, tick]);

  // Live: the firehose. Resubscribed on every session epoch — a reconnect is a
  // new connection that has subscribed to nothing.
  useEffect(() => {
    if (!enabled || !send || !onMessage) return;
    // Refcounted: the Work list (`useWorkList`) and the estimate hook listen to
    // the same firehose on the same socket, and the first to unmount must not
    // unsubscribe the others.
    const frames = pipelineAllSubscribeFrames();
    const release = acquireChannelSubscription(send, PIPELINE_ALL_CHANNEL, frames.subscribe, frames.unsubscribe, epoch);
    const unregister = onMessage((frame: unknown) => {
      const event = runEventFromFrame(frame);
      if (!event) return;
      setEntries((prev) => mergeRunEvent(prev, event));
    });
    return () => {
      unregister();
      release();
    };
  }, [enabled, send, onMessage, epoch]);

  // A reconnect may have dropped frames: one refresh per new epoch after the first.
  const seenEpoch = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (epoch === undefined) return;
    if (seenEpoch.current === undefined) { seenEpoch.current = epoch; return; }
    if (epoch === seenEpoch.current) return;
    seenEpoch.current = epoch;
    if (loaded.current) refresh();
  }, [epoch, refresh]);

  const summaries = useMemo(() => summarizeAll(entries), [entries]);
  const groups = useCallback((by: CatalogGroupBy = 'workType') => groupCatalog(summaries, by), [summaries]);

  return { entries, summaries, groups, loading, error, refresh };
}
