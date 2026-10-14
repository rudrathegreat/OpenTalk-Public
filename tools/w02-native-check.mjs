import { randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const modes = new Set(['capture', 'insertion', 'cancel', 'focus-change', 'quit']);
const args = new Map(process.argv.slice(2).map(value => {
  const [key, ...rest] = value.split('='); return [key, rest.join('=')];
}));
const mode = args.get('--mode');
if (!mode || !modes.has(mode)) throw new Error('Use --mode=capture|insertion|cancel|focus-change|quit.');
const sample = Number(args.get('--sample') ?? 0);
if (mode === 'capture' && ![1, 2, 3].includes(sample)) throw new Error('Capture mode requires --sample=1, --sample=2, or --sample=3.');

const helperPath = resolve('native/bin/opentalk-helper.exe');
const workerPath = resolve('native/bin/opentalk-worker.exe');
const targetScript = resolve('tools/w02-disposable-target.ps1');
const runtimeRoot = resolve('.runtime');
const runtime = join(runtimeRoot, `w02-${randomUUID()}`);
if (!runtime.startsWith(runtimeRoot + sep)) throw new Error('invalid runtime path');
const statePath = join(runtime, 'target-state.json');
const commandPath = join(runtime, 'target-command.json');
const settingsPath = join(process.env.APPDATA ?? '', 'OpenTalk', 'settings.json');
const fixedText = 'W02 \u2713 caf\u00e9 \u2014 \u6771\u4eac';
const expected = new Map([
  [1, ['violet', 'river']],
  [2, ['amber', 'lantern']],
  [3, ['quiet', 'orbit']],
]);
let commandSequence = 0;
let target = null;
let targetProcessId = null;
let helper = null;
let sessionId = null;

class NativeFailure extends Error {
  constructor(operation, code, priorCode = null) {
    super(`${operation}: ${code}${priorCode ? ` (preceded by ${priorCode})` : ''}`);
    this.operation = operation; this.code = code; this.priorCode = priorCode;
  }
}

class NativeClient {
  constructor(child) {
    this.child = child;
    this.generation = 1;
    this.pending = new Map();
    this.hotkeys = [];
    this.hotkeyWaiters = [];
    this.unsolicitedFailures = [];
    this.incoming = '';
    this.ready = new Promise((accept, reject) => { this.readyAccept = accept; this.readyReject = reject; });
    this.exited = new Promise(resolveExit => child.once('exit', (code, signal) => resolveExit({ code, signal })));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', data => this.consume(data));
    child.stderr.on('data', () => undefined);
    child.once('error', error => this.fail(error));
    child.once('exit', () => this.fail(new Error('native helper exited')));
  }
  consume(data) {
    this.incoming += data;
    for (;;) {
      const index = this.incoming.indexOf('\n');
      if (index < 0) return;
      const line = this.incoming.slice(0, index); this.incoming = this.incoming.slice(index + 1);
      let event;
      try { event = JSON.parse(line); } catch { this.fail(new Error('invalid native event')); continue; }
      if (event.type === 'ready') { this.readyAccept(); continue; }
      if (['started', 'stopped', 'cancel'].includes(event.type) && !this.pending.has(event.requestId)) {
        const waiter = this.hotkeyWaiters.shift();
        if (waiter) waiter.resolve(event.type); else this.hotkeys.push(event.type);
        continue;
      }
      const pending = this.pending.get(event.requestId);
      if (!pending) {
        if (event.type === 'error') this.unsolicitedFailures.push(String(event.payload?.code ?? 'native_failed'));
        continue;
      }
      this.pending.delete(event.requestId); clearTimeout(pending.timer);
      if (event.type === 'error') pending.reject(new NativeFailure(pending.operation, String(event.payload?.code ?? 'native_failed'), this.unsolicitedFailures.at(-1) ?? null));
      else pending.resolve(event);
    }
  }
  fail(error) {
    this.readyReject(error);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    for (const waiter of this.hotkeyWaiters) waiter.reject(error);
    this.hotkeyWaiters = [];
  }
  request(type, payload, requestSession = null, timeoutMs = 300000) {
    const requestId = randomUUID();
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); rejectRequest(new Error(`native timeout: ${type}`)); }, timeoutMs);
      this.pending.set(requestId, { operation: type, resolve: resolveRequest, reject: rejectRequest, timer });
      this.child.stdin.write(`${JSON.stringify({ version: 1, generation: this.generation, requestId, sessionId: requestSession, type, payload })}\n`);
    });
  }
  nextHotkey(timeoutMs = 180000) {
    if (this.hotkeys.length) return Promise.resolve(this.hotkeys.shift());
    return new Promise((resolveHotkey, rejectHotkey) => {
      const waiter = {
        resolve: value => { clearTimeout(timer); resolveHotkey(value); },
        reject: error => { clearTimeout(timer); rejectHotkey(error); },
      };
      const timer = setTimeout(() => {
        const index = this.hotkeyWaiters.indexOf(waiter); if (index >= 0) this.hotkeyWaiters.splice(index, 1);
        rejectHotkey(new Error('physical shortcut timeout'));
      }, timeoutMs);
      this.hotkeyWaiters.push(waiter);
    });
  }
}

