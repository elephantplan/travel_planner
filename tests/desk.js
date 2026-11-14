// On a computer: the day bar scrolls with the wheel, a drag, and arrows.
// And the calendar file for the iPhone lock screen.
//
//   node tests/desk.js        (needs a static server on :8799)
const { chromium } = require('playwright');
const { snap: base } = require('./fixture.js');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c){ pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : '')); } };

(async () => {
  const snap = JSON.parse(JSON.stringify(base));
  // many days, so the bar is wider than a laptop screen
  for (let i = 4; i <= 14; i++) snap.days.push({ id: 'day' + i, date: '', title: '第 ' + i + ' 日長長嘅標題', items: [] });
  snap.days[1].items.find(i => i.title === '景福宮').time = '約 10:00';
  snap.days[1].items.find(i => i.title === '景福宮').tip = '已訂位';
  snap.flights = [{ dir: 'out', no: 'CX410', date: '2026-10-23', from: 'HKG', to: 'ICN', dep: '08:30', arr: '13:00' }];
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await b.newContext({ serviceWorkers: 'block', viewport: { width: 900, height: 800 }, acceptDownloads: true });
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.route('**/rest/v1/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await p.route('**/rest/v1/itinerary_versions**', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 1, created_at: '2026-09-20T00:00:00Z', edited_by: 'x', source: 'seed', summary: 's', snapshot: snap, has_snapshot: true }]) }));
  await p.route('**/functions/v1/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
  await p.route('**tile**', r => r.abort());
  await p.goto('http://localhost:8799/trip.html?trip=1', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1500);
  const left = () => p.evaluate(() => document.getElementById('lines').scrollLeft);
  ok('日子太多時右邊有箭咀', await p.locator('.linesnav.next').isVisible() && !(await p.locator('.linesnav.prev').isVisible()));
  const box = await p.locator('#lines').boundingBox();
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await p.mouse.wheel(0, 300); await p.waitForTimeout(300);
  const a1 = await left();
  ok('滑鼠轆可以左右碌', a1 > 0, a1);
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await p.mouse.down();
  await p.mouse.move(box.x + box.width / 2 - 200, box.y + box.height / 2, { steps: 6 }); await p.mouse.up();
  await p.waitForTimeout(200);
  const a2 = await left();
  ok('撳住拖都得', a2 > a1 + 100, [a1, a2]);
  ok('拖完唔會當撳咗日子', /overview|全程/.test(await p.evaluate(() => document.querySelector('.linebtn.on, [aria-selected="true"]')?.textContent || 'overview')));
  await p.locator('.linesnav.prev').click(); await p.waitForTimeout(600);
  ok('撳箭咀都碌得', await left() < a2, await left());
  // the calendar file
  await p.click('#btn-export'); await p.waitForTimeout(300);
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#ex-ics')]);
  const ics = require('fs').readFileSync(await dl.path(), 'utf8');
  ok('下載到日曆檔', /^BEGIN:VCALENDAR/.test(ics) && /END:VCALENDAR\r\n$/.test(ics));
  ok('每日一個全日項目', /DTSTART;VALUE=DATE:20261024[\s\S]*SUMMARY:Day 2：/.test(ics));
  ok('有時間嘅地點有時間，已訂位提早提', /DTSTART:20261024T100000\r\nDTEND:20261024T110000\r\nSUMMARY:已訂：景福宮[\s\S]*?TRIGGER:-PT1H/.test(ics), ics.slice(0, 900));
  ok('航班有提醒', /SUMMARY:✈ CX410 HKG→ICN[\s\S]*?TRIGGER:-PT3H/.test(ics));
  ok('冇 JS 錯誤', errs.length === 0, errs);
  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
