import { useEffect, useMemo, useRef, useState } from 'react';
import {
  LuArchive,
  LuBell,
  LuBellOff,
  LuCheck,
  LuCheckCheck,
  LuClock,
  LuEllipsisVertical,
  LuFileText,
  LuImage,
  LuInbox,
  LuLogOut,
  LuMic,
  LuMusic,
  LuSearch,
  LuSettings,
  LuShieldAlert,
  LuSquarePen,
  LuTimer,
  LuVideo,
  LuWifiOff,
  LuX,
} from 'react-icons/lu';
import { errorMessage, get } from '../lib/api';
import { listStamp } from '../lib/format';
import { navigate } from '../lib/router';
import type { AppNotification, Conversation, ConversationRequest, PublicProfile } from '../lib/types';
import { kindLabel, markNotificationsRead, respondToRequest, signOut, systemText, toast, useApp } from '../state/app';
import { peekPlain, usePlaintext } from '../state/crypto';
import { jumpTo, openNewChat } from '../state/ui';
import { Avatar, MenuItem, Popover, Spinner } from './ui';

type Tab = 'chats' | 'archived' | 'requests';

export function Rail({ activeId }: { activeId: string | null }) {
  const me = useApp((s) => s.me)!;
  const conversations = useApp((s) => s.conversations);
  const loaded = useApp((s) => s.conversationsLoaded);
  const requests = useApp((s) => s.requests);
  const [tab, setTab] = useState<Tab>('chats');
  const [q, setQ] = useState('');

  const sorted = useMemo(() => Object.values(conversations).sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt)), [conversations]);
  const archivedUnread = sorted.filter((c) => c.archived && c.unreadCount > 0).length;
  const list = sorted.filter((c) => (tab === 'archived' ? c.archived : !c.archived));
  const pendingIncoming = requests.incoming.filter((r) => r.status === 'pending').length;

  return (
    <aside className="rail" aria-label="Conversations">
      <RailHeader />
      <ConnectionStatus />
      <div className="rail__search">
        <label className="search">
          <LuSearch aria-hidden="true" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search chats or find people" aria-label="Search" />
          {q ? (
            <button type="button" className="icon-btn search__clear" onClick={() => setQ('')} aria-label="Clear search">
              <LuX />
            </button>
          ) : null}
        </label>
      </div>
      {q.trim() ? (
        <SearchResults q={q.trim()} conversations={sorted} activeId={activeId} onPick={() => setQ('')} />
      ) : (
        <>
          <div className="rail__tabs" role="tablist" aria-label="Lists">
            <button type="button" role="tab" className="rail__tab" aria-selected={tab === 'chats'} onClick={() => setTab('chats')}>
              Chats
            </button>
            <button type="button" role="tab" className="rail__tab" aria-selected={tab === 'archived'} onClick={() => setTab('archived')}>
              <LuArchive style={{ width: 15, height: 15 }} /> Archived
              {archivedUnread ? <span className="count count--muted">{archivedUnread}</span> : null}
            </button>
            <button type="button" role="tab" className="rail__tab" aria-selected={tab === 'requests'} onClick={() => setTab('requests')}>
              Requests
              {pendingIncoming ? <span className="count">{pendingIncoming}</span> : null}
            </button>
          </div>
          <div className="rail__list" role="tabpanel">
            {tab === 'requests' ? (
              <RequestsList requests={requests} />
            ) : !loaded ? (
              <div className="timeline__loader">
                <Spinner />
              </div>
            ) : list.length === 0 ? (
              tab === 'archived' ? (
                <div className="empty">
                  <LuArchive size={28} />
                  <h3>No archived chats</h3>
                  <p>Archive a chat from its menu to tidy your list. New messages keep it archived.</p>
                </div>
              ) : (
                <div className="empty">
                  <LuInbox size={28} />
                  <h3>No conversations yet</h3>
                  <p>Find someone by their username to start chatting.</p>
                  <button className="btn btn--primary btn--sm" onClick={() => openNewChat()}>
                    <LuSquarePen /> New chat
                  </button>
                </div>
              )
            ) : (
              list.map((c) => <ConversationRow key={c.id} c={c} active={c.id === activeId} meId={me.id} />)
            )}
          </div>
        </>
      )}
    </aside>
  );
}

