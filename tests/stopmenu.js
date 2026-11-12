// The 「…」 menu on a stop card: make it a backup of another stop, or delete
// it — without opening the editor.
//
//   node tests/stopmenu.js        (needs a static server on :8799)
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
  await p.route('**/functions/v1/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
  await p.route('**tile**', r => r.abort());
  await p.goto('http://localhost:8799/trip.html?trip=1', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1200);
  await p.evaluate(() => document.querySelector('[data-go="day2"]').click());
  await p.waitForTimeout(1200);
  const last = () => { const x = [...saved].reverse().find(v => v.snapshot); return x && x.snapshot; };
  const stops = sn => sn.days[1].items.filter(i => i.kind !== 'connector' && i.kind !== 'note' && i.title);
  const before = stops(snap).map(s => s.title);

  ok('每張卡都有「…」掣', await p.locator('[data-stopmenu]').count() === before.length);
  await p.locator('[data-stopmenu]').nth(1).click();
  await p.waitForTimeout(300);
  const sheet = p.locator('.sheet');
  ok('撳咗就出選單，有做後備同刪走', await sheet.locator('[data-backupof]').count() === before.length - 1 && await sheet.locator('#stopdel').count() === 1);
  ok('最近嘅站排先', (await sheet.locator('[data-backupof] .foldn').first().innerText()).length > 0);
  await sheet.locator('[data-backupof]').first().click();
  await p.waitForTimeout(800);
  let sn = last();
  const after = sn ? stops(sn) : [];
  ok('做咗後備：行程少咗一個站', after.length === before.length - 1, after.map(s => s.title));
  ok('摺咗喺揀嗰個站下面', after.some(s => (s.alts || []).some(a => a.title === before[1])), after.map(s => [s.title, (s.alts || []).map(a => a.title)]));

  // move the first stop of day 2 into day 1, between its first and second stops
  await p.locator('[data-stopmenu]').first().click();
  await p.waitForTimeout(300);
  ok('選單有「搬去第二日」', await p.locator('#stopmove').count() === 1);
  await p.locator('#stopmove').click();
  await p.waitForTimeout(300);
  await p.locator('[data-today="day1"]').click();
  await p.waitForTimeout(300);
  const rows = await p.locator('.mvlist .mvrow .mvn').allInnerTexts();
  ok('揀咗日子就見到嗰日嘅行程', rows.join('|') === '仁川機場 T1|明洞酒店 Check-in|明洞餃子', rows);
  ok('每兩個地點中間有位揀', await p.locator('[data-mvat]').count() === rows.length + 1);
  const moving = (await p.locator('.sheet .sec-sub').innerText()).match(/「(.+?)」/)[1];
  await p.locator('[data-mvat="1"]').click();
  await p.waitForTimeout(800);
  sn = last();
  const d1 = sn.days[0].items.filter(i => i.title && i.kind !== 'connector' && i.kind !== 'note').map(i => i.title);
  ok('放咗喺揀嘅位置', d1[1] === moving && d1.length === 4, d1);
  ok('搬完跳去嗰日', /明洞餃子/.test(await p.locator('#app').innerText()));
  await p.evaluate(() => document.querySelector('[data-go="day2"]').click());
  await p.waitForTimeout(800);

  const n0 = await p.locator('[data-stopmenu]').count();
  await p.locator('[data-stopmenu]').first().click();
  await p.waitForTimeout(300);
  await p.locator('#stopdel').click();
  await p.waitForTimeout(800);
  sn = last();
  ok('刪走咗', await p.locator('[data-stopmenu]').count() === n0 - 1 && stops(sn).length === before.length - 3, sn && stops(sn).map(s => s.title));
  ok('冇 JS 錯誤', errs.length === 0, errs);
  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
