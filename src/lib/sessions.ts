import { api, NotSignedIn } from './api';
// The day helpers are pure and live in lessonNav, which imports nothing —
// keeping them here would drag the API client into every test that only wants
// to know what a lesson is called.
import { lessonDay, findSessionForDay } from './lessonNav';
export { lessonDay, findSessionForDay };

// A "session" is a saved snapshot of a teaching session for a class: what was
// taught (topic), the HTML used, and the whiteboard at save time.
//
// Stored server-side in `teaching_sessions` — NOT `sessions`, which the
// intelligence schema already owns for a different thing. The shape below is
// unchanged, so every screen reading it stayed as it was.
export interface SessionRow {
  id: string;
  class_id: string;
  teacher_id: string;
  started_at: string;
  ended_at: string | null;
  topic: string | null;
  notes: string | null;
  whiteboard_snapshot: any | null;
  html_used: string | null;
  /** Seconds with a teacher and >=1 student both present. */
  taught_seconds?: number | null;
}

function emptyIfSignedOut<T>(err: unknown, fallback: T): T {
  if (err instanceof NotSignedIn) return fallback;
  throw err;
}

/** The room_code → class id lookup. Resolves only for the owning teacher. */
export async function findClassIdByRoomCode(roomCode: string): Promise<string | null> {
  try {
    const { class: row } = await api.get<{ class: { id: string } | null }>(
      `/api/classes/by-code/${encodeURIComponent(roomCode)}`);
    return row?.id ?? null;
  } catch (err) { return emptyIfSignedOut(err, null); }
}

/** Insert a new lesson row. Returns its id so the caller can keep writing to it. */
export async function saveSession(input: {
  classId: string;
  topic?: string;
  html?: string | null;
  whiteboard?: any;
  startedAt?: string;
}): Promise<string> {
  const { session } = await api.post<{ session: SessionRow }>('/api/sessions', input);
  return session.id;
}

export async function listSessions(classId: string): Promise<SessionRow[]> {
  try {
    const { sessions } = await api.get<{ sessions: SessionRow[] }>(
      `/api/sessions?classId=${encodeURIComponent(classId)}`);
    return sessions ?? [];
  } catch (err) { return emptyIfSignedOut(err, []); }
}

export async function getSession(id: string): Promise<SessionRow | null> {
  try {
    const { session } = await api.get<{ session: SessionRow | null }>(
      `/api/sessions/${encodeURIComponent(id)}`);
    return session ?? null;
  } catch (err) { return emptyIfSignedOut(err, null); }
}

export async function deleteSession(id: string): Promise<void> {
  await api.del(`/api/sessions/${encodeURIComponent(id)}`);
}

// ── One row per lesson, not one per Save ──
//
// saveSession always INSERTs. Press "Save to history" three times in a lesson
// and the student's history grows three near-identical rows dated the same
// afternoon — and a lesson picker built on that shows "Aug 6" three times with
// no way to tell which is current. A lesson is a day's work, so saving during
// one updates it.

export async function updateSession(id: string, input: {
  topic?: string; html?: string | null; whiteboard?: unknown; taughtSeconds?: number | null;
}): Promise<void> {
  const patch: Record<string, unknown> = { ended_at: new Date().toISOString() };
  if (input.topic !== undefined) patch.topic = input.topic?.trim() || null;
  if (input.html !== undefined) patch.html_used = input.html;
  if (input.whiteboard !== undefined) patch.whiteboard_snapshot = input.whiteboard ?? null;
  // Only ever grows within a lesson, so a later save cannot shorten it.
  if (input.taughtSeconds !== undefined && input.taughtSeconds !== null) {
    patch.taught_seconds = input.taughtSeconds;
  }
  await api.patch(`/api/sessions/${encodeURIComponent(id)}`, patch);
}

/**
 * Save today's lesson, replacing today's row if there is one.
 *
 * Returns the row id when it can, so a caller can keep pointing at the same
 * lesson. Never creates a second row for a day already saved.
 */
export async function saveLessonForDay(input: {
  classId: string;
  topic?: string;
  html?: string | null;
  whiteboard?: unknown;
  /** Which lesson to write to; omit for today. */
  sessionId?: string | null;
  /** Seconds actually taught so far — see lib/teachingTime. */
  taughtSeconds?: number | null;
}): Promise<string | null> {
  if (input.sessionId) {
    await updateSession(input.sessionId, input);
    return input.sessionId;
  }
  const today = lessonDay(new Date().toISOString());
  const existing = findSessionForDay(await listSessions(input.classId), today);
  if (existing) {
    await updateSession(existing.id, input);
    return existing.id;
  }
  // The insert hands back its id directly now, so the "save then search for
  // what I just wrote" round trip the Supabase version needed is gone.
  const id = await saveSession(input);
  if (id && input.taughtSeconds) {
    try { await updateSession(id, { taughtSeconds: input.taughtSeconds }); }
    catch { /* the lesson is saved; its length is the lesser loss */ }
  }
  return id ?? null;
}
