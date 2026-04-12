import React, { useRef, useEffect } from 'react';
import { Socket } from 'socket.io-client';

interface ChatMessage {
  id: string;
  userId: string;
  userName: string;
  message: string;
  timestamp: number;
}

interface ChatPanelProps {
  socket: Socket | null;
  roomId: string;
  userName: string;
  messages: ChatMessage[];
  isOpen: boolean;
  onToggle: () => void;
  unreadCount?: number;
  /** Compact sidebar mode (teacher view) vs full panel (student view) */
  variant?: 'sidebar' | 'panel';
}

export default function ChatPanel({
  socket, roomId, userName, messages, isOpen, onToggle, unreadCount = 0, variant = 'sidebar',
}: ChatPanelProps) {
  const chatEndRef = useRef<HTMLDivElement>(null);
  const [chatInput, setChatInput] = React.useState('');

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const sendChat = (e: React.FormEvent) => {
    e.preventDefault();
    if (!socket || !chatInput.trim()) return;
    socket.emit('send_chat', { roomId, message: chatInput.trim(), userName });
    setChatInput('');
  };

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  // ── Panel variant (student view - slides in from right) ──
  if (variant === 'panel') {
    if (!isOpen) return null;
    return (
      <div className="flex flex-col shrink-0 animate-slide-in-right"
        style={{ width: '280px', background: 'var(--bg-secondary)', borderLeft: '1px solid var(--border-subtle)' }}>
        <div className="flex items-center justify-between px-3 py-2.5 shrink-0"
          style={{ borderBottom: '1px solid var(--border-subtle)' }}>
          <span className="badge badge-indigo text-[10px]">💬 CHAT</span>
          <button onClick={onToggle}
            style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '14px' }}>✕</button>
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-2.5">
          {messages.length === 0 ? (
            <div className="text-center py-8">
              <div className="text-3xl mb-2">💬</div>
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>No messages yet</p>
            </div>
          ) : messages.map(msg => (
            <div key={msg.id} className="animate-fade-in">
              <div className="flex items-center gap-2 mb-0.5">
                <span className="text-[10px] font-bold"
                  style={{ color: msg.userName === userName ? 'var(--accent-emerald)' : 'var(--accent-indigo)' }}>
                  {msg.userName}
                </span>
                <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>{formatTime(msg.timestamp)}</span>
              </div>
              <div className="text-sm px-3 py-2 rounded-xl"
                style={{
                  background: msg.userName === userName ? 'var(--accent-indigo-light)' : 'var(--bg-surface)',
                  color: 'var(--text-primary)',
                  borderRadius: msg.userName === userName ? '12px 12px 4px 12px' : '4px 12px 12px 12px',
                }}>
                {msg.message}
              </div>
            </div>
          ))}
          <div ref={chatEndRef} />
        </div>
        <form onSubmit={sendChat} className="p-3 shrink-0" style={{ borderTop: '1px solid var(--border-subtle)' }}>
          <div className="flex gap-2">
            <input value={chatInput} onChange={(e) => setChatInput(e.target.value)}
              placeholder="Type a message..."
              className="input-field text-sm" style={{ padding: '8px 12px' }} />
            <button type="submit" className="btn-primary" style={{ padding: '8px 12px', fontSize: '14px' }}>↑</button>
          </div>
        </form>
      </div>
    );
  }

  // ── Sidebar variant (teacher view - in-place expand/collapse) ──
  return (
    <div className="flex flex-col shrink-0" style={{
      width: isOpen ? '280px' : '52px',
      borderLeft: '1px solid var(--border-subtle)',
      background: 'var(--bg-secondary)',
      transition: 'width 0.25s ease',
    }}>
      {isOpen ? (
        <div className="flex flex-col h-full animate-fade-in">
          <div className="flex items-center justify-between px-3 py-2.5 shrink-0"
            style={{ borderBottom: '1px solid var(--border-subtle)' }}>
            <span className="badge badge-indigo text-[10px]">💬 CHAT</span>
            <button onClick={onToggle}
              style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '16px' }}>✕</button>
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {messages.length === 0 && (
              <p className="text-center text-xs py-8" style={{ color: 'var(--text-muted)' }}>No messages yet</p>
            )}
            {messages.map(msg => (
              <div key={msg.id}>
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-[10px] font-bold" style={{ color: 'var(--accent-indigo)' }}>{msg.userName}</span>
                  <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>{formatTime(msg.timestamp)}</span>
                </div>
                <div className="text-[13px] px-3 py-2"
                  style={{
                    background: 'var(--bg-surface)', color: 'var(--text-primary)',
                    borderRadius: '4px 12px 12px 12px',
                  }}>
                  {msg.message}
                </div>
              </div>
            ))}
            <div ref={chatEndRef} />
          </div>
          <form onSubmit={sendChat} className="p-2.5 shrink-0" style={{ borderTop: '1px solid var(--border-subtle)' }}>
            <div className="flex gap-2">
              <input value={chatInput} onChange={(e) => setChatInput(e.target.value)} placeholder="Message..."
                className="input-field text-[13px]" style={{ padding: '7px 10px' }} />
              <button type="submit" className="btn-primary" style={{ padding: '7px 12px', fontSize: '14px' }}>↑</button>
            </div>
          </form>
        </div>
      ) : (
        <div className="flex flex-col items-center py-3 gap-1.5">
          <button onClick={onToggle}
            className="w-[40px] h-[40px] rounded-xl flex items-center justify-center text-[17px] transition-all hover:scale-110 relative"
            style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', cursor: 'pointer' }}
            title="Chat">
            💬
            {unreadCount > 0 && (
              <span className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold text-white animate-bounce-in"
                style={{ background: 'var(--accent-rose)', boxShadow: '0 2px 6px rgba(244,63,94,0.4)' }}>
                {unreadCount}
              </span>
            )}
          </button>
        </div>
      )}
    </div>
  );
}
