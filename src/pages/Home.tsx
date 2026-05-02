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
      style={{ background: '#F4F5F7' }}>

      {/* Subtle grid */}
      <div className="fixed inset-0 pointer-events-none z-0"
        style={{ backgroundImage: 'radial-gradient(#D0D3DA 0.8px, transparent 0.8px)', backgroundSize: '24px 24px', opacity: 0.5 }} />

      <div className="relative z-10 flex flex-col items-center gap-8 max-w-[520px] w-full px-5">

        {/* Title */}
        <div className="text-center">
          <h1 className="font-display font-extrabold leading-none mb-3"
            style={{ fontSize: '48px', letterSpacing: '-0.04em', color: '#111318' }}>
            Maths<span style={{ color: '#5B5FE6' }}>Live</span>
          </h1>
          <p style={{ color: '#6B7080', fontSize: '15px', lineHeight: '1.6' }}>
            Real-time collaborative simulations for teachers and students.
          </p>
        </div>

        {/* Teacher Card */}
        <div
          onClick={() => setActiveCard('teacher')}
          style={{
            background: '#FFFFFF',
            border: activeCard === 'teacher' ? '2px solid #5B5FE6' : '2px solid transparent',
            borderRadius: '12px',
            boxShadow: activeCard === 'teacher'
              ? '0 8px 30px rgba(91,95,230,0.12), 0 0 0 1px rgba(91,95,230,0.08)'
              : '0 2px 8px rgba(0,0,0,0.06), 0 0 0 1px rgba(0,0,0,0.06)',
            padding: '24px',
            width: '100%',
            cursor: 'pointer',
            transition: 'all 0.15s ease',
          }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
            <div style={{
              width: '36px', height: '36px', borderRadius: '8px',
              background: '#5B5FE6', display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4M10 17l5-5-5-5M13.8 12H3"/>
              </svg>
            </div>
            <div>
              <div style={{ fontWeight: 700, fontSize: '16px', color: '#111318' }}>Launch Session</div>
              <div style={{ fontSize: '13px', color: '#8B90A0' }}>Create a room and share simulations</div>
            </div>
          </div>

          <div style={{ marginBottom: '12px' }}>
            <label style={{ display: 'block', fontSize: '11px', fontWeight: 700, color: '#8B90A0', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
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

          <button onClick={(e) => { e.stopPropagation(); createRoom(); }} disabled={!teacherName.trim()}
            style={{
              width: '100%', height: '42px', borderRadius: '8px', border: 'none',
              background: !teacherName.trim() ? '#D0D3DA' : '#5B5FE6',
              color: 'white', fontWeight: 700, fontSize: '14px', cursor: teacherName.trim() ? 'pointer' : 'not-allowed',
              transition: 'all 0.12s ease',
              boxShadow: teacherName.trim() ? '0 2px 8px rgba(91,95,230,0.25)' : 'none',
            }}>
            Create Room
          </button>
        </div>

        {/* Student Card */}
        <div
          onClick={() => setActiveCard('student')}
          style={{
            background: '#FFFFFF',
            border: activeCard === 'student' ? '2px solid #7C5CE6' : '2px solid transparent',
            borderRadius: '12px',
            boxShadow: activeCard === 'student'
              ? '0 8px 30px rgba(124,92,230,0.12), 0 0 0 1px rgba(124,92,230,0.08)'
              : '0 2px 8px rgba(0,0,0,0.06), 0 0 0 1px rgba(0,0,0,0.06)',
            padding: '24px',
            width: '100%',
            cursor: 'pointer',
            transition: 'all 0.15s ease',
          }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
            <div style={{
              width: '36px', height: '36px', borderRadius: '8px',
              background: '#7C5CE6', display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/>
              </svg>
            </div>
            <div>
              <div style={{ fontWeight: 700, fontSize: '16px', color: '#111318' }}>Join Session</div>
              <div style={{ fontSize: '13px', color: '#8B90A0' }}>Enter a code to join a live session</div>
            </div>
          </div>

          <form onSubmit={joinRoom} onClick={(e) => e.stopPropagation()}>
            <div style={{ marginBottom: '10px' }}>
              <label style={{ display: 'block', fontSize: '11px', fontWeight: 700, color: '#8B90A0', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                Your Name
              </label>
              <input type="text" placeholder="e.g. Arjun" value={studentName}
                onChange={(e) => setStudentName(e.target.value)} onFocus={() => setActiveCard('student')}
                className="input-field" />
            </div>
            <div style={{ marginBottom: '14px' }}>
              <label style={{ display: 'block', fontSize: '11px', fontWeight: 700, color: '#8B90A0', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                Room Code
              </label>
              <input type="text" placeholder="Enter room code" value={roomCode}
                onChange={(e) => setRoomCode(e.target.value)} onFocus={() => setActiveCard('student')}
                className="input-field"
                style={{ fontFamily: "'JetBrains Mono', monospace", letterSpacing: '0.12em', textAlign: 'center' }} />
            </div>
            <button type="submit" disabled={!roomCode.trim() || !studentName.trim()}
              style={{
                width: '100%', height: '42px', borderRadius: '8px', border: 'none',
                background: (!roomCode.trim() || !studentName.trim()) ? '#D0D3DA' : '#7C5CE6',
                color: 'white', fontWeight: 700, fontSize: '14px',
                cursor: (roomCode.trim() && studentName.trim()) ? 'pointer' : 'not-allowed',
                transition: 'all 0.12s ease',
                boxShadow: (roomCode.trim() && studentName.trim()) ? '0 2px 8px rgba(124,92,230,0.25)' : 'none',
              }}>
              Join Room
            </button>
          </form>
        </div>

        {/* Recent rooms */}
        {recentRooms.length > 0 && (
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '11px', fontWeight: 700, color: '#8B90A0', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Recent Sessions
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '6px' }}>
              {recentRooms.map((room) => (
                <button key={room.id} onClick={() => joinRecent(room.id)} className="btn"
                  style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '12px' }}>
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
