import { z } from 'zod';

export const CLEANUP_MODEL = 'gpt-5.6-luna' as const;
export const CLEANUP_MODEL_LABEL = 'GPT-5.6 Luna' as const;
export const CLEANUP_REASONING_EFFORT = 'none' as const;
export const HISTORY_PAGE_SIZE = 50 as const;
export const MAX_HISTORY_QUERY_LENGTH = 200 as const;
export const MAX_HISTORY_ENTRIES = 5_000 as const;
export const MAX_HISTORY_BYTES = 50 * 1024 * 1024;
export const MAX_HISTORY_TEXT_LENGTH = 192_000 as const;
export const MAX_HISTORY_DURATION_MS = 24 * 60 * 60 * 1000;
export const MEETING_PAGE_SIZE = 50 as const;
export const MAX_MEETING_TRANSCRIPT_LENGTH = 1_000_000 as const;
export const MAX_MEETING_SUMMARY_LENGTH = 12_000 as const;
export const MAX_MEETING_MINUTES_LENGTH = 64_000 as const;
export const MAX_MEETING_BOOKMARKS = 1_000 as const;
export const MAX_MEETING_DURATION_MS = 24 * 60 * 60 * 1000;
export const MAX_WEEKLY_TASKS = 50 as const;
export const MAX_WEEKLY_TASK_TEXT_LENGTH = 500 as const;

const shortcut = z.string().min(3).max(80).regex(/^(Ctrl|Alt|Shift|Win)(\+(Ctrl|Alt|Shift|Win)){0,3}(\+(Space|[A-Z]|F([1-9]|1[0-2])))?$/).refine(value => {
  const parts = value.split('+');
  return new Set(parts).size === parts.length && (parts.includes('Ctrl') || parts.includes('Alt'));
}, 'Use a distinct combination including Ctrl or Alt.');
const legacySettingsFields = {
  enabled: z.boolean(), microphoneId: z.string().max(512),
  holdShortcut: shortcut, handsFreeShortcut: shortcut,
  cleanup: z.enum(['adaptive', 'minimal']), vocabulary: z.array(z.string().trim().min(1).max(100)).max(200),
  speechModel: z.enum(['moonshine-small-streaming-en', 'base.en', 'small.en']), launchAtLogin: z.boolean(),
} as const;
const versionFourSettingsFields = { ...legacySettingsFields, keepOverlayVisible: z.boolean() } as const;
const versionFiveSettingsFields = { ...versionFourSettingsFields, softwareExperience: z.enum(['default', 'expressive']) } as const;
const versionSixSettingsFields = { ...versionFiveSettingsFields, playbackDeviceId: z.string().max(512) } as const;
const legacyColourVersionSixSettingsFields = { ...versionFiveSettingsFields, colourTheme: z.enum(['default', 'vibrant']) } as const;
const versionSevenSettingsFields = {
  ...versionSixSettingsFields,
  cleanup: z.enum(['default', 'minimal', 'casual', 'professional', 'extensive']),
} as const;
const currentSettingsFields = { ...versionSevenSettingsFields, colourTheme: z.enum(['default', 'vibrant', 'gradient']) } as const;
const shortcutsDiffer = (s: { holdShortcut: string; handsFreeShortcut: string }) => s.holdShortcut !== s.handsFreeShortcut;
const vocabularyUnique = (s: { vocabulary: string[] }) => new Set(s.vocabulary.map(x => x.toLocaleLowerCase('en'))).size === s.vocabulary.length;
export const settingsSchema = z.object({ version: z.literal(8), ...currentSettingsFields }).strict()
  .refine(shortcutsDiffer, 'Shortcuts must differ.').refine(vocabularyUnique, 'Vocabulary entries must be unique.');
export const versionSevenSettingsSchema = z.object({ version: z.literal(7), ...versionSevenSettingsFields }).strict()
  .refine(shortcutsDiffer, 'Shortcuts must differ.').refine(vocabularyUnique, 'Vocabulary entries must be unique.');
export const versionSixSettingsSchema = z.object({ version: z.literal(6), ...versionSixSettingsFields }).strict()
  .refine(shortcutsDiffer, 'Shortcuts must differ.').refine(vocabularyUnique, 'Vocabulary entries must be unique.');
export const legacyColourVersionSixSettingsSchema = z.object({ version: z.literal(6), ...legacyColourVersionSixSettingsFields }).strict()
  .refine(shortcutsDiffer, 'Shortcuts must differ.').refine(vocabularyUnique, 'Vocabulary entries must be unique.');
export const versionFiveSettingsSchema = z.object({ version: z.literal(5), ...versionFiveSettingsFields }).strict()
  .refine(shortcutsDiffer, 'Shortcuts must differ.').refine(vocabularyUnique, 'Vocabulary entries must be unique.');
