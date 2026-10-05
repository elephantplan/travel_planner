// Map buttons: which map a trip gets, what a button actually opens, and what
// happens to rows that are not places. Every section here exists because
// something in it shipped broken once.
//
//   node tests/maps.js        (needs a static server on :8799 at the repo root)
const { chromium } = require('playwright');
const { snap } = require('./fixture.js');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c){ pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : '')); } };

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

  async function boot(s0, goDay){
    const ctx = await b.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 1000 }, colorScheme: 'dark' });
    const p = await ctx.newPage();
    const errs = []; p.on('pageerror', e => errs.push(e.message));
    const cur = JSON.parse(JSON.stringify(s0));
    await p.route('**/rest/v1/itinerary_versions**', r => r.request().method() === 'POST'
      ? r.fulfill({ status: 201, contentType: 'application/json', body: '[]' })
      : r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 1,
          created_at: '2026-09-20T00:00:00Z', edited_by: 'x', source: 'seed', summary: 's',
          snapshot: cur, has_snapshot: true }]) }));
    await p.route('**/rest/v1/ai_notes**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await p.route('**/functions/v1/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
    await p.route('**tile**', r => r.abort());
    await p.goto('http://localhost:8799/trip.html?trip=1', { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(1000);
    if (goDay !== null){
      await p.evaluate(id => document.querySelector(`.dayline[data-go="${id}"]`).click(), goDay || 'day2');
      await p.waitForTimeout(600);
    }
    return { p, errs };
  }
  const hrefsOf = p => p.evaluate(() =>
    Array.from(document.querySelectorAll('a')).map(a => a.getAttribute('href') || '').join(' '));

  // A computed leg, as the app stores one. It has to sit immediately before a
  // stop: toUnits only pairs a connector with the stop that follows it.
  const korea = JSON.parse(JSON.stringify(snap));
  korea.days[1].items.splice(2, 0, { kind: 'connector', mode: 'metro', text: '地鐵約 18 分鐘',
    html: '<span class="icon"></span>地鐵約 18 分鐘' });

  // A genuinely non-Korean trip. Relabelling a Korean itinerary is not enough:
  // Korea is read off the itinerary too, so the stops stop being Korean as
  // well — which is what a real Tokyo trip looks like.
  function tokyoify(base){
    const t = JSON.parse(JSON.stringify(base));
    t.meta.destinationLocal = '東京';
    t.meta.title = '東京紅葉行';
    t.meta.eyebrow = '';
    (t.days || []).forEach(d => (d.items || []).forEach(i => { if (i.kr) i.kr = 'とうきょう'; }));
    return t;
  }

  console.log('\nA. 韓國行程：每個地點、每段路都有得開地圖');
  {
    const { p, errs } = await boot(korea);
    const foot = await p.locator('.stopfoot .maplink').evaluateAll(els => els.map(e => e.getAttribute('href') || ''));
    ok('每個地點有 Google 地圖', foot.some(h => /google\.com\/maps/.test(h)));
    ok('每個地點有 Naver 地圖', foot.some(h => /map\.naver\.com\/p\/search/.test(h)));

    const seg = await p.locator('.seg-links a').evaluateAll(els => els.map(e => e.getAttribute('href')));
    ok('交通段有路線掣', seg.length >= 2, seg.length);
    const g = seg.find(h => /google/.test(h)) || '';
    ok('Google 路線用 dir API', /\/maps\/dir\/\?api=1/.test(g), g);
    ok('Google 路線帶起點同終點', /origin=37\.5/.test(g) && /destination=37\.5/.test(g), g);
    ok('地鐵段用 transit 模式', /travelmode=transit/.test(g), g);
    const n = seg.find(h => /naver/.test(h)) || '';
    ok('Naver 路線係 directions URL', /map\.naver\.com\/p\/directions\//.test(n), n);
    ok('Naver 用「經度,緯度」次序', /directions\/126\.9\d+,37\.5\d+/.test(n), n);
    ok('Naver 段尾有交通模式', /\/-\/transit$/.test(n), n);

    const day = await p.locator('.dayroutes a').evaluateAll(els => els.map(e => e.getAttribute('href')));
    ok('有成日路線掣', day.length >= 1, day.length);
    const d = day.find(h => /google/.test(h)) || '';
    ok('成日路線帶 waypoints', /waypoints=/.test(d), d);
    ok('冇 JS 錯誤', errs.length === 0, errs);
    await p.close();
  }

  console.log('\nB. 邊個地圖行先：韓國用 Naver，其他地方用 Google');
  {
    const { p, errs } = await boot(korea);
    const order = sel => p.locator(sel).first().evaluateAll(els => els.length
      ? Array.from(els[0].querySelectorAll('a')).map(a => /naver/.test(a.getAttribute('href') || '') ? 'naver' : 'google') : []);
    const foot = await order('.stopfoot');
    ok('地點掣：Naver 排喺 Google 前面', foot.indexOf('naver') === 0 && foot.includes('google'), foot);
    const seg = await order('.seg-links');
    ok('交通段：Naver 行先', seg[0] === 'naver' && seg.includes('google'), seg);
    const day = await order('.dayroutes');
    ok('成日路線：Naver 行先', day[0] === 'naver' && day.includes('google'), day);
    ok('冇 JS 錯誤', errs.length === 0, errs);
    await p.close();
  }
  {
    const { p, errs } = await boot(tokyoify(korea));
    const all = await hrefsOf(p);
    ok('東京行程完全冇 Naver', !/naver/.test(all));
    ok('東京行程照樣有 Google 路線', /maps\/dir\/\?api=1/.test(all));
    ok('冇 JS 錯誤', errs.length === 0, errs);
    await p.close();
  }

  console.log('\nC. 冇座標就唔扮有路線');
  {
    const noxy = JSON.parse(JSON.stringify(korea));
    noxy.days[1].items.forEach(i => { delete i.lat; delete i.lng; });
    noxy.stays[0].lat = undefined; noxy.stays[0].lng = undefined;
    const { p, errs } = await boot(noxy);
    ok('冇成日路線掣', await p.locator('.dayroutes').count() === 0);
    const seg = await p.locator('.seg-links a').evaluateAll(els => els.map(e => e.getAttribute('href')));
    ok('Naver 段唔會出（要座標）', !seg.some(h => /naver/.test(h)), seg);
    ok('冇 JS 錯誤', errs.length === 0, errs);
    await p.close();
  }

  // Reported: places the AI puts on a board get a NAVER url written into
  // mapUrl, and the card rendered it raw under a button labelled "Google 地圖".
  console.log('\nD. 「Google 地圖」一定要開 Google');
  {
    const mixed = JSON.parse(JSON.stringify(korea));
    const stops = mixed.days[1].items.filter(i => i.kind === 'stop');
    stops[0].title = '豚壽百 弘大直營店';
    stops[0].kr = '돈수백 홍대직영점';
    stops[0].placeId = 'PID_DONSUBAEK';
    stops[0].mapUrl = 'https://map.naver.com/p/search/%EB%8F%88%EC%88%98%EB%B0%B1';
    if (stops[1]) stops[1].mapUrl = 'https://www.google.com/maps/search/?api=1&query=already+google';
    if (stops[2]) stops[2].mapUrl = 'https://map.kakao.com/?q=test';

    const { p, errs } = await boot(mixed);
    const foot = p.locator('.stopfoot').first();
    const href = await foot.locator('a.maplink').filter({ hasText: 'Google 地圖' }).first().getAttribute('href');
    ok('「Google 地圖」唔會開咗 Naver', !/naver/i.test(href), href);
    ok('真係 Google Maps', /google\.[a-z.]+\/maps/i.test(href), href);
    ok('用返 place id，開啱間舖', /query_place_id=PID_DONSUBAEK/.test(href), href);
    const nv = await foot.locator('a.maplink').filter({ hasText: 'Naver 地圖' }).first().getAttribute('href');
    ok('Naver 掣照樣開 Naver', /map\.naver\.com/.test(nv), nv);

    const all = await p.locator('.stopfoot').evaluateAll(els => els.map(e =>
      Array.from(e.querySelectorAll('a.maplink')).map(a => a.textContent.trim() + '|' + a.getAttribute('href'))));
    ok('本身已經係 Google 嘅連結會照用',
       (all[1] || []).some(x => /^Google 地圖\|.*already\+google/.test(x)), all[1]);
    ok('貼咗第三方地圖唔會扮 Google',
       !(all[2] || []).some(x => /^Google 地圖\|.*kakao/.test(x)), all[2]);
    ok('第三方地圖用返自己個名留返低',
       (all[2] || []).some(x => /^自訂地圖\|.*kakao/.test(x)), all[2]);
    ok('冇 JS 錯誤', errs.length === 0, errs);
    await p.close();
  }

  // Reported: 目的地本地語言名 read 「首爾」 rather than 「서울」, and every Naver
  // button on every page disappeared. Script is not a fact about a trip.
  console.log('\nE. 目的地寫中文都仲係識得認韓國');
  {
    const cn = JSON.parse(JSON.stringify(korea));
    cn.meta.destinationLocal = '首爾';
    const { p, errs } = await boot(cn);
    const all = await hrefsOf(p);
    ok('寫「首爾」都有 Naver 地圖', /map\.naver\.com\/p\/search/.test(all));
    ok('寫「首爾」都有 Naver 路線', /map\.naver\.com\/p\/directions/.test(all));
    ok('冇 JS 錯誤', errs.length === 0, errs);
    await p.close();
  }
  {
    const bare = JSON.parse(JSON.stringify(korea));
    bare.meta.destinationLocal = ''; bare.meta.title = '我哋嘅行程'; bare.meta.eyebrow = '';
    const { p, errs } = await boot(bare);
    ok('乜都冇寫，靠行程入面啲韓文都認得出', /map\.naver\.com/.test(await hrefsOf(p)));
    ok('冇 JS 錯誤', errs.length === 0, errs);
    await p.close();
  }
  {
    const jp = tokyoify(korea);
    jp.days[1].items.filter(i => i.kind === 'stop')[0].kr = '한우';   // one Korean place in Tokyo
    const { p, errs } = await boot(jp);
    ok('東京行程入面一間韓國餐廳唔算去咗韓國', !/naver/.test(await hrefsOf(p)));
    ok('冇 JS 錯誤', errs.length === 0, errs);
    await p.close();
  }

  // Reported: tapping the map on 「酒店出發」 searched Google for the words
  // 「酒店出發」 instead of taking you to the hotel.
  console.log('\nF. 「酒店出發」要指住間酒店');
  {
    const hotel = JSON.parse(JSON.stringify(korea));
    hotel.stays[0].kr = '명동 L7 호텔';
    hotel.days[1].items.unshift(
      { kind: 'stop', time: '08:30', title: '酒店出發' },
      { kind: 'connector', mode: 'metro', text: '地鐵約 12 分鐘',
        html: '<span class="icon"></span>地鐵約 12 分鐘' });
    hotel.days[1].items.push({ kind: 'stop', time: '21:00', title: '自由漫遊／拍照時光' });
    const { p, errs } = await boot(hotel);

    const first = await p.locator('.stopfoot').first().locator('a.maplink')
      .evaluateAll(els => els.map(a => a.textContent.trim() + '|' + a.getAttribute('href')));
    ok('「酒店出發」有地圖掣', first.length >= 1, first);
    ok('唔會搵「酒店出發」呢四個字',
       !first.some(h => /酒店出發|%E9%85%92%E5%BA%97%E5%87%BA%E7%99%BC/.test(h)), first);
    ok('Naver 搵間酒店個韓文名', first.some(h => /naver.*%ED%98%B8%ED%85%94|naver.*호텔/.test(h)), first);
    ok('Google 搵返間酒店', first.some(h => /google.*(L7|%4CL7|%E6%98%8E%E6%B4%9E)/i.test(h)), first);

    const seg = await p.locator('.seg-links a').evaluateAll(els => els.map(e => e.getAttribute('href')));
    ok('第一段 Naver 路線由酒店座標出發',
       /directions\/126\.9827,37\.5636/.test(seg.find(h => /naver/.test(h)) || ''), seg[0]);
    ok('第一段 Google 路線都係由酒店座標出發',
       /origin=37\.5636/.test(seg.find(h => /google/.test(h)) || ''), seg[1]);

    const roam = await p.locator('.stopcard').evaluateAll(els => {
      const e = els.find(x => /自由漫遊/.test(x.textContent || ''));
      return e ? Array.from(e.querySelectorAll('a.maplink')).map(a => a.getAttribute('href')) : null;
    });
    ok('「自由漫遊」照樣出到嚟', roam !== null);
    ok('「自由漫遊」唔會扮有地點', Array.isArray(roam) && roam.length === 0, roam);
    ok('冇 JS 錯誤', errs.length === 0, errs);
    await p.close();
  }

  // Reported: the hotel's Naver button opened a search for
  // "562-34 Yeonnam-dong, Mapo-gu" and Naver answered "No results found".
  // Naver's index is Korean text; romanisation finds nothing, ever.
  console.log('\nG. 英文拼音地址唔會送去 Naver');
  {
    const romanised = JSON.parse(JSON.stringify(korea));
    romanised.stays[0].name = '562-34 Yeonnam-dong, Mapo-gu, Seoul';
    romanised.stays[0].desc = '';
    const { p, errs } = await boot(romanised, null);   // stay on the overview
    const stay = p.locator('[data-hskey="acc"]');
    const links = await stay.locator('a.maplink').evaluateAll(els =>
      els.map(a => a.textContent.trim() + '|' + a.getAttribute('href')));
    ok('唔會畀粒一定搵唔到嘅 Naver 掣', !links.some(x => /naver/.test(x)), links);
    ok('Google 照出，因為佢讀得明拼音', links.some(x => /^Google 地圖/.test(x)), links);
    ok('話返畀人知點解冇 Naver', /Naver 搵唔到英文拼音地址/.test(await stay.innerText()));
    ok('冇 JS 錯誤', errs.length === 0, errs);
    await p.close();
  }
  {
    const withKr = JSON.parse(JSON.stringify(korea));
    withKr.stays[0].name = '562-34 Yeonnam-dong, Mapo-gu, Seoul';
    withKr.stays[0].kr = '서울 마포구 연남동 562-34';
    const { p, errs } = await boot(withKr, null);
    const stay = p.locator('[data-hskey="acc"]');
    const links = await stay.locator('a.maplink').evaluateAll(els =>
      els.map(a => a.textContent.trim() + '|' + a.getAttribute('href')));
    ok('填咗韓文地址就有返 Naver', links.some(x => /^Naver 地圖\|.*map\.naver\.com/.test(x)), links);
    ok('Naver 搵嘅係韓文，唔係拼音',
       links.some(x => /naver.*%EC%97%B0%EB%82%A8%EB%8F%99/.test(x)), links);
    ok('提示收返埋', !/Naver 搵唔到英文拼音地址/.test(await stay.innerText()));
    ok('冇 JS 錯誤', errs.length === 0, errs);
    await p.close();
  }

  console.log('\nH. 住宿自己一段，唔再收喺「行前準備」入面');
  {
    const { p, errs } = await boot(korea, null);
    ok('住宿係主頁上自己一段', await p.locator('[data-fold="stay"]').count() === 1);
    ok('唔使撳就見到間酒店', /L7/.test(await p.locator('.fold.open .fold-body').first().innerText()));
    ok('「行前準備」嗰度冇咗住宿', !/住宿/.test(await p.locator('[data-fold="prep"]').innerText()));
    ok('冇 JS 錯誤', errs.length === 0, errs);
    await p.close();
  }

  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
