// realtime-modules/src/chat/attachments.ts
//
// `metadata.attachments` on a chat send or edit (0.146.0).
//
// An attachment is an id the gateway issued for an upload. The client used to
// write the download URL too, and the server stored and fanned it out as
// written; `useAttachmentSrc` then fetched that URL with the viewer's bearer
// token. So any participant could aim every viewer's token at their own host.
//
// Now the server writes the URL from the id (`attachmentUrlFor`, by default
// FileUploadService's `/api/uploads/<id>`). A frame may still carry a URL —
// older clients copy the `downloadUrl` the server issued — but only that
// exact server-issued URL for that id, or the bare `/api/uploads/<id>` path.
// Anything else refuses the whole send. Unknown keys are dropped, display
// fields are clipped, and a preview must be an inline `data:image/` URI.

import { defaultUploadBase, uploadUrlFor } from '../fileupload/uploadUrl';

/** Most attachments one message may carry. */
export const MAX_CHAT_ATTACHMENTS = 20;
/** Longest attachment id accepted (a tenant-scoped `<tenant>|<uuid>` fits easily). */
export const MAX_ATTACHMENT_ID_LENGTH = 256;
/** Same cap FileUploadService puts on a transfer's inline placeholder. */
export const MAX_ATTACHMENT_PREVIEW_CHARS = 16 * 1024;

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

export type AttachmentCheck =
    | { ok: true; attachments: ChatAttachmentRecord[] }
    | { ok: false; reason: string };

/** The default `attachmentUrlFor`: FileUploadService's URL with `FILEUPLOAD_PUBLIC_BASE`. */
export function defaultAttachmentUrlFor(id: string): string {
    return uploadUrlFor(defaultUploadBase(), id);
}

function isIssuedUrl(url: string, id: string, urlFor: (id: string) => string): boolean {
    if (url === urlFor(id)) return true;
    // The bare path the default (root-relative) configuration issues, which a
    // host that later set a public base will still find in older frames.
    return url === `/api/uploads/${encodeURIComponent(id)}`;
}

const posInt = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;

/**
 * Check and rewrite `metadata.attachments`. `undefined` (no attachments) is
 * fine; anything present must be an array of `{ id, … }` whose optional `url`
 * is the server-issued one for that id.
 */
export function normalizeChatAttachments(raw: unknown, urlFor: (id: string) => string = defaultAttachmentUrlFor): AttachmentCheck {
    if (raw === undefined) return { ok: true, attachments: [] };
    if (!Array.isArray(raw)) return { ok: false, reason: 'attachments must be an array' };
    if (raw.length > MAX_CHAT_ATTACHMENTS) return { ok: false, reason: `at most ${MAX_CHAT_ATTACHMENTS} attachments per message` };
    const out: ChatAttachmentRecord[] = [];
    for (const entry of raw) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { ok: false, reason: 'an attachment must be an object' };
        const a = entry as Record<string, unknown>;
        const id = a.id;
        if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ATTACHMENT_ID_LENGTH || /[\u0000-\u001f\u007f]/.test(id)) {
            return { ok: false, reason: 'an attachment needs the id the upload was issued' };
        }
        if (a.url !== undefined && a.url !== null && (typeof a.url !== 'string' || !isIssuedUrl(a.url, id, urlFor))) {
            return { ok: false, reason: 'attachment URLs are issued by the server; send the attachment id only' };
        }
        const record: ChatAttachmentRecord = { id, url: urlFor(id) };
        if (typeof a.name === 'string') record.name = a.name.slice(0, 255);
        if (typeof a.size === 'number' && Number.isFinite(a.size) && a.size >= 0) record.size = Math.floor(a.size);
        if (typeof a.contentType === 'string') record.contentType = a.contentType.slice(0, 120);
        const width = posInt(a.width);
        const height = posInt(a.height);
        if (width) record.width = width;
        if (height) record.height = height;
        if (typeof a.preview === 'string' && a.preview.startsWith('data:image/') && a.preview.length <= MAX_ATTACHMENT_PREVIEW_CHARS) {
            record.preview = a.preview;
        }
        out.push(record);
    }
    return { ok: true, attachments: out };
}
