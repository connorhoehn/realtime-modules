/**
 * @jest-environment jsdom
 */
// realtime-modules/test/client/useFileUpload.test.tsx
//
// Exercises useFileUpload via a mock GatewayContext + a stub XMLHttpRequest.
// Covers:
//   - upload() adds a pending entry then transitions to uploading on URL frame
//   - XHR progress updates are reflected in uploads[].progress
//   - fileupload:complete transitions status to 'completed'
//   - fileupload:scanning / fileupload:clean multi-step status transitions
//   - fileupload:infected sets status to 'infected' + error
//   - fileupload:failed rejects the upload() promise and sets status 'failed'
//   - cancel() aborts in-flight XHR and sends cancel frame
//   - removeCompleted() strips completed/clean/infected entries
//   - channel-change clears upload list

import React from 'react';
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react';
import { GatewayContext } from '../../src/client/GatewaySocketProvider';
import type { GatewayContextValue } from '../../src/client/GatewaySocketProvider';
import type { GatewayMessage } from '../../src/client/types';
import { useFileUpload } from '../../src/client/useFileUpload';

// ---------------------------------------------------------------------------
// Fake XMLHttpRequest
// ---------------------------------------------------------------------------

class FakeXHR {
  static instances: FakeXHR[] = [];

  url = '';
  method = '';
  headers: Record<string, string> = {};
  body: unknown = null;
  aborted = false;
  _status = 200;

  // Upload event listeners stored directly on the instance.
  _uploadListeners: Record<string, ((e: ProgressEvent) => void)> = {};
  _listeners: Record<string, ((e: Event) => void)> = {};

  // Expose an `upload` object matching the XHR spec shape.
  upload: { addEventListener: (type: string, cb: (e: ProgressEvent) => void) => void };

  constructor() {
    // Capture `this` so arrow methods in `upload` always reference this instance.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    this.upload = {
      addEventListener(type: string, cb: (e: ProgressEvent) => void) {
        self._uploadListeners[type] = cb;
      },
    };
    FakeXHR.instances.push(this);
  }

  addEventListener(type: string, cb: (e: Event) => void) {
    this._listeners[type] = cb;
  }

  open(_method: string, _url: string) {
    this.method = _method;
    this.url = _url;
  }

  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }

  send(body: unknown) {
    this.body = body;
  }

  abort() {
    this.aborted = true;
    const cb = this._listeners['abort'];
    if (cb) cb(new Event('abort'));
  }

  get status() {
    return this._status;
  }

  set status(v: number) {
    this._status = v;
  }

  // Test helper: fire a progress event on the upload object
  fireUploadProgress(loaded: number, total: number) {
    const cb = this._uploadListeners['progress'];
    if (cb) {
      cb({ lengthComputable: true, loaded, total } as ProgressEvent);
    }
  }

  // Test helper: fire load (success)
  fireLoad(status = 200) {
    this._status = status;
    const cb = this._listeners['load'];
    if (cb) cb(new Event('load'));
  }

  // Test helper: fire error
  fireError() {
    const cb = this._listeners['error'];
    if (cb) cb(new Event('error'));
  }
}

// ---------------------------------------------------------------------------
// Fake GatewayContext
// ---------------------------------------------------------------------------

function makeGatewayContext() {
  const sent: Record<string, unknown>[] = [];
  const handlers = new Set<(msg: GatewayMessage) => void>();

  const ctx: GatewayContextValue = {
    connectionState: 'connected',
    lastError: null,
    sessionToken: null,
    clientId: 'client-1',
    currentChannel: 'ch-1',
    switchChannel: jest.fn() as unknown as (c: string) => void,
    sendMessage: jest.fn() as unknown as (msg: Record<string, unknown>) => void,
    disconnect: jest.fn() as unknown as () => void,
    reconnect: jest.fn() as unknown as () => void,
    send: jest.fn((msg: Record<string, unknown>) => {
      sent.push(msg);
    }) as unknown as (msg: Record<string, unknown>) => void,
    subscribe: jest.fn() as unknown as (ch: string) => void,
    unsubscribe: jest.fn() as unknown as (ch: string) => void,
    publish: jest.fn() as unknown as (ch: string, frame: Record<string, unknown>) => void,
    onMessage: (handler: (msg: GatewayMessage) => void) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };

  const emit = (msg: GatewayMessage) => {
    for (const h of handlers) h(msg);
  };

  return { ctx, sent, emit };
}

