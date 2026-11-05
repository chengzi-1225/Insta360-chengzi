// ==UserScript==
// @name         insta360-IDswitching
// @namespace    local.ls.toolkit
// @version      3.18.0
// @description  精简分组工具栏、预设全选与拖动框选；保留原生删框撤回、选中显隐、标签同步及自定义快捷键。
// @updateURL    https://raw.githubusercontent.com/chengzi-1225/Insta360-chengzi/refs/heads/main/insta360-IDswitching.user.js
// @downloadURL  https://raw.githubusercontent.com/chengzi-1225/Insta360-chengzi/refs/heads/main/insta360-IDswitching.user.js
// @match        *://label.insta360.com/*
// @match        *://*.labelstud.io/*
// @run-at       document-idle
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  let __toastEl = null, __toastTimer = null;
  function showToast(text, duration) {
    try {
      if (!__toastEl || !__toastEl.isConnected) {
        __toastEl = document.createElement('div');
        __toastEl.style.cssText = `
          position: fixed; left: 50%; top: 24px; transform: translateX(-50%);
          z-index: 100010; padding: 8px 16px; border-radius: 6px;
          background: rgba(0,0,0,.82); color: #fff; font-size: 13px;
          font-family: system-ui,-apple-system,"Segoe UI","PingFang SC",sans-serif;
          pointer-events: none; opacity: 0; transition: opacity .15s;
          max-width: 80vw; white-space: nowrap;
        `;
        (document.body || document.documentElement).appendChild(__toastEl);
      }
      __toastEl.textContent = text;
      __toastEl.style.opacity = '1';
      if (__toastTimer) clearTimeout(__toastTimer);
      __toastTimer = setTimeout(() => { if (__toastEl) __toastEl.style.opacity = '0'; }, duration || 1800);
    } catch (e) {}
  }

  function getReactFiber(node) {
    if (!node) return null;
    try {
      for (const k of Object.keys(node)) {
        if (k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')) return node[k];
      }
    } catch (e) {}
    return null;
  }

  // BEGIN SHARED EDITOR HISTORY
  // Shared inline runtime; both userscripts remain independently installable.
  function installEditingSupport() {
    if (window.__LS_EDIT_HISTORY) return window.__LS_EDIT_HISTORY;
    let boundHistory = null, disposeHistory = null, controls = null;
    const visibilityLock = '__ls_selected_visibility_history_lock';
    function annotation() {
      for (const key of ['Htx', '__lsf', 'LS', 'labelStudio', '__store', 'lsf']) {
        try {
          const store = window[key], as = store && store.annotationStore;
          if (as && (as.selected || as.current)) return as.selected || as.current;
        } catch (e) {}
      }
      for (const node of document.querySelectorAll('.lsf-outliner, .lsf-outliner-item')) {
        if (node.closest('.lsf-panel-tabs__ghost-tab')) continue;
        let fiber = getReactFiber(node);
        for (let depth = 0; fiber && depth < 40; depth++, fiber = fiber.return) {
          const props = fiber.memoizedProps;
          const ann = props && (props.item && props.item.annotation || props.regions && props.regions.annotation);
          if (ann && (ann.regionStore || ann.areas)) return ann;
        }
      }
      return null;
    }
    function regions(ann = annotation()) {
      const source = ann && (ann.regionStore && ann.regionStore.regions || ann.areas);
      if (!source) return [];
      return typeof source.values === 'function' ? Array.from(source.values()) :
        typeof source[Symbol.iterator] === 'function' ? Array.from(source) : [];
    }
    function drawing(ann = annotation()) {
      return !!ann && (ann.isDrawing === true || regions(ann).some(region =>
        region && !region.classification && (region.isDrawing === true || region.incomplete === true)));
    }
    function selectedRegions(ann, all) {
      try {
        const store = ann && ann.regionStore, selected = store && store.selectedRegions;
        if (selected && typeof selected[Symbol.iterator] === 'function') {
          const matches = Array.from(selected).filter(r => all.includes(r));
          if (matches.length) return matches;
        }
        const selection = store && store.selection;
        if (selection && typeof selection.has === 'function') {
          const matches = all.filter(r => selection.has(r.id));
          if (matches.length) return matches;
        }
        if (ann && all.includes(ann.highlightedNode)) return [ann.highlightedNode];
      } catch (e) {}
      return [];
    }
    function withoutRecording(ann, run) {
      const history = ann && ann.history;
      // safeUnfreeze releases only our lock and deliberately does not record a new snapshot.
      if (!history || typeof history.freeze !== 'function' || typeof history.safeUnfreeze !== 'function') return run();
      let locked = false;
      try { history.freeze(visibilityLock); locked = true; } catch (e) {}
      try { return run(); }
      finally { if (locked) history.safeUnfreeze(visibilityLock); }
    }
    function historyRestored() {
      if (window.__ANGLE_INHERIT && window.__ANGLE_INHERIT.pauseForHistory) window.__ANGLE_INHERIT.pauseForHistory();
      document.dispatchEvent(new CustomEvent('ls-toolkit-history-restored'));
      setTimeout(() => { if (window.__SELECTED_VISIBILITY) window.__SELECTED_VISIBILITY.refresh(); refresh(); }, 0);
    }
    function can(history, direction) {
      if (!history || typeof history[direction] !== 'function') return false;
      const value = history[direction === 'undo' ? 'canUndo' : 'canRedo'];
      return typeof value === 'function' ? !!value.call(history) : value === true;
    }
    function refresh() {
      const ann = annotation(), history = ann && ann.history;
      if (history !== boundHistory) {
        if (typeof disposeHistory === 'function') disposeHistory();
        boundHistory = history; disposeHistory = null;
        if (history && typeof history.onUpdate === 'function') disposeHistory = history.onUpdate(historyRestored);
      }
      if (!controls) return;
      const busy = drawing(ann) || !!(window.__CLEAR_TAGS && window.__CLEAR_TAGS.isRunning());
      for (const direction of ['undo', 'redo']) {
        const button = controls.querySelector(`[data-history-action="${direction}"]`);
        const disabled = busy || !can(history, direction);
        if (button.disabled !== disabled) button.disabled = disabled;
      }
    }
    function run(direction) {
      const ann = annotation(), history = ann && ann.history;
      if (drawing(ann) || window.__CLEAR_TAGS && window.__CLEAR_TAGS.isRunning() || !can(history, direction)) return false;
      historyRestored();
      history[direction]();
      refresh();
      return true;
    }
    function mount(parent) {
      parent = document.getElementById('__id_switch_action_row') || parent;
      if (!parent) return;
      if (!controls) {
        controls = document.createElement('span'); controls.id = '__ls_edit_history_controls';
        controls.setAttribute('role', 'group'); controls.setAttribute('aria-label', '原生编辑历史');
        controls.style.cssText = 'display:inline-flex;gap:5px;flex-wrap:wrap;max-width:100%';
        for (const [direction, label, title] of [['undo', '撤回编辑', '撤回真实编辑（Ctrl / ⌘ Z）'], ['redo', '重做编辑', '重做真实编辑（Ctrl / ⌘ Shift Z）']]) {
          const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
          button.setAttribute('aria-label', label); button.dataset.historyAction = direction; button.title = title;
          button.style.cssText = 'height:24px;padding:0 8px;border:1px solid #d5deea;border-radius:4px;background:#fff;color:#526780;font:inherit;cursor:pointer;white-space:nowrap';
          button.addEventListener('mousedown', event => event.preventDefault());
          button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); run(direction); });
          controls.appendChild(button);
        }
        for (const name of ['pointerdown', 'mousedown', 'click', 'dblclick']) controls.addEventListener(name, event => event.stopPropagation());
      }
      const copy = document.getElementById(controls.id);
      if (copy && copy !== controls) copy.replaceWith(controls);
      if (controls.parentElement !== parent) parent.appendChild(controls);
      refresh();
    }
    window.addEventListener('keydown', event => {
      if (event.defaultPrevented || event.isComposing || !(event.ctrlKey || event.metaKey) || event.altKey) return;
      if (event.target && event.target.closest && event.target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),dialog,.ant-modal')) return;
      if (['z', 'y'].includes(event.key.toLowerCase())) historyRestored();
      // The native editor owns Ctrl/⌘ Z, including cancellation of a drawing gesture.
    }, true);
    const api = { annotation, regions, drawing, selectedRegions, withoutRecording, mount, refresh,
      undo: () => run('undo'), redo: () => run('redo') };
    window.__LS_EDIT_HISTORY = api;
    setInterval(refresh, 500);
    refresh();
    return api;
  }
  const editing = installEditingSupport();
  // The native editor owns the history controls; keep its shared history API.
  editing.mount = () => { document.getElementById('__ls_edit_history_controls')?.remove(); };
  // END SHARED EDITOR HISTORY

  // BEGIN SHARED SELECTED VISIBILITY
  /* ============================================================
   *  选中隐藏：默认保留人物-1、人物-2，可从独立工具栏关闭
   *  - 使用原生 region.toggleHidden()，保留 Outliner 中的 ID 条目
   *  - 首次默认开启；保存开关状态；关闭时显示全部框
   *  - 开启时自动处理任务切换、新增框和原生眼睛操作
   *  - 点击或快捷切换条目时显示对应框，人物常显，其余比例框隐藏
   * ============================================================ */
  (function modulePersonVisibility() {
    // 主脚本已内置同一模块；两种安装顺序都只创建一组控件和监听器。
    if (window.__SELECTED_VISIBILITY) return;
    const BUTTON_ID = '__selected_visibility_btn';
    const STORAGE_KEY = 'ls_toolkit_person_only';
    const RATIO_KEY = 'ls_selected_visibility_ratio_v1';
    const RATIOS = ['9:16', '16:9', '1:1', '4:3', '3:4'];
    const TOKENS = /\[\s*(\d+(?:\.\d+)?)\s*[,，]\s*(\d+(?:\.\d+)?)\s*\]|(?:^|[^\dA-Za-z_.+\-−－:：/×,，])(\d+(?:\.\d+)?)\s*[:：/xX×]\s*(\d+(?:\.\d+)?)(?=$|[^\dA-Za-z_.:：/×,，])/g;
    let selectedRatio = 'all';
    let enabled = true, restoreAll = false, timer = null, running = false;
    let result = 'waiting', failed = new WeakSet(), toolbarNode = null;
    let revealedRegion = null, revealedId = null, revealAnnotation = null, pendingReveal = false;
    let canvasSelectionPending = false, recentIds = [];
    let knownRegionIds = null, createdRegionIds = new Set(), nativeSelectionKey = null;
    let canvasGestureIds = null, canvasGestureEnded = false;
    try { enabled = localStorage.getItem(STORAGE_KEY) !== 'false'; } catch (e) {}
    try {
      const saved = localStorage.getItem(RATIO_KEY);
      if (RATIOS.includes(saved)) selectedRatio = saved;
    } catch (e) {}

    function mainNavigation() {
      const api = window.__OUTLINER;
      return api && typeof api.next === 'function' && typeof api.prev === 'function' ? api : null;
    }

    function regionFor(item) {
      let fiber = getReactFiber(item);
      for (let depth = 0; fiber && depth < 40; depth++, fiber = fiber.return) {
        const region = fiber.memoizedProps && fiber.memoizedProps.item;
        if (region && region.annotation) return region;
      }
      return null;
    }

    function navigationItems() {
      const outliner = Array.from(document.querySelectorAll('.lsf-outliner'))
        .find(node => !node.closest('.lsf-panel-tabs__ghost-tab') && node.getClientRects().length);
      if (!outliner) return [];
      return Array.from(outliner.querySelectorAll('.lsf-outliner-item')).filter(item => {
        const region = regionFor(item);
        if (region && (region.classification || region.isDrawing || region.incomplete)) return false;
        const title = item.querySelector('.lsf-outliner-item__title');
        const values = [title && title.textContent];
        const labels = region && region.labels;
        if (typeof labels === 'string') values.push(labels);
        else if (labels && typeof labels[Symbol.iterator] === 'function') values.push(...labels);
        for (const name of ['title', 'aria-label', 'data-label', 'data-name', 'data-ratio']) values.push(item.getAttribute(name));
        if (values.some(value => typeof value === 'string' && value.includes('人物'))) return false;
        return values.some(value => typeof value === 'string' && Array.from(value.matchAll(TOKENS)).some(match => {
          const width = Number(match[1] || match[3]), height = Number(match[2] || match[4]);
          if (!(width > 0 && height > 0)) return false;
          return RATIOS.some(ratio => {
            if (selectedRatio !== 'all' && ratio !== selectedRatio) return false;
            const [w, h] = ratio.split(':').map(Number), left = width * h, right = height * w;
            return Math.abs(left - right) <= Number.EPSILON * Math.max(left, right) * 4;
          });
        }));
      });
    }

    function navigate(direction) {
      if (editing.drawing() || window.__CLEAR_TAGS && window.__CLEAR_TAGS.isRunning()) return;
      const main = mainNavigation();
      if (main) { (direction < 0 ? main.prev : main.next)(); return; }
      const items = navigationItems();
      if (!items.length) { showToast('当前比例没有可切换的 ID', 1400); return; }
      let index = items.findIndex(item => item.classList.contains('lsf-outliner-item_active') ||
        item.closest('.lsf-tree-treenode-selected, .lsf-tree-node-selected'));
      if (index < 0 && revealedRegion) index = items.findIndex(item => regionFor(item) === revealedRegion);
      const next = index < 0 ? direction < 0 ? items.length - 1 : 0 : (index + direction + items.length) % items.length;
      const item = items[next];
      item.scrollIntoView({ block: 'nearest' });
      for (const type of ['mousedown', 'mouseup', 'click']) {
        item.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
      }
    }

    function setRatio(value) {
      value = String(value).replace('：', ':');
      if (value !== 'all' && !RATIOS.includes(value)) return false;
      try { localStorage.setItem(RATIO_KEY, value); }
      catch (e) { showToast('比例设置保存失败', 1500); mountButton(); return false; }
      selectedRatio = value;
      mountButton();
      return true;
    }

    function cycleRatio() {
      setRatio(RATIOS[(RATIOS.indexOf(selectedRatio) + 1) % RATIOS.length]);
    }

    function onNavigationKey(event) {
      if (mainNavigation() || event.defaultPrevented || event.isComposing || event.keyCode === 229 ||
          event.ctrlKey || event.metaKey || event.altKey || event.shiftKey ||
          !toolbarNode || toolbarNode.hidden || !toolbarNode.isConnected) return;
      const target = event.target && event.target.closest ? event.target : null;
      if (target && target.closest('input,textarea,select,button,[role="button"],[role="textbox"],[role="combobox"],[contenteditable]:not([contenteditable="false"]),dialog,.ant-modal,.ant-drawer')) return;
      if (document.querySelector('dialog[open],.ant-modal-wrap:not([style*="display: none"])')) return;
      const key = event.key.toLowerCase();
      if (!['a', 'd', 'tab', 's'].includes(key) || window.__CLEAR_TAGS && window.__CLEAR_TAGS.isRunning()) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (key === 's') { if (!event.repeat) cycleRatio(); }
      else navigate(key === 'a' ? -1 : 1);
    }

    function annotation() {
      for (const key of ['Htx', '__lsf', 'LS', 'labelStudio', '__store', 'lsf']) {
        try {
          const store = window[key];
          const ann = store && store.annotationStore && (store.annotationStore.selected || store.annotationStore.current);
          if (ann) return ann;
        } catch (e) {}
      }
      // 单独安装时也能从原生 Outliner 模型取得 annotation，不依赖 id切换。
      for (const item of document.querySelectorAll('.lsf-outliner, .lsf-outliner-item')) {
        let fiber = getReactFiber(item);
        for (let depth = 0; fiber && depth < 40; depth++, fiber = fiber.return) {
          try {
            const props = fiber.memoizedProps;
            const ann = props && (props.item && props.item.annotation || props.regions && props.regions.annotation);
            if (ann && (ann.regionStore || ann.areas)) return ann;
          } catch (e) {}
        }
      }
      return null;
    }

    function regionsFor(ann) {
      const regions = ann && (ann.regionStore && ann.regionStore.regions || ann.areas);
      if (!regions) return null;
      if (typeof regions.values === 'function') return Array.from(regions.values());
      if (typeof regions[Symbol.iterator] === 'function') return Array.from(regions);
      return null;
    }

    function isPerson(region) {
      const labels = [];
      const add = values => {
        if (typeof values === 'string') labels.push(values);
        else if (values && typeof values[Symbol.iterator] === 'function') {
          for (const value of values) if (typeof value === 'string') labels.push(value);
        }
      };
      add(region.labels);
      add(region.labeling && region.labeling.mainValue);
      if (region.labelings) for (const label of region.labelings) add(label.mainValue);
      if (!labels.length) add(region.labelName);
      return labels.some(label => /^\s*人物\s*[-_－:：]\s*[12]\s*$/.test(label));
    }

    function rememberRegion(region, ann) {
      revealedRegion = region; revealAnnotation = ann;
      revealedId = (region && (region.id ?? region.pid)) ?? null;
      if (revealedId !== null) recentIds = [...recentIds.filter(id => id !== revealedId), revealedId].slice(-50);
    }

    function syncSelection(ann, regions) {
      if (ann !== revealAnnotation) {
        revealedRegion = null; revealedId = null; pendingReveal = false; recentIds = [];
        revealAnnotation = ann;
        knownRegionIds = null; createdRegionIds.clear(); nativeSelectionKey = null;
      }
      const ids = new Set(regions.map(region => region.id ?? region.pid));
      const drawingNow = editing.drawing(ann);
      if (knownRegionIds) for (const region of regions) {
        const id = region.id ?? region.pid;
        if (!knownRegionIds.has(id) && (region.isDrawing || drawingNow ||
            canvasGestureIds && !canvasGestureIds.has(id) || recentIds.includes(id))) createdRegionIds.add(id);
      }
      knownRegionIds = ids;
      for (const id of createdRegionIds) if (!ids.has(id)) createdRegionIds.delete(id);
      if (!pendingReveal) {
        let selected = editing.selectedRegions(ann, regions);
        if (!selected.length && canvasSelectionPending) {
          selected = Array.from(document.querySelectorAll('.lsf-outliner-item')).filter(item =>
            item.classList.contains('lsf-outliner-item_active') || item.closest('.lsf-tree-treenode-selected, .lsf-tree-node-selected'))
            .map(regionFor).filter(region => regions.includes(region));
        }
        const selectionKey = JSON.stringify(selected.map(region => region.id ?? region.pid).sort());
        const newlyCompleted = !drawingNow && regions.filter(region =>
          createdRegionIds.has(region.id ?? region.pid) && !region.classification && !region.isDrawing && !region.incomplete);
        if (newlyCompleted && newlyCompleted.length) {
          // Some native configurations keep the previous selection after creating a region.
          // Keep the completed region until a later explicit selection or canvas click.
          rememberRegion(newlyCompleted[newlyCompleted.length - 1], ann);
          for (const region of newlyCompleted) createdRegionIds.delete(region.id ?? region.pid);
        } else if (selected.length && (selectionKey !== nativeSelectionKey || canvasSelectionPending)) {
          // 原生画布选择包含新建完成的框；列表点击仅是其中一种选择方式。
          const target = selected.find(region => !region.classification && !isPerson(region)) || selected[0];
          if (target && !target.classification) rememberRegion(target, ann);
        }
        nativeSelectionKey = selectionKey;
      }
      canvasSelectionPending = false;
      if (canvasGestureEnded && !drawingNow) {
        canvasGestureIds = null; canvasGestureEnded = false;
      }
      if (revealedRegion && !regions.includes(revealedRegion)) {
        // 原生撤回可能重建模型对象；使用稳定 ID 找回当前框。
        const target = [...recentIds].reverse().map(id => regions.find(region => (region.id ?? region.pid) === id)).find(Boolean);
        rememberRegion(target || null, ann);
      }
    }

    function revealClickedItem(event) {
      const target = event.target && (event.target.nodeType === 1 ? event.target : event.target.parentElement);
      const item = target && target.closest('.lsf-outliner-item');
      if (!item || target.closest('button, .lsf-outliner-item__controls') ||
          window.__CLEAR_TAGS && window.__CLEAR_TAGS.isRunning()) return;
      let fiber = getReactFiber(item), region = null;
      for (let depth = 0; fiber && depth < 40; depth++, fiber = fiber.return) {
        const candidate = fiber.memoizedProps && fiber.memoizedProps.item;
        if (candidate && candidate.annotation) { region = candidate; break; }
      }
      const ann = annotation();
      if (!region || !ann || region.annotation !== ann) return;
      // 按原生模型引用定位，两个同名 4:3 条目也不会互相误开。
      if (ann !== revealAnnotation) recentIds = [];
      rememberRegion(region, ann); pendingReveal = true;
      failed.delete(region);
      sync();
    }

    function mountButton() {
      const outliner = Array.from(document.querySelectorAll('.lsf-outliner'))
        .find(node => !node.closest('.lsf-panel-tabs__ghost-tab'));
      if (!outliner) { if (toolbarNode) toolbarNode.hidden = true; return; }
      if (!toolbarNode) {
        toolbarNode = document.createElement('div'); toolbarNode.id = '__selected_visibility_toolbar';
        toolbarNode.setAttribute('role', 'toolbar'); toolbarNode.setAttribute('aria-label', '选中隐藏工具栏');
        toolbarNode.style.cssText = 'display:flex;align-items:center;flex-wrap:wrap;gap:7px;box-sizing:border-box;max-width:100%;min-width:0;padding:7px 10px;border-bottom:1px solid #e2e8f0;background:#f8fafc;font:12px/1.4 system-ui,-apple-system,"PingFang SC",sans-serif';
        const label = document.createElement('span'); label.textContent = '显示控制'; label.style.color = '#64748b';
        const button = document.createElement('button'); button.id = BUTTON_ID; button.type = 'button';
        button.setAttribute('aria-label', '选中隐藏开关');
        button.style.cssText = 'height:24px;max-width:100%;padding:0 9px;border:1px solid #c9d9ee;border-radius:4px;cursor:pointer;font:inherit;white-space:nowrap';
        button.addEventListener('mousedown', event => event.preventDefault());
        button.addEventListener('click', event => {
          event.preventDefault(); event.stopPropagation(); setEnabled(!enabled);
        });
        for (const type of ['pointerdown', 'mousedown', 'click', 'dblclick']) {
          toolbarNode.addEventListener(type, event => event.stopPropagation());
        }
        toolbarNode.append(label, button);
        for (const [direction, name, text] of [[-1, '上一个 ID', '← 上一 ID'], [1, '下一个 ID', '下一 ID →']]) {
          const nav = document.createElement('button'); nav.type = 'button'; nav.textContent = text;
          nav.setAttribute('aria-label', name); nav.title = direction < 0 ? '上一个 ID（A）' : '下一个 ID（D / Tab）';
          nav.style.cssText = 'height:24px;padding:0 8px;border:1px solid #d5deea;border-radius:4px;background:#fff;color:#526780;font:inherit;cursor:pointer;white-space:nowrap';
          nav.addEventListener('mousedown', event => event.preventDefault());
          nav.addEventListener('click', () => navigate(direction)); toolbarNode.appendChild(nav);
        }
        const scope = document.createElement('div'); scope.id = '__selected_visibility_scope';
        scope.style.cssText = 'display:flex;align-items:center;flex-wrap:wrap;gap:7px;width:100%;min-width:0;color:#64748b';
        const select = document.createElement('select'); select.id = '__selected_visibility_ratio';
        select.setAttribute('aria-label', 'ID切换比例'); select.title = 'A / D / Tab 切换 ID，S 循环五种比例';
        select.style.cssText = 'height:26px;max-width:100%;padding:0 5px;border:1px solid #d5deea;border-radius:4px;background:#fff;color:#526780;font:inherit';
        for (const [value, text] of [['all', '全部五种比例'], ...RATIOS.map(value => [value, value])]) {
          const option = document.createElement('option'); option.value = value; option.textContent = text; select.appendChild(option);
        }
        select.addEventListener('change', () => setRatio(select.value));
        const count = document.createElement('span'); count.id = '__selected_visibility_count';
        scope.append(select, count); toolbarNode.appendChild(scope);
      }
      const clone = document.getElementById(toolbarNode.id);
      if (clone && clone !== toolbarNode) clone.replaceWith(toolbarNode);
      const switchToolbar = document.getElementById('__id_switch_toolbar');
      if (switchToolbar && (switchToolbar.parentElement === outliner || switchToolbar.parentElement.contains(outliner))) {
        if (switchToolbar.nextElementSibling !== toolbarNode) switchToolbar.after(toolbarNode);
      } else if (outliner.firstElementChild !== toolbarNode) outliner.prepend(toolbarNode);
      let inactive = false;
      for (let parent = outliner.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        const header = Array.from(parent.children).find(node => node.classList.contains('lsf-tabs__tabs-row'));
        if (!header) continue;
        const tab = Array.from(header.querySelectorAll('.lsf-panel-tabs__tab')).find(node =>
          !node.closest('.lsf-panel-tabs__ghost-tab') && /^Regions$/i.test(node.textContent.trim()));
        if (tab) { inactive = !tab.classList.contains('lsf-panel-tabs__tab_active'); break; }
      }
      if (toolbarNode.hidden !== inactive) toolbarNode.hidden = inactive;
      const button = toolbarNode.querySelector(`#${BUTTON_ID}`);
      const text = `选中隐藏：${enabled ? '开' : '关'}`;
      const title = enabled ? '人物-1、人物-2始终显示；点击哪个框就显示哪个，并隐藏前一个框。点击关闭后显示全部框。' :
        '已关闭自动隐藏。点击开启后保留人物和当前框。';
      if (button.textContent !== text) button.textContent = text;
      if (button.title !== title) button.title = title;
      if (button.getAttribute('aria-pressed') !== String(enabled)) {
        button.setAttribute('aria-pressed', String(enabled));
        button.style.background = enabled ? '#edf5ff' : '#fff';
        button.style.color = enabled ? '#287bd6' : '#64748b';
      }
      const scope = toolbarNode.querySelector('#__selected_visibility_scope');
      const external = !!mainNavigation();
      if (scope.hidden !== external) scope.hidden = external;
      const select = scope.querySelector('select');
      if (select.value !== selectedRatio) select.value = selectedRatio;
      if (!external) {
        const count = scope.querySelector('span'), text = `${navigationItems().length} 个 ID · A / D / Tab`;
        if (count.textContent !== text) count.textContent = text;
      }
      editing.mount(toolbarNode);
    }

    function sync() {
      if (running) return;
      mountButton();
      if (!enabled && !restoreAll && !pendingReveal) { result = 'off'; return; }
      const ann = annotation(), regions = regionsFor(ann);
      if (!regions) { result = 'waiting-model'; return; }
      syncSelection(ann, regions);
      // 绘制过程由原生编辑器持有，不改变画框时的可见性或选择。
      if (editing.drawing(ann)) { result = 'drawing'; return; }
      running = true;
      let skipped = 0;
      try {
        editing.withoutRecording(ann, () => {
        for (const region of regions) {
          if (!region || region.classification || region.hideable === false ||
              region.isDrawing || region.incomplete === true) continue;
          // 过滤关闭时，只打开本次点击的框，保留其他框的原生眼睛状态。
          if (!enabled && !restoreAll && region !== revealedRegion) continue;
          const hidden = enabled && !isPerson(region) && region !== revealedRegion;
          if (region.hidden === hidden) continue;
          if (failed.has(region) || typeof region.hidden !== 'boolean' || typeof region.toggleHidden !== 'function') {
            skipped++;
            continue;
          }
          // 原生 action 同时刷新画布与眼睛状态，不直接改 DOM 或写受保护模型属性。
          try { region.toggleHidden(); }
          catch (error) {
            failed.add(region); skipped++;
            console.warn('[人物显示] 一个框未能切换显隐：', error);
          }
        }
        });
        restoreAll = false;
        pendingReveal = false;
        result = skipped ? 'partial' : enabled ? revealedRegion && !isPerson(revealedRegion) ? 'person-and-selected' : 'person-only' : 'off';
      } finally { running = false; }
    }

    function schedule() {
      if (timer !== null) return;
      timer = setTimeout(() => { timer = null; sync(); }, 120);
    }

    function setEnabled(value) {
      enabled = !!value;
      restoreAll = !enabled;
      failed = new WeakSet();
      pendingReveal = false;
      try { localStorage.setItem(STORAGE_KEY, String(enabled)); } catch (e) {}
      sync();
      showToast(enabled ? '选中隐藏已开启：保留人物和当前框' : '选中隐藏已关闭：恢复显示全部框', 1800);
      return enabled;
    }

    function start() {
      if (!document.body) return;
      const style = document.createElement('style');
      style.textContent = '#__selected_visibility_toolbar[hidden],#__selected_visibility_scope[hidden]{display:none!important} #__selected_visibility_toolbar button:focus-visible,#__selected_visibility_ratio:focus-visible{outline:2px solid #409eff;outline-offset:2px}';
      (document.head || document.documentElement).appendChild(style);
      new MutationObserver(schedule).observe(document.body, {
        childList: true, subtree: true, characterData: true,
        attributes: true, attributeFilter: ['class', 'aria-label'],
      });
      document.addEventListener('click', event => { revealClickedItem(event); schedule(); }, true);
      document.addEventListener('pointerdown', event => {
        const target = event.target && event.target.closest ? event.target : null;
        if (target && target.closest('canvas,.konvajs-content,.lsf-image,.lsf-canvas,#canvas')) {
          canvasGestureIds = new Set((regionsFor(annotation()) || []).map(region => region.id ?? region.pid));
          canvasGestureEnded = false;
        }
      }, true);
      const onCanvasSelection = event => {
        if (canvasGestureIds && event.type === 'pointerup') canvasGestureEnded = true;
        const target = event.target && event.target.closest ? event.target : null;
        if (target && target.closest('canvas,.konvajs-content,.lsf-image,.lsf-canvas,#canvas')) {
          canvasSelectionPending = true; schedule();
        }
      };
      document.addEventListener('pointerup', onCanvasSelection, true);
      document.addEventListener('click', onCanvasSelection, true);
      document.addEventListener('ls-toolkit-history-restored', () => { pendingReveal = false; schedule(); });
      document.addEventListener('visibilitychange', schedule);
      window.addEventListener('keydown', onNavigationKey, true);
      // 新框或新任务可能仅改变模型，不产生 Outliner DOM 变动。
      setInterval(sync, 700);
      sync();
    }

    window.__SELECTED_VISIBILITY = {
      version: '1.2.1', setEnabled,
      refresh: sync,
      next: () => navigate(1), prev: () => navigate(-1), setRatio,
      state() { return { enabled, result, ratio: selectedRatio }; },
    };
    // 保留旧调试名称，方便已有页面工具读取状态；不依赖该工具集。
    window.__PERSON_VISIBILITY = window.__SELECTED_VISIBILITY;
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
    console.log('[选中隐藏] v1.2.1 已加载：跟随新框与画布选择，原生撤回重做');
  })();
  // END SHARED SELECTED VISIBILITY

  // 标题栏放比例选择和快捷键入口，其他操作放下方，避开原生排序栏。
  let outlinerHeaderControls = null;
  function ensureOutlinerToolbar() {
    const outliner = Array.from(document.querySelectorAll('.lsf-outliner'))
      .find(node => !node.closest('.lsf-panel-tabs__ghost-tab'));
    if (!outliner) {
      for (const id of ['__id_switch_toolbar', '__id_switch_header_controls']) {
        const previous = document.getElementById(id);
        if (previous && !previous.hidden) previous.hidden = true;
      }
      return null;
    }
    if (!document.getElementById('__id_switch_toolbar_style')) {
      const style = document.createElement('style');
      style.id = '__id_switch_toolbar_style';
      style.textContent = `
        #__id_switch_toolbar{display:flex!important;flex-direction:column!important;gap:8px!important;
          box-sizing:border-box!important;width:100%!important;min-width:0!important;max-width:100%!important;
          height:auto!important;flex:0 0 auto!important;align-self:stretch!important;padding:8px 10px!important;
          margin:0!important;border-bottom:1px solid #e2e8f0;background:#f8fafc;overflow:visible!important;
          font:12px/1.4 system-ui,-apple-system,"PingFang SC",sans-serif;white-space:normal!important}
        #__id_switch_toolbar[hidden],#__id_switch_header_controls[hidden]{display:none!important}
        [data-id-switch-header]{display:flex!important;flex-wrap:wrap!important;align-items:center!important;
          gap:6px!important;box-sizing:border-box!important;width:100%!important;min-width:0!important;
          max-width:100%!important;height:auto!important;min-height:30px!important;max-height:none!important;
          flex-shrink:0!important;overflow:visible!important;white-space:normal!important}
        [data-id-switch-header]>.lsf-tabs__tab-container{flex:0 1 auto!important;min-width:0!important;width:auto!important;max-width:100%!important}
        [data-id-switch-header]>.lsf-tabs__drop-space-after{flex:1 1 0!important;min-width:0!important;width:auto!important}
        #__id_switch_header_controls{display:flex!important;flex-wrap:wrap!important;align-items:center!important;
          justify-content:flex-end;gap:6px!important;min-width:0!important;max-width:100%!important;
          flex:0 1 auto!important;margin-left:auto!important;padding:3px 0;box-sizing:border-box!important;
          font:12px/1.4 system-ui,-apple-system,"PingFang SC",sans-serif;white-space:normal!important}
        #__id_switch_preset_row,#__id_switch_action_row{display:flex!important;flex-wrap:wrap!important;
          align-items:center!important;gap:6px!important;min-width:0!important;max-width:100%!important;
          width:100%!important;box-sizing:border-box!important}
        #__id_switch_header_controls #__outliner_ratio_controls{display:flex!important;flex-wrap:wrap!important;
          align-items:center!important;gap:6px!important;width:auto!important;max-width:100%!important;
          min-width:0!important;margin:0!important;box-sizing:border-box!important;white-space:normal!important}
        #__outliner_ratio_actions{display:flex;flex-wrap:wrap;align-items:center;gap:6px;max-width:100%;min-width:0}
        #__id_switch_toolbar button,#__id_switch_header_controls button{flex:0 0 auto;max-width:100%;margin-left:0!important}
        #__outliner_ratio_trigger{display:inline-flex;align-items:center;justify-content:center;gap:7px;
          box-sizing:border-box;height:28px;min-width:94px;max-width:164px!important;padding:0 9px;
          border:1px solid #d5dfea;border-radius:6px;background:#fff;color:#3b4d65;cursor:pointer;
          font:12px/1.4 system-ui,-apple-system,"PingFang SC",sans-serif;white-space:nowrap}
        #__outliner_ratio_trigger:hover{border-color:#a5bedc;background:#f8fbff}
        #__outliner_ratio_trigger[aria-expanded=true]{border-color:#8bb6ee;background:#f1f7ff;color:#1769cc}
        #__outliner_ratio_trigger .preset-summary{min-width:0;max-width:83px;overflow:hidden;
          text-overflow:ellipsis;padding:1px 5px;border-radius:3px;background:#edf2f8;color:#65778e;font-size:11px}
        #__outliner_ratio_trigger[aria-expanded=true] .preset-summary{background:#e1edfd;color:#246bc1}
        #__outliner_ratio_trigger svg{width:12px;height:12px;flex:0 0 12px;transition:transform .12s}
        #__outliner_ratio_trigger[aria-expanded=true] svg{transform:rotate(180deg)}
        #__outliner_ratio_trigger:focus-visible{outline:2px solid #409eff;outline-offset:2px}
        #__outliner_ratio_popover{position:fixed;z-index:100005;display:flex;flex-direction:column;
          box-sizing:border-box;width:280px;max-width:calc(100vw - 16px);padding:14px 10px 10px;
          border:1px solid #dce4ee;border-radius:10px;background:#fff;color:#33455f;
          box-shadow:0 8px 28px #21355324,0 2px 6px #2135530a;
          font:12px/1.5 system-ui,-apple-system,"PingFang SC",sans-serif}
        #__outliner_ratio_popover[hidden]{display:none!important}
        #__outliner_ratio_popover .preset-heading{display:flex;justify-content:space-between;align-items:center;
          gap:8px;margin:0 4px;font-size:13px;font-weight:600;flex:0 0 auto}
        #__outliner_ratio_popover .preset-count{font-size:11px;font-weight:400;color:#337bcf;white-space:nowrap}
        #__outliner_ratio_popover .preset-hint{margin:3px 4px 10px;color:#8a97a9;font-size:11px;flex:0 0 auto}
        #__outliner_ratio_select{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));align-content:start;
          gap:5px;min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;padding:2px}
        #__outliner_ratio_select label{display:flex;align-items:center;gap:8px;box-sizing:border-box;
          min-width:0;max-width:100%;min-height:35px;padding:7px 9px;border:1px solid transparent;
          border-radius:5px;background:#f7f9fc;color:#526176;font-weight:400;cursor:pointer;font-size:12px;line-height:1.4}
        #__outliner_ratio_select label:hover{background:#eef3fa}
        #__outliner_ratio_select label.is-selected{color:#246bc1;background:#edf5ff;border-color:#c8defa}
        #__outliner_ratio_select label.preset-all{grid-column:1/-1;margin-bottom:4px;background:#fff;border-color:#e2e8f0}
        #__outliner_ratio_select label.preset-wide{grid-column:1/-1}
        #__outliner_ratio_select label span{min-width:0;overflow-wrap:anywhere;white-space:normal}
        #__outliner_ratio_select input{width:14px;height:14px;flex:0 0 14px;margin:0;accent-color:#287ce4;cursor:pointer}
        #__outliner_ratio_select input:focus-visible{outline:2px solid #409eff;outline-offset:2px}
        #__outliner_ratio_select{user-select:none}
        #__outliner_ratio_select label[data-marquee-hit=true]{outline:1px solid #73a9ed;background:#dfedff}
        #__outliner_ratio_select[data-marquee-action=remove] label[data-marquee-hit=true]{outline-color:#d5a46e;background:#fff1e3}
        .preset-marquee{position:fixed;z-index:100010;pointer-events:none;border:1px solid #287ce4;
          background:#287ce41c;border-radius:3px;box-sizing:border-box}
        .preset-marquee[data-action=remove]{border-color:#c78c4e;background:#c78c4e1c}
        #__id_switch_toolbar{gap:9px!important;padding:12px!important;background:#f7f9fc;color:#33465f}
        #__id_switch_toolbar button,#__id_switch_header_controls button,
        #__selected_visibility_toolbar button{box-sizing:border-box;height:28px!important;min-height:28px;
          border-radius:6px!important;font-size:12px;line-height:1.3;transition:background .12s,border-color .12s}
        #__id_switch_toolbar button:focus-visible,#__id_switch_header_controls button:focus-visible,
        #__selected_visibility_toolbar button:focus-visible,#__label_actions_toolbar button:focus-visible{
          outline:2px solid #287ce4;outline-offset:2px}
        #__id_switch_toolbar button:disabled{opacity:.42!important;cursor:default!important}
        #__outliner_mode_btn{color:#315782!important;background:#edf4fd!important;border-color:#c8daef!important;
          overflow:hidden;text-overflow:ellipsis;max-width:100%}
        #__id_switch_preset_details{border-top:1px solid #e3e9f1;padding-top:8px;color:#6a7c92}
        #__id_switch_preset_details>summary{cursor:pointer;width:fit-content;font-size:11px;user-select:none}
        #__id_switch_preset_details[open]>summary{margin-bottom:8px}
        #__outliner_ratio_actions>span:first-child{display:none}
        #__outliner_ratio_actions button,#__ls_edit_history_controls button{color:#526780!important;background:#fff!important}
        #__selected_visibility_toolbar{gap:7px!important;padding:9px 12px!important;background:#fff!important;color:#6a7c92}
        #__id_switch_toolbar~#__selected_visibility_toolbar button[aria-label="上一个 ID"],
        #__id_switch_toolbar~#__selected_visibility_toolbar button[aria-label="下一个 ID"]{display:none!important}
        #__label_actions_toolbar{gap:7px!important;padding-top:10px!important;border-top:1px solid #edf0f5}
        #__label_actions_toolbar button{height:28px!important;border-radius:6px!important;background:#fff6f5!important;
          border-color:#f0cfcb!important;color:#b44f49!important;font-size:12px}
        #__label_actions_toolbar button:disabled{opacity:.5!important}
        @media(prefers-reduced-motion:reduce){#__id_switch_toolbar *,#__id_switch_header_controls *{transition:none!important}}
      `;
      (document.head || document.documentElement).appendChild(style);
    }
    let root = document.getElementById('__id_switch_toolbar');
    if (!root) {
      root = document.createElement('div'); root.id = '__id_switch_toolbar';
      root.setAttribute('role', 'toolbar'); root.setAttribute('aria-label', 'ID切换工具栏');
    }
    function row(id, label) {
      let element = root.querySelector(`#${id}`);
      if (!element) {
        element = document.createElement('div'); element.id = id;
        element.setAttribute('role', 'group'); element.setAttribute('aria-label', label);
        root.appendChild(element);
      }
      return element;
    }
    const presets = row('__id_switch_preset_row', '预设管理');
    const actions = row('__id_switch_action_row', 'ID切换操作');
    let details = root.querySelector('#__id_switch_preset_details');
    if (!details) {
      details = document.createElement('details'); details.id = '__id_switch_preset_details';
      const summary = document.createElement('summary'); summary.textContent = '预设管理';
      details.appendChild(summary); root.appendChild(details);
    }
    if (presets.parentElement !== details) details.appendChild(presets);
    let quick = outlinerHeaderControls;
    if (!quick) {
      quick = document.createElement('div'); quick.id = '__id_switch_header_controls';
      quick.setAttribute('role', 'group'); quick.setAttribute('aria-label', 'Regions快捷操作');
      for (const name of ['pointerdown', 'mousedown', 'click', 'dblclick']) {
        quick.addEventListener(name, event => event.stopPropagation());
      }
      outlinerHeaderControls = quick;
    }
    // 标题栏重建可能留下无监听器的副本，恢复原节点以保留子控件事件。
    const copiedQuick = document.getElementById('__id_switch_header_controls');
    if (copiedQuick && copiedQuick !== quick) copiedQuick.replaceWith(quick);
    let header = null, regionTab = null;
    for (let parent = outliner.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      const candidate = Array.from(parent.children).find(child => child.classList.contains('lsf-tabs__tabs-row'));
      if (!candidate) continue;
      const tab = candidate.querySelector('#Regions-draggable .lsf-panel-tabs__tab') ||
        Array.from(candidate.querySelectorAll('.lsf-panel-tabs__tab')).find(node =>
          !node.closest('.lsf-panel-tabs__ghost-tab') && /^Regions$/i.test(node.textContent.trim()));
      if (tab) { header = candidate; regionTab = tab; break; }
    }
    if (header) {
      const previous = quick.parentElement;
      if (previous && previous !== header && previous.hasAttribute('data-id-switch-header')) previous.removeAttribute('data-id-switch-header');
      if (!header.hasAttribute('data-id-switch-header')) header.setAttribute('data-id-switch-header', '');
      if (quick.parentElement !== header) header.appendChild(quick);
      if (header.nextElementSibling !== root) header.after(root);
    } else {
      const previous = quick.parentElement;
      if (previous && previous.hasAttribute('data-id-switch-header')) previous.removeAttribute('data-id-switch-header');
      if (root.firstElementChild !== quick) root.prepend(quick);
      if (outliner.firstElementChild !== root) outliner.prepend(root);
    }
    const inactive = !!regionTab && !regionTab.classList.contains('lsf-panel-tabs__tab_active');
    if (root.hidden !== inactive) root.hidden = inactive;
    if (quick.hidden !== inactive) quick.hidden = inactive;
    return { root, presets, actions, quick };
  }

  /* ============================================================
   *  模块 1：Outliner 快捷切换（支持模式切换 + 工具栏切换按钮）
   *  - S 和按钮只循环 9:16、16:9、1:1、4:3、3:4 五种常用比例
   *  - 比例各自独立切换，并保留「全部比例·非人物」模式
   *  - 默认 S 键循环切换模式，可在快捷键设置修改
   *  - 支持下拉面板多选预设、自定义比例保存及数学等价匹配
   *  - 修复：observer 防抖 + 按钮文字比较，避免自触发死循环
   * ============================================================ */
  (function moduleOutliner() {
    const SKIP_HUMAN = true;
    const MODE_BTN_ID = '__outliner_mode_btn';
    const RATIO_STORAGE_KEY = 'ls_toolkit_outliner_ratios_v1';
    const RATIO_CONTROLS_ID = '__outliner_ratio_controls';
    const RATIO_ACTIONS_ID = '__outliner_ratio_actions';
    const RATIO_SELECT_ID = '__outliner_ratio_select';
    const RATIO_TRIGGER_ID = '__outliner_ratio_trigger';
    const RATIO_POPOVER_ID = '__outliner_ratio_popover';
    const RATIO_SETTINGS_ID = '__outliner_ratio_settings_btn';
    const RATIO_DELETE_ID = '__outliner_ratio_delete_btn';
    const RATIO_DIALOG_ID = '__outliner_ratio_dialog';
    const MULTI_KEY = 'multiple';
    const NONE_KEY = 'none';
    const RATIO_ATTRS = ['title', 'aria-label', 'data-label', 'data-name', 'data-ratio'];
    const MAX_CUSTOM_RATIOS = 50;
    // 分数化比较可正确处理 1920:1080 = 16:9，同时不会把 116:9 误认成 16:9。
    const RATIO_TOKENS = /\[\s*(\d+(?:\.\d+)?)\s*[,，]\s*(\d+(?:\.\d+)?)\s*\]|(?:^|[^\dA-Za-z_.+\-−－:：/×,，])(\d+(?:\.\d+)?)\s*[:：/xX×]\s*(\d+(?:\.\d+)?)(?=$|[^\dA-Za-z_.:：/×,，])/g;
    const ratioCache = new WeakMap();
    let ratioDialog = null, ratioInput = null, ratioError = null, ratioStatus = null;
    let ratioList = null, previousRatioFocus = null;
    let ratioPopover = null;
    let cancelMarquee = () => {};
    let navigationAnchor = null, navigationAnnotation = null, navigationRoute = null;

    function parseRatio(value) {
      if (typeof value !== 'string' || value.length > 80) return null;
      let text = value.trim();
      if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1).trim();
      const match = text.match(/^(\d{1,9}(?:\.\d{1,6})?)\s*[:：/,，xX×]\s*(\d{1,9}(?:\.\d{1,6})?)$/);
      if (!match) return null;
      const scaled = token => {
        const [whole, fraction = ''] = token.split('.');
        return Number(whole) * 1000000 + Number(fraction.padEnd(6, '0'));
      };
      const width = scaled(match[1]), height = scaled(match[2]);
      if (!(width > 0 && height > 0)) return null;
      let a = width, b = height;
      while (b) { const remainder = a % b; a = b; b = remainder; }
      return { key: `${width / a}:${height / a}`, label: `${Number(match[1])}:${Number(match[2])}` };
    }

    function normalizeLabel(value) { return value.trim().replace(/\s+/g, ' '); }

    function parseNamedPreset(value) {
      if (typeof value !== 'string' || value.length > 80 || /[\p{Cc}<>]/u.test(value)) return null;
      const label = normalizeLabel(value);
      if (!label || !/\p{L}/u.test(label)) return null;
      // 写错的比例不能悄悄变成名称预设；名称中的数字、横线和中文均可使用。
      if (/^[+\-−－]?(?:\d[\d.eE+\-]*|Infinity|NaN)\s*[:：/xX×,，]/i.test(label)) return null;
      return { type: 'label', key: `label:${label}`, label };
    }

    const PRESET_RATIOS = ['9:16', '16:9', '1:1', '4:3', '3:4'].map(parseRatio);
    const presetKeys = new Set(PRESET_RATIOS.map(ratio => ratio.key));

    function loadRatios() {
      const fallback = { custom: [], removed: [], selected: 'all', multiple: [] };
      try {
        const saved = JSON.parse(localStorage.getItem(RATIO_STORAGE_KEY) || 'null');
        if (!saved || saved.version !== 1 || !Array.isArray(saved.custom) || saved.custom.length > MAX_CUSTOM_RATIOS) return fallback;
        const removed = Array.isArray(saved.removed) ? [...new Set(saved.removed.filter(key => presetKeys.has(key)))] : [];
        const keys = new Set([...presetKeys].filter(key => !removed.includes(key))), custom = [];
        for (const value of saved.custom) {
          const ratio = value && typeof value === 'object' && value.type === 'label' ? parseNamedPreset(value.label) : parseRatio(value);
          if (!ratio || presetKeys.has(ratio.key) || keys.has(ratio.key)) continue;
          keys.add(ratio.key); custom.push(ratio);
        }
        const multiple = Array.isArray(saved.multiple) ? [...new Set(saved.multiple.filter(key => keys.has(key)))] : [];
        const selected = saved.selected === MULTI_KEY ? (multiple.length > 1 ? MULTI_KEY : multiple[0] || 'all') :
          saved.selected === 'all' || saved.selected === NONE_KEY || keys.has(saved.selected) ? saved.selected : 'all';
        return { custom, removed, selected, multiple };
      } catch (e) { return fallback; }
    }

    const savedRatios = loadRatios();
    let customRatios = savedRatios.custom, selectedRatio = savedRatios.selected;
    let selectedMultiple = savedRatios.multiple;
    let removedPresetKeys = new Set(savedRatios.removed);
    function allRatios() { return [...PRESET_RATIOS.filter(ratio => !removedPresetKeys.has(ratio.key)), ...customRatios]; }
    function ratioChoices() { return allRatios().filter(ratio => ratio.type !== 'label'); }
    function ratioLabel(key) {
      if (key === 'all') return '全部比例';
      if (key === NONE_KEY) return '未选择预设';
      if (key === MULTI_KEY) return selectedMultiple.map(value => ratioLabel(value)).join(' + ');
      return (allRatios().find(ratio => ratio.key === key) || {}).label || key;
    }
    function ratioModeId(key) { return key === 'all' ? 'ratio' : key.startsWith('label:') ? key : `ratio:${key}`; }
    function persistRatios(custom, selected, removed = removedPresetKeys, multiple = selectedMultiple) {
      localStorage.setItem(RATIO_STORAGE_KEY, JSON.stringify({ version: 1, custom: custom.map(ratio =>
        ratio.type === 'label' ? { type: 'label', label: ratio.label } : ratio.label), removed: [...removed], selected, multiple }));
    }

    function getAll() { return Array.from(document.querySelectorAll('.lsf-outliner-item')); }

    function itemRatios(item) {
      const cached = ratioCache.get(item);
      if (cached) return cached;
      const found = new Set();
      const read = text => {
        if (!text) return;
        for (const match of String(text).matchAll(RATIO_TOKENS)) {
          const ratio = parseRatio(`${match[1] || match[3]}:${match[2] || match[4]}`);
          if (ratio) found.add(ratio.key);
        }
      };
      // 标题与行号属于不同 DOM 节点；整行 textContent 会把「2」「16:9」拼成「216:9」。
      const title = item.querySelector('.lsf-outliner-item__title');
      if (title) read(title.textContent);
      else {
        const readText = node => {
          if (node.nodeType === 3) { read(node.nodeValue); return; }
          for (const child of node.childNodes) readText(child);
        };
        readText(item);
      }
      const readAttrs = node => { for (const name of RATIO_ATTRS) read(node.getAttribute(name)); };
      readAttrs(item);
      for (const node of item.querySelectorAll('[title], [aria-label], [data-label], [data-name], [data-ratio]')) readAttrs(node);
      ratioCache.set(item, found);
      return found;
    }

    function isRatio(item, key) {
      if (!item) return false;
      const found = itemRatios(item);
      return key === 'all' ? found.size > 0 : found.has(key);
    }

    function updateRatioControls() {
      const select = document.getElementById(RATIO_SELECT_ID);
      if (!select) return;
      const options = [{ key: 'all', label: '全选' }, ...allRatios()];
      const signature = JSON.stringify(options);
      if (select.dataset.options !== signature) {
        const nodes = options.map(ratio => {
          const label = document.createElement('label');
          if (ratio.key === 'all') label.className = 'preset-all';
          else if (ratio.label.length > 12) label.className = 'preset-wide';
          const input = document.createElement('input'); input.type = 'checkbox'; input.value = ratio.key;
          input.addEventListener('change', () => togglePreset(ratio.key, input.checked));
          const text = document.createElement('span'); text.textContent = ratio.label;
          label.append(input, text);
          return label;
        });
        select.replaceChildren(...nodes);
        select.dataset.options = signature;
      }
      const active = new Set(checkedPresetKeys()), presets = allRatios();
      for (const input of select.querySelectorAll('input[type=checkbox]')) {
        const checked = input.value === 'all' ? presets.length > 0 && active.size === presets.length : active.has(input.value);
        if (input.checked !== checked) input.checked = checked;
        const partial = input.value === 'all' && active.size > 0 && active.size < presets.length;
        if (input.indeterminate !== partial) input.indeterminate = partial;
        if (input.parentElement.classList.contains('is-selected') !== checked) input.parentElement.classList.toggle('is-selected', checked);
      }
      const remove = document.getElementById(RATIO_DELETE_ID);
      if (remove) {
        const disabled = selectedRatio === 'all' || selectedRatio === MULTI_KEY || selectedRatio === NONE_KEY;
        if (remove.disabled !== disabled) remove.disabled = disabled;
        const opacity = disabled ? '0.45' : '1', cursor = disabled ? 'default' : 'pointer';
        if (remove.style.opacity !== opacity) remove.style.opacity = opacity;
        if (remove.style.cursor !== cursor) remove.style.cursor = cursor;
        const title = selectedRatio === MULTI_KEY ? '直接取消勾选可调整组合；删除单个预设请打开“新增”管理' :
          disabled ? '勾选单个预设后可删除，也可打开“新增”管理' : `从预设列表删除 ${ratioLabel(selectedRatio)}，保留标注框`;
        if (remove.title !== title) remove.title = title;
      }
      const title = `当前：${currentMode().label}；勾选即生效，支持多选并自动保存`;
      if (select.title !== title) select.title = title;
      const trigger = document.getElementById(RATIO_TRIGGER_ID);
      if (trigger) {
        const summary = trigger.querySelector('.preset-summary');
        const text = currentMode().ratioKey === 'all' ? '全部比例' : active.size > 1 ? `${active.size} 项` :
          active.size ? ratioLabel([...active][0]) : '未选择';
        if (summary.textContent !== text) summary.textContent = text;
        if (trigger.title !== title) trigger.title = title;
        const count = ratioPopover.querySelector('.preset-count');
        const countText = `已选 ${active.size} 项`;
        if (count.textContent !== countText) count.textContent = countText;
        if (!ratioPopover.hidden) {
          const quick = trigger.closest('#__id_switch_header_controls');
          if (!trigger.isConnected || quick && quick.hidden || document.querySelector('dialog[open]')) closePresetPanel();
          else positionPresetPanel();
        }
      }
    }

    function closePresetPanel(returnFocus = false) {
      if (!ratioPopover || ratioPopover.hidden) return;
      cancelMarquee();
      ratioPopover.hidden = true;
      const trigger = document.getElementById(RATIO_TRIGGER_ID);
      if (trigger) {
        trigger.setAttribute('aria-expanded', 'false');
        if (returnFocus && trigger.isConnected) trigger.focus();
      }
    }

    function positionPresetPanel() {
      if (!ratioPopover || ratioPopover.hidden) return;
      const trigger = document.getElementById(RATIO_TRIGGER_ID);
      if (!trigger || !trigger.getClientRects().length) { closePresetPanel(); return; }
      const rect = trigger.getBoundingClientRect(), gap = 6, edge = 8;
      const viewportWidth = document.documentElement.clientWidth, viewportHeight = document.documentElement.clientHeight;
      if (rect.bottom < 0 || rect.top > viewportHeight || rect.right < 0 || rect.left > viewportWidth) { closePresetPanel(); return; }
      const below = viewportHeight - rect.bottom - gap - edge, above = rect.top - gap - edge;
      // 优先向下展开，底部空间不足时在按钮上方展开；面板内部滚动。
      const upward = below < 250 && above > below;
      const maxHeight = Math.max(0, Math.min(360, upward ? above : below));
      ratioPopover.style.maxHeight = `${maxHeight}px`;
      const box = ratioPopover.getBoundingClientRect();
      const left = Math.max(edge, Math.min(rect.right - box.width, viewportWidth - edge - box.width));
      const top = Math.max(edge, Math.min(upward ? rect.top - gap - box.height : rect.bottom + gap,
        viewportHeight - edge - box.height));
      const leftPx = `${left}px`, topPx = `${top}px`;
      if (ratioPopover.style.left !== leftPx) ratioPopover.style.left = leftPx;
      if (ratioPopover.style.top !== topPx) ratioPopover.style.top = topPx;
    }

    function openPresetPanel(focusFirst = false) {
      if (!ratioPopover) return;
      ratioPopover.hidden = false;
      document.getElementById(RATIO_TRIGGER_ID).setAttribute('aria-expanded', 'true');
      positionPresetPanel();
      if (focusFirst) ratioPopover.querySelector('input').focus();
    }

    document.addEventListener('pointerdown', event => {
      if (ratioPopover && !ratioPopover.hidden && !ratioPopover.contains(event.target) &&
          !event.target.closest(`#${RATIO_TRIGGER_ID}`)) closePresetPanel();
    }, true);
    document.addEventListener('focusin', event => {
      if (ratioPopover && !ratioPopover.hidden && !ratioPopover.contains(event.target) &&
          !event.target.closest(`#${RATIO_TRIGGER_ID}`)) closePresetPanel();
    });
    window.addEventListener('resize', positionPresetPanel);
    document.addEventListener('scroll', positionPresetPanel, true);

    function checkedPresetKeys() {
      const key = currentMode().ratioKey;
      if (!key || key === NONE_KEY) return [];
      if (key === 'all') return ratioChoices().map(ratio => ratio.key);
      return key === MULTI_KEY ? [...selectedMultiple] : [key];
    }

    function selectPresetKeys(keys) {
      const ordered = allRatios().filter(ratio => keys.has(ratio.key)).map(ratio => ratio.key);
      const selection = ordered.length > 1 ? MULTI_KEY : ordered[0] || NONE_KEY;
      return commitRatios(customRatios, selection, true, removedPresetKeys, ordered);
    }
    function togglePreset(key, checked) {
      const keys = new Set(checkedPresetKeys());
      if (key === 'all') {
        keys.clear();
        if (checked) allRatios().forEach(preset => keys.add(preset.key));
      } else if (checked) keys.add(key); else keys.delete(key);
      selectPresetKeys(keys);
    }

    function installPresetMarquee(select) {
      let gesture = null, rectangle = null, suppressClick = false;
      const options = () => Array.from(select.querySelectorAll('label:not(.preset-all)'));
      function clean() {
        if (gesture) { try { select.releasePointerCapture(gesture.id); } catch (e) {} }
        gesture = null;
        rectangle?.remove(); rectangle = null;
        delete select.dataset.marqueeAction;
        options().forEach(label => label.removeAttribute('data-marquee-hit'));
      }
      cancelMarquee = clean;
      select.addEventListener('pointerdown', event => {
        if (event.button !== 0 || event.isPrimary === false || event.pointerType === 'touch' || event.target.closest('.preset-all')) return;
        const anchor=event.target.closest('label')?.querySelector('input');
        gesture = { id:event.pointerId, x:event.clientX, y:event.clientY, base:new Set(checkedPresetKeys()),
          subtract:event.altKey ? true : anchor ? anchor.checked : null, dragging:false, hits:[] };
      });
      document.addEventListener('pointermove', event => {
        if (!gesture || event.pointerId !== gesture.id) return;
        if (!gesture.dragging && Math.hypot(event.clientX-gesture.x,event.clientY-gesture.y) < 5) return;
        if (!gesture.dragging) { try { select.setPointerCapture(event.pointerId); } catch (e) {} }
        gesture.dragging = true; event.preventDefault();
        const bounds=select.getBoundingClientRect();
        const left=Math.max(bounds.left,Math.min(gesture.x,event.clientX));
        const top=Math.max(bounds.top,Math.min(gesture.y,event.clientY));
        const right=Math.min(bounds.right,Math.max(gesture.x,event.clientX));
        const bottom=Math.min(bounds.bottom,Math.max(gesture.y,event.clientY));
        if (!rectangle) { rectangle=document.createElement('div');rectangle.className='preset-marquee';rectangle.setAttribute('aria-hidden','true');document.body.appendChild(rectangle); }
        Object.assign(rectangle.style,{left:`${left}px`,top:`${top}px`,width:`${Math.max(0,right-left)}px`,height:`${Math.max(0,bottom-top)}px`});
        gesture.hits=[];
        for (const label of options()) {
          const rect=label.getBoundingClientRect();
          const hit=right>left && bottom>top && rect.right>left && rect.left<right && rect.bottom>top && rect.top<bottom;
          if (hit) gesture.hits.push(label.querySelector('input').value);
          if (hit) label.setAttribute('data-marquee-hit','true'); else label.removeAttribute('data-marquee-hit');
        }
        if (gesture.subtract === null && gesture.hits.length) gesture.subtract=gesture.hits.every(key=>gesture.base.has(key));
        select.dataset.marqueeAction=rectangle.dataset.action=gesture.subtract ? 'remove' : 'add';
      });
      document.addEventListener('pointerup', event => {
        if (!gesture || event.pointerId !== gesture.id) return;
        const finished=gesture;
        clean();
        if (!finished.dragging) return;
        event.preventDefault();
        suppressClick=true; setTimeout(()=>{suppressClick=false;},0);
        for (const key of finished.hits) { if (finished.subtract) finished.base.delete(key); else finished.base.add(key); }
        if (finished.hits.length) selectPresetKeys(finished.base);
      });
      document.addEventListener('pointercancel', event => { if (gesture && event.pointerId === gesture.id) clean(); });
      select.addEventListener('click', event => {
        if (!suppressClick) return;
        suppressClick=false;event.preventDefault();event.stopImmediatePropagation();
      },true);
    }

    function matchesNamedLabel(item, label) {
      const names = [];
      const add = values => {
        if (typeof values === 'string') names.push(normalizeLabel(values));
        else if (values && typeof values[Symbol.iterator] === 'function') {
          for (const value of values) if (typeof value === 'string') names.push(normalizeLabel(value));
        }
      };
      let fiber = getReactFiber(item);
      for (let depth = 0; fiber && depth < 40; depth++, fiber = fiber.return) {
        const region = fiber.memoizedProps && fiber.memoizedProps.item;
        if (!region) continue;
        add(region.labels);
        add(region.labeling && region.labeling.mainValue);
        if (region.labelings) for (const value of region.labelings) add(value.mainValue);
        add(region.labelName);
        if (names.length) return names.includes(label);
      }
      const title = item.querySelector('.lsf-outliner-item__title');
      if (!title) return false;
      const leaves = Array.from(title.querySelectorAll('.lsf-labels-list'))
        .filter(node => !node.querySelector('.lsf-labels-list'));
      return (leaves.length ? leaves : [title]).some(node => normalizeLabel(node.textContent) === label);
    }

    function isHuman(item) {
      if (!item) return false;
      const t = item.querySelector('.lsf-outliner-item__title');
      return t ? t.textContent.includes('人物') : false;
    }

    // 模式定义：match(item) 返回 true 才纳入切换列表
    function buildModes() {
      const presets = allRatios();
      const multiplePresets = presets.filter(preset => selectedMultiple.includes(preset.key));
      const ratioMode = (key, label) => ({ id: ratioModeId(key), label: `${label}·非人物`, ratioKey: key,
        match: item => !(SKIP_HUMAN && isHuman(item)) && isRatio(item, key) });
      return [
        ...presets.map(ratio => ratio.type === 'label' ? {
          id: ratio.key, label: ratio.label, ratioKey: ratio.key, namedLabel: ratio.label,
          match: item => !!item && matchesNamedLabel(item, ratio.label),
        } : ratioMode(ratio.key, ratio.label)),
        ...(selectedMultiple.length > 1 ? [{ id: ratioModeId(MULTI_KEY), label: ratioLabel(MULTI_KEY),
          ratioKey: MULTI_KEY, match: item => multiplePresets.some(preset => preset.type === 'label' ?
            matchesNamedLabel(item, preset.label) : !(SKIP_HUMAN && isHuman(item)) && isRatio(item, preset.key)) }] : []),
        ratioMode('all', '全部比例'),
        { id: ratioModeId(NONE_KEY), label: '未选择预设', ratioKey: NONE_KEY, match: () => false },
      ];
    }
    let MODES = buildModes();

    // —— 模式持久化 ——
    const STORAGE_KEY = 'ls_toolkit_outliner_mode';
    function loadSavedMode() {
      try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) {
          const i = MODES.findIndex(m => m.id === saved);
          if (i >= 0) return i;
          if (saved.startsWith('ratio:')) return MODES.findIndex(m => m.id === 'ratio');
        }
      } catch (e) {}
      return 0; // 无保存或旧不可用模式时默认第一个常用比例。
    }
    function saveMode(m) {
      if (m.ratioKey) selectedRatio = m.ratioKey;
      try {
        localStorage.setItem(STORAGE_KEY, m.id);
        persistRatios(customRatios, selectedRatio);
      } catch (e) {}
    }
    let modeIndex = loadSavedMode();
    if (MODES[modeIndex].ratioKey) selectedRatio = MODES[modeIndex].ratioKey;

    function currentMode() { return MODES[modeIndex]; }
    function matchMode(item) { return !!item && !!currentMode().match(item); }

    function getAvail() { return getAll().filter(matchMode); }
    function navigationBusy() {
      return editing.drawing() || !!window.__CLEAR_TAGS?.isRunning() || !!window.__REGION_DELETE?.isRunning();
    }

    function itemIdentity(item) {
      let fiber = getReactFiber(item);
      for (let depth = 0; fiber && depth < 40; depth++, fiber = fiber.return) {
        const region = fiber.memoizedProps && fiber.memoizedProps.item;
        if (region && (region.id || region.pid)) return String(region.id || region.pid);
      }
      return item.getAttribute('data-key') || item.getAttribute('data-id') || item;
    }

    function syncNavigationContext() {
      const ann = editing.annotation();
      if (ann !== navigationAnnotation || location.href !== navigationRoute) {
        navigationAnchor = null; navigationAnnotation = ann; navigationRoute = location.href;
      }
    }

    function rememberNavigation(item, items) {
      syncNavigationContext();
      navigationAnchor = { key: itemIdentity(item), order: items.map(itemIdentity) };
    }

    function syncManual(av = getAvail()) {
      syncNavigationContext();
      const selected = editing.selectedRegions(navigationAnnotation, editing.regions(navigationAnnotation));
      const selectedKeys = new Set(selected.map(region => String(region.id || region.pid)));
      const active = av.find(item => selectedKeys.has(itemIdentity(item))) || av.find(item =>
        item.classList.contains('lsf-outliner-item_active') ||
        item.closest('.lsf-tree-treenode-selected, .lsf-tree-node-selected'));
      if (active) rememberNavigation(active, av);
      return active;
    }

    function clearOutline() { getAll().forEach(i => { i.style.outline = ''; i.style.outlineOffset = ''; }); }

    function activate(item, dir) {
      if (navigationBusy()) return;
      clearOutline();
      item.style.outline = '2px solid #409eff';
      item.style.outlineOffset = '2px';
      item.scrollIntoView({ block: 'nearest' });
      ['mousedown', 'mouseup', 'click'].forEach(et => item.dispatchEvent(new MouseEvent(et, { bubbles: true, cancelable: true })));
    }

    function navigate(direction) {
      if (navigationBusy()) return;
      const av = getAvail();
      syncManual(av);
      if (!av.length) return;
      const keys = av.map(itemIdentity), index = navigationAnchor ? keys.indexOf(navigationAnchor.key) : -1;
      let target = null;
      if (index >= 0) target = av[(index + direction + av.length) % av.length];
      else if (navigationAnchor) {
        // 删除后保留原顺序中的缺口，向相应方向找最近仍存在的框。
        const order = navigationAnchor.order, deletedIndex = order.indexOf(navigationAnchor.key);
        for (let offset = 1; deletedIndex >= 0 && offset <= order.length; offset++) {
          const candidate = order[(deletedIndex + direction * offset + order.length) % order.length];
          const at = keys.indexOf(candidate);
          if (at >= 0) { target = av[at]; break; }
        }
      }
      target = target || av[direction < 0 ? av.length - 1 : 0];
      rememberNavigation(target, av);
      activate(target, direction < 0 ? '↑' : '↓');
    }

    function next() { navigate(1); }
    function prev() { navigate(-1); }

    /* ---- 同步工具栏按钮显示：先比较再写，避免触发 observer 死循环 ---- */
    function updateModeButton() {
      updateRatioControls();
      const btn = document.getElementById(MODE_BTN_ID);
      if (!btn) return;
      const m = currentMode();
      const av = getAvail();
      const text = `ID：${m.label}（${av.length}）`;
      if (btn.textContent !== text) btn.textContent = text;
      const shortcut = window.__LS_SHORTCUTS ? window.__LS_SHORTCUTS.hint('mode') : 'S';
      const title = `当前模式：${m.label}\n点击切换${shortcut ? `（也可按 ${shortcut}）` : '（未绑定快捷键）'}`;
      if (btn.title !== title) btn.title = title;
    }

    function switchMode(step) {
      const dir = (typeof step === 'number') ? step : 1;
      const cycle = PRESET_RATIOS.map(ratio => MODES.findIndex(mode => mode.ratioKey === ratio.key)).filter(index => index >= 0);
      if (!cycle.length) {
        showToast('当前没有常用比例预设，请从“新增”添加 9:16、16:9、1:1、4:3 或 3:4。', 2200);
        return currentMode();
      }
      const index = cycle.indexOf(modeIndex);
      const nextIndex = index < 0 ? dir < 0 ? cycle.length - 1 : 0 : ((index + dir) % cycle.length + cycle.length) % cycle.length;
      modeIndex = cycle[nextIndex];
      navigationAnchor = null;
      clearOutline();
      syncManual();
      saveMode(currentMode()); // 写入 localStorage，下次打开保持
      const av = getAvail();
      showToast(`切换 ID 模式：${currentMode().label}（${av.length} 项）`, 1600);
      updateModeButton();
      if (currentMode().namedLabel) next();
      return currentMode();
    }

    function setMode(idOrLabel) {
      const requested = idOrLabel === '比例·非人物' ? 'ratio' : idOrLabel;
      const i = MODES.findIndex(m => m.id === requested || m.label === requested);
      if (i < 0) { showToast(`未知模式：${idOrLabel}`, 1500); return currentMode().id; }
      modeIndex = i;
      navigationAnchor = null;
      clearOutline();
      syncManual();
      saveMode(currentMode()); // 写入 localStorage，下次打开保持
      const av = getAvail();
      showToast(`切换 ID 模式：${currentMode().label}（${av.length} 项）`, 1600);
      updateModeButton();
      return currentMode().id;
    }

    function ratioFeedback(message, error) {
      if (ratioError) ratioError.textContent = error ? message : '';
      if (ratioStatus) ratioStatus.textContent = error ? '' : message;
      if (error) showToast(message, 2500);
    }

    function commitRatios(custom, key, activate, removed = removedPresetKeys, multiple = selectedMultiple) {
      const available = [...PRESET_RATIOS.filter(ratio => !removed.has(ratio.key)), ...custom];
      const ratioKeys = new Set(available.map(ratio => ratio.key));
      const nextMultiple = [...new Set(multiple.filter(value => ratioKeys.has(value)))];
      if (key === MULTI_KEY && nextMultiple.length < 2) key = nextMultiple[0] || 'all';
      if (key !== 'all' && key !== MULTI_KEY && key !== NONE_KEY && !available.some(ratio => ratio.key === key)) return false;
      try { persistRatios(custom, key, removed, nextMultiple); }
      catch (error) {
        ratioFeedback('预设设置保存失败，请检查此站点的存储权限。当前设置未更改。', true);
        updateRatioControls();
        return false;
      }
      const previousMode = currentMode().id;
      customRatios = custom; selectedRatio = key; removedPresetKeys = removed; selectedMultiple = nextMultiple;
      MODES = buildModes();
      const nextMode = activate || previousMode === ratioModeId(MULTI_KEY) ? ratioModeId(key) : previousMode;
      // 删除正在使用的比例预设后，回到全部比例。
      modeIndex = Math.max(0, MODES.findIndex(mode => mode.id === nextMode));
      if (!MODES.some(mode => mode.id === nextMode)) modeIndex = MODES.findIndex(mode => mode.id === 'ratio');
      setMode(currentMode().id);
      if (activate && currentMode().namedLabel) next();
      refreshRatioList();
      return true;
    }

    function removeRatio(key) {
      const ratio = allRatios().find(value => value.key === key);
      if (!ratio) return;
      const removed = new Set(removedPresetKeys);
      if (presetKeys.has(key)) removed.add(key);
      const custom = customRatios.filter(value => value.key !== key);
      if (commitRatios(custom, selectedRatio === key ? 'all' : selectedRatio, false, removed)) {
        ratioFeedback(`已删除预设 ${ratio.label}，标注框保持不变。`, false);
        showToast(`已删除预设 ${ratio.label}`, 1600);
      }
    }

    function addRatioPreset(ratio) {
      const existing = allRatios().find(value => value.key === ratio.key);
      if (!existing && !presetKeys.has(ratio.key) && customRatios.length >= MAX_CUSTOM_RATIOS) {
        ratioFeedback(`最多保存 ${MAX_CUSTOM_RATIOS} 个自定义预设，请先删除不用的预设。`, true);
        return false;
      }
      const removed = new Set(removedPresetKeys); removed.delete(ratio.key);
      const custom = existing || presetKeys.has(ratio.key) ? customRatios : [...customRatios, ratio];
      if (!commitRatios(custom, ratio.key, true, removed)) return false;
      ratioFeedback(existing ? `已切换到已有预设 ${existing.label}，不会重复添加。` : `已保存并使用 ${ratio.label}，已加入 S 键循环。`, false);
      return true;
    }

    function addCustomRatio() {
      const ratio = parseRatio(ratioInput.value) || parseNamedPreset(ratioInput.value);
      if (!ratio) {
        ratioFeedback('请输入比例（如 16:9、2.35:1）或标签名称（如 人物-1）。比例两项必须大于 0；名称需含文字，最多 80 字。', true);
        ratioInput.focus();
        return;
      }
      if (!addRatioPreset(ratio)) return;
      ratioInput.value = '';
      ratioInput.focus();
    }

    function refreshRatioList() {
      if (!ratioList) return;
      ratioList.replaceChildren();
      if (!allRatios().length) {
        const empty = document.createElement('p'); empty.textContent = '还没有预设。可从上方下拉添加比例，或输入比例、标签名称。';
        ratioList.appendChild(empty);
        return;
      }
      for (const ratio of allRatios()) {
        const row = document.createElement('div'); row.className = 'ratio-custom-row';
        const use = document.createElement('button'); use.type = 'button';
        use.textContent = ratio.label;
        use.setAttribute('aria-label', `使用 ${ratio.label}`);
        use.setAttribute('aria-pressed', String(selectedRatio === ratio.key));
        use.addEventListener('click', () => {
          if (commitRatios(customRatios, ratio.key, true)) ratioFeedback(`已使用 ${ratio.label}`, false);
        });
        const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'ratio-remove';
        remove.textContent = '删除'; remove.setAttribute('aria-label', `删除 ${ratio.label}`);
        remove.addEventListener('click', () => removeRatio(ratio.key));
        row.append(use, remove); ratioList.appendChild(row);
      }
    }

    function closeRatioSettings() { if (ratioDialog && ratioDialog.open) ratioDialog.close(); }

    function buildRatioDialog() {
      const styleId = '__outliner_ratio_style';
      if (!document.getElementById(styleId)) {
        const style = document.createElement('style'); style.id = styleId;
        style.textContent = `
          #${RATIO_DIALOG_ID}{box-sizing:border-box;width:min(540px,calc(100vw - 32px));max-height:85vh;overflow:auto;padding:24px;border:1px solid #d8dee8;border-radius:12px;background:#fff;color:#253047;box-shadow:0 16px 60px #0004;font:14px/1.5 system-ui,-apple-system,"PingFang SC",sans-serif}
          #${RATIO_DIALOG_ID}::backdrop{background:#17203377}
          #${RATIO_DIALOG_ID} h2{font-size:20px;margin:0 0 6px}
          #${RATIO_DIALOG_ID} h3{font-size:14px;margin:20px 0 8px}
          #${RATIO_DIALOG_ID} p{margin:0 0 12px;color:#657186}
          #${RATIO_DIALOG_ID} button{font:inherit;cursor:pointer;border:1px solid #cbd3df;border-radius:5px;background:#fff;color:#334155;padding:6px 12px}
          #${RATIO_DIALOG_ID} button:focus-visible,#${RATIO_DIALOG_ID} input:focus,#${RATIO_DIALOG_ID} select:focus{outline:2px solid #409eff;outline-offset:2px}
          #${RATIO_DIALOG_ID} .ratio-form{display:flex;gap:8px;margin-top:6px;flex-wrap:wrap}
          #${RATIO_DIALOG_ID} input,#${RATIO_DIALOG_ID} select{box-sizing:border-box;flex:1;min-width:140px;height:34px;padding:6px 10px;border:1px solid #cbd3df;border-radius:5px;color:#253047;background:#fff;font:14px ui-monospace,monospace}
          #${RATIO_DIALOG_ID} .ratio-primary,#${RATIO_DIALOG_ID} [aria-pressed=true]{background:#287ce4;border-color:#287ce4;color:#fff}
          #${RATIO_DIALOG_ID} .ratio-custom-list{display:flex;gap:8px;flex-wrap:wrap}
          #${RATIO_DIALOG_ID} .ratio-custom-row{display:inline-flex;gap:4px}
          #${RATIO_DIALOG_ID} .ratio-remove{color:#bc3232;padding:6px 8px}
          #${RATIO_DIALOG_ID} [role=alert]{color:#bc3232;white-space:normal}
          #${RATIO_DIALOG_ID} [role=status]{color:#237345;white-space:normal}
          #${RATIO_DIALOG_ID} .ratio-feedback{margin:12px 0;min-height:22px}
          #${RATIO_DIALOG_ID} .ratio-footer{display:flex;justify-content:flex-end}
        `;
        (document.head || document.documentElement).appendChild(style);
      }
      ratioDialog = document.createElement('dialog'); ratioDialog.id = RATIO_DIALOG_ID;
      ratioDialog.setAttribute('aria-labelledby', '__outliner_ratio_title');
      const title = document.createElement('h2'); title.id = '__outliner_ratio_title'; title.textContent = '预设设置';
      const help = document.createElement('p');
      help.textContent = '预设支持比例和标签名称。标题栏直接勾选即可生效，支持多选并自动保存；选择单个名称可定位对应条目。';
      const stockLabel = document.createElement('label'); stockLabel.htmlFor = '__outliner_ratio_catalog'; stockLabel.textContent = '常用比例';
      const stockForm = document.createElement('div'); stockForm.className = 'ratio-form'; stockForm.style.marginBottom = '16px';
      const stockSelect = document.createElement('select'); stockSelect.id = stockLabel.htmlFor;
      for (const ratio of PRESET_RATIOS) {
        const option = document.createElement('option'); option.value = ratio.key; option.textContent = ratio.label;
        stockSelect.appendChild(option);
      }
      const addStock = document.createElement('button'); addStock.type = 'button'; addStock.className = 'ratio-primary'; addStock.textContent = '添加预设';
      addStock.addEventListener('click', () => addRatioPreset(PRESET_RATIOS.find(ratio => ratio.key === stockSelect.value)));
      stockForm.append(stockSelect, addStock);
      const label = document.createElement('label'); label.htmlFor = '__outliner_ratio_input'; label.textContent = '比例或标签名称';
      const form = document.createElement('div'); form.className = 'ratio-form';
      ratioInput = document.createElement('input'); ratioInput.type = 'text'; ratioInput.id = label.htmlFor;
      ratioInput.placeholder = '例如 16:9、2.35:1 或 人物-1'; ratioInput.maxLength = 80; ratioInput.autocomplete = 'off';
      const add = document.createElement('button'); add.type = 'button'; add.className = 'ratio-primary'; add.textContent = '添加并使用';
      add.addEventListener('click', addCustomRatio);
      form.append(ratioInput, add);
      const hint = document.createElement('p'); hint.style.marginTop = '8px';
      hint.textContent = '比例支持小数和等价匹配；名称按完整标签匹配，“人物-1”不会匹配到“人物-10”。名称预设也可选择人物。';
      const customTitle = document.createElement('h3'); customTitle.textContent = '当前预设（可选择或删除）';
      ratioList = document.createElement('div'); ratioList.className = 'ratio-custom-list';
      const feedback = document.createElement('div'); feedback.className = 'ratio-feedback';
      ratioError = document.createElement('div'); ratioError.setAttribute('role', 'alert');
      ratioStatus = document.createElement('div'); ratioStatus.setAttribute('role', 'status');
      feedback.append(ratioError, ratioStatus);
      const footer = document.createElement('div'); footer.className = 'ratio-footer';
      const done = document.createElement('button'); done.type = 'button'; done.textContent = '完成'; done.addEventListener('click', closeRatioSettings);
      footer.appendChild(done);
      ratioDialog.append(title, help, stockLabel, stockForm, label, form, hint, customTitle, ratioList, feedback, footer);
      ratioDialog.addEventListener('cancel', event => { event.preventDefault(); closeRatioSettings(); });
      ratioDialog.addEventListener('close', () => { if (previousRatioFocus && previousRatioFocus.isConnected) previousRatioFocus.focus(); });
      document.body.appendChild(ratioDialog);
    }

    function openRatioSettings() {
      closePresetPanel();
      if (!ratioDialog || !ratioDialog.isConnected) buildRatioDialog();
      if (ratioDialog.open) return;
      previousRatioFocus = document.activeElement;
      ratioInput.value = ''; ratioFeedback('', false); refreshRatioList();
      ratioDialog.showModal(); ratioInput.focus();
    }

    // 在 window 捕获阶段隔离弹窗，按钮获焦时 A/D/S/空格也不会触发业务快捷键。
    window.addEventListener('keydown', event => {
      const presetTarget = event.target && event.target.closest && event.target.closest(`#${RATIO_POPOVER_ID},#${RATIO_TRIGGER_ID}`);
      if (ratioPopover && !ratioPopover.hidden && event.key === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation(); closePresetPanel(true); return;
      }
      if (presetTarget && (!ratioPopover.hidden || ['ArrowDown', 'Enter', ' ', 'Tab'].includes(event.key))) {
        event.stopImmediatePropagation();
        if (presetTarget.id === RATIO_TRIGGER_ID && event.key === 'ArrowDown') {
          event.preventDefault(); openPresetPanel(true);
        }
        return;
      }
      if (!ratioDialog || !ratioDialog.open) return;
      event.stopImmediatePropagation();
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape') { event.preventDefault(); closeRatioSettings(); }
      else if (event.key === 'Enter' && event.target === ratioInput) { event.preventDefault(); addCustomRatio(); }
    }, true);

    function mountRatioControls(toolbar) {
      let controls = document.getElementById(RATIO_CONTROLS_ID);
      if (!controls) {
        controls = document.createElement('span'); controls.id = RATIO_CONTROLS_ID;
        controls.style.cssText = 'display:inline-flex;flex-wrap:wrap;align-items:center;gap:5px;margin-left:6px;max-width:100%;vertical-align:middle;font:12px/1 system-ui,-apple-system,"PingFang SC",sans-serif;white-space:nowrap;';
        const trigger = document.createElement('button'); trigger.id = RATIO_TRIGGER_ID; trigger.type = 'button';
        trigger.setAttribute('aria-label', '预设选择'); trigger.setAttribute('aria-expanded', 'false');
        trigger.setAttribute('aria-controls', RATIO_POPOVER_ID);
        const label = document.createElement('span'); label.textContent = '预设';
        const summary = document.createElement('span'); summary.className = 'preset-summary';
        const chevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        chevron.setAttribute('viewBox', '0 0 12 12'); chevron.setAttribute('aria-hidden', 'true');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'm3 4.5 3 3 3-3'); path.setAttribute('fill', 'none');
        path.setAttribute('stroke', 'currentColor'); path.setAttribute('stroke-width', '1.4');
        path.setAttribute('stroke-linecap', 'round'); path.setAttribute('stroke-linejoin', 'round');
        chevron.appendChild(path); trigger.append(label, summary, chevron);
        trigger.addEventListener('click', () => {
          if (ratioPopover.hidden) openPresetPanel(); else closePresetPanel();
        });
        for (const name of ['pointerdown', 'mousedown', 'click']) controls.addEventListener(name, event => event.stopPropagation());
        controls.appendChild(trigger);
      }
      if (controls.parentElement !== toolbar.quick) toolbar.quick.prepend(controls);
      if (!ratioPopover) {
        ratioPopover = document.createElement('div'); ratioPopover.id = RATIO_POPOVER_ID; ratioPopover.hidden = true;
        ratioPopover.setAttribute('role', 'region'); ratioPopover.setAttribute('aria-label', '选择预设');
        const heading = document.createElement('div'); heading.className = 'preset-heading';
        const title = document.createElement('span'); title.textContent = '选择预设';
        const count = document.createElement('span'); count.className = 'preset-count';
        heading.append(title, count);
        const hint = document.createElement('div'); hint.className = 'preset-hint'; hint.textContent = '拖动勾选 / 取消 · 自动保存';
        hint.title = '从已勾选项拖动可批量取消，从未勾选项拖动可批量勾选；Alt 拖动始终取消';
        const select = document.createElement('div'); select.id = RATIO_SELECT_ID;
        select.setAttribute('role', 'group'); select.setAttribute('aria-label', '预设选择');
        installPresetMarquee(select);
        ratioPopover.append(heading, hint, select);
      }
      if (!ratioPopover.isConnected) document.body.appendChild(ratioPopover);
      let manage = document.getElementById(RATIO_ACTIONS_ID);
      if (!manage) {
        manage = document.createElement('div'); manage.id = RATIO_ACTIONS_ID;
        const label = document.createElement('span'); label.textContent = '预设管理'; label.style.color = '#64748b';
        manage.appendChild(label);
      }
      const buttonStyle = 'height:24px;padding:0 8px;border:1px solid rgba(130,140,160,.45);border-radius:4px;background:transparent;color:#8a90a0;font:inherit;cursor:pointer;white-space:nowrap;';
      let button = document.getElementById(RATIO_SETTINGS_ID);
      if (!button) {
        button = document.createElement('button'); button.id = RATIO_SETTINGS_ID; button.type = 'button';
        button.textContent = '新增'; button.title = '新增比例或标签名称，并管理当前预设'; button.setAttribute('aria-label', '预设设置');
        button.style.cssText = buttonStyle;
        button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); openRatioSettings(); });
      }
      let remove = document.getElementById(RATIO_DELETE_ID);
      if (!remove) {
        remove = document.createElement('button'); remove.id = RATIO_DELETE_ID; remove.type = 'button';
        remove.textContent = '删除'; remove.setAttribute('aria-label', '删除当前预设');
        remove.style.cssText = buttonStyle;
        remove.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); removeRatio(selectedRatio); });
      }
      if (button.parentElement !== manage) manage.appendChild(button);
      if (remove.parentElement !== manage) manage.appendChild(remove);
      if (manage.parentElement !== toolbar.presets) toolbar.presets.appendChild(manage);
      updateRatioControls();
    }

    /* ---- 在独立操作行挂载切换按钮 ---- */
    function makeModeButton() {
      const btn = document.createElement('button');
      btn.id = MODE_BTN_ID;
      btn.type = 'button';
      btn.style.cssText = `
        height: 24px; padding: 0 10px; margin-left: 6px;
        border: 1px solid rgba(130,140,160,.45);
        background: transparent; color: #8a90a0;
        border-radius: 4px; outline: none; cursor: pointer;
        font: 12px/1 system-ui,-apple-system,"Segoe UI","PingFang SC",sans-serif;
        vertical-align: middle; white-space: nowrap;
        transition: background .12s, color .12s, border-color .12s;
      `;
      btn.addEventListener('mouseenter', () => {
        btn.style.borderColor = 'rgba(130,140,160,.85)';
        btn.style.color = '#c0c6d0';
      });
      btn.addEventListener('mouseleave', () => {
        btn.style.borderColor = 'rgba(130,140,160,.45)';
        btn.style.color = '#8a90a0';
      });
      btn.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        switchMode(1);
      });
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      btn.addEventListener('pointerdown', (e) => e.stopPropagation());
      return btn;
    }

    function mountModeButton() {
      const toolbar = ensureOutlinerToolbar();
      if (!toolbar) return null;
      const box = toolbar.actions;
      let btn = document.getElementById(MODE_BTN_ID);
      if (!btn) btn = makeModeButton();
      if (box.firstElementChild !== btn) {
        try { box.prepend(btn); } catch (e) {}
      }
      mountRatioControls(toolbar);
      editing.mount(box);
      updateModeButton();
      return btn;
    }

    /* ---- 防抖同步：挂载按钮 + 同步索引 + 刷新文案（幂等，无 DOM 空转） ---- */
    let syncTimer = null;
    function scheduleSync(mutations) {
      for (const mutation of mutations || []) {
        if (mutation.type === 'attributes' && mutation.attributeName === 'class') continue;
        // React 可能先离线改写旧行，再重用同一节点；重挂载也必须清除比例缓存。
        for (const node of mutation.addedNodes || []) {
          if (node.nodeType !== 1) continue;
          if (node.matches('.lsf-outliner-item')) ratioCache.delete(node);
          for (const item of node.querySelectorAll('.lsf-outliner-item')) ratioCache.delete(item);
        }
        const element = mutation.target.nodeType === 1 ? mutation.target : mutation.target.parentElement;
        const item = element && element.closest('.lsf-outliner-item');
        if (item) ratioCache.delete(item);
      }
      if (syncTimer) return;
      syncTimer = setTimeout(() => {
        syncTimer = null;
        // 1. 确保独立工具栏随 Regions 面板重建，并维持控件分组。
        const toolbar = ensureOutlinerToolbar();
        if (toolbar) {
          const btn = document.getElementById(MODE_BTN_ID);
          const ratios = document.getElementById(RATIO_CONTROLS_ID);
          const manage = document.getElementById(RATIO_ACTIONS_ID);
          if (!btn || !btn.isConnected || btn.parentElement !== toolbar.actions || !ratios || ratios.parentElement !== toolbar.quick ||
              !manage || manage.parentElement !== toolbar.presets || !document.getElementById(RATIO_SETTINGS_ID) || !document.getElementById(RATIO_DELETE_ID)) {
            mountModeButton();
          }
        }
        // 2. 同步索引
        syncManual();
        // 3. 刷新按钮文案（内部比较，不会产生无意义 DOM 写入）
        updateModeButton();
        editing.mount(toolbar && toolbar.actions);
      }, 120);
    }

    function fireUpdate() {
      const nd = document.querySelector('#lil-gui-name-11');
      if (nd) { const b = nd.closest('button'); if (b && !b.disabled) { b.click(); return; } }
      for (const s of ['[data-testid="update-annotation"]', '[data-qa="update-annotation"]',
        'button[aria-label*="Update" i]', 'button[aria-label*="更新" i]']) {
        const b = document.querySelector(s);
        if (b && !b.disabled && b.getClientRects().length > 0) { b.click(); return; }
      }
      for (const b of document.querySelectorAll('button')) {
        if (b.disabled) continue;
        const a = (b.getAttribute('aria-label') || '').toLowerCase();
        const t = (b.textContent || '').toLowerCase();
        if (!a.includes('update') && !t.includes('更新') && !t.includes('update')) continue;
        if (a.includes('draft') || t.includes('草稿') || t.includes('draft')) continue;
        if (a.includes('submit') || t.includes('提交')) continue;
        b.click(); return;
      }
    }

    document.addEventListener('click', function(e) {
      if (!e.target || !e.target.closest) return;
      const item = e.target.closest('.lsf-outliner-item');
      if (!item) { queueMicrotask(() => syncManual()); return; }
      if (!matchMode(item)) return;
      const av = getAvail();
      if (av.includes(item)) rememberNavigation(item, av);
    }, true);

    // 键盘统一由模块6处理，改绑后不再保留旧的固定监听。

    function boot() {
      syncManual();
      mountModeButton();
      if (!document.body) return;
      new MutationObserver(scheduleSync).observe(document.body, {
        childList: true, subtree: true, characterData: true,
        attributes: true, attributeFilter: [...RATIO_ATTRS, 'class'],
      });
    }
    if (document.readyState === 'complete' || document.readyState === 'interactive') boot();
    else document.addEventListener('DOMContentLoaded', boot);

    window.__OUTLINER = {
      modes: () => MODES.map(m => ({ id: m.id, label: m.label })),
      mode: () => currentMode().id,
      setMode,
      toggle: () => switchMode(1).id,
      next,
      prev,
      update: fireUpdate,
      count: () => getAvail().length,
      mountButton: mountModeButton,
      refreshButton: updateModeButton,
      rememberSelection: syncManual,
      openRatioSettings,
      ratios: () => ({ selected: selectedRatio, presets: PRESET_RATIOS.filter(ratio => !removedPresetKeys.has(ratio.key)).map(ratio => ({ ...ratio })), custom: customRatios.map(ratio => ({ ...ratio })), removed: [...removedPresetKeys], multiple: [...selectedMultiple] }),
      resetSavedMode: () => { try { localStorage.removeItem(STORAGE_KEY); showToast('已清除已保存的模式，刷新后恢复默认', 2000); } catch (e) {} },
    };

    console.log(`[Outliner] 模式切换已就绪：工具栏按钮及可自定义快捷键；当前模式：${currentMode().label}（已持久化）`);
  })();

  /* ============================================================
   *  模块 2：可用性 单/多 快捷按钮（保持原样）
   * ============================================================ */
  (function moduleUDBtn() {
    const CFG = { availKeyword: '可用', singleLabel: '单人构图', dualLabel: '多人构图',
      btnSingle: '单', btnDual: '多', toggleOff: true, intentTTL: 250, unlockDelay: 120 };
    const STYLE_ID = '__udbtn_style';
    const CLS_TOGGLE = 'ud-toggle';
    const CLS_BTN = 'ud-btn';
    const nameCache = new WeakMap();
    let labelIndex = new Map();
    let indexReady = false;
    let selfMutating = 0;
    const intentMap = new WeakMap();

    function getIntent(g) {
      if (!g) return null;
      const s = intentMap.get(g);
      if (!s) return null;
      if (Date.now() - s.ts > CFG.intentTTL) return null;
      return s;
    }
    function setIntent(g, sOn, dOn, name) {
      if (!g) return;
      intentMap.set(g, { singleOn: !!sOn, dualOn: !!dOn, availName: name || null, ts: Date.now() });
    }

    function injectStyle() {
      if (document.getElementById(STYLE_ID)) return;
      const st = document.createElement('style');
      st.id = STYLE_ID;
      st.textContent = `
        .${CLS_TOGGLE}{display:inline-flex;gap:3px;margin-left:6px;vertical-align:middle;align-items:center}
        .${CLS_BTN}{font:11px/1 system-ui,-apple-system,"Segoe UI",sans-serif;
          padding:0 8px;height:18px;display:inline-flex;align-items:center;
          border:1px solid rgba(130,140,160,.4);background:transparent;color:#8a90a0;
          border-radius:9px;cursor:pointer;outline:none;
          transition:background .08s,color .08s,border-color .08s}
        .${CLS_BTN}:hover{border-color:rgba(130,140,160,.75);color:#c0c6d0}
        .${CLS_BTN}.active{background:#4c8bf5;border-color:#4c8bf5;color:#fff}
        .${CLS_BTN}[data-v="dual"].active{background:#f5a623;border-color:#f5a623;color:#fff}
      `;
      (document.head || document.documentElement).appendChild(st);
    }

    function getInput(choice) {
      if (!choice) return null;
      return choice.querySelector('input.ant-checkbox-input') || choice.querySelector('input.ant-radio-input') ||
             choice.querySelector('input[type="checkbox"]') || choice.querySelector('input[type="radio"]');
    }

    function computeName(choice) {
      let txt = '';
      const stack = [choice];
      while (stack.length) {
        const n = stack.pop();
        if (n.nodeType === 3) { txt += ' ' + n.nodeValue; continue; }
        if (n.nodeType !== 1) continue;
        const cl = n.classList;
        if (cl && (cl.contains(CLS_TOGGLE) || cl.contains('__Cici__translate__') || cl.contains('lsf-hint'))) continue;
        if (n.tagName === 'SUP') continue;
        let c = n.firstChild;
        while (c) { stack.push(c); c = c.nextSibling; }
      }
      return txt.replace(/\s+/g, ' ').trim();
    }

    function getName(choice) {
      if (!choice) return '';
      let n = nameCache.get(choice);
      if (n !== undefined) return n;
      const i = getInput(choice);
      n = (i && i.getAttribute('name')) || computeName(choice);
      nameCache.set(choice, n);
      return n;
    }

    function rebuildIndex() {
      labelIndex = new Map();
      const all = document.querySelectorAll('.lsf-choice');
      for (let i = 0; i < all.length; i++) {
        const c = all[i];
        const n = getName(c);
        if (n && !labelIndex.has(n)) labelIndex.set(n, c);
      }
      indexReady = true;
    }

    function findChoice(label) {
      if (!indexReady) rebuildIndex();
      const e = labelIndex.get(label);
      if (e && e.isConnected) return e;
      for (const [n, el] of labelIndex) if (n.indexOf(label) !== -1 && el.isConnected) return el;
      rebuildIndex();
      const e2 = labelIndex.get(label);
      if (e2 && e2.isConnected) return e2;
      for (const [n, el] of labelIndex) if (n.indexOf(label) !== -1 && el.isConnected) return el;
      return null;
    }

    function setChecked(input, on) {
      if (!input) return;
      const want = !!on;
      if (input.checked === want) return;
      const prev = input.checked;
      try { input.click(); } catch (e) {}
      if (input.checked === want) return;
      try {
        input.checked = want;
        if (input._valueTracker && typeof input._valueTracker.setValue === 'function') input._valueTracker.setValue(prev);
        input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
        input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
      } catch (e) { try { input.checked = want; } catch (err) {} }
    }

    function applyOptimistic(choice, sOn, dOn, curOn) {
      document.querySelectorAll('.' + CLS_TOGGLE).forEach((box) => {
        const c = box.closest('.lsf-choice');
        if (!c) return;
        const isThis = c === choice;
        let thisOn;
        if (isThis) thisOn = curOn;
        else { const i = getInput(c); thisOn = !!(i && i.checked); }
        box.querySelectorAll('.' + CLS_BTN).forEach((btn) => {
          const v = btn.dataset.v;
          const on = thisOn && ((v === 'single' && sOn) || (v === 'dual' && dOn));
          btn.classList.toggle('active', on);
        });
      });
    }

    function handleClick(choice, kind) {
      const g = choice.closest('.lsf-choices');
      const cn = getName(choice);
      const intent = getIntent(g);
      let already = false;
      if (intent && intent.availName === cn) {
        already = (kind === 'single' && intent.singleOn) || (kind === 'dual' && intent.dualOn);
      } else {
        const ci = getInput(choice);
        const cOn = !!(ci && ci.checked);
        const s = findChoice(CFG.singleLabel);
        const d = findChoice(CFG.dualLabel);
        const sOn = !!(s && getInput(s) && getInput(s).checked);
        const dOn = !!(d && getInput(d) && getInput(d).checked);
        already = cOn && ((kind === 'single' && sOn) || (kind === 'dual' && dOn));
      }
      let tCur, tS, tD;
      if (already && CFG.toggleOff) {
        tCur = false;
        if (intent && intent.availName === cn) { tS = intent.singleOn; tD = intent.dualOn; }
        else {
          const s = findChoice(CFG.singleLabel);
          const d = findChoice(CFG.dualLabel);
          tS = !!(s && getInput(s) && getInput(s).checked);
          tD = !!(d && getInput(d) && getInput(d).checked);
        }
      } else if (kind === 'single') { tCur = true; tS = true; tD = false; }
      else { tCur = true; tS = false; tD = true; }

      setIntent(g, tS, tD, tCur ? cn : null);
      applyOptimistic(choice, tS, tD, tCur);
      const s = findChoice(CFG.singleLabel);
      const d = findChoice(CFG.dualLabel);
      selfMutating++;
      try {
        setChecked(s ? getInput(s) : null, tS);
        setChecked(d ? getInput(d) : null, tD);
        setChecked(getInput(choice), tCur);
      } catch (e) {}
      setTimeout(() => { selfMutating = Math.max(0, selfMutating - 1); }, CFG.unlockDelay);
    }

    function makeToggle(choice, name) {
      const box = document.createElement('span');
      box.className = CLS_TOGGLE;
      box.dataset.name = name;
      const bS = document.createElement('button');
      bS.type = 'button'; bS.className = CLS_BTN; bS.dataset.v = 'single';
      bS.textContent = CFG.btnSingle; bS.title = CFG.singleLabel + ' + 此可用性';
      const bD = document.createElement('button');
      bD.type = 'button'; bD.className = CLS_BTN; bD.dataset.v = 'dual';
      bD.textContent = CFG.btnDual; bD.title = CFG.dualLabel + ' + 此可用性';
      box.appendChild(bS); box.appendChild(bD);
      const swallow = (e) => e.stopPropagation();
      ['pointerdown', 'mousedown', 'mouseup', 'touchstart', 'touchend'].forEach(ev => box.addEventListener(ev, swallow, true));
      [bS, bD].forEach(btn => {
        btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); handleClick(choice, btn.dataset.v); });
        btn.addEventListener('mousedown', (e) => e.preventDefault());
      });
      return box;
    }

    function processGroup(group) {
      const choices = group.querySelectorAll('.lsf-choice');
      if (!choices.length) return;
      let hasAvail = false;
      for (let i = 0; i < choices.length; i++) if (getName(choices[i]).indexOf(CFG.availKeyword) !== -1) { hasAvail = true; break; }
      if (!hasAvail) return;
      for (let i = 0; i < choices.length; i++) {
        const c = choices[i];
        if (getName(c).indexOf(CFG.availKeyword) === -1) continue;
        const wrapper = c.querySelector('label.ant-checkbox-wrapper') || c.querySelector('.lsf-choice__item') || c;
        if (wrapper.querySelector('.' + CLS_TOGGLE)) continue;
        wrapper.appendChild(makeToggle(c, getName(c)));
      }
    }

    let refreshPending = false;
    function refreshAll() {
      if (refreshPending) return;
      refreshPending = true;
      requestAnimationFrame(() => {
        refreshPending = false;
        if (selfMutating > 0) return;
        document.querySelectorAll('.' + CLS_TOGGLE).forEach((box) => {
          const choice = box.closest('.lsf-choice');
          if (!choice) return;
          const ci = getInput(choice);
          const cOn = !!(ci && ci.checked);
          const g = choice.closest('.lsf-choices');
          const intent = getIntent(g);
          let sOn, dOn;
          if (intent) { sOn = intent.singleOn; dOn = intent.dualOn; }
          else {
            const s = findChoice(CFG.singleLabel);
            const d = findChoice(CFG.dualLabel);
            sOn = !!(s && getInput(s) && getInput(s).checked);
            dOn = !!(d && getInput(d) && getInput(d).checked);
          }
          box.querySelectorAll('.' + CLS_BTN).forEach(btn => {
            const v = btn.dataset.v;
            const on = cOn && ((v === 'single' && sOn) || (v === 'dual' && dOn));
            btn.classList.toggle('active', on);
          });
        });
      });
    }

    function scan(root) {
      root = root || document;
      if (root.nodeType === 1 && root.classList && root.classList.contains('lsf-choices')) processGroup(root);
      if (root.querySelectorAll) {
        const groups = root.querySelectorAll('.lsf-choices');
        for (let i = 0; i < groups.length; i++) processGroup(groups[i]);
      }
    }

    let scanTimer = null;
    function scheduleScan() {
      if (scanTimer) return;
      scanTimer = setTimeout(() => { scanTimer = null; scan(document); indexReady = false; refreshAll(); }, 150);
    }

    function start() {
      if (!document.body) return;
      injectStyle();
      scan(document);
      rebuildIndex();
      refreshAll();
      new MutationObserver((muts) => {
        for (let i = 0; i < muts.length; i++) {
          if (muts[i].addedNodes && muts[i].addedNodes.length) { indexReady = false; scheduleScan(); return; }
        }
      }).observe(document.body, { childList: true, subtree: true });
      document.addEventListener('change', (e) => {
        const t = e.target;
        if (t && t.matches && t.matches('input.ant-checkbox-input,input.ant-radio-input,input[type="checkbox"],input[type="radio"]')) {
          if (selfMutating > 0) return;
          refreshAll();
        }
      }, true);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();

    window.__UDBTN = {
      config: CFG,
      scan: () => { indexReady = false; scan(document); },
      refresh: refreshAll,
      state() {
        const s = findChoice(CFG.singleLabel);
        const d = findChoice(CFG.dualLabel);
        const out = {
          single: !!(s && getInput(s) && getInput(s).checked),
          dual: !!(d && getInput(d) && getInput(d).checked),
          selfMutating, avail: {},
        };
        document.querySelectorAll('.' + CLS_TOGGLE).forEach(box => {
          const c = box.closest('.lsf-choice');
          const i = c && getInput(c);
          if (i && i.checked) out.avail[box.dataset.name] = true;
        });
        return out;
      },
    };

    console.log('[可用性 单/多 按钮] v3.12.3 已加载');
  })();

  /* ============================================================
   *  模块 3：「清空标签」及「删除人物」按钮
   *  — 主流程：遍历所有 ID，逐个取消勾选（保留框）
   *  — 备选：deleteAll 删掉所有 region（控制台调）
   * ============================================================ */
  (function moduleClearTagsBtn() {

    const BTN_ID = '__clear_tags_btn';
    const ACTION_BAR_ID = '__label_actions_toolbar';
    const PERSON_BUTTONS = [
      { person: 1, id: '__delete_person_1_btn', label: '删除人物-1', title: '删除人物-1的框及ID1–ID6的框' },
      { person: 2, id: '__delete_person_2_btn', label: '删除人物-2', title: '删除人物-2的框及ID7–ID12的框' },
    ];
    const INPUT_SEL = 'input.ant-checkbox-input, input.ant-radio-input, input[type="checkbox"], input[type="radio"]';
    const CFG = {
      AUTO_UPDATE: true,
      STEP_DELAY_ACTIVATE: 80,
      STEP_DELAY_UPDATE: 100,
      WAIT_TIMEOUT: 500,
      WAIT_INTERVAL: 25,
    };
    const MOUNT_SELECTORS = ['.lsf-labels.lsf-labels_inline', '.lsf-labels'];

    let btnEl = null;
    let currentMount = null;
    let batchRunning = false;
    let activeDeletePerson = null;

    function findStore() {
      if (window.Htx && window.Htx.annotationStore) return window.Htx;
      for (const key of ['__lsf', 'LS', 'labelStudio', '__store', 'lsf']) {
        try { const v = window[key]; if (v && v.annotationStore) return v; } catch (e) {}
      }
      return null;
    }

    function getAnnotation() {
      const s = findStore();
      if (s) {
        const as = s.annotationStore || s;
        const ann = as.selected || as.current;
        if (ann) return ann;
      }
      // 部分页面不暴露 Htx；Outliner 的原生 React item 同样指向当前 annotation。
      for (const item of document.querySelectorAll('.lsf-outliner, .lsf-outliner-item')) {
        let fiber = getReactFiber(item);
        for (let depth = 0; fiber && depth < 40; depth++, fiber = fiber.return) {
          try {
            const props = fiber.memoizedProps;
            const ann = props && (props.item && props.item.annotation || props.regions && props.regions.annotation);
            if (ann && ann.regionStore) return ann;
          } catch (e) {}
        }
      }
      return null;
    }

    function getRegions(ann) {
      if (!ann) return null;
      const regions = ann.regionStore && ann.regionStore.regions || ann.areas;
      if (!regions) return null;
      if (typeof regions.values === 'function') return Array.from(regions.values());
      if (typeof regions[Symbol.iterator] === 'function') return Array.from(regions);
      return null;
    }

    function personForRegion(region) {
      if (region.classification) return null;
      const labels = [];
      const add = values => {
        if (typeof values === 'string') labels.push(values);
        else if (values && typeof values[Symbol.iterator] === 'function') {
          for (const value of values) if (typeof value === 'string') labels.push(value);
        }
      };
      add(region.labels);
      add(region.labeling && region.labeling.mainValue);
      if (region.labelings) for (const result of region.labelings) add(result.mainValue);
      if (!labels.length) add(region.labelName);
      const groups = new Set();
      for (const label of labels) {
        const person = label.match(/^\s*人物\s*[-_－:：]?\s*(\d+)(?!\d)/);
        if (person && (Number(person[1]) === 1 || Number(person[1]) === 2)) groups.add(Number(person[1]));
        const id = label.match(/^\s*id\s*[-_－:：]?\s*(\d+)\b/i);
        const n = id ? Number(id[1]) : 0;
        if (n >= 1 && n <= 6) groups.add(1);
        else if (n >= 7 && n <= 12) groups.add(2);
      }
      // 一个框带有相互冲突的分组标签时，不擅自选择其删除范围。
      return groups.size === 1 ? groups.values().next().value : null;
    }

    function deletionScope() {
      const s = findStore();
      return location.href + '|' + (s && s.task && s.task.id || '');
    }

    async function deletePerson(person) {
      if (person !== 1 && person !== 2) return;
      if (batchRunning) { showToast('正在批量处理中…'); return; }
      batchRunning = true;
      activeDeletePerson = person;
      setBtnState('running', '删除中…');
      let deleted = 0;
      try {
        const ann = getAnnotation(), initialScope = deletionScope();
        const regions = getRegions(ann);
        if (!regions) { showToast('无法读取当前标注的框，未执行删除', 2500); return; }
        if (typeof ann.isReadOnly === 'function' && ann.isReadOnly()) {
          showToast('当前标注为只读，无法删除', 2500); return;
        }
        // 先保存模型引用；从后向前删除，避免父框和左侧行号变化影响目标。
        const targets = regions.filter(region => personForRegion(region) === person).reverse();
        if (!targets.length) { showToast(`未找到人物-${person}及其对应ID的框`, 2500); return; }
        if (targets.some(region => typeof region.deleteRegion !== 'function')) {
          showToast('部分框没有可用的原生删除方法，未执行删除', 3000); return;
        }
        const stillCurrent = () => getAnnotation() === ann && deletionScope() === initialScope;
        let interrupted = false;
        for (let i = 0; i < targets.length; i++) {
          if (!stillCurrent()) { interrupted = true; break; }
          setBtnState('running', `删除中 ${i + 1}/${targets.length}`);
          const region = targets[i];
          const currentRegions = getRegions(ann) || [];
          if (!currentRegions.includes(region)) continue;
          if (personForRegion(region) !== person) continue;
          if (region.readonly === true || typeof region.isReadOnly === 'function' && region.isReadOnly()) continue;
          try {
            // 原生方法负责删除框、标签及相关关系；不直接移除页面 DOM。
            await region.deleteRegion();
            const started = Date.now();
            while (stillCurrent() && (getRegions(ann) || []).includes(region) && Date.now() - started < CFG.WAIT_TIMEOUT) {
              await sleep(CFG.WAIT_INTERVAL);
            }
            if (!stillCurrent()) { interrupted = true; break; }
            if (!(getRegions(ann) || []).includes(region)) deleted++;
          } catch (error) {
            console.warn(`[删除人物-${person}] 一个框未能删除：`, error);
          }
          await sleep(CFG.WAIT_INTERVAL);
        }
        if (!stillCurrent()) interrupted = true;
        if (interrupted) { showToast('任务或标注已切换，已停止本次删除', 3000); return; }
        if (deleted > 0 && CFG.AUTO_UPDATE) {
          fireUpdateButtonLocal();
          await sleep(CFG.STEP_DELAY_UPDATE);
        }
        const remaining = (getRegions(ann) || []).filter(region => personForRegion(region) === person).length;
        showToast(remaining ? `人物-${person}：已删除${deleted}个框，${remaining}个未删除` :
          `已删除人物-${person}及对应ID，共${deleted}个框`, 3000);
      } catch (error) {
        console.warn(`[删除人物-${person}] 本次操作停止：`, error);
        showToast(`删除停止，已删除${deleted}个框；请检查当前标注`, 3000);
      } finally {
        batchRunning = false;
        activeDeletePerson = null;
        setBtnState('idle', '清空标签');
      }
    }

    function countRegions() {
      const ann = getAnnotation();
      if (!ann) return 0;
      try {
        const rs = ann.regionStore && ann.regionStore.regions;
        if (!rs) return 0;
        if (typeof rs.size === 'number') return rs.size;
        if (typeof rs.length === 'number') return rs.length;
      } catch (e) {}
      return 0;
    }

    function fireUpdateButtonLocal() {
      const nd = document.querySelector('#lil-gui-name-11');
      if (nd) { const b = nd.closest('button'); if (b && !b.disabled) { b.click(); return true; } }
      for (const s of ['[data-testid="update-annotation"]', '[data-qa="update-annotation"]',
        'button[aria-label*="Update" i]', 'button[aria-label*="更新" i]']) {
        const b = document.querySelector(s);
        if (b && !b.disabled && b.getClientRects().length > 0) { b.click(); return true; }
      }
      for (const b of document.querySelectorAll('button')) {
        if (b.disabled) continue;
        const a = (b.getAttribute('aria-label') || '').toLowerCase();
        const t = (b.textContent || '').toLowerCase();
        if (!a.includes('update') && !t.includes('更新') && !t.includes('update')) continue;
        if (a.includes('draft') || t.includes('草稿') || t.includes('draft')) continue;
        if (a.includes('submit') || t.includes('提交')) continue;
        b.click(); return true;
      }
      return false;
    }

    /* ---- 判断 choice 是否勾选 ---- */
    function isChoiceChecked(choice) {
      if (!choice) return false;
      const i = choice.querySelector(INPUT_SEL);
      if (i && i.checked) return true;
      if (choice.querySelector('.ant-checkbox-checked, .ant-radio-checked')) return true;
      if (i && i.getAttribute('aria-checked') === 'true') return true;
      return false;
    }

    /* ---- 取消单个 choice 的勾选（不删 region） ---- */
    function uncheckChoice(choice) {
      if (!choice) return false;
      let any = false;
      choice.querySelectorAll(INPUT_SEL).forEach(i => {
        if (!i.checked) return;
        const prev = true;
        try { i.click(); } catch (e) {}
        if (!i.checked) { any = true; return; }
        try {
          i.checked = false;
          if (i._valueTracker && typeof i._valueTracker.setValue === 'function') i._valueTracker.setValue(prev);
          i.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
          i.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
          any = true;
        } catch (e) {}
      });
      if (!any) {
        const cv = choice.querySelector('.ant-checkbox-checked, .ant-radio-checked');
        if (cv) {
          const t = cv.querySelector('input') || choice.querySelector(INPUT_SEL) || cv;
          try { t.click(); any = true; } catch (e) {}
        }
      }
      return any;
    }

    /* ---- 清空当前 region 的所有勾选（不删 region） ---- */
    function clearCurrent() {
      const choices = document.querySelectorAll('.lsf-choice');
      let cleared = 0;
      choices.forEach(c => { if (isChoiceChecked(c) && uncheckChoice(c)) cleared++; });
      try { window.__UDBTN && window.__UDBTN.refresh && window.__UDBTN.refresh(); } catch (e) {}
      return cleared;
    }

    function activateItemForClear(item) {
      if (!item || !item.isConnected) return;
      item.scrollIntoView({ block: 'nearest' });
      ['mousedown', 'mouseup', 'click'].forEach(et => item.dispatchEvent(new MouseEvent(et, { bubbles: true, cancelable: true })));
    }

    function getChoicesSignature() {
      const choices = document.querySelectorAll('.lsf-choice');
      if (!choices.length) return '';
      const names = [];
      choices.forEach(c => {
        const t = c.querySelector('.lsf-choice__item, label') || c;
        names.push((t.textContent || '').trim().slice(0, 30));
      });
      return names.join('|');
    }

    async function waitForChoicesChange(prevSig, maxMs) {
      const t0 = Date.now();
      while (Date.now() - t0 < maxMs) {
        const sig = getChoicesSignature();
        if (sig && sig !== prevSig) return true;
        await sleep(CFG.WAIT_INTERVAL);
      }
      return false;
    }

    /* ---- 主流程：遍历所有 ID，逐个清空标签（保留框） ---- */
    async function clearAllTags() {
      if (batchRunning) { showToast('正在清空中…'); return; }
      batchRunning = true;
      setBtnState('running', '清空中...');

      const items = Array.from(document.querySelectorAll('.lsf-outliner-item'));
      if (!items.length) {
        batchRunning = false;
        setBtnState('idle', '清空标签');
        showToast('没有找到任何 ID 条目');
        return;
      }

      console.log(`[清标签] 开始遍历 ${items.length} 个 ID`);
      let totalCleared = 0;
      let touched = 0;

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        setBtnState('running', `${i + 1}/${items.length}`);
        if (!item.isConnected) continue;

        try {
          const prevSig = getChoicesSignature();
          activateItemForClear(item);
          await waitForChoicesChange(prevSig, CFG.WAIT_TIMEOUT);
          await sleep(CFG.STEP_DELAY_ACTIVATE);

          const cleared = clearCurrent();
          if (cleared > 0) {
            totalCleared += cleared;
            touched++;
            if (CFG.AUTO_UPDATE) {
              await sleep(30);
              fireUpdateButtonLocal();
              await sleep(CFG.STEP_DELAY_UPDATE);
            }
          } else {
            await sleep(30);
          }
        } catch (err) {
          console.warn(`[清标签] 第 ${i + 1} 项出错：`, err);
        }
      }

      batchRunning = false;
      setBtnState('idle', '清空标签');
      showToast(`已清空 ${touched}/${items.length} 个 ID（共 ${totalCleared} 个标签）`, 3500);
      console.log(`[清标签] 完成：${touched}/${items.length} 个 ID 有标签被清，共 ${totalCleared} 个标签`);
    }

    /* ---- 备选：一键删掉所有 region（会消失框） ---- */
    async function deleteAllRegions() {
      const ann = getAnnotation();
      if (!ann || typeof ann.deleteAllRegions !== 'function') {
        showToast('deleteAllRegions 不可用');
        return;
      }
      const before = countRegions();
      ann.deleteAllRegions();
      const after = countRegions();
      if (CFG.AUTO_UPDATE) {
        await sleep(150);
        fireUpdateButtonLocal();
        await sleep(200);
      }
      showToast(`已删除 ${before - after} 个 region`, 2500);
    }

    function onBtnClick(e) {
      e.preventDefault(); e.stopPropagation();
      if (batchRunning) { showToast('正在清空中…'); return; }
      clearAllTags();
    }

    function setBtnState(state, text) {
      const running = state === 'running';
      const buttons = [{ id: BTN_ID, label: '清空标签', person: null }, ...PERSON_BUTTONS];
      for (const entry of buttons) {
        const btn = document.getElementById(entry.id);
        if (!btn) continue;
        btn.disabled = running;
        btn.style.opacity = running ? '0.75' : '1';
        btn.style.cursor = running ? 'wait' : 'pointer';
        btn.style.background = running ? '#f78989' : '#f56c6c';
        btn.style.borderColor = running ? '#f78989' : '#f56c6c';
        const label = entry.person === activeDeletePerson ? text || entry.label : entry.label;
        if (btn.textContent !== label) btn.textContent = label;
      }
    }

    function pickLabelGroup() {
      for (const sel of MOUNT_SELECTORS) {
        for (const el of document.querySelectorAll(sel)) {
          if (el.closest('.lsf-outliner, .lsf-choice, dialog')) continue;
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) continue;
          // .lsf-labels_inline 在实际页面也用于单个比例标签，不能把按钮塞进 16:9。
          let group = el, parent = el.parentElement;
          for (let depth = 0; parent && depth < 4; depth++, parent = parent.parentElement) {
            if (parent.matches('main, body, html')) break;
            if (parent.matches('.lsf-labels') || parent.querySelectorAll('.lsf-labels').length > 1) {
              group = parent;
              break;
            }
          }
          return group;
        }
      }
      return null;
    }

    function pickMount() {
      const group = pickLabelGroup();
      if (!group || !group.parentElement) return null;
      let bar = document.getElementById(ACTION_BAR_ID);
      if (!bar) {
        bar = document.createElement('div'); bar.id = ACTION_BAR_ID;
        bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', '标签操作');
        bar.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:6px;box-sizing:border-box;max-width:100%;width:100%;flex:0 0 100%;clear:both;margin:10px 0 0;padding:0;';
        for (const name of ['pointerdown', 'mousedown', 'click']) bar.addEventListener(name, event => event.stopPropagation());
      }
      if (bar.parentElement !== group.parentElement || bar.previousElementSibling !== group) group.after(bar);
      return bar;
    }

    function applyBtnStyle(btn) {
      btn.style.cssText = `
        display:inline-flex;align-items:center;justify-content:center;
        height:24px;padding:0 10px;margin:0;
        border:1px solid #f56c6c;border-radius:11px;
        background:#f56c6c;color:#fff;
        font:12px/1 system-ui,-apple-system,"Segoe UI","PingFang SC",sans-serif;
        font-weight:500;cursor:pointer;outline:none;user-select:none;
        vertical-align:middle;transition:background .12s,border-color .12s,opacity .12s;
        box-sizing:border-box;white-space:nowrap;
      `;
      btn.addEventListener('mouseenter', () => { if (!btn.disabled) { btn.style.background = '#f78989'; btn.style.borderColor = '#f78989'; } });
      btn.addEventListener('mouseleave', () => { if (!btn.disabled) { btn.style.background = '#f56c6c'; btn.style.borderColor = '#f56c6c'; } });
    }

    function createButton() {
      if (!document.body) return null;
      const existing = document.getElementById(BTN_ID);
      if (existing && currentMount && existing.parentElement === currentMount && currentMount.isConnected) {
        btnEl = existing;
        mountPersonButtons(currentMount);
        return existing;
      }
      const mount = pickMount();
      if (!mount) return null;
      if (existing) { try { existing.parentElement.removeChild(existing); } catch (e) {} }
      const btn = document.createElement('button');
      btn.id = BTN_ID;
      btn.type = 'button';
      btn.textContent = '清空标签';
      btn.title = '清空所有 ID 的标签（保留矩形框）';
      applyBtnStyle(btn);
      btn.addEventListener('click', onBtnClick);
      btn.addEventListener('mousedown', (e) => e.stopPropagation());
      btn.addEventListener('pointerdown', (e) => e.stopPropagation());
      try { mount.appendChild(btn); } catch (e) { return null; }
      currentMount = mount;
      btnEl = btn;
      mountPersonButtons(mount);
      console.log(`[清标签按钮] 挂载到：${mount.className || mount.tagName}`);
      return btn;
    }

    function mountPersonButtons(mount) {
      let previous = document.getElementById(BTN_ID), created = false;
      if (!previous || previous.parentElement !== mount) return;
      for (const entry of PERSON_BUTTONS) {
        let btn = document.getElementById(entry.id);
        if (!btn) {
          btn = document.createElement('button');
          btn.id = entry.id; btn.type = 'button';
          btn.textContent = entry.label; btn.title = entry.title;
          applyBtnStyle(btn);
          btn.addEventListener('click', event => {
            event.preventDefault(); event.stopPropagation();
            deletePerson(entry.person);
          });
          btn.addEventListener('mousedown', event => event.stopPropagation());
          btn.addEventListener('pointerdown', event => event.stopPropagation());
          created = true;
        }
        if (btn.parentElement !== mount || btn.previousElementSibling !== previous) previous.insertAdjacentElement('afterend', btn);
        previous = btn;
      }
      if (created) setBtnState(batchRunning ? 'running' : 'idle', activeDeletePerson ? '删除中…' : batchRunning ? '清空中…' : '清空标签');
    }

    let watchTimer = null;
    function scheduleWatch() {
      if (watchTimer) return;
      watchTimer = setTimeout(() => {
        watchTimer = null;
        const btn = document.getElementById(BTN_ID);
        if (!btn) { btnEl = null; currentMount = null; createButton(); return; }
        const wanted = pickMount();
        if (wanted && btn.parentElement !== wanted) {
          try { wanted.appendChild(btn); currentMount = wanted; } catch (e) {}
        }
        if (wanted) mountPersonButtons(wanted);
      }, 120);
    }

    function watchMount() {
      createButton();
      if (!document.body) return;
      new MutationObserver(scheduleWatch).observe(document.body, { childList: true, subtree: true });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watchMount);
    else watchMount();

    let bootTries = 0;
    const bootTimer = setInterval(() => {
      const btn = document.getElementById(BTN_ID);
      const bar = document.getElementById(ACTION_BAR_ID);
      if (btn && bar && bar.isConnected && btn.parentElement === bar) { clearInterval(bootTimer); return; }
      bootTries++;
      if (bootTries > 40) { clearInterval(bootTimer); return; }
      createButton();
    }, 500);

    window.__CLEAR_TAGS = {
      clearAll: clearAllTags,
      deleteAll: deleteAllRegions,
      deletePerson,
      button: () => btnEl,
      mount: () => currentMount,
      remount: () => {
        const btn = document.getElementById(BTN_ID);
        if (btn) { try { btn.parentElement.removeChild(btn); } catch (e) {} }
        btnEl = null; currentMount = null;
        createButton();
        return currentMount;
      },
      isRunning: () => batchRunning,
      config: CFG,
      annotation: getAnnotation,
      regionCount: countRegions,
      probeSelect() {
        const ann = getAnnotation();
        if (!ann) { console.log('annotation 不存在'); return; }
        const candidates = [];
        let proto = Object.getPrototypeOf(ann);
        while (proto && proto !== Object.prototype) {
          Object.getOwnPropertyNames(proto).forEach(n => {
            if (/select|focus|active|current/i.test(n) && typeof ann[n] === 'function' && !candidates.includes(n)) {
              candidates.push(n);
            }
          });
          proto = Object.getPrototypeOf(proto);
        }
        console.log('可能用于切换 selected 的方法：', candidates);
        console.log('提示：如果有 setSelected / selectArea 之类，就能不通过 outliner 点击切换 region');
        return candidates;
      },
    };

    console.log('[标签操作] v3.12.3 已加载：清空标签 / 删除人物-1 / 删除人物-2 | 调试：window.__CLEAR_TAGS');
  })();

  /* ============================================================
   *  模块 4：拍摄角度、人物构图按相邻切换继承
   *  - 按标签 id-N 及实际切换顺序判断，忽略左侧行号
   *  - 当前 ID = 上一次选中 ID + 1 才同步；角度、构图均覆盖为来源集合
   *  - 来源为空时清除对应旧标签；手动修改不立即回填；批量操作时暂停
   * ============================================================ */
  (function moduleAngleInheritance() {
    const ANGLES = ['仰拍', '平拍', '俯拍'];
    const COMPOSITIONS = ['单人构图', '多人构图'];
    const GROUPS = [
      { key: 'angles', labels: ANGLES },
      { key: 'compositions', labels: COMPOSITIONS },
    ];
    const CFG = { settleMs: 100, pollMs: 50, waitMs: 1800 };
    let timer = null, generation = 0, current = null, transitionSource = null, writing = false;
    let result = 'idle';
    let historyPaused = false;

    function pauseForHistory() {
      generation++;
      historyPaused = true;
      transitionSource = null;
      current = null;
      result = 'paused-history';
      schedule();
    }

    function annotation() {
      for (const key of ['Htx', '__lsf', 'LS', 'labelStudio', '__store', 'lsf']) {
        try {
          const store = window[key];
          if (store && store.annotationStore) return store.annotationStore.selected || store.annotationStore.current || null;
        } catch (e) {}
      }
      return null;
    }

    function scope() {
      let task = '';
      try { task = window.Htx && window.Htx.task && window.Htx.task.id || ''; } catch (e) {}
      return location.href + '|' + task;
    }

    function regionFor(item) {
      let fiber = getReactFiber(item);
      for (let depth = 0; fiber && depth < 40; depth++, fiber = fiber.return) {
        try {
          const region = fiber.memoizedProps && fiber.memoizedProps.item;
          if (region && region.annotation) return region;
        } catch (e) {}
      }
      return null;
    }

    function regionChoices(region) {
      try {
        const results = region && region.results;
        if (!results || typeof results[Symbol.iterator] !== 'function') return null;
        const names = new Set();
        for (const result of results) {
          if (result.type && result.type !== 'choices') continue;
          const values = result.mainValue || result.value && result.value.choices;
          if (typeof values === 'string') names.add(values);
          else if (values && typeof values[Symbol.iterator] === 'function') {
            for (const name of values) if (typeof name === 'string') names.add(name);
          }
        }
        return names;
      } catch (e) { return null; }
    }

    function getRows(outliner) {
      let group = outliner;
      return Array.from(outliner.querySelectorAll('.lsf-outliner-item')).map(item => {
        const titleNode = item.querySelector('.lsf-outliner-item__title');
        const title = titleNode ? titleNode.textContent || '' : '';
        if (/^\s*人物/.test(title)) group = item;
        const id = title.match(/\bid\s*[-_：:]?\s*(\d+)\b/i);
        const region = regionFor(item), names = regionChoices(region);
        const compositions = COMPOSITIONS.filter(name => title.includes(name));
        return { item, group, region, id: id ? Number(id[1]) : null,
          angles: ANGLES.filter(name => names ? names.has(name) : title.includes(name)),
          compositions: names ? COMPOSITIONS.filter(name => names.has(name)) : compositions,
          known: { angles: true, compositions: names !== null || compositions.length > 0 } };
      });
    }

    function selected() {
      const active = Array.from(document.querySelectorAll('.lsf-outliner-item')).filter(item =>
        item.classList.contains('lsf-outliner-item_active') ||
        item.closest('.lsf-tree-treenode-selected, .lsf-tree-node-selected'));
      // 多选时无法确定 Choices 属于哪一个 region，不自动填写。
      if (active.length !== 1) return null;
      const item = active[0], outliner = item.closest('.lsf-outliner');
      if (!outliner) return null;
      const row = getRows(outliner).find(row => row.item === item);
      if (!row || !Number.isSafeInteger(row.id) || row.id < 1) return null;
      return { ...row, outliner, scope: scope(), annotation: annotation() || row.region && row.region.annotation || null };
    }

    function sameSelection(a, b) {
      return !!a && !!b && a.id === b.id && a.group === b.group &&
        sameContext(a, b);
    }

    function sameContext(a, b) {
      return a.outliner === b.outliner && a.scope === b.scope && a.annotation === b.annotation;
    }

    function clearing() {
      return !!(window.__CLEAR_TAGS && window.__CLEAR_TAGS.isRunning());
    }

    function sourceFor(target) {
      const previous = transitionSource;
      if (!target || !previous || !previous.item.isConnected ||
          target.id !== previous.id + 1 || !sameContext(previous, target)) return null;
      // 只读取刚刚离开的条目，不能从列表中另找一个被跳过的 ID 当来源。
      const row = getRows(previous.outliner).find(row => row.item === previous.item && row.id === previous.id);
      if (!row) return null;
      // 有些页面标题省略构图，且没有暴露 results；仅回退到离开前记录的原面板。
      for (const def of GROUPS) {
        const snapshot = previous.panels[def.key];
        if (!row.known[def.key] && snapshot) {
          row[def.key] = snapshot.values.slice();
          row.known[def.key] = true;
        }
      }
      return row;
    }

    function choiceName(choice, input) {
      const name = input.getAttribute('name');
      if (name) return name.trim();
      const clone = choice.cloneNode(true);
      clone.querySelectorAll('.lsf-hint, sup, .ud-toggle').forEach(node => node.remove());
      return (clone.textContent || '').replace(/\s+/g, '').trim();
    }

    function choicePanel(def) {
      const panels = [];
      document.querySelectorAll('.lsf-choices').forEach(group => {
        const inputs = new Map();
        group.querySelectorAll('.lsf-choice').forEach(choice => {
          const input = choice.querySelector('input[type="checkbox"], input[type="radio"]');
          if (!input || input.disabled || !input.getClientRects().length ||
              input.closest('[hidden], [aria-hidden="true"]')) return;
          const name = choiceName(choice, input);
          if (def.labels.includes(name)) inputs.set(name, input);
        });
        if (inputs.size === def.labels.length) panels.push(inputs);
      });
      return panels.length === 1 ? panels[0] : null;
    }

    function checkedValues(panel, def) {
      return def.labels.filter(name => panel.get(name).checked);
    }

    function equalValues(a, b) {
      return a.length === b.length && a.every((name, i) => name === b[i]);
    }

    function panelReady(row, def, panel) {
      const values = checkedValues(panel, def);
      if (row.known[def.key]) return equalValues(values, row[def.key]);
      if (current.panels[def.key]) return true;
      const before = current.before && current.before[def.key];
      // 没有原生结果时，等待输入节点或勾选状态实际切换，避免读取仍显示的上一 ID。
      return !before || def.labels.some(name => panel.get(name) !== before.inputs.get(name)) ||
        !equalValues(values, before.values);
    }

    function remember(row, def, panel) {
      if (sameSelection(current, row)) current.panels[def.key] = {
        inputs: panel, values: checkedValues(panel, def),
      };
    }

    function captureCurrent() {
      const row = selected();
      if (!sameSelection(current, row) || clearing()) return;
      for (const def of GROUPS) {
        const panel = choicePanel(def);
        if (panel && panelReady(row, def, panel)) remember(row, def, panel);
      }
    }

    function valid(target, token) {
      return token === generation && !historyPaused && !editing.drawing() && !clearing() && target.item.isConnected && sameSelection(target, selected());
    }

    function setChoiceChecked(input, checked, row) {
      if (input.type !== 'radio' || checked) { input.click(); return true; }
      // 已勾选的原生 radio 不触发 change；使用 Choice 的原生 action 取消并更新结果及历史。
      let fiber = getReactFiber(input.closest('.lsf-choice'));
      for (let depth = 0; fiber && depth < 40; depth++, fiber = fiber.return) {
        const choice = fiber.memoizedProps && fiber.memoizedProps.item;
        if (choice && choice.type === 'choice' && choice.annotation === row.annotation &&
            choice.sel === true && typeof choice.toggleSelected === 'function') {
          choice.toggleSelected();
          return true;
        }
      }
      return false;
    }

    async function inherit(target, token) {
      const started = Date.now();
      const pending = new Set(GROUPS), stable = new Map(), synchronized = [];
      result = 'waiting';
      await sleep(CFG.settleMs);
      while (pending.size && valid(target, token) && Date.now() - started < CFG.waitMs) {
        for (const def of pending) {
          if (!valid(target, token)) return;
          const live = selected(), source = sourceFor(live), key = def.key;
          if (!source) { result = 'no-source'; return; }
          if (current.cancelled.has(key) || !source.known[key]) {
            pending.delete(def);
            continue;
          }
          const panel = choicePanel(def);
          if (!panel || !panelReady(live, def, panel)) { stable.delete(def); continue; }
          remember(live, def, panel);
          const wanted = source[key].slice();
          if (equalValues(checkedValues(panel, def), wanted)) { pending.delete(def); continue; }
          if (!stable.has(def)) { stable.set(def, Date.now()); continue; }
          if (Date.now() - stable.get(def) < CFG.pollMs) continue;
          // 先取消目标多出的标签，再勾选来源标签，防止旧值残留或单选冲突。
          const changes = [
            ...def.labels.filter(name => panel.get(name).checked && !wanted.includes(name)),
            ...wanted,
          ];
          for (const name of changes) {
            if (!valid(target, token)) return;
            if (current.cancelled.has(key)) break;
            // 每次点击前重新找节点，兼容 React 在前一次点击后替换整个 Choices。
            const activePanel = choicePanel(def), rowBefore = selected();
            const input = activePanel && activePanel.get(name), checked = wanted.includes(name);
            if (!input || !input.isConnected || !panelReady(rowBefore, def, activePanel)) { result = 'panel-unavailable'; return; }
            if (input.checked === checked) continue;
            writing = true;
            try {
              if (!setChoiceChecked(input, checked, rowBefore)) { result = 'choice-unavailable'; return; }
            } finally { writing = false; }
            await sleep(CFG.pollMs);
            if (!valid(target, token)) return;
            if (current.cancelled.has(key)) break;
            const latest = choicePanel(def), row = selected();
            if (!latest || latest.get(name).checked !== checked || row.known[key] && row[key].includes(name) !== checked) {
              result = 'write-unconfirmed';
              console.warn('[标签继承] 原生点击尚未确认写入，已停止；请检查当前 ID。');
              return;
            }
            remember(row, def, latest);
          }
          if (!current.cancelled.has(key)) synchronized.push(`${key === 'angles' ? '角度' : '构图'}：${wanted.join('、') || '已清空'}`);
          pending.delete(def);
        }
        if (pending.size) await sleep(CFG.pollMs);
      }
      if (!valid(target, token)) return;
      result = synchronized.length ? 'synchronized' : pending.size ? 'panel-timeout' : 'no-changes';
      if (synchronized.length) showToast(`id-${transitionSource.id} → id-${target.id} · ${synchronized.join('；')}`, 1500);
    }

    function sync() {
      timer = null;
      const next = selected();
      if (clearing() || historyPaused || editing.drawing()) {
        generation++;
        current = next && { ...next, panels: {}, before: null, cancelled: new Set() };
        transitionSource = null;
        result = clearing() ? 'paused-clear' : historyPaused ? 'paused-history' : 'paused-drawing';
        return;
      }
      if (sameSelection(current, next)) { captureCurrent(); return; }
      if (!current && !next) return;
      const previous = current;
      current = next && { ...next, panels: {}, cancelled: new Set(),
        before: previous && sameContext(previous, next) ? previous.panels : null };
      transitionSource = previous && next && sameContext(previous, next) &&
        next.id === previous.id + 1 ? previous : null;
      const token = ++generation;
      captureCurrent();
      if (!transitionSource) { result = 'not-consecutive'; return; }
      inherit(next, token).catch(error => {
        if (token !== generation) return;
        result = 'error';
        console.warn('[标签继承] 本次继承停止：', error);
      });
    }

    function schedule() {
      if (timer !== null) return;
      timer = setTimeout(sync, 25);
    }

    function start() {
      if (!document.body) return;
      new MutationObserver(schedule).observe(document.body, {
        childList: true, subtree: true, characterData: true,
        attributes: true, attributeFilter: ['class', 'checked', 'disabled'],
      });
      document.addEventListener('change', event => {
        if (writing) return;
        const input = event.target;
        if (!input || !input.matches || !input.matches('input[type="checkbox"], input[type="radio"]')) return;
        const choice = input.closest('.lsf-choice');
        const def = choice && GROUPS.find(def => def.labels.includes(choiceName(choice, input)));
        if (!def) return;
        // 用户手动修改某一类后，仅取消这类本次同步；另一类仍独立处理。
        sync();
        if (current) current.cancelled.add(def.key);
        queueMicrotask(captureCurrent);
        result = clearing() ? 'paused-clear' : `manual-${def.key}`;
      }, true);
      document.addEventListener('click', event => {
        const target = event.target && event.target.closest ? event.target : null;
        if (target && !target.closest('button,.lsf-outliner-item__controls') &&
            target.closest('.lsf-outliner-item,canvas,.konvajs-content,.lsf-image,.lsf-canvas,#canvas')) historyPaused = false;
        captureCurrent(); schedule();
      }, true);
      document.addEventListener('keydown', () => { captureCurrent(); schedule(); }, true);
      schedule();
    }

    window.__ANGLE_INHERIT = {
      version: '3.16.0',
      pauseForHistory,
      config: CFG,
      state() {
        const target = selected(), source = sourceFor(target);
        return { result, currentId: target && target.id, sourceId: source && source.id,
          sourceAngles: source ? source.angles.slice() : [],
          sourceCompositions: source ? source.compositions.slice() : [], clearing: clearing() };
      },
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
    console.log('[标签同步] v3.16.0 已加载：相邻 ID 连续切换时覆盖同步角度、构图');
  })();

  // 原生删除：固定本次选择，整组放进一条编辑历史，不依赖列表序号或显隐缓存。
  (function moduleRegionDeletion() {
    if (window.__REGION_DELETE) return;
    const BUTTON_ID = '__delete_selected_regions_btn', LOCK = '__ls_toolkit_delete_selected';
    let running = false, button = null, timer = null;
    const readOnly = node => !!node && (node.readonly === true || node.locked === true ||
      node.isReadOnly === true || typeof node.isReadOnly === 'function' && node.isReadOnly());
    function state() {
      const ann = editing.annotation(), all = editing.regions(ann);
      // 新版平台的多选保存在 annotation.selectedRegions；旧显隐脚本的共享接口可能只返回高亮项。
      const selected = ann?.selectedRegions;
      const targets = (selected?.length ? Array.from(selected).filter(r => all.includes(r)) :
        editing.selectedRegions(ann, all)).filter(r => !r.classification);
      let reason = '';
      if (running || window.__CLEAR_TAGS?.isRunning()) reason = '正在处理，请稍候';
      else if (!ann || !targets.length) reason = '先在列表或画布选中要删除的框';
      else if (readOnly(ann) || targets.some(readOnly)) reason = '选中项包含只读或锁定框';
      else if (editing.drawing(ann) || ann.history?.isFrozen) reason = '完成当前绘制或调整后再删除';
      else if (targets.some(r => typeof r.deleteRegion !== 'function')) reason = '选中项没有可用的原生删除方法';
      return { ann, targets, reason };
    }
    async function run() {
      const { ann, targets, reason } = state();
      if (reason) { showToast(reason); return 0; }
      window.__OUTLINER?.rememberSelection?.();
      const history = ann.history, route = location.href;
      let locked = false, deleted = 0;
      running = true;
      // 避免删框后标签同步把来源写到另一项上。
      window.__ANGLE_INHERIT?.pauseForHistory?.();
      refresh();
      try {
        if (history && typeof history.freeze === 'function' && typeof history.unfreeze === 'function') {
          history.freeze(LOCK); locked = true;
        }
        for (const region of targets.slice().reverse()) {
          if (editing.annotation() !== ann || location.href !== route) break;
          if (!editing.regions(ann).includes(region)) continue;
          await region.deleteRegion();
          if (!editing.regions(ann).includes(region)) deleted++;
        }
      } catch (error) {
        console.warn('[删除选中框]', error);
      } finally {
        try { if (locked) history.unfreeze(LOCK); }
        finally { running = false; editing.refresh(); refresh(); }
      }
      window.__SELECTED_VISIBILITY?.refresh();
      showToast(deleted ? `已删除 ${deleted} 个框，可用原生撤回恢复` : '框未删除，请检查平台状态', 2200);
      return deleted;
    }
    function refresh() {
      const toolbar = ensureOutlinerToolbar();
      if (!toolbar) return;
      if (!button) {
        button = document.createElement('button'); button.id = BUTTON_ID; button.type = 'button';
        button.setAttribute('aria-label', '删除选中框');
        button.style.cssText = 'height:24px;padding:0 9px;border:1px solid #edc3c3;border-radius:4px;background:#fff7f7;color:#bf4545;cursor:pointer;font:inherit;white-space:nowrap';
        button.addEventListener('mousedown', event => event.preventDefault());
        button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); run(); });
      }
      const copy = document.getElementById(BUTTON_ID);
      if (copy && copy !== button) copy.replaceWith(button);
      if (button.parentElement !== toolbar.actions) toolbar.actions.appendChild(button);
      const current = state(), label = current.targets.length > 1 ? `删除选中框 (${current.targets.length})` : '删除选中框';
      if (button.textContent !== label) button.textContent = label;
      if (button.disabled !== !!current.reason) button.disabled = !!current.reason;
      const key = window.__LS_SHORTCUTS?.hint('deleteSelected') || '';
      const title = current.reason || `删除当前选中的 ${current.targets.length} 个框${key ? ` · ${key}` : ''}，可原生撤回`;
      if (button.title !== title) button.title = title;
    }
    function schedule() {
      if (timer !== null) return;
      timer = setTimeout(() => { timer = null; refresh(); }, 80);
    }
    window.__REGION_DELETE = { run, refresh, isRunning: () => running,
      state: () => { const s = state(); return { count: s.targets.length, reason: s.reason, running }; } };
    function start() {
      refresh(); setInterval(refresh, 500);
      document.addEventListener('click', schedule, true);
      new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
  })();

  /* ============================================================
   *  模块 5：统一快捷键及可持久化的设置面板
   *  - 原生选项改绑后屏蔽旧键，使用原生 input.click()，避免触发两次
   *  - 编辑和输入法期间不触发；设置支持录制、清空、冲突检查及恢复默认
   * ============================================================ */
  (function moduleShortcuts() {
    const STORAGE_KEY = 'ls_toolkit_shortcuts_v1';
    const BUTTON_ID = '__shortcuts_settings_btn';
    const DIALOG_ID = '__shortcuts_dialog';
    const ACTIONS = [
      { id: 'previous', label: '上一个 ID', key: 'A', navigation: true, run: () => window.__OUTLINER.prev() },
      { id: 'next', label: '下一个 ID', key: 'D', navigation: true, run: () => window.__OUTLINER.next() },
      { id: 'nextAlt', label: '下一个 ID（备用）', key: 'Tab', navigation: true, run: () => window.__OUTLINER.next() },
      { id: 'mode', label: '切换 ID 模式', key: 'S', run: () => window.__OUTLINER.toggle() },
      { id: 'update', label: '更新 / 保存', key: 'Space', run: () => window.__OUTLINER.update() },
      { id: 'deleteSelected', label: '删除选中框', key: 'Shift+Delete', run: () => window.__REGION_DELETE.run() },
      ...[
        ['angleUp', '仰拍', 'Q'], ['angleLevel', '平拍', ''], ['angleDown', '俯拍', ''],
        ['single', '单人构图', ''], ['multiple', '多人构图', ''],
        ['available', '可用', ''], ['unavailable', '不可用', ''],
      ].map(([id, label, key]) => ({ id, label, key, choice: label })),
    ];
    const defaults = Object.fromEntries(ACTIONS.map(action => [action.id, action.key]));
    const nativeKeys = new Map(ACTIONS.filter(action => action.choice).map(action =>
      [action.id, new Set(action.key ? [action.key] : [])]));
    const NAMED_KEYS = ['Tab', 'Space', 'Enter', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
      'Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Minus', 'Equal', 'BracketLeft', 'BracketRight',
      'Backslash', 'Semicolon', 'Quote', 'Comma', 'Period', 'Slash', 'Backquote', 'Delete', 'Backspace'];
    let overrides = {}, draft = null, dialog = null, errorNode = null, timer = null;
    let previousFocus = null;
    const nativeHintDisplay = new WeakMap();
    const pageActions = new Map();
    let scanStatus = null, pageRows = null, searchInput = null;
    const allActions = () => [...ACTIONS, ...pageActions.values()];

    function baseKey(value) {
      if (typeof value !== 'string') return null;
      if (value === ' ' || /^(spacebar|space)$/i.test(value)) return 'Space';
      if (/^[a-z0-9]$/i.test(value)) return value.toUpperCase();
      if (/^f([1-9]|1\d|2[0-4])$/i.test(value)) return value.toUpperCase();
      return NAMED_KEYS.find(key => key.toLowerCase() === value.toLowerCase()) || null;
    }

    function canonical(value) {
      if (value === '') return '';
      if (typeof value !== 'string') return null;
      const parts = value.split('+').map(part => part.trim());
      const key = baseKey(parts.pop());
      if (!key) return null;
      const modifiers = new Set();
      for (const part of parts) {
        const name = ({ ctrl: 'Ctrl', control: 'Ctrl', alt: 'Alt', option: 'Alt',
          shift: 'Shift', meta: 'Meta', cmd: 'Meta', command: 'Meta' })[part.toLowerCase()];
        if (!name || modifiers.has(name)) return null;
        modifiers.add(name);
      }
      return [...['Ctrl', 'Alt', 'Shift', 'Meta'].filter(name => modifiers.has(name)), key].join('+');
    }

    function chordFor(event) {
      let key = baseKey(event.key);
      if (!key && NAMED_KEYS.includes(event.code)) key = event.code;
      if (!key && /^Digit\d$/.test(event.code || '')) key = event.code.slice(-1);
      if (!key) return null;
      return [event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift',
        event.metaKey && 'Meta', key].filter(Boolean).join('+');
    }

    function bindings() { return { ...defaults, ...overrides }; }

    const BUTTONS = 'button, [role="button"], input[type="button"], input[type="submit"], input[type="reset"]';
    const normalizeText = value => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    function visible(node) {
      if (!node?.isConnected || node.closest('dialog, .ant-modal, .lsf-panel-tabs__ghost-tab, [inert]')) return false;
      for (let parent = node; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (parent.hidden || parent.getAttribute('aria-hidden') === 'true' || style.display === 'none' ||
            ['hidden', 'collapse'].includes(style.visibility)) return false;
      }
      return !!node.getClientRects().length;
    }
    function nodeName(node, kind) {
      if (kind === 'choice') return choiceName(node.closest('.lsf-choice'), node);
      if (kind === 'label') return normalizeText(node.querySelector('.lsf-label__text')?.textContent || node.textContent);
      const labelled = (node.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
        .map(id => document.getElementById(id)?.textContent || '').join(' ');
      const direct = normalizeText(node.getAttribute('aria-label') || labelled);
      if (direct) return direct;
      if (node.tagName === 'INPUT') return normalizeText(node.value);
      const copy = node.cloneNode(true);
      copy.querySelectorAll('svg, .lsf-hint, .lsf-label__hotkey, sup').forEach(el => el.remove());
      return normalizeText(copy.textContent) || normalizeText(node.getAttribute('title'));
    }
    function groupName(node) {
      const choice = node.closest('.lsf-choice'), input = choice?.querySelector('input');
      if (input) return normalizeText(choiceName(choice, input));
      const group = node.closest('.lsf-choices, .lsf-labels, [role="toolbar"], section, fieldset, .ipm-panel');
      if (!group) return '';
      return normalizeText(group.getAttribute('aria-label') || group.querySelector('h2,h3,h4,h5,legend,.lsf-header')?.textContent);
    }
    function describe(node, kind) {
      const label = normalizeText(nodeName(node, kind));
      if (!label) return null;
      // 语义描述不使用 DOM 序号或缓存节点，重新渲染后仍按名称和分组查找。
      return { kind, label, group: groupName(node) };
    }
    const descriptorKey = value => JSON.stringify([value.kind, value.label, value.group]);
    function validDescriptor(value) {
      return value && ['button', 'label', 'choice'].includes(value.kind) &&
        typeof value.label === 'string' && value.label.length > 0 && value.label.length <= 160 &&
        typeof value.group === 'string' && value.group.length <= 160;
    }
    function pageId(descriptor) { return 'page:' + encodeURIComponent(descriptorKey(descriptor)); }
    function candidates() {
      const result = [];
      for (const node of document.querySelectorAll(BUTTONS)) {
        if (node.closest('.lsf-outliner-item, #__shortcuts_dialog, #__id_switch_header_controls') ||
            ['__delete_selected_regions_btn', '__outliner_mode_btn'].includes(node.id) || node.matches('[data-history-action]') ||
            ['上一个 ID', '下一个 ID'].includes(node.getAttribute('aria-label'))) continue;
        if (visible(node)) result.push([node, 'button']);
      }
      for (const node of document.querySelectorAll('.lsf-label.lsf-label_clickable, .lsf-label')) {
        if (!node.closest('.lsf-outliner-item') && visible(node)) result.push([node, 'label']);
      }
      for (const node of document.querySelectorAll('.lsf-choice input[type="checkbox"], .lsf-choice input[type="radio"]')) {
        const name = choiceName(node.closest('.lsf-choice'), node);
        if (!ACTIONS.some(action => action.choice === name) && visible(node.closest('.lsf-choice'))) result.push([node, 'choice']);
      }
      return result;
    }
    function disabled(node) {
      return node.disabled || node.matches(':disabled') || !!node.closest('[aria-disabled="true"]');
    }
    function ensurePageAction(descriptor) {
      const id = pageId(descriptor);
      if (!pageActions.has(id)) {
        pageActions.set(id, { id, label: descriptor.label, key: '', page: descriptor, matches: 0, available: 0 });
        defaults[id] = '';
      }
      return pageActions.get(id);
    }
    function scanPage() {
      for (const action of pageActions.values()) { action.matches = 0; action.available = 0; }
      for (const [node, kind] of candidates()) {
        const descriptor = describe(node, kind);
        if (!descriptor) continue;
        const action = ensurePageAction(descriptor);
        action.matches++; if (!disabled(node)) action.available++;
      }
      for (const [id, action] of pageActions) {
        if (!action.matches && !overrides[id] && !draft?.[id]) { pageActions.delete(id); delete defaults[id]; }
      }
      if (draft) for (const action of pageActions.values()) if (!(action.id in draft)) draft[action.id] = overrides[action.id] || '';
      renderPageRows();
      return Array.from(pageActions.values(), ({ id, label, page, matches, available }) => ({ id, label, group: page.group, matches, available }));
    }
    function clickPage(action) {
      const key = descriptorKey(action.page);
      const matches = candidates().filter(([node, kind]) => {
        const description = describe(node, kind);
        return description && descriptorKey(description) === key;
      }).map(([node]) => node);
      if (matches.length !== 1) {
        showToast(matches.length ? `“${action.label}”有多个同名目标，暂未执行` : `当前页面未找到“${action.label}”`); return;
      }
      if (disabled(matches[0])) { showToast(`“${action.label}”当前不可用`); return; }
      matches[0].click();
    }

    function conflict(config) {
      const used = new Map();
      for (const action of allActions()) {
        const chord = config[action.id];
        if (canonical(chord) !== chord) return `${action.label}的快捷键无效，请重新按键。`;
        if (!chord) continue;
        if (used.has(chord)) return `快捷键冲突：${used.get(chord)}和${action.label}都使用了 ${chord}。`;
        used.set(chord, action.label);
      }
      return '';
    }

    function load() {
      try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
        if (!saved || saved.version !== 1 || !saved.bindings || Array.isArray(saved.bindings)) return;
        const descriptors = Array.isArray(saved.pageActions) ? saved.pageActions.slice(0, 300) : [];
        const valid = descriptors.filter(validDescriptor);
        const candidate = {};
        for (const descriptor of valid) ensurePageAction(descriptor);
        for (const action of allActions()) {
          if (!Object.prototype.hasOwnProperty.call(saved.bindings, action.id)) continue;
          const value = canonical(saved.bindings[action.id]);
          if (value === null) return;
          candidate[action.id] = value;
        }
        if (!conflict({ ...defaults, ...candidate })) overrides = candidate;
      } catch (e) {}
    }

    function choiceName(choice, input) {
      const name = input.getAttribute('name');
      if (name) return name.trim();
      const clone = choice.cloneNode(true);
      clone.querySelectorAll('.lsf-hint, sup, .ud-toggle').forEach(node => node.remove());
      return (clone.textContent || '').replace(/\s+/g, '');
    }

    function discoverChoices() {
      let changed = false;
      for (const choice of document.querySelectorAll('.lsf-choice')) {
        const input = choice.querySelector('input[type="checkbox"], input[type="radio"]');
        if (!input) continue;
        const name = choiceName(choice, input), action = ACTIONS.find(action => action.choice === name);
        if (!action) continue;
        const found = [];
        for (const hint of choice.querySelectorAll('.lsf-hint:not(.ls-toolkit-custom-hint)')) {
          const text = (hint.textContent || '').trim().replace(/^\[/, '').replace(/\]$/, '');
          const chord = canonical(text);
          if (chord) found.push(chord);
        }
        if (!found.length) continue;
        nativeKeys.set(action.id, new Set(found));
        if (defaults[action.id] !== found[0]) { defaults[action.id] = found[0]; changed = true; }
      }
      if (changed && window.__OUTLINER) window.__OUTLINER.refreshButton();
    }

    function updateChoiceHints() {
      const config = bindings();
      for (const choice of document.querySelectorAll('.lsf-choice')) {
        const input = choice.querySelector('input[type="checkbox"], input[type="radio"]');
        if (!input) continue;
        const action = ACTIONS.find(action => action.choice === choiceName(choice, input));
        if (!action) continue;
        const changed = Object.prototype.hasOwnProperty.call(overrides, action.id);
        for (const hint of choice.querySelectorAll('.lsf-hint:not(.ls-toolkit-custom-hint)')) {
          if (!nativeHintDisplay.has(hint)) nativeHintDisplay.set(hint, hint.style.display);
          const display = changed ? 'none' : nativeHintDisplay.get(hint);
          if (hint.style.display !== display) hint.style.display = display;
        }
        let hint = choice.querySelector('.ls-toolkit-custom-hint');
        if (!changed) { if (hint) hint.remove(); continue; }
        if (!hint) {
          hint = document.createElement('sup'); hint.className = 'lsf-hint ls-toolkit-custom-hint';
          (input.closest('label') || choice).appendChild(hint);
        }
        const text = `[${config[action.id] || '未绑定'}]`;
        if (hint.textContent !== text) hint.textContent = text;
      }
    }

    function clickChoice(name) {
      const inputs = [];
      for (const choice of document.querySelectorAll('.lsf-choice')) {
        const input = choice.querySelector('input[type="checkbox"], input[type="radio"]');
        if (input && choiceName(choice, input) === name && !input.disabled && input.getClientRects().length &&
            !input.closest('[hidden], [aria-hidden="true"]')) inputs.push(input);
      }
      if (inputs.length === 1) inputs[0].click();
    }

    function mountButton() {
      const toolbar = ensureOutlinerToolbar();
      if (!toolbar) return;
      const box = toolbar.quick;
      let button = document.getElementById(BUTTON_ID);
      if (!button) {
        button = document.createElement('button');
        button.id = BUTTON_ID; button.type = 'button'; button.textContent = '快捷键设置';
        button.title = '自定义导航、删框、标签快捷键，自动发现页面按钮';
        button.style.cssText = 'height:24px;padding:0 10px;margin-left:6px;border:1px solid rgba(130,140,160,.45);background:transparent;color:#8a90a0;border-radius:4px;cursor:pointer;white-space:nowrap;font:12px/1 system-ui,-apple-system,"PingFang SC",sans-serif;';
        button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); openSettings(); });
      }
      if (button.parentElement !== box) box.appendChild(button);
    }

    function refreshFields() {
      if (!dialog || !draft) return;
      for (const input of dialog.querySelectorAll('[data-shortcut-id]')) input.value = draft[input.dataset.shortcutId] || '';
      for (const hint of dialog.querySelectorAll('[data-default-id]')) {
        hint.textContent = `默认：${defaults[hint.dataset.defaultId] || '未绑定'}`;
      }
      errorNode.textContent = '';
    }

    function actionRow(action) {
      const row = document.createElement('div'); row.className = 'shortcut-row';
      const label = document.createElement('label'); label.textContent = action.label;
      const input = document.createElement('input'); input.type = 'text'; input.readOnly = true;
      input.id = `__shortcut_${action.id}`; input.dataset.shortcutId = action.id; input.placeholder = '未绑定';
      input.title = '点击后按下快捷键；Backspace / Delete 清空';
      label.htmlFor = input.id;
      const clear = document.createElement('button'); clear.type = 'button'; clear.className = 'shortcut-clear';
      clear.textContent = '清除'; clear.setAttribute('aria-label', `清除${action.label}${action.page?.group ? `（${action.page.group}）` : ''}`);
      clear.addEventListener('click', () => { draft[action.id] = ''; refreshFields(); });
      const hint = document.createElement('small');
      hint.id = `__shortcut_hint_${action.id}`;
      input.setAttribute('aria-describedby', hint.id);
      if (action.page) {
        const status = action.matches > 1 ? `同名 ${action.matches} 个，暂不可执行` :
          !action.matches ? '当前页未找到' : !action.available ? '当前不可用' :
          ({ button: '页面按钮', label: '标注标签', choice: '标签选项' })[action.page.kind];
        hint.textContent = [action.page.group, status].filter(Boolean).join(' · ');
        if (action.matches !== 1 || !action.available) hint.className = 'shortcut-unavailable';
        row.dataset.pageActionId = action.id; label.title = hint.textContent;
      } else hint.dataset.defaultId = action.id;
      const description = document.createElement('div'); description.className = 'shortcut-description';
      description.append(label, hint);
      row.append(description, input, clear);
      return row;
    }

    function renderPageRows() {
      if (!pageRows) return;
      const filter = normalizeText(searchInput.value).toLocaleLowerCase();
      pageRows.replaceChildren();
      const actions = Array.from(pageActions.values()).filter(action =>
        `${action.label} ${action.page.group}`.toLocaleLowerCase().includes(filter));
      actions.sort((a, b) => Number(!!(draft?.[b.id] || overrides[b.id])) - Number(!!(draft?.[a.id] || overrides[a.id])));
      for (const action of actions) {
        const row = actionRow(action); row.querySelector('input').value = draft?.[action.id] || '';
        pageRows.appendChild(row);
      }
      const count = Array.from(pageActions.values()).filter(action => action.matches).length;
      scanStatus.textContent = `发现 ${count} 项 · 显示 ${actions.length} 项`;
      if (!actions.length) {
        const empty = document.createElement('p'); empty.className = 'shortcut-empty';
        empty.textContent = filter ? '没有匹配项，试试其他名称' : '当前页没有可识别的按钮或标签';
        pageRows.appendChild(empty);
      }
    }

    function closeSettings() {
      draft = null;
      dialog.close();
    }

    function saveSettings() {
      const problem = conflict(draft);
      if (problem) { errorNode.textContent = problem; return; }
      const candidate = {};
      for (const action of allActions()) if (draft[action.id] !== defaults[action.id]) candidate[action.id] = draft[action.id];
      const pageDescriptors = Array.from(pageActions.values()).filter(action => candidate[action.id]).map(action => action.page);
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, bindings: candidate, pageActions: pageDescriptors })); }
      catch (e) { errorNode.textContent = '浏览器未能保存设置，请检查此站点的存储权限。原快捷键仍然有效。'; return; }
      overrides = candidate;
      updateChoiceHints();
      window.__OUTLINER.refreshButton();
      window.__REGION_DELETE?.refresh();
      closeSettings();
      showToast('快捷键已保存并生效', 1600);
    }

    function buildDialog() {
      const style = document.createElement('style');
      style.textContent = `
        #${DIALOG_ID}{box-sizing:border-box;width:min(900px,calc(100vw - 32px));max-height:calc(100vh - 40px);
          max-height:calc(100dvh - 40px);margin:auto;padding:0;overflow:hidden;border:1px solid #d9e3ef;
          border-radius:14px;background:#fff;color:#30445e;box-shadow:0 20px 80px #152d4a33;
          font:13px/1.5 system-ui,-apple-system,"PingFang SC",sans-serif}
        #${DIALOG_ID}[open]{display:flex;flex-direction:column}
        #${DIALOG_ID} *,#${DIALOG_ID} *::before,#${DIALOG_ID} *::after{box-sizing:border-box}
        #${DIALOG_ID}::backdrop{background:#172c4666}
        #${DIALOG_ID} .shortcut-header{display:flex;align-items:flex-start;justify-content:space-between;
          gap:16px;padding:21px 24px 16px;flex:0 0 auto}
        #${DIALOG_ID} h2{margin:0 0 5px;font-size:19px;line-height:1.4;font-weight:650;color:#243a55}
        #${DIALOG_ID} p{margin:0;color:#8090a5;font-size:12px;line-height:1.65}
        #${DIALOG_ID} button{font:inherit;cursor:pointer;border:1px solid #d8e2ee;border-radius:6px;
          background:#fff;color:#566c88;padding:7px 12px;line-height:1.4;transition:background .12s,border-color .12s}
        #${DIALOG_ID} button:hover{border-color:#a8c5e7;background:#f2f7fe;color:#246bc1}
        #${DIALOG_ID} button:focus-visible{outline:2px solid #287ce4;outline-offset:2px}
        #${DIALOG_ID} .shortcut-close{display:grid;place-items:center;flex:0 0 30px;width:30px;height:30px;
          padding:0;border-color:transparent;background:#f4f7fb;color:#8393a8;font-size:23px;font-weight:300;line-height:1}
        #${DIALOG_ID} .shortcut-tips{display:flex;align-items:center;gap:6px 14px;flex-wrap:wrap;padding:0 24px 17px;
          color:#8b9aaf;font-size:11px;flex:0 0 auto}
        #${DIALOG_ID} kbd{font:11px/1.4 ui-monospace,monospace;padding:1px 4px;border:1px solid #dfe7f1;
          border-radius:4px;background:#f7f9fc;color:#67809e}
        #${DIALOG_ID} .shortcut-body{min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;
          padding:20px 24px;background:#f5f8fc;border-top:1px solid #e8eef5;border-bottom:1px solid #e8eef5}
        #${DIALOG_ID} .shortcut-core-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;align-items:start}
        #${DIALOG_ID} .shortcut-section{min-width:0;padding:16px;border:1px solid #e0e8f2;border-radius:9px;background:#fff}
        #${DIALOG_ID} .shortcut-section-heading{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:12px}
        #${DIALOG_ID} h3{font-size:13px;font-weight:650;margin:0;color:#3d5573}
        #${DIALOG_ID} .shortcut-section-count{font-size:10px;white-space:nowrap;color:#7e92ac;background:#f0f4f9;padding:2px 6px;border-radius:4px}
        #${DIALOG_ID} .shortcut-rows{display:grid;gap:0}
        #${DIALOG_ID} .shortcut-row{display:grid;grid-template-columns:minmax(0,1fr) 132px 34px;
          align-items:center;gap:8px;min-height:58px;padding:9px 0;border-top:1px solid #f0f3f8}
        #${DIALOG_ID} .shortcut-row:first-child{border-top:0;padding-top:3px}
        #${DIALOG_ID} .shortcut-description{min-width:0}
        #${DIALOG_ID} .shortcut-description label{display:block;color:#49617e;font-size:12px;font-weight:500;line-height:1.5;overflow-wrap:anywhere;cursor:pointer}
        #${DIALOG_ID} .shortcut-description small{display:block;margin-top:2px;font-size:10px;color:#94a3b7;line-height:1.5;overflow-wrap:anywhere}
        #${DIALOG_ID} input{width:100%;min-width:0;height:34px;border:1px solid #d5dfec;border-radius:6px;
          padding:5px 7px;background:#f8fafd;color:#355a87;font:600 12px/1.4 ui-monospace,monospace;text-align:center;cursor:pointer}
        #${DIALOG_ID} input::placeholder{font-weight:400;color:#acb8c9}
        #${DIALOG_ID} input:focus{outline:2px solid #84b3ed;outline-offset:1px;border-color:#82afe7;background:#fff}
        #${DIALOG_ID} .shortcut-clear{padding:4px 0;border-color:transparent;background:transparent;color:#99a8bb;font-size:11px;white-space:nowrap}
        #${DIALOG_ID} .shortcut-page-section{margin-top:16px}
        #${DIALOG_ID} .shortcut-page-summary{display:flex;align-items:center;gap:10px;cursor:pointer;list-style:none;user-select:none}
        #${DIALOG_ID} .shortcut-page-summary::-webkit-details-marker{display:none}
        #${DIALOG_ID} .shortcut-page-title{margin-right:auto;font-size:13px;font-weight:650;color:#3d5573}
        #${DIALOG_ID} .shortcut-page-summary::after{content:'';width:7px;height:7px;margin:0 3px 4px 1px;
          border-right:1.5px solid #91a3ba;border-bottom:1.5px solid #91a3ba;transform:rotate(45deg)}
        #${DIALOG_ID} .shortcut-page-section[open]>.shortcut-page-summary{margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid #edf1f6}
        #${DIALOG_ID} .shortcut-page-section[open]>.shortcut-page-summary::after{transform:rotate(225deg);margin-top:6px}
        #${DIALOG_ID} .shortcut-page-summary:focus-visible{outline:2px solid #287ce4;outline-offset:5px;border-radius:3px}
        #${DIALOG_ID} .shortcut-page-section>p{font-size:11px;margin-bottom:12px}
        #${DIALOG_ID} .shortcut-scan-tools{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:8px;margin-bottom:6px}
        #${DIALOG_ID} .shortcut-scan-tools input{font:12px/1.4 system-ui,-apple-system,"PingFang SC",sans-serif;text-align:left;cursor:text;background:#fff;padding:5px 11px}
        #${DIALOG_ID} .shortcut-scan-tools button{height:34px;font-size:12px;white-space:nowrap}
        #${DIALOG_ID} .shortcut-scan-tools small{grid-column:1/-1;color:#8fa0b6;font-size:10px;margin:1px 0 5px}
        #${DIALOG_ID} .shortcut-page-rows .shortcut-row{grid-template-columns:minmax(0,1fr) 168px 34px}
        #${DIALOG_ID} .shortcut-description .shortcut-unavailable{color:#b48d61}
        #${DIALOG_ID} .shortcut-empty{text-align:center;padding:24px 8px!important;color:#96a5b9}
        #${DIALOG_ID} .shortcut-bottom{flex:0 0 auto;padding:14px 24px;background:#fff}
        #${DIALOG_ID} [role=alert]{margin:0 0 12px;padding:9px 11px;border:1px solid #f0d6d3;border-radius:6px;
          background:#fff6f5;font-size:12px;color:#b4544c;overflow-wrap:anywhere}
        #${DIALOG_ID} [role=alert]:empty{display:none}
        #${DIALOG_ID} .shortcut-footer{display:flex;align-items:center;gap:9px}
        #${DIALOG_ID} .shortcut-reset{margin-right:auto}
        #${DIALOG_ID} .shortcut-save{background:#287ce4;border-color:#287ce4;color:#fff;padding-left:18px;padding-right:18px}
        #${DIALOG_ID} .shortcut-save:hover{background:#1e70d7;border-color:#1e70d7;color:#fff}
        @media(max-width:760px){
          #${DIALOG_ID}{width:calc(100vw - 24px);max-height:calc(100vh - 24px);max-height:calc(100dvh - 24px);border-radius:11px}
          #${DIALOG_ID} .shortcut-header{padding:17px 16px 12px}
          #${DIALOG_ID} .shortcut-tips{padding:0 16px 14px;gap:5px 12px;font-size:10px}
          #${DIALOG_ID} .shortcut-body{padding:14px}
          #${DIALOG_ID} .shortcut-core-grid{grid-template-columns:minmax(0,1fr);gap:12px}
          #${DIALOG_ID} .shortcut-section{padding:14px}
          #${DIALOG_ID} .shortcut-row,#${DIALOG_ID} .shortcut-page-rows .shortcut-row{grid-template-columns:minmax(0,1fr) 122px 30px;gap:6px}
          #${DIALOG_ID} .shortcut-bottom{padding:12px 14px}
          #${DIALOG_ID} .shortcut-footer{gap:7px}
          #${DIALOG_ID} .shortcut-footer button{padding:7px 10px;font-size:12px}
        }
        @media(prefers-reduced-motion:reduce){#${DIALOG_ID} *{transition:none!important}}
      `;
      document.head.appendChild(style);
      dialog = document.createElement('dialog'); dialog.id = DIALOG_ID;
      dialog.setAttribute('aria-labelledby', '__shortcuts_title');
      dialog.setAttribute('aria-describedby', '__shortcuts_help');
      const header = document.createElement('div'); header.className = 'shortcut-header';
      const intro = document.createElement('div');
      const title = document.createElement('h2'); title.id = '__shortcuts_title'; title.textContent = '快捷键设置';
      const help = document.createElement('p'); help.id = '__shortcuts_help';
      help.textContent = '点击按键框，按下新的快捷键。修改后点击保存。';
      intro.append(title, help);
      const close = document.createElement('button'); close.type = 'button'; close.className = 'shortcut-close';
      close.textContent = '×'; close.setAttribute('aria-label', '关闭快捷键设置'); close.addEventListener('click', closeSettings);
      header.append(intro, close);
      const tips = document.createElement('div'); tips.className = 'shortcut-tips';
      for (const [key, text] of [['Ctrl / ⌘ / Alt / Shift', '支持组合键'], ['Delete', '清空按键'], ['Esc', '取消修改']]) {
        const item = document.createElement('span'), badge = document.createElement('kbd'); badge.textContent = key;
        item.append(badge, ` ${text}`); tips.appendChild(item);
      }
      const body = document.createElement('div'); body.className = 'shortcut-body';
      const core = document.createElement('div'); core.className = 'shortcut-core-grid';
      for (const [id, text, actions] of [
        ['navigation', '导航与操作', ACTIONS.filter(action => !action.choice)],
        ['choices', '标签选择', ACTIONS.filter(action => action.choice)],
      ]) {
        const section = document.createElement('section'); section.className = 'shortcut-section';
        const heading = document.createElement('div'); heading.className = 'shortcut-section-heading';
        const name = document.createElement('h3'); name.id = `__shortcuts_${id}_title`; name.textContent = text;
        section.setAttribute('aria-labelledby', name.id);
        const count = document.createElement('span'); count.className = 'shortcut-section-count'; count.textContent = `${actions.length} 项`;
        heading.append(name, count);
        const rows = document.createElement('div'); rows.className = 'shortcut-rows';
        for (const action of actions) rows.appendChild(actionRow(action));
        section.append(heading, rows); core.appendChild(section);
      }
      const pageSection = document.createElement('details'); pageSection.className = 'shortcut-section shortcut-page-section';
      const pageHeading = document.createElement('summary'); pageHeading.className = 'shortcut-page-summary';
      const pageTitle = document.createElement('span'); pageTitle.className = 'shortcut-page-title'; pageTitle.textContent = '页面按钮与标签';
      pageTitle.id = '__shortcuts_page_title'; pageSection.setAttribute('aria-labelledby', pageTitle.id);
      const pageBadge = document.createElement('span'); pageBadge.className = 'shortcut-section-count'; pageBadge.textContent = '按需使用';
      pageHeading.append(pageTitle, pageBadge);
      const scanHelp = document.createElement('p'); scanHelp.textContent = '打开时自动扫描当前页面。搜索名称后录制按键，未绑定项不会触发操作。';
      const scanTools = document.createElement('div'); scanTools.className = 'shortcut-scan-tools';
      searchInput = document.createElement('input'); searchInput.type = 'search'; searchInput.placeholder = '搜索按钮或标签';
      searchInput.setAttribute('aria-label', '搜索页面按钮'); searchInput.addEventListener('input', renderPageRows);
      const rescan = document.createElement('button'); rescan.type = 'button'; rescan.textContent = '重新扫描';
      rescan.setAttribute('aria-label', '重新扫描页面按钮'); rescan.addEventListener('click', () => { scanPage(); refreshFields(); });
      scanStatus = document.createElement('small'); scanStatus.setAttribute('role', 'status');
      scanTools.append(searchInput, rescan, scanStatus);
      pageRows = document.createElement('div'); pageRows.className = 'shortcut-rows shortcut-page-rows';
      pageSection.append(pageHeading, scanHelp, scanTools, pageRows);
      body.append(core, pageSection);
      errorNode = document.createElement('div'); errorNode.setAttribute('role', 'alert');
      const footer = document.createElement('div'); footer.className = 'shortcut-footer';
      for (const [text, cls, run] of [
        ['恢复默认', 'shortcut-reset', () => { draft = { ...defaults }; refreshFields(); }],
        ['取消', '', closeSettings], ['保存快捷键', 'shortcut-save', saveSettings],
      ]) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = text; button.className = cls;
        button.addEventListener('click', run); footer.appendChild(button);
      }
      const bottom = document.createElement('div'); bottom.className = 'shortcut-bottom'; bottom.append(errorNode, footer);
      dialog.append(header, tips, body, bottom);
      dialog.addEventListener('cancel', event => { event.preventDefault(); closeSettings(); });
      dialog.addEventListener('close', () => { draft = null; if (previousFocus && previousFocus.isConnected) previousFocus.focus(); });
      document.body.appendChild(dialog);
    }

    function openSettings() {
      discoverChoices();
      if (!dialog || !dialog.isConnected) buildDialog();
      if (dialog.open) return;
      previousFocus = document.activeElement;
      dialog.querySelector('.shortcut-page-section').open = false;
      draft = bindings(); searchInput.value = ''; scanPage(); refreshFields(); dialog.showModal();
      dialog.querySelector('.shortcut-body').scrollTop = 0;
    }

    function editing(event) {
      return [event.target, document.activeElement].some(node => node && node.nodeType === 1 &&
        (node.isContentEditable || node.closest('input,textarea,select,[role="textbox"],[role="combobox"]')));
    }

    window.addEventListener('keydown', event => {
      if (event.isComposing || event.keyCode === 229 || ['Dead', 'Process', 'Unidentified'].includes(event.key)) return;
      if (dialog && dialog.open) {
        event.stopImmediatePropagation();
        if (event.key === 'Escape') { event.preventDefault(); closeSettings(); return; }
        const input = event.target && event.target.closest && event.target.closest('[data-shortcut-id]');
        if (!input) return;
        event.preventDefault();
        const clear = ['Backspace', 'Delete'].includes(event.key) && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey;
        const chord = clear ? '' : chordFor(event);
        if (chord !== null) { draft[input.dataset.shortcutId] = chord; refreshFields(); }
        return;
      }
      if (editing(event) || [event.target, document.activeElement].some(node =>
        node?.closest?.('dialog, .ant-modal, [role="dialog"]'))) return;
      const chord = chordFor(event);
      if (!chord) return;
      const config = bindings(), action = allActions().find(action => config[action.id] === chord);
      // 即使旧原生键不再绑定任何动作，也要拦截，避免页面继续勾选原标签。
      const oldNative = Array.from(nativeKeys).some(([id, keys]) => keys.has(chord) && config[id] !== chord);
      // 改绑后也拦截旧删框键，避免浏览器的 Shift+Delete 剪切再次触发平台删除。
      const oldDelete = chord === 'Shift+Delete' && config.deleteSelected !== chord;
      if (!action && !oldNative && !oldDelete) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (!action || event.repeat && !action.navigation) return;
      if (window.__CLEAR_TAGS && window.__CLEAR_TAGS.isRunning()) return;
      if (action.page) clickPage(action);
      else if (action.choice) clickChoice(action.choice);
      else action.run();
    }, true);

    function schedule() {
      if (timer !== null) return;
      timer = setTimeout(() => { timer = null; discoverChoices(); updateChoiceHints(); mountButton(); }, 120);
    }

    function start() {
      discoverChoices(); updateChoiceHints(); mountButton(); window.__OUTLINER.refreshButton();
      new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, characterData: true });
    }

    load();
    window.__LS_SHORTCUTS = {
      version: '3.18.0', open: openSettings, scan: scanPage,
      hint: id => bindings()[id] || '',
      state: () => ({ bindings: bindings(), defaults: { ...defaults }, overrides: { ...overrides },
        pageActions: Array.from(pageActions.values(), ({ id, label, page, matches, available }) => ({ id, label, group: page.group, matches, available })) }),
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
  })();

  console.log('[LabelStudio 工具集] v3.18.0 已加载');
})();
