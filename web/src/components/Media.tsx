import { useCallback, useEffect, useRef, useState } from 'react';
import {
  LuDownload,
  LuEyeOff,
  LuFile,
  LuFileArchive,
  LuFileAudio,
  LuFileSpreadsheet,
  LuFileText,
  LuHourglass,
  LuMic,
  LuPause,
  LuPlay,
  LuShieldAlert,
  LuX,
} from 'react-icons/lu';
import { ApiError, getCsrfToken } from '../lib/api';
import { duration, fileSize, fileTypeLabel, timeOf } from '../lib/format';
import { createStore } from '../lib/store';
import type { Message, NormalAttachment, ProtectedAttachment } from '../lib/types';
import { kindLabel, useApp } from '../state/app';
import { Spinner } from './ui';

// ---------------------------------------------------------------------------
// viewer state (one viewer at a time, rendered by <MediaViewers/>)
// ---------------------------------------------------------------------------
const viewerStore = createStore<{ normal: Message | null; protectedMsg: Message | null }>({ normal: null, protectedMsg: null });
export const openMediaViewer = (m: Message) => viewerStore.set({ normal: m });
export const openProtectedViewer = (m: Message) => viewerStore.set({ protectedMsg: m });

export function MediaViewers() {
  const normal = viewerStore.useStore((s) => s.normal);
  const protectedMsg = viewerStore.useStore((s) => s.protectedMsg);
  return (
    <>
      {normal ? <MediaViewer m={normal} onClose={() => viewerStore.set({ normal: null })} /> : null}
      {protectedMsg ? <ProtectedViewer m={protectedMsg} onClose={() => viewerStore.set({ protectedMsg: null })} /> : null}
    </>
  );
}

const revealed = new Set<string>();

/** Fit media into the bubble while keeping its aspect ratio. */
function tileSize(w: number | null, h: number | null) {
  const maxW = Math.min(300, Math.round(window.innerWidth * 0.68));
  const maxH = 360;
  if (!w || !h) return { width: maxW, height: Math.round(maxW * 0.66) };
  let dw = Math.min(maxW, w);
  let dh = (dw * h) / w;
  if (dh > maxH) {
    dh = maxH;
    dw = (dh * w) / h;
  }
  return { width: Math.max(140, Math.round(dw)), height: Math.max(100, Math.round(dh)) };
}

// ---------------------------------------------------------------------------
// attachment inside a bubble
// ---------------------------------------------------------------------------
export function AttachmentView({ m, mine }: { m: Message; mine: boolean }) {
  const auto = useApp((s) => s.me?.privacy.autoDownloadMedia ?? true);
  const a = m.attachment!;
  if (a.viewPolicy !== 'normal') return <LanternTile m={m} a={a as ProtectedAttachment} mine={mine} />;
  const att = a as NormalAttachment;
  if (!att.available) {
    return (
      <div className="media-gone">
        <LuShieldAlert /> {kindLabel(att.kind, 'normal')} no longer available
      </div>
    );
  }
  switch (att.kind) {
    case 'image':
      return <ImageTile m={m} a={att} mine={mine} />;
    case 'video':
      return <VideoTile m={m} a={att} mine={mine} />;
    case 'audio':
    case 'voice':
      return <AudioPlayer src={`/api/attachments/${att.id}/content`} durationMs={att.durationMs} voice={att.kind === 'voice'} title={att.kind === 'audio' ? att.fileName : undefined} autoLoad={mine || revealed.has(att.id) || auto} />;
    default:
      return <FileChip a={att} />;
  }
}

function useReveal(id: string, mine: boolean) {
  const auto = useApp((s) => s.me?.privacy.autoDownloadMedia ?? true);
  const [on, setOn] = useState(mine || auto || revealed.has(id));
  return [on, () => (revealed.add(id), setOn(true))] as const;
}

function ImageTile({ m, a, mine }: { m: Message; a: NormalAttachment; mine: boolean }) {
  const [show, reveal] = useReveal(a.id, mine);
  const [loaded, setLoaded] = useState(false);
  const size = tileSize(a.width, a.height);
  const src = a.hasThumbnail ? `/api/attachments/${a.id}/thumbnail` : `/api/attachments/${a.id}/content`;
  return (
    <button type="button" className="media-tile" style={size} onClick={() => (show ? openMediaViewer(m) : reveal())} aria-label="Open photo">
      {show ? <img src={src} alt="" draggable={false} onLoad={() => setLoaded(true)} style={{ opacity: loaded ? 1 : 0, transition: 'opacity .2s' }} /> : null}
      {!show ? (
        <span className="media-tile__load">
          <span>
            <LuDownload /> Photo · {fileSize(a.size)}
          </span>
        </span>
      ) : !loaded ? (
        <span className="media-tile__load">
          <Spinner />
        </span>
      ) : null}
    </button>
  );
}

