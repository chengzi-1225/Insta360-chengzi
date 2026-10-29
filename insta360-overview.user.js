// ==UserScript==
// @name         Insta360 项目概览工具箱
// @namespace    https://label.insta360.com/
// @author       chengzi
// @version      4.6.5
// @description  项目概览与跳过数据统计、精简原生卡片、项目权限、成员快速分配与卡片隐藏
// @match        *://label.insta360.com/*
// @updateURL    https://raw.githubusercontent.com/chengzi-1225/Insta360-chengzi/refs/heads/main/insta360-overview.user.js
// @downloadURL  https://raw.githubusercontent.com/chengzi-1225/Insta360-chengzi/refs/heads/main/insta360-overview.user.js
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

/* MODULE: core */
(function () {
  'use strict';

  if (window.__INSTA360_SUITE__) return;

  var modules = new Map();
  var toolbarExtensions = new Map();
  var projectContextActions = new Map();
  var projectContextMenu = null;
  var FEATURE_SETTINGS_KEY = 'insta360-overview-features-v1';
  var routeTimer = null;
  var toastTimer = null;

  function loadFeatureSettings() {
    try {
      var stored = JSON.parse(localStorage.getItem(FEATURE_SETTINGS_KEY) || '{}');
      return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
    } catch (error) {
      return {};
    }
  }

  var featureSettings = loadFeatureSettings();

  function featureEnabled(name) {
    return featureSettings[name] !== false;
  }

  function setFeatureEnabled(name, value) {
    featureSettings[name] = value !== false;
    try { localStorage.setItem(FEATURE_SETTINGS_KEY, JSON.stringify(featureSettings)); } catch (error) {}
    window.dispatchEvent(new CustomEvent('insta360-suite:feature-change', {
      detail: { name: name, enabled: featureSettings[name] },
    }));
    sync();
  }

  function listPage() {
    return /^\/workspaces\/[^/]+\/projects\/?$/.test(location.pathname);
  }

  function workspaceId() {
    var match = location.pathname.match(/^\/workspaces\/([^/]+)/);
    return match ? match[1] : null;
  }

  function csrfToken() {
    var match = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
    if (match) return decodeURIComponent(match[1]);
    var meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.content : '';
  }

  async function api(path, options) {
    options = options || {};
    var headers = Object.assign({}, options.headers || {});
    if (options.body != null && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    var csrf = csrfToken();
    if (csrf) headers['X-CSRFToken'] = csrf;
    var response = await fetch(path, {
      method: options.method || 'GET',
      credentials: 'include',
      headers: headers,
      body: options.body == null || typeof options.body === 'string' ? options.body : JSON.stringify(options.body),
    });
    var text = await response.text();
    if (!response.ok) throw new Error('HTTP ' + response.status + (text ? ' ' + text.slice(0, 180) : ''));
    if (!text) return null;
    try { return JSON.parse(text); } catch (e) { return text; }
  }

  function projectId(card) {
    if (!card) return '';
    if (card.dataset && (card.dataset.projectId || card.dataset.id)) {
      return String(card.dataset.projectId || card.dataset.id);
    }
    var dataset = card.dataset || {};
    for (var key in dataset) {
      if (!Object.prototype.hasOwnProperty.call(dataset, key)) continue;
      if (/project/i.test(key) && /^\d+$/.test(String(dataset[key]))) return String(dataset[key]);
    }
    var links = [];
    var wrappingLink = card.closest && card.closest('a[href]');
    if (wrappingLink) links.push(wrappingLink);
    if (card.matches && card.matches('a[href]') && links.indexOf(card) === -1) links.push(card);
    if (card.querySelectorAll) links = links.concat([].slice.call(card.querySelectorAll('a[href]')));
    for (var i = 0; i < links.length; i++) {
      var match = String(links[i].getAttribute('href') || '').match(/\/projects\/(\d+)/);
      if (match) return match[1];
    }
    return '';
  }

  function projectName(card) {
    if (!card) return '';
    var selectors = ['.ls-project-card__title', '.ls-project-card__name', '[class*="project-card__title"]', 'h2', 'h3', 'h4'];
    for (var i = 0; i < selectors.length; i++) {
      var element = card.querySelector(selectors[i]);
      var text = element && (element.textContent || '').replace(/\s+/g, ' ').trim();
      if (text) return text;
    }
    return '项目 #' + projectId(card);
  }

  function addProjectContextAction(key, options) {
    projectContextActions.set(key, options || {});
  }

  function removeProjectContextAction(key) {
    projectContextActions.delete(key);
    if (!projectContextActions.size) closeProjectContextMenu();
  }

  function closeProjectContextMenu() {
    if (projectContextMenu) projectContextMenu.hidden = true;
  }

  function contextChildren(options, project) {
    if (!options || !options.children) return [];
    var children = typeof options.children === 'function' ? options.children(project) : options.children;
    return Array.isArray(children) ? children.filter(Boolean) : [];
  }

  function selectedContextKeys(button) {
    var submenu = button && button.closest('.ovw-suite-project-submenu');
    if (!submenu) return [];
    return [].slice.call(submenu.querySelectorAll('[data-context-selectable][aria-checked="true"]')).map(function (selected) {
      return selected.getAttribute('data-context-child');
    });
  }

  function syncContextSubmitButtons(submenu) {
    if (!submenu) return;
    var hasSelection = Boolean(submenu.querySelector('[data-context-selectable][aria-checked="true"]'));
    submenu.querySelectorAll('[data-context-submit]').forEach(function (button) {
      var allowEmpty = button.getAttribute('data-context-allow-empty') === 'true';
      var baseDisabled = button.getAttribute('data-context-base-disabled') === 'true';
      button.disabled = baseDisabled || (!allowEmpty && !hasSelection);
    });
  }

  function ensureProjectContextMenu() {
    if (projectContextMenu && document.body.contains(projectContextMenu)) return;
    projectContextMenu = document.createElement('div');
    projectContextMenu.className = 'ovw-suite-project-menu';
    projectContextMenu.hidden = true;
    projectContextMenu.addEventListener('click', function (event) {
      var button = event.target.closest('[data-context-action]');
      if (!button || !projectContextMenu.__project) return;
      var action = projectContextActions.get(button.dataset.contextAction);
      var project = projectContextMenu.__project;
      var children = contextChildren(action, project);
      var childKey = button.getAttribute('data-context-child');
      if (children.length && !childKey) {
        var parent = button.closest('.ovw-suite-project-menu-item');
        if (parent) parent.classList.toggle('is-expanded');
        return;
      }
      var selected = childKey
        ? children.find(function (child) { return String(child.key) === childKey; })
        : action;
      if (selected && selected.selectable) {
        var checked = button.getAttribute('aria-checked') === 'true';
        button.setAttribute('aria-checked', checked ? 'false' : 'true');
        button.classList.toggle('is-selected', !checked);
        syncContextSubmitButtons(button.closest('.ovw-suite-project-submenu'));
        return;
      }
      var selectedKeys = selected && selected.submitSelection ? selectedContextKeys(button) : [];
      if (selected && selected.submitSelection && !selected.allowEmptySelection && !selectedKeys.length) return;
      closeProjectContextMenu();
      if (selected && typeof selected.onClick === 'function') selected.onClick(project, event, selectedKeys);
    });
    document.body.appendChild(projectContextMenu);
  }

  function openProjectContextMenu(event, card) {
    var project = { id: projectId(card), name: projectName(card), card: card };
    if (!project.id) return;
    var actions = [];
    projectContextActions.forEach(function (options, key) {
      if (!options || (typeof options.when === 'function' && !options.when(project))) return;
      actions.push({ key: key, options: options });
    });
    if (!actions.length) return;
    event.preventDefault();
    event.stopPropagation();
    ensureProjectContextMenu();
    projectContextMenu.innerHTML = '';
    actions.forEach(function (item) {
      var button = document.createElement('button');
      var children = contextChildren(item.options, project);
      button.type = 'button';
      button.dataset.contextAction = item.key;
      button.textContent = item.options.label || item.key;
      if (!children.length) {
        projectContextMenu.appendChild(button);
        return;
      }
      var wrapper = document.createElement('div');
      wrapper.className = 'ovw-suite-project-menu-item has-children';
      if (event.clientX > window.innerWidth / 2) wrapper.classList.add('opens-left');
      button.className = 'ovw-suite-project-menu-parent';
      button.setAttribute('aria-haspopup', 'menu');
      var arrow = document.createElement('span');
      arrow.textContent = '›';
      button.appendChild(arrow);
      wrapper.appendChild(button);
      var submenu = document.createElement('div');
      submenu.className = 'ovw-suite-project-submenu';
      submenu.setAttribute('role', 'menu');
      children.forEach(function (child) {
        var childButton = document.createElement('button');
        childButton.type = 'button';
        childButton.dataset.contextAction = item.key;
        childButton.setAttribute('data-context-child', String(child.key));
        childButton.textContent = child.label || child.key;
        if (child.selectable) {
          var selected = child.selected !== false;
          childButton.setAttribute('data-context-selectable', 'true');
          childButton.setAttribute('role', 'menuitemcheckbox');
          childButton.setAttribute('aria-checked', selected ? 'true' : 'false');
          childButton.className = 'ovw-suite-project-selectable' + (selected ? ' is-selected' : '');
        } else {
          childButton.setAttribute('role', 'menuitem');
        }
        if (child.submitSelection) {
          childButton.setAttribute('data-context-submit', 'true');
          childButton.classList.add('ovw-suite-project-submit');
          if (child.allowEmptySelection) childButton.setAttribute('data-context-allow-empty', 'true');
        }
        if (child.disabled) {
          childButton.disabled = true;
          childButton.setAttribute('data-context-base-disabled', 'true');
        } else {
          childButton.setAttribute('data-context-base-disabled', 'false');
        }
        submenu.appendChild(childButton);
      });
      syncContextSubmitButtons(submenu);
      wrapper.appendChild(submenu);
      projectContextMenu.appendChild(wrapper);
      if (typeof item.options.onSubmenuOpen === 'function') {
        try {
          var hydration = item.options.onSubmenuOpen(project, submenu);
          if (hydration && typeof hydration.catch === 'function') {
            hydration.catch(function (error) { console.error('[Insta360 Suite] submenu load failed:', item.key, error); });
          }
        } catch (error) {
          console.error('[Insta360 Suite] submenu load failed:', item.key, error);
        }
      }
    });
    projectContextMenu.__project = project;
    projectContextMenu.hidden = false;
    projectContextMenu.style.left = Math.max(8, Math.min(event.clientX, window.innerWidth - projectContextMenu.offsetWidth - 8)) + 'px';
    projectContextMenu.style.top = Math.max(8, Math.min(event.clientY, window.innerHeight - projectContextMenu.offsetHeight - 8)) + 'px';
  }

  function findSearchInput() {
    var selectors = [
      'input[type="search"]',
      'input[placeholder*="搜索"]',
      'input[placeholder*="项目名称"]',
      'input[placeholder*="search" i]',
    ];
    for (var s = 0; s < selectors.length; s++) {
      var list = document.querySelectorAll(selectors[s]);
      for (var i = 0; i < list.length; i++) {
        if (list[i].offsetParent !== null || list[i].getClientRects().length) return list[i];
      }
    }
    return null;
  }

  function overviewToolbar() {
    return document.querySelector('.ovw-toolbar');
  }

  function addToolbarButton(key, options) {
    toolbarExtensions.set(key, options);
    return mountToolbarButton(key);
  }

  function removeToolbarButton(key) {
    toolbarExtensions.delete(key);
    document.querySelectorAll('[data-suite-tool="' + key + '"]').forEach(function (button) {
      if (button.parentNode) button.parentNode.removeChild(button);
    });
  }

  function mountToolbarButton(key) {
    var options = toolbarExtensions.get(key);
    if (!options || !listPage()) return null;
    var toolbar = overviewToolbar();
    if (!toolbar) return null;
    var selector = '[data-suite-tool="' + key + '"]';
    var existing = toolbar.querySelector(selector);
    if (existing) {
      if (options.badge) options.badge(existing);
      return existing;
    }
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'ovw-toolbar__btn ovw-suite-tool';
    button.dataset.suiteTool = key;
    button.title = options.title || options.label || key;
    button.innerHTML = (options.icon || '') + '<span>' + escapeHtml(options.label || key) + '</span>' +
      (options.badge ? '<span class="ovw-suite-tool__badge" hidden></span>' : '');
    button.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      options.onClick(button, event);
    });
    var panel = toolbar.querySelector('.ovw-toolbar__panel');
    toolbar.insertBefore(button, panel || null);
    if (options.badge) options.badge(button);
    return button;
  }

  function refreshToolbarButtons() {
    toolbarExtensions.forEach(function (_options, key) { mountToolbarButton(key); });
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (character) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character];
    });
  }

  function toast(message, type) {
    var element = document.getElementById('ovw-suite-toast');
    if (!element) {
      element = document.createElement('div');
      element.id = 'ovw-suite-toast';
      document.body.appendChild(element);
    }
    element.className = 'ovw-suite-toast is-' + (type || 'info');
    element.textContent = message;
    element.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { element.hidden = true; }, 2600);
  }

  function injectCoreStyle() {
    if (document.getElementById('ovw-suite-core-style')) return;
    var style = document.createElement('style');
    style.id = 'ovw-suite-core-style';
    style.textContent = [
      '.ovw-suite-tool{position:relative}',
      '.ovw-suite-tool__badge{display:inline-flex;align-items:center;justify-content:center;min-width:15px;height:15px;padding:0 4px;border-radius:8px;background:#2563eb;color:#fff;font-size:9px;font-weight:700}',
      '.ovw-suite-tool__badge[hidden]{display:none}',
      '.ovw-suite-toast{position:fixed;top:18px;left:50%;transform:translateX(-50%);z-index:2147483647;max-width:min(560px,calc(100vw - 32px));padding:9px 14px;border:1px solid #dbe3ed;border-radius:7px;background:#fff;color:#334155;box-shadow:0 10px 30px rgba(15,23,42,.18);font:12.5px/1.4 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}',
      '.ovw-suite-toast.is-success{border-color:#86efac;background:#f0fdf4;color:#15803d}',
      '.ovw-suite-toast.is-error{border-color:#fca5a5;background:#fef2f2;color:#b91c1c}',
      '.ovw-suite-toast[hidden]{display:none}',
      '.ovw-suite-project-menu{position:fixed;z-index:2147483646;display:flex;flex-direction:column;min-width:150px;padding:4px;border:1px solid #dfe4ea;border-radius:6px;background:#fff;box-shadow:0 12px 30px rgba(15,23,42,.2);font:12.5px/1.4 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}',
      '.ovw-suite-project-menu[hidden]{display:none}',
      '.ovw-suite-project-menu button{padding:7px 10px;border:0;border-radius:4px;background:transparent;text-align:left;color:#334155;cursor:pointer}',
      '.ovw-suite-project-menu button:hover{background:#eff6ff;color:#1d4ed8}',
      '.ovw-suite-project-menu button:disabled{opacity:.55;cursor:wait}',
      '.ovw-suite-project-menu-item{position:relative}.ovw-suite-project-menu-item>button{display:flex;align-items:center;justify-content:space-between;width:100%;gap:18px}.ovw-suite-project-menu-parent span{font-size:16px;line-height:1;color:#94a3b8}',
      '.ovw-suite-project-submenu{position:absolute;display:none;top:-4px;left:calc(100% + 4px);min-width:170px;padding:4px;border:1px solid #dfe4ea;border-radius:6px;background:#fff;box-shadow:0 12px 30px rgba(15,23,42,.2)}',
      '.ovw-suite-project-submenu button{display:flex;align-items:center;width:100%}.ovw-suite-project-menu-item:hover>.ovw-suite-project-submenu,.ovw-suite-project-menu-item:focus-within>.ovw-suite-project-submenu,.ovw-suite-project-menu-item.is-expanded>.ovw-suite-project-submenu{display:block}',
      '.ovw-suite-project-menu-item.opens-left>.ovw-suite-project-submenu{right:calc(100% + 4px);left:auto}',
      '.ovw-suite-project-selectable{gap:8px}.ovw-suite-project-selectable:before{display:inline-flex;flex:0 0 15px;align-items:center;justify-content:center;box-sizing:border-box;width:15px;height:15px;border:1px solid #cbd5e1;border-radius:3px;background:#fff;color:#fff;font-size:11px;line-height:1;content:""}.ovw-suite-project-selectable[aria-checked="true"]:before{border-color:#2563eb;background:#2563eb;content:"✓"}',
      '.ovw-suite-project-submit{justify-content:center;margin-top:4px;background:#2563eb!important;color:#fff!important;font-weight:650}.ovw-suite-project-submit:hover{background:#1d4ed8!important;color:#fff!important}.ovw-suite-project-submit:disabled{background:#e2e8f0!important;color:#94a3b8!important;cursor:not-allowed}',
    ].join('');
    document.head.appendChild(style);
  }

  function register(name, module) {
    modules.set(name, module);
    syncModule(name, module);
  }

  function syncModule(name, module) {
    try {
      var shouldRun = !module.match || module.match(location);
      if (shouldRun) {
        if (!module.__active && module.mount) module.mount();
        module.__active = true;
        if (module.scan) module.scan();
      } else if (module.__active) {
        if (module.unmount) module.unmount();
        module.__active = false;
      }
    } catch (error) {
      console.error('[Insta360 Suite] module failed:', name, error);
    }
  }

  function sync() {
    injectCoreStyle();
    modules.forEach(function (module, name) { syncModule(name, module); });
    refreshToolbarButtons();
  }

  function scheduleSync() {
    clearTimeout(routeTimer);
    routeTimer = setTimeout(function () {
      window.dispatchEvent(new CustomEvent('insta360-suite:route'));
      sync();
    }, 0);
  }

  ['pushState', 'replaceState'].forEach(function (method) {
    var original = history[method];
    if (typeof original !== 'function' || original.__insta360SuiteWrapped) return;
    var wrapped = function () {
      var result = original.apply(this, arguments);
      scheduleSync();
      return result;
    };
    wrapped.__insta360SuiteWrapped = true;
    history[method] = wrapped;
  });
  window.addEventListener('popstate', scheduleSync);
  window.addEventListener('hashchange', scheduleSync);
  window.addEventListener('insta360-suite:overview-toolbar', refreshToolbarButtons);
  document.addEventListener('contextmenu', function (event) {
    if (!listPage() || !event.target || !event.target.closest) return;
    var card = event.target.closest('.ls-project-card, article[class*="project-card"], [data-project-id]');
    if (card) openProjectContextMenu(event, card);
  });
  document.addEventListener('click', function (event) {
    if (!projectContextMenu || projectContextMenu.hidden || projectContextMenu.contains(event.target)) return;
    closeProjectContextMenu();
  }, true);
  window.addEventListener('resize', closeProjectContextMenu);
  window.addEventListener('scroll', closeProjectContextMenu, true);

  window.__INSTA360_SUITE__ = {
    addProjectContextAction: addProjectContextAction,
    addToolbarButton: addToolbarButton,
    api: api,
    csrfToken: csrfToken,
    escapeHtml: escapeHtml,
    featureEnabled: featureEnabled,
    findSearchInput: findSearchInput,
    listPage: listPage,
    overviewToolbar: overviewToolbar,
    projectId: projectId,
    projectName: projectName,
    refreshToolbarButtons: refreshToolbarButtons,
    register: register,
    removeProjectContextAction: removeProjectContextAction,
    removeToolbarButton: removeToolbarButton,
    scheduleSync: scheduleSync,
    setFeatureEnabled: setFeatureEnabled,
    toast: toast,
    workspaceId: workspaceId,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', sync, { once: true });
  else sync();
})();

/* MODULE: overview v3.11.8 */

