from pathlib import Path
from playwright.sync_api import sync_playwright, expect
ROOT=Path(__file__).resolve().parents[1]
html=(ROOT.parent/'docs/demos/insta360-workbench.html').read_text()
# Accelerate only the request timeout and retry delay. Demo data still follows real cancellation.
inject=r'''
const originalFetch=window.fetch, originalTimer=window.setTimeout;
window.__pendingFailures=0; window.__pendingAttempts={}; window.__pendingActive=0; window.__pendingMax=0;
window.setTimeout=(fn,ms,...args)=>originalTimer(fn,ms>=30000&&ms<=60000?220:ms===800?10:ms,...args);
window.fetch=async function(input,options={}) {
 const u=new URL(String(input),'https://demo.local');
 const heavy=u.pathname==='/api/projects'&&(u.searchParams.get('include')||'').includes('user_repair_count');
 if(!heavy)return originalFetch(input,options);
 const key=u.searchParams.get('page')||'1';
 window.__pendingAttempts[key]=(window.__pendingAttempts[key]||0)+1;
 window.__pendingActive++;window.__pendingMax=Math.max(window.__pendingMax,window.__pendingActive);
 try {
  if(window.__pendingMode==='forbidden')return {ok:false,status:403,headers:{get:()=> 'application/json'}};
  if(key==='2'&&(window.__pendingMode==='always'||window.__pendingMode==='once'&&window.__pendingFailures++===0)) {
   return await new Promise((resolve,reject)=>{
    const stop=()=>reject(new DOMException('Aborted','AbortError'));
    if(options.signal.aborted)stop();else options.signal.addEventListener('abort',stop,{once:true});
   });
  }
  return await originalFetch(input,options);
 } finally {window.__pendingActive--;}
};
'''

def open_case(browser,mode):
 page=browser.new_page(viewport={'width':1440,'height':950})
 body=html.replace('// ==UserScript==',inject+f"\nwindow.__pendingMode={mode!r};\n// ==UserScript==",1)
 page.route('https://demo.local/**',lambda route:route.fulfill(content_type='text/html',body=body))
 page.goto('https://demo.local/')
 page.locator('#pending-section > summary').click()
 return page

with sync_playwright() as p:
 browser=p.chromium.launch(channel='chrome',headless=True)
 page=open_case(browser,'once')
 expect(page.locator('#query-state')).to_have_text('查询完成',timeout=6000)
 expect(page.locator('.pending-row')).to_have_count(5)
 assert page.evaluate('__pendingAttempts[2]')==2,'timed-out page must retry once'
 heavy=page.evaluate('__demoRequests.filter(r=>r.path==="/api/projects"&&r.params.include.includes("user_repair_count"))')
 assert all(int(r['params']['page_size'])<=10 for r in heavy)
 assert page.evaluate('__pendingMax')<=2
 print('PASS: transient timeout retries once; small batches and bounded concurrency',flush=True)
 page.close()
 page=open_case(browser,'always')
 expect(page.locator('#pending-data')).to_contain_text('超时',timeout=6000)
 expect(page.locator('#query-state')).to_have_text('部分数据未完成')
 expect(page.locator('.pending-row')).to_have_count(4)
 expect(page.locator('#pending-total')).to_contain_text('未完整')
 expect(page.locator('#stats-data tfoot')).to_contain_text('978')
 stats=page.evaluate('__demoRequests.filter(r=>r.path==="/api/statistics/overview").length')
 page.evaluate('window.__pendingMode="ok"')
 page.locator('[data-retry-pending]').click()
 expect(page.locator('#query-state')).to_have_text('查询完成',timeout=6000)
 expect(page.locator('.pending-row')).to_have_count(5)
 assert page.evaluate('__demoRequests.filter(r=>r.path==="/api/statistics/overview").length')==stats
 page.screenshot(path=str(ROOT/'preview/timeout-recovered.png'),full_page=True)
 print('PASS: persistent timeout keeps partial rows; section retry preserves personal output',flush=True)
 page.close()
 page=open_case(browser,'always')
 expect(page.locator('#stats-data tfoot')).to_contain_text('978')
 page.locator('#close').click()
 attempts=page.evaluate('JSON.stringify(__pendingAttempts)')
 page.wait_for_timeout(650)
 assert page.evaluate('JSON.stringify(__pendingAttempts)')==attempts
 expect(page.locator('#panel')).to_be_hidden()
 print('PASS: closing cancels pending requests without automatic retries or reopening',flush=True)
 page.close()
 page=open_case(browser,'forbidden')
 expect(page.locator('#pending-data')).to_contain_text('权限',timeout=6000)
 assert page.evaluate('__pendingAttempts[1]')==1
 print('PASS: permission errors are not retried',flush=True)
 page.close()
 page=open_case(browser,'always')
 expect(page.locator('#pending-data')).to_contain_text('超时',timeout=6000)
 page.evaluate('window.__demoScenario="account"; window.__pendingMode="ok"')
 page.locator('[data-retry-pending]').click()
 expect(page.locator('#error')).to_contain_text('账号已变化')
 expect(page.locator('.pending-row')).to_have_count(0)
 expect(page.locator('#export')).to_be_disabled()
 print('PASS: retry reconfirms account and removes prior-account data',flush=True)
 browser.close()
