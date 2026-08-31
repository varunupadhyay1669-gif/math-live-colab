// "Today", "3 days ago", "Never" — the one thing that tells a tutor which
// student needs attention next.
//
// The dashboard is already sorted by recency, so this is what makes that
// ordering legible: without it, the top and bottom of the list look identical
// and the sort may as well be random.
export function lastTaught(iso: string | null | undefined): { text: string; stale: boolean } {
  if (!iso) return { text: "Not opened yet", stale: true };
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return { text: "Not opened yet", stale: true };

  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return { text: "Today", stale: false };
  if (days === 1) return { text: "Yesterday", stale: false };
  if (days < 7) return { text: `${days} days ago`, stale: false };
  if (days < 14) return { text: "Last week", stale: false };
  if (days < 60) return { text: `${Math.floor(days / 7)} weeks ago`, stale: days > 21 };
  return { text: `${Math.floor(days / 30)} months ago`, stale: true };
}
