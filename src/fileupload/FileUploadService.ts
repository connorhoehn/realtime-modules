// realtime-modules/src/fileupload/FileUploadService.ts
//
// Gateway-native file-upload WS service. Closes the long-standing gap where
// realtime-modules' useFileUpload hook had no server counterpart (the
// MessageValidator allow-list rejected `fileupload` frames as
// SERVICE_NOT_ENABLED).
//
// SCOPE: the WS signaling half of the upload lifecycle. The byte transfer
// itself rides a plain gateway HTTP endpoint (PUT /api/uploads/:id streams
// to a filesystem blob dir — see api-routes-fileupload.ts + FileBlobStore).
// This service handles three client verbs and emits the matching push frames.
//
// Wire contract — GROUND TRUTH is realtime-modules/src/client/useFileUpload.ts
// (the hook's `fileupload:*` frame types), NOT the ws.upload.* / type:'upload'
// declarations in event-catalog/gateway-signal.ts. The hook is the live
// consumer; the ws.upload.* frames are a parallel (unused-by-this-hook)
// declaration. The naming tension is documented in EC client-frames.ts.
//
//   IN  { service:'fileupload', action:'request-upload', channel, id, filename, size, metadata? }
//   OUT { type:'fileupload:url', channel, id, uploadUrl }      (to the requesting client)
//
//   IN  { service:'fileupload', action:'complete', channel, id }
//   OUT { type:'fileupload:complete', channel, id, downloadUrl } (broadcast to channel)
//
//   IN  { service:'fileupload', action:'cancel', channel, id }
//   OUT { type:'fileupload:cancelled', channel, id }            (to the requesting client)
//
//   failures → { type:'fileupload:failed', channel, id, error } (to the requesting client)
//
// uploadUrl  = `${FILEUPLOAD_PUBLIC_BASE}/api/uploads/${id}`  (HTTP PUT target)
// downloadUrl= `${FILEUPLOAD_PUBLIC_BASE}/api/uploads/${id}`  (HTTP GET target)
//
// AV-SCAN: deferred. We emit `fileupload:complete` directly with no
// scanning/clean/infected intermediate. A future scanner integration would
// slot a `fileupload:scanning` ack on `complete`, run the scan async, then
// emit `fileupload:clean` (with downloadUrl) or `fileupload:infected`.

import { randomUUID } from 'crypto';
import { FileBlobStore, resolveMaxBytes } from './FileBlobStore';
import { sanitizeUploadId } from './FileBlobStore';

// Wire error code kept as a local constant — the value is part of the WS
// protocol, not of any one app's error-code table.
const AUTHZ_CHANNEL_DENIED = 'AUTHZ_CHANNEL_DENIED';

/**
 * Metadata persistence contract (v0.18.0 extraction seam). The gateway's
 * DynamoDB FileUploadMetadataRepository satisfies this structurally; the
 * in-memory implementation below is the zero-config default for
 * kick-starter deployments and tests.
 */
export interface FileUploadMetadataStore {
    create(row: Omit<FileUploadRow, 'createdAt'> & { createdAt?: string }): Promise<void>;
    get(uploadId: string): Promise<FileUploadRow | null>;
    updateStatus(uploadId: string, status: FileUploadStatus, patch?: { size?: number; contentType?: string }): Promise<void>;
}

/** Upload lifecycle states — mirrors the gateway's DynamoDB repository. */
export type FileUploadStatus = 'pending' | 'uploaded' | 'completed' | 'failed' | 'cancelled';

/** Row shape shared with persistence implementations (copied verbatim from
 *  the gateway's FileUploadMetadataRepository — the DDB repo satisfies
 *  FileUploadMetadataStore structurally, so the shapes must stay in sync). */
