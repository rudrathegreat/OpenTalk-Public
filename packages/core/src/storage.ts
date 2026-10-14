import { mkdir, open, readFile, rename, unlink, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  defaults, historyEntrySchema, historyQuerySchema, legacyColourVersionSixSettingsSchema, legacySettingsSchema, meetingGeneratedSchema, meetingRecordSchema, previousSettingsSchema, settingsSchema, versionFiveSettingsSchema, versionFourSettingsSchema, versionSevenSettingsSchema, versionSixSettingsSchema, versionThreeSettingsSchema,
  HISTORY_PAGE_SIZE, MAX_HISTORY_BYTES, MAX_HISTORY_ENTRIES, MEETING_PAGE_SIZE,
  type HistoryEntry, type HistoryPage, type HistoryQuery, type MeetingBookmark, type MeetingPage, type MeetingRecord, type Settings,
} from './contracts';
import { AppError } from './errors';

export async function atomicWrite(file: string, bytes: string | Uint8Array): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(() => undefined); }
}
export async function boundedRead(file: string, limit = 1024 * 1024): Promise<Buffer> {
  const handle = await open(file, 'r');
  try {
    if ((await handle.stat()).size > limit) throw new AppError('storage_size');
    const data = Buffer.alloc(limit + 1); let offset = 0;
    while (offset < data.length) {
      const read = await handle.read(data, offset, data.length - offset, null);
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    if (offset > limit) throw new AppError('storage_size');
    return data.subarray(0, offset);
  } finally { await handle.close(); }
}
export class SettingsStore {
  private value: Settings = structuredClone(defaults);
  private writes: Promise<void> = Promise.resolve();
  recovered = false;
  constructor(private readonly file: string) {}
  async load(): Promise<Settings> {
    try {
      const raw = JSON.parse((await boundedRead(this.file, 65536)).toString()) as unknown;
      const current = settingsSchema.safeParse(raw);
      let migrated = false;
      let loaded: Settings;
      if (current.success) loaded = current.data;
      else {
        const migrateCleanup = (cleanup: 'adaptive' | 'minimal'): Settings['cleanup'] => cleanup === 'adaptive' ? 'default' : cleanup;
        const versionSeven = versionSevenSettingsSchema.safeParse(raw); migrated = true;
        if (versionSeven.success) {
          loaded = { ...versionSeven.data, version: 8, colourTheme: defaults.colourTheme };
        } else {
          const versionSix = versionSixSettingsSchema.safeParse(raw);
          if (versionSix.success) {
            loaded = { ...versionSix.data, version: 8, cleanup: migrateCleanup(versionSix.data.cleanup), colourTheme: defaults.colourTheme };
          } else {
            const legacyColourVersionSix = legacyColourVersionSixSettingsSchema.safeParse(raw);
            if (legacyColourVersionSix.success) {
              loaded = { ...legacyColourVersionSix.data, version: 8, cleanup: migrateCleanup(legacyColourVersionSix.data.cleanup), playbackDeviceId: defaults.playbackDeviceId };
            } else {
              const versionFive = versionFiveSettingsSchema.safeParse(raw);
              if (versionFive.success) {
                loaded = { ...versionFive.data, version: 8, cleanup: migrateCleanup(versionFive.data.cleanup), playbackDeviceId: defaults.playbackDeviceId, colourTheme: defaults.colourTheme };
              } else {
                const versionFour = versionFourSettingsSchema.safeParse(raw);
                if (versionFour.success) {
                  loaded = { ...versionFour.data, version: 8, cleanup: migrateCleanup(versionFour.data.cleanup), softwareExperience: defaults.softwareExperience, playbackDeviceId: defaults.playbackDeviceId, colourTheme: defaults.colourTheme };
                } else {
                  const versionThree = versionThreeSettingsSchema.safeParse(raw);
                  if (versionThree.success) {
                    loaded = { ...versionThree.data, version: 8, cleanup: migrateCleanup(versionThree.data.cleanup), keepOverlayVisible: defaults.keepOverlayVisible, softwareExperience: defaults.softwareExperience, playbackDeviceId: defaults.playbackDeviceId, colourTheme: defaults.colourTheme };
                  } else {
                    const versionTwo = previousSettingsSchema.safeParse(raw);
                    const previous = versionTwo.success ? versionTwo.data : legacySettingsSchema.parse(raw);
                    loaded = {
                      version: 8,
                      enabled: previous.enabled,
                      microphoneId: previous.microphoneId,
                      playbackDeviceId: defaults.playbackDeviceId,
                      holdShortcut: previous.holdShortcut,
                      handsFreeShortcut: previous.handsFreeShortcut,
                      cleanup: migrateCleanup(previous.cleanup),
                      vocabulary: previous.vocabulary,
                      // One-time owner-authorized default change; subsequent explicit Whisper selections persist.
                      speechModel: defaults.speechModel,
                      launchAtLogin: previous.launchAtLogin,
                      keepOverlayVisible: defaults.keepOverlayVisible,
                      softwareExperience: defaults.softwareExperience,
                      colourTheme: defaults.colourTheme,
                    };
                  }
                }
              }
            }
          }
        }
      }
      const legacyDefault = loaded.holdShortcut === 'Ctrl+Win' && loaded.handsFreeShortcut === 'Ctrl+Win+Space';
      this.value = legacyDefault ? { ...loaded, holdShortcut: defaults.holdShortcut, handsFreeShortcut: defaults.handsFreeShortcut } : loaded;
      if (legacyDefault || migrated) await atomicWrite(this.file, JSON.stringify(this.value));
    }
    catch (e) {
      const missing = e instanceof Error && 'code' in e && e.code === 'ENOENT';
      this.recovered = !missing;
      // A new profile uses the product default. Invalid persisted settings fail closed.
      this.value = { ...structuredClone(defaults), enabled: missing ? defaults.enabled : false };
      if (this.recovered) await rename(this.file, `${this.file}.corrupt-${randomUUID()}`).catch(() => undefined);
    }
    return this.get();
  }
  get(): Settings { return structuredClone(this.value); }
  update(input: unknown): Promise<Settings> {
    const next = settingsSchema.parse(input);
    const operation = this.writes.then(async () => { await atomicWrite(this.file, JSON.stringify(next)); this.value = next; });
    this.writes = operation.catch(() => undefined);
    return operation.then(() => this.get());
  }
}
export interface Protector { encrypt(value: string): Buffer; decrypt(value: Buffer): string }
export class ProtectedStore<T> {
  private writes: Promise<void> = Promise.resolve();
  constructor(private readonly file: string, private readonly protector: Protector, private readonly validate: (value: unknown) => T) {}
  async load(fallback: T): Promise<T> {
    try { return this.validate(JSON.parse(this.protector.decrypt(await boundedRead(this.file))) as unknown); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return fallback;
      throw new AppError('credential_store_unavailable');
    }
  }
  save(value: T): Promise<void> {
    const data = this.protector.encrypt(JSON.stringify(this.validate(value)));
    const operation = this.writes.then(() => atomicWrite(this.file, data));
    this.writes = operation.catch(() => undefined); return operation;
  }
}
const historyDocumentSchema = z.object({ version: z.literal(1), entries: z.array(historyEntrySchema).max(MAX_HISTORY_ENTRIES) }).strict();
const historyCursorSchema = z.object({ createdAt: z.string().datetime({ offset: true }), id: z.string().uuid() }).strict();
export interface HistoryAppendResult { entry: HistoryEntry; removed: number }
export interface HistoryOverview { recent: HistoryEntry[]; wordsSince: number; longestDurationMs: number | null }
export interface WeeklyTopicCandidate { source: 'dictation' | 'meeting'; createdAt: string; text: string }
export interface WeeklyTopicCandidates { items: WeeklyTopicCandidate[]; totalItems: number }
export interface WeeklyTaskCandidate { source: 'dictation' | 'meeting'; sourceId: string; createdAt: string; text: string }
export interface WeeklyTaskCandidates { items: WeeklyTaskCandidate[]; totalItems: number }
export interface HistoryStoreOptions { maxEntries?: number; maxBytes?: number; now?: () => Date; id?: () => string }

function countWords(text: string): number {
  return text.match(/[\p{L}\p{N}]+(?:['\u2019-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

function historyOrder(left: HistoryEntry, right: HistoryEntry): number {
  return right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id);
}
function encodeHistoryCursor(entry: Pick<HistoryEntry, 'createdAt' | 'id'>): string {
  return Buffer.from(JSON.stringify({ createdAt: entry.createdAt, id: entry.id })).toString('base64url');
}
function decodeHistoryCursor(value: string): z.infer<typeof historyCursorSchema> {
  try { return historyCursorSchema.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown); }
  catch { throw new AppError('history_cursor'); }
}

export class EncryptedHistoryStore {
  private entries: HistoryEntry[] = [];
  private writes: Promise<void> = Promise.resolve();
  private available = false;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly now: () => Date;
  private readonly id: () => string;
  constructor(private readonly file: string, private readonly protector: Protector, options: HistoryStoreOptions = {}) {
    this.maxEntries = options.maxEntries ?? MAX_HISTORY_ENTRIES;
    this.maxBytes = options.maxBytes ?? MAX_HISTORY_BYTES;
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? randomUUID;
  }
  async load(): Promise<void> {
    try {
      const encrypted = await boundedRead(this.file, MAX_HISTORY_BYTES + 1024 * 1024);
      const document = historyDocumentSchema.parse(JSON.parse(this.protector.decrypt(encrypted)) as unknown);
      const serialized = JSON.stringify(document);
      if (Buffer.byteLength(serialized) > this.maxBytes || document.entries.length > this.maxEntries) throw new AppError('history_size');
      this.entries = document.entries.toSorted(historyOrder);
      this.available = true;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        this.entries = []; this.available = true; return;
      }
      this.available = false;
      throw new AppError('history_store_unavailable');
    }
  }
  isAvailable(): boolean { return this.available; }
  query(input: unknown): HistoryPage {
    if (!this.available) throw new AppError('history_store_unavailable');
    const query = historyQuerySchema.parse(input) as HistoryQuery;
    const needle = query.search.trim().toLocaleLowerCase();
    const cursor = query.cursor ? decodeHistoryCursor(query.cursor) : null;
    const matching = this.entries.filter(entry => {
      if (needle && !entry.text.toLocaleLowerCase().includes(needle)) return false;
      return !cursor || entry.createdAt < cursor.createdAt || (entry.createdAt === cursor.createdAt && entry.id < cursor.id);
    });
    const items = matching.slice(0, HISTORY_PAGE_SIZE).map(entry => ({ ...entry }));
    return { items, nextCursor: matching.length > items.length && items.length ? encodeHistoryCursor(items.at(-1)!) : null, total: this.entries.filter(entry => !needle || entry.text.toLocaleLowerCase().includes(needle)).length };
  }
  add(text: unknown, durationMs?: unknown): Promise<HistoryAppendResult> {
    if (!this.available) return Promise.reject(new AppError('history_store_unavailable'));
    const entry = historyEntrySchema.parse({ id: this.id(), createdAt: this.now().toISOString(), text, durationMs });
    let result!: HistoryAppendResult;
    const operation = this.writes.then(async () => {
      const next = [entry, ...this.entries].toSorted(historyOrder);
      let removed = 0;
      while (next.length > this.maxEntries) { next.pop(); removed += 1; }
      let serialized = JSON.stringify({ version: 1, entries: next });
      while (Buffer.byteLength(serialized) > this.maxBytes && next.length > 1) {
        next.pop(); removed += 1; serialized = JSON.stringify({ version: 1, entries: next });
      }
      if (Buffer.byteLength(serialized) > this.maxBytes) throw new AppError('history_size');
      await atomicWrite(this.file, this.protector.encrypt(serialized));
      this.entries = next; result = { entry: { ...entry }, removed };
    });
    this.writes = operation.catch(() => undefined);
    return operation.then(() => result).catch(() => { this.available = false; throw new AppError('history_store_unavailable'); });
  }
  delete(id: unknown): Promise<boolean> {
    const validId = z.string().uuid().parse(id);
    if (!this.available) return Promise.reject(new AppError('history_store_unavailable'));
    let deleted = false;
    const operation = this.writes.then(async () => {
      const next = this.entries.filter(entry => entry.id !== validId);
      if (next.length === this.entries.length) return;
      const serialized = JSON.stringify({ version: 1, entries: next });
      await atomicWrite(this.file, this.protector.encrypt(serialized));
      this.entries = next; deleted = true;
    });
    this.writes = operation.catch(() => undefined);
    return operation.then(() => deleted).catch(() => { this.available = false; throw new AppError('history_store_unavailable'); });
  }
  find(id: unknown): HistoryEntry | null {
    const validId = z.string().uuid().parse(id);
    if (!this.available) throw new AppError('history_store_unavailable');
    const entry = this.entries.find(candidate => candidate.id === validId);
    return entry ? { ...entry } : null;
  }
  overviewSince(since: Date): HistoryOverview {
    if (!this.available) throw new AppError('history_store_unavailable');
    const threshold = since.getTime();
    if (!Number.isFinite(threshold)) throw new AppError('history_query');
    const current = this.entries.filter(entry => Date.parse(entry.createdAt) >= threshold);
    const durations = current.flatMap(entry => entry.durationMs === undefined ? [] : [entry.durationMs]);
    return {
      recent: this.entries.slice(0, 2).map(entry => ({ ...entry })),
      wordsSince: current.reduce((total, entry) => total + countWords(entry.text), 0),
      longestDurationMs: durations.length ? Math.max(...durations) : null,
    };
  }
  topicCandidatesSince(since: Date, limit: number): WeeklyTopicCandidates {
    if (!this.available) throw new AppError('history_store_unavailable');
    const threshold = since.getTime();
    const boundedLimit = z.number().int().nonnegative().max(100).parse(limit);
    if (!Number.isFinite(threshold)) throw new AppError('history_query');
    const current = this.entries.filter(entry => Date.parse(entry.createdAt) >= threshold);
    return {
      items: current.slice(0, boundedLimit).map(entry => ({ source: 'dictation', createdAt: entry.createdAt, text: entry.text })),
      totalItems: current.length,
    };
  }
  taskCandidatesSince(since: Date, limit: number): WeeklyTaskCandidates {
    if (!this.available) throw new AppError('history_store_unavailable');
    const threshold = since.getTime();
    const boundedLimit = z.number().int().nonnegative().max(100).parse(limit);
    if (!Number.isFinite(threshold)) throw new AppError('history_query');
    const current = this.entries.filter(entry => Date.parse(entry.createdAt) >= threshold);
    return {
      items: current.slice(0, boundedLimit).map(entry => ({ source: 'dictation', sourceId: entry.id, createdAt: entry.createdAt, text: entry.text })),
      totalItems: current.length,
    };
  }
}

const meetingDocumentSchema = z.union([
  z.object({ version: z.literal(1), meetings: z.array(meetingRecordSchema).max(1_000) }).strict(),
  z.object({ version: z.literal(2), meetings: z.array(meetingRecordSchema).max(1_000) }).strict(),
]);
const MAX_MEETING_STORE_BYTES = 50 * 1024 * 1024;
function meetingOrder(left: MeetingRecord, right: MeetingRecord): number {
  return right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id);
}

export class EncryptedMeetingStore {
  private meetings: MeetingRecord[] = [];
  private writes: Promise<void> = Promise.resolve();
  private available = false;
  constructor(private readonly file: string, private readonly protector: Protector) {}
  async load(): Promise<void> {
    try {
      const encrypted = await boundedRead(this.file, MAX_MEETING_STORE_BYTES + 1024 * 1024);
      const document = meetingDocumentSchema.parse(JSON.parse(this.protector.decrypt(encrypted)) as unknown);
      if (Buffer.byteLength(JSON.stringify(document)) > MAX_MEETING_STORE_BYTES) throw new AppError('meeting_store_size');
      this.meetings = document.meetings.toSorted(meetingOrder); this.available = true;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') { this.meetings = []; this.available = true; return; }
      this.available = false; throw new AppError('meeting_store_unavailable');
    }
  }
  isAvailable(): boolean { return this.available; }
  private commit(next: MeetingRecord[]): Promise<void> {
    const operation = this.writes.then(async () => {
      let retained = next.toSorted(meetingOrder);
      while (retained.length > 1_000) retained = retained.slice(0, -1);
      let serialized = JSON.stringify({ version: 2, meetings: retained });
      while (Buffer.byteLength(serialized) > MAX_MEETING_STORE_BYTES && retained.length > 1) {
        retained = retained.slice(0, -1); serialized = JSON.stringify({ version: 2, meetings: retained });
      }
      if (Buffer.byteLength(serialized) > MAX_MEETING_STORE_BYTES) throw new AppError('meeting_store_size');
      await atomicWrite(this.file, this.protector.encrypt(serialized)); this.meetings = retained;
    });
    this.writes = operation.catch(() => undefined);
    return operation.catch(() => { this.available = false; throw new AppError('meeting_store_unavailable'); });
  }
  addDraft(input: { id: string; createdAt: string; endedAt: string; transcript: string; bookmarks: MeetingBookmark[] }): Promise<MeetingRecord> {
    if (!this.available) return Promise.reject(new AppError('meeting_store_unavailable'));
    const created = new Date(input.createdAt);
    const title = `Meeting · ${new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(created)}`;
    const record = meetingRecordSchema.parse({ ...input, title, shortSummary: '', longSummary: '', minutesMarkdown: '', summaryStatus: 'processing' });
    return this.commit([record, ...this.meetings.filter(value => value.id !== record.id)]).then(() => ({ ...record }));
  }
  complete(id: unknown, generated: unknown): Promise<MeetingRecord> {
    const validId = z.string().uuid().parse(id), value = meetingGeneratedSchema.parse(generated);
    const current = this.meetings.find(meeting => meeting.id === validId);
    if (!current) return Promise.reject(new AppError('meeting_missing'));
    const next = meetingRecordSchema.parse({ ...current, ...value, summaryStatus: 'ready' });
    return this.commit([next, ...this.meetings.filter(meeting => meeting.id !== validId)]).then(() => ({ ...next }));
  }
  fail(id: unknown): Promise<void> {
    const validId = z.string().uuid().parse(id), current = this.meetings.find(meeting => meeting.id === validId);
    if (!current) return Promise.resolve();
    return this.commit([{ ...current, summaryStatus: 'failed' }, ...this.meetings.filter(meeting => meeting.id !== validId)]);
  }
  query(input: unknown): MeetingPage {
    if (!this.available) throw new AppError('meeting_store_unavailable');
    const query = historyQuerySchema.parse(input) as HistoryQuery, needle = query.search.trim().toLocaleLowerCase();
    const cursor = query.cursor ? decodeHistoryCursor(query.cursor) : null;
    const searched = this.meetings.filter(meeting => !needle || `${meeting.title}\n${meeting.shortSummary}\n${meeting.transcript}`.toLocaleLowerCase().includes(needle));
    const matching = searched.filter(meeting => !cursor || meeting.createdAt < cursor.createdAt || (meeting.createdAt === cursor.createdAt && meeting.id < cursor.id));
    const records = matching.slice(0, MEETING_PAGE_SIZE);
    const items = records.map(({ id, createdAt, endedAt, title, shortSummary, summaryStatus }) => ({ id, createdAt, endedAt, title, shortSummary, summaryStatus }));
    return { items, nextCursor: matching.length > records.length && records.length ? encodeHistoryCursor(records.at(-1)!) : null, total: searched.length };
  }
  find(id: unknown): MeetingRecord | null {
    const validId = z.string().uuid().parse(id);
    if (!this.available) throw new AppError('meeting_store_unavailable');
    const meeting = this.meetings.find(value => value.id === validId); return meeting ? { ...meeting, bookmarks: meeting.bookmarks.map(bookmark => ({ ...bookmark })) } : null;
  }
  delete(id: unknown): Promise<boolean> {
    const validId = z.string().uuid().parse(id);
    if (!this.available) return Promise.reject(new AppError('meeting_store_unavailable'));
    if (!this.meetings.some(meeting => meeting.id === validId)) return Promise.resolve(false);
    return this.commit(this.meetings.filter(meeting => meeting.id !== validId)).then(() => true);
  }
  countSince(since: Date): number {
    if (!this.available) throw new AppError('meeting_store_unavailable');
    const threshold = since.getTime();
    if (!Number.isFinite(threshold)) throw new AppError('meeting_query');
    return this.meetings.filter(meeting => Date.parse(meeting.createdAt) >= threshold).length;
  }
  topicCandidatesSince(since: Date, limit: number): WeeklyTopicCandidates {
    if (!this.available) throw new AppError('meeting_store_unavailable');
    const threshold = since.getTime();
    const boundedLimit = z.number().int().nonnegative().max(100).parse(limit);
    if (!Number.isFinite(threshold)) throw new AppError('meeting_query');
    const current = this.meetings.filter(meeting => Date.parse(meeting.createdAt) >= threshold && meeting.summaryStatus === 'ready' && meeting.shortSummary.trim());
    return {
      items: current.slice(0, boundedLimit).map(meeting => ({ source: 'meeting', createdAt: meeting.createdAt, text: `${meeting.title}. ${meeting.shortSummary}` })),
      totalItems: current.length,
    };
  }
  taskCandidatesSince(since: Date, limit: number): WeeklyTaskCandidates {
    if (!this.available) throw new AppError('meeting_store_unavailable');
    const threshold = since.getTime();
    const boundedLimit = z.number().int().nonnegative().max(100).parse(limit);
    if (!Number.isFinite(threshold)) throw new AppError('meeting_query');
    const current = this.meetings.filter(meeting => Date.parse(meeting.createdAt) >= threshold);
    return {
      items: current.slice(0, boundedLimit).map(meeting => ({
        source: 'meeting',
        sourceId: meeting.id,
        createdAt: meeting.createdAt,
        text: meeting.summaryStatus === 'ready' ? `${meeting.title}\n${meeting.longSummary}` : meeting.transcript,
      })),
      totalItems: current.length,
    };
  }
}
export async function exists(file: string): Promise<boolean> { try { return (await stat(file)).isFile(); } catch { return false; } }
export async function readText(file: string): Promise<string> { return (await readFile(file, 'utf8')); }
