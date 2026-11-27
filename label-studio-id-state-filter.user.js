// ==UserScript==
// @name         Label Studio 标注结果 + 多 ID + State 筛选
// @namespace    https://label.insta360.com/ls-id-state-filter
// @version      1.1.2
// @downloadURL  https://raw.githubusercontent.com/chengzi-1225/Insta360-chengzi/main/label-studio-id-state-filter.user.js
// @updateURL    https://raw.githubusercontent.com/chengzi-1225/Insta360-chengzi/main/label-studio-id-state-filter.user.js
// @description  仅增强原生筛选行：多 ID、State 中文多选、标注结果包含/不包含多选与长名称省略。优先读取项目配置并补全未勾选选项；配置不可用时最多读取 600 条任务去重。
// @match        *://label.insta360.com/*
// @match        https://label-test-internal.insta360.cn/*
// @run-at       document-start
// @sandbox      raw
// @grant        none
// @noframes
// ==/UserScript==

(function () {
  'use strict';
  if (window.__LS_ID_STATE_FILTER_LOADED__) return;
  window.__LS_ID_STATE_FILTER_LOADED__ = true;
  // A sample read must bypass this script's ID hooks and list-refresh tracking.
  const annotationRequest = window.fetch.bind(window);

  // 多 ID 模块立即启动，在页面初始化前安装请求拦截。
(function () {
  'use strict';

  if (window.__LS_MULTI_ID_LOADED__) return;
  window.__LS_MULTI_ID_LOADED__ = true;

  function getProjectIdFromUrl() {
    const m = location.pathname.match(/\/projects\/(\d+)/);
    if (m) return m[1];
    const q = new URLSearchParams(location.search).get('project');
    return q || '';
  }

  function lsfIcon(name) {
    // Lucide icon subset, ISC license. Copyright (c) Lucide Contributors.
    // Permission to use, copy, modify, and/or distribute this software for any
    // purpose with or without fee is hereby granted, provided that the above
    // copyright notice and this permission notice appear in all copies.
    // THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
    // WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
    // MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
    // ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
    // WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
    // ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
    // OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
    const nodes = {
      filter: '<path d="M3 6h18M7 12h10M10 18h4"/>',
      chevron: '<path d="m6 9 6 6 6-6"/>',
      hash: '<path d="M4 9h16M3 15h16M10 3 8 21M16 3l-2 18"/>',
      search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
      settings: '<path d="M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-3M14 20H3M14 2v4M8 10v4M18 18v4"/>',
      list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
      copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
      download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
      refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8M21 3v5h-5M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16M8 16H3v5"/>',
      stop: '<rect width="14" height="14" x="5" y="5" rx="2"/>',
      close: '<path d="m18 6-12 12M6 6l12 12"/>',
      check: '<path d="m9 11 3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
      left: '<path d="m15 18-6-6 6-6"/>',
      right: '<path d="m9 18 6-6-6-6"/>'
    };
    return '<svg class="lsf-svg" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + (nodes[name] || '') + '</svg>';
  }

  function getTaskListBridge() {
    // Each installable script embeds this module; the page shares one hook and active owner.
    if (window.__LS_TASK_LIST_BRIDGE_V1__) return window.__LS_TASK_LIST_BRIDGE_V1__;
    const requestFetch = window.fetch.bind(window);
    const clients = new Map();
    const state = { nativeIdFilter: null };
    let activeOwner = '';
    let payloadFilter = null;

    function statusFor(owner, text) {
      const options = clients.get(owner);
      if (options && options.onStatus) options.onStatus(text);
    }

    function setStatus(text) { statusFor(activeOwner, text); }

    function saveState() {
      clients.forEach(function (options, id) {
        if (options.onChange) options.onChange(id === activeOwner ? state.nativeIdFilter : null);
      });
    }

    function shouldHook() { return payloadFilter && payloadFilter.enabled(); }
    function filterPayload(data) { return payloadFilter ? payloadFilter.transform(data) : null; }

  function csrfToken() {
    const m = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
    if (m) return decodeURIComponent(m[1]);
    const meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.content : '';
  }

  function apiUrl(path, params) {
    const url = new URL(path, location.origin);
    if (params) Object.keys(params).forEach(function (k) {
      const v = params[k];
      if (v != null && v !== '') url.searchParams.set(k, String(v));
    });
    return url.toString();
  }

  function api(path, timeoutMs, signal) {
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, timeoutMs || 30000);
    const headers = { 'Accept': 'application/json' };
    const csrf = csrfToken();
    if (csrf) headers['X-CSRFToken'] = csrf;
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', function () { controller.abort(); }, { once: true });
    }
    return requestFetch(path, { credentials: 'include', headers: headers, signal: controller.signal })
      .then(function (r) { clearTimeout(timer); return r; },
        function (e) { clearTimeout(timer); throw e; });
  }

  function responseObjects(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
    const out = [body];
    const nested = ['data', 'result', 'payload', 'meta', 'pagination', 'page'];
    for (let i = 0; i < out.length && i < 12; i++) {
      for (let j = 0; j < nested.length; j++) {
        const n = out[i][nested[j]];
        if (!n || typeof n !== 'object' || Array.isArray(n)) continue;
        if (out.indexOf(n) < 0) out.push(n);
      }
    }
    return out;
  }

  function rowsFromResponse(body) {
    if (Array.isArray(body)) return body;
    const objects = responseObjects(body);
    const keys = ['results', 'tasks', 'items', 'rows', 'data'];
    for (let i = 0; i < objects.length; i++) {
      for (let j = 0; j < keys.length; j++) {
        if (Array.isArray(objects[i][keys[j]])) return objects[i][keys[j]];
      }
    }
    return [];
  }

  function taskListSummary(body) {
    const objects = responseObjects(body);
    const rows = rowsFromResponse(body);
    const hasRows = objects.some(function (object) {
      return ['results', 'tasks', 'items', 'rows', 'data'].some(function (key) { return Array.isArray(object[key]); });
    });
    let total = null;
    for (const object of objects) {
      const value = object.total != null ? object.total : object.count;
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) { total = value; break; }
    }
    if (!hasRows || total === null || total < rows.length) throw new Error('任务列表返回格式无法核对，请保留当前条件后重试。');
    return { rows: rows, total: total };
  }

  function verifyMembership(body, filter) {
    const summary = taskListSummary(body);
    if (filter) {
      const allowed = new Set(filter.ids);
      if (summary.total > allowed.size || summary.rows.some(function (row) { return !row || !allowed.has(Number(row.id)); })) {
        throw new Error('任务列表未执行 ID 条件，已停止应用，请重新打开筛选重试。');
      }
    }
    return summary;
  }

  function currentNativeViewId() {
    const dm = window.DM;
    const store = dm && (dm.store || dm);
    const project = store && (store.project && store.project.id || store.SDK && store.SDK.projectId);
    if (project != null && String(project) !== getProjectIdFromUrl()) return null;
    const id = store && store.currentView && store.currentView.id;
    return id == null ? null : String(id);
  }

  /* ==================== 单输入框多 ID 筛选 ==================== */
  let lastNativeTaskUrl = '';
  let multiIdBusy = false;
  let nativeRefresh = null;

  function analyzeIdInput(input) {
    const tokens = Array.isArray(input) ? input : String(input || '').trim().split(/[\s,，;；|、]+/);
    const ids = [];
    const invalid = [];
    let duplicates = 0;
    const seen = new Set();
    tokens.forEach(function (token) {
      const original = String(token).trim();
      const text = original.replace(/^#/, '').replace(/^id[:：=]/i, '');
      if (!text) { if (original) invalid.push(original); return; }
      const id = Number(text);
      if (!/^\d+$/.test(text) || !Number.isSafeInteger(id) || id <= 0) { invalid.push(original); return; }
      if (!seen.has(id)) { seen.add(id); ids.push(id); }
      else duplicates++;
    });
    return { ids: ids, invalid: invalid, duplicates: duplicates };
  }

  function normalizeMultiIds(input) {
    const result = analyzeIdInput(input);
    if (result.invalid.length) throw new Error('任务 ID 必须是有效的正整数：' + result.invalid[0].slice(0, 30));
    if (!result.ids.length) throw new Error('请填写任务 ID。');
    return result.ids;
  }

  function makeMultiIdQuery(base, ids) {
    const query = JSON.parse(JSON.stringify(base || {}));
    const group = query.filters || { conjunction: 'and', items: [] };
    const items = Array.isArray(group.items) ? group.items : [];
    const remaining = items.filter(function (item) { return item.filter !== 'filter:tasks:id'; });
    if (String(group.conjunction || 'and').toLowerCase() === 'or' && remaining.length && remaining.length !== items.length) {
      throw new Error('原生 ID 与其他条件使用 OR，不能安全合并；请先改为 AND，或仅保留 ID 条件。');
    }
    query.filters = Object.assign({}, group, { items: remaining });
    // selectedItems is an existing server-side membership filter, not hundreds of UI rows.
    query.selectedItems = { all: false, included: ids.slice() };
    return query;
  }

  function nativeTaskListInfo(url) {
    const dmPath = /^\/api\/(?:dm\/)?tasks\/?$/.test(url.pathname);
    const projectPath = url.pathname.match(/^\/api\/projects\/(\d+)\/tasks\/?$/);
    if (!dmPath && !projectPath) return null;
    return {
      projectFromPath: projectPath ? projectPath[1] : null,
      isProjectPath: !!projectPath
    };
  }

  function rewriteMultiIdUrl(raw, method, filter) {
    if (!filter || String(method || 'GET').toUpperCase() !== 'GET') return raw;
    const url = new URL(raw, location.origin);
    if (url.origin !== location.origin) return raw;
    const taskList = nativeTaskListInfo(url);
    if (!taskList) return raw;
    const project = taskList.projectFromPath || url.searchParams.get('project') || getProjectIdFromUrl();
    if (String(project) !== String(filter.projectId)) return raw;
    // Some Label Studio versions omit `view` on the project-scoped task list.
    // Only reject an explicit, different view; a missing view is still the same list endpoint.
    if (filter.viewId && url.searchParams.has('view') && url.searchParams.get('view') !== String(filter.viewId)) return raw;
    const currentView = currentNativeViewId();
    if (filter.viewId && currentView && !url.searchParams.has('view') && currentView !== String(filter.viewId)) return raw;
    const query = JSON.parse(JSON.stringify(filter.query));
    const live = JSON.parse(url.searchParams.get('query') || '{}');
    if (live.ordering) query.ordering = live.ordering;
    url.searchParams.delete('view');
    url.searchParams.delete('selectedItems');
    if (!taskList.isProjectPath) url.searchParams.set('project', String(filter.projectId));
    url.searchParams.set('query', JSON.stringify(query));
    if (url.href.length > 7500) throw new Error('多 ID 请求超过安全长度，请减少 ID 数量后重试。');
    return url.href;
  }

  function nativeFilterSignature(filters) {
    function stable(value) {
      if (Array.isArray(value)) return value.map(stable);
      if (!value || typeof value !== 'object') return value;
      const out = {};
      Object.keys(value).sort().forEach(function (key) { out[key] = stable(value[key]); });
      return out;
    }
    return JSON.stringify(stable(filters || { conjunction: 'and', items: [] }));
  }

  function syncNativeFilterChange(filters) {
    const active = state.nativeIdFilter;
    if (!active) return;
    const signature = nativeFilterSignature(filters);
    if (signature === active.originalFilters) return;
    try {
      const previous = JSON.parse(active.originalFilters);
      const withoutEnhancedFields = function (group) {
        return Object.assign({}, group, {
          items: (Array.isArray(group.items) ? group.items : []).filter(function (item) {
            return !['filter:tasks:state', 'filter:tasks:annotations_results', 'filter:tasks:annotation_results'].includes(item.filter);
          })
        });
      };
      // 状态和标注结果均保存为原生条件，变化时继续保留 ID 交集。
      // 其他原生条件变化仍沿用多 ID 模块原有的清除规则。
      if (nativeFilterSignature(withoutEnhancedFields(previous)) === nativeFilterSignature(withoutEnhancedFields(filters))) {
        active.query = makeMultiIdQuery(Object.assign({}, active.query, { filters: filters }), active.ids);
        active.originalFilters = signature;
        active.updatedAt = Date.now();
        saveState();
        refreshMultiIdIndicator();
        return;
      }
    } catch (error) {}
    clearMultiIdFilter(false);
    setStatus('原生筛选已变更，已停止临时 ID 筛选。');
  }

  function currentMultiIdFilter() {
    const active = state.nativeIdFilter;
    if (!active || String(active.projectId) !== getProjectIdFromUrl()) return null;
    if (active.viewId) {
      const currentView = currentNativeViewId();
      if (currentView && currentView !== String(active.viewId)) return null;
      if (!lastNativeTaskUrl) return null;
      const lastUrl = new URL(lastNativeTaskUrl);
      const taskList = nativeTaskListInfo(lastUrl);
      if (!taskList || (lastUrl.searchParams.get('view') && lastUrl.searchParams.get('view') !== String(active.viewId))) return null;
    }
    return active;
  }

  function blockUnsafeNativeAction(event) {
    if (!currentMultiIdFilter()) return;
    if (!(event.target instanceof Element)) return;
    const control = event.target.closest('button, a, [role=button], .dm-dropdown__trigger');
    if (!control || !control.closest('.dm-tab-panel') || control.closest('[data-lsf-inline], [data-lsf-native-ids], [data-lsid-inline]')) return;
    if (!/^(?:Actions|操作|批量操作)(?:\s*\d+)?$|^(?:导出|导出过滤|导出筛选|Export(?: filtered)?(?: tasks)?)$/i.test((control.textContent || '').trim())) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    setStatus('已阻止原生批量操作或导出：请先清除临时列表筛选。');
  }

  function observeNativeRequest(raw, method, body, confirmed) {
    try {
      const url = new URL(raw, location.origin);
      if (url.origin !== location.origin) return;
      const verb = String(method || 'GET').toUpperCase();
      const taskList = nativeTaskListInfo(url);
      if (verb === 'GET' && taskList) {
        const project = taskList.projectFromPath || url.searchParams.get('project') || getProjectIdFromUrl();
        if (project !== getProjectIdFromUrl()) return;
        const currentView = currentNativeViewId();
        if (currentView && url.searchParams.has('view') && url.searchParams.get('view') !== currentView) return;
        lastNativeTaskUrl = url.href;
        refreshMultiIdIndicator();
        const live = JSON.parse(url.searchParams.get('query') || '{}');
        const active = state.nativeIdFilter;
        if (active && project === String(active.projectId) && (!active.viewId || !url.searchParams.has('view') || url.searchParams.get('view') === String(active.viewId))
          && live.filters && nativeFilterSignature(live.filters) !== active.originalFilters) {
          syncNativeFilterChange(live.filters);
        }
      }
      const view = url.pathname.match(/^\/api\/dm\/views\/(\d+)\/?$/);
      if (confirmed && state.nativeIdFilter && view && view[1] === state.nativeIdFilter.viewId && /^(PATCH|PUT)$/.test(verb) && typeof body === 'string') {
        const payload = JSON.parse(body);
        const data = payload.data || payload;
        if (data.filters) syncNativeFilterChange(data.filters);
        if (state.nativeIdFilter && data.ordering) {
          state.nativeIdFilter.query.ordering = data.ordering;
          saveState();
        }
      }
    } catch (error) {}
  }

  function adaptNativeTaskUrl(raw, method, body) {
    observeNativeRequest(raw, method, body);
    try { return rewriteMultiIdUrl(raw, method, state.nativeIdFilter); }
    catch (error) {
      clearMultiIdFilter(false);
      setStatus('ID 筛选已停止：' + error.message);
      return raw;
    }
  }

  function refreshMultiIdIndicator() {
    clients.forEach(function (options) {
      if (options.onContext) options.onContext();
    });
  }

  async function refreshNativeTaskList() {
    const dm = window.DM;
    const store = dm && (dm.store || dm);
    const project = store && (store.project && store.project.id || store.SDK && store.SDK.projectId);
    if (project != null && String(project) !== getProjectIdFromUrl()) throw new Error('项目已切换，请等待当前任务列表加载。');
    const view = store && store.currentView;
    if (!view || typeof view.reload !== 'function') throw new Error('未找到当前任务表的局部刷新接口，未刷新或跳转页面。');
    if (nativeRefresh) throw new Error('任务列表正在刷新，请稍后重试。');
    let started, failed, timer;
    const failure = new Promise(function (resolve, reject) { failed = reject; });
    failure.catch(function () {});
    const firstRequest = new Promise(function (resolve, reject) {
      started = resolve;
      timer = setTimeout(function () { reject(new Error('未检测到任务列表刷新请求，未确认筛选生效。')); }, 3000);
    });
    const capture = {
      filter: state.nativeIdFilter, checks: [], started: started, error: null,
      fail: function (error) { capture.error = capture.error || error; failed(capture.error); },
      viewId: currentNativeViewId(), projectId: getProjectIdFromUrl()
    };
    nativeRefresh = capture;
    try {
      if (typeof view.clearSelection === 'function') view.clearSelection();
      await Promise.race([Promise.all([view.reload({ interaction: 'filter' }), firstRequest]), failure]);
      await Promise.all(capture.checks);
      if (getProjectIdFromUrl() !== capture.projectId ||
          (capture.viewId && currentNativeViewId() !== capture.viewId)) throw new Error('项目或视图已切换，请重新应用。');
    } finally { clearTimeout(timer); nativeRefresh = null; }
  }

  function captureForRequest(raw, method) {
    if (!nativeRefresh || !isTaskListUrl(raw, method)) return null;
    const url = new URL(raw, location.origin);
    if (nativeRefresh.viewId && url.searchParams.has('view') && url.searchParams.get('view') !== nativeRefresh.viewId) return null;
    return nativeRefresh;
  }

  function captureFetchResponse(promise, raw, method) {
    const capture = captureForRequest(raw, method);
    if (!capture) return promise;
    const check = promise.then(async function (response) {
      if (capture.error) throw capture.error;
      if (!response.ok) throw new Error('任务列表刷新失败（HTTP ' + response.status + '）。');
      verifyMembership(await response.clone().json(), capture.filter);
      return response;
    });
    check.catch(function (error) { capture.fail(error); });
    capture.checks.push(check);
    capture.started();
    return check;
  }

  function captureXhrResponse(xhr) {
    const capture = captureForRequest(xhr.__lsfUrl, xhr.__lsfMethod);
    if (!capture) return;
    const check = new Promise(function (resolve, reject) {
      xhr.__lsfRefreshCheck = { capture: capture, resolve: resolve, reject: reject, verified: false, error: null };
    });
    check.catch(function (error) { capture.fail(error); });
    capture.checks.push(check);
    capture.started();
  }

  function checkXhrResponse(xhr, event) {
    const record = xhr.__lsfRefreshCheck;
    if (!record) return false;
    if (record.error) {
      if (event === record.endEvent && xhr.status === 0) return false;
      event.stopImmediatePropagation(); return true;
    }
    if (xhr.readyState !== 4) return false;
    if (xhr.status < 200 || xhr.status >= 300) {
      record.reject(new Error('任务列表刷新失败（HTTP ' + xhr.status + '）。'));
      return false;
    }
    try {
      if (record.capture.error) throw record.capture.error;
      if (!record.verified) {
        const body = xhr.responseType === 'json' ? xhr.response : JSON.parse(xhr.responseText);
        verifyMembership(body, record.capture.filter);
        record.verified = true;
      }
      if (event.type === 'loadend') record.resolve();
      return false;
    } catch (error) {
      record.error = error;
      record.reject(error);
      event.stopImmediatePropagation();
      // Stop an invalid successful response before native onload/readyState handlers
      // can render it. Notify the native client so its pending request also settles.
      xhr.abort();
      if (xhr.__lsfRefreshCheck === record && xhr.status === 0) {
        xhr.dispatchEvent(new Event('error'));
        if (xhr.__lsfRefreshCheck === record && xhr.status === 0) {
          record.endEvent = new Event('loadend');
          xhr.dispatchEvent(record.endEvent);
        }
      }
      return true;
    }
  }

  function guardXhrResponse(xhr) {
    if (xhr.__lsfResponseGuard) return;
    xhr.__lsfResponseGuard = true;
    ['readystatechange', 'load', 'loadend'].forEach(function (type) {
      xhr.addEventListener(type, function (event) {
        if (checkXhrResponse(xhr, event)) return;
        if (xhr.readyState === 4 && xhr.status >= 200 && xhr.status < 300 && !xhr.__lsfObservedSave) {
          xhr.__lsfObservedSave = true;
          observeNativeRequest(xhr.__lsfUrl, xhr.__lsfMethod, xhr.__lsfBody, true);
        }
      }, true);
    });
  }

  function clearMultiIdFilter(reload) {
    if (reload && multiIdBusy) { setStatus('正在应用多 ID，请稍后再清除。'); return false; }
    const previous = state.nativeIdFilter;
    const previousOwner = activeOwner;
    state.nativeIdFilter = null;
    activeOwner = '';
    refreshMultiIdIndicator();
    if (!reload) { saveState(); return true; }
    multiIdBusy = true;
    return refreshNativeTaskList().then(function () {
      saveState();
      statusFor(previousOwner, '已清除多 ID 条件，已更新当前任务列表。');
      return true;
    }).catch(function (error) {
      state.nativeIdFilter = previous;
      activeOwner = previousOwner;
      refreshMultiIdIndicator();
      statusFor(previousOwner, '清除 ID 筛选失败：' + error.message);
      return false;
    }).finally(function () { multiIdBusy = false; });
  }

  async function applyMultiIds(input, onStatus, owner) {
    const status = typeof onStatus === 'function' ? onStatus : setStatus;
    if (multiIdBusy) { status('正在应用多 ID，请勿重复操作。'); return false; }
    multiIdBusy = true;
    const previous = { filter: state.nativeIdFilter, owner: activeOwner };
    let activated = false;
    try {
      const ids = normalizeMultiIds(input);
      const projectId = getProjectIdFromUrl();
      if (!projectId) throw new Error('无法识别当前项目 ID。');
      const context = lastNativeTaskUrl ? new URL(lastNativeTaskUrl) : null;
      const viewId = currentNativeViewId() || (context && (context.searchParams.get('project') || projectId) === projectId ? context.searchParams.get('view') : null);
      let base = context ? JSON.parse(context.searchParams.get('query') || '{}') : {};
      status('校验 ' + ids.length + ' 个 ID 的单条件筛选…');
      if (viewId) {
        const viewResponse = await api('/api/dm/views/' + viewId + '/', 10000);
        if (!viewResponse.ok) throw new Error('读取当前原生筛选失败（HTTP ' + viewResponse.status + '）。');
        const view = await viewResponse.json();
        if (view.project != null && String(view.project) !== projectId) throw new Error('原生视图不属于当前项目。');
        base = view.data || {};
      }
      const candidate = { projectId: projectId, viewId: viewId || null, ids: ids, query: makeMultiIdQuery(base, ids), originalFilters: nativeFilterSignature(base.filters), updatedAt: Date.now() };
      const probeUrl = context || new URL('/api/dm/tasks?project=' + projectId, location.origin);
      probeUrl.searchParams.set('page', '1');
      probeUrl.searchParams.set('page_size', '1');
      const probeBase = probeUrl.href;
      // A zero-ID probe catches servers that silently ignore selectedItems.
      const empty = Object.assign({}, candidate, { query: makeMultiIdQuery(base, [0]) });
      const probes = [empty, candidate];
      for (let i = 0; i < probes.length; i++) {
        const response = await api(rewriteMultiIdUrl(probeBase, 'GET', probes[i]), 15000);
        if (!response.ok) throw new Error('接口不支持多 ID 筛选（HTTP ' + response.status + '），已停止，不会创建大量筛选行。');
        const data = await response.json();
        const summary = verifyMembership(data, probes[i]);
        if (i === 0 && (summary.total !== 0 || summary.rows.length !== 0)) {
          throw new Error('接口未正确执行多 ID 条件，已停止，不会创建大量筛选行。');
        }
      }
      if (getProjectIdFromUrl() !== projectId) throw new Error('项目已切换，请在当前项目重新应用。');
      const liveView = currentNativeViewId() || (lastNativeTaskUrl && new URL(lastNativeTaskUrl).searchParams.get('view'));
      if (viewId && liveView && liveView !== viewId) throw new Error('原生视图已切换，请重新应用。');
      state.nativeIdFilter = candidate;
      activeOwner = owner;
      activated = true;
      status('正在更新当前任务列表…');
      await refreshNativeTaskList();
      saveState();
      refreshMultiIdIndicator();
      status('已应用 ' + ids.length + ' 个 ID，当前任务列表已更新。');
      return true;
    } catch (error) {
      if (activated) {
        state.nativeIdFilter = previous.filter;
        activeOwner = previous.owner;
        refreshMultiIdIndicator();
      }
      status('多 ID 筛选失败：' + error.message);
      return false;
    } finally { multiIdBusy = false; }
  }

  function isTaskListUrl(raw, method) {
    if (!raw || String(method || 'GET').toUpperCase() !== 'GET') return false;
    try {
      const url = new URL(raw, location.origin);
      const info = nativeTaskListInfo(url);
      if (url.origin !== location.origin || !info) return false;
      const project = info.projectFromPath || url.searchParams.get('project') || getProjectIdFromUrl();
      return !!project && project === getProjectIdFromUrl();
    } catch (error) { return false; }
  }

  function installHooks() {
    // ---- fetch ----
    const origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      window.fetch = function (input, init) {
        const rawUrl = typeof input === 'string' ? input : (input && (input.url || input.href)) || '';
        const method = (init && init.method) || (input && input.method) || 'GET';
        if (/^(PATCH|PUT)$/i.test(method) && /\/api\/dm\/views\/\d+\/?(?:\?|$)/.test(rawUrl)
          && typeof Request !== 'undefined' && input instanceof Request && !(init && init.body)) {
          return input.clone().text().then(function (body) {
            return origFetch.call(window, input, init).then(function (response) {
              if (response.ok) observeNativeRequest(rawUrl, method, body, true);
              return response;
            });
          });
        }
        const adapted = adaptNativeTaskUrl(rawUrl, method, init && init.body);
        const request = adapted !== rawUrl ? (typeof Request !== 'undefined' && input instanceof Request ? new Request(adapted, input) : adapted) : input;
        let pending = origFetch.call(window, request, init);
        if (/^(PATCH|PUT)$/i.test(method)) pending = pending.then(function (response) {
          if (response.ok) observeNativeRequest(rawUrl, method, init && init.body, true);
          return response;
        });
        const p = captureFetchResponse(pending, rawUrl, method);
        if (adapted !== rawUrl) return p;
        if (!shouldHook()) return p;
        let url = '';
        try {
          url = typeof input === 'string' ? input : (input && input.url) ? input.url : '';
        } catch (e) {}
        if (!isTaskListUrl(url, method)) return p;
        return p.then(function (resp) {
          if (!resp || !resp.ok) return resp;
          const clone = resp.clone();
          return clone.json().then(function (data) {
            const out = filterPayload(data);
            if (!out) return resp;
            return new Response(JSON.stringify(out), {
              status: resp.status,
              statusText: resp.statusText,
              headers: { 'Content-Type': 'application/json' }
            });
          }).catch(function () { return resp; });
        });
      };
    }

    // ---- XMLHttpRequest（axios 走这条）----
    const NativeXHR = window.XMLHttpRequest;
    const XP = XMLHttpRequest.prototype;
    // Install validation at construction, before any page-owned handlers.
    window.XMLHttpRequest = new Proxy(NativeXHR, {
      construct: function (Target, args, NewTarget) {
        const xhr = Reflect.construct(Target, args, NewTarget);
        guardXhrResponse(xhr);
        return xhr;
      }
    });
    const origOpen = XP.open;
    XP.open = function () {
      guardXhrResponse(this);
      if (this.__lsfRefreshCheck) this.__lsfRefreshCheck.reject(new Error('任务列表请求已被替换。'));
      this.__lsfRefreshCheck = null;
      this.__lsfObservedSave = false;
      this.__lsfBody = null;
      this.__lsfUrl = String(arguments[1] || '');
      this.__lsfMethod = String(arguments[0] || 'GET');
      const adapted = adaptNativeTaskUrl(this.__lsfUrl, this.__lsfMethod);
      this.__lsfBulk = adapted !== this.__lsfUrl;
      const args = Array.from(arguments);
      args[1] = adapted;
      const self = this;
      if (!this.__lsfReadListener) {
        this.__lsfReadListener = true;
        // 在 open 阶段注册，确保早于页面自己的 onload 回调执行
        this.addEventListener('readystatechange', function () {
          if (!shouldHook() || self.__lsfBulk || !isTaskListUrl(self.__lsfUrl, self.__lsfMethod)) return;
          if (self.readyState !== 4) return;
          if (self.status < 200 || self.status >= 300) return;
          let txt = '';
          try { txt = self.responseText; } catch (e) { return; }
          if (!txt) return;
          let data;
          try { data = JSON.parse(txt); } catch (e) { return; }
          const out = filterPayload(data);
          if (!out) return;
          const s = JSON.stringify(out);
          try {
            const isText = (self.responseType === '' || self.responseType === 'text');
            Object.defineProperty(self, 'responseText', { value: s, configurable: true, writable: true });
            Object.defineProperty(self, 'response', { value: isText ? s : out, configurable: true, writable: true });
          } catch (e) {}
        }, true);
      }
      return origOpen.apply(this, args);
    };
    const origSend = XP.send;
    XP.send = function (body) {
      this.__lsfBody = body;
      captureXhrResponse(this);
      try { return origSend.apply(this, arguments); }
      catch (error) {
        if (this.__lsfRefreshCheck) this.__lsfRefreshCheck.reject(error);
        throw error;
      }
    };
  }

  document.addEventListener('click', blockUnsafeNativeAction, true);
  installHooks();


    const bridge = {
      request: requestFetch,
      analyzeIds: analyzeIdInput,
      normalizeIds: normalizeMultiIds,
      refresh: refreshNativeTaskList,
      register: function (id, options) {
        clients.set(id, options);
        const restored = options.filter;
        if (restored && Array.isArray(restored.ids) && restored.query && String(restored.projectId) === getProjectIdFromUrl()
          && (!state.nativeIdFilter || Number(restored.updatedAt || 0) > Number(state.nativeIdFilter.updatedAt || 0))) {
          state.nativeIdFilter = restored;
          activeOwner = id;
        }
        return {
          apply: function (ids, onStatus) { return applyMultiIds(ids, onStatus || options.onStatus, id); },
          clear: function (reload) {
            if (activeOwner !== id || !state.nativeIdFilter) return Promise.resolve(false);
            return clearMultiIdFilter(reload);
          },
          get active() { return activeOwner === id ? currentMultiIdFilter() : null; },
          setPayloadFilter: function (filter) { payloadFilter = filter; }
        };
      }
    };
    window.__LS_TASK_LIST_BRIDGE_V1__ = bridge;
    return bridge;
  }


  const LS_KEY = 'lsf_multi_id_v1';
  const state = { idsText: '', nativeIdFilter: null };
  const bridge = getTaskListBridge();
  let draftTimer = null;
  loadState();

  const client = bridge.register('multi-id', {
    filter: state.nativeIdFilter,
    onChange: function (filter) {
      state.nativeIdFilter = filter;
      if (filter) state.idsText = filter.ids.join(',');
      saveState();
      refreshMultiIdIndicator();
    },
    onContext: refreshMultiIdIndicator,
    onStatus: setStatus
  });
  window.__LS_MULTI_ID__ = {
    apply: client.apply,
    clear: client.clear,
    get active() { return client.active; }
  };

  function saveState() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (error) {}
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(LS_KEY) || localStorage.getItem('lsf_choices_filter_v2');
      const saved = raw ? JSON.parse(raw) : {};
      state.idsText = typeof saved.idsText === 'string' ? saved.idsText : '';
      state.nativeIdFilter = saved.nativeIdFilter && Array.isArray(saved.nativeIdFilter.ids) && saved.nativeIdFilter.query ? saved.nativeIdFilter : null;
    } catch (error) {}
  }

  function currentMultiIdFilter() { return client.active; }
  function applyMultiIds(input, status) { return client.apply(input, status); }
  function clearMultiIdFilter(reload) { return client.clear(reload); }

  function setStatus(text) {
    document.querySelectorAll('[data-lsf-native-ids] [role=status]').forEach(function (node) {
      node.textContent = text;
    });
  }

  function refreshMultiIdIndicator() {
    if (document.body) scheduleNativeIdInputs();
  }

  function installStyles() {
    if (document.getElementById('lsmidStyles')) return;
    const style = document.createElement('style');
    style.id = 'lsmidStyles';
    style.textContent = `
      .lsf-native-id-entry{display:flex;align-items:center;flex-wrap:wrap;gap:4px;min-width:0;max-width:100%}
      .lsf-native-id-entry>textarea{box-sizing:border-box;flex:1 1 110px;min-width:60px;width:100%;height:36px;min-height:36px;max-height:36px;resize:none;overflow:hidden;border:1px solid #dce1e8;border-radius:6px;padding:8px;font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace}
      .lsf-native-id-entry>button{display:inline-flex;align-items:center;justify-content:center;width:30px;height:36px;padding:5px;border:1px solid #dce1e8;border-radius:6px;background:#fff;color:#3978d4;cursor:pointer;flex:0 0 30px}
      .lsf-native-id-entry>button:disabled{opacity:.4;cursor:wait}
      .lsf-native-id-entry>button:hover:enabled{background:#edf4ff;border-color:#9bb9e8}
      .lsf-native-id-entry>textarea:focus-visible,.lsf-native-id-entry>button:focus-visible{outline:2px solid #91b7ec;outline-offset:1px}
      .lsf-native-id-entry .lsf-svg{display:block;pointer-events:none}
      .lsf-native-id-status{font:11px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#697380;overflow-wrap:anywhere}
      .dm-filters input[data-lsf-native-original]{display:none!important}
      .dm-filters[data-lsf-id-active] .dm-filters__empty{display:none!important}
      [data-lsf-persisted-ids]{display:flex;flex-direction:column;gap:6px;min-width:0;max-width:100%;padding:8px 0;border-bottom:1px solid #e4e7eb;margin-bottom:8px;font:12px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;color:#30343b;letter-spacing:0}
      .lsf-native-id-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
      .lsf-native-id-heading>span{color:#697380;font-size:11px}
      [data-lsf-id-badge]{display:inline-flex;align-items:center;white-space:nowrap;font:11px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#0066cc;background:#edf5ff;border-radius:3px;padding:0 5px;margin-left:4px}
      [data-lsf-native-zero-badge]{display:none!important}

    `;
    document.head.appendChild(style);
  }

  function syncNativeIdEntry(entry, active, fallback) {
    const idsText = active ? active.ids.join(',') : '';
    if (entry.dataset.appliedIds === idsText) return;
    entry.dataset.appliedIds = idsText;
    entry.querySelector('[data-lsf-multi-input]').value = active ? idsText : fallback || '';
    entry.querySelector('[role=status]').textContent = active ? '已应用 ' + active.ids.length + ' 个 ID' : '';
  }

  function createNativeIdEntry(fallback) {
    const entry = document.createElement('div');
    entry.setAttribute('data-lsf-native-ids', '');
    entry.innerHTML = '<div class="lsf-native-id-entry"><textarea rows="1" wrap="off" data-lsf-multi-input aria-label="多个任务 ID" placeholder="1001,1002,1003" autocomplete="off" spellcheck="false"></textarea><button type="button" title="应用多个 ID" aria-label="应用多个 ID">' + lsfIcon('filter') + '</button><button type="button" title="清除临时 ID 筛选" aria-label="清除临时 ID 筛选">' + lsfIcon('close') + '</button></div><div class="lsf-native-id-status" role="status"></div>';
    const input = entry.querySelector('[data-lsf-multi-input]');
    const buttons = entry.querySelectorAll('button');
    const status = entry.querySelector('[role=status]');
    let working = false;
    syncNativeIdEntry(entry, currentMultiIdFilter(), fallback);
    const apply = async function (event) {
      event.preventDefault();
      event.stopPropagation();
      if (working) return;
      working = true;
      input.disabled = true;
      buttons.forEach(function (button) { button.disabled = true; });
      try { await applyMultiIds(input.value, function (text) { status.textContent = text; setStatus(text); }); }
      finally {
        const message = status.textContent;
        syncNativeIdEntry(entry, currentMultiIdFilter(), '');
        status.textContent = message;
        working = false; input.disabled = false;
        buttons.forEach(function (button) { button.disabled = false; });
      }
    };
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && !event.isComposing && !event.shiftKey) void apply(event);
    });
    buttons[0].addEventListener('click', apply);
    buttons[1].addEventListener('click', async function (event) {
      event.preventDefault();
      event.stopPropagation();
      if (working) return;
      if (currentMultiIdFilter()) {
        working = true;
        input.disabled = true;
        buttons.forEach(function (button) { button.disabled = true; });
        try {
          const cleared = await clearMultiIdFilter(true);
          status.textContent = cleared ? '已取消 ID 条件，其他筛选保持原样。' : '取消失败，已保留原 ID 条件；请重试。';
        } finally {
          const message = status.textContent;
          syncNativeIdEntry(entry, currentMultiIdFilter(), '');
          status.textContent = message;
          working = false; input.disabled = false;
          buttons.forEach(function (button) { button.disabled = false; });
        }
      } else { input.value = ''; status.textContent = ''; }
    });
    // Keep comma-separated text out of React's original numeric onChange handler.
    entry.addEventListener('input', function (event) {
      event.stopPropagation();
      if (event.target === input) {
        state.idsText = input.value;
        clearTimeout(draftTimer);
        draftTimer = setTimeout(saveState, 250);
      }
    });
    entry.addEventListener('change', function (event) { event.stopPropagation(); });
    return entry;
  }

  function enhanceNativeIdInputs() {
    if (!document.body) return;
    const active = currentMultiIdFilter();
    document.querySelectorAll('.dm-filters').forEach(function (filters) {
      const list = filters.querySelector('.dm-filters__list');
      if (!list) return;
      // Native Filters can wrap field/operation/value cells in layout groups.
      const columns = Array.from(list.querySelectorAll('.dm-field, .dm-operation, .dm-value'));
      columns.forEach(function (field, index) {
        if (!field.classList.contains('dm-field')) return;
        let value = null;
        let operator = '';
        for (let i = index + 1; i < columns.length && !columns[i].classList.contains('dm-field'); i++) {
          if (columns[i].classList.contains('dm-operation')) operator = columns[i].textContent.trim();
          if (columns[i].classList.contains('dm-value')) value = columns[i];
        }
        if (!value) return;
        const original = value.querySelector('input:not([data-lsf-multi-input])');
        let entry = value.querySelector('[data-lsf-native-ids]');
        const eligible = /^ID\s*[（(]\s*任务\s*ID\s*[)）]$/i.test(field.textContent.trim()) && operator === '=';
        if (!eligible) {
          if (entry) entry.remove();
          if (original) original.removeAttribute('data-lsf-native-original');
          return;
        }
        if (!original) return;
        if (!original.hasAttribute('data-lsf-native-original')) original.setAttribute('data-lsf-native-original', '');
        if (!entry) { entry = createNativeIdEntry(original.value || state.idsText); value.appendChild(entry); }
        else syncNativeIdEntry(entry, active, original.value);
      });
      let retained = filters.querySelector('[data-lsf-persisted-ids]');
      if (active && !list.querySelector('[data-lsf-native-ids]')) {
        if (!retained) {
          retained = document.createElement('div');
          retained.setAttribute('data-lsf-persisted-ids', '');
          retained.setAttribute('role', 'group');
          retained.setAttribute('aria-label', '已应用的任务 ID 条件');
          retained.innerHTML = '<div class="lsf-native-id-heading"><strong>ID(任务ID)</strong><span>任一匹配</span></div>';
          retained.appendChild(createNativeIdEntry(''));
          // Stay outside React's filter list so an empty-list rerender cannot erase the condition.
          filters.insertBefore(retained, filters.querySelector('.dm-filters__actions'));
        }
        syncNativeIdEntry(retained.querySelector('[data-lsf-native-ids]'), active, '');
      } else if (retained) retained.remove();
      if (active) filters.setAttribute('data-lsf-id-active', '');
      else filters.removeAttribute('data-lsf-id-active');
    });
    document.querySelectorAll('.dm-tab-panel .dm-dropdown__trigger, .dm-tab-panel button').forEach(function (trigger) {
      if (!/^(?:Filters|筛选|过滤)(?:\s|\d|$)/i.test(trigger.textContent.trim()) || trigger.closest('[data-lsf-inline]')) return;
      let badge = trigger.querySelector('[data-lsf-id-badge]');
      if (active) {
        if (!badge) { badge = document.createElement('span'); badge.setAttribute('data-lsf-id-badge', ''); trigger.appendChild(badge); }
        const text = 'ID ' + active.ids.length;
        if (badge.textContent !== text) badge.textContent = text;
      } else if (badge) badge.remove();
      trigger.querySelectorAll('.dm-badge').forEach(function (nativeBadge) {
        if (active && nativeBadge.textContent.trim() === '0') nativeBadge.setAttribute('data-lsf-native-zero-badge', '');
        else nativeBadge.removeAttribute('data-lsf-native-zero-badge');
      });
    });
  }

  let nativeIdUiTimer = null;
  function scheduleNativeIdInputs() {
    if (nativeIdUiTimer !== null) return;
    nativeIdUiTimer = setTimeout(function () { nativeIdUiTimer = null; enhanceNativeIdInputs(); }, 50);
  }

  function startNativeIdInputs() {
    const observer = new MutationObserver(function (records) {
      const relevant = records.some(function (record) {
        const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
        if (target && target.closest('[data-lsf-native-ids], [data-lsf-persisted-ids], .i360-state-control, .i360-state-tooltip')) return false;
        if (target && target.closest('.dm-filters')) return true;
        return Array.from(record.addedNodes || []).concat(Array.from(record.removedNodes || [])).some(function (node) {
          return node.nodeType === 1 && (node.matches('.dm-filters') || node.querySelector('.dm-filters'));
        });
      });
      if (relevant) scheduleNativeIdInputs();
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    document.addEventListener('click', function (event) {
      if (!(event.target instanceof Element)) return;
      if (event.target.closest('[data-lsf-native-ids]')) return;
      if (event.target.closest('.dm-dropdown__trigger, .dm-filters, .dm-dropdown__item, [role=option], .dm-tabs__item')) scheduleNativeIdInputs();
    });
    document.addEventListener('focusin', function (event) {
      if (!(event.target instanceof Element)) return;
      if (event.target.matches('.dm-filters .dm-value input:not([data-lsf-multi-input])')) {
        enhanceNativeIdInputs();
        const input = event.target.parentElement.querySelector('[data-lsf-multi-input]');
        if (input) input.focus();
      }
    });
  }


  function start() {
    installStyles();
    startNativeIdInputs();
    scheduleNativeIdInputs();
  }

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });


})();

  function startStateFilter() {
  'use strict';
  const KEY = '__i360StateFilter';
  window[KEY]?.destroy?.();

  // Populate from the platform's own StateCell map, including states which do
  // not occur in the current project. Never maintain a second enum here.
  const STATES = [];
  const known = new Set();
  function setCatalog(states) {
    STATES.splice(0, STATES.length, ...states);
    known.clear();
    for (const [value] of states) known.add(value);
  }

  function parseNativeCatalog(source) {
    const states = [];
    const field = (body, name) => {
      const value = body.match(new RegExp(`(?:\\b${name}|"${name}")\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")`));
      return value ? JSON.parse(value[1]) : null;
    };
    // Read only string data from the loaded bundle; never evaluate fetched JS.
    for (const match of source.matchAll(/(?:\b([A-Z][A-Z0-9_]*)|"([A-Z][A-Z0-9_]*)")\s*:\s*\{([^{}]*)\}/g)) {
      const styleKey = field(match[3], 'styleKey');
      const label = field(match[3], 'label');
      if (styleKey && label) states.push({ value: match[1] || match[2], label, styleKey });
    }
    if (!states.length) throw new Error('平台脚本中未找到状态映射');
    const keys = new Set(states.map(state => state.styleKey));
    let colors = {}, best = 0;
    for (const match of source.matchAll(/\{(?:\s*(?:[$\w]+|"[^"\r\n]+")\s*:\s*"(?:default|processing|success|error|warning)"\s*,?)+\s*\}/g)) {
      const pairs = [...match[0].matchAll(/(?:([$\w]+)|"([^"\r\n]+)")\s*:\s*"(default|processing|success|error|warning)"/g)];
      const score = pairs.filter(pair => keys.has(pair[1] || pair[2])).length;
      if (score > best) { best = score; colors = Object.fromEntries(pairs.map(pair => [pair[1] || pair[2], pair[3]])); }
    }
    return [...new Map(states.map(state => [state.value, [state.value, state.label, colors[state.styleKey] || 'default']])).values()];
  }

  const ordered = values => STATES.map(([value]) => value).filter(value => values.includes(value));
  const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function splitAlternatives(value) {
    const parts = [''];
    for (let i = 0; i < value.length; i++) {
      const char = value[i];
      if (char === '\\') {
        const next = value[++i];
        if (!next || !'\\^$.*+?()[]{}|'.includes(next)) return null;
        parts[parts.length - 1] += next;
      } else if (char === '|') parts.push('');
      else if ('^$.*+?()[]{}'.includes(char)) return null;
      else parts[parts.length - 1] += char;
    }
    return parts;
  }

  // A String field cannot accept an array for "contains": the native serializer
  // turns it into "A,B". Anchored regex expresses membership in the OR set and
  // remains a native, persistable filter, including alongside other AND/OR rows.
  function encode(mode, values) {
    const selected = ordered(values);
    if (mode === 'empty') return { operator: 'empty', value: false };
    if (!selected.length) return { operator: mode === 'ne' ? 'not_equal' : 'equal', value: null };
    if (selected.length === 1) return { operator: mode === 'ne' ? 'not_equal' : 'equal', value: selected[0] };
    const alternatives = selected.map(escapeRegex).join('|');
    return { operator: 'regex', value: mode === 'ne'
      ? `^(?!(?:${alternatives})$).*$`
      : `^(?:${alternatives})$` };
  }

  function decode(filter) {
    const { operator, currentValue: value } = filter;
    if (operator === 'empty') return { mode: 'empty', values: [], legacy: false };
    const mode = ['not_equal', 'not_contains'].includes(operator) ? 'ne' : 'eq';
    if (value == null || value === '') return { mode, values: [], legacy: false };
    if (['equal', 'not_equal', 'contains', 'not_contains'].includes(operator) && known.has(value)) {
      return { mode, values: [value], legacy: false };
    }
    if (operator === 'regex' && typeof value === 'string') {
      const positive = value.startsWith('^(?:') && value.endsWith(')$');
      const negative = value.startsWith('^(?!(?:') && value.endsWith(')$).*$');
      const parts = positive ? splitAlternatives(value.slice(4, -2)) : negative ? splitAlternatives(value.slice(7, -6)) : null;
      if (parts?.length && parts.every(part => known.has(part))) {
        return { mode: negative ? 'ne' : 'eq', values: ordered(parts), legacy: false };
      }
    }
    // Do not silently rewrite a pre-existing custom regex or an unknown state.
    return { mode, values: [], legacy: true, original: `${operator}: ${String(value)}` };
  }

  const style = document.createElement('style');
  style.id = 'i360-state-filter-style';
  style.textContent = `
    .dm-filters { --i360-border: #dce1e8; --i360-ink: #344054; --i360-muted: #8b95a5; box-sizing: border-box; padding: 14px; background: #fff; color: var(--i360-ink); }
    .dm-dropdown:has(> .dm-filters:not(.dm-filters_sidebar)) { border: 1px solid #e4e8ef; border-radius: 10px; background: #fff; box-shadow: 0 8px 28px #1d293917, 0 2px 6px #1d293909; }
    .dm-dropdown > .dm-filters { border-radius: inherit; }
    .dm-filters__list { gap: 8px !important; }
    .dm-operation.i360-state-operation > :not(.i360-state-operator) { display: none !important; }
    .dm-value.i360-state-value > :not(.i360-state-control) { display: none !important; }
    .dm-filters .dm-filter-line__column { min-height: 36px; }
    .dm-filters .dm-conjunction { width: auto; min-width: 0; color: var(--i360-muted); }
    .dm-filters .dm-select_size_small, .dm-filters .dm-input_size_small { height: 36px; min-height: 36px; box-sizing: border-box; border: 1px solid var(--i360-border); border-radius: 6px; background: #fff !important; color: var(--i360-ink); font-size: 12px; transition: border-color .15s, box-shadow .15s; }
    .dm-filters .dm-select__selected { height: 100%; box-sizing: border-box; padding: 0 10px; border: 0; border-radius: inherit; background: transparent; font-weight: 400; }
    .dm-filters .dm-select__icon { position: relative; width: 16px; height: 16px; flex-shrink: 0; }
    .dm-filters .dm-select__icon::before { display: none; }
    .dm-filters .dm-select__icon::after, .i360-state-operation::after, .i360-state-trigger::after { content: ''; position: absolute; width: 5px; height: 5px; border: 0; border-right: 1.5px solid #8b95a5; border-bottom: 1.5px solid #8b95a5; transform: rotate(45deg); pointer-events: none; }
    .dm-filters .dm-select__icon::after { top: 4px; left: 4px; }
    .dm-filters .dm-button_size_small { height: 36px; min-height: 36px; border-radius: 6px; }
    .dm-filters__actions { margin-top: 12px; padding-top: 12px; border-top: 1px solid #eef0f4; gap: 8px; }
    .dm-filters__actions > button:first-child { border: 1px solid var(--i360-border); background: #f8fafc; box-shadow: none; color: var(--i360-ink); }
    .dm-filters__actions > button:first-child:hover { border-color: #b4c4dd; background: #f1f5fa; }
    .dm-filters__actions > button[about="Pin to sidebar"] { width: 36px; min-width: 36px; padding: 0; border: 1px solid #e9edf2; background: #f8fafc; color: #8b95a5; justify-content: center; }
    .dm-filters__actions > button[about="Pin to sidebar"]:hover { border-color: #b4c4dd; color: #3978d4; }
    .dm-filters__actions > button[about="Pin to sidebar"] svg { width: 16px; height: 16px; }
    :where(.dm-filters:not(.dm-filters_sidebar)) .dm-filters__list_withFilters { grid-template-columns: 52px min-content min-content 1fr 36px; align-items: start; }
    .dm-filters_sidebar .dm-filters__list_withFilters { grid-template-columns: minmax(0,1fr) minmax(0,1fr) 36px; }
    .dm-filters .dm-filter-line__remove { width: 36px; min-width: 36px; height: 36px; min-height: 36px; display: flex; align-items: center; justify-content: center; align-self: start; }
    .dm-filters .dm-filter-line__remove button { box-sizing: border-box; height: 36px; width: 36px; min-width: 36px; padding: 0; border: 1px solid #e9edf2; border-radius: 6px; background: #f8fafc; color: #8b95a5; display: inline-flex; align-items: center; justify-content: center; transition: color .15s, background .15s, border-color .15s; }
    .dm-filters .dm-filter-line__remove button:hover { color: #cf1322; border-color: #ffccc7; background: #fff2f0; }
    .dm-filters .dm-filter-line__remove svg { width: 14px; height: 14px; }
    .dm-sidebar:has(.dm-filters) .dm-sidebar__extra button { min-height: 36px; min-width: 32px; }
    .i360-filter-menu .dm-select__option { min-height: 33px; padding: 8px 16px; box-sizing: border-box; display: flex; align-items: center; }
    .i360-filter-menu .dm-select__search input { height: 36px; box-sizing: border-box; }
    .dm-filters__list:has(.i360-state-operation) { grid-template-columns: 52px minmax(110px,auto) 72px minmax(216px,max-content) 36px; align-items: start; }
    .i360-state-operation { position: relative; }
    .i360-state-operation::after { right: 12px; top: 13px; }
    .i360-state-operator { appearance: none; width: 100%; height: 36px; box-sizing: border-box; border: 1px solid var(--i360-border); border-radius: 6px; background: #fff; color: var(--i360-ink); font: inherit; font-size: 12px; padding: 0 28px 0 10px; cursor: pointer; transition: border-color .15s, box-shadow .15s; }
    .i360-state-control { min-width: 216px; width: max-content; position: relative; }
    .i360-state-trigger { display: grid; grid-template-columns: repeat(2,max-content); align-items: center; align-content: center; justify-content: start; gap: 6px; width: max-content; min-width: 216px; min-height: 36px; padding: 5px 28px 5px 8px; box-sizing: border-box; border: 1px solid var(--i360-border); border-radius: 6px; background: #fff; color: var(--i360-ink); cursor: pointer; font: inherit; font-size: 12px; text-align: left; transition: border-color .15s, box-shadow .15s; }
    .i360-state-trigger::after { right: 12px; top: 13px; }
    .dm-filters .dm-select_size_small:hover, .dm-filters .dm-input_size_small:hover, .i360-state-operator:hover, .i360-state-trigger:hover { border-color: #aab9cf; }
    .i360-state-trigger[aria-expanded="true"], .i360-state-operator:focus-visible, .i360-state-search:focus-visible { outline: 0; border-color: #7aa7eb; box-shadow: 0 0 0 2px #1677ff14; }
    .i360-state-trigger:focus-visible, .i360-state-option:focus-visible, .i360-state-remove:focus-visible, .i360-state-clear:focus-visible { outline: 2px solid #91b7ec; outline-offset: 1px; }
    .i360-state-placeholder { grid-column: 1 / -1; color: #8b95a5; font-size: 12px; line-height: 24px; }
    .i360-state-tag.ant-tag { box-sizing: border-box; margin: 0; padding: 0 6px; height: 24px; border: 0; border-radius: 4px; display: inline-flex; flex: 0 0 auto; gap: 4px; align-items: center; justify-self: start; white-space: nowrap; word-break: keep-all; overflow-wrap: normal; font-family: inherit; font-size: 12px; font-weight: 400; line-height: 20px; }
    .i360-state-tag-text { white-space: nowrap; word-break: keep-all; overflow-wrap: normal; }
    .i360-state-remove { box-sizing: border-box; height: 24px; min-width: 18px; border: 0; padding: 0 2px; border-radius: 4px; background: transparent; color: inherit; opacity: .6; cursor: pointer; font: inherit; line-height: 24px; }
    .i360-state-remove:hover { opacity: 1; background: #0000000a; }
    .i360-state-popup { position: fixed; z-index: 10005; display: flex; flex-direction: column; width: 160px; box-sizing: border-box; padding: 8px; border: 1px solid #e4e8ef; border-radius: 10px; background: #fff; color: #344054; box-shadow: 0 8px 28px #1d293917, 0 2px 6px #1d293909; font-size: 12px; }
    .i360-state-popup[hidden] { display: none !important; }
    .i360-state-search { width: 100%; box-sizing: border-box; height: 36px; flex-shrink: 0; padding: 5px 9px; border: 1px solid #e8ecf2; border-radius: 6px; background: #f8fafc; color: #344054; font: inherit; transition: border-color .15s, box-shadow .15s; }
    .i360-state-search::placeholder { color: #98a2b3; }
    .i360-state-options { display: grid; gap: 2px; margin: 6px 0; min-height: 0; overflow-y: auto; scrollbar-width: thin; scrollbar-color: #cbd2dd transparent; overscroll-behavior: contain; }
    .i360-state-option { width: 100%; box-sizing: border-box; display: flex; align-items: center; justify-content: space-between; gap: 6px; min-height: 48px; padding: 4px 8px; border: 0; border-radius: 6px; background: transparent; color: inherit; cursor: pointer; text-align: left; font: inherit; }
    .i360-state-option:hover { background: #f5f7fa; }
    .i360-state-option[aria-selected="true"] { background: #edf4ff; }
    .i360-state-option[aria-selected="true"]:hover { background: #e3eeff; }
    .i360-state-option > .i360-state-tag.ant-tag { padding: 0; border: 0; background: transparent; gap: 7px; }
    .i360-state-option > .i360-state-tag::before { content: ''; width: 5px; height: 5px; border-radius: 50%; background: currentColor; flex-shrink: 0; }
    .i360-state-check { width: 16px; height: 16px; flex: 0 0 16px; order: 2; display: inline-grid; place-items: center; box-sizing: border-box; color: transparent; line-height: 16px; font-size: 13px; font-weight: 600; }
    [aria-selected="true"] > .i360-state-check { color: #3978d4; }
    .i360-state-footer { display: flex; flex-shrink: 0; align-items: center; justify-content: space-between; gap: 4px; border-top: 1px solid #eef0f4; padding-top: 6px; color: #98a2b3; font-size: 11px; }
    .i360-state-clear { min-height: 30px; border: 0; border-radius: 4px; padding: 2px 6px; background: transparent; color: #3978d4; cursor: pointer; font: inherit; }
    .i360-state-clear:hover:enabled { background: #edf4ff; }
    .i360-state-clear:disabled { color: #b7bfcc; cursor: default; }
    .i360-state-legacy { grid-column: 1 / -1; max-width: 180px; font-size: 12px; color: #925400; overflow-wrap: anywhere; }
    .i360-state-tag.ant-tag-processing { color: #175cd3; background: #eff6ff; }
    .i360-state-tag.ant-tag-success { color: #348137; background: #f0f8ed; }
    .i360-state-tag.ant-tag-error { color: #cf3c46; background: #fff1f1; }
    .i360-state-tag.ant-tag-warning { color: #a46b16; background: #fff8e7; }
    .i360-state-tag.ant-tag-default { color: #667085; background: #f2f4f7; }
    .i360-state-tooltip { position: fixed; z-index: 10020; pointer-events: none; box-sizing: border-box; max-width: calc(100vw - 16px); padding: 7px 10px; border-radius: 6px; background: #344054; color: #fff; box-shadow: 0 2px 8px #0002; font: 12px/18px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; white-space: nowrap; }
    .i360-state-tooltip[hidden] { display: none !important; }
    .dm-filters_sidebar .dm-filters__list:has(.i360-state-operation) { grid-template-columns: minmax(0,1fr) minmax(0,1fr) 36px; }
    .dm-filters_sidebar .dm-filter-line__group:has(+ .dm-filter-line__group > .i360-state-operation),
    .dm-filters_sidebar .dm-filter-line__group:has(> .i360-state-operation) { grid-column: 1 / span 2; min-width: 0; }
    .dm-filters_sidebar .dm-filter-line__group:has(> .i360-state-operation) { grid-template-columns: 72px minmax(216px,max-content); gap: 8px; justify-content: start; }
    .dm-filters_sidebar .i360-state-value { min-width: 216px; }
    @media (max-width: 700px) {
      .dm-filters:not(.dm-filters_sidebar) .dm-filters__list:has(.i360-state-operation) { grid-template-columns: 42px 110px 64px minmax(216px,max-content) 36px; }
    }
  `;
  (document.head || document.documentElement).append(style);

  const entries = new Set();
  const byColumn = new WeakMap();
  const saves = new Map();
  let openEntry = null;
  let stopped = false;
  let frame = 0;
  let sequence = 0;
  let nativeTagScope = '';
  let tooltipTarget = null;
  let catalogPromise = null;
  let catalogSource = '';
  let catalogError = '';
  const tooltip = element('div', 'i360-state-tooltip');
  tooltip.id = 'i360-state-tooltip';
  tooltip.setAttribute('role', 'tooltip');
  tooltip.hidden = true;
  document.body.append(tooltip);

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function loadCatalog() {
    if (STATES.length || catalogPromise || stopped) return catalogPromise;
    catalogError = '';
    catalogPromise = (async () => {
      try {
        const script = [...document.scripts].find(node => {
          if (!node.src) return false;
          const url = new URL(node.src, location.href);
          return url.origin === location.origin && /\/dm\/[^/]+\.js$/.test(url.pathname);
        });
        if (!script) throw new Error('未找到平台 Data Manager 脚本');
        const response = await fetch(script.src, { credentials: 'same-origin', cache: 'no-cache' });
        if (!response.ok) throw new Error(`平台脚本读取失败：${response.status}`);
        const states = parseNativeCatalog(await response.text());
        if (stopped) return;
        setCatalog(states);
        catalogSource = script.src;
      } catch (error) {
        if (!stopped) {
          catalogError = '未能读取平台状态，关闭后重新打开可重试';
          console.warn('[Insta360 state filter]', error);
        }
      } finally {
        catalogPromise = null;
        if (!stopped) for (const entry of entries) {
          entry.state = decode(entry.model);
          entry.signature = JSON.stringify(entry.state);
          render(entry);
        }
      }
    })();
    return catalogPromise;
  }

  function tagFor(value) {
    const [, label, tone] = STATES.find(([key]) => key === value);
    const native = document.querySelector('.ant-tag:not(.i360-state-tag)');
    // Empty result sets have no native tag. Keep its scope and provide complete
    // base CSS above so neither a zero-row result nor a fresh empty page changes it.
    if (native) nativeTagScope = [...native.classList].filter(name => name.startsWith('css-')).join(' ');
    const tag = element('span', `ant-tag ant-tag-${tone} ${nativeTagScope} i360-state-tag`);
    tag.dataset.state = value;
    tag.setAttribute('aria-description', value);
    tag.append(element('span', 'i360-state-tag-text', label));
    return tag;
  }

  function hideTooltip() {
    if (tooltipTarget?.getAttribute('aria-describedby') === tooltip.id) tooltipTarget.removeAttribute('aria-describedby');
    tooltipTarget = null;
    tooltip.hidden = true;
  }

  function positionTooltip() {
    if (!tooltipTarget?.isConnected || !tooltipTarget.getClientRects().length) return hideTooltip();
    const rect = tooltipTarget.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > window.innerHeight) return hideTooltip();
    const width = tooltip.offsetWidth;
    const height = tooltip.offsetHeight;
    const right = rect.right + 8;
    const left = right + width <= window.innerWidth - 8 ? right : Math.max(8, rect.left - width - 8);
    Object.assign(tooltip.style, {
      left: `${left}px`,
      top: `${Math.max(8, Math.min(rect.top + (rect.height - height) / 2, window.innerHeight - height - 8))}px`,
    });
  }

  function showTooltip(event) {
    const target = event.target.closest?.('.i360-state-option[data-state], .i360-state-tag[data-state]');
    if (!target) return hideTooltip();
    const anchor = target.closest('.i360-state-option') || target;
    if (tooltipTarget === anchor) return;
    hideTooltip();
    tooltipTarget = anchor;
    tooltip.textContent = anchor.dataset.state;
    anchor.setAttribute('aria-describedby', tooltip.id);
    tooltip.hidden = false;
    positionTooltip();
  }

  function leaveTooltip(event) {
    if (tooltipTarget && !tooltipTarget.contains(event.relatedTarget)) hideTooltip();
  }

  function markNativeMenus() {
    // Select menus are portalled to body. Follow their React ownership so these
    // larger hit areas apply only to Filters, never to other menus on the page.
    for (const content of document.querySelectorAll('.dm-select__content:not(.i360-filter-menu)')) {
      const key = Object.keys(content).find(name => name.startsWith('__reactFiber$') || name.startsWith('__reactInternalInstance$'));
      let fiber = content[key];
      for (let i = 0; fiber && i < 64; i++, fiber = fiber.return) {
        const node = fiber.stateNode;
        if (node instanceof Element && node.matches('.dm-select') && node.closest('.dm-filters')) {
          content.classList.add('i360-filter-menu');
          break;
        }
      }
    }
  }

  function modelFor(column) {
    const fiberKey = Object.keys(column).find(key => key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$'));
    let fiber = column[fiberKey];
    for (let i = 0; fiber && i < 16; i++, fiber = fiber.return) {
      const model = fiber.memoizedProps?.filter;
      if (model && typeof model.setOperator === 'function' && typeof model.save === 'function') return model;
    }
    return null;
  }

  function isState(model) {
    return model?.$treenode?.isAlive !== false && model?.field?.alias === 'state' && model?.field?.target === 'tasks';
  }

  function close(entry = openEntry, restoreFocus = false) {
    if (!entry) return;
    hideTooltip();
    entry.popup.hidden = true;
    entry.trigger.setAttribute('aria-expanded', 'false');
    if (openEntry === entry) openEntry = null;
    if (restoreFocus && entry.trigger.isConnected) entry.trigger.focus();
  }

  function position(entry) {
    if (entry.popup.hidden) return;
    const rect = entry.trigger.getBoundingClientRect();
    const width = Math.min(160, window.innerWidth - 16);
    const below = window.innerHeight - rect.bottom - 12;
    const above = rect.top - 12;
    const useAbove = below < 250 && above > below;
    const available = Math.max(100, useAbove ? above : below);
    // The native dropdown has will-change:transform and therefore establishes
    // a containing block even for position:fixed. Convert viewport coordinates
    // into that block; otherwise the popup is shifted by the dropdown's origin.
    let originX = 0, originY = 0;
    for (let parent = entry.popup.parentElement; parent && parent !== document.documentElement; parent = parent.parentElement) {
      const css = getComputedStyle(parent);
      if (css.transform !== 'none' || css.perspective !== 'none' || css.filter !== 'none' ||
          (css.backdropFilter && css.backdropFilter !== 'none') ||
          /transform|perspective|filter/.test(css.willChange) || /paint|layout|strict|content/.test(css.contain)) {
        const block = parent.getBoundingClientRect();
        originX = block.left + parent.clientLeft - parent.scrollLeft;
        originY = block.top + parent.clientTop - parent.scrollTop;
        break;
      }
    }
    Object.assign(entry.popup.style, {
      width: `${width}px`, maxHeight: `${Math.min(480, available)}px`,
      left: `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)) - originX}px`,
      bottom: 'auto',
    });
    entry.popup.style.top = `${(useAbove ? rect.top - entry.popup.offsetHeight - 5 : rect.bottom + 5) - originY}px`;
  }

  function toggle(entry) {
    if (!entry.popup.hidden) return close(entry);
    close();
    entry.popup.hidden = false;
    openEntry = entry;
    entry.trigger.setAttribute('aria-expanded', 'true');
    entry.search.value = '';
    if (!STATES.length) void loadCatalog();
    renderOptions(entry);
    position(entry);
    entry.search.focus();
  }

  function renderOptions(entry) {
    hideTooltip();
    const query = entry.search.value.trim().toLowerCase();
    const items = STATES.filter(([value, label]) => `${label} ${value}`.toLowerCase().includes(query));
    entry.options.replaceChildren();
    for (const [value, label] of items) {
      const selected = entry.state.values.includes(value);
      const option = element('button', 'i360-state-option');
      option.type = 'button';
      option.setAttribute('role', 'option');
      option.setAttribute('aria-label', label);
      option.setAttribute('aria-selected', String(selected));
      option.dataset.value = value;
      option.dataset.state = value;
      option.setAttribute('aria-description', value);
      const check = element('span', 'i360-state-check', selected ? '✓' : '');
      check.setAttribute('aria-hidden', 'true');
      option.append(check, tagFor(value));
      option.addEventListener('click', () => {
        change(entry, entry.state.mode, selected ? entry.state.values.filter(key => key !== value) : [...entry.state.values, value]);
        entry.options.querySelector(`[data-value="${value}"]`)?.focus();
      });
      entry.options.append(option);
    }
    if (!items.length) entry.options.append(element('span', 'i360-state-placeholder', STATES.length ? '没有匹配的状态' : catalogError || '正在读取平台原生状态…'));
    entry.summary.textContent = `已选 ${entry.state.values.length} 项`;
    entry.summary.title = entry.state.mode === 'ne' ? '排除任一所选状态' : '匹配任一所选状态';
    entry.clear.disabled = !entry.state.values.length;
  }

  function render(entry) {
    hideTooltip();
    const state = entry.state;
    entry.operator.value = state.mode;
    // Empty keeps the original site's yes/no dropdown, including its callbacks.
    entry.valueColumn.classList.toggle('i360-state-value', state.mode !== 'empty');
    entry.control.hidden = state.mode === 'empty';
    entry.trigger.replaceChildren();
    if (state.mode === 'empty') { close(entry); return; }
    if (!STATES.length) {
      entry.trigger.append(element('span', 'i360-state-placeholder', catalogError ? '读取失败，点击重试' : '读取状态中…'));
    } else if (state.legacy) {
      entry.trigger.append(element('span', 'i360-state-legacy', '已有自定义条件；点击选择状态以替换'));
    } else if (!state.values.length) {
      entry.trigger.append(element('span', 'i360-state-placeholder', '请选择状态'));
    } else {
      for (const value of state.values) {
        const tag = tagFor(value);
        const remove = element('button', 'i360-state-remove', '×');
        remove.type = 'button';
        remove.setAttribute('aria-label', `移除 ${STATES.find(([key]) => key === value)[1]}`);
        remove.addEventListener('click', event => {
          event.stopPropagation();
          change(entry, state.mode, state.values.filter(key => key !== value));
          entry.trigger.focus();
        });
        tag.append(remove);
        entry.trigger.append(tag);
      }
    }
    if (!entry.popup.hidden) { renderOptions(entry); position(entry); }
  }

  async function save(record) {
    const { model, entry } = record;
    if (!model.$treenode?.isAlive || !isState(model)) { saves.delete(model); return; }
    // Native input handlers also save asynchronously. Wait for them before
    // flushing the latest model so rapid multi-selection cannot drop a save.
    if (model.saving) { record.timer = setTimeout(() => save(record), 60); return; }
    const revision = record.revision;
    try {
      model.markUnsaved();
      await model.save(true);
    } catch (error) {
      console.error('[Insta360 state filter] 保存筛选失败', error);
      entry.trigger.title = '保存筛选失败，请重新选择状态后重试';
    }
    if (revision === record.revision) saves.delete(model);
  }

  function queueSave(entry) {
    let record = saves.get(entry.model);
    if (!record) {
      record = { model: entry.model, entry, revision: 0, timer: 0 };
      saves.set(entry.model, record);
    }
    record.revision++;
    clearTimeout(record.timer);
    record.timer = setTimeout(() => save(record), 250);
  }

  function change(entry, mode, values) {
    if (entry.disposed || !isState(entry.model)) return;
    const next = encode(mode, values);
    // MST applies all fields within one native action. setOperator() by itself
    // would reset the value and immediately save an intermediate empty/no state.
    const node = entry.model.$treenode;
    if (typeof node?.applySnapshot !== 'function') {
      entry.trigger.title = '页面筛选组件已更新，请更新状态筛选脚本';
      return;
    }
    node.applySnapshot({ ...entry.model.toJSON(), ...next });
    entry.state = decode(entry.model);
    entry.signature = JSON.stringify(entry.state);
    render(entry);
    queueSave(entry);
  }

  function create(column, valueColumn, model) {
    const operator = element('select', 'i360-state-operator');
    operator.setAttribute('aria-label', 'State 筛选关系');
    for (const [value, label] of [['eq', '包含'], ['ne', '不包含'], ['empty', '为空']]) {
      const option = element('option', '', label);
      option.value = value;
      operator.append(option);
    }
    const control = element('div', 'i360-state-control');
    const trigger = element('div', 'i360-state-trigger');
    trigger.tabIndex = 0;
    trigger.setAttribute('role', 'button');
    trigger.setAttribute('aria-label', '选择筛选状态（可多选）');
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    const popup = element('div', 'i360-state-popup');
    popup.hidden = true;
    popup.id = `i360-state-popup-${++sequence}`;
    trigger.setAttribute('aria-controls', popup.id);
    const search = element('input', 'i360-state-search');
    search.type = 'search';
    search.placeholder = '搜索状态';
    search.setAttribute('aria-label', '搜索状态');
    const options = element('div', 'i360-state-options');
    options.setAttribute('role', 'listbox');
    options.setAttribute('aria-label', '状态');
    options.setAttribute('aria-multiselectable', 'true');
    const footer = element('div', 'i360-state-footer');
    const summary = element('span');
    const clear = element('button', 'i360-state-clear', '清空');
    clear.type = 'button';
    footer.append(summary, clear);
    popup.append(search, options, footer);
    control.append(trigger, popup);
    column.append(operator);
    valueColumn.append(control);
    column.classList.add('i360-state-operation');
    const entry = { column, valueColumn, model, operator, control, trigger, popup, search, options, summary, clear, state: decode(model) };
    entry.signature = JSON.stringify(entry.state);
    operator.addEventListener('change', () => change(entry, operator.value, entry.state.values));
    trigger.addEventListener('click', () => toggle(entry));
    trigger.addEventListener('keydown', event => {
      if (event.target !== trigger) return;
      if (['Enter', ' ', 'ArrowDown'].includes(event.key)) { event.preventDefault(); toggle(entry); }
    });
    search.addEventListener('input', () => renderOptions(entry));
    clear.addEventListener('click', () => { change(entry, entry.state.mode, []); search.focus(); });
    control.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !popup.hidden) { event.preventDefault(); event.stopPropagation(); close(entry, true); }
      if (['ArrowDown', 'ArrowUp'].includes(event.key) && !popup.hidden) {
        event.preventDefault();
        const buttons = [...options.querySelectorAll('button')];
        const index = buttons.indexOf(document.activeElement);
        buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
      }
    });
    entries.add(entry);
    byColumn.set(column, entry);
    render(entry);
    return entry;
  }

  function dispose(entry) {
    close(entry);
    entry.disposed = true;
    entry.column.classList.remove('i360-state-operation');
    entry.valueColumn.classList.remove('i360-state-value');
    entry.operator.remove();
    entry.control.remove();
    byColumn.delete(entry.column);
    entries.delete(entry);
  }

  function scan() {
    frame = 0;
    if (stopped) return;
    markNativeMenus();
    if (tooltipTarget && !tooltipTarget.isConnected) hideTooltip();
    const found = new Set();
    for (const column of document.querySelectorAll('.dm-filters .dm-operation')) {
      const model = modelFor(column);
      const valueColumn = column.nextElementSibling;
      if (!isState(model) || !valueColumn?.classList.contains('dm-value')) continue;
      found.add(column);
      let entry = byColumn.get(column);
      if (entry && (entry.model !== model || entry.valueColumn !== valueColumn || !entry.operator.isConnected || !entry.control.isConnected)) {
        dispose(entry);
        entry = null;
      }
      if (!entry) { create(column, valueColumn, model); continue; }
      const state = decode(model);
      const signature = JSON.stringify(state);
      if (signature !== entry.signature) {
        entry.state = state;
        entry.signature = signature;
        render(entry);
      }
    }
    for (const entry of entries) if (!found.has(entry.column)) dispose(entry);
  }

  function schedule(records) {
    if (stopped || frame) return;
    if (records?.length && records.every(record => record.target.nodeType === 1 && record.target.closest?.('.i360-state-control, .i360-state-operator, .i360-state-tooltip'))) return;
    frame = requestAnimationFrame(scan);
  }
  function outside(event) { if (openEntry && !openEntry.control.contains(event.target)) close(); }
  function refit() { if (openEntry) position(openEntry); if (tooltipTarget) positionTooltip(); }
  function focusOut() { if (openEntry && !openEntry.control.contains(document.activeElement)) close(); }
  const observer = new MutationObserver(schedule);
  observer.observe(document.body || document.documentElement, { childList: true, subtree: true, characterData: true });
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('focusin', focusOut);
  document.addEventListener('pointerover', showTooltip);
  document.addEventListener('pointerout', leaveTooltip);
  document.addEventListener('focusin', showTooltip);
  document.addEventListener('focusout', leaveTooltip);
  window.addEventListener('resize', refit);
  window.addEventListener('scroll', refit, true);
  window.addEventListener('popstate', schedule);
  scan();
  void loadCatalog();

  window[KEY] = {
    version: '1.3.0',
    get catalog() { return { source: catalogSource, error: catalogError, states: STATES.map(state => [...state]) }; },
    destroy() {
      stopped = true;
      observer.disconnect();
      cancelAnimationFrame(frame);
      for (const entry of [...entries]) dispose(entry);
      for (const record of saves.values()) { clearTimeout(record.timer); void save(record); }
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('focusin', focusOut);
      document.removeEventListener('pointerover', showTooltip);
      document.removeEventListener('pointerout', leaveTooltip);
      document.removeEventListener('focusin', showTooltip);
      document.removeEventListener('focusout', leaveTooltip);
      window.removeEventListener('resize', refit);
      window.removeEventListener('scroll', refit, true);
      window.removeEventListener('popstate', schedule);
      style.remove();
      hideTooltip();
      tooltip.remove();
      for (const content of document.querySelectorAll('.i360-filter-menu')) content.classList.remove('i360-filter-menu');
      delete window[KEY];
    },
  };
  }

  function startAnnotationFilter() {
  'use strict';
  const KEY = '__i360AnnotationFilter';
  if (window[KEY]) return;
  const TOOLS = [];
  const known = new Set();
  const palette = ['#1677ff', '#13a8a8', '#389e0d', '#d46b08', '#722ed1', '#c41d7f', '#ad8b00'];
  const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function setCatalog(tools) {
    TOOLS.splice(0, TOOLS.length, ...tools);
    known.clear();
    for (const tool of tools) known.add(tool.token);
  }

  function tasksFromResponse(body) {
    if (Array.isArray(body)) return body;
    if (!body || typeof body !== 'object') return [];
    for (const key of ['tasks', 'results', 'items', 'rows']) if (Array.isArray(body[key])) return body[key];
    for (const key of ['data', 'result', 'payload']) {
      if (!body[key] || typeof body[key] !== 'object') continue;
      const tasks = tasksFromResponse(body[key]);
      if (tasks.length) return tasks;
    }
    return body.id != null && ('annotations_results' in body || 'annotation_results' in body || 'annotations' in body) ? [body] : [];
  }

  function taskPageInfo(body) {
    const sources = [];
    const collect = (value, depth = 0) => {
      if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 8) return;
      sources.push(value);
      for (const key of ['data', 'result', 'payload', 'pagination', 'meta']) collect(value[key], depth + 1);
    };
    collect(body);
    const numberValue = keys => {
      for (const source of sources) for (const key of keys) {
        const value = source[key];
        if (!['string', 'number'].includes(typeof value) || String(value).trim() === '') continue;
        const number = Number(value);
        if (Number.isSafeInteger(number) && number >= 0) return number;
      }
      return null;
    };
    const next = sources.map(source => source.next).find(value => value !== undefined);
    return {
      total: numberValue(['total', 'count']),
      pageSize: numberValue(['page_size', 'pageSize']) || null,
      hasNext: next === undefined ? null : Boolean(next),
    };
  }

  function projectFromResponse(body, depth = 0) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || depth > 8) return null;
    if ('label_config' in body || 'parsed_label_config' in body) return body;
    for (const key of ['data', 'result', 'payload', 'project']) {
      const project = projectFromResponse(body[key], depth + 1);
      if (project) return project;
    }
    return body.id != null ? body : null;
  }

  function parseTaskCatalog(task) {
    const tools = new Map();
    const add = (token, label) => {
      if (typeof token !== 'string' || !token.trim()) return;
      token = token.trim();
      const text = typeof label === 'string' && label.trim() ? label.trim() : token;
      if (!tools.has(token)) tools.set(token, { token, label: text, color: palette[tools.size % palette.length] });
      else if (tools.get(token).label === token && text !== token) tools.get(token).label = text;
    };
    function visit(value, depth = 0) {
      if (value == null || depth > 12) return;
      if (typeof value === 'string') {
        const text = value.trim();
        if (!text) return;
        try { const parsed = JSON.parse(text); if (parsed !== text) { visit(parsed, depth + 1); return; } } catch (_) {}
        if (!/^[\[{"]/.test(text)) add(text);
        return;
      }
      if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); return; }
      if (typeof value !== 'object') return;
      const token = typeof value.from_name === 'object' ? value.from_name?.name : value.from_name;
      if (typeof token === 'string') {
        const labels = value.value?.[value.type];
        add(token, value.label || (Array.isArray(labels) && labels.every(label => typeof label === 'string') ? labels.join('、') : null));
        return;
      }
      const wrappers = ['annotations_results', 'annotation_results', 'annotations', 'result', 'results'];
      const present = wrappers.filter(key => key in value);
      if (present.length) { for (const key of present) visit(value[key], depth + 1); return; }
      // Some project packages serialize results as a map keyed by tool name.
      for (const [key, nested] of Object.entries(value)) {
        if (nested && typeof nested === 'object' && !['value', 'data', 'meta'].includes(key)) add(key, nested.label);
      }
    }
    if (task && typeof task === 'object') {
      for (const key of ['annotations_results', 'annotation_results', 'annotations']) visit(task[key]);
      for (const key of ['annotations_results', 'annotation_results']) visit(task.data?.[key]);
    }
    return [...tools.values()];
  }

  function parseProjectCatalog(project) {
    project = projectFromResponse(project);
    const tools = new Map();
    const add = (token, label) => {
      if (typeof token !== 'string' || !token.trim()) return;
      token = token.trim();
      const text = typeof label === 'string' && label.trim() ? label.trim() : token;
      if (!tools.has(token)) tools.set(token, { token, label: text, color: palette[tools.size % palette.length] });
      else if (tools.get(token).label === token && text !== token) tools.get(token).label = text;
    };
    const ignoredTypes = new Set(['image', 'text', 'video', 'audio', 'hypertext', 'paragraph', 'paragraphs', 'timeseries', 'header', 'view', 'filter', 'style', 'list', 'table', 'timeline']);
    const labelText = value => {
      if (!Array.isArray(value)) return null;
      const labels = value.map(item => typeof item === 'string' ? item : item?.value)
        .filter(item => typeof item === 'string').map(item => item.trim()).filter(item => item && !item.startsWith('$'));
      return labels.length ? [...new Set(labels)].join('、') : null;
    };
    let parsed = project?.parsed_label_config ?? project?.data?.parsed_label_config;
    if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch (_) { parsed = null; } }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [name, definition] of Object.entries(parsed)) {
        if (!definition || typeof definition !== 'object' || typeof definition.type !== 'string') continue;
        const type = definition.type.toLowerCase();
        if (ignoredTypes.has(type)) continue;
        const label = labelText(definition.labels) || labelText(definition.choices) || labelText(definition.options) || labelText(definition.categories);
        if (definition.to_name || definition.toName || label) add(name, definition.title || definition.label || label);
      }
    }
    const xml = project?.label_config ?? project?.data?.label_config;
    if (typeof xml === 'string' && xml.trim() && typeof DOMParser !== 'undefined') {
      try {
        const doc = new DOMParser().parseFromString(xml, 'application/xml');
        if (!doc.getElementsByTagName('parsererror').length) {
          for (const control of doc.querySelectorAll('[name][toName], [name][toname]')) {
            if (ignoredTypes.has(control.localName.toLowerCase())) continue;
            const labels = [...control.querySelectorAll('Label, Choice, Option, Category')]
              .filter(node => node.closest('[name][toName], [name][toname]') === control)
              .map(node => node.getAttribute('value'));
            add(control.getAttribute('name'), control.getAttribute('title') || control.getAttribute('label') || labelText(labels));
          }
        }
      } catch (_) {}
    }
    return [...tools.values()];
  }

  function mergeTaskCatalog(tasks) {
    const merged = new Map();
    for (const task of Array.isArray(tasks) ? tasks : []) {
      for (const tool of parseTaskCatalog(task)) {
        const current = merged.get(tool.token);
        if (!current) {
          merged.set(tool.token, { ...tool, color: palette[merged.size % palette.length] });
        } else if (current.label === current.token && tool.label !== tool.token) {
          current.label = tool.label;
        }
      }
    }
    return [...merged.values()];
  }

  function splitAlternatives(value) {
    const parts = [''];
    for (let i = 0; i < value.length; i++) {
      const char = value[i];
      if (char === '\\') {
        const next = value[++i];
        if (!next || !'\\^$.*+?()[]{}|'.includes(next)) return null;
        parts[parts.length - 1] += next;
      } else if (char === '|') parts.push('');
      else if ('^$.*+?()[]{}'.includes(char)) return null;
      else parts[parts.length - 1] += char;
    }
    return parts;
  }

  // Keep exclusion in one native filter row so its OR set is negated as a
  // whole, independently of the conjunction between this row and other rows.
  // Explicit newline matching works in both the browser and backend regexes.
  const exclusionPrefix = '^(?!(?:.|\\n)*(?:';
  const exclusionSuffix = '))(?:.|\\n)*$';

  function encode(mode, values) {
    if (!['has', 'none'].includes(mode) || values.some(value => !known.has(value))) throw new Error('无法识别标注条件，请重新选择。');
    const selected = TOOLS.map(tool => tool.token).filter(token => values.includes(token));
    if (!selected.length) return { operator: mode === 'none' ? 'not_contains' : 'regex', value: null };
    const alternatives = selected.map(escapeRegex).join('|');
    return { operator: 'regex', value: mode === 'none' ? exclusionPrefix + alternatives + exclusionSuffix : alternatives };
  }

  function decode(model) {
    const value = model.currentValue;
    const negative = model.operator === 'regex' && typeof value === 'string' && value.startsWith(exclusionPrefix) && value.endsWith(exclusionSuffix);
    const mode = model.operator === 'not_contains' || negative ? 'none' : 'has';
    if (value == null || value === '') return { mode, values: [], custom: false };
    const parts = typeof value === 'string' ? (model.operator === 'regex' ? splitAlternatives(negative ? value.slice(exclusionPrefix.length, -exclusionSuffix.length) : value) : [value]) : null;
    if (parts?.length && parts.every(token => known.has(token)) &&
        (model.operator === 'regex' || (['contains', 'not_contains'].includes(model.operator) && parts.length === 1))) {
      return { mode, values: TOOLS.map(tool => tool.token).filter(token => parts.includes(token)), custom: false };
    }
    return { mode, values: [], custom: true };
  }

  const annotationStyle = document.createElement('style');
  annotationStyle.id = 'i360-annotation-filter-style';
  annotationStyle.textContent = `
    .dm-operation.i360-ar-operation > :not(.i360-ar-operator), .dm-value.i360-ar-value > :not(.i360-ar-control) { display:none!important; }
    .dm-filters__list:has(.i360-ar-operation) { grid-template-columns:52px minmax(110px,auto) 72px minmax(216px,max-content) 36px; align-items:start; }
    .dm-filters_sidebar .dm-filters__list:has(.i360-ar-operation) { grid-template-columns:minmax(0,1fr) minmax(0,1fr) 36px; }
    .i360-ar-operation { position:relative; }
    .i360-ar-operation::after, .i360-ar-trigger::after { content:''; position:absolute; width:5px; height:5px; right:12px; top:13px; border-right:1.5px solid #8b95a5; border-bottom:1.5px solid #8b95a5; transform:rotate(45deg); pointer-events:none; }
    .i360-ar-operator { appearance:none; width:100%; height:36px; box-sizing:border-box; border:1px solid #dce1e8; border-radius:6px; background:#fff; color:#344054; font:inherit; font-size:12px; padding:0 28px 0 10px; cursor:pointer; }
    .i360-ar-control { min-width:216px; width:216px; position:relative; font:inherit; font-size:12px; }
    .i360-ar-trigger { position:relative; display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); align-items:center; align-content:center; justify-content:start; gap:6px; width:100%; min-width:216px; min-height:36px; padding:5px 28px 5px 8px; box-sizing:border-box; border:1px solid #dce1e8; border-radius:6px; background:#fff; color:#344054; cursor:pointer; font:inherit; text-align:left; transition:border-color .15s,box-shadow .15s; }
    .i360-ar-placeholder { grid-column:1 / -1; color:#8b95a5; line-height:24px; }
    .i360-ar-tag { display:inline-flex; align-items:center; justify-self:start; gap:4px; min-width:0; max-width:100%; height:24px; box-sizing:border-box; padding:0 6px; border-radius:4px; background:var(--ar-background); color:var(--ar-color); white-space:nowrap; line-height:20px; }
    .i360-ar-tag-text { min-width:0; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
    .i360-ar-remove { height:24px; min-width:18px; flex-shrink:0; padding:0 2px; border:0; border-radius:4px; background:transparent; color:inherit; opacity:.6; cursor:pointer; font:inherit; line-height:24px; }
    .i360-ar-remove:hover { opacity:1; background:#0000000a; }
    .i360-ar-legacy { grid-column:1 / -1; max-width:180px; color:#925400; overflow-wrap:anywhere; }
    .i360-ar-note { display:block; max-width:216px; margin-top:5px; font-size:11px; color:#c24135; overflow-wrap:anywhere; }
    .i360-ar-note[hidden], .i360-ar-popup[hidden] { display:none!important; }
    .i360-ar-popup { position:fixed; z-index:10005; display:flex; flex-direction:column; width:160px; box-sizing:border-box; padding:8px; border:1px solid #e4e8ef; border-radius:10px; background:#fff; box-shadow:0 8px 28px #1d293917,0 2px 6px #1d293909; color:#344054; font-size:12px; }
    .i360-ar-search { width:100%; min-width:0; height:36px; flex-shrink:0; box-sizing:border-box; padding:5px 9px; border:1px solid #e8ecf2; border-radius:6px; background:#f8fafc; color:#344054; font:inherit; }
    .i360-ar-search::placeholder { color:#98a2b3; }
    .i360-ar-trigger:hover, .i360-ar-operator:hover { border-color:#aab9cf; }
    .i360-ar-trigger[aria-expanded=true], .i360-ar-operator:focus-visible, .i360-ar-search:focus-visible { outline:0; border-color:#7aa7eb; box-shadow:0 0 0 2px #1677ff14; }
    .i360-ar-trigger:focus-visible, .i360-ar-option:focus-visible, .i360-ar-remove:focus-visible, .i360-ar-clear:focus-visible { outline:2px solid #91b7ec; outline-offset:1px; }
    .i360-ar-options { display:grid; grid-template-columns:minmax(0,1fr); gap:2px; margin:6px 0; min-height:0; overflow-y:auto; overflow-x:hidden; scrollbar-width:thin; scrollbar-color:#cbd2dd transparent; overscroll-behavior:contain; }
    .i360-ar-option { display:flex; align-items:center; justify-content:space-between; gap:6px; width:100%; min-width:0; min-height:48px; box-sizing:border-box; padding:4px 8px; border:0; border-radius:6px; background:transparent; color:#344054; cursor:pointer; font:inherit; text-align:left; }
    .i360-ar-option:hover { background:#f5f7fa; }
    .i360-ar-option[aria-selected=true] { background:#edf4ff; }
    .i360-ar-option-label { display:inline-flex; flex:1 1 auto; align-items:center; min-width:0; gap:7px; color:var(--ar-color); overflow:hidden; }
    .i360-ar-option-text { display:block; min-width:0; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
    .i360-ar-check { order:2; display:inline-grid; place-items:center; width:16px; height:16px; flex:0 0 16px; color:transparent; font-size:13px; font-weight:600; }
    .i360-ar-option[aria-selected=true] .i360-ar-check { color:#3978d4; }
    .i360-ar-dot { width:5px; height:5px; border-radius:50%; flex-shrink:0; background:var(--ar-color); }
    .i360-ar-footer { display:flex; flex-shrink:0; align-items:center; justify-content:space-between; gap:4px; padding-top:6px; border-top:1px solid #eef0f4; font-size:11px; color:#98a2b3; }
    .i360-ar-clear { min-height:30px; border:0; border-radius:4px; padding:2px 6px; background:transparent; color:#3978d4; cursor:pointer; font:inherit; }
    .i360-ar-clear:hover:enabled { background:#edf4ff; }
    .i360-ar-clear:disabled { color:#b7bfcc; cursor:default; }
    .i360-ar-control button:disabled, .i360-ar-trigger[aria-disabled=true] { cursor:wait; }
    .dm-filters_sidebar .dm-filter-line__group:has(+ .dm-filter-line__group > .i360-ar-operation),
    .dm-filters_sidebar .dm-filter-line__group:has(> .i360-ar-operation) { grid-column:1 / span 2; min-width:0; }
    .dm-filters_sidebar .dm-filter-line__group:has(> .i360-ar-operation) { grid-template-columns:72px minmax(216px,max-content); gap:8px; justify-content:start; }
    @media (max-width:700px) {
      .dm-filters:not(.dm-filters_sidebar) .dm-filters__list:has(.i360-ar-operation) { grid-template-columns:42px 110px 64px minmax(216px,max-content) 36px; }
    }
  `;
  (document.head || document.documentElement).append(annotationStyle);
  const entries = new Map();
  let opened = null, frame = 0, sequence = 0;
  const catalogCache = new Map();
  let catalogProject = '';
  let catalogLoading = false;
  let catalogError = '';
  let catalogPromise = null;
  let catalogController = null;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    if (text != null) node.textContent = text;
    if (tag === 'button') node.type = 'button';
    return node;
  }

  function modelFor(column) {
    const key = Object.keys(column).find(key => key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$'));
    let fiber = column[key];
    for (let i = 0; fiber && i < 16; i++, fiber = fiber.return) {
      const model = fiber.memoizedProps?.filter;
      if (model?.field?.target === 'tasks' && ['annotations_results', 'annotation_results'].includes(model.field.alias) &&
          model.$treenode?.isAlive !== false && typeof model.save === 'function') return model;
    }
    return null;
  }

  function projectId() {
    const path = location.pathname.match(/\/projects\/(\d+)/);
    return path ? path[1] : new URLSearchParams(location.search).get('project') || '';
  }

  function projectCatalogUrl(id) {
    return new URL('/api/projects/' + id, location.origin).href;
  }

  function catalogUrl(id, page = 1, pageSize = 100) {
    const path = location.pathname.match(/\/projects\/(\d+)/);
    const url = path ? new URL('/api/projects/' + id + '/tasks', location.origin) : new URL('/api/dm/tasks', location.origin);
    url.searchParams.set('project', id);
    url.searchParams.set('page', String(page));
    url.searchParams.set('page_size', String(pageSize));
    url.searchParams.set('fields', 'all');
    url.searchParams.set('query', JSON.stringify({ filters: { conjunction: 'and', items: [] }, ordering: ['id'] }));
    // Explicitly clear the view's filters and omit selectedItems. Read a small
    // project sample independently of the current ID and view filters.
    return url.href;
  }

  async function catalogJSON(url, signal, subject, timeout = 15000) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, timeout);
    try {
      const response = await annotationRequest(url, { credentials: 'include', headers: { Accept: 'application/json' }, signal: controller.signal });
      if (!response.ok) throw new Error('读取' + subject + '失败（HTTP ' + response.status + '）');
      return await response.json();
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
  }

  async function loadTaskCatalog(id, controller) {
    const maxTasks = 600;
    const tasks = [], seen = new Set();
    let pageSize = 100;
    let page = 1;
    while (tasks.length < maxTasks) {
      const body = await catalogJSON(catalogUrl(id, page, pageSize), controller.signal, '项目任务');
      if (controller.signal.aborted) return tasks;
      const batch = tasksFromResponse(body);
      if (!batch.length) break;
      const before = tasks.length;
      for (const task of batch.slice(0, maxTasks - tasks.length)) {
        if (!task || typeof task !== 'object') continue;
        if (task.project != null && String(typeof task.project === 'object' ? task.project.id : task.project) !== id) throw new Error('返回的任务不属于当前项目，请重试');
        const key = task.id == null ? JSON.stringify(task) : String(task.id);
        if (!seen.has(key)) { tasks.push(task); seen.add(key); }
      }
      if (tasks.length === before) throw new Error('项目任务分页未前进，请关闭后重开重试');
      const info = taskPageInfo(body);
      const total = info.total;
      if (Number.isFinite(total) && tasks.length >= Math.min(total, maxTasks)) break;
      if (info.hasNext === false) break;
      if (page === 1) pageSize = Math.min(pageSize, info.pageSize || batch.length);
      else if (total == null && info.hasNext !== true && batch.length < pageSize) break;
      page += 1;
    }
    return tasks;
  }

  function renderCatalog() {
    for (const entry of entries.values()) {
      if (!entry.working) render(entry);
    }
  }

  function syncCatalogProject() {
    const id = projectId();
    if (id === catalogProject) return;
    catalogController?.abort();
    catalogProject = id;
    catalogController = null;
    catalogPromise = null;
    catalogLoading = false;
    catalogError = '';
    setCatalog(catalogCache.get(id) || []);
    close();
    renderCatalog();
  }

  async function loadCatalog(force = false) {
    syncCatalogProject();
    const id = projectId();
    if (!id) { setCatalog([]); catalogProject = ''; catalogError = '无法识别当前项目'; renderCatalog(); return; }
    if (!force && catalogCache.has(id)) {
      catalogProject = id;
      catalogError = '';
      setCatalog(catalogCache.get(id));
      renderCatalog();
      return;
    }
    if (catalogPromise) return catalogPromise;
    catalogProject = id;
    catalogLoading = true;
    catalogError = '';
    setCatalog([]);
    const controller = new AbortController();
    catalogController = controller;
    const timer = setTimeout(() => controller.abort(), 60000);
    renderCatalog();
    catalogPromise = (async () => {
      let tools = [];
      let project = null;
      try {
        project = projectFromResponse(await catalogJSON(projectCatalogUrl(id), controller.signal, '项目配置', 8000));
      } catch (error) {
        if (controller.signal.aborted) throw error;
      }
      if (project?.id != null && String(project.id) !== id) throw new Error('返回的配置不属于当前项目，请重试');
      tools = parseProjectCatalog(project);
      if (!tools.length) {
        const tasks = await loadTaskCatalog(id, controller);
        tools = mergeTaskCatalog(tasks);
      }
      if (controller.signal.aborted) return;
      catalogCache.set(id, tools);
      if (catalogController === controller && projectId() === id) setCatalog(tools);
    })()
      .catch(error => {
        if (catalogController === controller && projectId() === id) {
          setCatalog([]);
          catalogError = error.name === 'AbortError' ? '读取标注选项超时，关闭后重开可重试' : (error.message || '读取标注选项失败');
        }
      })
      .finally(() => {
        clearTimeout(timer);
        if (catalogController === controller) {
          catalogLoading = false;
          catalogPromise = null;
          catalogController = null;
          syncCatalogProject();
          renderCatalog();
        }
      });
    return catalogPromise;
  }

  function close(restore = false) {
    if (!opened) return;
    const entry = opened;
    entry.popup.hidden = true;
    entry.trigger.setAttribute('aria-expanded', 'false');
    opened = null;
    if (restore && entry.trigger.isConnected) entry.trigger.focus();
  }

  function position() {
    if (!opened) return;
    const entry = opened, rect = entry.trigger.getBoundingClientRect();
    if (!entry.trigger.isConnected || !entry.trigger.getClientRects().length) return close();
    const width = Math.min(160, innerWidth - 16);
    const below = innerHeight - rect.bottom - 12, above = rect.top - 12;
    const useAbove = below < 280 && above > below;
    Object.assign(entry.popup.style, { width: width + 'px', maxHeight: Math.max(120, Math.min(410, useAbove ? above : below)) + 'px', left: '0px', top: '0px' });
    const origin = entry.popup.getBoundingClientRect();
    entry.popup.style.left = (Math.max(8, Math.min(rect.left, innerWidth - width - 8)) - origin.left) + 'px';
    entry.popup.style.top = ((useAbove ? rect.top - entry.popup.offsetHeight - 5 : rect.bottom + 5) - origin.top) + 'px';
  }

  function renderOptions(entry) {
    const query = entry.search.value.trim().toLowerCase();
    const state = decode(entry.model);
    const focused = entry.options.contains(document.activeElement) ? document.activeElement.dataset.token : null;
    entry.options.replaceChildren();
    for (const tool of TOOLS.filter(tool => (tool.label + ' ' + tool.token).toLowerCase().includes(query))) {
      const selected = state.values.includes(tool.token);
      const option = element('button', 'i360-ar-option');
      option.setAttribute('role', 'option');
      option.setAttribute('aria-label', tool.label);
      option.setAttribute('aria-selected', String(selected));
      option.dataset.token = tool.token;
      option.title = tool.label + '（' + tool.token + '）';
      option.style.setProperty('--ar-color', tool.color);
      const check = element('span', 'i360-ar-check', selected ? '✓' : '');
      check.setAttribute('aria-hidden', 'true');
      const label = element('span', 'i360-ar-option-label');
      label.append(element('span', 'i360-ar-dot'), element('span', 'i360-ar-option-text', tool.label));
      option.append(check, label);
      option.disabled = entry.working || catalogLoading;
      option.addEventListener('click', () => {
        void apply(entry, state.mode, selected ? state.values.filter(token => token !== tool.token) : [...state.values, tool.token]);
      });
      entry.options.append(option);
    }
    if (!entry.options.children.length) entry.options.append(element('span', 'i360-ar-placeholder', catalogLoading ? '正在读取项目标注配置…' : (catalogError || (TOOLS.length ? '没有匹配的标注' : '项目配置和任务中没有标注结果'))));
    entry.summary.textContent = entry.working ? '正在保存…' : (state.mode === 'none' ? '排除任一 · 已选 ' : '包含任一 · 已选 ') + state.values.length + ' 项';
    entry.clear.disabled = entry.working || (!state.values.length && !state.custom);
    if (focused && !entry.working) [...entry.options.children].find(option => option.dataset.token === focused)?.focus();
  }

  function render(entry) {
    const state = decode(entry.model);
    entry.signature = JSON.stringify({ operator: entry.model.operator, value: entry.model.currentValue });
    entry.operator.value = state.mode;
    entry.trigger.replaceChildren();
    if (state.custom) entry.trigger.append(element('span', 'i360-ar-legacy', '已有自定义条件；点击选择标注以替换'));
    else if (!state.values.length) entry.trigger.append(element('span', 'i360-ar-placeholder', catalogLoading ? '正在读取项目任务…' : state.mode === 'none' ? '请选择要排除的标注' : '请选择标注'));
    else for (const tool of TOOLS.filter(tool => state.values.includes(tool.token))) {
      const tag = element('span', 'i360-ar-tag');
      tag.title = tool.label + '（' + tool.token + '）';
      tag.style.setProperty('--ar-color', tool.color);
      tag.style.setProperty('--ar-background', tool.color + '0d');
      const remove = element('button', 'i360-ar-remove', '×');
      remove.setAttribute('aria-label', '移除标注 ' + tool.label);
      remove.disabled = entry.working;
      remove.addEventListener('click', event => {
        event.stopPropagation();
        void apply(entry, state.mode, state.values.filter(token => token !== tool.token));
        entry.trigger.focus();
      });
      tag.append(element('span', 'i360-ar-tag-text', tool.label), remove);
      entry.trigger.append(tag);
    }
    entry.trigger.setAttribute('aria-disabled', String(entry.working));
    entry.trigger.setAttribute('aria-busy', String(entry.working));
    entry.operator.disabled = entry.working;
    if (!entry.popup.hidden) { renderOptions(entry); position(); }
  }

  async function apply(entry, mode, values) {
    if (entry.working || !entry.control.isConnected) return;
    syncCatalogProject();
    if (catalogLoading) return;
    const model = entry.model;
    const focusToken = entry.options.contains(document.activeElement) ? document.activeElement.dataset.token : null;
    let snapshot;
    const nativeControls = [...entry.valueColumn.querySelectorAll('input.dm-input'), ...entry.column.querySelectorAll('select')].map(node => ({ node, disabled: node.disabled }));
    try {
      const next = encode(mode, values);
      if (model.saving) throw new Error('原生条件仍在保存；若上次保存失败，请刷新页面后重试。');
      if (typeof model.$treenode?.applySnapshot !== 'function' || typeof model.toJSON !== 'function') throw new Error('未能识别当前原生筛选组件，请刷新页面后重试。');
      snapshot = model.toJSON();
      entry.working = true;
      entry.note.hidden = true;
      entry.trigger.setAttribute('aria-busy', 'true');
      entry.trigger.setAttribute('aria-disabled', 'true');
      entry.operator.disabled = true;
      entry.control.querySelectorAll('button').forEach(node => { node.disabled = true; });
      nativeControls.forEach(({ node }) => { node.disabled = true; });
      model.$treenode.applySnapshot({ ...snapshot, ...next });
      model.markUnsaved?.();
      await model.save(true);
    } catch (error) {
      if (snapshot && model.$treenode?.isAlive !== false) {
        try { model.$treenode.applySnapshot(snapshot); } catch (_) {}
      }
      const message = error.message + (model.saving ? ' 原生组件未结束保存，请刷新页面后重试。' : '');
      entry.note.textContent = message;
      entry.note.hidden = false;
    } finally {
      nativeControls.forEach(({ node, disabled }) => { node.disabled = disabled; });
      entry.working = false;
      render(entry);
      // Disabling the focused option during the request moves focus to body.
      // Restore it only while this dropdown remains open and focus is unclaimed.
      if (focusToken && opened === entry && document.activeElement === document.body) {
        [...entry.options.children].find(option => option.dataset.token === focusToken)?.focus();
      }
      schedule();
    }
  }

  function create(column, valueColumn, model) {
    const operator = element('select', 'i360-ar-operator');
    operator.setAttribute('aria-label', '标注结果筛选方式');
    for (const [value, label] of [['has', '包含'], ['none', '不包含']]) {
      const option = element('option', '', label); option.value = value; operator.append(option);
    }
    const control = element('div', 'i360-ar-control');
    const trigger = element('div', 'i360-ar-trigger');
    trigger.tabIndex = 0;
    trigger.setAttribute('role', 'button');
    trigger.setAttribute('aria-label', '选择标注结果（可多选）');
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    const clear = element('button', 'i360-ar-clear', '清空');
    clear.setAttribute('aria-label', '清除标注结果条件');
    const note = element('span', 'i360-ar-note');
    note.setAttribute('role', 'status');
    note.hidden = true;
    const popup = element('div', 'i360-ar-popup');
    popup.hidden = true;
    popup.id = 'i360-ar-popup-' + ++sequence;
    trigger.setAttribute('aria-controls', popup.id);
    const search = element('input', 'i360-ar-search');
    search.type = 'search'; search.placeholder = '搜索标注'; search.setAttribute('aria-label', '搜索标注');
    const options = element('div', 'i360-ar-options');
    options.setAttribute('role', 'listbox'); options.setAttribute('aria-label', '标注结果'); options.setAttribute('aria-multiselectable', 'true');
    const footer = element('div', 'i360-ar-footer');
    const summary = element('span', '');
    footer.append(summary, clear); popup.append(search, options, footer);
    const entry = { column, valueColumn, model, operator, control, trigger, popup, search, options, summary, clear, note, working: false };
    control.append(trigger, note, popup); valueColumn.append(control); column.append(operator);
    column.classList.add('i360-ar-operation'); valueColumn.classList.add('i360-ar-value');
    function toggle() {
      if (entry.working) return;
      syncCatalogProject();
      if (opened === entry) return close();
      close();
      search.value = '';
      popup.hidden = false; opened = entry; trigger.setAttribute('aria-expanded', 'true');
      renderOptions(entry); position(); search.focus();
      void loadCatalog();
    }
    trigger.addEventListener('click', toggle);
    trigger.addEventListener('keydown', event => {
      if (event.target === trigger && ['Enter', ' ', 'ArrowDown'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); toggle(); }
    });
    operator.addEventListener('change', event => { event.stopPropagation(); void apply(entry, operator.value, decode(model).values); });
    operator.addEventListener('input', event => event.stopPropagation());
    operator.addEventListener('click', event => event.stopPropagation());
    clear.addEventListener('click', () => { void apply(entry, decode(model).mode, []); search.focus(); });
    search.addEventListener('input', () => renderOptions(entry));
    control.addEventListener('input', event => event.stopPropagation());
    control.addEventListener('change', event => event.stopPropagation());
    control.addEventListener('click', event => event.stopPropagation());
    control.addEventListener('keydown', event => {
      if (event.key === 'Escape' && opened === entry) { event.preventDefault(); event.stopPropagation(); close(true); }
      if (opened === entry && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
        const buttons = [...options.querySelectorAll('button')];
        const current = buttons.indexOf(document.activeElement);
        event.preventDefault(); buttons[(current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
      }
    });
    render(entry);
    entries.set(column, entry);
  }

  function dispose(entry) {
    if (opened === entry) close();
    entry.column.classList.remove('i360-ar-operation');
    entry.valueColumn.classList.remove('i360-ar-value');
    entry.operator.remove();
    entry.control.remove();
    entries.delete(entry.column);
  }

  function scan() {
    frame = 0;
    syncCatalogProject();
    const found = new Set();
    for (const column of document.querySelectorAll('.dm-filters .dm-operation')) {
      const model = modelFor(column), valueColumn = column.nextElementSibling;
      if (!model || !valueColumn?.classList.contains('dm-value')) continue;
      found.add(column);
      const entry = entries.get(column);
      if (entry && (entry.model !== model || entry.valueColumn !== valueColumn || !entry.control.isConnected || !entry.operator.isConnected)) {
        dispose(entry);
      }
      if (!entries.has(column)) create(column, valueColumn, model);
      else {
        const live = entries.get(column);
        if (!live.working && live.signature !== JSON.stringify({ operator: model.operator, value: model.currentValue })) render(live);
      }
    }
    for (const [column, entry] of entries) if (!found.has(column)) {
      dispose(entry);
    }
  }

  function schedule(records) {
    if (frame || (records?.length && records.every(record => (record.target.nodeType === 1 ? record.target : record.target.parentElement)?.closest('.i360-ar-control, .i360-ar-operator')))) return;
    frame = requestAnimationFrame(scan);
  }
  document.addEventListener('pointerdown', event => { if (opened && !opened.control.contains(event.target)) close(); }, true);
  document.addEventListener('focusin', () => { if (opened && !opened.control.contains(document.activeElement)) close(); });
  window.addEventListener('resize', position);
  window.addEventListener('scroll', position, true);
  window.addEventListener('popstate', schedule);
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  document.addEventListener('click', schedule);
  document.addEventListener('input', event => { if (event.target instanceof Element && event.target.matches('.dm-filters .dm-value input')) schedule(); });
  document.addEventListener('change', event => { if (event.target instanceof Element && event.target.closest('.dm-filters .dm-operation')) schedule(); });
  window[KEY] = { version: '1.1.2' };
  scan();
  }

  function startFilterEnhancements() { startStateFilter(); startAnnotationFilter(); }

  // 筛选界面需要 body 和平台脚本标签；等待页面解析完毕再初始化。
  if (document.readyState === 'loading' || !document.body) {
    document.addEventListener('DOMContentLoaded', startFilterEnhancements, { once: true });
  } else {
    startFilterEnhancements();
  }
})();
