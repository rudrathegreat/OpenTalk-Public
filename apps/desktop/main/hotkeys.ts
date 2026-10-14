export type NativeHotkeyEvent = 'started' | 'stopped' | 'cancel' | 'meeting';

export interface HotkeyActions {
  isMeetingActive(): boolean;
  startDictation(): Promise<unknown>;
  stopDictation(): Promise<void>;
  cancelDictation(): Promise<void>;
  startMeeting(): Promise<void>;
  reportFailure(error: unknown): void;
}

/** Routes native events without allowing rejected async work to escape an event callback. */
export class HotkeyCoordinator {
  private meetingStart: Promise<void> | null = null;

  constructor(private readonly actions: HotkeyActions) {}

  handle(type: NativeHotkeyEvent): void {
    if (type === 'meeting') {
      this.beginMeeting();
      return;
    }
    if (this.meetingStart || this.actions.isMeetingActive()) return;
    const operation = type === 'started' ? this.actions.startDictation()
      : type === 'stopped' ? this.actions.stopDictation()
        : this.actions.cancelDictation();
    void operation.catch(error => this.actions.reportFailure(error));
  }

  private beginMeeting(): void {
    if (this.meetingStart || this.actions.isMeetingActive()) return;
    const operation = (async () => {
      await this.actions.cancelDictation();
      if (!this.actions.isMeetingActive()) await this.actions.startMeeting();
    })().catch(error => this.actions.reportFailure(error)).finally(() => {
      if (this.meetingStart === operation) this.meetingStart = null;
    });
    this.meetingStart = operation;
  }
}
