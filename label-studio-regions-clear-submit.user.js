// ==UserScript==
// @name         Insta360 Regions 批量清空并提交
// @namespace    local.insta360.regions-cleaner
// @version      3.2.2
// @description  输入 ID 或导入勾选后直接逐条清空 Regions 并原生提交；无需预览，提交后回读验证。
// @homepageURL  https://github.com/chengzi-1225/Insta360-chengzi
// @updateURL    https://raw.githubusercontent.com/chengzi-1225/Insta360-chengzi/main/label-studio-regions-clear-submit.meta.js
// @downloadURL  https://raw.githubusercontent.com/chengzi-1225/Insta360-chengzi/main/label-studio-regions-clear-submit.user.js
// @match        https://label.insta360.com/workspaces/*/projects/*/data*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

(() => {
  'use strict';
  const VERSION = '3.2.2';
  const MAX_TASKS = 10000;
  const clone = value => JSON.parse(JSON.stringify(value));
  const canonical = value => JSON.stringify(normalize(value));
  function normalize(value) {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => [k, normalize(value[k])]));
    return value;
  }
  const same = (a, b) => canonical(a) === canonical(b);
  const idOf = x => Number(x && typeof x === 'object' ? x.id : x);
  const roots = result => {
    if (!Array.isArray(result)) throw new Error('标注结果不是数组');
    const list = result.filter(r => r.type === 'reframe');
    if (list.some(r => typeof r.id !== 'string' || !r.id || !r.to_name) || new Set(list.map(r => r.id)).size !== list.length) throw new Error('轨迹 ID 缺失或重复');
    return list;
  };
  function cleanResult(result) {
    const selected = new Map(roots(result).map(r => [r.id, r]));
    return result.filter(r => r.type === 'relation' ? !selected.has(r.from_id) && !selected.has(r.to_id) : !selected.has(r.id) || selected.get(r.id).to_name !== r.to_name);
  }
  function parseIds(value) {
    const tokens = value.trim().split(/[\s,，;；]+/).filter(Boolean);
    if (!tokens.length || tokens.some(s => !/^#?[1-9]\d*$/.test(s))) throw new Error('请输入任务 ID，用逗号或换行分隔');
    const ids = [...new Set(tokens.map(s => Number(s.replace('#', ''))))];
    if (ids.length > MAX_TASKS || ids.some(x => !Number.isSafeInteger(x))) throw new Error(`每批最多 ${MAX_TASKS} 个有效任务 ID，请缩小筛选范围`);
    return ids;
  }
  async function resolveSelection(selection, query, project, fetchPage, options = {}) {
    const check = () => {
      if (options.shouldStop?.()) throw new Error('已停止导入，未导入部分结果');
      options.assertScope?.();
    };
    if (!selection || typeof selection.all !== 'boolean') throw new Error('无法读取页面选择，请先在原列表勾选或全选任务');
    const validate = list => {
      if (!Array.isArray(list)) throw new Error('页面选择结构不受支持');
      return list.length ? parseIds(list.join(',')) : [];
    };
    check();
    if (!selection.all) {
      const ids = validate(selection.included);
      if (!ids.length) throw new Error('请先在原列表勾选或全选任务');
      return ids;
    }
    const excluded = new Set(validate(selection.excluded));
    let parsed;
    try { parsed = typeof query === 'string' ? JSON.parse(query) : clone(query); } catch (_) { throw new Error('无法读取当前筛选条件'); }
    if (!parsed?.filters || !Array.isArray(parsed.filters.items) || !Array.isArray(parsed.ordering)) throw new Error('当前视图筛选结构不受支持');
    // Stable tie-breaker prevents tied sort values from moving between pages.
    if (!parsed.ordering.some(k => String(k).replace(/^-/, '') === 'tasks:id')) parsed.ordering.push('tasks:id');
    const frozenQuery = JSON.stringify(parsed), pageSize = 50;
    const ids = [], seen = new Set(); let total = null;
    for (let page = 1; ; page++) {
      check();
      const response = await fetchPage({ project, query: frozenQuery, page, page_size: pageSize });
      check();
      if (!response || response.error || response.isCanceled || response.$meta?.status >= 400 || !Array.isArray(response.tasks) || !Number.isSafeInteger(response.total) || response.total < 0) throw new Error('读取全选任务失败，请重试导入');
      if (total === null) total = response.total;
      if (response.total !== total) throw new Error('导入期间筛选结果数量发生变化，请重新导入');
      if (total > MAX_TASKS) throw new Error(`筛选结果 ${total} 条，超过 ${MAX_TASKS} 条，请先缩小筛选范围`);
      if (response.tasks.length > pageSize || (!response.tasks.length && seen.size < total)) throw new Error('分页结果不完整，请重新导入');
      for (const task of response.tasks) {
        const id = Number(task.id);
        if (!Number.isSafeInteger(id) || id <= 0 || seen.has(id)) throw new Error('分页任务 ID 无效或重复，请重新导入');
        if (task.project != null && idOf(task.project) !== project) throw new Error('分页结果项目不匹配，停止导入');
        seen.add(id); if (!excluded.has(id)) ids.push(id);
      }
      options.report?.(seen.size, total, ids.length);
      if (seen.size > total) throw new Error('分页结果总数不一致，请重新导入');
      if (seen.size === total) break;
    }
    if (!ids.length) throw new Error('当前全选范围内没有可导入任务');
    return ids;
  }
  function comparisonResult(result) {
    const trajectories = new Map(roots(result).map(r => [r.id, r.to_name]));
    return result.map(r => {
      // The video player rewrites this derived metadata while loading media.
      // Keep sequence/reframedata and every other field; never change the actual result.
      if (!trajectories.has(r.id) || trajectories.get(r.id) !== r.to_name || !['reframe', 'choices'].includes(r.type) || !r.value) return r;
      const value = { ...r.value }; delete value.duration; delete value.framesCount;
      return { ...r, value };
    });
  }
  function actionFor(snapshot) {
    return roots(snapshot.result).length ? 'workflow' : 'skip';
  }
  // Observe the native request promises without changing request data or responses.
  // History is loaded after hydration and can replace an initially empty annotation.
  function trackNativeRequests(manager) {
    const original = manager.apiCall;
    const tracker = { pending: 0, revision: 0, historySeen: 0, historyError: null };
    function wrapped(...args) {
      const history = args[0] === 'annotationHistory';
      if (history) tracker.historySeen++;
      const result = original.apply(this, args);
      if (!result || typeof result.then !== 'function') return result;
      tracker.pending++; tracker.revision++;
      return result.then(value => {
        tracker.pending--; tracker.revision++;
        if (history && (!value || value.error || value.$meta?.status >= 400)) tracker.historyError = '历史标注请求失败';
        return value;
      }, error => {
        tracker.pending--; tracker.revision++;
        if (history) tracker.historyError = error.message || '历史标注请求失败';
        throw error;
      });
    }
    manager.apiCall = wrapped;
    if (manager.apiCall !== wrapped) throw new Error('当前版本无法跟踪原生加载，请勿继续');
    tracker.close = () => { if (manager.apiCall === wrapped) manager.apiCall = original; };
    return tracker;
  }
  async function waitForNativeReady(read, tracker, options = {}) {
    const now = options.now || Date.now;
    const pause = options.wait || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const timeout = options.timeout ?? 45000, quietMs = options.quietMs ?? 1500;
    const start = now(), checkpoint = tracker.readyCheckpoint;
    let last = checkpoint?.clock === now ? checkpoint.token : null;
    let stableAt = last ? checkpoint.stableAt : start;
    let previousAnnotation = last ? checkpoint.annotation : null;
    const reset = () => { last = null; previousAnnotation = null; stableAt = now(); tracker.readyCheckpoint = null; };
    while (now() - start < timeout) {
      if (options.shouldStop?.()) { reset(); throw new Error('已结束本次原生加载等待'); }
      if (tracker.historyError) throw new Error(tracker.historyError);
      if (tracker.pending || tracker.historySeen <= 0) { reset(); await pause(150); continue; }
      const sample = read();
      if (sample?.ready) {
        const token = canonical({ revision: tracker.revision, identity: sample.identity, result: comparisonResult(sample.result) });
        if (token !== last || previousAnnotation !== sample.a) { last = token; previousAnnotation = sample.a; stableAt = now(); }
        tracker.readyCheckpoint = { token: last, annotation: sample.a, stableAt, clock: now };
        if (now() - stableAt >= quietMs) return sample;
      } else reset();
      await pause(150);
    }
    throw new Error('等待任务历史、媒体或提交后重新加载超时；未继续后续操作，请检查原生页面');
  }
  async function readWhileNativeReady(read, tracker, fetchTask, options = {}) {
    let closed = false;
    const readiness = { ...options, shouldStop: () => closed || options.shouldStop?.() };
    try {
      // Start the read immediately so its network time overlaps native loading.
      const taskPromise = Promise.resolve(fetchTask());
      const [first, task] = await Promise.all([waitForNativeReady(read, tracker, readiness), taskPromise]);
      const sample = await waitForNativeReady(read, tracker, readiness);
      if (first.a !== sample.a) throw new Error('读取期间标注来源改变，本任务未继续操作，请核查当前任务');
      return { task, sample };
    } finally { closed = true; }
  }
  async function verifySubmittedResult(task, annotationId, expected, submitted, readTask) {
    const matches = t => t?.id === task && t.annotations?.some(a => Number(a.id) === annotationId && same(a.result, expected) && roots(a.result).length === 0) && t.state === 'ANNOTATED';
    let t = submitted?.taskSnapshot;
    // Retry only the read if server postprocessing lagged behind the success event.
    if (!matches(t)) t = await readTask(task);
    if (!matches(t)) throw new Error('已提交结果回读不一致，停止后续任务');
    return t;
  }

  async function loadNativeTask(manager, task) {
    // Loading a task record alone does not mount the editor on the list page.
    // Use the same store action as a task-row click for the first task.
    if (manager.mode === 'explorer' || !manager.lsf?.loadTask) {
      if (typeof manager.store.startLabeling !== 'function') throw new Error('当前页面缺少原生进入任务入口，请刷新页面');
      await manager.store.startLabeling({ id: task });
    } else {
      await manager.lsf.loadTask(task);
    }
  }
  // The runner is independent of the page so success, failure and ordering can be tested offline.
  async function runBatch(entries, adapter, report, shouldStop = () => false) {
    const outcomes = [];
    for (const entry of entries) {
      if (shouldStop()) break;
      const outcome = { task: entry.task, stage: 'checking', annotationId: null, startedAt: new Date().toISOString() };
      outcomes.push(outcome);
      const emit = (stage, message) => { outcome.stage = stage; report(outcomes, message); };
      try {
        emit('checking', `任务 ${entry.task}：读取当前编辑器内容`);
        const current = await adapter.inspect(entry.task);
        outcome.state = current.state; outcome.source = current.source;
        outcome.regions = roots(current.result).length;
        const action = actionFor(current);
        if (action === 'skip') { emit('skipped', `任务 ${entry.task}：当前标注已无轨迹，跳过`); continue; }
        const expected = cleanResult(current.result);
        emit('cleaning', `任务 ${entry.task}：清空 ${roots(current.result).length} 条轨迹`);
        const cleaned = await adapter.clear(current);
        if (!same(cleaned, expected)) throw new Error('原生删除后的结果与预期不同，停止提交');
        emit('submitting', `任务 ${entry.task}：点击原生提交`);
        const submitted = await adapter.submit(entry.task);
        if (!Number.isSafeInteger(submitted.id) || submitted.id <= 0) throw new Error('提交成功事件缺少标注 ID');
        outcome.annotationId = submitted.id;
        emit('verifying_submission', `任务 ${entry.task}：回读已提交结果`);
        await adapter.verifySubmission(entry.task, submitted.id, expected, submitted);
        emit('done', `任务 ${entry.task}：清空并提交完成，已回读验证`);
      } catch (error) {
        if (Number.isSafeInteger(error.annotationId) && error.annotationId > 0) outcome.annotationId = error.annotationId;
        outcome.failedAt = outcome.stage;
        outcome.stage = 'failed'; outcome.error = error.message;
        report(outcomes, `任务 ${entry.task} 失败（${outcome.failedAt}）：${error.message}。已停止后续任务。`);
        break; // Never retry a submission automatically.
      }
    }
    return outcomes;
  }
  if (typeof module === 'object' && module.exports) { module.exports = { cleanResult, roots, parseIds, same, comparisonResult, actionFor, resolveSelection, trackNativeRequests, waitForNativeReady, readWhileNativeReady, verifySubmittedResult, loadNativeTask, runBatch }; return; }
  if (location.origin !== 'https://label.insta360.com') return;
  const project = Number(location.pathname.match(/\/projects\/(\d+)\/data/)?.[1]);
  if (!project) return;
  if (window.InstaRegionWorkflow?.version === VERSION) { window.InstaRegionWorkflow.open(); return; }
  if (window.InstaRegionWorkflow?.isBusy?.()) { alert('上一版流程仍在运行，请等待当前批次结束后再更新。'); return; }
  const old = document.getElementById('insta-regions-cleaner');
  if (old?.shadowRoot?.getElementById('stop')?.disabled === false) { alert('旧版脚本仍在运行，请先停止，待其结束后再加载新版。'); return; }
  old?.remove();

  const host = document.createElement('div'); host.id = 'insta-regions-cleaner';
  Object.assign(host.style, { position: 'fixed', right: '20px', bottom: '20px', zIndex: '2147483647', pointerEvents: 'auto' });
  const toggle = document.createElement('button'); toggle.textContent = 'Regions 清空并提交 v3';
  Object.assign(toggle.style, { padding: '12px 18px', border: '0', borderRadius: '24px', background: '#143f50', color: 'white', cursor: 'pointer', fontSize: '14px', boxShadow: '0 5px 24px #0004' });
  const frame = document.createElement('iframe'); frame.title = 'Regions 清空并提交面板'; frame.id = 'insta-regions-workflow-frame';
  Object.assign(frame.style, { position: 'fixed', right: '20px', top: '24px', bottom: '80px', height: 'calc(100vh - 104px)', width: 'min(800px, calc(100vw - 40px))', border: '1px solid #bacdd4', borderRadius: '14px', background: '#f8fafb', boxShadow: '0 15px 60px #0005', display: 'none' });
  // A same-origin iframe isolates keyboard and pointer events from Label Studio's global hotkeys.
  // No scripts, third-party URLs or untrusted HTML are embedded in this document.
  frame.srcdoc = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
    *{box-sizing:border-box}body{margin:0;background:#f8fafb;color:#203648;font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}header{position:sticky;top:0;background:#143f50;color:white;padding:16px 20px;display:flex;justify-content:space-between;z-index:1}h2{font-size:18px;margin:0}small{color:#c6dce5}#close{color:white;background:transparent;border:0;font-size:23px}main{padding:18px 20px}p{margin:0 0 10px}.hint{color:#607586;font-size:12px}button,input,textarea{font:inherit}button{cursor:pointer;border:1px solid #c4d4dc;border-radius:7px;padding:7px 12px;background:white;color:#203648}button:disabled{opacity:.45;cursor:default}.primary{background:#126c76;color:white;border-color:#126c76}.danger{background:#a73333;color:white;border-color:#a73333}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:10px 0}textarea{display:block;width:100%;min-height:90px;resize:vertical;background:white;border:1px solid #9eb7c4;border-radius:8px;padding:10px;user-select:text!important;pointer-events:auto!important;cursor:text!important}textarea:focus{outline:2px solid #52a6af;outline-offset:1px}.step{display:flex;gap:7px;flex-wrap:wrap;background:#eaf2f4;padding:10px 12px;border-radius:8px;margin-bottom:16px}.notice{border-left:3px solid #c79737;background:#fff4dc;padding:10px 12px;font-size:12px;margin:14px 0}table{width:100%;border-collapse:collapse;background:white;font-size:12px}th,td{text-align:left;border-bottom:1px solid #e2e9ee;padding:9px 6px;vertical-align:top}th{background:#edf3f6;position:sticky;top:0}.table{max-height:280px;overflow:auto;border:1px solid #d3e0e6;border-radius:8px}input[type=checkbox]{accent-color:#126c76}#log{white-space:pre-wrap;background:#eaf0f3;padding:12px;border-radius:8px;max-height:190px;overflow:auto;font-size:12px}#summary{font-weight:600;margin:12px 0}.error{color:#a73333}.ok{color:#126c76}a{color:#126c76}footer{font-size:12px;color:#607586;margin-top:15px}
  </style></head><body><header><div><h2>Regions 清空并提交</h2><small>v${VERSION} · 项目 ${project} · 清空轨迹与原生提交</small></div><button id="close" aria-label="收起面板">×</button></header><main>
    <div class="step"><span>① 进入任务</span><span>→</span><span>② 清空轨迹</span><span>→</span><span>③ 提交</span><span>→</span><span>④ 核对结果</span></div>
    <p>选择任务</p><p class="hint">输入任务 ID，或导入原列表勾选 / 全选结果。全选遵循当前筛选及取消勾选项，每批最多 10000 个。</p>
    <textarea id="ids" aria-label="任务 ID" autocomplete="off" spellcheck="false" placeholder="例如：4361049, 4361050&#10;支持逗号或换行分隔"></textarea>
    <div class="row"><button id="readSelected" data-action>导入页面勾选 / 全选</button><button id="current" data-action>填入当前打开任务</button></div>
    <p class="hint">输入或导入后，点击“直接清空并提交”，确认一次即开始。逐条进入任务、清空轨迹、原生提交并回读验证。</p>
    <div class="table"><table><thead><tr><th>任务</th><th>原状态 / 当前来源</th><th>轨迹</th><th>操作 / 进度</th></tr></thead><tbody id="rows"></tbody></table></div>
    <div id="summary">等待输入任务 ID</div>
    <div class="notice">先保存其他编辑页，并避免同时编辑这些任务。脚本会使用进入任务后默认选中的标注，删除其中全部 reframe 轨迹及关联项，保留视频级分类。其他标注版本和机器预测原始记录不改动。任一步失败会停止后续任务。</div>
    <div class="row"><button id="run" data-action class="danger" disabled>直接清空并提交</button><button id="stop" disabled>当前任务完成后停止</button><button id="journal" data-action disabled>下载执行记录</button></div>
    <p id="runHint" class="hint" role="status"></p>
    <div id="log" role="status">就绪。请填写任务 ID 或读取原列表中的勾选。</div>
    <footer>输入框位于独立页面中，不受标注快捷键影响。发生提交超时请先检查任务，脚本不会自动重试提交。</footer>
  </main></body></html>`;
  const state = { busy: false, stopped: false, taskIds: [], journal: [] };
  const open = () => { frame.style.display = 'block'; };
  toggle.onclick = () => { frame.style.display = frame.style.display === 'none' ? 'block' : 'none'; };
  window.InstaRegionWorkflow = { version: VERSION, open, isBusy: () => state.busy };
  const dm = () => {
    const value = window.dataManager;
    if (!value?.store?.taskStore || typeof value.apiCall !== 'function') throw new Error('原生 DataManager 未就绪，请等待页面加载或刷新');
    if (Number(value.projectId || value.store.project?.id) !== project) throw new Error('页面项目已切换，请刷新再运行');
    if (!['explorer', 'labeling'].includes(value.mode)) throw new Error('请在项目数据列表或任务详情中使用，不要在连续标注/审核模式中运行');
    return value;
  };
  async function getTask(task) {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 25000);
    try {
      const r = await fetch(`/api/tasks/${task}?project=${project}`, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal, headers: { Accept: 'application/json' } });
      if (!r.ok || r.redirected || !r.headers.get('content-type')?.includes('application/json')) throw new Error(`读取任务失败：HTTP ${r.status}`);
      const t = await r.json();
      if (Number(t.id) !== task || idOf(t.project) !== project) throw new Error('任务 ID 或项目不匹配');
      for (const k of ['annotations', 'drafts', 'predictions']) if (!Array.isArray(t[k])) throw new Error(`不支持的任务结构：${k}`);
      return t;
    } finally { clearTimeout(timer); }
  }
  function nativeAnnotation(task) {
    const b = dm().lsf; const a = b?.currentAnnotation;
    if (Number(b?.taskID) !== task || !a || b.lsf?.isLoading || !b.lsf?.hydrated) return null;
    return { b, a };
  }
  function readySample(task) {
    const native = nativeAnnotation(task); if (!native) return null;
    const { a, b } = native;
    const names = b.lsf.annotationStore?.names;
    const videos = names ? [...names.values()].filter(o => o.type === 'video') : [];
    const ready = videos.length > 0 && videos.every(o => o.isReady && o.ref?.current && Number.isFinite(o.ref.current.duration) && o.ref.current.duration > 0 && o.length > 0) && !a.isDraftSaving;
    return { ...native, ready, identity: { id: a.id, pk: a.pk, draftId: a.draftId }, result: ready ? clone(a.serializeAnnotation()) : null };
  }
  function backendSnapshot(t) {
    const record = x => ({ id: x.id, task: x.task, annotation: x.annotation, user: x.user, updated_at: x.updated_at, result: x.result });
    return { annotations: t.annotations.map(record), drafts: t.drafts.map(record), predictions: t.predictions.map(record) };
  }
  const adapter = {
    async inspect(task) {
      const manager = dm();
      if (manager.lsf?.lsf?.commentStore?.hasUnsaved) throw new Error('当前任务有未提交评论，请先保存');
      const tracker = trackNativeRequests(manager);
      try {
        await loadNativeTask(manager, task);
        const { task: t, sample: stable } = await readWhileNativeReady(() => readySample(task), tracker, () => getTask(task));
        const { b, a } = stable;
        if (a.isReadOnly() || a.readonly || a.editable === false) throw new Error('默认标注只读，无法按原生流程清理');
        if (typeof a.serializeAnnotation !== 'function' || typeof a.pauseAutosave !== 'function') throw new Error('当前编辑器版本不支持所需操作');
        const result = stable.result; roots(result);
        const actorEmail = window.APP_SETTINGS?.user?.email || null;
        return { task, state: t.state, actorEmail, identity: { annotationId: a.pk ? Number(a.pk) : null, draftId: a.draftId > 0 ? Number(a.draftId) : null, parentPrediction: a.parent_prediction ?? null }, result, backend: backendSnapshot(t), source: a.draftId > 0 ? `草稿 #${a.draftId}` : a.pk ? `标注 #${a.pk}` : a.parent_prediction ? `预测预填 #${a.parent_prediction}` : '新标注', defaultRegions: b.currentAnnotation.regionStore.regions.length };
      } finally { tracker.close(); }
    },
    async clear(snapshot) {
      const { a } = nativeAnnotation(snapshot.task) || {};
      if (!a || !same(comparisonResult(a.serializeAnnotation()), comparisonResult(snapshot.result))) throw new Error('编辑器内容发生变化');
      const regionIds = new Set(roots(snapshot.result).map(r => r.id));
      const candidates = [...a.regionStore.regions];
      // Model ids carry an annotation suffix, e.g. regionId#annotationId.
      const selected = candidates.filter(r => regionIds.has(String(r.id).split('#')[0]));
      if (selected.length !== regionIds.size || selected.some(r => typeof r.deleteRegion !== 'function')) throw new Error('原生轨迹模型与序列化结果不匹配');
      a.pauseAutosave();
      for (const r of selected) r.deleteRegion();
      return clone(a.serializeAnnotation());
    },
    async submit(task) {
      const manager = dm();
      const { a } = nativeAnnotation(task) || {};
      if (!a) throw new Error('提交前编辑器未就绪');
      const buttons = [...document.querySelectorAll('button[aria-label="submit"]')].filter(b => b.getClientRects().length);
      if (buttons.length !== 1 || buttons[0].disabled) throw new Error('未找到唯一可用的原生提交按钮');
      const tracker = trackNativeRequests(manager);
      let submitted;
      try {
        submitted = await new Promise((resolve, reject) => {
          let finished = false;
          const cleanup = () => { clearTimeout(timer); manager.off('submitAnnotation', handler); manager.off('updateAnnotation', handler); };
          const handler = (...args) => {
            const r = args.at(-1);
            if (finished || !r?.id || (r.task && idOf(r.task) !== task)) return;
            if (r.$meta?.status >= 400 || r.error) return;
            finished = true; cleanup(); resolve({ id: Number(r.id) });
          };
          const timer = setTimeout(() => { if (!finished) { finished = true; cleanup(); reject(new Error('30 秒内未收到提交成功事件。请检查原生校验提示或网络；不要直接重复提交')); } }, 30000);
          manager.on('submitAnnotation', handler); manager.on('updateAnnotation', handler);
          try { buttons[0].click(); } catch (e) { finished = true; cleanup(); reject(e); }
        });
        // Success precedes the native reload and its history request. Wait before
        // the runner opens another task, even though the submission has succeeded.
        const { task: taskSnapshot } = await readWhileNativeReady(() => readySample(task), tracker, () => getTask(task));
        return { ...submitted, taskSnapshot };
      } catch (error) {
        if (submitted?.id) { error.annotationId = submitted.id; error.message = `已收到提交成功（标注 #${submitted.id}），但重新加载未完成：${error.message}。请先核对服务端结果，勿重复提交`; }
        throw error;
      } finally { tracker.close(); }
    },
    async verifySubmission(task, annotationId, expected, submitted) {
      await verifySubmittedResult(task, annotationId, expected, submitted, getTask);
    }
  };
  function download(value, kind) {
    const u = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json;charset=utf-8' }));
    const a = document.createElement('a'); a.href = u; a.download = `regions-${kind}-${project}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(u), 30000);
  }
  const stateNames = { CREATED: '待标注', ANNOTATED: '已提交', REVIEWED_REJECTED: '审核驳回', REVIEWED_ACCEPTED: '审核通过' };
  const stageNames = { checking: '核对中', cleaning: '清空中', submitting: '提交中', verifying_submission: '校验提交', done: '完成', skipped: '跳过', failed: '失败' };
  frame.onload = () => {
    const doc = frame.contentDocument; if (!doc?.getElementById('ids')) return;
    const $ = id => doc.getElementById(id);
    $('ids').value = new URLSearchParams(location.search).get('task') || '';
    const log = message => { $('log').textContent = message; };
    const inputIds = () => { try { return parseIds($('ids').value); } catch (_) { return []; } };
    function update() {
      const ids = inputIds();
      const done = state.journal.filter(o => o.stage === 'done').length;
      const skipped = state.journal.filter(o => o.stage === 'skipped').length;
      const failed = state.journal.filter(o => o.stage === 'failed').length;
      $('summary').textContent = state.taskIds.length
        ? `本次 ${state.taskIds.length} 个任务 · 完成 ${done} · 跳过 ${skipped} · 失败 ${failed} · 未开始 ${state.taskIds.length - state.journal.length}`
        : `已输入 ${ids.length} 个任务`;
      const reason = state.busy ? '正在处理已确认的任务；输入框的修改只用于下一次执行' : !ids.length ? '请输入任务 ID 或导入页面勾选' : '';
      $('run').disabled = state.busy || !ids.length;
      $('run').title = reason || `直接清空并提交 ${ids.length} 个任务`;
      $('runHint').textContent = reason || `已就绪：可直接清空并提交 ${ids.length} 个任务，无需预览`;
      $('readSelected').disabled = state.busy; $('current').disabled = state.busy;
      $('stop').disabled = !state.busy; $('journal').disabled = state.busy || !state.journal.length;
    }
    function render() {
      $('rows').replaceChildren();
      const outcomes = new Map(state.journal.map(o => [o.task, o]));
      const start = Math.max(0, state.journal.length - 200);
      // Bound table rendering for large batches; the downloaded journal retains all tasks.
      for (const task of state.taskIds.slice(start, start + 300)) {
        const outcome = outcomes.get(task), tr = doc.createElement('tr');
        const values = [`#${task}`, outcome?.source ? `${stateNames[outcome.state] || outcome.state} / ${outcome.source}` : '执行时读取',
          outcome?.regions == null ? '—' : String(outcome.regions),
          outcome ? `${stageNames[outcome.stage] || outcome.stage}${outcome.error ? '：' + outcome.error : ''}` : '未开始'];
        for (const value of values) { const td = doc.createElement('td'); td.textContent = value; tr.append(td); }
        $('rows').append(tr);
      }
      update();
    }
    async function busy(fn) {
      if (state.busy) return; state.busy = true; state.stopped = false; update();
      try { await fn(); } catch (e) { log(e.message); console.error('[Regions Workflow]', e); }
      finally { state.busy = false; update(); }
    }
    $('close').onclick = () => { frame.style.display = 'none'; };
    $('ids').oninput = update;
    $('readSelected').onclick = () => busy(async () => {
      const manager = dm(), view = manager.store.currentView;
      if (!view?.selected?.snapshot) throw new Error('请先在原列表勾选或全选任务');
      const input = $('ids').value;
      const scopeOf = () => ({ project: Number(manager.projectId || manager.store.project?.id), view: manager.store.currentView?.id, query: manager.store.currentView?.query, selection: manager.store.currentView?.selected?.snapshot });
      const scope = clone(scopeOf());
      log(scope.selection.all ? '正在分页导入当前筛选的全部任务…' : '正在导入页面勾选任务…');
      const ids = await resolveSelection(scope.selection, scope.query, project, params => manager.apiCall('tasks', params), {
        shouldStop: () => state.stopped,
        assertScope: () => {
          if (!same(scope, scopeOf())) throw new Error('导入期间项目、视图、筛选或勾选发生变化，请重新导入');
          if ($('ids').value !== input) throw new Error('导入期间输入框已修改，未覆盖输入，请重新导入');
        },
        report: (loaded, total, count) => log(`导入全选：已读取 ${loaded}/${total} 条，排除取消勾选后 ${count} 条`)
      });
      $('ids').value = ids.join(', '); update();
      log(`已导入${scope.selection.all ? '当前筛选的全选范围' : '页面勾选'} ${ids.length} 个任务。可直接点击“直接清空并提交”。`);
    });
    $('current').onclick = () => { const id = new URLSearchParams(location.search).get('task'); if (!id) return log('当前没有打开任务，请从原列表勾选或输入 ID。'); $('ids').value = id; update(); };
    $('run').onclick = () => busy(async () => {
      const ids = parseIds($('ids').value), route = location.href; dm();
      if (!confirm(`直接清空并提交项目 ${project} 的 ${ids.length} 个任务？\n脚本将逐条打开默认标注，清空 Regions 后原生提交，无需预览。\n视频级分类保留；当前无轨迹的任务跳过。\n请确认没有其他页面正在编辑这些任务。`)) { log('已取消，未读取任务、未清空、未提交。'); return; }
      if (location.href !== route || !same(ids, parseIds($('ids').value))) throw new Error('确认期间页面或任务 ID 发生变化，未开始清空，请重新执行');
      state.taskIds = ids.slice(); state.journal = []; render();
      state.journal = await runBatch(ids.map(task => ({ task })), adapter, (outcomes, message) => {
        state.journal = outcomes; log(message); render();
        // Keep the live progress lightweight. Save the full journal once this run settles.
      }, () => state.stopped);
      try { sessionStorage.setItem(`insta-regions-workflow-journal:${project}`, JSON.stringify({ project, outcomes: state.journal })); } catch (_) { /* File export remains available. */ }
      const failed = state.journal.find(o => o.stage === 'failed');
      const done = state.journal.filter(o => o.stage === 'done').length;
      const skipped = state.journal.filter(o => o.stage === 'skipped').length;
      if (!failed) log(`本批结束：完成 ${done} 个任务，跳过 ${skipped} 个，未开始 ${ids.length - state.journal.length} 个。${state.stopped ? '已按要求停止后续任务。' : ''}请刷新列表核对提交结果。`);
      render();
    });
    $('stop').onclick = () => { state.stopped = true; log('已请求停止。当前执行中的任务会完成清空与提交，之后不再进入下一任务。'); };
    $('journal').onclick = () => download({ format: 'insta360-regions-workflow-journal-v3', version: VERSION, project, exportedAt: new Date().toISOString(), outcomes: state.journal }, 'journal');
    update();
  };
  // Register the load handler before mounting the iframe so cached loads cannot skip setup.
  host.append(toggle, frame); document.documentElement.append(host);
})();
