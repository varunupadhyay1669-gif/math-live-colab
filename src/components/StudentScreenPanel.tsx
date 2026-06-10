import React, { useEffect, useRef } from 'react';

interface StudentScreenPanelProps {
  studentName: string;
  html: string | null;          // latest serialized DOM of the student's screen
  updatedAt: number;            // bump to flash the "live" indicator
  hasControl: boolean;          // does this student currently hold the chalk?
  onClose: () => void;
  onRefresh: () => void;        // re-request a fresh snapshot
  onResync: () => void;         // rebuild this student from canonical state
  onToggleControl: () => void;  // give / take back control
}

// A read-only window into a single student's ACTUAL screen. The student's
// iframe serializes its live DOM on request; we render it here WITHOUT
// re-running scripts (sandbox="") so it's a faithful frozen snapshot of what
// they currently see — not a re-simulated approximation.
export default function StudentScreenPanel({
  studentName, html, updatedAt, hasControl, onClose, onRefresh, onResync, onToggleControl,
}: StudentScreenPanelProps) {
  // Auto-refresh every 2s while the panel is open so it stays close to live.
  const onRefreshRef = useRef(onRefresh);
  useEffect(() => { onRefreshRef.current = onRefresh; }, [onRefresh]);
  useEffect(() => {
    onRefreshRef.current();
    const id = setInterval(() => onRefreshRef.current(), 2000);
    return () => clearInterval(id);
  }, [studentName]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(4px)' }}
      onClick={onClose}>
      <div className="ml-surface-elevated flex flex-col"
        style={{ width: 'min(880px, 94vw)', height: 'min(620px, 88vh)', borderRadius: 16, overflow: 'hidden', boxShadow: 'var(--shadow-xl)' }}
        onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
          <span style={{ fontSize: 16 }}>👁️</span>
          <div className="flex flex-col">
            <span className="text-[13px] font-bold" style={{ color: 'var(--text-primary)' }}>
              {studentName}'s screen{hasControl ? ' ✋ (driving)' : ''}
            </span>
            <span key={updatedAt} className="text-[10px]" style={{ color: 'var(--accent-emerald)', animation: 'pulse 1.2s ease-out' }}>
              {html ? '● live' : 'waiting for screen…'}
            </span>
          </div>
          <div className="flex-1" />
          <button onClick={onToggleControl} className="ml-btn ml-btn-sm"
            style={{ background: hasControl ? 'var(--accent-rose-light, rgba(244,63,94,0.12))' : 'var(--accent-indigo-light)', color: hasControl ? '#E11D48' : 'var(--accent-indigo)', fontWeight: 700 }}>
            {hasControl ? '🔙 Take back control' : '✋ Give control'}
          </button>
          <button onClick={onResync} className="ml-btn ml-btn-sm ml-btn-secondary" title="Rebuild this student from the current class state">
            ⟳ Resync
          </button>
          <button onClick={onClose} className="ml-icon-btn ml-icon-btn-sm" title="Close">✕</button>
        </div>
        {/* Screen */}
        <div className="flex-1" style={{ background: '#0b0d12', position: 'relative' }}>
          {html ? (
            <iframe
              title={`${studentName} screen`}
              srcDoc={html}
              sandbox=""
              className="w-full h-full border-none"
              style={{ background: '#fff' }}
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center" style={{ color: 'var(--text-muted)', fontSize: 13 }}>
              Asking {studentName}'s device for a snapshot…
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
