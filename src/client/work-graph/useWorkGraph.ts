import { useCallback, useEffect, useRef, useState } from 'react';

import type { WorkGraphDeltaBatch, WorkGraphSnapshot, WorkGraphStreamMessage } from '../../work-graph/contracts';
import type { WorkGraphSnapshotV2 } from '../../work-graph/contractsV2';
import { validateWorkGraphDeltaBatch, validateWorkGraphSnapshot } from '../../work-graph/validation';
import { validateWorkGraphQueryV2, validateWorkGraphSnapshotV2 } from '../../work-graph/validationV2';
import {
  applyWorkGraphViewPatchV2,
  type WorkGraphStreamViewV2,
  type WorkGraphViewPatchV2,
} from '../../work-graph/viewPatch';
import {
  applyWorkGraphActivity,
  applyWorkGraphSnapshot,
  applyWorkGraphSnapshotV2,
  createClientWorkGraphState,
  reduceWorkGraphStream,
  type ClientWorkGraphActivity,
  type ClientWorkGraphScope,
  type ClientWorkGraphState,
} from './reduceSnapshot';

/**
 * Viewer is part of the client boundary even though it is intentionally absent
 * from the viewer-safe snapshot body. Changing it creates a new subscription
 * generation and cannot reuse data from the preceding viewer.
 */
export interface WorkGraphClientScope extends ClientWorkGraphScope {
  viewerId: string;
}

/** Additive request fields. A v1 caller sends exactly the same body as before. */
export interface WorkGraphActivityRequest {
  schemaVersion: 2;
  windowStart: string;
  windowEnd: string;
  mode: 'live' | 'as-of';
  /**
   * NFR #85 (0.86): ask the platform to name the snapshot's view (`viewHash`)
   * so the stream's first frame can be a patch against it. A transport
   * forwards it as `viewBase=1`; a platform that does not know it answers as
   * before and the first frame stays whole.
   */
  viewBase?: 1;
}

export interface WorkGraphSnapshotRequest {
  scope: WorkGraphClientScope;
  signal: AbortSignal;
  /** Present only when the caller opted into schemaVersion 2. */
  activity?: WorkGraphActivityRequest;
}

export interface WorkGraphSocketRequest {
  scope: WorkGraphClientScope;
  /** Absent only with `awaitAccess: 1`: there is no snapshot to continue from. */
  cursor?: string;
  subscriptionGeneration: string;
  /**
   * The snapshot was refused (NFR #109). The transport forwards this on the
   * subscribe frame without a cursor; the gateway keeps a content-free
   * placeholder for this socket and answers `reset-required` /
   * `access-restored` once the platform's access signal re-authorizes the
   * viewer. Nothing is polled, and no data rides this socket: the hook
   * fetches a fresh snapshot on the hint.
   */
  awaitAccess?: 1;
  /** Present only when the caller opted into schemaVersion 2. */
  activity?: WorkGraphActivityRequest;
  /**
   * Set with schemaVersion 2: this reader applies `viewPatch` frames (NFR #66),
   * so the transport should forward it on the subscribe frame. A gateway that
   * never sees it keeps sending the whole view.
   */
  viewPatch?: 1;
  /**
   * The `viewHash` of the snapshot this stream starts from (NFR #85). The
   * transport forwards it on the subscribe frame; a gateway that can prove
   * that view patches the first frame against it, anything else sends it whole.
   */
  baseViewHash?: string;
  onMessage(message: unknown): void;
  onClose(): void;
  onError(): void;
}

export interface WorkGraphSocket {
  close(): void;
}

/**
 * The adapter owns authentication (for example, same-origin cookies or a
 * WebSocket subprotocol). Credentials and URLs are deliberately not accepted
 * here, so they cannot be copied into query strings, React state, or errors.
 */
export interface WorkGraphClientTransport {
  fetchSnapshot(request: WorkGraphSnapshotRequest): Promise<unknown>;
  openWebSocket(request: WorkGraphSocketRequest): WorkGraphSocket;
}

export type WorkGraphClientError =
  | 'snapshot-unavailable'
  | 'invalid-snapshot'
  | 'invalid-query'
  | 'stream-unavailable';

