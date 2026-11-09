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

const SUGGEST = { ok: true, stays: {
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
  const saved = [], asked = [], sentText = [];
  await p.route('**/rest/v1/itinerary_versions**', r => {
    if (r.request().method() === 'POST'){ try { saved.push(JSON.parse(r.request().postData())); } catch (_){}
      return r.fulfill({ status: 201, contentType: 'application/json', body: '[]' }); }
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 1, created_at: '2026-09-20T00:00:00Z',
      edited_by: 'x', source: 'seed', summary: 's', snapshot: cur, has_snapshot: true }]) });
  });
  await p.route('**/rest/v1/ai_notes**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await p.route('**/functions/v1/**', r => {
    const url = r.request().url(), body = JSON.parse(r.request().postData() || '{}');
    if (/trip-import/.test(url)){ asked.push(body.mode); sentText.push(body.text || ''); return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SUGGEST) }); }
    if (/place-photo-store/.test(url)) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, url: 'http://localhost:8799/icons/icon-v2.svg' }) });
    if (body.action === 'place-search') return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ places: [{ name: body.query, placeId: 'pid-' + body.query.length, lat: 37.56, lng: 126.98, rating: 4.4, ratingCount: 900 }] }) });
    if (body.action === 'transit') return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, mode: 'walk', text: '步行約 4 分鐘' }) });
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await p.route('**tile**', r => r.abort());
  await p.goto('http://localhost:8799/trip.html?trip=1', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1200);

  const acc = p.locator('[data-fold="stay"]').locator('xpath=..');
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
  ok('講明每間房大約幾多人', /每間房 4 個人/.test(await p.locator('[data-perroom]').innerText()), await p.locator('[data-perroom]').innerText());
  await p.locator('[data-esave]').click();
  await p.waitForTimeout(2500);
  const sent = sentText[sentText.length - 1] || '';
  ok('要求有傳畀 AI', /6 個大人/.test(sent) && /2 間/.test(sent) && /有浴缸/.test(sent) && /HK\$800–1,500/.test(sent), sent.slice(0, 200));
  const t = await acc.innerText();
  ok('問咗住宿建議', asked.includes('stay-suggest'), asked);
  ok('講邊幾晚住邊區', /Day 1–3/.test(t) && /住明洞/.test(t) && /唔使搬酒店/.test(t), t.slice(0, 120));
  ok('每間酒店有價錢', /HK\$1,500–2,000/.test(t) && /網上搜尋估價/.test(t));
  ok('有好處', /乙支路入口站直達/.test(t));
  ok('最近車站同自己計嘅步行時間', /最近\s*을지로입구역\s*·\s*步行約 4 分鐘/.test(t), (t.match(/最近[\s\S]{0,30}/) || [])[0]);
  ok('有 Google 評分同相', await acc.locator('.sgh .thumb-rate').count() === 2 && await acc.locator('.sgh-photo img').count() === 2);
  const bk = await acc.locator('a', { hasText: 'Booking' }).first().getAttribute('href');
  ok('有 Booking 睇價連結（帶日子、人數、房數）', bk.includes('checkin=') && bk.includes('group_adults=6') && bk.includes('no_rooms=2') && bk.includes('group_children=1'), bk);
  ok('建議講明跟咗咩要求', /按你嘅要求：[\s\S]*6 大 1 小・2 間房・每晚 HK\$800–1,500[\s\S]*有浴缸/.test(await acc.innerText()));

  await acc.locator('[data-staypick="1"]').click();
  await p.waitForTimeout(900);
  const last = [...saved].reverse().find(x => x.snapshot);
  const stays = last ? last.snapshot.stays : [];
  ok('揀咗就取代嗰幾晚原本嘅酒店', stays.length === 1 && stays[0].name === '明洞九樹酒店', stays.map(s => s.name));
  ok('連埋 Google 地點同車站', stays[0] && stays[0].placeId && stays[0].station === '명동역');
  ok('酒店卡標明係 AI 建議', /AI 建議/.test(await p.locator('[data-hskey="acc"]').innerText()));
  // the trash on a hotel removes that hotel, not the whole 住宿 section
  p.once('dialog', d => d.accept());
  await p.locator('[data-staydelete="0"]').click();
  await p.waitForTimeout(900);
  const after = [...saved].reverse().find(x => x.snapshot);
  ok('刪酒店只係刪嗰間', after && after.snapshot.stays.length === 0, after && after.snapshot.stays.length);
  ok('住宿呢段仲喺度', await p.locator('[data-fold="stay"]').count() === 1 && !((after.snapshot.hiddenSections || []).includes('acc')));
  ok('收埋成段係另一粒寫明嘅掣', /收埋成段「住宿」/.test(await p.locator('[data-fold="stay"]').locator('xpath=..').innerText()));
  ok('冇 JS 錯誤', errs.length === 0, errs);
  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
