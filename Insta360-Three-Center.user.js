// ==UserScript==
// @name         标注 ↔ 审核 一键互切
// @namespace    https://local/cs
// @version      6.0.0
// @description  在标注页显示「审核」按钮，在审核页显示「标注」按钮，点一下即切
// @match        *://label.insta360.com/*
// @run-at       document-idle
// @grant        none
// @noframes
// @updateURL    https://raw.githubusercontent.com/chengzi-1225/Insta360-chengzi/refs/heads/main/Insta360-Three-Center.user.js
// @downloadURL  https://raw.githubusercontent.com/chengzi-1225/Insta360-chengzi/refs/heads/main/Insta360-Three-Center.user.js
// ==/UserScript==

(function () {
  'use strict';
  const HOST = '__cs6';
  if (document.getElementById(HOST)) return;

  const MODE_RE = /^\/(annotation|review)(?=\/|$)/i;
  const SLOT = '.ls-menu-header__context-item_right';

  /* ===== 当前属于哪个中心 ===== */
  function currentMode() {
    const m = location.pathname.match(MODE_RE);
    return m ? m[1].toLowerCase() : null;
  }

  /* ===== 目标 URL ===== */
  function buildTarget() {
    const cur = currentMode();
    if (!cur) return null;

    const next = cur === 'review' ? 'annotation' : 'review';
    const prefix = '/' + next;

    const u = new URL(location.href);
    let p = u.pathname.replace(MODE_RE, '');
    if (!p) p = '/';
    if (p[0] !== '/') p = '/' + p;
    u.pathname = (prefix + p).replace(/\/{2,}/g, '/');

    // 切到标注中心 → 删掉 annotation= 参数（标注页用不到）
    if (next === 'annotation') u.searchParams.delete('annotation');

    return { url: u.toString(), next };
  }

  /* ===== UI ===== */
  const host = document.createElement('div');
  host.id = HOST;
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
<style>
  :host { all: initial; }
  button {
    display: flex; align-items: center; gap: 5px;
    padding: 4px 12px; border-radius: 6px; cursor: pointer; white-space: nowrap;
    background: transparent; color: inherit;
    border: 1px solid rgba(128,128,128,.45);
    font: 12px/1.4 system-ui,-apple-system,"Microsoft YaHei",sans-serif;
    transition: background .12s, border-color .12s;
  }
  button:hover { background: rgba(37,99,235,.12); border-color: #2563eb; }
  button:active { transform: translateY(1px); }
  /* 兜底 fixed */
  :host(.fixed) button {
    position: fixed; top: 8px; right: 8px; z-index: 2147483647;
    padding: 6px 14px; border-radius: 8px;
    background: rgba(24,24,30,.97); color: #e6e6ea; border-color: #3a3a44;
    box-shadow: 0 6px 20px rgba(0,0,0,.45);
  }
  :host(.fixed) button:hover { background: #2f3a4d; border-color: #2563eb; }
</style>
<button id="go"><span id="lab">切换</span></button>`;

  const btn = root.getElementById('go');
  const lab = root.getElementById('lab');

  function refresh() {
    const cur = currentMode();
    if (!cur) return;
    // review → 显示「标注」；annotation → 显示「审核」
    lab.textContent = cur === 'review' ? '→ 标注' : '→ 审核';
    btn.title = cur === 'review' ? '切到标注中心' : '切到审核中心';
  }

  btn.onclick = () => {
    const r = buildTarget();
    if (!r) return;
    // 当前标签直接跳，避免多开
    location.href = r.url;
  };

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
    refresh();
  }

  mount();
  setInterval(mount, 500);
  new MutationObserver(mount).observe(document.documentElement, { childList: true, subtree: true });

  // SPA 内部跳转也要刷新文案
  ['pushState', 'replaceState'].forEach((k) => {
    const orig = history[k];
    history[k] = function () {
      const r = orig.apply(this, arguments);
      setTimeout(mount, 50);
      return r;
    };
  });
  window.addEventListener('popstate', () => setTimeout(mount, 50));
})();
