import { randomUUID } from 'node:crypto';
import { defaults, type DictationMode, type Settings, type Status, type TranscriptUpdate } from './contracts';
import { couldBeVoiceCommand, matchVoiceCommand, type VoiceCommandId } from './commands';
import { AppError, checkAbort } from './errors';
import { PerformanceRecorder } from './performance';

export interface Target { opaque: unknown }
export type Insertion = { outcome: 'notAttempted' | 'attempted' | 'uncertain'; reason: string };
export interface SessionPorts {
  inspectTarget(signal: AbortSignal): Promise<Target>;
  startCapture(id: string, settings: Settings, signal: AbortSignal): Promise<void>;
  stopCapture(id: string): Promise<void>;
  discard(id: string): Promise<void>;
  transcribe(id: string, settings: Settings, signal: AbortSignal): Promise<string>;
  watchTranscript?(id: string, listener: (update: TranscriptUpdate) => void): () => void;
  prepareCleanup?(account: string, signal: AbortSignal): Promise<void>;
  clean(text: string, settings: Settings, account: string, signal: AbortSignal, mode: DictationMode): Promise<string>;
  insert(id: string, target: Target, text: string, signal: AbortSignal): Promise<Insertion>;
  recordHistory(text: string, durationMs: number): Promise<void>;
  executeCommand(command: VoiceCommandId): Promise<void>;
  invalidate(id: string): void;
}
type Termination = 'cancel' | 'failure' | 'finish';
type Preparation = { ok: true } | { ok: false };
type Cleaned = { ok: true; text: string } | { ok: false };
interface Session {
  id: string;
  settings: Settings;
  account: string;
  mode: DictationMode;
  controller: AbortController;
  target: Target | null;
  stopping: boolean;
  attempted: boolean;
  ready: boolean;
  termination: Termination | null;
  release: Promise<void> | null;
  began: number;
  captureStartedAt: number | null;
  stoppedAt: number | null;
  feedbackRecorded: boolean;
  pasteRecorded: boolean;
  preparation: Promise<Preparation> | null;
  unwatch: (() => void) | null;
  draft: TranscriptUpdate | null;
  speculative: { transcript: string; controller: AbortController; result: Promise<Cleaned> } | null;
  cleanupRequests: number;
}
export class SessionCoordinator {
  private current: Session | null = null;
  private recovery: { text: string; expires: number } | null = null;
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private doneTimer: ReturnType<typeof setTimeout> | null = null;
  private enabled = false;
  private historyWrites = new Set<Promise<void>>();
  private status: Status = { phase: 'disabled', message: 'Disabled', canCopy: false };
  constructor(private readonly ports: SessionPorts, private readonly publish: (status: Status) => void, private readonly now = Date.now, private readonly timings = new PerformanceRecorder()) {}
  recordingVisible(): void {
    const session = this.current;
    if (!session?.ready || session.stopping || session.feedbackRecorded) return;
    session.feedbackRecorded = true; this.timings.record('recordingFeedback', this.timings.now() - session.began);
  }
  pasteDispatched(id: string): void {
    const session = this.current;
    if (!session || session.id !== id || session.termination || !session.attempted || session.stoppedAt === null || session.pasteRecorded) return;
    session.pasteRecorded = true;
    this.timings.record('releaseToPasteDispatch', this.timings.now() - session.stoppedAt);
  }
  private prepareCleanup(session: Session): Promise<Preparation> {
    session.preparation ??= this.timings.measure('tokenPreparation', () => this.ports.prepareCleanup?.(session.account, session.controller.signal) ?? Promise.resolve())
      .then(() => ({ ok: true as const }), () => ({ ok: false as const }));
    return session.preparation;
  }
  private async requestCleanup(session: Session, transcript: string, signal: AbortSignal): Promise<string> {
    checkAbort(signal);
    if (this.current !== session || session.termination || session.cleanupRequests >= 2) throw new AppError('stale_session');
    session.cleanupRequests += 1;
    return this.ports.clean(transcript, session.settings, session.account, signal, session.mode);
  }
  private receiveDraft(session: Session, update: TranscriptUpdate): void {
    if (this.current !== session || !session.ready || session.stopping || session.termination || session.controller.signal.aborted) return;
    const previous = session.draft;
    if (previous && (update.revision <= previous.revision || update.audioEndSample < previous.audioEndSample)) return;
    session.draft = update;
  }
  private startSpeculativeCleanup(session: Session, transcript: string): void {
    const text = transcript.trim();
    if (!text || session.speculative || this.current !== session || session.termination || session.controller.signal.aborted) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([session.controller.signal, controller.signal]);
    const result: Promise<Cleaned> = (async () => {
      if (!(await this.prepareCleanup(session)).ok) throw new AppError('reconnect');
      const cleaned = await this.timings.measure('speculativeCleanup', () => this.requestCleanup(session, text, signal));
      checkAbort(signal);
      if (!cleaned.trim() || cleaned.includes('\0')) throw new AppError('invalid_output');
      return { ok: true as const, text: cleaned };
    })().catch(() => ({ ok: false as const }));
    session.speculative = { transcript: text, controller, result };
  }
  private stopWatching(session: Session): void {
    session.unwatch?.(); session.unwatch = null; session.draft = null;
  }
  async shutdown(): Promise<void> {
    this.setEnabled(false);
    await this.current?.release?.catch(() => undefined);
    await Promise.all([...this.historyWrites]);
  }
  getStatus(): Status { return { ...this.status }; }
  private emit(phase: Status['phase'], message: string, canCopy = false): void { this.status = { phase, message, canCopy }; this.publish(this.getStatus()); }
  private clearRecovery(): void { this.recovery = null; if (this.recoveryTimer) clearTimeout(this.recoveryTimer); this.recoveryTimer = null; }
  private offerRecovery(text: string): void {
    this.recovery = { text, expires: this.now() + 60000 };
    this.recoveryTimer = setTimeout(() => {
      this.clearRecovery();
      if (!this.current) this.emit(this.enabled ? 'idle' : 'disabled', this.enabled ? 'Ready' : 'Disabled');
    }, 60000);
    this.recoveryTimer.unref();
    this.emit('blocked', 'Insertion blocked', true);
  }
  private clearDone(): void { if (this.doneTimer) clearTimeout(this.doneTimer); this.doneTimer = null; }
  private showDone(): void {
    this.clearDone();
    if (!this.enabled) { this.emit('disabled', 'Disabled'); return; }
    this.emit('done', 'Done');
    this.doneTimer = setTimeout(() => {
      this.doneTimer = null;
      if (!this.current && this.status.phase === 'done') this.emit(this.enabled ? 'idle' : 'disabled', this.enabled ? 'Ready' : 'Disabled');
    }, 1500);
    this.doneTimer.unref();
  }
  setEnabled(value: boolean): void { this.clearDone(); this.enabled = value; if (!value) this.cancel(); if (!this.current) this.emit(value ? 'idle' : 'disabled', value ? 'Ready' : 'Disabled'); }
  async start(settings: Settings = defaults, account: string | null = null, mode: DictationMode = 'dictation'): Promise<string | null> {
    if (!this.enabled) return null;
    if (this.current || this.historyWrites.size >= 16) { this.publish({ phase: 'busy', message: 'Busy', canCopy: false }); return null; }
    this.clearDone();
    this.clearRecovery();
    if (!account) { this.emit('unavailable', 'Sorry, not available'); return null; }
    const session: Session = {
      id: randomUUID(), settings: structuredClone(settings), account, mode, controller: new AbortController(), target: null,
      stopping: false, attempted: false, ready: false, termination: null, release: null,
      began: this.timings.now(), captureStartedAt: null, stoppedAt: null, feedbackRecorded: false, pasteRecorded: false,
      preparation: null, unwatch: null, draft: null, speculative: null, cleanupRequests: 0,
    };
    this.current = session;
    try {
      session.target = await this.timings.measure('targetInspection', () => this.ports.inspectTarget(session.controller.signal)); checkAbort(session.controller.signal);
      session.unwatch = this.ports.watchTranscript?.(session.id, update => this.receiveDraft(session, update)) ?? null;
      await this.timings.measure('captureStart', () => this.ports.startCapture(session.id, session.settings, session.controller.signal)); checkAbort(session.controller.signal);
      if (this.current !== session) return null;
      session.captureStartedAt = this.timings.now();
      session.ready = true;
      void this.prepareCleanup(session);
      this.timings.record('startToCapture', this.timings.now() - session.began);
      this.emit('recording', 'Recording · Esc to cancel'); return session.id;
    } catch { await this.fail(session); return null; }
  }
  async stop(): Promise<void> {
    const session = this.current; if (!session || session.stopping) return;
    if (!session.ready) { this.cancel(); return; }
    session.stopping = true;
    const latestDraft = session.draft?.text.trim() ?? '';
    this.stopWatching(session);
    session.stoppedAt = this.timings.now();
    if (session.mode === 'command' || !couldBeVoiceCommand(latestDraft)) this.startSpeculativeCleanup(session, latestDraft);
    const signal = session.controller.signal;
    // Attach rejection handling immediately: silence/cancellation may never consume this result.
    const preparation = this.prepareCleanup(session);
    try {
      await this.timings.measure('stopDrain', () => this.ports.stopCapture(session.id)); checkAbort(signal);
      this.emit('transcribing', 'Processing');
      const transcript = await this.timings.measure('transcription', () => this.ports.transcribe(session.id, session.settings, signal)); checkAbort(signal);
      if (!transcript.trim()) { await this.finish(session); return; }
      const command = session.mode === 'dictation' ? matchVoiceCommand(transcript) : null;
      if (command) { await this.completeCommand(session, command); return; }
      if (!(await preparation).ok) throw new AppError('reconnect');
      checkAbort(signal);
      this.emit('cleaning', 'Processing');
      const text = await this.timings.measure('cleanup', async () => {
        const candidate = session.speculative;
        if (candidate && candidate.transcript === transcript.trim()) {
          const result = await candidate.result; checkAbort(signal);
          if (result.ok) { this.timings.record('speculativeHit', 0); return result.text; }
        }
        candidate?.controller.abort(); this.timings.record('speculativeMiss', 0);
        return this.requestCleanup(session, transcript, signal);
      }); checkAbort(signal);
      if (!text.trim() || text.includes('\0')) throw new AppError('invalid_output');
      if (this.current !== session || session.attempted || !session.target) throw new AppError('stale_session');
      session.attempted = true; // Reserve ownership before dispatch, including an uncertain outcome.
      this.emit('inserting', 'Processing');
      const target = session.target;
      const outcome = await this.timings.measure('insertion', () => this.ports.insert(session.id, target, text, signal)); checkAbort(signal);
      this.timings.record('releaseToInsertion', this.timings.now() - session.stoppedAt);
      if (outcome.outcome !== 'attempted') {
        if (await this.finish(session, true, text)) this.offerRecovery(text);
        return;
      }
      await this.finish(session, false, text);
    } catch { await this.fail(session); }
  }
  cancel(): void {
    void this.cancelAndWait();
  }
  async cancelAndWait(): Promise<void> {
    this.clearDone();
    this.clearRecovery();
    const session = this.current;
    if (!session) { this.emit(this.enabled ? 'idle' : 'disabled', this.enabled ? 'Ready' : 'Disabled'); return; }
    if (!session.termination) {
      session.termination = 'cancel';
      this.invalidate(session);
    }
    // A terminal path may already own the same id. Its release promise is the
    // barrier that prevents meeting capture from racing the native session.
    if (session.termination !== 'cancel') {
      await session.release?.catch(() => undefined);
      return;
    }
    // Keep ownership until native release completes, preventing overlapping capture.
    await this.release(session).catch(() => undefined);
    if (this.current === session) {
      this.current = null;
      this.emit(this.enabled ? 'idle' : 'disabled', this.enabled ? 'Ready' : 'Disabled');
    }
  }
  unavailable(): void { this.clearDone(); const session = this.current; if (session) void this.fail(session); else { this.clearRecovery(); this.emit('unavailable', 'Sorry, not available'); } }
  copyRecovery(write: (text: string) => void): boolean {
    const recovery = this.recovery;
    if (!recovery || recovery.expires <= this.now()) {
      this.clearRecovery();
      if (!this.current) this.emit(this.enabled ? 'idle' : 'disabled', this.enabled ? 'Ready' : 'Disabled');
      return false;
    }
    write(recovery.text);
    this.clearRecovery();
    if (!this.current) this.emit(this.enabled ? 'idle' : 'disabled', this.enabled ? 'Ready' : 'Disabled');
    return true;
  }
  private async completeCommand(session: Session, command: VoiceCommandId): Promise<void> {
    try { await this.release(session); }
    catch {
      if (this.current === session) {
        session.termination = 'failure'; session.controller.abort(); this.current = null;
        this.emit('unavailable', 'Sorry, not available');
      }
      return;
    }
    if (this.current !== session || session.termination) return;
    session.termination = 'finish'; session.controller.abort(); this.current = null;
    if (session.stoppedAt !== null) this.timings.record('releaseToDone', this.timings.now() - session.stoppedAt);
    try {
      await this.ports.executeCommand(command);
      this.emit(this.enabled ? 'idle' : 'disabled', this.enabled ? 'Ready' : 'Disabled');
    } catch { this.emit('unavailable', 'Sorry, not available'); }
  }
  private async finish(session: Session, preserve = false, historyText?: string): Promise<boolean> {
    if (session.termination) return false;
    session.termination = 'finish';
    try { await this.release(session); }
    catch {
      if (this.current !== session) return false;
      this.current = null; this.clearRecovery(); this.emit('unavailable', 'Sorry, not available'); return false;
    }
    if (this.current !== session) return false;
    session.controller.abort();
    this.current = null;
    if (!preserve) this.showDone();
    if (session.stoppedAt !== null) this.timings.record('releaseToDone', this.timings.now() - session.stoppedAt);
    if (historyText) {
      const durationMs = session.captureStartedAt === null || session.stoppedAt === null ? 0 : Math.max(0, Math.round(session.stoppedAt - session.captureStartedAt));
      const write = this.timings.measure('history', () => this.ports.recordHistory(historyText, durationMs)).catch(() => undefined);
      this.historyWrites.add(write);
      void write.finally(() => this.historyWrites.delete(write));
    }
    return true;
  }
  private async fail(session: Session): Promise<void> {
    if (session.termination === 'cancel') { await this.release(session).catch(() => undefined); return; }
    if (session.termination) return;
    session.termination = 'failure';
    this.invalidate(session);
    await this.release(session).catch(() => undefined);
    if (this.current !== session) return;
    this.current = null; this.clearRecovery();
    this.emit('unavailable', 'Sorry, not available');
  }
  private invalidate(session: Session): void {
    this.stopWatching(session); session.speculative?.controller.abort();
    try { this.ports.invalidate(session.id); }
    finally { session.controller.abort(); }
  }
  private release(session: Session): Promise<void> {
    this.stopWatching(session); session.speculative?.controller.abort();
    session.release ??= this.timings.measure('nativeRelease', () => Promise.resolve().then(() => this.ports.discard(session.id)));
    return session.release;
  }
}
