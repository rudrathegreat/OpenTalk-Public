export type TimingStage = 'shortcutRecognition' | 'targetInspection' | 'captureStart' | 'microphoneOpen' | 'firstAudioFrame' | 'recordingFeedback' | 'startToCapture' | 'stopDrain' | 'transcription' | 'tokenPreparation' | 'cleanupFirstOutput' | 'cleanupCompleted' | 'cleanup' | 'insertion' | 'releaseToInsertion' | 'nativeRelease' | 'releaseToDone' | 'history' | 'workerPreparation' | 'previewRecognition' | 'finalRecognition' | 'speculativeCleanup' | 'speculativeHit' | 'speculativeMiss' | 'pasteDispatch' | 'clipboardRestoration' | 'releaseToPasteDispatch';
export interface Timing { stage: TimingStage; durationMs: number; outcome: 'ok' | 'error' }

// Disabled by default. The sink receives only an allowlisted stage, duration and outcome.
export class PerformanceRecorder {
  constructor(private readonly sink?: (timing: Timing) => void, private readonly clock = () => performance.now()) {}
  now(): number { return this.clock(); }
  record(stage: TimingStage, durationMs: number, outcome: Timing['outcome'] = 'ok'): void {
    if (!this.sink || !Number.isFinite(durationMs) || durationMs < 0 || durationMs > 24 * 60 * 60 * 1000) return;
    try { this.sink({ stage, durationMs: Math.round(durationMs * 10) / 10, outcome }); } catch { /* Diagnostics cannot affect a dictation. */ }
  }
  async measure<T>(stage: TimingStage, operation: () => Promise<T>): Promise<T> {
    const began = this.now();
    try { const value = await operation(); this.record(stage, this.now() - began); return value; }
    catch (error) { this.record(stage, this.now() - began, 'error'); throw error; }
  }
}
