import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { v4 as uuidv4 } from "uuid";

export default function Home() {
  const navigate = useNavigate();
  const [teacherName, setTeacherName] = useState(() => localStorage.getItem('mathslive_teacher_name') || '');
  const [studentName, setStudentName] = useState('');
  const [roomCode, setRoomCode] = useState("");
  const [recentRooms, setRecentRooms] = useState<Array<{ id: string; name: string; date: string }>>([]);
  const [activeCard, setActiveCard] = useState<'teacher' | 'student' | null>(null);

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
    <div className="min-h-screen flex flex-col items-center justify-center relative overflow-hidden"
      style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)' }}>

      {/* Background mesh gradient */}
      <div className="fixed inset-0 pointer-events-none z-0" style={{ background: 'var(--gradient-mesh)' }} />
      <div className="fixed inset-0 pointer-events-none z-0"
        style={{ backgroundImage: 'radial-gradient(var(--border-subtle) 1px, transparent 1px)', backgroundSize: '32px 32px', opacity: 0.5 }} />

      <div className="relative z-10 flex flex-col items-center gap-6 max-w-4xl w-full px-6">

        {/* Badge */}
        <div className="badge badge-indigo">
          <span className="connection-dot online" style={{ width: 6, height: 6 }} />
          System Active
        </div>

        {/* Title */}
        <h1 className="font-display font-extrabold text-center leading-none"
          style={{ fontSize: 'clamp(48px, 10vw, 96px)', letterSpacing: '-0.04em', color: 'var(--text-primary)' }}>
          Maths<span className="gradient-text">Live</span>
        </h1>

        {/* Subtitle */}
        <p className="text-center max-w-lg mx-auto" style={{ color: 'var(--text-secondary)', fontSize: '16px', lineHeight: '1.7' }}>
          Real-time collaborative platform for interactive HTML simulations. Teach, demonstrate, and explore together.
        </p>

        {/* Role Selection Buttons */}
        <div className="flex items-center gap-4 pt-2">
          <button onClick={() => setActiveCard(activeCard === 'teacher' ? null : 'teacher')}
            className="btn-primary"
            style={{ padding: '14px 28px', fontSize: '15px' }}>
            Launch Session
            <span style={{ fontSize: '16px' }}>&#8594;</span>
          </button>
          <button onClick={() => setActiveCard(activeCard === 'student' ? null : 'student')}
            className="btn-secondary"
            style={{ padding: '14px 28px', fontSize: '15px' }}>
            Join Session
          </button>
        </div>

        {/* Cards */}
        <div className="w-full grid md:grid-cols-2 gap-5 mt-2">

          {/* Teacher Card */}
          <div className={`panel p-7 flex flex-col gap-5 transition-all duration-300 ${
            activeCard === 'teacher' ? 'opacity-100 ring-2' : 'opacity-60 hover:opacity-80'
          }`} style={{
            borderColor: activeCard === 'teacher' ? 'var(--accent-indigo)' : 'var(--border-subtle)',
            boxShadow: activeCard === 'teacher' ? 'var(--shadow-lg), var(--shadow-glow-indigo)' : 'var(--shadow-sm)',
            '--tw-ring-color': 'var(--accent-indigo)',
          } as React.CSSProperties}>

            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center"
                style={{ background: 'var(--accent-indigo-light)' }}>
                <span style={{ fontSize: '20px' }}>&#128640;</span>
              </div>
              <div>
                <h3 className="font-display text-lg font-bold" style={{ color: 'var(--text-primary)' }}>Launch Session</h3>
                <p className="text-[13px]" style={{ color: 'var(--text-muted)' }}>Create a room and share simulations</p>
              </div>
            </div>

            <div>
              <label className="block text-[11px] font-bold uppercase mb-1.5"
                style={{ color: 'var(--text-muted)', letterSpacing: '0.08em' }}>Session Title</label>
              <input
                type="text"
                placeholder="e.g. Calculus Visualization 101"
                value={teacherName}
                onChange={(e) => setTeacherName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && createRoom()}
                onFocus={() => setActiveCard('teacher')}
                className="input-field"
              />
            </div>

            <button onClick={createRoom} disabled={!teacherName.trim()} className="btn-primary w-full justify-center disabled:opacity-40">
              Create Room
            </button>
          </div>

          {/* Student Card */}
          <div className={`panel p-7 flex flex-col gap-5 transition-all duration-300 ${
            activeCard === 'student' ? 'opacity-100 ring-2' : 'opacity-60 hover:opacity-80'
          }`} style={{
            borderColor: activeCard === 'student' ? 'var(--accent-violet)' : 'var(--border-subtle)',
            boxShadow: activeCard === 'student' ? 'var(--shadow-lg), var(--shadow-glow-violet)' : 'var(--shadow-sm)',
            '--tw-ring-color': 'var(--accent-violet)',
          } as React.CSSProperties}>

            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center"
                style={{ background: 'var(--accent-violet-light)' }}>
                <span style={{ fontSize: '20px' }}>&#128101;</span>
              </div>
              <div>
                <h3 className="font-display text-lg font-bold" style={{ color: 'var(--text-primary)' }}>Join Session</h3>
                <p className="text-[13px]" style={{ color: 'var(--text-muted)' }}>Enter a code to join a live session</p>
              </div>
            </div>

            <form onSubmit={joinRoom} className="flex flex-col gap-3">
              <div>
                <label className="block text-[11px] font-bold uppercase mb-1.5"
                  style={{ color: 'var(--text-muted)', letterSpacing: '0.08em' }}>Your Name</label>
                <input
                  type="text"
                  placeholder="e.g. Arjun"
                  value={studentName}
                  onChange={(e) => setStudentName(e.target.value)}
                  onFocus={() => setActiveCard('student')}
                  className="input-field"
                />
              </div>
              <div>
                <label className="block text-[11px] font-bold uppercase mb-1.5"
                  style={{ color: 'var(--text-muted)', letterSpacing: '0.08em' }}>Room Code</label>
                <input
                  type="text"
                  placeholder="Enter room code"
                  value={roomCode}
                  onChange={(e) => setRoomCode(e.target.value)}
                  onFocus={() => setActiveCard('student')}
                  className="input-field"
                  style={{ fontFamily: "'JetBrains Mono', monospace", letterSpacing: '0.15em', textAlign: 'center' }}
                />
              </div>
              <button type="submit" disabled={!roomCode.trim() || !studentName.trim()}
                className="btn-primary w-full justify-center disabled:opacity-40"
                style={{ background: 'linear-gradient(135deg, #8B5CF6, #A78BFA, #7C3AED)' }}>
                Join Room
              </button>
            </form>
          </div>
        </div>

        {/* Recent rooms */}
        {recentRooms.length > 0 && (
          <div className="flex flex-col items-center gap-2 mt-2">
            <span className="text-[11px] font-bold uppercase" style={{ color: 'var(--text-muted)', letterSpacing: '0.08em' }}>
              Recent Sessions
            </span>
            <div className="flex flex-wrap justify-center gap-2">
              {recentRooms.map((room) => (
                <button key={room.id} onClick={() => joinRecent(room.id)}
                  className="btn text-[12px]"
                  style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                  {room.id}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Footer */}
        <p className="text-[12px] mt-4" style={{ color: 'var(--text-muted)' }}>
          Built for teachers who love interactive learning
        </p>
      </div>
    </div>
  );
}
