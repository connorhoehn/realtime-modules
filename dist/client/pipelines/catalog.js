"use strict";
// realtime-modules/src/client/pipelines/catalog.ts
//
// The shared vocabulary of the pipelines directory: what kind of work a
// pipeline does (its group on the page), the mark its row wears, the last-run
// rollup platform-api keeps beside each definition, and the pure rules the
// page reads them with — grouping, the status pill, and the merge that keeps
// a rollup current from the run events the gateway already fans out.
//
// This file is the one home of the enum (realtime-examples
// docs/design/pipelines-page/PLAN.md §2.1–2.5). platform-api mirrors the
// values with a contract test; the host re-exports them from here. Everything
// in this file is pure (no React, no fetch) so scripts and tests can use it
// the same way the hook does.
Object.defineProperty(exports, "__esModule", { value: true });
exports.RUN_EVENT_STATUS = exports.RECENT_LIMIT = exports.ROLLUP_RECENT_LIMIT = exports.RUN_ITEM_STATUSES = exports.MAX_ROUTE_ENTRIES = exports.MAX_INSTRUCTION_CHARS = exports.ORIGIN_KINDS = exports.KIND_LABEL = exports.KIND_WORK_TYPE = exports.KIND_MARK = exports.PIPELINE_KINDS = exports.PIPELINE_KIND_ORDER = exports.WORK_TYPE_ORDER = exports.WORK_TYPE_LABEL = void 0;
exports.isWorkType = isWorkType;
exports.isPipelineKind = isPipelineKind;
exports.isFailedRunStatus = isFailedRunStatus;
exports.isActiveRunStatus = isActiveRunStatus;
exports.isTerminalRunStatus = isTerminalRunStatus;
exports.workTypeOf = workTypeOf;
exports.kindOf = kindOf;
exports.summarize = summarize;
exports.summarizeAll = summarizeAll;
exports.compareSummaries = compareSummaries;
exports.sortSummaries = sortSummaries;
exports.groupCatalog = groupCatalog;
exports.groupByWorkType = groupByWorkType;
exports.relativeTime = relativeTime;
exports.statusPillFor = statusPillFor;
exports.runEventFromFrame = runEventFromFrame;
exports.emptyRollup = emptyRollup;
exports.applyRunEvent = applyRunEvent;
exports.mergeRunEvent = mergeRunEvent;
exports.WORK_TYPE_LABEL = {
    documents: 'Documents & presentations',
    agents: 'Agents & experiments',
    conversations: 'Conversations & media',
    other: 'Other',
};
/** The order the groups render in. Empty groups are not rendered. */
exports.WORK_TYPE_ORDER = ['documents', 'agents', 'conversations', 'other'];
exports.PIPELINE_KIND_ORDER = [
    'document', 'presentation', 'diagram',
    'agent', 'experiment',
    'recording', 'call', 'conversation', 'media',
    'workflow',
];
/** platform-api's name for the same list. */
exports.PIPELINE_KINDS = exports.PIPELINE_KIND_ORDER;
/**
 * The ui-components `FileKindMark` kind for each pipeline kind. Strings, not
 * the library's type: this package does not depend on ui-components, and the
 * host's `FileKind` union accepts every value here.
 */
