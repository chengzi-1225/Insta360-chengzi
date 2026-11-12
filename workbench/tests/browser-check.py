from pathlib import Path
import csv, io, json
from playwright.sync_api import sync_playwright, expect
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'preview'
OUT.mkdir(exist_ok=True)
checks=[]
errors=[]

def check(name):
    checks.append(name)
    print('PASS:',name,flush=True)

def ready(page,count=None):
    expect(page.locator('#query-state')).to_have_text('查询完成',timeout=15000)
    if count is not None: expect(page.locator('#result-count')).to_have_text(f'{count} / {count} 个项目')

def scenario(page,value,count=None):
    page.locator('#demo-scenario').select_option(value)
    ready(page,count)

with sync_playwright() as p:
    browser=p.chromium.launch(channel='chrome',headless=True)
    page=browser.new_page(viewport={'width':1440,'height':1050},device_scale_factor=1,accept_downloads=True)
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.goto((ROOT.parent/'docs/demos/insta360-workbench.html').as_uri())
    ready(page,8)
    expect(page.locator('#stats-data')).not_to_contain_text('999999')
    expect(page.locator('#stats-data tfoot')).to_contain_text('978')
    check('self-contained file opens, queries all pages, excludes other accounts, totals match')

    calls=page.evaluate('window.__demoRequests.length')
    page.locator('#quick-search').fill('#103')
    expect(page.locator('#result-count')).to_have_text('1 / 8 个项目 · 搜索结果')
    expect(page.locator('#stats-data tfoot')).to_contain_text('148')
    expect(page.locator('#metrics .metric').first).to_contain_text('148',timeout=2000)
    expect(page.locator('#stats-data tbody tr')).to_have_count(1)
    page.locator('#clear-quick').click()
    page.locator('[data-sort="submit_total"]').click()
    expect(page.locator('#stats-data tbody tr').first).to_contain_text('#108')
    page.locator('[data-sort="submit_total"]').click()
    expect(page.locator('#stats-data tbody tr').first).to_contain_text('#101')
    assert page.evaluate('window.__demoRequests.length')==calls
    check('name/ID quick search, overview totals and numeric sorting use no new requests')

    page.locator('#quick-search').fill('运动')
    with page.expect_download() as dl:
        page.locator('#export').click()
    download=dl.value
    target=OUT/'filtered-export.csv'
    download.save_as(target)
    data=list(csv.reader(io.StringIO(target.read_text(encoding='utf-8-sig'))))
    idx=next(i for i,r in enumerate(data) if r[0]=='项目 ID')
    assert len(data[idx+1:])==2
    assert {r[0] for r in data[idx+1:]}=={'102','107'}
    assert data[1][1]=='橙子'
    page.locator('#clear-quick').click()
    check('CSV contains only matching personal projects and includes query/account context')

    scenario(page,'many',36)
    expect(page.locator('#stats-data tbody tr')).to_have_count(10)
    expect(page.locator('#page-info')).to_have_text('第 1 / 4 页')
    total=page.locator('#stats-data tfoot').inner_text()
    page.locator('#next-page').click()
    expect(page.locator('#page-info')).to_have_text('第 2 / 4 页')
    assert page.locator('#stats-data tfoot').inner_text()==total
    page.locator('#page-size').select_option('20')
    expect(page.locator('#stats-data tbody tr')).to_have_count(20)
    expect(page.locator('#page-info')).to_have_text('第 1 / 2 页')
    with page.expect_download() as dl:
        page.locator('#export').click()
    all_data=list(csv.reader(io.StringIO(Path(dl.value.path()).read_text(encoding='utf-8-sig'))))
    idx=next(i for i,r in enumerate(all_data) if r[0]=='项目 ID')
    assert len(all_data[idx+1:])==36
    check('pagination, page size and all-matches export remain correct with 36 projects')

    scenario(page,'sparse',8)
    expect(page.locator('#stats-data tbody tr').last.locator('td').nth(1)).to_have_text('—')
    expect(page.locator('#metrics')).to_contain_text('项目有值')
    page.locator('[data-sort="submit_total"]').click()
    expect(page.locator('#stats-data tbody tr').last.locator('td').nth(1)).to_have_text('—')
    page.screenshot(path=str(OUT/'missing-fields.png'),full_page=True)
    check('missing values remain distinct from zero and stay last in both sort directions')

    scenario(page,'zero',8)
    expect(page.locator('#stats-data tbody tr').first.locator('td').nth(1)).to_have_text('0')
    expect(page.locator('#stats-data tfoot')).to_contain_text('—')
    check('real zeros display as zero; undefined accuracy displays a dash')

    scenario(page,'empty',0)
    expect(page.locator('#stats-data')).to_contain_text('暂无个人记录')
    expect(page.locator('#export')).to_be_disabled()
    page.locator('#demo-scenario').select_option('error')
    expect(page.locator('#stats-data')).to_contain_text('HTTP 503',timeout=10000)
    expect(page.locator('#export')).to_be_disabled()
    check('empty and failed queries do not show old totals or enable export')

    scenario(page,'normal',8)
    page.locator('.advanced summary').click()
    page.locator('#project-ids').fill('101,103')
    page.locator('#query').click()
    ready(page,2)
    expect(page.locator('#stats-data')).not_to_contain_text('#102')
    page.locator('#search').fill('不存在的项目')
    expect(page.locator('#result-count')).to_have_text('2 / 2 个项目')
    page.locator('#search').fill('')
    page.locator('#project-ids').fill('bad')
    page.locator('#query').click()
    expect(page.locator('#error')).to_contain_text('项目 ID 只能填写数字')
    page.locator('#project-ids').fill('')
    page.locator('#search').fill('人物')
    ready_caption=page.locator('#result-count').inner_text()
    assert ready_caption=='尚未查询'  # invalid ID query above already cleared results
    page.locator('#query').click()
    ready(page,2)
    assert all('人物' in s for s in page.locator('#stats-data .project-name').all_inner_texts())
    page.locator('#search').fill('')
    page.locator('#query').click()
    ready(page,8)
    page.locator('#start').fill('2026-11-13')
    page.locator('#end').fill('2026-11-12')
    page.locator('#query').click()
    expect(page.locator('#error')).to_contain_text('日期')
    page.locator('[data-preset="week"]').click()
    page.locator('#query').click()
    ready(page,8)
    requests=page.evaluate('window.__demoRequests.filter(x=>x.path==="/api/statistics/overview").at(-1).params')
    assert requests['start_date'].endswith('00:00:00') and requests['end_date'].endswith('23:59:59')
    check('server project ID/name scopes and calendar boundaries validate correctly')

    page.locator('#field-all').click()
    expect(page.locator('#project-reference')).to_be_visible()
    page.locator('#query').click()
    ready(page,8)
    expect(page.locator('#project-metrics')).to_contain_text('877,680',timeout=10000)
    page.locator('#field-none').click()
    expect(page.locator('#export')).to_be_disabled()
    page.locator('#field-default').click()
    expect(page.locator('#export')).to_be_enabled()
    page.locator('.advanced summary').click()
    check('column selection, full-member regions reference and default restore work')

    page.locator('[data-pending-mode="repair"]').click()
    assert page.locator('.pending-row').count()==3
    page.locator('[data-work="repair"]').first.click()
    expect(page.locator('#demo-navigation')).to_be_visible()
    expect(page.locator('#demo-target')).to_contain_text('repair=1')
    page.locator('#demo-navigation button').click()
    page.locator('[data-pending-mode="all"]').click()
    check('pending-type filters and native repair route work')

    page.locator('[data-demo-role="reviewer"]').click()
    ready(page,8)
    expect(page.locator('#work-title')).to_have_text('我的审核')
    expect(page.locator('#pending-section')).to_be_hidden()
    expect(page.locator('[data-sort="review_total"]')).to_be_visible()
    page.locator('[data-demo-role="annotator"]').click()
    ready(page,8)
    check('annotation/review switching resets browsing state and displays the right metrics')

    page.locator('#demo-scenario').select_option('slow')
    expect(page.locator('#query-state')).to_have_text('正在读取数据')
    expect(page.locator('#export')).to_be_disabled()
    page.locator('#demo-scenario').select_option('normal')
    ready(page,8)
    page.wait_for_timeout(1500)
    expect(page.locator('#result-count')).to_have_text('8 / 8 个项目')
    scenario(page,'account',0)
    expect(page.locator('#account')).to_contain_text('测试账号 B')
    expect(page.locator('#stats-data')).not_to_contain_text('固定 FOV')
    scenario(page,'normal',8)
    check('in-flight queries cancel safely and switching account clears previous personal data')

    page.locator('#close').click()
    expect(page.locator('#panel')).to_be_hidden()
    page.locator('[data-insta360-personal-menu="annotator"] a').click()
    expect(page.locator('#panel')).to_be_visible()
    page.locator('#panel .scroll').evaluate('(e)=>e.scrollTop=0')
    page.screenshot(path=str(OUT/'desktop.png'),full_page=True)
    page.locator('[data-jump="details"]').click()
    page.wait_for_timeout(500)
    page.screenshot(path=str(OUT/'project-comparison.png'),full_page=True)
    check('close/reopen and section shortcuts work')

    for width in [1024,768,640,390,320]:
        page.set_viewport_size({'width':width,'height':844})
        page.locator('#panel .scroll').evaluate('(e)=>e.scrollTop=0')
        page.wait_for_timeout(100)
        result=page.evaluate('''()=>{const r=document.querySelector('#insta360-personal-toolbox').shadowRoot;const s=r.querySelector('.scroll');return {w:s.clientWidth,sw:s.scrollWidth,host:document.querySelector('#insta360-personal-toolbox').getBoundingClientRect().toJSON()}}''')
        assert result['sw']<=result['w']+1,(width,result)
        if width==390:page.screenshot(path=str(OUT/'mobile.png'),full_page=True)
    check('320–1440px layouts fit the viewport; wide tables scroll inside their own container')
    assert not errors,errors
    check('no JavaScript errors in all test scenarios')
    browser.close()
(OUT/'验证记录.json').write_text(json.dumps({'passed':checks,'errors':errors},ensure_ascii=False,indent=2))
print(f'{len(checks)} checks passed')
