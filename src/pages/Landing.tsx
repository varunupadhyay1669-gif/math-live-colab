import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import ConvenientOrderDemo from '../components/ConvenientOrderDemo';
import BothSides from '../components/BothSides';
import LessonTaster from '../components/LessonTaster';
import StartFree from '../components/StartFree';
import { getPublicPricing, type PublicPricing } from '../lib/billing';

// The page that has to convince a tutor in about fifteen seconds.
//
// THE POSITION, which took two attempts to get right. The first version sold a
// better whiteboard against Zoom. That is not the idea: a whiteboard is a
// surface you write on, and there are dozens.
//
// The idea is that the tutor stops being a scribe and becomes a PRESENTER.
// The board does not hold ink, it RUNS things — simulations, animations,
// interactives — and the student does not watch them, they reach in and move
// them. That is a change of what teaching is, not a change of stationery, and
// it is what the mirror engine exists for.
//
// So the page argues the philosophy first and the features after, and the hero
// demo is a running interactive rather than a picture of handwriting.
//
// What it does NOT claim: that the product writes the interactives for you.
// Generation exists in the codebase and is switched off (no key). The board
// running what you give it is true today; anything more would be a promise the
// first trial would catch.
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
        <section className="ml-land-hero">
          <div className="ml-land-say">
            <span className="ml-land-eyebrow">A whiteboard that runs</span>
            <h1 className="ml-land-h1">Stop writing maths.<br />Start presenting it.</h1>
            <p className="ml-land-lede">
              A board that does not hold ink — it runs things. Drop in a simulation, an
              animation, an interactive you built this morning, and it plays live in the
              lesson. Your student does not watch it. They reach in and move it themselves.
            </p>
            <StartFree label="Start teaching free" />
            <p className="ml-land-price">
              Then <strong>₹{price} a month</strong> — about twenty minutes of one
              lesson's fee.
            </p>
          </div>

          <div className="ml-land-show">
            <ConvenientOrderDemo />
            <p className="ml-land-caption">
              That is not a picture of a lesson — it is one, running. Your student gets
              the same thing on their own iPad, and can move it while you talk.
            </p>
          </div>
        </section>

        <section className="ml-land-sec">
          <h2 className="ml-land-h2">What your student actually gets</h2>
          <p className="ml-land-sub">
            Not a video of your screen — the live thing itself, on their own device,
            which they can work on too.
          </p>
          <BothSides />
        </section>

        {/* The lessons themselves, running. A visitor should not have to sign
            up to find out what the product is. */}
        <section className="ml-land-sec">
          <h2 className="ml-land-h2">Six of these come with it</h2>
          <p className="ml-land-sub">
            Not screenshots — the lessons themselves, running here. Pick one and use it
            the way your student would.
          </p>
          <LessonTaster />
        </section>

        {/* The order a tutor meets these in: make it, present it, they use it. */}
        <section className="ml-land-three">
          <div className="ml-land-item">
            <span className="ml-land-num">01</span>
            <h3>Bring anything that runs</h3>
            <p>
              If it is a web page, it works: a geometry sketch, a graph that redraws as you
              drag it, a probability machine. Paste it in and it is on the board — no
              conversion, no plugin, no upload queue.
            </p>
          </div>
          <div className="ml-land-item">
            <span className="ml-land-num">02</span>
            <h3>Present it, do not narrate it</h3>
            <p>
              Step through it, pause it, hand control to the student and take it back.
              You are running a demonstration, not describing one — which is the difference
              between a child watching and a child understanding.
            </p>
          </div>
          <div className="ml-land-item">
            <span className="ml-land-num">03</span>
            <h3>Every lesson is kept</h3>
            <p>
              Each board, topic and minute taught, saved per student. Open a child's page
              before the next lesson and you know exactly where you stopped.
            </p>
          </div>
        </section>

        {/* The doubts that actually stop a purchase. */}
        <section className="ml-land-sec">
          <h2 className="ml-land-h2">The bits people ask about</h2>
          <div className="ml-faq">
            <div className="ml-faq-q">
              <h3>Does my student need an account, or an app?</h3>
              <p>
                Neither. You send them a link — the same link every week — and they tap it.
                No sign-up, no password, no download. It opens in the browser they already have.
              </p>
            </div>
            <div className="ml-faq-q">
              <h3>Where do the simulations come from?</h3>
              <p>
                You bring them. Anything that runs in a browser works, including the ones
                people now build in a minute by asking an AI for them. MathsLive is what
                puts one in front of a child and lets them touch it.
              </p>
            </div>
            <div className="ml-faq-q">
              <h3>Will it work on an old iPad and ordinary home internet?</h3>
              <p>
                That is what it was built for. The board is sent as drawing instructions
                rather than video, so it stays sharp and keeps up on connections that make
                a video call stutter.
              </p>
            </div>
            <div className="ml-faq-q">
              <h3>What happens to my work if I stop paying?</h3>
              <p>
                Nothing is deleted. Your students, their links and every saved board stay
                exactly as they are — you simply cannot start a new lesson until you renew.
                There are three days of grace either way, so a class in your diary is never
                cancelled at the door.
              </p>
            </div>
          </div>
        </section>

        {/* Named honestly. The rival is not another platform. */}
        <section className="ml-land-sec">
          <h2 className="ml-land-h2">What teaching looks like without it</h2>
          <p className="ml-land-sub">
            Not another tutoring platform. The way the lesson actually runs today.
          </p>
          <div className="ml-land-vs">
            <div className="ml-land-col">
              <span className="ml-land-tag">A call, and you writing</span>
              <p>You describe the moving thing. They picture it, or they do not.</p>
              <p>They watch you write. They cannot touch anything.</p>
              <p>Nothing is kept. Last week's working is gone.</p>
              <p>The parent sees a video call and wonders what they are paying for.</p>
            </div>
            <div className="ml-land-col is-us">
              <span className="ml-land-tag">MathsLive</span>
              <p>The moving thing is on the board, moving.</p>
              <p>They take hold of it from their own screen.</p>
              <p>Every board and topic saved, per student.</p>
              <p>₹{price} a month, paid by UPI, cancel by not paying.</p>
            </div>
          </div>
        </section>

        <section className="ml-land-close">
          <h2>Present your next lesson.</h2>
          <p>
            {trialDays} days free, no card. If you stop paying, nothing is deleted —
            your students, your boards and your links stay exactly where they are.
          </p>
          <StartFree label="Start free" tone="light" />
          <span className="ml-land-by">
            Built and run by a maths tutor in India, who teaches on it every day.
            139 students set up since May. Payments by UPI, to a person.
          </span>
        </section>
      </main>
    </div>
  );
}
