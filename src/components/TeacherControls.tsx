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
}: TeacherControlsProps) {
  const [showTimerMenu, setShowTimerMenu] = useState(false);

  return (
    <>
      {/* ── Main Toolbar ── */}
      <div className="shrink-0 flex flex-wrap items-center gap-2 px-4 py-2.5"
        style={{ borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-secondary)' }}>

        {/* Tool group: Cursor / Draw / Laser */}
        <div className="flex items-center gap-1 p-1 rounded-lg" style={{ background: 'var(--bg-surface)' }}>
          <button onClick={() => { onSetDrawMode(false); onSetLaserMode(false); }}
            className={`btn-ghost text-[12px] ${(!drawMode && !laserMode) ? 'btn-toolbar-active' : ''}`}
            style={{ padding: '5px 12px', borderRadius: '6px' }}>
            🖱 Cursor
          </button>
          <button onClick={() => { onSetDrawMode(true); onSetPenType('transient'); onSetLaserMode(false); }}
            className={`btn-ghost text-[12px] ${(drawMode && penType === 'transient') ? 'btn-toolbar-active' : ''}`}
            style={{ padding: '5px 12px', borderRadius: '6px' }}>
            ✏️ Highlight
          </button>
          <button onClick={() => { onSetDrawMode(true); onSetPenType('permanent'); onSetLaserMode(false); }}
            className={`btn-ghost text-[12px] ${(drawMode && penType === 'permanent') ? 'btn-toolbar-active' : ''}`}
            style={{ padding: '5px 12px', borderRadius: '6px' }}>
            🖊 Permanent
          </button>
          <button onClick={() => { onSetLaserMode(true); onSetDrawMode(false); }}
            className={`btn-ghost text-[12px] ${laserMode ? 'btn-toolbar-active' : ''}`}
            style={{
              padding: '5px 12px', borderRadius: '6px',
              ...(laserMode ? { background: 'var(--accent-rose-light)', color: 'var(--accent-rose)', borderColor: 'rgba(244,63,94,0.3)' } : {}),
            }}>
            🔴 Laser
          </button>
        </div>

        <div className="h-5 w-px" style={{ background: 'var(--border-subtle)' }} />

        {/* Force Sync */}
        <button onClick={onForceSync}
          className="btn-accent text-[12px] font-bold"
          style={{ padding: '6px 14px' }}>
          🔄 Force Sync
        </button>

        {/* Timer */}
        <div className="relative">
          <button onClick={() => setShowTimerMenu(!showTimerMenu)}
            className={`btn text-[12px] ${challengeTimer ? 'btn-toolbar-active' : ''}`}>
            {challengeTimer ? `⏱ ${challengeTimer.remaining}s` : '⏱ Timer'}
          </button>
          {showTimerMenu && (
            <div className="absolute top-full right-0 mt-2 z-50 animate-slide-down rounded-xl p-1.5 min-w-[130px]"
              style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', boxShadow: 'var(--shadow-lg)' }}>
              {TIMER_OPTIONS.map(sec => (
                <button key={sec} onClick={() => { onStartTimer(sec); setShowTimerMenu(false); }}
                  className="w-full text-left px-3 py-2 rounded-lg text-[12px] font-medium transition-all"
                  style={{ color: 'var(--text-primary)' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-surface)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                  ⏱ {sec >= 60 ? `${sec / 60} min` : `${sec}s`}
                </button>
              ))}
              {challengeTimer && (
                <button onClick={() => { onStopTimer(); setShowTimerMenu(false); }}
                  className="w-full text-left px-3 py-2 rounded-lg text-[12px] font-medium transition-all mt-1"
                  style={{ color: 'var(--accent-rose)' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--accent-rose-light)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                  ✕ Stop Timer
                </button>
              )}
            </div>
          )}
        </div>

        {/* Celebrate */}
        <button onClick={onTriggerCelebration} className="btn text-[12px]" title="Celebrate!">
          🎉
        </button>

        {/* Pause */}
        <button onClick={onTogglePause}
          className="btn text-[12px]"
          style={isPaused ? { background: 'var(--accent-rose-light)', color: 'var(--accent-rose)', borderColor: 'rgba(244,63,94,0.3)' } : {}}>
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
        <div className="flex items-center gap-4 px-4 py-2 animate-slide-down shrink-0"
          style={{ background: 'var(--bg-surface)', borderBottom: '1px solid var(--border-subtle)' }}>
          <div className="flex gap-2">
            {PEN_COLORS.map(c => (
              <button key={c} onClick={() => onSetPenColor(c)} className="transition-all active:scale-90" style={{
                width: 22, height: 22, borderRadius: '50%',
                background: c, cursor: 'pointer',
                transform: penColor === c ? 'scale(1.15)' : 'scale(1)',
                boxShadow: penColor === c ? `0 0 0 2px var(--bg-surface), 0 0 0 4px ${c}` : '0 0 0 1px var(--border-default)',
              }} />
            ))}
          </div>
          <div className="h-5 w-px" style={{ background: 'var(--border-subtle)' }} />
          <select value={penWidth} onChange={(e) => onSetPenWidth(Number(e.target.value))}
            className="text-[12px] font-medium outline-none px-2 py-1 rounded-md"
            style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)', cursor: 'pointer' }}>
            <option value={2}>Thin</option>
            <option value={4}>Medium</option>
            <option value={7}>Thick</option>
          </select>
          <div className="flex-1" />
          <button onClick={onClearDrawing} className="btn text-[12px]">
            🗑 Clear Board
          </button>
        </div>
      )}
    </>
  );
}
