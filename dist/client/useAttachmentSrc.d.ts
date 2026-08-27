export interface UseAttachmentSrcOptions {
    /** Returns a fresh bearer token per fetch. */
    getToken?: () => string | null | undefined;
    /**
     * Maximum number of decoded attachments held at once. Older entries are
     * revoked when the cap is exceeded — a scrollback of hundreds of images
     * would otherwise pin every blob it ever rendered.
     */
    maxCached?: number;
}
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