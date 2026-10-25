// iOS kills an installed app in the background; relaunching opens the start
// URL (the trip list). The app must put you back on the day you were reading.
const { chromium } = require('playwright');
const { snap } = require('./fixture.js');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c){ pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : '')); } };
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await b.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 700 } });
  await ctx.addInitScript(() => Object.defineProperty(navigator, 'standalone', { get: () => true }));
  const cur = JSON.parse(JSON.stringify(snap));
  for (let i = 0; i < 12; i++) cur.days[1].items.push({ kind:'stop', title:'站 ' + i, desc:'x'.repeat(200) });
  await ctx.route('**/rest/v1/itinerary_versions**', r => r.request().method()==='POST'
    ? r.fulfill({ status:201, contentType:'application/json', body:'[]' })
    : r.fulfill({ status:200, contentType:'application/json', body: JSON.stringify([{ id:1, created_at:'2026-09-20T00:00:00Z', edited_by:'x', source:'seed', summary:'s', snapshot:cur, has_snapshot:true }]) }));
  await ctx.route('**/rest/v1/trips**', r => r.fulfill({ status:200, contentType:'application/json', body:'[]' }));
  await ctx.route('**/rest/v1/ai_notes**', r => r.fulfill({ status:200, contentType:'application/json', body:'[]' }));
  await ctx.route('**/functions/v1/**', r => r.fulfill({ status:200, contentType:'application/json', body:'{"ok":true}' }));
  await ctx.route('**tile**', r => r.abort());
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://localhost:8799/trip.html?trip=1', { waitUntil:'domcontentloaded' }); await p.waitForTimeout(900);
  await p.evaluate(() => document.querySelector('.dayline[data-go="day2"]').click()); await p.waitForTimeout(600);
  await p.evaluate(() => window.scrollTo(0, 900)); await p.waitForTimeout(700);

  // the relaunch: iOS opens the start URL from scratch
  await p.goto('http://localhost:8799/', { waitUntil:'domcontentloaded' }); await p.waitForTimeout(1500);
  ok('重開之後返到行程，唔係主頁', /trip\.html\?trip=1/.test(p.url()), p.url());
  ok('返到原本睇緊嗰日', /古宮/.test(await p.locator('#app').innerText()));
  ok('碌返去差唔多原本位置', (await p.evaluate(() => window.scrollY)) > 600, await p.evaluate(() => window.scrollY));

  // pressing 主頁 on purpose must actually reach the home page
  await p.locator('#btn-home').click(); await p.waitForTimeout(1200);
  ok('自己撳主頁就真係去主頁', !/trip\.html/.test(p.url()), p.url());
  ok('冇 JS 錯誤', errs.length === 0, errs);
  await b.close(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
