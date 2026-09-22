// ==UserScript==
// @name         Insta360 我的返修面板
// @namespace    https://label.insta360.com/
// @author       chengzi
// @version      1.5.0
// @description  侧边栏「我的返修」按钮，只显示属于本人的审核驳回任务（含进度条）
// @match        *://label.insta360.com/*
// @run-at       document-idle
// @grant        none
// @noframes
// @updateURL    https://raw.githubusercontent.com/chengzi-1225/Insta360-chengzi/refs/heads/main/insta360-my-rework.user.js
// @downloadURL  https://raw.githubusercontent.com/chengzi-1225/Insta360-chengzi/refs/heads/main/insta360-my-rework.user.js
// ==/UserScript==

(function () {
  'use strict';

  var DEBUG = false;
  var log = function () { if (DEBUG) try { console.log.apply(console, ['[返修]'].concat([].slice.call(arguments))); } catch (e) {} };

  var CONFIG = {
    projectPath: '/api/projects',
    taskPath: '/api/tasks',        // ★ v1.3.1：新接口路径
    whoamiPath: '/api/current-user/whoami',
    pageSize: 500,
    projectIdPageSize: 2000,
    projectBatchSize: 800,
    projectBatchConcurrency: 6,
    userCountFields: 'id,user_rework_count,user_repair_count',
    maxTaskPages: 50,
    concurrency: 4,
    pageConcurrency: 3,
    useRejectedFilter: true,
    rejectedQueryKey: 'status',
    rejectedQueryValue: 'REVIEWED_REJECTED',
    cacheTtlMs: 60 * 1000,
    rejectedStatuses: ['REVIEWED_REJECTED', 'REVIEW_REJECTED', 'REJECTED'],
  };

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

  function num(v) { var n = Number(v); return Number.isFinite(n) ? n : 0; }

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
    if (!res.ok) { var e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
    return res.json();
  }

  function rowsFromResponse(body) {
    if (Array.isArray(body)) return body;
    if (body && typeof body === 'object') {
      var keys = ['results', 'tasks', 'items', 'data', 'projects'];
      for (var i = 0; i < keys.length; i++) {
        if (Array.isArray(body[keys[i]])) return body[keys[i]];
      }
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

  function responseNext(body) {
    return body && typeof body.next === 'string' && body.next ? body.next : '';
  }

  /* ============================================================
   * 任务分页拉取：优先按驳回状态筛选，首屏拿到 total 后并行拉后续页
   * ============================================================ */

  function taskKey(task, fallback) {
    if (!task || typeof task !== 'object') return '__row_' + fallback;
    var id = task.id != null ? task.id : task.task_id != null ? task.task_id : task.taskId;
    return id == null ? '__row_' + fallback : String(id);
  }

  function mergeTaskRows(groups) {
    var seen = {};
    var out = [];
    for (var i = 0; i < groups.length; i++) {
      var rows = groups[i] || [];
      for (var j = 0; j < rows.length; j++) {
        var key = taskKey(rows[j], out.length);
        if (seen[key]) continue;
        seen[key] = 1;
        out.push(rows[j]);
      }
    }
    return out;
  }

  function rejectedQueryParams() {
    var params = {};
    if (CONFIG.useRejectedFilter && CONFIG.rejectedQueryKey && CONFIG.rejectedQueryValue) {
      params[CONFIG.rejectedQueryKey] = CONFIG.rejectedQueryValue;
    }
    return params;
  }

  async function fetchTaskPage(pid, page, extraParams) {
    var params = Object.assign({ project: pid, page: page, page_size: CONFIG.pageSize }, extraParams || {});
    var body = await getJson(apiUrl(CONFIG.taskPath, params));
    return { body: body, rows: rowsFromResponse(body) };
  }

  async function fetchProjectTasks(pid) {
    var useFilterForPages = CONFIG.useRejectedFilter;
    var first = await fetchTaskPage(pid, 1, rejectedQueryParams());
    var firstRows = first.rows;

    // 有些部署会忽略 status 参数；发现返回了其它状态时自动回退，确保统计不漏。
    if (CONFIG.useRejectedFilter && firstRows.some(function (task) { return !isRejected(task); })) {
      first = await fetchTaskPage(pid, 1, {});
      firstRows = first.rows;
      useFilterForPages = false;
    }

    var total = totalFromResponse(first.body);
    var groups = [firstRows];
    var next = first.body && typeof first.body.next === 'string' ? first.body.next : '';
    var totalPages = total != null ? Math.min(CONFIG.maxTaskPages, Math.ceil(total / CONFIG.pageSize)) : 0;

    if (totalPages > 1) {
      var pagePool = new Pool(CONFIG.pageConcurrency);
      var pages = [];
      for (var page = 2; page <= totalPages; page++) pages.push(page);
      var pageResults = await Promise.all(pages.map(function (pageNo) {
        return pagePool.run(function () {
          return fetchTaskPage(pid, pageNo, useFilterForPages ? rejectedQueryParams() : {});
        });
      }));
      for (var i = 0; i < pageResults.length; i++) groups.push(pageResults[i].rows);
    } else if (next) {
      // 没有 total 时保留 next 链路兼容性；这类接口只能串行跟随链接。
      var url = next;
      for (var guard = 1; url && guard < CONFIG.maxTaskPages; guard++) {
        var body = await getJson(new URL(url, location.origin).toString());
        var rows = rowsFromResponse(body);
        if (!rows.length) break;
        groups.push(rows);
        url = body && typeof body.next === 'string' ? body.next : '';
      }
    } else if (firstRows.length >= CONFIG.pageSize) {
      // 接口没有 total/next 时按旧逻辑补页，避免截断数据。
      for (var fallbackPage = 2; fallbackPage <= CONFIG.maxTaskPages; fallbackPage++) {
        var fallback = await fetchTaskPage(pid, fallbackPage, useFilterForPages ? rejectedQueryParams() : {});
        if (!fallback.rows.length) break;
        groups.push(fallback.rows);
        if (fallback.rows.length < CONFIG.pageSize) break;
      }
    }
    return mergeTaskRows(groups);
  }

  async function fetchAllProjects(onProgress) {
    var curWs = (location.pathname.match(/\/workspaces\/([^/]+)/) || [])[1] || '';
    var list = [];
    var page = 1;
    var url = apiUrl(CONFIG.projectPath, Object.assign({ page: page, page_size: CONFIG.projectIdPageSize },
      curWs && curWs !== 'all' ? { workspace: curWs } : {}));

    for (var guard = 0; url && guard < 100; guard++) {
      var body = await getJson(url);
      var rows = rowsFromResponse(body);
      if (!rows.length) break;
      list = list.concat(rows);
      if (onProgress) onProgress('读取项目列表 ' + list.length + (totalFromResponse(body) != null ? ' / ' + totalFromResponse(body) : '') + '…');
      var next = responseNext(body);
      if (next) url = new URL(next, location.origin).toString();
      else if (rows.length >= CONFIG.projectIdPageSize) {
        page += 1;
        url = apiUrl(CONFIG.projectPath, Object.assign({ page: page, page_size: CONFIG.projectIdPageSize },
          curWs && curWs !== 'all' ? { workspace: curWs } : {}));
      } else url = '';
    }

    // 当前工作区接口偶尔只返回局部项目，保留原有 all 工作区兜底。
    if (curWs && curWs !== 'all' && list.length < 100) {
      try {
        var allBody = await getJson(apiUrl(CONFIG.projectPath, { page: 1, page_size: CONFIG.projectIdPageSize, workspace: 'all' }));
        var allRows = rowsFromResponse(allBody);
        if (allRows.length > list.length) list = allRows;
      } catch (e) {}
    }
    return list;
  }

  function projectIdChunks(projects) {
    var ids = projects.map(function (p) { return p.projectId != null ? p.projectId : p.id; }).filter(function (id) { return id != null; });
    var chunks = [];
    for (var i = 0; i < ids.length; i += CONFIG.projectBatchSize) {
      chunks.push(ids.slice(i, i + CONFIG.projectBatchSize));
    }
    return chunks;
  }

  async function fetchProjectUserCounts(projects, onProgress) {
    var chunks = projectIdChunks(projects);
    var rows = [];
    var done = 0;
    var failed = 0;
    var pool = new Pool(CONFIG.projectBatchConcurrency);
    await Promise.all(chunks.map(function (ids) {
      return pool.run(async function () {
        try {
          var body = await getJson(apiUrl(CONFIG.projectPath, {
            ids: ids.join(','),
            include: CONFIG.userCountFields,
            page_size: ids.length,
          }));
          rows = rows.concat(rowsFromResponse(body));
        } catch (e) {
          failed += 1;
          log('项目返修计数批次失败：', e.message);
        } finally {
          done += ids.length;
          if (onProgress) onProgress('统计我的返修 ' + Math.min(done, projects.length) + ' / ' + projects.length + '…' + (failed ? '（' + failed + ' 批失败）' : ''));
        }
      });
    }));
    return { rows: rows, failed: failed };
  }

  /* ============================================================
   * 识别当前用户
   * ============================================================ */

  function extractCleanText(el) {
    if (!el) return '';
    try {
      var clone = el.cloneNode(true);
      var kills = clone.querySelectorAll('.__Cici__translate__, .__Cici__translate__ *');
      for (var i = 0; i < kills.length; i++) {
        if (kills[i].parentNode) kills[i].parentNode.removeChild(kills[i]);
      }
      return (clone.textContent || '').trim();
    } catch (e) { return (el.textContent || '').trim(); }
  }

  function getSidebarUserName() {
    var el = document.querySelector('.ls-userpic__username');
    if (el) { var t = extractCleanText(el); if (t) return t; }
    var sels = ['.ls-userpic__name', '[class*="userpic"] [class*="name"]', '.ls-user-menu__name', '[class*="user-name"]'];
    for (var i = 0; i < sels.length; i++) {
      var e = document.querySelector(sels[i]);
      if (e) { var t2 = extractCleanText(e); if (t2 && t2.length < 50) return t2; }
    }
    return '';
  }

  async function fetchMe() {
    var me = { id: null, names: [], loaded: false };
    try {
      var j = await getJson(CONFIG.whoamiPath);
      if (j && typeof j === 'object') {
        if (j.id != null) me.id = String(j.id);
        var fn = j.first_name ? String(j.first_name).trim() : '';
        var ln = j.last_name ? String(j.last_name).trim() : '';
        if (fn && ln) { me.names.push(fn + ln); me.names.push(ln + fn); }
        if (fn) me.names.push(fn);
        if (ln) me.names.push(ln);
        if (j.username && !/^\d+$/.test(String(j.username).trim())) me.names.push(String(j.username).trim());
        if (j.email && String(j.email).indexOf('@') > 0) {
          var ep = String(j.email).split('@')[0];
          if (!/^\d+$/.test(ep)) me.names.push(ep);
        }
        ['name', 'display_name', 'nickname'].forEach(function (k) {
          if (j[k] != null && String(j[k]).trim()) me.names.push(String(j[k]).trim());
        });
      }
    } catch (e) { log('whoami 失败：', e.message); }

    var sidebarName = getSidebarUserName();
    if (sidebarName) me.names.push(sidebarName);

    var uniq = {};
    me.names = me.names.filter(function (v) {
      if (!v) return false;
      var key = v.replace(/\s+/g, '').toLowerCase();
      if (uniq[key]) return false;
      uniq[key] = 1;
      return true;
    });
    me.loaded = Boolean(me.id || me.names.length);
    return me;
  }

  /* ============================================================
   * 归属识别
   * ============================================================ */

  function collectTaskOwners(task) {
    var ids = [], names = [];
    var idKeys = ['annotator_id', 'assignee_id', 'user_id', 'completed_by', 'created_by_id', 'creator_id', 'owner_id', 'assigned_to_id', 'annotatorId', 'assigneeId', 'userId', 'completedBy', 'createdById', 'creatorId', 'ownerId', 'updated_by'];
    var nameKeys = ['annotator', 'assignee', 'user', 'created_by', 'creator', 'owner', 'assigned_to', 'annotator_name', 'assignee_name', 'created_by_name', 'creator_name', 'username', 'user_name', 'operator'];
    var arrayKeys = ['annotators', 'reviewers', 'acceptors', 'annotations', 'reviews', 'acceptances'];

    function pushUserObject(obj) {
      if (!obj) return;
      if (typeof obj === 'object') {
        if (obj.id != null) ids.push(String(obj.id));
        ['username', 'name', 'display_name', 'email', 'first_name', 'last_name', 'nickname'].forEach(function (nk) {
          if (obj[nk] != null && String(obj[nk]).trim()) names.push(String(obj[nk]).trim());
        });
        if (obj.first_name && obj.last_name) {
          names.push(obj.first_name + obj.last_name);
          names.push(obj.last_name + obj.first_name);
        }
      } else if (typeof obj === 'string' || typeof obj === 'number') {
        var sv = String(obj).trim();
        if (/^\d+$/.test(sv)) ids.push(sv); else names.push(sv);
      }
    }

    function scanRecord(rec) {
      if (!rec || typeof rec !== 'object') return;
      idKeys.forEach(function (k) { var v = rec[k]; if (v != null) { var sv = String(v).trim(); if (sv) ids.push(sv); } });
      nameKeys.forEach(function (k) {
        var v = rec[k]; if (v == null) return;
        if (typeof v === 'object') pushUserObject(v);
        else { var sv = String(v).trim(); if (sv) { if (/^\d+$/.test(sv)) ids.push(sv); else names.push(sv); } }
      });
      arrayKeys.forEach(function (k) { var arr = rec[k]; if (!Array.isArray(arr)) return; arr.forEach(pushUserObject); });
    }
    scanRecord(task);
    if (task.data && typeof task.data === 'object') scanRecord(task.data);
    if (task.meta && typeof task.meta === 'object') scanRecord(task.meta);
    [task.events, task.history, task.status_history, task.records].forEach(function (arr) {
      if (!Array.isArray(arr)) return;
      arr.forEach(function (ev) {
        if (!ev || typeof ev !== 'object') return;
        if (ev.user_id != null) ids.push(String(ev.user_id));
        if (ev.userId != null) ids.push(String(ev.userId));
        if (ev.user != null) pushUserObject(ev.user);
        if (ev.username) names.push(String(ev.username));
        if (ev.operator) names.push(String(ev.operator));
      });
    });
    var uI = {}, uN = {};
    ids = ids.filter(function (v) { if (!v || uI[v]) return false; uI[v] = 1; return true; });
    names = names.filter(function (v) {
      if (!v) return false;
      var k = v.replace(/\s+/g, '').toLowerCase();
      if (uN[k]) return false;
      uN[k] = 1;
      return true;
    });
    return { ids: ids, names: names };
  }

  function isMine(task, me) {
    if (!me || !me.loaded) return true;
    var owners = collectTaskOwners(task);
    if (!owners.ids.length && !owners.names.length) return false;
    if (me.id) {
      for (var i = 0; i < owners.ids.length; i++) if (owners.ids[i] === me.id) return true;
    }
    var myNames = me.names.map(function (n) { return n.replace(/\s+/g, '').toLowerCase(); });
    for (var j = 0; j < owners.names.length; j++) {
      var on = owners.names[j].replace(/\s+/g, '').toLowerCase();
      for (var k = 0; k < myNames.length; k++) {
        var mn = myNames[k]; if (!mn) continue;
        if (mn === on) return true;
        if (mn.length >= 2 && on.length >= 2 && (on.indexOf(mn) !== -1 || mn.indexOf(on) !== -1)) return true;
      }
    }
    return false;
  }

  function isRejected(task) {
    var stateKeys = ['currentStatus', 'current_status', 'workflowState', 'workflow_state', 'taskState', 'task_state', 'state', 'status'];
    for (var i = 0; i < stateKeys.length; i++) {
      var v = task[stateKeys[i]]; if (v == null) continue;
      var s = String(typeof v === 'object' ? (v.value || v.code || v.status || '') : v).toUpperCase().trim();
      for (var j = 0; j < CONFIG.rejectedStatuses.length; j++) {
        if (s === CONFIG.rejectedStatuses[j] || s.indexOf(CONFIG.rejectedStatuses[j]) !== -1) return true;
      }
    }
    var events = task.events || task.history || task.status_history;
    if (Array.isArray(events) && events.length) {
      var last = events[events.length - 1];
      var st = String((last && (last.status || last.state || last.toStatus)) || '').toUpperCase();
      for (var k = 0; k < CONFIG.rejectedStatuses.length; k++) {
        if (st === CONFIG.rejectedStatuses[k]) return true;
      }
    }
    return false;
  }

  /* ============================================================
   * 项目
   * ============================================================ */

  function projectPathFromHref(href) {
    if (!href) return null;
    var m = href.match(/\/workspaces\/([^/]+)\/projects\/(\d+)/);
    if (m) return { workspaceId: m[1], projectId: m[2], basePath: '/workspaces/' + m[1] + '/projects/' + m[2] + '/data' };
    return null;
  }

  function projectTitleFromApi(p) {
    if (!p) return '';
    var keys = ['title', 'name', 'project_name', 'projectName', 'display_name', 'project_title', 'label'];
    for (var i = 0; i < keys.length; i++) {
      var v = p[keys[i]];
      if (v != null && String(v).trim()) return String(v).trim();
    }
    if (p.project && typeof p.project === 'object') return projectTitleFromApi(p.project);
    return '';
  }

  function projectTitleFromCard(card) {
    var sels = ['.ls-project-card__title', '[class*="project-title"]', '[class*="card-title"]', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', '[role="heading"]'];
    for (var i = 0; i < sels.length; i++) {
      var el = card.querySelector(sels[i]);
      if (!el) continue;
      var t = (el.textContent || '').trim();
      if (t && t.length < 100) return t;
    }
    var kids = card.querySelectorAll('*');
    for (var j = 0; j < kids.length; j++) {
      var t2 = (kids[j].textContent || '').trim();
      if (t2 && t2.length > 1 && t2.length < 40 && kids[j].children.length === 0) return t2;
    }
    return '';
  }

  function projectsFromPage() {
    var cards = document.querySelectorAll('.ls-project-card');
    var out = [], seen = {};
    for (var i = 0; i < cards.length; i++) {
      var link = cards[i].closest('a[href]');
      var href = link ? link.getAttribute('href') : '';
      if (!href) {
        var inner = cards[i].querySelector('a[href]');
        if (inner) href = inner.getAttribute('href') || '';
      }
      var info = projectPathFromHref(href);
      if (!info || seen[info.projectId]) continue;
      seen[info.projectId] = 1;
      info.title = projectTitleFromCard(cards[i]) || '未命名项目';
      info.rejectedCount = 1;
      out.push(info);
    }
    return out;
  }

  function projectsFromApi(projects) {
    var curWs = (location.pathname.match(/\/workspaces\/([^/]+)/) || [])[1] || 'all';
    var out = [];
    for (var i = 0; i < projects.length; i++) {
      var p = projects[i];
      if (!p || p.id == null) continue;
      var ws = p.workspace != null ? String(p.workspace) : curWs;
      out.push({
        workspaceId: ws,
        projectId: String(p.id),
        title: projectTitleFromApi(p) || '未命名项目',
        basePath: '/workspaces/' + ws + '/projects/' + p.id + '/data',
        rejectedCount: num(p.review_rejected_count != null ? p.review_rejected_count :
                           p.review_reject_count != null ? p.review_reject_count : 0),
      });
    }
    return out;
  }

  /* ============================================================
   * 核心加载
   * ============================================================ */

  var cache = { loadedAt: 0, rows: null, promise: null, scanInfo: '', me: null };
  var projectCache = new Map();

  function getCachedProjectRow(project, me, force) {
    var key = String(project.projectId);
    var hit = projectCache.get(key);
    if (!force && hit && hit.row && Date.now() - hit.loadedAt < CONFIG.cacheTtlMs) {
      return Promise.resolve(hit.row);
    }
    if (!force && hit && hit.promise) return hit.promise;

    var promise = (async function () {
      try {
        var tasks = await fetchProjectTasks(project.projectId);
        var rejected = tasks.filter(function (t) { return isRejected(t) && isMine(t, me); });
        return { project: project, tasks: rejected, total: tasks.length };
      } catch (e) {
        log('项目 ' + project.projectId + ' 失败：', e.message);
        return { project: project, tasks: [], error: e.message };
      }
    })();
    projectCache.set(key, { loadedAt: 0, promise: promise, row: null });
    return promise.then(function (row) {
      projectCache.set(key, { loadedAt: Date.now(), promise: null, row: row });
      return row;
    }, function (err) {
      projectCache.delete(key);
      throw err;
    });
  }

  async function loadReworkRows(force, onUpdate) {
    if (!force && cache.rows && (Date.now() - cache.loadedAt < CONFIG.cacheTtlMs)) {
      if (onUpdate) onUpdate(cache.rows, cache.scanInfo, 0, 0);
      return cache.rows;
    }
    if (cache.promise && !force) return cache.promise;

    if (force) projectCache.clear();

    cache.promise = (async function () {
      var t0 = Date.now();
      var mePromise = fetchMe();
      var projects, scanInfo;
      try {
        var list = await fetchAllProjects(function (msg) {
          if (onUpdate) onUpdate([], '', 0, null, msg);
        });
        projects = projectsFromApi(list);
        scanInfo = 'API ' + projects.length + ' 个项目';
      } catch (e) {
        projects = projectsFromPage();
        scanInfo = '页面 ' + projects.length + ' 个项目（API 失败）';
      }

      var me = await mePromise;
      cache.me = me;
      if (!me.loaded) {
        scanInfo += '，⚠ 无法识别当前用户';
      } else {
        var displayName = '';
        for (var i = 0; i < me.names.length; i++) {
          if (!/^\d+$/.test(me.names[i])) { displayName = me.names[i]; break; }
        }
        if (!displayName) displayName = me.names[0] || '';
        scanInfo += '，当前用户 ' + (me.id ? '#' + me.id : '') + (displayName ? '「' + displayName + '」' : '');
      }

      // 先按项目批量查询当前用户的返修计数，只有命中的项目才补查任务明细。
      var countResult = await fetchProjectUserCounts(projects, function (msg) {
        if (onUpdate) onUpdate([], scanInfo, 0, null, msg);
      });
      var countById = {};
      countResult.rows.forEach(function (row) {
        if (row && row.id != null) countById[String(row.id)] = row;
      });
      projects.forEach(function (project) {
        var count = countById[String(project.projectId)];
        if (!count) return;
        project.userRepairCount = num(count.user_repair_count);
        project.userReworkCount = num(count.user_rework_count);
        project.hasUserCount = true;
      });

      var candidates = projects.filter(function (p) {
        if (p.hasUserCount) return p.userRepairCount > 0 || p.userReworkCount > 0;
        if (p.rejectedCount == null) return true;
        return p.rejectedCount > 0;
      });

      // 项目列表和当前用户加载完成后，立即把真实扫描总数交给界面。
      if (onUpdate) onUpdate([], scanInfo, 0, candidates.length, candidates.length ? '准备扫描 ' + candidates.length + ' 个项目…' : '没有需要扫描的驳回项目');

      if (!candidates.length) {
        var empty = [];
        cache.rows = empty;
        cache.loadedAt = Date.now();
        cache.scanInfo = scanInfo + '，无驳回项目';
        if (onUpdate) onUpdate(empty, cache.scanInfo, 0, 0);
        return empty;
      }

      var pool = new Pool(CONFIG.concurrency);
      var results = [];
      var completed = 0;
      var started = 0;
      var failCount = 0;
      var total = candidates.length;

      await Promise.all(candidates.map(function (p) {
        return pool.run(async function () {
          started += 1;
          if (onUpdate) {
            onUpdate(results.slice(), scanInfo, completed, total, '正在扫描项目 ' + started + ' / ' + total + '…');
          }
          var row = await getCachedProjectRow(p, me, force);
          if (row.error) failCount += 1;
          results.push(row);
          completed += 1;
          if (onUpdate) {
            var partial = results.slice().sort(function (a, b) { return b.tasks.length - a.tasks.length; });
            onUpdate(partial, scanInfo, completed, total);
          }
          return row;
        });
      }));

      results.sort(function (a, b) { return b.tasks.length - a.tasks.length; });
      var elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      cache.rows = results;
      cache.loadedAt = Date.now();
      cache.scanInfo = scanInfo + '，耗时 ' + elapsed + 's' + (failCount ? '，' + failCount + ' 个失败' : '');
      return results;
    })();

    try {
      var r = await cache.promise;
      cache.promise = null;
      return r;
    } catch (e) {
      cache.promise = null;
      throw e;
    }
  }

  /* ============================================================
   * UI
   * ============================================================ */

  function injectMenuItem() {
    if (document.getElementById('ovw-rwk-menu')) return;
    var spacer = document.querySelector('.ls-main-menu__spacer');
    if (!spacer || !spacer.parentElement) return;
    var li = document.createElement('li');
    li.id = 'ovw-rwk-menu';
    li.className = 'ls-main-menu__item';
    li.setAttribute('role', 'menuitem');
    li.innerHTML =
      '<a class="ls-main-menu__item-link" href="javascript:void(0)" style="display:flex;align-items:center;gap:8px;padding:8px 12px;cursor:pointer;">' +
      '  <span class="ls-main-menu__item-icon" style="display:inline-flex;">' +
      '    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 2 4 5v6c0 5.55 3.84 10.74 8 12 4.16-1.26 8-6.45 8-12V5l-8-3zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>' +
      '  </span>' +
      '  <span class="ls-main-menu__item-label">我的返修</span>' +
      '</a>';
    li.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); openPanel(); });
    spacer.parentElement.insertBefore(li, spacer);
  }

  var openEl = null;

  function openPanel() {
    if (openEl) return;
    openEl = document.createElement('div');
    openEl.id = 'ovw-rwk-panel';
    openEl.innerHTML =
      '<div class="ovw-rwk-mask"></div>' +
      '<div class="ovw-rwk-drawer">' +
      '  <div class="ovw-rwk-head">' +
      '    <span>我的返修任务</span>' +
      '    <span class="ovw-rwk-info"></span>' +
      '    <button type="button" class="ovw-rwk-refresh" title="刷新">⟳</button>' +
      '    <button type="button" class="ovw-rwk-close" aria-label="关闭">×</button>' +
      '  </div>' +
      '  <div class="ovw-rwk-progress" style="display:none">' +
      '    <div class="ovw-rwk-progress-bar"></div>' +
      '    <div class="ovw-rwk-progress-text"></div>' +
      '  </div>' +
      '  <div class="ovw-rwk-body"><div class="ovw-rwk-loading">加载中…</div></div>' +
      '</div>';
    document.body.appendChild(openEl);
    openEl.querySelector('.ovw-rwk-mask').addEventListener('click', closePanel);
    openEl.querySelector('.ovw-rwk-close').addEventListener('click', closePanel);
    openEl.querySelector('.ovw-rwk-refresh').addEventListener('click', function () { render(true); });
    document.addEventListener('keydown', onEsc);
    render(false);
  }

  function closePanel() {
    if (!openEl) return;
    openEl.remove();
    openEl = null;
    document.removeEventListener('keydown', onEsc);
  }

  function onEsc(e) { if (e.key === 'Escape') closePanel(); }

  function updateInfo(text) {
    if (!openEl) return;
    var el = openEl.querySelector('.ovw-rwk-info');
    if (el) el.textContent = text ? '· ' + text : '';
  }

  function updateProgress(completed, total) {
    if (!openEl) return;
    var wrap = openEl.querySelector('.ovw-rwk-progress');
    var bar = openEl.querySelector('.ovw-rwk-progress-bar');
    var text = openEl.querySelector('.ovw-rwk-progress-text');
    if (!wrap || !bar || !text) return;
    var phase = arguments.length > 2 ? arguments[2] : '';
    if (phase) {
      wrap.style.display = 'block';
      wrap.classList.add('ovw-rwk-progress-indeterminate');
      bar.style.width = '35%';
      text.textContent = phase;
      return;
    }
    wrap.classList.remove('ovw-rwk-progress-indeterminate');
    if (!total || completed >= total) {
      wrap.style.display = 'none';
      return;
    }
    wrap.style.display = 'block';
    var pct = Math.round((completed / total) * 100);
    bar.style.width = pct + '%';
    text.textContent = '扫描项目 ' + completed + ' / ' + total + '（' + pct + '%）';
  }

  async function render(force) {
    if (!openEl) return;
    var body = openEl.querySelector('.ovw-rwk-body');
    if (!body) return;
    body.innerHTML = '<div class="ovw-rwk-loading">加载中…</div>';
    // 项目接口响应前显示明确的加载状态，不伪装成 0 / 1。
    updateProgress(0, null, '正在获取项目列表…');

    try {
      await loadReworkRows(force, function (partial, info, completed, total, phase) {
        if (!openEl) return;
        updateInfo(info);
        if (phase) updateProgress(0, null, phase);
        else if (typeof completed === 'number') updateProgress(completed, total);
        renderRows(body, partial);
      });
    } catch (e) {
      body.innerHTML = '<div class="ovw-rwk-empty ovw-rwk-error">加载失败：' + escapeHtml(e.message || e) + '</div>';
    }
  }

  function renderRows(body, rows) {
    var totalRejected = rows.reduce(function (s, r) { return s + r.tasks.length; }, 0);
    var okProjects = rows.filter(function (r) { return r.tasks.length > 0; });
    var failed = rows.filter(function (r) { return r.error; });

    if (!totalRejected) {
      body.innerHTML = '<div class="ovw-rwk-empty">没有找到属于你的返修任务。</div>' +
        '<div class="ovw-rwk-tip">共扫描 ' + rows.length + ' 个项目' +
        (failed.length ? '，其中 ' + failed.length + ' 个请求失败' : '') + '</div>';
      return;
    }

    var html = '<div class="ovw-rwk-total">共 <b>' + totalRejected + '</b> 个返修任务，分布在 <b>' + okProjects.length + '</b> 个项目</div>';

    okProjects.forEach(function (r) {
      html += '<div class="ovw-rwk-group">';
      html += '  <a class="ovw-rwk-proj" href="javascript:void(0)" data-path="' + escapeHtml(r.project.basePath) + '" title="点击打开项目">' +
              '    <span class="ovw-rwk-proj-name">' + escapeHtml(r.project.title) + '</span>' +
              '    <span class="ovw-rwk-badge">' + r.tasks.length + '</span>' +
              '  </a>';
      html += '  <div class="ovw-rwk-list">';
      r.tasks.forEach(function (t) {
        var tid = t.id || t.task_id || t.taskId;
        var label = taskLabel(t) || ('任务 #' + tid);
        html += '<a class="ovw-rwk-task" href="javascript:void(0)" data-path="' + escapeHtml(r.project.basePath) + '" data-tid="' + escapeHtml(String(tid)) + '" title="' + escapeHtml(label) + '">' +
                '  <span class="ovw-rwk-task-title">' + escapeHtml(label) + '</span>' +
                '  <span class="ovw-rwk-task-go">去返修 ›</span>' +
                '</a>';
      });
      html += '  </div>';
      html += '</div>';
    });

    body.innerHTML = html;

    body.querySelectorAll('.ovw-rwk-proj').forEach(function (el) {
      el.addEventListener('click', function () {
        location.href = new URL(el.getAttribute('data-path'), location.origin).href;
      });
    });
    body.querySelectorAll('.ovw-rwk-task').forEach(function (el) {
      el.addEventListener('click', function () {
        var path = el.getAttribute('data-path');
        var tid = el.getAttribute('data-tid');
        var u = new URL(path, location.origin);
        if (tid) u.searchParams.set('task', tid);
        location.href = u.toString();
      });
    });
  }

  function taskLabel(t) {
    var keys = ['inner_id', 'innerId', 'name', 'title', 'video_name', 'fileName', 'file_name', 'task_name', 'display_name'];
    for (var i = 0; i < keys.length; i++) if (t[keys[i]] != null && String(t[keys[i]]).trim()) return String(t[keys[i]]).trim();
    if (t.data && typeof t.data === 'object') {
      for (var j = 0; j < keys.length; j++) if (t.data[keys[j]] != null && String(t.data[keys[j]]).trim()) return String(t.data[keys[j]]).trim();
      for (var k in t.data) {
        if (/id$/i.test(k)) continue;
        var v = t.data[k];
        if (typeof v === 'string' && v.trim() && v.length < 80 && !/^\d+$/.test(v)) return v.trim();
      }
    }
    return '';
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];
    });
  }

  /* ============================================================
   * 样式
   * ============================================================ */

  function addStyle() {
    if (document.getElementById('ovw-rwk-style')) return;
    var s = document.createElement('style');
    s.id = 'ovw-rwk-style';
    s.textContent = [
      '#ovw-rwk-panel{position:fixed;inset:0;z-index:2147483600;}',
      '.ovw-rwk-mask{position:absolute;inset:0;background:rgba(0,0,0,.35);}',
      '.ovw-rwk-drawer{position:absolute;top:0;right:0;bottom:0;width:440px;max-width:92vw;background:#fff;box-shadow:-8px 0 24px rgba(0,0,0,.15);display:flex;flex-direction:column;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",Arial,sans-serif;color:#262626;}',
      '.ovw-rwk-head{display:flex;align-items:center;gap:8px;padding:14px 16px;border-bottom:1px solid rgba(0,0,0,.06);font-weight:600;font-size:14px;}',
      '.ovw-rwk-head>span:first-child{flex:0 0 auto;}',
      '.ovw-rwk-info{flex:1;font-weight:400;font-size:11px;color:#bfbfbf;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.ovw-rwk-refresh,.ovw-rwk-close{border:0;background:transparent;color:#8c8c8c;cursor:pointer;padding:2px 6px;border-radius:4px;font-size:16px;line-height:1;}',
      '.ovw-rwk-close{font-size:22px;}',
      '.ovw-rwk-refresh:hover,.ovw-rwk-close:hover{background:rgba(0,0,0,.05);color:#262626;}',
      '.ovw-rwk-progress{position:relative;height:22px;background:rgba(0,0,0,.04);overflow:hidden;flex:0 0 auto;}',
      '.ovw-rwk-progress-bar{position:absolute;left:0;top:0;bottom:0;background:linear-gradient(90deg,#1677ff,#4096ff);transition:width .25s ease;width:0;}',
      '.ovw-rwk-progress-indeterminate .ovw-rwk-progress-bar{animation:ovw-rwk-progress-slide 1.15s ease-in-out infinite;}',
      '@keyframes ovw-rwk-progress-slide{0%{transform:translateX(-100%);}100%{transform:translateX(300%);}}',
      '.ovw-rwk-progress-text{position:absolute;left:0;right:0;top:0;bottom:0;display:flex;align-items:center;justify-content:center;color:#fff;font-size:11px;font-weight:600;text-shadow:0 1px 2px rgba(0,0,0,.35);pointer-events:none;}',
      '.ovw-rwk-body{flex:1;overflow-y:auto;padding:10px 12px;}',
      '.ovw-rwk-body::-webkit-scrollbar{width:6px;}',
      '.ovw-rwk-body::-webkit-scrollbar-thumb{background:rgba(0,0,0,.12);border-radius:3px;}',
      '.ovw-rwk-loading,.ovw-rwk-empty{color:#8c8c8c;text-align:center;padding:40px 16px;}',
      '.ovw-rwk-error{color:#cf1322;}',
      '.ovw-rwk-tip{color:#bfbfbf;text-align:center;font-size:12px;margin-top:8px;}',
      '.ovw-rwk-total{color:#595959;font-size:12px;padding:4px 6px 10px;}',
      '.ovw-rwk-group{margin-bottom:14px;}',
      '.ovw-rwk-proj{display:flex;justify-content:space-between;align-items:center;padding:8px 10px;font-weight:600;color:rgba(0,0,0,.88);border-radius:6px;background:linear-gradient(180deg,rgba(250,250,250,.9),rgba(245,246,248,.9));cursor:pointer;text-decoration:none;transition:all .12s ease;}',
      '.ovw-rwk-proj:hover{background:rgba(22,119,255,.08);color:#1677ff;}',
      '.ovw-rwk-proj-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.ovw-rwk-badge{background:#ff4d4f;color:#fff;border-radius:10px;font-size:11px;padding:1px 8px;font-weight:600;flex:0 0 auto;margin-left:8px;}',
      '.ovw-rwk-list{margin-top:4px;}',
      '.ovw-rwk-task{display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:6px;color:inherit;text-decoration:none;font-size:12.5px;transition:background .12s ease;}',
      '.ovw-rwk-task:hover{background:rgba(22,119,255,.08);}',
      '.ovw-rwk-task-title{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#595959;}',
      '.ovw-rwk-task-go{color:#1677ff;font-size:11.5px;opacity:.65;flex:0 0 auto;}',
      '.ovw-rwk-task:hover .ovw-rwk-task-go{opacity:1;}'
    ].join('');
    document.head.appendChild(s);
  }

  /* ============================================================
   * 启动
   * ============================================================ */

  function boot() {
    addStyle();
    injectMenuItem();
    var obs = new MutationObserver(function () { injectMenuItem(); });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();

  window.__REWORK = {
    open: openPanel, close: closePanel,
    refresh: function () { return render(true); },
    data: function () { return cache.rows; },
    info: function () { return cache.scanInfo; },
    me: function () { return cache.me; },
    clearCache: function () { cache.rows = null; cache.loadedAt = 0; projectCache.clear(); return 'cleared'; },
    test: function (task) { return { isMine: isMine(task, cache.me), owners: collectTaskOwners(task) }; },
  };
})();
