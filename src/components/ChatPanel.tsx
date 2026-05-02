import React, { useEffect, useRef, useState } from "react";
import { Socket } from "socket.io-client";

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
  variant?: "sidebar" | "panel";
}

export default function ChatPanel({
  socket,
  roomId,
  userName,
  messages,
  isOpen,
  onToggle,
  unreadCount = 0,
  variant = "sidebar",
}: ChatPanelProps) {
  const chatEndRef = useRef<HTMLDivElement>(null);
  const [chatInput, setChatInput] = useState("");

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const sendChat = (e: React.FormEvent) => {
    e.preventDefault();
    if (!socket || !chatInput.trim()) return;
    socket.emit("send_chat", { roomId, message: chatInput.trim(), userName });
    setChatInput("");
  };

  const formatTime = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  const content = (
    <div className="flex h-full flex-col animate-fade-in">
      <div className="flex shrink-0 items-center justify-between px-3 py-3" style={{ borderBottom: "1px solid var(--border-subtle)" }}>
        <span className="ml-badge ml-badge-indigo">Chat</span>
        <button onClick={onToggle} className="ml-icon-btn ml-icon-btn-sm" aria-label="Close chat">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto p-3">
        {messages.length === 0 ? (
          <div className="flex h-full items-center justify-center text-center">
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>No messages yet</p>
          </div>
        ) : (
          messages.map((msg) => {
            const mine = msg.userName === userName;
            return (
              <div key={msg.id} className={`animate-fade-in ${mine ? "ml-7" : "mr-7"}`}>
                <div className="mb-1 flex items-center gap-2">
                  <span className="text-[11px] font-bold" style={{ color: mine ? "var(--accent-emerald)" : "var(--accent-indigo)" }}>
                    {msg.userName}
                  </span>
                  <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>{formatTime(msg.timestamp)}</span>
                </div>
                <div
                  className="px-3 py-2 text-[13px] leading-5"
                  style={{
                    background: mine ? "rgba(5,150,105,0.10)" : "#F1F5F9",
                    color: "var(--text-primary)",
                    border: "1px solid rgba(15,23,42,0.06)",
                    borderRadius: mine ? "14px 14px 4px 14px" : "4px 14px 14px 14px",
                  }}
                >
                  {msg.message}
                </div>
              </div>
            );
          })
        )}
        <div ref={chatEndRef} />
      </div>

      <form onSubmit={sendChat} className="shrink-0 p-3" style={{ borderTop: "1px solid var(--border-subtle)" }}>
        <div className="flex gap-2">
          <input
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            placeholder="Message..."
            className="input-field text-[13px]"
            style={{ height: 36, padding: "0 12px" }}
          />
          <button type="submit" className="ml-btn ml-btn-primary ml-btn-sm" aria-label="Send message">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="m22 2-7 20-4-9-9-4 20-7Z" />
              <path d="M22 2 11 13" />
            </svg>
          </button>
        </div>
      </form>
    </div>
  );

  if (variant === "panel") {
    if (!isOpen) return null;
    return (
      <aside
        className="flex shrink-0 flex-col animate-slide-in-right"
        style={{
          width: 304,
          background: "rgba(255,255,255,0.92)",
          borderLeft: "1px solid rgba(15,23,42,0.08)",
          backdropFilter: "blur(18px)",
        }}
      >
        {content}
      </aside>
    );
  }

  return (
    <aside
      className="flex shrink-0 flex-col"
      style={{
        width: isOpen ? 304 : 56,
        borderLeft: "1px solid rgba(15,23,42,0.08)",
        background: "rgba(255,255,255,0.92)",
        transition: "width 0.25s ease",
        backdropFilter: "blur(18px)",
      }}
    >
      {isOpen ? (
        content
      ) : (
        <div className="flex flex-col items-center gap-2 py-3">
          <button onClick={onToggle} className="ml-icon-btn relative" title="Chat" aria-label="Open chat">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z" />
            </svg>
            {unreadCount > 0 && (
              <span className="absolute -right-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[10px] font-bold text-white animate-bounce-in"
                style={{ background: "var(--accent-rose)", boxShadow: "0 2px 8px rgba(225,29,72,0.35)" }}>
                {unreadCount}
              </span>
            )}
          </button>
        </div>
      )}
    </aside>
  );
}
