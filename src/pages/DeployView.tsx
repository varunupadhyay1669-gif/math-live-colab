import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { LESSON_IFRAME_SANDBOX, LESSON_IFRAME_ALLOW } from "../lib/iframeAttrs";

// Standalone viewer for a quick-deploy page (drop HTML on the landing page →
// /p/:id). It renders the REAL uploaded HTML with scripts intact — the visitor
// runs the page themselves, so it works with NO teacher/collab present
// (deploy-and-forget) for both static pages and interactive demos. A slim bar
// lets the owner open it as a live MathsLive class or deploy another.

type State =
  | { status: "loading" }
  | { status: "ok"; html: string; fileName: string }
  | { status: "missing" }
  | { status: "error"; message: string };

export default function DeployView() {
  const { pageId } = useParams<{ pageId: string }>();
  const navigate = useNavigate();
  const [state, setState] = useState<State>({ status: "loading" });
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    (async () => {
      try {
        const res = await fetch(`/api/room/${pageId}/content`, { headers: { Accept: "application/json" } });
        if (cancelled) return;
        if (res.status === 404 || res.status === 204) { setState({ status: "missing" }); return; }
        if (!res.ok) { setState({ status: "error", message: `Couldn't load this page (${res.status}).` }); return; }
        const data = await res.json();
        if (cancelled) return;
        if (!data || typeof data.html !== "string") { setState({ status: "missing" }); return; }
        setState({ status: "ok", html: data.html, fileName: data.fileName || "Shared page" });
      } catch {
        if (!cancelled) setState({ status: "error", message: "Network error — check your connection and refresh." });
      }
    })();
    return () => { cancelled = true; };
  }, [pageId]);

  // Render the HTML from a blob URL (same mechanism the app uses for lessons),
  // so scripts run and the page behaves exactly as authored.
  const blobUrl = useMemo(() => {
    if (state.status !== "ok") return "";
    const blob = new Blob([state.html], { type: "text/html" });
    return URL.createObjectURL(blob);
  }, [state]);
  useEffect(() => () => { if (blobUrl) URL.revokeObjectURL(blobUrl); }, [blobUrl]);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1800);
    } catch { /* clipboard blocked — non-fatal */ }
  };

  const bar: CSSProperties = {
    display: "flex", alignItems: "center", gap: 10, padding: "8px 14px",
    background: "#0f1222", color: "#e7e9f3", borderBottom: "1px solid rgba(255,255,255,.08)",
    fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif", fontSize: 13, flexWrap: "wrap",
  };
  const btn: CSSProperties = {
    padding: "6px 12px", borderRadius: 8, border: "1px solid rgba(255,255,255,.14)",
    background: "rgba(255,255,255,.06)", color: "#e7e9f3", fontSize: 12.5, fontWeight: 600,
    cursor: "pointer", whiteSpace: "nowrap",
  };
  const btnPrimary: CSSProperties = { ...btn, background: "#4f46e5", borderColor: "#4f46e5", color: "#fff" };

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: "#0f1222" }}>
      <div style={bar}>
        <button onClick={() => navigate("/")} style={{ ...btn, display: "flex", alignItems: "center", gap: 7, fontWeight: 800 }} title="MathsLive home">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M4 18l6-12 4 8 6-4" /></svg>
          Maths<span style={{ color: "#818cf8" }}>Live</span>
        </button>
        {state.status === "ok" && (
          <span style={{ opacity: .7, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 240 }}>
            {state.fileName}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {state.status === "ok" && (
          <>
            <button onClick={copyLink} style={btn}>{copied ? "Copied ✓" : "Copy link"}</button>
            <button onClick={() => navigate(`/room/${pageId}?name=${encodeURIComponent("Host")}`)} style={btnPrimary} title="Teach with this page live — students join and see it mirrored">
              Open as live class
            </button>
          </>
        )}
        <button onClick={() => navigate("/")} style={btn}>Deploy your own</button>
      </div>

      <div style={{ flex: 1, position: "relative", background: "#fff" }}>
        {state.status === "loading" && (
          <Centered>Loading…</Centered>
        )}
        {state.status === "missing" && (
          <Centered>
            <div style={{ fontSize: 40, marginBottom: 6 }}>⌛</div>
            <div style={{ fontSize: 17, fontWeight: 700, color: "#1f2333" }}>This page has expired or doesn't exist</div>
            <div style={{ fontSize: 14, color: "#6b7080", marginTop: 6, maxWidth: 380 }}>
              Quick-deployed pages are live for 24 hours. Deploy a fresh one in seconds.
            </div>
            <button onClick={() => navigate("/")} style={{ ...btnPrimary, marginTop: 16, padding: "10px 18px" }}>Deploy a page</button>
          </Centered>
        )}
        {state.status === "error" && (
          <Centered>
            <div style={{ fontSize: 40, marginBottom: 6 }}>⚠️</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: "#1f2333" }}>{state.message}</div>
            <button onClick={() => window.location.reload()} style={{ ...btnPrimary, marginTop: 16, padding: "10px 18px" }}>Retry</button>
          </Centered>
        )}
        {state.status === "ok" && (
          <iframe
            title={state.fileName}
            src={blobUrl}
            sandbox={LESSON_IFRAME_SANDBOX}
            allow={LESSON_IFRAME_ALLOW}
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: 0, background: "#fff" }}
          />
        )}
      </div>
    </div>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div style={{
      position: "absolute", inset: 0, display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center", textAlign: "center", padding: 24,
      fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif", color: "#6b7080",
    }}>
      {children}
    </div>
  );
}
