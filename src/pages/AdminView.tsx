import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useAuth } from '../lib/auth';
import {
  checkAdminAccess, fetchTutorUsage, fetchStudentUsage, activityStatus, agoLabel,
  AdminNotInstalled, getOverview, getRenewals, getLiveRooms, untilLabel,
  type TutorUsage, type StudentUsage, type AdminAccess,
  type Overview, type Renewal, type LiveRoom,
} from '../lib/admin';
import { humanTeachingTime } from '../lib/teachingTime';
import { listClaims, confirmClaim, rejectClaim, type ClaimRow } from '../lib/billing';
import { lazy, Suspense } from 'react';
import { getAdminCapabilities } from '../lib/admin';
const PeoplePanel = lazy(() => import('./admin/PeoplePanel'));
const AuditPanel = lazy(() => import('./admin/AuditPanel'));
const ClassDataPanel = lazy(() => import('./admin/ClassDataPanel'));

// MathsLive Admin — who is using the platform.
//
// A separate surface with its own identity, not a tab on the tutor dashboard:
// nothing here belongs to a tutor, and mixing the two invites the mistake of
// showing one tutor another's students.
//
// This page hiding itself from non-admins is a COURTESY, not the control. The
// control is in Postgres (migration 004): the RPCs behind this refuse anyone
// not listed in platform_admins, so calling them by hand gets you nothing.

type Tab = 'money' | 'tutors' | 'students' | 'payments' | 'live' | 'people' | 'audit' | 'data';

