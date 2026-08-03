// A fixture modelled on a real completed session.
//
// Shaped from an actual pack that came back from a lesson: 21 minutes, board
// snapshots only, a transcript with genuine ASR failures in it ("Merry Christmas
// until notation" for set-builder notation), and an explainer whose practice
// questions never reached the export at all. Scaled to the 48-minute case in the
// spec so the snapshot counts mean something.
//
// Used by the sample generator and by test-packexport.

const IMG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

/** A board frame, at t seconds, optionally carrying new ink. */
function snap(tSeconds, reason, ink) {
  return {
    t: tSeconds * 1000,
    dataUrl: IMG, width: 1220, height: 590,
    label: 'Whiteboard', surfaceId: 'wb_1', reason,
    hasNewInk: !!ink,
    inkBbox: ink || null,
    inkDeltaDataUrl: ink ? IMG : null,
    scrollY: 0,
  };
}

export function fixture(overrides = {}) {
  const started = Date.parse('2026-08-03T20:39:50.000Z');
  return {
    sessionId: 'sess_kanishka_20260803',
    startedAt: started,
    endedAt: started + 2880 * 1000,
    room: 'kanishka',
    subject: 'Math',
    lessonNumber: 3,
    participants: [
      { role: 'tutor', id: 'u_varun_upadhyay', display_name: 'Varun Upadhyay', timezone: null },
      { role: 'student', id: 's_kanishka_sharma', display_name: 'Kanishka Sharma', timezone: null },
    ],
    intentBefore: 'aiming to finish sets; homework should lean on interval notation',
    noteAfter: 'still flipping the inequality sign when dividing by a negative - worksheet should drill that',
    narration: [
      { t: 1640000, speaker: 'Varun Upadhyay', text: 'so we solve this right, so we subtracted 2 from both sides' },
      { t: 1667000, speaker: 'Kanishka Sharma', text: 'is it x greater than or equal to minus 18' },
      { t: 1672000, speaker: 'Varun Upadhyay', text: 'careful, you divided by a negative so the sign flips' },
      { t: 1900000, speaker: 'Varun Upadhyay', text: 'Merry Christmas until notation' },
      { t: 2540000, speaker: 'Kanishka Sharma', text: 'the intersection is minus 2 to 5' },
    ],
    // A real recogniser is confident about clear speech and hedges on the rest.
    confidenceOf: (line) =>
      line.text.includes('Merry Christmas')
        ? { confidence: 0.41, alternates: ['set builder notation', 'set-builder notation'] }
        : { confidence: 0.93, alternates: [] },
    events: [
      { t: 481, type: 'control_handed_to_student' },
      { t: 1964, type: 'surface_changed', surface_id: 'exp_1' },
      { t: 2267, type: 'surface_changed', surface_id: 'wb_1' },
      { t: 2400, type: 'silence', duration_s: 42 },
    ],
    surfaces: [
      { id: 'wb_1', type: 'whiteboard', title: null },
      { id: 'exp_1', type: 'explainer', title: 'Mastering Sets & Interval Notation' },
    ],
    // 14 kept from 60 offered; the two either side of the correction both survive.
    snapshots: [
      snap(300, 'ink_committed', [180, 240, 520, 300]),
      snap(640, 'ink_committed', [200, 260, 560, 320]),
      snap(980, 'surface_changed'),
      snap(1200, 'ink_committed', [210, 280, 540, 340]),
      snap(1420, 'ink_committed', [220, 290, 550, 350]),
      // The correction: "x <= -18" written, then crossed out and rewritten.
      snap(1640, 'ink_committed', [220, 300, 470, 360]),
      snap(1667, 'ink_committed', [220, 300, 470, 360]),
      snap(1810, 'ink_committed', [230, 310, 600, 370]),
      snap(1964, 'surface_changed'),
      snap(2100, 'interactive_answered'),
      snap(2267, 'surface_changed'),
      snap(2400, 'ink_committed', [240, 320, 610, 380]),
      snap(2600, 'ink_committed', [250, 330, 620, 390]),
      snap(2870, 'session_end'),
    ],
    materials: [
      {
        id: 'mat_1', type: 'explainer', name: 'Mastering Sets & Interval Notation',
        shownFrom: 1964000, shownTo: 2267000, source: 'in_lesson',
        sourceHtml: '<html><head><style>/* 18 pages of it */</style></head><body>...</body></html>',
        dataUrl: null,
      },
    ],
    outlines: [
      {
        surface_id: 'exp_1',
        title: 'Mastering Sets & Interval Notation',
        sections: [
          {
            heading: 'Why it matters', level: 2,
            text: ['Intervals describe a continuous run of numbers.'],
            worked_examples: [],
            questions: [],
          },
          {
            heading: 'Practice Zone', level: 2,
            text: [],
            worked_examples: [{ title: 'Worked example 1', steps: ['Subtract 2 from both sides', 'Divide by -3 and flip the sign'] }],
            questions: [
              { question_id: 'q4', prompt: 'Find the intersection of I1 = (-inf, 5) and I2 = [-2, inf)', options: ['(-inf, inf)', '(-2, 5]', '[-2, 5)', 'empty set'], correct_option_index: 2 },
            ],
          },
        ],
        source_ref: 'materials/mat_1.html',
      },
    ],
    interactives: [
      {
        surface_id: 'exp_1', widget: 'practice_zone', question_id: 'q4',
        prompt: 'Find the intersection of I1 = (-inf, 5) and I2 = [-2, inf)',
        options: ['(-inf, inf)', '(-2, 5]', '[-2, 5)', 'empty set'],
        correct_option_index: 2,
        attempts: [
          { t: 2540, by: 'student', option_index: 1, correct: false },
          { t: 2562, by: 'student', option_index: 2, correct: true },
        ],
        final_state: 'correct_after_retry',
      },
      {
        surface_id: 'exp_1', widget: 'trap_or_truth', question_id: 'q5',
        prompt: 'Is (-2,5) a closed interval?', options: ['yes', 'no'], correct_option_index: 1,
        attempts: [{ t: 2600, by: 'student', option_index: 1, correct: true }],
        final_state: 'correct_first_try',
      },
      {
        surface_id: 'exp_1', widget: 'practice_zone', question_id: 'q6',
        prompt: 'Solve 4x < 9 - 2x', options: ['x < 1.5', 'x > 1.5'], correct_option_index: 0,
        attempts: [{ t: 2700, by: 'student', option_index: 1, correct: false }],
        final_state: 'incorrect',
      },
    ],
    duplicatesSuppressed: 46,
    failures: [{ what: 'lesson_screen_recording', why: 'capture not enabled for this room' }],
    generatedAt: '2026-08-03T21:30:00.000Z',
    ...overrides,
  };
}
