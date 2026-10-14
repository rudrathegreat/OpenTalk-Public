import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, open, rename, rmdir, statfs, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import manifest from '../../../native/moonshine/manifest.json';
import { AppError, checkAbort } from './errors';
import type { Fetch } from './network';
export const moonshineBytes = manifest.files.reduce((sum, file) => sum + file.bytes, 0);
type Asset = (typeof manifest.files)[number];
async function verified(path: string, spec: Asset): Promise<boolean> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== spec.bytes) return false;
  const hash = createHash('sha256');
  for await (const block of createReadStream(path)) hash.update(block as Buffer);
  return hash.digest('hex') === spec.sha256;
}
export class MoonshineModel {
  constructor(private readonly directory: string, private readonly fetcher: Fetch = fetch) {}
  private path(): string { return join(this.directory, manifest.id); }
  async ready(): Promise<boolean> {
    try {
      const info = await lstat(this.path());
      if (!info.isDirectory() || info.isSymbolicLink()) return false;
      for (const file of manifest.files) if (!await verified(join(this.path(), file.name), file)) return false;
      return true;
    } catch { return false; }
  }
  private async install(populate: (stage: string) => Promise<void>, signal?: AbortSignal): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const info = await statfs(this.directory);
    if (info.bavail * info.bsize < moonshineBytes + 256 * 1024 * 1024) throw new AppError('disk_headroom');
    const stage = join(this.directory, `.moonshine-${randomUUID()}.partial`);
    await mkdir(stage, { mode: 0o700 });
    try {
      await populate(stage);
      for (const file of manifest.files) if (!await verified(join(stage, file.name), file)) throw new AppError('download_checksum');
      if (signal) checkAbort(signal);
      // Retain invalid previous data for recovery; never recursively delete an unknown directory.
      try { await lstat(this.path()); await rename(this.path(), `${this.path()}.invalid-${randomUUID()}`); }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
      await rename(stage, this.path());
    } finally {
      for (const file of manifest.files) await unlink(join(stage, file.name)).catch(() => undefined);
      await rmdir(stage).catch(() => undefined);
    }
  }
  async installBundled(source: string): Promise<void> {
    if (await this.ready()) return;
    const info = await lstat(source);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new AppError('model_path');
    await this.install(async stage => {
      for (const file of manifest.files) {
        const path = join(source, file.name), entry = await lstat(path);
        if (!entry.isFile() || entry.isSymbolicLink()) throw new AppError('model_path');
        await copyFile(path, join(stage, file.name));
      }
    });
  }
  async download(signal: AbortSignal, progress: (bytes: number, total: number) => void): Promise<void> {
    checkAbort(signal);
    if (await this.ready()) return;
    await this.install(async stage => {
      let completed = 0;
      for (const asset of manifest.files) {
        checkAbort(signal);
        const response = await this.fetcher(`${manifest.url}/${asset.name}`, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(30 * 60 * 1000)]) });
        if (!response.ok || !response.body) throw new AppError('download_http');
        const reader = response.body.getReader(), output = await open(join(stage, asset.name), 'wx', 0o600);
        let bytes = 0;
        try {
          for (;;) {
            checkAbort(signal);
            const block = await reader.read(); if (block.done) break;
            bytes += block.value.length; if (bytes > asset.bytes) throw new AppError('download_size');
            await output.writeFile(block.value); progress(completed + bytes, moonshineBytes);
          }
          if (bytes !== asset.bytes) throw new AppError('download_checksum');
          await output.sync();
        } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); await output.close(); }
        if (!await verified(join(stage, asset.name), asset)) throw new AppError('download_checksum');
        completed += bytes;
      }
    }, signal);
  }
}
