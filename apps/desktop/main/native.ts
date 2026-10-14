import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { parseEnvelope, MAX_CONTROL_BYTES, transcriptUpdateSchema, finalTranscriptSchema, type Envelope, type Microphone, type PlaybackDevice, type Settings, type TranscriptUpdate } from '../../../packages/core/src/contracts';
import { AppError } from '../../../packages/core/src/errors';
import type { Insertion, Target } from '../../../packages/core/src/session';
import { MAX_ASSISTANT_SELECTION_BYTES, type AssistantSelection } from '../../../packages/core/src/assistant';
import { PerformanceRecorder } from '../../../packages/core/src/performance';
import type { NativeHotkeyEvent } from './hotkeys';

const audioDeviceSchema = z.array(z.object({ id: z.string().max(512), name: z.string().max(512), isDefault: z.boolean() }).strict()).max(256)
  .refine(value => value.filter(device => device.isDefault).length <= 1, 'Multiple default audio devices were reported.');
const audioLevelSchema = z.object({ level: z.number().int().min(0).max(100) }).strict();
const workerReadySchema = z.object({ workerPid: z.number().int().positive().max(0xffffffff) }).strict();
const timingSchema = z.object({ stage: z.enum(['shortcutRecognition', 'microphoneOpen', 'firstAudioFrame', 'previewRecognition', 'finalRecognition', 'pasteDispatch', 'clipboardRestoration']), durationMs: z.number().finite().min(0).max(86400000) }).strict();
const assistantSelectionSchema = z.object({
  target: z.unknown(),
  text: z.string().min(1).max(MAX_ASSISTANT_SELECTION_BYTES).refine(value => value.trim().length > 0 && Buffer.byteLength(value) <= MAX_ASSISTANT_SELECTION_BYTES && !value.includes('\0')),
  bounds: z.object({ x: z.number().int(), y: z.number().int(), width: z.number().int().positive(), height: z.number().int().positive() }).strict(),
  capture: z.enum(['automation', 'clipboard']),
}).strict().transform(value => ({ ...value, target: { opaque: value.target } } satisfies AssistantSelection));
type NativeProcess = ChildProcessWithoutNullStreams;
type NativeLauncher = (binary: string, worker: string, generation: number, environment?: NodeJS.ProcessEnv) => NativeProcess;
const launchNative: NativeLauncher = (binary, worker, generation, environment) => spawn(binary, ['--generation', String(generation), '--worker', worker], { stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true, env: { ...process.env, ...environment } });
export class NativeAdapter {
  private process: NativeProcess | null = null;
  private generation = 0;
  private sequence = -1;
  private incoming = '';
  private pending = new Map<string, { resolve: (event: Envelope) => void; reject: (reason: unknown) => void; timer: ReturnType<typeof setTimeout>; cleanup: () => void }>();
  private abandoned = new Set<string>();
  private shuttingDown = false;
  private preparedModel: string | null = null;
  private preparation: { path: string; promise: Promise<void> } | null = null;
  private transcriptWatch: { id: string; listener: (update: TranscriptUpdate) => void } | null = null;
  private transcriptWatermark: { id: string; revision: number; watermark: number } | null = null;
  ready = false;
  onReady: () => void = () => undefined;
  onHotkey: (type: NativeHotkeyEvent) => void = () => undefined;
  onAudioLevel: (level: number) => void = () => undefined;
  onPasteDispatched: (id: string) => void = () => undefined;
  onSelectionChanged: () => void = () => undefined;
  onFocusChanged: () => void = () => undefined;
  onFailure: () => void = () => undefined;
  constructor(private readonly binary: string, private readonly worker: string, private readonly launch: NativeLauncher = launchNative, private readonly timings = new PerformanceRecorder(), private readonly environment?: NodeJS.ProcessEnv) {}
  start(): void {
    if (this.process) return;
    const generation = ++this.generation; this.sequence = -1; this.incoming = ''; this.abandoned.clear(); this.shuttingDown = false;
    const child = this.launch(this.binary, this.worker, generation, this.environment);
    this.process = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (data: string) => {
      if (this.process !== child) return;
      this.incoming += data;
      if (Buffer.byteLength(this.incoming) > MAX_CONTROL_BYTES * 2) { this.crash(child); return; }
      for (;;) {
        const index = this.incoming.indexOf('\n'); if (index < 0) break;
        const line = this.incoming.slice(0, index); this.incoming = this.incoming.slice(index + 1);
        try {
          const event = parseEnvelope(line);
          if (event.generation !== generation || event.sequence <= this.sequence) throw new AppError('native_order');
          this.sequence = event.sequence;
          if (event.type === 'ready') { this.ready = true; this.onReady(); continue; }
          if (event.type === 'workerUnavailable') { this.preparedModel = null; continue; }
          if (event.type === 'timing') { const value = timingSchema.parse(event.payload); this.timings.record(value.stage, value.durationMs); continue; }
          if (event.type === 'transcriptUpdate') {
            const update = transcriptUpdateSchema.parse(event.payload);
            if (!event.sessionId) throw new AppError('transcript_session');
            const watch = this.transcriptWatch;
            const watermark = this.transcriptWatermark;
            if (watermark?.id === event.sessionId) {
              if (update.revision <= watermark.revision || update.audioEndSample < watermark.watermark) throw new AppError('transcript_order');
              watermark.revision = update.revision; watermark.watermark = update.audioEndSample;
              if (watch?.id === event.sessionId) watch.listener(update);
            }
            continue;
          }
          if (event.type === 'pasteDispatched') {
            z.object({}).strict().parse(event.payload);
            if (!event.sessionId) throw new AppError('insertion_session');
            this.onPasteDispatched(event.sessionId); continue;
          }
          if (this.abandoned.delete(event.requestId)) continue;
          const pending = this.pending.get(event.requestId);
          if (pending) { this.pending.delete(event.requestId); clearTimeout(pending.timer); pending.cleanup(); if (event.type === 'error') { this.preparedModel = null; pending.reject(new AppError('native_failed')); } else pending.resolve(event); }
          else if (event.type === 'started' || event.type === 'stopped' || event.type === 'cancel' || event.type === 'meeting') {
            z.object({}).strict().parse(event.payload); this.onHotkey(event.type);
          }
          else if (event.type === 'selectionChanged' || event.type === 'focusChanged') {
            z.object({}).strict().parse(event.payload);
            if (event.type === 'selectionChanged') this.onSelectionChanged(); else this.onFocusChanged();
          }
          else if (event.type === 'audioLevel') this.onAudioLevel(audioLevelSchema.parse(event.payload).level);
          else if (event.type === 'error') { this.preparedModel = null; this.onFailure(); }
        } catch { this.crash(child); return; }
      }
      if (Buffer.byteLength(this.incoming) > MAX_CONTROL_BYTES) this.crash(child);
    });
    child.stderr.on('data', () => undefined); // Native diagnostics may contain provider/device details; never persist them.
    child.on('error', () => this.crash(child)); child.on('exit', () => this.crash(child));
  }
  private crash(child: NativeProcess | null = this.process): void {
    if (!child || this.process !== child) return;
    this.process = null; this.ready = false; this.preparedModel = null; this.preparation = null; this.transcriptWatch = null; this.transcriptWatermark = null; child.kill();
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.cleanup(); p.reject(new AppError('native_exit')); }
    this.pending.clear(); this.abandoned.clear();
    if (!this.shuttingDown) this.onFailure();
  }
  private abandon(requestId: string): void {
    this.abandoned.add(requestId);
    if (this.abandoned.size > 32) {
      const oldest = this.abandoned.values().next().value;
      if (oldest) this.abandoned.delete(oldest);
    }
  }
  request(type: string, payload: unknown, sessionId: string | null = null, signal?: AbortSignal, timeout = 15000): Promise<Envelope> {
    const child = this.process;
    if (!child || !this.ready || signal?.aborted) return Promise.reject(new AppError('native_unavailable'));
    if (this.pending.size >= 16) return Promise.reject(new AppError('native_backpressure'));
    const requestId = randomUUID();
    const line = JSON.stringify({ version: 1, generation: this.generation, requestId, sessionId, type, payload }) + '\n';
    if (Buffer.byteLength(line) > MAX_CONTROL_BYTES) return Promise.reject(new AppError('native_size'));
    return new Promise((resolve, reject) => {
      const abort = () => { const p = this.pending.get(requestId); if (p) { this.pending.delete(requestId); this.abandon(requestId); clearTimeout(p.timer); p.cleanup(); reject(new AppError('canceled')); } };
      const timer = setTimeout(() => { this.pending.delete(requestId); signal?.removeEventListener('abort', abort); reject(new AppError('native_timeout')); this.crash(child); }, timeout);
      this.pending.set(requestId, { resolve, reject, timer, cleanup: () => signal?.removeEventListener('abort', abort) });
      signal?.addEventListener('abort', abort, { once: true });
      child.stdin.write(line, error => { if (error) this.crash(child); });
    });
  }
  async microphones(): Promise<Microphone[]> { return audioDeviceSchema.parse((await this.request('listMicrophones', {})).payload); }
  async playbackDevices(): Promise<PlaybackDevice[]> { return audioDeviceSchema.parse((await this.request('listPlaybackDevices', {})).payload); }
  async configure(settings: Settings): Promise<void> {
    if (!settings.enabled) this.preparedModel = null;
    await this.request('configure', { enabled: settings.enabled, hold: settings.holdShortcut, handsFree: settings.handsFreeShortcut });
    if (!settings.enabled) this.preparedModel = null;
  }
  async prepare(modelPath: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new AppError('canceled');
    if (this.preparedModel === modelPath) return;
    if (this.preparation) {
      if (this.preparation.path === modelPath) { await this.waitForPreparation(this.preparation.promise, signal); return; }
      await this.waitForPreparation(this.preparation.promise.catch(() => undefined), signal);
      return this.prepare(modelPath, signal);
    }
    const operation = this.timings.measure('workerPreparation', async () => {
      // Preparation is shared; cancel the session waiter, not another caller's worker.
      const response = await this.request('prepareWorker', { modelPath }, null, undefined, 65000);
      if (response.type !== 'workerReady') throw new AppError('worker_protocol');
      workerReadySchema.parse(response.payload);
      this.preparedModel = modelPath;
    });
    const promise = operation.finally(() => { if (this.preparation?.promise === promise) this.preparation = null; });
    this.preparation = { path: modelPath, promise };
    await this.waitForPreparation(promise, signal);
  }
  private waitForPreparation(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(new AppError('canceled'));
    return new Promise((resolve, reject) => {
      const abort = () => reject(new AppError('canceled'));
      signal.addEventListener('abort', abort, { once: true });
      void promise.then(() => { signal.removeEventListener('abort', abort); if (signal.aborted) reject(new AppError('canceled')); else resolve(); }, error => { signal.removeEventListener('abort', abort); reject(error); });
    });
  }
  async inspectTarget(signal: AbortSignal): Promise<Target> { return { opaque: (await this.request('inspectTarget', {}, null, signal)).payload }; }
  async inspectSelection(signal?: AbortSignal): Promise<AssistantSelection> {
    return assistantSelectionSchema.parse((await this.request('inspectSelection', {}, null, signal)).payload);
  }
  async registerAssistantWindow(handle: string): Promise<void> { await this.request('registerAssistantWindow', { handle }); }
  async capture(id: string, settings: Settings, modelPath: string, signal: AbortSignal): Promise<void> {
    await this.prepare(modelPath, signal);
    await this.request('startCapture', { captureMode: 'microphone', microphoneId: settings.microphoneId, modelPath, vocabulary: settings.vocabulary }, id, signal, 60000);
  }
  async captureMeeting(id: string, settings: Settings, modelPath: string, signal: AbortSignal): Promise<void> {
    await this.prepare(modelPath, signal);
    await this.request('startCapture', { captureMode: 'meeting', microphoneId: settings.microphoneId, playbackDeviceId: settings.playbackDeviceId, modelPath, vocabulary: settings.vocabulary }, id, signal, 60000);
  }
  async stop(id: string): Promise<void> { await this.request('stopCapture', {}, id); }
  watchTranscript(id: string, listener: (update: TranscriptUpdate) => void): () => void {
    if (this.transcriptWatch) throw new AppError('session_busy');
    const watch = { id, listener }; this.transcriptWatch = watch;
    this.transcriptWatermark = { id, revision: 0, watermark: 0 };
    return () => { if (this.transcriptWatch === watch) this.transcriptWatch = null; };
  }
  async transcript(id: string, signal: AbortSignal): Promise<string> {
    const result = await this.request('transcribe', {}, id, signal, 300000);
    if (result.type !== 'transcript' || result.sessionId !== id) throw new AppError('transcript_protocol');
    const final = finalTranscriptSchema.parse(result.payload), watermark = this.transcriptWatermark;
    if (watermark?.id === id && (final.revision <= watermark.revision || final.audioEndSample < watermark.watermark)) throw new AppError('transcript_watermark');
    return final.text;
  }
  async insert(id: string, target: Target, text: string, signal: AbortSignal): Promise<Insertion> {
    const event = await this.request('insertText', { target: target.opaque, text }, id, signal);
    return z.object({ outcome: z.enum(['notAttempted', 'attempted', 'uncertain']), reason: z.string().max(100) }).strict().parse(event.payload);
  }
  async replaceSelection(id: string, selection: AssistantSelection, text: string, signal: AbortSignal): Promise<Insertion> {
    const event = await this.request('replaceSelection', { selection: { ...selection, target: selection.target.opaque }, text }, id, signal);
    return z.object({ outcome: z.enum(['notAttempted', 'attempted', 'uncertain']), reason: z.string().max(100) }).strict().parse(event.payload);
  }
  invalidate(id: string): void { void this.request('invalidate', {}, id).catch(() => undefined); }
  async discard(id: string): Promise<void> {
    if (this.ready) await this.request('discard', {}, id);
    if (this.transcriptWatermark?.id === id) this.transcriptWatermark = null;
  }
  async testMicrophone(id: string): Promise<void> { await this.request('testMicrophone', { microphoneId: id }, null, undefined, 10000); }
  async shutdown(): Promise<void> {
    const child = this.process; if (!child) return;
    this.shuttingDown = true;
    await new Promise<void>(resolve => {
      let settled = false;
      const finish = () => { if (settled) return; settled = true; clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { this.crash(child); finish(); }, 2000);
      timer.unref(); child.once('exit', finish); child.once('error', finish); child.stdin.end();
    });
  }
}
