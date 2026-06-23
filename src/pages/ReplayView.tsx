import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { seededSyncScript } from '../lib/syncScript';
import { LESSON_IFRAME_SANDBOX, LESSON_IFRAME_ALLOW } from '../lib/iframeAttrs';

// ── Session Re-watch Player ──
// A fully OFFLINE viewer for a downloaded MathsLive recording (the JSON the
// teacher saves via the Record button). No socket, no server — it loads the
// file and replays it into a sandboxed iframe, so it can never touch a live
// class. The recording is a list of timestamped events:
//   { type:'lesson',       data:{ html, seed } }   — which sim was on screen
//   { type:'interaction',  data:{ type:'SYNC_*', ... } } — a click/scroll/etc.
//   { type:'chat_message', data:{ userName, message } }
// We rebuild the lesson blob (with the recorded seed so deterministic sims
// reproduce exactly), then replay interactions as REMOTE_* messages — the same
// mechanism a live student uses to mirror the teacher.

interface RecEvent { timestamp: number; type: string; data: any; }
interface Recording { version?: number; startTime?: number; totalDuration?: number; events: RecEvent[]; }

function buildLessonBlobUrl(html: string, seed: number): string {
  const scripts = seededSyncScript(seed || 0);
  let content = html || '<!doctype html><body></body>';
  if (content.includes('<head>')) content = content.replace('<head>', '<head>' + scripts);
  else if (content.includes('<html>')) content = content.replace('<html>', '<html><head>' + scripts + '</head>');
  else content = scripts + content;
  return URL.createObjectURL(new Blob([content], { type: 'text/html' }));
}