function VideoTile({ m, a, mine }: { m: Message; a: NormalAttachment; mine: boolean }) {
  const [show, reveal] = useReveal(a.id, mine);
  const size = tileSize(a.width, a.height);
  return (
    <button type="button" className="media-tile" style={size} onClick={() => (show ? openMediaViewer(m) : reveal())} aria-label="Play video">
      {show && a.hasThumbnail ? <img src={`/api/attachments/${a.id}/thumbnail`} alt="" draggable={false} /> : null}
      <span className="media-tile__play">
        <span>
          <LuPlay />
        </span>
      </span>
      <span className="media-tile__dur">
        {duration(a.durationMs)}
        {!show ? ` · ${fileSize(a.size)}` : ''}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// audio
// ---------------------------------------------------------------------------
let current: HTMLAudioElement | null = null;

export function AudioPlayer({ src, durationMs, voice, title, autoLoad = true }: { src: string; durationMs: number | null; voice?: boolean; title?: string; autoLoad?: boolean }) {
  const ref = useRef<HTMLAudioElement>(null);
  const [started, setStarted] = useState(autoLoad);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [dur, setDur] = useState((durationMs ?? 0) / 1000);
  const [rate, setRate] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const toggle = () => {
    const el = ref.current;
    if (!started) {
      setStarted(true);
      setLoading(true);
      window.setTimeout(() => void ref.current?.play().catch(() => setError(true)), 0);
      return;
    }
    if (!el) return;
    if (el.paused) {
      if (current && current !== el) current.pause();
      current = el;
      setLoading(true);
      void el.play().catch(() => setError(true));
    } else el.pause();
  };

  const pct = dur ? Math.min(100, (time / dur) * 100) : 0;
  return (
    <div className="audio">
      <button type="button" className="audio__play" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}>
        {loading && !playing ? <Spinner /> : playing ? <LuPause /> : <LuPlay />}
      </button>
      <div className="audio__track">
        {title ? <span className="audio__title">{title}</span> : null}
        <div
          className="audio__bar"
          role="slider"
          tabIndex={0}
          aria-label="Playback position"
          aria-valuemin={0}
          aria-valuemax={Math.round(dur)}
          aria-valuenow={Math.round(time)}
          onClick={(e) => {
            const el = ref.current;
            if (!el || !dur) return;
            const r = e.currentTarget.getBoundingClientRect();
            el.currentTime = ((e.clientX - r.left) / r.width) * dur;
          }}
          onKeyDown={(e) => {
            const el = ref.current;
            if (!el) return;
            if (e.key === 'ArrowRight') el.currentTime = Math.min(dur, el.currentTime + 5);
            if (e.key === 'ArrowLeft') el.currentTime = Math.max(0, el.currentTime - 5);
          }}
        >
          <div className="audio__fill" style={{ width: `${pct}%` }} />
          <div className="audio__knob" style={{ left: `${pct}%` }} />
        </div>
        <div className="audio__time">
          <span className="audio__label">
            {voice ? <LuMic /> : null}
            {error ? 'Unavailable' : duration((playing || time ? time : dur) * 1000)}
          </span>
          {voice ? (
            <button type="button" className="audio__rate" onClick={() => setRate((r) => (r === 1 ? 1.5 : r === 1.5 ? 2 : 1))} aria-label="Playback speed">
              {rate}×
            </button>
          ) : null}
        </div>
      </div>
      <audio
        ref={ref}
        src={started ? src : undefined}
        preload="metadata"
        onPlay={() => {
          setPlaying(true);
          setLoading(false);
          if (ref.current) ref.current.playbackRate = rate;
        }}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setTime(0);
        }}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => Number.isFinite(e.currentTarget.duration) && setDur(e.currentTarget.duration)}
        onWaiting={() => setLoading(true)}
        onPlaying={() => setLoading(false)}
        onError={() => {
          setError(true);
          setLoading(false);
        }}
        controlsList="nodownload"
      />
      {/* keep rate in sync */}
      <RateSync el={ref} rate={rate} />
    </div>
  );
}

