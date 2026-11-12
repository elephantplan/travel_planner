// 改動紀錄: clear the old history in one tap, keeping the version the trip
// is on now. When the database refuses (no delete permission yet) it says so.
//
//   node tests/history.js        (needs a static server on :8799)
const { chromium } = require('playwright');
const { snap } = require('./fixture.js');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c){ pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : '')); } };

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const p = await (await b.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 900 } })).newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  p.on('dialog', d => d.accept());
  let rows = [3, 2, 1].map(id => ({ id, created_at: `2026-09-2${id}T00:00:00Z`, edited_by: 'x', source: 'edit', summary: '改咗 ' + id, trivial: false, has_snapshot: true }));
  const deletes = []; let allow = false;
  await p.route('**/rest/v1/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await p.route('**/rest/v1/itinerary_versions**', r => {
    const u = r.request().url(), m = r.request().method();
    if (m === 'DELETE'){ deletes.push(u);
      const gone = allow ? rows.filter(x => x.id !== 3) : [];
      rows = rows.filter(x => !gone.includes(x));
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(gone) }); }
    if (/select=id,created_at/.test(u)) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) });
    if (m === 'POST') return r.fulfill({ status: 201, contentType: 'application/json', body: '[]' });
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 3, created_at: '2026-09-23T00:00:00Z', edited_by: 'x', source: 'seed', summary: 's', snapshot: snap, has_snapshot: true }]) });
  });
  await p.route('**/functions/v1/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
  await p.route('**tile**', r => r.abort());
  await p.goto('http://localhost:8799/trip.html?trip=7', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1200);
  const open = async () => { await p.click('#btn-history'); await p.waitForTimeout(600); };
  await open();
  ok('有「刪走舊紀錄」掣', await p.locator('#prunehist').count() === 1);
  await p.click('#prunehist'); await p.waitForTimeout(600);
  ok('數據庫唔俾刪就講清楚', /刪唔到/.test(await p.locator('body').innerText()) && await p.locator('.vrow').count() === 3);
  ok('刪嘅時候保留最新嗰個', deletes[0] && /trip_id=eq\.7/.test(deletes[0]) && /id=neq\.3/.test(deletes[0]), deletes);
  allow = true;
  await p.click('#prunehist'); await p.waitForTimeout(600);
  ok('刪咗之後淨係得最新', await p.locator('.vrow').count() === 1 && /刪咗 2 個舊紀錄/.test(await p.locator('body').innerText()));
  ok('得返一個就冇掣', await p.locator('#prunehist').count() === 0);
  ok('冇 JS 錯誤', errs.length === 0, errs);
  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
