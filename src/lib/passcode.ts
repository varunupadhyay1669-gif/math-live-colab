// The shared site passcode.
//
// One code that everyone — tutor and student — enters before the app will do
// anything. It exists because this account's monthly quota was exhausted by
// traffic the owner did not control; resuming a suspended service without a
// gate hands that quota straight back to whoever arrives first.
//
// The REAL check is the socket handshake on the server. Everything here is the
// prompt and the remembering. A browser cannot enforce this — anyone can edit
// the page — which is exactly why the server refuses the connection rather
// than trusting a screen to stay in the way.

const KEY = 'mathslive:passcode';

export function storedPasscode(): string {
  try { return localStorage.getItem(KEY) || ''; } catch { return ''; }
}

export function rememberPasscode(code: string): void {
  try { localStorage.setItem(KEY, code); } catch { /* private mode — they retype it */ }
}

export function forgetPasscode(): void {
  try { localStorage.removeItem(KEY); } catch { /* noop */ }
}

/**
 * Socket.IO auth payload.
 *
 * Always sent, even when empty: a server with no passcode set ignores it, and
 * one that wants it gets it on the very first handshake rather than after a
 * failed round trip.
 */
export function socketAuth(): { passcode: string } {
  return { passcode: storedPasscode() };
}

/** Header form, for the two HTTP endpoints that do real work. */
export function passcodeHeaders(): Record<string, string> {
  const code = storedPasscode();
  return code ? { 'x-site-passcode': code } : {};
}

/**
 * Was this connection refused for want of the passcode?
 *
 * Socket.IO delivers middleware failures as a plain Error carrying the
 * server's message, so this matches on that rather than on a status code.
 */
export function isPasscodeError(err: unknown): boolean {
  const msg = (err as { message?: string })?.message || String(err ?? '');
  return /passcode_required/i.test(msg);
}

/** Does this deployment want one? Cheap, and never returns the code. */
export async function passcodeIsRequired(): Promise<boolean> {
  // Two paths, because some hosts answer /healthz themselves at the edge.
  // Google AI Studio returns its own 404 there, which made this report "no
  // server" and skip the prompt on a deployment that was running perfectly.
  for (const path of ['/healthz', '/api/healthz']) {
    try {
      const res = await fetch(path, { cache: 'no-store' });
      if (!res.ok) continue;
      const body = await res.json();
      if (typeof body?.passcodeRequired === 'boolean') return body.passcodeRequired;
    } catch { /* try the next path */ }
  }
  // Neither answered: offline, or the server is down. Do not block the app on
  // a guess — if a code is genuinely needed the socket refuses, and that path
  // brings the prompt up anyway.
  return false;
}

/** The event that brings the prompt back up. */
export const PASSCODE_REFUSED = 'mathslive:passcode-refused';

export interface PasscodeRefusedDetail {
  /** True when a code was stored and rejected; false when none was ever entered. */
  hadCode: boolean;
}

/**
 * fetch() for the endpoints the server gates, with the passcode attached.
 *
 * Three HTTP endpoints do real work and check the passcode: quick-deploy
 * publish, the /p/:id viewer, and the student's content fallback. Every one of
 * them called plain fetch(), so none of them ever sent the code and all three
 * returned 401 the moment a SITE_PASSCODE was set. Quick deploy was the visible
 * casualty — "Deploy now" answered with the raw string passcode_required and no
 * way to supply one, because the gate only ever listened to the socket.
 *
 * Attaching the header is the fix; re-arming the gate on a refusal is what turns
 * the remaining cases (no code stored, or a stale one) into a prompt instead of
 * a dead end.
 */
export function refusePasscode(): void {
  const detail: PasscodeRefusedDetail = { hadCode: !!storedPasscode() };
  window.dispatchEvent(new CustomEvent(PASSCODE_REFUSED, { detail }));
}

export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(input, {
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined), ...passcodeHeaders() },
  });
  if (res.status === 401) {
    // Read a COPY: the caller still needs to consume the body itself.
    const body = await res.clone().json().catch(() => null) as { error?: string } | null;
    if (body?.error === 'passcode_required') refusePasscode();
  }
  return res;
}
