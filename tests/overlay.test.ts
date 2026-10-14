import { describe, expect, it } from 'vitest';
import { overlayPresentation } from '../apps/desktop/renderer/src/overlay';
import { defaults, overlayNeedsPointerInput, overlayShouldBeVisible, type Phase, type Snapshot } from '../packages/core/src/contracts';

function snapshot(phase: Phase, message: string = phase): Snapshot {
  return { settings: defaults, accounts: [], models: [], microphones: [], playbackDevices: [], status: { phase, message, canCopy: false }, notice: '', modelReady: false, nativeReady: false, historyAvailable: true, historyRevision: 0, meetingsAvailable: true, meetingsRevision: 0, meeting: { phase: 'idle', transcript: '', startedAt: null, bookmarks: [] }, assistant: { phase: 'hidden' }, commandMode: false, audioLevel: 0 };
}

describe('overlay presentation', () => {
  it.each(['idle', 'disabled'] as const)('shows the startup instruction for %s', phase => {
    expect(overlayPresentation(snapshot(phase))).toMatchObject({ key: 'launch', label: 'Hold Ctrl+Shift and speak', centered: true });
  });
  it('shows an accurate disabled state when the overlay is kept visible', () => {
    const disabled = snapshot('disabled', 'Disabled'); disabled.settings = { ...defaults, keepOverlayVisible: true };
    expect(overlayPresentation(disabled)).toMatchObject({ key: 'disabled', label: 'Disabled', kind: 'status' });
  });
  it('hides the idle layer when persistence is off and shows only explicit visibility states', () => {
    const idle = snapshot('idle', 'Ready');
    expect(overlayShouldBeVisible(idle.status, true, false)).toBe(true);
    expect(overlayShouldBeVisible(idle.status, false, false)).toBe(false);
    expect(overlayShouldBeVisible(idle.status, false, true)).toBe(true);
    expect(overlayShouldBeVisible(snapshot('disabled').status, false, true)).toBe(true);
    expect(overlayShouldBeVisible(snapshot('done').status, false, false)).toBe(true);
    expect(overlayShouldBeVisible(idle.status, false, false, { phase: 'starting', transcript: '', startedAt: null, bookmarks: [] })).toBe(true);
    expect(overlayShouldBeVisible(idle.status, false, false, { phase: 'paused', transcript: 'Synthetic transcript.', startedAt: '2026-10-10T00:00:00.000Z', bookmarks: [] })).toBe(true);
    expect(overlayShouldBeVisible(idle.status, false, false, { phase: 'failed', transcript: '', startedAt: null, bookmarks: [] })).toBe(false);
  });
  it('keeps the recording label left of a separate waveform', () => {
    expect(overlayPresentation(snapshot('recording'))).toMatchObject({ key: 'recording', label: 'Recording', recording: true, centered: false, colour: 'recording' });
  });
  it.each(['transcribing', 'cleaning', 'inserting'] as const)('maps %s to the stable Processing view', phase => {
    expect(overlayPresentation(snapshot(phase, 'legacy detail'))).toMatchObject({ key: 'processing', label: 'Processing', centered: true, colour: 'processing' });
  });
  it('shows successful completion', () => {
    expect(overlayPresentation(snapshot('done', 'Done'))).toMatchObject({ label: 'Done', kind: 'status', centered: true, colour: 'success' });
  });
  it.each([
    ['recording', 0, 'Go for it'],
    ['recording', 0.999, "I'm listening"],
    ['transcribing', 0, 'Cleaning that up'],
    ['cleaning', 0.5, 'One sec, fixing the umms'],
    ['inserting', 0.999, 'Turning ramble into writing'],
    ['done', 0, 'All yours!'],
    ['done', 0.999, 'And.... Done!'],
  ] as const)('selects expressive copy for %s at %s', (phase, value, label) => {
    const expressive = snapshot(phase, phase); expressive.settings = { ...defaults, softwareExperience: 'expressive' };
    expect(overlayPresentation(expressive, () => value).label).toBe(label);
  });
  it('keeps all other messages unchanged in expressive mode', () => {
    const blocked = snapshot('blocked', 'Insertion blocked'); blocked.settings = { ...defaults, softwareExperience: 'expressive' };
    expect(overlayPresentation(blocked, () => 0).label).toBe('Insertion blocked');
  });
  it('preserves other status messages', () => {
    expect(overlayPresentation(snapshot('blocked', 'Insertion blocked'))).toMatchObject({ label: 'Insertion blocked', kind: 'status', colour: 'blocked' });
    expect(overlayPresentation(snapshot('unavailable', 'Sorry, not available'))).toMatchObject({ colour: 'neutral' });
  });
  it('offers Copy only for an explicitly copyable blocked result', () => {
    const blocked = snapshot('blocked', 'Insertion blocked'); blocked.status.canCopy = true;
    expect(overlayPresentation(blocked)).toMatchObject({ label: 'Insertion blocked', kind: 'status', canCopy: true, centered: false });
    expect(overlayNeedsPointerInput(blocked.status)).toBe(true);
    expect(overlayPresentation(snapshot('blocked', 'Insertion blocked')).canCopy).toBe(false);
    const inconsistent = snapshot('unavailable', 'Sorry, not available'); inconsistent.status.canCopy = true;
    expect(overlayPresentation(inconsistent).canCopy).toBe(false); expect(overlayNeedsPointerInput(inconsistent.status)).toBe(false);
    expect(overlayNeedsPointerInput(snapshot('idle').status)).toBe(true);
  });
});
