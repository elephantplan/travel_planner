// A place shut on its day: one tap swaps it for a well-rated one nearby that
// is open that day (same kind of food), and the shut one becomes a backup.
//
//   node tests/closedswap.js        (needs a static server on :8799)
const { chromium } = require('playwright');
const { snap: base } = require('./fixture.js');
const snap = JSON.parse(JSON.stringify(base));
Object.assign(snap.days[1].items.find(i => i.title === '南山塔 韓牛燒肉'), { title: '晚餐：韓牛燒肉', type: 'eat', placeId: 'pSHUT', weekdayText: ['星期一: 11:00–22:00', '星期六: 休息', '星期日: 11:00–22:00'] });
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
  const asked = [];
  const hours = { pSHUT: ['星期六: 休息'], pA: ['星期六: 休息'], pB: ['星期六: 11:00–22:00'] };
  await p.route('**/functions/v1/**', r => {
    let body = {}; try { body = JSON.parse(r.request().postData() || '{}'); } catch (_){}
    const j = o => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (body.mode === 'suggest-add'){ asked.push(body);
      return j({ ok: true, places: [{ placeId: 'pA', name: 'Beef A', lat: 37.55, lng: 126.99, rating: 4.6, ratingCount: 900 },
        { placeId: 'pB', name: 'Beef B', name_zh: '韓牛乙', lat: 37.551, lng: 126.989, rating: 4.4, ratingCount: 500 }] }); }
    if (body.action === 'place-hours') return j({ ok: true, weekdayText: hours[body.placeId] || [], summary: 'x' });
    return j({ ok: true });
  });
  await p.route('**tile**', r => r.abort());
  await p.goto('http://localhost:8799/trip.html?trip=1', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1200);
  await p.evaluate(() => document.querySelector('[data-go="day2"]').click());
  await p.waitForTimeout(1000);
  const last = () => { const x = [...saved].reverse().find(v => v.snapshot); return x && x.snapshot; };

  ok('休息嗰日：餐廳卡有「換一間嗰陣有開嘅」', await p.locator('[data-swapeat][data-shut]').count() === 1);
  await p.locator('[data-swapeat][data-shut]').click();
  await p.waitForTimeout(400);
  ok('未撳「幫我搵幾間」唔會自己搵', asked.length === 0 && /燒肉/.test(await p.locator('#sw-out').innerText()), asked.length);
  ok('同類已經揀咗', await p.locator('[data-po-cuisine].on').count() === 1);
  ok('講明點解要換', /星期六休息/.test(await p.locator('.sw-shut').innerText().catch(() => '')));
  await p.locator('#sw-go').click();
  await p.waitForTimeout(300);
  ok('撳咗先搵，有動畫', await p.locator('#sw-out .ldrbox, #sw-out .ldr').count() >= 1 || /韓牛乙/.test(await p.locator('#sw-out').innerText()));
  await p.waitForTimeout(2000);
  await p.locator('.swcard', { hasText: '韓牛乙' }).locator('[data-swpick]').click();
  await p.waitForTimeout(1500);
  const st = last() && last().days[1].items.find(i => i.placeId === 'pB');
  ok('用同類嘢搵（燒肉，韓國用韓文）', asked[0] && /고기구이/.test(asked[0].want) && asked[0].kind === 'eat', asked[0]);
  ok('跳過嗰日都休息嘅，換咗做有開嗰間', st && st.title === '晚餐：韓牛乙', st && st.title);
  ok('原本嗰間做咗後備', st && (st.alts || []).some(a => a.placeId === 'pSHUT'), st && st.alts);
  ok('公休提示冇咗', await p.locator('.meta-chip.closed').count() === 0);
  ok('冇 JS error', !errs.length, errs);
  await b.close();
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
