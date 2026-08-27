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
}
export declare function useChat(channel: string): UseChatReturn;
//# sourceMappingURL=useChat.d.ts.map