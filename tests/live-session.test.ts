import { describe, expect, it, vi } from 'vitest';
import { defaults, type TranscriptUpdate } from '../packages/core/src/contracts';
import { SessionCoordinator, type SessionPorts } from '../packages/core/src/session';
import { PerformanceRecorder, type Timing } from '../packages/core/src/performance';

const draft = 'Please send the revised invoice on Friday.';
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness(changes: Partial<SessionPorts> = {}) {
  let listener: ((update: TranscriptUpdate) => void) | null = null;
  const unwatch = vi.fn(() => { listener = null; });
  const timings: Timing[] = [];
  const ports: SessionPorts = {
    inspectTarget: async () => ({ opaque: 'target' }), startCapture: vi.fn(async () => undefined),
    stopCapture: vi.fn(async () => undefined), discard: vi.fn(async () => undefined),
    transcribe: vi.fn(async () => draft), prepareCleanup: vi.fn(async () => undefined),
    watchTranscript: (_id, callback) => { listener = callback; return unwatch; },
    clean: vi.fn(async () => 'Please send the revised invoice on Friday.'),
    insert: vi.fn(async () => ({ outcome: 'attempted' as const, reason: 'synthetic' })),
    recordHistory: vi.fn(async () => undefined), executeCommand: vi.fn(async () => undefined), invalidate: vi.fn(), ...changes,
  };
  const coordinator = new SessionCoordinator(ports, () => undefined, Date.now, new PerformanceRecorder(timing => timings.push(timing)));
  coordinator.setEnabled(true);
  const emit = (revision: number, text = draft, pauseMs = 400) => listener?.({ revision, text, audioEndSample: revision * 32000, pauseMs, final: false });
  return { coordinator, ports, emit, unwatch, timings, getListener: () => listener };
}

