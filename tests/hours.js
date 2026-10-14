// Opening hours for places nobody asked the AI about. They used to be fetched
// only when the AI added a place, so hand-entered stops never had any.
//   node tests/hours.js        (needs a static server on :8799)
const { chromium } = require('playwright');
const { snap } = require('./fixture.js');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c){ pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : '')); } };
const WEEK = ['星期一: 11:00 – 22:00','星期二: 11:00 – 22:00','星期三: 11:00 – 22:00','星期四: 11:00 – 22:00',
              '星期五: 11:00 – 23:00','星期六: 10:00 – 23:00','星期日: 10:00 – 21:00'];
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await b.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 1000 } });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  const cur = JSON.parse(JSON.stringify(snap));
  const saved = []; const asked = [];
  await p.route('**/rest/v1/itinerary_versions**', r => {
    if (r.request().method() === 'POST'){ try { saved.push(JSON.parse(r.request().postData() || '{}')); } catch (_){}
      return r.fulfill({ status: 201, contentType: 'application/json', body: '[]' }); }
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 1,
      created_at: '2026-09-20T00:00:00Z', edited_by: 'x', source: 'seed', summary: 's', snapshot: cur, has_snapshot: true }]) });
  });
  await p.route('**/rest/v1/ai_notes**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await p.route('**/functions/v1/**', async r => {
    let body = {}; try { body = JSON.parse(r.request().postData() || '{}'); } catch (_){}
    if (body.action === 'place-hours'){ asked.push(body.placeId);
      return r.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ ok: true, summary: '🕒 星期一至四 11:00–22:00；週末另計', weekdayText: WEEK }) }); }
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await p.route('**tile**', r => r.abort());
  await p.goto('http://localhost:8799/trip.html?trip=1', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1000);
  await p.evaluate(() => document.querySelector('.dayline[data-go="day2"]').click());
  await p.waitForTimeout(2500);

  console.log('\nA. 自己加嘅地點都會補返營業時間');
  ok('每個有 place id 嘅地點都問咗', ['p4','p5','p6'].every(x => asked.includes(x)), asked);
  const text = await p.locator('#app').innerText();
  ok('卡上面見到全星期時間', /星期一至四 11:00–22:00/.test(text));
  ok('仲見到嗰日（星期六）嘅時間', /呢日（星期六）：10:00 – 23:00/.test(text), text.match(/呢日[^\n]*/));
  // upkeep saves are batched; leaving the app (or 60 s) flushes them
  await p.evaluate(() => { Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange')); });
  await p.waitForTimeout(1500);
  const last = saved.filter(x => x.snapshot).slice(-1)[0];
  ok('存低咗，下次唔使再問', last && last.snapshot.days[1].items.some(i => (i.eatMeta||[]).some(c => /11:00/.test(c.text))));

  console.log('\nB. 已經有就唔再問');
  const n = asked.length;
  await p.evaluate(() => document.querySelector('.dayline[data-go="day2"], [data-go="day2"]').click());
  await p.waitForTimeout(1500);
  ok('再開同一日唔會再問一次', asked.length === n, { before: n, after: asked.length });
  ok('冇 JS 錯誤', errs.length === 0, errs);
  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
