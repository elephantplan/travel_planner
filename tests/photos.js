// Places added by the AI, or typed in without picking a Google result, used
// to arrive with no photo, and the only fix was a button per day. Opening a
// day now fills them in by itself.
//
//   node tests/photos.js        (needs a static server on :8799)
const { chromium } = require('playwright');
const { snap } = require('./fixture.js');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c){ pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : '')); } };

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await b.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 1000 } });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  const cur = JSON.parse(JSON.stringify(snap));
  cur.days.forEach(d => d.items.forEach(i => { delete i.photoUrl; delete i.noPhoto; }));
  const saved = []; const asked = [];
  await p.route('**/rest/v1/itinerary_versions**', r => {
    if (r.request().method() === 'POST'){ try { saved.push(JSON.parse(r.request().postData() || '{}')); } catch (_){}
      return r.fulfill({ status: 201, contentType: 'application/json', body: '[]' }); }
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 1,
      created_at: '2026-09-20T00:00:00Z', edited_by: 'x', source: 'seed', summary: 's', snapshot: cur, has_snapshot: true }]) });
  });
  await p.route('**/rest/v1/ai_notes**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await p.route('**/functions/v1/**', async r => {
    let body = {}; try { body = JSON.parse(r.request().postData() || '{}'); } catch (_){}
    if ('count' in body && ('placeId' in body || 'query' in body)){
      asked.push(body.placeId || body.query);
      return r.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ ok: true, url: 'http://localhost:8799/icons/icon-v2.svg?' + (body.placeId || 'q') }) });
    }
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await p.route('**tile**', r => r.abort());
  await p.goto('http://localhost:8799/trip.html?trip=1', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1000);
  await p.evaluate(() => document.querySelector('.dayline[data-go="day1"]').click());
  await p.waitForTimeout(3000);

  const stops = cur.days[0].items.filter(i => i.kind === 'stop' && (i.placeId || i.mapUrl));
  ok('冇相嘅地點都自動去攞', stops.length > 0 && asked.length >= stops.length, { stops: stops.length, asked });
  ok('畫面即刻見到相', await p.locator('.thumb img').count() >= stops.length, await p.locator('.thumb img').count());
  // background upkeep is flushed when the app goes to the background
  await p.evaluate(() => { Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange')); });
  await p.waitForTimeout(1000);
  const last = [...saved].reverse().find(x => x.snapshot);
  const got = last ? last.snapshot.days[0].items.filter(i => i.photoUrl).length : 0;
  ok('存返落 server', got >= stops.length, got);
  ok('唔使撳「攞返地點相」', await p.locator('#getphotos').count() === 0);
  ok('冇 JS 錯誤', errs.length === 0, errs);
  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
