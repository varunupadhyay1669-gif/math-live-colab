import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { calculate, formatResult, ExpressionError } from '../lib/mathExpr';

// ─────────────────────────────────────────────────────────────────────────
// A calculator that floats over the lesson.
//
// Asked for on 10 Sep 2026: "different calculator options for the teacher and
// if he want for the students also." Two readings of that sentence, and both
// are built here:
//
//   different OPTIONS  — basic and scientific are one component with a switch,
//                        not two panels. Mid-lesson a tutor should not have to
//                        close the thing he is using to find the thing he
//                        needs; the sum he already typed survives the switch.
//   and for STUDENTS   — every question of who may open it is the parent's.
//                        This component takes `canUse` and renders nothing when
//                        it is false, and it holds no socket and no roomId, so
//                        there is no path by which it can put anything on the
//                        wire by itself. Sharing a result is an optional
//                        callback the room wires up.
//
// It is deliberately not a modal. He is calculating ABOUT something — a number
// on the whiteboard, a value in a simulation — and a dialog that covers what he
// is calculating about is a dialog he closes before he can read the answer. So:
// floating, draggable, and it stays where he put it.
//
// Two audiences, two input methods, both first class. The tutor is on a laptop
// and types; his students are on iPads and tap. Which is why the expression is
// a real <input> (so the keyboard just works) AND every key is a real button at
// finger size (so a thumb hits what it aimed at).
//
// Wiring note for whoever mounts this: render it as `<Calculator open={x} …/>`
// rather than `{x && <Calculator …/>}`. It returns null when closed, which
// keeps its history and its memory alive across a close and reopen — unmounting
// it throws away the working of the lesson so far.
// ─────────────────────────────────────────────────────────────────────────

export interface CalculatorEntry {
  id: string;
  /** Exactly what was typed, so tapping it puts the working back, not the answer. */
  expression: string;
  /** The answer as it was displayed. */
  result: string;
  /** Whether it was worked out in degrees, since sin(30) means two things. */
  degrees: boolean;
}

interface CalculatorProps {
  open: boolean;
  onClose: () => void;
  /**
   * May this person use a calculator at all? The room decides — the teacher
   * always, a student only when he has turned it on for them.
   */
  canUse: boolean;
  title?: string;
  /**
   * "Let the class see this one." Optional, and the only way a result leaves
   * this component. Nothing here imports a socket; the room does the sending.
   */
  onShare?: (entry: CalculatorEntry) => void;
  shareLabel?: string;
}

type Mode = 'basic' | 'scientific';
type Angle = 'deg' | 'rad';

interface KeyDef {
  label: string;
  /** Text typed into the expression at the caret. */
  insert?: string;
  /** A command instead of text. */
  run?: () => void;
  tone?: 'digit' | 'op' | 'fn' | 'accent' | 'warn';
  span?: number;
  /** Said out loud by a screen reader, when the label is a symbol. */
  aria?: string;
}

const STORE_KEY = 'mathslive:calculator';
const HISTORY_LIMIT = 12;

// 46px, which clears Apple's 44px minimum touch target with a pixel to spare.
// The students are on iPads and iPhones; a 32px key is a key that gets pressed
// twice, and the second press is a wrong answer in front of a class.
const KEY_HEIGHT = 46;

