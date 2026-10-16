import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  LuBan,
  LuChevronDown,
  LuCopy,
  LuFileText,
  LuFlag,
  LuForward,
  LuLockKeyhole,
  LuPencil,
  LuPlus,
  LuReply,
  LuShieldAlert,
  LuTimer,
  LuTrash2,
} from 'react-icons/lu';
import { errorMessage } from '../lib/api';
import { dayKey, dayLabel, fileSize, timeOf } from '../lib/format';
import { shallowArray } from '../lib/store';
import { displayText, isJumboEmoji, linkify } from '../lib/text';
import type { Conversation, Message } from '../lib/types';
import { deleteMessage, discardPending, kindLabel, loadAround, loadLatest, loadOlder, markRead, react, retryPending, store, systemText, toast, useApp, type Pending } from '../state/app';
import { usePlaintext } from '../state/crypto';
import { ui, useUi } from '../state/ui';
import { EmojiPicker, QUICK_REACTIONS } from './EmojiPicker';
import { AttachmentView, RingProgress } from './Media';
import { StatusTick } from './Rail';
import { Dialog, MenuItem, Popover, Spinner, useLongPress } from './ui';

function loadOlderIfNeeded(convId: string) {
  const cm = store.get().messages[convId];
  if (cm?.loaded && cm.hasMoreBefore && !cm.loadingOlder) void loadOlder(convId);
}

const idCmp = (a: string, b: string) => (a.length !== b.length ? a.length - b.length : a < b ? -1 : a > b ? 1 : 0);
const GROUP_GAP_MS = 5 * 60_000;

export interface TimelineActions {
  onReply: (m: Message) => void;
  onEdit: (m: Message, text: string) => void;
  onVerify: () => void;
}

