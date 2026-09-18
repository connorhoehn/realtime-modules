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
  /**
   * Record an activity event.
   *
   * The server stamps `timestamp`, `userId` and `displayName` from the
   * connection's own auth context, so a client cannot publish as somebody
   * else — you supply the type and the detail, and nothing more.
   *
   * The event comes back through the normal broadcast (the publisher is not
   * excluded from it), so `events` updates from the server's copy rather than
   * an optimistic one, and what you see is what everyone else sees.
   *
   * Remember this feed is global: what you publish here reaches every
   * subscriber on every channel, not just this hook's.
   */
  publish: (eventType: string, detail?: Record<string, unknown>) => void;
}

export function useActivity(channel: string): UseActivityReturn {
  const { send, onMessage, sessionEpoch } = useGateway();
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
  // The channel this effect last ran for, so a re-run can tell a channel
  // change from a reconnect.
  const subscribedChannelRef = useRef<string | null>(null);
  // Whether the caller has asked for history on this channel, and with what.
  const loadedHistoryRef = useRef(false);
  const lastHistoryLimitRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    const reconnected = subscribedChannelRef.current === channel;
    subscribedChannelRef.current = channel;

    // A reconnect does NOT clear the feed. Unlike chat's join, an activity
    // subscribe pushes nothing back — the server answers with a bare
    // `subscribed` ack — so clearing here emptied the feed and left nothing
    // to refill it. Every reconnect wiped the panel, permanently, with no
    // event to say why. The events already held are still true: they
    // happened, and a new socket does not un-happen them.
    if (!reconnected) {
      setEvents([]);
      loadedHistoryRef.current = false;
      lastHistoryLimitRef.current = undefined;
    }

    send({
      service: 'activity',
      action: 'subscribe',
      channel,
      channelId: channel,
    } satisfies ClientFramePayload<'client.activity.subscribe'>);

    // Anything that happened while the socket was down was missed. Re-asking
    // fills that gap — but only for a caller who was using history, since a
    // history frame REPLACES the list and would otherwise discard the live
    // events this hook just protected.
    if (reconnected && loadedHistoryRef.current) {
      send({
        service: 'activity',
        action: 'getHistory',
        channel,
        channelId: channel,
        limit: lastHistoryLimitRef.current ?? DEFAULT_HISTORY_LIMIT,
      } satisfies ClientFramePayload<'client.activity.getHistory'>);
    }
    return () => {
      send({
        service: 'activity',
        action: 'unsubscribe',
        channel,
        channelId: channel,
      } satisfies ClientFramePayload<'client.activity.unsubscribe'>);
    };
      // sessionEpoch: a reconnect is a NEW server-side connection that has
    // joined nothing. Keyed only on `send` — a stable callback — this effect
    // would never fire again, and the hook would sit silently unsubscribed
    // while connectionState reads 'connected'.
  }, [channel, send, sessionEpoch]);

  // ActivityService accepts `publish`, and until now the hook did not expose
  // it — so recording an event meant hand-rolling the frame through
  // useGateway(), duplicating the envelope this file already owns.
  //
  // No `satisfies` annotation: event-catalog declares the activity service's
  // subscribe / unsubscribe / getHistory but not publish. The verb is real on
  // both servers — EC declares the INBOUND `ws.activity.published` as
  // "confirmation sent back to the client that published an activity event" —
  // so the omission is a gap in the catalog's outbound set rather than a
  // missing capability. Same footing as the cursor verbs.
  const publish = useCallback(
    (eventType: string, detail?: Record<string, unknown>) => {
      if (!eventType) return; // the server refuses it anyway; no point in the round trip
      send({
        service: 'activity',
        action: 'publish',
        event: { eventType, detail: detail ?? {} },
      });
    },
    [send],
  );

  const loadHistory = useCallback(
    (limit: number = DEFAULT_HISTORY_LIMIT) => {
      // Gateway verb is 'getHistory' with `channelId` — the gateway rejects
      // action 'history' with "Unknown activity action". EC v0.3.56 now
      // declares client.activity.getHistory (hub#1497 closed the hub#1492
      // divergence), so the `satisfies` annotation is back.
      // Remembered so a reconnect can re-ask for the same depth.
      loadedHistoryRef.current = true;
      lastHistoryLimitRef.current = limit;
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

  return { events, loadHistory, publish };
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
