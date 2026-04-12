import React from 'react';

interface PausedOverlayProps {
  isPaused: boolean;
  isTeacher: boolean;
}

export default function PausedOverlay({ isPaused, isTeacher }: PausedOverlayProps) {
  if (!isPaused) return null;

  return (
    <div className="absolute inset-0 flex items-center justify-center z-30 animate-fade-in"
      style={{ background: 'rgba(249,250,251,0.88)', backdropFilter: 'blur(8px)' }}>
      <div className="text-center animate-bounce-in">
        <div className="text-6xl mb-4" style={{ animation: 'pulse 2s ease-in-out infinite' }}>⏸</div>
        <h2 className="font-display text-2xl font-bold mb-2" style={{ color: 'var(--text-primary)' }}>
          Session Paused
        </h2>
        <p className="text-base max-w-xs mx-auto" style={{ color: 'var(--text-secondary)', lineHeight: 1.6 }}>
          {isTeacher
            ? 'Students see a paused screen. Click Resume to continue.'
            : 'Your teacher is explaining something...'}
        </p>
      </div>
    </div>
  );
}
