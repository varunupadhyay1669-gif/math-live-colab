import React, { useState } from 'react';
import { Socket } from 'socket.io-client';

interface StepGateProps {
  socket: Socket | null;
  roomId: string;
  // For teacher: creating a gate
  mode: 'create' | 'answer';
  step: number;
  // For creating
  onSave?: (gate: { question: string; options: string[]; correctIndex: number }) => void;
  onClose: () => void;
  // For answering
  gate?: { question: string; options: string[]; correctIndex: number };
  studentName?: string;
}

export default function StepGate({ socket, roomId, mode, step, onSave, onClose, gate, studentName }: StepGateProps) {
  // Create mode state
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '', '', '']);
  const [correctIndex, setCorrectIndex] = useState(0);

  // Answer mode state
  const [selectedAnswer, setSelectedAnswer] = useState<number | null>(null);
  const [result, setResult] = useState<'correct' | 'wrong' | null>(null);
  const [hint, setHint] = useState(false);

  const handleCreateSave = () => {
    if (!question.trim() || options.filter(o => o.trim()).length < 2) return;
    const validOptions = options.filter(o => o.trim());
    onSave?.({ question: question.trim(), options: validOptions, correctIndex: Math.min(correctIndex, validOptions.length - 1) });
    if (socket) {
      socket.emit('add_gate', {
        roomId, step,
        question: question.trim(),
        options: validOptions,
        correctIndex: Math.min(correctIndex, validOptions.length - 1),
      });
    }
    onClose();
  };

  const handleAnswer = (index: number) => {
    setSelectedAnswer(index);
    if (socket) {
      socket.emit('gate_answer', { roomId, step, answerIndex: index, studentName });
    }
    // Listen for result
    socket?.once('gate_result', ({ correct }: { correct: boolean }) => {
      setResult(correct ? 'correct' : 'wrong');
      if (!correct) setHint(true);
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(6px)' }}>
      <div className="w-full max-w-md animate-bounce-in"
        style={{ background: 'var(--bg-card)', borderRadius: 'var(--radius-xl)', border: '1px solid var(--border-subtle)', boxShadow: 'var(--shadow-xl)' }}>

        {mode === 'create' ? (
          <div className="p-6">
            <div className="flex items-center justify-between mb-5">
              <h3 className="font-display text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
                🚧 Add Gate — Step {step}
              </h3>
              <button onClick={onClose}
                style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '18px' }}>✕</button>
            </div>

            <p className="text-xs mb-3" style={{ color: 'var(--text-muted)' }}>
              Students must answer correctly before they can see Step {step}.
            </p>

            <textarea value={question} onChange={e => setQuestion(e.target.value)}
              placeholder="Enter your question..."
              className="input-field mb-4" style={{ minHeight: '70px', resize: 'vertical' }} />

            <div className="space-y-2 mb-4">
              <label className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>Answer Options</label>
              {options.map((opt, i) => (
                <div key={i} className="flex items-center gap-2">
                  <button onClick={() => setCorrectIndex(i)}
                    className="w-6 h-6 rounded-full shrink-0 flex items-center justify-center transition-all"
                    style={{
                      border: correctIndex === i ? '2px solid var(--accent-emerald)' : '2px solid var(--border-default)',
                      background: correctIndex === i ? 'var(--accent-emerald-light)' : 'transparent',
                      cursor: 'pointer',
                    }}>
                    {correctIndex === i && <span style={{ color: 'var(--accent-emerald)', fontSize: '12px', fontWeight: 700 }}>✓</span>}
                  </button>
                  <input value={opt} onChange={e => {
                    const updated = [...options];
                    updated[i] = e.target.value;
                    setOptions(updated);
                  }}
                    placeholder={`Option ${i + 1}`}
                    className="input-field text-sm" style={{ padding: '6px 10px' }} />
                </div>
              ))}
            </div>

            <div className="flex gap-3">
              <button onClick={onClose} className="btn-secondary flex-1">Cancel</button>
              <button onClick={handleCreateSave}
                disabled={!question.trim() || options.filter(o => o.trim()).length < 2}
                className="btn-primary flex-1 disabled:opacity-40">
                Save Gate
              </button>
            </div>
          </div>
        ) : (
          <div className="p-6">
            <div className="text-center mb-5">
              <div className="text-4xl mb-3 animate-reaction-pop">🚧</div>
              <h3 className="font-display text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
                Checkpoint
              </h3>
              <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>Answer correctly to continue</p>
            </div>

            <div className="p-4 rounded-xl mb-4" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)' }}>
              <p className="text-base font-medium text-center" style={{ color: 'var(--text-primary)', lineHeight: 1.6 }}>
                {gate?.question}
              </p>
            </div>

            {result === 'correct' ? (
              <div className="text-center py-4">
                <div className="text-4xl mb-2 animate-bounce-in">✅</div>
                <p className="text-sm font-medium" style={{ color: 'var(--accent-emerald)' }}>Correct! Moving on...</p>
                <button onClick={onClose} className="btn-primary mt-4">Continue</button>
              </div>
            ) : (
              <div className="space-y-2 mb-4">
                {gate?.options.map((opt, i) => (
                  <button key={i} onClick={() => !result && handleAnswer(i)}
                    disabled={result === 'wrong' && selectedAnswer === i}
                    className="w-full text-left px-4 py-3 rounded-xl text-sm font-medium transition-all"
                    style={{
                      background: selectedAnswer === i
                        ? (result === 'wrong' ? 'var(--accent-rose-light)' : 'var(--accent-indigo-light)')
                        : 'var(--bg-surface)',
                      border: `1px solid ${selectedAnswer === i
                        ? (result === 'wrong' ? 'rgba(244,63,94,0.3)' : 'rgba(99,102,241,0.3)')
                        : 'var(--border-subtle)'}`,
                      color: 'var(--text-primary)',
                      cursor: result ? 'default' : 'pointer',
                    }}>
                    {opt}
                  </button>
                ))}
              </div>
            )}

            {hint && (
              <div className="text-center py-2 animate-slide-up">
                <p className="text-sm" style={{ color: 'var(--accent-amber)' }}>💡 Not quite — try again!</p>
                <button onClick={() => { setResult(null); setSelectedAnswer(null); setHint(false); }}
                  className="btn-secondary text-sm mt-2">Retry</button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
