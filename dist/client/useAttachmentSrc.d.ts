export interface UseAttachmentSrcOptions {
    /** Returns a fresh bearer token per fetch. */
    getToken?: () => string | null | undefined;
    /**
     * Maximum number of decoded attachments held at once. Older entries are
     * revoked when the cap is exceeded — a scrollback of hundreds of images
     * would otherwise pin every blob it ever rendered.
     */
    maxCached?: number;
    /**
     * Origins besides the page's own that may receive the bearer token, for a
     * gateway whose HTTP origin differs from the app's (`FILEUPLOAD_PUBLIC_BASE`).
     * Exact origins (`https://gateway.example.com`). Even on these the token is
     * sent only to a path ending in `/api/uploads/<id>`.
     */
    trustedOrigins?: readonly string[];
}
/**
 * Whether `url` is the gateway's download route on an origin allowed to see
 * the viewer's token: a bare `/api/uploads/<id>` path, or the same path on the
 * page's origin or one of `trustedOrigins`. Protocol-relative (`//host/…`)
 * and every other form are not.
 */
export declare function mayCarryAttachmentToken(url: string, trustedOrigins?: readonly string[]): boolean;
export interface UseAttachmentSrcResult {
    /**
     * Renderable src for an attachment, or undefined while it is still being
     * fetched (callers fall back to the inline preview so the reader sees the
     * blurred placeholder rather than an empty box).
     */
    srcFor: (attachment: {
        id: string;
        url: string;
        contentType?: string;
    }) => string | undefined;
}
export declare function useAttachmentSrc(options?: UseAttachmentSrcOptions): UseAttachmentSrcResult;
//# sourceMappingURL=useAttachmentSrc.d.ts.map