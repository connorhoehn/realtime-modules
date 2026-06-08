// realtime-modules/test/client/GatewayProvider.test.ts
//
// Covers the outbound awareness frame contract: when the local awareness
// state has `user.mode` and `user.idle`, those fields must be forwarded as
// top-level WS frame fields so the server's CRDTService.handleAwareness can
// pass them straight to DocumentPresenceService without decoding the binary
// Y.js blob.

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import * as Y from 'yjs';
import { GatewayProvider } from '../../src/client/GatewayProvider';

describe('GatewayProvider awareness send', () => {
  let doc: Y.Doc;
  let sendMessage: jest.Mock;
  let provider: GatewayProvider;

  beforeEach(() => {
    jest.useFakeTimers();
    doc = new Y.Doc();
    sendMessage = jest.fn();
    provider = new GatewayProvider(doc, 'doc:test', sendMessage);
    // Drain the doc-update echo from provider construction (none expected,
    // but defensive).
    sendMessage.mockClear();
  });

  function awarenessSends() {
    return sendMessage.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .filter((m) => m.action === 'awareness');
  }

  it('omits mode and idle from the frame when local state has neither', () => {
    provider.awareness.setLocalStateField('user', {
      userId: 'u-1',
      displayName: 'Alice',
      color: '#ff0000',
    });
    jest.advanceTimersByTime(100);

    const sends = awarenessSends();
    expect(sends).toHaveLength(1);
    const msg = sends[0];
    expect(msg.service).toBe('crdt');
    expect(msg.channel).toBe('doc:test');
    expect(typeof msg.update).toBe('string');
    expect('mode' in msg).toBe(false);
    expect('idle' in msg).toBe(false);
  });

  it('forwards mode as a top-level frame field when present', () => {
    provider.awareness.setLocalStateField('user', {
      userId: 'u-1',
      displayName: 'Alice',
      color: '#ff0000',
      mode: 'reviewer',
    });
    jest.advanceTimersByTime(100);

    const sends = awarenessSends();
    expect(sends.length).toBeGreaterThanOrEqual(1);
    const msg = sends[sends.length - 1];
    expect(msg.mode).toBe('reviewer');
    expect('idle' in msg).toBe(false);
  });

  it('forwards idle as a top-level frame field when present', () => {
    provider.awareness.setLocalStateField('user', {
      userId: 'u-1',
      displayName: 'Alice',
      color: '#ff0000',
      idle: true,
    });
    jest.advanceTimersByTime(100);

    const sends = awarenessSends();
    expect(sends.length).toBeGreaterThanOrEqual(1);
    const msg = sends[sends.length - 1];
    expect(msg.idle).toBe(true);
    expect('mode' in msg).toBe(false);
  });

  it('forwards both mode and idle when both are present', () => {
    provider.awareness.setLocalStateField('user', {
      userId: 'u-1',
      displayName: 'Alice',
      color: '#ff0000',
      mode: 'reader',
      idle: false,
    });
    jest.advanceTimersByTime(100);

    const sends = awarenessSends();
    const msg = sends[sends.length - 1];
    expect(msg.mode).toBe('reader');
    expect(msg.idle).toBe(false);
  });

  it('debounces multiple rapid updates into a single send (50ms)', () => {
    provider.awareness.setLocalStateField('user', { mode: 'editor', idle: false });
    provider.awareness.setLocalStateField('user', { mode: 'reviewer', idle: false });
    provider.awareness.setLocalStateField('user', { mode: 'reader', idle: true });

    // Before the 50ms debounce, no send yet.
    jest.advanceTimersByTime(40);
    expect(awarenessSends()).toHaveLength(0);

    // After the debounce window, exactly one send with the LAST state.
    jest.advanceTimersByTime(20);
    const sends = awarenessSends();
    expect(sends).toHaveLength(1);
    expect(sends[0].mode).toBe('reader');
    expect(sends[0].idle).toBe(true);
  });

  it('rejects non-string mode and non-boolean idle (defensive typing)', () => {
    provider.awareness.setLocalStateField('user', {
      userId: 'u-1',
      // Invalid types — must not appear on the wire.
      mode: 42 as unknown as string,
      idle: 'yes' as unknown as boolean,
    });
    jest.advanceTimersByTime(100);

    const sends = awarenessSends();
    expect(sends.length).toBeGreaterThanOrEqual(1);
    const msg = sends[sends.length - 1];
    expect('mode' in msg).toBe(false);
    expect('idle' in msg).toBe(false);
  });
});
