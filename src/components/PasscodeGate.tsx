import { useEffect, useState, type ReactNode, type FormEvent } from 'react';
import { passcodeIsRequired, storedPasscode, rememberPasscode, forgetPasscode } from '../lib/passcode';

// The passcode prompt.
//
// Shown to everyone, tutor and student alike, before the app is usable. It is
// NOT the security boundary — the server refuses the socket handshake without
// the code, and no amount of editing this page changes that. This is the door
// people are meant to walk through.

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

  // A refused handshake anywhere in the app means the stored code is wrong or
  // stale — drop it and ask again, rather than leaving someone staring at a
  // room that silently never connects.
  useEffect(() => {
    const onRefused = () => {
      forgetPasscode();
      setEntered('');
      setError('That code was not accepted. Try again.');
      setRequired(true);
    };
    window.addEventListener('mathslive:passcode-refused', onRefused);
    return () => window.removeEventListener('mathslive:passcode-refused', onRefused);
  }, []);

  // Still asking the server, or no gate on this deployment.
  if (required === null || required === false) return <>{children}</>;
  if (entered) return <>{children}</>;

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
