"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.useWorkGraph = useWorkGraph;
const react_1 = require("react");
const validation_1 = require("../../work-graph/validation");
const reduceSnapshot_1 = require("./reduceSnapshot");
const invalidationReasons = new Set([
    'policy-changed',
    'sharing-paused',
    'sharing-stopped',
    'sharing-expired',
    'cursor-expired',
    'source-authorization-unavailable',
]);
const resetReasons = new Set(['gap', 'replay-unavailable', 'scope-changed']);
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
function useWorkGraph({ scope, transport, enabled = true, reconnectDelayMs = 250, createSubscriptionGeneration, }) {
    const scopeKey = keyForScope(scope);
    const generationSequence = (0, react_1.useRef)(0);
    const generationFactory = (0, react_1.useRef)(createSubscriptionGeneration);
    const [restart, setRestart] = (0, react_1.useState)(0);
    const [internal, setInternal] = (0, react_1.useState)(() => ({
        scopeKey,
        graph: (0, reduceSnapshot_1.createClientWorkGraphState)(reducerScope(scope), 'pending'),
        error: null,
    }));
    const retry = (0, react_1.useCallback)(() => {
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
        // may have been revoked while this client was disconnected.
        publish(graph);
        const recover = (delayMs, error = null) => {
            if (disposed || recoveryStarted)
                return;
            recoveryStarted = true;
            abortController.abort();
            const activeSocket = socket;
            socket = null;
            activeSocket?.close();
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
        const bootstrap = async () => {
            let rawSnapshot;
            try {
                rawSnapshot = await transport.fetchSnapshot({ scope: { ...scope }, signal: abortController.signal });
            }
            catch {
                if (!disposed && !abortController.signal.aborted)
                    publish(graph, 'snapshot-unavailable');
                return;
            }
            if (disposed)
                return;
            const validated = (0, validation_1.validateWorkGraphSnapshot)(rawSnapshot);
            if (!validated.ok) {
                publish((0, reduceSnapshot_1.createClientWorkGraphState)(currentScope, subscriptionGeneration), 'invalid-snapshot');
                return;
            }
            const snapshot = validated.value;
            const next = (0, reduceSnapshot_1.applyWorkGraphSnapshot)(graph, snapshot, request);
            if (next === graph || next.status === 'loading') {
                publish((0, reduceSnapshot_1.createClientWorkGraphState)(currentScope, subscriptionGeneration), 'invalid-snapshot');
                return;
            }
            publish(next);
            const onMessage = (rawMessage) => {
                if (disposed || recoveryStarted)
                    return;
                const message = parseStreamMessage(rawMessage);
                if (!message) {
                    recover(reconnectDelayMs);
                    return;
                }
                const reduced = (0, reduceSnapshot_1.reduceWorkGraphStream)(graph, message);
                publish(reduced);
                if (reduced.status === 'refetch-required' || reduced.status === 'invalidated')
                    recover(0);
            };
            try {
                socket = transport.openWebSocket({
                    scope: { ...scope },
                    cursor: snapshot.cursor,
                    subscriptionGeneration,
                    onMessage,
                    onClose: () => recover(reconnectDelayMs),
                    onError: () => recover(reconnectDelayMs, 'stream-unavailable'),
                });
            }
            catch {
                recover(reconnectDelayMs, 'stream-unavailable');
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
        restart,
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