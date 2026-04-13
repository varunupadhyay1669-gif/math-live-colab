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
    // of questions/numbers when interacting with the simulation.
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
      // Seed based on initial HTML structure (which matches exactly when loaded)
      let seed = hashCode(document.documentElement.innerHTML);
      if (seed < 1000) seed += 123456789;
      
      Math.random = function() {
        let t = seed += 0x6D2B79F5;
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
      };
    })();
    
    function getElementPath(el) {
      if (!el || el.nodeType !== 1) return '';
      if (el.id) return '#' + el.id;
      let path = [];
      while (el && el.nodeType === 1) {
        let selector = el.nodeName.toLowerCase();
        if (el.id) {
          selector += '#' + el.id;
          path.unshift(selector);
          break;
        } else {
          let sib = el, nth = 1;
          while (sib = sib.previousElementSibling) {
            if (sib.nodeName.toLowerCase() == selector) nth++;
          }
          if (nth != 1) selector += ":nth-of-type("+nth+")";
        }
        path.unshift(selector);
        el = el.parentNode;
      }
      return path.join(' > ');
    }

    // ── Input events ──
    document.addEventListener('input', (e) => {
      if (isRemoteUpdate) return;
      const path = getElementPath(e.target);
      if (path) {
        window.parent.postMessage({ type: 'SYNC_INPUT', path, value: e.target.value, checked: e.target.checked }, '*');
      }
    }, true);

    document.addEventListener('change', (e) => {
      if (isRemoteUpdate) return;
      const path = getElementPath(e.target);
      if (path) {
        window.parent.postMessage({ type: 'SYNC_CHANGE', path, value: e.target.value, checked: e.target.checked }, '*');
      }
    }, true);

    // ── Click events ──
    document.addEventListener('click', (e) => {
      if (isRemoteUpdate || !e.isTrusted) return;
      const path = getElementPath(e.target);
      if (path) {
        window.parent.postMessage({ type: 'SYNC_CLICK', path }, '*');
      }
    }, true);

    // ── Mouse move for cursors (throttled) ──
    let lastMove = 0;
    document.addEventListener('mousemove', (e) => {
      const now = Date.now();
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
    let lastTouch = 0;
    document.addEventListener('touchmove', (e) => {
      const now = Date.now();
      if (now - lastTouch > 80) {
        lastTouch = now;
        const touch = e.touches[0];
        if (touch) {
          window.parent.postMessage({ 
            type: 'SYNC_CURSOR', 
            x: touch.clientX / window.innerWidth, 
            y: touch.clientY / window.innerHeight 
          }, '*');
        }
      }
    }, { passive: true });

    document.addEventListener('touchstart', (e) => {
      if (isRemoteUpdate) return;
      const touch = e.touches[0];
      if (touch) {
        const el = document.elementFromPoint(touch.clientX, touch.clientY);
        if (el) {
          const path = getElementPath(el);
          if (path) {
            window.parent.postMessage({ type: 'SYNC_CLICK', path }, '*');
          }
        }
      }
    }, { passive: true });

    // ── Scroll sync (toggleable, smooth) ──
    let scrollSyncEnabled = true;
    let lastScroll = 0;

    function sendDocScroll() {
      if (isRemoteUpdate || !scrollSyncEnabled) return;
      var now = Date.now();
      if (now - lastScroll < 50) return;
      lastScroll = now;
      var maxW = document.documentElement.scrollWidth - window.innerWidth;
      var maxH = document.documentElement.scrollHeight - window.innerHeight;
      if (maxW > 0 || maxH > 0) {
        window.parent.postMessage({ 
          type: 'SYNC_SCROLL', 
          scrollX: maxW > 0 ? window.scrollX / maxW : 0, 
          scrollY: maxH > 0 ? window.scrollY / maxH : 0 
        }, '*');
      }
    }

    function sendElementScroll(e) {
      if (isRemoteUpdate || !scrollSyncEnabled) return;
      var now = Date.now();
      if (now - lastScroll < 50) return;
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
          scrollLeft: maxLeft > 0 ? el.scrollLeft / maxLeft : 0
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

    // ── Drag events ──
    document.addEventListener('mousedown', (e) => {
      if (isRemoteUpdate || !e.isTrusted) return;
      const path = getElementPath(e.target);
      if (path) {
        window.parent.postMessage({ 
          type: 'SYNC_MOUSEDOWN', 
          path,
          x: e.clientX / window.innerWidth,
          y: e.clientY / window.innerHeight
        }, '*');
      }
    }, true);

    document.addEventListener('mouseup', (e) => {
      if (isRemoteUpdate || !e.isTrusted) return;
      const path = getElementPath(e.target);
      if (path) {
        window.parent.postMessage({ 
          type: 'SYNC_MOUSEUP', 
          path,
          x: e.clientX / window.innerWidth,
          y: e.clientY / window.innerHeight
        }, '*');
      }
    }, true);

    // ── HTML5 Drag/Drop sync ──
    let dragStartPath = '';
    let lastDrag = 0;

    document.addEventListener('dragstart', (e) => {
      if (isRemoteUpdate) return;
      dragStartPath = getElementPath(e.target);
      window.parent.postMessage({
        type: 'SYNC_DRAGSTART',
        path: dragStartPath,
        clientX: e.clientX / window.innerWidth,
        clientY: e.clientY / window.innerHeight
      }, '*');
    }, true);

    document.addEventListener('drag', (e) => {
      if (isRemoteUpdate || !e.clientX) return;
      const now = Date.now();
      if (now - lastDrag < 50) return; // throttle
      lastDrag = now;
      window.parent.postMessage({
        type: 'SYNC_DRAG',
        path: dragStartPath,
        clientX: e.clientX / window.innerWidth,
        clientY: e.clientY / window.innerHeight
      }, '*');
    }, true);

    document.addEventListener('dragend', (e) => {
      if (isRemoteUpdate) return;
      window.parent.postMessage({
        type: 'SYNC_DRAGEND',
        path: dragStartPath,
        clientX: e.clientX / window.innerWidth,
        clientY: e.clientY / window.innerHeight
      }, '*');
      dragStartPath = '';
    }, true);

    document.addEventListener('drop', (e) => {
      if (isRemoteUpdate) return;
      e.preventDefault();
      const dropPath = getElementPath(e.target);
      window.parent.postMessage({
        type: 'SYNC_DROP',
        dragPath: dragStartPath,
        dropPath: dropPath,
        clientX: e.clientX / window.innerWidth,
        clientY: e.clientY / window.innerHeight
      }, '*');
    }, true);

    document.addEventListener('dragover', (e) => {
      e.preventDefault(); // Required to allow drops
    }, true);

    // ── Key events for simulations ──
    document.addEventListener('keydown', (e) => {
      if (isRemoteUpdate) return;
      window.parent.postMessage({ 
        type: 'SYNC_KEYDOWN', 
        key: e.key, 
        code: e.code,
        shiftKey: e.shiftKey,
        ctrlKey: e.ctrlKey
      }, '*');
    }, true);

    document.addEventListener('keyup', (e) => {
      if (isRemoteUpdate) return;
      window.parent.postMessage({ 
        type: 'SYNC_KEYUP', 
        key: e.key, 
        code: e.code
      }, '*');
    }, true);

    // ── Receive remote events ──
    window.addEventListener('message', (e) => {
      const data = e.data;
      if (!data || !data.type) return;
      
      if (data.type === 'REMOTE_INPUT' || data.type === 'REMOTE_CHANGE') {
        const el = document.querySelector(data.path);
        if (el) {
          isRemoteUpdate = true;
          if (el.type === 'checkbox' || el.type === 'radio') {
            el.checked = data.checked;
          } else {
            el.value = data.value;
          }
          const event = new Event(data.type === 'REMOTE_INPUT' ? 'input' : 'change', { bubbles: true });
          el.dispatchEvent(event);
          isRemoteUpdate = false;
        }
      } else if (data.type === 'REMOTE_CLICK') {
        const el = document.querySelector(data.path);
        if (el) {
          isRemoteUpdate = true;
          el.click();
          isRemoteUpdate = false;
        }
      } else if (data.type === 'REMOTE_SCROLL') {
        if (!scrollSyncEnabled) return;
        isRemoteUpdate = true;
        if (data.path) {
          // Element-level scroll
          var scrollEl = document.querySelector(data.path);
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
          window.scrollTo({ left: data.scrollX * maxX, top: data.scrollY * maxY, behavior: 'smooth' });
        }
        setTimeout(function() { isRemoteUpdate = false; }, 300);
      } else if (data.type === 'SET_SCROLL_SYNC') {
        scrollSyncEnabled = !!data.enabled;
      } else if (data.type === 'REMOTE_MOUSEDOWN') {
        const el = document.querySelector(data.path);
        if (el) {
          isRemoteUpdate = true;
          const rect = el.getBoundingClientRect();
          el.dispatchEvent(new MouseEvent('mousedown', { 
            bubbles: true, clientX: data.x * window.innerWidth, clientY: data.y * window.innerHeight 
          }));
          isRemoteUpdate = false;
        }
      } else if (data.type === 'REMOTE_MOUSEUP') {
        const el = document.querySelector(data.path);
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
          key: data.key, code: data.code, bubbles: true, shiftKey: data.shiftKey, ctrlKey: data.ctrlKey 
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
        var el = data.path ? document.querySelector(data.path) : null;
        if (el) {
          el.dispatchEvent(new DragEvent('dragstart', {
            bubbles: true, clientX: data.clientX * window.innerWidth, clientY: data.clientY * window.innerHeight
          }));
        }
        isRemoteUpdate = false;
      } else if (data.type === 'REMOTE_DRAG') {
        // Drag events are informational — the remote side tracks position
        isRemoteUpdate = true;
        isRemoteUpdate = false;
      } else if (data.type === 'REMOTE_DRAGEND') {
        isRemoteUpdate = true;
        var el = data.path ? document.querySelector(data.path) : null;
        if (el) {
          el.dispatchEvent(new DragEvent('dragend', {
            bubbles: true, clientX: data.clientX * window.innerWidth, clientY: data.clientY * window.innerHeight
          }));
        }
        isRemoteUpdate = false;
      } else if (data.type === 'REMOTE_DROP') {
        isRemoteUpdate = true;
        var dropEl = data.dropPath ? document.querySelector(data.dropPath) : null;
        if (dropEl) {
          dropEl.dispatchEvent(new DragEvent('drop', {
            bubbles: true, clientX: data.clientX * window.innerWidth, clientY: data.clientY * window.innerHeight
          }));
        }
        isRemoteUpdate = false;
      } else if (data.type === 'REQUEST_HTML') {
        const inputs = document.querySelectorAll('input, select, textarea');
        inputs.forEach(el => {
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
                Array.from(el.options).forEach(opt => {
                    if (opt.selected) opt.setAttribute('selected', 'selected');
                    else opt.removeAttribute('selected');
                });
            }
        });
        
        window.parent.postMessage({ 
            type: 'SYNC_PROVIDE_HTML', 
            html: '<!DOCTYPE html>\n<html>' + document.documentElement.innerHTML + '</html>' 
        }, '*');
      }
    });
  })();
</script>
`;
