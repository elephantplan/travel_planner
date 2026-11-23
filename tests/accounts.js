// Accounts and share links: requests carry the logged-in person's token;
// the trip list shows my trips and ones shared with me (not other people's
// old trips); a share link's token rides along on database requests and
// the 分享 sheet hands out the link.
//
//   node tests/accounts.js        (needs a static server on :8799)
const { chromium } = require('playwright');
const { snap } = require('./fixture.js');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c){ pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : '')); } };

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await b.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 900 } });
  await ctx.addInitScript(() => {
    if (!localStorage.getItem('trip_auth_v1')) localStorage.setItem('trip_auth_v1', JSON.stringify({ access_token: 'USERTOK', refresh_token: 'r',
      expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'u1', email: 'me@example.com', name: '我', avatar: '' } }));
  });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  const reqs = [];
  const soon = new Date(Date.now() + 10 * 864e5).toISOString().slice(0, 10);
  const trips = [
    { id: 1, name: '我嘅東京', destination_local: '東京', date_start: soon, date_end: soon, owner_id: 'u1', share_token: 'TOK1' },
    { id: 2, name: '朋友嘅大阪', destination_local: '大阪', date_start: soon, date_end: soon, owner_id: 'u2', share_token: 'TOK2' },
    { id: 3, name: '別人舊行程', destination_local: '首爾', date_start: soon, date_end: soon, owner_id: null, share_token: 'TOK3' }];
  await p.route('**/rest/v1/**', r => {
    reqs.push({ url: r.request().url(), h: r.request().headers() });
    const u = r.request().url();
    if (/\/trips\?id=eq\.1/.test(u)) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([trips[0]]) });
    if (/\/trips/.test(u)) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(trips) });
    if (/itinerary_versions/.test(u)) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 9, created_at: '2026-09-20T00:00:00Z', edited_by: 'x', source: 'seed', summary: 's', snapshot: snap, has_snapshot: true }]) });
    return r.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await p.route('**/functions/v1/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
  await p.route('**tile**', r => r.abort());

  await p.goto('http://localhost:8799/index.html', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1200);
  ok('資料庫請求用登入咗嘅 token', reqs.some(x => /\/trips/.test(x.url) && x.h.authorization === 'Bearer USERTOK'));
  const list = await p.locator('#upcoming').innerText();
  ok('見到自己同朋友分享嘅行程', /我嘅東京/.test(list) && /朋友嘅大阪/.test(list) && /朋友分享/.test(list), list);
  ok('冇開過嘅舊行程唔會出現', !/別人舊行程/.test(list));
  ok('右上角係自己個頭像／名', !(await p.locator('#btn-acct').isHidden()) && !/登入/.test(await p.locator('#btn-acct').innerText()));
  ok('登入咗就冇登入提示', await p.locator('#logincard').isHidden());

  // a share link
  reqs.length = 0;
  await p.goto('http://localhost:8799/trip.html?trip=1&s=TOK1', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2000);
  ok('分享連結嘅 token 跟住資料庫請求', reqs.some(x => /itinerary_versions/.test(x.url) && x.h['x-share-token'] === 'TOK1'), reqs.map(x => x.h['x-share-token']));
  ok('網址收返 token', !/s=TOK1/.test(p.url()), p.url());
  ok('有「分享／匯出」掣', await p.locator('#btn-export').isVisible());
  await p.locator('#btn-export').click(); await p.waitForTimeout(600);
  ok('分享連結有 token，擁有人可以重設', /trip=1&s=TOK1/.test(await p.inputValue('#sh-link')) && await p.locator('#sh-reset').count() === 1);
  ok('冇 JS 錯誤', errs.length === 0, errs);
  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
