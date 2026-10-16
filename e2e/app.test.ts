/**
 * Browser end-to-end tests: real server, real Postgres, real SMTP (captured), real Chromium.
 * Every feature is exercised by at least two independent accounts in separate browser contexts.
 *
 *   npm run build -w web && npm run test:e2e
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Page } from 'playwright';
import { csrfTokenFor } from '../server/src/auth/sessions';
import * as fx from '../server/test/helpers/fixtures';
import { Client, type Harness } from '../server/test/helpers/harness';
import { bubble, codeFor, enterCode, newContext, registerUser, sendText, SHOTS, startStack, type Stack, type User } from './harness';

let stack: Stack;
before(async () => {
  stack = await startStack();
});
after(async () => {
  await stack?.close();
});

const shot = (p: Page, name: string) => p.screenshot({ path: path.join(SHOTS, `e2e-${name}.png`) });

async function fixtureFile(name: string, data: Buffer | Promise<Buffer>) {
  const p = path.join(stack.storageDir, name);
  fs.writeFileSync(p, await data);
  return p;
}

/** a asks to chat with b (b only accepts requests by default); b accepts; both end up in the chat. */
async function connect(a: User, b: User, note?: string) {
  await a.page.getByTestId('new-chat').click();
  await a.page.getByLabel('Username').fill(b.username);
  await a.page.getByTestId(`user-result-${b.username}`).click();
  if (note) await a.page.getByLabel('Say hello (optional)').fill(note);
  await a.page.getByTestId('start-chat').click();
  await a.page.getByText('Message request sent').waitFor();
  await b.page.getByRole('tab', { name: /Requests/ }).click();
  await b.page.getByTestId(`request-${a.username}`).getByRole('button', { name: 'Accept' }).click();
  await b.page.locator('.chat').waitFor();
  await a.page.getByTestId(`conversation-${b.username}`).click();
  await a.page.locator('.chat').waitFor();
}

async function openMenu(u: User, text: string) {
  const msg = bubble(u, text).last();
  await msg.hover();
  await msg.getByRole('button', { name: 'Message options' }).click();
}

/** Sign in with email + code in a fresh browser context; returns the page at whatever screen follows. */
async function signInFresh(u: User, mobile = false) {
  const ctx = await newContext(stack, { mobile });
  const page = await ctx.newPage();
  await page.goto(stack.origin + '/login');
  await page.getByLabel('Email').fill(u.email);
  const since = Date.now() - 5;
  await page.getByRole('button', { name: 'Send code' }).click();
  const { code } = await codeFor(stack, u.email, since);
  await enterCode(page, code);
  return { ctx, page };
}

