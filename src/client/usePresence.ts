// realtime-modules/src/client/usePresence.ts
//
// usePresence(channel) — React hook for gateway presence.
//
// Returns:
//   roster        — PresenceEntry[] (Map<clientId, PresenceEntry> rendered as array)
//   setStatus     — send a presence:set frame with the given status
//   updateMetadata — merge metadata into the current presence entry
//
// Inbound frame shapes (gateway presence service):
//   { type: 'presence:state',   channel, clients: PresenceEntry[] }
//   { type: 'presence:joined',  channel, client: PresenceEntry }
//   { type: 'presence:updated', channel, client: PresenceEntry }
//   { type: 'presence:left',    channel, clientId: string }
//
// Outbound frames (canonical declarations: @connorhoehn/event-catalog
// client-frames — client.presence.subscribe / unsubscribe / set):
//   { service: 'presence', action: 'subscribe',   channel }
//   { service: 'presence', action: 'unsubscribe', channel }
//   { service: 'presence', action: 'set',         channel, status, metadata? }

import { useState, useEffect, useRef, useCallback } from 'react';
import { useGateway } from './GatewaySocketProvider';
import type { PresenceEntry, PresenceStatus } from './types';
import type { GatewayMessage } from './types';
// Type-only import — erased at build; the EC package stays a devDependency.
import type { ClientFramePayload } from '@connorhoehn/event-catalog/client-frames';

export interface UsePresenceReturn {
  roster: PresenceEntry[];
  setStatus: (status: PresenceStatus) => void;
  updateMetadata: (meta: Record<string, unknown>) => void;
}

export function usePresence(channel: string): UsePresenceReturn {
  const { send, onMessage } = useGateway();

  // Internal roster kept in a Map for O(1) updates; exposed as sorted array.
  const rosterMapRef = useRef<Map<string, PresenceEntry>>(new Map());
  const [roster, setRoster] = useState<PresenceEntry[]>([]);

  const channelRef = useRef(channel);
  useEffect(() => {
    channelRef.current = channel;
  }, [channel]);

  // Snapshot the Map into the state array (sorted by clientId for stability).
  const flush = useCallback(() => {
    setRoster(Array.from(rosterMapRef.current.values()).sort((a, b) =>
      a.clientId.localeCompare(b.clientId),
    ));
  }, []);

  // Register inbound handler once.
  useEffect(() => {
    const unsubscribe = onMessage((msg: GatewayMessage) => {
      if (msg.channel !== channelRef.current) return;

      const raw = msg as Record<string, unknown>;

      switch (msg.type) {
        case 'presence:state': {
          // Full roster snapshot — replace the map.
          const list = Array.isArray(raw.clients) ? (raw.clients as unknown[]) : [];
          rosterMapRef.current = new Map(
            list
              .map(asPresenceEntry)
              .filter(Boolean)
              .map((e) => [e!.clientId, e!] as [string, PresenceEntry]),
          );
          flush();
          break;
        }
        case 'presence:joined':
        case 'presence:updated': {
          const entry = asPresenceEntry(raw.client);
          if (entry) {
            rosterMapRef.current.set(entry.clientId, entry);
            flush();
          }
          break;
        }
        case 'presence:left': {
          const clientId = typeof raw.clientId === 'string' ? raw.clientId : null;
          if (clientId) {
            rosterMapRef.current.delete(clientId);
            flush();
          }
          break;
        }
        default:
          break;
      }
    });
    return unsubscribe;
  }, [onMessage, flush]);

  // Subscribe / unsubscribe when channel changes.
  useEffect(() => {
    rosterMapRef.current = new Map();
    setRoster([]);
    send({
      service: 'presence',
      action: 'subscribe',
      channel,
    } satisfies ClientFramePayload<'client.presence.subscribe'>);
    return () => {
      send({
        service: 'presence',
        action: 'unsubscribe',
        channel,
      } satisfies ClientFramePayload<'client.presence.unsubscribe'>);
    };
  }, [channel, send]);

  const setStatus = useCallback(
    (status: PresenceStatus) => {
      send({
        service: 'presence',
        action: 'set',
        channel: channelRef.current,
        status,
      } satisfies ClientFramePayload<'client.presence.set'>);
    },
    [send],
  );

  const updateMetadata = useCallback(
    (meta: Record<string, unknown>) => {
      send({
        service: 'presence',
        action: 'set',
        channel: channelRef.current,
        metadata: meta,
      } satisfies ClientFramePayload<'client.presence.set'>);
    },
    [send],
  );

  return { roster, setStatus, updateMetadata };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asPresenceEntry(raw: unknown): PresenceEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.clientId !== 'string') return null;
  return {
    clientId: m.clientId,
    status: (typeof m.status === 'string' ? m.status : 'online') as PresenceStatus,
    metadata: (typeof m.metadata === 'object' && m.metadata !== null
      ? m.metadata
      : {}) as Record<string, unknown>,
    channels: Array.isArray(m.channels)
      ? (m.channels as string[]).filter((c) => typeof c === 'string')
      : [],
    nodeId: typeof m.nodeId === 'string' ? m.nodeId : '',
    timestamp: typeof m.timestamp === 'string' ? m.timestamp : new Date().toISOString(),
    lastSeen: typeof m.lastSeen === 'string' ? m.lastSeen : new Date().toISOString(),
    lastHeartbeat: typeof m.lastHeartbeat === 'number' ? m.lastHeartbeat : Date.now(),
  };
}
