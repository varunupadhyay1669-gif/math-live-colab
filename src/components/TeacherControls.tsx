import React, { useState } from 'react';
import { Socket } from 'socket.io-client';

interface TeacherControlsProps {
  socket: Socket | null;
  roomId: string;
  isPaused: boolean;
  onTogglePause: () => void;
  // Draw / Laser mode
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
  // Actions
  onForceSync: () => void;
  onTriggerCelebration: () => void;
  // Timer
  challengeTimer: { seconds: number; remaining: number } | null;
  onStartTimer: (seconds: number) => void;
  onStopTimer: () => void;
  // Sync indicator
  lastSyncTime: number | null;
  // Quiz
  onOpenQuiz: () => void;
  // Reactions
  onSendReaction: (emoji: string) => void;
  // Scroll sync
  scrollSyncEnabled: boolean;
  onToggleScrollSync: () => void;
}

const PEN_COLORS = ['#6366F1', '#111827', '#10B981', '#0EA5E9', '#F43F5E'];
const TIMER_OPTIONS = [30, 60, 90, 120, 180];
const REACTION_EMOJIS = ['🎉', '✅', '🤔', '❌', '👏', '🔥'];

export default function TeacherControls({
  socket, roomId, isPaused, onTogglePause,
  drawMode, laserMode, penType, penColor, penWidth,
  onSetDrawMode, onSetLaserMode, onSetPenType, onSetPenColor, onSetPenWidth, onClearDrawing,
  onForceSync, onTriggerCelebration,
  challengeTimer, onStartTimer, onStopTimer,
  lastSyncTime, onOpenQuiz, onSendReaction,
  scrollSyncEnabled, onToggleScrollSync,
}: TeacherControlsProps) {
  const [showTimerMenu, setShowTimerMenu] = useState(false);

  return (
    <>
      {/* ── Main Toolbar ── */}
      <div className="shrink-0 flex items-center gap-1.5 px-3 py-2 overflow-x-auto scrollbar-hide"
        style={{ borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-secondary)' }}>

        {/* Tool group: Cursor / Draw / Laser */}
        <div className="flex items-center p-0.5 rounded-lg" style={{ background: 'var(--bg-surface)' }}>
          <button onClick={() => { onSetDrawMode(false); onSetLaserMode(false); }}
            className={`text-[12px] font-semibold px-3 py-1.5 rounded-md transition-all ${(!drawMode && !laserMode) ? 'btn-toolbar-active' : ''}`}
            style={{ background: (!drawMode && !laserMode) ? 'var(--bg-secondary)' : 'transparent', border: 'none', cursor: 'pointer', color: (!drawMode && !laserMode) ? 'var(--accent-indigo)' : 'var(--text-muted)', boxShadow: (!drawMode && !laserMode) ? 'var(--shadow-xs)' : 'none' }}>
            🖱 Cursor
          </button>
          <button onClick={() => { onSetDrawMode(true); onSetPenType('transient'); onSetLaserMode(false); }}
            className={`text-[12px] font-semibold px-3 py-1.5 rounded-md transition-all`}
            style={{ background: (drawMode && penType === 'transient') ? 'var(--bg-secondary)' : 'transparent', border: 'none', cursor: 'pointer', color: (drawMode && penType === 'transient') ? 'var(--accent-indigo)' : 'var(--text-muted)', boxShadow: (drawMode && penType === 'transient') ? 'var(--shadow-xs)' : 'none' }}>
            ✏️ Draw
          </button>
          <button onClick={() => { onSetDrawMode(true); onSetPenType('permanent'); onSetLaserMode(false); }}
            className={`text-[12px] font-semibold px-3 py-1.5 rounded-md transition-all`}
            style={{ background: (drawMode && penType === 'permanent') ? 'var(--bg-secondary)' : 'transparent', border: 'none', cursor: 'pointer', color: (drawMode && penType === 'permanent') ? 'var(--accent-indigo)' : 'var(--text-muted)', boxShadow: (drawMode && penType === 'permanent') ? 'var(--shadow-xs)' : 'none' }}>
            🖊 Ink
          </button>
          <button onClick={() => { onSetLaserMode(true); onSetDrawMode(false); }}
            className={`text-[12px] font-semibold px-3 py-1.5 rounded-md transition-all`}
            style={{ background: laserMode ? 'rgba(244,63,94,0.08)' : 'transparent', border: 'none', cursor: 'pointer', color: laserMode ? 'var(--accent-rose)' : 'var(--text-muted)', boxShadow: laserMode ? 'var(--shadow-xs)' : 'none' }}>
            🔴 Laser
          </button>
        </div>

        <div className="h-4 w-px mx-0.5" style={{ background: 'var(--border-default)' }} />

        {/* Scroll Sync Toggle */}
        <button onClick={onToggleScrollSync}
          className={`btn text-[12px] ${scrollSyncEnabled ? 'btn-toolbar-active' : ''}`}
          title={scrollSyncEnabled ? 'Scroll sync ON' : 'Scroll sync OFF'}>
          {scrollSyncEnabled ? '🔗 Sync' : '🔓 Free'}
        </button>

        {/* Force Sync */}
        <button onClick={onForceSync}
          className="btn-accent text-[12px]">
          🔄 Sync
        </button>

        {/* Timer */}
        <div className="relative">
          <button onClick={() => setShowTimerMenu(!showTimerMenu)}
            className={`btn text-[12px] ${challengeTimer ? 'btn-toolbar-active' : ''}`}>
            {challengeTimer ? `⏱ ${challengeTimer.remaining}s` : '⏱ Timer'}
          </button>
          {showTimerMenu && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setShowTimerMenu(false)} />
              <div className="absolute top-full left-0 mt-2 z-50 animate-slide-down rounded-xl p-1 min-w-[140px]"
                style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', boxShadow: 'var(--shadow-xl)' }}>
                {TIMER_OPTIONS.map(sec => (
                  <button key={sec} onClick={() => { onStartTimer(sec); setShowTimerMenu(false); }}
                    className="w-full text-left px-3 py-2 rounded-lg text-[12px] font-semibold transition-all"
                    style={{ color: 'var(--text-primary)', border: 'none', background: 'transparent', cursor: 'pointer' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-surface)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                    ⏱ {sec >= 60 ? `${sec / 60} min` : `${sec}s`}
                  </button>
                ))}
                {challengeTimer && (
                  <button onClick={() => { onStopTimer(); setShowTimerMenu(false); }}
                    className="w-full text-left px-3 py-2 rounded-lg text-[12px] font-semibold transition-all mt-0.5"
                    style={{ color: 'var(--accent-rose)', border: 'none', background: 'transparent', cursor: 'pointer' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--accent-rose-light)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                    ✕ Stop
                  </button>
                )}
              </div>
            </>
          )}
        </div>

        {/* Celebrate */}
        <button onClick={onTriggerCelebration} className="btn text-[12px]" title="Celebrate!">
          🎉
        </button>

        {/* Pause */}
        <button onClick={onTogglePause}
          className="btn text-[12px]"
          style={isPaused ? { background: 'var(--accent-rose-light)', color: 'var(--accent-rose)', borderColor: 'rgba(244,63,94,0.15)' } : {}}>
          {isPaused ? '▶ Resume' : '⏸ Pause'}
        </button>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Sync indicator */}
        {lastSyncTime && (
          <span className="badge badge-emerald text-[10px]">
            ✓ Synced
          </span>
        )}
      </div>

      {/* ── Pen Controls (visible when drawMode active) ── */}
      {drawMode && (
        <div className="flex items-center gap-3 px-4 py-2 animate-slide-down shrink-0"
          style={{ background: 'var(--bg-surface)', borderBottom: '1px solid var(--border-subtle)' }}>
          <div className="flex gap-1.5">
            {PEN_COLORS.map(c => (
              <button key={c} onClick={() => onSetPenColor(c)} className="transition-all active:scale-90" style={{
                width: 24, height: 24, borderRadius: '50%',
                background: c, cursor: 'pointer', border: 'none',
                transform: penColor === c ? 'scale(1.1)' : 'scale(1)',
                boxShadow: penColor === c ? `0 0 0 2px var(--bg-surface), 0 0 0 3.5px ${c}` : 'inset 0 0 0 1px rgba(0,0,0,0.1)',
              }} />
            ))}
          </div>
          <div className="h-4 w-px" style={{ background: 'var(--border-default)' }} />
          <select value={penWidth} onChange={(e) => onSetPenWidth(Number(e.target.value))}
            className="text-[12px] font-semibold outline-none px-2.5 py-1 rounded-lg"
            style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)', cursor: 'pointer' }}>
            <option value={2}>Thin</option>
            <option value={4}>Medium</option>
            <option value={7}>Thick</option>
          </select>
          <div className="flex-1" />
          <button onClick={onClearDrawing} className="btn text-[12px]">
            🗑 Clear
          </button>
        </div>
      )}
    </>
  );
}
