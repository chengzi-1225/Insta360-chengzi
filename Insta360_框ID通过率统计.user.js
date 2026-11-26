// ==UserScript==
// @name         Insta360 框ID通过率统计
// @namespace    local.insta360.region-pass-rate
// @version      1.4.0
// @description  统计项目历史通过率，读取全部评论并按项目、标注员合并导出Excel。
// @match        https://label.insta360.com/*
// @homepageURL  https://github.com/chengzi-1225/Insta360-chengzi
// @downloadURL  https://raw.githubusercontent.com/chengzi-1225/Insta360-chengzi/main/Insta360_框ID通过率统计.user.js
// @updateURL    https://raw.githubusercontent.com/chengzi-1225/Insta360-chengzi/main/Insta360_框ID通过率统计.user.js
// @grant        GM_setClipboard
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
'use strict';
const Core = (() => {
const DEFAULT_ORIGIN = 'https://label.insta360.com';
const FIELD_NAMES = ['url', 'reviewer', 'annotator', 'result', 'reason', 'comment', 'ratio', 'image', 'attachment'];
const HEADER_ALIASES = {
  url: ['url', '任务链接', '链接', '任务页面链接'], reviewer: ['reviewer', '质检员', '审核员'],
  annotator: ['annotator', '标注员'], result: ['result', '质检结果', '结果', '合格/不合格', '是否合格'],
  reason: ['reason', '问题类型'], comment: ['comment', '问题描述', '评论', '评论内容'],
  ratio: ['ratio', '构图比例', '比例'], image: ['image', '图片', '图片文件名', '图片名称'],
  attachment: ['attachment', '附件'],
};
const normalizedName = name => String(name || '').replace(/\s+/g, '');
const normalizedLabel = label => String(label || '').trim().replace(/\s/g, '').replace(/：/g, ':');

function taskIdentity(value, origin = DEFAULT_ORIGIN) {
  const base = new URL(origin);
  const url = new URL(String(value).trim(), base.origin);
  if (url.origin !== base.origin || !/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error('任务链接必须属于当前标注平台');
  const project = /\/projects\/([1-9]\d*)(?:\/|$)/.exec(url.pathname);
  const task = url.searchParams.getAll('task');
  if (!project || task.length !== 1 || !/^[1-9]\d*$/.test(task[0])) throw new Error('任务链接缺少有效的项目 ID 或任务 ID');
  url.hash = '';
  return { project_id: project[1], task_id: task[0], key: `${project[1]}/${task[0]}`, url: url.href };
}

function readDelimited(text, delimiter) {
  const records = []; let cells = [], value = '', quoted = false, afterQuote = false, line = 1, startLine = 1;
  const field = () => { cells.push(value); value = ''; afterQuote = false; };
  const record = () => { field(); if (cells.some(cell => cell.trim())) records.push({ cells, line: startLine }); cells = []; startLine = line + 1; };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { value += '"'; i++; } else { quoted = false; afterQuote = true; }
      } else {
        if (char === '\r' && text[i + 1] === '\n') { value += '\n'; line++; i++; }
        else { value += char; if (char === '\n' || char === '\r') line++; }
      }
    } else if (char === delimiter) field();
    else if (char === '\n' || char === '\r') {
      record(); line++; startLine = line;
      if (char === '\r' && text[i + 1] === '\n') i++;
    } else if (char === '"' && value === '' && !afterQuote) quoted = true;
    else {
      if (afterQuote && char.trim()) throw new Error(`第 ${line} 行引号后的分隔格式不正确`);
      if (!afterQuote) value += char;
    }
  }
  if (quoted) throw new Error(`第 ${startLine} 行的引号未闭合`);
  record(); return records;
}

function parseTable(input, origin = DEFAULT_ORIGIN) {
  const text = String(input || '').replace(/^\uFEFF/, '');
  const issues = [], rows = [];
  if (!text.trim()) return { rows, issues: [{ message: '请粘贴质检表，包含合格与不合格数据。' }] };
  // The first logical row determines the delimiter; quoted commas and tabs are ignored.
  const probe = text.replace(/^(?:[ \t]*\r\n|[ \t]*[\r\n])+/, '');
  let quoted = false, tabs = 0, commas = 0;
  for (let i = 0; i < probe.length; i++) {
    if (probe[i] === '"') { if (quoted && probe[i + 1] === '"') i++; else quoted = !quoted; }
    else if (!quoted && /[\r\n]/.test(probe[i])) break;
    else if (!quoted && probe[i] === '\t') tabs++;
    else if (!quoted && probe[i] === ',') commas++;
  }
  let records;
  try { records = readDelimited(text, tabs ? '\t' : ',', origin); }
  catch (error) { return { rows, issues: [{ message: error.message }] }; }
  if (!tabs && !commas) return { rows, issues: [{ message: '请从表格复制完整的列，或导入 CSV / TSV / TXT 文件。' }] };
  let positions = FIELD_NAMES.map((_, i) => i);
  const first = records[0]?.cells.map(cell => cell.trim()) || [];
  const isHeader = first.some(cell => HEADER_ALIASES.url.includes(cell.toLowerCase()));
  if (isHeader) {
    positions = FIELD_NAMES.map(name => first.findIndex(cell => HEADER_ALIASES[name].includes(cell.toLowerCase())));
    const missing = ['url', 'annotator', 'result'].filter(name => positions[FIELD_NAMES.indexOf(name)] < 0);
    if (missing.length) return { rows, issues: [{ source_row: records[0].line, message: '表头至少需要“任务链接、标注员、质检结果”三列。' }] };
    records.shift();
  }
  for (const record of records) {
    const row = { source_row: record.line };
    try {
      if (!isHeader && record.cells.length !== 9) throw new Error(`无表头数据需要 9 列，当前 ${record.cells.length} 列。顺序为：链接、质检员、标注员、质检结果、问题类型、问题描述、构图比例、图片、附件。`);
      if (isHeader && record.cells.length !== first.length) throw new Error('本行列数与表头不同，请检查引号或分隔符。');
      FIELD_NAMES.forEach((field, i) => { row[field] = positions[i] >= 0 ? String(record.cells[positions[i]] ?? '').trim() : ''; });
      const identity = taskIdentity(row.url, origin);
      Object.assign(row, identity, { url: row.url });
      if (!row.annotator) throw new Error('标注员不能为空');
      if (!['合格', '不合格'].includes(row.result)) throw new Error('质检结果必须为“合格”或“不合格”');
      rows.push(row);
    } catch (error) { issues.push({ source_row: record.line, message: error.message }); }
  }
  if (!records.length) issues.push({ message: '表格中没有质检数据。' });
  return { rows, issues };
}

function annotationName(annotation) {
  const user = annotation.completed_by;
  if (user && typeof user === 'object') {
    const name = `${user.first_name || ''}${user.last_name || ''}`.trim();
    if (name) return name;
  }
  // created_username commonly contains "姓 名 email, ID".
  const raw = annotation.created_username || (typeof user === 'object' ? user?.username : '');
  return String(raw || '').split(/\s+/).filter(part => part && !/@/.test(part) && !/^[\d,，]+$/.test(part)).join('');
}

function selectVersion(task, annotator, useDrafts) {
  if (!Array.isArray(task.annotations)) throw new Error('任务详情缺少已提交标注列表');
  const active = task.annotations.filter(a => a && !a.was_cancelled);
  const matches = active.filter(a => normalizedName(annotationName(a)) === normalizedName(annotator));
  const annotation = active.length === 1 ? active[0] : matches.length === 1 ? matches[0] : null;
  if (!annotation) throw new Error(active.length ? '存在多个候选标注，无法唯一对应到该标注员' : '没有可用的已提交标注');
  const knownName = annotationName(annotation);
  if (knownName && normalizedName(knownName) !== normalizedName(annotator)) throw new Error(`质检表标注员“${annotator}”与任务标注员“${knownName}”不同`);
  let selected = annotation, version = '已提交标注';
  if (useDrafts) {
    if (task.drafts != null && !Array.isArray(task.drafts)) throw new Error('任务草稿格式不正确');
    const drafts = (task.drafts || []).filter(d => d && d.result != null);
    if (drafts.some(d => d.annotation == null) && active.length > 1) throw new Error('存在未关联标注的草稿，无法唯一对应到该标注员');
    const available = drafts.filter(d => d.annotation == null || String(typeof d.annotation === 'object' ? d.annotation.id : d.annotation) === String(annotation.id));
    if (available.length) {
      const stamp = d => {
        const date = Date.parse(d.updated_at || d.created_at || '');
        if (!Number.isFinite(date)) throw new Error('草稿缺少有效时间，无法确定最新版本');
        return date;
      };
      available.forEach(stamp);
      selected = [...available].sort((a, b) => stamp(b) - stamp(a) || Number(b.id || 0) - Number(a.id || 0))[0];
      version = '最新草稿';
    }
  }
  if (!Array.isArray(selected.result)) throw new Error('选用的标注版本缺少有效框数据');
  return { selected, annotation, version };
}

