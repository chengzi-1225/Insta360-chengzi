// ==UserScript==
// @name         LabelStudio 项目进度徽章（顶栏 + 列表页统计）
// @namespace    https://label.insta360.com/
// @version      2.2.0
// @description  顶栏进度徽章；列表页（含审核中心）/review/workspaces/{ws} 统计未达标；点击跳转审核页
// @author       you
// @match        *://label.insta360.com/*
// @updateURL    https://raw.githubusercontent.com/chengzi-1225/Insta360-chengzi/refs/heads/main/LabelStudio-projectProgressBadge.user.js
// @downloadURL  https://raw.githubusercontent.com/chengzi-1225/Insta360-chengzi/refs/heads/main/LabelStudio-projectProgressBadge.user.js
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';
  if (window.__LSPCT_LOADED__) return;
  window.__LSPCT_LOADED__ = true;

  const LS_KEY = 'lsperm:customPct';
  const LS_THRESHOLD = 'lspct:threshold';
  const LS_LIST_THR = 'lspct:listThreshold';
  const CLS = 'lspct-badge';
  const CLS_ALERT = 'lspct-badge--alert';
  const POP_ID = 'lspct-pop';
  const LIST_ENTRY_ID = 'lspct-list-entry';
  const LIST_PANEL_ID = 'lspct-list-panel';
  const DEFAULT_THRESHOLD = 20;
  const DEFAULT_LIST_THR = 20;
  const CACHE_TTL = 8 * 1000;
  const REFRESH_INTERVAL = 8 * 1000;
  const DEBUG = false;
  const log = (...a) => { if (DEBUG) console.log('%c[进度徽章]', 'color:#f97316', ...a); };

  /* ================= 数值格式化 ================= */
  function fmt(n) {
    if (!Number.isFinite(n)) return null;
    const r = Math.round(n * 10) / 10;
    return String(r);
  }

  /* ================= 持久化 ================= */
  function loadJSON(k, def) {
    try { const v = JSON.parse(localStorage.getItem(k) || ''); return v == null ? def : v; } catch (e) { return def; }
  }
  function saveJSON(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {}
  }
  function loadNum(k, def) {
    const v = parseFloat(localStorage.getItem(k) || '');
    return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : def;
  }
  function saveNum(k, v) {
    try { localStorage.setItem(k, String(v)); } catch (e) {}
  }

  let CUSTOM = loadJSON(LS_KEY, {});
  let THRESHOLD = loadNum(LS_THRESHOLD, DEFAULT_THRESHOLD);
  let LIST_THRESHOLD = loadNum(LS_LIST_THR, DEFAULT_LIST_THR);

  function saveCustom(o) { saveJSON(LS_KEY, o); }
  function saveThreshold(v) { saveNum(LS_THRESHOLD, v); }
  function saveListThreshold(v) { saveNum(LS_LIST_THR, v); }

  /* ================= 页面判定 ================= */
  function getProjectIdFromUrl() {
    const m = /\/projects\/(\d+)/.exec(location.pathname);
    return m ? m[1] : null;
  }
  function isProjectPage() {
    return !!getProjectIdFromUrl() && /\/projects\/\d+/.test(location.pathname);
  }
  // ★ 列表页判定：普通工作区列表 + 审核中心列表
  function isListPage() {
    const p = location.pathname;
    if (/\/projects\/\d+/.test(p)) return false;
    if (/\/settings\//.test(p)) return false;
    // 普通工作区项目列表页
    if (/^\/workspaces\/[^/]+\/projects\/?$/i.test(p)) return true;
    // ★ 审核中心列表页 /review/workspaces/140?page=1
    if (/^\/review\/workspaces\/[^/]+\/?$/i.test(p)) return true;
    // ★ 审核中心项目列表 /review/workspaces/140/projects
    if (/^\/review\/workspaces\/[^/]+\/projects\/?$/i.test(p)) return true;
    return false;
  }
  // 提取 workspace id
  function getWorkspaceFromUrl() {
    const m = /\/workspaces\/([^/]+)/.exec(location.pathname);
    return m ? m[1] : 'all';
  }

  /* ================= 顶栏挂载点 ================= */
  function findMountPoint() {
    let el = document.querySelector('.ls-menu-header__context-item_right');
    if (el) return { el: el, mode: 'right' };
    el = document.querySelector('.ls-menu-header__context');
    if (el) return { el: el, mode: 'context' };
    el = document.querySelector('.ls-breadcrumbs__list');
    if (el) return { el: el, mode: 'breadcrumbs' };
    el = document.querySelector('.ls-breadcrumbs');
    if (el) return { el: el, mode: 'breadcrumbs' };
    return null;
  }

  /* ================= 列表页挂载点（含审核中心） ================= */
  function findListMountPoint() {
    // ★ 审核中心列表页筛选容器（优先）
    let el = document.querySelector('.ls-review-center-page__filter-container');
    if (el) return { el: el, mode: 'filter' };
    // 普通项目列表页
    el = document.querySelector('.ls-projects-page__filter-container');
    if (el) return { el: el, mode: 'filter' };
    el = document.querySelector('.ls-projects-page__title-container');
    if (el) return { el: el, mode: 'title' };
    el = document.querySelector('.ls-projects-page__header-left');
    if (el) return { el: el, mode: 'header-left' };
    // 兜底：审核中心标题栏
    el = document.querySelector('.ls-review-center-page__title-container');
    if (el) return { el: el, mode: 'title' };
    return null;
  }

  /* ================= 列表页进度读取（优先 ovw-summary，保留小数） ================= */
  function getPctFromCard(card) {
    const ovw = card.querySelector('.ovw-summary');
    if (ovw) {
      const reviewBar = ovw.querySelector('.ovw-bar[data-ovw-key="reviewProgress"]');
      if (reviewBar) {
        const fill = reviewBar.querySelector('.ovw-bar__fill');
        if (fill) {
          const w = parseFloat(fill.style.width || '');
          if (Number.isFinite(w)) return w;
        }
        const val = reviewBar.querySelector('.ovw-bar__val');
        if (val) {
          const v = parseFloat((val.textContent || '').replace(/[^\d.]/g, ''));
          if (Number.isFinite(v)) return v;
        }
      }
    }

    // 兜底：原生卡片四级
    const pctEl = card.querySelector('.ls-project-card__progress-percentage');
    let v = pctEl && parseFloat((pctEl.textContent || '').replace(/[^\d.]/g, ''));
    if (Number.isFinite(v)) return v;

    const foot = card.querySelector('.ls-project-card__footer');
    v = foot && parseFloat((foot.textContent || '').replace(/[^\d.]/g, ''));
    if (Number.isFinite(v)) return v;

    const bar = card.querySelector('.ls-project-card__process-bar') ||
                card.querySelector('.ls-project-card__progress-bar-fill');
    if (bar) {
      v = parseFloat(bar.style.width || '');
      if (Number.isFinite(v)) return v;
    }

    const cnt = card.querySelector('.ls-project-card__progress-count');
    const m = cnt && /(\d+)\s*\/\s*(\d+)/.exec(cnt.textContent || '');
    if (m && +m[2] > 0) return (+m[1] / +m[2]) * 100;

    return null;
  }

  function getPidFromCard(card) {
    const ovw = card.querySelector('.ovw-summary[data-project-id]');
    if (ovw) {
      const id = ovw.getAttribute('data-project-id');
      if (id) return id;
    }
    const a = card.closest('a[href*="/projects/"]') || card.querySelector('a[href*="/projects/"]');
    const src = a ? a.getAttribute('href') : (card.dataset.projectId || card.outerHTML);
    const m = /\/projects\/(\d+)/.exec(src || '');
    return m ? m[1] : null;
  }

  function getNameFromCard(card) {
    const t = card.querySelector('.ls-project-card__title-text') ||
              card.querySelector('.ls-project-card__title') ||
              card.querySelector('[class*="title"]');
    if (!t) return '(未命名)';
    const clone = t.cloneNode(true);
    clone.querySelectorAll('.__Cici__translate__').forEach(n => n.remove());
    return (clone.textContent || '').trim() || '(未命名)';
  }

  function collectCards() {
    const out = { list: [], below: 0, ok: 0 };
    const cards = document.querySelectorAll('.ls-project-card');
    cards.forEach(function (card) {
      const pid = getPidFromCard(card);
      const name = getNameFromCard(card);
      const real = getPctFromCard(card);
      const custom = pid != null ? CUSTOM[pid] : undefined;
      const shown = custom != null ? custom : real;
      const below = shown != null && shown < LIST_THRESHOLD;
      if (shown != null) { if (below) out.below++; else out.ok++; }
      out.list.push({ id: pid, name: name, pct: shown, real: real, custom: custom, below: below });
    });
    return out;
  }

  /* ================= 顶栏进度 API ================= */
  const CACHE = {};
  const INFLIGHT = {};
  let AUTO_REFRESH = true;
  let refreshTimer = null;

  async function fetchProgress(pid) {
    try {
      const r = await fetch(`/api/projects?ids=${pid}&page_size=1`, { credentials: 'include' });
      if (!r.ok) return null;
      const j = await r.json();
      let p = null;
      if (Array.isArray(j)) p = j[0];
      else if (j && Array.isArray(j.results)) p = j.results[0];
      else if (j && j.id) p = j;
      if (!p) return null;
      const total = Number(p.task_number) || 0;
      if (!total) return null;
      const reviewed = Number(p.reviewed_count) || 0;
      const rejected = Number(p.review_reject_count) || 0;
      return (reviewed + rejected) / total * 100;
    } catch (e) { return null; }
  }

  function ensureProgress(pid, onDone) {
    const c = CACHE[pid];
    if (c && Date.now() - c.ts < CACHE_TTL) return c.pct;
    if (INFLIGHT[pid]) return undefined;
    INFLIGHT[pid] = true;
    fetchProgress(pid).then(function (pct) {
      CACHE[pid] = { pct: pct, ts: Date.now() };
      delete INFLIGHT[pid];
      onDone && onDone(pct);
    });
    return undefined;
  }

  function startAutoRefresh() {
    if (refreshTimer) return;
    refreshTimer = setInterval(function () {
      if (!AUTO_REFRESH) return;
      if (!isProjectPage()) return;
      const pid = getProjectIdFromUrl();
      if (!pid) return;
      if (CUSTOM[pid] != null) return;
      delete CACHE[pid];
      ensureProgress(pid, function () { scan(); });
    }, REFRESH_INTERVAL);
  }
  function stopAutoRefresh() {
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  }

  /* ================= 颜色 ================= */
  function colorOf(p) {
    if (p >= 100) return { bg: '#16a34a', fg: '#fff' };
    if (p >= 70)  return { bg: '#84cc16', fg: '#1a2e05' };
    if (p >= 40)  return { bg: '#f59e0b', fg: '#3b2600' };
    if (p >= 10)  return { bg: '#f97316', fg: '#fff' };
    return { bg: '#ef4444', fg: '#fff' };
  }

  /* ================= 样式 ================= */
  function injectStyle() {
    if (document.getElementById('lspct-style')) return;
    const s = document.createElement('style');
    s.id = 'lspct-style';
    s.textContent = `
      .${CLS} {
        display: inline-flex; align-items: center; justify-content: center;
        margin: 0 8px; padding: 2px 10px; border-radius: 999px;
        font-size: 12px; line-height: 18px; font-weight: 700;
        letter-spacing: .3px; cursor: pointer; user-select: none;
        vertical-align: middle; white-space: nowrap;
        box-shadow: 0 0 0 1px rgba(0,0,0,.12), 0 1px 3px rgba(0,0,0,.2);
        transition: transform .12s ease, filter .12s ease;
      }
      .${CLS}:hover { transform: scale(1.08); filter: brightness(1.08); }
      .${CLS}[data-custom="1"] {
        box-shadow: 0 0 0 2px #fff, 0 0 0 3px rgba(0,0,0,.25), 0 1px 4px rgba(0,0,0,.3);
      }
      .${CLS}.${CLS_ALERT} {
        color: #1a1200 !important;
        background: linear-gradient(135deg, #ffe066 0%, #ffc400 100%) !important;
        box-shadow: 0 0 0 2px #fff, 0 0 0 3px #ffb800, 0 2px 8px rgba(255,184,0,.6) !important;
        font-weight: 800;
        animation: lspct-pulse 1.4s ease-in-out infinite;
      }
      .${CLS}.${CLS_ALERT}[data-custom="1"] {
        box-shadow: 0 0 0 2px #fff, 0 0 0 4px #ffb800, 0 2px 10px rgba(255,184,0,.75) !important;
      }
      @keyframes lspct-pulse {
        0%,100% { transform: scale(1);    box-shadow: 0 0 0 2px #fff, 0 0 0 3px #ffb800, 0 0 6px rgba(255,184,0,.5); }
        50%     { transform: scale(1.06); box-shadow: 0 0 0 2px #fff, 0 0 0 5px #ffd54a, 0 0 14px rgba(255,184,0,.9); }
      }
      @media (prefers-reduced-motion: reduce) { .${CLS}.${CLS_ALERT} { animation: none; } }

      #${POP_ID} {
        position: fixed; z-index: 2147483647;
        width: 240px; padding: 14px;
        background: #fff; color: #222;
        border: 1px solid #e5e7eb; border-radius: 12px;
        box-shadow: 0 12px 40px rgba(0,0,0,.22);
        font: 13px/1.5 system-ui,-apple-system,"Microsoft YaHei",sans-serif;
        box-sizing: border-box;
      }
      #${POP_ID} * { box-sizing: border-box; }
      #${POP_ID} .lspct-pop-title {
        font-size: 13px; font-weight: 700; margin-bottom: 10px; color: #111;
        display: flex; align-items: center; justify-content: space-between;
      }
      #${POP_ID} .lspct-pop-close {
        cursor: pointer; color: #999; font-size: 16px; line-height: 1;
        padding: 0 2px; user-select: none;
      }
      #${POP_ID} .lspct-pop-close:hover { color: #e11d48; }
      #${POP_ID} .lspct-pop-real {
        display: flex; justify-content: space-between; align-items: center;
        padding: 6px 10px; border-radius: 8px; margin-bottom: 10px;
        background: #f3f4f6; font-size: 12px; color: #4b5563;
      }
      #${POP_ID} .lspct-pop-real b { color: #111; font-size: 13px; }
      #${POP_ID} .lspct-pop-row { margin-bottom: 10px; }
      #${POP_ID} label.lspct-pop-label {
        display: block; font-size: 12px; color: #6b7280; margin-bottom: 4px;
      }
      #${POP_ID} input.lspct-pop-input {
        width: 100%; padding: 6px 9px; border-radius: 8px;
        border: 1px solid #d1d5db; font-size: 13px; outline: none;
        font-family: ui-monospace,Consolas,monospace;
      }
      #${POP_ID} input.lspct-pop-input:focus {
        border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,.15);
      }
      #${POP_ID} .lspct-pop-hint { font-size: 11px; color: #9ca3af; margin-top: 3px; }
      #${POP_ID} .lspct-pop-actions { display: flex; gap: 6px; margin-top: 12px; }
      #${POP_ID} button {
        flex: 1; padding: 7px 0; border-radius: 8px; cursor: pointer;
        font-size: 12px; font-weight: 600; border: 1px solid transparent;
        transition: filter .12s ease;
      }
      #${POP_ID} button:hover { filter: brightness(1.06); }
      #${POP_ID} .lspct-pop-save { background: #2563eb; color: #fff; }
      #${POP_ID} .lspct-pop-clear { background: #f3f4f6; color: #4b5563; border-color: #e5e7eb; }

      #${LIST_ENTRY_ID} {
        display: inline-flex; align-items: center; gap: 6px;
        margin-right: 8px; padding: 5px 12px;
        border-radius: 8px; cursor: pointer; user-select: none;
        font: 12px/1.4 system-ui,-apple-system,"Microsoft YaHei",sans-serif;
        font-weight: 600; white-space: nowrap;
        background: #fff; color: #4b5563;
        border: 1px solid #e5e7eb;
        transition: all .12s ease;
      }
      #${LIST_ENTRY_ID}:hover { border-color: #2563eb; color: #2563eb; background: #eff6ff; }
      #${LIST_ENTRY_ID}.lspct-list-entry--warn {
        background: #fff7ed; color: #c2410c; border-color: #fed7aa;
      }
      #${LIST_ENTRY_ID}.lspct-list-entry--warn:hover { background: #ffedd5; border-color: #fb923c; }
      #${LIST_ENTRY_ID} .lspct-list-entry-n {
        font-family: ui-monospace,Consolas,monospace;
        padding: 0 6px; border-radius: 4px;
        background: rgba(194,65,12,.12); color: inherit;
        font-weight: 700;
      }

      #${LIST_PANEL_ID} {
        position: fixed; z-index: 2147483646;
        width: 320px; max-height: 60vh; overflow: hidden;
        display: flex; flex-direction: column;
        background: #fff; color: #222;
        border: 1px solid #e5e7eb; border-radius: 12px;
        box-shadow: 0 12px 40px rgba(0,0,0,.22);
        font: 13px/1.5 system-ui,-apple-system,"Microsoft YaHei",sans-serif;
      }
      #${LIST_PANEL_ID} * { box-sizing: border-box; }
      #${LIST_PANEL_ID} .lspct-lp-head {
        display: flex; align-items: center; justify-content: space-between;
        padding: 12px 14px; border-bottom: 1px solid #f0f0f0;
      }
      #${LIST_PANEL_ID} .lspct-lp-title { font-weight: 700; font-size: 13px; }
      #${LIST_PANEL_ID} .lspct-lp-close {
        cursor: pointer; color: #999; font-size: 16px; line-height: 1; user-select: none;
      }
      #${LIST_PANEL_ID} .lspct-lp-close:hover { color: #e11d48; }
      #${LIST_PANEL_ID} .lspct-lp-thr {
        display: flex; align-items: center; gap: 6px;
        padding: 8px 14px; background: #f9fafb; border-bottom: 1px solid #f0f0f0;
        font-size: 12px; color: #4b5563;
      }
      #${LIST_PANEL_ID} .lspct-lp-thr input {
        width: 60px; padding: 3px 6px; border-radius: 6px;
        border: 1px solid #d1d5db; font-family: ui-monospace,monospace;
        font-size: 12px; outline: none;
      }
      #${LIST_PANEL_ID} .lspct-lp-thr input:focus { border-color: #2563eb; }
      #${LIST_PANEL_ID} .lspct-lp-list {
        flex: 1; overflow-y: auto; padding: 6px 0;
      }
      #${LIST_PANEL_ID} .lspct-lp-item {
        display: flex; align-items: center; gap: 8px;
        padding: 8px 14px; cursor: pointer;
        transition: background .12s ease;
      }
      #${LIST_PANEL_ID} .lspct-lp-item:hover { background: #f3f4f6; }
      #${LIST_PANEL_ID} .lspct-lp-item-name {
        flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        font-size: 13px; color: #111;
      }
      #${LIST_PANEL_ID} .lspct-lp-item-pct {
        font-family: ui-monospace,Consolas,monospace;
        font-weight: 700; font-size: 12px;
        padding: 2px 8px; border-radius: 999px;
      }
      #${LIST_PANEL_ID} .lspct-lp-empty {
        padding: 24px 14px; text-align: center; color: #9ca3af; font-size: 12px;
      }
    `;
    (document.head || document.documentElement).appendChild(s);
  }

  /* ================= 顶栏小弹窗 ================= */
  let popEl = null;
  function closePop() {
    if (popEl && popEl.parentNode) popEl.parentNode.removeChild(popEl);
    popEl = null;
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onDocKey, true);
  }
  function onDocDown(e) { if (popEl && !popEl.contains(e.target)) closePop(); }
  function onDocKey(e) { if (e.key === 'Escape') { e.stopPropagation(); closePop(); } }

  function openPop(badge, pid, realPct) {
    closePop();
    injectStyle();
    const curCustom = CUSTOM[pid];
    popEl = document.createElement('div');
    popEl.id = POP_ID;
    popEl.innerHTML = `
      <div class="lspct-pop-title">
        <span>进度徽章设置</span>
        <span class="lspct-pop-close" title="关闭 (ESC)">✕</span>
      </div>
      <div class="lspct-pop-real">
        <span>当前实际进度</span>
        <b>${realPct == null ? '获取中…' : fmt(realPct) + '%'}</b>
      </div>
      <div class="lspct-pop-row">
        <label class="lspct-pop-label">固定显示值（留空 = 跟随实际）</label>
        <input class="lspct-pop-input" id="lspct-in-custom" type="number" step="0.1" min="0" max="100"
               placeholder="跟随实际进度" value="${curCustom != null ? curCustom : ''}">
      </div>
      <div class="lspct-pop-row">
        <label class="lspct-pop-label">高亮阈值（显示值 ≥ 此值即高亮）</label>
        <input class="lspct-pop-input" id="lspct-in-thr" type="number" step="0.1" min="0" max="100"
               value="${THRESHOLD}">
        <div class="lspct-pop-hint">默认 ${DEFAULT_THRESHOLD}%</div>
      </div>
      <div class="lspct-pop-actions">
        <button class="lspct-pop-clear" id="lspct-btn-clear">清除固定值</button>
        <button class="lspct-pop-save" id="lspct-btn-save">保存</button>
      </div>
    `;
    document.body.appendChild(popEl);

    const r = badge.getBoundingClientRect();
    const pw = 240, ph = popEl.offsetHeight || 260;
    let left = r.left, top = r.bottom + 6;
    if (left + pw > innerWidth - 8) left = innerWidth - pw - 8;
    if (left < 8) left = 8;
    if (top + ph > innerHeight - 8) top = Math.max(8, r.top - ph - 6);
    popEl.style.left = left + 'px';
    popEl.style.top = top + 'px';

    const inCustom = popEl.querySelector('#lspct-in-custom');
    const inThr = popEl.querySelector('#lspct-in-thr');

    popEl.querySelector('.lspct-pop-close').addEventListener('click', closePop);
    popEl.querySelector('#lspct-btn-save').addEventListener('click', function () {
      const tv = parseFloat(inThr.value);
      THRESHOLD = Number.isFinite(tv) ? Math.max(0, Math.min(100, tv)) : DEFAULT_THRESHOLD;
      saveThreshold(THRESHOLD);
      const t = (inCustom.value || '').trim();
      if (t === '') delete CUSTOM[pid];
      else {
        const n = parseFloat(t);
        if (Number.isFinite(n)) CUSTOM[pid] = Math.max(0, Math.min(100, n));
      }
      saveCustom(CUSTOM);
      closePop();
      scan();
    });
    popEl.querySelector('#lspct-btn-clear').addEventListener('click', function () {
      delete CUSTOM[pid];
      saveCustom(CUSTOM);
      closePop();
      scan();
    });
    popEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); popEl.querySelector('#lspct-btn-save').click(); }
    });
    setTimeout(function () {
      inCustom.focus(); inCustom.select();
      document.addEventListener('mousedown', onDocDown, true);
      document.addEventListener('keydown', onDocKey, true);
    }, 0);
  }

  function bindBadge(badge, getPid, getRealPct) {
    badge.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      const pid = getPid(); if (!pid) return;
      const real = getRealPct ? getRealPct() : null;
      openPop(badge, pid, real);
    });
    badge.addEventListener('mousedown', e => e.stopPropagation());
    badge.addEventListener('dblclick', e => { e.preventDefault(); e.stopPropagation(); });
  }

  function paintBadge(badge, shownNum, isCustom, realNum) {
    if (shownNum == null) { badge.style.display = 'none'; return; }
    const c = colorOf(shownNum);
    badge.style.display = '';
    badge.textContent = (isCustom ? '★ ' : '') + fmt(shownNum) + '%';
    badge.style.background = c.bg;
    badge.style.color = c.fg;
    badge.dataset.custom = isCustom ? '1' : '0';
    const alerted = shownNum >= THRESHOLD;
    badge.classList.toggle(CLS_ALERT, alerted);
    badge.title =
      (isCustom ? '固定 ' + fmt(shownNum) + '%（实际 ' + (realNum == null ? '?' : fmt(realNum) + '%') + '）'
                : '实际进度 ' + fmt(shownNum) + '%') +
      (alerted ? ' ⚠ 已超过阈值 ' + THRESHOLD + '%' : '') + ' · 点击设置';
  }

  /* ================= 渲染：顶栏徽章 ================= */
  function renderTopBadge() {
    let badge = document.querySelector('.' + CLS);
    if (!isProjectPage()) { if (badge) badge.remove(); return; }
    const pid = getProjectIdFromUrl();
    if (!pid) { if (badge) badge.remove(); return; }
    const mp = findMountPoint();
    if (!mp) return;

    if (!badge || !document.body.contains(badge) || badge.parentElement !== mp.el) {
      if (badge) badge.remove();
      badge = document.createElement('span');
      badge.className = CLS;
      bindBadge(
        badge,
        () => getProjectIdFromUrl(),
        () => (CACHE[getProjectIdFromUrl()] ? CACHE[getProjectIdFromUrl()].pct : null)
      );
      if (mp.mode === 'right') mp.el.insertBefore(badge, mp.el.firstChild);
      else if (mp.mode === 'context') {
        const rightEl = mp.el.querySelector('.ls-menu-header__context-item_right');
        if (rightEl) mp.el.insertBefore(badge, rightEl); else mp.el.appendChild(badge);
      } else mp.el.appendChild(badge);
    }

    const custom = CUSTOM[pid];
    if (custom != null) { paintBadge(badge, custom, true, CACHE[pid] ? CACHE[pid].pct : null); return; }
    const cached = CACHE[pid];
    if (cached && Date.now() - cached.ts < CACHE_TTL) { paintBadge(badge, cached.pct, false, cached.pct); return; }

    badge.style.display = '';
    badge.textContent = '--%';
    badge.style.background = '#9ca3af';
    badge.style.color = '#fff';
    badge.dataset.custom = '0';
    badge.classList.remove(CLS_ALERT);
    badge.title = '正在获取项目进度…';

    ensureProgress(pid, function (pct) {
      if (CUSTOM[pid] != null) { scan(); return; }
      const b = document.querySelector('.' + CLS);
      if (!b) return;
      if (pct == null) {
        b.textContent = '?%'; b.style.background = '#9ca3af'; b.style.color = '#fff';
        b.title = '进度获取失败 · 点击设置';
      } else paintBadge(b, pct, false, pct);
    });
  }

  /* ================= 渲染：列表页统计入口 ================= */
  function renderListEntry() {
    let entry = document.getElementById(LIST_ENTRY_ID);
    if (!isListPage()) {
      if (entry) entry.remove();
      closeListPanel();
      return;
    }
    const mp = findListMountPoint();
    if (!mp) { if (entry) entry.remove(); return; }

    const stats = collectCards();

    if (!entry || !document.body.contains(entry) || entry.parentElement !== mp.el) {
      if (entry) entry.remove();
      entry = document.createElement('button');
      entry.type = 'button';
      entry.id = LIST_ENTRY_ID;
      entry.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation();
        toggleListPanel(entry);
      });
      if (mp.mode === 'filter') mp.el.insertBefore(entry, mp.el.firstChild);
      else mp.el.appendChild(entry);
    }

    const total = stats.below + stats.ok;
    entry.classList.toggle('lspct-list-entry--warn', stats.below > 0);
    entry.innerHTML =
      '<span>未达 ' + LIST_THRESHOLD + '%</span>' +
      '<span class="lspct-list-entry-n">' + stats.below + '</span>' +
      '<span style="color:#9ca3af;font-weight:400">/ ' + total + '</span>';
    entry.title = '当前页共 ' + total + ' 个项目，其中 ' + stats.below +
                  ' 个进度 < ' + LIST_THRESHOLD + '%（点击查看清单，阈值可在浮层内修改）';

    if (document.getElementById(LIST_PANEL_ID)) updateListPanel(stats);
  }

  /* ================= 列表页浮层 ================= */
  let listPanelEl = null;
  function closeListPanel() {
    if (listPanelEl && listPanelEl.parentNode) listPanelEl.parentNode.removeChild(listPanelEl);
    listPanelEl = null;
    document.removeEventListener('mousedown', onListDocDown, true);
    document.removeEventListener('keydown', onListDocKey, true);
  }
  function onListDocDown(e) {
    if (!listPanelEl) return;
    if (listPanelEl.contains(e.target)) return;
    const entry = document.getElementById(LIST_ENTRY_ID);
    if (entry && entry.contains(e.target)) return;
    closeListPanel();
  }
  function onListDocKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); closeListPanel(); }
  }

  function toggleListPanel(entry) {
    if (listPanelEl) { closeListPanel(); return; }
    openListPanel(entry);
  }

  function openListPanel(entry) {
    injectStyle();
    listPanelEl = document.createElement('div');
    listPanelEl.id = LIST_PANEL_ID;
    listPanelEl.innerHTML = `
      <div class="lspct-lp-head">
        <span class="lspct-lp-title">未达标项目（< <span id="lspct-lp-thr-txt">${LIST_THRESHOLD}</span>%）</span>
        <span class="lspct-lp-close" title="关闭 (ESC)">✕</span>
      </div>
      <div class="lspct-lp-thr">
        <span>阈值</span>
        <input id="lspct-lp-thr-in" type="number" step="0.1" min="0" max="100" value="${LIST_THRESHOLD}">
        <span>%</span>
        <span style="color:#9ca3af;margin-left:auto">点击行 → 审核页</span>
      </div>
      <div class="lspct-lp-list" id="lspct-lp-list"></div>
    `;
    document.body.appendChild(listPanelEl);

    const r = entry.getBoundingClientRect();
    const pw = 320;
    let left = r.left;
    let top = r.bottom + 6;
    if (left + pw > innerWidth - 8) left = innerWidth - pw - 8;
    if (left < 8) left = 8;
    listPanelEl.style.left = left + 'px';
    listPanelEl.style.top = top + 'px';

    listPanelEl.querySelector('.lspct-lp-close').addEventListener('click', closeListPanel);

    const thrIn = listPanelEl.querySelector('#lspct-lp-thr-in');
    thrIn.addEventListener('input', function () {
      const v = parseFloat(thrIn.value);
      if (Number.isFinite(v)) {
        LIST_THRESHOLD = Math.max(0, Math.min(100, v));
        saveListThreshold(LIST_THRESHOLD);
        scan();
      }
    });

    updateListPanel(collectCards());

    setTimeout(function () {
      document.addEventListener('mousedown', onListDocDown, true);
      document.addEventListener('keydown', onListDocKey, true);
    }, 0);
  }

  function updateListPanel(stats) {
    if (!listPanelEl) return;
    const thrTxt = listPanelEl.querySelector('#lspct-lp-thr-txt');
    if (thrTxt) thrTxt.textContent = LIST_THRESHOLD;

    const listEl = listPanelEl.querySelector('#lspct-lp-list');
    if (!listEl) return;

    const belowItems = stats.list.filter(x => x.below);
    if (belowItems.length === 0) {
      listEl.innerHTML = '<div class="lspct-lp-empty">当前页没有未达标项目 ✓</div>';
      return;
    }
    listEl.innerHTML = belowItems.map(function (it) {
      const c = colorOf(it.pct);
      const name = it.name.replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return `<div class="lspct-lp-item" data-pid="${it.id || ''}">
        <span class="lspct-lp-item-name" title="${name}">${name}</span>
        <span class="lspct-lp-item-pct" style="background:${c.bg};color:${c.fg}">${fmt(it.pct)}%</span>
      </div>`;
    }).join('');

    listEl.querySelectorAll('.lspct-lp-item').forEach(function (row) {
      row.addEventListener('click', function () {
        const pid = row.dataset.pid;
        if (!pid) return;
        const ws = getWorkspaceFromUrl();
        // ★ 统一跳转到审核页（带 reviewing=1）
        location.href = `/review/workspaces/${ws}/projects/${pid}/data?reviewing=1`;
      });
    });
  }

  /* ================= 主扫描 ================= */
  function render() {
    if (!document.body) return;
    injectStyle();
    renderTopBadge();
    renderListEntry();
  }
  function scan() { render(); }

  /* ================= 防冲突：定时自检 ================= */
  let lastHref = location.href;
  setInterval(function () {
    if (location.href !== lastHref) {
      lastHref = location.href;
      [150, 400, 900].forEach(t => setTimeout(scan, t));
    }
    scan();
  }, 400);

  ['pushState', 'replaceState'].forEach(function (k) {
    const orig = history[k];
    history[k] = function () {
      const r = orig.apply(this, arguments);
      [150, 400, 900].forEach(t => setTimeout(scan, t));
      return r;
    };
  });
  window.addEventListener('popstate', () => [150, 400].forEach(t => setTimeout(scan, t)));

  /* ================= 调试入口 ================= */
  window.__LSPCT = {
    scan: scan,
    custom: () => CUSTOM,
    set: (pid, v) => { const n = parseFloat(v); if (Number.isFinite(n)) { CUSTOM[pid] = Math.max(0, Math.min(100, n)); saveCustom(CUSTOM); scan(); } },
    clear: (pid) => { delete CUSTOM[pid]; saveCustom(CUSTOM); scan(); },
    threshold: () => THRESHOLD,
    setThreshold: (v) => { const n = parseFloat(v); if (Number.isFinite(n)) { THRESHOLD = Math.max(0, Math.min(100, n)); saveThreshold(THRESHOLD); scan(); } return THRESHOLD; },
    listThreshold: () => LIST_THRESHOLD,
    setListThreshold: (v) => { const n = parseFloat(v); if (Number.isFinite(n)) { LIST_THRESHOLD = Math.max(0, Math.min(100, n)); saveListThreshold(LIST_THRESHOLD); scan(); } return LIST_THRESHOLD; },
    listStats: () => collectCards(),
    state: () => {
      const pid = getProjectIdFromUrl();
      const badge = document.querySelector('.' + CLS);
      const entry = document.getElementById(LIST_ENTRY_ID);
      const shown = pid != null && CUSTOM[pid] != null ? CUSTOM[pid] : (CACHE[pid] ? CACHE[pid].pct : null);
      return {
        url: location.pathname + location.search,
        isProjectPage: isProjectPage(),
        isListPage: isListPage(),
        pid: pid,
        ws: getWorkspaceFromUrl(),
        badgeExists: !!badge,
        listEntryExists: !!entry,
        listPanelOpen: !!listPanelEl,
        custom: pid != null ? CUSTOM[pid] : undefined,
        threshold: THRESHOLD,
        listThreshold: LIST_THRESHOLD,
        shown: shown,
        shownText: shown == null ? null : fmt(shown) + '%',
        autoRefresh: AUTO_REFRESH
      };
    },
    refresh: () => { const pid = getProjectIdFromUrl(); if (pid) { delete CACHE[pid]; scan(); } },
    autoRefresh: (on) => { AUTO_REFRESH = (on !== false); if (AUTO_REFRESH) startAutoRefresh(); else stopAutoRefresh(); return AUTO_REFRESH; },
    refreshNow: () => { const pid = getProjectIdFromUrl(); if (pid) { delete CACHE[pid]; scan(); } }
  };

  /* ================= 启动 ================= */
  injectStyle();
  scan();
  [150, 400, 900, 1500, 2500].forEach(t => setTimeout(scan, t));
  startAutoRefresh();
  log('已加载 v2.2.0');
})();