export const versionFourSettingsSchema = z.object({ version: z.literal(4), ...versionFourSettingsFields }).strict()
  .refine(shortcutsDiffer, 'Shortcuts must differ.').refine(vocabularyUnique, 'Vocabulary entries must be unique.');
export const versionThreeSettingsSchema = z.object({ version: z.literal(3), ...legacySettingsFields }).strict()
  .refine(shortcutsDiffer, 'Shortcuts must differ.').refine(vocabularyUnique, 'Vocabulary entries must be unique.');
const previousFields = { ...legacySettingsFields, speechModel: z.enum(['base.en', 'small.en']) } as const;
export const previousSettingsSchema = z.object({ version: z.literal(2), ...previousFields }).strict()
  .refine(shortcutsDiffer, 'Shortcuts must differ.').refine(vocabularyUnique, 'Vocabulary entries must be unique.');
export const legacySettingsSchema = z.object({ version: z.literal(1), ...previousFields, cleanupModel: z.string().max(100) }).strict()
  .refine(shortcutsDiffer, 'Shortcuts must differ.').refine(vocabularyUnique, 'Vocabulary entries must be unique.');
export type Settings = z.infer<typeof settingsSchema>;
export const defaults: Settings = {
  version: 8, enabled: true, microphoneId: '', playbackDeviceId: '', holdShortcut: 'Ctrl+Shift', handsFreeShortcut: 'Ctrl+Shift+Space',
  cleanup: 'default', vocabulary: [], speechModel: 'moonshine-small-streaming-en', launchAtLogin: false,
  keepOverlayVisible: false, softwareExperience: 'default', colourTheme: 'default',
};
export const idSchema = z.string().uuid();
export const historyEntrySchema = z.object({
  id: idSchema,
  createdAt: z.string().datetime({ offset: true }),
  text: z.string().trim().min(1).max(MAX_HISTORY_TEXT_LENGTH).refine(value => !value.includes('\0'), 'History text contains an invalid character.'),
  durationMs: z.number().int().nonnegative().max(MAX_HISTORY_DURATION_MS).optional(),
}).strict();
export const historyQuerySchema = z.object({
  search: z.string().max(MAX_HISTORY_QUERY_LENGTH),
  cursor: z.string().max(512).nullable(),
}).strict();
export type HistoryEntry = z.infer<typeof historyEntrySchema>;
export type HistoryQuery = z.infer<typeof historyQuerySchema>;
export interface HistoryPage { items: HistoryEntry[]; nextCursor: string | null; total: number }
export const meetingGeneratedSchema = z.object({
  title: z.string().trim().min(1).max(160),
  shortSummary: z.string().trim().min(1).max(1_200),
  longSummary: z.string().trim().min(1).max(MAX_MEETING_SUMMARY_LENGTH),
  minutesMarkdown: z.string().trim().min(1).max(MAX_MEETING_MINUTES_LENGTH),
}).strict();
export const meetingBookmarkSchema = z.object({
  id: idSchema,
  offsetMs: z.number().int().nonnegative().max(MAX_MEETING_DURATION_MS),
  transcriptOffset: z.number().int().nonnegative().max(MAX_MEETING_TRANSCRIPT_LENGTH),
}).strict();
export const meetingRecordSchema = z.object({
  id: idSchema,
  createdAt: z.string().datetime({ offset: true }),
  endedAt: z.string().datetime({ offset: true }),
  title: z.string().trim().min(1).max(160),
  shortSummary: z.string().max(1_200),
  longSummary: z.string().max(MAX_MEETING_SUMMARY_LENGTH),
  minutesMarkdown: z.string().max(MAX_MEETING_MINUTES_LENGTH),
  transcript: z.string().trim().min(1).max(MAX_MEETING_TRANSCRIPT_LENGTH).refine(value => !value.includes('\0'), 'Meeting transcript contains an invalid character.'),
  bookmarks: z.array(meetingBookmarkSchema).max(MAX_MEETING_BOOKMARKS).default([]),
  summaryStatus: z.enum(['processing', 'ready', 'failed']),
}).strict().superRefine((value, context) => {
  value.bookmarks.forEach((bookmark, index) => {
    if (bookmark.transcriptOffset > value.transcript.length) context.addIssue({ code: 'custom', path: ['bookmarks', index, 'transcriptOffset'], message: 'Bookmark is outside the transcript.' });
  });
});
export const meetingQuerySchema = historyQuerySchema;
export type MeetingGenerated = z.infer<typeof meetingGeneratedSchema>;
export type MeetingBookmark = z.infer<typeof meetingBookmarkSchema>;
export type MeetingRecord = z.infer<typeof meetingRecordSchema>;
export type MeetingListItem = Pick<MeetingRecord, 'id' | 'createdAt' | 'endedAt' | 'title' | 'shortSummary' | 'summaryStatus'>;
export interface MeetingPage { items: MeetingListItem[]; nextCursor: string | null; total: number }
export interface WeeklyUsage {
  weekStartedAt: string;
  wordsThisWeek: number | null;
  meetingsThisWeek: number | null;
  longestDictationMs: number | null;
}
export interface OverviewSummary extends WeeklyUsage {
  recentDictations: HistoryEntry[];
  weeklySummary: string;
}
export const weeklyTaskSchema = z.object({
  id: z.string().min(1).max(64),
  text: z.string().trim().min(1).max(MAX_WEEKLY_TASK_TEXT_LENGTH).refine(value => !value.includes('\0'), 'Task text contains an invalid character.'),
  source: z.enum(['dictation', 'meeting']),
  sourceId: idSchema,
  createdAt: z.string().datetime({ offset: true }),
}).strict();
export type WeeklyTask = z.infer<typeof weeklyTaskSchema>;
export interface WeeklyTasks {
  weekStartedAt: string;
  tasks: WeeklyTask[];
  available: boolean;
  limited: boolean;
}
export function startOfLocalWeek(now: Date): Date {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  return start;
}
export type MeetingPhase = 'idle' | 'starting' | 'recording' | 'pausing' | 'paused' | 'processing' | 'failed';
export interface MeetingState { phase: MeetingPhase; transcript: string; startedAt: string | null; bookmarks: MeetingBookmark[] }
export type AssistantPhase = 'hidden' | 'offered' | 'recording' | 'processing' | 'review' | 'inserting' | 'done' | 'blocked' | 'unavailable';
export type AssistantBlockReason = 'selection-unavailable' | 'window-changed' | 'control-changed' | 'input-changed' | 'focus-changed' | 'text-changed' | 'security-blocked' | 'clipboard-unavailable' | 'unknown';
export interface AssistantState { phase: AssistantPhase; blockedReason?: AssistantBlockReason }
export type AssistantChoice = 'replace' | 'append';
export interface AccountView { id: string; label: string; connected: boolean; planEnabled: boolean; selected: boolean }
export interface ModelView { slug: string; displayName: string }
export interface AudioDevice { id: string; name: string; isDefault: boolean }
export type Microphone = AudioDevice;
export type PlaybackDevice = AudioDevice;
function preferredAudioDeviceId(savedId: string, devices: AudioDevice[]): string {
  if (devices.some(device => device.id === savedId)) return savedId;
  return devices.find(device => device.isDefault)?.id ?? savedId;
}
export const preferredMicrophoneId = preferredAudioDeviceId;
export const preferredPlaybackDeviceId = preferredAudioDeviceId;
export type Phase = 'idle' | 'recording' | 'transcribing' | 'cleaning' | 'inserting' | 'done' | 'blocked' | 'unavailable' | 'disabled' | 'busy';
export type DictationMode = 'dictation' | 'command';
export interface Status { phase: Phase; message: string; canCopy: boolean }
export function overlayNeedsPointerInput(status: Status, meeting: MeetingState = { phase: 'idle', transcript: '', startedAt: null, bookmarks: [] }): boolean {
  return meeting.phase !== 'idle' || status.phase === 'idle' || status.phase === 'disabled' || (status.phase === 'blocked' && status.canCopy);
}
export function overlayShouldBeVisible(
  status: Status,
  launchHintActive: boolean,
  keepOverlayVisible: boolean,
  meeting: MeetingState = { phase: 'idle', transcript: '', startedAt: null, bookmarks: [] },
): boolean {
  const meetingActive = meeting.phase !== 'idle' && meeting.phase !== 'failed';
  return launchHintActive || keepOverlayVisible || meetingActive || (status.phase !== 'idle' && status.phase !== 'disabled');
}
export type RecordingLayerTransitionPhase = 'compact-exit' | 'expanded-exit';
export interface Snapshot { settings: Settings; accounts: AccountView[]; models: ModelView[]; microphones: Microphone[]; playbackDevices: PlaybackDevice[]; status: Status; notice: string; modelReady: boolean; nativeReady: boolean; historyAvailable: boolean; historyRevision: number; meetingsAvailable: boolean; meetingsRevision: number; meeting: MeetingState; assistant: AssistantState; commandMode: boolean; audioLevel: number; recordingLayerTransition?: RecordingLayerTransitionPhase; assistantLayerTransition?: 'exit' }
export function dictationSetupReady(input: Pick<Snapshot, 'settings' | 'accounts' | 'models' | 'microphones' | 'modelReady' | 'nativeReady'>): boolean {
  const account = input.accounts.find(candidate => candidate.selected);
  return input.nativeReady && input.modelReady && input.models.some(model => model.slug === CLEANUP_MODEL) && input.microphones.some(microphone => microphone.id === input.settings.microphoneId) && Boolean(account?.connected && account.planEnabled);
}
export function meetingPlaybackReady(input: Pick<Snapshot, 'settings' | 'playbackDevices' | 'nativeReady'>): boolean {
  return input.nativeReady && input.playbackDevices.some(device => device.id === input.settings.playbackDeviceId);
}
export interface DesktopBridge {
  recordingVisible(): Promise<void>;
  getSnapshot(): Promise<Snapshot>;
  updateSettings(settings: Settings): Promise<Snapshot>;
  signIn(id: string | null): Promise<Snapshot>;
  testCleanup(): Promise<Snapshot>;
  cancelSignIn(): Promise<Snapshot>;
  selectAccount(id: string): Promise<Snapshot>;
  disconnect(id: string): Promise<Snapshot>;
  manageUsage(): Promise<void>;
  refreshDevices(): Promise<Snapshot>;
  testMicrophone(): Promise<void>;
  downloadModel(): Promise<Snapshot>;
  cancelDownload(): Promise<void>;
  setEnabled(value: boolean): Promise<Snapshot>;
  cancelSession(): Promise<void>;
  copyRecovery(): Promise<boolean>;
  setOverlayPointerInput(enabled: boolean): Promise<void>;
  setCommandMode(enabled: boolean): Promise<void>;
  startAssistant(): Promise<void>;
  stopAssistant(): Promise<void>;
  acceptAssistant(choice: AssistantChoice): Promise<void>;
  getAssistantResult(): Promise<string>;
  copyAssistant(): Promise<boolean>;
  getOverview(): Promise<OverviewSummary>;
  getWeeklyTasks(): Promise<WeeklyTasks>;
  queryHistory(query: HistoryQuery): Promise<HistoryPage>;
  copyHistory(id: string): Promise<boolean>;
  deleteHistory(id: string): Promise<boolean>;
  startMeeting(): Promise<void>;
  pauseMeeting(): Promise<void>;
  resumeMeeting(): Promise<void>;
  bookmarkMeeting(): Promise<void>;
  stopMeeting(): Promise<void>;
  queryMeetings(query: HistoryQuery): Promise<MeetingPage>;
  getMeeting(id: string): Promise<MeetingRecord | null>;
  deleteMeeting(id: string): Promise<boolean>;
  exportMeetingMinutes(id: string): Promise<boolean>;
  onStatus(listener: (snapshot: Snapshot) => void): () => void;
}

