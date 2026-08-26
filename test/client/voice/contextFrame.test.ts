// The context ladder is the load-bearing rule of ambient capture, so these
// tests assert the REFUSALS as hard as the successes. A test suite that only
// checks the happy path would pass just as well against a system that guesses.

import {
  buildContextFrame,
  resolveTier,
  resolveAnchor,
  type CaptureContextSample,
} from '../../../src/client/voice/contextFrame';

const doc: CaptureContextSample['route'] = { entityType: 'document', entityId: 'doc-1' };

describe('resolveTier — the ladder, in order', () => {
  it('prefers an explicit selection over everything below it', () => {
    const rung = resolveTier({
      route: doc,
      selection: { sectionId: 'sec-A', quote: 'quarterly' },
      focusedSectionId: 'sec-B',
      viewport: [{ sectionId: 'sec-C', ratio: 1 }],
    });
    expect(rung.tier).toBe('selection');
    expect(rung.sectionId).toBe('sec-A');
  });

  it('falls to focused section when nothing is selected', () => {
    const rung = resolveTier({
      route: doc,
      focusedSectionId: 'sec-B',
      viewport: [{ sectionId: 'sec-C', ratio: 1 }],
    });
    expect(rung.tier).toBe('section');
    expect(rung.sectionId).toBe('sec-B');
  });

  it('uses the viewport only when ONE section dominates it', () => {
    const dominant = resolveTier({ route: doc, viewport: [{ sectionId: 'sec-C', ratio: 0.8 }] });
    expect(dominant.tier).toBe('viewport');
    expect(dominant.sectionId).toBe('sec-C');
  });

  it('refuses to pick a section when two share the viewport', () => {
    // 55/45 is exactly the case a "closest match" heuristic gets wrong, and
    // getting it wrong means the remark lands on the wrong paragraph.
    const split = resolveTier({
      route: doc,
      viewport: [
        { sectionId: 'sec-C', ratio: 0.55 },
        { sectionId: 'sec-D', ratio: 0.45 },
      ],
    });
    expect(split.tier).toBe('route');
    expect(split.sectionId).toBeUndefined();
  });

  it('returns none when nothing addressable is on screen', () => {
    expect(resolveTier({}).tier).toBe('none');
  });
});

describe('buildContextFrame — latch at start, never re-decide', () => {
  const start: CaptureContextSample = { route: doc, focusedSectionId: 'sec-A' };
  const moved: CaptureContextSample = { route: doc, focusedSectionId: 'sec-B' };

  it('takes the target from the START sample even when the end moved', () => {
    const frame = buildContextFrame({ start, end: moved, t0_ms: 1000, t1_ms: 4000 });
    expect(frame.sectionId).toBe('sec-A');
    expect(frame.endSectionId).toBe('sec-B');
  });

  it('sets contextSplit and withholds autoAttach when the context moved', () => {
    const frame = buildContextFrame({ start, end: moved, t0_ms: 1000, t1_ms: 4000 });
    expect(frame.contextSplit).toBe(true);
    expect(frame.autoAttach).toBe(false);
  });

  it('auto-attaches when the span stayed put', () => {
    const frame = buildContextFrame({ start, end: start, t0_ms: 1000, t1_ms: 4000 });
    expect(frame.contextSplit).toBe(false);
    expect(frame.autoAttach).toBe(true);
  });

  it('treats navigating to another document as a split', () => {
    const frame = buildContextFrame({
      start,
      end: { route: { entityType: 'document', entityId: 'doc-2' }, focusedSectionId: 'sec-A' },
      t0_ms: 1,
      t1_ms: 2,
    });
    expect(frame.contextSplit).toBe(true);
    expect(frame.entityId).toBe('doc-1');
  });

  it('never auto-attaches a "none" target even when start and end agree', () => {
    const frame = buildContextFrame({ start: {}, end: {}, t0_ms: 1, t1_ms: 2 });
    expect(frame.tier).toBe('none');
    expect(frame.contextSplit).toBe(false);
    expect(frame.autoAttach).toBe(false);
  });

  it('carries the anchor triple and the utterance span', () => {
    const frame = buildContextFrame({
      start: {
        route: doc,
        selection: { sectionId: 'sec-A', quote: 'monthly', relPos: 'yrel:abc' },
      },
      end: { route: doc, selection: { sectionId: 'sec-A', quote: 'monthly', relPos: 'yrel:abc' } },
      t0_ms: 1_700_000_000_000,
      t1_ms: 1_700_000_003_400,
    });
    expect(frame.anchor).toEqual({ relPos: 'yrel:abc', sectionId: 'sec-A', quote: 'monthly' });
    expect(frame.confidence).toBe('exact');
    expect(frame.documentId).toBe('doc-1');
    expect(frame.t1_ms - frame.t0_ms).toBe(3400);
  });

  it('maps each tier to a distinct confidence', () => {
    const tiers: Array<[CaptureContextSample, string]> = [
      [{ route: doc, selection: { sectionId: 's' } }, 'exact'],
      [{ route: doc, focusedSectionId: 's' }, 'high'],
      [{ route: doc, viewport: [{ sectionId: 's', ratio: 0.9 }] }, 'medium'],
      [{ route: doc }, 'low'],
      [{}, 'none'],
    ];
    for (const [sample, confidence] of tiers) {
      const frame = buildContextFrame({ start: sample, end: sample, t0_ms: 0, t1_ms: 1 });
      expect(frame.confidence).toBe(confidence);
    }
  });
});

describe('resolveAnchor — degrades relPos -> sectionId -> quote', () => {
  const anchor = { relPos: 'r', sectionId: 's', quote: 'q' };

  it('stops at the first rung that resolves', () => {
    expect(
      resolveAnchor(anchor, {
        byRelPos: () => 'from-relpos',
        bySectionId: () => 'from-section',
        byQuote: () => 'from-quote',
      }),
    ).toEqual({ value: 'from-relpos', via: 'relPos' });
  });

  it('falls through when a rung cannot resolve', () => {
    expect(
      resolveAnchor(anchor, {
        byRelPos: () => null,
        bySectionId: () => null,
        byQuote: () => 'from-quote',
      }),
    ).toEqual({ value: 'from-quote', via: 'quote' });
  });

  it('returns null rather than guessing when every rung is dead', () => {
    expect(resolveAnchor(anchor, { byRelPos: () => null })).toBeNull();
  });
});