export interface UseWorkGraphOptions {
  scope: WorkGraphClientScope;
  transport: WorkGraphClientTransport;
  enabled?: boolean;
  reconnectDelayMs?: number;
  /** Intended for deterministic tests and hosts with their own ID generator. */
  createSubscriptionGeneration?: () => string;
  /**
   * Opt-in reader version. Omitted or 1 keeps the existing v1 request and
   * response exactly; 2 requests the activity layer and validates it strictly.
   */
  schemaVersion?: 1 | 2;
  /** Required with schemaVersion 2: the selected interval inside the local day. */
  window?: { start: string; end: string; mode?: 'live' | 'as-of' };
  /** Ceiling for the backoff between recovery attempts after transient failures. */
  retryMaxDelayMs?: number;
  /**
   * How long transient failures (5xx, refused connections, a dropped socket)
   * are retried silently before the hook reports an error. It keeps retrying
   * after that; only a refusal (401/403/404 and other 4xx) stops it.
   */
  outageGraceMs?: number;
  /** Jitter source, injectable for tests. */
  random?: () => number;
  /** A snapshot request that has not answered by then is abandoned and retried. */
  snapshotTimeoutMs?: number;
}

/**
 * A snapshot failure that retrying cannot fix: the platform answered and said
 * no (not authenticated, not shared, not found, a malformed request). A
 * missing or 5xx/408/429 status is transient — a restart, a refused
 * connection, a timeout — and is retried with backoff.
 */
function isRefusal(error: unknown): boolean {
  const status = error !== null && typeof error === 'object' ? (error as { status?: unknown }).status : undefined;
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

export interface UseWorkGraphResult {
  graph: ClientWorkGraphState;
  status: ClientWorkGraphState['status'] | 'idle' | 'error';
  error: WorkGraphClientError | null;
  retry(): void;
}

interface InternalState {
  scopeKey: string;
  graph: ClientWorkGraphState;
  error: WorkGraphClientError | null;
}

const invalidationReasons = new Set([
  'policy-changed',
  'sharing-paused',
  'sharing-stopped',
  'sharing-expired',
  'cursor-expired',
  'source-authorization-unavailable',
]);
const resetReasons = new Set(['gap', 'replay-unavailable', 'scope-changed', 'source-unavailable', 'access-restored']);
/**
 * Server-announced resets that say nothing about access: the stream could not
 * express a change as deltas (every change on a non-UTC day), so a fresh
 * snapshot is needed. The last authorized graph stays on screen until that
 * snapshot lands, instead of flashing an empty canvas on every update.
 * `source-unavailable` is a platform outage seen by the gateway, not an access
 * change. `scope-changed` is excluded: the old graph belongs to another scope.
 */
const keepVisibleResetReasons = new Set(['gap', 'replay-unavailable', 'source-unavailable']);

function keyForScope(scope: WorkGraphClientScope): string {
  // JSON encoding avoids delimiter ambiguity; this value never leaves memory.
  return JSON.stringify([scope.viewerId, scope.personId, scope.day, scope.timezone]);
}

function reducerScope(scope: WorkGraphClientScope): ClientWorkGraphScope {
  return { personId: scope.personId, day: scope.day, timezone: scope.timezone };
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length
    && actual.every((key) => typeof key === 'string' && keys.includes(key));
}

function parseStreamMessage(value: unknown): WorkGraphStreamMessage | null {
  if (!exactRecord(value, ['kind', 'batch']) && !exactRecord(value, ['kind', 'subscriptionGeneration', 'reason'])) {
    return null;
  }
  if (value.kind === 'delta' && exactRecord(value, ['kind', 'batch'])) {
    const batch = validateWorkGraphDeltaBatch(value.batch);
    return batch.ok ? { kind: 'delta', batch: batch.value } : null;
  }
  if (typeof value.subscriptionGeneration !== 'string' || value.subscriptionGeneration.length === 0) return null;
  if (value.kind === 'invalidate' && typeof value.reason === 'string' && invalidationReasons.has(value.reason)) {
    return value as WorkGraphStreamMessage;
  }
  if (value.kind === 'reset-required' && typeof value.reason === 'string' && resetReasons.has(value.reason)) {
    return value as WorkGraphStreamMessage;
  }
  return null;
}

/**
 * Opt-in activity refresh. It is parsed only for a schemaVersion 2 caller, so
 * a v1 client keeps rejecting every message kind it did not already accept.
 */
function parseActivityMessage(value: unknown): {
  subscriptionGeneration: string;
  policyRevision?: string;
  activity: ClientWorkGraphActivity;
} | null {
  if (!exactRecord(value, ['kind', 'subscriptionGeneration', 'snapshot'])
    && !exactRecord(value, ['kind', 'subscriptionGeneration', 'policyRevision', 'snapshot'])) return null;
  if (value.kind !== 'activity'
    || typeof value.subscriptionGeneration !== 'string'
    || value.subscriptionGeneration.length === 0) return null;
  if ('policyRevision' in value && typeof value.policyRevision !== 'string') return null;
  const validated = validateWorkGraphSnapshotV2(value.snapshot);
  if (!validated.ok) return null;
  const { query, temporal, efforts, details, operations, eventBuckets } = validated.value;
  return {
    subscriptionGeneration: value.subscriptionGeneration,
    ...(typeof value.policyRevision === 'string' ? { policyRevision: value.policyRevision } : {}),
    activity: { query, temporal, efforts, details, operations, eventBuckets },
  };
}

/**
 * A schemaVersion 2 delta: the v1 batch plus the refreshed activity view the
 * gateway attaches to every batch. Until this parser, the v1 validator saw the
 * extra `view` key, rejected the frame and the hook refetched the whole
 * snapshot on every change — no v2 panel ever applied a delta.
 */
function parseDeltaV2(value: unknown):
  | { batch: WorkGraphDeltaBatch; view: Record<string, unknown>; viewPatch?: undefined }
  | { batch: WorkGraphDeltaBatch; view?: undefined; viewPatch: WorkGraphViewPatchV2 }
  | null {
  if (!exactRecord(value, ['kind', 'batch']) || value.kind !== 'delta') return null;
  const raw = value.batch;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { view, viewPatch, schemaVersion, ...rest } = raw as Record<string, unknown>;
  if (schemaVersion !== 2) return null;
  const isRecord = (candidate: unknown) => candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate);
  // Exactly one of the two: a whole view, or a patch against the last one.
  if (isRecord(view) === isRecord(viewPatch) || (view !== undefined && !isRecord(view))
    || (viewPatch !== undefined && !isRecord(viewPatch))) return null;
  const batch = validateWorkGraphDeltaBatch({ ...rest, schemaVersion: 1 });
  if (!batch.ok) return null;
  if (isRecord(viewPatch)) {
    const patch = viewPatch as unknown as WorkGraphViewPatchV2;
    return Number.isSafeInteger(patch.baseWatermark) ? { batch: batch.value, viewPatch: patch } : null;
  }
  return { batch: batch.value, view: view as Record<string, unknown> };
}

