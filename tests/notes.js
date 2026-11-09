// 問過啲咩: old AI answers can be deleted, and the places a day-plan answer
// suggested can still be put into the trip from there.
//
//   node tests/notes.js        (needs a static server on :8799)
const { chromium } = require('playwright');
const { snap } = require('./fixture.js');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c){ pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : '')); } };

const NOTE = { id: 42, trip_id: 1, kind: 'day-plan', asked_by: 'tiffany', created_at: '2026-11-09T10:42:00Z',
  question: '聖水洞咖啡一日：AI 建議',
  answer: '整體路線好順。\n\n【Day 2・改】景福宮（約 09:30）\n補充出發時間。\n\n【Day 3・加】Blue Bottle Coffee 聖水店（約 15:30）\n回酒店前歇歇腳。' };

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const p = await (await b.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 1000 } })).newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  const cur = JSON.parse(JSON.stringify(snap));
  const saved = [], deleted = [];
  await p.route('**/rest/v1/itinerary_versions**', r => {
    if (r.request().method() === 'POST'){ try { saved.push(JSON.parse(r.request().postData())); } catch (_){}
      return r.fulfill({ status: 201, contentType: 'application/json', body: '[]' }); }
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 1, created_at: '2026-09-20T00:00:00Z',
      edited_by: 'x', source: 'seed', summary: 's', snapshot: cur, has_snapshot: true }]) });
  });
  await p.route('**/rest/v1/ai_notes**', r => {
    if (r.request().method() === 'DELETE'){ deleted.push(r.request().url()); return r.fulfill({ status: 204, body: '' }); }
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([NOTE]) });
  });
  await p.route('**/functions/v1/**', r => {
    const body = JSON.parse(r.request().postData() || '{}');
    if (body.action === 'place-search') return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ places: [{ name: body.query, placeId: 'pid-bb', lat: 37.54, lng: 127.05 }] }) });
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await p.route('**tile**', r => r.abort());
  await p.goto('http://localhost:8799/trip.html?trip=1', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1200);
  await p.evaluate(() => document.querySelector('[data-go="notes"]').click());
  await p.waitForTimeout(800);
  await p.locator('[data-note="0"]').click();
  await p.waitForTimeout(200);
  const a = p.locator('.qa-a').first();
  ok('已經喺行程嘅地點寫明喺邊日', /已喺 D2/.test(await a.innerText()));
  ok('建議加嘅地點有「加去 D3」', await a.locator('[data-noteadd]').count() === 1 && /加去 D3/.test(await a.innerText()));
  await a.locator('[data-noteadd]').click();
  await p.waitForTimeout(300);
  ok('預先揀好 Day 3', await p.locator('[data-addto="day3"].suggested').count() === 1);
  await p.locator('[data-addto="day3"]').click();
  await p.waitForTimeout(2000);
  const last = [...saved].reverse().find(x => x.snapshot);
  const st = last && last.snapshot.days[2].items.find(i => i.kind === 'stop');
  ok('加咗落 Day 3，帶埋時間同原因', st && st.title === 'Blue Bottle Coffee 聖水店' && st.time === '約 15:30' && /歇歇腳/.test(st.desc), st);

  await p.evaluate(() => document.querySelector('[data-go="notes"]').click());
  await p.waitForTimeout(800);
  p.once('dialog', d => d.accept());
  await p.locator('[data-notedel="0"]').click();
  await p.waitForTimeout(600);
  ok('刪紀錄會叫 server 刪嗰條', deleted.length === 1 && /id=eq\.42/.test(deleted[0]), deleted);
  ok('畫面即刻冇咗', await p.locator('.qa').count() === 0);
  ok('冇 JS 錯誤', errs.length === 0, errs);
  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