export default function AdminView() {
  const auth = useAuth();
  const [access, setAccess] = useState<AdminAccess | null>(null);
  const [tab, setTab] = useState<Tab>('money');
  const [tutors, setTutors] = useState<TutorUsage[]>([]);
  const [students, setStudents] = useState<StudentUsage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [claims, setClaims] = useState<ClaimRow[]>([]);
  const [claimBusy, setClaimBusy] = useState<string | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [renewals, setRenewals] = useState<Renewal[]>([]);
  const [live, setLive] = useState<LiveRoom[]>([]);
  const [graceDays, setGraceDays] = useState(3);
  // What this signed-in person may do. Used ONLY to decide what to render —
  // every route re-checks it in the database, so hiding a button is a courtesy
  // to whoever is clicking and never the control.
  const [perms, setPerms] = useState<string[]>([]);
  const can = useCallback((p: string) => perms.includes(p), [perms]);

  useEffect(() => {
    if (!auth.user) return;
    let stop = false;
    void getAdminCapabilities()
      .then(c => { if (!stop) setPerms(c.permissions || []); })
      .catch(() => { /* the tabs simply stay read-only */ });
    return () => { stop = true; };
  }, [auth.user]);

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

  const loadClaims = useCallback(async () => {
    try { setClaims((await listClaims()).claims); }
    catch { /* the rest of admin still works without this */ }
  }, []);
  useEffect(() => { if (access === 'admin') void loadClaims(); }, [access, loadClaims]);

  const loadBusiness = useCallback(async () => {
    // Settled, not all: the revenue figures are the point of this screen and
    // must survive a renewals or live-rooms failure.
    const [o, r] = await Promise.allSettled([getOverview(), getRenewals()]);
    if (o.status === 'fulfilled') setOverview(o.value);
    if (r.status === 'fulfilled') { setRenewals(r.value.renewals); setGraceDays(r.value.graceDays); }
  }, []);
  useEffect(() => { if (access === 'admin') void loadBusiness(); }, [access, loadBusiness]);

  // Who is teaching right now, refreshed while the tab is open. Cheap: it is
  // read from the server's memory, never the database.
  const loadLive = useCallback(async () => {
    try { setLive((await getLiveRooms()).rooms); } catch { /* panel stays as it was */ }
  }, []);
  useEffect(() => {
    if (access !== 'admin') return;
    void loadLive();
    if (tab !== 'live') return;
    const t = setInterval(() => { void loadLive(); }, 10_000);
    return () => clearInterval(t);
  }, [access, tab, loadLive]);

  const decide = async (id: string, yes: boolean) => {
    setClaimBusy(id);
    setError(null);
    try {
      if (yes) await confirmClaim(id); else await rejectClaim(id);
      await loadClaims();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update that payment.');
    } finally { setClaimBusy(null); }
  };

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

      {tab === 'people' && (
        <Suspense fallback={<p className="ml-admin-muted">Loading…</p>}>
          <PeoplePanel can={can} />
        </Suspense>
      )}

      {tab === 'audit' && (
        <Suspense fallback={<p className="ml-admin-muted">Loading…</p>}>
          <AuditPanel />
        </Suspense>
      )}

      {tab === 'data' && (
        <Suspense fallback={<p className="ml-admin-muted">Loading…</p>}>
          <ClassDataPanel can={can} />
        </Suspense>
      )}
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
          On the server, add your email to the admin list:
        </p>
        <code className="ml-admin-code">INSERT INTO platform_admins (email) VALUES ('you@example.com');</code>
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
  const openClaims = claims.filter(c => !c.confirmed_at && !c.rejected_at).length;

  return (
    <Shell wide>
      {/* The business first. Usage is interesting; revenue is what decides
          whether there is a company, so it reads before anything else. */}
      <div className="ml-admin-stats">
        <Stat label="Monthly revenue" value={overview ? `₹${overview.mrr.toLocaleString('en-IN')}` : '—'} tone="money" />
        <Stat label="Paying" value={overview ? String(overview.paying) : '—'} tone="money" />
        <Stat label="On trial" value={overview ? String(overview.trialing) : '—'} />
        <Stat label="Expiring ≤7d" value={overview ? String(overview.expiring_7d + overview.trials_ending_3d) : '—'}
              tone={overview && (overview.expiring_7d + overview.trials_ending_3d) > 0 ? 'warn' : undefined} />
        <Stat label="Awaiting confirm" value={overview ? String(overview.claims_pending) : '—'}
              tone={overview && overview.claims_pending > 0 ? 'warn' : undefined} />
        <Stat label="In grace" value={overview ? String(overview.in_grace) : '—'}
              tone={overview && overview.in_grace > 0 ? 'warn' : undefined} />
        <Stat label="Lapsed" value={overview ? String(overview.expired) : '—'} />
        <Stat label="Teaching now" value={String(live.length)} tone={live.length > 0 ? 'live' : undefined} />
      </div>
      <div className="ml-admin-stats ml-admin-stats-sub">
        <Stat label="Collected, all time" value={overview ? `₹${overview.collected_total.toLocaleString('en-IN')}` : '—'} />
        <Stat label="This month" value={overview ? `₹${overview.collected_month.toLocaleString('en-IN')}` : '—'} />
        <Stat label="Tutors" value={String(tutors.length)} />
        <Stat label="Students" value={String(students.length)} />
        <Stat label="Lessons today" value={overview ? String(overview.lessons_today) : '—'} />
        <Stat label="Lessons, 7d" value={overview ? String(overview.lessons_7d) : '—'} />
        <Stat label="Taught" value={totalTaught > 0 ? humanTeachingTime(totalTaught) : '—'} />
      </div>

      <div className="ml-admin-tabs">
        <button className={tab === 'money' ? 'is-on' : ''} onClick={() => setTab('money')}>Renewals</button>
        <button className={tab === 'tutors' ? 'is-on' : ''} onClick={() => setTab('tutors')}>Tutors</button>
        <button className={tab === 'students' ? 'is-on' : ''} onClick={() => setTab('students')}>Students</button>
        <button className={tab === 'payments' ? 'is-on' : ''} onClick={() => setTab('payments')}>
          Payments{openClaims > 0 ? ` (${openClaims})` : ''}
        </button>
        <button className={tab === 'live' ? 'is-on' : ''} onClick={() => setTab('live')}>
          Live{live.length > 0 ? ` (${live.length})` : ''}
        </button>
        <button className={tab === 'people' ? 'is-on' : ''} onClick={() => setTab('people')}>People</button>
        <button className={tab === 'audit' ? 'is-on' : ''} onClick={() => setTab('audit')}>Audit</button>
        <button className={tab === 'data' ? 'is-on' : ''} onClick={() => setTab('data')}>Class data</button>
        <div style={{ flex: 1 }} />
        <button className="ml-admin-btn" onClick={() => { void load(); void loadBusiness(); void loadClaims(); void loadLive(); }} disabled={busy}>
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
                <th>Tutor</th><th>Billing</th><th>Renews</th><th>Status</th><th>Students</th><th>Lessons</th>
                <th>Last 30d</th><th>Last 7d</th><th>Taught</th><th>Last lesson</th><th>Joined</th>
              </tr>
            </thead>
            <tbody>
              {tutors.map(t => {
                const status = activityStatus(t.last_signed_in);
                return (
                  <tr key={t.user_id}>
                    <td className="ml-admin-strong">{t.email}</td>
                    <td><span className={`ml-bill-pill b-${t.billing.state}`}>
                      {t.billing.state === 'active' ? 'paid'
                        : t.billing.state === 'admin' ? 'admin'
                        : t.billing.state === 'trial' ? `trial · ${t.billing.daysLeft}d`
                        : t.billing.state === 'grace' ? `grace · ${t.billing.daysLeft}d` : 'lapsed'}
                    </span></td>
                    <td className="ml-admin-mono">{t.billing.state === 'admin' ? '—' : untilLabel(t.billing.until).text}</td>
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
                <tr><td colSpan={11} className="ml-admin-muted">No tutors yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      ) : tab === 'students' ? (
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
      ) : null}

      {tab === 'money' && (
        <div className="ml-admin-table-wrap">
          <table className="ml-admin-table">
            <thead>
              <tr>
                <th>Tutor</th><th>On</th><th>Ends</th><th>When</th>
                <th>Students</th><th>Last lesson</th><th>Payments</th><th></th>
              </tr>
            </thead>
            <tbody>
              {renewals.map(r => {
                const u = untilLabel(r.ends_at);
                // Past the end but inside the grace window is still teaching,
                // and reads differently from genuinely lost.
                const past = u.days !== null && u.days < 0;
                const inGrace = past && Math.abs(u.days!) <= graceDays;
                const lapsed = past && !inGrace;
                return (
                  <tr key={r.id} className={u.urgent ? 'ml-row-urgent' : ''}>
                    <td className="ml-admin-strong">{r.email}</td>
                    <td><span className={`ml-bill-pill b-${lapsed ? 'expired' : inGrace ? 'grace' : r.kind === 'paid' ? 'active' : 'trial'}`}>
                      {lapsed ? 'lapsed' : inGrace ? 'grace' : r.kind === 'paid' ? 'paid' : 'trial'}
                    </span></td>
                    <td className="ml-admin-mono">
                      {r.ends_at ? new Date(r.ends_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '—'}
                    </td>
                    <td className={`ml-admin-mono${u.urgent ? ' ml-urgent' : ''}`}>{u.text}</td>
                    <td>{r.students}</td>
                    <td>{agoLabel(r.last_lesson)}</td>
                    <td>{r.payments || '—'}</td>
                    <td>{r.claim_pending && <span className="ml-bill-pill b-pending">confirm</span>}</td>
                  </tr>
                );
              })}
              {renewals.length === 0 && (
                <tr><td colSpan={8} className="ml-admin-muted">No tutors yet.</td></tr>
              )}
            </tbody>
          </table>
          <p className="ml-admin-note">
            Sorted by the date each tutor runs out — the order to work through them in.
            “Lapsed” means they cannot take the teacher seat until they pay; their students and
            classes are untouched.
          </p>
        </div>
      )}

      {tab === 'live' && (
        <div className="ml-claims">
          {live.length === 0 && (
            <p className="ml-admin-muted">Nobody is teaching right now.</p>
          )}
          {live.map(r => (
            <div key={r.roomId} className="ml-claim ml-live-room">
              <span className="ml-live-dot" aria-hidden="true" />
              <div className="ml-claim-main">
                <span className="ml-claim-who">
                  {r.teacher || 'No teacher in the seat'}
                  {r.students.length > 0 && <span className="ml-live-with"> with {r.students.join(', ')}</span>}
                </span>
                <span className="ml-claim-meta">
                  /live/{r.roomId} · open {humanTeachingTime(Math.round((Date.now() - r.startedAt) / 1000))}
                  {r.paused && ' · paused'}
                </span>
                {/* The name is typed by whoever is sitting there; the device id
                    is not. It answers the question a name cannot — is this the
                    same machine as last time, and are these two the same one? */}
                <span className="ml-claim-meta">
                  device {r.teacherDevice ? r.teacherDevice.slice(0, 6) : '—'}
                  {r.studentDevices.length > 0 &&
                    ' · student ' + r.studentDevices.map(d => d.slice(0, 6)).join(', ')}
                </span>
              </div>
              {r.waiting
                ? <span className="ml-bill-pill b-pending">waiting for a teacher</span>
                : <span className="ml-claim-done">{r.students.length} student{r.students.length === 1 ? '' : 's'}</span>}
            </div>
          ))}
          <p className="ml-admin-note">
            Read from the server’s memory, not the database, and refreshed every 10 seconds while
            this tab is open. Names only — no board, lesson or chat content leaves the server.
          </p>
        </div>
      )}

      {tab === 'payments' && (
        <div className="ml-claims">
          {claims.length === 0 && (
            <p className="ml-admin-muted">No payments yet.</p>
          )}
          {claims.map(c => {
            const open = !c.confirmed_at && !c.rejected_at;
            return (
              <div key={c.id} className={`ml-claim${open ? ' ml-claim-open' : ''}`}>
                <div className="ml-claim-main">
                  <span className="ml-claim-who">{c.teacher_email}</span>
                  <span className="ml-claim-meta">
                    &#8377;{c.amount_rupees} &middot; {c.months} month{c.months === 1 ? '' : 's'}
                    {' '}&middot; ref {c.reference || '—'}
                    {' '}&middot; {new Date(c.claimed_at).toLocaleString()}
                  </span>
                  {c.note && <span className="ml-admin-muted">{c.note}</span>}
                </div>
                {open ? (
                  <>
                    <button
                      className="ml-admin-btn"
                      disabled={claimBusy === c.id}
                      onClick={() => void decide(c.id, true)}
                    >
                      {claimBusy === c.id ? 'Working…' : 'Confirm'}
                    </button>
                    <button
                      className="ml-admin-btn"
                      disabled={claimBusy === c.id}
                      onClick={() => void decide(c.id, false)}
                    >
                      Reject
                    </button>
                  </>
                ) : (
                  <span className="ml-claim-done">
                    {c.confirmed_at
                      ? `Confirmed ✓ — paid until ${c.paid_until ? new Date(c.paid_until).toLocaleDateString() : '—'}`
                      : 'Rejected'}
                  </span>
                )}
              </div>
            );
          })}
          <p className="ml-admin-note">
            Confirming adds the months to that teacher&rsquo;s account, counting from whichever
            is later — today, or the date they already had. Paying early never costs them days.
          </p>
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

/**
 * One number on the strip.
 *
 * `tone` encodes meaning, not decoration: money is the figure the business is
 * steered by, warn is a number that means someone must act today, and live is
 * something happening right now. A number that needs attention should read as
 * needing attention without being counted first.
 */
function Stat({ label, value, tone }: { label: string; value: string; tone?: 'money' | 'warn' | 'live' }) {
  return (
    <div className={`ml-admin-stat${tone ? ` t-${tone}` : ''}`}>
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
