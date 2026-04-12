import { Socket } from 'socket.io-client';

/**
 * Sets up attention detection by monitoring tab visibility and window focus.
 * Emits `attention_change` events to the server so the teacher can see
 * which students are actively viewing the session.
 */
export function setupAttentionDetection(
  socket: Socket,
  roomId: string,
  userName: string
): () => void {
  const emit = (isAttentive: boolean) => {
    socket.emit('attention_change', {
      roomId,
      userName,
      isAttentive,
      timestamp: Date.now(),
    });
  };

  const handleVisibility = () => {
    emit(document.visibilityState === 'visible');
  };

  const handleBlur = () => emit(false);
  const handleFocus = () => emit(true);

  document.addEventListener('visibilitychange', handleVisibility);
  window.addEventListener('blur', handleBlur);
  window.addEventListener('focus', handleFocus);

  // Initial state
  emit(true);

  // Return cleanup function
  return () => {
    document.removeEventListener('visibilitychange', handleVisibility);
    window.removeEventListener('blur', handleBlur);
    window.removeEventListener('focus', handleFocus);
  };
}
