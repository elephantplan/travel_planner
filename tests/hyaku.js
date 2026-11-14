// Japan trips: a Tabelog link on restaurant cards, and 百名店 near the plan —
// found by the AI, checked on Google Maps, matched to the day and the stop
// they are closest to, and added to that day in one tap.
//
//   node tests/hyaku.js        (needs a static server on :8799)
const { chromium } = require('playwright');
const { snap: base } = require('./fixture.js');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c){ pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : '')); } };

(async () => {
  const snap = JSON.parse(JSON.stringify(base));
  snap.meta.destinationLocal = '大阪'; snap.meta.title = '大阪行程';
  const tgt = snap.days[1].items.find(i => i.title === '南山塔 韓牛燒肉');
  tgt.type = 'eat'; tgt.kr = '焼肉 万両'; tgt.mapUrl = 'https://maps.google.com/?q=x';
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const p = await (await b.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 900 } })).newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  const saved = [], asked = [];
  await p.route('**/rest/v1/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await p.route('**/rest/v1/itinerary_versions**', r => {
    if (r.request().method() === 'POST'){ try { saved.push(JSON.parse(r.request().postData())); } catch (_){} return r.fulfill({ status: 201, contentType: 'application/json', body: '[]' }); }
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 1, created_at: '2026-09-20T00:00:00Z', edited_by: 'x', source: 'seed', summary: 's', snapshot: snap, has_snapshot: true }]) });
  });
  await p.route('**/functions/v1/**', r => {
    const body = JSON.parse(r.request().postData() || '{}');
    if (body.mode === 'hyakumeiten'){ asked.push(JSON.parse(body.text || '{}'));
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, places: [
        { name_jp: '麺屋 一燈', name_zh: '麵屋一燈', genre: 'ラーメン', award: '百名店 2025 ラーメン', area: '北村', day: 2, why: '濃厚雞湯拉麵' },
        { name_jp: '遠い店', genre: '寿司', award: '百名店 2024 寿司', area: '遠方', day: 2, why: '' } ] }) }); }
    if (body.action === 'place-search'){
      const far = /遠い/.test(body.query);
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ places: [{ name: body.query, placeId: far ? 'pFar' : 'pIttou',
        lat: far ? 35.0 : 37.5830, lng: far ? 135.0 : 126.9840, rating: 4.5 }] }) }); }
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await p.route('**tile**', r => r.abort());
  await p.goto('http://localhost:8799/trip.html?trip=1', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1500);

  ok('日本行程主頁有「Tabelog 百名店」', await p.locator('[data-fold="hyaku"]').count() === 1);
  await p.click('[data-fold="hyaku"]'); await p.waitForTimeout(300);
  await p.click('[data-hyakufind]'); await p.waitForTimeout(1500);
  ok('將每日去邊度送去搵', asked[0] && asked[0].days[1].stops.includes('경복궁'), asked[0]);
  const t = await p.locator('#app').innerText();
  ok('百名店對返 Day 2，近北村', /麵屋一燈/.test(t) && /百名店 2025 ラーメン/.test(t) && /離「北村韓屋村」約/.test(t), t.slice(0, 400));
  ok('離行程太遠嘅唔要', !/遠い店/.test(t));
  ok('有 Tabelog 連結', /tabelog\.com\/rstLst\/\?vs=1&sk=/.test(await p.locator('.hycard a.tabelog').first().getAttribute('href')));
  await p.click('[data-hyakuadd]'); await p.waitForTimeout(1500);
  const last = [...saved].reverse().find(v => v.snapshot).snapshot;
  const d2 = last.days[1].items.filter(i => i.title && i.kind !== 'connector' && i.kind !== 'note').map(i => i.title);
  ok('一撳加入 Day 2，排喺北村後面', d2.join('|') === '景福宮|北村韓屋村|麵屋一燈|南山塔 韓牛燒肉', d2);
  ok('加完顯示已經喺 Day 2', /已經喺 Day 2/.test(await p.locator('#app').innerText()));
  // the restaurant card itself carries a Tabelog link with the Japanese name
  await p.evaluate(() => document.querySelector('[data-go="day2"]').click()); await p.waitForTimeout(800);
  const tl = await p.locator('.stopcard', { hasText: '南山塔 韓牛燒肉' }).locator('a.tabelog').getAttribute('href').catch(() => '');
  ok('餐廳卡有 Tabelog（用日文名搵）', tl && tl.includes(encodeURIComponent('焼肉 万両')), tl);
  ok('景點唔會有 Tabelog', await p.locator('.stopcard', { hasText: '景福宮' }).locator('a.tabelog').count() === 0);
  ok('冇 JS 錯誤', errs.length === 0, errs);
  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
