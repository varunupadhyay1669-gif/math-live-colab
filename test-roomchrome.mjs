// Room chrome — at most one status row above the board, ever.
// node --import tsx test-roomchrome.mjs
import { stripMode } from './src/lib/roomChrome.ts';

let pass = 0, fail = 0; const fails = [];
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, d) => { fail++; fails.push(n + (d ? ' — ' + d : '')); console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); };
const assert = (c, n, d) => c ? ok(n) : bad(n, d);

const base = { expiresAt: null, claimed: false, claimedBy: null, canSaveHistory: false, slim: false };
const at = (o) => stripMode({ ...base, ...o });

console.log('R1: the case that cost two rows');
// A signed-in tutor with an unsaved board. Both prompts applied, both rendered,
// and the board started 26px lower for the whole lesson.
assert(at({ expiresAt: Date.now() + 3600_000, canSaveHistory: true }) === 'both',
  'both prompts collapse into ONE row', at({ expiresAt: 1, canSaveHistory: true }));

console.log('R2: each prompt alone still shows');
assert(at({ expiresAt: Date.now() + 3600_000 }) === 'expiry', 'an anonymous board gets its countdown');
assert(at({ canSaveHistory: true }) === 'history', 'a signed-in tutor gets the file-it prompt');
assert(at({}) === 'none', 'and a claimed, signed-out room shows nothing at all');

console.log('R3: a saved board stops nagging');
assert(at({ expiresAt: Date.now() + 3600_000, claimed: true, claimedBy: 'Varun' }) === 'saved',
  'once saved the countdown is replaced by a confirmation, not shown alongside it');
assert(at({ claimed: true, claimedBy: 'Varun', slim: true }) === 'none',
  'and on the whiteboard even that goes — it confirms something already done');
assert(at({ claimed: true, claimedBy: null }) === 'none', 'no claimer, no confirmation');
assert(at({ claimed: true, claimedBy: 'Varun', canSaveHistory: true }) === 'history',
  'a saved board still offers the thing that IS still actionable');

console.log('R4: it can never return two things');
// The property the old code lacked. Every combination of the inputs must
// resolve to exactly one mode.
const bools = [false, true];
let combos = 0;
for (const exp of [null, Date.now() + 1000])
  for (const claimed of bools)
    for (const by of [null, 'Varun'])
      for (const hist of bools)
        for (const slim of bools) {
          const m = stripMode({ expiresAt: exp, claimed, claimedBy: by, canSaveHistory: hist, slim });
          combos++;
          if (!['none', 'expiry', 'history', 'both', 'saved'].includes(m)) {
            bad('every combination yields one known mode', JSON.stringify({ exp, claimed, by, hist, slim, m }));
            combos = -1; break;
          }
        }
assert(combos === 32, 'all 32 input combinations resolve to exactly one mode', String(combos));

console.log('R5: an expiry that has not been set is not a countdown');
assert(at({ expiresAt: 0 }) === 'none', 'expiresAt of 0 is "unknown", not "expires at the epoch"');

console.log(`\nROOM CHROME RESULT: ${pass} passed, ${fail} failed`);
if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
process.exit(fail === 0 ? 0 : 1);
