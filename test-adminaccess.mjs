// Telling "not set up yet" apart from "not allowed".
//
// These looked identical to the admin page, so the owner — signed in with the
// right account — was told "this account does not have access" when the truth
// was that a migration had not been run. That sends someone hunting a
// permissions bug that does not exist.
//
// The payloads below are the REAL ones: PGRST202 is what this project's
// PostgREST actually returned, captured from it.
// node --import tsx test-adminaccess.mjs
import { classifyAdminError } from './src/lib/adminLabels.ts';

let pass = 0, fail = 0; const fails = [];
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, d) => { fail++; fails.push(n + (d ? ' — ' + d : '')); console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); };
const assert = (c, n, d) => c ? ok(n) : bad(n, d);

console.log('C1: the error this project actually returns');
// Captured verbatim from the live database before migration 004 was run.
const REAL = {
  code: 'PGRST202',
  details: 'Searched for the function public.is_platform_admin without parameters or with a single unnamed json/jsonb parameter, but no matches were found in the schema cache.',
  hint: null,
  message: 'Could not find the function public.is_platform_admin without parameters in the schema cache',
};
assert(classifyAdminError(REAL) === 'not-installed',
  'a missing RPC is recognised as "not installed", not as a refusal', classifyAdminError(REAL));

console.log('C2: the older detector missed exactly this');
// It looked for 42883 or the words "could not find the function"/"does not
// exist" in `message`. PostgREST puts the useful wording in `details`, and the
// code is its own — so the one condition the check existed to name fell
// through to "unknown error".
assert(classifyAdminError({ code: 'PGRST202', details: REAL.details, message: '' }) === 'not-installed',
  'even when the message is empty and only details explain it');
assert(classifyAdminError({ code: '42883', message: 'function public.x() does not exist' }) === 'not-installed',
  'and Postgres raising it directly still counts');

console.log('C3: a genuine refusal stays a refusal');
assert(classifyAdminError({ code: '42501', message: 'not authorised' }) === 'denied',
  'insufficient_privilege is a refusal');
assert(classifyAdminError({ message: 'not authorised' }) === 'denied', 'and so is the message alone');
assert(classifyAdminError({ code: 'P0001', message: 'not authorized' }) === 'denied', 'either spelling');

console.log('C4: anything else is honestly unknown');
// Reporting a network blip as "not installed" would send someone to run a
// migration they have already run.
assert(classifyAdminError({ message: 'Failed to fetch' }) === 'error', 'a network failure is not a diagnosis');
assert(classifyAdminError({ code: '08006', message: 'connection failure' }) === 'error', 'nor is a dropped connection');
assert(classifyAdminError(null) === 'error', 'and neither is nothing at all');
assert(classifyAdminError({}) === 'error', 'nor an empty object');

console.log(`\nADMIN ACCESS RESULT: ${pass} passed, ${fail} failed`);
if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
process.exit(fail === 0 ? 0 : 1);
