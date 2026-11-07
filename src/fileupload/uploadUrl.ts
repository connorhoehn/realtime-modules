// realtime-modules/src/fileupload/uploadUrl.ts
//
// The one place the gateway's upload/download URL is built from a storage id.
// FileUploadService issues it on `fileupload:url` / `fileupload:complete`, and
// ChatService (0.146.0) writes it onto every `metadata.attachments[]` entry
// from the attachment id, so a URL a client sends is never what the viewers
// fetch.

/** Normalise a public base URL: no trailing slash; '' means root-relative. */
export function normalizeUploadBase(base: string | null | undefined): string {
    return (base ?? '').replace(/\/+$/, '');
}

/** The base FileUploadService uses when no `publicBaseUrl` is passed. */
export function defaultUploadBase(): string {
    return normalizeUploadBase(typeof process !== 'undefined' ? process.env?.FILEUPLOAD_PUBLIC_BASE : '');
}

/** `${base}/api/uploads/${encodeURIComponent(id)}` — PUT target and GET download alike. */
export function uploadUrlFor(base: string, uploadId: string): string {
    return `${normalizeUploadBase(base)}/api/uploads/${encodeURIComponent(uploadId)}`;
}
