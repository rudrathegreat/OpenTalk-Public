import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaults } from '../packages/core/src/contracts';
import { SettingsStore, ProtectedStore } from '../packages/core/src/storage';
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function temporary() { const path = await mkdtemp(join(tmpdir(), 'dictation-test-')); directories.push(path); return path; }
function versionThreeDefaults() {
  return {
    version: 3 as const, enabled: defaults.enabled, microphoneId: defaults.microphoneId,
    holdShortcut: defaults.holdShortcut, handsFreeShortcut: defaults.handsFreeShortcut,
    cleanup: 'adaptive' as const, vocabulary: defaults.vocabulary, speechModel: defaults.speechModel,
    launchAtLogin: defaults.launchAtLogin,
  };
}
function versionFourDefaults() {
  return { ...versionThreeDefaults(), version: 4 as const, keepOverlayVisible: defaults.keepOverlayVisible };
}
function versionFiveDefaults() {
  return { ...versionFourDefaults(), version: 5 as const, softwareExperience: defaults.softwareExperience };
}
function versionSixDefaults() {
  return { ...versionFiveDefaults(), version: 6 as const, playbackDeviceId: defaults.playbackDeviceId };
}
function versionSevenDefaults() {
  return { ...versionSixDefaults(), version: 7 as const, cleanup: 'default' as const };
}
describe('atomic versioned storage', () => {
  it('uses safe recording defaults for a new profile', async () => { const store = new SettingsStore(join(await temporary(), 'settings.json')); expect(await store.load()).toMatchObject({ version: 8, enabled: true, cleanup: 'default', keepOverlayVisible: false, softwareExperience: 'default', playbackDeviceId: '', colourTheme: 'default' }); expect(store.recovered).toBe(false); });
  it('persists ordered concurrent updates and restores values', async () => { const file = join(await temporary(), 'settings.json'); const store = new SettingsStore(file); await store.load(); await Promise.all([store.update({ ...defaults, cleanup: 'minimal' }), store.update({ ...defaults, vocabulary: ['ExampleTerm'] })]); const reopened = new SettingsStore(file); expect((await reopened.load()).vocabulary).toEqual(['ExampleTerm']); expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(reopened.get()); });
  it('migrates the focus-stealing legacy shortcut pair atomically', async () => { const file = join(await temporary(), 'settings.json'); await writeFile(file, JSON.stringify({ ...defaults, holdShortcut: 'Ctrl+Win', handsFreeShortcut: 'Ctrl+Win+Space', enabled: true })); const store = new SettingsStore(file); const loaded = await store.load(); expect(loaded).toMatchObject({ enabled: true, holdShortcut: 'Ctrl+Shift', handsFreeShortcut: 'Ctrl+Shift+Space' }); expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(loaded); });
  it('migrates version-one model settings without losing preferences', async () => {
    const file = join(await temporary(), 'settings.json');
    await writeFile(file, JSON.stringify({ ...versionThreeDefaults(), version: 1, enabled: true, microphoneId: 'saved-mic', cleanup: 'minimal', vocabulary: ['ExampleTerm'], speechModel: 'small.en', cleanupModel: 'previous-model', launchAtLogin: true }));
    const store = new SettingsStore(file); const loaded = await store.load();
    expect(loaded).toEqual({ ...defaults, enabled: true, microphoneId: 'saved-mic', cleanup: 'minimal', vocabulary: ['ExampleTerm'], launchAtLogin: true });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(loaded); expect(store.recovered).toBe(false);
  });
  it('switches version-two profiles to Moonshine once and preserves later explicit Whisper choices', async () => {
    const file = join(await temporary(), 'settings.json');
    await writeFile(file, JSON.stringify({ ...versionThreeDefaults(), version: 2, speechModel: 'base.en', enabled: false, microphoneId: 'saved-mic' }));
    const store = new SettingsStore(file);
    expect(await store.load()).toEqual({ ...defaults, enabled: false, microphoneId: 'saved-mic' });
    await store.update({ ...store.get(), speechModel: 'small.en' });
    expect((await new SettingsStore(file).load()).speechModel).toBe('small.en');
  });
  it('adds the overlay preference to version-three profiles without changing their choices', async () => {
    const file = join(await temporary(), 'settings.json');
    await writeFile(file, JSON.stringify({ ...versionThreeDefaults(), enabled: false, microphoneId: 'saved-mic', speechModel: 'small.en', launchAtLogin: true }));
    const store = new SettingsStore(file); const loaded = await store.load();
    expect(loaded).toEqual({ ...defaults, enabled: false, microphoneId: 'saved-mic', speechModel: 'small.en', launchAtLogin: true });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(loaded); expect(store.recovered).toBe(false);
  });
  it('adds the default software experience to version-four profiles without changing their choices', async () => {
    const file = join(await temporary(), 'settings.json');
    await writeFile(file, JSON.stringify({ ...versionFourDefaults(), enabled: false, microphoneId: 'saved-mic', cleanup: 'minimal', speechModel: 'small.en', keepOverlayVisible: true }));
    const store = new SettingsStore(file); const loaded = await store.load();
    expect(loaded).toEqual({ ...defaults, enabled: false, microphoneId: 'saved-mic', cleanup: 'minimal', speechModel: 'small.en', keepOverlayVisible: true });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(loaded); expect(store.recovered).toBe(false);
  });
  it('adds an unresolved playback endpoint to version-five profiles without changing their choices', async () => {
    const file = join(await temporary(), 'settings.json');
    await writeFile(file, JSON.stringify({ ...versionFiveDefaults(), enabled: false, microphoneId: 'saved-mic', cleanup: 'minimal', speechModel: 'small.en', keepOverlayVisible: true, softwareExperience: 'expressive' }));
    const store = new SettingsStore(file); const loaded = await store.load();
    expect(loaded).toEqual({ ...defaults, enabled: false, microphoneId: 'saved-mic', playbackDeviceId: '', cleanup: 'minimal', speechModel: 'small.en', keepOverlayVisible: true, softwareExperience: 'expressive' });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(loaded); expect(store.recovered).toBe(false);
  });
  it('renames adaptive to default when migrating version-six settings', async () => {
    const file = join(await temporary(), 'settings.json');
    await writeFile(file, JSON.stringify({ ...versionSixDefaults(), enabled: false, microphoneId: 'saved-mic', cleanup: 'adaptive', softwareExperience: 'expressive' }));
    const store = new SettingsStore(file); const loaded = await store.load();
    expect(loaded).toEqual({ ...defaults, enabled: false, microphoneId: 'saved-mic', cleanup: 'default', softwareExperience: 'expressive' });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(loaded); expect(store.recovered).toBe(false);
  });
  it('adds the default colour theme to version-seven profiles without losing newer settings', async () => {
    const file = join(await temporary(), 'settings.json');
    await writeFile(file, JSON.stringify({ ...versionSevenDefaults(), enabled: false, microphoneId: 'saved-mic', playbackDeviceId: 'saved-playback', cleanup: 'extensive', softwareExperience: 'expressive' }));
    const store = new SettingsStore(file); const loaded = await store.load();
    expect(loaded).toEqual({ ...defaults, enabled: false, microphoneId: 'saved-mic', playbackDeviceId: 'saved-playback', cleanup: 'extensive', softwareExperience: 'expressive' });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(loaded); expect(store.recovered).toBe(false);
  });
  it('recovers the original vibrant version-six profile while adding newer defaults', async () => {
    const file = join(await temporary(), 'settings.json');
    await writeFile(file, JSON.stringify({ ...versionFiveDefaults(), version: 6, enabled: false, microphoneId: 'saved-mic', cleanup: 'minimal', softwareExperience: 'expressive', colourTheme: 'vibrant' }));
    const store = new SettingsStore(file); const loaded = await store.load();
    expect(loaded).toEqual({ ...defaults, enabled: false, microphoneId: 'saved-mic', cleanup: 'minimal', softwareExperience: 'expressive', colourTheme: 'vibrant' });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(loaded); expect(store.recovered).toBe(false);
  });
  it.each(['default', 'minimal', 'casual', 'professional', 'extensive'] as const)('persists the %s dictation style', async cleanup => {
    const file = join(await temporary(), 'settings.json'); const store = new SettingsStore(file);
    await store.load(); await store.update({ ...store.get(), cleanup });
    expect(await new SettingsStore(file).load()).toMatchObject({ version: 8, cleanup });
  });
  it('persists an expressive software experience', async () => {
    const file = join(await temporary(), 'settings.json'); const store = new SettingsStore(file);
    await store.load(); await store.update({ ...store.get(), softwareExperience: 'expressive' });
    expect(await new SettingsStore(file).load()).toMatchObject({ version: 8, softwareExperience: 'expressive' });
  });
  it.each(['vibrant', 'gradient'] as const)('persists the %s colour theme', async colourTheme => {
    const file = join(await temporary(), 'settings.json'); const store = new SettingsStore(file);
    await store.load(); await store.update({ ...store.get(), colourTheme });
    expect(await new SettingsStore(file).load()).toMatchObject({ version: 8, colourTheme });
  });
  it('recovers corrupt and future settings without enabling capture', async () => { const file = join(await temporary(), 'settings.json'); await writeFile(file, '{bad'); const store = new SettingsStore(file); expect((await store.load()).enabled).toBe(false); expect(store.recovered).toBe(true); await writeFile(file, JSON.stringify({ ...defaults, version: 999, enabled: true })); expect((await store.load()).enabled).toBe(false); });
  it('rejects invalid changes without losing saved settings', async () => { const file = join(await temporary(), 'settings.json'); const store = new SettingsStore(file); await store.update(defaults); expect(() => store.update({ ...defaults, microphoneId: 12 })).toThrow(); expect(store.get()).toEqual(defaults); });
  it('never writes a plaintext fallback when encryption fails', async () => { const file = join(await temporary(), 'accounts.enc'); const store = new ProtectedStore(file, { encrypt: () => { throw new Error('DPAPI unavailable'); }, decrypt: () => '' }, value => value); expect(() => store.save({ token: 'secret' })).toThrow(); await expect(readFile(file)).rejects.toThrow(); });
});
