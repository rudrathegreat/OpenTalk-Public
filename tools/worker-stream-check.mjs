// Public fixture only: no microphone, credentials, clipboard, target or network access.
import { spawn, execFile } from 'node:child_process';
import { readFile, mkdir, rm, realpath } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, join, dirname, basename } from 'node:path';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';

const wav = await readFile('.tools/whisper.cpp/samples/jfk.wav');
assert.equal(createHash('sha256').update(wav).digest('hex'), '59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e');
let pcm;
for (let pos = 12; pos + 8 <= wav.length;) {
  const size = wav.readUInt32LE(pos + 4), start = pos + 8;
  if (wav.toString('ascii', pos, pos + 4) === 'data') pcm = wav.subarray(start, start + size);
  pos = start + size + size % 2;
}
assert.ok(pcm);
const moonshine = process.argv.includes('--moonshine');
const child = spawn('native/bin/opentalk-worker.exe', ['--model', moonshine ? '.tools/moonshine-small-streaming-en' : '.tools/ggml-base.en.bin', '--stream'], { stdio: ['pipe', 'pipe', 'ignore'], shell: false, windowsHide: true });
let buffer = Buffer.alloc(0), readyResolve, readyReject, sequence = 0, initialized = false;
const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
const pending = new Map();
function fail(error) { readyReject(error); for (const value of pending.values()) value.reject(error); }
child.stdout.on('data', bytes => {
  try {
    buffer = Buffer.concat([buffer, bytes]); assert.ok(buffer.length <= 2 * 192012);
    if (!initialized && buffer.length >= 4) {
      assert.equal(buffer.subarray(0, 4).toString('ascii'), 'OTW2'); buffer = buffer.subarray(4); initialized = true; readyResolve();
    }
    while (initialized && buffer.length >= 12) {
      const id = buffer.readUInt32LE(0), status = buffer.readUInt32LE(4), length = buffer.readUInt32LE(8);
      assert.ok(length <= 192000 && status <= 1);
      if (buffer.length < length + 12) break;
      const request = pending.get(id); assert.ok(request); pending.delete(id);
      request.resolve({ status, text: buffer.subarray(12, length + 12).toString('utf8') }); buffer = buffer.subarray(length + 12);
    }
  } catch (error) { fail(error); child.kill(); }
});
child.on('error', fail);
const exited = new Promise(resolve => child.on('exit', code => { fail(new Error('worker exited')); resolve(code); }));
const deadline = setTimeout(() => { fail(new Error('worker timeout')); child.kill(); }, process.argv.includes('--synthetic') ? 180000 : 60000);
function request(kind, audio, overlap = 0) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject }); const header = Buffer.alloc(16);
    header.writeUInt32LE(kind); header.writeUInt32LE(id, 4); header.writeUInt32LE(audio.length / 2, 8);
    header.writeUInt32LE(overlap, 12);
    child.stdin.write(header); child.stdin.write(audio);
  });
}
function cancelPreview() { const header = Buffer.alloc(16); header.writeUInt32LE(3); child.stdin.write(header); }
const normalized = text => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const clauses = text => { assert.match(normalized(text), /ask not what your country can do for you/i); assert.match(normalized(text), /ask what you can do for your country/i); };
async function syntheticClips() {
  const runtime = resolve('.runtime'); await mkdir(runtime, { recursive: true });
  const root = join(runtime, `cpu200-${randomUUID()}`); await mkdir(root);
  try {
    const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve('tools/cpu-synthetic-fixtures.ps1'), '-OutputRoot', root], { windowsHide: true, timeout: 90000 });
    const clips = JSON.parse(stdout.trim()); assert.ok(Array.isArray(clips) && clips.length === 4);
    const samples = [];
    for (const clip of clips) {
      assert.ok(['short', 'ten-seconds', 'twenty-seconds', 'near-thirty-seconds'].includes(clip.name));
      assert.ok(clip.wordsPerMinute >= 180 && clip.wordsPerMinute <= 220);
      const wave = await readFile(join(root, `${clip.name}.wav`)); let audio;
      for (let pos = 12; pos + 8 <= wave.length;) {
        const size = wave.readUInt32LE(pos + 4), start = pos + 8;
        if (wave.toString('ascii', pos, pos + 4) === 'data') audio = wave.subarray(start, start + size);
        pos = start + size + size % 2;
      }
      assert.ok(audio && audio.length <= 30 * 32000);
      const previewEnd = Math.min(audio.length, 4 * 32000);
      let streamComputeMs = 0;
      if (moonshine) {
        // Emulate the production 250 ms cadence, leaving the final <250 ms tail for EOS.
        for (let end = 8000; end < audio.length; end += 8000) {
          const at = performance.now(); const preview = await request(1, audio.subarray(0, end));
          assert.equal(preview.status, 0); streamComputeMs += performance.now() - at;
        }
      } else { const preview = await request(1, audio.subarray(0, previewEnd)); assert.equal(preview.status, 0); }
      const started = performance.now(), final = await request(2, audio), finalMs = Math.round(performance.now() - started);
      assert.equal(final.status, 0); assert.match(final.text, /Thursday/i); assert.match(final.text, /Friday/i);
      // The identical full-audio recognition must remain stable after preview work.
      const repeated = await request(2, audio); assert.equal(repeated.status, 0);
      // Streaming and batch can punctuate differently; both must preserve the late correction.
      if (!moonshine) assert.equal(repeated.text, final.text);
      else { assert.match(repeated.text, /Thursday/i); assert.match(repeated.text, /Friday/i); }
      samples.push({ name: clip.name, seconds: clip.seconds, wordsPerMinute: clip.wordsPerMinute, finalMs, streamComputeMs: Math.round(streamComputeMs), recognitionRealtimeFactor: Math.round((finalMs + streamComputeMs) / (clip.seconds * 1000) * 1000) / 1000, finalCorrectionWordsPresent: true, stableAfterPreview: !moonshine });
    }
    return samples;
  } finally {
    const target = await realpath(root), parent = await realpath(runtime);
    assert.equal(dirname(target).toLowerCase(), parent.toLowerCase()); assert.ok(basename(target).startsWith('cpu200-'));
    await rm(target, { recursive: true });
  }
}
try {
  await ready;
  const began = performance.now(), baseline = await request(2, pcm), baselineMs = Math.round(performance.now() - began);
  assert.equal(baseline.status, 0); clauses(baseline.text);
  const cancellations = [];
  for (let index = 0; index < 5; ++index) {
    const preview = request(1, pcm);
    await new Promise(resolve => setTimeout(resolve, 25));
    const cancelAt = performance.now(); cancelPreview();
    // A final request may arrive while the old preview is being cooperatively aborted.
    const final = request(2, pcm);
    const canceled = await preview; assert.equal(canceled.status, 1); assert.equal(canceled.text, '');
    const abortMs = Math.round(performance.now() - cancelAt);
    const result = await final; assert.equal(result.status, 0); clauses(result.text);
    assert.equal(normalized(result.text), normalized(baseline.text));
    cancellations.push({ abortMs, finalReadyMs: Math.round(performance.now() - cancelAt) });
  }
  const silent = await request(2, Buffer.alloc(32000)); assert.equal(silent.status, 0); assert.equal(silent.text, '');
  if (moonshine) {
    // The next long-session chunk begins with one second from the preceding chunk.
    const overlapAudio = Buffer.concat([pcm.subarray(pcm.length - 32000), pcm]);
    const overlapped = await request(2, overlapAudio, 100); assert.equal(overlapped.status, 0); clauses(overlapped.text);
    const reused = await request(2, pcm); assert.equal(reused.status, 0); clauses(reused.text);
  }
  const synthetic = process.argv.includes('--synthetic') ? await syntheticClips() : undefined;
  child.stdin.end(); assert.equal(await exited, 0);
  console.log(JSON.stringify({ result: 'PASS', backend: moonshine ? 'moonshine-cpu' : 'whisper-cpu', baselineMs, cancellations, finalMeaningPreserved: true, silenceEmpty: true, workerReusedAfterAbort: true, synthetic }));
} finally { clearTimeout(deadline); child.kill(); }
