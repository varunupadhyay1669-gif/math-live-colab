import React, { useState, useRef } from 'react';
import { Socket } from 'socket.io-client';

interface StudentReactionsProps {
  socket: Socket | null;
  roomId: string;
  studentName: string;
  isPaused: boolean;
  visible: boolean;
}

const REACTIONS = [
  { emoji: '✅', label: 'Got it!' },
  { emoji: '😕', label: 'Confused' },
  { emoji: '🐌', label: 'Slow down' },
  { emoji: '🤯', label: 'Mind blown' },
];

export default function StudentReactions({ socket, roomId, studentName, isPaused, visible }: StudentReactionsProps) {
  const [cooldown, setCooldown] = useState(false);
  const [lastEmoji, setLastEmoji] = useState<string | null>(null);

  if (!visible || isPaused) return null;

  const sendReaction = (emoji: string, label: string) => {
    if (!socket || cooldown) return;
    socket.emit('student_reaction', { roomId, emoji, label, studentName });
    setLastEmoji(emoji);
    setCooldown(true);
    setTimeout(() => {
      setCooldown(false);
      setLastEmoji(null);
    }, 2000);
  };

  return (
    <div className="absolute bottom-5 left-1/2 -translate-x-1/2 z-30 animate-slide-up">
      <div className="flex items-center gap-1.5 px-3 py-2 rounded-2xl"
        style={{
          background: 'rgba(255,255,255,0.9)',
          backdropFilter: 'blur(12px)',
          border: '1px solid var(--border-subtle)',
          boxShadow: 'var(--shadow-lg)',
        }}>
        {REACTIONS.map(r => (
          <button key={r.emoji}
            onClick={() => sendReaction(r.emoji, r.label)}
            disabled={cooldown}
            className="px-3 py-1.5 rounded-xl transition-all text-sm font-semibold flex items-center gap-1"
            style={{
              color: 'var(--text-primary)',
              background: lastEmoji === r.emoji ? 'var(--accent-indigo-light)' : 'transparent',
              opacity: cooldown && lastEmoji !== r.emoji ? 0.5 : 1,
              transform: lastEmoji === r.emoji ? 'scale(1.1)' : 'scale(1)',
            }}
            onMouseEnter={e => !cooldown && (e.currentTarget.style.background = 'var(--bg-surface)')}
            onMouseLeave={e => (e.currentTarget.style.background = lastEmoji === r.emoji ? 'var(--accent-indigo-light)' : 'transparent')}>
            {r.emoji} <span className="hidden sm:inline text-[12px]" style={{ color: 'var(--text-secondary)' }}>{r.label}</span>
          </button>
        ))}
        <div className="h-5 w-px mx-1" style={{ background: 'var(--border-subtle)' }} />
        <button
          onClick={() => {
            if (!socket) return;
            socket.emit('raise_hand', { roomId, studentName });
          }}
          className="px-3 py-1.5 rounded-xl transition-all text-sm font-semibold flex items-center gap-1"
          style={{ color: 'var(--text-primary)', background: 'transparent' }}
          onMouseEnter={e => (e.currentTarget.style.background = 'var(--accent-amber-light)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
          ✋ <span className="hidden sm:inline text-[12px]" style={{ color: 'var(--text-secondary)' }}>Raise Hand</span>
        </button>
      </div>
    </div>
  );
}
