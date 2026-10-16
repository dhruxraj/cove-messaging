import { useEffect, useState } from 'react';
import { LuBan, LuBellOff, LuEye, LuFlag, LuShieldCheck, LuTimer, LuTrash2, LuX } from 'react-icons/lu';
import { errorMessage } from '../lib/api';
import { lastSeenText, ttlLabel } from '../lib/format';
import { navigate } from '../lib/router';
import type { Conversation } from '../lib/types';
import { deleteConversation, setBlocked, toast, updateConversation, useApp } from '../state/app';
import { getPin, safetyNumberWith, setVerified, useE2EE } from '../state/crypto';
import { ui } from '../state/ui';
import { usePresence } from './Rail';
import { Avatar, Confirm, Dialog, Spinner, Toggle } from './ui';

export function ProfilePanel({ conv, verify, onClose, onTtl }: { conv: Conversation; verify: boolean; onClose: () => void; onTtl: () => void }) {
  const me = useApp((s) => s.me)!;
  const peer = conv.peer;
  const presence = usePresence(peer);
  const version = useE2EE((s) => s.version);
  const [verifyOpen, setVerifyOpen] = useState(verify);
  const [verified, setVerifiedState] = useState(false);
  const [confirm, setConfirm] = useState<null | 'block' | 'delete'>(null);

  useEffect(() => {
    if (peer) void getPin(peer.id).then((p) => setVerifiedState(!!p?.verified && p.kid === conv.peerKeyId));
  }, [peer, conv.peerKeyId, version]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && !verifyOpen && !confirm && onClose();
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, [onClose, verifyOpen, confirm]);

  if (!peer) return null;
  const allowProtected = conv.allowProtectedMedia ?? me.privacy.allowProtectedMedia;
  const act = (fn: () => Promise<unknown>) => void fn().catch((err) => toast(errorMessage(err), 'error'));

  return (
    <aside className="panel" role="dialog" aria-label="Contact info">
      <div className="panel__head">
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close contact info" autoFocus>
          <LuX />
        </button>
        <h2>Contact info</h2>
      </div>
      <div className="panel__body">
        <div className="profile-hero">
          <Avatar name={peer.displayName} url={peer.avatarUrl} size={112} online={presence.online} />
          <h3>{peer.displayName}</h3>
          {peer.username ? <span className="handle">@{peer.username}</span> : null}
          <span className="handle">{presence.online ? 'online' : presence.lastSeenAt ? lastSeenText(presence.lastSeenAt) : ''}</span>
          {peer.bio ? <p className="bio">{peer.bio}</p> : null}
        </div>

        <div className="group">
          <button type="button" className="setting" onClick={() => setVerifyOpen(true)}>
            <LuShieldCheck />
            <span className="setting__body">
              <span className="setting__title" style={{ display: 'block' }}>
                Encryption
              </span>
              <span className="setting__desc">Messages are end-to-end encrypted. Compare security codes to verify.</span>
            </span>
            <span className={`setting__value${verified ? ' setting__value--ok' : ''}`}>{verified ? 'Verified' : 'Not verified'}</span>
          </button>
        </div>

        <div className="group">
          <div className="setting">
            <LuBellOff />
            <span className="setting__body">
              <span className="setting__title">Mute notifications</span>
            </span>
            <Toggle checked={conv.muted} label="Mute notifications" onChange={(v) => act(() => updateConversation(conv.id, { muted: v }))} />
          </div>
          <button type="button" className="setting" onClick={onTtl}>
            <LuTimer />
            <span className="setting__body">
              <span className="setting__title">Disappearing messages</span>
            </span>
            <span className="setting__value">{ttlLabel(conv.messageTtlSeconds)}</span>
          </button>
          <div className="setting">
            <LuEye />
            <span className="setting__body">
              <span className="setting__title" style={{ display: 'block' }}>
                Receive view-once media
              </span>
              <span className="setting__desc">Allow {peer.displayName.split(' ')[0]} to send you photos and videos that can only be opened once or twice.</span>
            </span>
            <Toggle checked={allowProtected} label="Receive view-once media" onChange={(v) => act(() => updateConversation(conv.id, { allowProtectedMedia: v }))} />
          </div>
        </div>

        <div className="group">
          {!peer.deleted ? (
            peer.blockedByMe ? (
              <button type="button" className="setting" onClick={() => act(() => setBlocked(peer.id, false))}>
                <LuBan />
                <span className="setting__body">
                  <span className="setting__title">Unblock {peer.displayName}</span>
                </span>
              </button>
            ) : (
              <button type="button" className="setting setting--danger" onClick={() => setConfirm('block')}>
                <LuBan />
                <span className="setting__body">
                  <span className="setting__title">Block {peer.displayName}</span>
                </span>
              </button>
            )
          ) : null}
          {!peer.deleted ? (
            <button type="button" className="setting setting--danger" onClick={() => ui.set({ report: { userId: peer.id, message: null } })}>
              <LuFlag />
              <span className="setting__body">
                <span className="setting__title">Report {peer.displayName}</span>
              </span>
            </button>
          ) : null}
          <button type="button" className="setting setting--danger" onClick={() => setConfirm('delete')}>
            <LuTrash2 />
            <span className="setting__body">
              <span className="setting__title">Delete chat</span>
            </span>
          </button>
        </div>
        {!peer.deleted ? (
          <p className="panel__foot">On Cove since {new Date(peer.joinedAt).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</p>
        ) : null}
      </div>
      {verifyOpen ? <SafetyNumberDialog conv={conv} onClose={() => setVerifyOpen(false)} /> : null}
      {confirm === 'block' ? (
        <Confirm
          title={`Block ${peer.displayName}?`}
          text="They won't be able to message you or start new conversations, and won't see your photo, online status or last seen."
          confirmLabel="Block"
          danger
          onClose={() => setConfirm(null)}
          onConfirm={() => {
            setConfirm(null);
            act(() => setBlocked(peer.id, true));
          }}
        />
      ) : null}
      {confirm === 'delete' ? (
        <Confirm
          title="Delete this chat?"
          text="The conversation and its history are removed from your account only."
          confirmLabel="Delete chat"
          danger
          onClose={() => setConfirm(null)}
          onConfirm={() => {
            setConfirm(null);
            act(async () => {
              await deleteConversation(conv.id);
              navigate('/');
            });
          }}
        />
      ) : null}
    </aside>
  );
}

function SafetyNumberDialog({ conv, onClose }: { conv: Conversation; onClose: () => void }) {
  const peer = conv.peer!;
  const [data, setData] = useState<{ number: string; peerKid: string } | null | undefined>(undefined);
  const [verified, setV] = useState(false);
  useEffect(() => {
    void safetyNumberWith(peer.id).then(async (d) => {
      setData(d);
      const pin = await getPin(peer.id);
      setV(!!d && !!pin?.verified && pin.kid === d.peerKid);
    });
  }, [peer.id]);
  const groups = data?.number.split(' ') ?? [];
  return (
    <Dialog title="Verify security code" onClose={onClose}>
      <p className="dialog__text">
        Compare these numbers with {peer.displayName} in person or on a call. If they match on both devices, your messages are encrypted with each
        other's real keys — nobody, including the Cove server, is in the middle.
      </p>
      {data === undefined ? (
        <div className="timeline__loader">
          <Spinner />
        </div>
      ) : data === null ? (
        <div className="notice">{peer.displayName} hasn't set up encryption yet.</div>
      ) : (
        <div className="safety-number" aria-label="Security code">
          {groups.map((g, i) => (
            <span key={i}>{g}</span>
          ))}
        </div>
      )}
      {data ? (
        <div className="setting" style={{ padding: 0 }}>
          <span className="setting__body">
            <span className="setting__title" style={{ display: 'block' }}>
              Mark as verified
            </span>
            <span className="setting__desc">If their code changes later, this chat shows a warning.</span>
          </span>
          <Toggle
            checked={verified}
            label="Mark as verified"
            onChange={(v) => {
              setV(v);
              void setVerified(peer.id, data.peerKid, v);
            }}
          />
        </div>
      ) : null}
      <div className="dialog__actions">
        <button type="button" className="btn btn--primary" onClick={onClose}>
          Done
        </button>
      </div>
    </Dialog>
  );
}