describe('CPU preview and speculative cleanup ownership', () => {
  it('prepares credentials during capture and starts one short no-pause cleanup only at release', async () => {
    const short = 'Hi there.';
    const { coordinator, ports, emit } = harness({ transcribe: async () => short });
    await coordinator.start(defaults, 'account');
    expect(ports.prepareCleanup).toHaveBeenCalledTimes(1);
    emit(1, short, 0); await Promise.resolve();
    expect(coordinator.getStatus().phase).toBe('recording');
    expect(ports.clean).not.toHaveBeenCalled(); expect(ports.stopCapture).not.toHaveBeenCalled(); expect(ports.insert).not.toHaveBeenCalled(); expect(ports.recordHistory).not.toHaveBeenCalled();
    await coordinator.stop(); expect(ports.prepareCleanup).toHaveBeenCalledTimes(1); expect(ports.clean).toHaveBeenCalledTimes(1); expect(ports.insert).toHaveBeenCalledTimes(1);
  });
  it('waits for final drained recognition even when the speculative response is complete', async () => {
    const final = deferred<string>(); const { coordinator, ports, emit, timings } = harness({ transcribe: () => final.promise });
    await coordinator.start(defaults, 'account'); emit(1);
    const stop = coordinator.stop(); await vi.waitFor(() => expect(ports.clean).toHaveBeenCalledTimes(1));
    expect(coordinator.getStatus().phase).toBe('transcribing');
    expect(ports.insert).not.toHaveBeenCalled(); final.resolve(draft); await stop;
    expect(ports.clean).toHaveBeenCalledTimes(1); expect(timings.some(t => t.stage === 'speculativeHit')).toBe(true);
  });
  it('starts speculative cleanup before native capture drain completes', async () => {
    const drain = deferred<void>(); const { coordinator, ports, emit } = harness({ stopCapture: vi.fn(() => drain.promise) });
    await coordinator.start(defaults, 'account'); emit(1);
    const stop = coordinator.stop(); await vi.waitFor(() => expect(ports.clean).toHaveBeenCalledTimes(1));
    expect(ports.transcribe).not.toHaveBeenCalled(); expect(ports.insert).not.toHaveBeenCalled();
    drain.resolve(); await stop;
    expect(ports.transcribe).toHaveBeenCalledTimes(1); expect(ports.insert).toHaveBeenCalledTimes(1);
  });
  it('awaits matching cleanup completion after release without launching another request', async () => {
    const response = deferred<string>(); const { coordinator, ports, emit } = harness({ clean: vi.fn(() => response.promise) });
    await coordinator.start(defaults, 'account'); emit(1);
    const stop = coordinator.stop(); await vi.waitFor(() => expect(coordinator.getStatus().phase).toBe('cleaning'));
    expect(ports.insert).not.toHaveBeenCalled(); response.resolve('Completed formatted text.'); await stop;
    expect(ports.clean).toHaveBeenCalledTimes(1); expect(ports.insert).toHaveBeenCalledWith(expect.any(String), { opaque: 'target' }, 'Completed formatted text.', expect.any(AbortSignal));
  });
  it('discards an outdated response and retains a correction arriving immediately before release', async () => {
    const early = deferred<string>(); const corrected = 'Please send the revised invoice on Thursday, not Friday.';
    const earlySignals: AbortSignal[] = [];
    const cleaner = vi.fn((text: string, _settings, _account, signal: AbortSignal) => {
      if (text === draft) { earlySignals.push(signal); return early.promise; }
      return Promise.resolve(corrected);
    });
    const { coordinator, ports, emit } = harness({ transcribe: async () => corrected, clean: cleaner });
    await coordinator.start(defaults, 'account'); emit(1);
    await coordinator.stop(); expect(earlySignals[0]?.aborted).toBe(true); early.resolve('Friday.');
    expect(cleaner).toHaveBeenCalledTimes(2); expect(ports.insert).toHaveBeenCalledWith(expect.any(String), { opaque: 'target' }, corrected, expect.any(AbortSignal));
    expect(ports.recordHistory).toHaveBeenCalledWith(corrected, expect.any(Number));
  });
  it('uses only the newest preview after continuous and resumed speech', async () => {
    const latest = 'This is the resumed and complete sentence.';
    const { coordinator, ports, emit } = harness({ transcribe: async () => latest });
    await coordinator.start(defaults, 'account');
    emit(1, 'This is an earlier sentence.', 0); emit(2, 'This keeps changing while speech continues.', 0); emit(3, latest, 0);
    await Promise.resolve(); expect(ports.clean).not.toHaveBeenCalled();
    await coordinator.stop();
    expect(ports.clean).toHaveBeenCalledTimes(1); expect(ports.clean).toHaveBeenCalledWith(latest, expect.anything(), 'account', expect.any(AbortSignal), 'dictation');
    expect(ports.insert).toHaveBeenCalledTimes(1);
  });
  it('uses one final request when release occurs before any preview exists', async () => {
    const { coordinator, ports } = harness(); await coordinator.start(defaults, 'account');
    await coordinator.stop();
    expect(ports.clean).toHaveBeenCalledTimes(1); expect(ports.clean).toHaveBeenCalledWith(draft, expect.anything(), 'account', expect.any(AbortSignal), 'dictation');
  });
  it('requires a final request for punctuation-only differences', async () => {
    const withoutPunctuation = draft.slice(0, -1);
    const seen: string[] = [];
    const { coordinator, ports, emit } = harness({ clean: vi.fn(async text => { seen.push(text); return `${text}.`; }) });
    await coordinator.start(defaults, 'account'); emit(1, withoutPunctuation, 0);
    await coordinator.stop();
    expect(seen).toEqual([withoutPunctuation, draft]); expect(ports.insert).toHaveBeenCalledTimes(1);
  });
  it('ignores obsolete revisions when choosing the release preview', async () => {
    const { coordinator, ports, emit } = harness(); await coordinator.start(defaults, 'account');
    emit(2); emit(1, 'Obsolete different text.'); emit(2, 'Duplicate different text.');
    await coordinator.stop();
    expect(ports.clean).toHaveBeenCalledTimes(1); expect(ports.clean).toHaveBeenCalledWith(draft, expect.anything(), 'account', expect.any(AbortSignal), 'dictation');
  });
  it('cancels speculation and removes its subscription without retaining late output', async () => {
    const late = deferred<string>(), final = deferred<string>();
    const { coordinator, ports, emit, unwatch, getListener } = harness({ clean: vi.fn(() => late.promise), transcribe: () => final.promise });
    await coordinator.start(defaults, 'account'); emit(1); const obsolete = getListener();
    const stopping = coordinator.stop(); await vi.waitFor(() => expect(ports.clean).toHaveBeenCalledTimes(1));
    coordinator.cancel(); final.resolve(draft); late.resolve('Late result.'); await stopping;
    obsolete?.({ text: draft, revision: 3, audioEndSample: 96000, pauseMs: 500, final: false });
    await vi.waitFor(() => expect(coordinator.getStatus().phase).toBe('idle'));
    expect(unwatch).toHaveBeenCalledTimes(1); expect(ports.insert).not.toHaveBeenCalled(); expect(ports.recordHistory).not.toHaveBeenCalled();
    await coordinator.start(defaults, 'another-account'); coordinator.cancel();
  });
  it('permits one final request after speculative failure, with no unhandled rejection', async () => {
    let calls = 0;
    const cleaner = vi.fn(async () => { if (++calls === 1) throw new Error('synthetic failure'); return 'Final text.'; });
    const { coordinator, ports, emit } = harness({ clean: cleaner });
    await coordinator.start(defaults, 'account'); emit(1);
    await coordinator.stop(); expect(cleaner).toHaveBeenCalledTimes(2); expect(ports.insert).toHaveBeenCalledTimes(1);
  });
  it('aborts early output and inserts nothing when final recognition is silent', async () => {
    const late = deferred<string>(); const { coordinator, ports, emit } = harness({ clean: vi.fn(() => late.promise), transcribe: async () => '' });
    await coordinator.start(defaults, 'account'); emit(1);
    await coordinator.stop(); late.resolve('Invented text.');
    expect(ports.insert).not.toHaveBeenCalled(); expect(ports.recordHistory).not.toHaveBeenCalled(); expect(ports.clean).toHaveBeenCalledTimes(1);
  });
  it('freezes vocabulary and formatting settings for early and final requests', async () => {
    const seen: string[] = [];
    const { coordinator, emit } = harness({ clean: vi.fn(async (_text, settings) => { seen.push(JSON.stringify([settings.cleanup, settings.vocabulary])); return 'Text.'; }), transcribe: async () => 'Different final transcript.' });
    const settings = { ...defaults, vocabulary: ['Acme'], cleanup: 'minimal' as const };
    await coordinator.start(settings, 'account'); settings.vocabulary.push('changed'); emit(1);
    await coordinator.stop(); expect(seen).toEqual(['["minimal",["Acme"]]', '["minimal",["Acme"]]']);
  });
  it('records dispatch separately while insertion acknowledgment is still pending', async () => {
    const insertion = deferred<{ outcome: 'attempted'; reason: string }>();
    const { coordinator, ports, timings } = harness({ insert: vi.fn(() => insertion.promise) });
    const id = await coordinator.start(defaults, 'account'); if (!id) throw new Error('session missing');
    const stop = coordinator.stop(); await vi.waitFor(() => expect(ports.insert).toHaveBeenCalledTimes(1));
    coordinator.pasteDispatched('obsolete'); coordinator.pasteDispatched(id); coordinator.pasteDispatched(id);
    expect(timings.filter(t => t.stage === 'releaseToPasteDispatch')).toHaveLength(1);
    expect(timings.some(t => t.stage === 'releaseToInsertion')).toBe(false);
    insertion.resolve({ outcome: 'attempted', reason: 'once' }); await stop;
    expect(coordinator.getStatus().phase).toBe('done');
    await coordinator.start(defaults, 'account'); expect(coordinator.getStatus().phase).toBe('recording'); coordinator.cancel();
  });
});
