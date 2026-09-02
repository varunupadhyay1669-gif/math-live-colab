// ─────────────────────────────────────────────────────────────────────────
// LIVE MIRROR — "impossible to desync" sync engine.
//
// The input-replay engine (syncScript) re-derives lesson state on EACH side by
// re-running clicks. That is fundamentally leaky: a dropped/reordered/doubled
// event, a reconnect, or a re-seed can drift the two screens apart. Every past
// desync was a leak in that model.
//
// Live Mirror removes the possibility by construction: exactly ONE side runs
// the lesson (the "source" / authoritative instance). Everyone else renders a
// live MIRROR of the source's REAL DOM (+ canvas pixels) and never runs the
// lesson's own JS — so a follower literally cannot be on a different screen
// than the source. A follower's clicks are forwarded to the source, applied on
// the real lesson there, and the resulting DOM streams back to everyone.
//
//   • No journal, no replay, no seed, no determinism assumptions.
//   • Late-join / reconnect = "send me the current DOM" → instantly correct.
//   • Works for arbitrary JS / timers / animations (they run only on the
//     source; followers see the result) and for <canvas>/WebGL via frame capture.
//
// This module is injected as ONE of two modes:
//   source   → into the driver's authoritative lesson iframe (lesson JS intact).
//   follower → into a script-STRIPPED shell (lesson JS removed) that only mirrors.
// The mode placeholder is replaced at blob-build time by mirrorScriptFor().
// ─────────────────────────────────────────────────────────────────────────