// Which functions care about DEG/RAD. Used to decide when the toggle has to be
// on screen even in basic mode.
const USES_ANGLES = /\b(a?sin|a?cos|a?tan)\s*\(/i;

interface Stored {
  x: number;
  y: number;
  mode: Mode;
  angle: Angle;
}

/**
 * Where it was last put, and how it was last set up.
 *
 * Position, mode and DEG/RAD only. The history stays in memory on purpose: last
 * Tuesday's sums reappearing in Thursday's lesson is clutter, and a calculation
 * a tutor did for one student is not something to leave lying in the browser of
 * whoever sits down next.
 */
function loadStored(): Stored {
  const fallback: Stored = {
    // Away from the left edge, which the tool rail owns for its whole height,
    // and clear of the top chrome. The video call button learned this the hard
    // way by launching on top of the first three tools.
    //
    // `|| 1280` because a pane that has not been laid out yet reports a width
    // of zero, and the panel would then open pinned to the left edge on top of
    // that rail — the resize clamp below pulls it back in if 1280 is generous.
    x: Math.max(16, ((typeof window !== 'undefined' ? window.innerWidth : 0) || 1280) - 356),
    y: 92,
    mode: 'basic',
    angle: 'deg',
  };
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return fallback;
    const saved = JSON.parse(raw) as Partial<Stored>;
    return {
      x: Number.isFinite(saved.x) ? (saved.x as number) : fallback.x,
      y: Number.isFinite(saved.y) ? (saved.y as number) : fallback.y,
      mode: saved.mode === 'scientific' ? 'scientific' : 'basic',
      angle: saved.angle === 'rad' ? 'rad' : 'deg',
    };
  } catch {
    return fallback;   // corrupt or private mode — the defaults are fine
  }
}

/**
 * A number written so that the engine can read it back.
 *
 * formatResult gives a person something to read, and for a big enough number
 * that is `1e+21`. Typing that back into the line would be read as 1 × e + 21,
 * because `e` is Euler's number here — twenty-three point seven, silently, from
 * pressing memory-recall. So anything in exponent form goes back in as the
 * multiplication it actually is.
 */
function asExpression(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const text = formatResult(value);
  if (!/e/i.test(text)) return text;
  const [mantissa, exponent] = text.split(/e/i);
  return `(${mantissa}*10^${Number(exponent)})`;
}

