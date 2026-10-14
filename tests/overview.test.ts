import { describe, expect, it } from 'vitest';
import { buildWeeklySummaryInput, localWeeklyUsageSummary, MAX_WEEKLY_TOPIC_SAMPLE_BYTES, MAX_WEEKLY_TOPIC_SAMPLES, MAX_WEEKLY_USAGE_SUMMARY_LENGTH, WeeklyUsageSummaryCache, WeeklyUsageSummaryService, weeklyUsageSummaryInstructions } from '../packages/core/src/overview';

function frame(value: unknown): string { return `data: ${JSON.stringify(value)}\n\n`; }
function stream(value: string): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(value)); controller.close(); } });
}
const usage = { weekStartedAt: '2026-10-05T00:00:00.000Z', wordsThisWeek: 1_240, meetingsThisWeek: 2, longestDictationMs: 82_000 };
const topics = [
  { source: 'dictation' as const, createdAt: '2026-10-09T01:00:00.000Z', text: 'Plan the accessibility review and keep the Thursday launch milestone.' },
  { source: 'meeting' as const, createdAt: '2026-10-08T01:00:00.000Z', text: 'Customer interview. The team discussed pricing constraints and follow-up questions.' },
];
const summaryInput = buildWeeklySummaryInput(usage, topics, topics.length);

describe('weekly overview narrative', () => {
  it('uses the constrained plan route with bounded recent topics as untrusted data', async () => {
    let sent: RequestInit | undefined;
    const generated = 'Accessibility reviews, launch planning, and pricing follow-ups kept your voice busy this week - 1,240 words while the keyboard took five.';
    const service = new WeeklyUsageSummaryService(async (_input, init) => {
      sent = init;
      return new Response(stream(frame({ type: 'response.output_text.delta', delta: generated }) + frame({
        type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: generated }] }] },
      })));
    });

    expect(weeklyUsageSummaryInstructions).toContain('lightly playful');
    expect(weeklyUsageSummaryInstructions).toContain('untrusted data');
    expect(await service.generate(summaryInput, 'private-token', new AbortController().signal)).toBe(generated);
    const body = JSON.parse(sent!.body as string) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['input', 'instructions', 'model', 'reasoning', 'store', 'stream']);
    expect(body).toMatchObject({ store: false, stream: true, reasoning: { effort: 'none' } });
    const input = body.input as Array<{ content: string }>;
    expect(JSON.parse(input[0]!.content)).toEqual(summaryInput);
    expect(JSON.stringify(body)).not.toContain('private-token');
    expect(JSON.stringify(body)).not.toContain('recentDictations');
    expect(JSON.stringify(body)).not.toContain('00000000-');
  });

  it('rejects incomplete and oversized generated summaries', async () => {
    const incomplete = new WeeklyUsageSummaryService(async () => new Response(stream(frame({ type: 'response.output_text.delta', delta: 'Partial' }))));
    await expect(incomplete.generate(summaryInput, 'token', new AbortController().signal)).rejects.toThrow();
    const oversizedText = 'x'.repeat(MAX_WEEKLY_USAGE_SUMMARY_LENGTH + 1);
    const oversized = new WeeklyUsageSummaryService(async () => new Response(stream(frame({
      type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: oversizedText }] }] },
    }))));
    await expect(oversized.generate(summaryInput, 'token', new AbortController().signal)).rejects.toThrow();
  });

  it('keeps only complete bounded topic samples in newest-first order', () => {
    const candidates = [
      { source: 'dictation' as const, createdAt: '2026-10-11T01:00:00.000Z', text: 'x'.repeat(MAX_WEEKLY_TOPIC_SAMPLE_BYTES + 1) },
      ...Array.from({ length: MAX_WEEKLY_TOPIC_SAMPLES + 2 }, (_, index) => ({
        source: 'dictation' as const,
        createdAt: `2026-10-10T01:00:${String(59 - index).padStart(2, '0')}.000Z`,
        text: `Complete topic ${index}`,
      })),
    ];
    const input = buildWeeklySummaryInput(usage, candidates, candidates.length);
    expect(input.topicSamples).toHaveLength(MAX_WEEKLY_TOPIC_SAMPLES);
    expect(input.topicSamples[0]?.text).toBe('Complete topic 0');
    expect(input.topicSamples.some(sample => sample.text.startsWith('x'))).toBe(false);
    expect(input.topicItemsAvailable).toBe(candidates.length);
  });

  it('coalesces matching generation, caches success, and retries failures or changed totals', async () => {
    const cache = new WeeklyUsageSummaryCache();
    let calls = 0;
    let release!: (value: string) => void;
    const pending = () => { calls += 1; return new Promise<string>(resolve => { release = resolve; }); };
    const first = cache.get(summaryInput, pending), duplicate = cache.get(summaryInput, pending);
    expect(calls).toBe(1); release('A concise generated summary.');
    await expect(Promise.all([first, duplicate])).resolves.toEqual(['A concise generated summary.', 'A concise generated summary.']);
    await expect(cache.get(summaryInput, async () => { calls += 1; return 'Unexpected'; })).resolves.toBe('A concise generated summary.');
    expect(calls).toBe(1);
    await expect(cache.get({ ...summaryInput, wordsThisWeek: 1_241 }, async () => { calls += 1; throw new Error('offline'); })).rejects.toThrow('offline');
    await expect(cache.get({ ...summaryInput, wordsThisWeek: 1_241 }, async () => { calls += 1; return 'Updated generated summary.'; })).resolves.toBe('Updated generated summary.');
    expect(calls).toBe(3);
  });

  it('provides a truthful local fallback without inventing unavailable values', () => {
    expect(localWeeklyUsageSummary(usage)).toBe('You gave your keyboard a breather with 1,240 dictated words and 2 completed meetings this week. Your longest brain dump ran 1 minute 22 seconds.');
    expect(localWeeklyUsageSummary({ ...usage, wordsThisWeek: 0, meetingsThisWeek: 0, longestDictationMs: null })).toContain('next idea lands');
    expect(localWeeklyUsageSummary({ ...usage, wordsThisWeek: null, meetingsThisWeek: null, longestDictationMs: null })).toContain('quick break');
  });
});
