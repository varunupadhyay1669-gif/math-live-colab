import { useEffect, useRef, useState } from 'react';

// The two questions only the tutor can answer.
//
// Both fields already existed, inside a panel called "Lesson notes & homework"
// that a tutor has no reason to open mid-lesson — so in practice they were
// always null, and every pack described an hour with no stated purpose. A field
// nobody opens is not a field.
//
// So this asks, once, at the moment the answer is cheapest: the plan before the
// lesson starts, and the one-line verdict as it ends. It is skippable in one
// click and it gets out of the way on its own, because the alternative failure
// — a tutor who feels nagged and starts dismissing everything — costs more than
// the field is worth.
export interface SessionPromptProps {
  kind: 'before' | 'after';
  value: string;
  onChange: (v: string) => void;
  onDone: () => void;
  /** Seconds before it dismisses itself. 0 keeps it until answered. */
  autoSkipS?: number;
}

const COPY = {
  before: {
    title: 'What is this lesson for?',
    hint: 'One line. It is the difference between a follow-up worksheet aimed at this lesson and one aimed at the subject.',
    placeholder: 'Number properties p.85 — watch his multiplication facts',
    done: 'Save',
  },
  after: {
    title: 'How did it go?',
    hint: 'One sentence, while it is fresh. This is the first thing you will read before the next lesson.',
    placeholder: 'Still doubling instead of regrouping when the numbers get big',
    done: 'Save and export',
  },
} as const;

export default function SessionPrompt({ kind, value, onChange, onDone, autoSkipS = 0 }: SessionPromptProps) {
  const [left, setLeft] = useState(autoSkipS);
  const inputRef = useRef<HTMLInputElement>(null);
  const copy = COPY[kind];

  useEffect(() => { inputRef.current?.focus(); }, []);

  // Counts down only while untouched. A tutor halfway through typing must not
  // have the box vanish from under them.
  useEffect(() => {
    if (!autoSkipS || value.length > 0) return;
    if (left <= 0) { onDone(); return; }
    const t = setTimeout(() => setLeft(l => l - 1), 1000);
    return () => clearTimeout(t);
  }, [left, autoSkipS, value.length, onDone]);

  return (
    <div className="ml-prompt" role="dialog" aria-label={copy.title}>
      <div className="ml-prompt-head">
        <span className="ml-prompt-title">{copy.title}</span>
        {autoSkipS > 0 && value.length === 0 && left > 0 && (
          <span className="ml-prompt-count" aria-hidden="true">{left}s</span>
        )}
      </div>
      <input
        ref={inputRef}
        className="ml-prompt-input"
        value={value}
        placeholder={copy.placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onDone();
          if (e.key === 'Escape') onDone();
        }}
      />
      <div className="ml-prompt-foot">
        <span className="ml-prompt-hint">{copy.hint}</span>
        <div className="ml-prompt-actions">
          <button className="ml-prompt-skip" onClick={onDone}>Skip</button>
          <button className="ml-prompt-go" onClick={onDone} disabled={!value.trim()}>{copy.done}</button>
        </div>
      </div>
    </div>
  );
}
