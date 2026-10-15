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
    id?: unknown;
    timestamp?: unknown;
    userId?: unknown;
    message?: unknown;
    metadata?: {
        userId?: unknown;
        displayName?: unknown;
    } & Record<string, unknown>;
}
/**
 * Reads a chat `message` frame from a plugin hook. Returns null unless the
 * frame is a chat message AND its server-stamped sender (`message.userId`,
 * else `metadata.userId`) equals the authenticated publisher. A frame with no
 * stamp passes; a missing publisher (server-originated publish) fails, since
 * there is no one to attribute the message to.
 */
export declare function parseChatPluginMessage(input: ChatPluginInput, opts?: {
    resolveUserId?: (clientId: string) => string | undefined;
}): ParsedChatPluginMessage | null;
//# sourceMappingURL=pluginMessage.d.ts.map