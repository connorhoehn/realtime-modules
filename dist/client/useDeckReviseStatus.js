"use strict";
// realtime-modules/src/client/useDeckReviseStatus.ts
//
// Which slides of a presentation an agent is editing RIGHT NOW, from anyone's
// tab — so the filmstrip can show "Generating…" on the slide being revised,
// and the task strip can show the real phase instead of a made-up percent.
//
// Source: platform-api's `POST /api/deck/revise` with a `documentId` publishes
// `pipeline:deck:revise:{started,phase,completed,failed}` onto the existing
// pipeline relay; the gateway delivers them as ordinary `pipeline:event`
// frames (`eventType: 'pipeline.deck.revise.*'`) on the document's channel
// `pipeline:run:deck-revise:<documentId>`. So this hook is a pipeline-channel
// subscriber like usePipelineRunStatus: same frames, same injectable transport,
// same `{ service:'pipeline', action:'subscribe' }` handshake.
//
// The events carry ids, the phase and the outcome — never the instruction or
// any slide text (the channel is not per-document authorized). The request
// that started a revise gets the edit itself in its HTTP response.
//
// A revise ends with `completed` or `failed`. If neither arrives (a platform
// restart mid-request, a dropped frame), the activity goes `stale` after
// `staleMs` — 60 s, past the server's 45 s model timeout — and stops counting
// as generating. Nothing is invented to fill the gap.
Object.defineProperty(exports, "__esModule", { value: true });
exports.DECK_REVISE_EVENT_PREFIX = exports.DEFAULT_DECK_REVISE_STALE_MS = void 0;
exports.deckReviseChannel = deckReviseChannel;
exports.deckRevisePhaseLabel = deckRevisePhaseLabel;
exports.isDeckReviseSettled = isDeckReviseSettled;
exports.reduceDeckReviseFrame = reduceDeckReviseFrame;
exports.markStaleDeckRevises = markStaleDeckRevises;
exports.useDeckReviseStatus = useDeckReviseStatus;
const react_1 = require("react");
const GatewaySocketProvider_1 = require("./GatewaySocketProvider");
exports.DEFAULT_DECK_REVISE_STALE_MS = 60_000;
exports.DECK_REVISE_EVENT_PREFIX = 'pipeline.deck.revise.';
/** The gateway channel a document's revise events arrive on. */
function deckReviseChannel(documentId) {
    return `pipeline:run:deck-revise:${documentId}`;
}
const PHASE_LABELS = {
    started: 'Starting',
    'reading-sources': 'Reading sources',
    'asking-model': 'Writing the edit',
    checking: 'Checking the edit',
    saving: 'Saving the new revision',
    completed: 'Done',
    failed: 'Failed',
};
function deckRevisePhaseLabel(phase) {
    return PHASE_LABELS[phase];
}
const PHASES = new Set(Object.keys(PHASE_LABELS));
const TERMINAL = new Set(['completed', 'failed']);
function isDeckReviseSettled(activity) {
    return TERMINAL.has(activity.phase) || activity.stale === true;
}
const str = (value) => (typeof value === 'string' && value ? value : undefined);
/**
 * One frame into the per-request map. Pure; returns the same map when the
 * frame is not a revise event for `documentId`, or arrives after the
 * revise settled (a late `phase` never un-finishes it).
 */
