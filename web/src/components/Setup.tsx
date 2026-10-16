import { useEffect, useRef, useState, type FormEvent } from 'react';
import { LuCamera, LuCheck, LuCopy, LuDownload, LuKeyRound, LuLockKeyhole, LuShieldCheck, LuTrash2 } from 'react-icons/lu';
import { ApiError, errorMessage, get, patch } from '../lib/api';
import type { Me } from '../lib/types';
import { uploadRaw } from '../lib/upload';
import { encryptionReady, profileReady, signOut, toast, useApp } from '../state/app';
import { completeSetup, isE2EEError, prepareSetup, resetKeys, restoreWithRecoveryKey, useE2EE, type PreparedSetup } from '../state/crypto';
import { AuthArt } from './Auth';
import { AvatarCropper, validateAvatarFile, type CropResult } from './AvatarCropper';
import { Avatar, Confirm, Spinner, Wordmark } from './ui';

function SetupLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="auth">
      <AuthArt />
      <main className="auth__panel">
        <div className="auth__card">
          <div className="auth__mobile-brand">
            <Wordmark size={34} />
            <span>Cove</span>
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// profile
// ---------------------------------------------------------------------------
export function useUsernameCheck(username: string, current: string | null) {
  const [state, setState] = useState<{ status: 'idle' | 'checking' | 'ok' | 'bad'; message?: string }>({ status: 'idle' });
  useEffect(() => {
    const u = username.trim().replace(/^@/, '').toLowerCase();
    if (!u || u === current) {
      setState({ status: 'idle' });
      return;
    }
    setState({ status: 'checking' });
    const t = window.setTimeout(() => {
      get<{ available: boolean; reason: string | null }>(`/api/usernames/check?u=${encodeURIComponent(u)}`)
        .then((r) => setState(r.available ? { status: 'ok', message: `@${u} is available` } : { status: 'bad', message: r.reason ?? 'Not available' }))
        .catch(() => setState({ status: 'idle' }));
    }, 350);
    return () => window.clearTimeout(t);
  }, [username, current]);
  return state;
}

export async function uploadAvatar(file: File, crop: CropResult['crop']): Promise<Me> {
  const q = new URLSearchParams({ x: String(crop.x), y: String(crop.y), size: String(crop.size) });
  const r = await uploadRaw<{ me: Me }>(`/api/me/avatar?${q}`, file, () => {}).promise;
  return r.me;
}

export function ProfileSetup() {
  const me = useApp((s) => s.me)!;
  const [displayName, setDisplayName] = useState(me.displayName ?? '');
  const [username, setUsername] = useState(me.username ?? me.email.split('@')[0]!.replace(/[^a-z0-9_.]/gi, '').toLowerCase().slice(0, 24));
  const [bio, setBio] = useState(me.bio);
  const [photo, setPhoto] = useState<{ file: File; crop: CropResult } | null>(null);
  const [cropping, setCropping] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const check = useUsernameCheck(username, me.username);
  const fileRef = useRef<HTMLInputElement>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!displayName.trim()) return setError('Enter the name people will see.');
    if (check.status === 'bad') return setError(check.message ?? 'Choose another username.');
    setBusy(true);
    setError(null);
    try {
      let r = await patch<{ me: Me }>('/api/me/profile', { displayName, username, bio });
      if (photo) {
        try {
          r = { me: await uploadAvatar(photo.file, photo.crop.crop) };
        } catch (err) {
          toast(`Your profile was saved, but the photo couldn't be uploaded: ${errorMessage(err)}`, 'error');
        }
      }
      profileReady(r.me);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SetupLayout>
      <form onSubmit={submit} style={{ display: 'grid', gap: 18 }}>
        <h2>Set up your profile</h2>
        <p className="lede">This is how people find and recognise you. Your email address stays private.</p>
        <div className="avatar-pick">
          {photo ? (
            <span className="avatar" style={{ width: 72, height: 72 }}>
              <img src={photo.crop.previewUrl} alt="" />
            </span>
          ) : (
            <Avatar name={displayName || username || '?'} size={72} />
          )}
          <div className="avatar-pick__actions">
            <button type="button" className="btn btn--sm" onClick={() => fileRef.current?.click()}>
              <LuCamera /> {photo ? 'Change photo' : 'Add photo'}
            </button>
            {photo ? (
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => setPhoto(null)}>
                <LuTrash2 /> Remove
              </button>
            ) : null}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              const problem = validateAvatarFile(f, me.limits.maxAvatarMb);
              if (problem) toast(problem, 'error');
              else setCropping(f);
            }}
          />
        </div>
        <label className="field">
          <span className="field__label">Display name</span>
          <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={64} autoComplete="name" autoFocus required />
        </label>
        <label className="field">
          <span className="field__label">Username</span>
          <span className="input-prefix">
            <span>@</span>
            <input
              className="input"
              value={username}
              onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_.]/g, ''))}
              maxLength={24}
              autoCapitalize="none"
              spellCheck={false}
              required
            />
          </span>
          <span className={`field__hint${check.status === 'bad' ? ' field__hint--error' : check.status === 'ok' ? ' field__hint--ok' : ''}`}>
            {check.status === 'checking' ? 'Checking…' : (check.message ?? '3–24 characters: letters, numbers, dots and underscores.')}
          </span>
        </label>
        <label className="field">
          <span className="field__label">About (optional)</span>
          <input className="input" value={bio} onChange={(e) => setBio(e.target.value)} maxLength={160} placeholder="A short status or bio" />
        </label>
        {error ? (
          <div className="notice notice--error" role="alert">
            {error}
          </div>
        ) : null}
        <button className="btn btn--primary btn--block" disabled={busy || check.status === 'checking'}>
          {busy ? <Spinner /> : 'Continue'}
        </button>
        <p className="auth__switch">
          Signed in as {me.email} ·{' '}
          <button type="button" onClick={() => void signOut()}>
            Sign out
          </button>
        </p>
      </form>
      {cropping ? (
        <AvatarCropper
          file={cropping}
          onCancel={() => setCropping(null)}
          onDone={(crop) => {
            setPhoto({ file: cropping, crop });
            setCropping(null);
          }}
        />
      ) : null}
    </SetupLayout>
  );
}

