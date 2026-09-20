import { nodeReferenceFixture, workGraphFixtureIds } from '../../src/work-graph/fixtures';
import { decodeAnyWorkReference, decodeWorkReference, encodeWorkReference, encodeWorkReferenceV2 } from '../../src/work-graph/references';

describe('work references', () => {
  test('round-trips a node reference', () => {
    expect(decodeWorkReference(encodeWorkReference(nodeReferenceFixture))).toEqual(nodeReferenceFixture);
  });

  test('round-trips an edge reference', () => {
    const edge = { ...nodeReferenceFixture, target: { kind: 'edge' as const, id: workGraphFixtureIds.edge } };
    expect(decodeWorkReference(encodeWorkReference(edge))).toEqual(edge);
  });

  test.each(['', 'wg2.aaaa', 'wg1.***', 'wg1.e30'])('rejects malformed or unsupported tokens', (value) => {
    expect(() => decodeWorkReference(value)).toThrow(RangeError);
  });

  test('rejects unsupported fields instead of serializing private metadata', () => {
    expect(() => encodeWorkReference({
      ...nodeReferenceFixture,
      label: 'Private title',
      sourceUrl: 'https://private.example/item',
      credential: 'secret',
    } as typeof nodeReferenceFixture)).toThrow(RangeError);
  });

  test('contains no copied labels, URLs, or credentials', () => {
    const token = encodeWorkReference(nodeReferenceFixture);
    expect(token).not.toContain('Private');
    expect(token).not.toContain('http');
    expect(token).not.toContain('secret');
  });
});


describe('upgraded work reference reader', () => {
  test('round-trips an exact artifact revision and anchor while preserving v1 compatibility', () => {
    const reference = { ...nodeReferenceFixture, version: 2 as const, target: { kind: 'node' as const, id: 'deck', revisionId: 'revision-2', anchor: { kind: 'slide' as const, id: 'slide-4' } } };
    const encoded = encodeWorkReferenceV2(reference);
    expect(decodeAnyWorkReference(encoded)).toEqual(reference);
    expect(decodeAnyWorkReference(encodeWorkReference(nodeReferenceFixture))).toEqual(nodeReferenceFixture);
    expect(() => decodeWorkReference(encoded)).toThrow(RangeError);
    expect(() => decodeAnyWorkReference(encoded.replace('wg2.', 'wg1.'))).toThrow(RangeError);
    expect(() => encodeWorkReferenceV2({ ...reference, label: 'Private' } as typeof reference)).toThrow(RangeError);
  });
  test.each(['wg2.***', 'wg2.e30', 'wg3.aaaa', `wg2.${'a'.repeat(3000)}`])('rejects malformed v2 token %s', (value) => {
    expect(() => decodeAnyWorkReference(value)).toThrow(RangeError);
  });
});
