// ==UserScript==
// @name         自适应面板移植器
// @namespace    http://tampermonkey.net/
// @version      3.1.1
// @updateURL    https://raw.githubusercontent.com/chengzi-1225/Insta360-chengzi/refs/heads/main/insta360-AdaptivePanelMigrator.user.js
// @downloadURL  https://raw.githubusercontent.com/chengzi-1225/Insta360-chengzi/refs/heads/main/insta360-AdaptivePanelMigrator.user.js
// @description  将标签、问答和复合规则面板移入 Relations，短选项并排、长文字换行，支持动态分支和恢复原位
// @author       chengzi
// @match        https://label.insta360.com/*
// @run-at       document-idle
// @noframes
// @grant        none
// ==/UserScript==

(function () {
  'use strict';
  if (location.hostname !== 'label.insta360.com' || window.top !== window.self) return;
  window.__instaPanelMover?.destroy();

  const CONFIG = {
    relationsSelector: '.lsf-relations__section-content',
    relationsFallbackSelector: '.lsf-relations__section-tab',
    sourceSelector: '.lsf-main-view__annotation',
    anchorSelector: '.lsf-choices, .lsf-labels, .ant-checkbox-group, .ant-radio-group, input[type="checkbox"], input[type="radio"]',
    maxDepth: 10,
    debounceMs: 100,
    debug: false,
  };
  // 使用类名边界，避免 lsf-labels-list 等无关名称被当成标签控件。
  const PROTECTED = [
    'canvas', 'video', 'audio', 'iframe', 'object', 'embed',
    '.lsf-reframe', '.timeline-stage', '.konvajs-content', '.lsf-video',
    '.lsf-timeline', '.lsf-object', '.lsf-video-segmentation', '.lsf-seeker',
    '.lsf-minimap', '.lsf-timeline-controls', '.lsf-image',
  ].join(',');
  const BOUNDARY = '.lsf-editor, .lsf-main-view, .lsf-main-content, .lsf-sidepanels, .lsf-tabs__contents';
  const HEADINGS = 'h3, h4, h5, legend, [role="heading"]';
  const QUESTION_INPUTS = 'input[type="checkbox"], input[type="radio"]';
  const records = new Map();
  const guards = new Map();
  const mounts = new Map();
  const nativeInsert = Node.prototype.insertBefore;
  const nativeRemove = Node.prototype.removeChild;
  let observer, timer = null, enabled = true, destroyed = false, busy = false;
  let scans = 0, moves = 0, lastError = '', styleElement = null, mountId = 0;

  function log(...args) {
    if (CONFIG.debug) console.log('[自适应移植 v3]', ...args);
  }

  function isExcludedElement(el) {
    if (!(el instanceof Element)) return true;
    if (el.matches('html, body, #root, #app, #main, #container')) return true;
    return !!(el.closest(PROTECTED) || el.querySelector(PROTECTED));
  }

  function hasCardSurface(el) {
    const s = getComputedStyle(el);
    const padding = Math.max(...[s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft].map(x => parseFloat(x) || 0));
    const border = ['Top', 'Right', 'Bottom', 'Left'].some(side => (parseFloat(s[`border${side}Width`]) || 0) > 0 && !['none', 'hidden'].includes(s[`border${side}Style`]));
    const background = s.backgroundColor && !['transparent', 'rgba(0, 0, 0, 0)'].includes(s.backgroundColor);
    return padding >= 4 && (border || background || (s.boxShadow && s.boxShadow !== 'none'));
  }

  function hiddenAtSource(anchor, source) {
    for (let el = anchor; el; el = el.parentElement) {
      const style = getComputedStyle(el);
      if (el.hidden || el.hasAttribute('inert') || el.getAttribute('aria-hidden') === 'true' || style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility)) return true;
      if (el === source) break;
    }
    return false;
  }

  function findCompositePanels(source, anchors) {
    // 从真实控件向上找，避免逐个测量工作区内的所有 div。
    const candidates = new Set(), surfaces = new WeakMap();
    const surface = el => {
      if (!surfaces.has(el)) surfaces.set(el, hasCardSurface(el));
      return surfaces.get(el);
    };
    for (const anchor of anchors) {
      for (let el = anchor, depth = 0; el && el !== source && depth < CONFIG.maxDepth; el = el.parentElement, depth++) {
        if (el.matches(BOUNDARY) || isExcludedElement(el)) break;
        if (surface(el)) candidates.add(el);
      }
    }
    const panels = Array.from(candidates).filter(el => {
      if (el.querySelectorAll(QUESTION_INPUTS).length < 2) return false;
      // 只统计这张卡片自己的标题；另一张有底色/边框的独立子卡片不算。
      // 因此能识别蓝色多题面板，也不会把包住多张卡片的工作区一起搬走。
      const ownHeadings = Array.from(el.querySelectorAll(HEADINGS)).filter(heading => {
        for (let p = heading.parentElement; p && p !== el; p = p.parentElement) if (surface(p)) return false;
        return true;
      });
      return ownHeadings.length >= 2;
    });
    return panels.filter(el => !panels.some(parent => parent !== el && parent.contains(el)));
  }

  function findCard(anchor, source) {
    if (isExcludedElement(anchor)) return null;
    let fallback = null;
    for (let el = anchor, depth = 0; el && el !== source && depth < CONFIG.maxDepth; el = el.parentElement, depth++) {
      // 一旦遇到画布/媒体边界，不再向上找到包含整个工作区的容器。
      if (isExcludedElement(el)) break;
      if (el.matches(BOUNDARY)) break;
      if (!hasCardSurface(el)) continue;
      // 保留完整的标题、所有标签和第三方脚本附加按钮。
      const headings = el.querySelectorAll(HEADINGS);
      if (headings.length === 1) return el;
      if (headings.length > 1) break;
      fallback ||= el;
    }
    return fallback;
  }

  function editorFor(el) { return el.closest('.lsf-editor'); }
  function targetFor(editor) {
    // 空 Relations 在新版原生界面中没有 section-content，使用其专属页签容器。
    for (const selector of [CONFIG.relationsSelector, CONFIG.relationsFallbackSelector]) {
      const target = Array.from(editor.querySelectorAll(selector)).find(el => editorFor(el) === editor);
      if (target) return target;
    }
    return null;
  }

  function findAllPanels() {
    const result = [];
    for (const source of document.querySelectorAll(CONFIG.sourceSelector)) {
      const editor = editorFor(source);
      if (!editor) continue;
      const anchors = Array.from(source.querySelectorAll(CONFIG.anchorSelector)).filter(anchor =>
        editorFor(anchor) === editor && !anchor.closest('[data-ipm-panel], [data-moved="true"]') && !hiddenAtSource(anchor, source));
      const compositePanels = findCompositePanels(source, anchors);
      result.push(...compositePanels);
      for (const anchor of anchors) {
        if (compositePanels.some(panel => panel.contains(anchor))) continue;
        const panel = findCard(anchor, source);
        if (!panel || panel.closest('[data-moved="true"]') || records.has(panel)) continue;
        if (result.some(el => el === panel || el.contains(panel))) continue;
        // 候选外层卡片晚出现时，移除已收集的内层，避免双向嵌套重复。
        for (let i = result.length - 1; i >= 0; i--) if (panel.contains(result[i])) result.splice(i, 1);
        result.push(panel);
      }
    }
    return result;
  }

  function addOwnedClass(el, name, owned) {
    if (el && !el.classList.contains(name)) { el.classList.add(name); owned.push([el, name]); }
  }

  function ensureStyle() {
    if (styleElement?.isConnected) return;
    styleElement = document.createElement('style');
    styleElement.id = 'ipm-style';
    styleElement.textContent = `
      .ipm-scroll { overflow-y:auto !important; min-height:0; }
      .ipm-target { display:block !important; min-width:0; box-sizing:border-box; }
      .ipm-host { display:flex; flex-direction:column; gap:4px; min-width:0; padding:4px; box-sizing:border-box; }
      .ipm-toolbar { display:flex; flex-wrap:wrap; align-items:center; gap:4px; font:12px/1.5 system-ui,-apple-system,"PingFang SC",sans-serif; }
      .ipm-count { flex:1 1 80px; color:#637083; }
      .ipm-button { padding:2px 6px; border:1px solid #ced6e0; border-radius:5px; color:#324258; background:#fff; cursor:pointer; font:inherit; }
      .ipm-button:hover { background:#edf5ff; border-color:#8cb7ef; }
      .ipm-button:focus-visible { outline:2px solid #4081d6; outline-offset:2px; }
      .ipm-button:disabled { opacity:.45; cursor:default; }
      .ipm-list { display:flex; flex-direction:column; gap:4px; min-width:0; }
      .ipm-panel { flex:0 0 auto !important; width:100% !important; max-width:100% !important; min-width:0 !important; min-height:0 !important; height:auto !important; box-sizing:border-box !important; margin:0 !important; padding:6px 8px !important; }
      .ipm-panel :is(h3,h4,h5,legend,[role="heading"]) { margin:4px 0 3px !important; font-size:13px !important; line-height:1.45 !important; overflow-wrap:anywhere; }
      .ipm-panel > :is(h3,h4,h5,legend,[role="heading"]):first-child { margin-top:0 !important; }
      .ipm-panel :is(div,section,fieldset,p) { min-width:0 !important; min-height:0 !important; max-width:100%; margin-block:0 !important; box-sizing:border-box; }
      .ipm-panel :is(.lsf-choices,.lsf-choices__list,.ant-checkbox-group,.ant-radio-group) { display:flex !important; flex-direction:row !important; flex-wrap:wrap !important; align-items:flex-start; align-content:flex-start; justify-content:flex-start !important; flex:1 1 100% !important; width:100% !important; min-width:0 !important; gap:2px 10px !important; }
      .ipm-panel :is([style*="display: flex"],[style*="display:flex"]) { flex-wrap:wrap !important; }
      .ipm-panel :is([style*="display: grid"],[style*="display:grid"]) { grid-template-columns:minmax(0,1fr) !important; }
      .ipm-panel :is(label,.lsf-choice) { display:inline-flex !important; align-items:center; flex:0 1 auto !important; width:auto !important; min-width:0; max-width:100%; min-height:24px; margin:0 !important; line-height:1.45 !important; vertical-align:top; white-space:normal !important; overflow-wrap:anywhere; }
      .ipm-panel :is(label,.lsf-choice) > :not(input):not(.ant-checkbox):not(.ant-radio):not(.lsf-hint) { min-width:0; white-space:normal !important; }
      .ipm-panel :is(input[type="checkbox"],input[type="radio"],.ant-checkbox,.ant-radio) { flex-shrink:0; }
      .ipm-panel .lsf-labels { flex-wrap:wrap !important; }
      .ipm-panel .lsf-label { margin:2px !important; }
      .ipm-panel .lsf-label__text { white-space:normal; overflow-wrap:anywhere; }
      .ipm-panel hr { margin:5px 0 !important; }
    `;
    (document.head || document.documentElement).appendChild(styleElement);
  }

  function ensureMount(target) {
    let mount = mounts.get(target);
    if (mount?.host.parentNode === target) return mount;
    if (mount) removeMount(mount);
    ensureStyle();
    const host = document.createElement('div'); host.className = 'ipm-host';
    const toolbar = document.createElement('div'); toolbar.className = 'ipm-toolbar';
    toolbar.id = mountId++ ? `ipm-toolbar-${mountId}` : 'ipm-toolbar';
    toolbar.setAttribute('role', 'toolbar'); toolbar.setAttribute('aria-label', '面板移植工具');
    const count = document.createElement('span'); count.className = 'ipm-count';
    const restore = document.createElement('button'); restore.type = 'button'; restore.className = 'ipm-button';
    restore.textContent = '恢复原位'; restore.title = '将所有移植面板放回原位，并暂停自动移植';
    restore.addEventListener('click', () => restoreAll());
    const resume = document.createElement('button'); resume.type = 'button'; resume.className = 'ipm-button';
    resume.textContent = '移入侧栏'; resume.title = '重新启用自动移植';
    resume.addEventListener('click', () => moveAllPanels());
    toolbar.append(count, restore, resume);
    const list = document.createElement('div'); list.className = 'ipm-list';
    host.append(toolbar, list); target.insertBefore(host, target.firstChild);
    const owned = [];
    addOwnedClass(target, 'ipm-target', owned);
    addOwnedClass(target.closest('.lsf-tabs__contents'), 'ipm-scroll', owned);
    mount = { target, host, toolbar, count, restore, resume, list, owned };
    mounts.set(target, mount);
    return mount;
  }

  function removeMount(mount) {
    mount.host.remove();
    for (const [el, name] of mount.owned) el.classList.remove(name);
    mounts.delete(mount.target);
  }

  function releaseGuard(parent) {
    const guard = guards.get(parent);
    if (!guard || Array.from(records.values()).some(r => r.parent === parent)) return;
    for (const name of ['removeChild', 'insertBefore']) {
      // 其他脚本若随后替换了方法，不覆盖它。
      if (parent[name] !== guard.wrappers[name]) continue;
      const descriptor = guard.descriptors[name];
      if (descriptor) Object.defineProperty(parent, name, descriptor);
      else delete parent[name];
    }
    guards.delete(parent);
  }

  function clearRecord(record, returnToSource, keepCurrentPosition = false) {
    const { panel, marker, parent, originalAttribute, originalClass } = record;
    if (!keepCurrentPosition) {
      if (returnToSource && marker.parentNode === parent) nativeInsert.call(parent, panel, marker);
      else if (!returnToSource && panel.parentNode) nativeRemove.call(panel.parentNode, panel);
    }
    marker.remove();
    if (!originalClass) panel.classList.remove('ipm-panel');
    if (originalAttribute === null) panel.removeAttribute('data-ipm-panel');
    else panel.setAttribute('data-ipm-panel', originalAttribute);
    records.delete(panel);
    releaseGuard(parent);
  }

  function guardParent(parent) {
    if (guards.has(parent)) return true;
    const descriptors = {}, bases = {}, wrappers = {};
    for (const name of ['removeChild', 'insertBefore']) {
      descriptors[name] = Object.getOwnPropertyDescriptor(parent, name);
      if (descriptors[name] && !descriptors[name].configurable) return false;
      bases[name] = parent[name];
    }
    // 只适配本脚本移走的直接子节点，不修改 Node/Element 原型或 React 私有状态。
    wrappers.removeChild = function (child) {
      const r = records.get(child);
      if (this === parent && r?.parent === parent && child.parentNode !== parent) clearRecord(r, true);
      return bases.removeChild.call(this, child);
    };
    wrappers.insertBefore = function (child, reference) {
      const r = records.get(reference);
      if (this === parent && r?.parent === parent && reference.parentNode !== parent) clearRecord(r, true);
      return bases.insertBefore.call(this, child, reference);
    };
    const installed = [];
    try {
      for (const name of ['removeChild', 'insertBefore']) {
        Object.defineProperty(parent, name, { value: wrappers[name], configurable: true, writable: true });
        installed.push(name);
      }
    } catch (error) {
      for (const name of installed) {
        if (descriptors[name]) Object.defineProperty(parent, name, descriptors[name]); else delete parent[name];
      }
      log('无法适配源容器，保留原位', error);
      return false;
    }
    guards.set(parent, { descriptors, wrappers });
    return true;
  }

  function updateMounts() {
    for (const mount of mounts.values()) {
      const count = Array.from(records.values()).filter(r => r.mount === mount).length;
      mount.count.textContent = enabled ? `已移入 ${count} 个面板` : '已恢复原位';
      mount.restore.disabled = !records.size;
      mount.resume.disabled = enabled;
    }
  }

  function observe() {
    if (!destroyed && observer && document.body) observer.observe(document.body, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ['hidden', 'inert', 'aria-hidden', 'style', 'class'],
    });
  }

  function mutate(fn) {
    observer?.disconnect();
    try { return fn(); } finally { observe(); }
  }

  function reconcile() {
    if (destroyed || busy || !enabled) return;
    busy = true;
    try {
      mutate(() => {
        scans++;
        for (const record of Array.from(records.values())) {
          if (record.panel.isConnected && !record.mount.host.contains(record.panel) && record.panel.closest(CONFIG.sourceSelector)) {
            // 框架已把卡片移回源区重排：保留新位置，重新建立位置标记。
            clearRecord(record, false, true);
          } else if (!record.parent.isConnected || !record.marker.isConnected) {
            clearRecord(record, false);
          } else if (!record.mount.target.isConnected || record.mount.host.parentNode !== record.mount.target) {
            clearRecord(record, true);
          } else if (!record.panel.isConnected) {
            clearRecord(record, false);
          } else if (!record.mount.host.contains(record.panel)) {
            clearRecord(record, true);
          }
        }
        for (const mount of Array.from(mounts.values())) {
          if (!mount.target.isConnected || mount.host.parentNode !== mount.target) removeMount(mount);
        }
        for (const panel of findAllPanels()) {
          const editor = editorFor(panel), target = targetFor(editor);
          if (!target || target.contains(panel) || panel.contains(target) || target.closest(PROTECTED)) continue;
          const parent = panel.parentNode;
          if (!guardParent(parent)) continue;
          const mount = ensureMount(target), marker = document.createComment('ipm:original-position');
          nativeInsert.call(parent, marker, panel);
          const record = { panel, parent, marker, mount, originalClass: panel.classList.contains('ipm-panel'), originalAttribute: panel.getAttribute('data-ipm-panel') };
          records.set(panel, record);
          panel.classList.add('ipm-panel'); panel.setAttribute('data-ipm-panel', 'true');
          mount.list.appendChild(panel); moves++;
          log('移入面板', panel.querySelector('h3,h4,h5,legend')?.textContent?.trim());
        }
        for (const mount of mounts.values()) {
          const ordered = Array.from(records.values()).filter(r => r.mount === mount).sort((a, b) => {
            const pos = a.marker.compareDocumentPosition(b.marker);
            return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : pos & Node.DOCUMENT_POSITION_PRECEDING ? 1 : 0;
          });
          let reference = mount.list.firstChild;
          for (const { panel } of ordered) {
            if (panel !== reference) mount.list.insertBefore(panel, reference);
            reference = panel.nextSibling;
          }
        }
        updateMounts();
      });
      lastError = '';
    } catch (error) {
      lastError = String(error?.message || error);
      console.error('[自适应移植] 本次更新失败；可用“恢复原位”还原。', error);
    } finally { busy = false; }
  }

  function schedule() {
    if (!enabled || destroyed || timer !== null) return;
    timer = setTimeout(() => { timer = null; reconcile(); }, CONFIG.debounceMs);
  }

  function cancelScheduled() { if (timer !== null) { clearTimeout(timer); timer = null; } }

  function moveAllPanels() {
    if (destroyed) return;
    enabled = true; cancelScheduled(); reconcile();
  }

  function restoreAll() {
    if (destroyed) return;
    enabled = false; cancelScheduled();
    mutate(() => {
      for (const record of Array.from(records.values())) clearRecord(record, record.parent.isConnected && record.marker.parentNode === record.parent);
      updateMounts();
    });
  }

  function relevant(mutation) {
    if (mutation.type === 'attributes') {
      const el = mutation.target;
      return el instanceof Element && !!el.closest(CONFIG.sourceSelector) && !el.closest('[data-ipm-panel]') &&
        (el.matches(CONFIG.anchorSelector) || !!el.querySelector(CONFIG.anchorSelector));
    }
    const nodes = [...mutation.addedNodes, ...mutation.removedNodes];
    const selector = `${CONFIG.sourceSelector}, ${CONFIG.relationsSelector}, ${CONFIG.relationsFallbackSelector}, ${CONFIG.anchorSelector}, .ipm-host`;
    for (const node of nodes) {
      if (node instanceof Element && (node.matches(selector) || node.querySelector(selector))) return true;
      for (const r of records.values()) {
        if (node === r.marker || node === r.panel || node === r.parent || (node instanceof Element && (node.contains(r.parent) || node.contains(r.marker)))) return true;
      }
    }
    return false;
  }

  function onRouteChange() {
    // popstate/hashchange 之后异步扫描；MutationObserver 负责框架异步挂载。
    schedule();
  }

  function destroy() {
    if (destroyed) return;
    restoreAll(); destroyed = true; cancelScheduled(); observer?.disconnect();
    for (const mount of Array.from(mounts.values())) removeMount(mount);
    for (const parent of guards.keys()) releaseGuard(parent);
    styleElement?.remove();
    window.removeEventListener('popstate', onRouteChange);
    window.removeEventListener('hashchange', onRouteChange);
    document.removeEventListener('DOMContentLoaded', schedule);
    if (window.__debugPanelMover === api) delete window.__debugPanelMover;
    if (window.__instaPanelMover === api) delete window.__instaPanelMover;
  }

  const api = {
    version: '3.1.1', config: CONFIG, scan: findAllPanels, move: moveAllPanels,
    restore: restoreAll, destroy, isExcluded: isExcludedElement,
    status: () => ({ version: '3.1.1', enabled, moved: records.size, scans, moves, pending: timer !== null, lastError }),
  };
  window.__instaPanelMover = api;
  window.__debugPanelMover = api;
  observer = new MutationObserver(mutations => { if (mutations.some(relevant)) schedule(); });
  observe();
  window.addEventListener('popstate', onRouteChange);
  window.addEventListener('hashchange', onRouteChange);
  if (document.body) schedule(); else document.addEventListener('DOMContentLoaded', schedule, { once: true });
})();
