/**
 * Text hygiene for user-supplied strings. Output is always rendered as text (never HTML) by the
 * client, so this is about integrity, not XSS: strip control characters and bidi overrides that
 * can be used to spoof names, normalise Unicode, and bound length.
 */
// C0/C1 controls except \t and \n, plus zero-width / bidi formatting characters used for spoofing.
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;
const BIDI = /[‎‏‪-‮⁦-⁩؜]/g;
const ZERO_WIDTH_RUN = /[​-‍﻿]{2,}/g;

export function cleanMultiline(input: string): string {
  return input
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL, '')
    .replace(BIDI, '')
    .replace(ZERO_WIDTH_RUN, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

export function cleanSingleLine(input: string): string {
  return input
    .normalize('NFC')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(CONTROL, '')
    .replace(BIDI, '')
    .replace(/[​-‍﻿]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Sanitise an uploaded file name: keep the readable name, drop paths and dangerous characters. */
export function cleanFileName(input: string | undefined, fallback: string): string {
  if (!input) return fallback;
  let name = input.normalize('NFC').split(/[\\/]/).pop() ?? '';
  name = name.replace(CONTROL, '').replace(BIDI, '').replace(/[<>:"|?*\u0000]/g, '_').replace(/^\.+/, '').trim();
  if (name.length > 120) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : '';
    name = name.slice(0, 120 - ext.length) + ext;
  }
  return name || fallback;
}

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** A single emoji (incl. ZWJ sequences / skin tones / flags), nothing else. */
const EMOJI_RE = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}{2})(?:[\u{1F3FB}-\u{1F3FF}️⃣]|‍(?:\p{Extended_Pictographic}|[♀♂⚕⚖✈❤]))*️?$/u;
export const isSingleEmoji = (s: string) => s.length <= 16 && EMOJI_RE.test(s);

/** Escape LIKE wildcards in a user search term. */
export const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => '\\' + m);

export function snippet(body: string, max = 120): string {
  const s = body.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
