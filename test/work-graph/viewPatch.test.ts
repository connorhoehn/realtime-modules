import {
  applyWorkGraphViewPatchV2,
  diffWorkGraphViewV2,
  type WorkGraphStreamViewV2,
} from '../../src/work-graph/viewPatch';

const at = '2026-09-21T13:30:00.000Z';

function view(details: string[], efforts: string[] = ['e1', 'e2']): WorkGraphStreamViewV2 {
  return {
    query: { schemaVersion: 2, personId: 'p', day: '2026-09-21', timezone: 'UTC', windowStart: '2026-09-21T00:00:00.000Z', windowEnd: at, mode: 'live' },
    temporal: { mode: 'live', observedAt: at, coverage: { from: '2026-09-21T00:00:00.000Z', through: at, complete: true } },
    efforts: efforts.map((id) => ({ id, anchorNodeId: id, title: `Effort ${id}`, nodeIds: [id], edgeIds: [], contextNodeIds: [] })),
    details: details.map((id) => ({ nodeId: id, summary: `Summary of ${id} `.repeat(20), lines: ['one', 'two'] })),
    operations: [],
    eventBuckets: [{ at, count: details.length }],
  };
}

describe('work-graph view patch (NFR #66)', () => {
  test('an unchanged list is left out; a changed entry is the only one sent', () => {
    const base = view(Array.from({ length: 50 }, (_, i) => `n${i}`));
    const next = structuredClone(base);
    next.details[7] = { ...next.details[7]!, summary: 'edited' };
    const patch = diffWorkGraphViewV2(base, next, 11);
    expect(patch.baseWatermark).toBe(11);
    expect(patch.efforts).toBeUndefined();
    expect(patch.details).toEqual({ upsert: [next.details[7]], remove: [] });
    expect(JSON.stringify(patch).length).toBeLessThan(JSON.stringify(next).length / 20);
    expect(applyWorkGraphViewPatchV2(base, patch)).toEqual(next);
  });

  test('additions, removals and reorders round-trip exactly', () => {
    const base = view(['a', 'b', 'c', 'd'], ['e1', 'e2', 'e3']);
    const next = view(['new', 'c', 'a', 'd'], ['e3', 'e1']);
    next.details[1] = { ...next.details[1]!, lines: ['changed'] };
    const patch = diffWorkGraphViewV2(base, next, 5);
    expect(patch.details?.remove).toEqual(['b']);
    expect(patch.details?.order).toEqual(['new', 'c', 'a', 'd']);
    expect(patch.efforts?.remove).toEqual(['e2']);
    expect(applyWorkGraphViewPatchV2(base, patch)).toEqual(next);
  });

  test('an append in order needs no order list', () => {
    const base = view(['a', 'b']);
    const next = view(['a', 'b', 'c']);
    const patch = diffWorkGraphViewV2(base, next, 1);
    expect(patch.details?.order).toBeUndefined();
    expect(applyWorkGraphViewPatchV2(base, patch)).toEqual(next);
  });

  test('a patch that does not fit its base is refused, not guessed', () => {
    const base = view(['a', 'b']);
    const patch = diffWorkGraphViewV2(base, view(['b', 'a']), 1);
    expect(applyWorkGraphViewPatchV2(view(['a', 'b', 'x']), patch)).toBeNull();
    expect(applyWorkGraphViewPatchV2(base, { ...patch, details: { upsert: 'x', remove: [] } as never })).toBeNull();
  });
});
