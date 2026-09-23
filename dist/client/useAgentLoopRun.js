"use strict";
// realtime-modules/src/client/useAgentLoopRun.ts
//
// One agent loop (platform-api `/api/agent-loops/:runId`), for a task card or
// a task strip: where it is, which step, how many steps are done, and the one
// control it really has — Stop.
//
// Two sources, like usePipelineRunStatus:
//   - Durable: `GET {apiBaseUrl}/api/agent-loops/:runId` on mount, again on
//     every live frame for the run (debounced), and every `pollMs` while the
//     loop is not over as a safety net for a missed frame.
//   - Live: the gateway's `pipeline:event` frames on
//     `pipeline:run:<executorRunId ?? runId>`. A frame is a nudge to re-read,
//     not a second source of truth — the view is the platform's.
//
// PAUSE: not offered. The platform says so in the view
// (`controls.pause === false`, `controls.pauseUnsupportedReason`) and answers
// `POST …/pause|resume` with 501. The result carries `canPause: false` and the
// reason so a UI can explain the missing button instead of rendering one that
// does nothing. When the platform grows real pause, this hook grows
// `pause()`/`resume()` behind `controls.pause`.
Object.defineProperty(exports, "__esModule", { value: true });
exports.PAUSE_UNSUPPORTED_FALLBACK = exports.DEFAULT_AGENT_LOOP_POLL_MS = void 0;
exports.agentLoopPhase = agentLoopPhase;
exports.isAgentLoopOver = isAgentLoopOver;
exports.agentLoopProgress = agentLoopProgress;
exports.useAgentLoopRun = useAgentLoopRun;
const react_1 = require("react");
const GatewaySocketProvider_1 = require("./GatewaySocketProvider");
exports.DEFAULT_AGENT_LOOP_POLL_MS = 5_000;
exports.PAUSE_UNSUPPORTED_FALLBACK = 'Pausing is not supported: a running step cannot be suspended. Stop ends the run.';
const DONE_STEP = new Set(['completed', 'succeeded', 'failed', 'skipped', 'cancelled', 'canceled']);
/** The platform's status word, folded into the phases a strip renders. */
function agentLoopPhase(status) {
    switch (status) {
        case 'planning':
        case 'pending': return 'planning';
        case 'running':
        case 'in_progress':
        case 'awaiting_approval':
        case 'paused_at_breakpoint': return 'running';
        case 'completed':
        case 'succeeded': return 'completed';
        case 'failed':
        case 'rejected': return 'failed';
        case 'cancelled':
        case 'canceled': return 'cancelled';
        case 'budget': return 'budget';
        default: return 'unknown';
    }
}
function isAgentLoopOver(phase) {
    return phase === 'completed' || phase === 'failed' || phase === 'cancelled' || phase === 'budget';
}
/** Steps done / total and the step in hand. Pure. */
function agentLoopProgress(steps) {
    const stepsTotal = steps.length;
    const stepsDone = steps.filter((step) => DONE_STEP.has(step.status)).length;
    const currentStep = steps.find((step) => step.status === 'running' || step.status === 'in_progress')
        ?? steps.find((step) => !DONE_STEP.has(step.status));
    return {
        stepsDone,
        stepsTotal,
        ...(stepsTotal > 0 ? { percent: Math.round((stepsDone / stepsTotal) * 100) } : {}),
        ...(currentStep ? { currentStep } : {}),
    };
}
function useAgentLoopRun(runId, opts) {
    const { apiBaseUrl, idToken, transport } = opts;
    const pollMs = opts.pollMs ?? exports.DEFAULT_AGENT_LOOP_POLL_MS;
    const frameDebounceMs = opts.frameDebounceMs ?? 250;
    const gateway = (0, GatewaySocketProvider_1.useGatewayOptional)();
    const send = transport === null ? undefined : transport ? transport.send : gateway?.sendMessage;
    const onMessage = transport === null ? undefined : transport ? transport.onMessage : gateway?.onMessage;
    const epoch = transport === undefined ? gateway?.sessionEpoch : undefined;
    const [loop, setLoop] = (0, react_1.useState)(undefined);
    const [loading, setLoading] = (0, react_1.useState)(true);
    const [notFound, setNotFound] = (0, react_1.useState)(false);
    const [error, setError] = (0, react_1.useState)(undefined);
    const [stopping, setStopping] = (0, react_1.useState)(false);
    const [tick, setTick] = (0, react_1.useState)(0);
    const alive = (0, react_1.useRef)(true);
    (0, react_1.useEffect)(() => { alive.current = true; return () => { alive.current = false; }; }, []);
    // A different run starts from nothing.
    (0, react_1.useEffect)(() => {
        setLoop(undefined);
        setLoading(true);
        setNotFound(false);
        setError(undefined);
    }, [runId]);
    const refresh = (0, react_1.useCallback)(() => setTick((t) => t + 1), []);
    // The durable read — on mount, on every tick (frame, poll, Stop, refresh).
    (0, react_1.useEffect)(() => {
        if (!runId || !idToken)
            return;
        let cancelled = false;
        void (async () => {
            try {
                const res = await fetch(`${apiBaseUrl}/api/agent-loops/${encodeURIComponent(runId)}`, { headers: { Authorization: `Bearer ${idToken}` } });
                if (cancelled || !alive.current)
                    return;
                if (res.status === 404) {
                    setNotFound(true);
                    setLoading(false);
                    return;
                }
                if (!res.ok) {
                    setError(`The loop could not be read (${res.status}).`);
                    setLoading(false);
                    return;
                }
                const view = (await res.json());
                if (cancelled || !alive.current)
                    return;
                setLoop({ ...view, steps: Array.isArray(view.steps) ? view.steps : [] });
                setNotFound(false);
                setError(undefined);
                setLoading(false);
            }
            catch (err) {
                if (cancelled || !alive.current)
                    return;
                setError(err instanceof Error ? err.message : String(err));
                setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [runId, idToken, apiBaseUrl, tick]);
    const phase = agentLoopPhase(loop?.status);
    const over = isAgentLoopOver(phase);
    // The executor's id is what the frames carry; the loop id is what the client holds.
    const liveId = loop?.executorRunId ?? runId ?? undefined;
    // Live: a frame for this run means "re-read soon".
    (0, react_1.useEffect)(() => {
        if (!liveId || !send || !onMessage)
            return;
        const channel = `pipeline:run:${liveId}`;
        const ids = new Set([liveId, runId].filter((id) => !!id));
        let timer = null;
        send({ service: 'pipeline', action: 'subscribe', channel });
        const unregister = onMessage((frame) => {
            const msg = frame;
            if (!msg || msg.type !== 'pipeline:event')
                return;
            const id = msg.payload?.runId;
            if (typeof id !== 'string' || !ids.has(id))
                return;
            if (timer)
                return;
            timer = setTimeout(() => { timer = null; refresh(); }, frameDebounceMs);
        });
        return () => {
            if (timer)
                clearTimeout(timer);
            unregister();
            send({ service: 'pipeline', action: 'unsubscribe', channel });
        };
    }, [liveId, runId, send, onMessage, epoch, frameDebounceMs, refresh]);
    // Safety net while the loop is live.
    (0, react_1.useEffect)(() => {
        if (!runId || !idToken || pollMs <= 0 || over || notFound)
            return;
        const timer = setInterval(refresh, pollMs);
        return () => clearInterval(timer);
    }, [runId, idToken, pollMs, over, notFound, refresh]);
    const stop = (0, react_1.useCallback)(async () => {
        if (!runId || !idToken)
            return { ok: false, error: 'Not signed in.' };
        setStopping(true);
        try {
            const res = await fetch(`${apiBaseUrl}/api/agent-loops/${encodeURIComponent(runId)}/stop`, {
                method: 'POST', headers: { Authorization: `Bearer ${idToken}`, 'content-type': 'application/json' }, body: '{}',
            });
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                return { ok: false, status: res.status, error: typeof body.error === 'string' ? body.error : `Stop failed (${res.status}).` };
            }
            return { ok: true, status: res.status };
        }
        catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
        finally {
            if (alive.current) {
                setStopping(false);
                refresh();
            }
        }
    }, [runId, idToken, apiBaseUrl, refresh]);
    const steps = (0, react_1.useMemo)(() => loop?.steps ?? [], [loop]);
    const progress = (0, react_1.useMemo)(() => agentLoopProgress(steps), [steps]);
    const canStop = !!loop && !over && (loop.controls ? loop.controls.stop : true);
    return {
        ...(loop ? { loop } : {}),
        loading,
        notFound,
        ...(error ? { error } : {}),
        phase,
        ...(loop?.status ? { status: loop.status } : {}),
        steps,
        ...progress,
        ...(loop?.startedAt ? { startedAt: loop.startedAt } : {}),
        canStop,
        stopping,
        stop,
        canPause: false,
        pauseUnsupportedReason: loop?.controls?.pauseUnsupportedReason ?? exports.PAUSE_UNSUPPORTED_FALLBACK,
        refresh,
    };
}
exports.default = useAgentLoopRun;
//# sourceMappingURL=useAgentLoopRun.js.map