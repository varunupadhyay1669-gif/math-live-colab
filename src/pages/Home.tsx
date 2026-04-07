import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { v4 as uuidv4 } from "uuid";

const MATH_SYMBOLS = ["∫", "π", "∑", "√", "∞", "Δ", "θ", "λ", "Ω", "±", "÷", "×", "≈", "≠", "≤", "∂"];

function FloatingSymbol({ symbol, delay, duration, left, size }: { symbol: string; delay: number; duration: number; left: number; size: number }) {
  return (
    <div
      className="absolute pointer-events-none select-none"
      style={{
        left: `${left}%`,
        top: `-60px`,
        fontSize: `${size}px`,
        opacity: 0.07,
        animation: `float-slow ${duration}s ease-in-out infinite`,
        animationDelay: `${delay}s`,
        color: 'white',
      }}
    >
      {symbol}
    </div>
  );
}

export default function Home() {
  const navigate = useNavigate();
  const [teacherName, setTeacherName] = useState(() => localStorage.getItem('mathslive_teacher_name') || '');
  const [studentName, setStudentName] = useState('');
  const [roomCode, setRoomCode] = useState("");
  const [recentRooms, setRecentRooms] = useState<Array<{ id: string; name: string; date: string }>>([]);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    try {
      const stored = localStorage.getItem('mathslive_recent_rooms');
      if (stored) setRecentRooms(JSON.parse(stored));
    } catch {}
  }, []);

  const createRoom = () => {
    if (!teacherName.trim()) return;
    localStorage.setItem('mathslive_teacher_name', teacherName.trim());
    const newRoomId = uuidv4().slice(0, 8);
    // Save to recent
    const updated = [{ id: newRoomId, name: teacherName, date: new Date().toLocaleString() }, ...recentRooms].slice(0, 5);
    localStorage.setItem('mathslive_recent_rooms', JSON.stringify(updated));
    navigate(`/room/${newRoomId}?name=${encodeURIComponent(teacherName.trim())}`);
  };

  const joinRoom = (e: React.FormEvent) => {
    e.preventDefault();
    if (roomCode.trim() && studentName.trim()) {
      navigate(`/live/${roomCode.trim()}?name=${encodeURIComponent(studentName.trim())}`);
    }
  };

  const joinRecent = (id: string) => {
    navigate(`/room/${id}?name=${encodeURIComponent(teacherName.trim() || 'Teacher')}`);
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4 md:p-8 relative overflow-hidden"
      style={{ background: 'var(--bg-primary)' }}>
      
      {/* Animated Background */}
      <div className="absolute inset-0 overflow-hidden">
        {/* Gradient orbs */}
        <div className="absolute w-[500px] h-[500px] rounded-full animate-pulse-glow"
          style={{ top: '-10%', right: '-5%', background: 'radial-gradient(circle, rgba(79,143,255,0.08) 0%, transparent 70%)' }} />
        <div className="absolute w-[400px] h-[400px] rounded-full animate-pulse-glow"
          style={{ bottom: '-10%', left: '-5%', background: 'radial-gradient(circle, rgba(139,92,246,0.08) 0%, transparent 70%)', animationDelay: '1.5s' }} />
        <div className="absolute w-[300px] h-[300px] rounded-full animate-pulse-glow"
          style={{ top: '40%', left: '50%', background: 'radial-gradient(circle, rgba(52,211,153,0.06) 0%, transparent 70%)', animationDelay: '3s' }} />
        
        {/* Floating math symbols */}
        {MATH_SYMBOLS.map((s, i) => (
          <FloatingSymbol
            key={i}
            symbol={s}
            delay={i * 0.7}
            duration={8 + (i % 5) * 2}
            left={5 + (i * 6) % 90}
            size={28 + (i % 4) * 12}
          />
        ))}
      </div>

      <div className="max-w-4xl w-full relative z-10">
        {/* Hero */}
        <div className="text-center mb-12 animate-slide-up">
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full mb-6"
            style={{ background: 'var(--accent-blue-glow)', border: '1px solid rgba(79,143,255,0.2)' }}>
            <span className="text-xl">🧮</span>
            <span style={{ color: 'var(--accent-blue)', fontSize: '13px', fontWeight: 600, letterSpacing: '0.05em' }}>
              INTERACTIVE MATHS CLASSROOM
            </span>
          </div>
          
          <h1 className="text-5xl md:text-7xl font-bold tracking-tight mb-4 leading-tight">
            <span className="gradient-text">MathsLive</span>
          </h1>
          
          <p className="text-lg md:text-xl max-w-2xl mx-auto leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
            Upload interactive HTML simulations. Teach visually.
            <br className="hidden md:block" />
            Your student sees and interacts — <span style={{ color: 'var(--accent-emerald)' }}>in real time</span>.
          </p>
        </div>

        {/* Cards */}
        <div className="grid md:grid-cols-2 gap-6 max-w-3xl mx-auto mb-12" style={{ animationDelay: '0.15s' }}>
          
          {/* Teacher Card */}
          <div className="glass card-hover p-8 animate-slide-up"
            style={{ borderRadius: 'var(--radius-xl)', animationDelay: '0.2s' }}>
            <div className="flex items-center gap-3 mb-6">
              <div className="w-12 h-12 rounded-xl flex items-center justify-center text-2xl"
                style={{ background: 'var(--accent-emerald-glow)', border: '1px solid rgba(52,211,153,0.2)' }}>
                🎓
              </div>
              <div>
                <h2 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>Launch Session</h2>
                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Create a live classroom</p>
              </div>
            </div>
            
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>Your Name</label>
                <input
                  type="text"
                  placeholder="e.g. Mr. Sharma"
                  value={teacherName}
                  onChange={(e) => setTeacherName(e.target.value)}
                  className="input-field"
                  onKeyDown={(e) => e.key === 'Enter' && createRoom()}
                />
              </div>
              <button
                onClick={createRoom}
                disabled={!teacherName.trim()}
                className="btn-primary w-full text-base disabled:opacity-40 disabled:cursor-not-allowed disabled:transform-none"
                style={{ background: !teacherName.trim() ? 'var(--bg-elevated)' : undefined }}
              >
                🚀 Create Room
              </button>
            </div>
          </div>

          {/* Student Card */}
          <div className="glass card-hover p-8 animate-slide-up"
            style={{ borderRadius: 'var(--radius-xl)', animationDelay: '0.35s' }}>
            <div className="flex items-center gap-3 mb-6">
              <div className="w-12 h-12 rounded-xl flex items-center justify-center text-2xl"
                style={{ background: 'var(--accent-blue-glow)', border: '1px solid rgba(79,143,255,0.2)' }}>
                🎒
              </div>
              <div>
                <h2 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>Join Session</h2>
                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Enter your teacher's room</p>
              </div>
            </div>
            
            <form onSubmit={joinRoom} className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>Your Name</label>
                <input
                  type="text"
                  placeholder="e.g. Arjun"
                  value={studentName}
                  onChange={(e) => setStudentName(e.target.value)}
                  className="input-field"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>Room Code</label>
                <input
                  type="text"
                  placeholder="Paste room code"
                  value={roomCode}
                  onChange={(e) => setRoomCode(e.target.value)}
                  className="input-field text-center"
                  style={{ fontFamily: "'JetBrains Mono', monospace", letterSpacing: '0.1em' }}
                />
              </div>
              <button
                type="submit"
                disabled={!roomCode.trim() || !studentName.trim()}
                className="btn-primary w-full text-base disabled:opacity-40 disabled:cursor-not-allowed disabled:transform-none"
                style={{ background: (!roomCode.trim() || !studentName.trim()) ? 'var(--bg-elevated)' : undefined }}
              >
                ✨ Join Classroom
              </button>
            </form>
          </div>
        </div>

        {/* Recent Rooms */}
        {recentRooms.length > 0 && (
          <div className="max-w-3xl mx-auto animate-slide-up" style={{ animationDelay: '0.5s' }}>
            <h3 className="text-sm font-semibold mb-3 text-center" style={{ color: 'var(--text-muted)', letterSpacing: '0.05em' }}>
              RECENT SESSIONS
            </h3>
            <div className="flex flex-wrap justify-center gap-2">
              {recentRooms.map((room) => (
                <button
                  key={room.id}
                  onClick={() => joinRecent(room.id)}
                  className="glass-light px-4 py-2 rounded-xl text-sm font-medium transition-all hover:border-blue-500/30"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  <span style={{ color: 'var(--accent-blue)', fontFamily: "'JetBrains Mono', monospace", fontSize: '12px' }}>
                    {room.id}
                  </span>
                  <span className="mx-2" style={{ color: 'var(--text-muted)' }}>·</span>
                  <span>{room.date}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Features */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 max-w-3xl mx-auto mt-16 animate-slide-up" style={{ animationDelay: '0.6s' }}>
          {[
            { icon: '📤', label: 'Upload HTML' },
            { icon: '👆', label: 'Real-time Sync' },
            { icon: '💬', label: 'Live Chat' },
            { icon: '🎯', label: 'Pop Quizzes' },
          ].map((f, i) => (
            <div key={i} className="text-center p-4 rounded-xl" style={{ background: 'rgba(255,255,255,0.02)' }}>
              <div className="text-2xl mb-2">{f.icon}</div>
              <div className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>{f.label}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
