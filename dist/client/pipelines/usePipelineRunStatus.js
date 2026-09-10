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
//
// A card can EXPAND: `details` carries the run's steps (ordered, labelled, with
// a status each), the document it worked on (id, title, a snippet), and the
// ops the apply step emitted — derived from the snapshot's step outputs and
// kept current by step frames. Details are only ever added to, never cleared
// by a sparser snapshot.
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
exports.stepTimelineLabel = stepTimelineLabel;
exports.stepsFromSnapshot = stepsFromSnapshot;
exports.opsFromApplyOutput = opsFromApplyOutput;
exports.snippetFromOutline = snippetFromOutline;
exports.documentFromOutputs = documentFromOutputs;
exports.mergeDetails = mergeDetails;
exports.detailsFromSnapshot = detailsFromSnapshot;
exports.statusFromSnapshot = statusFromSnapshot;
exports.enrichTerminalStatus = enrichTerminalStatus;
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
/** The snapshot's steps as a list, each carrying its id (the store keys them by node id; older shapes carried an array). */
function stepListOf(snap) {
    return Array.isArray(snap.steps) ? snap.steps : Object.entries(snap.steps ?? {}).map(([id, st]) => ({ stepId: id, ...st }));
}
/** An error's message, whether the record carried a string or `{ message }`. */
function errorMessage(err) {
    if (typeof err === 'string' && err)
        return err;
    const m = err?.message;
    return typeof m === 'string' && m ? m : undefined;
}
/** The message of a failed run: the run's own error, then the failed step's, then its last attempt's. */
function failureMessage(snap, stepList) {
    const own = errorMessage(snap.error);
    if (own)
        return own;
    const failed = stepList.find((s) => s.status === 'failed') ?? stepList.find((s) => s.error !== undefined);
    if (!failed)
        return undefined;
    const attempts = failed.attempts ?? [];
    return errorMessage(failed.error) ?? errorMessage(attempts[attempts.length - 1]?.error);
}
// ---------------------------------------------------------------------------
// Details — what an expanded card shows
// ---------------------------------------------------------------------------
const OP_TEXT_MAX = 140;
const SNIPPET_MAX = 200;
function truncate(text, max) {
    return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
/** The step's label for a timeline: the narration without its trailing ellipsis. */
function stepTimelineLabel(stepId, pipelineId, tables = {}) {
    return stepLabelFor(stepId, pipelineId, tables).replace(/(\.{3}|…)+\s*$/u, '').trimEnd() || stepId;
}
function stepStatusOf(raw, running) {
    if (running)
        return 'running';
    switch (raw) {
        case 'awaiting':
        case 'running':
        case 'completed':
        case 'failed':
        case 'skipped': return raw;
        case 'success': return 'completed';
        case 'error': return 'failed';
        default: return 'pending';
    }
}
/**
 * The snapshot's steps in the order a person reads them: the trigger first,
 * then by `startedAt` among the steps that have one — a step without a
 * timestamp keeps its place in the record. The definition's node order is
 * not known here.
 */
function stepsFromSnapshot(snap, pipelineId, tables = {}) {
    const list = stepListOf(snap).map((s) => ({ ...s, id: s.stepId ?? s.nodeId ?? '' })).filter((s) => s.id);
    if (list.length === 0)
        return undefined;
    const trigger = list.filter((s) => s.id === 'trigger');
    const rest = list.filter((s) => s.id !== 'trigger');
    const stamped = rest.filter((s) => typeof s.startedAt === 'string').sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    let next = 0;
    const ordered = rest.map((s) => (typeof s.startedAt === 'string' ? stamped[next++] : s));
    const current = new Set(snap.currentStepIds ?? []);
    return [...trigger, ...ordered].map((s) => ({
        id: s.id,
        label: stepTimelineLabel(s.id, pipelineId, tables),
        status: stepStatusOf(s.status, current.has(s.id) && s.status !== 'awaiting' && s.status !== 'completed' && s.status !== 'failed'),
    }));
}
/** platform-api's DocOp objects, flattened for a card: text cut short, only the fields that name what happened. */
function opsFromApplyOutput(applyOutput) {
    const raw = applyOutput?.ops;
    if (!Array.isArray(raw))
        return undefined;
    const ops = [];
    for (const item of raw) {
        const o = (item ?? {});
        if (typeof o.op !== 'string' || !o.op)
            continue;
        const out = { op: o.op };
        if (typeof o.text === 'string')
            out.text = truncate(o.text, OP_TEXT_MAX);
        if (typeof o.index === 'number')
            out.index = o.index;
        if (typeof o.macroName === 'string' && o.macroName)
            out.macroName = o.macroName;
        if (typeof o.typeName === 'string' && o.typeName)
            out.typeName = o.typeName;
        if (typeof o.reason === 'string' && o.reason)
            out.reason = truncate(o.reason, OP_TEXT_MAX);
        ops.push(out);
    }
    return ops;
}
/**
 * A snippet of the document from the read step's outline — `title: …` dropped,
 * each `#N kind(h2)(macro): ` prefix stripped, `(empty)` lines skipped — cut
 * to ~200 chars.
 */
function snippetFromOutline(outline) {
    if (typeof outline !== 'string' || !outline.trim())
        return undefined;
    const lines = outline
        .split('\n')
        .filter((line) => !/^title:\s/.test(line))
        .map((line) => line.replace(/^#\d+\s+[^:]*:\s*/, '').trim())
        .filter((line) => line && line !== '(empty)');
    const text = lines.join(' ').replace(/\s+/g, ' ').trim();
    return text ? truncate(text, SNIPPET_MAX) : undefined;
}
/** The document a run worked on, from the trigger/context/apply output; title and snippet from the read step, falling back to what apply wrote. */
function documentFromOutputs(outputs, context) {
    const o = outputs ?? {};
    const step = (id) => (o[id] ?? {});
    const trigger = step('trigger');
    const read = step('read');
    const apply = step('apply');
    const id = firstString(trigger.documentId, ...(context ? [context.documentId, context.trigger?.documentId, context.input?.documentId] : []), apply.documentId, read.documentId);
    if (!id)
        return undefined;
    const title = firstString(read.documentTitle, apply.title, context?.documentTitle);
    const firstAppend = (opsFromApplyOutput(apply) ?? []).find((op) => (op.op === 'appendBlock' || op.op === 'insertBlock') && op.text);
    const snippet = snippetFromOutline(read.documentOutline) ?? (firstAppend?.text ? truncate(firstAppend.text, SNIPPET_MAX) : undefined);
    return { id, ...(title ? { title } : {}), ...(snippet ? { snippet } : {}) };
}
/** `next` laid over `prev`, field by field — a field the newer source lacks keeps the older value. Never clears. */
function mergeDetails(prev, next) {
    if (!next)
        return prev;
    if (!prev)
        return next;
    const merged = { ...prev };
    if (next.steps && next.steps.length > 0)
        merged.steps = next.steps;
    if (next.ops)
        merged.ops = next.ops;
    if (next.document)
        merged.document = { ...(prev.document ?? {}), ...next.document };
    if (next.startedAt)
        merged.startedAt = next.startedAt;
    if (next.completedAt)
        merged.completedAt = next.completedAt;
    if (next.error)
        merged.error = next.error;
    return merged;
}
/** The expanded card's details from a run snapshot, laid over what was already known. */
function detailsFromSnapshot(snap, prev, pipelineId, tables = {}) {
    const stepList = stepListOf(snap);
    const outputs = Object.fromEntries(stepList.map((s) => [s.stepId ?? s.nodeId ?? '', s.output]));
    const context = { ...(snap.trigger ? { trigger: snap.trigger } : {}), ...(snap.context ?? {}) };
    const status = String(snap.status ?? '');
    const next = {};
    const steps = stepsFromSnapshot(snap, pipelineId, tables);
    if (steps)
        next.steps = steps;
    const ops = opsFromApplyOutput(outputs.apply);
    if (ops)
        next.ops = ops;
    const document = documentFromOutputs(outputs, context);
    if (document)
        next.document = document;
    if (typeof snap.startedAt === 'string' && snap.startedAt)
        next.startedAt = snap.startedAt;
    if (typeof snap.completedAt === 'string' && snap.completedAt)
        next.completedAt = snap.completedAt;
    const error = status === 'failed' || status === 'cancelled' ? failureMessage(snap, stepList) : errorMessage(snap.error);
    if (error)
        next.error = error;
    return mergeDetails(prev, Object.keys(next).length > 0 ? next : undefined);
}
/** One step's status changed in a frame: update it in place, or add it when the timeline had not seen it. */
function withStepStatus(details, stepId, status, pipelineId, tables = {}) {
    if (!stepId)
        return details;
    const steps = details?.steps ?? [];
    const idx = steps.findIndex((s) => s.id === stepId);
    const nextSteps = idx >= 0
        ? steps.map((s, i) => (i === idx ? { ...s, status } : s))
        : [...steps, { id: stepId, label: stepTimelineLabel(stepId, pipelineId, tables), status }];
    return { ...(details ?? {}), steps: nextSteps };
}
/** What a live frame adds to the details: a step's status, the apply ops, the document, an error. */
function detailsFromEvent(eventType, p, prev, pipelineId, tables = {}) {
    const stepId = typeof p.stepId === 'string' ? p.stepId : '';
    const at = typeof p.at === 'string' ? p.at : undefined;
    switch (eventType) {
        case 'pipeline.run.started': return at ? mergeDetails(prev, { startedAt: at }) : prev;
        case 'pipeline.step.started': return withStepStatus(prev, stepId, 'running', pipelineId, tables);
        case 'pipeline.step.skipped': return withStepStatus(prev, stepId, 'skipped', pipelineId, tables);
        case 'pipeline.approval.requested': return withStepStatus(prev, stepId || 'approve', 'awaiting', pipelineId, tables);
        case 'pipeline.step.completed': {
            const base = withStepStatus(prev, stepId, 'completed', pipelineId, tables);
            const outputs = stepId ? { [stepId]: p.output } : {};
            const patch = {};
            if (stepId === 'apply') {
                const ops = opsFromApplyOutput(p.output);
                if (ops)
                    patch.ops = ops;
            }
            const document = documentFromOutputs(outputs, p);
            if (document)
                patch.document = document;
            return mergeDetails(base, Object.keys(patch).length > 0 ? patch : undefined);
        }
        case 'pipeline.step.failed': {
            const base = withStepStatus(prev, stepId, 'failed', pipelineId, tables);
            const error = errorMessage(p.error);
            return mergeDetails(base, error ? { error } : undefined);
        }
        case 'pipeline.run.failed': {
            const error = errorMessage(p.error);
            const nodeId = p.error?.nodeId;
            const base = typeof nodeId === 'string' && nodeId && !nodeId.startsWith('(') ? withStepStatus(prev, nodeId, 'failed', pipelineId, tables) : prev;
            const patch = { ...(error ? { error } : {}), ...(at ? { completedAt: at } : {}) };
            return mergeDetails(base, Object.keys(patch).length > 0 ? patch : undefined);
        }
        case 'pipeline.run.completed': {
            const outputs = outputsOfContext(p.output);
            const patch = {};
            const ops = opsFromApplyOutput(outputs?.apply);
            if (ops)
                patch.ops = ops;
            const document = documentFromOutputs(outputs, { ...p, ...(p.output ?? {}) });
            if (document)
                patch.document = document;
            if (at)
                patch.completedAt = at;
            const error = p.status === 'failed' || p.status === 'cancelled' ? errorMessage(p.error) : undefined;
            if (error)
                patch.error = error;
            return mergeDetails(prev, Object.keys(patch).length > 0 ? patch : undefined);
        }
        default: return prev;
    }
}
/** `applied === 0` on the apply step: the run changed nothing (the model chose `skip`, or there was nothing to do). */
function isNoop(outputs) {
    const apply = (outputs?.apply ?? {});
    return apply.applied === 0;
}
/** A card is only a placeholder when nobody has said anything specific yet. */
const PLACEHOLDER_DETAILS = new Set(['Done', 'The run failed', undefined]);
/** The card's status from a run snapshot; `undefined` when the snapshot says nothing new (pending). */
function statusFromSnapshot(snap, prev, pipelineId, tables = {}) {
    const phase = phaseFromSnapshot(snap, prev, pipelineId, tables);
    if (!phase)
        return undefined;
    const details = detailsFromSnapshot(snap, prev?.details, pipelineId, tables);
    return details ? { ...phase, details } : phase;
}
function phaseFromSnapshot(snap, prev, pipelineId, tables = {}) {
    const status = String(snap.status ?? '');
    const stepList = stepListOf(snap);
    const outputs = Object.fromEntries(stepList.map((s) => [s.stepId ?? s.nodeId ?? '', s.output]));
    if (status === 'completed') {
        const result = resultOf(snap, stepList);
        const base = {
            phase: 'completed',
            detail: runStatusDetail(outputs) ?? 'Done',
            ...(result !== undefined ? { result } : {}),
            ...(isNoop(outputs) ? { noop: true } : {}),
        };
        // The snapshot's review wins; a snapshot that has not caught up yet must not clear one already learned from a frame.
        return withReview(base, suggestionOf(outputs, { ...(snap.trigger ? { trigger: snap.trigger } : {}), ...(snap.context ?? {}) }) ?? prev?.suggestion, reviewOf(snap.review) ?? prev?.review);
    }
    if (status === 'rejected')
        return { phase: 'rejected', detail: rejectedDetail(snap.rejection) };
    if (status === 'failed' || status === 'cancelled')
        return { phase: 'failed', detail: failureMessage(snap, stepList) ?? 'The run failed' };
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
/**
 * A terminal status learned from a frame, filled in from the snapshot that
 * arrives after it: a placeholder line ("Done" / "The run failed") gives way
 * to the snapshot's, a missing result/suggestion/review/noop is taken, and
 * the details merge. The phase itself is never walked back. Returns `cur`
 * itself when nothing changed.
 */
function enrichTerminalStatus(cur, snap, pipelineId, tables = {}) {
    const fromSnap = statusFromSnapshot(snap, cur, pipelineId, tables);
    const samePhase = fromSnap?.phase === cur.phase;
    const review = cur.review ?? (samePhase ? fromSnap?.review : reviewOf(snap.review));
    const suggestion = cur.suggestion ?? (cur.phase === 'completed' ? fromSnap?.suggestion : undefined);
    const details = mergeDetails(cur.details, fromSnap?.details ?? detailsFromSnapshot(snap, undefined, pipelineId, tables));
    const next = withReview({ ...cur }, suggestion, review);
    if (samePhase && fromSnap) {
        if (PLACEHOLDER_DETAILS.has(cur.detail) && fromSnap.detail && !PLACEHOLDER_DETAILS.has(fromSnap.detail) && !review)
            next.detail = fromSnap.detail;
        if (next.result === undefined && fromSnap.result !== undefined)
            next.result = fromSnap.result;
        if (next.noop === undefined && fromSnap.noop)
            next.noop = true;
    }
    if (details)
        next.details = details;
    const changed = next.detail !== cur.detail || next.result !== cur.result || next.noop !== cur.noop || next.review !== cur.review || next.suggestion !== cur.suggestion
        || JSON.stringify(next.details) !== JSON.stringify(cur.details);
    return changed ? next : cur;
}
/** The card's status after one live frame; `undefined` when the frame is not about the card. */
function statusFromEvent(eventType, p, prev, pipelineId, tables = {}) {
    const type = normalizeEventType(eventType);
    const details = detailsFromEvent(type, p, prev?.details, pipelineId, tables);
    const phase = phaseFromEvent(type, p, prev, pipelineId, tables);
    if (phase)
        return details ? { ...phase, details } : phase;
    // A frame that says nothing about the phase can still move a step in the timeline.
    if (details && prev && details !== prev.details)
        return { ...prev, details };
    return undefined;
}
function phaseFromEvent(type, p, prev, pipelineId, tables = {}) {
    const stepId = typeof p.stepId === 'string' ? p.stepId : '';
    switch (type) {
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
                // The apply step's verdict travels to the completion frame: a skip stays a skip.
                return { phase: 'running', stepLabel: 'Finishing', detail: runStatusDetail(outputs), ...(suggestion ? { suggestion } : {}), ...(isNoop(outputs) ? { noop: true } : {}) };
            }
            return undefined;
        }
        case 'pipeline.run.completed': {
            if (p.status === 'rejected')
                return { phase: 'rejected', detail: rejectedDetail(p.rejection) };
            // A completion frame that says the run failed IS a failure, whatever the event's name.
            if (p.status === 'failed' || p.status === 'cancelled')
                return { phase: 'failed', detail: errorMessage(p.error) ?? 'The run failed' };
            const result = resultOf(p, []);
            const outputs = outputsOfContext(p.output);
            const noop = isNoop(outputs) || (prev?.phase === 'running' && prev.noop === true);
            const base = {
                phase: 'completed',
                detail: (prev?.phase === 'running' ? prev.detail : undefined) ?? runStatusDetail(outputs) ?? 'Done',
                ...(result !== undefined ? { result } : {}),
                ...(noop ? { noop: true } : {}),
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
                            // stale snapshot — but the snapshot fills the card in: a pending
                            // suggestion settles, a placeholder line gives way, details land.
                            const next = enrichTerminalStatus(cur, snap, r.pipelineId, tablesRef.current);
                            return next === cur ? prev : { ...prev, [r.runId]: next };
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