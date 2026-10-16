import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { Client, connectedPair, sleep, startHarness, type Harness } from './helpers/harness';

let h: Harness;
before(async () => {
  h = await startHarness();
});
after(async () => {
  await h.close();
});

/** Send end-to-end encrypted text (encrypted on the "device", exactly like the web client). */
const send = (c: Client, conversationId: string, text: string, extra: Record<string, unknown> = {}) => c.sendText(conversationId, text, extra);
const texts = (c: Client, messages: any[]) => Promise.all(messages.map((m) => c.textOf(m)));

describe('profiles and discovery', () => {
  it('finds users by username without exposing their email', async () => {
    const a = new Client(h);
    const b = new Client(h);
    const { email } = await b.register('findable_bob', { displayName: 'Bob Findable' });
    await a.register('searcher_amy');
    const r = await a.get('/api/users/search?q=@findable');
    assert.equal(r.status, 200);
    assert.equal(r.body.users[0].username, 'findable_bob');
    const profile = await a.get(`/api/users/${b.id}`);
    assert.ok(!JSON.stringify(r.body).includes(email));
    assert.ok(!JSON.stringify(profile.body).includes(email));
    assert.equal(profile.body.user.email, undefined);
  });

  it('enforces unique, well-formed usernames', async () => {
    const a = new Client(h);
    const b = new Client(h);
    await a.register('unique_name');
    await b.register('other_name');
    assert.equal((await b.patch('/api/me/profile', { username: 'unique_name' })).status, 409);
    assert.equal((await b.patch('/api/me/profile', { username: 'Bad Name!' })).status, 400);
    assert.equal((await b.patch('/api/me/profile', { username: 'admin' })).status, 400);
    const check = await b.get('/api/usernames/check?u=unique_name');
    assert.equal(check.body.available, false);
  });

  it('strips control and bidi-override characters from display names', async () => {
    const a = new Client(h);
    await a.register('bidi_user');
    const r = await a.patch('/api/me/profile', { displayName: 'Eve‮gnp.exe\u0007' });
    assert.equal(r.body.me.displayName, 'Evegnp.exe');
  });

  it('applies profile-photo and presence privacy settings', async () => {
    const { a, b } = await connectedPair(h, ['priv_a', 'priv_b']);
    const stranger = new Client(h);
    await stranger.register('priv_stranger');
    await b.patch('/api/me/privacy', { profilePhoto: 'contacts', onlineStatus: 'nobody', lastSeen: 'nobody' });
    // give b a photo
    const sharp = (await import('sharp')).default;
    const png = await sharp({ create: { width: 300, height: 200, channels: 3, background: '#4a8' } }).png().toBuffer();
    const up = await b.req('POST', '/api/me/avatar?x=50&y=0&size=200', { body: png, headers: { 'content-type': 'image/png' } });
    assert.equal(up.status, 200);
    const asContact = await a.get(`/api/users/${b.id}`);
    const asStranger = await stranger.get(`/api/users/${b.id}`);
    assert.ok(asContact.body.user.avatarUrl);
    assert.equal(asStranger.body.user.avatarUrl, null);
    assert.equal(asContact.body.user.presence.online, null);
    assert.equal((await a.get(asContact.body.user.avatarUrl + '&size=512')).status, 200);
    assert.equal((await stranger.get(`/api/users/${b.id}/avatar?size=128`)).status, 404);
  });
});

