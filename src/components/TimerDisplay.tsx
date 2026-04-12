import React from 'react';

interface TimerDisplayProps {
  seconds: number;
  remaining: number;
}

export default function TimerDisplay({ seconds, remaining }: TimerDisplayProps) {
  const minutes = Math.floor(remaining / 60);
  const secs = remaining % 60;
  const timeStr = minutes > 0
    ? `${minutes}:${secs.toString().padStart(2, '0')}`
    : `${remaining}s`;
  const progress = (remaining / seconds) * 100;
  const isUrgent = remaining <= 10;
  const isCritical = remaining <= 5;

  return (
    <div className="absolute top-4 left-1/2 -translate-x-1/2 pointer-events-none z-20 animate-bounce-in">
      <div className="flex items-center gap-3 px-5 py-2.5 rounded-xl" style={{
        background: isUrgent ? 'rgba(244,63,94,0.95)' : 'rgba(17,24,39,0.9)',
        backdropFilter: 'blur(10px)',
        boxShadow: 'var(--shadow-xl)',
        animation: isCritical ? 'pulse 0.5s ease-in-out infinite' : 'none',
      }}>
        <span className="text-xl">{isUrgent ? '⏳' : '⏱'}</span>
        <span className="text-2xl font-black text-white tabular-nums">{timeStr}</span>
        <div className="w-20 h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.2)' }}>
          <div className="h-full rounded-full transition-all duration-1000 ease-linear" style={{
            width: `${progress}%`,
            background: isUrgent ? '#FBBF24' : '#10B981',
          }} />
        </div>
      </div>
    </div>
  );
}
