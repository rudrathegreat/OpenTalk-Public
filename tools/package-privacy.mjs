import { access, readdir, readFile } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import { extractFile, listPackage } from '@electron/asar';
import { createHash } from 'node:crypto';

const PRIVATE_FILE_NAMES = new Set([
  'accounts.enc',
  'history.enc',
  'settings.json',
  'preferences',
  'local state',
  'cookies',
]);
const PRIVATE_DIRECTORY_NAMES = new Set([
  'blob_storage',
  'cache',
  'code cache',
  'gpu cache',
  'local storage',
  'network',
  'session storage',
]);
const TEXT_EXTENSIONS = new Set(['.cjs', '.css', '.html', '.js', '.json', '.md', '.mjs', '.txt']);
export const EXPECTED_NATIVE_FILES = ['opentalk-helper.exe', 'opentalk-worker.exe', 'whisper-LICENSE.txt', 'moonshine.dll', 'onnxruntime.dll', 'moonshine-LICENSE.txt', 'onnxruntime-LICENSE.txt', 'onnxruntime-NOTICES.txt', 'msvcp140.dll', 'msvcp140_1.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'];
const REVIEWED_NOTICES = new Map([['onnxruntime-NOTICES.txt', 'e9e90971a8e75a9a8ac0c6412e29c1202d079998389915aa485f46c816c3b4cc']]);

function normalized(value) {
  return value.replaceAll('\\', '/').replace(/^\/+/, '');
}

function privatePathReason(value) {
  const parts = normalized(value).split('/').map(part => part.toLowerCase());
  const fileName = parts.at(-1) ?? '';
  if (PRIVATE_FILE_NAMES.has(fileName)) return `private profile file ${fileName}`;
  const privateDirectory = parts.find(part => PRIVATE_DIRECTORY_NAMES.has(part));
  return privateDirectory ? `private profile directory ${privateDirectory}` : null;
}

function buildMachineProfiles() {
  return [process.env.USERPROFILE, process.env.HOME]
    .filter(value => typeof value === 'string' && value.length >= 6);
}

function buildMachineMarkers() {
  return buildMachineProfiles().map(value => value.toLowerCase());
}

function assertNoPersonalText(value, label) {
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(value)) {
    throw new Error(`Privacy audit rejected an email address in ${label}.`);
  }
  if (/(?:[A-Z]:\\Users\\|\/Users\/|\/home\/)[^\s"']+/i.test(value)) {
    throw new Error(`Privacy audit rejected an absolute user-profile path in ${label}.`);
  }
  if (/\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/.test(value)) {
    throw new Error(`Privacy audit rejected a secret-looking API key in ${label}.`);
  }
  const lower = value.toLowerCase();
  if (buildMachineMarkers().some(marker => lower.includes(marker))) {
    throw new Error(`Privacy audit rejected a build-machine profile marker in ${label}.`);
  }
}

function assertNoBuildMachineMarker(value, label) {
  for (const profile of buildMachineProfiles()) {
    for (const marker of new Set([profile, profile.toLowerCase(), profile.toUpperCase()])) {
      if (value.indexOf(Buffer.from(marker, 'utf8')) !== -1 || value.indexOf(Buffer.from(marker, 'utf16le')) !== -1) {
        throw new Error(`Privacy audit rejected a build-machine profile marker in ${label}.`);
      }
    }
  }
}