export default function Calculator({ open, onClose, canUse, title, onShare, shareLabel }: CalculatorProps) {
  const [initial] = useState(loadStored);
  // A finger or a mouse. The two differ on one question — whether putting the
  // caret back in the line is a kindness or a software keyboard covering the
  // lesson — and they get different answers below.
  const [coarsePointer] = useState(() => {
    try { return window.matchMedia('(pointer: coarse)').matches; } catch { return false; }
  });

  const [mode, setMode] = useState<Mode>(initial.mode);
  const [angle, setAngle] = useState<Angle>(initial.angle);
  const [pos, setPos] = useState({ x: initial.x, y: initial.y });
  const [expr, setExpr] = useState('');
  const [history, setHistory] = useState<CalculatorEntry[]>([]);
  const [memory, setMemory] = useState(0);
  // What `ans` means. Kept as a number rather than read back off the display,
  // and only replaced when an answer was a real one: an undefined result stored
  // as Ans turns every sum after it into undefined too, which looks exactly
  // like a calculator that has broken.
  const [ans, setAns] = useState(0);
  // Set only by pressing =. While typing, an unfinished expression is not a
  // mistake to shout about; once he has asked for the answer, it is.
  const [problem, setProblem] = useState<string | null>(null);
  const [recall, setRecall] = useState(-1);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const caretRef = useRef<number | null>(null);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);

  // The answer as it stands, recomputed on every keystroke.
  //
  // A live preview is the difference between a calculator and a form: he sees
  // 47 appear as he types and never presses = at all. It is also why the engine
  // must not throw for maths errors — half of what is on screen mid-typing is
  // an incomplete expression, and each one of those would otherwise be an
  // exception per character.
  const preview = useMemo(() => {
    const src = expr.trim();
    if (!src) return { value: null as number | null, text: '', trouble: null as string | null };
    try {
      const value = calculate(src, { degrees: angle === 'deg', vars: { ans } });
      return { value, text: formatResult(value), trouble: null };
    } catch (err) {
      return {
        value: null,
        text: '',
        trouble: err instanceof ExpressionError ? err.message : 'that is not something I can work out',
      };
    }
  }, [expr, angle, ans]);

  // A remembered position must not survive a move to a smaller screen, or the
  // panel sits off the edge of an iPad with no header left to grab.
  useEffect(() => {
    const clamp = () => setPos((p) => ({
      x: Math.max(8, Math.min(window.innerWidth - 120, p.x)),
      y: Math.max(8, Math.min(window.innerHeight - 80, p.y)),
    }));
    window.addEventListener('resize', clamp);
    return () => window.removeEventListener('resize', clamp);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ x: pos.x, y: pos.y, mode, angle }));
    } catch { /* private mode: it just opens where it opened */ }
  }, [pos, mode, angle]);

  // Focus the line when it opens — but only where there is a real keyboard.
  // On a touch device this call is what makes the software keyboard slide up
  // over the lesson before he has asked to type anything, which on an iPad
  // costs half the screen the class is looking at.
  useEffect(() => {
    if (!open || !canUse || coarsePointer) return;
    inputRef.current?.focus();
  }, [open, canUse, coarsePointer]);

  // Put the caret back where the key left it. Only meaningful when the line has
  // focus: a tap on a key deliberately does NOT take focus, so on an iPad this
  // never runs and the text simply appends.
  useLayoutEffect(() => {
    const at = caretRef.current;
    caretRef.current = null;
    const input = inputRef.current;
    if (at === null || !input || document.activeElement !== input) return;
    try { input.setSelectionRange(at, at); } catch { /* not a text input any more */ }
  }, [expr]);

  /** Where a keypress lands: the selection if the line has focus, the end if not. */
  const caretRange = useCallback((): { start: number; end: number; focused: boolean } => {
    const input = inputRef.current;
    const focused = !!input && document.activeElement === input;
    if (!focused || !input || input.selectionStart == null || input.selectionEnd == null) {
      return { start: expr.length, end: expr.length, focused: false };
    }
    return { start: input.selectionStart, end: input.selectionEnd, focused: true };
  }, [expr]);

  const insert = useCallback((text: string) => {
    const { start, end, focused } = caretRange();
    caretRef.current = focused ? start + text.length : null;
    setExpr(expr.slice(0, start) + text + expr.slice(end));
    setProblem(null);
    setRecall(-1);
  }, [expr, caretRange]);

  const backspace = useCallback(() => {
    const { start, end, focused } = caretRange();
    if (start === end) {
      if (start === 0) return;
      caretRef.current = focused ? start - 1 : null;
      setExpr(expr.slice(0, start - 1) + expr.slice(end));
    } else {
      caretRef.current = focused ? start : null;
      setExpr(expr.slice(0, start) + expr.slice(end));
    }
    setProblem(null);
  }, [expr, caretRange]);

  /**
   * ± flips the sign of the number the caret is sitting on, not of everything.
   *
   * Negating the whole line would turn 2+3 into -(2+3), which is not what the
   * key means on any calculator he has ever held: it means "this number I am
   * typing is negative". `2+-3` is exactly what the engine reads as 2 + (−3).
   */
  const toggleSign = useCallback(() => {
    const { start: at, focused } = caretRange();
    let start = at;
    while (start > 0 && /[0-9.]/.test(expr[start - 1])) start--;
    if (start > 0 && expr[start - 1] === '-') {
      const before = start >= 2 ? expr[start - 2] : '';
      // Only strip a minus that is a SIGN. The one in `10-3` belongs to the
      // subtraction, and eating it would silently change the sum.
      if (before === '' || '+-*/^(,'.includes(before)) {
        caretRef.current = focused ? at - 1 : null;
        setExpr(expr.slice(0, start - 1) + expr.slice(start));
        return;
      }
    }
    caretRef.current = focused ? at + 1 : null;
    setExpr(expr.slice(0, start) + '-' + expr.slice(start));
  }, [expr, caretRange]);

  const commit = useCallback(() => {
    const src = expr.trim();
    if (!src) return;
    try {
      const value = calculate(src, { degrees: angle === 'deg', vars: { ans } });
      const entry: CalculatorEntry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        expression: src,
        result: formatResult(value),
        degrees: angle === 'deg',
      };
      // An undefined answer is still worth keeping in the history — "why did
      // that come out undefined" is a teachable moment, and dropping it would
      // just look like the = key had failed.
      setHistory((h) => [entry, ...h].slice(0, HISTORY_LIMIT));
      if (Number.isFinite(value)) setAns(value);
      setProblem(null);
      setRecall(-1);
    } catch (err) {
      setProblem(err instanceof ExpressionError ? err.message : 'that is not something I can work out');
    }
  }, [expr, angle, ans]);

  // ── Dragging by the header ──
  const onDragStart = (e: ReactPointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;   // a control, not a handle
    dragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* no capture; it still drags */ }
  };
  const onDragMove = (e: ReactPointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setPos({
      x: Math.max(8, Math.min(window.innerWidth - 120, e.clientX - d.dx)),
      y: Math.max(8, Math.min(window.innerHeight - 80, e.clientY - d.dy)),
    });
  };
  const onDragEnd = () => { dragRef.current = null; };

  // Keys are handled on the panel, not on window.
  //
  // Escape is spoken for elsewhere — the whiteboard uses it to drop a selection
  // and the overlays use it to close — so a global listener here would make one
  // press do two things depending on what happened to mount first.
  const onKeyDown = (e: any) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); return; }
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
    // Up and down walk back through what he has already worked out, the way a
    // terminal does. It costs the caret's home/end behaviour on a single-line
    // input, which is a trade a tutor re-running "that same sum, but with 12"
    // will take every time.
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      if (history.length === 0) return;
      e.preventDefault();
      const next = e.key === 'ArrowUp'
        ? Math.min(recall + 1, history.length - 1)
        : Math.max(recall - 1, -1);
      setRecall(next);
      setExpr(next < 0 ? '' : history[next].expression);
      setProblem(null);
    }
  };

  // Permission and visibility are both the parent's to decide, and both end
  // here. Returning null rather than unmounting is what keeps the memory and
  // the history alive while it is shut.
  if (!open || !canUse) return null;

  const scientificKeys: KeyDef[] = [
    { label: 'sin', insert: 'sin(', tone: 'fn' },
    { label: 'cos', insert: 'cos(', tone: 'fn' },
    { label: 'tan', insert: 'tan(', tone: 'fn' },
    { label: 'xʸ', insert: '^', tone: 'fn', aria: 'to the power of' },
    { label: '√', insert: 'sqrt(', tone: 'fn', aria: 'square root' },
    { label: 'sin⁻¹', insert: 'asin(', tone: 'fn', aria: 'inverse sine' },
    { label: 'cos⁻¹', insert: 'acos(', tone: 'fn', aria: 'inverse cosine' },
    { label: 'tan⁻¹', insert: 'atan(', tone: 'fn', aria: 'inverse tangent' },
    { label: 'x²', insert: '^2', tone: 'fn', aria: 'squared' },
    { label: 'x!', insert: '!', tone: 'fn', aria: 'factorial' },
    { label: 'ln', insert: 'ln(', tone: 'fn' },
    { label: 'log', insert: 'log(', tone: 'fn' },
    { label: 'log₂', insert: 'log2(', tone: 'fn', aria: 'log base two' },
    { label: 'π', insert: 'pi', tone: 'fn', aria: 'pi' },
    { label: 'e', insert: 'e', tone: 'fn' },
  ];

  // Everything else the engine knows — cbrt, exp, abs, floor, ceil, round,
  // sinh, min, max, pow — is reachable by typing its name. A keypad with
  // thirty keys on it is a keypad nobody can find anything on.
  const padKeys: KeyDef[] = [
    { label: 'MC', run: () => setMemory(0), tone: 'fn', aria: 'memory clear' },
    { label: 'MR', run: () => insert(asExpression(memory)), tone: 'fn', aria: 'memory recall' },
    { label: 'M+', run: () => setMemory((m) => m + (preview.value ?? 0)), tone: 'fn', aria: 'add to memory' },
    { label: 'M−', run: () => setMemory((m) => m - (preview.value ?? 0)), tone: 'fn', aria: 'subtract from memory' },
    { label: 'C', run: () => { setExpr(''); setProblem(null); setRecall(-1); }, tone: 'warn', aria: 'clear' },

    { label: '7', insert: '7', tone: 'digit' },
    { label: '8', insert: '8', tone: 'digit' },
    { label: '9', insert: '9', tone: 'digit' },
    { label: '⌫', run: backspace, tone: 'op', aria: 'backspace' },
    { label: '÷', insert: '/', tone: 'op', aria: 'divide' },

    { label: '4', insert: '4', tone: 'digit' },
    { label: '5', insert: '5', tone: 'digit' },
    { label: '6', insert: '6', tone: 'digit' },
    { label: '%', insert: '%', tone: 'op', aria: 'percent' },
    { label: '×', insert: '*', tone: 'op', aria: 'multiply' },

    { label: '1', insert: '1', tone: 'digit' },
    { label: '2', insert: '2', tone: 'digit' },
    { label: '3', insert: '3', tone: 'digit' },
    { label: '(', insert: '(', tone: 'op' },
    { label: '−', insert: '-', tone: 'op', aria: 'minus' },

    { label: '0', insert: '0', tone: 'digit' },
    { label: '.', insert: '.', tone: 'digit', aria: 'point' },
    { label: '±', run: toggleSign, tone: 'op', aria: 'change sign' },
    { label: ')', insert: ')', tone: 'op' },
    { label: '+', insert: '+', tone: 'op', aria: 'plus' },

    { label: 'Ans', insert: 'ans', tone: 'op', span: 2, aria: 'last answer' },
    { label: '=', run: commit, tone: 'accent', span: 3, aria: 'equals' },
  ];

  const toneStyle = (tone: KeyDef['tone']) => {
    switch (tone) {
      case 'accent':
        return { background: 'var(--accent-indigo)', color: 'var(--text-inverse)', border: '1px solid transparent' };
      case 'warn':
        return { background: 'var(--accent-rose-light)', color: 'var(--accent-rose)', border: '1px solid var(--border-subtle)' };
      case 'op':
        return { background: 'var(--bg-surface)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' };
      case 'fn':
        return { background: 'var(--bg-surface)', color: 'var(--text-secondary)', border: '1px solid var(--border-subtle)' };
      default:
        return { background: 'var(--bg-card)', color: 'var(--text-primary)', border: '1px solid var(--border-default)' };
    }
  };

  const renderKey = (key: KeyDef, index: number) => (
    <button
      key={`${key.label}-${index}`}
      type="button"
      aria-label={key.aria || key.label}
      // Pointer, not mouse, and preventDefault so the press never moves focus.
      // That is what keeps the caret where he left it in the middle of a sum on
      // the laptop, and what stops the iPad's keyboard appearing the moment a
      // student taps 7.
      onPointerDown={(e) => e.preventDefault()}
      onClick={() => {
        if (key.run) key.run(); else if (key.insert) insert(key.insert);
        // Hand the line back its focus, but only where there is a real
        // keyboard. Otherwise a tutor who taps 12 × 4 and then reaches for
        // Enter presses it into nothing: the keys refuse focus on purpose, so
        // without this there is no element left for the key to arrive at. On
        // an iPad the same call would slide the keyboard up over the lesson,
        // which is why it is asked rather than assumed.
        if (!coarsePointer) inputRef.current?.focus();
      }}
      style={{
        gridColumn: key.span ? `span ${key.span}` : undefined,
        minHeight: KEY_HEIGHT,
        borderRadius: 'var(--radius-lg)',
        fontSize: key.tone === 'fn' ? 12 : 16,
        fontWeight: key.tone === 'digit' ? 600 : 550,
        cursor: 'pointer',
        // Kills the 300ms wait iOS spends deciding whether a tap was the first
        // half of a double-tap-to-zoom. Without it every key feels broken.
        touchAction: 'manipulation',
        userSelect: 'none',
        ...toneStyle(key.tone),
      }}
    >
      {key.label}
    </button>
  );

  const grid = { display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', gap: 6 };

  // DEG/RAD belongs to scientific mode, but the setting keeps applying in basic
  // mode — and a tutor who types sin(30) there deserves to see which of 0.5 and
  // −0.988 he is about to be given. So the toggle comes back the moment the
  // line contains a trig function, whatever mode is showing.
  const showAngle = mode === 'scientific' || USES_ANGLES.test(expr);

  return (
    <div
      role="dialog"
      data-testid="calculator-panel"
      aria-label={title || 'Calculator'}
      onKeyDown={onKeyDown}
      style={{
        position: 'fixed', left: pos.x, top: pos.y,
        // Above the lesson, the whiteboard and the call bubble (70); below the
        // room's own dialogs, which live at 86 and 92 in Room.tsx.
        zIndex: 78,
        width: 340,
        // Measured from where the panel actually starts, not from the top of
        // the window. An iPad in landscape is 768px tall; scientific mode with
        // a few sums behind it is taller than what is left below wherever he
        // dragged it, and the part that would hang off the bottom is the =
        // key. The keypad scrolls instead.
        maxHeight: `calc(100vh - ${Math.max(0, pos.y)}px - 12px)`,
        display: 'flex', flexDirection: 'column',
        background: 'var(--bg-card)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-2xl)',
        boxShadow: 'var(--shadow-xl)',
        overflow: 'hidden',
      }}
    >
      <div
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
        className="flex items-center gap-1.5 px-3 py-2 shrink-0"
        style={{
          borderBottom: '1px solid var(--border-subtle)',
          cursor: 'grab',
          // Without this a finger dragging the header scrolls the page behind
          // it instead of moving the panel.
          touchAction: 'none',
        }}
      >
        <span className="text-sm font-semibold truncate flex-1" style={{ color: 'var(--text-primary)' }}>
          {title || 'Calculator'}
        </span>

        {(['basic', 'scientific'] as Mode[]).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            aria-pressed={mode === m}
            style={{
              minHeight: 30, padding: '0 10px', borderRadius: 'var(--radius-md)',
              fontSize: 11, fontWeight: 650, cursor: 'pointer', touchAction: 'manipulation',
              background: mode === m ? 'var(--accent-indigo-light)' : 'transparent',
              color: mode === m ? 'var(--accent-indigo)' : 'var(--text-muted)',
              border: '1px solid ' + (mode === m ? 'var(--accent-indigo-light)' : 'var(--border-subtle)'),
            }}
          >
            {m === 'basic' ? 'Basic' : 'Sci'}
          </button>
        ))}

        {/* sin(30) is 0.5 in degrees and −0.988 in radians. A tutor who cannot
            see which one he is in has no way to know which answer he just read
            out to a student, so this is never hidden while it matters. */}
        {showAngle && (
          <button
            type="button"
            onClick={() => setAngle((a) => (a === 'deg' ? 'rad' : 'deg'))}
            aria-label={angle === 'deg' ? 'Angles in degrees, switch to radians' : 'Angles in radians, switch to degrees'}
            style={{
              minHeight: 30, padding: '0 8px', borderRadius: 'var(--radius-md)',
              fontSize: 11, fontWeight: 700, cursor: 'pointer', touchAction: 'manipulation',
              background: 'var(--accent-violet-light)', color: 'var(--accent-violet)',
              border: '1px solid var(--border-subtle)',
            }}
          >
            {angle === 'deg' ? 'DEG' : 'RAD'}
          </button>
        )}

        <button
          type="button"
          onClick={onClose}
          aria-label="Close the calculator"
          style={{
            minWidth: 30, minHeight: 30, borderRadius: 'var(--radius-md)',
            background: 'transparent', border: 'none', color: 'var(--text-muted)',
            fontSize: 16, cursor: 'pointer', touchAction: 'manipulation',
          }}
        >
          ✕
        </button>
      </div>

      <div className="px-3 pt-3 pb-2 shrink-0">
        <input
          ref={inputRef}
          value={expr}
          onChange={(e) => { setExpr(e.target.value); setProblem(null); setRecall(-1); }}
          placeholder="Type or tap a sum"
          inputMode="text"
          // iOS capitalises the first letter of a field by default, which turns
          // sin into Sin. The engine lowercases names for exactly this reason,
          // but there is no good coming of the tutor watching it happen.
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          data-testid="calculator-input"
          aria-label="Expression"
          style={{
            width: '100%', minHeight: 40, padding: '8px 10px',
            borderRadius: 'var(--radius-lg)',
            background: 'var(--bg-surface)',
            border: '1px solid var(--border-subtle)',
            color: 'var(--text-primary)',
            fontSize: 18, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          }}
        />

        <div className="flex items-end justify-between gap-2 mt-1.5" style={{ minHeight: 30 }}>
          <div className="min-w-0 flex-1">
            {problem ? (
              <div className="text-[12px] leading-snug" style={{ color: 'var(--accent-rose)' }}>{problem}</div>
            ) : preview.text ? (
              <div className="truncate" data-testid="calculator-result" style={{ color: 'var(--text-primary)', fontSize: 22, fontWeight: 700, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                = {preview.text}
              </div>
            ) : (
              // Mid-typing trouble is stated quietly. "a bracket was opened and
              // never closed" is useful; the same sentence in red on every
              // keystroke of a long expression is nagging.
              <div className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>{preview.trouble || ' '}</div>
            )}
          </div>

          {memory !== 0 && (
            <span className="badge text-[9px] shrink-0" style={{ background: 'var(--accent-amber-light)', color: 'var(--accent-amber)' }}>
              M {formatResult(memory)}
            </span>
          )}

          {/* Only after = — sharing is a deliberate act, and a button wired to
              the live preview would put half-typed sums on the class's screen. */}
          {onShare && history.length > 0 && (
            <button
              type="button"
              onClick={() => onShare(history[0])}
              className="shrink-0"
              style={{
                minHeight: 30, padding: '0 10px', borderRadius: 'var(--radius-md)',
                fontSize: 11, fontWeight: 650, cursor: 'pointer', touchAction: 'manipulation',
                background: 'var(--accent-emerald-light)', color: 'var(--accent-emerald)',
                border: '1px solid var(--border-subtle)',
              }}
            >
              {shareLabel || 'Show students'}
            </button>
          )}
        </div>
      </div>

      <div className="px-3 pb-3 overflow-y-auto" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {mode === 'scientific' && (
          <div style={grid}>{scientificKeys.map(renderKey)}</div>
        )}
        <div style={grid}>{padKeys.map(renderKey)}</div>

        {history.length > 0 && (
          <div className="mt-1">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Recent</span>
              <button
                type="button"
                onClick={() => setHistory([])}
                style={{
                  minHeight: 28, padding: '0 8px', borderRadius: 'var(--radius-md)',
                  background: 'transparent', border: 'none', color: 'var(--text-muted)',
                  fontSize: 11, cursor: 'pointer', touchAction: 'manipulation',
                }}
              >
                Clear
              </button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 132, overflowY: 'auto' }}>
              {/* Tapping puts the WORKING back on the line, not the answer. He
                  reaches for a previous line to change one number in it; giving
                  him 47 to edit instead of 12*4-1 is giving him the wrong thing. */}
              {history.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => { setExpr(entry.expression); setProblem(null); setRecall(-1); }}
                  className="flex items-baseline justify-between gap-2 text-left"
                  style={{
                    minHeight: 34, padding: '5px 9px', borderRadius: 'var(--radius-md)',
                    background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)',
                    cursor: 'pointer', touchAction: 'manipulation',
                  }}
                >
                  <span className="truncate text-[11px]" style={{ color: 'var(--text-secondary)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                    {entry.expression}
                  </span>
                  <span className="shrink-0 text-[12px] font-semibold" style={{ color: 'var(--text-primary)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                    = {entry.result}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