function calculate(inputRows, taskDataByKey, { useDrafts = true } = {}) {
  const qc = inputRows.map(row => ({ ...row, original_region_id: '', matched_region_id: '', region_key: '', match_method: '' }));
  const issues = [], mappingNotes = [], tasks = [], regions = [], groups = new Map(), peopleMap = new Map();
  const addIssue = (row, message, code) => {
    issues.push({ source_row: row.source_row, project_id: String(row.project_id || ''), task_id: String(row.task_id || ''), annotator: row.annotator, code, message });
    const person = peopleMap.get(normalizedName(row.annotator)); if (person) person.incomplete = true;
  };
  for (const row of qc) {
    row.project_id = String(row.project_id); row.task_id = String(row.task_id);
    const nameKey = normalizedName(row.annotator), key = `${row.project_id}/${row.task_id}`;
    if (!peopleMap.has(nameKey)) peopleMap.set(nameKey, { annotator: row.annotator, taskKeys: new Set(), incomplete: false });
    peopleMap.get(nameKey).taskKeys.add(key);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const taskRegions = new Map();
  for (const [key, records] of groups) {
    const row = records[0];
    const info = { project_id: row.project_id, task_id: row.task_id, annotator: row.annotator, url: String(row.url || '').split('#')[0], region_count: null, error_count: null, pass_count: null, pass_rate: null, version: '', version_id: '', updated_at: '', annotation_id: '', issue: '' };
    tasks.push(info);
    try {
      if (new Set(records.map(r => normalizedName(r.annotator))).size !== 1) throw new Error('同一任务在质检表中有多个标注员，请先核对归属');
      if (records.some(r => !['合格', '不合格'].includes(r.result))) throw new Error('质检结果只能是合格或不合格');
      const task = taskDataByKey instanceof Map ? taskDataByKey.get(key) : taskDataByKey[key];
      if (!task || task.error) throw new Error(task?.error || '未读取到任务详情');
      const projectId = typeof task.project === 'object' ? task.project?.id : task.project;
      if (String(task.id) !== row.task_id || String(projectId) !== row.project_id) throw new Error('接口返回的项目或任务 ID 与链接不一致');
      const { selected, annotation, version } = selectVersion(task, row.annotator, useDrafts);
      info.version = version; info.version_id = String(selected.id ?? ''); info.updated_at = selected.updated_at || selected.created_at || ''; info.annotation_id = annotation.id;
      const unique = new Map();
      for (const item of selected.result) {
        if (!item || !['rectanglelabels', 'rectangle'].includes(item.type)) continue;
        if (typeof item.id !== 'string' || !item.id.trim()) throw new Error('标注框缺少有效 ID，无法准确计数');
        const labelValues = item.value?.rectanglelabels || item.value?.labels || [];
        const labels = Array.isArray(labelValues) ? labelValues.map(String) : [];
        const existing = unique.get(item.id);
        if (existing) { existing.labels = [...new Set([...existing.labels, ...labels])]; existing.label = existing.labels.join('、'); continue; }
        unique.set(item.id, { key: `${key}/${item.id}`, project_id: row.project_id, task_id: row.task_id, annotator: row.annotator, region_id: item.id, label: labels.join('、'), labels, version, error: 0, qc_source_rows: [] });
      }
      info.region_count = unique.size;
      if (!unique.size) throw new Error('选用版本没有可统计的矩形框，请核对任务或草稿');
      taskRegions.set(key, unique); regions.push(...unique.values());
    } catch (error) {
      info.issue = error.message;
      for (const record of records) addIssue(record, error.message, 'TASK');
    }
  }
  for (const row of qc) {
    if (row.result !== '不合格') continue;
    const key = `${row.project_id}/${row.task_id}`, available = taskRegions.get(key);
    if (!available) { row.match_method = '任务待核对'; continue; }
    try {
      let image = String(row.image || ''); try { image = decodeURIComponent(image); } catch { /* Keep literal filename. */ }
      const original = /QC_(\d+)_(.+?)_([0-9a-fA-F]{10})\.png(?:[?#\s]|$)/i.exec(image);
      if (original && original[1] !== row.task_id) throw new Error('质检图片里的任务 ID 与链接不同');
      row.original_region_id = original?.[2] || '';
      let region = available.get(row.original_region_id), method = '原框ID匹配';
      if (!region) {
        const ratio = normalizedLabel(row.ratio);
        const candidates = [...available.values()].filter(r => ratio && r.labels.some(label => normalizedLabel(label) === ratio));
        if (candidates.length !== 1) throw new Error(candidates.length ? `“${row.ratio}”对应 ${candidates.length} 个框，无法唯一确定错误 ID` : `找不到错误框 ID，且“${row.ratio || '未填写比例'}”无法唯一对应`);
        region = candidates[0];
        method = row.original_region_id ? '原ID已变更，按同任务唯一比例匹配' : '图片字段未带ID，按同任务唯一比例匹配';
      }
      row.matched_region_id = region.region_id; row.region_key = region.key; row.match_method = method;
      region.error = 1;
      if (!region.qc_source_rows.includes(row.source_row)) region.qc_source_rows.push(row.source_row);
      if (method !== '原框ID匹配') mappingNotes.push({ source_row: row.source_row, project_id: row.project_id, task_id: row.task_id, original_region_id: row.original_region_id, matched_region_id: row.matched_region_id, match_method: method });
    } catch (error) { row.match_method = '待核对'; addIssue(row, error.message, 'REGION'); }
  }
  for (const task of tasks) {
    const key = `${task.project_id}/${task.task_id}`, own = taskRegions.get(key);
    const ownIssues = issues.filter(i => `${i.project_id}/${i.task_id}` === key);
    task.issue = [...new Set(ownIssues.map(i => i.message))].join('；');
    if (!own) continue;
    task.error_count = [...own.values()].filter(r => r.error).length;
    if (!ownIssues.length) { task.pass_count = task.region_count - task.error_count; task.pass_rate = 1 - task.error_count / task.region_count; }
  }
  if (!groups.size) issues.push({ code: 'EMPTY', message: '没有可统计的质检记录' });
  const people = [...peopleMap.entries()].map(([key, person]) => {
    const own = tasks.filter(t => normalizedName(t.annotator) === key);
    const count = own.reduce((n, t) => n + (t.region_count || 0), 0), errors = own.reduce((n, t) => n + (t.error_count || 0), 0);
    const valid = !person.incomplete && count > 0;
    return { annotator: person.annotator, task_count: person.taskKeys.size, region_count: valid ? count : null, error_count: valid ? errors : null, pass_count: valid ? count - errors : null, pass_rate: valid ? 1 - errors / count : null };
  });
  const count = regions.length, errors = regions.filter(r => r.error).length, complete = !issues.length;
  return { people, tasks, regions, qc, issues, complete, mappingNotes, totals: { tasks: groups.size, regions: count, errors, passes: complete ? count - errors : null, pass_rate: complete && count ? 1 - errors / count : null } };
}

function toCSV(headers, rows) {
  const cell = value => {
    let text = String(value ?? '');
    // Spreadsheet programs interpret these prefixes as formulas, even inside CSV quotes.
    if (/^[\s\uFEFF]*[=+@-]/.test(text)) text = `'${text}`;
    const escaped = text.replace(/"/g, '""');
    return /[",\r\n]/.test(escaped) ? `"${escaped}"` : escaped;
  };
  return '\uFEFF' + [headers, ...rows].map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}

async function fetchTaskJSON(url, { fetchImpl = globalThis.fetch, signal, timeoutMs = 20000, maxAttempts = 3, retryDelayMs = 500, allowArray = false } = {}) {
  const abortError = () => new DOMException('已停止读取', 'AbortError');
  const pause = ms => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const onAbort = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal?.aborted) throw abortError();
    const request = new AbortController(); let timedOut = false;
    const cancel = () => request.abort(); signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => { timedOut = true; request.abort(); }, timeoutMs);
    let retry = false, delay = retryDelayMs * (attempt + 1);
    try {
      const response = await fetchImpl(url, { method: 'GET', credentials: 'same-origin', headers: { Accept: 'application/json' }, cache: 'no-store', signal: request.signal });
      if (!response.ok) {
        retry = [408, 429].includes(response.status) || response.status >= 500;
        const retryAfter = response.headers?.get?.('Retry-After');
        if (retryAfter && Number.isFinite(Number(retryAfter))) delay = Math.max(delay, Math.min(15000, Number(retryAfter) * 1000));
        throw new Error([401, 403].includes(response.status) ? `HTTP ${response.status}：请确认已登录且有任务查看权限` : `HTTP ${response.status}：任务读取失败`);
      }
      const type = response.headers?.get?.('content-type');
      if (type && !/\bjson\b/i.test(type)) throw new Error('接口返回的不是 JSON，请确认登录状态');
      const data = await response.json();
      if (!data || typeof data !== 'object' || (!allowArray && Array.isArray(data))) throw new Error('接口返回格式不正确');
      return data;
    } catch (error) {
      if (signal?.aborted) throw abortError();
      if (timedOut) { retry = true; error = new Error('任务读取超时，请稍后重试'); }
      else if (error instanceof TypeError || error.name === 'NetworkError') retry = true;
      if (!retry || attempt === maxAttempts - 1) throw error;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
    await pause(delay);
  }
  throw new Error('没有执行有效的读取请求');
}

const HISTORY_DEFAULT_ORIGIN = 'https://label.insta360.com';
const POSITIVE_ID = /^[1-9]\d*$/;
const ACCEPTED = new Set(['REVIEWED_ACCEPTED', 'REVIEW_ACCEPTED', 'ACCEPTED', 'APPROVED', 'PASS', 'PASSED', '通过', '审核通过']);
const REJECTED = new Set(['REVIEWED_REJECTED', 'REVIEW_REJECTED', 'REJECTED', 'REJECT', '审核驳回', '审核未通过']);
const NON_REVIEW = new Set(['ANNOTATED', 'TASK_ANNOTATED', 'REWORK', 'REPAIR', 'CREATED', 'PENDING', 'PENDING_ANNOTATION', 'APPEALED', 'APPEAL_ACCEPTED', 'APPEAL_REJECTED', 'ACCEPTANCE_ACCEPTED', 'ACCEPTANCE_REJECTED']);

function text(value) {
  return String(value ?? '').trim();
}

function id(value) {
  const raw = value && typeof value === 'object' ? value.id ?? value.value : value;
  return POSITIVE_ID.test(text(raw)) ? text(raw) : '';
}

function normalized(value) {
  return text(value).replace(/[\s-]+/g, '_').toUpperCase();
}

function recordValues(record) {
  const values = [];
  for (const key of ['state', 'status', 'current_state', 'currentStatus', 'workflow_state', 'workflowState', 'previous_state', 'previousStatus', 'previous_status', 'transition_name', 'transition', 'action', 'result']) {
    if (record && record[key] != null) values.push(record[key]);
  }
  const context = record?.context_data && typeof record.context_data === 'object' ? record.context_data : null;
  if (context) for (const key of ['state', 'status', 'previous_state', 'result', 'review_result', 'review_status']) if (context[key] != null) values.push(context[key]);
  return values;
}

function parseProjectIds(input) {
  const values = text(input).split(/[,，;；\s]+/).filter(Boolean);
  if (!values.length || values.some(value => !POSITIVE_ID.test(value))) throw new Error('项目 ID 必须是正整数，可用空格、换行或逗号分隔');
  return [...new Set(values)];
}

function cardLink(card) {
  const outer = typeof card?.closest === 'function' ? card.closest('a[href]') : null;
  const inner = typeof card?.querySelector === 'function' ? card.querySelector('a[href]') : null;
  const href = outer?.getAttribute?.('href') || inner?.getAttribute?.('href') || card?.getAttribute?.('href') || '';
  return text(href);
}

function cardTitle(card) {
  for (const selector of ['.ls-project-card__title-text', '.ls-project-card__title', '[data-project-title]']) {
    const node = typeof card?.querySelector === 'function' ? card.querySelector(selector) : null;
    const value = text(node?.textContent || node?.getAttribute?.('data-project-title'));
    if (value) return value.replace(/\s+/g, ' ');
  }
  return '';
}

function extractCurrentProjectCards(root = globalThis.document, currentURL = '') {
  const source = root && typeof root.querySelectorAll === 'function' ? root : null;
  const found = new Map();
  const cards = source ? [...source.querySelectorAll('.ls-project-card')] : [];
  for (const card of cards) {
    const href = cardLink(card);
    const match = /\/projects\/([1-9]\d*)(?:\/|$)/.exec(href);
    if (!match || found.has(match[1])) continue;
    found.set(match[1], { project_id: match[1], project_name: cardTitle(card) });
  }
  if (!found.size && currentURL) {
    const match = /\/projects\/([1-9]\d*)(?:\/|$)/.exec(String(currentURL));
    if (match) found.set(match[1], { project_id: match[1], project_name: '' });
  }
  return [...found.values()];
}

function classifyHistoryStatus(record) {
  const stateValue = record?.state ?? record?.current_state ?? record?.currentStatus ?? record?.workflow_state ?? record?.workflowState ?? record?.status;
  if (stateValue != null && NON_REVIEW.has(normalized(stateValue))) return '';
  for (const value of recordValues(record)) {
    const raw = text(value);
    const norm = normalized(raw);
    if (ACCEPTED.has(raw) || ACCEPTED.has(norm) || /(?:REVIEW|审核).*?(?:ACCEPT|PASS|通过)/i.test(raw)) return '通过';
    if (REJECTED.has(raw) || REJECTED.has(norm) || /(?:REVIEW|审核).*?(?:REJECT|FAIL|驳回|未通过)/i.test(raw)) return '驳回';
  }
  return '';
}

function eventTime(row) {
  const value = row?.created_at ?? row?.createdAt ?? row?.timestamp ?? row?.time;
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? time : 0;
}

function localDayBoundary(value, end = false) {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value).trim());
  if (!match) throw new Error('日期必须使用 YYYY-MM-DD 格式');
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), end ? 23 : 0, end ? 59 : 0, end ? 59 : 0, end ? 999 : 0);
  if (date.getFullYear() !== Number(match[1]) || date.getMonth() !== Number(match[2]) - 1 || date.getDate() !== Number(match[3])) throw new Error('日期无效');
  return date.getTime();
}

function filterHistoryRows(rows, { start = '', end = '' } = {}) {
  if (!Array.isArray(rows)) throw new TypeError('历史记录必须是数组');
  const from = localDayBoundary(start, false);
  const to = localDayBoundary(end, true);
  if (from != null && to != null && from > to) throw new Error('开始日期不能晚于结束日期');
  return rows.filter(row => {
    const time = eventTime(row);
    return time && (from == null || time >= from) && (to == null || time <= to);
  });
}

function userId(value) {
  const raw = value && typeof value === 'object'
    ? value.user_id ?? value.id ?? value.value ?? value.user?.id
    : value;
  return POSITIVE_ID.test(text(raw)) ? text(raw) : '';
}

function createdUsernameName(value) {
  const raw = text(value)
    .replace(/[^\s,，]+@[^\s,，]+/g, ' ')
    .replace(/[,，]/g, ' ')
    .split(/\s+/)
    .filter(part => part && !/^\d+$/.test(part))
    .join(' ');
  const normalized = raw.replace(/\s+/g, ' ').trim();
  return /[\u3400-\u9fff]/.test(normalized) ? normalized.replace(/\s/g, '') : normalized;
}

