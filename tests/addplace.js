// An AI note that recommends places ("永觀堂（京都）：紅葉之王…") gets a
// 「加去行程」 button per place; advice lines (transport, clothing) don't.
// Picking a day puts the place at the end of that day, matched on Google.
//
//   node tests/addplace.js        (needs a static server on :8799)
const { chromium } = require('playwright');
const { snap } = require('./fixture.js');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c){ pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : '')); } };

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await b.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 1000 } });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  const cur = JSON.parse(JSON.stringify(snap));
  cur.sections = [{ id: 'k1', icon: '', title: '去邊睇紅葉好', sub: '', source: 'ai', topic: '去邊睇紅葉好', aiRefresh: true, where: 'prep', links: [],
    lines: ['永觀堂（京都）：紅葉之王，12月初去睇尾聲', '景福宮：秋天銀杏好靚', '交通安排：大阪去京都搭京阪電車'] }];
  const saved = [];
  await p.route('**/rest/v1/itinerary_versions**', r => {
    if (r.request().method() === 'POST'){ try { saved.push(JSON.parse(r.request().postData())); } catch (_){}
      return r.fulfill({ status: 201, contentType: 'application/json', body: '[]' }); }
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 1, created_at: '2026-09-20T00:00:00Z',
      edited_by: 'x', source: 'seed', summary: 's', snapshot: cur, has_snapshot: true }]) });
  });
  await p.route('**/rest/v1/ai_notes**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await p.route('**/functions/v1/**', r => {
    const body = JSON.parse(r.request().postData() || '{}');
    if (body.action === 'place-search') return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ places: [{ name: body.query, placeId: 'pid-eikando', lat: 35.01, lng: 135.79 }] }) });
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await p.route('**tile**', r => r.abort());
  await p.goto('http://localhost:8799/trip.html?trip=1', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1200);
  await p.locator('[data-fold="prep"]').click();
  await p.waitForTimeout(400);

  const block = p.locator('.usec').filter({ hasText: '去邊睇紅葉好' });
  ok('地點有「加去行程」', await block.locator('[data-addplace]').count() === 1, await block.locator('[data-addplace]').count());
  ok('已經喺行程嘅地點講明喺邊日', /已喺 D2/.test(await block.innerText()));
  ok('交通建議冇呢粒掣', await block.locator('li', { hasText: '交通安排' }).locator('[data-addplace]').count() === 0);

  await block.locator('[data-addplace]').click();
  await p.waitForTimeout(300);
  ok('揀日子', await p.locator('[data-addto]').count() === cur.days.length);
  await p.locator('[data-addto="day3"]').click();
  await p.waitForTimeout(2500);
  const last = [...saved].reverse().find(x => x.snapshot);
  const d3 = last ? last.snapshot.days.find(d => d.id === 'day3') : null;
  const st = d3 && d3.items.filter(i => i.kind === 'stop').pop();
  ok('加咗喺 Day 3 最尾', st && st.title === '永觀堂', st && st.title);
  ok('去掉括號、描述跟埋', st && /紅葉之王/.test(st.desc || ''));
  ok('配咗 Google 地點', st && st.placeId === 'pid-eikando', st && st.placeId);
  ok('冇 JS 錯誤', errs.length === 0, errs);
  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
