/**
 * End-to-end harness: the real server (built web client, Postgres, private storage, SMTP) plus
 * Chromium driven by Playwright. Emails go to an in-process SMTP sink so tests can read the codes.
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { createApp, type AppInstance } from '../server/src/app';
import { loadConfig } from '../server/src/config';
import { configureLogger } from '../server/src/lib/log';
import { SmtpSink } from '../server/test/helpers/smtp-sink';

const here = path.dirname(fileURLToPath(import.meta.url));
export const E2E_DB = process.env.E2E_DATABASE_URL ?? 'postgres://postgres:devpassword@127.0.0.1:5432/cove_e2e';
export const SHOTS = process.env.E2E_SCREENSHOTS ?? path.join(here, 'screenshots');

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

export interface Stack {
  origin: string;
  sink: SmtpSink;
  inst: AppInstance;
  browser: Browser;
  storageDir: string;
  close(): Promise<void>;
}

export async function startStack(env: Record<string, string> = {}): Promise<Stack> {
  configureLogger({ level: 'error', silent: !process.env.TEST_LOGS });
  const dist = path.join(here, '../web/dist');
  if (!fs.existsSync(path.join(dist, 'index.html'))) throw new Error('Build the web client first: npm run build -w web');
  const client = new pg.Client({ connectionString: E2E_DB });
  await client.connect();
  await client.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  await client.end();
  const sink = await new SmtpSink().start();
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cove-e2e-'));
  const cfg = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: E2E_DB,
    APP_ORIGIN: origin,
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(sink.port),
    STORAGE_DIR: storageDir,
    WEB_DIST_DIR: dist,
    OTP_RESEND_COOLDOWN_SECONDS: '0',
    OTP_MAX_PER_HOUR: '100',
    OTP_MAX_FAILURES_PER_HOUR: '1000',
    // Every browser in the suite signs in from 127.0.0.1; lift the per-network limits for tests.
    OTP_IP_MAX_PER_HOUR: '10000',
    OTP_VERIFY_IP_MAX_PER_15MIN: '10000',
    CLEANUP_INTERVAL_SECONDS: '3600',
    LOG_LEVEL: 'error',
    ...env,
  });
  const inst = await createApp(cfg);
  await inst.listen(port, '127.0.0.1');
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  fs.mkdirSync(SHOTS, { recursive: true });
  return {
    origin,
    sink,
    inst,
    browser,
    storageDir,
    async close() {
      await browser.close();
      await inst.close();
      await sink.stop();
      fs.rmSync(storageDir, { recursive: true, force: true });
    },
  };
}

export interface User {
  ctx: BrowserContext;
  page: Page;
  email: string;
  username: string;
  displayName: string;
  recoveryKey: string;
}

let n = 0;
export async function newContext(stack: Stack, opts: { mobile?: boolean } = {}) {
  const ctx = await stack.browser.newContext(
    opts.mobile
      ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, permissions: ['microphone'] }
      : { viewport: { width: 1280, height: 820 }, permissions: ['microphone', 'clipboard-read', 'clipboard-write'] },
  );
  return ctx;
}

/** Read the newest 6-digit code mailed to `email` after `since`. */
export async function codeFor(stack: Stack, email: string, since: number) {
  const mail = await stack.sink.next(email, since, 8000);
  const code = SmtpSink.codeIn(mail);
  if (!code) throw new Error(`no code in mail to ${email}: ${mail.subject}`);
  return { code, mail };
}

export async function enterCode(page: Page, code: string) {
  await page.getByLabel('Digit 1').fill(code);
}

/** Register through the UI: email → code → profile → encryption keys. */
export async function registerUser(stack: Stack, name: string, opts: { mobile?: boolean; shots?: string } = {}): Promise<User> {
  const ctx = await newContext(stack, opts);
  const page = await ctx.newPage();
  const username = `${name.toLowerCase()}_${(++n).toString(36)}${Date.now().toString(36).slice(-3)}`;
  const email = `${username.replace(/_/g, '.')}@gmail.com`;
  const shot = async (label: string) => opts.shots && (await page.screenshot({ path: path.join(SHOTS, `${opts.shots}-${label}.png`) }));

  await page.goto(stack.origin + '/register');
  await page.getByLabel('Email').fill(email);
  await shot('01-register');
  const since = Date.now() - 5;
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByText('Check your email').waitFor();
  const { code } = await codeFor(stack, email, since);
  await shot('02-code');
  await enterCode(page, code);

  await page.getByRole('heading', { name: 'Set up your profile' }).waitFor();
  await page.getByLabel('Display name').fill(name);
  await page.getByLabel('Username').fill(username);
  await page.getByText(`@${username} is available`).waitFor();
  await shot('03-profile');
  await page.getByRole('button', { name: 'Continue' }).click();

  await page.getByRole('heading', { name: 'Protect your messages' }).waitFor();
  await shot('04-encryption');
  await page.getByRole('button', { name: 'Create my keys' }).click();
  const recoveryKey = (await page.getByLabel('Recovery key', { exact: true }).getAttribute('data-key'))!;
  await shot('05-recovery-key');
  await page.getByLabel('Type the last 4 characters to confirm you saved it').fill(recoveryKey.slice(-4));
  await page.getByRole('button', { name: 'Finish setup' }).click();
  await page.locator('.rail').waitFor();
  await shot('06-home');
  return { ctx, page, email, username, displayName: name, recoveryKey };
}

/** Open (or create) the chat between `a` and `b` from a's side, through the UI. */
export async function startChat(a: User, b: User) {
  await a.page.getByTestId('new-chat').click();
  await a.page.getByLabel('Username').fill(b.username);
  await a.page.getByTestId(`user-result-${b.username}`).click();
  await a.page.getByTestId('start-chat').click();
}

export async function openChat(u: User, other: User) {
  await u.page.getByTestId(`conversation-${other.username}`).first().click();
  await u.page.locator('.chat').waitFor();
}

/** Type and send a message. Desktop presses Enter; touch devices tap Send (Enter adds a new line there). */
export async function sendText(u: User, text: string, opts: { useButton?: boolean } = {}) {
  const box = u.page.getByRole('textbox', { name: 'Message' });
  await box.fill(text);
  const touch = await u.page.evaluate(() => matchMedia('(hover: none) and (pointer: coarse)').matches);
  if (touch || opts.useButton) await u.page.getByRole('button', { name: 'Send', exact: true }).click();
  else await box.press('Enter');
}

/** Messages whose own text (not a quoted reply) contains `text`. */
export const bubble = (u: User, text: string) => u.page.locator('[data-testid="message"]').filter({ has: u.page.locator('.bubble__text', { hasText: text }) });
