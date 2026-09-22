// ==UserScript==
// @name         Insta360 项目概览
// @namespace    https://label.insta360.com/
// @author       chengzi8899
// @version      1.9.5
// @description  项目卡片状态概览 + 状态跳转自动筛选
// @match        *://label.insta360.com/*
// @run-at       document-idle
// @grant        none
// @noframes
// @updateURL    https://github.com/chengzi-1225/Insta360-chengzi/blob/main/insta360-overview.user.js
// @downloadURL  https://github.com/chengzi-1225/Insta360-chengzi/blob/main/insta360-overview.user.js
// ==/UserScript==

(function () {
  'use strict';

  /* ============================================================
   * 页面判断
   * ============================================================ */
  function isListPage() {
    var path = location.pathname.replace(/\/+$/, '') || '/';
    if (!/^\/workspaces\/[^/]+\/projects$/.test(path)) return false;
    var page = new URLSearchParams(location.search).get('page');
    return page != null && page !== '';
  }
  function isDataPage() {
    return /^\/workspaces\/[^/]+\/projects\/\d+\/data(?:\/|$)/.test(location.pathname);
  }

  /* ============================================================
   * 配置
   * ============================================================ */

  var DEBUG = false;
  var PENDING_KEY = 'ovw_pending_filter';

  var CONFIG = {
    cardSelector: '.ls-project-card',
    summaryHostSelector: '.ls-project-card__detail',
    summaryHostFallback: '.ls-project-card__description',
    cacheTtlMs: 60 * 1000,
    projectPath: '/api/projects',
    taskPath: '/api/dm/tasks',
    settingsKey: 'insta360-overview-fields-v1',
    fastMode: true,
    detailConcurrency: 2,
    taskPageSize: 500,
    taskPageConcurrency: 12,
    defaultPendingWhenNoStatus: true,
    mountDelayMs: 120,
    autoApplyFilter: true
  };

  var STATUS_CODES = [
    'PENDING_ANNOTATION', 'ANNOTATED',
    'REVIEWED_ACCEPTED', 'REVIEWED_REJECTED',
    'APPEALED', 'APPEAL_ACCEPTED', 'APPEAL_REJECTED',
    'ACCEPTANCE_ACCEPTED', 'ACCEPTANCE_REJECTED',
    'REWORK'
  ];

  var STATUS_LABELS = {
    PENDING_ANNOTATION: '待标注', ANNOTATED: '已提交',
    REVIEWED_ACCEPTED: '审核通过', REVIEWED_REJECTED: '审核驳回',
    APPEALED: '已申诉', APPEAL_ACCEPTED: '申诉通过', APPEAL_REJECTED: '申诉拒绝',
    ACCEPTANCE_ACCEPTED: '验收通过', ACCEPTANCE_REJECTED: '验收拒绝',
    REWORK: '返工/返修'
  };

  var STATUS_COLORS = {
    PENDING_ANNOTATION: '#8c8c8c', ANNOTATED: '#1677ff',
    REVIEWED_ACCEPTED: '#52c41a', REVIEWED_REJECTED: '#ff4d4f',
    APPEALED: '#722ed1', APPEAL_ACCEPTED: '#13c2c2', APPEAL_REJECTED: '#eb2f96',
    ACCEPTANCE_ACCEPTED: '#389e0d', ACCEPTANCE_REJECTED: '#d4380d',
    REWORK: '#fa8c16'
  };

  // 筛选值：全大写优先
  var FILTER_VALUE_CANDIDATES = {
    PENDING_ANNOTATION: ['CREATED', 'PENDING', 'created'],
    ANNOTATED:          ['ANNOTATED', 'annotated'],
    REVIEWED_ACCEPTED:  ['REVIEWED_ACCEPTED', 'reviewed_accepted'],
    REVIEWED_REJECTED:  ['REVIEWED_REJECTED', 'reviewed_rejected'],
    REWORK:             ['REWORK', 'rework']
  };

  var FILTERABLE = {
    PENDING_ANNOTATION: 1, ANNOTATED: 1,
    REVIEWED_ACCEPTED: 1, REVIEWED_REJECTED: 1, REWORK: 1
  };

  var STATUS_ALIASES = {
    PENDING: 'PENDING_ANNOTATION', PENDING_ANNOTATION: 'PENDING_ANNOTATION',
    TO_ANNOTATE: 'PENDING_ANNOTATION', NEW: 'PENDING_ANNOTATION',
    CREATED: 'PENDING_ANNOTATION', TODO: 'PENDING_ANNOTATION',
    UNLABELED: 'PENDING_ANNOTATION', TASK_CREATED: 'PENDING_ANNOTATION',
    task_created: 'PENDING_ANNOTATION',
    ANNOTATION_SUBMITTED: 'ANNOTATED', SUBMITTED: 'ANNOTATED',
    TASK_ANNOTATED: 'ANNOTATED', task_annotated: 'ANNOTATED',
    REVIEW_ACCEPTED: 'REVIEWED_ACCEPTED', REVIEW_REJECTED: 'REVIEWED_REJECTED',
    APPEALING: 'APPEALED', REPAIR: 'REWORK', REWORKING: 'REWORK',
    '已提交': 'ANNOTATED', '待标注': 'PENDING_ANNOTATION',
    '审核通过': 'REVIEWED_ACCEPTED', '审核驳回': 'REVIEWED_REJECTED',
    '审核未通过': 'REVIEWED_REJECTED', '已申诉': 'APPEALED',
    '申诉通过': 'APPEAL_ACCEPTED', '申诉拒绝': 'APPEAL_REJECTED',
    '验收通过': 'ACCEPTANCE_ACCEPTED', '验收拒绝': 'ACCEPTANCE_REJECTED',
    '返工/返修': 'REWORK', '返工': 'REWORK', '返修': 'REWORK'
  };

  function log() {
    if (!DEBUG) return;
    try { console.log.apply(console, ['[概览]'].concat([].slice.call(arguments))); } catch (e) {}
  }

  /* ============================================================
   * 字段定义
   * ============================================================ */

  var FIELD_DEFS = [
    { key: 'total',               label: '当前总数',  color: '#262626', kind: 'total' },
    { key: 'PENDING_ANNOTATION',  label: '待标注',    color: '#8c8c8c', kind: 'status' },
    { key: 'ANNOTATED',           label: '已提交',    color: '#1677ff', kind: 'status' },
    { key: 'REVIEWED_ACCEPTED',   label: '审核通过',  color: '#52c41a', kind: 'status' },
    { key: 'REVIEWED_REJECTED',   label: '审核驳回',  color: '#ff4d4f', kind: 'status' },
    { key: 'ACCEPTANCE_ACCEPTED', label: '验收通过',  color: '#389e0d', kind: 'status' },
    { key: 'ACCEPTANCE_REJECTED', label: '验收拒绝',  color: '#d4380d', kind: 'status' },
    { key: 'REWORK',              label: '返工/返修', color: '#fa8c16', kind: 'status' },
    { key: 'annotationProgress',  label: '标注进度',  color: '#13c2c2', kind: 'percent' },
    { key: 'reviewProgress',      label: '审核进度',  color: '#722ed1', kind: 'percent' }
  ];

  var FIELD_MAP = {};
  for (var fi = 0; fi < FIELD_DEFS.length; fi++) FIELD_MAP[FIELD_DEFS[fi].key] = FIELD_DEFS[fi];

  var DEFAULT_VISIBLE = ['total', 'PENDING_ANNOTATION', 'ANNOTATED', 'REVIEWED_ACCEPTED', 'REVIEWED_REJECTED', 'REWORK'];

  function loadVisibleFields() {
    try {
      var raw = JSON.parse(localStorage.getItem(CONFIG.settingsKey) || 'null');
      if (Array.isArray(raw) && raw.length) return raw.filter(function (k) { return FIELD_MAP[k]; });
    } catch (e) {}
    return DEFAULT_VISIBLE.slice();
  }
  function saveVisibleFields(list) {
    try { localStorage.setItem(CONFIG.settingsKey, JSON.stringify(list)); } catch (e) {}
  }

  var visibleFields = loadVisibleFields();
  function isVisible(key) { return visibleFields.indexOf(key) !== -1; }

  /* ============================================================
   * 并发池
   * ============================================================ */

  function Pool(limit) { this.limit = limit; this.active = 0; this.queue = []; }
  Pool.prototype.run = function (fn) {
    var self = this;
    return new Promise(function (resolve, reject) {
      var task = function () {
        self.active += 1;
        Promise.resolve().then(fn)
          .then(function (v) { resolve(v); })
          .catch(function (e) { reject(e); })
          .then(function () { self.active -= 1; self.next(); });
      };
      if (self.active < self.limit) task(); else self.queue.push(task);
    });
  };
  Pool.prototype.next = function () {
    if (this.active < this.limit && this.queue.length) this.queue.shift()();
  };
  var detailPool = new Pool(CONFIG.detailConcurrency);

  /* ============================================================
   * 状态归一化
   * ============================================================ */

  var STATUS_SET = {};
  for (var si = 0; si < STATUS_CODES.length; si++) STATUS_SET[STATUS_CODES[si]] = true;
  var STATUS_NOUNDER = {};
  for (var ni = 0; ni < STATUS_CODES.length; ni++) STATUS_NOUNDER[STATUS_CODES[ni].replace(/_/g, '')] = STATUS_CODES[ni];

  function asStatus(value) {
    if (value == null) return null;
    var raw = value;
    if (typeof value === 'object') {
      if (value.value != null) raw = value.value;
      else if (value.code != null) raw = value.code;
      else if (value.status != null) raw = value.status;
      else raw = null;
    }
    if (raw == null) return null;
    var text = String(raw).trim();
    if (!text) return null;
    var normalized = text.toUpperCase();
    if (STATUS_SET[normalized]) return normalized;
    if (STATUS_ALIASES[text]) return STATUS_ALIASES[text];
    if (STATUS_ALIASES[normalized]) return STATUS_ALIASES[normalized];
    var stripped = normalized.replace(/^(TASK|DM|LS|WORKFLOW|LABEL|ANNOTATION|REVIEW)_/, '');
    if (STATUS_SET[stripped]) return stripped;
    if (STATUS_ALIASES[stripped]) return STATUS_ALIASES[stripped];
    var noUnder = normalized.replace(/_/g, '');
    var strippedNoUnder = stripped.replace(/_/g, '');
    if (STATUS_NOUNDER[noUnder]) return STATUS_NOUNDER[noUnder];
    if (STATUS_NOUNDER[strippedNoUnder]) return STATUS_NOUNDER[strippedNoUnder];
    for (var i = 0; i < STATUS_CODES.length; i++) {
      var code = STATUS_CODES[i];
      var codeNoUnder = code.replace(/_/g, '');
      if (noUnder.indexOf(codeNoUnder) !== -1 || codeNoUnder.indexOf(noUnder) !== -1) return code;
    }
    return null;
  }

  function firstValue(record, keys) {
    if (!record) return null;
    for (var i = 0; i < keys.length; i++) if (record[keys[i]] != null) return record[keys[i]];
    return null;
  }
  function collectEvents(task) {
    var events = [];
    if (!task) return events;
    var keys = ['events', 'history', 'status_history', 'workflow_history', 'reviews', 'appeals', 'acceptances'];
    for (var i = 0; i < keys.length; i++) {
      var arr = task[keys[i]];
      if (Array.isArray(arr)) for (var j = 0; j < arr.length; j++) events.push(arr[j]);
    }
    return events;
  }
  function normalizeTask(raw, fallbackId) {
    var task = (raw && typeof raw === 'object') ? raw : {};
    var nested = (task.task && typeof task.task === 'object') ? task.task : null;
    var taskId = firstValue(task, ['id', 'taskId', 'task_id', 'pk']);
    if (taskId == null) taskId = firstValue(nested, ['id', 'taskId', 'task_id', 'pk']);
    if (taskId == null) taskId = fallbackId;
    var records = [task]; if (nested) records.push(nested);
    var stateKeys = ['currentStatus', 'current_status', 'workflowState', 'workflow_state', 'taskState', 'task_state', 'state', 'status'];
    var hadStatusValue = false;
    for (var i = 0; i < records.length; i++) {
      var record = records[i];
      for (var j = 0; j < stateKeys.length; j++) {
        var rawStatus = record[stateKeys[j]];
        if (rawStatus == null || rawStatus === '') continue;
        hadStatusValue = true;
        var status = asStatus(rawStatus);
        if (status) return { taskId: taskId, status: status };
      }
    }
    var rawEvents = collectEvents(task);
    var events = [];
    for (var k = 0; k < rawEvents.length; k++) {
      var event = rawEvents[k];
      var date = firstValue(event, ['updatedAt', 'updated_at', 'createdAt', 'created_at', 'timestamp', 'date']);
      var time = date == null ? Number.NEGATIVE_INFINITY : Date.parse(date);
      var st = asStatus(event);
      if (st) events.push({ status: st, time: Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY });
    }
    events.sort(function (a, b) { return b.time - a.time; });
    if (events.length) return { taskId: taskId, status: events[0].status };
    if (!hadStatusValue && CONFIG.defaultPendingWhenNoStatus) return { taskId: taskId, status: 'PENDING_ANNOTATION' };
    return { taskId: taskId, status: null };
  }
  function aggregateTasks(rows) {
    var counts = {};
    for (var i = 0; i < STATUS_CODES.length; i++) counts[STATUS_CODES[i]] = 0;
    var seen = {};
    var total = 0, unknown = 0;
    var list = Array.isArray(rows) ? rows : [];
    for (var j = 0; j < list.length; j++) {
      var t = normalizeTask(list[j], 'row-' + j);
      var key = String(t.taskId);
      if (seen[key]) continue;
      seen[key] = true;
      total += 1;
      if (t.status && STATUS_SET[t.status]) counts[t.status] += 1;
      else unknown += 1;
    }
    return { total: total, counts: counts, unknown: unknown, available: STATUS_CODES.slice(), needsTaskDetails: false, source: 'tasks' };
  }
  function num(v) { var n = Number(v); return Number.isFinite(n) ? n : 0; }

  function fastAggregate(summary) {
    if (!summary) return null;
    var total = num(summary.task_number);
    if (!total) return null;
    var submitted = num(summary.num_tasks_with_annotations);
    var reviewed = num(summary.reviewed_count);
    var reviewRejected = num(
      summary.review_rejected_count != null ? summary.review_rejected_count :
      summary.review_reject_count != null ? summary.review_reject_count :
      summary.review_rejected != null ? summary.review_rejected :
      summary.rejected_count
    );
    var acceptance = num(summary.acceptance_count);
    var acceptanceRej = num(summary.acceptance_rejected_count);
    var appealed = num(summary.appealed_count);
    var rework = num(summary.user_rework_count) + num(summary.user_repair_count);
    var reviewAccepted = Math.max(0, reviewed - reviewRejected);
    var pending = Math.max(0, total - submitted);
    var counts = {};
    for (var i = 0; i < STATUS_CODES.length; i++) counts[STATUS_CODES[i]] = 0;
    counts.PENDING_ANNOTATION = pending;
    counts.ANNOTATED = submitted;
    counts.REVIEWED_ACCEPTED = reviewAccepted;
    counts.REVIEWED_REJECTED = reviewRejected;
    counts.ACCEPTANCE_ACCEPTED = acceptance;
    counts.ACCEPTANCE_REJECTED = acceptanceRej;
    counts.APPEALED = appealed;
    counts.REWORK = rework;
    var sum = 0; for (var k in counts) sum += counts[k];
    return { total: total, counts: counts, available: STATUS_CODES.slice(), unknown: Math.max(0, total - sum), source: 'summary-fast', needsTaskDetails: false, summary: summary };
  }

  /* ============================================================
   * API
   * ============================================================ */

  function apiUrl(path, params) {
    var url = new URL(path, location.origin);
    if (params) Object.keys(params).forEach(function (k) {
      var v = params[k];
      if (v != null && v !== '') url.searchParams.set(k, String(v));
    });
    return url.toString();
  }
  async function getJson(url) {
    var res = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
    if (res.status === 401) throw new Error('登录状态已失效');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }
  function rowsFromResponse(body) {
    if (Array.isArray(body)) return body;
    if (body && typeof body === 'object') {
      var keys = ['results', 'tasks', 'items', 'data'];
      for (var i = 0; i < keys.length; i++) if (Array.isArray(body[keys[i]])) return body[keys[i]];
    }
    return [];
  }
  function totalFromResponse(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    var keys = ['count', 'total', 'total_count', 'totalCount'];
    for (var i = 0; i < keys.length; i++) {
      var v = Number(body[keys[i]]);
      if (Number.isFinite(v)) return v;
    }
    return null;
  }
  async function loadProjectSummary(projectId) {
    var body = await getJson(apiUrl(CONFIG.projectPath, { ids: projectId, page_size: 1 }));
    if (Array.isArray(body)) return body[0] || null;
    if (body && Array.isArray(body.results)) return body.results[0] || null;
    if (body && typeof body === 'object') return body;
    return null;
  }
  async function loadProjectFast(projectId) {
    var summary = await loadProjectSummary(projectId);
    var agg = fastAggregate(summary);
    if (!agg) throw new Error('汇总接口未返回 task_number');
    return agg;
  }
  function nextPage(body, currentUrl, page, rowCount) {
    var u = new URL(currentUrl);
    var projectId = u.searchParams.get('project');
    var workspaceId = u.searchParams.get('workspace');
    if (body && typeof body.next === 'string' && body.next) return new URL(body.next, currentUrl).toString();
    if (body && (body.has_next === true || body.hasNext === true))
      return apiUrl(CONFIG.taskPath, { project: projectId, workspace: workspaceId, page: page + 1, page_size: CONFIG.taskPageSize });
    var count = Number((body && (body.count != null ? body.count : body.total)) || 0);
    if (count > rowCount && page * CONFIG.taskPageSize < count)
      return apiUrl(CONFIG.taskPath, { project: projectId, workspace: workspaceId, page: page + 1, page_size: CONFIG.taskPageSize });
    return null;
  }
  async function loadTasks(projectId, workspaceId) {
    var baseParams = { project: projectId, workspace: workspaceId, page_size: CONFIG.taskPageSize };
    var firstUrl = apiUrl(CONFIG.taskPath, Object.assign({ page: 1 }, baseParams));
    var firstBody = await getJson(firstUrl);
    var firstRows = rowsFromResponse(firstBody);
    var rows = firstRows.slice();
    var effectiveSize = firstRows.length || CONFIG.taskPageSize;
    var total = totalFromResponse(firstBody);
    if (total == null || total <= 0) return rows;
    if (rows.length >= total) return rows;
    var pageCount = Math.ceil(total / effectiveSize);
    var pageList = [];
    for (var p = 2; p <= pageCount; p++) pageList.push(p);
    var queue = pageList.slice();
    var concurrency = Math.max(1, Math.min(CONFIG.taskPageConcurrency, pageCount - 1));
    async function worker() {
      while (queue.length) {
        var page = queue.shift();
        var url = apiUrl(CONFIG.taskPath, Object.assign({ page: page }, baseParams));
        try {
          var body = await getJson(url);
          var pageRows = rowsFromResponse(body);
          for (var i = 0; i < pageRows.length; i++) rows.push(pageRows[i]);
        } catch (e) {}
      }
    }
    var workers = [];
    for (var w = 0; w < concurrency; w++) workers.push(worker());
    await Promise.all(workers);
    return rows;
  }
  async function loadProjectPrecise(projectId, workspaceId) {
    var summary = null;
    try { summary = await loadProjectSummary(projectId); } catch (e) {}
    var tasks = await loadTasks(projectId, workspaceId);
    var agg = aggregateTasks(tasks);
    agg.summary = summary;
    return agg;
  }
  async function loadProjectFull(projectId, workspaceId) {
    if (CONFIG.fastMode) return await loadProjectFast(projectId);
    return await loadProjectPrecise(projectId, workspaceId);
  }
  function projectContext(card) {
    var href = '';
    var link = card.closest ? card.closest('a[href]') : null;
    if (link) href = link.getAttribute('href') || '';
    if (!href) {
      var inner = card.querySelector('a[href]');
      if (inner) href = inner.getAttribute('href') || '';
    }
    var workspaceId = null, projectId = null;
    if (href) {
      var m = href.match(/\/workspaces\/([^/]+)\/projects\/(\d+)(?:\/|$)/);
      if (m) { workspaceId = m[1]; projectId = m[2]; }
      if (!projectId) {
        var m2 = href.match(/\/projects\/(\d+)(?:\/|$)/);
        if (m2) projectId = m2[1];
      }
    }
    if (!projectId) return null;
    if (!workspaceId) {
      var wsMatch = location.pathname.match(/\/workspaces\/([^/]+)/);
      workspaceId = wsMatch ? wsMatch[1] : 'all';
    }
    return { workspaceId: workspaceId, projectId: projectId, href: href };
  }
  var cache = {};

  async function refreshProject(card, options) {
    options = options || {};
    var context = card && projectContext(card);
    if (!context) return null;
    var summaryEl = createSummary(card, context);
    var existing = cache[context.projectId];
    if (!options.force && existing && existing.aggregate && Date.now() - existing.loadedAt < CONFIG.cacheTtlMs) {
      renderSummary(summaryEl, existing.aggregate);
      return existing.aggregate;
    }
    if (existing && existing.promise) return existing.promise;
    renderSummary(summaryEl, existing ? existing.aggregate : null, true);
    var promise = loadProjectFull(context.projectId, context.workspaceId)
      .then(function (aggregate) {
        cache[context.projectId] = { loadedAt: Date.now(), aggregate: aggregate };
        renderSummary(summaryEl, aggregate);
        return aggregate;
      })
      .catch(function (error) {
        cache[context.projectId] = { loadedAt: 0, aggregate: existing ? existing.aggregate : null, error: error };
        renderSummary(summaryEl, existing ? existing.aggregate : null, false, error);
        return null;
      })
      .then(function (result) {
        var cur = cache[context.projectId];
        if (cur) delete cur.promise;
        return result;
      });
    var entry = Object.assign({}, existing || {});
    entry.promise = promise;
    cache[context.projectId] = entry;
    return promise;
  }
  function computeFieldValue(field, agg) {
    if (!agg) return null;
    var counts = agg.counts || {};
    var available = {};
    var avList = agg.available || STATUS_CODES;
    for (var i = 0; i < avList.length; i++) available[avList[i]] = true;
    if (field.kind === 'total') return String(agg.total != null ? agg.total : 0);
    if (field.kind === 'status') {
      if (!available[field.key]) return '…';
      return String(counts[field.key] != null ? counts[field.key] : 0);
    }
    if (field.kind === 'percent') {
      if (field.key === 'annotationProgress') {
        var total1 = Number(agg.total) || 0;
        if (!total1) return '—';
        var pending = Number(counts.PENDING_ANNOTATION) || 0;
        return (((total1 - pending) / total1) * 100).toFixed(1) + '%';
      }
      if (field.key === 'reviewProgress') {
        var total2 = Number(agg.total) || 0;
        if (!total2) return '—';
        var acc = Number(counts.REVIEWED_ACCEPTED) || 0;
        var rej = Number(counts.REVIEWED_REJECTED) || 0;
        return (((acc + rej) / total2) * 100).toFixed(1) + '%';
      }
    }
    return '—';
  }
  function createSummary(card, context) {
    var summary = card.querySelector('.ovw-summary');
    if (summary) return summary;
    summary = document.createElement('div');
    summary.className = 'ovw-summary';
    summary.dataset.projectId = context.projectId;
    summary.setAttribute('role', 'button');
    summary.setAttribute('tabindex', '0');
    summary.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      var entry = cache[context.projectId];
      if (!entry || !entry.aggregate) return;
      showPopover(summary, context, entry.aggregate);
    });
    var host = card.querySelector(CONFIG.summaryHostSelector) || card.querySelector(CONFIG.summaryHostFallback) || card;
    host.appendChild(summary);
    return summary;
  }
  function jumpToProjectWithFilter(card, code, label) {
    var ctx = projectContext(card);
    if (!ctx || !ctx.href) return;
    var candidates = FILTER_VALUE_CANDIDATES[code] || [code];
    try {
      sessionStorage.setItem(PENDING_KEY, JSON.stringify({
        projectId: ctx.projectId, code: code, label: label,
        candidates: candidates, ts: Date.now()
      }));
    } catch (e) {}
    var target = ctx.href;
    try {
      var u = new URL(target, location.origin);
      target = u.origin + u.pathname;
    } catch (e) {}
    location.href = target;
  }
  function renderSummary(summaryEl, agg, loading, error) {
    summaryEl.setAttribute('aria-busy', loading ? 'true' : 'false');
    if (error) {
      summaryEl.innerHTML = '<span class="ovw-message ovw-message--err">统计失败</span>' +
        '<button type="button" class="ovw-refresh" title="重试"><svg viewBox="0 0 16 16" width="12" height="12"><path fill="currentColor" d="M8 3a5 5 0 1 0 4.55 2.9l1.2-.7A6.5 6.5 0 1 1 8 1.5v1.5z"/><path fill="currentColor" d="M12.5 1v3h-3z"/></svg></button>';
      var btn = summaryEl.querySelector('.ovw-refresh');
      if (btn) btn.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation();
        refreshProject(summaryEl.closest(CONFIG.cardSelector), { force: true });
      });
      return;
    }
    if (!agg) { summaryEl.innerHTML = '<span class="ovw-message">加载中…</span>'; return; }
    var card = summaryEl.closest(CONFIG.cardSelector);
    var frag = document.createDocumentFragment();
    if (visibleFields.length === 0) {
      var empty = document.createElement('span');
      empty.className = 'ovw-message';
      empty.textContent = '未选择统计字段';
      frag.appendChild(empty);
    } else {
      for (var i = 0; i < visibleFields.length; i++) {
        var key = visibleFields[i];
        var def = FIELD_MAP[key];
        if (!def) continue;
        var val = computeFieldValue(def, agg);
        var isClickable = !!FILTERABLE[def.key];
        var chip = document.createElement('span');
        chip.className = 'ovw-chip' + (isClickable ? ' ovw-chip--clickable' : '');
        chip.style.setProperty('--ovw-c', def.color);
        chip.innerHTML = '<span class="ovw-chip__label">' + escapeHtml(def.label) + '</span>' +
          '<span class="ovw-chip__value">' + escapeHtml(String(val)) + '</span>' +
          (isClickable ? '<span class="ovw-chip__arrow">›</span>' : '');
        if (isClickable) {
          chip.setAttribute('role', 'button');
          chip.setAttribute('tabindex', '0');
          chip.title = '点击查看此状态的任务';
          chip.addEventListener('click', (function (k, l) {
            return function (e) {
              e.preventDefault(); e.stopPropagation();
              jumpToProjectWithFilter(card, k, l);
            };
          })(def.key, def.label));
          chip.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); chip.click(); }
          });
        }
        frag.appendChild(chip);
      }
    }
    var refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.className = 'ovw-refresh';
    refresh.title = '刷新';
    refresh.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12"><path fill="currentColor" d="M8 3a5 5 0 1 0 4.55 2.9l1.2-.7A6.5 6.5 0 1 1 8 1.5v1.5z"/><path fill="currentColor" d="M12.5 1v3h-3z"/></svg>';
    refresh.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      refreshProject(summaryEl.closest(CONFIG.cardSelector), { force: true });
    });
    frag.appendChild(refresh);
    summaryEl.innerHTML = '';
    summaryEl.appendChild(frag);
  }
  var openPopover = null;
  function closePopover() { if (openPopover) openPopover.remove(); openPopover = null; }
  function showPopover(anchor, context, agg) {
    closePopover();
    var popover = document.createElement('div');
    popover.className = 'ovw-popover';
    var rowsHtml = STATUS_CODES.map(function (c) {
      var count = agg.counts[c] != null ? agg.counts[c] : 0;
      var clickable = !!FILTERABLE[c];
      return '<div class="ovw-popover__row' + (clickable ? ' ovw-popover__row--clickable' : '') + '" data-code="' + c + '">' +
        '<span class="ovw-popover__dot" style="background:' + STATUS_COLORS[c] + '"></span>' +
        '<span class="ovw-popover__label">' + STATUS_LABELS[c] + '</span>' +
        '<span class="ovw-popover__num">' + count + (clickable ? ' <span class="ovw-popover__arrow">›</span>' : '') + '</span>' +
      '</div>';
    }).join('');
    popover.innerHTML =
      '<div class="ovw-popover__head">' +
        '<span class="ovw-popover__title">项目状态</span>' +
        '<button type="button" class="ovw-popover__close" aria-label="关闭"><svg viewBox="0 0 16 16" width="14" height="14"><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" d="M3.5 3.5l9 9M12.5 3.5l-9 9"/></svg></button>' +
      '</div>' +
      '<div class="ovw-popover__body">' + rowsHtml + '</div>' +
      '<div class="ovw-popover__foot">' +
        '<div class="ovw-popover__foot-row"><span>未知</span><span>' + agg.unknown + '</span></div>' +
        '<div class="ovw-popover__foot-row ovw-popover__foot-row--strong"><span>合计</span><span>' + agg.total + '</span></div>' +
        '<div class="ovw-popover__time">' + formatTime(Date.now()) + '</div>' +
      '</div>';
    document.body.appendChild(popover);
    popover.querySelectorAll('.ovw-popover__row--clickable').forEach(function (row) {
      row.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation();
        var code = row.getAttribute('data-code');
        var card = anchor.closest(CONFIG.cardSelector);
        if (card) jumpToProjectWithFilter(card, code, STATUS_LABELS[code]);
      });
    });
    var rect = anchor.getBoundingClientRect();
    var left = Math.min(Math.max(12, rect.left), window.innerWidth - popover.offsetWidth - 12);
    var top = (rect.bottom + 10 + popover.offsetHeight < window.innerHeight) ? rect.bottom + 10 : Math.max(12, rect.top - popover.offsetHeight - 10);
    popover.style.left = left + 'px';
    popover.style.top = top + 'px';
    popover.querySelector('.ovw-popover__close').addEventListener('click', closePopover);
    openPopover = popover;
  }

  function findSearchInput() {
    var list = [].slice.call(document.querySelectorAll('input[type="search"]'))
      .concat([].slice.call(document.querySelectorAll('input[placeholder*="搜索"]')))
      .concat([].slice.call(document.querySelectorAll('input[placeholder*="项目名称"]')))
      .concat([].slice.call(document.querySelectorAll('input[placeholder*="search" i]')));
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (el.offsetParent !== null || el.getClientRects().length) return el;
    }
    return null;
  }
  function injectFieldsToolbar() {
    if (document.querySelector('.ovw-toolbar')) return;
    var input = findSearchInput();
    if (!input) return;
    var host = input.closest('.ant-input-affix-wrapper') || input.closest('.ant-input-group-wrapper') || input.closest('.ant-input-search') || input.parentElement;
    if (!host || !host.parentElement) return;
    var toolbar = document.createElement('div');
    toolbar.className = 'ovw-toolbar';
    toolbar.innerHTML =
      '<button type="button" class="ovw-toolbar__btn">' +
        '<svg viewBox="0 0 16 16" width="14" height="14"><path fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" d="M2.5 4.5h11M4.5 8h7M6.5 11.5h3"/></svg>' +
        '<span>统计字段</span>' +
      '</button>' +
      '<div class="ovw-toolbar__panel" hidden>' +
        '<div class="ovw-toolbar__panel-head"><span>卡片显示字段</span><button type="button" class="ovw-toolbar__reset">恢复默认</button></div>' +
        '<div class="ovw-toolbar__panel-list"></div>' +
      '</div>';
    host.parentElement.insertBefore(toolbar, host.nextSibling);
    var btn = toolbar.querySelector('.ovw-toolbar__btn');
    var panel = toolbar.querySelector('.ovw-toolbar__panel');
    var listEl = toolbar.querySelector('.ovw-toolbar__panel-list');
    var resetBtn = toolbar.querySelector('.ovw-toolbar__reset');
    function renderList() {
      listEl.innerHTML = '';
      for (var i = 0; i < FIELD_DEFS.length; i++) {
        var def = FIELD_DEFS[i];
        var row = document.createElement('label');
        row.className = 'ovw-toolbar__item';
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = isVisible(def.key);
        cb.addEventListener('change', (function (d, checkbox) {
          return function () {
            var set = {};
            for (var k = 0; k < visibleFields.length; k++) set[visibleFields[k]] = true;
            if (checkbox.checked) set[d.key] = true; else delete set[d.key];
            var next = [];
            for (var k2 = 0; k2 < FIELD_DEFS.length; k2++) if (set[FIELD_DEFS[k2].key]) next.push(FIELD_DEFS[k2].key);
            visibleFields = next;
            saveVisibleFields(visibleFields);
            rerenderAllCards();
          };
        })(def, cb));
        var dot = document.createElement('span');
        dot.className = 'ovw-toolbar__dot';
        dot.style.background = def.color;
        var text = document.createElement('span');
        text.textContent = def.label;
        row.appendChild(cb); row.appendChild(dot); row.appendChild(text);
        listEl.appendChild(row);
      }
    }
    function openPanel() { renderList(); panel.hidden = false; btn.classList.add('is-open'); }
    function closePanel() { panel.hidden = true; btn.classList.remove('is-open'); }
    btn.addEventListener('click', function (e) { e.stopPropagation(); if (panel.hidden) openPanel(); else closePanel(); });
    resetBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      visibleFields = DEFAULT_VISIBLE.slice();
      saveVisibleFields(visibleFields);
      renderList(); rerenderAllCards();
    });
    panel.addEventListener('click', function (e) { e.stopPropagation(); });
    document.addEventListener('click', function (e) { if (!toolbar.contains(e.target)) closePanel(); }, true);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !panel.hidden) closePanel(); });
  }
  function mountCard(card) {
    if (card.dataset.ovwMounted === '1') return;
    var context = projectContext(card);
    if (!context) {
      var old = card.querySelector('.ovw-summary');
      if (old) old.remove();
      return;
    }
    card.dataset.ovwMounted = '1';
    createSummary(card, context);
    detailPool.run(function () { return refreshProject(card); }).catch(function () {});
  }
  function scanCards() {
    var cards = document.querySelectorAll(CONFIG.cardSelector);
    for (var i = 0; i < cards.length; i++) mountCard(cards[i]);
  }
  function rerenderAllCards() {
    var cards = document.querySelectorAll(CONFIG.cardSelector);
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      var summary = card.querySelector('.ovw-summary');
      if (!summary) continue;
      var ctx = projectContext(card);
      if (!ctx) continue;
      var entry = cache[ctx.projectId];
      if (entry && entry.aggregate) renderSummary(summary, entry.aggregate);
    }
  }

  /* ============================================================
   * 样式
   * ============================================================ */

  var CSS_TEXT = [
    '.ovw-summary{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:10px;padding:8px 10px;border-radius:8px;background:linear-gradient(180deg,rgba(250,250,250,.9),rgba(245,246,248,.9));border:1px solid rgba(0,0,0,.05);color:#595959;font:12px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",Arial,sans-serif;cursor:pointer;transition:all .15s ease;box-sizing:border-box;}',
    '.ovw-summary:hover{background:#fff;border-color:rgba(22,119,255,.25);box-shadow:0 2px 8px rgba(22,119,255,.08);}',
    '.ovw-summary[aria-busy="true"]{opacity:.6;}',
    '.ovw-summary::before{content:"";flex:0 0 4px;height:16px;border-radius:2px;background:linear-gradient(180deg,#1677ff,#4096ff);opacity:.7;}',
    '.ovw-chip{display:inline-flex;align-items:baseline;gap:4px;padding:3px 8px;border-radius:5px;background:rgba(0,0,0,.028);white-space:nowrap;font-variant-numeric:tabular-nums;transition:all .12s ease;}',
    '.ovw-chip__label{color:#8c8c8c;font-size:11px;}',
    '.ovw-chip__value{color:var(--ovw-c,#262626);font-weight:600;font-size:12.5px;}',
    '.ovw-chip__arrow{color:var(--ovw-c,#262626);font-size:14px;opacity:.35;margin-left:1px;font-weight:600;transition:all .15s ease;display:inline-block;}',
    '.ovw-chip--clickable{cursor:pointer;}',
    '.ovw-chip--clickable:hover{background:rgba(22,119,255,.08);box-shadow:0 1px 4px rgba(22,119,255,.12);transform:translateY(-1px);}',
    '.ovw-chip--clickable:hover .ovw-chip__arrow{opacity:1;transform:translateX(2px);}',
    '.ovw-chip--clickable:focus{outline:none;box-shadow:0 0 0 2px rgba(22,119,255,.35);}',
    '.ovw-message{color:#8c8c8c;}',
    '.ovw-message--err{color:#cf1322;}',
    '.ovw-refresh{margin-left:auto;flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border:0;border-radius:5px;background:transparent;color:#8c8c8c;cursor:pointer;padding:0;transition:all .15s ease;}',
    '.ovw-refresh:hover{background:rgba(22,119,255,.1);color:#1677ff;}',
    '.ovw-toolbar{position:relative;display:inline-block;vertical-align:middle;margin-left:8px;font:14px/1.5 Roboto,Arial,sans-serif;}',
    '.ovw-toolbar__btn{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 12px;border:1px solid #d9d9d9;border-radius:6px;background:#fff;color:rgba(0,0,0,.88);cursor:pointer;font-size:13px;line-height:1;transition:all .15s ease;font-family:inherit;}',
    '.ovw-toolbar__btn:hover,.ovw-toolbar__btn.is-open{color:#1677ff;border-color:#1677ff;background:rgba(22,119,255,.03);}',
    '.ovw-toolbar__panel{position:absolute;top:calc(100% + 6px);right:0;z-index:1000000;min-width:210px;padding:0;border:1px solid rgba(0,0,0,.06);border-radius:10px;background:#fff;box-shadow:0 8px 28px rgba(0,0,0,.13);overflow:hidden;}',
    '.ovw-toolbar__panel-head{display:flex;justify-content:space-between;align-items:center;padding:10px 14px 8px;font-size:12px;color:#8c8c8c;border-bottom:1px solid rgba(0,0,0,.04);}',
    '.ovw-toolbar__reset{border:0;background:transparent;color:#1677ff;cursor:pointer;font-size:12px;padding:0;}',
    '.ovw-toolbar__panel-list{max-height:340px;overflow-y:auto;padding:4px 0;}',
    '.ovw-toolbar__item{display:flex;align-items:center;gap:9px;padding:7px 14px;cursor:pointer;font-size:13px;color:rgba(0,0,0,.88);}',
    '.ovw-toolbar__item:hover{background:rgba(22,119,255,.05);}',
    '.ovw-toolbar__dot{width:8px;height:8px;border-radius:50%;display:inline-block;flex:0 0 8px;}',
    '.ovw-popover{position:fixed;z-index:1000001;width:260px;padding:0;border:1px solid rgba(0,0,0,.06);border-radius:12px;background:#fff;box-shadow:0 12px 36px rgba(0,0,0,.16);color:rgba(0,0,0,.88);font:13px/1.5 Roboto,Arial,sans-serif;overflow:hidden;box-sizing:border-box;}',
    '.ovw-popover__head{display:flex;justify-content:space-between;align-items:center;padding:12px 14px 10px;border-bottom:1px solid rgba(0,0,0,.05);}',
    '.ovw-popover__title{font-weight:600;font-size:13px;}',
    '.ovw-popover__close{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border:0;border-radius:5px;background:transparent;color:#8c8c8c;cursor:pointer;padding:0;}',
    '.ovw-popover__close:hover{background:rgba(0,0,0,.05);color:#262626;}',
    '.ovw-popover__body{padding:8px;max-height:340px;overflow-y:auto;}',
    '.ovw-popover__row{display:grid;grid-template-columns:10px 1fr auto;align-items:center;gap:8px;padding:5px 8px;border-radius:5px;font-size:12.5px;}',
    '.ovw-popover__row--clickable{cursor:pointer;}',
    '.ovw-popover__row--clickable:hover{background:rgba(22,119,255,.08);}',
    '.ovw-popover__dot{width:7px;height:7px;border-radius:50%;}',
    '.ovw-popover__label{color:#595959;}',
    '.ovw-popover__num{color:#262626;font-weight:600;font-variant-numeric:tabular-nums;}',
    '.ovw-popover__arrow{color:#1677ff;opacity:.6;font-weight:600;}',
    '.ovw-popover__row--clickable:hover .ovw-popover__arrow{opacity:1;}',
    '.ovw-popover__foot{padding:8px 14px 12px;border-top:1px solid rgba(0,0,0,.05);background:rgba(250,250,251,.6);}',
    '.ovw-popover__foot-row{display:flex;justify-content:space-between;gap:12px;padding:2px 0;font-size:12.5px;color:#8c8c8c;}',
    '.ovw-popover__foot-row--strong{color:rgba(0,0,0,.88);font-weight:600;}',
    '.ovw-popover__time{margin-top:6px;text-align:right;font-size:11px;color:#bfbfbf;}',
    '.ovw-filter-hint{position:fixed;top:80px;right:20px;z-index:1000002;display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:10px;background:#fff;border:1px solid rgba(22,119,255,.25);box-shadow:0 8px 24px rgba(22,119,255,.15);color:rgba(0,0,0,.88);font:13px/1.4 Roboto,Arial,sans-serif;max-width:420px;}',
    '.ovw-filter-hint__icon{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:50%;background:linear-gradient(180deg,#1677ff,#4096ff);color:#fff;flex:0 0 26px;}',
    '.ovw-filter-hint__text{flex:1;min-width:0;}',
    '.ovw-filter-hint__title{font-weight:600;font-size:13px;}',
    '.ovw-filter-hint__desc{font-size:11.5px;color:#8c8c8c;margin-top:2px;word-break:break-all;}',
    '.ovw-filter-hint__close{border:0;background:transparent;color:#8c8c8c;cursor:pointer;padding:2px 4px;font-size:16px;line-height:1;}'
  ].join('');

  function addStyle() {
    if (document.getElementById('ovw-style')) return;
    var style = document.createElement('style');
    style.id = 'ovw-style';
    style.textContent = CSS_TEXT;
    document.head.appendChild(style);
  }

  var ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function escapeHtml(v) { return String(v).replace(/[&<>"']/g, function (c) { return ESCAPE_MAP[c]; }); }
  function formatTime(ts) { return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }); }

  document.addEventListener('click', function (e) {
    if (openPopover && !openPopover.contains(e.target) && !(e.target.closest && e.target.closest('.ovw-summary'))) closePopover();
  }, true);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closePopover(); });

  /* ============================================================
   * data 页自动筛选执行
   * ============================================================ */

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function setNativeValue(el, value) {
    try {
      var proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, value);
    } catch (e) { el.value = value; }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function findFiltersButton() {
    var btns = document.querySelectorAll('button.dm-button, button.dm-dropdown__trigger');
    for (var i = 0; i < btns.length; i++) {
      var el = btns[i];
      if (el.offsetParent === null) continue;
      var txt = (el.textContent || '').replace(/__Cici__\S+/g, '').trim();
      if (/Filters|筛选器|筛选/i.test(txt)) return el;
    }
    var all = document.querySelectorAll('button');
    for (var j = 0; j < all.length; j++) {
      if (all[j].offsetParent === null) continue;
      if (/Filters|筛选器/i.test(all[j].textContent || '')) return all[j];
    }
    return null;
  }

  function findFilterPanel() {
    var panels = document.querySelectorAll('.dm-dropdown.dm-visible, .dm-dropdown');
    for (var i = 0; i < panels.length; i++) {
      var p = panels[i];
      if (p.querySelector('.dm-filters')) return p;
    }
    return null;
  }

  function findAddFilterButton(panel) {
    var btns = panel.querySelectorAll('button.dm-button, button');
    for (var i = 0; i < btns.length; i++) {
      var el = btns[i];
      if (el.offsetParent === null) continue;
      var txt = (el.textContent || '').replace(/__Cici__\S+/g, '').trim();
      if (/Add Another|再加一个/i.test(txt)) continue;
      if (/Add Filter|添加筛选|添加条件/i.test(txt)) return el;
    }
    for (var j = 0; j < btns.length; j++) {
      var b = btns[j];
      if (b.offsetParent === null) continue;
      var svg = b.querySelector('svg');
      if (!svg) continue;
      var path = svg.querySelector('path');
      var d = path ? (path.getAttribute('d') || '') : '';
      if (/M416 208H272V64c0-17.67/.test(d)) return b;
    }
    return null;
  }

  function findFieldTrigger(panel) {
    var field = panel.querySelector('.dm-filter-line__column.dm-field, .dm-field');
    if (!field) return null;
    return field.querySelector('.dm-select__selected, .dm-dropdown__trigger');
  }

  function findValueInput(panel) {
    var valCol = panel.querySelector('.dm-filter-line__column.dm-value, .dm-value');
    if (!valCol) return null;
    return valCol.querySelector('input.dm-input, input[type="text"]');
  }

  function hasFilterRow(panel) {
    return !!panel.querySelector('.dm-filter-line__column.dm-field, .dm-filter-line__column.dm-value');
  }

  function findApplyButton(panel) {
    var btns = panel.querySelectorAll('button.dm-button');
    for (var i = 0; i < btns.length; i++) {
      var txt = (btns[i].textContent || '').replace(/__Cici__\S+/g, '').trim();
      if (/Apply|应用|确认|查询|Search/i.test(txt)) return btns[i];
    }
    return null;
  }

  async function selectOptionFromDropdown(trigger, matcher) {
    trigger.click();
    await sleep(200);
    var selectors = [
      '.dm-select__option', '.dm-dropdown__item', '.dm-dropdown__option',
      '.dm-list-item', '[role="option"]', '.dm-option', 'li.dm-option'
    ];
    for (var s = 0; s < selectors.length; s++) {
      var els = document.querySelectorAll(selectors[s]);
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (el.offsetParent === null) continue;
        var txt = (el.textContent || '').replace(/__Cici__\S+/g, '').trim();
        if (matcher(txt)) {
          log('选中 option:', txt.slice(0, 30));
          el.click();
          await sleep(150);
          return true;
        }
      }
    }
    var all = document.querySelectorAll('div, li, span');
    for (var k = 0; k < all.length; k++) {
      var e = all[k];
      if (e.offsetParent === null) continue;
      if (e.children.length > 3) continue;
      var t = (e.textContent || '').replace(/__Cici__\S+/g, '').trim();
      if (t.length > 30) continue;
      if (matcher(t)) {
        log('兜底选中:', t);
        e.click();
        await sleep(150);
        return true;
      }
    }
    return false;
  }

  async function autoFillFilter(intent) {
    var candidates = intent.candidates || [intent.filterValue || intent.code];
    log('自动筛选开始，候选值：', candidates);

    // 1. 点 Filters
    var btn = findFiltersButton();
    if (!btn) { log('未找到 Filters 按钮'); return false; }
    btn.click();
    log('已点击 Filters');

    // 2. 等面板
    var panel = null;
    for (var i = 0; i < 20; i++) {
      await sleep(100);
      panel = findFilterPanel();
      if (panel) break;
    }
    if (!panel) { log('面板未出现'); return false; }
    log('面板已打开');

    // 3. 确保有筛选行
    if (!hasFilterRow(panel)) {
      var addBtn = findAddFilterButton(panel);
      if (addBtn) {
        log('点击 Add Filter');
        addBtn.click();
        for (var w = 0; w < 20; w++) {
          await sleep(100);
          if (hasFilterRow(panel)) break;
        }
      }
    }
    if (!hasFilterRow(panel)) { log('筛选行未出现'); return false; }
    log('筛选行存在');

    // 4. 字段切换为 State
    var fieldTrigger = findFieldTrigger(panel);
    if (fieldTrigger) {
      var fieldTxt = (fieldTrigger.textContent || '').replace(/__Cici__\S+/g, '').trim();
      log('当前字段：', fieldTxt);
      if (!/State|状态/i.test(fieldTxt)) {
        await selectOptionFromDropdown(fieldTrigger, function (t) {
          return /State|状态/i.test(t);
        });
        await sleep(200);
        fieldTrigger = findFieldTrigger(panel);
        if (fieldTrigger) {
          log('切换后字段：', (fieldTrigger.textContent || '').replace(/__Cici__\S+/g, '').trim());
        }
      }
    } else {
      log('未找到字段触发器');
    }

    // 操作符保持 contains，不动

    // 5. 填值
    var valueInput = findValueInput(panel);
    if (!valueInput) { log('未找到值输入框'); return false; }

    for (var ci = 0; ci < candidates.length; ci++) {
      var val = candidates[ci];
      log('尝试填入：', val);
      setNativeValue(valueInput, val);
      await sleep(150);
    }

    // 6. 应用
    var applyBtn = findApplyButton(panel);
    if (applyBtn) {
      applyBtn.click();
      log('已点击应用');
    } else {
      valueInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      log('已回车提交');
    }
    return true;
  }

  function runDataPageFilterExecutor() {
    var raw = null;
    try { raw = sessionStorage.getItem(PENDING_KEY); } catch (e) {}
    if (!raw) return;
    var intent = null;
    try { intent = JSON.parse(raw); } catch (e) {}
    if (!intent) return;
    if (Date.now() - (intent.ts || 0) > 10 * 60 * 1000) {
      try { sessionStorage.removeItem(PENDING_KEY); } catch (e) {}
      return;
    }
    try { sessionStorage.removeItem(PENDING_KEY); } catch (e) {}

    setTimeout(async function () {
      injectFilterHint(intent);
      if (CONFIG.autoApplyFilter) {
        for (var i = 0; i < 30; i++) {
          if (findFiltersButton()) break;
          await sleep(200);
        }
        var ok = await autoFillFilter(intent);
        log('自动筛选结果：', ok);
      }
    }, 1200);
  }

  function injectFilterHint(intent) {
    if (document.querySelector('.ovw-filter-hint')) return;
    var cands = (intent.candidates || []).join(' / ');
    var hint = document.createElement('div');
    hint.className = 'ovw-filter-hint';
    hint.innerHTML =
      '<span class="ovw-filter-hint__icon"><svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M10 18h4v-2h-4v2zM3 6v2h18V6H3zm3 7h12v-2H6v2z"/></svg></span>' +
      '<div class="ovw-filter-hint__text">' +
        '<div class="ovw-filter-hint__title">正在自动筛选：' + escapeHtml(intent.label || intent.code) + '</div>' +
        '<div class="ovw-filter-hint__desc">候选值：' + escapeHtml(cands) + '</div>' +
      '</div>' +
      '<button type="button" class="ovw-filter-hint__close">×</button>';
    document.body.appendChild(hint);
    hint.querySelector('.ovw-filter-hint__close').addEventListener('click', function () { hint.remove(); });
    setTimeout(function () {
      if (hint.parentNode) {
        hint.style.transition = 'opacity .4s ease';
        hint.style.opacity = '0';
        setTimeout(function () { if (hint.parentNode) hint.remove(); }, 400);
      }
    }, 12000);
  }

  /* ============================================================
   * 路由感知
   * ============================================================ */

  var active = false, observer = null, scanTimer = null;
  function scheduleScan() {
    if (!active) return;
    if (scanTimer) return;
    scanTimer = setTimeout(function () {
      scanTimer = null;
      if (!active) return;
      try { scanCards(); injectFieldsToolbar(); } catch (e) {}
    }, CONFIG.mountDelayMs);
  }
  function activate() {
    if (active) return;
    active = true;
    addStyle();
    var tries = 0;
    var kick = function () {
      if (!active) return;
      tries += 1;
      var hasCards = document.querySelectorAll(CONFIG.cardSelector).length > 0;
      var hasSearch = Boolean(findSearchInput());
      if ((hasCards && hasSearch) || tries > 30) {
        scanCards(); injectFieldsToolbar();
        if (!observer) {
          observer = new MutationObserver(scheduleScan);
          observer.observe(document.body, { childList: true, subtree: true });
        }
      } else setTimeout(kick, 250);
    };
    kick();
  }
  function deactivate() {
    if (!active) return;
    active = false;
    if (observer) { observer.disconnect(); observer = null; }
    if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
    document.querySelectorAll('.ovw-summary, .ovw-toolbar, .ovw-popover').forEach(function (el) {
      if (el.parentNode) el.parentNode.removeChild(el);
    });
    document.querySelectorAll('[data-ovw-mounted]').forEach(function (el) { delete el.dataset.ovwMounted; });
    closePopover();
    cache = {};
    var style = document.getElementById('ovw-style');
    if (style && style.parentNode) style.parentNode.removeChild(style);
  }
  function checkRoute() {
    if (isListPage()) activate(); else deactivate();
    if (isDataPage()) { addStyle(); runDataPageFilterExecutor(); }
  }
  (function hookRouter() {
    var op = history.pushState;
    history.pushState = function () { var r = op.apply(this, arguments); setTimeout(checkRoute, 0); return r; };
    var or = history.replaceState;
    history.replaceState = function () { var r = or.apply(this, arguments); setTimeout(checkRoute, 0); return r; };
    window.addEventListener('popstate', function () { setTimeout(checkRoute, 0); });
  })();

  if (DEBUG) {
    window.__OVW = {
      active: function () { return active; },
      page: function () { return isListPage() ? 'list' : (isDataPage() ? 'data' : 'other'); },
      setFilter: function (code, label) {
        var cands = FILTER_VALUE_CANDIDATES[code] || [code];
        sessionStorage.setItem(PENDING_KEY, JSON.stringify({
          code: code, label: label || STATUS_LABELS[code] || code,
          candidates: cands, ts: Date.now()
        }));
        return { code: code, candidates: cands };
      },
      intent: function () { try { return JSON.parse(sessionStorage.getItem(PENDING_KEY) || 'null'); } catch (e) { return null; } },
      testFilter: function () { var btn = findFiltersButton(); return btn ? btn.outerHTML.slice(0, 300) : '未找到'; },
      autoApply: function () { var i = this.intent(); if (i) autoFillFilter(i); },
      dump: function () {
        var panel = findFilterPanel();
        if (!panel) return '面板未打开';
        return {
          有筛选行: hasFilterRow(panel),
          字段触发器HTML: (findFieldTrigger(panel) || {}).outerHTML,
          值输入框HTML: (findValueInput(panel) || {}).outerHTML,
          应用按钮HTML: (findApplyButton(panel) || {}).outerHTML
        };
      }
    };
    console.log('[概览] DEBUG 开启');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', checkRoute, { once: true });
  else checkRoute();
})();