export interface FileUploadRow {
    uploadId: string;       // SERVER-minted unguessable token (storage key)
    /**
     * Client-supplied correlation id from the request-upload frame. The
     * useFileUpload hook keys its in-flight upload state by THIS id, so
     * every push frame back to the hook must echo it as `id`. Decoupled
     * from `uploadId` (the storage key) by the server-mint fix.
     */
    correlationId?: string;
    channel: string;
    uploader: string;       // authed userId (or 'anonymous' under SKIP_AUTH)
    filename: string;
    size: number;           // declared size on request; actual byte count after PUT
    status: FileUploadStatus;
    contentType?: string;
    createdAt: string;      // ISO-8601
    updatedAt?: string;     // ISO-8601
    metadata?: Record<string, unknown>;
}

/** Zero-config in-memory metadata store (single-process; kick-starters/tests). */
export class InMemoryFileUploadMetadataStore implements FileUploadMetadataStore {
    private rows = new Map<string, FileUploadRow>();
    async create(row: Omit<FileUploadRow, 'createdAt'> & { createdAt?: string }): Promise<void> {
        this.rows.set(row.uploadId, { ...row, createdAt: row.createdAt ?? new Date().toISOString() } as FileUploadRow);
    }
    async get(uploadId: string): Promise<FileUploadRow | null> {
        return this.rows.get(uploadId) ?? null;
    }
    async updateStatus(uploadId: string, status: FileUploadStatus, patch: { size?: number; contentType?: string } = {}): Promise<void> {
        const row = this.rows.get(uploadId);
        if (row) this.rows.set(uploadId, { ...row, ...patch, status, updatedAt: new Date().toISOString() });
    }
}

interface RouterLike {
    sendToClient(clientId: string, message: unknown): Promise<unknown> | unknown;
    sendToChannel(
        channel: string,
        message: unknown,
        excludeClientId?: string | null,
        opts?: { skipCoalesce?: boolean; publisherClientId?: string | null },
    ): Promise<unknown> | unknown;
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
    metricsCollector?: { recordMetric?: (name: string, value: number) => void };
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

const ALLOWED_ACTIONS = new Set(['request-upload', 'complete', 'cancel']);

const MAX_FILENAME_LEN = 255;
const CHANNEL_PATTERN = /^[a-zA-Z0-9_:-]{1,50}$/;

export class FileUploadService {
    // Public so `enforceChannelPermission` can resolve them off the service
    // instance (it reads service.messageRouter / .logger / .metricsCollector /
    // .sendError) — the SAME contract chat/subscribe/cursor/etc use. Renamed
    // from the old private `router`/`metrics` fields for that reason.
    messageRouter: RouterLike;
    logger: LoggerLike;
    metricsCollector?: { recordMetric?: (name: string, value: number) => void };
    readonly blobStore: FileBlobStore;
    readonly metadataRepo: FileUploadMetadataStore;
    private readonly authz: (service: FileUploadService, clientId: string, channel: string) => boolean;
    private publicBaseUrl: string;
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
    private correlationToUploadId = new Map<string, string>();

    constructor(opts: FileUploadServiceOptions) {
        this.messageRouter = opts.messageRouter;
        this.logger = opts.logger;
        this.metricsCollector = opts.metricsCollector;
        this.blobStore = opts.blobStore ?? new FileBlobStore();
        this.metadataRepo = opts.metadataRepo ?? new InMemoryFileUploadMetadataStore();
        this.authz = opts.authz ?? (() => true);
        this.publicBaseUrl = (opts.publicBaseUrl ?? process.env.FILEUPLOAD_PUBLIC_BASE ?? '').replace(/\/+$/, '');
        this.maxBytes = opts.maxBytes ?? resolveMaxBytes();
    }

    /** Build the HTTP url (PUT for upload, GET for download — same path). */
    uploadUrlFor(uploadId: string): string {
        return `${this.publicBaseUrl}/api/uploads/${encodeURIComponent(uploadId)}`;
    }