function RateSync({ el, rate }: { el: React.RefObject<HTMLAudioElement | null>; rate: number }) {
  useEffect(() => {
    if (el.current) el.current.playbackRate = rate;
  }, [el, rate]);
  return null;
}

// ---------------------------------------------------------------------------
// documents
// ---------------------------------------------------------------------------
function fileIcon(mime: string) {
  if (mime.includes('spreadsheet') || mime === 'text/csv' || mime === 'application/vnd.ms-excel') return <LuFileSpreadsheet />;
  if (mime === 'application/zip') return <LuFileArchive />;
  if (mime.startsWith('audio/')) return <LuFileAudio />;
  if (mime === 'application/pdf' || mime.startsWith('text/') || mime.includes('word') || mime.includes('opendocument.text')) return <LuFileText />;
  return <LuFile />;
}

export function FileChip({ a }: { a: NormalAttachment }) {
  return (
    <a className="file-chip" href={`/api/attachments/${a.id}/content?download=1`} download={a.fileName} title={`Download ${a.fileName}`}>
      <span className="file-chip__icon">{fileIcon(a.mime)}</span>
      <span className="file-chip__body">
        <span className="file-chip__name">{a.fileName}</span>
        <span className="file-chip__meta">
          {fileSize(a.size)} · {fileTypeLabel(a.mime, a.fileName)}
        </span>
      </span>
      <span className="file-chip__dl" aria-hidden="true">
        <LuDownload />
      </span>
    </a>
  );
}

// ---------------------------------------------------------------------------
// view once / view twice
// ---------------------------------------------------------------------------
function arcPath(i: number, n: number) {
  const r = 20;
  const c = 22;
  const gap = n > 1 ? 14 : 0;
  const span = 360 / n;
  const a0 = ((-90 + i * span + gap / 2) * Math.PI) / 180;
  const a1 = ((-90 + (i + 1) * span - gap / 2) * Math.PI) / 180;
  if (n === 1) return `M ${c} ${c - r} A ${r} ${r} 0 1 1 ${c - 0.01} ${c - r}`;
  const large = span - gap > 180 ? 1 : 0;
  return `M ${c + r * Math.cos(a0)} ${c + r * Math.sin(a0)} A ${r} ${r} 0 ${large} 1 ${c + r * Math.cos(a1)} ${c + r * Math.sin(a1)}`;
}

function LanternTile({ m, a, mine }: { m: Message; a: ProtectedAttachment; mine: boolean }) {
  const limit = a.viewLimit ?? (a.viewPolicy === 'twice' ? 2 : 1);
  const spent = a.state === 'opened' || a.state === 'expired';
  const what = kindLabel(a.kind, 'normal');
  const policy = a.viewPolicy === 'once' ? 'View once' : 'View twice';
  let sub: string;
  if (mine) {
    sub = a.state === 'unopened' ? 'Not opened yet' : a.state === 'partially_viewed' ? `Opened · ${a.viewsRemaining} view left` : a.state === 'opened' ? 'Opened' : 'Expired';
  } else {
    sub =
      a.state === 'opened'
        ? 'Opened'
        : a.state === 'expired'
          ? 'Expired'
          : `${a.viewsRemaining} ${a.viewsRemaining === 1 ? 'view' : 'views'} left · Tap to open`;
  }
  return (
    <button
      type="button"
      className={`lantern${spent ? ' lantern--spent' : ''}`}
      disabled={mine || !a.canView}
      onClick={() => openProtectedViewer(m)}
      aria-label={`${policy} ${what.toLowerCase()}. ${sub}`}
      data-testid="protected-media"
    >
      <span className="lantern__glyph">
        <svg className="lantern__ring" viewBox="0 0 44 44" aria-hidden="true">
          {Array.from({ length: limit }, (_, i) => (
            <path key={i} d={arcPath(i, limit)} className={`lantern__arc ${i < a.viewsUsed || spent ? 'lantern__arc--used' : 'lantern__arc--live'}`} />
          ))}
        </svg>
        <span className="lantern__core">{a.state === 'expired' ? <LuHourglass /> : spent ? <LuEyeOff /> : <strong>{mine ? limit : a.viewsRemaining}</strong>}</span>
      </span>
      <span>
        <span className="lantern__title">
          {policy} {what.toLowerCase()}
        </span>
        <span className="lantern__sub" style={{ display: 'block' }}>
          {sub}
        </span>
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// full-screen viewer for normal media
// ---------------------------------------------------------------------------
function useEscape(onClose: () => void) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, [onClose]);
}

