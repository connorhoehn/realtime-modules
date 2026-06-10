// realtime-modules/src/client/useVideoHangout.ts
//
// useVideoHangout(channel) — React hook for LVS video session signaling + state.
//
// Responsibilities:
//   - Signal signaling only — WebRTC/media is the web-broadcast-shim's job.
//   - Manages participant list, joinToken, video/audio toggle state via WS frames.
//   - Returns joinToken so the consumer can pass it to <Stage> (web-broadcast-shim).
//
// Inbound frame types:
//   videohangout:created      — { session: { id, type, createdAt }, joinToken }
//   videohangout:joined       — { session, joinToken, participants }
//   videohangout:participant   — { participant: HangoutParticipant }  (join/update)
//   videohangout:left         — { clientId }
//   videohangout:media        — { clientId, videoOn, audioOn }
//   videohangout:ended        — session ended by host
//   videohangout:error        — { error: string }
//
// Outbound frames (canonical declarations: @connorhoehn/event-catalog
// client-frames — client.videohangout.*):
//   { service: 'videohangout', action: 'start',  channel, type?, metadata? }
//   { service: 'videohangout', action: 'join',   channel, sessionId }
//   { service: 'videohangout', action: 'leave',  channel, sessionId }
//   { service: 'videohangout', action: 'end',    channel, sessionId }
//   { service: 'videohangout', action: 'toggle-video', channel, sessionId, videoOn }
//   { service: 'videohangout', action: 'toggle-audio', channel, sessionId, audioOn }

import { useState, useEffect, useRef, useCallback } from 'react';
import { useGateway } from './GatewaySocketProvider';
import type { GatewayMessage } from './types';
// Type-only import — erased at build; the EC package stays a devDependency.
import type { ClientFramePayload } from '@connorhoehn/event-catalog/client-frames';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface HangoutParticipant {
  clientId: string;
  displayName?: string;
  role: 'host' | 'participant' | 'viewer';
  videoOn: boolean;
  audioOn: boolean;
  joinedAt: string;
}

export interface HangoutSession {
  id: string;
  type: string;
  createdAt: string;
}

export interface UseVideoHangoutResult {
  session: HangoutSession | null;
  participants: HangoutParticipant[];
  joinToken: string | null;
  start(opts?: { type?: 'hangout' | 'call'; metadata?: Record<string, unknown> }): Promise<void>;
  join(sessionId: string): Promise<void>;
  leave(): Promise<void>;
  end(): Promise<void>;
  toggleVideo(): void;
  toggleAudio(): void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asParticipant(raw: unknown): HangoutParticipant | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.clientId !== 'string') return null;
  return {
    clientId: p.clientId,
    displayName: typeof p.displayName === 'string' ? p.displayName : undefined,
    role:
      p.role === 'host' || p.role === 'participant' || p.role === 'viewer'
        ? p.role
        : 'participant',
    videoOn: p.videoOn === true,
    audioOn: p.audioOn === true,
    joinedAt: typeof p.joinedAt === 'string' ? p.joinedAt : new Date().toISOString(),
  };
}

