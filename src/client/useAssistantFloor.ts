// realtime-modules/src/client/useAssistantFloor.ts
//
// Who has a call assistant's ear, pushed. A call that runs its assistant
// hands-free has a "floor": at most one person the assistant is listening to
// (they said its name, asked a follow-up, or are holding a talk button). The
// server sends a frame on the call's chat channel whenever the floor changes:
//
//   { type: 'assistant-floor', channel, handsfree: boolean,
//     floor: { userId, name, via, phase } | null }
//
// The hook reads the floor once with `read` (the app's REST read; it may also
// carry per-viewer fields such as `mayHold`), then applies every frame for its
// channel. It reads again after the socket reconnects (frames sent while it
// was away are lost), and never polls. The channel guard is the server's: a
// frame reaches only sockets admitted to that channel.
//
//   const { view } = useAssistantFloor({
//     channel: `orgiq:huddle:${callId}`,
//     read: (signal) => fetch(`/api/calls/${callId}/assistant/floor`, { signal }).then((r) => r.json()),
//   });
//
// The socket: the `gateway` option (anything with `onMessage`, and
// `connectionState` for the reconnect read), else the nearest GatewayContext.

import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { GatewayContext } from './GatewaySocketProvider';

export const ASSISTANT_FLOOR_FRAME = 'assistant-floor' as const;

export type AssistantFloorVia = 'name' | 'follow-up' | 'hold';
export type AssistantFloorPhase = 'routing' | 'answering';

export interface AssistantFloor {
  /** Who the assistant is listening to (the app's user id; a guest's id as the app writes it). */
  userId: string;
  /** Their name as every viewer may see it. */
  name: string;
  /** How they got the floor. */
  via: AssistantFloorVia;
  /** Still being heard (`routing`) or being answered (`answering`). */
  phase: AssistantFloorPhase;
}

export interface AssistantFloorView {
  /** The call runs its assistant hands-free now. */
  handsfree: boolean;
  /** Who has the floor; always null while not hands-free. */
  floor: AssistantFloor | null;
  /** May this viewer take the floor by holding (from `read` only; frames never carry it). */
  mayHold?: boolean;
}

export interface AssistantFloorFrame {
  type: typeof ASSISTANT_FLOOR_FRAME;
  channel: string;
  handsfree: boolean;
  floor: AssistantFloor | null;
}

export const NO_ASSISTANT_FLOOR: AssistantFloorView = Object.freeze({ handsfree: false, floor: null });

const VIA: readonly AssistantFloorVia[] = ['name', 'follow-up', 'hold'];
const PHASE: readonly AssistantFloorPhase[] = ['routing', 'answering'];
const MAX_NAME = 80;

const recordOf = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;

/** Reads a floor body (a `read` answer or a frame); anything malformed is no floor. `mayHold` is kept when it is a boolean. */
export function parseAssistantFloor(body: unknown): AssistantFloorView {
  const b = recordOf(body) ?? {};
  const f = recordOf(b['floor']);
  const via = VIA.find((v) => v === f?.['via']);
  const phase = PHASE.find((p) => p === f?.['phase']);
  const userId = f?.['userId'];
  const name = typeof f?.['name'] === 'string' ? (f['name'] as string).trim() : '';
  const handsfree = b['handsfree'] === true;
  const floor = handsfree && typeof userId === 'string' && userId && name && via && phase
    ? { userId, name: name.slice(0, MAX_NAME), via, phase } : null;
  return { handsfree, floor, ...(typeof b['mayHold'] === 'boolean' ? { mayHold: b['mayHold'] as boolean } : {}) };
}

/** The frame a server sends on `channel` when the floor changes (the shape the hook applies). */
export function assistantFloorFrame(channel: string, view: Pick<AssistantFloorView, 'handsfree' | 'floor'>): AssistantFloorFrame {
  return { type: ASSISTANT_FLOOR_FRAME, channel, handsfree: view.handsfree, floor: view.handsfree ? view.floor : null };
}