/**
 * The view is checked against the graph the delta just produced, with the same
 * validator a v2 snapshot passes: every effort member, detail and lease must
 * point at a node or edge this viewer actually holds.
 */
function deltaActivity(
  state: ClientWorkGraphState,
  batch: WorkGraphDeltaBatch,
  view: Record<string, unknown>,
): ClientWorkGraphActivity | null {
  const { query, temporal, efforts, details, operations, eventBuckets } = view;
  if (Object.keys(view).length !== 6) return null;
  const validated = validateWorkGraphSnapshotV2({
    schemaVersion: 2,
    scope: {
      personId: state.scope.personId,
      day: state.scope.day,
      timezone: state.scope.timezone,
      policyRevision: batch.policyRevision,
    },
    revision: batch.watermark,
    watermark: batch.watermark,
    cursor: batch.cursor,
    nodes: Object.values(state.nodes),
    edges: Object.values(state.edges),
    sources: Object.values(state.sources),
    partial: state.status === 'partial',
    query, temporal, efforts, details, operations, eventBuckets,
  });
  if (!validated.ok) return null;
  const value = validated.value;
  return {
    query: value.query,
    temporal: value.temporal,
    efforts: value.efforts,
    details: value.details,
    operations: value.operations,
    eventBuckets: value.eventBuckets,
  };
}

/** The fields of a snapshot a stream frame's view carries: the base the platform hashed (NFR #85). */
function snapshotStreamView(snapshot: WorkGraphSnapshotV2): WorkGraphStreamViewV2 {
  const { query, temporal, efforts, details, operations, eventBuckets } = snapshot;
  return { query, temporal, efforts, details, operations, eventBuckets };
}

function defaultGeneration(sequence: number): string {
  const random = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID().replaceAll('-', '')
    : Math.random().toString(36).slice(2);
  return `wg_${Date.now().toString(36)}_${sequence.toString(36)}_${random}`;
}

/**
 * Owns exactly one viewer-scoped work-graph snapshot/stream handshake.
 * Recovery always obtains a fresh authorized snapshot before accepting more
 * deltas, and every async callback is fenced by both scope and generation.
 */
