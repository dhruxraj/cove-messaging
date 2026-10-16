const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

export const timeOf = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/** Conversation list stamp: time today, "Yesterday", weekday this week, else a short date. */
export function listStamp(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  if (sameDay(d, now)) return timeOf(iso);
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return 'Yesterday';
  if (now.getTime() - d.getTime() < 6 * 86400_000) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

export function dayLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  if (sameDay(d, now)) return 'Today';
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

export const dayKey = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

export function lastSeenText(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const mins = Math.floor((now.getTime() - d.getTime()) / 60_000);
  if (mins < 1) return 'last seen just now';
  if (mins < 60) return `last seen ${mins} min ago`;
  if (sameDay(d, now)) return `last seen today at ${timeOf(iso)}`;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return `last seen yesterday at ${timeOf(iso)}`;
  return `last seen ${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function duration(ms: number | null | undefined): string {
  if (!ms || !Number.isFinite(ms)) return '0:00';
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export const ttlLabel = (s: number | null) => (s === 86400 ? '24 hours' : s === 604800 ? '7 days' : s === 7776000 ? '90 days' : 'Off');

export function fileTypeLabel(mime: string, name: string): string {
  if (mime === 'application/pdf') return 'PDF';
  if (mime.includes('wordprocessingml') || mime === 'application/msword' || mime.includes('opendocument.text')) return 'Document';
  if (mime.includes('spreadsheetml') || mime === 'application/vnd.ms-excel' || mime.includes('spreadsheet') || mime === 'text/csv') return 'Spreadsheet';
  if (mime.includes('presentation') || mime === 'application/vnd.ms-powerpoint') return 'Presentation';
  if (mime === 'application/zip') return 'ZIP archive';
  if (mime.startsWith('text/') || mime === 'application/json') return 'Text';
  const ext = name.split('.').pop();
  return ext && ext !== name ? ext.toUpperCase() : 'File';
}

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => [...w][0]!.toUpperCase())
    .join('') || '?';
