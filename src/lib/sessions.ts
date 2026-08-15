import { getSupabase } from './supabase';
// The day helpers are pure and live in lessonNav, which imports nothing —
// keeping them here would drag the Supabase client into every test that only
// wants to know what a lesson is called.
import { lessonDay, findSessionForDay } from './lessonNav';
export { lessonDay, findSessionForDay };

// A "session" is a saved snapshot of a teaching session for a class: what was
// taught (topic), the HTML used, and the whiteboard at save time. RLS scopes
// rows to the owning teacher (see SUPABASE.md).
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
  /** Seconds with a teacher and >=1 student both present (migration 003).
   *  Optional on the type: a database without the column simply omits it. */
  taught_seconds?: number | null;
}

// The room_code → class id lookup (RLS: resolves only for the owning teacher).
export async function findClassIdByRoomCode(roomCode: string): Promise<string | null> {
  const supabase = await getSupabase();
  if (!supabase) return null;
  const { data, error } = await supabase.from('classes').select('id').eq('room_code', roomCode).maybeSingle();
  if (error || !data) return null;
  return (data as { id: string }).id;
}

export async function saveSession(input: {
  classId: string;
  topic?: string;
  html?: string | null;
  whiteboard?: any;
  startedAt?: string;
}): Promise<void> {
  const supabase = await getSupabase();
  if (!supabase) throw new Error('Auth not configured');
  const { data: userData } = await supabase.auth.getUser();
  const teacher_id = userData.user?.id;
  if (!teacher_id) throw new Error('Not signed in');
  const { error } = await supabase.from('sessions').insert({
    class_id: input.classId,
    teacher_id,
    started_at: input.startedAt || new Date().toISOString(),
    ended_at: new Date().toISOString(),
    topic: input.topic?.trim() || null,
    whiteboard_snapshot: input.whiteboard ?? null,
    html_used: input.html ?? null,
  });
  if (error) throw error;
}

export async function listSessions(classId: string): Promise<SessionRow[]> {
  const supabase = await getSupabase();
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('sessions')
    .select('*')
    .eq('class_id', classId)
    .order('started_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  return (data ?? []) as SessionRow[];
}

export async function getSession(id: string): Promise<SessionRow | null> {
  const supabase = await getSupabase();
  if (!supabase) return null;
  const { data, error } = await supabase.from('sessions').select('*').eq('id', id).maybeSingle();
  if (error || !data) return null;
  return data as SessionRow;
}

export async function deleteSession(id: string): Promise<void> {
  const supabase = await getSupabase();
  if (!supabase) return;
  const { error } = await supabase.from('sessions').delete().eq('id', id);
  if (error) throw error;
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
  const supabase = await getSupabase();
  if (!supabase) throw new Error('Auth not configured');
  const patch: Record<string, unknown> = { ended_at: new Date().toISOString() };
  if (input.topic !== undefined) patch.topic = input.topic?.trim() || null;
  if (input.html !== undefined) patch.html_used = input.html;
  if (input.whiteboard !== undefined) patch.whiteboard_snapshot = input.whiteboard ?? null;
  // Only ever grows within a lesson, so a later save cannot shorten it.
  if (input.taughtSeconds !== undefined && input.taughtSeconds !== null) patch.taught_seconds = input.taughtSeconds;
  const { error } = await supabase.from('sessions').update(patch).eq('id', id);
  // 42703 = the column is not there yet (migration 003 unrun). Saving the
  // lesson matters more than recording its length, so retry without it.
  if (error && (error as { code?: string }).code === '42703' && 'taught_seconds' in patch) {
    delete patch.taught_seconds;
    const retry = await supabase.from('sessions').update(patch).eq('id', id);
    if (retry.error) throw retry.error;
    return;
  }
  if (error) throw error;
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
  const supabase = await getSupabase();
  if (!supabase) throw new Error('Auth not configured');
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
  await saveSession(input);
  const fresh = findSessionForDay(await listSessions(input.classId), today);
  // saveSession INSERTs the columns it has always known about; the lesson's
  // length is written straight after so a first save records it too, rather
  // than only from the second save onwards.
  if (fresh && input.taughtSeconds) {
    try { await updateSession(fresh.id, { taughtSeconds: input.taughtSeconds }); }
    catch { /* the lesson is saved; its length is the lesser loss */ }
  }
  return fresh?.id ?? null;
}
