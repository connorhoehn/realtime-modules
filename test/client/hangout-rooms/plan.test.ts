import { parseHangoutPlanInput, HangoutPlanValidationError, updateRoom } from '../../../src/hangout-rooms';
import cases from '../../fixtures/hangout-plan-cases.json';

test.each(cases)('$name', ({ input, valid }) => {
  if (valid) {
    const result = parseHangoutPlanInput(input);
    expect(result.expectedVersion).toBe((input as { expectedVersion: number }).expectedVersion);
    expect(result).not.toHaveProperty('updatedBy');
    expect(result).not.toHaveProperty('updatedAt');
    expect(result).not.toHaveProperty('version');
    for (const room of result.rooms) expect(room.name).toBe(room.name.trim());
  } else expect(() => parseHangoutPlanInput(input)).toThrow(HangoutPlanValidationError);
});

test('the parser rejects sparse arrays and does not share mutable input arrays', () => {
  const input = { expectedVersion: 0, mode: 'assigned', allowReturnToMain: true, rooms: [{ id: 'a', name: 'A', members: ['alice'] }] };
  const result = parseHangoutPlanInput(input);
  input.rooms[0]!.members.push('bob');
  expect(result.rooms[0]!.members).toEqual(['alice']);
  expect(() => parseHangoutPlanInput({ ...input, rooms: new Array(1) })).toThrow();
  expect(() => parseHangoutPlanInput({ ...input, rooms: [{ ...input.rooms[0], members: new Array(1) }] })).toThrow();
});

test.each([true, false])('the pure REST update preserves the saved plan (wrapped=%s)', async wrapped => {
  const plan = { version: 1, mode: 'assigned' as const, allowReturnToMain: true, rooms: [], updatedAt: '2026-10-26T00:00:00Z', updatedBy: 'owner' };
  const room = { roomId: 'room-1', plan };
  const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(wrapped ? { room } : room), { status: 200 }));
  try {
    const input = { expectedVersion: 0, mode: 'assigned' as const, allowReturnToMain: true, rooms: [] };
    expect(await updateRoom({ baseUrl: 'https://example.invalid' }, 'design studio', { plan: input })).toEqual(room);
    expect(fetch).toHaveBeenCalledWith('https://example.invalid/api/rooms/design%20studio', expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ plan: input }) }));
  } finally { fetch.mockRestore(); }
});
