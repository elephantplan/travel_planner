// Adding a place between two stops: the sheet searches Google itself and
// offers well-rated places to eat or see near the stops either side. A leg
// left 「計緊」 by an interrupted run is picked up again.
//
//   node tests/insert.js        (needs a static server on :8799)
const { chromium } = require('playwright');
const { snap } = require('./fixture.js');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c){ pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : '')); } };

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const p = await (await b.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 1000 } })).newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  const cur = JSON.parse(JSON.stringify(snap));
  // a leg saved half-way through a calculation
  cur.days[1].items.splice(3, 0, { kind: 'connector', html: '', stale: true, checking: true });
  const saved = [], near = [], transit = [];
  await p.route('**/rest/v1/itinerary_versions**', r => {
    if (r.request().method() === 'POST'){ try { saved.push(JSON.parse(r.request().postData())); } catch (_){}
      return r.fulfill({ status: 201, contentType: 'application/json', body: '[]' }); }
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 1, created_at: '2026-09-20T00:00:00Z',
      edited_by: 'x', source: 'seed', summary: 's', snapshot: cur, has_snapshot: true }]) });
  });
  await p.route('**/rest/v1/ai_notes**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await p.route('**/functions/v1/**', r => {
    const body = JSON.parse(r.request().postData() || '{}');
    if (body.mode === 'nearby'){ near.push(body);
      const list = body.kind === 'eat'
        ? [{ name: '土俗村參雞湯', placeId: 'pN1', lat: 37.578, lng: 126.971, rating: 4.4, ratingCount: 21000, walk: 6, area: '鍾路區' }]
        : [{ name: '國立古宮博物館', placeId: 'pN2', lat: 37.577, lng: 126.975, rating: 4.6, ratingCount: 3000, walk: 4, area: '鍾路區' }];
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, places: list }) }); }
    if (body.action === 'place-search') return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ places: [{ name: body.query + ' 本店', placeId: 'pQ', lat: 37.58, lng: 126.98, address: '首爾', rating: 4.2 }] }) });
    if (body.action === 'transit'){ transit.push(body);
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, mode: 'walk', text: '步行約 7 分鐘' }) }); }
    if (/place-photo-store/.test(r.request().url())) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, url: 'http://localhost:8799/icons/icon-v2.svg' }) });
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await p.route('**tile**', r => r.abort());
  await p.goto('http://localhost:8799/trip.html?trip=1', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1200);
  await p.evaluate(() => document.querySelector('[data-go="day2"]').click());
  await p.waitForTimeout(2000);

  console.log('\nA. 計到一半嘅交通');
  ok('冇再卡喺「計緊交通時間」', !/計緊交通時間/.test(await p.locator('#app').innerText()));
  ok('自動重新計咗', transit.some(x => x.to && x.to.placeId === 'p6'), transit.map(x => x.to));

  console.log('\nB. 加地點');
  await p.locator('[data-insert="2"]').click();
  await p.waitForTimeout(800);
  const sh = p.locator('.sheet');
  ok('一打開就有搜尋格', await sh.locator('#ins-q').count() === 1);
  const st = await sh.innerText();
  ok('講明前後兩個地點附近有咩食同去', /景福宮」附近值得食/.test(st) && /附近值得去/.test(st), st.slice(0, 200));
  await p.waitForTimeout(600);
  const st2 = await sh.innerText();
  ok('附近嘅係 Google 真地點，有評分同行幾耐', /土俗村參雞湯/.test(st2) && /4\.4（21,000）/.test(st2) && /行 6 分鐘/.test(st2), st2.slice(0, 300));
  ok('問附近嗰陣避開當日已有嘅地點', near.length >= 2 && near[0].skip.includes('p4'), near[0] && near[0].skip);
  await sh.locator('.nearrow', { hasText: '土俗村參雞湯' }).first().click();
  await p.waitForTimeout(1500);
  const last = () => { const x = [...saved].reverse().find(v => v.snapshot); return x && x.snapshot; };
  const added = (last() || { days: [{}, { items: [] }] }).days[1].items.find(i => i.placeId === 'pN1');
  ok('一撳就加咗，唔使再填', added && added.title === '土俗村參雞湯' && added.type === 'eat' && Number.isFinite(added.lat), added);
  ok('冇開空白編輯格', await p.locator('[data-editor]').count() === 0);
  await p.waitForTimeout(1500);
  ok('前後交通自動計', transit.some(x => x.to && x.to.placeId === 'pN1'), transit.map(x => x.to));

  await p.locator('[data-insert]').last().click();
  await p.waitForTimeout(500);
  await p.fill('#ins-q', '明洞餃子');
  await p.waitForTimeout(900);
  await p.locator('#ins-res .nearrow').first().click();
  await p.waitForTimeout(1200);
  ok('搜尋結果都係一撳就加', ((last() || {}).days || [])[1].items.some(i => i.placeId === 'pQ'));
  ok('冇 JS 錯誤', errs.length === 0, errs);
  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
