import {
  attachTranscriptAsComment,
  evaluateAttach,
} from '../../../src/client/voice/commentSink';
import { buildContextFrame } from '../../../src/client/voice/contextFrame';
import type { TranscriptReadyEvent } from '../../../src/client/voice/transcriptBus';

const doc = { entityType: 'document', entityId: 'doc-1' };

function event(overrides: Partial<TranscriptReadyEvent> = {}): TranscriptReadyEvent {
  const sample = { route: doc, focusedSectionId: 'sec-A' };
  return {
    utteranceId: 'utt-1',
    captureId: 'cap-1',
    text: 'this header should say quarterly',
    t0_ms: 1000,
    t1_ms: 4000,
    context: buildContextFrame({ start: sample, end: sample, t0_ms: 1000, t1_ms: 4000 }),
    outcome: 'settled',
    lines: [{ seq: 1, text: 'this header should say quarterly' }],
    speechMs: 2600,
    ...overrides,
  };
}

describe('evaluateAttach — refusals are the feature', () => {
  it('allows a clean, unsplit, section-targeted utterance', () => {
    expect(evaluateAttach(event())).toEqual({ ok: true });
  });

  it('refuses when the context moved mid-utterance', () => {
    const split = buildContextFrame({
      start: { route: doc, focusedSectionId: 'sec-A' },
      end: { route: doc, focusedSectionId: 'sec-B' },
      t0_ms: 1000,
      t1_ms: 4000,
    });
    const verdict = evaluateAttach(event({ context: split }));
    expect(verdict).toMatchObject({ ok: false, reason: 'context-split' });
  });

  it('allows a split utterance only once a human confirms the target', () => {
    const split = buildContextFrame({
      start: { route: doc, focusedSectionId: 'sec-A' },
      end: { route: doc, focusedSectionId: 'sec-B' },
      t0_ms: 1000,
      t1_ms: 4000,
    });
    expect(evaluateAttach(event({ context: split }), true)).toEqual({ ok: true });
  });

  it('refuses when nothing addressable was on screen', () => {
    const none = buildContextFrame({ start: {}, end: {}, t0_ms: 1, t1_ms: 2 });
    expect(evaluateAttach(event({ context: none }))).toMatchObject({
      ok: false,
      reason: 'not-a-document',
    });
  });

  it('refuses a lost transcript instead of writing an empty comment', () => {
    expect(evaluateAttach(event({ outcome: 'lost', text: '' }))).toMatchObject({
      ok: false,
      reason: 'transcript-lost',
    });
  });

  it('refuses an empty transcript', () => {
    expect(evaluateAttach(event({ text: '  ' }))).toMatchObject({
      ok: false,
      reason: 'empty-transcript',
    });
  });
});

describe('attachTranscriptAsComment', () => {
  it('POSTs to the existing document-comments endpoint with the latched section', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return {
        ok: true,
        status: 201,
        json: async () => ({ comment: { commentId: 'c-1' } }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const result = await attachTranscriptAsComment(event(), {
      apiBaseUrl: 'http://api.test',
      authToken: 'tok',
      fetchImpl: fakeFetch,
    });

    expect(result).toEqual({
      attached: true,
      commentId: 'c-1',
      sectionId: 'sec-A',
      documentId: 'doc-1',
    });
    expect(calls[0]!.url).toBe('http://api.test/api/documents/doc-1/comments');
    expect(calls[0]!.body).toEqual({
      sectionId: 'sec-A',
      text: 'this header should say quarterly',
    });
  });

  it('does not call the API at all when the verdict refuses', async () => {
    const fakeFetch = (() => {
      throw new Error('must not be called');
    }) as unknown as typeof fetch;
    const none = buildContextFrame({ start: {}, end: {}, t0_ms: 1, t1_ms: 2 });
    const result = await attachTranscriptAsComment(event({ context: none }), {
      authToken: 'tok',
      fetchImpl: fakeFetch,
    });
    expect(result).toMatchObject({ attached: false, reason: 'not-a-document' });
  });
});
