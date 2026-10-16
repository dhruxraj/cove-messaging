#!/usr/bin/env node
// Local development: rebuilds the web client on change, runs the API server with reload, and starts
// the development mailbox that prints sign-in emails to this terminal (instead of sending them).
//
//   cp .env.example .env   # once; the defaults work for local development
//   npm run dev            # then open http://localhost:8080
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Minimal .env reader (KEY=value lines, # comments, optional quotes). Existing env vars win. */
function loadEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

const env = {
  APP_ORIGIN: 'http://localhost:8080',
  SMTP_HOST: '127.0.0.1',
  SMTP_PORT: '1025',
  MAIL_FROM: 'Cove <no-reply@localhost>',
  STORAGE_DIR: path.join(root, 'server/data/storage'),
  WEB_DIST_DIR: path.join(root, 'web/dist'),
  ...loadEnv(path.join(root, '.env')),
  ...process.env,
  NODE_ENV: 'development',
};

const colors = { web: 36, api: 35, mail: 33 };
const children = [];
function run(name, cmd, args, cwd) {
  const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const prefix = `\x1b[${colors[name]}m${name.padEnd(4)}\x1b[0m │ `;
  const pipe = (stream, out) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) out.write(prefix + l + '\n');
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => {
    if (!shuttingDown) {
      console.error(`${prefix}exited with ${code}; stopping`);
      shutdown(code ?? 1);
    }
  });
  children.push(child);
}

let shuttingDown = false;
function shutdown(code = 0) {
  shuttingDown = true;
  for (const c of children) c.kill('SIGTERM');
  setTimeout(() => process.exit(code), 300);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

if (env.SMTP_HOST === '127.0.0.1' && env.SMTP_PORT === '1025') run('mail', process.execPath, ['scripts/dev-mailbox.mjs'], root);
run('web', process.execPath, ['build.mjs', '--watch'], path.join(root, 'web'));
// Give the first web build a moment so the server finds index.html.
setTimeout(() => run('api', 'npx', ['tsx', 'watch', '--clear-screen=false', 'src/index.ts'], path.join(root, 'server')), 800);
console.log(`\nCove dev: ${env.APP_ORIGIN}  (sign-in codes appear in the "mail" lines below)\n`);
