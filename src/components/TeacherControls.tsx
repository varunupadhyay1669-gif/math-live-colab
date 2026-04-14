import React, { useState } from 'react';
import { Socket } from 'socket.io-client';

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
}

const PEN_COLORS = ['#5B5FE6', '#0F1117', '#10B981', '#0EA5E9', '#EF4444', '#F59E0B'];
const TIMER_OPTIONS = [30, 60, 90, 120, 180];
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
}: TeacherControlsProps) {
  const [showTimerMenu, setShowTimerMenu] = useState(false);
  const [showReactionMenu, setShowReactionMenu] = useState(false);

  const isCursor = !drawMode && !laserMode;
  const isDraw = drawMode && penType === 'transient';
  const isInk = drawMode && penType === 'permanent';

  return (
    <>
      {/* ═══ Main Toolbar ═══ */}
      <div className="teacher-toolbar shrink-0 overflow-x-auto scrollbar-hide">

        {/* ── Tool Mode ── */}
        <button onClick={() => { onSetDrawMode(false); onSetLaserMode(false); }}
          className={`tb-btn ${isCursor ? 'active' : ''}`} data-tip="Cursor">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51z"/>
          </svg>
        </button>
        <button onClick={() => { onSetDrawMode(true); onSetPenType('transient'); onSetLaserMode(false); }}
          className={`tb-btn ${isDraw ? 'active' : ''}`} data-tip="Draw (fades)">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17 3a2.828 2.828 0 114 4L7.5 20.5 2 22l1.5-5.5z"/>
          </svg>
        </button>
        <button onClick={() => { onSetDrawMode(true); onSetPenType('permanent'); onSetLaserMode(false); }}
          className={`tb-btn ${isInk ? 'active' : ''}`} data-tip="Ink (permanent)">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/>
          </svg>
        </button>
        <button onClick={() => { onSetLaserMode(true); onSetDrawMode(false); }}
          className={`tb-btn ${laserMode ? 'active-rose' : ''}`} data-tip="Laser pointer">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
          </svg>
        </button>

        <div className="toolbar-divider" />

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
          <button onClick={() => setShowTimerMenu(!showTimerMenu)}
            className={`tb-btn ${challengeTimer ? 'active' : ''}`}
            data-tip={challengeTimer ? `${challengeTimer.remaining}s remaining` : 'Challenge timer'}>
            {challengeTimer ? (
              <span style={{ fontSize: '12px', fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: 'inherit' }}>
                {challengeTimer.remaining}s
              </span>
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
              </svg>
            )}
          </button>
          {showTimerMenu && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setShowTimerMenu(false)} />
              <div className="absolute top-full left-0 mt-2 z-50 animate-slide-down dropdown-menu">
                {TIMER_OPTIONS.map(sec => (
                  <button key={sec} onClick={() => { onStartTimer(sec); setShowTimerMenu(false); }}
                    className="dropdown-item">
                    {sec >= 60 ? `${sec / 60} min` : `${sec}s`}
                  </button>
                ))}
                {challengeTimer && (
                  <button onClick={() => { onStopTimer(); setShowTimerMenu(false); }}
                    className="dropdown-item danger">
                    Stop Timer
                  </button>
                )}
              </div>
            </>
          )}
        </div>

        <button onClick={onOpenQuiz} className="tb-btn" data-tip="Pop quiz">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
        </button>

        <div className="relative" style={{ display: 'inline-flex' }}>
          <button onClick={() => setShowReactionMenu(!showReactionMenu)} className="tb-btn" data-tip="Send reaction">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/>
            </svg>
          </button>
          {showReactionMenu && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setShowReactionMenu(false)} />
              <div className="absolute top-full left-0 mt-2 z-50 animate-slide-down flex gap-1 dropdown-menu" style={{ padding: '6px' }}>
                {REACTION_EMOJIS.map((emoji, i) => (
                  <button key={i} onClick={() => { onSendReaction(emoji); setShowReactionMenu(false); }}
                    style={{ width: '36px', height: '36px', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 'var(--radius-sm)', fontSize: '18px', border: 'none', background: 'transparent', cursor: 'pointer', transition: 'all 0.12s' }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-surface)'; e.currentTarget.style.transform = 'scale(1.15)'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.transform = 'scale(1)'; }}>
                    {emoji}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        <button onClick={onTriggerCelebration} className="tb-btn" data-tip="Celebrate!">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
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
