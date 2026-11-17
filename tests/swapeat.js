// A restaurant says what kind of food it is, and 換一間 asks what you'd
// rather have (several kinds at once, price, nearby, 百名店 in Japan), then
// offers a few nearby that are open then: one replaces it, others can be backups.
//
//   node tests/swapeat.js        (needs a static server on :8799)
const { chromium } = require('playwright');
const { snap: base } = require('./fixture.js');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c){ pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : '')); } };

async function run(b, japan){
  const snap = JSON.parse(JSON.stringify(base));
  if (japan) Object.assign(snap.meta, { destinationLocal: '札幌' });
  Object.assign(snap.days[1].items.find(i => i.title === '南山塔 韓牛燒肉'), { title: '晚餐：韓牛燒肉', type: 'eat', time: '約 19:00', placeId: 'pOLD', weekdayText: ['星期六: 11:00–22:00'] });
  const p = await (await b.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 900 } })).newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  const saved = [], wants = [];
  await p.route('**/rest/v1/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await p.route('**/rest/v1/itinerary_versions**', r => {
    if (r.request().method() === 'POST'){ try { saved.push(JSON.parse(r.request().postData())); } catch (_){}
      return r.fulfill({ status: 201, contentType: 'application/json', body: '[]' }); }
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 1, created_at: '2026-09-20T00:00:00Z',
      edited_by: 'x', source: 'seed', summary: 's', snapshot: snap, has_snapshot: true }]) });
  });
  const hours = { pA: ['星期六: 11:00–14:00'], pB: ['星期六: 17:00–23:00'], pC: ['星期六: 11:00–23:00'], pH: ['星期六: 18:00–23:00'] };
  await p.route('**/functions/v1/**', r => {
    let body = {}; try { body = JSON.parse(r.request().postData() || '{}'); } catch (_){}
    const j = o => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (body.mode === 'suggest-add'){ wants.push(body.want);
      return j({ ok: true, places: body.want === '壽司'
        ? [{ placeId: 'pA', name: 'Sushi Lunch', lat: 37.551, lng: 126.988, rating: 4.7, ratingCount: 900 }, { placeId: 'pB', name: 'Sushi Night', name_zh: '夜鮨', lat: 37.5512, lng: 126.9881, rating: 4.5, ratingCount: 700, walk: 3 }]
        : [{ placeId: 'pC', name: 'Ramen C', lat: 37.5513, lng: 126.9883, rating: 4.3, ratingCount: 400, walk: 4 }] }); }
    if (body.mode === 'brief-many') return j({ ok: true, briefs: { pB: { what: '夜晚先開嘅鮨店', mustTry: '海膽' } } });
    if (body.mode === 'hyakumeiten') return j({ ok: true, places: [{ name_jp: '名店H', genre: 'ラーメン', award: '百名店 2025 ラーメン', why: '湯底濃' }] });
    if (body.action === 'place-search') return j({ places: [{ name: body.query, placeId: 'pH', lat: 37.5514, lng: 126.9884, rating: 4.6, ratingCount: 2000 }] });
    if (body.action === 'place-hours') return j({ ok: true, weekdayText: hours[body.placeId] || [], summary: 'x' });
    return j({ ok: true });
  });
  await p.route('**tile**', r => r.abort());
  await p.goto('http://localhost:8799/trip.html?trip=1', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1200);
  await p.evaluate(() => document.querySelector('[data-go="day2"]').click());
  await p.waitForTimeout(1000);
  const last = () => { const x = [...saved].reverse().find(v => v.snapshot); return x && x.snapshot; };
  return { p, errs, wants, last };
}

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  // Seoul: types, several kinds, open then, pick one, keep another as backup
  { const { p, errs, wants, last } = await run(b, false);
    ok('餐廳卡講明係咩菜', /🥩 燒肉/.test(await p.locator('.meta-chip.cuisine').first().innerText().catch(() => '')));
    ok('餐廳卡有「換一間」', await p.locator('[data-swapeat]').count() === 1);
    await p.locator('[data-swapeat]').click(); await p.waitForTimeout(300);
    ok('問想食咩，有常見選擇', await p.locator('#sw-kind .pfchip').count() >= 10 && /晚餐・約 19:00/.test(await p.locator('.sheet').innerText()));
    ok('韓國行程冇百名店選項', await p.locator('#sw-hyaku').count() === 0);
    await p.locator('#sw-kind .pfchip', { hasText: '壽司' }).click();
    await p.locator('#sw-kind .pfchip', { hasText: '拉麵' }).click();
    await p.locator('#sw-go').click(); await p.waitForTimeout(1500);
    ok('揀咗幾類就逐類搵', wants.includes('壽司') && wants.includes('拉麵'), wants);
    const txt = await p.locator('#sw-out').innerText();
    ok('嗰陣冇開嘅唔出', !/Sushi Lunch/.test(txt) && /跳過咗 1 間/.test(txt), txt.slice(0, 200));
    ok('列出幾間有開嘅，講埋類型同幾時開', /夜鮨/.test(txt) && /Ramen C/.test(txt) && /嗰陣有開（17:00–23:00）/.test(txt), txt.slice(0, 300));
    ok('有介紹同必食', /海膽/.test(txt));
    await p.locator('.swcard', { hasText: 'Ramen C' }).locator('[data-swalt]').click(); await p.waitForTimeout(500);
    await p.locator('.swcard', { hasText: '夜鮨' }).locator('[data-swpick]').click(); await p.waitForTimeout(1500);
    const st = last().days[1].items.find(i => i.placeId === 'pB');
    ok('揀咗嗰間取代原本', st && st.title === '晚餐：夜鮨', st && st.title);
    ok('原本嗰間同另一間都做咗後備', st && (st.alts || []).some(a => a.placeId === 'pOLD') && (st.alts || []).some(a => a.placeId === 'pC'), st && (st.alts || []).map(a => a.placeId));
    ok('新嗰間顯示壽司', /🍣 壽司/.test(await p.locator('.meta-chip.cuisine').first().innerText().catch(() => '')));
    ok('冇 JS error', !errs.length, errs);
  }
  // Japan: 百名店 only
  { const { p, errs } = await run(b, true);
    await p.locator('[data-swapeat]').click(); await p.waitForTimeout(300);
    ok('日本行程有「淨係百名店」', await p.locator('#sw-hyaku').count() === 1);
    await p.locator('#sw-hyaku').click(); await p.locator('#sw-go').click(); await p.waitForTimeout(2000);
    const txt = await p.locator('#sw-out').innerText();
    ok('百名店有標明', /百名店 2025 ラーメン/.test(txt) && /名店H/.test(txt), txt.slice(0, 200));
    ok('冇 JS error（日本）', !errs.length, errs);
  }
  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
