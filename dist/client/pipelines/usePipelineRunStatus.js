"use strict";
// realtime-modules/src/client/pipelines/usePipelineRunStatus.ts
//
// Where a pipeline run is, for a card in a conversation. Ported from the
// realtime-examples app hook (frontend/src/hooks/useAgentRunStatus.ts) so any
// host that embeds the chat gets live agent-run cards without copying app code.
//
// Two sources, merged per run:
//   - Live: the gateway's `pipeline:event` frames. The firehose (`pipeline:all`)
//     is subscribed as well as each run's own channel, because a per-run
//     subscription lands AFTER the run has started and misses its first frames.
//   - Durable: `GET {apiBaseUrl}/api/pipelines/:pipelineId/runs/:runId`, once
//     on mount and then every `pollMs` while the run is not terminal. Frames
//     can be missed (a reconnect drops one); the run store is the truth.
//
// The transport is injectable so an app that owns its own socket can hand in
// `{ send, onMessage }`; an rm-native host mounted under GatewaySocketProvider
// passes nothing and the hook reads the gateway context itself.
//
// A run that SUGGESTED its edit (apply step `mode: 'suggest'`) completes with a
// `suggestion` and waits on a person: the `pipeline.run.reviewed` frame, or the
// snapshot's `review`, settles it to "Accepted by …" / "Rejected by …".
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_REVIEW_POLL_MS = exports.DEFAULT_POLL_MS = exports.DEFAULT_PIPELINE_STEP_LABELS = exports.DEFAULT_STEP_LABELS = void 0;
exports.stepLabelFor = stepLabelFor;
exports.retryLabel = retryLabel;
exports.requestPipelineRun = requestPipelineRun;
exports.approvePipelineRun = approvePipelineRun;
exports.reviewPipelineRun = reviewPipelineRun;
exports.runStatusDetail = runStatusDetail;
exports.reviewDetail = reviewDetail;
exports.reviewOf = reviewOf;
exports.suggestionOf = suggestionOf;
exports.isAwaitingReview = isAwaitingReview;
exports.normalizeEventType = normalizeEventType;
exports.statusFromSnapshot = statusFromSnapshot;
exports.statusFromEvent = statusFromEvent;
exports.usePipelineRunStatus = usePipelineRunStatus;
const react_1 = require("react");
const GatewaySocketProvider_1 = require("../GatewaySocketProvider");
/** The narration people see while a step runs, keyed by step id. */
exports.DEFAULT_STEP_LABELS = {
    // document-agent-edit / document-transform
    read: 'Reading the document…',
    plan: 'Deciding what to change (Haiku)…',
    review: 'Checking the plan',
    approve: 'Waiting for approval',
    apply: 'Applying the edit as a collaborator…',
    // recording-finalize
    resolve: 'Finding the call',
    persist: 'Saving the recording',
    'await-compose': 'Waiting for the composed file',
    announce: 'Posting to the conversation',
    'start-transcription': 'Starting transcription',
    // call-transcription
    transcribe: 'Transcribing the audio',
    'merge-reactions': 'Merging reactions',
    store: 'Storing the transcript',
    summarize: 'Summarising the call (Haiku)…',
    'store-summary': 'Storing the summary',
    publish: 'Publishing the transcript',
    // conversation-summarize
    'read-history': 'Reading the conversation',
};
/** Steps whose ids collide across pipelines read differently per pipeline. */
exports.DEFAULT_PIPELINE_STEP_LABELS = {
    'conversation-summarize': { plan: 'Writing the summary (Haiku)…', apply: 'Writing the page as a collaborator…', publish: 'Posting to the conversation' },
    'diagram-generate': { plan: 'Sketching the diagram (Haiku)…', apply: 'Drawing the board', publish: 'Posting to the conversation' },
};
/** The label for a step: the pipeline-specific one, then the general one, then the raw id. */
function stepLabelFor(stepId, pipelineId, tables = {}) {
    const perPipeline = { ...exports.DEFAULT_PIPELINE_STEP_LABELS, ...(tables.pipelineStepLabels ?? {}) };
    const general = { ...exports.DEFAULT_STEP_LABELS, ...(tables.stepLabels ?? {}) };
    return (pipelineId ? perPipeline[pipelineId]?.[stepId] : undefined) ?? general[stepId] ?? stepId;
}
/** "Retrying — attempt 2 of 3", or without the "of 3" when the budget is not known. */
function retryLabel(attemptNumber, maxAttempts) {
    return `Retrying — attempt ${attemptNumber}${typeof maxAttempts === 'number' && maxAttempts > 0 ? ` of ${maxAttempts}` : ''}`;
}
async function errorFrom(res, fallback) {
    const body = (await res.json().catch(() => ({})));
    return Object.assign(new Error(body.error || body.message || `${fallback} (${res.status})`), { status: res.status });
}
/**
 * Generic authenticated POST to platform-api. `path` is appended to
 * `apiBaseUrl` verbatim (e.g. `/api/documents/doc-1/agent-edit`); the JSON
 * body comes back typed as the caller says it does.
 */
