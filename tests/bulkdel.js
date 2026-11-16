// 揀幾個 then 刪除, or 淨係留呢啲 (keep only the picked ones).
//
//   node tests/bulkdel.js        (needs a static server on :8799)
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
  // the app's own confirm box: answer yes
  await p.addInitScript(() => setInterval(() => { const y = document.querySelector('[role=alertdialog] [data-yes]'); if (y) y.click(); }, 50));
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
  const stops = sn => sn.days[1].items.filter(i => i.kind === 'stop').map(s => s.title);
  const before = stops(snap);

  await p.locator('#daymore').click(); await p.waitForTimeout(200); await p.locator('#selstart').click(); await p.waitForTimeout(300);
  await p.locator('[data-select="0"]').click(); await p.waitForTimeout(150);
  await p.locator('[data-select="2"]').click(); await p.waitForTimeout(150);
  await p.locator('#seldel').click(); await p.waitForTimeout(1500);
  const a = stops(last());
  ok('刪咗揀嗰兩個（景福宮、北村）', JSON.stringify(a) === JSON.stringify(['南山塔 韓牛燒肉']), a);
  ok('揀選模式完咗', await p.locator('.selectbar').count() === 0);

  await p.locator('#btn-undo').click(); await p.waitForTimeout(1500);
  await p.locator('#daymore').click(); await p.waitForTimeout(200); await p.locator('#selstart').click(); await p.waitForTimeout(300);
  await p.locator('[data-select="2"]').click(); await p.waitForTimeout(150);
  await p.locator('#selkeep').click(); await p.waitForTimeout(1500);
  ok('淨係留低揀咗嗰個', JSON.stringify(stops(last())) === JSON.stringify(['北村韓屋村']), stops(last()));
  ok('留低之後問要唔要 AI 再諗', /再諗過/.test(await p.locator('#sheet, .sheet, [role=dialog]').last().innerText().catch(() => '')));
  await p.locator('#rp-yes').click(); await p.waitForTimeout(400);
  ok('跟住開 AI 諗行程，有類型可以揀', await p.locator('[data-want]').count() >= 5);
  await p.locator('[data-want="行街購物"]').click();
  await p.locator('[data-want="夜景"]').click();
  ok('揀咗嘅類型入咗個格', await p.locator('#dayai-q').inputValue() === '行街購物、夜景', await p.locator('#dayai-q').inputValue());
  await p.locator('[data-want="行街購物"]').click();
  ok('再撳一次就拎走', await p.locator('#dayai-q').inputValue() === '夜景');
  await p.keyboard.press('Escape'); await p.waitForTimeout(300);
  await p.evaluate(() => { const c = document.querySelector('.sheet-close, [data-close], #sheet-close'); if (c) c.click(); });
  await p.waitForTimeout(300);

  // 清走成日 (at the top of the day)
  await p.locator('#btn-undo').click(); await p.waitForTimeout(1500);
  await p.locator('#daymore').click(); await p.waitForTimeout(200); await p.locator('#clearday').click(); await p.waitForTimeout(1500);
  ok('清走成日', last().days[1].items.filter(i => i.kind === 'stop' || i.kind === 'note').length === 0, last().days[1].items);
  ok('問要唔要重新諗', await p.locator('#rp-yes').count() === 1);
  ok('冇 JS error', !errs.length, errs);
  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