exports.KIND_MARK = {
    document: 'page', presentation: 'presentation', diagram: 'diagram',
    agent: 'agent', experiment: 'experiment',
    recording: 'recording', call: 'call', conversation: 'conversation', media: 'media',
    workflow: 'workflow',
};
exports.KIND_WORK_TYPE = {
    document: 'documents', presentation: 'documents', diagram: 'documents',
    agent: 'agents', experiment: 'agents',
    recording: 'conversations', call: 'conversations', conversation: 'conversations', media: 'conversations',
    workflow: 'other',
};
exports.KIND_LABEL = {
    document: 'Document', presentation: 'Presentation', diagram: 'Diagram',
    agent: 'Agent', experiment: 'Experiment',
    recording: 'Recording', call: 'Call', conversation: 'Conversation', media: 'Media',
    workflow: 'Workflow',
};
function isWorkType(v) {
    return typeof v === 'string' && Object.prototype.hasOwnProperty.call(exports.WORK_TYPE_LABEL, v);
}
function isPipelineKind(v) {
    return typeof v === 'string' && Object.prototype.hasOwnProperty.call(exports.KIND_MARK, v);
}
exports.ORIGIN_KINDS = ['system', 'template', 'agent', 'blank', 'import'];
/** The longest instruction `origin.instruction` and `/generate` accept. */
exports.MAX_INSTRUCTION_CHARS = 4000;
/** `route` shows this many steps before the platform folds the rest into "… +N". */
exports.MAX_ROUTE_ENTRIES = 6;
exports.RUN_ITEM_STATUSES = [
    'pending', 'running', 'awaiting_approval', 'paused_at_breakpoint',
    'completed', 'failed', 'cancelled', 'rejected',
    'interrupted', 'stuck',
];
/** How many runs a rollup remembers (platform-api `RECENT_LIMIT`). */
exports.ROLLUP_RECENT_LIMIT = 5;
exports.RECENT_LIMIT = exports.ROLLUP_RECENT_LIMIT;
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'rejected']);
const LIVE = new Set(['pending', 'running', 'awaiting_approval', 'paused_at_breakpoint']);
const BAD = new Set(['failed', 'interrupted', 'stuck']);
/** failed | interrupted | stuck — what `failedOfRecent` counts. */
function isFailedRunStatus(status) {
    return !!status && BAD.has(status);
}
/** pending | running | awaiting_approval | paused_at_breakpoint — what `runningCount` counts. */
function isActiveRunStatus(status) {
    return !!status && LIVE.has(status);
}
/**
 * completed | failed | cancelled | rejected. `interrupted` and `stuck` are
 * NOT terminal: a stuck run may still finish, and the platform applies both
 * as live states a later terminal event can overwrite.
 */
function isTerminalRunStatus(status) {
    return !!status && TERMINAL.has(status);
}
/** Work type of an entry: the explicit field, else the kind's, else 'other'. */
function workTypeOf(def) {
    if (isWorkType(def.workType))
        return def.workType;
    if (isPipelineKind(def.kind))
        return exports.KIND_WORK_TYPE[def.kind];
    return 'other';
}
/** Kind of an entry: the explicit field, else 'workflow'. */
function kindOf(def) {
    return isPipelineKind(def.kind) ? def.kind : 'workflow';
}
function summarize(entry) {
    const rollup = entry.rollup ?? null;
    const recent = rollup?.recent ?? [];
    const kind = kindOf(entry);
    const hasRun = !!rollup && !!rollup.lastRunId;
    return {
        id: entry.id,
        name: entry.name,
        description: entry.description,
        workType: workTypeOf(entry),
        kind,
        mark: exports.KIND_MARK[kind],
        route: Array.isArray(entry.route) ? entry.route.filter((s) => typeof s === 'string') : [],
        origin: entry.origin,
        status: entry.status,
        readOnly: entry.readOnly === true,
        tags: entry.tags,
        updatedAt: entry.updatedAt,
        lastRunId: hasRun ? rollup.lastRunId : undefined,
        lastRunAt: hasRun ? rollup.lastRunAt : undefined,
        lastRunStatus: hasRun ? rollup.lastRunStatus ?? undefined : undefined,
        failedCount: rollup ? rollup.failedOfRecent : 0,
        totalCount: recent.length,
        pendingApprovals: typeof entry.pendingApprovals === 'number'
            ? entry.pendingApprovals
            : recent.filter((r) => r.status === 'awaiting_approval').length,
        runningCount: rollup ? rollup.runningCount : 0,
        rollupPending: rollup === null,
    };
}
function summarizeAll(entries) {
    return entries.map(summarize);
}
const DEFINITION_STATUS_ORDER = ['published', 'draft', 'archived'];
const DEFINITION_STATUS_LABEL = {
    published: 'Published', draft: 'Draft', archived: 'Archived',
};
function timeOf(iso) {
    if (!iso)
        return 0;
    const t = new Date(iso).getTime();
    return Number.isNaN(t) ? 0 : t;
}
/**
 * Row order inside a group: something in flight first, then by most recent
 * run, then by most recently edited, then by name so the order is total.
 */
