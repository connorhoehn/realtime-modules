/** Most attachments one message may carry. */
export declare const MAX_CHAT_ATTACHMENTS = 20;
/** Longest attachment id accepted (a tenant-scoped `<tenant>|<uuid>` fits easily). */
export declare const MAX_ATTACHMENT_ID_LENGTH = 256;
/** Same cap FileUploadService puts on a transfer's inline placeholder. */
export declare const MAX_ATTACHMENT_PREVIEW_CHARS: number;
export interface ChatAttachmentRecord {
    id: string;
    url: string;
    name?: string;
    size?: number;
    contentType?: string;
    width?: number;
    height?: number;
    preview?: string;
}
export type AttachmentCheck = {
    ok: true;
    attachments: ChatAttachmentRecord[];
} | {
    ok: false;
    reason: string;
};
/** The default `attachmentUrlFor`: FileUploadService's URL with `FILEUPLOAD_PUBLIC_BASE`. */
export declare function defaultAttachmentUrlFor(id: string): string;
/**
 * Check and rewrite `metadata.attachments`. `undefined` (no attachments) is
 * fine; anything present must be an array of `{ id, … }` whose optional `url`
 * is the server-issued one for that id.
 */
export declare function normalizeChatAttachments(raw: unknown, urlFor?: (id: string) => string): AttachmentCheck;
//# sourceMappingURL=attachments.d.ts.map