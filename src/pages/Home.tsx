import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { v4 as uuidv4 } from "uuid";
import { motion } from "motion/react";
import { ThemeToggle } from "../components/ThemeToggle";

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
      style={{ background: 'var(--bg-primary)' }}>

      {/* Cloud pattern background for overworld vibe */}
      <div className="fixed inset-0 pointer-events-none z-0 opacity-20"
        style={{
          backgroundImage: 'radial-gradient(var(--bg-secondary) 2px, transparent 2px)',
          backgroundSize: '32px 32px',
        }} />

      <div className="absolute top-4 right-4 z-50">
        <ThemeToggle />
      </div>

      <div className="relative z-10 flex flex-col items-center gap-10 max-w-[560px] w-full px-5">

        {/* Title */}
        <motion.div
          initial={{ y: -50, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ type: "spring", bounce: 0.5 }}
          className="text-center"
        >
          <h1 className="font-display font-bold leading-none mb-4"
            style={{ fontSize: '64px', color: 'var(--text-inverse)', textShadow: '4px 4px 0px rgba(0,0,0,0.3)' }}>
            Maths<span style={{ color: 'var(--accent-emerald)' }}>Craft</span>
          </h1>
          <div style={{
            background: 'var(--bg-card)',
            padding: '8px 16px',
            border: '2px solid var(--border-default)',
            boxShadow: 'var(--shadow-sm)',
            display: 'inline-block'
          }}>
            <p style={{ color: 'var(--text-primary)', fontSize: '18px', textTransform: 'uppercase' }}>
              Real-time collaborative simulation
            </p>
          </div>
        </motion.div>

        <div className="flex flex-col gap-6 w-full">
          {/* Teacher Card */}
          <motion.div
            initial={{ x: -50, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            transition={{ delay: 0.1 }}
            onClick={() => setActiveCard('teacher')}
            style={{
              background: 'var(--bg-card)',
              border: '3px solid',
              borderColor: activeCard === 'teacher' ? 'var(--text-primary)' : 'var(--border-default)',
              boxShadow: activeCard === 'teacher' ? 'var(--shadow-lg)' : 'var(--shadow-md)',
              padding: '24px',
              width: '100%',
              cursor: 'pointer',
              transition: 'all 0.15s ease',
            }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '20px' }}>
              <div style={{
                width: '48px', height: '48px',
                background: 'var(--accent-emerald)',
                border: '2px solid var(--text-primary)',
                boxShadow: 'inset -2px -2px 0px rgba(0,0,0,0.3), inset 2px 2px 0px rgba(255,255,255,0.4)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <span style={{ fontSize: '24px' }}>🍎</span>
              </div>
              <div>
                <div style={{ fontWeight: 700, fontSize: '24px', color: 'var(--text-primary)', textTransform: 'uppercase' }}>Launch Session</div>
                <div style={{ fontSize: '16px', color: 'var(--text-secondary)' }}>Create a room for your students</div>
              </div>
            </div>

            <div style={{ marginBottom: '16px' }}>
              <label style={{ display: 'block', fontSize: '16px', color: 'var(--text-primary)', marginBottom: '8px', textTransform: 'uppercase' }}>
                Session Name
              </label>
              <input
                type="text"
                placeholder="e.g. Redstone Logic"
                value={teacherName}
                onChange={(e) => setTeacherName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && createRoom()}
                onFocus={() => setActiveCard('teacher')}
                onClick={(e) => e.stopPropagation()}
                className="input-field"
                style={{
                  background: 'var(--bg-code)',
                  color: 'var(--text-inverse)',
                  border: '2px solid var(--text-primary)',
                  boxShadow: 'inset 3px 3px 0px rgba(0,0,0,0.5)',
                  fontSize: '18px'
                }}
              />
            </div>

            <button onClick={(e) => { e.stopPropagation(); createRoom(); }} disabled={!teacherName.trim()}
              style={{
                width: '100%', height: '48px', border: '2px solid var(--text-primary)',
                background: !teacherName.trim() ? 'var(--bg-surface)' : 'var(--accent-emerald)',
                color: !teacherName.trim() ? 'var(--text-muted)' : 'var(--text-inverse)',
                fontSize: '20px', textTransform: 'uppercase', textShadow: teacherName.trim() ? '2px 2px 0px rgba(0,0,0,0.3)' : 'none',
                cursor: teacherName.trim() ? 'pointer' : 'not-allowed',
                boxShadow: !teacherName.trim() ? 'var(--shadow-sm)' : 'var(--shadow-md)',
              }}>
              Create World
            </button>
          </motion.div>

          {/* Student Card */}
          <motion.div
            initial={{ x: 50, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            transition={{ delay: 0.2 }}
            onClick={() => setActiveCard('student')}
            style={{
              background: 'var(--bg-card)',
              border: '3px solid',
              borderColor: activeCard === 'student' ? 'var(--text-primary)' : 'var(--border-default)',
              boxShadow: activeCard === 'student' ? 'var(--shadow-lg)' : 'var(--shadow-md)',
              padding: '24px',
              width: '100%',
              cursor: 'pointer',
              transition: 'all 0.15s ease',
            }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '20px' }}>
              <div style={{
                width: '48px', height: '48px',
                background: 'var(--accent-amber)',
                border: '2px solid var(--text-primary)',
                boxShadow: 'inset -2px -2px 0px rgba(0,0,0,0.3), inset 2px 2px 0px rgba(255,255,255,0.4)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <span style={{ fontSize: '24px' }}>⛏️</span>
              </div>
              <div>
                <div style={{ fontWeight: 700, fontSize: '24px', color: 'var(--text-primary)', textTransform: 'uppercase' }}>Join Session</div>
                <div style={{ fontSize: '16px', color: 'var(--text-secondary)' }}>Connect to a server</div>
              </div>
            </div>

            <form onSubmit={joinRoom} onClick={(e) => e.stopPropagation()}>
              <div style={{ marginBottom: '16px' }}>
                <label style={{ display: 'block', fontSize: '16px', color: 'var(--text-primary)', marginBottom: '8px', textTransform: 'uppercase' }}>
                  Player Name
                </label>
                <input type="text" placeholder="e.g. Steve" value={studentName}
                  onChange={(e) => setStudentName(e.target.value)} onFocus={() => setActiveCard('student')}
                  className="input-field"
                  style={{
                    background: 'var(--bg-code)', color: 'var(--text-inverse)',
                    border: '2px solid var(--text-primary)', boxShadow: 'inset 3px 3px 0px rgba(0,0,0,0.5)', fontSize: '18px'
                  }} />
              </div>
              <div style={{ marginBottom: '24px' }}>
                <label style={{ display: 'block', fontSize: '16px', color: 'var(--text-primary)', marginBottom: '8px', textTransform: 'uppercase' }}>
                  Server Code
                </label>
                <input type="text" placeholder="ENTER CODE" value={roomCode}
                  onChange={(e) => setRoomCode(e.target.value)} onFocus={() => setActiveCard('student')}
                  className="input-field"
                  style={{
                    background: 'var(--bg-code)', color: 'var(--accent-amber)',
                    border: '2px solid var(--text-primary)', boxShadow: 'inset 3px 3px 0px rgba(0,0,0,0.5)',
                    fontSize: '24px', textAlign: 'center', letterSpacing: '0.1em'
                  }} />
              </div>
              <button type="submit" disabled={!roomCode.trim() || !studentName.trim()}
                style={{
                  width: '100%', height: '48px', border: '2px solid var(--text-primary)',
                  background: (!roomCode.trim() || !studentName.trim()) ? 'var(--bg-surface)' : 'var(--accent-amber)',
                  color: (!roomCode.trim() || !studentName.trim()) ? 'var(--text-muted)' : 'var(--text-primary)',
                  fontSize: '20px', textTransform: 'uppercase',
                  cursor: (roomCode.trim() && studentName.trim()) ? 'pointer' : 'not-allowed',
                  boxShadow: (!roomCode.trim() || !studentName.trim()) ? 'var(--shadow-sm)' : 'var(--shadow-md)',
                }}>
                Connect
              </button>
            </form>
          </motion.div>
        </div>

        {/* Recent rooms */}
        {recentRooms.length > 0 && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.4 }} style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '16px', color: 'var(--text-primary)', marginBottom: '12px', textTransform: 'uppercase' }}>
              Recent Servers
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '8px' }}>
              {recentRooms.map((room) => (
                <button key={room.id} onClick={() => joinRecent(room.id)}
                  style={{
                    background: 'var(--bg-surface)', border: '2px solid var(--border-default)',
                    color: 'var(--text-primary)', padding: '6px 12px', fontSize: '16px',
                    boxShadow: 'var(--shadow-sm)', cursor: 'pointer'
                  }}>
                  {room.id}
                </button>
              ))}
            </div>
          </motion.div>
        )}
      </div>
    </div>
  );
}
