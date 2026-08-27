export interface FileUploadState {
    id: string;
    filename: string;
    size: number;
    status: 'pending' | 'uploading' | 'completed' | 'failed' | 'scanning' | 'clean' | 'infected';
    progress?: number;
    uploadUrl?: string;
    downloadUrl?: string;
    error?: string;
}
/**
 * A transfer happening in this channel — possibly somebody else's.
 *
 * This is the type that makes the feature feel live. `uploads` below is the
 * viewer's own outbox and always was; `transfers` is the shared truth about
 * what is moving through the channel right now, assembled from the server's
 * `fileupload:started` / `:progress` / terminal broadcasts. Without it a
 * recipient's UI has nothing to render until a completed file drops in fully
 * formed.
 */
export interface ChannelTransfer {
    /** Server-minted id. Stable across every participant, unlike the
     *  per-client correlation id, so everyone keys the same transfer alike. */
    transferId: string;
    /** Human-facing attribution, so a recipient reads "Ada is sending…". */
    actor: string;
    /** Authed user id of the sender — the reliable identity for "is this mine". */
    uploader: string;
    name: string;
    size: number;
    /** Bytes the SERVER has counted. Never a client's self-report. */
    transferred: number;
    phase: 'started' | 'transferring' | 'verifying' | 'complete' | 'failed' | 'cancelled';
    contentType?: string;
    /** Sender's inline data-URI placeholder, shown while bytes are in flight. */
    preview?: string;
    width?: number;
    height?: number;
    error?: string;
    /** Present once the transfer completes. */
    downloadUrl?: string;
}
export interface UseFileUploadResult {
    /** The viewer's own uploads, keyed by their local correlation id. */
    uploads: FileUploadState[];
    /**
     * Every transfer in flight in this channel, the viewer's own included,
     * keyed by the server-minted transfer id. Settled transfers are dropped as
     * soon as they settle — a completed one becomes a message attachment, and a
     * failed one has already been reported.
     */
    transfers: ChannelTransfer[];
    upload(file: File, opts?: {
        metadata?: Record<string, unknown>;
    }): Promise<FileUploadState>;
    cancel(id: string): void;
    /** Cancel by the server-minted transfer id (what the UI renders). */
    cancelTransfer(transferId: string): void;
    removeCompleted(): void;
}
export interface UseFileUploadOptions {
    /**
     * Fires once for every transfer that lands in this channel — the viewer's
     * own and everybody else's.
     *
     * The hook deliberately does not decide what a completed upload MEANS. In a
     * chat it becomes a message attachment; in a document it becomes an
     * embedded figure. The consumer owns that, and receiving the same event on
     * every client is what lets each of them render the result at the same
     * moment without a refetch.
     */
    onComplete?: (transfer: CompletedTransfer) => void;
    /** Attribution shown to other participants ("Ada is sending…"). */
    displayName?: string;
    /**
     * Longest edge, in pixels, of the inline placeholder generated for image
     * uploads. Small on purpose: it is broadcast to every subscriber before the
     * real bytes move. 0 disables placeholder generation.
     */
    previewMaxEdge?: number;
}
export interface CompletedTransfer {
    transferId: string;
    /**
     * True on the sender's client only.
     *
     * `onComplete` fires on EVERY participant — that is what lets each of them
     * react at the same instant without a refetch. But exactly one of them may
     * write the resulting durable record (a chat message, a document embed) or
     * the channel gets one copy per viewer. This flag is how a consumer knows
     * which one it is, and the hook is the only layer that can answer it: it
     * holds the correlation-id map that ties this transfer to an upload() call
     * made here.
     */
    mine: boolean;
    actor: string;
    uploader: string;
    filename: string;
    size: number;
    contentType: string;
    downloadUrl: string;
    width?: number;
    height?: number;
    preview?: string;
}
export declare function useFileUpload(channel: string, options?: UseFileUploadOptions): UseFileUploadResult;
//# sourceMappingURL=useFileUpload.d.ts.map