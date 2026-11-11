// ==UserScript==
// @name         Insta360 清空标注并恢复待标注
// @namespace    insta360-local-tools
// @version      1.0.5
// @description  对勾选任务或指定 ID 直接清理，预览与下载备份可选，清空标注、草稿和预标注并核查状态。
// @homepageURL  https://github.com/chengzi-1225/Insta360-chengzi
// @updateURL    https://raw.githubusercontent.com/chengzi-1225/Insta360-chengzi/main/label-studio-reset-annotations.meta.js
// @downloadURL  https://raw.githubusercontent.com/chengzi-1225/Insta360-chengzi/main/label-studio-reset-annotations.user.js
// @match        https://label.insta360.com/workspaces/*/projects/*/data*
// @match        https://label.insta360.com/projects/*/data*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const TASK_TABLES = '.dm-table, .dm-data-view table, .dm-data-view [role="table"], .dm-data-view [role="grid"]';
  const TASK_ROWS = '.dm-table-row, tbody tr, [role="row"]';

  function idOf(value) {
    if (value && typeof value === 'object') value = value.id;
    if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) {
      throw new Error('接口返回了无效 ID');
    }
    return Number(value);
  }

  function reference(value) { return value == null ? null : idOf(value); }

  function parseIds(text) {
    const tokens = String(text).trim().split(/[\s,，;；]+/).filter(Boolean);
    if (!tokens.length) throw new Error('请填写任务 ID');
    if (tokens.some(token => !/^\d+$/.test(token))) throw new Error('任务 ID 只能包含整数、空格、换行或逗号');
    return Array.from(new Set(tokens.map(idOf)));
  }

  // Read only explicit task-ID columns/attributes. Never scrape arbitrary numbers from page text.
  function captureTaskIds(doc, pageUrl) {
    const project = new URL(pageUrl).pathname.match(/\/projects\/(\d+)\/data(?:\/|$)/)?.[1];
    const empty = { ids: [], pageIds: [], source: 'page', selectedCount: 0, rowCount: 0, issue: '' };
    if (!project) return { ...empty, issue: '请在项目数据列表页面使用' };
    const visibility = new WeakMap();
    function visible(element) {
      if (!element || element.nodeType !== 1) return true;
      if (visibility.has(element)) return visibility.get(element);
      const style = doc.defaultView?.getComputedStyle(element);
      const result = !element.hidden && element.getAttribute('aria-hidden') !== 'true' &&
        style?.display !== 'none' && style?.visibility !== 'hidden' && visible(element.parentElement);
      visibility.set(element, result);
      return result;
    }
    function safeId(value) { try { return idOf(String(value ?? '').trim()); } catch { return null; } }
    function idColumn(header) {
      const key = header.getAttribute('data-id') || header.getAttribute('data-field');
      if (key) return /^(?:tasks:)?id$/i.test(key);
      return /^(?:id(?:[（(]任务id[)）])?|taskid|任务id)$/i.test(header.textContent.replace(/\s+/g, ''));
    }
    const rows = [];
    for (const table of doc.querySelectorAll(TASK_TABLES)) {
      if (!visible(table)) continue;
      const headers = Array.from(table.querySelectorAll('.dm-table-head .dm-table__cell, thead th, [role="columnheader"]'));
      const idColumns = headers.map((header, index) => idColumn(header) ? index : -1).filter(index => index >= 0);
      for (const row of table.querySelectorAll(TASK_ROWS)) {
        if (row.closest(TASK_TABLES) !== table || !visible(row) || row.closest('thead, .dm-table-head') ||
          row.querySelector('[role="columnheader"]')) continue;
        const wrapper = row.closest('.dm-table__row-wrapper') || row;
        const selected = row.getAttribute('aria-selected') === 'true' || wrapper.getAttribute('aria-selected') === 'true' ||
          wrapper.matches('.dm-table__row-wrapper_selected, .dm-table__row-wrapper_selected_true') ||
          !!row.querySelector('input[type="checkbox"]:checked, [role="checkbox"][aria-checked="true"]');
        const cells = row.querySelectorAll(':scope > .dm-table__cell, :scope > td, :scope > [role="cell"], :scope > [role="gridcell"]');
        const candidates = [];
        const attributeId = row.getAttribute('data-task-id') || wrapper.getAttribute('data-task-id');
        if (attributeId != null) candidates.push(safeId(attributeId));
        idColumns.forEach(index => candidates.push(safeId(cells[index]?.textContent)));
        if (!candidates.length) { rows.push({ id: null, selected }); continue; }
        const loading = row.matches('.loading') || !!row.closest('.dm-table__row-wrapper_loading, [aria-busy="true"]');
        const id = !loading && candidates.every(value => value && value === candidates[0]) ? candidates[0] : null;
        rows.push({ id, selected });
      }
    }
    const selected = rows.filter(row => row.selected);
    const chosen = selected.length ? selected : rows;
    const pageIds = Array.from(new Set(rows.filter(row => row.id).map(row => row.id)));
    const result = { ...empty, pageIds, source: selected.length ? 'selected' : 'page',
      selectedCount: selected.length, rowCount: rows.length };
    if (chosen.some(row => !row.id)) return { ...result,
      issue: selected.length ? '有勾选行的任务 ID 未识别，已暂停捕捉；请显示任务 ID 列后重试'
        : '部分任务 ID 未识别，已暂停捕捉；请显示任务 ID 列并等待列表加载完成' };
    result.ids = Array.from(new Set(chosen.map(row => row.id)));
    if (!result.ids.length) result.issue = '未捕捉到任务 ID，请等待列表加载，或显示任务 ID 列后点击“重新捕捉”';
    return result;
  }

  function stableJson(value) {
    function sort(item) {
      if (Array.isArray(item)) return item.map(sort);
      if (item && typeof item === 'object') {
        const out = {};
        Object.keys(item).sort().forEach(key => { out[key] = sort(item[key]); });
        return out;
      }
      return item;
    }
    return JSON.stringify(sort(value));
  }

  function nativeSelection(page, pageUrl) {
    const url = new URL(pageUrl), projectId = idOf(url.pathname.match(/\/projects\/(\d+)\/data(?:\/|$)/)?.[1]);
    const dm = page.dataManager || page.DM, store = dm?.store || dm;
    const view = store?.currentView, selected = view?.selected;
    if (!selected || typeof selected.all !== 'boolean' || !Array.isArray(selected.list)) {
      throw new Error('无法读取平台原生跨页勾选范围，请刷新页面后重试，或直接输入完整 ID；不会退回当前可见行');
    }
    const project = store.project?.id ?? store.SDK?.projectId;
    if (project == null || idOf(project) !== projectId) throw new Error('勾选范围的项目不匹配，请等待当前项目加载');
    const tab = url.searchParams.get('tab');
    if (tab && String(view.id) !== tab && String(view.tabKey) !== tab) throw new Error('勾选视图已切换，请等待列表加载');
    const list = Array.from(new Set(Array.from(selected.list, idOf)));
    const count = Number(view.selectedCount);
    if (!Number.isSafeInteger(count) || count < 1) throw new Error('请先勾选需要处理的任务');
    if (selected.all === false && count !== list.length) throw new Error('平台勾选数量与 ID 列表数量不一致，未读取局部范围');
    let query = typeof view.query === 'string' ? JSON.parse(view.query) : view.query;
    query = JSON.parse(JSON.stringify(query || {}));
    if (selected.all && (!query.filters || !Array.isArray(query.filters.items))) throw new Error('无法读取完整筛选条件，未读取全选范围');
    query.selectedItems = selected.all ? { all: true, excluded: list } : { all: false, included: list };
    query.ordering = ['id'];
    return { projectId, viewId: view.id, count, query };
  }

  async function resolveSelection({ api, scope, shouldStop = () => false, onProgress = () => {} }) {
    const check = () => { if (shouldStop()) throw new Error('勾选范围变化或已停止，请重新读取'); };
    check();
    const selection = scope.query.selectedItems;
    if (!selection.all) { onProgress(selection.included.length); return selection.included.slice(); }
    function path(query, page, size) {
      const params = new URLSearchParams({ project: String(scope.projectId), page: String(page), page_size: String(size),
        fields: 'task_only', include: 'id,project', resolve_uri: 'false', query: JSON.stringify(query) });
      return `/api/dm/tasks?${params}`;
    }
    function unpack(data) {
      const rows = data?.tasks ?? data?.results, total = data?.total ?? data?.count;
      if (!Array.isArray(rows) || !Number.isSafeInteger(total) || total < rows.length || total < 0) throw new Error('选择接口未返回可靠的列表和数量');
      return { rows, total };
    }
    // Detect servers or installed list hooks that silently discard selection filters.
    const probe = unpack(await api(path({ ...scope.query, selectedItems: { all: false, included: [0] } }, 1, 1)));
    check();
    if (probe.total !== 0 || probe.rows.length) throw new Error('接口未执行选择筛选，已停止读取');
    const ids = [], seen = new Set(), excluded = new Set(selection.excluded);
    for (let page = 1; ids.length < scope.count; page++) {
      check();
      const { rows, total } = unpack(await api(path(scope.query, page, 500)));
      check();
      if (total !== scope.count || !rows.length) throw new Error(`勾选数量不一致：平台勾选 ${scope.count} 条，接口返回 ${total} 条，已读取 ${ids.length} 条`);
      for (const row of rows) {
        const id = idOf(row.id);
        if (seen.has(id)) throw new Error('选择分页返回重复 ID，未采用不完整范围');
        if (excluded.has(id) || (row.project != null && reference(row.project) !== scope.projectId)) throw new Error('选择分页超出勾选范围或当前项目');
        seen.add(id); ids.push(id);
      }
      if (ids.length > scope.count) throw new Error('选择分页数量超出勾选数量');
      onProgress(ids.length);
    }
    check(); return ids;
  }

  function makeError(message, extra = {}) { return Object.assign(new Error(message), extra); }

  function createApi({ origin, csrf, fetch: fetchRequest }) {
    return async function api(path, method = 'GET', body) {
      const url = new URL(path, origin);
      if (url.origin !== origin || !url.pathname.startsWith('/api/')) throw new Error('仅允许同站点 API 请求');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);
      try {
        const headers = { Accept: 'application/json' };
        if (method !== 'GET') {
          const token = csrf();
          if (!token) throw makeError('未找到 CSRF 令牌，请刷新并确认已登录', { fatal: true });
          headers['X-CSRFToken'] = token;
        }
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        let response;
        try {
          response = await fetchRequest(url.href, { method, headers, credentials: 'same-origin',
            redirect: 'error', cache: 'no-store', signal: controller.signal,
            ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        } catch (error) {
          throw makeError(error.name === 'AbortError' ? '请求超时，写入结果需核查' : '网络连接失败，写入结果需核查', { status: 0 });
        }
        let text;
        try { text = await response.text(); }
        catch (error) { throw makeError('响应接收失败，写入结果需核查', { status: 0 }); }
        let data = null;
        if (text) {
          try { data = JSON.parse(text); }
          catch (error) {
            throw makeError(`接口未返回 JSON（HTTP ${response.status}），请检查登录状态或接口兼容性`,
              { status: response.status, fatal: response.ok });
          }
        }
        if (!response.ok) {
          const detail = data?.detail ?? data?.validation_errors ?? data?.error ?? data ?? response.statusText;
          throw makeError(`HTTP ${response.status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`.slice(0, 900),
            { status: response.status, fatal: response.status === 401 || response.status === 403 });
        }
        return data;
      } finally { clearTimeout(timer); }
    };
  }

  const pendingStates = ['CREATED', 'PENDING_ANNOTATION', 'PENDING', 'NEW', 'TO_ANNOTATE', 'UNLABELED', 'TODO', '待标注'];
  function stateOf(task) {
    const raw = task?.state ?? task?.task_state ?? task?.workflow_state ?? task?.current_state;
    const value = raw && typeof raw === 'object' ? raw.value ?? raw.code ?? raw.state : raw;
    return value == null ? '' : String(value).trim().toUpperCase();
  }
  function content(entry) {
    // Exclude only top-level display/audit metadata. Never strip keys from result:
    // a custom annotation answer can legitimately use any of these field names.
    const metadata = new Set(['created_ago', 'updated_ago', 'created_username', 'updated_username',
      'created_at', 'updated_at', 'draft_created_at', 'lead_time', 'last_action', 'updated_by', 'last_created_by']);
    const references = new Set(['task', 'project', 'completed_by', 'created_by', 'user',
      'annotation', 'parent_annotation', 'parent_prediction']);
    function normalizeRecord(row) {
      const result = {};
      for (const [key, value] of Object.entries(row)) {
        if (metadata.has(key)) continue;
        result[key] = references.has(key) && value && typeof value === 'object' && value.id != null ? idOf(value.id) : value;
      }
      return result;
    }
    const sorted = rows => rows.slice().sort((a, b) => idOf(a.id) - idOf(b.id)).map(normalizeRecord);
    return stableJson({ project: idOf(entry.task.project), data: entry.task.data,
      annotations: sorted(entry.task.annotations), predictions: sorted(entry.task.predictions), drafts: sorted(entry.drafts) });
  }
  function changeError(before, after, message, compareState = true) {
    const previous = JSON.parse(content(before)), current = JSON.parse(content(after));
    if (compareState) { previous.state = before.state; current.state = after.state; }
    const changes = [], changeValues = [];
    function visit(left, right, path) {
      if (changes.length >= 6 || stableJson(left) === stableJson(right)) return;
      if (left == null || right == null || typeof left !== 'object' || typeof right !== 'object' ||
        Array.isArray(left) !== Array.isArray(right)) {
        changes.push(path || 'task');
        if (/(?:^|\.)state(?:\.|$)/.test(path)) changeValues.push({ path, before: left, after: right });
        return;
      }
      if (Array.isArray(left) && [...left, ...right].every(row => row && typeof row === 'object' && row.id != null)) {
        const oldRows = new Map(left.map(row => [String(row.id), row]));
        const newRows = new Map(right.map(row => [String(row.id), row]));
        for (const id of new Set([...oldRows.keys(), ...newRows.keys()])) visit(oldRows.get(id), newRows.get(id), `${path}[id=${id}]`);
      } else {
        for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
          visit(left[key], right[key], Array.isArray(left) ? `${path}[${key}]` : path ? `${path}.${key}` : key);
        }
      }
    }
    visit(previous, current, '');
    const display = value => (stableJson(value) ?? '未返回').slice(0, 160);
    const values = changeValues.map(row => `${row.path}: ${display(row.before)} → ${display(row.after)}`).join('；');
    return makeError(`${message}；变化字段：${changes.join('、') || '未识别'}${values ? `；${values}` : ''}。请重新预览。`,
      { fatal: true, changes, changeValues });
  }
  async function taskState(api, task, projectId) {
    const direct = stateOf(task);
    if (direct) return direct;
    const query = encodeURIComponent(JSON.stringify({ selectedItems: { all: false, included: [idOf(task.id)], excluded: [] } }));
    const data = await api(`/api/dm/tasks?project=${projectId}&page=1&page_size=2&query=${query}`);
    const rows = Array.isArray(data) ? data : data?.tasks ?? data?.results;
    if (!Array.isArray(rows) || rows.length !== 1 || idOf(rows[0].id) !== idOf(task.id)) {
      throw new Error('列表接口未准确返回当前任务，无法核实状态');
    }
    const state = stateOf(rows[0]);
    if (!state) throw new Error('接口未返回任务状态，无法确认待标注');
    return state;
  }
  async function independentAnnotations(api, entry) {
    const initial = `/api/tasks/${entry.taskId}/annotations/`;
    let path = initial;
    const rows = [], seen = new Set(), visited = new Set();
    while (path) {
      if (visited.has(path) || visited.size >= 1000) throw new Error('独立标注核查分页异常');
      visited.add(path);
      const response = await api(path);
      const page = Array.isArray(response) ? response : response?.results;
      if (!Array.isArray(page)) throw new Error('独立标注接口未返回完整列表，不能确认已清空');
      for (const row of page) {
        const id = idOf(row.id);
        if (seen.has(id) || row.is_stub === true || !Array.isArray(row.result) || (row.task != null && reference(row.task) !== entry.taskId)) {
          throw new Error('独立标注列表不完整、重复或含其他任务的记录');
        }
        seen.add(id); rows.push(row);
      }
      if (!Array.isArray(response) && response?.count != null && (!Number.isSafeInteger(response.count) || (!response.next && response.count !== rows.length))) {
        throw new Error('独立标注列表数量不匹配，不能确认已清空');
      }
      const next = !Array.isArray(response) && response?.next;
      if (!next) break;
      const url = new URL(next, 'https://label.insta360.com');
      if (url.origin !== 'https://label.insta360.com' || url.pathname !== initial) throw new Error('独立标注分页超出当前任务');
      path = url.pathname + url.search;
    }
    // The list endpoint excludes cancelled annotations on some deployments; retain
    // records returned by task detail, and include any records the detail omitted.
    const merged = new Map(entry.task.annotations.map(row => [idOf(row.id), row]));
    rows.forEach(row => merged.set(idOf(row.id), row));
    entry.task.annotations = Array.from(merged.values());
    entry.independentAnnotationCount = rows.length;
    entry.fingerprint = content(entry);
    return entry;
  }
  async function snapshot(api, taskId, projectId, crossCheck = false) {
    const task = await api(`/api/tasks/${taskId}/?resolve_uri=false&annotations_stub=false`);
    if (!task || idOf(task.id) !== taskId || idOf(task.project) !== projectId) {
      throw new Error(`任务 ${taskId} 的 ID 或项目不匹配，停止处理`);
    }
    for (const name of ['annotations', 'predictions']) {
      if (!Array.isArray(task[name])) throw new Error(`任务未返回完整 ${name}，停止处理`);
      const ids = new Set();
      for (const row of task[name]) {
        const id = idOf(row.id);
        if (ids.has(id) || row.is_stub === true || !Array.isArray(row.result)) throw new Error(`${name} 数据不完整或 ID 重复`);
        ids.add(id);
        if (row.task != null && reference(row.task) !== taskId) throw new Error(`${name} 含其他任务的记录`);
      }
    }
    // This Label Studio route intentionally has no trailing slash.
    const initial = `/api/tasks/${taskId}/drafts`;
    let path = initial;
    const drafts = [], visited = new Set(), ids = new Set();
    while (path) {
      if (visited.has(path) || visited.size >= 100) throw new Error('草稿分页异常');
      visited.add(path);
      const response = await api(path);
      const rows = Array.isArray(response) ? response : response?.results;
      if (!Array.isArray(rows)) throw new Error('接口未返回完整草稿列表');
      for (const row of rows) {
        const id = idOf(row.id);
        if (reference(row.task) !== taskId || ids.has(id) || !Array.isArray(row.result)) throw new Error('草稿不完整、任务不符或分页重复');
        ids.add(id); drafts.push(row);
      }
      const next = !Array.isArray(response) && response?.next;
      if (!next) { path = null; continue; }
      const url = new URL(next, 'https://label.insta360.com');
      if (url.origin !== 'https://label.insta360.com' || url.pathname.replace(/\/$/, '') !== initial) throw new Error('草稿分页超出当前任务');
      path = url.pathname + url.search;
    }
    const entry = { taskId, task, drafts, state: await taskState(api, task, projectId) };
    entry.fingerprint = content(entry);
    return crossCheck ? independentAnnotations(api, entry) : entry;
  }
  async function preview({ api, projectId, taskIds, crossCheck = false, shouldStop = () => false, onProgress = () => {} }) {
    projectId = idOf(projectId); taskIds = parseIds(taskIds.join('\n'));
    const plan = { version: 1, projectId, taskIds, runId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: new Date().toISOString(), entries: [], stopped: false };
    const stopped = () => { if (shouldStop()) plan.stopped = true; return plan.stopped; };
    await runConcurrent(taskIds, 3, stopped, async taskId => {
      try { plan.entries.push({ ...await snapshot(api, taskId, projectId, crossCheck), status: 'ready' }); }
      catch (error) { plan.entries.push({ taskId, status: 'failed', error: error.message }); }
      onProgress(plan);
    });
    return plan;
  }
  async function runConcurrent(items, limit, stopped, process) {
    let next = 0;
    async function worker() {
      while (next < items.length && !stopped()) {
        const item = items[next++];
        await process(item);
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  }
  function verifyEmpty(entry) {
    if (entry.task.annotations.length || entry.task.predictions.length || entry.drafts.length) throw new Error('标注、草稿或预标注尚未全部清空');
    for (const key of ['total_annotations', 'cancelled_annotations', 'total_predictions', 'total_drafts']) {
      if (entry.task[key] != null && Number(entry.task[key]) !== 0) throw new Error(`记录已清空，但 ${key} 统计尚未归零`);
    }
    if (entry.task.is_labeled === true) throw new Error('记录已清空，但平台仍标记为已标注');
  }
  function createDirectPlan(projectId, taskIds) {
    projectId = idOf(projectId); taskIds = parseIds(taskIds.join('\n'));
    return { version: 1, mode: 'direct', projectId, taskIds,
      runId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, createdAt: new Date().toISOString(),
      entries: taskIds.map(taskId => ({ taskId, status: 'direct' })) };
  }
  function nativeCleanupActions(catalog) {
    if (!Array.isArray(catalog)) throw new Error('平台原生动作列表格式不匹配，请导出接口诊断');
    const kinds = [
      { kind: 'reviews', ids: ['delete_tasks_reviews'], titles: ['delete reviews and scores', 'delete reviews', '删除审核和评分', '删除审核及评分'] },
      { kind: 'acceptances', ids: ['delete_tasks_acceptances'], titles: ['delete acceptances', '删除验收'] },
      { kind: 'reviewers', ids: ['delete_reviewers'], titles: ['delete reviewers', '删除审核员'] },
      { kind: 'annotators', ids: ['delete_annotators'], titles: ['delete annotators', '删除标注员'] },
    ];
    const result = [];
    for (const group of kinds) {
      const matches = catalog.filter(action => !action.disabled && /^[a-zA-Z0-9_-]+$/.test(String(action.id)) && action.id !== 'delete_tasks' &&
        (group.ids.includes(action.id) || group.titles.includes(String(action.title || '').trim().toLowerCase())));
      if (matches.length > 1) throw new Error(`平台提供多个 ${group.kind} 清理动作，请导出接口诊断确认`);
      if (matches[0]) result.push({ ...matches[0], kind: group.kind });
    }
    return result;
  }
  function nativeFormBody(action) {
    const form = action.dialog?.form;
    if (form == null) return {};
    if (!Array.isArray(form)) throw new Error(`原生动作 ${action.title} 的表单无法识别，请导出接口诊断`);
    const fields = form.flatMap(row => [...(row.fields || []), ...(row.columns || []).flatMap(column => column.fields || [])]);
    const body = {};
    for (const field of fields) {
      if (!/^(?:annotator|reviewer|user)(?:s|_id|_ids)?$/.test(field.name || '') || field.required) {
        throw new Error(`原生动作 ${action.title} 需要确认字段 ${field.name || '未知'}，未自动提交`);
      }
      // The native deletion dialogs use null for all users. Never select one person's default.
      body[field.name] = null;
    }
    return body;
  }
  function contentAroundNative(entry, kind) {
    const value = JSON.parse(content(entry));
    const fieldsByKind = {
      reviews: ['state', 'review', 'review_id', 'reviewId', 'reviews', 'reviewers', 'reviewed_by', 'reviewed_at',
        'review_status', 'reviewed', 'score', 'scores', 'review_score', 'total_reviews'],
      acceptances: ['state', 'acceptance', 'acceptance_id', 'acceptances', 'accepted_by', 'accepted_at', 'acceptance_status'],
      reviewers: ['reviewer', 'reviewers', 'reviewed_by', 'assigned_reviewers'],
      annotators: ['completed_by', 'annotator', 'annotators', 'assigned_annotators'],
    };
    const fields = (Array.isArray(kind) ? kind : [kind]).flatMap(name => fieldsByKind[name] || []);
    value.annotations.forEach(row => fields.forEach(key => { delete row[key]; }));
    return stableJson(value);
  }
  function verification(entry) {
    return { checkedAt: new Date().toISOString(), taskId: entry.taskId, state: entry.state,
      annotations: entry.task.annotations.length, drafts: entry.drafts.length, predictions: entry.task.predictions.length,
      independentAnnotationCount: entry.independentAnnotationCount,
      annotationIds: entry.task.annotations.map(row => idOf(row.id)),
      draftIds: entry.drafts.map(row => idOf(row.id)), predictionIds: entry.task.predictions.map(row => idOf(row.id)) };
  }
  function remainingText(entry) {
    return `服务器剩余：标注 ${entry.task.annotations.length} / 草稿 ${entry.drafts.length} / 预标注 ${entry.task.predictions.length}`;
  }
  async function executeBatches({ api, plan, persist, actions, shouldStop, onProgress }) {
    const report = { version: 1, runId: plan.runId, projectId: plan.projectId, mode: 'direct', strategy: 'native-batch',
      batchSize: 100, results: [], stopped: false, startedAt: new Date().toISOString(),
      nativeActionsAvailable: actions.map(({ id, title, kind }) => ({ id, title, kind })) };
    const stopped = () => {
      if (shouldStop()) { report.stopped = true; report.stopReason ??= { message: '用户停止或页面切换' }; }
      return report.stopped;
    };
    const checkStop = () => { if (stopped()) throw makeError('已停止；已发出的批量请求仍可能完成，已删内容不会自动恢复', { cancelled: true }); };
    const phase = text => { report.phase = text; onProgress(report); };
    for (let offset = 0; offset < plan.entries.length && !stopped(); offset += report.batchSize) {
      const originals = plan.entries.slice(offset, offset + report.batchSize);
      const entries = new Map(), finals = new Map(), receipts = [];
      const label = `第 ${Math.floor(offset / report.batchSize) + 1} / ${Math.ceil(plan.entries.length / report.batchSize)} 批`;
      let batchError, writesStarted = false;
      const readAll = async (target, backup = false, compare = false) => {
        let error;
        await runConcurrent(originals, 8, () => false, async original => {
          try {
            if (backup) checkStop();
            const entry = await snapshot(api, original.taskId, plan.projectId, true);
            if (compare) {
              const before = entries.get(original.taskId);
              if (entry.fingerprint !== before.fingerprint || entry.state !== before.state) {
                throw changeError(before, entry, '批量清理前内容或状态发生变化，整批未执行删除');
              }
            }
            target.set(original.taskId, entry);
            if (backup) {
              try { await persist({ runId: plan.runId, projectId: plan.projectId, entry }); }
              catch (cause) { throw makeError(`本地备份失败，整批未开始清空：${cause.message}`, { fatal: true }); }
            }
          } catch (cause) { error ??= cause; }
        });
        if (error) throw error;
      };
      try {
        // Validate all forms before the first write; never guess a state-transition form.
        const forms = new Map(actions.map(action => [action.id, nativeFormBody(action)]));
        phase(`${label} · 读取并保存 ${originals.length} 个任务的本机备份`);
        await readAll(entries, true);
        checkStop(); phase(`${label} · 核对备份后内容`);
        const fresh = new Map(); await readAll(fresh, false, true);
        const invoke = async action => {
          checkStop(); phase(`${label} · 批量执行 ${action.title}`);
          writesStarted = true;
          const params = new URLSearchParams({ project: String(plan.projectId), id: action.id });
          let response;
          try {
            response = await api(`/api/dm/actions/?${params}`, 'POST', { ...forms.get(action.id),
              selectedItems: { all: false, included: originals.map(row => row.taskId), excluded: [] },
              filters: { conjunction: 'and', items: [] }, ordering: [] });
          } catch (error) {
            throw makeError(`批量动作 ${action.title} 失败：${error.message}；未重复提交`, { uncertain: error.status === 0, status: error.status });
          }
          const receipt = { id: action.id, title: action.title, kind: action.kind, scope: 'batch',
            taskIds: originals.map(row => row.taskId), status: 'applied', response };
          receipts.push(receipt);
          if (response?.error) throw makeError(`批量动作 ${action.title} 失败：${response.detail || JSON.stringify(response.error)}`);
          if (response?.async === true || response?.job || response?.job_id) {
            receipt.status = 'pending';
            if (!['annotations', 'predictions'].includes(action.kind)) {
              throw makeError(`批量动作 ${action.title} 已交给平台后台处理，尚未确认完成；未重复提交，请稍后独立核查`, { uncertain: true });
            }
            // Native content deletion may run in the background without a job ID.
            // Poll only outstanding tasks; never resubmit a destructive action.
            let pending = originals.slice();
            const deadline = Date.now() + 120000;
            for (let attempt = 0; pending.length && attempt < 60; attempt++) {
              if (stopped()) throw makeError('已停止等待；平台后台删除可能继续执行，请稍后核查，未重复提交', { uncertain: true, cancelled: true });
              phase(`${label} · 平台后台删除中，仅回查剩余 ${pending.length} 个任务`);
              const remaining = []; let readError;
              await runConcurrent(pending, 8, () => false, async original => {
                try {
                  const current = await snapshot(api, original.taskId, plan.projectId, true);
                  if (stableJson(current.task.data) !== stableJson(entries.get(original.taskId).task.data)) throw new Error('后台处理期间源数据发生变化');
                  const hasContent = action.kind === 'annotations' ? current.task.annotations.length || current.drafts.length : current.task.predictions.length;
                  if (hasContent) remaining.push(original);
                } catch (error) { readError ??= error; }
              });
              if (readError) throw makeError(`后台删除已提交，但回查失败：${readError.message}`, { uncertain: true });
              pending = remaining;
              if (!pending.length) { receipt.status = 'applied'; break; }
              if (Date.now() >= deadline) break;
              await new Promise(resolve => setTimeout(resolve, 2000));
            }
            if (pending.length) throw makeError(`后台删除尚有 ${pending.length} 个任务未确认完成；已暂停后续批次，请稍后核查，未重复提交`, { uncertain: true });
          }
        };
        const metadata = actions.filter(action => !['annotations', 'predictions'].includes(action.kind));
        for (const action of metadata) await invoke(action);
        if (metadata.length) {
          phase(`${label} · 核对关联清理后的实际标注内容`);
          const afterMetadata = new Map(); await readAll(afterMetadata);
          for (const original of originals) {
            const before = entries.get(original.taskId), after = afterMetadata.get(original.taskId);
            if (contentAroundNative(before, metadata.map(action => action.kind)) !== contentAroundNative(after, metadata.map(action => action.kind))) {
              throw makeError(`任务 ${original.taskId} 原生关联清理后实际标注内容发生变化，已停止后续删除`);
            }
          }
        }
        for (const action of actions.filter(action => ['annotations', 'predictions'].includes(action.kind))) {
          // Detail counters may be zero while a separate editor still has records.
          // Let the platform delete all children of these explicit task IDs.
          await invoke(action);
        }
      } catch (error) {
        batchError = error; report.stopped = true;
        report.stopReason ??= { message: error.message };
      }
      // Always settle an issued batch by reading each task, even after the user presses Stop.
      phase(`${label} · 独立回查每个任务，未清空不会显示完成`);
      let readError;
      try { await readAll(finals); } catch (error) { readError = error; }
      for (const original of originals) {
        const result = { taskId: original.taskId, status: 'failed', removed: { annotations: [], drafts: [], predictions: [] },
          nativeActions: receipts.map(receipt => ({ ...receipt })), writesStarted };
        const before = entries.get(original.taskId), final = finals.get(original.taskId);
        if (final) {
          result.verification = verification(final); result.state = final.state;
          if (before) for (const kind of ['annotations', 'drafts', 'predictions']) {
            const old = kind === 'drafts' ? before.drafts : before.task[kind];
            const remaining = new Set((kind === 'drafts' ? final.drafts : final.task[kind]).map(row => idOf(row.id)));
            result.removed[kind] = old.map(row => idOf(row.id)).filter(id => !remaining.has(id));
          }
        }
        let error = batchError;
        if (!final) error = makeError(`无法独立回查：${readError?.message || '任务未返回'}`, { uncertain: writesStarted });
        if (!error && before && stableJson(before.task.data) !== stableJson(final.task.data)) error = makeError('原始视频或源数据发生变化，请核查备份');
        if (!error) {
          try {
            verifyEmpty(final);
            if (!pendingStates.includes(final.state)) throw new Error(`内容为空，但状态仍为 ${final.state}，尚未恢复待标注`);
          } catch (cause) { error = cause; }
        }
        if (error) {
          result.error = `${error.message}${final ? `；${remainingText(final)}` : ''}`;
          const removed = Object.values(result.removed).some(ids => ids.length);
          result.status = error.uncertain ? 'unknown' : removed ? 'partial' : error.cancelled && !writesStarted ? 'stopped' : writesStarted ? 'unknown' : 'failed';
          report.stopped = true; report.stopReason ??= { taskId: result.taskId, message: result.error };
        } else {
          result.status = 'success';
          result.message = `已执行 ${receipts.filter(row => !['annotations', 'predictions'].includes(row.kind)).length} 项平台原生关联清理；${remainingText(final)}，待标注（${final.state}）`;
        }
        report.results.push(result); onProgress(report);
      }
    }
    report.finishedAt = new Date().toISOString(); return report;
  }
  async function execute({ api, plan, persist, nativeCleanup = false, shouldStop = () => false, onProgress = () => {} }) {
    const catalog = nativeCleanup ? await api(`/api/dm/actions/?project=${idOf(plan.projectId)}`) : [];
    const nativeActions = nativeCleanupActions(catalog);
    const contentActions = ['annotations', 'predictions'].map(kind => {
      const action = catalog.find(row => row.id === `delete_tasks_${kind}` && !row.disabled);
      return action && { ...action, kind };
    });
    if (plan.mode === 'direct' && contentActions.every(Boolean)) {
      return executeBatches({ api, plan, persist, actions: [...nativeActions, ...contentActions], shouldStop, onProgress });
    }
    const report = { version: 1, runId: plan.runId, projectId: idOf(plan.projectId), results: [], stopped: false,
      nativeActionsAvailable: nativeActions.map(action => ({ id: action.id, title: action.title, kind: action.kind })),
      mode: plan.mode === 'direct' ? 'direct' : 'preview', startedAt: new Date().toISOString() };
    const stopped = () => {
      if (shouldStop()) {
        report.stopped = true;
        report.stopReason ??= { message: '用户停止或页面切换' };
      }
      return report.stopped;
    };
    await runConcurrent(plan.entries, 3, stopped, async original => {
      const result = { taskId: original.taskId, status: 'failed', removed: { drafts: [], annotations: [], predictions: [] },
        nativeActions: [], writesStarted: false };
      try {
        if (original.status !== 'ready' && !(plan.mode === 'direct' && original.status === 'direct')) throw new Error(original.error || '任务未通过预览');
        let expected = await snapshot(api, original.taskId, plan.projectId);
        if (plan.mode === 'direct') original = { ...expected, status: 'ready' };
        if (expected.fingerprint !== original.fingerprint || expected.state !== original.state) {
          throw changeError(original, expected, '预览后实际标注内容或任务状态发生变化，未执行删除');
        }
        try { await persist({ runId: plan.runId, projectId: plan.projectId, entry: expected }); }
        catch (error) { throw makeError(`本地备份失败，未开始清空：${error.message}`, { fatal: true }); }
        const checkStop = () => {
          if (!stopped()) return;
          const names = { drafts: '草稿', annotations: '标注', predictions: '预标注' };
          const removed = Object.entries(result.removed).filter(([, ids]) => ids.length)
            .map(([kind, ids]) => `${names[kind]} ${ids.length} 条（ID ${ids.slice(0, 8).join(', ')}${ids.length > 8 ? '…' : ''}）`).join('、');
          const applied = result.nativeActions.filter(action => action.status === 'applied').map(action => action.title).join('、');
          const outcome = removed ? `已确认删除：${removed}；后续未执行，已删记录不会自动恢复`
            : applied ? `已执行原生关联清理：${applied}；尚未删除标注、草稿或预标注` : '本任务未发出删除或修改请求';
          const cause = report.stopReason ? `；触发原因：${report.stopReason.taskId ? `任务 ${report.stopReason.taskId} · ` : ''}${report.stopReason.message}` : '';
          throw makeError(`已停止；${outcome}${cause}`, { fatal: true, cancelled: true });
        };
        checkStop();
        // Persisting can take time. Recheck once after backup, then reuse each
        // immediately preceding deletion check rather than rereading the same task twice.
        const afterBackup = await snapshot(api, original.taskId, plan.projectId);
        if (afterBackup.fingerprint !== expected.fingerprint || afterBackup.state !== expected.state) {
          throw changeError(expected, afterBackup, '备份期间实际内容或状态发生变化，未执行删除');
        }
        expected = afterBackup;
        for (const action of nativeActions) {
          checkStop();
          const extra = nativeFormBody(action);
          const params = new URLSearchParams({ project: String(plan.projectId), id: action.id });
          result.writesStarted = true;
          let response, writeError;
          try {
            response = await api(`/api/dm/actions/?${params}`, 'POST', {
              ...extra, selectedItems: { all: false, included: [original.taskId], excluded: [] },
              filters: { conjunction: 'and', items: [] }, ordering: [],
            });
          } catch (error) { writeError = error; }
          if (response?.async === true || response?.job || response?.job_id) {
            result.nativeActions.push({ id: action.id, title: action.title, status: 'pending', response });
            throw makeError(`原生动作 ${action.title} 已交给平台后台处理，尚未确认完成；未重复提交，请完成后重新核查`, { uncertain: true });
          }
          if (!writeError && response?.error) writeError = makeError(`原生动作 ${action.title} 失败：${response.detail || JSON.stringify(response.error)}`, { fatal: true });
          if (!writeError) result.nativeActions.push({ id: action.id, title: action.title, status: 'applied', response });
          let after;
          try { after = await snapshot(api, original.taskId, plan.projectId); }
          catch (error) { throw makeError(`原生动作 ${action.title} 已提交，但无法回查：${error.message}`, { uncertain: true }); }
          if (writeError) {
            if (writeError.status === 0) throw makeError(`原生动作 ${action.title} 响应不确定，未重试：${writeError.message}`, { uncertain: true });
            throw makeError(`原生动作 ${action.title}（${action.id}）失败：${writeError.message}`, { status: writeError.status, fatal: true });
          }
          if (contentAroundNative(expected, action.kind) !== contentAroundNative(after, action.kind)) {
            throw makeError(`原生动作 ${action.title} 后实际标注内容或其他记录发生变化，已停止后续删除，请核查结果`, { fatal: true });
          }
          expected = after;
        }
        // Native review/assignment cleanup may change annotation metadata and task state.
        // Record deletion still uses the freshly checked full contents and original IDs.
        for (const kind of ['drafts', 'annotations', 'predictions']) {
          const records = kind === 'drafts' ? original.drafts : original.task[kind];
          for (const record of records) {
            checkStop();
            const id = idOf(record.id);
            result.writesStarted = true;
            let writeError;
            try { await api(`/api/${kind}/${id}/`, 'DELETE'); } catch (error) { writeError = error; }
            let after;
            try { after = await snapshot(api, original.taskId, plan.projectId); }
            catch (error) { throw makeError(`删除请求已发出，但无法回查：${error.message}`, { uncertain: true }); }
            const remaining = kind === 'drafts' ? after.drafts : after.task[kind];
            if (remaining.some(row => idOf(row.id) === id)) {
              const reason = writeError?.message || '删除未生效';
              const advice = writeError?.status === 422 && /审核|打分|评分/.test(reason)
                ? '；平台仍要求先处理审核和评分关联记录，请核查原生操作结果及账号权限，或联系管理员处理。可导出结果与接口诊断继续排查' : '';
              throw makeError(`${kind} ${id} 仍存在：${reason}${advice}`, { status: writeError?.status, fatal: writeError?.fatal });
            }
            result.removed[kind].push(id);
            if (kind === 'drafts') expected.drafts = expected.drafts.filter(row => idOf(row.id) !== id);
            else expected.task[kind] = expected.task[kind].filter(row => idOf(row.id) !== id);
            if (after.fingerprint !== content(expected)) throw changeError(expected, after, '清理期间出现新增或修改内容，已停止，请核查备份', false);
            expected = after;
            if (writeError?.fatal) throw writeError;
          }
        }
        checkStop();
        // expected is the full server response read after the last deletion (or
        // after backup for an already empty task), so it also supplies final verification.
        let final = expected;
        verifyEmpty(final);
        if (!pendingStates.includes(final.state)) {
          const options = await api(`/api/tasks/${original.taskId}/`, 'OPTIONS');
          const field = options?.actions?.PATCH?.state ?? options?.actions?.PUT?.state;
          const choices = Array.isArray(field?.choices) ? field.choices : [];
          const target = choices.find(item => pendingStates.includes(String(item.value ?? item).toUpperCase()));
          if (!field || field.read_only === true || target == null) {
            throw makeError(`内容已清空，但状态仍为 ${final.state}；接口未提供可写的待标注选项，需要管理员核查`, { fatal: true });
          }
          const fresh = await snapshot(api, original.taskId, plan.projectId);
          if (fresh.fingerprint !== final.fingerprint || fresh.state !== final.state) throw changeError(final, fresh, '状态更新前任务发生变化');
          checkStop(); result.writesStarted = true;
          let writeError;
          try { await api(`/api/tasks/${original.taskId}/`, 'PATCH', { state: target.value ?? target }); }
          catch (error) { writeError = error; }
          try { final = await snapshot(api, original.taskId, plan.projectId); }
          catch (error) { throw makeError('状态更新请求已发出，但无法回查', { uncertain: true }); }
          verifyEmpty(final);
          if (!pendingStates.includes(final.state)) throw writeError || makeError(`状态未恢复，当前为 ${final.state}`, { fatal: true });
        }
        result.state = final.state;
        if (nativeCleanup) { await independentAnnotations(api, final); result.verification = verification(final); verifyEmpty(final); }
        result.verification = verification(final);
        result.status = 'success'; result.message = `${result.nativeActions.length ? `已执行 ${result.nativeActions.length} 项平台原生关联清理；` : ''}标注、草稿和预标注已清空，待标注（${final.state}）`;
      } catch (error) {
        result.error = error.message;
        if (error.changes) result.changeDetails = error.changes;
        if (error.changeValues) result.changeValues = error.changeValues;
        const nativeApplied = result.nativeActions.some(action => action.status === 'applied' && action.response?.processed_items !== 0);
        result.status = error.uncertain ? 'unknown' : Object.values(result.removed).some(ids => ids.length) || nativeApplied ? 'partial' : error.cancelled ? 'stopped' : 'failed';
        if (result.writesStarted || error.fatal || error.status === 401 || error.status === 403) {
          report.stopped = true;
          report.stopReason ??= { taskId: result.taskId, message: error.message };
        }
      }
      report.results.push(result); onProgress(report);
    });
    report.finishedAt = new Date().toISOString();
    return report;
  }

  async function diagnose({ api, projectId, taskId }) {
    projectId = idOf(projectId); taskId = idOf(taskId);
    const task = await api(`/api/tasks/${taskId}/?resolve_uri=false&annotations_stub=false`);
    if (idOf(task.id) !== taskId || idOf(task.project) !== projectId) throw new Error('诊断任务的项目不匹配');
    function shape(value, depth = 0) {
      if (value == null) return 'null';
      if (Array.isArray(value)) return { type: 'array', length: value.length };
      if (typeof value !== 'object' || depth >= 3) return typeof value;
      return Object.fromEntries(Object.entries(value).filter(([key]) => !['result', 'data', 'video', 'text'].includes(key))
        .map(([key, item]) => [key, shape(item, depth + 1)]));
    }
    const data = { version: 1, projectId, taskId, state: stateOf(task), createdAt: new Date().toISOString(),
      taskShape: shape(task), records: [] };
    try {
      const taskDetailCount = task.annotations?.length;
      const checked = await independentAnnotations(api, { taskId, task: { ...task, annotations: task.annotations?.slice() || [] }, drafts: [], state: stateOf(task) });
      data.annotationCheck = { taskDetailCount, independentListCount: checked.independentAnnotationCount,
        mergedIds: checked.task.annotations.map(row => idOf(row.id)) };
    } catch (error) { data.annotationCheckError = error.message; }
    try { data.nativeActions = await api(`/api/dm/actions/?project=${projectId}`); }
    catch (error) { data.nativeActionsError = error.message; }
    const targets = [{ kind: 'tasks', id: taskId, shape: shape(task) }];
    for (const kind of ['annotations', 'predictions']) {
      for (const record of (task[kind] || []).slice(0, 3)) targets.push({ kind, id: idOf(record.id), state: stateOf(record), shape: shape(record) });
    }
    for (const target of targets) {
      try { target.options = await api(`/api/${target.kind}/${target.id}/`, 'OPTIONS'); }
      catch (error) { target.error = error.message; }
      data.records.push(target);
    }
    return data;
  }

  const core = { parseIds, captureTaskIds, nativeSelection, resolveSelection, diagnose, createApi, createDirectPlan, nativeCleanupActions, preview, execute, stateOf, content };
  if (typeof module === 'object' && module.exports) { module.exports = core; return; }

  function projectFromUrl() { return Number(location.pathname.match(/\/projects\/(\d+)\/data(?:\/|$)/)?.[1] || 0); }
  function csrfToken() {
    const cookie = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
    return cookie ? decodeURIComponent(cookie[1]) : document.querySelector('input[name="csrfmiddlewaretoken"]')?.value ||
      document.querySelector('meta[name="csrf-token"]')?.content || '';
  }
  function backupStore(value) {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('insta360-reset-annotation-backups', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('backups', { keyPath: 'id' });
      request.onerror = request.onblocked = () => reject(new Error('无法打开本地备份库'));
      request.onsuccess = () => {
        const db = request.result;
        try {
          const transaction = db.transaction('backups', value ? 'readwrite' : 'readonly');
          const result = value ? transaction.objectStore('backups').put({
            id: `${value.runId}/${value.entry.taskId}`, savedAt: new Date().toISOString(), ...value,
          }) : transaction.objectStore('backups').getAll();
          transaction.oncomplete = () => { db.close(); resolve(result.result); };
          transaction.onerror = transaction.onabort = () => { db.close(); reject(new Error('本地备份读写失败')); };
        } catch (error) { db.close(); reject(error); }
      };
    });
  }
  function download(name, data) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = name;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  function mount() {
    if (document.getElementById('insta360-reset-annotations')) return;
    const host = document.createElement('div'); host.id = 'insta360-reset-annotations';
    const demoSlot = ['localhost', '127.0.0.1'].includes(location.hostname) && document.getElementById('reset-demo-slot');
    host.style.cssText = demoSlot ? 'display:block;width:100%;' : 'position:fixed;right:22px;bottom:22px;z-index:2147483600;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      :host{color:#243242;font:13px/1.55 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
      *{box-sizing:border-box}button,textarea,input{font:inherit}button{border:1px solid #d5dce5;background:#fff;color:#344357;padding:8px 11px;border-radius:7px;cursor:pointer;font-weight:600;transition:background .12s}
      button:hover:not(:disabled){background:#f0f5ff}button:disabled{opacity:.42;cursor:default}button:focus-visible,textarea:focus-visible,input:focus-visible{outline:3px solid #81adff;outline-offset:2px}
      button.primary{background:#2768d8;color:white;border-color:#2768d8}button.danger{background:#b93d36;color:white;border-color:#b93d36}button.stop{color:#a32626}
      .toggle{float:right;background:#243b57;color:white;box-shadow:0 4px 20px #18294030;border:0;padding:11px 16px}.panel{width:${demoSlot ? '100%' : '420px'};max-width:calc(100vw - 32px);max-height:${demoSlot ? 'none' : 'calc(100vh - 100px)'};overflow:auto;background:white;border:1px solid #d8e0e9;border-radius:12px;box-shadow:0 12px 48px #142c4a22;margin-bottom:10px;padding:22px}
      .panel[hidden]{display:none}h2{font-size:19px;letter-spacing:-.5px;margin:0 0 3px}.project{font-size:12px;color:#748195;margin:0 0 18px}.hint{font-size:12px;color:#69788c;margin:7px 0}.warning{border-left:3px solid #d3952b;background:#fff8e9;color:#855916;font-size:12px;padding:10px 12px;margin:0 0 18px}
      label{display:block}textarea{width:100%;height:100px;border:1px solid #cbd5e1;border-radius:7px;background:#fbfcfe;padding:10px 12px;margin:8px 0 0;resize:vertical;font-family:ui-monospace,SFMono-Regular,monospace;font-size:13px}
      .row{display:flex;justify-content:space-between;align-items:center;gap:8px}.row label{font-weight:600}.capture{font-size:12px;padding:5px 8px}.scope{min-height:20px;font-size:11px;color:#748195;margin:5px 0 15px}.steps{display:flex;gap:8px}.steps button{flex:1;padding:9px 6px;font-size:12px}
      .status{white-space:pre-wrap;padding:12px;background:#f2f6fb;border:1px solid #e3eaf2;border-radius:7px;margin:14px 0 10px;font-size:12px}.status[data-tone="error"]{background:#fff1ef;color:#9c362e;border-color:#f2d3d0}.status[data-tone="success"]{background:#edf8f3;color:#21694b;border-color:#cde8dc}
      .run{width:100%;padding:11px;margin-top:8px}.log{max-height:180px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;color:#66778c;font:11px/1.8 ui-monospace,SFMono-Regular,monospace;margin:12px 0}
      .tools{display:flex;flex-wrap:wrap;gap:7px;border-top:1px solid #edf0f4;padding-top:12px}.tools button{font-size:11px;padding:5px 8px}.foot{font-size:10px;color:#94a0af;margin:11px 0 0}.update{color:#4879ad;text-decoration:none;margin-left:6px}.update:hover{text-decoration:underline}
      @media(prefers-reduced-motion:reduce){button{transition:none}}
    </style>
    <section class="panel" ${demoSlot ? '' : 'hidden'} aria-label="清空标注工具">
      <h2>清空标注，重新开始</h2><p class="project"></p>
      <p class="warning">优先执行平台提供的审核评分、验收和人员关联清理，再删除标注、草稿及预标注。任务与视频保留。预览及下载备份可选；未下载时执行前弹窗确认。</p>
      <div class="row"><label for="reset-ids">任务 ID</label><button class="capture">读取已勾选任务</button></div>
      <textarea id="reset-ids" aria-label="任务 ID" placeholder="每行一个 ID，或用逗号分隔&#10;例如：24084572" spellcheck="false"></textarea>
      <div class="scope">勾选列表任务后点击读取，或直接输入 ID。</div>
      <div class="steps"><button class="preview">预览范围（可选）</button><button class="backup" disabled>下载备份（可选）</button></div>
      <div class="status" role="status" aria-live="polite">等待选择任务</div>
      <button class="run danger" disabled>直接清空（无需预览）</button><pre class="log"></pre>
      <div class="tools"><button class="stop" disabled>停止</button><button class="verify">核查是否清空</button><button class="export" disabled>导出结果</button><button class="diagnose">导出接口诊断</button><button class="local">导出本机备份</button><button class="refresh">刷新列表</button></div>
      <p class="foot">v1.0.5 · 批量清理 · 保留任务 ID 与原始数据<a class="update" href="https://raw.githubusercontent.com/chengzi-1225/Insta360-chengzi/main/label-studio-reset-annotations.user.js" target="_blank" rel="noopener noreferrer">安装 / 更新</a></p>
    </section><button class="toggle" ${demoSlot ? 'hidden' : ''}>清空标注</button>`;
    (demoSlot || document.documentElement).append(host);
    const $ = s => root.querySelector(s);
    const input = $('textarea'), status = $('.status'), log = $('.log');
    const api = createApi({ origin: location.origin, csrf: csrfToken, fetch: window.fetch.bind(window) });
    let plan = null, report = null, busy = false, downloaded = false, stopRequested = false;
    let route = location.href, disposed = false;
    function message(text, tone = '') { status.textContent = text; status.dataset.tone = tone; }
    const logLines = [];
    function writeLog(text) {
      if (!log.textContent) logLines.length = 0;
      logLines.push(text); if (logLines.length > 300) logLines.shift();
      log.textContent = logLines.join('\n') + '\n'; log.scrollTop = log.scrollHeight;
    }
    function validPlan() { return plan && !plan.stopped && plan.entries.length === plan.taskIds.length && plan.entries.every(e => e.status === 'ready'); }
    function controls() {
      let validIds = false;
      try { validIds = !!projectFromUrl() && parseIds(input.value).length > 0; } catch { /* Keep disabled for invalid input. */ }
      input.disabled = busy; $('.capture').disabled = busy; $('.preview').disabled = busy || !projectFromUrl();
      $('.backup').disabled = busy || !validPlan();
      $('.run').disabled = busy || !validIds;
      $('.verify').disabled = busy || !validIds;
      $('.run').textContent = validPlan() ? '清空并恢复待标注' : '直接清空（无需预览）';
      $('.stop').disabled = !busy; $('.export').disabled = busy || !report; $('.diagnose').disabled = busy; $('.local').disabled = busy; $('.refresh').disabled = busy;
      $('.project').textContent = `当前项目 ${projectFromUrl() || '未识别'} · 勾选任务 / 指定 ID`;
    }
    function invalidate(text = '可以直接清空，无需等待整批预览；也可以先预览或下载备份。') {
      plan = null; downloaded = false; message(text); controls();
    }
    const scopeChanged = () => location.href !== route || projectFromUrl() !== plan?.projectId;
    $('.toggle').onclick = () => { $('.panel').hidden = !$('.panel').hidden; controls(); };
    input.addEventListener('input', () => { $('.scope').textContent = '手动 ID 模式；执行范围以文本框为准。'; invalidate(); });
    $('.capture').onclick = async () => {
      if (busy) return;
      plan = null; downloaded = false; input.value = ''; busy = true; stopRequested = false; controls();
      try {
        const pageRoute = location.href, scope = nativeSelection(window, pageRoute), signature = stableJson(scope);
        const unchanged = () => {
          if (stopRequested || location.href !== pageRoute) return false;
          try { return stableJson(nativeSelection(window, location.href)) === signature; } catch { return false; }
        };
        const ids = await resolveSelection({ api, scope, shouldStop: () => !unchanged(),
          onProgress: count => message(`正在读取跨页勾选范围 ${count} / ${scope.count}`) });
        if (!unchanged()) throw new Error('勾选范围已变化，请重新读取');
        input.value = ids.join('\n'); $('.scope').textContent = `已完整读取勾选的 ${ids.length} / ${scope.count} 个任务；执行范围以文本框 ID 为准。`;
        invalidate();
      } catch (error) { message(error.message, 'error'); }
      finally { busy = false; controls(); }
    };
    $('.preview').onclick = async () => {
      if (busy) return;
      try {
        const taskIds = parseIds(input.value), projectId = idOf(projectFromUrl());
        route = location.href; plan = null; report = null; downloaded = false;
        stopRequested = false; log.textContent = ''; busy = true; controls();
        plan = await preview({ api, projectId, taskIds,
          shouldStop: () => stopRequested || location.href !== route,
          onProgress: current => {
            const e = current.entries.at(-1);
            message(`正在读取任务 ${current.entries.length} / ${taskIds.length}`);
            writeLog(e.status === 'ready' ? `${e.taskId} · ${e.state} · 标注 ${e.task.annotations.length} / 草稿 ${e.drafts.length} / 预标注 ${e.task.predictions.length}` : `${e.taskId} · ${e.error}`);
          } });
        if (location.href !== route) invalidate('页面已切换，请在当前项目重新选择任务');
        else if (validPlan()) {
          const sum = name => plan.entries.reduce((n, e) => n + (name === 'drafts' ? e.drafts.length : e.task[name].length), 0);
          message(`预览完成 · ${plan.entries.length} 个任务\n将删除 ${sum('annotations')} 条标注、${sum('drafts')} 条草稿、${sum('predictions')} 条预标注。\n任务与原始视频保留。可直接清空，或先下载备份。`);
        } else message('预览未全部通过，未执行清空。请查看下方明细并重新预览。', 'error');
      } catch (error) { message(error.message, 'error'); }
      finally { busy = false; controls(); }
    };
    $('.backup').onclick = () => {
      try {
        if (!validPlan() || scopeChanged()) { invalidate(); return; }
        download(`清空标注-执行前备份-项目${plan.projectId}-${plan.runId}.json`, plan);
        downloaded = true; message('已触发备份下载。点击“清空并恢复待标注”将直接执行，不再弹确认提醒。'); controls();
      } catch (error) { message(`备份导出失败：${error.message}`, 'error'); }
    };
    $('.run').onclick = async () => {
      if (busy) return;
      let executionPlan, hasPreview;
      const pageRoute = location.href, scopeText = input.value;
      try {
        const taskIds = parseIds(scopeText), projectId = idOf(projectFromUrl());
        hasPreview = validPlan() && !scopeChanged() && stableJson(plan.taskIds) === stableJson(taskIds);
        executionPlan = hasPreview ? plan : createDirectPlan(projectId, taskIds);
      } catch (error) { message(error.message, 'error'); return; }
      const detail = hasPreview ? (() => {
        const total = kind => executionPlan.entries.reduce((n, e) => n + (kind === 'drafts' ? e.drafts.length : e.task[kind].length), 0);
        return `将删除：标注 ${total('annotations')} 条、草稿 ${total('drafts')} 条、预标注 ${total('predictions')} 条。`;
      })() : '本次未预览：确认后优先每 100 个任务调用平台批量清理，再逐个核查；平台不提供批量动作时使用逐条清理。';
      const accepted = (hasPreview && downloaded) || window.confirm(`尚未下载本次备份，仍要清空项目 ${executionPlan.projectId} 的 ${executionPlan.taskIds.length} 个任务吗？\n\n${detail}\n同时执行平台实际提供的审核评分、验收、审核员与标注员关联删除。任务 ID 与原始视频保留。\n\n删除无法直接撤销。点击“确定”开始清空，或“取消”返回。`);
      if (!accepted) { message('已取消，未执行清空。'); return; }
      if (location.href !== pageRoute || input.value !== scopeText || (hasPreview && plan !== executionPlan)) { invalidate('确认期间任务范围或页面发生变化，请重新操作'); return; }
      route = pageRoute; report = null; log.textContent = '';
      busy = true; stopRequested = false; controls();
      message(`开始${hasPreview ? '清空' : '批量清空'} ${executionPlan.taskIds.length} 个任务；正在读取平台动作与首批任务。`);
      let logged = 0;
      try {
        report = await execute({ api, plan: executionPlan, persist: backupStore, nativeCleanup: true,
          shouldStop: () => stopRequested || location.href !== route,
          onProgress: current => {
            report = current;
            for (; logged < current.results.length; logged++) {
              const result = current.results[logged];
              writeLog(`${result.taskId} · ${result.status === 'success' ? '完成' : result.status === 'partial' ? '部分完成' : result.status === 'unknown' ? '待核实' : result.status === 'stopped' ? '已停止' : '失败'} · ${result.message || result.error}`);
            }
            message(`已处理 ${current.results.length} / ${executionPlan.entries.length}${current.phase ? `\n${current.phase}` : ''}`);
          } });
        const count = value => report.results.filter(r => r.status === value).length;
        const nextStep = report.stopped || count('failed') || count('partial') || count('unknown')
          ? '请查看下方错误详情或导出结果核查，重新核对范围后再操作。' : '可刷新列表查看待标注状态。';
        message(`${report.stopped ? '处理已停止' : '本批处理结束'}\n完成 ${count('success')} · 失败 ${count('failed')} · 部分完成 ${count('partial')} · 待核实 ${count('unknown')} · 已停止 ${count('stopped')} · 未开始 ${executionPlan.entries.length - report.results.length}\n${nextStep}`,
          report.stopped || count('failed') ? 'error' : 'success');
      } catch (error) { message(`执行中断：${error.message}。请导出本机备份核查。`, 'error'); }
      finally { busy = false; plan = null; downloaded = false; controls(); }
    };
    $('.stop').onclick = () => { stopRequested = true; message('正在停止；当前已发出的批量请求仍可能完成。回查后不再发起后续清理，已删内容不会自动恢复。'); };
    $('.verify').onclick = async () => {
      if (busy) return;
      try {
        const taskIds = parseIds(input.value), projectId = idOf(projectFromUrl());
        const pageRoute = location.href;
        busy = true; stopRequested = false; log.textContent = ''; controls();
        const current = await preview({ api, projectId, taskIds, crossCheck: true, shouldStop: () => stopRequested || location.href !== pageRoute,
          onProgress: state => {
            const entry = state.entries.at(-1);
            writeLog(entry.status === 'ready' ? `${entry.taskId} · 标注 ${entry.task.annotations.length} / 草稿 ${entry.drafts.length} / 预标注 ${entry.task.predictions.length} · ${entry.state}` : `${entry.taskId} · 核查失败：${entry.error}`);
            message(`只读核查 ${state.entries.length} / ${taskIds.length}；未执行删除`);
          } });
        const notEmpty = current.entries.filter(entry => entry.status !== 'ready' || entry.task.annotations.length || entry.task.predictions.length || entry.drafts.length || !pendingStates.includes(entry.state));
        message(current.stopped ? '核查已停止，不能确认整个范围清空。'
          : notEmpty.length ? `${notEmpty.length} 个任务仍有内容、状态未恢复或核查失败；请查看每个任务的剩余数量。未执行删除。`
          : `本次核查的 ${current.entries.length} 个任务标注、草稿和预标注均为 0，状态为待标注。编辑器若仍有内容，请导出接口诊断继续核对。`, notEmpty.length ? 'error' : 'success');
      } catch (error) { message(`核查失败：${error.message}`, 'error'); }
      finally { busy = false; controls(); }
    };
    $('.export').onclick = () => { if (report) download(`清空标注-执行结果-${report.runId}.json`, report); };
    $('.diagnose').onclick = async () => {
      if (busy) return;
      try {
        const taskId = parseIds(input.value)[0], projectId = idOf(projectFromUrl());
        busy = true; controls(); message(`正在只读诊断任务 ${taskId} 的字段与接口能力`);
        const data = await diagnose({ api, projectId, taskId });
        download(`清空标注-接口诊断-任务${taskId}.json`, data);
        message('已导出接口诊断文件，仅读取首个任务的字段结构和接口说明；没有执行清空。可提供该文件继续排查审核、评分和人员信息清理入口。');
      } catch (error) { message(`诊断失败：${error.message}`, 'error'); }
      finally { busy = false; controls(); }
    };
    $('.local').onclick = async () => {
      try { download('清空标注-本机备份.json', await backupStore()); }
      catch (error) { message(error.message, 'error'); }
    };
    $('.refresh').onclick = () => { if (!busy) location.reload(); };
    window.addEventListener('beforeunload', event => { if (busy) { event.preventDefault(); event.returnValue = ''; } });
    const watcher = setInterval(() => {
      if (!host.isConnected) { clearInterval(watcher); disposed = true; return; }
      if (disposed || location.href === route) return;
      if (busy) stopRequested = true;
      else { route = location.href; invalidate('页面已切换，请重新预览'); }
    }, 500);
    controls();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();

