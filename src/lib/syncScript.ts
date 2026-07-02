export const injectedSyncScript = `
<script id="mathslive-sync-script">
  try {
    Object.defineProperty(window, 'fetch', {
      value: window.fetch,
      writable: true,
      configurable: true
    });
  } catch (e) {}

  (function() {
    // AUTONOMOUS: [ORDER-1] Use counter instead of boolean to prevent isRemoteUpdate getting stuck
    var remoteDepth = 0;
    function isRemote() { return remoteDepth > 0; }
    function enterRemote() { remoteDepth++; }
    function exitRemote() { remoteDepth = Math.max(0, remoteDepth - 1); }

    var interactionBlocked = false;
    var presenterMode = false;
    var lockedWindowX = 0;
    var lockedWindowY = 0;

    function updateLockedWindowPos() {
      lockedWindowX = window.scrollX || 0;
      lockedWindowY = window.scrollY || 0;
    }

    function blockScrollEvent(e) {
      if (!interactionBlocked || isRemote()) return false;
      try { e.preventDefault(); } catch(ignore) {}
      try { e.stopPropagation(); } catch(ignore) {}
      return true;
    }

    // In view-only mode, fully suppress local user-initiated interaction events
    // BEFORE they reach the simulation's own handlers. The simulation's own
    // onclick / oninput / etc. listeners would otherwise advance internal state
    // (e.g. a quiz's "Next" button), causing the student's iframe to drift out
    // of sync with the teacher (the originally-reported "teacher on Q2,
    // student on Q5" bug). Remote-replayed events (isRemote()) and presenter
    // mode bypass this block.
    // Returns true if the event was suppressed — caller should return immediately.
    function blockLocalInteraction(e) {
      if (!interactionBlocked || isRemote() || presenterMode) return false;
      try { e.preventDefault(); } catch(ignore) {}
      try { e.stopPropagation(); } catch(ignore) {}
      try { e.stopImmediatePropagation(); } catch(ignore) {}
      return true;
    }

    // SCROLL IS NEVER LOCKED. A student must always be able to scroll their own
    // viewport (the parent's mirror overlay forwards wheel/touch into here).
    // Previously this snapped the student back to the teacher's scroll position
    // in view-only mode, which made students unable to scroll at all. We keep
    // the function (it has several call sites) but it is now a no-op. Following
    // the teacher's scroll is still possible via REMOTE_SCROLL (scroll-sync),
    // which is a separate, opt-in channel.
    function enforceScrollLock() {
      return;
    }

    // Show a visual indicator when following clicks from another user
    function showClickIndicator(x, y) {
      try {
        var indicator = document.createElement('div');
        indicator.style.cssText = 'position:fixed;left:' + x + 'px;top:' + y + 'px;width:20px;height:20px;margin:-10px 0 0 -10px;border-radius:50%;background:rgba(239,68,68,0.6);border:3px solid #EF4444;z-index:999999;pointer-events:none;animation:clickPulse 1s ease-out forwards;';
        document.body.appendChild(indicator);

        // Add animation keyframes if not already present
        if (!document.getElementById('clickPulseStyle')) {
          var style = document.createElement('style');
          style.id = 'clickPulseStyle';
          style.textContent = '@keyframes clickPulse{0%{transform:scale(1);opacity:1}50%{transform:scale(2)}100%{transform:scale(3);opacity:0}}';
          document.head.appendChild(style);
        }

        setTimeout(function() {
          if (indicator.parentNode) indicator.parentNode.removeChild(indicator);
        }, 1000);
      } catch(ignore) {}
    }

    function isScrollKey(e) {
      var k = e.key;
      return k === 'ArrowUp' || k === 'ArrowDown' || k === 'ArrowLeft' || k === 'ArrowRight' ||
             k === 'PageUp' || k === 'PageDown' || k === 'Home' || k === 'End' ||
             k === ' ' || k === 'Spacebar' || k === 'Space';
    }

    function isEditableTarget(t) {
      if (!t) return false;
      try {
        var tag = (t.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
        if (t.isContentEditable) return true;
      } catch(ignore) {}
      return false;
    }

    // AUTONOMOUS: [ORDER-3] CSS.escape polyfill for older browsers
    if (typeof CSS === 'undefined' || !CSS.escape) {
      window.CSS = window.CSS || {};
      CSS.escape = function(str) {
        return String(str).replace(/[\\!"#$%&'()*+,.\\/:;<=>?@[\\]^\\x60{|}~]/g, '\\\\$&');
      };
    }

    // ── Deterministic Randomness ──
    // The seed is the lynchpin of syncing non-deterministic sims (a quiz that
    // rolls a random question, a sim that scatters particles). Every screen
    // MUST seed identically, BEFORE the sim's own scripts run, or the very
    // first Math.random() draw diverges. The server issues ONE seed per
    // lesson baseline and the parent injects it here at blob-build time
    // (replacing the placeholder below) — so it's a literal constant present
    // synchronously when this script executes, ahead of the sim. When no seed
    // is injected (legacy / 0) we fall back to a body-text hash, which is only
    // approximately stable.
    (function() {
      var INJECTED_SEED = __MATHSLIVE_SEED__;
      function hashCode(str) {
        var hash = 0;
        for (var i = 0; i < str.length; i++) {
          var c = str.charCodeAt(i);
          hash = ((hash << 5) - hash) + c;
          hash = hash & hash;
        }
        return Math.abs(hash) || 12345;
      }
      function getStableSeed() {
        var body = document.body;
        if (!body) return 12345;
        var text = body.textContent || '';
        return hashCode(text.trim().substring(0, 500));
      }

      var seed;
      if (typeof INJECTED_SEED === 'number' && INJECTED_SEED > 0) {
        seed = INJECTED_SEED; // server-shared, identical on every screen
      } else if (document.readyState === 'loading') {
        seed = 12345;
        document.addEventListener('DOMContentLoaded', function() {
          seed = getStableSeed();
          if (seed < 1000) seed += 123456789;
        });
      } else {
        seed = getStableSeed();
      }
      if (seed < 1000) seed += 123456789;

      Math.random = function() {
        var t = seed += 0x6D2B79F5;
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
      };
    })();

    // ── Deterministic, isolated storage ──
    // A lesson that persists to localStorage/sessionStorage (progress, XP,
    // "which screen am I on") is poison for sync. The lesson iframe is a blob:
    // URL that INHERITS the parent app's origin, so a real localStorage would
    // (1) persist across every iframe rebuild and full page reload, and
    // (2) be SHARED-by-origin yet DIVERGE between the teacher's browser and the
    // student's. The two sides then boot from different saved state, and the
    // journal replay — which assumes a clean boot — reconstructs the wrong
    // screen (a root cause of the "teacher on the map, student on the quiz"
    // desync). We replace both Storages with an in-memory one that starts EMPTY
    // on every load, exactly like the Math.random seed shim above neutralises
    // randomness. Lessons that use storage still work; they just don't persist
    // across reloads — so teacher, student, late-joiner and post-reconnect
    // rebuild ALL boot from the identical clean slate and replay deterministically.
    (function() {
      function makeMemStore() {
        var data = {};
        var api = {
          getItem: function(k) { k = String(k); return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
          setItem: function(k, v) { data[String(k)] = String(v); },
          removeItem: function(k) { delete data[String(k)]; },
          clear: function() { data = {}; },
          key: function(i) { var ks = Object.keys(data); return (i >= 0 && i < ks.length) ? ks[i] : null; }
        };
        // Proxy faithfully emulates bracket access (store['k']) + length, which
        // some lessons use instead of getItem/setItem.
        try {
          return new Proxy(api, {
            get: function(t, p) {
              if (p === 'length') return Object.keys(data).length;
              if (p in t) return t[p];
              if (typeof p === 'string' && Object.prototype.hasOwnProperty.call(data, p)) return data[p];
              return undefined;
            },
            set: function(t, p, v) { if (p in t) { t[p] = v; } else { data[String(p)] = String(v); } return true; },
            has: function(t, p) { return (p in t) || Object.prototype.hasOwnProperty.call(data, p); },
            deleteProperty: function(t, p) { if (Object.prototype.hasOwnProperty.call(data, p)) delete data[p]; return true; }
          });
        } catch (e) { return api; }
      }
      try {
        var ls = makeMemStore(), ss = makeMemStore();
        try { Object.defineProperty(window, 'localStorage', { value: ls, configurable: true }); } catch (e1) { try { window.localStorage = ls; } catch (e2) {} }
        try { Object.defineProperty(window, 'sessionStorage', { value: ss, configurable: true }); } catch (e3) { try { window.sessionStorage = ss; } catch (e4) {} }
      } catch (e) {}
    })();

    // ── Sim load/error reporting ──
    // When a lesson fails on a STUDENT's machine (CDN script blocked by their
    // network, WebGL unavailable, a JS crash mid-boot) the teacher previously
    // had no signal at all — the student just "wasn't following". Capture the
    // first few fatal-ish errors and post them to the parent, which relays
    // them to the teacher as a toast. Capture-phase listener because resource
    // load errors don't bubble. IMG failures are skipped (noisy, non-fatal).
    var simErrCount = 0;
    var simErrSeen = {};
    function reportSimError(msg, src) {
      try {
        if (simErrCount >= 3) return;
        var key = String(msg || '') + '|' + String(src || '');
        if (simErrSeen[key]) return;
        simErrSeen[key] = 1;
        simErrCount++;
        window.parent.postMessage({
          type: 'SYNC_SIM_ERROR',
          message: String(msg || 'Script error').slice(0, 300),
          source: String(src || '').slice(0, 300)
        }, '*');
      } catch (e) {}
    }
    window.addEventListener('error', function(e) {
      try {
        var t = e && e.target;
        if (t && t !== window && t.tagName) {
          var tag = String(t.tagName).toUpperCase();
          if (tag === 'SCRIPT' || tag === 'LINK') {
            reportSimError('Failed to load ' + tag.toLowerCase() + ': ' + (t.src || t.href || '(unknown url)'), t.src || t.href || '');
          }
          return; // resource error (incl. IMG) — never a JS error object
        }
        reportSimError((e && e.message) || 'Script error', (e && e.filename) || '');
      } catch (err) {}
    }, true);
    window.addEventListener('unhandledrejection', function(e) {
      try {
        var r = e && e.reason;
        var m = r && (r.message || (typeof r === 'string' ? r : ''));
        if (m) reportSimError('Unhandled rejection: ' + m, '');
      } catch (err) {}
    });

    // ── Element Path (robust selector generation) ──
    function getElementPath(el) {
      if (!el || el.nodeType !== 1) return '';
      if (el.id) return '#' + CSS.escape(el.id);
      var path = [];
      while (el && el.nodeType === 1) {
        var selector = el.nodeName.toLowerCase();
        if (el.id) {
          selector += '#' + CSS.escape(el.id);
          path.unshift(selector);
          break;
        } else {
          var sib = el, nth = 1;
          while (sib = sib.previousElementSibling) nth++;
          selector += ':nth-child(' + nth + ')';
        }
        path.unshift(selector);
        el = el.parentNode;
        if (el && el.nodeName === 'BODY') {
          path.unshift('body');
          break;
        }
      }
      return path.join(' > ');
    }

    function findElement(path) {
      if (!path) return null;
      try { return document.querySelector(path); } catch(e) { return null; }
    }

    // ── Input events ──
    document.addEventListener('input', function(e) {
      if (isRemote()) return;
      if (blockLocalInteraction(e)) return;
      var path = getElementPath(e.target);
      if (path) {
        window.parent.postMessage({ type: 'SYNC_INPUT', path: path, value: e.target.value, checked: e.target.checked }, '*');
      }
    }, true);

    document.addEventListener('change', function(e) {
      if (isRemote()) return;
      if (blockLocalInteraction(e)) return;
      var path = getElementPath(e.target);
      if (path) {
        window.parent.postMessage({ type: 'SYNC_CHANGE', path: path, value: e.target.value, checked: e.target.checked }, '*');
      }
    }, true);

    // ── Element ping (Alt+click = "look here") ──
    // Renders a 1.2s ripple at a point/element and syncs it to everyone.
    // Works even in view-only mode (the parent/server treat SYNC_PING like
    // cursor traffic) so a confused student can point at the exact thing.
    function showPing(x, y) {
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
        setTimeout(function() { ping.parentNode && ping.parentNode.removeChild(ping); }, 1300);
      } catch(ignore) {}
    }
    // Capture-phase + stopImmediatePropagation: an Alt+click must PING, not
    // activate the element underneath (we don't want "point at the button"
    // to also press the button).
    document.addEventListener('click', function(e) {
      if (!e.altKey || !e.isTrusted || isRemote()) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      showPing(e.clientX, e.clientY);
      window.parent.postMessage({ type: 'SYNC_PING', path: getElementPath(e.target), clientX: e.clientX / window.innerWidth, clientY: e.clientY / window.innerHeight }, '*');
    }, true);

    // ── Click events ──
    document.addEventListener('click', function(e) {
      if (isRemote()) return;
      if (blockLocalInteraction(e)) return;
      if (!e.isTrusted) return;
      if (e.altKey) return; // Alt+click is a ping, handled above
      var path = getElementPath(e.target);
      if (path) {
        window.parent.postMessage({ type: 'SYNC_CLICK', path: path, clientX: e.clientX / window.innerWidth, clientY: e.clientY / window.innerHeight }, '*');
      }
    }, true);

    // ── Mouse move for cursors (throttled) ──
    var lastMove = 0;
    // Track physical button state so we can mirror DRAG gestures. Many math
    // simulations drag on raw mousedown→mousemove→mouseup (canvas/SVG points,
    // sliders, rotations) rather than HTML5 drag-and-drop. Previously only the
    // mousedown and mouseup synced, so the dragged object teleported on the
    // student's screen. We now stream throttled SYNC_MOUSEMOVE while the button
    // is held so the student's simulation follows the drag continuously.
    var pointerDown = false;
    var lastDragMove = 0;
    // Safety: if the gesture ends off-iframe (teacher releases outside the
    // simulation, or the tab loses focus mid-drag) we never see mouseup, so
    // clear the flag here to avoid a "stuck drag" that streams forever.
    window.addEventListener('blur', function() { pointerDown = false; });
    document.addEventListener('mousemove', function(e) {
      var now = Date.now();
      if (now - lastMove > 50) {
        lastMove = now;
        // Element-anchor the cursor: viewport-percentage coords alone land in
        // the wrong place on the other side whenever layouts differ (centered
        // fixed-width content, different window sizes/toolbars). We also send
        // the hovered element's path plus the relative offset INSIDE it; the
        // receiver re-resolves that element in its own layout and positions
        // the cursor there, falling back to the raw percentages.
        var cpath = null, cex = 0.5, cey = 0.5;
        try {
          if (e.target && e.target !== document && e.target !== document.body && e.target !== document.documentElement) {
            cpath = getElementPath(e.target);
            var crect = e.target.getBoundingClientRect();
            if (crect.width > 0 && crect.height > 0) {
              cex = (e.clientX - crect.left) / crect.width;
              cey = (e.clientY - crect.top) / crect.height;
            }
          }
        } catch (ignore) {}
        window.parent.postMessage({ type: 'SYNC_CURSOR', x: e.clientX / window.innerWidth, y: e.clientY / window.innerHeight, path: cpath, ex: cex, ey: cey }, '*');
      }
      // Mirror the drag itself (only for genuine local gestures — never replay
      // remote events back, never leak from a view-only student). Throttled
      // tighter than the cursor so the motion stays smooth without flooding.
      if (pointerDown && !isRemote() && !(interactionBlocked && !presenterMode)) {
        if (now - lastDragMove > 30) {
          lastDragMove = now;
          var dpath = getElementPath(e.target);
          window.parent.postMessage({
            type: 'SYNC_MOUSEMOVE',
            path: dpath,
            x: e.clientX / window.innerWidth,
            y: e.clientY / window.innerHeight,
            buttons: e.buttons
          }, '*');
        }
      }
    });

    // ── Touch events for mobile ──
    var lastTouch = 0;
    document.addEventListener('touchmove', function(e) {
      var now = Date.now();
      if (now - lastTouch > 80) {
        lastTouch = now;
        var touch = e.touches[0];
        if (touch) {
          window.parent.postMessage({ type: 'SYNC_CURSOR', x: touch.clientX / window.innerWidth, y: touch.clientY / window.innerHeight }, '*');
        }
      }
      // In view-only mode, block touch scroll/pan gestures (must be passive:false to allow preventDefault)
      if (interactionBlocked && !isRemote()) {
        try { e.preventDefault(); } catch(ignore) {}
        try { e.stopPropagation(); } catch(ignore) {}
      }
    }, { passive: false });

    // Strict view-only lock: prevent student-originated scroll inputs via wheel
    document.addEventListener('wheel', function(e) {
      if (blockScrollEvent(e)) {
        // Also immediately snap back to locked position for stronger enforcement
        enforceScrollLock();
      }
    }, { capture: true, passive: false });

    // Block keyboard scroll keys in view-only mode
    document.addEventListener('keydown', function(e) {
      if (!interactionBlocked || isRemote()) return;
      if (!isScrollKey(e)) return;
      if (isEditableTarget(e.target)) return;
      try { e.preventDefault(); } catch(ignore) {}
      try { e.stopPropagation(); } catch(ignore) {}
      // Enforce scroll lock immediately
      enforceScrollLock();
    }, true);

    document.addEventListener('touchstart', function(e) {
      if (isRemote()) return;
      // Note: this listener is passive:true so preventDefault is a no-op here,
      // but a sibling touchstart handler with passive:false (added below) does
      // the actual blocking. We only need to skip the SYNC emit on this side.
      if (interactionBlocked && !presenterMode) return;
      var touch = e.touches[0];
      if (touch) {
        var el = document.elementFromPoint(touch.clientX, touch.clientY);
        if (el) {
          var path = getElementPath(el);
          if (path) {
            window.parent.postMessage({ type: 'SYNC_CLICK', path: path }, '*');
          }
        }
      }
    }, { passive: true });

    // Companion touchstart blocker: passive:false so preventDefault actually
    // suppresses the simulation's own touchstart handlers in view-only mode.
    document.addEventListener('touchstart', function(e) {
      blockLocalInteraction(e);
    }, { capture: true, passive: false });

    // ── Scroll sync (toggleable, smooth) ──
    var scrollSyncEnabled = true;
    var lastScroll = 0;

    // ── Zoom sync ──
    var currentZoom = 1;
    function _applyZoom(z) {
      currentZoom = z;
      var root = document.documentElement;
      // Prefer CSS zoom (fast, preserves layout; widely supported in Chromium, Safari, Edge)
      try {
        root.style.zoom = String(z);
      } catch(e) {}
      // Firefox doesn't support CSS zoom — use transform scale as fallback
      if (!('zoom' in root.style)) {
        root.style.transformOrigin = '0 0';
        root.style.transform = z === 1 ? '' : 'scale(' + z + ')';
        root.style.width = z === 1 ? '' : (100 / z) + '%';
      }
    }

    // Find a meaningful anchor element near the top of the visible area
    var _lastAnchorTime = 0;
    var _lastAnchorResult = null;
    var _lastAnchorContainer = null;
    function _findAnchor(scrollContainer) {
      var now = Date.now();
      // Cache anchor for 120ms to avoid expensive DOM queries on every scroll tick
      if (now - _lastAnchorTime < 120 && _lastAnchorContainer === scrollContainer && _lastAnchorResult) {
        // Update offset for cached anchor (position may have changed slightly)
        try {
          var cachedEl = document.querySelector(_lastAnchorResult.anchor);
          if (cachedEl) {
            var cr = cachedEl.getBoundingClientRect();
            _lastAnchorResult.anchorOffsetPx = !scrollContainer ? -cr.top : (scrollContainer.getBoundingClientRect().top - cr.top);
            return _lastAnchorResult;
          }
        } catch(e) {}
      }
      _lastAnchorTime = now;
      _lastAnchorContainer = scrollContainer;

      var isDoc = !scrollContainer;
      var vpHeight = isDoc ? window.innerHeight : scrollContainer.clientHeight;
      var scanY = vpHeight * 0.15; // 15% into the visible viewport
      // Check elements with semantic meaning — prefer quiz/step markers, then headings, then containers
      var root = isDoc ? document : scrollContainer;
      var candidates = root.querySelectorAll(
        '[data-step], [data-question], .question, .slide, .card, .panel, .problem, section, article, h1, h2, h3, h4, h5, h6, li, tr'
      );
      // If too few semantic elements, also check divs/paragraphs
      if (candidates.length < 3) {
        candidates = root.querySelectorAll(
          '[data-step], [data-question], .question, .slide, .card, .panel, .problem, section, article, h1, h2, h3, h4, h5, h6, p, li, tr, div'
        );
      }
      var best = null;
      var bestDist = Infinity;
      var limit = Math.min(candidates.length, 500); // Cap for performance
      for (var i = 0; i < limit; i++) {
        var c = candidates[i];
        var rect = c.getBoundingClientRect();
        // Use viewport-relative top (no need to add scrollTop)
        var dist = Math.abs(rect.top - scanY);
        if (dist < bestDist) {
          bestDist = dist;
          best = c;
        }
      }
      if (best && bestDist < vpHeight) {
        var p = getElementPath(best);
        if (p) {
          var bestRect = best.getBoundingClientRect();
          _lastAnchorResult = { anchor: p, anchorOffsetPx: isDoc ? -bestRect.top : (scrollContainer.getBoundingClientRect().top - bestRect.top) };
          return _lastAnchorResult;
        }
      }
      _lastAnchorResult = null;
      return null;
    }

    function sendDocScroll() {
      if (isRemote() || !scrollSyncEnabled || (interactionBlocked && !presenterMode)) return;
      var now = Date.now();
      if (now - lastScroll < 30) return;
      lastScroll = now;
      var maxW = Math.max(0, document.documentElement.scrollWidth - window.innerWidth);
      var maxH = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      var msg = {
        type: 'SYNC_SCROLL',
        scrollX: maxW > 0 ? window.scrollX / maxW : 0,
        scrollY: maxH > 0 ? window.scrollY / maxH : 0,
        absScrollX: window.scrollX,
        absScrollY: window.scrollY,
        maxScrollX: maxW,
        maxScrollY: maxH
      };
      // Add anchor for cross-resolution sync
      var a = _findAnchor(null);
      if (a) { msg.anchor = a.anchor; msg.anchorOffsetPx = a.anchorOffsetPx; }
      window.parent.postMessage(msg, '*');
    }

    function sendElementScroll(e) {
      if (isRemote() || !scrollSyncEnabled || (interactionBlocked && !presenterMode)) return;
      var now = Date.now();
      if (now - lastScroll < 30) return;
      lastScroll = now;
      var el = e.currentTarget || e.target;
      if (!el || el.nodeType !== 1) return;
      var path = getElementPath(el);
      if (!path) return;
      var maxTop = Math.max(0, el.scrollHeight - el.clientHeight);
      var maxLeft = Math.max(0, el.scrollWidth - el.clientWidth);
      if (maxTop > 0 || maxLeft > 0) {
        var msg = {
          type: 'SYNC_SCROLL', path: path,
          scrollTop: maxTop > 0 ? el.scrollTop / maxTop : 0,
          scrollLeft: maxLeft > 0 ? el.scrollLeft / maxLeft : 0,
          absScrollTop: el.scrollTop, absScrollLeft: el.scrollLeft
        };
        // Add anchor for cross-resolution sync
        var a = _findAnchor(el);
        if (a) { msg.anchor = a.anchor; msg.anchorOffsetPx = a.anchorOffsetPx; }
        window.parent.postMessage(msg, '*');
      }
    }

    // Send scroll sync updates (only when not blocked or during remote updates)
    window.addEventListener('scroll', function() {
      if (interactionBlocked && !presenterMode && !isRemote()) {
        // In view-only mode, revert any student scroll attempts immediately
        enforceScrollLock();
        return;
      }
      sendDocScroll();
    }, { passive: true });

    // AUTONOMOUS: [ORDER-4] Debounce DOM scanning to prevent perf issues (was 150ms, now 800ms)
    var _scrollTag = '__syncScroll';
    var _scanTimer = null;
    function _attachScrollListeners() {
      var all = document.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (el[_scrollTag]) continue;
        var sH = el.scrollHeight > el.clientHeight + 2;
        var sW = el.scrollWidth > el.clientWidth + 2;
        if (!sH && !sW) continue;
        try {
          var cs = window.getComputedStyle(el);
          var oy = cs.overflowY;
          var ox = cs.overflowX;
          if (oy === 'auto' || oy === 'scroll' || oy === 'overlay' ||
              ox === 'auto' || ox === 'scroll' || ox === 'overlay') {
            el[_scrollTag] = true;
            el.addEventListener('scroll', sendElementScroll, { passive: true });
          }
        } catch(ignore) {}
      }
    }

    function _debouncedAttach() {
      if (_scanTimer) clearTimeout(_scanTimer);
      _scanTimer = setTimeout(_attachScrollListeners, 800);
    }

    function _initScrollMonitor() {
      _attachScrollListeners();
      try {
        new MutationObserver(_debouncedAttach)
          .observe(document.documentElement || document.body, { childList: true, subtree: true });
      } catch(ignore) {}
      // AUTONOMOUS: [ORDER-4] Reduced periodic scan from 3s to 10s
      setInterval(_attachScrollListeners, 10000);
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', _initScrollMonitor);
    } else {
      setTimeout(_initScrollMonitor, 100);
    }
    window.addEventListener('load', function() { setTimeout(_attachScrollListeners, 300); });

    // ── Mouse down/up events ──
    document.addEventListener('mousedown', function(e) {
      if (isRemote()) return;
      if (blockLocalInteraction(e)) return;
      if (!e.isTrusted) return;
      pointerDown = true;
      lastDragMove = 0; // allow the first drag-move to fire immediately
      var path = getElementPath(e.target);
      if (path) {
        window.parent.postMessage({ type: 'SYNC_MOUSEDOWN', path: path, x: e.clientX / window.innerWidth, y: e.clientY / window.innerHeight, button: e.button }, '*');
      }
    }, true);

    // ── Pointer events ──
    // Modern quizzes/sims often advance on Pointer Events, which the
    // mouse/click/touch listeners above don't cover. Two failures result:
    // (1) in view-only mode the student could still advance the quiz locally
    // (the reported "student on Q5, teacher on Q2" drift); (2) in interactive
    // mode a pointer-only interaction produced no SYNC_ signal, so the teacher
    // never learned the student acted. Capture pointerdown/up: block them in
    // view-only, and in interactive mode emit a marker so the parent triggers
    // a fresh state snapshot to the teacher. We deliberately do NOT replay
    // these on the teacher (the click sync + the absolute state snapshot do
    // the real work) to avoid double-applying a gesture.
    document.addEventListener('pointerdown', function(e) {
      if (isRemote()) return;
      if (blockLocalInteraction(e)) return;
      if (!e.isTrusted) return;
      var path = getElementPath(e.target);
      window.parent.postMessage({ type: 'SYNC_POINTERDOWN', path: path, x: e.clientX / window.innerWidth, y: e.clientY / window.innerHeight, button: e.button || 0 }, '*');
    }, true);

    document.addEventListener('pointerup', function(e) {
      if (isRemote()) return;
      if (blockLocalInteraction(e)) return;
    }, true);

    document.addEventListener('mouseup', function(e) {
      // Clear the drag flag before any guard returns so a blocked/remote
      // mouseup can't leave the gesture stuck "down".
      pointerDown = false;
      if (isRemote()) return;
      if (blockLocalInteraction(e)) return;
      if (!e.isTrusted) return;
      var path = getElementPath(e.target);
      if (path) {
        window.parent.postMessage({ type: 'SYNC_MOUSEUP', path: path, x: e.clientX / window.innerWidth, y: e.clientY / window.innerHeight }, '*');
      }
    }, true);

    // ── HTML5 Drag/Drop sync ──
    var dragStartPath = '';
    var lastDrag = 0;

    document.addEventListener('dragstart', function(e) {
      if (isRemote()) return;
      if (blockLocalInteraction(e)) return;
      dragStartPath = getElementPath(e.target);
      window.parent.postMessage({ type: 'SYNC_DRAGSTART', path: dragStartPath, clientX: e.clientX / window.innerWidth, clientY: e.clientY / window.innerHeight }, '*');
    }, true);

    document.addEventListener('drag', function(e) {
      if (isRemote()) return;
      if (blockLocalInteraction(e)) return;
      if (!e.clientX) return;
      var now = Date.now();
      if (now - lastDrag < 50) return;
      lastDrag = now;
      window.parent.postMessage({ type: 'SYNC_DRAG', path: dragStartPath, clientX: e.clientX / window.innerWidth, clientY: e.clientY / window.innerHeight }, '*');
    }, true);

    document.addEventListener('dragend', function(e) {
      if (isRemote()) return;
      if (blockLocalInteraction(e)) return;
      window.parent.postMessage({ type: 'SYNC_DRAGEND', path: dragStartPath, clientX: e.clientX / window.innerWidth, clientY: e.clientY / window.innerHeight }, '*');
      dragStartPath = '';
    }, true);

    document.addEventListener('drop', function(e) {
      if (isRemote()) return;
      if (blockLocalInteraction(e)) return;
      e.preventDefault();
      var dropPath = getElementPath(e.target);
      window.parent.postMessage({ type: 'SYNC_DROP', dragPath: dragStartPath, dropPath: dropPath, clientX: e.clientX / window.innerWidth, clientY: e.clientY / window.innerHeight }, '*');
    }, true);

    document.addEventListener('dragover', function(e) { e.preventDefault(); }, true);

    // ── Key events for simulations ──
    document.addEventListener('keydown', function(e) {
      if (isRemote()) return;
      if (blockLocalInteraction(e)) return;
      window.parent.postMessage({ type: 'SYNC_KEYDOWN', key: e.key, code: e.code, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey }, '*');
    }, true);

    document.addEventListener('keyup', function(e) {
      if (isRemote()) return;
      if (blockLocalInteraction(e)) return;
      window.parent.postMessage({ type: 'SYNC_KEYUP', key: e.key, code: e.code }, '*');
    }, true);

    // ── Receive remote events ──
    // AUTONOMOUS: [ORDER-1] All dispatchEvent calls wrapped in try-finally to prevent stuck flags
    window.addEventListener('message', function(e) {
      var data = e.data;
      if (!data || !data.type) return;

      if (data.type === 'REMOTE_INPUT' || data.type === 'REMOTE_CHANGE') {
        var el = findElement(data.path);
        // Don't stomp the field the LOCAL user is actively editing — otherwise
        // a remote keystroke resets their value/caret and they "can't type".
        // The two sides reconcile when the local user blurs / on the next sync.
        if (el && el === document.activeElement) {
          // skip — local user owns this field right now
        } else if (el) {
          enterRemote();
          try {
            if (el.type === 'checkbox' || el.type === 'radio') {
              el.checked = data.checked;
            } else {
              el.value = data.value;
            }
            el.dispatchEvent(new Event(data.type === 'REMOTE_INPUT' ? 'input' : 'change', { bubbles: true }));
          } finally { exitRemote(); }
        }
      } else if (data.type === 'REMOTE_CLICK') {
        // A replayed click can arrive a tick before its target exists — the
        // navigation click that BUILDS this screen was replayed just before, and
        // the lesson may create the new screen's elements a moment later.
        // Silently dropping the click (the old behaviour) is what permanently
        // desynced the two sides: once one navigation click is lost, every later
        // click targets a screen the other side never reached. So if the element
        // isn't present yet, retry briefly before giving up.
        var doRemoteClick = function(elc) {
          enterRemote();
          try {
            if (data.clientX !== undefined && data.clientY !== undefined) {
              elc.dispatchEvent(new MouseEvent('click', {
                bubbles: true, clientX: data.clientX * window.innerWidth, clientY: data.clientY * window.innerHeight, view: window
              }));
            } else {
              elc.click();
            }
          } finally { exitRemote(); }
        };
        var rcEl = findElement(data.path);
        if (rcEl) {
          doRemoteClick(rcEl);
        } else if (data.path) {
          var rcTries = 0;
          var rcRetry = function() {
            var el2 = findElement(data.path);
            if (el2) { doRemoteClick(el2); return; }
            if (++rcTries < 6) setTimeout(rcRetry, 100);
          };
          setTimeout(rcRetry, 60);
        }
      } else if (data.type === 'REMOTE_PING') {
        // Anchor to the pinged ELEMENT when it resolves — layouts differ
        // across screens, so the element's own rect beats raw coordinates.
        var pingEl = data.path ? findElement(data.path) : null;
        if (pingEl && pingEl.getBoundingClientRect) {
          var pr = pingEl.getBoundingClientRect();
          showPing(pr.left + pr.width / 2, pr.top + pr.height / 2);
        } else if (data.clientX !== undefined) {
          showPing(data.clientX * window.innerWidth, data.clientY * window.innerHeight);
        }
      } else if (data.type === 'REMOTE_SCROLL') {
        if (!scrollSyncEnabled) return;
        enterRemote();
        try {
          // Try anchor-based sync first (works across different screen sizes)
          var anchorUsed = false;
          if (data.anchor) {
            var anchorEl = findElement(data.anchor);
            if (anchorEl) {
              var anchorRect = anchorEl.getBoundingClientRect();
              if (data.path) {
                // Element-level: scroll container so anchor is at the right offset
                var scrollEl = findElement(data.path);
                if (scrollEl) {
                  var containerRect = scrollEl.getBoundingClientRect();
                  var targetScrollTop = scrollEl.scrollTop + anchorRect.top - containerRect.top + (data.anchorOffsetPx || 0);
                  scrollEl.scrollTo({ top: Math.max(0, targetScrollTop), left: scrollEl.scrollLeft, behavior: 'smooth' });
                  anchorUsed = true;
                }
              } else {
                // Document-level: scroll so anchor is at the right offset from viewport top
                var targetTop = window.scrollY + anchorRect.top + (data.anchorOffsetPx || 0);
                window.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
                anchorUsed = true;
              }
            }
          }
          // Fallback to ratio-based sync if anchor not available
          if (!anchorUsed) {
            if (data.path) {
              var scrollEl = findElement(data.path);
              if (scrollEl) {
                var maxT = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
                var maxL = Math.max(0, scrollEl.scrollWidth - scrollEl.clientWidth);
                scrollEl.scrollTo({ left: (data.scrollLeft || 0) * maxL, top: (data.scrollTop || 0) * maxT, behavior: 'smooth' });
              }
            } else {
              var maxX = Math.max(0, document.documentElement.scrollWidth - window.innerWidth);
              var maxY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
              window.scrollTo({ left: data.scrollX * maxX, top: data.scrollY * maxY, behavior: 'smooth' });
            }
          }
        } catch(ignore) {}
        // AUTONOMOUS: [ORDER-1] Use delayed exit for smooth scroll animation duration
        setTimeout(function() {
          updateLockedWindowPos();
          exitRemote();
        }, 600);
      } else if (data.type === 'FOLLOW_CLICK') {
        // Scroll to the clicked position (used when following other user's clicks)
        try {
          enterRemote();
          var targetX = data.x * Math.max(0, document.documentElement.scrollWidth - window.innerWidth);
          var targetY = data.y * Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
          window.scrollTo({ left: targetX, top: targetY, behavior: 'smooth' });
          // Show a visual indicator at the click position
          showClickIndicator(data.x * window.innerWidth, data.y * window.innerHeight);
          setTimeout(function() { exitRemote(); }, 600);
        } catch(ignore) {}
      } else if (data.type === 'SET_ZOOM') {
        // Teacher-initiated zoom: apply + broadcast via SYNC_ZOOM
        var z = Math.max(0.5, Math.min(3, Number(data.zoom) || 1));
        _applyZoom(z);
        window.parent.postMessage({ type: 'SYNC_ZOOM', zoom: z }, '*');
      } else if (data.type === 'REMOTE_ZOOM') {
        // Student receives zoom from teacher — apply silently (no echo)
        var z2 = Math.max(0.5, Math.min(3, Number(data.zoom) || 1));
        enterRemote();
        try { _applyZoom(z2); } catch(e) {}
        setTimeout(function() { exitRemote(); }, 200);
      } else if (data.type === 'SET_SCROLL_SYNC') {
        scrollSyncEnabled = !!data.enabled;
      } else if (data.type === 'SET_INTERACTION_MODE') {
        interactionBlocked = !data.allowed;
        // Capture the current position as lock-point when entering view-only mode.
        if (interactionBlocked) updateLockedWindowPos();
      } else if (data.type === 'SET_PRESENTER_MODE') {
        presenterMode = !!data.enabled;
        if (presenterMode) interactionBlocked = false;
      } else if (data.type === 'EMIT_CURRENT_SCROLL') {
        // Bypass throttle/presenter guards and emit the current document scroll
        // so a freshly opened mirror/student can catch up immediately.
        try {
          var maxW = Math.max(0, document.documentElement.scrollWidth - window.innerWidth);
          var maxH = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
          var msg = {
            type: 'SYNC_SCROLL',
            scrollX: maxW > 0 ? window.scrollX / maxW : 0,
            scrollY: maxH > 0 ? window.scrollY / maxH : 0,
            absScrollX: window.scrollX,
            absScrollY: window.scrollY,
            maxScrollX: maxW,
            maxScrollY: maxH,
            mirrorOnly: !!data.mirrorOnly
          };
          var a = _findAnchor(null);
          if (a) { msg.anchor = a.anchor; msg.anchorOffsetPx = a.anchorOffsetPx; }
          window.parent.postMessage(msg, '*');
        } catch(ignore) {}
      } else if (data.type === 'RESET_VIEW') {
        enterRemote();
        try { window.scrollTo({ top: 0, left: 0, behavior: 'smooth' }); } catch(ignore) {}
        setTimeout(function() { exitRemote(); }, 400);
      } else if (data.type === 'REMOTE_MOUSEDOWN') {
        var el = findElement(data.path);
        if (el) {
          enterRemote();
          try { el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: data.x * window.innerWidth, clientY: data.y * window.innerHeight, button: data.button || 0 })); }
          finally { exitRemote(); }
        }
      } else if (data.type === 'REMOTE_MOUSEUP') {
        var el = findElement(data.path);
        if (el) {
          enterRemote();
          try { el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: data.x * window.innerWidth, clientY: data.y * window.innerHeight })); }
          finally { exitRemote(); }
        }
      } else if (data.type === 'REMOTE_MOUSEMOVE') {
        // Replay a drag movement. Prefer the original target element by path;
        // fall back to whatever element sits under the mapped point so the
        // gesture still lands sensibly across different screen sizes.
        enterRemote();
        try {
          var mmx = data.x * window.innerWidth;
          var mmy = data.y * window.innerHeight;
          var mmEl = data.path ? findElement(data.path) : null;
          if (!mmEl) { try { mmEl = document.elementFromPoint(mmx, mmy); } catch(e) {} }
          (mmEl || document).dispatchEvent(new MouseEvent('mousemove', {
            bubbles: true, clientX: mmx, clientY: mmy, buttons: data.buttons || 1, view: window
          }));
        } finally { exitRemote(); }
      } else if (data.type === 'REMOTE_DOM') {
        // The presenter (teacher) is the single source of truth: its iframe runs
        // the live, INTERACTIVE simulation that everyone else mirrors. Never
        // replace its DOM. A body-innerHTML swap silently drops every
        // addEventListener the page wired up on load, so the page's own buttons
        // (and the student clicks we replay into it as REMOTE_CLICK) stop doing
        // anything — the "interactive buttons stop working" bug. Mirrors/students
        // are not in presenter mode, so they still soft-swap to follow.
        if (presenterMode) return;
        // Absolute-state sync: replace the visible DOM with a snapshot of the
        // other side's iframe (so the teacher sees the student's ACTUAL state —
        // e.g. quiz question 5 — instead of a drifting replay of clicks). Soft
        // body-innerHTML swap → no reload, no flicker.
        //
        // CRITICAL: never blow away the DOM while the LOCAL user is typing — a
        // full innerHTML swap destroys the focused field and steals the caret,
        // which made the teacher unable to type whenever the student typed.
        // If the local user is editing, skip this snapshot entirely; a later
        // one applies once they're done.
        if (isEditableTarget(document.activeElement)) {
          // skip — protect the local user's in-progress typing
        } else {
          enterRemote();
          try {
            var parsed = new DOMParser().parseFromString(data.html || '', 'text/html');
            if (parsed && parsed.body && document.body) {
              document.body.innerHTML = parsed.body.innerHTML;
            }
          } catch(ignore) {}
          setTimeout(function() { exitRemote(); }, 0);
        }
      } else if (data.type === 'REMOTE_KEYDOWN') {
        enterRemote();
        try { document.dispatchEvent(new KeyboardEvent('keydown', { key: data.key, code: data.code, bubbles: true, shiftKey: data.shiftKey, ctrlKey: data.ctrlKey, altKey: data.altKey })); }
        finally { exitRemote(); }
      } else if (data.type === 'REMOTE_KEYUP') {
        enterRemote();
        try { document.dispatchEvent(new KeyboardEvent('keyup', { key: data.key, code: data.code, bubbles: true })); }
        finally { exitRemote(); }
      } else if (data.type === 'REMOTE_DRAGSTART') {
        var el = findElement(data.path);
        if (el) {
          enterRemote();
          try { el.dispatchEvent(new DragEvent('dragstart', { bubbles: true, clientX: data.clientX * window.innerWidth, clientY: data.clientY * window.innerHeight })); }
          finally { exitRemote(); }
        }
      } else if (data.type === 'REMOTE_DRAG') {
        // No-op for drag movement
      } else if (data.type === 'REMOTE_DRAGEND') {
        var el = findElement(data.path);
        if (el) {
          enterRemote();
          try { el.dispatchEvent(new DragEvent('dragend', { bubbles: true, clientX: data.clientX * window.innerWidth, clientY: data.clientY * window.innerHeight })); }
          finally { exitRemote(); }
        }
      } else if (data.type === 'REMOTE_DROP') {
        var dropEl = findElement(data.dropPath);
        if (dropEl) {
          enterRemote();
          try { dropEl.dispatchEvent(new DragEvent('drop', { bubbles: true, clientX: data.clientX * window.innerWidth, clientY: data.clientY * window.innerHeight })); }
          finally { exitRemote(); }
        }
      } else if (data.type === 'REQUEST_HTML') {
        var inputs = document.querySelectorAll('input, select, textarea');
        inputs.forEach(function(el) {
          try {
            if (el.tagName === 'INPUT') {
              if (el.type === 'checkbox' || el.type === 'radio') {
                if (el.checked) el.setAttribute('checked', 'checked');
                else el.removeAttribute('checked');
              } else {
                el.setAttribute('value', el.value);
              }
            } else if (el.tagName === 'TEXTAREA') {
              el.innerHTML = el.value;
            } else if (el.tagName === 'SELECT') {
              Array.from(el.options).forEach(function(opt) {
                if (opt.selected) opt.setAttribute('selected', 'selected');
                else opt.removeAttribute('selected');
              });
            }
          } catch(ignore) {}
        });
        var htmlClone = document.documentElement.cloneNode(true);
        try {
          // Strip BOTH injected scripts — they're re-injected on every iframe
          // build. Leaving them in the serialized snapshot meant force-sync
          // wrote them into the saved file, and each rebuild stacked another
          // copy (N duplicate message listeners after N force-syncs).
          var injected = htmlClone.querySelectorAll('#mathslive-sync-script, #mathslive-steplock-script');
          injected.forEach(function(script) { script.parentNode && script.parentNode.removeChild(script); });
        } catch(ignore) {}
        window.parent.postMessage({
          type: 'SYNC_PROVIDE_HTML',
          requestId: data.requestId,
          html: '<!DOCTYPE html>\\n' + htmlClone.outerHTML,
          scrollX: window.scrollX,
          scrollY: window.scrollY,
          // Canvas/WebGL content can't be serialized via outerHTML — the
          // parent/server use this to keep the pristine source as the boot
          // state for late-joiners instead of a blank canvas shell.
          hasCanvas: !!document.querySelector('canvas')
        }, '*');
      }
    });
  })();
</script>
`;

// Bake the server-issued deterministic seed into the script at blob-build
// time. The raw template carries a placeholder that is INVALID JS on its own,
// so always build the injected script through this — never inject
// `injectedSyncScript` directly. seed 0/absent → the script falls back to a
// body-text hash.
export function seededSyncScript(seed: number | null | undefined): string {
  const n = typeof seed === 'number' && Number.isFinite(seed) && seed > 0 ? Math.floor(seed) : 0;
  return injectedSyncScript.replace('__MATHSLIVE_SEED__', String(n));
}
