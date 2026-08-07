import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useAuth } from '../lib/auth';
import {
  checkAdminAccess, fetchTutorUsage, fetchStudentUsage, activityStatus, agoLabel,
  AdminNotInstalled, type TutorUsage, type StudentUsage, type AdminAccess,
} from '../lib/admin';
import { humanTeachingTime } from '../lib/teachingTime';

// MathsLive Admin — who is using the platform.
//
// A separate surface with its own identity, not a tab on the tutor dashboard:
// nothing here belongs to a tutor, and mixing the two invites the mistake of
// showing one tutor another's students.
//
// This page hiding itself from non-admins is a COURTESY, not the control. The
// control is in Postgres (migration 004): the RPCs behind this refuse anyone
// not listed in platform_admins, so calling them by hand gets you nothing.

type Tab = 'tutors' | 'students';

export default function AdminView() {
  const auth = useAuth();
  const [access, setAccess] = useState<AdminAccess | null>(null);
  const [tab, setTab] = useState<Tab>('tutors');
  const [tutors, setTutors] = useState<TutorUsage[]>([]);
  const [students, setStudents] = useState<StudentUsage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);

  useEffect(() => {
    if (auth.loading) return;
    if (!auth.user) { setAccess('no-auth'); return; }
    let cancelled = false;
    void checkAdminAccess().then(a => { if (!cancelled) setAccess(a); });
    return () => { cancelled = true; };
  }, [auth.loading, auth.user]);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const [t, s] = await Promise.all([fetchTutorUsage(), fetchStudentUsage()]);
      setTutors(t);
      setStudents(s);
    } catch (e) {
      setError(e instanceof AdminNotInstalled ? e.message : e instanceof Error ? e.message : 'Could not load usage');
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { if (access === 'admin') void load(); }, [access, load]);

  // ── Not signed in ──
  if (auth.loading || access === null) {
    return <Shell><p className="ml-admin-muted">Checking…</p></Shell>;
  }

  if (!auth.user) {
    return (
      <Shell>
        <p className="ml-admin-muted" style={{ marginBottom: 18 }}>
          Sign in with the owner account to continue.
        </p>
        {sent ? (
          <p className="ml-admin-note">Check your email for the sign-in link.</p>
        ) : (
          <form
            className="ml-admin-signin"
            onSubmit={async (e) => {
              e.preventDefault();
              const res = await auth.signInWithEmail(email.trim());
              if (res.error) setError(res.error); else setSent(true);
            }}
          >
            <input
              type="email" required value={email} placeholder="you@example.com"
              onChange={(e) => setEmail(e.target.value)} aria-label="Email"
            />
            <button type="submit">Send link</button>
          </form>
        )}
        {error && <p className="ml-admin-error">{error}</p>}
      </Shell>
    );
  }

  // ── The database side was never installed ──
  // Emphatically NOT "you do not have access". Telling the owner they lack
  // permission to their own platform sends them hunting a bug that is not
  // there; this is a setup step that has not been done.
  if (access === 'not-installed') {
    return (
      <Shell>
        <h2 className="ml-admin-setup-title">One setup step left</h2>
        <p className="ml-admin-muted" style={{ lineHeight: 1.6 }}>
          The admin functions are not in the database yet, so nothing can be read across tutors.
          Open Supabase → SQL Editor and run:
        </p>
        <code className="ml-admin-code">supabase/migrations/004_platform_admin.sql</code>
        <p className="ml-admin-muted" style={{ lineHeight: 1.6, marginTop: 14 }}>
          Step 2 of that file has an email in it — make sure it is
          <strong style={{ color: '#E2E8F0' }}> {auth.user.email}</strong>, the account you are signed
          in with right now. Then reload this page.
        </p>
        <button className="ml-admin-btn" style={{ marginTop: 18 }} onClick={() => window.location.reload()}>
          I have run it — check again
        </button>
      </Shell>
    );
  }

  if (access === 'error') {
    return (
      <Shell>
        <p className="ml-admin-muted">Could not reach the database to check access. Try again in a moment.</p>
        <button className="ml-admin-btn" style={{ marginTop: 16 }} onClick={() => window.location.reload()}>Retry</button>
      </Shell>
    );
  }

  // ── Signed in, installed, and genuinely not an admin ──
  // Says only that this account cannot see it. Whether an admin page has
  // anything in it, and who the admins are, is not this page's news to give.
  if (access !== 'admin') {
    return (
      <Shell>
        <p className="ml-admin-muted">
          This account ({auth.user.email}) does not have access.
        </p>
        <button className="ml-admin-btn" style={{ marginTop: 16 }} onClick={() => void auth.signOut()}>
          Sign out
        </button>
      </Shell>
    );
  }

  const totalLessons = tutors.reduce((n, t) => n + Number(t.lessons || 0), 0);
  const totalTaught = tutors.reduce((n, t) => n + Number(t.taught_seconds || 0), 0);
  const activeThisWeek = tutors.filter(t => activityStatus(t.last_signed_in) === 'active this week').length;

  return (
    <Shell wide>
      <div className="ml-admin-stats">
        <Stat label="Tutors" value={String(tutors.length)} />
        <Stat label="Active this week" value={String(activeThisWeek)} />
        <Stat label="Students" value={String(students.length)} />
        <Stat label="Lessons" value={String(totalLessons)} />
        <Stat label="Taught" value={totalTaught > 0 ? humanTeachingTime(totalTaught) : '—'} />
      </div>

      <div className="ml-admin-tabs">
        <button className={tab === 'tutors' ? 'is-on' : ''} onClick={() => setTab('tutors')}>Tutors</button>
        <button className={tab === 'students' ? 'is-on' : ''} onClick={() => setTab('students')}>Students</button>
        <div style={{ flex: 1 }} />
        <button className="ml-admin-btn" onClick={() => void load()} disabled={busy}>
          {busy ? 'Loading…' : 'Refresh'}
        </button>
        <button className="ml-admin-btn" onClick={() => void auth.signOut()}>Sign out</button>
      </div>

      {error && <p className="ml-admin-error">{error}</p>}

      {tab === 'tutors' ? (
        <div className="ml-admin-table-wrap">
          <table className="ml-admin-table">
            <thead>
              <tr>
                <th>Tutor</th><th>Status</th><th>Students</th><th>Lessons</th>
                <th>Last 30d</th><th>Last 7d</th><th>Taught</th><th>Last lesson</th><th>Joined</th>
              </tr>
            </thead>
            <tbody>
              {tutors.map(t => {
                const status = activityStatus(t.last_signed_in);
                return (
                  <tr key={t.user_id}>
                    <td className="ml-admin-strong">{t.email}</td>
                    <td><span className={`ml-admin-pill s-${status.replace(/\s+/g, '-')}`}>{status}</span></td>
                    <td>{t.students}</td>
                    <td>{t.lessons}</td>
                    <td>{t.lessons_30d}</td>
                    <td>{t.lessons_7d}</td>
                    <td>{humanTeachingTime(t.taught_seconds)}</td>
                    <td>{agoLabel(t.last_lesson)}</td>
                    <td>{new Date(t.signed_up).toLocaleDateString()}</td>
                  </tr>
                );
              })}
              {tutors.length === 0 && !busy && (
                <tr><td colSpan={9} className="ml-admin-muted">No tutors yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="ml-admin-table-wrap">
          <table className="ml-admin-table">
            <thead>
              <tr><th>Student</th><th>Tutor</th><th>Subject</th><th>Lessons</th><th>Taught</th><th>Last lesson</th><th>Room</th></tr>
            </thead>
            <tbody>
              {students.map(s => (
                <tr key={s.room_code}>
                  <td className="ml-admin-strong">{s.student_name}</td>
                  <td>{s.tutor_email}</td>
                  <td>{s.subject || '—'}</td>
                  <td>{s.lessons}</td>
                  <td>{humanTeachingTime(s.taught_seconds)}</td>
                  <td>{agoLabel(s.last_lesson)}</td>
                  <td className="ml-admin-mono">{s.room_code}</td>
                </tr>
              ))}
              {students.length === 0 && !busy && (
                <tr><td colSpan={7} className="ml-admin-muted">No students yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Said plainly rather than left for someone to discover by comparing
          two columns that disagree. */}
      <p className="ml-admin-note">
        “Taught” counts only time with a tutor and a student both in the room. Lessons taught
        before this was measured show “—” rather than zero.
      </p>
    </Shell>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="ml-admin-stat">
      <div className="ml-admin-stat-value">{value}</div>
      <div className="ml-admin-stat-label">{label}</div>
    </div>
  );
}

function Shell({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="ml-admin">
      <header className="ml-admin-header">
        <span className="ml-admin-mark">
          Maths<span>Live</span>
          <span className="ml-admin-badge">Admin</span>
        </span>
      </header>
      <main className="ml-admin-main" style={{ maxWidth: wide ? 1180 : 460 }}>
        {children}
      </main>
    </div>
  );
}
