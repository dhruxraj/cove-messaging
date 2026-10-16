import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Client, startHarness, type Harness } from './helpers/harness';
import { SmtpSink } from './helpers/smtp-sink';

let h: Harness;
before(async () => {
  h = await startHarness();
});
after(async () => {
  await h.close();
});

describe('registration', () => {
  it('registers a new Gmail address via a 6-digit email code, then asks for profile setup', async () => {
    const c = new Client(h);
    const { challengeId, mail, code } = await c.requestCode('new.person@gmail.com', 'register');
    assert.match(code!, /^\d{6}$/);
    assert.match(mail.subject, /verify your email/i);
    assert.ok(!mail.subject.includes(code!), 'code is not in the subject line');
    const r = await c.verify(challengeId, code!);
    assert.equal(r.status, 200);
    assert.equal(r.body.isNewUser, true);
    assert.equal(r.body.me.setupComplete, false);
    assert.equal(r.body.me.email, 'new.person@gmail.com');
    const session = await c.get('/api/auth/session');
    assert.equal(session.status, 200);
    const p = await c.patch('/api/me/profile', { username: 'new_person', displayName: 'New Person', bio: 'hello' });
    assert.equal(p.status, 200);
    assert.equal(p.body.me.setupComplete, true);
  });

  it('rejects non-Gmail and malformed addresses', async () => {
    const c = new Client(h);
    for (const email of ['someone@yahoo.com', 'not-an-email', 'a@@gmail.com', '.dot@gmail.com', '']) {
      const r = await c.post('/api/auth/otp', { email, purpose: 'register' });
      assert.equal(r.status, 400, email);
      assert.equal(r.body.error.code, 'invalid_email');
    }
  });

  it('treats Gmail dot and +tag variants as the same mailbox', async () => {
    const a = new Client(h);
    await a.signIn('Jane.Doe+chat@gmail.com', 'register');
    const b = new Client(h);
    const { challengeId, mail, code } = await b.requestCode('janedoe@gmail.com', 'register');
    assert.match(mail.text, /already has one/i);
    const r = await b.verify(challengeId, code!);
    assert.equal(r.body.isNewUser, false);
    assert.equal(r.body.me.id, a.me.id);
  });

  it('never stores the code in plaintext and never returns it', async () => {
    const c = new Client(h);
    const r = await c.post('/api/auth/otp', { email: 'hash.check@gmail.com', purpose: 'register' });
    const mail = await h.sink.next('hash.check@gmail.com');
    const code = SmtpSink.codeIn(mail)!;
    assert.ok(!JSON.stringify(r.body).includes(code));
    const row = await h.db.one<{ code_hash: Buffer }>('SELECT code_hash FROM auth_challenges WHERE id = $1', [r.body.challengeId]);
    assert.equal(row!.code_hash.length, 32);
    assert.ok(!row!.code_hash.toString('latin1').includes(code));
    const cols = await h.db.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'auth_challenges'`);
    assert.ok(!cols.rows.some((x) => x.column_name === 'code'));
  });
});

describe('code verification', () => {
  it('rejects an incorrect code and reports remaining attempts', async () => {
    const c = new Client(h);
    const { challengeId, code } = await c.requestCode('wrong.code@gmail.com');
    const wrong = code === '000000' ? '111111' : '000000';
    const r = await c.verify(challengeId, wrong);
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'invalid_code');
    assert.equal(r.body.error.attemptsRemaining, 4);
    assert.equal(c.cookies.size, 0);
  });

  it('rejects an expired code', async () => {
    const c = new Client(h);
    const { challengeId, code } = await c.requestCode('expired.code@gmail.com');
    await h.db.query(`UPDATE auth_challenges SET expires_at = now() - interval '1 second' WHERE id = $1`, [challengeId]);
    const r = await c.verify(challengeId, code!);
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'code_expired');
  });

  it('expires codes after five minutes by default', async () => {
    const c = new Client(h);
    const { challengeId } = await c.requestCode('ttl.check@gmail.com');
    const row = await h.db.one<{ s: number }>(`SELECT round(extract(epoch FROM expires_at - created_at))::int AS s FROM auth_challenges WHERE id = $1`, [challengeId]);
    assert.equal(row!.s, 300);
  });

  it('rejects a reused code', async () => {
    const c = new Client(h);
    const { challengeId, code } = await c.requestCode('reuse.code@gmail.com');
    assert.equal((await c.verify(challengeId, code!)).status, 200);
    const other = new Client(h);
    const r = await other.verify(challengeId, code!);
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'code_used');
  });

  it('locks a code after too many wrong attempts — even the right code then fails', async () => {
    const c = new Client(h);
    const { challengeId, code } = await c.requestCode('brute.force@gmail.com');
    const wrong = code === '123456' ? '654321' : '123456';
    for (let i = 0; i < 5; i++) await c.verify(challengeId, wrong);
    const r = await c.verify(challengeId, code!);
    assert.equal(r.status, 429);
    assert.equal(r.body.error.code, 'too_many_attempts');
    // A fresh code still works: one mistake never locks the account permanently.
    const again = await c.requestCode('brute.force@gmail.com');
    assert.equal((await c.verify(again.challengeId, again.code!)).status, 200);
  });

  it('counts concurrent guesses correctly (row-locked attempts)', async () => {
    const c = new Client(h);
    const { challengeId, code } = await c.requestCode('parallel.guess@gmail.com');
    const guesses = Array.from({ length: 12 }, (_, i) => String(i).padStart(6, '9')).filter((g) => g !== code);
    const results = await Promise.all(guesses.map((g) => new Client(h).verify(challengeId, g)));
    const counted = results.filter((r) => r.body.error?.code === 'invalid_code').length;
    assert.ok(counted <= 5, `at most 5 guesses evaluated, got ${counted}`);
    const row = await h.db.one<{ attempts: number }>('SELECT attempts FROM auth_challenges WHERE id = $1', [challengeId]);
    assert.equal(row!.attempts, 5);
  });

  it('only the newest code for an address is valid', async () => {
    const c = new Client(h);
    const first = await c.requestCode('newest.only@gmail.com');
    const second = await c.requestCode('newest.only@gmail.com');
    const r = await c.verify(first.challengeId, first.code!);
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'code_expired');
    assert.equal((await c.verify(second.challengeId, second.code!)).status, 200);
  });
});

describe('login', () => {
  it('signs in a registered user without a password', async () => {
    const c = new Client(h);
    await c.signIn('login.me@gmail.com', 'register');
    const d = new Client(h);
    const r = await d.signIn('login.me@gmail.com', 'login');
    assert.equal(r.body.isNewUser, false);
  });

  it('does not reveal whether an address is registered, and never signs in an unknown one', async () => {
    const c = new Client(h);
    const known = new Client(h);
    await known.signIn('known.user@gmail.com', 'register');
    const r1 = await c.post('/api/auth/otp', { email: 'known.user@gmail.com', purpose: 'login' });
    const r2 = await c.post('/api/auth/otp', { email: 'nobody.here@gmail.com', purpose: 'login' });
    assert.equal(r1.status, r2.status);
    assert.deepEqual(Object.keys(r1.body).sort(), Object.keys(r2.body).sort());
    const mail = await h.sink.next('nobody.here@gmail.com');
    assert.equal(SmtpSink.codeIn(mail), null, 'no code is sent for unknown addresses');
    assert.match(mail.text, /no account/i);
    for (const guess of ['000000', '123456', '999999']) {
      const v = await c.verify(r2.body.challengeId, guess);
      assert.equal(v.status, 400);
    }
    const u = await h.db.one(`SELECT 1 FROM users WHERE email_canonical = 'nobodyhere@gmail.com'`);
    assert.equal(u, undefined);
  });

  it('rate-limits code requests per address', async () => {
    const h2 = await startHarness({ OTP_MAX_PER_HOUR: '3', OTP_RESEND_COOLDOWN_SECONDS: '0' }, { reset: false, sink: h.sink });
    try {
      const c = new Client(h2);
      for (let i = 0; i < 3; i++) assert.equal((await c.post('/api/auth/otp', { email: 'limited@gmail.com', purpose: 'register' })).status, 200);
      const r = await c.post('/api/auth/otp', { email: 'limited@gmail.com', purpose: 'register' });
      assert.equal(r.status, 429);
      assert.ok(Number(r.headers.get('retry-after')) > 0);
    } finally {
      await h2.close();
    }
  });

  it('enforces a resend cooldown', async () => {
    const h2 = await startHarness({ OTP_RESEND_COOLDOWN_SECONDS: '60' }, { reset: false, sink: h.sink });
    try {
      const c = new Client(h2);
      assert.equal((await c.post('/api/auth/otp', { email: 'cooldown@gmail.com', purpose: 'register' })).status, 200);
      const r = await c.post('/api/auth/otp', { email: 'cooldown@gmail.com', purpose: 'register' });
      assert.equal(r.status, 429);
      assert.equal(r.body.error.code, 'resend_cooldown');
    } finally {
      await h2.close();
    }
  });

  it('blocks new codes for an address after many failed verifications', async () => {
    const h2 = await startHarness({ OTP_MAX_FAILURES_PER_HOUR: '6' }, { reset: false, sink: h.sink });
    try {
      const c = new Client(h2);
      for (let round = 0; round < 2; round++) {
        const { challengeId, code } = await c.requestCode('many.failures@gmail.com');
        const wrong = code === '222222' ? '333333' : '222222';
        for (let i = 0; i < 3; i++) await c.verify(challengeId, wrong);
      }
      const r = await c.post('/api/auth/otp', { email: 'many.failures@gmail.com', purpose: 'login' });
      assert.equal(r.status, 429);
      assert.equal(r.body.error.code, 'too_many_failures');
    } finally {
      await h2.close();
    }
  });
});

describe('sessions', () => {
  it('uses an HttpOnly, SameSite=Strict cookie and stores only a hash of the token', async () => {
    const c = new Client(h);
    const { challengeId, code } = await c.requestCode('cookie.check@gmail.com');
    const res = await fetch(h.base + '/api/auth/verify', {
      method: 'POST',
      headers: { origin: 'http://localhost:5999', 'content-type': 'application/json', 'x-forwarded-for': '10.9.9.9' },
      body: JSON.stringify({ challengeId, code }),
    });
    const cookie = res.headers.getSetCookie()[0]!;
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);
    assert.match(cookie, /Path=\//);
    const token = cookie.split(';')[0]!.split('=')[1]!;
    const rows = await h.db.query<{ token_hash: Buffer }>('SELECT token_hash FROM sessions');
    assert.ok(rows.rows.every((r) => r.token_hash.toString('base64url') !== token && !r.token_hash.toString('utf8').includes(token)));
  });

  it('allows one active session: a new sign-in ends the previous one and notifies the owner', async () => {
    const first = new Client(h);
    await first.signIn('single.session@gmail.com', 'register');
    const sock = await first.connect();
    const second = new Client(h);
    const since = Date.now();
    const r = await second.signIn('single.session@gmail.com', 'login');
    assert.equal(r.body.replacedPreviousSession, true);
    const revoked = await sock.waitFor('session:revoked');
    assert.equal(revoked.reason, 'replaced');
    const closed = await sock.closed;
    assert.equal(closed.code, 4001);
    assert.equal((await first.get('/api/me')).status, 401);
    assert.equal((await second.get('/api/me')).status, 200);
    const alert = await h.sink.next('single.session@gmail.com', since);
    assert.match(alert.subject, /new sign-in/i);
    const n = await second.get('/api/notifications');
    assert.ok(n.body.notifications.some((x: any) => x.type === 'security_session_replaced'));
  });

  it('allows several sessions when SESSION_POLICY=multiple', async () => {
    const h2 = await startHarness({ SESSION_POLICY: 'multiple' }, { reset: false, sink: h.sink });
    try {
      const a = new Client(h2);
      const b = new Client(h2);
      await a.signIn('multi.session@gmail.com', 'register');
      await b.signIn('multi.session@gmail.com', 'login');
      assert.equal((await a.get('/api/me')).status, 200);
      assert.equal((await b.get('/api/me')).status, 200);
      const list = await a.get('/api/auth/sessions');
      assert.equal(list.body.sessions.length, 2);
    } finally {
      await h2.close();
    }
  });

  it('expires sessions (absolute and idle)', async () => {
    const c = new Client(h);
    await c.signIn('expiry.check@gmail.com', 'register');
    await h.db.query(`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE user_id = $1`, [c.me.id]);
    assert.equal((await c.get('/api/me')).status, 401);
    const d = new Client(h);
    await d.signIn('expiry.check@gmail.com', 'login');
    await h.db.query(`UPDATE sessions SET last_active_at = now() - interval '15 days' WHERE user_id = $1 AND revoked_at IS NULL`, [d.me.id]);
    assert.equal((await d.get('/api/me')).status, 401);
  });

  it('logs out and clears site data', async () => {
    const c = new Client(h);
    await c.signIn('logout.me@gmail.com', 'register');
    const r = await c.post('/api/auth/logout');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('clear-site-data') ?? '', /cache/);
    assert.equal((await c.get('/api/me')).status, 401);
  });

  it('can end all sessions', async () => {
    const h2 = await startHarness({ SESSION_POLICY: 'multiple' }, { reset: false, sink: h.sink });
    try {
      const a = new Client(h2);
      const b = new Client(h2);
      await a.signIn('end.all@gmail.com', 'register');
      await b.signIn('end.all@gmail.com', 'login');
      const r = await a.post('/api/auth/logout-all');
      assert.equal(r.body.endedSessions, 2);
      assert.equal((await a.get('/api/me')).status, 401);
      assert.equal((await b.get('/api/me')).status, 401);
    } finally {
      await h2.close();
    }
  });

  it('deletes the account only with a fresh email code', async () => {
    const c = new Client(h);
    await c.register('to_be_deleted');
    const userId = c.id;
    const start = await c.post('/api/account/delete/request');
    assert.equal(start.status, 200);
    const mail = await h.sink.next(c.me.email);
    const bad = await c.post('/api/account/delete', { challengeId: start.body.challengeId, code: SmtpSink.codeIn(mail) === '000000' ? '111111' : '000000' });
    assert.equal(bad.status, 400);
    const ok = await c.post('/api/account/delete', { challengeId: start.body.challengeId, code: SmtpSink.codeIn(mail) });
    assert.equal(ok.status, 200);
    assert.equal(await h.db.one('SELECT 1 FROM users WHERE id = $1', [userId]), undefined);
    assert.equal((await c.get('/api/me')).status, 401);
  });
});

describe('request forgery protection', () => {
  it('rejects state-changing requests from another origin', async () => {
    const c = new Client(h);
    const r = await c.post('/api/auth/otp', { email: 'x@gmail.com', purpose: 'login' }, { origin: 'https://evil.example' });
    assert.equal(r.status, 403);
    const r2 = await c.post('/api/auth/otp', { email: 'x@gmail.com', purpose: 'login' }, { origin: null });
    assert.equal(r2.status, 403);
  });

  it('requires the session-bound CSRF token for authenticated writes', async () => {
    const c = new Client(h);
    await c.register('csrf_user');
    const noToken = await c.patch('/api/me/profile', { bio: 'x' }, { csrf: false });
    assert.equal(noToken.status, 403);
    assert.equal(noToken.body.error.code, 'csrf_failed');
    const wrong = await c.patch('/api/me/profile', { bio: 'x' }, { csrf: false, headers: { 'x-csrf-token': 'forged' } });
    assert.equal(wrong.status, 403);
    assert.equal((await c.patch('/api/me/profile', { bio: 'x' })).status, 200);
  });

  it('requires a JSON content type (blocks simple cross-site form posts)', async () => {
    const c = new Client(h);
    const r = await c.req('POST', '/api/auth/otp', { body: 'email=x@gmail.com&purpose=login', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    assert.equal(r.status, 415);
  });
});
