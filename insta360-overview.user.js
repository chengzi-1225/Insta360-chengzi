// ==UserScript==
// @name         Insta360 项目概览
// @namespace    https://label.insta360.com/
// @author       chengzi
// @version      3.10.0
// @description  项目卡片统计与返修/返工入口 + 共享缓存的渐进式人员扫描 + 可靠分页和完整性检查
// @match        *://label.insta360.com/*
// @run-at       document-idle
// @grant        none
// @noframes
// @updateURL    https://raw.githubusercontent.com/chengzi-1225/Insta360-chengzi/refs/heads/main/insta360-overview.user.js
// @downloadURL  https://raw.githubusercontent.com/chengzi-1225/Insta360-chengzi/refs/heads/main/insta360-overview.user.js
// ==/UserScript==

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
    settingsKey: 'insta360-overview-fields-v2',
    fastMode: true,
    detailConcurrency: 2,
    taskPageSize: 100,
    taskPageConcurrency: 20,
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

  function closeStatedProjects() {
    saveStatsProjects({});
    document.querySelectorAll(CONFIG.cardSelector).forEach(function (c) {
      var s = c.querySelector('.ovw-summary');
      if (s && s.dataset.ovwManual === '1') { s.dataset.ovwManual = ''; delete c.dataset.ovwMounted; }
    });
    scanCards();
  }
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
    'total', 'ANNOTATED', 'REVIEWED_ACCEPTED', 'REPAIR', 'REWORK'
  ];
  function loadVisibleFields() {
    try { var raw = JSON.parse(localStorage.getItem(CONFIG.settingsKey) || 'null');
      if (Array.isArray(raw)) return raw.filter(function (k) { return FIELD_MAP[k]; }); } catch (e) {}
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
    var list = Array.isArray(rows) ? rows : [];
    for (var j = 0; j < list.length; j++) {
      var t = normalizeTask(list[j], 'row-' + j);
      var key = String(t.taskId);
      if (seen[key]) continue;
      seen[key] = true; total += 1;
      if (t.status && STATUS_SET[t.status]) counts[t.status] += 1; else unknown += 1;
    }
    counts.reworkTotal = counts.REWORK || 0;
    return { total: total, counts: counts, unknown: unknown, available: STATUS_CODES.concat(['reworkTotal']), needsTaskDetails: false, source: 'tasks' };
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
    return {
      total: total, counts: counts,
      available: STATUS_CODES.concat(['reworkTotal']),
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
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    } catch (e) {
      clearTimeout(timeoutId);
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
        return await getJson(url);
      } catch (e) {
        lastError = e;
        if (attempt < CONFIG.taskPageRetries) {
          await new Promise(function(resolve) { setTimeout(resolve, 150 * (attempt + 1)); });
        }
      }
    }
    throw new Error('任务读取不完整：第 ' + page + ' 页读取失败（' + String(lastError) + '）');
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

  // 全量拉取：使用站点支持的分页尺寸；无总数时继续读取到最后一页。
  async function loadTasks(projectId, workspaceId) {
    var baseParams = { project: projectId, workspace: workspaceId, page_size: CONFIG.taskPageSize };
    var firstBody = await loadTaskPage(1, baseParams);
    var firstRows = rowsFromResponse(firstBody);
    var rows = [];
    var seen = {};
    appendUniqueTaskRows(rows, seen, firstRows);
    var effectiveSize = firstRows.length || CONFIG.taskPageSize;
    var total = totalFromResponse(firstBody);
    if (!firstRows.length || total === 0 || (total != null && rows.length >= total)) return rows;

    if (total != null) {
      var pageCount = Math.ceil(total / effectiveSize);
      var pageList = [];
      for (var p = 2; p <= pageCount; p++) pageList.push(p);
      var queue = pageList.slice();
      var concurrency = Math.max(1, Math.min(CONFIG.taskPageConcurrency, pageCount - 1));
      async function worker() {
        while (queue.length) {
          var page = queue.shift();
          var body = await loadTaskPage(page, baseParams);
          appendUniqueTaskRows(rows, seen, rowsFromResponse(body));
        }
      }
      var workers = [];
      for (var w = 0; w < concurrency; w++) workers.push(worker());
      await Promise.all(workers);
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
        var rows = await loadTasksShared(ctx.projectId, ctx.workspaceId, !!force);
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
    if (key === 'reworkTotal') return null;
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
          '<span>卡片显示</span>' +
          '<span class="ovw-toolbar__acts">' +
            '<button type="button" class="ovw-toolbar__closestat" title="已统计的卡片回到「点击统计本项目」">关闭已统计</button>' +
            '<button type="button" class="ovw-toolbar__hideall" title="所有卡片彻底不显示（含待点击态）">全部关闭</button>' +
            '<button type="button" class="ovw-toolbar__reset" title="恢复字段默认并重新显示所有卡片">恢复默认</button>' +
          '</span>' +
        '</div>' +
        '<div class="ovw-toolbar__panel-list"></div>' +
      '</div>';
    host.parentElement.insertBefore(toolbar, host.nextSibling);
    var btn = toolbar.querySelector('.ovw-toolbar__btn--fields');
    var repairBtn = toolbar.querySelector('.ovw-toolbar__btn--repair');
    var panel = toolbar.querySelector('.ovw-toolbar__panel');
    var listEl = toolbar.querySelector('.ovw-toolbar__panel-list');
    var resetBtn = toolbar.querySelector('.ovw-toolbar__reset');
    var hideAllBtn = toolbar.querySelector('.ovw-toolbar__hideall');
    var closeStatBtn = toolbar.querySelector('.ovw-toolbar__closestat');

    hideAllBtnEl = hideAllBtn;
    updateHideAllBtn();

    if (repairBtn) {
      repairBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        toggleRepairPanel(toolbar, repairBtn);
      });
    }

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
    function openPanel() { renderList(); updateHideAllBtn(); panel.hidden = false; btn.classList.add('is-open'); }
    function closePanel() { panel.hidden = true; btn.classList.remove('is-open'); }

    btn.addEventListener('click', function (e) { e.stopPropagation(); if (panel.hidden) openPanel(); else closePanel(); });
    resetBtn.addEventListener('click', function (e) { e.stopPropagation(); restoreAll(); renderList(); });
    hideAllBtn.addEventListener('click', function (e) { e.stopPropagation(); if (allHidden) showAllCards(); else hideAllCards(); });
    closeStatBtn.addEventListener('click', function (e) { e.stopPropagation(); closeStatedProjects(); });

    panel.addEventListener('click', function (e) { e.stopPropagation(); });
    document.addEventListener('click', function (e) { if (!toolbar.contains(e.target)) closePanel(); }, true);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !panel.hidden) closePanel(); });
  }

  var repairCache = {};

  function repairScanPriorityFromCounts(counts) {
    if (!counts || typeof counts !== 'object') return 1;
    var pending = (Number(counts.REVIEWED_REJECTED) || 0)
      + (Number(counts.REWORK) || 0)
      + (Number(counts.REPAIR) || 0);
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
          cardRejected: d.cardRejected,
          empty: d.empty, error: d.error
        };
      }
    }

    var entry = cache[ctx.projectId];
    var agg = entry && entry.aggregate;
    var cardRejected = 0;
    if (agg && agg.counts) {
      var n1 = Number(agg.counts.REVIEWED_REJECTED) || 0;
      var n2 = Number(agg.counts.REWORK) || 0;
      var n3 = Number(agg.counts.REPAIR) || 0;
      cardRejected = n1;
      if (!n1 && !n2 && !n3) {
        var emptyResult = {
          workspaceId: ctx.workspaceId,
          projectId: ctx.projectId, href: ctx.href, name: name,
          repair: [], rework: [], empty: true,
          repairTaskCount: 0, reworkTaskCount: 0,
          repairTaskIds: [], reworkTaskIds: [],
          cardRejected: 0
        };
        repairCache[ctx.projectId] = { ts: Date.now(), data: emptyResult };
        return emptyResult;
      }
    }

    // ★ v3.8.9 全量拉取任务，客户端过滤
    var rows;
    try {
      rows = await loadTasksShared(ctx.projectId, ctx.workspaceId, !!forceRefresh);
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

    var repairMap = {}, reworkMap = {};
    var repairTaskIds = [], reworkTaskIds = [];
    var repairTaskCount = 0, reworkTaskCount = 0;

    var taskAnnotatorMap = loadTaskAnnotatorMap();

    for (var i = 0; i < rows.length; i++) {
      var t = rows[i];
      var st = taskStatusOf(t);
      if (!isRepairState(st) && !isReworkState(st)) continue;

      var taskId = t.id != null ? String(t.id) : (t.taskId != null ? String(t.taskId) : null);

      var pp = extractPeople(t);
      var finalPeople = [];

      for (var p = 0; p < pp.length; p++) {
        var person = pp[p];
        if (isNumericId(person) && taskId && taskAnnotatorMap[taskId]) {
          finalPeople.push(taskAnnotatorMap[taskId]);
        } else {
          finalPeople.push(person);
        }
      }

      if (finalPeople.length === 0 && taskId && taskAnnotatorMap[taskId]) {
        finalPeople.push(taskAnnotatorMap[taskId]);
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
        for (var r = 0; r < uniquePeople.length; r++) {
          repairMap[uniquePeople[r]] = (repairMap[uniquePeople[r]] || 0) + 1;
        }
      } else if (isReworkState(st)) {
        reworkTaskCount++;
        if (reworkTaskIds.length < 20) reworkTaskIds.push(taskId || '(no-id)');
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
      cardRejected: cardRejected,
      empty: (repairTaskCount + reworkTaskCount) === 0
    };
    repairCache[ctx.projectId] = { ts: Date.now(), data: result };
    return result;
  }

  function renderRepairShell(panelEl, scanCount, skipped) {
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
      return;
    }

    var html = '';
    html += '<div class="ovw-repair-head">';
    html += '<span>待返修 / 待返工人员</span>';
    html += '<span class="ovw-repair-acts">';
    html += '<button type="button" class="ovw-repair-clear"' + (selCnt ? '' : ' disabled') + '>清空选择</button>';
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
    var refreshBtn = panelEl.querySelector('.ovw-repair-refresh');
    var onlyCb = panelEl.querySelector('.ovw-repair-onlysel input');
    var bodyEl = panelEl.querySelector('.ovw-repair-body');

    if (clearBtn) clearBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      clearProjectSelected();
      renderRepairPanel(panelEl, false);
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
  }

  function shouldLoadRepairPanel(panelEl, forceRefresh) {
    return !!forceRefresh || !panelEl || !panelEl.dataset || panelEl.dataset.ovwLoaded !== '1';
  }

  function repairLaneHtml(item, kind) {
    var isRepair = kind === 'repair';
    var label = isRepair ? '待返修' : '待返工';
    var mode = isRepair ? 'repair' : 'rework';
    var count = Number(item[kind + 'TaskCount']) || 0;
    var people = item[kind] || [];
    var ids = item[kind + 'TaskIds'] || [];
    var url = buildProjectDataUrl(item, mode);
    var html = '<div class="ovw-repair-lane ovw-repair-lane--' + mode + '">';
    html += '<div class="ovw-repair-lane-head">';
    if (url) {
      html += '<a class="ovw-repair-tag ovw-repair-tag--' + mode + '" href="' + escapeHtml(url) + '">' + label + '</a>';
    } else {
      html += '<span class="ovw-repair-tag ovw-repair-tag--' + mode + '">' + label + '</span>';
    }
    html += '<span class="ovw-repair-lane-count">' + count + ' 条</span>';
    html += '</div>';

    if (people.length) {
      html += '<div class="ovw-repair-people">' + people.map(function(x) {
        return '<span class="ovw-repair-person">' + escapeHtml(x.name) + '<b>' + x.count + '</b></span>';
      }).join('') + '</div>';
    } else if (count > 0) {
      var shownIds = ids.slice(0, CONFIG.showTaskIdLimit).join(', ');
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

  function renderRepairResults(bodyEl, results, scanTotal, done, complete) {
    if (!bodyEl) return;
    var valid = results.filter(function(r) { return r; });
    var withTask = valid.filter(function(r) { return !r.empty && !r.error; });
    var emptyCount = valid.filter(function(r) { return r.empty; }).length;
    var errorCount = valid.filter(function(r) { return r.error; }).length;
    var html = '<div class="ovw-repair-sum">';
    html += '<span>已完成 ' + done + '/' + scanTotal + '</span>';
    html += '<span>待处理项目 ' + withTask.length + '</span>';
    if (emptyCount) html += '<span class="ovw-repair-dim">无待处理 ' + emptyCount + '</span>';
    if (errorCount) html += '<span class="ovw-repair-err">读取失败 ' + errorCount + '</span>';
    html += '</div>';

    for (var i = 0; i < withTask.length; i++) html += repairProjectHtml(withTask[i]);

    if (!complete && done < scanTotal) {
      html += '<div class="ovw-repair-loading">正在扫描，剩余 ' + (scanTotal - done) + ' 个项目</div>';
    } else if (!withTask.length) {
      html += '<div class="ovw-repair-empty">当前范围内没有待返修或待返工任务</div>';
    }
    bodyEl.innerHTML = html;
  }

  async function renderRepairPanel(panelEl, forceRefresh) {
    if (!shouldLoadRepairPanel(panelEl, forceRefresh)) {
      updateRepairPanelMeta();
      return;
    }
    panelEl.dataset.ovwLoaded = '1';

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

    if (forceRefresh) {
      for (var ci = 0; ci < cards.length; ci++) {
        var refreshCtx = projectContext(cards[ci]);
        if (!refreshCtx) continue;
        delete repairCache[refreshCtx.projectId];
        delete reworkTotalCache[refreshCtx.projectId];
        clearTaskRowsCache(refreshCtx.projectId, refreshCtx.workspaceId);
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
      return;
    }

    var results = new Array(cards.length);
    var done = 0;
    var scanId = String(Date.now()) + ':' + String(Math.random());
    panelEl.dataset.ovwScanId = scanId;
    renderRepairResults(bodyEl, results, cards.length, done, false);
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
            renderRepairResults(bodyEl, results, cards.length, done, false);
          }
          return r;
        });
      });
    });
    await Promise.all(tasks);
    if (panelEl.dataset.ovwScanId !== scanId) return;
    renderRepairResults(bodyEl, results, cards.length, done, true);
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
    '.ovw-summary{',
      '--ovw-label:#595959;--ovw-track:rgba(0,0,0,.08);--ovw-divider:rgba(0,0,0,.08);--ovw-hover:rgba(0,0,0,.045);--ovw-icon:rgba(0,0,0,.35);',
      'display:block;width:100%;max-width:100%;box-sizing:border-box;',
      'position:relative;margin:6px 0 10px 0;padding:10px 16px 8px 16px;',
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
    '.ovw-toolbar__btn:hover,.ovw-toolbar__btn.is-open{color:#1677ff;border-color:#1677ff;background:rgba(22,119,255,.03);}',
    '.ovw-toolbar__panel{position:absolute;top:calc(100% + 6px);right:0;z-index:1000000;min-width:320px;padding:0;border:1px solid rgba(0,0,0,.06);border-radius:10px;background:#fff;box-shadow:0 8px 28px rgba(0,0,0,.13);overflow:hidden;}',
    '.ovw-toolbar__panel-head{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px 14px 8px;font-size:12px;color:#8c8c8c;border-bottom:1px solid rgba(0,0,0,.04);}',
    '.ovw-toolbar__acts{display:inline-flex;align-items:center;gap:10px;flex:0 0 auto;}',
    '.ovw-toolbar__reset{border:0;background:transparent;color:#1677ff;cursor:pointer;font-size:12px;padding:0;font-family:inherit;}',
    '.ovw-toolbar__closestat{border:0;background:transparent;color:#fa8c16;cursor:pointer;font-size:12px;padding:0;font-family:inherit;}',
    '.ovw-toolbar__closestat:hover{color:#d46b08;}',
    '.ovw-toolbar__hideall{border:0;background:transparent;color:#8c8c8c;cursor:pointer;font-size:12px;padding:0;font-family:inherit;transition:all .15s ease;border-radius:4px;}',
    '.ovw-toolbar__hideall:hover{color:#ff4d4f;}',
    '.ovw-toolbar__hideall.is-on{background:#fa8c16;color:#fff;padding:1px 8px;border-radius:4px;font-weight:600;box-shadow:0 1px 4px rgba(250,140,22,.35);}',
    '.ovw-toolbar__hideall.is-on:hover{background:#d46b08;color:#fff;}',
    '.ovw-toolbar__panel-list{max-height:340px;overflow-y:auto;padding:4px 0;}',
    '.ovw-toolbar__item{display:flex;align-items:center;gap:9px;padding:7px 14px;cursor:pointer;font-size:13px;color:rgba(0,0,0,.88);}',
    '.ovw-toolbar__item:hover{background:rgba(22,119,255,.05);}',
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
    '.ovw-repair-refresh{border:0;background:transparent;color:#1677ff;cursor:pointer;font-size:12px;padding:0;font-family:inherit;}',
    '.ovw-repair-refresh:hover{color:#0958d9;}',
    '.ovw-repair-sum{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:0 0 8px;margin-bottom:2px;border-bottom:1px solid rgba(0,0,0,.06);font-size:12px;color:#595959;}',
    '.ovw-repair-sum>span:first-child{font-weight:600;color:rgba(0,0,0,.88);}',
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
    '@media (max-width:640px){.ovw-repair-panel{right:-8px;width:calc(100vw - 24px);padding:11px 12px;}.ovw-repair-grid{grid-template-columns:minmax(0,1fr);gap:9px;}.ovw-repair-lane{padding-right:0;}.ovw-repair-lane+.ovw-repair-lane{padding:9px 0 0;border-left:0;border-top:1px solid rgba(0,0,0,.06);}}'
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
