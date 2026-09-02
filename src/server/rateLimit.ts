// How often one address may ask.
//
// Until this file there was no HTTP rate limiting anywhere (PLAN.md Step 1.4,
// finding S3). The socket path has had per-event limits for months, but every
// HTTP route was open: `POST /api/auth/magic-link` would send an unlimited
// number of emails to any address anyone typed — somebody else's inbox, our
// Resend quota, our sending reputation — and `POST /api/publish` would create
// an unlimited number of rooms in a database on a 1 GB box.
//
// WHAT THIS IS, precisely: a fixed window counter per key, in this process's
// memory. Not a token bucket, not Redis, not a library. One process serves
// this app (PLAN.md Step 7.1), so a Map is the whole of it; if a second box is
// ever added, each gets its own window and the effective limit doubles — say
// so then rather than pretend otherwise now.
//
// THREE RULES IT MUST NOT BREAK:
//
//   1. It fails OPEN. Every limiter in this file answers "allowed" if anything
//      goes wrong internally. A bug in a rate limiter must never be the reason
//      a tutor cannot sign in before a lesson.
//   2. It is bounded. One entry per key on a machine where the heap ceiling is
//      the thing that has killed the service twice. Past `maxKeys` the window
//      is emptied rather than allowed to grow — an attacker gets a free pass
//      for one window, which is strictly better than an out-of-memory kill.
//   3. It never distinguishes a known address from an unknown one. The refusal
//      is identical either way, so this cannot be used to enumerate teachers.

/** What one window knows about one key. */
interface Hit { count: number; resetAt: number }

export interface Decision {
  allowed: boolean;
  /** Requests left in this window. Zero once refused. */
  remaining: number;
  /** Milliseconds until the window resets. Zero when allowed. */
  retryAfterMs: number;
}

export interface LimiterOptions {
  /** For the log line only. */
  name: string;
  windowMs: number;
  max: number;
  /** Distinct keys held before the window is dropped wholesale. */
  maxKeys?: number;
}

export interface Limiter {
  readonly name: string;
  check(key: string, now?: number): Decision;
  /** Drop expired entries. Called automatically; exported for tests. */
  sweep(now?: number): number;
  size(): number;
}

const ALLOW: Decision = { allowed: true, remaining: -1, retryAfterMs: 0 };

/**
 * A counter per key, reset every `windowMs`.
 *
 * Deliberately swept lazily rather than on a timer: a `setInterval` per limiter
 * is a handle that outlives tests and keeps a process alive at shutdown, and
 * there is no work to do when nobody is calling.
 */
export function makeLimiter(opts: LimiterOptions): Limiter {
  const { name, windowMs, max } = opts;
  const maxKeys = opts.maxKeys ?? 20_000;
  const hits = new Map<string, Hit>();

  function sweep(now = Date.now()): number {
    let dropped = 0;
    for (const [k, h] of hits) {
      if (now > h.resetAt) { hits.delete(k); dropped++; }
    }
    return dropped;
  }

  function check(key: string, now = Date.now()): Decision {
    try {
      if (!key) return ALLOW;                       // no key, no opinion
      if (!(max > 0) || !(windowMs > 0)) return ALLOW;

      if (hits.size >= maxKeys) {
        sweep(now);
        if (hits.size >= maxKeys) {
          // Rule 2. Losing the counts costs one window of protection; running
          // out of heap costs every lesson in progress.
          console.warn(`⚠️  rate limit "${name}": ${hits.size} keys held, window cleared`);
          hits.clear();
        }
      }

      const hit = hits.get(key);
      if (!hit || now > hit.resetAt) {
        hits.set(key, { count: 1, resetAt: now + windowMs });
        return { allowed: true, remaining: max - 1, retryAfterMs: 0 };
      }
      hit.count++;
      if (hit.count > max) {
        return { allowed: false, remaining: 0, retryAfterMs: Math.max(0, hit.resetAt - now) };
      }
      return { allowed: true, remaining: max - hit.count, retryAfterMs: 0 };
    } catch (err) {
      // Rule 1.
      console.error(`rate limit "${name}" failed open:`, (err as Error).message);
      return ALLOW;
    }
  }

  return { name, check, sweep, size: () => hits.size };
}

/**
 * The caller's address.
 *
 * Caddy sits in front in production and sets `X-Forwarded-For`; Express is told
 * to trust exactly one hop (`app.set('trust proxy', 1)` in server.ts), so
 * `req.ip` is the real client and a header the client sets itself is ignored.
 * The fallbacks are for local development, where there is no proxy at all.
 */
export function clientIp(req: { ip?: string; socket?: { remoteAddress?: string } }): string {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

/** The same question for a Socket.IO handshake, which has no Express request. */
export function handshakeIp(handshake: {
  address?: string;
  headers?: Record<string, unknown>;
}): string {
  const fwd = handshake?.headers?.['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) {
    // Left-most is the original client; Caddy appends, so the first entry is
    // whatever the client claimed. Good enough to spread real users across
    // keys, and a flood from one machine still shares its socket address —
    // which is why the ceiling below is set where a flood is obvious and a
    // reconnect storm is not.
    const first = fwd.split(',')[0]?.trim();
    if (first) return first;
  }
  return handshake?.address || 'unknown';
}

export interface MiddlewareOptions extends LimiterOptions {
  /** What to count by. Defaults to the caller's address. */
  key?: (req: any) => string | null | undefined;
  /** Status for a refusal. */
  status?: number;
  /** Body for a refusal. */
  body?: (retryAfterSeconds: number) => Record<string, unknown>;
  /** Called on every refusal, before the response. */
  onLimit?: (req: any, key: string) => void;
}

/**
 * Express middleware form.
 *
 * The refusal is a plain 429 with a `Retry-After`. A 429 says nothing about
 * whether an account exists — the answer is identical for a known and an
 * unknown address — so it satisfies rule 3 while telling a real teacher who
 * double-clicked something true instead of "check your email" for a message
 * that was never sent.
 */
export function rateLimit(opts: MiddlewareOptions) {
  const limiter = makeLimiter(opts);
  const status = opts.status ?? 429;
  const keyOf = opts.key ?? ((req: any) => clientIp(req));
  const bodyOf = opts.body ?? ((s: number) => ({
    error: 'Too many requests. Try again in a moment.',
    code: 'rate_limited',
    retryAfterSeconds: s,
  }));

  const middleware = (req: any, res: any, next: any) => {
    let key: string | null | undefined;
    try { key = keyOf(req); } catch { key = null; }
    if (!key) return next();

    const decision = limiter.check(`${key}`);
    if (decision.allowed) return next();

    const seconds = Math.ceil(decision.retryAfterMs / 1000);
    try { opts.onLimit?.(req, `${key}`); } catch { /* never block on a log */ }
    console.warn(`⏱️  rate limit "${opts.name}" refused ${key} (retry in ${seconds}s)`);
    res.setHeader('Retry-After', String(seconds));
    return res.status(status).json(bodyOf(seconds));
  };

  // Handed back on the function so tests and the health page can read it.
  (middleware as any).limiter = limiter;
  return middleware as ((req: any, res: any, next: any) => void) & { limiter: Limiter };
}
