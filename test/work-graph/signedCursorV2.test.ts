import { describe, expect, it } from '@jest/globals';
import type { WorkGraphQueryScope } from '../../src/work-graph/contracts';
import type { WorkGraphQueryV2 } from '../../src/work-graph/contractsV2';
import { WorkGraphCursorCodec, WorkGraphCursorError } from '../../src/work-graph/signedCursor';

const secret = 'a-local-test-secret-of-at-least-32-bytes';
const scope: WorkGraphQueryScope = {
  organizationId: 'org-1', viewerId: 'frank', personId: 'connor',
  day: '2026-09-21', timezone: 'America/New_York', policyRevision: 'policy-1',
};
const query: WorkGraphQueryV2 = {
  schemaVersion: 2, personId: 'connor', day: '2026-09-21', timezone: 'America/New_York',
  windowStart: '2026-09-21T13:15:00.000Z', windowEnd: '2026-09-21T13:30:00.000Z', mode: 'live',
};
const input = {
  scope, query,
  partitions: [{ utcDay: '2026-09-21', watermark: 12 }, { utcDay: '2026-09-22', watermark: 3 }],
  observationWatermark: 15,
  subscriptionGeneration: 'gen-1',
};

describe('composite v2 work graph cursor', () => {
  it('round-trips the bound query and per-partition watermarks', () => {
    const codec = new WorkGraphCursorCodec({ secret });
    const claims = codec.verifyV2(codec.issueV2(input), scope, query);
    expect(claims.schemaVersion).toBe(2);
    expect(claims.partitions).toEqual(input.partitions);
    expect(claims.observationWatermark).toBe(15);
    expect(claims.query).toEqual(query);
  });

  it('keeps the two versions separate in both directions', () => {
    const codec = new WorkGraphCursorCodec({ secret });
    const v1 = codec.issue({ scope, watermark: 15, subscriptionGeneration: 'gen-1' });
    const v2 = codec.issueV2(input);
    expect(() => codec.verify(v2)).toThrow(WorkGraphCursorError);
    expect(() => codec.verifyV2(v1)).toThrow(WorkGraphCursorError);
  });

  it('cannot be replayed against another viewer, policy revision or interval', () => {
    const codec = new WorkGraphCursorCodec({ secret });
    const token = codec.issueV2(input);
    expect(() => codec.verifyV2(token, { ...scope, viewerId: 'someone-else' })).toThrow(/scope-mismatch/);
    expect(() => codec.verifyV2(token, { ...scope, policyRevision: 'policy-2' })).toThrow(/scope-mismatch/);
    expect(() => codec.verifyV2(token, scope, { ...query, windowStart: '2026-09-21T13:00:00.000Z' })).toThrow(/scope-mismatch/);
  });

  it('rejects a tampered payload, an unsigned token and an expired one', () => {
    const codec = new WorkGraphCursorCodec({ secret });
    const token = codec.issueV2(input);
    const [prefix, payload, signature] = token.split('.');
    const tampered = Buffer.from(JSON.stringify({
      ...JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
      observationWatermark: 9_999,
    }), 'utf8').toString('base64url');
    expect(() => codec.verifyV2(`${prefix}.${tampered}.${signature}`)).toThrow(/invalid-signature/);
    expect(() => codec.verifyV2(`${prefix}.${payload}`)).toThrow(/malformed/);

    let clock = Date.parse('2026-09-21T13:30:00.000Z');
    const expiring = new WorkGraphCursorCodec({ secret, now: () => clock });
    const short = expiring.issueV2(input);
    clock += 16 * 60 * 1_000;
    expect(() => expiring.verifyV2(short)).toThrow(/expired/);
  });

  it('refuses claims that do not describe one real local day', () => {
    const codec = new WorkGraphCursorCodec({ secret });
    expect(() => codec.issueV2({ ...input, partitions: [] })).toThrow(/one or two UTC partitions/);
    expect(() => codec.issueV2({ ...input, query: { ...query, windowEnd: query.windowStart } })).toThrow(/valid v2 work graph query/);
  });
});
