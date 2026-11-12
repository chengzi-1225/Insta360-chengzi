from pathlib import Path
from playwright.sync_api import sync_playwright, expect
ROOT=Path(__file__).resolve().parents[1]
source=(ROOT.parent/'Insta360我的工作台.user.js').read_text()
html=(ROOT/'demo.template.html').read_text().replace('/*__WORKBENCH_SCRIPT__*/',source.replace('</script','<\\/script'))
errors=[]
with sync_playwright() as p:
    b=p.chromium.launch(channel='chrome',headless=True)
    page=b.new_page(viewport={'width':1440,'height':980})
    page.on('pageerror',lambda e:errors.append(str(e)))
    # 用交付脚本原文验证真实站点路由与同源请求；页面及接口都由本地测试数据提供。
    page.route('https://label.insta360.com/**',lambda route:route.fulfill(status=200,content_type='text/html',body=html))
    for route,role in [('annotation','我的标注'),('review','我的审核')]:
        page.goto('https://label.insta360.com/'+route+'/workspaces/109#insta360-personal')
        expect(page.locator('#query-state')).to_have_text('查询完成',timeout=10000)
        expect(page.locator('#work-title')).to_have_text(role)
        expect(page.locator('#result-count')).to_have_text('8 / 8 个项目')
        params=page.evaluate('__demoRequests.find(r=>r.path==="/api/statistics/overview").params')
        assert params['user_id']=='7' and params['workspace_id']=='109'
        assert params['role']==('reviewer' if route=='review' else 'annotator')
        page.locator('#quick-search').fill('#101')
        expect(page.locator('#stats-data tbody tr')).to_have_count(1)
    page.goto((ROOT.parent/'docs/demos/insta360-workbench.html').as_uri())
    expect(page.locator('#query-state')).to_have_text('查询完成',timeout=10000)
    page.set_viewport_size({'width':390,'height':844})
    assert page.evaluate('document.documentElement.scrollHeight')==844
    page.screenshot(path=str(ROOT/'preview/mobile.png'),full_page=True)
    assert not errors,errors
    b.close()
print('PASS: unchanged production userscript works on both real route shapes with scoped simulated requests')
print('PASS: standalone mobile page fits exactly in its viewport')
