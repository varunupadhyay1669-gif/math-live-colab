import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import {
  getBillingStatus, claimPayment, describe, type BillingStatus,
} from "../lib/billing";

// Subscribe / renew. One screen, one job: show the QR, take the reference
// number, and be honest that a human confirms it.
//
// The honesty matters more than it looks. A teacher who pays and then sees
// nothing happen assumes the payment failed and pays again. So the page says
// plainly that confirmation is manual, shows the claim sitting in the queue
// once it is made, and never pretends to be instant.
export default function Billing() {
  const navigate = useNavigate();
  const auth = useAuth();

  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reference, setReference] = useState("");
  const [months, setMonths] = useState(1);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [qrBroken, setQrBroken] = useState(false);

  useEffect(() => {
    if (auth.loading) return;
    if (!auth.enabled || !auth.user) navigate("/", { replace: true });
  }, [auth.enabled, auth.user, auth.loading, navigate]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setStatus(await getBillingStatus());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load your subscription.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const submit = async () => {
    if (!reference.trim()) {
      setError("Please enter the UPI reference number from your payment.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await claimPayment(reference.trim(), months, note.trim() || undefined);
      setSent(true);
      setReference("");
      setNote("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not record your payment.");
    } finally {
      setBusy(false);
    }
  };

  const amount = (status?.priceRupees ?? 500) * months;
  const pending = status?.pendingClaim ?? null;

  return (
    <div className="ml-dark-home">
      <div className="ml-dark-stage">
        <header className="ml-dark-topbar">
          <div className="ml-dark-brand">
            <span className="ml-dark-wordmark">Maths<span className="accent">Live</span></span>
          </div>
          <button className="ml-dark-btn ml-dark-btn-ghost" onClick={() => navigate("/dashboard")}>
            Back to classes
          </button>
        </header>

        <div className="ml-dark-center ml-page-top">
          <h1 className="ml-dark-headline">Subscription</h1>

          {loading ? (
            <p style={{ opacity: 0.7 }}>Loading…</p>
          ) : (
            <div className="ml-bill-wrap">
              {/* Where you stand */}
              {status && (
                <div className={`ml-bill-state ml-bill-state-${status.state}`}>
                  <strong>{describe(status)}</strong>
                  {status.state === "expired" && (
                    <span>Pay below to carry on teaching. Your students and classes are all still here.</span>
                  )}
                  {status.state === "grace" && (
                    <span>
                      You can still teach while you renew — no lesson will be cut off in the
                      meantime. Pay below and it is sorted.
                    </span>
                  )}
                  {status.state === "trial" && (
                    <span>Everything works during the trial. Pay any time — days you have left are added on, not lost.</span>
                  )}
                </div>
              )}

              {/* A payment already waiting on confirmation */}
              {pending && (
                <div className="ml-bill-pending">
                  <strong>Payment received — waiting for confirmation</strong>
                  <span>
                    ₹{pending.amount_rupees} · reference {pending.reference} · sent{" "}
                    {new Date(pending.claimed_at).toLocaleString()}
                  </span>
                  <span className="ml-bill-muted">
                    We have been notified. This is checked by hand, so it may take a few hours.
                    You do not need to pay again.
                  </span>
                </div>
              )}

              {!pending && (
                <>
                  <div className="ml-bill-cols">
                    {/* Pay */}
                    <div className="ml-bill-card">
                      <h2 className="ml-bill-h2">1 · Pay ₹{amount}</h2>
                      <p className="ml-bill-muted">
                        Scan with any UPI app — Paytm, PhonePe, Google Pay, or your bank's app.
                      </p>

                      {qrBroken ? (
                        <div className="ml-bill-qr ml-bill-qr-missing">
                          <span>No payment QR has been installed yet.</span>
                        </div>
                      ) : (
                        <img
                          className="ml-bill-qr"
                          src={`/api/billing/qr?months=${months}`}
                          alt="Scan this QR code with a UPI app to pay"
                          onError={() => setQrBroken(true)}
                          key={months}
                        />
                      )}

                      {status?.upiId && (
                        <p className="ml-bill-upi">
                          or send to <code>{status.upiId}</code>
                          {status.payeeName ? ` (${status.payeeName})` : ""}
                        </p>
                      )}

                      <label className="ml-bill-label">
                        Paying for
                        <select
                          className="ml-dark-input"
                          value={months}
                          onChange={(e) => setMonths(Number(e.target.value))}
                        >
                          {[1, 3, 6, 12].map((m) => (
                            <option key={m} value={m}>
                              {m} month{m === 1 ? "" : "s"} — ₹{(status?.priceRupees ?? 500) * m}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>

                    {/* Tell us */}
                    <div className="ml-bill-card">
                      <h2 className="ml-bill-h2">2 · Tell us you paid</h2>
                      <p className="ml-bill-muted">
                        After paying, your UPI app shows a reference or transaction number.
                        Enter it here so the payment can be matched to your account.
                      </p>

                      <label className="ml-bill-label">
                        UPI reference number
                        <input
                          className="ml-dark-input"
                          placeholder="e.g. 418293746512"
                          value={reference}
                          onChange={(e) => setReference(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter" && !busy) void submit(); }}
                        />
                      </label>

                      <label className="ml-bill-label">
                        Anything we should know (optional)
                        <input
                          className="ml-dark-input"
                          placeholder="Paid from a different number, etc."
                          value={note}
                          onChange={(e) => setNote(e.target.value)}
                        />
                      </label>

                      <button
                        className="ml-dark-btn ml-dark-btn-primary"
                        disabled={busy || !reference.trim()}
                        onClick={() => void submit()}
                        style={{ width: "100%" }}
                      >
                        {busy ? "Sending…" : `I have paid ₹${amount}`}
                      </button>

                      <p className="ml-bill-muted" style={{ marginTop: 10 }}>
                        A person checks the payment and switches your account on — usually
                        the same day. You will not be charged automatically, ever.
                      </p>
                    </div>
                  </div>
                </>
              )}

              {sent && !pending && (
                <p className="ml-bill-ok">Thank you — we have been notified.</p>
              )}
              {error && <p className="ml-bill-err">{error}</p>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
