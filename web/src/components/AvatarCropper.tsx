import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { LuZoomIn, LuZoomOut } from 'react-icons/lu';
import { Dialog } from './ui';

export interface CropResult {
  /** Square region in the image's (orientation-corrected) pixel space. */
  crop: { x: number; y: number; size: number };
  /** Local circular preview (object URL) to show before the upload finishes. */
  previewUrl: string;
}

const ACCEPT = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

export function validateAvatarFile(file: File, maxMb: number): string | null {
  if (!ACCEPT.includes(file.type)) return 'Choose a JPEG, PNG, WebP or GIF image.';
  if (file.size > maxMb * 1024 * 1024) return `Photos can be at most ${maxMb} MB.`;
  return null;
}

/**
 * Drag to reposition, slider / wheel / pinch to zoom. The visible circle is what gets saved.
 * The server re-validates the file and performs the actual crop and resize.
 */
export function AvatarCropper({ file, onCancel, onDone }: { file: File; onCancel: () => void; onDone: (r: CropResult) => void }) {
  const [url] = useState(() => URL.createObjectURL(file));
  const [img, setImg] = useState<{ w: number; h: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState(300);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  type Drag = { x: number; y: number; ox: number; oy: number; pointers: Map<number, { x: number; y: number }>; pinch?: number; zoom0?: number };
  const drag = useRef<Drag | null>(null);

  useEffect(() => () => URL.revokeObjectURL(url), [url]);

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (el) setStage(el.clientWidth);
  }, [img]);

  const base = img ? stage / Math.min(img.w, img.h) : 1;
  const scale = base * zoom;

  const clamp = (o: { x: number; y: number }, s = scale) => {
    if (!img) return o;
    return { x: Math.min(0, Math.max(stage - img.w * s, o.x)), y: Math.min(0, Math.max(stage - img.h * s, o.y)) };
  };

  useEffect(() => {
    if (!img) return;
    // Start centred.
    setOffset(clamp({ x: (stage - img.w * base) / 2, y: (stage - img.h * base) / 2 }, base));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [img, stage]);

  function zoomTo(next: number, cx = stage / 2, cy = stage / 2) {
    const z = Math.min(4, Math.max(1, next));
    const s = base * z;
    // Keep the point under (cx, cy) fixed while zooming.
    const ix = (cx - offset.x) / scale;
    const iy = (cy - offset.y) / scale;
    setZoom(z);
    setOffset(clamp({ x: cx - ix * s, y: cy - iy * s }, s));
  }

  async function finish() {
    if (!img) return;
    const size = Math.round(stage / scale);
    const x = Math.round(-offset.x / scale);
    const y = Math.round(-offset.y / scale);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 256;
    const ctx = canvas.getContext('2d')!;
    const el = new Image();
    el.src = url;
    await el.decode().catch(() => {});
    ctx.drawImage(el, x, y, size, size, 0, 0, 256, 256);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/webp', 0.85));
    onDone({ crop: { x, y, size }, previewUrl: blob ? URL.createObjectURL(blob) : url });
  }

  return (
    <Dialog title="Position your photo" onClose={onCancel}>
      <div className="cropper">
        <div
          ref={stageRef}
          className="cropper__stage"
          onPointerDown={(e) => {
            (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
            const d: Drag = drag.current ?? { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y, pointers: new Map() };
            d.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (d.pointers.size === 2) {
              const [a, b] = [...d.pointers.values()];
              d.pinch = Math.hypot(a!.x - b!.x, a!.y - b!.y);
              d.zoom0 = zoom;
            } else {
              Object.assign(d, { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y });
            }
            drag.current = d;
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d || !d.pointers.has(e.pointerId)) return;
            d.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (d.pointers.size === 2 && d.pinch && d.zoom0) {
              const [a, b] = [...d.pointers.values()];
              zoomTo((d.zoom0 * Math.hypot(a!.x - b!.x, a!.y - b!.y)) / d.pinch);
              return;
            }
            setOffset(clamp({ x: d.ox + e.clientX - d.x, y: d.oy + e.clientY - d.y }));
          }}
          onPointerUp={(e) => {
            const d = drag.current;
            d?.pointers.delete(e.pointerId);
            if (!d || d.pointers.size === 0) drag.current = null;
            else {
              const [p] = [...d.pointers.values()];
              Object.assign(d, { x: p!.x, y: p!.y, ox: offset.x, oy: offset.y, pinch: undefined });
            }
          }}
          onPointerCancel={() => (drag.current = null)}
          onWheel={(e) => {
            const r = stageRef.current!.getBoundingClientRect();
            zoomTo(zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08), e.clientX - r.left, e.clientY - r.top);
          }}
        >
          {failed ? (
            <div className="cropper__error">This image can't be displayed. Try another one.</div>
          ) : (
            <img
              src={url}
              alt=""
              draggable={false}
              onLoad={(e) => setImg({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
              onError={() => setFailed(true)}
              style={img ? { width: img.w, height: img.h, transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` } : { opacity: 0 }}
            />
          )}
          <div className="cropper__mask" />
          <div className="cropper__ring" />
        </div>
        <label className="cropper__zoom">
          <LuZoomOut aria-hidden="true" />
          <input type="range" min={1} max={4} step={0.01} value={zoom} onChange={(e) => zoomTo(Number(e.target.value))} aria-label="Zoom" />
          <LuZoomIn aria-hidden="true" />
        </label>
      </div>
      <div className="dialog__actions">
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn btn--primary" onClick={() => void finish()} disabled={!img}>
          Use photo
        </button>
      </div>
    </Dialog>
  );
}
