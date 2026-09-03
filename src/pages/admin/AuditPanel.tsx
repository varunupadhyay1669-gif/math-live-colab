import { useEffect, useState } from 'react';
import { getAuditLog, type AuditEntryRow } from '../../lib/admin';

// Everything an admin has done, in one list.
//
// There was no such list. The only trace of any admin action anywhere was
// payment_claims.confirmed_by, and /api/admin/grant — which hands a teacher
// months of the product for nothing — recorded nothing at all.
//
// It matters most for the actions nobody remembers taking: a grant given in a
// hurry, an account suspended during a support conversation, a decision made
// six months ago that now looks strange. The reason column is the part that
// cannot be reconstructed from the database afterwards, which is why the
// server refuses to record a grant or a suspension without one.
export default function AuditPanel() {
  const [entries, setEntries] = useState<AuditEntryRow[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    getAuditLog()
      .then(r => { if (!stop) setEntries(r.entries); })
      .catch(e => { if (!stop) setError(e instanceof Error ? e.message : 'Could not read the audit log'); })
      .finally(() => { if (!stop) setBusy(false); });
    return () => { stop = true; };
  }, []);

  if (busy) return <p className="ml-admin-muted">Reading the log…</p>;
  if (error) return <p className="ml-admin-error">{error}</p>;

  return (
    <div className="ml-admin-table-wrap">
      <table className="ml-admin-table">
        <thead>
          <tr><th>When</th><th>Who</th><th>Did</th><th>To</th><th>Why</th></tr>
        </thead>
        <tbody>
          {entries.map(e => (
            <tr key={e.id}>
              <td className="ml-admin-mono">{new Date(e.at).toLocaleString()}</td>
              <td>{e.actor_email ?? <span className="ml-admin-muted">system</span>}</td>
              <td className="ml-admin-strong">{e.action}</td>
              <td>{e.target_email ?? (e.target_id ? <span className="ml-admin-mono">{e.target_id}</span> : '—')}</td>
              <td>{e.reason ?? <span className="ml-admin-muted">—</span>}</td>
            </tr>
          ))}
          {entries.length === 0 && (
            <tr>
              <td colSpan={5} className="ml-admin-muted">
                Nothing has been done yet — which is the correct state for a log that only started recording today.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