function RailHeader() {
  const me = useApp((s) => s.me)!;
  const unread = useApp((s) => s.notifications.unread);
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const [bell, setBell] = useState<DOMRect | null>(null);
  return (
    <div className="rail__head">
      <button type="button" className="rail__me" onClick={() => navigate('/settings')} aria-label="Your profile and settings">
        <Avatar name={me.displayName ?? me.username ?? '?'} url={me.avatarUrl} size={38} />
        <span className="rail__title">Chats</span>
      </button>
      <button
        type="button"
        className="icon-btn"
        aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
        onClick={(e) => {
          setBell(e.currentTarget.getBoundingClientRect());
          if (unread) void markNotificationsRead();
        }}
      >
        <LuBell />
        {unread ? <span className="dot-badge">{unread > 9 ? '9+' : unread}</span> : null}
      </button>
      <button type="button" className="icon-btn" aria-label="New chat" onClick={() => openNewChat()} data-testid="new-chat">
        <LuSquarePen />
      </button>
      <button type="button" className="icon-btn" aria-label="Menu" aria-haspopup="menu" onClick={(e) => setMenu(e.currentTarget.getBoundingClientRect())}>
        <LuEllipsisVertical />
      </button>
      {menu ? (
        <Popover anchor={menu} onClose={() => setMenu(null)}>
          <MenuItem
            icon={<LuSettings />}
            onClick={() => {
              setMenu(null);
              navigate('/settings');
            }}
          >
            Settings
          </MenuItem>
          <MenuItem
            icon={<LuLogOut />}
            onClick={() => {
              setMenu(null);
              void signOut();
            }}
          >
            Sign out
          </MenuItem>
        </Popover>
      ) : null}
      {bell ? <NotificationsPopover anchor={bell} onClose={() => setBell(null)} /> : null}
    </div>
  );
}

function ConnectionStatus() {
  const connection = useApp((s) => s.connection);
  const [show, setShow] = useState(false);
  useEffect(() => {
    // Don't flash the banner for brief reconnects.
    if (connection === 'online') {
      setShow(false);
      return;
    }
    const t = window.setTimeout(() => setShow(true), 2500);
    return () => window.clearTimeout(t);
  }, [connection]);
  if (!show) return null;
  return (
    <div className="rail__status" role="status">
      {connection === 'offline' ? <LuWifiOff /> : <Spinner />}
      {connection === 'offline' ? "You're offline. Messages will send when you're back." : 'Connecting…'}
    </div>
  );
}

// ---------------------------------------------------------------------------
// conversation rows
// ---------------------------------------------------------------------------
export function usePresence(peer: PublicProfile | null | undefined) {
  const live = useApp((s) => (peer ? s.presence[peer.id] : undefined));
  return live ?? peer?.presence ?? { online: null, lastSeenAt: null };
}

