import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { listClasses, createClass, deleteClass, touchClass, type ClassRow } from "../lib/classes";
import { listSessions, type SessionRow } from "../lib/sessions";
import { cleanDisplayName } from "../lib/displayName";

// Teacher hub: a private list of classes (one per student) with permanent
// links, plus create / open / delete. Only reachable when auth is enabled and
// the teacher is signed in; otherwise we bounce to the home screen.
export default function Dashboard() {
  const navigate = useNavigate();
  const auth = useAuth();

  const [rows, setRows] = useState<ClassRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [studentName, setStudentName] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  // Per-student session history (Stage 4): which class is expanded + its rows.
  const [historyOf, setHistoryOf] = useState<string | null>(null);
  const [sessionsByClass, setSessionsByClass] = useState<Record<string, SessionRow[]>>({});
  const [historyLoading, setHistoryLoading] = useState(false);

  // Guard: no auth / not signed in → home.
  useEffect(() => {
    if (auth.loading) return;
    if (!auth.enabled || !auth.user) navigate("/", { replace: true });
  }, [auth.enabled, auth.user, auth.loading, navigate]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(await listClasses());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load classes");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (auth.user) void refresh();
  }, [auth.user, refresh]);

  const teacherName = (() => {
    const meta = auth.user?.user_metadata as { full_name?: string; name?: string } | undefined;
    // Magic-link accounts have no profile name — the fallback used to be the
    // RAW EMAIL, which students then saw on the teacher's cursor, in chat and
    // in the participants list. cleanDisplayName turns it into a humane name.
    return meta?.full_name || meta?.name || cleanDisplayName(auth.user?.email) || "Teacher";
  })();

  const studentLink = (code: string) => `${window.location.origin}/live/${code}`;

  const handleCreate = async () => {
    const name = studentName.trim();
    if (!name || busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await createClass(name, label);
      setStudentName("");
      setLabel("");
      setRows((prev) => [created, ...prev]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create class");
    } finally {
      setBusy(false);
    }
  };

  const handleOpen = (row: ClassRow) => {
    // Best-effort recency stamp — must never delay opening the room
    // (awaiting it made the Open click visibly stall on slow networks).
    void touchClass(row.room_code);
    navigate(`/room/${row.room_code}?name=${encodeURIComponent(teacherName)}`);
  };

  const handleCopy = async (row: ClassRow) => {
    const link = studentLink(row.room_code);
    // navigator.clipboard is undefined on non-HTTPS origins (a common LAN
    // teaching setup) and the write can be permission-rejected — both used
    // to throw/reject unhandled while the UI still claimed "Copied!".
    let copied = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(link);
        copied = true;
      }
    } catch { copied = false; }
    if (!copied) {
      // Fallback: select-and-copy via a transient textarea (works on http).
      try {
        const ta = document.createElement('textarea');
        ta.value = link;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        copied = document.execCommand('copy');
        document.body.removeChild(ta);
      } catch { copied = false; }
    }
    if (copied) {
      setCopiedId(row.id);
      setTimeout(() => setCopiedId((id) => (id === row.id ? null : id)), 2000);
    } else {
      setError(`Couldn't copy automatically — the link is ${link}`);
    }
  };

  const handleDelete = async (row: ClassRow) => {
    if (!window.confirm(`Delete ${row.student_name}'s class? The link ${row.room_code} will stop working.`)) return;
    try {
      await deleteClass(row.id);
      setRows((prev) => prev.filter((r) => r.id !== row.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete class");
    }
  };

  const toggleHistory = async (row: ClassRow) => {
    if (historyOf === row.id) { setHistoryOf(null); return; }
    setHistoryOf(row.id);
    if (!sessionsByClass[row.id]) {
      setHistoryLoading(true);
      try {
        const list = await listSessions(row.id);
        setSessionsByClass((prev) => ({ ...prev, [row.id]: list }));
      } catch {
        setSessionsByClass((prev) => ({ ...prev, [row.id]: [] }));
      } finally {
        setHistoryLoading(false);
      }
    }
  };

  // Reopen a saved session: the room hydrates HTML + whiteboard from ?session.
  const reopenSession = (row: ClassRow, s: SessionRow) => {
    navigate(`/room/${row.room_code}?name=${encodeURIComponent(teacherName)}&session=${s.id}`);
  };

  const fmtDate = (iso: string) => {
    try { return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
    catch { return iso; }
  };

  return (
    <div className="ml-dark-home">
      <div className="ml-dark-stage">
        {/* Top bar */}
        <header className="ml-dark-topbar">
          <div className="ml-dark-brand">
            <span className="ml-dark-brandmark" aria-hidden="true">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 18l6-12 4 8 6-4" />
              </svg>
            </span>
            <span className="ml-dark-wordmark">
              Maths<span className="accent">Live</span>
            </span>
          </div>
          <button className="ml-dark-btn ml-dark-btn-ghost" onClick={() => auth.signOut()}>
            Sign out{auth.user?.email ? ` (${auth.user.email})` : ""}
          </button>
        </header>

        <div className="ml-dark-center">
          <h1 className="ml-dark-headline">Your classes</h1>

          {/* Create a class for a student */}
          <div className="ml-dark-form" style={{ marginBottom: 20 }}>
            <input
              className="ml-dark-input"
              placeholder="Student name — e.g. Drihan"
              value={studentName}
              onChange={(e) => setStudentName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            />
            <input
              className="ml-dark-input"
              placeholder="Subject / note (optional) — e.g. Algebra"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            />
            <button
              className="ml-dark-btn ml-dark-btn-primary"
              onClick={handleCreate}
              disabled={!studentName.trim() || busy}
              title={!studentName.trim() ? "Enter a student name first" : busy ? "Creating class..." : undefined}
              style={{ width: "100%" }}
            >
              {busy ? "Creating…" : "Create class"}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
          </div>

          {error && (
            <p style={{ color: "#F87171", fontSize: 13, textAlign: "center", marginBottom: 12 }}>{error}</p>
          )}

          {/* Class list */}
          {loading ? (
            <p style={{ opacity: 0.7, textAlign: "center" }}>Loading…</p>
          ) : rows.length === 0 ? (
            <p style={{ opacity: 0.7, textAlign: "center", lineHeight: 1.6 }}>
              No classes yet. Create one above — you'll get a permanent link to
              share with that student.
            </p>
          ) : (
            <ul className="ml-dark-saved-list">
              {rows.map((row) => (
                <React.Fragment key={row.id}>
                <li className="ml-dark-saved-item">
                  <button
                    className="ml-dark-saved-open"
                    onClick={() => handleOpen(row)}
                    title={`Open ${row.student_name}'s room`}
                  >
                    <span className="ml-dark-saved-label">
                      {row.student_name}
                      {row.label ? ` · ${row.label}` : ""}
                    </span>
                    <span className="ml-dark-saved-meta">/live/{row.room_code}</span>
                  </button>
                  <button
                    className="ml-dark-btn ml-dark-btn-glass"
                    onClick={() => handleCopy(row)}
                    title="Copy the student's permanent link"
                  >
                    {copiedId === row.id ? "Copied!" : "Copy link"}
                  </button>
                  <button
                    className="ml-dark-btn ml-dark-btn-glass"
                    onClick={() => toggleHistory(row)}
                    title="Past sessions for this student"
                  >
                    {historyOf === row.id ? "Hide history" : "History"}
                  </button>
                  <button
                    className="ml-dark-saved-remove"
                    onClick={() => handleDelete(row)}
                    aria-label={`Delete ${row.student_name}'s class`}
                    title="Delete this class"
                  >
                    ×
                  </button>
                </li>
                {historyOf === row.id && (
                  <li style={{ listStyle: "none", padding: "8px 12px", background: "rgba(255,255,255,0.04)", borderRadius: 8, margin: "2px 0 8px" }}>
                    {historyLoading && !sessionsByClass[row.id] ? (
                      <div style={{ opacity: 0.7, fontSize: 13 }}>Loading…</div>
                    ) : (sessionsByClass[row.id]?.length ?? 0) === 0 ? (
                      <div style={{ opacity: 0.7, fontSize: 13, lineHeight: 1.5 }}>
                        No saved sessions yet. Open the room and use “💾 Save to history”.
                      </div>
                    ) : (
                      <ul style={{ display: "flex", flexDirection: "column", gap: 4, margin: 0, padding: 0 }}>
                        {sessionsByClass[row.id]!.map((s) => (
                          <li key={s.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, listStyle: "none" }}>
                            <span style={{ fontSize: 13 }}>
                              <strong>{s.topic || "Session"}</strong>
                              <span style={{ opacity: 0.6, marginLeft: 8 }}>{fmtDate(s.started_at)}</span>
                            </span>
                            <button className="ml-dark-btn ml-dark-btn-glass" onClick={() => reopenSession(row, s)}>
                              Reopen
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                )}
                </React.Fragment>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
