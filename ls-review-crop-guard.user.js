// ==UserScript==
// @name         Insta360 审核裁剪框修改保护（项目通用）
// @namespace    insta360-ls-review-crop-guard
// @version      1.1.0
// @description  防止切换裁剪预览时清空尚未提交的修改历史，保留原生审核提交逻辑。
// @match        https://label.insta360.com/*
// @run-at       document-start
// @grant        none
// @sandbox      raw
// @noframes
// @homepageURL  https://github.com/chengzi-1225/Insta360-chengzi
// @downloadURL  https://raw.githubusercontent.com/chengzi-1225/Insta360-chengzi/main/ls-review-crop-guard.user.js
// @updateURL    https://raw.githubusercontent.com/chengzi-1225/Insta360-chengzi/main/ls-review-crop-guard.user.js
// ==/UserScript==

(() => {
  'use strict';

  const KEY = '__LS_REVIEW_CROP_GUARD__';
  const BADGE_ID = 'ls-review-crop-guard-status';
  window[KEY]?.destroy?.();

  let boundStore = null;
  let dispose = null;
  let dead = false;
  let failed = false;
  let blockedResets = 0;
  let timer = null;
  let badge = null;

  function inScope() {
    return location.hostname === 'label.insta360.com'
      && /^\/review\/workspaces\/\d+\/projects\/\d+(?:\/|$)/.test(location.pathname);
  }

  function showStatus(text, error = false) {
    if (!document.body || dead) return;
    if (!badge?.isConnected) {
      badge = document.createElement('div');
      badge.id = BADGE_ID;
      badge.setAttribute('role', 'status');
      badge.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:2147483647;'
        + 'padding:6px 10px;border-radius:6px;color:#fff;font:12px/1.5 sans-serif;'
        + 'pointer-events:none;box-shadow:0 2px 8px #0002;max-width:330px;';
      document.body.appendChild(badge);
    }
    if (badge.textContent !== text) badge.textContent = text;
    const color = error ? 'rgb(165, 39, 39)' : 'rgb(34, 100, 71)';
    if (badge.style.backgroundColor !== color) badge.style.backgroundColor = color;
  }

  function detach() {
    dispose?.();
    dispose = null;
    boundStore = null;
    failed = false;
  }

  function middleware(call, next, abort) {
    // 只拦截已定位到的异步图片初始化路径；正常保存、重置和其他操作继续执行。
    if (dead || failed || !inScope() || window.Htx !== boundStore
      || call.type !== 'action' || call.name !== 'reinitHistory'
      || call.args?.[0] !== false) return next(call);

    let protect = false;
    try {
      const annotation = call.context;
      const selected = boundStore.annotationStore?.selected;
      const history = annotation?.history;
      const compatible = typeof history?.canUndo === 'boolean'
        && typeof annotation?.serializeAnnotation === 'function';
      protect = annotation === selected && compatible
        && (history.canUndo || history.canRedo || !!annotation.versions?.draft);
      if (protect && typeof abort !== 'function') throw new Error('Middleware abort unavailable');
    } catch (error) {
      failed = true;
      showStatus('审核修改保护：未启用，平台版本不兼容', true);
      console.warn('[审核修改保护] 保护已停止，请停用脚本并反馈。', error);
      return next(call);
    }

    if (!protect) return next(call);

    // MST 的正确中止方式。直接 return 会破坏 action 的中间件调用约定。
    // 中止整个 reinitHistory，既保留撤销记录，也保留待执行的自动保存。
    blockedResets += 1;
    showStatus(`审核修改保护：已启用 · 已保护 ${blockedResets} 次`);
    return abort(undefined);
  }

  function sync() {
    if (dead) return;
    if (!inScope()) {
      detach();
      badge?.remove();
      badge = null;
      return;
    }

    const store = window.Htx;
    if (store !== boundStore) detach();
    if (!store) {
      showStatus('审核修改保护：等待审核页加载');
      return;
    }

    if (!dispose) {
      try {
        const node = store.$treenode;
        if (typeof node?.addMiddleWare !== 'function') throw new Error('MST middleware unavailable');
        boundStore = store;
        dispose = node.addMiddleWare(middleware, false);
      } catch {
        boundStore = null;
        showStatus('审核修改保护：未启用，无法连接标注组件', true);
        return;
      }
    }

    if (failed) return;
    const selected = store.annotationStore?.selected;
    if (!selected) {
      showStatus('审核修改保护：等待打开标注任务');
    } else if (typeof selected.history?.canUndo !== 'boolean'
      || typeof selected.serializeAnnotation !== 'function') {
      showStatus('审核修改保护：未启用，平台版本不兼容', true);
    } else {
      showStatus('审核修改保护：已启用'
        + (blockedResets ? ` · 已保护 ${blockedResets} 次` : ''));
    }
  }

  const api = {
    version: '1.1.0',
    destroy() {
      dead = true;
      if (timer !== null) clearInterval(timer);
      window.removeEventListener('popstate', sync);
      detach();
      badge?.remove();
      badge = null;
      if (window[KEY] === api) delete window[KEY];
    },
  };
  window[KEY] = api;
  window.addEventListener('popstate', sync);
  // 页面会在切换任务时更换编辑器，因此持续检查实例，而非只保护第一个任务。
  timer = setInterval(sync, 300);
  sync();
})();
