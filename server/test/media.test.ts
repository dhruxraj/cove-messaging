import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import sharp from 'sharp';
import { Client, connectedPair, ORIGIN, sleep, startHarness, type Harness } from './helpers/harness';
import * as fx from './helpers/fixtures';

let h: Harness;
before(async () => {
  h = await startHarness();
});
after(async () => {
  await h.close();
});

const upload = (c: Client, conversationId: string, data: Buffer, name: string, opts: { policy?: string; voice?: boolean } = {}) =>
  c.req('POST', `/api/uploads?conversationId=${conversationId}&name=${encodeURIComponent(name)}&policy=${opts.policy ?? 'normal'}&voice=${opts.voice ? 1 : 0}`, {
    body: data,
    headers: { 'content-type': 'application/octet-stream' },
  });

async function sendMedia(c: Client, conversationId: string, data: Buffer, name: string, opts: { policy?: string; voice?: boolean; body?: string } = {}) {
  const up = await upload(c, conversationId, data, name, opts);
  assert.equal(up.status, 201, JSON.stringify(up.body));
  const body = opts.body ? await c.seal(await c.peerIn(conversationId), opts.body) : '';
  const m = await c.post(`/api/conversations/${conversationId}/messages`, { clientId: randomUUID(), attachmentId: up.body.attachment.id, body });
  assert.equal(m.status, 201, JSON.stringify(m.body));
  return { attachment: up.body.attachment, message: m.body.message };
}

const objectExists = async (attachmentId: string) => {
  const row = await h.db.one<{ storage_key: string }>('SELECT storage_key FROM attachments WHERE id = $1', [attachmentId]);
  return row ? fs.existsSync(path.join(h.storageDir, 'objects', row.storage_key)) : false;
};

describe('images', () => {
  it('stores photos privately, strips EXIF/GPS, makes a thumbnail and serves only to participants', async () => {
    const { a, b, conversationId } = await connectedPair(h, ['img_a', 'img_b']);
    const original = await fx.jpegWithGps();
    assert.ok((await sharp(original).metadata()).exif, 'fixture has EXIF');
    const { attachment, message } = await sendMedia(a, conversationId, original, 'holiday.jpg', { body: 'look!' });
    assert.equal(attachment.kind, 'image');
    assert.equal(attachment.hasThumbnail, true);
    assert.equal(message.kind, 'image');

    const got = await b.get(`/api/attachments/${attachment.id}/content`);
    assert.equal(got.status, 200);
    assert.equal(got.headers.get('content-type'), 'image/jpeg');
    assert.match(got.headers.get('content-security-policy') ?? '', /sandbox/);
    assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
    const meta = await sharp(got.body).metadata();
    assert.equal(meta.exif, undefined, 'EXIF (incl. GPS) removed');
    assert.ok(!got.body.includes(Buffer.from('secret-owner')));

    assert.equal((await a.get(`/api/attachments/${attachment.id}/content`)).status, 200, 'sender can view normal media');
    assert.equal((await b.get(`/api/attachments/${attachment.id}/thumbnail`)).headers.get('content-type'), 'image/webp');

    const eve = new Client(h);
    await eve.register('img_eve');
    assert.equal((await eve.get(`/api/attachments/${attachment.id}/content`)).status, 404);
    assert.equal((await eve.get(`/api/attachments/${attachment.id}/thumbnail`)).status, 404);
    assert.equal((await new Client(h).get(`/api/attachments/${attachment.id}/content`)).status, 401);
    // Storage keys never appear in API output.
    const key = (await h.db.one<{ storage_key: string }>('SELECT storage_key FROM attachments WHERE id = $1', [attachment.id]))!.storage_key;
    const hist = await b.get(`/api/conversations/${conversationId}/messages`);
    assert.ok(!JSON.stringify(hist.body).includes(key));
  });

  it('re-encodes images so appended payloads (polyglots) are dropped', async () => {
    const { a, b, conversationId } = await connectedPair(h, ['poly_a', 'poly_b']);
    const polyglot = Buffer.concat([await fx.png(), Buffer.from('<script>alert(1)</script><html>')]);
    const { attachment } = await sendMedia(a, conversationId, polyglot, 'x.png');
    const got = await b.get(`/api/attachments/${attachment.id}/content`);
    assert.ok(!got.body.includes(Buffer.from('<script>')));
  });

  it('removes files deleted for everyone from storage', async () => {
    const { a, b, conversationId } = await connectedPair(h, ['del_a', 'del_b']);
    const { attachment, message } = await sendMedia(a, conversationId, await fx.png(), 'bye.png');
    const key = (await h.db.one<{ storage_key: string }>('SELECT storage_key FROM attachments WHERE id = $1', [attachment.id]))!.storage_key;
    assert.ok(fs.existsSync(path.join(h.storageDir, 'objects', key)));
    await a.del(`/api/messages/${message.id}?for=everyone`);
    assert.equal((await b.get(`/api/attachments/${attachment.id}/content`)).status, 404);
    await h.inst.cleanup.runOnce();
    assert.ok(!fs.existsSync(path.join(h.storageDir, 'objects', key)), 'bytes deleted');
  });
});

