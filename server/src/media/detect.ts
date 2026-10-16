import fs from 'node:fs/promises';
import { extensionOf } from '../lib/text';

/**
 * Whitelist-based content sniffing. The browser-supplied MIME type and the file extension are
 * never trusted on their own: the first bytes must match a known, allowed format. Images are then
 * fully decoded by sharp and audio/video fully parsed by ffprobe before anything is stored.
 */
export type Family = 'image' | 'av' | 'document';

export interface Detected {
  family: Family;
  mime: string; // provisional for 'av' (refined after probing)
  label: string; // short human label
  container?: 'mp4' | 'matroska' | 'ogg' | 'mp3' | 'wav' | 'flac' | 'aac';
}

export class UnsupportedFileError extends Error {}

const startsWith = (buf: Buffer, sig: number[], offset = 0) => sig.every((b, i) => buf[offset + i] === b);
const ascii = (buf: Buffer, start: number, end: number) => buf.subarray(start, end).toString('latin1');

const OOXML: Record<string, { mime: string; label: string; marker: string }> = {
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', label: 'Word document', marker: 'word/' },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', label: 'Excel spreadsheet', marker: 'xl/' },
  pptx: { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', label: 'PowerPoint presentation', marker: 'ppt/' },
};
const ODF: Record<string, string> = {
  'application/vnd.oasis.opendocument.text': 'OpenDocument text',
  'application/vnd.oasis.opendocument.spreadsheet': 'OpenDocument spreadsheet',
  'application/vnd.oasis.opendocument.presentation': 'OpenDocument presentation',
};
const OLE_BY_EXT: Record<string, { mime: string; label: string }> = {
  doc: { mime: 'application/msword', label: 'Word document' },
  xls: { mime: 'application/vnd.ms-excel', label: 'Excel spreadsheet' },
  ppt: { mime: 'application/vnd.ms-powerpoint', label: 'PowerPoint presentation' },
};
const TEXT_BY_EXT: Record<string, { mime: string; label: string }> = {
  txt: { mime: 'text/plain', label: 'Text file' },
  log: { mime: 'text/plain', label: 'Text file' },
  md: { mime: 'text/markdown', label: 'Markdown file' },
  csv: { mime: 'text/csv', label: 'CSV file' },
  tsv: { mime: 'text/tab-separated-values', label: 'TSV file' },
  json: { mime: 'application/json', label: 'JSON file' },
};

/** List entry names from a ZIP central directory (no decompression, so zip bombs are harmless). */
async function zipEntryNames(file: string, size: number): Promise<string[] | null> {
  const fh = await fs.open(file, 'r');
  try {
    const tailLen = Math.min(size, 65_557);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) return null;
    const entries = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdOffset + cdSize > size || cdSize > 8 * 1024 * 1024) return null;
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);
    const names: string[] = [];
    let p = 0;
    for (let i = 0; i < entries && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) return null;
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      names.push(cd.subarray(p + 46, p + 46 + nameLen).toString('utf8'));
      p += 46 + nameLen + extraLen + commentLen;
    }
    return names;
  } finally {
    await fh.close();
  }
}