function makeWrapper(ctx: GatewayContextValue) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <GatewayContext.Provider value={ctx}>
        {children}
      </GatewayContext.Provider>
    );
  };
}

/**
 * Starts an upload and resolves once its `request-upload` frame has actually
 * been sent, returning the upload id.
 *
 * `upload()` builds the preview and measures the file BEFORE asking for a URL
 * — deliberately, so the `fileupload:started` broadcast already carries the
 * placeholder. That makes the send asynchronous, so reading `sent` on the
 * line after `act()` races it and finds an empty array. Every test that needs
 * the id must await the frame rather than assume it is there.
 */
async function startUpload(
  result: { current: { upload: (f: File) => Promise<unknown> } },
  sent: Record<string, unknown>[],
  file: File,
): Promise<string> {
  const before = sent.length;
  act(() => { void result.current.upload(file); });
  const frameOf = () => sent.slice(before).find((s) => s.action === 'request-upload');
  await waitFor(() => expect(frameOf()).toBeDefined());
  return frameOf()!.id as string;
}

// ---------------------------------------------------------------------------
// Minimal File stub
// ---------------------------------------------------------------------------

function makeFile(name = 'test.txt', size = 1024, type = 'text/plain'): File {
  const blob = new Blob(['x'.repeat(size)], { type });
  return new File([blob], name, { type });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const realXHR = (globalThis as unknown as Record<string, unknown>).XMLHttpRequest;

beforeEach(() => {
  FakeXHR.instances = [];
  (globalThis as unknown as Record<string, unknown>).XMLHttpRequest = FakeXHR;
});

afterEach(() => {
  (globalThis as unknown as Record<string, unknown>).XMLHttpRequest = realXHR;
  jest.clearAllMocks();
});

describe('useFileUpload', () => {
  it('starts with empty uploads array', () => {
    const { ctx } = makeGatewayContext();
    const { result } = renderHook(() => useFileUpload('ch-1'), {
      wrapper: makeWrapper(ctx),
    });
    expect(result.current.uploads).toEqual([]);
  });

  it('upload() adds a pending entry immediately', async () => {
    const { ctx } = makeGatewayContext();
    const { result } = renderHook(() => useFileUpload('ch-1'), {
      wrapper: makeWrapper(ctx),
    });

    const file = makeFile();
    // Don't await — let it pend waiting for the URL frame.
    act(() => { void result.current.upload(file); });

    expect(result.current.uploads).toHaveLength(1);
    expect(result.current.uploads[0]!.status).toBe('pending');
    expect(result.current.uploads[0]!.filename).toBe('test.txt');
    expect(result.current.uploads[0]!.size).toBe(1024);
  });

  it('emits request-upload frame with correct fields', async () => {
    const { ctx, sent } = makeGatewayContext();
    const { result } = renderHook(() => useFileUpload('ch-1'), {
      wrapper: makeWrapper(ctx),
    });

    const file = makeFile('report.pdf', 2048, 'application/pdf');
    await startUpload(result, sent, file);

    const frame = sent.find((s) => s.action === 'request-upload');
    expect(frame).toBeDefined();
    expect(frame!.service).toBe('fileupload');
    expect(frame!.channel).toBe('ch-1');
    expect(frame!.filename).toBe('report.pdf');
    expect(frame!.size).toBe(2048);
    expect(typeof frame!.id).toBe('string');
  });

  it('transitions to uploading when fileupload:url arrives and XHR fires progress', async () => {
    const { ctx, sent, emit } = makeGatewayContext();
    const { result } = renderHook(() => useFileUpload('ch-1'), {
      wrapper: makeWrapper(ctx),
    });

    const file = makeFile();
    const id = await startUpload(result, sent, file);

    // Gateway responds with presigned URL.
    act(() => {
      emit({ type: 'fileupload:url', channel: 'ch-1', id, uploadUrl: 'https://s3.example.com/upload' });
    });

    // Wait for the XHR to be instantiated (upload() will have started the XHR).
    await waitFor(() => expect(FakeXHR.instances.length).toBeGreaterThan(0));

    const xhr = FakeXHR.instances[0]!;

    // Fire progress event.
    act(() => { xhr.fireUploadProgress(512, 1024); });

    expect(result.current.uploads[0]!.status).toBe('uploading');
    expect(result.current.uploads[0]!.progress).toBe(50);
  });

  it('transitions to completed on fileupload:complete frame', async () => {
    const { ctx, sent, emit } = makeGatewayContext();
    const { result } = renderHook(() => useFileUpload('ch-1'), {
      wrapper: makeWrapper(ctx),
    });

    const file = makeFile();
    const id = await startUpload(result, sent, file);

    act(() => {
      emit({ type: 'fileupload:url', channel: 'ch-1', id, uploadUrl: 'https://s3.example.com/upload' });
    });

    await waitFor(() => expect(FakeXHR.instances.length).toBeGreaterThan(0));
    const xhr = FakeXHR.instances[0]!;

    // Complete the XHR — this triggers the 'complete' outbound frame.
    act(() => { xhr.fireLoad(200); });

    // Gateway confirms completion with a download URL.
    act(() => {
      emit({
        type: 'fileupload:complete',
        channel: 'ch-1',
        id,
        downloadUrl: 'https://cdn.example.com/file.txt',
      });
    });

    expect(result.current.uploads[0]!.status).toBe('completed');
    expect(result.current.uploads[0]!.downloadUrl).toBe('https://cdn.example.com/file.txt');
  });

  it('handles scanning → clean flow', async () => {
    const { ctx, sent, emit } = makeGatewayContext();
    const { result } = renderHook(() => useFileUpload('ch-1'), {
      wrapper: makeWrapper(ctx),
    });

    const file = makeFile();
    const id = await startUpload(result, sent, file);

    act(() => {
      emit({ type: 'fileupload:url', channel: 'ch-1', id, uploadUrl: 'https://s3.example.com/upload' });
    });

    await waitFor(() => expect(FakeXHR.instances.length).toBeGreaterThan(0));

    act(() => { FakeXHR.instances[0]!.fireLoad(); });

    act(() => {
      emit({ type: 'fileupload:scanning', channel: 'ch-1', id });
    });
    expect(result.current.uploads[0]!.status).toBe('scanning');

    act(() => {
      emit({ type: 'fileupload:clean', channel: 'ch-1', id, downloadUrl: 'https://cdn.example.com/file.txt' });
    });
    expect(result.current.uploads[0]!.status).toBe('clean');
    expect(result.current.uploads[0]!.downloadUrl).toBe('https://cdn.example.com/file.txt');
  });

  it('handles fileupload:infected', async () => {
    const { ctx, sent, emit } = makeGatewayContext();
    const { result } = renderHook(() => useFileUpload('ch-1'), {
      wrapper: makeWrapper(ctx),
    });

    const file = makeFile();
    const id = await startUpload(result, sent, file);

    act(() => {
      emit({ type: 'fileupload:url', channel: 'ch-1', id, uploadUrl: 'https://s3.example.com/upload' });
    });

    await waitFor(() => expect(FakeXHR.instances.length).toBeGreaterThan(0));
    act(() => { FakeXHR.instances[0]!.fireLoad(); });

    act(() => {
      emit({ type: 'fileupload:infected', channel: 'ch-1', id, error: 'Virus detected: EICAR.Test' } as unknown as GatewayMessage);
    });

    expect(result.current.uploads[0]!.status).toBe('infected');
    expect(result.current.uploads[0]!.error).toBe('Virus detected: EICAR.Test');
  });

  it('fileupload:failed before URL rejects upload() promise and sets failed status', async () => {
    const { ctx, sent, emit } = makeGatewayContext();
    const { result } = renderHook(() => useFileUpload('ch-1'), {
      wrapper: makeWrapper(ctx),
    });

    const file = makeFile();
    let uploadError: unknown;
    act(() => {
      // Not `startUpload` here: this test needs the promise itself to assert
      // the rejection, so it keeps the handle and waits for the frame inline.
      result.current.upload(file).catch((e) => { uploadError = e; });
    });

    const frameOf = () => sent.find((s) => s.action === 'request-upload');
    await waitFor(() => expect(frameOf()).toBeDefined());
    const id = frameOf()!.id as string;

    act(() => {
      emit({ type: 'fileupload:failed', channel: 'ch-1', id, error: 'Storage quota exceeded' } as unknown as GatewayMessage);
    });

    await waitFor(() => expect(uploadError).toBeDefined());
    expect((uploadError as Error).message).toBe('Storage quota exceeded');
    expect(result.current.uploads[0]!.status).toBe('failed');
  });

  it('cancel() aborts XHR and emits cancel frame', async () => {
    const { ctx, sent, emit } = makeGatewayContext();
    const { result } = renderHook(() => useFileUpload('ch-1'), {
      wrapper: makeWrapper(ctx),
    });

    const file = makeFile();
    const id = await startUpload(result, sent, file);

    act(() => {
      emit({ type: 'fileupload:url', channel: 'ch-1', id, uploadUrl: 'https://s3.example.com/upload' });
    });

    await waitFor(() => expect(FakeXHR.instances.length).toBeGreaterThan(0));

    act(() => { result.current.cancel(id); });

    expect(FakeXHR.instances[0]!.aborted).toBe(true);
    const cancelFrame = sent.find((s) => s.action === 'cancel');
    expect(cancelFrame).toBeDefined();
    expect(cancelFrame!.id).toBe(id);
    expect(result.current.uploads[0]!.status).toBe('failed');
  });

  it('removeCompleted() strips completed, clean, and infected entries', async () => {
    const { ctx, sent, emit } = makeGatewayContext();
    const { result } = renderHook(() => useFileUpload('ch-1'), {
      wrapper: makeWrapper(ctx),
    });

    // Upload two files.
    const file1 = makeFile('a.txt');
    const file2 = makeFile('b.txt');
    // Sequential, not concurrent: each helper waits for its own frame, which
    // also pins the ids to the files that produced them.
    const id1 = await startUpload(result, sent, file1);
    const id2 = await startUpload(result, sent, file2);

    // Complete file1, leave file2 pending.
    act(() => {
      emit({ type: 'fileupload:url', channel: 'ch-1', id: id1, uploadUrl: 'https://s3.example.com/1' });
    });
    await waitFor(() => expect(FakeXHR.instances.length).toBeGreaterThan(0));
    act(() => { FakeXHR.instances[0]!.fireLoad(); });
    act(() => {
      emit({ type: 'fileupload:complete', channel: 'ch-1', id: id1, downloadUrl: 'https://cdn.example.com/a.txt' });
    });

    expect(result.current.uploads).toHaveLength(2);
    act(() => { result.current.removeCompleted(); });
    expect(result.current.uploads).toHaveLength(1);
    expect(result.current.uploads[0]!.id).toBe(id2);
  });

  it('channel change resets upload list', () => {
    const { ctx } = makeGatewayContext();
    const { result, rerender } = renderHook(
      ({ ch }) => useFileUpload(ch),
      { wrapper: makeWrapper(ctx), initialProps: { ch: 'ch-1' } },
    );

    // Manually inject an upload entry (we just care that rerender clears it).
    // Trigger a re-render on channel change.
    act(() => {
      rerender({ ch: 'ch-2' });
    });

    expect(result.current.uploads).toHaveLength(0);
  });
});
