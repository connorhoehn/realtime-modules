"use strict";
// realtime-modules/src/client/documents/work.ts
//
// The Documents four-pane redesign's data, as the browser reads it
// (realtime-examples `docs/design/documents-detail/PLAN.md` §2). platform-api
// owns the rows; this file mirrors their field names exactly, and holds the
// pure pieces the hooks are built from — REST helpers usable from scripts,
// the optimistic-apply rule for a work PATCH, the Work column's grouping, and
// the parser for the gateway's id-only `doc-work:*` signals.
//
// Signals carry ids and enums only (the gateway authorizes the subscription,
// but anything textual is re-read over REST behind the document grant). So a
// hook never trusts a frame's content beyond "this record changed at revision
// n": it refetches the one record.
Object.defineProperty(exports, "__esModule", { value: true });
exports.docWorkScopeChannel = exports.docWorkChannel = exports.DOC_WORK_SCOPE_CHANNEL_PREFIX = exports.DOC_WORK_CHANNEL_PREFIX = exports.RUN_DRAFT_DISPATCH_STALE_MS = exports.WORK_GROUP_ORDER = exports.WORK_STATUS_LABEL = void 0;
exports.newWorkItemId = newWorkItemId;
exports.rankAfter = rankAfter;
exports.applyWorkUpdate = applyWorkUpdate;
exports.orderedCriteria = orderedCriteria;
exports.normalizeDocumentWork = normalizeDocumentWork;
exports.workGroupOf = workGroupOf;
exports.groupWorkRows = groupWorkRows;
exports.pointsRollup = pointsRollup;
exports.normalizeWorkList = normalizeWorkList;
exports.mergeWorkIntoRow = mergeWorkIntoRow;
exports.runDraftPhase = runDraftPhase;
exports.normalizeRunDraft = normalizeRunDraft;
exports.currentRunDraft = currentRunDraft;
exports.normalizeRunEstimate = normalizeRunEstimate;
exports.fetchDocumentWork = fetchDocumentWork;
exports.patchDocumentWork = patchDocumentWork;
exports.fetchWorkList = fetchWorkList;
exports.fetchRunDrafts = fetchRunDrafts;
exports.fetchRunDraft = fetchRunDraft;
exports.putRunDraft = putRunDraft;
exports.dispatchRunDraft = dispatchRunDraft;
exports.cancelDraftRun = cancelDraftRun;
exports.fetchRunEstimate = fetchRunEstimate;
exports.docWorkSubscribeFrame = docWorkSubscribeFrame;
exports.docWorkSignalFromFrame = docWorkSignalFromFrame;
exports.acquireChannelSubscription = acquireChannelSubscription;
/** A client-made id for a criterion, a link or a run draft: ≤ 64, `[A-Za-z0-9_-]`. */
function newWorkItemId() {
    const c = globalThis.crypto;
    if (c && typeof c.randomUUID === 'function')
        return c.randomUUID();
    const hex = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
    return `${hex()}${hex()}-${hex()}-4${hex().slice(1)}-${hex()}-${hex()}${hex()}${hex()}`;
}
/** A rank strictly after `last` (or the first one) — enough for appending; drag order is the host's. */
function rankAfter(last) {
    return last ? `${last}n` : 'n';
}
/**
 * The optimistic view of a PATCH: what the row looks like if the platform
 * applies it. Pure, and forgiving the way the server is — a check on a
 * criterion that no longer exists changes nothing.
 */
