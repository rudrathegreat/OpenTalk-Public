// Reads opt-in application timing lines from stdin. Outputs no source log content.
import { createInterface } from 'node:readline';
const groups = new Map();
const stages = new Set(['shortcutRecognition', 'targetInspection', 'captureStart', 'microphoneOpen', 'firstAudioFrame', 'recordingFeedback', 'startToCapture', 'stopDrain', 'transcription', 'tokenPreparation', 'cleanupFirstOutput', 'cleanupCompleted', 'cleanup', 'insertion', 'releaseToInsertion', 'nativeRelease', 'releaseToDone', 'history', 'workerPreparation', 'previewRecognition', 'finalRecognition', 'speculativeCleanup', 'speculativeHit', 'speculativeMiss', 'pasteDispatch', 'clipboardRestoration', 'releaseToPasteDispatch']);
for await (const line of createInterface({ input: process.stdin })) {
  if (line.length > 1024) continue;
  try {
    const value = JSON.parse(line).opentalkTiming;
    if (!value || !stages.has(value.stage) || value.outcome !== 'ok' || !Number.isFinite(value.durationMs) || value.durationMs < 0 || value.durationMs > 86400000) continue;
    const values = groups.get(value.stage) ?? []; if (values.length >= 10000) continue;
    values.push(value.durationMs); groups.set(value.stage, values);
  } catch { /* Other application output is intentionally ignored. */ }
}
const summary = {};
for (const [stage, values] of groups) {
  values.sort((a, b) => a - b); const middle = Math.floor(values.length / 2);
  summary[stage] = { samples: values.length, medianMs: values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2, p95Ms: values[Math.ceil(values.length * 0.95) - 1] };
}
console.log(JSON.stringify(summary, null, 2));