    private uploaderFor(clientId: string): string {
        const uid = this.messageRouter.getUserIdForClient?.(clientId);
        return typeof uid === 'string' && uid.length > 0 ? uid : 'anonymous';
    }

    private correlationKey(clientId: string, channel: string, correlationId: string): string {
        return `${clientId}::${channel}::${correlationId}`;
    }

    /**
     * Resolve a client's request-upload correlation id to the server-minted
     * storage uploadId + its persisted row. Fast path: the in-memory
     * correlation map. Fallback: scan-free direct read is impossible (the row
     * is keyed by minted id, not correlation), so when the map misses (cross-
     * node / post-restart) the caller treats it as unknown — the hook will
     * surface a failure and the row self-expires via TTL. Returns null when
     * unresolvable.
     */
    private async resolveByCorrelation(
        clientId: string,
        channel: string,
        correlationId: string,
    ): Promise<{ uploadId: string; row: FileUploadRow } | null> {
        const mintedId = this.correlationToUploadId.get(
            this.correlationKey(clientId, channel, correlationId),
        );
        if (!mintedId) return null;
        const row = await this.metadataRepo.get(mintedId);
        if (!row) return null;
        return { uploadId: mintedId, row };
    }

    private emitFailed(clientId: string, channel: string, id: string, error: string): void {
        void this.messageRouter.sendToClient(clientId, {
            type: 'fileupload:failed',
            channel,
            id,
            error,
            timestamp: new Date().toISOString(),
        });
    }

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
    sendError(clientId: string, message: string, code: string = AUTHZ_CHANNEL_DENIED): void {
        void this.messageRouter.sendToClient(clientId, {
            type: 'fileupload:failed',
            service: 'fileupload',
            code,
            error: message,
            message,
            timestamp: new Date().toISOString(),
        });
    }

    /**
     * Dispatch entrypoint — same `handleAction(clientId, action, data)`
     * contract every gateway WS service implements. `data` is the inbound
     * frame minus `service`/`action` (channel, id, filename, size, metadata).
     */
    async handleAction(clientId: string, action: string, data: Record<string, unknown>): Promise<void> {
        if (!ALLOWED_ACTIONS.has(action)) {
            void this.messageRouter.sendToClient(clientId, {
                type: 'fileupload:failed',
                channel: typeof data.channel === 'string' ? data.channel : '',
                id: typeof data.id === 'string' ? data.id : '',
                error: `Unknown fileupload action: ${action}`,
            });
            return;
        }

        const channel = typeof data.channel === 'string' ? data.channel : '';
        const id = typeof data.id === 'string' ? data.id : '';

        // Common validation: channel + id are required on every verb.
        if (!channel || !CHANNEL_PATTERN.test(channel)) {
            this.emitFailed(clientId, channel, id, 'invalid or missing channel');
            return;
        }
        if (!id || !sanitizeUploadId(id)) {
            this.emitFailed(clientId, channel, id, 'invalid or missing upload id');
            return;
        }

        // ---- AUTHZ (M3 bug class) -------------------------------------------
        // Every fileupload verb publishes into / reads from a channel:
        //   - request-upload mints a pending row scoped to the channel
        //   - complete BROADCASTS a fileupload:complete frame to the channel
        //   - cancel deletes the blob + acks
        // Before this gate the service called sendToChannel with NO
        // publisherClientId, so the router's CRD publisher-role check (which
        // only runs `if (publisherClientId)`) was skipped entirely AND there
        // was no membership/permission check at all — the exact M3 chat bug
        // (publisher-authz decoupled from echo) reintroduced for uploads. We
        // run the same `enforceChannelPermission` interceptor every other
        // service uses; on denial it has already emitted the error frame, so
        // we early-return with NO ack / NO broadcast.
        if (!this.authz(this, clientId, channel)) {
            return;
        }
        // --------------------------------------------------------------------

        try {
            switch (action) {
                case 'request-upload':
                    await this.handleRequestUpload(clientId, channel, id, data);
                    return;
                case 'complete':
                    await this.handleComplete(clientId, channel, id);
                    return;
                case 'cancel':
                    await this.handleCancel(clientId, channel, id);
                    return;
                default:
                    return;
            }
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this.logger.error?.('[FileUploadService] handleAction failed', {
                clientId, action, channel, id, error: message,
            });
            this.emitFailed(clientId, channel, id, 'internal upload error');
        }
    }

