import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { LuCircleStop, LuMic, LuPaperclip, LuPause, LuPlay, LuSend, LuSmile, LuTrash2, LuX } from 'react-icons/lu';
import { errorMessage } from '../lib/api';
import { duration, fileSize } from '../lib/format';
import { MAX_MESSAGE_CHARS } from '../lib/text';
import type { Conversation, Message, ViewPolicy } from '../lib/types';
import { editMessage, realtime, sendFile, sendText, setBlocked, toast, useApp } from '../state/app';
import { usePlaintext } from '../state/crypto';
import { EmojiPicker } from './EmojiPicker';
import { Dialog, Segmented, Spinner } from './ui';

const drafts = new Map<string, string>();
const MB = 1024 * 1024;
const isTouch = () => window.matchMedia?.('(hover: none) and (pointer: coarse)').matches;

export interface EditState {
  m: Message;
  text: string;
}

export function Composer({ conv, reply, editing, onClearReply, onDoneEditing }: { conv: Conversation; reply: Message | null; editing: EditState | null; onClearReply: () => void; onDoneEditing: () => void }) {
  const me = useApp((s) => s.me)!;
  const [text, setText] = useState(() => drafts.get(conv.id) ?? '');
  const [emoji, setEmoji] = useState<DOMRect | null>(null);
  const [attach, setAttach] = useState<File | null>(null);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const typingSent = useRef(0);
  const typingStop = useRef<number | undefined>(undefined);

  // Entering edit mode loads the message text; leaving restores the draft.
  useEffect(() => {
    if (editing) {
      setText(editing.text);
      window.setTimeout(() => ta.current?.focus(), 0);
    } else setText(drafts.get(conv.id) ?? '');
  }, [editing, conv.id]);

  useEffect(() => {
    if (reply) ta.current?.focus();
  }, [reply]);

  useEffect(() => {
    if (!editing) {
      if (text) drafts.set(conv.id, text);
      else drafts.delete(conv.id);
    }
  }, [text, editing, conv.id]);

  // Grow with the text, up to the CSS max-height.
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  // Files can be dropped anywhere on the conversation.
  useEffect(() => {
    const chat = rootRef.current?.closest('.chat');
    if (!chat) return;
    const over = (e: Event) => {
      const de = e as DragEvent;
      if (de.dataTransfer?.types.includes('Files')) {
        de.preventDefault();
        chat.classList.add('chat--drop');
      }
    };
    const leave = (e: Event) => {
      if (e.target === chat) chat.classList.remove('chat--drop');
    };
    const drop = (e: Event) => {
      const de = e as DragEvent;
      chat.classList.remove('chat--drop');
      const f = de.dataTransfer?.files?.[0];
      if (f) {
        de.preventDefault();
        setAttach(f);
      }
    };
    chat.addEventListener('dragover', over);
    chat.addEventListener('dragleave', leave);
    chat.addEventListener('drop', drop);
    return () => {
      chat.removeEventListener('dragover', over);
      chat.removeEventListener('dragleave', leave);
      chat.removeEventListener('drop', drop);
    };
  }, []);

  useEffect(
    () => () => {
      window.clearTimeout(typingStop.current);
      if (typingSent.current) realtime.typing(conv.id, false);
    },
    [conv.id],
  );

  const stopTyping = () => {
    window.clearTimeout(typingStop.current);
    if (typingSent.current) {
      realtime.typing(conv.id, false);
      typingSent.current = 0;
    }
  };

  const onType = (v: string) => {
    setText(v);
    if (editing) return;
    const now = Date.now();
    if (v.trim() && now - typingSent.current > 2500) {
      realtime.typing(conv.id, true);
      typingSent.current = now;
    }
    window.clearTimeout(typingStop.current);
    typingStop.current = window.setTimeout(stopTyping, 4000);
    if (!v.trim()) stopTyping();
  };

  async function submit() {
    const value = text;
    if (!value.trim() || busy) return;
    if (value.length > MAX_MESSAGE_CHARS) {
      toast(`Messages can be at most ${MAX_MESSAGE_CHARS.toLocaleString()} characters.`, 'error');
      return;
    }
    stopTyping();
    if (editing) {
      setBusy(true);
      try {
        await editMessage(editing.m, value);
        onDoneEditing();
      } catch (err) {
        toast(errorMessage(err), 'error');
      } finally {
        setBusy(false);
      }
      return;
    }
    sendText(conv.id, value, reply);
    drafts.delete(conv.id);
    setText('');
    onClearReply();
    ta.current?.focus();
  }

  if (conv.peer?.deleted) {
    return <div className="composer composer__blocked">This account was deleted. You can't reply.</div>;
  }
  if (conv.peer?.blockedByMe) {
    return (
      <div className="composer composer__blocked">
        You blocked {conv.peer.displayName}.
        <button type="button" className="btn btn--sm" onClick={() => void setBlocked(conv.peer!.id, false).catch((err) => toast(errorMessage(err), 'error'))}>
          Unblock
        </button>
      </div>
    );
  }

  const context = editing ? { title: 'Editing message', body: editing.text, close: onDoneEditing } : reply ? { title: 'Replying', reply, close: onClearReply } : null;
  const showSend = !!text.trim() || !!editing;

  return (
    <div className="composer" ref={rootRef}>
      {context ? (
        <div className="composer__context">
          <div className="composer__context-body">
            <div className="composer__context-title">{context.title === 'Replying' && reply ? <ReplyTitle m={reply} conv={conv} meId={me.id} /> : context.title}</div>
            <div className="composer__context-text">{'reply' in context && context.reply ? <ReplyText m={context.reply} conv={conv} meId={me.id} /> : context.body}</div>
          </div>
          <button type="button" className="icon-btn" onClick={context.close} aria-label={editing ? 'Cancel editing' : 'Cancel reply'}>
            <LuX />
          </button>
        </div>
      ) : null}
      <div className="composer__row">
        {recording ? (
          <VoiceRecorder conv={conv} reply={reply} onDone={() => (setRecording(false), onClearReply())} />
        ) : (
          <>
            <div className="composer__box">
              <button type="button" className="icon-btn" aria-label="Emoji" onClick={(e) => setEmoji(e.currentTarget.getBoundingClientRect())}>
                <LuSmile />
              </button>
              <textarea
                ref={ta}
                rows={1}
                value={text}
                placeholder={editing ? 'Edit message' : 'Message'}
                aria-label="Message"
                maxLength={MAX_MESSAGE_CHARS + 100}
                onChange={(e) => onType(e.target.value)}
                onBlur={stopTyping}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !isTouch()) {
                    e.preventDefault();
                    void submit();
                  } else if (e.key === 'Escape' && context) {
                    context.close();
                  }
                }}
                onPaste={(e) => {
                  const f = e.clipboardData.files?.[0];
                  if (f && !editing) {
                    e.preventDefault();
                    setAttach(f);
                  }
                }}
              />
              {!editing ? (
                <button type="button" className="icon-btn" aria-label="Attach a file" onClick={() => fileRef.current?.click()}>
                  <LuPaperclip />
                </button>
              ) : null}
              <input
                ref={fileRef}
                type="file"
                hidden
                data-testid="file-input"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (f) setAttach(f);
                }}
              />
            </div>
            {showSend ? (
              <button type="button" className="composer__send" aria-label={editing ? 'Save edit' : 'Send'} onClick={() => void submit()} disabled={busy}>
                {busy ? <Spinner /> : <LuSend />}
              </button>
            ) : (
              <button type="button" className="composer__send" aria-label="Record a voice message" onClick={() => setRecording(true)}>
                <LuMic />
              </button>
            )}
          </>
        )}
      </div>
      {emoji ? (
        <EmojiPicker
          anchor={emoji}
          onClose={() => setEmoji(null)}
          onPick={(e) => {
            const el = ta.current;
            const start = el?.selectionStart ?? text.length;
            const end = el?.selectionEnd ?? text.length;
            const next = text.slice(0, start) + e + text.slice(end);
            onType(next);
            window.setTimeout(() => {
              el?.focus();
              el?.setSelectionRange(start + e.length, start + e.length);
            }, 0);
          }}
        />
      ) : null}
      {attach ? (
        <AttachSheet
          file={attach}
          conv={conv}
          reply={reply}
          initialCaption={text}
          onClose={() => setAttach(null)}
          onSent={() => {
            setAttach(null);
            setText('');
            drafts.delete(conv.id);
            onClearReply();
          }}
        />
      ) : null}
    </div>
  );
}

