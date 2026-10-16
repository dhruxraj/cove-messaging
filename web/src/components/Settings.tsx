import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  LuArrowLeft,
  LuBan,
  LuBell,
  LuCamera,
  LuChevronRight,
  LuEyeOff,
  LuKeyRound,
  LuLaptop,
  LuLockKeyhole,
  LuLogOut,
  LuMonitor,
  LuMoon,
  LuPalette,
  LuShield,
  LuShieldCheck,
  LuSmartphone,
  LuSun,
  LuTrash2,
  LuUserRound,
} from 'react-icons/lu';
import { api, del, errorMessage, get, patch, post } from '../lib/api';
import { listStamp } from '../lib/format';
import { navigate } from '../lib/router';
import { getThemePref, setThemePref, type ThemePref } from '../lib/theme';
import type { Me, PublicProfile } from '../lib/types';
import { refreshMe, setBlocked, signOut, store, toast, useApp } from '../state/app';
import { activeKey, myFingerprint, replaceRecoveryKey, rotateKey } from '../state/crypto';
import { OtpInput } from './Auth';
import { AvatarCropper, validateAvatarFile } from './AvatarCropper';
import { RecoveryKeyCard, uploadAvatar, useUsernameCheck } from './Setup';
import { Avatar, Confirm, Dialog, Segmented, Spinner, Toggle } from './ui';

const SECTIONS: { id: string; title: string; desc: string; icon: ReactNode }[] = [
  { id: 'profile', title: 'Profile', desc: 'Photo, name, username and about', icon: <LuUserRound /> },
  { id: 'privacy', title: 'Privacy', desc: 'Who sees your photo, status and receipts', icon: <LuEyeOff /> },
  { id: 'notifications', title: 'Notifications', desc: 'Alerts, sounds and browser notifications', icon: <LuBell /> },
  { id: 'security', title: 'Security & encryption', desc: 'Sessions, recovery key, security code', icon: <LuShield /> },
  { id: 'blocked', title: 'Blocked people', desc: 'People who can’t contact you', icon: <LuBan /> },
  { id: 'appearance', title: 'Appearance', desc: 'Light, dark or match your device', icon: <LuPalette /> },
  { id: 'account', title: 'Account', desc: 'Sign out or delete your account', icon: <LuLockKeyhole /> },
];

export function Settings({ path }: { path: string }) {
  const section = path.split('/')[2] ?? '';
  const current = SECTIONS.find((s) => s.id === section);
  return (
    <section className="settings">
      <header className="chat__head">
        <button type="button" className="icon-btn" onClick={() => navigate(current ? '/settings' : '/')} aria-label="Back">
          <LuArrowLeft />
        </button>
        <h2 className="settings__title">{current?.title ?? 'Settings'}</h2>
      </header>
      <div className="settings__body">
        <div className="settings__inner">
          {section === 'profile' ? (
            <ProfileSettings />
          ) : section === 'privacy' ? (
            <PrivacySettings />
          ) : section === 'notifications' ? (
            <NotificationSettings />
          ) : section === 'security' ? (
            <SecuritySettings />
          ) : section === 'blocked' ? (
            <BlockedSettings />
          ) : section === 'appearance' ? (
            <AppearanceSettings />
          ) : section === 'account' ? (
            <AccountSettings />
          ) : (
            <Overview />
          )}
        </div>
      </div>
    </section>
  );
}

function Overview() {
  const me = useApp((s) => s.me)!;
  return (
    <>
      <button type="button" className="profile-hero profile-hero--button" onClick={() => navigate('/settings/profile')}>
        <Avatar name={me.displayName ?? '?'} url={me.avatarUrl} size={96} />
        <h3>{me.displayName}</h3>
        <span className="handle">@{me.username}</span>
        {me.bio ? <p className="bio">{me.bio}</p> : null}
      </button>
      <div className="group">
        {SECTIONS.map((s) => (
          <button key={s.id} type="button" className="setting" onClick={() => navigate(`/settings/${s.id}`)}>
            {s.icon}
            <span className="setting__body">
              <span className="setting__title" style={{ display: 'block' }}>
                {s.title}
              </span>
              <span className="setting__desc">{s.desc}</span>
            </span>
            <LuChevronRight className="setting__chevron" />
          </button>
        ))}
      </div>
    </>
  );
}

