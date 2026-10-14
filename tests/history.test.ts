import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { startOfLocalWeek } from '../packages/core/src/contracts';
import { EncryptedHistoryStore, type Protector } from '../packages/core/src/storage';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function temporary(): Promise<string> { const path = await mkdtemp(join(tmpdir(), 'opentalk-history-test-')); directories.push(path); return path; }
function protect(value: string | Buffer): Buffer {
  const input = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  const output = Buffer.alloc(input.length);
  for (let index = 0; index < input.length; index += 1) output[index] = input[index]! ^ 0xa5;
  return output;
}
const protector: Protector = {
  encrypt(value) { return protect(value); },
  decrypt(value) { return protect(value).toString('utf8'); },
};
function clock() { let value = Date.parse('2026-10-04T05:00:00.000Z'); return () => new Date(value += 1000); }

describe('encrypted dictation history', () => {
  it('starts weekly overview totals at local Monday midnight', () => {
    const start = startOfLocalWeek(new Date(2026, 9, 7, 15, 30));
    expect(start.getDay()).toBe(1); expect(start.getDate()).toBe(5); expect(start.getHours()).toBe(0); expect(start.getMinutes()).toBe(0);
  });
  it('persists Unicode without leaving plaintext at rest', async () => {
    const file = join(await temporary(), 'history.enc');
    const store = new EncryptedHistoryStore(file, protector, { now: clock() }); await store.load();
    await store.add('Meet at the café in 東京.');
    expect((await readFile(file)).includes(Buffer.from('café'))).toBe(false);
    const reopened = new EncryptedHistoryStore(file, protector); await reopened.load();
    expect(reopened.query({ search: '', cursor: null }).items[0]?.text).toBe('Meet at the café in 東京.');
  });

  it('serializes concurrent appends in newest-first order and supports case-insensitive search', async () => {
    const store = new EncryptedHistoryStore(join(await temporary(), 'history.enc'), protector, { now: clock() }); await store.load();
    await Promise.all([store.add('First Project Atlas note'), store.add('Second project atlas note'), store.add('Unrelated message')]);
    const all = store.query({ search: '', cursor: null });
    expect(all.items.map(entry => entry.text)).toEqual(['Unrelated message', 'Second project atlas note', 'First Project Atlas note']);
    expect(store.query({ search: '  PROJECT ATLAS ', cursor: null }).items.map(entry => entry.text)).toEqual(['Second project atlas note', 'First Project Atlas note']);
  });

  it('summarizes recent dictations and this-week word and duration totals without inventing old durations', async () => {
    const dates = [new Date('2026-10-05T01:00:00.000Z'), new Date('2026-10-06T01:00:00.000Z'), new Date('2026-10-07T01:00:00.000Z')];
    const store = new EncryptedHistoryStore(join(await temporary(), 'history.enc'), protector, { now: () => dates.shift()! }); await store.load();
    await store.add('Before this week has four words.');
    const project = await store.add('Project Atlas is ready', 82_000);
    const ship = await store.add('Ship Thursday', 522_000);
    const summary = store.overviewSince(new Date('2026-10-06T00:00:00.000Z'));
    expect(summary.recent.map(entry => entry.text)).toEqual(['Ship Thursday', 'Project Atlas is ready']);
    expect(summary.wordsSince).toBe(6);
    expect(summary.longestDurationMs).toBe(522_000);
    expect(store.overviewSince(new Date('2026-10-08T00:00:00.000Z')).longestDurationMs).toBeNull();
    expect(store.topicCandidatesSince(new Date('2026-10-06T00:00:00.000Z'), 10)).toEqual({
      items: [
        { source: 'dictation', createdAt: '2026-10-07T01:00:00.000Z', text: 'Ship Thursday' },
        { source: 'dictation', createdAt: '2026-10-06T01:00:00.000Z', text: 'Project Atlas is ready' },
      ],
      totalItems: 2,
    });
    expect(store.taskCandidatesSince(new Date('2026-10-06T00:00:00.000Z'), 10)).toEqual({
      items: [
        { source: 'dictation', sourceId: ship.entry.id, createdAt: '2026-10-07T01:00:00.000Z', text: 'Ship Thursday' },
        { source: 'dictation', sourceId: project.entry.id, createdAt: '2026-10-06T01:00:00.000Z', text: 'Project Atlas is ready' },
      ],
      totalItems: 2,
    });
  });

  it('returns stable pages of fifty entries', async () => {
    const store = new EncryptedHistoryStore(join(await temporary(), 'history.enc'), protector, { now: clock() }); await store.load();
    for (let index = 0; index < 55; index += 1) await store.add(`Synthetic message ${index}`);
    const first = store.query({ search: '', cursor: null });
    expect(first.items).toHaveLength(50); expect(first.total).toBe(55); expect(first.nextCursor).not.toBeNull();
    const second = store.query({ search: '', cursor: first.nextCursor });
    expect(second.items).toHaveLength(5); expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map(entry => entry.id)).size).toBe(55);
  });

  it('deletes only the selected entry and persists the deletion', async () => {
    const file = join(await temporary(), 'history.enc');
    const store = new EncryptedHistoryStore(file, protector, { now: clock() }); await store.load();
    const retained = await store.add('Keep this'); const deleted = await store.add('Delete this');
    expect(await store.delete(deleted.entry.id)).toBe(true); expect(await store.delete(randomUUID())).toBe(false);
    expect(store.find(deleted.entry.id)).toBeNull(); expect(store.find(retained.entry.id)?.text).toBe('Keep this');
    const reopened = new EncryptedHistoryStore(file, protector); await reopened.load();
    expect(reopened.query({ search: '', cursor: null }).items.map(entry => entry.text)).toEqual(['Keep this']);
  });

  it('removes the oldest entries at the configured count and byte limits', async () => {
    const countStore = new EncryptedHistoryStore(join(await temporary(), 'count.enc'), protector, { maxEntries: 2, now: clock() }); await countStore.load();
    await countStore.add('oldest'); await countStore.add('middle'); const countResult = await countStore.add('newest');
    expect(countResult.removed).toBe(1); expect(countStore.query({ search: '', cursor: null }).items.map(entry => entry.text)).toEqual(['newest', 'middle']);

    const byteStore = new EncryptedHistoryStore(join(await temporary(), 'bytes.enc'), protector, { maxBytes: 260, now: clock() }); await byteStore.load();
    await byteStore.add('a'.repeat(40)); const byteResult = await byteStore.add('b'.repeat(40));
    expect(byteResult.removed).toBe(1); expect(byteStore.query({ search: '', cursor: null }).items.map(entry => entry.text)).toEqual(['b'.repeat(40)]);
  });

  it('preserves corrupt encrypted data and never falls back to plaintext', async () => {
    const directory = await temporary(), corruptFile = join(directory, 'corrupt.enc'), failedFile = join(directory, 'failed.enc');
    const original = Buffer.from('encrypted-but-invalid'); await writeFile(corruptFile, original);
    const corrupt = new EncryptedHistoryStore(corruptFile, protector);
    await expect(corrupt.load()).rejects.toThrow('Sorry, not available');
    expect(await readFile(corruptFile)).toEqual(original); expect(corrupt.isAvailable()).toBe(false);

    const unavailable: Protector = { encrypt: () => { throw new Error('DPAPI unavailable'); }, decrypt: () => { throw new Error('DPAPI unavailable'); } };
    const failed = new EncryptedHistoryStore(failedFile, unavailable); await failed.load();
    await expect(failed.add('private history text')).rejects.toThrow();
    await expect(readFile(failedFile)).rejects.toThrow();
  });
});
