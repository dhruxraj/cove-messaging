import { ApiError, getCsrfToken } from './api';

export interface UploadHandle<T> {
  promise: Promise<T>;
  abort: () => void;
}

/**
 * Upload a file as the raw request body (no multipart parsing on the server) with progress.
 * XHR is used because fetch() still has no upload-progress events in most browsers.
 */
export function uploadRaw<T>(url: string, file: Blob, onProgress: (fraction: number) => void): UploadHandle<T> {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<T>((resolve, reject) => {
    xhr.open('POST', url);
    xhr.setRequestHeader('x-csrf-token', getCsrfToken());
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.responseType = 'json';
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response as T);
      else {
        const e = (xhr.response as { error?: { code?: string; message?: string } } | null)?.error;
        reject(new ApiError(xhr.status, e?.code ?? 'upload_failed', e?.message ?? `Upload failed (${xhr.status}).`));
      }
    };
    xhr.onerror = () => reject(new ApiError(0, 'network', 'The upload was interrupted. Check your connection and try again.'));
    xhr.onabort = () => reject(new ApiError(0, 'aborted', 'Upload cancelled.'));
    xhr.send(file);
  });
  return { promise, abort: () => xhr.abort() };
}