function MediaViewer({ m, onClose }: { m: Message; onClose: () => void }) {
  const a = m.attachment as NormalAttachment;
  const conv = useApp((s) => s.conversations[m.conversationId]);
  const meId = useApp((s) => s.me?.id);
  const [loaded, setLoaded] = useState(false);
  useEscape(onClose);
  const who = m.senderId === meId ? 'You' : (conv?.peer?.displayName ?? '');
  return (
    <div className="viewer" role="dialog" aria-modal="true" aria-label={kindLabel(a.kind, 'normal')}>
      <div className="viewer__bar">
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close" autoFocus>
          <LuX />
        </button>
        <div className="viewer__title">
          <strong>{who}</strong>
          <span>
            {new Date(m.createdAt).toLocaleDateString()} {timeOf(m.createdAt)}
          </span>
        </div>
        <a className="icon-btn" href={`/api/attachments/${a.id}/content?download=1`} download={a.fileName} aria-label="Download">
          <LuDownload />
        </a>
      </div>
      <div className="viewer__stage" onClick={(e) => e.target === e.currentTarget && onClose()}>
        {!loaded ? (
          <span style={{ position: 'absolute' }}>
            <Spinner />
          </span>
        ) : null}
        {a.kind === 'image' ? (
          <img src={`/api/attachments/${a.id}/content`} alt="" onLoad={() => setLoaded(true)} />
        ) : (
          <video src={`/api/attachments/${a.id}/content`} controls autoPlay playsInline onLoadedData={() => setLoaded(true)} />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// protected viewer
// ---------------------------------------------------------------------------
class FatalViewError extends Error {}

/**
 * Downloads the protected bytes for an opened viewing session into memory. Interrupted transfers
 * resume with Range requests on the same short-lived token, so a flaky network doesn't burn a view.
 */
async function fetchProtected(id: string, token: string, size: number, mime: string, onProgress: (f: number) => void): Promise<Blob> {
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const headers: Record<string, string> = { 'x-view-token': token, 'x-csrf-token': getCsrfToken() };
      if (received) headers.Range = `bytes=${received}-`;
      const res = await fetch(`/api/attachments/${id}/protected`, { headers, cache: 'no-store', credentials: 'same-origin' });
      if (res.status === 410 || res.status === 403 || res.status === 404) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new FatalViewError(body?.error?.message ?? 'This media is no longer available.');
      }
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      if (received && res.status !== 206) {
        chunks.length = 0;
        received = 0;
      }
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        onProgress(size ? received / size : 0);
      }
      if (received >= size) return new Blob(chunks as BlobPart[], { type: mime });
    } catch (err) {
      if (err instanceof FatalViewError) throw err;
      await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
    }
  }
  throw new FatalViewError("The media couldn't be loaded. If it never started loading, you'll get the view back in a few minutes.");
}

