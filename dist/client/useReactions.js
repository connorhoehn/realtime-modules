"use strict";
// realtime-modules/src/client/useReactions.ts
//
// useReactions(channel) — React hook for gateway emoji reactions.
//
// Returns:
//   reactions — last 50 Reaction[] for the channel (oldest first)
//   react     — send a reaction emoji to the channel
//
// Inbound frame shapes (gateway reaction service):
//   { type: 'reaction:new',     channel, ...Reaction }
//   { type: 'reaction:history', channel, reactions: Reaction[] }
//
// Outbound frames:
//   { service: 'reaction', action: 'react',   channel, emoji }
//   { service: 'reaction', action: 'history', channel, limit: number }
Object.defineProperty(exports, "__esModule", { value: true });
exports.useReactions = useReactions;
const react_1 = require("react");
const GatewaySocketProvider_1 = require("./GatewaySocketProvider");
const MAX_REACTIONS = 50;
function useReactions(channel) {
    const { send, onMessage } = (0, GatewaySocketProvider_1.useGateway)();
    const [reactions, setReactions] = (0, react_1.useState)([]);
    const channelRef = (0, react_1.useRef)(channel);
    (0, react_1.useEffect)(() => {
        channelRef.current = channel;
    }, [channel]);
    // Register inbound handler once.
    (0, react_1.useEffect)(() => {
        const unsubscribe = onMessage((msg) => {
            if (msg.channel !== channelRef.current)
                return;
            if (msg.type === 'reaction:new') {
                const entry = asReaction(msg);
                if (entry) {
                    // Keep bounded to MAX_REACTIONS — drop the oldest when over limit.
                    setReactions((prev) => {
                        const next = [...prev, entry];
                        return next.length > MAX_REACTIONS ? next.slice(next.length - MAX_REACTIONS) : next;
                    });
                }
            }
            else if (msg.type === 'reaction:history') {
                const raw = msg;
                const list = Array.isArray(raw.reactions) ? raw.reactions : [];
                const parsed = list
                    .map((r) => asReaction(r))
                    .filter(Boolean);
                // Honour the bound even on history payloads.
                setReactions(parsed.slice(-MAX_REACTIONS));
            }
        });
        return unsubscribe;
    }, [onMessage]);
    // Reset reactions when channel changes.
    (0, react_1.useEffect)(() => {
        setReactions([]);
    }, [channel]);
    const react = (0, react_1.useCallback)((emoji) => {
        send({ service: 'reaction', action: 'react', channel: channelRef.current, emoji });
    }, [send]);
    return { reactions, react };
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function asReaction(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    if (typeof raw.id !== 'string' || typeof raw.clientId !== 'string')
        return null;
    if (typeof raw.channel !== 'string' || typeof raw.emoji !== 'string')
        return null;
    return {
        id: raw.id,
        clientId: raw.clientId,
        channel: raw.channel,
        emoji: raw.emoji,
        effect: typeof raw.effect === 'string' ? raw.effect : '',
        position: raw.position ?? null,
        metadata: (typeof raw.metadata === 'object' && raw.metadata !== null
            ? raw.metadata
            : {}),
        timestamp: typeof raw.timestamp === 'string' ? raw.timestamp : new Date().toISOString(),
    };
}
//# sourceMappingURL=useReactions.js.map