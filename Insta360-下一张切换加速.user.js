// ==UserScript==
// @name         Insta360 下一张切换防重复（独立版）
// @namespace    insta360.next-item-dedupe
// @version      1.0.2
// @description  只处理下一张切换的重复事件：保留一次 click，屏蔽脚本额外派发的 mousedown / mouseup，并短暂防止重复 click 排队。
// @updateURL    https://raw.githubusercontent.com/chengzi-1225/Insta360-chengzi/main/Insta360-%E4%B8%8B%E4%B8%80%E5%BC%A0%E5%88%87%E6%8D%A2%E5%8A%A0%E9%80%9F.user.js
// @downloadURL  https://raw.githubusercontent.com/chengzi-1225/Insta360-chengzi/main/Insta360-%E4%B8%8B%E4%B8%80%E5%BC%A0%E5%88%87%E6%8D%A2%E5%8A%A0%E9%80%9F.user.js
// @match        https://label.insta360.com/*
// @match        *://*.labelstud.io/*
// @run-at       document-start
// @grant        none
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  const INSTANCE = '__INSTA360_NEXT_ITEM_DEDUPE__';
  if (window[INSTANCE]) return;
  window[INSTANCE] = true;

  const TARGET_SELECTOR = '.lsf-outliner-item';
  const CLICK_GUARD_MS = 160;
  let lastClickTarget = null;
  let lastClickAt = -Infinity;

  function targetOf(event) {
    return event.target?.closest?.(TARGET_SELECTOR) || null;
  }

  // 原脚本为模拟一次选择而派发 mousedown、mouseup、click 三个事件。
  // 列表切换由 click 完成，前两个事件只会增加一次重复状态计算。
  document.addEventListener('mousedown', event => {
    if (!event.isTrusted && targetOf(event)) event.stopImmediatePropagation();
  }, true);

  document.addEventListener('mouseup', event => {
    if (!event.isTrusted && targetOf(event)) event.stopImmediatePropagation();
  }, true);

  // 保留同一目标的第一次 click，拦截短时间内重复排队的 click。
  document.addEventListener('click', event => {
    const target = targetOf(event);
    if (!target) return;
    const now = performance.now();
    if (target === lastClickTarget && now - lastClickAt < CLICK_GUARD_MS) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    lastClickTarget = target;
    lastClickAt = now;
  }, true);
})();
