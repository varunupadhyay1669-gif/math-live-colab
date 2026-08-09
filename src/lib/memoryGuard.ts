// Shedding load instead of being killed.
//
// Render suspended this service after repeated "exceeded its memory limit"
// restarts. Eviction on a ten-minute sweep helps, but a ten-minute sweep does
// nothing about the two minutes in which a couple of big lessons push the heap
// over the edge — the process dies, every live room dies with it, and the
// restart is the outage the tutor sees.
//
// So the heap is watched, and when it climbs the idle-room window collapses:
// rooms that would normally sit warm for half an hour are written out and
// dropped immediately. Shedding an idle room costs a lazy restore later.
// Being OOM-killed costs the lesson.
//
// Pure so the thresholds can be tested; the server supplies the numbers.

export type MemoryPressure = 'ok' | 'high' | 'critical';

export interface MemoryPolicy {
  /** What the instance can actually hold, in bytes. */
  budgetBytes: number;
  /** Normal idle-eviction window. */
  idleMs: number;
}

/**
 * How close to the ceiling are we?
 *
 * 'high' at 70% and 'critical' at 85% — deliberately well short of the limit,
 * because by the time a Node heap is at 95% the collector is already thrashing
 * and shedding load is too late to prevent the kill.
 */
export function pressureFrom(heapUsed: number, policy: MemoryPolicy): MemoryPressure {
  if (!Number.isFinite(heapUsed) || heapUsed <= 0 || policy.budgetBytes <= 0) return 'ok';
  const used = heapUsed / policy.budgetBytes;
  if (used >= 0.85) return 'critical';
  if (used >= 0.70) return 'high';
  return 'ok';
}

/**
 * How long an empty room may stay in memory, given the pressure.
 *
 * Under pressure the window collapses; at critical it goes to zero, so every
 * unoccupied room is shed on the next pass. It NEVER returns something that
 * would evict an occupied room — occupancy is checked separately and is not
 * negotiable at any pressure. Losing the room someone is teaching in to save
 * memory would be solving the problem by causing it.
 */
export function idleWindowFor(pressure: MemoryPressure, policy: MemoryPolicy): number {
  if (pressure === 'critical') return 0;
  if (pressure === 'high') return Math.min(policy.idleMs, 60_000);
  return policy.idleMs;
}

/** For the log line — a number a person can act on. */
export function describeMemory(heapUsed: number, policy: MemoryPolicy): string {
  const mb = (n: number) => Math.round(n / 1048576);
  const pct = policy.budgetBytes > 0 ? Math.round((heapUsed / policy.budgetBytes) * 100) : 0;
  return `${mb(heapUsed)}MB of ${mb(policy.budgetBytes)}MB (${pct}%)`;
}