function ProtectedViewer({ m, onClose }: { m: Message; onClose: () => void }) {
  const a = m.attachment as ProtectedAttachment;
  const me = useApp((s) => s.me)!;
  const conv = useApp((s) => s.conversations[m.conversationId]);
  const [phase, setPhase] = useState<'opening' | 'loading' | 'ready' | 'error'>('opening');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const [url, setUrl] = useState<string | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [shield, setShield] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const urlRef = useRef<string | null>(null);
  const close = useCallback(() => {
    // Wipe what was shown and drop the only in-memory copy.
    const c = canvasRef.current;
    if (c) {
      c.getContext('2d')?.clearRect(0, 0, c.width, c.height);
      c.width = c.height = 0;
    }
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
    onClose();
  }, [onClose]);
  useEscape(close);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Counting the view happens on the server, atomically, before any bytes are sent.
        const res = await fetch(`/api/attachments/${a.id}/views`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-csrf-token': getCsrfToken() },
          body: '{}',
          credentials: 'same-origin',
          cache: 'no-store',
        });
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new ApiError(res.status, body?.error?.code ?? 'error', body?.error?.message ?? 'This media is not available.');
        if (cancelled) return;
        setRemaining(body.viewsRemaining);
        setPhase('loading');
        const blob = await fetchProtected(a.id, body.token, body.size, body.mime, setProgress);
        if (cancelled) return;
        if (a.kind === 'image') {
          const bmp = await createImageBitmap(blob);
          const c = canvasRef.current;
          if (c && !cancelled) {
            c.width = bmp.width;
            c.height = bmp.height;
            c.getContext('2d')!.drawImage(bmp, 0, 0);
          }
          bmp.close();
        } else {
          const u = URL.createObjectURL(blob);
          urlRef.current = u;
          setUrl(u);
        }
        setPhase('ready');
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'This media is not available.');
        setPhase('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [a.id, a.kind]);

  // Deterrence: hide the content whenever the window loses focus or the page is hidden
  // (app switchers, screen-recording pickers, some screenshot tools), and on Print Screen.
  useEffect(() => {
    const hide = () => setShield(true);
    const maybeShow = () => setShield(document.visibilityState !== 'visible' || !document.hasFocus());
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'PrintScreen' || (e.metaKey && e.shiftKey && ['3', '4', '5', 's', 'S'].includes(e.key))) {
        setShield(true);
        void navigator.clipboard?.writeText('').catch(() => {});
        window.setTimeout(maybeShow, 1500);
      }
    };
    window.addEventListener('blur', hide);
    window.addEventListener('focus', maybeShow);
    document.addEventListener('visibilitychange', maybeShow);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('keyup', onKey, true);
    return () => {
      window.removeEventListener('blur', hide);
      window.removeEventListener('focus', maybeShow);
      document.removeEventListener('visibilitychange', maybeShow);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('keyup', onKey, true);
    };
  }, []);

  const mark = `@${me.username ?? me.id.slice(0, 8)} · ${new Date().toLocaleString()}`;
  const policy = a.viewPolicy === 'once' ? 'View once' : 'View twice';
  return (
    <div
      className="viewer viewer--protected"
      role="dialog"
      aria-modal="true"
      aria-label={`${policy} ${kindLabel(a.kind, 'normal').toLowerCase()}`}
      onContextMenu={(e) => e.preventDefault()}
      onDragStart={(e) => e.preventDefault()}
      onCopy={(e) => e.preventDefault()}
    >
      <div className="viewer__bar">
        <button type="button" className="icon-btn" onClick={close} aria-label="Close" autoFocus>
          <LuX />
        </button>
        <div className="viewer__title">
          <strong>{conv?.peer?.displayName ?? ''}</strong>
          <span>
            {policy}
            {remaining !== null ? ` · ${remaining === 0 ? 'last view' : `${remaining} ${remaining === 1 ? 'view' : 'views'} left after this`}` : ''}
          </span>
        </div>
      </div>
      <div className="viewer__stage">
        {phase === 'opening' || phase === 'loading' ? (
          <div className="viewer__loading">
            <Spinner />
            {phase === 'loading' && progress > 0 ? <span>{Math.round(progress * 100)}%</span> : null}
          </div>
        ) : null}
        {phase === 'error' ? <div className="viewer__error">{error}</div> : null}
        {a.kind === 'image' ? <canvas ref={canvasRef} style={{ display: phase === 'ready' ? 'block' : 'none' }} /> : null}
        {a.kind === 'video' && url ? (
          <video src={url} controls autoPlay playsInline controlsList="nodownload noremoteplayback noplaybackrate" disablePictureInPicture disableRemotePlayback />
        ) : null}
        {(a.kind === 'audio' || a.kind === 'voice') && url ? <audio src={url} controls autoPlay controlsList="nodownload noplaybackrate" /> : null}
        {phase === 'ready' ? (
          <div className="viewer__watermark" aria-hidden="true">
            {Array.from({ length: 24 }, (_, i) => (
              <span key={i}>{mark}</span>
            ))}
          </div>
        ) : null}
        {shield && phase === 'ready' ? (
          <div className="viewer__shield">
            <div>
              <LuEyeOff size={28} />
              <p>Hidden while Cove isn't in focus.</p>
            </div>
          </div>
        ) : null}
      </div>
      <p className="viewer__note">
        {a.viewPolicy === 'once' ? "This can't be opened again after you close it." : 'This can be opened twice in total.'} Screenshots can't be
        blocked in a browser — please respect the sender.
      </p>
    </div>
  );
}

/** Circular upload progress for pending media. */
export function RingProgress({ value }: { value: number }) {
  const r = 20;
  const c = 2 * Math.PI * r;
  return (
    <svg className="ring-progress" viewBox="0 0 48 48" aria-label={`${Math.round(value * 100)}%`} role="img">
      <circle cx="24" cy="24" r={r} fill="none" stroke="rgba(255,255,255,.3)" strokeWidth="4" />
      <circle cx="24" cy="24" r={r} fill="none" stroke="#fff" strokeWidth="4" strokeDasharray={c} strokeDashoffset={c * (1 - Math.max(0.02, value))} strokeLinecap="round" transform="rotate(-90 24 24)" />
    </svg>
  );
}
