import { useCallback, useEffect, useRef, useState } from 'react';

import type { WorkGraphSnapshot, WorkGraphStreamMessage } from '../../work-graph/contracts';
import type { WorkGraphSnapshotV2 } from '../../work-graph/contractsV2';
import { validateWorkGraphDeltaBatch, validateWorkGraphSnapshot } from '../../work-graph/validation';
import { validateWorkGraphQueryV2, validateWorkGraphSnapshotV2 } from '../../work-graph/validationV2';
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
}

export interface WorkGraphSnapshotRequest {
  scope: WorkGraphClientScope;
  signal: AbortSignal;
  /** Present only when the caller opted into schemaVersion 2. */
  activity?: WorkGraphActivityRequest;
}

export interface WorkGraphSocketRequest {
  scope: WorkGraphClientScope;
  cursor: string;
  subscriptionGeneration: string;
  /** Present only when the caller opted into schemaVersion 2. */
  activity?: WorkGraphActivityRequest;
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
const resetReasons = new Set(['gap', 'replay-unavailable', 'scope-changed']);

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
}: UseWorkGraphOptions): UseWorkGraphResult {
  const scopeKey = keyForScope(scope);
  const generationSequence = useRef(0);
  const generationFactory = useRef(createSubscriptionGeneration);
  const [restart, setRestart] = useState(0);
  const [internal, setInternal] = useState<InternalState>(() => ({
    scopeKey,
    graph: createClientWorkGraphState(reducerScope(scope), 'pending'),
    error: null,
  }));

  const retry = useCallback(() => {
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
      ? { schemaVersion: 2, windowStart: window.start, windowEnd: window.end, mode: window.mode ?? 'live' }
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
    // may have been revoked while this client was disconnected.
    publish(graph);

    const recover = (delayMs: number, error: WorkGraphClientError | null = null) => {
      if (disposed || recoveryStarted) return;
      recoveryStarted = true;
      abortController.abort();
      const activeSocket = socket;
      socket = null;
      activeSocket?.close();
      publish(createClientWorkGraphState(currentScope, subscriptionGeneration), error);
      const restartNow = () => {
        if (!disposed) setRestart((value) => value + 1);
      };
      if (delayMs <= 0) restartNow();
      else recoveryTimer = setTimeout(restartNow, delayMs);
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
      try {
        rawSnapshot = await transport.fetchSnapshot({
          scope: { ...scope },
          signal: abortController.signal,
          ...(activityRequest ? { activity: activityRequest } : {}),
        });
      } catch {
        if (!disposed && !abortController.signal.aborted) publish(graph, 'snapshot-unavailable');
        return;
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

      const onMessage = (rawMessage: unknown) => {
        if (disposed || recoveryStarted) return;
        if (schemaVersion === 2) {
          const refresh = parseActivityMessage(rawMessage);
          if (refresh) {
            publish(applyWorkGraphActivity(graph, refresh.activity, refresh));
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
        if (reduced.status === 'refetch-required' || reduced.status === 'invalidated') recover(0);
      };

      try {
        socket = transport.openWebSocket({
          scope: { ...scope },
          cursor: snapshot.cursor,
          subscriptionGeneration,
          ...(activityRequest ? { activity: activityRequest } : {}),
          onMessage,
          onClose: () => recover(reconnectDelayMs),
          onError: () => recover(reconnectDelayMs, 'stream-unavailable'),
        });
      } catch {
        recover(reconnectDelayMs, 'stream-unavailable');
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
