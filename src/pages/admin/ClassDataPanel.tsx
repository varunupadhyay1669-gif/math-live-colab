import { useCallback, useEffect, useState } from 'react';

// "Clear data of the classes, and select date."
//
// The button that means a production database never has to be opened by hand to
// free space. That is the actual safety argument for it: the alternative is not
// "nothing happens", it is somebody typing DELETE at speed against the live
// database at the end of a long day.
//
// Two rules it exists to hold on to:
//
//   1. The STUDENTS are not class data. Their names, grades, goals and room
//      codes live in a different table and nothing here can reach it. Losing
//      them would mean re-adding every student and reissuing every link.
//   2. Nothing is deleted before the numbers are shown. The preview uses the
//      very same condition as the delete, so the count in front of you is the
//      count that goes — a confirmation showing anything else is a lie with a
//      button attached.
//
// Deliberately no "undo". There is a nightly database backup and a manual dump
// taken before the first wipe; an undo button here would need a copy of
// everything it deletes, which is exactly the storage this feature exists to
// reclaim.

interface Counts { rooms: number; boardImages: number; sessions: number }

export default function ClassDataPanel({ can }: { can: (p: string) => boolean }) {
  const allowed = can('users.manage');
  // Empty means "everything". A date means "older than this".
  const [before, setBefore] = useState('');
  const [counts, setCounts] = useState<Counts | null>(null);
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);
  const [done, setDone] = useState<Counts | null>(null);
  const [error, setError] = useState<string | null>(null);

  const preview = useCallback(async () => {
    setBusy(true); setError(null); setDone(null);
    try {
      const q = before ? `?before=${encodeURIComponent(new Date(before).toISOString())}` : '';
      const r = await fetch(`/api/admin/class-data${q}`, { credentials: 'include' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Could not read the counts.');
      setCounts(j.counts);
    } catch (e) {
      setError((e as Error).message); setCounts(null);
    } finally {
      setBusy(false);
    }
  }, [before]);

  // Re-count whenever the date changes, so the numbers on screen always belong
  // to the date in the box. A stale count beside a changed date is how the
  // wrong thing gets deleted with the right number showing.
  useEffect(() => { setArmed(false); void preview(); }, [preview]);

  const clear = async () => {
    setBusy(true); setError(null);
    try {
      const r = await fetch('/api/admin/class-data/clear', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          confirm: true,
          before: before ? new Date(before).toISOString() : undefined,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Could not clear the data.');
      setDone(j.counts); setArmed(false);
      void preview();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!allowed) {
    return <p className="ml-admin-muted">You do not have permission to clear class data.</p>;
  }

  const total = counts ? counts.rooms + counts.boardImages + counts.sessions : 0;

  return (
    <div className="ml-admin-card" style={{ maxWidth: 640 }}>
      <h3 style={{ marginTop: 0 }}>Clear class data</h3>
      <p className="ml-admin-muted" style={{ marginTop: 0 }}>
        Removes saved boards, whiteboard pictures and lesson records.
        <b> Students, their names and their links are not touched.</b>
      </p>

      <label style={{ display: 'block', margin: '14px 0 6px', fontWeight: 600 }}>
        Delete everything older than
      </label>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          type="date"
          value={before}
          max={new Date().toISOString().slice(0, 10)}
          onChange={(e) => setBefore(e.target.value)}
          className="ml-admin-input"
          aria-label="Delete class data older than this date"
        />
        {before && (
          <button className="ml-admin-btn" onClick={() => setBefore('')}>
            Clear date
          </button>
        )}
      </div>
      <p className="ml-admin-muted" style={{ marginTop: 6, fontSize: 12 }}>
        {before
          ? `Anything from before ${new Date(before).toLocaleDateString()} goes. Everything after it stays.`
          : 'No date set — this will delete ALL class data, however recent.'}
      </p>

      {error && <p className="ml-admin-error">{error}</p>}

      {counts && (
        <div style={{ margin: '14px 0', padding: '10px 14px', borderRadius: 10, background: 'rgba(255,255,255,0.04)' }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>
            {total === 0 ? 'Nothing to delete.' : `${total} thing${total === 1 ? '' : 's'} would be deleted:`}
          </div>
          <div className="ml-admin-muted" style={{ fontSize: 13, lineHeight: 1.7 }}>
            {counts.rooms} saved board{counts.rooms === 1 ? '' : 's'}<br />
            {counts.sessions} lesson record{counts.sessions === 1 ? '' : 's'}<br />
            {counts.boardImages} whiteboard picture{counts.boardImages === 1 ? '' : 's'}
            {' '}<span style={{ opacity: 0.7 }}>(only those no remaining board still uses)</span>
          </div>
        </div>
      )}

      {done && (
        <p style={{ color: '#34d399', fontWeight: 600 }}>
          Deleted {done.rooms} board{done.rooms === 1 ? '' : 's'}, {done.sessions} lesson
          record{done.sessions === 1 ? '' : 's'} and {done.boardImages} picture
          {done.boardImages === 1 ? '' : 's'}. Students untouched.
        </p>
      )}

      {/* Two presses, and the second one says what it is about to do. A single
          red button next to a date field is one slip away from erasing a term. */}
      {!armed ? (
        <button
          className="ml-admin-btn"
          disabled={busy || total === 0}
          onClick={() => setArmed(true)}
          style={{ background: '#b91c1c', color: '#fff', borderColor: '#b91c1c' }}
        >
          {busy ? 'Working…' : 'Clear this data'}
        </button>
      ) : (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 700 }}>
            Delete {total} item{total === 1 ? '' : 's'}
            {before ? ` from before ${new Date(before).toLocaleDateString()}` : ' — ALL class data'}?
            This cannot be undone.
          </span>
          <button
            className="ml-admin-btn"
            disabled={busy}
            onClick={() => void clear()}
            style={{ background: '#b91c1c', color: '#fff', borderColor: '#b91c1c' }}
          >
            {busy ? 'Deleting…' : 'Yes, delete'}
          </button>
          <button className="ml-admin-btn" disabled={busy} onClick={() => setArmed(false)}>Cancel</button>
        </div>
      )}
    </div>
  );
}
