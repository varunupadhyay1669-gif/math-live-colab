// Check a class pack against the 1.2 contract.
//
//   node --import tsx tools/validate_pack.mjs <dir-or-json> [...]
//
// Two layers, because a pack can be well-formed and still be a lie:
//
//   SHAPE      validatePack() in src/lib/packSchema.ts — fields, types, and
//              every cross-reference (evidence pointers, surface ids, material
//              ids) resolving to something that exists in the same file.
//   ARCHIVE    what only the filesystem can answer: does every image the JSON
//              names actually exist, is summary.md there and small enough, and
//              does the README promise anything the pack does not contain.
//
// The README check is the one that catches the failure this whole exercise
// began with: a manifest advertising materials and practice questions in a
// pack where both were empty. An agent that trusts the manifest wastes its
// time; one that learns not to stops reading it. Either way the promise costs
// more than it buys, so a promise with nothing behind it is an ERROR here.
import { readFileSync, existsSync, statSync, readdirSync } from 'fs';
import path from 'path';
import { validatePack } from '../src/lib/packSchema.ts';

const MAX_SUMMARY_BYTES = 6 * 1024;

/** Resolve the argument to {jsonPath, root}. */
function locate(target) {
  if (!existsSync(target)) throw new Error(`no such path: ${target}`);
  if (statSync(target).isDirectory()) {
    const jsons = readdirSync(target).filter(f => f.endsWith('.json'));
    if (jsons.length === 0) throw new Error(`no .json in ${target}`);
    if (jsons.length > 1) throw new Error(`more than one .json in ${target}: ${jsons.join(', ')}`);
    return { jsonPath: path.join(target, jsons[0]), root: target };
  }
  return { jsonPath: target, root: path.dirname(target) };
}

function archiveErrors(pack, root) {
  const errs = [];
  const here = (rel) => existsSync(path.join(root, rel));

  // Every image the JSON names must be in the archive. A snapshot pointing at
  // a file that is not there is worse than no snapshot: a consumer plans around
  // a frame it can never load.
  for (const [i, s] of (pack.snapshots ?? []).entries()) {
    if (s.image && !here(s.image)) errs.push(`snapshots[${i}].image missing from archive: ${s.image}`);
    if (s.ink_delta_image && !here(s.ink_delta_image)) {
      errs.push(`snapshots[${i}].ink_delta_image missing from archive: ${s.ink_delta_image}`);
    }
  }
  for (const [i, m] of (pack.materials ?? []).entries()) {
    if (m.image && !here(m.image)) errs.push(`materials[${i}].image missing from archive: ${m.image}`);
    if (m.source_ref && !here(m.source_ref)) errs.push(`materials[${i}].source_ref missing from archive: ${m.source_ref}`);
  }

  // summary.md travels with `derived`: the model wrote both, and one without
  // the other means half a pass was lost somewhere.
  const summaryPath = path.join(root, 'summary.md');
  const hasSummary = existsSync(summaryPath);
  if (pack.derived && !hasSummary) errs.push('derived is present but summary.md is missing');
  if (hasSummary) {
    const size = statSync(summaryPath).size;
    if (size >= MAX_SUMMARY_BYTES) {
      errs.push(`summary.md is ${size} bytes; it must stay under ${MAX_SUMMARY_BYTES} (about a page)`);
    }
    if (size === 0) errs.push('summary.md is empty');
  }

  // The manifest must not promise absent data.
  const readmePath = path.join(root, 'README.txt');
  if (!existsSync(readmePath)) {
    errs.push('README.txt missing');
  } else {
    const readme = readFileSync(readmePath, 'utf8');
    const promises = [
      { re: /materials\//i,                  has: (pack.materials ?? []).length > 0,           what: 'materials/' },
      { re: /snapshots\//i,                  has: (pack.snapshots ?? []).length > 0,           what: 'snapshots/' },
      { re: /interactive|practice question/i, has: (pack.interactives ?? []).length > 0,       what: 'interactives' },
      { re: /explainer/i,                    has: (pack.explainer_outlines ?? []).length > 0,  what: 'explainer outlines' },
      { re: /summary\.md/i,                  has: hasSummary,                                  what: 'summary.md' },
      { re: /\bderived\b/i,                  has: !!pack.derived,                              what: 'derived' },
    ];
    for (const p of promises) {
      if (p.re.test(readme) && !p.has) {
        errs.push(`README promises ${p.what}, but the pack has none`);
      }
    }
    if (!/For AI agents/i.test(readme)) {
      errs.push('README is missing the "For AI agents" orientation line');
    }
  }

  // The anonymisation must survive into everything derived from the pack.
  const named = (pack.session?.participants ?? []).find(p => p.role === 'student');
  if (named && named.display_name !== 'Student') {
    errs.push(`student display_name is "${named.display_name}"; packs must stay anonymised as "Student"`);
  }

  return errs;
}

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error('usage: node --import tsx tools/validate_pack.mjs <pack-dir-or-json> [...]');
  process.exit(2);
}

let failed = 0;
for (const target of targets) {
  let errs = [];
  let pack = null;
  try {
    const { jsonPath, root } = locate(target);
    pack = JSON.parse(readFileSync(jsonPath, 'utf8'));
    errs = [...validatePack(pack), ...archiveErrors(pack, root)];
  } catch (err) {
    errs = [`could not read pack: ${err.message}`];
  }

  const label = `${target}${pack?.schema_version ? ` (schema ${pack.schema_version})` : ''}`;
  if (errs.length === 0) {
    console.log(`✓ ${label}`);
  } else {
    failed++;
    console.log(`✗ ${label} — ${errs.length} problem(s)`);
    for (const e of errs) console.log(`    · ${e}`);
  }
}

process.exit(failed === 0 ? 0 : 1);
