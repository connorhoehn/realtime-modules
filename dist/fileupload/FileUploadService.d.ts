import { FileBlobStore } from './FileBlobStore';
/**
 * Metadata persistence contract (v0.18.0 extraction seam). The gateway's
 * DynamoDB FileUploadMetadataRepository satisfies this structurally; the
 * in-memory implementation below is the zero-config default for
 * kick-starter deployments and tests.
 */
export interface FileUploadMetadataStore {
    create(row: Omit<FileUploadRow, 'createdAt'> & {
        createdAt?: string;
    }): Promise<void>;
    get(uploadId: string): Promise<FileUploadRow | null>;
    updateStatus(uploadId: string, status: FileUploadStatus, patch?: {
        size?: number;
        contentType?: string;
    }): Promise<void>;
}
/** Upload lifecycle states — mirrors the gateway's DynamoDB repository. */
export type FileUploadStatus = 'pending' | 'uploaded' | 'completed' | 'failed' | 'cancelled';
/** Row shape shared with persistence implementations (copied verbatim from
 *  the gateway's FileUploadMetadataRepository — the DDB repo satisfies
 *  FileUploadMetadataStore structurally, so the shapes must stay in sync). */
export interface FileUploadRow {
    uploadId: string;
    /**
     * Client-supplied correlation id from the request-upload frame. The
     * useFileUpload hook keys its in-flight upload state by THIS id, so
     * every push frame back to the hook must echo it as `id`. Decoupled
     * from `uploadId` (the storage key) by the server-mint fix.
     */
    correlationId?: string;
    channel: string;
    uploader: string;
    filename: string;
    size: number;
    status: FileUploadStatus;
    contentType?: string;
    createdAt: string;
    updatedAt?: string;
    metadata?: Record<string, unknown>;
}
/** Zero-config in-memory metadata store (single-process; kick-starters/tests). */
export declare class InMemoryFileUploadMetadataStore implements FileUploadMetadataStore {
    private rows;
    create(row: Omit<FileUploadRow, 'createdAt'> & {
        createdAt?: string;
    }): Promise<void>;
    get(uploadId: string): Promise<FileUploadRow | null>;
    updateStatus(uploadId: string, status: FileUploadStatus, patch?: {
        size?: number;
        contentType?: string;
    }): Promise<void>;
}
interface RouterLike {
    sendToClient(clientId: string, message: unknown): Promise<unknown> | unknown;
    sendToChannel(channel: string, message: unknown, excludeClientId?: string | null, opts?: {
        skipCoalesce?: boolean;
        publisherClientId?: string | null;
    }): Promise<unknown> | unknown;
    getUserIdForClient?(clientId: string): string | null;
    /**
     * Resolve the client's user context — required by
     * `enforceChannelPermission` (it reads `clientData.userContext`). Optional
     * in the type so test doubles can omit it (the interceptor treats a
     * missing context as "deny").
     */
    getClientData?(clientId: string): unknown;
}
interface LoggerLike {
    debug?: (...args: unknown[]) => void;
    info?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
}
export interface FileUploadServiceOptions {
    messageRouter: RouterLike;
    logger: LoggerLike;
    metricsCollector?: {
        recordMetric?: (name: string, value: number) => void;
    };
    blobStore?: FileBlobStore;
    metadataRepo?: FileUploadMetadataStore;
    /**
     * Channel authz hook (v0.18.0 extraction seam). The gateway wires its
     * enforceChannelPermission interceptor (reads clientData.userContext,
     * emits AUTHZ_CHANNEL_DENIED on failure). Default allows everything —
     * fine for single-tenant kick-starters; a multi-tenant deployment that
     * skips this has a cross-tenant isolation hole, per the gateway's own
     * interceptor doc.
     */
    authz?: (service: FileUploadService, clientId: string, channel: string) => boolean;
    /**
     * Public base URL the browser uses to reach this gateway's HTTP surface.
     * Defaults to '' so the issued uploadUrl/downloadUrl are root-relative
     * (`/api/uploads/<id>`) — the browser resolves them against the gateway
     * origin it already holds the WS connection to. Override with
     * FILEUPLOAD_PUBLIC_BASE when the HTTP origin differs from the WS origin.
     */
    publicBaseUrl?: string;
    maxBytes?: number;
}
export declare class FileUploadService {
    messageRouter: RouterLike;
    logger: LoggerLike;
    metricsCollector?: {
        recordMetric?: (name: string, value: number) => void;
    };
    readonly blobStore: FileBlobStore;
    readonly metadataRepo: FileUploadMetadataStore;
    private readonly authz;
    private publicBaseUrl;
    readonly maxBytes: number;
    /**
     * Correlation index: maps a client's request-upload `id` (the hook's
     * in-flight key) to the SERVER-minted storage uploadId. The hook sends the
     * SAME correlation `id` on `complete`/`cancel`; we resolve it here to the
     * minted id that actually keys the row + blob. Keyed by
     * `${clientId}::${channel}::${correlationId}` so two clients (or two
     * channels) can't collide on the same correlation string. Entries are
     * dropped on terminal transitions + onClientDisconnect; the persisted
     * row.correlationId is the durable fallback (cross-node / post-restart).
     */
    private correlationToUploadId;
    constructor(opts: FileUploadServiceOptions);
    /** Build the HTTP url (PUT for upload, GET for download — same path). */
    uploadUrlFor(uploadId: string): string;
    private uploaderFor;
    private correlationKey;
    /**
     * Resolve a client's request-upload correlation id to the server-minted
     * storage uploadId + its persisted row. Fast path: the in-memory
     * correlation map. Fallback: scan-free direct read is impossible (the row
     * is keyed by minted id, not correlation), so when the map misses (cross-
     * node / post-restart) the caller treats it as unknown — the hook will
     * surface a failure and the row self-expires via TTL. Returns null when
     * unresolvable.
     */
    private resolveByCorrelation;
    private emitFailed;
    /**
     * Authz-denial error envelope. Signature matches what
     * `enforceChannelPermission` expects (`sendError(clientId, message,
     * code?)`). On denial the interceptor calls this with the AuthzError's
     * code/message. We surface it to the hook as a `fileupload:failed` frame
     * (the hook has no generic `error` handler for fileupload ids) so the
     * pending upload resolves to a failed state rather than hanging.
     *
     * NOTE: the interceptor calls this WITHOUT a channel/id (it only knows
     * clientId + message + code). The hook keys failures by `id`, so an authz
     * denial reported via this path lacks an id and won't patch a specific
     * upload row — that's acceptable for the denial case (the upload() promise
     * is rejected by the per-verb early-return path below, which emits a
     * properly-keyed `fileupload:failed` for request-upload). This method
     * exists so the interceptor contract is satisfied and any denial is at
     * least logged + surfaced.
     */
    sendError(clientId: string, message: string, code?: string): void;
    /**
     * Dispatch entrypoint — same `handleAction(clientId, action, data)`
     * contract every gateway WS service implements. `data` is the inbound
     * frame minus `service`/`action` (channel, id, filename, size, metadata).
     */
    handleAction(clientId: string, action: string, data: Record<string, unknown>): Promise<void>;
    private handleRequestUpload;
    private handleComplete;
    private handleCancel;
    /**
     * Drop a disconnected client's correlation entries so the map doesn't grow
     * unbounded. The persisted row.correlationId + TTL handle durability; this
     * is purely in-memory cleanup. Named onClientDisconnect so the server's
     * disconnect loop picks it up (same as SubscribeService).
     */
    onClientDisconnect(clientId: string): void;
}
export {};
//# sourceMappingURL=FileUploadService.d.ts.map