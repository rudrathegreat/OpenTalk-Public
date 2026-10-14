import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const binaryArgument = process.argv.find(argument => argument.startsWith('--binary='));
const binary = binaryArgument ? resolve(root, binaryArgument.slice('--binary='.length)) : resolve(root, 'native/bin/opentalk-helper.exe');
const worker = resolve(dirname(binary), 'opentalk-worker.exe');
const generation = 23;
const delayArgument = process.argv.find(argument => argument.startsWith('--delay-ms='));
const delayMs = delayArgument ? Number(delayArgument.slice('--delay-ms='.length)) : 0;
if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 10_000) throw new Error('Invalid probe delay.');
const child = spawn(binary, ['--generation', String(generation), '--worker', worker], {
  cwd: root,
  stdio: ['pipe', 'pipe', 'inherit'],
  windowsHide: true,
});

let incoming = '';
let helperReady = false;
let ready;
const readyPromise = new Promise((resolveReady, rejectReady) => { ready = { resolveReady, rejectReady }; });
const pending = new Map();

child.stdout.setEncoding('utf8');
child.stdout.on('data', data => {
  incoming += data;
  for (;;) {
    const index = incoming.indexOf('\n');
    if (index < 0) break;
    const line = incoming.slice(0, index);
    incoming = incoming.slice(index + 1);
    const event = JSON.parse(line);
    if (event.type === 'ready') { helperReady = true; ready.resolveReady(); continue; }
    const resolveRequest = pending.get(event.requestId);
    if (resolveRequest) { pending.delete(event.requestId); resolveRequest(event); }
  }
});
child.once('error', error => ready.rejectReady(error));
child.once('exit', code => {
  if (!helperReady) ready.rejectReady(new Error(`Selection probe helper exited before ready with ${code}.`));
  if (code && pending.size) throw new Error(`Selection probe helper exited with ${code}.`);
});

function request(type, payload = {}) {
  const requestId = randomUUID();
  child.stdin.write(`${JSON.stringify({ version: 1, generation, requestId, sessionId: null, type, payload })}\n`);
  return new Promise(resolveRequest => pending.set(requestId, resolveRequest));
}

function redact(event) {
  if (event.type === 'error') return { error: event.payload?.code ?? 'unknown' };
  const selection = event.payload;
  return {
    target: selection.target,
    textLength: selection.text.length,
    textSha256: createHash('sha256').update(selection.text).digest('hex'),
    bounds: selection.bounds,
  };
}

try {
  await readyPromise;
  if (delayMs) await new Promise(resolveWait => setTimeout(resolveWait, delayMs));
  const snapshots = [];
  for (let index = 0; index < 3; index += 1) {
    snapshots.push(redact(await request('inspectSelection')));
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
  process.stdout.write(`${JSON.stringify(snapshots, null, 2)}\n`);
} finally {
  child.stdin.end();
}
