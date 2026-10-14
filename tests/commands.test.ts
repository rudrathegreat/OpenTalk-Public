import { describe, expect, it } from 'vitest';
import { couldBeVoiceCommand, matchVoiceCommand, voiceCommands } from '../packages/core/src/commands';

describe('deterministic voice commands', () => {
  it('publishes the fixed Start Meeting command for the hub', () => {
    expect(voiceCommands).toEqual([{
      id: 'start-meeting',
      title: 'Start Meeting',
      phrase: 'start meeting',
      description: 'Starts a local recording of your microphone and selected meeting playback.',
    }]);
  });

  it.each(['start meeting', ' Start Meeting ', 'START MEETING.', 'Start Meeting?!'])('matches an exact normalized phrase: %s', phrase => {
    expect(matchVoiceCommand(phrase)).toBe('start-meeting');
  });

  it.each(['start', 'start meeting please', 'please start meeting', 'start the meeting', ''])('rejects non-command text: %s', phrase => {
    expect(matchVoiceCommand(phrase)).toBeNull();
  });

  it('identifies only nonempty prefixes that may become a command', () => {
    expect(couldBeVoiceCommand('start')).toBe(true);
    expect(couldBeVoiceCommand('start meet')).toBe(true);
    expect(couldBeVoiceCommand('start meeting')).toBe(true);
    expect(couldBeVoiceCommand('')).toBe(false);
    expect(couldBeVoiceCommand('ordinary dictation')).toBe(false);
  });
});
