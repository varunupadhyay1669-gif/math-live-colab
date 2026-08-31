import { useState } from 'react';

// The landing page's argument, as a thing you can touch.
//
// Every tutoring site shows a screenshot of a whiteboard. A whiteboard is not
// what MathsLive does that Zoom cannot — a phone pointed at paper is a
// whiteboard. What it does is put a live, manipulable model in front of the
// student, which is precisely the thing a screenshot cannot demonstrate.
//
// So the hero is not a picture of the product. It IS the product, running,
// with the visitor sitting in the student's seat.
//
// The maths is the real lesson from a real session: 4 × 21 × 5, where pairing
// 4 and 5 first turns a multiplication you write down into one you do in your
// head. A tutor recognises it immediately — which is the point, because the
// page has to convince someone who teaches this for a living.

const NUMBERS = [4, 21, 5] as const;

interface Working {
  a: number; b: number; rest: number; first: number; total: number; easy: boolean;
}

function work(pair: [number, number] | null): Working | null {
  if (!pair) return null;
  const [i, j] = pair;
  const a = NUMBERS[i], b = NUMBERS[j];
  const rest = NUMBERS[[0, 1, 2].find(k => k !== i && k !== j)!];
  const first = a * b;
  return {
    a, b, rest, first, total: first * rest,
    // A round first step is what "convenient order" means: 20 × 21 is a step
    // you take in your head, 84 × 5 is one you write down.
    easy: first % 10 === 0,
  };
}

export default function ConvenientOrderDemo({ compact = false }: { compact?: boolean }) {
  const [picked, setPicked] = useState<number[]>([]);
  const pair = picked.length === 2 ? [picked[0], picked[1]] as [number, number] : null;
  const w = work(pair);

  const toggle = (i: number) => {
    setPicked(prev => {
      if (prev.includes(i)) return prev.filter(x => x !== i);
      if (prev.length >= 2) return [prev[1], i];
      return [...prev, i];
    });
  };

  return (
    <div className={`ml-demo${compact ? ' is-compact' : ''}`}>
      <div className="ml-demo-head">
        <span className="ml-demo-label">Try it yourself</span>
        <span className="ml-demo-nudge">tap two to multiply first</span>
      </div>

      <div className="ml-demo-row">
        {NUMBERS.map((n, i) => (
          <button
            key={i}
            className={`ml-demo-tile${picked.includes(i) ? ' is-on' : ''}`}
            onClick={() => toggle(i)}
            aria-pressed={picked.includes(i)}
            aria-label={`Multiply ${n} first`}
          >
            {n}
          </button>
        ))}
      </div>

      <div className="ml-demo-out" aria-live="polite">
        {!w ? (
          <>
            <p className="ml-demo-sum">4 × 21 × 5</p>
            <p className="ml-demo-hint">
              Multiplication works in any order. Which two would you pair first?
            </p>
          </>
        ) : (
          <>
            <p className="ml-demo-sum">
              {w.a} × {w.b} = {w.first}
              <span className="ml-demo-arrow"> → </span>
              {w.first} × {w.rest} = <span className="ml-demo-total">{w.total}</span>
            </p>
            <p className={`ml-demo-verdict${w.easy ? ' is-easy' : ''}`}>
              {w.easy
                ? `${w.first} × ${w.rest} is a step you do in your head. Same answer, no working out.`
                : `${w.first} × ${w.rest} is the one you write down. Same answer — now try pairing 4 and 5.`}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
