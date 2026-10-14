import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const model = process.argv[2] ?? '.tools/ggml-base.en.bin';
const fixture = process.argv[3] ?? '.tools/whisper.cpp/samples/jfk.wav';
const wav = await readFile(fixture);
assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
let pcm, rate, channels, bits;
for (let pos = 12; pos + 8 <= wav.length;) {
  const name = wav.toString('ascii', pos, pos + 4), length = wav.readUInt32LE(pos + 4), start = pos + 8;
  if (name === 'fmt ') { assert.equal(wav.readUInt16LE(start), 1); channels = wav.readUInt16LE(start + 2); rate = wav.readUInt32LE(start + 4); bits = wav.readUInt16LE(start + 14); }
  if (name === 'data') pcm = wav.subarray(start, start + length);
  pos = start + length + length % 2;
}
assert.equal(rate, 16000); assert.equal(channels, 1); assert.equal(bits, 16); assert.ok(pcm);
const child = spawn('native/bin/opentalk-worker.exe', ['--model', model], { stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true });
let buffer = Buffer.alloc(0), resolveFrame, rejectFrame;
child.stdout.on('data', bytes => { buffer = Buffer.concat([buffer, bytes]); if (buffer.length > 192004) { child.kill(); rejectFrame?.(new Error('worker size')); } if (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) { const length = buffer.readUInt32LE(0); const result = buffer.subarray(4, 4 + length).toString('utf8'); buffer = buffer.subarray(4 + length); resolveFrame?.(result); } });
child.stderr.on('data', () => undefined);
child.on('error', error => rejectFrame?.(error)); child.on('exit', code => { if (code) rejectFrame?.(new Error('worker exit')); });
function transcribe(audio) { return new Promise((resolve, reject) => { resolveFrame = resolve; rejectFrame = reject; const header = Buffer.alloc(8); header.writeUInt32LE(audio.length / 2); child.stdin.write(header); child.stdin.write(audio); }); }
const timer = setTimeout(() => { child.kill(); rejectFrame?.(new Error('worker timeout')); }, 120000);
try {
  const start = performance.now(); const text = await transcribe(pcm);
  assert.match(text.toLowerCase(), /ask not what your country can do for you/);
  assert.match(text.toLowerCase(), /ask what you can do for your country/);
  const silence = await transcribe(Buffer.alloc(16000 * 2)); assert.equal(silence, '');
  console.log(JSON.stringify({ result: 'PASS', fixtureSha256: createHash('sha256').update(wav).digest('hex'), seconds: pcm.length / 32000, inferenceMs: Math.round(performance.now() - start), clausesPreserved: true, silenceEmpty: true, persistentWorker: true }));
} finally { clearTimeout(timer); child.stdin.end(); }