function ConversationRow({ c, active, meId }: { c: Conversation; active: boolean; meId: string }) {
  const typing = useApp((s) => (s.typing[c.id] ?? 0) > Date.now());
  const presence = usePresence(c.peer);
  const name = c.peer?.displayName ?? 'Unknown';
  const unread = c.unreadCount > 0;
  return (
    <button type="button" className="row" aria-current={active} onClick={() => navigate(`/c/${c.id}`)} data-testid={`conversation-${c.peer?.username ?? c.id}`}>
      <Avatar name={name} url={c.peer?.avatarUrl} size={50} online={presence.online} />
      <span className="row__body">
        <span className="row__top">
          <span className="row__name">{name}</span>
          <span className={`row__time${unread && !c.muted ? ' row__time--unread' : ''}`}>{listStamp(c.lastMessage?.createdAt ?? c.lastActivityAt)}</span>
        </span>
        <span className="row__bottom">
          {typing ? <span className="row__preview row__preview--typing">typing…</span> : <LastMessagePreview c={c} meId={meId} />}
          <span className="row__flags">
            {c.messageTtlSeconds ? <LuTimer aria-label="Disappearing messages on" /> : null}
            {c.muted ? <LuBellOff aria-label="Muted" /> : null}
            {unread ? <span className={`count${c.muted ? ' count--muted' : ''}`}>{c.unreadCount > 99 ? '99+' : c.unreadCount}</span> : null}
          </span>
        </span>
      </span>
    </button>
  );
}

export function StatusTick({ status }: { status?: 'sent' | 'delivered' | 'read' | 'pending' | 'failed' }) {
  if (!status) return null;
  if (status === 'pending') return <LuClock aria-label="Sending" />;
  if (status === 'failed') return <LuShieldAlert className="meta__failed" aria-label="Failed to send" />;
  if (status === 'sent') return <LuCheck aria-label="Sent" />;
  return <LuCheckCheck className={status === 'read' ? 'meta__read' : undefined} aria-label={status === 'read' ? 'Read' : 'Delivered'} />;
}

const kindIcon = (kind: string | null) =>
  kind === 'image' ? <LuImage /> : kind === 'video' ? <LuVideo /> : kind === 'voice' ? <LuMic /> : kind === 'audio' ? <LuMusic /> : kind === 'file' ? <LuFileText /> : null;

function LastMessagePreview({ c, meId }: { c: Conversation; meId: string }) {
  const lm = c.lastMessage;
  const recipient = lm?.senderId ? (lm.senderId === meId ? (c.peer?.id ?? null) : meId) : null;
  const plain = usePlaintext(lm?.body, lm?.senderId, recipient);
  if (!lm) return <span className="row__preview">No messages yet</span>;
  if (lm.kind === 'system') return <span className="row__preview">{systemText(lm.system, meId, c.peer?.displayName)}</span>;
  if (lm.deleted) return <span className="row__preview"><em>This message was deleted</em></span>;
  const mine = lm.senderId === meId;
  const text = plain.status === 'ok' ? plain.text.replace(/\s+/g, ' ') : plain.status === 'error' ? '🔒 Encrypted message' : '';
  const label = lm.kind === 'text' ? '' : kindLabel(lm.kind, lm.viewPolicy);
  return (
    <span className="row__preview">
      {mine ? <StatusTick status={lm.status} /> : null}
      {kindIcon(lm.kind)}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label && text && lm.viewPolicy === 'normal' ? `${label} · ${text}` : label || text || ' '}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// search: chats by name, people by username, messages already decrypted on this device
// ---------------------------------------------------------------------------
function SearchResults({ q, conversations, activeId, onPick }: { q: string; conversations: Conversation[]; activeId: string | null; onPick: () => void }) {
  const me = useApp((s) => s.me)!;
  const messages = useApp((s) => s.messages);
  const [people, setPeople] = useState<PublicProfile[] | null>(null);
  const needle = q.toLowerCase().replace(/^@/, '');
  const chats = conversations.filter((c) => c.peer && (c.peer.displayName.toLowerCase().includes(needle) || (c.peer.username ?? '').includes(needle)));

  useEffect(() => {
    setPeople(null);
    if (!/^@?[a-z0-9_.]{2,24}$/i.test(q)) {
      setPeople([]);
      return;
    }
    const t = window.setTimeout(() => {
      get<{ users: PublicProfile[] }>(`/api/users/search?q=${encodeURIComponent(q)}`)
        .then((r) => setPeople(r.users))
        .catch(() => setPeople([]));
    }, 250);
    return () => window.clearTimeout(t);
  }, [q]);

  const hits = useMemo(() => {
    const out: { convId: string; messageId: string; text: string; at: string; name: string }[] = [];
    for (const [convId, cm] of Object.entries(messages)) {
      const c = conversations.find((x) => x.id === convId);
      if (!c) continue;
      for (const m of cm.items) {
        if (!m.body || m.deleted) continue;
        const text = peekPlain(m.body);
        if (text && text.toLowerCase().includes(q.toLowerCase())) out.push({ convId, messageId: m.id, text, at: m.createdAt, name: c.peer?.displayName ?? '' });
      }
    }
    return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 30);
  }, [messages, conversations, q]);

  const known = new Set(conversations.map((c) => c.peer?.id));
  const strangers = (people ?? []).filter((p) => !known.has(p.id));

  return (
    <div className="rail__list">
      {chats.length ? <div className="rail__section">Chats</div> : null}
      {chats.map((c) => (
        <ConversationRow key={c.id} c={c} active={c.id === activeId} meId={me.id} />
      ))}
      {strangers.length ? <div className="rail__section">People</div> : null}
      {strangers.map((p) => (
        <PersonRow key={p.id} p={p} onPick={onPick} />
      ))}
      {hits.length ? <div className="rail__section">Messages</div> : null}
      <div className="search-results">
        {hits.map((h) => (
          <button
            key={h.messageId}
            type="button"
            className="hit"
            onClick={() => {
              onPick();
              jumpTo(h.convId, h.messageId);
            }}
          >
            <span className="hit__top">
              <span>{h.name}</span>
              <span>{listStamp(h.at)}</span>
            </span>
            <span className="hit__text">
              <Highlight text={h.text} q={q} />
            </span>
          </button>
        ))}
      </div>
      {people !== null && !chats.length && !strangers.length && !hits.length ? (
        <div className="empty">
          <h3>No results</h3>
          <p>Search people by their exact username, like @maya. Message search covers chats you've opened on this device.</p>
        </div>
      ) : null}
    </div>
  );
}

