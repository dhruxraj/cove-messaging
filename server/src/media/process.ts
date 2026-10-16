import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import sharp, { type Metadata, type OutputInfo, type Region } from 'sharp';
import type { Config } from '../config';
import { detectFile, UnsupportedFileError, type Detected } from './detect';
import { Ffmpeg, type ProbeResult } from './ffmpeg';

export type AttachmentKind = 'image' | 'video' | 'audio' | 'voice' | 'file';

export interface ProcessedMedia {
  kind: AttachmentKind;
  mime: string;
  label: string;
  path: string;
  size: number;
  sha256: Buffer;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  thumbnail: Buffer | null;
}

export class MediaTooLargeError extends Error {}

sharp.cache(false);
sharp.concurrency(2);

const MB = 1024 * 1024;
const PIXEL_LIMIT = 80_000_000;

export async function hashFile(file: string): Promise<{ sha256: Buffer; size: number }> {
  const h = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(file)) {
    h.update(chunk as Buffer);
    size += (chunk as Buffer).length;
  }
  return { sha256: h.digest(), size };
}

const VIDEO_CODECS = new Set(['h264', 'hevc', 'vp8', 'vp9', 'av1']);
const AUDIO_CODECS = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', 'alac', 'pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_f32le', 'pcm_u8']);

