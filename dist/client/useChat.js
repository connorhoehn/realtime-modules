"use strict";
// realtime-modules/src/client/useChat.ts
//
// useChat(channel) — React hook for gateway chat.
//
// Returns:
//   messages    — accumulated ChatMessage[] for the channel (newest last)
//   sendMessage — post a text message to the channel
//   loadHistory — fetch prior messages via the gateway HTTP history endpoint
//
// Inbound frame shapes (gateway chat service):
//   { type: 'chat:message',  channel, ...ChatMessage }
//   { type: 'chat:history',  channel, messages: ChatMessage[] }
//   { type: 'chat:joined',   channel }         // subscribe ack — ignored
//   { type: 'chat:error',    channel, error }  // ignored (surfaced at WS layer)
//
// Outbound frames (canonical declarations: @connorhoehn/event-catalog
// client-frames — client.chat.send / client.chat.history):
//   { service: 'chat', action: 'send',      channel, message: string }
//   { service: 'chat', action: 'history',   channel, limit: number }
Object.defineProperty(exports, "__esModule", { value: true });
exports.useChat = useChat;
const react_1 = require("react");
const GatewaySocketProvider_1 = require("./GatewaySocketProvider");
const DEFAULT_HISTORY_LIMIT = 50;
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
            if (msg.type === 'chat:message') {
                // Single new message broadcast — append to tail.
                const entry = asChatMessage(msg);
                if (entry) {
                    setMessages((prev) => [...prev, entry]);
                }
            }
            else if (msg.type === 'chat:history') {
                // History payload — replace current state with the ordered list.
                const raw = msg;
                const list = Array.isArray(raw.messages) ? raw.messages : [];
                const parsed = list.map(asChatMessageRaw).filter(Boolean);
                setMessages(parsed);
            }
        });
        return unsubscribe;
    }, [onMessage]);
    // Reset messages when channel changes.
    (0, react_1.useEffect)(() => {
        setMessages([]);
    }, [channel]);
    const sendMessage = (0, react_1.useCallback)((text) => {
        send({
            service: 'chat',
            action: 'send',
            channel: channelRef.current,
            message: text,
        });
    }, [send]);
    const loadHistory = (0, react_1.useCallback)((limit = DEFAULT_HISTORY_LIMIT) => {
        send({
            service: 'chat',
            action: 'history',
            channel: channelRef.current,
            limit,
        });
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
        channel: m.channel,
        message: m.message,
        metadata: typeof m.metadata === 'object' && m.metadata !== null
            ? m.metadata
            : undefined,
        timestamp: m.timestamp,
    };
}
//# sourceMappingURL=useChat.js.map