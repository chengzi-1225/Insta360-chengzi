// ==UserScript==
// @name         Insta360 下一张切换加速（独立版）
// @namespace    insta360.next-item-fast
// @version      1.0.1
// @description  独立优化标注页上一张/下一张切换：单次点击、短暂防重复排队，不依赖其他脚本。
// @updateURL    https://raw.githubusercontent.com/chengzi-1225/Insta360-chengzi/main/Insta360-下一张切换加速.user.js
// @downloadURL  https://raw.githubusercontent.com/chengzi-1225/Insta360-chengzi/main/Insta360-下一张切换加速.user.js
// @match        https://label.insta360.com/*
// @match        *://*.labelstud.io/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  const INSTANCE = '__INSTA360_NEXT_ITEM_FAST__';
  if (window[INSTANCE]) return;
  window[INSTANCE] = true;

  const TOOLBAR_ID = '__insta360_next_item_fast_toolbar';
  const STYLE_ID = '__insta360_next_item_fast_style';
  const ITEM_SELECTOR = '.lsf-outliner-item';
  const LOCK_MS = 160;
  let lastActivation = -Infinity;
  let toolbar = null;
  let observer = null;
  let mountTimer = null;

  const visible = node => {
    if (!node?.isConnected || node.closest('.lsf-panel-tabs__ghost-tab')) return false;
    if (node.hidden || node.getAttribute('aria-hidden') === 'true') return false;
    for (let p = node; p; p = p.parentElement) {
      const css = getComputedStyle(p);
      if (p.hidden || css.display === 'none' || css.visibility === 'hidden' || css.opacity === '0') return false;
    }
    return node.getClientRects().length > 0;
  };

  function items() {
    return [...document.querySelectorAll(ITEM_SELECTOR)].filter(visible);
  }

  function activeItem(list) {
    return list.find(item => item.classList.contains('lsf-outliner-item_active')) ||
      list.find(item => item.closest('.lsf-tree-treenode-selected, .lsf-tree-node-selected,[aria-selected="true"]')) ||
      list.find(item => item.getAttribute('aria-selected') === 'true') || null;
  }

  function activate(item) {
    if (!item || !visible(item)) return false;
    const now = performance.now();
    if (now - lastActivation < LOCK_MS) return false;
    lastActivation = now;
    item.scrollIntoView?.({block: 'nearest'});
    item.click?.();
    return true;
  }

  function navigate(direction) {
    const list = items();
    if (!list.length) return false;
    const current = activeItem(list);
    const index = current ? list.indexOf(current) : -1;
    const targetIndex = index < 0 ? (direction > 0 ? 0 : list.length - 1) :
      (index + direction + list.length) % list.length;
    return activate(list[targetIndex]);
  }

  function isEditing(target) {
    return !!target?.closest?.('input,textarea,select,[contenteditable="true"],[role="textbox"],[role="combobox"],dialog,.ant-modal,.ant-drawer');
  }

  function mountStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${TOOLBAR_ID}{display:inline-flex;align-items:center;gap:4px;margin-left:8px;z-index:10001;}
      #${TOOLBAR_ID} button{height:28px;padding:0 9px;border:1px solid #cbd8e8;border-radius:5px;background:#fff;color:#31577f;font:12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;cursor:pointer;}
      #${TOOLBAR_ID} button:hover{background:#edf5ff;border-color:#7aa9df;}
      #${TOOLBAR_ID} button:active{transform:translateY(1px);}
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function toolbarHost() {
    return document.querySelector('.lsf-topbar__group_slot_right') ||
      document.querySelector('.lsf-topbar__group') ||
      document.querySelector('.lsf-topbar');
  }

  function mount() {
    mountTimer = null;
    mountStyle();
    const host = toolbarHost();
    if (!host) return;
    if (!toolbar || !toolbar.isConnected) {
      toolbar = document.createElement('span');
      toolbar.id = TOOLBAR_ID;
      toolbar.innerHTML = '<button type="button" data-dir="-1" aria-label="上一张">← 上一张</button><button type="button" data-dir="1" aria-label="下一张">下一张 →</button>';
      toolbar.addEventListener('click', event => {
        const button = event.target.closest('button[data-dir]');
        if (!button) return;
        event.preventDefault();
        event.stopPropagation();
        navigate(Number(button.dataset.dir));
      });
    }
    if (toolbar.parentElement !== host) host.appendChild(toolbar);
  }

  function scheduleMount() {
    if (mountTimer === null) mountTimer = window.setTimeout(mount, 80);
  }

  function start() {
    mount();
    window.addEventListener('keydown', event => {
      if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || isEditing(event.target)) return;
      const key = String(event.key || '').toLowerCase();
      if (key !== 'a' && key !== 'd') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!event.repeat) navigate(key === 'd' ? 1 : -1);
    }, true);
    observer = new MutationObserver(scheduleMount);
    observer.observe(document.body, {childList: true, subtree: true});
  }

  window.__INSTA360_NEXT_ITEM_FAST_API__ = {
    next: () => navigate(1),
    previous: () => navigate(-1),
    status: () => ({items: items().length, active: activeItem(items())?.textContent?.trim() || null}),
    destroy: () => {
      observer?.disconnect();
      toolbar?.remove();
      document.getElementById(STYLE_ID)?.remove();
      delete window.__INSTA360_NEXT_ITEM_FAST_API__;
      delete window[INSTANCE];
    },
  };

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, {once: true});
})();
