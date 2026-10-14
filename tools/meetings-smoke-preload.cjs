const { contextBridge, ipcRenderer } = require('electron');
const meeting = {
  id: '00000000-0000-4000-8000-000000000020', createdAt: '2026-10-04T04:45:00.000Z', endedAt: '2026-10-04T05:15:00.000Z',
  title: 'Weekly product review', shortSummary: 'The team reviewed launch readiness, confirmed the Thursday milestone, and assigned the remaining accessibility checks.',
  longSummary: 'The team reviewed launch readiness and the remaining work. The Thursday milestone was confirmed, with accessibility checks assigned before release. No change was made to the approved scope.',
  minutesMarkdown: '# Meeting Minutes\n\n## Summary\n\nLaunch readiness review.\n\n## Decisions\n\n- Keep the Thursday milestone.\n\n## Action items\n\n- Complete accessibility checks.\n\n[Inert reference](https://example.invalid/private)\n\n![Remote image](https://example.invalid/tracker.png)\n\n<script>window.markdownExecuted = true</script>',
  transcript: 'We reviewed launch readiness and confirmed the Thursday milestone.\n\nThe remaining accessibility checks need to be completed before release.',
  bookmarks: [{ id: '00000000-0000-4000-8000-000000000021', offsetMs: 42_000, transcriptOffset: 20 }, { id: '00000000-0000-4000-8000-000000000022', offsetMs: 80_000, transcriptOffset: 88 }], summaryStatus: 'ready',
};
const snapshot = {
  settings: { version: 8, enabled: true, microphoneId: 'mic', playbackDeviceId: 'playback', holdShortcut: 'Ctrl+Shift', handsFreeShortcut: 'Ctrl+Shift+Space', cleanup: 'default', vocabulary: [], speechModel: 'moonshine-small-streaming-en', launchAtLogin: false, keepOverlayVisible: false, softwareExperience: 'default', colourTheme: 'default' },
  accounts: [], models: [], microphones: [], playbackDevices: [{ id: 'playback', name: 'Selected playback', isDefault: true }], status: { phase: 'idle', message: 'Ready', canCopy: false }, notice: '', modelReady: true, nativeReady: true,
  historyAvailable: true, historyRevision: 0, meetingsAvailable: true, meetingsRevision: 1, meeting: { phase: 'idle', transcript: '', startedAt: null, bookmarks: [] }, assistant: { phase: 'hidden' }, commandMode: false, audioLevel: 64,
};
const recentDictations = [
  { id: '00000000-0000-4000-8000-000000000031', createdAt: '2026-10-07T04:45:00.000Z', text: 'We should move the accessibility review to Thursday afternoon and keep the launch checklist unchanged.', durationMs: 48_000 },
  { id: '00000000-0000-4000-8000-000000000030', createdAt: '2026-10-07T03:15:00.000Z', text: 'Please prepare a concise summary of the customer interview, including the pricing constraint and the requested follow-up.', durationMs: 522_000 },
];
const weeklyTasks = [
  { id: 'task-1', text: 'Complete the accessibility checks before release.', source: 'meeting', sourceId: meeting.id, createdAt: '2026-10-09T04:00:00.000Z' },
  { id: 'task-2', text: 'Prepare the customer interview summary.', source: 'dictation', sourceId: recentDictations[1].id, createdAt: '2026-10-08T03:15:00.000Z' },
  { id: 'task-3', text: 'Move the accessibility review to Thursday afternoon.', source: 'dictation', sourceId: recentDictations[0].id, createdAt: '2026-10-07T04:45:00.000Z' },
  { id: 'task-4', text: 'Send the revised launch brief.', source: 'meeting', sourceId: meeting.id, createdAt: '2026-10-06T02:15:00.000Z' },
];
contextBridge.exposeInMainWorld('openTalk', {
  recordingVisible: async () => undefined, getSnapshot: async () => snapshot, updateSettings: async () => snapshot, signIn: async () => snapshot, testCleanup: async () => snapshot,
  cancelSignIn: async () => snapshot, selectAccount: async () => snapshot, disconnect: async () => snapshot, manageUsage: async () => undefined, refreshDevices: async () => snapshot,
  testMicrophone: async () => undefined, downloadModel: async () => snapshot, cancelDownload: async () => undefined, setEnabled: async () => snapshot, cancelSession: async () => undefined,
  copyRecovery: async () => false, setOverlayPointerInput: async () => undefined, setCommandMode: async () => undefined,
  startAssistant: async () => undefined, stopAssistant: async () => undefined, acceptAssistant: async () => undefined, getAssistantResult: async () => '', copyAssistant: async () => false,
  getOverview: async () => ({ recentDictations, weekStartedAt: '2026-10-05T00:00:00.000Z', wordsThisWeek: 18420, meetingsThisWeek: 12, longestDictationMs: 522000, weeklySummary: 'You bounced between accessibility checks, launch planning, and customer follow-ups this week - 18,420 dictated words while your keyboard caught its breath.' }),
  getWeeklyTasks: async () => ({ weekStartedAt: '2026-10-05T00:00:00.000Z', tasks: weeklyTasks, available: true, limited: false }),
  queryHistory: async () => ({ items: recentDictations, nextCursor: null, total: recentDictations.length }), copyHistory: async () => false, deleteHistory: async () => false,
  startMeeting: async () => { ipcRenderer.send('smoke-command-start'); }, pauseMeeting: async () => undefined, resumeMeeting: async () => undefined, bookmarkMeeting: async () => { ipcRenderer.send('smoke-bookmark-add'); }, stopMeeting: async () => undefined,
  queryMeetings: async () => ({ items: [meeting], nextCursor: null, total: 1 }), getMeeting: async () => meeting, deleteMeeting: async () => false, exportMeetingMinutes: async () => true,
  onStatus(listener) { const handler = (_event, state) => listener({ ...snapshot, ...(state.recordingLayerTransition ? { recordingLayerTransition: state.recordingLayerTransition } : {}), meeting: state.meeting ?? state }); ipcRenderer.on('smoke-status', handler); return () => ipcRenderer.removeListener('smoke-status', handler); },
});