function delay(milliseconds) { return new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds)); }
async function waitFor(fn, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const value = await fn(); if (value) return value; } catch { /* retry transient file reads */ }
    await delay(75);
  }
  throw new Error(message);
}
async function readState() { return JSON.parse(await readFile(statePath, 'utf8')); }
async function command(action) {
  const next = { sequence: ++commandSequence, action };
  const temporary = `${commandPath}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(next), { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, commandPath);
  await waitFor(async () => (await readState()).commandSequence >= next.sequence, 5000, `target command timeout: ${action}`);
}
async function exists(path) { try { await access(path); return true; } catch { return false; } }
async function processPresent(image) {
  const { stdout } = await execFileAsync('tasklist.exe', ['/FI', `IMAGENAME eq ${image}`, '/NH', '/FO', 'CSV'], { windowsHide: true });
  return stdout.toLocaleLowerCase('en').includes(`"${image.toLocaleLowerCase('en')}"`);
}
async function expectNativeError(operation, allowed) {
  try { await operation; } catch (error) {
    if (error instanceof NativeFailure && allowed.includes(error.code)) return error.code;
    throw error;
  }
  throw new Error('native request unexpectedly succeeded');
}
async function prepareTarget() {
  await mkdir(runtime, { recursive: false, mode: 0o700 });
  target = spawn('powershell.exe', ['-NoProfile', '-Sta', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', targetScript, '-StatePath', statePath, '-CommandPath', commandPath], {
    stdio: ['ignore', 'ignore', 'ignore'], shell: false, windowsHide: false,
  });
  const state = await waitFor(async () => { const value = await readState(); return value.ready && value.active === 'primary' ? value : null; }, 15000, 'disposable target did not become ready');
  if (state.elevated) throw new Error('disposable target is elevated; ordinary privilege is required');
  if (!Number.isInteger(state.processId) || state.processId !== target.pid) throw new Error('disposable target process identity could not be verified');
  targetProcessId = state.processId;
}
async function prepareNative(settings) {
  if (await processPresent(basename(helperPath)) || await processPresent(basename(workerPath))) throw new Error('a native dictation process is already running');
  const child = spawn(helperPath, ['--generation', '1', '--worker', workerPath], { stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true });
  helper = new NativeClient(child);
  await Promise.race([helper.ready, delay(10000).then(() => { throw new Error('native ready timeout'); })]);
  const devices = await helper.request('listMicrophones', {});
  if (!settings.microphoneId || !Array.isArray(devices.payload) || !devices.payload.some(device => device?.id === settings.microphoneId)) {
    throw new Error('the saved microphone is missing or unavailable');
  }
  await helper.request('configure', { enabled: true, hold: settings.holdShortcut, handsFree: settings.handsFreeShortcut });
}
async function beginFromPhysicalShortcut(settings) {
  const event = await helper.nextHotkey();
  if (event !== 'started') throw new Error(`expected start shortcut, received ${event}`);
  const inspected = await helper.request('inspectTarget', {});
  if (inspected.payload?.process !== targetProcessId) throw new Error('shortcut began outside the disposable target; capture was not started');
  sessionId = randomUUID();
  const completion = helper.nextHotkey();
  await helper.request('prepareWorker', { modelPath: settings.modelPath }, null, 65000);
  await helper.request('startCapture', { microphoneId: settings.microphoneId, modelPath: settings.modelPath, vocabulary: [] }, sessionId, 60000);
  return { target: inspected.payload, completion };
}
async function stopFromPhysicalShortcut(completion) {
  const event = await completion;
  if (event !== 'stopped') throw new Error(`expected stop shortcut, received ${event}`);
  await helper.request('stopCapture', {}, sessionId, 30000);
}
async function discard() {
  if (!sessionId || !helper) return;
  await helper.request('discard', {}, sessionId, 30000).catch(() => undefined);
  sessionId = null;
}
async function runCapture(settings) {
  console.log(JSON.stringify({ status: 'READY', mode, sample, instruction: 'physical-start-stop' }));
  const active = await beginFromPhysicalShortcut(settings);
  await stopFromPhysicalShortcut(active.completion);
  const transcript = await helper.request('transcribe', {}, sessionId, 300000);
  const text = typeof transcript.payload?.text === 'string' ? transcript.payload.text : '';
  const normalized = text.normalize('NFKD').toLocaleLowerCase('en');
  const keywords = expected.get(sample);
  const matches = keywords.filter(keyword => normalized.includes(keyword));
  if (!text.trim() || matches.length !== keywords.length) throw new Error(`capture ${sample} was not intelligible enough (${matches.length}/${keywords.length} markers)`);
  const completedId = sessionId;
  await discard();
  const spoolRemoved = !(await exists(join(process.env.LOCALAPPDATA ?? '', 'OpenTalk', 'spool', completedId)));
  if (!spoolRemoved) throw new Error('capture spool remained after discard');
  console.log(JSON.stringify({ result: 'PASS', mode, sample, nonemptyTranscript: true, intelligibilityMarkers: matches.length, captureStopped: true, spoolRemoved }));
}
async function runInsertion(settings) {
  console.log(JSON.stringify({ status: 'READY', mode, instruction: 'physical-start-stop' }));
  const active = await beginFromPhysicalShortcut(settings);
  await stopFromPhysicalShortcut(active.completion);
  // The stop event is emitted when the first required modifier is released.
  // Let the paired key-up arrive before exercising the intentionally immediate fixed-text path.
  await delay(500);
  const outcome = await helper.request('insertText', { target: active.target, text: fixedText }, sessionId, 30000);
  if (outcome.payload?.outcome !== 'attempted') throw new Error(`fixed insertion was not attempted: ${String(outcome.payload?.reason ?? 'unknown')}`);
  let state;
  try {
    state = await waitFor(async () => { const value = await readState(); return value.primary === fixedText ? value : null; }, 5000, 'fixed Unicode text was not received exactly');
  } catch {
    const observed = await readState();
    const classification = observed.primary === '' ? 'empty' : observed.primary === fixedText + fixedText ? 'duplicate' : 'other';
    throw new Error(`fixed Unicode text was not received exactly (observed=${classification}, length=${String(observed.primary?.length ?? -1)}, focus=${String(observed.active)})`);
  }
  const duplicateCode = await expectNativeError(helper.request('insertText', { target: active.target, text: fixedText }, sessionId, 30000), ['insertion_duplicate_or_canceled']);
  const completedId = sessionId;
  await discard();
  const staleCode = await expectNativeError(helper.request('insertText', { target: active.target, text: fixedText }, completedId, 30000), ['session']);
  await delay(400);
  const finalState = await readState();
  if (finalState.primary !== fixedText || finalState.secondary !== '') throw new Error('duplicate or stale request changed the disposable target');
  console.log(JSON.stringify({ result: 'PASS', mode, exactUnicode: state.primary === fixedText, insertionCount: 1, duplicateAdditionalInsertion: 0, staleAdditionalInsertion: 0, duplicateCode, staleCode }));
}
async function runCancel(settings) {
  console.log(JSON.stringify({ status: 'READY', mode, instruction: 'physical-start-stop' }));
  const active = await beginFromPhysicalShortcut(settings);
  await stopFromPhysicalShortcut(active.completion);
  console.log(JSON.stringify({ status: 'AWAITING_CANCEL', mode, instruction: 'press-escape' }));
  const event = await helper.nextHotkey();
  if (event !== 'cancel') throw new Error(`expected cancel shortcut, received ${event}`);
  await helper.request('invalidate', {}, sessionId, 30000);
  const cancelCode = await expectNativeError(helper.request('insertText', { target: active.target, text: fixedText }, sessionId, 30000), ['insertion_duplicate_or_canceled']);
  await discard();
  const state = await readState();
  if (state.primary !== '' || state.secondary !== '') throw new Error('cancellation changed the disposable target');
  console.log(JSON.stringify({ result: 'PASS', mode, insertionCount: 0, cancelCode }));
}
async function runFocusChange(settings) {
  console.log(JSON.stringify({ status: 'READY', mode, instruction: 'physical-start-stop' }));
  const active = await beginFromPhysicalShortcut(settings);
  await stopFromPhysicalShortcut(active.completion);
  await command('focus-secondary');
  const state = await waitFor(async () => { const value = await readState(); return value.active === 'secondary' ? value : null; }, 5000, 'controlled focus did not change');
  const outcome = await helper.request('insertText', { target: active.target, text: fixedText }, sessionId, 30000);
  await discard();
  const finalState = await readState();
  if (outcome.payload?.outcome !== 'notAttempted' || outcome.payload?.reason !== 'target_changed' || state.active !== 'secondary' || finalState.primary !== '' || finalState.secondary !== '') {
    throw new Error('focus-change guard did not produce zero insertion');
  }
  console.log(JSON.stringify({ result: 'PASS', mode, focusChanged: true, outcome: 'notAttempted', reason: 'target_changed', insertionCount: 0 }));
}
async function runQuit(settings) {
  console.log(JSON.stringify({ status: 'READY', mode, instruction: 'physical-start-only' }));
  const event = await helper.nextHotkey();
  if (event !== 'started') throw new Error(`expected start shortcut, received ${event}`);
  await helper.request('inspectTarget', {});
  sessionId = randomUUID();
  await helper.request('prepareWorker', { modelPath: settings.modelPath }, null, 65000);
  await helper.request('startCapture', { microphoneId: settings.microphoneId, modelPath: settings.modelPath, vocabulary: [] }, sessionId, 60000);
  const quittingId = sessionId;
  helper.child.stdin.end();
  const exit = await Promise.race([helper.exited, delay(15000).then(() => { throw new Error('helper quit timeout'); })]);
  await delay(500);
  const helperExited = !(await processPresent(basename(helperPath)));
  const workerExited = !(await processPresent(basename(workerPath)));
  const spoolRemoved = !(await exists(join(process.env.LOCALAPPDATA ?? '', 'OpenTalk', 'spool', quittingId)));
  sessionId = null;
  if (exit.code !== 0 || !helperExited || !workerExited || !spoolRemoved) throw new Error('quit did not release all native resources');
  console.log(JSON.stringify({ result: 'PASS', mode, captureWasActive: true, helperExited, workerExited, spoolRemoved }));
}

try {
  await access(helperPath); await access(workerPath); await access(targetScript);
  const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  if (!['base.en', 'small.en'].includes(settings.speechModel)) throw new Error('saved speech model is invalid');
  settings.modelPath = join(process.env.APPDATA ?? '', 'OpenTalk', 'models', `ggml-${settings.speechModel}.bin`);
  await access(settings.modelPath);
  await prepareTarget();
  await prepareNative(settings);
  if (mode === 'capture') await runCapture(settings);
  else if (mode === 'insertion') await runInsertion(settings);
  else if (mode === 'cancel') await runCancel(settings);
  else if (mode === 'focus-change') await runFocusChange(settings);
  else await runQuit(settings);
} finally {
  await discard().catch(() => undefined);
  if (helper?.child && helper.child.exitCode === null && helper.child.signalCode === null) {
    helper.child.stdin.end();
    await Promise.race([helper.exited, delay(3000)]).catch(() => undefined);
    if (helper.child.exitCode === null && helper.child.signalCode === null) helper.child.kill();
  }
  if (target && target.exitCode === null && target.signalCode === null) {
    await command('close').catch(() => undefined);
    await delay(300);
    if (target.exitCode === null && target.signalCode === null) target.kill();
  }
  await rm(runtime, { recursive: true, force: true }).catch(() => undefined);
}
