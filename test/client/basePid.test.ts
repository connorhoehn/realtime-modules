import { basePidOf, SCREEN_PID_SUFFIX } from '../../src/client/video/lib/basePid';

describe('basePidOf', () => {
  it('strips only the screen suffix', () => {
    expect(SCREEN_PID_SUFFIX).toBe(':screen');
    expect(basePidOf('hank')).toBe('hank');
    expect(basePidOf('hank:screen')).toBe('hank');
  });
  it('keeps an id that holds a colon whole (an interview guest\'s media id)', () => {
    expect(basePidOf('guest:inv-0001-k3j2')).toBe('guest:inv-0001-k3j2');
    expect(basePidOf('guest:inv-0001-k3j2:screen')).toBe('guest:inv-0001-k3j2');
    expect(basePidOf('guest:inv-0001-k3j2')).not.toBe(basePidOf('guest:inv-0002-k3j2'));
  });
  it('strips the suffix once, and only at the end', () => {
    expect(basePidOf('a:screen:screen')).toBe('a:screen');
    expect(basePidOf('screen:a')).toBe('screen:a');
  });
});
