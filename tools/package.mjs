import { build, Platform, Arch } from 'electron-builder';
import { access, readFile, mkdir, writeFile, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { auditPackageInputs, auditPackagedApp, EXPECTED_NATIVE_FILES } from './package-privacy.mjs';
const native = resolve('native/bin');
const icon = resolve('build/app-icon.png');
await access(icon);
for (const file of EXPECTED_NATIVE_FILES) await access(`${native}/${file}`);
await mkdir('apps/desktop/dist/notices', { recursive: true });
await copyFile('THIRD_PARTY_NOTICES.md', 'apps/desktop/dist/notices/THIRD_PARTY_NOTICES.md');
await auditPackageInputs();
const result = await build({ targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64), config: {
  appId: 'local.opentalk.desktop', productName: 'OpenTalk',
  directories: { app: 'apps/desktop', output: 'release' },
  files: ['dist/**/*', 'package.json'], asar: true,
  extraResources: [
    { from: native, to: 'native', filter: EXPECTED_NATIVE_FILES },
    { from: resolve('.tools/moonshine-small-streaming-en'), to: 'speech-models/moonshine-small-streaming-en', filter: ['*.ort', 'tokenizer.bin', 'streaming_config.json'] },
  ],
  afterPack: context => auditPackagedApp(context.appOutDir),
  win: { target: 'nsis', icon, requestedExecutionLevel: 'asInvoker' },
  nsis: { oneClick: false, perMachine: false, allowElevation: false, allowToChangeInstallationDirectory: false, deleteAppDataOnUninstall: false, createDesktopShortcut: false, createStartMenuShortcut: true, shortcutName: 'OpenTalk' },
  artifactName: 'OpenTalk-${version}-${arch}-setup.${ext}',
} });
await auditPackagedApp(resolve('release/win-unpacked'));
for (const file of result.filter(f => f.endsWith('.exe'))) {
  const hash = createHash('sha256').update(await readFile(file)).digest('hex'); await writeFile(`${file}.sha256`, `${hash}  ${file.split(/[\\/]/).at(-1)}\n`);
}
console.log('Unsigned OpenTalk preview installer created. Full Windows acceptance remains required.');