(function () {
  'use strict';

  function isListPage() {
    var path = location.pathname.replace(/\/+$/, '') || '/';
    if (!/^\/workspaces\/[^/]+\/projects$/.test(path)) return false;
    var page = new URLSearchParams(location.search).get('page');
    return page != null && page !== '';
  }
  function isDataPage() {
    return /^\/workspaces\/[^/]+\/projects\/\d+\/data(?:\/|$)/.test(location.pathname);
  }

  var DEBUG = false;
  var PENDING_KEY = 'ovw_pending_filter';

  var CONFIG = {
    cardSelector: '.ls-project-card',
    infoSelector: '.ls-project-card__info',
    cacheTtlMs: 60 * 1000,
    projectPath: '/api/projects',
    taskPath: '/api/dm/tasks',
    userPath: '/api/users',
    settingsKey: 'insta360-overview-fields-v2',
    fastMode: true,
    detailConcurrency: 2,
    taskPageSizePreferred: 500,
    taskPageSize: 100,
    taskPageConcurrency: 20,
    taskGlobalConcurrency: 8,
    taskUnknownPageConcurrency: 4,
    taskPageRetries: 2,
    taskRowsCacheTtlMs: 60 * 1000,
    defaultPendingWhenNoStatus: true,
    mountDelayMs: 120,
    selfCheckIntervalMs: 600,
    autoApplyFilter: true,
    manualModeOnAllWorkspace: true,
    allWorkspaceCardLimit: 50,
    repairPeopleKeys: [
      'annotators', 'annotator', 'updated_by', 'locked_by', 'reviewers',
      'annotator_id', 'assignee', 'assigned_to', 'user', 'username', 'user_id',
      'creator', 'modifier', 'operator', 'last_annotator', 'completed_by',
      'worker', 'assignee_id', 'created_by'
    ],
    repairConcurrency: 6,
    repairCacheTtlMs: 30 * 1000,
    reworkTotalCacheTtlMs: 60 * 1000,
    showTaskIdLimit: 5
  };

  var STATS_ON_KEY = 'insta360-overview-stats-on-v1';
  var STATS_PROJECTS_KEY = 'insta360-overview-stats-projects-v1';
  var HIDE_ALL_KEY = 'insta360-overview-hide-all-v1';
  var SELECTED_KEY = 'insta360-overview-selected-v1';
  var ONLY_SELECTED_KEY = 'insta360-overview-only-selected-v1';
  var TASK_ANNOTATOR_MAP_KEY = 'insta360-overview-task-annotator-map-v1';
  var REPAIR_TOOL_VISIBLE_KEY = 'insta360-overview-repair-tool-visible-v1';

  function repairToolVisibleFromStoredValue(value) { return value !== '0'; }
  function loadRepairToolVisible() {
    try { return repairToolVisibleFromStoredValue(localStorage.getItem(REPAIR_TOOL_VISIBLE_KEY)); }
    catch (e) { return true; }
  }
  function saveRepairToolVisible(value) {
    try { localStorage.setItem(REPAIR_TOOL_VISIBLE_KEY, value ? '1' : '0'); } catch (e) {}
  }
  var repairToolVisible = loadRepairToolVisible();

  var USER_ID_NAME_MAP = {
    '4': '杰', '5': '敏', '6': '王小芳-已停用', '7': '文禄艳', '8': '何薇',
    '9': '陈佳豪', '10': '符雨嘉', '11': '焦蕾', '12': '陈勃霖', '13': '刘子衍', '14': '钱涛',
    '16': '吴春梅', '17': 'xiaoming', '18': '王小芳',
    '21': '沈玲', '22': '雪儿', '23': '梁林会', '24': '丁山周', '25': '刘瑞',
    '28': '李艳丽', '30': '张方荣', '31': '文小艳', '34': '唐玫', '35': 'mohuanjun', '36': '谌丽娟',
    '39': '李思颖', '40': '朱贵婧', '41': '刘素', '48': '张川宁', '50': '谌欢',
    '52': '石胜林', '53': '张景涛', '54': '陈超浪', '55': '戴天洋', '56': '易赟',
    '57': '刘爽如', '58': '谢静秀', '59': '刘海青', '60': '蒋静', '61': '许洋鑫',
    '62': '林天霖', '63': '李华琪', '64': '邓雪姣', '66': '王煜淞',
    '69': '曾淦雄', '70': '桂良要', '71': '王纯婷', '72': '沈明海', '73': '宋龙龙',
    '74': '周兰西', '75': '张繁宇', '76': '朱雅芬', '77': '陈中友', '78': '田雯倩',
    '79': '阳咏轩', '80': '陈恩彬', '81': '韦忠杰', '82': '汤茹洁', '83': '方贵智',
    '84': '李加伟', '85': '张文昌', '86': '郑文坤', '87': '安伟', '88': '黄远亮',
    '89': '张雁菁', '90': '周萌', '91': '林金毫',
    '94': '公共管理员', '95': '方妮', '96': '卢屿川1', '98': '姜晶', '99': '郑少泳',
    '102': '屈博1', '104': '杰', '105': '庄志昊', '106': '文嘉燕', '107': '刘瑶', '108': '詹俊飞',
    '110': '刘圳', '111': '刘雅琪', '112': '陈俊希', '113': '刘梦军', '114': '覃帅',
    '115': '周娅琳', '116': '蔡振星', '117': '张益军', '118': '李俏欣', '119': '庄启邦',
    '121': '曾子腾', '122': '方正威', '123': '王洁文', '124': '再兰丁', '125': '钟丽菊',
    '127': '刘江伟', '128': '贺恬',
    '132': '袁伟强', '133': '宋华臻', '134': '陈锦源', '135': '凌润山', '136': '罗鑫宇',
    '137': '黄双梦', '138': '丁再兰', '139': '马龙祥',
    '144': '谢秀成', '146': '侯美琪', '147': 'linxia', '149': '柴景旋',
    '151': '刘圆圆', '152': '许书凝', '153': '方壮泽', '154': '丁梦淇', '156': '郑世茂',
    '159': 'LucaFu', '161': '吴桂平', '162': '贺鑫颖', '163': '李雨露', '165': '李龙',
    '167': '孟洋', '169': '黄桂斌', '170': '加贝贝', '171': '傅俊景',
    '173': '赵智浩', '174': '王泽楷', '175': '蒲月红', '176': '蒙彩柄', '177': '解童',
    '178': '石梦霞', '179': '白雅婷', '180': '李秀娟', '181': '陈旺胜', '182': '许淑媛',
    '183': '吴靖雨', '185': '阳丽萍', '186': '谢钰华',
    '189': '唐君婷', '190': '马晓娜', '191': '叶嘉翠', '192': '郑雅纯', '193': '叶思红',
    '194': '林健平', '195': '刘孟豪', '197': '邱家琪', '199': '陈思瑶',
    '200': '测试-标注员annotator权限》账号可删除',
    '201': '测试-审核员reviewer》账号可删除',
    '202': '测试-经理manager》账号可删除',
    '203': '测试-管理员Admin》账号可删除',
    '204': '邱晓雪', '206': '钟敏丽', '207': '袁敏', '208': '孟婷', '210': '李龙',
    '213': '罗娟', '215': '公共图像审核员账号', '217': '刘聪', '218': '杨家慧',
    '221': '吴春梅', '222': '张颖颖', '223': '卢芷炫', '224': '易晓彤', '225': '严俊楷',
    '228': '公共经理', '229': '王贤舜', '230': '杨凌风', '231': '赵子仪',
    '234': 'erqilin', '237': 'linzijia', '238': '赵璟懿', '240': 'jialong',
    '242': '孙文强', '244': '李亿璠', '249': '陈启熊',
    '251': '蒋金燕', '252': '林宣宇', '253': '陈泳君', '254': '王喜红', '255': '邬承均',
    '256': '饶超凡', '257': '褚燕彬', '259': '巫琪',
    '260': '梁雅灵-用户忘记密码', '261': '梁雅灵', '262': '谭铭铭', '263': '张思茂',
    '264': '崔焕城', '265': '谢志聪', '266': '谭振航', '267': '吕虹钢', '268': '许谦',
    '274': '鲜怡灵', '275': '贾雪', '276': '林彩隆', '277': 'renchanhong',
    '280': '秦月敏', '281': '刘凡凡',
    '284': '珠海管理员账号', '285': '蔡天榆', '286': '庞豪康', '287': '刘毅',
    '288': '梁燕梅', '289': '黄欣乐', '290': '魏敏',
    '292': '闵衍', '293': '卢晓欣', '294': '邹敬科', '295': '邹文垚', '296': '陈铭靖',
    '297': '林炜盛', '298': '文芷菁', '299': '杜艺', '300': '林韵儿', '301': '刘懿',
    '302': '董青青', '303': '刘雨欣', '304': '黄李丽', '305': '陈佳惠', '306': '田先准',
    '307': '张炯', '308': '张丽萍',
    '311': '汤浩铭', '312': '王星杰', '315': '黎舟杰', '317': '林铭',
    '320': 'renjiahe', '321': '吴霜', '322': '黄亦朗', '323': '张嘉鑫', '324': '吴雯婷',
    '327': '计忠辰', '328': '曾雨珊', '329': '刘泽政', '330': '何静颜',
    '333': '陈文辉', '334': '容紫丽',
    '336': '黄伊琳', '337': '张启航', '338': '杨梅', '339': '张立明', '340': '高振威',
    '341': '蒙仁定', '344': 'suyu',
    '347': '罗彤', '348': '郑少春', '349': '曹旭东', '350': 'Olivia', '351': '何光泽',
    '352': '梁凯源', '353': '倪心怡', '354': '高艳秋', '355': '易子淇', '356': '梁德慧',
    '357': '王梓杰', '358': '郑晨宇', '359': '张海晴', '360': '刘继伟', '361': '赵海霞',
    '362': '谢玉峰', '363': '陈嘉炜', '364': '赵家顺', '365': '卢韬', '366': '张瑞杨',
    '367': '张迪哲', '368': '黎浩', '369': '闭紫灏', '370': '刘素飞', '371': '陈磊',
    '372': '胡幸欣', '373': '黄浩彬', '374': '莫溪勇', '375': '王鹏', '376': '罗十',
    '377': '牛泉竹', '378': '程立', '379': '苏文驰', '380': '米风姣', '381': '陈欣雅',
    '382': '李雨桐', '383': '田冰倩', '384': '莫鸿鑫', '385': '姚采蓝', '386': '黎紫玲',
    '387': '林浩涛', '388': '赖晶', '389': '杨智翔', '390': '随心怡', '391': '苏雨辰',
    '392': '陈恩惠', '393': '李佳文', '394': '吴瑞泓', '395': '卢耿瑜', '396': '杨欣',
    '397': '赵雨凡', '398': '洪常超', '399': '韦洺杰', '400': '李华卿', '401': '张银滨',
    '402': '巫海维', '403': '雨昕田', '404': '龚欣雨', '405': '彭世好', '406': '王夙加',
    '407': '刘英吉', '408': '吴诗怡', '409': '张雯雯', '410': '蔡智', '411': 'weisijing',
    '413': 'huangshiya', '414': 'hejiabin1', '415': '詹梦露', '416': 'liwenbin',
    '417': '杨林深', '418': '管名惠', '419': '王姿懿', '420': '孙辰', '421': '王忻瑶',
    '422': '谌丽娟', '423': '黄凯', '425': '李昌昊', '426': '晗李', '427': '刘思怡',
    '428': '钟佳倩', '429': '黄家裕', '430': '黄少鹏', '431': '詹妮', '432': '方正威',
    '433': '黄琼珊', '434': '王靖贻', '435': 'chenke', '436': '李林萍（李莹）', '437': '佟涛',
    '439': '张驷骐', '440': '钟文媛', '441': '邓倩倩', '442': '丁凤菊', '443': '卢衍涛',
    '444': '邓锶琪', '445': '卜耀琳', '446': '王荷', '447': '林洁纯', '448': '张伊琳',
    '450': '雷盛嘉', '451': '叶家喜',
    '452': '邱燕峰', '455': '赵晨杰', '456': '刘舒', '457': '李羿慷', '461': '蒋咏雪',
    '462': '张蜜', '465': '张深宇', '466': '杨程焕', '467': '陈银柳'
  };
  function isNumericId(v) {
    if (v == null) return false;
    return /^\d+$/.test(String(v).trim());
  }
  function nameOfId(id) {
    if (!isNumericId(id)) return null;
    var n = USER_ID_NAME_MAP[String(id).trim()];
    return n ? n : null;
  }
  function displayUser(v) {
    if (v == null) return '';
    var s = String(v).trim();
    if (!s) return '';
    if (isNumericId(s)) {
      var n = USER_ID_NAME_MAP[s];
      return n ? n : s;
    }
    return s;
  }

  var userDirectoryLoaded = false;
  var userDirectoryInflight = null;
  var projectUserDirectoryLoaded = {};
  var projectUserDirectoryInflight = {};

  function userDirectoryName(user) {
    if (!user || typeof user !== 'object') return '';
    var fullName = '';
    if (user.first_name != null || user.last_name != null) {
      fullName = (String(user.first_name || '') + String(user.last_name || '')).trim();
    }
    return fullName || user.name || user.displayName || user.display_name ||
      user.nickname || user.username || user.email || user.login || '';
  }

  function mergeUserDirectory(body) {
    var rows = Array.isArray(body) ? body : [];
    if (!rows.length && body && typeof body === 'object') {
      rows = body.results || body.users || body.items || body.data || [];
    }
    if (!Array.isArray(rows)) return 0;
    var added = 0;
    for (var i = 0; i < rows.length; i++) {
      var record = rows[i];
      if (!record || typeof record !== 'object') continue;
      var user = record.user && typeof record.user === 'object' ? record.user : record;
      var id = user.id;
      if (id == null) id = user.user_id;
      if (id == null) id = record.user_id;
      var name = userDirectoryName(user);
      if (id == null || !name) continue;
      USER_ID_NAME_MAP[String(id)] = String(name).trim();
      added++;
    }
    return added;
  }

  function currentOrganizationId() {
    var settings = window.APP_SETTINGS || {};
    var user = settings.user || {};
    return user.organizationID || user.organization_id || settings.organizationID || settings.organization_id || null;
  }

  function loadUserDirectory() {
    if (userDirectoryLoaded) return Promise.resolve(0);
    if (userDirectoryInflight) return userDirectoryInflight;
    userDirectoryInflight = (async function () {
      var requests = [apiUrl(CONFIG.userPath, { page: 1, page_size: -1 })];
      var organizationId = currentOrganizationId();
      if (organizationId != null) {
        requests.push(apiUrl('/api/organizations/' + encodeURIComponent(organizationId) + '/memberships', {
          page: 1, page_size: -1, active: true, pending: false
        }));
      }
      var lastError = null;
      for (var i = 0; i < requests.length; i++) {
        try {
          var added = mergeUserDirectory(await getJson(requests[i]));
          if (added > 0) {
            userDirectoryLoaded = true;
            return added;
          }
        } catch (e) {
          lastError = e;
        }
      }
      userDirectoryLoaded = true;
      if (lastError) log('用户目录读取失败', lastError);
      return 0;
    })().then(function (count) {
      userDirectoryInflight = null;
      return count;
    }, function (error) {
      userDirectoryInflight = null;
      userDirectoryLoaded = true;
      log('用户目录读取失败', error);
      return 0;
    });
    return userDirectoryInflight;
  }

  function loadProjectUserDirectory(projectId) {
    var key = String(projectId || '');
    if (!key || projectUserDirectoryLoaded[key]) return Promise.resolve(0);
    if (projectUserDirectoryInflight[key]) return projectUserDirectoryInflight[key];
    projectUserDirectoryInflight[key] = getJson(apiUrl('/api/projects/' + encodeURIComponent(key) + '/members', {
      active: true
    })).then(function(body) {
      projectUserDirectoryLoaded[key] = true;
      return mergeUserDirectory(body);
    }).catch(function(error) {
      projectUserDirectoryLoaded[key] = true;
      log('项目成员目录读取失败', key, error);
      return 0;
    }).then(function(count) {
      delete projectUserDirectoryInflight[key];
      return count;
    });
    return projectUserDirectoryInflight[key];
  }

  // ========== 数据页 DOM 抓取 ==========
  function loadTaskAnnotatorMap() {
    try {
      var o = JSON.parse(localStorage.getItem(TASK_ANNOTATOR_MAP_KEY) || '{}');
      return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
    } catch(e) { return {}; }
  }
  function saveTaskAnnotatorMap(map) {
    try { localStorage.setItem(TASK_ANNOTATOR_MAP_KEY, JSON.stringify(map || {})); } catch(e) {}
  }

  function scrapeTaskAnnotatorsFromDOM() {
    var rows = document.querySelectorAll('.dm-table-row');
    if (!rows.length) return;
    var map = loadTaskAnnotatorMap();
    var changed = false;

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var cells = row.querySelectorAll('.dm-table__cell');
      if (cells.length < 7) continue;

      var taskId = null;
      for (var j = 0; j < cells.length; j++) {
        var txt = (cells[j].textContent || '').trim();
        if (/^\d{5,}$/.test(txt)) { taskId = txt; break; }
      }
      if (!taskId) continue;

      var annotatorsDiv = row.querySelector('.dm-annotators');
      if (!annotatorsDiv) continue;

      var names = [];
      var items = annotatorsDiv.querySelectorAll('.dm-annotators__item');
      for (var k = 0; k < items.length; k++) {
        var item = items[k];
        var img = item.querySelector('img.dm-userpic__avatar');
        var span = item.querySelector('.dm-userpic__username');
        var name = '';
        if (img && img.getAttribute('alt') && img.getAttribute('alt') !== 'Data') {
          name = img.getAttribute('alt');
        } else if (span && (span.textContent || '').trim()) {
          name = (span.textContent || '').trim();
        }
        if (name && names.indexOf(name) === -1) names.push(name);
      }

      if (names.length) {
        var val = names.join('、');
        if (map[taskId] !== val) {
          map[taskId] = val;
          changed = true;
        }
      }
    }

    if (changed) {
      saveTaskAnnotatorMap(map);
      if (DEBUG) console.log('[概览] 已从数据表抓取缓存 ' + Object.keys(map).length + ' 个任务的标注员姓名');
    }
  }

  var dataScrapeObserver = null;
  var dataScrapeTimer = null;
  function startDataScrapeObserver() {
    if (dataScrapeObserver) return;
    var target = document.querySelector('.dm-table__virual');
    if (!target) { setTimeout(startDataScrapeObserver, 1000); return; }
    scrapeTaskAnnotatorsFromDOM();
    dataScrapeObserver = new MutationObserver(function() {
      if (dataScrapeTimer) return;
      dataScrapeTimer = setTimeout(function() {
        dataScrapeTimer = null;
        scrapeTaskAnnotatorsFromDOM();
      }, 400);
    });
    dataScrapeObserver.observe(target, { childList: true, subtree: true });
  }
  function stopDataScrapeObserver() {
    if (dataScrapeObserver) { dataScrapeObserver.disconnect(); dataScrapeObserver = null; }
    if (dataScrapeTimer) { clearTimeout(dataScrapeTimer); dataScrapeTimer = null; }
  }

  function loadStatsFlag() { try { return localStorage.getItem(STATS_ON_KEY) === '1'; } catch (e) { return false; } }
  function saveStatsFlag(v) { try { localStorage.setItem(STATS_ON_KEY, v ? '1' : '0'); } catch (e) {} }
  function loadStatsProjects() {
    try { var o = JSON.parse(localStorage.getItem(STATS_PROJECTS_KEY) || '{}');
      return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {}; } catch (e) { return {}; }
  }
  function saveStatsProjects(o) { try { localStorage.setItem(STATS_PROJECTS_KEY, JSON.stringify(o || {})); } catch (e) {} }
  function markProjectOn(id) { var o = loadStatsProjects(); o[String(id)] = 1; saveStatsProjects(o); }
  function markProjectOff(id) { var o = loadStatsProjects(); delete o[String(id)]; saveStatsProjects(o); }
  function isProjectOn(id) { return !!loadStatsProjects()[String(id)]; }
  function loadHideAll() { try { return localStorage.getItem(HIDE_ALL_KEY) === '1'; } catch (e) { return false; } }
  function saveHideAll(v) { try { localStorage.setItem(HIDE_ALL_KEY, v ? '1' : '0'); } catch (e) {} }

  var selectedMapCache = null;
  function loadSelected() {
    if (selectedMapCache) return selectedMapCache;
    try {
      var o = JSON.parse(localStorage.getItem(SELECTED_KEY) || '{}');
      selectedMapCache = (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
    } catch (e) { selectedMapCache = {}; }
    return selectedMapCache;
  }
  function saveSelected(o) {
    selectedMapCache = o || {};
    try { localStorage.setItem(SELECTED_KEY, JSON.stringify(selectedMapCache)); } catch (e) {}
  }
  function isProjectSelected(id) { return !!loadSelected()[String(id)]; }
  function selectedCount() { return Object.keys(loadSelected()).length; }
  function toggleProjectSelected(id) {
    var o = loadSelected(); var k = String(id);
    if (o[k]) delete o[k]; else o[k] = 1;
    saveSelected(o);
    return !!o[k];
  }
  function clearProjectSelected() { saveSelected({}); syncSelectedUI(); }

  var onlySelected = (function () {
    try { return localStorage.getItem(ONLY_SELECTED_KEY) === '1'; } catch (e) { return false; }
  })();
  function saveOnlySelected(v) { try { localStorage.setItem(ONLY_SELECTED_KEY, v ? '1' : '0'); } catch (e) {} }

  function applySelectedState(card, context, summaryEl) {
    if (!card || !context) return;
    var on = isProjectSelected(context.projectId);
    var s = summaryEl || card.querySelector('.ovw-summary');
    if (s) { if (on) s.classList.add('is-selected'); else s.classList.remove('is-selected'); }
    if (on) card.classList.add('ovw-card--sel'); else card.classList.remove('ovw-card--sel');
  }
  function syncSelectedUI() {
    var cards = document.querySelectorAll(CONFIG.cardSelector);
    for (var i = 0; i < cards.length; i++) applySelectedState(cards[i], projectContext(cards[i]));
    updateRepairPanelMeta();
  }
  function updateRepairPanelMeta() {
    var panelEl = document.querySelector('.ovw-repair-panel');
    if (!panelEl) return;
    var n = selectedCount();
    var cntEl = panelEl.querySelector('.ovw-repair-selcount');
    if (cntEl) cntEl.textContent = n ? ('已选中 ' + n + ' 个') : '未选中任何项目';
    var clearBtn = panelEl.querySelector('.ovw-repair-clear');
    if (clearBtn) clearBtn.disabled = !n;
  }

  var statsEnabled = loadStatsFlag();
  var allHidden = loadHideAll();

  function hideAllCards() {
    allHidden = true; saveHideAll(true);
    document.querySelectorAll(CONFIG.cardSelector).forEach(function (c) {
      delete c.dataset.ovwMounted;
      var s = c.querySelector('.ovw-summary');
      if (s) { s.dataset.ovwManual = ''; s.classList.add('ovw-summary--off'); }
    });
    scanCards(); updateHideAllBtn();
  }
  function showAllCards() {
    allHidden = false; saveHideAll(false);
    document.querySelectorAll(CONFIG.cardSelector).forEach(function (c) {
      delete c.dataset.ovwMounted;
      var s = c.querySelector('.ovw-summary');
      if (s) s.classList.remove('ovw-summary--off');
    });
    scanCards(); updateHideAllBtn();
  }
  function restoreAll() {
    allHidden = false; saveHideAll(false); saveStatsProjects({});
    saveSelected({}); onlySelected = false; saveOnlySelected(false);
    visibleFields = DEFAULT_VISIBLE.slice(); saveVisibleFields(visibleFields);
    document.querySelectorAll(CONFIG.cardSelector).forEach(function (c) {
      delete c.dataset.ovwMounted;
      c.classList.remove('ovw-card--sel');
      var s = c.querySelector('.ovw-summary');
      if (s) { s.dataset.ovwManual = ''; s.classList.remove('ovw-summary--off'); s.classList.remove('is-selected'); }
    });
    scanCards(); updateHideAllBtn();
  }

  var hideAllBtnEl = null;
  function updateHideAllBtn() {
    if (!hideAllBtnEl) return;
    if (allHidden) {
      hideAllBtnEl.textContent = '全部打开';
      hideAllBtnEl.classList.add('is-on');
      hideAllBtnEl.title = '当前全部隐藏，点此全部打开';
    } else {
      hideAllBtnEl.textContent = '全部关闭';
      hideAllBtnEl.classList.remove('is-on');
      hideAllBtnEl.title = '所有卡片彻底不显示（含待点击态）';
    }
  }
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
    REWORK: '返工', REPAIR: '返修', reworkTotal: '总返工量'
  };
  var FILTER_VALUE_CANDIDATES = {
    PENDING_ANNOTATION: ['CREATED', 'PENDING', 'created'],
    ANNOTATED:          ['ANNOTATED', 'annotated'],
    REVIEWED_ACCEPTED:  ['REVIEWED_ACCEPTED', 'reviewed_accepted'],
    REVIEWED_REJECTED:  ['REVIEWED_REJECTED', 'reviewed_rejected'],
    REWORK:             ['REWORK', 'rework'],
    reworkTotal:        ['REWORK', 'rework'],
    REPAIR:             ['REPAIR', 'repair', 'REPAIRED', 'repaired', '修复']
  };
  var FILTERABLE = {
    PENDING_ANNOTATION: 1, ANNOTATED: 1,
    REVIEWED_ACCEPTED: 1, REVIEWED_REJECTED: 1,
    REWORK: 1, reworkTotal: 1,
    REPAIR: 1
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
  function log() { if (!DEBUG) return; try { console.log.apply(console, ['[概览]'].concat([].slice.call(arguments))); } catch (e) {} }

  var FIELD_DEFS = [
    { key: 'annotationProgress',  label: '标注进度', short: '标注',     color: '#52c41a', kind: 'percent' },
    { key: 'reviewProgress',      label: '审核进度', short: '审核',     color: '#13c2c2', kind: 'percent' },
    { key: 'repairProgress',      label: '返修进度', short: '返修',     color: '#ff4d4f', kind: 'percent' },
    { key: 'total',               label: '总数',     short: '总数',     color: '#1677ff', kind: 'total' },
    { key: 'ANNOTATED',           label: '已标注',   short: '已标注',   color: '#52c41a', kind: 'status' },
    { key: 'REVIEWED_ACCEPTED',   label: '已审核',   short: '已审核',   color: '#13c2c2', kind: 'status' },
    { key: 'REPAIR',              label: '待返修',   short: '待返修',   color: '#ff4d4f', kind: 'status' },
    { key: 'REWORK',              label: '返工',     short: '返工',     color: '#fa8c16', kind: 'status' },
    { key: 'SKIPPED',             label: '跳过数据', short: '跳过',     color: '#8b5cf6', kind: 'status' },
    { key: 'reworkTotal',         label: '总返工量', short: '总返工',   color: '#fa8c16', kind: 'status' },
    { key: 'PENDING_ANNOTATION',  label: '待标注',   short: '待标注',   color: '#8c8c8c', kind: 'status' },
    { key: 'REVIEWED_REJECTED',   label: '审核驳回', short: '审核驳回', color: '#ff4d4f', kind: 'status' },
    { key: 'ACCEPTANCE_ACCEPTED', label: '验收通过', short: '验收通过', color: '#52c41a', kind: 'status' },
    { key: 'ACCEPTANCE_REJECTED', label: '验收拒绝', short: '验收拒绝', color: '#ff4d4f', kind: 'status' }
  ];
  var FIELD_MAP = {};
  for (var fi = 0; fi < FIELD_DEFS.length; fi++) FIELD_MAP[FIELD_DEFS[fi].key] = FIELD_DEFS[fi];
  var DEFAULT_VISIBLE = [
    'annotationProgress', 'reviewProgress', 'repairProgress',
    'total', 'ANNOTATED', 'REVIEWED_ACCEPTED', 'SKIPPED', 'REVIEWED_REJECTED'
  ];
  var SKIPPED_FIELD_MIGRATION_KEY = 'insta360-overview-skipped-field-v1';
  function loadVisibleFields() {
    try {
      var raw = JSON.parse(localStorage.getItem(CONFIG.settingsKey) || 'null');
      var list = Array.isArray(raw) ? raw.filter(function (k) { return FIELD_MAP[k]; }) : DEFAULT_VISIBLE.slice();
      if (localStorage.getItem(SKIPPED_FIELD_MIGRATION_KEY) !== '1') {
        if (list.indexOf('SKIPPED') === -1) list.push('SKIPPED');
        localStorage.setItem(CONFIG.settingsKey, JSON.stringify(list));
        localStorage.setItem(SKIPPED_FIELD_MIGRATION_KEY, '1');
      }
      return list;
    } catch (e) {}
    return DEFAULT_VISIBLE.slice();
  }
  function saveVisibleFields(list) { try { localStorage.setItem(CONFIG.settingsKey, JSON.stringify(list)); } catch (e) {} }
  var visibleFields = loadVisibleFields();
  function isVisible(key) { return visibleFields.indexOf(key) !== -1; }

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
  Pool.prototype.next = function () { if (this.active < this.limit && this.queue.length) this.queue.shift()(); };
  var detailPool = new Pool(CONFIG.detailConcurrency);
  var repairPool = new Pool(CONFIG.repairConcurrency);
  var taskPagePool = new Pool(CONFIG.taskGlobalConcurrency);

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
    var seen = {}; var total = 0, unknown = 0;
    var skipped = 0, skippedAvailable = true;
    var list = Array.isArray(rows) ? rows : [];
    for (var j = 0; j < list.length; j++) {
      var t = normalizeTask(list[j], 'row-' + j);
      var key = String(t.taskId);
      if (seen[key]) continue;
      seen[key] = true; total += 1;
      var annotations = list[j] && list[j].annotations;
      if (Array.isArray(annotations)) {
        skipped += annotations.filter(function (annotation) { return annotation && annotation.was_cancelled === true; }).length;
      } else {
        skippedAvailable = false;
      }
      if (t.status && STATUS_SET[t.status]) counts[t.status] += 1; else unknown += 1;
    }
    counts.reworkTotal = counts.REWORK || 0;
    var available = STATUS_CODES.concat(['reworkTotal']);
    if (skippedAvailable) { counts.SKIPPED = skipped; available.push('SKIPPED'); }
    return { total: total, counts: counts, unknown: unknown, available: available, needsTaskDetails: false, source: 'tasks' };
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
    var rework = num(
      summary.user_rework_count != null ? summary.user_rework_count :
      summary.rework_count      != null ? summary.rework_count      :
      summary.user_rework       != null ? summary.user_rework       :
      summary.total_rework_count
    );
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
    counts.reworkTotal = rework;
    counts.REPAIR = repair;
    var sum = 0; for (var k in counts) sum += counts[k];
    var available = STATUS_CODES.concat(['reworkTotal']);
    // Use the platform's cancelled/skipped annotation count; never infer it
    // from total minus completed tasks, which also includes untouched tasks.
    var skippedRaw = summary.skipped_annotations_number;
    var skipped = typeof skippedRaw === 'number' || (typeof skippedRaw === 'string' && skippedRaw.trim() !== '') ? Number(skippedRaw) : NaN;
    if (Number.isSafeInteger(skipped) && skipped >= 0) {
      counts.SKIPPED = skipped;
      available.push('SKIPPED');
    }
    return {
      total: total, counts: counts,
      available: available,
      unknown: Math.max(0, total - sum),
      source: 'summary-fast', needsTaskDetails: false, summary: summary
    };
  }

  function apiUrl(path, params) {
    var url = new URL(path, location.origin);
    if (params) Object.keys(params).forEach(function (k) {
      var v = params[k];
      if (v != null && v !== '') url.searchParams.set(k, String(v));
    });
    return url.toString();
  }

  async function getJson(url) {
    var controller = new AbortController();
    var timeoutId = setTimeout(function() { controller.abort(); }, 20000);
    try {
      var res = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' }, signal: controller.signal });
      clearTimeout(timeoutId);
      if (res.status === 401) throw new Error('登录状态已失效');
      if (!res.ok) {
        var message = 'HTTP ' + res.status;
        if (res.status === 429) message += '：请求过于频繁';
        else if (res.status >= 500) message += '：服务器暂时不可用';
        var httpError = new Error(message);
        httpError.httpStatus = res.status;
        throw httpError;
      }
      return res.json();
    } catch (e) {
      clearTimeout(timeoutId);
      if (e && e.name === 'AbortError') throw new Error('请求超时（20 秒）');
      throw e;
    }
  }

  function responseObjects(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
    var out = [body];
    var nestedKeys = ['data', 'result', 'payload', 'meta', 'pagination', 'page'];
    for (var i = 0; i < out.length && i < 12; i++) {
      var obj = out[i];
      for (var j = 0; j < nestedKeys.length; j++) {
        var nested = obj[nestedKeys[j]];
        if (!nested || typeof nested !== 'object' || Array.isArray(nested)) continue;
        if (out.indexOf(nested) < 0) out.push(nested);
      }
    }
    return out;
  }
  function rowsFromResponse(body) {
    if (Array.isArray(body)) return body;
    var objects = responseObjects(body);
    var keys = ['results', 'tasks', 'items', 'rows', 'data'];
    for (var i = 0; i < objects.length; i++) {
      for (var j = 0; j < keys.length; j++) {
        if (Array.isArray(objects[i][keys[j]])) return objects[i][keys[j]];
      }
    }
    return [];
  }
  function totalFromResponse(body) {
    var objects = responseObjects(body);
    var keys = ['count', 'total', 'total_count', 'totalCount', 'records_total', 'recordsTotal', 'total_items', 'totalItems'];
    for (var i = 0; i < objects.length; i++) {
      for (var j = 0; j < keys.length; j++) {
        var raw = objects[i][keys[j]];
        if (raw == null || raw === '') continue;
        var v = Number(raw);
        if (Number.isFinite(v) && v >= 0) return v;
      }
    }
    return null;
  }
  function taskRowKey(row) {
    if (!row || typeof row !== 'object') return null;
    var id = row.id;
    if (id == null) id = row.task_id;
    if (id == null) id = row.taskId;
    return id == null ? null : String(id);
  }
  function appendUniqueTaskRows(target, seen, pageRows) {
    var added = 0;
    for (var i = 0; i < pageRows.length; i++) {
      var key = taskRowKey(pageRows[i]);
      if (key != null) {
        if (seen[key]) continue;
        seen[key] = 1;
      }
      target.push(pageRows[i]);
      added++;
    }
    return added;
  }
  async function loadTaskPage(page, baseParams) {
    var lastError = null;
    for (var attempt = 0; attempt <= CONFIG.taskPageRetries; attempt++) {
      try {
        var url = apiUrl(CONFIG.taskPath, Object.assign({ page: page }, baseParams));
        return await taskPagePool.run(function() { return getJson(url); });
      } catch (e) {
        lastError = e;
        if (e && (e.httpStatus === 401 || (e.httpStatus >= 400 && e.httpStatus < 500 && e.httpStatus !== 429))) break;
        if (attempt < CONFIG.taskPageRetries) {
          await new Promise(function(resolve) { setTimeout(resolve, 200 * Math.pow(2, attempt)); });
        }
      }
    }
    var pageError = new Error('任务读取不完整：第 ' + page + ' 页读取失败（' + String(lastError) + '）');
    pageError.httpStatus = lastError && lastError.httpStatus;
    pageError.taskPage = page;
    throw pageError;
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

  // 分页拉取：支持附加 Data Manager 查询；无总数时继续读取到最后一页。
  async function loadTasksPaged(projectId, workspaceId, extraParams, pageSize, firstPageValidator) {
    var baseParams = Object.assign(
      { project: projectId, workspace: workspaceId, page_size: pageSize },
      extraParams || {}
    );
    var firstBody = await loadTaskPage(1, baseParams);
    var firstRows = rowsFromResponse(firstBody);
    var rows = [];
    var seen = {};
    appendUniqueTaskRows(rows, seen, firstRows);
    var effectiveSize = firstRows.length || CONFIG.taskPageSize;
    var total = totalFromResponse(firstBody);
    if (firstPageValidator) firstPageValidator({ body: firstBody, rows: firstRows, total: total });
    if (!firstRows.length || total === 0 || (total != null && rows.length >= total)) return rows;

    if (total != null) {
      var pageCount = Math.ceil(total / effectiveSize);
      var pageList = [];
      for (var p = 2; p <= pageCount; p++) pageList.push(p);
      var queue = pageList.slice();
      var pageErrors = [];
      var concurrency = Math.max(1, Math.min(CONFIG.taskPageConcurrency, pageCount - 1));
      async function worker() {
        while (queue.length) {
          var page = queue.shift();
          try {
            var body = await loadTaskPage(page, baseParams);
            appendUniqueTaskRows(rows, seen, rowsFromResponse(body));
          } catch (e) {
            pageErrors.push(e);
          }
        }
      }
      var workers = [];
      for (var w = 0; w < concurrency; w++) workers.push(worker());
      await Promise.all(workers);

      if (pageErrors.length) {
        var unrecoverable = null;
        for (var pe = 0; pe < pageErrors.length; pe++) {
          if (pageErrors[pe].httpStatus !== 404 || pageErrors[pe].taskPage <= 1) {
            unrecoverable = pageErrors[pe];
            break;
          }
        }
        if (unrecoverable) throw unrecoverable;

        // Data Manager 的筛选视图可能在并发读取期间重建，短暂令末页返回 404。
        // 重新确认第一页与总数，并顺序重拉，避免把两次分页快照拼在一起。
        var refreshedFirstBody = await loadTaskPage(1, baseParams);
        var refreshedFirstRows = rowsFromResponse(refreshedFirstBody);
        var refreshedTotal = totalFromResponse(refreshedFirstBody);
        if (firstPageValidator) {
          firstPageValidator({ body: refreshedFirstBody, rows: refreshedFirstRows, total: refreshedTotal });
        }
        if (refreshedTotal == null) throw pageErrors[0];

        rows = [];
        seen = {};
        appendUniqueTaskRows(rows, seen, refreshedFirstRows);
        effectiveSize = refreshedFirstRows.length || CONFIG.taskPageSize;
        total = refreshedTotal;
        if (!refreshedFirstRows.length || total === 0 || rows.length >= total) return rows;

        pageCount = Math.ceil(total / effectiveSize);
        for (var rp = 2; rp <= pageCount; rp++) {
          var refreshedBody = await loadTaskPage(rp, baseParams);
          appendUniqueTaskRows(rows, seen, rowsFromResponse(refreshedBody));
        }
      }
      if (rows.length < total) {
        throw new Error('任务读取不完整：接口显示共 ' + total + ' 条，实际只读取到 ' + rows.length + ' 条');
      }
      return rows;
    }

    var nextPage = 2;
    var unknownConcurrency = Math.max(1, CONFIG.taskUnknownPageConcurrency);
    while (true) {
      var batch = [];
      for (var b = 0; b < unknownConcurrency; b++) {
        (function(page) {
          batch.push(loadTaskPage(page, baseParams).then(function(body) {
            return { page: page, rows: rowsFromResponse(body) };
          }));
        })(nextPage + b);
      }
      var pages = await Promise.all(batch);
      pages.sort(function(a, b) { return a.page - b.page; });
      for (var q = 0; q < pages.length; q++) {
        var pageRows = pages[q].rows;
        if (!pageRows.length) return rows;
        var added = appendUniqueTaskRows(rows, seen, pageRows);
        if (added === 0 && pageRows.length >= effectiveSize) {
          throw new Error('任务读取不完整：分页接口重复返回第 1 页数据');
        }
        if (pageRows.length < effectiveSize) return rows;
      }
      nextPage += unknownConcurrency;
    }
  }

  function shouldFallbackTaskPageSize(error) {
    return !!error && (error.httpStatus === 400 || error.httpStatus === 413 || error.httpStatus === 422);
  }

  async function loadTasksWithParams(projectId, workspaceId, extraParams, firstPageValidator) {
    var preferred = CONFIG.taskPageSizePreferred || CONFIG.taskPageSize;
    try {
      return await loadTasksPaged(projectId, workspaceId, extraParams, preferred, firstPageValidator);
    } catch (e) {
      if (preferred === CONFIG.taskPageSize || !shouldFallbackTaskPageSize(e)) throw e;
      return loadTasksPaged(projectId, workspaceId, extraParams, CONFIG.taskPageSize, firstPageValidator);
    }
  }

  async function loadTasks(projectId, workspaceId) {
    return loadTasksWithParams(projectId, workspaceId, null, null);
  }

  function buildPendingTaskQuery() {
    return JSON.stringify({
      filters: {
        conjunction: 'or',
        items: ['REVIEWED_REJECTED', 'REPAIR', 'REWORK'].map(function(value) {
          return {
            filter: 'filter:tasks:state',
            operator: 'equal',
            value: value,
            type: 'String'
          };
        })
      },
      ordering: [],
      hiddenColumns: {}
    });
  }

  function pendingTaskRows(rows) {
    return rows.filter(function(row) {
      var state = taskStatusOf(row);
      return isRepairState(state) || isReworkState(state);
    });
  }

  async function loadPendingTasks(projectId, workspaceId, pendingHint) {
    try {
      var filtered = await loadTasksWithParams(
        projectId,
        workspaceId,
        { query: buildPendingTaskQuery() },
        function(info) {
          if (info.rows.some(function(row) {
            var state = taskStatusOf(row);
            return !isRepairState(state) && !isReworkState(state);
          })) {
            throw new Error('服务端未应用待返修/返工筛选');
          }
          if (info.total === 0 && Number(pendingHint) > 0) {
            throw new Error('服务端筛选结果与卡片待处理数量不一致');
          }
        }
      );
      if (filtered.length !== pendingTaskRows(filtered).length) {
        throw new Error('服务端筛选返回了非待处理任务');
      }
      return filtered;
    } catch (filteredError) {
      log('待处理任务筛选不可用，回退全量扫描', projectId, filteredError);
      return pendingTaskRows(await loadTasks(projectId, workspaceId));
    }
  }

  var taskRowsCache = {};
  var taskRowsInflight = {};

  function taskRowsCacheKey(projectId, workspaceId) {
    return String(workspaceId || 'all') + ':' + String(projectId);
  }

  function clearTaskRowsCache(projectId, workspaceId) {
    delete taskRowsCache[taskRowsCacheKey(projectId, workspaceId)];
  }

  async function loadTasksShared(projectId, workspaceId, forceRefresh) {
    var key = taskRowsCacheKey(projectId, workspaceId);
    if (forceRefresh) delete taskRowsCache[key];

    var cached = taskRowsCache[key];
    if (cached && Date.now() - cached.ts < CONFIG.taskRowsCacheTtlMs) return cached.rows;
    if (taskRowsInflight[key]) return taskRowsInflight[key];

    var promise = loadTasks(projectId, workspaceId).then(function(rows) {
      taskRowsCache[key] = { ts: Date.now(), rows: rows };
      return rows;
    }).finally(function() {
      delete taskRowsInflight[key];
    });

    taskRowsInflight[key] = promise;
    return promise;
  }

  var pendingTaskRowsCache = {};
  var pendingTaskRowsInflight = {};

  function clearPendingTaskRowsCache(projectId, workspaceId) {
    delete pendingTaskRowsCache[taskRowsCacheKey(projectId, workspaceId)];
  }

  async function loadPendingTasksShared(projectId, workspaceId, pendingHint, forceRefresh) {
    var key = taskRowsCacheKey(projectId, workspaceId);
    if (forceRefresh) delete pendingTaskRowsCache[key];

    var cached = pendingTaskRowsCache[key];
    if (cached && Date.now() - cached.ts < CONFIG.taskRowsCacheTtlMs) return cached.rows;
    if (pendingTaskRowsInflight[key]) return pendingTaskRowsInflight[key];

    var promise = loadPendingTasks(projectId, workspaceId, pendingHint).then(function(rows) {
      pendingTaskRowsCache[key] = { ts: Date.now(), rows: rows };
      return rows;
    }).finally(function() {
      delete pendingTaskRowsInflight[key];
    });

    pendingTaskRowsInflight[key] = promise;
    return promise;
  }

  async function loadProjectPrecise(projectId, workspaceId) {
    var summary = null;
    try { summary = await loadProjectSummary(projectId); } catch (e) {}
    var tasks = await loadTasks(projectId, workspaceId);
    var agg = aggregateTasks(tasks);
    agg.summary = summary;
    return agg;
  }
  function withTimeout(promise, ms) {
    return Promise.race([promise, new Promise(function (_, reject) { setTimeout(function () { reject(new Error('请求超时')); }, ms); })]);
  }
  async function loadProjectFull(projectId, workspaceId) {
    var p = CONFIG.fastMode ? loadProjectFast(projectId) : loadProjectPrecise(projectId, workspaceId);
    return await withTimeout(p, 15000);
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

  function buildProjectDataUrl(ctx, mode) {
    if (!ctx || (mode !== 'repair' && mode !== 'rework')) return '';
    var basePath = '';
    if (ctx.workspaceId && ctx.projectId) {
      basePath = '/annotation/workspaces/' + encodeURIComponent(ctx.workspaceId)
        + '/projects/' + encodeURIComponent(ctx.projectId);
    }
    if (!basePath) return '';
    return location.origin + basePath + '/data?labeling=1&' + mode + '=1';
  }
  var cache = {};

  var reworkTotalCache = {};
  var reworkTotalInflight = {};

  async function fetchReworkTotal(card, force) {
    var ctx = projectContext(card);
    if (!ctx) return null;
    var pid = ctx.projectId;
    var now = Date.now();

    if (!force) {
      var c = reworkTotalCache[pid];
      if (c && now - c.ts < CONFIG.reworkTotalCacheTtlMs) return c.count;
    }
    if (reworkTotalInflight[pid]) return reworkTotalInflight[pid];

    var p = (async function () {
      try {
        var entry = cache[ctx.projectId];
        var counts = entry && entry.aggregate && entry.aggregate.counts;
        var rows = await loadPendingTasksShared(
          ctx.projectId,
          ctx.workspaceId,
          pendingCountFromCounts(counts),
          !!force
        );
        var n = 0;
        for (var i = 0; i < rows.length; i++) {
          var st = taskStatusOf(rows[i]);
          if (st === 'REWORK') n++;
        }
        reworkTotalCache[pid] = { ts: Date.now(), count: n };
        return n;
      } catch (e) {
        return null;
      } finally {
        delete reworkTotalInflight[pid];
      }
    })();

    reworkTotalInflight[pid] = p;
    return p;
  }

  function triggerReworkTotalFetch(card, summaryEl) {
    if (visibleFields.indexOf('reworkTotal') === -1) return;
    if (!summaryEl) return;
    var pid = summaryEl.dataset ? summaryEl.dataset.projectId : null;
    if (!pid) return;
    if (reworkTotalInflight[pid]) return;
    var cached = reworkTotalCache[pid];
    if (cached && (Date.now() - cached.ts) < CONFIG.reworkTotalCacheTtlMs) return;

    fetchReworkTotal(card).then(function (n) {
      if (n == null) return;
      var entry = cache[pid];
      if (entry && entry.aggregate) {
        if (!entry.aggregate.counts) entry.aggregate.counts = {};
        entry.aggregate.counts.reworkTotal = n;
        if (!entry.aggregate.available) entry.aggregate.available = STATUS_CODES.slice();
        if (entry.aggregate.available.indexOf('reworkTotal') === -1) {
          entry.aggregate.available = entry.aggregate.available.concat(['reworkTotal']);
        }
        var s = card.querySelector('.ovw-summary');
        if (s) renderSummary(s, entry.aggregate);
      }
    }).catch(function () {});
  }

  async function refreshProject(card, options) {
    options = options || {};
    var context = card && projectContext(card);
    if (!context) return null;
    var summaryEl = createSummary(card, context);
    if (!summaryEl) return null;
    if (summaryEl.classList.contains('ovw-summary--off')) return null;
    var existing = cache[context.projectId];
    if (!options.force && existing && existing.aggregate && Date.now() - existing.loadedAt < CONFIG.cacheTtlMs) {
      renderSummary(summaryEl, existing.aggregate);
      triggerReworkTotalFetch(card, summaryEl);
      return existing.aggregate;
    }
    if (existing && existing.promise) return existing.promise;
    renderSummary(summaryEl, existing ? existing.aggregate : null, true);
    var promise = loadProjectFull(context.projectId, context.workspaceId)
      .then(function (aggregate) {
        cache[context.projectId] = { loadedAt: Date.now(), aggregate: aggregate };
        ensureSummaryInPlace(card, summaryEl);
        renderSummary(summaryEl, aggregate);
        triggerReworkTotalFetch(card, summaryEl);
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
    function ch(v) { v = v / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
    return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
  }
  function detectTheme(startEl) {
    var node = startEl; var depth = 0;
    while (node && depth < 14) {
      var bg = '';
      try { bg = window.getComputedStyle(node).backgroundColor; } catch (e) { bg = ''; }
      var c = parseColor(bg);
      if (c && c.a > 0.5) return relLum(c) > 0.5 ? 'light' : 'dark';
      node = node.parentElement; depth += 1;
    }
    try { if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark'; } catch (e) {}
    return 'light';
  }
  function applyTheme(summaryEl) {
    if (!summaryEl) return;
    var start = summaryEl.parentElement || summaryEl;
    var theme = detectTheme(start);
    if (summaryEl.dataset.ovwTheme !== theme) summaryEl.dataset.ovwTheme = theme;
  }

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
    var avList = agg.available || STATUS_CODES.concat(['reworkTotal']);
    for (var i = 0; i < avList.length; i++) available[avList[i]] = true;
    if (field.kind === 'total') return String(agg.total != null ? agg.total : 0);
    if (field.kind === 'status') {
      if (field.key === 'SKIPPED' && !available.SKIPPED) return '—';
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

  function counterActionForKey(key) {
    if (key === 'REPAIR') return { type: 'stream', mode: 'repair' };
    if (key === 'REWORK') return { type: 'stream', mode: 'rework' };
    if (key === 'reworkTotal') return { type: 'filter', code: 'REWORK' };
    if (FILTERABLE[key]) return { type: 'filter', code: key };
    return null;
  }

  var ICON_REFRESH = '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path fill="currentColor" d="M8 3a5 5 0 1 0 4.55 2.9l1.2-.7A6.5 6.5 0 1 1 8 1.5v1.5z"/><path fill="currentColor" d="M12.5 1v3h-3z"/></svg>';
  var ICON_CLOSE = '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" d="M4 4l8 8M12 4l-8 8"/></svg>';

  function findInsertAnchor(card) {
    var info = card.querySelector(CONFIG.infoSelector);
    if (info && info.parentElement === card) return { parent: card, before: info };
    return null;
  }
  function ensureSummaryInPlace(card, summaryEl) {
    if (!summaryEl) return false;
    var anchor = findInsertAnchor(card);
    if (!anchor) return false;
    if (summaryEl.parentElement === anchor.parent && summaryEl.nextSibling === anchor.before) return true;
    anchor.parent.insertBefore(summaryEl, anchor.before);
    return true;
  }

  function createSummary(card, context) {
    var existing = card.querySelector('.ovw-summary');
    if (existing) { ensureSummaryInPlace(card, existing); applyTheme(existing); applySelectedState(card, context, existing); return existing; }
    if (!findInsertAnchor(card)) return null;

    var summary = document.createElement('div');
    summary.className = 'ovw-summary';
    summary.dataset.projectId = context.projectId;
    summary.dataset.ovwHref = context.href || '';
    summary.dataset.ovwManual = '';

    summary.addEventListener('click', function (e) {
      var target = e.target;
      var cardEl = summary.closest(CONFIG.cardSelector);

      var selectEl = target.closest ? target.closest('.ovw-select') : null;
      if (selectEl) {
        e.preventDefault(); e.stopPropagation();
        if (cardEl) {
          var sctx = projectContext(cardEl);
          if (sctx) {
            toggleProjectSelected(sctx.projectId);
            applySelectedState(cardEl, sctx, summary);
            var panelEl = document.querySelector('.ovw-repair-panel');
            if (panelEl && !panelEl.hidden) {
              if (onlySelected) renderRepairPanel(panelEl, false);
              else updateRepairPanelMeta();
            }
          }
        }
        return;
      }

      var closeEl = target.closest ? target.closest('.ovw-close') : null;
      if (closeEl) {
        e.preventDefault(); e.stopPropagation();
        if (cardEl) {
          var closeCtx = projectContext(cardEl);
          if (closeCtx) markProjectOff(closeCtx.projectId);
        }
        summary.dataset.ovwManual = '';
        renderSummaryManual(summary);
        return;
      }
      var refreshEl = target.closest ? target.closest('.ovw-refresh') : null;
      if (refreshEl) {
        e.preventDefault(); e.stopPropagation();
        if (cardEl) {
          var rctx = projectContext(cardEl);
          if (rctx) delete reworkTotalCache[rctx.projectId];
          refreshProject(cardEl, { force: true });
        }
        return;
      }
      var keyEl = target.closest ? target.closest('[data-ovw-key]') : null;
      if (keyEl && cardEl) {
        var key = keyEl.getAttribute('data-ovw-key');
        var action = counterActionForKey(key);
        if (action) {
          e.preventDefault();
          e.stopPropagation();
          var def = FIELD_MAP[key];
          if (action.type === 'stream') {
            var streamUrl = buildProjectDataUrl(projectContext(cardEl), action.mode);
            if (streamUrl) location.href = streamUrl;
          } else if (action.type === 'filter') {
            jumpToProjectWithFilter(cardEl, action.code, def ? def.label : key);
          }
        }
      }
    });
    summary.addEventListener('mouseenter', function () { applyTheme(summary); });

    var anchor = findInsertAnchor(card);
    if (!anchor) return null;
    anchor.parent.insertBefore(summary, anchor.before);
    applyTheme(summary);
    applySelectedState(card, context, summary);
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
    try { var u = new URL(target, location.origin); target = u.origin + u.pathname; } catch (e) {}
    location.href = target;
  }

  function closeBtnHtml(summaryEl) {
    if (summaryEl.dataset.ovwManual !== '1') return '';
    return '<button type="button" class="ovw-close" title="关闭此卡统计">' + ICON_CLOSE + '</button>';
  }
  function selectBtnHtml(summaryEl) {
    if (!summaryEl || !summaryEl.dataset) return '';
    var pid = summaryEl.dataset.projectId;
    if (!pid) return '';
    var on = isProjectSelected(pid);
    return '<button type="button" class="ovw-select" title="选中此项目（配合「仅扫描选中」使用）" aria-pressed="' + (on ? 'true' : 'false') + '"></button>';
  }

  function renderSummary(summaryEl, agg, loading, error) {
    if (!summaryEl) return;
    applyTheme(summaryEl);
    summaryEl.setAttribute('aria-busy', loading ? 'true' : 'false');
    var pidForSel = summaryEl.dataset ? summaryEl.dataset.projectId : null;
    if (pidForSel) {
      if (isProjectSelected(pidForSel)) summaryEl.classList.add('is-selected');
      else summaryEl.classList.remove('is-selected');
    }

    if (error) {
      summaryEl.innerHTML = selectBtnHtml(summaryEl) +
        '<button type="button" class="ovw-retry">统计失败，点击重试</button>' + closeBtnHtml(summaryEl);
      var retryBtn = summaryEl.querySelector('.ovw-retry');
      if (retryBtn) retryBtn.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation();
        var card = summaryEl.closest(CONFIG.cardSelector);
        if (card) {
          var rctx = projectContext(card);
          if (rctx) delete reworkTotalCache[rctx.projectId];
          refreshProject(card, { force: true });
        }
      });
      return;
    }
    if (!agg) {
      summaryEl.innerHTML = selectBtnHtml(summaryEl) + '<div class="ovw-skeleton"><span></span><span></span></div>';
      return;
    }

    var pid = summaryEl.dataset ? summaryEl.dataset.projectId : null;
    var displayAgg = agg;
    if (pid && visibleFields.indexOf('reworkTotal') !== -1 && reworkTotalCache[pid]) {
      displayAgg = Object.assign({}, agg);
      displayAgg.counts = Object.assign({}, agg.counts);
      displayAgg.counts.reworkTotal = reworkTotalCache[pid].count;
    }

    var barDefs = [], statDefs = [];
    for (var i = 0; i < visibleFields.length; i++) {
      var def = FIELD_MAP[visibleFields[i]];
      if (!def) continue;
      if (def.kind === 'percent') barDefs.push(def); else statDefs.push(def);
    }
    var total = Number(displayAgg.total) || 0;
    var html = selectBtnHtml(summaryEl);

    if (barDefs.length) {
      html += '<div class="ovw-bars">';
      for (var b = 0; b < barDefs.length; b++) {
        var bd = barDefs[b];
        var pct = total ? computePercent(bd, displayAgg) : 0;
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
        var val = computeFieldValue(sd, displayAgg);
        var statAction = counterActionForKey(sd.key);
        html += '<div class="ovw-stat' + (statAction ? '' : ' ovw-stat--static') + '" data-ovw-key="' + sd.key + '" style="--ovw-c:' + sd.color + '">' +
                  '<span class="ovw-stat__num">' + escapeHtml(String(val)) + '</span>' +
                  '<span class="ovw-stat__label">' + escapeHtml(sd.label) + '</span>' +
                '</div>';
      }
      html += '</div>';
    }
    if (!barDefs.length && !statDefs.length) {
      html += '<div class="ovw-empty">未选择统计字段，可在顶部「统计字段」中开启</div>';
    }
    html += '<button type="button" class="ovw-refresh" title="刷新">' + ICON_REFRESH + '</button>';
    html += closeBtnHtml(summaryEl);

    summaryEl.innerHTML = html;

    if (pid && visibleFields.indexOf('reworkTotal') !== -1 && !reworkTotalInflight[pid]) {
      var cached = reworkTotalCache[pid];
      var stale = !cached || (Date.now() - cached.ts) >= CONFIG.reworkTotalCacheTtlMs;
      if (stale) {
        var card = summaryEl.closest(CONFIG.cardSelector);
        if (card) triggerReworkTotalFetch(card, summaryEl);
      }
    }
  }

  function renderSummaryManual(summaryEl) {
    if (!summaryEl) return;
    applyTheme(summaryEl);
    summaryEl.innerHTML = selectBtnHtml(summaryEl) + '<button type="button" class="ovw-load-btn">点击统计本项目</button>';
    var btn = summaryEl.querySelector('.ovw-load-btn');
    if (!btn) return;
    ['mousedown', 'mouseup', 'pointerdown'].forEach(function (ev) {
      btn.addEventListener(ev, function (e) { e.stopPropagation(); });
    });
    btn.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      var card = summaryEl.closest(CONFIG.cardSelector);
      if (!card) return;
      var ctx = projectContext(card);
      if (ctx) markProjectOn(ctx.projectId);
      summaryEl.dataset.ovwManual = '1';
      renderSummary(summaryEl, null, true);
      detailPool.run(function () { return refreshProject(card, { force: true }); }).catch(function () {});
    });
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

  function positionFieldsPanel(toolbar) {
    if (!toolbar) return;
    var panel = toolbar.querySelector('.ovw-toolbar__panel');
    var button = toolbar.querySelector('.ovw-toolbar__btn--fields');
    if (!panel || panel.hidden || !button) return;
    panel.style.left = button.offsetLeft + 'px';
    panel.style.top = (button.offsetTop + button.offsetHeight + 6) + 'px';
    var rect = panel.getBoundingClientRect();
    var left = Math.max(8, Math.min(rect.left, window.innerWidth - rect.width - 8));
    var scale = toolbar.offsetWidth ? toolbar.getBoundingClientRect().width / toolbar.offsetWidth : 1;
    if (left !== rect.left) panel.style.left = (button.offsetLeft + (left - rect.left) / (scale || 1)) + 'px';
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
      '<button type="button" class="ovw-toolbar__btn ovw-toolbar__btn--fields">' +
        '<svg viewBox="0 0 16 16" width="14" height="14"><path fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" d="M2.5 4.5h11M4.5 8h7M6.5 11.5h3"/></svg>' +
        '<span>统计字段</span>' +
      '</button>' +
      '<button type="button" class="ovw-toolbar__btn ovw-toolbar__btn--repair">' +
        '<svg viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="M8 1.5A6.5 6.5 0 1 0 14.5 8 6.5 6.5 0 0 0 8 1.5zm0 12A5.5 5.5 0 1 1 13.5 8 5.5 5.5 0 0 1 8 13.5zM8.5 4h-1v5l4 2.4.5-.9-3.5-2.1z"/></svg>' +
        '<span>待返修/返工</span>' +
      '</button>' +
      '<div class="ovw-toolbar__panel" hidden>' +
        '<div class="ovw-toolbar__panel-head">' +
          '<span>功能与卡片显示</span>' +
          '<span class="ovw-toolbar__acts">' +
            '<button type="button" class="ovw-toolbar__hideall" title="所有卡片彻底不显示（含待点击态）">全部关闭</button>' +
            '<button type="button" class="ovw-toolbar__reset" title="恢复字段默认并重新显示所有卡片">恢复默认</button>' +
          '</span>' +
        '</div>' +
        '<div class="ovw-toolbar__panel-list"></div>' +
      '</div>';
    host.parentElement.insertBefore(toolbar, host.nextSibling);
    window.dispatchEvent(new CustomEvent('insta360-suite:overview-toolbar'));
    var btn = toolbar.querySelector('.ovw-toolbar__btn--fields');
    var repairBtn = toolbar.querySelector('.ovw-toolbar__btn--repair');
    var panel = toolbar.querySelector('.ovw-toolbar__panel');
    var listEl = toolbar.querySelector('.ovw-toolbar__panel-list');
    var resetBtn = toolbar.querySelector('.ovw-toolbar__reset');
    var hideAllBtn = toolbar.querySelector('.ovw-toolbar__hideall');

    hideAllBtnEl = hideAllBtn;
    updateHideAllBtn();

    function applyRepairToolVisibility() {
      if (!repairBtn) return;
      repairBtn.hidden = !repairToolVisible;
      if (!repairToolVisible) {
        repairBtn.classList.remove('is-open');
        var repairPanel = toolbar.querySelector('.ovw-repair-panel');
        if (repairPanel) repairPanel.hidden = true;
      }
    }
    applyRepairToolVisibility();

    if (repairBtn) {
      repairBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        toggleRepairPanel(toolbar, repairBtn);
      });
    }

    function renderList() {
      listEl.innerHTML = '';
      function appendFeatureSwitch(label, checked, onChange) {
        var featureRow = document.createElement('label');
        featureRow.className = 'ovw-toolbar__item ovw-toolbar__item--feature';
        var featureCb = document.createElement('input');
        featureCb.type = 'checkbox';
        featureCb.className = 'ovw-toolbar__switch-input';
        featureCb.checked = checked;
        var featureTrack = document.createElement('span');
        featureTrack.className = 'ovw-toolbar__switch';
        var featureText = document.createElement('span');
        featureText.textContent = label;
        featureCb.addEventListener('change', function () { onChange(!!featureCb.checked); });
        featureRow.appendChild(featureCb);
        featureRow.appendChild(featureTrack);
        featureRow.appendChild(featureText);
        listEl.appendChild(featureRow);
      }

      appendFeatureSwitch('显示待返修/返工', repairToolVisible, function (enabled) {
        repairToolVisible = enabled;
        saveRepairToolVisible(repairToolVisible);
        applyRepairToolVisibility();
      });
      appendFeatureSwitch('显示项目权限', window.__INSTA360_SUITE__.featureEnabled('project-permissions'), function (enabled) {
        window.__INSTA360_SUITE__.setFeatureEnabled('project-permissions', enabled);
      });
      appendFeatureSwitch('显示成员分配', window.__INSTA360_SUITE__.featureEnabled('member-assignment'), function (enabled) {
        window.__INSTA360_SUITE__.setFeatureEnabled('member-assignment', enabled);
      });

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
            if (checkbox.checked && d.key === 'reworkTotal') {
              document.querySelectorAll(CONFIG.cardSelector).forEach(function (c) {
                var s = c.querySelector('.ovw-summary');
                if (s) triggerReworkTotalFetch(c, s);
              });
            }
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
    function openPanel() { renderList(); updateHideAllBtn(); panel.hidden = false; btn.classList.add('is-open'); positionFieldsPanel(toolbar); }
    function closePanel() { panel.hidden = true; btn.classList.remove('is-open'); }

    btn.addEventListener('click', function (e) { e.stopPropagation(); if (panel.hidden) openPanel(); else closePanel(); });
    resetBtn.addEventListener('click', function (e) { e.stopPropagation(); restoreAll(); renderList(); });
    hideAllBtn.addEventListener('click', function (e) { e.stopPropagation(); if (allHidden) showAllCards(); else hideAllCards(); });

    panel.addEventListener('click', function (e) { e.stopPropagation(); });
    document.addEventListener('click', function (e) { if (!toolbar.contains(e.target)) closePanel(); }, true);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !panel.hidden) closePanel(); });
  }

  var repairCache = {};

  var REPAIR_CSV_HEADERS = ['项目名称', '项目 ID', '类型', '人员', '数量'];

  function csvCell(value) {
    return '"' + String(value == null ? '' : value).replace(/"/g, '""') + '"';
  }

  function repairExportRows(results) {
    var rows = [];
    var valid = Array.isArray(results) ? results : [];
    for (var i = 0; i < valid.length; i++) {
      var item = valid[i];
      if (!item || item.error || item.empty) continue;
      var kinds = [
        { key: 'repair', label: '待返修' },
        { key: 'rework', label: '待返工' }
      ];
      for (var k = 0; k < kinds.length; k++) {
        var kind = kinds[k];
        var count = Number(item[kind.key + 'TaskCount']) || 0;
        if (count <= 0) continue;
        var people = Array.isArray(item[kind.key]) ? item[kind.key] : [];
        var namedPeople = people.filter(function (person) {
          return person && person.name != null && !isNumericId(person.name);
        });
        var namedCount = 0;
        for (var p = 0; p < namedPeople.length; p++) {
          var personCount = Number(namedPeople[p].count) || 0;
          if (personCount <= 0) continue;
          namedCount += personCount;
          rows.push([
            item.name || '',
            item.projectId == null ? '' : item.projectId,
            kind.label,
            namedPeople[p].name,
            personCount
          ]);
        }
        var unknownCount = Math.max(0, count - namedCount);
        if (unknownCount > 0) {
          rows.push([
            item.name || '',
            item.projectId == null ? '' : item.projectId,
            kind.label,
            '未获取姓名',
            unknownCount
          ]);
        }
      }
    }
    return rows;
  }

  function buildRepairCsv(results) {
    var rows = [REPAIR_CSV_HEADERS].concat(repairExportRows(results));
    return '\ufeff' + rows.map(function (row) {
      return row.map(csvCell).join(',');
    }).join('\r\n') + '\r\n';
  }

  function repairExportFileName() {
    var now = new Date();
    function pad(value) { return String(value).padStart(2, '0'); }
    return '待返修待返工人员_' + now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + '_' +
      pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds()) + '.csv';
  }

  function repairExportToast(message, type) {
    var suite = window.__INSTA360_SUITE__;
    if (suite && typeof suite.toast === 'function') suite.toast(message, type || 'info');
  }

  function syncRepairExportButton(panelEl) {
    if (!panelEl) return;
    var button = panelEl.querySelector('.ovw-repair-export');
    if (!button) return;
    var state = panelEl.__ovwRepairExport || {};
    var ready = state.complete === true && repairExportRows(state.results).length > 0;
    button.disabled = !ready;
    button.title = ready ? '导出当前扫描结果' : '扫描完成且有待返修/待返工任务后可导出';
  }

  function downloadRepairCsv(panelEl) {
    var state = panelEl && panelEl.__ovwRepairExport;
    var rows = state ? repairExportRows(state.results) : [];
    if (!state || !state.complete) {
      repairExportToast('请等待统计扫描完成后再导出', 'info');
      return;
    }
    if (!rows.length) {
      repairExportToast('当前范围没有可导出的待返修或待返工人员', 'info');
      return;
    }
    if (typeof Blob === 'undefined' || !window.URL || typeof window.URL.createObjectURL !== 'function') {
      repairExportToast('当前浏览器不支持 CSV 下载', 'error');
      return;
    }
    var blob = new Blob([buildRepairCsv(state.results)], { type: 'text/csv;charset=utf-8' });
    var url = window.URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = repairExportFileName();
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { window.URL.revokeObjectURL(url); }, 0);
  }

  function pendingCountFromCounts(counts) {
    if (!counts || typeof counts !== 'object') return null;
    return (Number(counts.REVIEWED_REJECTED) || 0)
      + (Number(counts.REWORK) || 0)
      + (Number(counts.REPAIR) || 0);
  }

  function repairScanPriorityFromCounts(counts) {
    if (!counts || typeof counts !== 'object') return 1;
    var pending = pendingCountFromCounts(counts);
    return pending > 0 ? 0 : 2;
  }

  function repairScanPriority(card) {
    var ctx = projectContext(card);
    var entry = ctx && cache[ctx.projectId];
    return repairScanPriorityFromCounts(entry && entry.aggregate && entry.aggregate.counts);
  }

  function cardName(card) {
    var t = card.querySelector('.ls-project-card__title-text');
    if (t && t.textContent) return t.textContent.trim();
    var t2 = card.querySelector('.ls-project-card__title');
    return t2 ? (t2.textContent || '').replace(/\s+/g, ' ').trim() : '未命名';
  }

  function extractPeople(task) {
    var out = []; var seen = {};
    function push(v) {
      if (v == null || v === '') return;
      if (typeof v === 'string' || typeof v === 'number') {
        var s = String(v).trim(); if (!s) return;
        if (seen[s]) return;
        seen[s] = 1;
        out.push(displayUser(s));
        return;
      }
      if (typeof v === 'object') {
        var nestedUser = v.user && typeof v.user === 'object' ? v.user : null;
        var name = v.username || v.name || v.displayName || v.display_name ||
                   v.nickname || v.email || v.full_name || v.fullName || v.login;
        if (!name && v.first_name != null) name = String(v.first_name) + String(v.last_name || '');
        if (!name && nestedUser) {
          name = nestedUser.username || nestedUser.name || nestedUser.displayName || nestedUser.display_name ||
                 nestedUser.nickname || nestedUser.email || nestedUser.full_name || nestedUser.fullName || nestedUser.login;
          if (!name && nestedUser.first_name != null) {
            name = String(nestedUser.first_name) + String(nestedUser.last_name || '');
          }
        }
        var idValue = v.id;
        if (idValue == null) idValue = v.user_id;
        if (idValue == null) idValue = v.userId;
        if (idValue == null && nestedUser) idValue = nestedUser.id != null ? nestedUser.id : nestedUser.user_id;
        if (idValue == null && (typeof v.user === 'string' || typeof v.user === 'number')) idValue = v.user;
        var idRaw = idValue != null ? String(idValue) : (name != null ? String(name) : '');
        if (!idRaw) return;
        if (seen[idRaw]) return;
        seen[idRaw] = 1;
        var label = null;
        if (idValue != null) label = nameOfId(idValue);
        if (!label && name != null) label = displayUser(name);
        if (!label && (typeof v.user === 'string' || typeof v.user === 'number')) label = displayUser(v.user);
        if (!label) label = idRaw;
        out.push(label);
      }
    }
    var keys = CONFIG.repairPeopleKeys;
    for (var i = 0; i < keys.length; i++) {
      var v = task[keys[i]];
      if (v == null) continue;
      if (Array.isArray(v)) {
        if (!v.length) continue;
        for (var j = 0; j < v.length; j++) push(v[j]);
        if (out.length) return out;
      } else {
        push(v);
        if (out.length) return out;
      }
    }
    var nestedPaths = [
      ['meta', 'annotators'], ['data', 'annotators'],
      ['meta', 'annotator'],  ['data', 'annotator'],
      ['meta', 'completed_by'], ['data', 'completed_by']
    ];
    for (var n = 0; n < nestedPaths.length; n++) {
      var obj = task;
      var ok = true;
      for (var m = 0; m < nestedPaths[n].length; m++) {
        if (obj == null || typeof obj !== 'object') { ok = false; break; }
        obj = obj[nestedPaths[n][m]];
      }
      if (!ok || obj == null) continue;
      if (Array.isArray(obj)) {
        if (!obj.length) continue;
        for (var q = 0; q < obj.length; q++) push(obj[q]);
        if (out.length) return out;
      } else {
        push(obj);
        if (out.length) return out;
      }
    }
    return out;
  }

  function taskStatusOf(task) {
    var stateKeys = ['currentStatus','current_status','workflowState','workflow_state',
                     'taskState','task_state','state','status'];
    var nested = (task && task.task && typeof task.task === 'object') ? task.task : null;
    var records = [task]; if (nested) records.push(nested);
    for (var i = 0; i < records.length; i++) {
      for (var j = 0; j < stateKeys.length; j++) {
        var v = records[i][stateKeys[j]];
        if (v == null || v === '') continue;
        var st = asStatus(v);
        if (st) return st;
      }
    }
    return null;
  }

  function isRepairState(st) {
    if (!st) return false;
    var s = String(st).toUpperCase();
    if (s === 'REVIEWED_REJECTED' || s === 'REPAIR') return true;
    return /REJECT/.test(s) && !/REWORK/.test(s);
  }
  function isReworkState(st) {
    if (!st) return false;
    return /REWORK/.test(String(st).toUpperCase());
  }

  async function collectRepairPeopleForProject(card, forceRefresh) {
    var ctx = projectContext(card);
    if (!ctx) return null;
    var name = cardName(card);

    if (!forceRefresh) {
      var cached = repairCache[ctx.projectId];
      if (cached && Date.now() - cached.ts < CONFIG.repairCacheTtlMs) {
        var d = cached.data;
        return {
          workspaceId: d.workspaceId || ctx.workspaceId,
          projectId: d.projectId, href: d.href || ctx.href, name: name,
          repair: d.repair, rework: d.rework,
          repairTaskCount: d.repairTaskCount, reworkTaskCount: d.reworkTaskCount,
          repairTaskIds: d.repairTaskIds, reworkTaskIds: d.reworkTaskIds,
          repairUnknownTaskIds: d.repairUnknownTaskIds, reworkUnknownTaskIds: d.reworkUnknownTaskIds,
          cardRejected: d.cardRejected,
          empty: d.empty, error: d.error
        };
      }
    }

    var entry = cache[ctx.projectId];
    var agg = entry && entry.aggregate;
    var cardRejected = 0;
    var pendingHint = null;
    if (agg && agg.counts) {
      var n1 = Number(agg.counts.REVIEWED_REJECTED) || 0;
      var n2 = Number(agg.counts.REWORK) || 0;
      var n3 = Number(agg.counts.REPAIR) || 0;
      cardRejected = n1;
      pendingHint = n1 + n2 + n3;
    }

    // 汇总可能缺少项目级待处理数，即使汇总为 0 也必须查询当前任务。
    var rows;
    try {
      var loaded = await Promise.all([
        loadUserDirectory(),
        loadPendingTasksShared(ctx.projectId, ctx.workspaceId, pendingHint, !!forceRefresh)
      ]);
      rows = loaded[1];
    } catch (e) {
      return {
        workspaceId: ctx.workspaceId,
        projectId: ctx.projectId,
        href: ctx.href,
        name: name,
        error: String(e),
        cardRejected: cardRejected
      };
    }

    var needsProjectDirectory = rows.some(function(task) {
      return extractPeople(task).some(function(person) { return isNumericId(person); });
    });
    if (needsProjectDirectory) await loadProjectUserDirectory(ctx.projectId);

    var repairMap = {}, reworkMap = {};
    var repairTaskIds = [], reworkTaskIds = [];
    var repairUnknownTaskIds = [], reworkUnknownTaskIds = [];
    var repairTaskCount = 0, reworkTaskCount = 0;

    var taskAnnotatorMap = loadTaskAnnotatorMap();

    for (var i = 0; i < rows.length; i++) {
      var t = rows[i];
      var st = taskStatusOf(t);
      if (!isRepairState(st) && !isReworkState(st)) continue;

      var taskId = t.id != null ? String(t.id) : (t.taskId != null ? String(t.taskId) : null);

      var pp = extractPeople(t);
      var finalPeople = [];
      var unresolvedPerson = pp.length === 0;

      for (var p = 0; p < pp.length; p++) {
        var person = pp[p];
        if (isNumericId(person) && taskId && taskAnnotatorMap[taskId]) {
          finalPeople.push(taskAnnotatorMap[taskId]);
        } else if (isNumericId(person)) {
          unresolvedPerson = true;
        } else {
          finalPeople.push(person);
        }
      }

      if (finalPeople.length === 0 && taskId && taskAnnotatorMap[taskId]) {
        finalPeople.push(taskAnnotatorMap[taskId]);
        unresolvedPerson = false;
      }

      var seenPeople = {};
      var uniquePeople = [];
      for (var f = 0; f < finalPeople.length; f++) {
        if (!seenPeople[finalPeople[f]]) {
          seenPeople[finalPeople[f]] = 1;
          uniquePeople.push(finalPeople[f]);
        }
      }

      if (isRepairState(st)) {
        repairTaskCount++;
        if (repairTaskIds.length < 20) repairTaskIds.push(taskId || '(no-id)');
        if (unresolvedPerson && repairUnknownTaskIds.length < 20) repairUnknownTaskIds.push(taskId || '(no-id)');
        for (var r = 0; r < uniquePeople.length; r++) {
          repairMap[uniquePeople[r]] = (repairMap[uniquePeople[r]] || 0) + 1;
        }
      } else if (isReworkState(st)) {
        reworkTaskCount++;
        if (reworkTaskIds.length < 20) reworkTaskIds.push(taskId || '(no-id)');
        if (unresolvedPerson && reworkUnknownTaskIds.length < 20) reworkUnknownTaskIds.push(taskId || '(no-id)');
        for (var w = 0; w < uniquePeople.length; w++) {
          reworkMap[uniquePeople[w]] = (reworkMap[uniquePeople[w]] || 0) + 1;
        }
      }
    }

    var repairArr = Object.keys(repairMap).map(function(k) { return { name: k, count: repairMap[k] }; });
    repairArr.sort(function(a, b) { return b.count - a.count; });
    var reworkArr = Object.keys(reworkMap).map(function(k) { return { name: k, count: reworkMap[k] }; });
    reworkArr.sort(function(a, b) { return b.count - a.count; });

    var result = {
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId, href: ctx.href, name: name,
      repair: repairArr,
      rework: reworkArr,
      repairTaskCount: repairTaskCount,
      reworkTaskCount: reworkTaskCount,
      repairTaskIds: repairTaskIds,
      reworkTaskIds: reworkTaskIds,
      repairUnknownTaskIds: repairUnknownTaskIds,
      reworkUnknownTaskIds: reworkUnknownTaskIds,
      cardRejected: cardRejected,
      empty: (repairTaskCount + reworkTaskCount) === 0
    };
    repairCache[ctx.projectId] = { ts: Date.now(), data: result };
    return result;
  }

  function renderRepairShell(panelEl, scanCount, skipped) {
    if (!panelEl.__ovwRepairExport) {
      panelEl.__ovwRepairExport = { results: [], scanTotal: scanCount, done: 0, complete: false, scopeKey: '' };
    }
    var selCnt = selectedCount();
    if (panelEl.querySelector('.ovw-repair-head')) {
      var selCntEl = panelEl.querySelector('.ovw-repair-selcount');
      if (selCntEl) selCntEl.textContent = selCnt ? ('已选中 ' + selCnt + ' 个') : '未选中任何项目';
      var dimEl = panelEl.querySelector('.ovw-repair-dim');
      if (dimEl) {
        if (onlySelected && skipped) dimEl.textContent = '已忽略 ' + skipped + ' 个未选中';
        else dimEl.textContent = '';
      }
      var clearBtn = panelEl.querySelector('.ovw-repair-clear');
      if (clearBtn) clearBtn.disabled = !selCnt;
      var onlyCb = panelEl.querySelector('.ovw-repair-onlysel input');
      if (onlyCb) onlyCb.checked = onlySelected;
      syncRepairExportButton(panelEl);
      return;
    }

    var html = '';
    html += '<div class="ovw-repair-head">';
    html += '<span>待返修 / 待返工人员</span>';
    html += '<span class="ovw-repair-acts">';
    html += '<button type="button" class="ovw-repair-clear"' + (selCnt ? '' : ' disabled') + '>清空选择</button>';
    html += '<button type="button" class="ovw-repair-export" disabled>导出 CSV</button>';
    html += '<button type="button" class="ovw-repair-refresh">刷新</button>';
    html += '</span>';
    html += '</div>';

    html += '<div class="ovw-repair-toolbar">';
    html += '<label class="ovw-repair-onlysel">';
    html += '<input type="checkbox"' + (onlySelected ? ' checked' : '') + '>';
    html += '<span>仅扫描选中项目</span>';
    html += '</label>';
    html += '<span class="ovw-repair-selcount">' + (selCnt ? ('已选中 ' + selCnt + ' 个') : '未选中任何项目') + '</span>';
    if (onlySelected && skipped) {
      html += '<span class="ovw-repair-dim">已忽略 ' + skipped + ' 个未选中</span>';
    }
    html += '</div>';

    html += '<div class="ovw-repair-body"></div>';
    panelEl.innerHTML = html;

    var clearBtn = panelEl.querySelector('.ovw-repair-clear');
    var exportBtn = panelEl.querySelector('.ovw-repair-export');
    var refreshBtn = panelEl.querySelector('.ovw-repair-refresh');
    var onlyCb = panelEl.querySelector('.ovw-repair-onlysel input');
    var bodyEl = panelEl.querySelector('.ovw-repair-body');

    if (clearBtn) clearBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      clearProjectSelected();
      renderRepairPanel(panelEl, false);
    });
    if (exportBtn) exportBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      downloadRepairCsv(panelEl);
    });
    if (refreshBtn) refreshBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      renderRepairPanel(panelEl, true);
    });
    if (onlyCb) onlyCb.addEventListener('change', function (e) {
      e.stopPropagation();
      onlySelected = !!onlyCb.checked;
      saveOnlySelected(onlySelected);
      renderRepairPanel(panelEl, false);
    });
    if (bodyEl) bodyEl.addEventListener('click', function (e) {
      var el = e.target && e.target.closest ? e.target.closest('.ovw-copy-id') : null;
      if (!el || !bodyEl.contains(el)) return;
      e.stopPropagation();
      var text = el.getAttribute('data-clipboard-text');
      if (!text || !navigator.clipboard) return;
      navigator.clipboard.writeText(text).then(function() {
        var old = el.textContent;
        el.textContent = '已复制';
        setTimeout(function() { el.textContent = old; }, 1000);
      });
    });
    syncRepairExportButton(panelEl);
  }

  function shouldLoadRepairPanel(panelEl, forceRefresh, scopeKey) {
    return !!forceRefresh || !panelEl || !panelEl.dataset || panelEl.dataset.ovwLoaded !== '1'
      || panelEl.dataset.ovwScopeKey !== scopeKey;
  }

  function repairLaneHtml(item, kind) {
    var isRepair = kind === 'repair';
    var label = isRepair ? '待返修' : '待返工';
    var mode = isRepair ? 'repair' : 'rework';
    var count = Number(item[kind + 'TaskCount']) || 0;
    var people = item[kind] || [];
    var namedPeople = people.filter(function(x) {
      return x && x.name != null && !isNumericId(x.name);
    });
    var namedCount = namedPeople.reduce(function(total, x) {
      return total + (Number(x.count) || 0);
    }, 0);
    var ids = item[kind + 'TaskIds'] || [];
    var unknownIds = item[kind + 'UnknownTaskIds'] || [];
    var html = '<div class="ovw-repair-lane ovw-repair-lane--' + mode + '">';
    html += '<div class="ovw-repair-lane-head">';
    html += '<span class="ovw-repair-tag ovw-repair-tag--' + mode + '">' + label + '</span>';
    html += '<span class="ovw-repair-lane-count">' + count + ' 条</span>';
    html += '</div>';

    if (namedPeople.length) {
      html += '<div class="ovw-repair-people">' + namedPeople.map(function(x) {
        return '<span class="ovw-repair-person">' + escapeHtml(x.name) + '<b>' + x.count + '</b></span>';
      }).join('') + '</div>';
      if (namedCount < count) {
        var partialIds = unknownIds.slice(0, CONFIG.showTaskIdLimit).join(', ');
        html += '<div class="ovw-repair-none">另有 ' + (count - namedCount) + ' 条未获取到姓名';
        if (partialIds) {
          html += '，任务 ID：<span class="ovw-copy-id" data-clipboard-text="' + escapeHtml(partialIds) + '">' + escapeHtml(partialIds) + '</span>';
        }
        html += '</div>';
      }
    } else if (count > 0) {
      var shownIds = (unknownIds.length ? unknownIds : ids).slice(0, CONFIG.showTaskIdLimit).join(', ');
      html += '<div class="ovw-repair-none">未获取到姓名';
      if (shownIds) {
        html += '，任务 ID：<span class="ovw-copy-id" data-clipboard-text="' + escapeHtml(shownIds) + '">' + escapeHtml(shownIds) + '</span>';
      }
      html += '</div>';
    } else {
      html += '<div class="ovw-repair-none">无</div>';
    }
    html += '</div>';
    return html;
  }

  function repairProjectHtml(item) {
    var total = (Number(item.repairTaskCount) || 0) + (Number(item.reworkTaskCount) || 0);
    var html = '<div class="ovw-repair-item">';
    html += '<div class="ovw-repair-name"><span>' + escapeHtml(item.name) + '</span>';
    html += '<span class="ovw-repair-count">当前 ' + total + ' 条</span>';
    if (item.cardRejected && item.cardRejected !== total) {
      html += '<span class="ovw-repair-count" title="卡片汇总里的历史累计驳回数">历史驳回 ' + item.cardRejected + '</span>';
    }
    html += '</div>';
    html += '<div class="ovw-repair-grid">';
    html += repairLaneHtml(item, 'repair');
    html += repairLaneHtml(item, 'rework');
    html += '</div></div>';
    return html;
  }

  function repairFailureHtml(item) {
    var name = item && item.name ? item.name : ('项目 ' + ((item && item.projectId) || '未知'));
    var message = String((item && item.error) || '未知错误').replace(/^Error:\s*/, '');
    var html = '<div class="ovw-repair-failure">';
    html += '<strong>' + escapeHtml(name) + '</strong>';
    html += '<span>' + escapeHtml(message) + '</span>';
    html += '</div>';
    return html;
  }

  function renderRepairResults(bodyEl, results, scanTotal, done, complete) {
    if (!bodyEl) return;
    var valid = results.filter(function(r) { return r; });
    var withTask = valid.filter(function(r) { return !r.empty && !r.error; });
    var failures = valid.filter(function(r) { return r.error; });
    var emptyCount = valid.filter(function(r) { return r.empty; }).length;
    var errorCount = failures.length;
    var html = '<div class="ovw-repair-sum">';
    html += '<span>已完成 ' + done + '/' + scanTotal + '</span>';
    html += '<span>待处理项目 ' + withTask.length + '</span>';
    if (emptyCount) html += '<span class="ovw-repair-dim">无待处理 ' + emptyCount + '</span>';
    if (errorCount) html += '<span class="ovw-repair-err">读取失败 ' + errorCount + '</span>';
    html += '</div>';

    for (var f = 0; f < failures.length; f++) html += repairFailureHtml(failures[f]);
    for (var i = 0; i < withTask.length; i++) html += repairProjectHtml(withTask[i]);

    if (!complete && done < scanTotal) {
      html += '<div class="ovw-repair-loading">正在扫描，剩余 ' + (scanTotal - done) + ' 个项目</div>';
    } else if (!withTask.length && !errorCount) {
      html += '<div class="ovw-repair-empty">当前范围内没有待返修或待返工任务</div>';
    }
    bodyEl.innerHTML = html;
  }

  async function renderRepairPanel(panelEl, forceRefresh) {
    var allCards = [].slice.call(document.querySelectorAll(CONFIG.cardSelector));
    var cards = allCards;
    var skipped = 0;
    if (onlySelected) {
      var sel = loadSelected();
      cards = allCards.filter(function (c) {
        var ctx = projectContext(c);
        return ctx && sel[String(ctx.projectId)];
      });
      skipped = allCards.length - cards.length;
    }

    var scopeKey = JSON.stringify([onlySelected, cards.map(function(card) {
      var ctx = projectContext(card);
      return ctx ? [ctx.workspaceId, ctx.projectId] : null;
    }).sort()]);
    if (!shouldLoadRepairPanel(panelEl, forceRefresh, scopeKey)) {
      renderRepairShell(panelEl, cards.length, skipped);
      return;
    }
    panelEl.dataset.ovwLoaded = '1';
    panelEl.dataset.ovwScopeKey = scopeKey;
    // 在处理空选择前更新扫描标记，阻止旧请求覆盖当前范围的结果。
    var scanId = String(Date.now()) + ':' + String(Math.random());
    panelEl.dataset.ovwScanId = scanId;
    panelEl.__ovwRepairExport = {
      results: [],
      scanTotal: cards.length,
      done: 0,
      complete: false,
      scopeKey: scopeKey
    };

    if (forceRefresh) {
      for (var ci = 0; ci < cards.length; ci++) {
        var refreshCtx = projectContext(cards[ci]);
        if (!refreshCtx) continue;
        delete repairCache[refreshCtx.projectId];
        delete reworkTotalCache[refreshCtx.projectId];
        clearTaskRowsCache(refreshCtx.projectId, refreshCtx.workspaceId);
        clearPendingTaskRowsCache(refreshCtx.projectId, refreshCtx.workspaceId);
      }
    }

    cards = cards.map(function(card, index) {
      return { card: card, index: index, priority: repairScanPriority(card) };
    }).sort(function(a, b) {
      return a.priority - b.priority || a.index - b.index;
    }).map(function(item) { return item.card; });

    renderRepairShell(panelEl, cards.length, skipped);

    var bodyEl = panelEl.querySelector('.ovw-repair-body');
    if (!bodyEl) return;

    if (!cards.length) {
      bodyEl.innerHTML = '<div class="ovw-repair-empty ovw-repair-empty--warn">'
        + (onlySelected ? '尚未选中任何项目，请点击卡片右上角的复选框选择要扫描的项目'
                        : '当前页没有项目卡片')
        + '</div>';
      panelEl.__ovwRepairExport.complete = true;
      syncRepairExportButton(panelEl);
      return;
    }

    var results = new Array(cards.length);
    var done = 0;
    renderRepairResults(bodyEl, results, cards.length, done, false);
    panelEl.__ovwRepairExport.results = results;
    panelEl.__ovwRepairExport.done = done;
    syncRepairExportButton(panelEl);
    var tasks = cards.map(function (c, idx) {
      return repairPool.run(function () {
        return collectRepairPeopleForProject(c, forceRefresh).then(function (r) {
          results[idx] = r;
          return r;
        }).catch(function (e) {
          results[idx] = { projectId: null, name: cardName(c), error: String(e) };
          return null;
        }).then(function(r) {
          done++;
          if (panelEl.dataset.ovwScanId === scanId) {
            panelEl.__ovwRepairExport.results = results;
            panelEl.__ovwRepairExport.done = done;
            renderRepairResults(bodyEl, results, cards.length, done, false);
            syncRepairExportButton(panelEl);
          }
          return r;
        });
      });
    });
    await Promise.all(tasks);
    if (panelEl.dataset.ovwScanId !== scanId) return;
    panelEl.__ovwRepairExport.results = results;
    panelEl.__ovwRepairExport.done = done;
    panelEl.__ovwRepairExport.complete = true;
    renderRepairResults(bodyEl, results, cards.length, done, true);
    syncRepairExportButton(panelEl);
  }

  function toggleRepairPanel(toolbar, btnEl) {
    var panel = toolbar.querySelector('.ovw-repair-panel');
    if (panel) {
      if (panel.hidden) { panel.hidden = false; if (btnEl) btnEl.classList.add('is-open'); renderRepairPanel(panel, false); }
      else { panel.hidden = true; if (btnEl) btnEl.classList.remove('is-open'); }
      return;
    }
    panel = document.createElement('div');
    panel.className = 'ovw-repair-panel';
    toolbar.appendChild(panel);
    if (btnEl) btnEl.classList.add('is-open');
    renderRepairPanel(panel, false);

    document.addEventListener('click', function (e) {
      if (panel.hidden) return;
      var path = e.composedPath ? e.composedPath() : [];
      var clickedInside = path.some(function (el) { return el === panel || el === toolbar; });
      if (!clickedInside) {
        panel.hidden = true;
        if (btnEl) btnEl.classList.remove('is-open');
      }
    }, true);
  }

  function injectGlobalStatsToggle() {
    if (document.querySelector('.ovw-global-toggle')) return;
    var input = findSearchInput();
    if (!input) return;
    var host = input.closest('.ant-input-affix-wrapper') || input.closest('.ant-input-group-wrapper') || input.closest('.ant-input-search') || input.parentElement;
    if (!host || !host.parentElement) return;

    var totalCards = document.querySelectorAll(CONFIG.cardSelector).length;
    if (!shouldManualMode(totalCards)) return;

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ovw-global-toggle' + (statsEnabled ? ' is-on' : '');
    btn.textContent = statsEnabled ? '统计已开启（点此关闭全部）' : '开启全部统计（' + totalCards + '）';

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (statsEnabled) {
        statsEnabled = false; saveStatsFlag(false); saveStatsProjects({});
        btn.textContent = '开启全部统计（' + totalCards + '）';
        btn.classList.remove('is-on');
        document.querySelectorAll(CONFIG.cardSelector).forEach(function (c) {
          delete c.dataset.ovwMounted;
          var s = c.querySelector('.ovw-summary');
          if (s) s.dataset.ovwManual = '';
        });
        scanCards();
        return;
      }
      statsEnabled = true; saveStatsFlag(true);
      btn.textContent = '统计已开启（点此关闭全部）';
      btn.classList.add('is-on');
      allHidden = false; saveHideAll(false); updateHideAllBtn();
      document.querySelectorAll(CONFIG.cardSelector).forEach(function (c) {
        delete c.dataset.ovwMounted;
        var s = c.querySelector('.ovw-summary');
        if (s) s.classList.remove('ovw-summary--off');
      });
      scanCards();
    });

    var fieldsToolbar = host.parentElement.querySelector('.ovw-toolbar');
    if (fieldsToolbar && fieldsToolbar.nextSibling) host.parentElement.insertBefore(btn, fieldsToolbar.nextSibling);
    else host.parentElement.insertBefore(btn, host.nextSibling);
  }

  function mountCard(card) {
    var context = projectContext(card);
    if (!context) {
      var old = card.querySelector('.ovw-summary');
      if (old) old.remove();
      delete card.dataset.ovwMounted;
      return;
    }
    var anchor = findInsertAnchor(card);
    if (!anchor) { delete card.dataset.ovwMounted; return; }

    var summaryEl = card.querySelector('.ovw-summary');
    if (summaryEl) ensureSummaryInPlace(card, summaryEl);
    if (summaryEl) applySelectedState(card, context, summaryEl);

    if (summaryEl && card.dataset.ovwMounted === '1') {
      if (allHidden && !summaryEl.classList.contains('ovw-summary--off')) {
        summaryEl.dataset.ovwManual = '';
        summaryEl.classList.add('ovw-summary--off');
      }
      return;
    }

    card.dataset.ovwMounted = '1';
    if (!summaryEl) summaryEl = createSummary(card, context);
    if (!summaryEl) { delete card.dataset.ovwMounted; return; }

    if (allHidden) {
      summaryEl.dataset.ovwManual = '';
      summaryEl.classList.add('ovw-summary--off');
      return;
    }
    summaryEl.classList.remove('ovw-summary--off');

    var totalCards = document.querySelectorAll(CONFIG.cardSelector).length;
    var manual = shouldManualMode(totalCards) && !statsEnabled;
    if (manual && !isProjectOn(context.projectId)) {
      summaryEl.dataset.ovwManual = '';
      renderSummaryManual(summaryEl);
      return;
    }
    if (manual) summaryEl.dataset.ovwManual = '1';

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
      if (!summary || summary.classList.contains('ovw-summary--off')) continue;
      var ctx = projectContext(card);
      if (!ctx) continue;
      var entry = cache[ctx.projectId];
      if (entry && entry.aggregate) renderSummary(summary, entry.aggregate);
    }
  }

  var CSS_TEXT = [
    '.ls-projects-page__link:has(.ls-project-card){display:flex!important;flex-direction:column;align-self:stretch;}',
    '.ls-project-card{display:flex!important;flex-direction:column!important;justify-content:flex-start!important;height:auto!important;min-height:0!important;flex:1 0 auto!important;}',
    '.ls-project-card .ls-project-card__description{display:block!important;height:auto!important;min-height:40px!important;flex:1 0 auto!important;box-sizing:border-box;}',
    '.ls-project-card .ls-project-card__info{flex:0 0 auto!important;}',
    '.ls-project-card .ls-project-card__detail{display:none!important;}',
    '.ovw-summary{',
      'flex:0 0 auto!important;',
      '--ovw-label:#595959;--ovw-track:rgba(0,0,0,.08);--ovw-divider:rgba(0,0,0,.08);--ovw-hover:rgba(0,0,0,.045);--ovw-icon:rgba(0,0,0,.35);',
      'display:block;width:100%;max-width:100%;box-sizing:border-box;',
      'position:relative;margin:6px 0 0;padding:10px 16px 0;',
      'border-top:1px dashed var(--ovw-divider);color:#262626;',
      'font:12px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",Arial,sans-serif;',
    '}',
    '.ovw-summary--off{display:none !important;}',
    '.ovw-summary[data-ovw-theme="dark"]{--ovw-label:rgba(255,255,255,.80);--ovw-track:rgba(255,255,255,.18);--ovw-divider:rgba(255,255,255,.16);--ovw-hover:rgba(255,255,255,.10);--ovw-icon:rgba(255,255,255,.55);color:#fff;}',
    '.ovw-summary[aria-busy="true"]{opacity:.7;}',
    '.ovw-bars{display:flex;flex-direction:column;gap:8px;}',
    '.ovw-bar{display:grid;grid-template-columns:34px 1fr 40px;align-items:center;gap:9px;padding:1px 2px;border-radius:4px;cursor:default;}',
    '.ovw-bar[data-ovw-key]{cursor:pointer;}',
    '.ovw-bar[data-ovw-key]:hover{background:var(--ovw-hover);}',
    '.ovw-bar__label{font-size:11.5px;font-weight:500;color:var(--ovw-label);white-space:nowrap;}',
    '.ovw-bar__track{position:relative;height:5px;border-radius:3px;background:var(--ovw-track);overflow:hidden;}',
    '.ovw-bar__fill{display:block;height:100%;border-radius:3px;background:var(--ovw-c,#52c41a);transition:width .35s ease;}',
    '.ovw-bar__val{font-size:12px;font-weight:700;text-align:right;color:var(--ovw-c,#52c41a);font-variant-numeric:tabular-nums;}',
    '.ovw-stats{display:grid;gap:2px;margin-top:10px;}',
    '.ovw-stat{display:flex;flex-direction:column;align-items:center;gap:1px;padding:3px 0;border-radius:6px;cursor:pointer;transition:background .15s ease;}',
    '.ovw-stat:hover{background:var(--ovw-hover);}',
    '.ovw-stat--static{cursor:default;}',
    '.ovw-stat--static:hover{background:transparent;}',
    '.ovw-stat__num{font-size:15px;font-weight:700;line-height:1.15;color:var(--ovw-c,#1677ff);font-variant-numeric:tabular-nums;}',
    '.ovw-stat__label{font-size:10.5px;font-weight:500;color:var(--ovw-label);white-space:nowrap;}',
    '.ovw-summary[data-ovw-theme="dark"] .ovw-stat__num,',
    '.ovw-summary[data-ovw-theme="dark"] .ovw-bar__val{filter:brightness(1.28) saturate(1.05);}',
    '.ovw-summary[data-ovw-theme="dark"] .ovw-bar__fill{filter:brightness(1.18) saturate(1.05);}',
    '.ovw-empty{padding:4px 0;font-size:11.5px;color:var(--ovw-label);text-align:center;}',

    '.ovw-select{position:absolute;top:8px;right:8px;display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;padding:0;border:1.5px solid var(--ovw-icon);border-radius:4px;background:transparent;cursor:pointer;opacity:0;transition:opacity .15s ease,border-color .15s ease,background .15s ease;}',
    '.ovw-summary:hover .ovw-select,.ovw-summary.is-selected .ovw-select{opacity:1;}',
    '.ovw-select:hover{border-color:#1677ff;}',
    '.ovw-summary.is-selected .ovw-select{background:#1677ff;border-color:#1677ff;}',
    '.ovw-summary.is-selected .ovw-select::after{content:"";position:absolute;left:4px;top:0.5px;width:4.5px;height:8.5px;border:solid #fff;border-width:0 1.8px 1.8px 0;transform:rotate(45deg);}',
    '.ovw-card--sel{outline:2px solid #1677ff;outline-offset:1px;border-radius:8px;}',

    '.ovw-refresh{position:absolute;top:8px;right:30px;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;padding:0;border:0;border-radius:4px;background:transparent;color:var(--ovw-icon);cursor:pointer;opacity:0;transition:opacity .15s ease,color .15s ease,background .15s ease,right .15s ease;}',
    '.ovw-summary:hover .ovw-refresh{opacity:1;}',
    '.ovw-refresh:hover{background:rgba(22,119,255,.14);color:#1677ff;}',
    '.ovw-summary[data-ovw-manual="1"] .ovw-refresh{right:52px;}',
    '.ovw-close{position:absolute;top:8px;right:30px;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;padding:0;border:0;border-radius:4px;background:transparent;color:var(--ovw-icon);cursor:pointer;opacity:0;transition:opacity .15s ease,color .15s ease,background .15s ease;}',
    '.ovw-summary:hover .ovw-close{opacity:1;}',
    '.ovw-close:hover{background:rgba(255,77,79,.14);color:#ff4d4f;}',
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

    '.ovw-toolbar{position:relative;display:inline-block;vertical-align:middle;margin-left:8px;font:14px/1.5 Roboto,Arial,sans-serif;white-space:nowrap;flex:0 0 auto;}',
    '.ovw-toolbar__btn{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 12px;margin-left:8px;border:1px solid #d9d9d9;border-radius:6px;background:#fff;color:rgba(0,0,0,.88);cursor:pointer;font-size:13px;line-height:1;white-space:nowrap;transition:all .15s ease;font-family:inherit;}',
    '.ovw-toolbar__btn[hidden]{display:none!important;}',
    '.ovw-toolbar__btn:hover,.ovw-toolbar__btn.is-open{color:#1677ff;border-color:#1677ff;background:rgba(22,119,255,.03);}',
    '.ovw-toolbar__panel{position:absolute;top:calc(100% + 6px);left:8px;right:auto;z-index:1000000;width:320px;max-width:calc(100vw - 16px);min-width:0;box-sizing:border-box;padding:0;border:1px solid rgba(0,0,0,.06);border-radius:10px;background:#fff;box-shadow:0 8px 28px rgba(0,0,0,.13);overflow:hidden;}',
    '.ovw-toolbar__panel-head{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px 14px 8px;font-size:12px;color:#8c8c8c;border-bottom:1px solid rgba(0,0,0,.04);}',
    '.ovw-toolbar__acts{display:inline-flex;align-items:center;gap:10px;flex:0 0 auto;}',
    '.ovw-toolbar__reset{border:0;background:transparent;color:#1677ff;cursor:pointer;font-size:12px;padding:0;font-family:inherit;}',
    '.ovw-toolbar__hideall{border:0;background:transparent;color:#8c8c8c;cursor:pointer;font-size:12px;padding:0;font-family:inherit;transition:all .15s ease;border-radius:4px;}',
    '.ovw-toolbar__hideall:hover{color:#ff4d4f;}',
    '.ovw-toolbar__hideall.is-on{background:#fa8c16;color:#fff;padding:1px 8px;border-radius:4px;font-weight:600;box-shadow:0 1px 4px rgba(250,140,22,.35);}',
    '.ovw-toolbar__hideall.is-on:hover{background:#d46b08;color:#fff;}',
    '.ovw-toolbar__panel-list{max-height:340px;overflow-y:auto;padding:4px 0;}',
    '.ovw-toolbar__item{display:flex;align-items:center;gap:9px;padding:7px 14px;cursor:pointer;font-size:13px;color:rgba(0,0,0,.88);}',
    '.ovw-toolbar__item:hover{background:rgba(22,119,255,.05);}',
    '.ovw-toolbar__item--feature{padding-top:10px;padding-bottom:10px;border-bottom:1px solid rgba(0,0,0,.06);}',
    '.ovw-toolbar__switch-input{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;}',
    '.ovw-toolbar__switch{position:relative;display:inline-block;width:32px;height:18px;border-radius:9px;background:#bfbfbf;box-shadow:inset 0 0 0 1px rgba(0,0,0,.04);transition:background .15s ease;flex:0 0 32px;}',
    '.ovw-toolbar__switch::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.25);transition:transform .15s ease;}',
    '.ovw-toolbar__switch-input:checked+.ovw-toolbar__switch{background:#1677ff;}',
    '.ovw-toolbar__switch-input:checked+.ovw-toolbar__switch::after{transform:translateX(14px);}',
    '.ovw-toolbar__switch-input:focus-visible+.ovw-toolbar__switch{outline:2px solid rgba(22,119,255,.3);outline-offset:2px;}',
    '.ovw-toolbar__dot{width:8px;height:8px;border-radius:50%;display:inline-block;flex:0 0 8px;}',

    '.ovw-global-toggle{display:inline-flex;align-items:center;height:32px;padding:0 14px;margin-left:8px;border:1px solid #1677ff;border-radius:6px;background:#1677ff;color:#fff;cursor:pointer;font-size:13px;font-family:inherit;white-space:nowrap;flex:0 0 auto;transition:all .15s ease;}',
    '.ovw-global-toggle:hover{background:#0958d9;border-color:#0958d9;}',
    '.ovw-global-toggle.is-on{background:#f5f5f5;color:#8c8c8c;border-color:#d9d9d9;}',
    '.ovw-global-toggle.is-on:hover{background:#ededed;border-color:#bfbfbf;color:#595959;}',

    '.ovw-filter-hint{position:fixed;top:80px;right:20px;z-index:1000002;display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:10px;background:#fff;border:1px solid rgba(22,119,255,.25);box-shadow:0 8px 24px rgba(22,119,255,.15);color:rgba(0,0,0,.88);font:13px/1.4 Roboto,Arial,sans-serif;max-width:420px;}',
    '.ovw-filter-hint__icon{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:50%;background:linear-gradient(180deg,#1677ff,#4096ff);color:#fff;flex:0 0 26px;}',
    '.ovw-filter-hint__text{flex:1;min-width:0;}',
    '.ovw-filter-hint__title{font-weight:600;font-size:13px;}',
    '.ovw-filter-hint__desc{font-size:11.5px;color:#8c8c8c;margin-top:2px;word-break:break-all;}',
    '.ovw-filter-hint__close{border:0;background:transparent;color:#8c8c8c;cursor:pointer;padding:2px 4px;font-size:16px;line-height:1;}',

    '.ovw-repair-panel{position:absolute;top:calc(100% + 6px);right:0;z-index:1000001;width:560px;max-width:calc(100vw - 24px);max-height:620px;overflow-y:auto;padding:12px 14px;border:1px solid rgba(0,0,0,.08);border-radius:8px;background:#fff;box-shadow:0 8px 28px rgba(0,0,0,.13);font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC",Arial,sans-serif;color:rgba(0,0,0,.88);}',
    '.ovw-repair-loading{padding:14px 0 4px;text-align:center;color:#8c8c8c;font-size:12px;}',
    '.ovw-repair-head{display:flex;align-items:center;gap:8px;padding-bottom:8px;margin-bottom:8px;border-bottom:1px solid rgba(0,0,0,.06);font-size:12px;color:#595959;}',
    '.ovw-repair-head>span:first-child{font-weight:600;color:rgba(0,0,0,.88);font-size:13px;}',
    '.ovw-repair-acts{margin-left:auto;display:inline-flex;gap:10px;align-items:center;}',
    '.ovw-repair-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding-bottom:8px;margin-bottom:8px;border-bottom:1px dashed rgba(0,0,0,.06);font-size:12px;color:#595959;}',
    '.ovw-repair-onlysel{display:inline-flex;align-items:center;gap:5px;cursor:pointer;user-select:none;}',
    '.ovw-repair-onlysel input{margin:0;cursor:pointer;}',
    '.ovw-repair-selcount{color:#1677ff;font-weight:500;}',
    '.ovw-repair-dim{color:#bfbfbf;}',
    '.ovw-repair-err{color:#ff4d4f;}',
    '.ovw-repair-clear{border:0;background:transparent;color:#8c8c8c;cursor:pointer;font-size:12px;padding:0;font-family:inherit;}',
    '.ovw-repair-clear:hover:not(:disabled){color:#ff4d4f;}',
    '.ovw-repair-clear:disabled{opacity:.45;cursor:default;}',
    '.ovw-repair-export{border:0;background:transparent;color:#1677ff;cursor:pointer;font-size:12px;padding:0;font-family:inherit;}',
    '.ovw-repair-export:hover:not(:disabled){color:#0958d9;}',
    '.ovw-repair-export:disabled{opacity:.45;cursor:default;}',
    '.ovw-repair-refresh{border:0;background:transparent;color:#1677ff;cursor:pointer;font-size:12px;padding:0;font-family:inherit;}',
    '.ovw-repair-refresh:hover{color:#0958d9;}',
    '.ovw-repair-sum{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:0 0 8px;margin-bottom:2px;border-bottom:1px solid rgba(0,0,0,.06);font-size:12px;color:#595959;}',
    '.ovw-repair-sum>span:first-child{font-weight:600;color:rgba(0,0,0,.88);}',
    '.ovw-repair-failure{display:grid;grid-template-columns:minmax(120px,auto) minmax(0,1fr);gap:10px;padding:9px 0;border-bottom:1px solid rgba(255,77,79,.14);font-size:12px;line-height:1.45;color:#cf1322;}',
    '.ovw-repair-failure strong{min-width:0;color:rgba(0,0,0,.88);font-weight:600;overflow-wrap:anywhere;}',
    '.ovw-repair-failure span{min-width:0;overflow-wrap:anywhere;}',
    '.ovw-repair-empty{padding:28px 0;text-align:center;color:#52c41a;font-size:13px;}',
    '.ovw-repair-empty--warn{color:#fa8c16;}',
    '.ovw-repair-item{padding:11px 0 12px;border-bottom:1px solid rgba(0,0,0,.06);}',
    '.ovw-repair-item:last-of-type{border-bottom:0;}',
    '.ovw-repair-name{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;font-weight:600;font-size:13px;color:rgba(0,0,0,.88);margin-bottom:8px;}',
    '.ovw-repair-name>span:first-child{min-width:0;overflow-wrap:anywhere;}',
    '.ovw-repair-count{font-weight:400;font-size:11.5px;color:#8c8c8c;}',
    '.ovw-repair-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:0;}',
    '.ovw-repair-lane{min-width:0;padding-right:14px;}',
    '.ovw-repair-lane+.ovw-repair-lane{padding-right:0;padding-left:14px;border-left:1px solid rgba(0,0,0,.06);}',
    '.ovw-repair-lane-head{display:flex;align-items:center;gap:7px;min-height:22px;margin-bottom:6px;}',
    '.ovw-repair-lane-count{font-size:11.5px;color:#8c8c8c;font-variant-numeric:tabular-nums;}',
    '.ovw-repair-tag{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;min-width:48px;height:20px;padding:0 6px;border-radius:4px;font-size:11px;font-weight:600;letter-spacing:0;text-decoration:none;}',
    'a.ovw-repair-tag:hover,a.ovw-repair-tag:focus{text-decoration:none;filter:brightness(.94);}',
    '.ovw-repair-tag--repair{background:rgba(255,77,79,.10);color:#cf1322;}',
    '.ovw-repair-tag--rework{background:rgba(250,140,22,.12);color:#d46b08;}',
    '.ovw-repair-people{display:flex;align-items:center;gap:5px;flex-wrap:wrap;min-width:0;color:rgba(0,0,0,.88);}',
    '.ovw-repair-person{display:inline-flex;align-items:center;gap:3px;max-width:100%;padding:2px 5px;border-radius:4px;background:rgba(0,0,0,.035);font-size:12px;overflow-wrap:anywhere;}',
    '.ovw-repair-person b{font-size:10.5px;font-weight:600;color:#8c8c8c;font-variant-numeric:tabular-nums;}',
    '.ovw-repair-none{min-width:0;color:#bfbfbf;font-size:12px;overflow-wrap:anywhere;}',
    '.ovw-copy-id{cursor:pointer;text-decoration:underline;}',
    '@media (max-width:640px){.ovw-repair-panel{right:-8px;width:calc(100vw - 24px);padding:11px 12px;}.ovw-repair-failure{grid-template-columns:minmax(0,1fr);gap:3px;}.ovw-repair-grid{grid-template-columns:minmax(0,1fr);gap:9px;}.ovw-repair-lane{padding-right:0;}.ovw-repair-lane+.ovw-repair-lane{padding:9px 0 0;border-left:0;border-top:1px solid rgba(0,0,0,.06);}}'
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
    for (var i = 0; i < panels.length; i++) if (panels[i].querySelector('.dm-filters')) return panels[i];
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
      var svg = b.querySelector('svg'); if (!svg) continue;
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
    var selectors = ['.dm-select__option', '.dm-dropdown__item', '.dm-dropdown__option', '.dm-list-item', '[role="option"]', '.dm-option', 'li.dm-option'];
    for (var s = 0; s < selectors.length; s++) {
      var els = document.querySelectorAll(selectors[s]);
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (el.offsetParent === null) continue;
        var txt = (el.textContent || '').replace(/__Cici__\S+/g, '').trim();
        if (matcher(txt)) { log('选中 option:', txt.slice(0, 30)); el.click(); await sleep(150); return true; }
      }
    }
    var all = document.querySelectorAll('div, li, span');
    for (var k = 0; k < all.length; k++) {
      var e = all[k];
      if (e.offsetParent === null) continue;
      if (e.children.length > 3) continue;
      var t = (e.textContent || '').replace(/__Cici__\S+/g, '').trim();
      if (t.length > 30) continue;
      if (matcher(t)) { log('兜底选中:', t); e.click(); await sleep(150); return true; }
    }
    return false;
  }
  async function autoFillFilter(intent) {
    var candidates = intent.candidates || [intent.filterValue || intent.code];
    log('自动筛选开始，候选值：', candidates);
    var btn = findFiltersButton();
    if (!btn) { log('未找到 Filters 按钮'); return false; }
    btn.click(); log('已点击 Filters');
    var panel = null;
    for (var i = 0; i < 20; i++) { await sleep(100); panel = findFilterPanel(); if (panel) break; }
    if (!panel) { log('面板未出现'); return false; }
    log('面板已打开');
    if (!hasFilterRow(panel)) {
      var addBtn = findAddFilterButton(panel);
      if (addBtn) {
        log('点击 Add Filter'); addBtn.click();
        for (var w = 0; w < 20; w++) { await sleep(100); if (hasFilterRow(panel)) break; }
      }
    }
    if (!hasFilterRow(panel)) { log('筛选行未出现'); return false; }
    log('筛选行存在');
    var fieldTrigger = findFieldTrigger(panel);
    if (fieldTrigger) {
      var fieldTxt = (fieldTrigger.textContent || '').replace(/__Cici__\S+/g, '').trim();
      log('当前字段：', fieldTxt);
      if (!/State|状态/i.test(fieldTxt)) {
        await selectOptionFromDropdown(fieldTrigger, function (t) { return /State|状态/i.test(t); });
        await sleep(200);
        fieldTrigger = findFieldTrigger(panel);
        if (fieldTrigger) log('切换后字段：', (fieldTrigger.textContent || '').replace(/__Cici__\S+/g, '').trim());
      }
    } else log('未找到字段触发器');
    var valueInput = findValueInput(panel);
    if (!valueInput) { log('未找到值输入框'); return false; }
    for (var ci = 0; ci < candidates.length; ci++) {
      var val = candidates[ci];
      log('尝试填入：', val);
      setNativeValue(valueInput, val);
      await sleep(150);
    }
    var applyBtn = findApplyButton(panel);
    if (applyBtn) { applyBtn.click(); log('已点击应用'); }
    else { valueInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); log('已回车提交'); }
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
        for (var i = 0; i < 30; i++) { if (findFiltersButton()) break; await sleep(200); }
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

  var active = false, observer = null, observerTarget = null, selfCheckTimer = null, scanTimer = null;

  function scheduleScan() {
    if (!active) return;
    if (scanTimer) return;
    scanTimer = setTimeout(function () {
      scanTimer = null;
      if (!active) return;
      try { scanCards(); injectFieldsToolbar(); injectGlobalStatsToggle(); } catch (e) {}
    }, CONFIG.mountDelayMs);
  }
  function findGridContainer() {
    var first = document.querySelector(CONFIG.cardSelector);
    if (!first) return null;
    return first.parentElement || null;
  }
  function ensureObserverTarget() {
    if (!observer) return;
    var grid = findGridContainer();
    if (!grid) return;
    if (observerTarget !== grid) {
      observer.disconnect();
      observer.observe(grid, { childList: true });
      observerTarget = grid;
      log('MutationObserver 目标更新为网格容器');
    }
  }
  function startSelfCheck() {
    if (selfCheckTimer) return;
    selfCheckTimer = setInterval(function () {
      if (!active) return;
      ensureObserverTarget();
      scanCards();
      injectFieldsToolbar();
      injectGlobalStatsToggle();
    }, CONFIG.selfCheckIntervalMs);
  }
  function stopSelfCheck() { if (selfCheckTimer) { clearInterval(selfCheckTimer); selfCheckTimer = null; } }

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
        ensureObserverTarget(); startSelfCheck();
        if (!observer) {
          observer = new MutationObserver(scheduleScan);
          ensureObserverTarget();
        }
      } else setTimeout(kick, 250);
    };
    kick();
  }
  function deactivate() {
    if (!active) return;
    active = false;
    if (observer) { observer.disconnect(); observer = null; observerTarget = null; }
    stopSelfCheck();
    stopDataScrapeObserver();
    if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
    document.querySelectorAll('.ovw-summary, .ovw-toolbar, .ovw-global-toggle, .ovw-repair-panel').forEach(function (el) {
      if (el.parentNode) el.parentNode.removeChild(el);
    });
    document.querySelectorAll('[data-ovw-mounted]').forEach(function (el) { delete el.dataset.ovwMounted; });
    document.querySelectorAll('.ovw-card--sel').forEach(function (el) { el.classList.remove('ovw-card--sel'); });
    cache = {};
    repairCache = {};
    taskRowsCache = {};
    taskRowsInflight = {};
    pendingTaskRowsCache = {};
    pendingTaskRowsInflight = {};
    reworkTotalCache = {};
    reworkTotalInflight = {};
    hideAllBtnEl = null;
    selectedMapCache = null;
    var style = document.getElementById('ovw-style');
    if (style && style.parentNode) style.parentNode.removeChild(style);
  }
  function checkRoute() {
    if (isListPage()) { activate(); stopDataScrapeObserver(); } else deactivate();
    if (isDataPage()) { addStyle(); runDataPageFilterExecutor(); startDataScrapeObserver(); }
    else stopDataScrapeObserver();
  }
  window.addEventListener('insta360-suite:route', function () { setTimeout(checkRoute, 0); });
  window.addEventListener('resize', function () { positionFieldsPanel(document.querySelector('.ovw-toolbar')); });

  if (DEBUG) {
    window.__OVW = {
      active: function () { return active; },
      page: function () { return isListPage() ? 'list' : (isDataPage() ? 'data' : 'other'); },
      clearRepairCache: function () { repairCache = {}; return '已清缓存'; },
      dumpRejected: async function () {
        var card = document.querySelector(CONFIG.cardSelector);
        if (!card) return null;
        var ctx = projectContext(card);
        if (!ctx) return null;
        var rows = await loadTasks(ctx.projectId, ctx.workspaceId);
        var r = 0, w = 0, p = 0;
        for (var i = 0; i < rows.length; i++) {
          var st = taskStatusOf(rows[i]);
          if (st === 'REVIEWED_REJECTED') r++;
          else if (st === 'REWORK') w++;
          else if (st === 'REPAIR') p++;
        }
        console.log('[概览] 项目 ' + ctx.projectId + ' 全量=' + rows.length +
          ' | REVIEWED_REJECTED=' + r + ' REWORK=' + w + ' REPAIR=' + p);
        return { total: rows.length, REVIEWED_REJECTED: r, REWORK: w, REPAIR: p };
      }
    };
    console.log('[概览] DEBUG 开启（v3.8.9 测试版）');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', checkRoute, { once: true });
  else checkRoute();
})();

