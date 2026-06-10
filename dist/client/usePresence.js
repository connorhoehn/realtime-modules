"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.usePresence = usePresence;
const react_1 = require("react");
const GatewaySocketProvider_1 = require("./GatewaySocketProvider");
function usePresence(channel) {
    const { send, onMessage } = (0, GatewaySocketProvider_1.useGateway)();
    // Internal roster kept in a Map for O(1) updates; exposed as sorted array.
    const rosterMapRef = (0, react_1.useRef)(new Map());
    const [roster, setRoster] = (0, react_1.useState)([]);
    const channelRef = (0, react_1.useRef)(channel);
    (0, react_1.useEffect)(() => {
        channelRef.current = channel;
    }, [channel]);
    // Snapshot the Map into the state array (sorted by clientId for stability).
    const flush = (0, react_1.useCallback)(() => {
        setRoster(Array.from(rosterMapRef.current.values()).sort((a, b) => a.clientId.localeCompare(b.clientId)));
    }, []);
    // Register inbound handler once.
    (0, react_1.useEffect)(() => {
        const unsubscribe = onMessage((msg) => {
            if (msg.channel !== channelRef.current)
                return;
            const raw = msg;
            switch (msg.type) {
                case 'presence:state': {
                    // Full roster snapshot — replace the map.
                    const list = Array.isArray(raw.clients) ? raw.clients : [];
                    rosterMapRef.current = new Map(list
                        .map(asPresenceEntry)
                        .filter(Boolean)
                        .map((e) => [e.clientId, e]));
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
    (0, react_1.useEffect)(() => {
        rosterMapRef.current = new Map();
        setRoster([]);
        send({
            service: 'presence',
            action: 'subscribe',
            channel,
        });
        return () => {
            send({
                service: 'presence',
                action: 'unsubscribe',
                channel,
            });
        };
    }, [channel, send]);
    const setStatus = (0, react_1.useCallback)((status) => {
        send({
            service: 'presence',
            action: 'set',
            channel: channelRef.current,
            status,
        });
    }, [send]);
    const updateMetadata = (0, react_1.useCallback)((meta) => {
        send({
            service: 'presence',
            action: 'set',
            channel: channelRef.current,
            metadata: meta,
        });
    }, [send]);
    return { roster, setStatus, updateMetadata };
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function asPresenceEntry(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const m = raw;
    if (typeof m.clientId !== 'string')
        return null;
    return {
        clientId: m.clientId,
        status: (typeof m.status === 'string' ? m.status : 'online'),
        metadata: (typeof m.metadata === 'object' && m.metadata !== null
            ? m.metadata
            : {}),
        channels: Array.isArray(m.channels)
            ? m.channels.filter((c) => typeof c === 'string')
            : [],
        nodeId: typeof m.nodeId === 'string' ? m.nodeId : '',
        timestamp: typeof m.timestamp === 'string' ? m.timestamp : new Date().toISOString(),
        lastSeen: typeof m.lastSeen === 'string' ? m.lastSeen : new Date().toISOString(),
        lastHeartbeat: typeof m.lastHeartbeat === 'number' ? m.lastHeartbeat : Date.now(),
    };
}
//# sourceMappingURL=usePresence.js.map