import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { Socket } from "socket.io-client";
import { parseYouTube, embedUrl } from "../lib/youtube";
import { loadYouTubeApi, YT_STATE } from "../lib/ytPlayer";

// ─────────────────────────────────────────────────────────────────────────
// "Let me show you this video" — a YouTube clip floating over the lesson.
//
// The teacher pastes a link and it opens on every screen in the room at once.
// The teacher's player is the authoritative one: their position is sent out
// once a second and each student's copy quietly follows, so pausing to explain
// something pauses it for everyone, and nobody is watching thirty seconds ahead.
//
// This is app furniture, not lesson content, so the DOM mirror doesn't carry
// it — it rides its own socket events, and it lives on the room so a student
// who joins or reloads mid-clip still lands on the right video.
// ─────────────────────────────────────────────────────────────────────────

type Shared = { videoId: string; start: number };

type Props = {
  socket: Socket | null;
  roomId: string;
  isTeacher: boolean;
  /** Teacher only: the paste-a-link dialog is showing. */
  promptOpen?: boolean;
  onPromptClose?: () => void;
  /** Lets the toolbar show "Stop video" while a clip is up. */
  onActiveChange?: (active: boolean) => void;
};

/** How far a student may drift before we nudge them back. Below about a
 *  second, correcting is more disruptive than the drift itself. */
const DRIFT_TOLERANCE = 1.5;

