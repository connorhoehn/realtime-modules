"use strict";
// realtime-modules/src/client/useReactions.ts
//
// useReactions(channel, opts?) — React hook for gateway emoji reactions.
//
// Returns:
//   reactions      — last 50 Reaction[] for the channel (or filtered to
//                    opts.targetId when provided), oldest first
//   react          — send a reaction emoji to the channel
//   reactionsFor   — utility: filter the full reaction list by targetId
//                    without re-subscribing
//
// WIRE CONTRACT (gateway-real, verified against the gateway's installed
// ReactionService.handleAction — hub#1497): the reaction verbs are
// subscribe | unsubscribe | send | getAvailable. The previously sent
// 'react' was NEVER accepted ("Unknown reaction action: react"). Broadcasts
// are only delivered to clients that subscribed to the channel, so the hook
// subscribes on mount / channel change and unsubscribes on cleanup.
//
// Inbound frame shapes (gateway ReactionService send-backs):
//   { type: 'reaction', action: 'reaction_received', data: Reaction }
//   { type: 'reaction', action: 'reaction_subscribed'|'reaction_sent'|...,
//     success: true, data }                          // acks — ignored
// Legacy flat shapes ({ type: 'reaction:new' } / { type: 'reaction:history' })
// are still parsed as a fallback for non-gateway servers. The gateway sends
// no reaction-history frame (reactions are ephemeral).
//
// Outbound frames (canonical declaration: @connorhoehn/event-catalog
// client-frames v0.3.56 — client.reaction.send; subscribe/unsubscribe are
// the verified gateway verbs but have no EC declarations yet, so those
// send-sites carry no `satisfies` annotations):
//   { service: 'reaction', action: 'subscribe',   channel }
//   { service: 'reaction', action: 'unsubscribe', channel }
//   { service: 'reaction', action: 'send', channel, emoji, targetId?, metadata? }
//
// targetId support (v0.7.6):
//   - useReactions(channel, { targetId }) — reactions is pre-filtered to that entity
//   - react(emoji, { targetId }) — per-call override; falls back to hook-level targetId
//   - reactionsFor(targetId) — filter on demand from the full channel list
//
// NOTE: gateway-side ReactionService must forward the targetId field from inbound
// frames to all subscribers for round-trip to work. The field passes through
// opaquely in the current implementation.
Object.defineProperty(exports, "__esModule", { value: true });
exports.useReactions = useReactions;
const react_1 = require("react");
const GatewaySocketProvider_1 = require("./GatewaySocketProvider");
const MAX_REACTIONS = 50;
function useReactions(channel, opts) {
    const { send, onMessage } = (0, GatewaySocketProvider_1.useGateway)();
    // allReactions holds every reaction for the channel (unfiltered).
    const [allReactions, setAllReactions] = (0, react_1.useState)([]);
    const channelRef = (0, react_1.useRef)(channel);
    (0, react_1.useEffect)(() => {
        channelRef.current = channel;
    }, [channel]);
    // Track hook-level targetId via ref so callbacks see the latest value without
    // needing to re-register the message handler on every opts change.
    const targetIdRef = (0, react_1.useRef)(opts?.targetId);
    (0, react_1.useEffect)(() => {
        targetIdRef.current = opts?.targetId;
    }, [opts?.targetId]);
    // Register inbound handler once.
    (0, react_1.useEffect)(() => {
        const unsubscribe = onMessage((msg) => {
            // Gateway-real envelope: { type: 'reaction', action: 'reaction_received',
            // data: Reaction }. The frame carries no top-level channel — the
            // Reaction in `data` does, so channel-filter on that.
            if (msg.type === 'reaction') {
                if (msg.action === 'reaction_received') {
                    const raw = msg;
                    const entry = raw.data && typeof raw.data === 'object'
                        ? asReaction(raw.data)
                        : null;
                    if (entry && entry.channel === channelRef.current) {
                        setAllReactions((prev) => {
                            const next = [...prev, entry];
                            return next.length > MAX_REACTIONS ? next.slice(next.length - MAX_REACTIONS) : next;
                        });
                    }
                }
                // reaction_subscribed / reaction_sent / available_reactions acks —
                // no state change needed.
                return;
            }
            // Legacy flat shapes (non-gateway servers) — kept as a fallback.
            if (msg.channel !== channelRef.current)
                return;
            if (msg.type === 'reaction:new') {
                const entry = asReaction(msg);
                if (entry) {
                    // Keep bounded to MAX_REACTIONS — drop the oldest when over limit.
                    setAllReactions((prev) => {
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
                setAllReactions(parsed.slice(-MAX_REACTIONS));
            }
        });
        return unsubscribe;
    }, [onMessage]);
    // Subscribe / unsubscribe when channel changes — the gateway only
    // delivers reaction broadcasts to subscribed clients. The subscribe verb
    // is gateway-verified; no EC declaration yet (hub#1497).
    (0, react_1.useEffect)(() => {
        setAllReactions([]);
        send({
            service: 'reaction',
            action: 'subscribe',
            channel,
        });
        return () => {
            send({
                service: 'reaction',
                action: 'unsubscribe',
                channel,
            });
        };
    }, [channel, send]);
    const react = (0, react_1.useCallback)((emoji, reactOpts) => {
        const resolvedTargetId = reactOpts?.targetId ?? targetIdRef.current;
        const frame = {
            service: 'reaction',
            action: 'send',
            channel: channelRef.current,
            emoji,
        };
        if (resolvedTargetId !== undefined)
            frame.targetId = resolvedTargetId;
        if (reactOpts?.metadata !== undefined)
            frame.metadata = reactOpts.metadata;
        send(frame);
    }, [send]);
    const reactionsFor = (0, react_1.useCallback)((targetId) => allReactions.filter((r) => r.targetId === targetId), [allReactions]);
    // Apply hook-level targetId filter for the returned reactions list.
    const reactions = opts?.targetId !== undefined
        ? allReactions.filter((r) => r.targetId === opts.targetId)
        : allReactions;
    return { reactions, react, reactionsFor };
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
        targetId: typeof raw.targetId === 'string' ? raw.targetId : undefined,
    };
}
//# sourceMappingURL=useReactions.js.map