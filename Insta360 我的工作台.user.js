// ==UserScript==
// @name         Insta360 我的工作台（标注员 / 审核员）
// @namespace    https://label.insta360.com/personal-toolbox/
// @version      1.3.0
// @description  只看本人：按日期统计标注、审核工作量，汇总个人返修和返工并直达原生处理流程
// @author       chengzi / Codex
// @match        *://label.insta360.com/*
// @updateURL    https://raw.githubusercontent.com/chengzi-1225/Insta360-chengzi/refs/heads/main/Insta360 我的工作台.user.js
// @downloadURL  https://raw.githubusercontent.com/chengzi-1225/Insta360-chengzi/refs/heads/main/Insta360 我的工作台.user.js
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

  function sumMetric(rows, key) {
    var sum = 0;
    for (var i = 0; i < rows.length; i++) {
      var n = number(rows[i].stats && rows[i].stats[key]);
      if (n == null) return null;
      sum += n;
    }
    return sum;
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
      totals[projectId] = number(row.stats && row.stats.total_regions);
    });
    return totals;
  }

  function workUrl(project, mode) {
    if (!id(project.id) || (!id(project.workspace) && project.workspace !== 'all') || !/^(repair|rework)$/.test(mode)) throw new Error('返修/返工入口无效，请刷新');
    return '/annotation/workspaces/' + encodeURIComponent(project.workspace) + '/projects/' + id(project.id) + '/data?labeling=1&' + mode + '=1';
  }

  // 不依赖请求的 page_size：服务器可能限流到较小页。计数未取完、重复页均不能当成成功。
  async function loadPages(fetchPage, rowsKey, rowKey, options) {
    options = options || {};
    var requestedConcurrency = Number(options.concurrency);
    var concurrency = Number.isInteger(requestedConcurrency) ? Math.max(1, Math.min(3, requestedConcurrency)) : 1;
    var result = [], seen = new Set(), expected = null, firstBody = await fetchPage(1);
    function accept(body) {
      if (!body || !Array.isArray(body[rowsKey])) throw new Error('返回数据格式不支持，请联系脚本维护者');
      var count = number(body.count);
      if (count == null || !Number.isInteger(count)) throw new Error('返回数据格式缺少分页总数');
      if (expected == null) expected = count;
      if (expected !== count) throw new Error('查询期间数据数量发生变化，请刷新重试');
      var rows = body[rowsKey];
      if (!rows.length && result.length < expected) throw new Error('读取不完整：未取得所有分页，请刷新重试');
      rows.forEach(function (row) {
        var key = rowKey(row);
        if (!key || seen.has(key)) throw new Error('读取到重复分页或无效记录，请刷新重试');
        seen.add(key);
        result.push(row);
      });
      if (result.length > expected) throw new Error('分页数量不一致，请刷新重试');
    }
    accept(firstBody);
    if (result.length === expected) return result;
    var pageSize = number(firstBody.page_size);
    if (!pageSize || !Number.isInteger(pageSize)) pageSize = firstBody[rowsKey].length;
    if (!pageSize || !Number.isInteger(pageSize)) throw new Error('读取不完整：未取得有效分页大小，请刷新重试');
    var totalPages = Math.ceil(expected / pageSize);
    if (totalPages > 500) throw new Error('分页数量过多，未完整读取，请缩小查询范围');
    for (var start = 2; start <= totalPages; start += concurrency) {
      var batch = [];
      for (var page = start; page < start + concurrency && page <= totalPages; page++) batch.push(fetchPage(page));
      var bodies = await Promise.all(batch);
      bodies.forEach(accept);
    }
    if (result.length !== expected) throw new Error('读取不完整：未取得所有分页，请刷新重试');
    return result;
  }

  function routeContext(path) {
    var match = path.replace(/\/+$/, '').match(/^\/(annotation|review)(?:\/workspaces\/(all|\d+))?$/);
    if (match) return {workspace: match[2] || 'all', role: match[1] === 'review' ? 'reviewer' : 'annotator'};
    match = path.match(/^\/workspaces\/(all|\d+)\/projects\/?$/);
    return match ? {workspace: match[1], role: 'annotator'} : null;
  }

  var core = {identity: identity, selfRows: selfRows, sumMetric: sumMetric, statsParams: statsParams, personalProjects: personalProjects, projectRegionTotals: projectRegionTotals, workUrl: workUrl, loadPages: loadPages, presetRange: presetRange, activeRange: activeRange, routeContext: routeContext};
  if (typeof module === 'object' && module.exports) module.exports = core;
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__INSTA360_PERSONAL_TOOLBOX__) return;
  window.__INSTA360_PERSONAL_TOOLBOX__ = {version: '1.3.0'};

  var METRICS = {
    annotator: [
      ['submit_total', '新标注提交', '条', '新提交的标注，不包含返修和返工'],
      ['update_total', '返修 / 返工更新', '条', '按平台统计的已更新任务数；与新标注分开核对'],
      ['review_passed', '标注审核通过', '条', '选定时间内被审核通过的标注'],
      ['review_rejected_total', '标注被驳回', '次', '选定时间内被审核驳回的事件次数'],
      ['total_time_min', '有效耗时', '分钟', '使用平台统计的有效耗时，已扣除挂机'],
    ],
    reviewer: [
      ['review_total', '已审核', '次', '通过与驳回的审核动作次数；同一任务重复审核可多次计数'],
      ['review_passed', '审核通过', '次', '审核为通过的动作次数'],
      ['review_rejected', '审核驳回', '次', '审核为驳回的动作次数'],
      ['acceptance_rejected', '验收驳回', '次', '本人审核通过后被验收驳回的次数'],
      ['total_time_min', '有效耗时', '分钟', '使用平台统计的有效耗时，已扣除挂机'],
    ],
  };

  var state = {
    context: null, role: 'annotator', workspace: 'all', range: presetRange('today'), preset: 'today',
    user: null, stats: null, regions: null, pending: null, error: '', statsError: '', regionError: '', pendingError: '',
    busy: false, statsBusy: false, regionBusy: false, pendingBusy: false, opened: false, filter: '', discarded: 0, updated: '', regionUpdated: '', pendingUpdated: '',
  };
  var host, root, controller, runNumber = 0, refreshTimer, lastPath = '';
  var menuItems = new Map();
  function roleTitle(role) { return role === 'reviewer' ? '我的审核' : '我的标注'; }

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
      event.preventDefault(); state.opened = true; refresh(false);
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
    if (root) host.setAttribute('data-menu', String(hasMenu));
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
    updateMenuState();
  }

  function focusEntry() {
    var link;
    menuItems.forEach(function (item) { if (state.context && item.role === state.context.role) link = item.link; });
    if (link) link.focus();
  }
  // 只在当前页面内存中保存，账号/权限改变即清空；日期不影响待处理列表的缓存键。
  var cache = new Map(), cacheAccount = '';
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
  function escape(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) { return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function display(value, key) { return value == null ? '—' : (key === 'total_time_min' ? value.toFixed(1) : value.toLocaleString('zh-CN')); }
  function abort() { runNumber++; if (controller) controller.abort(); clearTimeout(refreshTimer); state.busy = false; state.statsBusy = false; state.regionBusy = false; state.pendingBusy = false; }
  function clearResults() { state.user = null; state.stats = null; state.regions = null; state.pending = null; state.updated = ''; state.regionUpdated = ''; state.pendingUpdated = ''; state.discarded = 0; state.error = ''; state.statsError = ''; state.regionError = ''; state.pendingError = ''; }

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
      if (!response.ok) throw new Error(response.status === 429 ? '查询过于频繁，请稍后刷新' : '查询失败（HTTP ' + response.status + '），请刷新重试');
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

  async function refresh(force) {
    abort(); clearResults();
    if (!state.context || !state.opened || document.hidden) { if (root) render(); return; }
    state.role = state.context.role;
    state.range = activeRange(state.preset, state.range);
    var run = runNumber, role = state.role, workspace = state.workspace, range = state.range.slice();
    controller = new AbortController();
    var signal = controller.signal;
    state.busy = true; state.statsBusy = true; state.regionBusy = true; state.pendingBusy = role === 'annotator'; render();
    try {
      var user = identity(await request('/api/current-user/whoami', {}, signal));
      if (run !== runNumber) return;
      var accountKey = user.id + ':' + user.role;
      if (cacheAccount !== accountKey) { clearCache(); cacheAccount = accountKey; }
      state.user = user;
      if (user.role === 'annotator' && role === 'reviewer') throw new Error('当前账号无法查看审核统计，请返回标注中心');
      var params = statsParams(user.id, role, workspace, range[0], range[1]);
      render();
      var projectParams = {include: 'id,title,workspace,user_repair_count,user_rework_count', page_size: 100};
      if (workspace !== 'all') projectParams.workspaces = workspace;
      var statsKey = JSON.stringify(['stats', accountKey, role, workspace, range]);
      var pendingKey = JSON.stringify(['pending', accountKey, workspace]);
      cancelOtherJobs(role === 'annotator' ? [statsKey, pendingKey] : [statsKey]);
      async function publish(kind, key, ttl, load, confirmIdentity) {
        try {
          var result = await readCached(key, ttl, force === true, async function (jobSignal) {
            var value = await load(jobSignal);
            // 每部分独立核对账号并发布，不让慢的项目列表阻塞产量。
            if (confirmIdentity !== false) await confirmAccount(user, jobSignal);
            return value;
          });
          if (run !== runNumber) return;
          // 新结果在写入缓存前已核对身份；缓存命中则使用本轮刚确认的身份。
          if (kind === 'stats') {
            state.stats = selfRows(result.value, user.id);
            state.discarded = result.value.length - state.stats.length;
            state.updated = updateTime(result.at);
          } else if (kind === 'pending') { state.pending = result.value; state.pendingUpdated = updateTime(result.at); }
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
      var statsJob = publish('stats', statsKey, 30000, function (jobSignal) {
          return loadPages(async function (page) {
            var response = await request('/api/statistics/overview', Object.assign({}, params, {page: page, page_size: 100}), jobSignal);
            if (response.role && response.role !== role) throw new Error('统计角色返回不一致，请刷新');
            return response;
          }, 'users_stats', function (row) { return id(row.id) && id(row.project_id) ? id(row.id) + ':' + id(row.project_id) : ''; });
        });
      var jobs = [statsJob.then(function () {
        if (run !== runNumber || !state.stats || !state.stats.length) return;
        var projectIds = Array.from(new Set(state.stats.map(function (row) { return id(row.project_id); }).filter(Boolean))).sort();
        if (!projectIds.length) return;
        var regionKey = JSON.stringify(['regions', accountKey, workspace, projectIds]);
        state.regionBusy = true; render();
        return publish('region', regionKey, 60000, function (jobSignal) {
          var regionParams = {project_id: projectIds.join(',')};
          if (workspace !== 'all') regionParams.workspace_id = workspace;
          return request('/api/statistics/project-overview', regionParams, jobSignal).then(projectRegionTotals);
        }, false);
      })];
      if (role === 'annotator') jobs.push(publish('pending', pendingKey, 60000, async function (jobSignal) {
          var projects = await loadPages(function (page) { return request('/api/projects', Object.assign({}, projectParams, {page: page}), jobSignal); }, 'results', function (row) { return id(row.id); }, {concurrency: 3});
          return personalProjects(projects, workspace);
        }));
      await Promise.all(jobs);
    } catch (error) {
      if (run !== runNumber || (error && error.name === 'AbortError')) return;
      clearCache(); clearResults(); state.error = error.message || '查询失败，请刷新重试';
    } finally {
      if (run === runNumber) { state.busy = false; state.statsBusy = false; state.regionBusy = false; state.pendingBusy = false; render(); }
    }
  }

  function scheduleRefresh(delay) {
    abort(); clearResults(); render();
    refreshTimer = setTimeout(function () { refresh(false); }, typeof delay === 'number' ? delay : 180);
  }

  function matches(name) { return String(name || '').toLocaleLowerCase().includes(state.filter.trim().toLocaleLowerCase()); }

  function renderStats() {
    var metrics = METRICS[state.role], rows = state.stats && state.stats.filter(function (r) { return matches(r.project_title); });
    var cards = metrics.map(function (m) {
      var n = rows ? sumMetric(rows, m[0]) : null;
      return '<div class="metric" title="' + escape(m[3]) + '"><span>' + m[1] + '</span><div><strong>' + display(n, m[0]) + '</strong><small>' + m[2] + '</small></div></div>';
    }).join('');
    $('#metrics').innerHTML = cards;
    var head = '<thead><tr><th>项目名称</th><th title="项目在平台上的区域总数，不受上方日期筛选影响">区域总数</th>' + metrics.map(function (m) { return '<th title="' + escape(m[3]) + '">' + m[1] + '</th>'; }).join('') + '</tr></thead>';
    if (state.statsError) $('#stats-data').innerHTML = '<p class="error" role="alert">' + escape(state.statsError) + '</p>';
    else if (!rows) $('#stats-data').innerHTML = '<p class="empty">' + (state.statsBusy ? '正在读取本人工作量…' : '点击“查询 / 刷新”读取数据') + '</p>';
    else if (!rows.length) $('#stats-data').innerHTML = '<p class="empty">' + (state.filter ? '没有匹配项目名称的本人记录' : '这个日期范围内，本人暂无' + (state.role === 'annotator' ? '标注' : '审核') + '记录') + '</p>';
    else $('#stats-data').innerHTML = '<div class="table-wrap"><table>' + head + '<tbody>' + rows.map(function (row) {
      var regionCount = state.regions && Object.prototype.hasOwnProperty.call(state.regions, id(row.project_id)) ? state.regions[id(row.project_id)] : null;
      return '<tr><td><span class="project-name">' + escape(row.project_title || ('项目 #' + row.project_id)) + '</span><small class="project-id">#' + escape(row.project_id) + '</small></td><td>' + display(regionCount) + '</td>' + metrics.map(function (m) { return '<td>' + display(number(row.stats && row.stats[m[0]]), m[0]) + '</td>'; }).join('') + '</tr>';
    }).join('') + '</tbody></table></div>';
    $('#stats-note').textContent = state.role === 'annotator'
      ? '新标注提交与返修 / 返工更新分别统计。通过、驳回按平台统计口径；缺失数据用“—”表示。'
      : '审核数量按通过 / 驳回的动作次数统计。同一条数据重复审核可能计多次，与平台“数据统计”一致。';
    if (state.discarded) $('#stats-note').textContent += ' 已排除非本人记录。';
    if (state.regionError) $('#stats-note').textContent += ' 区域总数读取失败：' + state.regionError;
    $('#range-caption').textContent = state.range[0] + ' 至 ' + state.range[1] + ' · 全天' + (rows ? ' · ' + rows.length + ' 个项目' : '');
  }

  function renderPending() {
    $('#pending-section').hidden = state.role !== 'annotator';
    if (state.role !== 'annotator') {
      $('#pending-data').innerHTML = ''; $('#pending-total').textContent = ''; $('#pending-updated').textContent = ''; return;
    }
    $('#pending-updated').textContent = state.pendingUpdated ? '读取于 ' + state.pendingUpdated + ' · 自动查询可复用 60 秒内结果，点击“查询 / 刷新”立即更新' : '';
    if (state.pendingError) { $('#pending-data').innerHTML = '<p class="error" role="alert">' + escape(state.pendingError) + '</p>'; $('#pending-total').textContent = ''; return; }
    if (!state.pending) { $('#pending-data').innerHTML = '<p class="empty">' + (state.pendingBusy ? '正在读取本人待处理项目…' : '点击“查询 / 刷新”读取待处理数据') + '</p>'; $('#pending-total').textContent = ''; return; }
    var items = state.pending.items.filter(function (p) { return matches(p.name); });
    var repair = 0, rework = 0;
    items.forEach(function (p) { repair += p.repair || 0; rework += p.rework || 0; });
    $('#pending-total').textContent = items.length + ' 个项目 · 返修 ' + repair + ' · 返工 ' + rework + (state.pending.unknown ? '（部分计数未取得）' : '');
    var warning = state.pending.unknown ? '<p class="notice">有 ' + state.pending.unknown + ' 个项目未返回完整个人计数，当前合计仅包含已取得的数据。请刷新或查看原项目卡片。</p>' : '';
    if (!items.length) {
      $('#pending-data').innerHTML = warning + '<p class="empty">' + (state.filter ? '没有匹配的个人待处理项目' : state.pending.unknown ? '已取得个人计数的项目中暂无待处理数据' : '当前范围内，本人暂无待返修或待返工数据') + '</p>';
      return;
    }
    $('#pending-data').innerHTML = warning + '<div class="pending-list">' + items.map(function (p) {
      return '<article class="pending-row"><div class="pending-project"><strong>' + escape(p.name) + '</strong><small>#' + p.id + '</small></div>' + ['repair', 'rework'].map(function (mode) {
        var n = p[mode], label = mode === 'repair' ? '返修' : '返工';
        return '<div class="lane ' + mode + '"><span>待' + label + ' <b>' + display(n) + '</b></span><button type="button" data-work="' + mode + '" data-project="' + p.id + '" ' + (!(n > 0) ? 'disabled' : '') + '>前往' + label + ' <span aria-hidden="true">↗</span></button></div>';
      }).join('') + '</article>';
    }).join('') + '</div>';
  }

  function render() {
    if (!root) return;
    $('#panel').hidden = !state.opened;
    updateMenuState();
    $('#work-title').textContent = roleTitle(state.role);
    $('#panel').setAttribute('aria-label', roleTitle(state.role));
    $('#center-label').textContent = state.role === 'reviewer' ? '审核中心 · 本人审核数据' : '标注中心 · 本人标注数据';
    $('#stats-title').textContent = state.role === 'reviewer' ? '我的审核产量' : '我的标注产量';
    $('#account').textContent = state.user ? state.user.name + ' · ID ' + state.user.id : state.busy ? '正在确认当前账号…' : '仅显示当前登录账号的数据';
    $('#start').value = state.range[0]; $('#end').value = state.range[1];
    $('#query').textContent = state.busy ? '重新查询' : '查询 / 刷新';
    $('#error').textContent = state.error; $('#error').hidden = !state.error;
    $('#updated').textContent = state.statsBusy ? '正在查询产量…' : state.updated ? '读取于 ' + state.updated + ' · 自动查询可复用 30 秒内结果' : '';
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
      '<div class="filter-line dates"><label>开始日期 <input id="start" type="date" aria-label="开始日期"></label><span class="date-separator">至</span><label>结束日期 <input id="end" type="date" aria-label="结束日期"></label><button id="query" class="primary" type="button">查询 / 刷新</button><input id="search" type="search" placeholder="筛选项目名称" aria-label="筛选项目名称"></div></div>' +
      '<p id="error" class="error" role="alert" hidden></p><div class="section-title"><h2 id="stats-title"></h2><span id="updated" aria-live="polite"></span></div><p id="range-caption" class="caption"></p><div id="metrics" class="metrics"></div><div id="stats-data" aria-live="polite"></div><p id="stats-note" class="note"></p>' +
      '<section id="pending-section" class="pending-section" aria-label="我的返修和返工"><div class="section-title"><h2>我的返修 / 返工</h2><span id="pending-total"></span></div><p class="note">当前仍需本人处理的标注数据，包含以前遗留的返修 / 返工，不受上方日期影响。个人计数与标注中心卡片一致。</p><div id="pending-data" aria-live="polite"></div><p id="pending-updated" class="caption"></p></section>' +
      '<footer>只统计当前账号 · 不提供其他成员切换</footer></div></section>';
    document.body.appendChild(host);
    $('#close').addEventListener('click', function () { state.opened = false; abort(); clearResults(); render(); focusEntry(); });
    $('#query').addEventListener('click', function () { refresh(true); });
    root.querySelectorAll('[data-preset]').forEach(function (b) { b.addEventListener('click', function () { state.preset = b.dataset.preset; state.range = presetRange(state.preset); scheduleRefresh(); }); });
    ['start','end'].forEach(function (key, index) { $('#' + key).addEventListener('change', function () { state.range[index] = this.value; state.preset = ''; scheduleRefresh(); }); });
    $('#scope').addEventListener('change', function () { state.workspace = this.value; cancelOtherJobs([]); scheduleRefresh(); });
    $('#search').addEventListener('input', function () { state.filter = this.value; renderStats(); renderPending(); });
    root.addEventListener('keydown', function (event) { if (event.key === 'Escape' && state.opened) $('#close').click(); });
    root.addEventListener('click', function (event) { var button = event.target.closest('[data-work]'); if (button) goToWork(button.dataset.project, button.dataset.work, button); });
  }

  var CSS = `
    :host{all:initial;--ink:#182c46;--muted:#69798e;--line:#e4eaf2;--blue:#1767c7;--soft:#f4f7fb;--red:#b83a48;--amber:#986315;font:13px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;color:var(--ink)}
    :host([hidden]){display:none!important}*{box-sizing:border-box}[hidden]{display:none!important}button,input,select{font:inherit}button{cursor:pointer}button:disabled{cursor:default;opacity:.42}button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--blue);outline-offset:3px}button{border:1px solid var(--line);background:#fff;color:var(--ink);border-radius:6px;padding:6px 12px}button:hover:not(:disabled){background:var(--soft)}
    #panel{position:fixed;z-index:1000003;top:72px;right:24px;bottom:86px;width:min(990px,calc(100vw - 48px));background:#fff;border:1px solid #dae2ed;border-radius:14px;box-shadow:0 14px 65px #182c462b;display:flex;flex-direction:column;overflow:hidden}
    :host([data-menu=true]) #panel{bottom:24px}
    header{display:flex;justify-content:space-between;align-items:flex-start;padding:22px 26px 17px;border-bottom:1px solid var(--line);background:#fafcff}h1,h2,p{margin:0}h1{font-size:24px;line-height:1.35;font-weight:650;letter-spacing:.5px;margin:4px 0}h2{font-size:16px;font-weight:650}.eyebrow{font-size:10px;letter-spacing:1.1px;font-weight:650;color:var(--blue)}#account{color:var(--muted);font-size:12px}#close{border:0;background:transparent;font-size:25px;line-height:1;padding:3px 5px;color:var(--muted)}
    .scroll{overflow:auto;padding:20px 26px 0}.filters{padding-bottom:19px;border-bottom:1px solid var(--line)}.filter-line{display:flex;gap:12px;align-items:center;flex-wrap:wrap}#center-label{color:var(--muted);font-size:12px}.scope-label{margin-left:auto;display:flex;gap:8px;align-items:center;color:var(--muted)}select{max-width:245px;border:1px solid var(--line);border-radius:6px;color:var(--ink);padding:7px 8px;background:#fff}
    .presets{display:flex;gap:6px;margin:16px 0 12px}.presets button{padding:3px 12px;font-size:12px}.presets button[aria-pressed=true]{background:#edf4fd;border-color:#bcd5f4;color:var(--blue)}.dates{gap:10px}.dates label{display:flex;flex-direction:column;gap:3px;font-size:10px;color:var(--muted)}input{min-width:0;padding:7px 8px;border:1px solid #d4deea;border-radius:5px;background:#fff;color:var(--ink);font-size:12px}input[type=date]{width:146px}.date-separator{margin-top:18px;color:var(--muted)}#query{margin-top:18px}button.primary{background:var(--blue);color:white;border-color:var(--blue)}button.primary:hover{background:#145aaf}#search{margin-left:auto;margin-top:18px;width:184px}
    .section-title{display:flex;align-items:baseline;gap:10px;justify-content:space-between;margin-top:21px}.section-title>span{font-size:11px;color:var(--muted)}.caption{font-size:11px;color:var(--muted);margin:3px 0 12px}.metrics{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px;margin-bottom:15px}.metric{padding:13px 12px;background:var(--soft);border-radius:7px;border-top:2px solid #d9e6f6}.metric:first-child{border-top-color:var(--blue)}.metric>span{font-size:11px;color:var(--muted)}.metric>div{display:flex;gap:5px;align-items:baseline;margin-top:5px}.metric strong{font:600 26px/1.35 "SFMono-Regular",Consolas,monospace;letter-spacing:-1px;color:var(--ink)}.metric small{font-size:10px;color:var(--muted)}
    .table-wrap{max-height:275px;overflow:auto;border:1px solid var(--line);border-radius:7px}table{border-collapse:collapse;width:100%;font-size:12px}th,td{padding:11px 13px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}th{background:#f8fafc;font-size:10px;color:var(--muted);font-weight:500;position:sticky;top:0}td:first-child,th:first-child{text-align:left;min-width:180px}tr:last-child td{border-bottom:0}td:first-child{white-space:normal}.project-name{max-width:300px;display:block;overflow-wrap:anywhere}.project-id{color:#8b99aa;font-size:10px}tbody tr:hover{background:#fbfcfe}.note{font-size:11px;color:var(--muted);margin:9px 0 0;line-height:1.8}.empty{padding:25px 12px;text-align:center;color:var(--muted);background:#fafbfd;border:1px dashed var(--line);border-radius:7px;font-size:12px}
    .pending-section{border-top:1px solid var(--line);margin-top:22px;padding-bottom:8px}.pending-section .note{margin-bottom:12px}.pending-list{border:1px solid var(--line);border-radius:8px;overflow:hidden}.pending-row{display:grid;grid-template-columns:minmax(0,1fr) 182px 182px;align-items:center;padding:14px 16px;gap:15px;border-bottom:1px solid var(--line)}.pending-row:last-child{border-bottom:0}.pending-project strong{font-size:13px;font-weight:600;overflow-wrap:anywhere;display:block}.pending-project small{font-size:10px;color:var(--muted)}.lane{display:flex;gap:8px;align-items:center;justify-content:space-between}.lane>span{font-size:11px;white-space:nowrap}.lane b{font:600 15px Consolas,monospace;margin-left:2px}.lane button{font-size:11px;padding:4px 9px;white-space:nowrap}.repair{color:var(--red)}.repair button{color:var(--red);border-color:#f0cdd2;background:#fff9fa}.rework{color:var(--amber)}.rework button{color:var(--amber);border-color:#eddcc0;background:#fffcf6}
    .error,.notice{padding:11px 13px;border-radius:6px;font-size:12px;line-height:1.8;margin:12px 0}.error{color:#a62d3b;background:#fff1f3;border:1px solid #f3cbd1}.notice{color:#805c16;background:#fff9e9;border:1px solid #eee0b9}footer{border-top:1px solid var(--line);padding:14px 0;margin-top:18px;font-size:10px;color:#8b99aa;text-align:right}
    @media(max-width:760px){#panel{top:20px;right:12px;bottom:80px;width:calc(100vw - 24px)}:host([data-menu=true]) #panel{bottom:20px}header{padding:17px 18px}.scroll{padding:16px 18px 0}.metrics{grid-template-columns:repeat(3,minmax(0,1fr))}.scope-label{margin-left:0}.pending-row{grid-template-columns:minmax(0,1fr);gap:7px}.lane{justify-content:flex-start;gap:16px}.lane>span{min-width:85px}#search{margin-left:0;width:180px}.section-title{flex-wrap:wrap;gap:4px}.metric strong{font-size:23px}}@media(max-width:420px){.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}input[type=date]{width:132px}.dates{gap:6px}#search{width:100%;margin-top:7px}}
  `;

  function syncRoute() {
    if (!document.body) return;
    syncMenu();
    var path = location.pathname;
    if (path === lastPath && host && host.isConnected) return;
    var context = routeContext(path);
    lastPath = path;
    abort(); cancelOtherJobs([]); clearResults();
    state.context = context;
    if (!context) { clearCache(); if (host) host.hidden = true; updateMenuState(); return; }
    if (!host || !host.isConnected) mount();
    host.hidden = false;
    state.role = context.role; state.workspace = context.workspace; state.filter = ''; $('#search').value = '';
    state.opened = location.hash === '#insta360-personal';
    $('#scope').innerHTML = (context.workspace !== 'all' ? '<option value="' + context.workspace + '">当前工作区 #' + context.workspace + '</option>' : '') + '<option value="all">全部可访问项目</option>';
    $('#scope').value = state.workspace;
    render(); refresh();
  }
  window.addEventListener('popstate', syncRoute);
  window.addEventListener('ls:locationchange', syncRoute);
  window.addEventListener('focus', function () { if (state.context && state.opened && !document.hidden) scheduleRefresh(80); });
  document.addEventListener('visibilitychange', function () {
    if (!state.context || !state.opened) return;
    if (document.hidden) { abort(); clearResults(); render(); }
    else scheduleRefresh(80);
  });
  // 兼容 SPA 的 pushState，以及管理版脚本已包裹 history 的情况，不改写站点路由函数。
  setInterval(syncRoute, 700);
  syncRoute();
})();
