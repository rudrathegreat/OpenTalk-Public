export const voiceCommands = [{
  id: 'start-meeting',
  title: 'Start Meeting',
  phrase: 'start meeting',
  description: 'Starts a local recording of your microphone and selected meeting playback.',
}] as const;

export type VoiceCommandId = typeof voiceCommands[number]['id'];

function normalizeVoiceCommand(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/\s+/gu, ' ')
    .replace(/[.!?,;:]+$/u, '')
    .trim();
}

export function matchVoiceCommand(value: string): VoiceCommandId | null {
  const normalized = normalizeVoiceCommand(value);
  return voiceCommands.find(command => command.phrase === normalized)?.id ?? null;
}

export function couldBeVoiceCommand(value: string): boolean {
  const normalized = normalizeVoiceCommand(value);
  return Boolean(normalized) && voiceCommands.some(command => command.phrase.startsWith(normalized));
}