function durationOf(p: ProbeResult): number | null {
  const candidates = [p.format.duration, ...p.streams.map((s) => s.duration)];
  for (const d of candidates) {
    const n = d ? Number.parseFloat(d) : Number.NaN;
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function rotationOf(s: { tags?: { rotate?: string }; side_data_list?: { rotation?: number }[] }): number {
  const r = s.side_data_list?.find((d) => typeof d.rotation === 'number')?.rotation ?? Number(s.tags?.rotate ?? 0);
  return Math.abs(Math.round(r)) % 180;
}

export class MediaProcessor {
  private ff: Ffmpeg;
  constructor(private cfg: Config, private tempPath: () => string) {
    this.ff = new Ffmpeg(cfg.FFMPEG_PATH, cfg.FFPROBE_PATH);
  }

  limitFor(kind: AttachmentKind): number {
    const c = this.cfg;
    return (kind === 'image' ? c.MAX_IMAGE_MB : kind === 'video' ? c.MAX_VIDEO_MB : kind === 'audio' || kind === 'voice' ? c.MAX_AUDIO_MB : c.MAX_FILE_MB) * MB;
  }

  /** Largest upload any kind may have — enforced while the bytes stream in. */
  get maxUploadBytes() {
    const c = this.cfg;
    return Math.max(c.MAX_IMAGE_MB, c.MAX_VIDEO_MB, c.MAX_AUDIO_MB, c.MAX_FILE_MB) * MB;
  }

  /**
   * Validate and normalise an uploaded file. Returns a new temp file (the caller owns cleanup of
   * both input and output). Re-encoding/remuxing strips EXIF, GPS and container metadata.
   */
  async process(input: { path: string; size: number; sha256: Buffer; name: string; voice: boolean; protectedMedia: boolean }): Promise<ProcessedMedia> {
    const detected = await detectFile(input.path, input.size, input.name);
    let result: ProcessedMedia;
    if (detected.family === 'image') {
      if (input.voice) throw new UnsupportedFileError('Voice messages must be audio recordings.');
      this.checkSize('image', input.size);
      result = await this.image(input.path, detected, input.protectedMedia);
    } else if (detected.family === 'av') result = await this.av(input.path, input.size, detected, input.voice, input.protectedMedia);
    else {
      if (input.voice) throw new UnsupportedFileError('Voice messages must be audio recordings.');
      this.checkSize('file', input.size);
      result = { kind: 'file', mime: detected.mime, label: detected.label, path: input.path, size: input.size, sha256: input.sha256, width: null, height: null, durationMs: null, thumbnail: null };
    }
    if (input.voice && result.kind === 'audio') result.kind = 'voice';
    if (input.protectedMedia && result.size > this.cfg.MAX_PROTECTED_MB * MB) {
      if (result.path !== input.path) await fs.rm(result.path, { force: true });
      throw new MediaTooLargeError(`View-once media is limited to ${this.cfg.MAX_PROTECTED_MB} MB.`);
    }
    return result;
  }

  checkSize(kind: AttachmentKind, size: number) {
    if (size > this.limitFor(kind)) {
      const what = kind === 'file' ? 'documents' : kind === 'voice' ? 'voice messages' : kind + 's';
      throw new MediaTooLargeError(`This file is too large. The limit for ${what} is ${Math.round(this.limitFor(kind) / MB)} MB.`);
    }
  }

  private async image(file: string, d: Detected, protectedMedia: boolean): Promise<ProcessedMedia> {
    let meta: Metadata;
    try {
      meta = await sharp(file, { limitInputPixels: PIXEL_LIMIT, failOn: 'error' }).metadata();
    } catch {
      throw new UnsupportedFileError('This image could not be read. It may be damaged.');
    }
    if (!meta.width || !meta.height) throw new UnsupportedFileError('This image could not be read.');
    const animated = (meta.pages ?? 1) > 1 && (d.mime === 'image/gif' || d.mime === 'image/webp');
    let p = sharp(file, { limitInputPixels: PIXEL_LIMIT, failOn: 'error', animated });
    if (!animated) p = p.rotate(); // apply EXIF orientation, then EXIF is dropped
    p = p.resize({ width: 4096, height: 4096, fit: 'inside', withoutEnlargement: true });
    let mime = d.mime;
    if (d.mime === 'image/jpeg') p = p.jpeg({ quality: 86, mozjpeg: true });
    else if (d.mime === 'image/png') p = p.png({ compressionLevel: 8 });
    else if (d.mime === 'image/gif') p = p.gif();
    else {
      p = p.webp({ quality: 85 });
      mime = 'image/webp';
    }
    const out = this.tempPath();
    let info: OutputInfo;
    try {
      info = await p.toFile(out);
    } catch {
      await fs.rm(out, { force: true });
      throw new UnsupportedFileError('This image could not be processed. It may be damaged.');
    }
    const thumbnail = protectedMedia
      ? null
      : await sharp(out, { limitInputPixels: PIXEL_LIMIT }).resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true }).webp({ quality: 70 }).toBuffer();
    const { sha256, size } = await hashFile(out);
    const height = animated && info.pageHeight ? info.pageHeight : info.height;
    return { kind: 'image', mime, label: d.label, path: out, size, sha256, width: info.width, height, durationMs: null, thumbnail };
  }

  private async av(file: string, inputSize: number, d: Detected, voice: boolean, protectedMedia: boolean): Promise<ProcessedMedia> {
    let probe: ProbeResult;
    try {
      probe = await this.ff.probe(file);
    } catch {
      throw new UnsupportedFileError('This media file could not be read. It may be damaged.');
    }
    const video = probe.streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
    const audio = probe.streams.find((s) => s.codec_type === 'audio');
    const duration = durationOf(probe);
    const out = this.tempPath();
    try {
      if (video && !voice) {
        this.checkSize('video', inputSize);
        if (!VIDEO_CODECS.has(video.codec_name ?? '')) {
          throw new UnsupportedFileError('This video format can’t be played in browsers. Convert it to MP4 (H.264) and try again.');
        }
        if (duration && duration > this.cfg.MAX_VIDEO_SECONDS) {
          throw new MediaTooLargeError(`Videos can be at most ${Math.round(this.cfg.MAX_VIDEO_SECONDS / 60)} minutes long.`);
        }
        const webm = ['vp8', 'vp9', 'av1'].includes(video.codec_name!) && (!audio || ['opus', 'vorbis'].includes(audio.codec_name ?? ''));
        const args = ['-i', file, '-map', '0:v:0', ...(audio ? ['-map', '0:a:0'] : []), '-map_metadata', '-1', '-map_chapters', '-1', '-c:v', 'copy'];
        if (webm) args.push(...(audio ? ['-c:a', 'copy'] : []), '-f', 'webm', out);
        else {
          if (audio) args.push(...(['aac', 'mp3'].includes(audio.codec_name ?? '') ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '128k']));
          if (video.codec_name === 'hevc') args.push('-tag:v', 'hvc1');
          args.push('-movflags', '+faststart', '-f', 'mp4', out);
        }
        await this.ff.exec(args);
        const outProbe = await this.ff.probe(out);
        const v = outProbe.streams.find((s) => s.codec_type === 'video');
        const rotated = v ? rotationOf(v) === 90 : false;
        const dur = durationOf(outProbe) ?? duration;
        let thumbnail: Buffer | null = null;
        if (!protectedMedia) {
          try {
            const png = await this.ff.frame(out, Math.min(1, (dur ?? 0) / 3));
            thumbnail = await sharp(png).resize({ width: 480, height: 480, fit: 'inside' }).webp({ quality: 70 }).toBuffer();
          } catch {
            thumbnail = null; // a missing thumbnail is not fatal
          }
        }
        const { sha256, size } = await hashFile(out);
        return {
          kind: 'video',
          mime: webm ? 'video/webm' : 'video/mp4',
          label: 'Video',
          path: out,
          size,
          sha256,
          width: (rotated ? v?.height : v?.width) ?? null,
          height: (rotated ? v?.width : v?.height) ?? null,
          durationMs: dur ? Math.round(dur * 1000) : null,
          thumbnail,
        };
      }
      if (!audio || !AUDIO_CODECS.has(audio.codec_name ?? '')) {
        throw new UnsupportedFileError('This audio format is not supported. Try MP3, M4A, WAV, FLAC or Ogg.');
      }
      this.checkSize(voice ? 'voice' : 'audio', inputSize);
      if (duration && duration > this.cfg.MAX_AUDIO_SECONDS) {
        throw new MediaTooLargeError(`Audio can be at most ${Math.round(this.cfg.MAX_AUDIO_SECONDS / 60)} minutes long.`);
      }
      // Voice notes and Ogg/WebM audio are transcoded to MP3: the one format every current browser
      // plays, including Safari (no Ogg/WebM Opus on older iOS) and Chromium builds without AAC.
      const transcode = voice || d.container === 'ogg' || d.container === 'matroska';
      let mime: string;
      const args = ['-i', file, '-vn', '-map', '0:a:0', '-map_metadata', '-1'];
      if (transcode) {
        args.push('-c:a', 'libmp3lame', '-b:a', voice ? '64k' : '128k', ...(voice ? ['-ac', '1'] : []), '-id3v2_version', '0', '-write_xing', '1', '-f', 'mp3', out);
        mime = 'audio/mpeg';
      } else {
        args.push('-c:a', 'copy');
        const fmt = { mp4: ['mp4', 'audio/mp4'], mp3: ['mp3', 'audio/mpeg'], wav: ['wav', 'audio/wav'], flac: ['flac', 'audio/flac'], aac: ['adts', 'audio/aac'] }[d.container as 'mp4'] ?? ['mp4', 'audio/mp4'];
        if (fmt[0] === 'mp4') args.push('-movflags', '+faststart');
        if (fmt[0] === 'mp3') args.push('-id3v2_version', '0');
        args.push('-f', fmt[0]!, out);
        mime = fmt[1]!;
      }
      await this.ff.exec(args);
      const outProbe = await this.ff.probe(out);
      const dur = durationOf(outProbe) ?? duration;
      const { sha256, size } = await hashFile(out);
      return { kind: 'audio', mime, label: voice ? 'Voice message' : 'Audio', path: out, size, sha256, width: null, height: null, durationMs: dur ? Math.round(dur * 1000) : null, thumbnail: null };
    } catch (err) {
      await fs.rm(out, { force: true });
      if (err instanceof UnsupportedFileError || err instanceof MediaTooLargeError) throw err;
      throw new UnsupportedFileError('This media file could not be processed. It may be damaged or use an unsupported format.');
    }
  }

  /** Square avatar from a user-chosen crop rectangle (in oriented image pixels). */
  async avatar(file: string, crop: { x: number; y: number; size: number } | null): Promise<{ large: Buffer; small: Buffer }> {
    let meta: Metadata;
    try {
      meta = await sharp(file, { limitInputPixels: PIXEL_LIMIT, failOn: 'error' }).metadata();
    } catch {
      throw new UnsupportedFileError('This image could not be read.');
    }
    const swap = (meta.orientation ?? 1) >= 5;
    const w = (swap ? meta.height : meta.width) ?? 0;
    const h = (swap ? meta.width : meta.height) ?? 0;
    if (!w || !h) throw new UnsupportedFileError('This image could not be read.');
    let region: Region;
    if (crop) {
      const size = Math.min(Math.round(crop.size), w, h);
      const left = Math.min(Math.max(0, Math.round(crop.x)), w - size);
      const top = Math.min(Math.max(0, Math.round(crop.y)), h - size);
      if (size < 32) throw new UnsupportedFileError('The selected area is too small.');
      region = { left, top, width: size, height: size };
    } else {
      const size = Math.min(w, h);
      region = { left: Math.floor((w - size) / 2), top: Math.floor((h - size) / 2), width: size, height: size };
    }
    try {
      const base = await sharp(file, { limitInputPixels: PIXEL_LIMIT, failOn: 'error' }).rotate().extract(region).toBuffer();
      const large = await sharp(base).resize(512, 512).webp({ quality: 82 }).toBuffer();
      const small = await sharp(base).resize(128, 128).webp({ quality: 78 }).toBuffer();
      return { large, small };
    } catch {
      throw new UnsupportedFileError('This image could not be processed.');
    }
  }
}