function compareSummaries(a, b) {
    const aActive = isActiveRunStatus(a.lastRunStatus) ? 1 : 0;
    const bActive = isActiveRunStatus(b.lastRunStatus) ? 1 : 0;
    if (aActive !== bActive)
        return bActive - aActive;
    const byRun = timeOf(b.lastRunAt) - timeOf(a.lastRunAt);
    if (byRun !== 0)
        return byRun;
    const byEdit = timeOf(b.updatedAt) - timeOf(a.updatedAt);
    if (byEdit !== 0)
        return byEdit;
    return a.name.localeCompare(b.name);
}
function sortSummaries(summaries) {
    return [...summaries].sort(compareSummaries);
}
function countsOf(entries) {
    let failed = 0;
    let running = 0;
    let pendingApprovals = 0;
    for (const e of entries) {
        if (isFailedRunStatus(e.lastRunStatus) || e.failedCount > 0)
            failed += 1;
        if (e.runningCount > 0 || isActiveRunStatus(e.lastRunStatus))
            running += 1;
        pendingApprovals += e.pendingApprovals;
    }
    return { total: entries.length, failed, running, pendingApprovals };
}
/**
 * Group summaries for the page. Groups follow the enum's order, empty groups
 * are omitted, and the rows inside each are sorted by `compareSummaries`.
 */
function groupCatalog(summaries, by = 'workType') {
    const order = by === 'workType' ? exports.WORK_TYPE_ORDER : by === 'kind' ? exports.PIPELINE_KIND_ORDER : DEFINITION_STATUS_ORDER;
    const labelOf = (k) => by === 'workType' ? exports.WORK_TYPE_LABEL[k]
        : by === 'kind' ? exports.KIND_LABEL[k]
            : DEFINITION_STATUS_LABEL[k] ?? k;
    const keyOf = (s) => by === 'workType' ? s.workType : by === 'kind' ? s.kind : s.status;
    const buckets = new Map();
    for (const s of summaries) {
        const k = keyOf(s);
        const list = buckets.get(k);
        if (list)
            list.push(s);
        else
            buckets.set(k, [s]);
    }
    const keys = [...order.filter((k) => buckets.has(k)), ...[...buckets.keys()].filter((k) => !order.includes(k))];
    return keys.map((key) => {
        const entries = sortSummaries(buckets.get(key));
        return {
            key,
            label: labelOf(key),
            ...(by === 'workType' ? { workType: key } : {}),
            entries,
            counts: countsOf(entries),
        };
    });
}
/** `groupCatalog(summaries, 'workType')` — the page's default. */
function groupByWorkType(summaries) {
    return groupCatalog(summaries, 'workType');
}
/**
 * "just now" / "3m ago" / "2h ago" / "2d ago" / a plain date past three days.
 * The same shape the host's `formatTime.ts` produces, so the list and the run
 * pages agree about the same run. `now` is injectable for tests.
 */
function relativeTime(iso, now = Date.now()) {
    if (!iso)
        return '--';
    const then = new Date(iso).getTime();
    if (Number.isNaN(then))
        return '--';
    const d = now - then;
    if (d < 60_000)
        return 'just now';
    if (d < 3_600_000)
        return `${Math.floor(d / 60_000)}m ago`;
    if (d < 86_400_000)
        return `${Math.floor(d / 3_600_000)}h ago`;
    if (d < 259_200_000)
        return `${Math.floor(d / 86_400_000)}d ago`;
    return new Date(iso).toLocaleDateString();
}
function pill(tone, label, meta) {
    return { tone, label, ...(meta ? { meta } : {}), text: meta ? `${label} · ${meta}` : label };
}
/**
 * The pill for a row (PLAN §2.2): a run in flight → info; the newest run
 * failed → danger "Failed · 10h ago"; some of the recent runs failed →
 * warning "1 of 5 failed · 29m ago"; otherwise the definition's own status.
 */
