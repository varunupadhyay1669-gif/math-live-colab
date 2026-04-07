import express from 'express';
import { createServer as createViteServer } from 'vite';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';

interface FileEntry {
  id: string;
  name: string;
  html: string;
  uploadedAt: number;
}

interface RoomData {
  files: FileEntry[];
  activeFileId: string | null;
  lastRunHtml: string | null;
  users: Map<string, { name: string; role: 'teacher' | 'student'; joinedAt: number }>;
  isPaused: boolean;
  teacherSocketId: string | null;
  createdAt: number;
  lastActivityAt: number; // For clearing memory after 48 hours
  chat: Array<{ id: string; userId: string; userName: string; message: string; timestamp: number }>;
}

async function startServer() {
  const app = express();
  const PORT = parseInt(process.env.PORT || '3000', 10);

  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: { origin: '*' },
    maxHttpBufferSize: 5e6, // 5MB for large HTML files
  });

  const rooms = new Map<string, RoomData>();

  // ─── MEMORY MANAGEMENT (Garbage collection) ───
  // Run every 10 minutes, sweep rooms inactive for > 48 hours
  setInterval(() => {
    const now = Date.now();
    const expiryMs = 48 * 60 * 60 * 1000; // 48 hours
    let deletedCount = 0;
    
    for (const [roomId, room] of rooms.entries()) {
      if (now - room.lastActivityAt > expiryMs) {
        rooms.delete(roomId);
        deletedCount++;
      }
    }
    
    if (deletedCount > 0) {
      console.log(`🧹 Memory Sweep: Cleared ${deletedCount} abandoned rooms.`);
    }
  }, 10 * 60 * 1000); 

  function updateRoomActivity(roomId: string) {
    const room = rooms.get(roomId);
    if (room) room.lastActivityAt = Date.now();
  }

  function createRoom(): RoomData {
    return {
      files: [],
      activeFileId: null,
      lastRunHtml: null,
      users: new Map(),
      isPaused: false,
      teacherSocketId: null,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      chat: [],
    };
  }

  function getRoomUserList(room: RoomData) {
    const list: Array<{ id: string; name: string; role: string }> = [];
    room.users.forEach((user, id) => {
      list.push({ id, name: user.name, role: user.role });
    });
    return list;
  }

  io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // ─── JOIN ROOM ───
    socket.on('join_room', ({ roomId, userName, role }: { roomId: string; userName: string; role: 'teacher' | 'student' }) => {
      updateRoomActivity(roomId);
      socket.join(roomId);
      if (!rooms.has(roomId)) {
        rooms.set(roomId, createRoom());
      }
      const room = rooms.get(roomId)!;
      room.users.set(socket.id, { name: userName || 'Anonymous', role, joinedAt: Date.now() });

      if (role === 'teacher') {
        room.teacherSocketId = socket.id;
      }

      // Send current state to the newly joined user
      socket.emit('room_state', {
        files: room.files,
        activeFileId: room.activeFileId,
        lastRunHtml: room.lastRunHtml,
        isPaused: room.isPaused,
        users: getRoomUserList(room),
        chat: room.chat.slice(-50), // Last 50 messages
      });

      // Broadcast updated user list
      io.to(roomId).emit('user_list', getRoomUserList(room));
    });

    // ─── FILE MANAGEMENT ───
    socket.on('upload_file', ({ roomId, file }: { roomId: string; file: FileEntry }) => {
      updateRoomActivity(roomId);
      const room = rooms.get(roomId);
      if (!room) return;
      room.files.push(file);
      room.activeFileId = file.id;
      room.lastRunHtml = file.html;
      io.to(roomId).emit('file_uploaded', file);
      io.to(roomId).emit('active_file_changed', file.id);
      // Auto-push HTML to all connected students immediately
      io.to(roomId).emit('run_preview', { fileId: file.id, html: file.html });
    });

    socket.on('update_file', ({ roomId, fileId, html }: { roomId: string; fileId: string; html: string }) => {
      const room = rooms.get(roomId);
      if (!room) return;
      const file = room.files.find(f => f.id === fileId);
      if (file) {
        file.html = html;
        socket.to(roomId).emit('file_updated', { fileId, html });
      }
    });

    socket.on('delete_file', ({ roomId, fileId }: { roomId: string; fileId: string }) => {
      const room = rooms.get(roomId);
      if (!room) return;
      room.files = room.files.filter(f => f.id !== fileId);
      if (room.activeFileId === fileId) {
        room.activeFileId = room.files.length > 0 ? room.files[0].id : null;
      }
      io.to(roomId).emit('file_deleted', { fileId, newActiveId: room.activeFileId });
    });

    socket.on('switch_file', ({ roomId, fileId }: { roomId: string; fileId: string }) => {
      const room = rooms.get(roomId);
      if (!room) return;
      room.activeFileId = fileId;
      const file = room.files.find(f => f.id === fileId);
      if (file) {
        room.lastRunHtml = file.html;
        io.to(roomId).emit('run_preview', { fileId, html: file.html });
      }
      io.to(roomId).emit('active_file_changed', fileId);
    });

    // ─── RUN / REFRESH PREVIEW ───
    socket.on('run_preview', ({ roomId, fileId, html }: { roomId: string; fileId: string; html: string }) => {
      updateRoomActivity(roomId);
      const room = rooms.get(roomId);
      if (!room) return;
      // Update the file content
      const file = room.files.find(f => f.id === fileId);
      if (file) {
        file.html = html;
      }
      room.activeFileId = fileId;
      room.lastRunHtml = html;
      // Send to everyone (including sender for confirmation)
      io.to(roomId).emit('run_preview', { fileId, html });
    });

    // ─── TEACHER CONTROLS ───
    socket.on('pause_session', ({ roomId }: { roomId: string }) => {
      const room = rooms.get(roomId);
      if (!room) return;
      room.isPaused = true;
      io.to(roomId).emit('session_paused');
    });

    socket.on('resume_session', ({ roomId }: { roomId: string }) => {
      const room = rooms.get(roomId);
      if (!room) return;
      room.isPaused = false;
      io.to(roomId).emit('session_resumed');
    });

    // ─── REACTIONS ───
    socket.on('send_reaction', ({ roomId, emoji, fromName }: { roomId: string; emoji: string; fromName: string }) => {
      io.to(roomId).emit('reaction', { emoji, fromName, senderId: socket.id });
    });

    // ─── CHAT ───
    socket.on('send_chat', ({ roomId, message, userName }: { roomId: string; message: string; userName: string }) => {
      updateRoomActivity(roomId);
      const room = rooms.get(roomId);
      if (!room) return;
      const chatMsg = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        userId: socket.id,
        userName,
        message,
        timestamp: Date.now(),
      };
      room.chat.push(chatMsg);
      // Keep only last 200 messages
      if (room.chat.length > 200) room.chat = room.chat.slice(-200);
      io.to(roomId).emit('chat_message', chatMsg);
    });

    // ─── QUIZ / QUESTIONS ───
    socket.on('send_quiz', ({ roomId, question, options }: { roomId: string; question: string; options?: string[] }) => {
      io.to(roomId).emit('quiz', { question, options, senderId: socket.id });
    });

    socket.on('quiz_answer', ({ roomId, answer, studentName }: { roomId: string; answer: string; studentName: string }) => {
      // Send answer to teacher
      const room = rooms.get(roomId);
      if (!room || !room.teacherSocketId) return;
      io.to(room.teacherSocketId).emit('quiz_answer_received', { answer, studentName, studentId: socket.id });
    });

    // ─── RAISE HAND ───
    socket.on('raise_hand', ({ roomId, studentName }: { roomId: string; studentName: string }) => {
      const room = rooms.get(roomId);
      if (!room) return;
      io.to(roomId).emit('hand_raised', { studentName, studentId: socket.id });
    });

    // ─── SPOTLIGHT / ANNOTATION ───
    socket.on('spotlight', ({ roomId, x, y, active }: { roomId: string; x: number; y: number; active: boolean }) => {
      socket.to(roomId).emit('spotlight', { x, y, active, senderId: socket.id });
    });

    // ─── DRAWING / ANNOTATION ───
    socket.on('draw_stroke', ({ roomId, points, color, width, transient }: any) => {
      socket.to(roomId).emit('draw_stroke', { points, color, width, transient, senderId: socket.id });
    });

    socket.on('draw_clear', ({ roomId }: { roomId: string }) => {
      socket.to(roomId).emit('draw_clear');
    });

    // ─── LASER POINTER ───
    socket.on('laser_pointer', ({ roomId, x, y, active }: { roomId: string; x: number; y: number; active: boolean }) => {
      socket.to(roomId).emit('laser_pointer', { x, y, active });
    });

    // ─── CHALLENGE TIMER ───
    socket.on('start_timer', ({ roomId, seconds }: { roomId: string; seconds: number }) => {
      io.to(roomId).emit('timer_started', { seconds, startedAt: Date.now() });
    });

    socket.on('stop_timer', ({ roomId }: { roomId: string }) => {
      io.to(roomId).emit('timer_stopped');
    });

    // ─── CELEBRATION ───
    socket.on('trigger_celebration', ({ roomId, type }: { roomId: string; type: string }) => {
      io.to(roomId).emit('celebration', { type });
    });

    // ─── STUDENT QUICK REACTIONS ───
    socket.on('student_reaction', ({ roomId, emoji, label, studentName }: { roomId: string; emoji: string; label: string; studentName: string }) => {
      const room = rooms.get(roomId);
      if (!room || !room.teacherSocketId) return;
      io.to(room.teacherSocketId).emit('student_feedback', { emoji, label, studentName, studentId: socket.id });
    });

    // ─── FOCUS MODE ───
    socket.on('focus_mode', ({ roomId, active, x, y, radius }: { roomId: string; active: boolean; x: number; y: number; radius: number }) => {
      updateRoomActivity(roomId);
      socket.to(roomId).emit('focus_mode', { active, x, y, radius });
    });

    // ─── INTERACTION SYNC ───
    socket.on('interaction', ({ roomId, event }: { roomId: string; event: any }) => {
      updateRoomActivity(roomId);
      event.userId = socket.id;
      const room = rooms.get(roomId);
      if (room) {
        const user = room.users.get(socket.id);
        if (user) event.userName = user.name;
      }
      socket.to(roomId).emit('interaction', event);
    });

    // ─── DISCONNECT ───
    socket.on('disconnecting', () => {
      for (const roomId of socket.rooms) {
        if (rooms.has(roomId)) {
          const room = rooms.get(roomId)!;
          const user = room.users.get(socket.id);
          room.users.delete(socket.id);

          io.to(roomId).emit('user_list', getRoomUserList(room));
          io.to(roomId).emit('user_left', { userId: socket.id, userName: user?.name || 'Unknown' });

          if (room.teacherSocketId === socket.id) {
            room.teacherSocketId = null;
          }

          // Clean up empty rooms after 5 minutes
          if (room.users.size === 0) {
            setTimeout(() => {
              if (rooms.has(roomId) && rooms.get(roomId)!.users.size === 0) {
                rooms.delete(roomId);
                console.log(`Room ${roomId} cleaned up`);
              }
            }, 5 * 60 * 1000);
          }
        }
      }
    });

    socket.on('disconnect', () => {
      console.log('User disconnected:', socket.id);
    });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  🧮 MathsLive server running on http://localhost:${PORT}\n`);
  });
}

startServer();
