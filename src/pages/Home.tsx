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
    <div className="min-h-screen flex flex-col items-center justify-center relative overflow-hidden bg-[#F4F5F7]">

      {/* Subtle grid */}
      <div className="fixed inset-0 pointer-events-none z-0 opacity-50 bg-[radial-gradient(#D0D3DA_0.8px,transparent_0.8px)] bg-[length:24px_24px]" />

      <div className="relative z-10 flex flex-col items-center gap-8 max-w-[520px] w-full px-5">

        {/* Title */}
        <div className="text-center">
          <h1 className="font-display font-extrabold leading-none mb-3 text-[48px] tracking-[-0.04em] text-[#111318]">
            Maths<span className="text-[#5B5FE6]">Live</span>
          </h1>
          <p className="text-[#6B7080] text-[15px] leading-relaxed">
            Real-time collaborative simulations for teachers and students.
          </p>
        </div>

        {/* Teacher Card */}
        <div
          onClick={() => setActiveCard('teacher')}
          className={`bg-white rounded-xl p-6 w-full cursor-pointer transition-all duration-150 ease-in-out border-2 ${
            activeCard === 'teacher'
              ? 'border-[#5B5FE6] shadow-[0_8px_30px_rgba(91,95,230,0.12),0_0_0_1px_rgba(91,95,230,0.08)]'
              : 'border-transparent shadow-[0_2px_8px_rgba(0,0,0,0.06),0_0_0_1px_rgba(0,0,0,0.06)] hover:shadow-md'
          }`}
        >
          <div className="flex items-center gap-3 mb-4">
            <div className="w-9 h-9 rounded-lg bg-[#5B5FE6] flex items-center justify-center">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4M10 17l5-5-5-5M13.8 12H3"/>
              </svg>
            </div>
            <div>
              <div className="font-bold text-[16px] text-[#111318]">Launch Session</div>
              <div className="text-[13px] text-[#8B90A0]">Create a room and share simulations</div>
            </div>
          </div>

          <div className="mb-3">
            <label className="block text-[11px] font-bold text-[#8B90A0] mb-1.5 uppercase tracking-[0.06em]">
              Session Title
            </label>
            <input
              type="text"
              placeholder="e.g. Calculus Visualization 101"
              value={teacherName}
              onChange={(e) => setTeacherName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && createRoom()}
              onFocus={() => setActiveCard('teacher')}
              onClick={(e) => e.stopPropagation()}
              className="input-field"
            />
          </div>

          <button
            onClick={(e) => { e.stopPropagation(); createRoom(); }}
            disabled={!teacherName.trim()}
            className={`w-full h-[42px] rounded-lg border-none text-white font-bold text-[14px] transition-all duration-150 ease-in-out ${
              !teacherName.trim()
                ? 'bg-[#D0D3DA] cursor-not-allowed'
                : 'bg-[#5B5FE6] cursor-pointer shadow-[0_2px_8px_rgba(91,95,230,0.25)] hover:bg-[#4f53d9] hover:shadow-[0_4px_12px_rgba(91,95,230,0.3)]'
            }`}
          >
            Create Room
          </button>
        </div>

        {/* Student Card */}
        <div
          onClick={() => setActiveCard('student')}
          className={`bg-white rounded-xl p-6 w-full cursor-pointer transition-all duration-150 ease-in-out border-2 ${
            activeCard === 'student'
              ? 'border-[#7C5CE6] shadow-[0_8px_30px_rgba(124,92,230,0.12),0_0_0_1px_rgba(124,92,230,0.08)]'
              : 'border-transparent shadow-[0_2px_8px_rgba(0,0,0,0.06),0_0_0_1px_rgba(0,0,0,0.06)] hover:shadow-md'
          }`}
        >
          <div className="flex items-center gap-3 mb-4">
            <div className="w-9 h-9 rounded-lg bg-[#7C5CE6] flex items-center justify-center">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/>
              </svg>
            </div>
            <div>
              <div className="font-bold text-[16px] text-[#111318]">Join Session</div>
              <div className="text-[13px] text-[#8B90A0]">Enter a code to join a live session</div>
            </div>
          </div>

          <form onSubmit={joinRoom} onClick={(e) => e.stopPropagation()}>
            <div className="mb-2.5">
              <label className="block text-[11px] font-bold text-[#8B90A0] mb-1.5 uppercase tracking-[0.06em]">
                Your Name
              </label>
              <input type="text" placeholder="e.g. Arjun" value={studentName}
                onChange={(e) => setStudentName(e.target.value)} onFocus={() => setActiveCard('student')}
                className="input-field" />
            </div>
            <div className="mb-3.5">
              <label className="block text-[11px] font-bold text-[#8B90A0] mb-1.5 uppercase tracking-[0.06em]">
                Room Code
              </label>
              <input type="text" placeholder="Enter room code" value={roomCode}
                onChange={(e) => setRoomCode(e.target.value)} onFocus={() => setActiveCard('student')}
                className="input-field font-mono tracking-[0.12em] text-center" />
            </div>
            <button
              type="submit"
              disabled={!roomCode.trim() || !studentName.trim()}
              className={`w-full h-[42px] rounded-lg border-none text-white font-bold text-[14px] transition-all duration-150 ease-in-out ${
                (!roomCode.trim() || !studentName.trim())
                  ? 'bg-[#D0D3DA] cursor-not-allowed'
                  : 'bg-[#7C5CE6] cursor-pointer shadow-[0_2px_8px_rgba(124,92,230,0.25)] hover:bg-[#6a4ccc] hover:shadow-[0_4px_12px_rgba(124,92,230,0.3)]'
              }`}
            >
              Join Room
            </button>
          </form>
        </div>

        {/* Recent rooms */}
        {recentRooms.length > 0 && (
          <div className="text-center">
            <div className="text-[11px] font-bold text-[#8B90A0] mb-2 uppercase tracking-[0.06em]">
              Recent Sessions
            </div>
            <div className="flex flex-wrap justify-center gap-1.5">
              {recentRooms.map((room) => (
                <button key={room.id} onClick={() => joinRecent(room.id)} className="btn font-mono text-[12px]">
                  {room.id}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
