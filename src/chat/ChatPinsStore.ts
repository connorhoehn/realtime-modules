/** A channel-scoped pin, independent of the sender's message metadata. */
export interface PinnedMessage {
    channelId: string;
    messageId: string;
    pinnedBy: string;
    pinnedAt: string;
    preview: string;
    author: string;
    /** The message's own send time. Never inferred from the pin time. */
    sentAt?: string;
}

export interface ChatPinInput {
    channelId: string;
    messageId: string;
    /** The authenticated subject, supplied by the host. */
    pinnedBy: string;
    text: string;
    author: string;
    sentAt?: string;
}

export interface ChatPinsStore {
    pin(input: ChatPinInput): Promise<PinnedMessage>;
    unpin(channelId: string, messageId: string): Promise<void>;
    /** Newest pin first, with message id as a deterministic tie breaker. */
    list(channelId: string): Promise<PinnedMessage[]>;
}

export const PIN_PREVIEW_MAX = 140;

export function pinRecord(input: ChatPinInput, now: number): PinnedMessage {
    const flat = input.text.replace(/\s+/g, ' ').trim();
    return {
        channelId: input.channelId, messageId: input.messageId,
        pinnedBy: input.pinnedBy, pinnedAt: new Date(now).toISOString(),
        preview: flat.length > PIN_PREVIEW_MAX ? flat.slice(0, PIN_PREVIEW_MAX - 1) + '…' : flat,
        author: input.author,
        ...(input.sentAt?.trim() ? { sentAt: input.sentAt } : {}),
    };
}

export function comparePins(a: PinnedMessage, b: PinnedMessage): number {
    return b.pinnedAt.localeCompare(a.pinnedAt) || a.messageId.localeCompare(b.messageId);
}

/** Memory storage; an optional row getter supports resettable host fixtures. */
export class MemoryChatPinsStore implements ChatPinsStore {
    private readonly rows: () => PinnedMessage[];
    private readonly now: () => number;

    constructor(opts: { rows?: () => PinnedMessage[]; now?: () => number } = {}) {
        const rows: PinnedMessage[] = [];
        this.rows = opts.rows ?? (() => rows);
        this.now = opts.now ?? Date.now;
    }

    async pin(input: ChatPinInput): Promise<PinnedMessage> {
        const record = pinRecord(input, this.now());
        const rows = this.rows();
        const index = rows.findIndex((p) => p.channelId === input.channelId && p.messageId === input.messageId);
        if (index < 0) rows.push(record); else rows[index] = record;
        return { ...record };
    }

    async unpin(channelId: string, messageId: string): Promise<void> {
        const rows = this.rows();
        const index = rows.findIndex((p) => p.channelId === channelId && p.messageId === messageId);
        if (index >= 0) rows.splice(index, 1);
    }

    async list(channelId: string): Promise<PinnedMessage[]> {
        return this.rows().filter((p) => p.channelId === channelId).map((p) => ({ ...p })).sort(comparePins);
    }
}
