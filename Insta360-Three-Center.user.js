// ==UserScript==
// @name         Insta360 三中心切换
// @namespace    https://local/cs
// @version      5.1.0
// @description  挂进 LSF 顶栏，折叠成小按钮；点开粘贴链接切中心
// @match        *://*/*
// @run-at       document-idle
// @grant        none
// @noframes
// @updateURL    https://raw.githubusercontent.com/chengzi-1225/Insta360-chengzi/refs/heads/Insta360-Three-Center.user.js
// @downloadURL  https://raw.githubusercontent.com/chengzi-1225/Insta360-chengzi/refs/heads/Insta360-Three-Center.user.js
// ==/UserScript==

(function () {
  'use strict';
  const HOST = '__cs5';
  const FOLD_KEY = '__cs5_folded';
  if (document.getElementById(HOST)) return;

  const CENTERS = [['项目',''], ['标注','/annotation'], ['审核','/review']];
  const MODE_RE = /^\/(annotation|review)(?=\/|$)/i;
  const SLOT = '.ls-menu-header__context-item_right';

  function build(raw, prefix) {
    let s = String(raw || '').trim();
    if (!s) return null;
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s.replace(/^\/+/, '');
    let u;
    try { u = new URL(s); } catch (_) { return null; }
    let p = (u.pathname || '/').replace(MODE_RE, '');
    if (!p) p = '/';
    if (p[0] !== '/') p = '/' + p;
    u.pathname = (prefix + p).replace(/\/{2,}/g, '/');
    return u.toString();
  }

  /* ============ UI ============ */
  const host = document.createElement('div');
  host.id = HOST;
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
<style>
  :host { all: initial; }
  #b {
    display: flex; gap: 4px; align-items: center;
    font: 12px/1.5 system-ui,-apple-system,"Microsoft YaHei",sans-serif;
  }
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
    border: 1px solid rgba(128,128,128,.45);
    font: 12px/1.4 system-ui,sans-serif;
  }
  button:hover { background: rgba(37,99,235,.12); border-color: #2563eb; }
  button:active { transform: translateY(1px); }

  /* 折叠按钮 */
  #tog {
    padding: 4px 10px; font-size: 14px; line-height: 1;
    display: flex; align-items: center; gap: 5px; position: relative;
  }
  #tog .dot {
    width: 6px; height: 6px; border-radius: 50%;
    background: #2563eb; display: none;
  }
  :host(.has-content) #tog .dot { display: block; }

  /* 展开 / 折叠状态 */
  #exp { display: none; gap: 4px; align-items: center; }
  :host(.open) #exp { display: flex; }
  :host(.open) #tog { display: none; }

  /* 兜底 fixed */
  :host(.fixed) #b {
    position: fixed; top: 8px; left: 50%; transform: translateX(-50%);
    z-index: 2147483647; padding: 6px 8px; border-radius: 10px;
    background: rgba(24,24,30,.97); color: #e6e6ea;
    border: 1px solid #3a3a44; box-shadow: 0 6px 20px rgba(0,0,0,.5);
  }
  :host(.fixed) input { background: #17171c; color: #e6e6ea; border-color: #3a3a44; }
  :host(.fixed) input:focus { background: #17171c; color: #e6e6ea; }
</style>

<div id="b">
  <!-- 折叠态 -->
  <button id="tog" title="展开（Ctrl+Shift+X）">⇄<span class="dot"></span></button>

  <!-- 展开态 -->
  <div id="exp">
    <input id="i" spellcheck="false" placeholder="粘贴链接">
    ${CENTERS.map(([n, k]) => `<button data-k="${k}">${n}</button>`).join('')}
    <button id="fold" title="收起（Ctrl+Shift+X）">◀</button>
  </div>
</div>`;

  const inp = root.getElementById('i');

  /* ============ 折叠控制 ============ */
  function setFold(fold) {
    host.classList.toggle('open', !fold);
    try { localStorage.setItem(FOLD_KEY, fold ? '1' : '0'); } catch (_) {}
    if (!fold) setTimeout(() => { try { inp.focus(); } catch (_) {} }, 0);
  }
  function toggleFold() { setFold(host.classList.contains('open')); }

  root.getElementById('tog').onclick = () => setFold(false);
  root.getElementById('fold').onclick = () => setFold(true);

  /* 快捷键 Ctrl+Shift+X */
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && (e.key === 'X' || e.key === 'x')) {
      e.preventDefault();
      toggleFold();
    }
  }, true);

  /* ============ 输入 ============ */
  // 在 Insta360 页面自动预填当前 URL
  if (/insta360\.com$/i.test(location.hostname)) inp.value = location.href;

  inp.addEventListener('input', () => {
    host.classList.toggle('has-content', !!inp.value.trim());
  });
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      root.querySelector('button[data-k]').click();
    }
    if (e.key === 'Escape') { e.preventDefault(); setFold(true); }
  });

  root.querySelectorAll('button[data-k]').forEach((btn) => {
    btn.onclick = () => {
      const url = build(inp.value, CENTERS[+btn.dataset.k][1]);
      if (!url) {
        inp.style.borderColor = '#ff6b6b';
        setTimeout(() => inp.style.borderColor = '', 800);
        return;
      }
      window.open(url, '_blank', 'noopener,noreferrer');
      setFold(true);   // 打开后自动收起
    };
  });

  /* ============ 挂载 / 自愈 ============ */
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

  /* ============ 启动 ============ */
  let folded = true;   // 默认折叠
  try { folded = localStorage.getItem(FOLD_KEY) !== '0'; } catch (_) {}
  setFold(folded);
  if (inp.value.trim()) host.classList.add('has-content');

  mount();
  setInterval(mount, 1500);
  new MutationObserver(mount).observe(document.documentElement, {
    childList: true, subtree: true
  });
})();