function asSession(raw: unknown): HangoutSession | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.id !== 'string') return null;
  return {
    id: s.id,
    type: typeof s.type === 'string' ? s.type : 'hangout',
    createdAt: typeof s.createdAt === 'string' ? s.createdAt : new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Hook implementation
// ---------------------------------------------------------------------------

export function useVideoHangout(channel: string): UseVideoHangoutResult {
  const { send, onMessage } = useGateway();

  const [session, setSession] = useState<HangoutSession | null>(null);
  const [participants, setParticipants] = useState<HangoutParticipant[]>([]);
  const [joinToken, setJoinToken] = useState<string | null>(null);

  // Own media state (reflected in the participants list once the gateway echoes back).
  const videoOnRef = useRef(true);
  const audioOnRef = useRef(true);

  const channelRef = useRef(channel);
  useEffect(() => {
    channelRef.current = channel;
  }, [channel]);

  const sessionRef = useRef<HangoutSession | null>(null);
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  // Pending start/join resolvers — fulfilled when gateway sends the created/joined frame.
  type Resolver = { resolve: () => void; reject: (e: Error) => void };
  const pendingStartRef = useRef<Resolver | null>(null);
  const pendingJoinRef = useRef<Resolver | null>(null);

  // ---- Inbound handler ------------------------------------------------------

  useEffect(() => {
    const unsubscribe = onMessage((msg: GatewayMessage) => {
      if (msg.channel !== channelRef.current) return;
      if (typeof msg.type !== 'string' || !msg.type.startsWith('videohangout:')) return;

      const raw = msg as Record<string, unknown>;

      switch (msg.type) {
        case 'videohangout:created': {
          const sess = asSession(raw.session);
          const token = typeof raw.joinToken === 'string' ? raw.joinToken : null;
          if (sess) setSession(sess);
          if (token) setJoinToken(token);
          const r = pendingStartRef.current;
          if (r) {
            pendingStartRef.current = null;
            r.resolve();
          }
          break;
        }
        case 'videohangout:joined': {
          const sess = asSession(raw.session);
          const token = typeof raw.joinToken === 'string' ? raw.joinToken : null;
          if (sess) setSession(sess);
          if (token) setJoinToken(token);
          // Replace full participant list if provided.
          if (Array.isArray(raw.participants)) {
            const list = (raw.participants as unknown[])
              .map(asParticipant)
              .filter(Boolean) as HangoutParticipant[];
            setParticipants(list);
          }
          const r = pendingJoinRef.current;
          if (r) {
            pendingJoinRef.current = null;
            r.resolve();
          }
          break;
        }
        case 'videohangout:participant': {
          // A participant joined or updated their state.
          const p = asParticipant(raw.participant);
          if (!p) break;
          setParticipants((prev) => {
            const idx = prev.findIndex((x) => x.clientId === p.clientId);
            if (idx === -1) return [...prev, p];
            const next = [...prev];
            next[idx] = p;
            return next;
          });
          break;
        }
        case 'videohangout:left': {
          const clientId = typeof raw.clientId === 'string' ? raw.clientId : null;
          if (clientId) {
            setParticipants((prev) => prev.filter((p) => p.clientId !== clientId));
          }
          break;
        }
        case 'videohangout:media': {
          const clientId = typeof raw.clientId === 'string' ? raw.clientId : null;
          if (!clientId) break;
          setParticipants((prev) =>
            prev.map((p) =>
              p.clientId === clientId
                ? {
                    ...p,
                    videoOn: typeof raw.videoOn === 'boolean' ? raw.videoOn : p.videoOn,
                    audioOn: typeof raw.audioOn === 'boolean' ? raw.audioOn : p.audioOn,
                  }
                : p,
            ),
          );
          break;
        }
        case 'videohangout:ended': {
          setSession(null);
          setParticipants([]);
          setJoinToken(null);
          break;
        }
        case 'videohangout:error': {
          const errMsg = typeof raw.error === 'string' ? raw.error : 'Video hangout error';
          // Reject any pending resolver.
          const rs = pendingStartRef.current;
          if (rs) {
            pendingStartRef.current = null;
            rs.reject(new Error(errMsg));
          }
          const rj = pendingJoinRef.current;
          if (rj) {
            pendingJoinRef.current = null;
            rj.reject(new Error(errMsg));
          }
          break;
        }
        default:
          break;
      }
    });
    return unsubscribe;
  }, [onMessage]);

  // Reset state when channel changes.
  useEffect(() => {
    setSession(null);
    setParticipants([]);
    setJoinToken(null);
    pendingStartRef.current = null;
    pendingJoinRef.current = null;
  }, [channel]);

  // ---- Actions --------------------------------------------------------------

  const start = useCallback(
    async (opts?: { type?: 'hangout' | 'call'; metadata?: Record<string, unknown> }): Promise<void> => {
      return new Promise((resolve, reject) => {
        pendingStartRef.current = { resolve, reject };
        send({
          service: 'videohangout',
          action: 'start',
          channel: channelRef.current,
          ...(opts?.type ? { type: opts.type } : {}),
          ...(opts?.metadata ? { metadata: opts.metadata } : {}),
        } satisfies ClientFramePayload<'client.videohangout.start'>);
      });
    },
    [send],
  );

  const join = useCallback(
    async (sessionId: string): Promise<void> => {
      return new Promise((resolve, reject) => {
        pendingJoinRef.current = { resolve, reject };
        send({
          service: 'videohangout',
          action: 'join',
          channel: channelRef.current,
          sessionId,
        } satisfies ClientFramePayload<'client.videohangout.join'>);
      });
    },
    [send],
  );

  const leave = useCallback(async (): Promise<void> => {
    const sess = sessionRef.current;
    if (!sess) return;
    send({
      service: 'videohangout',
      action: 'leave',
      channel: channelRef.current,
      sessionId: sess.id,
    } satisfies ClientFramePayload<'client.videohangout.leave'>);
    setSession(null);
    setParticipants([]);
    setJoinToken(null);
  }, [send]);

  const end = useCallback(async (): Promise<void> => {
    const sess = sessionRef.current;
    if (!sess) return;
    send({
      service: 'videohangout',
      action: 'end',
      channel: channelRef.current,
      sessionId: sess.id,
    } satisfies ClientFramePayload<'client.videohangout.end'>);
    setSession(null);
    setParticipants([]);
    setJoinToken(null);
  }, [send]);

  const toggleVideo = useCallback(() => {
    const sess = sessionRef.current;
    if (!sess) return;
    videoOnRef.current = !videoOnRef.current;
    send({
      service: 'videohangout',
      action: 'toggle-video',
      channel: channelRef.current,
      sessionId: sess.id,
      videoOn: videoOnRef.current,
    } satisfies ClientFramePayload<'client.videohangout.toggle-video'>);
  }, [send]);

  const toggleAudio = useCallback(() => {
    const sess = sessionRef.current;
    if (!sess) return;
    audioOnRef.current = !audioOnRef.current;
    send({
      service: 'videohangout',
      action: 'toggle-audio',
      channel: channelRef.current,
      sessionId: sess.id,
      audioOn: audioOnRef.current,
    } satisfies ClientFramePayload<'client.videohangout.toggle-audio'>);
  }, [send]);

  return {
    session,
    participants,
    joinToken,
    start,
    join,
    leave,
    end,
    toggleVideo,
    toggleAudio,
  };
}
