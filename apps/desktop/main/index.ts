import { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, protocol, shell, safeStorage, clipboard, dialog, session, screen, type SaveDialogOptions } from 'electron';
import { join, resolve, sep, extname } from 'node:path';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { CLEANUP_MODEL, MAX_WEEKLY_TASKS, dictationSetupReady, historyQuerySchema, idSchema, meetingPlaybackReady, meetingQuerySchema, overlayNeedsPointerInput, overlayShouldBeVisible, preferredMicrophoneId, preferredPlaybackDeviceId, settingsSchema, startOfLocalWeek, type AssistantChoice, type OverviewSummary, type Snapshot, type ModelView, type Microphone, type PlaybackDevice, type WeeklyTasks } from '../../../packages/core/src/contracts';
import { atomicWrite, EncryptedHistoryStore, EncryptedMeetingStore, SettingsStore, ProtectedStore, exists } from '../../../packages/core/src/storage';
import { AccountService, accountStateSchema, type AccountState } from '../../../packages/core/src/accounts';
import { OAuthClient } from '../../../packages/core/src/oauth';
import { AUTH } from '../../../packages/core/src/network';
import { AppError } from '../../../packages/core/src/errors';
import { CleanupService } from '../../../packages/core/src/cleanup';
import { ModelManager } from '../../../packages/core/src/models';
import { SessionCoordinator } from '../../../packages/core/src/session';
import { assistantIpcAllowed, overlayIpcAllowed, trustedFrame, uiPath } from '../../../packages/core/src/ipc';
import { NativeAdapter } from './native';
import { PerformanceRecorder } from '../../../packages/core/src/performance';
import { MeetingCoordinator, MeetingSummaryService } from '../../../packages/core/src/meetings';
import type { VoiceCommandId } from '../../../packages/core/src/commands';
import { AssistantLayerTransition, keepRecordingLayerAboveOtherWindows, RecordingLayerPointerRouter, RecordingLayerTransition, type AssistantLayerTransitionPhase, type RecordingLayerTransitionPhase } from './window-policy';
import { HotkeyCoordinator } from './hotkeys';
import { AssistantCoordinator, AssistantService } from '../../../packages/core/src/assistant';
import { buildWeeklySummaryInput, localWeeklyUsageSummary, MAX_WEEKLY_TOPIC_SAMPLES, WeeklyUsageSummaryCache, WeeklyUsageSummaryService } from '../../../packages/core/src/overview';
import { buildWeeklyTaskInput, MAX_WEEKLY_TASK_SOURCE_ITEMS, WeeklyTaskCache, WeeklyTaskService } from '../../../packages/core/src/tasks';

