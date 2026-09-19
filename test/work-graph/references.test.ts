import { nodeReferenceFixture, workGraphFixtureIds } from '../../src/work-graph/fixtures';
import { decodeWorkReference, encodeWorkReference } from '../../src/work-graph/references';

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
