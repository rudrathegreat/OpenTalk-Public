import type { Snapshot } from '../../../../packages/core/src/contracts';

export type OverlayKind = 'launch' | 'recording' | 'processing' | 'status';
export interface OverlayPresentation {
  kind: OverlayKind;
  key: string;
  label: string;
  recording: boolean;
  centered: boolean;
  canCopy: boolean;
  colour: 'neutral' | 'recording' | 'processing' | 'success' | 'blocked';
}

const expressiveLabels = {
  recording: ['Go for it', 'Brain dump away', "I'm listening"],
  processing: ['Cleaning that up', 'Tidying your thoughts', 'One sec, fixing the umms', 'Turning ramble into writing'],
  done: ['All yours!', 'There we go', 'Ready to go', 'And.... Done!'],
} as const;

function randomLabel(labels: readonly string[], random: () => number): string {
  return labels[Math.min(labels.length - 1, Math.max(0, Math.floor(random() * labels.length)))]!;
}

export function overlayPresentation(snapshot: Snapshot | null, random: () => number = Math.random): OverlayPresentation {
  const phase = snapshot?.status.phase ?? 'idle';
  const expressive = snapshot?.settings.softwareExperience === 'expressive';
  if (phase === 'disabled' && snapshot?.settings.keepOverlayVisible) {
    return { kind: 'status', key: 'disabled', label: snapshot.status.message, recording: false, centered: true, canCopy: false, colour: 'neutral' };
  }
  if (phase === 'idle' || phase === 'disabled') {
    return { kind: 'launch', key: 'launch', label: 'Hold Ctrl+Shift and speak', recording: false, centered: true, canCopy: false, colour: 'neutral' };
  }
  if (phase === 'recording') {
    return { kind: 'recording', key: 'recording', label: expressive ? randomLabel(expressiveLabels.recording, random) : 'Recording', recording: true, centered: false, canCopy: false, colour: 'recording' };
  }
  if (phase === 'transcribing' || phase === 'cleaning' || phase === 'inserting') {
    return { kind: 'processing', key: 'processing', label: expressive ? randomLabel(expressiveLabels.processing, random) : 'Processing', recording: false, centered: true, canCopy: false, colour: 'processing' };
  }
  if (phase === 'done') {
    return { kind: 'status', key: 'done', label: expressive ? randomLabel(expressiveLabels.done, random) : 'Done', recording: false, centered: true, canCopy: false, colour: 'success' };
  }
  const label = snapshot?.status.message ?? 'Sorry, not available';
  const canCopy = phase === 'blocked' && snapshot?.status.canCopy === true;
  return { kind: 'status', key: `${phase}:${label}:${canCopy}`, label, recording: false, centered: !canCopy, canCopy, colour: phase === 'blocked' ? 'blocked' : 'neutral' };
}
