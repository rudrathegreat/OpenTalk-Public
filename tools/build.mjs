import { build as bundle } from 'esbuild';
import { build as ui } from 'vite';
import { copyFile } from 'node:fs/promises';
await ui({ root: 'apps/desktop/renderer', base: './', build: { outDir: '../dist/ui', emptyOutDir: true } });
await copyFile('build/app-icon.png', 'apps/desktop/dist/app-icon.png');
await bundle({ entryPoints: ['apps/desktop/main/index.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron'], outfile: 'apps/desktop/dist/main.cjs' });
await bundle({ entryPoints: ['apps/desktop/preload/index.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: 'apps/desktop/dist/preload.cjs' });