/* MODULE: project-permissions */
(function () {
  'use strict';

  var suite = window.__INSTA360_SUITE__;
  if (!suite) return;

  var FIELDS = {
    reviewer: 'show_tasks_to_reviewer',
    annotator: 'show_tasks_to_annotator',
  };
  var state = new Map();
  var pending = new Set();
  var stateLoads = new Map();
  var panel = null;
  var entryButton = null;
  var focusedProjectId = null;
  var bulk = { field: null, done: 0, total: 0, failed: 0, changed: 0 };

  function visibleProjects() {
    var seen = new Set();
    var projects = [];
    document.querySelectorAll('.ls-project-card, [class*="project-card"]').forEach(function (card) {
      var id = suite.projectId(card);
      if (!id || seen.has(id)) return;
      seen.add(id);
      var name = suite.projectName(card);
      projects.push({ id: id, name: name });
      if (!state.has(id)) {
        state.set(id, { name: name, reviewer: null, annotator: null, loading: true, saving: null, errors: {} });
      } else {
        state.get(id).name = name || state.get(id).name;
      }
    });
    return projects;
  }

  function booleanValue(object, key) {
    return object && typeof object[key] === 'boolean' ? object[key] : null;
  }

  async function patchProject(id, body) {
    return suite.api('/api/projects/' + encodeURIComponent(id), { method: 'PATCH', body: body });
  }

  async function runConcurrent(items, worker, concurrency) {
    var cursor = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async function () {
      while (cursor < items.length) {
        var index = cursor++;
        await worker(items[index]);
      }
    }));
  }

  async function fetchStatesBatch(ids) {
    if (!ids.length) return;
    var chunks = [];
    for (var i = 0; i < ids.length; i += 50) chunks.push(ids.slice(i, i + 50));

    for (var c = 0; c < chunks.length; c++) {
      var chunk = chunks[c];
      var batched = false;
      try {
        var response = await suite.api('/api/projects?ids=' + chunk.join(',') +
          '&include=id,' + FIELDS.reviewer + ',' + FIELDS.annotator + '&page_size=' + chunk.length);
        var rows = Array.isArray(response) ? response : ((response && (response.results || response.projects)) || []);
        if (rows.length && (FIELDS.reviewer in rows[0] || FIELDS.annotator in rows[0])) {
          batched = true;
          rows.forEach(function (project) {
            var item = state.get(String(project.id));
            if (!item) return;
            item.reviewer = booleanValue(project, FIELDS.reviewer);
            item.annotator = booleanValue(project, FIELDS.annotator);
            item.loading = false;
            item.error = null;
          });
        }
      } catch (error) {
        console.warn('[Suite Permissions] batch load failed, falling back', error);
      }

      if (!batched) {
        await runConcurrent(chunk, async function (id) {
          var item = state.get(id);
          if (!item) return;
          try {
            var project = await suite.api('/api/projects/' + encodeURIComponent(id));
            item.reviewer = booleanValue(project, FIELDS.reviewer);
            item.annotator = booleanValue(project, FIELDS.annotator);
            item.error = null;
          } catch (error) {
            item.error = String(error.message || error);
          } finally {
            item.loading = false;
          }
        }, 4);
      }
      chunk.forEach(function (id) {
        var item = state.get(id);
        if (item) item.loading = false;
      });
      render();
    }
  }

  function switchButton(field, item) {
    var button = document.createElement('button');
    var error = item.errors && item.errors[field];
    var savingFields = Array.isArray(item.saving) ? item.saving : [item.saving];
    var loading = item.loading || savingFields.indexOf(field) !== -1;
    var value = item[field];
    var status = error ? 'error' : loading ? 'loading' : value === true ? 'on' : value === false ? 'off' : 'unknown';
    var label = field === 'reviewer' ? '审核员' : '标注员';
    button.type = 'button';
    button.className = 'ovw-suite-perm-switch';
    button.dataset.field = field;
    button.dataset.state = status;
    button.disabled = Boolean(item.saving || bulk.field);
    button.title = error ? label + '：保存失败 - ' + error : label + '：' + (value ? '已开启' : '已关闭');
    button.setAttribute('aria-pressed', value === true ? 'true' : value === false ? 'false' : 'mixed');
    button.innerHTML = '<span><i></i></span>';
    return button;
  }

  function updateEntryBadge() {
    if (!entryButton) return;
    var badge = entryButton.querySelector('.ovw-suite-tool__badge');
    if (!badge) return;
    var enabled = visibleProjects().reduce(function (count, project) {
      var item = state.get(project.id) || {};
      return count + (item.reviewer === true ? 1 : 0) + (item.annotator === true ? 1 : 0);
    }, 0);
    badge.textContent = String(enabled);
    badge.hidden = enabled === 0;
  }

  function render() {
    updateEntryBadge();
    if (!panel || panel.hidden) return;
    var list = panel.querySelector('.ovw-suite-perm-list');
    var info = panel.querySelector('.ovw-suite-perm-info');
    var projects = visibleProjects();
    list.innerHTML = '';
    if (!projects.length) {
      list.innerHTML = '<div class="ovw-suite-perm-empty">当前页未找到项目卡片</div>';
      info.textContent = '';
      return;
    }
    projects.forEach(function (project) {
      var item = state.get(project.id);
      var row = document.createElement('div');
      row.className = 'ovw-suite-perm-row';
      row.dataset.id = project.id;
      if (project.id === focusedProjectId) row.classList.add('is-focused');
      var name = document.createElement('div');
      name.className = 'ovw-suite-perm-name';
      name.title = item.name + ' #' + project.id;
      name.innerHTML = '<span>' + suite.escapeHtml(item.name) + '</span><small>#' + suite.escapeHtml(project.id) + '</small>';
      row.appendChild(name);
      row.appendChild(switchButton('reviewer', item));
      row.appendChild(switchButton('annotator', item));
      list.appendChild(row);
    });

    if (bulk.field) {
      info.innerHTML = '批量处理中 <b>' + bulk.done + '/' + bulk.total + '</b>' +
        (bulk.failed ? '，失败 <b class="is-error">' + bulk.failed + '</b>' : '');
    } else {
      var reviewerOn = 0;
      var annotatorOn = 0;
      projects.forEach(function (project) {
        var item = state.get(project.id);
        if (item.reviewer === true) reviewerOn++;
        if (item.annotator === true) annotatorOn++;
      });
      info.innerHTML = '本页 <b>' + projects.length + '</b> 个，审核员开 <b>' + reviewerOn + '</b>，标注员开 <b>' + annotatorOn + '</b>';
    }
    panel.querySelectorAll('[data-act]').forEach(function (button) { button.disabled = Boolean(bulk.field); });
  }

  async function setOne(id, field, next) {
    var item = state.get(id);
    if (!item || item.saving || bulk.field) return;
    var label = field === 'reviewer' ? '审核员' : '标注员';
    if (item[field] === next) {
      suite.toast(item.name + ' · ' + label + (next ? ' 已经开启' : ' 已经关闭'), 'success');
      return;
    }
    var previous = item[field];
    item[field] = next;
    item.saving = field;
    item.errors = item.errors || {};
    item.errors[field] = null;
    render();
    try {
      var body = {};
      body[FIELDS[field]] = next;
      await patchProject(id, body);
      suite.toast(item.name + ' · ' + label + (next ? ' 已开启' : ' 已关闭'), 'success');
    } catch (error) {
      item[field] = previous;
      item.errors[field] = String(error.message || error);
      suite.toast('保存失败：' + item.errors[field], 'error');
    } finally {
      item.saving = null;
      render();
    }
  }

  function toggleOne(id, field) {
    var item = state.get(id);
    if (!item) return;
    return setOne(id, field, item[field] !== true);
  }

  async function bulkToggle(field, value) {
    if (bulk.field) return;
    var ids = visibleProjects().map(function (project) { return project.id; });
    bulk = { field: field, done: 0, total: ids.length, failed: 0, changed: 0 };
    render();
    await runConcurrent(ids, async function (id) {
      var item = state.get(id);
      if (!item || item[field] === value) {
        bulk.done++;
        render();
        return;
      }
      var previous = item[field];
      item[field] = value;
      item.saving = field;
      item.errors[field] = null;
      render();
      try {
        var body = {};
        body[FIELDS[field]] = value;
        await patchProject(id, body);
        bulk.changed++;
      } catch (error) {
        item[field] = previous;
        item.errors[field] = String(error.message || error);
        bulk.failed++;
      } finally {
        item.saving = null;
        bulk.done++;
        render();
      }
    }, 4);
    var summary = { changed: bulk.changed, failed: bulk.failed, total: bulk.total };
    bulk = { field: null, done: 0, total: 0, failed: 0, changed: 0 };
    render();
    suite.toast('批量完成：' + summary.changed + ' 项已更新' + (summary.failed ? '，失败 ' + summary.failed + ' 项' : '') + '（共 ' + summary.total + ' 项）', summary.failed ? 'error' : 'success');
  }

  async function reload() {
    var projects = visibleProjects();
    projects.forEach(function (project) {
      var item = state.get(project.id);
      item.loading = true;
      item.error = null;
    });
    render();
    await fetchStatesBatch(projects.map(function (project) { return project.id; }));
    suite.toast('项目权限已刷新', 'success');
  }

  function positionPanel() {
    if (!panel || panel.hidden) return;
    var width = Math.min(440, window.innerWidth - 24);
    var rect = entryButton ? entryButton.getBoundingClientRect() : null;
    var left = rect
      ? Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))
      : Math.max(12, window.innerWidth - width - 12);
    panel.style.width = width + 'px';
    panel.style.left = left + 'px';
    panel.style.top = rect
      ? Math.min(rect.bottom + 8, window.innerHeight - Math.min(panel.offsetHeight || 500, window.innerHeight - 24) - 12) + 'px'
      : '12px';
  }

  function closePanel() {
    if (panel) panel.hidden = true;
    if (entryButton) entryButton.classList.remove('is-open');
    focusedProjectId = null;
  }

  function togglePanel() {
    ensurePanel();
    var opening = panel.hidden;
    panel.hidden = !opening;
    entryButton.classList.toggle('is-open', opening);
    if (!opening) return;
    focusedProjectId = null;
    render();
    positionPanel();
    var ids = visibleProjects().filter(function (project) {
      var item = state.get(project.id);
      return item && item.loading && !pending.has(project.id);
    }).map(function (project) { return project.id; });
    ids.forEach(function (id) { pending.add(id); });
    fetchStatesBatch(ids).finally(function () { ids.forEach(function (id) { pending.delete(id); }); });
  }

  function focusProjectRow(id) {
    setTimeout(function () {
      if (!panel || panel.hidden || focusedProjectId !== id) return;
      var row = panel.querySelector('.ovw-suite-perm-row[data-id="' + id + '"]');
      if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
    }, 0);
  }

  function ensureProjectState(project) {
    if (!project || !project.id) return null;
    var id = String(project.id);
    visibleProjects();
    if (!state.has(id)) {
      state.set(id, { name: project.name || ('项目 #' + id), reviewer: null, annotator: null, loading: true, saving: null, errors: {} });
    }
    return state.get(id);
  }

  function loadProjectState(project) {
    var item = ensureProjectState(project);
    if (!item) return Promise.reject(new Error('无法识别项目'));
    var id = String(project.id);
    if (stateLoads.has(id)) return stateLoads.get(id);

    item.loading = true;
    item.error = null;
    render();
    var request = (async function () {
      try {
        var response = await suite.api('/api/projects/' + encodeURIComponent(id));
        var reviewer = booleanValue(response, FIELDS.reviewer);
        var annotator = booleanValue(response, FIELDS.annotator);
        if (reviewer === null || annotator === null) throw new Error('项目权限字段缺失');
        item.reviewer = reviewer;
        item.annotator = annotator;
        item.error = null;
        return item;
      } catch (error) {
        item.error = String(error.message || error);
        throw error;
      } finally {
        item.loading = false;
        stateLoads.delete(id);
        render();
      }
    })();
    stateLoads.set(id, request);
    return request;
  }

  function openForProject(project) {
    if (!project || !project.id) return;
    var id = String(project.id);
    ensureProjectState(project);
    focusedProjectId = id;
    ensurePanel();
    panel.hidden = false;
    if (entryButton) entryButton.classList.add('is-open');
    render();
    positionPanel();
    focusProjectRow(id);
    loadProjectState(project).then(function () {
      render();
      focusProjectRow(id);
    }).catch(function () {
      suite.toast('读取项目权限失败，请稍后重试', 'error');
    });
  }

  function buildPermissionPatch(item, target) {
    var fields = [];
    var body = {};
    ['reviewer', 'annotator'].forEach(function (field) {
      var next = target[field] === true;
      body[FIELDS[field]] = next;
      if (item[field] !== next) fields.push(field);
    });
    return { fields: fields, body: body };
  }

  async function savePermissionsForProject(project, selectedFields) {
    var item = ensureProjectState(project);
    if (!item || item.saving || bulk.field) return;
    var id = String(project.id);
    if (item.loading) {
      try {
        await (stateLoads.get(id) || loadProjectState(project));
      } catch (error) {
        suite.toast('读取项目权限失败，请稍后重试', 'error');
        return;
      }
    }
    if (item.error) {
      suite.toast('读取项目权限失败，请稍后重试', 'error');
      return;
    }

    var fields = Array.isArray(selectedFields) ? selectedFields : [];
    var target = {
      reviewer: fields.indexOf('reviewer') !== -1,
      annotator: fields.indexOf('annotator') !== -1,
    };
    var patch = buildPermissionPatch(item, target);
    if (!patch.fields.length) {
      suite.toast(item.name + ' · 权限未发生变化', 'success');
      return;
    }

    var previous = { reviewer: item.reviewer, annotator: item.annotator };
    item.reviewer = target.reviewer;
    item.annotator = target.annotator;
    item.errors = item.errors || {};
    item.errors.reviewer = null;
    item.errors.annotator = null;
    item.saving = ['reviewer', 'annotator'];
    render();
    try {
      await patchProject(id, patch.body);
      suite.toast(item.name + ' · 项目权限已保存', 'success');
    } catch (error) {
      var message = String(error.message || error);
      item.reviewer = previous.reviewer;
      item.annotator = previous.annotator;
      patch.fields.forEach(function (field) { item.errors[field] = message; });
      suite.toast('保存失败：' + message, 'error');
    } finally {
      item.saving = null;
      render();
    }
  }

  function permissionContextChildren(project) {
    var item = ensureProjectState(project) || {};
    var disabled = item.loading || Boolean(item.error) || Boolean(item.saving);
    return [
      { key: 'reviewer', label: '审核员权限', selectable: true, selected: item.reviewer === true, disabled: disabled },
      { key: 'annotator', label: '标注员权限', selectable: true, selected: item.annotator === true, disabled: disabled },
      {
        key: 'apply',
        label: '保存权限',
        submitSelection: true,
        allowEmptySelection: true,
        disabled: disabled,
        onClick: function (targetProject, event, selected) {
          savePermissionsForProject(targetProject, selected);
        },
      },
      { key: 'panel', label: '打开权限面板', onClick: openForProject },
    ];
  }

  function setPermissionSubmenuButton(button, disabled) {
    if (!button) return;
    button.disabled = disabled;
    button.setAttribute('data-context-base-disabled', disabled ? 'true' : 'false');
  }

  function syncPermissionSubmenu(project, submenu) {
    if (!submenu) return;
    var item = ensureProjectState(project) || {};
    var disabled = item.loading || Boolean(item.error) || Boolean(item.saving);
    ['reviewer', 'annotator'].forEach(function (field) {
      var button = submenu.querySelector('[data-context-child="' + field + '"]');
      if (!button) return;
      var selected = item[field] === true;
      button.setAttribute('aria-checked', selected ? 'true' : 'false');
      button.classList.toggle('is-selected', selected);
      setPermissionSubmenuButton(button, disabled);
    });
    setPermissionSubmenuButton(submenu.querySelector('[data-context-child="apply"]'), disabled);
  }

  async function hydratePermissionSubmenu(project, submenu) {
    var request = loadProjectState(project);
    syncPermissionSubmenu(project, submenu);
    try {
      await request;
    } catch (error) {
      suite.toast('读取项目权限失败，请稍后重试', 'error');
    } finally {
      syncPermissionSubmenu(project, submenu);
    }
  }

  function ensurePanel() {
    if (panel && document.body.contains(panel)) return;
    panel = document.createElement('section');
    panel.className = 'ovw-suite-perm-panel';
    panel.hidden = true;
    panel.innerHTML =
      '<header><strong>项目权限</strong><span>工作区 ' + suite.escapeHtml(suite.workspaceId() || '') + '</span>' +
        '<button type="button" data-act="reload">刷新</button><button type="button" class="ovw-suite-perm-close" aria-label="关闭">×</button></header>' +
      '<div class="ovw-suite-perm-hint">开关即时保存，无需进入设置页。</div>' +
      '<div class="ovw-suite-perm-cols"><span>项目</span><span>审核员</span><span>标注员</span></div>' +
      '<div class="ovw-suite-perm-list"></div>' +
      '<footer><div class="ovw-suite-perm-info"></div>' +
        '<div class="ovw-suite-perm-actions">' +
          '<span>审核员</span><button type="button" data-act="rv-on">全开</button><button type="button" data-act="rv-off">全关</button>' +
          '<span>标注员</span><button type="button" data-act="an-on">全开</button><button type="button" data-act="an-off">全关</button>' +
        '</div></footer>';
    panel.addEventListener('click', function (event) {
      event.stopPropagation();
      var target = event.target;
      var switchElement = target.closest('.ovw-suite-perm-switch');
      if (switchElement) {
        var row = switchElement.closest('.ovw-suite-perm-row');
        if (row) toggleOne(row.dataset.id, switchElement.dataset.field);
        return;
      }
      if (target.closest('.ovw-suite-perm-close')) return closePanel();
      var action = target.closest('[data-act]');
      if (!action) return;
      if (action.dataset.act === 'reload') reload();
      if (action.dataset.act === 'rv-on') bulkToggle('reviewer', true);
      if (action.dataset.act === 'rv-off') bulkToggle('reviewer', false);
      if (action.dataset.act === 'an-on') bulkToggle('annotator', true);
      if (action.dataset.act === 'an-off') bulkToggle('annotator', false);
    });
    document.body.appendChild(panel);
  }

  function addStyle() {
    if (document.getElementById('ovw-suite-permissions-style')) return;
    var style = document.createElement('style');
    style.id = 'ovw-suite-permissions-style';
    style.textContent = [
      '.ovw-suite-perm-panel{position:fixed;z-index:2147483645;box-sizing:border-box;background:#fff;border:1px solid #dfe4ea;border-radius:8px;box-shadow:0 16px 44px rgba(15,23,42,.18);overflow:hidden;color:#1f2937;font:12.5px/1.4 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}',
      '.ovw-suite-perm-panel[hidden]{display:none}',
      '.ovw-suite-perm-panel header{display:grid;grid-template-columns:auto 1fr auto auto;align-items:center;gap:7px;padding:9px 12px;background:#f8fafc;border-bottom:1px solid #e9edf2}',
      '.ovw-suite-perm-panel header strong{font-size:13px}.ovw-suite-perm-panel header span{color:#94a3b8;font-size:11px}',
      '.ovw-suite-perm-panel button{font:inherit}.ovw-suite-perm-panel header button,.ovw-suite-perm-actions button{padding:3px 8px;border:1px solid #d9e0e8;border-radius:5px;background:#fff;color:#475569;cursor:pointer}',
      '.ovw-suite-perm-close{font-size:17px!important;border:0!important;background:transparent!important;padding:0 4px!important}',
      '.ovw-suite-perm-hint{padding:6px 12px;background:#fffbeb;border-bottom:1px solid #fde68a;color:#92400e;font-size:11px}',
      '.ovw-suite-perm-cols,.ovw-suite-perm-row{display:grid;grid-template-columns:minmax(0,1fr) 68px 68px;align-items:center;gap:8px}',
      '.ovw-suite-perm-cols{padding:6px 12px;background:#fbfcfd;border-bottom:1px solid #e9edf2;color:#94a3b8;font-size:10px;font-weight:650}.ovw-suite-perm-cols span:not(:first-child){text-align:center}',
      '.ovw-suite-perm-list{max-height:320px;overflow:auto}.ovw-suite-perm-row{height:32px;padding:0 12px;border-bottom:1px solid #f1f3f5}.ovw-suite-perm-row:hover{background:#f8fafc}',
      '.ovw-suite-perm-row.is-focused{background:#eff6ff;box-shadow:inset 3px 0 #3b82f6}',
      '.ovw-suite-perm-name{display:flex;gap:6px;min-width:0;align-items:baseline}.ovw-suite-perm-name span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ovw-suite-perm-name small{color:#aab2bd}',
      '.ovw-suite-perm-switch{display:flex;justify-content:center;padding:0;border:0;background:transparent;cursor:pointer}.ovw-suite-perm-switch>span{position:relative;width:30px;height:17px;border-radius:9px;background:#d1d5db}.ovw-suite-perm-switch i{position:absolute;top:2px;left:2px;width:13px;height:13px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .18s}.ovw-suite-perm-switch[data-state="on"]>span{background:#3b82f6}.ovw-suite-perm-switch[data-state="on"] i,.ovw-suite-perm-switch[data-state="loading"] i{transform:translateX(13px)}.ovw-suite-perm-switch[data-state="loading"]>span{background:#93c5fd}.ovw-suite-perm-switch[data-state="error"]>span{background:#fca5a5}',
      '.ovw-suite-perm-panel footer{padding:8px 12px 10px;background:#fafbfc;border-top:1px solid #e9edf2}.ovw-suite-perm-info{margin-bottom:7px;color:#6b7280;font-size:11px}.ovw-suite-perm-info b{color:#1f2937}.ovw-suite-perm-info .is-error{color:#b91c1c}',
      '.ovw-suite-perm-actions{display:grid;grid-template-columns:1fr auto auto;gap:5px;align-items:center}.ovw-suite-perm-actions span{color:#64748b;font-size:11px}.ovw-suite-perm-actions button:disabled{opacity:.5;cursor:not-allowed}',
      '.ovw-suite-perm-empty{padding:36px 12px;text-align:center;color:#a8b0bb}',
    ].join('');
    document.head.appendChild(style);
  }

  function toolbarOptions() {
    return {
      label: '项目权限',
      title: '批量控制审核员和标注员查看任务列表',
      icon: '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M12 6c-4 0-7.4 2.5-8.9 6 1.5 3.5 4.9 6 8.9 6s7.4-2.5 8.9-6C19.4 8.5 16 6 12 6zm0 9.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5z"/></svg>',
      badge: updateEntryBadge,
      onClick: function (button) { entryButton = button; togglePanel(); },
    };
  }

  function mount() {
    addStyle();
    entryButton = suite.addToolbarButton('permissions', toolbarOptions());
    ensurePanel();
    suite.addProjectContextAction('project-permissions', {
      label: '项目权限',
      children: permissionContextChildren,
      onSubmenuOpen: hydratePermissionSubmenu,
    });
  }

  function scan() {
    entryButton = suite.addToolbarButton('permissions', toolbarOptions()) || entryButton;
    if (panel && !panel.hidden) render();
  }

  function unmount() {
    closePanel();
    suite.removeProjectContextAction('project-permissions');
    suite.removeToolbarButton('permissions');
    entryButton = null;
    if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
    panel = null;
    state.clear();
    pending.clear();
    stateLoads.clear();
    bulk = { field: null, done: 0, total: 0, failed: 0, changed: 0 };
  }

  document.addEventListener('click', function (event) {
    if (!panel || panel.hidden) return;
    if (panel.contains(event.target) || (entryButton && entryButton.contains(event.target))) return;
    closePanel();
  }, true);
  window.addEventListener('resize', positionPanel);
  window.addEventListener('scroll', positionPanel, true);

  suite.register('project-permissions', {
    match: function () { return suite.listPage() && suite.featureEnabled('project-permissions'); },
    mount: mount,
    scan: scan,
    unmount: unmount,
  });
})();

