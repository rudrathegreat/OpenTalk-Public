import { createServer } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { jwtVerify, createLocalJWKSet, type JSONWebKeySet } from 'jose';
import { z } from 'zod';
import { AppError, checkAbort } from './errors';
import { AUTH, RESOURCE, authEndpoint, jsonRequest, type Fetch } from './network';

export const scopes = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const tokenSchema = z.object({ access_token: z.string().min(1).max(32768), refresh_token: z.string().min(1).max(32768).optional(),
  id_token: z.string().min(1).max(32768).optional(), expires_in: z.number().positive().max(86400), scope: z.string().max(1024),
  token_type: z.string().refine(v => v.toLowerCase() === 'bearer') }).passthrough();
export type TokenResponse = z.infer<typeof tokenSchema>;
export interface Registration { clientId: string | null; hostId: string; subject: string | null }
export interface Authorization { clientId: string; subject: string; label: string; tokens: TokenResponse }
export function equalState(a: unknown, b: string): boolean {
  if (typeof a !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export async function verifyIdentity(token: string, jwks: JSONWebKeySet, clientId: string, nonce: string, subject: string | null): Promise<{ subject: string; label: string }> {
  try {
    const { payload } = await jwtVerify(token, createLocalJWKSet(jwks), { issuer: AUTH, audience: clientId, algorithms: ['RS256', 'PS256', 'ES256'], requiredClaims: ['sub', 'exp', 'nonce'], clockTolerance: 0 });
    if (!equalState(payload.nonce, nonce) || !payload.sub || (subject && payload.sub !== subject) ||
      (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId) ||
      (payload.azp !== undefined && payload.azp !== clientId)) throw new AppError('identity_mismatch');
    const label = typeof payload.email === 'string' && payload.email.length <= 254 ? payload.email : 'ChatGPT connection';
    return { subject: payload.sub, label };
  } catch { throw new AppError('identity_invalid'); }
}
export interface Callback { code: string; clientId: string }
export function validateCallback(url: URL, state: string, clientId: string | null): Callback {
  if (!equalState(url.searchParams.get('state'), state)) throw new AppError('oauth_state');
  if (url.searchParams.has('error')) throw new AppError('oauth_denied');
  for (const key of ['code', 'state', 'client_id']) if (url.searchParams.getAll(key).length > 1) throw new AppError('oauth_duplicate');
  const code = url.searchParams.get('code'), issued = url.searchParams.get('client_id') ?? clientId;
  if (!code || code.length > 8192 || !issued || issued === 'dynamic_agent_client' || issued.length > 256 || (clientId && issued !== clientId)) throw new AppError('oauth_registration');
  return { code, clientId: issued };
}
export class OAuthClient {
  constructor(private readonly openBrowser: (url: string) => Promise<void>, private readonly fetcher: Fetch = fetch) {}
  async discover(signal: AbortSignal): Promise<{ jwksUri: string; revocation: string | null }> {
    const data = z.object({ issuer: z.literal(AUTH), jwks_uri: z.string(), revocation_endpoint: z.string().optional() }).passthrough()
      .parse(await jsonRequest(this.fetcher, `${AUTH}/.well-known/openid-configuration`, signal));
    return { jwksUri: authEndpoint(data.jwks_uri), revocation: data.revocation_endpoint ? authEndpoint(data.revocation_endpoint) : null };
  }
  async signIn(registration: Registration, signal: AbortSignal, saveRegistration: (clientId: string) => Promise<void>): Promise<Authorization> {
    checkAbort(signal);
    const discovery = await this.discover(signal);
    const state = randomBytes(32).toString('base64url'), nonce = randomBytes(32).toString('base64url'), verifier = randomBytes(48).toString('base64url');
    let received = false;
    let resolve!: (value: Callback) => void, reject!: (reason: unknown) => void;
    const callback = new Promise<Callback>((ok, fail) => { resolve = ok; reject = fail; });
    // Register a rejection handler before browser startup can fail.
    void callback.catch(() => undefined);
    const server = createServer({ maxHeaderSize: 16384 }, (req, res) => {
      res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
      if ((req.url?.length ?? 0) > 12288) { res.writeHead(413).end(); return; }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method !== 'GET' || url.pathname !== '/auth/callback') { res.writeHead(404).end(); return; }
      if (!equalState(url.searchParams.get('state'), state)) { res.writeHead(400).end('Invalid state.'); return; }
      if (received) { res.writeHead(409).end('Already consumed.'); return; }
      received = true;
      try { const result = validateCallback(url, state, registration.clientId); res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Return to OpenTalk to finish setup.'); resolve(result); }
      catch (e) { res.writeHead(400).end('Sign-in failed. Return to OpenTalk.'); reject(e); }
    });
    server.requestTimeout = 10000; server.headersTimeout = 10000;
    const abort = () => reject(new AppError('canceled'));
    signal.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => reject(new AppError('oauth_timeout')), 300000);
    let tokens: TokenResponse | undefined;
    let issuedClientId = registration.clientId;
    try {
      await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok); });
      checkAbort(signal);
      const address = server.address(); if (!address || typeof address === 'string') throw new AppError('oauth_listener');
      const redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
      const params = new URLSearchParams({ client_id: registration.clientId ?? 'dynamic_agent_client', ext_agent_host_id: registration.hostId,
        response_type: 'code', redirect_uri: redirectUri, scope: scopes, resource: RESOURCE, state, nonce,
        code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') });
      if (!registration.clientId) params.set('agent_name_hint', 'OpenTalk');
      await this.openBrowser(`${AUTH}/api/accounts/authorize?${params}`);
      const pending = await callback; issuedClientId = pending.clientId; checkAbort(signal); await saveRegistration(pending.clientId); checkAbort(signal);
      tokens = await this.token(new URLSearchParams({ grant_type: 'authorization_code', client_id: pending.clientId, code: pending.code,
        code_verifier: verifier, redirect_uri: redirectUri, resource: RESOURCE }), signal);
      if (!tokens.id_token) throw new AppError('identity_missing');
      const jwks = z.object({ keys: z.array(z.record(z.string(), z.unknown())).min(1).max(100) }).parse(await jsonRequest(this.fetcher, discovery.jwksUri, signal));
      const identity = await verifyIdentity(tokens.id_token, jwks as JSONWebKeySet, pending.clientId, nonce, registration.subject);
      checkAbort(signal);
      return { clientId: pending.clientId, ...identity, tokens };
    } catch (e) {
      if (tokens?.refresh_token) await this.revoke(tokens.refresh_token, issuedClientId, new AbortController().signal).catch(() => undefined);
      throw e;
    } finally { clearTimeout(timeout); signal.removeEventListener('abort', abort); server.closeAllConnections(); server.close(); }
  }
  async token(params: URLSearchParams, signal: AbortSignal): Promise<TokenResponse> {
    const parsed = tokenSchema.safeParse(await jsonRequest(this.fetcher, `${AUTH}/api/accounts/oauth/token`, signal,
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: params }));
    if (!parsed.success || (parsed.data.scope.split(/\s+/).includes('offline_access') && !parsed.data.refresh_token)) throw new AppError('oauth_token_payload');
    return parsed.data;
  }
  refresh(clientId: string, refreshToken: string, signal: AbortSignal): Promise<TokenResponse> {
    return this.token(new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken, resource: RESOURCE }), signal);
  }
  async revoke(refreshToken: string, clientId: string | null, signal: AbortSignal): Promise<boolean> {
    if (!clientId) return false;
    const { revocation } = await this.discover(signal); if (!revocation) return false;
    const response = await this.fetcher(revocation, { method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: refreshToken, token_type_hint: 'refresh_token', client_id: clientId }) });
    await response.body?.cancel(); return response.status === 200;
  }
}
