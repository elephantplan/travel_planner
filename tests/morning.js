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
  const saved = [], transit = [], legs = [];
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
    if (body.mode === 'leg'){ legs.push(body);
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body.prefer === 'walk'
        ? { ok: true, mode: 'walk', text: '步行約 30 分鐘' }
        : { ok: true, mode: 'metro', text: '電車約 20 分鐘', fromStation: '梅田', toStation: '大阪城公園', estimated: true }) }); }
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await p.route('**tile**', r => r.abort());
  await p.goto('http://localhost:8799/trip.html?trip=1', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1200);
  await p.evaluate(() => document.querySelector('[data-go="day2"]').click());
  await p.waitForTimeout(2500);

  console.log('\nA. 由酒店出發，返酒店');
  const rows = p.locator('.hotelrow');
  ok('一日頭尾都有酒店', await rows.count() === 2, await rows.count());
  const r0 = await rows.first().innerText(), r1 = await rows.last().innerText();
  ok('頭係「由酒店出發」，尾係「返酒店」', /由酒店出發/.test(r0) && /明洞 L7 酒店/.test(r0) && /返酒店/.test(r1), [r0, r1]);
  const legT = await p.locator('.seg.hotelleg').allInnerTexts();
  ok('出門要幾耐', /地鐵約 25 分鐘/.test(legT[0] || ''), legT);
  ok('返酒店都計埋', legT.length === 2 && /分鐘/.test(legT[1] || ''), legT);
  ok('有 Google 路線', await p.locator('.seg.hotelleg').first().locator('a[href*="google.com/maps/dir"]').count() === 1);
  const last = () => { const x = [...saved].reverse().find(v => v.snapshot); return x && x.snapshot; };
  await p.evaluate(() => document.querySelector('[data-go="day1"]').click());
  await p.waitForTimeout(1500);
  const d1 = await p.locator('.hotelrow').allInnerTexts();
  ok('第一日由機場開始，淨係有返酒店', d1.length === 1 && /返酒店/.test(d1[0]), d1);

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

  console.log('\nB2. 自己揀交通方式');
  await p.locator('[data-segmode]').last().click();
  await p.waitForTimeout(300);
  ok('有得揀行路／大眾運輸／揸車', /行路/.test(await p.locator('.sheet').innerText()) && /揸車/.test(await p.locator('.sheet').innerText()) && /大眾運輸/.test(await p.locator('.sheet').innerText()));
  await p.locator('[data-pickmode="walk"]').click();
  await p.waitForTimeout(1200);
  ok('照你揀嘅方式計', legs.some(x => x.prefer === 'walk'), legs.map(x => x.prefer));
  ok('顯示新時間', /步行約 30 分鐘/.test(await p.locator('#app').innerText()));

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
  console.log('\nD. 日本：Google 冇電車資料');
  {
    const jp = JSON.parse(JSON.stringify(snap));
    jp.meta.destinationLocal = '大阪';
    jp.days[1].items.splice(3, 0, { kind: 'connector', mode: 'metro', text: '地鐵約 15 分鐘', route: '谷町四丁目 ─谷町線・2站─ 南森町', est: true });
    // a place whose name carries the opening hours never got matched on Google
    jp.days[1].items.unshift({ kind: 'stop', title: '永觀堂 (9am - 4pm)', kr: '', placeId: '', type: 'sight' },
      { kind: 'connector', mode: 'metro', text: '電車／巴士：撳 Google 睇班次（的士約 59 分鐘）', noTime: true });
    // an old 「大眾運輸約」 leg, which in Japan was really a walking time
    jp.days[1].items.splice(4, 0, { kind: 'connector', mode: 'metro', text: '大眾運輸約 32 分鐘' });
    const p2 = await (await b.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 1000 } })).newPage();
    p2.on('pageerror', e => errs.push(e.message));
    const jl = [], ja = [], jq = [];
    await p2.route('**/rest/v1/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await p2.route('**/rest/v1/itinerary_versions**', r => r.request().method() === 'POST'
      ? r.fulfill({ status: 201, contentType: 'application/json', body: '[]' })
      : r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 1, created_at: '2026-09-20T00:00:00Z',
          edited_by: 'x', source: 'seed', summary: 's', snapshot: jp, has_snapshot: true }]) }));
    await p2.route('**/functions/v1/**', r => {
      const body = JSON.parse(r.request().postData() || '{}');
      if (body.action === 'transit') ja.push(body);
      if (body.action === 'place-search'){ jq.push(body.query);
        return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ places: [{ name: '永観堂', placeId: 'pE', lat: 35.0145, lng: 135.7944 }] }) }); }
      if (body.mode === 'leg'){ jl.push(body);
        return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, mode: 'metro',
          text: '梅田駅 → 大阪城公園駅', noTime: true, fromStation: '梅田駅', toStation: '大阪城公園駅',
          note: '行 4 分鐘去車站・落車行 6 分鐘・的士約 12 分鐘・行路約 35 分鐘' }) }); }
      return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    });
    await p2.route('**tile**', r => r.abort());
    await p2.goto('http://localhost:8799/trip.html?trip=1', { waitUntil: 'domcontentloaded' });
    await p2.waitForTimeout(1200);
    await p2.evaluate(() => document.querySelector('[data-go="day2"]').click());
    await p2.waitForTimeout(2500);
    ok('日本行程用新嘅交通查詢，唔再淨係得行路', jl.length >= 1 && ja.length === 0, [jl.length, ja.length]);
    ok('冇舊版 AI 估嘅路線殘留', !/AI 估/.test(await p2.locator('#app').innerText()));
    const t2 = await p2.locator('.seg.hotelleg').first().innerText();
    ok('講明由邊個站去邊個站，有的士同行路時間做參考', /梅田駅\s*→\s*大阪城公園駅/.test(t2) && /的士約 12 分鐘/.test(t2), t2);
    const pair = await p2.locator('.seg.hotelleg .stpair').first().boundingBox();
    ok('兩個站排喺同一行（左右）', pair && pair.height < 30, pair);
    ok('Google 路線用大眾運輸模式', /travelmode=transit/.test(await p2.locator('.seg.hotelleg').first().locator('a[href*="google.com/maps/dir"]').getAttribute('href')));
    ok('唔會當「12 分鐘」嚟計時間好趕', !/時間好趕/.test(await p2.locator('#app').innerText()));
    ok('舊版 AI 估嘅交通會自動重新計', jl.some(x => x.to && x.to.placeId === 'p6'), jl.map(x => x.to));
    ok('名入面嘅營業時間唔會拎去搜尋', jq.includes('永觀堂'), jq);
    ok('配返 Google 之後重新計佢前後嘅交通', jl.some(x => x.from && x.from.placeId === 'pE'), jl.map(x => x.from));
    ok('配返之後朝早都由酒店出發', /永觀堂/.test(await p2.locator('.stopcard').first().innerText()) && await p2.locator('.hotelrow').count() === 2);
    ok('舊嘅「大眾運輸約」重新計過', !/大眾運輸約 32 分鐘/.test(await p2.locator('#app').innerText()));
    const yh = await p2.locator('.seg.hotelleg').first().locator('a[href*="transit.yahoo.co.jp"]').getAttribute('href').catch(() => '');
    ok('Yahoo!乗換案内用站名搜（唔用長嘅正式名）', /from=%E6%A2%85%E7%94%B0&to=%E5%A4%A7%E9%98%AA%E5%9F%8E%E5%85%AC%E5%9C%92$/.test(yh || ''), yh);
    ok('冇 NAVITIME 掣', await p2.locator('a[href*="navitime"]').count() === 0);
    await p2.close();
  }
  ok('冇 JS 錯誤', errs.length === 0, errs);
  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