async function filesUnder(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Privacy audit rejected symbolic link ${relative(root, path)}.`);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
      else throw new Error(`Privacy audit rejected non-file package input ${relative(root, path)}.`);
    }
  }
  await visit(root);
  return files;
}

async function assertCleanFile(path, label) {
  const reason = privatePathReason(label);
  if (reason) throw new Error(`Privacy audit rejected ${reason} at ${label}.`);
  const value = await readFile(path);
  assertNoBuildMachineMarker(value, label);
  // Upstream notices contain public contacts; exempt only the exact reviewed bytes.
  const reviewed = REVIEWED_NOTICES.get(label.split('/').at(-1)) === createHash('sha256').update(value).digest('hex');
  if (!reviewed && TEXT_EXTENSIONS.has(extname(path).toLowerCase())) assertNoPersonalText(value.toString('utf8'), label);
}

async function assertExpectedNativeDirectory(nativeRoot, strict) {
  const entries = await readdir(nativeRoot, { withFileTypes: true });
  const files = entries.filter(entry => entry.isFile()).map(entry => entry.name).sort();
  const unexpectedKinds = entries.filter(entry => !entry.isFile());
  const missing = EXPECTED_NATIVE_FILES.filter(file => !files.includes(file));
  if (missing.length > 0 || (strict && (unexpectedKinds.length > 0 || JSON.stringify(files) !== JSON.stringify([...EXPECTED_NATIVE_FILES].sort())))) {
    throw new Error('Privacy audit rejected unexpected packaged native resources.');
  }
  for (const file of EXPECTED_NATIVE_FILES) await assertCleanFile(join(nativeRoot, file), `native/${file}`);
}

async function assertLocalProfileBlobsAbsent(archive) {
  const appData = process.env.APPDATA;
  if (!appData) return;
  for (const name of ['accounts.enc', 'history.enc', 'settings.json', 'Preferences', 'Local State']) {
    let local;
    try { local = await readFile(join(appData, 'OpenTalk', name)); }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') continue;
      throw error;
    }
    if (local.length >= 16 && archive.indexOf(local) !== -1) {
      throw new Error(`Privacy audit rejected embedded local profile content from ${name}.`);
    }
  }
}

export async function auditBuildDirectories(distRoot, nativeRoot) {
  await access(distRoot);
  for (const path of await filesUnder(distRoot)) {
    await assertCleanFile(path, `dist/${normalized(relative(distRoot, path))}`);
  }
  await assertExpectedNativeDirectory(nativeRoot, false);
}

export async function auditPackageInputs() {
  await auditBuildDirectories(resolve('apps/desktop/dist'), resolve('native/bin'));
  await auditMoonshineModel(resolve('.tools/moonshine-small-streaming-en'));
  await auditMoonshineRuntime(resolve('native/bin'));
  console.log('Privacy audit passed for installer inputs.');
}

export async function auditPackagedApp(appOutDir) {
  const resources = join(appOutDir, 'resources');
  const archivePath = join(resources, 'app.asar');
  const rawEntries = listPackage(archivePath);
  const entries = rawEntries.map(normalized);
  for (const entry of entries) {
    const topLevel = entry.split('/')[0];
    if (!['dist', 'node_modules', 'package.json'].includes(topLevel)) {
      throw new Error(`Privacy audit rejected unexpected application payload ${entry}.`);
    }
    const reason = privatePathReason(entry);
    if (reason) throw new Error(`Privacy audit rejected ${reason} at ${entry}.`);
  }
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!/^(?:dist\/.*\.(?:cjs|css|html|js|json|md|mjs|txt)|package\.json)$/i.test(entry)) continue;
    const rawEntry = rawEntries[index];
    assertNoPersonalText(extractFile(archivePath, rawEntry.slice(1)).toString('utf8'), entry);
  }
  const archive = await readFile(archivePath);
  assertNoBuildMachineMarker(archive, 'app.asar');
  await assertLocalProfileBlobsAbsent(archive);
  await assertExpectedNativeDirectory(join(resources, 'native'), true);
  await auditMoonshineModel(join(resources, 'speech-models', 'moonshine-small-streaming-en'));
  await auditMoonshineRuntime(join(resources, 'native'));
  console.log('Privacy audit passed for packaged application payload.');
}

export async function auditMoonshineModel(root) {
  const manifest = JSON.parse(await readFile(new URL('../native/moonshine/manifest.json', import.meta.url), 'utf8'));
  const entries = await readdir(root, { withFileTypes: true });
  if (entries.some(entry => !entry.isFile() || entry.isSymbolicLink()) || JSON.stringify(entries.map(entry => entry.name).sort()) !== JSON.stringify(manifest.files.map(file => file.name).sort())) throw new Error('Unexpected bundled Moonshine model asset.');
  for (const file of manifest.files) {
    const data = await readFile(join(root, file.name));
    if (data.length !== file.bytes || createHash('sha256').update(data).digest('hex') !== file.sha256) throw new Error('Bundled Moonshine model checksum mismatch.');
    assertNoBuildMachineMarker(data, `speech-models/${file.name}`);
  }
}
async function auditMoonshineRuntime(root) {
  for (const [name, hash] of [
    ['moonshine.dll', '5785b084680b7cb335e95b2e99e9c243e4b15833a30b1add5a4598694f8b48aa'],
    ['onnxruntime.dll', 'dec964ab1ee36cc9b0ae247d13b376627992fc57dec0454354017ab8fd84f1ea'],
    ['moonshine-LICENSE.txt', '7b749ee9a1bc694b648b0cfa1f4fbfda49d8af14cbb76dedab6fb9f086edfa7a'],
    ['onnxruntime-LICENSE.txt', '2f07c72751aed99790b8a4869cf2311df85a860b22ded05fa22803587a48922c'],
    ['onnxruntime-NOTICES.txt', 'e9e90971a8e75a9a8ac0c6412e29c1202d079998389915aa485f46c816c3b4cc'],
  ]) {
    if (createHash('sha256').update(await readFile(join(root, name))).digest('hex') !== hash) throw new Error('Moonshine runtime checksum mismatch.');
  }
}
