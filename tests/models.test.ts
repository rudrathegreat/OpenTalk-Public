import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelManager } from '../packages/core/src/models';
import manifest from '../native/moonshine/manifest.json';
// Tiny synthetic trusted manifest, so these tests need neither network nor downloaded weights.
vi.mock('../native/moonshine/manifest.json', async () => {
  const { createHash } = await import('node:crypto');
  return { default: { id: 'moonshine-small-streaming-en', url: 'https://download.moonshine.ai/model/synthetic-test', files: ['encoder.ort', 'tokenizer.bin'].map(name => ({ name, bytes: Buffer.byteLength(name), sha256: createHash('sha256').update(name).digest('hex') })) } };
});
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'opentalk-model-')); roots.push(root);
  const source = join(root, 'bundle'), models = join(root, 'models'); await mkdir(source);
  for (const file of manifest.files) await writeFile(join(source, file.name), file.name);
  return { source, models, manager: new ModelManager(models) };
}
describe('Moonshine verified multi-file installation', () => {
  it('installs bundled files without network and verifies every asset before readiness', async () => {
    const { source, models } = await fixture(); const network = vi.fn(); const manager = new ModelManager(models, network);
    expect(await manager.ready('moonshine-small-streaming-en')).toBe(false);
    await manager.installBundledMoonshine(source);
    expect(await manager.ready('moonshine-small-streaming-en')).toBe(true); expect(network).not.toHaveBeenCalled();
    await writeFile(join(manager.path('moonshine-small-streaming-en'), 'encoder.ort'), 'corruption');
    expect(await manager.ready('moonshine-small-streaming-en')).toBe(false);
  });
  it('rejects a corrupt bundle atomically and removes incomplete staging assets', async () => {
    const { source, models, manager } = await fixture(); await writeFile(join(source, 'tokenizer.bin'), 'wrong');
    await expect(manager.installBundledMoonshine(source)).rejects.toMatchObject({ code: 'download_checksum' });
    expect(await manager.ready('moonshine-small-streaming-en')).toBe(false); expect(await readdir(models)).toEqual([]);
  });
  it('repairs an invalid existing bundle without deleting its contents', async () => {
    const { source, models, manager } = await fixture(); const old = manager.path('moonshine-small-streaming-en'); await mkdir(old, { recursive: true }); await writeFile(join(old, 'unrecognized.txt'), 'preserve');
    await manager.installBundledMoonshine(source); expect(await manager.ready('moonshine-small-streaming-en')).toBe(true);
    const backup = (await readdir(models)).find(name => name.includes('.invalid-')); expect(backup).toBeDefined();
    expect(await readFile(join(models, backup!, 'unrecognized.txt'), 'utf8')).toBe('preserve');
  });
  it('downloads only pinned HTTPS assets and reports aggregate progress', async () => {
    const { models } = await fixture();
    const network = vi.fn(async (input: string | URL | Request, options?: RequestInit) => { expect(String(input)).toMatch(/^https:\/\/download\.moonshine\.ai\/model\/synthetic-test\//); expect(options?.redirect).toBe('error'); return new Response(String(input).split('/').at(-1)!); });
    const manager = new ModelManager(models, network), progress = vi.fn();
    await manager.download('moonshine-small-streaming-en', new AbortController().signal, progress);
    expect(network).toHaveBeenCalledTimes(2); expect(await manager.ready('moonshine-small-streaming-en')).toBe(true);
    const total = manifest.files.reduce((sum, file) => sum + file.bytes, 0); expect(progress).toHaveBeenLastCalledWith(total, total);
  });
  it('rejects wrong hashes, excess size, HTTP failures and cancellation without installing a partial model', async () => {
    for (const response of [() => new Response('x'.repeat(11)), () => new Response('x'.repeat(100)), () => new Response(null, { status: 503 })]) {
      const { models } = await fixture(); const manager = new ModelManager(models, async () => response());
      await expect(manager.download('moonshine-small-streaming-en', new AbortController().signal, () => undefined)).rejects.toThrow();
      expect(await manager.ready('moonshine-small-streaming-en')).toBe(false); expect(await readdir(models)).toEqual([]);
    }
    const { models } = await fixture(), controller = new AbortController();
    const manager = new ModelManager(models, async () => { controller.abort(); return new Response('encoder.ort'); });
    await expect(manager.download('moonshine-small-streaming-en', controller.signal, () => undefined)).rejects.toThrow();
    expect(await manager.ready('moonshine-small-streaming-en')).toBe(false); expect(await readdir(models)).toEqual([]);
  });
  it('retains the original Whisper model paths', async () => {
    const { manager } = await fixture(); expect(manager.path('base.en')).toMatch(/ggml-base\.en\.bin$/); expect(manager.path('small.en')).toMatch(/ggml-small\.en\.bin$/);
  });
});
