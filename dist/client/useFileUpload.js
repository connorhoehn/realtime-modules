"use strict";
// realtime-modules/src/client/useFileUpload.ts
//
// useFileUpload(channel) — React hook for gateway-mediated file upload lifecycle.
//
// Flow:
//   1. upload(file) — emits { service: 'fileupload', action: 'request-upload', channel, filename, size }
//   2. Gateway responds with { type: 'fileupload:url', channel, id, uploadUrl } — presigned PUT URL
//   3. Hook PUTs file bytes to uploadUrl with XHR progress tracking
//   4. On XHR completion, emits { service: 'fileupload', action: 'complete', channel, id }
//   5. Gateway responds with { type: 'fileupload:complete', channel, id, downloadUrl }
//      or { type: 'fileupload:scanning', channel, id } (antivirus scan in progress)
//      or { type: 'fileupload:clean',    channel, id, downloadUrl } (scan passed)
//      or { type: 'fileupload:infected', channel, id, error }
//      or { type: 'fileupload:failed',   channel, id, error }
//
// Inbound frame types handled:
//   fileupload:url       — presigned upload URL issued by gateway
//   fileupload:progress  — optional server-side progress (0–100)
//   fileupload:scanning  — AV scan in progress
//   fileupload:clean     — scan passed, downloadUrl available
//   fileupload:infected  — scan failed
//   fileupload:complete  — completed (no scan path)
//   fileupload:failed    — server-side failure
//   fileupload:cancelled — cancel acknowledged
//
// Outbound frames (canonical declarations: @connorhoehn/event-catalog
// client-frames — client.fileupload.request-upload / complete / cancel):
//   { service: 'fileupload', action: 'request-upload', channel, id, filename, size, metadata? }
//   { service: 'fileupload', action: 'complete',        channel, id }
//   { service: 'fileupload', action: 'cancel',          channel, id }
Object.defineProperty(exports, "__esModule", { value: true });
exports.useFileUpload = useFileUpload;
const react_1 = require("react");
const GatewaySocketProvider_1 = require("./GatewaySocketProvider");
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function randomId() {
    const c = globalThis.crypto;
    if (c && typeof c.randomUUID === 'function')
        return c.randomUUID();
    return `fu-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}
/**
 * Perform a PUT of the file to a presigned URL, reporting progress via the
 * callback. Returns a Promise that resolves on success or rejects on error.
 * Accepts an optional AbortSignal so the caller can cancel mid-flight.
 */
function xhrPut(url, file, onProgress, signal) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.upload.addEventListener('progress', (e) => {
            if (e.lengthComputable) {
                onProgress(Math.round((e.loaded / e.total) * 100));
            }
        });
        xhr.addEventListener('load', () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                onProgress(100);
                resolve();
            }
            else {
                reject(new Error(`Upload failed: HTTP ${xhr.status}`));
            }
        });
        xhr.addEventListener('error', () => {
            reject(new Error('Upload network error'));
        });
        xhr.addEventListener('abort', () => {
            reject(new DOMException('Upload aborted', 'AbortError'));
        });
        xhr.open('PUT', url);
        xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
        xhr.send(file);
        if (signal) {
            signal.addEventListener('abort', () => xhr.abort());
        }
    });
}
/**
 * Downscale an image file to a tiny data URI.
 *
 * This is what lets a recipient see WHAT is arriving rather than a grey box
 * with a percentage. It runs on the sender before the upload starts, costs one
 * canvas draw, and rides the `fileupload:started` broadcast. Returns undefined
 * for anything that is not a decodable image — a placeholder is a nicety, and
 * failing to make one must never block the actual upload.
 */
async function makePreview(file, maxEdge) {
    if (maxEdge <= 0 || !file.type.startsWith('image/'))
        return undefined;
    if (typeof document === 'undefined' || typeof createImageBitmap !== 'function')
        return undefined;
    try {
        const bitmap = await createImageBitmap(file);
        const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
        const w = Math.max(1, Math.round(bitmap.width * scale));
        const h = Math.max(1, Math.round(bitmap.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx)
            return undefined;
        ctx.drawImage(bitmap, 0, 0, w, h);
        bitmap.close?.();
        return canvas.toDataURL('image/jpeg', 0.5);
    }
    catch {
        return undefined;
    }
}
/** Intrinsic dimensions, so a recipient's layout reserves the right space
 *  before the full image has downloaded and stops reflowing on arrival. */
async function measure(file) {
    if (!file.type.startsWith('image/') || typeof createImageBitmap !== 'function')
        return {};
    try {
        const bitmap = await createImageBitmap(file);
        const dims = { width: bitmap.width, height: bitmap.height };
        bitmap.close?.();
        return dims;
    }
    catch {
        return {};
    }
}
function useFileUpload(channel, options = {}) {
    const { send, onMessage } = (0, GatewaySocketProvider_1.useGateway)();
    const optionsRef = (0, react_1.useRef)(options);
    (0, react_1.useEffect)(() => {
        optionsRef.current = options;
    });
    const [uploads, setUploads] = (0, react_1.useState)([]);
    const [transfers, setTransfers] = (0, react_1.useState)([]);
    /** correlation id -> server transfer id, for the viewer's own uploads. */
    const transferIdsRef = (0, react_1.useRef)(new Map());
    const channelRef = (0, react_1.useRef)(channel);
    (0, react_1.useEffect)(() => {
        channelRef.current = channel;
    }, [channel]);
    // Map of upload id → AbortController for in-flight XHR cancellation.
    const abortControllersRef = (0, react_1.useRef)(new Map());
    // Pending promises: upload() awaits a 'fileupload:url' frame for the given id.
    // Map of id → { resolve, reject }
    const urlWaitersRef = (0, react_1.useRef)(new Map());
    // Mutable patch helper — updates one upload entry by id.
    const patch = (0, react_1.useCallback)((id, delta) => {
        setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, ...delta } : u)));
    }, []);
    /**
     * Upsert a channel transfer by its server-minted id.
     *
     * Upsert rather than patch because these frames can genuinely arrive out of
     * order for a participant who joined mid-transfer: the first thing they see
     * may be a `:progress`, with no `:started` ever addressed to them. Treating
     * that as "unknown transfer, ignore" is how a recipient ends up watching
     * nothing happen.
     */
    const upsertTransfer = (0, react_1.useCallback)((transferId, delta) => {
        setTransfers((prev) => {
            const idx = prev.findIndex((t) => t.transferId === transferId);
            if (idx === -1) {
                return [
                    ...prev,
                    {
                        transferId,
                        actor: 'someone',
                        uploader: '',
                        name: 'file',
                        size: 0,
                        transferred: 0,
                        phase: 'started',
                        ...delta,
                    },
                ];
            }
            const next = prev.slice();
            // Progress is monotonic on the wire, but a late-delivered older frame
            // would still walk the bar backwards. Clamp it here too.
            const merged = { ...next[idx], ...delta };
            if (typeof delta.transferred === 'number') {
                merged.transferred = Math.max(next[idx].transferred, delta.transferred);
            }
            next[idx] = merged;
            return next;
        });
    }, []);
    const dropTransfer = (0, react_1.useCallback)((transferId) => {
        setTransfers((prev) => prev.filter((t) => t.transferId !== transferId));
    }, []);
    // Register inbound handler once.
    (0, react_1.useEffect)(() => {
        const unsubscribe = onMessage((msg) => {
            if (msg.channel !== channelRef.current)
                return;
            if (typeof msg.type !== 'string' || !msg.type.startsWith('fileupload:'))
                return;
            const raw = msg;
            const id = typeof raw.id === 'string' ? raw.id : null;
            const transferId = typeof raw.transferId === 'string' ? raw.transferId : null;
            // ---- channel-wide transfer lifecycle --------------------------------
            // These frames are BROADCASTS: every subscriber gets them, including
            // participants who are not uploading anything. They are handled before
            // the correlation-id gate below, because a recipient has no correlation
            // id for somebody else's upload and would otherwise drop the frame.
            if (transferId) {
                switch (msg.type) {
                    case 'fileupload:started':
                        upsertTransfer(transferId, {
                            actor: typeof raw.actor === 'string' ? raw.actor : 'someone',
                            uploader: typeof raw.uploader === 'string' ? raw.uploader : '',
                            name: typeof raw.filename === 'string' ? raw.filename : 'file',
                            size: typeof raw.size === 'number' ? raw.size : 0,
                            transferred: 0,
                            phase: 'started',
                            ...(typeof raw.contentType === 'string' ? { contentType: raw.contentType } : {}),
                            ...(typeof raw.preview === 'string' ? { preview: raw.preview } : {}),
                            ...(typeof raw.width === 'number' ? { width: raw.width } : {}),
                            ...(typeof raw.height === 'number' ? { height: raw.height } : {}),
                        });
                        break;
                    case 'fileupload:progress':
                        upsertTransfer(transferId, {
                            phase: 'transferring',
                            ...(typeof raw.actor === 'string' ? { actor: raw.actor } : {}),
                            ...(typeof raw.transferred === 'number' ? { transferred: raw.transferred } : {}),
                            ...(typeof raw.size === 'number' && raw.size > 0 ? { size: raw.size } : {}),
                        });
                        break;
                    case 'fileupload:complete': {
                        // The transfer row retires here; the consumer turns the completed
                        // frame into a durable message attachment. Leaving it in the
                        // in-flight list would double-render the file.
                        dropTransfer(transferId);
                        const downloadUrl = typeof raw.downloadUrl === 'string' ? raw.downloadUrl : '';
                        if (downloadUrl) {
                            let mine = false;
                            for (const mapped of transferIdsRef.current.values()) {
                                if (mapped === transferId) {
                                    mine = true;
                                    break;
                                }
                            }
                            optionsRef.current.onComplete?.({
                                transferId,
                                mine,
                                actor: typeof raw.actor === 'string' ? raw.actor : 'someone',
                                uploader: typeof raw.uploader === 'string' ? raw.uploader : '',
                                filename: typeof raw.filename === 'string' ? raw.filename : 'file',
                                size: typeof raw.size === 'number' ? raw.size : 0,
                                contentType: typeof raw.contentType === 'string' ? raw.contentType : 'application/octet-stream',
                                downloadUrl,
                                ...(typeof raw.width === 'number' ? { width: raw.width } : {}),
                                ...(typeof raw.height === 'number' ? { height: raw.height } : {}),
                                ...(typeof raw.preview === 'string' ? { preview: raw.preview } : {}),
                            });
                        }
                        break;
                    }
                    case 'fileupload:failed':
                    case 'fileupload:cancelled':
                        dropTransfer(transferId);
                        break;
                    default:
                        break;
                }
            }
            if (!id)
                return;
            switch (msg.type) {
                case 'fileupload:url': {
                    const uploadUrl = typeof raw.uploadUrl === 'string' ? raw.uploadUrl : undefined;
                    if (transferId)
                        transferIdsRef.current.set(id, transferId);
                    // Resolve the waiting upload() promise.
                    const waiter = urlWaitersRef.current.get(id);
                    if (waiter && uploadUrl) {
                        urlWaitersRef.current.delete(id);
                        waiter.resolve(uploadUrl);
                    }
                    else if (waiter) {
                        urlWaitersRef.current.delete(id);
                        waiter.reject(new Error('Gateway returned fileupload:url without uploadUrl'));
                    }
                    patch(id, { uploadUrl, status: 'uploading' });
                    break;
                }
                case 'fileupload:progress': {
                    const progress = typeof raw.progress === 'number' ? raw.progress : undefined;
                    if (progress !== undefined)
                        patch(id, { progress });
                    break;
                }
                case 'fileupload:complete': {
                    const downloadUrl = typeof raw.downloadUrl === 'string' ? raw.downloadUrl : undefined;
                    patch(id, { status: 'completed', progress: 100, downloadUrl });
                    break;
                }
                case 'fileupload:scanning': {
                    patch(id, { status: 'scanning' });
                    break;
                }
                case 'fileupload:clean': {
                    const downloadUrl = typeof raw.downloadUrl === 'string' ? raw.downloadUrl : undefined;
                    patch(id, { status: 'clean', progress: 100, downloadUrl });
                    break;
                }
                case 'fileupload:infected': {
                    const error = typeof raw.error === 'string' ? raw.error : 'File failed virus scan';
                    patch(id, { status: 'infected', error });
                    break;
                }
                case 'fileupload:failed': {
                    const error = typeof raw.error === 'string' ? raw.error : 'Upload failed';
                    // Also reject any pending URL waiter (server failed before issuing the URL).
                    const waiter = urlWaitersRef.current.get(id);
                    if (waiter) {
                        urlWaitersRef.current.delete(id);
                        waiter.reject(new Error(error));
                    }
                    patch(id, { status: 'failed', error });
                    break;
                }
                case 'fileupload:cancelled': {
                    patch(id, { status: 'failed', error: 'Cancelled' });
                    break;
                }
                default:
                    break;
            }
        });
        return unsubscribe;
    }, [onMessage, patch, upsertTransfer, dropTransfer]);
    // Reset uploads when channel changes.
    (0, react_1.useEffect)(() => {
        setUploads([]);
        setTransfers([]);
        transferIdsRef.current.clear();
        abortControllersRef.current.clear();
        urlWaitersRef.current.clear();
    }, [channel]);
    // Cleanup in-flight XHRs on unmount.
    (0, react_1.useEffect)(() => {
        return () => {
            for (const ctrl of abortControllersRef.current.values()) {
                ctrl.abort();
            }
            abortControllersRef.current.clear();
            urlWaitersRef.current.clear();
        };
    }, []);
    // ---- upload ---------------------------------------------------------------
    const upload = (0, react_1.useCallback)(async (file, opts) => {
        const id = randomId();
        const initial = {
            id,
            filename: file.name,
            size: file.size,
            status: 'pending',
            progress: 0,
        };
        setUploads((prev) => [...prev, initial]);
        // Build the presentation hints BEFORE asking for a URL, so the
        // `fileupload:started` broadcast the gateway fans out already carries
        // the placeholder. Generating it after would mean every recipient sees
        // a grey box first and a thumbnail second — two renders for one event.
        const { previewMaxEdge = 32, displayName } = optionsRef.current;
        const [preview, dims] = await Promise.all([
            makePreview(file, previewMaxEdge),
            measure(file),
        ]);
        // Request an upload URL from the gateway.
        send({
            service: 'fileupload',
            action: 'request-upload',
            channel: channelRef.current,
            id,
            filename: file.name,
            size: file.size,
            metadata: {
                contentType: file.type || 'application/octet-stream',
                ...(displayName ? { displayName } : {}),
                ...(preview ? { preview } : {}),
                ...dims,
                ...(opts?.metadata ?? {}),
            },
        });
        // Wait for the gateway to issue the presigned URL.
        const uploadUrl = await new Promise((resolve, reject) => {
            urlWaitersRef.current.set(id, { resolve, reject });
        });
        // PUT the file bytes directly to the storage provider.
        const ctrl = new AbortController();
        abortControllersRef.current.set(id, ctrl);
        try {
            await xhrPut(uploadUrl, file, (pct) => {
                patch(id, { progress: pct, status: 'uploading' });
            }, ctrl.signal);
        }
        catch (err) {
            abortControllersRef.current.delete(id);
            const message = err.message || 'Upload error';
            patch(id, { status: 'failed', error: message });
            return { ...initial, status: 'failed', error: message };
        }
        abortControllersRef.current.delete(id);
        // Notify gateway that the bytes are on the storage backend.
        send({
            service: 'fileupload',
            action: 'complete',
            channel: channelRef.current,
            id,
        });
        // Return current state snapshot — caller can observe further status changes
        // (scanning → clean/infected) via the uploads array.
        const snapshot = {
            id,
            filename: file.name,
            size: file.size,
            status: 'uploading',
            progress: 100,
            uploadUrl,
        };
        return snapshot;
    }, [send, patch]);
    // ---- cancel ---------------------------------------------------------------
    const cancel = (0, react_1.useCallback)((id) => {
        // Abort in-flight XHR if any.
        const ctrl = abortControllersRef.current.get(id);
        if (ctrl) {
            ctrl.abort();
            abortControllersRef.current.delete(id);
        }
        // Reject any pending URL waiter.
        const waiter = urlWaitersRef.current.get(id);
        if (waiter) {
            urlWaitersRef.current.delete(id);
            waiter.reject(new DOMException('Upload cancelled', 'AbortError'));
        }
        // Notify gateway.
        send({
            service: 'fileupload',
            action: 'cancel',
            channel: channelRef.current,
            id,
        });
        patch(id, { status: 'failed', error: 'Cancelled' });
    }, [send, patch]);
    // ---- removeCompleted ------------------------------------------------------
    const removeCompleted = (0, react_1.useCallback)(() => {
        setUploads((prev) => prev.filter((u) => u.status !== 'completed' && u.status !== 'clean' && u.status !== 'infected'));
    }, []);
    /** Cancel by the id the UI actually renders (the server-minted one). */
    const cancelTransfer = (0, react_1.useCallback)((transferId) => {
        for (const [correlationId, mapped] of transferIdsRef.current) {
            if (mapped === transferId) {
                cancel(correlationId);
                return;
            }
        }
        // Not ours to cancel — a recipient has no authority over somebody
        // else's upload, and the server would refuse anyway.
    }, [cancel]);
    return { uploads, transfers, upload, cancel, cancelTransfer, removeCompleted };
}
//# sourceMappingURL=useFileUpload.js.map