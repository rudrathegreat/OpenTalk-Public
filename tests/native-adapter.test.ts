import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { NativeAdapter } from '../apps/desktop/main/native';
import { defaults } from '../packages/core/src/contracts';

class FakeProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  kill(): boolean { this.killed = true; return true; }
  asChild(): ChildProcessWithoutNullStreams { return this as unknown as ChildProcessWithoutNullStreams; }
}

function event(generation: number, sequence: number, requestId: string, type: string, sessionId: string | null = null, payload: unknown = type === 'error' ? { code: 'test' } : {}): string {
  return JSON.stringify({ version: 1, generation, requestId, sessionId, sequence, type, payload }) + '\n';
}

function started(): { adapter: NativeAdapter; child: FakeProcess; failure: ReturnType<typeof vi.fn> } {
  const child = new FakeProcess();
  const adapter = new NativeAdapter('helper.exe', 'worker.exe', () => child.asChild());
  const failure = vi.fn(); adapter.onFailure = failure; adapter.start();
  child.stdout.write(event(1, 1, randomUUID(), 'ready'));
  expect(adapter.ready).toBe(true);
  return { adapter, child, failure };
}

describe('native adapter lifecycle', () => {
  it('prepares again when cancellation/discard has released the formerly cached worker', async () => {
    const { adapter, child, failure } = started(); let sequence = 1; const commands: string[] = [];
    child.stdin.on('data', chunk => {
      const command = JSON.parse(String(chunk)) as { requestId: string; type: string; sessionId: string | null };
      commands.push(command.type);
      if (command.type === 'discard') child.stdout.write(event(1, ++sequence, randomUUID(), 'workerUnavailable'));
      child.stdout.write(event(1, ++sequence, command.requestId, command.type === 'prepareWorker' ? 'workerReady' : 'target', command.sessionId, command.type === 'prepareWorker' ? { workerPid: 123 } : {}));
    });
    await adapter.prepare('model.bin'); await adapter.discard(randomUUID()); await adapter.prepare('model.bin');
    expect(commands).toEqual(['prepareWorker', 'discard', 'prepareWorker']); expect(failure).not.toHaveBeenCalled();
  });
  it('routes ordered drafts only to their owning session and stops delivering after unsubscribe', () => {
    const { adapter, child, failure } = started(); const session = randomUUID(); const listener = vi.fn();
    const unwatch = adapter.watchTranscript(session, listener);
    const payload = { text: 'Synthetic text.', revision: 1, audioEndSample: 32000, pauseMs: 300, final: false };
    child.stdout.write(event(1, 2, randomUUID(), 'transcriptUpdate', randomUUID(), payload));
    child.stdout.write(event(1, 3, randomUUID(), 'transcriptUpdate', session, payload));
    unwatch(); child.stdout.write(event(1, 4, randomUUID(), 'transcriptUpdate', session, { ...payload, revision: 2, audioEndSample: 64000 }));
    expect(listener).toHaveBeenCalledTimes(1); expect(failure).not.toHaveBeenCalled();
  });
  it.each(['duplicate revision', 'invalid pause', 'too much audio', 'null text'] as const)('rejects %s preview payloads', reason => {
    const { adapter, child, failure } = started(); const session = randomUUID(); adapter.watchTranscript(session, vi.fn());
    const payload = { text: 'Synthetic text.', revision: 1, audioEndSample: 32000, pauseMs: 300, final: false };
    child.stdout.write(event(1, 2, randomUUID(), 'transcriptUpdate', session, payload));
    const invalid = reason === 'duplicate revision' ? payload : reason === 'invalid pause' ? { ...payload, revision: 2, pauseMs: 30000 }
      : reason === 'too much audio' ? { ...payload, revision: 2, audioEndSample: 480001 } : { ...payload, revision: 2, text: 'unsafe\0text' };
    child.stdout.write(event(1, 3, randomUUID(), 'transcriptUpdate', session, invalid));
    expect(child.killed).toBe(true); expect(failure).toHaveBeenCalledTimes(1);
  });
  it('requires a final watermark covering every reported preview even after unsubscribe', async () => {
    const { adapter, child } = started(); const session = randomUUID(); const unwatch = adapter.watchTranscript(session, vi.fn());
    child.stdout.write(event(1, 2, randomUUID(), 'transcriptUpdate', session, { text: 'Synthetic draft.', revision: 1, audioEndSample: 64000, pauseMs: 0, final: false }));
    unwatch(); let sequence = 2;
    child.stdin.on('data', chunk => {
      const command = JSON.parse(String(chunk)) as { requestId: string };
      child.stdout.write(event(1, ++sequence, command.requestId, 'transcript', session, { text: 'Incomplete text.', revision: 2, audioEndSample: 32000, final: true }));
    });
    await expect(adapter.transcript(session, new AbortController().signal)).rejects.toThrow();
  });
  it('accepts final recognition and publishes dispatch without waiting for restoration acknowledgment', async () => {
    const { adapter, child } = started(); const session = randomUUID(); const dispatched = vi.fn(); adapter.onPasteDispatched = dispatched;
    child.stdin.on('data', chunk => {
      const command = JSON.parse(String(chunk)) as { requestId: string };
      child.stdout.write(event(1, 2, command.requestId, 'transcript', session, { text: 'Final text.', revision: 1, audioEndSample: 64000, final: true }));
    });
    expect(await adapter.transcript(session, new AbortController().signal)).toBe('Final text.');
    child.stdout.write(event(1, 3, randomUUID(), 'pasteDispatched', session)); expect(dispatched).toHaveBeenCalledWith(session);
  });
  it('resolves insertion and discard before a later clipboard-restoration timing event', async () => {
    const { adapter, child, failure } = started(); const session = randomUUID(); let sequence = 1;
    child.stdin.on('data', chunk => {
      const command = JSON.parse(String(chunk)) as { requestId: string; type: string; sessionId: string | null };
      if (command.type === 'insertText') {
        child.stdout.write(event(1, ++sequence, randomUUID(), 'pasteDispatched', session));
        child.stdout.write(event(1, ++sequence, command.requestId, 'insertion', session, { outcome: 'attempted', reason: 'sent_once' }));
      } else child.stdout.write(event(1, ++sequence, command.requestId, 'target', command.sessionId));
    });
    await expect(adapter.insert(session, { opaque: 'target' }, 'Synthetic text.', new AbortController().signal)).resolves.toEqual({ outcome: 'attempted', reason: 'sent_once' });
    await expect(adapter.discard(session)).resolves.toBeUndefined();
    child.stdout.write(event(1, ++sequence, randomUUID(), 'timing', session, { stage: 'clipboardRestoration', durationMs: 350 }));
    expect(failure).not.toHaveBeenCalled(); expect(child.killed).toBe(false);
  });
  it('bounds worker startup and fails pending preparation when the helper exits', async () => {
    vi.useFakeTimers();
    try {
      const { adapter, child } = started(); const preparation = adapter.prepare('model.bin');
      const rejection = expect(preparation).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(65000); await rejection;
      expect(child.killed).toBe(true); expect(adapter.ready).toBe(false);
    } finally { vi.useRealTimers(); }
  });
  it('shares preparation, reuses the warm worker and releases readiness on disable', async () => {
    const { adapter, child } = started(); const commands: Array<{ requestId: string; type: string }> = []; let sequence = 1;
    child.stdin.on('data', chunk => {
      const command = JSON.parse(String(chunk)) as { requestId: string; type: string }; commands.push(command);
      child.stdout.write(event(1, ++sequence, command.requestId, command.type === 'prepareWorker' ? 'workerReady' : 'target', null, command.type === 'prepareWorker' ? { workerPid: 123 } : {}));
    });
    await Promise.all([adapter.prepare('model.bin'), adapter.prepare('model.bin')]);
    await adapter.prepare('model.bin');
    expect(commands.filter(command => command.type === 'prepareWorker')).toHaveLength(1);
    await adapter.configure({ ...defaults, enabled: false }); await adapter.prepare('model.bin');
    expect(commands.filter(command => command.type === 'prepareWorker')).toHaveLength(2);
    child.stdout.write(event(1, ++sequence, randomUUID(), 'workerUnavailable')); await adapter.prepare('model.bin');
    expect(commands.filter(command => command.type === 'prepareWorker')).toHaveLength(3);
  });
  it('never starts capture after cancellation while worker preparation is pending', async () => {
    const { adapter, child } = started(); const controller = new AbortController(); const commands: Array<{ requestId: string; type: string }> = [];
    child.stdin.on('data', chunk => commands.push(JSON.parse(String(chunk))));
    const capture = adapter.capture(randomUUID(), defaults, 'model.bin', controller.signal);
    const rejection = expect(capture).rejects.toThrow(); controller.abort(); await rejection;
    const first = commands[0]; if (!first) throw new Error('preparation was not sent');
    child.stdout.write(event(1, 2, first.requestId, 'workerReady', null, { workerPid: 123 }));
    expect(commands.map(command => command.type)).toEqual(['prepareWorker']);
  });
  it('fails preparation on worker error and permits a later fresh attempt', async () => {
    const { adapter, child } = started(); let attempts = 0, sequence = 1;
    child.stdin.on('data', chunk => {
      const command = JSON.parse(String(chunk)) as { requestId: string }; attempts++;
      child.stdout.write(event(1, ++sequence, command.requestId, attempts === 1 ? 'error' : 'workerReady', null, attempts === 1 ? { code: 'test' } : { workerPid: 123 }));
    });
    await expect(adapter.prepare('model.bin')).rejects.toThrow(); await adapter.prepare('model.bin'); expect(attempts).toBe(2);
  });
  it('publishes validated microphone levels without treating them as failures', () => {
    const { adapter, child, failure } = started(); const level = vi.fn(); adapter.onAudioLevel = level;
    child.stdout.write(event(1, 2, randomUUID(), 'audioLevel', randomUUID(), { level: 67 }));
    expect(level).toHaveBeenCalledWith(67); expect(failure).not.toHaveBeenCalled(); expect(child.killed).toBe(false);
  });

  it('routes the distinct meeting shortcut event without treating it as dictation', () => {
    const { adapter, child, failure } = started(); const hotkey = vi.fn(); adapter.onHotkey = hotkey;
    child.stdout.write(event(1, 2, randomUUID(), 'meeting'));
    expect(hotkey).toHaveBeenCalledWith('meeting'); expect(failure).not.toHaveBeenCalled(); expect(child.killed).toBe(false);
  });

  it('accepts a microphone list with one explicitly identified Windows default', async () => {
    const { adapter, child, failure } = started();
    const microphones = [{ id: '0:Default', name: 'Default', isDefault: true }, { id: '1:Other', name: 'Other', isDefault: false }];
    child.stdin.on('data', chunk => {
      const command = JSON.parse(String(chunk)) as { requestId: string };
      child.stdout.write(event(1, 2, command.requestId, 'microphones', null, microphones));
    });
    await expect(adapter.microphones()).resolves.toEqual(microphones);
    expect(failure).not.toHaveBeenCalled(); expect(child.killed).toBe(false);
  });

  it('accepts playback devices and sends both selected endpoints only for meeting capture', async () => {
    const { adapter, child, failure } = started(); let sequence = 1;
    const commands: Array<{ type: string; requestId: string; sessionId: string | null; payload: Record<string, unknown> }> = [];
    child.stdin.on('data', chunk => {
      const command = JSON.parse(String(chunk)) as typeof commands[number]; commands.push(command);
      if (command.type === 'listPlaybackDevices') child.stdout.write(event(1, ++sequence, command.requestId, 'playbackDevices', null, [{ id: 'speaker', name: 'Speakers', isDefault: true }]));
      else if (command.type === 'prepareWorker') child.stdout.write(event(1, ++sequence, command.requestId, 'workerReady', null, { workerPid: 123 }));
      else child.stdout.write(event(1, ++sequence, command.requestId, 'started', command.sessionId));
    });
    await expect(adapter.playbackDevices()).resolves.toEqual([{ id: 'speaker', name: 'Speakers', isDefault: true }]);
    const id = randomUUID();
    await adapter.captureMeeting(id, { ...defaults, microphoneId: 'mic', playbackDeviceId: 'speaker' }, 'model.bin', new AbortController().signal);
    expect(commands.find(command => command.type === 'startCapture')?.payload).toMatchObject({ captureMode: 'meeting', microphoneId: 'mic', playbackDeviceId: 'speaker' });
    expect(failure).not.toHaveBeenCalled();
  });

  it('keeps assistant window registration independent from microphone enumeration', async () => {
    const { adapter, child, failure } = started(); let sequence = 1;
    const commands: string[] = [];
    child.stdin.on('data', chunk => {
      const command = JSON.parse(String(chunk)) as { requestId: string; type: string };
      commands.push(command.type);
      child.stdout.write(event(1, ++sequence, command.requestId, command.type === 'listMicrophones' ? 'microphones' : 'target', null,
        command.type === 'listMicrophones' ? [{ id: 'mic', name: 'Microphone', isDefault: true }] : {}));
    });
    await expect(adapter.microphones()).resolves.toHaveLength(1);
    await expect(adapter.registerAssistantWindow('1234')).resolves.toBeUndefined();
    expect(commands).toEqual(['listMicrophones', 'registerAssistantWindow']);
    expect(failure).not.toHaveBeenCalled();
  });

  it('validates selected text and preserves the opaque target for one replacement request', async () => {
    const { adapter, child, failure } = started(); let sequence = 1;
    const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
    child.stdin.on('data', chunk => {
      const command = JSON.parse(String(chunk)) as { requestId: string; type: string; sessionId: string | null; payload: Record<string, unknown> };
      sent.push(command);
      const payload = command.type === 'inspectSelection'
        ? { target: { hwnd: 1 }, text: ' Selected text. ', bounds: { x: 10, y: 20, width: 80, height: 18 }, capture: 'automation' }
        : { outcome: 'attempted', reason: 'sent_once' };
      child.stdout.write(event(1, ++sequence, command.requestId, command.type === 'inspectSelection' ? 'target' : 'insertion', command.sessionId, payload));
    });
    const selection = await adapter.inspectSelection();
    expect(selection).toEqual({ target: { opaque: { hwnd: 1 } }, text: ' Selected text. ', bounds: { x: 10, y: 20, width: 80, height: 18 }, capture: 'automation' });
    const id = randomUUID();
    await expect(adapter.replaceSelection(id, selection, 'Replacement.', new AbortController().signal)).resolves.toEqual({ outcome: 'attempted', reason: 'sent_once' });
    expect(sent[1]?.payload).toEqual({ selection: { target: { hwnd: 1 }, text: ' Selected text. ', bounds: { x: 10, y: 20, width: 80, height: 18 }, capture: 'automation' }, text: 'Replacement.' });
    expect(failure).not.toHaveBeenCalled();
  });

  it('routes selection and focus notifications without changing hotkey behavior', () => {
    const { adapter, child, failure } = started();
    const selected = vi.fn(), focused = vi.fn(); adapter.onSelectionChanged = selected; adapter.onFocusChanged = focused;
    child.stdout.write(event(1, 2, randomUUID(), 'selectionChanged'));
    child.stdout.write(event(1, 3, randomUUID(), 'focusChanged'));
    expect(selected).toHaveBeenCalledOnce(); expect(focused).toHaveBeenCalledOnce(); expect(failure).not.toHaveBeenCalled();
  });

  it.each([
    { microphones: [{ id: '0:Missing marker', name: 'Missing marker' }] },
    { microphones: [{ id: '0:First', name: 'First', isDefault: true }, { id: '1:Second', name: 'Second', isDefault: true }] },
  ])('rejects malformed or ambiguous microphone metadata', async ({ microphones }) => {
    const { adapter, child } = started();
    child.stdin.on('data', chunk => {
      const command = JSON.parse(String(chunk)) as { requestId: string };
      child.stdout.write(event(1, 2, command.requestId, 'microphones', null, microphones));
    });
    await expect(adapter.microphones()).rejects.toThrow();
  });

  it('ignores a terminal event for an aborted request but reports an unsolicited failure', async () => {
    const { adapter, child, failure } = started(); let command = '';
    child.stdin.on('data', chunk => { command += String(chunk); });
    const controller = new AbortController(); const sessionId = randomUUID();
    const request = adapter.request('transcribe', {}, sessionId, controller.signal);
    const rejection = expect(request).rejects.toThrow(); controller.abort(); await rejection;
    const requestId = (JSON.parse(command.trim()) as { requestId: string }).requestId;
    child.stdout.write(event(1, 2, requestId, 'error', sessionId));
    expect(failure).not.toHaveBeenCalled(); expect(child.killed).toBe(false);
    child.stdout.write(event(1, 3, randomUUID(), 'error', sessionId));
    expect(failure).toHaveBeenCalledTimes(1);
  });

  it('rejects pending work and reports an unexpected process exit once', async () => {
    const { adapter, child, failure } = started();
    const request = adapter.request('listMicrophones', {}); const rejection = expect(request).rejects.toThrow();
    child.emit('exit', 1, null); child.emit('error', new Error('late duplicate'));
    await rejection; expect(adapter.ready).toBe(false); expect(failure).toHaveBeenCalledTimes(1); expect(child.killed).toBe(true);
  });

  it('awaits orderly helper exit without reporting an availability failure', async () => {
    const { adapter, child, failure } = started();
    const shutdown = adapter.shutdown(); child.emit('exit', 0, null); await shutdown;
    expect(adapter.ready).toBe(false); expect(failure).not.toHaveBeenCalled();
  });
  it('bounds orderly shutdown and kills a helper that does not exit', async () => {
    vi.useFakeTimers();
    try {
      const { adapter, child, failure } = started(); const shutdown = adapter.shutdown();
      await vi.advanceTimersByTimeAsync(1999); expect(child.killed).toBe(false);
      await vi.advanceTimersByTimeAsync(1); await shutdown;
      expect(child.killed).toBe(true); expect(failure).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});
