// A place added where it makes a detour: the app says where it would be
// more on the way, and one tap moves it there.
//
//   node tests/betterspot.js        (needs a static server on :8799)
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
  const saved = [];
  await p.route('**/rest/v1/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await p.route('**/rest/v1/itinerary_versions**', r => {
    if (r.request().method() === 'POST'){ try { saved.push(JSON.parse(r.request().postData())); } catch (_){}
      return r.fulfill({ status: 201, contentType: 'application/json', body: '[]' }); }
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 1, created_at: '2026-09-20T00:00:00Z',
      edited_by: 'x', source: 'seed', summary: 's', snapshot: snap, has_snapshot: true }]) });
  });
  await p.route('**/functions/v1/**', r => {
    let b = {}; try { b = JSON.parse(r.request().postData() || '{}'); } catch (_){}
    if (b.mode === 'near-search') return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true,
      places: [{ placeId: 'pMD', name: '明洞炸雞', lat: 37.5630, lng: 126.9850, meters: 2000, rating: 4.3, ratingCount: 300 }] }) });
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await p.route('**tile**', r => r.abort());
  await p.goto('http://localhost:8799/trip.html?trip=1', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1200);
  await p.evaluate(() => document.querySelector('[data-go="day2"]').click());
  await p.waitForTimeout(1200);
  const last = () => { const x = [...saved].reverse().find(v => v.snapshot); return x && x.snapshot; };
  const stops = sn => sn.days[1].items.filter(i => i.kind !== 'connector' && i.kind !== 'note' && i.title).map(s => s.title);
  // add it between 景福宮 and 北村 (both up north); it is down by 明洞
  await p.locator('.insertrow[data-insert="1"]').first().click(); await p.waitForTimeout(300);
  await p.fill('#ins-q', '明洞炸雞'); await p.waitForTimeout(1200);
  await p.locator('#ins-res .nr-add').first().click();
  await p.waitForTimeout(2500);
  const bar = p.locator('.hintbar');
  ok('話你放第二個位會順路啲', await bar.count() === 1 && /順路/.test(await bar.innerText()), await bar.count() && await bar.innerText());
  await bar.locator('.btn').click();
  await p.waitForTimeout(1500);
  const sn = last();
  const where = sn.days.map(d => d.items.filter(i => i.kind === 'stop').map(i => i.title));
  ok('撳一下就搬咗去順路嗰度', !where[1].slice(0, 2).includes('明洞炸雞') && where.flat().includes('明洞炸雞'), where);
  ok('冇 JS error', !errs.length, errs);
  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