function applyWorkUpdate(work, update) {
    const next = { ...work, criteria: { ...work.criteria }, links: { ...work.links } };
    const set = update.set ?? {};
    for (const key of Object.keys(set)) {
        const value = set[key];
        if (value === undefined)
            continue;
        if (value === null)
            delete next[key];
        else
            next[key] = value;
    }
    for (const op of update.criteria ?? []) {
        const cur = next.criteria[op.id];
        switch (op.op) {
            case 'add': {
                if (cur)
                    break;
                const ranks = Object.values(next.criteria).map((c) => c.rank).sort();
                next.criteria[op.id] = { text: op.text, done: false, rank: op.rank ?? rankAfter(ranks[ranks.length - 1]) };
                break;
            }
            case 'check':
                if (cur)
                    next.criteria[op.id] = { ...cur, done: op.done };
                break;
            case 'edit':
                if (cur)
                    next.criteria[op.id] = { ...cur, text: op.text };
                break;
            case 'move':
                if (cur)
                    next.criteria[op.id] = { ...cur, rank: op.rank };
                break;
            case 'remove':
                delete next.criteria[op.id];
                break;
        }
    }
    for (const op of update.links ?? []) {
        const cur = next.links[op.id];
        switch (op.op) {
            case 'add':
                if (!cur)
                    next.links[op.id] = { documentId: op.documentId, relation: op.relation };
                break;
            case 'edit':
                if (cur)
                    next.links[op.id] = { ...cur, relation: op.relation };
                break;
            case 'remove':
                delete next.links[op.id];
                break;
        }
    }
    return next;
}
/** The criteria in display order (by `rank`, then id). */
function orderedCriteria(work) {
    return Object.entries(work.criteria)
        .map(([id, c]) => ({ id, ...c }))
        .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.id < b.id ? -1 : 1));
}
function obj(v) {
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}
function str(v) {
    return typeof v === 'string' && v.length > 0 ? v : undefined;
}
function num(v) {
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
/** A platform row (or `{ work }` envelope) in the shape above, with maps defaulted. */
function normalizeDocumentWork(raw, documentId) {
    const outer = obj(raw);
    const r = outer.work && typeof outer.work === 'object' ? obj(outer.work) : outer;
    const work = {
        ...r,
        documentId: str(r.documentId) ?? documentId ?? '',
        organizationId: str(r.organizationId) ?? '',
        criteria: obj(r.criteria),
        links: obj(r.links),
        fieldRevisions: obj(r.fieldRevisions),
        revision: num(r.revision) ?? 0,
        updatedAt: str(r.updatedAt) ?? '',
        updatedBy: str(r.updatedBy) ?? '',
    };
    if (typeof outer.tracked === 'boolean' && typeof r.tracked !== 'boolean')
        work.tracked = outer.tracked;
    if (typeof work.tracked !== 'boolean')
        work.tracked = work.revision > 0;
    return work;
}
exports.WORK_STATUS_LABEL = {
    next: 'Next up',
    in_progress: 'In progress',
    in_review: 'In review',
    done: 'Done',
    not_planned: 'Not planned',
};
/** Group order in the Work column. Untracked rows sit under "Not planned", never "Next up". */
exports.WORK_GROUP_ORDER = ['next', 'in_progress', 'in_review', 'done', 'not_planned'];
function workGroupOf(row) {
    return row.status && row.status in exports.WORK_STATUS_LABEL ? row.status : 'not_planned';
}
function byRank(a, b) {
    const ra = a.rank ?? '￿';
    const rb = b.rank ?? '￿';
    if (ra !== rb)
        return ra < rb ? -1 : 1;
    return a.documentId < b.documentId ? -1 : a.documentId > b.documentId ? 1 : 0;
}
/** Rows grouped by work status, in `WORK_GROUP_ORDER`, each sorted by `rank`. Empty groups are left out unless asked for. */
function groupWorkRows(rows, opts = {}) {
    const buckets = new Map(exports.WORK_GROUP_ORDER.map((k) => [k, []]));
    for (const row of rows)
        buckets.get(workGroupOf(row)).push(row);
    return exports.WORK_GROUP_ORDER
        .map((key) => {
        const list = buckets.get(key).sort(byRank);
        return { key, label: exports.WORK_STATUS_LABEL[key], count: list.length, rows: list };
    })
        .filter((g) => opts.includeEmpty || g.count > 0);
}
/** Σ points of `done` rows out of Σ over all rows — what the header reads, recomputed after a live merge. */
function pointsRollup(rows) {
    let pointsDone = 0;
    let pointsTotal = 0;
    for (const row of rows) {
        const p = typeof row.points === 'number' ? row.points : 0;
        pointsTotal += p;
        if (row.status === 'done')
            pointsDone += p;
    }
    return { pointsDone, pointsTotal };
}
function normalizeWorkList(raw, scope) {
    const body = obj(raw);
    const list = Array.isArray(body.rows) ? body.rows : Array.isArray(body.items) ? body.items : [];
    const rows = list
        .filter((r) => r && typeof r === 'object' && typeof r.documentId === 'string')
        .map((r) => {
        const row = normalizeDocumentWork(r);
        const active = obj(r.activeRun);
        row.activeRun = str(active.runId) && str(active.pipelineId) ? active : null;
        return row;
    });
    const r = obj(body.rollup);
    const points = pointsRollup(rows);
    const rollup = {
        pointsDone: num(r.pointsDone) ?? points.pointsDone,
        pointsTotal: num(r.pointsTotal) ?? points.pointsTotal,
        decisions: num(r.decisions) ?? 0,
        agents: num(r.agents) ?? 0,
    };
    const spent = num(r.spentUsd);
    if (spent !== undefined)
        rollup.spentUsd = spent;
    return { scope: str(body.scope) ?? scope, rows, rollup };
}
/** Merge a re-read work record into its list row, keeping the list-only fields (lifecycle status, live run). */
function mergeWorkIntoRow(row, work) {
    return { ...(row ?? { activeRun: null }), ...work };
}
/** A draft stuck in `dispatching` this long reads as "Dispatch not confirmed — Retry" (§2.2). */
exports.RUN_DRAFT_DISPATCH_STALE_MS = 60_000;
/** What the Run draft pane says about a draft. */
function runDraftPhase(draft, now = Date.now()) {
    if (!draft)
        return 'none';
    if (draft.status === 'dispatching') {
        const at = Date.parse(draft.updatedAt);
        return Number.isFinite(at) && now - at > exports.RUN_DRAFT_DISPATCH_STALE_MS ? 'unconfirmed' : 'dispatching';
    }
    return draft.status;
}
function normalizeRunDraft(raw) {
    const outer = obj(raw);
    const r = outer.draft && typeof outer.draft === 'object' ? obj(outer.draft) : outer;
    if (!str(r.draftId) || !str(r.documentId))
        return null;
    return { ...r, revision: num(r.revision) ?? 0, status: (str(r.status) ?? 'draft') };
}
/** The draft the pane shows: the newest one not cancelled, else the newest. */
function currentRunDraft(drafts) {
    if (drafts.length === 0)
        return null;
    const sorted = [...drafts].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    return sorted.find((d) => d.status !== 'cancelled') ?? sorted[0];
}
/** `null` means "No prior runs": the UI shows no number (a range is never shown with n = 0). */
function normalizeRunEstimate(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const r = obj(raw);
    const basis = obj(r.basis);
    const runs = num(basis.runs) ?? 0;
    if (runs <= 0 || r.confidence === 'none')
        return null;
    const range = (v) => {
        const o = obj(v);
        const low = num(o.low);
        const high = num(o.high);
        return low !== undefined && high !== undefined ? { low, high } : null;
    };
    const costUsd = range(r.costUsd);
    const durationMs = range(r.durationMs);
    if (!costUsd && !durationMs)
        return null;
    return {
        pipelineId: str(r.pipelineId) ?? '',
        basis: { runs, ...(str(basis.model) ? { model: str(basis.model) } : {}), repriced: basis.repriced === true },
        costUsd,
        durationMs,
        confidence: r.confidence === 'medium' ? 'medium' : 'low',
    };
}
async function errorFrom(res, fallback) {
    const body = (await res.json().catch(() => ({})));
    const message = str(body.message) || str(body.error) || `${fallback} (${res.status})`;
    return Object.assign(new Error(message), {
        status: res.status,
        ...(str(body.code) || str(body.error) ? { code: str(body.code) ?? str(body.error) } : {}),
        body,
    });
}
function headers(idToken, extra = {}) {
    return { ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}), ...extra };
}
const enc = encodeURIComponent;
/** `GET /api/documents/:documentId/work` — backfilled on read when absent (`tracked: false`, revision 0). */
async function fetchDocumentWork(apiBaseUrl, idToken, documentId, init) {
    const res = await fetch(`${apiBaseUrl}/api/documents/${enc(documentId)}/work`, {
        headers: headers(idToken), ...(init?.signal ? { signal: init.signal } : {}),
    });
    if (!res.ok)
        throw await errorFrom(res, 'Could not read the work item');
    return normalizeDocumentWork(await res.json(), documentId);
}
/**
 * `PATCH /api/documents/:documentId/work`. A 409 (a field this PATCH changes
 * moved on since `expectedRevision`) throws with `status: 409`.
 */
