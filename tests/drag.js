// Dragging a stop by its grip: the card lands where the finger lifts, even
// when the lift never reaches the grip (iPhone loses the capture when the
// page scrolls) and even if something redraws the page mid-drag.
//
//   node tests/drag.js        (needs a static server on :8799)
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
  const handle = p.locator('[data-drag]').first();
  const box = await handle.boundingBox();
  const target = await p.locator('.unit').last().boundingBox();
  // press on the grip and move, as a finger would
  await p.evaluate(({ x, y }) => {
    const h = document.querySelector('[data-drag]');
    h.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 7, pointerType: 'touch', isPrimary: true }));
  }, { x: box.x + 5, y: box.y + 5 });
  for (let k = 1; k <= 8; k++){
    await p.evaluate(({ x, y }) => document.querySelector('[data-drag]').dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 7, pointerType: 'touch' })),
      { x: box.x + 5, y: box.y + 5 + (target.y + target.height - box.y) * k / 8 });
    await p.waitForTimeout(30);
  }
  ok('拉緊嗰陣張卡浮起', await p.locator('.unit.lifted').count() === 1);
  // something finishes loading and wants to redraw mid-drag
  await p.evaluate(() => window.dispatchEvent(new Event('resize')));
  // the lift arrives on the page, not on the grip
  await p.evaluate(() => document.body.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'touch' })));
  await p.waitForTimeout(1500);
  ok('放手之後冇卡喺半空', await p.locator('.unit.lifted').count() === 0 && await p.evaluate(() => [...document.querySelectorAll('.unit')].every(u => !u.style.transform)));
  const after = stops(last() || snap);
  ok('搬咗去最尾', after[after.length - 1] === before[0] && after.length === before.length, after);
  ok('冇 JS error', !errs.length, errs);
  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