async function requestPipelineRun(apiBaseUrl, idToken, path, body) {
    const res = await fetch(`${apiBaseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}) },
        body: JSON.stringify(body ?? {}),
    });
    if (!res.ok)
        throw await errorFrom(res, 'Could not start the run');
    return (await res.json());
}
/** Approve or reject the step a run is waiting on. Resolves when platform-api has recorded it. */
async function approvePipelineRun(apiBaseUrl, idToken, input) {
    const res = await fetch(`${apiBaseUrl}/api/pipelines/${encodeURIComponent(input.runId)}/approvals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}) },
        body: JSON.stringify({ stepId: input.stepId, decision: input.decision, ...(input.comment ? { comment: input.comment } : {}) }),
    });
    if (!res.ok)
        throw await errorFrom(res, `Could not ${input.decision} the run`);
}
/**
 * Accept or reject the suggestions a completed run left in a document.
 * Resolves with platform-api's record; throws a `PipelineRunRequestError`
 * on a non-2xx — `status === 409` means someone already reviewed it.
 */
async function reviewPipelineRun(apiBaseUrl, idToken, input) {
    const { pipelineId, runId, ...body } = input;
    const res = await fetch(`${apiBaseUrl}/api/pipelines/${encodeURIComponent(pipelineId)}/runs/${encodeURIComponent(runId)}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}) },
        body: JSON.stringify(Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined))),
    });
    if (!res.ok)
        throw await errorFrom(res, `Could not ${input.decision} the suggestions`);
    return (await res.json());
}
// ---------------------------------------------------------------------------
// Detail lines
// ---------------------------------------------------------------------------
/**
 * The one line a finished card shows. `outputs` is keyed by step id (the run's
 * final context carries them under `steps`; the snapshot path builds the same
 * map). Recording and transcription runs finish on their publish step; the
 * document runs on their apply step.
 */
function runStatusDetail(outputs) {
    const o = outputs ?? {};
    const step = (id) => (o[id] ?? {});
    const publish = step('publish');
    if (typeof publish.words === 'number')
        return publish.words > 0 ? `Transcript ready — ${publish.words} word${publish.words === 1 ? '' : 's'}${publish.appended ? ', added to the document' : ''}` : 'No speech was found';
    const announce = step('announce');
    if (typeof announce.posted === 'boolean')
        return 'Recording ready';
    const apply = step('apply');
    if (typeof apply.title === 'string')
        return `Renamed to “${apply.title}”`;
    if (typeof apply.applied === 'number') {
        if (apply.applied <= 0)
            return typeof apply.reason === 'string' ? apply.reason : 'No changes were needed';
        return `${apply.applied} change${apply.applied === 1 ? '' : 's'} ${apply.mode === 'suggest' ? 'suggested' : 'applied'}`;
    }
    return undefined;
}
/** "Accepted by Grace" / "Rejected by Grace" — the name, falling back to the id. */
function reviewDetail(review) {
    return `${review.decision === 'accept' ? 'Accepted' : 'Rejected'} by ${review.byName || review.by}`;
}
/** A well-formed review record from a snapshot's `review` or a `pipeline.run.reviewed` payload; `undefined` otherwise. */
function reviewOf(raw) {
    const r = (raw ?? {});
    if (r.decision !== 'accept' && r.decision !== 'reject')
        return undefined;
    const by = typeof r.by === 'string' ? r.by : '';
    const at = typeof r.at === 'string' ? r.at : new Date(0).toISOString();
    return { decision: r.decision, by, at, ...(typeof r.byName === 'string' && r.byName ? { byName: r.byName } : {}) };
}
/** The first string among the candidates — the run's documentId lives in different places per source. */
function firstString(...candidates) {
    return candidates.find((c) => typeof c === 'string' && c.length > 0);
}
/** The document a run worked on: the trigger, then the context, then the apply output. */
function documentIdOf(context, apply) {
    const c = context ?? {};
    const trigger = (c.trigger ?? {});
    const input = (c.input ?? {});
    return firstString(c.documentId, trigger.documentId, input.documentId, apply.documentId);
}
/** The suggestion a completed run left behind, when its apply step ran in `mode: 'suggest'`. */
function suggestionOf(outputs, context) {
    const apply = (outputs?.apply ?? {});
    if (apply.mode !== 'suggest' || typeof apply.suggestionKey !== 'string' || !apply.suggestionKey)
        return undefined;
    const documentId = documentIdOf(context, apply);
    return { key: apply.suggestionKey, applied: typeof apply.applied === 'number' ? apply.applied : 0, ...(documentId ? { documentId } : {}) };
}
/** A completed status with its suggestion and review folded in — the review's line wins over the run's own. */
function withReview(base, suggestion, review) {
    return {
        ...base,
        ...(suggestion ? { suggestion } : {}),
        ...(review ? { review, detail: reviewDetail(review) } : {}),
    };
}
function outputsOfContext(output) {
    const o = (output ?? {});
    return o.steps ?? o;
}
/** Why the run paused, as the review step said it. */
function approvalReason(context, outputs) {
    const review = (outputs?.review ?? {});
    if (typeof review.reason === 'string' && review.reason)
        return review.reason;
    return typeof context?.reason === 'string' && context.reason ? context.reason : undefined;
}
/** "Rejected by Grace" when the decision names someone; a timeout or a nameless record is just "Rejected". */
function rejectedDetail(rejection) {
    const r = (rejection ?? {});
    const who = typeof r.displayName === 'string' && r.displayName ? r.displayName : (typeof r.userId === 'string' && r.userId && r.userId !== 'system:timeout' ? r.userId : undefined);
    const base = who ? `Rejected by ${who}` : (r.userId === 'system:timeout' ? 'Rejected — nobody approved in time' : 'Rejected');
    return typeof r.comment === 'string' && r.comment ? `${base} — ${r.comment}` : base;
}
/**
 * The run's result, when the record carries one. A top-level `result` wins;
 * otherwise the final step's output (the last step in the list that finished
 * with an output) — that is what the pipeline produced.
 */
function resultOf(snapOrFrame, stepList) {
    if (snapOrFrame.result !== undefined)
        return snapOrFrame.result;
    const ctx = snapOrFrame.output;
    if (ctx && ctx.result !== undefined)
        return ctx.result;
    for (let i = stepList.length - 1; i >= 0; i -= 1) {
        const s = stepList[i];
        if (s.output !== undefined && (s.status === undefined || s.status === 'completed'))
            return s.output;
    }
    return undefined;
}
const TERMINAL = new Set(['completed', 'failed', 'rejected']);
/** A completed run whose suggestions nobody has accepted or rejected yet — terminal for the phase, not for the card. */
function isAwaitingReview(status) {
    return status?.phase === 'completed' && !!status.suggestion && !status.review;
}
/** `pipeline:run:completed` and `pipeline.run.completed` are the same event. */
function normalizeEventType(eventType) {
    if (typeof eventType !== 'string' || !eventType)
        return undefined;
    return eventType.replace(/:/g, '.');
}
/** The card's status from a run snapshot; `undefined` when the snapshot says nothing new (pending). */
function statusFromSnapshot(snap, prev, pipelineId, tables = {}) {
    const status = String(snap.status ?? '');
    // The snapshot keys steps by node id; older shapes carried an array.
    const stepList = Array.isArray(snap.steps) ? snap.steps : Object.entries(snap.steps ?? {}).map(([id, st]) => ({ stepId: id, ...st }));
    const outputs = Object.fromEntries(stepList.map((s) => [s.stepId ?? s.nodeId ?? '', s.output]));
    if (status === 'completed') {
        const result = resultOf(snap, stepList);
        const base = { phase: 'completed', detail: runStatusDetail(outputs) ?? 'Done', ...(result !== undefined ? { result } : {}) };
        // The snapshot's review wins; a snapshot that has not caught up yet must not clear one already learned from a frame.
        return withReview(base, suggestionOf(outputs, { ...(snap.trigger ? { trigger: snap.trigger } : {}), ...(snap.context ?? {}) }) ?? prev?.suggestion, reviewOf(snap.review) ?? prev?.review);
    }
    if (status === 'rejected')
        return { phase: 'rejected', detail: rejectedDetail(snap.rejection) };
    if (status === 'failed' || status === 'cancelled')
        return { phase: 'failed', detail: typeof snap.error === 'string' ? snap.error : snap.error?.message ?? 'The run failed' };
    if (status === 'awaiting_approval') {
        const step = stepList.find((s) => s.status === 'awaiting') ?? stepList.find((s) => (s.stepId ?? s.nodeId) === 'approve');
        return { phase: 'awaiting_approval', approvalStepId: step?.stepId ?? step?.nodeId ?? 'approve', detail: approvalReason(snap.context, outputs) };
    }
    if (status === 'running') {
        // The run store knows which step is in flight — narrate it, and a retry as a retry.
        const currentId = snap.currentStepIds?.[0] ?? stepList.find((s) => s.status === 'running')?.stepId;
        const current = currentId ? stepList.find((s) => (s.stepId ?? s.nodeId) === currentId) : undefined;
        const attempts = current?.attempts ?? [];
        const latest = attempts.length > 0 ? attempts[attempts.length - 1]?.attemptNumber ?? attempts.length : 0;
        if (currentId && latest > 1) {
            const max = snap.pipelineDefinitionSnapshot?.nodes?.find((n) => n.id === currentId)?.data?.retryPolicy?.maxAttempts;
            return { phase: 'running', stepLabel: `${stepLabelFor(currentId, pipelineId, tables)} · ${retryLabel(latest, max)}` };
        }
        return { phase: 'running', stepLabel: currentId ? stepLabelFor(currentId, pipelineId, tables) : prev?.stepLabel };
    }
    return undefined;
}
/** The card's status after one live frame; `undefined` when the frame is not about the card. */
function statusFromEvent(eventType, p, prev, pipelineId, tables = {}) {
    const stepId = typeof p.stepId === 'string' ? p.stepId : '';
    switch (normalizeEventType(eventType)) {
        case 'pipeline.run.started': return { phase: 'running' };
        case 'pipeline.step.started': return { phase: 'running', stepLabel: stepLabelFor(stepId, pipelineId, tables) };
        case 'pipeline.step.attempt.started': {
            const n = typeof p.attemptNumber === 'number' ? p.attemptNumber : 1;
            if (n <= 1)
                return undefined;
            return { phase: 'running', stepLabel: `${stepLabelFor(stepId, pipelineId, tables)} · ${retryLabel(n, typeof p.maxAttempts === 'number' ? p.maxAttempts : undefined)}` };
        }
        case 'pipeline.approval.requested':
            return { phase: 'awaiting_approval', approvalStepId: stepId || 'approve', detail: prev?.detail };
        case 'pipeline.step.completed': {
            if (stepId === 'review') {
                const out = (p.output ?? {});
                // The review's reason is what the approval card will say; keep it around for the request frame.
                return out.needsApproval === true ? { phase: 'running', stepLabel: stepLabelFor('approve', pipelineId, tables), detail: typeof out.reason === 'string' ? out.reason : undefined } : undefined;
            }
            if (stepId === 'apply' || stepId === 'publish' || stepId === 'announce') {
                const outputs = { [stepId]: p.output };
                const suggestion = suggestionOf(outputs, p);
                return { phase: 'running', stepLabel: 'Finishing', detail: runStatusDetail(outputs), ...(suggestion ? { suggestion } : {}) };
            }
            return undefined;
        }
        case 'pipeline.run.completed': {
            if (p.status === 'rejected')
                return { phase: 'rejected', detail: rejectedDetail(p.rejection) };
            const result = resultOf(p, []);
            const outputs = outputsOfContext(p.output);
            const base = {
                phase: 'completed',
                detail: (prev?.phase === 'running' ? prev.detail : undefined) ?? runStatusDetail(outputs) ?? 'Done',
                ...(result !== undefined ? { result } : {}),
            };
            return withReview(base, suggestionOf(outputs, { ...p, ...(p.output ?? {}) }) ?? prev?.suggestion, prev?.review);
        }
        case 'pipeline.run.reviewed': {
            const review = reviewOf(p);
            if (!review)
                return undefined;
            const documentId = firstString(p.documentId, prev?.suggestion?.documentId);
            const suggestion = prev?.suggestion
                ? { ...prev.suggestion, ...(documentId ? { documentId } : {}) }
                : (typeof p.suggestionKey === 'string' && p.suggestionKey ? { key: p.suggestionKey, applied: 0, ...(documentId ? { documentId } : {}) } : undefined);
            return withReview({ ...(prev ?? {}), phase: 'completed' }, suggestion, review);
        }
        case 'pipeline.run.failed':
        case 'pipeline.step.failed': return { phase: 'failed', detail: typeof p.error === 'string' ? p.error : (typeof p.error?.message === 'string' ? p.error.message : 'The run failed') };
        default: return undefined;
    }
}
// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------
exports.DEFAULT_POLL_MS = 1500;
exports.DEFAULT_REVIEW_POLL_MS = 15_000;
function usePipelineRunStatus(runs, opts) {
    const { apiBaseUrl, idToken, transport, stepLabels, pipelineStepLabels } = opts;
    const pollMs = opts.pollMs ?? exports.DEFAULT_POLL_MS;
    const reviewPollMs = opts.reviewPollMs ?? exports.DEFAULT_REVIEW_POLL_MS;
    // Hooks cannot be conditional, so the context is always read; it is only
    // USED when the host handed in no transport of its own.
    const gateway = (0, GatewaySocketProvider_1.useGatewayOptional)();
    const send = transport === null ? undefined : transport ? transport.send : gateway?.sendMessage;
    const onMessage = transport === null ? undefined : transport ? transport.onMessage : gateway?.onMessage;
    const [statuses, setStatuses] = (0, react_1.useState)({});
    const fetched = (0, react_1.useRef)(new Set());
    const [tick, setTick] = (0, react_1.useState)(0);
    const key = runs.map((r) => r.runId).sort().join(',');
    // Label tables travel by ref so a caller passing a fresh literal each render
    // does not resubscribe the socket.
    const tablesRef = (0, react_1.useRef)({ stepLabels, pipelineStepLabels });
    tablesRef.current = { stepLabels, pipelineStepLabels };
    const runsRef = (0, react_1.useRef)(runs);
    runsRef.current = runs;
    // Live: one subscription per run in view, plus the firehose.
    (0, react_1.useEffect)(() => {
        if (runs.length === 0 || !send || !onMessage)
            return;
        send({ service: 'pipeline', action: 'subscribe', channel: 'pipeline:all' });
        for (const r of runs)
            send({ service: 'pipeline', action: 'subscribe', channel: `pipeline:run:${r.runId}` });
        const unregister = onMessage((frame) => {
            const msg = frame;
            if (!msg || msg.type !== 'pipeline:event')
                return;
            const p = msg.payload ?? {};
            const runId = typeof p.runId === 'string' ? p.runId : null;
            const run = runId ? runsRef.current.find((r) => r.runId === runId) : undefined;
            if (!runId || !run)
                return;
            const eventType = normalizeEventType(msg.eventType);
            setStatuses((prev) => {
                const next = statusFromEvent(eventType, p, prev[runId], run.pipelineId, tablesRef.current);
                return next ? { ...prev, [runId]: next } : prev;
            });
        });
        return () => {
            unregister();
            for (const r of runs)
                send({ service: 'pipeline', action: 'unsubscribe', channel: `pipeline:run:${r.runId}` });
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, send, onMessage]);
    // Once (and on every tick): the durable answer, for anyone arriving late.
    (0, react_1.useEffect)(() => {
        if (!idToken)
            return;
        for (const r of runs) {
            if (fetched.current.has(r.runId))
                continue;
            fetched.current.add(r.runId);
            void (async () => {
                try {
                    const res = await fetch(`${apiBaseUrl}/api/pipelines/${encodeURIComponent(r.pipelineId)}/runs/${encodeURIComponent(r.runId)}`, { headers: { Authorization: `Bearer ${idToken}` } });
                    if (!res.ok)
                        return;
                    const snap = (await res.json());
                    setStatuses((prev) => {
                        const cur = prev[r.runId];
                        if (TERMINAL.has(cur?.phase)) {
                            // A terminal phase learned from a frame is never walked back by a
                            // stale snapshot — but a snapshot CAN settle a pending suggestion.
                            const review = cur.review ?? reviewOf(snap.review);
                            const suggestion = cur.suggestion ?? (cur.phase === 'completed' ? statusFromSnapshot(snap, cur, r.pipelineId, tablesRef.current)?.suggestion : undefined);
                            if (review === cur.review && suggestion === cur.suggestion)
                                return prev;
                            return { ...prev, [r.runId]: withReview(cur, suggestion, review) };
                        }
                        const next = statusFromSnapshot(snap, cur, r.pipelineId, tablesRef.current);
                        return next ? { ...prev, [r.runId]: next } : prev;
                    });
                }
                catch { /* the live frames still tell the story */ }
            })();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, idToken, tick, apiBaseUrl]);
    // While a run is not terminal, re-read the snapshot every `pollMs`.
    (0, react_1.useEffect)(() => {
        if (!idToken || pollMs <= 0)
            return;
        const pending = runs.filter((r) => !TERMINAL.has(statuses[r.runId]?.phase));
        if (pending.length === 0)
            return;
        const timer = setInterval(() => {
            for (const r of pending)
                fetched.current.delete(r.runId);
            setTick((t) => t + 1);
        }, pollMs);
        return () => clearInterval(timer);
    }, [runs, statuses, idToken, pollMs]);
    // A completed suggestion waits on a person; re-read slowly until the review
    // lands (the `pipeline.run.reviewed` frame is the fast path). Reviewed = settled.
    (0, react_1.useEffect)(() => {
        if (!idToken || reviewPollMs <= 0)
            return;
        const awaiting = runs.filter((r) => isAwaitingReview(statuses[r.runId]));
        if (awaiting.length === 0)
            return;
        const timer = setInterval(() => {
            for (const r of awaiting)
                fetched.current.delete(r.runId);
            setTick((t) => t + 1);
        }, reviewPollMs);
        return () => clearInterval(timer);
    }, [runs, statuses, idToken, reviewPollMs]);
    return (0, react_1.useCallback)((runId) => statuses[runId], [statuses]);
}
exports.default = usePipelineRunStatus;
//# sourceMappingURL=usePipelineRunStatus.js.map