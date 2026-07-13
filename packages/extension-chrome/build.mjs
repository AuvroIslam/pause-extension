// Build the Pause Chrome extension: bundle content + background scripts with esbuild,
// then copy manifest, icons, and static pages into dist/.
import * as esbuild from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = __dirname;
const dist = resolve(root, 'dist');
const watch = process.argv.includes('--watch');

const entryPoints = {
  content: resolve(root, 'src/content.ts'),
  background: resolve(root, 'src/background.ts'),
  options: resolve(root, 'src/options.ts'),
};

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints,
  outdir: dist,
  bundle: true,
  format: 'iife', // content scripts + MV3 workers run as classic scripts
  target: ['chrome110'],
  platform: 'browser',
  logLevel: 'info',
  sourcemap: watch ? 'inline' : false,
  minify: !watch,
};

async function copyStatic() {
  await cp(resolve(root, 'manifest.json'), resolve(dist, 'manifest.json'));
  await cp(resolve(root, 'icons'), resolve(dist, 'icons'), { recursive: true });
  await cp(resolve(root, 'src/options.html'), resolve(dist, 'options.html'));
}

async function run() {
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });

  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    await copyStatic();
    console.log('[pause] watching for changes…');
  } else {
    await esbuild.build(options);
    await copyStatic();
    console.log('[pause] built → dist/');
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
