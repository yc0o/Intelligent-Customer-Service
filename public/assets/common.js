/* 共用工具：请求、格式化、弹窗、SSE */
(function () {
  'use strict';

  const KEYS = { staff: 'cs_staff_token', visitor: 'cs_visitor_token' };
  let scope = 'staff';

  const store = {
    setScope(s) {
      scope = s === 'visitor' ? 'visitor' : 'staff';
      // 支持通过 ?token=xxx 直接进入（便于演示与验收链接）
      try {
        const url = new URL(location.href);
        const t = url.searchParams.get('token');
        if (t) {
          localStorage.setItem(KEYS[scope], t);
          url.searchParams.delete('token');
          history.replaceState(null, '', url.pathname + (url.search ? url.search : '') + url.hash);
        }
      } catch { /* ignore */ }
    },
    get scope() { return scope; },
    get token() { return localStorage.getItem(KEYS[scope]) || ''; },
    set token(v) { if (v) localStorage.setItem(KEYS[scope], v); else localStorage.removeItem(KEYS[scope]); }
  };

  async function api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json' };
    const token = opts.token !== undefined ? opts.token : store.token;
    if (token) headers['x-token'] = token;
    const res = await fetch(`/api${path}`, {
      method: opts.method || 'GET',
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    let payload = null;
    try { payload = await res.json(); } catch { /* ignore */ }
    if (!res.ok || !payload || payload.ok === false) {
      const err = new Error((payload && payload.error && payload.error.message) || `请求失败 (${res.status})`);
      err.code = payload && payload.error ? payload.error.code : 'http_error';
      err.status = res.status;
      throw err;
    }
    return payload.data;
  }

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const pad = (n) => String(n).padStart(2, '0');

  function fmtTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function fmtFull(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function relTime(iso) {
    if (!iso) return '—';
    const diff = (Date.now() - new Date(iso)) / 1000;
    if (diff < 60) return '刚刚';
    if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
    if (diff < 86400) return fmtTime(iso);
    return fmtDate(iso).slice(0, 5);
  }

  function dur(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    if (s < 60) return `${s} 秒`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} 分 ${s % 60} 秒`;
    return `${Math.floor(m / 60)} 时 ${m % 60} 分`;
  }

  function durMin(min) {
    if (min == null) return '—';
    if (min < 1) return '不足 1 分钟';
    if (min < 60) return `${Math.round(min)} 分钟`;
    return `${Math.floor(min / 60)} 小时 ${Math.round(min % 60)} 分`;
  }

  function initials(name) {
    const s = String(name || '?').trim();
    if (!s) return '?';
    if (/^[a-zA-Z]/.test(s)) return s.slice(0, 2).toUpperCase();
    return s.slice(-2);
  }

  function stars(n) {
    return '★★★★★'.slice(0, Math.round(n)) + '☆☆☆☆☆'.slice(0, 5 - Math.round(n));
  }

  /* ---------- toast ---------- */
  let toastWrap = null;
  function toast(msg, type = '') {
    if (!toastWrap) {
      toastWrap = document.createElement('div');
      toastWrap.className = 'toast-wrap';
      document.body.appendChild(toastWrap);
    }
    const node = document.createElement('div');
    node.className = `toast ${type}`;
    node.textContent = msg;
    toastWrap.appendChild(node);
    setTimeout(() => {
      node.style.transition = 'opacity .2s, transform .2s';
      node.style.opacity = '0';
      node.style.transform = 'translateY(-6px)';
      setTimeout(() => node.remove(), 220);
    }, 2400);
  }

  /* ---------- modal ---------- */
  function openModal({ title, content = '', footer = '', wide = false, onClose }) {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `
      <div class="modal ${wide ? 'modal-lg' : ''}" role="dialog" aria-modal="true">
        <div class="modal-head">
          <h3>${esc(title)}</h3>
          <button class="close-x" type="button" aria-label="关闭">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
          </button>
        </div>
        <div class="modal-body"></div>
        ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
      </div>`;
    mask.querySelector('.modal-body').innerHTML = content;
    document.body.appendChild(mask);
    document.body.style.overflow = 'hidden';

    const close = () => {
      mask.remove();
      document.body.style.overflow = '';
      if (onClose) onClose();
    };
    mask.querySelector('.close-x').addEventListener('click', close);
    mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
    const escHandler = (e) => { if (e.key === 'Escape') { document.removeEventListener('keydown', escHandler); close(); } };
    document.addEventListener('keydown', escHandler);

    return { mask, modal: mask.querySelector('.modal'), body: mask.querySelector('.modal-body'), foot: mask.querySelector('.modal-foot'), close };
  }

  function confirmDialog(title, desc, { okText = '确认', danger = false } = {}) {
    return new Promise((resolve) => {
      const m = openModal({
        title,
        content: `<p style="font-size:13.5px;color:var(--ink-2);line-height:1.7">${esc(desc)}</p>`,
        footer: `<button class="btn" data-act="cancel">取消</button>
                 <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-act="ok">${esc(okText)}</button>`
      });
      m.foot.querySelector('[data-act="cancel"]').onclick = () => { m.close(); resolve(false); };
      m.foot.querySelector('[data-act="ok"]').onclick = () => { m.close(); resolve(true); };
    });
  }

  /* ---------- SSE ---------- */
  function connectSSE(path, handlers = {}) {
    const url = `/api${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(store.token)}`;
    let source;
    let closed = false;
    const open = () => {
      source = new EventSource(url);
      source.onopen = () => handlers.onopen && handlers.onopen();
      source.onerror = () => {
        if (closed) return;
        source.close();
        setTimeout(open, 2500);
      };
      Object.entries(handlers).forEach(([evt, cb]) => {
        if (['onopen', 'onerror'].includes(evt)) return;
        source.addEventListener(evt, (e) => {
          let data = {};
          try { data = JSON.parse(e.data); } catch { /* ignore */ }
          cb(data);
        });
      });
    };
    open();
    return { close: () => { closed = true; if (source) source.close(); } };
  }

  function debounce(fn, wait = 250) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
  }

  const qs = (sel, root = document) => root.querySelector(sel);
  const qsa = (sel, root = document) => [...root.querySelectorAll(sel)];

  const statusMap = {
    active: { text: '会话中', cls: 'badge-green', dot: 'dot-online' },
    waiting: { text: '排队中', cls: 'badge-amber', dot: 'dot-busy' },
    closed: { text: '已结束', cls: '', dot: 'dot-offline' }
  };
  const agentStatusMap = {
    online: { text: '在线', dot: 'dot-online' },
    busy: { text: '忙碌', dot: 'dot-busy' },
    offline: { text: '离线', dot: 'dot-offline' }
  };

  window.CS = {
    api, store, esc, fmtTime, fmtDate, fmtFull, relTime, dur, durMin,
    initials, stars, toast, openModal, confirmDialog, connectSSE, debounce, qs, qsa,
    statusMap, agentStatusMap
  };
})();
