import { supabase } from './supabase';

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
}

// The room_code → class id lookup (RLS: resolves only for the owning teacher).
export async function findClassIdByRoomCode(roomCode: string): Promise<string | null> {
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
  if (!supabase) return null;
  const { data, error } = await supabase.from('sessions').select('*').eq('id', id).maybeSingle();
  if (error || !data) return null;
  return data as SessionRow;
}

export async function deleteSession(id: string): Promise<void> {
  if (!supabase) return;
  const { error } = await supabase.from('sessions').delete().eq('id', id);
  if (error) throw error;
}
