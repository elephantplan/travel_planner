// 加地點 → AI 建議: several places can be picked in one go (the sheet stays
// open, each goes in after the last); and a photo's badge says how many
// people gave the rating.
//
//   node tests/aimulti.js        (needs a static server on :8799)
const { chromium } = require('playwright');
const { snap: base } = require('./fixture.js');
const snap = JSON.parse(JSON.stringify(base));
Object.assign(snap.days[1].items.find(i => i.title === '景福宮'), { photoUrl: 'https://example.com/p.jpg', rating: 4.6, ratingCount: 12345 });
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c){ pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : '')); } };

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const p = await (await b.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 1000 } })).newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  const saved = [], notes = [], noteGets = [];
  await p.route('**/rest/v1/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await p.route('**/rest/v1/itinerary_versions**', r => {
    if (r.request().method() === 'POST'){ try { saved.push(JSON.parse(r.request().postData())); } catch (_){}
      return r.fulfill({ status: 201, contentType: 'application/json', body: '[]' }); }
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 1, created_at: '2026-09-20T00:00:00Z',
      edited_by: 'x', source: 'seed', summary: 's', snapshot: snap, has_snapshot: true }]) });
  });
  await p.route('**/rest/v1/ai_notes**', r => {
    if (r.request().method() === 'POST'){
      const n = JSON.parse(r.request().postData()); n.created_at = '2026-11-14T07:30:00Z'; notes.unshift(n);
      return r.fulfill({ status: 201, contentType: 'application/json', body: '[]' }); }
    const u = r.request().url(); noteGets.push(u);
    const m = u.match(/kind=(eq|neq)\.(\w+)/);
    const rows = notes.filter(n => !m || (m[1] === 'eq' ? n.kind === m[2] : n.kind !== m[2]));
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) });
  });
  await p.route('**/functions/v1/**', r => {
    const body = JSON.parse(r.request().postData() || '{}');
    const j = o => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (body.mode === 'suggest-add') return j({ ok: true, places: [
      { name: 'Sushi A', placeId: 'sA', lat: 37.58, lng: 126.98, rating: 4.5, ratingCount: 300, walk: 4, nearName: '景福宮', types: ['restaurant'] },
      { name: 'Sushi B', placeId: 'sB', lat: 37.581, lng: 126.981, rating: 4.3, ratingCount: 120, walk: 6, nearName: '景福宮', types: ['restaurant'] }] });
    if (body.mode === 'brief-many') return j({ ok: true, briefs: { sA: { name_zh: '壽司甲', what: '好新鮮', mustTry: '吞拿魚', rank: 0 }, sB: { name_zh: '壽司乙', what: '平', mustTry: '', rank: 1 } } });
    return j({ ok: true });
  });
  await p.route('**tile**', r => r.abort());
  await p.route('https://example.com/**', r => r.fulfill({ status: 200, contentType: 'image/gif', body: Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64') }));
  await p.goto('http://localhost:8799/trip.html?trip=1', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1200);
  await p.evaluate(() => document.querySelector('[data-go="day2"]').click());
  await p.waitForTimeout(1000);
  const last = () => { const x = [...saved].reverse().find(v => v.snapshot); return x && x.snapshot; };

  await p.locator('[data-insert="2"]').first().click();
  await p.waitForTimeout(300);
  await p.locator('[data-instab="ai"]').click();
  await p.locator('#ins-go').click();
  await p.waitForTimeout(1500);
  await p.locator('#ins-nearres [data-pick]').nth(0).click();
  await p.waitForTimeout(300);
  ok('揀咗一間個 sheet 唔會關', await p.locator('#ins-nearres').isVisible());
  ok('揀咗嗰間變剔', await p.locator('#ins-nearres [data-pick]').nth(0).isDisabled());
  await p.locator('#ins-nearres [data-pick]').nth(1).click();
  await p.waitForTimeout(300);
  ok('「完成」寫住加咗幾多個', /已加 2 個/.test(await p.locator('#ins-done').textContent()), await p.locator('#ins-done').textContent());
  await p.waitForTimeout(3000);
  const d2 = last().days[1].items.filter(i => i.kind === 'stop').map(i => i.title);
  ok('兩間都加咗，跟揀嘅次序', d2[1] === '壽司甲' && d2[2] === '壽司乙', d2);
  await p.locator('#ins-done').click();
  await p.waitForTimeout(400);
  ok('撳完成先關', await p.locator('#ins-nearres').count() === 0);

  // rating badge with the number of reviews
  const badge = await p.evaluate(() => [...document.querySelectorAll('.thumb-rate')].map(x => x.textContent));
  ok('相上面寫埋幾多個評價', badge.some(t => /12,345 個評價/.test(t)), badge);
  ok('冇 JS 錯誤', errs.length === 0, errs);
  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