export const mirrorScript = `
<script id="mathslive-mirror-script">
(function () {
  var MODE = '__MIRROR_MODE__';
  var isSource = MODE === 'source';

  // ── Stable element path (matches syncScript's algorithm so paths resolve on
  //    both sides — the follower's DOM is a copy of the source's) ──
  function esc(s) {
    try { if (window.CSS && CSS.escape) return CSS.escape(s); } catch (e) {}
    return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\\\$&');
  }
  function getElementPath(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) return '#' + esc(el.id);
    var path = [];
    while (el && el.nodeType === 1) {
      var sel = el.nodeName.toLowerCase();
      if (el.id) { sel += '#' + esc(el.id); path.unshift(sel); break; }
      // nth-OF-TYPE, not nth-child, and the distinction is the whole bug.
      //
      // The two sides do not hold identical DOMs: the follower has the lesson's
      // <script> tags stripped, because running the lesson twice is exactly
      // what the mirror exists to prevent. nth-child counts EVERY element, so
      // removing a script renumbers every sibling after it.
      //
      // A real lesson (a Three.js bus simulation) did this:
      //
      //   teacher body: div, div, div, script, canvas   canvas = nth-child(5)
      //   student body: div, div, div, canvas           canvas = nth-child(4)
      //
      // The teacher sent "body > canvas:nth-child(5)", which on the student
      // addressed nothing at all. The page mirrored perfectly and the 3D scene
      // never appeared. It only bites when an element sits AFTER a <script> in
      // the same parent — which is precisely where a renderer.domElement
      // appended to document.body ends up.
      //
      // nth-of-type counts only siblings of the same tag, so scripts coming and
      // going cannot renumber a canvas. This also fixes the mirror image of the
      // fault: a student's forwarded click carried a path computed on the
      // stripped DOM and was resolved against the teacher's unstripped one.
      var sib = el, nth = 1, tag = el.nodeName;
      while ((sib = sib.previousElementSibling)) { if (sib.nodeName === tag) nth++; }
      sel += ':nth-of-type(' + nth + ')';
      path.unshift(sel);
      el = el.parentNode;
      if (el && el.nodeName === 'BODY') { path.unshift('body'); break; }
    }
    return path.join(' > ');
  }
  function findElement(p) { if (!p) return null; try { return document.querySelector(p); } catch (e) { return null; } }
  function post(msg) { try { window.parent.postMessage(msg, '*'); } catch (e) {} }
  // Cheap deterministic content fingerprint (djb2 + length). Both sides run the
  // SAME function over the SAME signature string, so a mismatch proves the
  // follower's screen differs from the source's — the basis of the self-healing
  // divergence check below. Not cryptographic; length-salted so accidental
  // collisions are vanishingly unlikely for DOM snapshots.
  function hashStr(s) {
    var h = 5381, i = s.length;
    while (i) h = ((h * 33) ^ s.charCodeAt(--i)) >>> 0;
    return h.toString(36) + '-' + s.length.toString(36);
  }

  // ═══════════════════════ SOURCE (authoritative) ═══════════════════════
  if (isSource) {
    var applyingInput = false;   // suppress self-triggered streams while applying forwarded input
    var lastForwardedScrollAt = 0; // when a student last drove our scroll (echo guard)
    var lastSentAt = 0, trailTimer = null, lastMutAt = 0, burstStart = 0;

    // Force preserveDrawingBuffer on every WebGL context the lesson creates.
    // Without it, canvas.toDataURL() on a WebGL canvas returns BLACK on many
    // GPUs/browsers (the drawing buffer is cleared after each composite), which
    // would make 3D/WebGL sims mirror as an empty canvas. This runs before any
    // lesson script (the mirror agent is first in <head>), so it patches the
    // context at creation — Three.js, raw WebGL, and everything in between.
    try {
      var _getCtx = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, attrs) {
        if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') {
          attrs = attrs || {};
          if (attrs.preserveDrawingBuffer !== true) { try { attrs.preserveDrawingBuffer = true; } catch (e) {} }
        }
        return _getCtx.call(this, type, attrs);
      };
    } catch (e) {}

    // Reflect the source's LIVE form values into the follower's copy by writing
    // to the DETACHED CLONE — NEVER the real DOM. Writing setAttribute/textContent
    // on the live <input>/<textarea>/<select> fires a mutation, which re-triggers
    // the MutationObserver, which serializes again → an infinite self-feeding loop
    // that froze the whole tab for ANY lesson with a form field (even a totally
    // static one; the identical-body dedup meant the throttle never engaged). The
    // clone is structurally identical, so the i-th field maps 1:1 in document order.
    function bakeFormStateInto(orig, clone) {
      try {
        var a = orig.querySelectorAll('input, textarea, select');
        var b = clone.querySelectorAll('input, textarea, select');
        for (var i = 0; i < a.length && i < b.length; i++) {
          var o = a[i], c = b[i];
          if (o.tagName === 'INPUT') {
            if (o.type === 'checkbox' || o.type === 'radio') {
              if (o.checked) c.setAttribute('checked', 'checked'); else c.removeAttribute('checked');
            } else { c.setAttribute('value', o.value); }
          } else if (o.tagName === 'TEXTAREA') { c.textContent = o.value; }
          else if (o.tagName === 'SELECT') {
            for (var j = 0; j < o.options.length && j < c.options.length; j++) {
              if (o.options[j].selected) c.options[j].setAttribute('selected', 'selected'); else c.options[j].removeAttribute('selected');
            }
          }
        }
      } catch (e) {}
    }
    function serializeBody() {
      var clone = document.body.cloneNode(true);
      bakeFormStateInto(document.body, clone);
      // The follower must NEVER run lesson JS — strip every script from the copy.
      try { clone.querySelectorAll('script').forEach(function (s) { s.parentNode && s.parentNode.removeChild(s); }); } catch (e) {}
      return clone.innerHTML;
    }
    // <body>'s OWN attributes. body.innerHTML drops them, so a lesson that does
    // document.body.className = 'dark' (theme toggles, state-driven styling)
    // changed nothing on the follower. Tiny payload; sent every snapshot.
    function serializeBodyAttrs() {
      var a = [];
      try {
        var at = document.body.attributes;
        for (var i = 0; i < at.length; i++) a.push([at[i].name, at[i].value]);
      } catch (e) {}
      return JSON.stringify(a);
    }
    // <head> stylesheets. Lessons commonly inject <style> at runtime (animations,
    // themes, computed layout). Those live OUTSIDE body, so they never reached
    // the follower and the mirror rendered with stale CSS. Captured separately
    // and only sent when changed, so the steady-state cost is zero.
    // Read LIVE stylesheet rules rather than element markup. This is the whole
    // trick: sheet.insertRule(), deleteRule(), replace()/replaceSync() and
    // constructed adoptedStyleSheets change a stylesheet's RULES without
    // touching any element's HTML — so the previous outerHTML read could not
    // see them at all, and lessons that inject CSS at runtime (very common for
    // themes, computed layout and animations) were silently mis-styled for
    // students. Reading cssRules reflects every one of those, and because our
    // 500ms heartbeat re-serializes and content-dedups, a CSSOM change is picked
    // up automatically within half a second — no monkey-patching of CSSOM
    // methods required (which is what a delta-based engine would need).
    function serializeHeadStyles() {
      var out = '';
      function dumpSheet(s) {
        var txt = null;
        try {
          if (s.cssRules) {
            txt = '';
            for (var j = 0; j < s.cssRules.length; j++) txt += s.cssRules[j].cssText;
          }
        } catch (e) { txt = null; } // cross-origin sheet → SecurityError on read
        if (txt != null) return '<style>' + txt + '</style>';
        // Unreadable (cross-origin): pass the link through so the follower
        // fetches it itself, exactly as before.
        return s.href ? '<link rel="stylesheet" href="' + s.href + '">' : '';
      }
      try {
        var sheets = document.styleSheets;
        for (var i = 0; i < sheets.length; i++) out += dumpSheet(sheets[i]);
      } catch (e) {}
      try {
        // Constructed stylesheets adopted by the document never appear in
        // document.styleSheets at all.
        var adopted = document.adoptedStyleSheets || [];
        for (var k = 0; k < adopted.length; k++) out += dumpSheet(adopted[k]);
      } catch (e) {}
      return out;
    }
    var lastSentSig = null, lastSentHead = null, lastSentHash = null, oversizeReported = false;
    // Send the CURRENT state — but only if it differs from the last thing we sent
    // (content-dedup). Every send is idempotent + self-correcting: a missed/late/
    // out-of-order snapshot is harmless because the next send always reflects the
    // true current DOM, and identical state is never re-sent.
    function sendSnapshot(force) {
      if (trailTimer) { clearTimeout(trailTimer); trailTimer = null; }
      var body, attrs, head;
      try { body = serializeBody(); attrs = serializeBodyAttrs(); head = serializeHeadStyles(); } catch (e) { return; }
      // The signature covers everything the follower renders, so ANY visual
      // change (body, body attributes, or head CSS) triggers a send.
      var sig = body + ' ' + attrs + ' ' + head;
      if (!force && sig === lastSentSig) return;
      var headChanged = head !== lastSentHead;
      lastSentSig = sig;
      lastSentHead = head;
      lastSentHash = hashStr(sig);
      lastSentAt = Date.now();
      // A snapshot too large for the transport would be dropped in transit and
      // the follower would silently freeze on stale content forever. Report it
      // once so the failure is visible instead of mysterious.
      if (body.length > 3500000 && !oversizeReported) {
        oversizeReported = true;
        post({ type: 'SYNC_MIRROR_OVERSIZE', bytes: body.length });
      }
      // Alongside the frame, never instead of it: the DOM is still what every
      // student renders. This is only for putting the SOURCE back.
      try { publishLessonState(); } catch (e) {}
      try {
        post({
          type: 'SYNC_MIRROR', body: body, attrs: attrs,
          // Only ship head CSS when it actually changed (or on a forced resync,
          // which must be self-contained since the follower may have missed it).
          head: (headChanged || force) ? head : null,
          h: lastSentHash,
          scrollX: window.scrollX || 0, scrollY: window.scrollY || 0,
        });
      } catch (e) {}
    }
    // Adaptive leading-edge throttle. The mirror runs on the SAME main thread as
    // the app UI (a same-origin blob iframe shares the parent's event loop), and
    // serializing the whole <body> on every mutation would starve the teacher's
    // buttons on an ANIMATED lesson (a requestAnimationFrame loop mutating the
    // DOM ~60×/s). So:
    //   • DISCRETE changes (quiz clicks, spaced >120ms apart) still send within
    //     ~60ms — the mirror feels instant, never a step behind.
    //   • A SUSTAINED mutation burst (animation running >350ms) backs off to
    //     ~4/s. That's plenty for a DOM mirror — canvas/3D visuals stream on
    //     their own throttled channel — and it keeps the main thread responsive.
    // MutationObserver already coalesces a synchronous DOM update into one call.
    // ── The lesson's own state ──
    //
    // The mirror can keep every student on the teacher's screen. It cannot keep
    // the teacher's screen alive through a reload: the lesson runs in that tab,
    // and closing it ends the only copy there is. Rebuilding from a DOM snapshot
    // re-runs the lesson's scripts over already-rendered markup, which is how a
    // quiz returns to question 1 with two canvases.
    //
    // No amount of cleverness out here fixes that. The lesson has to say what it
    // is, and a lesson that can say so can be put back exactly:
    //
    //     window.mathslive = {
    //       getState: () => state,
    //       setState: (s) => { state = s; render(); }
    //     };
    //
    // Optional throughout. A lesson without it loses its place on reload, the
    // same as before — but everyone loses it together, and the tutor is warned
    // rather than surprised.
    var lastStateJson = null;
    var MAX_STATE = 64 * 1024;
    function publishLessonState() {
      var api = null;
      try { api = window.mathslive; } catch (e) {}
      if (!api || typeof api.getState !== 'function') return;
      var json;
      try { json = JSON.stringify(api.getState()); } catch (e) { return; }
      if (typeof json !== 'string') return;
      // A lesson keeping its whole question bank in state would otherwise send
      // it on every click. State is for the PLACE, not the content.
      if (json.length > MAX_STATE) return;
      if (json === lastStateJson) return;
      lastStateJson = json;
      post({ type: 'SYNC_MIRROR_STATE', state: json });
    }

    function restoreLessonState(json) {
      var api = null;
      try { api = window.mathslive; } catch (e) {}
      if (!api || typeof api.setState !== 'function') return false;
      try {
        api.setState(JSON.parse(json));
        lastStateJson = json;   // do not immediately republish what we just applied
        return true;
      } catch (e) { return false; }
    }

    function scheduleSnapshot() {
      // A canvas can appear at any time (3D libraries append theirs once loaded,
      // or on a "Start" click). Any DOM change is our cue to check.
      if (!canvasTimer) ensureCanvasTimer();
      if (applyingInput) return;
      var now = Date.now();
      if (now - lastMutAt < 120) { if (!burstStart) burstStart = now; } else { burstStart = 0; }
      lastMutAt = now;
      var minInterval = (burstStart && now - burstStart > 350) ? 250 : 60;
      var wait = minInterval - (now - lastSentAt);
      if (wait <= 0) { sendSnapshot(); }
      else if (!trailTimer) { trailTimer = setTimeout(sendSnapshot, wait); }
    }

    // Canvas pixel channel (3D / WebGL). Skip fixed-position overlays (decorative
    // confetti etc.) and tiny/blank canvases. Throttled independent of the DOM stream.
    var taintReported = false;
    function captureCanvases() {
      var out = [];
      try {
        var cs = document.querySelectorAll('canvas');
        // Only treat position:fixed canvases as skippable decoration when there
        // is ALSO a normal-flow canvas to prefer (the confetti-overlay case).
        // A 3D sim whose only canvas is fixed — which full-screen WebGL
        // renderers do routinely — was previously skipped entirely, so the
        // student saw nothing at all.
        var hasNonFixed = false;
        for (var p = 0; p < cs.length; p++) {
          try {
            var s0 = window.getComputedStyle(cs[p]);
            if ((!s0 || s0.position !== 'fixed') && cs[p].width >= 4 && cs[p].height >= 4) { hasNonFixed = true; break; }
          } catch (e0) {}
        }
        for (var i = 0; i < cs.length && out.length < 4; i++) {
          var c = cs[i];
          try {
            var st = window.getComputedStyle(c);
            if (hasNonFixed && st && st.position === 'fixed') continue;
            if (!c.width || !c.height || c.width < 4 || c.height < 4) continue;
            // WebP at q0.6 measured ~3.5x smaller than PNG on real lesson
            // canvases with no visible quality loss at these sizes. A browser
            // that doesn't support WebP silently returns PNG from toDataURL,
            // so this is safe to request unconditionally.
            out.push({ sel: getElementPath(c), idx: i, w: c.width, h: c.height, data: c.toDataURL('image/webp', 0.6) });
          } catch (e) {
            // A canvas that has drawn a cross-origin image is "tainted":
            // toDataURL throws SecurityError forever. Previously swallowed, so
            // the student just saw a permanently blank canvas with no clue why.
            // Report once so the teacher learns the real cause (and the fix:
            // serve the image with CORS headers, or set crossOrigin on it).
            if (!taintReported && e && String(e.name) === 'SecurityError') {
              taintReported = true;
              post({ type: 'SYNC_MIRROR_TAINTED' });
            }
          }
        }
      } catch (e) {}
      return out;
    }
    var canvasTimer = null, hadCanvas = false;
    // Last frame sent per canvas, so an UNCHANGED canvas is not re-sent.
    //
    // This tick runs every 120ms — about 8 times a second — and used to post
    // every canvas every time, changed or not. The whiteboard is a canvas, and
    // so is any Three.js or animated lesson, which meant a completely static
    // board still streamed ~8 full WebP images per second to every student for
    // the whole lesson. At tens of KB per image (plus 33% for base64) that is
    // 150–350 KB/s per student, or roughly 400MB–1GB per lesson-hour. It was
    // the dominant share of a 3.93 GB WebSocket bill.
    //
    // The DOM path beside it has always been content-deduped; the pixel path
    // simply never got the same treatment. Comparing the encoded string is
    // exact — identical pixels encode identically — and costs one string
    // compare against a network send.
    //
    // Keyed by selector rather than array position: canvases can be added or
    // removed mid-lesson, and an index-based cache would silently compare one
    // canvas against another and either send needlessly or, worse, skip a real
    // change. Cleared on resync so a student asking for a fresh copy always
    // gets whole frames back rather than being told nothing changed.
    var lastCanvasData = Object.create(null);
    // Periodic keyframe. Dedup means a STILL canvas is sent once; if that one
    // frame is lost — dropped in transit, or arriving before the DOM snapshot
    // that carries the canvas element — the student is left with an empty box
    // and nothing ever corrects it. The follower asks for a resync when it
    // notices, but it cannot notice a frame that never arrived at all.
    //
    // So: every 40 ticks (~5s) send whole frames regardless. For a still scene
    // that is 0.2 frames/sec against the 8/sec this replaced — the bandwidth
    // win is kept almost entirely — and it makes a lost frame self-correcting
    // rather than permanent.
    var KEYFRAME_EVERY = 40;
    var canvasTicks = 0;
    function canvasTick(force) {
      var cv = captureCanvases();
      if (!cv.length) return;
      hadCanvas = true;
      var keyframe = force || (++canvasTicks % KEYFRAME_EVERY === 0);
      var changed = [];
      for (var i = 0; i < cv.length; i++) {
        var c = cv[i];
        if (keyframe || lastCanvasData[c.sel] !== c.data) {
          lastCanvasData[c.sel] = c.data;
          changed.push(c);
        }
      }
      // Nothing moved — say nothing. This is the whole saving.
      if (!changed.length) return;
      post({ type: 'SYNC_MIRROR_CANVAS', canvases: changed });
    }
    // Start the pixel channel the moment a canvas EXISTS — not only at two
    // fixed moments during boot. A 3D lesson typically creates its canvas
    // dynamically (Three.js appends renderer.domElement once the library has
    // loaded, often asynchronously), so at both old checkpoints there was no
    // canvas yet, the interval never started, and the student never received a
    // single frame — the sim simply never appeared. Called from boot, from
    // window load, AND from every DOM mutation, so a canvas created at any
    // point (including after a "Start" button) begins streaming immediately.
    function ensureCanvasTimer() {
      if (canvasTimer) return;
      try { if (!document.querySelector('canvas')) return; } catch (e) { return; }
      canvasTick(); // paint at once rather than waiting a full interval
      canvasTimer = setInterval(canvasTick, 120);
    }

    // Apply a follower's forwarded input onto the REAL lesson, then re-stream.
    // Turn the follower's fractions back into a real point on OUR layout.
    // Falls back to the element's centre, which is right for a button and the
    // best available guess for anything that sent no coordinates.
    function pointOn(el, d) {
      var r;
      try { r = el.getBoundingClientRect(); } catch (e) { r = null; }
      if (!r) return { x: 0, y: 0 };
      var fx = (typeof d.fx === 'number' && isFinite(d.fx)) ? d.fx : 0.5;
      var fy = (typeof d.fy === 'number' && isFinite(d.fy)) ? d.fy : 0.5;
      return { x: r.left + fx * r.width, y: r.top + fy * r.height };
    }

    // Every gesture a browser makes is a pointer event AND a mouse event, and
    // libraries pick one: OrbitControls r128+ listens only for pointer events,
    // older and simpler sims only for mouse. Sending both, pointer first (native
    // ordering), is what makes a forwarded gesture indistinguishable from a hand.
    function dispatchPointerPair(el, type, mouseType, pt, opts) {
      var base = {
        bubbles: true, cancelable: true, view: window, composed: true,
        clientX: pt.x, clientY: pt.y, screenX: pt.x, screenY: pt.y,
        button: 0, buttons: opts && opts.buttons != null ? opts.buttons : 1,
      };
      try {
        var pe = {};
        for (var k in base) pe[k] = base[k];
        pe.pointerId = 1;
        pe.pointerType = (opts && opts.pointerType) || 'mouse';
        pe.isPrimary = true;
        el.dispatchEvent(new PointerEvent(type, pe));
      } catch (e) { /* no PointerEvent here — the mouse event below still lands */ }
      try { el.dispatchEvent(new MouseEvent(mouseType, base)); } catch (e) {}
    }

    // The element a forwarded drag is anchored to, so moves and the release go
    // where the press did even after the pointer has left it.
    var forwardedDragEl = null;

    function applyForwardedInput(d) {
      applyingInput = true;
      // A forwarded tap is a REMOTE action, not a local one. The legacy replay
      // engine shares this document and cancels local input at capture phase
      // whenever this iframe is in a blocked state — which is exactly what
      // handing a student control does. Without this the student's taps were
      // swallowed before the lesson's own handler ever ran, and "you have
      // control" meant nothing worked. Optional: absent, we just dispatch.
      var guard = null;
      try { guard = window.__mathsliveRemote || null; } catch (e) {}
      if (guard && guard.enter) { try { guard.enter(); } catch (e) {} }
      try {
        if (d.kind === 'scroll') { lastForwardedScrollAt = Date.now(); window.scrollTo(d.scrollX || 0, d.scrollY || 0); }
        else if (d.kind === 'pointermove' || d.kind === 'pointerup') {
          // Anchored to where the press landed — see forwardedDragEl.
          var anchor = forwardedDragEl || (d.path ? findElement(d.path) : null);
          if (anchor) {
            var mp = pointOn(anchor, d);
            if (d.kind === 'pointermove') {
              dispatchPointerPair(anchor, 'pointermove', 'mousemove', mp, { pointerType: d.pointerType, buttons: 1 });
            } else {
              dispatchPointerPair(anchor, 'pointerup', 'mouseup', mp, { pointerType: d.pointerType, buttons: 0 });
              forwardedDragEl = null;
            }
          }
        }
        else {
          var el = d.path ? findElement(d.path) : null;
          if (el) {
            var pt = pointOn(el, d);
            if (d.kind === 'click') {
              // With coordinates, so a lesson that reads clientX/clientY — a
              // number line, a graph, "tap where it lands" — gets the point the
              // student actually touched. el.click() carries none, which is why
              // those taps used to land in the wrong place.
              dispatchPointerPair(el, 'pointerdown', 'mousedown', pt, { pointerType: d.pointerType, buttons: 1 });
              dispatchPointerPair(el, 'pointerup', 'mouseup', pt, { pointerType: d.pointerType, buttons: 0 });
              try { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, composed: true, clientX: pt.x, clientY: pt.y, button: 0 })); }
              catch (e) { if (el.click) el.click(); }
            }
            else if (d.kind === 'input') {
              try { el.value = d.value; } catch (e) {}
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }
            else if (d.kind === 'pointerdown') {
              forwardedDragEl = el;
              dispatchPointerPair(el, 'pointerdown', 'mousedown', pt, { pointerType: d.pointerType, buttons: 1 });
            }
            else if (d.kind === 'wheel') { el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, view: window, deltaY: d.deltaY || 0, clientX: pt.x, clientY: pt.y })); }
            else if (d.kind === 'key') { document.dispatchEvent(new KeyboardEvent('keydown', { key: d.key, bubbles: true })); }
            else if (d.kind === 'keyup') { document.dispatchEvent(new KeyboardEvent('keyup', { key: d.key, bubbles: true })); }
          }
        }
      } catch (e) {}
      if (guard && guard.exit) { try { guard.exit(); } catch (e) {} }
      applyingInput = false;
      scheduleSnapshot();
    }

    // ── The five things the mirror does not get for free ──
    //
    // Everything else the source needs it already has: the DOM is the state, and
    // the DOM is already streaming. These five are not derivable from a frame,
    // and they were the only reason the old replay engine still had to be loaded
    // into this iframe alongside the mirror.

    // 1. The teacher's cursor. A frame has no pointer in it.
    //    Anchored to the element under it rather than to a screen percentage: a
    //    percentage lands an option or two off whenever the two layouts differ,
    //    which for a centred fixed-width lesson is always.
    var lastCursorAt = 0;
    function trackCursor(e) {
      var now = Date.now();
      if (now - lastCursorAt < 50) return;
      lastCursorAt = now;
      var cpath = null, cex = 0.5, cey = 0.5;
      try {
        var t = e.target;
        if (t && t !== document && t !== document.body && t !== document.documentElement) {
          cpath = getElementPath(t);
          var r = t.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            cex = (e.clientX - r.left) / r.width;
            cey = (e.clientY - r.top) / r.height;
          }
        }
      } catch (err) {}
      post({ type: 'SYNC_CURSOR', x: e.clientX / window.innerWidth, y: e.clientY / window.innerHeight, path: cpath, ex: cex, ey: cey });
    }

    // 2. Alt+click "look here". Capture phase and stopped immediately, because
    //    pointing AT a button must not also press it.
    function pingAt(x, y) {
      try {
        var ping = document.createElement('div');
        ping.setAttribute('data-mathslive-ping', '1');
        ping.style.cssText = 'position:fixed;left:' + (x - 22) + 'px;top:' + (y - 22) + 'px;width:44px;height:44px;border-radius:50%;border:3px solid #F43F5E;background:rgba(244,63,94,0.18);pointer-events:none;z-index:2147483647;animation:mathslive-ping-pop 1.2s ease-out forwards;';
        if (!document.getElementById('mathslive-ping-style')) {
          var st = document.createElement('style');
          st.id = 'mathslive-ping-style';
          st.textContent = '@keyframes mathslive-ping-pop{0%{transform:scale(0.4);opacity:1}70%{transform:scale(1.6);opacity:0.7}100%{transform:scale(2.4);opacity:0}}';
          (document.head || document.documentElement).appendChild(st);
        }
        (document.body || document.documentElement).appendChild(ping);
        setTimeout(function () { ping.parentNode && ping.parentNode.removeChild(ping); }, 1300);
      } catch (e) {}
    }

    // 3. A lesson that failed to load. A CDN script blocked by the school's
    //    network, WebGL unavailable, a crash mid-boot — without this the tutor
    //    gets silence and a blank area, with no way to tell which.
    var simErrCount = 0, simErrSeen = {};
    function reportSimError(msg, src) {
      try {
        if (simErrCount >= 3) return;
        var key = String(msg).slice(0, 120);
        if (simErrSeen[key]) return;
        simErrSeen[key] = 1;
        simErrCount++;
        post({ type: 'SYNC_SIM_ERROR', message: key, source: src || '' });
      } catch (e) {}
    }

    // Registered HERE, not in activate(), and the difference is the whole point
    // of the feature. activate() waits for DOMContentLoaded; a <script src>
    // blocked by a school's network fails while the document is still being
    // parsed, which is BEFORE that. Listening late meant the one error most
    // worth reporting — the CDN a lesson depends on being unreachable on the
    // student's network — was the one error never reported. The mirror agent is
    // first in <head>, so from this line on nothing is missed.
    window.addEventListener('error', function (e) {
      try {
        var t = e && e.target;
        if (t && t.tagName === 'IMG') return;   // noisy and rarely fatal
        if (t && (t.tagName === 'SCRIPT' || t.tagName === 'LINK')) {
          reportSimError('Could not load ' + (t.src || t.href || 'a file'), t.src || t.href || '');
          return;
        }
        if (e && e.message) reportSimError(e.message, e.filename || '');
      } catch (err) {}
    }, true);
    window.addEventListener('unhandledrejection', function (e) {
      try {
        var r = e && e.reason;
        var m = r && (r.message || (typeof r === 'string' ? r : ''));
        if (m) reportSimError('Unhandled rejection: ' + m, '');
      } catch (err) {}
    });

    // 4. A snapshot of the whole document, on request. Two callers left — Force
    //    Sync's re-baseline and the class pack — and both ask explicitly.
    //    The injected scripts are stripped from the copy: leaving one in means
    //    the next build injects another on top of it, and after N force-syncs
    //    the lesson carries N observers.
    function provideHtml(requestId) {
      try {
        var clone = document.documentElement.cloneNode(true);
        try {
          var injected = clone.querySelectorAll('#mathslive-sync-script, #mathslive-steplock-script, #mathslive-mirror-script');
          for (var i = 0; i < injected.length; i++) injected[i].parentNode && injected[i].parentNode.removeChild(injected[i]);
        } catch (e) {}
        // Live form values live in properties, not attributes, so they have to
        // be written onto the clone or the snapshot loses everything typed.
        try {
          var a = document.querySelectorAll('input, textarea, select');
          var b = clone.querySelectorAll('input, textarea, select');
          for (var k = 0; k < a.length && k < b.length; k++) {
            var o = a[k], c = b[k];
            if (o.tagName === 'INPUT') {
              if (o.type === 'checkbox' || o.type === 'radio') {
                if (o.checked) c.setAttribute('checked', 'checked'); else c.removeAttribute('checked');
              } else { c.setAttribute('value', o.value); }
            } else if (o.tagName === 'TEXTAREA') { c.textContent = o.value; }
            else if (o.tagName === 'SELECT') {
              for (var j = 0; j < o.options.length && j < c.options.length; j++) {
                if (o.options[j].selected) c.options[j].setAttribute('selected', 'selected'); else c.options[j].removeAttribute('selected');
              }
            }
          }
        } catch (e) {}
        post({
          type: 'SYNC_PROVIDE_HTML', requestId: requestId,
          html: '<!DOCTYPE html>' + String.fromCharCode(10) + clone.outerHTML,
          scrollX: window.scrollX, scrollY: window.scrollY,
          hasCanvas: !!document.querySelector('canvas'),
        });
      } catch (e) {}
    }

    // 5. Scroll to where a student clicked, when the teacher is following them.
    function followClick(nx, ny) {
      try {
        var x = (typeof nx === 'number' ? nx : 0.5) * window.innerWidth;
        var y = (typeof ny === 'number' ? ny : 0.5) * window.innerHeight;
        var el = document.elementFromPoint(x, y);
        if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      } catch (e) {}
    }

    function activate() {
      try {
        new MutationObserver(scheduleSnapshot).observe(document.documentElement || document.body, { subtree: true, childList: true, attributes: true, characterData: true });
      } catch (e) {}
      // The source's OWN scroll should mirror too.
      // Don't bounce a student-driven scroll straight back at them: scrollTo
      // fires this listener a frame LATER, by which time applyingInput has
      // already been cleared, so a flag alone isn't enough — hold it briefly.
      window.addEventListener('scroll', function () {
        if (applyingInput || Date.now() - lastForwardedScrollAt < 250) return;
        post({ type: 'SYNC_MIRROR_SCROLL', scrollX: window.scrollX || 0, scrollY: window.scrollY || 0 });
      }, { passive: true });

      document.addEventListener('mousemove', trackCursor, { passive: true });
      document.addEventListener('click', function (e) {
        if (!e.altKey || !e.isTrusted || applyingInput) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        pingAt(e.clientX, e.clientY);
        post({ type: 'SYNC_PING', clientX: e.clientX / window.innerWidth, clientY: e.clientY / window.innerHeight, path: getElementPath(e.target) });
      }, true);

      // Announce whether this lesson can be restored, once it has had a moment
      // to define the hook (lessons set it up inside their own init).
      setTimeout(function () { post({ type: 'SYNC_MIRROR_STATEFUL', supported: !!(window.mathslive && typeof window.mathslive.getState === 'function' && typeof window.mathslive.setState === 'function') }); }, 800);
      setTimeout(function () { sendSnapshot(true); ensureCanvasTimer(); }, 40);
      window.addEventListener('load', function () { setTimeout(function () { sendSnapshot(true); ensureCanvasTimer(); }, 120); });
      // Self-correcting heartbeat: re-check the DOM every 500ms and re-send ONLY
      // if it changed since the last send (content-deduped). Cost is ~0 when
      // idle; guarantees any missed/late mutation-snapshot converges within 500ms
      // so the mirror can never get permanently stuck one step behind.
      setInterval(function () { if (!applyingInput) sendSnapshot(); }, 500);
      // ── DIVERGENCE PING (closes the last structural desync hole) ──
      // Content-dedup means a snapshot LOST IN TRANSIT (socket hiccup, reconnect,
      // relay drop) is never retried: the source believes the follower already
      // has that state and stays silent until the DOM next changes. On a static
      // screen — a quiz question sitting there — the follower would show stale
      // content indefinitely. So every 2s we broadcast just the fingerprint of
      // what we last sent (a few bytes). A follower whose rendering doesn't match
      // asks for a full resync. Cost is negligible; the guarantee is absolute.
      setInterval(function () {
        if (lastSentHash) post({ type: 'SYNC_MIRROR_PING', h: lastSentHash });
      }, 2000);
    }

    window.addEventListener('message', function (e) {
      var d = e.data; if (!d || !d.type) return;
      if (d.type === 'MIRROR_INPUT') applyForwardedInput(d);
      // Zoom, applied to BODY rather than documentElement.
      //
      // The old engine zoomed documentElement, which the mirror never sees: it
      // serializes the body's attributes and contents, and documentElement is
      // neither. So the teacher zoomed to 150%, said "look at the top-right
      // corner", and every student was still at 100% looking at something else.
      //
      // On the body it needs no new channel at all — style IS a body attribute,
      // so it rides the existing snapshot and every follower applies it with the
      // rest. One line here, and the fix is structural rather than another
      // message type to keep in step.
      else if (d.type === 'MIRROR_ZOOM') {
        try {
          var z = Number(d.zoom) || 1;
          var b = document.body;
          if ('zoom' in b.style) { b.style.zoom = z === 1 ? '' : String(z); }
          else {
            // Firefox has no CSS zoom.
            b.style.transformOrigin = '0 0';
            b.style.transform = z === 1 ? '' : 'scale(' + z + ')';
            b.style.width = z === 1 ? '' : (100 / z) + '%';
          }
        } catch (e) {}
      }
      // Late-join / reconnect / "Force sync" → force a full snapshot AND a full
      // set of canvas frames. The pixel channel only sends what changed, so a
      // student arriving mid-lesson in front of a canvas that happens to be
      // still would otherwise receive nothing at all and sit on a blank frame
      // until something moved. force=true bypasses the dedup for exactly this.
      else if (d.type === 'MIRROR_REQUEST') { sendSnapshot(true); canvasTick(true); }
      // Put this lesson back where the class was. Sent once, after a reload,
      // and only when the room's stored state belongs to THIS lesson.
      else if (d.type === 'MIRROR_RESTORE_STATE' && typeof d.state === 'string') {
        var ok = restoreLessonState(d.state);
        post({ type: 'SYNC_MIRROR_RESTORED', ok: ok });
        if (ok) { sendSnapshot(true); canvasTick(true); }
      }
      // Does this lesson implement the contract at all? The tutor is told when
      // it does not, because then a reload really does restart the class.
      else if (d.type === 'REQUEST_HTML') provideHtml(d.requestId);
      else if (d.type === 'FOLLOW_CLICK') followClick(d.x, d.y);
      else if (d.type === 'MIRROR_QUERY_STATEFUL') {
        var has = false;
        try { has = !!(window.mathslive && typeof window.mathslive.getState === 'function' && typeof window.mathslive.setState === 'function'); } catch (e) {}
        post({ type: 'SYNC_MIRROR_STATEFUL', supported: has });
      }
      else if (d.type === 'SET_MIRROR_ROLE' && d.role !== 'source') { /* role flip handled by parent via rebuild */ }
    });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', activate); else activate();
    post({ type: 'MIRROR_SOURCE_READY' });
    return;
  }

  // ═══════════════════════ FOLLOWER (dumb mirror) ═══════════════════════
  var applyingDom = false, lastBody = null, allow = false, lastCanvasList = null;
  var lastAttrs = null, lastHead = null, appliedHash = null, staleTicks = 0;

  // Re-apply <body>'s own attributes (class/style/data-*). Without this a lesson
  // that toggles a body class rendered unstyled on the follower.
  function applyBodyAttrs(json) {
    if (json == null || json === lastAttrs) return;
    lastAttrs = json;
    try {
      var want = JSON.parse(json), seen = {};
      for (var i = 0; i < want.length; i++) {
        var an = String(want[i][0] || '');
        // <body onclick=...> arrives down this channel too, and it is the same
        // hole as an inline handler anywhere else in the frame. The body's own
        // attributes were the one path into this document that the frame
        // cleaning did not cover.
        if (an.toLowerCase().indexOf('on') === 0) continue;
        document.body.setAttribute(an, want[i][1]); seen[an] = 1;
      }
      var have = document.body.attributes;
      for (var j = have.length - 1; j >= 0; j--) { if (!seen[have[j].name]) document.body.removeAttribute(have[j].name); }
    } catch (e) {}
  }
  // ─────────────────── SANITISE WHAT WE PAINT ───────────────────
  //
  // A mirrored frame is the teacher's live DOM, serialised. That DOM came from
  // a lesson file a teacher uploaded, and until this existed the follower took
  // it entirely on trust. The parent strips <script> tags out of the SHELL with
  // a regular expression, but the frames that arrive afterwards were written
  // straight into this document — and an inline handler needs no <script> tag
  // at all. <img src=x onerror=...> is the whole attack, and because this
  // document currently shares an origin with the app, whatever ran here could
  // read the app's storage and call its API with the viewer's own cookie.
  //
  // The viewer is usually a child on an iPad. So every frame is parsed inert
  // first — a <template> does not run what it holds — then walked and cleaned
  // before a single node is adopted into the page.
  //
  // What is removed is chosen to be invisible to an honest lesson:
  //
  //   script, object, embed   execute. Never legitimate in a mirrored frame:
  //                           the lesson runs once, on the teacher's machine.
  //   iframe, frame(set)      a whole second document, which would load
  //                           separately on every device and diverge. The
  //                           lesson contract already forbids it and
  //                           lessonCheck already warns about it.
  //   base                    rewrites every relative URL on the page.
  //   meta http-equiv         can send the frame somewhere else entirely.
  //   on* attributes          the actual hole. Removed everywhere, always.
  //   javascript:/vbscript:/data:text/html URLs, and srcdoc.
  //
  // Deliberately KEPT, because a worksheet where the student types an answer
  // and is marked instantly is a first-class lesson type here: <form>, <input>,
  // <button>, <label>, <select> and their values. Only their URL attributes are
  // inspected. <style> and <link rel=stylesheet> stay too — a mirrored lesson
  // that lost its styling would be a mirrored lesson nobody could read.
  var DROP_TAGS = { script: 1, object: 1, embed: 1, iframe: 1, base: 1, frame: 1, frameset: 1 };
  var URL_ATTRS = { href: 1, src: 1, action: 1, formaction: 1, data: 1, poster: 1, 'xlink:href': 1 };
  function looksExecutable(value) {
    // Whitespace and control characters go first: "java\tscript:alert(1)" and
    // " javascript:alert(1)" are the same URL to a browser, so they have to be
    // the same URL to this.
    // Written as an explicit scan rather than a regular expression on purpose:
    // this whole script lives inside a template literal in a .ts file, so a
    // backslash escape here is read once by TypeScript before the browser ever
    // sees it, and a character class of control codes is exactly the thing that
    // arrives mangled. A loop cannot be mis-escaped.
    var s = String(value == null ? '' : value);
    var v = '';
    for (var n = 0; n < s.length; n++) {
      var c = s.charCodeAt(n);
      if (c > 32 && c !== 160) v += s.charAt(n);   // drop control chars, space, NBSP
    }
    v = v.toLowerCase();
    return v.indexOf('javascript:') === 0 || v.indexOf('vbscript:') === 0 || v.indexOf('data:text/html') === 0;
  }
  /** Clean a parsed tree in place. Returns false only if it could not be done. */
  function sanitizeInto(root) {
    try {
      if (!root) return true;
      var doomed = [];
      // Collected and removed AFTER the walk: removing a node mid-walk moves
      // the walker's own cursor and silently skips its siblings — which is how
      // a sanitiser ends up leaving every second script in place.
      var walker = document.createTreeWalker(root, 1 /* SHOW_ELEMENT */, null);
      var el = walker.nextNode();
      while (el) {
        var tag = (el.tagName || '').toLowerCase();
        if (DROP_TAGS[tag] || (tag === 'meta' && el.hasAttribute && el.hasAttribute('http-equiv'))) {
          doomed.push(el);
        } else if (el.attributes) {
          for (var i = el.attributes.length - 1; i >= 0; i--) {
            var raw = el.attributes[i].name;
            var name = (raw || '').toLowerCase();
            if (name.indexOf('on') === 0 || name === 'srcdoc') { el.removeAttribute(raw); continue; }
            if (URL_ATTRS[name] && looksExecutable(el.attributes[i].value)) el.removeAttribute(raw);
          }
        }
        el = walker.nextNode();
      }
      for (var k = 0; k < doomed.length; k++) {
        try { doomed[k].parentNode.removeChild(doomed[k]); } catch (e) {}
      }
      return true;
    } catch (e) {
      // A frame that cannot be cleaned is a frame that is not painted. One
      // dropped frame costs a moment of staleness, which the fingerprint
      // heartbeat already repairs a few seconds later. Painting an uncleaned
      // one costs the viewer their session.
      return false;
    }
  }
  /** Parse a string of HTML without running any of it, and clean it. */
  function inertFragment(html) {
    var tpl = document.createElement('template');
    tpl.innerHTML = html;
    return sanitizeInto(tpl.content) ? tpl.content : null;
  }

  // "Show me what this student is actually looking at."
  //
  // The teacher's peek button has never worked. The chain is: teacher clicks →
  // server → student's page posts REQUEST_HTML into this frame → and nothing
  // answered, because the only handler for it lives in the SOURCE branch above,
  // which a follower never reaches. So the panel said "Asking … for a snapshot"
  // and sat there for ever. It went unnoticed because under the mirror the
  // student's screen is the teacher's screen by construction — until it is not,
  // which is the one time anybody presses this button.
  //
  // What the follower sends back is its own rendered document, which IS the
  // answer to the question being asked. Typed values are written onto the clone
  // because they live in properties, not attributes — a peek that showed a
  // worksheet with every box empty would be worse than none. The teacher's side
  // renders it in a frame with sandbox="" (StudentScreenPanel), so it is inert.
  function provideFollowerHtml(requestId) {
    try {
      var clone = document.documentElement.cloneNode(true);
      try {
        var drop = clone.querySelectorAll('#mathslive-mirror-script, #mathslive-mirror-head');
        for (var i = 0; i < drop.length; i++) {
          if (drop[i].parentNode) drop[i].parentNode.removeChild(drop[i]);
        }
      } catch (e) {}
      try {
        var live = document.querySelectorAll('input, textarea, select');
        var copy = clone.querySelectorAll('input, textarea, select');
        for (var k = 0; k < live.length && k < copy.length; k++) {
          var o = live[k], c = copy[k];
          if (o.tagName === 'INPUT') {
            if (o.type === 'checkbox' || o.type === 'radio') {
              if (o.checked) c.setAttribute('checked', 'checked'); else c.removeAttribute('checked');
            } else { c.setAttribute('value', o.value); }
          } else if (o.tagName === 'TEXTAREA') { c.textContent = o.value; }
          else if (o.tagName === 'SELECT') {
            for (var j = 0; j < o.options.length && j < c.options.length; j++) {
              if (o.options[j].selected) c.options[j].setAttribute('selected', 'selected');
              else c.options[j].removeAttribute('selected');
            }
          }
        }
      } catch (e) {}
      post({
        type: 'SYNC_PROVIDE_HTML', requestId: requestId,
        html: '<!DOCTYPE html>' + String.fromCharCode(10) + clone.outerHTML,
        scrollX: window.pageXOffset || 0, scrollY: window.pageYOffset || 0,
        hasCanvas: !!document.querySelector('canvas'),
      });
    } catch (e) {}
  }

  // Mirror runtime-injected <head> CSS into a dedicated container so dynamically
  // styled lessons look identical. Kept in its own element so we never touch the
  // follower agent's own script/styles.
  function applyHead(html) {
    if (html == null || html === lastHead) return;
    lastHead = html;
    try {
      var host = document.getElementById('mathslive-mirror-head');
      if (!host) {
        host = document.createElement('div');
        host.id = 'mathslive-mirror-head';
        host.style.display = 'none';
        (document.head || document.documentElement).appendChild(host);
      }
      // Was host.innerHTML = html. The head envelope is the same untrusted
      // stream as the body, and a <script> here would have run exactly as
      // readily.
      var frag = inertFragment(html);
      if (!frag) return;
      while (host.firstChild) host.removeChild(host.firstChild);
      host.appendChild(document.importNode(frag, true));
    } catch (e) {}
  }

  // ─────────────────── DOM MORPHING (fidelity core) ───────────────────
  // Replacing document.body.innerHTML destroys and re-creates EVERY element on
  // every frame. A freshly-created element restarts its CSS animation at t=0,
  // so at our frame rate animations never advanced past their first frame; the
  // same churn blanked <canvas>, reset <video>/<audio>, dropped focus and the
  // caret, and reset every inner scroller — all of which we were papering over
  // with save/restore hacks.
  //
  // Morphing instead PATCHES the existing tree in place: nodes that didn't
  // change are never touched, so animations, pixels, media playback, focus and
  // scroll all simply continue. Matching is by position + nodeName + id, so an
  // id change forces a clean replace rather than a wrong in-place morph.
  // Any exception falls back to the old wholesale swap — worst case we're
  // exactly as correct as before, never less.
  function sameNodeType(a, b) {
    if (a.nodeType !== b.nodeType) return false;
    if (a.nodeType !== 1) return true; // text / comment
    if (a.nodeName !== b.nodeName) return false;
    return (a.id || '') === (b.id || '');
  }
  function syncAttrs(from, to) {
    var ta = to.attributes, i, name, value;
    for (i = 0; i < ta.length; i++) {
      name = ta[i].name; value = ta[i].value;
      // Only write when different: setting width/height on a <canvas> CLEARS
      // it, and rewriting an identical attribute would flush styles for nothing.
      if (from.getAttribute(name) !== value) { try { from.setAttribute(name, value); } catch (e) {} }
    }
    var fa = from.attributes;
    for (i = fa.length - 1; i >= 0; i--) {
      name = fa[i].name;
      if (!to.hasAttribute(name)) { try { from.removeAttribute(name); } catch (e) {} }
    }
  }
  function syncFormValue(from, to) {
    // Never fight a student who is actively typing into this field.
    if (document.activeElement === from) return;
    try {
      if (from.tagName === 'SELECT') {
        morphChildren(from, to);
        var opts = to.querySelectorAll('option');
        for (var i = 0; i < opts.length && i < from.options.length; i++) from.options[i].selected = opts[i].hasAttribute('selected');
        return;
      }
      if (from.type === 'checkbox' || from.type === 'radio') {
        var want = to.hasAttribute('checked');
        if (from.checked !== want) from.checked = want;
        return;
      }
      if (from.tagName === 'TEXTAREA') {
        var tv = to.textContent || '';
        if (from.value !== tv) from.value = tv;
        return;
      }
      var v = to.getAttribute('value');
      if (v != null && from.value !== v) from.value = v;
    } catch (e) {}
  }
  function morphNode(from, to) {
    if (from.nodeType === 3 || from.nodeType === 8) {
      if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue;
      return;
    }
    if (from.nodeType !== 1) return;
    syncAttrs(from, to);
    var tag = from.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') { syncFormValue(from, to); return; }
    // A <canvas>'s content is pixels, not markup — its children are only
    // fallback text. Leave it entirely alone so the painted frame survives.
    if (tag === 'CANVAS') return;
    morphChildren(from, to);
  }
  function morphChildren(fromParent, toParent) {
    // ID-KEYED matching. Matching purely by POSITION looks fine until the
    // teacher inserts or removes anything: every later sibling shifts by one,
    // each gets "morphed" into its neighbour's content, and in practice the
    // whole tail is destroyed and rebuilt — which silently threw away exactly
    // what morphing exists to protect (running animations, canvas pixels,
    // focus/caret, media). Keying on id first means an insert or a reorder
    // moves the EXISTING node into place instead of rebuilding everything
    // after it. Nodes without an id still fall back to positional matching,
    // which is no worse than before.
    var fromById = null, n;
    for (n = fromParent.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 1 && n.id) { if (!fromById) fromById = {}; fromById['#' + n.id] = n; }
    }
    var cursor = fromParent.firstChild;
    for (var t = toParent.firstChild; t; t = t.nextSibling) {
      var key = (t.nodeType === 1 && t.id) ? '#' + t.id : null;
      var match = (key && fromById) ? fromById[key] : null;
      if (match) {
        // Reuse the existing node, moving it into position if needed. The node
        // itself survives, so everything living on it survives with it.
        if (match !== cursor) fromParent.insertBefore(match, cursor);
        else cursor = cursor.nextSibling;
        morphNode(match, t);
        continue;
      }
      // No id to match on: use the node at the cursor if it's compatible — but
      // never consume an id'd node positionally, since a later incoming node
      // may still claim it by id.
      if (cursor && sameNodeType(cursor, t) && !(cursor.nodeType === 1 && cursor.id)) {
        var next = cursor.nextSibling;
        morphNode(cursor, t);
        cursor = next;
        continue;
      }
      fromParent.insertBefore(document.importNode(t, true), cursor);
    }
    // Anything from the cursor onward was not claimed — it's gone upstream.
    while (cursor) {
      var nx = cursor.nextSibling;
      try { fromParent.removeChild(cursor); } catch (e) {}
      cursor = nx;
    }
  }
  // Returns true if the body was patched in place, false if we had to fall back.
  function applyBodyHtml(html) {
    var frag = null;
    try {
      frag = inertFragment(html);
      if (!frag) return false;            // could not be cleaned: do not paint it
      morphChildren(document.body, frag);
      return true;
    } catch (e) {
      // The wholesale-swap fallback. It used to be
      // "document.body.innerHTML = html", which put back verbatim everything
      // the cleaning had just taken out — the exception path quietly undoing
      // the safe path.
      try {
        if (!frag) frag = inertFragment(html);
        if (!frag) return false;
        while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
        document.body.appendChild(document.importNode(frag, true));
      } catch (e2) {}
      return false;
    }
  }

  function applySnapshot(d) {
    // Nothing to do when body AND the styling envelope are unchanged.
    if (d.body == null || (d.body === lastBody && (d.attrs == null || d.attrs === lastAttrs) && (d.head == null || d.head === lastHead))) {
      if (d.h) appliedHash = d.h; staleTicks = 0;
      return;
    }
    var firstPaint = (lastBody === null);
    lastBody = d.body;
    // Replacing body.innerHTML resets scroll, focus, the text caret, and the
    // scroll position of every inner scrollable panel. On a LIVE update (the
    // student acts → the teacher's lesson changes → a snapshot comes back) that
    // yanked the student to the top and dropped them out of whatever they were
    // typing. So we capture this viewer's interaction state before the swap and
    // restore it after. The teacher's own scrolling arrives separately via
    // MIRROR_SCROLL. Only on FIRST paint (initial render / late-join / reconnect)
    // do we align to the teacher's scroll, so a late joiner lands where they are.
    var keepX = window.pageXOffset || 0, keepY = window.pageYOffset || 0;
    var focusPath = null, selStart = null, selEnd = null;
    try {
      var ae = document.activeElement;
      if (ae && ae !== document.body && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) {
        focusPath = getElementPath(ae);
        try { selStart = ae.selectionStart; selEnd = ae.selectionEnd; } catch (e2) {}
      }
    } catch (e) {}
    // Inner scrollers (a scrollable question panel, a code pane, a list).
    var innerScroll = [];
    try {
      var all = document.body.querySelectorAll('*');
      for (var i = 0; i < all.length && innerScroll.length < 30; i++) {
        if (all[i].scrollTop > 0 || all[i].scrollLeft > 0) innerScroll.push([getElementPath(all[i]), all[i].scrollTop, all[i].scrollLeft]);
      }
    } catch (e) {}

    applyingDom = true;
    // Patch in place rather than rebuilding — see DOM MORPHING above. The
    // scroll/focus/inner-scroller restores below become no-ops when morphing
    // succeeds (nothing was destroyed, so nothing needs restoring); they still
    // cover the wholesale-swap fallback path.
    applyBodyHtml(d.body);
    applyBodyAttrs(d.attrs);
    applyHead(d.head);
    try {
      if (firstPaint && (typeof d.scrollX === 'number' || typeof d.scrollY === 'number')) {
        window.scrollTo(d.scrollX || 0, d.scrollY || 0);
      } else {
        window.scrollTo(keepX, keepY);
      }
    } catch (e) {}
    // Restore inner scrollers, then focus + caret.
    for (var k = 0; k < innerScroll.length; k++) {
      try { var t = findElement(innerScroll[k][0]); if (t) { t.scrollTop = innerScroll[k][1]; t.scrollLeft = innerScroll[k][2]; } } catch (e) {}
    }
    if (focusPath) {
      try {
        var fe = findElement(focusPath);
        if (fe && fe.focus) {
          fe.focus({ preventScroll: true });
          if (selStart != null && fe.setSelectionRange) { try { fe.setSelectionRange(selStart, selEnd); } catch (e3) {} }
        }
      } catch (e) {}
    }
    applyingDom = false;
    if (d.h) appliedHash = d.h;
    staleTicks = 0;
    // A body swap recreates any <canvas> BLANK (innerHTML can't carry pixels).
    // Immediately re-draw the most recent captured frame so a lesson that
    // mutates the DOM while a canvas/3D sim runs doesn't flicker to empty
    // between the swap and the next ~120ms canvas tick.
    if (lastCanvasList) repaintKnownCanvases();
  }
  // Ask for a fresh full frame, at most once every few seconds. A miss usually
  // means the DOM snapshot carrying this canvas has not landed yet, so a burst
  // of requests would all fail for the same reason; one, then wait.
  var lastCanvasRescueAt = 0;
  function rescueCanvases(why) {
    var now = Date.now();
    if (now - lastCanvasRescueAt < 3000) return;
    lastCanvasRescueAt = now;
    try { console.warn('[mirror] canvas not painted (' + why + ') — asking for a resync'); } catch (e) {}
    post({ type: 'MIRROR_STALE' });
  }

  // Last resort when the selector will not resolve. The source counts canvases
  // in document order and sends that index next to the path; stripping <script>
  // tags never removes or reorders a canvas, so the Nth canvas here is the Nth
  // canvas there even when the two DOMs disagree about everything else.
  //
  // This sits behind the nth-of-type fix in getElementPath rather than replacing
  // it: it also covers a teacher and a student left on different builds by a
  // mid-lesson deploy, and any future markup difference nobody has thought of.
  function canvasByIndex(i) {
    if (typeof i !== 'number' || i < 0) return null;
    var all = document.querySelectorAll('canvas');
    return i < all.length ? all[i] : null;
  }

  // Repaint the frames we already hold, after a body swap blanked their
  // canvases — onto the exact elements they were painted on, and nothing else.
  //
  // This is where confetti got stuck on a student's screen for the rest of a
  // lesson. A celebration canvas streams frames, the lesson removes it when the
  // animation finishes, and the next DOM snapshot repainted the cached list.
  //
  // The trap is that a positional selector does not stop resolving when its
  // element is removed — it silently starts resolving to a DIFFERENT element.
  // With the celebration canvas first in the body, "canvas:nth-of-type(1)"
  // became the LESSON canvas the moment confetti was removed, so a frozen burst
  // of confetti was drawn straight over the question, and drawn again on every
  // snapshot after it. Checking that the selector still resolves does not help;
  // it resolves perfectly, to the wrong canvas.
  //
  // So a cached frame is bound to the ELEMENT it was actually painted on. If
  // that element has left the document the frame is dropped, because there is
  // no longer anywhere it belongs.
  function repaintKnownCanvases() {
    if (!lastCanvasList) return;
    var alive = [];
    for (var i = 0; i < lastCanvasList.length; i++) {
      var item = lastCanvasList[i];
      var el = item.el;
      var here = false;
      try { here = !!(el && el.getContext && document.contains(el)); } catch (e) {}
      if (here) { alive.push(item); drawFrame(item, el, true); }
    }
    lastCanvasList = alive.length ? alive : null;
  }

  function drawFrame(item, c, isRepaint) {
    var img = new Image();
    img.onload = function () {
      try {
        if (c.width !== item.w) c.width = item.w;
        if (c.height !== item.h) c.height = item.h;
        var ctx = c.getContext('2d');
        // Null when something already took a webgl context on this element: a
        // canvas only ever grants one kind. Nothing can be drawn here, so say
        // so rather than failing mute.
        if (!ctx) { if (!isRepaint) rescueCanvases('no 2d context on ' + item.sel); return; }
        ctx.drawImage(img, 0, 0);
      } catch (e) {
        if (!isRepaint) rescueCanvases('draw failed: ' + (e && e.name));
      }
    };
    // A corrupt or truncated data URL fires onerror, never onload. Left
    // unhandled that was another way to sit on a blank canvas in silence.
    img.onerror = function () { if (!isRepaint) rescueCanvases('frame failed to decode'); };
    img.src = item.data;
  }

  function paintCanvases(list) {
    lastCanvasList = list;
    for (var i = 0; i < list.length; i++) {
      (function (item) {
        var c = findElement(item.sel) || canvasByIndex(item.idx);
        // The canvas this frame belongs to is not in our DOM yet.
        //
        // Routine for a 3D lesson: Three.js appends renderer.domElement from
        // JavaScript, so the element only reaches us once the DOM snapshot
        // containing it arrives — and the pixels may well get here first.
        //
        // This used to be a silent early return, survivable only because
        // frames arrived ~8 times a second, so the next one landed 120ms later.
        // Now that unchanged frames are skipped, a STILL 3D scene sends exactly
        // one frame; drop it and the student stares at an empty canvas for the
        // rest of the lesson while the rest of the page mirrors perfectly. That
        // is precisely how this was reported: "they see everything, but the
        // simulation is not showing".
        if (!c || !c.getContext) { rescueCanvases('element ' + item.sel + ' not found'); return; }
        // Remember WHICH element this frame belongs to, so a later repaint
        // cannot land it on a neighbour that inherited its selector.
        item.el = c;
        drawFrame(item, c, false);
      })(list[i]);
    }
  }

  // Forward the follower's own input to the source (only when allowed to drive).
  // WHERE on the element, not just which element.
  //
  // A path alone is enough for a button, and useless for everything a maths
  // lesson is actually made of: a number line, a graph, a "tap where the ball
  // lands". Those read clientX/clientY, and a forwarded tap that carried no
  // position landed wherever el.click() happens to put it — which is nowhere in
  // particular. Fractions of the target's own box travel correctly between two
  // screens of different sizes; the source multiplies them back out against its
  // own layout.
  //
  // Deliberately NOT clamped to 0..1: a drag that starts on a canvas and
  // continues past its edge is normal (that is how OrbitControls is used), and
  // the fraction stays meaningful outside the box.
  function boxFraction(el, clientX, clientY) {
    try {
      var r = el.getBoundingClientRect();
      if (!r || !r.width || !r.height) return null;
      return { fx: (clientX - r.left) / r.width, fy: (clientY - r.top) / r.height };
    } catch (e) { return null; }
  }

  function fwd(kind, e, extra) {
    if (applyingDom || !allow) return;
    var p = getElementPath(e.target);
    var msg = { type: 'SYNC_MIRROR_INPUT', kind: kind, path: p };
    var f = (typeof e.clientX === 'number') ? boxFraction(e.target, e.clientX, e.clientY) : null;
    if (f) { msg.fx = f.fx; msg.fy = f.fy; }
    if (extra) for (var k in extra) msg[k] = extra[k];
    post(msg);
  }

  // A drag is three things, not one.
  //
  // Only pointerdown was ever forwarded — no move, no up. So a drag never
  // happened: a 3D scene could not be rotated, a slider could not be dragged,
  // and drag-and-drop did nothing. Worse, a lone pointerdown on OrbitControls
  // left the TEACHER's camera stuck mid-drag until they moved their own mouse.
  //
  // The anchor is the element the pointer went DOWN on, and every later move and
  // the up are measured against it — because a drag routinely leaves the element
  // it started on, and re-resolving the target each frame would send the moves
  // to whatever happened to be under the finger.
  var dragAnchorPath = null, dragPointerId = null, lastMoveSentAt = 0;

  document.addEventListener('click', function (e) { fwd('click', e); }, true);
  document.addEventListener('input', function (e) { fwd('input', e, { value: e.target && e.target.value }); }, true);
  document.addEventListener('change', function (e) { fwd('input', e, { value: e.target && e.target.value }); }, true);
  document.addEventListener('pointerdown', function (e) {
    if (applyingDom || !allow) return;
    dragAnchorPath = getElementPath(e.target);
    dragPointerId = e.pointerId;
    fwd('pointerdown', e, { pointerType: e.pointerType, isPrimary: e.isPrimary !== false });
  }, true);
  document.addEventListener('pointermove', function (e) {
    if (applyingDom || !allow || dragAnchorPath === null) return;
    if (dragPointerId !== null && e.pointerId !== dragPointerId) return;
    // ~33/s. Enough for a smooth rotation, far under the relay's rate limit,
    // and the source coalesces them into its own frame anyway.
    var now = Date.now();
    if (now - lastMoveSentAt < 30) return;
    lastMoveSentAt = now;
    var el = findElement(dragAnchorPath);
    var f = el ? boxFraction(el, e.clientX, e.clientY) : null;
    post({ type: 'SYNC_MIRROR_INPUT', kind: 'pointermove', path: dragAnchorPath,
           fx: f ? f.fx : 0, fy: f ? f.fy : 0, pointerType: e.pointerType });
  }, { capture: true, passive: true });
  function endDrag(e) {
    if (applyingDom || !allow || dragAnchorPath === null) return;
    var el = findElement(dragAnchorPath);
    var f = (el && typeof e.clientX === 'number') ? boxFraction(el, e.clientX, e.clientY) : null;
    post({ type: 'SYNC_MIRROR_INPUT', kind: 'pointerup', path: dragAnchorPath,
           fx: f ? f.fx : 0, fy: f ? f.fy : 0, pointerType: e.pointerType });
    dragAnchorPath = null; dragPointerId = null;
  }
  document.addEventListener('pointerup', endDrag, true);
  // A pointer that is cancelled (the browser took over the gesture, the finger
  // left the surface) must still release the source's drag, or its camera stays
  // held down with nobody holding it.
  document.addEventListener('pointercancel', endDrag, true);
  document.addEventListener('wheel', function (e) { if (applyingDom || !allow) return; var p = getElementPath(e.target); post({ type: 'SYNC_MIRROR_INPUT', kind: 'wheel', path: p, deltaY: e.deltaY }); }, { capture: true, passive: true });
  document.addEventListener('keydown', function (e) { if (applyingDom || !allow) return; post({ type: 'SYNC_MIRROR_INPUT', kind: 'key', key: e.key }); }, true);

  // ── SCROLL LOCK ──
  // When the teacher keeps the class "Linked" and the student is view-only, the
  // student's view must stay where the teacher put it — they shouldn't be able
  // to wander off mid-explanation. We block USER-initiated scrolling only;
  // window.scrollTo() still works, so teacher-driven positioning (MIRROR_SCROLL)
  // is unaffected. Blocking the gesture (rather than snapping back afterwards)
  // avoids a jarring fight with the student's finger/wheel.
  // Start LOCKED. The lock state arrives by message a moment after the mirror
  // boots, and starting unlocked left a window at the very beginning of a
  // lesson where a view-only student could scroll away before the rule landed.
  // Being briefly locked when you were allowed to scroll is a harmless
  // half-second; being briefly free when you weren't is the actual bug.
  var scrollLocked = true;
  // Suppress echo: teacher scroll → we scrollTo → our own scroll event fires →
  // we'd forward it back → they scroll → … a feedback loop. Ignore our own
  // scroll for a moment after applying theirs.
  var applyingScroll = 0;
  var lastScrollSentAt = 0;
  var SCROLL_KEYS = { PageUp: 1, PageDown: 1, ArrowUp: 1, ArrowDown: 1, Home: 1, End: 1, ' ': 1, Spacebar: 1 };
  function blockIfLocked(e) {
    if (!scrollLocked) return;
    try { e.preventDefault(); } catch (err) {}
  }
  // A student who IS allowed to drive should move the teacher's view with them —
  // otherwise the teacher is left describing something off the student's screen.
  // The source already knows how to apply a forwarded scroll; this is the half
  // that was never sent. Throttled, and never echoes a scroll we just applied.
  window.addEventListener('scroll', function () {
    if (!allow || applyingDom || scrollLocked) return;
    if (Date.now() - applyingScroll < 250) return;   // this was their scroll, not ours
    var now = Date.now();
    if (now - lastScrollSentAt < 90) return;
    lastScrollSentAt = now;
    post({
      type: 'SYNC_MIRROR_INPUT', kind: 'scroll',
      scrollX: window.pageXOffset || 0, scrollY: window.pageYOffset || 0,
    });
  }, { passive: true });

  document.addEventListener('wheel', blockIfLocked, { capture: true, passive: false });
  document.addEventListener('touchmove', blockIfLocked, { capture: true, passive: false });
  document.addEventListener('keydown', function (e) {
    if (!scrollLocked || !e || !SCROLL_KEYS[e.key]) return;
    // Never swallow typing: a locked student may still be filling in an input.
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    try { e.preventDefault(); } catch (err) {}
  }, { capture: true, passive: false });

  window.addEventListener('message', function (e) {
    var d = e.data; if (!d || !d.type) return;
    if (d.type === 'MIRROR_APPLY') applySnapshot(d);
    else if (d.type === 'REQUEST_HTML') provideFollowerHtml(d.requestId);
    else if (d.type === 'MIRROR_CANVAS') paintCanvases(d.canvases || []);
    else if (d.type === 'MIRROR_SCROLL') {
      applyingScroll = Date.now();
      try { window.scrollTo(d.scrollX || 0, d.scrollY || 0); } catch (e) {}
    }
    else if (d.type === 'SET_MIRROR_INTERACT') allow = !!d.allowed;
    else if (d.type === 'SET_MIRROR_SCROLLLOCK') scrollLocked = !!d.locked;
    else if (d.type === 'MIRROR_PING') {
      // The source tells us the fingerprint of the state it believes we have.
      // A mismatch means a snapshot never reached us (dropped in transit /
      // reconnect) — the one case content-dedup can't self-heal, because the
      // source won't resend state it thinks we already hold. Require TWO
      // consecutive mismatches (~4s) so a snapshot merely in flight doesn't
      // trigger a needless resync, then ask for a full one.
      // Tell the parent what we ACTUALLY have, every time.
      //
      // The follower has always known when its screen differs from the
      // source's — that is what the mismatch below is — but it kept the answer
      // to itself and quietly asked for a resend. So a student could be frozen,
      // or three seconds behind, and nothing anywhere said so; the teacher found
      // out when the student spoke up, or never. This is the one fact that turns
      // "it sometimes doesn't work" into something with a name and a time.
      post({ type: 'MIRROR_ACK', h: appliedHash, ok: !!(d.h && d.h === appliedHash) });
      if (d.h && d.h !== appliedHash) {
        staleTicks++;
        if (staleTicks >= 2) { staleTicks = 0; post({ type: 'MIRROR_STALE' }); }
      } else staleTicks = 0;
    }
  });
  // The shell this script is running inside is the lesson's own markup with its
  // <script> tags removed by a regular expression in the parent. That regular
  // expression cannot see an inline handler, so the very first thing the
  // follower does is clean the document it was born into — before the first
  // mirrored frame arrives, and before a child can tap anything in it.
  try {
    if (document.body) sanitizeInto(document.body);
    else document.addEventListener('DOMContentLoaded', function () { sanitizeInto(document.body); });
  } catch (e) {}
  post({ type: 'MIRROR_FOLLOWER_READY' });
})();
</script>
`;

// Build the injected mirror script for a given role. Followers get a
// script-stripped lesson shell + this in 'follower' mode; the driver's
// authoritative iframe gets the lesson (scripts intact) + this in 'source' mode.
export function mirrorScriptFor(mode: 'source' | 'follower'): string {
  return mirrorScript.replace('__MIRROR_MODE__', mode === 'source' ? 'source' : 'follower');
}

// Strip a lesson's own <script> tags so a follower shell renders the DOM/styles
// without ever executing the lesson logic (that would make it a live, diverging
// instance instead of a faithful mirror). Keeps <style>, <link>, and everything
// else. The mirror agent is injected separately.
export function stripLessonScripts(html: string): string {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
}
