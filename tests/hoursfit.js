// Dinner at a place that shuts at 14:00: the card says so, opening the day
// offers to swap it, and the swap skips places also shut then.
//
//   node tests/hoursfit.js        (needs a static server on :8799)
const { chromium } = require('playwright');
const { snap: base } = require('./fixture.js');
const snap = JSON.parse(JSON.stringify(base));
Object.assign(snap.days[1].items.find(i => i.title === '南山塔 韓牛燒肉'), { title: '晚餐：韓牛燒肉', type: 'eat', time: '約 19:00', placeId: 'pSHUT', weekdayText: ['星期六: 11:00–14:00'] });
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
  const hours = { pSHUT: ['星期六: 11:00–14:00'], pA: ['星期六: 11:30–14:30'], pB: ['星期六: 17:00–23:00'] };
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

  ok('卡上講明嗰陣已經收咗', /19:00 到，佢 14:00 已經關門/.test(await p.locator('.meta-chip.closed').first().innerText()));
  ok('卡上有「換一間嗰陣有開嘅」', await p.locator('[data-swapeat][data-shut]').count() === 1);
  await p.waitForTimeout(2200);
  ok('開呢日會問要唔要換', /去嗰陣冇開/.test(await p.locator('.hintbar').innerText().catch(() => '')));
  await p.locator('.hintbar .btn').click();
  await p.waitForTimeout(3000);
  const st = last() && last().days[1].items.find(i => i.placeId === 'pB');
  ok('跳過嗰陣都冇開嘅，換咗做夜晚有開嗰間', st && st.title === '晚餐：韓牛乙', st && st.title);
  ok('原本嗰間做咗後備', st && (st.alts || []).some(a => a.placeId === 'pSHUT'));
  ok('時間唔夾嘅提示冇咗', await p.locator('.meta-chip.closed').count() === 0);
  ok('冇 JS error', !errs.length, errs);
  await b.close();
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
