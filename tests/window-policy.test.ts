import { describe, expect, it, vi } from 'vitest';
import { ASSISTANT_LAYER_EXIT_MS, AssistantLayerTransition, keepRecordingLayerAboveOtherWindows, RECORDING_LAYER_EXIT_MS, RecordingLayerPointerRouter, RecordingLayerTransition, routeRecordingLayerPointerInput } from '../apps/desktop/main/window-policy';

describe('recording layer window policy', () => {
  it('uses Electron\'s highest documented Windows always-on-top level', () => {
    const setAlwaysOnTop = vi.fn();
    keepRecordingLayerAboveOtherWindows({ setAlwaysOnTop, setIgnoreMouseEvents: vi.fn() });
    expect(setAlwaysOnTop).toHaveBeenCalledOnce();
    expect(setAlwaysOnTop).toHaveBeenCalledWith(true, 'screen-saver');
  });
  it('keeps transparent compact margins click-through and only enables an allowed hovered action', () => {
    const setIgnoreMouseEvents = vi.fn();
    const window = { setAlwaysOnTop: vi.fn(), setIgnoreMouseEvents };
    routeRecordingLayerPointerInput(window, false, false, true);
    routeRecordingLayerPointerInput(window, false, true, true);
    routeRecordingLayerPointerInput(window, false, true, false);
    expect(setIgnoreMouseEvents.mock.calls).toEqual([[true, { forward: true }], [false, undefined], [true, { forward: true }]]);
  });
  it('keeps the fully visible expanded recorder interactive', () => {
    const setIgnoreMouseEvents = vi.fn();
    routeRecordingLayerPointerInput({ setAlwaysOnTop: vi.fn(), setIgnoreMouseEvents }, true, false, false);
    expect(setIgnoreMouseEvents).toHaveBeenCalledWith(false, undefined);
  });
  it('preserves hovered compact action input across status republishes and resets it outside allowed states', () => {
    const setIgnoreMouseEvents = vi.fn();
    const window = { setAlwaysOnTop: vi.fn(), setIgnoreMouseEvents };
    const router = new RecordingLayerPointerRouter();
    router.present(window, false, true);
    router.request(window, false, true, true);
    router.present(window, false, true);
    router.present(window, false, false);
    router.present(window, false, true);
    expect(setIgnoreMouseEvents.mock.calls).toEqual([
      [true, { forward: true }],
      [false, undefined],
      [false, undefined],
      [true, { forward: true }],
      [true, { forward: true }],
    ]);
  });
  it('keeps each outgoing layer mounted for its exit, coalesces updates and cancels a reversed transition', () => {
    vi.useFakeTimers();
    const present = vi.fn();
    const transition = new RecordingLayerTransition<string>(present);
    transition.update('idle', false);
    transition.update('starting recording', true);
    transition.update('newest recording snapshot', true);
    expect(present.mock.calls).toEqual([
      ['idle', false],
      ['idle', false, 'compact-exit'],
    ]);
    vi.advanceTimersByTime(RECORDING_LAYER_EXIT_MS - 1);
    expect(present).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(present).toHaveBeenLastCalledWith('newest recording snapshot', true);
    transition.update('paused', true);
    expect(present).toHaveBeenLastCalledWith('paused', true);
    transition.update('idle', false);
    expect(present).toHaveBeenLastCalledWith('paused', true, 'expanded-exit');
    vi.advanceTimersByTime(RECORDING_LAYER_EXIT_MS);
    expect(present).toHaveBeenLastCalledWith('idle', false);
    transition.update('second meeting', true);
    transition.update('failed', false);
    vi.advanceTimersByTime(RECORDING_LAYER_EXIT_MS);
    expect(present).toHaveBeenLastCalledWith('failed', false);
    expect(present).toHaveBeenCalledTimes(8);
    transition.dispose();
    vi.useRealTimers();
  });
  it('hands visibility between the recording and Assistant layers only after the outgoing layer exits', () => {
    vi.useFakeTimers();
    const present = vi.fn();
    const transition = new AssistantLayerTransition<string>(present);
    transition.update('default layer', false);
    transition.update('selection offered', true);
    transition.update('assistant recording', true);
    expect(present.mock.calls).toEqual([
      ['default layer', false],
      ['default layer', false, 'recording-exit'],
    ]);
    vi.advanceTimersByTime(ASSISTANT_LAYER_EXIT_MS);
    expect(present).toHaveBeenLastCalledWith('assistant recording', true);
    transition.update('selection cleared', false);
    expect(present).toHaveBeenLastCalledWith('assistant recording', true, 'assistant-exit');
    vi.advanceTimersByTime(ASSISTANT_LAYER_EXIT_MS);
    expect(present).toHaveBeenLastCalledWith('selection cleared', false);
    transition.dispose();
    vi.useRealTimers();
  });
});
