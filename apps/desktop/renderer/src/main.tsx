import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import Markdown from 'react-markdown';
import {
  CLEANUP_MODEL, CLEANUP_MODEL_LABEL, CLEANUP_REASONING_EFFORT, MAX_HISTORY_QUERY_LENGTH,
  type AssistantPhase, type DesktopBridge, type HistoryEntry, type MeetingBookmark, type MeetingListItem, type MeetingRecord, type OverviewSummary, type Settings, type Snapshot, type WeeklyTask, type WeeklyTasks,
} from '../../../../packages/core/src/contracts';
import '@fontsource-variable/manrope/wght.css';
import openTalkLogo from '../../../../opentalk-logo.png';
import openTalkBackground from '../../../../open-talk-background.jpg';
import appLogo from '../../../../app-logo.jpg';
import { voiceCommands } from '../../../../packages/core/src/commands';
import { overlayPresentation, type OverlayPresentation } from './overlay';
import './style.css';

declare global { interface Window { openTalk: DesktopBridge } }
const api = window.openTalk;
const overlay = new URLSearchParams(location.search).has('overlay');
const assistantSurface = new URLSearchParams(location.search).has('assistant');
document.documentElement.classList.toggle('overlay-page', overlay || assistantSurface);
const meterShape = [-2, -1, 0, -1, -2];

function BookmarkIcon() {
  return <svg viewBox="0 0 16 18" aria-hidden="true"><path d="M3.25 1.5h9.5v14.75L8 13.1l-4.75 3.15V1.5Z" /></svg>;
}

