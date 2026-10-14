import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AccountView, ModelView } from './contracts';
import { AppError, checkAbort } from './errors';
import { OAuthClient, type TokenResponse } from './oauth';
import { jsonRequest, RESOURCE, type Fetch } from './network';

const credentialsSchema = z.object({ accessToken: z.string().max(32768), refreshToken: z.string().max(32768).nullable(), idToken: z.string().max(32768).nullable(),
  expiresAt: z.number(), scope: z.string().max(1024) }).strict();
const profileSchema = z.object({ id: z.string().uuid(), clientId: z.string().max(256).nullable(), subject: z.string().max(512).nullable(), label: z.string().max(254), credentials: credentialsSchema.nullable() }).strict();
export const accountStateSchema = z.object({ version: z.literal(1), hostId: z.string().regex(/^urn:uuid:[0-9a-f-]{36}$/), selectedId: z.string().uuid().nullable(), profiles: z.array(profileSchema).max(20) }).strict()
  .refine(s => new Set(s.profiles.map(p => p.id)).size === s.profiles.length && (!s.selectedId || s.profiles.some(p => p.id === s.selectedId)));
export type AccountState = z.infer<typeof accountStateSchema>;
type Profile = z.infer<typeof profileSchema>;
export interface AccountStorage { load(fallback: AccountState): Promise<AccountState>; save(state: AccountState): Promise<void> }
function credentials(tokens: TokenResponse, now: number): NonNullable<Profile['credentials']> {
  return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token ?? null, idToken: tokens.id_token ?? null, expiresAt: now + tokens.expires_in * 1000, scope: tokens.scope };
}
export class AccountService {
  private state: AccountState = { version: 1, hostId: `urn:uuid:${randomUUID()}`, selectedId: null, profiles: [] };
  private generation = new Map<string, number>();
  private refreshing = new Map<string, Promise<string>>();
  private controllers = new Map<string, AbortController>();
  private signInController: AbortController | null = null;
  private persistence: Promise<void> = Promise.resolve();
  constructor(private readonly store: AccountStorage, private readonly oauth: OAuthClient, private readonly fetcher: Fetch = fetch, private readonly now = Date.now) {}
  async load(): Promise<void> { this.state = accountStateSchema.parse(await this.store.load(this.state)); await this.persist(); }
  private persist(): Promise<void> {
    const snapshot = structuredClone(this.state);
    const operation = this.persistence.then(() => this.store.save(snapshot));
    this.persistence = operation.catch(() => undefined); return operation;
  }
  views(): AccountView[] { return this.state.profiles.map(p => ({ id: p.id, label: p.label, connected: !!p.credentials, planEnabled: !!p.credentials?.scope.split(/\s+/).includes('chatgpt.tokens.use.direct'), selected: p.id === this.state.selectedId })); }
  selectedId(): string | null { return this.state.selectedId; }
  private profile(id: string): Profile { const p = this.state.profiles.find(p => p.id === id); if (!p) throw new AppError('unknown_account'); return p; }
  cancelSignIn(): void { this.signInController?.abort(); }
  shutdown(): void { this.cancelSignIn(); for (const controller of this.controllers.values()) controller.abort(); }
  async select(id: string): Promise<void> { this.profile(id); this.cancelSignIn(); this.state.selectedId = id; await this.persist(); }
  async signIn(id: string | null): Promise<void> {
    if (this.signInController) throw new AppError('sign_in_busy');
    if (!id && this.state.profiles.length >= 20) throw new AppError('account_limit');
    const controller = new AbortController(); this.signInController = controller;
    const p = id ? this.profile(id) : { id: randomUUID(), clientId: null, subject: null, label: 'New ChatGPT connection', credentials: null };
    const generation = this.generation.get(p.id) ?? 0;
    try {
      if (!id) { this.state.profiles.push(p); await this.persist(); checkAbort(controller.signal); }
      const result = await this.oauth.signIn({ clientId: p.clientId, hostId: this.state.hostId, subject: p.subject }, controller.signal, async clientId => {
        checkAbort(controller.signal); if ((this.generation.get(p.id) ?? 0) !== generation) throw new AppError('canceled');
        p.clientId = clientId; await this.persist();
      });
      if (controller.signal.aborted || (this.generation.get(p.id) ?? 0) !== generation) {
        if (result.tokens.refresh_token) await this.oauth.revoke(result.tokens.refresh_token, result.clientId, new AbortController().signal).catch(() => undefined);
        throw new AppError('canceled');
      }
      p.clientId = result.clientId; p.subject = result.subject; p.label = result.label; p.credentials = credentials(result.tokens, this.now());
      await this.persist(); checkAbort(controller.signal);
      this.state.selectedId = p.id; await this.persist();
    } finally { if (this.signInController === controller) this.signInController = null; }
  }
  async disconnect(id: string): Promise<boolean> {
    const p = this.profile(id), old = p.credentials;
    this.generation.set(id, (this.generation.get(id) ?? 0) + 1);
    this.cancelSignIn(); this.controllers.get(id)?.abort();
    p.credentials = null; await this.persist();
    if (!old?.refreshToken || !p.clientId) return false;
    try { return await this.oauth.revoke(old.refreshToken, p.clientId, new AbortController().signal); } catch { return false; }
  }
  async token(id: string, signal: AbortSignal): Promise<string> {
    checkAbort(signal);
    const p = this.profile(id);
    if (!p.credentials || !p.clientId) throw new AppError('reconnect');
    if (!p.credentials.scope.split(/\s+/).includes('chatgpt.tokens.use.direct')) throw new AppError('plan_permission');
    if (p.credentials.expiresAt > this.now() + 60000) return p.credentials.accessToken;
    let pending = this.refreshing.get(id);
    if (!pending) {
      const generation = this.generation.get(id) ?? 0, old = p.credentials;
      if (!old.refreshToken) throw new AppError('reconnect');
      const controller = new AbortController(); this.controllers.set(id, controller);
      pending = (async () => {
        try {
          const result = await this.oauth.refresh(p.clientId!, old.refreshToken!, controller.signal);
          if ((this.generation.get(id) ?? 0) !== generation || controller.signal.aborted) {
            if (result.refresh_token) await this.oauth.revoke(result.refresh_token, p.clientId, new AbortController().signal).catch(() => undefined);
            throw new AppError('canceled');
          }
          if (!result.refresh_token) throw new AppError('refresh_rotation');
          p.credentials = credentials(result, this.now()); await this.persist();
          if ((this.generation.get(id) ?? 0) !== generation || controller.signal.aborted) throw new AppError('canceled');
          if (!p.credentials.scope.split(/\s+/).includes('chatgpt.tokens.use.direct')) throw new AppError('plan_permission');
          return p.credentials.accessToken;
        } catch (e) {
          if ((this.generation.get(id) ?? 0) === generation && !(e instanceof AppError && e.code === 'canceled')) { p.credentials = null; await this.persist(); }
          throw e;
        } finally { this.refreshing.delete(id); this.controllers.delete(id); }
      })();
      this.refreshing.set(id, pending);
    }
    const result = await pending; checkAbort(signal); return result;
  }
  async models(id: string, signal: AbortSignal): Promise<ModelView[]> {
    const token = await this.token(id, signal);
    const data = z.object({ models: z.array(z.object({ visibility: z.string(), slug: z.string().min(1).max(100), display_name: z.string().max(200).optional() }).passthrough()).max(1000) }).passthrough()
      .parse(await jsonRequest(this.fetcher, `${RESOURCE}/models`, signal, { headers: { Authorization: `Bearer ${token}` } }));
    return data.models.filter(m => m.visibility === 'list').map(m => ({ slug: m.slug, displayName: m.display_name ?? m.slug }));
  }
}