describe('file validation', () => {
  it('rejects disallowed or disguised files by content, not by name', async () => {
    const { a, conversationId } = await connectedPair(h, ['val_a', 'val_b']);
    const cases: [Buffer, string][] = [
      [fx.exe(), 'setup.exe'],
      [fx.exe(), 'invoice.pdf'],
      [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'logo.svg'],
      [Buffer.from('<html><script>alert(1)</script></html>'), 'page.html'],
      [Buffer.from(Array.from({ length: 512 }, (_, i) => (i * 37) % 256)), 'photo.png'],
      [Buffer.from('#!/bin/sh\nrm -rf /\n'), 'script.sh'],
    ];
    for (const [data, name] of cases) {
      const r = await upload(a, conversationId, data, name);
      assert.equal(r.status, 415, `${name} should be rejected`);
      assert.equal(r.body.error.code, 'unsupported_file');
    }
    const fakeOffice = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(600)]);
    assert.equal((await upload(a, conversationId, fakeOffice, 'installer.msi')).status, 415);
  });

  it('accepts documents and identifies Office files inside ZIP containers', async () => {
    const { a, b, conversationId } = await connectedPair(h, ['docs_a', 'docs_b']);
    const pdf = await upload(a, conversationId, fx.minimalPdf(), 'report.pdf');
    assert.equal(pdf.body.attachment.mime, 'application/pdf');
    const doc = await upload(a, conversationId, fx.docx(), 'letter.docx');
    assert.match(doc.body.attachment.mime, /wordprocessingml/);
    const sheet = await upload(a, conversationId, fx.xlsx(), 'numbers.xlsx');
    assert.match(sheet.body.attachment.mime, /spreadsheetml/);
    const z = await upload(a, conversationId, fx.zip({ 'a.txt': 'hi' }), 'bundle.zip');
    assert.equal(z.body.attachment.mime, 'application/zip');
    const txt = await upload(a, conversationId, Buffer.from('<script>alert(1)</script> just text'), 'notes.txt');
    assert.equal(txt.status, 201);
    const m = await a.post(`/api/conversations/${conversationId}/messages`, { clientId: randomUUID(), attachmentId: txt.body.attachment.id });
    const got = await b.get(`/api/attachments/${m.body.message.attachment.id}/content`);
    // Documents are always downloads, never rendered by the browser.
    assert.match(got.headers.get('content-disposition') ?? '', /^attachment; filename="notes.txt"/);
    assert.equal(got.headers.get('content-type'), 'text/plain');
    const invalidUtf8 = await upload(a, conversationId, Buffer.from([0xff, 0xfe, 0x41, 0x00, 0x42]), 'bad.txt');
    assert.equal(invalidUtf8.status, 415);
  });

  it('enforces per-type size limits', async () => {
    const { a, conversationId } = await connectedPair(h, ['size_a', 'size_b']);
    const big = await fx.noisyPng(1400, 1100); // > 4 MB image limit in tests
    assert.ok(big.length > 4 * 1024 * 1024);
    const r = await upload(a, conversationId, big, 'huge.png');
    assert.equal(r.status, 413);
    assert.equal(r.body.error.code, 'file_too_large');
    const bigPdf = Buffer.concat([fx.minimalPdf(), Buffer.alloc(3.5 * 1024 * 1024, 0x20)]);
    assert.equal((await upload(a, conversationId, bigPdf, 'big.pdf')).status, 413);
  });

  it('rejects an upload whose declared size exceeds the maximum before reading it', async () => {
    const { a, conversationId } = await connectedPair(h, ['decl_a', 'decl_b']);
    const status = await new Promise<number>((resolve, reject) => {
      const u = new URL(`${h.base}/api/uploads?conversationId=${conversationId}&name=x.bin`);
      const req = http.request(u, {
        method: 'POST',
        headers: { origin: ORIGIN, cookie: a.cookieHeader(), 'x-csrf-token': a.csrf, 'x-forwarded-for': a.ip, 'content-length': String(500 * 1024 * 1024) },
      });
      req.on('response', (res) => resolve(res.statusCode!));
      req.on('error', reject);
      req.write(Buffer.alloc(10));
    });
    assert.equal(status, 413);
  });

  it('leaves nothing behind when an upload is interrupted', async () => {
    const { a, conversationId } = await connectedPair(h, ['intr_a', 'intr_b']);
    const before = (await h.db.one<{ n: number }>('SELECT count(*)::int AS n FROM attachments'))!.n;
    await new Promise<void>((resolve) => {
      const u = new URL(`${h.base}/api/uploads?conversationId=${conversationId}&name=x.pdf`);
      const req = http.request(u, {
        method: 'POST',
        headers: { origin: ORIGIN, cookie: a.cookieHeader(), 'x-csrf-token': a.csrf, 'x-forwarded-for': a.ip, 'content-length': String(2 * 1024 * 1024) },
      });
      req.on('error', () => resolve());
      req.write(fx.minimalPdf());
      req.write(Buffer.alloc(256 * 1024));
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 200);
    });
    await sleep(400);
    const afterCount = (await h.db.one<{ n: number }>('SELECT count(*)::int AS n FROM attachments'))!.n;
    assert.equal(afterCount, before);
    assert.deepEqual(fs.readdirSync(path.join(h.storageDir, 'tmp')), [], 'temp file removed');
  });
});

