// ==UserScript==
// @name         Insta360 我的返修面板
// @namespace    https://label.insta360.com/
// @author       chengzi
// @version      1.2.0
// @description  侧边栏「我的返修」按钮，只显示属于本人的审核驳回任务
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
    taskPath: '/api/dm/tasks',
    whoamiPath: '/api/current-user/whoami',
    pageSize: 500,
    concurrency: 8,
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

  /* ============================================================
   * 工具
   * ============================================================ */

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
    if (!res.ok) throw new Error('HTTP ' + res.status);
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

  async function fetchAllProjects() {
    var body = await getJson(apiUrl(CONFIG.projectPath, { page_size: 200 }));
    return rowsFromResponse(body);
  }

  async function fetchProjectTasks(pid) {
    var body = await getJson(apiUrl(CONFIG.taskPath, { project: pid, page_size: CONFIG.pageSize }));
    return rowsFromResponse(body);
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
    } catch (e) {
      return (el.textContent || '').trim();
    }
  }

  function getSidebarUserName() {
    var el = document.querySelector('.ls-userpic__username');
    if (el) {
      var t = extractCleanText(el);
      if (t) return t;
    }
    var sels = ['.ls-userpic__name', '[class*="userpic"] [class*="name"]', '.ls-user-menu__name', '[class*="user-name"]'];
    for (var i = 0; i < sels.length; i++) {
      var e = document.querySelector(sels[i]);
      if (e) {
        var t2 = extractCleanText(e);
        if (t2 && t2.length < 50) return t2;
      }
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

        // 组合真名优先
        if (fn && ln) {
          me.names.push(fn + ln);
          me.names.push(ln + fn);
        }
        if (fn) me.names.push(fn);
        if (ln) me.names.push(ln);

        // username：纯数字（手机号）就跳过
        if (j.username && !/^\d+$/.test(String(j.username).trim())) {
          me.names.push(String(j.username).trim());
        }
        // 邮箱前缀
        if (j.email && String(j.email).indexOf('@') > 0) {
          var ep = String(j.email).split('@')[0];
          if (!/^\d+$/.test(ep)) me.names.push(ep);
        }
        // 其他别名
        ['name', 'display_name', 'nickname'].forEach(function (k) {
          if (j[k] != null && String(j[k]).trim()) me.names.push(String(j[k]).trim());
        });
      }
    } catch (e) {
      log('whoami 失败：', e.message);
    }

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
    log('fetchMe 结果：', me);
    return me;
  }

  /* ============================================================
   * 收集任务的归属者（支持数组字段）
   * ============================================================ */

  function collectTaskOwners(task) {
    var ids = [];
    var names = [];

    var idKeys = [
      'annotator_id', 'assignee_id', 'user_id', 'completed_by',
      'created_by_id', 'creator_id', 'owner_id', 'assigned_to_id',
      'annotatorId', 'assigneeId', 'userId', 'completedBy',
      'createdById', 'creatorId', 'ownerId', 'updated_by'
    ];
    var nameKeys = [
      'annotator', 'assignee', 'user', 'created_by', 'creator', 'owner', 'assigned_to',
      'annotator_name', 'assignee_name', 'created_by_name', 'creator_name',
      'username', 'user_name', 'operator'
    ];
    var arrayKeys = ['annotators', 'reviewers', 'acceptors', 'annotations', 'reviews', 'acceptances'];

    function pushUserObject(obj) {
      if (!obj) return;
      if (typeof obj === 'object') {
        if (obj.id != null) ids.push(String(obj.id));
        ['username', 'name', 'display_name', 'email', 'first_name', 'last_name', 'nickname'].forEach(function (nk) {
          if (obj[nk] != null && String(obj[nk]).trim()) {
            var sv = String(obj[nk]).trim();
            names.push(sv);
          }
        });
        if (obj.first_name && obj.last_name) {
          names.push(obj.first_name + obj.last_name);
          names.push(obj.last_name + obj.first_name);
        }
      } else if (typeof obj === 'string' || typeof obj === 'number') {
        var sv = String(obj).trim();
        if (/^\d+$/.test(sv)) ids.push(sv);
        else names.push(sv);
      }
    }

    function scanRecord(rec) {
      if (!rec || typeof rec !== 'object') return;
      idKeys.forEach(function (k) {
        var v = rec[k];
        if (v != null) {
          var sv = String(v).trim();
          if (sv) ids.push(sv);
        }
      });
      nameKeys.forEach(function (k) {
        var v = rec[k];
        if (v == null) return;
        if (typeof v === 'object') pushUserObject(v);
        else {
          var sv = String(v).trim();
          if (sv) { if (/^\d+$/.test(sv)) ids.push(sv); else names.push(sv); }
        }
      });
      arrayKeys.forEach(function (k) {
        var arr = rec[k];
        if (!Array.isArray(arr)) return;
        arr.forEach(pushUserObject);
      });
    }

    scanRecord(task);
    if (task.data && typeof task.data === 'object') scanRecord(task.data);
    if (task.meta && typeof task.meta === 'object') scanRecord(task.meta);

    var evLists = [task.events, task.history, task.status_history, task.records];
    evLists.forEach(function (arr) {
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

    var uniqId = {}, uniqName = {};
    ids = ids.filter(function (v) { if (!v || uniqId[v]) return false; uniqId[v] = 1; return true; });
    names = names.filter(function (v) {
      if (!v) return false;
      var k = v.replace(/\s+/g, '').toLowerCase();
      if (uniqName[k]) return false;
      uniqName[k] = 1;
      return true;
    });

    return { ids: ids, names: names };
  }

  /* ============================================================
   * 严格归属判断
   * ============================================================ */

  function isMine(task, me) {
    if (!me || !me.loaded) return true;

    var owners = collectTaskOwners(task);

    if (!owners.ids.length && !owners.names.length) return false;

    if (me.id) {
      for (var i = 0; i < owners.ids.length; i++) {
        if (owners.ids[i] === me.id) return true;
      }
    }

    var myNames = me.names.map(function (n) { return n.replace(/\s+/g, '').toLowerCase(); });
    for (var j = 0; j < owners.names.length; j++) {
      var on = owners.names[j].replace(/\s+/g, '').toLowerCase();
      for (var k = 0; k < myNames.length; k++) {
        var mn = myNames[k];
        if (!mn) continue;
        if (mn === on) return true;
        if (mn.length >= 2 && on.length >= 2) {
          if (on.indexOf(mn) !== -1 || mn.indexOf(on) !== -1) return true;
        }
      }
    }

    return false;
  }

  /* ============================================================
   * 状态判断
   * ============================================================ */

  function isRejected(task) {
    var stateKeys = ['currentStatus', 'current_status', 'workflowState', 'workflow_state', 'taskState', 'task_state', 'state', 'status'];
    for (var i = 0; i < stateKeys.length; i++) {
      var v = task[stateKeys[i]];
      if (v == null) continue;
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
   * 项目来源
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
      out.push(info);
    }
    return out;
  }

  function projectsFromApi(projects) {
    var currentWs = (location.pathname.match(/\/workspaces\/([^/]+)/) || [])[1] || 'all';
    var out = [];
    for (var i = 0; i < projects.length; i++) {
      var p = projects[i];
      if (!p || p.id == null) continue;
      var ws = p.workspace != null ? p.workspace : currentWs;
      out.push({
        workspaceId: String(ws),
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

  async function loadReworkRows(force, onUpdate) {
    if (!force && cache.rows && (Date.now() - cache.loadedAt < CONFIG.cacheTtlMs)) {
      if (onUpdate) onUpdate(cache.rows, cache.scanInfo);
      return cache.rows;
    }
    if (cache.promise && !force) return cache.promise;

    cache.promise = (async function () {
      var t0 = Date.now();
      var mePromise = fetchMe();
      var projects, scanInfo;
      try {
        var list = await fetchAllProjects();
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
        // 挑一个非纯数字的显示名
        var displayName = '';
        for (var i = 0; i < me.names.length; i++) {
          if (!/^\d+$/.test(me.names[i])) { displayName = me.names[i]; break; }
        }
        if (!displayName) displayName = me.names[0] || '';
        var idTxt = me.id ? ('#' + me.id) : '';
        var nameTxt = displayName ? ('「' + displayName + '」') : '';
        scanInfo += '，当前用户 ' + idTxt + nameTxt;
      }

      var candidates = projects.filter(function (p) {
        if (p.rejectedCount == null) return true;
        return p.rejectedCount > 0;
      });

      if (!candidates.length) {
        var empty = [];
        cache.rows = empty;
        cache.loadedAt = Date.now();
        cache.scanInfo = scanInfo + '，无驳回项目';
        if (onUpdate) onUpdate(empty, cache.scanInfo);
        return empty;
      }

      var pool = new Pool(CONFIG.concurrency);
      var results = [];
      var completed = 0;

      await Promise.all(candidates.map(function (p) {
        return pool.run(async function () {
          var row;
          try {
            var tasks = await fetchProjectTasks(p.projectId);
            var rejected = tasks.filter(function (t) {
              return isRejected(t) && isMine(t, me);
            });
            row = { project: p, tasks: rejected, total: tasks.length };
          } catch (e) {
            row = { project: p, tasks: [], error: e.message };
          }
          results.push(row);
          completed += 1;
          if (onUpdate) {
            var partial = results.slice().sort(function (a, b) { return b.tasks.length - a.tasks.length; });
            onUpdate(partial, scanInfo + '，已扫描 ' + completed + '/' + candidates.length);
          }
          return row;
        });
      }));

      results.sort(function (a, b) { return b.tasks.length - a.tasks.length; });
      var elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      cache.rows = results;
      cache.loadedAt = Date.now();
      cache.scanInfo = scanInfo + '，耗时 ' + elapsed + 's';
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
   * 侧边栏菜单
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

  /* ============================================================
   * 抽屉
   * ============================================================ */

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

  async function render(force) {
    if (!openEl) return;
    var body = openEl.querySelector('.ovw-rwk-body');
    if (!body) return;
    body.innerHTML = '<div class="ovw-rwk-loading">加载中…</div>';
    try {
      await loadReworkRows(force, function (partial, info) {
        if (!openEl) return;
        updateInfo(info);
        renderRows(body, partial);
      });
    } catch (e) {
      body.innerHTML = '<div class="ovw-rwk-empty ovw-rwk-error">加载失败：' + escapeHtml(e.message || e) + '</div>';
    }
  }

  function renderRows(body, rows) {
    var totalRejected = rows.reduce(function (s, r) { return s + r.tasks.length; }, 0);
    var okProjects = rows.filter(function (r) { return r.tasks.length > 0; });

    if (!totalRejected) {
      body.innerHTML =
        '<div class="ovw-rwk-empty">没有找到属于你的返修任务。</div>' +
        '<div class="ovw-rwk-tip">共扫描 ' + rows.length + ' 个项目</div>';
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
    for (var i = 0; i < keys.length; i++) {
      if (t[keys[i]] != null && String(t[keys[i]]).trim()) return String(t[keys[i]]).trim();
    }
    if (t.data && typeof t.data === 'object') {
      for (var j = 0; j < keys.length; j++) {
        if (t.data[keys[j]] != null && String(t.data[keys[j]]).trim()) return String(t.data[keys[j]]).trim();
      }
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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }

  window.__REWORK = {
    open: openPanel,
    close: closePanel,
    refresh: function () { return render(true); },
    data: function () { return cache.rows; },
    info: function () { return cache.scanInfo; },
    me: function () { return cache.me; },
    clearCache: function () { cache.rows = null; cache.loadedAt = 0; return 'cleared'; },
    test: function (task) { return { isMine: isMine(task, cache.me), owners: collectTaskOwners(task) }; },
  };
})();
