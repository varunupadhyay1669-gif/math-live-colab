import { ClassPack } from './classPack';
import { buildPackJson, buildPackArchive, slugId, type PackInputs, type RawSnapshot } from './packExport';
import type { StoredPack } from './packStore';
import { summariseInteractives, type RecordedAttempt } from './interactives';
import type { ClassPackJson, PackEvent, PackSurface, PackExplainerOutline, PackInteractive } from './packSchema';

// Rebuilding a pack from a stored session.
//
// P2-4 asked for a way to re-export the sidecar without regenerating the PDF —
// you notice a week later that you never saved the JSON, or a schema change
// means the old one should be reissued. That was impossible while the pack
// lived only in a React ref; now that sessions are stored, this turns one back
// into an export.
//
// Deliberately the SAME code path the live export uses. Two builders would
// drift, and the difference would only show up in a pack a model then read
// wrongly.

export interface RebuiltPack {
  json: ClassPackJson;
  baseName: string;
  inputs: PackInputs;
  pack: ClassPack;
}

/** Returns null when the record is unusable — never a half-rebuilt pack. */
export function rebuildFromStored(stored: StoredPack): RebuiltPack | null {
  const pack = ClassPack.fromState(stored.state);
  if (!pack) return null;

  const side = stored.side;
  const teacher = side?.teacher || pack.meta.teacher || 'Teacher';
  const student = side?.student || pack.meta.student || null;
  const room = stored.room || pack.meta.room || '';

  const snapshots: RawSnapshot[] = pack.allSnapshots.map(sn => ({
    t: sn.t, dataUrl: sn.dataUrl, width: sn.width, height: sn.height, label: sn.label,
    surfaceId: sn.surfaceId, reason: sn.reason, hasNewInk: sn.hasNewInk,
    inkBbox: sn.inkBbox, inkDeltaDataUrl: sn.inkDeltaDataUrl, scrollY: sn.scrollY,
  }));

  const surfaces = (side?.surfaces as PackSurface[] | undefined)?.length
    ? (side!.surfaces as PackSurface[])
    : [{ id: 'wb_1', type: 'whiteboard' as const, title: null }];

  const inputs: PackInputs = {
    sessionId: `sess_${room}_${new Date(pack.startedAt).toISOString().slice(0, 10)}`,
    startedAt: pack.startedAt,
    // A stored pack has no live clock; the last save is the best end we know.
    endedAt: stored.savedAt || pack.startedAt,
    room,
    subject: 'Math',
    lessonNumber: null,
    participants: [
      { role: 'tutor', id: `u_${slugId(teacher)}`, display_name: teacher, timezone: null },
      ...(student ? [{ role: 'student' as const, id: `s_${slugId(student)}`, display_name: student, timezone: null }] : []),
    ],
    intentBefore: side?.intentBefore || pack.meta.intentBefore || null,
    noteAfter: side?.noteAfter || pack.meta.noteAfter || null,
    narration: pack.allNarration,
    events: [
      ...((side?.events as PackEvent[] | undefined) || []),
      ...pack.allMoments.map(m => ({ t: m.t / 1000, type: 'note' as const, text: m.text })),
    ],
    surfaces,
    snapshots,
    materials: pack.allArtifacts
      .filter(a => a.kind === 'lesson' || a.kind === 'explanation')
      .map((a, i) => ({
        id: `mat_${i + 1}`,
        type: (a.kind === 'lesson' ? 'lesson_page' : 'explainer') as 'lesson_page' | 'explainer',
        name: a.name, shownFrom: a.t / 1000, shownTo: null, source: 'in_lesson',
        sourceHtml: a.body ?? null, dataUrl: null,
      })),
    outlines: (side?.outlines as PackExplainerOutline[] | undefined) || [],
    // The recorded clicks and the discovered questions are two separate lists,
    // and they must be folded together exactly as the live export does. Reading
    // only the discovered questions re-exported every one of them as
    // "unanswered" — losing the single most valuable thing in the pack.
    interactives: summariseInteractives(
      (side?.attempts as RecordedAttempt[] | undefined) || [],
      surfaces.find(sf => sf.type === 'explainer')?.id || surfaces[0]?.id || 'exp_1',
      (side?.interactives as PackInteractive[] | undefined) || [],
    ),
    homework: pack.allHomework.map(h => ({
      kind: h.kind, name: h.name, mime: h.mime, dataUrl: h.dataUrl, bytesBase64: h.bytesBase64,
    })),
    duplicatesSuppressed: pack.suppressedCount,
    failures: [{ what: 're-export', why: 'rebuilt from a stored session, not captured live' }],
  };

  return {
    json: buildPackJson(inputs),
    baseName: pack.suggestedFilename().replace(/\.pdf$/, ''),
    inputs,
    pack,
  };
}

/** Just the sidecar — no PDF regenerated. This is the P2-4 case. */
export function rebuildJsonBlob(stored: StoredPack): { blob: Blob; filename: string } | null {
  const built = rebuildFromStored(stored);
  if (!built) return null;
  return {
    blob: new Blob([JSON.stringify(built.json, null, 2)], { type: 'application/json' }),
    filename: `${built.baseName}.json`,
  };
}

/** The whole archive again, PDF included. */
export async function rebuildArchive(stored: StoredPack): Promise<{ blob: Blob; filename: string } | null> {
  const built = rebuildFromStored(stored);
  if (!built) return null;
  const pdfBytes = new Uint8Array(await built.pack.buildPdf().arrayBuffer());
  return {
    blob: buildPackArchive(pdfBytes, built.json, built.inputs, built.baseName),
    filename: `${built.baseName}.zip`,
  };
}