function Row({ icon, title, desc, children }: { icon?: ReactNode; title: string; desc?: ReactNode; children?: ReactNode }) {
  return (
    <div className="setting">
      {icon}
      <span className="setting__body">
        <span className="setting__title" style={{ display: 'block' }}>
          {title}
        </span>
        {desc ? <span className="setting__desc">{desc}</span> : null}
      </span>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// profile
// ---------------------------------------------------------------------------
function ProfileSettings() {
  const me = useApp((s) => s.me)!;
  const [displayName, setDisplayName] = useState(me.displayName ?? '');
  const [username, setUsername] = useState(me.username ?? '');
  const [bio, setBio] = useState(me.bio);
  const [busy, setBusy] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [cropping, setCropping] = useState<File | null>(null);
  const check = useUsernameCheck(username, me.username);
  const fileRef = useRef<HTMLInputElement>(null);
  const dirty = displayName !== (me.displayName ?? '') || username !== (me.username ?? '') || bio !== me.bio;

  async function save() {
    setBusy(true);
    try {
      const r = await patch<{ me: Me }>('/api/me/profile', { displayName, username, bio });
      store.set({ me: r.me });
      toast('Profile saved');
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="settings__form">
        <div className="avatar-pick">
          <Avatar name={me.displayName ?? '?'} url={me.avatarUrl} size={88} />
          <div className="avatar-pick__actions">
            <button type="button" className="btn btn--sm" onClick={() => fileRef.current?.click()} disabled={photoBusy}>
              {photoBusy ? <Spinner /> : <LuCamera />} {me.avatarUrl ? 'Change photo' : 'Add photo'}
            </button>
            {me.avatarUrl ? (
              <button
                type="button"
                className="btn btn--sm btn--ghost"
                onClick={() =>
                  void del<{ me: Me }>('/api/me/avatar')
                    .then((r) => store.set({ me: r.me }))
                    .catch((err) => toast(errorMessage(err), 'error'))
                }
              >
                <LuTrash2 /> Remove
              </button>
            ) : null}
          </div>
          <input
            ref={fileRef}
            type="file"
            hidden
            accept="image/jpeg,image/png,image/webp,image/gif"
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
          <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={64} />
        </label>
        <label className="field">
          <span className="field__label">Username</span>
          <span className="input-prefix">
            <span>@</span>
            <input className="input" value={username} onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_.]/g, ''))} maxLength={24} autoCapitalize="none" spellCheck={false} />
          </span>
          <span className={`field__hint${check.status === 'bad' ? ' field__hint--error' : check.status === 'ok' ? ' field__hint--ok' : ''}`}>
            {check.status === 'checking' ? 'Checking…' : (check.message ?? 'People find you by this. You can change it up to 5 times a day.')}
          </span>
        </label>
        <label className="field">
          <span className="field__label">About</span>
          <input className="input" value={bio} onChange={(e) => setBio(e.target.value)} maxLength={160} placeholder="A short status or bio" />
        </label>
        <div>
          <button className="btn btn--primary" onClick={() => void save()} disabled={!dirty || busy || check.status === 'bad' || !displayName.trim()}>
            {busy ? <Spinner /> : 'Save changes'}
          </button>
        </div>
      </div>
      <div className="group">
        <Row title="Email" desc="Used to sign in. Never shown to other people.">
          <span className="setting__value">{me.email}</span>
        </Row>
        <Row title="Member since">
          <span className="setting__value">{new Date(me.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}</span>
        </Row>
      </div>
      {cropping ? (
        <AvatarCropper
          file={cropping}
          onCancel={() => setCropping(null)}
          onDone={(r) => {
            const f = cropping;
            setCropping(null);
            setPhotoBusy(true);
            void uploadAvatar(f, r.crop)
              .then((m) => {
                store.set({ me: m });
                toast('Photo updated');
              })
              .catch((err) => toast(errorMessage(err), 'error'))
              .finally(() => {
                setPhotoBusy(false);
                URL.revokeObjectURL(r.previewUrl);
              });
          }}
        />
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// privacy
// ---------------------------------------------------------------------------
async function savePrivacy(p: Partial<Me['privacy']>) {
  try {
    const r = await patch<{ me: Me }>('/api/me/privacy', p);
    store.set({ me: r.me });
  } catch (err) {
    toast(errorMessage(err), 'error');
  }
}

function AudienceSelect({ value, onChange, label }: { value: string; onChange: (v: 'everyone' | 'contacts' | 'nobody') => void; label: string }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as 'everyone')} aria-label={label}>
      <option value="everyone">Everyone</option>
      <option value="contacts">My contacts</option>
      <option value="nobody">Nobody</option>
    </select>
  );
}

function PrivacySettings() {
  const p = useApp((s) => s.me!.privacy);
  return (
    <>
      <div className="group__title">Who can see my information</div>
      <div className="group">
        <Row title="Profile photo">
          <AudienceSelect value={p.profilePhoto} label="Profile photo" onChange={(v) => void savePrivacy({ profilePhoto: v })} />
        </Row>
        <Row title="Online status">
          <AudienceSelect value={p.onlineStatus} label="Online status" onChange={(v) => void savePrivacy({ onlineStatus: v })} />
        </Row>
        <Row title="Last seen" desc="If you hide your last seen, you can't see other people's.">
          <AudienceSelect value={p.lastSeen} label="Last seen" onChange={(v) => void savePrivacy({ lastSeen: v })} />
        </Row>
        <Row title="Read receipts" desc="If you turn these off, you won't see other people's either.">
          <Toggle checked={p.readReceipts} label="Read receipts" onChange={(v) => void savePrivacy({ readReceipts: v })} />
        </Row>
      </div>
      <div className="group__title">Conversations</div>
      <div className="group">
        <Row title="Who can message me" desc={p.whoCanMessage === 'requests' ? 'New people send a request that you accept or decline.' : p.whoCanMessage === 'nobody' ? 'Only people you already chat with can reach you.' : 'Anyone can start a chat with you.'}>
          <select value={p.whoCanMessage} onChange={(e) => void savePrivacy({ whoCanMessage: e.target.value as 'everyone' })} aria-label="Who can message me">
            <option value="everyone">Everyone</option>
            <option value="requests">Requests only</option>
            <option value="nobody">Nobody new</option>
          </select>
        </Row>
        <Row title="Default disappearing timer" desc="Applies to new chats you start.">
          <select
            value={String(p.defaultMessageTtlSeconds ?? '')}
            onChange={(e) => void savePrivacy({ defaultMessageTtlSeconds: e.target.value ? Number(e.target.value) : null })}
            aria-label="Default disappearing timer"
          >
            <option value="">Off</option>
            <option value="86400">24 hours</option>
            <option value="604800">7 days</option>
            <option value="7776000">90 days</option>
          </select>
        </Row>
        <Row title="Receive view-once media" desc="Allow photos and videos that can only be opened once or twice. You can change this per chat.">
          <Toggle checked={p.allowProtectedMedia} label="Receive view-once media" onChange={(v) => void savePrivacy({ allowProtectedMedia: v })} />
        </Row>
        <Row title="Download media automatically" desc="Off: photos, videos and voice messages load only when you tap them.">
          <Toggle checked={p.autoDownloadMedia} label="Download media automatically" onChange={(v) => void savePrivacy({ autoDownloadMedia: v })} />
        </Row>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// notifications
// ---------------------------------------------------------------------------
const b64ToBytes = (s: string) => {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

async function saveNotifications(p: Partial<Me['notifications']>) {
  const r = await patch<{ me: Me }>('/api/me/notifications', p);
  store.set({ me: r.me });
}

function NotificationSettings() {
  const me = useApp((s) => s.me)!;
  const n = me.notifications;
  const [busy, setBusy] = useState(false);
  const supported = typeof Notification !== 'undefined';

  async function setBrowser(on: boolean) {
    setBusy(true);
    try {
      if (on) {
        // Permission is requested only now, in response to this explicit choice.
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') {
          toast('Notifications are blocked for this site in your browser settings.', 'error');
          return;
        }
        if (me.pushPublicKey && 'serviceWorker' in navigator) {
          const reg = await navigator.serviceWorker.ready;
          const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(me.pushPublicKey) }));
          await post('/api/push/subscriptions', sub.toJSON());
          await refreshMe();
        } else {
          await saveNotifications({ pushEnabled: true });
        }
      } else {
        if ('serviceWorker' in navigator) {
          const reg = await navigator.serviceWorker.getRegistration();
          const sub = await reg?.pushManager.getSubscription();
          if (sub) {
            await api('DELETE', '/api/push/subscriptions', { endpoint: sub.endpoint }).catch(() => {});
            await sub.unsubscribe().catch(() => {});
          }
        }
        await saveNotifications({ pushEnabled: false });
      }
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  }

  const save = (p: Partial<Me['notifications']>) => void saveNotifications(p).catch((err) => toast(errorMessage(err), 'error'));
  return (
    <>
      <div className="group__title">In the app</div>
      <div className="group">
        <Row title="Message alerts" desc="A banner when a message arrives in another chat. Never shows message text.">
          <Toggle checked={n.inAppMessages} label="Message alerts" onChange={(v) => save({ inAppMessages: v })} />
        </Row>
        <Row title="Sound">
          <Toggle checked={n.sound} label="Sound" onChange={(v) => save({ sound: v })} />
        </Row>
      </div>
      <div className="group__title">Browser notifications</div>
      <div className="group">
        <Row
          title="Notify me when Cove is in the background"
          desc={
            !supported
              ? "This browser doesn't support notifications."
              : me.pushPublicKey
                ? 'Uses Web Push, so it also works when Cove is closed.'
                : 'Works while a Cove tab is open. (Push for closed tabs is not configured on this server.)'
          }
        >
          {busy ? <Spinner /> : <Toggle checked={n.pushEnabled} disabled={!supported} label="Browser notifications" onChange={(v) => void setBrowser(v)} />}
        </Row>
        <Row title="Show sender name" desc="Off: notifications only say “New message”. Message text is never included — it's end-to-end encrypted.">
          <Toggle checked={n.pushShowPreview} label="Show sender name" onChange={(v) => save({ pushShowPreview: v })} />
        </Row>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// security
// ---------------------------------------------------------------------------
interface SessionInfo {
  id: string;
  current: boolean;
  createdAt: string;
  lastActiveAt: string;
  ip: string | null;
  device: string;
}

function SecuritySettings() {
  const me = useApp((s) => s.me)!;
  const [sessions, setSessions] = useState<{ policy: string; sessions: SessionInfo[] } | null>(null);
  const [confirm, setConfirm] = useState<null | 'all' | 'rotate' | 'recovery'>(null);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = activeKey();

  const load = () => get<{ policy: string; sessions: SessionInfo[] }>('/api/auth/sessions').then(setSessions, (err) => toast(errorMessage(err), 'error'));
  useEffect(() => void load(), []);

  return (
    <>
      <div className="group__title">Signed-in devices</div>
      <div className="group">
        {!sessions ? (
          <div className="timeline__loader">
            <Spinner />
          </div>
        ) : (
          sessions.sessions.map((s) => (
            <Row
              key={s.id}
              icon={/Android|iOS/.test(s.device) ? <LuSmartphone /> : <LuLaptop />}
              title={`${s.device}${s.current ? ' · this device' : ''}`}
              desc={`${s.ip ?? 'Unknown IP'} · signed in ${listStamp(s.createdAt)} · active ${listStamp(s.lastActiveAt)}`}
            >
              {!s.current ? (
                <button type="button" className="btn btn--sm" onClick={() => void del(`/api/auth/sessions/${s.id}`).then(load, (err) => toast(errorMessage(err), 'error'))}>
                  End
                </button>
              ) : null}
            </Row>
          ))
        )}
        <button type="button" className="setting setting--danger" onClick={() => setConfirm('all')}>
          <LuLogOut />
          <span className="setting__body">
            <span className="setting__title" style={{ display: 'block' }}>
              Sign out everywhere
            </span>
            <span className="setting__desc">Ends every session, including this one, and removes encryption keys from devices that are online.</span>
          </span>
        </button>
      </div>
      {sessions?.policy === 'single' ? <p className="settings__note">For your security, Cove allows one signed-in device at a time. Signing in somewhere new signs out the previous device and emails you.</p> : null}

      <div className="group__title">End-to-end encryption</div>
      <div className="group">
        <Row icon={<LuShieldCheck />} title="Your key" desc={key ? `Fingerprint ${myFingerprint()} · created ${new Date(key.createdAt).toLocaleDateString()}` : 'Not available on this device'} />
        <button type="button" className="setting" onClick={() => setConfirm('recovery')}>
          <LuKeyRound />
          <span className="setting__body">
            <span className="setting__title" style={{ display: 'block' }}>
              Create a new recovery key
            </span>
            <span className="setting__desc">Use this if you lost your recovery key. The old one stops working.</span>
          </span>
        </button>
        <button type="button" className="setting" onClick={() => setConfirm('rotate')}>
          <LuShield />
          <span className="setting__body">
            <span className="setting__title" style={{ display: 'block' }}>
              Rotate encryption key
            </span>
            <span className="setting__desc">New messages use a fresh key. Your contacts see that your security code changed. Older messages stay readable.</span>
          </span>
        </button>
      </div>
      <div className="settings__explain">
        <h3>What is protected</h3>
        <p>
          <strong>End-to-end encrypted:</strong> message text, media captions and message-request notes. They are encrypted on your device with keys
          the server never sees. The server stores only ciphertext.
        </p>
        <p>
          <strong>Not end-to-end encrypted:</strong> photos, videos, voice messages and files. They're sent over HTTPS and kept in private storage that
          only the people in the chat can access, but the server processes them (to check file types and remove location data), so the server
          operator could technically access them. Names, profile photos, who you talk to and when are also visible to the server.
        </p>
        <h3>Screenshots</h3>
        <p>
          View-once media is hidden when Cove loses focus, can't be right-click saved and carries a watermark with your username. A website cannot
          block screenshots or photos of the screen, so these measures discourage copying but cannot prevent it.
        </p>
      </div>

      {confirm === 'all' ? (
        <Confirm
          title="Sign out everywhere?"
          text="Every device, including this one, will be signed out. You'll need an email code and your recovery key to sign back in."
          confirmLabel="Sign out everywhere"
          danger
          onClose={() => setConfirm(null)}
          onConfirm={() => void signOut(true)}
        />
      ) : null}
      {confirm === 'rotate' ? (
        <Confirm
          title="Rotate your encryption key?"
          text="A new key will be created on this device and added to your backup. Contacts will see that your security code changed and may want to verify it again."
          confirmLabel="Rotate key"
          busy={busy}
          onClose={() => setConfirm(null)}
          onConfirm={() => {
            setBusy(true);
            void rotateKey()
              .then((m) => {
                store.set({ me: m });
                toast('New encryption key in use.');
              })
              .catch((err) => toast(errorMessage(err), 'error'))
              .finally(() => {
                setBusy(false);
                setConfirm(null);
              });
          }}
        />
      ) : null}
      {confirm === 'recovery' ? (
        <Confirm
          title="Create a new recovery key?"
          text="Your current recovery key will stop working. Make sure you can store the new one safely."
          confirmLabel="Create new key"
          busy={busy}
          onClose={() => setConfirm(null)}
          onConfirm={() => {
            setBusy(true);
            void replaceRecoveryKey()
              .then((r) => {
                store.set({ me: r.me });
                setNewKey(r.recoveryKey);
              })
              .catch((err) => toast(errorMessage(err), 'error'))
              .finally(() => {
                setBusy(false);
                setConfirm(null);
              });
          }}
        />
      ) : null}
      {newKey ? (
        <Dialog title="Your new recovery key" onClose={() => setNewKey(null)}>
          <p className="dialog__text">Save it now — it won't be shown again. You need it to unlock your messages after signing out or on a new device.</p>
          <RecoveryKeyCard recoveryKey={newKey} />
          <div className="dialog__actions">
            <button type="button" className="btn btn--primary" onClick={() => setNewKey(null)}>
              I saved it
            </button>
          </div>
        </Dialog>
      ) : null}
      {me.encryption?.hasBackup === false ? <div className="notice">Your key backup is missing. Create a new recovery key to restore it.</div> : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// blocked
// ---------------------------------------------------------------------------
function BlockedSettings() {
  const [list, setList] = useState<{ user: PublicProfile; blockedAt: string }[] | null>(null);
  const load = () => get<{ blocked: { user: PublicProfile; blockedAt: string }[] }>('/api/blocks').then((r) => setList(r.blocked), (err) => toast(errorMessage(err), 'error'));
  useEffect(() => void load(), []);
  if (!list) {
    return (
      <div className="timeline__loader">
        <Spinner />
      </div>
    );
  }
  if (!list.length) {
    return (
      <div className="empty">
        <LuBan size={28} />
        <h3>No one is blocked</h3>
        <p>Blocked people can't message you, start chats with you, or see your photo, online status and last seen.</p>
      </div>
    );
  }
  return (
    <div className="group">
      {list.map(({ user, blockedAt }) => (
        <div key={user.id} className="setting">
          <Avatar name={user.displayName} url={user.avatarUrl} size={40} />
          <span className="setting__body">
            <span className="setting__title" style={{ display: 'block' }}>
              {user.displayName}
            </span>
            <span className="setting__desc">
              {user.username ? `@${user.username} · ` : ''}blocked {listStamp(blockedAt)}
            </span>
          </span>
          <button type="button" className="btn btn--sm" onClick={() => void setBlocked(user.id, false).then(load, (err) => toast(errorMessage(err), 'error'))}>
            Unblock
          </button>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// appearance
// ---------------------------------------------------------------------------
function AppearanceSettings() {
  const [pref, setPref] = useState<ThemePref>(getThemePref());
  return (
    <div className="group">
      <Row title="Theme" desc="Stored on this device only.">
        <Segmented<ThemePref>
          label="Theme"
          value={pref}
          onChange={(v) => {
            setPref(v);
            setThemePref(v);
          }}
          options={[
            { value: 'system', label: <><LuMonitor /> Auto</> },
            { value: 'light', label: <><LuSun /> Light</> },
            { value: 'dark', label: <><LuMoon /> Dark</> },
          ]}
        />
      </Row>
    </div>
  );
}

// ---------------------------------------------------------------------------
// account
// ---------------------------------------------------------------------------
function AccountSettings() {
  const me = useApp((s) => s.me)!;
  const [step, setStep] = useState<null | 'confirm' | { challengeId: string }>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function requestCode() {
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ challengeId: string }>('/api/account/delete/request');
      setStep({ challengeId: r.challengeId });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete(value: string) {
    if (typeof step !== 'object' || !step || value.length !== 6) return;
    setBusy(true);
    setError(null);
    try {
      await post('/api/account/delete', { challengeId: step.challengeId, code: value });
      await signOut();
      toast('Your account was deleted.');
    } catch (err) {
      setError(errorMessage(err));
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="group">
        <Row title="Signed in as" desc={me.email} />
        <button type="button" className="setting" onClick={() => void signOut()}>
          <LuLogOut />
          <span className="setting__body">
            <span className="setting__title" style={{ display: 'block' }}>
              Sign out
            </span>
            <span className="setting__desc">Removes your keys from this device. You'll need your recovery key next time.</span>
          </span>
        </button>
      </div>
      <div className="group">
        <button type="button" className="setting setting--danger" onClick={() => setStep('confirm')}>
          <LuTrash2 />
          <span className="setting__body">
            <span className="setting__title" style={{ display: 'block' }}>
              Delete account
            </span>
            <span className="setting__desc">Permanently deletes your profile, messages you sent, media and keys.</span>
          </span>
        </button>
      </div>
      {step === 'confirm' ? (
        <Confirm
          title="Delete your account?"
          text="This can't be undone. Your profile, the messages you sent, your media and your encryption keys are deleted. We'll email you a code to confirm."
          confirmLabel="Email me a code"
          danger
          busy={busy}
          onClose={() => setStep(null)}
          onConfirm={() => void requestCode()}
        />
      ) : null}
      {step && typeof step === 'object' ? (
        <Dialog title="Confirm deletion" onClose={() => setStep(null)}>
          <p className="dialog__text">Enter the 6-digit code we sent to {me.email}.</p>
          <OtpInput
            value={code}
            error={!!error}
            disabled={busy}
            onChange={(v) => {
              setCode(v);
              if (v.length === 6) void confirmDelete(v);
            }}
          />
          {error ? <div className="notice notice--error">{error}</div> : null}
          <div className="dialog__actions">
            <button type="button" className="btn" onClick={() => setStep(null)}>
              Cancel
            </button>
            <button type="button" className="btn btn--danger" disabled={busy || code.length !== 6} onClick={() => void confirmDelete(code)}>
              {busy ? <Spinner /> : 'Delete forever'}
            </button>
          </div>
        </Dialog>
      ) : null}
    </>
  );
}