function statusPillFor(summary, now = Date.now()) {
    const rel = summary.lastRunAt ? relativeTime(summary.lastRunAt, now) : undefined;
    const last = summary.lastRunStatus;
    if (last === 'running')
        return pill('info', 'Running', rel);
    if (last === 'pending')
        return pill('info', 'Queued', rel);
    if (last === 'awaiting_approval')
        return pill('info', 'Awaiting approval', rel);
    if (last === 'paused_at_breakpoint')
        return pill('info', 'Paused', rel);
    if (last === 'failed')
        return pill('danger', 'Failed', rel);
    if (last === 'interrupted')
        return pill('danger', 'Interrupted', rel);
    if (last === 'stuck')
        return pill('warning', 'Stuck', rel);
    if (summary.failedCount > 0 && summary.totalCount > 0) {
        return pill('warning', `${summary.failedCount} of ${summary.totalCount} failed`, rel);
    }
    if (summary.status === 'published')
        return pill('success', 'Published');
    if (summary.status === 'archived')
        return pill('neutral', 'Archived');
    return pill('neutral', 'Draft');
}
/**
 * Event type → the run status it puts a run in — the same table the
 * platform's subscriber applies. Both the dotted and the colon-separated
 * spellings are accepted by `runEventFromFrame`. A `completed` whose payload
 * says `status: 'rejected'` is a rejection.
 */
exports.RUN_EVENT_STATUS = {
    'pipeline.run.started': 'running',
    'pipeline.run.resumed': 'running',
    'pipeline.run.completed': 'completed',
    'pipeline.run.failed': 'failed',
    'pipeline.run.cancelled': 'cancelled',
    'pipeline.run.orphaned': 'interrupted',
    'pipeline.run.stuck': 'stuck',
};
const EVENT_TIME_FIELDS = ['at', 'startedAt', 'completedAt', 'failedAt', 'cancelledAt', 'stuckAt', 'interruptedAt', 'timestamp'];
function str(v) {
    return typeof v === 'string' && v ? v : undefined;
}
/**
 * Parse a gateway `pipeline:event` frame into a rollup event, or `undefined`
 * when the frame is not one (a step, a token, a checkpoint, an approval …) or
 * names no pipeline. The event time is the payload's `at` (or its own stamp)
 * when it carries one, else the envelope's `emittedAt`, else `now`.
 */
function runEventFromFrame(frame, now = () => new Date().toISOString()) {
    if (!frame || typeof frame !== 'object')
        return undefined;
    const msg = frame;
    if (msg.type !== 'pipeline:event')
        return undefined;
    const type = typeof msg.eventType === 'string' ? msg.eventType.replace(/:/g, '.') : '';
    let status = exports.RUN_EVENT_STATUS[type];
    if (!status)
        return undefined;
    const p = (msg.payload && typeof msg.payload === 'object' ? msg.payload : {});
    const runId = str(p.runId);
    const pipelineId = str(p.pipelineId);
    if (!runId || !pipelineId)
        return undefined;
    if (type === 'pipeline.run.completed' && p.status === 'rejected')
        status = 'rejected';
    let at;
    for (const f of EVENT_TIME_FIELDS) {
        at = str(p[f]);
        if (at)
            break;
    }
    at = at ?? str(msg.emittedAt) ?? now();
    const startedAt = type === 'pipeline.run.started' ? str(p.startedAt) ?? at : str(p.startedAt);
    const completedAt = isTerminalRunStatus(status) ? str(p.completedAt) ?? str(p.failedAt) ?? str(p.cancelledAt) : undefined;
    return {
        pipelineId, runId, status, at,
        ...(startedAt ? { startedAt } : {}),
        ...(completedAt ? { completedAt } : {}),
    };
}
function byStartedAtDesc(a, b) {
    if (a.startedAt === b.startedAt)
        return a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0;
    return a.startedAt < b.startedAt ? 1 : -1;
}
function maxIso(a, b) { return a > b ? a : b; }
function derive(pipelineId, recent, runCount, updatedAt) {
    const sorted = [...recent].sort(byStartedAtDesc).slice(0, exports.ROLLUP_RECENT_LIMIT);
    const newest = sorted[0];
    return {
        pipelineId,
        lastRunId: newest?.runId ?? '',
        lastRunAt: newest?.startedAt ?? '',
        lastRunStatus: newest?.status ?? null,
        recent: sorted,
        failedOfRecent: sorted.filter((r) => BAD.has(r.status)).length,
        runningCount: sorted.filter((r) => LIVE.has(r.status)).length,
        runCount,
        updatedAt,
    };
}
/** The row a pipeline gets before any run: nothing recent (the platform's sentinel). */
function emptyRollup(pipelineId, at) {
    return derive(pipelineId, [], 0, at);
}
/**
 * Apply one lifecycle event to a rollup — the rule platform-api's subscriber
 * applies before its conditional put, ported line for line so the browser's
 * copy and the row converge:
 *
 * - a run already in `recent`: an event older than the entry's own `at`, a
 *   replay (same status), or a non-terminal event for a finished run changes
 *   nothing (terminal is final); otherwise the entry takes the new status;
 * - a run not yet in `recent` is appended — unless the window is full and the
 *   run started before everything kept, which is history and must not evict
 *   a newer run;
 * - `recent` stays newest-first, capped at 5; `lastRun*`, `failedOfRecent`,
 *   `runningCount` are recomputed; `runCount` counts distinct runs absorbed.
 *
 * Returns the SAME object when nothing changed, so a caller can skip a render.
 * ISO-8601 UTC strings compare as strings, exactly as the platform compares them.
 */