describe('conversation requests', () => {
  it('sends a request when the recipient only accepts requests, and opens the chat on accept', async () => {
    const a = new Client(h);
    const b = new Client(h);
    await a.register('req_sender');
    await b.register('req_receiver'); // default: whoCanMessage = requests
    const bs = await b.connect();
    const r = await a.post('/api/conversations', { userId: b.id, note: await a.seal(b.id, 'Hi, it is Amy from work') });
    assert.ok(r.body.request);
    assert.equal(r.body.request.status, 'pending');
    const ev = await bs.waitFor('request:new');
    assert.match(ev.request.note, /^c1\./, 'the note is only ever stored and relayed encrypted');
    assert.equal(await b.open(ev.request.note, a.id, b.id), 'Hi, it is Amy from work');
    const plain = await a.post('/api/conversations', { userId: b.id, note: 'plaintext note' });
    assert.equal(plain.status, 400);
    const list = await b.get('/api/conversation-requests');
    assert.equal(list.body.incoming.length, 1);
    const acc = await b.post(`/api/conversation-requests/${ev.request.id}/accept`);
    assert.equal(acc.status, 200);
    const convId = acc.body.conversation.id;
    const msgs = await b.get(`/api/conversations/${convId}/messages`);
    const noteMsg = msgs.body.messages.find((m: any) => m.kind === 'text' && m.senderId === a.id);
    assert.equal(await b.textOf(noteMsg), 'Hi, it is Amy from work');
  });

  it('never tells the requester that a request was declined', async () => {
    const a = new Client(h);
    const b = new Client(h);
    await a.register('declined_a');
    await b.register('declined_b');
    const r = await a.post('/api/conversations', { userId: b.id });
    await b.post(`/api/conversation-requests/${r.body.request.id}/reject`);
    const mine = await a.get('/api/conversation-requests');
    assert.equal(mine.body.outgoing[0].status, 'pending');
    const again = await a.post('/api/conversations', { userId: b.id });
    assert.equal(again.body.request.id, r.body.request.id);
    assert.equal((await b.get('/api/conversation-requests')).body.incoming.length, 0);
  });

  it('respects "nobody can message me"', async () => {
    const a = new Client(h);
    const b = new Client(h);
    await a.register('nobody_a');
    await b.register('nobody_b', { privacy: { whoCanMessage: 'nobody' } });
    const r = await a.post('/api/conversations', { userId: b.id });
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'not_accepting');
  });
});