// ---------------------------------------------------------------------------
// encryption
// ---------------------------------------------------------------------------
export function RecoveryKeyCard({ recoveryKey }: { recoveryKey: string }) {
  const [copied, setCopied] = useState(false);
  const me = useApp((s) => s.me);
  const download = () => {
    const text = `Cove recovery key\n\nAccount: ${me?.username ? '@' + me.username : ''}\nRecovery key: ${recoveryKey}\n\nKeep this somewhere safe and private. You need it to read your messages after\nsigning out or on a new device. Cove cannot recover it for you.\n`;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'cove-recovery-key.txt';
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <div className="recovery">
      <code className="recovery__key" aria-label="Recovery key" data-key={recoveryKey}>
        {recoveryKey.split('-').map((g, i) => (
          <span key={i}>
            {g}
            {i < 5 ? <span className="recovery__dash">-</span> : null}
          </span>
        ))}
      </code>
      <div className="recovery__actions">
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => {
            void navigator.clipboard?.writeText(recoveryKey).then(() => setCopied(true));
          }}
        >
          {copied ? <LuCheck /> : <LuCopy />} {copied ? 'Copied' : 'Copy'}
        </button>
        <button type="button" className="btn btn--sm" onClick={download}>
          <LuDownload /> Download
        </button>
      </div>
    </div>
  );
}

/** Show a new recovery key and require proof it was saved before continuing. */
export function SaveRecoveryKey({ recoveryKey, busy, onConfirmed, confirmLabel = 'Finish setup' }: { recoveryKey: string; busy: boolean; onConfirmed: () => void; confirmLabel?: string }) {
  const [typed, setTyped] = useState('');
  const last = recoveryKey.slice(-4);
  const ok = typed.trim().toUpperCase() === last;
  return (
    <form
      style={{ display: 'grid', gap: 18 }}
      onSubmit={(e) => {
        e.preventDefault();
        if (ok) onConfirmed();
      }}
    >
      <h2>Save your recovery key</h2>
      <p className="lede">
        You'll need this key to read your messages after you sign out or when you use a new device. Store it in a password manager or somewhere
        only you can reach. <strong>Cove can't recover it for you.</strong>
      </p>
      <RecoveryKeyCard recoveryKey={recoveryKey} />
      <label className="field">
        <span className="field__label">Type the last 4 characters to confirm you saved it</span>
        <input className="input recovery__confirm" value={typed} onChange={(e) => setTyped(e.target.value)} maxLength={4} autoCapitalize="characters" spellCheck={false} placeholder="XXXX" />
      </label>
      <button className="btn btn--primary btn--block" disabled={!ok || busy}>
        {busy ? <Spinner /> : confirmLabel}
      </button>
    </form>
  );
}

