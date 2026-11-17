// admin.html: an admin sees the accounts and who owns which trip, can
// rename an account and hand a trip to someone; anyone else is told no.
//
//   node tests/admin.js        (needs a static server on :8799)
const { chromium } = require('playwright');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c){ pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : '')); } };
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await b.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 900 } });
  await ctx.addInitScript(() => localStorage.setItem('trip_auth_v1', JSON.stringify({ access_token: 'T', refresh_token: 'r',
    expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'u1', email: 'me@example.com', name: '我', avatar: '' } })));
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  const calls = []; let admin = true;
  await p.route('**/rest/v1/**', r => {
    const u = r.request().url(); const m = u.match(/rpc\/(\w+)/);
    const j = (o, s = 200) => r.fulfill({ status: s, contentType: 'application/json', body: JSON.stringify(o) });
    if (!m) return j([]);
    calls.push({ fn: m[1], body: JSON.parse(r.request().postData() || '{}') });
    if (!admin && /^admin_/.test(m[1])) return j({ code: '42501', message: 'not an admin' }, 403);
    if (m[1] === 'admin_users') return j([{ id: 'u1', email: 'me@example.com', name: '我', display_name: '我', avatar: '', is_admin: true, trips: 2, shared: 0, created_at: '2026-11-16T00:00:00Z' },
      { id: 'u2', email: 'w@example.com', name: 'W', display_name: '', avatar: '', is_admin: false, trips: 1, shared: 1, created_at: '2026-11-17T00:00:00Z' }]);
    if (m[1] === 'admin_google_usage') return j({ month: '2026-11-01', skus: [{ sku: 'text_search:enterprise', calls: 1200 },
      { sku: 'details:enterprise', calls: 300 }, { sku: 'text_search:ids', calls: 40 }, { sku: 'routes', calls: 90 }],
      days: [{ day: '2026-11-16', calls: 900 }, { day: '2026-11-17', calls: 730 }] });
    if (m[1] === 'admin_trips') return j([{ id: 5, name: '東京', date_start: '2026-11-21', date_end: '2026-11-22', owner_id: null, members: 0 }]);
    return j(true);
  });
  await p.goto('http://localhost:8799/admin.html', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1000);
  const t = await p.locator('#app').innerText();
  ok('列出用戶同 email', /me@example\.com/.test(t) && /w@example\.com/.test(t) && /用戶 2 個/.test(t.replace(/\s+/g, ' ')), t.slice(0, 200));
  const g = (await p.locator('#gusage').innerText()).replace(/\s+/g, ' ');
  ok('Google 用量：總數同各級', /1,630/.test(g) && /Text Search\)・Enterprise/.test(g) && /1,200 \/ 1,000 免費/.test(g) && /只攞 ID/.test(g), g.slice(0, 300));
  ok('超出免費額估計 US$7.00', /US\$7\.00/.test(g), g);
  ok('爆咗免費額嘅條 bar 變紅', await p.locator('#gusage .g-bar i.over').count() === 1);
  ok('有 Google 帳單連結', await p.locator('#gusage a[href*="console.cloud.google.com/billing"]').count() >= 1);
  await p.screenshot({ path: '/tmp/claude-0/admin-usage.png', fullPage: true });
  ok('自己冇得刪、冇得取消 admin', await p.locator('[data-u="u1"] [data-del]').count() === 0 && await p.locator('[data-u="u2"] [data-del]').count() === 1);
  await p.fill('[data-u="u2"] [data-name]', 'Wendy');
  await p.locator('[data-u="u2"] [data-save]').click(); await p.waitForTimeout(400);
  ok('改到其他人個名', calls.some(c => c.fn === 'admin_set_user' && c.body.uid === 'u2' && c.body.new_name === 'Wendy'), calls.map(c => c.fn));
  await p.locator('[data-t="5"] [data-owner]').selectOption('u1'); await p.waitForTimeout(400);
  ok('將行程交俾一個用戶', calls.some(c => c.fn === 'admin_set_trip_owner' && c.body.tid === 5 && c.body.uid === 'u1'));
  admin = false;
  await p.reload({ waitUntil: 'domcontentloaded' }); await p.waitForTimeout(800);
  ok('唔係 admin 就睇唔到', /唔係 admin/.test(await p.locator('#app').innerText()));
  ok('唔係 admin 冇用量', await p.locator('#gusage').isHidden());
  ok('冇 JS 錯誤', errs.length === 0, errs);
  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
