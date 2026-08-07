// How a tutor's activity is described on the admin page.
//
// Pure and dependency-free on purpose: getting these wrong means calling
// someone dormant while they teach daily, which is worth testing without
// standing up a database client.

export type ActivityStatus = 'active this week' | 'active this month' | 'dormant' | 'never signed in';

/** How to describe a tutor at a glance. */
export function activityStatus(lastSignedIn: string | null, now = Date.now()): ActivityStatus {
  if (!lastSignedIn) return 'never signed in';
  const age = now - new Date(lastSignedIn).getTime();
  if (!Number.isFinite(age)) return 'never signed in';
  if (age <= 7 * 864e5) return 'active this week';
  if (age <= 30 * 864e5) return 'active this month';
  return 'dormant';
}

/** "3 days ago", "today", "—". */
export function agoLabel(iso: string | null, now = Date.now()): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '—';
  const days = Math.floor((now - t) / 864e5);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.round(days / 30);
  return months === 1 ? 'a month ago' : `${months} months ago`;
}
