import React, { useEffect, useState } from 'react';
import { Socket } from 'socket.io-client';

interface ConnectionStatusProps {
  socket: Socket | null;
  connected: boolean;
}

export default function ConnectionStatus({ socket, connected }: ConnectionStatusProps) {
  const [status, setStatus] = useState<'connected' | 'reconnecting' | 'disconnected'>('disconnected');
  const [attempts, setAttempts] = useState(0);
  const [showToast, setShowToast] = useState(false);
  const [toastMsg, setToastMsg] = useState('');

  useEffect(() => {
    if (!socket) return;

    const onConnect = () => {
      setStatus('connected');
      setAttempts(0);
      if (status === 'reconnecting' || status === 'disconnected') {
        setToastMsg('✅ Reconnected!');
        setShowToast(true);
        setTimeout(() => setShowToast(false), 3000);
      }
    };

    const onDisconnect = () => {
      setStatus('disconnected');
      setToastMsg('⚠️ Disconnected from server');
      setShowToast(true);
    };

    const onReconnectAttempt = (attempt: number) => {
      setStatus('reconnecting');
      setAttempts(attempt);
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.io.on('reconnect_attempt' as any, onReconnectAttempt);

    // Initial state
    if (socket.connected) setStatus('connected');

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.io.off('reconnect_attempt' as any, onReconnectAttempt);
    };
  }, [socket]);

  useEffect(() => {
    setStatus(connected ? 'connected' : 'disconnected');
  }, [connected]);

  const statusConfig = {
    connected: { color: '#10B981', label: 'Connected', icon: '🟢' },
    reconnecting: { color: '#F59E0B', label: `Reconnecting (${attempts})`, icon: '🟡' },
    disconnected: { color: '#F43F5E', label: 'Disconnected', icon: '🔴' },
  };

  const cfg = statusConfig[status];

  return (
    <>
      {/* Inline indicator */}
      <div className="flex items-center gap-1.5 tooltip-wrapper" data-tooltip={cfg.label}>
        <div className="w-2 h-2 rounded-full" style={{
          background: cfg.color,
          boxShadow: `0 0 6px ${cfg.color}60`,
          animation: status === 'reconnecting' ? 'dot-pulse 1s ease-in-out infinite' : 'none',
        }} />
        {status !== 'connected' && (
          <span className="text-[11px] font-medium" style={{ color: cfg.color }}>
            {cfg.label}
          </span>
        )}
      </div>

      {/* Toast notification */}
      {showToast && (
        <div className="fixed top-3 right-3 z-[999] animate-slide-in-right">
          <div className="px-4 py-2.5 rounded-xl text-sm font-medium"
            style={{
              background: 'var(--bg-card)',
              color: 'var(--text-primary)',
              border: '1px solid var(--border-subtle)',
              boxShadow: 'var(--shadow-lg)',
            }}>
            {toastMsg}
          </div>
        </div>
      )}
    </>
  );
}
