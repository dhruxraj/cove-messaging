import nodemailer from 'nodemailer';
import type { Config } from '../config';
import { log } from './log';

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  send(mail: OutgoingMail): Promise<void>;
  close(): void;
}

export function createMailer(cfg: Config): Mailer {
  const transport = nodemailer.createTransport({
    host: cfg.SMTP_HOST,
    port: cfg.SMTP_PORT,
    secure: cfg.SMTP_SECURE,
    requireTLS: cfg.smtpRequireTls,
    auth: cfg.SMTP_USER ? { user: cfg.SMTP_USER, pass: cfg.SMTP_PASS ?? '' } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    tls: { minVersion: 'TLSv1.2' },
  });
  return {
    async send(mail) {
      try {
        await transport.sendMail({
          from: cfg.MAIL_FROM,
          to: mail.to,
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
          headers: { 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'All' },
        });
      } catch (err) {
        // Never log the message body: it may contain a one-time code.
        log.error('email delivery failed', { err: { message: (err as Error).message, code: (err as { code?: string }).code } });
        throw err;
      }
    },
    close: () => transport.close(),
  };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function layout(appName: string, heading: string, bodyHtml: string): string {
  return `<!doctype html><html><body style="margin:0;background:#f4f5f2;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1d2420">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" style="max-width:480px;background:#ffffff;border-radius:16px;padding:32px" cellpadding="0" cellspacing="0">
<tr><td style="font-size:15px;font-weight:600;letter-spacing:.02em;color:#24614f">${esc(appName)}</td></tr>
<tr><td style="padding-top:16px;font-size:20px;font-weight:600">${esc(heading)}</td></tr>
<tr><td style="padding-top:12px;font-size:15px;line-height:1.55;color:#3c4741">${bodyHtml}</td></tr>
</table></td></tr></table></body></html>`;
}

const codeBlock = (code: string) =>
  `<div style="margin:20px 0;font-size:32px;font-weight:700;letter-spacing:.3em;font-family:ui-monospace,Menlo,Consolas,monospace;color:#1d2420">${esc(code)}</div>`;

export const emails = {
  registerCode(appName: string, to: string, code: string, ttlMin: number): OutgoingMail {
    return {
      to,
      subject: `Verify your email for ${appName}`,
      text: `Your ${appName} verification code is ${code}\n\nIt expires in ${ttlMin} minutes and can be used once.\nIf you didn't try to create an account, you can ignore this email.`,
      html: layout(appName, 'Confirm your email', `Use this code to finish creating your account:${codeBlock(code)}It expires in ${ttlMin} minutes and can be used once. If you didn't try to create an account, you can ignore this email.`),
    };
  },
  loginCode(appName: string, to: string, code: string, ttlMin: number, alreadyRegistered: boolean): OutgoingMail {
    const intro = alreadyRegistered
      ? `You tried to create an account, but this address already has one. Use this code to sign in instead:`
      : `Use this code to sign in:`;
    return {
      to,
      subject: `Your ${appName} sign-in code`,
      text: `${intro}\n\n${code}\n\nIt expires in ${ttlMin} minutes and can be used once. Signing in ends your session on any other device.\nIf this wasn't you, ignore this email — nobody can sign in without the code.`,
      html: layout(appName, 'Sign in', `${esc(intro)}${codeBlock(code)}It expires in ${ttlMin} minutes and can be used once. Signing in ends your session on any other device.<br><br>If this wasn't you, ignore this email — nobody can sign in without the code.`),
    };
  },
  noAccount(appName: string, to: string, origin: string): OutgoingMail {
    return {
      to,
      subject: `Sign-in attempt on ${appName}`,
      text: `Someone tried to sign in to ${appName} with this address, but there is no account for it.\n\nIf that was you, create an account at ${origin}/register\nOtherwise you can ignore this email.`,
      html: layout(appName, 'No account found', `Someone tried to sign in with this address, but there is no account for it.<br><br>If that was you, <a href="${esc(origin)}/register" style="color:#24614f">create an account</a>. Otherwise you can ignore this email.`),
    };
  },
  deleteCode(appName: string, to: string, code: string, ttlMin: number): OutgoingMail {
    return {
      to,
      subject: `Confirm deleting your ${appName} account`,
      text: `Your code to permanently delete your ${appName} account is ${code}\n\nIt expires in ${ttlMin} minutes. If you didn't ask to delete your account, sign in and end all sessions.`,
      html: layout(appName, 'Delete your account', `Enter this code to permanently delete your account and all of your messages and media:${codeBlock(code)}It expires in ${ttlMin} minutes. If you didn't ask for this, sign in and end all sessions from Settings.`),
    };
  },
  newSignIn(appName: string, to: string, info: { when: string; device: string; ip: string; replaced: boolean }): OutgoingMail {
    const replacedLine = info.replaced ? 'Your previous session was signed out.' : '';
    return {
      to,
      subject: `New sign-in to your ${appName} account`,
      text: `Your account was just signed in.\n\nWhen: ${info.when}\nDevice: ${info.device}\nIP address: ${info.ip}\n${replacedLine}\n\nIf this wasn't you, someone has access to your email. Secure your Google account, then sign in to ${appName} again — that ends their session.`,
      html: layout(appName, 'New sign-in', `Your account was just signed in.<br><br><b>When:</b> ${esc(info.when)}<br><b>Device:</b> ${esc(info.device)}<br><b>IP address:</b> ${esc(info.ip)}<br>${esc(replacedLine)}<br><br>If this wasn't you, someone has access to your email. Secure your Google account, then sign in again — that ends their session.`),
    };
  },
};

/** Coarse, human-readable device description from a user agent (no fingerprinting). */
export function describeUserAgent(ua: string | undefined | null): string {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Unknown OS';
  return `${browser} on ${os}`;
}
