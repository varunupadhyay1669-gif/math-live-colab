import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { listClasses, createClass, deleteClass, touchClass, type ClassRow } from "../lib/classes";
import { filterStudents } from "../lib/studentSearch";
import { cleanDisplayName } from "../lib/displayName";
import { avatarFor, profileFrom } from "../lib/studentProfile";

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
  // Type a few letters to jump to a student. Matches on the START of the name
  // (or of any word in it, so "ka" finds "Anika Kapoor" by surname) and falls
  // back to a loose contains — then Enter opens the top hit. With more than a
  // handful of students, typing beats scanning a list every time.
  const [query, setQuery] = useState("");

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

  // A–Z when idle, best-match-first while typing. See lib/studentSearch.
  const visible = React.useMemo(() => filterStudents(rows, query), [rows, query]);

  const handleOpen = (row: ClassRow) => {
    // Best-effort recency stamp — must never delay opening the room
    // (awaiting it made the Open click visibly stall on slow networks).
    void touchClass(row.room_code);
    navigate(`/room/${row.room_code}?name=${encodeURIComponent(teacherName)}`);
  };

  const handleProfile = (row: ClassRow) => navigate(`/student-dashboard/${row.room_code}`);

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
            <span
              title={
                !(!studentName.trim() || busy) ? undefined
                : busy ? "Creating..."
                : "Please enter a student name"
              }
              style={{ display: "block", width: "100%" }}
            >
              <button
                className="ml-dark-btn ml-dark-btn-primary"
                onClick={handleCreate}
                disabled={!studentName.trim() || busy}
                style={{ width: "100%", pointerEvents: (!studentName.trim() || busy) ? "none" : undefined }}
              >
                {busy ? "Creating…" : "Create class"}
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </button>
            </span>
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
            <>
              {/* Jump straight to a student by typing. Enter opens the top hit,
                  so a class is two keystrokes away instead of a scroll. */}
              <div className="ml-dash-search">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
                  <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" />
                </svg>
                <input
                  autoFocus
                  className="ml-dash-search-input"
                  placeholder={`Type a name to jump… (${rows.length} student${rows.length === 1 ? "" : "s"})`}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && visible[0]) handleOpen(visible[0]);
                    if (e.key === "Escape") setQuery("");
                  }}
                  aria-label="Search students"
                />
                {query && (
                  <button className="ml-dash-search-clear" onClick={() => setQuery("")} aria-label="Clear search">×</button>
                )}
              </div>

              {visible.length === 0 ? (
                <p style={{ opacity: 0.7, textAlign: "center", padding: "18px 0" }}>
                  No student matches “{query}”.
                </p>
              ) : (
                <div className="ml-dash-grid">
                  {visible.map((row) => {
                    const av = avatarFor(row.student_name, profileFrom(row).avatar);
                    return (
                      <div key={row.id} className="ml-dash-card">
                        {/* The card opens the student's own page — profile, goals
                            and lesson history. "Open room" below is the
                            one-click path for when a lesson is starting. */}
                        <button
                          className="ml-dash-card-open"
                          onClick={() => handleProfile(row)}
                          title={`${row.student_name}'s dashboard`}
                        >
                          <span className="ml-dash-card-face" style={{ background: av.bg, color: av.fg }} aria-hidden="true">
                            {av.label}
                          </span>
                          <span className="ml-dash-card-name">{row.student_name}</span>
                          {row.label && <span className="ml-dash-card-label">{row.label}</span>}
                          <span className="ml-dash-card-code">/live/{row.room_code}</span>
                        </button>
                        <div className="ml-dash-card-actions">
                          <button onClick={() => handleOpen(row)} title={`Go straight into ${row.student_name}'s room`}>
                            Open room
                          </button>
                          <button onClick={() => handleCopy(row)} title="Copy the student's permanent link">
                            {copiedId === row.id ? "Copied!" : "Copy"}
                          </button>
                          <button
                            className="ml-dash-card-del"
                            onClick={() => handleDelete(row)}
                            aria-label={`Delete ${row.student_name}'s class`}
                            title="Delete this class"
                          >
                            ×
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

            </>
          )}
        </div>
      </div>
    </div>
  );
}
