const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../../Insta360我的工作台.user.js');
const rows = [
  {id:7,project_id:101,project_title:'运动场景',stats:{submit_total:9,review_passed:8,review_rejected_total:2}},
  {id:7,project_id:102,project_title:'人物 FOV',stats:{submit_total:30,review_passed:0,review_rejected_total:0}},
  {id:7,project_id:103,project_title:'缺失字段',stats:{}},
  {id:8,project_id:104,project_title:'其他账号',stats:{submit_total:999}},
];
test('quick search finds a name or project ID and never mutates original rows', () => {
  assert.equal(typeof core.browseRows, 'function');
  const result=core.browseRows(core.selfRows(rows,7),' fov ','submit_total','desc');
  assert.deepEqual(result.map(r=>r.project_id),[102]);
  assert.deepEqual(core.browseRows(rows,'#101','project_title','asc').map(r=>r.project_id),[101]);
  assert.deepEqual(rows.map(r=>r.project_id),[101,102,103,104]);
});
test('numeric sort keeps missing values last in both directions and preserves zero', () => {
  assert.equal(typeof core.browseRows, 'function');
  assert.deepEqual(core.browseRows(rows.slice(0,3),'','submit_total','desc').map(r=>r.project_id),[102,101,103]);
  assert.deepEqual(core.browseRows(rows.slice(0,3),'','review_passed','asc').map(r=>r.project_id),[102,101,103]);
  assert.deepEqual(core.browseRows(rows.slice(0,3),'','accuracy','desc').map(r=>r.project_id),[101,102,103]);
});
test('CSV escapes commas, quotes, newlines and spreadsheet formula names', () => {
  assert.equal(typeof core.csvText,'function');
  assert.equal(core.csvText([['名称','值'],['=HYPERLINK("bad")',null],['a,b\nc',0]]),'\ufeff"名称","值"\r\n"\'=HYPERLINK(""bad"")",""\r\n"a,b\nc","0"');
});
test('existing identity, date boundaries and incomplete pagination safeguards remain', async () => {
  assert.deepEqual(core.selfRows(rows,7).map(r=>r.project_id),[101,102,103]);
  assert.throws(()=>core.identity({name:'测试'}),/账号/);
  assert.equal(core.statsParams(7,'annotator',109,'2026-11-12','2026-11-12').end_date,'2026-11-12 23:59:59');
  assert.equal(core.sumMetric([{stats:{submit_total:0}},{stats:{}}],'submit_total'),0);
  assert.equal(core.sumMetric([{stats:{}}],'submit_total'),null);
  assert.equal(core.accuracySummary(rows.slice(0,3)).value,80);
  await assert.rejects(core.loadPages(async()=>({count:3,results:[{id:1},{id:2}]}),'results',r=>String(r.id)),/重复/);
});

test('smaller pending batches can still cover the original project-count limit', async () => {
  let calls=0;
  const rows=await core.loadPages(async page=>{
    calls++;
    return {count:501,page_size:1,page,results:[{id:page}]};
  },'results',r=>String(r.id),{concurrency:2,maxPages:5000});
  assert.equal(rows.length,501);
  assert.equal(calls,501);
  assert.equal(rows.at(-1).id,501);
});
