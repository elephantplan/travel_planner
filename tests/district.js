// A name that says the area (「澀谷 OWNDAYS」) must get the branch in that
// area, not the nearest one; a stop already matched to another area's
// branch is corrected on opening, and a new one is found right.
//
//   node tests/district.js        (needs a static server on :8799)
const { chromium } = require('playwright');
const { snap: base } = require('./fixture.js');
const snap = JSON.parse(JSON.stringify(base));
Object.assign(snap.days[1].items.find(i => i.title === '北村韓屋村'), { title: '澀谷 OWNDAYS 驗光揀眼鏡', kr: 'OWNDAYS 新宿マルイアネックス店', placeId: 'pSJK', lat: 35.6905, lng: 139.7049 });
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
  const queries = [];
  const branches = [
    { placeId: 'pSJK', name: 'OWNDAYS 新宿マルイアネックス店', address: '日本東京都新宿區新宿3丁目', lat: 35.6905, lng: 139.7049, meters: 900 },
    { placeId: 'pSBY', name: 'OWNDAYS 渋谷店', address: '日本東京都澀谷區宇田川町', lat: 35.6610, lng: 139.6985, meters: 3500, rating: 4.5, ratingCount: 800 }];
  await p.route('**/functions/v1/**', r => {
    let body = {}; try { body = JSON.parse(r.request().postData() || '{}'); } catch (_){}
    const j = o => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (body.mode === 'near-search'){ queries.push(body.query); return j({ ok: true, places: /OWNDAYS/i.test(body.query) ? branches : [] }); }
    if (body.action === 'place-search') return j({ ok: true, places: /OWNDAYS/i.test(body.query) ? branches : [] });
    return j({ ok: true });
  });
  await p.route('**tile**', r => r.abort());
  await p.goto('http://localhost:8799/trip.html?trip=1', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1200);
  await p.evaluate(() => document.querySelector('[data-go="day2"]').click());
  await p.waitForTimeout(1000);
  const last = () => { const x = [...saved].reverse().find(v => v.snapshot); return x && x.snapshot; };

  await p.waitForTimeout(3000);
  const st = last() && last().days[1].items.find(i => /OWNDAYS/.test(i.title || ''));
  ok('講明澀谷就改返澀谷分店，唔係最近嗰間', st && st.placeId === 'pSBY' && st.lat < 35.67, st && [st.placeId, st.lat]);
  ok('冇 JS error', !errs.length, errs);
  await b.close();
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
