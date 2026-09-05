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
//   { service: 'reaction', action: 'remove', channel, emoji, targetId }
//
// Durable message reactions (rm >= 0.33): when the server wires a
// ReactionStore, a reaction carrying a targetId is state rather than an event.
// Two extra inbound frames carry that:
//   { type:'reaction', action:'reaction_history', success:true,
//     data:{ channel, reactions: Reaction[] } }   // replay on subscribe
//   { type:'reaction', action:'reaction_removed',
//     data:{ channel, targetId, emoji, userId, timestamp } }
// Servers without a store never send either, and `unreact` gets an error
// frame back — the ephemeral call-reaction behaviour is unchanged.
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
                // Durable replay on subscribe: the server's stored reactions for the
                // channel, already in Reaction shape. REPLACES the list rather than
                // appending — it is the state, not more events.
                if (msg.action === 'reaction_history') {
                    const data = msg.data;
                    if (data && data.channel === channelRef.current && Array.isArray(data.reactions)) {
                        const parsed = data.reactions
                            .map((r) => asReaction(r))
                            .filter(Boolean);
                        setAllReactions(parsed.slice(-MAX_REACTIONS));
                    }
                    return;
                }
                // Somebody took their reaction back. Matched on the durable key
                // (target, emoji, owner) — NOT on the reaction id, which differs
                // between the live broadcast and the replayed row for the same fact.
                if (msg.action === 'reaction_removed') {
                    const data = msg.data;
                    if (data && data.channel === channelRef.current) {
                        setAllReactions((prev) => prev.filter((r) => !(r.targetId === data.targetId && r.emoji === data.emoji && r.userId === data.userId)));
                    }
                    return;
                }
                // reaction_subscribed / reaction_sent / reaction_unsent /
                // available_reactions acks — no state change needed.
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
    // delivers reaction broadcasts to subscribed clients.
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
    const unreact = (0, react_1.useCallback)((emoji, unreactOpts) => {
        const resolvedTargetId = unreactOpts?.targetId ?? targetIdRef.current;
        send({
            service: 'reaction',
            action: 'remove',
            channel: channelRef.current,
            emoji,
            targetId: resolvedTargetId,
        });
    }, [send]);
    // Reads the CURRENT list through a ref so the callback identity stays
    // stable — a toggle that changes on every reaction would re-render every
    // chip in the channel each time anyone reacted.
    const allRef = (0, react_1.useRef)(allReactions);
    (0, react_1.useEffect)(() => {
        allRef.current = allReactions;
    }, [allReactions]);
    const toggle = (0, react_1.useCallback)((emoji, toggleOpts) => {
        const resolvedTargetId = toggleOpts?.targetId ?? targetIdRef.current;
        const mine = allRef.current.some((r) => r.emoji === emoji &&
            r.targetId === resolvedTargetId &&
            r.userId === toggleOpts?.userId);
        if (mine)
            unreact(emoji, { targetId: resolvedTargetId });
        else
            react(emoji, { targetId: resolvedTargetId });
    }, [react, unreact]);
    const reactionsFor = (0, react_1.useCallback)((targetId) => allReactions.filter((r) => r.targetId === targetId), [allReactions]);
    // Apply hook-level targetId filter for the returned reactions list.
    const reactions = opts?.targetId !== undefined
        ? allReactions.filter((r) => r.targetId === opts.targetId)
        : allReactions;
    return { reactions, react, reactionsFor, unreact, toggle };
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
        userId: typeof raw.userId === 'string' ? raw.userId : undefined,
        displayName: typeof raw.displayName === 'string' ? raw.displayName : undefined,
    };
}
//# sourceMappingURL=useReactions.js.map