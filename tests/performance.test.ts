import { describe, expect, it } from 'vitest';
import { PerformanceRecorder, type Timing } from '../packages/core/src/performance';

describe('opt-in timings', () => {
  it('records monotonic durations and no operation result or exception details', async () => {
    const records: Timing[] = []; let now = 10;
    const recorder = new PerformanceRecorder(value => records.push(value), () => now);
    expect(await recorder.measure('transcription', async () => { now = 25; return 'private text'; })).toBe('private text');
    await expect(recorder.measure('cleanup', async () => { now = 31; throw new Error('private detail'); })).rejects.toThrow('private detail');
    expect(records).toEqual([{ stage: 'transcription', durationMs: 15, outcome: 'ok' }, { stage: 'cleanup', durationMs: 6, outcome: 'error' }]);
  });
  it('does not affect work with diagnostics disabled, invalid values, or a failing sink', async () => {
    expect(await new PerformanceRecorder().measure('history', async () => 'ok')).toBe('ok');
    const records: Timing[] = [], recorder = new PerformanceRecorder(value => records.push(value));
    recorder.record('history', NaN); recorder.record('history', -1); recorder.record('history', Infinity);
    expect(records).toEqual([]);
    expect(await new PerformanceRecorder(() => { throw new Error('sink'); }).measure('history', async () => 'ok')).toBe('ok');
  });
});
