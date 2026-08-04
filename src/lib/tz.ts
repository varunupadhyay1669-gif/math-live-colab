// The reader's clock problem.
//
// A class pack is full of times: "board at 27:47", a transcript line at
// 10:42, homework due Friday. Elapsed times are self-contained, but the wall
// clock ones are not — 10:42 in whose day? The tutor and the student are
// often in different countries, and a model reading the pack later has no way
// to place either of them.
//
// So each participant reports their own zone at join. It is one IANA name per
// person, sent once, kept in the room and written into the pack. Nothing is
// inferred from an IP and nothing leaves the tutor's download.

// Same shape the server re-validates against — it must not trust this, and
// this must not send something the server will silently drop.
const IANA = /^(UTC|[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){1,2})$/;

export function isTimezone(tz: unknown): tz is string {
  return typeof tz === 'string' && tz.length <= 64 && IANA.test(tz);
}

/**
 * This browser's zone, or undefined if it won't say.
 *
 * Intl is everywhere we support, but resolvedOptions().timeZone can still come
 * back empty on a locked-down device, and the whole call can throw. An absent
 * zone is a null field in the pack, which is the honest answer.
 */
export function localTimezone(): string | undefined {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isTimezone(tz) ? tz : undefined;
  } catch {
    return undefined;
  }
}
