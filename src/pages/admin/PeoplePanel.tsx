import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  listPeople, getPerson, grantFreeAccess, revokeFreeAccess, setAccountStatus, addAdminNote,
  agoLabel, type AdminPerson, type AdminPersonDetail,
} from '../../lib/admin';

// The half of /admin that does something.
//
// PLAN.md task 2.10, and the line in the founder's brief that has never had an
// implementation: "I and anyone I hand-pick get full access free forever."
// Until now the only ways to do that were to make somebody a platform admin —
// which also hands them every other teacher's data — or to push paid_until
// forward with SQL on the box, which is what was done for Vani on 2 September
// and left no record of the decision anywhere but a chat log.
//
// Written as its own file rather than a sixth branch inside AdminView, which is
// already 482 lines and is the page most likely to keep growing.
//
// Every button here is a request the server will refuse unless the caller holds
// the permission. `can` only decides what to render: a disabled button is a
// courtesy to the person clicking, never a control.

function pill(state: string): string {
  if (state === 'admin') return 'b-active';
  if (state === 'active') return 'b-active';
  if (state === 'trial') return 'b-trial';
  if (state === 'grace') return 'b-grace';
  return 'b-expired';
}

export default function PeoplePanel({ can }: { can: (p: string) => boolean }) {
  const [q, setQ] = useState('');
  const [people, setPeople] = useState<AdminPerson[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AdminPersonDetail | null>(null);
  const [acting, setActing] = useState(false);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');

  const load = useCallback(async (query: string) => {
    setBusy(true); setError(null);
    try { setPeople((await listPeople(query)).people); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not load accounts'); }
    finally { setBusy(false); }
  }, []);

  useEffect(() => { void load(''); }, [load]);

  const openDetail = useCallback(async (id: string) => {
    setOpenId(id); setDetail(null); setReason(''); setNote('');
    try { setDetail(await getPerson(id)); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not open that account'); }
  }, []);

  /** Run an action, then refresh both the row and the list behind it. */
  const act = useCallback(async (fn: () => Promise<unknown>) => {
    if (!openId) return;
    setActing(true); setError(null);
    try {
      await fn();
      setDetail(await getPerson(openId));
      await load(q);
      setReason('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not work');
    } finally { setActing(false); }
  }, [openId, load, q]);

  const search = (e: FormEvent) => { e.preventDefault(); void load(q); };
  const u = detail?.user;
  const hasLiveGrant = !!u?.grant_active;

  return (
    <div>
      <form onSubmit={search} className="ml-admin-search">
        <input
          className="ml-dark-input"
          placeholder="Search by email…"
          value={q}
          onChange={e => setQ(e.target.value)}
          aria-label="Search accounts by email"
        />
        <button className="ml-admin-btn" type="submit" disabled={busy}>
          {busy ? 'Searching…' : 'Search'}
        </button>
        {q && (
          <button type="button" className="ml-admin-btn" onClick={() => { setQ(''); void load(''); }}>
            Clear
          </button>
        )}
      </form>

      {error && <p className="ml-admin-error">{error}</p>}

      <div className="ml-admin-table-wrap">
        <table className="ml-admin-table">
          <thead>
            <tr>
              <th>Account</th><th>Access</th><th>Learners</th><th>Lessons</th>
              <th>Last lesson</th><th>Last seen</th><th></th>
            </tr>
          </thead>
          <tbody>
            {people.map(p => (
              <tr key={p.id} className={p.status === 'suspended' ? 'ml-row-urgent' : ''}>
                <td className="ml-admin-strong">
                  {p.email}
                  {p.role !== 'teacher' && <span className="ml-bill-pill b-active" style={{ marginLeft: 8 }}>{p.role.replace('_', ' ')}</span>}
                  {p.status === 'suspended' && <span className="ml-bill-pill b-expired" style={{ marginLeft: 8 }}>suspended</span>}
                </td>
                <td>
                  <span className={`ml-bill-pill ${pill(p.access.state)}`}>
                    {p.grant_active ? (p.grant_until ? 'free until' : 'free forever') : p.access.state}
                  </span>
                </td>
                <td className="ml-admin-mono">{p.learners}</td>
                <td className="ml-admin-mono">{p.lessons}</td>
                <td className="ml-admin-mono">{p.last_lesson ? agoLabel(p.last_lesson) : '—'}</td>
                <td className="ml-admin-mono">{p.last_login_at ? agoLabel(p.last_login_at) : 'never'}</td>
                <td>
                  <button className="ml-admin-btn" onClick={() => void openDetail(p.id)}>Open</button>
                </td>
              </tr>
            ))}
            {people.length === 0 && !busy && (
              <tr><td colSpan={7} className="ml-admin-muted">No account matches that.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {openId && (
        <div className="ml-admin-drawer">
          <div className="ml-admin-drawer-head">
            <strong>{u?.email ?? 'Loading…'}</strong>
            <button className="ml-admin-btn" onClick={() => { setOpenId(null); setDetail(null); }}>Close</button>
          </div>

          {!detail ? <p className="ml-admin-muted">Reading the account…</p> : (
            <>
              <p className="ml-admin-muted">
                {u!.learners} learners · {u!.lessons} lessons · joined {new Date(u!.created_at).toLocaleDateString()}
                {u!.status === 'suspended' && u!.status_reason ? ` · suspended: ${u!.status_reason}` : ''}
              </p>

              {/* One box, because both actions need the same sentence and it is
                  the only part of a decision that cannot be reconstructed. */}
              <label className="ml-field-label" htmlFor="admin-reason">Reason (kept in the audit log)</label>
              <input
                id="admin-reason"
                className="ml-dark-input"
                value={reason}
                onChange={e => setReason(e.target.value)}
                placeholder="Why are you doing this?"
              />

              <div className="ml-admin-drawer-actions">
                {can('billing.grant') && (hasLiveGrant ? (
                  <button className="ml-admin-btn" disabled={acting}
                    onClick={() => void act(() => revokeFreeAccess(openId, reason))}>
                    Revoke free access
                  </button>
                ) : (
                  <button className="ml-admin-btn" disabled={acting || !reason.trim()}
                    title={!reason.trim() ? 'Say why first' : 'Free forever, until you revoke it'}
                    onClick={() => void act(() => grantFreeAccess(openId, reason, null))}>
                    Give free access, forever
                  </button>
                ))}

                {can('users.manage') && u!.role !== 'super_admin' && (
                  u!.status === 'suspended' ? (
                    <button className="ml-admin-btn" disabled={acting}
                      onClick={() => void act(() => setAccountStatus(openId, 'active', reason))}>
                      Un-suspend
                    </button>
                  ) : (
                    <button className="ml-admin-btn ml-admin-danger" disabled={acting || !reason.trim()}
                      title={!reason.trim() ? 'Say why first' : 'Signs them out everywhere and refuses the teacher seat'}
                      onClick={() => void act(() => setAccountStatus(openId, 'suspended', reason))}>
                      Suspend
                    </button>
                  )
                )}
              </div>

              {hasLiveGrant && (
                <p className="ml-admin-muted">
                  Free {u!.grant_until ? `until ${new Date(u!.grant_until).toLocaleDateString()}` : 'forever'}
                  {u!.grant_reason ? ` — ${u!.grant_reason}` : ''}
                </p>
              )}

              <h4 className="ml-admin-note">Notes</h4>
              <form
                onSubmit={e => { e.preventDefault(); if (!note.trim()) return; void act(async () => { await addAdminNote(openId, note); setNote(''); }); }}
                className="ml-admin-search"
              >
                <input className="ml-dark-input" value={note} onChange={e => setNote(e.target.value)}
                  placeholder="What you worked out about this account" aria-label="Add a note" />
                <button className="ml-admin-btn" type="submit" disabled={acting || !note.trim()}>Save</button>
              </form>
              <ul className="ml-admin-list">
                {detail.notes.map(n => (
                  <li key={n.id}>
                    <span className="ml-admin-mono">{new Date(n.created_at).toLocaleDateString()}</span> — {n.note}
                  </li>
                ))}
                {detail.notes.length === 0 && <li className="ml-admin-muted">Nothing written down yet.</li>}
              </ul>

              <h4 className="ml-admin-note">What has been done to this account</h4>
              <ul className="ml-admin-list">
                {detail.audit.map(a => (
                  <li key={a.id}>
                    <span className="ml-admin-mono">{new Date(a.at).toLocaleString()}</span>
                    {' '}<strong>{a.action}</strong>{a.reason ? ` — ${a.reason}` : ''}
                  </li>
                ))}
                {detail.audit.length === 0 && <li className="ml-admin-muted">Nothing yet.</li>}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
