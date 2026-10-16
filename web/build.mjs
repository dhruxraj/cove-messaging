// Build the web client with esbuild: one hashed JS bundle + CSS, an index.html that references
// them, and the static files from public/. `--watch` rebuilds on change with stable file names.
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, 'dist');
const watch = process.argv.includes('--watch');

function copyPublic() {
  fs.cpSync(path.join(root, 'public'), dist, { recursive: true });
}

function writeHtml(metafile) {
  const outputs = Object.keys(metafile.outputs).map((p) => '/' + path.relative(dist, path.join(root, p)).split(path.sep).join('/'));
  const js = outputs.find((p) => p.endsWith('.js') && !p.includes('/chunks/'));
  const css = outputs.find((p) => p.endsWith('.css'));
  const template = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const html = template
    .replace('<!--CSS-->', css ? `<link rel="stylesheet" href="${css}">` : '')
    .replace('<!--JS-->', `<script type="module" src="${js}"></script>`);
  fs.writeFileSync(path.join(dist, 'index.html'), html);
}

const options = {
  absWorkingDir: root,
  entryPoints: { app: 'src/main.tsx' },
  outdir: 'dist/assets',
  entryNames: watch ? '[name]' : '[name]-[hash]',
  chunkNames: 'chunks/[name]-[hash]',
  assetNames: '[name]-[hash]',
  bundle: true,
  format: 'esm',
  splitting: true,
  target: ['es2020', 'chrome100', 'firefox100', 'safari15'],
  jsx: 'automatic',
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  metafile: true,
  legalComments: 'none',
  define: { 'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production') },
  logLevel: 'info',
  plugins: [
    {
      name: 'html',
      setup(build) {
        build.onEnd((result) => {
          if (result.errors.length || !result.metafile) return;
          copyPublic();
          writeHtml(result.metafile);
        });
      },
    },
  ],
};

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });
if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('watching web/src …');
} else {
  await esbuild.build(options);
}
