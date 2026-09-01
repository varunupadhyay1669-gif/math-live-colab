// A stable name for the machine, as opposed to the name the person typed.
//
// The admin screen could say "Varun is teaching Samaira", which is whatever
// two people put in a name box — useful for reading, useless for knowing. Two
// tabs, a shared laptop, or somebody typing a colleague's name all look
// identical.
//
// So each browser profile gets one opaque id, made once and kept. It answers
// the question a name cannot: is this the same machine as last time, and are
// these two rooms actually the same device?
//
// What it deliberately is NOT: it carries no name, no email and nothing about
// the person; it is random, not derived from anything about them. Clearing
// site data resets it, which is correct — this identifies a browser, and a
// cleared browser is a new one. It is not a login and must never be treated
// as one.
const KEY = 'mathslive_client_id';

function make(): string {
  try {
    // 9 bytes is plenty to never collide across a few thousand devices, and
    // short enough to read out over the phone.
    const b = new Uint8Array(9);
    crypto.getRandomValues(b);
    return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  } catch {
    return Math.random().toString(16).slice(2, 20);
  }
}

let cached: string | null = null;

/** The id for this browser. Stable across reloads; new after clearing data. */
export function clientId(): string {
  if (cached) return cached;
  try {
    const stored = localStorage.getItem(KEY);
    if (stored && /^[0-9a-f]{8,40}$/.test(stored)) { cached = stored; return cached; }
    const fresh = make();
    localStorage.setItem(KEY, fresh);
    cached = fresh;
    return fresh;
  } catch {
    // Private mode, or storage refused. A per-session id still tells the owner
    // that two rooms are the same tab, which is better than nothing.
    cached = cached || make();
    return cached;
  }
}

/** Short form for a screen: enough to compare two at a glance. */
export function shortClientId(id: string): string {
  return id.slice(0, 6);
}
