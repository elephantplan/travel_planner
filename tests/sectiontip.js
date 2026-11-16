// A tip in an AI section (「12月北海道限定攻略」): one that names a place on
// the plan says which day and goes there; one that names another place can
// be added; one that only mentions a place somewhere asks which; and plain
// advice gets no button.
//
//   node tests/sectiontip.js        (needs a static server on :8799)
const { chromium } = require('playwright');
const { snap } = require('./fixture.js');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c){ pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : '')); } };

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const p = await (await b.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 1000 } })).newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  const cur = JSON.parse(JSON.stringify(snap));
  cur.sections = [{ icon: '', title: '12月限定攻略', sub: '', source: 'ai', topic: '12月限定攻略', aiRefresh: false, links: [], lines: [
    '景福宮夜間開放好靚，記得早啲去。',
    '❄️ 南大門市場夜晚好熱鬧，可以食小食。',
    '12月當造必食鱈場蟹，二條市場或三角市場買。',
    '記得帶暖包同頸巾。'] }];
  await p.route('**/rest/v1/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await p.route('**/rest/v1/itinerary_versions**', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 1,
    created_at: '2026-09-20T00:00:00Z', edited_by: 'x', source: 'seed', summary: 's', snapshot: cur, has_snapshot: true }]) }));
  await p.route('**/functions/v1/**', r => {
    const body = JSON.parse(r.request().postData() || '{}');
    // 南大門市場 sits right by 景福宮 here, so the best spot is after it on Day 2
    if (body.action === 'place-search' || body.mode === 'near-search') return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, places: [{ name: '南大門市場', placeId: 'nm', lat: 37.5797, lng: 126.9772, rating: 4.2, ratingCount: 900 }] }) });
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await p.route('**tile**', r => r.abort());
  await p.goto('http://localhost:8799/trip.html?trip=1', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1200);
  const li = k => p.locator('li', { hasText: cur.sections[0].lines[k].replace(/^\S+ /, '').slice(0, 6) }).first();
  ok('喺行程入面嘅講明邊日', /已喺 D2/.test(await li(0).innerText()), await li(0).innerText());
  ok('未喺行程嘅有「加去行程」', await li(1).locator('[data-addplace]').count() === 1);
  await li(1).locator('[data-addplace]').click(); await p.waitForTimeout(300);
  await p.waitForTimeout(1200);
  const picked = async () => (await p.locator('.ap-spots .foldopt.on').innerText().catch(() => '')).replace(/\s+/g, ' ');
  ok('揀咗建議嘅位置（唔係最尾）', /景福宮」之後/.test(await picked()), await picked());
  await p.locator('[data-apday="day2"]').click(); await p.waitForTimeout(200);
  ok('再撳同一日，位置唔會變返最尾', /景福宮」之後/.test(await picked()), await picked());
  await p.locator('[data-apday="day1"]').click(); await p.waitForTimeout(200);
  ok('揀第二日：放喺離佢最近嗰個站之後', /明洞/.test(await picked()), await picked());
  ok('開頭有 emoji 都認得出地方，唔使再問', /將「南大門市場」加去邊度/.test(await p.locator('.sheet').innerText()) && await p.locator('#tipname').count() === 0);
  await p.evaluate(() => { const c = document.querySelector('.sheet-close'); if (c) c.click(); }); await p.waitForTimeout(200);
  ok('中間先提到地方都有「加去行程」', await li(2).locator('[data-addplace]').count() === 1);
  ok('純粹提醒冇掣', await li(3).locator('[data-addplace], [data-inday-go]').count() === 0);
  await li(2).locator('[data-addplace]').click(); await p.waitForTimeout(300);
  ok('講唔清係邊度就問', await p.locator('#tipname').count() === 1);
  await p.fill('#tipname', '二條市場'); await p.locator('#tipgo').click(); await p.waitForTimeout(400);
  ok('跟住揀日子同位置', /將「二條市場」加去邊度/.test(await p.locator('.sheet').innerText()));
  await p.evaluate(() => { const c = document.querySelector('.sheet-close'); if (c) c.click(); });
  await li(0).locator('[data-inday-go]').click(); await p.waitForTimeout(500);
  ok('撳「已喺 D2」去嗰日', /古宮/.test(await p.locator('.dayhead h2').innerText().catch(() => '')));
  ok('冇 JS error', !errs.length, errs);
  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
