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
    var taintReported = false;
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
            // WebP at q0.6 measured ~3.5x smaller than PNG on real lesson
            // canvases with no visible quality loss at these sizes. A browser
            // that doesn't support WebP silently returns PNG from toDataURL,
            // so this is safe to request unconditionally.
            out.push({ sel: getElementPath(c), w: c.width, h: c.height, data: c.toDataURL('image/webp', 0.6) });
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
      else if (d.type === 'MIRROR_REQUEST') sendSnapshot(true); // late-join / reconnect → force full snapshot
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
      for (var i = 0; i < want.length; i++) { document.body.setAttribute(want[i][0], want[i][1]); seen[want[i][0]] = 1; }
      var have = document.body.attributes;
      for (var j = have.length - 1; j >= 0; j--) { if (!seen[have[j].name]) document.body.removeAttribute(have[j].name); }
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
      host.innerHTML = html;
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
    try {
      var tpl = document.createElement('template');
      tpl.innerHTML = html;
      morphChildren(document.body, tpl.content);
      return true;
    } catch (e) {
      try { document.body.innerHTML = html; } catch (e2) {}
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

  // ── SCROLL LOCK ──
  // When the teacher keeps the class "Linked" and the student is view-only, the
  // student's view must stay where the teacher put it — they shouldn't be able
  // to wander off mid-explanation. We block USER-initiated scrolling only;
  // window.scrollTo() still works, so teacher-driven positioning (MIRROR_SCROLL)
  // is unaffected. Blocking the gesture (rather than snapping back afterwards)
  // avoids a jarring fight with the student's finger/wheel.
  var scrollLocked = false;
  var SCROLL_KEYS = { PageUp: 1, PageDown: 1, ArrowUp: 1, ArrowDown: 1, Home: 1, End: 1, ' ': 1, Spacebar: 1 };
  function blockIfLocked(e) {
    if (!scrollLocked) return;
    try { e.preventDefault(); } catch (err) {}
  }
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
    else if (d.type === 'MIRROR_CANVAS') paintCanvases(d.canvases || []);
    else if (d.type === 'MIRROR_SCROLL') { try { window.scrollTo(d.scrollX || 0, d.scrollY || 0); } catch (e) {} }
    else if (d.type === 'SET_MIRROR_INTERACT') allow = !!d.allowed;
    else if (d.type === 'SET_MIRROR_SCROLLLOCK') scrollLocked = !!d.locked;
    else if (d.type === 'MIRROR_PING') {
      // The source tells us the fingerprint of the state it believes we have.
      // A mismatch means a snapshot never reached us (dropped in transit /
      // reconnect) — the one case content-dedup can't self-heal, because the
      // source won't resend state it thinks we already hold. Require TWO
      // consecutive mismatches (~4s) so a snapshot merely in flight doesn't
      // trigger a needless resync, then ask for a full one.
      if (d.h && d.h !== appliedHash) {
        staleTicks++;
        if (staleTicks >= 2) { staleTicks = 0; post({ type: 'MIRROR_STALE' }); }
      } else staleTicks = 0;
    }
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