    private async handleRequestUpload(
        clientId: string,
        channel: string,
        id: string,
        data: Record<string, unknown>,
    ): Promise<void> {
        const filenameRaw = typeof data.filename === 'string' ? data.filename : '';
        const filename = filenameRaw.slice(0, MAX_FILENAME_LEN) || 'upload';
        const size = typeof data.size === 'number' && Number.isFinite(data.size) ? data.size : 0;

        // Reject declared sizes over the cap up front — saves a round-trip
        // (the HTTP PUT enforces the real cap on bytes regardless).
        if (size > this.maxBytes) {
            this.emitFailed(clientId, channel, id, `file exceeds ${this.maxBytes} byte limit`);
            return;
        }

        const metadata = data.metadata && typeof data.metadata === 'object'
            ? (data.metadata as Record<string, unknown>)
            : undefined;

        const uploader = this.uploaderFor(clientId);

        // ---- server-minted storage id (security) ----------------------------
        // `id` here is the CLIENT's correlation id (the hook's in-flight key).
        // It is attacker-controlled and NOT an unguessable token, so we MUST
        // NOT use it as the storage key — doing so lets a client pick a known
        // id, or collide with / overwrite another upload's blob. The storage
        // key is server-minted (randomUUID). The correlation id is preserved
        // for the wire (the hook keys urlWaiters/patch by it) via the
        // correlation map + the persisted row.correlationId.
        const correlationId = id;
        const uploadId = randomUUID();
        // ---------------------------------------------------------------------

        // Persist the pending row BEFORE issuing the URL so the HTTP PUT
        // handler can authorize against it. If the DDB write fails we fail
        // the upload rather than issue a URL with no backing row.
        await this.metadataRepo.create({
            uploadId,
            correlationId,
            channel,
            uploader,
            filename,
            size,
            status: 'pending',
            ...(metadata ? { metadata } : {}),
        });

        this.correlationToUploadId.set(
            this.correlationKey(clientId, channel, correlationId),
            uploadId,
        );

        this.metricsCollector?.recordMetric?.('FileUpload.requested', 1);

        // The reply echoes the CLIENT correlation id as `id` (so the hook's
        // url-waiter resolves) but the uploadUrl carries the SERVER-minted
        // storage id — the browser PUTs/GETs against the minted path.
        void this.messageRouter.sendToClient(clientId, {
            type: 'fileupload:url',
            channel,
            id: correlationId,
            uploadUrl: this.uploadUrlFor(uploadId),
            timestamp: new Date().toISOString(),
        });
    }

