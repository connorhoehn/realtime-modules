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
    // Indices into the list upsert/remove produced: [a, c, d, new] -> [new, c, a, d].
    expect(patch.details?.order).toEqual([3, 1, 0, 2]);
    expect(patch.efforts?.remove).toEqual(['e2']);
    expect(applyWorkGraphViewPatchV2(base, patch)).toEqual(next);
  });

  test('an edited entry moving to the top costs one entry plus indices, and buckets travel as a change', () => {
    const ids = Array.from({ length: 60 }, (_, i) => `wg_node_${String(i).padStart(64, '0')}`);
    const base = view(ids);
    base.eventBuckets = Array.from({ length: 40 }, (_, i) => ({ at: new Date(Date.parse(at) - (40 - i) * 60_000).toISOString(), count: i }));
    const next = structuredClone(base);
    const [moved] = next.details.splice(30, 1);
    next.details.unshift({ ...moved!, lines: ['rev 66'] });
    next.eventBuckets[39] = { ...next.eventBuckets[39]!, count: 99 };
    const patch = diffWorkGraphViewV2(base, next, 1);
    expect(patch.details?.upsert).toHaveLength(1);
    expect(patch.eventBuckets).toEqual({ upsert: [next.eventBuckets[39]], remove: [] });
    expect(JSON.stringify(patch.details?.order).length).toBeLessThan(300);
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
    expect(applyWorkGraphViewPatchV2(base, { ...patch, details: { upsert: [], remove: [], order: [0, 0] } })).toBeNull();
  });
});
