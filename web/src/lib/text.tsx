import type { ReactNode } from 'react';

/**
 * Message text hygiene. The server can no longer clean message text (it is end-to-end encrypted),
 * so the sender cleans before encrypting and every reader strips spoofing characters before display.
 * Text is always rendered as text nodes by React — never as HTML.
 */
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;
const BIDI_OVERRIDE = /[‪-‮⁦-⁩‎‏؜]/g;
const ZERO_WIDTH_RUN = /[​-‍﻿]{2,}/g;

export function cleanMessageText(input: string): string {
  return input
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL, '')
    .replace(BIDI_OVERRIDE, '')
    .replace(ZERO_WIDTH_RUN, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

/** Applied to text received from others before rendering. */
export const displayText = (s: string) => s.replace(CONTROL, '').replace(BIDI_OVERRIDE, '');

export const MAX_MESSAGE_CHARS = 4096;

const URL_RE = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,:;!?)\]}]/gi;

/** Text with http(s) links made clickable. Other schemes (javascript:, data:) are never linked. */
export function linkify(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const i = m.index ?? 0;
    let url = m[0];
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') continue;
      url = u.href;
    } catch {
      continue;
    }
    if (i > last) out.push(text.slice(last, i));
    out.push(
      <a key={i} href={url} target="_blank" rel="noopener noreferrer nofollow">
        {m[0]}
      </a>,
    );
    last = i + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const EMOJI_ONLY = /^(?:(?:\p{Extended_Pictographic}|\p{Regional_Indicator}{2})(?:[\u{1F3FB}-\u{1F3FF}️⃣]|‍(?:\p{Extended_Pictographic}|[♀♂⚕⚖✈❤]))*️?\s*){1,3}$/u;

/** One to three emoji and nothing else: shown large, like other messengers. */
export const isJumboEmoji = (s: string) => s.length <= 40 && EMOJI_ONLY.test(s.trim());
