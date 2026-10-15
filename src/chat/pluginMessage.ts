// 0.119 (lane R4): the one reading of a router plugin's chat input.
import { baseChannel } from '../server-ws/channelAccess';

/** What a `FeaturePlugin.onMessage` hook receives. */
export interface ChatPluginInput {
    clientId: string;
    channelId: string;
    message: unknown;
    userId?: string;
}

export interface ParsedChatPluginMessage<M = ChatPluginFrameMessage> {
    /** The channel with its service prefix stripped (`chat:x` -> `x`). */
    channel: string;
    /** The authenticated publisher (the hook's `userId`, else `resolveUserId(clientId)`). */
    sender: string;
    message: M;
    text: string;
    displayName: string | undefined;
}

export interface ChatPluginFrameMessage {
    id?: unknown; timestamp?: unknown; userId?: unknown; message?: unknown;
    metadata?: { userId?: unknown; displayName?: unknown } & Record<string, unknown>;
}

/**
 * Reads a chat `message` frame from a plugin hook. Returns null unless the
 * frame is a chat message AND its server-stamped sender (`message.userId`,
 * else `metadata.userId`) equals the authenticated publisher. A frame with no
 * stamp passes; a missing publisher (server-originated publish) fails, since
 * there is no one to attribute the message to.
 */
export function parseChatPluginMessage(
    input: ChatPluginInput,
    opts: { resolveUserId?: (clientId: string) => string | undefined } = {},
): ParsedChatPluginMessage | null {
    const frame = input.message as { type?: unknown; action?: unknown; message?: ChatPluginFrameMessage } | null;
    if (!frame || frame.type !== 'chat' || frame.action !== 'message' || !frame.message) return null;
    const sender = input.userId ?? opts.resolveUserId?.(input.clientId);
    const stamped = frame.message.userId ?? frame.message.metadata?.userId;
    if (!sender || (typeof stamped === 'string' && stamped !== sender)) return null;
    const name = frame.message.metadata?.displayName;
    return {
        channel: baseChannel(input.channelId),
        sender,
        message: frame.message,
        text: typeof frame.message.message === 'string' ? frame.message.message : '',
        displayName: typeof name === 'string' && name ? name : undefined,
    };
}
