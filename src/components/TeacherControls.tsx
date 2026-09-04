import React, { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Socket } from 'socket.io-client';
import { TIMER_PRESETS, parseDuration, formatDuration, presetLabel } from '../lib/timerOptions';
import type { BeamSource } from '../lib/beam';

interface TeacherControlsProps {
  socket: Socket | null;
  roomId: string;
  isPaused: boolean;
  onTogglePause: () => void;
  drawMode: boolean;
  laserMode: boolean;
  penType: 'transient' | 'permanent';
  penColor: string;
  penWidth: number;
  onSetDrawMode: (on: boolean) => void;
  onSetLaserMode: (on: boolean) => void;
  onSetPenType: (type: 'transient' | 'permanent') => void;
  onSetPenColor: (color: string) => void;
  onSetPenWidth: (width: number) => void;
  onClearDrawing: () => void;
  onForceSync: () => void;
  onTriggerCelebration: () => void;
  challengeTimer: { seconds: number; remaining: number } | null;
  onStartTimer: (seconds: number) => void;
  onStopTimer: () => void;
  lastSyncTime: number | null;
  onOpenQuiz: () => void;
  onSendReaction: (emoji: string) => void;
  scrollSyncEnabled: boolean;
  onToggleScrollSync: () => void;
  studentInteractionAllowed: boolean;
  onToggleStudentInteraction: () => void;
  onResetView: () => void;
  onAttentionCheck: () => void;
  // Zoom sync
  zoomLevel: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  // Hard reset
  onHardReset: () => void;
  // Leaderboard
  leaderboardCount: number;
  onToggleLeaderboard: () => void;
  // Whiteboard
  onToggleWhiteboard: () => void;
  whiteboardMode: boolean;
  // Explanation HTML overlay
  explanationActive: boolean;
  explanationName: string | null;
  onUploadExplanation: () => void; // opens the file picker
  onExitExplanation: () => void;   // clears the temp content and returns to main
  // Shared YouTube clip
  videoActive: boolean;
  onShowVideo: () => void;         // opens the paste-a-link dialog
  onStopVideo: () => void;         // closes it on everyone's screen
  // Class pack — the whole lesson as one file for a language model
  onDownloadPack: () => void;
  onOpenNotes: () => void;
  notesCount: number;   // homework attachments, so the button can say there are some
  narrationOn: boolean;
  onToggleNarration: () => void;
  packBusy: boolean;
  packCount: number;               // snapshots + materials collected so far
  // Annotation eraser (HTML-overlay drawings)
  eraserMode: 'off' | 'stroke' | 'pixel';
  onSetEraserMode: (mode: 'off' | 'stroke' | 'pixel') => void;
  // Annotation shape tools (HTML-overlay drawings)
  shapeTool: 'off' | 'line' | 'rect' | 'circle' | 'arrow';
  onSetShapeTool: (tool: 'off' | 'line' | 'rect' | 'circle' | 'arrow') => void;
  // Follow student clicks
  followStudentClicks: boolean;
  onToggleFollowStudentClicks: () => void;
  // Sharing the tutor's own screen with the class
  myScreenOn: boolean;
  onToggleMyScreen: () => void;
  // Beam — still pictures over the lesson socket, for when WebRTC will not come up
  beamOn: boolean;
  beamSource: BeamSource | null;
  onStartBeam: (source: BeamSource) => void;
  onStopBeam: () => void;
}

const PEN_COLORS = ['#5B5FE6', '#0F1117', '#10B981', '#0EA5E9', '#EF4444', '#F59E0B'];
const REACTION_EMOJIS = ['\u{1F389}', '\u2705', '\u{1F914}', '\u274C', '\u{1F44F}', '\u{1F525}'];

