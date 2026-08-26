import { UtteranceAggregator } from '../../../src/client/voice/utteranceAggregator';

const T0 = 1_000_000;

describe('UtteranceAggregator — rejoining the sidecar\'s 3-second slices', () => {
  it('joins lines in seq order, not arrival order', () => {
    // The relay is fan-out over Redis pub/sub; nothing guarantees ordering.
    const agg = new UtteranceAggregator(T0);
    agg.accept({ seq: 2, text: 'not monthly' }, T0 + 100);
    agg.accept({ seq: 1, text: 'it should say quarterly' }, T0 + 200);
    expect(agg.currentText()).toBe('it should say quarterly not monthly');
  });

  it('does not finalize while the audio is still open', () => {
    // A person pausing mid-sentence must not become two comments.
    const agg = new UtteranceAggregator(T0);
    agg.accept({ seq: 1, text: 'hold on' }, T0 + 100);
    expect(agg.evaluate(T0 + 60_000)).toBeNull();
  });

  it('settles once the lines stop arriving after release', () => {
    const agg = new UtteranceAggregator(T0);
    agg.accept({ seq: 1, text: 'the header is wrong' }, T0 + 100);
    agg.closeAudio(T0 + 200);
    expect(agg.evaluate(T0 + 500)).toBeNull();
    const done = agg.evaluate(T0 + 2000);
    expect(done?.outcome).toBe('settled');
    expect(done?.text).toBe('the header is wrong');
  });

  it('keeps waiting while lines are still trickling in', () => {
    const agg = new UtteranceAggregator(T0);
    agg.closeAudio(T0);
    agg.accept({ seq: 1, text: 'a' }, T0 + 500);
    expect(agg.evaluate(T0 + 1000)).toBeNull();
    agg.accept({ seq: 2, text: 'b' }, T0 + 1400);
    expect(agg.evaluate(T0 + 2000)).toBeNull();
    expect(agg.evaluate(T0 + 2700)?.outcome).toBe('settled');
  });

  it('reports LOST when speech was sent and no transcript ever came back', () => {
    // This is the only observable signal that the sidecar's bounded ASR queue
    // dropped the window — it has no metrics endpoint. Silently reporting
    // "you said nothing" would hide a real data loss.
    const agg = new UtteranceAggregator(T0);
    agg.addSpeechMs(1800);
    agg.closeAudio(T0);
    const done = agg.evaluate(T0 + 9000);
    expect(done?.outcome).toBe('lost');
    expect(done?.text).toBe('');
    expect(done?.speechMs).toBe(1800);
  });

  it('reports SILENT (not lost) when no speech was detected either', () => {
    const agg = new UtteranceAggregator(T0);
    agg.addSpeechMs(100);
    agg.closeAudio(T0);
    expect(agg.evaluate(T0 + 2000)?.outcome).toBe('silent');
  });

  it('reports TIMEOUT with partial text when lines never stop', () => {
    const agg = new UtteranceAggregator(T0, { maxWaitMs: 3000, settleMs: 5000 });
    agg.closeAudio(T0);
    agg.accept({ seq: 1, text: 'partial' }, T0 + 2900);
    const done = agg.evaluate(T0 + 3100);
    expect(done?.outcome).toBe('timeout');
    expect(done?.text).toBe('partial');
  });

  it('replaces a duplicated seq rather than doubling the words', () => {
    const agg = new UtteranceAggregator(T0);
    agg.accept({ seq: 1, text: 'hello' }, T0);
    agg.accept({ seq: 1, text: 'hello there' }, T0 + 10);
    agg.closeAudio(T0 + 20);
    expect(agg.evaluate(T0 + 2000)?.text).toBe('hello there');
  });

  it('ignores whitespace-only lines', () => {
    const agg = new UtteranceAggregator(T0);
    agg.accept({ seq: 1, text: '   ' }, T0);
    agg.addSpeechMs(50);
    agg.closeAudio(T0);
    expect(agg.evaluate(T0 + 2000)?.outcome).toBe('silent');
  });
});