async function patchDocumentWork(apiBaseUrl, idToken, documentId, body) {
    const res = await fetch(`${apiBaseUrl}/api/documents/${enc(documentId)}/work`, {
        method: 'PATCH',
        headers: headers(idToken, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
    });
    if (!res.ok)
        throw await errorFrom(res, 'Could not save the work item');
    return normalizeDocumentWork(await res.json(), documentId);
}
/** `GET /api/document-work?scope=<parentId|type:<type>>` — the Work column. */
async function fetchWorkList(apiBaseUrl, idToken, scope, init) {
    const res = await fetch(`${apiBaseUrl}/api/document-work?scope=${enc(scope)}`, {
        headers: headers(idToken), ...(init?.signal ? { signal: init.signal } : {}),
    });
    if (!res.ok)
        throw await errorFrom(res, 'Could not read the work list');
    return normalizeWorkList(await res.json(), scope);
}
/** `GET /api/documents/:documentId/run-drafts` — the document's drafts, newest state of each. */
async function fetchRunDrafts(apiBaseUrl, idToken, documentId, init) {
    const res = await fetch(`${apiBaseUrl}/api/documents/${enc(documentId)}/run-drafts`, {
        headers: headers(idToken), ...(init?.signal ? { signal: init.signal } : {}),
    });
    if (!res.ok)
        throw await errorFrom(res, 'Could not read the run drafts');
    const body = obj(await res.json());
    const list = Array.isArray(body.drafts) ? body.drafts : Array.isArray(body.items) ? body.items : [];
    return list.map(normalizeRunDraft).filter((d) => d !== null);
}
/** `GET /api/documents/:documentId/run-drafts/:draftId`. */
async function fetchRunDraft(apiBaseUrl, idToken, documentId, draftId, init) {
    const res = await fetch(`${apiBaseUrl}/api/documents/${enc(documentId)}/run-drafts/${enc(draftId)}`, {
        headers: headers(idToken), ...(init?.signal ? { signal: init.signal } : {}),
    });
    if (!res.ok)
        throw await errorFrom(res, 'Could not read the run draft');
    const draft = normalizeRunDraft(await res.json());
    if (!draft)
        throw Object.assign(new Error('The run draft answer had no draft'), { status: 502 });
    return draft;
}
/** `PUT /api/documents/:documentId/run-drafts/:draftId` — an idempotent upsert keyed by `draftId`. */
async function putRunDraft(apiBaseUrl, idToken, documentId, draftId, body) {
    const res = await fetch(`${apiBaseUrl}/api/documents/${enc(documentId)}/run-drafts/${enc(draftId)}`, {
        method: 'PUT',
        headers: headers(idToken, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
    });
    if (!res.ok)
        throw await errorFrom(res, 'Could not save the run draft');
    const draft = normalizeRunDraft(await res.json());
    if (!draft)
        throw Object.assign(new Error('The run draft answer had no draft'), { status: 502 });
    return draft;
}
/** `POST /api/documents/:documentId/run-drafts/:draftId/dispatch` — safe to retry: the draft id is the idempotency key. */
async function dispatchRunDraft(apiBaseUrl, idToken, documentId, draftId) {
    const res = await fetch(`${apiBaseUrl}/api/documents/${enc(documentId)}/run-drafts/${enc(draftId)}/dispatch`, {
        method: 'POST',
        headers: headers(idToken, { 'Content-Type': 'application/json' }),
        body: '{}',
    });
    if (!res.ok)
        throw await errorFrom(res, 'Could not dispatch the run');
    const draft = normalizeRunDraft(await res.json());
    if (!draft)
        throw Object.assign(new Error('The dispatch answer had no draft'), { status: 502 });
    return draft;
}
/** `POST /api/pipelines/:runId/cancel` — the existing cancel route, forwarded to the replica holding the run. */
async function cancelDraftRun(apiBaseUrl, idToken, runId, reason) {
    const res = await fetch(`${apiBaseUrl}/api/pipelines/${enc(runId)}/cancel`, {
        method: 'POST',
        headers: headers(idToken, { 'Content-Type': 'application/json', 'Idempotency-Key': `run-draft-cancel:${runId}` }),
        body: JSON.stringify(reason ? { reason } : {}),
    });
    if (!res.ok)
        throw await errorFrom(res, 'Could not stop the run');
}
/** `GET /api/pipelines/:pipelineId/estimate?model=` — `null` when the pipeline has no completed runs. */
async function fetchRunEstimate(apiBaseUrl, idToken, pipelineId, model, init) {
    const q = model ? `?model=${enc(model)}` : '';
    const res = await fetch(`${apiBaseUrl}/api/pipelines/${enc(pipelineId)}/estimate${q}`, {
        headers: headers(idToken), ...(init?.signal ? { signal: init.signal } : {}),
    });
    if (!res.ok)
        throw await errorFrom(res, 'Could not read the estimate');
    return normalizeRunEstimate(await res.json());
}
// ---------------------------------------------------------------------------
// Gateway signals
// ---------------------------------------------------------------------------
exports.DOC_WORK_CHANNEL_PREFIX = 'doc-work:';
exports.DOC_WORK_SCOPE_CHANNEL_PREFIX = 'doc-work-scope:';
const docWorkChannel = (documentId) => `${exports.DOC_WORK_CHANNEL_PREFIX}${documentId}`;
exports.docWorkChannel = docWorkChannel;
const docWorkScopeChannel = (scopeId) => `${exports.DOC_WORK_SCOPE_CHANNEL_PREFIX}${scopeId}`;
exports.docWorkScopeChannel = docWorkScopeChannel;
/** The gateway's `doc-work` service frames (realtime-examples `src/realtime-fanout/doc-work-service.ts`). */
function docWorkSubscribeFrame(action, target, documentGrant) {
    return { service: 'doc-work', action, ...target, ...(action === 'subscribe' && documentGrant ? { documentGrant } : {}) };
}
/** A `doc-work:*` / `doc-work-scope:*` signal frame, or undefined for anything else. Reads `payload` or the frame itself. */
function docWorkSignalFromFrame(frame) {
    const f = obj(frame);
    const type = f.type ?? f.eventType;
    if (type !== 'doc:work_updated' && type !== 'doc:run_draft_updated')
        return undefined;
    const p = f.payload && typeof f.payload === 'object' ? obj(f.payload) : f.data && typeof f.data === 'object' ? obj(f.data) : f;
    const documentId = str(p.documentId);
    if (!documentId)
        return undefined;
    const revision = num(p.revision) ?? 0;
    const channel = str(f.channel);
    if (type === 'doc:work_updated') {
        return {
            type, documentId, revision,
            ...(Array.isArray(p.fields) ? { fields: p.fields.filter((x) => typeof x === 'string') } : {}),
            ...('status' in p ? { status: (str(p.status) ?? null) } : {}),
            ...('rank' in p ? { rank: str(p.rank) ?? null } : {}),
            ...(channel ? { channel } : {}),
        };
    }
    const draftId = str(p.draftId);
    if (!draftId)
        return undefined;
    return {
        type, documentId, draftId, revision,
        ...(str(p.status) ? { status: str(p.status) } : {}),
        ...(str(p.runId) ? { runId: str(p.runId) } : {}),
        ...(channel ? { channel } : {}),
    };
}
const registry = new WeakMap();
/**
 * Refcounted subscribe over one transport. The gateway keeps one set of
 * channels per connection, so two hooks on the same channel must send one
 * subscribe and one unsubscribe between them — else the first to unmount
 * silences the other. A new session `epoch` is a new server-side connection
 * that has subscribed to nothing: the first acquirer after it re-sends.
 */
function acquireChannelSubscription(send, key, subscribeFrame, unsubscribeFrame, epoch) {
    let map = registry.get(send);
    if (!map) {
        map = new Map();
        registry.set(send, map);
    }
    const entry = map.get(key);
    if (!entry) {
        map.set(key, { count: 1, epoch });
        send(subscribeFrame);
    }
    else {
        entry.count += 1;
        if (entry.epoch !== epoch) {
            entry.epoch = epoch;
            send(subscribeFrame);
        }
    }
    let released = false;
    return () => {
        if (released)
            return;
        released = true;
        const m = registry.get(send);
        const e = m?.get(key);
        if (!m || !e)
            return;
        e.count -= 1;
        if (e.count <= 0) {
            m.delete(key);
            send(unsubscribeFrame);
        }
    };
}
//# sourceMappingURL=work.js.map