// Importing an itinerary the family already has: an Excel/CSV file or
// screenshots go in, a trip comes out with every place matched on Google.
// The AI step (trip-import) is stubbed; what is tested is everything around
// it — reading the file in the browser, sending pictures, the preview, the
// trip that gets created, and trip.html finishing the places off.
//
//   node tests/import.js        (needs a static server on :8799, and the
//                                xlsx package next to playwright)
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path'), os = require('os');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c){ pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : '')); } };

const XLSX_JS = require.resolve('xlsx/dist/xlsx.full.min.js');
const XLSX = require('xlsx');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'imp-'));
const csvPath = path.join(TMP, 'trip.csv');
fs.writeFileSync(csvPath, '日子,時間,地點,備註\n12/30,10:00,中正紀念堂,\n12/30,12:30,鼎泰豐 信義店,要排隊\n12/31,,九份老街,\n');
const xlsxPath = path.join(TMP, 'trip.xlsx');
{ const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['日子','地點'],['Day 1','台北101'],['Day 2','士林夜市']]), '行程');
  XLSX.writeFile(wb, xlsxPath); }
const pngPath = path.join(TMP, 'shot.png');
fs.writeFileSync(pngPath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));

const TRIP = {
  destination: '台北', title: '台北跨年', dateStart: '2026-12-30', dateEnd: '2026-12-31',
  stays: [{ name: '台北晶華酒店', kr: '', fromDay: 1, toDay: 2 }],
  notes: '',
  days: [
    { date: '2026-12-30', title: '市中心', items: [
      { kind: 'stop', type: 'normal', time: '約 10:00', title: '中正紀念堂', kr: '', desc: '', tip: '' },
      { kind: 'note', type: 'normal', time: '', title: '買悠遊卡', kr: '', desc: '', tip: '' },
      { kind: 'stop', type: 'eat', time: '約 12:30', title: '鼎泰豐 信義店', kr: '', desc: '', tip: '要排隊' } ] },
    { date: '2026-12-31', title: '九份', items: [
      { kind: 'stop', type: 'normal', time: '', title: '九份老街', kr: '', desc: '', tip: '' } ] },
  ],
};

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await b.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 900 } });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  const sentToImport = []; let createdTrip = null, createdSnap = null; const saves = [];
  await p.route('**cdnjs.cloudflare.com/ajax/libs/xlsx/**', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(XLSX_JS) }));
  await p.route('**/functions/v1/trip-import', r => { sentToImport.push(JSON.parse(r.request().postData() || '{}'));
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, trip: TRIP }) }); });
  await p.route('**/functions/v1/ai-assistant', r => {
    const body = JSON.parse(r.request().postData() || '{}');
    if (body.action === 'place-search') return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ places: [{ name: body.query, placeId: 'pid-' + encodeURIComponent(body.query), lat: 25.03, lng: 121.56, rating: 4.5 }] }) });
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await p.route('**/functions/v1/**', r => r.fallback());
  await p.route(/functions\/v1\/(place-photo-store|place-local-name)/, r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, url: 'http://localhost:8799/icons/icon-v2.svg' }) }));
  await p.route('**/rest/v1/trips**', r => {
    if (r.request().method() === 'POST'){ createdTrip = JSON.parse(r.request().postData());
      return r.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify([{ id: 77, ...createdTrip }]) }); }
    return r.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await p.route('**/rest/v1/itinerary_versions**', r => {
    if (r.request().method() === 'POST'){ const d = JSON.parse(r.request().postData()); if (!createdSnap) createdSnap = d.snapshot; else saves.push(d);
      return r.fulfill({ status: 201, contentType: 'application/json', body: '[]' }); }
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 1, created_at: '2026-11-09T00:00:00Z',
      edited_by: 'x', source: 'seed', summary: 's', snapshot: createdSnap, has_snapshot: true }]) });
  });
  await p.route('**/rest/v1/ai_notes**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await p.route('**tile**', r => r.abort());
  await p.goto('http://localhost:8799/index.html', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(600);

  console.log('\nA. 揀檔案');
  ok('主頁有導入入口', await p.locator('#btn-import').isVisible());
  await p.locator('#btn-import').click();
  ok('撳之前讀取掣未得撳', await p.locator('#imp-read').isDisabled());
  await p.setInputFiles('#imp-file', [csvPath, xlsxPath, pngPath]);
  await p.waitForTimeout(200);
  ok('三個檔案都列咗出嚟', await p.locator('.impfile').count() === 3);
  await p.locator('#imp-read').click();
  await p.waitForSelector('#imp-go', { timeout: 15000 });
  const sent = sentToImport[0] || {};
  ok('CSV 內容送咗去', /中正紀念堂/.test(sent.text || ''), (sent.text || '').slice(0, 80));
  ok('Excel 喺瀏覽器讀成文字', /台北101/.test(sent.text || '') && /士林夜市/.test(sent.text || ''));
  ok('截圖以圖片送去', (sent.images || []).length === 1 && sent.images[0].mime === 'image/jpeg');

  console.log('\nB. 預覽');
  const prev = await p.locator('.importsheet').innerText();
  ok('講明讀到幾多日', /讀到 2 日行程/.test(prev));
  ok('每日嘅地點都睇到', /中正紀念堂/.test(prev) && /九份老街/.test(prev));
  ok('日子預填好', await p.locator('#imp-start').inputValue() === '2026-12-30');
  ok('回程自動計', /2026-12-31/.test(await p.locator('#imp-end').innerText()));
  ok('住宿讀到', /台北晶華酒店/.test(prev));

  console.log('\nC. 開行程');
  await Promise.all([p.waitForURL(/trip\.html\?.*import=1/, { timeout: 15000 }), p.locator('#imp-go').click()]);
  ok('建立咗行程', createdTrip && createdTrip.destination_local === '台北' && createdTrip.date_start === '2026-12-30', createdTrip);
  const d1 = (createdSnap && createdSnap.days[0]) || { items: [] };
  ok('地點、提醒、時間都照抄', d1.items.length === 3 && d1.items[0].title === '中正紀念堂' && d1.items[1].kind === 'note'
     && d1.items[2].time === '約 12:30' && d1.items[2].type === 'eat', d1.items);
  ok('住宿對返日子', createdSnap && createdSnap.stays[0].from === 'day1' && createdSnap.stays[0].to === 'day2', createdSnap && createdSnap.stays);
  ok('日標題用返來源', createdSnap && createdSnap.days[1].title === '九份');

  console.log('\nD. trip.html 幫每個地點配返 Google');
  await p.waitForTimeout(6000);
  const last = [...saves].reverse().find(x => x.snapshot);
  const stops = last ? last.snapshot.days.flatMap(d => d.items.filter(i => i.kind === 'stop')) : [];
  ok('每個地點都配咗 place id', stops.length === 3 && stops.every(s => s.placeId), stops.map(s => [s.title, s.placeId]));
  ok('有座標', stops.every(s => Number.isFinite(s.lat)));
  ok('有相', stops.every(s => s.photoUrl), stops.map(s => s.photoUrl));
  ok('冇 JS 錯誤', errs.length === 0, errs);
  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