describe('registration and sign-in', () => {
  it('rejects non-Gmail addresses and wrong codes with clear messages', async () => {
    const ctx = await newContext(stack);
    const page = await ctx.newPage();
    await page.goto(stack.origin + '/register');
    await page.getByLabel('Email').fill('someone@yahoo.com');
    await page.getByRole('button', { name: 'Send code' }).click();
    await page.getByText('Only @gmail.com addresses can be used.').waitFor();
    await page.getByLabel('Email').fill('not-an-email');
    await page.getByRole('button', { name: 'Send code' }).click();
    await page.getByText('Enter a valid email address.').waitFor();

    const email = `wrong.code.${Date.now()}@gmail.com`;
    await page.getByLabel('Email').fill(email);
    const since = Date.now() - 5;
    await page.getByRole('button', { name: 'Send code' }).click();
    const { code } = await codeFor(stack, email, since);
    const wrong = code === '000000' ? '111111' : '000000';
    await enterCode(page, wrong);
    await page.getByText(/That code is incorrect\. 4 attempts left\./).waitFor();
    await shot(page, 'wrong-code');
    await enterCode(page, code);
    await page.getByRole('heading', { name: 'Set up your profile' }).waitFor();
    await ctx.close();
  });

  it('a new sign-in ends the previous session; the recovery key unlocks history on the new device', async () => {
    const a = await registerUser(stack, 'Rhea');
    const b = await registerUser(stack, 'Kabir');
    await connect(a, b);
    await sendText(a, 'remember the lighthouse');
    await bubble(b, 'remember the lighthouse').waitFor();

    // Kabir signs in on another device.
    const { ctx, page } = await signInFresh(b, true);
    await page.getByRole('heading', { name: 'Unlock your messages' }).waitFor();
    // The old device is signed out immediately and told why.
    await b.page.getByText('You signed in on another device, so this session was ended.').waitFor();
    await shot(b.page, 'session-replaced');
    // A security email was sent.
    const mail = await stack.sink.next(b.email, Date.now() - 10_000);
    assert.ok(mail);

    // A wrong recovery key is refused; the right one restores the keys.
    await page.getByLabel('Recovery key').fill('AAAA-BBBB-CCCC-DDDD-EEEE-FFFF');
    await page.getByRole('button', { name: 'Unlock' }).click();
    await page.getByText("That recovery key doesn't match this account.").waitFor();
    await page.getByLabel('Recovery key').fill(b.recoveryKey.toLowerCase().replace(/-/g, ' '));
    await page.getByRole('button', { name: 'Unlock' }).click();
    await page.locator('.rail').waitFor();
    await page.getByTestId(`conversation-${a.username}`).click();
    await page.locator('[data-testid="message"]', { hasText: 'remember the lighthouse' }).waitFor();
    await shot(page, 'restored-history-mobile');
    await ctx.close();
    await a.ctx.close();
    await b.ctx.close();
  });
});

describe('key management', () => {
  it('rotates the key (history stays readable, contact is told) and issues a new recovery key', async () => {
    const a = await registerUser(stack, 'Noor');
    const b = await registerUser(stack, 'Elan');
    await connect(a, b);
    await sendText(a, 'before rotation');
    await bubble(b, 'before rotation').waitFor();

    await a.page.goto(stack.origin + '/settings/security');
    await a.page.getByRole('button', { name: /Rotate encryption key/ }).click();
    await a.page.getByRole('button', { name: 'Rotate key' }).click();
    await a.page.getByText('New encryption key in use.').waitFor();
    // The contact is told, in the conversation, that the security code changed.
    await b.page.getByText(`${a.displayName}'s security code changed. Tap to verify.`).waitFor();

    await a.page.goto(stack.origin + '/');
    await a.page.getByTestId(`conversation-${b.username}`).click();
    await bubble(a, 'before rotation').waitFor();
    await sendText(a, 'after rotation');
    await bubble(b, 'after rotation').waitFor();
    await sendText(b, 'reply to the new key');
    await bubble(a, 'reply to the new key').waitFor();

    // Replace a lost recovery key while still signed in…
    await a.page.goto(stack.origin + '/settings/security');
    await a.page.getByRole('button', { name: /Create a new recovery key/ }).click();
    await a.page.getByRole('button', { name: 'Create new key' }).click();
    const fresh = (await a.page.getByLabel('Recovery key', { exact: true }).getAttribute('data-key'))!;
    assert.match(fresh, /^[0-9A-Z]{4}(-[0-9A-Z]{4}){5}$/);
    assert.notEqual(fresh, a.recoveryKey);
    await a.page.getByRole('button', { name: 'I saved it' }).click();

    // …then the old key no longer works on a new device, and the new one unlocks both keys' history.
    const { ctx, page } = await signInFresh(a);
    await page.getByLabel('Recovery key').fill(a.recoveryKey);
    await page.getByRole('button', { name: 'Unlock' }).click();
    await page.getByText("That recovery key doesn't match this account.").waitFor();
    await page.getByLabel('Recovery key').fill(fresh);
    await page.getByRole('button', { name: 'Unlock' }).click();
    await page.getByTestId(`conversation-${b.username}`).click();
    await page.locator('[data-testid="message"]', { hasText: 'before rotation' }).waitFor();
    await page.locator('[data-testid="message"]', { hasText: 'reply to the new key' }).waitFor();
    await ctx.close();
    await a.ctx.close();
    await b.ctx.close();
  });
});

