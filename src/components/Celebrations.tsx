import React from 'react';

const CONFETTI_COLORS = ['#6366F1', '#10B981', '#F59E0B', '#F43F5E', '#8B5CF6', '#EC4899', '#0EA5E9', '#F97316'];

interface CelebrationsProps {
  show: boolean;
  type?: 'confetti' | 'fireworks' | 'stars';
}

export default function Celebrations({ show, type = 'confetti' }: CelebrationsProps) {
  if (!show) return null;

  const count = type === 'fireworks' ? 100 : type === 'stars' ? 50 : 80;
  const shapes = type === 'stars'
    ? Array.from({ length: count }).map(() => '★')
    : null;

  return (
    <div className="absolute inset-0 pointer-events-none z-40 overflow-hidden">
      {Array.from({ length: count }).map((_, i) => {
        const size = 6 + Math.random() * 8;
        const left = Math.random() * 100;
        const duration = 2 + Math.random() * 2.5;
        const delay = Math.random() * 0.8;
        const rotation = Math.random() * 360;
        const color = CONFETTI_COLORS[i % CONFETTI_COLORS.length];

        if (shapes) {
          return (
            <div key={i} className="absolute" style={{
              left: `${left}%`,
              top: '-5%',
              fontSize: `${12 + Math.random() * 14}px`,
              color,
              animation: `confetti-fall ${duration}s ease-in forwards`,
              animationDelay: `${delay}s`,
              transform: `rotate(${rotation}deg)`,
              textShadow: `0 0 6px ${color}`,
            }}>
              {shapes[i]}
            </div>
          );
        }

        return (
          <div key={i} className="absolute" style={{
            left: `${left}%`,
            top: '-5%',
            width: `${size}px`,
            height: `${size}px`,
            background: color,
            borderRadius: Math.random() > 0.5 ? '50%' : '2px',
            animation: `confetti-fall ${duration}s ease-in forwards`,
            animationDelay: `${delay}s`,
            transform: `rotate(${rotation}deg)`,
          }} />
        );
      })}
    </div>
  );
}
