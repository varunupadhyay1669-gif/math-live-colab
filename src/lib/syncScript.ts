export const injectedSyncScript = `
<script>
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
    }, { passive: true });

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

    function sendDocScroll() {
      if (isRemote() || !scrollSyncEnabled || interactionBlocked) return;
      var now = Date.now();
      if (now - lastScroll < 30) return;
      lastScroll = now;
      var maxW = Math.max(0, document.documentElement.scrollWidth - window.innerWidth);
      var maxH = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      // AUTONOMOUS: [ORDER-3] Guard against zero/negative max to avoid NaN
      window.parent.postMessage({
        type: 'SYNC_SCROLL',
        scrollX: maxW > 0 ? window.scrollX / maxW : 0,
        scrollY: maxH > 0 ? window.scrollY / maxH : 0,
        absScrollX: window.scrollX,
        absScrollY: window.scrollY,
        maxScrollX: maxW,
        maxScrollY: maxH
      }, '*');
    }

    function sendElementScroll(e) {
      if (isRemote() || !scrollSyncEnabled || interactionBlocked) return;
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
        window.parent.postMessage({
          type: 'SYNC_SCROLL', path: path,
          scrollTop: maxTop > 0 ? el.scrollTop / maxTop : 0,
          scrollLeft: maxLeft > 0 ? el.scrollLeft / maxLeft : 0,
          absScrollTop: el.scrollTop, absScrollLeft: el.scrollLeft
        }, '*');
      }
    }

    window.addEventListener('scroll', sendDocScroll, { passive: true });

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
        } catch(ignore) {}
        // AUTONOMOUS: [ORDER-1] Use delayed exit for smooth scroll animation duration
        setTimeout(function() { exitRemote(); }, 600);
      } else if (data.type === 'SET_SCROLL_SYNC') {
        scrollSyncEnabled = !!data.enabled;
      } else if (data.type === 'SET_INTERACTION_MODE') {
        interactionBlocked = !data.allowed;
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
        window.parent.postMessage({
          type: 'SYNC_PROVIDE_HTML',
          html: '<!DOCTYPE html>\\n<html>' + document.documentElement.innerHTML + '</html>',
          scrollX: window.scrollX,
          scrollY: window.scrollY
        }, '*');
      }
    });
  })();
</script>
`;
