import { createReadStream, type ReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { uuid } from '../lib/crypto';

/**
 * Private object storage. Objects are addressed by opaque server-generated keys and are only
 * ever streamed back through authorised API routes — nothing here is web-accessible.
 *
 * The local-disk driver keeps objects on a volume outside any static directory. To move to S3/R2/
 * GCS, implement this interface (put/stat/read/delete/copy) — the rest of the app is unaware of
 * where bytes live.
 */
export interface Storage {
  /** Path for a temporary file on the same volume (so putFile can rename atomically). */
  tempPath(): string;
  putFile(key: string, srcPath: string): Promise<void>;
  putBuffer(key: string, data: Buffer): Promise<void>;
  stat(key: string): Promise<{ size: number } | null>;
  read(key: string, range?: { start: number; end: number }): ReadStream;
  readBuffer(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  copy(srcKey: string, dstKey: string): Promise<void>;
}

const KEY_RE = /^[a-z0-9][a-z0-9/_.-]{0,200}$/;

export class LocalStorage implements Storage {
  private ready: Promise<void>;
  constructor(private root: string) {
    this.ready = (async () => {
      await fs.mkdir(path.join(root, 'objects'), { recursive: true, mode: 0o700 });
      await fs.mkdir(path.join(root, 'tmp'), { recursive: true, mode: 0o700 });
    })();
  }

  private file(key: string) {
    if (!KEY_RE.test(key) || key.includes('..')) throw new Error(`invalid storage key`);
    return path.join(this.root, 'objects', key);
  }

  tempPath() {
    return path.join(this.root, 'tmp', uuid());
  }

  async init() {
    await this.ready;
  }

  async putFile(key: string, srcPath: string) {
    await this.ready;
    const dst = this.file(key);
    await fs.mkdir(path.dirname(dst), { recursive: true, mode: 0o700 });
    await fs.chmod(srcPath, 0o600);
    await fs.rename(srcPath, dst);
  }

  async putBuffer(key: string, data: Buffer) {
    await this.ready;
    const dst = this.file(key);
    await fs.mkdir(path.dirname(dst), { recursive: true, mode: 0o700 });
    const tmp = this.tempPath();
    await fs.writeFile(tmp, data, { mode: 0o600 });
    await fs.rename(tmp, dst);
  }

  async stat(key: string) {
    try {
      const s = await fs.stat(this.file(key));
      return { size: s.size };
    } catch {
      return null;
    }
  }

  read(key: string, range?: { start: number; end: number }) {
    return createReadStream(this.file(key), range ? { start: range.start, end: range.end, highWaterMark: 64 * 1024 } : { highWaterMark: 64 * 1024 });
  }

  readBuffer(key: string) {
    return fs.readFile(this.file(key));
  }

  async delete(key: string) {
    await fs.rm(this.file(key), { force: true });
  }

  async copy(srcKey: string, dstKey: string) {
    const dst = this.file(dstKey);
    await fs.mkdir(path.dirname(dst), { recursive: true, mode: 0o700 });
    await fs.copyFile(this.file(srcKey), dst);
  }

  /** Remove abandoned temp files (interrupted uploads that never reached cleanup). */
  async sweepTemp(olderThanMs: number) {
    const dir = path.join(this.root, 'tmp');
    const now = Date.now();
    for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
      const p = path.join(dir, name);
      const s = await fs.stat(p).catch(() => null);
      if (s && now - s.mtimeMs > olderThanMs) await fs.rm(p, { force: true, recursive: true });
    }
  }
}

/** New opaque keys. No user ids, names or extensions leak into storage paths. */
export const keys = {
  media: () => {
    const d = new Date();
    return `media/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${uuid()}`;
  },
  thumb: () => `thumbs/${uuid()}.webp`,
  avatarPrefix: () => `avatars/${uuid()}`,
};