function displayName(value, { createdUsername = '', allowId = true } = {}) {
  if (value && typeof value === 'object') {
    const full = `${value.first_name || ''}${value.last_name || ''}`.trim();
    if (full) return full;
    const created = createdUsernameName(value.created_username ?? value.createdUsername ?? createdUsername);
    if (created) return created;
    return text(value.username || value.name || value.display_name || value.nickname || value.email || (allowId ? value.id : ''));
  }
  const raw = text(value);
  return allowId ? raw : (POSITIVE_ID.test(raw) ? '' : raw);
}

function taskAnnotatorMap(detail, task) {
  const map = new Map();
  for (const list of [detail?.annotators, task?.annotators]) {
    if (!Array.isArray(list)) continue;
    for (const value of list) {
      const key = userId(value);
      const name = displayName(value, { allowId: false });
      if (key && name) map.set(key, name);
    }
  }
  return map;
}

function addUserDirectoryRows(map, rows) {
  for (const value of Array.isArray(rows) ? rows : []) {
    const key = userId(value);
    const name = displayName(value, { allowId: false });
    if (key && name) map.set(key, name);
  }
  return map;
}

function candidateName(candidates, userMap) {
  let fallback = '';
  for (const [value, createdUsername] of candidates) {
    const name = resolvedName(value, userMap, createdUsername);
    if (!name) continue;
    if (!fallback) fallback = name;
    if (!/^用户ID \d+$/.test(name)) return name;
  }
  return fallback;
}

function resolvedName(value, userMap, createdUsername = '') {
  const key = userId(value);
  if (key && userMap?.has(key)) return userMap.get(key);
  const name = displayName(value, { createdUsername, allowId: false });
  if (name) return name;
  return key ? `用户ID ${key}` : '';
}

function annotatorOf(row, userMap) {
  const candidates = [
    [row?.annotator, row?.created_username],
    [row?.annotator_name, row?.created_username],
    [row?.completed_by, row?.created_username],
    [row?.created_by, row?.created_username],
    [row?.triggered_by, row?.created_username],
    [row?.user, row?.created_username],
  ];
  for (const [value, createdUsername] of candidates) {
    const name = resolvedName(value, userMap, createdUsername);
    if (name) return name;
  }
  return '';
}

function annotationForTask(detail, event) {
  const annotations = Array.isArray(detail?.annotations) ? detail.annotations.filter(value => value && !value.was_cancelled) : [];
  const requested = event?.annotation_id ?? event?.annotation?.id ?? event?.context_data?.annotation_id ?? event?.context_data?.annotation?.id;
  const match = requested == null ? null : annotations.find(value => String(value.id) === String(requested));
  if (match) return match;
  return [...annotations].sort((a, b) => eventTime(b) - eventTime(a))[0] || annotations[0] || null;
}

function projectOf(row) {
  return id(row?.project_id ?? row?.project ?? row?.context_data?.project_id);
}

function taskOf(row) {
  return id(row?.task_id ?? row?.task ?? row?.context_data?.task_id ?? row?.context_data?.task?.id);
}

function projectNameOf(row) {
  return text(row?.project_name ?? row?.project_title ?? row?.context_data?.project_name);
}

function aggregateHistory(rows) {
  if (!Array.isArray(rows)) throw new TypeError('历史记录必须是数组');
  const people = new Map();
  const projects = new Map();
  const issues = [];
  let pass = 0, reject = 0;
  for (const row of rows) {
    if (!row || typeof row !== 'object') { issues.push({ message: '历史记录格式不正确' }); continue; }
    const status = row.status || classifyHistoryStatus(row);
    if (!['通过', '驳回'].includes(status)) continue;
    const annotator = annotatorOf(row) || '未识别人员';
    const projectId = projectOf(row) || '未知项目';
    const projectName = projectNameOf(row);
    const personKey = annotator;
    const projectKey = projectId;
    if (!people.has(personKey)) people.set(personKey, { annotator, pass_count: 0, reject_count: 0, total_count: 0, pass_rate: null });
    if (!projects.has(projectKey)) projects.set(projectKey, { project_id: projectId, project_name: projectName, pass_count: 0, reject_count: 0, total_count: 0, pass_rate: null });
    const person = people.get(personKey), project = projects.get(projectKey);
    const passValue = status === '通过';
    if (passValue) { pass++; person.pass_count++; project.pass_count++; }
    else { reject++; person.reject_count++; project.reject_count++; }
    person.total_count++; project.total_count++;
  }
  const finish = item => ({ ...item, pass_rate: item.total_count ? item.pass_count / item.total_count : null });
  const peopleRows = [...people.values()].map(finish).sort((a, b) => a.annotator.localeCompare(b.annotator, 'zh-CN'));
  const projectRows = [...projects.values()].map(finish).sort((a, b) => a.project_id.localeCompare(b.project_id, 'en'));
  return { people: peopleRows, projects: projectRows, issues, totals: { pass_count: pass, reject_count: reject, total_count: pass + reject, pass_rate: pass + reject ? pass / (pass + reject) : null } };
}

function safeURL(value, base, origin) {
  const url = new URL(value, base);
  if (url.origin !== origin || !/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error('分页地址必须属于当前登录网站');
  url.hash = '';
  return url.href;
}

function abortError() { return new DOMException('已停止读取', 'AbortError'); }

async function fetchHistoryPaged(url, { requestJSON, origin = HISTORY_DEFAULT_ORIGIN, signal, kind = '历史记录', onPage } = {}) {
  if (typeof requestJSON !== 'function') throw new TypeError('requestJSON 必须是函数');
  const rows = [], seen = new Set(), visited = new Set();
  let next = url, expected = null, base = `${origin}/`, page = 0;
  try {
    while (next) {
      if (signal?.aborted) throw abortError();
      const address = safeURL(next, base, origin);
      if (visited.has(address)) throw new Error(`${kind}分页地址重复`);
      visited.add(address);
      const data = await requestJSON(address, { signal });
      if (signal?.aborted) throw abortError();
      const batch = Array.isArray(data) ? data : Array.isArray(data?.results) ? data.results : Array.isArray(data?.tasks) ? data.tasks : null;
      if (!batch) throw new Error(`${kind}接口返回格式不正确`);
      if (data && !Array.isArray(data) && data.count != null) {
        if (!Number.isSafeInteger(data.count) || data.count < 0) throw new Error(`${kind}数量格式不正确`);
        if (expected != null && expected !== data.count) throw new Error(`${kind}总数量发生变化`);
        expected = data.count;
      }
      for (const row of batch) {
        const key = row?.id == null ? `row:${rows.length}:${JSON.stringify(row)}` : String(row.id);
        if (!seen.has(key)) { seen.add(key); rows.push(row); }
      }
      page++;
      onPage?.({ page, count: rows.length, total: expected });
      next = Array.isArray(data) ? null : data.next || null;
      base = address;
    }
    if (expected != null && rows.length !== expected) throw new Error(`${kind}读取不完整：共 ${expected} 条，实际 ${rows.length} 条`);
    return rows;
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') throw abortError();
    error.partialRows = rows.slice();
    throw error;
  }
}

async function collectProjectHistory(projectIds, { requestJSON, origin = HISTORY_DEFAULT_ORIGIN, signal, start = '', end = '', onProgress, concurrency = 8 } = {}) {
  const projects = parseProjectIds(projectIds);
  // Validate the requested date range before making network calls.
  filterHistoryRows([], { start, end });
  const currentOrigin = new URL(origin).origin;
  const projectRows = await fetchHistoryPaged(`${currentOrigin}/api/projects/?ids=${projects.join(',')}&page_size=100`, { requestJSON, origin: currentOrigin, signal, kind: '项目' });
  const projectMap = new Map(projectRows.map(row => [id(row?.id), { project_id: id(row?.id), project_name: text(row?.title ?? row?.name) }]));
  const failures = [], raw = [], userDirectory = new Map();
  let userDirectoryPromise = null;
  const loadUserDirectory = () => {
    if (!userDirectoryPromise) {
      userDirectoryPromise = fetchHistoryPaged(`${currentOrigin}/api/users/?page_size=500`, { requestJSON, origin: currentOrigin, signal, kind: '用户' })
        .then(rows => { addUserDirectoryRows(userDirectory, rows); return true; })
        .catch(error => {
          if (error.name === 'AbortError') throw error;
          addUserDirectoryRows(userDirectory, error.partialRows || []);
          failures.push({ project_id: '', task_id: '', message: `用户姓名读取失败：${error.message}` });
          return false;
        });
    }
    return userDirectoryPromise;
  };
  for (const projectId of projects) {
    let tasks = [];
    try { tasks = await fetchHistoryPaged(`${currentOrigin}/api/tasks/?project=${projectId}&page_size=500`, { requestJSON, origin: currentOrigin, signal, kind: `项目 ${projectId} 任务`, onPage: info => onProgress?.({ phase: 'tasks', projectId, ...info }) }); }
    catch (error) { if (error.name === 'AbortError') throw error; failures.push({ project_id: projectId, task_id: '', message: error.message }); tasks = error.partialRows || []; }
    const validTasks = tasks.filter(task => id(task?.id) && id(task?.project ?? task?.project_id) === projectId);
    if (validTasks.some(task => userId(task?.annotator) || (Array.isArray(task?.annotators) && task.annotators.some(value => userId(value))))) void loadUserDirectory().catch(() => {});
    let cursor = 0, done = 0;
    async function worker() {
      while (cursor < validTasks.length) {
        if (signal?.aborted) throw abortError();
        const task = validTasks[cursor++], taskId = id(task.id);
        try {
          const detailPromise = requestJSON(`${currentOrigin}/api/tasks/${taskId}/`, { signal })
            .then(fetched => fetched && typeof fetched === 'object' ? fetched : task)
            .catch(() => task); // History rows remain useful even if task detail is unavailable.
          const historyPromise = fetchHistoryPaged(`${currentOrigin}/api/fsm/entities/task/${taskId}/history`, { requestJSON, origin: currentOrigin, signal, kind: `任务 ${taskId} 历史` });
          const [detail, rows] = await Promise.all([detailPromise, historyPromise]);
          const userMap = new Map(userDirectory);
          for (const [key, name] of taskAnnotatorMap(detail, task)) userMap.set(key, name);
          for (const event of rows) {
            const status = classifyHistoryStatus(event);
            if (!status) continue;
            const annotation = annotationForTask(detail, event);
            const candidates = [
              [event.annotator, event.created_username],
              [event.annotator_name, event.created_username],
              [event.annotation?.completed_by, event.annotation?.created_username],
              [event.context_data?.annotator, event.context_data?.created_username],
              [annotation?.completed_by, annotation?.created_username],
              [task.annotator, task.created_username],
              [task.annotators?.[0], task.created_username],
              [event.completed_by, event.created_username],
            ];
            let annotator = candidateName(candidates, userMap);
            if (/^用户ID \d+$/.test(annotator)) {
              await loadUserDirectory();
              const resolvedMap = new Map(userDirectory);
              for (const [key, name] of taskAnnotatorMap(detail, task)) resolvedMap.set(key, name);
              annotator = candidateName(candidates, resolvedMap);
            }
            raw.push({ ...event, project_id: projectId, project_name: projectMap.get(projectId)?.project_name || '', task_id: taskId, status, annotator: annotator || '未识别人员', task_url: `${currentOrigin}/workspaces/all/projects/${projectId}/data?task=${taskId}` });
          }
        } catch (error) {
          if (error.name === 'AbortError') throw error;
          failures.push({ project_id: projectId, task_id: taskId, message: error.message });
        }
        done++;
        onProgress?.({ phase: 'history', projectId, taskId, done, total: validTasks.length, count: raw.length });
      }
    }
    await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), validTasks.length || 1) }, worker));
  }
  const selected = filterHistoryRows(raw, { start, end });
  const aggregate = aggregateHistory(selected);
  return { projects, projectRows: projects.map(projectId => projectMap.get(projectId) || { project_id: projectId, project_name: '' }), rows: selected, allRows: raw, failures, ...aggregate, complete: failures.length === 0 };
}

