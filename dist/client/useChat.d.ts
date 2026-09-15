import type { ChatMessage } from './types';
export interface UseChatReturn {
    messages: ChatMessage[];
    /**
     * Post to the channel. `metadata` rides the message verbatim, which is how
     * an attachment stays ORDERED with the text around it — the alternative, a
     * separate file-event stream, has to be merged back against the message
     * stream at render time and gets it wrong at exactly the moment it matters
     * (someone typing while a file uploads).
     */
    sendMessage: (text: string, metadata?: Record<string, unknown>) => void;
    loadHistory: (limit?: number) => void;
    /**
     * Who else is composing in this channel right now, by display name (or
     * user id when the server gave none). Never includes this connection.
     * An entry lapses on its own a few seconds after the last signal, so a
     * closed tab does not leave "Carol is typing…" on screen forever.
     */
    typingUsers: string[];
    /**
     * Say that this person is (or is no longer) composing. Throttled: while
     * typing, at most one frame every few seconds; a `false` goes out at once
     * and only if the channel was told `true`. Call it from the composer's
     * key handler and after every send.
     */
    setTyping: (typing: boolean) => void;
}
export declare function useChat(channel: string): UseChatReturn;
//# sourceMappingURL=useChat.d.ts.map