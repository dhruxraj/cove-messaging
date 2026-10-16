import { useEffect, useMemo, useRef, useState } from 'react';
import {
  LuArchive,
  LuArchiveRestore,
  LuArrowLeft,
  LuBan,
  LuBell,
  LuBellOff,
  LuEllipsisVertical,
  LuFlag,
  LuSearch,
  LuShieldAlert,
  LuTimer,
  LuTrash2,
  LuUserRound,
  LuX,
} from 'react-icons/lu';
import { errorMessage } from '../lib/api';
import { lastSeenText, listStamp, ttlLabel } from '../lib/format';
import { navigate } from '../lib/router';
import type { Conversation, Message } from '../lib/types';
import { deleteConversation, loadConversation, loadEntireHistory, setBlocked, textOf, toast, updateConversation, useApp } from '../state/app';
import { dismissKeyWarning, getPin, observePeerKey, useE2EE } from '../state/crypto';
import { jumpTo, ui } from '../state/ui';
import { Composer, type EditState } from './Composer';
import { ProfilePanel } from './ProfilePanel';
import { Highlight, usePresence } from './Rail';
import { Timeline, type TimelineActions } from './Timeline';
import { Avatar, Confirm, Dialog, MenuItem, Popover, Spinner } from './ui';

export function Chat({ conversationId }: { conversationId: string }) {
  const conv = useApp((s) => s.conversations[conversationId]);
  const loaded = useApp((s) => s.conversationsLoaded);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (!conv && loaded) void loadConversation(conversationId).then((c) => !c && setMissing(true));
  }, [conv, loaded, conversationId]);

  if (!conv) {
    return (
      <div className="welcome">
        {missing ? (
          <div className="welcome__inner">
            <h2>Conversation not found</h2>
            <p>It may have been deleted, or you don't have access to it.</p>
            <button className="btn" onClick={() => navigate('/')}>
              Back to chats
            </button>
          </div>
        ) : (
          <Spinner />
        )}
      </div>
    );
  }
  return <ChatView conv={conv} />;
}

function ChatView({ conv }: { conv: Conversation }) {
  const [reply, setReply] = useState<Message | null>(null);
  const [editing, setEditing] = useState<EditState | null>(null);
  const [panel, setPanel] = useState<null | 'profile' | 'verify'>(null);
  const [search, setSearch] = useState(false);
  const [ttlOpen, setTtlOpen] = useState(false);

  useEffect(() => {
    if (conv.peer && conv.peerKeyId) void observePeerKey(conv.peer.id, conv.peerKeyId);
  }, [conv.peer, conv.peerKeyId]);

  const actions: TimelineActions = useMemo(
    () => ({
      onReply: (m) => {
        setEditing(null);
        setReply(m);
      },
      onEdit: (m, text) => {
        setReply(null);
        setEditing({ m, text });
      },
      onVerify: () => setPanel('verify'),
    }),
    [],
  );

  return (
    <section className="chat" aria-label={`Conversation with ${conv.peer?.displayName ?? 'unknown'}`}>
      <ChatHeader conv={conv} onProfile={() => setPanel('profile')} onSearch={() => setSearch((s) => !s)} onTtl={() => setTtlOpen(true)} />
      {search ? <ChatSearch conv={conv} onClose={() => setSearch(false)} /> : null}
      <KeyWarning conv={conv} onVerify={() => setPanel('verify')} />
      {conv.messageTtlSeconds ? (
        <button type="button" className="chat__banner chat__banner--button" onClick={() => setTtlOpen(true)}>
          <LuTimer /> New messages disappear after {ttlLabel(conv.messageTtlSeconds)}
        </button>
      ) : null}
      <Timeline conv={conv} actions={actions} />
      <Composer conv={conv} reply={reply} editing={editing} onClearReply={() => setReply(null)} onDoneEditing={() => setEditing(null)} />
      {panel ? <ProfilePanel conv={conv} verify={panel === 'verify'} onClose={() => setPanel(null)} onTtl={() => setTtlOpen(true)} /> : null}
      {ttlOpen ? <DisappearingDialog conv={conv} onClose={() => setTtlOpen(false)} /> : null}
    </section>
  );
}

