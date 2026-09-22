// ==UserScript==
// @name         Insta360 项目概览
// @namespace    https://label.insta360.com/
// @author       chengzi
// @version      3.3.0
// @description  在项目卡片原有内容下方追加状态进度条与统计数字（文字颜色随底色自适应）+ 状态跳转自动筛选
// @match        *://label.insta360.com/*
// @run-at       document-idle
// @grant        none
// @noframes
// @updateURL    https://raw.githubusercontent.com/chengzi-1225/Insta360-chengzi/refs/heads/main/insta360-overview.user.js
// @downloadURL  https://raw.githubusercontent.com/chengzi-1225/Insta360-chengzi/refs/heads/main/insta360-overview.user.js
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
  var statsEnabled = false;

  var CONFIG = {
    cardSelector: '.ls-project-card',
    detailSelector: '.ls-project-card__detail',
    detailFallback: '.ls-project-card__description',
    cacheTtlMs: 60 * 1000,
    projectPath: '/api/projects',
    taskPath: '/api/dm/tasks',
    settingsKey: 'insta360-overview-fields-v2',
    fastMode: true,
    detailConcurrency: 2,
    taskPageSize: 500,
    taskPageConcurrency: 12,
    defaultPendingWhenNoStatus: true,
    mountDelayMs: 120,
    autoApplyFilter: true,
    manualModeOnAllWorkspace: true,
    allWorkspaceCardLimit: 50
  };

  function isAllWorkspace() {
    return /^\/workspaces\/all(\/|$)/.test(location.pathname) || /\/workspaces\/all\//.test(location.pathname);
  }

  function shouldManualMode(cardCount) {
    if (!CONFIG.manualModeOnAllWorkspace) return false;
    if (isAllWorkspace()) return true;
    if (cardCount > CONFIG.allWorkspaceCardLimit) return true;
    return false;
  }

  var STATUS_CODES = [
    'PENDING_ANNOTATION', 'ANNOTATED',
    'REVIEWED_ACCEPTED', 'REVIEWED_REJECTED',
    'APPEALED', 'APPEAL_ACCEPTED', 'APPEAL_REJECTED',
    'ACCEPTANCE_ACCEPTED', 'ACCEPTANCE_REJECTED',
    'REWORK', 'REPAIR'
  ];

  var STATUS_LABELS = {
    PENDING_ANNOTATION: '待标注', ANNOTATED: '已提交',
    REVIEWED_ACCEPTED: '审核通过', REVIEWED_REJECTED: '审核驳回',
    APPEALED: '已申诉', APPEAL_ACCEPTED: '申诉通过', APPEAL_REJECTED: '申诉拒绝',
    ACCEPTANCE_ACCEPTED: '验收通过', ACCEPTANCE_REJECTED: '验收拒绝',
    REWORK: '返工', REPAIR: '返修'
  };

  var FILTER_VALUE_CANDIDATES = {
    PENDING_ANNOTATION: ['CREATED', 'PENDING', 'created'],
    ANNOTATED:          ['ANNOTATED', 'annotated'],
    REVIEWED_ACCEPTED:  ['REVIEWED_ACCEPTED', 'reviewed_accepted'],
    REVIEWED_REJECTED:  ['REVIEWED_REJECTED', 'reviewed_rejected'],
    REWORK:             ['REWORK', 'rework'],
    REPAIR:             ['REPAIR', 'repair', 'REPAIRED', 'repaired', '修复']
  };

  var FILTERABLE = {
    PENDING_ANNOTATION: 1, ANNOTATED: 1,
    REVIEWED_ACCEPTED: 1, REVIEWED_REJECTED: 1,
    REWORK: 1, REPAIR: 1
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
    APPEALING: 'APPEALED',
    REWORK: 'REWORK', REWORKING: 'REWORK',
    REPAIR: 'REPAIR', REPAIRING: 'REPAIR', REPAIRED: 'REPAIR',
    '已提交': 'ANNOTATED', '待标注': 'PENDING_ANNOTATION',
    '审核通过': 'REVIEWED_ACCEPTED', '审核驳回': 'REVIEWED_REJECTED',
    '审核未通过': 'REVIEWED_REJECTED', '已申诉': 'APPEALED',
    '申诉通过': 'APPEAL_ACCEPTED', '申诉拒绝': 'APPEAL_REJECTED',
    '验收通过': 'ACCEPTANCE_ACCEPTED', '验收拒绝': 'ACCEPTANCE_REJECTED',
    '返工': 'REWORK', '返修': 'REPAIR', '返工/返修': 'REWORK'
  };

  function log() {
    if (!DEBUG) return;
    try { console.log.apply(console, ['[概览]'].concat([].slice.call(arguments))); } catch (e) {}
  }

  /* ============================================================
   * 字段定义（percent → 进度条；其余 → 数字格）
   * ============================================================ */

  var FIELD_DEFS = [
    { key: 'annotationProgress',  label: '标注进度', short: '标注',     color: '#52c41a', kind: 'percent' },
    { key: 'reviewProgress',      label: '审核进度', short: '审核',     color: '#13c2c2', kind: 'percent' },
    { key: 'repairProgress',      label: '返修进度', short: '返修',     color: '#ff4d4f', kind: 'percent' },
    { key: 'total',               label: '总数',     short: '总数',     color: '#1677ff', kind: 'total' },
    { key: 'ANNOTATED',           label: '已标注',   short: '已标注',   color: '#52c41a', kind: 'status' },
    { key: 'REVIEWED_ACCEPTED',   label: '已审核',   short: '已审核',   color: '#13c2c2', kind: 'status' },
    { key: 'REPAIR',              label: '待返修',   short: '待返修',   color: '#ff4d4f', kind: 'status' },
    { key: 'REWORK',              label: '待返工',   short: '待返工',   color: '#fa8c16', kind: 'status' },
    { key: 'PENDING_ANNOTATION',  label: '待标注',   short: '待标注',   color: '#8c8c8c', kind: 'status' },
    { key: 'REVIEWED_REJECTED',   label: '审核驳回', short: '审核驳回', color: '#ff4d4f', kind: 'status' },
    { key: 'ACCEPTANCE_ACCEPTED', label: '验收通过', short: '验收通过', color: '#52c41a', kind: 'status' },
    { key: 'ACCEPTANCE_REJECTED', label: '验收拒绝', short: '验收拒绝', color: '#ff4d4f', kind: 'status' }
  ];

  var FIELD_MAP = {};
  for (var fi = 0; fi < FIELD_DEFS.length; fi++) FIELD_MAP[FIELD_DEFS[fi].key] = FIELD_DEFS[fi];

  var DEFAULT_VISIBLE = [
    'annotationProgress', 'reviewProgress', 'repairProgress',
    'total', 'ANNOTATED', 'REVIEWED_ACCEPTED', 'REPAIR', 'REWORK'
  ];

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
    var rework = num(summary.user_rework_count);
    var repair = num(summary.user_repair_count);
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
    counts.REPAIR = repair;
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

  /* ============================================================
   * ★ 主题探测：读宿主真实底色决定文字明暗
   * ============================================================ */

  function parseColor(str) {
    if (!str) return null;
    if (str === 'transparent') return null;
    var m = String(str).match(/rgba?\(([^)]+)\)/i);
    if (!m) return null;
    var parts = m[1].split(',');
    if (parts.length < 3) return null;
    var r = parseFloat(parts[0]), g = parseFloat(parts[1]), b = parseFloat(parts[2]);
    var a = parts.length >= 4 ? parseFloat(parts[3]) : 1;
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null;
    if (!Number.isFinite(a)) a = 1;
    return { r: r, g: g, b: b, a: a };
  }

  function relLum(c) {
    function ch(v) {
      v = v / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    }
    return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
  }

  function detectTheme(startEl) {
    var node = startEl;
    var depth = 0;
    while (node && depth < 14) {
      var bg = '';
      try { bg = window.getComputedStyle(node).backgroundColor; } catch (e) { bg = ''; }
      var c = parseColor(bg);
      if (c && c.a > 0.5) {
        return relLum(c) > 0.5 ? 'light' : 'dark';
      }
      node = node.parentElement;
      depth += 1;
    }
    try {
      if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
    } catch (e) {}
    return 'light';
  }

  function applyTheme(summaryEl) {
    if (!summaryEl) return;
    var start = summaryEl.parentElement || summaryEl;
    var theme = detectTheme(start);
    if (summaryEl.dataset.ovwTheme !== theme) summaryEl.dataset.ovwTheme = theme;
  }

  /* ============================================================
   * 数值计算
   * ============================================================ */

  function computePercent(field, agg) {
    if (!agg) return 0;
    var counts = agg.counts || {};
    var total = Number(agg.total) || 0;
    if (!total) return 0;
    if (field.key === 'annotationProgress') {
      var pending = Number(counts.PENDING_ANNOTATION) || 0;
      return ((total - pending) / total) * 100;
    }
    if (field.key === 'reviewProgress') {
      var acc = Number(counts.REVIEWED_ACCEPTED) || 0;
      var rej = Number(counts.REVIEWED_REJECTED) || 0;
      return ((acc + rej) / total) * 100;
    }
    if (field.key === 'repairProgress') {
      var rw = Number(counts.REWORK) || 0;
      var rp = Number(counts.REPAIR) || 0;
      return ((rw + rp) / total) * 100;
    }
    return 0;
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
      var total = Number(agg.total) || 0;
      if (!total) return '—';
      return Math.round(computePercent(field, agg)) + '%';
    }
    return '—';
  }

  /* ============================================================
   * 图标
   * ============================================================ */

  var ICON_REFRESH = '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path fill="currentColor" d="M8 3a5 5 0 1 0 4.55 2.9l1.2-.7A6.5 6.5 0 1 1 8 1.5v1.5z"/><path fill="currentColor" d="M12.5 1v3h-3z"/></svg>';

  /* ============================================================
   * 卡片追加：创建 / 渲染
   * ============================================================ */

  function findDetailHost(card) {
    return card.querySelector(CONFIG.detailSelector)
      || card.querySelector(CONFIG.detailFallback)
      || card;
  }

  function createSummary(card, context) {
    var summary = card.querySelector('.ovw-summary');
    if (summary) { applyTheme(summary); return summary; }

    summary = document.createElement('div');
    summary.className = 'ovw-summary';
    summary.dataset.projectId = context.projectId;
    summary.dataset.ovwHref = context.href || '';

    summary.addEventListener('click', function (e) {
      var target = e.target;
      var cardEl = summary.closest(CONFIG.cardSelector);

      var refreshEl = target.closest ? target.closest('.ovw-refresh') : null;
      if (refreshEl) {
        e.preventDefault(); e.stopPropagation();
        if (cardEl) refreshProject(cardEl, { force: true });
        return;
      }

      var keyEl = target.closest ? target.closest('[data-ovw-key]') : null;
      if (keyEl && cardEl) {
        var key = keyEl.getAttribute('data-ovw-key');
        if (FILTERABLE[key]) {
          e.preventDefault(); e.stopPropagation();
          var def = FIELD_MAP[key];
          jumpToProjectWithFilter(cardEl, key, def ? def.label : key);
        }
      }
    });

    /* 悬停时重算一次主题，覆盖页面手动切换主题的情况 */
    summary.addEventListener('mouseenter', function () { applyTheme(summary); });

    findDetailHost(card).appendChild(summary);
    applyTheme(summary);
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
    applyTheme(summaryEl);
    summaryEl.setAttribute('aria-busy', loading ? 'true' : 'false');

    if (error) {
      summaryEl.innerHTML =
        '<button type="button" class="ovw-retry">统计失败，点击重试</button>';
      return;
    }
    if (!agg) {
      summaryEl.innerHTML =
        '<div class="ovw-skeleton"><span></span><span></span></div>';
      return;
    }

    var barDefs = [], statDefs = [];
    for (var i = 0; i < visibleFields.length; i++) {
      var def = FIELD_MAP[visibleFields[i]];
      if (!def) continue;
      if (def.kind === 'percent') barDefs.push(def); else statDefs.push(def);
    }

    var total = Number(agg.total) || 0;
    var html = '';

    if (barDefs.length) {
      html += '<div class="ovw-bars">';
      for (var b = 0; b < barDefs.length; b++) {
        var bd = barDefs[b];
        var pct = total ? computePercent(bd, agg) : 0;
        var shown = total ? (Math.round(pct) + '%') : '—';
        html += '<div class="ovw-bar" data-ovw-key="' + bd.key + '" style="--ovw-c:' + bd.color + '">' +
                  '<span class="ovw-bar__label">' + escapeHtml(bd.short || bd.label) + '</span>' +
                  '<span class="ovw-bar__track"><span class="ovw-bar__fill" style="width:' +
                    Math.max(0, Math.min(100, pct)) + '%"></span></span>' +
                  '<span class="ovw-bar__val">' + shown + '</span>' +
                '</div>';
      }
      html += '</div>';
    }

    if (statDefs.length) {
      html += '<div class="ovw-stats" style="grid-template-columns:repeat(' + statDefs.length + ',1fr)">';
      for (var s = 0; s < statDefs.length; s++) {
        var sd = statDefs[s];
        var val = computeFieldValue(sd, agg);
        html += '<div class="ovw-stat" data-ovw-key="' + sd.key + '" style="--ovw-c:' + sd.color + '">' +
                  '<span class="ovw-stat__num">' + escapeHtml(String(val)) + '</span>' +
                  '<span class="ovw-stat__label">' + escapeHtml(sd.label) + '</span>' +
                '</div>';
      }
      html += '</div>';
    }

    html += '<button type="button" class="ovw-refresh" title="刷新">' + ICON_REFRESH + '</button>';

    summaryEl.innerHTML = html;
  }

  function renderSummaryManual(summaryEl) {
    if (!summaryEl) return;
    applyTheme(summaryEl);
    summaryEl.innerHTML = '<button type="button" class="ovw-load-btn">点击统计本项目</button>';
    var btn = summaryEl.querySelector('.ovw-load-btn');
    if (!btn) return;
    ['mousedown', 'mouseup', 'pointerdown'].forEach(function (ev) {
      btn.addEventListener(ev, function (e) { e.stopPropagation(); });
    });
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var card = summaryEl.closest(CONFIG.cardSelector);
      if (card) {
        renderSummary(summaryEl, null, true);
        detailPool.run(function () { return refreshProject(card, { force: true }); }).catch(function () {});
      }
    });
  }

  /* ============================================================
   * 工具栏 / 扫描
   * ============================================================ */

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
        text.textContent = def.label + (def.kind === 'percent' ? '（进度条）' : '');
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

  function injectGlobalStatsToggle() {
    if (document.querySelector('.ovw-global-toggle')) return;
    var input = findSearchInput();
    if (!input) return;
    var host = input.closest('.ant-input-affix-wrapper')
      || input.closest('.ant-input-group-wrapper')
      || input.closest('.ant-input-search')
      || input.parentElement;
    if (!host || !host.parentElement) return;

    var totalCards = document.querySelectorAll(CONFIG.cardSelector).length;
    if (!shouldManualMode(totalCards)) return;

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ovw-global-toggle' + (statsEnabled ? ' is-on' : '');
    btn.textContent = statsEnabled ? '已开启统计' : '开启全部统计（' + totalCards + '）';
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (statsEnabled) return;
      statsEnabled = true;
      btn.textContent = '已开启统计';
      btn.classList.add('is-on');

      document.querySelectorAll(CONFIG.cardSelector).forEach(function (c) {
        delete c.dataset.ovwMounted;
      });
      scanCards();
    });

    var fieldsToolbar = host.parentElement.querySelector('.ovw-toolbar');
    if (fieldsToolbar && fieldsToolbar.nextSibling) {
      host.parentElement.insertBefore(btn, fieldsToolbar.nextSibling);
    } else {
      host.parentElement.insertBefore(btn, host.nextSibling);
    }
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

    var totalCards = document.querySelectorAll(CONFIG.cardSelector).length;
    if (shouldManualMode(totalCards) && !statsEnabled) {
      renderSummaryManual(card.querySelector('.ovw-summary'));
      return;
    }

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
   * 样式：颜色全部走 CSS 变量，随 data-ovw-theme 切换
   * ============================================================ */

  var CSS_TEXT = [
    /* ---- 追加区容器：默认浅色主题变量 ---- */
    '.ovw-summary{',
      '--ovw-label:#595959;',            /* 标签文字（明显但不抢眼） */
      '--ovw-label-strong:#262626;',     /* 需要强调的标签 */
      '--ovw-track:rgba(0,0,0,.08);',    /* 进度条轨道 */
      '--ovw-divider:rgba(0,0,0,.08);',  /* 顶部虚线 */
      '--ovw-hover:rgba(0,0,0,.045);',   /* 悬停底色 */
      '--ovw-icon:rgba(0,0,0,.35);',
      'position:relative;display:block;margin-top:10px;padding-top:9px;border-top:1px dashed var(--ovw-divider);',
      'color:var(--ovw-label-strong);',
      'font:12px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",Arial,sans-serif;',
      'box-sizing:border-box;',
    '}',

    /* ---- 深色主题变量覆盖 ---- */
    '.ovw-summary[data-ovw-theme="dark"]{',
      '--ovw-label:rgba(255,255,255,.80);',
      '--ovw-label-strong:#fff;',
      '--ovw-track:rgba(255,255,255,.18);',
      '--ovw-divider:rgba(255,255,255,.16);',
      '--ovw-hover:rgba(255,255,255,.10);',
      '--ovw-icon:rgba(255,255,255,.55);',
    '}',

    '.ovw-summary[aria-busy="true"]{opacity:.7;}',

    /* ---- 进度条 ---- */
    '.ovw-bars{display:flex;flex-direction:column;gap:7px;}',
    '.ovw-bar{display:grid;grid-template-columns:34px 1fr 40px;align-items:center;gap:9px;padding:1px 2px;border-radius:4px;cursor:default;}',
    '.ovw-bar[data-ovw-key]{cursor:pointer;}',
    '.ovw-bar[data-ovw-key]:hover{background:var(--ovw-hover);}',
    '.ovw-bar__label{font-size:11.5px;font-weight:500;color:var(--ovw-label);white-space:nowrap;}',
    '.ovw-bar__track{position:relative;height:5px;border-radius:3px;background:var(--ovw-track);overflow:hidden;}',
    '.ovw-bar__fill{display:block;height:100%;border-radius:3px;background:var(--ovw-c,#52c41a);transition:width .35s ease;}',
    '.ovw-bar__val{font-size:12px;font-weight:700;text-align:right;color:var(--ovw-c,#52c41a);font-variant-numeric:tabular-nums;}',

    /* ---- 数字格 ---- */
    '.ovw-stats{display:grid;gap:2px;margin-top:9px;}',
    '.ovw-stat{display:flex;flex-direction:column;align-items:center;gap:1px;padding:2px 0;border-radius:6px;cursor:pointer;transition:background .15s ease;}',
    '.ovw-stat:hover{background:var(--ovw-hover);}',
    '.ovw-stat__num{font-size:15px;font-weight:700;line-height:1.15;color:var(--ovw-c,#1677ff);font-variant-numeric:tabular-nums;}',
    '.ovw-stat__label{font-size:10.5px;font-weight:500;color:var(--ovw-label);white-space:nowrap;}',

    /* ---- 深色底：状态色提亮，保证对比度 ---- */
    '.ovw-summary[data-ovw-theme="dark"] .ovw-stat__num,',
    '.ovw-summary[data-ovw-theme="dark"] .ovw-bar__val{filter:brightness(1.28) saturate(1.05);}',
    '.ovw-summary[data-ovw-theme="dark"] .ovw-bar__fill{filter:brightness(1.18) saturate(1.05);}',

    /* ---- 刷新 ---- */
    '.ovw-refresh{position:absolute;top:6px;right:0;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;padding:0;border:0;border-radius:4px;background:transparent;color:var(--ovw-icon);cursor:pointer;opacity:0;transition:opacity .15s ease,color .15s ease,background .15s ease;}',
    '.ovw-summary:hover .ovw-refresh{opacity:1;}',
    '.ovw-refresh:hover{background:rgba(22,119,255,.14);color:#1677ff;}',

    /* ---- 状态 ---- */
    '.ovw-skeleton{display:flex;flex-direction:column;gap:8px;padding:4px 0;}',
    '.ovw-skeleton span{display:block;height:7px;border-radius:4px;background:var(--ovw-track);background-image:linear-gradient(90deg,transparent,rgba(128,128,128,.18),transparent);background-size:200% 100%;animation:ovw-shimmer 1.2s infinite;}',
    '.ovw-skeleton span:nth-child(1){width:82%;}',
    '.ovw-skeleton span:nth-child(2){width:60%;}',
    '@keyframes ovw-shimmer{0%{background-position:200% 0;}100%{background-position:-200% 0;}}',
    '.ovw-retry{display:block;width:100%;padding:5px 8px;border:1px dashed rgba(255,77,79,.55);border-radius:6px;background:rgba(255,77,79,.06);color:#cf1322;font-size:11.5px;font-weight:500;cursor:pointer;font-family:inherit;}',
    '.ovw-summary[data-ovw-theme="dark"] .ovw-retry{color:#ff7875;background:rgba(255,77,79,.12);}',
    '.ovw-retry:hover{background:rgba(255,77,79,.16);}',
    '.ovw-load-btn{display:inline-flex;align-items:center;justify-content:center;width:100%;padding:5px 10px;border:1px solid rgba(22,119,255,.45);border-radius:6px;background:rgba(22,119,255,.05);color:#1677ff;cursor:pointer;font-size:12px;font-weight:500;font-family:inherit;white-space:nowrap;transition:all .12s ease;}',
    '.ovw-load-btn:hover{background:rgba(22,119,255,.14);border-color:#1677ff;}',

    /* ---- 顶部工具栏 ---- */
    '.ovw-toolbar{position:relative;display:inline-block;vertical-align:middle;margin-left:8px;font:14px/1.5 Roboto,Arial,sans-serif;white-space:nowrap;flex:0 0 auto;}',
    '.ovw-toolbar__btn{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 12px;border:1px solid #d9d9d9;border-radius:6px;background:#fff;color:rgba(0,0,0,.88);cursor:pointer;font-size:13px;line-height:1;white-space:nowrap;transition:all .15s ease;font-family:inherit;}',
    '.ovw-toolbar__btn:hover,.ovw-toolbar__btn.is-open{color:#1677ff;border-color:#1677ff;background:rgba(22,119,255,.03);}',
    '.ovw-toolbar__panel{position:absolute;top:calc(100% + 6px);right:0;z-index:1000000;min-width:220px;padding:0;border:1px solid rgba(0,0,0,.06);border-radius:10px;background:#fff;box-shadow:0 8px 28px rgba(0,0,0,.13);overflow:hidden;}',
    '.ovw-toolbar__panel-head{display:flex;justify-content:space-between;align-items:center;padding:10px 14px 8px;font-size:12px;color:#8c8c8c;border-bottom:1px solid rgba(0,0,0,.04);}',
    '.ovw-toolbar__reset{border:0;background:transparent;color:#1677ff;cursor:pointer;font-size:12px;padding:0;}',
    '.ovw-toolbar__panel-list{max-height:340px;overflow-y:auto;padding:4px 0;}',
    '.ovw-toolbar__item{display:flex;align-items:center;gap:9px;padding:7px 14px;cursor:pointer;font-size:13px;color:rgba(0,0,0,.88);}',
    '.ovw-toolbar__item:hover{background:rgba(22,119,255,.05);}',
    '.ovw-toolbar__dot{width:8px;height:8px;border-radius:50%;display:inline-block;flex:0 0 8px;}',

    /* ---- 全部统计开关 ---- */
    '.ovw-global-toggle{display:inline-flex;align-items:center;height:32px;padding:0 14px;margin-left:8px;border:1px solid #1677ff;border-radius:6px;background:#1677ff;color:#fff;cursor:pointer;font-size:13px;font-family:inherit;white-space:nowrap;flex:0 0 auto;transition:all .15s ease;}',
    '.ovw-global-toggle:hover{background:#0958d9;border-color:#0958d9;}',
    '.ovw-global-toggle.is-on{background:#f5f5f5;color:#8c8c8c;border-color:#d9d9d9;cursor:default;}',

    /* ---- 筛选提示 ---- */
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

    var btn = findFiltersButton();
    if (!btn) { log('未找到 Filters 按钮'); return false; }
    btn.click();
    log('已点击 Filters');

    var panel = null;
    for (var i = 0; i < 20; i++) {
      await sleep(100);
      panel = findFilterPanel();
      if (panel) break;
    }
    if (!panel) { log('面板未出现'); return false; }
    log('面板已打开');

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

    var valueInput = findValueInput(panel);
    if (!valueInput) { log('未找到值输入框'); return false; }

    for (var ci = 0; ci < candidates.length; ci++) {
      var val = candidates[ci];
      log('尝试填入：', val);
      setNativeValue(valueInput, val);
      await sleep(150);
    }

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
      try { scanCards(); injectFieldsToolbar(); injectGlobalStatsToggle(); } catch (e) {}
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
        scanCards(); injectFieldsToolbar(); injectGlobalStatsToggle();
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
    statsEnabled = false;
    if (observer) { observer.disconnect(); observer = null; }
    if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
    document.querySelectorAll('.ovw-summary, .ovw-toolbar, .ovw-global-toggle').forEach(function (el) {
      if (el.parentNode) el.parentNode.removeChild(el);
    });
    document.querySelectorAll('[data-ovw-mounted]').forEach(function (el) { delete el.dataset.ovwMounted; });
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
      statsEnabled: function () { return statsEnabled; },
      theme: function () {
        var el = document.querySelector('.ovw-summary');
        return el ? { theme: el.dataset.ovwTheme, bg: window.getComputedStyle(el.parentElement || el).backgroundColor } : '未挂载';
      },
      rescanTheme: function () {
        document.querySelectorAll('.ovw-summary').forEach(applyTheme);
        return '已重算主题';
      },
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
