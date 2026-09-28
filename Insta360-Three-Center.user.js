// ==UserScript==
// @name         Insta360 三中心切换
// @namespace    https://local/cs
// @version      5.3.0
// @description  挂进 LSF 顶栏，折叠成小按钮；点开粘贴链接切中心（v5.3 修复 @match 泛匹配 + 去掉大范围 MutationObserver）
// @match        *://*.insta360.com/*
// @match        *://*.labelstud.io/*
// @run-at       document-idle
// @grant        none
// @noframes
// @updateURL    https://raw.githubusercontent.com/chengzi-1225/Insta360-chengzi/refs/heads/Insta360-Three-Center.user.js
// @downloadURL  https://raw.githubusercontent.com/chengzi-1225/Insta360-chengzi/refs/heads/Insta360-Three-Center.user.js
// ==/UserScript==

(function () {
    'use strict';

    /* ============ 域名兜底（双保险） ============ */
    const IS_TARGET_HOST = /(^|\.)insta360\.com$/i.test(location.hostname) ||
                           /(^|\.)labelstud\.io$/i.test(location.hostname);
    if (!IS_TARGET_HOST) return;

    const HOST = '__cs5';
    const FOLD_KEY = '__cs5_folded';
    if (document.getElementById(HOST)) return;

    const CENTERS = [['管', ''], ['标', '/annotation'], ['审', '/review']];
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

  #tog {
    padding: 4px 10px; font-size: 14px; line-height: 1;
    display: flex; align-items: center; gap: 5px; position: relative;
  }
  #tog .dot {
    width: 6px; height: 6px; border-radius: 50%;
    background: #2563eb; display: none;
  }
  :host(.has-content) #tog .dot { display: block; }

  #exp { display: none; gap: 4px; align-items: center; }
  :host(.open) #exp { display: flex; }
  :host(.open) #tog { display: none; }

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
  <button id="tog" title="展开（Ctrl+Shift+X）">⇄<span class="dot"></span></button>
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

    /* 快捷键 Ctrl+Shift+X（兼容大小写） */
    window.addEventListener('keydown', function (e) {
        if (e.ctrlKey && e.shiftKey && (e.key === 'X' || e.key === 'x' || e.code === 'KeyX')) {
            e.preventDefault();
            toggleFold();
        }
    }, true);

    /* ============ 输入 ============ */
    if (/insta360\.com$/i.test(location.hostname)) inp.value = location.href;

    inp.addEventListener('input', function () {
        host.classList.toggle('has-content', !!inp.value.trim());
    });
    inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            const first = root.querySelector('button[data-k]');
            if (first) first.click();
        }
        if (e.key === 'Escape') { e.preventDefault(); setFold(true); }
    });

    root.querySelectorAll('button[data-k]').forEach(function (btn) {
        btn.onclick = function () {
            const url = build(inp.value, CENTERS[+btn.dataset.k][1]);
            if (!url) {
                inp.style.borderColor = '#ff6b6b';
                setTimeout(function () { inp.style.borderColor = ''; }, 800);
                return;
            }
            window.open(url, '_blank', 'noopener,noreferrer');
            setFold(true);
        };
    });

    /* ============ 挂载 / 自愈（改用 setInterval + URL 检测，去掉大范围 MutationObserver） ============ */
    let lastHref = location.href;

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
    let folded = true;
    try { folded = localStorage.getItem(FOLD_KEY) !== '0'; } catch (_) {}
    setFold(folded);
    if (inp.value.trim()) host.classList.add('has-content');

    mount();

    /* 每 800ms 自检：URL 变了 / host 被移除 / slot 出现或消失 → 重挂 */
    setInterval(function () {
        if (location.href !== lastHref) {
            lastHref = location.href;
            mount();
        }
        if (!document.getElementById(HOST)) {
            /* host 被移除（比如页面切换），重新加入 body */
            if (host.parentNode) host.parentNode.removeChild(host);
            document.body.appendChild(host);
            mount();
        } else {
            mount();
        }
    }, 800);
})();
