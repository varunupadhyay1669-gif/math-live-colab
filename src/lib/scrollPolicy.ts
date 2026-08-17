// Who may scroll the lesson, and whose scrolling moves whom.
//
// Extracted from StudentView because the rule was written inline as one
// expression and quietly conflated two unrelated ideas — permission and the
// "Linked" toggle — which produced three separate faults in a single lesson:
// a view-only student scrolling away mid-explanation, revoking interaction not
// re-locking them, and a driving student's scroll never reaching the teacher.
//
// Two independent questions, kept independent:
//
//   mayStudentScroll  — a PERMISSION question. Only about whether this student
//                       is allowed to drive the lesson at all.
//   teacherScrollPushes / studentScrollPushes
//                     — ROUTING questions. Who is told about a scroll once it
//                       has legitimately happened.

export interface ScrollContext {
  /** Teacher has switched the whole room to interactive. */
  interactionAllowed: boolean;
  /** This particular student currently holds the control baton. */
  hasControl: boolean;
  /** The "Linked" toggle: teacher scrolling drags the students' view along. */
  scrollSyncEnabled: boolean;
}

/** May this student drive the lesson — click, type, and therefore scroll it? */
export function mayDrive(ctx: ScrollContext): boolean {
  return ctx.interactionAllowed || ctx.hasControl;
}

/**
 * May this student scroll their own view?
 *
 * Deliberately independent of scrollSyncEnabled. A student who may not drive
 * the lesson may not scroll it either, whatever the Linked toggle says —
 * otherwise unlinking scroll silently hands every view-only student the
 * freedom to wander off the page the teacher is explaining.
 */
export function mayStudentScroll(ctx: ScrollContext): boolean {
  return mayDrive(ctx);
}

/** The inverse, in the shape the follower script expects. */
export function scrollLocked(ctx: ScrollContext): boolean {
  return !mayStudentScroll(ctx);
}

/**
 * Does the teacher's scrolling move the students' view?
 *
 * This is what "Linked" actually means, and the only thing it should govern.
 */
export function teacherScrollPushes(ctx: ScrollContext): boolean {
  return ctx.scrollSyncEnabled;
}

/**
 * Does this student's scrolling move the TEACHER's view?
 *
 * Yes whenever they are driving — and NOT conditional on Linked. A tutor who
 * has handed a student the wheel needs to see where they have gone, or they
 * end up describing something that is off the student's screen. Linked governs
 * the teacher→student direction; it should not silently disable the return path.
 */
export function studentScrollPushes(ctx: ScrollContext): boolean {
  return mayDrive(ctx);
}
