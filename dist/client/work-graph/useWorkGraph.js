"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.useWorkGraph = useWorkGraph;
const react_1 = require("react");
const validation_1 = require("../../work-graph/validation");
const validationV2_1 = require("../../work-graph/validationV2");
const viewPatch_1 = require("../../work-graph/viewPatch");
const reduceSnapshot_1 = require("./reduceSnapshot");
/**
 * A snapshot failure that retrying cannot fix: the platform answered and said
 * no (not authenticated, not shared, not found, a malformed request). A
 * missing or 5xx/408/429 status is transient — a restart, a refused
 * connection, a timeout — and is retried with backoff.
 */
function isRefusal(error) {
    const status = error !== null && typeof error === 'object' ? error.status : undefined;
    return typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429;
}
const invalidationReasons = new Set([
    'policy-changed',
    'sharing-paused',
    'sharing-stopped',
    'sharing-expired',
    'cursor-expired',
    'source-authorization-unavailable',
]);
const resetReasons = new Set(['gap', 'replay-unavailable', 'scope-changed', 'source-unavailable']);
/**
 * Server-announced resets that say nothing about access: the stream could not
 * express a change as deltas (every change on a non-UTC day), so a fresh
 * snapshot is needed. The last authorized graph stays on screen until that
 * snapshot lands, instead of flashing an empty canvas on every update.
 * `source-unavailable` is a platform outage seen by the gateway, not an access
 * change. `scope-changed` is excluded: the old graph belongs to another scope.
 */
const keepVisibleResetReasons = new Set(['gap', 'replay-unavailable', 'source-unavailable']);
function keyForScope(scope) {
    // JSON encoding avoids delimiter ambiguity; this value never leaves memory.
    return JSON.stringify([scope.viewerId, scope.personId, scope.day, scope.timezone]);
}
function reducerScope(scope) {
    return { personId: scope.personId, day: scope.day, timezone: scope.timezone };
}
function exactRecord(value, keys) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
        return false;
    const actual = Reflect.ownKeys(value);
    return actual.length === keys.length
        && actual.every((key) => typeof key === 'string' && keys.includes(key));
}
function parseStreamMessage(value) {
    if (!exactRecord(value, ['kind', 'batch']) && !exactRecord(value, ['kind', 'subscriptionGeneration', 'reason'])) {
        return null;
    }
    if (value.kind === 'delta' && exactRecord(value, ['kind', 'batch'])) {
        const batch = (0, validation_1.validateWorkGraphDeltaBatch)(value.batch);
        return batch.ok ? { kind: 'delta', batch: batch.value } : null;
    }
    if (typeof value.subscriptionGeneration !== 'string' || value.subscriptionGeneration.length === 0)
        return null;
    if (value.kind === 'invalidate' && typeof value.reason === 'string' && invalidationReasons.has(value.reason)) {
        return value;
    }
    if (value.kind === 'reset-required' && typeof value.reason === 'string' && resetReasons.has(value.reason)) {
        return value;
    }
    return null;
}
/**
 * Opt-in activity refresh. It is parsed only for a schemaVersion 2 caller, so
 * a v1 client keeps rejecting every message kind it did not already accept.
 */