describe('video and audio', () => {
  it('accepts MP4 video, strips container metadata, makes a thumbnail and supports range requests', async () => {
    const { a, b, conversationId } = await connectedPair(h, ['vid_a', 'vid_b']);
    const { attachment } = await sendMedia(a, conversationId, fx.mp4WithLocation(), 'clip.mp4');
    assert.equal(attachment.kind, 'video');
    assert.equal(attachment.mime, 'video/mp4');
    assert.equal(attachment.width, 320);
    assert.ok(attachment.durationMs >= 1900 && attachment.durationMs <= 2200, String(attachment.durationMs));
    assert.equal(attachment.hasThumbnail, true);
    const ranged = await b.get(`/api/attachments/${attachment.id}/content`, { headers: { range: 'bytes=0-1023' } });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.body.length, 1024);
    assert.match(ranged.headers.get('content-range') ?? '', /^bytes 0-1023\/\d+$/);
    const full = await b.get(`/api/attachments/${attachment.id}/content`);
    const tmp = path.join(os.tmpdir(), `cove-dl-${randomUUID()}.mp4`);
    fs.writeFileSync(tmp, full.body);
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', tmp]).toString());
    fs.rmSync(tmp);
    assert.ok(probe.streams.some((s: any) => s.codec_type === 'video'));
    assert.equal(probe.format.tags?.location, undefined, 'GPS location removed');
    assert.equal(probe.format.tags?.title, undefined);
    const bad = await b.get(`/api/attachments/${attachment.id}/content`, { headers: { range: 'bytes=999999999-' } });
    assert.equal(bad.status, 416);
  });

  it('turns browser voice recordings into MP3 that every browser can play', async () => {
    const { a, b, conversationId } = await connectedPair(h, ['voice_a', 'voice_b']);
    const { attachment, message } = await sendMedia(a, conversationId, fx.webmOpusVoice(), 'recording.webm', { voice: true });
    assert.equal(attachment.kind, 'voice');
    assert.equal(attachment.mime, 'audio/mpeg');
    assert.equal(attachment.fileName, 'Voice message.mp3');
    assert.ok(attachment.durationMs >= 1800 && attachment.durationMs <= 2300, String(attachment.durationMs));
    assert.equal(message.kind, 'voice');
    const got = await b.get(`/api/attachments/${attachment.id}/content`);
    assert.equal(got.status, 200);
    assert.equal(got.headers.get('content-type'), 'audio/mpeg');
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-'], { input: got.body }).toString());
    assert.equal(probe.streams[0].codec_name, 'mp3');
    assert.equal(probe.streams[0].channels, 1);
  });

  it('rejects non-audio sent as a voice message', async () => {
    const { a, conversationId } = await connectedPair(h, ['voice2_a', 'voice2_b']);
    const r = await upload(a, conversationId, fx.minimalPdf(), 'x.webm', { voice: true });
    assert.equal(r.status, 415);
  });
});

