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

    // ── Scroll sync (throttled, guarded against loops) ──
    let lastScroll = 0;
    document.addEventListener('scroll', (e) => {
      if (isRemoteUpdate) return;
      const now = Date.now();
      if (now - lastScroll > 200) {
        lastScroll = now;
        const maxW = document.documentElement.scrollWidth - window.innerWidth;
        const maxH = document.documentElement.scrollHeight - window.innerHeight;
        if (maxW > 0 || maxH > 0) {
          window.parent.postMessage({ 
            type: 'SYNC_SCROLL', 
            scrollX: maxW > 0 ? window.scrollX / maxW : 0, 
            scrollY: maxH > 0 ? window.scrollY / maxH : 0 
          }, '*');
        }
      }
    }, true);

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
        isRemoteUpdate = true;
        const maxX = document.documentElement.scrollWidth - window.innerWidth;
        const maxY = document.documentElement.scrollHeight - window.innerHeight;
        window.scrollTo({ left: data.scrollX * maxX, top: data.scrollY * maxY, behavior: 'instant' });
        setTimeout(() => { isRemoteUpdate = false; }, 100);
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
      }
    });
  })();
</script>
`;