describe('messaging', () => {
  it('delivers in real time with sent → delivered → read receipts and typing indicators', async () => {
    const a = await registerUser(stack, 'Ishaan');
    const b = await registerUser(stack, 'Zoya');
    await connect(a, b, 'Hey Zoya, Ishaan here');
    await bubble(b, 'Ishaan here').waitFor();

    // Typing indicator
    await b.page.getByRole('textbox', { name: 'Message' }).pressSequentially('typing', { delay: 30 });
    await a.page.locator('.chat__sub--typing').waitFor();
    await b.page.getByRole('textbox', { name: 'Message' }).fill('');

    await sendText(a, 'Are we still on for Friday?');
    await bubble(b, 'still on for Friday').waitFor();
    // Zoya has the chat open and visible, so the message becomes "read" for Ishaan.
    await bubble(a, 'still on for Friday').locator('svg[aria-label="Read"]').waitFor();
    await sendText(b, 'Yes! 7pm 🍕');
    await bubble(a, '7pm').waitFor();
    await shot(a.page, 'receipts');

    // Only ciphertext reaches the database.
    const rows = await stack.inst.ctx.db.query<{ body: string }>(`SELECT body FROM messages WHERE kind = 'text'`);
    assert.ok(rows.rows.length >= 3);
    for (const r of rows.rows) {
      assert.match(r.body, /^c1\./);
      assert.ok(!r.body.includes('Friday') && !r.body.includes('pizza'));
    }
    const notes = await stack.inst.ctx.db.query<{ note: string }>(`SELECT note FROM conversation_requests WHERE note <> ''`);
    for (const n of notes.rows) assert.ok(!n.note.includes('Ishaan here'));
    await a.ctx.close();
    await b.ctx.close();
  });

  it('supports reply, reactions, edit, delete for everyone, forward and on-device search', async () => {
    const a = await registerUser(stack, 'Neha');
    const b = await registerUser(stack, 'Omar');
    const c = await registerUser(stack, 'Priya');
    await connect(a, b);
    await sendText(a, 'The quarterly report is ready');
    await bubble(b, 'quarterly report').waitFor();

    // Reply
    await openMenu(b, 'quarterly report');
    await b.page.getByRole('menuitem', { name: 'Reply' }).click();
    await sendText(b, 'Great, sending feedback tonight');
    const reply = bubble(a, 'sending feedback tonight');
    await reply.waitFor();
    await reply.locator('.reply-quote', { hasText: 'The quarterly report is ready' }).waitFor();

    // Reaction
    await openMenu(b, 'quarterly report');
    await b.page.getByRole('button', { name: 'React ❤️' }).click();
    await bubble(a, 'quarterly report').locator('.reaction', { hasText: '❤️' }).waitFor();

    // Edit
    await openMenu(a, 'quarterly report');
    await a.page.getByRole('menuitem', { name: 'Edit' }).click();
    const box = a.page.getByRole('textbox', { name: 'Message' });
    await box.fill('The Q3 report is ready');
    await box.press('Enter');
    await bubble(b, 'The Q3 report is ready').locator('.meta', { hasText: 'edited' }).waitFor();

    // Delete for everyone
    await sendText(a, 'oops wrong chat');
    await bubble(b, 'oops wrong chat').waitFor();
    await openMenu(a, 'oops wrong chat');
    await a.page.getByRole('menuitem', { name: 'Delete' }).click();
    await a.page.getByRole('button', { name: 'Delete for everyone' }).click();
    await b.page.getByText('This message was deleted').waitFor();
    assert.equal(await bubble(b, 'oops wrong chat').count(), 0);

    // Forward to a third person (text is re-encrypted for them)
    await a.page.getByTestId('new-chat').click();
    await a.page.getByLabel('Username').fill(c.username);
    await a.page.getByTestId(`user-result-${c.username}`).click();
    await a.page.getByTestId('start-chat').click();
    await c.page.getByRole('tab', { name: /Requests/ }).click();
    await c.page.getByTestId(`request-${a.username}`).getByRole('button', { name: 'Accept' }).click();
    await a.page.getByTestId(`conversation-${b.username}`).click();
    await openMenu(a, 'sending feedback tonight');
    await a.page.getByRole('menuitem', { name: 'Forward' }).click();
    await a.page.getByRole('dialog').getByRole('button', { name: /Priya/ }).click();
    await a.page.getByRole('button', { name: /^Forward \(1\)$/ }).click();
    await c.page.locator('[data-testid="message"]', { hasText: 'sending feedback tonight' }).locator('.bubble__forwarded').waitFor();

    // Search inside the conversation (decrypted on the device)
    await b.page.getByRole('button', { name: 'Search in conversation' }).click();
    await b.page.getByLabel('Search this conversation').fill('Q3 report');
    await b.page.locator('.hit', { hasText: 'Q3 report' }).first().click();
    await b.page.locator('.msg--highlight').waitFor();
    await shot(b.page, 'search');
    await a.ctx.close();
    await b.ctx.close();
    await c.ctx.close();
  });

  it('pages through long histories as you scroll up (messages from a separate Node.js client)', async () => {
    const b = await registerUser(stack, 'Reader');
    // A second, independent implementation of the client encrypts the history.
    const node = new Client({ base: stack.origin, origin: stack.origin, sink: stack.sink } as unknown as Harness);
    await node.register('history_writer', { privacy: { whoCanMessage: 'everyone' } });
    await b.page.goto(stack.origin + '/settings/privacy');
    await b.page.getByLabel('Who can message me').selectOption('everyone');
    await b.page.waitForTimeout(300);
    const conv = await node.post('/api/conversations', { userId: (await stack.inst.ctx.db.one<{ id: string }>('SELECT id FROM users WHERE email = $1', [b.email]))!.id });
    const conversationId = conv.body.conversation.id as string;
    const peer = conv.body.conversation.peer.id as string;
    for (let i = 0; i < 120; i++) {
      const body = await node.seal(peer, `history line ${i}`);
      await stack.inst.ctx.db.query(`INSERT INTO messages (conversation_id, sender_id, client_id, kind, body, created_at) VALUES ($1, $2, gen_random_uuid(), 'text', $3, now() - make_interval(mins => $4))`, [conversationId, node.id, body, 120 - i]);
    }
    await b.page.goto(stack.origin + `/c/${conversationId}`);
    await bubble(b, 'history line 119').waitFor();
    assert.equal(await bubble(b, 'history line 0').count(), 0, 'only the newest page is loaded at first');
    for (let i = 0; i < 20 && !(await bubble(b, 'history line 0').count()); i++) {
      await b.page.locator('.timeline').evaluate((el) => el.scrollTo({ top: 0 }));
      await b.page.waitForTimeout(400);
    }
    await bubble(b, 'history line 0').waitFor();
    assert.equal(await b.page.locator('[data-testid="message"]').count(), 120);
    await b.ctx.close();
  });

  it('renders hostile text as plain text', async () => {
    const a = await registerUser(stack, 'Eve');
    const b = await registerUser(stack, 'Dan');
    await connect(a, b);
    let dialog = false;
    b.page.on('dialog', async (d) => {
      dialog = true;
      await d.dismiss();
    });
    const payload = '<img src=x onerror="alert(1)"><script>alert(2)</script> javascript:alert(3)';
    await sendText(a, payload);
    const m = bubble(b, '<script>');
    await m.waitFor();
    assert.equal(await m.locator('img, script').count(), 0);
    assert.equal(await m.locator('a').count(), 0, 'javascript: is never linked');
    await sendText(a, 'docs at https://example.com/guide');
    await bubble(b, 'docs at').locator('a[href="https://example.com/guide"][rel~="noopener"]').waitFor();
    assert.equal(dialog, false);
    await a.ctx.close();
    await b.ctx.close();
  });

  it('queues messages while offline and delivers them after reconnecting', async () => {
    const a = await registerUser(stack, 'Tara');
    const b = await registerUser(stack, 'Vik');
    await connect(a, b);
    await a.ctx.setOffline(true);
    await sendText(a, 'sent from the tunnel');
    await a.page.locator('[data-testid="pending-message"]', { hasText: 'sent from the tunnel' }).waitFor();
    await shot(a.page, 'offline-pending');
    await a.page.waitForTimeout(1500);
    await a.ctx.setOffline(false);
    await bubble(b, 'sent from the tunnel').waitFor({ timeout: 30_000 });
    await bubble(a, 'sent from the tunnel').waitFor({ timeout: 30_000 });
    assert.equal(await a.page.locator('[data-testid="pending-message"]').count(), 0);
    const n = await stack.inst.ctx.db.query(`SELECT 1 FROM messages m JOIN users u ON u.id = m.sender_id WHERE u.email = $1 AND m.kind = 'text'`, [a.email]);
    assert.equal(n.rowCount, 1, 'exactly one copy despite retries');
    await a.ctx.close();
    await b.ctx.close();
  });
});