function reduceDeckReviseFrame(state, frame, documentId, now) {
    const msg = frame;
    if (!msg || msg.type !== 'pipeline:event')
        return state;
    const eventType = typeof msg.eventType === 'string' ? msg.eventType.replace(/:/g, '.') : '';
    if (!eventType.startsWith(exports.DECK_REVISE_EVENT_PREFIX))
        return state;
    const p = msg.payload ?? {};
    if (p.documentId !== documentId)
        return state;
    const requestId = str(p.requestId);
    if (!requestId)
        return state;
    const kind = eventType.slice(exports.DECK_REVISE_EVENT_PREFIX.length);
    const phase = (kind === 'phase' ? str(p.phase) : kind);
    if (!phase || !PHASES.has(phase))
        return state;
    const prev = state[requestId];
    if (prev && TERMINAL.has(prev.phase))
        return state;
    const at = Date.parse(str(p.occurredAt) ?? '');
    const when = Number.isFinite(at) ? at : now;
    const target = p.target && typeof p.target === 'object' && typeof p.target.field === 'string'
        ? p.target
        : prev?.target;
    const slideId = str(p.slideId) ?? prev?.slideId;
    const pipelineRunId = str(p.pipelineRunId) ?? prev?.pipelineRunId;
    const next = {
        requestId,
        documentId,
        userId: str(p.userId) ?? prev?.userId ?? '',
        scope: p.scope === 'slide' || p.scope === 'deck' ? p.scope : (prev?.scope ?? (slideId ? 'slide' : 'deck')),
        ...(slideId ? { slideId } : {}),
        ...(target ? { target } : {}),
        phase,
        label: PHASE_LABELS[phase],
        startedAt: prev?.startedAt ?? when,
        updatedAt: when,
        ...(Array.isArray(p.changedSlideIds) ? { changedSlideIds: p.changedSlideIds.filter((id) => typeof id === 'string') } : {}),
        ...(typeof p.status === 'number' ? { status: p.status } : {}),
        ...(str(p.code) ? { code: str(p.code) } : {}),
        ...(pipelineRunId ? { pipelineRunId } : {}),
        ...(p.revisionId === null ? { revisionId: null } : str(p.revisionId) ? { revisionId: str(p.revisionId) } : {}),
        ...(str(p.rebasedOnto) ? { rebasedOnto: str(p.rebasedOnto) } : {}),
        ...(str(p.reason) ? { reason: str(p.reason) } : {}),
    };
    return { ...state, [requestId]: next };
}
/** Marks unfinished revises with no event for `staleMs` as stale. Returns the same map when none are. */
function markStaleDeckRevises(state, now, staleMs) {
    let changed = false;
    const next = { ...state };
    for (const [id, activity] of Object.entries(state)) {
        if (isDeckReviseSettled(activity) || now - activity.updatedAt < staleMs)
            continue;
        next[id] = { ...activity, stale: true };
        changed = true;
    }
    return changed ? next : state;
}
function useDeckReviseStatus(documentId, opts = {}) {
    const { transport } = opts;
    const staleMs = opts.staleMs ?? exports.DEFAULT_DECK_REVISE_STALE_MS;
    const keepRecent = opts.keepRecent ?? 10;
    const nowRef = (0, react_1.useRef)(opts.now ?? Date.now);
    nowRef.current = opts.now ?? Date.now;
    const gateway = (0, GatewaySocketProvider_1.useGatewayOptional)();
    const send = transport === null ? undefined : transport ? transport.send : gateway?.sendMessage;
    const onMessage = transport === null ? undefined : transport ? transport.onMessage : gateway?.onMessage;
    // A reconnect is a new server session with no subscriptions; re-send.
    const epoch = transport === undefined ? gateway?.sessionEpoch : undefined;
    const [byId, setById] = (0, react_1.useState)({});
    // A different document is a different set of revises.
    (0, react_1.useEffect)(() => { setById({}); }, [documentId]);
    (0, react_1.useEffect)(() => {
        if (!documentId || !send || !onMessage)
            return;
        const channel = deckReviseChannel(documentId);
        send({ service: 'pipeline', action: 'subscribe', channel });
        const unregister = onMessage((frame) => {
            setById((prev) => reduceDeckReviseFrame(prev, frame, documentId, nowRef.current()));
        });
        return () => {
            unregister();
            send({ service: 'pipeline', action: 'unsubscribe', channel });
        };
    }, [documentId, send, onMessage, epoch]);
    const hasOpen = Object.values(byId).some((activity) => !isDeckReviseSettled(activity));
    (0, react_1.useEffect)(() => {
        if (!hasOpen || staleMs <= 0)
            return;
        const timer = setInterval(() => {
            setById((prev) => markStaleDeckRevises(prev, nowRef.current(), staleMs));
        }, Math.min(5_000, staleMs));
        return () => clearInterval(timer);
    }, [hasOpen, staleMs]);
    const derived = (0, react_1.useMemo)(() => {
        const all = Object.values(byId);
        const active = all.filter((activity) => !isDeckReviseSettled(activity)).sort((a, b) => a.startedAt - b.startedAt);
        const recent = all.filter(isDeckReviseSettled).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, keepRecent);
        const latest = [...all].sort((a, b) => b.startedAt - a.startedAt)[0];
        const generatingSlideIds = [...new Set(active.flatMap((activity) => (activity.scope === 'slide' && activity.slideId ? [activity.slideId] : [])))];
        return { active, recent, latest, generatingSlideIds, isGenerating: active.length > 0 };
    }, [byId, keepRecent]);
    const get = (0, react_1.useCallback)((requestId) => byId[requestId], [byId]);
    return { ...derived, get };
}
exports.default = useDeckReviseStatus;
//# sourceMappingURL=useDeckReviseStatus.js.map