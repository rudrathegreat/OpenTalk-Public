import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { AccountService, type AccountState, type AccountStorage } from '../packages/core/src/accounts';
import { OAuthClient, type TokenResponse } from '../packages/core/src/oauth';
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const fresh: TokenResponse = { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600, scope: 'chatgpt.tokens.use.direct offline_access', token_type: 'Bearer' };
async function setup() {
  const id = randomUUID(), other = randomUUID();
  const data: AccountState = { version: 1, hostId: `urn:uuid:${randomUUID()}`, selectedId: id, profiles: [id, other].map((value, index) => ({ id: value, clientId: `client-${index}`, subject: `person-${index}`, label: 'Same email', credentials: { accessToken: `access-${index}`, refreshToken: `refresh-${index}`, idToken: null, expiresAt: 1000, scope: 'chatgpt.tokens.use.direct offline_access' } })) };
  const saved: AccountState[] = [];
  const storage: AccountStorage = { load: async () => structuredClone(data), save: async state => { saved.push(structuredClone(state)); } };
  const oauth = new OAuthClient(async () => undefined);
  const service = new AccountService(storage, oauth, async () => new Response('{}'), () => 2000);
  await service.load(); return { service, oauth, id, other, saved };
}
describe('registration credentials and refresh races', () => {
  it('serializes concurrent refresh and persists rotation', async () => { const { service, oauth, id, saved } = await setup(); const gate = deferred<TokenResponse>(); const refresh = vi.spyOn(oauth, 'refresh').mockReturnValue(gate.promise); const signal = new AbortController().signal; const a = service.token(id, signal), b = service.token(id, signal); gate.resolve(fresh); expect(await Promise.all([a,b])).toEqual(['new-access','new-access']); expect(refresh).toHaveBeenCalledTimes(1); expect(saved.at(-1)?.profiles[0]?.credentials?.refreshToken).toBe('new-refresh'); });
  it('late refresh cannot revive a disconnected registration', async () => { const { service, oauth, id, saved } = await setup(); const gate = deferred<TokenResponse>(); vi.spyOn(oauth, 'refresh').mockReturnValue(gate.promise); vi.spyOn(oauth, 'revoke').mockResolvedValue(true); const pending = service.token(id, new AbortController().signal); await service.disconnect(id); gate.resolve(fresh); await expect(pending).rejects.toThrow(); expect(service.views().find(a => a.id === id)?.connected).toBe(false); expect(saved.at(-1)?.profiles[0]?.credentials).toBeNull(); });
  it('same email registrations never mix token/client pairs', async () => { const { service, oauth, id, other } = await setup(); const refresh = vi.spyOn(oauth, 'refresh').mockResolvedValue(fresh); await service.select(other); await service.token(other, new AbortController().signal); expect(refresh.mock.calls[0]?.slice(0,2)).toEqual(['client-1','refresh-1']); expect(service.views().find(a => a.id === id)?.selected).toBe(false); expect(JSON.stringify(service.views())).not.toContain('refresh-'); });
  it('reports remote revocation failure while clearing local credentials', async () => { const { service, oauth, id, saved } = await setup(); vi.spyOn(oauth, 'revoke').mockRejectedValue(new Error('network')); expect(await service.disconnect(id)).toBe(false); expect(saved.at(-1)?.profiles[0]?.credentials).toBeNull(); });
  it('denied plan scope blocks inference access', async () => { const { service, oauth, id } = await setup(); vi.spyOn(oauth, 'refresh').mockResolvedValue({ ...fresh, scope: 'openid profile' }); await expect(service.token(id, new AbortController().signal)).rejects.toThrow(); expect(service.views().find(a => a.id === id)?.planEnabled).toBe(false); });
  it('aborted caller never receives a late refreshed token', async () => { const { service, oauth, id } = await setup(); const gate = deferred<TokenResponse>(); vi.spyOn(oauth, 'refresh').mockReturnValue(gate.promise); const controller = new AbortController(); const pending = service.token(id, controller.signal); controller.abort(); gate.resolve(fresh); await expect(pending).rejects.toThrow(); });
});
