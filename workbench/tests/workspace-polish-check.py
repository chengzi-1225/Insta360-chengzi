from pathlib import Path
from playwright.sync_api import sync_playwright, expect
ROOT=Path(__file__).resolve().parents[1]
html=(ROOT.parent/'docs/demos/insta360-workbench.html').read_text()
fixture='''const originalFetch=window.fetch;window.fetch=async function(input,init){let u=new URL(input,'https://demo.local');if(u.pathname==='/api/workspaces'){let rows=Array.from({length:70},(_,i)=>({id:109+i,title:i===0?'sg1-自由宽高比':i===1?'sg2-测试工作区':'全景视频标注工作区-'+(i+1)+'-长名称演示'}));return new Response(JSON.stringify({count:70,results:rows}),{status:200,headers:{'Content-Type':'application/json'}});}return originalFetch.apply(this,arguments);};'''
# Mock wrapper is installed immediately before the actual userscript.
html=html.replace('// ==UserScript==',fixture+'\n// ==UserScript==',1)
with sync_playwright() as p:
 b=p.chromium.launch(channel='chrome',headless=True)
 page=b.new_page(viewport={'width':1440,'height':900})
 errors=[]
 page.on('pageerror',lambda e:errors.append(str(e)))
 page.route('https://demo.local/**',lambda route:route.fulfill(body=html,content_type='text/html'))
 # A fresh page keeps the dedicated fixture isolated from previous script timers.
 page.goto('https://demo.local/workbench')
 expect(page.locator('#query-state')).to_have_text('查询完成')
 assert page.locator('#scope').evaluate('(e)=>e.tagName')=='SUMMARY'
 page.locator('#scope').click()
 expect(page.locator('[data-workspace-choice]')).to_have_count(71)
 box=page.locator('.workspace-choice-panel').bounding_box()
 assert box['height']<=390,box
 assert page.locator('#workspace-options').evaluate('(e)=>e.scrollHeight>e.clientHeight')
 stats=page.evaluate('__demoRequests.filter(r=>r.path==="/api/statistics/overview").length')
 page.screenshot(path=str(ROOT/'preview/polish-workspaces.png'),full_page=True)
 page.locator('#workspace-search').fill('测试工作区')
 expect(page.locator('[data-workspace-choice]')).to_have_count(2)
 assert page.evaluate('__demoRequests.filter(r=>r.path==="/api/statistics/overview").length')==stats
 page.keyboard.press('Escape')
 assert not page.locator('#workspace-picker').evaluate('(e)=>e.open')
 expect(page.locator('#panel')).to_be_visible()
 page.locator('#scope').click()
 page.locator('#workspace-search').fill('')
 page.keyboard.press('End')
 page.keyboard.press('Enter')
 expect(page.locator('#workspace-label')).to_contain_text('70')
 expect(page.locator('#query-help')).to_be_visible()
 page.locator('#reset-filters').click()
 page.locator('#scope').click()
 page.locator('#workspace-search').fill('测试工作区')
 page.locator('[data-workspace-choice="110"]').click()
 expect(page.locator('#workspace-label')).to_have_text('sg2-测试工作区')
 page.locator('#query').click()
 expect(page.locator('#result-count')).to_have_text('1 / 1 个项目')
 page.locator('#reset-filters').click()
 page.locator('#query').click()
 expect(page.locator('#result-count')).to_have_text('8 / 8 个项目')
 expect(page.locator('#query-state')).to_have_text('查询完成')
 assert page.locator('#scope').evaluate('(e)=>parseFloat(getComputedStyle(e).fontSize)')>=12
 assert page.locator('#scope').bounding_box()['height']>=34
 assert page.locator('.project-name').first.evaluate('(e)=>parseFloat(getComputedStyle(e).fontSize)')>=12
 for width in [320,390,640,1024,1440,1920]:
  page.set_viewport_size({'width':width,'height':900})
  if width<=640:page.wait_for_function('Math.abs(document.querySelector("#insta360-personal-toolbox").getBoundingClientRect().width-innerWidth)<2')
  page.locator('#scope').click()
  box=page.locator('.workspace-choice-panel').bounding_box()
  assert box['x']>=0 and box['x']+box['width']<=width+1,(width,box)
  page.keyboard.press('Escape')
  assert page.locator('#panel').evaluate('(e)=>e.scrollWidth<=e.clientWidth+1'),width
  if width==390:page.screenshot(path=str(ROOT/'preview/polish-mobile.png'),full_page=True)
 page.set_viewport_size({'width':1440,'height':900})
 page.screenshot(path=str(ROOT/'preview/polish-desktop.png'),full_page=True)
 page.locator('#scope').click()
 page.locator('#work-title').click()
 assert not page.locator('#workspace-picker').evaluate('(e)=>e.open')
 page.locator('#demo-scenario').select_option('slow')
 expect(page.locator('.loading-data')).to_be_visible()
 expect(page.locator('#metrics .metric-value strong').first).to_have_text('—')
 page.screenshot(path=str(ROOT/'preview/polish-loading.png'),full_page=True)
 expect(page.locator('#query-state')).to_have_text('查询完成',timeout=15000)
 # The directory can fail independently; retry must not requery personal output.
 retry_html=html.replace('const originalFetch=window.fetch;', 'let workspaceFailures=2;const originalFetch=window.fetch;').replace("if(u.pathname==='/api/workspaces'){", "if(u.pathname==='/api/workspaces'){if(workspaceFailures-->0)return new Response('{}',{status:503,headers:{'Content-Type':'application/json'}});")
 page.route('https://retry.local/**',lambda route:route.fulfill(body=retry_html,content_type='text/html'))
 page.goto('https://retry.local/workbench')
 expect(page.locator('#query-state')).to_have_text('查询完成')
 page.locator('#scope').click()
 expect(page.locator('[data-retry-workspaces]')).to_be_visible()
 stats=page.evaluate('__demoRequests.filter(r=>r.path==="/api/statistics/overview").length')
 page.locator('[data-retry-workspaces]').click()
 expect(page.locator('[data-workspace-choice]')).to_have_count(71)
 assert page.evaluate('__demoRequests.filter(r=>r.path==="/api/statistics/overview").length')==stats

 assert not errors,errors
 b.close()
print('PASS: bounded 70-workspace menu, local search, keyboard, selection, readable type and responsive layout')
