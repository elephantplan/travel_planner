// Who changed what: each phone keeps its own name for 改動紀錄, settable there.
//
//   node tests/name.js        (needs a static server on :8799)
const { chromium } = require('playwright');
const { snap } = require('./fixture.js');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c){ pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : '')); } };
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await b.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 1000 } });
  await ctx.addInitScript(() => { try { localStorage.setItem('seoul_trip_name', 'tiffany'); } catch (_){} });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  const saved = [];
  await p.route('**/rest/v1/itinerary_versions**', r => {
    if (r.request().method() === 'POST'){ try { saved.push(JSON.parse(r.request().postData())); } catch (_){}
      return r.fulfill({ status: 201, contentType: 'application/json', body: '[]' }); }
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 1, created_at: '2026-09-20T00:00:00Z',
      edited_by: 'tiffany', source: 'seed', summary: 's', snapshot: snap, has_snapshot: true }]) });
  });
  await p.route('**/rest/v1/ai_notes**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await p.route('**/functions/v1/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
  await p.route('**tile**', r => r.abort());
  await p.goto('http://localhost:8799/trip.html?trip=1', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1200);
  await p.locator('#btn-history').click();
  await p.waitForTimeout(500);
  const wt = await p.locator('.whoami').innerText();
  ok('改動紀錄講明呢部機用緊咩名', /呢部機用緊嘅名：\s*tiffany/.test(wt), wt);
  await p.locator('#setname').click();
  await p.waitForTimeout(300);
  await p.fill('#nm-in', '爸爸');
  await p.locator('#nm-save').click();
  await p.waitForTimeout(300);
  ok('名存喺呢部機', await p.evaluate(() => localStorage.getItem('trip_editor_name')) === '爸爸');
  // make an edit and check who it is recorded as
  await p.evaluate(() => document.querySelector('[data-go="day1"]').click());
  await p.waitForTimeout(500);
  await p.locator('.stopcard [data-open]').first().click();
  await p.waitForTimeout(300);
  await p.fill('[data-editor] [data-f="tip"]', '記得帶護照');
  await p.locator('.stopcard [data-open]').first().click();
  await p.waitForTimeout(1800);
  const last = [...saved].reverse().find(x => x.summary && !x.trivial);
  ok('之後嘅改動寫新名', last && last.edited_by === '爸爸', last && last.edited_by);
  ok('冇 JS 錯誤', errs.length === 0, errs);
  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
