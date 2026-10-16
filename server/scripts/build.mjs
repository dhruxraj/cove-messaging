// Bundle the server (TypeScript → one ESM file per entry). Dependencies stay external and are
// loaded from node_modules at runtime; SQL migrations are read from ../migrations.
import { build } from 'esbuild';
import fs from 'node:fs';

fs.rmSync(new URL('../dist', import.meta.url), { recursive: true, force: true });
await build({
  entryPoints: { index: 'src/index.ts', migrate: 'src/cli/migrate.ts' },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  sourcemap: true,
  legalComments: 'none',
  logLevel: 'info',
});
