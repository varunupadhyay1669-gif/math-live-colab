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
// boot up. Adding more doesn't make the iframe less safe — sandbox is
// the security boundary; `allow` is just a permissions-policy gate.

export const LESSON_IFRAME_SANDBOX =
  'allow-scripts ' +
  'allow-same-origin ' +
  'allow-forms ' +
  'allow-modals ' +
  'allow-popups ' +
  'allow-pointer-lock ' +
  'allow-presentation ' +
  'allow-downloads';

export const LESSON_IFRAME_ALLOW =
  'accelerometer; ' +
  'autoplay; ' +
  'camera; ' +
  'fullscreen; ' +
  'gamepad; ' +
  'geolocation; ' +
  'gyroscope; ' +
  'magnetometer; ' +
  'microphone; ' +
  'midi; ' +
  'xr-spatial-tracking';
