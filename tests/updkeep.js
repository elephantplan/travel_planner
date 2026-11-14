// 用相或者文字更新行程: a place the new source leaves out can be ticked to
// keep; a screenshot on the clipboard pastes straight in; and the gap
// between the last place and 返酒店 has its own ＋.
//
//   node tests/updkeep.js        (needs a static server on :8799)
const { chromium } = require('playwright');
const { snap } = require('./fixture.js');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c){ pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : '')); } };

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const p = await (await b.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 900 } })).newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  const saved = [], reads = [];
  await p.route('**/rest/v1/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await p.route('**/rest/v1/itinerary_versions**', r => {
    if (r.request().method() === 'POST'){ try { saved.push(JSON.parse(r.request().postData())); } catch (_){}
      return r.fulfill({ status: 201, contentType: 'application/json', body: '[]' }); }
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 1, created_at: '2026-09-20T00:00:00Z',
      edited_by: 'x', source: 'seed', summary: 's', snapshot: snap, has_snapshot: true }]) });
  });
  await p.route('**/functions/v1/**', r => {
    const body = JSON.parse(r.request().postData() || '{}');
    if (/trip-import/.test(r.request().url()) && !body.mode){ reads.push(body);
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, trip: { destination: '首爾', title: '', dateStart: '2026-10-24', dateEnd: '2026-10-24',
        stays: [], flights: [], notes: '', days: [{ date: '2026-10-24', title: '古宮同市場', items: [
          { kind: 'stop', type: 'normal', time: '約 10:00', title: '景福宮', kr: '', desc: '', tip: '' },
          { kind: 'stop', type: 'eat', time: '', title: '廣藏市場', kr: '광장시장', desc: '', tip: '' },
          { kind: 'stop', type: 'eat', time: '', title: '南山塔韓牛燒肉', kr: '', desc: '', tip: '' } ] }] } }) }); }
    if (body.action === 'place-search') return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ places: [{ name: body.query, placeId: 'pNEW', lat: 37.57, lng: 126.99, address: '首爾', rating: 4.3 }] }) });
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await p.route('**tile**', r => r.abort());
  await p.goto('http://localhost:8799/trip.html?trip=1', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1500);


  await p.click('#ov-update'); await p.waitForTimeout(300);
  // paste a screenshot
  await p.evaluate(() => {
    const c = document.createElement('canvas'); c.width = c.height = 4;
    const bin = atob(c.toDataURL('image/png').split(',')[1]);
    const f = new File([Uint8Array.from(bin, ch => ch.charCodeAt(0))], 'image.png', { type: 'image/png' });
    const dt = new DataTransfer(); dt.items.add(f);
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
  });
  await p.waitForTimeout(200);
  ok('貼截圖就加咗入去', (await p.locator('.updfile').count()) === 1 && !(await p.locator('#upd-read').isDisabled()), await p.locator('#upd-files').innerText());
  await p.locator('.updfile [data-rm]').click();
  await p.fill('#upd-text', 'Day 2：景福宮、廣藏市場、南山塔韓牛燒肉');
  await p.click('#upd-read'); await p.waitForTimeout(800);
  ok('要拎走嘅地點有得剔保留', await p.locator('[data-keepdrop]').count() === 1);
  await p.locator('.updkeep').first().click();
  ok('剔咗變「保留」', await p.locator('[data-keepdrop]').first().isChecked() && await p.locator('.updkeep-keep').first().isVisible());
  await p.click('#upd-go'); await p.waitForTimeout(2500);
  const last = [...saved].reverse().find(v => v.snapshot).snapshot;
  const d2 = last.days[1].items.filter(i => i.title && i.kind !== 'connector' && i.kind !== 'note').map(i => i.title);
  ok('保留咗嘅地點留喺原本嘅位（景福宮之後）', d2.join('|') === '景福宮|北村韓屋村|廣藏市場|南山塔 韓牛燒肉', d2);
  // ＋ between the last place and the hotel
  await p.evaluate(() => document.querySelector('[data-go="day2"]').click());
  await p.waitForTimeout(1000);
  const gap = await p.evaluate(() => {
    const hotel = [...document.querySelectorAll('.hotelrow')].pop();
    if (!hotel) return 'no hotel';
    const unit = hotel.closest('.unit');
    const ins = unit && unit.querySelector(':scope > .insertrow');
    return ins ? ins.dataset.insert + '|' + !!(ins.compareDocumentPosition(hotel) & Node.DOCUMENT_POSITION_FOLLOWING) : 'none';
  });
  ok('最後一站同返酒店之間有 ＋', /^\d+\|true$/.test(gap), gap);
  ok('冇重複 ＋', await p.evaluate(() => { const v = [...document.querySelectorAll('#line .insertrow')].map(b => b.dataset.insert); return new Set(v).size === v.length; }));

  ok('冇 JS 錯誤', errs.length === 0, errs);
  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
