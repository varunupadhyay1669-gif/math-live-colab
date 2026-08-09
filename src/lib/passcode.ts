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
  try {
    const res = await fetch('/healthz', { cache: 'no-store' });
    if (!res.ok) return false;
    const body = await res.json();
    return body?.passcodeRequired === true;
  } catch {
    // Offline or the server is down. Do not block the app on a guess — the
    // socket will refuse anyway if a code is genuinely needed, and that path
    // shows the prompt.
    return false;
  }
}