protocol.registerSchemesAsPrivileged([{ scheme: 'opentalk', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false } }]);
const APP_ID = 'local.opentalk.desktop';
app.setName('OpenTalk');
app.setAppUserModelId(APP_ID);
if (!app.requestSingleInstanceLock()) app.quit();
let settingsWindow: BrowserWindow | null = null, overlay: BrowserWindow | null = null, assistantWindow: BrowserWindow | null = null, tray: Tray | null = null;
let quitting = false, models: ModelView[] = [], microphones: Microphone[] = [], playbackDevices: PlaybackDevice[] = [], notice = '', modelReady = false, historyRevision = 0, meetingsRevision = 0, audioLevel = 0;
let commandMode = false;
let modelController: AbortController | null = null, accountRequests = new AbortController();
let overlayReady = false, assistantReady = false, assistantNativeReady = false, launchHintActive = true, launchHintTimer: ReturnType<typeof setTimeout> | null = null;
let accountStorageReady = false;
let coordinator: SessionCoordinator, meetingCoordinator: MeetingCoordinator, assistantCoordinator: AssistantCoordinator, native: NativeAdapter, settings: SettingsStore, accounts: AccountService, history: EncryptedHistoryStore, meetings: EncryptedMeetingStore, modelManager: ModelManager;
const timings = new PerformanceRecorder(process.env.OPENTALK_PERF === '1' ? timing => { process.stdout.write(`${JSON.stringify({ opentalkTiming: timing })}\n`); } : undefined);
const cleanup = new CleanupService(fetch, timings);
const meetingSummary = new MeetingSummaryService(fetch);
const assistantService = new AssistantService(fetch);
const weeklyUsageSummary = new WeeklyUsageSummaryService(fetch);
const weeklyUsageSummaryCache = new WeeklyUsageSummaryCache();
const weeklyTaskService = new WeeklyTaskService(fetch);
const weeklyTaskCache = new WeeklyTaskCache();
let preparationQueue: Promise<void> = Promise.resolve();
let preparationEpoch = 0;
function dismissLaunchHint(): void {
  launchHintActive = false;
  if (launchHintTimer) clearTimeout(launchHintTimer);
  launchHintTimer = null;
}
function prepareSelectedWorker(forceEnable = false): Promise<void> {
  const current = settings.get();
  const epoch = preparationEpoch;
  const operation = preparationQueue.catch(() => undefined).then(async () => {
    if (quitting || epoch !== preparationEpoch || (!forceEnable && !settings.get().enabled) || !native.ready || !modelReady || settings.get().speechModel !== current.speechModel) return;
    if (['recording', 'transcribing', 'cleaning', 'inserting'].includes(coordinator.getStatus().phase)) return;
    await native.prepare(modelManager.path(current.speechModel));
  });
  preparationQueue = operation; return operation;
}
const ACCOUNT_CLEANUP_TEST_TRANSCRIPT = 'Um, please schedule the synthetic review for Friday—sorry, Thursday afternoon.';
const DATA = join(app.getPath('appData'), 'OpenTalk');
const APP_ICON = join(__dirname, 'app-icon.png');
app.setPath('userData', DATA);
function snapshot(): Snapshot {
  const status = coordinator.getStatus();
  const meeting = meetingCoordinator?.getState() ?? { phase: 'idle' as const, transcript: '', startedAt: null, bookmarks: [] };
  const assistant = assistantCoordinator?.getState() ?? { phase: 'hidden' as const };
  return { settings: settings.get(), accounts: accounts.views(), models, microphones, playbackDevices, status, notice, modelReady, nativeReady: native.ready, historyAvailable: history?.isAvailable() ?? false, historyRevision, meetingsAvailable: meetings?.isAvailable() ?? false, meetingsRevision, meeting, assistant, commandMode, audioLevel: status.phase === 'recording' || meeting.phase === 'recording' || assistant.phase === 'recording' ? audioLevel : 0 };
}
async function overview(): Promise<OverviewSummary> {
  const since = startOfLocalWeek(new Date());
  const historySummary = history.isAvailable() ? history.overviewSince(since) : null;
  const usage = {
    weekStartedAt: since.toISOString(),
    wordsThisWeek: historySummary?.wordsSince ?? null,
    meetingsThisWeek: meetings.isAvailable() ? meetings.countSince(since) : null,
    longestDictationMs: historySummary?.longestDurationMs ?? null,
  };
  const result = {
    recentDictations: historySummary?.recent ?? [],
    ...usage,
  };
  const account = accounts.selectedId();
  if (!account) return { ...result, weeklySummary: localWeeklyUsageSummary(usage) };
  try {
    const historyTopics = history.isAvailable() ? history.topicCandidatesSince(since, MAX_WEEKLY_TOPIC_SAMPLES) : { items: [], totalItems: 0 };
    const meetingTopics = meetings.isAvailable() ? meetings.topicCandidatesSince(since, MAX_WEEKLY_TOPIC_SAMPLES) : { items: [], totalItems: 0 };
    const summaryInput = buildWeeklySummaryInput(usage, [...historyTopics.items, ...meetingTopics.items], historyTopics.totalItems + meetingTopics.totalItems);
    const weeklySummary = await weeklyUsageSummaryCache.get(summaryInput, async () => weeklyUsageSummary.generate(summaryInput, await accounts.token(account, accountRequests.signal), accountRequests.signal));
    return { ...result, weeklySummary };
  } catch {
    return { ...result, weeklySummary: localWeeklyUsageSummary(usage) };
  }
}
async function weeklyTasks(): Promise<WeeklyTasks> {
  const since = startOfLocalWeek(new Date());
  const historyCandidates = history.isAvailable() ? history.taskCandidatesSince(since, MAX_WEEKLY_TASK_SOURCE_ITEMS) : { items: [], totalItems: 0 };
  const meetingCandidates = meetings.isAvailable() ? meetings.taskCandidatesSince(since, MAX_WEEKLY_TASK_SOURCE_ITEMS) : { items: [], totalItems: 0 };
  const sourceItemsAvailable = historyCandidates.totalItems + meetingCandidates.totalItems;
  const input = buildWeeklyTaskInput(since.toISOString(), [...historyCandidates.items, ...meetingCandidates.items], sourceItemsAvailable);
  const incompleteStores = !history.isAvailable() || !meetings.isAvailable();
  const limited = incompleteStores || input.sources.length < sourceItemsAvailable;
  if (!input.sources.length) return { weekStartedAt: input.weekStartedAt, tasks: [], available: sourceItemsAvailable === 0 && !incompleteStores, limited };
  const account = accounts.selectedId();
  if (!account) return { weekStartedAt: input.weekStartedAt, tasks: [], available: false, limited };
  try {
    const tasks = await weeklyTaskCache.get(input, async () => weeklyTaskService.generate(input, await accounts.token(account, accountRequests.signal), accountRequests.signal));
    return { weekStartedAt: input.weekStartedAt, tasks, available: true, limited: limited || tasks.length === MAX_WEEKLY_TASKS };
  } catch {
    return { weekStartedAt: input.weekStartedAt, tasks: [], available: false, limited };
  }
}
function canEnable(value = settings.get()): boolean {
  return dictationSetupReady({ settings: value, accounts: accounts.views(), models, microphones, modelReady, nativeReady: native.ready });
}
async function reconcileAutomaticEnabled(): Promise<void> {
  const current = settings.get();
  const enabled = canEnable(current);
  const next = current.enabled === enabled ? current : { ...current, enabled };
  if (!enabled) preparationEpoch++;
  if (native.ready) { if (enabled) await prepareSelectedWorker(true); await native.configure(next); }
  if (next.enabled !== current.enabled) await settings.update(next);
  coordinator.setEnabled(enabled);
  assistantCoordinator?.setEnabled(enabled && assistantNativeReady);
}
async function refreshAudioDevices(): Promise<void> {
  microphones = await native.microphones();
  playbackDevices = await native.playbackDevices();
  if (settings.recovered) return;
  const current = settings.get();
  const microphoneId = preferredMicrophoneId(current.microphoneId, microphones);
  const playbackDeviceId = preferredPlaybackDeviceId(current.playbackDeviceId, playbackDevices);
  if (microphoneId !== current.microphoneId || playbackDeviceId !== current.playbackDeviceId) await settings.update({ ...current, microphoneId, playbackDeviceId });
}
function failureNotice(error: unknown): string {
  return error instanceof AppError && /^[a-z0-9_]{1,64}$/.test(error.code) ? `Sorry, not available · ${error.code}` : 'Sorry, not available';
}
async function startMeeting(completingVoiceCommand = false): Promise<void> {
  if (!canEnable() || assistantCoordinator?.isActive() || (!completingVoiceCommand && !['idle', 'disabled'].includes(coordinator.getStatus().phase))) throw new AppError('setup_required');
  if (!meetingPlaybackReady({ settings: settings.get(), playbackDevices, nativeReady: native.ready })) throw new AppError('playback_unavailable');
  assistantCoordinator?.offer(null);
  await meetingCoordinator.start(settings.get(), accounts.selectedId());
}
async function executeVoiceCommand(command: VoiceCommandId): Promise<void> {
  switch (command) {
    case 'start-meeting': await startMeeting(true); return;
    default: { const unsupported: never = command; throw new AppError(`unsupported_command_${unsupported}`); }
  }
}
function meetingIsExpanded(data: Snapshot): boolean {
  return ['starting', 'recording', 'pausing', 'paused', 'processing'].includes(data.meeting.phase);
}
function presentOverlay(data: Snapshot, expanded: boolean, transition?: RecordingLayerTransitionPhase): void {
  if (!overlay || overlay.isDestroyed()) return;
  const display = screen.getPrimaryDisplay().workArea;
  const width = expanded ? 760 : 520, height = expanded ? 340 : 64;
  const x = display.x + Math.round((display.width - width) / 2), y = expanded ? display.y + 18 : display.y + display.height - 78;
  const bounds = overlay.getBounds();
  if (bounds.width !== width || bounds.height !== height || bounds.x !== x || bounds.y !== y) overlay.setBounds({ x, y, width, height }, false);
  overlayPointerRouter.present(overlay, expanded, overlayNeedsPointerInput(data.status, data.meeting));
  overlay.webContents.send('status', transition ? { ...data, recordingLayerTransition: transition } : data);
  if (overlayShouldBeVisible(data.status, launchHintActive, data.settings.keepOverlayVisible, data.meeting)) overlay.showInactive();
  else overlay.hide();
}
const overlayPointerRouter = new RecordingLayerPointerRouter();
const overlayTransition = new RecordingLayerTransition<Snapshot>(presentOverlay);
function publishOverlay(data: Snapshot): void {
  if (!overlay || !overlayReady || overlay.isDestroyed()) return;
  overlayTransition.update(data, meetingIsExpanded(data));
}
function presentAssistant(data: Snapshot, exiting = false): void {
  if (!assistantWindow || !assistantReady || assistantWindow.isDestroyed()) return;
  const phase = data.assistant.phase;
  if (phase === 'hidden' && !exiting) { assistantWindow.hide(); return; }
  const anchor = assistantCoordinator.getAnchor();
  if (!anchor && !exiting) { assistantWindow.hide(); return; }
  const size = phase === 'offered' ? { width: 48, height: 48 } : phase === 'review' || phase === 'blocked' ? { width: 600, height: 300 } : { width: 320, height: 64 };
  if (anchor) {
    const point = screen.screenToDipPoint({ x: anchor.x + anchor.width, y: anchor.y + anchor.height });
    const display = screen.getDisplayNearestPoint(point).workArea;
    const x = Math.max(display.x, Math.min(point.x + 8, display.x + display.width - size.width));
    const y = Math.max(display.y, Math.min(point.y + 8, display.y + display.height - size.height));
    const bounds = assistantWindow.getBounds();
    if (bounds.x !== x || bounds.y !== y || bounds.width !== size.width || bounds.height !== size.height) assistantWindow.setBounds({ x, y, ...size }, false);
  }
  assistantWindow.webContents.send('status', exiting ? { ...data, assistantLayerTransition: 'exit' } : data);
  assistantWindow.showInactive();
}
function presentLayers(data: Snapshot, assistantActive: boolean, transition?: AssistantLayerTransitionPhase): void {
  if (transition === 'recording-exit') {
    if (assistantWindow && !assistantWindow.isDestroyed()) assistantWindow.hide();
    const expanded = meetingIsExpanded(data);
    presentOverlay(data, expanded, expanded ? 'expanded-exit' : 'compact-exit');
    return;
  }
  if (transition === 'assistant-exit') {
    if (overlay && !overlay.isDestroyed()) overlay.hide();
    presentAssistant(data, true);
    return;
  }
  if (assistantActive) {
    if (overlay && !overlay.isDestroyed()) overlay.hide();
    presentAssistant(data);
    return;
  }
  if (assistantWindow && !assistantWindow.isDestroyed()) assistantWindow.hide();
  publishOverlay(data);
}
const assistantLayerTransition = new AssistantLayerTransition<Snapshot>(presentLayers);
function publish(): void {
  if (!coordinator || !settings || !accounts) return;
  const data = snapshot();
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.webContents.send('status', data);
  assistantLayerTransition.update(data, data.assistant.phase !== 'hidden');
  if (tray) tray.setToolTip(`OpenTalk · ${data.status.message}`);
}
function windows(): void {
  const common = { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, devTools: !app.isPackaged };
  settingsWindow = new BrowserWindow({ width: 1024, height: 768, minWidth: 800, minHeight: 600, show: false, icon: APP_ICON, backgroundColor: '#111111', webPreferences: common });
  settingsWindow.setMenu(null);
  const display = screen.getPrimaryDisplay().workArea;
  const overlayWidth = 520, overlayHeight = 64;
  overlay = new BrowserWindow({ width: overlayWidth, height: overlayHeight, x: display.x + Math.round((display.width - overlayWidth) / 2), y: display.y + display.height - 78,
    frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false, focusable: false, alwaysOnTop: true, skipTaskbar: true, resizable: false, show: false, webPreferences: common });
  keepRecordingLayerAboveOtherWindows(overlay);
  overlay.setIgnoreMouseEvents(true, { forward: true }); overlay.setVisibleOnAllWorkspaces(true);
  assistantWindow = new BrowserWindow({ width: 48, height: 48, frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false, focusable: false,
    alwaysOnTop: true, skipTaskbar: true, resizable: false, show: false, webPreferences: common });
  keepRecordingLayerAboveOtherWindows(assistantWindow); assistantWindow.setVisibleOnAllWorkspaces(true);
  for (const window of [settingsWindow, overlay, assistantWindow]) {
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('will-attach-webview', event => event.preventDefault());
  }
  settingsWindow.on('close', e => { if (!quitting) { e.preventDefault(); settingsWindow?.hide(); } });
  overlay.webContents.once('did-finish-load', () => {
    overlayReady = true; publish();
    launchHintTimer = setTimeout(() => { dismissLaunchHint(); publish(); }, 3000);
  });
  assistantWindow.webContents.once('did-finish-load', () => { assistantReady = true; publish(); });
  void settingsWindow.loadURL('opentalk://app/index.html'); void overlay.loadURL('opentalk://app/index.html?overlay=1'); void assistantWindow.loadURL('opentalk://app/index.html?assistant=1');
}
async function refreshModels(): Promise<void> {
  accountRequests.abort(); accountRequests = new AbortController(); models = [];
  const id = accounts.selectedId(); if (!id) return;
  const request = accountRequests;
  try { const result = await accounts.models(id, request.signal); if (!request.signal.aborted && accounts.selectedId() === id) models = result; }
  catch { if (!request.signal.aborted) notice = 'Reconnect your account or check plan access.'; }
}
function registerIpc(): void {
  function handle(channel: string, validator: z.ZodType, fn: (value: unknown) => Promise<unknown>): void {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      const owner = overlayIpcAllowed(channel) && event.sender.id === overlay?.webContents.id
        ? overlay
        : assistantIpcAllowed(channel) && event.sender.id === assistantWindow?.webContents.id
          ? assistantWindow
          : event.sender.id === settingsWindow?.webContents.id && !channel.startsWith('assistant-') ? settingsWindow : null;
      if (!owner || !event.senderFrame) throw new Error('Request rejected');
      trustedFrame(event.sender.id, owner.webContents.id, event.senderFrame.url, event.senderFrame === event.sender.mainFrame);
      if (args.length > 1) throw new Error('Request rejected');
      const input = validator.parse(args[0]);
      try { return await fn(input); } catch (error) { notice = failureNotice(error); publish(); throw new Error(notice, { cause: error }); }
    });
  }
  const noArgs = z.undefined();
  handle('snapshot', noArgs, async () => snapshot());
  handle('settings', settingsSchema, async value => {
    const requested = settingsSchema.parse(value);
    if (!requested.enabled || requested.speechModel !== settings.get().speechModel) preparationEpoch++;
    modelReady = await modelManager.ready(requested.speechModel);
    const next = { ...requested, enabled: canEnable(requested) };
    // Configure before persisting so an invalid shortcut never leaves a half-applied configuration.
    if (native.ready) await native.configure(next);
    await settings.update(next); app.setLoginItemSettings({ openAtLogin: next.launchAtLogin });
    if (!next.keepOverlayVisible) dismissLaunchHint();
    if (next.enabled) await prepareSelectedWorker();
    coordinator.setEnabled(next.enabled); assistantCoordinator.setEnabled(next.enabled && assistantNativeReady); publish(); return snapshot();
  });
  handle('sign-in', idSchema.nullable(), async value => { if (!accountStorageReady) throw new AppError('credential_store_unavailable'); coordinator.cancel(); assistantCoordinator.cancel(); notice = 'Complete sign-in in your browser.'; publish(); await accounts.signIn(value as string | null); notice = 'Eligible cleanup requests use your ChatGPT plan. Manage usage in ChatGPT settings.'; await refreshModels(); await reconcileAutomaticEnabled(); publish(); return snapshot(); });
  handle('test-cleanup', noArgs, async () => {
    const id = accounts.selectedId(), current = settings.get();
    if (!id || !models.some(model => model.slug === CLEANUP_MODEL)) throw new AppError('setup_required');
    notice = 'Testing account cleanup with synthetic text. No insertion will be attempted.'; publish();
    const text = await cleanup.clean(ACCOUNT_CLEANUP_TEST_TRANSCRIPT, { ...current, vocabulary: [] }, await accounts.token(id, accountRequests.signal), accountRequests.signal);
    if (!text.trim() || text.includes('\0')) throw new AppError('invalid_output');
    notice = 'Account cleanup test completed with validated nonempty text. No insertion was attempted.'; publish(); return snapshot();
  });
  handle('cancel-sign-in', noArgs, async () => { accounts.cancelSignIn(); notice = ''; publish(); return snapshot(); });
  handle('select-account', idSchema, async value => { coordinator.cancel(); assistantCoordinator.cancel(); await accounts.select(value as string); await refreshModels(); await reconcileAutomaticEnabled(); publish(); return snapshot(); });
  handle('disconnect', idSchema, async value => {
    coordinator.cancel(); assistantCoordinator.cancel(); accountRequests.abort(); const revoked = await accounts.disconnect(value as string);
    models = []; notice = revoked ? 'Disconnected. Renewable session revoked.' : 'Disconnected locally. Remote revocation was not confirmed. Disconnect OpenTalk in ChatGPT settings.'; await reconcileAutomaticEnabled(); publish(); return snapshot();
  });
  handle('manage-usage', noArgs, async () => { await shell.openExternal('https://chatgpt.com/settings/usage'); });
  handle('devices', noArgs, async () => { if (!native.ready) native.start(); await refreshAudioDevices(); await reconcileAutomaticEnabled(); publish(); return snapshot(); });
  handle('test-microphone', noArgs, async () => { if (coordinator.getStatus().phase !== 'idle' && coordinator.getStatus().phase !== 'disabled') throw new AppError('busy'); await native.testMicrophone(settings.get().microphoneId); notice = 'Microphone capture completed. No audio was saved or sent.'; publish(); });
  handle('download-model', noArgs, async () => {
    if (modelController) throw new AppError('download_busy');
    const controller = new AbortController(); modelController = controller; const selected = settings.get().speechModel;
    let last = 0;
    try { await modelManager.download(selected, controller.signal, (bytes, total) => { if (Date.now() - last > 500) { last = Date.now(); notice = `Downloading model · ${Math.round(bytes / total * 100)}%`; publish(); } }); modelReady = selected === settings.get().speechModel && await modelManager.ready(selected); await reconcileAutomaticEnabled(); notice = 'Model verified and ready.'; publish(); return snapshot(); }
    finally { modelController = null; }
  });
  handle('cancel-download', noArgs, async () => { modelController?.abort(); });
  handle('enabled', z.boolean(), async value => {
    const next = { ...settings.get(), enabled: value as boolean };
    if (!next.enabled) preparationEpoch++;
    if (next.enabled && !canEnable(next)) throw new AppError('setup_required');
    if (next.enabled) await prepareSelectedWorker(true);
    coordinator.setEnabled(next.enabled); assistantCoordinator.setEnabled(next.enabled && assistantNativeReady); if (native.ready) await native.configure(next); await settings.update(next); publish(); return snapshot();
  });
  handle('cancel-session', noArgs, async () => { coordinator.cancel(); assistantCoordinator.cancel(); });
  handle('recording-visible', noArgs, async () => { coordinator.recordingVisible(); });
  handle('copy-recovery', noArgs, async () => coordinator.copyRecovery(text => clipboard.writeText(text)));
  handle('overlay-pointer-input', z.boolean(), async value => {
    if (!overlay || overlay.isDestroyed()) return;
    const data = snapshot();
    overlayPointerRouter.request(overlay, meetingIsExpanded(data), z.boolean().parse(value), overlayNeedsPointerInput(data.status, data.meeting));
  });
  handle('command-mode', z.boolean(), async value => {
    if (!['idle', 'disabled'].includes(coordinator.getStatus().phase) || meetingCoordinator.isActive() || assistantCoordinator.isActive()) throw new AppError('busy');
    commandMode = value as boolean; publish();
  });
  handle('assistant-start', noArgs, async () => {
    if (!assistantNativeReady || !canEnable() || !['idle', 'disabled'].includes(coordinator.getStatus().phase) || meetingCoordinator.isActive()) throw new AppError('busy');
    await assistantCoordinator.start(settings.get(), accounts.selectedId());
  });
  handle('assistant-stop', noArgs, async () => { await assistantCoordinator.stop(); });
  handle('assistant-accept', z.enum(['replace', 'append']), async value => { await assistantCoordinator.accept(value as AssistantChoice); });
  handle('assistant-result', noArgs, async () => assistantCoordinator.getResult());
  handle('assistant-copy', noArgs, async () => assistantCoordinator.copy(text => clipboard.writeText(text)));
  handle('overview', noArgs, async () => overview());
  handle('weekly-tasks', noArgs, async () => weeklyTasks());
  handle('history-query', historyQuerySchema, async value => history.query(value));
  handle('history-copy', idSchema, async value => { const entry = history.find(value); if (!entry) return false; clipboard.writeText(entry.text); return true; });
  handle('history-delete', idSchema, async value => { const deleted = await history.delete(value); if (deleted) { historyRevision += 1; publish(); } return deleted; });
  handle('meeting-start', noArgs, async () => {
    await startMeeting();
  });
  handle('meeting-pause', noArgs, async () => { await meetingCoordinator.pause(); });
  handle('meeting-resume', noArgs, async () => { await meetingCoordinator.resume(); });
  handle('meeting-bookmark', noArgs, async () => { meetingCoordinator.bookmark(); });
  handle('meeting-stop', noArgs, async () => { await meetingCoordinator.stop(); });
  handle('meeting-query', meetingQuerySchema, async value => meetings.query(value));
  handle('meeting-get', idSchema, async value => meetings.find(value));
  handle('meeting-delete', idSchema, async value => { const deleted = await meetings.delete(value); if (deleted) { meetingsRevision += 1; publish(); } return deleted; });
  handle('meeting-export', idSchema, async value => {
    const meeting = meetings.find(value); if (!meeting || meeting.summaryStatus !== 'ready') return false;
    const safeTitle = [...meeting.title].map(character => character.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(character) ? '-' : character).join('').slice(0, 80) || 'Meeting minutes';
    const options: SaveDialogOptions = { title: 'Export meeting minutes', defaultPath: `${safeTitle}.md`, buttonLabel: 'Export', filters: [{ name: 'Markdown', extensions: ['md'] }], properties: ['dontAddToRecent'] };
    const result = settingsWindow ? await dialog.showSaveDialog(settingsWindow, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return false;
    await atomicWrite(result.filePath, meeting.minutesMarkdown); return true;
  });
}
void app.whenReady().then(async () => {
  if (process.platform !== 'win32') throw new AppError('windows_required');
  settings = new SettingsStore(join(DATA, 'settings.json')); await settings.load();
  const protector = {
    encrypt(value: string): Buffer { if (!safeStorage.isEncryptionAvailable()) throw new AppError('protection_unavailable'); return safeStorage.encryptString(value); },
    decrypt(value: Buffer): string { if (!safeStorage.isEncryptionAvailable()) throw new AppError('protection_unavailable'); return safeStorage.decryptString(value); },
  };
  accounts = new AccountService(new ProtectedStore<AccountState>(join(DATA, 'accounts.enc'), protector, value => accountStateSchema.parse(value)), new OAuthClient(async value => {
    const url = new URL(value); if (url.origin !== AUTH || url.pathname !== '/api/accounts/authorize' || url.username || url.password) throw new AppError('browser_origin'); await shell.openExternal(value);
  }));
  try { await accounts.load(); accountStorageReady = true; } catch { notice = 'Protected account storage could not be opened. Check Windows account protection before reconnecting; saved credentials have been preserved.'; }
  history = new EncryptedHistoryStore(join(DATA, 'history.enc'), protector);
  try { if (!safeStorage.isEncryptionAvailable()) throw new AppError('protection_unavailable'); await history.load(); }
  catch { notice = `${notice ? `${notice} ` : ''}Protected dictation history could not be opened; existing history has been preserved.`; }
  meetings = new EncryptedMeetingStore(join(DATA, 'meetings.enc'), protector);
  try { if (!safeStorage.isEncryptionAvailable()) throw new AppError('protection_unavailable'); await meetings.load(); }
  catch { notice = `${notice ? `${notice} ` : ''}Protected meeting history could not be opened; existing meetings have been preserved.`; }
  modelManager = new ModelManager(join(DATA, 'models'));
  if (settings.get().speechModel === 'moonshine-small-streaming-en') {
    try { await modelManager.installBundledMoonshine(app.isPackaged ? join(process.resourcesPath, 'speech-models', 'moonshine-small-streaming-en') : resolve(__dirname, '../../../.tools/moonshine-small-streaming-en')); }
    catch { notice = 'Moonshine could not be verified. Open Settings and Verify model to repair it.'; }
  }
  modelReady = await modelManager.ready(settings.get().speechModel);
  const nativeRoot = app.isPackaged ? join(process.resourcesPath, 'native') : resolve(__dirname, '../../../native/bin');
  const isolatedProfile = resolve(app.getPath('appData')).toLowerCase() !== resolve(process.env.APPDATA ?? '').toLowerCase();
  native = new NativeAdapter(join(nativeRoot, 'opentalk-helper.exe'), join(nativeRoot, 'opentalk-worker.exe'), undefined, timings, {
    APPDATA: app.getPath('appData'), LOCALAPPDATA: isolatedProfile ? join(app.getPath('appData'), 'local') : process.env.LOCALAPPDATA,
  });
  let preparedToken: { signal: AbortSignal; account: string; token: string } | null = null;
  coordinator = new SessionCoordinator({
    inspectTarget: signal => native.inspectTarget(signal),
    startCapture: (id, value, signal) => native.capture(id, value, modelManager.path(value.speechModel), signal),
    stopCapture: id => native.stop(id), discard: id => native.discard(id),
    transcribe: (id, _settings, signal) => native.transcript(id, signal),
    watchTranscript: (id, listener) => native.watchTranscript(id, listener),
    prepareCleanup: async (account, signal) => {
      const token = await accounts.token(account, signal);
      if (!signal.aborted) {
        preparedToken = { signal, account, token };
        signal.addEventListener('abort', () => { if (preparedToken?.signal === signal) preparedToken = null; }, { once: true });
      }
    },
    clean: async (text, value, account, signal, mode) => {
      const token = preparedToken?.account === account && !preparedToken.signal.aborted ? preparedToken.token : await accounts.token(account, signal);
      preparedToken = null; return cleanup.clean(text, value, token, signal, mode);
    },
    insert: (id, target, text, signal) => native.insert(id, target, text, signal),
    recordHistory: async (text, durationMs) => {
      try {
        const result = await history.add(text, durationMs);
        historyRevision += 1;
        if (result.removed) notice = `${result.removed} oldest dictation${result.removed === 1 ? '' : 's'} removed to keep history within its storage limit.`;
        publish();
      } catch (error) {
        notice = 'Dictation completed, but protected history could not be saved.'; publish(); throw error;
      }
    },
    executeCommand: executeVoiceCommand,
    invalidate: id => native.invalidate(id),
  }, () => {
    publish();
    if (!quitting && !meetingCoordinator?.isActive() && settings.get().enabled && ['done', 'idle', 'blocked'].includes(coordinator.getStatus().phase)) void prepareSelectedWorker().catch(() => undefined);
  }, Date.now, timings);
  meetingCoordinator = new MeetingCoordinator({
    startCapture: (id, value, signal) => native.captureMeeting(id, value, modelManager.path(value.speechModel), signal),
    stopCapture: id => native.stop(id), discard: id => native.discard(id),
    transcribe: (id, _value, signal) => native.transcript(id, signal),
    watchTranscript: (id, listener) => native.watchTranscript(id, listener),
    saveDraft: async value => { await meetings.addDraft(value); meetingsRevision += 1; publish(); },
    generate: async (transcript, account, signal) => meetingSummary.generate(transcript, await accounts.token(account, signal), signal),
    complete: async (id, generated) => { await meetings.complete(id, generated); meetingsRevision += 1; publish(); },
    fail: async id => { await meetings.fail(id); meetingsRevision += 1; publish(); },
  }, publish);
  assistantCoordinator = new AssistantCoordinator({
    startCapture: (id, value, signal) => native.capture(id, value, modelManager.path(value.speechModel), signal),
    stopCapture: id => native.stop(id), discard: id => native.discard(id),
    transcribe: (id, _value, signal) => native.transcript(id, signal),
    transform: async (selectedText, command, account, signal) => assistantService.transform(selectedText, command, await accounts.token(account, signal), signal),
    replaceSelection: (id, selection, text, signal) => native.replaceSelection(id, selection, text, signal),
    invalidate: id => native.invalidate(id),
  }, publish);
  const hotkeys = new HotkeyCoordinator({
    isMeetingActive: () => meetingCoordinator.isActive() || assistantCoordinator.isActive(),
    startDictation: () => { assistantCoordinator.offer(null); return coordinator.start(settings.get(), accounts.selectedId(), commandMode ? 'command' : 'dictation'); },
    stopDictation: () => coordinator.stop(),
    cancelDictation: () => coordinator.cancelAndWait(),
    startMeeting,
    reportFailure: () => { notice = 'Meeting could not start. Check your setup and try again.'; publish(); },
  });
  native.onHotkey = type => hotkeys.handle(type);
  native.onAudioLevel = level => { if (coordinator.getStatus().phase === 'recording' || meetingCoordinator.getState().phase === 'recording' || assistantCoordinator.isRecording()) { audioLevel = level; publish(); } };
  native.onPasteDispatched = id => coordinator.pasteDispatched(id);
  let selectionTimer: ReturnType<typeof setTimeout> | null = null, selectionEpoch = 0;
  const refreshAssistantSelection = (): void => {
    const epoch = ++selectionEpoch;
    if (!assistantNativeReady || !settings.get().enabled || !['idle', 'disabled'].includes(coordinator.getStatus().phase) || meetingCoordinator.isActive() || assistantCoordinator.isActive()) return;
    void native.inspectSelection().then(selection => { if (epoch === selectionEpoch) assistantCoordinator.offer(selection); }).catch(() => { if (epoch === selectionEpoch) assistantCoordinator.offer(null); });
  };
  native.onSelectionChanged = () => {
    if (selectionTimer) clearTimeout(selectionTimer);
    selectionTimer = setTimeout(() => { selectionTimer = null; refreshAssistantSelection(); }, 80);
  };
  native.onFocusChanged = () => {
    selectionEpoch++;
    // The captured selection remains authoritative while Assistant Mode records
    // and generates. Accept performs one native restore/revalidation of that exact
    // window/control/range instead of canceling on incidental focus notifications.
    if (!assistantCoordinator.isActive()) assistantCoordinator.offer(null);
  };
  native.onFailure = () => { audioLevel = 0; assistantNativeReady = false; assistantCoordinator.unavailable(); if (meetingCoordinator.isActive()) void meetingCoordinator.cancel(); coordinator.unavailable(); notice = 'Sorry, not available. Check your audio devices. Refresh devices if the helper stopped.'; publish(); };
  native.onReady = () => {
    const devices = refreshAudioDevices().then(async () => { await reconcileAutomaticEnabled(); publish(); });
    void devices.catch(() => native.onFailure());
    void devices.then(async () => {
      const handle = assistantWindow?.getNativeWindowHandle();
      if (!handle) return;
      let value = 0n;
      for (let index = handle.length - 1; index >= 0; index--) value = (value << 8n) | BigInt(handle[index] ?? 0);
      await native.registerAssistantWindow(value.toString());
      assistantNativeReady = true; assistantCoordinator.setEnabled(settings.get().enabled); publish();
    }).catch(() => { assistantNativeReady = false; assistantCoordinator.setEnabled(false); publish(); });
  };
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('opentalk://app/') }));
  protocol.handle('opentalk', async request => {
    try {
      const relative = uiPath(request.url), root = resolve(__dirname, 'ui'), file = resolve(root, relative);
      if (!file.startsWith(root + sep)) throw new AppError('path');
      const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
      const bytes = await readFile(file);
      return new Response(bytes, { headers: { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" } });
    }
    catch { return new Response('Not found', { status: 404 }); }
  });
  registerIpc(); windows();
  tray = new Tray(nativeImage.createFromPath(APP_ICON).resize({ width: 16, height: 16, quality: 'best' }));
  tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Settings', click: () => { settingsWindow?.show(); settingsWindow?.focus(); } }, { label: 'Cancel dictation', click: () => { coordinator.cancel(); assistantCoordinator.cancel(); } }, { label: 'Disable dictation', click: () => { preparationEpoch++; coordinator.setEnabled(false); assistantCoordinator.setEnabled(false); void settings.update({ ...settings.get(), enabled: false }).then(() => native.ready ? native.configure(settings.get()) : undefined).then(publish).catch(() => native.onFailure()); } }, { type: 'separator' }, { label: 'Quit', click: () => app.quit() }]));
  tray.on('double-click', () => settingsWindow?.show());
  if (settings.recovered) notice = 'Settings were recovered safely. Dictation is disabled; review setup.';
  if (await exists(join(nativeRoot, 'opentalk-helper.exe'))) {
    native.start();
  }
  void refreshModels().then(async () => { await reconcileAutomaticEnabled(); publish(); }); publish();
}).catch(() => { app.quit(); });
app.on('second-instance', () => { settingsWindow?.show(); settingsWindow?.focus(); });
app.on('window-all-closed', () => undefined);
let shutdownComplete = false;
app.on('before-quit', event => {
  if (shutdownComplete) return;
  event.preventDefault(); if (quitting) return; quitting = true;
  overlayTransition.dispose();
  assistantLayerTransition.dispose();
  dismissLaunchHint();
  accounts?.shutdown(); accountRequests.abort(); modelController?.abort();
  void (assistantCoordinator?.shutdown() ?? Promise.resolve()).catch(() => undefined)
    .then(() => meetingCoordinator?.shutdown() ?? Promise.resolve()).catch(() => undefined)
    .then(() => coordinator?.shutdown() ?? Promise.resolve()).catch(() => undefined)
    .then(() => native?.shutdown() ?? Promise.resolve()).catch(() => undefined)
    .finally(() => { tray?.destroy(); shutdownComplete = true; app.quit(); });
});
