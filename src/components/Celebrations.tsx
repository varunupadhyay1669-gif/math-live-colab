import React, { useMemo } from 'react';

const CONFETTI_COLORS = ['#6366F1', '#10B981', '#F59E0B', '#F43F5E', '#8B5CF6', '#EC4899', '#0EA5E9', '#F97316'];

interface CelebrationsProps {
  show: boolean;
  type?: 'confetti' | 'fireworks' | 'stars';
}

interface Particle {
  size: number;
  left: number;
  duration: number;
  delay: number;
  rotation: number;
  color: string;
  round: boolean;
  starSize: number;
}

export default function Celebrations({ show, type = 'confetti' }: CelebrationsProps) {
  // Particle geometry is randomized ONCE per burst. Computing Math.random()
  // in render meant every parent re-render (chat, cursors, attention ticks —
  // frequent during a live class) regenerated positions/durations, changing
  // the inline `animation` shorthand and restarting all ~80 particle
  // animations mid-flight: the confetti visibly teleported and stuttered.
  const particles = useMemo<Particle[]>(() => {
    const count = type === 'fireworks' ? 100 : type === 'stars' ? 50 : 80;
    return Array.from({ length: count }).map((_, i) => ({
      size: 6 + Math.random() * 8,
      left: Math.random() * 100,
      duration: 2 + Math.random() * 2.5,
      delay: Math.random() * 0.8,
      rotation: Math.random() * 360,
      color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
      round: Math.random() > 0.5,
      starSize: 12 + Math.random() * 14,
    }));
    // Re-roll only when a new burst starts or the style changes.
  }, [show, type]);

  if (!show) return null;

  return (
    <div className="absolute inset-0 pointer-events-none z-40 overflow-hidden">
      {particles.map((p, i) => {
        if (type === 'stars') {
          return (
            <div key={i} className="absolute" style={{
              left: `${p.left}%`,
              top: '-5%',
              fontSize: `${p.starSize}px`,
              color: p.color,
              animation: `confetti-fall ${p.duration}s ease-in forwards`,
              animationDelay: `${p.delay}s`,
              transform: `rotate(${p.rotation}deg)`,
              textShadow: `0 0 6px ${p.color}`,
            }}>
              ★
            </div>
          );
        }
        return (
          <div key={i} className="absolute" style={{
            left: `${p.left}%`,
            top: '-5%',
            width: `${p.size}px`,
            height: `${p.size}px`,
            background: p.color,
            borderRadius: p.round ? '50%' : '2px',
            animation: `confetti-fall ${p.duration}s ease-in forwards`,
            animationDelay: `${p.delay}s`,
            transform: `rotate(${p.rotation}deg)`,
          }} />
        );
      })}
    </div>
  );
}
