const { contextBridge, ipcRenderer } = require('electron');
const base = {
  settings: { version: 8, enabled: true, microphoneId: 'mic', playbackDeviceId: 'playback', holdShortcut: 'Ctrl+Shift', handsFreeShortcut: 'Ctrl+Shift+Space', cleanup: 'default', vocabulary: [], speechModel: 'moonshine-small-streaming-en', launchAtLogin: false, keepOverlayVisible: false, softwareExperience: 'default', colourTheme: 'default' },
  accounts: [], models: [], microphones: [{ id: 'mic', name: 'Selected microphone', isDefault: true }, { id: 'other', name: 'Other microphone', isDefault: false }], playbackDevices: [{ id: 'playback', name: 'Selected playback', isDefault: true }], status: { phase: 'idle', message: 'Ready', canCopy: false }, notice: '', modelReady: true, nativeReady: true,
  historyAvailable: true, historyRevision: 0, meetingsAvailable: true, meetingsRevision: 0, meeting: { phase: 'idle', transcript: '', startedAt: null }, assistant: { phase: 'hidden' }, commandMode: false, audioLevel: 0,
};
contextBridge.exposeInMainWorld('openTalk', {
  getSnapshot: async () => base,
  updateSettings: async () => base, testCleanup: async () => base, signIn: async () => base, cancelSignIn: async () => base, selectAccount: async () => base, disconnect: async () => base,
  manageUsage: async () => undefined, refreshDevices: async () => base, testMicrophone: async () => undefined, downloadModel: async () => base, cancelDownload: async () => undefined, setEnabled: async () => base,
  recordingVisible: async () => undefined, copyRecovery: async () => false, setOverlayPointerInput: async () => undefined,
  setCommandMode: async value => { base.commandMode = value; ipcRenderer.send('assistant-command-mode', value); },
  getOverview: async () => ({ recentDictations: [], wordsThisWeek: 0, meetingsThisWeek: 0, longestDictationMs: null }),
  getWeeklyTasks: async () => ({ weekStartedAt: '2026-10-05T00:00:00.000Z', tasks: [], available: true, limited: false }),
  queryHistory: async () => ({ items: [], nextCursor: null, total: 0 }), queryMeetings: async () => ({ items: [], nextCursor: null, total: 0 }),
  startMeeting: async () => undefined,
  startAssistant: async () => { ipcRenderer.send('assistant-action', 'start'); },
  stopAssistant: async () => { ipcRenderer.send('assistant-action', 'stop'); },
  acceptAssistant: async choice => { ipcRenderer.send('assistant-action', choice); },
  getAssistantResult: async () => 'A concise replacement that preserves the Thursday deadline.',
  copyAssistant: async () => true,
  cancelSession: async () => undefined,
  onStatus(listener) { const handler = (_event, state) => listener({ ...base, ...state, settings: { ...base.settings, ...state.settings } }); ipcRenderer.on('assistant-status', handler); return () => ipcRenderer.removeListener('assistant-status', handler); },
});
