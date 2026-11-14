// An AI day-plan suggestion that swaps one place for another is offered as
// an addition first (the old place stays); replacing it is a separate choice.
//
//   node tests/aiswap.js        (needs a static server on :8799)
const { chromium } = require('playwright');
const { snap } = require('./fixture.js');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c){ pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : '')); } };

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const p = await (await b.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 900 } })).newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  const saved = [];
  const stops = sn => sn.days[1].items.filter(i => i.kind !== 'connector' && i.kind !== 'note' && i.title).map(s => s.title);
  const orig = stops(snap);
  await p.route('**/rest/v1/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await p.route('**/rest/v1/itinerary_versions**', r => {
    if (r.request().method() === 'POST'){ try { saved.push(JSON.parse(r.request().postData())); } catch (_){}
      return r.fulfill({ status: 201, contentType: 'application/json', body: '[]' }); }
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 1, created_at: '2026-09-20T00:00:00Z',
      edited_by: 'x', source: 'seed', summary: 's', snapshot: snap, has_snapshot: true }]) });
  });
  await p.route('**/functions/v1/**', r => {
    let body = {}; try { body = JSON.parse(r.request().postData() || '{}'); } catch (_){}
    if (body.action === 'day-plan') return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, notes: '換晚餐',
      changes: [
        { op: 'edit', dayId: 'day2', matchTitle: orig[1], stop: { title: '新餐廳甲', time: '約 18:00', type: 'eat' }, reason: '試新嘢' },
        { op: 'edit', dayId: 'day2', matchTitle: orig[2], stop: { title: '新景點乙', time: '約 19:30' }, reason: '順路' },
      ] }) });
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await p.route('**tile**', r => r.abort());
  await p.goto('http://localhost:8799/trip.html?trip=1', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1200);
  await p.evaluate(() => document.querySelector('[data-go="day2"]').click());
  await p.waitForTimeout(1000);
  const last = () => { const x = [...saved].reverse().find(v => v.snapshot); return x && x.snapshot; };

  await p.locator('#dayai').click();
  await p.waitForTimeout(300);
  await p.locator('#dayai-go').click();
  await p.waitForTimeout(1200);
  const card = p.locator('.ai-change').first();
  ok('換地點嘅建議有「加落去」同「取代」兩個掣', await card.locator('[data-mode="add"]').count() === 1 && await card.locator('[data-mode="replace"]').count() === 1);
  ok('取代掣寫明換走邊個', (await card.locator('[data-mode="replace"]').innerText()).includes(orig[1].replace(/\s.*$/, '').slice(0, 2)));

  await card.locator('[data-mode="add"]').click();
  await p.waitForTimeout(1500);
  let t = stops(last());
  ok('加落去：原本嘅地點仲喺度', t.includes(orig[1]) && t.includes('新餐廳甲'), t);
  ok('加落去之後取代掣收埋', await card.locator('[data-mode="replace"]').isHidden());

  const card2 = p.locator('.ai-change').nth(1);
  await card2.locator('[data-mode="replace"]').click();
  await p.waitForTimeout(1500);
  t = stops(last());
  ok('取代：舊地點冇咗、新地點喺度', !t.includes(orig[2]) && t.includes('新景點乙'), t);
  ok('冇 JS error', !errs.length, errs);
  await b.close();
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
