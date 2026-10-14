export interface RecordingLayerWindow {
  setAlwaysOnTop(flag: boolean, level: 'screen-saver'): void;
  setIgnoreMouseEvents(ignore: boolean, options?: { forward: boolean }): void;
}

export const RECORDING_LAYER_EXIT_MS = 280;
export const ASSISTANT_LAYER_EXIT_MS = 280;

export type RecordingLayerTransitionPhase = 'compact-exit' | 'expanded-exit';

type Timer = ReturnType<typeof setTimeout>;

export type AssistantLayerTransitionPhase = 'recording-exit' | 'assistant-exit';

export class AssistantLayerTransition<T> {
  private assistantActive = false;
  private timer: Timer | null = null;
  private pending: T | null = null;
  private current: T | null = null;

  constructor(private readonly present: (value: T, assistantActive: boolean, transition?: AssistantLayerTransitionPhase) => void) {}

  update(value: T, assistantActive: boolean): void {
    if (this.timer) {
      if (assistantActive === this.assistantActive) {
        clearTimeout(this.timer);
        this.timer = null;
        this.pending = null;
        this.current = value;
        this.present(value, assistantActive);
      } else {
        this.pending = value;
      }
      return;
    }
    if (assistantActive !== this.assistantActive) {
      this.pending = value;
      const outgoing = this.current ?? value;
      this.present(outgoing, this.assistantActive, this.assistantActive ? 'assistant-exit' : 'recording-exit');
      this.timer = setTimeout(() => {
        this.timer = null;
        const pending = this.pending;
        this.pending = null;
        if (pending === null) return;
        this.assistantActive = assistantActive;
        this.current = pending;
        this.present(pending, assistantActive);
      }, ASSISTANT_LAYER_EXIT_MS);
      return;
    }
    this.current = value;
    this.present(value, assistantActive);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
    this.current = null;
  }
}

export class RecordingLayerTransition<T> {
  private mode: 'compact' | 'expanded' = 'compact';
  private timer: Timer | null = null;
  private pending: T | null = null;
  private current: T | null = null;

  constructor(private readonly present: (value: T, expanded: boolean, transition?: RecordingLayerTransitionPhase) => void) {}

  update(value: T, expanded: boolean): void {
    const targetMode = expanded ? 'expanded' : 'compact';
    if (this.timer) {
      if (targetMode === this.mode) {
        clearTimeout(this.timer);
        this.timer = null;
        this.pending = null;
        this.current = value;
        this.present(value, expanded);
      } else {
        this.pending = value;
      }
      return;
    }
    if (targetMode !== this.mode) {
      this.pending = value;
      const outgoing = this.current ?? value;
      this.present(outgoing, this.mode === 'expanded', this.mode === 'expanded' ? 'expanded-exit' : 'compact-exit');
      this.timer = setTimeout(() => {
        this.timer = null;
        const pending = this.pending;
        this.pending = null;
        if (pending === null) return;
        this.mode = targetMode;
        this.current = pending;
        this.present(pending, expanded);
      }, RECORDING_LAYER_EXIT_MS);
      return;
    }
    this.current = value;
    this.present(value, expanded);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
    this.current = null;
  }
}

export function keepRecordingLayerAboveOtherWindows(window: RecordingLayerWindow): void {
  window.setAlwaysOnTop(true, 'screen-saver');
}

export function routeRecordingLayerPointerInput(window: RecordingLayerWindow, expanded: boolean, requested: boolean, allowed: boolean): void {
  const ignore = !expanded && !(requested && allowed);
  window.setIgnoreMouseEvents(ignore, ignore ? { forward: true } : undefined);
}

export class RecordingLayerPointerRouter {
  private requested = false;

  present(window: RecordingLayerWindow, expanded: boolean, allowed: boolean): void {
    if (expanded || !allowed) this.requested = false;
    routeRecordingLayerPointerInput(window, expanded, this.requested, allowed);
  }

  request(window: RecordingLayerWindow, expanded: boolean, requested: boolean, allowed: boolean): void {
    this.requested = !expanded && allowed && requested;
    routeRecordingLayerPointerInput(window, expanded, this.requested, allowed);
  }
}
