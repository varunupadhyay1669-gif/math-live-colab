// AUTONOMOUS: Centralised iframe attributes for the lesson iframe.
//
// Modern 3D / WebXR / WebGL simulations need more permissions than the
// minimal sandbox we used to ship with. A typical Three.js / Babylon /
// p5.js scene in a sandboxed iframe needs at least:
//
//   - allow-scripts      → run the renderer
//   - allow-same-origin  → load CDN scripts under same-origin policy
//   - allow-forms        → quizzes / forms inside lessons
//   - allow-modals       → confirm() / alert() prompts
//   - allow-popups       → "View on CodePen" type buttons
//   - allow-pointer-lock → OrbitControls, FirstPersonControls
//   - allow-presentation → presentation API (some VR demos)
//   - allow-downloads    → "save screenshot" / "download PLY" features
//
// AND the `allow` permissions-policy attribute, which is a separate
// mechanism Chrome / Safari enforce on iframes. Without it the
// fullscreen button, device-orientation sensors, autoplaying audio,
// WebXR, gamepad, and similar features are blocked — even with the
// right sandbox flags. Many 3D demos fail to render anything because
// they call requestFullscreen() on init and the call is denied.
//
// The flags here are the union of what the major 3D libraries
// (Three.js, Babylon, p5.js, A-Frame, model-viewer) request when they
// boot up.
//
// SECURITY NOTE: the sandbox is NOT a hard boundary in this app. Lesson
// HTML is loaded from a blob: URL created by the parent, so the document
// inherits the parent's origin; `allow-same-origin` + `allow-scripts`
// therefore lets sim code run same-origin with the app. We keep
// `allow-same-origin` deliberately because the parent reads the iframe's
// scroll position directly (annotation anchoring) and many sims use
// localStorage — removing it breaks those. Because isolation is weak, the
// `allow` permissions below are kept to the minimum a maths/3D sim plausibly
// needs: camera, microphone, geolocation and midi are intentionally NOT
// granted (no maths sim needs them, and they are the highest-impact privacy
// grants for untrusted uploaded HTML).

// ─────────────────────────────────────────────────────────────────────────
// TWO SANDBOXES, because the two frames are not the same risk.
//
// PLAN.md task 1.3. The note above says isolation here is weak and why: the
// lesson is a blob: URL made by the parent, so `allow-same-origin` plus
// `allow-scripts` lets lesson code run at the app's own origin — able to read
// the app's storage and call its API with the viewer's cookie.
//
// The two frames earn different answers:
//
//   SOURCE (the teacher's copy)   runs the lesson. That is the whole design:
//   one authoritative instance. It keeps `allow-same-origin` FOR NOW, because
//   the class-pack recorder reads the rendered document directly to sample the
//   lesson's text, build the explainer outline, and see which option was
//   clicked (Room.tsx). Each of those already handles an unreadable document,
//   so nothing breaks without it — the pack simply records less. Closing this
//   properly means feeding those readers from the mirror frame the parent
//   already holds instead of from the live DOM, and that is the rest of F1.
//
//   FOLLOWER (every learner's copy)   runs NOTHING. Scripts are stripped from
//   the shell and every mirrored frame is cleaned before it is painted
//   (mirrorScript.ts). So same-origin buys the follower one thing only:
//   resolveCursorPosition in StudentView.tsx reads the frame to anchor the
//   teacher's cursor to an element — and that already falls back to the
//   sender's viewport fractions when it cannot. A slightly less precise cursor
//   is a small price for an opaque origin on the device where the risk is
//   highest: many machines, most of them children's, and a sanitiser bug there
//   would otherwise reach the app itself.
//
// So the follower gets the isolation now and pays almost nothing for it.
const SANDBOX_COMMON =
  'allow-scripts ' +
  'allow-forms ' +
  'allow-modals ' +
  'allow-popups ' +
  'allow-pointer-lock ' +
  'allow-presentation ' +
  'allow-downloads';

/** The teacher's authoritative copy — the one instance that runs the lesson. */
export const LESSON_IFRAME_SANDBOX = SANDBOX_COMMON + ' allow-same-origin';

/**
 * A learner's copy, and any other frame that only ever displays.
 *
 * No `allow-same-origin`: the document gets an opaque origin, so even if
 * something did run in there it could not touch the app's storage, cookies or
 * API. postMessage still works both ways, which is all the mirror uses.
 */
export const LESSON_IFRAME_SANDBOX_VIEW_ONLY = SANDBOX_COMMON;

export const LESSON_IFRAME_ALLOW =
  'accelerometer; ' +
  'autoplay; ' +
  'fullscreen; ' +
  'gamepad; ' +
  'gyroscope; ' +
  'magnetometer; ' +
  'xr-spatial-tracking';
