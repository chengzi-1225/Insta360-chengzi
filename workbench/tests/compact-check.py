from pathlib import Path
import json
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'preview'
OUT.mkdir(exist_ok=True)
results = []
with sync_playwright() as p:
    browser = p.chromium.launch(channel='chrome', headless=True)
    page = browser.new_page(viewport={'width': 1440, 'height': 900})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto((ROOT.parent / 'docs/demos/insta360-workbench.html').as_uri())
    expect(page.locator('#query-state')).to_have_text('查询完成', timeout=10000)
    expect(page.locator('#metrics .metric')).to_have_count(4)
    expect(page.locator('.view-nav')).to_have_count(0)
    assert page.locator('#stats-data tbody tr').first.bounding_box()['y'] < 360
    assert not page.locator('.advanced').evaluate('(e)=>e.open')
    assert not page.locator('#pending-section').evaluate('(e)=>e.open')
    assert page.locator('#stats-data tbody tr').last.bounding_box()['y'] < 800
    page.screenshot(path=str(OUT / 'compact-desktop.png'), full_page=True)
    results.append('4 key metrics; no repeated navigation; all 8 projects visible at 1440 x 900')

    page.locator('.advanced summary').click()
    expect(page.locator('#scope')).to_be_visible()
    expect(page.locator('#field-options')).to_be_visible()
    expect(page.locator('#project-ids')).to_be_visible()
    page.keyboard.press('Escape')
    expect(page.locator('#panel')).to_be_visible()
    assert not page.locator('.advanced').evaluate('(e)=>e.open')
    page.locator('#pending-section > summary').click()
    expect(page.locator('#pending-data .pending-row')).to_have_count(5)
    page.locator('[data-work="repair"]').first.click()
    expect(page.locator('#demo-navigation')).to_be_visible()
    page.locator('#demo-navigation button').click()
    page.locator('#pending-section > summary').click()
    results.append('less-used settings and pending work remain accessible; Escape only closes settings')

    page.locator('#quick-search').fill('#103')
    expect(page.locator('#stats-data tbody tr')).to_have_count(1)
    expect(page.locator('#metrics .metric').first).to_contain_text('148', timeout=2000)
    page.locator('#clear-quick').click()
    for width in [1920, 1440, 1024, 768, 640, 390, 320]:
        page.set_viewport_size({'width': width, 'height': 900 if width > 640 else 844})
        page.locator('#panel .scroll').evaluate('(e)=>e.scrollTop=0')
        data = page.evaluate('''()=>{
          const r=document.querySelector('#insta360-personal-toolbox').shadowRoot;
          const s=r.querySelector('.scroll');
          return {width:s.clientWidth, scroll:s.scrollWidth, first:r.querySelector('tbody tr').getBoundingClientRect().top};
        }''')
        assert data['scroll'] <= data['width'] + 1, (width, data)
        assert data['first'] < (600 if width <= 640 else 430), (width, data)
        for key in ['start', 'end']:
            date_box = page.locator('#' + key).bounding_box()
            assert date_box['width'] >= 85, (width, key, date_box)
        page.locator('.advanced summary').click()
        box = page.locator('.advanced-body').bounding_box()
        assert box['x'] >= 0 and box['x'] + box['width'] <= width + 1, (width, box)
        page.keyboard.press('Escape')
        if width == 390:
            page.screenshot(path=str(OUT / 'compact-mobile.png'), full_page=True)
    results.append('320–1920px layouts keep data near the top and settings inside the viewport')
    assert not errors, errors
    browser.close()
(OUT / 'compact-validation.json').write_text(json.dumps({'passed': results, 'errors': errors}, ensure_ascii=False, indent=2))
for result in results:
    print('PASS:', result)
