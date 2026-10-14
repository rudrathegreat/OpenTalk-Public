import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { CLEANUP_MODEL, defaults, dictationSetupReady, historyEntrySchema, historyQuerySchema, meetingPlaybackReady, settingsSchema, parseEnvelope } from '../packages/core/src/contracts';
import { assistantIpcAllowed, overlayIpcAllowed, trustedFrame, uiPath } from '../packages/core/src/ipc';
import { OAuthClient, validateCallback, verifyIdentity } from '../packages/core/src/oauth';
import { authEndpoint } from '../packages/core/src/network';
describe('trust boundaries', () => {
  it('rejects malformed shortcuts, vocabulary and preferences', () => { for (const change of [{ holdShortcut: 'Ctrl+Ctrl' }, { handsFreeShortcut: 'Ctrl+Shift' }, { vocabulary: ['Name', 'name'] }, { vocabulary: ['x'.repeat(101)] }, { holdShortcut: 'Space' }, { softwareExperience: 'chaotic' }, { colourTheme: 'neon' }, { token: 'private' }]) expect(() => settingsSchema.parse({ ...defaults, ...change })).toThrow(); });
  it('accepts valid settings and fails unknown protocol version', () => { expect(settingsSchema.parse(defaults)).toEqual(defaults); const event = { version: 1, requestId: randomUUID(), generation: 1, sessionId: null, sequence: 1, type: 'ready', payload: {} }; expect(parseEnvelope(JSON.stringify(event)).type).toBe('ready'); expect(() => parseEnvelope(JSON.stringify({ ...event, version: 2 }))).toThrow(); expect(() => parseEnvelope('x'.repeat(262145))).toThrow(); });
  it('bounds and strictly validates history IPC payloads', () => {
    const entry = { id: randomUUID(), createdAt: '2026-10-04T05:00:00.000Z', text: 'Synthetic cleaned result.' };
    expect(historyEntrySchema.parse(entry)).toEqual(entry); expect(historyQuerySchema.parse({ search: 'result', cursor: null })).toEqual({ search: 'result', cursor: null });
    for (const value of [{ search: 'x'.repeat(201), cursor: null }, { search: '', cursor: null, text: 'private' }, { search: '', cursor: 1 }]) expect(() => historyQuerySchema.parse(value)).toThrow();
    for (const value of [{ ...entry, text: '' }, { ...entry, text: 'unsafe\0text' }, { ...entry, createdAt: 'today' }, { ...entry, token: 'private' }]) expect(() => historyEntrySchema.parse(value)).toThrow();
  });
  it('enables dictation only when every saved setup dependency is available', () => {
    const ready = { settings: { ...defaults, microphoneId: 'mic' }, accounts: [{ id: randomUUID(), label: 'Account', connected: true, planEnabled: true, selected: true }], models: [{ slug: CLEANUP_MODEL, displayName: 'GPT-5.6 Luna' }], microphones: [{ id: 'mic', name: 'Microphone', isDefault: true }], modelReady: true, nativeReady: true };
    expect(dictationSetupReady(ready)).toBe(true);
    expect(dictationSetupReady({ ...ready, microphones: [] })).toBe(false);
    expect(dictationSetupReady({ ...ready, accounts: ready.accounts.map(account => ({ ...account, planEnabled: false })) })).toBe(false);
    expect(dictationSetupReady({ ...ready, models: [{ slug: 'different-model', displayName: 'Different model' }] })).toBe(false);
  });
  it('authorizes only the expected main renderer', () => { expect(() => trustedFrame(2, 2, 'opentalk://app/index.html', true)).not.toThrow(); for (const args of [[1, 2, 'opentalk://app/index.html', true], [2, 2, 'https://evil.test', true], [2, 2, 'opentalk://app/index.html', false]] as const) expect(() => trustedFrame(args[0], args[1], args[2], args[3])).toThrow(); });
  it('limits the overlay to session feedback, command-mode selection, active meeting controls and one-shot recovery copy', () => {
    expect(() => trustedFrame(3, 3, 'opentalk://app/index.html?overlay=1', true)).not.toThrow();
    expect(['snapshot', 'cancel-session', 'recording-visible', 'copy-recovery', 'overlay-pointer-input', 'command-mode', 'meeting-pause', 'meeting-resume', 'meeting-bookmark', 'meeting-stop'].every(overlayIpcAllowed)).toBe(true);
    expect(['settings', 'overview', 'weekly-tasks', 'history-query', 'history-copy', 'history-delete', 'meeting-start'].some(overlayIpcAllowed)).toBe(false);
  });
  it('gates meeting playback independently without disabling microphone dictation', () => {
    const settings = { ...defaults, microphoneId: 'mic', playbackDeviceId: 'speaker' };
    expect(meetingPlaybackReady({ settings, playbackDevices: [{ id: 'speaker', name: 'Speakers', isDefault: true }], nativeReady: true })).toBe(true);
    expect(meetingPlaybackReady({ settings, playbackDevices: [], nativeReady: true })).toBe(false);
    expect(meetingPlaybackReady({ settings, playbackDevices: [{ id: 'speaker', name: 'Speakers', isDefault: true }], nativeReady: false })).toBe(false);
  });
  it('limits the assistant surface to its explicit lifecycle actions', () => {
    expect(() => trustedFrame(4, 4, 'opentalk://app/index.html?assistant=1', true)).not.toThrow();
    expect(['snapshot', 'cancel-session', 'assistant-start', 'assistant-stop', 'assistant-accept', 'assistant-result', 'assistant-copy'].every(assistantIpcAllowed)).toBe(true);
    expect(['settings', 'devices', 'overview', 'weekly-tasks', 'history-query', 'meeting-start', 'overlay-pointer-input'].some(assistantIpcAllowed)).toBe(false);
  });
  it('rejects traversal and foreign application protocol paths', () => { expect(uiPath('opentalk://app/assets/file.js')).toBe('assets/file.js'); for (const path of ['opentalk://evil/index.html', 'opentalk://app/assets/%2e%2e%5csecret', 'opentalk://app/accounts.enc', 'opentalk://user@app/index.html', 'dictation://app/index.html']) expect(() => uiPath(path)).toThrow(); });
  it('checks callback state, duplicates, denial and registration isolation', () => { expect(validateCallback(new URL('http://127.0.0.1/auth/callback?state=s&code=c&client_id=issued'), 's', null).clientId).toBe('issued'); expect(() => validateCallback(new URL('http://127.0.0.1/?state=s&code=c'), 's', null)).toThrow(); for (const query of ['state=wrong&code=c&client_id=issued', 'state=s&error=denied', 'state=s&code=c&code=d&client_id=issued', 'state=s&code=c&client_id=other']) expect(() => validateCallback(new URL(`http://127.0.0.1/?${query}`), 's', 'issued')).toThrow(); });
  it('rejects untrusted identity discovery endpoints', () => { for (const endpoint of ['https://evil.test/keys', 'https://user@auth.openai.com/keys', 'http://auth.openai.com/keys']) expect(() => authEndpoint(endpoint)).toThrow(); });
  it('accepts required token fields while treating unused refresh metadata as opaque', async () => {
    const fetcher = async () => new Response(JSON.stringify({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', id_token: 'synthetic-id', expires_in: 3600, scope: 'openid offline_access chatgpt.tokens.use.direct', token_type: 'Bearer', earliest_refresh_at: 'provider-defined' }));
    const client = new OAuthClient(async () => undefined, fetcher as typeof fetch);
    const token = await client.token(new URLSearchParams(), new AbortController().signal);
    expect(token.access_token).toBe('synthetic-access');
  });
  it('rejects an offline token response without a rotating refresh credential', async () => {
    const fetcher = async () => new Response(JSON.stringify({ access_token: 'synthetic-access', expires_in: 3600, scope: 'openid offline_access', token_type: 'Bearer' }));
    const client = new OAuthClient(async () => undefined, fetcher as typeof fetch);
    await expect(client.token(new URLSearchParams(), new AbortController().signal)).rejects.toThrow('Sorry, not available');
  });
  it('validates signed identity and rejects wrong subject, nonce, audience, expiry and signature', async () => {
    const pair = await generateKeyPair('RS256'); const key = { ...await exportJWK(pair.publicKey), kid: 'test', alg: 'RS256' };
    const jwt = (nonce = 'nonce', audience = 'client', expiration = '1h') => new SignJWT({ nonce, email: 'example@example.test' }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer('https://auth.openai.com').setSubject('person').setAudience(audience).setExpirationTime(expiration).sign(pair.privateKey);
    expect((await verifyIdentity(await jwt(), { keys: [key] }, 'client', 'nonce', null)).subject).toBe('person');
    await expect(verifyIdentity(await jwt(), { keys: [key] }, 'client', 'wrong', null)).rejects.toThrow();
    await expect(verifyIdentity(await jwt(), { keys: [key] }, 'client', 'nonce', 'other')).rejects.toThrow();
    await expect(verifyIdentity(await jwt('nonce', 'wrong'), { keys: [key] }, 'client', 'nonce', null)).rejects.toThrow();
    await expect(verifyIdentity(await jwt('nonce', 'client', '-1h'), { keys: [key] }, 'client', 'nonce', null)).rejects.toThrow();
    const forged = (await jwt()).split('.'); forged[1] = Buffer.from(JSON.stringify({ sub: 'forged' })).toString('base64url'); await expect(verifyIdentity(forged.join('.'), { keys: [key] }, 'client', 'nonce', null)).rejects.toThrow();
  });
});
