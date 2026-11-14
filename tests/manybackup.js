// Several stops made backups of one stop at once — from the 「…」 menu of
// that stop, or from 揀幾個 then 做後備.
//
//   node tests/manybackup.js        (needs a static server on :8799)
const { chromium } = require('playwright');
const { snap } = require('./fixture.js');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c){ pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : '')); } };

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const p = await (await b.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 900 } })).newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  p.on('dialog', d => d.accept());
  const saved = [];
  await p.route('**/rest/v1/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await p.route('**/rest/v1/itinerary_versions**', r => {
    if (r.request().method() === 'POST'){ try { saved.push(JSON.parse(r.request().postData())); } catch (_){}
      return r.fulfill({ status: 201, contentType: 'application/json', body: '[]' }); }
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 1, created_at: '2026-09-20T00:00:00Z',
      edited_by: 'x', source: 'seed', summary: 's', snapshot: snap, has_snapshot: true }]) });
  });
  await p.route('**/functions/v1/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
  await p.route('**tile**', r => r.abort());
  await p.goto('http://localhost:8799/trip.html?trip=1', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1200);
  await p.evaluate(() => document.querySelector('[data-go="day2"]').click());
  await p.waitForTimeout(1200);
  const last = () => { const x = [...saved].reverse().find(v => v.snapshot); return x && x.snapshot; };
  const stops = sn => sn.days[1].items.filter(i => i.kind !== 'connector' && i.kind !== 'note' && i.title).map(s => s.title);
  const alts = sn => sn.days[1].items.filter(i => i.kind === 'stop').map(i => [i.title, (i.alts || []).map(a => a.title)]);
  // from the menu of 景福宮: pick 北村 and 南山塔
  await p.locator('[data-stopmenu]').first().click();
  await p.waitForTimeout(300);
  ok('選單有「揀幾個地點一齊做後備」', await p.locator('#stopmany').count() === 1);
  await p.locator('#stopmany').click();
  await p.waitForTimeout(300);
  ok('進入揀選模式，講明係邊個嘅後備', /景福宮.*後備/.test(await p.locator('.selectbar').innerText()));
  await p.locator('[data-select="2"]').click(); await p.waitForTimeout(150);
  await p.locator('[data-select="3"]').click(); await p.waitForTimeout(150);
  ok('已選 2 個', /已選 2 個/.test(await p.locator('.selectbar').innerText()));
  await p.locator('#selbackup').click();
  await p.waitForTimeout(1500);
  ok('兩個一齊摺咗做景福宮後備', JSON.stringify(alts(last())) === JSON.stringify([['景福宮', ['北村韓屋村', '南山塔 韓牛燒肉']]]), alts(last()));
  ok('一次存晒', saved.filter(v => v.snapshot).length === 1, saved.length);
  ok('揀選模式完咗', await p.locator('.selectbar').count() === 0);

  // the other way: 揀幾個 → 做後備 → choose the stop
  await p.locator('#btn-undo').click();
  await p.waitForTimeout(1500);
  await p.locator('#selstart').click(); await p.waitForTimeout(300);
  await p.locator('[data-select="0"]').click(); await p.waitForTimeout(150);
  await p.locator('[data-select="2"]').click(); await p.waitForTimeout(150);
  await p.locator('#selbackup').click(); await p.waitForTimeout(300);
  await p.locator('.foldopt', { hasText: '南山塔' }).click();
  await p.waitForTimeout(1500);
  ok('揀咗幾個再揀主站都得', JSON.stringify(alts(last())) === JSON.stringify([['南山塔 韓牛燒肉', ['景福宮', '北村韓屋村']]]), alts(last()));
  ok('冇 JS error', !errs.length, errs);
  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
