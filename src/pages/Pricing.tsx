import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getPublicPricing, type PublicPricing } from "../lib/billing";

// What it costs, and what happens if you stop paying.
//
// A page that has to exist before this can be advertised, and the one page a
// stranger can read without the access code. Its job is not to sell — that is
// the landing page's job — but to remove every reason to hesitate:
//
//   * the price, with no asterisk
//   * that nothing is deleted if you stop
//   * that a person, not a machine, confirms the payment, and roughly when
//   * who is behind it
//
// Written plainly on purpose. At ₹500 paid by UPI to a person, trust is the
// product, and the fastest way to lose it is a terms page that reads like it
// is hiding something.
export default function Pricing() {
  const navigate = useNavigate();
  const [p, setP] = useState<PublicPricing | null>(null);

  useEffect(() => { getPublicPricing().then(setP).catch(() => setP(null)); }, []);

  const plans = p?.plans ?? [
    { months: 1, rupees: 500, perMonth: 500 },
    { months: 3, rupees: 1350, perMonth: 450 },
    { months: 6, rupees: 2550, perMonth: 425 },
    { months: 12, rupees: 4800, perMonth: 400 },
  ];
  const monthly = p?.priceRupees ?? 500;
  const trialDays = p?.trialDays ?? 7;
  const graceDays = p?.graceDays ?? 3;

  return (
    <div className="ml-dark-home">
      <div className="ml-dark-stage">
        <header className="ml-dark-topbar">
          <div className="ml-dark-brand">
            <span className="ml-dark-wordmark">Maths<span className="accent">Live</span></span>
          </div>
          <button className="ml-dark-btn ml-dark-btn-ghost" onClick={() => navigate("/")}>
            Start teaching
          </button>
        </header>

        <div className="ml-dark-center ml-page-top">
          <h1 className="ml-dark-headline">Pricing</h1>
          <p className="ml-price-lede">
            {trialDays} days free, then ₹{monthly} a month. No card, no auto-charge,
            nothing to cancel.
          </p>

          <div className="ml-price-wrap">
            {/* The plans */}
            <div className="ml-price-grid">
              {plans.map((pl) => {
                const saving = monthly * pl.months - pl.rupees;
                return (
                  <div key={pl.months} className={`ml-price-card${pl.months === 1 ? " is-default" : ""}`}>
                    {pl.months === 1 && <span className="ml-price-tag">Most people start here</span>}
                    <span className="ml-price-term">
                      {pl.months} month{pl.months === 1 ? "" : "s"}
                    </span>
                    <span className="ml-price-big">₹{pl.rupees.toLocaleString("en-IN")}</span>
                    <span className="ml-price-rate">₹{pl.perMonth}/month</span>
                    {saving > 0
                      ? <span className="ml-price-save">saves ₹{saving.toLocaleString("en-IN")}</span>
                      : <span className="ml-price-save ml-price-save-none">the standard rate</span>}
                  </div>
                );
              })}
            </div>
            <p className="ml-price-fine">
              The monthly price never changes. Paying for longer costs less per month —
              that is the only discount there is, and you never have to wait for a sale.
            </p>

            {/* What you get */}
            <section className="ml-price-block">
              <h2>What ₹{monthly} a month includes</h2>
              <ul>
                <li>Unlimited students, unlimited classes, unlimited hours. Nothing is metered.</li>
                <li>A permanent link per student — they tap it and they are in. No account, no app, no password, ever.</li>
                <li>The live board, interactive lessons your student sees exactly as you do, screen sharing and video.</li>
                <li>Every lesson saved: what was on the board, what you covered, how long you taught.</li>
                <li>Works on an iPad, a phone or a laptop, on ordinary home internet.</li>
              </ul>
            </section>

            {/* How paying works */}
            <section className="ml-price-block">
              <h2>How paying works</h2>
              <ul>
                <li>Scan a UPI QR with any app — Paytm, PhonePe, Google Pay, or your bank's.</li>
                <li>The amount is already in the code, so there is nothing to type wrong.</li>
                <li>Enter the reference number your app gives you. A person checks it and switches your account on, usually the same day.</li>
                <li><strong>Nothing is automatic.</strong> There is no card on file and no recurring charge. When the month ends, it ends — you decide whether to pay again.</li>
              </ul>
            </section>

            {/* The bit people actually worry about */}
            <section className="ml-price-block ml-price-block-quiet">
              <h2>If you stop paying</h2>
              <ul>
                <li><strong>Nothing is deleted.</strong> Your students, classes, room links and saved boards stay exactly as they are.</li>
                <li>You get {graceDays} days of grace after the date, so a class already in your diary is never cancelled at the door.</li>
                <li>After that you simply cannot start a new lesson until you renew. Everything is still waiting when you do.</li>
                <li>We email you 2 days before, and on the day. You will not be caught out.</li>
              </ul>
            </section>

            <section className="ml-price-block ml-price-block-quiet">
              <h2>Refunds</h2>
              <p>
                If something goes wrong at our end and you could not teach, tell us and we
                will refund the month. If you paid by mistake — twice, or for the wrong
                length — tell us and we will refund it. We would rather return ₹500 than
                keep money someone feels bad about.
              </p>
              <p>Prices are in Indian rupees and include any applicable taxes.</p>
            </section>

            <section className="ml-price-block">
              <h2>Who runs this</h2>
              <p>
                MathsLive is built and run by Varun Upadhyay, a maths tutor. It is the tool
                he uses to teach his own students, which is the only reason it works the way
                it does. Payments go to him directly, by UPI.
              </p>
              <p>
                Questions before you pay? Ask — a real person answers.
              </p>
            </section>

            <div className="ml-price-cta">
              <button className="ml-dark-btn ml-dark-btn-primary" onClick={() => navigate("/")}>
                Start teaching free for {trialDays} days
              </button>
              <span className="ml-price-fine">No card needed to start.</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