describe('view once / view twice', () => {
  async function openView(c: Client, attachmentId: string) {
    return c.post(`/api/attachments/${attachmentId}/views`);
  }
  async function fetchView(c: Client, attachmentId: string, token: string, range?: string) {
    return c.get(`/api/attachments/${attachmentId}/protected`, { headers: { 'x-view-token': token, ...(range ? { range } : {}) } });
  }

  it('allows exactly one view, then denies further access and deletes the original', async () => {
    const { a, b, conversationId } = await connectedPair(h, ['once_a', 'once_b']);
    const as = await a.connect();
    const photo = await fx.png(200, 150);
    const { attachment, message } = await sendMedia(a, conversationId, photo, 'secret.png', { policy: 'once' });
    assert.equal(attachment.hasThumbnail, false, 'no preview for view-once media');
    assert.equal(message.attachment.state, 'unopened');
    assert.equal(message.attachment.canView, false, 'the sender cannot open it');

    // The ordinary content and thumbnail routes refuse protected media.
    assert.equal((await b.get(`/api/attachments/${attachment.id}/content`)).status, 403);
    assert.equal((await b.get(`/api/attachments/${attachment.id}/thumbnail`)).status, 404);
    assert.equal((await openView(a, attachment.id)).status, 404, 'sender has no grant');

    const hist = await b.get(`/api/conversations/${conversationId}/messages`);
    const forB = hist.body.messages.find((m: any) => m.id === message.id).attachment;
    assert.equal(forB.canView, true);
    assert.equal(forB.viewsRemaining, 1);
    assert.equal(forB.fileName, undefined);

    const v = await openView(b, attachment.id);
    assert.equal(v.status, 200);
    assert.equal(v.body.viewsRemaining, 0);
    const bytes = await fetchView(b, attachment.id, v.body.token);
    assert.equal(bytes.status, 200);
    assert.equal(bytes.headers.get('cache-control'), 'no-store, max-age=0');
    assert.ok((await sharp(bytes.body).metadata()).width === 200);

    // Refresh / new tab / replay: all denied.
    assert.equal((await fetchView(b, attachment.id, v.body.token)).status, 410);
    const again = await openView(b, attachment.id);
    assert.equal(again.status, 410);
    assert.equal(again.body.error.code, 'views_exhausted');

    const senderSees = await as.waitFor('message:updated', (d) => d.message.id === message.id && d.message.attachment?.state === 'opened');
    assert.ok(senderSees);
    await sleep(150);
    await h.inst.cleanup.runOnce();
    const row = await h.db.one<{ purged_at: Date | null }>('SELECT purged_at FROM attachments WHERE id = $1', [attachment.id]);
    assert.ok(row!.purged_at, 'original purged');
    assert.equal(await objectExists(attachment.id), false);
    a.closeSockets();
  });

  it('allows two views for view-twice and shows the remaining count', async () => {
    const { a, b, conversationId } = await connectedPair(h, ['twice_a', 'twice_b']);
    const { attachment } = await sendMedia(a, conversationId, await fx.png(), 'twice.png', { policy: 'twice' });
    const v1 = await openView(b, attachment.id);
    assert.equal(v1.body.viewsRemaining, 1);
    await fetchView(b, attachment.id, v1.body.token);
    let hist = await b.get(`/api/conversations/${conversationId}/messages`);
    let att = hist.body.messages.at(-1).attachment;
    assert.equal(att.state, 'partially_viewed');
    assert.equal(att.viewsRemaining, 1);
    const v2 = await openView(b, attachment.id);
    assert.equal(v2.status, 200);
    assert.equal(v2.body.viewsRemaining, 0);
    await fetchView(b, attachment.id, v2.body.token);
    assert.equal((await openView(b, attachment.id)).status, 410);
    hist = await a.get(`/api/conversations/${conversationId}/messages`);
    att = hist.body.messages.at(-1).attachment;
    assert.equal(att.state, 'opened');
    assert.equal(att.viewsUsed, 2);
  });

  it('cannot be exceeded by simultaneous requests', async () => {
    const { a, b, conversationId } = await connectedPair(h, ['race_a', 'race_b']);
    const { attachment } = await sendMedia(a, conversationId, await fx.png(), 'race.png', { policy: 'twice' });
    const results = await Promise.all(Array.from({ length: 12 }, () => openView(b, attachment.id)));
    assert.equal(results.filter((r) => r.status === 200).length, 2);
    assert.equal(results.filter((r) => r.status === 410).length, 10);
    const g = await h.db.one<{ views_used: number }>('SELECT views_used FROM media_access_grants WHERE attachment_id = $1 AND user_id = $2', [attachment.id, b.id]);
    assert.equal(g!.views_used, 2);
    // The database constraint makes over-counting impossible even for buggy code.
    await assert.rejects(h.db.query('UPDATE media_access_grants SET views_used = 3 WHERE attachment_id = $1 AND user_id = $2', [attachment.id, b.id]), /views_within_limit/);
  });

  it('binds viewing tokens to the user and login session', async () => {
    const { a, b, conversationId } = await connectedPair(h, ['bind_a', 'bind_b']);
    const { attachment } = await sendMedia(a, conversationId, await fx.png(), 'bind.png', { policy: 'once' });
    const v = await openView(b, attachment.id);
    // Another user with a stolen token gets nothing.
    assert.equal((await fetchView(a, attachment.id, v.body.token)).status, 410);
    // The same user after signing in again (new session) cannot reuse the old token.
    const b2 = new Client(h);
    await b2.signIn(b.me.email, 'login');
    assert.equal((await fetchView(b2, attachment.id, v.body.token)).status, 410);
  });

  it('gives the view back if the media never started loading, but not after delivery began', async () => {
    const { a, b, conversationId } = await connectedPair(h, ['refund_a', 'refund_b']);
    const { attachment } = await sendMedia(a, conversationId, await fx.png(300, 300), 'refund.png', { policy: 'once' });
    // 1) opened, but the content request never happened (network failure) → refunded
    const v1 = await openView(b, attachment.id);
    assert.equal(v1.status, 200);
    await h.db.query(`UPDATE media_view_sessions SET expires_at = now() - interval '1 second' WHERE attachment_id = $1`, [attachment.id]);
    await h.inst.cleanup.runOnce();
    const g = await h.db.one<{ views_used: number }>('SELECT views_used FROM media_access_grants WHERE attachment_id = $1 AND user_id = $2', [attachment.id, b.id]);
    assert.equal(g!.views_used, 0);
    // 2) delivery started (partial range), then interrupted → can resume within the session…
    const v2 = await openView(b, attachment.id);
    const part = await fetchView(b, attachment.id, v2.body.token, 'bytes=0-99');
    assert.equal(part.status, 206);
    const rest = await fetchView(b, attachment.id, v2.body.token, 'bytes=100-');
    assert.equal(rest.status, 206);
    // …and once delivered it counts, with no refund.
    assert.equal((await openView(b, attachment.id)).status, 410);
  });

  it('respects the recipient’s choice not to receive view-once media', async () => {
    const { a, b, conversationId } = await connectedPair(h, ['optout_a', 'optout_b']);
    await b.patch('/api/me/privacy', { allowProtectedMedia: false });
    const r = await upload(a, conversationId, await fx.png(), 'x.png', { policy: 'once' });
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'protected_media_not_allowed');
    await b.patch(`/api/conversations/${conversationId}`, { allowProtectedMedia: true });
    assert.equal((await upload(a, conversationId, await fx.png(), 'x.png', { policy: 'once' })).status, 201);
  });

  it('cannot be forwarded, and documents cannot be view-once', async () => {
    const { a, b, conversationId } = await connectedPair(h, ['fwd_a', 'fwd_b']);
    const { message } = await sendMedia(a, conversationId, await fx.png(), 'x.png', { policy: 'once' });
    const r = await b.post(`/api/messages/${message.id}/forward`, { targets: [{ conversationId, clientId: randomUUID(), body: '' }] });
    assert.equal(r.status, 400);
    const doc = await upload(a, conversationId, fx.minimalPdf(), 'x.pdf', { policy: 'once' });
    assert.equal(doc.status, 400);
  });

  it('supports view-once video and voice messages', async () => {
    const { a, b, conversationId } = await connectedPair(h, ['ovid_a', 'ovid_b']);
    const vid = await sendMedia(a, conversationId, fx.mp4WithLocation(), 'v.mp4', { policy: 'once' });
    assert.equal(vid.attachment.hasThumbnail, false);
    const v = await openView(b, vid.attachment.id);
    const bytes = await fetchView(b, vid.attachment.id, v.body.token);
    assert.equal(bytes.headers.get('content-type'), 'video/mp4');
    const voice = await sendMedia(a, conversationId, fx.webmOpusVoice(), 'r.webm', { policy: 'once', voice: true });
    assert.equal(voice.attachment.kind, 'voice');
  });

  it('expires unopened view-once media after its lifetime', async () => {
    const { a, b, conversationId } = await connectedPair(h, ['exp_a', 'exp_b']);
    const { attachment } = await sendMedia(a, conversationId, await fx.png(), 'old.png', { policy: 'once' });
    await h.db.query(`UPDATE attachments SET expires_at = now() - interval '1 second' WHERE id = $1`, [attachment.id]);
    const r = await openView(b, attachment.id);
    assert.equal(r.status, 410);
    assert.equal(r.body.error.code, 'media_expired');
    await h.inst.cleanup.runOnce();
    assert.equal(await objectExists(attachment.id), false);
    const hist = await b.get(`/api/conversations/${conversationId}/messages`);
    assert.equal(hist.body.messages.at(-1).attachment.state, 'expired');
  });
});