export default function TeacherControls({
  isPaused, onTogglePause,
  drawMode, laserMode, penType, penColor, penWidth,
  onSetDrawMode, onSetLaserMode, onSetPenType, onSetPenColor, onSetPenWidth, onClearDrawing,
  onForceSync, onTriggerCelebration,
  challengeTimer, onStartTimer, onStopTimer,
  lastSyncTime, onOpenQuiz, onSendReaction,
  scrollSyncEnabled, onToggleScrollSync,
  studentInteractionAllowed, onToggleStudentInteraction,
  onResetView, onAttentionCheck,
  zoomLevel, onZoomIn, onZoomOut, onZoomReset,
  onHardReset, leaderboardCount, onToggleLeaderboard,
  onToggleWhiteboard, whiteboardMode,
  explanationActive, explanationName, onUploadExplanation, onExitExplanation,
  videoActive, onShowVideo, onStopVideo,
  onDownloadPack, onOpenNotes, notesCount, onToggleNarration, narrationOn, packBusy, packCount,
  eraserMode, onSetEraserMode,
  shapeTool, onSetShapeTool,
  followStudentClicks, onToggleFollowStudentClicks,
  myScreenOn, onToggleMyScreen,
  beamOn, beamSource, onStartBeam, onStopBeam,
}: TeacherControlsProps) {
  const [showTimerMenu, setShowTimerMenu] = useState(false);
  const [customTime, setCustomTime] = useState('');
  const [customError, setCustomError] = useState(false);
  const [showReactionMenu, setShowReactionMenu] = useState(false);
  // Dropdowns render through a PORTAL anchored to their trigger's rect.
  // Inside the toolbar they were clipped: `overflow-x-auto` forces
  // overflow-y to auto (cutting absolutely-positioned menus at the ~40px
  // toolbar edge) and the toolbar's backdrop-filter makes it the containing
  // block for position:fixed children, confining the click-away backdrop.
  const timerBtnRef = useRef<HTMLButtonElement>(null);
  const reactionBtnRef = useRef<HTMLButtonElement>(null);
  const beamBtnRef = useRef<HTMLButtonElement>(null);
  const [timerMenuPos, setTimerMenuPos] = useState<{ left: number; top: number } | null>(null);
  const [reactionMenuPos, setReactionMenuPos] = useState<{ left: number; top: number } | null>(null);
  const [showBeamMenu, setShowBeamMenu] = useState(false);
  const [beamMenuPos, setBeamMenuPos] = useState<{ left: number; top: number } | null>(null);
  const anchorMenu = (btn: HTMLButtonElement | null, menuWidth: number) => {
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    return {
      left: Math.max(8, Math.min(r.left, window.innerWidth - menuWidth - 8)),
      top: r.bottom + 8,
    };
  };

  const isCursor = !drawMode && !laserMode;
  const isDraw = drawMode && penType === 'transient';
  const isInk = drawMode && penType === 'permanent';

  return (
    <>
      {/* ═══ Main Toolbar ═══ */}
      <div className="teacher-toolbar shrink-0 overflow-x-auto scrollbar-hide">

        {/* ── Tool Mode (annotation over the iframe simulation) ──
            Hidden when the whiteboard is open: the whiteboard has its own
            cursor / pen / shape / eraser tools in its left rail and these
            iframe-overlay tools are irrelevant there. */}
        {!whiteboardMode && (
          <>
            <button onClick={() => { onSetDrawMode(false); onSetLaserMode(false); onSetEraserMode('off'); onSetShapeTool('off'); }}
              className={`tb-btn ${isCursor && eraserMode === 'off' && shapeTool === 'off' ? 'active' : ''}`} data-tip="Cursor">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51z"/>
              </svg>
            </button>
            <button onClick={() => { onSetDrawMode(true); onSetPenType('transient'); onSetLaserMode(false); onSetEraserMode('off'); onSetShapeTool('off'); }}
              className={`tb-btn ${isDraw && eraserMode === 'off' && shapeTool === 'off' ? 'active' : ''}`} data-tip="Draw (fades)">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 3a2.828 2.828 0 114 4L7.5 20.5 2 22l1.5-5.5z"/>
              </svg>
            </button>
            <button onClick={() => { onSetDrawMode(true); onSetPenType('permanent'); onSetLaserMode(false); onSetEraserMode('off'); onSetShapeTool('off'); }}
              className={`tb-btn ${isInk && eraserMode === 'off' && shapeTool === 'off' ? 'active' : ''}`} data-tip="Ink (permanent)">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/>
              </svg>
            </button>
            <button onClick={() => { onSetLaserMode(true); onSetDrawMode(false); onSetEraserMode('off'); onSetShapeTool('off'); }}
              className={`tb-btn ${laserMode ? 'active-rose' : ''}`} data-tip="Laser pointer">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
              </svg>
            </button>

            {/* Eraser (annotation overlay) — toggles a stroke/pixel sub-mode.
                Picking the eraser turns OFF draw + laser modes so only one
                tool drives the canvas at a time. */}
            <button
              onClick={() => {
                if (eraserMode !== 'off') { onSetEraserMode('off'); return; }
                onSetEraserMode('stroke');
                onSetDrawMode(false);
                onSetLaserMode(false);
                onSetShapeTool('off');
              }}
              className={`tb-btn ${eraserMode !== 'off' ? 'active' : ''}`}
              data-tip={eraserMode !== 'off' ? 'Eraser on — click to turn off' : 'Eraser'}
              aria-pressed={eraserMode !== 'off'}
            >
              {/* AUTONOMOUS: Classic two-tone rubber eraser silhouette.
                  The previous icon was a tilted pencil-eraser line drawing
                  that read as a "knife" or "axe" to most users. This one is
                  the recognisable school-eraser shape: rounded slanted
                  block with the pink top + cream bottom partition. Stays
                  monochrome (currentColor) so it tints with the active
                  state, but the inner divider line keeps the
                  "two-material rubber eraser" silhouette. */}
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 13l-7.5 7.5a2 2 0 0 1-2.83 0L4.5 16.33a2 2 0 0 1 0-2.83L13.5 4.5a2 2 0 0 1 2.83 0L19.5 7.67a2 2 0 0 1 0 2.83Z" fill="currentColor" fillOpacity="0.18" />
                <path d="m9 11 4 4" />
              </svg>
            </button>

            {/* Eraser sub-mode pills (only visible while eraser is on) */}
            {eraserMode !== 'off' && (
              <>
                <button
                  onClick={() => onSetEraserMode('stroke')}
                  className={`tb-btn-label ${eraserMode === 'stroke' ? 'active' : ''}`}
                  data-tip="Click on a stroke to delete the whole stroke"
                  style={{ fontSize: 12 }}
                >
                  Stroke
                </button>
                <button
                  onClick={() => onSetEraserMode('pixel')}
                  className={`tb-btn-label ${eraserMode === 'pixel' ? 'active' : ''}`}
                  data-tip="Drag to erase pixels (precise eraser)"
                  style={{ fontSize: 12 }}
                >
                  Pixel
                </button>
              </>
            )}

            {/* Shape tools — line / rectangle / circle / arrow.
                Picking one disengages draw / laser / eraser. Clicking the
                active shape again returns to cursor. */}
            {([
              { id: 'line',    tip: 'Line',      icon: <path d="M5 19L19 5" /> },
              { id: 'rect',    tip: 'Rectangle', icon: <rect x="4" y="6" width="16" height="12" /> },
              { id: 'circle',  tip: 'Circle',    icon: <circle cx="12" cy="12" r="8" /> },
              { id: 'arrow',   tip: 'Arrow',     icon: <><path d="M5 19L19 5" /><path d="M12 5h7v7" /></> },
            ] as const).map(s => (
              <button
                key={s.id}
                onClick={() => {
                  if (shapeTool === s.id) { onSetShapeTool('off'); return; }
                  onSetShapeTool(s.id);
                  onSetDrawMode(false);
                  onSetLaserMode(false);
                  onSetEraserMode('off');
                }}
                className={`tb-btn ${shapeTool === s.id ? 'active' : ''}`}
                data-tip={s.tip}
                aria-pressed={shapeTool === s.id}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  {s.icon}
                </svg>
              </button>
            ))}

            <div className="toolbar-divider" />
          </>
        )}

        {/* ── Sync Controls ── */}
        <button onClick={onToggleScrollSync}
          className={`tb-btn-label ${scrollSyncEnabled ? 'active' : ''}`}
          data-tip={scrollSyncEnabled ? 'Scroll linked — click to unlink' : 'Scroll free — click to link'}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            {scrollSyncEnabled
              ? <><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></>
              : <><path d="M18 13a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07"/><path d="M6 11a5 5 0 017.54.54l3-3a5 5 0 00-7.07-7.07"/><line x1="2" y1="2" x2="22" y2="22"/></>}
          </svg>
          <span style={{ fontSize: '11.5px' }}>{scrollSyncEnabled ? 'Linked' : 'Free'}</span>
        </button>

        <button onClick={onForceSync} className="tb-btn" data-tip="Force sync all students">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
          </svg>
        </button>

        <button onClick={onResetView} className="tb-btn" data-tip="Scroll everyone to top">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>
          </svg>
        </button>

        <div className="toolbar-divider" />

        {/* ── Zoom Controls (synced to all students) ── */}
        <button onClick={onZoomOut} className="tb-btn" data-tip="Zoom out (synced)" disabled={zoomLevel <= 0.5}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/>
          </svg>
        </button>
        <button onClick={onZoomReset} className={`tb-btn-label ${zoomLevel !== 1 ? 'active' : ''}`}
          data-tip="Click to reset to 100%" style={{ minWidth: '52px' }}>
          <span style={{ fontSize: '11.5px', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
            {Math.round(zoomLevel * 100)}%
          </span>
        </button>
        <button onClick={onZoomIn} className="tb-btn" data-tip="Zoom in (synced)" disabled={zoomLevel >= 3}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/>
          </svg>
        </button>

        <div className="toolbar-divider" />

        {/* ── Student Controls ── */}
        <button onClick={onToggleStudentInteraction}
          className={`tb-btn-label ${studentInteractionAllowed ? 'active-emerald' : ''}`}
          data-tip={studentInteractionAllowed ? 'Students can interact — click for view-only' : 'View-only mode — click to allow interaction'}>
          {studentInteractionAllowed ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/>
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
            </svg>
          )}
          <span style={{ fontSize: '11.5px' }}>{studentInteractionAllowed ? 'Interactive' : 'View Only'}</span>
        </button>

        <button onClick={onAttentionCheck} className="tb-btn" data-tip="Roll call — check who's here">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07"/>
          </svg>
        </button>

        <div className="toolbar-divider" />

        {/* ── Engage ── */}
        <div className="relative" style={{ display: 'inline-flex' }}>
          {/* Deliberately the widest control on the toolbar. A running timer is
              the one thing on screen that BOTH people are watching, and it was
              a 15px glyph you had to hunt for. */}
          <button ref={timerBtnRef}
            onClick={() => {
              if (!showTimerMenu) setTimerMenuPos(anchorMenu(timerBtnRef.current, 232));
              setShowTimerMenu(!showTimerMenu);
            }}
            className={`tb-btn-timer ${challengeTimer ? 'is-running' : ''}`}
            data-tip={challengeTimer ? 'Timer running — click to change or stop' : 'Challenge timer'}
            aria-label={challengeTimer ? `Timer, ${challengeTimer.remaining} seconds remaining` : 'Start a challenge timer'}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
            </svg>
            <span className="tb-timer-value">
              {challengeTimer ? formatDuration(challengeTimer.remaining) : 'Timer'}
            </span>
          </button>
          {showTimerMenu && timerMenuPos && createPortal(
            <>
              <div className="fixed inset-0 z-40" onClick={() => setShowTimerMenu(false)} />
              <div className="animate-slide-down dropdown-menu"
                style={{ position: 'fixed', left: timerMenuPos.left, top: timerMenuPos.top, zIndex: 50 }}>
                {/* A grid, not a list: eleven durations as a vertical column
                    would run off the bottom of a laptop screen. */}
                <div className="tb-timer-grid">
                  {TIMER_PRESETS.map(sec => (
                    <button key={sec} onClick={() => { onStartTimer(sec); setShowTimerMenu(false); }}
                      className="tb-timer-preset">
                      {presetLabel(sec)}
                    </button>
                  ))}
                </div>
                <form className="tb-timer-custom"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const secs = parseDuration(customTime);
                    if (secs === null) { setCustomError(true); return; }
                    onStartTimer(secs);
                    setCustomTime('');
                    setCustomError(false);
                    setShowTimerMenu(false);
                  }}>
                  <input
                    value={customTime}
                    onChange={(e) => { setCustomTime(e.target.value); setCustomError(false); }}
                    placeholder="7 min, 90s, 2:30"
                    aria-label="Custom timer length"
                    className={customError ? 'has-error' : ''}
                  />
                  <button type="submit" className="tb-timer-go">Start</button>
                </form>
                {customError && (
                  <div className="tb-timer-hint">Try “90s”, “7 min”, or “2:30” — between 5 seconds and an hour.</div>
                )}
                {challengeTimer && (
                  <button onClick={() => { onStopTimer(); setShowTimerMenu(false); }}
                    className="dropdown-item danger">
                    Stop timer
                  </button>
                )}
              </div>
            </>,
            document.body
          )}
        </div>

        <button onClick={onOpenQuiz} className="tb-btn" data-tip="Pop quiz">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
        </button>

        <div className="toolbar-divider" />

        {/* Whiteboard surface-switch — primary action, not just another icon. */}
        <button
          onClick={onToggleWhiteboard}
          className={`tb-btn-whiteboard ${whiteboardMode ? 'is-active' : ''}`}
          data-tip={whiteboardMode ? 'Back to simulation' : 'Open the shared whiteboard'}
          aria-pressed={whiteboardMode}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {/* board */}
            <rect x="3" y="4" width="18" height="13" rx="1.6" />
            {/* easel legs */}
            <path d="M8 21l4-4 4 4" />
            {/* stroke on the board */}
            <path d="M7 12l3-3 3 2 4-4" />
          </svg>
          <span className="tb-label-text">{whiteboardMode ? 'Exit whiteboard' : 'Whiteboard'}</span>
        </button>

        {/* Explanation HTML — sister surface-switch. Hidden in whiteboard mode
            since the explanation overlays the iframe, not the whiteboard. */}
        {!whiteboardMode && (
          <button
            onClick={explanationActive ? onExitExplanation : onUploadExplanation}
            className={`tb-btn-explanation ${explanationActive ? 'is-active' : ''}`}
            data-tip={explanationActive ? `Showing: ${explanationName || 'explanation'} — click to exit` : 'Upload an explanation HTML to overlay'}
            aria-pressed={explanationActive}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              {/* book/explanation icon: open book with a bookmark */}
              <path d="M4 4h6a3 3 0 013 3v13a2 2 0 00-2-2H4z" />
              <path d="M20 4h-6a3 3 0 00-3 3v13a2 2 0 012-2h7z" />
            </svg>
            <span className="tb-label-text">{explanationActive ? 'Exit explanation' : 'Explanation'}</span>
          </button>
        )}

        {/* Show a YouTube clip over whatever is on screen. Lives here rather
            than beside the lesson pills because it works over the whiteboard
            just as well as over an HTML lesson. */}
        <button
          onClick={videoActive ? onStopVideo : onShowVideo}
          className={`tb-btn-video ${videoActive ? 'is-active' : ''}`}
          data-tip={videoActive ? 'Stop showing the video' : 'Show a YouTube video over the lesson'}
          aria-pressed={videoActive}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="2.5" y="5" width="19" height="14" rx="4" />
            <path d="M10.5 9.5l5 2.5-5 2.5z" fill="currentColor" stroke="none" />
          </svg>
          <span className="tb-label-text">{videoActive ? 'Stop video' : 'Video'}</span>
        </button>

        {/* Capture what's said as text, so the pack has the talking too. */}
        <button
          onClick={onToggleNarration}
          className={`tb-btn-mic ${narrationOn ? 'is-on' : ''}`}
          aria-pressed={narrationOn}
          data-tip={narrationOn
            ? 'Stop writing down what is said'
            : 'Write down what is said, into the class pack (asks your student first)'}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="9" y="2" width="6" height="11" rx="3" />
            <path d="M5 10a7 7 0 0014 0" /><path d="M12 17v5" />
          </svg>
          <span className="tb-label-text">{narrationOn ? 'Listening' : 'Narrate'}</span>
        </button>

        {/* Show them your actual screen. The escape hatch when the lesson will
            not render on their device — and the only screen sharing that works
            at all when they are on an iPad, which cannot capture but can watch. */}
        <button
          onClick={onToggleMyScreen}
          className={`tb-btn-screen${myScreenOn ? ' is-on' : ''}`}
          data-tip={myScreenOn ? 'Stop sharing your screen with the class' : 'Show the class your actual screen (works even when the lesson will not load for them)'}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="2" y="4" width="20" height="13" rx="2" /><path d="M8 21h8" /><path d="M12 17v4" />
          </svg>
          <span className="tb-label-text">{myScreenOn ? 'Sharing' : 'My screen'}</span>
        </button>

        {/* Beam — the emergency route.
            "My screen" above is WebRTC, and there is no TURN relay configured,
            so on a school network or Indian mobile data it never connects and
            says "Sharing" anyway. This sends still pictures over the socket
            that is already carrying the lesson: if THAT is down the student has
            no lesson either, so there is no state where the beam is broken and
            the class is fine. It is view-only and says so on their screen. */}
        <div className="relative" style={{ display: 'inline-flex' }}>
          <button
            ref={beamBtnRef}
            data-testid="beam-button"
            onClick={() => {
              if (beamOn) { onStopBeam(); setShowBeamMenu(false); return; }
              if (!showBeamMenu) setBeamMenuPos(anchorMenu(beamBtnRef.current, 268));
              setShowBeamMenu(!showBeamMenu);
            }}
            className={`tb-btn-screen${beamOn ? ' is-on' : ''}`}
            data-tip={beamOn
              ? `Beaming ${beamSource === 'board' ? 'the whiteboard' : 'a window'} — click to stop`
              : 'Send the class a picture of what you are showing, over the lesson connection (works when screen sharing will not connect)'}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="4" width="18" height="14" rx="2" /><path d="M8 21h8" /><path d="m9 9 5 2-5 2z" />
            </svg>
            <span className="tb-label-text">{beamOn ? 'Beaming' : 'Beam'}</span>
          </button>
          {showBeamMenu && beamMenuPos && createPortal(
            <>
              <div className="fixed inset-0 z-40" onClick={() => setShowBeamMenu(false)} />
              <div className="animate-slide-down dropdown-menu"
                style={{ position: 'fixed', left: beamMenuPos.left, top: beamMenuPos.top, zIndex: 50, width: 268 }}>
                <button
                  data-testid="beam-board"
                  onClick={() => { onStartBeam('board'); setShowBeamMenu(false); }}
                  className="dropdown-item">
                  The whiteboard
                </button>
                <button
                  data-testid="beam-screen"
                  onClick={() => { onStartBeam('screen'); setShowBeamMenu(false); }}
                  className="dropdown-item">
                  A window on my screen
                </button>
                {/* Said here rather than after it fails. Chrome's tab capture
                    of a PDF comes back blank — the plugin surface is not in the
                    captured layer — and the tutor cannot tell, because their
                    own screen looks right. */}
                <div className="px-3 py-2 text-xs" style={{ color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                  Pick the <strong>Window</strong> tab in the box that opens, not
                  Chrome Tab — a tab capture of a PDF comes back blank.
                </div>
              </div>
            </>,
            document.body
          )}
        </div>

        {/* What only the tutor knows: the lesson's aim, and last week's homework. */}
        <button
          onClick={onOpenNotes}
          className="tb-btn-notes"
          data-tip="Lesson aim, note after, and last week's homework - all go into the class pack"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 4h11l5 5v11a1 1 0 01-1 1H4a1 1 0 01-1-1V5a1 1 0 011-1z" />
            <path d="M14 4v6h6" /><path d="M8 14h7" /><path d="M8 17h5" />
          </svg>
          <span className="tb-label-text">Notes</span>
          {notesCount > 0 && <span className="tb-pack-count">{notesCount}</span>}
        </button>

        {/* The whole lesson as one file, for pasting into a language model. */}
        <button
          onClick={onDownloadPack}
          disabled={packBusy}
          className="tb-btn-pack"
          data-tip={packCount > 0
            ? `Save this lesson as one PDF for an AI (${packCount} pieces captured so far)`
            : 'Save this lesson as one PDF for an AI'}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
            <path d="M7 10l5 5 5-5" /><path d="M12 15V3" />
          </svg>
          <span className="tb-label-text">{packBusy ? 'Packing…' : 'Class pack'}</span>
          {packCount > 0 && <span className="tb-pack-count">{packCount}</span>}
        </button>

        {/* ── Follow Student Clicks ── */}
        <button
          onClick={onToggleFollowStudentClicks}
          className={`tb-btn ${followStudentClicks ? 'active-emerald' : ''}`}
          data-tip={followStudentClicks ? 'Stop following student clicks' : 'Follow student clicks'}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <circle cx="12" cy="12" r="3"/>
            <line x1="12" y1="1" x2="12" y2="4"/>
            <line x1="12" y1="20" x2="12" y2="23"/>
            <line x1="1" y1="12" x2="4" y2="12"/>
            <line x1="20" y1="12" x2="23" y2="12"/>
          </svg>
        </button>

        <div className="relative" style={{ display: 'inline-flex' }}>
          <button ref={reactionBtnRef}
            onClick={() => {
              if (!showReactionMenu) setReactionMenuPos(anchorMenu(reactionBtnRef.current, 320));
              setShowReactionMenu(!showReactionMenu);
            }}
            className="tb-btn" data-tip="Send reaction">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/>
            </svg>
          </button>
          {showReactionMenu && reactionMenuPos && createPortal(
            <>
              <div className="fixed inset-0 z-40" onClick={() => setShowReactionMenu(false)} />
              <div className="animate-slide-down flex gap-1 dropdown-menu"
                style={{ position: 'fixed', left: reactionMenuPos.left, top: reactionMenuPos.top, zIndex: 50, padding: '6px' }}>
                {REACTION_EMOJIS.map((emoji, i) => (
                  <button key={i} onClick={() => { onSendReaction(emoji); setShowReactionMenu(false); }}
                    style={{ width: '36px', height: '36px', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 'var(--radius-sm)', fontSize: '18px', border: 'none', background: 'transparent', cursor: 'pointer', transition: 'all 0.12s' }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-surface)'; e.currentTarget.style.transform = 'scale(1.15)'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.transform = 'scale(1)'; }}>
                    {emoji}
                  </button>
                ))}
              </div>
            </>,
            document.body
          )}
        </div>

        <button onClick={onTriggerCelebration} className="tb-btn" data-tip="Celebrate!">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
          </svg>
        </button>

        {/* ── Leaderboard ── */}
        <button onClick={onToggleLeaderboard} className="tb-btn-label" data-tip="XP Leaderboard"
          style={{ position: 'relative' }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 9H4.5a2.5 2.5 0 010-5H6"/><path d="M18 9h1.5a2.5 2.5 0 000-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0012 0V2z"/>
          </svg>
          <span style={{ fontSize: '11.5px' }}>XP</span>
          {leaderboardCount > 0 && (
            <span style={{ position: 'absolute', top: -4, right: -4, background: 'var(--accent-amber, #F59E0B)', color: '#fff', fontSize: '9px', fontWeight: 800, padding: '1px 5px', borderRadius: '8px', lineHeight: '1.2' }}>
              {leaderboardCount}
            </span>
          )}
        </button>

        {/* ── Hard Reset ── */}
        <button onClick={onHardReset} className="tb-btn" data-tip="Hard reset — clear everything"
          style={{ color: 'var(--accent-rose, #F43F5E)' }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 12a9 9 0 0115.5-6.3L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 01-15.5 6.3L3 16"/><path d="M3 21v-5h5"/>
          </svg>
        </button>

        <div className="flex-1" />

        {/* ── Pause / Resume ── */}
        <button onClick={onTogglePause}
          className={`tb-btn-label ${isPaused ? 'active-emerald' : 'active-rose'}`}
          style={{ paddingLeft: '12px', paddingRight: '12px' }}>
          {isPaused ? (
            <>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
              <span style={{ fontSize: '12px' }}>Resume</span>
            </>
          ) : (
            <>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
              <span style={{ fontSize: '12px' }}>Pause</span>
            </>
          )}
        </button>
      </div>

      {/* ═══ Pen Controls (only when drawing) ═══ */}
      {drawMode && (
        <div className="flex items-center gap-3 px-4 py-2 animate-slide-down shrink-0"
          style={{ background: 'var(--bg-surface)', borderBottom: '1px solid var(--border-subtle)' }}>
          <div style={{ display: 'flex', gap: '4px' }}>
            {PEN_COLORS.map(c => (
              <button key={c} onClick={() => onSetPenColor(c)} style={{
                width: 22, height: 22, borderRadius: '6px', background: c, cursor: 'pointer', border: 'none',
                outline: penColor === c ? `2px solid ${c}` : 'none',
                outlineOffset: '2px',
                transition: 'all 0.12s',
                transform: penColor === c ? 'scale(1.1)' : 'scale(1)',
              }} />
            ))}
          </div>
          <div className="toolbar-divider" />
          <div style={{ display: 'flex', gap: '2px' }}>
            {([{ v: 2, l: 'S' }, { v: 4, l: 'M' }, { v: 7, l: 'L' }] as const).map(({ v, l }) => (
              <button key={v} onClick={() => onSetPenWidth(v)}
                className={`tb-btn ${penWidth === v ? 'active' : ''}`}
                style={{ width: '28px', height: '28px', fontSize: '11px', fontWeight: 700 }}>
                {l}
              </button>
            ))}
          </div>
          <div className="flex-1" />
          <button onClick={onClearDrawing}
            className="tb-btn-label"
            style={{ color: 'var(--accent-rose)', fontSize: '12px' }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
            </svg>
            Clear
          </button>
        </div>
      )}
    </>
  );
}
