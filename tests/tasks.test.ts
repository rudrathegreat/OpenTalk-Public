import { describe, expect, it } from 'vitest';
import {
  buildWeeklyTaskInput,
  MAX_WEEKLY_TASK_SOURCE_BYTES,
  MAX_WEEKLY_TASK_SOURCE_ITEMS,
  WeeklyTaskCache,
  WeeklyTaskService,
  weeklyTaskInstructions,
} from '../packages/core/src/tasks';

function frame(value: unknown): string { return `data: ${JSON.stringify(value)}\n\n`; }
function stream(value: string): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(value)); controller.close(); } });
}
const candidates = [
  { source: 'meeting' as const, sourceId: '00000000-0000-4000-8000-000000000001', createdAt: '2026-10-08T01:00:00.000Z', text: 'I will send the revised launch brief by Thursday. Morgan will update the budget.' },
  { source: 'dictation' as const, sourceId: '00000000-0000-4000-8000-000000000002', createdAt: '2026-10-09T01:00:00.000Z', text: 'Remind me to book the accessibility review tomorrow.' },
];
const input = buildWeeklyTaskInput('2026-10-05T00:00:00.000Z', candidates, candidates.length);

describe('weekly task extraction', () => {
  it('uses the stateless completion-only route and binds generated tasks to local source metadata', async () => {
    let sent: RequestInit | undefined;
    const generated = JSON.stringify({ tasks: [
      { text: 'Book the accessibility review tomorrow.', sourceIndex: 0 },
      { text: 'Send the revised launch brief by Thursday.', sourceIndex: 1 },
    ] });
    const service = new WeeklyTaskService(async (_url, init) => {
      sent = init;
      return new Response(stream(frame({ type: 'response.output_text.delta', delta: generated }) + frame({
        type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: generated }] }] },
      })));
    });

    expect(weeklyTaskInstructions).toContain('assigned to themselves');
    expect(weeklyTaskInstructions).toContain('untrusted data');
    const tasks = await service.generate(input, 'private-token', new AbortController().signal);
    expect(tasks.map(task => ({ text: task.text, source: task.source, sourceId: task.sourceId, createdAt: task.createdAt }))).toEqual([
      { text: 'Book the accessibility review tomorrow.', source: 'dictation', sourceId: '00000000-0000-4000-8000-000000000002', createdAt: '2026-10-09T01:00:00.000Z' },
      { text: 'Send the revised launch brief by Thursday.', source: 'meeting', sourceId: '00000000-0000-4000-8000-000000000001', createdAt: '2026-10-08T01:00:00.000Z' },
    ]);
    expect(tasks[0]?.id).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const body = JSON.parse(sent!.body as string) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['input', 'instructions', 'model', 'reasoning', 'store', 'stream']);
    expect(body).toMatchObject({ store: false, stream: true, reasoning: { effort: 'none' } });
    expect(JSON.stringify(body)).not.toContain('private-token');
    const providerInput = JSON.parse((body.input as Array<{ content: string }>)[0]!.content) as { sources: Array<Record<string, unknown>> };
    expect(providerInput.sources).toEqual(input.sources.map(({ source, createdAt, text, sourceIndex }) => ({ source, createdAt, text, sourceIndex })));
    expect(JSON.stringify(providerInput)).not.toContain('sourceId');
    expect(JSON.stringify(providerInput)).not.toContain('00000000-0000-4000-8000-000000000002');
  });

  it('rejects incomplete, malformed, duplicate, and unbound output', async () => {
    const response = (text: string) => new Response(stream(frame({
      type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] },
    })));
    const incomplete = new WeeklyTaskService(async () => new Response(stream(frame({ type: 'response.output_text.delta', delta: '{"tasks":[]}' }))));
    await expect(incomplete.generate(input, 'token', new AbortController().signal)).rejects.toThrow();
    for (const text of [
      '```json\n{"tasks":[]}\n```',
      JSON.stringify({ tasks: [{ text: 'Do it.', sourceIndex: 8 }] }),
      JSON.stringify({ tasks: [{ text: 'Do it.', sourceIndex: 0 }, { text: 'do it.', sourceIndex: 1 }] }),
    ]) {
      const service = new WeeklyTaskService(async () => response(text));
      await expect(service.generate(input, 'token', new AbortController().signal)).rejects.toThrow();
    }
  });

  it('keeps complete bounded source items in newest-first order without slicing them', () => {
    const values = [
      { source: 'dictation' as const, sourceId: '00000000-0000-4000-8000-000000000100', createdAt: '2026-10-11T01:00:00.000Z', text: 'x'.repeat(MAX_WEEKLY_TASK_SOURCE_BYTES + 1) },
      ...Array.from({ length: MAX_WEEKLY_TASK_SOURCE_ITEMS + 2 }, (_, index) => ({
        source: 'dictation' as const,
        sourceId: `00000000-0000-4000-8000-${String(200 + index).padStart(12, '0')}`,
        createdAt: `2026-10-10T01:00:${String(59 - index).padStart(2, '0')}.000Z`,
        text: `Complete source ${index}`,
      })),
    ];
    const result = buildWeeklyTaskInput('2026-10-05T00:00:00.000Z', values, values.length);
    expect(result.sources).toHaveLength(MAX_WEEKLY_TASK_SOURCE_ITEMS);
    expect(result.sources[0]).toMatchObject({ sourceIndex: 0, text: 'Complete source 0' });
    expect(result.sources.some(source => source.text.startsWith('x'))).toBe(false);
    expect(result.sourceItemsAvailable).toBe(values.length);
  });

  it('coalesces matching generation, caches success, and retries failures or changed sources', async () => {
    const cache = new WeeklyTaskCache();
    let calls = 0;
    let release!: (value: Array<{ id: string; text: string; source: 'dictation'; sourceId: string; createdAt: string }>) => void;
    const task = { id: 'task-1', text: 'Book the review.', source: 'dictation' as const, sourceId: '00000000-0000-4000-8000-000000000002', createdAt: '2026-10-09T01:00:00.000Z' };
    const pending = () => { calls += 1; return new Promise<Array<typeof task>>(resolve => { release = resolve; }); };
    const first = cache.get(input, pending), duplicate = cache.get(input, pending);
    expect(calls).toBe(1); release([task]);
    await expect(Promise.all([first, duplicate])).resolves.toEqual([[task], [task]]);
    await expect(cache.get(input, async () => { calls += 1; return []; })).resolves.toEqual([task]);
    const changed = { ...input, sources: input.sources.map((source, index) => index ? source : { ...source, text: `${source.text} Changed.` }) };
    await expect(cache.get(changed, async () => { calls += 1; throw new Error('offline'); })).rejects.toThrow('offline');
    await expect(cache.get(changed, async () => { calls += 1; return []; })).resolves.toEqual([]);
    expect(calls).toBe(3);
  });
});