describe('real-time messaging', () => {
  it('delivers in real time with sent → delivered → read receipts', async () => {
    const { a, b, conversationId } = await connectedPair(h, ['rt_a', 'rt_b']);
    const as = await a.connect();
    const bs = await b.connect();
    const sent = await send(a, conversationId, 'Hello Bob 👋');
    assert.equal(sent.status, 201);
    assert.ok(['sent', 'delivered'].includes(sent.body.message.status));
    const incoming = await bs.waitFor('message:new', (d) => d.message.id === sent.body.message.id);
    assert.equal(await b.textOf(incoming.message), 'Hello Bob 👋');
    assert.equal(incoming.message.senderId, a.id);
    assert.equal(incoming.message.clientId, null, 'recipients never see the sender idempotency key');
    const delivered = await as.waitFor('message:status', (d) => d.status === 'delivered');
    assert.deepEqual(delivered.messageIds, [sent.body.message.id]);
    await b.post(`/api/conversations/${conversationId}/read`, { messageId: sent.body.message.id });
    const read = await as.waitFor('message:status', (d) => d.status === 'read');
    assert.deepEqual(read.messageIds, [sent.body.message.id]);
    const conv = await b.get(`/api/conversations/${conversationId}`);
    assert.equal(conv.body.conversation.unreadCount, 0);
    a.closeSockets();
    b.closeSockets();
  });

  it('does not send read receipts when either person disabled them', async () => {
    const { a, b, conversationId } = await connectedPair(h, ['norr_a', 'norr_b']);
    await b.patch('/api/me/privacy', { readReceipts: false });
    const as = await a.connect();
    await b.connect();
    const sent = await send(a, conversationId, 'are you there?');
    await as.waitFor('message:status', (d) => d.status === 'delivered');
    await b.post(`/api/conversations/${conversationId}/read`, { messageId: sent.body.message.id });
    assert.ok(await as.expectNone('message:status', (d) => d.status === 'read'));
    const list = await a.get(`/api/conversations/${conversationId}/messages`);
    assert.equal(list.body.messages.at(-1).status, 'delivered');
    a.closeSockets();
    b.closeSockets();
  });

  it('relays typing indicators only to the other participant', async () => {
    const { a, b, conversationId } = await connectedPair(h, ['typing_a', 'typing_b']);
    const outsider = new Client(h);
    await outsider.register('typing_outsider');
    const as = await a.connect();
    const bs = await b.connect();
    const os = await outsider.connect();
    as.send({ type: 'typing', conversationId, typing: true });
    const t = await bs.waitFor('typing');
    assert.equal(t.userId, a.id);
    assert.equal(t.typing, true);
    os.send({ type: 'typing', conversationId, typing: true });
    assert.ok(await as.expectNone('typing'));
    a.closeSockets();
    b.closeSockets();
    outsider.closeSockets();
  });

  it('is idempotent: retrying a send with the same clientId never duplicates', async () => {
    const { a, conversationId } = await connectedPair(h, ['dup_a', 'dup_b']);
    const clientId = randomUUID();
    const [r1, r2, r3] = await Promise.all([
      send(a, conversationId, 'once', { clientId }),
      send(a, conversationId, 'once', { clientId }),
      send(a, conversationId, 'once', { clientId }),
    ]);
    const ids = new Set([r1.body.message.id, r2.body.message.id, r3.body.message.id]);
    assert.equal(ids.size, 1);
    assert.equal([r1, r2, r3].filter((r) => r.body.duplicate === false).length, 1);
    const n = await h.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM messages WHERE client_id = $1`, [clientId]);
    assert.equal(n!.n, 1);
  });

  it('recovers messages missed while disconnected and marks them delivered on sync', async () => {
    const { a, b, conversationId } = await connectedPair(h, ['recon_a', 'recon_b']);
    const as = await a.connect();
    const first = await send(a, conversationId, 'before');
    const m1 = await send(a, conversationId, 'missed 1');
    const m2 = await send(a, conversationId, 'missed 2');
    assert.equal(m1.body.message.status, 'sent');
    // Bob comes back online: he syncs the list (marks delivered) and fetches what he missed.
    const bs = await b.connect();
    await b.get('/api/conversations');
    const status = await as.waitFor('message:status', (d) => d.status === 'delivered');
    assert.ok(status.messageIds.includes(m2.body.message.id));
    const missed = await b.get(`/api/conversations/${conversationId}/messages?after=${first.body.message.id}`);
    assert.deepEqual(await texts(b, missed.body.messages), ['missed 1', 'missed 2']);
    bs.close();
    as.close();
  });

  it('paginates history newest-first with hasMoreBefore', async () => {
    const { a, conversationId } = await connectedPair(h, ['page_a', 'page_b']);
    for (let i = 0; i < 25; i++) await send(a, conversationId, `m${i}`);
    const p1 = await a.get(`/api/conversations/${conversationId}/messages?limit=10`);
    assert.equal(p1.body.messages.length, 10);
    assert.equal(await a.textOf(p1.body.messages.at(-1)), 'm24');
    assert.equal(p1.body.hasMoreBefore, true);
    const p2 = await a.get(`/api/conversations/${conversationId}/messages?limit=10&before=${p1.body.messages[0].id}`);
    assert.equal(await a.textOf(p2.body.messages.at(-1)), 'm14');
    const around = await a.get(`/api/conversations/${conversationId}/messages?limit=6&around=${p2.body.messages[5].id}`);
    assert.ok(around.body.messages.some((m: any) => m.id === p2.body.messages[5].id));
  });

  it('supports replies, edits within the window, reactions, deletion and forwarding', async () => {
    const { a, b, conversationId } = await connectedPair(h, ['feat_a', 'feat_b']);
    const original = await send(a, conversationId, 'original text');
    const reply = await send(b, conversationId, 'replying', { replyToId: original.body.message.id });
    // The quoted message travels encrypted too; the client decrypts it for the reply preview.
    assert.equal(await b.open(reply.body.message.replyTo.body, a.id, b.id), 'original text');

    const edit = await a.patch(`/api/messages/${original.body.message.id}`, { body: await a.seal(b.id, 'edited text') });
    assert.equal(edit.status, 200);
    assert.equal((await a.patch(`/api/messages/${original.body.message.id}`, { body: 'plaintext edit' })).status, 400);
    assert.equal((await b.patch(`/api/messages/${original.body.message.id}`, { body: await b.seal(a.id, 'hijack') })).status, 403);
    await h.db.query(`UPDATE messages SET created_at = now() - interval '20 minutes' WHERE id = $1`, [original.body.message.id]);
    const late = await a.patch(`/api/messages/${original.body.message.id}`, { body: await a.seal(b.id, 'too late') });
    assert.equal(late.status, 403);
    assert.equal(late.body.error.code, 'edit_window_passed');

    assert.equal((await b.put(`/api/messages/${original.body.message.id}/reaction`, { emoji: '❤️' })).status, 200);
    assert.equal((await b.put(`/api/messages/${original.body.message.id}/reaction`, { emoji: 'not emoji' })).status, 400);
    let hist = await a.get(`/api/conversations/${conversationId}/messages`);
    const orig = hist.body.messages.find((m: any) => m.id === original.body.message.id);
    assert.equal(await a.textOf(orig), 'edited text');
    assert.ok(orig.editedAt);
    assert.deepEqual(orig.reactions, [{ emoji: '❤️', userId: b.id }]);

    // Forward to another chat
    const c = new Client(h);
    await c.register('feat_c', { privacy: { whoCanMessage: 'everyone' } });
    const ac = await a.post('/api/conversations', { userId: c.id });
    // The forwarding device decrypts and re-encrypts for the new recipient.
    const replyText = await a.textOf(reply.body.message);
    const target = { conversationId: ac.body.conversation.id, clientId: randomUUID(), body: await a.seal(c.id, replyText) };
    const fwd = await a.post(`/api/messages/${reply.body.message.id}/forward`, { targets: [target] });
    assert.deepEqual(fwd.body.forwardedTo, [ac.body.conversation.id]);
    const again = await a.post(`/api/messages/${reply.body.message.id}/forward`, { targets: [target] });
    assert.deepEqual(again.body.forwardedTo, [ac.body.conversation.id], 'retrying a forward is idempotent');
    const cHist = await c.get(`/api/conversations/${ac.body.conversation.id}/messages`);
    const fwdMsgs = cHist.body.messages.filter((m: any) => m.forwarded);
    assert.equal(fwdMsgs.length, 1);
    assert.equal(await c.textOf(fwdMsgs[0]), 'replying');

    // Delete for me vs for everyone
    await b.del(`/api/messages/${reply.body.message.id}?for=me`);
    hist = await b.get(`/api/conversations/${conversationId}/messages`);
    assert.ok(!hist.body.messages.some((m: any) => m.id === reply.body.message.id));
    hist = await a.get(`/api/conversations/${conversationId}/messages`);
    assert.ok(hist.body.messages.some((m: any) => m.id === reply.body.message.id));
    assert.equal((await b.del(`/api/messages/${original.body.message.id}?for=everyone`)).status, 403);
    assert.equal((await a.del(`/api/messages/${original.body.message.id}?for=everyone`)).status, 200);
    hist = await b.get(`/api/conversations/${conversationId}/messages`);
    const tomb = hist.body.messages.find((m: any) => m.id === original.body.message.id);
    assert.equal(tomb.deleted, true);
    assert.equal(tomb.body, '');
    assert.deepEqual(tomb.reactions, []);
  });

  it('stores only ciphertext: plaintext and envelopes for outdated keys are refused', async () => {
    const { a, b, conversationId } = await connectedPair(h, ['e2e_a', 'e2e_b']);
    const plain = await a.post(`/api/conversations/${conversationId}/messages`, { clientId: randomUUID(), body: 'the secret pineapple recipe' });
    assert.equal(plain.status, 400);
    assert.equal(plain.body.error.code, 'not_encrypted');
    const ok = await send(a, conversationId, 'the secret pineapple recipe');
    assert.equal(ok.status, 201);
    const row = await h.db.one<{ body: string }>('SELECT body FROM messages WHERE id = $1', [ok.body.message.id]);
    assert.ok(!row!.body.includes('pineapple'), 'the database never holds the plaintext');
    assert.match(row!.body, /^c1\./);
    // An envelope addressed to a key Bob no longer uses is refused with the current key ids.
    const stale = await a.seal(b.id, 'to the old key');
    await b.setupKeys(true);
    const r = await a.post(`/api/conversations/${conversationId}/messages`, { clientId: randomUUID(), body: stale });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'stale_key');
    assert.equal(r.body.error.recipientKid, b.identity!.kid);
    assert.equal((await send(a, conversationId, 'to the new key')).status, 201);
    // The old message stays readable for Bob with his previous key (restored from his backup).
    assert.equal(await b.textOf(ok.body.message), 'the secret pineapple recipe');
    const removed = await b.get('/api/search/messages?q=pineapple');
    assert.equal(removed.status, 404, 'there is no server-side message search');
  });

  it('publishes verified identity keys and tells contacts when a security code changes', async () => {
    const { a, b, conversationId } = await connectedPair(h, ['keys_a', 'keys_b']);
    const as = await a.connect();
    // Malformed keys or a key id that does not match the key are rejected.
    const bad = await b.req('PUT', '/api/me/keys', { json: { kid: b.identity!.kid, publicKey: 'A'.repeat(87), backup: {} } });
    assert.equal(bad.status, 400);
    const mismatch = await b.req('PUT', '/api/me/keys', {
      json: { kid: a.identity!.kid, publicKey: b.identity!.publicKey, backup: (await b.get('/api/me/keys/backup')).body.backup },
    });
    assert.equal(mismatch.body.error.code, 'invalid_key');
    // Replacing a key needs an explicit reset.
    const fresh = await (await import('../../web/src/lib/e2ee')).generateIdentity();
    const backup = (await b.get('/api/me/keys/backup')).body.backup;
    const noReplace = await b.req('PUT', '/api/me/keys', { json: { kid: fresh.kid, publicKey: fresh.publicKey, backup } });
    assert.equal(noReplace.body.error.code, 'key_exists');
    const before = b.identity!.kid;
    await b.setupKeys(true);
    const sys = await as.waitFor('message:new', (d) => d.message.kind === 'system' && d.message.system?.type === 'key_changed');
    assert.equal(sys.message.system.userId, b.id);
    const keyEv = await as.waitFor('user:keys');
    assert.equal(keyEv.kid, b.identity!.kid);
    const keys = await a.keysOf(b.id);
    assert.equal(keys.find((k) => k.active)!.kid, b.identity!.kid);
    assert.ok(keys.some((k) => k.kid === before && !k.active), 'previous keys stay published for older messages');
    const conv = await a.get(`/api/conversations/${conversationId}`);
    assert.equal(conv.body.conversation.peerKeyId, b.identity!.kid);
    // The backup is only available to its owner, and the server cannot read it.
    const stored = await h.db.one<{ ciphertext: string }>('SELECT ciphertext FROM key_backups WHERE user_id = $1', [b.id]);
    assert.ok(!stored!.ciphertext.includes(b.identity!.kid));
    assert.equal((await a.get('/api/me/keys/backup')).body.backup.ciphertext !== stored!.ciphertext, true);
    a.closeSockets();
  });

  it('archives and deletes a conversation for one side only', async () => {
    const { a, b, conversationId } = await connectedPair(h, ['arch_a', 'arch_b']);
    await send(a, conversationId, 'keep me for bob');
    await a.patch(`/api/conversations/${conversationId}`, { archived: true });
    let list = await a.get('/api/conversations');
    assert.equal(list.body.conversations.find((c: any) => c.id === conversationId).archived, true);
    await a.del(`/api/conversations/${conversationId}`);
    list = await a.get('/api/conversations');
    assert.ok(!list.body.conversations.some((c: any) => c.id === conversationId));
    const bobSees = await b.get(`/api/conversations/${conversationId}/messages`);
    assert.ok((await texts(b, bobSees.body.messages)).includes('keep me for bob'));
    // A new message brings it back for Alice, without the old history.
    await send(b, conversationId, 'new after delete');
    const aliceSees = await a.get(`/api/conversations/${conversationId}/messages`);
    assert.deepEqual(await texts(a, aliceSees.body.messages), ['new after delete']);
  });

  it('supports disappearing messages that the cleanup job removes', async () => {
    const { a, b, conversationId } = await connectedPair(h, ['ttl_a', 'ttl_b']);
    const r = await a.patch(`/api/conversations/${conversationId}`, { messageTtlSeconds: 86400 });
    assert.equal(r.body.conversation.messageTtlSeconds, 86400);
    const m = await send(a, conversationId, 'this will vanish');
    assert.ok(m.body.message.expiresAt);
    await h.db.query(`UPDATE messages SET expires_at = now() - interval '1 second' WHERE id = $1`, [m.body.message.id]);
    const hidden = await b.get(`/api/conversations/${conversationId}/messages`);
    assert.ok(!hidden.body.messages.some((x: any) => x.id === m.body.message.id), 'expired messages are hidden immediately');
    await h.inst.cleanup.runOnce();
    assert.equal(await h.db.one('SELECT 1 FROM messages WHERE id = $1', [m.body.message.id]), undefined);
    const sys = hidden.body.messages.find((x: any) => x.kind === 'system' && x.system?.type === 'ttl_changed');
    assert.ok(sys);
  });
});

describe('authorization and blocking', () => {
  it('keeps conversations private to their participants', async () => {
    const { a, conversationId } = await connectedPair(h, ['authz_a', 'authz_b']);
    const m = await send(a, conversationId, 'private');
    const eve = new Client(h);
    await eve.register('authz_eve');
    assert.equal((await eve.get(`/api/conversations/${conversationId}/messages`)).status, 404);
    assert.equal((await eve.get(`/api/conversations/${conversationId}`)).status, 404);
    const intrude = await eve.post(`/api/conversations/${conversationId}/messages`, { clientId: randomUUID(), body: await eve.seal(a.id, 'intrude') });
    assert.equal(intrude.status, 404);
    assert.equal((await eve.patch(`/api/messages/${m.body.message.id}`, { body: '' })).status, 404);
    assert.equal((await eve.del(`/api/messages/${m.body.message.id}?for=everyone`)).status, 404);
    assert.equal((await eve.put(`/api/messages/${m.body.message.id}/reaction`, { emoji: '😀' })).status, 404);
    assert.equal((await eve.post(`/api/messages/${m.body.message.id}/forward`, { targets: [{ conversationId, clientId: randomUUID(), body: '' }] })).status, 404);
    assert.equal((await eve.post(`/api/conversations/${conversationId}/read`, { messageId: m.body.message.id })).status, 404);
    // The database itself refuses messages from non-participants.
    await assert.rejects(
      h.db.query(`INSERT INTO messages (conversation_id, sender_id, kind, body) VALUES ($1, $2, 'text', '')`, [conversationId, eve.id]),
      /not a participant/,
    );
  });

  it('blocking stops messages and new conversations; unblocking restores them', async () => {
    const { a, b, conversationId } = await connectedPair(h, ['block_a', 'block_b']);
    await b.post(`/api/users/${a.id}/block`);
    const r = await send(a, conversationId, 'can you hear me');
    assert.equal(r.status, 403);
    assert.equal((await send(b, conversationId, 'blocked side')).body.error.code, 'you_blocked');
    // A different user blocked by B cannot open a chat either.
    const c = new Client(h);
    await c.register('block_c');
    await b.post(`/api/users/${c.id}/block`);
    const start = await c.post('/api/conversations', { userId: b.id });
    assert.equal(start.status, 403);
    // Blocked users can't see the blocker's presence or photo.
    const view = await a.get(`/api/users/${b.id}`);
    assert.equal(view.body.user.presence.online, null);
    const blocks = await b.get('/api/blocks');
    assert.equal(blocks.body.blocked.length, 2);
    await b.del(`/api/users/${a.id}/block`);
    assert.equal((await send(a, conversationId, 'back again')).status, 201);
  });

  it('accepts reports with an optional message excerpt', async () => {
    const { a, b, conversationId } = await connectedPair(h, ['rep_a', 'rep_b']);
    const m = await send(a, conversationId, 'abusive content');
    // The reporter's device decrypts the message and chooses to share its text with moderators.
    const excerpt = await b.textOf(m.body.message);
    const r = await b.post('/api/reports', { userId: a.id, messageId: m.body.message.id, reason: 'harassment', details: 'repeated', excerpt, block: true });
    assert.equal(r.status, 200);
    const row = await h.db.one<{ message_excerpt: string; message_envelope: string }>('SELECT message_excerpt, message_envelope FROM reports WHERE reported_user_id = $1', [a.id]);
    assert.equal(row!.message_excerpt, 'abusive content');
    assert.equal(row!.message_envelope, m.body.message.body);
    assert.ok(await h.db.one('SELECT 1 FROM blocks WHERE blocker_id = $1 AND blocked_id = $2', [b.id, a.id]));
  });

  it('pushes presence to contacts only when allowed', async () => {
    const { a, b } = await connectedPair(h, ['pres_a', 'pres_b']);
    const as = await a.connect();
    const bs = await b.connect();
    const online = await as.waitFor('presence', (d) => d.userId === b.id && d.online === true);
    assert.ok(online);
    bs.close();
    const offline = await as.waitFor('presence', (d) => d.userId === b.id && d.online === false);
    assert.ok(offline.lastSeenAt);
    await b.patch('/api/me/privacy', { onlineStatus: 'nobody', lastSeen: 'nobody' });
    await b.connect();
    assert.ok(await as.expectNone('presence', (d) => d.userId === b.id));
    a.closeSockets();
    b.closeSockets();
    await sleep(50);
  });
});