/* MODULE: member-assignment */
(function () {
  'use strict';

  var suite = window.__INSTA360_SUITE__;
  if (!suite) return;

  var dialog = null;
  var overlay = null;
  var currentProject = null;
  var allUsers = [];
  var memberships = new Map();
  var initialRightIds = new Set();
  var pendingAddIds = new Set();
  var pendingRemoveIds = new Set();
  var leftSelected = new Set();
  var rightSelected = new Set();
  var mentionSelectedIds = new Set();
  var mentionSummary = null;
  var organizationCache = { id: null, loadedAt: 0, users: [] };
  var loading = false;
  var saving = false;
  var observer = null;
  var scanTimer = null;

  function projectListMatch() {
    return suite.listPage() && suite.featureEnabled('member-assignment');
  }

  function userId(value) {
    if (value == null) return null;
    if (typeof value === 'object') return value.id || value.pk || null;
    return value;
  }

  function displayName(user) {
    var full = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
    return full || user.username || user.email || ('用户 #' + user.id);
  }

  function normalizeUser(raw, membership) {
    var source = raw && raw.user && typeof raw.user === 'object'
      ? raw.user
      : (raw && typeof raw === 'object' ? raw : {});
    var role = membership && membership.role != null ? membership.role : source.role;
    var roleName = '';
    if (role && typeof role === 'object') roleName = role.name || role.title || '';
    else if (typeof role === 'string') roleName = role;
    roleName = roleName || (membership && (membership.role_name || membership.roleName)) || '';
    return {
      id: Number(userId(source)),
      username: source.username || '',
      first_name: source.first_name || '',
      last_name: source.last_name || '',
      email: source.email || '',
      roleName: roleName,
      active: !membership || membership.is_active !== false,
    };
  }

  async function currentOrganizationId() {
    var bodyId = document.body && (document.body.dataset.organizationId || document.body.dataset.orgId);
    if (bodyId) return bodyId;
    try {
      var who = await suite.api('/api/current-user/whoami');
      var id = userId(who && (who.active_organization || who.organization));
      if (!id && who && Array.isArray(who.organizations) && who.organizations.length) id = userId(who.organizations[0]);
      if (id) return id;
    } catch (error) {
      console.warn('[Suite Members] unable to read current organization', error);
    }
    return '1';
  }

  async function getOrganizationMembers() {
    var organizationId = await currentOrganizationId();
    if (organizationCache.id === String(organizationId) && Date.now() - organizationCache.loadedAt < 5 * 60 * 1000) {
      return organizationCache.users.slice();
    }
    var rows = [];
    var nextUrl = '/api/organizations/' + encodeURIComponent(organizationId) + '/memberships?page=1&page_size=100';
    var pages = 0;
    while (nextUrl) {
      var response = await suite.api(nextUrl);
      var pageRows = Array.isArray(response) ? response : ((response && response.results) || []);
      rows = rows.concat(pageRows);
      nextUrl = response && !Array.isArray(response) ? response.next : null;
      pages++;
      if (pages > 100) throw new Error('组织成员分页超过 100 页，已停止以避免死循环');
    }
    var map = new Map();
    rows.forEach(function (membership) {
      var normalized = normalizeUser(membership, membership);
      if (normalized.id && normalized.active) map.set(normalized.id, normalized);
    });
    var users = Array.from(map.values()).sort(function (a, b) {
      return displayName(a).localeCompare(displayName(b), 'zh-CN');
    });
    organizationCache = { id: String(organizationId), loadedAt: Date.now(), users: users.slice() };
    return users;
  }

  async function getProjectMembers(projectId) {
    var response = await suite.api('/api/projects/' + encodeURIComponent(projectId) + '/members?active=true');
    var rows = Array.isArray(response) ? response : ((response && (response.results || response.members)) || []);
    return rows.map(function (membership) {
      var rawUser = membership.user != null ? membership.user : (membership.user_id != null ? membership.user_id : membership);
      var id = Number(userId(rawUser));
      var membershipId = membership.membership_id || membership.project_membership_id ||
        (membership.user && typeof membership.user === 'object' ? membership.id : null);
      return { userId: id, membershipId: membershipId, raw: membership };
    }).filter(function (item) { return item.userId; });
  }

  async function addMembersToProject(projectId, ids) {
    if (!ids.length) return;
    await suite.api('/api/projects/' + encodeURIComponent(projectId) + '/members', {
      method: 'POST',
      body: { users: ids },
    });
  }

  async function removeMembersFromProject(projectId, ids) {
    if (!ids.length) return;
    try {
      await suite.api('/api/projects/' + encodeURIComponent(projectId) + '/members', {
        method: 'DELETE',
        body: { users: ids },
      });
      return;
    } catch (bulkError) {
      var failures = [];
      for (var i = 0; i < ids.length; i++) {
        var membership = memberships.get(ids[i]);
        var membershipId = membership && membership.membershipId;
        if (!membershipId) {
          failures.push('用户 #' + ids[i] + ' 缺少 membershipId');
          continue;
        }
        try {
          await suite.api('/api/projects/' + encodeURIComponent(projectId) + '/members/' + encodeURIComponent(membershipId), {
            method: 'DELETE',
          });
        } catch (error) {
          failures.push('用户 #' + ids[i] + '：' + (error.message || error));
        }
      }
      if (failures.length) throw new Error(failures.join('；'));
    }
  }

  function finalRightIds() {
    var ids = new Set(initialRightIds);
    pendingRemoveIds.forEach(function (id) { ids.delete(id); });
    pendingAddIds.forEach(function (id) { ids.add(id); });
    return ids;
  }

  function keywords(value) {
    return String(value || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  }

  function normalizeSearchValue(value) {
    return String(value || '').trim().toLowerCase().replace(/\s+/g, '');
  }

  function mentionNames(value) {
    var tokens = String(value || '').trim().split(/[\s,，;；]+/).filter(Boolean);
    if (!tokens.length || tokens.some(function (token) { return token.charAt(0) !== '@' || token.length < 2; })) return [];
    var seen = new Set();
    return tokens.map(function (token) { return normalizeSearchValue(token.slice(1)); }).filter(function (name) {
      if (!name || seen.has(name)) return false;
      seen.add(name);
      return true;
    });
  }

  function userAliases(user) {
    var values = [
      displayName(user),
      [user.first_name, user.last_name].filter(Boolean).join(''),
      [user.last_name, user.first_name].filter(Boolean).join(''),
      user.username,
      user.email,
      String(user.id),
    ];
    var seen = new Set();
    return values.map(normalizeSearchValue).filter(function (value) {
      if (!value || seen.has(value)) return false;
      seen.add(value);
      return true;
    });
  }

  function matches(user, query) {
    var mentions = mentionNames(query);
    if (mentions.length) {
      var aliases = userAliases(user);
      return mentions.some(function (name) { return aliases.indexOf(name) !== -1; });
    }
    var terms = keywords(query);
    if (!terms.length) return true;
    var haystack = [displayName(user), user.username, user.email, user.roleName, String(user.id)].join(' ').toLowerCase();
    var compactHaystack = normalizeSearchValue(haystack);
    return terms.every(function (term) {
      return haystack.indexOf(term) !== -1 || compactHaystack.indexOf(normalizeSearchValue(term)) !== -1;
    });
  }

  function filteredAssignableUsers(users, rightIds, query) {
    return users.filter(function (user) {
      return !rightIds.has(user.id) && matches(user, query);
    });
  }

  function allFilteredSelected(selection, users) {
    return users.length > 0 && users.every(function (user) { return selection.has(user.id); });
  }

  function setFilteredSelection(selection, users, selected) {
    users.forEach(function (user) {
      if (selected) selection.add(user.id); else selection.delete(user.id);
    });
    return selection;
  }

  function resolveMentionSelection(users, rightIds, query) {
    var names = mentionNames(query);
    if (!names.length) return null;
    var selectedIds = new Set();
    var assignedNames = [];
    var ambiguousNames = [];
    var missingNames = [];
    names.forEach(function (name) {
      var found = users.filter(function (user) { return userAliases(user).indexOf(name) !== -1; });
      if (!found.length) {
        missingNames.push(name);
      } else if (found.length > 1) {
        ambiguousNames.push(name);
      } else if (rightIds.has(found[0].id)) {
        assignedNames.push(name);
      } else {
        selectedIds.add(found[0].id);
      }
    });
    return {
      selectedIds: Array.from(selectedIds),
      assignedNames: assignedNames,
      ambiguousNames: ambiguousNames,
      missingNames: missingNames,
    };
  }

  function applyMentionSelection(query) {
    mentionSelectedIds.forEach(function (id) { leftSelected.delete(id); });
    mentionSelectedIds = new Set();
    mentionSummary = resolveMentionSelection(allUsers, finalRightIds(), query);
    if (mentionSummary) {
      mentionSummary.selectedIds.forEach(function (id) {
        if (!leftSelected.has(id)) mentionSelectedIds.add(id);
        leftSelected.add(id);
      });
    }
    renderLists();
  }

  function mentionStatusText() {
    if (!mentionSummary) return '';
    var parts = [];
    if (mentionSummary.selectedIds.length) parts.push('已匹配并选中 ' + mentionSummary.selectedIds.length + ' 人');
    if (mentionSummary.assignedNames.length) parts.push('已在项目中：' + mentionSummary.assignedNames.join('、'));
    if (mentionSummary.ambiguousNames.length) parts.push('存在同名，请手动选择：' + mentionSummary.ambiguousNames.join('、'));
    if (mentionSummary.missingNames.length) parts.push('未找到：' + mentionSummary.missingNames.join('、'));
    return parts.join('；');
  }

  function userById(id) {
    return allUsers.find(function (user) { return user.id === Number(id); });
  }

  function rowHtml(user, selected, change) {
    return '<button type="button" class="ovw-suite-assign-row' + (selected ? ' is-selected' : '') + '" data-user-id="' + user.id + '">' +
      '<span class="ovw-suite-assign-check">' + (selected ? '✓' : '') + '</span>' +
      '<span class="ovw-suite-assign-person"><strong>' + suite.escapeHtml(displayName(user)) + '</strong><small>' + suite.escapeHtml(user.email || user.username || ('#' + user.id)) + '</small></span>' +
      (user.roleName ? '<span class="ovw-suite-assign-role">' + suite.escapeHtml(user.roleName) + '</span>' : '') +
      (change ? '<span class="ovw-suite-assign-change is-' + change + '">' + (change === 'add' ? '待添加' : '待移除') + '</span>' : '') +
    '</button>';
  }

  function renderLists() {
    if (!dialog) return;
    var rightIds = finalRightIds();
    var leftQuery = dialog.querySelector('.ovw-suite-assign-search-left').value;
    var rightQuery = dialog.querySelector('.ovw-suite-assign-search-right').value;
    var leftUsers = filteredAssignableUsers(allUsers, rightIds, leftQuery);
    var rightUsers = Array.from(rightIds).map(userById).filter(Boolean).filter(function (user) { return matches(user, rightQuery); });
    var leftList = dialog.querySelector('.ovw-suite-assign-left');
    var rightList = dialog.querySelector('.ovw-suite-assign-right');
    leftList.innerHTML = leftUsers.length ? leftUsers.map(function (user) {
      return rowHtml(user, leftSelected.has(user.id), pendingRemoveIds.has(user.id) ? 'remove' : '');
    }).join('') : '<div class="ovw-suite-assign-empty">无匹配成员</div>';
    rightList.innerHTML = rightUsers.length ? rightUsers.map(function (user) {
      return rowHtml(user, rightSelected.has(user.id), pendingAddIds.has(user.id) ? 'add' : '');
    }).join('') : '<div class="ovw-suite-assign-empty">暂无已分配成员</div>';
    dialog.querySelector('.ovw-suite-assign-left-count').textContent = String(leftUsers.length);
    dialog.querySelector('.ovw-suite-assign-right-count').textContent = String(rightUsers.length);
    var selectAll = dialog.querySelector('.ovw-suite-assign-select-all');
    var selectedAll = allFilteredSelected(leftSelected, leftUsers);
    selectAll.textContent = selectedAll ? '取消全选' : '全选结果';
    selectAll.setAttribute('aria-pressed', selectedAll ? 'true' : 'false');
    selectAll.disabled = !leftUsers.length || loading || saving;
    dialog.querySelector('.ovw-suite-assign-add').disabled = !leftSelected.size || loading || saving;
    dialog.querySelector('.ovw-suite-assign-remove').disabled = !rightSelected.size || loading || saving;
    dialog.querySelector('.ovw-suite-assign-save').disabled = (!pendingAddIds.size && !pendingRemoveIds.size) || loading || saving;
    dialog.querySelector('.ovw-suite-assign-status').textContent = pendingAddIds.size || pendingRemoveIds.size
      ? '待添加 ' + pendingAddIds.size + ' 人，待移除 ' + pendingRemoveIds.size + ' 人'
      : (mentionStatusText() || '没有未保存的修改');
  }

  function resetChanges(projectMembers) {
    memberships = new Map();
    initialRightIds = new Set();
    projectMembers.forEach(function (item) {
      initialRightIds.add(item.userId);
      memberships.set(item.userId, item);
      if (!userById(item.userId)) {
        var raw = item.raw && item.raw.user && typeof item.raw.user === 'object' ? item.raw.user : item.raw;
        var normalized = normalizeUser(raw || { id: item.userId });
        if (normalized.id) allUsers.push(normalized);
      }
    });
    pendingAddIds = new Set();
    pendingRemoveIds = new Set();
    leftSelected = new Set();
    rightSelected = new Set();
    mentionSelectedIds = new Set();
    mentionSummary = null;
    allUsers.sort(function (a, b) { return displayName(a).localeCompare(displayName(b), 'zh-CN'); });
  }

  async function loadDialog() {
    loading = true;
    dialog.classList.add('is-loading');
    dialog.querySelector('.ovw-suite-assign-status').textContent = '正在加载组织成员和项目成员…';
    renderLists();
    try {
      var results = await Promise.all([getOrganizationMembers(), getProjectMembers(currentProject.id)]);
      allUsers = results[0];
      resetChanges(results[1]);
      renderLists();
    } catch (error) {
      dialog.querySelector('.ovw-suite-assign-status').textContent = '加载失败：' + (error.message || error);
      suite.toast('成员加载失败：' + (error.message || error), 'error');
    } finally {
      loading = false;
      dialog.classList.remove('is-loading');
      renderLists();
    }
  }

  function moveRight() {
    leftSelected.forEach(function (id) {
      if (initialRightIds.has(id)) pendingRemoveIds.delete(id);
      else pendingAddIds.add(id);
    });
    leftSelected.clear();
    mentionSelectedIds.clear();
    mentionSummary = null;
    renderLists();
  }

  function toggleFilteredLeftSelection() {
    if (!dialog || dialog.dataset.readOnly === '1' || loading || saving) return;
    var query = dialog.querySelector('.ovw-suite-assign-search-left').value;
    var users = filteredAssignableUsers(allUsers, finalRightIds(), query);
    var select = !allFilteredSelected(leftSelected, users);
    setFilteredSelection(leftSelected, users, select);
    if (!select) {
      users.forEach(function (user) { mentionSelectedIds.delete(user.id); });
    }
    renderLists();
  }

  function moveLeft() {
    rightSelected.forEach(function (id) {
      if (pendingAddIds.has(id)) pendingAddIds.delete(id);
      else if (initialRightIds.has(id)) pendingRemoveIds.add(id);
    });
    rightSelected.clear();
    renderLists();
  }

  async function saveChanges() {
    if (saving || !currentProject) return;
    saving = true;
    renderLists();
    dialog.querySelector('.ovw-suite-assign-status').textContent = '正在保存成员分配…';
    var additions = Array.from(pendingAddIds);
    var removals = Array.from(pendingRemoveIds);
    var errors = [];
    try {
      if (additions.length) await addMembersToProject(currentProject.id, additions);
    } catch (error) {
      errors.push('添加失败：' + (error.message || error));
    }
    try {
      if (removals.length) await removeMembersFromProject(currentProject.id, removals);
    } catch (error) {
      errors.push('移除失败：' + (error.message || error));
    }
    try {
      var actual = await getProjectMembers(currentProject.id);
      resetChanges(actual);
    } catch (reloadError) {
      errors.push('刷新结果失败：' + (reloadError.message || reloadError));
    }
    saving = false;
    renderLists();
    if (errors.length) {
      dialog.querySelector('.ovw-suite-assign-status').textContent = errors.join('；');
      suite.toast(errors.join('；'), 'error');
    } else {
      suite.toast('项目成员分配已保存', 'success');
      closeDialog();
    }
  }

  function closeDialog() {
    if (overlay) overlay.hidden = true;
    if (dialog) dialog.hidden = true;
  }

  function openDialog(project, readOnly) {
    if (!suite.featureEnabled('member-assignment')) return;
    ensureDialog();
    currentProject = project;
    dialog.dataset.readOnly = readOnly ? '1' : '0';
    dialog.querySelector('h3').textContent = (readOnly ? '查看项目成员 · ' : '分配项目成员 · ') + project.name;
    dialog.querySelector('.ovw-suite-assign-save').hidden = Boolean(readOnly);
    dialog.querySelector('.ovw-suite-assign-arrows').hidden = Boolean(readOnly);
    mentionSelectedIds = new Set();
    mentionSummary = null;
    overlay.hidden = false;
    dialog.hidden = false;
    dialog.querySelectorAll('input').forEach(function (input) { input.value = ''; });
    loadDialog();
  }

  function ensureDialog() {
    if (dialog && document.body.contains(dialog)) return;
    overlay = document.createElement('div');
    overlay.className = 'ovw-suite-assign-overlay';
    overlay.hidden = true;
    dialog = document.createElement('section');
    dialog.className = 'ovw-suite-assign-dialog';
    dialog.hidden = true;
    dialog.innerHTML =
      '<header><h3>分配项目成员</h3><button type="button" class="ovw-suite-assign-close" aria-label="关闭">×</button></header>' +
      '<div class="ovw-suite-assign-body">' +
        '<section class="ovw-suite-assign-column"><div class="ovw-suite-assign-title">可分配成员 <span class="ovw-suite-assign-left-count">0</span></div><div class="ovw-suite-assign-search-tools"><input class="ovw-suite-assign-search-left" placeholder="姓名或邮箱；批量输入 @姓名 @姓名"><button type="button" class="ovw-suite-assign-select-all" aria-pressed="false">全选结果</button></div><div class="ovw-suite-assign-list ovw-suite-assign-left"></div></section>' +
        '<div class="ovw-suite-assign-arrows"><button type="button" class="ovw-suite-assign-add" title="添加选中成员">→</button><button type="button" class="ovw-suite-assign-remove" title="移除选中成员">←</button></div>' +
        '<section class="ovw-suite-assign-column"><div class="ovw-suite-assign-title">已分配成员 <span class="ovw-suite-assign-right-count">0</span></div><input class="ovw-suite-assign-search-right" placeholder="搜索已分配成员"><div class="ovw-suite-assign-list ovw-suite-assign-right"></div></section>' +
      '</div>' +
      '<footer><span class="ovw-suite-assign-status"></span><button type="button" class="ovw-suite-assign-cancel">取消</button><button type="button" class="ovw-suite-assign-save">保存分配</button></footer>';
    overlay.addEventListener('click', closeDialog);
    dialog.querySelector('.ovw-suite-assign-close').addEventListener('click', closeDialog);
    dialog.querySelector('.ovw-suite-assign-cancel').addEventListener('click', closeDialog);
    dialog.querySelector('.ovw-suite-assign-select-all').addEventListener('click', toggleFilteredLeftSelection);
    dialog.querySelector('.ovw-suite-assign-add').addEventListener('click', moveRight);
    dialog.querySelector('.ovw-suite-assign-remove').addEventListener('click', moveLeft);
    dialog.querySelector('.ovw-suite-assign-save').addEventListener('click', saveChanges);
    dialog.querySelector('.ovw-suite-assign-search-left').addEventListener('input', function (event) {
      applyMentionSelection(event.target.value);
    });
    dialog.querySelector('.ovw-suite-assign-search-right').addEventListener('input', renderLists);
    dialog.addEventListener('click', function (event) {
      if (dialog.dataset.readOnly === '1') return;
      var row = event.target.closest('.ovw-suite-assign-row');
      if (!row) return;
      var id = Number(row.dataset.userId);
      var selected = row.closest('.ovw-suite-assign-left') ? leftSelected : rightSelected;
      if (selected.has(id)) selected.delete(id); else selected.add(id);
      if (selected === leftSelected) mentionSelectedIds.delete(id);
      renderLists();
    });
    document.body.appendChild(overlay);
    document.body.appendChild(dialog);
  }

  function actionDock(card) {
    var dock = card.querySelector(':scope > .ovw-suite-card-actions');
    if (!dock) {
      dock = document.createElement('div');
      dock.className = 'ovw-suite-card-actions';
      card.appendChild(dock);
    }
    return dock;
  }

  function projectFromCard(card) {
    return { id: suite.projectId(card), name: suite.projectName(card), card: card };
  }

  function injectCardActions() {
    document.querySelectorAll('.ls-project-card').forEach(function (card) {
      if (!suite.projectId(card)) return;
      if (getComputedStyle(card).position === 'static') card.style.position = 'relative';
      var dock = actionDock(card);
      if (!dock.querySelector('.ovw-suite-assign-card')) {
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'ovw-suite-card-action ovw-suite-assign-card';
        button.title = '快速分配项目成员';
        button.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M15 12c2.2 0 4-1.8 4-4s-1.8-4-4-4-4 1.8-4 4 1.8 4 4 4zM6 10V7H4v3H1v2h3v3h2v-3h3v-2H6zm9 4c-2.7 0-8 1.3-8 4v2h16v-2c0-2.7-5.3-4-8-4z"/></svg>';
        button.addEventListener('mousedown', function (event) { event.stopPropagation(); });
        button.addEventListener('click', function (event) {
          event.preventDefault();
          event.stopPropagation();
          if (!suite.featureEnabled('member-assignment')) return;
          openDialog(projectFromCard(card), false);
        });
        dock.appendChild(button);
      }
    });
  }

  function addStyle() {
    if (document.getElementById('ovw-suite-assignment-style')) return;
    var style = document.createElement('style');
    style.id = 'ovw-suite-assignment-style';
    style.textContent = [
      '.ovw-suite-card-actions{position:absolute;top:6px;left:6px;z-index:24;display:none;align-items:center;gap:4px}.ls-project-card:hover>.ovw-suite-card-actions{display:flex}.ovw-suite-card-action{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:1px solid rgba(0,0,0,.08);border-radius:5px;background:rgba(255,255,255,.94);color:#64748b;box-shadow:0 1px 4px rgba(0,0,0,.12);cursor:pointer}.ovw-suite-card-action:hover{color:#2563eb;border-color:#93c5fd}',
      '.ovw-suite-assign-overlay{position:fixed;inset:0;z-index:2147483644;background:rgba(15,23,42,.46)}.ovw-suite-assign-overlay[hidden],.ovw-suite-assign-dialog[hidden]{display:none}',
      '.ovw-suite-assign-dialog{position:fixed;z-index:2147483645;top:50%;left:50%;transform:translate(-50%,-50%);display:flex;flex-direction:column;width:min(860px,calc(100vw - 32px));height:min(620px,calc(100vh - 32px));background:#fff;border:1px solid #dfe4ea;border-radius:8px;box-shadow:0 24px 70px rgba(15,23,42,.3);overflow:hidden;color:#1f2937;font:13px/1.4 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}',
      '.ovw-suite-assign-dialog>header{display:flex;align-items:center;justify-content:space-between;padding:13px 16px;background:#f8fafc;border-bottom:1px solid #e5eaf0}.ovw-suite-assign-dialog h3{margin:0;font-size:15px}.ovw-suite-assign-close{border:0;background:transparent;color:#94a3b8;font-size:22px;cursor:pointer}',
      '.ovw-suite-assign-body{display:grid;grid-template-columns:minmax(0,1fr) 46px minmax(0,1fr);gap:12px;min-height:0;flex:1;padding:14px}.ovw-suite-assign-column{display:flex;min-width:0;min-height:0;flex-direction:column;padding:10px;border:1px solid #e5eaf0;border-radius:7px;background:#f8fafc}.ovw-suite-assign-title{display:flex;justify-content:space-between;margin-bottom:8px;font-weight:650}.ovw-suite-assign-title span{color:#64748b;font-weight:500}',
      '.ovw-suite-assign-column input{box-sizing:border-box;width:100%;margin-bottom:8px;padding:7px 9px;border:1px solid #d9e0e8;border-radius:5px;background:#fff;outline:none}.ovw-suite-assign-column input:focus{border-color:#60a5fa;box-shadow:0 0 0 2px rgba(96,165,250,.16)}.ovw-suite-assign-search-tools{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px;margin-bottom:8px}.ovw-suite-assign-search-tools input{min-width:0;margin-bottom:0}.ovw-suite-assign-select-all{min-width:74px;padding:0 9px;border:1px solid #bfdbfe;border-radius:5px;background:#eff6ff;color:#2563eb;white-space:nowrap;cursor:pointer}.ovw-suite-assign-select-all[aria-pressed="true"]{border-color:#93c5fd;background:#dbeafe}.ovw-suite-assign-select-all:disabled{opacity:.45;cursor:not-allowed}.ovw-suite-assign-list{min-height:0;flex:1;overflow:auto;padding:4px;border:1px solid #e5e7eb;border-radius:5px;background:#fff}',
      '.ovw-suite-assign-row{display:flex;align-items:center;gap:8px;width:100%;padding:7px;border:0;border-radius:5px;background:transparent;text-align:left;cursor:pointer;color:#334155}.ovw-suite-assign-row:hover{background:#f1f5f9}.ovw-suite-assign-row.is-selected{background:#dbeafe}.ovw-suite-assign-check{display:flex;align-items:center;justify-content:center;width:16px;height:16px;border:1px solid #cbd5e1;border-radius:3px;color:#fff;font-size:10px}.is-selected>.ovw-suite-assign-check{border-color:#2563eb;background:#2563eb}.ovw-suite-assign-person{display:flex;min-width:0;flex:1;flex-direction:column}.ovw-suite-assign-person strong,.ovw-suite-assign-person small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ovw-suite-assign-person strong{font-size:12.5px}.ovw-suite-assign-person small{color:#94a3b8;font-size:10.5px}.ovw-suite-assign-role,.ovw-suite-assign-change{flex:none;padding:2px 5px;border-radius:4px;background:#eef2ff;color:#4f46e5;font-size:10px}.ovw-suite-assign-change.is-remove{background:#fef2f2;color:#b91c1c}.ovw-suite-assign-change.is-add{background:#f0fdf4;color:#15803d}',
      '.ovw-suite-assign-arrows{display:flex;flex-direction:column;justify-content:center;gap:8px}.ovw-suite-assign-arrows button{width:34px;height:34px;border:1px solid #bfdbfe;border-radius:5px;background:#eff6ff;color:#2563eb;cursor:pointer}.ovw-suite-assign-arrows button:disabled{opacity:.35;cursor:not-allowed}.ovw-suite-assign-empty{padding:32px 10px;text-align:center;color:#94a3b8}',
      '.ovw-suite-assign-dialog>footer{display:flex;align-items:center;gap:8px;padding:11px 14px;border-top:1px solid #e5eaf0;background:#f8fafc}.ovw-suite-assign-status{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#64748b;font-size:11px}.ovw-suite-assign-dialog>footer button{padding:6px 14px;border:1px solid #d9e0e8;border-radius:5px;background:#fff;color:#475569;cursor:pointer}.ovw-suite-assign-dialog>footer .ovw-suite-assign-save{border-color:#2563eb;background:#2563eb;color:#fff}.ovw-suite-assign-dialog>footer button:disabled{opacity:.45;cursor:not-allowed}',
      '.ovw-suite-assign-arrows[hidden],.ovw-suite-assign-save[hidden]{display:none!important}.ovw-suite-assign-dialog[data-read-only="1"] .ovw-suite-assign-body{display:block}.ovw-suite-assign-dialog[data-read-only="1"] .ovw-suite-assign-column:first-child{display:none}.ovw-suite-assign-dialog[data-read-only="1"] .ovw-suite-assign-column:last-child{height:100%;box-sizing:border-box}',
      '@media (max-width:700px){.ovw-suite-assign-body{grid-template-columns:1fr;overflow:auto}.ovw-suite-assign-arrows{flex-direction:row}.ovw-suite-assign-column{min-height:260px}.ovw-suite-assign-search-tools{grid-template-columns:minmax(0,1fr) auto}.ovw-suite-assign-dialog[data-read-only="1"] .ovw-suite-assign-body{grid-template-columns:1fr}}',
    ].join('');
    document.head.appendChild(style);
  }

  function mount() {
    addStyle();
    ensureDialog();
    suite.addProjectContextAction('assign-members', {
      label: '分配人员',
      onClick: function (project) { openDialog(project, false); },
    });
    suite.addProjectContextAction('view-members', {
      label: '查看成员',
      onClick: function (project) { openDialog(project, true); },
    });
    injectCardActions();
    if (!observer) {
      observer = new MutationObserver(function () {
        if (scanTimer) return;
        scanTimer = setTimeout(function () {
          scanTimer = null;
          injectCardActions();
        }, 150);
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }
  }

  function unmount() {
    closeDialog();
    suite.removeProjectContextAction('assign-members');
    suite.removeProjectContextAction('view-members');
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (scanTimer) {
      clearTimeout(scanTimer);
      scanTimer = null;
    }
    document.querySelectorAll('.ovw-suite-assign-card').forEach(function (button) {
      var dock = button.parentElement;
      button.remove();
      if (dock && dock.classList.contains('ovw-suite-card-actions') && !dock.children.length) dock.remove();
    });
  }

  suite.register('member-assignment', {
    match: projectListMatch,
    mount: mount,
    scan: injectCardActions,
    unmount: unmount,
  });
})();

/* MODULE: hidden-cards */
(function () {
  'use strict';

  var suite = window.__INSTA360_SUITE__;
  if (!suite) return;

  var STORE_KEY = 'insta360-hidden-cards-v1';
  var HIDE_ATTR = 'data-ovw-suite-hidden';
  var CARD_SELECTOR = '.ls-project-card';
  var ITEM_SELECTOR = '.ls-projects-page__link, .ls-annotation-center-page__link, .ls-review-center-page__link, .ls-acceptance-center-page__link';
  var hidden = loadHidden();
  var entryButton = null;
  var fallbackEntry = null;
  var popover = null;
  var observer = null;
  var scanTimer = null;

  function managedPage() {
    var path = location.pathname.replace(/\/+$/, '');
    return /^\/workspaces\/[^/]+\/projects$/.test(path) ||
      /^\/(?:annotation|review|acceptance)\/workspaces\/[^/]+$/.test(path);
  }

  function loadHidden() {
    try {
      var parsed = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
      return {};
    }
  }

  function saveHidden() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(hidden)); } catch (error) {}
  }

  function hiddenName(id) {
    var value = hidden[id];
    if (typeof value === 'string' && value) return value;
    if (value && typeof value === 'object' && value.title) return value.title;
    return '项目 #' + id;
  }

  function cardItem(card) {
    if (!card) return null;
    var item = card.closest(ITEM_SELECTOR);
    if (item) return item;
    var node = card;
    while (node && node.parentElement && node !== document.body) {
      var parent = node.parentElement;
      var display = '';
      try { display = getComputedStyle(parent).display || ''; } catch (error) {}
      if (display.indexOf('grid') !== -1 || display.indexOf('flex') !== -1) return node;
      node = parent;
    }
    return card;
  }

  function hideSlot(slot) {
    if (!slot) return;
    slot.style.setProperty('display', 'none', 'important');
    slot.setAttribute(HIDE_ATTR, '1');
  }

  function showSlot(slot) {
    if (!slot) return;
    slot.style.removeProperty('display');
    slot.removeAttribute(HIDE_ATTR);
  }

  function applyHidden() {
    document.querySelectorAll('[' + HIDE_ATTR + ']').forEach(function (slot) {
      var card = slot.matches(CARD_SELECTOR) ? slot : slot.querySelector(CARD_SELECTOR);
      var id = suite.projectId(card);
      if (!id || !hidden[id]) showSlot(slot);
    });
    document.querySelectorAll(CARD_SELECTOR).forEach(function (card) {
      var id = suite.projectId(card);
      if (id && hidden[id]) hideSlot(cardItem(card));
    });
  }

  function currentPageIds() {
    var ids = new Set();
    document.querySelectorAll(CARD_SELECTOR).forEach(function (card) {
      var id = suite.projectId(card);
      if (id) ids.add(id);
    });
    return ids;
  }

  function currentHiddenCount() {
    var ids = currentPageIds();
    return Object.keys(hidden).filter(function (id) { return ids.has(id); }).length;
  }

  function hideCard(card) {
    var id = suite.projectId(card);
    if (!id) return;
    hidden[id] = suite.projectName(card) || ('项目 #' + id);
    saveHidden();
    hideSlot(cardItem(card));
    updateEntry();
    renderPopover();
  }

  function restoreCard(id) {
    if (!id) return;
    delete hidden[id];
    saveHidden();
    applyHidden();
    updateEntry();
    renderPopover();
  }

  function restoreAll() {
    hidden = {};
    saveHidden();
    applyHidden();
    updateEntry();
    renderPopover();
    suite.toast('已恢复全部隐藏项目', 'success');
  }

  function actionDock(card) {
    var dock = card.querySelector(':scope > .ovw-suite-card-actions');
    if (!dock) {
      dock = document.createElement('div');
      dock.className = 'ovw-suite-card-actions';
      card.appendChild(dock);
    }
    return dock;
  }

  function injectCardButtons() {
    document.querySelectorAll(CARD_SELECTOR).forEach(function (card) {
      if (!suite.projectId(card)) return;
      if (getComputedStyle(card).position === 'static') card.style.position = 'relative';
      var dock = actionDock(card);
      if (dock.querySelector('.ovw-suite-hide-card')) return;
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'ovw-suite-card-action ovw-suite-hide-card';
      button.title = '隐藏此项目卡片';
      button.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M2.1 3.5 3.5 2.1l18.4 18.4-1.4 1.4-3-3C15.8 19.6 14 20 12 20c-5 0-9.3-3.1-11-8 1-2.2 2.4-4.1 4.2-5.5L2.1 3.5zm5.2 5.2A5 5 0 0 0 14.9 16l-1.6-1.6a3 3 0 0 1-3.7-3.7L7.3 8.7zM12 4c5 0 9.3 3.1 11 8-.6 1.4-1.4 2.6-2.4 3.7l-3.1-3.1c0-.2.1-.4.1-.6A5.6 5.6 0 0 0 12 6.4c-.2 0-.4 0-.6.1L9.2 4.3C10.1 4.1 11 4 12 4z"/></svg>';
      button.addEventListener('mousedown', function (event) { event.stopPropagation(); });
      button.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();
        hideCard(card);
      });
      dock.appendChild(button);
    });
  }

  function toolbarOptions() {
    return {
      label: '隐藏项目',
      title: '查看和恢复已隐藏的项目卡片',
      icon: '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M12 6c-4 0-7.4 2.5-8.9 6 1.5 3.5 4.9 6 8.9 6s7.4-2.5 8.9-6C19.4 8.5 16 6 12 6zm0 9.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5z"/></svg>',
      badge: updateEntryBadge,
      onClick: function (button) {
        entryButton = button;
        togglePopover(button);
      },
    };
  }

  function updateEntryBadge(button) {
    button = button || entryButton || fallbackEntry;
    if (!button) return;
    var badge = button.querySelector('.ovw-suite-tool__badge, .ovw-suite-hide-fallback-badge');
    var total = Object.keys(hidden).length;
    if (badge) {
      badge.textContent = String(total);
      badge.hidden = total === 0;
    }
    var here = currentHiddenCount();
    button.classList.toggle('has-current-hidden', here > 0);
    button.title = here ? '本页有 ' + here + ' 个隐藏项目，点击恢复' : '查看和恢复已隐藏的项目卡片';
  }

  function updateEntry() {
    updateEntryBadge(entryButton);
    updateEntryBadge(fallbackEntry);
  }

  function ensureFallbackEntry() {
    if (suite.listPage()) {
      if (fallbackEntry) fallbackEntry.hidden = true;
      return;
    }
    if (!fallbackEntry) {
      fallbackEntry = document.createElement('button');
      fallbackEntry.type = 'button';
      fallbackEntry.className = 'ovw-suite-hide-fallback';
      fallbackEntry.innerHTML = '<span>隐藏项目</span><b class="ovw-suite-hide-fallback-badge" hidden></b>';
      fallbackEntry.addEventListener('click', function (event) {
        event.stopPropagation();
        togglePopover(fallbackEntry);
      });
      document.body.appendChild(fallbackEntry);
    }
    fallbackEntry.hidden = false;
    updateEntryBadge(fallbackEntry);
  }

  function closePopover() {
    if (popover) {
      popover.remove();
      popover = null;
    }
  }

  function togglePopover(anchor) {
    if (popover) return closePopover();
    popover = document.createElement('section');
    popover.className = 'ovw-suite-hide-popover';
    popover.__anchor = anchor;
    document.body.appendChild(popover);
    popover.addEventListener('click', function (event) {
      event.stopPropagation();
      var restore = event.target.closest('[data-restore-id]');
      if (restore) return restoreCard(restore.dataset.restoreId);
      if (event.target.closest('.ovw-suite-hide-restore-all')) restoreAll();
    });
    renderPopover();
    positionPopover();
  }

  function renderPopover() {
    if (!popover) return;
    var ids = Object.keys(hidden);
    var current = currentPageIds();
    var currentCount = ids.filter(function (id) { return current.has(id); }).length;
    var html = '<header><strong>已隐藏的项目</strong><span>' + ids.length + '</span>' +
      (currentCount ? '<em>本页 ' + currentCount + '</em>' : '') + '</header>';
    if (!ids.length) {
      html += '<div class="ovw-suite-hide-empty">暂无隐藏项目</div>';
    } else {
      html += '<div class="ovw-suite-hide-list">' + ids.map(function (id) {
        return '<div class="ovw-suite-hide-row"><span class="' + (current.has(id) ? 'is-current' : '') + '" title="' + suite.escapeHtml(hiddenName(id)) + '">' + suite.escapeHtml(hiddenName(id)) + '</span><button type="button" data-restore-id="' + suite.escapeHtml(id) + '">恢复</button></div>';
      }).join('') + '</div><footer><button type="button" class="ovw-suite-hide-restore-all">全部恢复</button></footer>';
    }
    popover.innerHTML = html;
  }

  function positionPopover() {
    if (!popover || !popover.__anchor) return;
    var rect = popover.__anchor.getBoundingClientRect();
    var width = 300;
    popover.style.width = width + 'px';
    popover.style.left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)) + 'px';
    var below = rect.bottom + 7;
    popover.style.top = Math.min(below, window.innerHeight - Math.min(popover.offsetHeight || 420, window.innerHeight - 16) - 8) + 'px';
  }

  function addStyle() {
    if (document.getElementById('ovw-suite-hidden-style')) return;
    var style = document.createElement('style');
    style.id = 'ovw-suite-hidden-style';
    style.textContent = [
      '.ovw-suite-card-actions{position:absolute;top:6px;left:6px;z-index:24;display:none;align-items:center;gap:4px}.ls-project-card:hover>.ovw-suite-card-actions{display:flex}.ovw-suite-card-action{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:1px solid rgba(0,0,0,.08);border-radius:5px;background:rgba(255,255,255,.94);color:#64748b;box-shadow:0 1px 4px rgba(0,0,0,.12);cursor:pointer}.ovw-suite-hide-card:hover{color:#dc2626;border-color:#fca5a5}',
      '.ovw-suite-tool.has-current-hidden,.ovw-suite-hide-fallback.has-current-hidden{border-color:#f59e0b!important;background:#fffbeb!important;color:#b45309!important}',
      '.ovw-suite-hide-fallback{position:fixed;right:18px;bottom:18px;z-index:2147483643;display:inline-flex;align-items:center;gap:6px;padding:7px 10px;border:1px solid #d7dce3;border-radius:6px;background:#fff;color:#475569;box-shadow:0 8px 24px rgba(15,23,42,.14);cursor:pointer}.ovw-suite-hide-fallback[hidden]{display:none}.ovw-suite-hide-fallback-badge{display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:16px;padding:0 4px;border-radius:8px;background:#2563eb;color:#fff;font-size:10px}.ovw-suite-hide-fallback-badge[hidden]{display:none}',
      '.ovw-suite-hide-popover{position:fixed;z-index:2147483646;overflow:hidden;border:1px solid #dfe4ea;border-radius:7px;background:#fff;box-shadow:0 14px 38px rgba(15,23,42,.2);color:#334155;font:12.5px/1.4 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}.ovw-suite-hide-popover header{display:flex;align-items:center;gap:6px;padding:10px 11px;border-bottom:1px solid #e9edf2;background:#f8fafc}.ovw-suite-hide-popover header span{color:#94a3b8}.ovw-suite-hide-popover header em{margin-left:auto;padding:1px 6px;border-radius:8px;background:#fff7e6;color:#b45309;font-style:normal;font-size:10px}.ovw-suite-hide-list{max-height:320px;overflow:auto;padding:4px}.ovw-suite-hide-row{display:flex;align-items:center;gap:6px;padding:6px;border-radius:5px}.ovw-suite-hide-row:hover{background:#f8fafc}.ovw-suite-hide-row span{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ovw-suite-hide-row span.is-current{font-weight:650;color:#b45309}.ovw-suite-hide-row button,.ovw-suite-hide-popover footer button{border:0;background:transparent;color:#2563eb;cursor:pointer}.ovw-suite-hide-popover footer{padding:7px 9px;border-top:1px solid #e9edf2;text-align:right}.ovw-suite-hide-empty{padding:30px 12px;text-align:center;color:#94a3b8}',
    ].join('');
    document.head.appendChild(style);
  }

  function scan() {
    injectCardButtons();
    applyHidden();
    if (suite.listPage()) entryButton = suite.addToolbarButton('hidden-cards', toolbarOptions()) || entryButton;
    ensureFallbackEntry();
    updateEntry();
    if (popover) positionPopover();
  }

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(function () {
      scanTimer = null;
      scan();
    }, 150);
  }

  function mount() {
    addStyle();
    scan();
    if (!observer) {
      observer = new MutationObserver(scheduleScan);
      observer.observe(document.body, { childList: true, subtree: true });
    }
  }

  function unmount() {
    closePopover();
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (scanTimer) {
      clearTimeout(scanTimer);
      scanTimer = null;
    }
    document.querySelectorAll('[' + HIDE_ATTR + ']').forEach(showSlot);
    document.querySelectorAll('.ovw-suite-hide-card').forEach(function (button) { button.remove(); });
    if (fallbackEntry) fallbackEntry.hidden = true;
  }

  document.addEventListener('click', function (event) {
    if (!popover) return;
    var anchor = popover.__anchor;
    if (popover.contains(event.target) || (anchor && anchor.contains(event.target))) return;
    closePopover();
  }, true);
  window.addEventListener('resize', positionPopover);
  window.addEventListener('scroll', positionPopover, true);

  suite.register('hidden-cards', {
    match: managedPage,
    mount: mount,
    scan: scan,
    unmount: unmount,
  });

  window.__HIDECARDS = {
    list: function () { return Object.assign({}, hidden); },
    hide: function (id, name) { if (id) { hidden[id] = name || ('项目 #' + id); saveHidden(); scan(); } },
    unhide: restoreCard,
    clear: restoreAll,
    refresh: scan,
  };
})();
