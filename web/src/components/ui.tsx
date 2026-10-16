import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { LuX } from 'react-icons/lu';
import { initials } from '../lib/format';
import { dismissToast, useApp } from '../state/app';

export function Wordmark({ size = 28, onDark = false }: { size?: number; onDark?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <rect width="64" height="64" rx="15" fill={onDark ? 'rgba(255,255,255,0.12)' : 'var(--tide)'} />
      <path d="M43.5 18.2A18 18 0 1 0 43.5 45.8" fill="none" stroke="#F7F8FA" strokeWidth="6" strokeLinecap="round" />
      <circle cx="33" cy="32" r="5" fill="#E3A33B" />
    </svg>
  );
}

export function Avatar({ name, url, size = 44, online }: { name: string; url?: string | null; size?: number; online?: boolean | null }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  const src = url ? `${url}${url.includes('?') ? '&' : '?'}size=${size > 96 ? 512 : 128}` : null;
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }} aria-hidden="true">
      {src && !failed ? <img src={src} alt="" loading="lazy" draggable={false} onError={() => setFailed(true)} /> : initials(name)}
      {online ? <span className="avatar__online" /> : null}
    </span>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return <span className="spinner" role="status" aria-label={label} />;
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return <button type="button" role="switch" className="toggle" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)} />;
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: ReactNode; disabled?: boolean }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} disabled={o.disabled} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Modal dialog: focus moves inside, Tab is trapped, Escape and the scrim close it. */
export function Dialog({ title, onClose, children, wide, labelledBy }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; labelledBy?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current!;
    const focusable = () => [...el.querySelectorAll<HTMLElement>('button,input,textarea,select,a[href],[tabindex]:not([tabindex="-1"])')].filter((x) => !x.hasAttribute('disabled'));
    (el.querySelector<HTMLElement>('[data-autofocus]') ?? focusable()[1] ?? focusable()[0])?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
      if (e.key === 'Tab') {
        const f = focusable();
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) {
          e.preventDefault();
          f[f.length - 1]!.focus();
        } else if (!e.shiftKey && document.activeElement === f[f.length - 1]) {
          e.preventDefault();
          f[0]!.focus();
        }
      }
    };
    el.addEventListener('keydown', onKey);
    return () => {
      el.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [onClose]);
  return createPortal(
    <div className="dialog-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className={`dialog${wide ? ' dialog--wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={labelledBy ?? 'dialog-title'}>
        <div className="dialog__head">
          <h2 id={labelledBy ?? 'dialog-title'}>{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <LuX />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function Confirm({ title, text, confirmLabel, danger, onConfirm, onClose, busy }: { title: string; text: ReactNode; confirmLabel: string; danger?: boolean; onConfirm: () => void; onClose: () => void; busy?: boolean }) {
  return (
    <Dialog title={title} onClose={onClose}>
      <p className="dialog__text">{text}</p>
      <div className="dialog__actions">
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className={`btn ${danger ? 'btn--danger' : 'btn--primary'}`} onClick={onConfirm} disabled={busy} data-autofocus>
          {busy ? <Spinner /> : confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}

/**
 * A floating panel anchored to an element or a point. Closes on outside click, Escape, scroll
 * of the anchor container, or resize. Positions itself to stay on screen.
 */
export function Popover({ anchor, onClose, children, className = '', placement = 'below' }: { anchor: DOMRect | { x: number; y: number }; onClose: () => void; children: ReactNode; className?: string; placement?: 'below' | 'above' }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current!;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const r = 'width' in anchor ? anchor : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
    let left = Math.min(Math.max(8, r.left), vw - w - 8);
    if ('width' in anchor && r.right - w > 8 && r.left + w > vw - 8) left = r.right - w;
    let top = placement === 'above' ? r.top - h - 6 : r.bottom + 6;
    if (top + h > vh - 8) top = Math.max(8, r.top - h - 6);
    if (top < 8) top = Math.min(vh - h - 8, r.bottom + 6);
    setPos({ left, top });
  }, [anchor, placement]);
  useEffect(() => {
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    const t = window.setTimeout(() => {
      document.addEventListener('mousedown', onDown);
      document.addEventListener('touchstart', onDown);
    });
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onClose);
    ref.current?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
    return () => {
      window.clearTimeout(t);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);
  return createPortal(
    <div ref={ref} className={`popover ${className}`} style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }} role="menu">
      {children}
    </div>,
    document.body,
  );
}

export function MenuItem({ icon, children, onClick, danger }: { icon?: ReactNode; children: ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button type="button" role="menuitem" className={`menu__item${danger ? ' menu__item--danger' : ''}`} onClick={onClick}>
      {icon}
      <span>{children}</span>
    </button>
  );
}

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast${t.kind === 'error' ? ' toast--error' : ''}`} role={t.kind === 'error' ? 'alert' : 'status'}>
          <span>{t.text}</span>
          {t.action ? (
            <button
              type="button"
              onClick={() => {
                t.action!.run();
                dismissToast(t.id);
              }}
            >
              {t.action.label}
            </button>
          ) : null}
          <button type="button" onClick={() => dismissToast(t.id)} aria-label="Dismiss">
            <LuX />
          </button>
        </div>
      ))}
    </div>
  );
}

/** Long-press (touch) and right-click (mouse) handler for context menus. */
export function useLongPress(onTrigger: (point: { x: number; y: number }) => void, ms = 450) {
  const timer = useRef<number | undefined>(undefined);
  const start = useRef<{ x: number; y: number } | null>(null);
  return {
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      onTrigger({ x: e.clientX, y: e.clientY });
    },
    onTouchStart: (e: React.TouchEvent) => {
      const t = e.touches[0]!;
      start.current = { x: t.clientX, y: t.clientY };
      timer.current = window.setTimeout(() => {
        navigator.vibrate?.(10);
        onTrigger(start.current!);
      }, ms);
    },
    onTouchMove: (e: React.TouchEvent) => {
      const t = e.touches[0]!;
      if (start.current && Math.hypot(t.clientX - start.current.x, t.clientY - start.current.y) > 10) window.clearTimeout(timer.current);
    },
    onTouchEnd: () => window.clearTimeout(timer.current),
  };
}
