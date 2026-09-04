// Schema changes that are not just "create it if it isn't there".
//
// Everything until now has been idempotent boot DDL: one long CREATE TABLE IF
// NOT EXISTS ... ADD COLUMN IF NOT EXISTS batch, run on every start. That is a
// good trade while a schema is only ever growing — a new environment is one
// deploy from complete, with no migration step for anybody to forget.
//
// It runs out exactly when the schema stops only growing. "IF NOT EXISTS"
// cannot change a column's type, rename anything, backfill a value, add a
// constraint, or drop the six tables the intelligence spec created and nothing
// ever read. Phase 2 of PLAN.md needs all of those, so the mechanism has to
// exist before the work does. This is PLAN.md task 1.1.
//
// Deliberately small. No migration library, no down-migrations, no checksums:
//
//   * A `down` that has never been run is a lie in the repository. The way back
//     from a bad migration here is the nightly dump, which is tested weekly
//     (deploy/restore-test.sh) — a real recovery path rather than a hopeful one.
//   * Each file runs inside a transaction, so it either applies completely or
//     not at all. Postgres does DDL transactionally, which is what makes this
//     eleven lines instead of a dependency.
//   * An advisory lock means two boots — a deploy overlapping a restart — do
//     not run the same file twice.
//
// WHAT IT DOES ON FAILURE, which is the part worth arguing about: it stops at
// the first file that fails, leaves the rest unapplied, and lets the server
// carry on serving. It does NOT exit. A tutor with a child already in the room
// must not lose the lesson because a migration that only Phase 2 needs could
// not run; the old code is still correct against the old schema, because
// migrations only ever run ahead of the code that uses them.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Pool } from 'pg';

export const MIGRATIONS_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version     text PRIMARY KEY,
    applied_at  timestamptz NOT NULL DEFAULT now(),
    duration_ms integer
  );
`;

/** One arbitrary constant, so only this code contends for this lock. */
const LOCK_ID = 8675309;

/**
 * Where the .sql files live.
 *
 * Under `src/server/` rather than a top-level `migrations/` because AGENTS.md
 * forbids adding a top-level folder without asking, and because `src` is
 * already what the deploy tarball ships — a migration the deploy leaves behind
 * is worse than no migration runner at all.
 */
function migrationsDir(): string {
  // Two layouts, both real. Running from source (tsx, and the test suite) this
  // file sits beside its own migrations folder. Running the PRE-BUILT server
  // it does not: production bundles to dist-server/server.mjs, and the .sql
  // files are data that no bundler carries. So the sibling is tried first and
  // the repo path second — and the check is existsSync rather than a try/catch,
  // because resolving the wrong directory does not throw, it silently finds no
  // migrations and reports "nothing to do".
  try {
    const beside = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
    if (fs.existsSync(beside)) return beside;
  } catch { /* no import.meta in this context — fall through */ }
  return path.join(process.cwd(), 'src', 'server', 'migrations');
}

export interface MigrationResult {
  applied: string[];
  alreadyApplied: number;
  failed: { version: string; error: string } | null;
}

/** Sorted, so 0002 never runs before 0010 by accident of readdir order. */
export function listMigrationFiles(dir = migrationsDir()): string[] {
  try {
    return fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  } catch {
    return [];
  }
}

export async function runMigrations(pool: Pool): Promise<MigrationResult> {
  const out: MigrationResult = { applied: [], alreadyApplied: 0, failed: null };
  const dir = migrationsDir();
  const files = listMigrationFiles(dir);
  if (files.length === 0) return out;

  await pool.query(MIGRATIONS_SCHEMA_SQL);

  // Wait for the lock rather than skipping: the other boot may be mid-file,
  // and starting the app against a half-migrated schema is the thing to avoid.
  await pool.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
  try {
    const done = new Set<string>(
      (await pool.query('SELECT version FROM schema_migrations')).rows.map((r: { version: string }) => r.version),
    );

    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      if (done.has(version)) { out.alreadyApplied++; continue; }

      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      const started = Date.now();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (version, duration_ms) VALUES ($1, $2)',
          [version, Date.now() - started],
        );
        await client.query('COMMIT');
        out.applied.push(version);
        console.log(`🧱 migration ${version} applied in ${Date.now() - started}ms`);
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch { /* the connection is going back anyway */ }
        out.failed = { version, error: (err as Error).message };
        // Stop here. Running 0004 after 0003 failed is how a schema ends up in
        // a state no file describes.
        console.error(`❌ migration ${version} FAILED and was rolled back: ${(err as Error).message}`);
        console.error('   Later migrations were skipped. The app is still serving on the previous schema.');
        break;
      } finally {
        client.release();
      }
    }
  } finally {
    await pool.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => { /* the lock dies with the session */ });
  }

  if (out.applied.length === 0 && !out.failed) {
    console.log(`🧱 migrations: ${out.alreadyApplied} already applied, nothing to do`);
  }
  return out;
}
