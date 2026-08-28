// The browser's side of the records API.
//
// Supabase let the browser query Postgres directly and relied on row-level
// security to keep one teacher out of another's data. That is gone; the same
// guarantee now comes from the server scoping every statement by the session
// cookie. So this file is deliberately thin: it never sends a teacher id,
// because the server would ignore it anyway.
//
// Credentials are included on every call — the session is an HttpOnly cookie,
// which JavaScript cannot read and therefore cannot leak, and which the browser
// attaches on its own.
import { apiFetch } from './passcode';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** Signed out. Callers show a sign-in prompt rather than an error. */
export class NotSignedIn extends ApiError {
  constructor() { super('Not signed in', 401); this.name = 'NotSignedIn'; }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers || {}),
    },
  });
  if (res.status === 401) throw new NotSignedIn();
  let body: any = null;
  try { body = await res.json(); } catch { /* empty or non-JSON */ }
  if (!res.ok) throw new ApiError(body?.error || `Request failed (${res.status})`, res.status);
  return body as T;
}

export const api = {
  get:   <T>(p: string) => request<T>(p),
  post:  <T>(p: string, body?: unknown) =>
           request<T>(p, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: <T>(p: string, body: unknown) =>
           request<T>(p, { method: 'PATCH', body: JSON.stringify(body) }),
  del:   <T>(p: string) => request<T>(p, { method: 'DELETE' }),
};
