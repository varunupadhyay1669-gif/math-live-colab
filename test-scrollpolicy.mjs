// Who may scroll, and whose scroll moves whom.
//
// Every case below is a behaviour the tutor reported in one lesson. The old
// rule was `scrollSyncEnabled && !canInteract`, which tied permission to the
// "Linked" toggle and broke all three.
// node --import tsx test-scrollpolicy.mjs
import {
  mayDrive, mayStudentScroll, scrollLocked,
  teacherScrollPushes, studentScrollPushes,
} from './src/lib/scrollPolicy.ts';

let pass = 0, fail = 0; const fails = [];
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, d) => { fail++; fails.push(n + (d ? ' — ' + d : '')); console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); };
const assert = (c, n, d) => c ? ok(n) : bad(n, d);

const ctx = (o = {}) => ({
  interactionAllowed: false, hasControl: false, scrollSyncEnabled: true, ...o,
});

console.log('R1: a view-only student cannot scroll — whatever Linked says');
// The reported fault: with Linked off, view-only students scrolled away
// mid-explanation, because the lock was `scrollSyncEnabled && !canInteract`.
assert(scrollLocked(ctx({ scrollSyncEnabled: true })), 'locked in a linked room');
assert(scrollLocked(ctx({ scrollSyncEnabled: false })),
  'STILL locked when the teacher unlinks scroll — the old rule unlocked here');
assert(!mayStudentScroll(ctx({ scrollSyncEnabled: false })), 'and may not scroll');

console.log('R2: granting interaction lets them scroll');
assert(!scrollLocked(ctx({ interactionAllowed: true })), 'room-wide interactive unlocks');
assert(!scrollLocked(ctx({ hasControl: true })), 'holding the control baton unlocks');
assert(!scrollLocked(ctx({ hasControl: true, scrollSyncEnabled: false })),
  'and neither depends on the Linked toggle');

console.log('R3: revoking interaction re-locks them');
// The tutor turned interaction back OFF and the student could still scroll.
const granted = ctx({ interactionAllowed: true });
const revoked = { ...granted, interactionAllowed: false };
assert(!scrollLocked(granted), 'unlocked while granted');
assert(scrollLocked(revoked), 'locked again the moment it is revoked');
assert(scrollLocked({ ...revoked, scrollSyncEnabled: false }),
  'still locked after revoking even with Linked off — the old rule did not re-lock');

console.log('R4: a driving student moves the TEACHER\'s view');
// "if he is doing scrolling up and down, I should also see the same scroll on
// my side" — and this must not depend on Linked, which is the other direction.
assert(studentScrollPushes(ctx({ interactionAllowed: true })), 'interactive student pushes to teacher');
assert(studentScrollPushes(ctx({ hasControl: true })), 'control holder pushes to teacher');
assert(studentScrollPushes(ctx({ interactionAllowed: true, scrollSyncEnabled: false })),
  'and still pushes when Linked is off — Linked is the teacher→student direction');
assert(!studentScrollPushes(ctx()), 'a view-only student pushes nothing');

console.log('R5: "Linked" governs the teacher→student direction only');
assert(teacherScrollPushes(ctx({ scrollSyncEnabled: true })), 'linked: teacher drags students along');
assert(!teacherScrollPushes(ctx({ scrollSyncEnabled: false })), 'unlinked: students keep their own position');
// The two directions are independent — that is the whole point of the split.
assert(teacherScrollPushes(ctx({ scrollSyncEnabled: true })) && !studentScrollPushes(ctx()),
  'teacher pushes down while a view-only student pushes nothing back');

console.log('R6: mayDrive is the single source of truth');
// Anything that unlocks scrolling must be the same thing that permits driving,
// or the two can drift apart again.
for (const c of [ctx(), ctx({ interactionAllowed: true }), ctx({ hasControl: true }),
                 ctx({ interactionAllowed: true, hasControl: true, scrollSyncEnabled: false })]) {
  assert(mayStudentScroll(c) === mayDrive(c),
    `scroll permission tracks drive permission: ${JSON.stringify(c)}`);
}

console.log(`\nSCROLL POLICY RESULT: ${pass} passed, ${fail} failed`);
if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
process.exit(fail === 0 ? 0 : 1);
