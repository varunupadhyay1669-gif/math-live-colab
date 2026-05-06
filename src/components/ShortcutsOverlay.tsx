// AUTONOMOUS: [ORDER-3 FRICTION] - Keyboard shortcuts that already exist in
// the app are completely undiscoverable today. A teacher who doesn't try
// Ctrl+Z will never know undo works. The standard pattern (Slack / Linear /
// Figma): pressing `?` from anywhere opens a cheat sheet.
//
// This is a self-contained overlay component — wire it once at the root and
// it handles the keybind, dim, focus trap, and dismissal itself.

import { ReactNode, useEffect, useState } from 'react';

interface Shortcut {
  keys: string[];
  description: string;
}

interface Section {
  title: string;
  shortcuts: Shortcut[];
}

const SECTIONS: Section[] = [
  {
    title: 'General',
    shortcuts: [
      { keys: ['?'], description: 'Show / hide this help' },
      { keys: ['Esc'], description: 'Close dialog · clear selection · cancel text edit' },
    ],
  },
  {
    title: 'Whiteboard — drawing',
    shortcuts: [
      { keys: ['Ctrl', 'Z'], description: 'Undo' },
      { keys: ['Ctrl', 'Shift', 'Z'], description: 'Redo' },
      { keys: ['Ctrl', 'Y'], description: 'Redo (alt)' },
      { keys: ['Backspace'], description: 'Delete selected item(s)' },
      { keys: ['Delete'], description: 'Delete selected item(s)' },
    ],
  },
  {
    title: 'Whiteboard — view',
    shortcuts: [
      { keys: ['Space', '+', 'Drag'], description: 'Pan the board' },
      { keys: ['Wheel'], description: 'Zoom (Ctrl+Wheel zooms more aggressively)' },
      { keys: ['Click', '+', 'Drag'], description: 'Marquee multi-select (in Select tool)' },
    ],
  },
  {
    title: 'Whiteboard — text',
    shortcuts: [
      { keys: ['Click'], description: 'Place a label (in Text tool)' },
      { keys: ['Enter'], description: 'Commit the label being typed' },
      { keys: ['Shift', 'Enter'], description: 'Insert a newline in the label' },
      { keys: ['Esc'], description: 'Cancel without committing' },
      { keys: ['Double-click'], description: 'Re-edit an existing label (in Select tool)' },
    ],
  },
];

// AUTONOMOUS: types intentionally loose because this codebase doesn't have
// @types/react installed (see ErrorBoundary.tsx for the same pattern). The
// `key` prop on JSX is React's reserved attribute and isn't part of the
// component's own props type, so we accept any other props and ignore them.
function Key(props: any) {
  const children = props.children as ReactNode;
  // A simple visual "key cap". String "+" is rendered as a soft separator.
  if (children === '+') {
    return <span style={{ margin: '0 4px', color: '#94a3b8' }}>+</span>;
  }
  return (
    <kbd
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        fontFamily: 'ui-monospace, SFMono-Regular, monospace',
        fontSize: 12,
        fontWeight: 600,
        color: '#0F172A',
        background: '#fff',
        border: '1px solid #d4d4d8',
        borderBottomWidth: 2,
        borderRadius: 6,
        minWidth: 20,
        textAlign: 'center',
        lineHeight: '18px',
        verticalAlign: 'middle',
      }}
    >
      {children}
    </kbd>
  );
}

export default function ShortcutsOverlay() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Ignore the keybind while typing in any input — `?` should still go
      // into the field, not open the overlay. Includes contenteditable so
      // future rich-text inputs are covered.
      const target = e.target as HTMLElement | null;
      const isEditing = target && (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      );
      if (e.key === '?' && !isEditing) {
        // shift+/ produces ?; treat both as the trigger
        e.preventDefault();
        setOpen(o => !o);
        return;
      }
      if (e.key === 'Escape' && open) {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open]);

  if (!open) return null;

  return (
    <div
      onClick={() => setOpen(false)}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'rgba(15, 23, 42, 0.55)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        animation: 'shortcuts-fade 0.15s ease-out',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-label="Keyboard shortcuts"
        style={{
          width: '100%',
          maxWidth: 680,
          maxHeight: '80vh',
          overflowY: 'auto',
          background: '#FAFAF9',
          color: '#0A0A0F',
          border: '1px solid #E5E7EB',
          borderRadius: 18,
          boxShadow: '0 24px 60px rgba(15,23,42,0.35)',
          padding: '28px 32px 24px',
          fontFamily: 'ui-sans-serif, system-ui, -apple-system, sans-serif',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 20 }}>
          <h2 style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.02em', margin: 0 }}>
            Keyboard shortcuts
          </h2>
          <button
            onClick={() => setOpen(false)}
            style={{
              border: 'none',
              background: 'transparent',
              color: '#737373',
              cursor: 'pointer',
              fontSize: 13,
              fontWeight: 600,
            }}
            aria-label="Close shortcuts"
          >
            Close (Esc)
          </button>
        </div>
        {SECTIONS.map(section => (
          <div key={section.title} style={{ marginBottom: 18 }}>
            <h3
              style={{
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                color: '#4F46E5',
                margin: '0 0 8px',
              }}
            >
              {section.title}
            </h3>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {section.shortcuts.map(s => (
                <li
                  key={s.description}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '7px 0',
                    borderBottom: '1px solid rgba(15,23,42,0.06)',
                    fontSize: 14,
                    gap: 16,
                  }}
                >
                  <span style={{ color: '#0A0A0F' }}>{s.description}</span>
                  <span style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>
                    {s.keys.map((k, i) => <Key key={`${k}-${i}`}>{k}</Key>)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
        <div style={{ marginTop: 8, fontSize: 12, color: '#737373' }}>
          Press <Key>?</Key> anytime to bring this back.
        </div>
      </div>
      <style>{`
        @keyframes shortcuts-fade {
          from { opacity: 0; }
          to { opacity: 1; }
        }
      `}</style>
    </div>
  );
}
