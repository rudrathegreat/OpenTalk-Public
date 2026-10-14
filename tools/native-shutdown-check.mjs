import { randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { access } from 'node:fs/promises';

const execFileAsync = promisify(execFile);
const helper = resolve('native/bin/opentalk-helper.exe');
const worker = resolve('native/bin/opentalk-worker.exe');
const model = process.argv[2] ?? join(process.env.APPDATA ?? '', 'OpenTalk', 'models', 'ggml-base.en.bin');
const generation = 1;
const child = spawn(helper, ['--generation', String(generation), '--worker', worker], {
  stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true,
});
const pending = new Map();
let incoming = '';
let readyResolve;
let readyReject;
const ready = new Promise((resolveReady, rejectReady) => { readyResolve = resolveReady; readyReject = rejectReady; });
const exited = new Promise(resolveExit => child.once('exit', (code, signal) => resolveExit({ code, signal })));

child.stdout.setEncoding('utf8');
child.stdout.on('data', data => {
  incoming += data;
  for (;;) {
    const index = incoming.indexOf('\n');
    if (index < 0) break;
    const line = incoming.slice(0, index); incoming = incoming.slice(index + 1);
    let event;
    try { event = JSON.parse(line); } catch { readyReject(new Error('invalid native event')); continue; }
    if (event.type === 'ready') { readyResolve(); continue; }
    const request = pending.get(event.requestId);
    if (!request) continue;
    pending.delete(event.requestId); clearTimeout(request.timer);
    if (event.type === 'error') request.reject(new Error('native operation failed')); else request.resolve(event);
  }
});
child.once('error', error => readyReject(error));
child.stderr.on('data', () => undefined);

function request(type, payload, sessionId = null, timeoutMs = 15000) {
  const requestId = randomUUID();
  return new Promise((resolveRequest, rejectRequest) => {
    const timer = setTimeout(() => { pending.delete(requestId); rejectRequest(new Error('native timeout')); }, timeoutMs);
    pending.set(requestId, { resolve: resolveRequest, reject: rejectRequest, timer });
    child.stdin.write(`${JSON.stringify({ version: 1, generation, requestId, sessionId, type, payload })}\n`);
  });
}

async function processPresent(image) {
  const { stdout } = await execFileAsync('tasklist.exe', ['/FI', `IMAGENAME eq ${image}`, '/NH', '/FO', 'CSV'], { windowsHide: true });
  return stdout.toLocaleLowerCase('en').includes(`"${image.toLocaleLowerCase('en')}"`);
}

function withTimeout(promise, timeoutMs, message) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(message)), timeoutMs))]);
}

try {
  await withTimeout(ready, 10000, 'native ready timeout');
  const devices = await request('listMicrophones', {});
  if (!Array.isArray(devices.payload) || devices.payload.length === 0 || typeof devices.payload[0]?.id !== 'string') throw new Error('no microphone available');
  const sessionId = randomUUID();
  await request('prepareWorker', { modelPath: model }, null, 65000);
  await request('startCapture', { microphoneId: devices.payload[0].id, modelPath: model, vocabulary: [] }, sessionId, 60000);
  await new Promise(resolveDelay => setTimeout(resolveDelay, 500));
  const workerSeen = await processPresent('opentalk-worker.exe');
  child.stdin.end();
  const exit = await withTimeout(exited, 15000, 'helper shutdown timeout');
  await new Promise(resolveDelay => setTimeout(resolveDelay, 300));
  const helperExited = !(await processPresent('opentalk-helper.exe'));
  const workerExited = !(await processPresent('opentalk-worker.exe'));
  let spoolRemoved = false;
  try { await access(join(process.env.LOCALAPPDATA ?? '', 'OpenTalk', 'spool', sessionId)); }
  catch { spoolRemoved = true; }
  if (!workerSeen || !helperExited || !workerExited || !spoolRemoved || exit.code !== 0) throw new Error('native shutdown verification failed');
  console.log(JSON.stringify({ result: 'PASS', microphoneDetected: true, workerSeen, helperExited, workerExited, spoolRemoved }));
} finally {
  for (const request of pending.values()) clearTimeout(request.timer);
  if (child.exitCode === null && child.signalCode === null) child.kill();
}
