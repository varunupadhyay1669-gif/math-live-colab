// Where Supabase credentials come from, and the guard that stops a blank page.
//
// The live crash this covers: with the variables unset, createClient('') throws
// "Invalid supabaseUrl: Must be a valid HTTP or HTTPS URL" while the module is
// still evaluating. That takes down the WHOLE app — a tutor with no database
// configured got a blank page instead of a working whiteboard.
// node --import tsx test-runtimeconfig.mjs
import { validSupabaseUrl, resolveConfig } from './src/lib/runtimeConfig.ts';

let pass = 0, fail = 0; const fails = [];
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, d) => { fail++; fails.push(n + (d ? ' — ' + d : '')); console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); };
const assert = (c, n, d) => c ? ok(n) : bad(n, d);

const URL_OK = 'https://umskfpcvaiybdxlnpcck.supabase.co';
const KEY_OK = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.some.reasonably-long-anon-key';

console.log('R1: the exact values that crashed the app');
assert(!validSupabaseUrl(''), 'an empty string is not a URL — this is the one that threw');
assert(!validSupabaseUrl(undefined), 'nor undefined');
assert(!validSupabaseUrl(null), 'nor null');
assert(!validSupabaseUrl('   '), 'nor whitespace');
assert(!validSupabaseUrl('undefined'), 'nor the STRING "undefined", which is what a bad template produces');

console.log('R2: real URLs are accepted');
assert(validSupabaseUrl(URL_OK), 'a Supabase project URL');
assert(validSupabaseUrl('http://localhost:54321'), 'and a local one over http');
assert(validSupabaseUrl(' https://x.supabase.co '), 'padded with spaces, which a paste often is');

console.log('R3: things that look like URLs but are not');
assert(!validSupabaseUrl('umskfpcvaiybdxlnpcck.supabase.co'), 'no protocol is not a valid URL');
assert(!validSupabaseUrl('ftp://x.supabase.co'), 'nor a non-http protocol');
assert(!validSupabaseUrl('javascript:alert(1)'), 'and definitely not a javascript: URL');
assert(!validSupabaseUrl(12345), 'nor a number');

console.log('R4: build-time wins, runtime fills in');
const built = resolveConfig({ url: URL_OK, anonKey: KEY_OK }, null);
assert(built?.url === URL_OK, 'build-time values are used when present');
const fetched = resolveConfig({ url: undefined, anonKey: undefined }, { url: URL_OK, anonKey: KEY_OK });
assert(fetched?.url === URL_OK, 'and the server fills in when the build had none');
const both = resolveConfig({ url: URL_OK, anonKey: KEY_OK }, { url: 'https://other.supabase.co', anonKey: KEY_OK });
assert(both?.url === URL_OK, 'build-time wins over runtime — no needless round trip');

console.log('R5: half a configuration is not a configuration');
// Proceeding with one of the two is what produces the crash.
assert(resolveConfig({ url: URL_OK, anonKey: undefined }, null) === null, 'a URL with no key yields null');
assert(resolveConfig({ url: undefined, anonKey: KEY_OK }, null) === null, 'and a key with no URL');
assert(resolveConfig({ url: '', anonKey: '' }, null) === null, 'two empty strings yield null, NOT a client');
assert(resolveConfig({}, {}) === null, 'and nothing at all');
assert(resolveConfig({ url: URL_OK, anonKey: 'short' }, null) === null,
  'an implausibly short key is refused rather than sent to the server');

console.log('R6: a broken runtime response does not break the app');
// The server can answer with anything. None of it may throw.
for (const junk of [null, undefined, {}, { url: null, anonKey: null }, { url: 'nope' }, { url: 123, anonKey: 456 }]) {
  let threw = false, res;
  try { res = resolveConfig({}, junk); } catch { threw = true; }
  assert(!threw && res === null, `junk response handled: ${JSON.stringify(junk)}`);
}

console.log('R7: "no database" is a valid state, not an error');
// Rooms, the whiteboard and live sync all work with no account. Returning null
// must mean "run without records", never "crash".
assert(resolveConfig({}, null) === null, 'an unconfigured deployment resolves to null');

console.log(`\nRUNTIME CONFIG RESULT: ${pass} passed, ${fail} failed`);
if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
process.exit(fail === 0 ? 0 : 1);
