import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { getClassByRoomCode, updateClass, touchClass, ProfileColumnsMissing, type ClassRow } from "../lib/classes";
import { listSessions, type SessionRow } from "../lib/sessions";
import { cleanDisplayName } from "../lib/displayName";
import {
  profileFrom, joinGoals, parseGoals, avatarFor, summariseHistory, sinceLabel, firstEmoji,
} from "../lib/studentProfile";

// ─────────────────────────────────────────────────────────────────────────
// One student, one page.
//
// The class list answers "who do I teach?". This answers "who is this, where
// are they, and what are we doing next?" — the things a tutor otherwise keeps
// in their head or in a notebook. Everything on it is either something you act
// on (go in, send the link) or something you'd want to reread thirty seconds
// before the lesson starts.
// ─────────────────────────────────────────────────────────────────────────

const AVATAR_CHOICES = ['', '🦊', '🐰', '🐼', '🦉', '🐢', '🚀', '⭐', '🎯', '🌱', '🧠', '🎨'];

export default function StudentDashboard() {
  const { roomCode = '' } = useParams();
  const navigate = useNavigate();
  const auth = useAuth();

  const [row, setRow] = useState<ClassRow | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(0);
  const [copied, setCopied] = useState(false);

  // Draft of the editable fields. Kept separate from `row` so typing never
  // fights a background refresh, and so Cancel is a real cancel.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ grade: '', level: '', goals: '', avatar: '', label: '' });

  useEffect(() => {
    if (auth.loading) return;
    if (!auth.enabled || !auth.user) navigate('/', { replace: true });
  }, [auth.enabled, auth.user, auth.loading, navigate]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const found = await getClassByRoomCode(roomCode);
      if (!found) { setNotFound(true); return; }
      setRow(found);
      const p = profileFrom(found);
      setDraft({
        grade: p.grade, level: p.level, goals: joinGoals(p.goals),
        avatar: p.avatar, label: found.label ?? '',
      });
      try { setSessions(await listSessions(found.id)); } catch { setSessions([]); }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load this student');
    } finally {
      setLoading(false);
    }
  }, [roomCode]);

  useEffect(() => { if (auth.user) void load(); }, [auth.user, load]);

  const teacherName = useMemo(() => {
    const meta = auth.user?.user_metadata as { full_name?: string; name?: string } | undefined;
    return meta?.full_name || meta?.name || cleanDisplayName(auth.user?.email) || 'Teacher';
  }, [auth.user]);

  const profile = useMemo(() => profileFrom(row), [row]);
  const history = useMemo(() => summariseHistory(sessions), [sessions]);
  const avatar = useMemo(() => avatarFor(row?.student_name || '', profile.avatar), [row, profile.avatar]);
  const studentLink = row ? `${window.location.origin}/live/${row.room_code}` : '';

  const enterClassroom = () => {
    if (!row) return;
    void touchClass(row.room_code);
    navigate(`/room/${row.room_code}?name=${encodeURIComponent(teacherName)}`);
  };

  const copyLink = async () => {
    let done = false;
    try {
      if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(studentLink); done = true; }
    } catch { done = false; }
    if (!done) {
      // clipboard is undefined on plain-http origins (a common LAN setup).
      try {
        const ta = document.createElement('textarea');
        ta.value = studentLink; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
        done = true;
      } catch { done = false; }
    }
    if (done) { setCopied(true); setTimeout(() => setCopied(false), 1600); }
    else setError('Could not copy — select the link and copy it manually.');
  };

  const save = async () => {
    if (!row || saving) return;
    setSaving(true);
    setError(null);
    const fields = {
      label: draft.label.trim() || null,
      grade: draft.grade.trim() || null,
      level: draft.level.trim() || null,
      goals: joinGoals(parseGoals(draft.goals)) || null,
      avatar: firstEmoji(draft.avatar) || null,
    };
    try {
      await updateClass(row.id, fields);
      setRow({ ...row, ...fields });
      setEditing(false);
      setSavedAt(Date.now());
    } catch (e) {
      setError(e instanceof ProfileColumnsMissing
        ? e.message
        : e instanceof Error ? e.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  const cancel = () => {
    const p = profileFrom(row);
    setDraft({ grade: p.grade, level: p.level, goals: joinGoals(p.goals), avatar: p.avatar, label: row?.label ?? '' });
    setEditing(false);
    setError(null);
  };

  const fmtDate = (iso: string) => {
    try { return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
    catch { return iso; }
  };

  if (loading) {
    return <Shell><p style={{ opacity: 0.7, textAlign: 'center' }}>Loading…</p></Shell>;
  }

  if (notFound) {
    return (
      <Shell>
        <div className="ml-sd-empty">
          <h1 className="ml-dark-headline">Student not found</h1>
          <p style={{ opacity: 0.75, lineHeight: 1.6 }}>
            No student of yours has the code <code>{roomCode}</code>. It may have been
            deleted, or the link belongs to a different account.
          </p>
          <Link className="ml-dark-btn ml-dark-btn-primary" to="/dashboard">Back to your students</Link>
        </div>
      </Shell>
    );
  }

  if (!row) return <Shell><p style={{ opacity: 0.7 }}>{error || 'Could not load this student.'}</p></Shell>;

  return (
    <Shell>
      <div className="ml-sd">
        <Link to="/dashboard" className="ml-sd-back">← All students</Link>

        {/* ── Who ── */}
        <header className="ml-sd-head">
          <div className="ml-sd-avatar" style={{ background: avatar.bg, color: avatar.fg }} aria-hidden="true">
            <span style={{ fontSize: avatar.isEmoji ? '2rem' : '1.5rem' }}>{avatar.label}</span>
          </div>
          <div className="ml-sd-head-text">
            <h1 className="ml-sd-name">{row.student_name}</h1>
            <div className="ml-sd-chips">
              {profile.grade && <span className="ml-sd-chip">{profile.grade}</span>}
              {profile.level && <span className="ml-sd-chip">{profile.level}</span>}
              {row.label && <span className="ml-sd-chip ml-sd-chip-soft">{row.label}</span>}
              <span className="ml-sd-chip ml-sd-chip-soft">
                {history.count === 0 ? 'no lessons yet' : `${history.count} lesson${history.count === 1 ? '' : 's'} · ${sinceLabel(history.lastTaughtAt)}`}
              </span>
            </div>
          </div>
          <div className="ml-sd-head-actions">
            <button className="ml-dark-btn ml-dark-btn-primary" onClick={enterClassroom}>
              Enter classroom
            </button>
            <button className="ml-dark-btn ml-dark-btn-glass" onClick={copyLink}>
              {copied ? 'Link copied' : "Copy student's link"}
            </button>
          </div>
        </header>

        {error && <p className="ml-sd-error">{error}</p>}
        {savedAt > 0 && !editing && !error && <p className="ml-sd-saved">Saved.</p>}

        <div className="ml-sd-cols">
          {/* ── Profile ── */}
          <section className="ml-sd-card">
            <div className="ml-sd-card-head">
              <h2>Profile</h2>
              {!editing
                ? <button className="ml-dark-btn ml-dark-btn-ghost" onClick={() => setEditing(true)}>Edit</button>
                : (
                  <span style={{ display: 'flex', gap: 8 }}>
                    <button className="ml-dark-btn ml-dark-btn-ghost" onClick={cancel} disabled={saving}>Cancel</button>
                    <button className="ml-dark-btn ml-dark-btn-primary" onClick={save} disabled={saving}>
                      {saving ? 'Saving…' : 'Save'}
                    </button>
                  </span>
                )}
            </div>

            {!editing ? (
              <dl className="ml-sd-facts">
                <Fact label="Grade / year" value={profile.grade} />
                <Fact label="Level" value={profile.level} />
                <div className="ml-sd-fact">
                  <dt>Goals</dt>
                  <dd>
                    {profile.goals.length === 0
                      ? <span className="ml-sd-blank">Nothing set yet — Edit to add what you're working towards.</span>
                      : <ul className="ml-sd-goals">{profile.goals.map((g, i) => <li key={i}>{g}</li>)}</ul>}
                  </dd>
                </div>
              </dl>
            ) : (
              <div className="ml-sd-form">
                <label>
                  <span>Grade / year</span>
                  <input className="ml-dark-input" value={draft.grade} placeholder="e.g. Year 8"
                    onChange={(e) => setDraft(d => ({ ...d, grade: e.target.value }))} />
                </label>
                <label>
                  <span>Level</span>
                  <input className="ml-dark-input" value={draft.level} placeholder="e.g. Higher, Foundation, Olympiad"
                    onChange={(e) => setDraft(d => ({ ...d, level: e.target.value }))} />
                </label>
                <label>
                  <span>Subject / note</span>
                  <input className="ml-dark-input" value={draft.label} placeholder="e.g. Algebra"
                    onChange={(e) => setDraft(d => ({ ...d, label: e.target.value }))} />
                </label>
                <label>
                  <span>Goals — one per line</span>
                  <textarea className="ml-dark-input" rows={4} value={draft.goals}
                    placeholder={"Confident with fractions\nSpeed on times tables"}
                    onChange={(e) => setDraft(d => ({ ...d, goals: e.target.value }))} />
                </label>
                <div>
                  <span className="ml-sd-form-label">Avatar</span>
                  <div className="ml-sd-avatar-picker">
                    {AVATAR_CHOICES.map((c) => (
                      <button key={c || 'none'} type="button"
                        className={`ml-sd-avatar-opt${draft.avatar === c ? ' is-on' : ''}`}
                        onClick={() => setDraft(d => ({ ...d, avatar: c }))}
                        title={c ? `Use ${c}` : 'Use their initials'}>
                        {c || avatarFor(row.student_name).label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </section>

          {/* ── Lessons ── */}
          <section className="ml-sd-card">
            <div className="ml-sd-card-head">
              <h2>Lessons</h2>
              <span className="ml-sd-count">{history.count}</span>
            </div>

            {history.topics.length > 0 && (
              <p className="ml-sd-covered">
                <span className="ml-sd-covered-label">Recently covered</span>
                {history.topics.map((t, i) => <span key={i} className="ml-sd-chip ml-sd-chip-soft">{t}</span>)}
              </p>
            )}

            {sessions.length === 0 ? (
              <p className="ml-sd-blank" style={{ lineHeight: 1.6 }}>
                Nothing saved yet. At the end of a lesson, use “💾 Save to history”
                in the classroom and it will appear here — board and all.
              </p>
            ) : (
              <ul className="ml-sd-sessions">
                {sessions.map((s) => (
                  <li key={s.id}>
                    <span className="ml-sd-session-text">
                      <strong>{s.topic || 'Lesson'}</strong>
                      <span className="ml-sd-session-date">{fmtDate(s.started_at)}</span>
                    </span>
                    <button className="ml-dark-btn ml-dark-btn-glass"
                      onClick={() => navigate(`/room/${row.room_code}?name=${encodeURIComponent(teacherName)}&session=${s.id}`)}>
                      Reopen
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </Shell>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="ml-sd-fact">
      <dt>{label}</dt>
      <dd>{value || <span className="ml-sd-blank">—</span>}</dd>
    </div>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="ml-dark-home">
      <div className="ml-dark-stage">
        <header className="ml-dark-topbar">
          <Link to="/dashboard" className="ml-dark-brand" style={{ textDecoration: 'none' }}>
            <span className="ml-dark-brandmark" aria-hidden="true">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 18l6-12 4 8 6-4" />
              </svg>
            </span>
            <span className="ml-dark-wordmark">Maths<span className="accent">Live</span></span>
          </Link>
        </header>
        <div className="ml-dark-center">{children}</div>
      </div>
    </div>
  );
}