export function EncryptionSetup() {
  const [prep, setPrep] = useState<PreparedSetup | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      setPrep(await prepareSetup());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    if (!prep) return;
    setBusy(true);
    setError(null);
    try {
      const me = await completeSetup(prep);
      encryptionReady(me);
      toast('Encryption is set up. Your messages are end-to-end encrypted.');
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'key_exists' ? 'This account already has keys. Reload the page to restore them.' : errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SetupLayout>
      {!prep ? (
        <div style={{ display: 'grid', gap: 18 }}>
          <div className="setup-icon">
            <LuShieldCheck />
          </div>
          <h2>Protect your messages</h2>
          <p className="lede">
            Cove encrypts your messages on this device before they're sent. Only you and the person you're talking to can read them — the Cove
            server only ever stores scrambled data.
          </p>
          <ul className="setup-points">
            <li>A private key is created on this device and never leaves it unprotected.</li>
            <li>A recovery key lets you unlock your messages on another device. You'll save it next.</li>
            <li>Photos, videos and files are stored privately on the server, encrypted in transit, but they are not end-to-end encrypted.</li>
          </ul>
          {error ? <div className="notice notice--error">{error}</div> : null}
          <button className="btn btn--primary btn--block" onClick={() => void create()} disabled={busy}>
            {busy ? <Spinner /> : 'Create my keys'}
          </button>
        </div>
      ) : (
        <>
          <SaveRecoveryKey recoveryKey={prep.recoveryKey} busy={busy} onConfirmed={() => void finish()} />
          {error ? <div className="notice notice--error">{error}</div> : null}
        </>
      )}
    </SetupLayout>
  );
}

export function EncryptionRestore() {
  const keyId = useE2EE((s) => s.keyId);
  const me = useApp((s) => s.me)!;
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetPrep, setResetPrep] = useState<PreparedSetup | null>(null);

  async function restore(e: FormEvent) {
    e.preventDefault();
    if (!keyId) return;
    setBusy(true);
    setError(null);
    try {
      await restoreWithRecoveryKey(value, keyId);
      encryptionReady();
      toast('Your messages are unlocked on this device.');
    } catch (err) {
      setError(isE2EEError(err) ? err.message : errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function finishReset() {
    if (!resetPrep) return;
    setBusy(true);
    try {
      const updated = await resetKeys(resetPrep);
      encryptionReady(updated);
      toast('New keys created. Your contacts will see that your security code changed.');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (resetPrep) {
    return (
      <SetupLayout>
        <SaveRecoveryKey recoveryKey={resetPrep.recoveryKey} busy={busy} onConfirmed={() => void finishReset()} confirmLabel="Reset and continue" />
        {error ? <div className="notice notice--error">{error}</div> : null}
      </SetupLayout>
    );
  }

  return (
    <SetupLayout>
      <form onSubmit={restore} style={{ display: 'grid', gap: 18 }}>
        <div className="setup-icon">
          <LuLockKeyhole />
        </div>
        <h2>Unlock your messages</h2>
        <p className="lede">
          Your messages are end-to-end encrypted. Enter the recovery key you saved when you set up Cove to read them on this device.
        </p>
        <label className="field">
          <span className="field__label">Recovery key</span>
          <input
            className="input recovery__input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            autoFocus
          />
        </label>
        {error ? (
          <div className="notice notice--error" role="alert">
            {error}
          </div>
        ) : null}
        <button className="btn btn--primary btn--block" disabled={busy || value.replace(/[\s-]/g, '').length < 24}>
          {busy ? <Spinner /> : (
            <>
              <LuKeyRound /> Unlock
            </>
          )}
        </button>
        <p className="auth__switch">
          Lost your recovery key?{' '}
          <button type="button" onClick={() => setConfirmReset(true)}>
            Reset encryption
          </button>
        </p>
        <p className="auth__switch">
          Signed in as {me.email} ·{' '}
          <button type="button" onClick={() => void signOut()}>
            Sign out
          </button>
        </p>
      </form>
      {confirmReset ? (
        <Confirm
          title="Reset encryption?"
          text="You'll get new keys and a new recovery key. Messages sent before now can't be read on this or any new device. Your contacts will see that your security code changed."
          confirmLabel="Reset"
          danger
          busy={busy}
          onClose={() => setConfirmReset(false)}
          onConfirm={() => {
            setConfirmReset(false);
            void prepareSetup().then(setResetPrep);
          }}
        />
      ) : null}
    </SetupLayout>
  );
}

export function Unsupported() {
  return (
    <SetupLayout>
      <h2>This browser isn't supported</h2>
      <p className="lede">
        Cove needs a current browser with Web Crypto and IndexedDB to keep your messages end-to-end encrypted. Private-browsing modes in some
        browsers disable these. Try the latest Chrome, Edge, Firefox or Safari.
      </p>
      <button className="btn" onClick={() => void signOut()}>
        Sign out
      </button>
    </SetupLayout>
  );
}
