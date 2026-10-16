/**
 * Email validation and canonicalisation.
 *
 * Gmail ignores dots in the local part and everything after "+", so
 * "Jane.Doe+news@gmail.com" and "janedoe@gmail.com" are the same mailbox. We store the
 * canonical form with a unique constraint so one mailbox cannot hold several accounts.
 */
export interface NormalizedEmail {
  email: string; // lower-cased address as entered (used for sending)
  canonical: string; // mailbox identity
  domain: string;
}

// Conservative local-part rule: letters, digits and common punctuation; no quoted strings.
const LOCAL_RE = /^[a-z0-9](?:[a-z0-9._%+-]{0,62}[a-z0-9_%+-])?$/;
const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function normalizeEmail(input: unknown, allowedDomains: string[]): NormalizedEmail | { error: string } {
  if (typeof input !== 'string') return { error: 'Enter your email address.' };
  const email = input.trim().toLowerCase();
  if (email.length > 254 || email.split('@').length !== 2) return { error: 'Enter a valid email address.' };
  const [local, domain] = email.split('@') as [string, string];
  if (!LOCAL_RE.test(local) || local.includes('..') || !DOMAIN_RE.test(domain)) {
    return { error: 'Enter a valid email address.' };
  }
  if (!allowedDomains.includes(domain)) {
    const list = allowedDomains.map((d) => '@' + d).join(', ');
    return { error: `Only ${list} addresses can be used.` };
  }
  let canonicalLocal = local;
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    canonicalLocal = local.split('+')[0]!.replace(/\./g, '');
    if (!canonicalLocal) return { error: 'Enter a valid email address.' };
  }
  const canonicalDomain = domain === 'googlemail.com' ? 'gmail.com' : domain;
  return { email, canonical: `${canonicalLocal}@${canonicalDomain}`, domain };
}

/** "j***e@gmail.com" — for display in security notices without exposing the full address. */
export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  if (local.length <= 2) return `${local[0] ?? ''}*@${domain}`;
  return `${local[0]}${'*'.repeat(Math.min(6, local.length - 2))}${local[local.length - 1]}@${domain}`;
}
