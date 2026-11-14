// 「上一步」: one tap (or ⌘Z) puts the trip back the way it was before the
// last change, and saves that as a new version.
//
//   node tests/undo.js        (needs a static server on :8799)
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
  const before = stops(snap);
  ok('未改過嘢就冇「上一步」', await p.locator('#btn-undo').isHidden());
  await p.locator('[data-stopmenu]').first().click();
  await p.waitForTimeout(300);
  await p.locator('#stopdel').click();
  await p.waitForTimeout(1500);
  ok('刪咗一個站', stops(last()).length === before.length - 1, stops(last()));
  ok('改完就出「上一步」', await p.locator('#btn-undo').isVisible());
  await p.locator('#btn-undo').click();
  await p.waitForTimeout(1500);
  ok('撳「上一步」就返晒嚟，仲存埋', JSON.stringify(stops(last())) === JSON.stringify(before), stops(last()));
  ok('存低嘅說明寫住返上一步', /返上一步/.test(saved[saved.length - 1].summary || ''), saved[saved.length - 1].summary);
  ok('畫面都返晒嚟', await p.locator('[data-stopmenu]').count() === before.length);
  ok('冇得再返就收埋', await p.locator('#btn-undo').isHidden());
  // ⌘Z on a computer
  await p.locator('[data-stopmenu]').first().click();
  await p.waitForTimeout(300);
  await p.locator('#stopdel').click();
  await p.waitForTimeout(1500);
  await p.keyboard.press('Control+z');
  await p.waitForTimeout(1500);
  ok('Ctrl+Z 都得', JSON.stringify(stops(last())) === JSON.stringify(before), stops(last()));
  ok('冇 JS error', !errs.length, errs);
  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
