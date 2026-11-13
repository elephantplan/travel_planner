// Where to sleep is proposed, not decided: the AI suggests which area for
// which nights and a few hotels per area (price, highlights, nearest
// station), each checked on Google, and the family picks one.
//
//   node tests/stays.js        (needs a static server on :8799)
const { chromium } = require('playwright');
const { snap } = require('./fixture.js');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c){ pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : '')); } };

const quickFlags = [];
const SUGGEST = { ok: true, stays: {
  areas: [{ area: '明洞', best: true, pros: '三日都喺市中心，唔使搬酒店', cons: '晚上人多', goodFor: '第一次去' },
          { area: '弘大', best: false, pros: '後生熱鬧', cons: '去景福宮要轉車', goodFor: '鍾意夜生活' }],
  plan: [{ fromDay: 1, toDay: 3, area: '明洞', why: '三日都喺市中心，唔使搬酒店' }],
  hotels: [
    { name: '明洞樂天酒店', local: '롯데호텔 서울', area: '明洞', fromDay: 1, toDay: 3, price: '每晚約 HK$1,500–2,000',
      highlights: ['乙支路入口站直達', '房間大'], station: '을지로입구역', walk: '步行約 3 分鐘' },
    { name: '明洞九樹酒店', local: '나인트리 호텔 명동', area: '明洞', fromDay: 1, toDay: 3, price: '每晚約 HK$800–1,100',
      highlights: ['價錢抵'], station: '명동역', walk: '' },
  ] } };

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await b.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 1000 } });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  const cur = JSON.parse(JSON.stringify(snap));
  const saved = [], asked = [], sentText = [], suggestText = [];
  await p.route('**/rest/v1/itinerary_versions**', r => {
    if (r.request().method() === 'POST'){ try { saved.push(JSON.parse(r.request().postData())); } catch (_){}
      return r.fulfill({ status: 201, contentType: 'application/json', body: '[]' }); }
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 1, created_at: '2026-09-20T00:00:00Z',
      edited_by: 'x', source: 'seed', summary: 's', snapshot: cur, has_snapshot: true }]) });
  });
  await p.route('**/rest/v1/ai_notes**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await p.route('**/functions/v1/**', r => {
    const url = r.request().url(), body = JSON.parse(r.request().postData() || '{}');
    if (/trip-import/.test(url) && body.mode === 'stay-check'){ asked.push(body.mode); sentText.push(body.text || '');
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, hotel: {
        area: '難波', local: 'ホリデイ・イン大阪難波', price: '兩間房每晚約 HK$2,200', roomSize: '約 22㎡，3 人住得落',
        station: 'なんば駅', walk: '步行約 5 分鐘', highlights: ['近道頓堀'], convenience: '去京都要轉車，但食嘢行街好方便',
        score: 7, scoreWhy: '行街方便，但離梅田景點遠少少' } }) });
    }
    if (/trip-import/.test(url)){ asked.push(body.mode); sentText.push(body.text || ''); suggestText.push(body.text || ''); quickFlags.push(body.quick === true);
      return new Promise(res => setTimeout(res, 600)).then(() => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SUGGEST) })); }
    if (/place-photo-store/.test(url)) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, url: 'http://localhost:8799/icons/icon-v2.svg' }) });
    if (body.action === 'place-search') return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ places: [{ name: body.query, placeId: 'pid-' + body.query.length, lat: 37.56, lng: 126.98, rating: 4.4, ratingCount: 900 }] }) });
    if (body.action === 'transit') return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, mode: 'walk', text: '步行約 4 分鐘' }) });
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await p.route('**tile**', r => r.abort());
  await p.goto('http://localhost:8799/trip.html?trip=1', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1200);

  await p.evaluate(() => document.querySelector('[data-go="stays"]').click());   // 住宿 lives on its own page
  await p.waitForTimeout(400);
  const acc = p.locator('#app');
  ok('有掣叫 AI 建議其他酒店', await acc.locator('[data-stayprefs]').count() === 1);
  await acc.locator('[data-stayprefs]').click();
  await p.waitForTimeout(300);
  // the preferences sheet: people, rooms, budget, what matters
  ok('先問要求', /你想住點樣嘅酒店/.test(await p.locator('.sheet').innerText()));
  await p.fill('[data-pf="adults"]', '6');
  await p.fill('[data-pf="kids"]', '1');
  await p.fill('[data-pf="rooms"]', '2');
  await p.locator('[data-pfone="budget"] .pfchip', { hasText: 'HK$800–1,500' }).click();
  await p.locator('[data-pfmany="focus"] .pfchip', { hasText: '有浴缸' }).click();
  await p.fill('[data-pf="area"]', '心齋橋');
  ok('講明每間房大約幾多人', /每間房 4 個人/.test(await p.locator('[data-perroom]').innerText()), await p.locator('[data-perroom]').innerText());
  await p.locator('[data-esave]').click();
  await p.waitForTimeout(2500);
  const sent = suggestText[suggestText.length - 1] || '';
  ok('要求有傳畀 AI', /6 個大人/.test(sent) && /2 間/.test(sent) && /有浴缸/.test(sent) && /HK\$800–1,500/.test(sent), sent.slice(0, 200));
  const t = await acc.innerText();
  ok('問咗住宿建議', asked.includes('stay-suggest'), asked);
  ok('想住邊區當硬性要求傳畀 AI', /想住嘅區/.test(sent) && /心齋橋/.test(sent));
  ok('有酒店位置地圖', await acc.locator('#map-stays').count() === 1);
  ok('每張卡有同地圖對應嘅字母', (await acc.locator('.sgpin').allInnerTexts()).join('') === 'AB', await acc.locator('.sgpin').allInnerTexts());
  await p.waitForTimeout(1500);
  {
    const c0 = await acc.locator('.sgh').first().innerText();
    ok('AI 推介嘅都會補返推介指數', /7\s*\/10 推介指數/.test(c0) && /約 22㎡/.test(c0), c0.slice(0, 200));
    ok('AI 自己嘅價錢唔會出「AI 估」', !/AI 估/.test(c0) && /HK\$1,500–2,000/.test(c0));
  }
  ok('講邊幾晚住邊區', /Day 1–3/.test(t) && /住明洞/.test(t) && /唔使搬酒店/.test(t), t.slice(0, 120));
  ok('列出幾個區，逐區講好處同留意', /可以住邊區/.test(t) && /弘大/.test(t) && /去景福宮要轉車/.test(t) && /AI 首選/.test(t));
  await acc.locator('.sgfilter [data-stayarea="弘大"]').click();
  await p.waitForTimeout(200);
  ok('揀區就淨係睇嗰區嘅酒店', await acc.locator('.sgh').count() === 0, await acc.locator('.sgh').count());
  await acc.locator('.sgfilter [data-stayarea=""]').click();
  await p.waitForTimeout(200);
  ok('每間酒店有價錢', /HK\$1,500–2,000/.test(t) && /網上搜尋估價/.test(t));
  ok('有好處', /乙支路入口站直達/.test(t));
  ok('最近車站同自己計嘅步行時間', /最近\s*을지로입구역\s*·\s*步行約 4 分鐘/.test(t), (t.match(/最近[\s\S]{0,30}/) || [])[0]);
  ok('有 Google 評分同相', await acc.locator('.sgh .thumb-rate').count() === 2 && await acc.locator('.sgh-photo img').count() === 2);
  const bk = await acc.locator('a', { hasText: 'Google 睇價' }).first().getAttribute('href');
  ok('有 Google 睇價連結（帶酒店名、日子、人數、房數）', /google\.com\/travel\/search/.test(bk) && bk.includes('checkin=') && bk.includes('adults=7') && bk.includes('rooms=2') && /curr=HKD/.test(bk), bk);
  // Day 1 to Day 3 of a trip starting 2026-10-23: in on the 23rd, out on the 25th
  ok('Google 用英文（Google）名去搵', /[가-힯]/.test(new URL(bk).searchParams.get('q') || '') && !/明洞樂天/.test(new URL(bk).searchParams.get('q') || ''), bk);
  ok('冇再估訂房網連結', await acc.locator('a[href*="agoda"], a[href*="booking.com"]').count() === 0);
  const when = await acc.locator('.sgh-when').first().innerText();
  ok('寫明入住、退房日子同人數', /入住 10\/23\s*・退房 10\/25/.test(when) && /6 大 1 小・2 間房/.test(when), when);
  ok('建議講明跟咗咩要求', /你嘅要求：[\s\S]*住心齋橋・6 大 1 小・2 間房・每晚 HK\$800–1,500[\s\S]*有浴缸/.test(await acc.innerText()));

  // sorting: cheapest first puts the HK$800 one on top, dearest first the HK$1,500 one
  await acc.locator('[data-staysort="cheap"]').click();
  await p.waitForTimeout(200);
  ok('平到貴', /九樹/.test(await acc.locator('.sgh-name').first().innerText()), await acc.locator('.sgh-name').first().innerText());
  await acc.locator('[data-staysort="dear"]').click();
  await p.waitForTimeout(200);
  ok('貴到平', /樂天/.test(await acc.locator('.sgh-name').first().innerText()));
  await acc.locator('[data-staysort="ai"]').click();
  await p.waitForTimeout(200);
  await acc.locator('[data-staypick="1"]').click();
  await p.waitForTimeout(900);
  const last = [...saved].reverse().find(x => x.snapshot);
  const stays = last ? last.snapshot.stays : [];
  ok('揀咗就取代嗰幾晚原本嘅酒店', stays.length === 1 && stays[0].name === '明洞九樹酒店', stays.map(s => s.name));
  ok('連埋 Google 地點同車站', stays[0] && stays[0].placeId && stays[0].station === '명동역');
  ok('揀咗嘅酒店卡唔再標「AI 建議」', !/AI 建議/.test(await p.locator('[data-hskey="acc"]').innerText()));
  // the trash on a hotel removes that hotel, not the whole 住宿 section
  p.once('dialog', d => d.accept());
  await p.locator('[data-staydelete="0"]').click();
  await p.waitForTimeout(900);
  const after = [...saved].reverse().find(x => x.snapshot);
  ok('刪酒店只係刪嗰間', after && after.snapshot.stays.length === 0, after && after.snapshot.stays.length);
  ok('住宿呢段仲喺度', await p.locator('[data-hskey="acc"]').count() === 1 && !((after.snapshot.hiddenSections || []).includes('acc')));
  ok('收埋成段係另一粒寫明嘅掣', /喺主頁收埋「住宿」/.test(await p.locator('#app').innerText()));
  // the quick box sends extra wishes straight away
  const accQ = p.locator('#app');
  await accQ.locator('#sg-extra').fill('要有停車場');
  await accQ.locator('[data-sgask]').click();
  await p.waitForTimeout(2500);
  ok('「仲有冇要啲咩」直接傳畀 AI', /今次額外要求/.test(sentText[sentText.length - 1] || '') && /停車場/.test(sentText[sentText.length - 1] || ''));
  // no extra wish needed: the button searches with the saved requirements
  const n0 = sentText.length;
  await accQ.locator('[data-sgask]').click();
  await p.waitForTimeout(250);
  ok('搵緊嘅時候喺結果位置有酒店動畫', await p.locator('.sgloading .hl-pin').count() === 1);
  await p.waitForTimeout(2500);
  ok('先攞酒店名（快速模式），詳情之後逐間補', quickFlags.length > 0 && quickFlags.every(Boolean), quickFlags);
  ok('搵完動畫就走', await p.locator('.sgloading').count() === 0);
  ok('唔使打字都撳得「AI 推介」', sentText.length === n0 + 1 && !/今次額外要求/.test(sentText[sentText.length - 1] || ''));
  ok('要求擺喺掣上面', await p.evaluate(() => { const a = document.querySelector('.sgprefs'), b = document.querySelector('[data-sgask]'); return !!(a && b && (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)); }));
  // searching again keeps what was found and asks for different ones
  // the questions can be saved without starting a search
  const before = asked.length;
  await p.locator('#app [data-stayprefs]').last().click();
  await p.waitForTimeout(300);
  await p.locator('[data-pfmany="focus"] .pfchip', { hasText: '包早餐' }).click();
  await p.locator('[data-psave]').click();
  await p.waitForTimeout(900);
  ok('「淨係儲存」唔會搵', asked.length === before);
  const sp = [...saved].reverse().find(x => x.snapshot);
  ok('要求存咗', sp && sp.snapshot.stayPrefs.focus.includes('包早餐'));
  const accB = p.locator('#app');
  await accB.locator('[data-stayprefs]').last().click();
  await p.waitForTimeout(300);
  await p.locator('[data-esave]').click();
  await p.waitForTimeout(2500);
  ok('再搵會叫 AI 唔好重複', /已經建議過/.test(suggestText[suggestText.length - 1] || '') && /明洞樂天酒店/.test(suggestText[suggestText.length - 1] || ''));
  ok('之前搵到嘅冇冇咗', await accB.locator('.sgh').count() === 2, await accB.locator('.sgh').count());
  await accB.locator('[data-stayskip="0"]').click();
  await p.waitForTimeout(900);
  ok('撳 × 淨係刪嗰間建議', await accB.locator('.sgh').count() === 1);
  const s2 = [...saved].reverse().find(x => x.snapshot);
  ok('刪咗嘅建議都存咗', s2 && s2.snapshot.staySuggest.hotels.length === 1);
  // adding one by hand puts it in the same list, on top, marked as theirs
  const accM = p.locator('#app');
  ok('標題係「住宿推薦」', /住宿推薦/.test(await accM.innerText()) && !/AI 住宿建議/.test(await accM.innerText()));
  await accM.locator('[data-staymanual]').first().click();
  await p.waitForTimeout(300);
  await p.fill('[data-mh="q"]', '難波假日酒店');
  await p.waitForTimeout(900);
  await p.locator('[data-mhp="0"]').click();
  await p.fill('[data-mh="price"]', '每晚約 HK$1,100');
  await p.fill('[data-mh="area"]', '難波');
  await p.locator('.sheet [data-esave]').click();
  await p.waitForTimeout(1500);
  const sm = [...saved].reverse().find(x => x.snapshot);
  const top = sm && sm.snapshot.staySuggest.hotels[0];
  ok('自己加嘅放最頂', top && top.manual === true && top.price === '每晚約 HK$1,100' && top.area === '難波', top);
  ok('配咗 Google 地點同相', top && top.placeId && top.photoUrl);
  ok('卡上寫明「自己加」', /自己加/.test(await accM.locator('.sgh').first().innerText()));
  const card = await accM.locator('.sgh').first().innerText();
  ok('自己加嘅都有推介指數同原因', /7\s*\/10 推介指數/.test(card) && /離梅田景點遠少少/.test(card), card.slice(0, 200));
  ok('房間大細同方唔方便', /約 22㎡/.test(card) && /去京都要轉車/.test(card));
  ok('自己打嘅價錢保留，AI 估價放隔籬', /HK\$1,100/.test(card) && /AI 估：兩間房每晚約 HK\$2,200/.test(card));
  ok('最近車站用 Google 計步行', /なんば駅[\s\S]*步行約 4 分鐘/.test(card));
  {
    await p.evaluate(() => document.querySelector('[data-go="stays"]') && document.querySelector('[data-go="stays"]').click());
    await p.waitForTimeout(400);
    if (!(await p.locator('[data-stayunpick]').count())){ await p.locator('[data-staypick]').first().click(); await p.waitForTimeout(900); }
    const pickedName = await p.locator('.stayrow .v').first().innerText();
    p.once('dialog', d => d.accept());
    const n0 = await p.locator('.sgh').count();
    ok('揀咗嘅酒店有「改日子／資料」同「唔揀呢間」', await p.locator('.stayacts [data-editsec="acc"]').count() >= 1 && await p.locator('[data-stayunpick]').count() >= 1);
    await p.locator('[data-stayunpick="0"]').click();
    await p.waitForTimeout(1200);
    const su = [...saved].reverse().find(x => x.snapshot);
    ok('唔揀之後冇咗喺已揀', su && (su.snapshot.stays || []).length === 0, su && su.snapshot.stays);
    ok('放返去推薦列表，冇唔見', su && su.snapshot.staySuggest.hotels.some(h => h.name === pickedName) && await p.locator('.sgh').count() >= n0, [pickedName, n0]);
  }
  ok('分析時傳埋人數同行程', /stay-check/.test(asked.join()) && /行程|days/.test(sentText[sentText.length - 1] || ''));
  ok('冇 JS 錯誤', errs.length === 0, errs);
  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
