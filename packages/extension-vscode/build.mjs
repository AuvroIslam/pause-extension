// Bundle the VS Code extension host into a single CommonJS file (vscode requires CJS).
import * as esbuild from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: [resolve(__dirname, 'src/extension.ts')],
  outfile: resolve(__dirname, 'dist/extension.js'),
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: ['node18'],
  external: ['vscode'], // provided by the VS Code runtime
  sourcemap: true,
  logLevel: 'info',
  minify: !watch,
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('[pause-vscode] watching…');
} else {
  await esbuild.build(options);
  console.log('[pause-vscode] built → dist/extension.js');
}
