// A new place is looked up near the other places on its day, not wherever
// the trip's city name leads: a Kyoto shop on a day based in Osaka must not
// become a same-named Osaka branch.
//
//   node tests/nearfind.js        (needs a static server on :8799)
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
  const near = [];
  await p.route('**/functions/v1/**', r => {
    let body = {}; try { body = JSON.parse(r.request().postData() || '{}'); } catch (_){}
    const j = o => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (body.action === 'day-plan') return j({ ok: true, notes: '',
      changes: [{ op: 'add', dayId: 'day2', stop: { title: '同名小店', time: '約 12:00', type: 'eat' }, reason: '試' }] });
    if (body.mode === 'near-search'){ near.push(body);
      return j({ ok: true, places: [{ placeId: 'pNEAR', name: '同名小店 首爾店', lat: 37.58, lng: 126.98, meters: 500, rating: 4.2, ratingCount: 50 }] }); }
    if (body.action === 'place-search') return j({ ok: true, places: [{ placeId: 'pFAR', name: '同名小店 釜山店', lat: 35.1, lng: 129.0, rating: 4.5 }] });
    return j({ ok: true });
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
  await p.waitForTimeout(1000);
  await p.locator('[data-apply]').first().click();
  await p.waitForTimeout(2500);
  const st = last().days[1].items.find(i => i.title === '同名小店');
  ok('用同日附近嘅地點去搵', near.length > 0 && near[0].lat > 37.5 && near[0].lat < 37.6, near[0]);
  ok('揀咗附近嗰間，唔係同名但遠嘅', st && st.placeId === 'pNEAR', st && st.placeId);

  // a stop that was matched in another city says so and can be looked up again
  const far = JSON.parse(JSON.stringify(snap));
  const fs = far.days[1].items.find(i => i.title === '北村韓屋村');
  Object.assign(fs, { lat: 35.1, lng: 129.0, placeId: 'pBUSAN' });
  await p.evaluate(f => { window.__far = f; }, far);
  await p.route('**/rest/v1/itinerary_versions**', r => {
    if (r.request().method() === 'POST'){ try { saved.push(JSON.parse(r.request().postData())); } catch (_){}
      return r.fulfill({ status: 201, contentType: 'application/json', body: '[]' }); }
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 2, created_at: '2026-09-21T00:00:00Z',
      edited_by: 'x', source: 'seed', summary: 's', snapshot: far, has_snapshot: true }]) });
  });
  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1500);
  await p.evaluate(() => { const g = document.querySelector('[data-go="day2"]'); g && g.click(); });
  await p.waitForTimeout(1000);
  ok('搵錯城市嘅地點有提示', await p.locator('.faroff').count() === 1, await p.locator('.faroff').count());
  await p.locator('[data-refind]').click();
  await p.waitForTimeout(2500);
  const fixed = last().days[1].items.find(i => i.title === '北村韓屋村');
  ok('喺附近再搵就改返附近嗰間', fixed && fixed.placeId === 'pNEAR' && fixed.lat > 37, fixed && [fixed.placeId, fixed.lat]);
  ok('改好之後提示冇咗', await p.locator('.faroff').count() === 0);
  ok('冇 JS error', !errs.length, errs);
  await b.close();
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
