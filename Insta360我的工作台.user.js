// ==UserScript==
// @name         Insta360 我的工作台（标注员 / 审核员）
// @namespace    https://label.insta360.com/personal-toolbox/
// @version      1.8.2
// @updateURL    https://raw.githubusercontent.com/chengzi-1225/Insta360-chengzi/refs/heads/main/Insta360我的工作台.user.js
// @downloadURL  https://raw.githubusercontent.com/chengzi-1225/Insta360-chengzi/refs/heads/main/Insta360我的工作台.user.js
// @description  个人数据工作台：总览、项目搜索排序、分页合计、CSV 导出与返修返工快捷入口
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
    if (totalPages > (options.maxPages || 500)) throw new Error('分页数量过多，未完整读取，请缩小查询范围');
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

  function rowMetric(row, key, totals) {
    if (key === 'project_title') return String(row.project_title || ('项目 #' + row.project_id));
    if (key === 'accuracy') return accuracySummary([row]).value;
    if (key === 'project_regions') return number(totals && totals[id(row.project_id)]);
    return number(row.stats && row.stats[key === 'regions' ? 'label__region' : key]);
  }

  function browseRows(rows, query, key, direction, totals) {
    var needle = String(query || '').trim().toLocaleLowerCase();
    return rows.filter(function (row) {
      return !needle || (String(row.project_title || '') + ' #' + row.project_id).toLocaleLowerCase().includes(needle);
    }).slice().sort(function (a, b) {
      var x = rowMetric(a, key, totals), y = rowMetric(b, key, totals);
      if (x == null && y == null) return Number(a.project_id) - Number(b.project_id);
      if (x == null) return 1;
      if (y == null) return -1;
      var order = typeof x === 'string' ? x.localeCompare(y, 'zh-CN', {numeric: true}) : x - y;
      return order ? order * (direction === 'asc' ? 1 : -1) : Number(a.project_id) - Number(b.project_id);
    });
  }

  function csvText(rows) {
    return '\ufeff' + rows.map(function (row) {
      return row.map(function (value) {
        var cell = value == null ? '' : String(value);
        if (typeof value === 'string' && /^[\s]*[=+@\-\t\r]/.test(cell)) cell = "'" + cell;
        return '"' + cell.replace(/"/g, '""') + '"';
      }).join(',');
    }).join('\r\n');
  }

  var core = {browseRows: browseRows, rowMetric: rowMetric, csvText: csvText, identity: identity, selfRows: selfRows, sumMetric: sumMetric, summarizeMetric: summarizeMetric, accuracySummary: accuracySummary, parseProjectIds: parseProjectIds, sumRegionMetric: sumRegionMetric, statsParams: statsParams, personalProjects: personalProjects, projectRegionTotals: projectRegionTotals, workUrl: workUrl, pageOrder: pageOrder, loadPages: loadPages, presetRange: presetRange, activeRange: activeRange, routeContext: routeContext};
  if (typeof module === 'object' && module.exports) module.exports = core;
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__INSTA360_PERSONAL_TOOLBOX__) return;
  window.__INSTA360_PERSONAL_TOOLBOX__ = {version: '1.8.1'};

  var SHORT_LABELS = {submit_total:'新提交',update_total:'更新',review_passed:'通过',review_rejected_total:'驳回',accuracy:'准确率',total_time_min:'耗时（分钟）',regions:'本人 regions',project_regions:'项目 regions',review_total:'已审核',review_rejected:'驳回',acceptance_rejected:'验收驳回'};
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
    selectedProjectId: '', choiceSearch: '', quick: '', sortKey: '', sortDirection: 'desc', page: 1, pageSize: 10, pendingMode: 'all',
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
  var choiceController = null, choiceVersion = 0, choiceRows = [], choiceWorkspace = null, choiceBusy = false, choiceError = '';
  var workspaceController = null, workspaceRows = [], workspaceBusy = false;
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
    cancelChoices(); choiceRows = []; choiceWorkspace = null; workspaceRows = [];
    if (workspaceController) workspaceController.abort(); workspaceBusy = false;
    if (root && state.context) configureScope(state.context);
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
      entry.controller.abort();
      throw error;
    });
    return entry.promise;
  }
  function cancelOtherJobs(keys) {
    cache.forEach(function (entry, key) {
      if (entry.promise && keys.indexOf(key) < 0) { entry.controller.abort(); cache.delete(key); }
    });
  }
  function currentScope() {
    var ids = parseProjectIds(state.projectIdsText);
    if (state.selectedProjectId) {
      if (ids.length && ids.indexOf(state.selectedProjectId) < 0) throw new Error('所选项目不在填写的项目 ID 中，请调整筛选条件');
      ids = [state.selectedProjectId];
    }
    return {title: state.filter.trim(), ids: ids, selectedId: state.selectedProjectId};
  }
  function cancelChoices() {
    choiceVersion++; if (choiceController) choiceController.abort(); choiceBusy = false;
  }
  function renderProjectChoices() {
    if (!root) return;
    $('#project-label').textContent = state.filter || '全部项目';
    $('#project-picker summary').title = state.filter || '项目名称';
    var needle = state.choiceSearch.trim().toLocaleLowerCase();
    var rows = choiceWorkspace === state.workspace ? choiceRows : [];
    var options = rows.filter(function (row) { return !needle || (String(row.title || '') + ' #' + row.id).toLocaleLowerCase().includes(needle); });
    setMarkup('#project-options', '<button type="button" role="option" data-project-choice="" aria-selected="' + (!state.filter) + '">全部项目' + (!state.filter ? '<span>✓</span>' : '') + '</button>' +
      options.map(function (row) { return '<button type="button" role="option" data-project-choice="' + id(row.id) + '" aria-selected="' + (id(row.id) === state.selectedProjectId) + '"><span class="choice-name">' + escape(row.title || '项目 #' + row.id) + '</span><small>#' + id(row.id) + '</small>' + (id(row.id) === state.selectedProjectId ? '<span>✓</span>' : '') + '</button>'; }).join('') +
      (needle ? '<button type="button" data-project-keyword>名称包含：' + escape(state.choiceSearch.trim()) + '</button>' : '') +
      (choiceBusy ? '<p class="choice-note" role="status">正在读取项目名称…</p>' : choiceError ? '<p class="choice-note" role="alert">' + escape(choiceError) + ' <button type="button" data-retry-choices>重试</button></p>' : !options.length ? '<p class="choice-note">没有匹配项目</p>' : ''));
  }
  async function loadProjectChoices(force) {
    if (!state.opened || !$('#project-picker').open || choiceBusy) return;
    if (!force && choiceWorkspace === state.workspace) { renderProjectChoices(); return; }
    cancelChoices(); choiceController = new AbortController();
    var version = choiceVersion, signal = choiceController.signal, workspace = state.workspace;
    choiceRows = []; choiceWorkspace = null; choiceBusy = true; choiceError = ''; renderProjectChoices();
    try {
      var user = identity(await request('/api/current-user/whoami', {}, signal));
      if (state.user && (user.id !== state.user.id || user.role !== state.user.role)) { var changed = new Error('登录账号已变化，请重新查询'); changed.identityFailure = true; throw changed; }
      var rows = await loadPages(function (page) {
        var params = {include: 'id,title,workspace', page_size: 100, page: page};
        if (workspace !== 'all') params.workspaces = workspace;
        return request('/api/projects', params, signal);
      }, 'results', function (row) { return id(row.id); }, {concurrency: 2});
      await confirmAccount(user, signal);
      if (version !== choiceVersion || workspace !== state.workspace) return;
      choiceRows = rows.filter(function (row) { return workspace === 'all' || id(row.workspace) === workspace; });
      choiceWorkspace = workspace;
    } catch (error) {
      if (version !== choiceVersion || error.name === 'AbortError') return;
      if (error.identityFailure) { abort(); clearCache(); clearResults(); state.error = error.message; render(); return; }
      choiceError = error.message || '项目名称读取失败';
    } finally {
      if (version === choiceVersion) { choiceBusy = false; renderProjectChoices(); }
    }
  }
  async function loadWorkspaceChoices() {
    if (!state.opened || workspaceBusy || workspaceRows.length) return;
    workspaceController = new AbortController();
    var signal = workspaceController.signal;
    workspaceBusy = true;
    try {
      var user = identity(await request('/api/current-user/whoami', {}, signal));
      if (state.user && (user.id !== state.user.id || user.role !== state.user.role)) { var changed = new Error('登录账号已变化，请重新查询'); changed.identityFailure = true; throw changed; }
      var rows = await loadPages(async function (page) {
        var body = await request('/api/workspaces', {page: page, page_size: 100}, signal);
        return Array.isArray(body) ? {count: body.length, results: body} : body;
      }, 'results', function (row) { return id(row.id); });
      await confirmAccount(user, signal);
      if (!signal.aborted) { workspaceRows = rows; configureScope(state.context); }
    } catch (error) {
      if (error.name === 'AbortError') return;
      if (error.identityFailure) { abort(); clearCache(); clearResults(); state.error = error.message; render(); }
      else $('#scope').title = '工作区名称暂未取得，可继续使用当前范围';
    } finally { if (!signal.aborted) workspaceBusy = false; }
  }
  function resetFilters() {
    cancelChoices(); state.workspace = state.context.workspace; state.filter = ''; state.selectedProjectId = ''; state.projectIdsText = ''; state.choiceSearch = '';
    $('#search').value = ''; $('#project-picker').open = false; configureScope(state.context); render();
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
      if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) { strong.textContent = display(target, key.split(':').pop()); countCurrent[key] = target; return; }
      var start = Number.isFinite(countCurrent[key]) ? countCurrent[key] : 0, began = null;
      if (start === target) { strong.textContent = display(target, key.split(':').pop()); return; }
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
  function clearResults() { state.page = 1; resetCountAnimations(); state.user = null; state.stats = null; state.regions = null; state.pending = null; state.queryScope = null; state.queryRange = null; state.queryWorkspace = null; state.statsProgress = null; state.pendingProgress = null; state.updated = ''; state.regionUpdated = ''; state.pendingUpdated = ''; state.discarded = 0; state.error = ''; state.statsError = ''; state.regionError = ''; state.pendingError = ''; }

  async function request(path, params, signal, options) {
    options = options || {};
    for (var attempt = 0; ; attempt++) {
      try { return await requestOnce(path, params, signal, (options.timeoutMs || 30000) + attempt * 15000); }
      catch (error) {
        if (signal.aborted || error.name === 'AbortError' || attempt >= (options.retries || 0) || !(error.timedOut || error instanceof TypeError || [502, 503, 504].indexOf(error.status) >= 0)) throw error;
        await new Promise(function (resolve, reject) {
          var timer;
          function stop() { clearTimeout(timer); signal.removeEventListener('abort', stop); reject(new DOMException('Aborted', 'AbortError')); }
          if (signal.aborted) { stop(); return; }
          timer = setTimeout(function () { signal.removeEventListener('abort', stop); resolve(); }, 800);
          signal.addEventListener('abort', stop, {once: true});
        });
      }
    }
  }

  async function requestOnce(path, params, signal, timeoutMs) {
    var url = new URL(path, location.origin);
    Object.keys(params || {}).forEach(function (key) { if (params[key] != null) url.searchParams.set(key, params[key]); });
    var timeout = new AbortController(), timedOut = false;
    var onAbort = function () { timeout.abort(); };
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    signal.addEventListener('abort', onAbort, {once: true});
    var timer = setTimeout(function () { timedOut = true; timeout.abort(); }, timeoutMs);
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
      if (timedOut && !signal.aborted) { var timeoutError = new Error('查询超时，请选择工作区或项目后重试'); timeoutError.timedOut = true; throw timeoutError; }
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
        return request('/api/projects', Object.assign({}, params, {ids: priorityIds.join(','), page: page}), priorityController.signal, {retries: 1});
      }, 'results', function (row) { return id(row.id); }).then(function (rows) {
        priorityRows = rows; publishProgress();
      }).catch(function () { /* 优先读取失败时由完整扫描核对，不能中断完整查询。 */ });
    }
    try {
      var rows = await loadPages(function (page) {
        return request('/api/projects', Object.assign({}, params, {page: page}), signal, {retries: 1});
      }, 'results', function (row) { return id(row.id); }, {
        concurrency: priorityIds.length ? 1 : 2, maxPages: 5000, priorityPage: priorityPage,
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

  async function refreshPending(force, run, user, workspace, scope) {
    if (run !== runNumber || state.role !== 'annotator') return;
    state.pendingBusy = true; state.busy = true; state.pendingError = ''; render();
    var key = JSON.stringify(['pending', user.id + ':' + user.role, workspace, scope]);
    var params = {include: 'id,title,workspace,user_repair_count,user_rework_count', page_size: 10};
    if (workspace !== 'all') params.workspaces = workspace;
    if (scope.title) params.title = scope.title;
    if (scope.ids.length) params.ids = scope.ids.join(',');
    var previous = cache.get(key);
    try {
      // 重试也先核对登录身份，避免把旧账号的部分结果留给新账号。
      await confirmAccount(user, controller.signal);
      if (run !== runNumber || !state.opened) return;
      var result = await readCached(key, 60000, force === true, async function (jobSignal) {
        var value = await readPendingProjects(user, workspace, params, jobSignal, function (progress) {
          if (run !== runNumber) return;
          state.pending = progress.value; state.pendingProgress = progress.meta; render();
        }, previous && previous.value);
        await confirmAccount(user, jobSignal);
        return value;
      });
      if (run !== runNumber) return;
      state.pending = result.value; state.pendingProgress = null; state.pendingUpdated = updateTime(result.at);
    } catch (error) {
      if (run !== runNumber || error.name === 'AbortError') return;
      if (error.identityFailure) { abort(); clearCache(); clearResults(); state.error = error.message; render(); return; }
      state.pendingError = error.message || '待处理列表读取失败'; state.pendingUpdated = '';
    } finally {
      if (run === runNumber) { state.pendingBusy = false; state.busy = state.statsBusy || state.regionBusy; render(); }
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
      var scope = currentScope();
      state.queryScope = scope;
      render(); loadWorkspaceChoices();
      var statsKey = JSON.stringify(['stats', accountKey, role, workspace, range, scope]);
      var pendingKey = JSON.stringify(['pending', accountKey, workspace, scope]);
      var scopeKey = JSON.stringify(['scope', accountKey, workspace, scope]);
      cancelOtherJobs(role === 'annotator' ? [statsKey, pendingKey, scopeKey] : [statsKey, scopeKey]);
      var pendingJob = role === 'annotator' ? refreshPending(force, run, user, workspace, scope) : null;
      var selectedIds = scope.ids;
      if (scope.title && !scope.selectedId) {
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
      }
      if (selectedIds.length) params.project_id = selectedIds.join(',');
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
          } else { state.regions = result.value; state.regionUpdated = updateTime(result.at); }
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

  function matches(name) { var applied = state.queryScope ? state.queryScope.title : ''; return String(name || '').toLocaleLowerCase().includes(applied.toLocaleLowerCase()); }

  function visibleRows() {
    if (!state.stats || state.statsError || state.error) return null;
    return browseRows(state.stats.filter(function (r) { return matches(r.project_title); }), state.quick, state.sortKey || (state.role === 'annotator' ? 'submit_total' : 'review_total'), state.sortDirection, state.regions);
  }

  function exportStats() {
    if ($('#export').disabled) return;
    var rows = visibleRows(), metrics = METRICS[state.role].filter(metricMatches);
    if (!rows || !rows.length || !state.user) return;
    var table = [
      ['统计类型', roleTitle(state.role)],
      ['账号', state.user.name, 'ID', state.user.id],
      ['日期', state.queryRange[0], state.queryRange[1]],
      ['工作区', state.queryWorkspace],
      ['服务器项目筛选', state.queryScope.title, state.queryScope.ids.join(',')],
      ['本地搜索', state.quick],
      ['完整性', '已完成本人查询', '缺失字段留空，真实零保留 0'],
      ['导出范围', '全部匹配项目', rows.length],
      ['统计说明', '准确率仅纳入通过和驳回均有值的项目；项目 regions 为全部成员全日期累计参考'],
      ['项目 ID', '项目名称'].concat(metrics.map(function (m) { return m[1] + '（' + m[2] + '）'; })),
    ];
    rows.forEach(function (row) {
      table.push([row.project_id, row.project_title || ('项目 #' + row.project_id)].concat(metrics.map(function (m) { return rowMetric(row, m[0], state.regions); })));
    });
    var blob = new Blob([csvText(table)], {type: 'text/csv;charset=utf-8;'}), url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = 'Insta360-' + roleTitle(state.role) + '-' + state.queryRange.join('_') + '.csv';
    document.body.appendChild(link); link.click(); link.remove(); setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    $('#export-feedback').textContent = '已导出 ' + rows.length + ' 个匹配项目';
  }

  function renderStats() {
    var metrics = METRICS[state.role].filter(metricMatches), rows = visibleRows();
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
      return '<div class="metric" title="' + escape(m[3]) + '"><span>' + (m[0] === 'update_total' ? m[1] : SHORT_LABELS[m[0]] || m[1]) + '</span><div class="metric-value" data-count-key="' + state.role + ':' + m[0] + '"' + target + '><strong>' + display(n, m[0]) + '</strong><small>' + m[2] + '</small></div>' + coverage + '</div>';
    }
    var overviewKeys = state.role === 'annotator' ? ['submit_total', 'update_total', 'accuracy', 'regions'] : ['review_total', 'review_passed', 'review_rejected', 'regions'];
    var personalMetrics = overviewKeys.map(function (key) { return METRICS[state.role].find(function (m) { return m[0] === key; }); });
    var projectMetrics = metrics.filter(function (m) { return m[0] === 'project_regions'; });
    var cardsChanged = setMarkup('#metrics', personalMetrics.map(card).join('') || '<p class="empty">请勾选要显示的本人统计字段</p>');
    $('#project-reference').hidden = !projectMetrics.length;
    var projectChanged = setMarkup('#project-metrics', projectMetrics.map(card).join(''));
    // 总览直接显示精确数值，搜索和翻页时不播放数字动画。
    var primary = state.role === 'annotator' ? 'submit_total' : 'review_total';
    var key = state.sortKey || primary;
    var head = '<thead><tr>' + [['project_title', '项目名称']].concat(metrics).map(function (m) {
      var active = key === m[0];
      return '<th scope="col" aria-sort="' + (active ? state.sortDirection === 'asc' ? 'ascending' : 'descending' : 'none') + '"><button type="button" data-sort="' + escape(m[0]) + '" title="' + escape((m[3] || m[1]) + ' · 点击排序') + '">' + escape(SHORT_LABELS[m[0]] || m[1]) + '<span aria-hidden="true">' + (active ? state.sortDirection === 'asc' ? ' ↑' : ' ↓' : ' ↕') + '</span></button></th>';
    }).join('') + '</tr></thead>';
    var count = rows ? rows.length : 0, pages = Math.max(1, Math.ceil(count / state.pageSize));
    state.page = Math.min(state.page, pages);
    $('#result-count').textContent = rows ? count + ' / ' + state.stats.length + ' 个项目' + (state.quick ? ' · 搜索结果' : '') : '尚未查询';
    $('#page-info').textContent = '第 ' + state.page + ' / ' + pages + ' 页';
    $('#prev-page').disabled = state.page <= 1;
    $('#next-page').disabled = state.page >= pages;
    $('#pagination').hidden = !count;
    $('#export').disabled = !count || state.statsBusy || !!state.statsError || !!state.error || !metrics.length || (metrics.some(function (m) { return m[0] === 'project_regions'; }) && (state.regionBusy || !!state.regionError || !state.regions));
    if (state.statsError) setMarkup('#stats-data', '<p class="error" role="alert">' + escape(state.statsError) + '</p>');
    else if (!rows) setMarkup('#stats-data', '<div class="empty"><span class="empty-symbol" aria-hidden="true">▦</span><strong>' + (state.statsBusy ? '正在读取本人工作量…' : '选择日期，开始查看工作数据') + '</strong><span>' + (state.statsBusy ? '分页数据返回后会逐步显示' : '点击上方“查询 / 刷新”读取当前账号数据') + '</span></div>');
    else if (!rows.length) setMarkup('#stats-data', '<div class="empty"><span class="empty-symbol" aria-hidden="true">⌕</span><strong>' + (state.quick ? '没有找到匹配的项目' : state.statsBusy ? '正在继续查询项目…' : '当前范围暂无个人记录') + '</strong><span>' + (state.quick ? '试试项目名称、ID，或清空搜索' : '可以更改日期或工作区后重新查询') + '</span></div>');
    else {
      var pageRows = rows.slice((state.page - 1) * state.pageSize, state.page * state.pageSize);
      var body = pageRows.map(function (row) {
        return '<tr><td><span class="project-name" title="' + escape(row.project_title) + '">' + escape(row.project_title || ('项目 #' + row.project_id)) + '</span><small class="project-id">#' + escape(row.project_id) + '</small></td>' + metrics.map(function (m) {
          var value = rowMetric(row, m[0], state.regions);
          var content = display(value, m[0]) + (m[0] === 'accuracy' && value != null ? '%' : '');
          return '<td class="' + (value == null ? 'missing' : m[0] === primary ? 'primary-number' : '') + '">' + (m[0] === 'accuracy' && value != null ? '<span class="accuracy ' + (value >= 95 ? 'good' : value >= 80 ? 'medium' : 'low') + '">' + content + '</span>' : content) + '</td>';
        }).join('') + '</tr>';
      }).join('');
      var totals = '<tfoot><tr><th scope="row">匹配项目合计 <small>' + rows.length + ' 项</small></th>' + metrics.map(function (m) {
        var total = m[0] === 'accuracy' ? accuracySummary(rows).value : m[0] === 'project_regions' ? sumRegions(rows) : summarizeMetric(rows, m[0] === 'regions' ? 'label__region' : m[0]).value;
        return '<td>' + display(total, m[0]) + (m[0] === 'accuracy' && total != null ? '%' : '') + '</td>';
      }).join('') + '</tr></tfoot>';
      setMarkup('#stats-data', '<div class="table-wrap" tabindex="0" role="region" aria-label="项目产量明细，可横向滚动"><table>' + head + '<tbody>' + body + '</tbody>' + totals + '</table></div>');
    }
    $('#stats-note').textContent = state.role === 'annotator'
      ? '新标注提交与返修 / 返工更新分别统计。通过、驳回按平台统计口径；缺失数据用“—”表示。'
      : '审核数量按通过 / 驳回的动作次数统计。同一条数据重复审核可能计多次，与平台“数据统计”一致。';
    if (state.discarded) $('#stats-note').textContent += ' 已排除非本人记录。';
    $('#stats-note').textContent += ' 本人 regions 数按当前账号及所选日期统计，与任务条数分别计数。';
    if (hasMissing) $('#stats-note').textContent += ' 存在缺失字段时，卡片仅合计已知数值，并标注有值项目数；全部缺失仍显示“—”，不按 0 计算。';
    if (state.role === 'annotator') $('#stats-note').textContent += ' 准确率 = 审核通过 /（审核通过 + 审核驳回）× 100%；先合计再计算，只纳入通过、驳回均有值的项目，分母为 0 时显示“—”。';
    if (projectMetrics.length && state.regionError) $('#stats-note').textContent += ' 项目参考区域总数读取失败：' + state.regionError;
    else if (projectMetrics.length && !state.regions && !state.regionBusy) $('#stats-note').textContent += ' 项目 regions 总数需勾选后点击“查询 / 刷新”读取。';
    $('#range-caption').textContent = state.queryRange ? state.queryRange[0] + (state.queryRange[0] === state.queryRange[1] ? '' : ' — ' + state.queryRange[1]) + ' · ' + (state.queryWorkspace === 'all' ? '全部可访问项目' : '工作区 #' + state.queryWorkspace) + progressText(state.statsProgress) : '尚未查询，请点击“查询 / 刷新”';
    if (state.queryScope && (state.queryScope.title || state.queryScope.ids.length)) $('#range-caption').textContent += ' · 服务端项目筛选：' + [state.queryScope.title, state.queryScope.ids.length ? 'ID ' + state.queryScope.ids.join(', ') : ''].filter(Boolean).join('；');
  }

  function renderPending() {
    $('#pending-section').hidden = state.role !== 'annotator';
    if (state.role !== 'annotator') {
      setMarkup('#pending-data', ''); $('#pending-total').textContent = ''; $('#pending-updated').textContent = ''; return;
    }
    $('#pending-updated').textContent = state.pendingUpdated ? '读取于 ' + state.pendingUpdated + ' · 仅点击“查询 / 刷新”时更新' : '';
    var failure = state.pendingError ? '<p class="error" role="alert">返修 / 返工：' + escape(state.pendingError) + (state.pending ? '。已保留本次读到的部分数据，合计未完整。' : '。本人产量统计不受影响。') + ' <button type="button" data-retry-pending>仅重试待处理</button></p>' : '';
    if (state.pendingError && !state.pending) { setMarkup('#pending-data', failure); $('#pending-total').textContent = '未完成'; return; }
    if (!state.pending) { setMarkup('#pending-data', '<p class="empty">' + (state.pendingBusy ? '正在读取本人待处理项目…' : '点击“查询 / 刷新”读取待处理数据') + '</p>'); $('#pending-total').textContent = ''; return; }
    var items = state.pending.items.filter(function (p) { return matches(p.name) && (!state.quick.trim() || (p.name + ' #' + p.id).toLocaleLowerCase().includes(state.quick.trim().toLocaleLowerCase())) && (state.pendingMode === 'all' || p[state.pendingMode] > 0); });
    var repair = 0, rework = 0;
    items.forEach(function (p) { repair += p.repair || 0; rework += p.rework || 0; });
    $('#pending-total').textContent = items.length + ' 个项目 · 返修 ' + repair + ' · 返工 ' + rework + (state.pending.unknown ? '（部分计数未取得）' : '') + (state.pendingError ? ' · 未完整' : progressText(state.pendingProgress));
    var warning = failure + (state.pending.unknown ? '<p class="notice">有 ' + state.pending.unknown + ' 个项目未返回完整个人计数，当前合计仅包含已取得的数据。请刷新或查看原项目卡片。</p>' : '');
    if (!items.length) {
      setMarkup('#pending-data', warning + '<p class="empty">' + (state.filter ? '没有匹配的个人待处理项目' : state.pendingError ? '查询未完整，尚不能确定是否有待处理数据' : state.pendingBusy ? '已读取部分项目包，正在继续查询…' : state.pending.unknown ? '已取得个人计数的项目中暂无待处理数据' : '当前范围内，本人暂无待返修或待返工数据') + '</p>');
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
    $('#stats-title').textContent = state.role === 'reviewer' ? '审核工作总览' : '标注工作总览';
    $('#clear-quick').hidden = !state.quick;
    root.querySelectorAll('[data-pending-mode]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.pendingMode === state.pendingMode)); });
    $('#account').textContent = state.user ? state.user.name + ' · #' + state.user.id : state.busy ? '正在确认当前账号…' : '仅显示当前登录账号的数据';
    $('#start').value = state.range[0]; $('#end').value = state.range[1];
    $('#project-ids').value = state.projectIdsText;
    renderFieldOptions(); renderProjectChoices();
    $('#query').textContent = state.busy ? '重新查询' : '查询 / 刷新';
    $('#error').textContent = state.error; $('#error').hidden = !state.error;
    $('#updated').textContent = state.statsBusy ? '读取中…' : state.updated ? '更新于 ' + state.updated : '';
    var changed = false;
    if (state.queryRange && state.queryScope) {
      try { changed = JSON.stringify(state.range) !== JSON.stringify(state.queryRange) || state.workspace !== state.queryWorkspace || !state.queryScope || state.filter.trim() !== state.queryScope.title || JSON.stringify(currentScope()) !== JSON.stringify(state.queryScope); }
      catch (_) { changed = true; }
    }
    $('#query-help').textContent = changed ? '筛选条件已修改，点击“查询 / 刷新”应用；下方仍为上次查询结果。' : '手动查询 · 本地搜索、排序和翻页无需重复请求。';
    $('#query-help').classList.toggle('changed', changed);
    $('#query-help').hidden = !changed;
    $('#query-state').textContent = state.busy ? '正在读取数据' : state.error || state.statsError ? '查询遇到问题' : changed ? '查询条件未应用' : state.pendingError || state.regionError ? '部分数据未完成' : state.updated ? '查询完成' : '等待查询';
    $('#query-state').setAttribute('data-status', state.busy ? 'busy' : state.error || state.statsError ? 'error' : changed ? 'changed' : state.pendingError || state.regionError ? 'partial' : 'ready');
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
      '<section id="panel" aria-label="我的工作台"><header><div class="heading"><h1 id="work-title"></h1><span id="account"></span></div><div class="header-actions"><span id="query-state" role="status"></span><button id="close" type="button" aria-label="收起工作台">×</button></div><span id="center-label" class="sr-only"></span></header>' +
      '<div class="scroll"><div class="filters"><div class="query-row"><div class="presets" role="group" aria-label="日期快捷选择"><button type="button" data-preset="today">今天</button><button type="button" data-preset="yesterday">昨天</button><button type="button" data-preset="week">近 7 天</button><button type="button" data-preset="month">本月</button></div>' +
      '<div class="dates"><input id="start" type="date" aria-label="开始日期"><span>—</span><input id="end" type="date" aria-label="结束日期"></div>' +
      '<details class="advanced"><summary>列设置 <span aria-hidden="true">⌄</span></summary><div class="advanced-body"><div class="settings-heading">显示统计列<span id="field-count"></span></div>' +
      '<div class="field-picker" role="group" aria-label="显示统计字段"><div class="field-toolbar"><span>显示列</span><button id="field-default" type="button">默认</button><button id="field-all" type="button">全选</button><button id="field-none" type="button">清空</button></div><div id="field-options" class="field-options"></div></div><p class="setting-note">显示列与导出列立即生效。</p><button id="apply-filters" type="button">完成</button></div></details></div>' +
      '<div class="scope-row" role="group" aria-label="项目筛选"><select id="scope" aria-label="工作区"></select>' +
      '<details id="project-picker" class="project-picker"><summary aria-label="选择项目"><span id="project-label">全部项目</span><span aria-hidden="true">⌄</span></summary><div class="project-choice-panel"><input id="search" type="search" placeholder="搜索项目名称 / ID" aria-label="搜索可选项目" autocomplete="off"><div id="project-options" role="listbox" aria-label="项目选项"></div></div></details>' +
      '<input id="project-ids" type="text" aria-label="筛选项目 ID" placeholder="项目 ID（可多输）"><button id="query" class="primary" type="button">查询 / 刷新</button><button id="reset-filters" type="button">重置</button></div><p id="query-help" class="query-help" hidden></p></div>' +
      '<p id="error" class="error" role="alert" hidden></p><div class="result-meta"><p id="range-caption" class="caption"></p><span id="updated" aria-live="polite"></span></div>' +
      '<section id="overview" aria-label="核心工作指标"><h2 id="stats-title" class="sr-only"></h2><div id="metrics" class="metrics"></div></section>' +
      '<section id="details" class="detail-section" aria-label="项目明细"><div class="table-toolbar"><div class="quick-search"><span aria-hidden="true">⌕</span><input id="quick-search" type="search" placeholder="搜索项目名称 / ID" aria-label="搜索当前结果"><button id="clear-quick" type="button" aria-label="清空当前搜索" hidden>×</button></div><span id="result-count"></span><button id="export" type="button" disabled>导出 CSV</button></div><p id="export-feedback" class="sr-only" role="status"></p><div id="stats-data" aria-live="polite"></div>' +
      '<div id="pagination" class="pagination" hidden><label>每页<select id="page-size" aria-label="每页项目数"><option value="10">10 项</option><option value="20">20 项</option><option value="50">50 项</option></select></label><span id="page-info"></span><button id="prev-page" type="button" aria-label="上一页">←</button><button id="next-page" type="button" aria-label="下一页">→</button></div></section>' +
      '<section id="project-reference" class="project-reference" aria-label="项目累计参考" hidden><h2>项目累计参考</h2><p class="note">全部成员、所有日期的 regions，不计入本人产量。</p><div id="project-metrics" class="metrics"></div></section>' +
      '<details id="pending-section" class="pending-section"><summary><span>返修 / 返工</span><span id="pending-total"></span></summary><div class="pending-body"><div class="pending-toolbar"><p class="note">当前待处理 · 不受日期筛选影响</p><div class="pending-tabs" role="group" aria-label="待处理类型"><button data-pending-mode="all" aria-pressed="true">全部</button><button data-pending-mode="repair">待返修</button><button data-pending-mode="rework">待返工</button></div></div><div id="pending-data" aria-live="polite"></div><p id="pending-updated" class="caption"></p></div></details>' +
      '<details class="metric-notes"><summary>统计说明</summary><p id="stats-note" class="note"></p></details></div></section>';
    document.body.appendChild(host);
    $('#close').addEventListener('click', function () {
      if (state.statsBusy) { state.stats = null; state.statsProgress = null; state.updated = ''; }
      if (state.pendingBusy) { state.pending = null; state.pendingProgress = null; state.pendingUpdated = ''; }
      if (state.regionBusy) { state.regions = null; state.regionUpdated = ''; }
      state.opened = false; cancelChoices(); if (workspaceController) workspaceController.abort(); workspaceBusy = false; abort(); cancelOtherJobs([]); render(); focusEntry();
    });
    $('#query').addEventListener('click', function () { $('.advanced').open = false; $('#project-picker').open = false; refresh(true); });
    $('#apply-filters').addEventListener('click', function () { $('.advanced').open = false; });
    $('#reset-filters').addEventListener('click', resetFilters);
    $('#project-picker').addEventListener('toggle', function () { if (this.open) { $('.advanced').open = false; renderProjectChoices(); loadProjectChoices(false); $('#search').focus(); } });
    root.querySelectorAll('[data-preset]').forEach(function (b) { b.addEventListener('click', function () { state.preset = b.dataset.preset; state.range = presetRange(state.preset); render(); }); });
    ['start','end'].forEach(function (key, index) { $('#' + key).addEventListener('change', function () { state.range[index] = this.value; state.preset = ''; render(); }); });
    $('#scope').addEventListener('focus', loadWorkspaceChoices);
    $('#scope').addEventListener('pointerdown', loadWorkspaceChoices);
    $('#scope').addEventListener('change', function () { cancelChoices(); state.workspace = this.value; state.filter = ''; state.selectedProjectId = ''; state.choiceSearch = ''; $('#search').value = ''; $('#project-picker').open = false; render(); });
    $('#search').addEventListener('input', function () { state.choiceSearch = this.value; renderProjectChoices(); });
    $('#project-ids').addEventListener('input', function () { state.projectIdsText = this.value; render(); });
    $('#field-options').addEventListener('change', function (event) {
      var input = event.target, key = input && input.dataset && input.dataset.field;
      if (!METRICS[state.role].some(function (metric) { return metric[0] === key; })) return;
      if (input.checked) state.fieldSelection[state.role].add(key); else state.fieldSelection[state.role].delete(key);
      renderFieldOptions(); renderStats();
    });
    $('#field-all').addEventListener('click', function () { selectFields(true); });
    $('#field-default').addEventListener('click', function () { state.fieldSelection[state.role] = defaultFields(state.role); renderFieldOptions(); renderStats(); });
    $('#field-none').addEventListener('click', function () { selectFields(false); });
    $('#quick-search').addEventListener('input', function () { state.quick = this.value; state.page = 1; renderStats(); renderPending(); $('#clear-quick').hidden = !state.quick; });
    $('#clear-quick').addEventListener('click', function () { state.quick = ''; state.page = 1; $('#quick-search').value = ''; render(); $('#quick-search').focus(); });
    $('#page-size').addEventListener('change', function () { state.pageSize = Number(this.value); state.page = 1; renderStats(); });
    $('#prev-page').addEventListener('click', function () { state.page--; renderStats(); });
    $('#next-page').addEventListener('click', function () { state.page++; renderStats(); });
    $('#export').addEventListener('click', exportStats);
    root.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && ['start', 'end', 'project-ids'].indexOf(event.target.id) >= 0) { event.preventDefault(); $('#query').click(); }
      if ($('#project-picker').open && ['ArrowDown', 'ArrowUp', 'Home', 'End'].indexOf(event.key) >= 0) {
        var choices = Array.from(root.querySelectorAll('#project-options button[role=option]')), active = choices.indexOf(root.activeElement);
        if (choices.length) { event.preventDefault(); var next = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : active < 0 ? event.key === 'ArrowUp' ? choices.length - 1 : 0 : (active + (event.key === 'ArrowUp' ? -1 : 1) + choices.length) % choices.length; choices[next].focus(); }
      }
      if (event.key === 'Escape' && $('#project-picker').open) { event.preventDefault(); $('#project-picker').open = false; $('#project-picker summary').focus(); return; }
      if (event.key === 'Escape' && $('.advanced').open) { event.preventDefault(); $('.advanced').open = false; $('.advanced summary').focus(); return; }
      if (event.key === 'Escape' && state.opened) { if (event.target.id === 'quick-search' && state.quick) { event.preventDefault(); $('#clear-quick').click(); } else $('#close').click(); }
    });
    ['pointerdown', 'mousedown', 'touchstart'].forEach(function (type) { root.addEventListener(type, function (event) { event.stopPropagation(); }); });
    root.addEventListener('click', function (event) {
      event.stopPropagation();
      if (!$('.advanced').contains(event.target)) $('.advanced').open = false;
      if (!$('#project-picker').contains(event.target)) $('#project-picker').open = false;
      var choice = event.target.closest('[data-project-choice], [data-project-keyword]');
      if (choice) {
        state.selectedProjectId = choice.hasAttribute('data-project-choice') ? choice.dataset.projectChoice : '';
        var project = choiceRows.find(function (row) { return id(row.id) === state.selectedProjectId; });
        state.filter = project ? String(project.title || '') : choice.hasAttribute('data-project-keyword') ? state.choiceSearch.trim() : '';
        state.choiceSearch = ''; $('#search').value = ''; state.page = 1; $('#project-picker').open = false; render(); $('#project-picker summary').focus();
      }
      if (event.target.closest('[data-retry-choices]')) loadProjectChoices(true);
      if (event.target.closest('[data-retry-pending]') && !state.pendingBusy && state.user && state.queryScope) refreshPending(true, runNumber, state.user, state.queryWorkspace, state.queryScope);
      var button = event.target.closest('[data-work]');
      if (button) goToWork(button.dataset.project, button.dataset.work, button);
      var sort = event.target.closest('[data-sort]');
      if (sort) {
        var oldKey = state.sortKey || (state.role === 'annotator' ? 'submit_total' : 'review_total');
        state.sortDirection = oldKey === sort.dataset.sort && state.sortDirection === 'desc' ? 'asc' : 'desc';
        state.sortKey = sort.dataset.sort; state.page = 1; renderStats();
        var next = root.querySelector('[data-sort="' + state.sortKey + '"]'); if (next) next.focus({preventScroll: true});
      }
      var mode = event.target.closest('[data-pending-mode]');
      if (mode) { state.pendingMode = mode.dataset.pendingMode; render(); }

    });
  }

  var CSS = `
    :host{all:initial;position:fixed;z-index:1000003;inset:0;display:block;overflow:hidden;pointer-events:none;--ink:#263347;--muted:#8490a0;--line:#e8ecf1;--blue:#2863c9;font:13px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;color:var(--ink)}
    :host([hidden]),[hidden]{display:none!important}*{box-sizing:border-box}h1,h2,p{margin:0}button,input,select{font:inherit}button{cursor:pointer;border:1px solid #dde3eb;border-radius:5px;background:#fff;color:#536174;padding:6px 10px;white-space:nowrap}button:hover:not(:disabled){background:#f5f7fa;border-color:#bac9dd}button:disabled{opacity:.38;cursor:default}button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible,.table-wrap:focus-visible{outline:2px solid #6b96df;outline-offset:2px}input,select{min-width:0;border:1px solid #dde3eb;border-radius:5px;background:#fff;color:var(--ink);padding:6px 8px}input[type=checkbox]{accent-color:var(--blue)}summary{cursor:pointer;list-style:none}summary::-webkit-details-marker{display:none}
    #panel{width:100%;height:100%;min-width:0;display:flex;flex-direction:column;overflow:hidden;background:#fff;border-left:1px solid var(--line);pointer-events:auto}header{height:62px;flex:none;padding:0 24px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--line)}.heading,.header-actions{display:flex;align-items:center;gap:16px;min-width:0}h1{font-size:19px;font-weight:650;letter-spacing:-.4px;white-space:nowrap}#account{font-size:11px;color:#8b96a5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:240px}.header-actions{gap:16px}#query-state{font-size:10px;color:#98a2af;display:inline-flex;align-items:center;gap:6px;white-space:nowrap}#query-state:before{content:"";width:5px;height:5px;border-radius:50%;background:#78a58d}#query-state[data-status=busy]{color:#4e7ac6}#query-state[data-status=busy]:before{background:#5c8ada}#query-state[data-status=error],#query-state[data-status=changed]{color:#a97939}#query-state[data-status=error]:before,#query-state[data-status=changed]:before{background:#c69b5b}#close{border:0;padding:1px 4px;font-size:23px;line-height:1;color:#939dab;background:transparent}
    .scroll{flex:1;min-height:0;overflow:auto;padding:18px 24px 16px;scrollbar-width:thin}.query-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;position:relative}.presets{display:flex;background:#f3f5f8;padding:3px;border-radius:6px;flex-shrink:0}.presets button{border:0;background:transparent;color:#85909e;font-size:11px;padding:4px 12px}.presets button[aria-pressed=true]{background:white;color:#3065bc;box-shadow:0 1px 3px #172a4212;font-weight:600}.dates{display:flex;align-items:center;gap:7px;color:#b1b9c5;min-width:0}.dates input{width:134px;font-size:11px;padding:6px;min-width:0}.dates>span{font-size:10px}button.primary{background:var(--blue);border-color:var(--blue);color:white;font-size:11px;padding:7px 14px}button.primary:hover{background:#2058b8}.advanced{margin-left:auto;font-size:11px;flex-shrink:0}.advanced>summary{border:1px solid #dde3eb;border-radius:5px;padding:6px 11px;color:#748194;white-space:nowrap}.advanced[open]>summary{color:#2863c9;border-color:#a9bfdf}.advanced>summary span{margin-left:8px;color:#9aa5b4}.advanced-body{position:absolute;right:0;top:calc(100% + 8px);width:490px;max-width:100%;z-index:20;padding:18px;background:white;border:1px solid #dfe5ee;border-radius:8px;box-shadow:0 8px 30px #253b5c1f;max-height:min(560px,65vh);overflow:auto}.settings-heading{display:flex;align-items:center;justify-content:space-between;font-size:12px;font-weight:600;margin-bottom:15px}.settings-heading>span{font-size:10px;color:#9ca6b3;font-weight:400}.scope-label{display:flex;align-items:center;gap:12px;font-size:11px;color:#7a8798}.scope-label select{flex:1;font-size:11px}.project-filters{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:14px 0}.project-filters label{display:flex;flex-direction:column;gap:5px;font-size:11px;color:#8a95a5;min-width:0}.project-filters input{width:100%;font-size:11px}.field-picker{border-top:1px solid var(--line);padding-top:12px}.field-toolbar{display:flex;gap:5px;align-items:center;margin-bottom:10px;font-size:11px;color:#7d8a9d}.field-toolbar>span{margin-right:auto}.field-toolbar button{font-size:10px;padding:2px 7px}.field-options{display:grid;grid-template-columns:1fr 1fr;gap:10px 12px}.field-option{display:flex;align-items:center;gap:6px;font-size:11px;color:#758298;cursor:pointer;min-width:0}.field-option input{padding:0;margin:0}.setting-note{font-size:10px;color:#a1aab7;margin:15px 0 12px}.query-help{font-size:11px;margin:9px 0 0;color:#a47637;background:#fff8e9;border:1px solid #f1e6cd;padding:7px 10px;border-radius:5px}
    .result-meta{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-top:12px;color:#9da7b4;font-size:10px}.caption{font-size:10px;color:#98a3b3}.result-meta .caption{color:#8f9aaa}.result-meta>#updated{white-space:nowrap;font-size:10px}.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));margin:16px 0 22px;border-bottom:1px solid var(--line);padding-bottom:17px;gap:0}.metric{min-width:0;padding:0 24px;border-left:1px solid var(--line)}.metric:first-child{padding-left:0;border-left:0}.metric>span{font-size:11px;color:#8b96a6}.metric-value{display:flex;align-items:baseline;gap:5px;margin-top:5px;white-space:nowrap}.metric-value strong{font-size:27px;font-weight:600;letter-spacing:-.6px;line-height:1.25;font-variant-numeric:tabular-nums}.metric:first-child strong{color:#2b63c0}.metric-value small{font-size:10px;color:#a0a9b7}.metric-coverage{display:block;color:#a6814c;font-size:9px;margin-top:5px}
    .detail-section{border:1px solid var(--line);border-radius:7px;overflow:hidden;background:#fff}.table-toolbar{display:flex;align-items:center;gap:12px;padding:12px 14px}.quick-search{display:flex;align-items:center;gap:6px;min-width:0;width:270px;border:1px solid #e0e6ee;border-radius:5px;padding:0 8px;background:#fff}.quick-search>span{font-size:20px;line-height:1;color:#a2afc1}.quick-search input{font-size:11px;min-width:0;flex:1;width:100%;border:0;padding:6px 2px;outline:0;background:transparent}.quick-search:focus-within{border-color:#8eabdc;box-shadow:0 0 0 2px #eef3fc}.quick-search button{padding:0 1px;font-size:17px;color:#a4aebb;border:0;background:transparent}#result-count{font-size:10px;color:#9ba6b5;white-space:nowrap}#export{margin-left:auto;font-size:11px;padding:5px 10px;color:#748196}.table-wrap{overflow:auto;max-height:min(520px,65vh);scrollbar-width:thin;overscroll-behavior:contain}table{border-collapse:separate;border-spacing:0;width:100%;white-space:nowrap;font-size:12px}thead th{position:sticky;top:0;z-index:2;padding:0;text-align:right;font-weight:400;background:#f8f9fb;border-bottom:1px solid var(--line);border-top:1px solid var(--line);color:#8d98a8}thead th button{font-size:11px;border:0;border-radius:0;background:transparent;color:inherit;display:block;width:100%;padding:10px 12px;text-align:right}thead th button span{color:#c4cbd6;font-size:10px}thead th[aria-sort=ascending],thead th[aria-sort=descending]{color:#426db3}thead th[aria-sort=ascending] span,thead th[aria-sort=descending] span{color:#7194cd}td,thead th:first-child{background:#fff}th:first-child,td:first-child{position:sticky;left:0;text-align:left;min-width:245px;max-width:270px;width:270px;box-shadow:1px 0 0 #edf0f4}thead th:first-child{z-index:3;background:#f8f9fb}thead th:first-child button{text-align:left;padding-left:16px}td{padding:12px;border-bottom:1px solid #eff2f6;text-align:right;font-variant-numeric:tabular-nums;color:#68778d}td:first-child{padding-left:16px}.project-name{display:inline-block;vertical-align:middle;max-width:190px;overflow:hidden;text-overflow:ellipsis;color:#4b5b72;font-size:11px;font-weight:450}.project-id{display:inline-block;vertical-align:middle;font-size:9px;color:#adb6c4;margin-left:8px}.primary-number{font-weight:600;color:#3d68ae}.missing{color:#bdc6d2}.accuracy{font-size:11px}.accuracy.good{color:#658c77}.accuracy.medium{color:#aa8a52}.accuracy.low{color:#bf737d}tbody tr:hover td{background:#f8faff}tfoot th,tfoot td{position:sticky;bottom:0;z-index:1;background:#f8fafc;border-top:1px solid #e7ecf3;border-bottom:0;padding:12px;font-weight:550;color:#5c7294;font-size:11px}tfoot th:first-child{z-index:2;background:#f8fafc;padding-left:16px}tfoot small{font-size:9px;font-weight:400;color:#a0adbf;margin-left:4px}.pagination{display:flex;align-items:center;gap:6px;padding:10px 14px;border-top:1px solid var(--line);font-size:10px;color:#a0aab8}.pagination label{display:flex;align-items:center;gap:5px}.pagination select{font-size:10px;padding:2px 5px;color:#8f9bac;border-color:#e4e9f0}#page-info{margin-left:auto;margin-right:7px}.pagination button{font-size:12px;line-height:1;padding:4px 8px;color:#8195b5}
    .pending-section{margin-top:17px;border-bottom:1px solid var(--line);padding-bottom:12px}.pending-section>summary{display:flex;align-items:center;gap:8px;font-size:11px;color:#8390a2}.pending-section>summary:before{content:"›";font-size:15px;line-height:1;color:#a3afc0;transform:rotate(0deg)}.pending-section[open]>summary:before{transform:rotate(90deg)}#pending-total{font-size:10px;color:#a4adbb;margin-left:auto;text-align:right}.pending-toolbar{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin:14px 0 12px}.note{font-size:11px;color:#98a2b0;line-height:1.8}.pending-tabs{display:flex;gap:4px}.pending-tabs button{font-size:10px;padding:3px 8px;border-color:#e6ebf2}.pending-tabs button[aria-pressed=true]{background:#f1f5fd;color:#5a7bb5;border-color:#d8e3f4}.pending-list{border:1px solid var(--line);border-radius:6px;overflow:hidden}.pending-row{display:grid;grid-template-columns:minmax(0,1fr) 175px 175px;align-items:center;gap:20px;padding:12px 16px;border-bottom:1px solid var(--line)}.pending-row:last-child{border-bottom:0}.pending-project{min-width:0}.pending-project strong{font-size:11px;font-weight:450;display:inline-block;max-width:calc(100% - 48px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:middle}.pending-project small{font-size:9px;color:#a7b2c3;margin-left:7px}.lane{display:flex;align-items:center;gap:9px;justify-content:space-between;font-size:10px;color:#9aa5b5}.lane b{font-size:12px;font-weight:550;color:#7b8aa3;margin-left:4px}.lane button{font-size:10px;padding:3px 7px;color:#8c9db7;border-color:#e2e8f1}.pending-body>.caption{margin-top:10px}.metric-notes{margin-top:12px}.metric-notes>summary{font-size:10px;color:#abb4c0;display:inline-flex;align-items:center;gap:7px}.metric-notes>summary:before{content:"›";font-size:14px}.metric-notes[open]>summary:before{transform:rotate(90deg)}.metric-notes p{padding:12px 0;color:#909dae;font-size:11px;line-height:1.9}.project-reference{margin-top:16px;padding:14px;background:#fafbfd;border:1px solid #e6ebf2;border-radius:6px}.project-reference h2{font-size:12px;font-weight:500;color:#8491a5}.project-reference .metrics{display:block;margin:8px 0 0;padding:0;border:0}.project-reference strong{font-size:21px}.empty{display:flex;flex-direction:column;align-items:center;gap:7px;padding:38px 16px;color:#a8b3c3;font-size:11px}.empty strong{font-size:12px;font-weight:450;color:#8595ac}.empty-symbol{font-size:24px;line-height:1.5;color:#c0cede}.error{color:#b16a6c;background:#fff4f3;border:1px solid #f1dfdc;border-radius:5px;font-size:11px;padding:10px 12px;margin:12px 0}.notice{padding:8px 12px;color:#a9864e;background:#fff9ed;font-size:11px}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
    @media(max-width:1100px){header{padding:0 18px}.scroll{padding:16px 18px}.query-row{gap:8px}.presets button{padding:4px 10px}.metric{padding:0 16px}.pending-row{grid-template-columns:minmax(0,1fr) 145px 145px;gap:12px}.project-name{max-width:165px}}
    @media(max-width:760px){header{padding:0 14px;height:58px}.scroll{padding:14px}.heading{gap:9px}h1{font-size:18px}#account{font-size:10px;max-width:115px}.header-actions{gap:11px}.metric{padding:0 12px}.metric-value strong{font-size:24px}.metric-value{gap:3px}.presets button{font-size:10px;padding:5px 8px}.dates input{width:123px}.advanced{margin-left:auto}.table-toolbar{gap:9px;padding:10px}.quick-search{width:230px}#result-count{font-size:9px}.pending-row{grid-template-columns:1fr;gap:8px}.lane{justify-content:flex-start;gap:20px}.lane>span{min-width:80px}}
    @media(max-width:640px){.query-row{row-gap:10px}.presets{order:0;flex:1}.presets button{flex:1}.advanced{order:1}.dates{order:2;flex:1 0 calc(100% - 88px)}.dates input{width:calc(50% - 12px);flex:1;min-width:0}#query{order:3;font-size:11px;padding:7px 10px}.metrics{grid-template-columns:repeat(2,minmax(0,1fr));gap:17px 0;margin-top:17px;padding-bottom:17px;margin-bottom:16px}.metric{padding-left:17px}.metric:nth-child(odd){padding-left:0;border-left:0}.metric-value strong{font-size:25px}.metric>span{font-size:10px}.result-meta{gap:8px;margin-top:12px}.result-meta .caption{font-size:9px}.result-meta>#updated{font-size:9px}.table-toolbar{flex-wrap:wrap;gap:8px}.quick-search{width:100%;flex:auto}#result-count{flex:1}.table-wrap{max-height:500px}th:first-child,td:first-child{min-width:170px;max-width:170px;width:170px}.project-name{max-width:105px}.project-id{font-size:8px;margin-left:5px}td,td:first-child{padding:11px 10px}thead th:first-child button{padding-left:10px}thead th button{padding:9px 10px}#pending-total{font-size:9px}.project-filters{grid-template-columns:1fr}.advanced-body{padding:15px}.field-options{gap:10px}.metric-notes{margin-top:11px}.pending-section{margin-top:15px}}
    @media(max-width:350px){#account{max-width:92px}.header-actions{gap:7px}#query-state{font-size:9px}.heading{gap:7px}h1{font-size:17px}.scroll{padding:12px}.presets button{padding:5px 6px}.advanced>summary{padding:6px 9px}.advanced>summary span{margin-left:3px}.metrics{gap:15px 0}.metric-value strong{font-size:24px}.metric-value small{font-size:9px}#pending-total{max-width:180px}.field-options{grid-template-columns:1fr}.result-meta>#updated{display:none}}

    .filters{position:relative}.query-row{position:static}.scope-row{display:grid;grid-template-columns:minmax(140px,1fr) minmax(180px,1.25fr) minmax(150px,1fr) auto auto;gap:8px;margin-top:10px;align-items:start}.scope-row>select,.scope-row>input,.scope-row>button,.project-picker>summary{height:32px;font-size:11px;border-radius:4px}.scope-row>select,.scope-row>input{width:100%;min-width:0;padding:5px 9px}.scope-row>button{white-space:nowrap;padding:5px 12px}.project-picker{position:relative;min-width:0}.project-picker>summary{display:flex;gap:10px;align-items:center;justify-content:space-between;padding:5px 10px;list-style:none;border:1px solid #dce4ef;background:#fff;cursor:pointer;color:#718096}.project-picker>summary::-webkit-details-marker{display:none}#project-label{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.project-picker[open]>summary{border-color:#82a5e3;box-shadow:0 0 0 2px #eef3fc}.project-choice-panel{position:absolute;top:37px;left:0;width:100%;min-width:260px;max-width:calc(100vw - 28px);padding:7px;background:white;border:1px solid #dce4ef;box-shadow:0 5px 18px #263f611c;border-radius:5px;z-index:20}.project-choice-panel>input{width:100%;min-width:0;padding:6px 8px;font-size:11px}#project-options{margin-top:5px;max-height:min(290px,45vh);overflow:auto;scrollbar-width:thin}#project-options>button{display:flex;align-items:center;gap:8px;width:100%;text-align:left;border:0;border-radius:2px;background:#fff;padding:8px;font-size:11px;color:#53647c}#project-options>button[aria-selected=true],#project-options>button:hover,#project-options>button:focus-visible{background:#edf3fe;color:#356dc6}.choice-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#project-options small{margin-left:auto;font-size:9px;color:#a2aec0}.choice-note{font-size:11px;line-height:1.6;color:#9aa7b9;padding:10px 8px}.query-row>.advanced{margin-left:auto}.advanced-body{width:370px}#query-state[data-status=partial]{color:#ad854c}#query-state[data-status=partial]:before{background:#c69b5b}.error [data-retry-pending]{font-size:11px;margin-left:6px;padding:3px 8px}.query-row .dates{flex:0 0 auto}.query-row .dates input{width:134px;min-width:104px}.scope-row #query{order:initial}
    @media(max-width:900px){.scope-row{grid-template-columns:minmax(120px,1fr) minmax(150px,1fr) minmax(120px,1fr) auto}.scope-row #reset-filters{grid-column:4}.scope-row #query{grid-column:4;grid-row:1}.scope-row #reset-filters{display:none}}
    @media(max-width:640px){.query-row{gap:8px}.query-row .presets{flex:1;order:0}.query-row>.advanced{order:1}.query-row .dates{order:2;flex:1 0 100%;width:100%}.query-row .dates input{flex:1 1 100px;width:calc(50% - 12px);min-width:85px}.scope-row{grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px}.scope-row>select,.scope-row>.project-picker{grid-row:1}.scope-row>#project-ids{grid-column:1;grid-row:2}.scope-row #query{grid-column:2;grid-row:2;justify-self:stretch}.scope-row #reset-filters{display:none}.project-choice-panel{min-width:0;width:calc(200% + 8px);left:auto;right:0}.advanced-body{width:min(370px,calc(100vw - 28px))}.metrics{margin-top:14px}.scope-row .project-picker>summary{padding:5px 8px}}
    @media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important;animation:none!important}}
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
      $('#search').value = ''; $('#quick-search').value = state.quick; $('#page-size').value = String(state.pageSize);
      render();
      return;
    }
    var keepOpened = state.opened && state.context && context && state.context.role === context.role;
    lastPath = path;
    abort(); cancelChoices(); cancelOtherJobs([]); clearResults();
    state.context = context;
    if (!context) { clearCache(); if (host) host.hidden = true; updateMenuState(); return; }
    if (!host || !host.isConnected) mount();
    host.hidden = false;
    state.sortKey = ''; state.sortDirection = 'desc'; state.quick = ''; state.pendingMode = 'all'; $('#quick-search').value = '';
    state.role = context.role; state.workspace = context.workspace; state.filter = ''; state.selectedProjectId = ''; state.projectIdsText = ''; state.choiceSearch = ''; $('#search').value = ''; $('#project-ids').value = '';
    state.opened = !!keepOpened || location.hash === '#insta360-personal';
    configureScope(context);
    render();
  }
  function configureScope(context) {
    var names = new Map(workspaceRows.map(function (row) { return [id(row.id), String(row.title || row.name || '工作区 #' + row.id)]; }));
    if (context.workspace !== 'all' && !names.has(context.workspace)) names.set(context.workspace, '当前工作区 #' + context.workspace);
    if (state.workspace !== 'all' && !names.has(state.workspace)) names.set(state.workspace, '工作区 #' + state.workspace);
    $('#scope').innerHTML = '<option value="all">全部工作区</option>' + Array.from(names, function (pair) { return '<option value="' + pair[0] + '">' + escape(pair[1]) + '</option>'; }).join('');
    $('#scope').value = state.workspace;
  }
  window.addEventListener('popstate', syncRoute);
  window.addEventListener('ls:locationchange', syncRoute);
  window.addEventListener('resize', syncDrawerLayout);
  // 兼容 SPA 的 pushState，以及管理版脚本已包裹 history 的情况，不改写站点路由函数。
  setInterval(syncRoute, 700);
  syncRoute();
})();