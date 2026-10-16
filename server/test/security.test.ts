import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { isAllowedPushEndpoint } from '../src/notifications/routes';
import { Client, connectedPair, ORIGIN, startHarness, TestSocket, type Harness } from './helpers/harness';

let h: Harness;
before(async () => {
  h = await startHarness();
});
after(async () => {
  await h.close();
});

describe('unauthenticated access', () => {
  it('rejects every protected endpoint without a session', async () => {
    const anon = new Client(h);
    const id = randomUUID();
    const endpoints: [string, string][] = [
      ['GET', '/api/me'],
      ['GET', '/api/conversations'],
      ['GET', `/api/conversations/${id}/messages`],
      ['POST', `/api/conversations/${id}/messages`],
      ['GET', `/api/users/search?q=abc`],
      ['GET', `/api/users/${id}`],
      ['GET', `/api/users/${id}/avatar`],
      ['GET', `/api/attachments/${id}/content`],
      ['POST', `/api/attachments/${id}/views`],
      ['GET', `/api/attachments/${id}/protected`],
      ['POST', `/api/uploads?conversationId=${id}`],
      ['GET', '/api/notifications'],
      ['GET', '/api/auth/sessions'],
      ['POST', '/api/auth/logout-all'],
      ['POST', '/api/account/delete/request'],
      ['PATCH', '/api/me/privacy'],
      ['GET', '/api/me/keys/backup'],
      ['PUT', '/api/me/keys'],
      ['GET', '/api/does-not-exist'],
    ];
    for (const [method, p] of endpoints) {
      const r = await anon.req(method, p, method === 'GET' ? {} : { json: {} });
      assert.equal(r.status, 401, `${method} ${p}`);
    }
  });

  it('rejects WebSocket connections without a session or from another origin', async () => {
    const anon = new TestSocket(h.base.replace('http', 'ws') + '/ws', { origin: ORIGIN }, true);
    await assert.rejects(anon.opened, /401/);
    const c = new Client(h);
    await c.register('ws_origin');
    await assert.rejects(c.connect({ origin: 'https://evil.example' }), /403/);
    const ok = await c.connect();
    ok.close();
  });
});

describe('cross-user isolation', () => {
  it('prevents reading or changing another user’s data by changing identifiers', async () => {
    const { a, b, conversationId } = await connectedPair(h, ['iso_a', 'iso_b']);
    const eve = new Client(h);
    await eve.register('iso_eve');
    const m = await a.sendText(conversationId, 'top secret');
    // Eve cannot end Bob's sessions.
    const sessions = await h.db.query<{ id: string }>('SELECT id FROM sessions WHERE user_id = $1 AND revoked_at IS NULL', [b.id]);
    assert.equal((await eve.del(`/api/auth/sessions/${sessions.rows[0]!.id}`)).status, 404);
    assert.equal((await b.get('/api/me')).status, 200);
    // Eve cannot accept a request addressed to someone else.
    const c = new Client(h);
    await c.register('iso_c');
    const req = await a.post('/api/conversations', { userId: c.id });
    assert.equal((await eve.post(`/api/conversation-requests/${req.body.request.id}/accept`)).status, 404);
    // Eve can fetch public keys, but never anyone's key backup or messages.
    assert.equal((await eve.get(`/api/users/${a.id}/keys`)).status, 200);
    assert.equal((await eve.get('/api/me/keys/backup')).body.backup.ciphertext !== (await a.get('/api/me/keys/backup')).body.backup.ciphertext, true);
    // Reporting a message requires being in the conversation.
    const rep = await eve.post('/api/reports', { userId: a.id, messageId: m.body.message.id, reason: 'spam' });
    assert.equal(rep.status, 404);
  });

  it('never exposes email addresses or session details of other users', async () => {
    const { a, b, conversationId } = await connectedPair(h, ['leak_a', 'leak_b']);
    await a.sendText(conversationId, 'hi');
    const bodies = [
      await b.get('/api/conversations'),
      await b.get(`/api/conversations/${conversationId}/messages`),
      await b.get(`/api/users/${a.id}`),
      await b.get('/api/users/search?q=leak'),
    ].map((r) => JSON.stringify(r.body));
    for (const body of bodies) {
      assert.ok(!body.includes(a.me.email), 'email not exposed');
      assert.ok(!body.includes('token_hash') && !body.includes('storage_key'));
    }
  });
});

describe('response hardening', () => {
  it('sends strict security headers', async () => {
    const r = await new Client(h).get('/api/health');
    assert.equal(r.status, 200);
    const csp = r.headers.get('content-security-policy') ?? '';
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /object-src 'none'/);
    assert.ok(!/unsafe-inline|unsafe-eval/.test(csp));
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.match(r.headers.get('permissions-policy') ?? '', /camera=\(\)/);
  });

  it('carries message text only as opaque ciphertext that decrypts verbatim (no HTML interpretation)', async () => {
    const { a, b, conversationId } = await connectedPair(h, ['xss_a', 'xss_b']);
    const payload = '<img src=x onerror=alert(1)><script>alert(document.cookie)</script>';
    await a.sendText(conversationId, payload);
    const r = await b.get(`/api/conversations/${conversationId}/messages`);
    assert.match(r.headers.get('content-type') ?? '', /application\/json/);
    const last = r.body.messages.at(-1);
    assert.ok(!JSON.stringify(r.body).includes('<script>'), 'the server only ever handles ciphertext');
    assert.equal(await b.textOf(last), payload);
  });

  it('does not serve storage or source files over HTTP', async () => {
    const anon = new Client(h);
    for (const p of ['/objects/', '/data/storage/objects/media', '/../.env', '/server/src/config.ts', '/api/../package.json']) {
      const r = await anon.get(p);
      assert.notEqual(r.status, 200, p);
    }
  });

  it('only accepts push subscriptions for known push services (SSRF guard)', () => {
    assert.equal(isAllowedPushEndpoint('https://fcm.googleapis.com/fcm/send/abc'), true);
    assert.equal(isAllowedPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/abc'), true);
    assert.equal(isAllowedPushEndpoint('https://web.push.apple.com/abc'), true);
    assert.equal(isAllowedPushEndpoint('http://fcm.googleapis.com/x'), false);
    assert.equal(isAllowedPushEndpoint('https://169.254.169.254/latest/meta-data'), false);
    assert.equal(isAllowedPushEndpoint('https://localhost:8080/x'), false);
    assert.equal(isAllowedPushEndpoint('https://fcm.googleapis.com.evil.example/x'), false);
  });

  it('rejects oversized JSON bodies', async () => {
    const c = new Client(h);
    await c.register('bigjson');
    const r = await c.patch('/api/me/profile', { bio: 'x'.repeat(200_000) });
    assert.equal(r.status, 413);
  });
});

describe('rate limiting', () => {
  it('throttles message floods', async () => {
    const { a, conversationId } = await connectedPair(h, ['flood_a', 'flood_b']);
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) => a.post(`/api/conversations/${conversationId}/messages`, { clientId: randomUUID(), body: `spam ${i}` })),
    );
    assert.ok(results.some((r) => r.status === 429));
    assert.ok(results.filter((r) => r.status === 201).length <= 30);
  });

  it('throttles user search', async () => {
    const c = new Client(h);
    await c.register('searchy');
    let limited = false;
    for (let i = 0; i < 70 && !limited; i++) limited = (await c.get('/api/users/search?q=abc')).status === 429;
    assert.ok(limited);
  });
});
