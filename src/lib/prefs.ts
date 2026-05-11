// AUTONOMOUS: [ORDER-2 ESSENTIAL] - localStorage-backed user preferences.
//
// Without this, every session starts fresh: students re-type their name on
// every reconnect, teachers re-set their sound preference, etc. That's the
// kind of small friction that compounds over a hundred sessions and makes
// the product feel half-built.
//
// Defensive: localStorage can throw (private mode, quota exceeded, security
// errors in some embeds). Every read/write is wrapped, and a missing /
// invalid value falls back to the default.

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

const NS = 'mathlive:'; // namespace so we don't collide with other apps on the same origin

function safeGet(key: string): string | null {
  try {
    return window.localStorage.getItem(NS + key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(NS + key, value);
  } catch {
    // Quota / disabled / private mode — silently no-op. The preference just
    // won't persist for this session, which is preferable to crashing.
  }
}

export const prefs = {
  // ── String ──
  getString(key: string, fallback: string): string {
    const v = safeGet(key);
    return v == null ? fallback : v;
  },
  setString(key: string, value: string): void {
    safeSet(key, value);
  },

  // ── Boolean ──
  getBool(key: string, fallback: boolean): boolean {
    const v = safeGet(key);
    if (v == null) return fallback;
    return v === '1' || v === 'true';
  },
  setBool(key: string, value: boolean): void {
    safeSet(key, value ? '1' : '0');
  },

  // ── JSON (objects/arrays) ──
  getJson<T extends Json>(key: string, fallback: T): T {
    const v = safeGet(key);
    if (v == null) return fallback;
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  },
  setJson(key: string, value: Json): void {
    try {
      safeSet(key, JSON.stringify(value));
    } catch {
      // Circular ref or some other JSON failure — drop silently.
    }
  },
};

// Well-known keys, centralised so renaming is a one-line change.
export const PREF_KEYS = {
  userName: 'userName',
  soundMuted: 'soundMuted',
  savedBoards: 'savedBoards',
} as const;

// AUTONOMOUS: Saved-boards helpers (Miro-style "Save to my boards").
//
// We store a per-browser list of room ids the user explicitly claimed.
// localStorage is the right scope for now: identity is name-only and
// per-browser anyway; cross-device portability needs real auth (Phase 3).
// Stored as a JSON array of {roomId, name, claimedAt, label} so Home
// can render a "My boards" section without a server round-trip.
export interface SavedBoard {
  roomId: string;
  name: string;          // the user's chosen display name at claim time
  claimedAt: number;     // ms epoch
  label?: string;        // optional human-friendly board title
}

export const savedBoards = {
  list(): SavedBoard[] {
    // Cast through unknown — see add() comment for the type rationale.
    const raw = prefs.getJson(PREF_KEYS.savedBoards, [] as unknown as Json);
    return (Array.isArray(raw) ? raw : []) as unknown as SavedBoard[];
  },
  add(entry: SavedBoard): void {
    const current = savedBoards.list().filter(b => b.roomId !== entry.roomId);
    current.unshift(entry); // newest first
    // Cap to 50 to avoid localStorage bloat — older entries fall off.
    // Cast through `unknown`: SavedBoard is json-serializable but the
    // strict Json type requires an index signature we'd rather not add
    // to the public interface (it would weaken the field types).
    prefs.setJson(PREF_KEYS.savedBoards, current.slice(0, 50) as unknown as Json);
  },
  remove(roomId: string): void {
    const current = savedBoards.list().filter(b => b.roomId !== roomId);
    prefs.setJson(PREF_KEYS.savedBoards, current as unknown as Json);
  },
  has(roomId: string): boolean {
    return savedBoards.list().some(b => b.roomId === roomId);
  },
};
