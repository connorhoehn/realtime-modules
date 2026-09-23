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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useGatewayOptional } from './GatewaySocketProvider';
import type { GatewayMessage } from './types';
import type { PipelineRunTransport } from './pipelines/usePipelineRunStatus';

export type DeckRevisePhase = 'started' | 'reading-sources' | 'asking-model' | 'checking' | 'completed' | 'failed';

/** The part of a slide a revise was pointed at (platform `DeckReviseTarget`). */
export interface DeckReviseTargetRef {
  field: 'title' | 'eyebrow' | 'subtitle' | 'bullets' | 'columns' | 'chart' | 'quote' | 'image' | 'notes';
  index?: number;
}

export interface DeckReviseActivity {
  requestId: string;
  documentId: string;
  /** Who asked (the platform `sub`). */
  userId: string;
  scope: 'slide' | 'deck';
  slideId?: string;
  target?: DeckReviseTargetRef;
  phase: DeckRevisePhase;
  /** The phase as a task strip would say it ("Writing the edit"). */
  label: string;
  /** ms since epoch, from the server's `occurredAt` of the first event seen. */
  startedAt: number;
  /** ms since epoch of the latest event. */
  updatedAt: number;
  /** On `completed`. */
  changedSlideIds?: string[];
  /** On `failed`: the HTTP status the request answered with. */
  status?: number;
  /** On `failed`: the plain sentence the request answered with. */
  reason?: string;
  /** No terminal event arrived within `staleMs`: no longer counted as in flight. */
  stale?: boolean;
}

export interface UseDeckReviseStatusOptions {
  /** A host-owned socket. Omit to use the nearest GatewaySocketProvider; `null` disables. */
  transport?: PipelineRunTransport | null;
  /** How long an unfinished revise may go without an event. Default 60 000. */
  staleMs?: number;
  /** Settled revises kept in `recent`. Default 10. */
  keepRecent?: number;
  /** Clock, for tests. */
  now?: () => number;
}

export interface UseDeckReviseStatusResult {
  /** In-flight revises, oldest first. */
  active: DeckReviseActivity[];
  /** Settled revises (completed, failed or stale), newest first. */
  recent: DeckReviseActivity[];
  /** The newest revise, in flight or settled. */
  latest?: DeckReviseActivity;
  /** Slides an in-flight slide-scoped revise is editing — the filmstrip's "Generating…". */
  generatingSlideIds: string[];
  /** True while any revise (slide or deck) is in flight. */
  isGenerating: boolean;
  /** One revise by its requestId (the id the HTTP response also carries). */
  get: (requestId: string) => DeckReviseActivity | undefined;
}

export const DEFAULT_DECK_REVISE_STALE_MS = 60_000;
export const DECK_REVISE_EVENT_PREFIX = 'pipeline.deck.revise.';

/** The gateway channel a document's revise events arrive on. */
export function deckReviseChannel(documentId: string): string {
  return `pipeline:run:deck-revise:${documentId}`;
}

const PHASE_LABELS: Record<DeckRevisePhase, string> = {
  started: 'Starting',
  'reading-sources': 'Reading sources',
  'asking-model': 'Writing the edit',
  checking: 'Checking the edit',
  completed: 'Done',
  failed: 'Failed',
};

export function deckRevisePhaseLabel(phase: DeckRevisePhase): string {
  return PHASE_LABELS[phase];
}

const PHASES = new Set<string>(Object.keys(PHASE_LABELS));
const TERMINAL = new Set<DeckRevisePhase>(['completed', 'failed']);

export function isDeckReviseSettled(activity: DeckReviseActivity): boolean {
  return TERMINAL.has(activity.phase) || activity.stale === true;
}

const str = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

/**
 * One frame into the per-request map. Pure; returns the same map when the
 * frame is not a revise event for `documentId`, or arrives after the
 * revise settled (a late `phase` never un-finishes it).
 */
