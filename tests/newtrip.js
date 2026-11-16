// A new trip end to end, as a first-time user on a phone: what was said once
// is used everywhere, every stop has a rough price, the day opens on its
// places, and there is a rainy-day version.
//
//   node tests/newtrip.js        (needs a static server on :8799)
const { chromium } = require('playwright');
const OUT = process.argv[2] || '';
const log = (...a) => console.log(...a);
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c){ pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : '')); } };
const DAYS = {
  day1: [['約 14:00','抵達關西機場','関西国際空港','normal'],['約 16:00','難波酒店 check-in','なんば','normal'],['約 17:30','道頓堀散步','道頓堀','normal'],['約 19:00','一蘭拉麵 道頓堀店','一蘭 道頓堀店本館','eat']],
  day2: [['約 09:00','大阪城公園','大阪城公園','normal'],['約 12:00','午餐：きじ 大阪燒','きじ 梅田','eat'],['約 14:00','梅田藍天大廈','梅田スカイビル','normal'],['約 18:30','晚餐：松阪牛燒肉 M','焼肉 M','eat']],
  day3: [['約 09:30','奈良公園餵鹿','奈良公園','normal'],['約 11:00','東大寺','東大寺','normal'],['約 12:30','午餐：中谷堂麻糬','中谷堂','eat'],['約 17:00','心齋橋行街','心斎橋筋商店街','normal']],
  day4: [['約 09:00','黑門市場早餐','黒門市場','eat'],['約 11:00','難波 Parks','なんばパークス','normal'],['約 14:00','前往關西機場','関西国際空港','normal']],
};
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await b.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, colorScheme: 'light', isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 160)); });
  await p.addInitScript(() => setInterval(() => { const y = document.querySelector('[role=alertdialog] [data-yes]'); if (y) y.click(); }, 300));
  let trip = null, versions = [], vid = 0; const calls = [], plans = []; let seenDoing = false;
  await p.route('**/rest/v1/**', async r => {
    const req = r.request(), url = req.url(), m = req.method();
    const J = (o, s = 200) => r.fulfill({ status: s, contentType: 'application/json', body: JSON.stringify(o) });
    if (/select=owner_id/.test(url)) return J({ message: 'no column' }, 400);
    if (/\/trips/.test(url)){
      if (m === 'POST'){ trip = Object.assign({ id: 7, created_at: new Date().toISOString() }, JSON.parse(req.postData())); return J([trip], 201); }
      if (m === 'PATCH') return J([], 204);
      return J(trip ? [trip] : []);
    }
    if (/itinerary_versions/.test(url)){
      if (m === 'POST'){ const v = Object.assign({ id: ++vid, created_at: new Date().toISOString(), has_snapshot: true }, JSON.parse(req.postData())); versions.unshift(v); return J([v], 201); }
      if (/select=id,edited_by,created_at/.test(url)) return J(versions.slice(0, 1).map(v => ({ id: v.id, edited_by: v.edited_by, created_at: v.created_at })));
      if (/select=id,created_at,edited_by,source/.test(url)) return J(versions.map(v => ({ id: v.id, created_at: v.created_at, edited_by: v.edited_by, source: v.source, summary: v.summary, trivial: v.trivial, has_snapshot: true })));
      return J(versions.slice(0, 1));
    }
    return J([]);
  });
  await p.route('**/functions/v1/**', async r => {
    const req = r.request(), url = req.url(), body = JSON.parse(req.postData() || '{}');
    const J = (o, ms = 200) => new Promise(res => setTimeout(res, ms)).then(() => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) }));
    calls.push((url.match(/v1\/([a-z-]+)/) || [])[1] + ':' + (body.action || body.mode || ''));
    if (body.action === 'place-search'){
      const q = String(body.query || '');
      if (/大阪/.test(q) && q.length < 4) return J({ places: [{ name: '大阪', address: '日本大阪府大阪市', lat: 34.6937, lng: 135.5023, placeId: 'osaka' }, { name: '大阪城', address: '大阪府大阪市中央区', lat: 34.6873, lng: 135.5262, placeId: 'oc' }] });
      const h = [...q].reduce((a, c) => a + c.charCodeAt(0), 0);
      return J({ places: [{ name: q, address: '大阪', lat: 34.66 + (h % 50) / 1000, lng: 135.49 + (h % 70) / 1000, placeId: 'p' + h, rating: 4.1 + (h % 8) / 10, ratingCount: 300 + h % 4000 }] });
    }
    if (body.action === 'ask' && /旅行社顧問/.test(body.question || '')) return J({ aiSummary: JSON.stringify({ questions: [
      { q: '幾多人去？', options: ['2 個大人', '2 大 1 小', '4 個朋友'] },
      { q: '幾點到埗、幾點走？', options: ['朝早到、夜晚走', '下晝到、朝早走'] },
      { q: '想食咩？', options: ['拉麵', '燒肉', '大阪燒', '海鮮'], multi: true },
      { q: '每日預算大約？', options: ['慳啲', '中等', '唔理'] }] }) }, 1800);
    if (body.action === 'ask' && /抽出到埗同離開/.test(body.question || '')) return J({ aiSummary: '{"arrive":{"airport":"KIX","time":"13:00"},"depart":{"airport":"KIX","time":"18:00"}}' }, 500);
    if (body.action === 'ask' && /每人大約使幾多錢/.test(body.question || '')) return J({ aiSummary: JSON.stringify({ costs: [{ title: '自己加嘅地方', cost: '¥2,000' }] }) }, 300);
    if (body.action === 'ask' && /分配每日/.test(body.question || '')) return J({ aiSummary: 'day1｜難波、道頓堀｜抵達\nday2｜大阪城、梅田｜城同夜景\nday3｜奈良、心齋橋｜餵鹿行街\nday4｜黑門、難波｜返程' }, 1500);
    if (body.action === 'day-plan'){
      plans.push(body.question || '');
      const changes = (body.dayIds || []).flatMap(id => (DAYS[id] || []).map(([time, title, kr, type], k) => ({ op: /落雨/.test(body.question) ? 'edit' : 'add', matchTitle: /落雨/.test(body.question) ? title : null, dayId: id, stop: { time, title: /落雨/.test(body.question) && k === 0 ? title + '（室內）' : title, kr, type, desc: title + '：AI 介紹一句。', cost: type === 'eat' ? '¥1,500' : k % 2 ? '免費' : '¥600–1,000' }, reason: '順路' })));
      return J({ ok: true, notes: '排好咗', changes, dayTitles: { day1: '抵達・道頓堀', day2: '大阪城・梅田夜景', day3: '奈良餵鹿・心齋橋', day4: '黑門市場・返程' } }, 2500);
    }
    if (body.action === 'transit') return J({ ok: true, mode: 'walk', text: '步行約 9 分鐘' });
    if (body.mode === 'leg') return J({ ok: true, mode: 'metro', text: '電車約 18 分鐘（估計，車站係真嘅，路線出發前喺 Google 確認）', route: '行4分 → なんば ─御堂筋線・3站─ 梅田 → 行5分', estimated: true }, 300);
    if (body.mode === 'stay-areas') return J({ ok: true, stays: { areas: [{ area: '難波', best: true, pros: '去機場同食嘢方便', cons: '夜晚嘈', goodFor: '第一次去' }, { area: '梅田', pros: '交通樞紐', cons: '貴啲', goodFor: '去京都' }], plan: [] } }, 1500);
    if (body.mode === 'stay-suggest') return J({ ok: true, stays: { areas: [], plan: [], hotels: [{ name: '難波平價酒店 ' + Math.random().toString(36).slice(2, 4), local: 'なんばホテル', area: /梅田/.test(body.text) ? '梅田' : '難波', fromDay: 1, toDay: 4, highlights: ['近地鐵', '平'] }] } }, 2500);
    if (body.mode === 'stay-check') return J({ ok: true, hotel: { price: '每晚約 HK$700–900', score: 7, scoreWhy: '平又近站', station: 'なんば駅', walk: '步行約 4 分鐘', highlights: ['近站'] } }, 1200);
    return J({ ok: false, message: 'n/a' });
  });
  await p.route('**tile**', r => r.abort());
  await p.route('**/*.{png,jpg,jpeg,webp}', r => r.request().url().includes('localhost') ? r.continue() : r.abort());
  const shot = async (name) => { await p.waitForTimeout(250); if (OUT) await p.screenshot({ path: `${OUT}/${name}.png` }); };
  const step = async (name, fn) => { try { await fn(); } catch (e){ log('STEP FAIL', name, e.message.split('\n')[0]); } };

  await p.goto('http://localhost:8799/index.html', { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(1200);
  await shot('01-home');
  await step('dest', async () => { await p.fill('#f-dest', '大阪'); await p.waitForTimeout(1400); await shot('02-dest-suggest'); await p.evaluate(() => document.activeElement.blur()); await p.waitForTimeout(400); });
  await step('dates', async () => { await p.locator('.datecell').first().click(); await p.waitForTimeout(400); await shot('03-datepicker');
    await p.locator('.rp-d[data-d="2026-12-18"]').click(); await p.locator('.rp-d[data-d="2026-12-21"]').click(); await p.waitForTimeout(200); await shot('04-dates-picked'); if (await p.locator('.rp-ok').isVisible().catch(() => false)) await p.locator('.rp-ok').click(); });
  ok('打咗目的地唔揀都撳得「開始規劃」', !(await p.locator('#f-go').isDisabled()));
  await step('req', async () => { await p.fill('#f-req', '同老婆兩個人去，想慳啲錢，想食好嘢同行街，唔想太趕'); await shot('05-form-filled'); });
  await step('go', async () => { await p.locator('#f-go').click(); await p.waitForTimeout(500); await shot('06-asking'); await p.waitForTimeout(1800); await shot('07-questions');
    const g = p.locator('.pf-g'); await g.nth(0).locator('button').first().click(); await g.nth(1).locator('button').first().click(); await g.nth(2).locator('button').nth(0).click(); await g.nth(2).locator('button').nth(2).click(); await g.nth(3).locator('button').first().click();
    await shot('08-questions-answered'); await p.locator('#pf-ok').click(); });
  await p.waitForURL(/trip\.html/, { timeout: 15000 });
  // while it plans: which day is being worked on shows on the overview
  for (let k = 0; k < 40 && !seenDoing; k++){ seenDoing = /AI 排緊呢日/.test(await p.locator('#app').innerText().catch(() => '')); await p.waitForTimeout(250); }
  ok('排緊嗰陣主頁講明邊日排緊', seenDoing);
  await p.waitForFunction(() => /行程生成完成/.test(document.body.innerText), null, { timeout: 60000 }).catch(() => {});
  await p.waitForTimeout(1200);
  const snap = () => versions[0].snapshot;
  ok('要求入面講過到埗時間：航班自動填好', (snap().flights || []).some(f => f.dir === 'out' && f.arr === '13:00' && f.to === 'KIX'), snap().flights);
  ok('講過「同老婆兩個人、慳錢」：住宿要求自動填好', snap().stayPrefs && snap().stayPrefs.adults === 2 && /800 以下/.test(snap().stayPrefs.budget), snap().stayPrefs);
  ok('第一日跟住落機時間排', /13:00 到 KIX/.test(plans[0] || ''), (plans[0] || '').slice(0, 200));
  ok('冇估使費（唔準）', !/每人約|今日大約每人|成個行程大約/.test(await p.locator('#app').innerText()));
  ok('講過想慳錢：叫 AI 揀平嘅', plans.every(q => /想慳錢/.test(q)));
  await p.evaluate(() => document.querySelector('[data-go="day1"]').click()); await p.waitForTimeout(1000);
  await shot('day1');
  ok('入到日子：地圖預設收埋，一開就見到地點', await p.locator('.mapbox').count() === 0 && await p.locator('.stopcard').first().isVisible());
  ok('工具只得一行：AI 諗行程、落雨版、更多', await p.locator('.daytools #dayai').count() === 1 && await p.locator('#rainplan').count() === 1 && await p.locator('#selstart').count() === 0);
  await p.locator('#daymore').click(); await p.waitForTimeout(200);
  ok('撳「更多」先見其他工具', await p.locator('#selstart').count() === 1 && await p.locator('#clearday').count() === 1);
  ok('卡上淨係地圖同「更多」', await p.locator('.stopcard').nth(1).locator('.stopfoot > .maplink:visible, .stopfoot > a:visible, .stopfoot > button:visible').count() <= 2);
  ok('交通說明短咗', !/車站係真嘅/.test(await p.locator('#app').innerText()) && /・估計/.test(await p.locator('#app').innerText()));
  // a stop without a price gets one on request
  // rainy version
  await p.evaluate(() => window.scrollTo(0, 0));
  await p.locator('#rainplan').click(); await p.waitForTimeout(400);
  ok('落雨版即刻開始諗', await p.locator('.dai-think').count() === 1);
  await p.waitForTimeout(3200);
  ok('講明係落雨版', /落雨／太凍版/.test(await p.locator('.dai-asked').innerText().catch(() => '')));
  ok('落雨版係換，唔係加', /落雨或者太凍版/.test(plans[plans.length - 1] || ''));
  await p.evaluate(() => { const c = document.querySelector('.sheet-close'); if (c) c.click(); });
  // hotels: the questions start from what was said
  await p.evaluate(() => document.querySelector('[data-go="stays"]').click()); await p.waitForTimeout(600);
  ok('住宿頁冇兩粒一樣嘅「自己加」', await p.locator('[data-staymanual]').count() === 0 && await p.locator('[data-editsec="acc"]').count() >= 1);
  ok('冇 JS error', !errs.filter(e => !/Failed to load resource/.test(e)).length, errs);
  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