export function useWorkGraph({
  scope,
  transport,
  enabled = true,
  reconnectDelayMs = 250,
  createSubscriptionGeneration,
  schemaVersion = 1,
  window,
  retryMaxDelayMs = 15_000,
  outageGraceMs = 20_000,
  random = Math.random,
  snapshotTimeoutMs = 10_000,
}: UseWorkGraphOptions): UseWorkGraphResult {
  const scopeKey = keyForScope(scope);
  const generationSequence = useRef(0);
  const generationFactory = useRef(createSubscriptionGeneration);
  /** Set by a keep-visible reset; consumed by the very next handshake only. */
  const carryVisible = useRef<string | null>(null);
  const [restart, setRestart] = useState(0);
  /** Consecutive transient failures, and when the current outage began (NFR #68). */
  const failures = useRef(0);
  const outageStartedAt = useRef<number | null>(null);
  const randomRef = useRef(random);
  randomRef.current = random;
  const [internal, setInternal] = useState<InternalState>(() => ({
    scopeKey,
    graph: createClientWorkGraphState(reducerScope(scope), 'pending'),
    error: null,
  }));

  const retry = useCallback(() => {
    failures.current = 0;
    outageStartedAt.current = null;
    // Clear synchronously rather than rendering the preceding authorization
    // decision for one more frame while the replacement effect starts.
    setInternal({
      scopeKey,
      graph: createClientWorkGraphState(reducerScope(scope), 'pending'),
      error: null,
    });
    setRestart((value) => value + 1);
  }, [scope.day, scope.personId, scope.timezone, scopeKey]);

  useEffect(() => {
    if (!enabled) return undefined;

    generationSequence.current += 1;
    const subscriptionGeneration = generationFactory.current?.()
      ?? defaultGeneration(generationSequence.current);
    const currentScope = reducerScope(scope);
    const request = { scope: currentScope, subscriptionGeneration };
    const activityRequest: WorkGraphActivityRequest | null = schemaVersion === 2 && window
      ? { schemaVersion: 2, windowStart: window.start, windowEnd: window.end, mode: window.mode ?? 'live', viewBase: 1 }
      : null;
    let graph = createClientWorkGraphState(currentScope, subscriptionGeneration);
    let disposed = false;
    let recoveryStarted = false;
    let socket: WorkGraphSocket | null = null;
    let recoveryTimer: ReturnType<typeof setTimeout> | null = null;
    const abortController = new AbortController();

    const publish = (next: ClientWorkGraphState, error: WorkGraphClientError | null = null) => {
      graph = next;
      if (!disposed) setInternal({ scopeKey, graph: next, error });
    };

    // Start with an empty graph. In particular, retries never carry data that
    // may have been revoked while this client was disconnected. The one
    // exception is a refetch the server itself asked for while access stood
    // (see keepVisibleResetReasons): that graph stays until the new snapshot
    // replaces it, and any failure below still publishes the empty graph.
    const carried = carryVisible.current === scopeKey;
    carryVisible.current = null;
    if (!carried) publish(graph);

    const recover = (
      delayMs: number,
      error: WorkGraphClientError | null = null,
      keepVisible = false,
    ) => {
      if (disposed || recoveryStarted) return;
      recoveryStarted = true;
      abortController.abort();
      const activeSocket = socket;
      socket = null;
      activeSocket?.close();
      if (keepVisible) carryVisible.current = scopeKey;
      else publish(createClientWorkGraphState(currentScope, subscriptionGeneration), error);
      const restartNow = () => {
        if (!disposed) setRestart((value) => value + 1);
      };
      if (delayMs <= 0) restartNow();
      else recoveryTimer = setTimeout(restartNow, delayMs);
    };

    /**
     * A transient failure: retry with exponential backoff and full-range
     * jitter (so a restarted platform is not hit by every panel at once), and
     * only report `error` once the outage has lasted `outageGraceMs`. Until
     * then the last authorized graph stays on screen: a dropped socket, a 5xx
     * or a timeout says nothing about access, and every retry re-authorizes
     * through a fresh snapshot (a refusal there clears it). Past the grace the
     * graph is cleared with the error.
     */
    const recoverTransient = (error: WorkGraphClientError) => {
      const attempt = failures.current;
      failures.current = attempt + 1;
      const now = Date.now();
      if (outageStartedAt.current === null) outageStartedAt.current = now;
      const sustained = now - outageStartedAt.current >= outageGraceMs;
      const ceiling = Math.min(retryMaxDelayMs, Math.max(reconnectDelayMs, 1) * 2 ** attempt);
      const delay = Math.max(1, Math.round(ceiling * (0.5 + 0.5 * randomRef.current())));
      recover(delay, sustained ? error : null, !sustained);
    };

    /**
     * The platform refused the snapshot (NFR #109: a paused grant, or none
     * yet). The error stays on screen with its "Try again", but the hook
     * also asks the gateway to hold a content-free placeholder for this
     * generation and listens for the one hint it can send: `access-restored`,
     * the platform's access signal re-authorized this viewer. On it the hook
     * refetches, which is where the data is authorized — nothing arrives on
     * this socket, and nothing is polled. A gateway that predates the hint
     * answers nothing; the reader still has "Try again".
     */
    const awaitAccess = () => {
      if (disposed || recoveryStarted) return;
      try {
        socket = transport.openWebSocket({
          scope: { ...scope },
          subscriptionGeneration,
          awaitAccess: 1,
          onMessage: (rawMessage) => {
            const message = parseStreamMessage(rawMessage);
            if (!message || message.kind !== 'reset-required' || message.reason !== 'access-restored'
              || message.subscriptionGeneration !== subscriptionGeneration) return;
            failures.current = 0;
            outageStartedAt.current = null;
            recover(0);
          },
          // The gateway socket went away (a pod swap): the placeholder went
          // with it, so the wait is re-established through a fresh snapshot.
          onClose: () => recoverTransient('stream-unavailable'),
          onError: () => recoverTransient('stream-unavailable'),
        });
      } catch {
        recoverTransient('stream-unavailable');
      }
    };

    const bootstrap = async () => {
      if (schemaVersion === 2) {
        // Refuse to issue a v2 request the server would have to interpret.
        // The window has to be a real interval inside this person's local day.
        const query = activityRequest && validateWorkGraphQueryV2({
          schemaVersion: 2,
          personId: scope.personId,
          day: scope.day,
          timezone: scope.timezone,
          windowStart: activityRequest.windowStart,
          windowEnd: activityRequest.windowEnd,
          mode: activityRequest.mode,
        });
        if (!query || !query.ok) {
          publish(createClientWorkGraphState(currentScope, subscriptionGeneration), 'invalid-query');
          return;
        }
      }
      let rawSnapshot: unknown;
      // A request into a restarting gateway can hang until the proxy gives up
      // (30 s, measured). It is abandoned after snapshotTimeoutMs and retried
      // like any other transient failure.
      const fetchController = new AbortController();
      const forwardAbort = () => fetchController.abort();
      abortController.signal.addEventListener('abort', forwardAbort);
      let timedOut = false;
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        rawSnapshot = await Promise.race([
          transport.fetchSnapshot({
            scope: { ...scope },
            signal: fetchController.signal,
            ...(activityRequest ? { activity: activityRequest } : {}),
          }),
          new Promise<never>((_, reject) => {
            timeoutTimer = setTimeout(() => {
              timedOut = true;
              fetchController.abort();
              reject(new Error('snapshot timed out'));
            }, snapshotTimeoutMs);
          }),
        ]);
      } catch (error) {
        if (disposed || (abortController.signal.aborted && !timedOut)) return;
        if (!timedOut && isRefusal(error)) {
          publish(graph, 'snapshot-unavailable');
          awaitAccess();
        } else {
          recoverTransient('snapshot-unavailable');
        }
        return;
      } finally {
        if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
        abortController.signal.removeEventListener('abort', forwardAbort);
      }
      if (disposed) return;

      const validated = schemaVersion === 2
        ? validateWorkGraphSnapshotV2(rawSnapshot)
        : validateWorkGraphSnapshot(rawSnapshot);
      if (!validated.ok) {
        publish(createClientWorkGraphState(currentScope, subscriptionGeneration), 'invalid-snapshot');
        return;
      }

      const snapshot = validated.value as WorkGraphSnapshot | WorkGraphSnapshotV2;
      const next = snapshot.schemaVersion === 2
        ? applyWorkGraphSnapshotV2(graph, snapshot, request)
        : applyWorkGraphSnapshot(graph, snapshot, request);
      if (next === graph || next.status === 'loading') {
        publish(createClientWorkGraphState(currentScope, subscriptionGeneration), 'invalid-snapshot');
        return;
      }
      publish(next);
      failures.current = 0;
      outageStartedAt.current = null;

      // The view a `viewPatch` may apply to, and the watermark of the frame
      // it came with. It starts as the snapshot's own view when the platform
      // named it (NFR #85): the gateway patches the first frame against that
      // exact view only after proving it by hash, so a patch naming this
      // watermark can only mean this view. Otherwise the first frame is whole.
      const viewHash = snapshot.schemaVersion === 2 ? (snapshot as WorkGraphSnapshotV2).viewHash : undefined;
      let streamView: { watermark: number; view: WorkGraphStreamViewV2 } | null = viewHash
        ? { watermark: snapshot.watermark, view: snapshotStreamView(snapshot as WorkGraphSnapshotV2) }
        : null;

      const onMessage = (rawMessage: unknown) => {
        if (disposed || recoveryStarted) return;
        if (schemaVersion === 2) {
          const refresh = parseActivityMessage(rawMessage);
          if (refresh) {
            publish(applyWorkGraphActivity(graph, refresh.activity, refresh));
            return;
          }
          const deltaV2 = parseDeltaV2(rawMessage);
          if (deltaV2) {
            const reduced = reduceWorkGraphStream(graph, { kind: 'delta', batch: deltaV2.batch });
            if (reduced.status === 'refetch-required' || reduced.status === 'invalidated') {
              publish(reduced);
              recover(0);
              return;
            }
            // A batch at or below the current watermark changes nothing.
            if (reduced === graph) return;
            let view: Record<string, unknown> | null;
            if (deltaV2.viewPatch) {
              // A patch against a view this reader does not hold is not an
              // error the user should see: resync from a snapshot, keeping the
              // graph on screen (access has not changed).
              view = streamView && deltaV2.viewPatch.baseWatermark === streamView.watermark
                ? applyWorkGraphViewPatchV2(streamView.view, deltaV2.viewPatch) as Record<string, unknown> | null
                : null;
              if (!view) {
                recover(0, null, true);
                return;
              }
            } else {
              view = deltaV2.view;
            }
            const activity = deltaActivity(reduced, deltaV2.batch, view);
            if (!activity) {
              recover(reconnectDelayMs);
              return;
            }
            streamView = { watermark: deltaV2.batch.watermark, view: view as unknown as WorkGraphStreamViewV2 };
            publish(applyWorkGraphActivity(reduced, activity, deltaV2.batch));
            return;
          }
        }
        const message = parseStreamMessage(rawMessage);
        if (!message) {
          recover(reconnectDelayMs);
          return;
        }
        const reduced = reduceWorkGraphStream(graph, message);
        publish(reduced);
        if (reduced.status === 'refetch-required' || reduced.status === 'invalidated') {
          recover(0, null, message.kind === 'reset-required'
            && reduced.status === 'refetch-required'
            && keepVisibleResetReasons.has(message.reason));
        }
      };

      try {
        socket = transport.openWebSocket({
          scope: { ...scope },
          cursor: snapshot.cursor,
          subscriptionGeneration,
          ...(activityRequest ? { activity: activityRequest, viewPatch: 1 as const } : {}),
          ...(viewHash ? { baseViewHash: viewHash } : {}),
          onMessage,
          onClose: () => recoverTransient('stream-unavailable'),
          onError: () => recoverTransient('stream-unavailable'),
        });
      } catch {
        recoverTransient('stream-unavailable');
      }
    };

    void bootstrap();
    return () => {
      disposed = true;
      abortController.abort();
      if (recoveryTimer !== null) clearTimeout(recoveryTimer);
      const activeSocket = socket;
      socket = null;
      activeSocket?.close();
    };
  }, [
    enabled,
    reconnectDelayMs,
    retryMaxDelayMs,
    outageGraceMs,
    snapshotTimeoutMs,
    restart,
    schemaVersion,
    window?.start,
    window?.end,
    window?.mode,
    scope.day,
    scope.personId,
    scope.timezone,
    scope.viewerId,
    scopeKey,
    transport,
  ]);

  // Effects run after render. Never expose the previous viewer/scope during
  // that one render when a caller switches identity or date.
  const visible = internal.scopeKey === scopeKey
    ? internal
    : {
      scopeKey,
      graph: createClientWorkGraphState(reducerScope(scope), 'pending'),
      error: null,
    };
  if (!enabled) {
    const graph = createClientWorkGraphState(reducerScope(scope), 'disabled');
    return { graph, status: 'idle', error: null, retry };
  }
  return {
    graph: visible.graph,
    status: visible.error ? 'error' : visible.graph.status,
    error: visible.error,
    retry,
  };
}
