import { useEffect, useRef, useState, type FormEvent } from 'react';
import { LuArrowLeft, LuLockKeyhole } from 'react-icons/lu';
import { api, ApiError, errorMessage, get } from '../lib/api';
import { navigate } from '../lib/router';
import type { Me } from '../lib/types';
import { signedIn, toast, useApp } from '../state/app';
import { Spinner, Wordmark } from './ui';

interface AuthConfig {
  appName: string;
  allowedEmailDomains: string[];
  otpTtlSeconds: number;
  otpMaxAttempts: number;
  sessionPolicy: 'single' | 'multiple';
}

let configCache: AuthConfig | null = null;
function useAuthConfig() {
  const [cfg, setCfg] = useState<AuthConfig | null>(configCache);
  useEffect(() => {
    if (configCache) return;
    get<AuthConfig>('/api/auth/config')
      .then((c) => setCfg((configCache = c)))
      .catch(() => {});
  }, []);
  return cfg;
}

type Step = { kind: 'email' } | { kind: 'code'; email: string; challengeId: string; expiresAt: number; resendAt: number };

export function AuthScreen({ mode }: { mode: 'login' | 'register' }) {
  const cfg = useAuthConfig();
  const signedOutReason = useApp((s) => s.signedOutReason);
  const [step, setStep] = useState<Step>({ kind: 'email' });
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const domains = cfg?.allowedEmailDomains ?? ['gmail.com'];
  const domainHint = domains.length === 1 ? `Your @${domains[0]} address` : `An address ending in ${domains.map((d) => '@' + d).join(', ')}`;

  async function requestCode(e?: FormEvent) {
    e?.preventDefault();
    const value = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      setError('Enter a valid email address.');
      return;
    }
    const domain = value.split('@')[1]!;
    if (cfg && !domains.includes(domain)) {
      setError(`Only ${domains.map((d) => '@' + d).join(', ')} addresses can be used.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ challengeId: string; expiresAt: string; resendAfterSeconds: number }>('POST', '/api/auth/otp', { email: value, purpose: mode });
      setStep({ kind: 'code', email: value, challengeId: r.challengeId, expiresAt: Date.parse(r.expiresAt), resendAt: Date.now() + r.resendAfterSeconds * 1000 });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <AuthArt />
      <main className="auth__panel">
        {step.kind === 'email' ? (
          <form className="auth__card" onSubmit={requestCode} noValidate>
            <MobileBrand />
            {signedOutReason ? <div className="notice">{signedOutReason}</div> : null}
            <h2>{mode === 'login' ? 'Sign in' : 'Create your account'}</h2>
            <p className="lede">No password needed. We'll email you a 6-digit code.</p>
            <label className="field">
              <span className="field__label">Email</span>
              <input
                className="input"
                type="email"
                inputMode="email"
                autoComplete="email"
                autoCapitalize="none"
                spellCheck={false}
                placeholder={`you@${domains[0]}`}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoFocus
                aria-invalid={!!error}
                aria-describedby="email-hint"
              />
              <span id="email-hint" className={`field__hint${error ? ' field__hint--error' : ''}`} role={error ? 'alert' : undefined}>
                {error ?? domainHint}
              </span>
            </label>
            <button className="btn btn--primary btn--block" disabled={busy}>
              {busy ? <Spinner /> : 'Send code'}
            </button>
            <p className="auth__switch">
              {mode === 'login' ? (
                <>
                  New to Cove?{' '}
                  <button type="button" onClick={() => navigate('/register')}>
                    Create an account
                  </button>
                </>
              ) : (
                <>
                  Already have an account?{' '}
                  <button type="button" onClick={() => navigate('/login')}>
                    Sign in
                  </button>
                </>
              )}
            </p>
          </form>
        ) : (
          <CodeStep
            step={step}
            cfg={cfg}
            onBack={() => {
              setStep({ kind: 'email' });
              setError(null);
            }}
            onResent={(r) => setStep(r)}
            mode={mode}
          />
        )}
      </main>
    </div>
  );
}

function CodeStep({ step, cfg, onBack, onResent, mode }: { step: Extract<Step, { kind: 'code' }>; cfg: AuthConfig | null; onBack: () => void; onResent: (s: Step) => void; mode: 'login' | 'register' }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [now, setNow] = useState(Date.now());
  const submitted = useRef('');

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  async function verify(value: string) {
    if (value.length !== 6 || busy || submitted.current === value) return;
    submitted.current = value;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ me: Me; csrfToken: string; isNewUser: boolean; replacedPreviousSession: boolean }>('POST', '/api/auth/verify', { challengeId: step.challengeId, code: value });
      signedIn(r.me, r.csrfToken);
      navigate('/', { replace: true });
      if (r.replacedPreviousSession) toast('Signed in. Your session on your other device was ended.');
    } catch (err) {
      const e = err as ApiError;
      setError(errorMessage(err));
      if (e instanceof ApiError && ['too_many_attempts', 'code_expired', 'code_used', 'invalid_challenge'].includes(e.code)) setLocked(true);
      setCode('');
      submitted.current = '';
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    setError(null);
    try {
      const r = await api<{ challengeId: string; expiresAt: string; resendAfterSeconds: number }>('POST', '/api/auth/otp', { email: step.email, purpose: mode });
      onResent({ kind: 'code', email: step.email, challengeId: r.challengeId, expiresAt: Date.parse(r.expiresAt), resendAt: Date.now() + r.resendAfterSeconds * 1000 });
      setLocked(false);
      setCode('');
      submitted.current = '';
      toast('A new code is on its way. Earlier codes no longer work.');
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const resendIn = Math.max(0, Math.ceil((step.resendAt - now) / 1000));
  const expiresIn = Math.max(0, Math.ceil((step.expiresAt - now) / 1000));
  const ttlMin = Math.round((cfg?.otpTtlSeconds ?? 300) / 60);

  return (
    <form
      className="auth__card"
      onSubmit={(e) => {
        e.preventDefault();
        void verify(code);
      }}
    >
      <MobileBrand />
      <div>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onBack} style={{ marginLeft: -12 }}>
          <LuArrowLeft /> Change email
        </button>
      </div>
      <h2>Check your email</h2>
      <p className="lede">
        Enter the 6-digit code we sent to <strong>{step.email}</strong>. It works once and expires in {ttlMin} minutes.
      </p>
      <OtpInput
        value={code}
        disabled={busy || locked}
        error={!!error}
        onChange={(v) => {
          setCode(v);
          if (v.length === 6) void verify(v);
        }}
      />
      {error ? (
        <div className="notice notice--error" role="alert">
          {error}
        </div>
      ) : expiresIn === 0 ? (
        <div className="notice">This code has expired. Request a new one.</div>
      ) : null}
      <button className="btn btn--primary btn--block" disabled={busy || locked || code.length !== 6}>
        {busy ? <Spinner /> : 'Continue'}
      </button>
      <p className="auth__switch">
        Didn't get it? Check spam, or{' '}
        <button type="button" className="link-btn" onClick={() => void resend()} disabled={resendIn > 0}>
          {resendIn > 0 ? `resend in ${resendIn}s` : 'send a new code'}
        </button>
      </p>
      {cfg?.sessionPolicy !== 'multiple' ? (
        <p className="field__hint" style={{ textAlign: 'center' }}>
          Signing in here signs you out on any other device.
        </p>
      ) : null}
    </form>
  );
}

/** Six single-digit boxes. Accepts typing, backspace navigation and pasting the whole code. */
export function OtpInput({ value, onChange, disabled, error }: { value: string; onChange: (v: string) => void; disabled?: boolean; error?: boolean }) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const digits = value.padEnd(6, ' ').slice(0, 6).split('');

  useEffect(() => {
    if (!disabled && !value) refs.current[0]?.focus();
  }, [disabled, value]);

  const setAt = (i: number, d: string) => {
    const arr = value.padEnd(6, ' ').slice(0, 6).split('');
    arr[i] = d;
    return arr.join('').replace(/\s+$/, '').replace(/ /g, '');
  };

  return (
    <div className={`otp${error ? ' otp--error' : ''}`} role="group" aria-label="6-digit code">
      {digits.map((d, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          inputMode="numeric"
          autoComplete={i === 0 ? 'one-time-code' : 'off'}
          pattern="[0-9]*"
          maxLength={i === 0 ? 6 : 1}
          aria-label={`Digit ${i + 1}`}
          value={d.trim()}
          disabled={disabled}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => {
            const raw = e.target.value.replace(/\D/g, '');
            if (raw.length > 1) {
              // Autofill or paste into a single box: spread the digits.
              const next = (value.slice(0, i) + raw).slice(0, 6);
              onChange(next);
              refs.current[Math.min(5, next.length)]?.focus();
              return;
            }
            const next = setAt(i, raw);
            onChange(next);
            if (raw && i < 5) refs.current[i + 1]?.focus();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Backspace' && !d.trim() && i > 0) {
              e.preventDefault();
              onChange(setAt(i - 1, ''));
              refs.current[i - 1]?.focus();
            } else if (e.key === 'ArrowLeft' && i > 0) refs.current[i - 1]?.focus();
            else if (e.key === 'ArrowRight' && i < 5) refs.current[i + 1]?.focus();
          }}
          onPaste={(e) => {
            const raw = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
            if (!raw) return;
            e.preventDefault();
            onChange(raw);
            refs.current[Math.min(5, raw.length)]?.focus();
          }}
        />
      ))}
    </div>
  );
}

function MobileBrand() {
  return (
    <div className="auth__mobile-brand">
      <Wordmark size={34} />
      <span>Cove</span>
    </div>
  );
}

export function AuthArt() {
  return (
    <aside className="auth__art" aria-hidden="true">
      <div className="auth__brand">
        <Wordmark size={36} onDark />
        <span>Cove</span>
      </div>
      <div className="auth__claim">
        <h1>Conversations that stay between you.</h1>
        <p>Messages are end-to-end encrypted on your device. Photos can be set to open once. Sign in with just your email.</p>
        <p className="auth__lock">
          <LuLockKeyhole /> Only the people in a chat can read it — not even Cove.
        </p>
      </div>
      <svg className="auth__bay" viewBox="0 0 1200 520" preserveAspectRatio="none">
        <path d="M0 210 C 180 150 320 250 520 205 S 900 120 1200 190 L1200 520 L0 520 Z" fill="rgba(255,255,255,0.06)" />
        <path d="M0 290 C 220 240 380 330 600 285 S 980 220 1200 280 L1200 520 L0 520 Z" fill="rgba(255,255,255,0.08)" />
        <path d="M0 370 C 240 330 420 400 640 365 S 1000 320 1200 360 L1200 520 L0 520 Z" fill="rgba(255,255,255,0.1)" />

      </svg>
    </aside>
  );
}
