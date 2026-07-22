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
      var sib = el, nth = 1;
      while ((sib = sib.previousElementSibling)) nth++;
      sel += ':nth-child(' + nth + ')';
      path.unshift(sel);
      el = el.parentNode;
      if (el && el.nodeName === 'BODY') { path.unshift('body'); break; }
    }
    return path.join(' > ');
  }
  function findElement(p) { if (!p) return null; try { return document.querySelector(p); } catch (e) { return null; } }
  function post(msg) { try { window.parent.postMessage(msg, '*'); } catch (e) {} }

  // ═══════════════════════ SOURCE (authoritative) ═══════════════════════
  if (isSource) {
    var applyingInput = false;   // suppress self-triggered streams while applying forwarded input
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
    var lastSentBody = null;
    // Send the CURRENT body — but only if it differs from the last thing we
    // sent (content-dedup). This makes every send idempotent + self-correcting:
    // a missed/late/out-of-order snapshot is harmless because the next send
    // always reflects the true current DOM, and identical bodies are never
    // re-sent (cheap heartbeat).
    function sendSnapshot(force) {
      if (trailTimer) { clearTimeout(trailTimer); trailTimer = null; }
      var body;
      try { body = serializeBody(); } catch (e) { return; }
      if (!force && body === lastSentBody) return;
      lastSentBody = body;
      lastSentAt = Date.now();
      try { post({ type: 'SYNC_MIRROR', body: body, scrollX: window.scrollX || 0, scrollY: window.scrollY || 0 }); } catch (e) {}
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
    function scheduleSnapshot() {
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
    function captureCanvases() {
      var out = [];
      try {
        var cs = document.querySelectorAll('canvas');
        for (var i = 0; i < cs.length && out.length < 4; i++) {
          var c = cs[i];
          try {
            var st = window.getComputedStyle(c);
            if (st && st.position === 'fixed') continue;
            if (!c.width || !c.height || c.width < 4 || c.height < 4) continue;
            out.push({ sel: getElementPath(c), w: c.width, h: c.height, data: c.toDataURL('image/png') });
          } catch (e) {}
        }
      } catch (e) {}
      return out;
    }
    var canvasTimer = null, hadCanvas = false;
    function canvasTick() {
      var cv = captureCanvases();
      if (cv.length) { hadCanvas = true; post({ type: 'SYNC_MIRROR_CANVAS', canvases: cv }); }
    }

    // Apply a follower's forwarded input onto the REAL lesson, then re-stream.
    function applyForwardedInput(d) {
      applyingInput = true;
      try {
        if (d.kind === 'scroll') { window.scrollTo(d.scrollX || 0, d.scrollY || 0); }
        else {
          var el = d.path ? findElement(d.path) : null;
          if (el) {
            if (d.kind === 'click') { if (el.click) el.click(); else el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })); }
            else if (d.kind === 'input') { try { el.value = d.value; } catch (e) {} el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
            else if (d.kind === 'pointerdown') { try { el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, view: window })); } catch (e) {} el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window })); }
            else if (d.kind === 'wheel') { el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, view: window, deltaY: d.deltaY || 0 })); }
            else if (d.kind === 'key') { document.dispatchEvent(new KeyboardEvent('keydown', { key: d.key, bubbles: true })); }
          }
        }
      } catch (e) {}
      applyingInput = false;
      scheduleSnapshot();
    }

    function activate() {
      try {
        new MutationObserver(scheduleSnapshot).observe(document.documentElement || document.body, { subtree: true, childList: true, attributes: true, characterData: true });
      } catch (e) {}
      // The source's OWN scroll should mirror too.
      window.addEventListener('scroll', function () { if (!applyingInput) post({ type: 'SYNC_MIRROR_SCROLL', scrollX: window.scrollX || 0, scrollY: window.scrollY || 0 }); }, { passive: true });
      setTimeout(function () { sendSnapshot(true); canvasTick(); if (!canvasTimer && (hadCanvas || document.querySelector('canvas'))) canvasTimer = setInterval(canvasTick, 120); }, 40);
      window.addEventListener('load', function () { setTimeout(function () { sendSnapshot(true); }, 120); if (!canvasTimer && document.querySelector('canvas')) canvasTimer = setInterval(canvasTick, 120); });
      // Self-correcting heartbeat: re-check the DOM every 500ms and re-send ONLY
      // if it changed since the last send (content-deduped). Cost is ~0 when
      // idle; guarantees any missed/late mutation-snapshot converges within 500ms
      // so the mirror can never get permanently stuck one step behind.
      setInterval(function () { if (!applyingInput) sendSnapshot(); }, 500);
    }

    window.addEventListener('message', function (e) {
      var d = e.data; if (!d || !d.type) return;
      if (d.type === 'MIRROR_INPUT') applyForwardedInput(d);
      else if (d.type === 'MIRROR_REQUEST') sendSnapshot(true); // late-join / reconnect → force full snapshot
      else if (d.type === 'SET_MIRROR_ROLE' && d.role !== 'source') { /* role flip handled by parent via rebuild */ }
    });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', activate); else activate();
    post({ type: 'MIRROR_SOURCE_READY' });
    return;
  }

  // ═══════════════════════ FOLLOWER (dumb mirror) ═══════════════════════
  var applyingDom = false, lastBody = null, allow = false, lastCanvasList = null;

  function applySnapshot(d) {
    if (d.body == null || d.body === lastBody) return;
    var firstPaint = (lastBody === null);
    lastBody = d.body;
    // Replacing body.innerHTML resets the scroll to the top. On a LIVE update
    // (the student did something → the teacher's lesson changed → a fresh
    // snapshot comes back) that yanked the student back to the top of the page
    // on every action. So we snapshot THIS viewer's scroll before the swap and
    // restore it after — the student stays exactly where they were. The
    // teacher's own scrolling is mirrored separately via MIRROR_SCROLL. Only on
    // the FIRST paint (initial render / late-join / reconnect) do we align to
    // the teacher's snapshot scroll so a late joiner lands where the teacher is.
    var keepX = window.pageXOffset || 0, keepY = window.pageYOffset || 0;
    applyingDom = true;
    try { document.body.innerHTML = d.body; } catch (e) {}
    try {
      if (firstPaint && (typeof d.scrollX === 'number' || typeof d.scrollY === 'number')) {
        window.scrollTo(d.scrollX || 0, d.scrollY || 0);
      } else {
        window.scrollTo(keepX, keepY);
      }
    } catch (e) {}
    applyingDom = false;
    // A body swap recreates any <canvas> BLANK (innerHTML can't carry pixels).
    // Immediately re-draw the most recent captured frame so a lesson that
    // mutates the DOM while a canvas/3D sim runs doesn't flicker to empty
    // between the swap and the next ~120ms canvas tick.
    if (lastCanvasList) paintCanvases(lastCanvasList);
  }
  function paintCanvases(list) {
    lastCanvasList = list;
    for (var i = 0; i < list.length; i++) {
      (function (item) {
        var c = findElement(item.sel);
        if (!c || !c.getContext) return;
        var img = new Image();
        img.onload = function () { try { if (c.width !== item.w) c.width = item.w; if (c.height !== item.h) c.height = item.h; c.getContext('2d').drawImage(img, 0, 0); } catch (e) {} };
        img.src = item.data;
      })(list[i]);
    }
  }

  // Forward the follower's own input to the source (only when allowed to drive).
  function fwd(kind, e, extra) {
    if (applyingDom || !allow) return;
    var p = getElementPath(e.target);
    var msg = { type: 'SYNC_MIRROR_INPUT', kind: kind, path: p };
    if (extra) for (var k in extra) msg[k] = extra[k];
    post(msg);
  }
  document.addEventListener('click', function (e) { fwd('click', e); }, true);
  document.addEventListener('input', function (e) { fwd('input', e, { value: e.target && e.target.value }); }, true);
  document.addEventListener('change', function (e) { fwd('input', e, { value: e.target && e.target.value }); }, true);
  document.addEventListener('pointerdown', function (e) { fwd('pointerdown', e); }, true);
  document.addEventListener('wheel', function (e) { if (applyingDom || !allow) return; var p = getElementPath(e.target); post({ type: 'SYNC_MIRROR_INPUT', kind: 'wheel', path: p, deltaY: e.deltaY }); }, { capture: true, passive: true });
  document.addEventListener('keydown', function (e) { if (applyingDom || !allow) return; post({ type: 'SYNC_MIRROR_INPUT', kind: 'key', key: e.key }); }, true);

  window.addEventListener('message', function (e) {
    var d = e.data; if (!d || !d.type) return;
    if (d.type === 'MIRROR_APPLY') applySnapshot(d);
    else if (d.type === 'MIRROR_CANVAS') paintCanvases(d.canvases || []);
    else if (d.type === 'MIRROR_SCROLL') { try { window.scrollTo(d.scrollX || 0, d.scrollY || 0); } catch (e) {} }
    else if (d.type === 'SET_MIRROR_INTERACT') allow = !!d.allowed;
  });
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
