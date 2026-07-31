import type { ClassRow } from './classes';
import type { SessionRow } from './sessions';

// Who a student is, beyond a name and a room link: the things a tutor actually
// holds in their head between lessons — what year they're in, where they're
// working, and what they're trying to get to.
//
// These live as extra columns on `classes` (one row per student already), so
// there's no second table to keep in step. The columns are added by the
// migration in SUPABASE.md; everything here reads defensively so the app works
// perfectly well before that migration is applied — the fields just read empty.

export interface StudentProfile {
  grade: string;   // "Year 8", "Grade 6", "Class 9 ICSE" — free text on purpose
  level: string;   // "Foundation", "Higher", "Olympiad prep" — the tutor's own words
  goals: string[]; // one per line in the database
  avatar: string;  // a single emoji, or '' to use the derived initials
}

/** Read a profile off a class row that may predate the migration. */
export function profileFrom(row: Partial<ClassRow> | null | undefined): StudentProfile {
  const r = (row ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  return {
    grade: str(r.grade),
    level: str(r.level),
    goals: parseGoals(str(r.goals)),
    avatar: firstEmoji(str(r.avatar)),
  };
}

/** Goals are stored as one block of text, one goal per line. */
export function parseGoals(text: string): string[] {
  return (text || '')
    .split('\n')
    .map((g) => g.replace(/^\s*[-•*]\s*/, '').trim())   // tolerate pasted bullets
    .filter(Boolean)
    .slice(0, 12);                                       // a wish-list, not a syllabus
}

export function joinGoals(goals: string[]): string {
  return goals.map((g) => g.trim()).filter(Boolean).join('\n');
}

/** One emoji, or nothing. Guards against a whole sentence landing in the field. */
export function firstEmoji(raw: string): string {
  const s = (raw || '').trim();
  if (!s) return '';
  // One emoji can span several code points (skin tone, ZWJ families), so slice
  // by GRAPHEME, not by character — otherwise "🦊🐰🐼" reads as one "emoji"
  // and three faces end up crammed into the avatar circle.
  let first: string;
  const Segmenter = (Intl as unknown as { Segmenter?: new (l?: string, o?: object) => { segment: (s: string) => Iterable<{ segment: string }> } }).Segmenter;
  if (Segmenter) {
    first = [...new Segmenter(undefined, { granularity: 'grapheme' }).segment(s)][0]?.segment ?? '';
  } else {
    const m = s.match(/\p{Extended_Pictographic}(\p{Emoji_Modifier}|️|‍\p{Extended_Pictographic})*/u);
    first = m ? m[0] : s.slice(0, 2);
  }
  return /\p{Extended_Pictographic}/u.test(first) ? first : '';
}

/** "Anika Kapoor" → "AK"; "drihan" → "D". Used when there's no emoji. */
export function initials(name: string): string {
  const words = (name || '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 1).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

// A small, deliberately calm palette. The colour is DERIVED from the name, so
// every student has a consistent identity from the moment they're created —
// nobody has to pick one, and it never changes under them.
const PALETTE = [
  { bg: '#4F46E5', fg: '#EEF2FF' }, // indigo
  { bg: '#0D9488', fg: '#ECFDF5' }, // teal
  { bg: '#B45309', fg: '#FFFBEB' }, // amber
  { bg: '#BE123C', fg: '#FFF1F2' }, // rose
  { bg: '#6D28D9', fg: '#F5F3FF' }, // violet
  { bg: '#0369A1', fg: '#F0F9FF' }, // sky
  { bg: '#4D7C0F', fg: '#F7FEE7' }, // lime
  { bg: '#9333EA', fg: '#FAF5FF' }, // purple
];

/** Stable per-name colour (djb2 — same hash the mirror uses for fingerprints). */
export function accentFor(name: string): { bg: string; fg: string } {
  let h = 5381;
  const s = (name || '').trim().toLowerCase();
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export interface Avatar { label: string; isEmoji: boolean; bg: string; fg: string }

export function avatarFor(name: string, override?: string): Avatar {
  const emoji = firstEmoji(override || '');
  const { bg, fg } = accentFor(name);
  return emoji
    ? { label: emoji, isEmoji: true, bg, fg }
    : { label: initials(name), isEmoji: false, bg, fg };
}

export interface HistorySummary {
  count: number;
  lastTaughtAt: string | null;
  /** Most recent distinct topics, newest first — the "what we've covered" line. */
  topics: string[];
}

export function summariseHistory(sessions: SessionRow[] | null | undefined): HistorySummary {
  const list = (sessions ?? []).filter(Boolean);
  if (list.length === 0) return { count: 0, lastTaughtAt: null, topics: [] };
  // listSessions already sorts newest-first, but a summary that silently
  // depends on its caller's ordering is a trap — sort defensively.
  const sorted = [...list].sort((a, b) => (b.started_at || '').localeCompare(a.started_at || ''));
  const topics: string[] = [];
  for (const s of sorted) {
    const t = (s.topic || '').trim();
    if (t && !topics.some((x) => x.toLowerCase() === t.toLowerCase())) topics.push(t);
    if (topics.length >= 6) break;
  }
  return { count: sorted.length, lastTaughtAt: sorted[0].started_at || null, topics };
}

/** "3 days ago" / "today" — a tutor reads recency, not timestamps. */
export function sinceLabel(iso: string | null, now: number = Date.now()): string {
  if (!iso) return 'not yet taught';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'not yet taught';
  const days = Math.floor((now - t) / 86400000);
  if (days < 0) return 'scheduled';
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 14) return 'last week';
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  return `${Math.floor(days / 30)} months ago`;
}
