import React, { useState } from 'react';
import { Socket } from 'socket.io-client';

interface StepControlsProps {
  socket: Socket | null;
  roomId: string;
  currentStep: number;
  maxStep: number;
  stepLockEnabled: boolean;
  onSetStep: (step: number) => void;
  onToggleStepLock: () => void;
  onOpenGate: () => void;
  gates: Record<number, { question: string; options: string[]; correctIndex: number }>;
}

export default function StepControls({
  socket, roomId, currentStep, maxStep, stepLockEnabled,
  onSetStep, onToggleStepLock, onOpenGate, gates,
}: StepControlsProps) {
  if (!stepLockEnabled && maxStep === 0) return null;

  return (
    <div className="shrink-0 flex items-center gap-3 px-4 py-2 animate-slide-down"
      style={{ background: 'var(--bg-surface)', borderBottom: '1px solid var(--border-subtle)' }}>

      {/* Toggle */}
      <button onClick={onToggleStepLock}
        className={`btn text-[12px] ${stepLockEnabled ? 'btn-toolbar-active' : ''}`}
        title={stepLockEnabled ? 'Disable Step Lock' : 'Enable Step Lock'}>
        {stepLockEnabled ? '🔒 Locked' : '🔓 Unlocked'}
      </button>

      {stepLockEnabled && (
        <>
          <div className="h-5 w-px" style={{ background: 'var(--border-subtle)' }} />

          {/* Previous */}
          <button onClick={() => onSetStep(Math.max(1, currentStep - 1))}
            disabled={currentStep <= 1}
            className="btn text-[12px] disabled:opacity-30"
            style={{ padding: '5px 10px' }}>
            ◀ Prev
          </button>

          {/* Step indicator */}
          <div className="flex items-center gap-2">
            <span className="font-display font-bold text-sm" style={{ color: 'var(--text-primary)' }}>
              Step {currentStep} of {maxStep || '?'}
            </span>
            {/* Progress dots */}
            {maxStep > 0 && maxStep <= 12 && (
              <div className="flex gap-1">
                {Array.from({ length: maxStep }).map((_, i) => (
                  <button key={i} onClick={() => onSetStep(i + 1)}
                    className="transition-all"
                    style={{
                      width: 8, height: 8, borderRadius: '50%',
                      background: i + 1 <= currentStep ? 'var(--accent-indigo)' : 'var(--border-default)',
                      border: 'none', cursor: 'pointer',
                      transform: i + 1 === currentStep ? 'scale(1.3)' : 'scale(1)',
                      boxShadow: i + 1 === currentStep ? 'var(--shadow-glow-indigo)' : 'none',
                    }} />
                ))}
              </div>
            )}
          </div>

          {/* Next */}
          <button onClick={() => onSetStep(Math.min(maxStep || 999, currentStep + 1))}
            disabled={maxStep > 0 && currentStep >= maxStep}
            className="btn text-[12px] disabled:opacity-30"
            style={{ padding: '5px 10px' }}>
            Next ▶
          </button>

          <div className="h-5 w-px" style={{ background: 'var(--border-subtle)' }} />

          {/* Gate indicator for current step */}
          {gates[currentStep + 1] && (
            <span className="badge badge-amber text-[10px]">🚧 Gate on Step {currentStep + 1}</span>
          )}

          {/* Add Gate */}
          <button onClick={onOpenGate}
            className="btn text-[12px]"
            title="Add a gate question before the next step">
            🚧 Add Gate
          </button>
        </>
      )}
    </div>
  );
}
