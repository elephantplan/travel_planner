// 排順路: a day that zigzags gets a button that reorders it by distance
// (first and last stay), with the times given to the new order; and a
// stop that is only a shopping area offers the malls and shops there.
//
//   node tests/reorder.js        (needs a static server on :8799)
const { chromium } = require('playwright');
const { snap: base } = require('./fixture.js');
const snap = JSON.parse(JSON.stringify(base));
const mk = (t, lat, lng, time) => ({ kind: 'stop', type: 'normal', title: t, kr: '', time, lat, lng, placeId: 'p' + t });
snap.days[1].items = [mk('A', 37.50, 127.00, '約 09:00'), { kind: 'connector', html: '' }, mk('C', 37.60, 127.00, '約 11:00'), { kind: 'connector', html: '' },
  mk('B', 37.55, 127.00, '約 13:00'), { kind: 'connector', html: '' }, mk('D', 37.65, 127.00, '約 15:00'), { kind: 'connector', html: '' },
  Object.assign(mk('澀谷購物', 37.70, 127.00, '約 17:00'), { placeId: '' })];
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
  const fn = [];
  await p.route('**/functions/v1/**', r => { try { fn.push(JSON.parse(r.request().postData() || '{}')); } catch (_){} r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }); });
  await p.route('**tile**', r => r.abort());
  await p.goto('http://localhost:8799/trip.html?trip=1', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1200);
  await p.evaluate(() => document.querySelector('[data-go="day2"]').click());
  await p.waitForTimeout(1200);
  const last = () => { const x = [...saved].reverse().find(v => v.snapshot); return x && x.snapshot; };
  const stops = sn => sn.days[1].items.filter(i => i.kind !== 'connector' && i.kind !== 'note' && i.title).map(s => s.title);
  ok('唔順路嘅日子有「按距離排順路」', await p.locator('#reorder').count() === 1, await p.locator('.toollist').innerText().catch(() => ''));
  ok('購物區有「推介呢度嘅商場」', await p.locator('[data-shophere]').count() === 1);
  await p.locator('#reorder').click(); await p.waitForTimeout(300);
  await p.locator('#reord-go').click(); await p.waitForTimeout(1500);
  const sn = last();
  const order = sn.days[1].items.filter(i => i.kind === 'stop').map(i => i.title + '@' + i.time);
  ok('排咗 A→B→C→D→最尾，時間跟次序', order.join('|') === 'A@約 09:00|B@約 11:00|C@約 13:00|D@約 15:00|澀谷購物@約 17:00', order);
  ok('排完個掣冇咗', await p.locator('#reorder').count() === 0);
  await p.locator('[data-shophere]').click(); await p.waitForTimeout(800);
  ok('撳咗就即刻搵嗰度嘅購物地方', fn.some(b => b.mode === 'suggest-add' && b.kind === 'shop') && await p.locator('[data-sugkind="shop"].on').count() === 1, fn.map(b => b.mode || b.action));
  ok('冇 JS error', !errs.length, errs);
  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
