import { useEffect, useMemo, useState } from 'react';
import { LuArrowLeft, LuCheck, LuSearch } from 'react-icons/lu';
import { ApiError, errorMessage, get } from '../lib/api';
import { navigate } from '../lib/router';
import type { PublicProfile } from '../lib/types';
import { forward, reportUser, startConversation, toast, useApp } from '../state/app';
import { closeNewChat, ui, useUi } from '../state/ui';
import { Avatar, Dialog, Spinner } from './ui';

/** Dialogs that can be opened from anywhere in the app. */
export function GlobalDialogs() {
  const newChat = useUi((s) => s.newChat);
  const fwd = useUi((s) => s.forward);
  const report = useUi((s) => s.report);
  return (
    <>
      {newChat.open ? <NewChatDialog initial={newChat.user} /> : null}
      {fwd ? <ForwardDialog /> : null}
      {report ? <ReportDialog /> : null}
    </>
  );
}

function NewChatDialog({ initial }: { initial: PublicProfile | null }) {
  const conversations = useApp((s) => s.conversations);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<PublicProfile[] | null>(null);
  const [selected, setSelected] = useState<PublicProfile | null>(initial);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const term = q.trim();
    if (!/^@?[a-z0-9_.]{2,24}$/i.test(term)) {
      setResults(term ? [] : null);
      return;
    }
    setResults(null);
    const t = window.setTimeout(() => {
      get<{ users: PublicProfile[] }>(`/api/users/search?q=${encodeURIComponent(term)}`)
        .then((r) => setResults(r.users))
        .catch((err) => {
          setResults([]);
          setError(errorMessage(err));
        });
    }, 250);
    return () => window.clearTimeout(t);
  }, [q]);

  const existing = selected ? Object.values(conversations).find((c) => c.peer?.id === selected.id) : undefined;

  async function start() {
    if (!selected) return;
    if (existing) {
      closeNewChat();
      navigate(`/c/${existing.id}`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await startConversation(selected.id, note);
      closeNewChat();
      if (r.conversation) navigate(`/c/${r.conversation.id}`);
      else toast(`Message request sent to ${selected.displayName}. You can chat once they accept.`);
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title={selected ? 'Start a conversation' : 'New chat'} onClose={closeNewChat}>
      {!selected ? (
        <>
          <label className="search">
            <LuSearch aria-hidden="true" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by username" aria-label="Username" autoFocus data-autofocus autoCapitalize="none" spellCheck={false} />
          </label>
          <div className="pick-list" style={{ minHeight: 120 }}>
            {results === null && q.trim() ? (
              <div className="timeline__loader">
                <Spinner />
              </div>
            ) : results && results.length === 0 && q.trim() ? (
              <p className="field__hint" style={{ padding: '8px 12px' }}>
                No one with that username. Usernames are 3–24 characters, like @maya or @alex.k
              </p>
            ) : !q.trim() ? (
              <p className="field__hint" style={{ padding: '8px 12px' }}>
                People are found by username only. Email addresses are never shown or searchable.
              </p>
            ) : (
              results!.map((u) => (
                <button key={u.id} type="button" className="row" onClick={() => setSelected(u)} data-testid={`user-result-${u.username}`}>
                  <Avatar name={u.displayName} url={u.avatarUrl} size={44} />
                  <span className="row__body">
                    <span className="row__name">{u.displayName}</span>
                    <span className="row__preview">@{u.username}</span>
                  </span>
                </button>
              ))
            )}
          </div>
        </>
      ) : (
        <>
          <div className="profile-hero" style={{ padding: '4px 0 0' }}>
            <Avatar name={selected.displayName} url={selected.avatarUrl} size={80} />
            <h3>{selected.displayName}</h3>
            <span className="handle">@{selected.username}</span>
            {selected.bio ? <p className="bio">{selected.bio}</p> : null}
          </div>
          {existing ? (
            <p className="dialog__text">You already have a conversation with {selected.displayName}.</p>
          ) : (
            <label className="field">
              <span className="field__label">Say hello (optional)</span>
              <textarea className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={280} rows={2} placeholder={`Hi ${selected.displayName.split(' ')[0]}! It's …`} />
              <span className="field__hint">If {selected.displayName.split(' ')[0]} only accepts requests, this note goes with your request. It's end-to-end encrypted.</span>
            </label>
          )}
          {error ? <div className="notice notice--error">{error}</div> : null}
          <div className="dialog__actions">
            {!initial ? (
              <button type="button" className="btn btn--ghost" onClick={() => setSelected(null)}>
                <LuArrowLeft /> Back
              </button>
            ) : null}
            <button type="button" className="btn btn--primary" onClick={() => void start()} disabled={busy} data-testid="start-chat">
              {busy ? <Spinner /> : existing ? 'Open chat' : 'Start chat'}
            </button>
          </div>
        </>
      )}
    </Dialog>
  );
}

function ForwardDialog() {
  const message = useUi((s) => s.forward)!;
  const conversations = useApp((s) => s.conversations);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const list = useMemo(
    () => Object.values(conversations).filter((c) => c.peer && !c.peer.blockedByMe && !c.peer.deleted).sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt)),
    [conversations],
  );
  const close = () => ui.set({ forward: null });

  async function send() {
    setBusy(true);
    try {
      const r = await forward(message, picked);
      close();
      toast(r.forwardedTo.length === picked.length ? `Forwarded to ${picked.length === 1 ? '1 chat' : `${picked.length} chats`}.` : `Forwarded to ${r.forwardedTo.length} of ${picked.length} chats.`);
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="Forward to…" onClose={close}>
      <div className="pick-list">
        {list.map((c) => {
          const on = picked.includes(c.id);
          return (
            <button
              key={c.id}
              type="button"
              className="row"
              aria-pressed={on}
              onClick={() => setPicked((p) => (on ? p.filter((x) => x !== c.id) : p.length >= 5 ? p : [...p, c.id]))}
            >
              <Avatar name={c.peer!.displayName} url={c.peer!.avatarUrl} size={40} />
              <span className="row__body">
                <span className="row__name">{c.peer!.displayName}</span>
                <span className="row__preview">@{c.peer!.username}</span>
              </span>
              <span className={`check${on ? ' check--on' : ''}`}>{on ? <LuCheck /> : null}</span>
            </button>
          );
        })}
        {!list.length ? <p className="field__hint">No conversations to forward to.</p> : null}
      </div>
      <p className="field__hint">Up to 5 chats. The text is re-encrypted for each person.</p>
      <div className="dialog__actions">
        <button type="button" className="btn" onClick={close}>
          Cancel
        </button>
        <button type="button" className="btn btn--primary" disabled={!picked.length || busy} onClick={() => void send()}>
          {busy ? <Spinner /> : `Forward${picked.length ? ` (${picked.length})` : ''}`}
        </button>
      </div>
    </Dialog>
  );
}