/** A floor frame for `channel`, parsed; null for any other frame. */
export function floorFromFrame(frame: unknown, channel: string): AssistantFloorView | null {
  const f = recordOf(frame);
  if (!f || f['type'] !== ASSISTANT_FLOOR_FRAME || f['channel'] !== channel) return null;
  const { mayHold: _ignored, ...view } = parseAssistantFloor(f);
  return view;
}

/** Any frame handler (method-typed, so a socket whose handler takes its own message type fits). */
type FrameHandler = { bivarianceHack(frame: unknown): void }['bivarianceHack'];

export interface AssistantFloorGateway {
  onMessage(handler: FrameHandler): () => void;
  connectionState?: string;
}

export interface UseAssistantFloorOptions {
  /** The call's chat channel the frames ride; null: nothing is read or applied. */
  channel: string | null;
  /** The initial (and reconnect) read; its answer goes through `parseAssistantFloor`. */
  read?: (signal: AbortSignal) => Promise<unknown>;
  /** The socket; default the nearest GatewayContext. */
  gateway?: AssistantFloorGateway | null;
  /** False: nothing is read or applied, the view is NO_ASSISTANT_FLOOR. Default true. */
  enabled?: boolean;
}

export interface UseAssistantFloorResult {
  view: AssistantFloorView;
  /** Read again now (e.g. after an action whose answer is not a floor body). */
  refresh: () => void;
  /** Apply a floor body the app already holds (e.g. a hold action's answer); `mayHold` kept unless the body sets it. */
  apply: (body: unknown) => void;
}

export function useAssistantFloor(options: UseAssistantFloorOptions): UseAssistantFloorResult {
  const { channel, read, enabled = true } = options;
  const context = useContext(GatewayContext);
  const gateway: AssistantFloorGateway | null = options.gateway !== undefined ? options.gateway : context;
  const on = enabled && !!channel;
  const [view, setView] = useState<AssistantFloorView>(NO_ASSISTANT_FLOOR);
  const readRef = useRef(read);
  readRef.current = read;
  const [readEpoch, setReadEpoch] = useState(0);

  // A frame changes who has the floor; the viewer's own `mayHold` stays as last read.
  const merge = useCallback((next: AssistantFloorView) => {
    setView((cur) => ({ ...next, ...(next.mayHold === undefined && cur.mayHold !== undefined ? { mayHold: cur.mayHold } : {}) }));
  }, []);

  useEffect(() => {
    if (!on) { setView(NO_ASSISTANT_FLOOR); return undefined; }
    const doRead = readRef.current;
    if (!doRead) return undefined;
    const ctrl = new AbortController();
    doRead(ctrl.signal).then((body) => { if (!ctrl.signal.aborted) merge(parseAssistantFloor(body)); }, () => { /* keep the last floor */ });
    return () => ctrl.abort();
  }, [on, channel, readEpoch, merge]);

  const onMessage = gateway?.onMessage;
  useEffect(() => {
    if (!on || !onMessage || !channel) return undefined;
    return onMessage((frame: unknown) => { const next = floorFromFrame(frame, channel); if (next) merge(next); });
  }, [on, onMessage, channel, merge]);

  // Frames sent while the socket was away are lost: read again when it is back.
  const connectionState = gateway?.connectionState;
  const wasConnected = useRef(connectionState === 'connected');
  useEffect(() => {
    const connected = connectionState === 'connected';
    if (connected && !wasConnected.current && on) setReadEpoch((n) => n + 1);
    wasConnected.current = connected;
  }, [connectionState, on]);

  const refresh = useCallback(() => setReadEpoch((n) => n + 1), []);
  const apply = useCallback((body: unknown) => merge(parseAssistantFloor(body)), [merge]);
  return { view: on ? view : NO_ASSISTANT_FLOOR, refresh, apply };
}