describe('media', () => {
  it('sends photos, documents, video and a recorded voice message', async () => {
    const a = await registerUser(stack, 'Lena');
    const b = await registerUser(stack, 'Ravi');
    await connect(a, b);

    await a.page.getByTestId('file-input').setInputFiles(await fixtureFile('trip.jpg', fx.jpegWithGps(1200, 900)));
    await a.page.getByLabel('Caption (optional)').fill('From the trip');
    await a.page.getByTestId('send-attachment').click();
    const photo = bubble(b, 'From the trip');
    await photo.waitFor({ timeout: 15_000 });
    await photo.getByRole('button', { name: 'Open photo' }).click();
    await b.page.locator('.viewer img').waitFor();
    await b.page.getByRole('button', { name: 'Close' }).click();

    await a.page.getByTestId('file-input').setInputFiles(await fixtureFile('notes.pdf', fx.minimalPdf()));
    await a.page.getByTestId('send-attachment').click();
    await b.page.locator('.file-chip', { hasText: 'notes.pdf' }).waitFor({ timeout: 15_000 });
    const [download] = await Promise.all([b.page.waitForEvent('download'), b.page.locator('.file-chip', { hasText: 'notes.pdf' }).click()]);
    assert.equal(download.suggestedFilename(), 'notes.pdf');

    await a.page.getByTestId('file-input').setInputFiles(await fixtureFile('clip.mp4', fx.mp4WithLocation()));
    await a.page.getByTestId('send-attachment').click();
    await b.page.getByRole('button', { name: 'Play video' }).waitFor({ timeout: 20_000 });

    // Voice: Chromium's fake microphone produces a tone.
    await a.page.getByRole('button', { name: 'Record a voice message' }).click();
    await a.page.getByText('Recording…').waitFor();
    await a.page.waitForTimeout(1500);
    await a.page.getByRole('button', { name: 'Stop recording' }).click();
    await a.page.getByRole('button', { name: 'Send voice message' }).click();
    const voice = b.page.locator('.audio').last();
    await voice.locator('.audio__label svg').waitFor({ timeout: 20_000 });
    // The recipient can actually play it (MP3 decodes in every browser, including Chromium without AAC).
    await voice.getByRole('button', { name: 'Play', exact: true }).click();
    await voice.getByRole('button', { name: 'Pause', exact: true }).waitFor({ timeout: 10_000 });
    assert.equal(await voice.getByText('Unavailable').count(), 0);
    await shot(b.page, 'media');

    // Unsupported files are refused with a clear message.
    await a.page.getByTestId('file-input').setInputFiles(await fixtureFile('setup.exe', Promise.resolve(fx.exe())));
    await a.page.getByTestId('send-attachment').click();
    await a.page.getByText(/This file type is not supported/).waitFor({ timeout: 15_000 });
    await a.ctx.close();
    await b.ctx.close();
  });

  it('enforces view once and view twice on the server, across reloads', async () => {
    const a = await registerUser(stack, 'Sana');
    const b = await registerUser(stack, 'Jay');
    await connect(a, b);
    const img = await fixtureFile('secret.png', fx.png(800, 600));

    await a.page.getByTestId('file-input').setInputFiles(img);
    await a.page.getByRole('button', { name: 'View once' }).click();
    await a.page.getByTestId('send-attachment').click();
    const lantern = b.page.getByTestId('protected-media').last();
    await lantern.waitFor({ timeout: 15_000 });
    await lantern.click();
    await b.page.locator('.viewer--protected canvas').waitFor({ state: 'visible' });
    // No <img> with a URL exists for protected media, and right-click is suppressed.
    assert.equal(await b.page.locator('.viewer--protected img').count(), 0);
    await b.page.getByRole('button', { name: 'Close' }).click();
    await b.page.reload();
    await b.page.getByTestId(`conversation-${a.username}`).click();
    await b.page.getByTestId('protected-media').last().waitFor();
    assert.equal(await b.page.getByTestId('protected-media').last().isDisabled(), true);
    await a.page.getByText('Opened').last().waitFor();
    // Asking the server directly is refused too.
    const id = (await stack.inst.ctx.db.one<{ id: string }>(`SELECT a.id FROM attachments a JOIN users u ON u.id = a.uploader_id WHERE u.email = $1 AND a.view_policy = 'once'`, [a.email]))!.id;
    const session = (await b.ctx.cookies(stack.origin)).find((c) => c.name === 'cove_session')!.value;
    const again = await fetch(`${stack.origin}/api/attachments/${id}/views`, {
      method: 'POST',
      headers: { origin: stack.origin, cookie: `cove_session=${session}`, 'x-csrf-token': csrfTokenFor(stack.inst.ctx.cfg, session), 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(again.status, 410, 'the server refuses a further view');

    // View twice
    await a.page.getByTestId('file-input').setInputFiles(img);
    await a.page.getByRole('button', { name: 'View twice' }).click();
    await a.page.getByTestId('send-attachment').click();
    const twice = b.page.getByTestId('protected-media').last();
    await b.page.getByText('2 views left · Tap to open').waitFor({ timeout: 15_000 });
    await twice.click();
    await b.page.locator('.viewer--protected canvas').waitFor({ state: 'visible' });
    await b.page.getByRole('button', { name: 'Close' }).click();
    await b.page.getByText('1 view left · Tap to open').waitFor();
    await twice.click();
    await b.page.locator('.viewer--protected canvas').waitFor({ state: 'visible' });
    await b.page.getByRole('button', { name: 'Close' }).click();
    await b.page.waitForTimeout(500);
    assert.equal(await b.page.getByTestId('protected-media').last().isDisabled(), true);
    await shot(b.page, 'view-twice-spent');
    await a.ctx.close();
    await b.ctx.close();
  });
});

describe('privacy and safety', () => {
  it('blocking stops messages; unblocking restores them', async () => {
    const a = await registerUser(stack, 'Mira');
    const b = await registerUser(stack, 'Ken');
    await connect(a, b);
    await b.page.getByRole('button', { name: 'Conversation options' }).click();
    await b.page.getByRole('menuitem', { name: 'Block' }).click();
    await b.page.getByRole('dialog').getByRole('button', { name: 'Block' }).click();
    await b.page.getByText(`You blocked ${a.displayName}.`).waitFor();
    await sendText(a, 'hello?');
    await a.page.getByText("This message couldn't be delivered.").waitFor();
    // Blocked users can't start a new conversation either.
    await b.page.getByRole('button', { name: 'Unblock' }).click();
    await b.page.getByRole('textbox', { name: 'Message' }).waitFor();
    await sendText(a, 'back again');
    await bubble(b, 'back again').waitFor();
    await a.ctx.close();
    await b.ctx.close();
  });

  it('applies privacy settings: hidden online status, disappearing messages, verified security code', async () => {
    const a = await registerUser(stack, 'Asha');
    const b = await registerUser(stack, 'Leo');
    await connect(a, b);
    await a.page.locator('.chat__sub', { hasText: 'online' }).waitFor();

    await b.page.goto(stack.origin + '/settings/privacy');
    await b.page.getByLabel('Online status').selectOption('nobody');
    await b.page.getByLabel('Last seen').selectOption('nobody');
    await b.page.waitForTimeout(400);
    await a.page.reload();
    await a.page.getByTestId(`conversation-${b.username}`).click();
    await a.page.locator('.chat__sub').waitFor();
    assert.equal(await a.page.locator('.chat__sub', { hasText: 'online' }).count(), 0);

    // Disappearing messages
    await a.page.getByRole('button', { name: 'Conversation options' }).click();
    await a.page.getByRole('menuitem', { name: 'Disappearing messages' }).click();
    await a.page.getByLabel('7 days').check();
    await a.page.getByRole('button', { name: 'Save' }).click();
    await a.page.getByText('New messages disappear after 7 days').waitFor();

    // Safety number is identical on both sides
    await a.page.locator('.chat__who').click();
    await a.page.getByRole('button', { name: /Encryption/ }).click();
    const sa = await a.page.getByLabel('Security code', { exact: true }).innerText();
    await b.page.goto(stack.origin + '/');
    await b.page.getByTestId(`conversation-${a.username}`).click();
    await b.page.locator('.chat__who').click();
    await b.page.getByRole('button', { name: /Encryption/ }).click();
    const sb = await b.page.getByLabel('Security code', { exact: true }).innerText();
    assert.equal(sa.replace(/\s+/g, ''), sb.replace(/\s+/g, ''));
    assert.equal(sa.replace(/\D/g, '').length, 60);
    await a.page.getByLabel('Mark as verified').click();
    await shot(a.page, 'safety-number');
    await a.ctx.close();
    await b.ctx.close();
  });

  it('uploads and crops a profile photo that contacts can see', async () => {
    const a = await registerUser(stack, 'Ira');
    const b = await registerUser(stack, 'Sam');
    await connect(a, b);
    await a.page.goto(stack.origin + '/settings/profile');
    await a.page.locator('input[type=file]').setInputFiles(await fixtureFile('me.jpg', fx.jpegWithGps(900, 600)));
    await a.page.getByRole('heading', { name: 'Position your photo' }).waitFor();
    await a.page.getByLabel('Zoom').fill('1.6');
    await a.page.getByRole('button', { name: 'Use photo' }).click();
    await a.page.getByText('Photo updated').waitFor({ timeout: 15_000 });
    await b.page.reload();
    await b.page.getByTestId(`conversation-${a.username}`).locator('.avatar img').waitFor();
    await a.ctx.close();
    await b.ctx.close();
  });

  it('works as a single-column app on a phone', async () => {
    const a = await registerUser(stack, 'Nia', { mobile: true });
    const b = await registerUser(stack, 'Raj');
    await connect(a, b);
    // In a chat the list is hidden and the composer is visible at the bottom.
    assert.equal(await a.page.locator('.rail').isVisible(), false);
    const composer = await a.page.locator('.composer').boundingBox();
    assert.ok(composer && composer.y + composer.height <= 844 + 1);
    await a.page.getByRole('button', { name: 'Back to chats' }).click();
    await a.page.locator('.rail').waitFor();
    assert.equal(await a.page.locator('.main').isVisible(), false);
    const overflow = await a.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    assert.equal(overflow, false, 'no horizontal scrolling');
    await shot(a.page, 'mobile-list');
    await a.ctx.close();
    await b.ctx.close();
  });

  it('deletes an account only with an emailed code', async () => {
    const a = await registerUser(stack, 'Gone');
    await a.page.goto(stack.origin + '/settings/account');
    await a.page.getByRole('button', { name: /Delete account/ }).click();
    const since = Date.now() - 5;
    await a.page.getByRole('button', { name: 'Email me a code' }).click();
    const { code } = await codeFor(stack, a.email, since);
    await enterCode(a.page, code);
    await a.page.getByRole('heading', { name: 'Sign in' }).waitFor({ timeout: 10_000 });
    const row = await stack.inst.ctx.db.one('SELECT 1 FROM users WHERE email = $1', [a.email]);
    assert.equal(row, undefined);
    await a.ctx.close();
  });
});