function fmt(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export default function ReplayView() {
  const [rec, setRec] = useState<Recording | null>(null);
  const [fileName, setFileName] = useState('');
  const [playing, setPlaying] = useState(false);
  const [playhead, setPlayhead] = useState(0); // ms into the recording
  const [speed, setSpeed] = useState(1);
  const [iframeUrl, setIframeUrl] = useState('');
  const [error, setError] = useState('');

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const loadedLessonTsRef = useRef<number>(-1); // timestamp of the lesson blob currently in the iframe
  const lastAppliedIdxRef = useRef<number>(-1); // index of last interaction posted to the iframe
  const pendingApplyRef = useRef<boolean>(false); // iframe is (re)loading; apply on its load
  const urlRef = useRef<string>('');

  const duration = useMemo(() => {
    if (!rec?.events?.length) return 0;
    return rec.totalDuration || rec.events[rec.events.length - 1].timestamp;
  }, [rec]);

  const hasLesson = useMemo(() => !!rec?.events?.some(e => e.type === 'lesson'), [rec]);
  const chatUpTo = useMemo(() => {
    if (!rec) return [];
    return rec.events.filter(e => e.type === 'chat_message' && e.timestamp <= playhead).slice(-40);
  }, [rec, playhead]);

  const onFile = (e: any) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setError('');
    const r = new FileReader();
    r.onload = () => {
      try {
        const data = JSON.parse(String(r.result));
        if (!data || !Array.isArray(data.events)) { setError('That file is not a MathsLive recording.'); return; }
        data.events.sort((a: RecEvent, b: RecEvent) => a.timestamp - b.timestamp);
        loadedLessonTsRef.current = -1; lastAppliedIdxRef.current = -1; pendingApplyRef.current = false;
        setRec(data); setFileName(f.name); setPlayhead(0); setPlaying(false);
      } catch { setError('Could not read that recording (invalid JSON).'); }
    };
    r.readAsText(f);
  };

  // Load the lesson blob that should be on screen at time t (latest 'lesson' <= t).
  const ensureLesson = useCallback((t: number) => {
    if (!rec) return;
    let lesson: RecEvent | null = null;
    for (const ev of rec.events) {
      if (ev.timestamp > t) break;
      if (ev.type === 'lesson') lesson = ev;
    }
    if (!lesson) return;
    if (lesson.timestamp !== loadedLessonTsRef.current) {
      loadedLessonTsRef.current = lesson.timestamp;
      lastAppliedIdxRef.current = -1;     // fresh iframe → re-apply interactions
      pendingApplyRef.current = true;      // wait for onLoad to apply
      const url = buildLessonBlobUrl(lesson.data?.html || '', lesson.data?.seed || 0);
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = url;
      setIframeUrl(url);
    }
  }, [rec]);

  // Post every interaction in (currentLesson .. t] that hasn't been applied yet.
  const applyInteractions = useCallback((t: number) => {
    if (!rec) return;
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    for (let i = lastAppliedIdxRef.current + 1; i < rec.events.length; i++) {
      const ev = rec.events[i];
      if (ev.timestamp > t) break;
      lastAppliedIdxRef.current = i;
      if (ev.timestamp < loadedLessonTsRef.current) continue; // belongs to an earlier lesson
      if (ev.type === 'interaction' && typeof ev.data?.type === 'string' && ev.data.type.startsWith('SYNC_')) {
        try { win.postMessage({ ...ev.data, type: ev.data.type.replace('SYNC_', 'REMOTE_') }, '*'); } catch { /* ignore */ }
      }
    }
  }, [rec]);

  const onIframeLoad = useCallback(() => {
    // Lock local interaction so the viewer can't accidentally drive the replay;
    // REMOTE_* still applies. Then reconstruct state up to the playhead.
    try { iframeRef.current?.contentWindow?.postMessage({ type: 'SET_INTERACTION_MODE', allowed: false }, '*'); } catch { /* ignore */ }
    if (pendingApplyRef.current) {
      pendingApplyRef.current = false;
      applyInteractions(playhead);
    }
  }, [applyInteractions, playhead]);

  // React to playhead changes: load the right lesson, then apply interactions
  // (unless a fresh iframe is loading — onIframeLoad handles that case).
  useEffect(() => {
    ensureLesson(playhead);
    if (!pendingApplyRef.current) applyInteractions(playhead);
  }, [playhead, ensureLesson, applyInteractions]);

  // Playback clock (20 ticks/sec — smooth scrubber, light on renders).
  useEffect(() => {
    if (!playing || !rec) return;
    let last = performance.now();
    const id = setInterval(() => {
      const now = performance.now();
      const dt = (now - last) * speed; last = now;
      setPlayhead(p => Math.min(duration, p + dt));
    }, 50);
    return () => clearInterval(id);
  }, [playing, rec, speed, duration]);

  // Auto-stop at the end.
  useEffect(() => { if (playing && playhead >= duration && duration > 0) setPlaying(false); }, [playhead, duration, playing]);

  // Cleanup blob on unmount.
  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current); }, []);

  const seek = (v: number) => {
    setPlaying(false);
    // Force a clean rebuild so backward seeks reconstruct from the lesson start.
    loadedLessonTsRef.current = -1; lastAppliedIdxRef.current = -1; pendingApplyRef.current = false;
    setPlayhead(v);
  };

  const counts = useMemo(() => {
    if (!rec) return { lesson: 0, interaction: 0, chat: 0 };
    return rec.events.reduce((a, e) => { (a as any)[e.type] = ((a as any)[e.type] || 0) + 1; return a; }, { lesson: 0, interaction: 0, chat: 0 } as any);
  }, [rec]);

  return (
    <div style={{ height: '100vh', width: '100vw', display: 'flex', flexDirection: 'column', background: 'var(--bg-primary, #0b1020)', color: 'var(--text-primary, #e8edff)' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', borderBottom: '1px solid var(--border-subtle, rgba(120,140,220,0.2))' }}>
        <strong style={{ fontSize: 16 }}>⏯ Lesson Re-watch</strong>
        <span style={{ fontSize: 12, opacity: 0.7 }}>{fileName || 'Load a recording you saved from the Record button'}</span>
        <label style={{ marginLeft: 'auto', cursor: 'pointer', fontSize: 13, padding: '6px 12px', borderRadius: 8, background: 'var(--accent-indigo, #6366f1)', color: '#fff' }}>
          {rec ? 'Load another…' : 'Open recording…'}
          <input type="file" accept="application/json,.json" onChange={onFile} style={{ display: 'none' }} />
        </label>
      </header>

      {error && <div style={{ padding: 10, color: '#fca5a5', fontSize: 13 }}>{error}</div>}

      {!rec ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 10, opacity: 0.8 }}>
          <div style={{ fontSize: 40 }}>🎬</div>
          <div style={{ fontSize: 15 }}>Open a <code>.json</code> recording to replay the lesson.</div>
          <div style={{ fontSize: 12, opacity: 0.6, maxWidth: 420, textAlign: 'center' }}>
            In a room, hit <b>Record</b> to capture the session; stopping downloads a file. Load that file here to scrub through the sim, the clicks, and the chat exactly as they happened.
          </div>
        </div>
      ) : (
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          <div style={{ flex: 1, position: 'relative', background: '#fff', minWidth: 0 }}>
            {hasLesson ? (
              <iframe ref={iframeRef} src={iframeUrl} onLoad={onIframeLoad} title="replay"
                className="w-full h-full" style={{ width: '100%', height: '100%', border: 'none' }}
                sandbox={LESSON_IFRAME_SANDBOX} allow={LESSON_IFRAME_ALLOW} />
            ) : (
              <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#475569', textAlign: 'center', padding: 24 }}>
                This recording has no lesson snapshot (it predates lesson capture, or recording started on a blank board). Interaction and chat timing are still shown below.
              </div>
            )}
          </div>
          <aside style={{ width: 240, borderLeft: '1px solid var(--border-subtle, rgba(120,140,220,0.2))', padding: 12, overflowY: 'auto', fontSize: 13 }}>
            <div style={{ fontWeight: 700, marginBottom: 8 }}>💬 Chat</div>
            {chatUpTo.length === 0 ? <div style={{ opacity: 0.5 }}>No messages yet at this point.</div> :
              chatUpTo.map((e, i) => (
                <div key={i} style={{ marginBottom: 6 }}>
                  <b style={{ opacity: 0.8 }}>{e.data?.userName || 'User'}:</b> {e.data?.message || ''}
                </div>
              ))}
            <div style={{ marginTop: 16, fontSize: 11, opacity: 0.5 }}>
              {counts.lesson} lesson · {counts.interaction} interactions · {counts.chat} chat
            </div>
          </aside>
        </div>
      )}

      {rec && (
        <footer style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', borderTop: '1px solid var(--border-subtle, rgba(120,140,220,0.2))' }}>
          <button onClick={() => { if (playhead >= duration) seek(0); setPlaying(p => !p); }}
            style={{ fontSize: 18, width: 40, height: 40, borderRadius: '50%', border: 'none', cursor: 'pointer', background: 'var(--accent-indigo, #6366f1)', color: '#fff' }}
            aria-label={playing ? 'Pause' : 'Play'}>{playing ? '⏸' : '▶'}</button>
          <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: 13, minWidth: 92 }}>{fmt(playhead)} / {fmt(duration)}</span>
          <input type="range" min={0} max={duration || 1} value={Math.min(playhead, duration || 1)}
            onChange={e => seek(Number(e.target.value))} style={{ flex: 1 }} aria-label="Seek" />
          <select value={speed} onChange={e => setSpeed(Number(e.target.value))}
            style={{ fontSize: 13, padding: '4px 6px', borderRadius: 6, background: 'transparent', color: 'inherit', border: '1px solid var(--border-subtle, rgba(120,140,220,0.3))' }}>
            {[0.5, 1, 1.5, 2, 4].map(s => <option key={s} value={s} style={{ color: '#000' }}>{s}×</option>)}
          </select>
        </footer>
      )}
    </div>
  );
}
