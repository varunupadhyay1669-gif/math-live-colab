// Regenerate the checked-in sample pack from the fixture.
//   node --import tsx scripts/make-sample-pack.mjs
//
// The fixture mirrors a real 48-minute session: the timer produced 60 frames of
// which 14 survive, the tutor corrects an inequality on the board, and the
// student answers three practice questions with two wrong first.
import { writeFileSync, mkdirSync } from 'node:fs';
import { buildPackJson } from '../src/lib/packExport.ts';
import { validatePack } from '../src/lib/packSchema.ts';
import { fixture } from '../fixtures/session-kanishka.mjs';

const pack = buildPackJson(fixture());
const errs = validatePack(pack);
if (errs.length) {
  console.error('sample does not validate:', errs);
  process.exit(1);
}
mkdirSync('docs', { recursive: true });
writeFileSync('docs/sample-class-pack.json', JSON.stringify(pack, null, 2) + '\n');
console.log('wrote docs/sample-class-pack.json');
console.log(`  snapshots kept       ${pack.capture_report.board_snapshots_kept}`);
console.log(`  duplicates suppressed ${pack.capture_report.duplicates_suppressed}`);
console.log(`  with new ink          ${pack.capture_report.snapshots_with_new_ink}`);
console.log(`  transcript lines      ${pack.transcript.length} (${pack.capture_report.asr_lines_low_confidence} low confidence)`);
console.log(`  questions             ${pack.interactives.length}`);
