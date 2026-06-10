// realtime-modules/src/client/useActivity.ts
//
// useActivity(channel) — React hook for gateway activity feed.
//
// Returns:
//   events      — accumulated ActivityEvent[] for the channel (oldest first)
//   loadHistory — request prior activity events from the gateway
//
// Inbound frame shapes (gateway activity service):
//   { type: 'activity:event',   channel, ...ActivityEvent }
//   { type: 'activity:history', channel, events: ActivityEvent[] }
//
// Outbound frames (canonical declarations: @connorhoehn/event-catalog
// client-frames — client.activity.subscribe / unsubscribe / history):
//   { service: 'activity', action: 'subscribe',   channel }
//   { service: 'activity', action: 'unsubscribe', channel }
//   { service: 'activity', action: 'history',     channel, limit: number }

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
      if (msg.channel !== channelRef.current) return;

      if (msg.type === 'activity:event') {
        const entry = asActivityEvent(msg as Record<string, unknown>);
        if (entry) {
          setEvents((prev) => [...prev, entry]);
        }
      } else if (msg.type === 'activity:history') {
        const raw = msg as Record<string, unknown>;
        const list = Array.isArray(raw.events) ? (raw.events as unknown[]) : [];
        const parsed = list
          .map((e) => asActivityEvent(e as Record<string, unknown>))
          .filter(Boolean) as ActivityEvent[];
        setEvents(parsed);
      }
    });
    return unsubscribe;
  }, [onMessage]);

  // Subscribe / unsubscribe when channel changes.
  useEffect(() => {
    setEvents([]);
    send({
      service: 'activity',
      action: 'subscribe',
      channel,
    } satisfies ClientFramePayload<'client.activity.subscribe'>);
    return () => {
      send({
        service: 'activity',
        action: 'unsubscribe',
        channel,
      } satisfies ClientFramePayload<'client.activity.unsubscribe'>);
    };
  }, [channel, send]);

  const loadHistory = useCallback(
    (limit: number = DEFAULT_HISTORY_LIMIT) => {
      send({
        service: 'activity',
        action: 'history',
        channel: channelRef.current,
        limit,
      } satisfies ClientFramePayload<'client.activity.history'>);
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
