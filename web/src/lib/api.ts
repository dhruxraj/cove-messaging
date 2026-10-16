export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
  get isNetwork() {
    return this.status === 0;
  }
}

let csrfToken = '';
let onUnauthorized: (() => void) | null = null;

export const setCsrfToken = (t: string) => {
  csrfToken = t;
};
export const getCsrfToken = () => csrfToken;
export const setUnauthorizedHandler = (fn: () => void) => {
  onUnauthorized = fn;
};

/** JSON API call. Throws ApiError (status 0 = network failure). */
export async function api<T = unknown>(method: string, path: string, body?: unknown, opts: { signal?: AbortSignal; quiet401?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['x-csrf-token'] = csrfToken;
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      cache: 'no-store',
      signal: opts.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, 'network', "You're offline or the server can't be reached.");
  }
  const type = res.headers.get('content-type') ?? '';
  const data = type.includes('application/json') ? await res.json().catch(() => null) : null;
  if (!res.ok) {
    const e = data?.error ?? {};
    if (res.status === 401 && !opts.quiet401) onUnauthorized?.();
    throw new ApiError(res.status, e.code ?? 'error', e.message ?? `Request failed (${res.status}).`, e);
  }
  return data as T;
}

export const get = <T>(path: string, signal?: AbortSignal) => api<T>('GET', path, undefined, { signal });
export const post = <T>(path: string, body: unknown = {}) => api<T>('POST', path, body);
export const patch = <T>(path: string, body: unknown) => api<T>('PATCH', path, body);
export const put = <T>(path: string, body: unknown) => api<T>('PUT', path, body);
export const del = <T>(path: string, body?: unknown) => api<T>('DELETE', path, body);

export const errorMessage = (err: unknown) => (err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
