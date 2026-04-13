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

const PEN_COLORS = ['#5B5FE6', '#111318', '#0DAF6E', '#0C8FD0', '#E5394B', '#E09600'];
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
}: TeacherControlsProps) {
  const [showTimerMenu, setShowTimerMenu] = useState(false);
  const [showReactionMenu, setShowReactionMenu] = useState(false);

  const isCursor = !drawMode && !laserMode;
  const isDraw = drawMode && penType === 'transient';
  const isInk = drawMode && penType === 'permanent';

  return (
    <>
      {/* Main Toolbar */}
      <div className="shrink-0 flex items-center gap-3 px-4 py-2 overflow-x-auto scrollbar-hide"
        style={{ borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-secondary)' }}>

        {/* Tool Mode Group */}
        <div className="toolbar-group">
          <button onClick={() => { onSetDrawMode(false); onSetLaserMode(false); }}
            className={`tg-btn ${isCursor ? 'active' : ''}`}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{display:'inline',verticalAlign:'middle',marginRight:'4px',marginTop:'-1px'}}>
              <path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51z"/>
            </svg>
            Cursor
          </button>
          <button onClick={() => { onSetDrawMode(true); onSetPenType('transient'); onSetLaserMode(false); }}
            className={`tg-btn ${isDraw ? 'active' : ''}`}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{display:'inline',verticalAlign:'middle',marginRight:'4px',marginTop:'-1px'}}>
              <path d="M17 3a2.828 2.828 0 114 4L7.5 20.5 2 22l1.5-5.5z"/>
            </svg>
            Draw
          </button>
          <button onClick={() => { onSetDrawMode(true); onSetPenType('permanent'); onSetLaserMode(false); }}
            className={`tg-btn ${isInk ? 'active' : ''}`}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{display:'inline',verticalAlign:'middle',marginRight:'4px',marginTop:'-1px'}}>
              <path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/>
            </svg>
            Ink
          </button>
          <button onClick={() => { onSetLaserMode(true); onSetDrawMode(false); }}
            className={`tg-btn ${laserMode ? 'active-danger' : ''}`}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{display:'inline',verticalAlign:'middle',marginRight:'4px',marginTop:'-1px'}}>
              <circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
            </svg>
            Laser
          </button>
        </div>

        {/* Sync Group */}
        <div className="toolbar-group">
          <button onClick={onToggleScrollSync}
            className={`tg-btn ${scrollSyncEnabled ? 'active-accent' : ''}`}
            title={scrollSyncEnabled ? 'Scroll sync ON' : 'Scroll sync OFF'}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{display:'inline',verticalAlign:'middle',marginRight:'3px',marginTop:'-1px'}}>
              {scrollSyncEnabled ? <><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></> : <><path d="M18 13a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07"/><path d="M6 11a5 5 0 017.54.54l3-3a5 5 0 00-7.07-7.07"/><line x1="2" y1="2" x2="22" y2="22"/></>}
            </svg>
            {scrollSyncEnabled ? 'Linked' : 'Free'}
          </button>
          <button onClick={onForceSync} className="tg-btn" title="Force sync all students">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{display:'inline',verticalAlign:'middle',marginRight:'3px',marginTop:'-1px'}}>
              <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
            </svg>
            Sync
          </button>
        </div>

        {/* Actions Group */}
        <div className="toolbar-group">
          {/* Timer */}
          <div className="relative" style={{display:'inline-flex'}}>
            <button onClick={() => setShowTimerMenu(!showTimerMenu)}
              className={`tg-btn ${challengeTimer ? 'active-accent' : ''}`}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{display:'inline',verticalAlign:'middle',marginRight:'3px',marginTop:'-1px'}}>
                <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
              </svg>
              {challengeTimer ? `${challengeTimer.remaining}s` : 'Timer'}
            </button>
            {showTimerMenu && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowTimerMenu(false)} />
                <div className="absolute top-full left-0 mt-1 z-50 animate-slide-down"
                  style={{ background: 'var(--bg-card)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-xl)', minWidth: '130px', padding: '4px' }}>
                  {TIMER_OPTIONS.map(sec => (
                    <button key={sec} onClick={() => { onStartTimer(sec); setShowTimerMenu(false); }}
                      style={{ display: 'block', width: '100%', textAlign: 'left', padding: '7px 12px', borderRadius: 'var(--radius-xs)', fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', border: 'none', background: 'transparent', cursor: 'pointer' }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-surface)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                      {sec >= 60 ? `${sec / 60} min` : `${sec}s`}
                    </button>
                  ))}
                  {challengeTimer && (
                    <button onClick={() => { onStopTimer(); setShowTimerMenu(false); }}
                      style={{ display: 'block', width: '100%', textAlign: 'left', padding: '7px 12px', borderRadius: 'var(--radius-xs)', fontSize: '13px', fontWeight: 600, color: 'var(--accent-rose)', border: 'none', background: 'transparent', cursor: 'pointer' }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--accent-rose-light)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                      Stop
                    </button>
                  )}
                </div>
              </>
            )}
          </div>

          <button onClick={onOpenQuiz} className="tg-btn" title="Pop quiz">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{display:'inline',verticalAlign:'middle',marginRight:'3px',marginTop:'-1px'}}>
              <circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
            Quiz
          </button>

          {/* Reactions */}
          <div className="relative" style={{display:'inline-flex'}}>
            <button onClick={() => setShowReactionMenu(!showReactionMenu)} className="tg-btn" title="Send reaction">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{display:'inline',verticalAlign:'middle',marginRight:'3px',marginTop:'-1px'}}>
                <circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/>
              </svg>
              React
            </button>
            {showReactionMenu && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowReactionMenu(false)} />
                <div className="absolute top-full left-0 mt-1 z-50 animate-slide-down flex gap-1"
                  style={{ background: 'var(--bg-card)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-xl)', padding: '6px' }}>
                  {REACTION_EMOJIS.map((emoji, i) => (
                    <button key={i} onClick={() => { onSendReaction(emoji); setShowReactionMenu(false); }}
                      style={{ width: '36px', height: '36px', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 'var(--radius-sm)', fontSize: '18px', border: 'none', background: 'transparent', cursor: 'pointer', transition: 'all 0.1s' }}
                      onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-surface)'; e.currentTarget.style.transform = 'scale(1.15)'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.transform = 'scale(1)'; }}>
                      {emoji}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          <button onClick={onTriggerCelebration} className="tg-btn" title="Celebrate">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{display:'inline',verticalAlign:'middle',marginRight:'3px',marginTop:'-1px'}}>
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
            </svg>
            Celebrate
          </button>
        </div>

        <div className="flex-1" />

        {/* Pause */}
        <button onClick={onTogglePause}
          style={{
            height: '32px', padding: '0 14px', borderRadius: 'var(--radius-sm)',
            fontSize: '12.5px', fontWeight: 700, border: 'none', cursor: 'pointer',
            background: isPaused ? 'var(--accent-emerald)' : 'var(--accent-rose)',
            color: 'white', transition: 'all 0.12s ease',
            boxShadow: isPaused ? '0 2px 6px rgba(13,175,110,0.25)' : '0 2px 6px rgba(229,57,75,0.25)',
            display: 'inline-flex', alignItems: 'center', gap: '5px',
          }}>
          {isPaused ? (
            <><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg> Resume</>
          ) : (
            <><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg> Pause</>
          )}
        </button>

        {lastSyncTime && <span className="badge badge-emerald" style={{fontSize:'10px'}}>Synced</span>}
      </div>

      {/* Pen Controls */}
      {drawMode && (
        <div className="flex items-center gap-3 px-4 py-2 animate-slide-down shrink-0"
          style={{ background: 'var(--bg-surface)', borderBottom: '1px solid var(--border-subtle)' }}>
          <div style={{ display: 'flex', gap: '4px' }}>
            {PEN_COLORS.map(c => (
              <button key={c} onClick={() => onSetPenColor(c)} style={{
                width: 20, height: 20, borderRadius: '4px', background: c, cursor: 'pointer', border: 'none',
                outline: penColor === c ? `2px solid ${c}` : 'none',
                outlineOffset: '2px',
                transition: 'all 0.1s',
              }} />
            ))}
          </div>
          <div style={{ width: '1px', height: '16px', background: 'var(--border-default)' }} />
          <div className="toolbar-group" style={{ padding: '2px' }}>
            {([{ v: 2, l: 'S' }, { v: 4, l: 'M' }, { v: 7, l: 'L' }] as const).map(({ v, l }) => (
              <button key={v} onClick={() => onSetPenWidth(v)}
                className={`tg-btn ${penWidth === v ? 'active' : ''}`}
                style={{ height: '24px', padding: '0 8px', fontSize: '11px', fontWeight: 700 }}>
                {l}
              </button>
            ))}
          </div>
          <div className="flex-1" />
          <button onClick={onClearDrawing} className="btn" style={{ height: '28px', fontSize: '12px', color: 'var(--accent-rose)', borderColor: 'rgba(229,57,75,0.2)' }}>
            Clear
          </button>
        </div>
      )}
    </>
  );
}
