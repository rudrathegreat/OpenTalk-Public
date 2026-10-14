import { describe, expect, it, vi } from 'vitest';
import { defaults } from '../packages/core/src/contracts';
import { CleanupService } from '../packages/core/src/cleanup';
import { SessionCoordinator, type Insertion, type SessionPorts } from '../packages/core/src/session';
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function harness(change: Partial<SessionPorts> = {}) {
  const ports: SessionPorts = { inspectTarget: async () => ({ opaque: 'target' }), startCapture: vi.fn(async () => undefined), stopCapture: vi.fn(async () => undefined), discard: vi.fn(async () => undefined), transcribe: vi.fn(async () => 'hello'), clean: vi.fn(async () => 'Hello.'), insert: vi.fn(async () => ({ outcome: 'attempted' as const, reason: 'test' })), recordHistory: vi.fn(async () => undefined), executeCommand: vi.fn(async () => undefined), invalidate: vi.fn(), ...change };
  const coordinator = new SessionCoordinator(ports, () => undefined); coordinator.setEnabled(true); return { ports, coordinator };
}
describe('one-session insertion ownership', () => {
  it('prepares authentication concurrently with transcription and sends cleanup only after both finish', async () => {
    const token = deferred<void>(), transcript = deferred<string>();
    const { coordinator, ports } = harness({ prepareCleanup: vi.fn(() => token.promise), transcribe: vi.fn(() => transcript.promise) });
    await coordinator.start(defaults, 'account'); const stop = coordinator.stop();
    await vi.waitFor(() => expect(ports.transcribe).toHaveBeenCalled());
    expect(ports.prepareCleanup).toHaveBeenCalledWith('account', expect.any(AbortSignal));
    transcript.resolve('hello'); await Promise.resolve(); expect(ports.clean).not.toHaveBeenCalled();
    token.resolve(); await stop; expect(ports.insert).toHaveBeenCalledTimes(1);
  });
  it('handles early authentication failure without unhandled rejection or insertion', async () => {
    const transcript = deferred<string>();
    const { coordinator, ports } = harness({ prepareCleanup: async () => { throw new Error('refresh failed'); }, transcribe: () => transcript.promise });
    await coordinator.start(defaults, 'account'); const stop = coordinator.stop();
    transcript.resolve('hello'); await stop;
    expect(ports.clean).not.toHaveBeenCalled(); expect(ports.insert).not.toHaveBeenCalled();
    expect(coordinator.getStatus().phase).toBe('unavailable');
  });
  it('shows Done and permits another recording while history is slow; shutdown drains it', async () => {
    const history = deferred<void>();
    const { coordinator, ports } = harness({ recordHistory: vi.fn(() => history.promise) });
    await coordinator.start(defaults, 'account'); await coordinator.stop();
    expect(coordinator.getStatus().phase).toBe('done');
    await coordinator.start(defaults, 'account'); expect(coordinator.getStatus().phase).toBe('recording');
    history.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(coordinator.getStatus().phase).toBe('recording');
    await coordinator.shutdown(); expect(ports.discard).toHaveBeenCalledTimes(2);
  });
  it('keeps shutdown pending until an outstanding history write completes', async () => {
    const history = deferred<void>(); const { coordinator } = harness({ recordHistory: () => history.promise });
    await coordinator.start(defaults, 'account'); await coordinator.stop();
    let finished = false; const shutdown = coordinator.shutdown().then(() => { finished = true; });
    await Promise.resolve(); await Promise.resolve(); expect(finished).toBe(false);
    history.resolve(); await shutdown; expect(finished).toBe(true);
  });
  it('inserts once on repeated stop and freezes running settings', async () => { const seen: string[] = []; const { coordinator, ports } = harness({ clean: async (_text, s) => { seen.push(s.cleanup); return 'Hello.'; } }); const settings = { ...defaults }; await coordinator.start(settings, 'account'); settings.cleanup = 'minimal'; await Promise.all([coordinator.stop(), coordinator.stop()]); expect(ports.insert).toHaveBeenCalledTimes(1); expect(seen).toEqual(['default']); });
  it('refuses disabled and overlapping starts', async () => { const { coordinator, ports } = harness(); coordinator.setEnabled(false); expect(await coordinator.start(defaults, 'account')).toBeNull(); coordinator.setEnabled(true); await coordinator.start(defaults, 'account'); expect(await coordinator.start(defaults, 'account')).toBeNull(); expect(ports.startCapture).toHaveBeenCalledTimes(1); coordinator.cancel(); });
  it.each(['transcribe', 'clean'] as const)('cancellation during %s ignores late completion', async stage => { const gate = deferred<string>(); const { coordinator, ports } = harness({ [stage]: () => gate.promise }); await coordinator.start(defaults, 'account'); const result = coordinator.stop(); await Promise.resolve(); await Promise.resolve(); coordinator.cancel(); gate.resolve('Late text'); await result; expect(ports.insert).not.toHaveBeenCalled(); expect(ports.invalidate).toHaveBeenCalled(); });
  it('treats release while target inspection is pending as cancellation', async () => {
    const gate = deferred<{ opaque: string }>();
    const { coordinator, ports } = harness({ inspectTarget: () => gate.promise });
    const start = coordinator.start(defaults, 'account');
    await coordinator.stop();
    gate.resolve({ opaque: 'late' });
    expect(await start).toBeNull();
    expect(ports.startCapture).not.toHaveBeenCalled();
    expect(ports.transcribe).not.toHaveBeenCalled();
    expect(ports.discard).toHaveBeenCalledTimes(1);
    expect(coordinator.getStatus().phase).toBe('idle');
  });
  it('treats release before startCapture acknowledgement as cancellation and releases once', async () => {
    const gate = deferred<void>();
    const { coordinator, ports } = harness({ startCapture: vi.fn(() => gate.promise) });
    const start = coordinator.start(defaults, 'account');
    await vi.waitFor(() => expect(ports.startCapture).toHaveBeenCalledTimes(1));
    await coordinator.stop();
    gate.resolve();
    expect(await start).toBeNull();
    expect(ports.stopCapture).not.toHaveBeenCalled();
    expect(ports.transcribe).not.toHaveBeenCalled();
    expect(ports.discard).toHaveBeenCalledTimes(1);
    expect(coordinator.getStatus().phase).toBe('idle');
  });
  it('cancels while stopCapture is pending and ignores its late completion', async () => {
    const gate = deferred<void>();
    const { coordinator, ports } = harness({ stopCapture: vi.fn(() => gate.promise) });
    await coordinator.start(defaults, 'account');
    const stop = coordinator.stop();
    await vi.waitFor(() => expect(ports.stopCapture).toHaveBeenCalledTimes(1));
    coordinator.cancel(); gate.resolve(); await stop;
    expect(ports.transcribe).not.toHaveBeenCalled();
    expect(ports.insert).not.toHaveBeenCalled();
    expect(coordinator.getStatus().phase).toBe('idle');
  });
  it('invalidates an insertion in flight and ignores its late outcome', async () => {
    const gate = deferred<Insertion>();
    const { coordinator, ports } = harness({ insert: vi.fn(() => gate.promise) });
    await coordinator.start(defaults, 'account');
    const stop = coordinator.stop();
    await vi.waitFor(() => expect(ports.insert).toHaveBeenCalledTimes(1));
    coordinator.cancel(); gate.resolve({ outcome: 'attempted', reason: 'late' }); await stop;
    expect(ports.invalidate).toHaveBeenCalledTimes(1);
    expect(coordinator.copyRecovery(vi.fn())).toBe(false);
    expect(coordinator.getStatus().phase).toBe('idle');
  });
  it('disable cancels the active session and finishes disabled', async () => {
    const gate = deferred<string>();
    const { coordinator, ports } = harness({ transcribe: vi.fn(() => gate.promise) });
    await coordinator.start(defaults, 'account');
    const stop = coordinator.stop();
    await vi.waitFor(() => expect(ports.transcribe).toHaveBeenCalledTimes(1));
    coordinator.setEnabled(false); gate.resolve('late'); await stop;
    expect(ports.insert).not.toHaveBeenCalled();
    expect(coordinator.getStatus().phase).toBe('disabled');
  });
  it('native process failure invalidates cleanup and reports unavailable once', async () => {
    const gate = deferred<string>(); const published: string[] = [];
    const ports: SessionPorts = { inspectTarget: async () => ({ opaque: 'target' }), startCapture: vi.fn(async () => undefined), stopCapture: vi.fn(async () => undefined), discard: vi.fn(async () => undefined), transcribe: async () => 'hello', clean: () => gate.promise, insert: vi.fn(async () => ({ outcome: 'attempted' as const, reason: 'test' })), recordHistory: vi.fn(async () => undefined), executeCommand: vi.fn(async () => undefined), invalidate: vi.fn() };
    const coordinator = new SessionCoordinator(ports, status => published.push(status.phase)); coordinator.setEnabled(true);
    await coordinator.start(defaults, 'account'); const stop = coordinator.stop();
    await vi.waitFor(() => expect(coordinator.getStatus().phase).toBe('cleaning'));
    coordinator.unavailable(); gate.resolve('late'); await stop;
    expect(ports.insert).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(coordinator.getStatus().phase).toBe('unavailable'));
    expect(published.filter(phase => phase === 'unavailable')).toHaveLength(1);
  });
  it('serializes repeated cancellation and retains ownership until discard completes', async () => {
    const gate = deferred<void>();
    const { coordinator, ports } = harness({ discard: vi.fn(() => gate.promise) });
    await coordinator.start(defaults, 'account'); coordinator.cancel(); coordinator.cancel();
    expect(ports.invalidate).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(ports.discard).toHaveBeenCalledTimes(1));
    expect(await coordinator.start(defaults, 'account')).toBeNull();
    gate.resolve(); await vi.waitFor(() => expect(coordinator.getStatus().phase).toBe('idle'));
    await coordinator.start(defaults, 'account');
    expect(ports.startCapture).toHaveBeenCalledTimes(2);
    coordinator.cancel();
  });
  it('exposes an awaitable cancellation barrier for a mutually exclusive meeting capture', async () => {
    const gate = deferred<void>();
    const { coordinator, ports } = harness({ discard: vi.fn(() => gate.promise) });
    await coordinator.start(defaults, 'account');
    let released = false; const cancellation = coordinator.cancelAndWait().then(() => { released = true; });
    await vi.waitFor(() => expect(ports.discard).toHaveBeenCalledTimes(1));
    expect(released).toBe(false); expect(coordinator.getStatus().phase).toBe('recording');
    gate.resolve(); await cancellation;
    expect(released).toBe(true); expect(coordinator.getStatus().phase).toBe('idle');
  });
  it.each(['inspectTarget', 'startCapture', 'stopCapture', 'transcribe', 'clean'] as const)('%s failure releases capture and inserts nothing', async stage => { const { coordinator, ports } = harness({ [stage]: async () => { throw new Error('sensitive detail'); } }); await coordinator.start(defaults, 'account'); await coordinator.stop(); expect(ports.insert).not.toHaveBeenCalled(); expect(ports.discard).toHaveBeenCalled(); expect(coordinator.getStatus().message).toBe('Sorry, not available'); });
  it('authorizes delta-only text once after a valid completed event', async () => {
    const events = [
      { type: 'response.output_text.delta', delta: 'Completed synthetic text.' },
      { type: 'response.completed', response: { status: 'completed', output: [] } },
    ].map(item => `data: ${JSON.stringify(item)}\n\n`).join('');
    const service = new CleanupService(async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(events)); controller.close(); } })));
    const { coordinator, ports } = harness({ clean: (text, settings, _account, signal) => service.clean(text, settings, 'test-credential', signal) });
    await coordinator.start(defaults, 'account'); await coordinator.stop();
    expect(ports.insert).toHaveBeenCalledTimes(1);
    expect(ports.insert).toHaveBeenCalledWith(expect.any(String), { opaque: 'target' }, 'Completed synthetic text.', expect.any(AbortSignal));
  });
  it('an incomplete provider stream shows unavailable and authorizes zero insertion', async () => {
    const encoded = new TextEncoder().encode(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'Partial synthetic text.' })}\n\n`);
    const service = new CleanupService(async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoded); controller.close(); } })));
    const { coordinator, ports } = harness({ clean: (text, settings, _account, signal) => service.clean(text, settings, 'test-credential', signal) });
    await coordinator.start(defaults, 'account'); await coordinator.stop();
    expect(coordinator.getStatus()).toEqual({ phase: 'unavailable', message: 'Sorry, not available', canCopy: false });
    expect(ports.insert).not.toHaveBeenCalled(); expect(coordinator.copyRecovery(vi.fn())).toBe(false);
  });
  it('an empty completed provider response shows unavailable and authorizes zero insertion', async () => {
    const completed = `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [] } })}\n\n`;
    const service = new CleanupService(async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(completed)); controller.close(); } })));
    const { coordinator, ports } = harness({ clean: (text, settings, _account, signal) => service.clean(text, settings, 'test-credential', signal) });
    await coordinator.start(defaults, 'account'); await coordinator.stop();
    expect(coordinator.getStatus()).toEqual({ phase: 'unavailable', message: 'Sorry, not available', canCopy: false });
    expect(ports.insert).not.toHaveBeenCalled(); expect(coordinator.copyRecovery(vi.fn())).toBe(false);
  });
  it('silence avoids cleanup and insertion', async () => { const cleaner = vi.fn(async () => 'fabricated'); const { coordinator, ports } = harness({ transcribe: async () => '', clean: cleaner }); await coordinator.start(defaults, 'account'); await coordinator.stop(); expect(cleaner).not.toHaveBeenCalled(); expect(ports.insert).not.toHaveBeenCalled(); });
  it('uses one Processing message for transcription, cleanup and insertion', async () => {
    const transcript = deferred<string>(), cleaned = deferred<string>(), inserted = deferred<Insertion>();
    const statuses: Array<{ phase: string; message: string }> = [];
    const ports: SessionPorts = { inspectTarget: async () => ({ opaque: 'target' }), startCapture: async () => undefined, stopCapture: async () => undefined, discard: async () => undefined, transcribe: () => transcript.promise, clean: () => cleaned.promise, insert: () => inserted.promise, recordHistory: vi.fn(async () => undefined), executeCommand: vi.fn(async () => undefined), invalidate: vi.fn() };
    const coordinator = new SessionCoordinator(ports, status => statuses.push(status)); coordinator.setEnabled(true);
    await coordinator.start(defaults, 'account'); const stop = coordinator.stop();
    await vi.waitFor(() => expect(coordinator.getStatus().phase).toBe('transcribing'));
    transcript.resolve('hello'); await vi.waitFor(() => expect(coordinator.getStatus().phase).toBe('cleaning'));
    cleaned.resolve('Hello.'); await vi.waitFor(() => expect(coordinator.getStatus().phase).toBe('inserting'));
    inserted.resolve({ outcome: 'attempted', reason: 'test' }); await stop;
    expect(statuses.filter(status => ['transcribing', 'cleaning', 'inserting'].includes(status.phase)).map(status => status.message)).toEqual(['Processing', 'Processing', 'Processing']);
    expect(coordinator.getStatus()).toEqual({ phase: 'done', message: 'Done', canCopy: false });
  });
  it('returns to Ready after briefly showing Done', async () => {
    vi.useFakeTimers();
    try {
      const { coordinator } = harness();
      await coordinator.start(defaults, 'account'); await coordinator.stop();
      expect(coordinator.getStatus().message).toBe('Done');
      vi.advanceTimersByTime(1499); expect(coordinator.getStatus().message).toBe('Done');
      vi.advanceTimersByTime(1); expect(coordinator.getStatus()).toEqual({ phase: 'idle', message: 'Ready', canCopy: false });
    } finally { vi.useRealTimers(); }
  });
  it.each(['notAttempted', 'uncertain'] as const)('copies one temporary cleaned result after %s without a retry', async outcome => {
    const write = vi.fn(); const { coordinator, ports } = harness({ insert: vi.fn(async () => ({ outcome, reason: 'changed' })) });
    await coordinator.start(defaults, 'account'); await coordinator.stop(); await coordinator.stop();
    expect(ports.insert).toHaveBeenCalledTimes(1); expect(coordinator.getStatus()).toEqual({ phase: 'blocked', message: 'Insertion blocked', canCopy: true });
    expect(coordinator.copyRecovery(write)).toBe(true); expect(write).toHaveBeenCalledWith('Hello.'); expect(coordinator.copyRecovery(write)).toBe(false); expect(write).toHaveBeenCalledTimes(1);
  });
  it('retains blocked recovery when the clipboard write fails', async () => {
    const { coordinator } = harness({ insert: async () => ({ outcome: 'notAttempted', reason: 'changed' }) });
    await coordinator.start(defaults, 'account'); await coordinator.stop();
    expect(() => coordinator.copyRecovery(() => { throw new Error('clipboard busy'); })).toThrow('clipboard busy');
    expect(coordinator.getStatus()).toEqual({ phase: 'blocked', message: 'Insertion blocked', canCopy: true });
    const write = vi.fn(); expect(coordinator.copyRecovery(write)).toBe(true); expect(write).toHaveBeenCalledWith('Hello.');
  });
  it('expires recovery without copying and clears it when a new session starts', async () => {
    vi.useFakeTimers();
    try {
      const expired = harness({ insert: async () => ({ outcome: 'notAttempted', reason: 'changed' }) });
      await expired.coordinator.start(defaults, 'account'); await expired.coordinator.stop(); vi.advanceTimersByTime(60000);
      expect(expired.coordinator.copyRecovery(vi.fn())).toBe(false); expect(expired.coordinator.getStatus().phase).toBe('idle');
      const replaced = harness({ insert: async () => ({ outcome: 'uncertain', reason: 'unknown' }) });
      await replaced.coordinator.start(defaults, 'account'); await replaced.coordinator.stop(); await replaced.coordinator.start(defaults, 'account');
      expect(replaced.coordinator.copyRecovery(vi.fn())).toBe(false); replaced.coordinator.cancel();
    } finally { vi.useRealTimers(); }
  });
  it('clears blocked recovery when canceled or disabled', async () => {
    for (const terminate of ['cancel', 'disable'] as const) {
      const { coordinator } = harness({ insert: async () => ({ outcome: 'notAttempted', reason: 'changed' }) });
      await coordinator.start(defaults, 'account'); await coordinator.stop();
      if (terminate === 'cancel') coordinator.cancel(); else coordinator.setEnabled(false);
      expect(coordinator.copyRecovery(vi.fn())).toBe(false);
      expect(coordinator.getStatus().phase).toBe(terminate === 'disable' ? 'disabled' : 'idle');
    }
  });
  it('never offers copy for failed cleanup', async () => { const { coordinator } = harness({ clean: async () => { throw new Error('limit'); } }); await coordinator.start(defaults, 'account'); await coordinator.stop(); expect(coordinator.copyRecovery(vi.fn())).toBe(false); });
  it('records one cleaned result and its nonnegative capture duration after a successful terminal session', async () => { const { coordinator, ports } = harness(); await coordinator.start(defaults, 'account'); await Promise.all([coordinator.stop(), coordinator.stop()]); expect(ports.recordHistory).toHaveBeenCalledTimes(1); expect(ports.recordHistory).toHaveBeenCalledWith('Hello.', expect.any(Number)); expect(vi.mocked(ports.recordHistory).mock.calls[0]![1]).toBeGreaterThanOrEqual(0); });
  it.each(['notAttempted', 'uncertain'] as const)('records a cleaned result after a %s insertion outcome', async outcome => { const { coordinator, ports } = harness({ insert: vi.fn(async () => ({ outcome, reason: 'changed' })) }); await coordinator.start(defaults, 'account'); await coordinator.stop(); expect(ports.recordHistory).toHaveBeenCalledWith('Hello.', expect.any(Number)); });
  it('does not retain silence, canceled work, or a failed terminal session', async () => {
    const silent = harness({ transcribe: async () => '' }); await silent.coordinator.start(defaults, 'account'); await silent.coordinator.stop(); expect(silent.ports.recordHistory).not.toHaveBeenCalled();
    const gate = deferred<string>(); const canceled = harness({ clean: () => gate.promise }); await canceled.coordinator.start(defaults, 'account'); const stopping = canceled.coordinator.stop(); await vi.waitFor(() => expect(canceled.coordinator.getStatus().phase).toBe('cleaning')); canceled.coordinator.cancel(); gate.resolve('Late'); await stopping; expect(canceled.ports.recordHistory).not.toHaveBeenCalled();
    const failed = harness({ insert: async () => { throw new Error('failed'); } }); await failed.coordinator.start(defaults, 'account'); await failed.coordinator.stop(); expect(failed.ports.recordHistory).not.toHaveBeenCalled();
  });
  it('does not turn a completed insertion into a failure when history cannot be written', async () => { const { coordinator, ports } = harness({ recordHistory: vi.fn(async () => { throw new Error('unavailable'); }) }); await coordinator.start(defaults, 'account'); await coordinator.stop(); expect(ports.insert).toHaveBeenCalledTimes(1); expect(coordinator.getStatus().phase).toBe('done'); });
  it('consumes Start Meeting locally after native release without cleanup, insertion, or history', async () => {
    const order: string[] = [];
    const { coordinator, ports } = harness({
      watchTranscript: (_id, listener) => { listener({ text: 'Start meeting', revision: 1, audioEndSample: 16_000, pauseMs: 250, final: false }); return () => undefined; },
      transcribe: vi.fn(async () => 'Start Meeting.'),
      discard: vi.fn(async () => { order.push('discard'); }),
      executeCommand: vi.fn(async () => { order.push('command'); }),
    });
    await coordinator.start(defaults, 'account'); await coordinator.stop();
    expect(order).toEqual(['discard', 'command']);
    expect(ports.executeCommand).toHaveBeenCalledWith('start-meeting');
    expect(ports.clean).not.toHaveBeenCalled();
    expect(ports.insert).not.toHaveBeenCalled();
    expect(ports.recordHistory).not.toHaveBeenCalled();
    expect(coordinator.getStatus().phase).toBe('idle');
  });
  it('keeps command mode text-only and bypasses local voice-command dispatch', async () => {
    const { coordinator, ports } = harness({ transcribe: vi.fn(async () => 'Start Meeting.'), clean: vi.fn(async () => 'Command Mode can only generate text.') });
    await coordinator.start(defaults, 'account', 'command'); await coordinator.stop();
    expect(ports.executeCommand).not.toHaveBeenCalled();
    expect(ports.clean).toHaveBeenCalledWith('Start Meeting.', expect.anything(), 'account', expect.any(AbortSignal), 'command');
    expect(ports.insert).toHaveBeenCalledWith(expect.any(String), { opaque: 'target' }, 'Command Mode can only generate text.', expect.any(AbortSignal));
    expect(ports.recordHistory).toHaveBeenCalledWith('Command Mode can only generate text.', expect.any(Number));
  });
  it('reports unavailable when a matched command action fails', async () => {
    const { coordinator, ports } = harness({ transcribe: vi.fn(async () => 'start meeting'), executeCommand: vi.fn(async () => { throw new Error('failed'); }) });
    await coordinator.start(defaults, 'account'); await coordinator.stop();
    expect(ports.clean).not.toHaveBeenCalled(); expect(ports.insert).not.toHaveBeenCalled();
    expect(coordinator.getStatus()).toEqual({ phase: 'unavailable', message: 'Sorry, not available', canCopy: false });
  });
  it('does not execute a matched command when cancellation wins during native release', async () => {
    const released = deferred<void>();
    const { coordinator, ports } = harness({ transcribe: vi.fn(async () => 'start meeting'), discard: vi.fn(() => released.promise) });
    await coordinator.start(defaults, 'account'); const stopping = coordinator.stop();
    await vi.waitFor(() => expect(ports.discard).toHaveBeenCalledTimes(1));
    const canceled = coordinator.cancelAndWait(); released.resolve(); await Promise.all([stopping, canceled]);
    expect(ports.executeCommand).not.toHaveBeenCalled(); expect(ports.insert).not.toHaveBeenCalled();
    expect(coordinator.getStatus().phase).toBe('idle');
  });
  it('cancel while acquiring a target never opens capture', async () => { const gate = deferred<{ opaque: string }>(); const { coordinator, ports } = harness({ inspectTarget: () => gate.promise }); const result = coordinator.start(defaults, 'account'); coordinator.cancel(); gate.resolve({ opaque: 'late' }); await result; expect(ports.startCapture).not.toHaveBeenCalled(); expect(ports.insert).not.toHaveBeenCalled(); expect(coordinator.getStatus().phase).toBe('idle'); });
});
