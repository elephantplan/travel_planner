// AI 諗行程 on a day: the questions fold away while it thinks, the answer
// has one 全部加入 at the bottom, and that puts everything in at once,
// closes the sheet and shows the day with the new stops marked.
//
//   node tests/dayai.js        (needs a static server on :8799)
const { chromium } = require('playwright');
const { snap } = require('./fixture.js');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c){ pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : '')); } };

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const p = await (await b.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 860 } })).newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  const saved = [];
  await p.route('**/rest/v1/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await p.route('**/rest/v1/itinerary_versions**', r => {
    if (r.request().method() === 'POST'){ try { saved.push(JSON.parse(r.request().postData())); } catch (_){}
      return r.fulfill({ status: 201, contentType: 'application/json', body: '[]' }); }
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 1, created_at: '2026-09-20T00:00:00Z',
      edited_by: 'x', source: 'seed', summary: 's', snapshot: snap, has_snapshot: true }]) });
  });
  let asked = null;
  await p.route('**/functions/v1/**', r => {
    const body = JSON.parse(r.request().postData() || '{}');
    const j = o => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (body.action === 'day-plan'){ asked = body; return new Promise(res => setTimeout(res, 2500)).then(() => j({ ok: true, notes: '加多三個', changes: [
      { op: 'add', dayId: 'day2', stop: { title: '仁寺洞', time: '約 13:00' }, reason: '順路' },
      { op: 'add', dayId: 'day2', stop: { title: '廣藏市場', time: '約 15:00' }, reason: '食嘢' },
      { op: 'add', dayId: 'day2', stop: { title: '清溪川', time: '約 17:00' }, reason: '散步' }] })); }
    return new Promise(res => setTimeout(res, 800)).then(() => j({ ok: true }));
  });
  await p.route('**tile**', r => r.abort());
  await p.goto('http://localhost:8799/trip.html?trip=1', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1200);
  await p.evaluate(() => document.querySelector('[data-go="day2"]').click());
  await p.waitForTimeout(800);
  const last = () => { const x = [...saved].reverse().find(v => v.snapshot); return x && x.snapshot; };

  await p.locator('#dayai').click(); await p.waitForTimeout(300);
  await p.locator('[data-want="想食好嘢"]').click();
  await p.locator('#dayai-go').click(); await p.waitForTimeout(600);
  if (process.env.SHOT) await p.screenshot({ path: process.env.SHOT + '-1.png' });
  ok('諗緊嘅時候收埋啲問題', await p.locator('.dai-form').isHidden());
  ok('諗緊有動畫同講緊做咩', await p.locator('.dai-think .ldr').count() === 1 && /Day 2/.test(await p.locator('#dai-now').innerText()));
  await p.waitForTimeout(2600);
  ok('答完頂部講返問咗咩', /想食好嘢/.test(await p.locator('.dai-asked').innerText()));
  ok('問題仍然收埋', await p.locator('.dai-form').isHidden());
  ok('全部加入喺底部', /全部加入行程（3 個）/.test(await p.locator('.dai-foot').innerText()));
  const n0 = saved.length, t0 = Date.now();
  if (process.env.SHOT) await p.screenshot({ path: process.env.SHOT + '-2.png' });
  await p.locator('[data-applyall]').click();
  await p.waitForTimeout(300);
  if (process.env.SHOT) await p.screenshot({ path: process.env.SHOT + '-3.png' });
  ok('即刻關咗個 sheet', await p.locator('#layer .sheet').count() === 0);
  { const c = await Promise.all(['仁寺洞', '廣藏市場', '清溪川'].map(t => p.locator('.stopcard', { hasText: t }).count())); ok('三個即刻喺行程度', c.every(x => x === 1), c); }
  ok('新加嘅有標記', await p.locator('.stopcard.justadded').count() === 3, await p.locator('.stopcard.justadded').count());
  await p.waitForTimeout(800);
  ok('一開始就存咗', saved.length > n0 && ['仁寺洞', '廣藏市場', '清溪川'].every(t => last().days[1].items.some(i => i.title === t)), Date.now() - t0);
  ok('有 banner 講緊補相同交通', /加咗 3 個/.test(await p.locator('#genbanner').innerText()));

  // 改要求 brings the questions back
  await p.locator('#dayai').click(); await p.waitForTimeout(200);
  await p.locator('#dayai-go').click(); await p.waitForTimeout(2900);
  await p.locator('[data-reask]').click();
  ok('改要求就返返啲問題', await p.locator('.dai-form').isVisible());
  ok('冇 JS error', !errs.length, errs);
  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
