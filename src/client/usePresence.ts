// realtime-modules/src/client/usePresence.ts
//
// usePresence(channel) — React hook for gateway presence.
//
// Returns:
//   roster        — PresenceEntry[] (Map<clientId, PresenceEntry> rendered as array)
//   setStatus     — send a presence:set frame with the given status
//   updateMetadata — merge metadata into the current presence entry
//
// WIRE CONTRACT (gateway-real, verified against the gateway's installed
// PresenceService.handleAction — hub#1497): the presence verbs are
// set | get | subscribe | unsubscribe | heartbeat. `subscribe` REQUIRES a
// channel ("Channel is required"). `set` REQUIRES status ("Status is
// required"; valid: online|away|busy|offline) and reads only
// { status, metadata, channels } — a top-level `channel` field is IGNORED
// (deprecated in the EC declaration); channel pinning uses the `channels`
// array, so the hook maps its channel to channels: [channel]. The service
// REPLACES the whole presence entry on every set, so the hook carries the
// last-known status + metadata on both setStatus and updateMetadata.
//
// Inbound frame shapes (gateway PresenceService send-backs):
//   { type: 'presence', action: 'subscribed', channel, presence: PresenceEntry[] }
//   { type: 'presence', action: 'set',        presence: PresenceEntry }   // own ack
//   { type: 'presence', action: 'update',     presence: PresenceEntry }   // broadcast
//   { type: 'presence', action: 'offline',    clientId }                  // departure
// (update/offline carry no top-level channel — scoping comes from the
// presence:<channel> subscription; update is filtered via presence.channels.)
// Legacy flat shapes (presence:state / presence:joined / presence:updated /
// presence:left) are still parsed as a fallback for non-gateway servers.
//
// Outbound frames (canonical declarations: @connorhoehn/event-catalog
// client-frames v0.3.56 — client.presence.subscribe / unsubscribe / set):
//   { service: 'presence', action: 'subscribe',   channel }
//   { service: 'presence', action: 'unsubscribe', channel }
//   { service: 'presence', action: 'set', status, metadata?, channels? }

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
      const raw = msg as Record<string, unknown>;

      // Gateway-real envelopes: { type: 'presence', action: ... }.
      if (msg.type === 'presence') {
        switch (msg.action) {
          case 'subscribed': {
            // Roster snapshot for the subscribed channel.
            if (msg.channel !== channelRef.current) break;
            const list = Array.isArray(raw.presence) ? (raw.presence as unknown[]) : [];
            rosterMapRef.current = new Map(
              list
                .map(asPresenceEntry)
                .filter(Boolean)
                .map((e) => [e!.clientId, e!] as [string, PresenceEntry]),
            );
            flush();
            break;
          }
          case 'set':
          case 'update': {
            // 'set' is the own-entry ack (broadcasts exclude the sender);
            // 'update' is the channel broadcast. Neither carries a top-level
            // channel — filter via the entry's pinned channels list.
            const entry = asPresenceEntry(raw.presence);
            if (entry && entry.channels.includes(channelRef.current)) {
              rosterMapRef.current.set(entry.clientId, entry);
              flush();
            }
            break;
          }
          case 'offline': {
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
        return;
      }

      // Legacy flat shapes (non-gateway servers) — kept as a fallback.
      if (msg.channel !== channelRef.current) return;

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

  // The gateway REPLACES the whole presence entry on every set, so carry
  // the last-known status + metadata across setStatus / updateMetadata
  // calls (status defaults to 'online' until the first setStatus).
  const lastStatusRef = useRef<PresenceStatus>('online');
  const lastMetadataRef = useRef<Record<string, unknown>>({});

  const setStatus = useCallback(
    (status: PresenceStatus) => {
      lastStatusRef.current = status;
      send({
        service: 'presence',
        action: 'set',
        status,
        metadata: lastMetadataRef.current,
        channels: [channelRef.current],
      } satisfies ClientFramePayload<'client.presence.set'>);
    },
    [send],
  );

  const updateMetadata = useCallback(
    (meta: Record<string, unknown>) => {
      lastMetadataRef.current = { ...lastMetadataRef.current, ...meta };
      send({
        service: 'presence',
        action: 'set',
        // status is REQUIRED by the gateway ("Status is required") — carry
        // the last-known value so metadata-only updates don't error.
        status: lastStatusRef.current,
        metadata: lastMetadataRef.current,
        channels: [channelRef.current],
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