export default function VideoOverlay({ socket, roomId, isTeacher, promptOpen = false, onPromptClose, onActiveChange }: Props) {
  const [video, setVideo] = useState<Shared | null>(null);
  const [link, setLink] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);
  // 0 tucked away in a corner, 1 normal, 2 as big as the window allows.
  // A student can't close the clip — only the teacher can — so they must at
  // least be able to shrink it off their worksheet.
  const [size, setSize] = useState(1);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [needsSound, setNeedsSound] = useState(false);
  const [fallback, setFallback] = useState(false);   // API blocked → plain embed
  const [loading, setLoading] = useState(false);

  const panelRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<any>(null);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  const startRef = useRef(0);
  // A position update that arrived before this student's player existed.
  const pendingRef = useRef<{ time: number; playing: boolean } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { startRef.current = video?.start ?? 0; }, [video]);
  useEffect(() => { onActiveChange?.(!!video); }, [video, onActiveChange]);

  // ─── What's playing, according to the room ───
  useEffect(() => {
    if (!socket) return;
    const onOpen = ({ videoId, start }: { videoId: string; start?: number }) => {
      if (typeof videoId !== 'string') return;
      setVideo({ videoId, start: Math.max(0, Math.floor(Number(start) || 0)) });
      setNeedsSound(false);
    };
    const onClose = () => { setVideo(null); setNeedsSound(false); };
    // Hydration (join / reconnect) carries the clip too, wound forward to now.
    const onSession = (p: any) => {
      const sv = p?.sharedVideo;
      if (sv?.videoId) setVideo({ videoId: sv.videoId, start: Math.max(0, Math.floor(Number(sv.time) || 0)) });
      else setVideo(null);
    };
    socket.on('video_open', onOpen);
    socket.on('video_close', onClose);
    socket.on('session_state', onSession);
    return () => {
      socket.off('video_open', onOpen);
      socket.off('video_close', onClose);
      socket.off('session_state', onSession);
    };
  }, [socket]);

  // ─── The player itself ───
  // Keyed on the video id alone: a heartbeat that only moves the position must
  // never tear down and rebuild the player underneath the viewer.
  const videoId = video?.videoId ?? null;
  useEffect(() => {
    if (!videoId) return;
    let cancelled = false;
    setFallback(false);
    setLoading(true);

    loadYouTubeApi().then((YT) => {
      if (cancelled || !hostRef.current) return;
      // The API swaps the element it's given for an iframe, so hand it a plain
      // div we made ourselves rather than one React is tracking.
      const mount = document.createElement('div');
      mount.style.width = '100%';
      mount.style.height = '100%';
      hostRef.current.innerHTML = '';
      hostRef.current.appendChild(mount);

      playerRef.current = new YT.Player(mount, {
        host: 'https://www.youtube-nocookie.com',
        width: '100%',
        height: '100%',
        videoId,
        playerVars: {
          autoplay: 1,
          // A student's browser will refuse to start a video with sound before
          // they've touched anything, so theirs starts silent behind a
          // "tap for sound" button. The teacher just clicked, so theirs won't.
          mute: isTeacher ? 0 : 1,
          rel: 0,
          modestbranding: 1,
          playsinline: 1,
          start: Math.floor(startRef.current),
          origin: window.location.origin,
          enablejsapi: 1,
        },
        events: {
          onReady: (e: any) => {
            if (cancelled) return;
            setLoading(false);
            try {
              if (!isTeacher) { e.target.mute(); setNeedsSound(true); }
              e.target.playVideo();
              const queued = pendingRef.current;
              if (queued && !isTeacher) {
                pendingRef.current = null;
                if (Math.abs((e.target.getCurrentTime() || 0) - queued.time) > DRIFT_TOLERANCE) {
                  e.target.seekTo(queued.time, true);
                }
                if (!queued.playing) e.target.pauseVideo();
              }
            } catch { /* player went away mid-setup */ }
          },
          onStateChange: (e: any) => {
            // Teacher: broadcast the moment they play, pause or scrub, rather
            // than making everyone wait for the next heartbeat.
            if (!isTeacher || !socket) return;
            try {
              socket.emit('video_state', {
                roomId,
                time: e.target.getCurrentTime() || 0,
                playing: e.data === YT_STATE.PLAYING,
              });
            } catch { /* socket closing */ }
          },
        },
      });
    }).catch(() => {
      // Blocked or offline. Show a plain embed — it plays, it just won't follow.
      if (cancelled) return;
      setFallback(true);
      setLoading(false);
    });

    return () => {
      cancelled = true;
      try { playerRef.current?.destroy(); } catch { /* already gone */ }
      playerRef.current = null;
      if (hostRef.current) hostRef.current.innerHTML = '';
    };
  }, [videoId, isTeacher, socket, roomId]);

  // ─── Teacher: keep the room posted on where we are ───
  useEffect(() => {
    if (!isTeacher || !socket || !videoId) return;
    const t = setInterval(() => {
      const p = playerRef.current;
      if (!p?.getCurrentTime) return;
      try {
        socket.emit('video_state', {
          roomId,
          time: p.getCurrentTime() || 0,
          playing: p.getPlayerState?.() === YT_STATE.PLAYING,
        });
      } catch { /* socket closing */ }
    }, 1000);
    return () => clearInterval(t);
  }, [isTeacher, socket, roomId, videoId]);

  // ─── Student: follow the teacher ───
  useEffect(() => {
    if (isTeacher || !socket) return;
    const onState = ({ time, playing }: { time: number; playing: boolean }) => {
      const p = playerRef.current;
      if (!p?.getCurrentTime) { pendingRef.current = { time, playing }; return; }
      try {
        const state = p.getPlayerState?.();
        // Mid-buffer the reported position is meaningless; correcting now just
        // starts another buffer. Wait for the next tick.
        if (state === YT_STATE.BUFFERING) return;
        if (Math.abs((p.getCurrentTime() || 0) - time) > DRIFT_TOLERANCE) p.seekTo(time, true);
        if (playing && state !== YT_STATE.PLAYING) p.playVideo();
        if (!playing && state === YT_STATE.PLAYING) p.pauseVideo();
      } catch { /* player torn down between checks */ }
    };
    socket.on('video_state', onState);
    return () => { socket.off('video_state', onState); };
  }, [isTeacher, socket]);

  // ─── Where the window sits ───
  useEffect(() => {
    if (!video || pos) return;
    const w = Math.min(window.innerWidth * 0.94, 720);
    // Below the header and the surface's own tool row, so opening a clip never
    // hides the pen and shapes the teacher is about to reach for. Once it's
    // open they can drag it wherever they like.
    setPos({ x: Math.max(8, (window.innerWidth - w) / 2), y: Math.min(190, Math.max(72, window.innerHeight * 0.26)) });
  }, [video, pos]);

  // Clamped against the panel's real width, not a fixed margin — a 720px-wide
  // video parked at x=280 vanishes off the side of a narrow window otherwise.
  const clamp = useCallback((x: number, y: number) => {
    const w = panelRef.current?.offsetWidth ?? 320;
    return {
      x: Math.min(Math.max(8, x), Math.max(8, window.innerWidth - w - 8)),
      // Leave the title bar and a slice of picture on screen; demanding the
      // whole panel fit would shove it to the top of a short window.
      y: Math.min(Math.max(8, y), Math.max(8, window.innerHeight - 140)),
    };
  }, []);

  // Keep it reachable when the window resizes, a phone rotates, or the viewer
  // makes the panel bigger.
  useEffect(() => {
    const reclamp = () => setPos((p) => p && clamp(p.x, p.y));
    reclamp();
    window.addEventListener('resize', reclamp);
    return () => window.removeEventListener('resize', reclamp);
  }, [clamp, size, video]);

  const onDragStart = useCallback((e: ReactPointerEvent) => {
    if (!pos) return;
    dragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  }, [pos]);
  const onDragMove = useCallback((e: ReactPointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setPos(clamp(e.clientX - d.dx, e.clientY - d.dy));
  }, [clamp]);
  const onDragEnd = useCallback(() => { dragRef.current = null; }, []);

  // Growing it from a low position would push the picture off the bottom, so
  // pull it up as it grows. Shrinking leaves it wherever they put it.
  const resize = useCallback((delta: number) => {
    const next = Math.min(2, Math.max(0, size + delta));
    if (next > size) setPos((p) => p && ({ x: p.x, y: Math.min(p.y, 72) }));
    setSize(next);
  }, [size]);

  const openVideo = useCallback(() => {
    const parsed = parseYouTube(link);
    if (!parsed) {
      setLinkError("That doesn't look like a YouTube link — paste the address from the browser bar or the Share button.");
      inputRef.current?.focus();
      return;
    }
    socket?.emit('video_open', { roomId, videoId: parsed.id, start: parsed.start });
    setLink('');
    setLinkError(null);
    onPromptClose?.();
  }, [link, socket, roomId, onPromptClose]);

  const closeVideo = useCallback(() => {
    socket?.emit('video_close', { roomId });
    setVideo(null);
  }, [socket, roomId]);

  const unmute = useCallback(() => {
    try {
      playerRef.current?.unMute?.();
      playerRef.current?.setVolume?.(100);
      playerRef.current?.playVideo?.();
    } catch { /* noop */ }
    setNeedsSound(false);
  }, []);

  // Focus the box as soon as the teacher opens it, so they can just paste.
  useEffect(() => {
    if (promptOpen) { setLinkError(null); setTimeout(() => inputRef.current?.focus(), 30); }
  }, [promptOpen]);

  // Escape closes the paste dialog.
  useEffect(() => {
    if (!promptOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onPromptClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [promptOpen, onPromptClose]);

  return (
    <>
      {/* ═══ Teacher: paste a link ═══ */}
      {promptOpen && isTeacher && (
        <div className="fixed inset-0 z-[90] flex items-start justify-center p-4 pt-24"
          style={{ background: 'rgba(0,0,0,0.3)', backdropFilter: 'blur(4px)' }}
          onClick={() => onPromptClose?.()}>
          <div className="w-full max-w-lg animate-bounce-in" onClick={(e) => e.stopPropagation()}
            style={{ background: 'var(--bg-card)', borderRadius: 'var(--radius-xl)', border: '1px solid var(--border-subtle)', boxShadow: 'var(--shadow-xl)' }}>
            <div className="px-5 pt-5 pb-1">
              <div className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>Show a video</div>
              <div className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>
                Paste a YouTube link. It opens on your student's screen too, and follows your play, pause and skip.
              </div>
            </div>
            <div className="p-5 pt-3">
              <input
                ref={inputRef}
                value={link}
                onChange={(e) => { setLink(e.target.value); setLinkError(null); }}
                onKeyDown={(e) => { if (e.key === 'Enter') openVideo(); }}
                placeholder="https://youtu.be/…"
                className="w-full px-3 py-2.5 text-sm rounded-lg outline-none"
                style={{ background: 'var(--bg-input, var(--bg-card))', color: 'var(--text-primary)', border: `1px solid ${linkError ? '#ef4444' : 'var(--border-default)'}` }}
              />
              {linkError && <div className="text-xs mt-2" style={{ color: '#ef4444' }}>{linkError}</div>}
              <div className="flex justify-end gap-2 mt-4">
                <button onClick={() => onPromptClose?.()}
                  className="px-4 py-2 text-sm rounded-lg font-medium"
                  style={{ color: 'var(--text-secondary)', border: '1px solid var(--border-default)' }}>
                  Cancel
                </button>
                <button onClick={openVideo}
                  className="px-4 py-2 text-sm rounded-lg font-medium text-white"
                  style={{ background: 'var(--accent-indigo)' }}>
                  Show it
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ═══ The player ═══ */}
      {video && pos && (
        <div ref={panelRef} style={{
          position: 'fixed', left: pos.x, top: pos.y, zIndex: 80,
          // The largest size also measures against the window's height, so
          // "bigger" never means "the bottom half is off the screen".
          width: size === 0 ? 'min(70vw, 280px)'
            : size === 1 ? 'min(94vw, 720px)'
            : 'min(96vw, 1180px, calc((100vh - 130px) * 16 / 9))',
          background: '#0b0b0f',
          borderRadius: 'var(--radius-xl)',
          border: '1px solid rgba(255,255,255,0.12)',
          boxShadow: '0 24px 60px rgba(0,0,0,0.45)',
          overflow: 'hidden',
        }}>
          {/* Title bar — also the drag handle */}
          <div
            onPointerDown={onDragStart}
            onPointerMove={onDragMove}
            onPointerUp={onDragEnd}
            onPointerCancel={onDragEnd}
            className="flex items-center gap-2 px-3 py-2 select-none"
            style={{ cursor: 'grab', background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.9)' }}
          >
            <span className="text-sm font-medium">Video</span>
            {/* Tucked into a corner there's only room for the controls. */}
            {!isTeacher && size > 0 && <span className="text-[11px]" style={{ color: 'rgba(255,255,255,0.55)' }}>following your teacher</span>}
            <div className="flex-1" />
            {needsSound && size > 0 && (
              <button onClick={unmute} onPointerDown={(e) => e.stopPropagation()}
                className="px-2.5 py-1 text-xs rounded-md font-medium text-white"
                style={{ background: 'var(--accent-indigo)' }}>
                🔊 Tap for sound
              </button>
            )}
            <button onClick={() => resize(-1)} onPointerDown={(e) => e.stopPropagation()}
              disabled={size === 0}
              className="px-2 py-1 text-xs rounded-md"
              style={{ color: 'rgba(255,255,255,0.8)', background: 'rgba(255,255,255,0.08)', opacity: size === 0 ? 0.35 : 1 }}
              title={size === 1 ? 'Tuck it into the corner' : 'Smaller'}>
              −
            </button>
            <button onClick={() => resize(1)} onPointerDown={(e) => e.stopPropagation()}
              disabled={size === 2}
              className="px-2 py-1 text-xs rounded-md"
              style={{ color: 'rgba(255,255,255,0.8)', background: 'rgba(255,255,255,0.08)', opacity: size === 2 ? 0.35 : 1 }}
              title="Bigger">
              +
            </button>
            {isTeacher && (
              <button onClick={closeVideo} onPointerDown={(e) => e.stopPropagation()}
                className="px-2 py-1 text-xs rounded-md"
                style={{ color: 'rgba(255,255,255,0.8)', background: 'rgba(255,255,255,0.08)' }}
                title="Stop showing this">
                ✕
              </button>
            )}
          </div>

          {/* 16:9 stage */}
          <div style={{ position: 'relative', width: '100%', aspectRatio: '16 / 9', background: '#000' }}>
            {fallback ? (
              <iframe
                title="Video"
                src={embedUrl(video.videoId, { start: video.start, autoplay: true, mute: !isTeacher })}
                allow="accelerometer; autoplay; encrypted-media; picture-in-picture"
                allowFullScreen
                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0 }}
              />
            ) : (
              <div ref={hostRef} style={{ position: 'absolute', inset: 0 }} />
            )}
            {loading && !fallback && (
              <div className="absolute inset-0 flex items-center justify-center text-sm"
                style={{ color: 'rgba(255,255,255,0.6)' }}>
                Loading video…
              </div>
            )}
          </div>

          {/* A student's clip starts silent because browsers won't allow sound
              before they've touched the page — make the fix impossible to miss. */}
          {needsSound && (
            <button onClick={unmute}
              className="w-full py-2 text-sm font-medium text-white"
              style={{ background: 'var(--accent-indigo)' }}>
              🔊 Tap for sound
            </button>
          )}
          {fallback && (
            <div className="px-3 py-1.5 text-[11px]" style={{ color: 'rgba(255,255,255,0.55)' }}>
              Playing on its own — this network blocked the sync, so use the video's own controls.
            </div>
          )}
        </div>
      )}
    </>
  );
}