export function Timeline({ conv, actions }: { conv: Conversation; actions: TimelineActions }) {
  const meId = useApp((s) => s.me!.id);
  const cm = useApp((s) => s.messages[conv.id]);
  const pending = useApp(
    (s) => Object.values(s.pending).filter((p) => p.conversationId === conv.id),
    shallowArray,
  );
  const jump = useUi((s) => s.jump);
  const scrollRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const prev = useRef<{ first?: string; last?: string; height: number; top: number } | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [newBelow, setNewBelow] = useState(0);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const firstUnread = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (!cm?.loaded) loadLatest(conv.id).catch((err) => setError(errorMessage(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conv.id]);

  const items = cm?.items ?? [];
  if (cm?.loaded && firstUnread.current === undefined) {
    const f = items.find((m) => m.senderId && m.senderId !== meId && idCmp(m.id, conv.lastReadMessageId) > 0);
    firstUnread.current = f?.id ?? null;
  }

  // Keep the view anchored: stay at the bottom for new messages, keep position when older ones load.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !cm?.loaded) return;
    const first = items[0]?.id;
    const last = items.at(-1)?.id;
    const p = prev.current;
    if (!p) {
      const target = firstUnread.current ? document.getElementById(`unread-divider`) : null;
      if (target) {
        target.scrollIntoView({ block: 'center' });
        stick.current = false;
      } else el.scrollTop = el.scrollHeight;
    } else if (p.first !== first && p.last === last) {
      el.scrollTop = el.scrollHeight - p.height + p.top;
    } else if (stick.current) {
      el.scrollTop = el.scrollHeight;
    } else if (p.last !== last) {
      const added = items.filter((m) => p.last && idCmp(m.id, p.last) > 0 && m.senderId !== meId).length;
      if (added) setNewBelow((n) => n + added);
    }
    prev.current = { first, last, height: el.scrollHeight, top: el.scrollTop };
    // Re-derive "at bottom" from the real position (content may fit entirely, or have grown below).
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (bottom) stick.current = true;
    setAtBottom(bottom);
    // If the top of the history is (still) on screen, keep loading older pages.
    const top = topRef.current;
    if (top && top.getBoundingClientRect().bottom >= el.getBoundingClientRect().top - 400) loadOlderIfNeeded(conv.id);
  }, [items, pending.length, cm?.loaded, meId, conv.id]);

  // Load older history whenever the top of the timeline comes into view — this also works when the
  // view is already at the very top, where scrolling up produces no scroll events.
  useEffect(() => {
    const root = scrollRef.current;
    const top = topRef.current;
    if (!root || !top || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && loadOlderIfNeeded(conv.id), { root, rootMargin: '400px 0px 0px 0px' });
    io.observe(top);
    return () => io.disconnect();
  }, [conv.id]);

  // Images and players change height after they load; keep the bottom pinned while sticking.
  useEffect(() => {
    const inner = innerRef.current;
    const el = scrollRef.current;
    if (!inner || !el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
      prev.current = prev.current ? { ...prev.current, height: el.scrollHeight, top: el.scrollTop } : prev.current;
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, []);

  // Jump to a message (search result, reply quote).
  useEffect(() => {
    if (!jump || jump.conversationId !== conv.id) return;
    let cancelled = false;
    (async () => {
      if (!document.getElementById(`m-${jump.messageId}`)) {
        try {
          await loadAround(conv.id, jump.messageId);
        } catch (err) {
          toast(errorMessage(err), 'error');
          return;
        }
      }
      await new Promise((r) => requestAnimationFrame(r));
      if (cancelled) return;
      const node = document.getElementById(`m-${jump.messageId}`);
      if (node) {
        stick.current = false;
        node.scrollIntoView({ block: 'center', behavior: 'smooth' });
        setHighlight(jump.messageId);
        window.setTimeout(() => setHighlight(null), 1800);
      } else toast('That message is no longer available.');
      ui.set({ jump: null });
    })();
    return () => {
      cancelled = true;
    };
  }, [jump, conv.id]);

  const onScroll = () => {
    const el = scrollRef.current!;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stick.current = bottom;
    if (bottom !== atBottom) setAtBottom(bottom);
    if (bottom && newBelow) {
      setNewBelow(0);
      markRead(conv.id);
    }
    if (el.scrollTop < 400) loadOlderIfNeeded(conv.id);
    prev.current = prev.current ? { ...prev.current, height: el.scrollHeight, top: el.scrollTop } : prev.current;
  };

  const rows = useMemo(() => {
    const out: React.ReactNode[] = [];
    let prevMsg: Message | null = null;
    let lastDay = '';
    for (const m of items) {
      const day = dayKey(m.createdAt);
      if (day !== lastDay) {
        out.push(
          <div key={`d-${m.id}`} className="day">
            {dayLabel(m.createdAt)}
          </div>,
        );
        lastDay = day;
        prevMsg = null;
      }
      if (m.id === firstUnread.current) {
        out.push(
          <div key="unread" id="unread-divider" className="unread-divider">
            Unread messages
          </div>,
        );
      }
      if (m.kind === 'system') {
        out.push(<SystemMessage key={m.id} m={m} conv={conv} meId={meId} onVerify={actions.onVerify} />);
        prevMsg = null;
        continue;
      }
      const groupStart = !prevMsg || prevMsg.senderId !== m.senderId || Date.parse(m.createdAt) - Date.parse(prevMsg.createdAt) > GROUP_GAP_MS;
      out.push(<MessageItem key={m.id} m={m} conv={conv} meId={meId} groupStart={groupStart} highlight={highlight === m.id} actions={actions} />);
      prevMsg = m;
    }
    return out;
  }, [items, conv, meId, highlight, actions]);

  const sortedPending = [...pending].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  return (
    <div className="timeline" ref={scrollRef} onScroll={onScroll} role="log" aria-label="Messages" aria-live="polite">
      <div className="timeline__inner" ref={innerRef}>
        <div ref={topRef} className="timeline__sentinel" aria-hidden="true" />
        {!cm?.loaded ? (
          <div className="timeline__loader">{error ? <span>{error}</span> : <Spinner />}</div>
        ) : cm.loadingOlder ? (
          <div className="timeline__loader">
            <Spinner label="Loading older messages" />
          </div>
        ) : !cm.hasMoreBefore ? (
          <div className="e2ee-note">
            <LuLockKeyhole /> Messages and captions are end-to-end encrypted. Only you and {conv.peer?.displayName ?? 'this person'} can read them.
          </div>
        ) : null}
        {rows}
        {sortedPending.map((p) => (
          <PendingItem key={p.clientId} p={p} />
        ))}
      </div>
      {!atBottom ? (
        <button
          type="button"
          className="scroll-bottom"
          aria-label="Scroll to latest messages"
          onClick={() => {
            const el = scrollRef.current!;
            el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
            setNewBelow(0);
            markRead(conv.id);
          }}
        >
          <LuChevronDown />
          {newBelow ? <span className="count">{newBelow}</span> : null}
        </button>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// messages
// ---------------------------------------------------------------------------
function MetaLine({ m, mine, overlay }: { m: Message; mine: boolean; overlay?: boolean }) {
  return (
    <span className={`meta${overlay ? ' meta--overlay' : ''}`}>
      {m.expiresAt ? <LuTimer aria-label="Disappearing message" /> : null}
      {m.editedAt && !m.deleted ? <span>edited</span> : null}
      <time dateTime={m.createdAt}>{timeOf(m.createdAt)}</time>
      {mine ? <StatusTick status={m.status} /> : null}
    </span>
  );
}

function MessageItem({ m, conv, meId, groupStart, highlight, actions }: { m: Message; conv: Conversation; meId: string; groupStart: boolean; highlight: boolean; actions: TimelineActions }) {
  const mine = m.senderId === meId;
  const recipient = mine ? (conv.peer?.id ?? null) : meId;
  const plain = usePlaintext(m.deleted ? null : m.body, m.senderId, recipient);
  const [menu, setMenu] = useState<DOMRect | { x: number; y: number } | null>(null);
  const press = useLongPress((p) => setMenu(p));
  const text = plain.status === 'ok' ? displayText(plain.text) : '';
  const a = m.deleted ? null : m.attachment;
  const visualMedia = !!a && a.viewPolicy === 'normal' && (a.kind === 'image' || a.kind === 'video');
  const jumbo = !a && !!text && isJumboEmoji(text);

  const cls = ['msg', mine ? 'msg--out' : '', groupStart ? 'msg--group-start' : '', a ? 'msg--media' : '', highlight ? 'msg--highlight' : ''].filter(Boolean).join(' ');
  return (
    <div className={cls} id={`m-${m.id}`} data-testid="message" data-mine={mine ? 'true' : 'false'}>
      <div className={`bubble${jumbo ? ' bubble--jumbo' : ''}`} {...press}>
        {m.forwarded && !m.deleted ? (
          <div className="bubble__forwarded">
            <LuForward /> Forwarded
          </div>
        ) : null}
        {m.replyTo && !m.deleted ? <ReplyQuote m={m} conv={conv} meId={meId} /> : null}
        {m.deleted ? (
          <div className="bubble__text">
            <span className="bubble__deleted">
              <LuBan /> {mine ? 'You deleted this message' : 'This message was deleted'}
            </span>
            <MetaLine m={m} mine={mine} />
          </div>
        ) : (
          <>
            {a ? (
              <div className="bubble__media">
                <AttachmentView m={m} mine={mine} />
                {visualMedia && !m.body ? <MetaLine m={m} mine={mine} overlay /> : null}
              </div>
            ) : null}
            {plain.status === 'error' ? (
              <div className="bubble__text">
                <span className="bubble__deleted" title="This device doesn't have the key this message was encrypted with.">
                  <LuLockKeyhole /> {plain.reason}
                </span>
                <MetaLine m={m} mine={mine} />
              </div>
            ) : text ? (
              <div className={`bubble__text${jumbo ? ' bubble__text--jumbo' : ''}`} dir="auto">
                {linkify(text)}
                <MetaLine m={m} mine={mine} />
              </div>
            ) : plain.status === 'pending' ? (
              <div className="bubble__text">
                <span className="bubble__deleted">Decrypting…</span>
              </div>
            ) : !visualMedia ? (
              <div className="bubble__meta-row">
                <MetaLine m={m} mine={mine} />
              </div>
            ) : null}
          </>
        )}
      </div>
      <Reactions m={m} meId={meId} />
      {!m.deleted ? (
        <button type="button" className="msg__menu-btn" aria-label="Message options" aria-haspopup="menu" aria-expanded={!!menu} onClick={(e) => setMenu(e.currentTarget.getBoundingClientRect())}>
          <LuChevronDown />
        </button>
      ) : null}
      {menu ? <MessageMenu m={m} conv={conv} mine={mine} text={text} anchor={menu} onClose={() => setMenu(null)} actions={actions} /> : null}
    </div>
  );
}

function ReplyQuote({ m, conv, meId }: { m: Message; conv: Conversation; meId: string }) {
  const r = m.replyTo!;
  const recipient = r.senderId === meId ? (conv.peer?.id ?? null) : meId;
  const plain = usePlaintext(r.unavailable || r.deleted ? null : r.body, r.senderId, recipient);
  const who = r.senderId === meId ? 'You' : (conv.peer?.displayName ?? '');
  let text: string;
  if (r.unavailable) text = 'Message unavailable';
  else if (r.deleted) text = 'Deleted message';
  else if (r.kind !== 'text') text = kindLabel(r.kind, r.viewPolicy) + (plain.status === 'ok' && r.viewPolicy === 'normal' ? ` · ${plain.text}` : '');
  else text = plain.status === 'ok' ? plain.text : plain.status === 'error' ? 'Encrypted message' : '…';
  return (
    <button
      type="button"
      className="reply-quote"
      onClick={() => !r.unavailable && ui.set({ jump: { conversationId: m.conversationId, messageId: r.id, nonce: Date.now() } })}
      aria-label={`Reply to ${who}: ${text}`}
    >
      <span className="reply-quote__who">{who}</span>
      <span className="reply-quote__text">{displayText(text)}</span>
    </button>
  );
}

function Reactions({ m, meId }: { m: Message; meId: string }) {
  if (!m.reactions.length || m.deleted) return null;
  const groups = new Map<string, { n: number; mine: boolean }>();
  for (const r of m.reactions) {
    const g = groups.get(r.emoji) ?? { n: 0, mine: false };
    g.n++;
    if (r.userId === meId) g.mine = true;
    groups.set(r.emoji, g);
  }
  return (
    <div className="reactions">
      {[...groups].map(([emoji, g]) => (
        <button
          key={emoji}
          type="button"
          className={`reaction${g.mine ? ' reaction--mine' : ''}`}
          aria-label={`${emoji} ${g.n}${g.mine ? ', including you. Tap to remove' : ''}`}
          onClick={() => react(m, g.mine ? null : emoji).catch((err) => toast(errorMessage(err), 'error'))}
        >
          {emoji}
          {g.n > 1 ? <span className="reaction__n">{g.n}</span> : null}
        </button>
      ))}
    </div>
  );
}

function MessageMenu({ m, conv, mine, text, anchor, onClose, actions }: { m: Message; conv: Conversation; mine: boolean; text: string; anchor: DOMRect | { x: number; y: number }; onClose: () => void; actions: TimelineActions }) {
  const me = useApp((s) => s.me)!;
  const [picker, setPicker] = useState<DOMRect | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const ageMin = (Date.now() - Date.parse(m.createdAt)) / 60_000;
  const blocked = !!conv.peer?.blockedByMe;
  const canEdit = mine && m.kind === 'text' && !!text && ageMin < me.limits.editWindowMinutes && !blocked;
  const protectedMedia = m.attachment && m.attachment.viewPolicy !== 'normal';
  const myReaction = m.reactions.find((r) => r.userId === me.id)?.emoji;
  const doReact = (emoji: string) => {
    onClose();
    void react(m, myReaction === emoji ? null : emoji).catch((err) => toast(errorMessage(err), 'error'));
  };

  if (confirmDelete) return <DeleteDialog m={m} mine={mine} onClose={onClose} />;
  if (picker) return <EmojiPicker anchor={picker} onPick={doReact} onClose={onClose} />;

  return (
    <Popover anchor={anchor} onClose={onClose} className="msg-menu">
      {!blocked ? (
        <div className="menu__reactions" role="group" aria-label="React">
          {QUICK_REACTIONS.map((e) => (
            <button key={e} type="button" aria-pressed={myReaction === e} aria-label={`React ${e}`} onClick={() => doReact(e)}>
              {e}
            </button>
          ))}
          <button type="button" aria-label="More reactions" onClick={(e) => setPicker(e.currentTarget.getBoundingClientRect())}>
            <LuPlus style={{ width: 20, height: 20 }} />
          </button>
        </div>
      ) : null}
      {!blocked ? (
        <MenuItem
          icon={<LuReply />}
          onClick={() => {
            onClose();
            actions.onReply(m);
          }}
        >
          Reply
        </MenuItem>
      ) : null}
      {text ? (
        <MenuItem
          icon={<LuCopy />}
          onClick={() => {
            onClose();
            void navigator.clipboard?.writeText(text).then(
              () => toast('Copied'),
              () => toast("Couldn't copy to the clipboard.", 'error'),
            );
          }}
        >
          Copy text
        </MenuItem>
      ) : null}
      {!protectedMedia ? (
        <MenuItem
          icon={<LuForward />}
          onClick={() => {
            onClose();
            ui.set({ forward: m });
          }}
        >
          Forward
        </MenuItem>
      ) : null}
      {canEdit ? (
        <MenuItem
          icon={<LuPencil />}
          onClick={() => {
            onClose();
            actions.onEdit(m, text);
          }}
        >
          Edit
        </MenuItem>
      ) : null}
      {!mine && conv.peer ? (
        <MenuItem
          icon={<LuFlag />}
          onClick={() => {
            onClose();
            ui.set({ report: { userId: conv.peer!.id, message: m } });
          }}
        >
          Report
        </MenuItem>
      ) : null}
      <div className="menu__sep" />
      <MenuItem icon={<LuTrash2 />} danger onClick={() => setConfirmDelete(true)}>
        Delete
      </MenuItem>
    </Popover>
  );
}

function DeleteDialog({ m, mine, onClose }: { m: Message; mine: boolean; onClose: () => void }) {
  const me = useApp((s) => s.me)!;
  const [busy, setBusy] = useState<string | null>(null);
  const ageMin = (Date.now() - Date.parse(m.createdAt)) / 60_000;
  const forEveryone = mine && !m.deleted && ageMin < me.limits.deleteWindowMinutes;
  const run = async (scope: 'me' | 'everyone') => {
    setBusy(scope);
    try {
      await deleteMessage(m, scope);
      onClose();
    } catch (err) {
      toast(errorMessage(err), 'error');
      setBusy(null);
    }
  };
  return (
    <Dialog title="Delete message?" onClose={onClose}>
      <p className="dialog__text">
        {forEveryone ? 'Delete for everyone removes it, and any attached media, for both of you.' : 'This removes the message from your device and account only.'}
      </p>
      <div className="dialog__actions dialog__actions--stack">
        {forEveryone ? (
          <button type="button" className="btn btn--danger" onClick={() => void run('everyone')} disabled={!!busy}>
            {busy === 'everyone' ? <Spinner /> : 'Delete for everyone'}
          </button>
        ) : null}
        <button type="button" className={`btn${forEveryone ? '' : ' btn--danger'}`} onClick={() => void run('me')} disabled={!!busy}>
          {busy === 'me' ? <Spinner /> : 'Delete for me'}
        </button>
        <button type="button" className="btn btn--ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Dialog>
  );
}

function SystemMessage({ m, conv, meId, onVerify }: { m: Message; conv: Conversation; meId: string; onVerify: () => void }) {
  const t = m.system?.type;
  const text = systemText(m.system, meId, conv.peer?.displayName);
  if (t === 'key_changed' && m.system?.userId !== meId) {
    return (
      <button type="button" className="system-msg system-msg--action" onClick={onVerify}>
        <LuShieldAlert /> {text}. Tap to verify.
      </button>
    );
  }
  return (
    <div className="system-msg">
      {t === 'ttl_changed' ? <LuTimer /> : t === 'conversation_started' ? <LuLockKeyhole /> : <LuShieldAlert />}
      {t === 'conversation_started' ? 'Conversation started · end-to-end encrypted' : text}
    </div>
  );
}

// ---------------------------------------------------------------------------
// outgoing messages that haven't reached the server yet
// ---------------------------------------------------------------------------
function PendingItem({ p }: { p: Pending }) {
  const failed = p.state === 'failed';
  const media = p.kind !== 'text';
  const visual = (p.kind === 'image' || p.kind === 'video') && p.previewUrl;
  return (
    <div className={`msg msg--out msg--group-start${media ? ' msg--media' : ''} msg--pending`} data-testid="pending-message">
      <div className="bubble">
        {visual ? (
          <div className="media-tile" style={{ width: 240, height: 180 }}>
            {p.kind === 'image' ? <img src={p.previewUrl} alt="" /> : <video src={p.previewUrl} muted playsInline />}
            {p.state === 'uploading' ? (
              <span className="media-tile__progress">
                <RingProgress value={p.progress ?? 0} />
              </span>
            ) : null}
          </div>
        ) : media ? (
          <div className="file-chip">
            <span className="file-chip__icon">{p.state === 'uploading' ? <Spinner /> : <LuFileText />}</span>
            <span className="file-chip__body">
              <span className="file-chip__name">{p.kind === 'voice' ? 'Voice message' : p.fileName}</span>
              <span className="file-chip__meta">
                {p.state === 'uploading' ? `Uploading ${Math.round((p.progress ?? 0) * 100)}%` : p.file ? fileSize(p.file.size) : ''}
                {p.policy && p.policy !== 'normal' ? ` · ${p.policy === 'once' ? 'View once' : 'View twice'}` : ''}
              </span>
            </span>
          </div>
        ) : null}
        {p.body || !media ? (
          <div className="bubble__text" dir="auto">
            {p.body}
            <span className="meta">
              <time>{timeOf(p.createdAt)}</time>
              <StatusTick status={failed ? 'failed' : 'pending'} />
            </span>
          </div>
        ) : (
          <div className="bubble__meta-row">
            <span className="meta">
              <time>{timeOf(p.createdAt)}</time>
              <StatusTick status={failed ? 'failed' : 'pending'} />
            </span>
          </div>
        )}
      </div>
      {failed ? (
        <div className="msg__retry" role="alert">
          <span>{p.error ?? 'Not sent.'}</span>
          <button type="button" onClick={() => retryPending(p.clientId)}>
            Retry
          </button>
          <button type="button" className="danger" onClick={() => discardPending(p.clientId)}>
            Delete
          </button>
        </div>
      ) : p.state === 'uploading' && p.progress !== undefined ? null : null}
    </div>
  );
}
