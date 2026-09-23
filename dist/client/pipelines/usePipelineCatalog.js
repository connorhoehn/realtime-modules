"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.PIPELINE_ALL_CHANNEL = void 0;
exports.normalizeCatalogEntry = normalizeCatalogEntry;
exports.fetchPipelineCatalog = fetchPipelineCatalog;
exports.newPipelineDraftRequestId = newPipelineDraftRequestId;
exports.generatePipelineDraft = generatePipelineDraft;
exports.usePipelineCatalog = usePipelineCatalog;
const react_1 = require("react");
const GatewaySocketProvider_1 = require("../GatewaySocketProvider");
const catalog_1 = require("./catalog");
async function errorFrom(res, fallback) {
    const body = (await res.json().catch(() => ({})));
    const message = body.message || (typeof body.detail === 'string' ? body.detail : undefined) || body.error || `${fallback} (${res.status})`;
    return Object.assign(new Error(message), {
        status: res.status,
        ...(body.error ? { code: body.error } : {}),
        ...(body.detail !== undefined ? { detail: body.detail } : {}),
    });
}
function authHeaders(idToken) {
    return idToken ? { Authorization: `Bearer ${idToken}` } : {};
}
function normalizeCatalogEntry(raw) {
    const rollup = raw.rollup && typeof raw.rollup === 'object' ? raw.rollup : null;
    return { ...raw, rollup, ...(raw.readOnly === true ? { readOnly: true } : {}) };
}
/** `GET {apiBaseUrl}/api/pipelines/defs?include=rollup`, normalised. */
async function fetchPipelineCatalog(apiBaseUrl, idToken, init) {
    const res = await fetch(`${apiBaseUrl}/api/pipelines/defs?include=rollup`, {
        headers: authHeaders(idToken),
        ...(init?.signal ? { signal: init.signal } : {}),
    });
    if (!res.ok)
        throw await errorFrom(res, 'Could not read the pipelines');
    const body = (await res.json());
    const list = Array.isArray(body.pipelines) ? body.pipelines : [];
    return list.filter((p) => p && typeof p === 'object' && typeof p.id === 'string').map(normalizeCatalogEntry);
}
/** A fresh idempotency key: a UUID where the runtime has one, else a time-and-random id of the same shape. */
function newPipelineDraftRequestId() {
    const c = globalThis.crypto;
    if (c && typeof c.randomUUID === 'function')
        return c.randomUUID();
    const hex = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
    return `${hex()}${hex()}-${hex()}-4${hex().slice(1)}-${hex()}-${hex()}${hex()}${hex()}`;
}
/**
 * `POST {apiBaseUrl}/api/pipelines/defs/generate` — the `/agent` planner on the
 * page. Same shape as `requestPipelineRun`; throws a `PipelineCatalogRequestError`
 * whose `code` is `invalid_instruction` on a 422, `invalid_body` on a 400, and
 * `idempotency_in_progress` on a 409 (the same key is already being planned).
 */
async function generatePipelineDraft(apiBaseUrl, idToken, input) {
    const requestId = input.requestId || newPipelineDraftRequestId();
    const body = { ...input, requestId };
    const res = await fetch(`${apiBaseUrl}/api/pipelines/defs/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': requestId, ...authHeaders(idToken) },
        body: JSON.stringify(body),
    });
    if (!res.ok)
        throw await errorFrom(res, 'Could not plan the pipeline');
    const json = (await res.json());
    return { ...json, requestId: json.requestId || requestId };
}
/** Subscribe / unsubscribe frames for the firehose, as the gateway's pipeline service expects them. */
exports.PIPELINE_ALL_CHANNEL = 'pipeline:all';
function usePipelineCatalog(opts) {
    const { apiBaseUrl, idToken, transport } = opts;
    const enabled = opts.enabled !== false;
    // Hooks cannot be conditional, so the context is always read; it is only
    // USED when the host handed in no transport of its own.
    const gateway = (0, GatewaySocketProvider_1.useGatewayOptional)();
    const send = transport === null ? undefined : transport ? transport.send : gateway?.sendMessage;
    const onMessage = transport === null ? undefined : transport ? transport.onMessage : gateway?.onMessage;
    const epoch = opts.sessionEpoch ?? (transport === undefined ? gateway?.sessionEpoch : undefined);
    const [entries, setEntries] = (0, react_1.useState)([]);
    const [loading, setLoading] = (0, react_1.useState)(true);
    const [error, setError] = (0, react_1.useState)(undefined);
    const [tick, setTick] = (0, react_1.useState)(0);
    const alive = (0, react_1.useRef)(true);
    const loaded = (0, react_1.useRef)(false);
    (0, react_1.useEffect)(() => { alive.current = true; return () => { alive.current = false; }; }, []);
    const refresh = (0, react_1.useCallback)(() => setTick((t) => t + 1), []);
    // The durable read — on mount, on every refresh.
    (0, react_1.useEffect)(() => {
        if (!enabled) {
            setLoading(false);
            return;
        }
        if (!idToken) {
            setLoading(false);
            return;
        }
        let cancelled = false;
        if (!loaded.current)
            setLoading(true);
        void (async () => {
            try {
                const list = await fetchPipelineCatalog(apiBaseUrl, idToken);
                if (cancelled || !alive.current)
                    return;
                loaded.current = true;
                setEntries(list);
                setError(undefined);
            }
            catch (err) {
                if (cancelled || !alive.current)
                    return;
                setError(err instanceof Error ? err.message : String(err));
            }
            finally {
                if (!cancelled && alive.current)
                    setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [enabled, apiBaseUrl, idToken, tick]);
    // Live: the firehose. Resubscribed on every session epoch — a reconnect is a
    // new connection that has subscribed to nothing.
    (0, react_1.useEffect)(() => {
        if (!enabled || !send || !onMessage)
            return;
        send({ service: 'pipeline', action: 'subscribe', channel: exports.PIPELINE_ALL_CHANNEL });
        const unregister = onMessage((frame) => {
            const event = (0, catalog_1.runEventFromFrame)(frame);
            if (!event)
                return;
            setEntries((prev) => (0, catalog_1.mergeRunEvent)(prev, event));
        });
        return () => {
            unregister();
            send({ service: 'pipeline', action: 'unsubscribe', channel: exports.PIPELINE_ALL_CHANNEL });
        };
    }, [enabled, send, onMessage, epoch]);
    // A reconnect may have dropped frames: one refresh per new epoch after the first.
    const seenEpoch = (0, react_1.useRef)(undefined);
    (0, react_1.useEffect)(() => {
        if (epoch === undefined)
            return;
        if (seenEpoch.current === undefined) {
            seenEpoch.current = epoch;
            return;
        }
        if (epoch === seenEpoch.current)
            return;
        seenEpoch.current = epoch;
        if (loaded.current)
            refresh();
    }, [epoch, refresh]);
    const summaries = (0, react_1.useMemo)(() => (0, catalog_1.summarizeAll)(entries), [entries]);
    const groups = (0, react_1.useCallback)((by = 'workType') => (0, catalog_1.groupCatalog)(summaries, by), [summaries]);
    return { entries, summaries, groups, loading, error, refresh };
}
//# sourceMappingURL=usePipelineCatalog.js.map