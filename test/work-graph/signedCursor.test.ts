import { WorkGraphCursorCodec, WorkGraphCursorError } from '../../src/work-graph/signedCursor';

const scope = {
  organizationId: 'org-1', viewerId: 'viewer-1', personId: 'person-1',
  day: '2026-09-19', timezone: 'America/New_York', policyRevision: 'policy-1',
};

describe('shared work graph cursor codec', () => {
  test('round-trips a scope-bound cursor and rejects scope reuse', () => {
    const codec = new WorkGraphCursorCodec({ secret: 'x'.repeat(32), now: () => Date.parse('2026-09-19T20:00:00Z') });
    const token = codec.issue({ scope, watermark: 7, subscriptionGeneration: 'generation-1' });
    expect(codec.verify(token, scope)).toMatchObject({ watermark: 7, ...scope });
    expect(() => codec.verify(token, { ...scope, viewerId: 'viewer-2' }))
      .toThrow(expect.objectContaining<Partial<WorkGraphCursorError>>({ reason: 'scope-mismatch' }));
  });
});