function ReplyTitle({ m, conv, meId }: { m: Message; conv: Conversation; meId: string }) {
  return <>Replying to {m.senderId === meId ? 'yourself' : (conv.peer?.displayName ?? '')}</>;
}

function ReplyText({ m, conv, meId }: { m: Message; conv: Conversation; meId: string }) {
  const recipient = m.senderId === meId ? (conv.peer?.id ?? null) : meId;
  const plain = usePlaintext(m.body, m.senderId, recipient);
  if (m.attachment) return <>{plain.status === 'ok' && plain.text ? plain.text : m.attachment.kind === 'file' ? 'Document' : m.attachment.kind[0]!.toUpperCase() + m.attachment.kind.slice(1)}</>;
  return <>{plain.status === 'ok' ? plain.text : '…'}</>;
}

// ---------------------------------------------------------------------------
// attachment sheet
// ---------------------------------------------------------------------------
type Kind = 'image' | 'video' | 'audio' | 'file';
const kindOf = (f: File): Kind => (f.type.startsWith('image/') ? 'image' : f.type.startsWith('video/') ? 'video' : f.type.startsWith('audio/') ? 'audio' : 'file');

function AttachSheet({ file, conv, reply, initialCaption, onClose, onSent }: { file: File; conv: Conversation; reply: Message | null; initialCaption: string; onClose: () => void; onSent: () => void }) {
  const me = useApp((s) => s.me)!;
  const kind = kindOf(file);
  const [url] = useState(() => (kind === 'file' ? null : URL.createObjectURL(file)));
  const [caption, setCaption] = useState(initialCaption);
  const [policy, setPolicy] = useState<ViewPolicy>('normal');
  const [previewFailed, setPreviewFailed] = useState(false);
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);

  const L = me.limits;
  const baseLimit = kind === 'image' ? L.maxImageMb : kind === 'video' ? L.maxVideoMb : kind === 'audio' ? L.maxAudioMb : L.maxFileMb;
  const limit = policy === 'normal' ? baseLimit : Math.min(baseLimit, L.maxProtectedMb);
  const tooBig = file.size > limit * MB;
  const protectable = kind !== 'file';
  const peerAccepts = conv.peerAcceptsProtectedMedia;
  const label = kind === 'image' ? 'photo' : kind === 'video' ? 'video' : kind === 'audio' ? 'audio' : 'document';

  const send = () => {
    sendFile(conv.id, file, { caption: policy === 'normal' ? caption : '', policy, replyTo: reply, fileName: file.name });
    onSent();
  };

  return (
    <Dialog title={`Send ${label}`} onClose={onClose} wide>
      <div className="attach-preview">
        {kind === 'image' && url && !previewFailed ? (
          <img src={url} alt="" onError={() => setPreviewFailed(true)} />
        ) : kind === 'video' && url && !previewFailed ? (
          <video src={url} controls muted playsInline onError={() => setPreviewFailed(true)} />
        ) : kind === 'audio' && url ? (
          <audio src={url} controls style={{ margin: 24, width: 'min(420px, 80%)' }} />
        ) : (
          <div className="file-chip">
            <span className="file-chip__icon">
              <LuPaperclip />
            </span>
            <span className="file-chip__body">
              <span className="file-chip__name">{file.name}</span>
              <span className="file-chip__meta">{fileSize(file.size)}</span>
            </span>
          </div>
        )}
      </div>
      <p className="field__hint" style={{ margin: '-8px 0 0' }}>
        {file.name} · {fileSize(file.size)}
        {previewFailed ? ' · preview unavailable in this browser' : ''}
      </p>
      {protectable ? (
        <div className="policy">
          <span className="policy__label">Who can keep it</span>
          <Segmented<ViewPolicy>
            label="Viewing"
            value={policy}
            onChange={setPolicy}
            options={[
              { value: 'normal', label: 'Normal' },
              { value: 'once', label: 'View once', disabled: !peerAccepts },
              { value: 'twice', label: 'View twice', disabled: !peerAccepts },
            ]}
          />
          <span className="policy__note">
            {!peerAccepts
              ? `${conv.peer?.displayName ?? 'This person'} doesn't accept view-once media.`
              : policy === 'normal'
                ? `${conv.peer?.displayName ?? 'They'} can open and download it any time.`
                : `${conv.peer?.displayName ?? 'They'} can open it ${policy === 'once' ? 'once' : 'twice'}; the server then deletes it. You won't be able to open it after sending. Screenshots can't be prevented in a browser.`}
          </span>
        </div>
      ) : null}
      {policy === 'normal' ? (
        <label className="field">
          <span className="field__label">Caption (optional)</span>
          <input className="input" value={caption} onChange={(e) => setCaption(e.target.value)} maxLength={1024} placeholder="Add a caption" />
        </label>
      ) : null}
      {tooBig ? (
        <div className="notice notice--error">
          This file is {fileSize(file.size)}. The limit for {policy === 'normal' ? `${label}s` : 'view-once media'} is {limit} MB.
        </div>
      ) : null}
      <div className="dialog__actions">
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn btn--primary" onClick={send} disabled={tooBig} data-testid="send-attachment">
          <LuSend /> Send
        </button>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// voice messages
// ---------------------------------------------------------------------------
const MAX_RECORD_MS = 15 * 60_000;

function pickMime(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  return ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm'].find((t) => MediaRecorder.isTypeSupported(t));
}

function VoiceRecorder({ conv, reply, onDone }: { conv: Conversation; reply: Message | null; onDone: () => void }) {
  const [phase, setPhase] = useState<'starting' | 'recording' | 'preview' | 'error'>('starting');
  const [error, setError] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [once, setOnce] = useState(false);
  const rec = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const started = useRef(0);
  const discard = useRef(false);
  const audio = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    let timer: number | undefined;
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
        setError("This browser can't record audio.");
        setPhase('error');
        return;
      }
      try {
        // The microphone permission prompt appears only now, when the user chose to record.
        const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        stream.current = s;
        const mime = pickMime();
        const r = new MediaRecorder(s, mime ? { mimeType: mime, audioBitsPerSecond: 48_000 } : undefined);
        const chunks: BlobPart[] = [];
        r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
        r.onstop = () => {
          s.getTracks().forEach((t) => t.stop());
          window.clearInterval(timer);
          if (discard.current) return;
          const b = new Blob(chunks, { type: r.mimeType || mime || 'audio/webm' });
          setBlob(b);
          setUrl(URL.createObjectURL(b));
          setPhase('preview');
        };
        rec.current = r;
        r.start(250);
        started.current = Date.now();
        setPhase('recording');
        timer = window.setInterval(() => {
          const ms = Date.now() - started.current;
          setElapsed(ms);
          if (ms >= MAX_RECORD_MS) r.stop();
        }, 200);
      } catch (err) {
        const name = (err as DOMException).name;
        setError(name === 'NotAllowedError' ? 'Microphone access was blocked. Allow it in your browser settings to record.' : name === 'NotFoundError' ? 'No microphone was found.' : "Couldn't start recording.");
        setPhase('error');
      }
    })();
    return () => {
      window.clearInterval(timer);
      discard.current = true;
      if (rec.current && rec.current.state !== 'inactive') rec.current.stop();
      stream.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);

  const cancel = () => {
    discard.current = true;
    if (rec.current && rec.current.state !== 'inactive') rec.current.stop();
    onDone();
  };

  const send = () => {
    if (!blob) return;
    const ext = blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm';
    sendFile(conv.id, blob, { voice: true, durationMs: elapsed, policy: once ? 'once' : 'normal', replyTo: reply, fileName: `voice.${ext}` });
    onDone();
  };

  return (
    <>
      <div className="recorder" role="group" aria-label="Voice message">
        <button type="button" className="icon-btn" onClick={cancel} aria-label="Discard recording">
          <LuTrash2 />
        </button>
        {phase === 'recording' ? <span className="recorder__dot" aria-hidden="true" /> : null}
        {phase === 'preview' ? (
          <button type="button" className="icon-btn" aria-label={playing ? 'Pause' : 'Play recording'} onClick={() => (audio.current?.paused ? void audio.current.play() : audio.current?.pause())}>
            {playing ? <LuPause /> : <LuPlay />}
          </button>
        ) : null}
        <span className="recorder__time" aria-live="off">
          {duration(elapsed)}
        </span>
        <span className="recorder__hint">{phase === 'starting' ? 'Starting microphone…' : phase === 'recording' ? 'Recording…' : phase === 'preview' ? 'Ready to send' : error}</span>
        {phase === 'preview' ? (
          <button
            type="button"
            className={`recorder__once${once ? ' recorder__once--on' : ''}`}
            aria-pressed={once}
            onClick={() => setOnce((o) => !o)}
            title={conv.peerAcceptsProtectedMedia ? 'View once' : "They don't accept view-once media"}
            disabled={!conv.peerAcceptsProtectedMedia}
          >
            1
          </button>
        ) : null}
        {url ? <audio ref={audio} src={url} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} /> : null}
      </div>
      {phase === 'recording' ? (
        <button type="button" className="composer__send" onClick={() => rec.current?.stop()} aria-label="Stop recording">
          <LuCircleStop />
        </button>
      ) : phase === 'preview' ? (
        <button type="button" className="composer__send" onClick={send} aria-label="Send voice message">
          <LuSend />
        </button>
      ) : (
        <button type="button" className="composer__send" onClick={cancel} aria-label="Close">
          <LuX />
        </button>
      )}
    </>
  );
}