function applyRunEvent(existing, event) {
    const base = existing ?? emptyRollup(event.pipelineId, event.at);
    if (base.pipelineId !== event.pipelineId)
        return base;
    const idx = base.recent.findIndex((r) => r.runId === event.runId);
    const recent = base.recent.slice();
    let runCount = base.runCount;
    if (idx >= 0) {
        const cur = recent[idx];
        const older = event.at < cur.at;
        const regress = TERMINAL.has(cur.status) && !TERMINAL.has(event.status);
        const same = cur.status === event.status && !(event.completedAt && !cur.completedAt);
        if (older || regress || same) {
            // Nothing new — but a started event can still fill a missing startedAt.
            if (event.startedAt && cur.startedAt === cur.at && event.startedAt < cur.startedAt) {
                recent[idx] = { ...cur, startedAt: event.startedAt };
                return derive(base.pipelineId, recent, runCount, maxIso(base.updatedAt, event.at));
            }
            return existing ?? base;
        }
        recent[idx] = {
            ...cur,
            status: event.status,
            at: event.at,
            ...(event.startedAt && event.startedAt < cur.startedAt ? { startedAt: event.startedAt } : {}),
            ...(event.completedAt ? { completedAt: event.completedAt } : TERMINAL.has(event.status) ? { completedAt: event.at } : {}),
        };
    }
    else {
        const startedAt = event.startedAt ?? event.at;
        if (recent.length >= exports.ROLLUP_RECENT_LIMIT && startedAt < recent[recent.length - 1].startedAt) {
            return existing ?? base;
        }
        recent.push({
            runId: event.runId,
            status: event.status,
            startedAt,
            at: event.at,
            ...(event.completedAt ? { completedAt: event.completedAt } : TERMINAL.has(event.status) ? { completedAt: event.at } : {}),
        });
        runCount += 1;
    }
    return derive(base.pipelineId, recent, runCount, maxIso(base.updatedAt, event.at));
}
/**
 * Apply an event to the entry it names. Entries that are not the event's
 * pipeline keep their identity; an event for a pipeline not in the list is
 * ignored (the definition list is refreshed by the caller, not invented here).
 * Returns the SAME array when nothing changed.
 */
function mergeRunEvent(entries, event) {
    let changed = false;
    const out = entries.map((e) => {
        if (e.id !== event.pipelineId)
            return e;
        const rollup = applyRunEvent(e.rollup, event);
        if (rollup === e.rollup)
            return e;
        changed = true;
        return { ...e, rollup };
    });
    return changed ? out : entries;
}
//# sourceMappingURL=catalog.js.map