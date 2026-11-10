// Each morning starts at the hotel: the leg to the day's first place is timed
// like any other. Legs left stale by an edit are re-asked without a button,
// a stop's 提醒 can be edited, and the hours line says it once.
//
//   node tests/morning.js        (needs a static server on :8799)
const { chromium } = require('playwright');
const { snap } = require('./fixture.js');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c){ pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : '')); } };

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const p = await (await b.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 1000 } })).newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  const cur = JSON.parse(JSON.stringify(snap));
  const d2 = cur.days[1].items;
  d2[0].tip = '已訂位';
  d2[0].weekdayText = ['星期一: 09:00 – 18:00', '星期二: 休息', '星期三: 09:00 – 18:00', '星期四: 09:00 – 18:00',
                       '星期五: 09:00 – 18:00', '星期六: 09:00 – 18:00', '星期日: 09:00 – 18:00'];
  d2[0].eatMeta = [{ cls: 'meta-chip hours', text: '星期一、三至日 09:00–18:00；星期二休息' }];
  d2[2].kr = '北村韓屋村';
  // an edit left the leg into 南山 flagged
  d2.splice(3, 0, { kind: 'connector', html: '', stale: true });
  const saved = [], transit = [];
  await p.route('**/rest/v1/itinerary_versions**', r => {
    if (r.request().method() === 'POST'){ try { saved.push(JSON.parse(r.request().postData())); } catch (_){}
      return r.fulfill({ status: 201, contentType: 'application/json', body: '[]' }); }
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 1, created_at: '2026-09-20T00:00:00Z',
      edited_by: 'x', source: 'seed', summary: 's', snapshot: cur, has_snapshot: true }]) });
  });
  await p.route('**/rest/v1/ai_notes**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await p.route('**/functions/v1/**', r => {
    const body = JSON.parse(r.request().postData() || '{}');
    if (body.action === 'transit'){ transit.push(body);
      const fromHotel = body.from && Number.isFinite(body.from.lat) && body.from.lat === 37.5636;
      return r.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ ok: true, mode: 'metro', text: fromHotel ? '地鐵約 25 分鐘' : '地鐵約 18 分鐘' }) }); }
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await p.route('**tile**', r => r.abort());
  await p.goto('http://localhost:8799/trip.html?trip=1', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1200);
  await p.evaluate(() => document.querySelector('[data-go="day2"]').click());
  await p.waitForTimeout(2500);

  console.log('\nA. 由酒店出發');
  const leg = p.locator('.hotelleg');
  ok('第一個地點前面有由酒店出發嗰段', await leg.count() === 1);
  const lt = await leg.innerText();
  ok('講明由邊間酒店出發同要幾耐', /由 明洞 L7 酒店 出發/.test(lt) && /地鐵約 25 分鐘/.test(lt), lt);
  ok('有 Google 路線', await leg.locator('a[href*="google.com/maps/dir"]').count() === 1);
  const last = () => { const x = [...saved].reverse().find(v => v.snapshot); return x && x.snapshot; };
  await p.evaluate(() => document.querySelector('[data-go="day1"]').click());
  await p.waitForTimeout(800);
  ok('第一日（由機場開始）冇呢段', await p.locator('.hotelleg').count() === 0);

  console.log('\nB. 交通自動更新');
  await p.evaluate(() => document.querySelector('[data-go="day2"]').click());
  await p.waitForTimeout(800);
  const t = await p.locator('#app').innerText();
  ok('冇再叫你自己撳重算', !/次序改咗/.test(t), (t.match(/次序改咗[^\n]*/) || [])[0]);
  ok('自動問咗 Google', transit.some(x => x.to && x.to.placeId === 'p6'), transit.map(x => x.to));
  ok('新時間顯示咗', /地鐵約 18 分鐘/.test(t));
  const n = transit.length;
  await p.evaluate(() => document.querySelector('[data-go="day1"]').click());
  await p.waitForTimeout(300);
  await p.evaluate(() => document.querySelector('[data-go="day2"]').click());
  await p.waitForTimeout(1200);
  ok('計過嘅唔會一開就再問', transit.length === n, transit.length - n);

  console.log('\nC. 提醒同營業時間');
  const card = p.locator('.stopcard').first();
  ok('卡上見到提醒', /已訂位/.test(await card.locator('.tipbox').innerText()));
  const hrs = await card.locator('.meta-chip.hours').allInnerTexts();
  ok('營業時間得一粒，講埋休息日', hrs.length === 1 && /09:00–18:00（星期二休息）/.test(hrs[0]), hrs);
  await card.locator('[data-open]').click();
  await p.waitForTimeout(300);
  const tip = p.locator('[data-editor] [data-f="tip"]');
  ok('編輯入面改得提醒', await tip.inputValue() === '已訂位');
  await tip.fill('');
  await p.locator('.stopcard').first().locator('[data-open]').click();
  await p.waitForTimeout(1600);
  ok('清空就冇咗', await p.locator('.stopcard').first().locator('.tipbox').count() === 0);
  ok('存咗', last() && !last().days[1].items[0].tip);
  ok('由酒店出發嘅時間跟住一齊存低', last() && last().days[1].hotelLeg && /25 分鐘/.test(last().days[1].hotelLeg.text));
  ok('中文名同當地名一樣就唔寫兩次', !/北村韓屋村\s*北村韓屋村/.test(await p.locator('#app').innerText()));
  ok('冇 JS 錯誤', errs.length === 0, errs);
  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