export async function detectFile(file: string, size: number, originalName: string): Promise<Detected> {
  const fh = await fs.open(file, 'r');
  const head = Buffer.alloc(Math.min(size, 4100));
  try {
    await fh.read(head, 0, head.length, 0);
  } finally {
    await fh.close();
  }
  const ext = extensionOf(originalName);

  // ---- images ----
  if (startsWith(head, [0xff, 0xd8, 0xff])) return { family: 'image', mime: 'image/jpeg', label: 'JPEG image' };
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { family: 'image', mime: 'image/png', label: 'PNG image' };
  if (ascii(head, 0, 6) === 'GIF87a' || ascii(head, 0, 6) === 'GIF89a') return { family: 'image', mime: 'image/gif', label: 'GIF image' };
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 12) === 'WEBP') return { family: 'image', mime: 'image/webp', label: 'WebP image' };
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 12) === 'WAVE') return { family: 'av', mime: 'audio/wav', label: 'WAV audio', container: 'wav' };

  // ---- ISO base media (MP4/MOV/M4A/AVIF/HEIC) ----
  if (ascii(head, 4, 8) === 'ftyp') {
    const brand = ascii(head, 8, 12);
    if (brand === 'avif' || brand === 'avis') return { family: 'image', mime: 'image/avif', label: 'AVIF image' };
    if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand)) {
      throw new UnsupportedFileError('HEIC photos are not supported yet. Choose "Most Compatible" in your camera settings or share as JPEG.');
    }
    return { family: 'av', mime: brand.startsWith('M4A') || brand.startsWith('M4B') ? 'audio/mp4' : 'video/mp4', label: 'MP4 media', container: 'mp4' };
  }
  if (startsWith(head, [0x1a, 0x45, 0xdf, 0xa3])) return { family: 'av', mime: 'video/webm', label: 'WebM media', container: 'matroska' };
  if (ascii(head, 0, 4) === 'OggS') return { family: 'av', mime: 'audio/ogg', label: 'Ogg audio', container: 'ogg' };
  if (ascii(head, 0, 4) === 'fLaC') return { family: 'av', mime: 'audio/flac', label: 'FLAC audio', container: 'flac' };
  if (ascii(head, 0, 3) === 'ID3' || (head[0] === 0xff && ((head[1] ?? 0) & 0xe6) === 0xe2)) {
    return { family: 'av', mime: 'audio/mpeg', label: 'MP3 audio', container: 'mp3' };
  }
  if (head[0] === 0xff && ((head[1] ?? 0) & 0xf6) === 0xf0) return { family: 'av', mime: 'audio/aac', label: 'AAC audio', container: 'aac' };

  // ---- documents ----
  if (ascii(head, 0, 5) === '%PDF-') return { family: 'document', mime: 'application/pdf', label: 'PDF document' };
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04]) || startsWith(head, [0x50, 0x4b, 0x05, 0x06])) {
    // ODF stores an uncompressed "mimetype" entry first.
    if (ascii(head, 30, 38) === 'mimetype') {
      const extraLen = head.readUInt16LE(28);
      const start = 38 + extraLen;
      const mt = ascii(head, start, start + 60).replace(/[^a-z0-9./+-].*$/, '');
      if (ODF[mt]) return { family: 'document', mime: mt, label: ODF[mt]! };
    }
    const names = await zipEntryNames(file, size);
    if (!names) throw new UnsupportedFileError('This ZIP file appears to be damaged.');
    if (names.includes('[Content_Types].xml')) {
      for (const k of Object.keys(OOXML)) {
        const t = OOXML[k]!;
        if (names.some((n) => n.startsWith(t.marker))) return { family: 'document', mime: t.mime, label: t.label };
      }
    }
    return { family: 'document', mime: 'application/zip', label: 'ZIP archive' };
  }
  if (startsWith(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    // Legacy Office files share this container with installers (.msi), so the extension decides.
    const t = OLE_BY_EXT[ext];
    if (t) return { family: 'document', ...t };
    throw new UnsupportedFileError('This file type is not supported.');
  }
  if (ascii(head, 0, 5) === '{\\rtf') return { family: 'document', mime: 'application/rtf', label: 'Rich text document' };

  // ---- plain text (whitelisted extensions, must be valid UTF-8 without NUL bytes) ----
  const t = TEXT_BY_EXT[ext];
  if (t) {
    const data = await fs.readFile(file);
    if (data.includes(0)) throw new UnsupportedFileError('This file type is not supported.');
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(data);
    } catch {
      throw new UnsupportedFileError('Text files must be UTF-8 encoded.');
    }
    return { family: 'document', ...t };
  }

  throw new UnsupportedFileError('This file type is not supported. You can send images, videos, audio, PDF, Office documents, text files and ZIP archives.');
}
