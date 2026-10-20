// ==UserScript==
// @name         Insta360 我的工作台（标注员 / 审核员）
// @namespace    https://label.insta360.com/personal-toolbox/
// @version      1.7.0
// @updateURL    https://raw.githubusercontent.com/chengzi-1225/Insta360-chengzi/refs/heads/main/Insta360 我的工作台.user.js
// @downloadURL  https://raw.githubusercontent.com/chengzi-1225/Insta360-chengzi/refs/heads/main/Insta360 我的工作台.user.js
// @description  只看本人：按日期统计标注、审核工作量，汇总个人返修和返工并直达原生处理流程
// @author       chengzi / Codex
// @match        *://label.insta360.com/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // 数据函数同时供本地 Node 行为测试使用，不依赖站点全局变量或用户名缓存。
  function id(value) {
    if (value && typeof value === 'object') value = value.id;
    return value != null && /^\d+$/.test(String(value)) ? String(value) : '';
  }

  function identity(who) {
    if (!who || !id(who.id)) throw new Error('无法确认当前登录账号，请重新登录后刷新');
    return {
      id: id(who.id),
      name: (String(who.first_name || '') + String(who.last_name || '')).trim() || who.username || '当前用户',
      role: typeof who.role === 'string' ? who.role : ((who.role && who.role.name) || ''),
    };
  }

  function selfRows(rows, userId) {
    if (!id(userId)) throw new Error('无法确认当前登录账号');
    return rows.filter(function (row) { return row && id(row.id) === id(userId); });
  }

  function number(value) {
    if (value == null || value === '' || typeof value === 'boolean') return null;
    var result = Number(value);
    return Number.isFinite(result) && result >= 0 ? result : null;
  }

  function summarizeMetric(rows, key) {
    var sum = 0, available = 0;
    for (var i = 0; i < rows.length; i++) {
      var n = number(rows[i].stats && rows[i].stats[key]);
      if (n == null) continue;
      sum += n;
      available++;
    }
    return {value: rows.length && !available ? null : sum, available: available, missing: rows.length - available};
  }

  function sumMetric(rows, key) {
    return summarizeMetric(rows, key).value;
  }

  function accuracySummary(rows) {
    var passed = 0, rejected = 0, available = 0;
    rows.forEach(function (row) {
      var p = number(row.stats && row.stats.review_passed), r = number(row.stats && row.stats.review_rejected_total);
      if (p == null || r == null) return;
      passed += p; rejected += r; available++;
    });
    return {value: passed + rejected > 0 ? passed / (passed + rejected) * 100 : null, available: available, missing: rows.length - available};
  }

  function parseProjectIds(value) {
    var parts = String(value || '').trim().split(/[\s,，;；]+/).filter(Boolean);
    if (parts.some(function (part) { return !id(part); })) throw new Error('项目 ID 只能填写数字，多个 ID 用逗号或空格分隔');
    return Array.from(new Set(parts)).sort();
  }

  function dateString(date) {
    return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
  }

  function validDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
    var date = new Date(value + 'T12:00:00');
    return Number.isFinite(date.getTime()) && dateString(date) === value;
  }

  function presetRange(preset, now) {
    now = now || new Date();
    var from = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
    var to = new Date(from);
    if (preset === 'yesterday') { from.setDate(from.getDate() - 1); to = new Date(from); }
    else if (preset === 'week') from.setDate(from.getDate() - 6);
    else if (preset === 'month') from.setDate(1);
    return [dateString(from), dateString(to)];
  }

  function activeRange(preset, currentRange, now) {
    return preset ? presetRange(preset, now) : currentRange.slice();
  }

  function statsParams(userId, role, workspace, start, end) {
    if (!id(userId)) throw new Error('无法确认当前登录账号');
    if (!validDate(start) || !validDate(end) || start > end) throw new Error('请检查日期：开始日期不能晚于结束日期');
    if (role !== 'annotator' && role !== 'reviewer') throw new Error('未知统计角色');
    var params = {user_id: id(userId), role: role, start_date: start + ' 00:00:00', end_date: end + ' 23:59:59'};
    if (workspace != null && workspace !== 'all') {
      if (!id(workspace)) throw new Error('工作区无效');
      params.workspace_id = id(workspace);
    }
    return params;
  }

  function personalProjects(rows, workspace) {
    var items = [], unknown = 0;
    rows.forEach(function (p) {
      var ws = id(p.workspace);
      if (workspace && workspace !== 'all' && ws !== String(workspace)) throw new Error('项目工作区与筛选范围不一致，请刷新');
      if (!id(p.id)) throw new Error('项目数据缺少 ID');
      var repair = number(p.user_repair_count), rework = number(p.user_rework_count);
      if (repair == null || rework == null) unknown++;
      if (!(repair > 0 || rework > 0)) return;
      items.push({id: id(p.id), workspace: ws || workspace || 'all', name: p.title || ('项目 #' + p.id), repair: repair, rework: rework});
    });
    items.sort(function (a, b) { return ((b.repair || 0) + (b.rework || 0)) - ((a.repair || 0) + (a.rework || 0)); });
    return {items: items, unknown: unknown, scanned: rows.length};
  }

  function projectRegionTotals(body) {
    var totals = Object.create(null);
    var rows = Array.isArray(body) ? body : body && Array.isArray(body.projects_stats) ? body.projects_stats : [];
    rows.forEach(function (row) {
      var projectId = id(row && (row.project_id != null ? row.project_id : row.id));
      if (!projectId) return;
      var stats = row.stats || {};
      // 平台“regions数”的真实字段为 label__region；兼容旧版 total_regions。
      totals[projectId] = number(stats.label__region != null ? stats.label__region : stats.total_regions);
    });
    return totals;
  }

  function sumRegionMetric(rows, totals) {
    if (!totals) return null;
    var sum = 0;
    for (var i = 0; i < rows.length; i++) {
      var n = number(totals[id(rows[i] && rows[i].project_id)]);
      if (n == null) return null;
      sum += n;
    }
    return sum;
  }

  function workUrl(project, mode) {
    if (!id(project.id) || (!id(project.workspace) && project.workspace !== 'all') || !/^(repair|rework)$/.test(mode)) throw new Error('返修/返工入口无效，请刷新');
    return '/annotation/workspaces/' + encodeURIComponent(project.workspace) + '/projects/' + id(project.id) + '/data?labeling=1&' + mode + '=1';
  }

  function flattenPages(pageRows) {
    var result = [];
    Array.from(pageRows.keys()).sort(function (a, b) { return a - b; }).forEach(function (page) {
      result = result.concat(pageRows.get(page) || []);
    });
    return result;
  }

  function pageOrder(totalPages, priorityPage) {
    var order = [1], priority = Number(priorityPage);
    if (Number.isInteger(priority) && priority > 1 && priority <= totalPages) order.push(priority);
    for (var page = 2; page <= totalPages; page++) if (order.indexOf(page) < 0) order.push(page);
    return order;
  }

  // 不依赖请求的 page_size：服务器可能限流到较小页。计数未取完、重复页均不能当成成功。
  // onPage 用于让调用方在每一页返回时先显示部分数据；最终返回仍按页码顺序排列。
  async function loadPages(fetchPage, rowsKey, rowKey, options) {
    options = options || {};
    var requestedConcurrency = Number(options.concurrency);
    var concurrency = Number.isInteger(requestedConcurrency) ? Math.max(1, Math.min(3, requestedConcurrency)) : 1;
    var seen = new Set(), pageRows = new Map(), received = 0, expected = null;
    function rowsFrom(body) {
      if (!body || !Array.isArray(body[rowsKey])) throw new Error('返回数据格式不支持，请联系脚本维护者');
      var count = number(body.count);
      if (count == null || !Number.isInteger(count)) throw new Error('返回数据格式缺少分页总数');
      if (expected == null) expected = count;
      if (expected !== count) throw new Error('查询期间数据数量发生变化，请刷新重试');
      return body[rowsKey];
    }
    function accept(page, rows, totalPages) {
      if (!rows.length && received < expected) throw new Error('读取不完整：未取得所有分页，请刷新重试');
      rows.forEach(function (row) {
        var key = rowKey(row);
        if (!key || seen.has(key)) throw new Error('读取到重复分页或无效记录，请刷新重试');
        seen.add(key);
        received++;
      });
      if (received > expected) throw new Error('分页数量不一致，请刷新重试');
      pageRows.set(page, rows);
      if (typeof options.onPage === 'function') options.onPage(page, rows, {received: received, expected: expected, totalPages: totalPages, receivedPages: pageRows.size});
    }
    var priority = Number(options.priorityPage), firstPage = Number.isInteger(priority) && priority > 1 && priority <= 500 ? priority : 1;
    var firstBody;
    try { firstBody = await fetchPage(firstPage); }
    catch (error) {
      if (firstPage === 1 || !error || (error.status !== 400 && error.status !== 404)) throw error;
      firstPage = 1; firstBody = await fetchPage(1);
    }
    // 旧包已失效、服务端未提供页大小或忽略页码时，从第一页重新建立分页元数据。
    if (firstPage > 1 && (Array.isArray(firstBody && firstBody[rowsKey]) && !firstBody[rowsKey].length || !number(firstBody && firstBody.page_size) || firstBody.page != null && Number(firstBody.page) !== firstPage)) {
      firstPage = 1; firstBody = await fetchPage(1);
    }
    var firstRows = rowsFrom(firstBody);
    if (expected === 0 && firstRows.length === 0) { accept(1, firstRows, 1); return []; }
    var pageSize = number(firstBody.page_size);
    if (!pageSize || !Number.isInteger(pageSize)) pageSize = firstRows.length;
    if (!pageSize || !Number.isInteger(pageSize)) throw new Error('读取不完整：未取得有效分页大小，请刷新重试');
    var totalPages = Math.ceil(expected / pageSize);
    if (totalPages > 500) throw new Error('分页数量过多，未完整读取，请缩小查询范围');
    if (firstPage > totalPages) throw new Error('查询期间分页数量发生变化，请刷新重试');
    accept(firstPage, firstRows, totalPages);
    if (received === expected) return firstRows;
    var order = pageOrder(totalPages, options.priorityPage).filter(function (page) { return page !== firstPage; }), cursor = 0, inFlight = new Map();
    function requestPage(pageNumber) {
      return Promise.resolve(fetchPage(pageNumber)).then(function (body) { return {page: pageNumber, body: body}; });
    }
    function launch() {
      while (cursor < order.length && inFlight.size < concurrency) {
        var page = order[cursor++];
        inFlight.set(page, requestPage(page));
      }
    }
    launch();
    while (inFlight.size) {
      var settled = await Promise.race(Array.from(inFlight.values()));
      inFlight.delete(settled.page);
      var rows = rowsFrom(settled.body);
      accept(settled.page, rows, totalPages);
      launch();
    }
    if (received !== expected) throw new Error('读取不完整：未取得所有分页，请刷新重试');
    return flattenPages(pageRows);
  }

  function routeContext(path) {
    var match = path.replace(/\/+$/, '').match(/^\/(annotation|review)(?:\/workspaces\/(all|\d+))?$/);
    if (match) return {workspace: match[2] || 'all', role: match[1] === 'review' ? 'reviewer' : 'annotator'};
    match = path.match(/^\/workspaces\/(all|\d+)\/projects\/?$/);
    return match ? {workspace: match[1], role: 'annotator'} : null;
  }

  var core = {identity: identity, selfRows: selfRows, sumMetric: sumMetric, summarizeMetric: summarizeMetric, accuracySummary: accuracySummary, parseProjectIds: parseProjectIds, sumRegionMetric: sumRegionMetric, statsParams: statsParams, personalProjects: personalProjects, projectRegionTotals: projectRegionTotals, workUrl: workUrl, pageOrder: pageOrder, loadPages: loadPages, presetRange: presetRange, activeRange: activeRange, routeContext: routeContext};
  if (typeof module === 'object' && module.exports) module.exports = core;
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__INSTA360_PERSONAL_TOOLBOX__) return;
  window.__INSTA360_PERSONAL_TOOLBOX__ = {version: '1.7.0'};

  var METRICS = {
    annotator: [
      ['submit_total', '新标注提交', '条', '新提交的标注，不包含返修和返工'],
      ['update_total', '返修 / 返工更新', '条', '按平台统计的已更新任务数；与新标注分开核对'],
      ['review_passed', '标注审核通过', '条', '选定时间内被审核通过的标注'],
      ['review_rejected_total', '标注被驳回', '次', '选定时间内被审核驳回的事件次数'],
      ['accuracy', '标注准确率', '%', '审核通过 /（审核通过 + 审核驳回）× 100%；跨项目先合计数量，分母为 0 时显示“—”'],
      ['total_time_min', '有效耗时', '分钟', '使用平台统计的有效耗时，已扣除挂机'],
      ['regions', '本人 regions 数', '个', '当前账号在所选日期内的区域数，使用平台个人标注统计'],
      ['project_regions', '项目 regions 总数', '个', '项目全部成员的累计区域总数，不受个人日期筛选影响，仅作参考'],
    ],
    reviewer: [
      ['review_total', '已审核', '次', '通过与驳回的审核动作次数；同一任务重复审核可多次计数'],
      ['review_passed', '审核通过', '次', '审核为通过的动作次数'],
      ['review_rejected', '审核驳回', '次', '审核为驳回的动作次数'],
      ['acceptance_rejected', '验收驳回', '次', '本人审核通过后被验收驳回的次数'],
      ['total_time_min', '有效耗时', '分钟', '使用平台统计的有效耗时，已扣除挂机'],
      ['regions', '本人 regions 数', '个', '当前账号在所选日期内的区域数，使用平台个人审核统计'],
      ['project_regions', '项目 regions 总数', '个', '项目全部成员的累计区域总数，不受个人日期筛选影响，仅作参考'],
    ],
  };

  var state = {
    context: null, role: 'annotator', workspace: 'all', range: presetRange('today'), preset: 'today',
    user: null, stats: null, regions: null, pending: null, statsProgress: null, pendingProgress: null, error: '', statsError: '', regionError: '', pendingError: '',
    busy: false, statsBusy: false, regionBusy: false, pendingBusy: false, opened: false, filter: '', projectIdsText: '', queryScope: null, queryRange: null, queryWorkspace: null, discarded: 0, updated: '', regionUpdated: '', pendingUpdated: '',
    fieldSelection: {annotator: defaultFields('annotator'), reviewer: defaultFields('reviewer')},
  };
  function defaultFields(role) { return new Set(METRICS[role].filter(function (metric) { return metric[0] !== 'project_regions'; }).map(function (metric) { return metric[0]; })); }
  var host, root, controller, runNumber = 0, lastPath = '';
  var countFrames = Object.create(null), countCurrent = Object.create(null);
  var menuItems = new Map();
  var drawerBounds = {left: 0, top: 0};
  var pinnedSidebar = null, sidebarStyle = null, sidebarObserver = null;
  var sidebarSession = false, sidebarOpenedByScript = false, lastSidebarAttempt = 0;
  function roleTitle(role) { return role === 'reviewer' ? '我的审核' : '我的标注'; }

  function nativeSidebar() {
    var menu = document.querySelector('.ls-main-menu');
    return menu ? (menu.closest('.ls-sidebar') || menu) : document.querySelector('.ls-sidebar_floating');
  }

  function shouldPinSidebar() { return !!(state.context && state.opened && window.innerWidth > 640); }

  function syncSidebarPin() {
    if (!shouldPinSidebar()) {
      if (!sidebarSession) return null;
      if (sidebarObserver) sidebarObserver.disconnect();
      if (pinnedSidebar) pinnedSidebar.removeAttribute('data-insta360-personal-sidebar');
      if (sidebarStyle) sidebarStyle.remove();
      var restoreClosed = sidebarOpenedByScript, trigger = document.querySelector('.main-menu-trigger');
      pinnedSidebar = null; sidebarStyle = null; sidebarSession = false; sidebarOpenedByScript = false; lastSidebarAttempt = 0;
      if (restoreClosed && nativeSidebar() && trigger) trigger.click();
      return null;
    }
    var sidebar = nativeSidebar();
    if (!sidebarSession) {
      sidebarSession = true; sidebarOpenedByScript = !sidebar;
      if (!sidebarObserver && typeof MutationObserver === 'function') {
        sidebarObserver = new MutationObserver(function () {
          if (!shouldPinSidebar()) return;
          var current = nativeSidebar();
          if (!current || current !== pinnedSidebar || !menuItems.size) { syncMenu(); syncDrawerLayout(); }
        });
      }
      if (sidebarObserver) sidebarObserver.observe(document.body, {childList: true, subtree: true});
    }
    if (!sidebar && Date.now() - lastSidebarAttempt >= 500) {
      var opener = document.querySelector('.main-menu-trigger');
      if (opener) { lastSidebarAttempt = Date.now(); opener.click(); sidebar = nativeSidebar(); }
    }
    if (!sidebar) return null;
    lastSidebarAttempt = 0;
    if (pinnedSidebar && pinnedSidebar !== sidebar) pinnedSidebar.removeAttribute('data-insta360-personal-sidebar');
    pinnedSidebar = sidebar;
    var bounds = sidebar.getBoundingClientRect();
    if (!(bounds.width > 0)) return sidebar;
    var left = Math.max(0, Math.floor(bounds.left)), top = Math.max(0, Math.min(Math.floor(bounds.top), window.innerHeight - 240));
    var width = Math.min(Math.ceil(bounds.width), window.innerWidth - left - 320);
    sidebar.setAttribute('data-insta360-personal-sidebar', 'pinned');
    if (!sidebarStyle || !sidebarStyle.isConnected) {
      sidebarStyle = document.createElement('style'); sidebarStyle.id = 'insta360-personal-sidebar-style'; document.body.appendChild(sidebarStyle);
    }
    var rules = '[data-insta360-personal-sidebar="pinned"]{position:fixed!important;left:' + left + 'px!important;top:' + top + 'px!important;bottom:0!important;width:' + width + 'px!important;height:auto!important;max-height:none!important;display:flex!important;flex-direction:column!important;visibility:visible!important;opacity:1!important;transform:none!important;transition:none!important;pointer-events:auto!important;z-index:1000004!important;box-shadow:none!important;overflow-y:auto;overscroll-behavior:contain}';
    if (sidebarStyle.textContent !== rules) sidebarStyle.textContent = rules;
    return sidebar;
  }

  function syncDrawerLayout() {
    var pinned = syncSidebarPin();
    if (!host || !state.opened || !state.context) return;
    var width = window.innerWidth, height = window.innerHeight;
    if (width > 640) {
      if (pinned) {
        var pinnedBounds = pinned.getBoundingClientRect();
        if (pinnedBounds.width > 0 && pinnedBounds.right > 0 && pinnedBounds.right <= width - 320) {
          drawerBounds.left = Math.ceil(pinnedBounds.right); drawerBounds.top = Math.max(0, Math.floor(pinnedBounds.top));
        }
      }
      menuItems.forEach(function (item, center) {
        if (pinned) return;
        if (item.role !== state.context.role || !center.isConnected) return;
        var row = center.closest('li');
        var menu = center.closest('aside') || center.closest('.ls-main-menu') || center.closest('nav, [role="navigation"]') || (row && row.parentElement) || center;
        var bounds = menu.getBoundingClientRect();
        if (!(bounds.width > 0 && bounds.right > 0 && bounds.right <= Math.min(480, width - 320))) return;
        drawerBounds.left = Math.ceil(bounds.right);
        drawerBounds.top = Math.max(0, Math.floor(bounds.top));
      });
    }
    // 原生侧栏短暂移除时沿用上次边界；手机上使用完整视口。
    host.style.left = (width <= 640 ? 0 : Math.min(drawerBounds.left, Math.max(0, width - 320))) + 'px';
    host.style.top = (width <= 640 ? 0 : Math.min(drawerBounds.top, Math.max(0, height - 240))) + 'px';
  }

  function createMenuItem(center, role) {
    var row = document.createElement('li'), link = document.createElement('a');
    row.setAttribute('data-insta360-personal-menu', role); row.setAttribute('translate', 'no');
    link.className = 'ls-main-menu__item';
    link.style.paddingInlineStart = '42px'; link.style.fontSize = '13px';
    var icon = document.createElement('span'), label = document.createElement('span');
    icon.className = 'ls-main-menu__item-icon'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = '▦';
    label.className = 'ls-main-menu__item-label'; label.textContent = roleTitle(role);
    link.appendChild(icon); link.appendChild(label); row.appendChild(link);
    link.addEventListener('click', function (event) {
      // 跨中心及 Ctrl/Cmd 点击沿用普通链接导航，不干预站点的路由。
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      if (!state.context || state.context.role !== role) return;
      event.preventDefault(); event.stopPropagation(); state.opened = true; render();
    });
    return {row: row, link: link, role: role};
  }

  function updateMenuState() {
    var hasMenu = false;
    menuItems.forEach(function (item, center) {
      var current = !!(state.context && state.context.role === item.role);
      var active = current && state.opened;
      item.link.setAttribute('href', (current ? location.pathname + location.search : center.getAttribute('href').split('#')[0]) + '#insta360-personal');
      item.link.setAttribute('aria-expanded', String(active));
      item.link.classList.toggle('ls-main-menu__item_active', active);
      if (active) item.link.setAttribute('aria-current', 'page'); else item.link.removeAttribute('aria-current');
      if (current) hasMenu = true;
    });
    if (root) { host.setAttribute('data-menu', String(hasMenu)); syncDrawerLayout(); }
    return hasMenu;
  }

  function syncMenu() {
    menuItems.forEach(function (item, center) {
      if (!center.isConnected || !center.closest('li') || !item.row.isConnected) {
        item.row.remove(); menuItems.delete(center);
      }
    });
    document.querySelectorAll('a.ls-main-menu__item[href]').forEach(function (center) {
      var nativeRow = center.closest('li');
      if (!nativeRow || nativeRow.getAttribute('data-insta360-personal-menu')) return;
      var url;
      try { url = new URL(center.getAttribute('href'), location.origin); } catch (_) { return; }
      if (url.origin !== location.origin || !/^\/(annotation|review)(?:\/workspaces\/(?:all|\d+))?\/?$/.test(url.pathname)) return;
      var role = routeContext(url.pathname).role, item = menuItems.get(center);
      if (!item) { item = createMenuItem(center, role); menuItems.set(center, item); }
      if (nativeRow.nextElementSibling !== item.row) nativeRow.after(item.row);
    });
    // 侧栏在 SPA 重绘时会短暂消失；面板生命周期由路由和用户关闭操作决定。
    updateMenuState();
  }

  function focusEntry() {
    var link;
    menuItems.forEach(function (item) { if (state.context && item.role === state.context.role) link = item.link; });
    if (link) link.focus();
  }
  // 只在当前页面内存中保存，账号/权限改变即清空；日期不影响待处理列表的缓存键。
  var cache = new Map(), cacheAccount = '', pendingPageMemory = new Map();
  function pendingPageKey(accountKey, workspace, scope) {
    var key = accountKey + ':' + (workspace || 'all');
    return scope && (scope.title || scope.ids) ? key + ':' + JSON.stringify([scope.title || '', scope.ids || '']) : key;
  }
  function getPendingPriorityPage(accountKey, workspace, scope) {
    var key = pendingPageKey(accountKey, workspace, scope), value = pendingPageMemory.get(key), stored;
    if (Number.isInteger(value) && value > 1) return value;
    try {
      stored = window.sessionStorage && window.sessionStorage.getItem('insta360-personal:last-pending-page:' + key);
      value = Number(stored);
      if (Number.isInteger(value) && value > 1) { pendingPageMemory.set(key, value); return value; }
    } catch (_) {}
    return null;
  }
  function rememberPendingPage(accountKey, workspace, page, scope) {
    if (!Number.isInteger(page) || page <= 1) return;
    var key = pendingPageKey(accountKey, workspace, scope);
    pendingPageMemory.set(key, page);
    try {
      if (window.sessionStorage) window.sessionStorage.setItem('insta360-personal:last-pending-page:' + key, String(page));
    } catch (_) {}
  }
  function clearCache() {
    cache.forEach(function (entry) { if (entry.controller) entry.controller.abort(); });
    cache.clear(); cacheAccount = '';
  }
  function readCached(key, ttl, force, load) {
    var entry = cache.get(key);
    if (entry && entry.promise) return entry.promise;
    if (entry && !force && Date.now() - entry.at < ttl) return Promise.resolve(entry);
    entry = {controller: new AbortController()};
    cache.delete(key); cache.set(key, entry);
    // 限制内存；只淘汰已经完成的查询，不打断本次并行请求。
    if (cache.size > 20) {
      for (var pair of cache) {
        if (!pair[1].promise && pair[0] !== key) { cache.delete(pair[0]); break; }
      }
    }
    entry.promise = Promise.resolve().then(function () { return load(entry.controller.signal); }).then(function (value) {
      entry.value = value; entry.at = Date.now(); entry.promise = null;
      return entry;
    }, function (error) {
      if (cache.get(key) === entry) cache.delete(key);
      throw error;
    });
    return entry.promise;
  }
  function cancelOtherJobs(keys) {
    cache.forEach(function (entry, key) {
      if (entry.promise && keys.indexOf(key) < 0) { entry.controller.abort(); cache.delete(key); }
    });
  }
  function $(selector) { return root.querySelector(selector); }
  var renderedMarkup = new WeakMap();
  function setMarkup(selector, html) {
    var node = $(selector);
    if (renderedMarkup.get(node) === html) return false;
    var wrap = node.querySelector && node.querySelector('.table-wrap');
    var scrollTop = wrap ? wrap.scrollTop : 0, scrollLeft = wrap ? wrap.scrollLeft : 0;
    node.innerHTML = html; renderedMarkup.set(node, html);
    wrap = node.querySelector && node.querySelector('.table-wrap');
    if (wrap) { wrap.scrollTop = scrollTop; wrap.scrollLeft = scrollLeft; }
    return true;
  }
  function escape(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) { return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function display(value, key) { return value == null ? '—' : (key === 'accuracy' ? value.toFixed(2) : key === 'total_time_min' ? value.toFixed(1) : value.toLocaleString('zh-CN')); }
  function metricMatches(metric) {
    return state.fieldSelection[state.role].has(metric[0]);
  }
  function renderFieldOptions() {
    var metrics = METRICS[state.role], selected = state.fieldSelection[state.role];
    setMarkup('#field-options', metrics.map(function (metric) {
      return '<label class="field-option" title="' + escape(metric[3]) + '"><input type="checkbox" data-field="' + escape(metric[0]) + '"><span>' + escape(metric[1]) + '</span></label>';
    }).join(''));
    root.querySelectorAll('#field-options input[data-field]').forEach(function (input) { input.checked = selected.has(input.dataset.field); });
    $('#field-count').textContent = '已选 ' + selected.size + ' / ' + metrics.length + ' 项';
  }
  function selectFields(all) {
    state.fieldSelection[state.role] = new Set(all ? METRICS[state.role].map(function (metric) { return metric[0]; }) : []);
    renderFieldOptions(); renderStats();
  }
  function sumRegions(rows) {
    return sumRegionMetric(rows, state.regions);
  }
  function progressText(progress) {
    if (progress && progress.priority) return ' · 已优先读取上次待处理项目，继续查询中';
    if (!progress || progress.receivedPages >= progress.totalPages) return '';
    return ' · 已读取 ' + progress.receivedPages + '/' + progress.totalPages + ' 个项目包，继续查询中';
  }
  function metricAnimationText(value, key) {
    var shown = key === 'accuracy' ? Number(value.toFixed(2)) : key === 'total_time_min' ? Number(value.toFixed(1)) : Math.round(value);
    return display(shown, key);
  }
  function animateCounts() {
    if (!window || typeof window.requestAnimationFrame !== 'function' || !root || typeof root.querySelectorAll !== 'function') return;
    Object.keys(countFrames).forEach(function (key) {
      if (typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(countFrames[key]);
      delete countFrames[key];
    });
    root.querySelectorAll('.metric-value[data-count-target]').forEach(function (node) {
      var key = node.getAttribute('data-count-key'), target = Number(node.getAttribute('data-count-target')), strong = node.querySelector('strong');
      if (!key || !Number.isFinite(target) || !strong) return;
      var start = Number.isFinite(countCurrent[key]) ? countCurrent[key] : 0, began = null;
      strong.textContent = metricAnimationText(start, key.split(':').pop());
      function step(now) {
        if (began == null) began = now;
        var ratio = Math.min(1, (now - began) / 420), eased = 1 - Math.pow(1 - ratio, 3), value = start + (target - start) * eased;
        countCurrent[key] = value; strong.textContent = metricAnimationText(value, key.split(':').pop());
        if (ratio < 1) countFrames[key] = window.requestAnimationFrame(step);
        else { countCurrent[key] = target; strong.textContent = metricAnimationText(target, key.split(':').pop()); delete countFrames[key]; }
      }
      countFrames[key] = window.requestAnimationFrame(step);
    });
  }
  function resetCountAnimations() {
    Object.keys(countFrames).forEach(function (key) {
      if (typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(countFrames[key]);
      delete countFrames[key];
    });
    countCurrent = Object.create(null);
  }
  function abort() { runNumber++; if (controller) controller.abort(); state.busy = false; state.statsBusy = false; state.regionBusy = false; state.pendingBusy = false; }
  function clearResults() { resetCountAnimations(); state.user = null; state.stats = null; state.regions = null; state.pending = null; state.queryScope = null; state.queryRange = null; state.queryWorkspace = null; state.statsProgress = null; state.pendingProgress = null; state.updated = ''; state.regionUpdated = ''; state.pendingUpdated = ''; state.discarded = 0; state.error = ''; state.statsError = ''; state.regionError = ''; state.pendingError = ''; }

  async function request(path, params, signal) {
    var url = new URL(path, location.origin);
    Object.keys(params || {}).forEach(function (key) { if (params[key] != null) url.searchParams.set(key, params[key]); });
    var timeout = new AbortController(), timedOut = false;
    var onAbort = function () { timeout.abort(); };
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    signal.addEventListener('abort', onAbort, {once: true});
    var timer = setTimeout(function () { timedOut = true; timeout.abort(); }, 30000);
    try {
      var response = await fetch(url.href, {method: 'GET', credentials: 'include', headers: {Accept: 'application/json'}, signal: timeout.signal, cache: 'no-store'});
      if (response.status === 401) throw new Error('登录已失效，请重新登录后刷新');
      if (response.status === 403) throw new Error('当前账号没有查看此项的权限');
      if (!response.ok) { var httpError = new Error(response.status === 429 ? '查询过于频繁，请稍后刷新' : '查询失败（HTTP ' + response.status + '），请刷新重试'); httpError.status = response.status; throw httpError; }
      if (!(response.headers.get('content-type') || '').includes('json')) throw new Error('未取得统计数据，请确认仍处于登录状态');
      var data = await response.json();
      if (data && data.error) throw new Error('平台未能完成查询，请刷新重试');
      return data;
    } catch (error) {
      if (timedOut) throw new Error('查询超时，请缩小范围或稍后刷新');
      throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }

  async function confirmAccount(user, signal) {
    try {
      var confirmed = identity(await request('/api/current-user/whoami', {}, signal));
      if (confirmed.id !== user.id || confirmed.role !== user.role) throw new Error('登录账号已变化，请点击“查询 / 刷新”重新读取');
    } catch (error) { error.identityFailure = true; throw error; }
  }

  function updateTime(at) { return new Date(at).toLocaleTimeString('zh-CN', {hour12: false}); }

  async function ensureProjectRegions(force, run) {
    if (!state.fieldSelection[state.role].has('project_regions')) {
      cache.forEach(function (entry, key) {
        if (entry.promise && JSON.parse(key)[0] === 'regions') { entry.controller.abort(); cache.delete(key); }
      });
      var wasBusy = state.regionBusy;
      state.regionBusy = false; state.busy = state.statsBusy || state.pendingBusy; if (wasBusy) render(); return;
    }
    if (run !== runNumber || !state.opened || state.statsBusy || state.statsError || !state.user || !state.stats || !state.stats.length) return;
    var user = state.user, workspace = state.queryWorkspace;
    var projectIds = Array.from(new Set(state.stats.map(function (row) { return id(row.project_id); }).filter(Boolean))).sort();
    if (!projectIds.length) return;
    var key = JSON.stringify(['regions', user.id + ':' + user.role, workspace, projectIds]);
    state.regionBusy = true; state.busy = true; state.regionError = ''; render();
    try {
      var result = await readCached(key, 60000, force === true, async function (jobSignal) {
        var params = {project_id: projectIds.join(',')};
        if (workspace !== 'all') params.workspace_id = workspace;
        var rows = await loadPages(function (page) {
          return request('/api/statistics/project-overview', Object.assign({}, params, {page: page, page_size: 100}), jobSignal);
        }, 'projects_stats', function (row) { return id(row && (row.project_id != null ? row.project_id : row.id)); }, {concurrency: 3});
        await confirmAccount(user, jobSignal);
        return projectRegionTotals(rows);
      });
      if (run !== runNumber) return;
      state.regions = result.value; state.regionUpdated = updateTime(result.at);
    } catch (error) {
      if (run !== runNumber || error.name === 'AbortError') return;
      if (error.identityFailure) { abort(); clearCache(); clearResults(); state.error = error.message; render(); return; }
      state.regionError = error.message || '项目参考读取失败';
    } finally {
      if (run === runNumber) { state.regionBusy = false; state.busy = state.statsBusy || state.pendingBusy; render(); }
    }
  }

  async function readPendingProjects(user, workspace, params, signal, report, previous) {
    var pages = new Map(), priorityRows = [], progress = null, finished = false, usefulPage = null;
    var accountKey = user.id + ':' + user.role, priorityPage = getPendingPriorityPage(accountKey, workspace, params);
    var priorityIds = previous && previous.items ? previous.items.slice(0, 20).map(function (p) { return id(p.id); }).filter(Boolean) : [];
    if (previous && previous.scanned <= priorityIds.length) priorityIds = [];
    var priorityController = new AbortController();
    var cancelPriority = function () { priorityController.abort(); };
    signal.addEventListener('abort', cancelPriority, {once: true});
    if (signal.aborted) cancelPriority();
    function publishProgress() {
      if (finished || signal.aborted) return;
      var merged = new Map();
      priorityRows.forEach(function (row) { merged.set(id(row.id), row); });
      flattenPages(pages).forEach(function (row) { merged.set(id(row.id), row); });
      report({value: personalProjects(Array.from(merged.values()), workspace), meta: progress || {priority: true}});
    }
    // 仅使用上一次同账号、同范围的项目 ID；显示的是本次接口返回的计数。
    if (priorityIds.length) {
      loadPages(function (page) {
        return request('/api/projects', Object.assign({}, params, {ids: priorityIds.join(','), page: page}), priorityController.signal);
      }, 'results', function (row) { return id(row.id); }).then(function (rows) {
        priorityRows = rows; publishProgress();
      }).catch(function () { /* 优先读取失败时由完整扫描核对，不能中断完整查询。 */ });
    }
    try {
      var rows = await loadPages(function (page) {
        return request('/api/projects', Object.assign({}, params, {page: page}), signal);
      }, 'results', function (row) { return id(row.id); }, {
        concurrency: 3, priorityPage: priorityPage,
        onPage: function (page, rows, meta) {
          pages.set(page, rows); progress = meta;
          if (personalProjects(rows, workspace).items.length) usefulPage = page;
          publishProgress();
        },
      });
      if (usefulPage != null) rememberPendingPage(accountKey, workspace, usefulPage, params);
      return personalProjects(rows, workspace);
    } finally {
      finished = true; cancelPriority(); signal.removeEventListener('abort', cancelPriority);
    }
  }

  async function refresh(force) {
    abort(); clearResults();
    if (force === true) cancelOtherJobs([]);
    if (!state.context || !state.opened) { if (root) render(); return; }
    state.role = state.context.role;
    state.range = activeRange(state.preset, state.range);
    var run = runNumber, role = state.role, workspace = state.workspace, range = state.range.slice(), readRegions = state.fieldSelection[state.role].has('project_regions');
    state.queryRange = range.slice(); state.queryWorkspace = workspace;
    controller = new AbortController();
    var signal = controller.signal;
    state.busy = true; state.statsBusy = true; state.regionBusy = false; state.pendingBusy = role === 'annotator'; render();
    try {
      var user = identity(await request('/api/current-user/whoami', {}, signal));
      if (run !== runNumber) return;
      var accountKey = user.id + ':' + user.role;
      if (cacheAccount !== accountKey) { clearCache(); cacheAccount = accountKey; }
      state.user = user;
      if (user.role === 'annotator' && role === 'reviewer') throw new Error('当前账号无法查看审核统计，请返回标注中心');
      var params = statsParams(user.id, role, workspace, range[0], range[1]);
      var scope = {title: state.filter.trim(), ids: parseProjectIds(state.projectIdsText)};
      state.queryScope = scope;
      render();
      var projectParams = {include: 'id,title,workspace,user_repair_count,user_rework_count', page_size: 100};
      if (workspace !== 'all') projectParams.workspaces = workspace;
      var statsKey = JSON.stringify(['stats', accountKey, role, workspace, range, scope]);
      var pendingKey = JSON.stringify(['pending', accountKey, workspace, scope]);
      var scopeKey = JSON.stringify(['scope', accountKey, workspace, scope]);
      cancelOtherJobs(role === 'annotator' ? [statsKey, pendingKey, scopeKey] : [statsKey, scopeKey]);
      if (scope.title) projectParams.title = scope.title;
      if (scope.ids.length) projectParams.ids = scope.ids.join(',');
      var previousPending = cache.get(pendingKey), pendingJob, pendingParams = Object.assign({}, projectParams);
      if (role === 'annotator') {
        pendingJob = publish('pending', pendingKey, 60000, function (jobSignal, report) {
          return readPendingProjects(user, workspace, pendingParams, jobSignal, report, previousPending && previousPending.value);
        }, true, function (progress) {
          state.pending = progress.value; state.pendingProgress = progress.meta; render();
        });
      }
      var selectedIds = scope.ids;
      if (scope.title) {
        var scopeResult = await readCached(scopeKey, 30000, force === true, async function (jobSignal) {
          var lookup = {title: scope.title, include: 'id,title,workspace', page_size: 100};
          if (workspace !== 'all') lookup.workspaces = workspace;
          if (scope.ids.length) lookup.ids = scope.ids.join(',');
          var found = await loadPages(function (page) { return request('/api/projects', Object.assign({}, lookup, {page: page}), jobSignal); }, 'results', function (row) { return id(row.id); }, {concurrency: 3});
          await confirmAccount(user, jobSignal);
          return found.filter(function (row) { return String(row.title || '').toLocaleLowerCase().includes(scope.title.toLocaleLowerCase()) && (!scope.ids.length || scope.ids.indexOf(id(row.id)) >= 0); }).map(function (row) { return id(row.id); }).sort();
        });
        if (run !== runNumber) return;
        selectedIds = scopeResult.value;
        if (!selectedIds.length) {
          state.stats = []; state.updated = updateTime(scopeResult.at);
          if (pendingJob) await pendingJob;
          return;
        }
        projectParams.title = scope.title;
      }
      if (selectedIds.length) { params.project_id = selectedIds.join(','); projectParams.ids = selectedIds.join(','); }
      async function publish(kind, key, ttl, load, confirmIdentity, onProgress) {
        try {
          var result = await readCached(key, ttl, force === true, async function (jobSignal) {
            var value = await load(jobSignal, function (progress) {
              if (run === runNumber && typeof onProgress === 'function') onProgress(progress);
            });
            // 每部分独立核对账号并发布，不让慢的项目列表阻塞产量。
            if (confirmIdentity !== false) await confirmAccount(user, jobSignal);
            return value;
          });
          if (run !== runNumber) return;
          // 新结果在写入缓存前已核对身份；缓存命中则使用本轮刚确认的身份。
          if (kind === 'stats') {
            state.stats = selfRows(result.value, user.id);
            state.discarded = result.value.length - state.stats.length;
            state.statsProgress = null;
            state.updated = updateTime(result.at);
          } else if (kind === 'pending') { state.pending = result.value; state.pendingProgress = null; state.pendingUpdated = updateTime(result.at); }
          else { state.regions = result.value; state.regionUpdated = updateTime(result.at); }
        } catch (error) {
          if (run !== runNumber || error.name === 'AbortError') return;
          if (error.identityFailure) {
            abort(); clearCache(); clearResults(); state.error = error.message; render(); return;
          }
          state[kind + 'Error'] = error.message || '读取失败，请刷新';
        } finally {
          if (run === runNumber) { state[kind + 'Busy'] = false; state.busy = state.statsBusy || state.regionBusy || state.pendingBusy; render(); }
        }
      }
      var statsPages = new Map();
      var statsJob = publish('stats', statsKey, 30000, function (jobSignal, report) {
          return loadPages(async function (page) {
            var response = await request('/api/statistics/overview', Object.assign({}, params, {page: page, page_size: 100}), jobSignal);
            if (response.role && response.role !== role) throw new Error('统计角色返回不一致，请刷新');
            return response;
          }, 'users_stats', function (row) { return id(row.id) && id(row.project_id) ? id(row.id) + ':' + id(row.project_id) : ''; }, {
            concurrency: 3,
            onPage: function (page, rows, meta) {
              statsPages.set(page, rows);
              report({rows: flattenPages(statsPages), meta: meta});
            },
          });
        }, true, function (progress) {
          state.stats = selfRows(progress.rows, user.id);
          state.discarded = progress.rows.length - state.stats.length;
          state.statsProgress = progress.meta;
          render();
        });
      var jobs = [statsJob.then(function () { if (run === runNumber && readRegions) return ensureProjectRegions(force, run); })];
      if (pendingJob) jobs.push(pendingJob);
      await Promise.all(jobs);
    } catch (error) {
      if (run !== runNumber || (error && error.name === 'AbortError')) return;
      clearCache(); clearResults(); state.error = error.message || '查询失败，请刷新重试';
    } finally {
      if (run === runNumber) { state.statsBusy = false; state.pendingBusy = false; state.busy = state.regionBusy; render(); }
    }
  }

  function matches(name) { return String(name || '').toLocaleLowerCase().includes(state.filter.trim().toLocaleLowerCase()); }

  function renderStats() {
    var metrics = METRICS[state.role].filter(metricMatches), rows = state.stats && state.stats.filter(function (r) { return matches(r.project_title); });
    var hasMissing = false;
    function card(m) {
      var summary = rows && m[0] !== 'project_regions' ? (m[0] === 'accuracy' ? accuracySummary(rows) : summarizeMetric(rows, m[0] === 'regions' ? 'label__region' : m[0])) : null;
      var n = summary ? summary.value : rows ? sumRegions(rows) : null;
      var coverage = '';
      if (summary && summary.missing) {
        hasMissing = true;
        coverage = '<small class="metric-coverage">' + (m[0] === 'accuracy' ? '通过/驳回齐全 · ' : summary.available ? '已知合计 · ' : '') + summary.available + '/' + rows.length + ' 项目有值</small>';
      }
      var target = n == null ? '' : ' data-count-target="' + escape(n) + '"';
      return '<div class="metric" title="' + escape(m[3]) + '"><span>' + m[1] + '</span><div class="metric-value" data-count-key="' + state.role + ':' + m[0] + '"' + target + '><strong>' + display(n, m[0]) + '</strong><small>' + m[2] + '</small></div>' + coverage + '</div>';
    }
    var personalMetrics = metrics.filter(function (m) { return m[0] !== 'project_regions'; });
    var projectMetrics = metrics.filter(function (m) { return m[0] === 'project_regions'; });
    var cardsChanged = setMarkup('#metrics', personalMetrics.map(card).join('') || '<p class="empty">请勾选要显示的本人统计字段</p>');
    $('#project-reference').hidden = !projectMetrics.length;
    var projectChanged = setMarkup('#project-metrics', projectMetrics.map(card).join(''));
    if (cardsChanged || projectChanged) animateCounts();
    var head = '<thead><tr><th>项目名称</th>' + metrics.map(function (m) { return '<th title="' + escape(m[3]) + '">' + m[1] + '</th>'; }).join('') + '</tr></thead>';
    if (state.statsError) setMarkup('#stats-data', '<p class="error" role="alert">' + escape(state.statsError) + '</p>');
    else if (!rows) setMarkup('#stats-data', '<p class="empty">' + (state.statsBusy ? '正在读取本人工作量…' : '点击“查询 / 刷新”读取数据') + '</p>');
    else if (!rows.length) setMarkup('#stats-data', '<p class="empty">' + (state.filter ? '没有匹配项目名称的本人记录' : state.statsBusy ? '已读取部分项目包，正在继续查询…' : '这个日期范围内，本人暂无' + (state.role === 'annotator' ? '标注' : '审核') + '记录') + '</p>');
    else setMarkup('#stats-data', '<div class="table-wrap"><table>' + head + '<tbody>' + rows.map(function (row) {
      return '<tr><td><span class="project-name">' + escape(row.project_title || ('项目 #' + row.project_id)) + '</span><small class="project-id">#' + escape(row.project_id) + '</small></td>' + metrics.map(function (m) {
        var value = m[0] === 'accuracy' ? accuracySummary([row]).value : m[0] === 'project_regions' ? state.regions && state.regions[id(row.project_id)] : row.stats && row.stats[m[0] === 'regions' ? 'label__region' : m[0]];
        var numeric = number(value);
        return '<td>' + display(numeric, m[0]) + (m[0] === 'accuracy' && numeric != null ? '%' : '') + '</td>';
      }).join('') + '</tr>';
    }).join('') + '</tbody></table></div>');
    $('#stats-note').textContent = state.role === 'annotator'
      ? '新标注提交与返修 / 返工更新分别统计。通过、驳回按平台统计口径；缺失数据用“—”表示。'
      : '审核数量按通过 / 驳回的动作次数统计。同一条数据重复审核可能计多次，与平台“数据统计”一致。';
    if (state.discarded) $('#stats-note').textContent += ' 已排除非本人记录。';
    $('#stats-note').textContent += ' 本人 regions 数按当前账号及所选日期统计，与任务条数分别计数。';
    if (hasMissing) $('#stats-note').textContent += ' 存在缺失字段时，卡片仅合计已知数值，并标注有值项目数；全部缺失仍显示“—”，不按 0 计算。';
    if (state.role === 'annotator') $('#stats-note').textContent += ' 准确率 = 审核通过 /（审核通过 + 审核驳回）× 100%；先合计再计算，只纳入通过、驳回均有值的项目，分母为 0 时显示“—”。';
    if (projectMetrics.length && state.regionError) $('#stats-note').textContent += ' 项目参考区域总数读取失败：' + state.regionError;
    else if (projectMetrics.length && !state.regions && !state.regionBusy) $('#stats-note').textContent += ' 项目 regions 总数需勾选后点击“查询 / 刷新”读取。';
    $('#range-caption').textContent = state.queryRange ? state.queryRange[0] + ' 至 ' + state.queryRange[1] + ' · 全天 · ' + (state.queryWorkspace === 'all' ? '全部可访问项目' : '工作区 #' + state.queryWorkspace) + (rows ? ' · ' + rows.length + ' 个项目' : '') + progressText(state.statsProgress) : '尚未查询，请点击“查询 / 刷新”';
    if (state.queryScope && (state.queryScope.title || state.queryScope.ids.length)) $('#range-caption').textContent += ' · 服务端项目筛选：' + [state.queryScope.title, state.queryScope.ids.length ? 'ID ' + state.queryScope.ids.join(', ') : ''].filter(Boolean).join('；');
  }

  function renderPending() {
    $('#pending-section').hidden = state.role !== 'annotator';
    if (state.role !== 'annotator') {
      setMarkup('#pending-data', ''); $('#pending-total').textContent = ''; $('#pending-updated').textContent = ''; return;
    }
    $('#pending-updated').textContent = state.pendingUpdated ? '读取于 ' + state.pendingUpdated + ' · 仅点击“查询 / 刷新”时更新' : '';
    if (state.pendingError) { setMarkup('#pending-data', '<p class="error" role="alert">' + escape(state.pendingError) + '</p>'); $('#pending-total').textContent = ''; return; }
    if (!state.pending) { setMarkup('#pending-data', '<p class="empty">' + (state.pendingBusy ? '正在读取本人待处理项目…' : '点击“查询 / 刷新”读取待处理数据') + '</p>'); $('#pending-total').textContent = ''; return; }
    var items = state.pending.items.filter(function (p) { return matches(p.name); });
    var repair = 0, rework = 0;
    items.forEach(function (p) { repair += p.repair || 0; rework += p.rework || 0; });
    $('#pending-total').textContent = items.length + ' 个项目 · 返修 ' + repair + ' · 返工 ' + rework + (state.pending.unknown ? '（部分计数未取得）' : '') + progressText(state.pendingProgress);
    var warning = state.pending.unknown ? '<p class="notice">有 ' + state.pending.unknown + ' 个项目未返回完整个人计数，当前合计仅包含已取得的数据。请刷新或查看原项目卡片。</p>' : '';
    if (!items.length) {
      setMarkup('#pending-data', warning + '<p class="empty">' + (state.filter ? '没有匹配的个人待处理项目' : state.pendingBusy ? '已读取部分项目包，正在继续查询…' : state.pending.unknown ? '已取得个人计数的项目中暂无待处理数据' : '当前范围内，本人暂无待返修或待返工数据') + '</p>');
      return;
    }
    setMarkup('#pending-data', warning + '<div class="pending-list">' + items.map(function (p) {
      return '<article class="pending-row"><div class="pending-project"><strong>' + escape(p.name) + '</strong><small>#' + p.id + '</small></div>' + ['repair', 'rework'].map(function (mode) {
        var n = p[mode], label = mode === 'repair' ? '返修' : '返工';
        return '<div class="lane ' + mode + '"><span>待' + label + ' <b>' + display(n) + '</b></span><button type="button" data-work="' + mode + '" data-project="' + p.id + '" ' + (!(n > 0) ? 'disabled' : '') + '>前往' + label + ' <span aria-hidden="true">↗</span></button></div>';
      }).join('') + '</article>';
    }).join('') + '</div>');
  }

  function render() {
    if (!root) return;
    $('#panel').hidden = !state.opened;
    updateMenuState();
    $('#work-title').textContent = roleTitle(state.role);
    $('#panel').setAttribute('aria-label', roleTitle(state.role));
    $('#center-label').textContent = state.role === 'reviewer' ? '审核中心 · 本人审核数据' : '标注中心 · 本人标注数据';
    $('#stats-title').textContent = state.role === 'reviewer' ? '我的审核产量' : '我的标注产量';
    $('#account').textContent = state.user ? '查询账号：' + state.user.name + ' · ID ' + state.user.id : state.busy ? '正在确认当前账号…' : '仅显示当前登录账号的数据';
    $('#start').value = state.range[0]; $('#end').value = state.range[1];
    $('#project-ids').value = state.projectIdsText;
    renderFieldOptions();
    $('#query').textContent = state.busy ? '重新查询' : '查询 / 刷新';
    $('#error').textContent = state.error; $('#error').hidden = !state.error;
    $('#updated').textContent = state.statsBusy ? '正在查询产量…' : state.updated ? '读取于 ' + state.updated + ' · 手动刷新' : '';
    var changed = false;
    if (state.queryRange && state.queryScope) {
      try { changed = JSON.stringify(state.range) !== JSON.stringify(state.queryRange) || state.workspace !== state.queryWorkspace || !state.queryScope || state.filter.trim() !== state.queryScope.title || parseProjectIds(state.projectIdsText).join(',') !== state.queryScope.ids.join(','); }
      catch (_) { changed = true; }
    }
    $('#query-help').textContent = (changed ? '筛选已修改，点击“查询 / 刷新”后读取新范围；当前数据仍属于上次查询。' : '只有点击“查询 / 刷新”才读取数据。') + ' 名称输入可筛选当前结果；勾选项目累计 regions 后也需点击按钮读取。';
    root.querySelectorAll('[data-preset]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.preset === state.preset)); });
    renderStats(); renderPending();
  }

  async function goToWork(projectId, mode, button) {
    if (!state.context || state.context.role !== 'annotator') return;
    var project = state.pending && state.pending.items.find(function (p) { return p.id === projectId; });
    if (!project || !(project[mode] > 0) || !state.user) return;
    var account = state.user.id, run = runNumber;
    button.disabled = true;
    try {
      var actionController = new AbortController();
      var who = identity(await request('/api/current-user/whoami', {}, actionController.signal));
      if (run !== runNumber) return;
      if (who.id !== account) { abort(); clearCache(); clearResults(); state.error = '登录账号已变化，请重新查询后进入返修'; render(); return; }
      var cards = document.querySelectorAll('.ls-project-card');
      for (var i = 0; i < cards.length; i++) {
        var link = cards[i].closest('a[href]') || cards[i].querySelector('a[href]');
        var match = link && (link.getAttribute('href') || '').match(/\/projects\/(\d+)(?:\/|$)/);
        if (!match || match[1] !== project.id) continue;
        var nativeButton = cards[i].querySelector(mode === 'repair' ? '.ls-project-card__annotation-button_repair' : '.ls-project-card__annotation-button_fix');
        if (nativeButton && !nativeButton.disabled) { nativeButton.click(); return; }
      }
      location.assign(workUrl(project, mode));
    } catch (error) { state.error = error.message; render(); }
    finally { if (button.isConnected) button.disabled = false; }
  }

  function mount() {
    host = document.createElement('div'); host.id = 'insta360-personal-toolbox'; host.setAttribute('translate', 'no');
    root = host.attachShadow({mode: 'open'});
    root.innerHTML = '<style>' + CSS + '</style>' +
      '<section id="panel" aria-label="我的工作台"><header><div><div class="eyebrow">INSTA360 · 个人工作台</div><h1 id="work-title"></h1><p id="account"></p></div><button id="close" type="button" aria-label="收起工作台">×</button></header>' +
      '<div class="scroll"><div class="filters"><div class="filter-line"><div id="center-label"></div><label class="scope-label">范围 <select id="scope" aria-label="统计范围"></select></label></div>' +
      '<div class="presets"><button type="button" data-preset="today">今天</button><button type="button" data-preset="yesterday">昨天</button><button type="button" data-preset="week">近 7 天</button><button type="button" data-preset="month">本月</button></div>' +
      '<div class="filter-line dates"><label>开始日期 <input id="start" type="date" aria-label="开始日期"></label><span class="date-separator">至</span><label>结束日期 <input id="end" type="date" aria-label="结束日期"></label><button id="query" class="primary" type="button">查询 / 刷新</button><input id="search" type="search" placeholder="项目名称，点击查询" aria-label="筛选项目名称"></div>' +
      '<div class="filter-line project-filters"><label>项目 ID（选填） <input id="project-ids" type="text" aria-label="筛选项目 ID" placeholder="多个 ID 用逗号或空格分隔"></label></div><p id="query-help" class="query-help"></p>' +
      '<div class="field-picker" role="group" aria-label="显示统计字段"><div class="field-toolbar"><span>显示字段</span><small id="field-count"></small><button id="field-all" type="button">全选</button><button id="field-none" type="button">清空</button></div><div id="field-options" class="field-options"></div></div></div>' +
      '<p id="error" class="error" role="alert" hidden></p><div class="section-title"><h2 id="stats-title"></h2><span id="updated" aria-live="polite"></span></div><p id="range-caption" class="caption"></p><div id="metrics" class="metrics"></div><div id="stats-data" aria-live="polite"></div><p id="stats-note" class="note"></p>' +
      '<section id="project-reference" class="project-reference" aria-label="项目累计参考" hidden><h2>项目参考 · 全部成员累计</h2><p class="note">项目 regions 总数包含全部成员、所有日期的区域，不受上方个人日期筛选影响，不计入本人产量。</p><div id="project-metrics" class="metrics"></div></section>' +
      '<section id="pending-section" class="pending-section" aria-label="我的返修和返工"><div class="section-title"><h2>我的返修 / 返工</h2><span id="pending-total"></span></div><p class="note">当前仍需本人处理的标注数据，包含以前遗留的返修 / 返工，不受上方日期影响。个人计数与标注中心卡片一致。</p><div id="pending-data" aria-live="polite"></div><p id="pending-updated" class="caption"></p></section>' +
      '<footer>个人产量按当前账号统计 · 不提供其他成员切换</footer></div></section>';
    document.body.appendChild(host);
    $('#close').addEventListener('click', function () {
      if (state.statsBusy) { state.stats = null; state.statsProgress = null; state.updated = ''; }
      if (state.pendingBusy) { state.pending = null; state.pendingProgress = null; state.pendingUpdated = ''; }
      if (state.regionBusy) { state.regions = null; state.regionUpdated = ''; }
      state.opened = false; abort(); cancelOtherJobs([]); render(); focusEntry();
    });
    $('#query').addEventListener('click', function () { refresh(true); });
    root.querySelectorAll('[data-preset]').forEach(function (b) { b.addEventListener('click', function () { state.preset = b.dataset.preset; state.range = presetRange(state.preset); render(); }); });
    ['start','end'].forEach(function (key, index) { $('#' + key).addEventListener('change', function () { state.range[index] = this.value; state.preset = ''; render(); }); });
    $('#scope').addEventListener('change', function () { state.workspace = this.value; render(); });
    $('#search').addEventListener('input', function () { state.filter = this.value; render(); });
    $('#project-ids').addEventListener('input', function () { state.projectIdsText = this.value; render(); });
    $('#field-options').addEventListener('change', function (event) {
      var input = event.target, key = input && input.dataset && input.dataset.field;
      if (!METRICS[state.role].some(function (metric) { return metric[0] === key; })) return;
      if (input.checked) state.fieldSelection[state.role].add(key); else state.fieldSelection[state.role].delete(key);
      renderFieldOptions(); renderStats();
    });
    $('#field-all').addEventListener('click', function () { selectFields(true); });
    $('#field-none').addEventListener('click', function () { selectFields(false); });
    root.addEventListener('keydown', function (event) { if (event.key === 'Escape' && state.opened) $('#close').click(); });
    ['pointerdown', 'mousedown', 'touchstart'].forEach(function (type) { root.addEventListener(type, function (event) { event.stopPropagation(); }); });
    root.addEventListener('click', function (event) { event.stopPropagation(); var button = event.target.closest('[data-work]'); if (button) goToWork(button.dataset.project, button.dataset.work, button); });
  }

  var CSS = `
    :host{all:initial;position:fixed;z-index:1000003;top:0;right:0;bottom:0;left:0;display:block;overflow:hidden;pointer-events:none;--ink:#182c46;--muted:#69798e;--line:#e4eaf2;--blue:#1767c7;--soft:#f4f7fb;--red:#b83a48;--amber:#986315;font:13px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;color:var(--ink)}
    :host([hidden]){display:none!important}*{box-sizing:border-box}[hidden]{display:none!important}button,input,select{font:inherit}button{cursor:pointer}button:disabled{cursor:default;opacity:.42}button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--blue);outline-offset:3px}button{border:1px solid var(--line);background:#fff;color:var(--ink);border-radius:6px;padding:6px 12px}button:hover:not(:disabled){background:var(--soft)}
    #panel{width:100%;height:100%;min-width:0;min-height:0;background:#fff;border:0;border-left:1px solid #dae2ed;display:flex;flex-direction:column;overflow:hidden;pointer-events:auto;animation:drawer-enter .22s ease-out both}
    @keyframes drawer-enter{from{transform:translateX(-100%)}to{transform:translateX(0)}}@media(prefers-reduced-motion:reduce){#panel{animation:none}}
    header{display:flex;justify-content:space-between;align-items:flex-start;padding:22px 26px 17px;border-bottom:1px solid var(--line);background:#fafcff}h1,h2,p{margin:0}h1{font-size:24px;line-height:1.35;font-weight:650;letter-spacing:.5px;margin:4px 0}h2{font-size:16px;font-weight:650}.eyebrow{font-size:10px;letter-spacing:1.1px;font-weight:650;color:var(--blue)}#account{color:var(--muted);font-size:12px}#close{border:0;background:transparent;font-size:25px;line-height:1;padding:3px 5px;color:var(--muted)}
    .scroll{overflow:auto;flex:1;min-height:0;padding:20px 26px 0}.filters{padding-bottom:19px;border-bottom:1px solid var(--line)}.filter-line{display:flex;gap:12px;align-items:center;flex-wrap:wrap}#center-label{color:var(--muted);font-size:12px}.scope-label{margin-left:auto;display:flex;gap:8px;align-items:center;color:var(--muted)}select{max-width:245px;border:1px solid var(--line);border-radius:6px;color:var(--ink);padding:7px 8px;background:#fff}
    .presets{display:flex;gap:6px;margin:16px 0 12px}.presets button{padding:3px 12px;font-size:12px}.presets button[aria-pressed=true]{background:#edf4fd;border-color:#bcd5f4;color:var(--blue)}.dates{gap:10px}.dates label{display:flex;flex-direction:column;gap:3px;font-size:10px;color:var(--muted)}input{min-width:0;padding:7px 8px;border:1px solid #d4deea;border-radius:5px;background:#fff;color:var(--ink);font-size:12px}input[type=date]{width:146px}.date-separator{margin-top:18px;color:var(--muted)}#query{margin-top:18px}button.primary{background:var(--blue);color:white;border-color:var(--blue)}button.primary:hover{background:#145aaf}#search{margin-left:auto;margin-top:18px;width:184px}
    .field-picker{margin-top:16px;padding-top:12px;border-top:1px solid var(--line)}.field-toolbar{display:flex;align-items:center;gap:8px;margin-bottom:9px;color:var(--muted);font-size:11px}.field-toolbar>span{font-weight:600;color:var(--ink)}.field-toolbar small{margin-right:auto;font-size:10px}.field-toolbar button{padding:2px 9px;font-size:11px}.field-options{display:flex;flex-wrap:wrap;gap:8px 16px}.field-option{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--muted);cursor:pointer}.field-option input{margin:0;padding:0;width:14px;height:14px;accent-color:var(--blue);cursor:pointer}.field-option:has(input:checked){color:var(--ink)}.project-reference{margin-top:20px;padding:15px;background:#fffcf4;border:1px solid #eee0b9;border-radius:7px}.project-reference h2{font-size:14px;color:#805c16}.project-reference .note{margin:5px 0 10px}.project-reference .metrics{margin-bottom:0}
    .section-title{display:flex;align-items:baseline;gap:10px;justify-content:space-between;margin-top:21px}.section-title>span{font-size:11px;color:var(--muted)}.caption{font-size:11px;color:var(--muted);margin:3px 0 12px}.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin-bottom:15px}.metric{padding:13px 12px;background:var(--soft);border-radius:7px;border-top:2px solid #d9e6f6}.metric:first-child{border-top-color:var(--blue)}.metric>span{font-size:11px;color:var(--muted)}.metric>div{display:flex;gap:5px;align-items:baseline;margin-top:5px}.metric strong{font:600 26px/1.35 "SFMono-Regular",Consolas,monospace;letter-spacing:-1px;color:var(--ink)}.metric small{font-size:10px;color:var(--muted)}
    .table-wrap{max-height:275px;overflow:auto;border:1px solid var(--line);border-radius:7px}table{border-collapse:collapse;width:100%;font-size:12px}th,td{padding:11px 13px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}th{background:#f8fafc;font-size:10px;color:var(--muted);font-weight:500;position:sticky;top:0}td:first-child,th:first-child{text-align:left;min-width:180px}tr:last-child td{border-bottom:0}td:first-child{white-space:normal}.project-name{max-width:300px;display:block;overflow-wrap:anywhere}.project-id{color:#8b99aa;font-size:10px}tbody tr:hover{background:#fbfcfe}.note{font-size:11px;color:var(--muted);margin:9px 0 0;line-height:1.8}.empty{padding:25px 12px;text-align:center;color:var(--muted);background:#fafbfd;border:1px dashed var(--line);border-radius:7px;font-size:12px}
    .pending-section{border-top:1px solid var(--line);margin-top:22px;padding-bottom:8px}.pending-section .note{margin-bottom:12px}.pending-list{border:1px solid var(--line);border-radius:8px;overflow:hidden}.pending-row{display:grid;grid-template-columns:minmax(0,1fr) 182px 182px;align-items:center;padding:14px 16px;gap:15px;border-bottom:1px solid var(--line)}.pending-row:last-child{border-bottom:0}.pending-project strong{font-size:13px;font-weight:600;overflow-wrap:anywhere;display:block}.pending-project small{font-size:10px;color:var(--muted)}.lane{display:flex;gap:8px;align-items:center;justify-content:space-between}.lane>span{font-size:11px;white-space:nowrap}.lane b{font:600 15px Consolas,monospace;margin-left:2px}.lane button{font-size:11px;padding:4px 9px;white-space:nowrap}.repair{color:var(--red)}.repair button{color:var(--red);border-color:#f0cdd2;background:#fff9fa}.rework{color:var(--amber)}.rework button{color:var(--amber);border-color:#eddcc0;background:#fffcf6}
    .error,.notice{padding:11px 13px;border-radius:6px;font-size:12px;line-height:1.8;margin:12px 0}.error{color:#a62d3b;background:#fff1f3;border:1px solid #f3cbd1}.notice{color:#805c16;background:#fff9e9;border:1px solid #eee0b9}footer{border-top:1px solid var(--line);padding:14px 0;margin-top:18px;font-size:10px;color:#8b99aa;text-align:right}
    @media(max-width:760px){header{padding:17px 18px}.scroll{padding:16px 18px 0}.metrics{grid-template-columns:repeat(3,minmax(0,1fr))}.scope-label{margin-left:0}.pending-row{grid-template-columns:minmax(0,1fr);gap:7px}.lane{justify-content:flex-start;gap:16px}.lane>span{min-width:85px}#search{margin-left:0;width:180px}.section-title{flex-wrap:wrap;gap:4px}.metric strong{font-size:23px}}@media(max-width:420px){.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}input[type=date]{width:132px}.dates{gap:6px}#search{width:100%;margin-top:7px}.field-options{gap:8px 12px}}
    .metric .metric-coverage{display:block;margin-top:6px;line-height:1.5;color:#856327}
    .project-filters{margin-top:12px}.project-filters label{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:11px;flex-wrap:wrap}.project-filters input{width:min(340px,100%)}.query-help{margin-top:6px;font-size:10px;line-height:1.6;color:var(--muted)}
  `;

  function syncRoute() {
    if (!document.body) return;
    syncMenu();
    var path = location.pathname;
    if (path === lastPath && host && host.isConnected) return;
    var context = routeContext(path);
    if (path === lastPath && context && host) {
      resetCountAnimations();
      mount(); host.hidden = false;
      configureScope(context);
      $('#search').value = state.filter;
      render();
      return;
    }
    var keepOpened = state.opened && state.context && context && state.context.role === context.role;
    lastPath = path;
    abort(); cancelOtherJobs([]); clearResults();
    state.context = context;
    if (!context) { clearCache(); if (host) host.hidden = true; updateMenuState(); return; }
    if (!host || !host.isConnected) mount();
    host.hidden = false;
    state.role = context.role; state.workspace = context.workspace; state.filter = ''; state.projectIdsText = ''; $('#search').value = ''; $('#project-ids').value = '';
    state.opened = !!keepOpened || location.hash === '#insta360-personal';
    configureScope(context);
    render();
  }
  function configureScope(context) {
    $('#scope').innerHTML = (context.workspace !== 'all' ? '<option value="' + context.workspace + '">当前工作区 #' + context.workspace + '</option>' : '') + '<option value="all">全部可访问项目</option>';
    $('#scope').value = state.workspace;
  }
  window.addEventListener('popstate', syncRoute);
  window.addEventListener('ls:locationchange', syncRoute);
  window.addEventListener('resize', syncDrawerLayout);
  // 兼容 SPA 的 pushState，以及管理版脚本已包裹 history 的情况，不改写站点路由函数。
  setInterval(syncRoute, 700);
  syncRoute();
})();
