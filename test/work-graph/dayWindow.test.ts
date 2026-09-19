import { intervalOverlapsWorkDay, workDayWindow } from '../../src/work-graph/dayWindow';

describe('workDayWindow', () => {
  test('resolves a 23-hour daylight-saving day', () => {
    const window = workDayWindow('2026-03-08', 'America/New_York');
    expect(window).toMatchObject({
      start: '2026-03-08T05:00:00.000Z',
      end: '2026-03-09T04:00:00.000Z',
      durationMs: 23 * 60 * 60 * 1_000,
    });
  });

  test('resolves a 25-hour daylight-saving day', () => {
    const window = workDayWindow('2026-11-01', 'America/New_York');
    expect(window).toMatchObject({
      start: '2026-11-01T04:00:00.000Z',
      end: '2026-11-02T05:00:00.000Z',
      durationMs: 25 * 60 * 60 * 1_000,
    });
  });

  test.each([
    ['2026-02-30', 'America/New_York'],
    ['19-09-2026', 'America/New_York'],
    ['2026-09-19', 'Mars/Olympus_Mons'],
  ])('rejects invalid day/timezone input', (day, timezone) => {
    expect(() => workDayWindow(day, timezone)).toThrow(RangeError);
  });
});

describe('intervalOverlapsWorkDay', () => {
  const window = workDayWindow('2026-09-19', 'America/New_York');

  test('includes a session spanning midnight', () => {
    expect(intervalOverlapsWorkDay('2026-09-19T03:30:00.000Z', '2026-09-19T05:00:00.000Z', window)).toBe(true);
  });

  test('includes ongoing work started yesterday', () => {
    expect(intervalOverlapsWorkDay('2026-09-18T18:00:00.000Z', undefined, window)).toBe(true);
  });

  test('uses half-open day boundaries', () => {
    expect(intervalOverlapsWorkDay('2026-09-18T20:00:00.000Z', window.start, window)).toBe(false);
    expect(intervalOverlapsWorkDay(window.end, undefined, window)).toBe(false);
  });
});
