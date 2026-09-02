// Every email this server sends, in one place.
//
// It was two places by yesterday — the sign-in link in identity.ts and the
// payment alert in billing.ts — each with its own copy of the Resend call, its
// own error handling, and its own idea of who the owner is. A third copy was
// about to appear for receipts. So: one sender, one place to look when mail
// stops arriving, one place to swap providers.
//
// Nothing here throws. A failed email must never take down the thing that
// triggered it: a receipt that cannot be sent is a bad day, a crash while
// confirming a payment is a lost payment.
export interface MailResult { ok: boolean; reason?: string }

/** Who the owner is, as configured. Comma-separated because he has two. */
export function ownerAddresses(): string[] {
  return (process.env.OWNER_EMAIL || '')
    .split(',').map(s => s.trim()).filter(Boolean);
}

export function mailFrom(): string {
  return process.env.AUTH_EMAIL_FROM || 'MathsLive <login@matheinstein.com>';
}

/**
 * Send one email. Returns why it failed rather than throwing, so callers can
 * decide whether that matters — for most of them it does not.
 */
export async function sendMail(to: string[], subject: string, text: string): Promise<MailResult> {
  const key = process.env.RESEND_API_KEY;
  const recipients = to.filter(Boolean);
  if (!key) return { ok: false, reason: 'RESEND_API_KEY is not set' };
  if (recipients.length === 0) return { ok: false, reason: 'no recipient' };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: mailFrom(), to: recipients, subject, text }),
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      console.error(`Resend refused "${subject}":`, res.status, body);
      return { ok: false, reason: `${res.status} ${body}` };
    }
    return { ok: true };
  } catch (err) {
    console.error(`Could not send "${subject}":`, (err as Error).message);
    return { ok: false, reason: (err as Error).message };
  }
}

// ── Telegram, for the things that cannot wait for an inbox ────────────────
//
// Email is the record; this is the interruption. It exists because the two
// alerts that matter most — "a teacher says they paid" and "the site is down"
// — are worth nothing an hour late, and because WhatsApp's Cloud API only
// permits a free-form message within 24 hours of the recipient writing to the
// business number, so it goes quiet exactly when it has not been used lately.
// A bot has no such window, costs nothing, and needs no business account.
//
// Unset variables mean "not configured", not "broken": every caller sends the
// email as well and none of them depend on the answer.
export function telegramConfigured(): boolean {
  return !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

export async function sendTelegram(text: string): Promise<MailResult> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return { ok: false, reason: 'TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are not set' };
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // No parse_mode: a teacher's note or an error message containing an
      // underscore or an asterisk would be a malformed-entity error from
      // Telegram, and an alert that fails to send because of punctuation is
      // worse than an unformatted one. 4096 is Telegram's hard limit.
      body: JSON.stringify({ chat_id: chat, text: text.slice(0, 4000), disable_web_page_preview: true }),
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      console.error('Telegram refused a message:', res.status, body);
      return { ok: false, reason: `${res.status} ${body}` };
    }
    return { ok: true };
  } catch (err) {
    console.error('Could not send a Telegram message:', (err as Error).message);
    return { ok: false, reason: (err as Error).message };
  }
}

/** The public address of this install, for links inside emails. */
export function siteUrl(): string {
  return (process.env.PUBLIC_URL || 'https://mathslive.matheinstein.com').replace(/\/+$/, '');
}

/**
 * Today's date in India, as YYYY-MM-DD.
 *
 * Every teacher here is in India and the server's clock is UTC, so "did we
 * already send today's mail?" has to be asked in IST or the answer flips at
 * half past five in the morning. IST is UTC+5:30 with no daylight saving,
 * which is the entire reason this can be four lines instead of a library.
 */
export function istDay(now = new Date()): string {
  return new Date(now.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);
}

/** The hour of day in India, 0–23. */
export function istHour(now = new Date()): number {
  return new Date(now.getTime() + 5.5 * 3600_000).getUTCHours();
}

/** "7 September" — how a date should read in a sentence, not an ISO string. */
export function niceDate(d: string | Date | null | undefined): string {
  if (!d) return 'unknown';
  const date = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return 'unknown';
  return new Date(date.getTime() + 5.5 * 3600_000)
    .toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' });
}
