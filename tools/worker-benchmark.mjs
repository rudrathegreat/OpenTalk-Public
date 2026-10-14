// Local-only: public fixture, no microphone, account, transcript logging or insertion.
import { spawn, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const readyProtocol = process.argv.includes('--ready');
const threadIndex = process.argv.indexOf('--threads');
const threads = threadIndex >= 0 ? process.argv[threadIndex + 1] : null;
if (threadIndex >= 0) assert.ok(['2', '4', '6', '8'].includes(threads), 'Use --threads 2, 4, 6 or 8.');
const wav = await readFile('.tools/whisper.cpp/samples/jfk.wav');
let pcm;
for (let pos = 12; pos + 8 <= wav.length;) {
  const size = wav.readUInt32LE(pos + 4), start = pos + 8;
  if (wav.toString('ascii', pos, pos + 4) === 'data') pcm = wav.subarray(start, start + size);
  pos = start + size + size % 2;
}
assert.ok(pcm);
const child = spawn('native/bin/opentalk-worker.exe', ['--model', '.tools/ggml-base.en.bin', ...(readyProtocol ? ['--ready'] : []), ...(threads ? ['--threads', threads] : [])], { stdio: ['pipe', 'pipe', 'ignore'], shell: false, windowsHide: true });
let buffer = Buffer.alloc(0), pending;
child.stdout.on('data', bytes => {
  buffer = Buffer.concat([buffer, bytes]);
  if (buffer.length > 192008) { child.kill(); pending?.reject(new Error('worker size')); return; }
  if (!pending || buffer.length < 4) return;
  if (pending.ready) {
    assert.equal(buffer.subarray(0, 4).toString('ascii'), 'OTW1');
    buffer = buffer.subarray(4); pending.resolve(); pending = null; return;
  }
  const length = buffer.readUInt32LE(0);
  if (buffer.length < length + 4) return;
  const text = buffer.subarray(4, length + 4).toString('utf8');
  buffer = buffer.subarray(length + 4); pending.resolve(text); pending = null;
});
child.on('error', error => pending?.reject(error));
child.on('exit', () => pending?.reject(new Error('worker exit')));
const timer = setTimeout(() => { pending?.reject(new Error('worker timeout')); child.kill(); }, 180000);
function transcribe(audio) {
  return new Promise((resolve, reject) => {
    pending = { resolve, reject }; const header = Buffer.alloc(8);
    header.writeUInt32LE(audio.length / 2); child.stdin.write(header); child.stdin.write(audio);
  });
}
function memory() {
  const script = `$probe = Get-Process -Id ${child.pid}; [pscustomobject]@{workingSetMiB=[math]::Round($probe.WorkingSet64/1MB,1);privateCommittedMiB=[math]::Round($probe.PrivateMemorySize64/1MB,1)} | ConvertTo-Json -Compress`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true });
  return result.status === 0 ? JSON.parse(result.stdout) : { unavailable: true };
}
function summary(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { medianMs: Math.round((sorted[9] + sorted[10]) / 2), p95Ms: Math.round(sorted[18]) };
}
try {
  const start = performance.now();
  if (readyProtocol) await new Promise((resolve, reject) => { pending = { ready: true, resolve, reject }; });
  else assert.equal(await transcribe(Buffer.alloc(32000)), '');
  const modelLoadMs = Math.round(performance.now() - start), loadedMemory = memory();
  const recognitionMs = [];
  for (let index = 0; index < 20; index++) {
    const began = performance.now(), text = await transcribe(pcm);
    recognitionMs.push(performance.now() - began);
    assert.match(text, /ask not what your country can do for you/i);
    assert.match(text, /ask what you can do for your country/i);
  }
  assert.equal(await transcribe(Buffer.alloc(32000)), '');
  console.log(JSON.stringify({ result: 'PASS', threads: threads ? Number(threads) : 'default', fixtureSha256: createHash('sha256').update(wav).digest('hex'), fixtureSeconds: pcm.length / 32000, repetitions: 20, modelLoadMs, loadedMemory, recognitionMemory: memory(), firstRecognitionMs: Math.round(recognitionMs[0]), ...summary(recognitionMs), recognitionMs: recognitionMs.map(Math.round), clausesPreserved: true, silenceEmpty: true }));
} finally { clearTimeout(timer); child.stdin.end(); }
