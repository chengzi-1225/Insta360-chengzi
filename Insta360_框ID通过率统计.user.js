// ==UserScript==
// @name         Insta360 框ID通过率统计
// @namespace    local.insta360.region-pass-rate
// @version      1.0.0
// @description  粘贴质检表，自动读取实际矩形框ID，按标注员去重汇总通过率，导出Excel明细。
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

return {taskIdentity, parseTable, calculate, toCSV, fetchTaskJSON, workbookBytes};
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
    *{box-sizing:border-box} [hidden]{display:none!important} button,input,textarea{font:inherit} button{cursor:pointer}
    button{border:1px solid #ced8df;background:#fff;color:#244354;border-radius:8px;padding:8px 13px} button:hover{background:#edf5f5}
    button:disabled{opacity:.45;cursor:default} .primary{background:#12675b;color:#fff;border-color:#12675b}.primary:hover{background:#0d544a}
    #launcher{position:fixed;right:22px;bottom:156px;z-index:2147483600;box-shadow:0 3px 16px #16362e33;border-color:#12675b;color:#12675b;font-weight:600}
    #backdrop{position:fixed;inset:0;background:#13293466;z-index:2147483601;display:grid;place-items:center;padding:20px}
    #panel{width:min(1120px,96vw);height:min(880px,92vh);background:#f7fafb;border-radius:16px;box-shadow:0 18px 90px #0d273644;display:flex;flex-direction:column;overflow:hidden}
    header{padding:20px 24px 14px;display:flex;align-items:flex-start;gap:16px;background:white;border-bottom:1px solid #dfe8eb}
    h1{font-size:20px;line-height:1.4;margin:0 0 4px;font-weight:650} header p{margin:0;color:#61727e;font-size:13px} #close{margin-left:auto;padding:4px 12px;font-size:20px}
    main{padding:18px 24px 24px;overflow:auto;flex:1} label{display:block;font-weight:600;margin-bottom:7px}.hint{font-size:12px;color:#647783;margin:7px 0}
    textarea{display:block;width:100%;height:140px;resize:vertical;min-height:85px;border:1px solid #c7d5dc;border-radius:9px;padding:11px;background:#fff;color:#223947}
    textarea:focus,button:focus-visible,select:focus-visible{outline:2px solid #46a496;outline-offset:2px} .toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:9px;margin:12px 0}
    #file{display:none}.option{display:inline-flex;gap:6px;align-items:center;font-weight:400;margin:0 0 0 auto;font-size:13px}.option input{accent-color:#12675b}
    #status{white-space:pre-line;color:#4c6574;min-height:24px;font-size:13px} progress{width:100%;height:7px;accent-color:#12675b;display:block;margin:5px 0 14px}
    #metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:15px 0}.metric{border:1px solid #dce6e9;border-radius:10px;background:#fff;padding:12px 16px}
    .metric span{display:block;color:#6c7e89;font-size:12px}.metric strong{display:block;font-size:25px;margin-top:4px;font-variant-numeric:tabular-nums;color:#164a43}
    .resultbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:16px 0 10px}.resultbar strong{margin-right:auto}
    .tablewrap{border:1px solid #d8e2e6;border-radius:10px;overflow:auto;background:#fff;max-height:350px}table{border-collapse:collapse;width:100%;font-size:13px}
    th{position:sticky;top:0;background:#edf4f4;font-weight:600;color:#435e68}th,td{text-align:left;padding:10px 14px;border-bottom:1px solid #e6edef;white-space:nowrap}tbody tr:last-child td{border-bottom:0}
    td:not(:first-child){font-variant-numeric:tabular-nums} .muted{color:#778b97}.warning{background:#fff5e5;color:#8b5716;border:1px solid #f0d7a8;border-radius:8px;padding:10px 12px;margin:12px 0;font-size:13px}
    details{font-size:13px;margin-top:12px} summary{cursor:pointer;color:#3d6677}.detailsbody{margin-top:8px;max-height:180px;overflow:auto;white-space:pre-wrap;word-break:break-word}
    #rules{color:#657b87;font-size:12px;border-top:1px solid #dce6e9;padding-top:12px;margin-top:17px} #rules p{margin:4px 0}
    @media(max-width:650px){main{padding:14px}header{padding:16px}#backdrop{padding:8px}#metrics{grid-template-columns:repeat(2,1fr)}.option{margin-left:0}.metric strong{font-size:22px}}
  `;
  root.append(css);
  // All dynamic data is inserted as text; pasted links and comments are never interpreted as HTML.
  const layout = document.createElement('div');
  layout.innerHTML = `
    <button id="launcher" type="button">框 ID 通过率</button>
    <div id="backdrop" hidden><section id="panel" role="dialog" aria-modal="true" aria-labelledby="title">
      <header><div><h1 id="title">按框 ID 统计通过率</h1><p>同标注员合并 · 重复数据去重 · 合格数据与主体框计入总数</p></div><button id="close" type="button" aria-label="收起统计面板">×</button></header>
      <main>
        <label for="input">1. 粘贴完整质检表（包含合格、不合格记录）</label>
        <textarea id="input" spellcheck="false" placeholder="从表格复制整片数据后粘贴到这里。支持原来的 9 列顺序，也支持带表头的表格。"></textarea>
        <p class="hint">无表头列顺序：任务链接、质检员、标注员、合格/不合格、问题类型、问题描述、构图比例、图片文件名、附件。统计范围为本次粘贴或导入的任务。</p>
        <div class="toolbar"><button id="start" class="primary" type="button">读取框数并统计</button><button id="import" type="button">导入 CSV / TSV / TXT</button><input id="file" type="file" accept=".csv,.tsv,.txt,text/plain,text/csv"><button id="cancel" type="button" disabled>停止</button><label class="option"><input id="drafts" type="checkbox" checked>有草稿时使用最新已保存草稿</label></div>
        <div id="status" role="status" aria-live="polite">先登录标注平台，再粘贴质检数据。仅点击统计时读取任务。</div><progress id="progress" max="1" value="0" hidden></progress>
        <section id="results" hidden>
          <div id="metrics"></div><div id="warning" class="warning" hidden></div>
          <div class="resultbar"><strong>2. 标注员汇总</strong><button id="copy" type="button">复制汇总表</button><button id="csv" type="button">导出汇总 CSV</button><button id="excel" class="primary" type="button">导出完整 Excel</button></div>
          <div class="tablewrap"><table><thead><tr><th>标注员</th><th>任务数</th><th>总框 ID</th><th>错误 ID</th><th>通过 ID</th><th>通过率</th><th>状态</th></tr></thead><tbody id="body"></tbody></table></div>
          <details id="notes"><summary>匹配说明与待核对记录</summary><div class="detailsbody" id="details"></div></details>
        </section>
        <div id="rules"><p>通过率 = 1 − 错误框 ID 数 ÷ 总框 ID 数。相同项目、任务、框 ID 只计一次；同框多次报错只算一个错误 ID。</p><p>原框 ID 已更换时，仅在同任务该构图比例唯一时自动对应。无法读取或无法唯一对应的任务会标为“待核对”，受影响的通过率暂不显示。</p><p>完整 Excel 含标注员汇总、任务明细、框 ID 明细、质检记录和待核对记录。草稿选择与框 ID 对应方式会保留在明细中。</p></div>
      </main>
    </section></div>`;
  root.append(layout);
  const $ = id => root.getElementById(id);
  let result = null, controller = null, lastFocus = null, copyTimer = 0, importing = false;
  const percent = value => typeof value === 'number' ? `${(value * 100).toFixed(2)}%` : '待核对';
  const cellValue = value => value === null || value === undefined ? '待核对' : String(value);
  function show() { lastFocus = document.activeElement; $('backdrop').hidden = false; $('input').focus(); }
  function hide() { $('backdrop').hidden = true; (lastFocus?.isConnected ? lastFocus : $('launcher')).focus(); }
  $('launcher').addEventListener('click', show);
  $('close').addEventListener('click', hide);
  $('backdrop').addEventListener('click', event => { if (event.target === $('backdrop')) hide(); });
  // Keep the host page's annotation shortcuts from handling keys typed in this tool.
  for (const type of ['keydown', 'keyup', 'keypress']) host.addEventListener(type, event => event.stopPropagation());
  root.addEventListener('keydown', event => {
    if ($('backdrop').hidden) return;
    if (event.key === 'Escape') { event.preventDefault(); hide(); }
    if (event.key === 'Tab') {
      const focusable = [...$('panel').querySelectorAll('button,input,textarea,summary')].filter(el => !el.disabled && el.type !== 'file' && !el.closest('[hidden]') && (el.tagName === 'SUMMARY' || !el.closest('details:not([open])')));
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && root.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && root.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
  function invalidate() { result = null; $('results').hidden = true; if (!controller) $('status').textContent = '数据已更新，请重新读取框数并统计。'; }
  $('input').addEventListener('input', invalidate);
  $('drafts').addEventListener('change', invalidate);
  $('import').addEventListener('click', () => $('file').click());
  $('file').addEventListener('change', async () => {
    const file = $('file').files?.[0];
    if (!file) return;
    if (controller || importing) { $('file').value = ''; return; }
    importing = true; invalidate();
    for (const id of ['start', 'import', 'input', 'drafts']) $(id).disabled = true;
    $('status').textContent = `正在导入 ${file.name}…`;
    try {
      const bytes = await file.arrayBuffer();
      let text = new TextDecoder('utf-8').decode(bytes);
      if (text.includes('\uFFFD')) text = new TextDecoder('gb18030').decode(bytes);
      $('input').value = text; invalidate(); $('status').textContent = `已导入 ${file.name}，点击“读取框数并统计”。`;
    } catch (error) { $('status').textContent = `导入失败：${error.message}`; }
    finally { importing = false; busy(false); $('file').value = ''; }
  });
  function busy(value) {
    for (const id of ['input', 'drafts', 'start', 'import']) $(id).disabled = value;
    $('cancel').disabled = !value; $('progress').hidden = !value;
  }
  $('cancel').addEventListener('click', () => controller?.abort());
  $('start').addEventListener('click', async () => {
    if (controller || importing) return;
    invalidate();
    const parsed = Core.parseTable($('input').value, location.origin);
    if (parsed.issues.length || !parsed.rows.length) {
      $('status').textContent = parsed.issues.map(issue => `${issue.source_row ? `第 ${issue.source_row} 行：` : ''}${issue.message}`).join('\n') || '请先粘贴质检表。';
      return;
    }
    const groups = new Map();
    for (const row of parsed.rows) groups.set(`${row.project_id}/${row.task_id}`, row);
    controller = new AbortController(); const signal = controller.signal;
    busy(true); $('progress').max = groups.size; $('progress').value = 0;
    $('status').textContent = `${parsed.rows.length} 条质检记录，${groups.size} 个唯一任务，正在读取…`;
    const data = Object.create(null), entries = [...groups.entries()]; let cursor = 0, done = 0, failed = 0;
    try {
      await Promise.all(Array.from({ length: Math.min(3, entries.length) }, async () => {
        while (cursor < entries.length && !signal.aborted) {
          const [key, row] = entries[cursor++];
          try { data[key] = await Core.fetchTaskJSON(`${location.origin}/api/tasks/${row.task_id}/`, { signal }); }
          catch (error) {
            if (signal.aborted) throw error;
            data[key] = { error: error.message }; failed++;
          }
          done++; $('progress').value = done;
          $('status').textContent = `已读取 ${done} / ${entries.length} 个任务${failed ? `，${failed} 个读取失败（会列入待核对）` : ''}。`;
        }
      }));
      if (signal.aborted) throw new DOMException('已停止', 'AbortError');
      result = Core.calculate(parsed.rows, data, { useDrafts: $('drafts').checked });
      render();
      $('status').textContent = result.complete
        ? `统计完成：${parsed.rows.length} 条记录，${result.totals.tasks} 个任务；${result.tasks.filter(t => t.version === '最新草稿').length} 个任务使用最新已保存草稿。`
        : `读取结束：有 ${result.issues.length} 条待核对记录，请查看明细。`;
    } catch (error) {
      invalidate(); $('status').textContent = signal.aborted ? '已停止。本次没有生成统计结果；可以重新开始。' : `统计失败：${error.message}`;
    } finally { controller = null; busy(false); }
  });
  function render() {
    $('results').hidden = false; $('metrics').replaceChildren(); $('body').replaceChildren();
    const metrics = [['唯一任务', result.totals.tasks], [result.complete ? '总框 ID' : '已读取框 ID', result.totals.regions], [result.complete ? '错误 ID' : '已匹配错误 ID', result.totals.errors], ['整体通过率', percent(result.totals.pass_rate)]];
    for (const [name, value] of metrics) {
      const box = document.createElement('div'); box.className = 'metric';
      const label = document.createElement('span'), strong = document.createElement('strong'); label.textContent = name; strong.textContent = value; box.append(label, strong); $('metrics').append(box);
    }
    for (const p of result.people) {
      const tr = document.createElement('tr');
      for (const value of [p.annotator, p.task_count, p.region_count, p.error_count, p.pass_count, percent(p.pass_rate), p.pass_rate === null ? '待核对' : '已核对']) {
        const td = document.createElement('td'); td.textContent = cellValue(value); tr.append(td);
      }
      $('body').append(tr);
    }
    $('warning').hidden = result.complete;
    $('warning').textContent = '有任务读取失败或错误 ID 无法唯一对应。受影响标注员及整体通过率暂不显示，导出的表格会保留待核对原因。';
    const lines = result.issues.map(i => `[待核对] ${i.source_row ? `第${i.source_row}行 ` : ''}${i.task_id ? `任务${i.task_id} ` : ''}${i.message}`);
    for (const note of result.mappingNotes) lines.push(`[自动对应] 第${note.source_row}行 / 任务${note.task_id}：${note.original_region_id || '无原框ID'} → ${note.matched_region_id}（${note.match_method}）`);
    $('details').textContent = lines.join('\n') || '所有任务已读取，所有错误均已对应到具体框 ID。';
    $('notes').open = !result.complete;
  }
  function summaryRows(formatted = false) {
    return result.people.map(p => [p.annotator, p.task_count, p.region_count, p.error_count, p.pass_count, formatted ? percent(p.pass_rate) : p.pass_rate, p.pass_rate === null ? '待核对' : '已核对']);
  }
  const summaryHeaders = ['标注员', '任务数', '总框ID', '错误框ID', '通过框ID', '通过率', '统计状态'];
  function save(bytes, name, type) {
    const url = URL.createObjectURL(new Blob([bytes], { type })); const a = document.createElement('a'); a.href = url; a.download = name; root.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  const dateStamp = () => new Date().toISOString().replace(/[-:]/g, '').slice(0, 15).replace('T', '_');
  $('copy').addEventListener('click', async () => {
    if (!result) return;
    const text = [summaryHeaders, ...summaryRows(true)].map(row => row.map(value => String(value ?? '待核对').replace(/[\t\r\n]/g, ' ')).join('\t')).join('\n');
    try {
      if (typeof GM_setClipboard === 'function') GM_setClipboard(text, 'text'); else await navigator.clipboard.writeText(text);
      $('copy').textContent = '已复制'; clearTimeout(copyTimer); copyTimer = setTimeout(() => { $('copy').textContent = '复制汇总表'; }, 1600);
    } catch { $('status').textContent = '复制失败，请使用“导出汇总 CSV”或“导出完整 Excel”。'; }
  });
  $('csv').addEventListener('click', () => { if (result) save(Core.toCSV(summaryHeaders, summaryRows(true)), `标注员框ID通过率_${result.complete ? '' : '待核对_'}${dateStamp()}.csv`, 'text/csv;charset=utf-8'); });
  $('excel').addEventListener('click', () => {
    if (!result) return;
    const sheets = [
      { name: '标注员通过率', headers: summaryHeaders, rows: summaryRows(), percentColumns: [5] },
      { name: '每条数据框数', headers: ['项目ID', '任务ID', '标注员', '总框ID', '错误框ID', '通过框ID', '通过率', '选用版本', '版本ID', '版本时间', '任务链接', '待核对原因'], percentColumns: [6], rows: result.tasks.map(t => [t.project_id, t.task_id, t.annotator, t.region_count, t.error_count, t.pass_count, t.pass_rate, t.version, t.version_id, t.updated_at, t.url, t.issue || '']) },
      { name: '框ID明细', headers: ['项目ID', '任务ID', '标注员', '框ID', '框标签', '是否错误', '质检原行号', '选用版本', '唯一键'], rows: result.regions.map(r => [r.project_id, r.task_id, r.annotator, r.region_id, r.label, r.error ? '是' : '否', r.qc_source_rows.join('、'), r.version, r.key]) },
      { name: '质检记录', headers: ['原行号', '项目ID', '任务ID', '标注员', '质检员', '质检结果', '问题类型', '问题描述', '构图比例', '图片文件名', '附件', '原框ID', '当前框ID', '对应方式', '任务链接'], rows: result.qc.map(q => [q.source_row, q.project_id, q.task_id, q.annotator, q.reviewer, q.result, q.reason, q.comment, q.ratio, q.image, q.attachment, q.original_region_id, q.matched_region_id, q.match_method, q.url]) },
      { name: '待核对与口径', headers: ['类型', '原行号', '项目ID', '任务ID', '标注员', '说明'], rows: [['统计口径', '', '', '', '', '通过率=1−错误框ID/总框ID；按项目/任务/框去重，含主体和合格数据。统计范围仅限导入任务。'], ['版本口径', '', '', '', '', $('drafts').checked ? '优先最新已保存草稿，无草稿使用已提交标注；不包含未保存改动。' : '仅使用已提交标注，不包含草稿和未保存改动。'], ...result.issues.map(i => ['待核对', i.source_row || '', i.project_id || '', i.task_id || '', i.annotator || '', i.message])] }
    ];
    // A blank rate in an incomplete workbook always has an explicit status/reason alongside it.
    try { save(Core.workbookBytes(sheets), `按实际框ID统计_标注员通过率_${result.complete ? '' : '待核对_'}${dateStamp()}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); }
    catch (error) { $('status').textContent = `导出失败：${error.message}。可以先导出汇总 CSV。`; }
  });
})();

})();
