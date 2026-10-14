import { describe, expect, it } from 'vitest';
import { preferredMicrophoneId, preferredPlaybackDeviceId, type Microphone, type PlaybackDevice } from '../packages/core/src/contracts';

const microphones: Microphone[] = [
  { id: '0:Windows default', name: 'Windows default', isDefault: true },
  { id: '1:Manual microphone', name: 'Manual microphone', isDefault: false },
];

describe('startup microphone selection', () => {
  it('selects the Windows default for an empty or unavailable saved choice', () => {
    expect(preferredMicrophoneId('', microphones)).toBe('0:Windows default');
    expect(preferredMicrophoneId('2:Removed microphone', microphones)).toBe('0:Windows default');
    expect(preferredMicrophoneId('7:Manual microphone', microphones)).toBe('0:Windows default');
  });

  it('preserves any saved microphone that is still available', () => {
    expect(preferredMicrophoneId('1:Manual microphone', microphones)).toBe('1:Manual microphone');
    expect(preferredMicrophoneId('0:Windows default', microphones)).toBe('0:Windows default');
  });

  it('retains the unresolved setting when Windows reports no default', () => {
    const withoutDefault = microphones.map(microphone => ({ ...microphone, isDefault: false }));
    expect(preferredMicrophoneId('2:Temporarily missing', withoutDefault)).toBe('2:Temporarily missing');
    expect(preferredMicrophoneId('', [])).toBe('');
  });
});

describe('startup meeting playback selection', () => {
  const devices: PlaybackDevice[] = [
    { id: '0:Default speakers', name: 'Default speakers', isDefault: true },
    { id: '1:Meeting headset', name: 'Meeting headset', isDefault: false },
  ];
  it('selects the Windows default for an empty or unavailable saved choice', () => {
    expect(preferredPlaybackDeviceId('', devices)).toBe('0:Default speakers');
    expect(preferredPlaybackDeviceId('2:Removed output', devices)).toBe('0:Default speakers');
  });
  it('preserves an available explicit meeting output and retains an unresolved choice without a default', () => {
    expect(preferredPlaybackDeviceId('1:Meeting headset', devices)).toBe('1:Meeting headset');
    expect(preferredPlaybackDeviceId('removed', devices.map(device => ({ ...device, isDefault: false })))).toBe('removed');
  });
});
