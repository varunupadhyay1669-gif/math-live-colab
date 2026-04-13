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
}

const PEN_COLORS = ['#6366F1', '#111827', '#10B981', '#0EA5E9', '#F43F5E', '#F59E0B'];
const TIMER_OPTIONS = [30, 60, 90, 120, 180];

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
  const [showReactionMenu, setShowReactionMenu] = useState(false);

  const ToolBtn = ({ active, danger, onClick, children, title }: {
    active?: boolean; danger?: boolean; onClick: () => void; children: React.ReactNode; title?: string;
  }) => (
    <button onClick={onClick} title={title}
      className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-[12px] font-semibold transition-all"
      style={{
        background: active ? (danger ? 'var(--accent-rose-light)' : 'var(--accent-indigo-light)')
          : 'var(--bg-secondary)',
        color: active ? (danger ? 'var(--accent-rose)' : 'var(--accent-indigo)')
          : 'var(--text-secondary)',
        border: `1px solid ${active ? (danger ? 'rgba(244,63,94,0.2)' : 'rgba(99,102,241,0.2)') : 'var(--border-subtle)'}`,
        cursor: 'pointer',
        boxShadow: active ? 'var(--shadow-sm)' : 'none',
      }}>
      {children}
    </button>
  );

  return (
    <>
      {/* Main Toolbar */}
      <div className="shrink-0 flex items-center gap-2 px-4 py-2.5 overflow-x-auto scrollbar-hide"
        style={{ borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-secondary)' }}>

        {/* Tool Mode Selector */}
        <div className="flex items-center p-1 rounded-lg" style={{ background: 'var(--bg-surface)', gap: '2px' }}>
          <button onClick={() => { onSetDrawMode(false); onSetLaserMode(false); }}
            className="px-3 py-1.5 rounded-md text-[12px] font-semibold transition-all"
            style={{
              background: (!drawMode && !laserMode) ? 'var(--bg-secondary)' : 'transparent',
              color: (!drawMode && !laserMode) ? 'var(--accent-indigo)' : 'var(--text-muted)',
              border: 'none', cursor: 'pointer',
              boxShadow: (!drawMode && !laserMode) ? 'var(--shadow-sm)' : 'none',
            }}>
            Cursor
          </button>
          <button onClick={() => { onSetDrawMode(true); onSetPenType('transient'); onSetLaserMode(false); }}
            className="px-3 py-1.5 rounded-md text-[12px] font-semibold transition-all"
            style={{
              background: (drawMode && penType === 'transient') ? 'var(--bg-secondary)' : 'transparent',
              color: (drawMode && penType === 'transient') ? 'var(--accent-indigo)' : 'var(--text-muted)',
              border: 'none', cursor: 'pointer',
              boxShadow: (drawMode && penType === 'transient') ? 'var(--shadow-sm)' : 'none',
            }}>
            Draw
          </button>
          <button onClick={() => { onSetDrawMode(true); onSetPenType('permanent'); onSetLaserMode(false); }}
            className="px-3 py-1.5 rounded-md text-[12px] font-semibold transition-all"
            style={{
              background: (drawMode && penType === 'permanent') ? 'var(--bg-secondary)' : 'transparent',
              color: (drawMode && penType === 'permanent') ? 'var(--accent-indigo)' : 'var(--text-muted)',
              border: 'none', cursor: 'pointer',
              boxShadow: (drawMode && penType === 'permanent') ? 'var(--shadow-sm)' : 'none',
            }}>
            Ink
          </button>
          <button onClick={() => { onSetLaserMode(true); onSetDrawMode(false); }}
            className="px-3 py-1.5 rounded-md text-[12px] font-semibold transition-all"
            style={{
              background: laserMode ? 'rgba(244,63,94,0.08)' : 'transparent',
              color: laserMode ? 'var(--accent-rose)' : 'var(--text-muted)',
              border: 'none', cursor: 'pointer',
              boxShadow: laserMode ? 'var(--shadow-sm)' : 'none',
            }}>
            Laser
          </button>
        </div>

        <div className="h-5 w-px mx-1" style={{ background: 'var(--border-default)' }} />

        {/* Sync Controls */}
        <ToolBtn active={scrollSyncEnabled} onClick={onToggleScrollSync}
          title={scrollSyncEnabled ? 'Scroll sync ON - students follow your scroll' : 'Scroll sync OFF - students scroll freely'}>
          {scrollSyncEnabled ? 'Scroll Linked' : 'Scroll Free'}
        </ToolBtn>

        <ToolBtn onClick={onForceSync} title="Force sync all students to your current state">
          Sync All
        </ToolBtn>

        <div className="h-5 w-px mx-1" style={{ background: 'var(--border-default)' }} />

        {/* Timer */}
        <div className="relative">
          <ToolBtn active={!!challengeTimer} onClick={() => setShowTimerMenu(!showTimerMenu)}>
            {challengeTimer ? `${challengeTimer.remaining}s` : 'Timer'}
          </ToolBtn>
          {showTimerMenu && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setShowTimerMenu(false)} />
              <div className="absolute top-full left-0 mt-2 z-50 animate-slide-down rounded-xl overflow-hidden min-w-[150px]"
                style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', boxShadow: 'var(--shadow-xl)' }}>
                <div className="p-1.5">
                  {TIMER_OPTIONS.map(sec => (
                    <button key={sec} onClick={() => { onStartTimer(sec); setShowTimerMenu(false); }}
                      className="w-full text-left px-3 py-2 rounded-lg text-[13px] font-medium transition-all"
                      style={{ color: 'var(--text-primary)', border: 'none', background: 'transparent', cursor: 'pointer' }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-surface)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                      {sec >= 60 ? `${sec / 60} min` : `${sec}s`}
                    </button>
                  ))}
                  {challengeTimer && (
                    <button onClick={() => { onStopTimer(); setShowTimerMenu(false); }}
                      className="w-full text-left px-3 py-2 rounded-lg text-[13px] font-medium transition-all"
                      style={{ color: 'var(--accent-rose)', border: 'none', background: 'transparent', cursor: 'pointer' }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--accent-rose-light)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                      Stop Timer
                    </button>
                  )}
                </div>
              </div>
            </>
          )}
        </div>

        {/* Quiz */}
        <ToolBtn onClick={onOpenQuiz} title="Send a pop quiz to students">
          Quiz
        </ToolBtn>

        {/* Reactions */}
        <div className="relative">
          <ToolBtn onClick={() => setShowReactionMenu(!showReactionMenu)} title="Send a reaction to all students">
            React
          </ToolBtn>
          {showReactionMenu && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setShowReactionMenu(false)} />
              <div className="absolute top-full left-0 mt-2 z-50 animate-slide-down rounded-xl p-2 flex gap-1"
                style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', boxShadow: 'var(--shadow-xl)' }}>
                {['&#127881;', '&#9989;', '&#129300;', '&#10060;', '&#128079;', '&#128293;'].map((code, i) => {
                  const emojis = ['\u{1F389}', '\u2705', '\u{1F914}', '\u274C', '\u{1F44F}', '\u{1F525}'];
                  return (
                    <button key={i} onClick={() => { onSendReaction(emojis[i]); setShowReactionMenu(false); }}
                      className="w-10 h-10 flex items-center justify-center rounded-lg text-xl transition-all hover:scale-110 active:scale-95"
                      style={{ background: 'transparent', border: 'none', cursor: 'pointer' }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-surface)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                      {emojis[i]}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>

        {/* Celebrate */}
        <ToolBtn onClick={onTriggerCelebration} title="Trigger celebration animation for all">
          Celebrate
        </ToolBtn>

        <div className="flex-1" />

        {/* Pause / Resume */}
        <ToolBtn active={isPaused} danger={isPaused} onClick={onTogglePause}
          title={isPaused ? 'Resume student interaction' : 'Pause student interaction'}>
          {isPaused ? 'Resume' : 'Pause'}
        </ToolBtn>

        {/* Sync indicator */}
        {lastSyncTime && (
          <span className="badge badge-emerald text-[10px]">Synced</span>
        )}
      </div>

      {/* Pen Controls (visible when drawMode active) */}
      {drawMode && (
        <div className="flex items-center gap-3 px-4 py-2.5 animate-slide-down shrink-0"
          style={{ background: 'var(--bg-surface)', borderBottom: '1px solid var(--border-subtle)' }}>
          <div className="flex gap-1.5">
            {PEN_COLORS.map(c => (
              <button key={c} onClick={() => onSetPenColor(c)} className="transition-all active:scale-90" style={{
                width: 22, height: 22, borderRadius: '50%',
                background: c, cursor: 'pointer', border: 'none',
                transform: penColor === c ? 'scale(1.15)' : 'scale(1)',
                boxShadow: penColor === c ? `0 0 0 2px var(--bg-surface), 0 0 0 3.5px ${c}` : 'inset 0 0 0 1px rgba(0,0,0,0.1)',
              }} />
            ))}
          </div>
          <div className="h-4 w-px" style={{ background: 'var(--border-default)' }} />
          <div className="flex items-center gap-1 p-0.5 rounded-lg" style={{ background: 'var(--bg-secondary)' }}>
            {([{ v: 2, l: 'S' }, { v: 4, l: 'M' }, { v: 7, l: 'L' }] as const).map(({ v, l }) => (
              <button key={v} onClick={() => onSetPenWidth(v)}
                className="px-2.5 py-1 rounded-md text-[11px] font-bold transition-all"
                style={{
                  background: penWidth === v ? 'var(--accent-indigo-light)' : 'transparent',
                  color: penWidth === v ? 'var(--accent-indigo)' : 'var(--text-muted)',
                  border: 'none', cursor: 'pointer',
                }}>
                {l}
              </button>
            ))}
          </div>
          <div className="flex-1" />
          <button onClick={onClearDrawing}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-semibold transition-all"
            style={{
              background: 'var(--accent-rose-light)', color: 'var(--accent-rose)',
              border: '1px solid rgba(244,63,94,0.15)', cursor: 'pointer'
            }}>
            Clear Canvas
          </button>
        </div>
      )}
    </>
  );
}
