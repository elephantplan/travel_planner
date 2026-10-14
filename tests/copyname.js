// One tap copies a place's local-language name (for taxis, Naver, shop staff).
const { chromium } = require('playwright');
const { snap } = require('./fixture.js');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c){ pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : '')); } };
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await b.newContext({ serviceWorkers: 'block', permissions: ['clipboard-read','clipboard-write'] });
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  const cur = JSON.parse(JSON.stringify(snap));
  cur.days[1].items.push({ kind:'stop', title:'一蘭', kr:'一蘭 渋谷店', placeId:'pj' });
  await p.route('**/rest/v1/itinerary_versions**', r => r.request().method()==='POST'
    ? r.fulfill({ status:201, contentType:'application/json', body:'[]' })
    : r.fulfill({ status:200, contentType:'application/json', body: JSON.stringify([{ id:1, created_at:'2026-09-20T00:00:00Z', edited_by:'x', source:'seed', summary:'s', snapshot:cur, has_snapshot:true }]) }));
  await p.route('**/rest/v1/ai_notes**', r => r.fulfill({ status:200, contentType:'application/json', body:'[]' }));
  await p.route('**/functions/v1/**', r => r.fulfill({ status:200, contentType:'application/json', body:'{"ok":true}' }));
  await p.route('**tile**', r => r.abort());
  await p.goto('http://localhost:8799/trip.html?trip=1', { waitUntil:'domcontentloaded' }); await p.waitForTimeout(1000);
  await p.evaluate(() => document.querySelector('.dayline[data-go="day2"]').click()); await p.waitForTimeout(700);
  const btn = p.locator('[data-copyname="경복궁"]');
  ok('韓文地點有「複製韓文名」', /複製韓文名/.test(await btn.innerText()));
  await btn.click(); await p.waitForTimeout(300);
  ok('真係複製咗韓文', (await p.evaluate(() => navigator.clipboard.readText())) === '경복궁');
  ok('話返畀人知', /已複製：경복궁/.test(await p.locator('#savestate').innerText()));
  ok('韓國行程入面全漢字名唔會亂叫日文', !/複製日文名/.test(await p.locator('[data-copyname="一蘭 渋谷店"]').innerText()));
  // a Tokyo trip: kanji-only names are Japanese
  await p.evaluate(() => 0);
  ok('冇 JS 錯誤', errs.length === 0, errs);
  {
    const p2 = await ctx.newPage();
    const jp = JSON.parse(JSON.stringify(cur)); jp.meta.destinationLocal = '東京'; jp.meta.title = '東京行';
    jp.days.forEach(d => d.items.forEach(i => { if (/[가-힣]/.test(i.kr || '')) i.kr = ''; }));
    await p2.route('**/rest/v1/itinerary_versions**', r => r.request().method()==='POST'
      ? r.fulfill({ status:201, contentType:'application/json', body:'[]' })
      : r.fulfill({ status:200, contentType:'application/json', body: JSON.stringify([{ id:1, created_at:'2026-09-20T00:00:00Z', edited_by:'x', source:'seed', summary:'s', snapshot:jp, has_snapshot:true }]) }));
    await p2.route('**/rest/v1/ai_notes**', r => r.fulfill({ status:200, contentType:'application/json', body:'[]' }));
    await p2.route('**/functions/v1/**', r => r.fulfill({ status:200, contentType:'application/json', body:'{"ok":true}' }));
    await p2.route('**tile**', r => r.abort());
    await p2.goto('http://localhost:8799/trip.html?trip=1', { waitUntil:'domcontentloaded' }); await p2.waitForTimeout(1000);
    await p2.evaluate(() => document.querySelector('.dayline[data-go="day2"]').click()); await p2.waitForTimeout(700);
    ok('日本行程：全漢字名都寫「複製日文名」', /複製日文名/.test(await p2.locator('[data-copyname="一蘭 渋谷店"]').innerText()));
  }
  await b.close(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
