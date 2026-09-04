// Build a release tarball, and refuse to build one that has not been checked.
//
// Why this exists. On 3 Sep 2026 a deploy died on the server at "3/4 checking
// it at least parses": release.sh ran `tsc --noEmit` on the box, the compiler
// asked for 455MB beside Postgres on a 1GB machine, and the kernel killed it.
// The files had already been unpacked by then, so the deploy failed holding the
// door open — new code on disk, old process serving, and the next restart from
// any cause would have picked up code no one had decided to ship.
//
// The compiler is a larger process than the app it checks. Running it next to
// the database is the same mistake that took the site down for three hours that
// morning, and giving it a bigger heap would make that outcome more likely, not
// less. So the check moves to the machine with memory to spare — this one — and
// travels with the tarball as .typecheck-ok, which release.sh verifies BEFORE it
// unpacks anything.
//
//   npm run pack
//
// It runs the full offline suite, builds, writes the marker, and prints the one
// command that ships it.
import { execFileSync, execSync } from 'node:child_process';
import { writeFileSync, statSync, existsSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MARKER = join(ROOT, '.typecheck-ok');
const OUT = process.env.PACK_OUT || join(tmpdir(), 'mathslive-app.tgz');

// Exactly what release.sh restores on a rollback, plus the marker, so a
// rolled-back release carries the proof that IT was checked and not the proof
// belonging to the release that replaced it.
const PARTS = [
  'server.ts', 'src', 'dist', 'dist-server', 'package.json', 'package-lock.json',
  'index.html', 'vite.config.ts', 'tsconfig.json', 'deploy', '.typecheck-ok',
];

const say = (s) => console.log(`\n\x1b[1;36m${s}\x1b[0m`);
const die = (s) => { console.error(`\x1b[1;31m${s}\x1b[0m`); process.exit(1); };

function run(label, cmd) {
  say(label);
  try {
    execSync(cmd, { cwd: ROOT, stdio: 'inherit' });
  } catch {
    // The marker must never outlive a failure. If it did, the next pack would
    // ship a tarball whose proof belongs to an older, working build.
    if (existsSync(MARKER)) unlinkSync(MARKER);
    die(`${label} failed — nothing was packed.`);
  }
}

function git(args, fallback) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return fallback;
  }
}

// Delete it first: a marker on disk from a previous pack is indistinguishable
// from one earned by this build, and that is precisely the accident this file
// exists to prevent.
if (existsSync(MARKER)) unlinkSync(MARKER);

const commit = git(['rev-parse', '--short', 'HEAD'], 'unknown');
const dirty = git(['status', '--porcelain'], '') !== '';
const id = dirty ? `${commit}-dirty` : commit;

run('1/4  Checking it (types, mirror, packing)', 'npm test');
run('2/4  Building the client and the server', 'npm run build && npm run build:server');

say('3/4  Marking it as checked');
writeFileSync(
  MARKER,
  `${id}\n${new Date().toISOString()}\nnpm test && npm run build\n`,
  'utf8',
);
console.log(`  ${id}`);
if (dirty) {
  console.log('  \x1b[33muncommitted changes — this tarball does not match any commit\x1b[0m');
}

say(`4/4  Packing ${OUT}`);
// mathslive.env is excluded twice over: it is gitignored so it is not here, and
// named here anyway, because "not here" is a property of this checkout and not
// of every checkout this ever runs in.
const args = ['-c', '-z', '-f', OUT, '--exclude', 'deploy/mathslive.env', ...PARTS];
// A Windows path starts "C:", and GNU tar reads anything before a colon as a
// remote HOST — it tries to rsh to a machine called C. --force-local says no.
// BSD tar, which is what a bare `tar` resolves to in some Windows shells, has
// no such flag and does not need one, so try it and drop it if it is rejected.
// The mode is spelled -c -z -f rather than czf because GNU tar only accepts the
// bundled form as the FIRST argument, and --force-local has to go somewhere.
const local = /^[A-Za-z]:/.test(OUT) ? ['--force-local'] : [];
try {
  execFileSync('tar', [...local, ...args], { cwd: ROOT, stdio: 'inherit' });
} catch (err) {
  if (local.length) {
    try {
      execFileSync('tar', args, { cwd: ROOT, stdio: 'inherit' });
    } catch (err2) {
      die(`tar failed: ${err2.message}`);
    }
  } else {
    die(`tar failed: ${err.message}`);
  }
}
const mb = (statSync(OUT).size / 1024 / 1024).toFixed(1);
console.log(`  ${mb} MB`);

console.log(`
\x1b[1mShip it:\x1b[0m
  scp -i ~/.ssh/mathslive_aws ${OUT} ubuntu@52.66.124.44:/tmp/mathslive-app.tgz
  ssh -i ~/.ssh/mathslive_aws ubuntu@52.66.124.44 "sudo RELEASE_ID=${id} /opt/mathslive/deploy/release.sh deploy /tmp/mathslive-app.tgz"

The deploy snapshots what is running, checks this marker before it unpacks
anything, and restarts at the first moment no lesson is live. To undo it:
  ssh -i ~/.ssh/mathslive_aws ubuntu@52.66.124.44 "sudo /opt/mathslive/deploy/release.sh rollback"
`);