function parseActivityMessage(value) {
    if (!exactRecord(value, ['kind', 'subscriptionGeneration', 'snapshot'])
        && !exactRecord(value, ['kind', 'subscriptionGeneration', 'policyRevision', 'snapshot']))
        return null;
    if (value.kind !== 'activity'
        || typeof value.subscriptionGeneration !== 'string'
        || value.subscriptionGeneration.length === 0)
        return null;
    if ('policyRevision' in value && typeof value.policyRevision !== 'string')
        return null;
    const validated = (0, validationV2_1.validateWorkGraphSnapshotV2)(value.snapshot);
    if (!validated.ok)
        return null;
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
function parseDeltaV2(value) {
    if (!exactRecord(value, ['kind', 'batch']) || value.kind !== 'delta')
        return null;
    const raw = value.batch;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
        return null;
    const { view, viewPatch, schemaVersion, ...rest } = raw;
    if (schemaVersion !== 2)
        return null;
    const isRecord = (candidate) => candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate);
    // Exactly one of the two: a whole view, or a patch against the last one.
    if (isRecord(view) === isRecord(viewPatch) || (view !== undefined && !isRecord(view))
        || (viewPatch !== undefined && !isRecord(viewPatch)))
        return null;
    const batch = (0, validation_1.validateWorkGraphDeltaBatch)({ ...rest, schemaVersion: 1 });
    if (!batch.ok)
        return null;
    if (isRecord(viewPatch)) {
        const patch = viewPatch;
        return Number.isSafeInteger(patch.baseWatermark) ? { batch: batch.value, viewPatch: patch } : null;
    }
    return { batch: batch.value, view: view };
}
/**
 * The view is checked against the graph the delta just produced, with the same
 * validator a v2 snapshot passes: every effort member, detail and lease must
 * point at a node or edge this viewer actually holds.
 */