export function reduceDeckReviseFrame(
  state: Readonly<Record<string, DeckReviseActivity>>,
  frame: unknown,
  documentId: string,
  now: number,
): Readonly<Record<string, DeckReviseActivity>> {
  const msg = frame as (GatewayMessage & { eventType?: unknown; payload?: Record<string, unknown> }) | null;
  if (!msg || msg.type !== 'pipeline:event') return state;
  const eventType = typeof msg.eventType === 'string' ? msg.eventType.replace(/:/g, '.') : '';
  if (!eventType.startsWith(DECK_REVISE_EVENT_PREFIX)) return state;
  const p = msg.payload ?? {};
  if (p.documentId !== documentId) return state;
  const requestId = str(p.requestId);
  if (!requestId) return state;

  const kind = eventType.slice(DECK_REVISE_EVENT_PREFIX.length);
  const phase = (kind === 'phase' ? str(p.phase) : kind) as DeckRevisePhase | undefined;
  if (!phase || !PHASES.has(phase)) return state;

  const prev = state[requestId];
  if (prev && TERMINAL.has(prev.phase)) return state;

  const at = Date.parse(str(p.occurredAt) ?? '');
  const when = Number.isFinite(at) ? at : now;
  const target = p.target && typeof p.target === 'object' && typeof (p.target as { field?: unknown }).field === 'string'
    ? p.target as DeckReviseTargetRef
    : prev?.target;
  const slideId = str(p.slideId) ?? prev?.slideId;
  const next: DeckReviseActivity = {
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
    ...(Array.isArray(p.changedSlideIds) ? { changedSlideIds: p.changedSlideIds.filter((id): id is string => typeof id === 'string') } : {}),
    ...(typeof p.status === 'number' ? { status: p.status } : {}),
    ...(str(p.reason) ? { reason: str(p.reason) } : {}),
  };
  return { ...state, [requestId]: next };
}

/** Marks unfinished revises with no event for `staleMs` as stale. Returns the same map when none are. */
export function markStaleDeckRevises(
  state: Readonly<Record<string, DeckReviseActivity>>,
  now: number,
  staleMs: number,
): Readonly<Record<string, DeckReviseActivity>> {
  let changed = false;
  const next: Record<string, DeckReviseActivity> = { ...state };
  for (const [id, activity] of Object.entries(state)) {
    if (isDeckReviseSettled(activity) || now - activity.updatedAt < staleMs) continue;
    next[id] = { ...activity, stale: true };
    changed = true;
  }
  return changed ? next : state;
}

export function useDeckReviseStatus(
  documentId: string | null | undefined,
  opts: UseDeckReviseStatusOptions = {},
): UseDeckReviseStatusResult {
  const { transport } = opts;
  const staleMs = opts.staleMs ?? DEFAULT_DECK_REVISE_STALE_MS;
  const keepRecent = opts.keepRecent ?? 10;
  const nowRef = useRef(opts.now ?? Date.now);
  nowRef.current = opts.now ?? Date.now;

  const gateway = useGatewayOptional();
  const send = transport === null ? undefined : transport ? transport.send : gateway?.sendMessage as PipelineRunTransport['send'] | undefined;
  const onMessage = transport === null ? undefined : transport ? transport.onMessage : gateway?.onMessage as PipelineRunTransport['onMessage'] | undefined;
  // A reconnect is a new server session with no subscriptions; re-send.
  const epoch = transport === undefined ? gateway?.sessionEpoch : undefined;

  const [byId, setById] = useState<Readonly<Record<string, DeckReviseActivity>>>({});

  // A different document is a different set of revises.
  useEffect(() => { setById({}); }, [documentId]);

  useEffect(() => {
    if (!documentId || !send || !onMessage) return;
    const channel = deckReviseChannel(documentId);
    send({ service: 'pipeline', action: 'subscribe', channel });
    const unregister = onMessage((frame: unknown) => {
      setById((prev) => reduceDeckReviseFrame(prev, frame, documentId, nowRef.current()));
    });
    return () => {
      unregister();
      send({ service: 'pipeline', action: 'unsubscribe', channel });
    };
  }, [documentId, send, onMessage, epoch]);

  const hasOpen = Object.values(byId).some((activity) => !isDeckReviseSettled(activity));
  useEffect(() => {
    if (!hasOpen || staleMs <= 0) return;
    const timer = setInterval(() => {
      setById((prev) => markStaleDeckRevises(prev, nowRef.current(), staleMs));
    }, Math.min(5_000, staleMs));
    return () => clearInterval(timer);
  }, [hasOpen, staleMs]);

  const derived = useMemo(() => {
    const all = Object.values(byId);
    const active = all.filter((activity) => !isDeckReviseSettled(activity)).sort((a, b) => a.startedAt - b.startedAt);
    const recent = all.filter(isDeckReviseSettled).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, keepRecent);
    const latest = [...all].sort((a, b) => b.startedAt - a.startedAt)[0];
    const generatingSlideIds = [...new Set(active.flatMap((activity) => (activity.scope === 'slide' && activity.slideId ? [activity.slideId] : [])))];
    return { active, recent, latest, generatingSlideIds, isGenerating: active.length > 0 };
  }, [byId, keepRecent]);

  const get = useCallback((requestId: string) => byId[requestId], [byId]);
  return { ...derived, get };
}

export default useDeckReviseStatus;
