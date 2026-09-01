import { useState } from 'react';
import { SEED_LESSONS } from '../lib/seedLessons';

// The shipped lessons, running on the marketing page.
//
// The page tells a visitor the board runs things, and then made them sign up
// to see one. That is the wrong way round: the product is the argument, and
// asking for an account before showing it is asking for trust before giving
// any.
//
// These are not mockups or recordings of the lessons — they are THE lessons,
// the same objects the library ships, rendered from the same source. A tutor
// who plays with one here has already used the product, and the trial is then
// a formality rather than a leap.
//
// Sandboxed with scripts but no same-origin: the lesson runs, and cannot reach
// the page around it. That matters more once these come from teachers.
const SHOWN = ['seed_fraction_wall', 'seed_balance', 'seed_angle_sum', 'seed_probability'];

export default function LessonTaster() {
  const lessons = SHOWN
    .map(id => SEED_LESSONS.find(l => l.id === id))
    .filter((l): l is NonNullable<typeof l> => !!l);
  const [active, setActive] = useState(0);
  const lesson = lessons[active];
  if (!lesson) return null;

  return (
    <div className="ml-taste">
      <div className="ml-taste-tabs" role="tablist" aria-label="Lessons you can try">
        {lessons.map((l, i) => (
          <button
            key={l.id}
            role="tab"
            aria-selected={i === active}
            className={`ml-taste-tab${i === active ? ' is-on' : ''}`}
            onClick={() => setActive(i)}
          >
            <span className="ml-taste-name">{l.name}</span>
            <span className="ml-taste-topic">{l.topic}</span>
          </button>
        ))}
      </div>

      <div className="ml-taste-stage">
        <p className="ml-taste-blurb">{lesson.blurb}</p>
        <iframe
          /* Keyed so switching tabs remounts and the lesson starts clean,
             rather than showing the last visitor's half-solved equation. */
          key={lesson.id}
          className="ml-taste-frame"
          title={lesson.name}
          srcDoc={lesson.html}
          sandbox="allow-scripts"
        />
      </div>
    </div>
  );
}
