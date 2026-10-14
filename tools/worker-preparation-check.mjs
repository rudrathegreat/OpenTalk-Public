// Isolated profile; exercises worker lifecycle without microphone or account access.
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, copyFile, readFile, readdir, writeFile, realpath, rm } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import assert from 'node:assert/strict';
const root = resolve('.runtime', `worker-preparation-${randomUUID()}`);
const appData = join(root, 'appdata-テスト'), localData = join(root, 'localdata');
const models = join(appData, 'OpenTalk', 'models'); await mkdir(models, { recursive: true }); await mkdir(localData);
const model = join(models, 'ggml-base.en.bin'); await copyFile('.tools/ggml-base.en.bin', model);
assert.equal(createHash('sha256').update(await readFile(model)).digest('hex'), 'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002');
// Same verified model under the other allowed name isolates replacement mechanics, not small-model fidelity.
const replacement = join(models, 'ggml-small.en.bin'); await copyFile(model, replacement);
const helper = spawn(resolve('native/bin/opentalk-helper.exe'), ['--generation', '1', '--worker', resolve('native/bin/opentalk-worker.exe')], { stdio: ['pipe', 'pipe', 'ignore'], shell: false, windowsHide: true, env: { ...process.env, APPDATA: appData, LOCALAPPDATA: localData } });
let buffer = '', readyResolve, readyReject, lostResolve, sequence = -1;
const lost = new Promise(resolveLost => { lostResolve = resolveLost; });
const ready = new Promise((resolveReady, rejectReady) => { readyResolve = resolveReady; readyReject = rejectReady; });
const pending = new Map();
helper.stdout.setEncoding('utf8');
helper.stdout.on('data', bytes => {
  buffer += bytes;
  for (;;) {
    const end = buffer.indexOf('\n'); if (end < 0) break;
    const value = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
    assert.ok(value.sequence > sequence); sequence = value.sequence;
    if (value.type === 'ready') { readyResolve(); continue; }
    if (value.type === 'workerUnavailable') { lostResolve(); continue; }
    const request = pending.get(value.requestId); if (!request) continue;
    pending.delete(value.requestId); clearTimeout(request.timer);
    if (value.type === 'error') request.reject(new Error(`native ${request.operation} rejected: ${String(value.payload?.code).replace(/[^a-z_]/g, '')}`)); else request.resolve(value);
  }
});
helper.on('error', error => { readyReject(error); for (const request of pending.values()) request.reject(error); });
const exited = new Promise(resolveExit => helper.on('exit', code => { readyReject(new Error('helper exit')); for (const request of pending.values()) request.reject(new Error('helper exit')); resolveExit(code); }));
const timeout = setTimeout(() => { helper.kill(); readyReject(new Error('timeout')); }, 30000);
function request(type, payload) {
  const requestId = randomUUID();
  return new Promise((resolveRequest, rejectRequest) => {
    const timer = setTimeout(() => { pending.delete(requestId); rejectRequest(new Error('timeout')); }, 10000);
    pending.set(requestId, { resolve: resolveRequest, reject: rejectRequest, timer, operation: `${type}/${payload.modelPath ? basename(payload.modelPath) : 'control'}` });
    helper.stdin.write(`${JSON.stringify({ version: 1, generation: 1, requestId, sessionId: null, type, payload })}\n`);
  });
}
try {
  await ready;
  const cold = performance.now(); const first = await request('prepareWorker', { modelPath: model }); assert.equal(first.type, 'workerReady'); const coldMs = Math.round(performance.now() - cold);
  const warm = performance.now(); const reused = await request('prepareWorker', { modelPath: model }); assert.equal(reused.type, 'workerReady'); const warmMs = Math.round(performance.now() - warm);
  assert.equal(first.payload.workerPid, reused.payload.workerPid);
  // Kill only the worker PID issued by this isolated helper's private pipe.
  assert.ok(Number.isInteger(first.payload.workerPid) && first.payload.workerPid > 0); process.kill(first.payload.workerPid);
  await lost;
  const recovered = await request('prepareWorker', { modelPath: model }); assert.equal(recovered.type, 'workerReady'); assert.notEqual(recovered.payload.workerPid, first.payload.workerPid);
  assert.equal((await request('prepareWorker', { modelPath: replacement })).type, 'workerReady');
  await request('configure', { enabled: false, hold: 'Ctrl+Shift', handsFree: 'Ctrl+Shift+Space' });
  await writeFile(replacement, 'invalid synthetic model');
  await assert.rejects(request('prepareWorker', { modelPath: replacement }));
  assert.equal((await request('prepareWorker', { modelPath: model })).type, 'workerReady');
  await assert.rejects(request('prepareWorker', { modelPath: resolve('.tools/ggml-base.en.bin') }));
  await request('configure', { enabled: false, hold: 'Ctrl+Shift', handsFree: 'Ctrl+Shift+Space' });
  assert.equal((await request('prepareWorker', { modelPath: model })).type, 'workerReady');
  assert.deepEqual(await readdir(join(localData, 'OpenTalk', 'spool')), []);
  const manifest = JSON.parse(await readFile('native/moonshine/manifest.json', 'utf8'));
  const moonshineModel = join(models, manifest.id); await mkdir(moonshineModel);
  for (const asset of manifest.files) {
    const source = join('.tools', manifest.id, asset.name);
    assert.equal(createHash('sha256').update(await readFile(source)).digest('hex'), asset.sha256);
    await copyFile(source, join(moonshineModel, asset.name));
  }
  const moonshineAt = performance.now(), moonshineReady = await request('prepareWorker', { modelPath: moonshineModel });
  assert.equal(moonshineReady.type, 'workerReady');
  const moonshineColdMs = Math.round(performance.now() - moonshineAt);
  const moonshineWarmAt = performance.now(), moonshineReused = await request('prepareWorker', { modelPath: moonshineModel });
  assert.equal(moonshineReused.payload.workerPid, moonshineReady.payload.workerPid);
  const moonshineWarmMs = Math.round(performance.now() - moonshineWarmAt);
  await request('configure', { enabled: false, hold: 'Ctrl+Shift', handsFree: 'Ctrl+Shift+Space' });
  await rm(join(moonshineModel, 'tokenizer.bin'));
  await assert.rejects(request('prepareWorker', { modelPath: moonshineModel }));
  console.log(JSON.stringify({ moonshineReady: true, moonshineReused: true, moonshineMissingAssetRejected: true, moonshineColdMs, moonshineWarmMs }));
  helper.stdin.end(); assert.equal(await exited, 0);
  console.log(JSON.stringify({ result: 'PASS', coldMs, warmMs, workerReused: true, recoveredAfterWorkerDeath: true, replacementReady: true, invalidModelRejected: true, recoveredAfterFailure: true, outsidePathRejected: true, disableThenPrepare: true, spoolEmpty: true, microphoneOpened: false }));
} finally {
  clearTimeout(timeout); for (const value of pending.values()) clearTimeout(value.timer);
  if (helper.exitCode === null) { helper.kill(); await exited; }
  const target = await realpath(root), runtime = await realpath(resolve('.runtime'));
  assert.equal(dirname(target), runtime); assert.match(basename(target), /^worker-preparation-[0-9a-f-]{36}$/);
  await rm(target, { recursive: true, force: true });
}
