import { useState } from 'react';

// The landing page's argument, as a thing you can touch.
//
// Every tutoring site shows a screenshot of a whiteboard. A whiteboard is not
// what MathsLive does that Zoom cannot — a phone pointed at paper is a
// whiteboard. What it does is put a live, manipulable model in front of the
// student, which is precisely the thing a screenshot cannot demonstrate.
//
// So the hero is not a picture of the product. It IS the product, running, with
// the visitor in the student's seat.
//
// The maths is deliberately the real lesson from a real session: 4 x 21 x 5,
// where pairing 4 and 5 first turns a hard multiplication into an easy one.
// A tutor recognises it immediately, which is the point — the page has to be
// convincing to someone who teaches this for a living, not to a marketer.

const NUMBERS = [4, 21, 5] as const;

/** The two chosen numbers, and the one left over. */
function work(pair: [number, number] | null) {
  if (!pair) return null;
  const [i, j] = pair;
  const a = NUMBERS[i], b = NUMBERS[j];
  const rest = NUMBERS[[0, 1, 2].find(k => k !== i && k !== j)!];
  const first = a * b;
  return {
    a, b, rest, first, total: first * rest,
    // A round first step is what "convenient" means: 20 x 21 is arithmetic you
    // do in your head, 84 x 5 is arithmetic you write down.
    easy: first % 10 === 0,
  };
}

export default function ConvenientOrderDemo() {
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
    <div className="ml-demo">
      <div className="ml-demo-task">
        <span className="ml-demo-label">Try it — tap two numbers to multiply first</span>
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
      </div>

      <div className="ml-demo-out" aria-live="polite">
        {!w ? (
          <p className="ml-demo-hint">
            4 × 21 × 5. Multiplication can be done in any order — so which two would you
            pair first?
          </p>
        ) : (
          <>
            <p className="ml-demo-step">
              <strong>{w.a} × {w.b} = {w.first}</strong>
              <span className="ml-demo-then">then {w.first} × {w.rest} =</span>
              <strong className="ml-demo-total">{w.total}</strong>
            </p>
            <p className={`ml-demo-verdict${w.easy ? ' is-easy' : ''}`}>
              {w.easy
                ? `${w.first} × ${w.rest} is a step you can do in your head. Same answer, no working out.`
                : `${w.first} × ${w.rest} is the one you have to write down. Same answer — try pairing 4 and 5 instead.`}
            </p>
          </>
        )}
      </div>

      <p className="ml-demo-foot">
        Your student sees this on their own screen, moving as you move it. Not a
        video of it, not a screenshot — the same live thing, on an iPad, on home
        broadband.
      </p>
    </div>
  );
}
