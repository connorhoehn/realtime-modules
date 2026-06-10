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

import { useState, useEffect, useRef, useCallback } from 'react';
import { useGateway } from './GatewaySocketProvider';
import type { GatewayMessage } from './types';
// Type-only import — erased at build; the EC package stays a devDependency.
import type { ClientFramePayload } from '@connorhoehn/event-catalog/client-frames';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface FileUploadState {
  id: string;
  filename: string;
  size: number;
  status: 'pending' | 'uploading' | 'completed' | 'failed' | 'scanning' | 'clean' | 'infected';
  progress?: number; // 0-100
  uploadUrl?: string;
  downloadUrl?: string;
  error?: string;
}

export interface UseFileUploadResult {
  uploads: FileUploadState[];
  upload(file: File, opts?: { metadata?: Record<string, unknown> }): Promise<FileUploadState>;
  cancel(id: string): void;
  removeCompleted(): void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `fu-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

/**
 * Perform a PUT of the file to a presigned URL, reporting progress via the
 * callback. Returns a Promise that resolves on success or rejects on error.
 * Accepts an optional AbortSignal so the caller can cancel mid-flight.
 */
function xhrPut(
  url: string,
  file: File,
  onProgress: (pct: number) => void,
  signal?: AbortSignal,
): Promise<void> {
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
      } else {
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

// ---------------------------------------------------------------------------
// Hook implementation
// ---------------------------------------------------------------------------

export function useFileUpload(channel: string): UseFileUploadResult {
  const { send, onMessage } = useGateway();
  const [uploads, setUploads] = useState<FileUploadState[]>([]);

  const channelRef = useRef(channel);
  useEffect(() => {
    channelRef.current = channel;
  }, [channel]);

  // Map of upload id → AbortController for in-flight XHR cancellation.
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());

  // Pending promises: upload() awaits a 'fileupload:url' frame for the given id.
  // Map of id → { resolve, reject }
  const urlWaitersRef = useRef<Map<string, { resolve: (url: string) => void; reject: (err: Error) => void }>>(new Map());

  // Mutable patch helper — updates one upload entry by id.
  const patch = useCallback((id: string, delta: Partial<FileUploadState>) => {
    setUploads((prev) =>
      prev.map((u) => (u.id === id ? { ...u, ...delta } : u)),
    );
  }, []);

  // Register inbound handler once.
  useEffect(() => {
    const unsubscribe = onMessage((msg: GatewayMessage) => {
      if (msg.channel !== channelRef.current) return;
      if (typeof msg.type !== 'string' || !msg.type.startsWith('fileupload:')) return;

      const raw = msg as Record<string, unknown>;
      const id = typeof raw.id === 'string' ? raw.id : null;
      if (!id) return;

      switch (msg.type) {
        case 'fileupload:url': {
          const uploadUrl = typeof raw.uploadUrl === 'string' ? raw.uploadUrl : undefined;
          // Resolve the waiting upload() promise.
          const waiter = urlWaitersRef.current.get(id);
          if (waiter && uploadUrl) {
            urlWaitersRef.current.delete(id);
            waiter.resolve(uploadUrl);
          } else if (waiter) {
            urlWaitersRef.current.delete(id);
            waiter.reject(new Error('Gateway returned fileupload:url without uploadUrl'));
          }
          patch(id, { uploadUrl, status: 'uploading' });
          break;
        }
        case 'fileupload:progress': {
          const progress = typeof raw.progress === 'number' ? raw.progress : undefined;
          if (progress !== undefined) patch(id, { progress });
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
  }, [onMessage, patch]);

  // Reset uploads when channel changes.
  useEffect(() => {
    setUploads([]);
    abortControllersRef.current.clear();
    urlWaitersRef.current.clear();
  }, [channel]);

  // Cleanup in-flight XHRs on unmount.
  useEffect(() => {
    return () => {
      for (const ctrl of abortControllersRef.current.values()) {
        ctrl.abort();
      }
      abortControllersRef.current.clear();
      urlWaitersRef.current.clear();
    };
  }, []);

  // ---- upload ---------------------------------------------------------------

  const upload = useCallback(
    async (file: File, opts?: { metadata?: Record<string, unknown> }): Promise<FileUploadState> => {
      const id = randomId();
      const initial: FileUploadState = {
        id,
        filename: file.name,
        size: file.size,
        status: 'pending',
        progress: 0,
      };

      setUploads((prev) => [...prev, initial]);

      // Request a presigned upload URL from the gateway.
      send({
        service: 'fileupload',
        action: 'request-upload',
        channel: channelRef.current,
        id,
        filename: file.name,
        size: file.size,
        ...(opts?.metadata ? { metadata: opts.metadata } : {}),
      } satisfies ClientFramePayload<'client.fileupload.request-upload'>);

      // Wait for the gateway to issue the presigned URL.
      const uploadUrl = await new Promise<string>((resolve, reject) => {
        urlWaitersRef.current.set(id, { resolve, reject });
      });

      // PUT the file bytes directly to the storage provider.
      const ctrl = new AbortController();
      abortControllersRef.current.set(id, ctrl);

      try {
        await xhrPut(
          uploadUrl,
          file,
          (pct) => {
            patch(id, { progress: pct, status: 'uploading' });
          },
          ctrl.signal,
        );
      } catch (err) {
        abortControllersRef.current.delete(id);
        const message = (err as { message?: string }).message || 'Upload error';
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
      } satisfies ClientFramePayload<'client.fileupload.complete'>);

      // Return current state snapshot — caller can observe further status changes
      // (scanning → clean/infected) via the uploads array.
      const snapshot: FileUploadState = {
        id,
        filename: file.name,
        size: file.size,
        status: 'uploading',
        progress: 100,
        uploadUrl,
      };
      return snapshot;
    },
    [send, patch],
  );

  // ---- cancel ---------------------------------------------------------------

  const cancel = useCallback(
    (id: string) => {
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
      } satisfies ClientFramePayload<'client.fileupload.cancel'>);
      patch(id, { status: 'failed', error: 'Cancelled' });
    },
    [send, patch],
  );

  // ---- removeCompleted ------------------------------------------------------

  const removeCompleted = useCallback(() => {
    setUploads((prev) =>
      prev.filter(
        (u) => u.status !== 'completed' && u.status !== 'clean' && u.status !== 'infected',
      ),
    );
  }, []);

  return { uploads, upload, cancel, removeCompleted };
}
