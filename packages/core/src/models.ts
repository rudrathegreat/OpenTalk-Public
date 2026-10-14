import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, stat, statfs, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError, checkAbort } from './errors';
import type { Fetch } from './network';
import { MoonshineModel, moonshineBytes } from './moonshine-model';
const revision = '5359861c739e955e79d9a303bcbc70fb988958b1';
export const modelManifest = {
  'base.en': { bytes: 147964211, sha256: 'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002' },
  'small.en': { bytes: 487614201, sha256: 'c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d' },
  'moonshine-small-streaming-en': { bytes: moonshineBytes },
} as const;
type Model = keyof typeof modelManifest;
export async function digest(file: string): Promise<string> { const hash = createHash('sha256'); for await (const block of createReadStream(file)) hash.update(block as Buffer); return hash.digest('hex'); }
export class ModelManager {
  constructor(private readonly directory: string, private readonly fetcher: Fetch = fetch) {}
  path(model: Model): string { return join(this.directory, model === 'moonshine-small-streaming-en' ? model : `ggml-${model}.bin`); }
  async installBundledMoonshine(source: string): Promise<void> { await new MoonshineModel(this.directory, this.fetcher).installBundled(source); }
  async ready(model: Model): Promise<boolean> {
    if (model === 'moonshine-small-streaming-en') return new MoonshineModel(this.directory, this.fetcher).ready();
    try { return (await stat(this.path(model))).size === modelManifest[model].bytes && await digest(this.path(model)) === modelManifest[model].sha256; } catch { return false; }
  }
  async download(model: Model, signal: AbortSignal, progress: (bytes: number, total: number) => void): Promise<void> {
    if (model === 'moonshine-small-streaming-en') return new MoonshineModel(this.directory, this.fetcher).download(signal, progress);
    checkAbort(signal); await mkdir(this.directory, { recursive: true });
    if (await this.ready(model)) return;
    const spec = modelManifest[model], info = await statfs(this.directory);
    if (info.bavail * info.bsize < spec.bytes + 256 * 1024 * 1024) throw new AppError('disk_headroom');
    const temporary = `${this.path(model)}.partial`; await unlink(temporary).catch(() => undefined);
    let url = `https://huggingface.co/ggerganov/whisper.cpp/resolve/${revision}/ggml-${model}.bin`;
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(30 * 60 * 1000)]);
    let response: Response | null = null;
    for (let i = 0; i < 6; i++) {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !(parsed.hostname === 'huggingface.co' || parsed.hostname.endsWith('.hf.co'))) throw new AppError('download_origin');
      response = await this.fetcher(url, { redirect: 'manual', signal: requestSignal });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const next = response.headers.get('location'); await response.body?.cancel(); if (!next) throw new AppError('download_redirect'); url = new URL(next, url).href; continue;
      }
      break;
    }
    if (!response?.ok || !response.body) throw new AppError('download_http');
    const reader = response.body.getReader(), hash = createHash('sha256'); let bytes = 0;
    const file = await open(temporary, 'wx', 0o600);
    try {
      for (;;) {
        checkAbort(requestSignal); const { done, value } = await reader.read(); if (done) break;
        bytes += value.length; if (bytes > spec.bytes) throw new AppError('download_size');
        hash.update(value); await file.writeFile(value); progress(bytes, spec.bytes);
      }
      if (bytes !== spec.bytes || hash.digest('hex') !== spec.sha256) throw new AppError('download_checksum');
      await file.sync(); await file.close(); checkAbort(requestSignal); await rename(temporary, this.path(model));
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); await file.close().catch(() => undefined); await unlink(temporary).catch(() => undefined); }
  }
}
