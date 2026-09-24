// ==UserScript==
// @name         Insta360 项目卡片隐藏
// @namespace    https://label.insta360.com/
// @version      2.1.2
// @description  隐藏项目卡片并持久保存（隐藏后自动重排，不留空位），入口固定在「所有项目」左侧，本页有隐藏卡片时入口高亮
// @match        https://label.insta360.com/*
// @match        https://label.insta360.com/workspaces/*/projects*
// @match        https://label.insta360.com/annotation/workspaces/*
// @match        https://label.insta360.com/review/workspaces/*
// @match        https://label.insta360.com/acceptance/workspaces/*
// @run-at       document-idle
// @grant        none
// @noframes
// @updateURL    https://raw.githubusercontent.com/chengzi-1225/Insta360-chengzi/refs/heads/main/Insta360项目卡片隐藏.user.js
// @downloadURL  https://raw.githubusercontent.com/chengzi-1225/Insta360-chengzi/refs/heads/main/Insta360项目卡片隐藏.user.js
// ==/UserScript==

(function () {
  'use strict';

  var DEBUG = false;
  var log = function () { if (DEBUG) try { console.log.apply(console, ['[隐藏卡片]'].concat([].slice.call(arguments))); } catch (e) {} };

  var STORE_KEY = 'insta360-hidden-cards-v1';
  var CARD_SEL = '.ls-project-card';
  var CARD_ITEM_SEL = '.ls-projects-page__link, .ls-annotation-center-page__link, .ls-review-center-page__link, .ls-acceptance-center-page__link';
  var HIDE_ATTR = 'data-ovw-hidden';
  var MANAGED_PATHS = [
    /^\/workspaces\/[^/]+\/projects\/?$/,
    /^\/(?:annotation|review|acceptance)\/workspaces\/[^/]+\/?$/
  ];
  var active = false;
  var lastHref = location.href;

  function isManagedPage(url) {
    var u;
    try { u = new URL(url || location.href, location.origin); } catch (e) { return false; }
    return u.origin === location.origin && MANAGED_PATHS.some(function (path) {
      return path instanceof RegExp ? path.test(u.pathname) : path === u.pathname;
    });
  }

  /* ---------- 存储 ---------- */
  function loadHidden() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      var o = raw ? JSON.parse(raw) : {};
      return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
    } catch (e) { return {}; }
  }
  function saveHidden(o) { try { localStorage.setItem(STORE_KEY, JSON.stringify(o)); } catch (e) {} }
  var hidden = loadHidden();

  function nameOf(id) {
    var v = hidden[id];
    if (typeof v === 'string' && v) return v;
    if (v && typeof v === 'object' && v.t) return v.t;
    return '项目 #' + id;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  /* ---------- 卡片识别 ---------- */
  function cardId(card) {
    if (!card) return '';
    var a = card.closest && card.closest('a[href]');
    if (!a) a = card.querySelector && card.querySelector('a[href]');
    if (a) {
      var m = String(a.getAttribute('href') || '').match(/\/projects\/(\d+)/);
      if (m) return m[1];
    }
    var ds = card.dataset || {};
    for (var k in ds) {
      if (Object.prototype.hasOwnProperty.call(ds, k) && /project/i.test(k) && /^\d+$/.test(ds[k])) return ds[k];
    }
    var as = card.querySelectorAll ? card.querySelectorAll('a[href]') : [];
    for (var i = 0; i < as.length; i++) {
      var m2 = String(as[i].getAttribute('href') || '').match(/\/projects\/(\d+)/);
      if (m2) return m2[1];
    }
    return '';
  }

  function cardTitle(card) {
    if (!card) return '';
    var sels = ['.ls-project-card__title', '[class*="project-title"]', '[class*="card-title"]', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'];
    for (var i = 0; i < sels.length; i++) {
      var el = card.querySelector(sels[i]);
      if (!el) continue;
      var t = (el.textContent || '').trim();
      if (t && t.length < 120) return t;
    }
    return '';
  }

  /* ---------- 找到真正占格子的元素 ---------- */
  function cardItem(card) {
    if (!card) return null;
    if (card.closest) {
      var item = card.closest(CARD_ITEM_SEL);
      if (item) return item;
    }
    var node = card;
    while (node && node.parentElement && node !== document.body) {
      node = node.parentElement;
      if (node.matches && node.matches(CARD_ITEM_SEL)) return node;
    }
    return null;
  }

  function locateSlot(card) {
    var item = cardItem(card);
    if (item) return item;

    var node = card;
    while (node && node.parentElement && node !== document.body) {
      var p = node.parentElement;
      var disp = '';
      try { disp = getComputedStyle(p).display || ''; } catch (e) {}
      if (disp.indexOf('grid') !== -1 || disp.indexOf('flex') !== -1) {
        var others = node.querySelectorAll ? node.querySelectorAll(CARD_SEL) : [];
        var visibleOther = 0;
        for (var i = 0; i < others.length; i++) {
          if (others[i] !== card && !others[i].hasAttribute(HIDE_ATTR)) visibleOther++;
        }
        if (visibleOther === 0) return node;
        return card;
      }
      node = p;
    }
    return card;
  }

  function hideSlot(slot) {
    if (!slot) return;
    slot.style.setProperty('display', 'none', 'important');
    slot.setAttribute(HIDE_ATTR, '1');
  }
  function showSlot(slot) {
    if (!slot) return;
    slot.style.removeProperty('display');
    slot.removeAttribute(HIDE_ATTR);
  }

  /* ---------- 应用隐藏 ---------- */
  function applyHidden() {
    var marked = document.querySelectorAll('[' + HIDE_ATTR + ']');
    for (var i = 0; i < marked.length; i++) {
      var m = marked[i];
      var c = (m.classList && m.classList.contains('ls-project-card')) ? m : m.querySelector(CARD_SEL);
      var id = c ? cardId(c) : '';
      if (!id || !hidden[id]) showSlot(m);
    }
    var cards = document.querySelectorAll(CARD_SEL);
    for (var j = 0; j < cards.length; j++) {
      var card = cards[j];
      var cid = cardId(card);
      if (cid && hidden[cid]) hideSlot(locateSlot(card));
    }
  }

  function injectCardButtons() {
    var cards = document.querySelectorAll(CARD_SEL);
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i];
      if (c.querySelector(':scope > .ovw-hide-btn')) continue;
      var id = cardId(c);
      if (!id) continue;
      if (getComputedStyle(c).position === 'static') c.style.position = 'relative';
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ovw-hide-btn';
      btn.title = '隐藏此卡片';
      btn.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M12 6c-3.98 0-7.35 2.5-8.9 6 1.55 3.5 4.92 6 8.9 6s7.35-2.5 8.9-6c-1.55-3.5-4.92-6-8.9-6zm0 10a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm0-2a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"/></svg>';
      btn.addEventListener('mousedown', function (e) { e.stopPropagation(); });
      btn.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation();
        hideCard(this.parentElement);
      });
      c.appendChild(btn);
    }
  }

  function hideCard(card) {
    var id = cardId(card);
    if (!id) { log('无法识别卡片 ID'); return; }
    var t = cardTitle(card) || ('项目 #' + id);
    hidden[id] = t;
    saveHidden(hidden);
    hideSlot(locateSlot(card));
    applyHidden();
    updateEntryBadge();
    updateEntryNotice(true);
    log('已隐藏', id, t);
  }

  /* ★ v2.1.2：恢复不再重建弹层，原地标记为「已恢复」 */
  function unhide(id) {
    if (!id) return;
    if (!Object.prototype.hasOwnProperty.call(hidden, id)) {
      /* 数据里已经没有，但 UI 上可能还是可点状态，统一置灰 */
      markRestored(id);
      refreshPopHead();
      return;
    }
    delete hidden[id];
    saveHidden(hidden);
    if (active) applyHidden();
    updateEntryBadge();
    updateEntryNotice(true);
    markRestored(id);
    refreshPopHead();
  }

  function unhideAll() {
    hidden = {};
    saveHidden(hidden);
    if (active) applyHidden();
    updateEntryBadge();
    updateEntryNotice(true);
    renderPopList();
    positionPop();
  }

  /* ---------- 顶部入口 ---------- */
  var entryBtn = null;
  var entryWrap = null;
  var popEl = null;

  /* 当前页面（本项目包）里真实出现的 projectId 集合 */
  function currentPageIds() {
    var ids = {};
    var cards = document.querySelectorAll(CARD_SEL);
    for (var i = 0; i < cards.length; i++) {
      var id = cardId(cards[i]);
      if (id) ids[id] = true;
    }
    return ids;
  }

  function currentHiddenCount() {
    var ids = currentPageIds();
    var count = 0;
    Object.keys(hidden).forEach(function (id) {
      if (ids[id]) count++;
    });
    return count;
  }

  /* 找到搜索框组的宿主：优先 .ant-input-group-wrapper */
  function findSearchHost() {
    var input = document.querySelector('input[placeholder*="项目名称"]')
      || document.querySelector('input[placeholder*="搜索"]')
      || document.querySelector('input[type="search"]');
    if (!input) return null;
    var host = input.closest('.ant-input-group-wrapper');
    if (host) return host;
    host = input.closest('.ant-input-affix-wrapper');
    if (host) return host;
    return input.parentElement;
  }

  /* ★ v2.1.0：不再显示文字提示，改为“本页有隐藏卡片 → 入口按钮高亮” */
  var lastNoticeTs = 0;
  function updateEntryNotice(force) {
    if (!entryBtn) return;
    var now = Date.now();
    if (!force && now - lastNoticeTs < 800) return;
    lastNoticeTs = now;
    var has = currentHiddenCount() > 0;
    entryBtn.classList.toggle('ovw-hide-entry--active', has);
    entryBtn.title = has ? '本项目包内有卡片已隐藏，点击查看/恢复' : '隐藏的卡片';
  }

  /* ★ 每次调用都校验位置：不对就挪到「所有项目」左侧 */
  function ensureEntryButton() {
    var host = findSearchHost();
    var targetParent = (host && host.parentElement) ? host.parentElement : null;

    /* 已挂载 → 校验位置 */
    if (entryBtn && entryWrap && document.body.contains(entryBtn)) {
      if (targetParent) {
        var wrongParent = entryWrap.parentElement !== targetParent;
        var wrongNext = entryWrap.nextElementSibling !== host;
        if (wrongParent || wrongNext) {
          try {
            targetParent.insertBefore(entryWrap, host);
            entryWrap.classList.remove('ovw-hide-entry-fallback');
            log('入口位置已校正');
          } catch (e) {}
        }
      }
      updateEntryBadge();
      updateEntryNotice();
      return;
    }

    /* 首次挂载 */
    entryWrap = document.createElement('div');
    entryWrap.className = 'ovw-hide-entry-wrap';

    entryBtn = document.createElement('button');
    entryBtn.type = 'button';
    entryBtn.id = 'ovw-hide-entry';
    entryBtn.className = 'ovw-hide-entry';
    entryBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" style="vertical-align:-2px;margin-right:4px">' +
        '<path d="M12 6c-3.98 0-7.35 2.5-8.9 6 1.55 3.5 4.92 6 8.9 6s7.35-2.5 8.9-6c-1.55-3.5-4.92-6-8.9-6zm0 10a4 4 0 1 1 0-8 4 4 0 0 1 0 8z"/>' +
      '</svg>' +
      '<span>隐藏的卡片</span> <span class="ovw-hide-entry-n">(0)</span>';
    entryBtn.addEventListener('click', function (e) { e.stopPropagation(); togglePop(); });
    entryWrap.appendChild(entryBtn);

    if (targetParent) {
      try {
        targetParent.insertBefore(entryWrap, host);
        entryWrap.classList.remove('ovw-hide-entry-fallback');
      } catch (e) {
        entryWrap.classList.add('ovw-hide-entry-fallback');
        document.body.appendChild(entryWrap);
      }
    } else {
      /* 首屏搜索框还没渲染时先放 body，后续 MutationObserver 会挪回去 */
      entryWrap.classList.add('ovw-hide-entry-fallback');
      document.body.appendChild(entryWrap);
    }

    updateEntryBadge();
    updateEntryNotice(true);
  }

  function updateEntryBadge() {
    if (!entryBtn) return;
    var n = Object.keys(hidden).length;
    var el = entryBtn.querySelector('.ovw-hide-entry-n');
    if (el) el.textContent = '(' + n + ')';
  }

  function togglePop() { if (popEl) closePop(); else openPop(); }

  function openPop() {
    closePop();
    popEl = document.createElement('div');
    popEl.className = 'ovw-hide-pop';
    document.body.appendChild(popEl);

    /* ★ v2.1.2：事件委托，只绑一次；恢复用 pointerdown（响应更快、不怕元素被替换） */
    var downEvt = window.PointerEvent ? 'pointerdown' : 'mousedown';
    popEl.addEventListener(downEvt, onPopPointerDown, true);
    popEl.addEventListener('click', onPopClick, true);

    renderPopList();
    positionPop();
    document.addEventListener('click', onDocClick, true);
    window.addEventListener('resize', positionPop);
    window.addEventListener('scroll', positionPop, true);
  }

  function closePop() {
    if (!popEl) return;
    var downEvt = window.PointerEvent ? 'pointerdown' : 'mousedown';
    popEl.removeEventListener(downEvt, onPopPointerDown, true);
    popEl.removeEventListener('click', onPopClick, true);
    popEl.remove(); popEl = null;
    document.removeEventListener('click', onDocClick, true);
    window.removeEventListener('resize', positionPop);
    window.removeEventListener('scroll', positionPop, true);
  }

  /* ★ v2.1.2：恢复按钮在 pointerdown 就响应 */
  function onPopPointerDown(e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var restore = t.closest('.ovw-hide-pop-restore');
    if (!restore) return;
    e.preventDefault();
    e.stopPropagation();
    if (restore.disabled || restore.classList.contains('ovw-hide-pop-restore--done')) return;
    unhide(restore.getAttribute('data-id'));
  }

  /* 全部恢复仍走 click（避免误触） */
  function onPopClick(e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var all = t.closest('.ovw-hide-pop-all');
    if (!all) return;
    e.preventDefault();
    e.stopPropagation();
    unhideAll();
  }

  function onDocClick(e) {
    if (!popEl) return;
    if (popEl.contains(e.target)) return;
    if (entryBtn && entryBtn.contains(e.target)) return;
    closePop();
  }

  function positionPop() {
    if (!popEl || !entryBtn) return;
    var r = entryBtn.getBoundingClientRect();
    var w = 280;
    var left = Math.min(r.right - w, window.innerWidth - w - 8);
    left = Math.max(8, left);
    popEl.style.position = 'fixed';
    popEl.style.top = (r.bottom + 6) + 'px';
    popEl.style.left = left + 'px';
    popEl.style.width = w + 'px';
  }

  function renderPopList() {
    if (!popEl) return;
    var ids = Object.keys(hidden);
    /* ★ v2.1.1：当前项目包里真实存在的 id 才高亮 */
    var here = currentPageIds();
    var hereCount = 0;
    ids.forEach(function (id) { if (here[id]) hereCount++; });

    var html = '<div class="ovw-hide-pop-head">已隐藏的卡片 <span class="ovw-hide-pop-n">' + ids.length + '</span>' +
               (hereCount ? '<span class="ovw-hide-pop-head-hint">本项目包 ' + hereCount + '</span>' : '') +
               '</div>';
    if (!ids.length) {
      html += '<div class="ovw-hide-pop-empty">暂无隐藏的卡片</div>';
    } else {
      html += '<div class="ovw-hide-pop-list">';
      ids.forEach(function (id) {
        var name = nameOf(id);
        var isHere = !!here[id];
        html += '<div class="ovw-hide-pop-item" data-id="' + esc(id) + '">' +
                  '<span class="ovw-hide-pop-name' + (isHere ? ' ovw-hide-pop-name--here' : '') + '"' +
                        ' title="' + esc(name) + (isHere ? '（本项目包）' : '（其他项目包）') + '">' +
                    esc(name) +
                  '</span>' +
                  '<button type="button" class="ovw-hide-pop-restore" data-id="' + esc(id) + '">恢复</button>' +
                '</div>';
      });
      html += '</div>';
      html += '<div class="ovw-hide-pop-foot"><button type="button" class="ovw-hide-pop-all">全部恢复</button></div>';
    }
    popEl.innerHTML = html;
  }

  /* ★ v2.1.2：把某一行原地置为「已恢复」，不移除、不重排 */
  function markRestored(id) {
    if (!popEl || !id) return;
    var items = popEl.querySelectorAll('.ovw-hide-pop-item');
    for (var i = 0; i < items.length; i++) {
      if (items[i].getAttribute('data-id') !== String(id)) continue;
      items[i].classList.add('ovw-hide-pop-item--restored');
      var nm = items[i].querySelector('.ovw-hide-pop-name');
      if (nm) nm.classList.remove('ovw-hide-pop-name--here');
      var b = items[i].querySelector('.ovw-hide-pop-restore');
      if (b) {
        b.disabled = true;
        b.classList.add('ovw-hide-pop-restore--done');
        b.textContent = '已恢复';
      }
      break;
    }
    /* 全部恢复完 → 显示空态 */
    if (!Object.keys(hidden).length) renderPopList();
  }

  /* ★ v2.1.2：增量刷新头部计数 +「本项目包 N」徽标（不重建列表） */
  function refreshPopHead() {
    if (!popEl) return;
    var ids = Object.keys(hidden);
    var here = currentPageIds();
    var hereCount = 0;
    ids.forEach(function (id) { if (here[id]) hereCount++; });

    var nEl = popEl.querySelector('.ovw-hide-pop-n');
    if (nEl) nEl.textContent = ids.length;

    var head = popEl.querySelector('.ovw-hide-pop-head');
    var hEl = popEl.querySelector('.ovw-hide-pop-head-hint');
    if (hereCount) {
      if (hEl) {
        hEl.textContent = '本项目包 ' + hereCount;
      } else if (head) {
        hEl = document.createElement('span');
        hEl.className = 'ovw-hide-pop-head-hint';
        hEl.textContent = '本项目包 ' + hereCount;
        head.appendChild(hEl);
      }
    } else if (hEl) {
      hEl.remove();
    }
  }

  /* ★ v2.1.2：MO 触发时只增量刷新高亮，绝不重建弹层（重建会导致点击丢失） */
  function refreshPopState() {
    if (!popEl) return;
    var here = currentPageIds();
    var names = popEl.querySelectorAll('.ovw-hide-pop-name');
    for (var i = 0; i < names.length; i++) {
      var nm = names[i];
      var item = nm.closest ? nm.closest('.ovw-hide-pop-item') : null;
      var id = item ? item.getAttribute('data-id') : '';
      if (!id) continue;
      if (item.classList && item.classList.contains('ovw-hide-pop-item--restored')) continue;
      var isHere = !!here[id];
      nm.classList.toggle('ovw-hide-pop-name--here', isHere);
      nm.title = nameOf(id) + (isHere ? '（本项目包）' : '（其他项目包）');
    }
    refreshPopHead();
  }

  /* ---------- 样式 ---------- */
  function addStyle() {
    if (document.getElementById('ovw-hide-style')) return;
    var s = document.createElement('style');
    s.id = 'ovw-hide-style';
    s.textContent = [
      '.ovw-hide-btn{position:absolute;top:6px;left:6px;z-index:20;width:24px;height:24px;border:0;border-radius:6px;background:rgba(255,255,255,.88);color:#8c8c8c;cursor:pointer;display:none;align-items:center;justify-content:center;box-shadow:0 1px 4px rgba(0,0,0,.12);transition:all .12s;}',
      '.ls-project-card:hover .ovw-hide-btn{display:inline-flex;}',
      '.ovw-hide-btn:hover{background:#fff;color:#ff4d4f;}',

      /* 入口容器：紧贴「所有项目」下拉框左侧 */
      '.ovw-hide-entry-wrap{display:inline-flex;align-items:center;gap:10px;margin-right:8px;vertical-align:middle;flex:0 0 auto;white-space:nowrap;}',
      '.ovw-hide-entry-wrap.ovw-hide-entry-fallback{position:fixed;top:12px;right:160px;z-index:9999;margin-right:0;}',
      '.ovw-hide-entry{display:inline-flex;align-items:center;height:32px;padding:0 12px;border:1px solid #d9d9d9;border-radius:6px;background:#fff;color:rgba(0,0,0,.75);font:13px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",Arial,sans-serif;cursor:pointer;transition:all .12s;flex:0 0 auto;white-space:nowrap;min-width:max-content;}',
      '.ovw-hide-entry:hover{border-color:#1677ff;color:#1677ff;}',

      /* ★ v2.1.0 本页有隐藏卡片 → 入口整体高亮 + 呼吸圆点 */
      '.ovw-hide-entry--active{border-color:#fa8c16;color:#d46b08;background:#fff7e6;box-shadow:0 0 0 2px rgba(250,140,22,.15);}',
      '.ovw-hide-entry--active:hover{border-color:#d46b08;color:#d46b08;background:#fff2e0;}',
      '.ovw-hide-entry--active::after{content:"";width:6px;height:6px;border-radius:50%;background:#fa8c16;margin-left:6px;flex:0 0 auto;animation:ovw-hide-pulse 1.4s ease-in-out infinite;}',
      '@keyframes ovw-hide-pulse{0%,100%{opacity:1;transform:scale(1);}50%{opacity:.4;transform:scale(.75);}}',

      /* 兜底：按钮里的文字和图标都不换行 */
      '.ovw-hide-entry span,.ovw-hide-entry svg{white-space:nowrap;flex:0 0 auto;}',

      '.ovw-hide-pop{position:fixed;z-index:2147483600;background:#fff;border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.16);border:1px solid rgba(0,0,0,.06);font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",Arial,sans-serif;color:#262626;overflow:hidden;}',
      '.ovw-hide-pop-head{padding:10px 12px;font-weight:600;border-bottom:1px solid rgba(0,0,0,.06);}',
      '.ovw-hide-pop-n{color:#8c8c8c;font-weight:400;margin-left:2px;}',
      '.ovw-hide-pop-head-hint{float:right;color:#d46b08;background:#fff7e6;border:1px solid #ffd591;border-radius:10px;padding:1px 8px;font-size:11.5px;font-weight:500;}',
      '.ovw-hide-pop-empty{padding:24px 12px;text-align:center;color:#bfbfbf;}',
      '.ovw-hide-pop-list{max-height:320px;overflow-y:auto;padding:4px;}',
      '.ovw-hide-pop-item{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;}',
      '.ovw-hide-pop-item:hover{background:rgba(0,0,0,.03);}',

      /* 默认：非本项目包 → 普通文字，不高亮 */
      '.ovw-hide-pop-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#595959;}',
      /* ★ v2.1.1：属于本项目包 → 高亮标签 */
      '.ovw-hide-pop-name--here{color:#ad4e00;background:#fff7e6;border:1px solid #ffd591;border-radius:4px;padding:2px 6px;font-weight:600;}',

      /* 恢复按钮：加大点击热区，避免点不中 */
      '.ovw-hide-pop-restore{border:0;background:transparent;color:#1677ff;cursor:pointer;font-size:12.5px;padding:4px 10px;min-height:24px;border-radius:4px;flex:0 0 auto;user-select:none;transition:background .1s;}',
      '.ovw-hide-pop-restore:hover{background:rgba(22,119,255,.12);}',
      '.ovw-hide-pop-restore:active{background:rgba(22,119,255,.22);}',
      '.ovw-hide-pop-restore:disabled,.ovw-hide-pop-restore--done{color:#bfbfbf;background:transparent;cursor:default;}',

      /* ★ v2.1.2：已恢复的行原地保留，置灰+删除线，列表不跳动 */
      '.ovw-hide-pop-item--restored{opacity:.6;}',
      '.ovw-hide-pop-item--restored .ovw-hide-pop-name{color:#bfbfbf;text-decoration:line-through;background:transparent;border-color:transparent;font-weight:400;}',

      '.ovw-hide-pop-foot{padding:8px 10px;border-top:1px solid rgba(0,0,0,.06);text-align:right;}',
      '.ovw-hide-pop-all{border:0;background:transparent;color:#8c8c8c;cursor:pointer;font-size:12.5px;padding:4px 8px;border-radius:4px;}',
      '.ovw-hide-pop-all:hover{background:rgba(0,0,0,.05);color:#262626;}'
    ].join('');
    document.head.appendChild(s);
  }

  function removeRenderedControls() {
    closePop();
    document.querySelectorAll('.ovw-hide-btn').forEach(function (btn) { btn.remove(); });
    document.querySelectorAll('[' + HIDE_ATTR + ']').forEach(function (slot) { showSlot(slot); });
    if (entryWrap) entryWrap.remove();
    entryBtn = null;
    entryWrap = null;
  }

  function activate() {
    if (!isManagedPage()) return;
    active = true;
    injectCardButtons();
    applyHidden();
    ensureEntryButton();
  }

  function deactivate() {
    if (!active && !entryWrap && !document.querySelector('.ovw-hide-btn')) return;
    active = false;
    removeRenderedControls();
  }

  function syncRoute() {
    if (isManagedPage()) activate();
    else deactivate();
  }

  function watchHistory() {
    ['pushState', 'replaceState'].forEach(function (method) {
      var original = window.history[method];
      if (typeof original !== 'function' || original.__ovwWrapped) return;
      var wrapped = function () {
        var result = original.apply(this, arguments);
        window.dispatchEvent(new Event('ovw-route-change'));
        return result;
      };
      wrapped.__ovwWrapped = true;
      window.history[method] = wrapped;
    });
    window.addEventListener('popstate', syncRoute);
    window.addEventListener('hashchange', syncRoute);
    window.addEventListener('ovw-route-change', syncRoute);
    function pollRoute() {
      var href = location.href;
      if (href !== lastHref) {
        lastHref = href;
        syncRoute();
      } else if (active && (!entryBtn || !document.body.contains(entryBtn))) {
        activate();
      }
      /* ★ 定时兜底刷新高亮状态（内部 800ms 节流） */
      if (active) updateEntryNotice();
    }
    setInterval(pollRoute, 400);
  }

  /* ---------- 启动 ---------- */
  function boot() {
    addStyle();
    watchHistory();
    syncRoute();

    var t = null;
    var mo = new MutationObserver(function () {
      if (t) return;
      t = setTimeout(function () {
        t = null;
        syncRoute();
        /* ★ v2.1.2：弹层打开时只增量刷新，不重建（重建会导致点击丢失） */
        if (popEl) refreshPopState();
      }, 150);
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();

  window.__HIDECARDS = {
    list: function () { return Object.assign({}, hidden); },
    hide: function (id, name) { if (id) { hidden[id] = name || hidden[id] || ('项目 #' + id); saveHidden(hidden); if (active) applyHidden(); updateEntryBadge(); updateEntryNotice(true); } },
    unhide: unhide,
    clear: unhideAll,
    refresh: function () { syncRoute(); },
    slotOf: function (card) { return locateSlot(card); },
    pageIds: currentPageIds,
    locateEntry: function () {
      return entryWrap ? {
        parent: entryWrap.parentElement,
        isFallback: entryWrap.classList.contains('ovw-hide-entry-fallback'),
        next: entryWrap.nextElementSibling,
        highlighted: entryBtn ? entryBtn.classList.contains('ovw-hide-entry--active') : false
      } : '未挂载';
    }
  };
})();