export function Highlight({ text, q }: { text: string; q: string }) {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return <>{text}</>;
  const start = Math.max(0, i - 40);
  return (
    <>
      {start > 0 ? '…' : ''}
      {text.slice(start, i)}
      <mark>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

function PersonRow({ p, onPick }: { p: PublicProfile; onPick: () => void }) {
  return (
    <button
      type="button"
      className="row"
      onClick={() => {
        onPick();
        openNewChat(p);
      }}
    >
      <Avatar name={p.displayName} url={p.avatarUrl} size={44} />
      <span className="row__body">
        <span className="row__name">{p.displayName}</span>
        <span className="row__preview">@{p.username}</span>
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// requests
// ---------------------------------------------------------------------------
function RequestsList({ requests }: { requests: { incoming: ConversationRequest[]; outgoing: ConversationRequest[] } }) {
  const incoming = requests.incoming.filter((r) => r.status === 'pending');
  const outgoing = requests.outgoing.filter((r) => r.status === 'pending');
  if (!incoming.length && !outgoing.length) {
    return (
      <div className="empty">
        <LuInbox size={28} />
        <h3>No message requests</h3>
        <p>When someone you haven't chatted with wants to message you, their request appears here. You decide whether to accept.</p>
      </div>
    );
  }
  return (
    <>
      {incoming.length ? <div className="rail__section">Wants to message you</div> : null}
      {incoming.map((r) => (
        <RequestCard key={r.id} r={r} />
      ))}
      {outgoing.length ? <div className="rail__section">Sent by you</div> : null}
      {outgoing.map((r) => (
        <RequestCard key={r.id} r={r} />
      ))}
    </>
  );
}

function RequestCard({ r }: { r: ConversationRequest }) {
  const me = useApp((s) => s.me)!;
  const [busy, setBusy] = useState<string | null>(null);
  const incoming = r.direction === 'incoming';
  const note = usePlaintext(r.note || null, incoming ? r.user.id : me.id, incoming ? me.id : r.user.id);
  const act = async (action: 'accept' | 'reject' | 'cancel') => {
    setBusy(action);
    try {
      const conv = await respondToRequest(r.id, action);
      if (conv) navigate(`/c/${conv.id}`);
      else if (action === 'reject') toast('Request declined. They won’t be notified.');
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="request-card" data-testid={`request-${r.user.username}`}>
      <div className="row" style={{ padding: 0 }}>
        <Avatar name={r.user.displayName} url={r.user.avatarUrl} size={44} />
        <span className="row__body">
          <span className="row__top">
            <span className="row__name">{r.user.displayName}</span>
            <span className="row__time">{listStamp(r.createdAt)}</span>
          </span>
          <span className="row__preview">@{r.user.username}</span>
        </span>
      </div>
      {r.note ? <div className="request-card__note">{note.status === 'ok' ? note.text : note.status === 'error' ? '🔒 Encrypted note' : '…'}</div> : null}
      {incoming ? (
        <div className="request-card__actions">
          <button className="btn btn--sm" onClick={() => void act('reject')} disabled={!!busy}>
            {busy === 'reject' ? <Spinner /> : 'Decline'}
          </button>
          <button className="btn btn--sm btn--primary" onClick={() => void act('accept')} disabled={!!busy}>
            {busy === 'accept' ? <Spinner /> : 'Accept'}
          </button>
        </div>
      ) : (
        <div className="request-card__actions">
          <span className="field__hint" style={{ flex: 2, alignSelf: 'center' }}>
            Waiting for them to accept
          </span>
          <button className="btn btn--sm" onClick={() => void act('cancel')} disabled={!!busy}>
            {busy === 'cancel' ? <Spinner /> : 'Withdraw'}
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// notifications
// ---------------------------------------------------------------------------
function notificationText(n: AppNotification): { title: string; body: string } {
  const p = n.payload as Record<string, string>;
  switch (n.type) {
    case 'conversation_request':
      return { title: 'New message request', body: 'Someone wants to start a conversation with you. Open Requests to respond.' };
    case 'request_accepted':
      return { title: 'Request accepted', body: 'You can now chat.' };
    case 'security_session_replaced':
      return { title: 'New sign-in', body: `${p.device ?? 'A device'}${p.ip ? ` (${p.ip})` : ''} signed in to your account. Your previous session was signed out.` };
    case 'security_sessions_ended':
      return { title: 'Sessions ended', body: 'All sessions on your account were signed out.' };
    default:
      return { title: 'Notification', body: '' };
  }
}

function NotificationsPopover({ anchor, onClose }: { anchor: DOMRect; onClose: () => void }) {
  const items = useApp((s) => s.notifications.items);
  const ref = useRef<HTMLDivElement>(null);
  return (
    <Popover anchor={anchor} onClose={onClose} className="notif-panel">
      <div ref={ref}>
        <div className="notif-panel__head">Notifications</div>
        {items.length === 0 ? (
          <p className="notif-panel__empty">You're all caught up.</p>
        ) : (
          items.slice(0, 20).map((n) => {
            const t = notificationText(n);
            return (
              <button
                key={n.id}
                type="button"
                className={`notif${n.read ? '' : ' notif--unread'}`}
                onClick={() => {
                  onClose();
                  if (n.type === 'request_accepted' && (n.payload as { conversationId?: string }).conversationId) navigate(`/c/${(n.payload as { conversationId: string }).conversationId}`);
                  else if (n.type.startsWith('security')) navigate('/settings/security');
                }}
              >
                <span className="notif__title">
                  {t.title}
                  <span>{listStamp(n.createdAt)}</span>
                </span>
                <span className="notif__body">{t.body}</span>
              </button>
            );
          })
        )}
      </div>
    </Popover>
  );
}
