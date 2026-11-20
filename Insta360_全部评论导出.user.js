// ==UserScript==
// @name         Insta360 全部评论导出
// @namespace    local.insta360.comment-export
// @version      1.0.0
// @description  按项目读取全部任务评论，按项目分工作表导出Excel、任务汇总和读取状态。
// @match        https://label.insta360.com/*
// @homepageURL  https://github.com/chengzi-1225/Insta360-chengzi
// @downloadURL  https://raw.githubusercontent.com/chengzi-1225/Insta360-chengzi/main/Insta360_全部评论导出.user.js
// @updateURL    https://raw.githubusercontent.com/chengzi-1225/Insta360-chengzi/main/Insta360_全部评论导出.user.js
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function(){
'use strict';
const Core={...(()=>{
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

return {taskIdentity,parseTable,calculate,toCSV,fetchTaskJSON,workbookBytes};
})(),...(()=>{
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
    const annotations = Array.isArray(detail.annotations) ? detail.annotations.filter(value => value && !commentBoolean(value.was_cancelled) && !commentBoolean(value.is_draft)) : [];
    const annotation = commentLatest(annotations, true);
    const reviewer = commentLatest(Array.isArray(detail.reviews) ? detail.reviews : []);
    const annotatorName = commentUserName(annotation?.completed_by, users, annotation?.created_username);
    const reviewerName = commentUserName(reviewer?.created_by, users, reviewer?.created_username);
    const feedback = detail.feedback;
    const reviewText = commentText(reviewer?.comment || (feedback && typeof feedback === 'object' ? feedback.text ?? feedback.comment : feedback));
    const file = commentFileName(detail, currentOrigin) || commentFileName(raw, currentOrigin);
    const shared = { 项目ID: projectId, 任务ID: taskId, 文件名称: file, 任务页面链接: pageUrl, 标注员: annotatorName, 审核员: reviewerName };
    const taskComments = validComments.map(value => ({
      ...shared,
      评论ID: value.id ?? '',
      评论文字: commentText(value.text),
      评论图片: commentImages(value.images, currentOrigin),
      评论人: commentUserName(value.created_by, users, value.created_username),
      评论时间: commentText(value.created_at),
      修改时间: commentText(value.updated_at),
      是否已解决: commentBoolean(value.is_resolved) ? '是' : '否',
      标注ID: value.annotation && typeof value.annotation === 'object' ? value.annotation.id ?? commentText(value.annotation) : value.annotation ?? '',
    }));
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

return {parseProjectIds,fetchPagedRows,collectCommentProjects};
})()};
(function () {
  'use strict';
  if (window.top !== window.self || document.getElementById('i360-comment-export-host')) return;
  const host = document.createElement('div'); host.id = 'i360-comment-export-host'; document.body.append(host);
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    :host{all:initial;font:14px/1.55 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;color:#1f3542}*{box-sizing:border-box}[hidden]{display:none!important}button,input{font:inherit}button{cursor:pointer;border:1px solid #cbd8df;border-radius:8px;background:white;color:#254554;padding:8px 13px}button:hover{background:#edf5f6}.primary{background:#12675b;color:white;border-color:#12675b}.primary:hover{background:#0e544b}button:disabled{opacity:.45;cursor:default}#launcher{position:fixed;right:22px;bottom:92px;z-index:2147483600;color:#12675b;border-color:#12675b;box-shadow:0 3px 16px #16362e33;font-weight:600}#backdrop{position:fixed;inset:0;background:#13293466;z-index:2147483601;display:grid;place-items:center;padding:20px}#panel{width:min(1080px,96vw);height:min(820px,92vh);background:#f7fafb;border-radius:16px;box-shadow:0 18px 90px #0d273644;display:flex;flex-direction:column;overflow:hidden}header{display:flex;align-items:flex-start;gap:16px;padding:20px 24px 14px;background:#fff;border-bottom:1px solid #dfe8eb}h1{font-size:20px;margin:0 0 4px;font-weight:650}header p{margin:0;color:#61727e;font-size:13px}#close{margin-left:auto;padding:4px 12px;font-size:20px}main{padding:18px 24px 24px;overflow:auto;flex:1}label{display:block;font-weight:600;margin-bottom:7px}input{width:100%;border:1px solid #c7d5dc;border-radius:8px;padding:10px;background:#fff;color:#223947}.hint{font-size:12px;color:#647783;margin:7px 0}.toolbar{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin:14px 0}.toolbar .spacer{flex:1}.status{white-space:pre-line;min-height:25px;color:#4c6574;font-size:13px}progress{width:100%;height:7px;accent-color:#12675b;margin:5px 0 15px}.metricgrid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:15px 0}.metric{border:1px solid #dce6e9;border-radius:10px;background:#fff;padding:12px 16px}.metric span{display:block;color:#6c7e89;font-size:12px}.metric strong{display:block;font-size:24px;margin-top:3px;color:#164a43;font-variant-numeric:tabular-nums}.tablewrap{border:1px solid #d8e2e6;border-radius:10px;overflow:auto;background:#fff;max-height:360px}table{border-collapse:collapse;width:100%;font-size:13px}th{position:sticky;top:0;background:#edf4f4;font-weight:600;color:#435e68}th,td{text-align:left;padding:9px 12px;border-bottom:1px solid #e6edef;white-space:nowrap}td.wrap{white-space:pre-wrap;min-width:220px;max-width:500px}.warning{background:#fff5e5;color:#8b5716;border:1px solid #f0d7a8;border-radius:8px;padding:10px 12px;margin:12px 0;font-size:13px}@media(max-width:650px){main{padding:14px}header{padding:16px}.metricgrid{grid-template-columns:repeat(2,1fr)}#backdrop{padding:8px}}
  `;
  root.append(style);
  const body = document.createElement('div');
  body.innerHTML = `<button id="launcher" type="button">全部评论导出</button><div id="backdrop" hidden><section id="panel" role="dialog" aria-modal="true" aria-labelledby="title"><header><div><h1 id="title">导出项目全部评论</h1><p>读取项目内全部任务、评论、评论人和时间，并导出 Excel 与 CSV</p></div><button id="close" type="button" aria-label="收起评论导出面板">×</button></header><main><label for="projects">项目 ID</label><input id="projects" spellcheck="false" placeholder="例如：10532,10533,10534（也支持中文逗号）"><p class="hint">可以填写一个或多个项目 ID。当前页面项目会自动填入；脚本只使用当前浏览器登录会话读取同源接口。</p><div class="toolbar"><button id="start" class="primary" type="button">开始读取全部评论</button><button id="cancel" type="button" disabled>停止</button><span class="spacer"></span><button id="summary" type="button" disabled>导出任务汇总 CSV</button><button id="comments" type="button" disabled>导出评论明细 CSV</button><button id="excel" class="primary" type="button" disabled>导出 Excel</button></div><div id="status" class="status" role="status" aria-live="polite">先输入项目 ID，再开始读取。</div><progress id="progress" max="1" value="0" hidden></progress><section id="result" hidden><div class="metricgrid" id="metrics"></div><div id="warning" class="warning" hidden></div><div class="tablewrap"><table><thead><tr><th>项目</th><th>任务 ID</th><th>评论数</th><th>标注员</th><th>文件名称</th><th>读取状态</th></tr></thead><tbody id="rows"></tbody></table></div></section></main></section></div>`;
  root.append(body);
  const $ = id => root.getElementById(id);
  let output = null, controller = null, focusBefore = null;
  const stamp = () => new Date().toISOString().replace(/[-:]/g, '').slice(0, 15).replace('T', '_');
  function download(bytes, name, type) { const url = URL.createObjectURL(new Blob([bytes], { type })); const a = document.createElement('a'); a.href = url; a.download = name; root.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000); }
  function show() { focusBefore = document.activeElement; $('backdrop').hidden = false; $('projects').focus(); }
  function hide() { $('backdrop').hidden = true; (focusBefore?.isConnected ? focusBefore : $('launcher')).focus(); }
  $('launcher').addEventListener('click', show); $('close').addEventListener('click', hide); $('backdrop').addEventListener('click', e => { if (e.target === $('backdrop')) hide(); });
  for (const type of ['keydown', 'keyup', 'keypress']) host.addEventListener(type, e => e.stopPropagation());
  root.addEventListener('keydown', e => {
    if ($('backdrop').hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); hide(); }
    if (e.key === 'Tab') {
      const controls = [...$('panel').querySelectorAll('button,input')].filter(el => !el.disabled && !el.closest('[hidden]'));
      if (e.shiftKey && root.activeElement === controls[0]) { e.preventDefault(); controls.at(-1).focus(); }
      else if (!e.shiftKey && root.activeElement === controls.at(-1)) { e.preventDefault(); controls[0].focus(); }
    }
  });
  const currentProject = /\/projects\/([1-9]\d*)(?:\/|$)/.exec(location.pathname)?.[1]; if (currentProject) $('projects').value = currentProject;
  function invalidate() {
    output = null;
    $('result').hidden = true;
    for (const id of ['summary', 'comments', 'excel']) $(id).disabled = true;
  }
  function busy(active) {
    $('projects').disabled = active;
    $('start').disabled = active;
    $('cancel').disabled = !active;
    $('progress').hidden = !active;
  }
  $('projects').addEventListener('input', () => {
    invalidate(); $('status').textContent = '项目 ID 已更新，请重新读取。';
  });
  $('cancel').addEventListener('click', () => controller?.abort());
  function rowsFor(records, headers) { return records.map(record => headers.map(key => record[key] === undefined ? '' : record[key])); }
  const summaryHeaders = ['项目ID', '任务ID', '文件名称', '任务页面链接', '标注员', '审核员', '最新审核评论', '任务状态', '最新评论文字', '全部评论文字', '评论条数', '评论读取状态', '详情读取状态'];
  const commentHeaders = ['项目ID', '任务ID', '文件名称', '任务页面链接', '标注员', '审核员', '评论ID', '评论文字', '评论人', '评论时间', '修改时间', '是否已解决', '标注ID', '评论图片'];
  const failureHeaders = ['项目ID', '任务ID', '说明'];
  function render() {
    $('result').hidden = false;
    $('rows').replaceChildren();
    // Large projects keep all rows in the export; preview a bounded subset to keep the page responsive.
    for (const row of output.summaries.slice(0, 200)) {
      const tr = document.createElement('tr');
      for (const key of ['项目ID', '任务ID', '评论条数', '标注员', '文件名称', '评论读取状态']) {
        const td = document.createElement('td'); td.textContent = row[key] ?? '读取失败'; tr.append(td);
      }
      $('rows').append(tr);
    }
    const notices = [];
    if (output.failures.length) notices.push(`有 ${output.failures.length} 条读取失败记录，已写入“读取状态”工作表。带“待核对”的导出文件包含成功读取的数据。`);
    notices.push(...output.warnings.map(w => typeof w === 'string' ? w : w.message || w.说明 || '用户姓名读取不完整'));
    if (output.summaries.length > 200) notices.push('页面预览前 200 个任务；导出包含全部已读取的任务。');
    $('warning').hidden = !notices.length; $('warning').textContent = notices.join('\n');
    const values = [['项目数', output.projects.length], ['任务数', output.summaries.length], [output.complete ? '全部评论数' : '已读取评论数', output.comments.length], ['待核对', output.failures.length]];
    $('metrics').replaceChildren(...values.map(([name, value]) => {
      const div = document.createElement('div'); div.className = 'metric';
      const label = document.createElement('span'), number = document.createElement('strong');
      label.textContent = name; number.textContent = value; div.append(label, number); return div;
    }));
    for (const id of ['summary', 'comments', 'excel']) $(id).disabled = false;
  }
  $('start').addEventListener('click', async () => {
    if (controller) return;
    let projects;
    try { projects = Core.parseProjectIds($('projects').value); }
    catch (error) { $('status').textContent = error.message; return; }
    invalidate(); controller = new AbortController();
    const signal = controller.signal; busy(true);
    $('progress').removeAttribute('value');
    $('status').textContent = `准备读取 ${projects.length} 个项目…`;
    try {
      output = await Core.collectCommentProjects(projects, {
        origin: location.origin, signal,
        requestJSON: (url, options) => Core.fetchTaskJSON(url, { ...options, allowArray: true }),
        onProgress: event => {
          if (event.total) { $('progress').max = event.total; $('progress').value = event.done || 0; }
          else $('progress').removeAttribute('value');
          $('status').textContent = event.message || `项目 ${event.projectId}：已读取 ${event.done || 0} / ${event.total || '…'} 个任务，${event.commentCount || 0} 条评论。`;
        },
      });
      if (signal.aborted) throw new DOMException('已停止', 'AbortError');
      render();
      $('status').textContent = output.complete
        ? `读取完成：${output.projects.length} 个项目，${output.summaries.length} 个任务，${output.comments.length} 条评论。`
        : `读取结束：${output.summaries.length} 个任务、${output.comments.length} 条已读取评论，${output.failures.length} 条记录待核对。`;
    } catch (error) {
      invalidate(); $('status').textContent = signal.aborted ? '已停止。本次没有生成导出结果，可以重新读取。' : `读取失败：${error.message}`;
    } finally { controller = null; busy(false); }
  });
  const suffix = () => `${output.complete ? '' : '待核对_'}${stamp()}`;
  $('summary').addEventListener('click', () => {
    if (output) download(Core.toCSV(summaryHeaders, rowsFor(output.summaries, summaryHeaders)), `项目任务汇总_${suffix()}.csv`, 'text/csv;charset=utf-8');
  });
  $('comments').addEventListener('click', () => {
    if (output) download(Core.toCSV(commentHeaders, rowsFor(output.comments, commentHeaders)), `全部评论明细_${suffix()}.csv`, 'text/csv;charset=utf-8');
  });
  $('excel').addEventListener('click', () => {
    if (!output) return;
    const sheets = output.projects.map(id => ({
      name: `项目${id}`, headers: commentHeaders,
      rows: rowsFor(output.comments.filter(row => String(row['项目ID']) === String(id)), commentHeaders),
      widths: [12, 14, 28, 62, 16, 16, 12, 65, 18, 25, 25, 12, 14, 60],
    }));
    sheets.push(
      { name: '任务汇总', headers: summaryHeaders, rows: rowsFor(output.summaries, summaryHeaders), widths: [12, 14, 28, 62, 16, 16, 35, 14, 35, 55, 12, 26, 26] },
      { name: '读取状态', headers: failureHeaders, rows: [...rowsFor(output.failures, failureHeaders), ...output.warnings.map(w => ['', '', typeof w === 'string' ? w : w.message || w.说明 || '用户姓名读取不完整'])], widths: [12, 14, 80] },
    );
    try { download(Core.workbookBytes(sheets), `项目全部评论_${suffix()}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); }
    catch (error) { $('status').textContent = `导出失败：${error.message}。可以先导出 CSV。`; }
  });
})();

})();