function ChatHeader({ conv, onProfile, onSearch, onTtl }: { conv: Conversation; onProfile: () => void; onSearch: () => void; onTtl: () => void }) {
  const typing = useApp((s) => (s.typing[conv.id] ?? 0) > Date.now());
  const presence = usePresence(conv.peer);
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const [confirm, setConfirm] = useState<null | 'block' | 'delete'>(null);
  const [busy, setBusy] = useState(false);
  const peer = conv.peer;
  const name = peer?.displayName ?? 'Unknown';
  const sub = typing ? 'typing…' : presence.online ? 'online' : presence.lastSeenAt ? lastSeenText(presence.lastSeenAt) : peer?.username ? `@${peer.username}` : '';

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setMenu(null);
    try {
      await fn();
      if (done) toast(done);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  return (
    <header className="chat__head">
      <button type="button" className="icon-btn chat__back" onClick={() => navigate('/')} aria-label="Back to chats">
        <LuArrowLeft />
      </button>
      <button type="button" className="chat__who" onClick={onProfile} aria-label={`${name}, contact info`}>
        <Avatar name={name} url={peer?.avatarUrl} size={42} online={presence.online} />
        <span style={{ minWidth: 0 }}>
          <span className="chat__name" style={{ display: 'block' }}>
            {name}
          </span>
          <span className={`chat__sub${typing ? ' chat__sub--typing' : ''}`} style={{ display: 'block' }} aria-live="polite">
            {sub}
          </span>
        </span>
      </button>
      <button type="button" className="icon-btn" onClick={onSearch} aria-label="Search in conversation">
        <LuSearch />
      </button>
      <button type="button" className="icon-btn" onClick={(e) => setMenu(e.currentTarget.getBoundingClientRect())} aria-label="Conversation options" aria-haspopup="menu">
        <LuEllipsisVertical />
      </button>
      {menu ? (
        <Popover anchor={menu} onClose={() => setMenu(null)}>
          <MenuItem
            icon={<LuUserRound />}
            onClick={() => {
              setMenu(null);
              onProfile();
            }}
          >
            Contact info
          </MenuItem>
          <MenuItem icon={conv.muted ? <LuBell /> : <LuBellOff />} onClick={() => void run(() => updateConversation(conv.id, { muted: !conv.muted }), conv.muted ? 'Notifications on' : 'Muted')}>
            {conv.muted ? 'Unmute' : 'Mute notifications'}
          </MenuItem>
          <MenuItem
            icon={<LuTimer />}
            onClick={() => {
              setMenu(null);
              onTtl();
            }}
          >
            Disappearing messages
          </MenuItem>
          <MenuItem
            icon={conv.archived ? <LuArchiveRestore /> : <LuArchive />}
            onClick={() =>
              void run(async () => {
                await updateConversation(conv.id, { archived: !conv.archived });
                if (!conv.archived) navigate('/');
              }, conv.archived ? 'Moved back to chats' : 'Chat archived')
            }
          >
            {conv.archived ? 'Unarchive' : 'Archive'}
          </MenuItem>
          <div className="menu__sep" />
          {peer && !peer.deleted ? (
            peer.blockedByMe ? (
              <MenuItem icon={<LuBan />} onClick={() => void run(() => setBlocked(peer.id, false), `${name} unblocked`)}>
                Unblock
              </MenuItem>
            ) : (
              <MenuItem
                icon={<LuBan />}
                danger
                onClick={() => {
                  setMenu(null);
                  setConfirm('block');
                }}
              >
                Block
              </MenuItem>
            )
          ) : null}
          {peer && !peer.deleted ? (
            <MenuItem
              icon={<LuFlag />}
              danger
              onClick={() => {
                setMenu(null);
                ui.set({ report: { userId: peer.id, message: null } });
              }}
            >
              Report
            </MenuItem>
          ) : null}
          <MenuItem
            icon={<LuTrash2 />}
            danger
            onClick={() => {
              setMenu(null);
              setConfirm('delete');
            }}
          >
            Delete chat
          </MenuItem>
        </Popover>
      ) : null}
      {confirm === 'block' && peer ? (
        <Confirm
          title={`Block ${name}?`}
          text="They won't be able to message you or start new conversations, and won't see your photo, online status or last seen. They aren't told that you blocked them."
          confirmLabel="Block"
          danger
          busy={busy}
          onClose={() => setConfirm(null)}
          onConfirm={() => {
            setBusy(true);
            void setBlocked(peer.id, true)
              .then(() => toast(`${name} blocked`))
              .catch((err) => toast(errorMessage(err), 'error'))
              .finally(() => {
                setBusy(false);
                setConfirm(null);
              });
          }}
        />
      ) : null}
      {confirm === 'delete' ? (
        <Confirm
          title="Delete this chat?"
          text={`The conversation and its history are removed from your account. ${name} keeps their copy. If they message you again, it reappears without the old history.`}
          confirmLabel="Delete chat"
          danger
          busy={busy}
          onClose={() => setConfirm(null)}
          onConfirm={() => {
            setBusy(true);
            void deleteConversation(conv.id)
              .then(() => navigate('/'))
              .catch((err) => toast(errorMessage(err), 'error'))
              .finally(() => setBusy(false));
          }}
        />
      ) : null}
    </header>
  );
}

/** Warns when a contact's key changed after you verified it (detected on this device, not by the server). */
function KeyWarning({ conv, onVerify }: { conv: Conversation; onVerify: () => void }) {
  const version = useE2EE((s) => s.version);
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!conv.peer) return;
    void getPin(conv.peer.id).then((p) => setShow(!!p?.changedAfterVerify));
  }, [conv.peer, conv.peerKeyId, version]);
  if (!show || !conv.peer) return null;
  return (
    <div className="chat__banner chat__banner--warn" role="alert">
      <LuShieldAlert />
      <span>{conv.peer.displayName}'s security code changed since you verified it.</span>
      <button type="button" className="link-btn" onClick={onVerify}>
        Verify
      </button>
      <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => void dismissKeyWarning(conv.peer!.id)} style={{ width: 28, height: 28 }}>
        <LuX />
      </button>
    </div>
  );
}

