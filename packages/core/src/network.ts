import { AppError } from './errors';
export type Fetch = typeof fetch;
export const AUTH = 'https://auth.openai.com';
export const RESOURCE = 'https://api.openai.com/v1';
export function authEndpoint(input: unknown): string {
  if (typeof input !== 'string') throw new AppError('identity_endpoint');
  const url = new URL(input);
  if (url.origin !== AUTH || url.username || url.password || url.hash) throw new AppError('identity_endpoint');
  return url.href;
}
export async function readBounded(body: ReadableStream<Uint8Array> | null, limit: number): Promise<string> {
  if (!body) throw new AppError('empty_body');
  const reader = body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let text = '', bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.length; if (bytes > limit) throw new AppError('provider_size');
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
export async function jsonRequest(fetcher: Fetch, url: string, signal: AbortSignal, options: RequestInit = {}): Promise<unknown> {
  const response = await fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(25000)]) });
  if (!response.ok) { await response.body?.cancel(); throw new AppError(response.status === 401 ? 'reconnect' : 'provider_http'); }
  try { return JSON.parse(await readBounded(response.body, 1024 * 1024)) as unknown; }
  catch (e) { if (e instanceof AppError) throw e; throw new AppError('provider_payload'); }
}
