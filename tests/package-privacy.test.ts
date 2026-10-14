import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPackage } from '@electron/asar';
import { afterEach, describe, expect, it } from 'vitest';
import { auditBuildDirectories, auditPackagedApp, auditMoonshineModel, EXPECTED_NATIVE_FILES } from '../tools/package-privacy.mjs';
import manifest from '../native/moonshine/manifest.json';

const nativeFiles = EXPECTED_NATIVE_FILES;
const temporaryRoots: string[] = [];

async function temporary(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function nativeDirectory(root: string): Promise<string> {
  const native = join(root, 'native');
  await mkdir(native, { recursive: true });
  await Promise.all(nativeFiles.map(name => writeFile(join(native, name), `synthetic ${name}`)));
  return native;
}

describe('installer privacy audit', () => {
  it('does not exempt altered native third-party notices from personal-data checks', async () => {
    const root = await temporary('opentalk-notice-private-'); const dist = join(root, 'dist'); await mkdir(dist);
    const native = await nativeDirectory(root);
    await writeFile(join(native, 'onnxruntime-NOTICES.txt'), 'private@example.com');
    await expect(auditBuildDirectories(dist, native)).rejects.toThrow(/email address/i);
  });
  it('rejects unexpected and corrupted bundled Moonshine model assets', async () => {
    const root = await temporary('opentalk-model-package-'); await writeFile(join(root, 'accounts.enc'), 'not a model');
    await expect(auditMoonshineModel(root)).rejects.toThrow(/unexpected/i);
    await rm(join(root, 'accounts.enc'));
    for (const file of manifest.files) await writeFile(join(root, file.name), 'synthetic corruption');
    await expect(auditMoonshineModel(root)).rejects.toThrow(/checksum mismatch/i);
  });
  it('accepts a synthetic package containing only public application inputs', async () => {
    const root = await temporary('opentalk-package-clean-');
    const dist = join(root, 'dist');
    await mkdir(dist);
    await writeFile(join(dist, 'main.cjs'), 'console.log("OpenTalk");');
    await expect(auditBuildDirectories(dist, await nativeDirectory(root))).resolves.toBeUndefined();
  });

  it('rejects profile state and personal identifiers in build inputs', async () => {
    const root = await temporary('opentalk-package-private-');
    const native = await nativeDirectory(root);
    const stateDist = join(root, 'state-dist');
    await mkdir(stateDist);
    await writeFile(join(stateDist, 'accounts.enc'), 'synthetic private state');
    await expect(auditBuildDirectories(stateDist, native)).rejects.toThrow(/private profile file/i);
    const identityDist = join(root, 'identity-dist');
    await mkdir(identityDist);
    await writeFile(join(identityDist, 'main.js'), 'const owner = "private@example.com";');
    await expect(auditBuildDirectories(identityDist, native)).rejects.toThrow(/email address/i);
  });

  it('rejects unexpected files from the final application archive', async () => {
    const root = await temporary('opentalk-package-asar-');
    const source = join(root, 'source');
    const dist = join(source, 'dist');
    const appOut = join(root, 'app');
    const resources = join(appOut, 'resources');
    await mkdir(dist, { recursive: true });
    await mkdir(resources, { recursive: true });
    await writeFile(join(source, 'package.json'), '{"name":"opentalk-test"}');
    await writeFile(join(dist, 'main.cjs'), 'console.log("OpenTalk");');
    await writeFile(join(source, 'accounts.enc'), 'synthetic private state');
    await createPackage(source, join(resources, 'app.asar'));
    const native = await nativeDirectory(resources);
    expect(native).toBe(join(resources, 'native'));
    await expect(auditPackagedApp(appOut)).rejects.toThrow(/unexpected application payload|private profile file/i);
  });
});