    private async handleComplete(clientId: string, channel: string, id: string): Promise<void> {
        // `id` is the client correlation id — resolve it to the server-minted
        // storage id + row. (Unknown correlation = no row we issued for this
        // client/channel; treat as unknown upload.)
        const resolved = await this.resolveByCorrelation(clientId, channel, id);
        if (!resolved) {
            this.emitFailed(clientId, channel, id, 'unknown upload');
            return;
        }
        const { uploadId, row } = resolved;

        // Ownership: only the user who requested the upload may complete it.
        // Without this an authorized channel member could complete (and
        // broadcast a download URL for) another member's in-flight upload.
        const callerUserId = this.uploaderFor(clientId);
        if (row.uploader !== callerUserId && row.uploader !== 'anonymous') {
            this.logger.warn?.('[FileUploadService] complete denied — not uploader', {
                clientId, channel, uploadId, owner: row.uploader, caller: callerUserId,
            });
            this.emitFailed(clientId, channel, id, 'not the uploader');
            return;
        }

        // The bytes must have actually landed (HTTP PUT flipped status to
        // 'uploaded'). A `complete` before the PUT lands is a client bug or
        // a race — fail it rather than broadcast a download URL for an
        // empty/absent blob.
        if (row.status !== 'uploaded' && row.status !== 'completed') {
            this.emitFailed(clientId, channel, id, `cannot complete upload in status '${row.status}'`);
            return;
        }

        if (row.status !== 'completed') {
            await this.metadataRepo.updateStatus(uploadId, 'completed');
        }

        this.metricsCollector?.recordMetric?.('FileUpload.completed', 1);

        // AV-SCAN deferred: emit complete directly. A scanner integration
        // would instead ack `fileupload:scanning` here and emit
        // `fileupload:clean` / `fileupload:infected` asynchronously.
        //
        // publisherClientId names the AUTHZ subject so the router's CRD
        // publisher-role check fires on this broadcast (M3 fix): the gate
        // further up authorized this client's permission to use the channel,
        // and this ensures the operator-pushed channel-config publisher
        // restriction is ALSO enforced at the fan-out boundary. excludeClientId
        // stays null so the uploader receives their own completion frame
        // (sender-echo — the hook patches its own upload row off it). The wire
        // `id` is the client correlation id (what the hook patches by); the
        // downloadUrl carries the server-minted storage id.
        void this.messageRouter.sendToChannel(
            channel,
            {
                type: 'fileupload:complete',
                channel,
                id,
                downloadUrl: this.uploadUrlFor(uploadId),
                filename: row.filename,
                size: row.size,
                timestamp: new Date().toISOString(),
            },
            null,
            { publisherClientId: clientId },
        );
    }

    private async handleCancel(clientId: string, channel: string, id: string): Promise<void> {
        const resolved = await this.resolveByCorrelation(clientId, channel, id);

        if (resolved) {
            const { uploadId, row } = resolved;
            // Ownership: only the requesting user may cancel (which deletes the
            // blob). Without this an authorized channel member could delete
            // another member's in-flight upload.
            const callerUserId = this.uploaderFor(clientId);
            if (row.uploader !== callerUserId && row.uploader !== 'anonymous') {
                this.logger.warn?.('[FileUploadService] cancel denied — not uploader', {
                    clientId, channel, uploadId, owner: row.uploader, caller: callerUserId,
                });
                this.emitFailed(clientId, channel, id, 'not the uploader');
                return;
            }
            // Idempotent: cancelling an already-terminal upload still acks.
            if (row.status !== 'completed') {
                await this.metadataRepo.updateStatus(uploadId, 'cancelled').catch(() => { /* best-effort */ });
                await this.blobStore.delete(uploadId);
            }
            this.correlationToUploadId.delete(this.correlationKey(clientId, channel, id));
        }

        this.metricsCollector?.recordMetric?.('FileUpload.cancelled', 1);

        // Idempotent ack even for an unknown correlation so the hook's pending
        // state resolves (matches the prior best-effort cancel contract).
        void this.messageRouter.sendToClient(clientId, {
            type: 'fileupload:cancelled',
            channel,
            id,
            timestamp: new Date().toISOString(),
        });
    }

    /**
     * Drop a disconnected client's correlation entries so the map doesn't grow
     * unbounded. The persisted row.correlationId + TTL handle durability; this
     * is purely in-memory cleanup. Named onClientDisconnect so the server's
     * disconnect loop picks it up (same as SubscribeService).
     */
    onClientDisconnect(clientId: string): void {
        const prefix = `${clientId}::`;
        for (const key of Array.from(this.correlationToUploadId.keys())) {
            if (key.startsWith(prefix)) this.correlationToUploadId.delete(key);
        }
    }
}
