// ==UserScript==
// @name         Insta360 项目卡片隐藏
// @namespace    https://label.insta360.com/
// @version      1.4.0
// @description  隐藏项目卡片并持久保存（隐藏后自动重排，不留空位），顶部入口可查看/恢复
// @match        *://label.insta360.com/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  var DEBUG = false;
  var log = function () { if (DEBUG) try { console.log.apply(console, ['[隐藏卡片]'].concat([].slice.call(arguments))); } catch (e) {} };

  var STORE_KEY = 'insta360-hidden-cards-v1';
  var CARD_SEL = '.ls-project-card';
  var CARD_ITEM_SEL = '.ls-projects-page__link, .ls-annotation-center-page__link, .ls-review-center-page__link, .ls-acceptance-center-page__link';
  var HIDE_ATTR = 'data-ovw-hidden';

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
    // 各中心页面都以对应的 *_page__link 作为 grid/flex 直接子项。
    // 隐藏这个外层节点才能让后续项目自动补位。
    var item = cardItem(card);
    if (item) return item;

    var node = card;
    while (node && node.parentElement && node !== document.body) {
      var p = node.parentElement;
      var disp = '';
      try { disp = getComputedStyle(p).display || ''; } catch (e) {}
      if (disp.indexOf('grid') !== -1 || disp.indexOf('flex') !== -1) {
        // node 是 p 的直接子项（一个格子）
        // 若这一格里还装着别的卡片，就不能隐藏整格
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
    // 先清理：已不在隐藏表里的，恢复显示
    var marked = document.querySelectorAll('[' + HIDE_ATTR + ']');
    for (var i = 0; i < marked.length; i++) {
      var m = marked[i];
      var c = (m.classList && m.classList.contains('ls-project-card')) ? m : m.querySelector(CARD_SEL);
      var id = c ? cardId(c) : '';
      if (!id || !hidden[id]) showSlot(m);
    }
    // 再应用
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
    // 统一重放一次，兼容列表组件在点击后同步/异步重绘的情况。
    applyHidden();
    updateEntryBadge();
    updateEntryNotice();
    log('已隐藏', id, t);
  }

  function unhide(id) {
    if (!id) return;
    delete hidden[id];
    saveHidden(hidden);
    applyHidden();
    updateEntryBadge();
    updateEntryNotice();
    renderPopList();
  }

  function unhideAll() {
    hidden = {};
    saveHidden(hidden);
    applyHidden();
    updateEntryBadge();
    updateEntryNotice();
    renderPopList();
  }

  /* ---------- 顶部入口 ---------- */
  var entryBtn = null;
  var entryWrap = null;
  var noticeEl = null;
  var popEl = null;

  function currentHiddenCount() {
    var ids = {};
    var cards = document.querySelectorAll(CARD_SEL);
    for (var i = 0; i < cards.length; i++) {
      var id = cardId(cards[i]);
      if (id) ids[id] = true;
    }
    var count = 0;
    Object.keys(hidden).forEach(function (id) {
      if (ids[id]) count++;
    });
    return count;
  }

  function findHeaderHost() {
    var sels = [
      '.ls-projects-page__title-container',
      '.ls-annotation-center-page__title-container',
      '.ls-review-center-page__title-container',
      '.ls-acceptance-center-page__title-container',
      '.ls-projects-page__header',
      '.ls-annotation-center-page__header',
      '.ls-review-center-page__header',
      '.ls-acceptance-center-page__header'
    ];
    for (var i = 0; i < sels.length; i++) {
      var host = document.querySelector(sels[i]);
      if (host) return host;
    }
    var back = document.querySelector('[class*="__back"]');
    return back && back.parentElement ? back.parentElement : null;
  }

  function updateEntryNotice() {
    if (!noticeEl) return;
    var n = currentHiddenCount();
    noticeEl.hidden = n === 0;
    noticeEl.textContent = n ? ('本项目包内有 ' + n + ' 个卡片已隐藏') : '';
  }

  function findToolbar() {
    var els = document.querySelectorAll('button, a');
    for (var i = 0; i < els.length; i++) {
      var tx = (els[i].textContent || '').trim();
      if (/^(创建项目|新建项目)$/.test(tx)) return els[i].parentElement;
    }
    var inp = document.querySelector('input[placeholder*="搜索"], input[placeholder*="项目名称"]');
    if (inp) {
      var p = inp.parentElement;
      for (var j = 0; j < 4 && p; j++) {
        if (p.querySelectorAll('button').length >= 1) return p;
        p = p.parentElement;
      }
    }
    return null;
  }

  function ensureEntryButton() {
    if (entryBtn && document.body.contains(entryBtn)) { updateEntryBadge(); updateEntryNotice(); return; }
    var bar = findToolbar();
    entryBtn = document.createElement('button');
    entryBtn.type = 'button';
    entryBtn.id = 'ovw-hide-entry';
    entryBtn.className = 'ovw-hide-entry';
    entryBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" style="vertical-align:-2px;margin-right:4px"><path d="M12 6c-3.98 0-7.35 2.5-8.9 6 1.55 3.5 4.92 6 8.9 6s7.35-2.5 8.9-6c-1.55-3.5-4.92-6-8.9-6zm0 10a4 4 0 1 1 0-8 4 4 0 0 1 0 8z"/></svg><span>隐藏的卡片</span> <span class="ovw-hide-entry-n">(0)</span>';
    entryBtn.addEventListener('click', function (e) { e.stopPropagation(); togglePop(); });
    if (bar) {
      bar.insertBefore(entryBtn, bar.firstChild);
    } else {
      entryBtn.style.position = 'fixed';
      entryBtn.style.top = '12px';
      entryBtn.style.right = '160px';
      entryBtn.style.zIndex = '9999';
      document.body.appendChild(entryBtn);
    }
    entryWrap = document.createElement('div');
    entryWrap.className = 'ovw-hide-entry-wrap';
    noticeEl = document.createElement('span');
    noticeEl.className = 'ovw-hide-notice';
    entryWrap.appendChild(noticeEl);
    if (entryBtn.parentElement) {
      entryBtn.parentElement.insertBefore(entryWrap, entryBtn);
      entryWrap.appendChild(entryBtn);
    }

    var host = findHeaderHost();
    entryBtn.style.removeProperty('position');
    entryBtn.style.removeProperty('top');
    entryBtn.style.removeProperty('right');
    entryBtn.style.removeProperty('z-index');
    if (host && entryWrap) {
      host.appendChild(entryWrap);
      entryWrap.classList.remove('ovw-hide-entry-fallback');
    } else if (entryWrap) {
      entryWrap.classList.add('ovw-hide-entry-fallback');
    }
    updateEntryBadge();
    updateEntryNotice();
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
    renderPopList();
    positionPop();
    document.addEventListener('click', onDocClick, true);
    window.addEventListener('resize', positionPop);
    window.addEventListener('scroll', positionPop, true);
  }

  function closePop() {
    if (!popEl) return;
    popEl.remove(); popEl = null;
    document.removeEventListener('click', onDocClick, true);
    window.removeEventListener('resize', positionPop);
    window.removeEventListener('scroll', positionPop, true);
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
    var html = '<div class="ovw-hide-pop-head">已隐藏的卡片 <span class="ovw-hide-pop-n">' + ids.length + '</span></div>';
    if (!ids.length) {
      html += '<div class="ovw-hide-pop-empty">暂无隐藏的卡片</div>';
    } else {
      html += '<div class="ovw-hide-pop-list">';
      ids.forEach(function (id) {
        var name = nameOf(id);
        html += '<div class="ovw-hide-pop-item">' +
                '<span class="ovw-hide-pop-name" title="' + esc(name) + '">' + esc(name) + '</span>' +
                '<button type="button" class="ovw-hide-pop-restore" data-id="' + esc(id) + '">恢复</button>' +
                '</div>';
      });
      html += '</div>';
      html += '<div class="ovw-hide-pop-foot"><button type="button" class="ovw-hide-pop-all">全部恢复</button></div>';
    }
    popEl.innerHTML = html;

    popEl.querySelectorAll('.ovw-hide-pop-restore').forEach(function (b) {
      b.addEventListener('click', function (e) { e.stopPropagation(); unhide(b.getAttribute('data-id')); positionPop(); });
    });
    var allBtn = popEl.querySelector('.ovw-hide-pop-all');
    if (allBtn) allBtn.addEventListener('click', function (e) { e.stopPropagation(); unhideAll(); positionPop(); });
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
      '.ovw-hide-entry-wrap{display:inline-flex;align-items:center;gap:10px;margin-left:16px;vertical-align:middle;}',
      '.ovw-hide-entry-wrap.ovw-hide-entry-fallback{position:fixed;top:12px;right:160px;z-index:9999;margin-left:0;}',
      '.ovw-hide-notice{display:inline-flex;align-items:center;color:#8c8c8c;font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",Arial,sans-serif;white-space:nowrap;}',
      '.ovw-hide-entry{display:inline-flex;align-items:center;height:32px;padding:0 12px;margin-right:0;border:1px solid #d9d9d9;border-radius:6px;background:#fff;color:rgba(0,0,0,.75);font:13px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",Arial,sans-serif;cursor:pointer;transition:all .12s;}',
      '.ovw-hide-entry:hover{border-color:#1677ff;color:#1677ff;}',
      '.ovw-hide-pop{position:fixed;z-index:2147483600;background:#fff;border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.16);border:1px solid rgba(0,0,0,.06);font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",Arial,sans-serif;color:#262626;overflow:hidden;}',
      '.ovw-hide-pop-head{padding:10px 12px;font-weight:600;border-bottom:1px solid rgba(0,0,0,.06);}',
      '.ovw-hide-pop-n{color:#8c8c8c;font-weight:400;margin-left:2px;}',
      '.ovw-hide-pop-empty{padding:24px 12px;text-align:center;color:#bfbfbf;}',
      '.ovw-hide-pop-list{max-height:320px;overflow-y:auto;padding:4px;}',
      '.ovw-hide-pop-item{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;}',
      '.ovw-hide-pop-item:hover{background:rgba(0,0,0,.03);}',
      '.ovw-hide-pop-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#595959;}',
      '.ovw-hide-pop-restore{border:0;background:transparent;color:#1677ff;cursor:pointer;font-size:12.5px;padding:2px 8px;border-radius:4px;}',
      '.ovw-hide-pop-restore:hover{background:rgba(22,119,255,.1);}',
      '.ovw-hide-pop-foot{padding:8px 10px;border-top:1px solid rgba(0,0,0,.06);text-align:right;}',
      '.ovw-hide-pop-all{border:0;background:transparent;color:#8c8c8c;cursor:pointer;font-size:12.5px;padding:4px 8px;border-radius:4px;}',
      '.ovw-hide-pop-all:hover{background:rgba(0,0,0,.05);color:#262626;}'
    ].join('');
    document.head.appendChild(s);
  }

  /* ---------- 启动 ---------- */
  function boot() {
    addStyle();
    injectCardButtons();
    applyHidden();
    ensureEntryButton();

    var t = null;
    var mo = new MutationObserver(function () {
      if (t) return;
      t = setTimeout(function () {
        t = null;
        injectCardButtons();
        applyHidden();
        ensureEntryButton();
        if (popEl) { renderPopList(); positionPop(); }
      }, 150);
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();

  window.__HIDECARDS = {
    list: function () { return Object.assign({}, hidden); },
    hide: function (id, name) { if (id) { hidden[id] = name || hidden[id] || ('项目 #' + id); saveHidden(hidden); applyHidden(); updateEntryBadge(); } },
    unhide: unhide,
    clear: unhideAll,
    refresh: function () { injectCardButtons(); applyHidden(); ensureEntryButton(); },
    slotOf: function (card) { return locateSlot(card); },
  };
})();