/** Search the whole conversation on this device (the server only holds ciphertext). */
function ChatSearch({ conv, onClose }: { conv: Conversation; onClose: () => void }) {
  const items = useApp((s) => s.messages[conv.id]?.items);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(false);
  const [count, setCount] = useState(0);
  const [texts, setTexts] = useState<Map<string, string>>(new Map());
  const loadedAll = useRef(false);

  useEffect(() => {
    if (!q.trim() || loadedAll.current) return;
    loadedAll.current = true;
    setLoading(true);
    void loadEntireHistory(conv.id, setCount)
      .catch((err) => toast(errorMessage(err), 'error'))
      .finally(() => setLoading(false));
  }, [q, conv.id]);

  useEffect(() => {
    if (!items) return;
    let alive = true;
    void Promise.all(items.filter((m) => m.body && !m.deleted && m.kind !== 'system').map(async (m) => [m.id, await textOf(m)] as const)).then((pairs) => {
      if (alive) setTexts(new Map(pairs));
    });
    return () => {
      alive = false;
    };
  }, [items]);

  const needle = q.trim().toLowerCase();
  const hits = useMemo(() => {
    if (needle.length < 2 || !items) return [];
    return items.filter((m) => (texts.get(m.id) ?? '').toLowerCase().includes(needle)).reverse();
  }, [items, texts, needle]);

  return (
    <>
      <div className="chat-search">
        <label className="search">
          <LuSearch aria-hidden="true" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search this conversation" autoFocus aria-label="Search this conversation" />
        </label>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close search">
          <LuX />
        </button>
      </div>
      {needle.length >= 2 ? (
        <div className="chat-search__results">
          {loading ? (
            <p className="field__hint" style={{ padding: 8 }}>
              <Spinner /> Decrypting history on this device… {count ? `${count} messages` : ''}
            </p>
          ) : null}
          {hits.length === 0 && !loading ? (
            <p className="field__hint" style={{ padding: 8 }}>
              No messages found.
            </p>
          ) : null}
          {hits.slice(0, 100).map((m) => (
            <button key={m.id} type="button" className="hit" onClick={() => jumpTo(conv.id, m.id)}>
              <span className="hit__top">
                <span>{m.senderId === conv.peer?.id ? conv.peer?.displayName : 'You'}</span>
                <span>{listStamp(m.createdAt)}</span>
              </span>
              <span className="hit__text">
                <Highlight text={texts.get(m.id) ?? ''} q={q.trim()} />
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}

const TTL_OPTIONS: { value: number | null; label: string }[] = [
  { value: null, label: 'Off' },
  { value: 86400, label: '24 hours' },
  { value: 604800, label: '7 days' },
  { value: 7776000, label: '90 days' },
];

function DisappearingDialog({ conv, onClose }: { conv: Conversation; onClose: () => void }) {
  const [value, setValue] = useState<number | null>(conv.messageTtlSeconds);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog title="Disappearing messages" onClose={onClose}>
      <p className="dialog__text">New messages in this chat are deleted for both of you after the time you choose. This doesn't affect messages already sent.</p>
      <div className="radio-list" role="radiogroup">
        {TTL_OPTIONS.map((o) => (
          <label key={String(o.value)} className="radio">
            <input type="radio" name="ttl" checked={value === o.value} onChange={() => setValue(o.value)} />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
      <div className="dialog__actions">
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn--primary"
          disabled={busy || value === conv.messageTtlSeconds}
          onClick={() => {
            setBusy(true);
            void updateConversation(conv.id, { messageTtlSeconds: value })
              .then(onClose)
              .catch((err) => toast(errorMessage(err), 'error'))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? <Spinner /> : 'Save'}
        </button>
      </div>
    </Dialog>
  );
}
