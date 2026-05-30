import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { listClasses, createClass, deleteClass, touchClass, type ClassRow } from "../lib/classes";

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
    return meta?.full_name || meta?.name || auth.user?.email || "Teacher";
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

  const handleOpen = async (row: ClassRow) => {
    await touchClass(row.room_code);
    navigate(`/room/${row.room_code}?name=${encodeURIComponent(teacherName)}`);
  };

  const handleCopy = (row: ClassRow) => {
    navigator.clipboard.writeText(studentLink(row.room_code));
    setCopiedId(row.id);
    setTimeout(() => setCopiedId((id) => (id === row.id ? null : id)), 2000);
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
            <button
              className="ml-dark-btn ml-dark-btn-primary"
              onClick={handleCreate}
              disabled={!studentName.trim() || busy}
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
                <li key={row.id} className="ml-dark-saved-item">
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
                    className="ml-dark-saved-remove"
                    onClick={() => handleDelete(row)}
                    aria-label={`Delete ${row.student_name}'s class`}
                    title="Delete this class"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
