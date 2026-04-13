import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { v4 as uuidv4 } from "uuid";

export default function Home() {
  const navigate = useNavigate();
  const [teacherName, setTeacherName] = useState(() => localStorage.getItem('mathslive_teacher_name') || '');
  const [studentName, setStudentName] = useState('');
  const [roomCode, setRoomCode] = useState("");
  const [recentRooms, setRecentRooms] = useState<Array<{ id: string; name: string; date: string }>>([]);

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

  const font = "'Manrope', sans-serif";
  const mono = "'JetBrains Mono', monospace";

  const [activeCard, setActiveCard] = useState<'teacher' | 'student' | null>(null);

  return (
    <div className="min-h-screen overflow-x-hidden relative flex flex-col items-center justify-center" style={{ background: '#0c0e12', color: '#f6f6fc', fontFamily: font }}>
      {/* Dot grid */}
      <div className="fixed inset-0 pointer-events-none z-0" style={{ backgroundImage: 'radial-gradient(#46484d 1px, transparent 1px)', backgroundSize: '32px 32px', opacity: 0.15 }} />
      {/* Glow */}
      <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] rounded-full pointer-events-none z-0" style={{ background: 'rgba(204,151,255,0.05)', filter: 'blur(120px)' }} />

      <div className="relative z-10 flex flex-col items-center gap-8 max-w-4xl w-full px-6">
        {/* Badge */}
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-[#46484d]/20" style={{ background: '#23262c' }}>
          <span className="w-1.5 h-1.5 rounded-full bg-[#cc97ff] animate-pulse" />
          <span className="text-[10px] font-bold uppercase text-[#aaabb0]" style={{ letterSpacing: '0.2em' }}>System Status: Active</span>
        </div>

        {/* Title */}
        <h1 className="font-extrabold leading-none text-center" style={{ fontSize: 'clamp(56px, 11vw, 120px)', letterSpacing: '-0.05em' }}>
          Maths<span className="text-[#cc97ff]">Live</span>
        </h1>

        {/* Subtitle */}
        <p className="text-lg md:text-xl font-light max-w-2xl mx-auto leading-relaxed text-center" style={{ color: '#aaabb0' }}>
          A sophisticated computational laboratory for interactive HTML simulations. Experience the precision of mathematics through real-time synced visualization.
        </p>

        {/* Two buttons */}
        <div className="pt-4 flex flex-col sm:flex-row items-center justify-center gap-5">
          <button
            onClick={() => setActiveCard(activeCard === 'teacher' ? null : 'teacher')}
            className="flex items-center gap-3 px-8 py-4 bg-[#cc97ff] text-black font-bold rounded-xl text-sm transition-all hover:-translate-y-0.5 active:scale-[0.98]"
            style={{ boxShadow: '0 0 30px rgba(204,151,255,0.3)' }}>
            Join as Teacher
            <span style={{ fontSize: '18px' }}>→</span>
          </button>
          <button
            onClick={() => setActiveCard(activeCard === 'student' ? null : 'student')}
            className="px-8 py-4 border border-[#46484d]/20 rounded-xl font-bold text-sm text-[#f6f6fc] hover:bg-[#1d2025] transition-all active:scale-[0.98]">
            Join as Student
          </button>
        </div>

        {/* Cards — small, frosted glass, side by side */}
        <div className="w-full grid md:grid-cols-2 gap-6 mt-4">
          {/* Teacher Card */}
          <div
            className={`rounded-xl p-8 flex flex-col gap-5 transition-all duration-500 border ${
              activeCard === 'teacher'
                ? 'border-[#cc97ff]/30 opacity-100 scale-100'
                : 'border-[#46484d]/10 opacity-60'
            }`}
            style={{ backdropFilter: 'blur(20px)', background: 'rgba(35, 38, 44, 0.6)' }}
          >
            <div className="w-10 h-10 rounded-lg bg-[#cc97ff]/10 flex items-center justify-center">
              <span className="text-[#cc97ff] text-xl">🚀</span>
            </div>
            <div>
              <h3 className="text-xl font-bold mb-1">Launch Session</h3>
              <p className="text-sm" style={{ color: '#aaabb0' }}>Create a new interactive environment and upload your HTML simulation.</p>
            </div>
            <div className="space-y-2">
              <label className="block text-[10px] font-bold uppercase text-[#aaabb0]" style={{ letterSpacing: '0.15em' }}>Session Title</label>
              <input
                type="text"
                placeholder="e.g. Calculus Visualization 101"
                value={teacherName}
                onChange={(e) => setTeacherName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && createRoom()}
                onFocus={() => setActiveCard('teacher')}
                className="w-full px-4 py-3 border border-[#46484d]/20 rounded-lg text-sm text-[#f6f6fc] placeholder:text-[#74757a] focus:outline-none focus:border-[#cc97ff] transition-all"
                style={{ background: '#000000' }}
              />
            </div>
            <button
              onClick={createRoom}
              disabled={!teacherName.trim()}
              className="w-full py-3.5 bg-[#cc97ff] text-black font-bold rounded-lg text-sm transition-all hover:shadow-[0_0_20px_rgba(204,151,255,0.2)] active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed">
              Initiate Environment
            </button>
          </div>

          {/* Student Card */}
          <div
            className={`rounded-xl p-8 flex flex-col gap-5 transition-all duration-500 border ${
              activeCard === 'student'
                ? 'border-[#699cff]/30 opacity-100 scale-100'
                : 'border-[#46484d]/10 opacity-60'
            }`}
            style={{ backdropFilter: 'blur(20px)', background: 'rgba(35, 38, 44, 0.6)' }}
          >
            <div className="w-10 h-10 rounded-lg bg-[#699cff]/10 flex items-center justify-center">
              <span className="text-[#699cff] text-xl">👥</span>
            </div>
            <div>
              <h3 className="text-xl font-bold mb-1">Join Session</h3>
              <p className="text-sm" style={{ color: '#aaabb0' }}>Enter a session ID to participate in an active mathematical demonstration.</p>
            </div>
            <form onSubmit={joinRoom} className="flex flex-col gap-3">
              <div>
                <label className="block text-[10px] font-bold uppercase text-[#aaabb0] mb-1.5" style={{ letterSpacing: '0.15em' }}>Your Name</label>
                <input
                  type="text"
                  placeholder="e.g. Arjun"
                  value={studentName}
                  onChange={(e) => setStudentName(e.target.value)}
                  onFocus={() => setActiveCard('student')}
                  className="w-full px-4 py-3 border border-[#46484d]/20 rounded-lg text-sm text-[#f6f6fc] placeholder:text-[#74757a] focus:outline-none focus:border-[#699cff] transition-all"
                  style={{ background: '#000000' }}
                />
              </div>
              <div>
                <label className="block text-[10px] font-bold uppercase text-[#aaabb0] mb-1.5" style={{ letterSpacing: '0.15em' }}>Access Code</label>
                <input
                  type="text"
                  placeholder="XXX - XXX - XXX"
                  value={roomCode}
                  onChange={(e) => setRoomCode(e.target.value)}
                  onFocus={() => setActiveCard('student')}
                  className="w-full px-4 py-3 border border-[#46484d]/20 rounded-lg text-sm text-center text-[#f6f6fc] placeholder:text-[#74757a] focus:outline-none focus:border-[#699cff] transition-all"
                  style={{ background: '#000000', fontFamily: mono, letterSpacing: '0.5em' }}
                />
              </div>
              <button
                type="submit"
                disabled={!roomCode.trim() || !studentName.trim()}
                className="w-full py-3.5 bg-[#699cff] text-[#001e4a] font-bold rounded-lg text-sm transition-all hover:shadow-[0_0_20px_rgba(105,156,255,0.2)] active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed">
                Connect to Node
              </button>
            </form>
          </div>
        </div>

        {/* Recent rooms */}
        {recentRooms.length > 0 && (
          <div className="flex flex-wrap justify-center gap-2 mt-4">
            {recentRooms.map((room) => (
              <button
                key={room.id}
                onClick={() => joinRecent(room.id)}
                className="px-3 py-1.5 border border-[#46484d]/20 rounded-lg bg-[#171a1f] hover:border-[#cc97ff]/30 transition-all text-[#aaabb0] hover:text-white text-[11px]"
                style={{ fontFamily: mono }}>
                {room.id}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