export const envelopeSchema = z.object({
  version: z.literal(1), requestId: z.string().uuid(), generation: z.number().int().nonnegative(),
  sessionId: z.string().uuid().nullable(), sequence: z.number().int().nonnegative(),
  type: z.enum(['ready', 'workerReady', 'workerUnavailable', 'timing', 'microphones', 'playbackDevices', 'started', 'stopped', 'cancel', 'meeting', 'selectionChanged', 'focusChanged', 'target', 'insertion', 'pasteDispatched', 'error', 'transcript', 'transcriptUpdate', 'audioLevel']),
  payload: z.unknown(),
}).strict();
export type Envelope = z.infer<typeof envelopeSchema>;
export const MAX_CONTROL_BYTES = 256 * 1024;
const transcriptFields = {
  text: z.string().max(48000).refine(value => Buffer.byteLength(value) <= 48000 && !value.includes('\0'), 'Invalid transcript.'),
  revision: z.number().int().positive().max(0xffffffff),
  audioEndSample: z.number().int().nonnegative().max(1024 * 1024 * 1024),
};
export const transcriptUpdateSchema = z.object({
  ...transcriptFields, final: z.literal(false), pauseMs: z.number().int().nonnegative().max(30000),
}).strict().refine(value => value.audioEndSample <= 30 * 16000 && value.pauseMs * 16 <= value.audioEndSample, 'Invalid preview watermark.');
export const finalTranscriptSchema = z.object({ ...transcriptFields, final: z.literal(true) }).strict();
export type TranscriptUpdate = z.infer<typeof transcriptUpdateSchema>;
export function parseEnvelope(line: string): Envelope {
  if (Buffer.byteLength(line) > MAX_CONTROL_BYTES) throw new Error('protocol_size');
  return envelopeSchema.parse(JSON.parse(line) as unknown);
}
