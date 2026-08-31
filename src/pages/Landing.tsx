import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import ConvenientOrderDemo from '../components/ConvenientOrderDemo';
import { getPublicPricing, type PublicPricing } from '../lib/billing';

// The page that has to convince a tutor in about fifteen seconds.
//
// The old front door was the app itself: a room-code box and a "start
// teaching" button, which answers "how do I use this?" for someone who already
// decided to, and nothing at all for someone deciding. This answers the
// deciding.
//
// It is written for one reader — a tutor in India who currently teaches on
// Zoom with a phone pointed at paper, and who is quietly aware that is not
// good enough. Everything here is aimed at that person: the demo is real
// maths from a real lesson, the price is stated without a discovery call, and
// the competitor named is Zoom, because that is the truth.
export default function Landing() {
  const navigate = useNavigate();
  const [p, setP] = useState<PublicPricing | null>(null);

  useEffect(() => { getPublicPricing().then(setP).catch(() => setP(null)); }, []);
  const price = p?.priceRupees ?? 500;
  const trialDays = p?.trialDays ?? 7;

  return (
    <div className="ml-dark-home">
      <div className="ml-dark-stage">
        <header className="ml-dark-topbar">
          <div className="ml-dark-brand">
            <span className="ml-dark-wordmark">Maths<span className="accent">Live</span></span>
          </div>
          <div className="ml-land-nav">
            <button className="ml-dark-btn ml-dark-btn-ghost" onClick={() => navigate('/pricing')}>
              Pricing
            </button>
            <button className="ml-dark-btn ml-dark-btn-primary" onClick={() => navigate('/')}>
              Start teaching
            </button>
          </div>
        </header>

        <div className="ml-dark-center ml-page-top">
          <div className="ml-land">
            {/* The thesis: not a picture of the product, the product. */}
            <section className="ml-land-hero">
              <h1 className="ml-land-h1">
                Show them the maths.<br />Not a photo of your notebook.
              </h1>
              <p className="ml-land-sub">
                A live teaching board where your student sees and touches the same
                thing you do — interactive, on their iPad, over ordinary home
                internet. {trialDays} days free, then ₹{price} a month.
              </p>
              <ConvenientOrderDemo />
            </section>

            {/* Three claims, each one a thing Zoom cannot do. */}
            <section className="ml-land-grid">
              <div className="ml-land-card">
                <h3>They tap one link</h3>
                <p>
                  Every student gets a permanent link of their own. No account, no
                  app, no password — ever. A ten-year-old on a shared iPad taps it
                  and is in the lesson.
                </p>
              </div>
              <div className="ml-land-card">
                <h3>The board is shared, properly</h3>
                <p>
                  Write, draw, paste a textbook page, run an interactive. It appears
                  on their screen as it happens — not a video of your screen, the
                  actual thing, sharp enough to read on a tablet.
                </p>
              </div>
              <div className="ml-land-card">
                <h3>The lesson is kept</h3>
                <p>
                  Every board, every topic, every minute taught, saved per student.
                  Open a child's page before the next lesson and you know exactly
                  where you left off.
                </p>
              </div>
            </section>

            {/* The honest comparison. Naming Zoom is the credibility. */}
            <section className="ml-land-vs">
              <h2 className="ml-land-h2">What you are probably using now</h2>
              <div className="ml-land-vs-row">
                <div className="ml-land-vs-col">
                  <span className="ml-land-vs-tag">Zoom and a phone on a stand</span>
                  <ul>
                    <li>They watch you write. They cannot write with you.</li>
                    <li>Nothing is kept. Last week's work is gone.</li>
                    <li>Parents see a video call and wonder what they are paying for.</li>
                    <li>Free.</li>
                  </ul>
                </div>
                <div className="ml-land-vs-col is-us">
                  <span className="ml-land-vs-tag">MathsLive</span>
                  <ul>
                    <li>They work on the same board, from their own screen.</li>
                    <li>Every lesson saved, per student, with the boards.</li>
                    <li>Something to send the parent after each class.</li>
                    <li>₹{price} a month — about twenty minutes of one lesson's fee.</li>
                  </ul>
                </div>
              </div>
            </section>

            <section className="ml-land-cta">
              <h2 className="ml-land-h2">Try it on your next lesson</h2>
              <p className="ml-land-sub">
                {trialDays} days free. No card, nothing to cancel — if you stop, your
                students and boards stay exactly where they are.
              </p>
              <div className="ml-land-cta-row">
                <button className="ml-dark-btn ml-dark-btn-primary" onClick={() => navigate('/')}>
                  Start teaching free
                </button>
                <button className="ml-dark-btn ml-dark-btn-ghost" onClick={() => navigate('/pricing')}>
                  See what it costs
                </button>
              </div>
              <p className="ml-land-fine">
                Built and run by a maths tutor, in India. Payments by UPI, to a person.
              </p>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
