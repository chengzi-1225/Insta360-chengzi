// ==UserScript==
// @name         Insta360 三中心切换
// @namespace    https://github.com/chengzi-1225/Insta360-chengzi
// @version      6.6.1
// @description  面板：粘贴链接 → 点【项目/标注/审核】切换前缀，query 参数原样保留；输入框自适应宽度
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
  const PREFIX_RE = /^\/(annotation|review)(?=\/|$)/i;
  const SLOT = '.ls-menu-header__context-item_right';

  /* ===== 只替换前缀，query 一字不动 ===== */
  function build(raw, prefix) {
    let s = String(raw || '').trim();
    if (!s) return { err: '没有输入链接' };
    if (/^\//.test(s)) s = location.origin + s;
    else if (!/^https?:\/\//i.test(s)) s = 'https://' + s.replace(/^\/+/, '');

    let u;
    try { u = new URL(s); } catch (_) { return { err: '链接解析失败' }; }
    if (!/^https?:$/i.test(u.protocol)) return { err: '只支持 http / https' };

    let p = u.pathname.replace(PREFIX_RE, '');
    if (!p) p = '/';
    if (p[0] !== '/') p = '/' + p;
    u.pathname = (prefix + p).replace(/\/{2,}/g, '/');

    return { url: u.toString(), same: u.toString() === s };
  }

  /* ===== UI ===== */
  const host = document.createElement('div');
  host.id = HOST;
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
<style>
  :host { all: initial; }
  #b {
    display: flex; gap: 4px; align-items: center;
    max-width: calc(100vw - 24px);
    font: 12px/1.5 system-ui,-apple-system,"Microsoft YaHei",sans-serif;
  }
  input {
    flex: 1 1 120px;
    min-width: 80px;
    max-width: 300px;
    padding: 5px 9px; border-radius: 6px;
    background: rgba(0,0,0,.05); color: inherit;
    border: 1px solid rgba(128,128,128,.35);
    font: 12px/1.5 ui-monospace,Consolas,monospace; outline: none;
    box-sizing: border-box;
  }
  input:focus { border-color: #2563eb; background: #fff; color: #000; box-shadow: 0 0 0 2px rgba(37,99,235,.2); }
  input::placeholder { color: #888; }
  button {
    flex: 0 0 auto;
    padding: 5px 12px; border-radius: 6px; cursor: pointer; white-space: nowrap;
    background: transparent; color: inherit;
    border: 1px solid rgba(128,128,128,.45); font: 12px/1.4 system-ui,sans-serif;
    box-sizing: border-box;
  }
  button:hover { background: rgba(37,99,235,.12); border-color: #2563eb; }
  button:active { transform: translateY(1px); }
  #tog { padding: 5px 11px; font-size: 14px; line-height: 1; position: relative; }
  #tog .dot { width: 6px; height: 6px; border-radius: 50%; background: #2563eb; position: absolute; top: 2px; right: 2px; display: none; }
  :host(.has-content) #tog .dot { display: block; }
  #exp {
    display: none; gap: 4px; align-items: center;
    min-width: 0; max-width: 100%;
  }
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
    <input id="i" spellcheck="false" autocomplete="off" placeholder="粘贴链接（Ctrl+V）">
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
    if (!fold) setTimeout(() => { try { inp.focus(); inp.select(); } catch (_) {} }, 30);
  }
  const toggleFold = () => setFold(host.classList.contains('open'));
  root.getElementById('tog').onclick = () => setFold(false);
  root.getElementById('fold').onclick = () => setFold(true);
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && (e.key === 'X' || e.key === 'x')) { e.preventDefault(); toggleFold(); }
  }, true);

  /* ===== 输入 ===== */
  if (/insta360\.com$/i.test(location.hostname)) inp.value = location.href;

  function syncState() {
    const v = inp.value.trim();
    host.classList.toggle('has-content', !!v);
    inp.title = v;
  }
  syncState();

  inp.addEventListener('input', syncState);

  inp.addEventListener('paste', (e) => {
    const txt = (e.clipboardData || window.clipboardData).getData('text');
    if (!txt) return;
    e.preventDefault();
    inp.value = txt.trim();
    syncState();
    say('已粘贴 ' + inp.value.length + ' 字符');
  });

  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); root.querySelector('button[data-k]').click(); }
    if (e.key === 'Escape') { e.preventDefault(); setFold(true); }
  });

  /* ===== 三按钮 ===== */
  root.querySelectorAll('button[data-k]').forEach((btn) => {
    btn.onclick = () => {
      const prefix = btn.dataset.k;
      const name = CENTERS.find(([n, k]) => k === prefix)[0];
      const r = build(inp.value, prefix);
      if (r.err) { say('✕ ' + r.err, true); inp.style.borderColor = '#ff6b6b'; setTimeout(() => inp.style.borderColor = '', 800); return; }
      if (r.same) { say('已经是：' + name); setFold(true); return; }

      let w = null;
      try { w = window.open(r.url, '_blank', 'noopener,noreferrer'); } catch (_) {}
      if (!w) { say('⚠️ 弹窗被拦截', true); return; }

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
  syncState();

  mount();
  setInterval(mount, 500);
  new MutationObserver(mount).observe(document.documentElement, { childList: true, subtree: true });

  /* ===== 对外 API ===== */
  window.__cs6 = {
    version: '6.6.1',
    build: build,
    open: () => setFold(false),
    close: () => setFold(true),
    toggle: toggleFold,
    value: () => inp.value,
    setValue: (v) => { inp.value = v; syncState(); },
    diag: () => {
      const rect = inp.getBoundingClientRect();
      const info = {
        version: '6.6.1',
        hostExists: !!document.getElementById(HOST),
        panelOpen: host.classList.contains('open'),
        isFixedFallback: host.classList.contains('fixed'),
        inputValue: inp.value,
        inputLength: inp.value.length,
        inputRect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
        hostParent: host.parentNode ? (host.parentNode.className || host.parentNode.tagName) : 'none',
        leftovers: ['__cs5','__center_switcher_host','__center_bar_host','__cs_v3_host','__cs4']
          .filter(id => document.getElementById(id))
      };
      console.table(info);
      return info;
    }
  };
})();
