import { useEffect, useState, type ReactNode, type FormEvent } from 'react';
import {
  passcodeIsRequired, storedPasscode, rememberPasscode, forgetPasscode,
  PASSCODE_REFUSED, type PasscodeRefusedDetail,
} from '../lib/passcode';

// The passcode prompt.
//
// Shown to everyone, tutor and student alike, before the app is usable. It is
// NOT the security boundary — the server refuses the socket handshake without
// the code, and no amount of editing this page changes that. This is the door
// people are meant to walk through.

/**
 * Pages a stranger is allowed to read without the code.
 *
 * Deliberately a short, exact list rather than a prefix match. The gate exists
 * so a passer-by cannot wander into a lesson; a price list is the one thing
 * they are supposed to be able to read before deciding to ask for a code at
 * all. Nothing here reads a room, a class, or a teacher — it is a page of
 * prices and promises.
 */
const PUBLIC_PATHS = new Set(['/pricing']);

interface Props {
  children: ReactNode;
}

export default function PasscodeGate({ children }: Props) {
  const [required, setRequired] = useState<boolean | null>(null);
  const [code, setCode] = useState('');
  const [entered, setEntered] = useState(storedPasscode());
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void passcodeIsRequired().then(r => { if (!cancelled) setRequired(r); });
    return () => { cancelled = true; };
  }, []);

  // A refusal anywhere in the app — the socket handshake, or one of the gated
  // HTTP endpoints — means we need a code we do not have. Ask for it, rather
  // than leaving someone staring at a room that silently never connects or a
  // button that answers with an error code.
  useEffect(() => {
    const onRefused = (e: Event) => {
      // Two different situations wear the same 401, and telling someone their
      // code was rejected when they were never asked for one sends them looking
      // for a mistake they did not make.
      const hadCode = (e as CustomEvent<PasscodeRefusedDetail>).detail?.hadCode ?? true;
      forgetPasscode();
      setEntered('');
      setError(hadCode
        ? 'That code was not accepted. Try again.'
        : 'This site needs an access code before it can do that.');
      setRequired(true);
    };
    window.addEventListener(PASSCODE_REFUSED, onRefused);
    return () => window.removeEventListener(PASSCODE_REFUSED, onRefused);
  }, []);

  // Still asking the server, or no gate on this deployment.
  if (required === null || required === false) return <>{children}</>;
  if (entered) return <>{children}</>;
  // A price list nobody can read is not a price list. Checked against the
  // live path so it also holds if someone lands here directly from a search
  // result or an advert.
  if (PUBLIC_PATHS.has(window.location.pathname.replace(/\/+$/, '') || '/')) {
    return <>{children}</>;
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const value = code.trim();
    if (!value) return;
    setChecking(true);
    setError(null);
    // Verified by USING it: the socket handshake is the only authority, so the
    // code is stored and the app proceeds. A wrong one is refused on connect
    // and the listener above brings this screen straight back.
    rememberPasscode(value);
    setEntered(value);
    setChecking(false);
  };

  return (
    <div className="ml-gate">
      <form className="ml-gate-card" onSubmit={submit}>
        <div className="ml-gate-mark">Maths<span>Live</span></div>
        <h1 className="ml-gate-title">Enter the access code</h1>
        <p className="ml-gate-text">
          This class platform is private. Ask your teacher for the code if you do not have it.
        </p>
        <input
          className="ml-gate-input"
          value={code}
          onChange={(e) => { setCode(e.target.value); setError(null); }}
          // Numeric on a phone or iPad keypad, which is what a student is on.
          inputMode="numeric"
          autoComplete="one-time-code"
          // type=password so it is not readable over a shoulder or on a shared
          // screen — a tutor sharing their screen would otherwise show it to
          // the whole class.
          type="password"
          placeholder="Access code"
          aria-label="Access code"
          autoFocus
        />
        {error && <p className="ml-gate-error">{error}</p>}
        <button className="ml-gate-btn" type="submit" disabled={checking || !code.trim()}>
          {checking ? 'Checking…' : 'Continue'}
        </button>
      </form>
    </div>
  );
}
