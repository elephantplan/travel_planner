// The trip list: a picture per trip, and 刪除 that only moves a trip to
// 最近刪除 (restorable for 30 days) instead of wiping it at once.
//
//   node tests/tripbin.js        (needs a static server on :8799)
const { chromium } = require('playwright');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c){ pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : '')); } };

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const p = await (await b.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 900 } })).newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  const writes = [];
  const soon = new Date(Date.now() + 10 * 864e5).toISOString().slice(0, 10);
  let trips = [
    { id: 1, name: '東京行程', destination_local: '東京', date_start: soon, date_end: soon, cover_url: 'https://example.com/c.jpg', deleted_at: null },
    { id: 2, name: '舊行程', destination_local: '大阪', date_start: soon, date_end: soon, deleted_at: new Date(Date.now() - 2 * 864e5).toISOString() }];
  await p.route('**/rest/v1/trips**', r => {
    const m = r.request().method();
    if (m !== 'GET'){ writes.push({ m, url: r.request().url(), body: r.request().postData() });
      return r.fulfill({ status: 204, body: '' }); }
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(trips) });
  });
  await p.route('https://example.com/**', r => r.fulfill({ status: 200, contentType: 'image/gif', body: Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64') }));
  await p.route('**/functions/v1/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
  await p.goto('http://localhost:8799/index.html', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1200);
  ok('行程卡有張相', await p.locator('.pass .pass-cover').count() === 1);
  ok('刪咗嘅唔喺清單，喺「最近刪除」', await p.locator('#upcoming .pass').count() === 1 && await p.locator('#binwrap').isVisible() && /舊行程/.test(await p.locator('#bin').textContent()));
  ok('講明仲有幾多日', /仲有 28 日/.test(await p.locator('#bin').textContent()), await p.locator('#bin').textContent());
  await p.locator('[data-del="1"]').click(); await p.waitForTimeout(200);
  ok('刪除唔使打名，講明 30 日內可以還原', await p.locator('#del-confirm').count() === 0 && /30 日內可以還原/.test(await p.locator('.sheet').innerText()));
  await p.locator('#del-go').click(); await p.waitForTimeout(500);
  ok('刪除係標記，唔係真刪', writes.some(w => w.m === 'PATCH' && /id=eq\.1/.test(w.url) && /deleted_at/.test(w.body)) && !writes.some(w => w.m === 'DELETE'), writes);
  await p.locator('.bin > summary').click();
  await p.locator('[data-restore="2"]').click(); await p.waitForTimeout(500);
  ok('還原就清返標記', writes.some(w => w.m === 'PATCH' && /id=eq\.2/.test(w.url) && /"deleted_at":null/.test(w.body)), writes);
  ok('冇 JS 錯誤', errs.length === 0, errs);
  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
