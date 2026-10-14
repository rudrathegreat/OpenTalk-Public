import { describe, expect, it, vi } from 'vitest';
import { HotkeyCoordinator, type HotkeyActions } from '../apps/desktop/main/hotkeys';

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function harness(changes: Partial<HotkeyActions> = {}) {
  const actions: HotkeyActions = {
    isMeetingActive: vi.fn(() => false),
    startDictation: vi.fn(async () => undefined),
    stopDictation: vi.fn(async () => undefined),
    cancelDictation: vi.fn(async () => undefined),
    startMeeting: vi.fn(async () => undefined),
    reportFailure: vi.fn(),
    ...changes,
  };
  return { actions, coordinator: new HotkeyCoordinator(actions) };
}

describe('hotkey coordinator', () => {
  it('waits for dictation release before starting meeting mode', async () => {
    const release = deferred();
    const { actions, coordinator } = harness({ cancelDictation: vi.fn(() => release.promise) });
    coordinator.handle('meeting');
    expect(actions.cancelDictation).toHaveBeenCalledTimes(1);
    expect(actions.startMeeting).not.toHaveBeenCalled();
    release.resolve();
    await vi.waitFor(() => expect(actions.startMeeting).toHaveBeenCalledTimes(1));
  });

  it('coalesces repeated meeting events while dictation release is pending', async () => {
    const release = deferred();
    const { actions, coordinator } = harness({ cancelDictation: vi.fn(() => release.promise) });
    coordinator.handle('meeting'); coordinator.handle('meeting'); coordinator.handle('started');
    expect(actions.cancelDictation).toHaveBeenCalledTimes(1);
    expect(actions.startDictation).not.toHaveBeenCalled();
    release.resolve();
    await vi.waitFor(() => expect(actions.startMeeting).toHaveBeenCalledTimes(1));
  });

  it('contains meeting startup failures and permits a later retry', async () => {
    const failure = new Error('synthetic meeting failure');
    const { actions, coordinator } = harness({ startMeeting: vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined) });
    coordinator.handle('meeting');
    await vi.waitFor(() => expect(actions.reportFailure).toHaveBeenCalledWith(failure));
    coordinator.handle('meeting');
    await vi.waitFor(() => expect(actions.startMeeting).toHaveBeenCalledTimes(2));
  });

  it('ignores dictation events while meeting mode is active', () => {
    const { actions, coordinator } = harness({ isMeetingActive: () => true });
    coordinator.handle('started'); coordinator.handle('stopped'); coordinator.handle('cancel'); coordinator.handle('meeting');
    expect(actions.startDictation).not.toHaveBeenCalled();
    expect(actions.stopDictation).not.toHaveBeenCalled();
    expect(actions.cancelDictation).not.toHaveBeenCalled();
    expect(actions.startMeeting).not.toHaveBeenCalled();
  });
});
