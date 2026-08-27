"use strict";
// realtime-modules/src/client/useChat.ts
//
// useChat(channel) — React hook for gateway chat.
//
// Returns:
//   messages    — accumulated ChatMessage[] for the channel (newest last)
//   sendMessage — post a text message to the channel
//   loadHistory — explicitly re-request message history over the WS
//
// WIRE CONTRACT (gateway-real, verified against the gateway's installed
// ChatService.handleAction — hub#1497): the chat verbs are
// join | leave | send | history. The previously sent 'subscribe' was NEVER
// accepted ("Unknown chat action: subscribe"), and `send` requires a prior
// `join` on the channel ("You must join the channel before sending
// messages"). The hook therefore joins its channel on mount / channel
// change and leaves on cleanup. `join` auto-pushes recent channel history
// (chat/history frame) when any exists, so no explicit history request is
// sent on join — loadHistory remains for explicit re-fetch.
//
// Inbound frame shapes (gateway ChatService send-backs):
//   { type: 'chat', action: 'message', channel, message: ChatMessage }
//   { type: 'chat', action: 'history', channel, messages: ChatMessage[] }
//   { type: 'chat', action: 'joined'|'left'|'sent', channel }  // acks — ignored
// Legacy flat shapes ({ type: 'chat:message' } / { type: 'chat:history' })
// are still parsed as a fallback for non-gateway servers.
//
// Outbound frames (canonical declarations: @connorhoehn/event-catalog
// client-frames v0.3.56 — client.chat.join / client.chat.send /
// client.chat.history; `leave` is the verified gateway verb but has no EC
// declaration yet, so its send-site carries no `satisfies` annotation):
//   { service: 'chat', action: 'join',    channel }
//   { service: 'chat', action: 'leave',   channel }
//   { service: 'chat', action: 'send',    channel, message: string }
//   { service: 'chat', action: 'history', channel, limit?: number }
//     (limit omitted → gateway falls back to its configured default)
Object.defineProperty(exports, "__esModule", { value: true });
exports.useChat = useChat;
const react_1 = require("react");
const GatewaySocketProvider_1 = require("./GatewaySocketProvider");
function useChat(channel) {
    const { send, onMessage } = (0, GatewaySocketProvider_1.useGateway)();
    const [messages, setMessages] = (0, react_1.useState)([]);
    // Keep channel in a ref so the message handler always sees the latest value
    // without needing to be re-registered on every channel change.
    const channelRef = (0, react_1.useRef)(channel);
    (0, react_1.useEffect)(() => {
        channelRef.current = channel;
    }, [channel]);
    // Register inbound handler once; channel filtering uses channelRef.
    (0, react_1.useEffect)(() => {
        const unsubscribe = onMessage((msg) => {
            if (msg.channel !== channelRef.current)
                return;
            const raw = msg;
            // Gateway-real envelopes: { type: 'chat', action: 'message'|'history' }.
            if (msg.type === 'chat') {
                if (msg.action === 'message') {
                    // Broadcast — the ChatMessage is nested under `message`.
                    const entry = asChatMessageRaw(raw.message);
                    if (entry) {
                        setMessages((prev) => [...prev, entry]);
                    }
                }
                else if (msg.action === 'history') {
                    // History payload (explicit request OR auto-push on join) —
                    // replace current state with the ordered list.
                    const list = Array.isArray(raw.messages) ? raw.messages : [];
                    const parsed = list.map(asChatMessageRaw).filter(Boolean);
                    setMessages(parsed);
                }
                // 'joined' / 'left' / 'sent' acks need no state change.
                return;
            }
            // Legacy flat shapes (non-gateway servers) — kept as a fallback.
            if (msg.type === 'chat:message') {
                const entry = asChatMessage(msg);
                if (entry) {
                    setMessages((prev) => [...prev, entry]);
                }
            }
            else if (msg.type === 'chat:history') {
                const list = Array.isArray(raw.messages) ? raw.messages : [];
                const parsed = list.map(asChatMessageRaw).filter(Boolean);
                setMessages(parsed);
            }
        });
        return unsubscribe;
    }, [onMessage]);
    // Join / leave the chat channel when it changes. The gateway requires a
    // join before send, and the join auto-pushes recent history (arriving as
    // a chat/history frame), so no explicit history request is needed here.
    (0, react_1.useEffect)(() => {
        setMessages([]);
        send({
            service: 'chat',
            action: 'join',
            channel,
        });
        return () => {
            send({
                service: 'chat',
                action: 'leave',
                channel,
            });
        };
    }, [channel, send]);
    const sendMessage = (0, react_1.useCallback)((text, metadata) => {
        send({
            service: 'chat',
            action: 'send',
            channel: channelRef.current,
            message: text,
            ...(metadata ? { metadata } : {}),
        });
    }, [send]);
    const loadHistory = (0, react_1.useCallback)((limit) => {
        // limit is optional pass-through — when omitted the gateway falls
        // back to its configured default history limit.
        const frame = {
            service: 'chat',
            action: 'history',
            channel: channelRef.current,
        };
        if (limit !== undefined)
            frame.limit = limit;
        send(frame);
    }, [send]);
    return { messages, sendMessage, loadHistory };
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/** Cast a GatewayMessage (typed as index type) to a ChatMessage, or null. */
function asChatMessage(msg) {
    return asChatMessageRaw(msg);
}
function asChatMessageRaw(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const m = raw;
    if (typeof m.id !== 'string' || typeof m.clientId !== 'string')
        return null;
    if (typeof m.channel !== 'string' || typeof m.message !== 'string')
        return null;
    if (typeof m.timestamp !== 'string')
        return null;
    return {
        id: m.id,
        clientId: m.clientId,
        userId: typeof m.userId === 'string' ? m.userId : undefined,
        channel: m.channel,
        message: m.message,
        metadata: typeof m.metadata === 'object' && m.metadata !== null
            ? m.metadata
            : undefined,
        timestamp: m.timestamp,
    };
}
//# sourceMappingURL=useChat.js.map