const REASONS: { value: string; label: string }[] = [
  { value: 'spam', label: 'Spam or scam' },
  { value: 'harassment', label: 'Harassment or bullying' },
  { value: 'inappropriate', label: 'Inappropriate content' },
  { value: 'impersonation', label: 'Pretending to be someone else' },
  { value: 'other', label: 'Something else' },
];

function ReportDialog() {
  const report = useUi((s) => s.report)!;
  const [reason, setReason] = useState('spam');
  const [details, setDetails] = useState('');
  const [includeText, setIncludeText] = useState(!!report.message);
  const [block, setBlock] = useState(true);
  const [busy, setBusy] = useState(false);
  const close = () => ui.set({ report: null });

  async function submit() {
    setBusy(true);
    try {
      await reportUser(report.userId, { reason, details, message: report.message, includeText, block });
      close();
      toast(block ? 'Report sent and user blocked. Thank you.' : 'Report sent. Thank you.');
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title={report.message ? 'Report message' : 'Report user'} onClose={close}>
      <div className="field">
        <span className="field__label">What's wrong?</span>
        <div className="radio-list" role="radiogroup">
          {REASONS.map((r) => (
            <label key={r.value} className="radio">
              <input type="radio" name="reason" value={r.value} checked={reason === r.value} onChange={() => setReason(r.value)} />
              <span>{r.label}</span>
            </label>
          ))}
        </div>
      </div>
      <label className="field">
        <span className="field__label">Details (optional)</span>
        <textarea className="input" value={details} onChange={(e) => setDetails(e.target.value)} maxLength={1000} rows={3} />
      </label>
      {report.message ? (
        <label className="checkline">
          <input type="checkbox" checked={includeText} onChange={(e) => setIncludeText(e.target.checked)} />
          <span>Share this message's text with moderators. Messages are end-to-end encrypted, so moderators can only see what you choose to share.</span>
        </label>
      ) : null}
      <label className="checkline">
        <input type="checkbox" checked={block} onChange={(e) => setBlock(e.target.checked)} />
        <span>Also block this person</span>
      </label>
      <div className="dialog__actions">
        <button type="button" className="btn" onClick={close}>
          Cancel
        </button>
        <button type="button" className="btn btn--danger" onClick={() => void submit()} disabled={busy}>
          {busy ? <Spinner /> : 'Send report'}
        </button>
      </div>
    </Dialog>
  );
}
