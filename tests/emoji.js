// Emoji in the data (hours chips, access badges, clothing tips, AI prose)
// made the whole page look cheap. They are stripped on the way to the screen;
// the stored data is untouched.
//
//   node tests/emoji.js        (needs a static server on :8799)
const { chromium } = require('playwright');
const { snap } = require('./fixture.js');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c){ pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : '')); } };
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await b.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 1000 } });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  const cur = JSON.parse(JSON.stringify(snap));
  cur.meta.title = '🍁 ' + cur.meta.title;
  const st = cur.days[0].items.find(i => i.title);
  st.title = '🍜 ' + st.title; st.desc = '🕒 08:30 – 22:00 · 🟢 地面店舖';
  (cur.sections || []).forEach(s => { s.lines = (s.lines || []).map(l => '👕 ' + l); });
  await p.route('**/rest/v1/itinerary_versions**', r => r.request().method() === 'POST'
    ? r.fulfill({ status: 201, contentType: 'application/json', body: '[]' })
    : r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 1,
        created_at: '2026-09-20T00:00:00Z', edited_by: 'x', source: 'seed', summary: 's', snapshot: cur, has_snapshot: true }]) }));
  await p.route('**/rest/v1/ai_notes**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await p.route('**/functions/v1/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await p.route('**tile**', r => r.abort());
  await p.goto('http://localhost:8799/trip.html?trip=1', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1200);
  await p.locator('[data-fold="prep"]').click().catch(() => {});
  await p.waitForTimeout(300);
  const home = await p.locator('#app').innerText();
  ok('主頁冇 emoji', !EMOJI.test(home), (home.match(EMOJI) || [])[0]);
  ok('字照出', home.includes(cur.meta.title.slice(3)));
  await p.evaluate(() => document.querySelector('.dayline[data-go="day1"]').click());
  await p.waitForTimeout(700);
  const day = await p.locator('#app').innerText();
  ok('日頁冇 emoji', !EMOJI.test(day), (day.match(EMOJI) || [])[0]);
  ok('營業時間啲字仲喺度', /08:30 – 22:00/.test(day) && /地面店舖/.test(day));
  ok('冇 JS 錯誤', errs.length === 0, errs);
  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
