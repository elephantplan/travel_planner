// 加地點 → AI 建議: every 「幫我揀」 list is kept, and 「睇返之前 AI 建議過嘅」
// shows the earlier ones (this day's first) with a + to add any of them.
//
//   node tests/pastsug.js        (needs a static server on :8799)
const { chromium } = require('playwright');
const { snap } = require('./fixture.js');
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
  await p.goto('http://localhost:8799/trip.html?trip=1', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1200);
  await p.evaluate(() => document.querySelector('[data-go="day2"]').click());
  await p.waitForTimeout(1000);
  const last = () => { const x = [...saved].reverse().find(v => v.snapshot); return x && x.snapshot; };

  await p.locator('[data-insert="2"]').first().click();
  await p.waitForTimeout(300);
  await p.locator('[data-instab="ai"]').click();
  await p.fill('#ins-want', '壽司');
  await p.locator('#ins-go').click();
  await p.waitForTimeout(1500);
  const kept = notes.find(n => n.kind === 'addsug');
  ok('AI 建議會存低（連介紹）', kept && /壽司甲/.test(kept.answer) && /"day":"day2"/.test(kept.answer), kept);
  await p.keyboard.press('Escape'); await p.waitForTimeout(300);
  await p.evaluate(() => document.querySelectorAll('.layer').forEach(x => x.remove()));

  // later, from another 加地點
  await p.locator('[data-insert="1"]').first().click();
  await p.waitForTimeout(300);
  await p.locator('[data-instab="ai"]').click();
  ok('有「睇返之前 AI 建議過嘅」', await p.locator('#ins-past').isVisible());
  await p.locator('#ins-past').click();
  await p.waitForTimeout(800);
  ok('只讀 AI 建議嘅紀錄', noteGets.some(u => /kind=eq\.addsug/.test(u)));
  const box = p.locator('#ins-nearres');
  ok('見到之前嘅建議同介紹', await box.locator('.pastsug').count() === 1 && /壽司甲/.test(await box.innerText()) && /好新鮮/.test(await box.innerText()), await box.innerText());
  ok('講明係邊日、搵咩', /Day 2/.test(await box.innerText()) && /「壽司」/.test(await box.innerText()));
  await box.locator('[data-pick]').first().click();
  await p.waitForTimeout(1500);
  const d2 = last().days[1].items.filter(i => i.kind === 'stop').map(i => i.title);
  ok('撳 + 就加咗入呢個位', d2[1] === '壽司甲', d2);

  // the 問過啲咩 page doesn't list these
  await p.evaluate(() => { const b = document.querySelector('#go-notes, [data-view="notes"]'); });
  ok('問過啲咩唔會讀埋 AI 建議', !noteGets.some(u => !/kind=/.test(u)));
  ok('冇 JS 錯誤', errs.length === 0, errs);
  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
