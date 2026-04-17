import React from 'react';

interface LeaderboardEntry {
  studentName: string;
  xp: number;
  streak: number;
  bestStreak?: number;
  correct?: number;
  total?: number;
}

interface LeaderboardProps {
  entries: LeaderboardEntry[];
  open: boolean;
  onClose: () => void;
  currentStudentName?: string; // Highlight this row
}

const MEDALS = ['🥇', '🥈', '🥉'];

function levelFromXp(xp: number) {
  return Math.floor(xp / 100) + 1;
}

function progressToNextLevel(xp: number) {
  return xp % 100;
}

export default function Leaderboard({ entries, open, onClose, currentStudentName }: LeaderboardProps) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center animate-fade-in"
      style={{ background: 'rgba(8, 10, 18, 0.55)', backdropFilter: 'blur(6px)' }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-md mx-4 rounded-2xl overflow-hidden animate-scale-in"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(250,250,255,0.98) 100%)',
          border: '1px solid var(--border-subtle, rgba(0,0,0,0.08))',
          boxShadow: '0 40px 100px rgba(0,0,0,0.35), 0 0 0 1px rgba(255,255,255,0.1) inset',
        }}
      >
        {/* Header */}
        <div
          className="px-6 py-5 flex items-center justify-between"
          style={{
            background: 'linear-gradient(135deg, #6366F1 0%, #8B5CF6 50%, #EC4899 100%)',
            color: '#fff',
          }}
        >
          <div className="flex items-center gap-3">
            <div style={{ fontSize: 28 }}>🏆</div>
            <div>
              <h2 className="font-display font-bold text-lg leading-tight">XP Leaderboard</h2>
              <p className="text-xs opacity-90">{entries.length} {entries.length === 1 ? 'player' : 'players'}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-9 h-9 rounded-full flex items-center justify-center transition-all"
            style={{ background: 'rgba(255,255,255,0.2)', color: '#fff' }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.32)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.2)')}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div style={{ maxHeight: '60vh', overflowY: 'auto' }}>
          {entries.length === 0 ? (
            <div className="text-center py-12 px-6">
              <div className="text-4xl mb-3 opacity-40">📝</div>
              <p className="font-semibold" style={{ color: 'var(--text-primary, #0F1117)' }}>
                No scores yet
              </p>
              <p className="text-sm mt-1" style={{ color: 'var(--text-muted, #9CA3AF)' }}>
                Students earn XP by answering gate questions correctly.
              </p>
            </div>
          ) : (
            <ul className="divide-y" style={{ borderColor: 'var(--border-subtle, rgba(0,0,0,0.06))' }}>
              {entries.map((e, i) => {
                const level = levelFromXp(e.xp);
                const progress = progressToNextLevel(e.xp);
                const isCurrent = currentStudentName === e.studentName;
                const rankBadge = i < 3 ? MEDALS[i] : `#${i + 1}`;
                const accuracy = e.total && e.total > 0 ? Math.round(((e.correct || 0) / e.total) * 100) : null;

                return (
                  <li
                    key={e.studentName}
                    className="px-5 py-3 flex items-center gap-3"
                    style={{
                      background: isCurrent
                        ? 'linear-gradient(90deg, rgba(99,102,241,0.1), rgba(139,92,246,0.05))'
                        : 'transparent',
                    }}
                  >
                    {/* Rank */}
                    <div
                      className="shrink-0 flex items-center justify-center font-bold"
                      style={{
                        width: 40,
                        height: 40,
                        fontSize: i < 3 ? 22 : 14,
                        color: i < 3 ? undefined : 'var(--text-muted, #9CA3AF)',
                      }}
                    >
                      {rankBadge}
                    </div>

                    {/* Name + Level */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span
                          className="font-semibold truncate"
                          style={{ color: 'var(--text-primary, #0F1117)', fontSize: 14 }}
                        >
                          {e.studentName}
                        </span>
                        {isCurrent && (
                          <span
                            style={{
                              fontSize: 9,
                              fontWeight: 800,
                              padding: '2px 6px',
                              borderRadius: 6,
                              background: '#6366F1',
                              color: '#fff',
                            }}
                          >
                            YOU
                          </span>
                        )}
                        {e.streak >= 3 && (
                          <span
                            style={{ fontSize: 11, fontWeight: 700, color: '#F59E0B' }}
                            title={`${e.streak} in a row`}
                          >
                            🔥 {e.streak}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 mt-1">
                        <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted, #9CA3AF)' }}>
                          LVL {level}
                        </span>
                        <div
                          style={{
                            flex: 1,
                            height: 5,
                            borderRadius: 3,
                            background: 'rgba(0,0,0,0.07)',
                            overflow: 'hidden',
                          }}
                        >
                          <div
                            style={{
                              width: `${progress}%`,
                              height: '100%',
                              background: 'linear-gradient(90deg, #6366F1, #8B5CF6)',
                              borderRadius: 3,
                              transition: 'width 0.6s cubic-bezier(.34,1.56,.64,1)',
                            }}
                          />
                        </div>
                        {accuracy !== null && (
                          <span style={{ fontSize: 10, color: 'var(--text-muted, #9CA3AF)', fontVariantNumeric: 'tabular-nums' }}>
                            {accuracy}%
                          </span>
                        )}
                      </div>
                    </div>

                    {/* XP */}
                    <div className="text-right shrink-0">
                      <div
                        style={{
                          fontSize: 16,
                          fontWeight: 800,
                          color: 'var(--text-primary, #0F1117)',
                          fontVariantNumeric: 'tabular-nums',
                        }}
                      >
                        {e.xp}
                      </div>
                      <div style={{ fontSize: 9, color: 'var(--text-muted, #9CA3AF)', fontWeight: 700, letterSpacing: 0.5 }}>
                        XP
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
