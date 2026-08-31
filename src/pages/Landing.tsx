import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import ConvenientOrderDemo from '../components/ConvenientOrderDemo';
import { getPublicPricing, type PublicPricing } from '../lib/billing';

// The page that has to convince a tutor in about fifteen seconds.
//
// The old front door was the app itself: a room-code box and a "start
// teaching" button, which answers "how do I use this?" for someone who already
// decided, and nothing at all for someone deciding.
//
// The design commits to one idea rather than hedging. The headline promises
// "not a photo of your notebook", so the page IS a notebook — ruled paper,
// serif numerals, the working shown rather than described. It reads as maths
// rather than as software, which is the register the reader lives in.
//
// Written for one person: a tutor in India teaching on Zoom with a phone
// pointed at paper, quietly aware that is not good enough. Hence the
// competitor named is Zoom — not another tutoring platform — because that is
// the truth and pretending otherwise is exactly what makes marketing pages
// unreadable to the people they are aimed at.
export default function Landing() {
  const navigate = useNavigate();
  const [p, setP] = useState<PublicPricing | null>(null);

  useEffect(() => { getPublicPricing().then(setP).catch(() => setP(null)); }, []);
  const price = p?.priceRupees ?? 500;
  const trialDays = p?.trialDays ?? 7;

  return (
    <div className="ml-paper">
      <header className="ml-land-bar">
        <span className="ml-land-mark">Maths<span>Live</span></span>
        <nav className="ml-land-nav">
          <button className="ml-land-link" onClick={() => navigate('/pricing')}>Pricing</button>
          <button className="ml-land-link" onClick={() => navigate('/')}>Sign in</button>
          <button className="ml-land-go" onClick={() => navigate('/')}>Start free</button>
        </nav>
      </header>

      <main className="ml-land">
        {/* Type on the left, the working thing on the right. */}
        <section className="ml-land-hero">
          <div className="ml-land-say">
            <span className="ml-land-eyebrow">For one-to-one maths tutors</span>
            <h1 className="ml-land-h1">Stop pointing a phone<br />at your notebook.</h1>
            <p className="ml-land-lede">
              Your student opens one link and lands on the same board you are working
              on — writing on it, moving things on it, from their own iPad. Not a video
              of your screen. The thing itself.
            </p>
            <div className="ml-land-act">
              <button className="ml-land-cta" onClick={() => navigate('/')}>
                Teach your next lesson free
              </button>
              <span className="ml-land-aside">{trialDays} days, no card</span>
            </div>
            <p className="ml-land-price">
              Then <strong>₹{price} a month</strong> — about twenty minutes of one
              lesson's fee.
            </p>
          </div>

          <div className="ml-land-show">
            <ConvenientOrderDemo />
            <p className="ml-land-caption">
              Your student sees exactly this, moving as you move it — on a tablet, on
              home broadband. That is the whole difference.
            </p>
          </div>
        </section>

        {/* The honest comparison. Naming Zoom is the credibility. */}
        <section className="ml-land-sec">
          <h2 className="ml-land-h2">What you are using today</h2>
          <p className="ml-land-sub">
            Not another tutoring platform. The thing you would actually be replacing.
          </p>
          <div className="ml-land-vs">
            <div className="ml-land-col">
              <span className="ml-land-tag">Zoom, and a phone on a stand</span>
              <p>They watch you write. They cannot write with you.</p>
              <p>Nothing is kept. Last week's working is gone.</p>
              <p>The parent sees a video call and wonders what they are paying for.</p>
              <p>Free — which is the honest part.</p>
            </div>
            <div className="ml-land-col is-us">
              <span className="ml-land-tag">MathsLive</span>
              <p>They work on the same board, from their own screen.</p>
              <p>Every board and every topic saved, per student.</p>
              <p>Something worth sending the parent after each class.</p>
              <p>₹{price} a month, paid by UPI, cancel by not paying.</p>
            </div>
          </div>
        </section>

        {/* Numbered because these are the three things in order of what a
            tutor meets first, not because a list wanted decoration. */}
        <section className="ml-land-three">
          <div className="ml-land-item">
            <span className="ml-land-num">01</span>
            <h3>They tap one link</h3>
            <p>
              A permanent link per student. No account, no app, no password — ever.
              A ten-year-old on a shared iPad taps it and is in the lesson.
            </p>
          </div>
          <div className="ml-land-item">
            <span className="ml-land-num">02</span>
            <h3>The board is properly shared</h3>
            <p>
              Write, draw, paste a textbook page, run something they can drag. It
              arrives on their screen as it happens, sharp enough to read on a tablet.
            </p>
          </div>
          <div className="ml-land-item">
            <span className="ml-land-num">03</span>
            <h3>The lesson is kept</h3>
            <p>
              Every board, topic and minute taught, saved per student. Open a child's
              page before the next lesson and you know where you stopped.
            </p>
          </div>
        </section>

        <section className="ml-land-close">
          <h2>Use it on your next lesson.</h2>
          <p>
            {trialDays} days free, no card. If you stop paying, nothing is deleted —
            your students, your boards and your links stay exactly where they are.
          </p>
          <button className="ml-land-cta is-light" onClick={() => navigate('/')}>
            Teach your next lesson free
          </button>
          <span className="ml-land-by">
            Built and run by a maths tutor, in India. Payments by UPI, to a person.
          </span>
        </section>
      </main>
    </div>
  );
}
