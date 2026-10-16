import net from 'node:net';

export interface CapturedMail {
  to: string[];
  raw: string;
  subject: string;
  text: string;
  receivedAt: number;
}

function decodeQuotedPrintable(s: string) {
  return s.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

function decodeSubject(s: string) {
  return s.replace(/=\?utf-8\?([BQ])\?([^?]*)\?=/gi, (_, enc: string, data: string) =>
    enc.toUpperCase() === 'B' ? Buffer.from(data, 'base64').toString('utf8') : decodeQuotedPrintable(data.replace(/_/g, ' ')),
  );
}

/** Extract the text/plain part of a (possibly multipart) message. */
function plainText(raw: string): string {
  const parts = raw.split(/\r?\n--[^\r\n]+\r?\n/);
  for (const p of parts) {
    if (/content-type:\s*text\/plain/i.test(p)) {
      const [head, ...rest] = p.split(/\r?\n\r?\n/);
      const bodyText = rest.join('\n\n');
      if (/content-transfer-encoding:\s*quoted-printable/i.test(head ?? '')) return decodeQuotedPrintable(bodyText);
      if (/content-transfer-encoding:\s*base64/i.test(head ?? '')) return Buffer.from(bodyText.replace(/\s+/g, ''), 'base64').toString('utf8');
      return bodyText;
    }
  }
  return raw;
}

/**
 * Minimal SMTP server for tests and local development. It accepts mail without auth/TLS and keeps
 * it in memory, so tests exercise the real nodemailer → SMTP path.
 */
export class SmtpSink {
  private server = net.createServer((s) => this.handle(s));
  readonly mails: CapturedMail[] = [];
  private waiters: { match: (m: CapturedMail) => boolean; resolve: (m: CapturedMail) => void }[] = [];
  port = 0;

  async start(port = 0) {
    await new Promise<void>((r) => this.server.listen(port, '127.0.0.1', () => r()));
    this.port = (this.server.address() as net.AddressInfo).port;
    return this;
  }

  async stop() {
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  private handle(socket: net.Socket) {
    let buf = '';
    let inData = false;
    let data = '';
    let rcpt: string[] = [];
    const reply = (s: string) => socket.write(s + '\r\n');
    reply('220 localhost ESMTP sink');
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      for (;;) {
        if (inData) {
          data += buf;
          buf = '';
          const end = data.indexOf('\r\n.\r\n');
          if (end === -1) return;
          buf = data.slice(end + 5);
          const message = data.slice(0, end);
          inData = false;
          this.store(rcpt, message.replace(/\r\n\.\./g, '\r\n.'));
          data = '';
          rcpt = [];
          reply('250 OK queued');
          continue;
        }
        const nl = buf.indexOf('\r\n');
        if (nl === -1) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO') socket.write('250-localhost\r\n250-8BITMIME\r\n250 SMTPUTF8\r\n');
        else if (cmd === 'HELO') reply('250 localhost');
        else if (cmd === 'MAIL') reply('250 OK');
        else if (cmd === 'RCPT') {
          const m = /<([^>]+)>/.exec(line);
          if (m) rcpt.push(m[1]!.toLowerCase());
          reply('250 OK');
        } else if (cmd === 'DATA') {
          inData = true;
          reply('354 End data with <CR><LF>.<CR><LF>');
        } else if (cmd === 'QUIT') {
          reply('221 Bye');
          socket.end();
        } else reply('250 OK');
      }
    });
    socket.on('error', () => {});
  }

  private store(to: string[], raw: string) {
    const header = raw.split(/\r?\n\r?\n/)[0] ?? '';
    const subject = decodeSubject((/^subject:\s*(.*(?:\r?\n[ \t].*)*)/im.exec(header)?.[1] ?? '').replace(/\r?\n[ \t]/g, ' '));
    const mail: CapturedMail = { to, raw, subject, text: plainText(raw), receivedAt: Date.now() };
    this.mails.push(mail);
    for (const w of [...this.waiters]) {
      if (w.match(mail)) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve(mail);
      }
    }
  }

  /** Wait for the next mail to `to` received after `since` (default: now). */
  next(to: string, since = Date.now() - 50, timeoutMs = 5000): Promise<CapturedMail> {
    const match = (m: CapturedMail) => m.to.includes(to.toLowerCase()) && m.receivedAt >= since;
    const found = [...this.mails].reverse().find(match);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no mail for ${to}`)), timeoutMs);
      this.waiters.push({ match, resolve: (m) => (clearTimeout(t), resolve(m)) });
    });
  }

  static codeIn(mail: CapturedMail): string | null {
    return /\b(\d{6})\b/.exec(mail.text)?.[1] ?? null;
  }
}
