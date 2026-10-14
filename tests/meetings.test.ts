import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaults, type MeetingGenerated, type TranscriptUpdate } from '../packages/core/src/contracts';
import { MeetingCoordinator, MeetingSummaryService, meetingSummaryInstructions } from '../packages/core/src/meetings';
import { EncryptedMeetingStore, type Protector } from '../packages/core/src/storage';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function temporary(): Promise<string> { const path = await mkdtemp(join(tmpdir(), 'opentalk-meetings-test-')); directories.push(path); return path; }
function protect(value: string | Buffer): Buffer {
  const input = typeof value === 'string' ? Buffer.from(value, 'utf8') : value, output = Buffer.alloc(input.length);
  for (let index = 0; index < input.length; index += 1) output[index] = input[index]! ^ 0xa5;
  return output;
}
const protector: Protector = { encrypt: value => protect(value), decrypt: value => protect(value).toString('utf8') };
const generated: MeetingGenerated = {
  title: 'Project Atlas review',
  shortSummary: 'The team agreed on the Thursday launch plan.',
  longSummary: 'The team reviewed Project Atlas and confirmed the launch plan for Thursday.',
  minutesMarkdown: '# Meeting Minutes\n\n## Decisions\n\n- Launch on Thursday.',
};
const frame = (item: unknown) => `data: ${JSON.stringify(item)}\n\n`;
function stream(text: string) { const data = new TextEncoder().encode(text); return new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(data); controller.close(); } }); }