/**
 * Create an XLSX workbook without dependencies. Percent columns are zero based.
 * Keep helpers inside this function so the complete exporter can be inlined.
 */
function workbookBytes(sheets) {
  if (!Array.isArray(sheets)) throw new TypeError('sheets must be an array');
  if (sheets.length > 65530) throw new RangeError('Too many sheets for a ZIP32 workbook');

  const encoder = new TextEncoder();
  const namespace = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const relationshipNamespace = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const usedNames = new Set();
  const files = [];

  function cleanText(value) {
    let result = '';
    for (const character of String(value)) {
      const point = character.codePointAt(0);
      if (point === 9 || point === 10 || point === 13 ||
          (point >= 0x20 && point <= 0xd7ff) ||
          (point >= 0xe000 && point <= 0xfffd) ||
          (point >= 0x10000 && point <= 0x10ffff)) result += character;
    }
    return result;
  }

  function xml(value) {
    const escapes = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;', '\r': '&#13;' };
    return cleanText(value).replace(/[&<>"'\r]/g, character => escapes[character]);
  }

  function shortName(value, length) {
    const result = value.slice(0, length);
    return /[\ud800-\udbff]$/.test(result) ? result.slice(0, -1) : result;
  }

  function sheetName(value, index) {
    let base = cleanText(value == null ? '' : value)
      .replace(/[\[\]:*?\/\\\u0000-\u001f]/g, ' ')
      .trim().replace(/^'+|'+$/g, '').trim();
    if (!base) base = `Sheet${index + 1}`;
    if (base.toLowerCase() === 'history') base += '_';
    base = shortName(base, 31).replace(/'+$/g, '');
    let name = base;
    let number = 2;
    while (usedNames.has(name.toLowerCase())) {
      const suffix = ` (${number++})`;
      name = shortName(base, 31 - suffix.length) + suffix;
    }
    usedNames.add(name.toLowerCase());
    return name;
  }

  function columnName(index) {
    let name = '';
    for (let value = index + 1; value; value = Math.floor((value - 1) / 26)) {
      name = String.fromCharCode(65 + ((value - 1) % 26)) + name;
    }
    return name;
  }

  function cell(value, reference, header, percentage) {
    const numeric = typeof value === 'number' && Number.isFinite(value);
    const style = header ? 1 : numeric && percentage ? 2 : 0;
    const start = `<c r="${reference}" s="${style}"`;
    if (value == null) return `${start}/>`;
    if (numeric) return `${start}><v>${value}</v></c>`;
    if (typeof value === 'boolean') return `${start} t="b"><v>${value ? 1 : 0}</v></c>`;
    return `${start} t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
  }

  function addFile(name, content) {
    files.push({ name: encoder.encode(name), data: encoder.encode(declaration + content) });
  }

  const normalized = (sheets.length ? sheets : [{ name: 'Sheet1', headers: [], rows: [] }]).map((sheet, index) => {
    if (!sheet || !Array.isArray(sheet.headers) || !Array.isArray(sheet.rows)) {
      throw new TypeError('Each sheet must contain headers and rows arrays');
    }
    if (sheet.rows.length > 1048575) throw new RangeError('A sheet cannot exceed 1048576 rows including its header');
    let columns = Math.max(1, sheet.headers.length);
    for (const row of sheet.rows) {
      if (!Array.isArray(row)) throw new TypeError('Each sheet row must be an array');
      columns = Math.max(columns, row.length);
    }
    if (columns > 16384) throw new RangeError('A sheet cannot exceed 16384 columns');
    return { ...sheet, name: sheetName(sheet.name, index), columns };
  });

  const sheetTags = [];
  const sheetRelationships = [];
  const sheetTypes = [];
  for (let index = 0; index < normalized.length; index++) {
    const sheet = normalized[index];
    const id = index + 1;
    const columns = Array.from({ length: sheet.columns }, (_, column) => columnName(column));
    const range = `A1:${columns.at(-1)}${sheet.rows.length + 1}`;
    const percentages = new Set(sheet.percentColumns || []);
    const widths = sheet.widths || [];
    const content = [
      `<worksheet xmlns="${namespace}">`,
      `<dimension ref="${range}"/>`,
      '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>',
      '<sheetFormatPr defaultRowHeight="15"/>',
      '<cols>',
    ];
    for (let column = 0; column < sheet.columns; column++) {
      const requested = widths[column];
      const width = typeof requested === 'number' && Number.isFinite(requested) && requested > 0 ? Math.min(255, requested) : 22;
      content.push(`<col min="${column + 1}" max="${column + 1}" width="${width}" customWidth="1"/>`);
    }
    content.push('</cols><sheetData><row r="1" ht="30" customHeight="1">');
    for (let column = 0; column < sheet.columns; column++) {
      content.push(cell(sheet.headers[column], `${columns[column]}1`, true, false));
    }
    content.push('</row>');
    for (let row = 0; row < sheet.rows.length; row++) {
      const rowNumber = row + 2;
      content.push(`<row r="${rowNumber}">`);
      for (let column = 0; column < sheet.columns; column++) {
        content.push(cell(sheet.rows[row][column], `${columns[column]}${rowNumber}`, false, percentages.has(column)));
      }
      content.push('</row>');
    }
    content.push(`</sheetData><autoFilter ref="${range}"/></worksheet>`);
    addFile(`xl/worksheets/sheet${id}.xml`, content.join(''));
    sheetTags.push(`<sheet name="${xml(sheet.name)}" sheetId="${id}" r:id="rId${id}"/>`);
    sheetRelationships.push(`<Relationship Id="rId${id}" Type="${relationshipNamespace}/worksheet" Target="worksheets/sheet${id}.xml"/>`);
    sheetTypes.push(`<Override PartName="/xl/worksheets/sheet${id}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);
  }

  addFile('xl/styles.xml', `<styleSheet xmlns="${namespace}">` +
    '<numFmts count="1"><numFmt numFmtId="164" formatCode="0.00%"/></numFmts>' +
    '<fonts count="2"><font><sz val="11"/><color rgb="FF1F2937"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font></fonts>' +
    '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F4E78"/><bgColor indexed="64"/></patternFill></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>' +
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>' +
    '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>');
  addFile('xl/workbook.xml', `<workbook xmlns="${namespace}" xmlns:r="${relationshipNamespace}"><bookViews><workbookView activeTab="0"/></bookViews><sheets>${sheetTags.join('')}</sheets></workbook>`);
  addFile('xl/_rels/workbook.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + sheetRelationships.join('') +
    `<Relationship Id="rId${normalized.length + 1}" Type="${relationshipNamespace}/styles" Target="styles.xml"/></Relationships>`);
  addFile('_rels/.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${relationshipNamespace}/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  addFile('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' + sheetTypes.join('') + '</Types>');

  // ZIP32 stored entries keep this implementation usable offline in userscripts.
  const crcTable = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    crcTable[index] = value >>> 0;
  }
  let localSize = 0;
  let centralSize = 0;
  for (const file of files) {
    let crc = 0xffffffff;
    for (const byte of file.data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    file.crc = (crc ^ 0xffffffff) >>> 0;
    file.offset = localSize;
    localSize += 30 + file.name.length + file.data.length;
    centralSize += 46 + file.name.length;
  }
  const totalSize = localSize + centralSize + 22;
  if (totalSize > 0xffffffff) throw new RangeError('Workbook exceeds the ZIP32 size limit');
  const bytes = new Uint8Array(totalSize);
  const view = new DataView(bytes.buffer);
  const u16 = (offset, value) => view.setUint16(offset, value, true);
  const u32 = (offset, value) => view.setUint32(offset, value, true);
  let directoryOffset = localSize;
  for (const file of files) {
    const offset = file.offset;
    u32(offset, 0x04034b50);
    u16(offset + 4, 20);
    u16(offset + 12, 33); // DOS date: January 1, 1980; fixed for reproducibility.
    u32(offset + 14, file.crc);
    u32(offset + 18, file.data.length);
    u32(offset + 22, file.data.length);
    u16(offset + 26, file.name.length);
    bytes.set(file.name, offset + 30);
    bytes.set(file.data, offset + 30 + file.name.length);
    u32(directoryOffset, 0x02014b50);
    u16(directoryOffset + 4, 20);
    u16(directoryOffset + 6, 20);
    u16(directoryOffset + 14, 33);
    u32(directoryOffset + 16, file.crc);
    u32(directoryOffset + 20, file.data.length);
    u32(directoryOffset + 24, file.data.length);
    u16(directoryOffset + 28, file.name.length);
    u32(directoryOffset + 42, offset);
    bytes.set(file.name, directoryOffset + 46);
    directoryOffset += 46 + file.name.length;
  }
  u32(directoryOffset, 0x06054b50);
  u16(directoryOffset + 8, files.length);
  u16(directoryOffset + 10, files.length);
  u32(directoryOffset + 12, centralSize);
  u32(directoryOffset + 16, localSize);
  return bytes;
}

return {taskIdentity, parseTable, calculate, toCSV, fetchTaskJSON, parseProjectIds, extractCurrentProjectCards, classifyHistoryStatus, filterHistoryRows, aggregateHistory, fetchHistoryPaged, collectProjectHistory, workbookBytes};
})();
const Comments = (() => {
const COMMENT_DEFAULT_ORIGIN = 'https://label.insta360.com';

function commentAbortError() {
  const error = new Error('已停止读取');
  error.name = 'AbortError';
  return error;
}

function commentCheckAbort(signal, error) {
  if (signal?.aborted || error?.name === 'AbortError') throw commentAbortError();
}

function commentOrigin(origin) {
  let url;
  try { url = new URL(origin || COMMENT_DEFAULT_ORIGIN); } catch { throw new Error('当前网站地址格式不正确'); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error('当前网站必须使用有效的 HTTP 同源地址');
  return url.origin;
}

function commentSafeURL(value, base, origin, kind) {
  let url;
  try { url = new URL(value, base); } catch { throw new Error(`${kind}分页地址格式不正确`); }
  if (url.origin !== origin || !/^https?:$/.test(url.protocol)) throw new Error(`${kind}分页地址必须属于当前同源网站`);
  if (url.username || url.password) throw new Error(`${kind}分页地址不能包含登录凭据`);
  url.hash = '';
  return url;
}

function commentRequest(url, { requestJSON, signal }) {
  commentCheckAbort(signal);
  if (typeof requestJSON !== 'function') return Promise.reject(new TypeError('requestJSON must be a function'));
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(commentAbortError()); };
    const cleanup = () => signal?.removeEventListener('abort', abort);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    Promise.resolve().then(() => {
      commentCheckAbort(signal);
      return requestJSON(url, { signal });
    }).then(value => {
      cleanup();
      if (signal?.aborted) reject(commentAbortError());
      else resolve(value);
    }, error => {
      cleanup();
      reject(signal?.aborted || error?.name === 'AbortError' ? commentAbortError() : error);
    });
  });
}

function commentPositiveId(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : '';
  return typeof value === 'string' && /^[1-9]\d*$/.test(value) ? value : '';
}

function commentReferenceId(value) {
  return commentPositiveId(value && typeof value === 'object' ? value.id : value);
}

function commentText(value) {
  if (value == null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function commentMessage(error) {
  return error?.message || String(error || '未知错误');
}

function parseProjectIds(text) {
  const values = String(text ?? '').trim().split(/[,，\s]+/).filter(Boolean);
  if (!values.length || values.some(value => !commentPositiveId(value))) throw new Error('项目 ID 必须是正整数，可用英文逗号、中文逗号或空白分隔');
  return [...new Set(values)];
}

/**
 * Read documented array/results/comments/tasks pages. On incomplete reads the
 * rejected error carries partialRows, which callers can retain as partial data.
 */
async function fetchPagedRows(url, { requestJSON, origin = COMMENT_DEFAULT_ORIGIN, signal, kind = '记录', onPage } = {}) {
  commentCheckAbort(signal);
  const currentOrigin = commentOrigin(origin);
  const rows = [], ids = new Set(), visited = new Set();
  let next = url, base = `${currentOrigin}/`, expectedCount = null, page = 0;
  try {
    while (next) {
      commentCheckAbort(signal);
      const address = commentSafeURL(next, base, currentOrigin, kind);
      const canonical = new URL(address);
      canonical.searchParams.sort();
      if (visited.has(canonical.href)) throw new Error(`${kind}分页地址重复，未能完整读取`);
      if (page >= 10000) throw new Error(`${kind}分页超过安全上限，未能完整读取`);
      visited.add(canonical.href);
      const data = await commentRequest(address.href, { requestJSON, signal });
      commentCheckAbort(signal);
      let batch, following = null;
      if (Array.isArray(data)) batch = data;
      else if (data && typeof data === 'object') {
        const keys = ['results', 'comments', 'tasks'].filter(key => Object.hasOwn(data, key));
        if (keys.length !== 1 || !Array.isArray(data[keys[0]])) throw new Error(`${kind}接口分页结果格式不正确`);
        batch = data[keys[0]];
        if (Object.hasOwn(data, 'count')) {
          if (typeof data.count !== 'number' || !Number.isSafeInteger(data.count) || data.count < 0) throw new Error(`${kind}分页数量 count 格式不正确`);
          if (expectedCount !== null && expectedCount !== data.count) throw new Error(`${kind}分页总数量发生变化，未能确认完整性`);
          expectedCount = data.count;
        }
        following = data.next;
        if (following != null && typeof following !== 'string') throw new Error(`${kind}下一页地址格式不正确`);
      } else throw new Error(`${kind}接口返回格式不正确`);
      if (batch.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw new Error(`${kind}页结果必须是对象数组，接口格式不正确`);
      for (const row of batch) {
        const id = row.id;
        const hasId = (typeof id === 'string' && id !== '') || (typeof id === 'number' && Number.isFinite(id));
        if (hasId) {
          const key = String(id);
          if (ids.has(key)) continue;
          ids.add(key);
        }
        rows.push(row);
      }
      page++;
      onPage?.({ page, url: address.href, count: rows.length, total: expectedCount, pageCount: batch.length });
      commentCheckAbort(signal);
      if (expectedCount !== null && rows.length > expectedCount) throw new Error(`${kind}唯一记录数量 ${rows.length} 超过 count ${expectedCount}，未能确认完整性`);
      next = following || null;
      base = address.href;
      if (!next && expectedCount !== null && rows.length !== expectedCount) throw new Error(`${kind}唯一记录数量 ${rows.length} 与 count ${expectedCount} 不一致或缺少下一页，未能完整读取`);
    }
    return rows;
  } catch (error) {
    commentCheckAbort(signal, error);
    const failure = new Error(commentMessage(error));
    failure.partialRows = rows.slice();
    throw failure;
  }
}

function commentName(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return /[\u3400-\u9fff]/.test(text) ? text.replace(/\s/g, '') : text;
}

function commentCreatedName(value) {
  return commentName(String(value ?? '').replace(/[^\s,，]+@[^\s,，]+/g, ' ').replace(/[,，]/g, ' ').split(/\s+/).filter(part => part && !/^\d+$/.test(part)).join(' '));
}

function commentUserName(value, users, createdUsername) {
  if (value && typeof value === 'object') {
    const full = commentName(`${value.first_name || ''} ${value.last_name || ''}`);
    if (full) return full;
    if (value.username) return commentName(value.username);
    const fallback = commentCreatedName(createdUsername);
    if (fallback) return fallback;
    return users.get(String(value.id)) || commentText(value.id);
  }
  const fallback = commentCreatedName(createdUsername);
  if (fallback) return fallback;
  return users.get(String(value)) || commentName(value);
}

function commentTime(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? time : 0;
}

function commentCompareId(a, b) {
  const left = String(a ?? ''), right = String(b ?? '');
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
    const l = left.replace(/^0+(?=\d)/, ''), r = right.replace(/^0+(?=\d)/, '');
    return l.length - r.length || (l < r ? -1 : l > r ? 1 : 0);
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

function commentCompare(a, b) {
  return commentTime(a.created_at) - commentTime(b.created_at) || commentCompareId(a.id, b.id);
}

function commentLatest(records, updated = false) {
  return records.filter(value => value && typeof value === 'object').reduce((latest, value) => {
    if (!latest) return value;
    const time = item => updated ? commentTime(item.updated_at) || commentTime(item.created_at) : commentTime(item.created_at);
    return time(value) > time(latest) || (time(value) === time(latest) && commentCompareId(value.id, latest.id) > 0) ? value : latest;
  }, null);
}

function commentFileName(task, origin) {
  const data = task?.data || {};
  const values = [data.filename, data.file_name, data.image, data.video, data.audio, task?.filename, task?.file_name, task?.image, task?.file_url, task?.url];
  for (const value of values) {
    if (typeof value !== 'string' || !value) continue;
    let name;
    try { name = new URL(value, origin).pathname.split('/').pop(); }
    catch { name = value.split(/[\\/]/).pop()?.split(/[?#]/)[0]; }
    if (name) { try { return decodeURIComponent(name); } catch { return name; } }
  }
  return '';
}

function commentImages(images, origin) {
  if (images == null) return '';
  return (Array.isArray(images) ? images : [images]).map(value => {
    if (typeof value !== 'string') return commentText(value);
    try { return new URL(value, origin).href; } catch { return value; }
  }).join('\n');
}

function commentBoolean(value) {
  return value === true || value === 1 || value === 'true' || value === '1';
}

async function collectCommentProjects(projectIds, { origin = COMMENT_DEFAULT_ORIGIN, requestJSON, signal, onProgress, concurrency = 3 } = {}) {
  commentCheckAbort(signal);
  if (!Array.isArray(projectIds) || !projectIds.length || projectIds.some(id => !commentPositiveId(id))) throw new Error('项目 ID 必须是正整数数组且不能为空');
  const projects = [...new Set(projectIds.map(String))];
  const currentOrigin = commentOrigin(origin);
  if (typeof requestJSON !== 'function') throw new TypeError('requestJSON must be a function');
  const workers = Math.max(1, Math.min(3, Number.isFinite(concurrency) ? Math.floor(concurrency) : 3));
  const summaries = [], comments = [], failures = [], warnings = [], users = new Map();
  let commentCount = 0;
  const progress = (phase, projectId, done, total, message) => {
    commentCheckAbort(signal);
    onProgress?.({ phase, projectId, done, total, commentCount, message });
    commentCheckAbort(signal);
  };
  progress('users', '', 0, projects.length, '正在读取用户姓名');
  let userRows = [];
  try {
    userRows = await fetchPagedRows(`${currentOrigin}/api/users/?page_size=500`, { requestJSON, origin: currentOrigin, signal, kind: '用户' });
  } catch (error) {
    commentCheckAbort(signal, error);
    userRows = error.partialRows || [];
    warnings.push(`用户表读取失败，部分姓名可能显示为 ID：${commentMessage(error)}`);
  }
  for (const user of userRows) {
    if (user.id != null) users.set(String(user.id), commentUserName(user, new Map()) || String(user.id));
  }

  async function readTask(raw, projectId) {
    commentCheckAbort(signal);
    const taskId = commentPositiveId(raw.id);
    const pageUrl = `${currentOrigin}/workspaces/all/projects/${projectId}/data?task=${encodeURIComponent(taskId)}`;
    let detail = raw, detailFailure = '', commentFailure = '', list = [];
    try {
      const result = await commentRequest(`${currentOrigin}/api/tasks/${taskId}/`, { requestJSON, signal });
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('任务详情格式不正确');
      if (commentPositiveId(result.id) !== taskId || commentReferenceId(result.project) !== projectId ||
          (result.project_id != null && commentReferenceId(result.project_id) !== projectId)) throw new Error('任务详情的项目或任务 ID 与请求不一致');
      detail = result;
    } catch (error) {
      commentCheckAbort(signal, error);
      detailFailure = `任务详情读取失败：${commentMessage(error)}`;
    }
    // Keep the detail and comments failures independent while limiting the
    // total number of in-flight API tasks to the configured worker count.
    try {
      list = await fetchPagedRows(`${currentOrigin}/api/comments/?task=${encodeURIComponent(taskId)}`, { requestJSON, origin: currentOrigin, signal, kind: '评论' });
    } catch (error) {
      commentCheckAbort(signal, error);
      list = error.partialRows || [];
      commentFailure = `评论读取失败：${commentMessage(error)}`;
    }
    commentCheckAbort(signal);
    const validComments = [];
    for (const value of list) {
      if ((value.task != null && commentReferenceId(value.task) !== taskId) ||
          (value.project != null && commentReferenceId(value.project) !== projectId)) {
        const message = '评论的项目或任务 ID 与请求不一致';
        if (!commentFailure.includes(message)) commentFailure += `${commentFailure ? '；' : ''}评论读取失败：${message}`;
      } else validComments.push(value);
    }
    validComments.sort(commentCompare);
    const allAnnotations = Array.isArray(detail.annotations) ? detail.annotations.filter(value => value && typeof value === 'object') : [];
    const annotations = allAnnotations.filter(value => !commentBoolean(value.was_cancelled) && !commentBoolean(value.is_draft));
    const annotation = commentLatest(annotations, true);
    const reviewer = commentLatest(Array.isArray(detail.reviews) ? detail.reviews : []);
    const annotatorName = commentUserName(annotation?.completed_by, users, annotation?.created_username);
    const reviewerName = commentUserName(reviewer?.created_by, users, reviewer?.created_username);
    const feedback = detail.feedback;
    const reviewText = commentText(reviewer?.comment || (feedback && typeof feedback === 'object' ? feedback.text ?? feedback.comment : feedback));
    const file = commentFileName(detail, currentOrigin) || commentFileName(raw, currentOrigin);
    const shared = { 项目ID: projectId, 任务ID: taskId, 文件名称: file, 任务页面链接: pageUrl, 标注员: annotatorName, 标注员ID: commentReferenceId(annotation?.completed_by), 审核员: reviewerName };
    const taskComments = validComments.map(value => {
      const linked = value.annotation == null ? annotation : allAnnotations.find(item => commentReferenceId(item.id) === commentReferenceId(value.annotation));
      return {
      ...shared,
      标注员: commentUserName(linked?.completed_by, users, linked?.created_username),
      标注员ID: commentReferenceId(linked?.completed_by),
      评论ID: value.id ?? '',
      评论文字: commentText(value.text),
      评论图片: commentImages(value.images, currentOrigin),
      评论人: commentUserName(value.created_by, users, value.created_username),
      评论时间: commentText(value.created_at),
      修改时间: commentText(value.updated_at),
      是否已解决: commentBoolean(value.is_resolved) ? '是' : '否',
      标注ID: value.annotation && typeof value.annotation === 'object' ? value.annotation.id ?? commentText(value.annotation) : value.annotation ?? '',
      };
    });
    const summary = {
      ...shared,
      最新审核评论: reviewText,
      任务状态: commentText(detail.state ?? raw.state),
      最新评论文字: commentText(validComments.at(-1)?.text),
      全部评论文字: validComments.map(value => commentText(value.text)).join('\n\n'),
      评论条数: commentFailure ? null : validComments.length,
      评论读取状态: commentFailure ? `${commentFailure}${validComments.length ? `；已保留 ${validComments.length} 条部分评论` : ''}` : '成功',
      详情读取状态: detailFailure || '成功',
    };
    const failure = detailFailure || commentFailure ? { 项目ID: projectId, 任务ID: taskId, 说明: [detailFailure, commentFailure].filter(Boolean).join('；') } : null;
    return { summary, comments: taskComments, failure };
  }

  for (const projectId of projects) {
    commentCheckAbort(signal);
    progress('tasks', projectId, 0, 0, `正在读取项目 ${projectId} 的全部任务`);
    let tasks = [];
    try {
      tasks = await fetchPagedRows(`${currentOrigin}/api/tasks/?project=${encodeURIComponent(projectId)}&page_size=200`, {
        requestJSON, origin: currentOrigin, signal, kind: '任务',
        onPage: page => progress('tasks', projectId, page.count, page.total ?? page.count, `项目 ${projectId}：已读取 ${page.count} 个任务`),
      });
    } catch (error) {
      commentCheckAbort(signal, error);
      tasks = error.partialRows || [];
      failures.push({ 项目ID: projectId, 任务ID: '', 说明: `任务列表读取失败：${commentMessage(error)}` });
    }
    const validTasks = [];
    for (const task of tasks) {
      const id = commentPositiveId(task.id);
      const listedProject = task.project_id ?? task.project;
      if (!id || commentReferenceId(listedProject) !== projectId || (task.project != null && commentReferenceId(task.project) !== projectId)) {
        failures.push({ 项目ID: projectId, 任务ID: commentText(task.id), 说明: !id ? '任务列表包含无效的任务 ID，必须是正整数' : '任务列表的项目 ID 与请求不一致' });
      } else validTasks.push(task);
    }
    let cursor = 0, done = 0;
    const result = new Array(validTasks.length);
    async function worker() {
      while (cursor < validTasks.length) {
        commentCheckAbort(signal);
        const index = cursor++;
        const item = await readTask(validTasks[index], projectId);
        commentCheckAbort(signal);
        result[index] = item;
        done++;
        commentCount += item.comments.length;
        progress('task', projectId, done, validTasks.length, `项目 ${projectId}：已读取 ${done} / ${validTasks.length} 个任务，已收集 ${commentCount} 条评论`);
      }
    }
    await Promise.all(Array.from({ length: Math.min(workers, validTasks.length) }, () => worker()));
    commentCheckAbort(signal);
    for (const item of result) {
      summaries.push(item.summary);
      comments.push(...item.comments);
      if (item.failure) failures.push(item.failure);
    }
    progress('project', projectId, done, validTasks.length, `项目 ${projectId} 读取结束：${done} 个任务`);
  }
  comments.sort((a, b) => commentTime(a.评论时间) - commentTime(b.评论时间) || commentCompareId(a.评论ID, b.评论ID) || projects.indexOf(a.项目ID) - projects.indexOf(b.项目ID) || commentCompareId(a.任务ID, b.任务ID));
  const complete = failures.length === 0;
  progress('complete', '', summaries.length, summaries.length, complete ? '全部项目评论读取完成' : '读取结束，存在未完整读取的数据');
  return { projects, summaries, comments, failures, warnings, complete };
}

const COMMENT_GROUP_HEADERS = ['项目ID', '项目名称', '标注员', '涉及任务数', '已读评论数', '内容分段', '合并评论', '任务链接', '读取状态', '标注员ID'];
const COMMENT_DETAIL_HEADERS = ['项目ID', '任务ID', '文件名称', '任务页面链接', '标注员', '审核员', '评论ID', '评论文字', '评论人', '评论时间', '修改时间', '是否已解决', '标注ID', '评论图片', '标注员ID'];
const COMMENT_TASK_HEADERS = ['项目ID', '任务ID', '文件名称', '任务页面链接', '标注员', '审核员', '最新审核评论', '任务状态', '最新评论文字', '全部评论文字', '评论条数', '评论读取状态', '详情读取状态', '标注员ID'];

function groupText(value) { return String(value ?? ''); }
function groupName(row) { return groupText(row.标注员).replace(/\s+/g, ' ').trim(); }
function groupAccountId(row) {
  const value = groupText(row.标注员ID || (/^[1-9]\d*$/.test(groupName(row)) ? groupName(row) : ''));
  return /^[1-9]\d*$/.test(value) ? value : '';
}
function groupPerson(row, aliases = new Map()) {
  const name = groupName(row);
  const matches = aliases.get(JSON.stringify([groupText(row.项目ID), name]));
  const id = groupAccountId(row) || (matches?.size === 1 ? [...matches][0] : '');
  if (id) return { name: !name || name === '未识别人员' || /^[1-9]\d*$/.test(name) ? `用户ID ${id}` : name, id, key: `id:${id}`, unknown: false };
  if (!name || name === '未识别人员') return { name: `未识别人员（任务 ${row.任务ID}）`, id: '', key: `unknown:${row.任务ID}`, unknown: true };
  if (matches?.size > 1) return { name: `${name}（任务 ${row.任务ID}，ID待核对）`, id: '', key: `ambiguous:${row.任务ID}:${name}`, unknown: true };
  return { name, id: '', key: `name:${name}`, unknown: false };
}
function groupTime(row) { return Date.parse(row.评论时间 || '') || 0; }
function compareComments(a, b) {
  return groupTime(a) - groupTime(b) || groupText(a.评论ID).localeCompare(groupText(b.评论ID), 'en', { numeric: true }) || groupText(a.任务ID).localeCompare(groupText(b.任务ID), 'en', { numeric: true });
}
function taskProblem(row) {
  return ['评论读取状态', '详情读取状态'].some(key => row[key] && row[key] !== '成功');
}
function commentBlock(row) {
  return [
    `任务 ${row.任务ID} · 评论 ${row.评论ID}`,
    row.文件名称 && `文件：${row.文件名称}`,
    row.评论时间 && `时间：${row.评论时间}`,
    row.评论人 && `评论人：${row.评论人}`,
    row.是否已解决 && `已解决：${row.是否已解决}`,
    row.评论文字 || (row.评论图片 ? '（图片评论）' : '（无文字）'),
    row.评论图片 && `图片：${row.评论图片}`,
  ].filter(Boolean).join('\n');
}

function groupProjectComments(output, projectRows = []) {
  const names = new Map(projectRows.map(row => [groupText(row.project_id), groupText(row.project_name)]));
  const groups = new Map();
  const aliases = new Map();
  for (const row of [...output.summaries, ...output.comments]) {
    const id = groupAccountId(row), name = groupName(row);
    if (!id || !name || name === '未识别人员') continue;
    const key = JSON.stringify([groupText(row.项目ID), name]);
    if (!aliases.has(key)) aliases.set(key, new Set());
    aliases.get(key).add(id);
  }
  const summaries = new Map(output.summaries.map(row => [JSON.stringify([groupText(row.项目ID), groupText(row.任务ID)]), row]));
  function ensure(row) {
    const person = groupPerson(row, aliases);
    const key = JSON.stringify([groupText(row.项目ID), person.key]);
    if (!groups.has(key)) {
      groups.set(key, { project_id: groupText(row.项目ID), project_name: names.get(groupText(row.项目ID)) || '', annotator: person.name, annotator_id: person.id, tasks: new Set(), urls: new Set(), comments: [], incomplete: person.unknown });
    }
    const group = groups.get(key);
    if (/^用户ID \d+$/.test(group.annotator) && !/^用户ID \d+$/.test(person.name)) group.annotator = person.name;
    group.tasks.add(groupText(row.任务ID));
    if (row.任务页面链接) group.urls.add(groupText(row.任务页面链接));
    const summary = summaries.get(JSON.stringify([groupText(row.项目ID), groupText(row.任务ID)]));
    if (summary && taskProblem(summary)) group.incomplete = true;
    return group;
  }
  for (const row of output.summaries) ensure(row);
  for (const row of output.comments) ensure(row).comments.push(row);
  const displayCounts = new Map();
  for (const group of groups.values()) {
    const key = JSON.stringify([group.project_id, group.annotator]);
    displayCounts.set(key, (displayCounts.get(key) || 0) + 1);
  }
  const projectOrder = new Map(output.projects.map((value, index) => [groupText(value), index]));
  return [...groups.values()].map(group => ({
    project_id: group.project_id, project_name: group.project_name, annotator_id: group.annotator_id,
    annotator: displayCounts.get(JSON.stringify([group.project_id, group.annotator])) > 1 && group.annotator_id ? `${group.annotator}（ID ${group.annotator_id}）` : group.annotator,
    task_count: group.tasks.size, comment_count: group.comments.length,
    merged_comments: [...group.comments].sort(compareComments).map(commentBlock).join('\n\n'),
    task_urls: [...group.urls].join('\n'), status: group.incomplete ? '待核对（姓名或读取不完整）' : '已读取',
  })).sort((a, b) => (projectOrder.get(a.project_id) ?? Infinity) - (projectOrder.get(b.project_id) ?? Infinity) || a.annotator.localeCompare(b.annotator, 'zh-CN'));
}

// Excel limits a cell to 32,767 characters. Keep room for labels and never split a surrogate pair.
function commentCellParts(value) {
  if (typeof value !== 'string') return [value];
  const parts = [];
  for (let start = 0; start < value.length;) {
    let end = Math.min(start + 30000, value.length);
    if (end < value.length && /[\ud800-\udbff]/.test(value[end - 1])) end--;
    parts.push(value.slice(start, end));
    start = end;
  }
  return parts.length ? parts : [''];
}

function commentGroupTable(groups) {
  const rows = [];
  for (const group of groups) {
    const content = commentCellParts(group.merged_comments), urls = commentCellParts(group.task_urls);
    const total = Math.max(content.length, urls.length);
    for (let index = 0; index < total; index++) rows.push([
      group.project_id, group.project_name, group.annotator, index ? null : group.task_count, index ? null : group.comment_count,
      `${index + 1}/${total}`, content[index] || '', urls[index] || '', group.status, group.annotator_id || '',
    ]);
  }
  return { headers: COMMENT_GROUP_HEADERS.slice(), rows };
}

function detailRows(records, headers) {
  return records.flatMap(record => {
    const parts = headers.map(key => commentCellParts(record[key] ?? ''));
    const count = Math.max(...parts.map(value => value.length));
    return Array.from({ length: count }, (_, index) => parts.map(value => value.length > 1 ? value[index] ?? '' : value[0]));
  });
}

function commentProjectSheets(output, projectRows = []) {
  const groups = groupProjectComments(output, projectRows);
  const sheets = [];
  for (const project of output.projects) {
    const id = groupText(project);
    sheets.push({ name: `项目${id}_标注员汇总`, ...commentGroupTable(groups.filter(row => row.project_id === id)), widths: [12, 26, 20, 14, 14, 12, 90, 65, 30, 14] });
    const comments = output.comments.filter(row => groupText(row.项目ID) === id).sort((a, b) => groupPerson(a).name.localeCompare(groupPerson(b).name, 'zh-CN') || compareComments(a, b));
    sheets.push({ name: `项目${id}_评论明细`, headers: COMMENT_DETAIL_HEADERS.slice(), rows: detailRows(comments, COMMENT_DETAIL_HEADERS), widths: [12, 14, 28, 62, 18, 18, 14, 70, 18, 26, 26, 12, 14, 65, 14] });
  }
  sheets.push({ name: '任务汇总', headers: COMMENT_TASK_HEADERS.slice(), rows: detailRows(output.summaries, COMMENT_TASK_HEADERS) });
  const notes = [
    ['导出口径', '', '各项目分别建表，优先按标注员账号ID合并；无ID时按姓名匹配，重名无法确认及未知标注员按任务分开保留。评论为全部时间，不使用历史审核日期筛选。'],
    ['长内容', '', '长于单元格容量的内容分行保留；标注员汇总的任务数和评论数只在首段显示。'],
    ...output.failures.map(row => [row.项目ID || '', row.任务ID || '', row.说明 || '读取失败']),
    ...output.warnings.map(row => ['', '', typeof row === 'string' ? row : row.message || row.说明 || '用户姓名读取不完整']),
    ...groups.filter(row => row.status !== '已读取').map(row => [row.project_id, '', `${row.annotator}：${row.status}`]),
  ];
  sheets.push({ name: '读取状态', headers: ['项目ID', '任务ID', '说明'], rows: detailRows(notes.map(row => ({ 项目ID: row[0], 任务ID: row[1], 说明: row[2] })), ['项目ID', '任务ID', '说明']), widths: [16, 16, 90] });
  return sheets;
}

return {parseProjectIds, fetchPagedRows, collectCommentProjects, groupProjectComments, commentGroupTable, commentProjectSheets};
})();
(function () {
  'use strict';
  if (window.top !== window.self || document.getElementById('i360-region-pass-host')) return;
  const host = document.createElement('div');
  host.id = 'i360-region-pass-host';
  document.body.append(host);
  const root = host.attachShadow({ mode: 'open' });
  const css = document.createElement('style');
  css.textContent = `
    :host{all:initial;font:14px/1.55 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;color:#1c2c3b}
    *{box-sizing:border-box}[hidden]{display:none!important}button,input,textarea{font:inherit}button{cursor:pointer}
    button{border:1px solid #ced8df;background:#fff;color:#244354;border-radius:8px;padding:8px 13px}button:hover{background:#edf5f5}
    button:disabled{opacity:.45;cursor:default}.primary{background:#2864e8;color:#fff;border-color:#2864e8}.primary:hover{background:#1f54cb}
    #launcher{position:fixed;right:22px;bottom:156px;z-index:2147483600;box-shadow:0 3px 16px #16362e33;border-color:#2864e8;color:#2864e8;font-weight:600}
    #backdrop{position:fixed;inset:0;background:#13293466;z-index:2147483601;display:grid;place-items:center;padding:20px}
    #panel{width:min(1160px,96vw);height:min(900px,94vh);background:#f7fafb;border-radius:16px;box-shadow:0 18px 90px #0d273644;display:flex;flex-direction:column;overflow:hidden}
    header{padding:20px 24px 14px;display:flex;align-items:flex-start;gap:16px;background:#fff;border-bottom:1px solid #dfe8eb}h1{font-size:20px;line-height:1.4;margin:0 0 4px;font-weight:650}header p{margin:0;color:#61727e;font-size:13px}#close{margin-left:auto;padding:4px 12px;font-size:20px}
    main{padding:18px 24px 24px;overflow:auto;flex:1}label{display:block;font-weight:600;margin-bottom:7px}.hint{font-size:12px;color:#647783;margin:7px 0}
    textarea{display:block;width:100%;height:70px;resize:vertical;min-height:55px;border:1px solid #c7d5dc;border-radius:9px;padding:10px;background:#fff;color:#223947}
    textarea:focus,input:focus,button:focus-visible,summary:focus-visible{outline:2px solid #6a93ed;outline-offset:2px}.toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:9px;margin:12px 0}.date{display:inline-flex;align-items:center;gap:7px;font-size:13px;font-weight:400;margin:0}.date input{border:1px solid #c7d5dc;border-radius:7px;padding:7px 9px;background:#fff;color:#223947}
    #status{white-space:pre-line;color:#4c6574;min-height:24px;font-size:13px}progress{width:100%;height:7px;accent-color:#2864e8;display:block;margin:5px 0 14px}
    .projectbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:12px 0 8px}.projectbar strong{margin-right:auto}.projectbar button{padding:5px 9px;font-size:12px}
    #projects{border:1px solid #d8e2e6;border-radius:10px;background:#fff;max-height:240px;overflow:auto}.project{display:flex;align-items:center;gap:9px;padding:10px 13px;border-bottom:1px solid #edf1f3}.project:last-child{border-bottom:0}.project:hover{background:#f6f9ff}.project input{accent-color:#2864e8}.project-title{font-weight:600;min-width:0;overflow-wrap:anywhere}.project-id{color:#7b8b95;font-size:12px;margin-left:auto;font-variant-numeric:tabular-nums}
    #metrics{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;margin:15px 0}.metric{border:1px solid #dce6e9;border-radius:10px;background:#fff;padding:12px 14px}.metric span{display:block;color:#6c7e89;font-size:12px}.metric strong{display:block;font-size:23px;margin-top:4px;font-variant-numeric:tabular-nums;color:#164a43}
    .resultbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:16px 0 10px}.resultbar strong{margin-right:auto}.tablewrap{border:1px solid #d8e2e6;border-radius:10px;overflow:auto;background:#fff;max-height:340px}table{border-collapse:collapse;width:100%;font-size:13px}th{position:sticky;top:0;background:#edf4f4;font-weight:600;color:#435e68}th,td{text-align:left;padding:9px 12px;border-bottom:1px solid #e6edef;white-space:nowrap}tbody tr:last-child td{border-bottom:0}td:not(:first-child){font-variant-numeric:tabular-nums}
    .warning{background:#fff5e5;color:#8b5716;border:1px solid #f0d7a8;border-radius:8px;padding:10px 12px;margin:12px 0;font-size:13px}details{font-size:13px;margin-top:12px}summary{cursor:pointer;color:#3d6677}.detailsbody{margin-top:8px;max-height:200px;overflow:auto;white-space:pre-wrap;word-break:break-word}
    #rules{color:#657b87;font-size:12px;border-top:1px solid #dce6e9;padding-top:12px;margin-top:17px}#rules p{margin:4px 0}
    @media(max-width:750px){main{padding:14px}header{padding:16px}#backdrop{padding:8px}#metrics{grid-template-columns:repeat(2,1fr)}.project-id{margin-left:0}.date{width:100%}}
  `;
  root.append(css);
  const layout = document.createElement('div');
  layout.innerHTML = `
    <button id="launcher" type="button">通过率 / 评论导出</button>
    <div id="backdrop" hidden><section id="panel" role="dialog" aria-modal="true" aria-labelledby="title">
      <header><div><h1 id="title">项目通过率与全部评论</h1><p>通过率按历史记录统计 · 评论按项目和标注员合并导出</p></div><button id="close" type="button" aria-label="收起统计面板">×</button></header>
      <main>
        <label for="projectIds">1. 选择项目包</label>
        <textarea id="projectIds" spellcheck="false" placeholder="留空将读取当前页面显示的项目卡片；也可手动输入多个项目 ID，用空格、换行或逗号分隔"></textarea>
        <div class="toolbar"><button id="loadProjects" type="button">读取当前页面项目</button><button id="selectAll" type="button">全选项目</button><button id="clearAll" type="button">清除选择</button><span id="selectedCount" class="hint">已选 0 个项目</span></div>
        <div class="projectbar"><strong>项目列表</strong><span id="projectHint" class="hint">留空后读取当前页面项目包</span></div>
        <div id="projects" aria-live="polite"></div>
        <div class="toolbar"><label class="date">历史开始日期 <input id="startDate" type="date"></label><label class="date">历史结束日期 <input id="endDate" type="date"></label><button id="start" class="primary" type="button" disabled>统计选中项目</button><button id="commentStart" type="button" disabled>读取全部评论</button><button id="cancel" type="button" disabled>停止</button></div>
        <p id="commentHint" class="hint">评论读取所选项目的全部时间，不受上方日期限制；同一项目内按标注员合并，不同项目分表。可直接读取评论，无须先统计通过率。</p>
        <div id="status" role="status" aria-live="polite">先读取当前页面项目，勾选后统计通过率或读取评论。</div><progress id="progress" max="1" value="0" hidden></progress>
        <section id="results" hidden>
          <div id="metrics"></div><div id="warning" class="warning" hidden></div>
          <div class="resultbar"><strong>2. 标注员汇总</strong><button id="copy" type="button">复制汇总表</button><button id="csv" type="button">导出汇总 CSV</button><button id="excel" class="primary" type="button">导出完整 Excel</button></div>
          <div class="tablewrap"><table><thead><tr><th>标注员</th><th>通过次数</th><th>驳回次数</th><th>审核次数</th><th>通过率</th><th>状态</th></tr></thead><tbody id="body"></tbody></table></div>
          <details id="notes"><summary>历史记录与待核对说明</summary><div class="detailsbody" id="details"></div></details>
        </section>
        <section id="commentResults" hidden>
          <div class="resultbar"><strong>评论 · 按项目与标注员汇总</strong><button id="commentCsv" type="button">导出合并评论 CSV</button><button id="commentExcel" class="primary" type="button">导出评论 Excel</button></div>
          <p id="commentSummary" class="hint"></p><div id="commentWarning" class="warning" hidden></div>
          <div class="tablewrap"><table><thead><tr><th>项目</th><th>标注员</th><th>涉及任务数</th><th>已读评论数</th><th>状态</th></tr></thead><tbody id="commentBody"></tbody></table></div>
          <details><summary>评论读取说明</summary><div id="commentDetails" class="detailsbody"></div></details>
        </section>
        <div id="rules"><p>通过率 = 历史通过次数 ÷（历史通过次数 + 历史驳回次数）。每一条审核记录分别统计，同一任务多次审核不会去重。</p><p>日期按历史记录时间筛选，包含首尾日期。无法识别的历史状态不计入通过率，保留在明细说明中。</p><p>评论 Excel 每个项目各有标注员汇总、逐条评论明细，另附任务汇总和读取状态；已解决及图片评论也保留。优先按标注员账号 ID 合并，归属不明的按任务分开标记待核对。</p><p>两项读取均完成后，“导出完整 Excel”同时包含通过率和评论。长评论分行保留。</p></div>
      </main>
    </section></div>`;
  root.append(layout);
  const $ = id => root.getElementById(id);
  let result = null, commentResult = null, commentGroups = [], controller = null, working = false, lastFocus = null, copyTimer = 0, projectRows = [];
  const percent = value => typeof value === 'number' ? `${(value * 100).toFixed(2)}%` : '待核对';
  const cellValue = value => value === null || value === undefined ? '待核对' : String(value);
  const today = new Date();
  const isoDate = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  $('startDate').value = isoDate(monthStart); $('endDate').value = isoDate(today);
  function show() { lastFocus = document.activeElement; $('backdrop').hidden = false; $('projectIds').focus(); }
  function hide() { $('backdrop').hidden = true; (lastFocus?.isConnected ? lastFocus : $('launcher')).focus(); }
  function requestJSON(url, { signal } = {}) {
    return fetch(url, { method: 'GET', credentials: 'same-origin', headers: { Accept: 'application/json' }, cache: 'no-store', signal }).then(async response => {
      if (!response.ok) throw new Error(`HTTP ${response.status}：读取失败`);
      const type = response.headers.get('content-type');
      if (type && !/\bjson\b/i.test(type)) throw new Error('接口返回的不是 JSON，请确认登录状态');
      return response.json();
    });
  }
  function selectedIds() { return [...$('projects').querySelectorAll('input[type="checkbox"]:checked')].map(input => input.value); }
  function updateSelection() {
    const ids = selectedIds(); $('selectedCount').textContent = `已选 ${ids.length} 个项目`;
    $('start').disabled = $('commentStart').disabled = !ids.length || working;
  }
  function renderProjects() {
    $('projects').replaceChildren();
    for (const project of projectRows) {
      const label = document.createElement('label'); label.className = 'project';
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.value = project.project_id; checkbox.checked = true;
      const title = document.createElement('span'); title.className = 'project-title'; title.textContent = project.project_name || `项目 ${project.project_id}`;
      const id = document.createElement('span'); id.className = 'project-id'; id.textContent = `ID ${project.project_id}`;
      label.append(checkbox, title, id); $('projects').append(label);
      checkbox.addEventListener('change', () => { invalidate(); updateSelection(); });
    }
    $('projectHint').textContent = projectRows.length ? `共 ${projectRows.length} 个项目` : '没有找到项目';
    updateSelection();
  }
  $('launcher').addEventListener('click', show); $('close').addEventListener('click', hide); $('backdrop').addEventListener('click', event => { if (event.target === $('backdrop')) hide(); });
  for (const type of ['keydown', 'keyup', 'keypress']) host.addEventListener(type, event => event.stopPropagation());
  root.addEventListener('keydown', event => {
    if ($('backdrop').hidden) return;
    if (event.key === 'Escape') { event.preventDefault(); hide(); }
  });
  function invalidateHistory() { result = null; $('results').hidden = true; }
  function invalidateComments() { commentResult = null; commentGroups = []; $('commentResults').hidden = true; }
  function invalidate() { invalidateHistory(); invalidateComments(); if (!working) $('status').textContent = '项目已更新，请重新读取。'; }
  $('projectIds').addEventListener('input', () => { invalidate(); projectRows = []; renderProjects(); });
  for (const id of ['startDate', 'endDate']) $(id).addEventListener('change', () => { invalidateHistory(); if (!working) $('status').textContent = '历史日期已更新，请重新统计通过率；已读取评论仍为全部时间。'; });
  function busy(value) {
    working = value;
    for (const id of ['projectIds', 'loadProjects', 'selectAll', 'clearAll', 'startDate', 'endDate']) $(id).disabled = value;
    for (const input of $('projects').querySelectorAll('input')) input.disabled = value;
    $('cancel').disabled = !controller; $('progress').hidden = !value; updateSelection();
  }
  $('loadProjects').addEventListener('click', async () => {
    if (working) return;
    invalidate();
    const input = $('projectIds').value.trim();
    busy(true); $('status').textContent = input ? '正在读取项目…' : '正在读取当前页面项目…';
    try {
      if (!input) {
        projectRows = Core.extractCurrentProjectCards(document, location.href);
        if (!projectRows.length) throw new Error('当前页面未找到项目包，请输入项目 ID。');
        $('projectIds').value = projectRows.map(project => project.project_id).join(',');
        renderProjects();
        $('status').textContent = `已读取当前页面 ${projectRows.length} 个项目，请勾选后统计。`;
      } else {
        const ids = Core.parseProjectIds(input);
        $('status').textContent = `正在读取 ${ids.length} 个项目…`;
        const rows = await Core.fetchHistoryPaged(`${location.origin}/api/projects/?ids=${ids.join(',')}&page_size=100`, { requestJSON, origin: location.origin, kind: '项目' });
        const map = new Map(rows.map(row => [String(row.id), { project_id: String(row.id), project_name: String(row.title ?? row.name ?? '') }]));
        projectRows = ids.map(id => map.get(id) || { project_id: id, project_name: '' }); renderProjects();
        $('status').textContent = `已读取 ${projectRows.length} 个项目，请勾选后统计。`;
      }
    } catch (error) { projectRows = []; renderProjects(); $('status').textContent = `项目读取失败：${error.message}`; }
    finally { busy(false); }
  });
  $('selectAll').addEventListener('click', () => { for (const input of $('projects').querySelectorAll('input[type="checkbox"]')) input.checked = true; invalidate(); updateSelection(); });
  $('clearAll').addEventListener('click', () => { for (const input of $('projects').querySelectorAll('input[type="checkbox"]')) input.checked = false; invalidate(); updateSelection(); });
  $('cancel').addEventListener('click', () => controller?.abort());
  $('start').addEventListener('click', async () => {
    if (working) return;
    const ids = selectedIds();
    if (!ids.length) { $('status').textContent = '请先读取并勾选至少一个项目。'; return; }
    if ($('startDate').value && $('endDate').value && $('startDate').value > $('endDate').value) { $('status').textContent = '开始日期不能晚于结束日期。'; return; }
    invalidateHistory(); controller = new AbortController(); const signal = controller.signal; busy(true); $('progress').hidden = false; $('progress').removeAttribute('value');
    $('status').textContent = `正在读取 ${ids.length} 个项目的任务历史…`;
    try {
      result = await Core.collectProjectHistory(ids, { requestJSON, origin: location.origin, signal, start: $('startDate').value, end: $('endDate').value, onProgress: info => { if (info.phase === 'history') $('status').textContent = `项目 ${info.projectId}：已读取 ${info.done} / ${info.total} 个任务，发现 ${info.count || 0} 条审核记录…`; else if (info.phase === 'tasks') $('status').textContent = `项目 ${info.projectId}：正在读取任务列表…`; } });
      render(); $('status').textContent = result.complete ? `统计完成：${result.rows.length} 条历史审核记录。` : `读取结束：有 ${result.failures.length} 条待核对记录。`;
    } catch (error) { invalidateHistory(); $('status').textContent = signal.aborted ? '已停止，本次没有生成统计结果。' : `统计失败：${error.message}`; }
    finally { controller = null; busy(false); }
  });
  $('commentStart').addEventListener('click', async () => {
    if (working) return;
    const ids = selectedIds();
    if (!ids.length) { $('status').textContent = '请先读取并勾选至少一个项目。'; return; }
    invalidateComments(); controller = new AbortController(); const signal = controller.signal; busy(true); $('progress').removeAttribute('value');
    $('status').textContent = `正在读取 ${ids.length} 个项目的全部评论…`;
    try {
      commentResult = await Comments.collectCommentProjects(ids, { requestJSON, origin: location.origin, signal, onProgress: info => {
        $('status').textContent = info.message;
        if (info.phase === 'task' && info.total) { $('progress').max = info.total; $('progress').value = info.done; }
        else if (info.phase !== 'complete') $('progress').removeAttribute('value');
      } });
      commentGroups = Comments.groupProjectComments(commentResult, projectRows);
      renderComments();
      $('status').textContent = `${commentResult.complete ? '评论读取完成' : '评论读取结束（部分待核对）'}：${commentResult.projects.length} 个项目，${commentResult.comments.length} 条评论，${commentGroups.length} 组标注员。`;
    } catch (error) {
      invalidateComments(); $('status').textContent = signal.aborted ? '已停止，本次没有生成评论结果。' : `评论读取失败：${error.message}`;
    } finally { controller = null; busy(false); }
  });
  function commentsNeedReview() { return !commentResult.complete || !!commentResult.warnings.length || commentGroups.some(row => row.status !== '已读取'); }
  function renderComments() {
    $('commentResults').hidden = false; $('commentBody').replaceChildren();
    $('commentSummary').textContent = `${commentResult.projects.length} 个项目 · ${commentResult.summaries.length} 个任务 · ${commentGroups.length} 组标注员 · ${commentResult.comments.length} 条评论（全部时间）。${commentGroups.length > 200 ? '页面显示前 200 组，导出包含全部。' : ''}`;
    for (const person of commentGroups.slice(0, 200)) {
      const tr = document.createElement('tr');
      for (const value of [`${person.project_name || '项目'}（${person.project_id}）`, person.annotator, person.task_count, person.comment_count, person.status]) {
        const td = document.createElement('td'); td.textContent = String(value); tr.append(td);
      }
      $('commentBody').append(tr);
    }
    $('commentWarning').hidden = !commentsNeedReview();
    $('commentWarning').textContent = '部分读取或姓名归属待核对；评论数为已成功读取的数量。导出保留已读评论及失败原因。';
    const notes = [
      ...commentResult.failures.map(row => `项目 ${row.项目ID}${row.任务ID ? ` / 任务 ${row.任务ID}` : ''}：${row.说明}`),
      ...commentResult.warnings.map(row => typeof row === 'string' ? row : row.message || row.说明 || String(row)),
      ...commentGroups.filter(row => row.status !== '已读取').map(row => `项目 ${row.project_id} / ${row.annotator}：${row.status}`),
    ];
    $('commentDetails').textContent = notes.join('\n') || '所选项目的全部评论已读取；同项目同标注员合并，跨项目分别保留。';
  }
  function render() {
    $('results').hidden = false; $('metrics').replaceChildren(); $('body').replaceChildren();
    const metrics = [['选中项目', result.projects.length], ['历史通过', result.totals.pass_count], ['历史驳回', result.totals.reject_count], ['审核次数', result.totals.total_count], ['整体通过率', percent(result.totals.pass_rate)]];
    for (const [name, value] of metrics) { const box = document.createElement('div'); box.className = 'metric'; const label = document.createElement('span'), strong = document.createElement('strong'); label.textContent = name; strong.textContent = value; box.append(label, strong); $('metrics').append(box); }
    for (const person of result.people) { const tr = document.createElement('tr'); for (const value of [person.annotator, person.pass_count, person.reject_count, person.total_count, percent(person.pass_rate), '已核对']) { const td = document.createElement('td'); td.textContent = cellValue(value); tr.append(td); } $('body').append(tr); }
    $('warning').hidden = result.complete; $('warning').textContent = '部分项目或任务历史读取失败，结果只包含已成功读取的记录；失败原因见明细和 Excel。';
    const lines = [...result.failures.map(item => `[读取失败] 项目 ${item.project_id}${item.task_id ? ` / 任务 ${item.task_id}` : ''}：${item.message}`), ...result.issues.map(item => `[待核对] ${item.message || item}`)];
    $('details').textContent = lines.join('\n') || '所有历史审核记录均已读取并按日期筛选。'; $('notes').open = !result.complete || !!lines.length;
  }
  const summaryHeaders = ['标注员', '通过次数', '驳回次数', '审核次数', '通过率', '统计状态'];
  const summaryRows = formatted => result.people.map(person => [person.annotator, person.pass_count, person.reject_count, person.total_count, formatted ? percent(person.pass_rate) : person.pass_rate, '已核对']);
  function save(bytes, name, type) { const url = URL.createObjectURL(new Blob([bytes], { type })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; root.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000); }
  const dateStamp = () => new Date().toISOString().replace(/[-:]/g, '').slice(0, 15).replace('T', '_');
  $('copy').addEventListener('click', async () => { if (!result) return; const text = [summaryHeaders, ...summaryRows(true)].map(row => row.map(value => String(value ?? '').replace(/[\t\r\n]/g, ' ')).join('\t')).join('\n'); try { if (typeof GM_setClipboard === 'function') GM_setClipboard(text, 'text'); else await navigator.clipboard.writeText(text); $('copy').textContent = '已复制'; clearTimeout(copyTimer); copyTimer = setTimeout(() => { $('copy').textContent = '复制汇总表'; }, 1600); } catch { $('status').textContent = '复制失败，请导出 CSV 或 Excel。'; } });
  $('csv').addEventListener('click', () => { if (result) save(Core.toCSV(summaryHeaders, summaryRows(true)), `项目历史通过率_${dateStamp()}.csv`, 'text/csv;charset=utf-8'); });
  $('excel').addEventListener('click', () => {
    if (!result) return;
    const projectHeaders = ['项目ID', '项目名称', '通过次数', '驳回次数', '审核次数', '通过率'];
    const historyHeaders = ['项目ID', '项目名称', '任务ID', '标注员', '审核结果', '历史时间', '触发人', '原始状态', '任务链接'];
    const issueRows = [['统计口径', '', '', '', '', `通过率=历史通过次数÷（历史通过次数+历史驳回次数）；每次历史记录分别统计。`], ['时间范围', '', '', '', '', `${$('startDate').value || '不限'} 至 ${$('endDate').value || '不限'}（含首尾日期）`], ...result.failures.map(item => ['读取失败', item.project_id, item.task_id, '', '', item.message]), ...result.issues.map(item => ['待核对', '', '', '', '', item.message || String(item)])];
    const sheets = [
      { name: '标注员通过率', headers: summaryHeaders, rows: summaryRows(false), percentColumns: [4] },
      { name: '项目汇总', headers: projectHeaders, rows: result.projects.map(project => [project.project_id, project.project_name, project.pass_count, project.reject_count, project.total_count, project.pass_rate]), percentColumns: [5] },
      { name: '历史记录', headers: historyHeaders, rows: result.rows.map(row => [row.project_id, row.project_name, row.task_id, row.annotator, row.status, row.created_at || '', row.triggered_by?.first_name ? `${row.triggered_by.first_name}${row.triggered_by.last_name || ''}` : String(row.triggered_by ?? ''), row.state || row.previous_state || row.transition_name || '', row.task_url || '']) },
      { name: '待核对与口径', headers: ['类型', '项目ID', '任务ID', '标注员', '结果', '说明'], rows: issueRows },
    ];
    if (commentResult) sheets.push(...Comments.commentProjectSheets(commentResult, projectRows));
    try { save(Core.workbookBytes(sheets), `${commentResult ? '项目通过率与评论' : '项目历史通过率'}_${commentResult && commentsNeedReview() ? '待核对_' : ''}${dateStamp()}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); } catch (error) { $('status').textContent = `导出失败：${error.message}`; }
  });
  $('commentCsv').addEventListener('click', () => {
    if (!commentResult) return;
    const table = Comments.commentGroupTable(commentGroups);
    save(Core.toCSV(table.headers, table.rows), `项目标注员评论_${commentsNeedReview() ? '待核对_' : ''}${dateStamp()}.csv`, 'text/csv;charset=utf-8');
  });
  $('commentExcel').addEventListener('click', () => {
    if (!commentResult) return;
    try { save(Core.workbookBytes(Comments.commentProjectSheets(commentResult, projectRows)), `项目标注员评论_${commentsNeedReview() ? '待核对_' : ''}${dateStamp()}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); }
    catch (error) { $('status').textContent = `评论导出失败：${error.message}`; }
  });
})();

})();
