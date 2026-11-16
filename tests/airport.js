// Airports are pinned: 「成田」 must never become Haneda (the nearer one to a
// Tokyo day), and a stop saved at the wrong airport is put right on opening.
//
//   node tests/airport.js        (needs a static server on :8799)
const { chromium } = require('playwright');
const { snap: base } = require('./fixture.js');
const snap = JSON.parse(JSON.stringify(base));
Object.assign(snap.days[1].items.find(i => i.title === '景福宮'), { title: '到達成田國際機場＆前往市區', kr: 'Narita International Airport', placeId: 'pHND', lat: 35.5494, lng: 139.7798 });
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
  const searched = [];
  await p.route('**/functions/v1/**', r => {
    let body = {}; try { body = JSON.parse(r.request().postData() || '{}'); } catch (_){}
    const j = o => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (body.action === 'place-search'){ searched.push(body.query);
      // Google's answer biased to the city: Haneda first
      return j({ ok: true, places: [{ placeId: 'pHND', name: 'Haneda Airport', lat: 35.5494, lng: 139.7798 },
        { placeId: 'pNRT', name: 'Narita International Airport', lat: 35.7720, lng: 140.3929, rating: 4.1, ratingCount: 50000 }] }); }
    if (body.mode === 'near-search') return j({ ok: true, places: [{ placeId: 'pHND', name: 'Haneda Airport', lat: 35.5494, lng: 139.7798, meters: 15000 }] });
    return j({ ok: true });
  });
  await p.route('**tile**', r => r.abort());
  await p.goto('http://localhost:8799/trip.html?trip=1', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1200);
  await p.evaluate(() => document.querySelector('[data-go="day2"]').click());
  await p.waitForTimeout(1000);
  const last = () => { const x = [...saved].reverse().find(v => v.snapshot); return x && x.snapshot; };

  await p.waitForTimeout(2500);
  const st = last() && last().days[1].items.find(i => /成田/.test(i.title || ''));
  ok('打開就發現個機場錯咗，改返成田', st && st.placeId === 'pNRT' && st.lat > 35.7, st && [st.placeId, st.lat]);
  ok('Google 地圖連結都係成田', st && /Narita/.test(decodeURIComponent(st.mapUrl || '')), st && st.mapUrl);
  ok('用機場正式名搵', searched.includes('Narita International Airport'), searched);
  ok('冇 JS error', !errs.length, errs);
  await b.close();
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
