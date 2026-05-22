"use strict";
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
// Outbound frames:
//   { service: 'activity', action: 'subscribe', channel }
//   { service: 'activity', action: 'history',   channel, limit: number }
Object.defineProperty(exports, "__esModule", { value: true });
exports.useActivity = useActivity;
const react_1 = require("react");
const GatewaySocketProvider_1 = require("./GatewaySocketProvider");
const DEFAULT_HISTORY_LIMIT = 50;
function useActivity(channel) {
    const { send, onMessage } = (0, GatewaySocketProvider_1.useGateway)();
    const [events, setEvents] = (0, react_1.useState)([]);
    const channelRef = (0, react_1.useRef)(channel);
    (0, react_1.useEffect)(() => {
        channelRef.current = channel;
    }, [channel]);
    // Register inbound handler once.
    (0, react_1.useEffect)(() => {
        const unsubscribe = onMessage((msg) => {
            if (msg.channel !== channelRef.current)
                return;
            if (msg.type === 'activity:event') {
                const entry = asActivityEvent(msg);
                if (entry) {
                    setEvents((prev) => [...prev, entry]);
                }
            }
            else if (msg.type === 'activity:history') {
                const raw = msg;
                const list = Array.isArray(raw.events) ? raw.events : [];
                const parsed = list
                    .map((e) => asActivityEvent(e))
                    .filter(Boolean);
                setEvents(parsed);
            }
        });
        return unsubscribe;
    }, [onMessage]);
    // Subscribe / unsubscribe when channel changes.
    (0, react_1.useEffect)(() => {
        setEvents([]);
        send({ service: 'activity', action: 'subscribe', channel });
        return () => {
            send({ service: 'activity', action: 'unsubscribe', channel });
        };
    }, [channel, send]);
    const loadHistory = (0, react_1.useCallback)((limit = DEFAULT_HISTORY_LIMIT) => {
        send({ service: 'activity', action: 'history', channel: channelRef.current, limit });
    }, [send]);
    return { events, loadHistory };
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function asActivityEvent(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    if (typeof raw.eventType !== 'string')
        return null;
    return {
        eventType: raw.eventType,
        detail: (typeof raw.detail === 'object' && raw.detail !== null
            ? raw.detail
            : {}),
        timestamp: typeof raw.timestamp === 'string' ? raw.timestamp : new Date().toISOString(),
        userId: typeof raw.userId === 'string' ? raw.userId : null,
        displayName: typeof raw.displayName === 'string' ? raw.displayName : 'anonymous',
    };
}
//# sourceMappingURL=useActivity.js.map