function bookmarkTime(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}` : `${minutes}:${String(seconds).padStart(2, '0')}`;
}

interface TranscriptSection { text: string; start: number; nextStart: number }
function transcriptSections(transcript: string): TranscriptSection[] {
  const sections: TranscriptSection[] = [];
  const separator = /\n{2,}/g;
  let start = 0;
  for (const match of transcript.matchAll(separator)) {
    const end = match.index;
    if (end > start) sections.push({ text: transcript.slice(start, end), start, nextStart: end + match[0].length });
    start = end + match[0].length;
  }
  if (start < transcript.length) sections.push({ text: transcript.slice(start), start, nextStart: transcript.length + 1 });
  return sections;
}

function transcriptContent(section: TranscriptSection, bookmarks: MeetingBookmark[], selectedId: string | null): ReactNode[] {
  const content: ReactNode[] = [];
  let cursor = 0;
  for (const bookmark of bookmarks) {
    const offset = Math.max(0, Math.min(section.text.length, bookmark.transcriptOffset - section.start));
    if (offset > cursor) content.push(section.text.slice(cursor, offset));
    content.push(<span id={`audio-bookmark-${bookmark.id}`} className={`audio-bookmark-marker ${selectedId === bookmark.id ? 'selected' : ''}`} tabIndex={-1} aria-label={`Audio bookmark at ${bookmarkTime(bookmark.offsetMs)}`} key={bookmark.id}><BookmarkIcon /><span>{bookmarkTime(bookmark.offsetMs)}</span></span>);
    cursor = offset;
  }
  if (cursor < section.text.length) content.push(section.text.slice(cursor));
  return content;
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const query = matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(query.matches);
    query.addEventListener('change', update); return () => query.removeEventListener('change', update);
  }, []);
  return reduced;
}

function IndicatorContent({ presentation, level, commandMode = false, measured = false, copyState = 'idle', onCopy, onCommandMode }: { presentation: OverlayPresentation; level: number; commandMode?: boolean; measured?: boolean; copyState?: 'idle' | 'copying' | 'failed'; onCopy?: () => void; onCommandMode?: () => void }) {
  const levelStep = Math.min(5, Math.round(level / 18));
  return <div className={`indicator-content ${presentation.centered ? 'centered' : ''}`} aria-hidden={measured || undefined}>
    <span className="indicator-label" role={presentation.canCopy && !measured ? 'status' : undefined}>{copyState === 'failed' ? 'Copy failed · Try again' : presentation.label}</span>
    {presentation.recording && <span className="signal-meter" aria-hidden="true">{meterShape.map((offset, index) => <span key={index} className={`signal-bar strength-${Math.max(0, Math.min(5, levelStep + offset))}`} />)}</span>}
    {presentation.kind === 'launch' && <button className="command-mode-button" data-overlay-action="true" type="button" aria-pressed={commandMode} tabIndex={measured ? -1 : undefined} onClick={measured ? undefined : onCommandMode}><span>{commandMode ? 'Dictation mode' : 'Command mode'}</span></button>}
    {presentation.canCopy && <button className="recovery-copy" data-overlay-action="true" type="button" disabled={copyState === 'copying'} tabIndex={measured ? -1 : undefined} aria-label="Copy transcribed text" onClick={measured ? undefined : onCopy}>{copyState === 'copying' ? 'Copying…' : 'Copy'}</button>}
  </div>;
}

function MeetingRecorder({ snapshot, exiting = false }: { snapshot: Snapshot; exiting?: boolean }) {
  const [working, setWorking] = useState(false);
  const [bookmarkAdded, setBookmarkAdded] = useState(false);
  const bookmarkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const state = snapshot.meeting;
  const levelStep = Math.min(5, Math.round(snapshot.audioLevel / 18));
  const action = async (fn: () => Promise<void>) => { setWorking(true); try { await fn(); } finally { setWorking(false); } };
  const addBookmark = async () => {
    await action(async () => {
      await api.bookmarkMeeting();
      setBookmarkAdded(true);
      if (bookmarkTimer.current) clearTimeout(bookmarkTimer.current);
      bookmarkTimer.current = setTimeout(() => {
        setBookmarkAdded(false);
        bookmarkTimer.current = null;
      }, 1_000);
    });
  };
  useEffect(() => () => {
    if (bookmarkTimer.current) clearTimeout(bookmarkTimer.current);
  }, []);
  return <div className="overlay-shell meeting-overlay-shell">
    <section className={`meeting-recorder ${exiting ? 'mode-exit' : ''}`} aria-label="Meeting recorder">
      <header className="meeting-recorder-header">
        <div className="meeting-recording-state"><span>{state.phase === 'starting' ? 'Starting' : state.phase === 'paused' ? 'Paused' : state.phase === 'processing' || state.phase === 'pausing' ? 'Processing' : 'Recording'}</span>
          <span className="signal-meter" aria-hidden="true">{meterShape.map((offset, index) => <span key={index} className={`signal-bar strength-${state.phase === 'recording' ? Math.max(0, Math.min(5, levelStep + offset)) : 0}`} />)}</span>
        </div>
        <div className="meeting-recorder-actions">
          {state.phase === 'recording' && <button className={`meeting-bookmark-button ${bookmarkAdded ? 'bookmark-added' : ''}`} type="button" disabled={working} aria-label="Add audio bookmark" title="Add audio bookmark" onClick={() => void addBookmark()}><span className="meeting-bookmark-confirmation">Bookmark added</span><BookmarkIcon /></button>}
          {state.phase === 'recording' && <button type="button" disabled={working} onClick={() => void action(() => api.pauseMeeting())}>Pause</button>}
          {state.phase === 'paused' && <button type="button" disabled={working} onClick={() => void action(() => api.resumeMeeting())}>Resume</button>}
          <button className="meeting-stop" type="button" disabled={working || !['recording', 'paused'].includes(state.phase)} onClick={() => void action(() => api.stopMeeting())}>Stop</button>
        </div>
      </header>
      <div className="live-transcript" aria-live="polite">{state.transcript || (state.phase === 'recording' ? 'Listening…' : 'Preparing transcript…')}</div>
    </section>
  </div>;
}

function CompactOverlayPill({ snapshot, exiting = false }: { snapshot: Snapshot | null; exiting?: boolean }) {
  const target = overlayPresentation(snapshot);
  const colourTheme = snapshot?.settings.colourTheme ?? 'default';
  const commandMode = snapshot?.commandMode ?? false;
  const animatedTheme = colourTheme !== 'default';
  const [shown, setShown] = useState(target);
  const [transition, setTransition] = useState<'stable' | 'out' | 'in'>('stable');
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'failed'>('idle');
  const [width, setWidth] = useState(190);
  const measureRef = useRef<HTMLDivElement>(null);
  const pointerInputRef = useRef(false);
  const reducedMotion = useReducedMotion();
  const level = shown.recording ? snapshot?.audioLevel ?? 0 : 0;

  useEffect(() => () => { void api.setOverlayPointerInput(false).catch(() => undefined); }, []);

  useEffect(() => {
    if (target.key === shown.key) return;
    setCopyState('idle');
    if (reducedMotion || (target.recording && !animatedTheme)) { setShown(target); setTransition('stable'); return; }
    if (target.recording) { setShown(target); setTransition('in'); return; }
    setTransition('out');
    const swap = setTimeout(() => { setShown(target); setTransition('in'); }, 120);
    return () => clearTimeout(swap);
  }, [animatedTheme, reducedMotion, shown.key, target.key]);

  useEffect(() => {
    if (transition !== 'in') return;
    const settle = setTimeout(() => setTransition('stable'), animatedTheme ? 320 : 180);
    return () => clearTimeout(settle);
  }, [animatedTheme, transition, shown.key]);

  useEffect(() => {
    if (!shown.recording) return;
    const frame = requestAnimationFrame(() => { void api.recordingVisible().catch(() => undefined); });
    return () => cancelAnimationFrame(frame);
  }, [shown.key, shown.recording]);

  useEffect(() => {
    if (target.kind !== 'launch' && !target.canCopy) setPointerInput(false);
  }, [target.canCopy, target.kind]);

  useLayoutEffect(() => {
    const element = measureRef.current;
    if (!element) return;
    let active = true;
    const measure = () => setWidth(Math.max(96, Math.min(500, Math.ceil(element.getBoundingClientRect().width + 30))));
    const observer = new ResizeObserver(measure); observer.observe(element); measure();
    void document.fonts.ready.then(() => { if (active) measure(); });
    return () => { active = false; observer.disconnect(); };
  }, [copyState, shown.key]);

  async function copyRecovery(): Promise<void> {
    if (!shown.canCopy || copyState === 'copying') return;
    setCopyState('copying');
    try {
      if (!await api.copyRecovery()) setCopyState('failed');
    } catch { setCopyState('failed'); }
  }
  async function toggleCommandMode(): Promise<void> { await api.setCommandMode(!commandMode).catch(() => undefined); }
  function setPointerInput(enabled: boolean): void {
    if (pointerInputRef.current === enabled) return;
    pointerInputRef.current = enabled;
    void api.setOverlayPointerInput(enabled).catch(() => undefined);
  }
  function routePointer(event: ReactMouseEvent<HTMLDivElement>): void {
    const target = event.target;
    setPointerInput(target instanceof Element && Boolean(target.closest('[data-overlay-action="true"]')));
  }

  return <div className="overlay-shell" onMouseMove={routePointer} onMouseLeave={() => setPointerInput(false)}>
    <div className="indicator-measurer" ref={measureRef}><IndicatorContent presentation={shown} level={level} commandMode={commandMode} copyState={copyState} measured /></div>
    <div className={`indicator ${shown.kind} colour-${shown.colour} theme-${colourTheme} ${commandMode ? 'command-mode-active' : ''} ${shown.canCopy ? 'copyable' : ''} transition-${transition} ${exiting ? 'mode-exit' : ''}`} style={{ width }} role={shown.canCopy || shown.kind === 'launch' ? undefined : 'status'} aria-label={shown.canCopy || shown.kind === 'launch' ? undefined : shown.recording ? `Recording. Microphone input level ${level} percent.` : shown.label}>
      <IndicatorContent presentation={shown} level={level} commandMode={commandMode} copyState={copyState} onCopy={() => void copyRecovery()} onCommandMode={() => void toggleCommandMode()} />
    </div>
  </div>;
}

function OverlayPill({ snapshot }: { snapshot: Snapshot | null }) {
  if (snapshot?.recordingLayerTransition === 'compact-exit') return <CompactOverlayPill snapshot={snapshot} exiting />;
  if (snapshot?.recordingLayerTransition === 'expanded-exit') return <MeetingRecorder snapshot={snapshot} exiting />;
  return snapshot && snapshot.meeting.phase !== 'idle' && snapshot.meeting.phase !== 'failed'
    ? <MeetingRecorder snapshot={snapshot} />
    : <CompactOverlayPill snapshot={snapshot} />;
}

interface AssistantPillPresentation {
  phase: AssistantPhase;
  label: string;
  recording: boolean;
}

function assistantPillPresentation(phase: AssistantPhase): AssistantPillPresentation {
  if (phase === 'recording') return { phase, label: 'Listening', recording: true };
  if (phase === 'processing') return { phase, label: 'Processing', recording: false };
  if (phase === 'inserting') return { phase, label: 'Replacing text', recording: false };
  if (phase === 'done') return { phase, label: 'Done', recording: false };
  return { phase, label: 'Assistant unavailable', recording: false };
}

function AssistantPillContent({ presentation, level, working, measured = false, onStop }: { presentation: AssistantPillPresentation; level: number; working: boolean; measured?: boolean; onStop: () => void }) {
  const levelStep = Math.min(5, Math.round(level / 18));
  return <div className={`indicator-content ${presentation.recording ? '' : 'centered'}`} aria-hidden={measured || undefined}>
    <span className="indicator-label">{presentation.label}</span>
    {presentation.recording && <span className="signal-meter" aria-hidden="true">{meterShape.map((offset, index) => <span key={index} className={`signal-bar strength-${Math.max(0, Math.min(5, levelStep + offset))}`} />)}</span>}
    {presentation.recording && <button className="recovery-copy assistant-stop" type="button" tabIndex={measured ? -1 : undefined} disabled={working || measured} onClick={measured ? undefined : onStop}>Stop</button>}
  </div>;
}

function AssistantPill({ phase, level, working, exiting, onStop }: { phase: AssistantPhase; level: number; working: boolean; exiting: boolean; onStop: () => void }) {
  const target = assistantPillPresentation(phase);
  const [shown, setShown] = useState(target);
  const [transition, setTransition] = useState<'stable' | 'out' | 'in'>('in');
  const [width, setWidth] = useState(96);
  const measureRef = useRef<HTMLDivElement>(null);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    if (target.phase === shown.phase) return;
    if (reducedMotion) { setShown(target); setTransition('stable'); return; }
    setTransition('out');
    const swap = setTimeout(() => { setShown(target); setTransition('in'); }, 120);
    return () => clearTimeout(swap);
  }, [reducedMotion, shown.phase, target.phase]);

  useEffect(() => {
    if (transition !== 'in') return;
    const settle = setTimeout(() => setTransition('stable'), 360);
    return () => clearTimeout(settle);
  }, [shown.phase, transition]);

  useLayoutEffect(() => {
    const element = measureRef.current;
    if (!element) return;
    let active = true;
    const measure = () => setWidth(Math.max(96, Math.min(300, Math.ceil(element.getBoundingClientRect().width + 36))));
    const observer = new ResizeObserver(measure); observer.observe(element); measure();
    void document.fonts.ready.then(() => { if (active) measure(); });
    return () => { active = false; observer.disconnect(); };
  }, [shown.phase]);

  const shownLevel = shown.recording ? level : 0;
  return <div className="assistant-shell assistant-compact-shell">
    <div className="indicator-measurer assistant-measurer" ref={measureRef}><AssistantPillContent presentation={shown} level={shownLevel} working={working} measured onStop={onStop} /></div>
    <div className={`indicator assistant-indicator ${shown.phase} transition-${transition} ${exiting ? 'assistant-surface-exit' : 'assistant-surface-enter'}`} style={{ width }} role="status" aria-label={shown.recording ? `Listening. Microphone input level ${shownLevel} percent.` : shown.label}>
      <AssistantPillContent presentation={shown} level={shownLevel} working={working} onStop={onStop} />
    </div>
  </div>;
}

function AssistantSurface({ snapshot }: { snapshot: Snapshot | null }) {
  const phase = snapshot?.assistant.phase ?? 'hidden';
  const exiting = snapshot?.assistantLayerTransition === 'exit';
  const [result, setResult] = useState('');
  const [working, setWorking] = useState(false);
  useEffect(() => {
    let active = true;
    if (phase !== 'review' && phase !== 'blocked') { setResult(''); return () => { active = false; }; }
    void api.getAssistantResult().then(value => { if (active) setResult(value); }).catch(() => { if (active) setResult(''); });
    return () => { active = false; };
  }, [phase]);
  const action = async (operation: () => Promise<unknown>): Promise<void> => {
    if (working) return;
    setWorking(true); try { await operation(); } finally { setWorking(false); }
  };
  const blockedLabel = (() => {
    switch (snapshot?.assistant.blockedReason) {
      case 'selection-unavailable': return 'Selection is no longer accessible';
      case 'window-changed': return 'Selected window changed';
      case 'control-changed': return 'Selected field changed';
      case 'input-changed': return 'Input was detected after selection';
      case 'focus-changed': return 'Focus changed after selection';
      case 'text-changed': return 'Selected text changed';
      case 'security-blocked': return 'Selection is protected';
      case 'clipboard-unavailable': return 'Clipboard is unavailable';
      default: return 'Selection could not be replaced';
    }
  })();
  if (phase === 'hidden') return null;
  if (phase === 'offered') return <div className="assistant-shell assistant-offered-shell">
    <button className={`assistant-launch ${exiting ? 'assistant-surface-exit' : 'assistant-surface-enter'}`} type="button" aria-label="Open assistant for selected text" disabled={working} onClick={() => void action(() => api.startAssistant())}><img src={appLogo} alt="" /></button>
  </div>;
  if (phase === 'review' || phase === 'blocked') return <div className="assistant-shell">
    <section className={`assistant-review ${exiting ? 'assistant-surface-exit' : 'assistant-surface-enter'}`} aria-label="Assistant result">
      <header><span>{phase === 'blocked' ? blockedLabel : 'Assistant result'}</span><button type="button" aria-label="Close assistant" onClick={() => void action(() => api.cancelSession())}>Close</button></header>
      <div className="assistant-result" role="status">{result || 'Preparing result…'}</div>
      <footer>{phase === 'review'
        ? <><button type="button" disabled={working || !result} onClick={() => void action(() => api.acceptAssistant('append'))}>Add after selection</button><button className="assistant-replace" type="button" disabled={working || !result} onClick={() => void action(() => api.acceptAssistant('replace'))}>Replace selected text</button></>
        : <button className="primary" type="button" disabled={working || !result} onClick={() => void action(() => api.copyAssistant())}>Copy result</button>}
      </footer>
    </section>
  </div>;
  return <AssistantPill phase={phase} level={phase === 'recording' ? snapshot?.audioLevel ?? 0 : 0} working={working} exiting={exiting} onStop={() => void action(() => api.stopAssistant())} />;
}

function dayLabel(value: string): string {
  const parts = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(value => value.type === type)?.value ?? '';
  return `${part('weekday')} ${part('day')} ${part('month')} ${part('year')}`;
}
function timeLabel(value: string): string {
  const parts = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: true }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(value => value.type === type)?.value ?? '';
  return `${part('hour')}:${part('minute')}${part('dayPeriod').toUpperCase()}`;
}

function durationLabel(milliseconds: number | null): string {
  if (milliseconds === null) return '—';
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60), remainder = seconds % 60;
  return minutes ? `${minutes}min ${remainder}s` : `${remainder}s`;
}

function taskSourceLabel(task: WeeklyTask): string {
  const date = new Date(task.createdAt);
  const when = Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(date);
  return `${task.source === 'meeting' ? 'Meeting' : 'Dictation'}${when ? ` · ${when}` : ''}`;
}

function TaskList({ tasks, compact = false, onOpenSource }: { tasks: WeeklyTask[]; compact?: boolean; onOpenSource?(task: WeeklyTask): void }) {
  return <div className={`task-list ${compact ? 'compact' : ''}`}>{tasks.map(task => <article className="task-item" key={task.id}>
    <div className="task-copy"><p>{task.text}</p><span>{taskSourceLabel(task)}</span></div>
    {onOpenSource && <button type="button" className="task-see-dictation" onClick={() => onOpenSource(task)}>See {task.source === 'meeting' ? 'Meeting' : 'Dictation'}</button>}
  </article>)}</div>;
}

function TaskFeedback({ value, loading }: { value: WeeklyTasks | null; loading: boolean }) {
  if (loading && !value) return <div className="overview-empty"><p>Finding this week&apos;s tasks…</p></div>;
  if (value && !value.available) return <div className="overview-empty"><p>Key tasks are temporarily unavailable. Connect your account or try again later.</p></div>;
  if (value?.tasks.length === 0) return <div className="overview-empty"><p>No tasks found in this week&apos;s dictations or meetings.</p></div>;
  return null;
}

function OverviewPanel({ historyRevision, meetingsRevision, onDictations, onTasks, onUsage }: { historyRevision: number; meetingsRevision: number; onDictations(): void; onTasks(): void; onUsage(): void }) {
  const [summary, setSummary] = useState<OverviewSummary | null>(null);
  const [tasks, setTasks] = useState<WeeklyTasks | null>(null);
  const [tasksLoading, setTasksLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const requestSequence = useRef(0);

  const load = useCallback(async () => {
    const sequence = ++requestSequence.current;
    try {
      const value = await api.getOverview();
      if (sequence === requestSequence.current) { setSummary(value); setMessage(''); }
    } catch {
      if (sequence === requestSequence.current) setMessage('Overview is temporarily unavailable.');
    }
  }, []);
  useEffect(() => { void load(); }, [historyRevision, meetingsRevision, load]);
  useEffect(() => {
    let active = true;
    setTasksLoading(true);
    void api.getWeeklyTasks().then(value => { if (active) setTasks(value); }).catch(() => {
      if (active) setTasks({ weekStartedAt: '', tasks: [], available: false, limited: false });
    }).finally(() => { if (active) setTasksLoading(false); });
    return () => { active = false; };
  }, [historyRevision, meetingsRevision]);

  async function remove(id: string): Promise<void> {
    try {
      if (!await api.deleteHistory(id)) { setMessage('That dictation is no longer available.'); return; }
      setConfirmDelete(null); await load();
    } catch { setMessage('This dictation could not be deleted.'); }
  }

  const number = new Intl.NumberFormat().format(summary?.wordsThisWeek ?? 0);
  return <section className="content-view overview-view" aria-labelledby="overview-heading">
    <header className="overview-hero">
      <img src={openTalkBackground} alt="" />
      <h1 id="overview-heading">Overview</h1>
      <p aria-live="polite">{summary?.weeklySummary ?? 'Summarising your week with OpenTalk...'}</p>
    </header>

    <section className="overview-section overview-tasks" aria-labelledby="key-tasks-heading">
      <div className="overview-section-heading"><h2 id="key-tasks-heading">Key tasks</h2><button type="button" onClick={onTasks}>See all tasks</button></div>
      <TaskFeedback value={tasks} loading={tasksLoading} />
      {tasks?.available && <TaskList tasks={tasks.tasks.slice(0, 3)} compact />}
    </section>

    <section className="overview-section overview-recents" aria-labelledby="recent-dictation-heading">
      <div className="overview-section-heading"><h2 id="recent-dictation-heading">Recent dictation</h2><button type="button" onClick={onDictations}>See dictations</button></div>
      {message && <p className="overview-feedback" role="status">{message}</p>}
      {!message && summary && summary.recentDictations.length === 0 && <div className="overview-empty"><p>No dictations yet. Your cleaned dictations will appear here.</p></div>}
      <div className="overview-recent-list">
        {summary?.recentDictations.map(entry => <article className="overview-recent-item" key={entry.id}>
          <div className="overview-recent-meta"><time dateTime={entry.createdAt}>{timeLabel(entry.createdAt)}</time><div className="overview-delete-actions">
            {confirmDelete === entry.id
              ? <><button type="button" className="danger" onClick={() => void remove(entry.id)}>Confirm</button><button type="button" onClick={() => setConfirmDelete(null)}>Cancel</button></>
              : <button type="button" onClick={() => setConfirmDelete(entry.id)}>Delete</button>}
          </div></div>
          <p>{entry.text}</p>
        </article>)}
      </div>
    </section>

    <section className="overview-section overview-stats" aria-labelledby="your-stats-heading">
      <div className="overview-section-heading"><h2 id="your-stats-heading">Your stats</h2><button type="button" onClick={onUsage}>See usage</button></div>
      <div className="stats-grid">
        <article className="stat-card"><strong>{summary?.wordsThisWeek == null ? '—' : number}</strong><span>words dictated<br />this week</span></article>
        <article className="stat-card"><strong>{summary?.meetingsThisWeek ?? '—'}</strong><span>meetings / lectures<br />recorded this week</span></article>
        <article className="stat-card"><strong>{durationLabel(summary?.longestDictationMs ?? null)}</strong><span>longest brain<br />dump this week</span></article>
      </div>
    </section>
  </section>;
}

function TasksPanel({ historyRevision, meetingsRevision, onOpenSource }: { historyRevision: number; meetingsRevision: number; onOpenSource(task: WeeklyTask): void }) {
  const [value, setValue] = useState<WeeklyTasks | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    setLoading(true);
    void api.getWeeklyTasks().then(result => { if (active) setValue(result); }).catch(() => {
      if (active) setValue({ weekStartedAt: '', tasks: [], available: false, limited: false });
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [historyRevision, meetingsRevision]);
  return <section className="content-view tasks-view" aria-labelledby="tasks-heading">
    <header className="tasks-heading"><h1 id="tasks-heading">Tasks</h1></header>
    <TaskFeedback value={value} loading={loading} />
    {value?.available && <TaskList tasks={value.tasks} onOpenSource={onOpenSource} />}
    {value?.available && value.limited && <p className="task-limit-note">This list uses a bounded set of complete weekly source items; longer or older items may be omitted.</p>}
  </section>;
}

interface HistoryPanelProps {
  available: boolean;
  revision: number;
  selectedId: string | null;
}

function HistoryPanel({ available, revision, selectedId }: HistoryPanelProps) {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<HistoryEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const requestSequence = useRef(0);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (cursor: string | null, append: boolean) => {
    if (!available) { setItems([]); setTotal(0); setNextCursor(null); setMessage('Protected dictation history is unavailable.'); return; }
    const sequence = ++requestSequence.current;
    setLoading(true); setMessage('');
    try {
      const page = await api.queryHistory({ search: query, cursor });
      if (sequence !== requestSequence.current) return;
      setItems(current => append ? [...current, ...page.items] : page.items);
      setNextCursor(page.nextCursor); setTotal(page.total);
    } catch {
      if (sequence === requestSequence.current) setMessage('History is temporarily unavailable.');
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, [available, query]);

  useEffect(() => {
    const timer = setTimeout(() => { void load(null, false); }, 180);
    return () => clearTimeout(timer);
  }, [load, revision]);
  useEffect(() => {
    if (!selectedId || !items.some(entry => entry.id === selectedId)) return;
    const frame = requestAnimationFrame(() => document.getElementById(`dictation-${selectedId}`)?.scrollIntoView({ block: 'center' }));
    return () => cancelAnimationFrame(frame);
  }, [items, selectedId]);
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);

  async function copy(entry: HistoryEntry): Promise<void> {
    try {
      if (!await api.copyHistory(entry.id)) throw new Error('missing');
      setCopiedId(entry.id);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopiedId(null), 1800);
    } catch { setMessage('This dictation could not be copied.'); }
  }

  async function remove(id: string): Promise<void> {
    try {
      if (await api.deleteHistory(id)) {
        setConfirmDelete(null);
        await load(null, false);
      } else setMessage('That dictation is no longer available.');
    } catch { setMessage('This dictation could not be deleted.'); }
  }

  const groups: Array<{ day: string; items: HistoryEntry[] }> = [];
  for (const entry of items) {
    const day = dayLabel(entry.createdAt), previous = groups.at(-1);
    if (previous?.day === day) previous.items.push(entry); else groups.push({ day, items: [entry] });
  }

  return <section className="content-view dictation-view" aria-labelledby="dictation-heading">
    <div className="history-heading">
      <h1 id="dictation-heading">Dictation History</h1>
      <span className="sr-only">{total} saved dictations</span>
      <label className="search-field">
        <span className="sr-only">Search dictation history</span>
        <input type="search" value={query} maxLength={MAX_HISTORY_QUERY_LENGTH} onChange={event => setQuery(event.target.value)} placeholder="Search dictations" autoComplete="off" />
        <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m21 21-4.35-4.35m2.35-5.4A7.75 7.75 0 1 1 3.5 11.25a7.75 7.75 0 0 1 15.5 0Z" /></svg>
      </label>
    </div>
    <p className="history-feedback" role="status">{message || (loading ? 'Loading history…' : copiedId ? 'Copied to clipboard.' : '')}</p>
    {!loading && !message && items.length === 0 && <div className="empty-state"><h2>{query.trim() ? 'No matching dictations' : 'No dictations yet'}</h2><p>{query.trim() ? 'Try a different search.' : 'Your cleaned dictations will appear here.'}</p></div>}
    <div className="history-groups">
      {groups.map(group => <section className="history-day" key={group.day} aria-label={group.day}>
        <h2>{group.day}</h2>
        <div className="history-list">
          {group.items.map(entry => <article id={`dictation-${entry.id}`} className={`history-item ${selectedId === entry.id ? 'selected' : ''}`} key={entry.id}>
            <div className="history-meta"><time dateTime={entry.createdAt}>{timeLabel(entry.createdAt)}</time>
              <div className="history-actions">
                <button type="button" onClick={() => void copy(entry)}>{copiedId === entry.id ? 'Copied' : 'Copy'}</button>
                {confirmDelete === entry.id
                  ? <><button type="button" className="danger" onClick={() => void remove(entry.id)}>Confirm</button><button type="button" onClick={() => setConfirmDelete(null)}>Cancel</button></>
                  : <button type="button" onClick={() => setConfirmDelete(entry.id)}>Delete</button>}
              </div>
            </div>
            <p>{entry.text}</p>
          </article>)}
        </div>
      </section>)}
    </div>
    {nextCursor && <button className="load-more" type="button" disabled={loading} onClick={() => void load(nextCursor, true)}>Load more</button>}
  </section>;
}

function SearchField({ value, onChange, label }: { value: string; onChange(value: string): void; label: string }) {
  return <label className="search-field"><span className="sr-only">{label}</span>
    <input type="search" value={value} maxLength={MAX_HISTORY_QUERY_LENGTH} onChange={event => onChange(event.target.value)} placeholder="Search" autoComplete="off" />
    <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m21 21-4.35-4.35m2.35-5.4A7.75 7.75 0 1 1 3.5 11.25a7.75 7.75 0 0 1 15.5 0Z" /></svg>
  </label>;
}

function MeetingsPanel({ available, revision, onSelect }: { available: boolean; revision: number; onSelect(id: string): void }) {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<MeetingListItem[]>([]);
  const [message, setMessage] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => {
      if (!available) { setMessage('Protected meeting history is unavailable.'); setItems([]); return; }
      void api.queryMeetings({ search: query, cursor: null }).then(page => { setItems(page.items); setMessage(''); }).catch(() => setMessage('Meetings are temporarily unavailable.'));
    }, 180);
    return () => clearTimeout(timer);
  }, [available, query, revision]);
  const groups: Array<{ day: string; items: MeetingListItem[] }> = [];
  for (const entry of items) { const day = dayLabel(entry.createdAt), previous = groups.at(-1); if (previous?.day === day) previous.items.push(entry); else groups.push({ day, items: [entry] }); }
  return <section className="content-view meetings-view" aria-labelledby="meetings-heading">
    <div className="history-heading meetings-heading"><h1 id="meetings-heading">Meetings and lectures</h1><SearchField value={query} onChange={setQuery} label="Search meetings and lectures" /></div>
    {message && <p className="history-feedback" role="status">{message}</p>}
    {!message && items.length === 0 && <div className="empty-state"><h2>{query ? 'No matching meetings' : 'No meetings yet'}</h2><p>{query ? 'Try a different search.' : 'Use Start Meeting in Commands or press Ctrl+Shift+Space to begin.'}</p></div>}
    <div className="meeting-groups">{groups.map(group => <section className="meeting-day" key={group.day}><h2>{group.day}</h2><div className="meeting-list">
      {group.items.map(entry => <article className="meeting-list-item" key={entry.id}>
        <div className="meeting-list-meta"><time dateTime={entry.createdAt}>{timeLabel(entry.createdAt)}</time><button type="button" onClick={() => onSelect(entry.id)}>View</button></div>
        <div className="meeting-list-copy"><h3>{entry.title}</h3><p>{entry.summaryStatus === 'ready' ? entry.shortSummary : entry.summaryStatus === 'processing' ? 'Generating summary…' : 'Summary unavailable. The raw transcript is preserved.'}</p></div>
      </article>)}
    </div></section>)}</div>
  </section>;
}

function MeetingDetailPanel({ id, revision, onBack }: { id: string; revision: number; onBack(): void }) {
  const [meeting, setMeeting] = useState<MeetingRecord | null>(null);
  const [tab, setTab] = useState<'transcript' | 'minutes'>('transcript');
  const [query, setQuery] = useState('');
  const [message, setMessage] = useState('');
  const [selectedBookmark, setSelectedBookmark] = useState<string | null>(null);
  const reducedMotion = useReducedMotion();
  useEffect(() => { void api.getMeeting(id).then(value => { setMeeting(value); if (!value) setMessage('Meeting not found.'); }).catch(() => setMessage('Meeting is temporarily unavailable.')); }, [id, revision]);
  if (!meeting) return <section className="content-view meeting-detail-view"><p role="status">{message || 'Loading…'}</p><button className="detail-action" type="button" onClick={onBack}>Back</button></section>;
  const transcriptParts = transcriptSections(meeting.transcript).filter(part => !query || part.text.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const minutes = !query || meeting.minutesMarkdown.toLocaleLowerCase().includes(query.toLocaleLowerCase()) ? meeting.minutesMarkdown : '';
  const remove = async () => { if (!confirm('Delete this meeting and its transcript?')) return; if (await api.deleteMeeting(id)) onBack(); };
  const navigateBookmark = (bookmark: MeetingBookmark) => {
    setQuery(''); setTab('transcript'); setSelectedBookmark(bookmark.id);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const target = document.getElementById(`audio-bookmark-${bookmark.id}`);
      target?.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'center' });
      target?.focus({ preventScroll: true });
    }));
  };
  return <section className="content-view meeting-detail-view" aria-labelledby="meeting-title">
    <header className="meeting-detail-header"><h1 id="meeting-title">{meeting.title}</h1><div className="meeting-detail-actions"><button type="button" onClick={onBack}>Back</button><button type="button" onClick={() => void remove()}>Delete</button></div><SearchField value={query} onChange={setQuery} label="Search this meeting" /></header>
    <p className="meeting-long-summary">{meeting.summaryStatus === 'ready' ? meeting.longSummary : meeting.summaryStatus === 'processing' ? 'Generating the meeting summary and minutes…' : 'The AI summary could not be generated. The raw transcript has been preserved.'}</p>
    <div className="meeting-tab-row"><div className="meeting-tabs" role="tablist"><button type="button" role="tab" aria-selected={tab === 'transcript'} className={tab === 'transcript' ? 'active' : ''} onClick={() => setTab('transcript')}>Raw Transcript</button><button type="button" role="tab" aria-selected={tab === 'minutes'} className={tab === 'minutes' ? 'active' : ''} onClick={() => setTab('minutes')}>AI Generated Meeting Minutes</button></div><button className="meeting-export" type="button" disabled={meeting.summaryStatus !== 'ready'} onClick={() => void api.exportMeetingMinutes(id)}>Export Markdown</button></div>
    {tab === 'transcript' ? <>{meeting.bookmarks.length > 0 && <nav className="audio-bookmarks" aria-label="Audio bookmarks">{meeting.bookmarks.map(bookmark => <button className={selectedBookmark === bookmark.id ? 'selected' : ''} type="button" key={bookmark.id} onClick={() => navigateBookmark(bookmark)}><BookmarkIcon />{bookmarkTime(bookmark.offsetMs)}</button>)}</nav>}<div className="transcript-cards">{transcriptParts.map((part, index) => {
        const bookmarks = meeting.bookmarks.filter(bookmark => bookmark.transcriptOffset >= part.start && bookmark.transcriptOffset < part.nextStart);
        return <article className={`transcript-card ${bookmarks.some(bookmark => bookmark.id === selectedBookmark) ? 'bookmarked' : ''}`} key={`${index}-${part.text.slice(0, 20)}`}><p>{transcriptContent(part, bookmarks, selectedBookmark)}</p></article>;
      })}</div></>
      : <div className="minutes-panel">{minutes
        ? <div className="minutes-markdown"><Markdown skipHtml disallowedElements={['img']} components={{ a: ({ children }) => <span className="minutes-link">{children}</span> }}>{minutes}</Markdown></div>
        : <div className="minutes-markdown"><p>No matching meeting minutes.</p></div>}</div>}
  </section>;
}

interface SettingsPanelProps {
  snapshot: Snapshot;
  settings: Settings;
  working: boolean;
  message: string;
  change<K extends keyof Settings>(key: K, value: Settings[K]): void;
  action(fn: () => Promise<unknown>): Promise<void>;
}

function SettingsPanel({ snapshot, settings, working, message, change, action }: SettingsPanelProps) {
  const selected = snapshot.accounts.find(account => account.selected);
  const selectedMicrophone = snapshot.microphones.find(microphone => microphone.id === snapshot.settings.microphoneId);
  const cleanupModelReady = snapshot.models.some(model => model.slug === CLEANUP_MODEL);
  const accountReady = Boolean(selected?.connected && selected.planEnabled && cleanupModelReady);
  const microphoneReady = Boolean(snapshot.nativeReady && selectedMicrophone);
  const setupReady = accountReady && microphoneReady && snapshot.modelReady;

  return <section className="content-view settings-view" aria-labelledby="settings-heading">
    <h1 id="settings-heading">Settings</h1>
    <section className="reference-settings" aria-label="Connection and models">
      <div className="setting-block account-block">
        <div className="setting-label-row"><label htmlFor="account-select">Account</label><span className={`account-state ${accountReady ? 'active' : ''}`}>{accountReady ? 'Active' : 'Inactive'}</span></div>
        <div className="control-row account-row">
          <div className="account-select-field">
            <select id="account-select" value={selected?.id ?? ''} disabled={working} onChange={event => void action(() => api.selectAccount(event.target.value))}><option value="" disabled>Select a connection</option>{snapshot.accounts.map(account => <option key={account.id} value={account.id}>{account.label} · {account.connected ? (account.planEnabled ? 'Plan enabled' : 'Signed in · plan not enabled') : 'Reconnect required'}</option>)}</select>
            <button type="button" disabled={working} onClick={() => void action(() => api.signIn(null))}>Add ChatGPT sign in</button>
          </div>
          <button disabled={working || !selected} onClick={() => void action(() => api.signIn(selected!.id))}>Reconnect</button>
          <button disabled={!selected} onClick={() => void action(() => api.disconnect(selected!.id))}>Disconnect</button>
        </div>
      </div>

      <div className="setting-block">
        <label htmlFor="microphone-select">Microphone</label>
        <div className="control-row single-action-row">
          <select id="microphone-select" value={settings.microphoneId} onChange={event => change('microphoneId', event.target.value)}><option value="">Select a microphone explicitly</option>{snapshot.microphones.map(microphone => <option key={microphone.id} value={microphone.id}>{microphone.name}{microphone.isDefault ? ' · Windows default' : ''}</option>)}</select>
          <button disabled={working || !snapshot.settings.microphoneId} onClick={() => void action(() => api.testMicrophone())}>Test Mic</button>
        </div>
      </div>

      <div className="setting-block">
        <label htmlFor="playback-device-select">Meeting playback</label>
        <div className="control-row">
          <select id="playback-device-select" value={settings.playbackDeviceId} onChange={event => change('playbackDeviceId', event.target.value)}><option value="">Select the speakers or headset used for meetings</option>{snapshot.playbackDevices.map(device => <option key={device.id} value={device.id}>{device.name}{device.isDefault ? ' · Windows default' : ''}</option>)}</select>
        </div>
        <p className="setting-help">During an active meeting, OpenTalk records audio played through this device together with your microphone. Dictation and Assistant remain microphone-only.</p>
      </div>

      <div className="setting-block">
        <label htmlFor="speech-model-select">Transcription Model</label>
        <div className="control-row single-action-row">
          <select id="speech-model-select" value={settings.speechModel} onChange={event => change('speechModel', event.target.value as Settings['speechModel'])}><option value="moonshine-small-streaming-en">Moonshine Small Streaming · English · CPU</option><option value="base.en">Whisper Base English · about 148 MB</option><option value="small.en">Whisper Small English · about 488 MB</option></select>
          <button disabled={working} onClick={() => void action(() => api.downloadModel())}>Verify model</button>
        </div>
      </div>

      <div className="model-summary">
        <label>Cleaning model<input value={CLEANUP_MODEL_LABEL} readOnly /></label>
        <label>Reasoning Effort<input id="cleanup-reasoning-effort" value={CLEANUP_REASONING_EFFORT.charAt(0).toUpperCase() + CLEANUP_REASONING_EFFORT.slice(1)} readOnly /></label>
      </div>
    </section>

    <section className="settings-details" aria-label="Additional settings">
      {(message || snapshot.notice) && <p className="notice" role="alert">{message || snapshot.notice}</p>}

      <section className="setting-block settings-flat-block" aria-labelledby="hotkeys-heading">
        <h2 className="setting-title" id="hotkeys-heading">Hotkeys</h2>
        <div className="hotkey-grid">
          <label htmlFor="hold-shortcut"><span>Hold shortcut</span><input id="hold-shortcut" value={settings.holdShortcut} onChange={event => change('holdShortcut', event.target.value)} spellCheck={false} /></label>
          <label htmlFor="hands-free-shortcut"><span>Meeting shortcut</span><input id="hands-free-shortcut" value={settings.handsFreeShortcut} onChange={event => change('handsFreeShortcut', event.target.value)} spellCheck={false} /></label>
        </div>
        <p className="setting-help">Use Ctrl, Alt, Shift, Win and optionally Space, A–Z or F1–F12. Esc cancels. Release either hold modifier to finish.</p>
      </section>

      <section className="setting-block settings-flat-block" aria-labelledby="application-heading">
        <h2 className="setting-title" id="application-heading">Application</h2>
        <label className="application-control"><input type="checkbox" checked={settings.launchAtLogin} onChange={event => change('launchAtLogin', event.target.checked)} /><span>Launch at Windows sign-in</span></label>
        <label className="application-control"><input id="keep-overlay-visible" type="checkbox" checked={settings.keepOverlayVisible} onChange={event => change('keepOverlayVisible', event.target.checked)} /><span>Keep recording overlay visible</span></label>
        <div className="settings-action-row"><button className="primary" disabled={working} onClick={() => void action(() => api.updateSettings(settings))}>Save settings</button><button disabled={working || (!snapshot.settings.enabled && !setupReady)} onClick={() => void action(() => api.setEnabled(!snapshot.settings.enabled))}>{snapshot.settings.enabled ? 'Disable dictation' : 'Enable dictation'}</button></div>
      </section>
    </section>
  </section>;
}

interface PreferencePanelProps {
  settings: Settings;
  working: boolean;
  change<K extends keyof Settings>(key: K, value: Settings[K]): void;
  action(fn: () => Promise<unknown>): Promise<void>;
}

function DictionaryPanel({ settings, working, change, action }: PreferencePanelProps) {
  return <section className="content-view preference-view" aria-labelledby="dictionary-heading">
    <h1 id="dictionary-heading">Dictionary</h1>
    <section className="preference-form">
      <label htmlFor="preferred-vocabulary">Preferred vocabulary</label>
      <p>Add one name, product, specialist term, or preferred spelling per line.</p>
      <textarea id="preferred-vocabulary" rows={12} value={settings.vocabulary.join('\n')} onChange={event => change('vocabulary', event.target.value.split('\n').filter(value => value.trim()))} placeholder="Names, products, specialist terms" />
      <div className="actions"><button className="primary" disabled={working} onClick={() => void action(() => api.updateSettings(settings))}>Save dictionary</button></div>
    </section>
  </section>;
}

function StylesPanel({ settings, working, change, action }: PreferencePanelProps) {
  return <section className="content-view preference-view" aria-labelledby="styles-heading">
    <h1 id="styles-heading">Styles</h1>
    <section className="preference-form">
      <label htmlFor="cleanup-strength">Dictation preferences</label>
      <p>Choose how OpenTalk should rewrite your dictated text.</p>
      <select id="cleanup-strength" value={settings.cleanup} onChange={event => change('cleanup', event.target.value as Settings['cleanup'])}>
        <option value="default">Default</option>
        <option value="minimal">Minimal</option>
        <option value="casual">Casual</option>
        <option value="professional">Professional</option>
        <option value="extensive">Extensive</option>
      </select>
      <label htmlFor="software-experience">Software experience</label>
      <p>Choose consistent status messages or a more playful rotating set while dictating.</p>
      <select id="software-experience" value={settings.softwareExperience} onChange={event => change('softwareExperience', event.target.value as Settings['softwareExperience'])}><option value="default">Default</option><option value="expressive">Expressive</option></select>
      <label htmlFor="colour-theme">Colour themes</label>
      <p>Choose neutral, solid state colours, or subtle animated gradient blobs for the recording layer.</p>
      <select id="colour-theme" value={settings.colourTheme} onChange={event => change('colourTheme', event.target.value as Settings['colourTheme'])}><option value="default">Default</option><option value="vibrant">Vibrant</option><option value="gradient">Gradient</option></select>
      <div className="actions"><button className="primary" disabled={working} onClick={() => void action(() => api.updateSettings(settings))}>Save preferences</button></div>
    </section>
  </section>;
}

function CommandsPanel({ snapshot, working, message, action }: { snapshot: Snapshot; working: boolean; message: string; action(fn: () => Promise<unknown>): Promise<void> }) {
  const command = voiceCommands[0];
  const meetingActive = !['idle', 'failed'].includes(snapshot.meeting.phase);
  return <section className="content-view commands-view" aria-labelledby="commands-heading">
    <header className="commands-heading">
      <h1 id="commands-heading">Commands</h1>
      <p>Say an exact phrase while using the dictation shortcut. OpenTalk matches commands locally and runs only the listed action.</p>
    </header>
    {message && <p className="commands-feedback" role="alert">{message}</p>}
    <div className="command-list">
      <article className="command-card">
        <div className="command-copy">
          <span className="command-phrase">Say “{command.phrase}”</span>
          <h2>{command.title}</h2>
          <p>{command.description}</p>
        </div>
        <button type="button" disabled={working || meetingActive} onClick={() => void action(() => api.startMeeting())}>{meetingActive ? 'Meeting active' : command.title}</button>
      </article>
    </div>
    <p className="commands-note">Extra words do not trigger a command; they continue through normal dictation.</p>
  </section>;
}

function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [message, setMessage] = useState('');
  const [working, setWorking] = useState(false);
  const [view, setView] = useState<'overview' | 'tasks' | 'dictation' | 'dictionary' | 'styles' | 'meetings' | 'commands' | 'settings'>('overview');
  const [selectedDictation, setSelectedDictation] = useState<string | null>(null);
  const [selectedMeeting, setSelectedMeeting] = useState<string | null>(null);

  useEffect(() => {
    void api.getSnapshot().then(value => { setSnapshot(value); setSettings(value.settings); }).catch(() => setMessage('Sorry, not available'));
    return api.onStatus(value => {
      setSnapshot(value);
      setSettings(current => {
        if (!current) return value.settings;
        const draftMicrophoneAvailable = value.microphones.some(microphone => microphone.id === current.microphoneId);
        const draftPlaybackAvailable = value.playbackDevices.some(device => device.id === current.playbackDeviceId);
        return { ...current, enabled: value.settings.enabled, microphoneId: draftMicrophoneAvailable ? current.microphoneId : value.settings.microphoneId, playbackDeviceId: draftPlaybackAvailable ? current.playbackDeviceId : value.settings.playbackDeviceId };
      });
    });
  }, []);

  async function action(fn: () => Promise<unknown>): Promise<void> {
    setWorking(true); setMessage('');
    try {
      const result = await fn();
      if (result && typeof result === 'object' && 'settings' in result) { const value = result as Snapshot; setSnapshot(value); setSettings(value.settings); }
    } catch (error) { setMessage(String(error).match(/Sorry, not available(?: · [a-z0-9_]{1,64})?/)?.[0] ?? 'Sorry, not available'); }
    finally { setWorking(false); }
  }

  if (assistantSurface) return <AssistantSurface snapshot={snapshot} />;
  if (overlay) return <OverlayPill snapshot={snapshot} />;
  if (!snapshot || !settings) return <main className="hub-loading"><h1>OpenTalk</h1><p role="status">{message || 'Loading…'}</p></main>;
  function change<K extends keyof Settings>(key: K, value: Settings[K]): void { setSettings(current => current ? { ...current, [key]: value } : current); }
  function openTaskSource(task: WeeklyTask): void {
    if (task.source === 'meeting') {
      setSelectedMeeting(task.sourceId); setSelectedDictation(null); setView('meetings');
    } else {
      setSelectedDictation(task.sourceId); setSelectedMeeting(null); setView('dictation');
    }
  }

  return <main className="hub-shell">
    <aside className="sidebar">
      <img className="wordmark" src={openTalkLogo} alt="OpenTalk" />
      <nav className="primary-nav" aria-label="OpenTalk sections">
        <button type="button" className={view === 'overview' ? 'active' : ''} aria-current={view === 'overview' ? 'page' : undefined} onClick={() => setView('overview')}>Overview</button>
        <button type="button" className={view === 'tasks' ? 'active' : ''} aria-current={view === 'tasks' ? 'page' : undefined} onClick={() => setView('tasks')}>Tasks</button>
        <button type="button" className={view === 'dictation' ? 'active' : ''} aria-current={view === 'dictation' ? 'page' : undefined} onClick={() => { setSelectedDictation(null); setView('dictation'); }}>Dictation</button>
        <button type="button" className={view === 'dictionary' ? 'active' : ''} aria-current={view === 'dictionary' ? 'page' : undefined} onClick={() => setView('dictionary')}>Dictionary</button>
        <button type="button" className={view === 'styles' ? 'active' : ''} aria-current={view === 'styles' ? 'page' : undefined} onClick={() => setView('styles')}>Styles</button>
        <button type="button" className={view === 'meetings' ? 'active' : ''} aria-current={view === 'meetings' ? 'page' : undefined} onClick={() => { setSelectedMeeting(null); setView('meetings'); }}>Meetings</button>
        <button type="button" className={view === 'commands' ? 'active' : ''} aria-current={view === 'commands' ? 'page' : undefined} onClick={() => setView('commands')}>Commands</button>
      </nav>
      <nav className="secondary-nav" aria-label="OpenTalk support and settings">
        <button type="button" className={view === 'settings' ? 'active' : ''} aria-current={view === 'settings' ? 'page' : undefined} onClick={() => setView('settings')}>Settings</button>
        <button type="button" onClick={() => void action(() => api.manageUsage())}>Usage</button>
      </nav>
    </aside>
    <div className="content-panel">
      {view === 'overview'
        ? <OverviewPanel historyRevision={snapshot.historyRevision} meetingsRevision={snapshot.meetingsRevision} onDictations={() => { setSelectedDictation(null); setView('dictation'); }} onTasks={() => setView('tasks')} onUsage={() => void action(() => api.manageUsage())} />
        : view === 'tasks'
        ? <TasksPanel historyRevision={snapshot.historyRevision} meetingsRevision={snapshot.meetingsRevision} onOpenSource={openTaskSource} />
        : view === 'dictation'
        ? <HistoryPanel available={snapshot.historyAvailable} revision={snapshot.historyRevision} selectedId={selectedDictation} />
        : view === 'dictionary'
          ? <DictionaryPanel settings={settings} working={working} change={change} action={action} />
          : view === 'styles'
            ? <StylesPanel settings={settings} working={working} change={change} action={action} />
            : view === 'meetings'
              ? selectedMeeting
                ? <MeetingDetailPanel id={selectedMeeting} revision={snapshot.meetingsRevision} onBack={() => setSelectedMeeting(null)} />
                : <MeetingsPanel available={snapshot.meetingsAvailable} revision={snapshot.meetingsRevision} onSelect={setSelectedMeeting} />
              : view === 'commands'
                ? <CommandsPanel snapshot={snapshot} working={working} message={message} action={action} />
                : <SettingsPanel snapshot={snapshot} settings={settings} working={working} message={message} change={change} action={action} />}
    </div>
  </main>;
}

const root = document.getElementById('root'); if (root) createRoot(root).render(<App />);
