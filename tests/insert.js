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
  const saved = [], near = [], transit = [], briefs = [];
  await p.route('**/rest/v1/itinerary_versions**', r => {
    if (r.request().method() === 'POST'){ try { saved.push(JSON.parse(r.request().postData())); } catch (_){}
      return r.fulfill({ status: 201, contentType: 'application/json', body: '[]' }); }
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 1, created_at: '2026-09-20T00:00:00Z',
      edited_by: 'x', source: 'seed', summary: 's', snapshot: cur, has_snapshot: true }]) });
  });
  await p.route('**/rest/v1/ai_notes**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await p.route('**/functions/v1/**', r => {
    const body = JSON.parse(r.request().postData() || '{}');
    if (body.mode === 'suggest-add'){ near.push(body);
      const list = body.kind === 'eat'
        ? [{ name: '토속촌 삼계탕', name_zh: '土俗村參雞湯', placeId: 'pN1', lat: 37.578, lng: 126.971, rating: 4.4, ratingCount: 21000, walk: 6,
            nearName: '景福宮', onTheWay: true, types: ['restaurant'], what: '景福宮附近人氣參雞湯老店', mustTry: '原隻人參雞湯、烏雞參雞湯' }]
        : [{ name: '國立古宮博物館', placeId: 'pN2', lat: 37.577, lng: 126.975, rating: 4.6, ratingCount: 3000, walk: 4, nearName: '景福宮', types: ['museum'], what: '朝鮮王室文物', mustTry: '御寶同王室馬車' }];
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, places: list }) }); }
    if (body.mode === 'place-brief'){ briefs.push(body);
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, brief: { what: '首爾有名嘅手工餃子店', mustTry: '餃子、刀削麵', food: true, rating: 4.3, ratingCount: 9000 } }) }); }
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
  ok('得一粒 AI 建議掣，唔會一開就搵', near.length === 0 && await sh.locator('#ins-ai').count() === 1 && await sh.locator('[data-sugkind]:visible').count() === 0);
  await sh.locator('#ins-ai').click();
  await p.waitForTimeout(200);
  ok('撳咗先揀景點／購物／餐廳', (await sh.locator('[data-sugkind]:visible').allInnerTexts()).join() === '景點,購物,餐廳');
  await sh.locator('[data-sugkind="eat"]').click();
  await p.waitForTimeout(800);
  const q0 = near[0] || {};
  ok('用前後兩個地點搵順路', q0.kind === 'eat' && (q0.points || []).length === 2 && q0.skip.includes('p4'), q0);
  const st2 = await sh.innerText();
  ok('有中文名、Google 評分同幾多人評', /土俗村參雞湯/.test(st2) && /4\.4（21,000 人評）/.test(st2), st2.slice(0, 300));
  ok('講明順路同行幾耐', /順路/.test(st2) && /離「景福宮」行 6 分鐘/.test(st2));
  ok('有介紹同必食', /人氣參雞湯老店/.test(st2) && /必食/.test(st2) && /原隻人參雞湯/.test(st2));
  ok('可以撳去 Google 睇相同評論', await sh.locator('.sugcard a[href*="google.com/maps"]').count() >= 1);
  await sh.locator('.sugcard', { hasText: '土俗村參雞湯' }).first().locator('.nr-add').click();
  await p.waitForTimeout(1500);
  const last = () => { const x = [...saved].reverse().find(v => v.snapshot); return x && x.snapshot; };
  const added = (last() || { days: [{}, { items: [] }] }).days[1].items.find(i => i.placeId === 'pN1');
  ok('一撳就加咗，唔使再填', added && added.title === '土俗村參雞湯' && added.type === 'eat' && Number.isFinite(added.lat), added);
  ok('加入時連埋介紹同必食', added && /人氣參雞湯老店/.test(added.desc) && /必食：原隻人參雞湯/.test(added.desc), added && added.desc);
  ok('冇開空白編輯格', await p.locator('[data-editor]').count() === 0);
  await p.waitForTimeout(1500);
  ok('前後交通自動計', transit.some(x => x.to && x.to.placeId === 'pN1'), transit.map(x => x.to));

  await p.locator('[data-insert]').last().click();
  await p.waitForTimeout(500);
  await p.fill('#ins-q', '明洞餃子');
  await p.waitForTimeout(900);
  await p.locator('#ins-res .nr-add').first().click();
  await p.waitForTimeout(1200);
  ok('搜尋結果都係一撳就加', ((last() || {}).days || [])[1].items.some(i => i.placeId === 'pQ'));
  await p.waitForTimeout(1200);
  const q = ((last() || {}).days || [])[1].items.find(i => i.placeId === 'pQ') || {};
  ok('自己加嘅地點都有介紹同必食（由 Google 評論整理）', briefs.some(x => x.placeId === 'pQ') && /手工餃子店/.test(q.desc || '') && /必食：餃子/.test(q.desc || ''), q.desc);
  ok('卡上面見到介紹', /手工餃子店/.test(await p.locator('#app').innerText()));
  ok('冇 JS 錯誤', errs.length === 0, errs);
  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
