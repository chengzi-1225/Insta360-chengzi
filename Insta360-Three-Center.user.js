// ==UserScript==
// @name         Insta360 三中心切换
// @namespace    https://github.com/chengzi-1225/Insta360-chengzi
// @version      6.2.0
// @description  面板：自动填当前链接 → 点按钮切到项目/标注/审核中心（自动清理审核态参数）
// @author       chengzi
// @match        *://label.insta360.com/*
// @updateURL    https://raw.githubusercontent.com/chengzi-1225/Insta360-chengzi/refs/heads/main/Insta360-Three-Center.user.js
// @downloadURL  https://raw.githubusercontent.com/chengzi-1225/Insta360-chengzi/refs/heads/main/Insta360-Three-Center.user.js
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

(function () {
  'use strict';
  const HOST = '__cs6';
  const FOLD_KEY = '__cs6_folded';
  if (document.getElementById(HOST)) return;

  const CENTERS = [['项目',''], ['标注','/annotation'], ['审核','/review']];
  const MODE_RE = /^\/(annotation|review)(?=\/|$)/i;
  const SLOT = '.ls-menu-header__context-item_right';

  // 审核页特有、切走后必须删的参数
  const REVIEW_ONLY_PARAMS = ['annotation', 'reviewing'];

  /* ===== 链接清洗 ===== */
  function norm(raw) {
    let s = String(raw || '');
    s = s.replace(/&amp;/g, '&');
    s = s.replace(/\u3000/g, ' ');
    s = s.replace(/[\u200B-\u200D\uFEFF\u00AD]/g, '');
    s = s.split(/[\r\n]+/).map(x => x.trim()).find(Boolean) || '';
    return s.trim();
  }

  /* ===== 目标 URL ===== */
  function build(raw, prefix) {
    let s = norm(raw);
    if (!s) return { err: '没有输入链接' };
    if (/^\//.test(s)) s = location.origin + s;
    else if (!/^https?:\/\//i.test(s)) s = 'https://' + s.replace(/^\/+/, '');

    let u;
    try { u = new URL(s); } catch (_) { return { err: '链接解析失败，可能混了空格或特殊字符' }; }
    if (!/^https?:$/i.test(u.protocol)) return { err: '只支持 http / https' };

    let p = (u.pathname || '/').replace(MODE_RE, '');
    if (!p) p = '/';
    if (p[0] !== '/') p = '/' + p;
    u.pathname = (prefix + p).replace(/\/{2,}/g, '/');

    // 目标不是审核中心 → 把审核态参数全清掉
    if (prefix !== '/review') {
      REVIEW_ONLY_PARAMS.forEach((k) => u.searchParams.delete(k));
    }

    return { url: u.toString(), same: u.toString() === norm(raw) };
  }

  /* ===== UI ===== */
  const host = document.createElement('div');
  host.id = HOST;
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
<style>
  :host { all: initial; }
  #b { display: flex; gap: 4px; align-items: center; font: 12px/1.5 system-ui,-apple-system,"Microsoft YaHei",sans-serif; }
  input {
    width: 280px; padding: 4px 8px; border-radius: 6px;
    background: rgba(0,0,0,.05); color: inherit;
    border: 1px solid rgba(128,128,128,.35);
    font: 12px/1.5 ui-monospace,Consolas,monospace; outline: none;
  }
  input:focus { border-color: #2563eb; background: #fff; color: #000; }
  input::placeholder { color: #888; }
  button {
    padding: 4px 10px; border-radius: 6px; cursor: pointer; white-space: nowrap;
    background: transparent; color: inherit;
    border: 1px solid rgba(128,128,128,.45); font: 12px/1.4 system-ui,sans-serif;
  }
  button:hover { background: rgba(37,99,235,.12); border-color: #2563eb; }
  button:active { transform: translateY(1px); }
  #tog { padding: 4px 10px; font-size: 14px; line-height: 1; position: relative; }
  #tog .dot { width: 6px; height: 6px; border-radius: 50%; background: #2563eb; position: absolute; top: 2px; right: 2px; display: none; }
  :host(.has-content) #tog .dot { display: block; }
  #exp { display: none; gap: 4px; align-items: center; }
  :host(.open) #exp { display: flex; }
  :host(.open) #tog { display: none; }
  #toast {
    position: fixed; top: 56px; left: 50%; transform: translateX(-50%);
    z-index: 2147483647; padding: 6px 14px; border-radius: 8px;
    background: rgba(30,30,38,.96); color: #e6e6ea;
    border: 1px solid #3a3a44; box-shadow: 0 6px 20px rgba(0,0,0,.4);
    font: 12px/1.5 system-ui,sans-serif; opacity: 0; pointer-events: none;
    transition: opacity .2s; max-width: 80vw;
  }
  #toast.on { opacity: 1; }
  #toast.err { border-color: #b44; color: #ffb3b3; }
  :host(.fixed) #b {
    position: fixed; top: 8px; left: 50%; transform: translateX(-50%);
    z-index: 2147483647; padding: 6px 8px; border-radius: 10px;
    background: rgba(24,24,30,.97); color: #e6e6ea; border: 1px solid #3a3a44;
    box-shadow: 0 6px 20px rgba(0,0,0,.5);
  }
  :host(.fixed) input { background: #17171c; color: #e6e6ea; border-color: #3a3a44; }
  :host(.fixed) input:focus { background: #17171c; color: #e6e6ea; }
</style>
<div id="b">
  <button id="tog" title="展开（Ctrl+Shift+X）">⇄<span class="dot"></span></button>
  <div id="exp">
    <input id="i" spellcheck="false" placeholder="粘贴链接">
    ${CENTERS.map(([n, k]) => `<button data-k="${k}">${n}</button>`).join('')}
    <button id="fold" title="收起（Ctrl+Shift+X）">◀</button>
  </div>
</div>
<div id="toast"></div>`;

  const inp = root.getElementById('i');
  const toast = root.getElementById('toast');
  let toastTimer = null;
  function say(msg, err) {
    toast.textContent = msg;
    toast.classList.toggle('err', !!err);
    toast.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('on'), 2600);
  }

  /* ===== 折叠 ===== */
  function setFold(fold) {
    host.classList.toggle('open', !fold);
    try { localStorage.setItem(FOLD_KEY, fold ? '1' : '0'); } catch (_) {}
    if (!fold) setTimeout(() => { try { inp.focus(); } catch (_) {} }, 0);
  }
  const toggleFold = () => setFold(host.classList.contains('open'));
  root.getElementById('tog').onclick = () => setFold(false);
  root.getElementById('fold').onclick = () => setFold(true);
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && (e.key === 'X' || e.key === 'x')) { e.preventDefault(); toggleFold(); }
  }, true);

  /* ===== 输入 ===== */
  if (/insta360\.com$/i.test(location.hostname)) inp.value = location.href;
  inp.addEventListener('input', () => {
    host.classList.toggle('has-content', !!inp.value.trim());
    inp.title = norm(inp.value);
  });
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); root.querySelector('button[data-k]').click(); }
    if (e.key === 'Escape') { e.preventDefault(); setFold(true); }
  });

  /* ===== 按钮 ===== */
  root.querySelectorAll('button[data-k]').forEach((btn) => {
    btn.onclick = () => {
      const name = CENTERS[+btn.dataset.k][0];
      const r = build(inp.value, CENTERS[+btn.dataset.k][1]);
      if (r.err) { say('✕ ' + r.err, true); inp.style.borderColor = '#ff6b6b'; setTimeout(() => inp.style.borderColor = '', 800); return; }
      if (r.same) { say('已经在该中心：' + name); setFold(true); return; }

      let w = null;
      try { w = window.open(r.url, '_blank', 'noopener,noreferrer'); } catch (_) {}
      if (!w) { say('⚠️ 弹窗被拦截，请允许弹出窗口', true); return; }

      say('已打开：' + name);
      setFold(true);
    };
  });

  /* ===== 挂载 ===== */
  function mount() {
    const slot = document.querySelector(SLOT);
    if (slot) {
      host.classList.remove('fixed');
      if (host.parentNode !== slot) slot.appendChild(host);
    } else {
      host.classList.add('fixed');
      if (host.parentNode !== document.body) document.body.appendChild(host);
    }
  }

  /* ===== 启动 ===== */
  let folded = true;
  try { folded = localStorage.getItem(FOLD_KEY) !== '0'; } catch (_) {}
  setFold(folded);
  if (inp.value.trim()) host.classList.add('has-content');

  mount();
  setInterval(mount, 500);
  new MutationObserver(mount).observe(document.documentElement, { childList: true, subtree: true });

  ['pushState', 'replaceState'].forEach((k) => {
    const orig = history[k];
    history[k] = function () {
      const r = orig.apply(this, arguments);
      setTimeout(() => {
        if (inp.value && inp.value === inp.dataset.auto) {
          inp.value = location.href;
          inp.dataset.auto = location.href;
        }
        mount();
      }, 60);
      return r;
    };
  });

  // 调试入口
  window.__cs6 = { build, norm };
})();