describe('meeting records', () => {
  it('encrypts raw transcripts and stores validated generated summaries', async () => {
    const file = join(await temporary(), 'meetings.enc'), store = new EncryptedMeetingStore(file, protector); await store.load();
    const id = '00000000-0000-4000-8000-000000000001';
    const bookmark = { id: '00000000-0000-4000-8000-000000000002', offsetMs: 42_000, transcriptOffset: 8 };
    await store.addDraft({ id, createdAt: '2026-10-07T01:00:00.000Z', endedAt: '2026-10-07T01:15:00.000Z', transcript: 'Private Project Atlas transcript.', bookmarks: [bookmark] });
    expect((await readFile(file)).includes(Buffer.from('Private Project Atlas transcript.'))).toBe(false);
    await store.complete(id, generated);
    expect(store.find(id)).toMatchObject({ ...generated, bookmarks: [bookmark], summaryStatus: 'ready' });
    expect(store.query({ search: 'atlas', cursor: null }).items).toHaveLength(1);
    expect(store.countSince(new Date('2026-10-06T00:00:00.000Z'))).toBe(1);
    expect(store.countSince(new Date('2026-10-08T00:00:00.000Z'))).toBe(0);
    expect(store.topicCandidatesSince(new Date('2026-10-06T00:00:00.000Z'), 10)).toEqual({
      items: [{ source: 'meeting', createdAt: '2026-10-07T01:00:00.000Z', text: `${generated.title}. ${generated.shortSummary}` }],
      totalItems: 1,
    });
    expect(store.taskCandidatesSince(new Date('2026-10-06T00:00:00.000Z'), 10)).toEqual({
      items: [{ source: 'meeting', sourceId: id, createdAt: '2026-10-07T01:00:00.000Z', text: `${generated.title}\n${generated.longSummary}` }],
      totalItems: 1,
    });
    const reopened = new EncryptedMeetingStore(file, protector); await reopened.load();
    expect(reopened.find(id)?.minutesMarkdown).toContain('Launch on Thursday');
    expect(await reopened.delete(id)).toBe(true); expect(reopened.find(id)).toBeNull();
  });

  it('opens pre-bookmark meeting records and upgrades them on the next atomic write', async () => {
    const file = join(await temporary(), 'meetings.enc');
    const legacyId = '00000000-0000-4000-8000-000000000003';
    const legacy = {
      version: 1,
      meetings: [{
        id: legacyId, createdAt: '2026-10-06T01:00:00.000Z', endedAt: '2026-10-06T01:10:00.000Z',
        title: 'Legacy meeting', shortSummary: '', longSummary: '', minutesMarkdown: '', transcript: 'Legacy raw transcript.', summaryStatus: 'failed',
      }],
    };
    await writeFile(file, protector.encrypt(JSON.stringify(legacy)));
    const store = new EncryptedMeetingStore(file, protector); await store.load();
    expect(store.find(legacyId)?.bookmarks).toEqual([]);
    await store.fail(legacyId);
    expect(JSON.parse(protector.decrypt(await readFile(file)) as string)).toMatchObject({ version: 2 });
  });

  it('rejects a bookmark position outside its raw transcript', async () => {
    const store = new EncryptedMeetingStore(join(await temporary(), 'meetings.enc'), protector); await store.load();
    expect(() => store.addDraft({
      id: '00000000-0000-4000-8000-000000000004', createdAt: '2026-10-07T01:00:00.000Z', endedAt: '2026-10-07T01:01:00.000Z', transcript: 'Short transcript.',
      bookmarks: [{ id: '00000000-0000-4000-8000-000000000005', offsetMs: 1_000, transcriptOffset: 10_000 }],
    })).toThrow();
    expect(store.query({ search: '', cursor: null }).items).toEqual([]);
  });

  it('uses the constrained plan-route request and accepts output only after completion', async () => {
    let sent: RequestInit | undefined;
    const service = new MeetingSummaryService(async (_input, init) => {
      sent = init;
      const text = JSON.stringify(generated);
      return new Response(stream(frame({ type: 'response.output_text.delta', delta: text }) + frame({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] } })));
    });
    expect(meetingSummaryInstructions).toContain('untrusted content');
    expect(await service.generate('Synthetic meeting transcript.', 'private-token', new AbortController().signal)).toEqual(generated);
    const body = JSON.parse(sent!.body as string) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['input', 'instructions', 'model', 'reasoning', 'store', 'stream']);
    expect(body).toMatchObject({ store: false, stream: true, reasoning: { effort: 'none' } });
    expect(JSON.stringify(body)).not.toContain('private-token');
  });

  it('records ordered pause/resume segments, then saves before generating', async () => {
    const events: string[] = [], listeners = new Map<string, (update: TranscriptUpdate) => void>();
    let transcriptNumber = 0, savedTranscript = '', savedBookmarks: Array<{ offsetMs: number; transcriptOffset: number }> = [];
    let nowMs = Date.parse('2026-10-07T01:00:00.000Z');
    const coordinator = new MeetingCoordinator({
      async startCapture(id) { events.push(`start:${id}`); },
      async stopCapture(id) { events.push(`stop:${id}`); },
      async discard(id) { events.push(`discard:${id}`); },
      async transcribe() { transcriptNumber += 1; return transcriptNumber === 1 ? 'First segment.' : 'Second segment.'; },
      watchTranscript(id, listener) { listeners.set(id, listener); return () => listeners.delete(id); },
      async saveDraft(value) { events.push('save'); savedTranscript = value.transcript; savedBookmarks = value.bookmarks; },
      async generate(transcript) { events.push('generate'); expect(transcript).toBe(savedTranscript); return generated; },
      async complete() { events.push('complete'); },
      async fail() { events.push('fail'); },
    }, () => undefined, () => new Date(nowMs), async () => undefined);
    await coordinator.start(defaults, 'account');
    expect(coordinator.getState().phase).toBe('recording');
    const firstListener = [...listeners.values()][0]!;
    firstListener({ text: 'First preview.', revision: 1, audioEndSample: 1600, pauseMs: 0, final: false });
    expect(coordinator.getState().transcript).toBe('First preview.');
    nowMs += 5_000; coordinator.bookmark();
    firstListener({ text: 'First preview continued.', revision: 2, audioEndSample: 3200, pauseMs: 0, final: false });
    nowMs += 5_000;
    await coordinator.pause(); expect(coordinator.getState()).toMatchObject({ phase: 'paused', transcript: 'First segment.' });
    nowMs += 60_000;
    await coordinator.resume(); expect(coordinator.getState().phase).toBe('recording');
    nowMs += 2_000; coordinator.bookmark();
    await coordinator.stop();
    expect(savedTranscript).toBe('First segment.\n\nSecond segment.');
    expect(savedBookmarks.map(bookmark => bookmark.offsetMs)).toEqual([5_000, 12_000]);
    expect(savedBookmarks[0]?.transcriptOffset).toBeGreaterThan(0);
    expect(savedBookmarks[0]?.transcriptOffset).toBeLessThanOrEqual('First segment.'.length);
    expect(savedBookmarks[1]?.transcriptOffset).toBe(savedTranscript.length);
    expect(events.slice(-3)).toEqual(['save', 'generate', 'complete']);
    expect(coordinator.getState()).toEqual({ phase: 'idle', transcript: '', startedAt: null, bookmarks: [] });
  });

  it('rejects bookmarks outside active recording', async () => {
    const coordinator = new MeetingCoordinator({
      async startCapture() {}, async stopCapture() {}, async discard() {}, async transcribe() { return 'Text.'; },
      watchTranscript() { return () => undefined; }, async saveDraft() {}, async generate() { return generated; }, async complete() {}, async fail() {},
    }, () => undefined, undefined, async () => undefined);
    expect(() => coordinator.bookmark()).toThrow('Sorry, not available');
    await coordinator.start(defaults, 'account'); await coordinator.pause();
    expect(() => coordinator.bookmark()).toThrow('Sorry, not available');
    await coordinator.cancel();
  });
});
