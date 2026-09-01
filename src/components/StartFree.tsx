import { useState, type FormEvent } from 'react';
import { apiFetch } from '../lib/passcode';

// Start the trial from the landing page, with an email and nothing else.
//
// The button used to send a visitor into the app, where they met a room-code
// box and had to work out that the sign-in link was somewhere else. Every step
// between deciding and starting is a place to stop deciding.
//
// So the page asks for the one thing it needs. The same magic-link endpoint the
// app uses sends a sign-in link; clicking it creates the account and starts the
// seven days. There is no password to choose, which is also why there is no
// second field.
export default function StartFree({ label = 'Start free', tone = 'dark' }: { label?: string; tone?: 'dark' | 'light' }) {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const value = email.trim();
    // Checked here only to save a round trip; the server decides.
    if (!/^\S+@\S+\.\S+$/.test(value)) {
      setState('error');
      setError('That does not look like an email address.');
      return;
    }
    setState('sending');
    setError(null);
    try {
      const res = await apiFetch('/api/auth/magic-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: value }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || 'Could not send the link. Try again in a moment.');
      }
      setState('sent');
    } catch (err) {
      setState('error');
      setError(err instanceof Error ? err.message : 'Could not send the link.');
    }
  };

  if (state === 'sent') {
    return (
      <div className={`ml-start is-sent tone-${tone}`} role="status">
        <strong>Check your email.</strong>
        <span>
          We have sent a link to <b>{email.trim()}</b>. Click it and you are in — no
          password to choose.
        </span>
      </div>
    );
  }

  return (
    <form className={`ml-start tone-${tone}`} onSubmit={submit} noValidate>
      <div className="ml-start-row">
        <input
          className="ml-start-input"
          type="email"
          inputMode="email"
          autoComplete="email"
          placeholder="you@example.com"
          aria-label="Your email"
          value={email}
          onChange={(e) => { setEmail(e.target.value); if (state === 'error') setState('idle'); }}
        />
        <button className="ml-start-go" type="submit" disabled={state === 'sending'}>
          {state === 'sending' ? 'Sending…' : label}
        </button>
      </div>
      <span className="ml-start-note">
        {error ?? 'Seven days free. No card, no password — we send you a link.'}
      </span>
    </form>
  );
}
