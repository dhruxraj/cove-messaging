#!/usr/bin/env node
// Development-only SMTP mailbox. Point the server at it (SMTP_HOST=127.0.0.1, SMTP_PORT=1025)
// and sign-in emails are printed here instead of being delivered. Never use in production.
import net from 'node:net';

const PORT = Number(process.env.MAILBOX_PORT ?? 1025);

function decodeQP(s) {
  return s.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}
function plainText(raw) {
  for (const part of raw.split(/\r?\n--[^\r\n]+\r?\n/)) {
    if (/content-type:\s*text\/plain/i.test(part)) {
      const [head, ...rest] = part.split(/\r?\n\r?\n/);
      const body = rest.join('\n\n');
      if (/quoted-printable/i.test(head)) return decodeQP(body);
      if (/base64/i.test(head)) return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
      return body;
    }
  }
  return raw;
}
function subjectOf(raw) {
  const header = raw.split(/\r?\n\r?\n/)[0] ?? '';
  const s = (/^subject:\s*(.*(?:\r?\n[ \t].*)*)/im.exec(header)?.[1] ?? '').replace(/\r?\n[ \t]/g, ' ');
  return s.replace(/=\?utf-8\?([BQ])\?([^?]*)\?=/gi, (_, e, d) => (e.toUpperCase() === 'B' ? Buffer.from(d, 'base64').toString('utf8') : decodeQP(d.replace(/_/g, ' '))));
}

net
  .createServer((socket) => {
    let buf = '';
    let data = '';
    let inData = false;
    let rcpt = [];
    const reply = (s) => socket.write(s + '\r\n');
    reply('220 localhost dev-mailbox');
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      for (;;) {
        if (inData) {
          data += buf;
          buf = '';
          const end = data.indexOf('\r\n.\r\n');
          if (end === -1) return;
          buf = data.slice(end + 5);
          const raw = data.slice(0, end);
          data = '';
          inData = false;
          console.log('\n' + '─'.repeat(60));
          console.log(`To:      ${rcpt.join(', ')}`);
          console.log(`Subject: ${subjectOf(raw)}`);
          console.log('─'.repeat(60));
          console.log(plainText(raw).trim());
          rcpt = [];
          reply('250 OK');
          continue;
        }
        const nl = buf.indexOf('\r\n');
        if (nl === -1) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO') socket.write('250-localhost\r\n250-8BITMIME\r\n250 SMTPUTF8\r\n');
        else if (cmd === 'RCPT') {
          const m = /<([^>]+)>/.exec(line);
          if (m) rcpt.push(m[1]);
          reply('250 OK');
        } else if (cmd === 'DATA') {
          inData = true;
          reply('354 go ahead');
        } else if (cmd === 'QUIT') {
          reply('221 bye');
          socket.end();
        } else reply('250 OK');
      }
    });
    socket.on('error', () => {});
  })
  .listen(PORT, '127.0.0.1', () => console.log(`dev mailbox listening on 127.0.0.1:${PORT} — emails will be printed here`));
