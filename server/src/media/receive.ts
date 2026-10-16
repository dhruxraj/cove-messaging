import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { ApiError } from '../lib/errors';
import type { Storage } from './storage';

export interface ReceivedFile {
  path: string;
  size: number;
  sha256: Buffer;
}

/**
 * Stream a raw request body to a private temp file, enforcing the size limit while bytes arrive
 * (nothing is buffered in memory). Interrupted or oversized uploads leave nothing behind.
 */
export async function receiveToTemp(req: Request, storage: Storage, maxBytes: number): Promise<ReceivedFile> {
  const declared = Number(req.headers.get('content-length') ?? 'NaN');
  const limitMb = Math.round(maxBytes / 1024 / 1024);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ApiError(413, 'file_too_large', `This file is too large. The maximum is ${limitMb} MB.`);
  }
  if (!req.body) throw new ApiError(400, 'empty_upload', 'No file was received.');

  const path = storage.tempPath();
  const hash = createHash('sha256');
  let size = 0;
  let tooLarge = false;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length;
      if (size > maxBytes) {
        tooLarge = true;
        cb(new Error('too large'));
        return;
      }
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(req.body as unknown as WebReadableStream), meter, createWriteStream(path, { mode: 0o600 }));
  } catch {
    await fs.rm(path, { force: true });
    if (tooLarge) throw new ApiError(413, 'file_too_large', `This file is too large. The maximum is ${limitMb} MB.`);
    throw new ApiError(400, 'upload_interrupted', 'The upload was interrupted. Please try again.');
  }
  if (size === 0) {
    await fs.rm(path, { force: true });
    throw new ApiError(400, 'empty_upload', 'The file is empty.');
  }
  if (Number.isFinite(declared) && declared !== size) {
    await fs.rm(path, { force: true });
    throw new ApiError(400, 'upload_interrupted', 'The upload was incomplete. Please try again.');
  }
  return { path, size, sha256: hash.digest() };
}
