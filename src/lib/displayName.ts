/**
 * Human display names — never show a raw email to the class.
 *
 * When auth is on, the only identity a magic-link teacher has is their email,
 * and that used to flow verbatim into the room name → cursor labels, the
 * participants list, chat, "X is driving" banners. Students were literally
 * watching "varunupadhyay.1669@gmail.com" glide around the lesson.
 *
 * cleanDisplayName("varunupadhyay.1669@gmail.com") → "Varunupadhyay"
 * cleanDisplayName("ms.priya-shah@school.org")     → "Ms Priya Shah"
 * cleanDisplayName("Mr Sharma")                    → "Mr Sharma" (untouched)
 */
export function cleanDisplayName(raw: string | null | undefined): string {
  const s = (raw || '').trim();
  if (!s) return '';
  if (!s.includes('@')) return s;
  const local = s.split('@')[0];
  const words = local
    .split(/[._\-+]+/)
    .filter(w => w && !/^\d+$/.test(w)) // drop pure-number chunks ("1669")
    .map(w => w.charAt(0).toUpperCase() + w.slice(1));
  return words.join(' ') || local;
}
