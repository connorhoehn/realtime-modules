// realtime-modules/src/client/useActivity.ts
//
// useActivity(channel) — React hook for gateway activity feed.
//
// Returns:
//   events      — accumulated ActivityEvent[] for the channel (oldest first)
//   loadHistory — request prior activity events from the gateway
//
// Inbound frame shapes (gateway ActivityService — verified against the
// gateway's running dist + the gateway frontend's useActivityBus, hub#1492):
//
//   Live event (payload-wrapped, NO channel field on the envelope):
//     { type: 'activity:event',
//       payload: { eventType, detail, timestamp, userId, displayName } }
//
//   History response:
//     { type: 'activity', action: 'history',
//       events: ActivityEvent[], channelId, timestamp }
//
// Channel-filtering decision: the gateway broadcasts every live activity
// event to the single global 'activity:broadcast' channel (every client is
// auto-subscribed on connect) and scopes delivery via that channel
// subscription (messageRouter.sendToChannel). Neither the envelope nor the
// payload carries a channel field, so per-frame channel filtering of live
// events is impossible AND unnecessary — the hook accepts every
// `activity:event` frame the socket delivers. History responses DO carry
// `channelId`, which is filtered against the subscribed channel.
//
// Legacy fallback (pre-0.13.1 / other servers) — still parsed, payload-first
// then flat:
//     { type: 'activity:event',   channel, ...ActivityEvent }   (flat)
//     { type: 'activity:history', channel, events: [...] }
// Legacy frames that DO carry a `channel` field are filtered against the
// subscribed channel (preserves the old behavior for old servers).
//
// Outbound frames (what the gateway's ActivityService.handleAction accepts):
//   { service: 'activity', action: 'subscribe',   channelId }
//   { service: 'activity', action: 'unsubscribe', channelId }
//   { service: 'activity', action: 'getHistory',  channelId, limit }
// The gateway reads `channelId` (NOT `channel`) and the history verb is
// 'getHistory' (NOT 'history'). The frames also carry the legacy `channel`
// field for tolerance toward servers still reading the old shape — the
// gateway ignores unknown fields. event-catalog v0.3.56 now declares the
// gateway-real frames (client.activity.subscribe / unsubscribe /
// getHistory, all keyed on `channelId`), so every send-site carries a
// `satisfies` annotation again (hub#1497 closed the hub#1492 divergence).

import { useState, useEffect, useRef, useCallback } from 'react';
import { useGateway } from './GatewaySocketProvider';
import type { ActivityEvent } from './types';
import type { GatewayMessage } from './types';
// Type-only import — erased at build; the EC package stays a devDependency.
import type { ClientFramePayload } from '@connorhoehn/event-catalog/client-frames';

const DEFAULT_HISTORY_LIMIT = 50;

export interface UseActivityReturn {
  events: ActivityEvent[];
  loadHistory: (limit?: number) => void;
}

export function useActivity(channel: string): UseActivityReturn {
  const { send, onMessage } = useGateway();
  const [events, setEvents] = useState<ActivityEvent[]>([]);

  const channelRef = useRef(channel);
  useEffect(() => {
    channelRef.current = channel;
  }, [channel]);

  // Register inbound handler once.
  useEffect(() => {
    const unsubscribe = onMessage((msg: GatewayMessage) => {
      const raw = msg as Record<string, unknown>;

      if (msg.type === 'activity:event') {
        // Real gateway frames carry no channel field (global broadcast —
        // see header). Legacy flat frames do; filter only when present.
        if (typeof msg.channel === 'string' && msg.channel !== channelRef.current) {
          return;
        }
        // Payload-first (real gateway envelope), flat-fallback (legacy).
        const source =
          raw.payload && typeof raw.payload === 'object'
            ? (raw.payload as Record<string, unknown>)
            : raw;
        const entry = asActivityEvent(source);
        if (entry) {
          setEvents((prev) => [...prev, entry]);
        }
        return;
      }

      // History — real envelope { type:'activity', action:'history',
      // events, channelId } first; legacy { type:'activity:history',
      // channel, events } fallback. Other `type:'activity'` action acks
      // (subscribed / unsubscribed / published) fall through untouched.
      const isHistory =
        (msg.type === 'activity' && msg.action === 'history') ||
        msg.type === 'activity:history';
      if (!isHistory) return;

      const frameChannel =
        typeof raw.channelId === 'string'
          ? raw.channelId
          : typeof raw.channel === 'string'
            ? raw.channel
            : null;
      if (frameChannel !== null && frameChannel !== channelRef.current) return;

      const list = Array.isArray(raw.events) ? (raw.events as unknown[]) : [];
      const parsed = list
        .map((e) => asActivityEvent(e as Record<string, unknown>))
        .filter(Boolean) as ActivityEvent[];
      setEvents(parsed);
    });
    return unsubscribe;
  }, [onMessage]);

  // Subscribe / unsubscribe when channel changes. The gateway reads
  // `channelId`; `channel` is kept for legacy-server tolerance (EC v0.3.56
  // declares it as an optional deprecated field).
  useEffect(() => {
    setEvents([]);
    send({
      service: 'activity',
      action: 'subscribe',
      channel,
      channelId: channel,
    } satisfies ClientFramePayload<'client.activity.subscribe'>);
    return () => {
      send({
        service: 'activity',
        action: 'unsubscribe',
        channel,
        channelId: channel,
      } satisfies ClientFramePayload<'client.activity.unsubscribe'>);
    };
  }, [channel, send]);

  const loadHistory = useCallback(
    (limit: number = DEFAULT_HISTORY_LIMIT) => {
      // Gateway verb is 'getHistory' with `channelId` — the gateway rejects
      // action 'history' with "Unknown activity action". EC v0.3.56 now
      // declares client.activity.getHistory (hub#1497 closed the hub#1492
      // divergence), so the `satisfies` annotation is back.
      send({
        service: 'activity',
        action: 'getHistory',
        channel: channelRef.current,
        channelId: channelRef.current,
        limit,
      } satisfies ClientFramePayload<'client.activity.getHistory'>);
    },
    [send],
  );

  return { events, loadHistory };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asActivityEvent(raw: Record<string, unknown>): ActivityEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.eventType !== 'string') return null;
  return {
    eventType: raw.eventType,
    detail: (typeof raw.detail === 'object' && raw.detail !== null
      ? raw.detail
      : {}) as Record<string, unknown>,
    timestamp: typeof raw.timestamp === 'string' ? raw.timestamp : new Date().toISOString(),
    userId: typeof raw.userId === 'string' ? raw.userId : null,
    displayName: typeof raw.displayName === 'string' ? raw.displayName : 'anonymous',
  };
}
