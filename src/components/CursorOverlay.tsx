import React from 'react';

interface Cursor {
  x: number;
  y: number;
  color: string;
  name: string;
}

interface CursorOverlayProps {
  cursors: Record<string, Cursor>;
}

export default function CursorOverlay({ cursors }: CursorOverlayProps) {
  const entries = Object.entries(cursors) as [string, Cursor][];
  if (entries.length === 0) return null;

  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden" style={{ zIndex: 11 }}>
      {entries.map(([id, c]) => (
        <div key={id} className="absolute transition-all duration-100 ease-linear"
          style={{ left: `${c.x * 100}%`, top: `${c.y * 100}%`, transform: 'translate(-2px,-2px)' }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill={c.color}>
            <path d="M5.5 3.21V20.8c0 .45.54.67.85.35l4.86-4.86a.5.5 0 0 1 .35-.15h6.87c.45 0 .67-.54.35-.85L6.35 2.86a.5.5 0 0 0-.85.35Z"
              stroke="#fff" strokeWidth="1.5" strokeLinejoin="round"/>
          </svg>
          <span className="absolute left-5 top-3 text-[9px] font-bold px-1.5 py-0.5 rounded-md text-white whitespace-nowrap"
            style={{ background: c.color }}>{c.name}</span>
        </div>
      ))}
    </div>
  );
}
