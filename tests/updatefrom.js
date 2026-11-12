// 用相或者文字更新行程: read a new source and fold it into the trip day by
// day — places already there are kept as they are, new ones are added and
// found on Google, missing ones dropped; days not mentioned are untouched.
//
//   node tests/updatefrom.js        (needs a static server on :8799)
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

  ok('主頁有「用相或者文字更新行程」', await p.locator('#ov-update').count() === 1);
  await p.click('#ov-update'); await p.waitForTimeout(300);
  ok('可以揀相／Excel，又可以貼字', await p.locator('#upd-file').count() === 1 && await p.locator('#upd-text').count() === 1);
  ok('未揀嘢唔撳得讀取', await p.locator('#upd-read').isDisabled());
  await p.fill('#upd-text', 'Day 2：景福宮、廣藏市場、南山塔韓牛燒肉');
  await p.click('#upd-read'); await p.waitForTimeout(800);
  ok('連埋而家嘅日子一齊送去對照', reads[0] && /Day 2｜2026-10-24/.test(reads[0].text) && /廣藏市場/.test(reads[0].text), reads[0] && reads[0].text.slice(0, 200));
  const prev = await p.locator('.sheet').innerText();
  ok('先俾人睇改咩', /會改 1 日/.test(prev) && await p.locator('.updday li.keep').count() === 2 && await p.locator('.updday li.add').count() === 1 && await p.locator('.updday li.drop').count() === 1, prev.slice(0, 300));
  ok('冇咗嘅地點講明拎走', /北村韓屋村[\s\S]*拎走/.test(prev));
  ok('未撳更新就冇存', saved.length === 0);
  const kept0 = snap.days[1].items.find(i => i.title === '景福宮');
  await p.click('#upd-go'); await p.waitForTimeout(2500);
  const last = [...saved].reverse().find(v => v.snapshot).snapshot;
  const d2 = last.days[1].items.filter(i => i.title && i.kind !== 'connector' && i.kind !== 'note');
  ok('Day 2 跟新嘅次序', d2.map(i => i.title).join('|') === '景福宮|廣藏市場|南山塔 韓牛燒肉', d2.map(i => i.title));
  ok('已有嘅地點原封不動（相、placeId 保留）', d2[0].placeId === kept0.placeId && d2[0].photoUrl === kept0.photoUrl, [d2[0].placeId, kept0.placeId]);
  ok('新地點搵咗 Google', d2[1].placeId === 'pNEW' && d2[1].type === 'eat', d2[1]);
  ok('日子標題都更新', last.days[1].title === '古宮同市場');
  ok('冇提到嘅日子唔郁', JSON.stringify(last.days[0].items.map(i => i.title)) === JSON.stringify(snap.days[0].items.map(i => i.title)));
  ok('冇 JS 錯誤', errs.length === 0, errs);
  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