function deltaActivity(state, batch, view) {
    const { query, temporal, efforts, details, operations, eventBuckets } = view;
    if (Object.keys(view).length !== 6)
        return null;
    const validated = (0, validationV2_1.validateWorkGraphSnapshotV2)({
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
    if (!validated.ok)
        return null;
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
function snapshotStreamView(snapshot) {
    const { query, temporal, efforts, details, operations, eventBuckets } = snapshot;
    return { query, temporal, efforts, details, operations, eventBuckets };
}
function defaultGeneration(sequence) {
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
function useWorkGraph({ scope, transport, enabled = true, reconnectDelayMs = 250, createSubscriptionGeneration, schemaVersion = 1, window, retryMaxDelayMs = 15_000, outageGraceMs = 20_000, random = Math.random, snapshotTimeoutMs = 10_000, }) {
    const scopeKey = keyForScope(scope);
    const generationSequence = (0, react_1.useRef)(0);
    const generationFactory = (0, react_1.useRef)(createSubscriptionGeneration);
    /** Set by a keep-visible reset; consumed by the very next handshake only. */
    const carryVisible = (0, react_1.useRef)(null);
    const [restart, setRestart] = (0, react_1.useState)(0);
    /** Consecutive transient failures, and when the current outage began (NFR #68). */
    const failures = (0, react_1.useRef)(0);
    const outageStartedAt = (0, react_1.useRef)(null);
    const randomRef = (0, react_1.useRef)(random);
    randomRef.current = random;
    const [internal, setInternal] = (0, react_1.useState)(() => ({
        scopeKey,
        graph: (0, reduceSnapshot_1.createClientWorkGraphState)(reducerScope(scope), 'pending'),
        error: null,
    }));
    const retry = (0, react_1.useCallback)(() => {
        failures.current = 0;
        outageStartedAt.current = null;
        // Clear synchronously rather than rendering the preceding authorization
        // decision for one more frame while the replacement effect starts.
        setInternal({
            scopeKey,
            graph: (0, reduceSnapshot_1.createClientWorkGraphState)(reducerScope(scope), 'pending'),
            error: null,
        });
        setRestart((value) => value + 1);
    }, [scope.day, scope.personId, scope.timezone, scopeKey]);
    (0, react_1.useEffect)(() => {
        if (!enabled)
            return undefined;
        generationSequence.current += 1;
        const subscriptionGeneration = generationFactory.current?.()
            ?? defaultGeneration(generationSequence.current);
        const currentScope = reducerScope(scope);
        const request = { scope: currentScope, subscriptionGeneration };
        const activityRequest = schemaVersion === 2 && window
            ? { schemaVersion: 2, windowStart: window.start, windowEnd: window.end, mode: window.mode ?? 'live', viewBase: 1 }
            : null;
        let graph = (0, reduceSnapshot_1.createClientWorkGraphState)(currentScope, subscriptionGeneration);
        let disposed = false;
        let recoveryStarted = false;
        let socket = null;
        let recoveryTimer = null;
        const abortController = new AbortController();
        const publish = (next, error = null) => {
            graph = next;
            if (!disposed)
                setInternal({ scopeKey, graph: next, error });
        };
        // Start with an empty graph. In particular, retries never carry data that
        // may have been revoked while this client was disconnected. The one
        // exception is a refetch the server itself asked for while access stood
        // (see keepVisibleResetReasons): that graph stays until the new snapshot
        // replaces it, and any failure below still publishes the empty graph.
        const carried = carryVisible.current === scopeKey;
        carryVisible.current = null;
        if (!carried)
            publish(graph);
        const recover = (delayMs, error = null, keepVisible = false) => {
            if (disposed || recoveryStarted)
                return;
            recoveryStarted = true;
            abortController.abort();
            const activeSocket = socket;
            socket = null;
            activeSocket?.close();
            if (keepVisible)
                carryVisible.current = scopeKey;
            else
                publish((0, reduceSnapshot_1.createClientWorkGraphState)(currentScope, subscriptionGeneration), error);
            const restartNow = () => {
                if (!disposed)
                    setRestart((value) => value + 1);
            };
            if (delayMs <= 0)
                restartNow();
            else
                recoveryTimer = setTimeout(restartNow, delayMs);
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
        const recoverTransient = (error) => {
            const attempt = failures.current;
            failures.current = attempt + 1;
            const now = Date.now();
            if (outageStartedAt.current === null)
                outageStartedAt.current = now;
            const sustained = now - outageStartedAt.current >= outageGraceMs;
            const ceiling = Math.min(retryMaxDelayMs, Math.max(reconnectDelayMs, 1) * 2 ** attempt);
            const delay = Math.max(1, Math.round(ceiling * (0.5 + 0.5 * randomRef.current())));
            recover(delay, sustained ? error : null, !sustained);
        };
        const bootstrap = async () => {
            if (schemaVersion === 2) {
                // Refuse to issue a v2 request the server would have to interpret.
                // The window has to be a real interval inside this person's local day.
                const query = activityRequest && (0, validationV2_1.validateWorkGraphQueryV2)({
                    schemaVersion: 2,
                    personId: scope.personId,
                    day: scope.day,
                    timezone: scope.timezone,
                    windowStart: activityRequest.windowStart,
                    windowEnd: activityRequest.windowEnd,
                    mode: activityRequest.mode,
                });
                if (!query || !query.ok) {
                    publish((0, reduceSnapshot_1.createClientWorkGraphState)(currentScope, subscriptionGeneration), 'invalid-query');
                    return;
                }
            }
            let rawSnapshot;
            // A request into a restarting gateway can hang until the proxy gives up
            // (30 s, measured). It is abandoned after snapshotTimeoutMs and retried
            // like any other transient failure.
            const fetchController = new AbortController();
            const forwardAbort = () => fetchController.abort();
            abortController.signal.addEventListener('abort', forwardAbort);
            let timedOut = false;
            let timeoutTimer;
            try {
                rawSnapshot = await Promise.race([
                    transport.fetchSnapshot({
                        scope: { ...scope },
                        signal: fetchController.signal,
                        ...(activityRequest ? { activity: activityRequest } : {}),
                    }),
                    new Promise((_, reject) => {
                        timeoutTimer = setTimeout(() => {
                            timedOut = true;
                            fetchController.abort();
                            reject(new Error('snapshot timed out'));
                        }, snapshotTimeoutMs);
                    }),
                ]);
            }
            catch (error) {
                if (disposed || (abortController.signal.aborted && !timedOut))
                    return;
                if (!timedOut && isRefusal(error))
                    publish(graph, 'snapshot-unavailable');
                else
                    recoverTransient('snapshot-unavailable');
                return;
            }
            finally {
                if (timeoutTimer !== undefined)
                    clearTimeout(timeoutTimer);
                abortController.signal.removeEventListener('abort', forwardAbort);
            }
            if (disposed)
                return;
            const validated = schemaVersion === 2
                ? (0, validationV2_1.validateWorkGraphSnapshotV2)(rawSnapshot)
                : (0, validation_1.validateWorkGraphSnapshot)(rawSnapshot);
            if (!validated.ok) {
                publish((0, reduceSnapshot_1.createClientWorkGraphState)(currentScope, subscriptionGeneration), 'invalid-snapshot');
                return;
            }
            const snapshot = validated.value;
            const next = snapshot.schemaVersion === 2
                ? (0, reduceSnapshot_1.applyWorkGraphSnapshotV2)(graph, snapshot, request)
                : (0, reduceSnapshot_1.applyWorkGraphSnapshot)(graph, snapshot, request);
            if (next === graph || next.status === 'loading') {
                publish((0, reduceSnapshot_1.createClientWorkGraphState)(currentScope, subscriptionGeneration), 'invalid-snapshot');
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
            const viewHash = snapshot.schemaVersion === 2 ? snapshot.viewHash : undefined;
            let streamView = viewHash
                ? { watermark: snapshot.watermark, view: snapshotStreamView(snapshot) }
                : null;
            const onMessage = (rawMessage) => {
                if (disposed || recoveryStarted)
                    return;
                if (schemaVersion === 2) {
                    const refresh = parseActivityMessage(rawMessage);
                    if (refresh) {
                        publish((0, reduceSnapshot_1.applyWorkGraphActivity)(graph, refresh.activity, refresh));
                        return;
                    }
                    const deltaV2 = parseDeltaV2(rawMessage);
                    if (deltaV2) {
                        const reduced = (0, reduceSnapshot_1.reduceWorkGraphStream)(graph, { kind: 'delta', batch: deltaV2.batch });
                        if (reduced.status === 'refetch-required' || reduced.status === 'invalidated') {
                            publish(reduced);
                            recover(0);
                            return;
                        }
                        // A batch at or below the current watermark changes nothing.
                        if (reduced === graph)
                            return;
                        let view;
                        if (deltaV2.viewPatch) {
                            // A patch against a view this reader does not hold is not an
                            // error the user should see: resync from a snapshot, keeping the
                            // graph on screen (access has not changed).
                            view = streamView && deltaV2.viewPatch.baseWatermark === streamView.watermark
                                ? (0, viewPatch_1.applyWorkGraphViewPatchV2)(streamView.view, deltaV2.viewPatch)
                                : null;
                            if (!view) {
                                recover(0, null, true);
                                return;
                            }
                        }
                        else {
                            view = deltaV2.view;
                        }
                        const activity = deltaActivity(reduced, deltaV2.batch, view);
                        if (!activity) {
                            recover(reconnectDelayMs);
                            return;
                        }
                        streamView = { watermark: deltaV2.batch.watermark, view: view };
                        publish((0, reduceSnapshot_1.applyWorkGraphActivity)(reduced, activity, deltaV2.batch));
                        return;
                    }
                }
                const message = parseStreamMessage(rawMessage);
                if (!message) {
                    recover(reconnectDelayMs);
                    return;
                }
                const reduced = (0, reduceSnapshot_1.reduceWorkGraphStream)(graph, message);
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
                    ...(activityRequest ? { activity: activityRequest, viewPatch: 1 } : {}),
                    ...(viewHash ? { baseViewHash: viewHash } : {}),
                    onMessage,
                    onClose: () => recoverTransient('stream-unavailable'),
                    onError: () => recoverTransient('stream-unavailable'),
                });
            }
            catch {
                recoverTransient('stream-unavailable');
            }
        };
        void bootstrap();
        return () => {
            disposed = true;
            abortController.abort();
            if (recoveryTimer !== null)
                clearTimeout(recoveryTimer);
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
            graph: (0, reduceSnapshot_1.createClientWorkGraphState)(reducerScope(scope), 'pending'),
            error: null,
        };
    if (!enabled) {
        const graph = (0, reduceSnapshot_1.createClientWorkGraphState)(reducerScope(scope), 'disabled');
        return { graph, status: 'idle', error: null, retry };
    }
    return {
        graph: visible.graph,
        status: visible.error ? 'error' : visible.graph.status,
        error: visible.error,
        retry,
    };
}
//# sourceMappingURL=useWorkGraph.js.map