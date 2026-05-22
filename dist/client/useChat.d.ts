import type { ChatMessage } from './types';
export interface UseChatReturn {
    messages: ChatMessage[];
    sendMessage: (text: string) => void;
    loadHistory: (limit?: number) => void;
}
export declare function useChat(channel: string): UseChatReturn;
//# sourceMappingURL=useChat.d.ts.map