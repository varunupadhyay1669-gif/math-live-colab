import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { v4 as uuidv4 } from "uuid";

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
      style={{ background: 'var(--gradient-hero)' }}>

      {/* Soft decorative blobs */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute w-[600px] h-[600px] rounded-full animate-pulse-glow"
          style={{ top: '-15%', right: '-10%', background: 'radial-gradient(circle, rgba(99,102,241,0.08) 0%, transparent 70%)' }} />
        <div className="absolute w-[500px] h-[500px] rounded-full animate-pulse-glow"
          style={{ bottom: '-15%', left: '-10%', background: 'radial-gradient(circle, rgba(139,92,246,0.07) 0%, transparent 70%)', animationDelay: '1.5s' }} />
        <div className="absolute w-[350px] h-[350px] rounded-full animate-pulse-glow"
          style={{ top: '30%', left: '45%', background: 'radial-gradient(circle, rgba(244,63,94,0.05) 0%, transparent 70%)', animationDelay: '3s' }} />
      </div>

      <div className="max-w-4xl w-full relative z-10">
        {/* Hero */}
        <div className="text-center mb-12 animate-slide-up">
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full mb-6"
            style={{ background: 'var(--accent-indigo-light)', border: '1px solid rgba(99,102,241,0.15)' }}>
            <span className="text-lg">🧮</span>
            <span style={{ color: 'var(--accent-indigo)', fontSize: '12px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
              Interactive Maths Classroom
            </span>
          </div>

          <h1 className="font-display text-5xl md:text-7xl font-extrabold tracking-tight mb-4 leading-tight">
            <span className="gradient-text">MathsLive</span>
          </h1>

          <p className="text-lg md:text-xl max-w-xl mx-auto leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
            Upload interactive HTML simulations and teach visually.
            <br className="hidden md:block" />
            Your student interacts — <span style={{ color: 'var(--accent-indigo)', fontWeight: 600 }}>in real time</span>.
          </p>
        </div>

        {/* Cards */}
        <div className="grid md:grid-cols-2 gap-6 max-w-3xl mx-auto mb-10">

          {/* Teacher Card */}
          <div className="card-hover p-7 animate-slide-up"
            style={{
              background: 'var(--bg-card)', borderRadius: 'var(--radius-xl)',
              border: '1px solid var(--border-subtle)', boxShadow: 'var(--shadow-md)',
              animationDelay: '0.15s',
            }}>
            <div className="flex items-center gap-3 mb-5">
              <div className="w-11 h-11 rounded-xl flex items-center justify-center text-xl"
                style={{ background: 'var(--accent-emerald-light)', border: '1px solid rgba(16,185,129,0.15)' }}>
                🎓
              </div>
              <div>
                <h2 className="font-display text-lg font-bold" style={{ color: 'var(--text-primary)' }}>Launch Session</h2>
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Create a live classroom</p>
              </div>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-secondary)', letterSpacing: '0.03em' }}>Your Name</label>
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
                className="btn-primary w-full justify-center text-sm disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none"
              >
                🚀 Create Room
              </button>
            </div>
          </div>

          {/* Student Card */}
          <div className="card-hover p-7 animate-slide-up"
            style={{
              background: 'var(--bg-card)', borderRadius: 'var(--radius-xl)',
              border: '1px solid var(--border-subtle)', boxShadow: 'var(--shadow-md)',
              animationDelay: '0.3s',
            }}>
            <div className="flex items-center gap-3 mb-5">
              <div className="w-11 h-11 rounded-xl flex items-center justify-center text-xl"
                style={{ background: 'var(--accent-indigo-light)', border: '1px solid rgba(99,102,241,0.15)' }}>
                🎒
              </div>
              <div>
                <h2 className="font-display text-lg font-bold" style={{ color: 'var(--text-primary)' }}>Join Session</h2>
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Enter your teacher's room</p>
              </div>
            </div>

            <form onSubmit={joinRoom} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-secondary)', letterSpacing: '0.03em' }}>Your Name</label>
                <input
                  type="text"
                  placeholder="e.g. Arjun"
                  value={studentName}
                  onChange={(e) => setStudentName(e.target.value)}
                  className="input-field"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-secondary)', letterSpacing: '0.03em' }}>Room Code</label>
                <input
                  type="text"
                  placeholder="Paste room code"
                  value={roomCode}
                  onChange={(e) => setRoomCode(e.target.value)}
                  className="input-field text-center"
                  style={{ fontFamily: "'JetBrains Mono', monospace", letterSpacing: '0.12em' }}
                />
              </div>
              <button
                type="submit"
                disabled={!roomCode.trim() || !studentName.trim()}
                className="btn-primary w-full justify-center text-sm disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none"
              >
                ✨ Join Classroom
              </button>
            </form>
          </div>
        </div>

        {/* Recent Rooms */}
        {recentRooms.length > 0 && (
          <div className="max-w-3xl mx-auto animate-slide-up" style={{ animationDelay: '0.45s' }}>
            <h3 className="text-xs font-bold mb-3 text-center" style={{ color: 'var(--text-muted)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
              Recent Sessions
            </h3>
            <div className="flex flex-wrap justify-center gap-2">
              {recentRooms.map((room) => (
                <button
                  key={room.id}
                  onClick={() => joinRecent(room.id)}
                  className="btn"
                  style={{ fontSize: '12px' }}
                >
                  <span style={{ color: 'var(--accent-indigo)', fontFamily: "'JetBrains Mono', monospace", fontSize: '11px', fontWeight: 600 }}>
                    {room.id}
                  </span>
                  <span style={{ color: 'var(--text-muted)' }}>·</span>
                  <span style={{ color: 'var(--text-secondary)' }}>{room.date}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Feature pills */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 max-w-3xl mx-auto mt-14 animate-slide-up" style={{ animationDelay: '0.55s' }}>
          {[
            { icon: '📤', label: 'Upload HTML', color: 'var(--accent-violet-light)' },
            { icon: '🔄', label: 'Real-time Sync', color: 'var(--accent-indigo-light)' },
            { icon: '💬', label: 'Live Chat', color: 'var(--accent-emerald-light)' },
            { icon: '🎯', label: 'Pop Quizzes', color: 'var(--accent-amber-light)' },
          ].map((f, i) => (
            <div key={i} className="text-center p-4 rounded-xl transition-all hover:scale-105"
              style={{ background: f.color, border: '1px solid var(--border-subtle)' }}>
              <div className="text-2xl mb-1.5">{f.icon}</div>
              <div className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>{f.label}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
