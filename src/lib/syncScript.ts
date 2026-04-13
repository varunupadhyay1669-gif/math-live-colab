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
    let isRemoteUpdate = false;

    // ── Deterministic Randomness ──
    // Overriding Math.random so that both Teacher and Student generate the exact same sequences
    (function() {
      function hashCode(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
          let char = str.charCodeAt(i);
          hash = ((hash << 5) - hash) + char;
          hash = hash & hash;
        }
        return Math.abs(hash) || 12345;
      }
      // Seed based on the body text content only (ignoring injected scripts)
      // This ensures teacher and student get the same seed even if scripts differ
      function getStableSeed() {
        var body = document.body;
        if (!body) return 12345;
        var text = body.textContent || '';
        return hashCode(text.trim().substring(0, 500));
      }

      var seed;
      if (document.readyState === 'loading') {
        // Use a temp seed, re-seed after DOMContentLoaded
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
      // Prefer id-based paths (most reliable)
      if (el.id) return '#' + CSS.escape(el.id);

      var path = [];
      while (el && el.nodeType === 1) {
        var selector = el.nodeName.toLowerCase();
        if (el.id) {
          selector += '#' + CSS.escape(el.id);
          path.unshift(selector);
          break;
        } else {
          // Use nth-child for uniqueness (more reliable than nth-of-type)
          var sib = el, nth = 1;
          while (sib = sib.previousElementSibling) nth++;
          selector += ':nth-child(' + nth + ')';
        }
        path.unshift(selector);
        el = el.parentNode;
        // Stop at body to avoid html/head differences
        if (el && el.nodeName === 'BODY') {
          path.unshift('body');
          break;
        }
      }
      return path.join(' > ');
    }

    // ── Safe query helper ──
    function findElement(path) {
      if (!path) return null;
      try { return document.querySelector(path); } catch(e) { return null; }
    }

    // ── Input events ──
    document.addEventListener('input', function(e) {
      if (isRemoteUpdate) return;
      var path = getElementPath(e.target);
      if (path) {
        window.parent.postMessage({ type: 'SYNC_INPUT', path: path, value: e.target.value, checked: e.target.checked }, '*');
      }
    }, true);

    document.addEventListener('change', function(e) {
      if (isRemoteUpdate) return;
      var path = getElementPath(e.target);
      if (path) {
        window.parent.postMessage({ type: 'SYNC_CHANGE', path: path, value: e.target.value, checked: e.target.checked }, '*');
      }
    }, true);

    // ── Click events ──
    document.addEventListener('click', function(e) {
      if (isRemoteUpdate || !e.isTrusted) return;
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
        window.parent.postMessage({
          type: 'SYNC_CURSOR',
          x: e.clientX / window.innerWidth,
          y: e.clientY / window.innerHeight
        }, '*');
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
          window.parent.postMessage({
            type: 'SYNC_CURSOR',
            x: touch.clientX / window.innerWidth,
            y: touch.clientY / window.innerHeight
          }, '*');
        }
      }
    }, { passive: true });

    document.addEventListener('touchstart', function(e) {
      if (isRemoteUpdate) return;
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
      if (isRemoteUpdate || !scrollSyncEnabled) return;
      var now = Date.now();
      if (now - lastScroll < 30) return;
      lastScroll = now;
      var maxW = document.documentElement.scrollWidth - window.innerWidth;
      var maxH = document.documentElement.scrollHeight - window.innerHeight;
      window.parent.postMessage({
        type: 'SYNC_SCROLL',
        scrollX: maxW > 0 ? window.scrollX / maxW : 0,
        scrollY: maxH > 0 ? window.scrollY / maxH : 0,
        // Also send absolute pixel values for more accurate sync
        absScrollX: window.scrollX,
        absScrollY: window.scrollY,
        maxScrollX: maxW,
        maxScrollY: maxH
      }, '*');
    }

    function sendElementScroll(e) {
      if (isRemoteUpdate || !scrollSyncEnabled) return;
      var now = Date.now();
      if (now - lastScroll < 30) return;
      lastScroll = now;
      var el = e.currentTarget || e.target;
      if (!el || el.nodeType !== 1) return;
      var path = getElementPath(el);
      if (!path) return;
      var maxTop = el.scrollHeight - el.clientHeight;
      var maxLeft = el.scrollWidth - el.clientWidth;
      if (maxTop > 0 || maxLeft > 0) {
        window.parent.postMessage({
          type: 'SYNC_SCROLL',
          path: path,
          scrollTop: maxTop > 0 ? el.scrollTop / maxTop : 0,
          scrollLeft: maxLeft > 0 ? el.scrollLeft / maxLeft : 0,
          absScrollTop: el.scrollTop,
          absScrollLeft: el.scrollLeft
        }, '*');
      }
    }

    // Document-level scroll
    window.addEventListener('scroll', sendDocScroll, { passive: true });

    // Discover scrollable elements and attach direct listeners
    var _scrollTag = '__syncScroll';
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

    function _initScrollMonitor() {
      _attachScrollListeners();
      try {
        new MutationObserver(function() { setTimeout(_attachScrollListeners, 150); })
          .observe(document.documentElement || document.body, { childList: true, subtree: true });
      } catch(ignore) {}
      setInterval(_attachScrollListeners, 3000);
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', _initScrollMonitor);
    } else {
      setTimeout(_initScrollMonitor, 100);
    }
    window.addEventListener('load', function() { setTimeout(_attachScrollListeners, 300); });

    // ── Mouse down/up events ──
    document.addEventListener('mousedown', function(e) {
      if (isRemoteUpdate || !e.isTrusted) return;
      var path = getElementPath(e.target);
      if (path) {
        window.parent.postMessage({
          type: 'SYNC_MOUSEDOWN',
          path: path,
          x: e.clientX / window.innerWidth,
          y: e.clientY / window.innerHeight,
          button: e.button
        }, '*');
      }
    }, true);

    document.addEventListener('mouseup', function(e) {
      if (isRemoteUpdate || !e.isTrusted) return;
      var path = getElementPath(e.target);
      if (path) {
        window.parent.postMessage({
          type: 'SYNC_MOUSEUP',
          path: path,
          x: e.clientX / window.innerWidth,
          y: e.clientY / window.innerHeight
        }, '*');
      }
    }, true);

    // ── HTML5 Drag/Drop sync ──
    var dragStartPath = '';
    var lastDrag = 0;

    document.addEventListener('dragstart', function(e) {
      if (isRemoteUpdate) return;
      dragStartPath = getElementPath(e.target);
      window.parent.postMessage({
        type: 'SYNC_DRAGSTART',
        path: dragStartPath,
        clientX: e.clientX / window.innerWidth,
        clientY: e.clientY / window.innerHeight
      }, '*');
    }, true);

    document.addEventListener('drag', function(e) {
      if (isRemoteUpdate || !e.clientX) return;
      var now = Date.now();
      if (now - lastDrag < 50) return;
      lastDrag = now;
      window.parent.postMessage({
        type: 'SYNC_DRAG',
        path: dragStartPath,
        clientX: e.clientX / window.innerWidth,
        clientY: e.clientY / window.innerHeight
      }, '*');
    }, true);

    document.addEventListener('dragend', function(e) {
      if (isRemoteUpdate) return;
      window.parent.postMessage({
        type: 'SYNC_DRAGEND',
        path: dragStartPath,
        clientX: e.clientX / window.innerWidth,
        clientY: e.clientY / window.innerHeight
      }, '*');
      dragStartPath = '';
    }, true);

    document.addEventListener('drop', function(e) {
      if (isRemoteUpdate) return;
      e.preventDefault();
      var dropPath = getElementPath(e.target);
      window.parent.postMessage({
        type: 'SYNC_DROP',
        dragPath: dragStartPath,
        dropPath: dropPath,
        clientX: e.clientX / window.innerWidth,
        clientY: e.clientY / window.innerHeight
      }, '*');
    }, true);

    document.addEventListener('dragover', function(e) {
      e.preventDefault();
    }, true);

    // ── Key events for simulations ──
    document.addEventListener('keydown', function(e) {
      if (isRemoteUpdate) return;
      window.parent.postMessage({
        type: 'SYNC_KEYDOWN',
        key: e.key,
        code: e.code,
        shiftKey: e.shiftKey,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey
      }, '*');
    }, true);

    document.addEventListener('keyup', function(e) {
      if (isRemoteUpdate) return;
      window.parent.postMessage({
        type: 'SYNC_KEYUP',
        key: e.key,
        code: e.code
      }, '*');
    }, true);

    // ── Receive remote events ──
    window.addEventListener('message', function(e) {
      var data = e.data;
      if (!data || !data.type) return;

      if (data.type === 'REMOTE_INPUT' || data.type === 'REMOTE_CHANGE') {
        var el = findElement(data.path);
        if (el) {
          isRemoteUpdate = true;
          if (el.type === 'checkbox' || el.type === 'radio') {
            el.checked = data.checked;
          } else {
            el.value = data.value;
          }
          var event = new Event(data.type === 'REMOTE_INPUT' ? 'input' : 'change', { bubbles: true });
          el.dispatchEvent(event);
          isRemoteUpdate = false;
        }
      } else if (data.type === 'REMOTE_CLICK') {
        var el = findElement(data.path);
        if (el) {
          isRemoteUpdate = true;
          // Use coordinates if available for more precise clicking
          if (data.clientX !== undefined && data.clientY !== undefined) {
            var rect = el.getBoundingClientRect();
            el.dispatchEvent(new MouseEvent('click', {
              bubbles: true,
              clientX: data.clientX * window.innerWidth,
              clientY: data.clientY * window.innerHeight,
              view: window
            }));
          } else {
            el.click();
          }
          isRemoteUpdate = false;
        }
      } else if (data.type === 'REMOTE_SCROLL') {
        if (!scrollSyncEnabled) return;
        isRemoteUpdate = true;
        if (data.path) {
          // Element-level scroll
          var scrollEl = findElement(data.path);
          if (scrollEl) {
            var maxT = scrollEl.scrollHeight - scrollEl.clientHeight;
            var maxL = scrollEl.scrollWidth - scrollEl.clientWidth;
            scrollEl.scrollTo({
              left: (data.scrollLeft || 0) * maxL,
              top: (data.scrollTop || 0) * maxT,
              behavior: 'smooth'
            });
          }
        } else {
          // Document-level scroll
          var maxX = document.documentElement.scrollWidth - window.innerWidth;
          var maxY = document.documentElement.scrollHeight - window.innerHeight;
          window.scrollTo({
            left: data.scrollX * maxX,
            top: data.scrollY * maxY,
            behavior: 'smooth'
          });
        }
        setTimeout(function() { isRemoteUpdate = false; }, 200);
      } else if (data.type === 'SET_SCROLL_SYNC') {
        scrollSyncEnabled = !!data.enabled;
      } else if (data.type === 'REMOTE_MOUSEDOWN') {
        var el = findElement(data.path);
        if (el) {
          isRemoteUpdate = true;
          el.dispatchEvent(new MouseEvent('mousedown', {
            bubbles: true, clientX: data.x * window.innerWidth, clientY: data.y * window.innerHeight, button: data.button || 0
          }));
          isRemoteUpdate = false;
        }
      } else if (data.type === 'REMOTE_MOUSEUP') {
        var el = findElement(data.path);
        if (el) {
          isRemoteUpdate = true;
          el.dispatchEvent(new MouseEvent('mouseup', {
            bubbles: true, clientX: data.x * window.innerWidth, clientY: data.y * window.innerHeight
          }));
          isRemoteUpdate = false;
        }
      } else if (data.type === 'REMOTE_KEYDOWN') {
        isRemoteUpdate = true;
        document.dispatchEvent(new KeyboardEvent('keydown', {
          key: data.key, code: data.code, bubbles: true, shiftKey: data.shiftKey, ctrlKey: data.ctrlKey, altKey: data.altKey
        }));
        isRemoteUpdate = false;
      } else if (data.type === 'REMOTE_KEYUP') {
        isRemoteUpdate = true;
        document.dispatchEvent(new KeyboardEvent('keyup', {
          key: data.key, code: data.code, bubbles: true
        }));
        isRemoteUpdate = false;
      } else if (data.type === 'REMOTE_DRAGSTART') {
        isRemoteUpdate = true;
        var el = findElement(data.path);
        if (el) {
          el.dispatchEvent(new DragEvent('dragstart', {
            bubbles: true, clientX: data.clientX * window.innerWidth, clientY: data.clientY * window.innerHeight
          }));
        }
        isRemoteUpdate = false;
      } else if (data.type === 'REMOTE_DRAG') {
        isRemoteUpdate = true;
        isRemoteUpdate = false;
      } else if (data.type === 'REMOTE_DRAGEND') {
        isRemoteUpdate = true;
        var el = findElement(data.path);
        if (el) {
          el.dispatchEvent(new DragEvent('dragend', {
            bubbles: true, clientX: data.clientX * window.innerWidth, clientY: data.clientY * window.innerHeight
          }));
        }
        isRemoteUpdate = false;
      } else if (data.type === 'REMOTE_DROP') {
        isRemoteUpdate = true;
        var dropEl = findElement(data.dropPath);
        if (dropEl) {
          dropEl.dispatchEvent(new DragEvent('drop', {
            bubbles: true, clientX: data.clientX * window.innerWidth, clientY: data.clientY * window.innerHeight
          }));
        }
        isRemoteUpdate = false;
      } else if (data.type === 'REQUEST_HTML') {
        // Capture current form state into attributes for serialization
        var inputs = document.querySelectorAll('input, select, textarea');
        inputs.forEach(function(el) {
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
