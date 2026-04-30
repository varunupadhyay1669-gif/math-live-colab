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

    // Strict scroll blocking for view-only mode
    function enforceScrollLock() {
      if (!interactionBlocked || isRemote()) return;
      var currX = window.scrollX || 0;
      var currY = window.scrollY || 0;
      if (currX !== lockedWindowX || currY !== lockedWindowY) {
        enterRemote();
        window.scrollTo(lockedWindowX, lockedWindowY);
        setTimeout(function() { exitRemote(); }, 0);
      }
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
    (function() {
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
      if (document.readyState === 'loading') {
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
      if (isRemote() || interactionBlocked) return;
      var path = getElementPath(e.target);
      if (path) {
        window.parent.postMessage({ type: 'SYNC_INPUT', path: path, value: e.target.value, checked: e.target.checked }, '*');
      }
    }, true);

    document.addEventListener('change', function(e) {
      if (isRemote() || interactionBlocked) return;
      var path = getElementPath(e.target);
      if (path) {
        window.parent.postMessage({ type: 'SYNC_CHANGE', path: path, value: e.target.value, checked: e.target.checked }, '*');
      }
    }, true);

    // ── Click events ──
    document.addEventListener('click', function(e) {
      if (isRemote() || interactionBlocked || !e.isTrusted) return;
      var path = getElementPath(e.target);
      if (path) {
        window.parent.postMessage({ type: 'SYNC_CLICK', path: path, clientX: e.clientX / window.innerWidth, clientY: e.clientY / window.innerHeight }, '*');
      }
    }, true);

    // ── Mouse move for cursors (throttled) ──
    var lastMove = 0;
    document.addEventListener('mousemove', function(e) {
      var now = Date.now();
      if (now - lastMove > 50) {
        lastMove = now;
        window.parent.postMessage({ type: 'SYNC_CURSOR', x: e.clientX / window.innerWidth, y: e.clientY / window.innerHeight }, '*');
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
      if (isRemote() || interactionBlocked) return;
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
      if (isRemote() || interactionBlocked || !e.isTrusted) return;
      var path = getElementPath(e.target);
      if (path) {
        window.parent.postMessage({ type: 'SYNC_MOUSEDOWN', path: path, x: e.clientX / window.innerWidth, y: e.clientY / window.innerHeight, button: e.button }, '*');
      }
    }, true);

    document.addEventListener('mouseup', function(e) {
      if (isRemote() || interactionBlocked || !e.isTrusted) return;
      var path = getElementPath(e.target);
      if (path) {
        window.parent.postMessage({ type: 'SYNC_MOUSEUP', path: path, x: e.clientX / window.innerWidth, y: e.clientY / window.innerHeight }, '*');
      }
    }, true);

    // ── HTML5 Drag/Drop sync ──
    var dragStartPath = '';
    var lastDrag = 0;

    document.addEventListener('dragstart', function(e) {
      if (isRemote() || interactionBlocked) return;
      dragStartPath = getElementPath(e.target);
      window.parent.postMessage({ type: 'SYNC_DRAGSTART', path: dragStartPath, clientX: e.clientX / window.innerWidth, clientY: e.clientY / window.innerHeight }, '*');
    }, true);

    document.addEventListener('drag', function(e) {
      if (isRemote() || interactionBlocked || !e.clientX) return;
      var now = Date.now();
      if (now - lastDrag < 50) return;
      lastDrag = now;
      window.parent.postMessage({ type: 'SYNC_DRAG', path: dragStartPath, clientX: e.clientX / window.innerWidth, clientY: e.clientY / window.innerHeight }, '*');
    }, true);

    document.addEventListener('dragend', function(e) {
      if (isRemote() || interactionBlocked) return;
      window.parent.postMessage({ type: 'SYNC_DRAGEND', path: dragStartPath, clientX: e.clientX / window.innerWidth, clientY: e.clientY / window.innerHeight }, '*');
      dragStartPath = '';
    }, true);

    document.addEventListener('drop', function(e) {
      if (isRemote() || interactionBlocked) return;
      e.preventDefault();
      var dropPath = getElementPath(e.target);
      window.parent.postMessage({ type: 'SYNC_DROP', dragPath: dragStartPath, dropPath: dropPath, clientX: e.clientX / window.innerWidth, clientY: e.clientY / window.innerHeight }, '*');
    }, true);

    document.addEventListener('dragover', function(e) { e.preventDefault(); }, true);

    // ── Key events for simulations ──
    document.addEventListener('keydown', function(e) {
      if (isRemote() || interactionBlocked) return;
      window.parent.postMessage({ type: 'SYNC_KEYDOWN', key: e.key, code: e.code, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey }, '*');
    }, true);

    document.addEventListener('keyup', function(e) {
      if (isRemote() || interactionBlocked) return;
      window.parent.postMessage({ type: 'SYNC_KEYUP', key: e.key, code: e.code }, '*');
    }, true);

    // ── Receive remote events ──
    // AUTONOMOUS: [ORDER-1] All dispatchEvent calls wrapped in try-finally to prevent stuck flags
    window.addEventListener('message', function(e) {
      var data = e.data;
      if (!data || !data.type) return;

      if (data.type === 'REMOTE_INPUT' || data.type === 'REMOTE_CHANGE') {
        var el = findElement(data.path);
        if (el) {
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
        var el = findElement(data.path);
        if (el) {
          enterRemote();
          try {
            if (data.clientX !== undefined && data.clientY !== undefined) {
              el.dispatchEvent(new MouseEvent('click', {
                bubbles: true, clientX: data.clientX * window.innerWidth, clientY: data.clientY * window.innerHeight, view: window
              }));
            } else {
              el.click();
            }
          } finally { exitRemote(); }
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
          var syncScripts = htmlClone.querySelectorAll('#mathslive-sync-script');
          syncScripts.forEach(function(script) { script.parentNode && script.parentNode.removeChild(script); });
        } catch(ignore) {}
        window.parent.postMessage({
          type: 'SYNC_PROVIDE_HTML',
          requestId: data.requestId,
          html: '<!DOCTYPE html>\\n' + htmlClone.outerHTML,
          scrollX: window.scrollX,
          scrollY: window.scrollY
        }, '*');
      }
    });
  })();
</script>
`;
