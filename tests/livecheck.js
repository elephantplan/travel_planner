// The 「Check 實時」 buttons. They used to fetch the real answer, print it, and
// leave the section itself stale while the timestamp under it read 「啱啱」.
// These tests are about the write-back: that it is offered, that it is never
// automatic, and that it lands in the right field.
//
//   node tests/livecheck.js        (needs a static server on :8799)
const { chromium } = require('playwright');
const { snap } = require('./fixture.js');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c){ pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : '')); } };

// what the edge function answers for action:"weather" — Open-Meteo's daily
// block rides along in `raw`, which is where the table's numbers come from
const WEATHER = {
  summary: '首爾未來幾日：日間 15°C 上下，早晚涼。',
  aiSummary: '帶件薄羽絨，日夜溫差大。',
  raw: { daily: {
    time: ['2026-10-23', '2026-10-24', '2026-10-25'],
    temperature_2m_max: [16.4, 14.8, 13.2],
    temperature_2m_min: [7.6, 6.1, 5.4],
    precipitation_probability_max: [10, 40, 0],
  } },
};
const FOLIAGE = { aiSummary: '2026 年銀杏絕頂 10 月 30 日，首爾市區十月下旬黃綠參半。' };

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

  async function boot(){
    const ctx = await b.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 1000 }, colorScheme: 'dark' });
    const p = await ctx.newPage();
    const errs = []; p.on('pageerror', e => errs.push(e.message));
    const cur = JSON.parse(JSON.stringify(snap));
    const saved = [];
    await p.route('**/rest/v1/itinerary_versions**', r => {
      if (r.request().method() === 'POST'){
        try { saved.push(JSON.parse(r.request().postData() || '{}')); } catch (_){}
        return r.fulfill({ status: 201, contentType: 'application/json', body: '[]' });
      }
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 1,
        created_at: '2026-09-20T00:00:00Z', edited_by: 'x', source: 'seed', summary: 's',
        snapshot: cur, has_snapshot: true }]) });
    });
    await p.route('**/rest/v1/ai_notes**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await p.route('**/functions/v1/**', async r => {
      let body = {};
      try { body = JSON.parse(r.request().postData() || '{}'); } catch (_){}
      const out = body.action === 'weather' ? WEATHER
                : body.action === 'foliage' ? FOLIAGE
                : { ok: true };
      await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(out) });
    });
    await p.route('**tile**', r => r.abort());
    await p.goto('http://localhost:8799/trip.html?trip=1', { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(1100);
    await p.locator('[data-fold="prep"]').click();      // the weather/foliage blocks live in here
    await p.waitForTimeout(400);
    return { p, errs, saved };
  }
  // the snapshot in the newest save this page sent
  const lastSnap = saved => {
    for (let i = saved.length - 1; i >= 0; i--) if (saved[i] && saved[i].snapshot) return saved[i].snapshot;
    return null;
  };

  console.log('\nA. 天氣：撳 check 之後有得一撳套用');
  {
    const { p, errs, saved } = await boot();
    const before = await p.locator('.wtable').innerText();
    ok('原本張表係 fixture 嗰啲數', /10-23/.test(before) && /19°/.test(before), before.slice(0, 40));

    await p.locator('[data-livecheck="weather"]').click();
    await p.waitForTimeout(900);
    const out = p.locator('#livecheck-weather');
    ok('出咗實時答案', /日間 15°C/.test(await out.innerText()));
    ok('先睇到會寫入咩', /10\/23/.test(await out.locator('.applyprev').innerText()));
    ok('預覽用返實際預報嘅數', /16°/.test(await out.locator('.applyprev').innerText()),
       await out.locator('.applyprev').innerText());
    ok('有粒套用掣', await out.locator('[data-apply]').count() === 1);

    // nothing may change until it is actually pressed
    ok('未撳之前張表一個字都冇郁', (await p.locator('.wtable').innerText()) === before);

    await out.locator('[data-apply]').click();
    await p.waitForTimeout(900);
    const after = await p.locator('.wtable').innerText();
    ok('撳完張表變咗', after !== before);
    ok('入面係實時預報嘅數字', /16°/.test(after) && /降雨機率 40%/.test(after), after.slice(0, 80));
    ok('舊數字冇殘留', !/19°/.test(after), after.slice(0, 80));
    ok('真係存返落 server', /16°/.test(JSON.stringify(lastSnap(saved) || {})));
    ok('存低嗰版寫明做過咩',
       /天氣表/.test(JSON.stringify((saved[saved.length - 1] || {}).summary || '')),
       (saved[saved.length - 1] || {}).summary);
    ok('冇 JS 錯誤', errs.length === 0, errs);
    await p.close();
  }

  console.log('\nB. 季節提示：一樣有得套用');
  {
    const { p, errs, saved } = await boot();
    const before = await p.locator('.sec-sub').filter({ hasText: '銀杏' }).first().innerText();
    ok('原本有段舊嘅季節提示', /轉黃/.test(before), before);
    await p.locator('[data-livecheck="foliage"]').click();
    await p.waitForTimeout(900);
    const out = p.locator('#livecheck-foliage');
    ok('出咗答案', /10 月 30 日/.test(await out.innerText()));
    ok('有粒套用掣', await out.locator('[data-apply]').count() === 1);
    ok('季節提示冇文字預覽（答案本身就係）', await out.locator('.applyprev').count() === 0);

    await out.locator('[data-apply]').click();
    await p.waitForTimeout(900);
    const page = await p.locator('#app').innerText();
    ok('段文字換咗做新嗰份', /銀杏絕頂 10 月 30 日/.test(page));
    ok('舊嗰句冇咗', !/下旬銀杏開始轉黃/.test(page), page.slice(0, 60));
    ok('真係存返落 server', /銀杏絕頂 10 月 30 日/.test(JSON.stringify(lastSnap(saved) || {})));
    ok('冇 JS 錯誤', errs.length === 0, errs);
    await p.close();
  }

  console.log('\nC. 冇嘢可以套用嘅時候唔好扮有');
  {
    const ctx = await b.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 1000 }, colorScheme: 'dark' });
    const p = await ctx.newPage();
    const errs = []; p.on('pageerror', e => errs.push(e.message));
    const cur = JSON.parse(JSON.stringify(snap));
    await p.route('**/rest/v1/itinerary_versions**', r => r.request().method() === 'POST'
      ? r.fulfill({ status: 201, contentType: 'application/json', body: '[]' })
      : r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 1,
          created_at: '2026-09-20T00:00:00Z', edited_by: 'x', source: 'seed', summary: 's',
          snapshot: cur, has_snapshot: true }]) }));
    await p.route('**/rest/v1/ai_notes**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    // the function answers, but with no forecast behind it
    await p.route('**/functions/v1/**', r => r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ aiNotice: '而家攞唔到實時預報。' }) }));
    await p.route('**tile**', r => r.abort());
    await p.goto('http://localhost:8799/trip.html?trip=1', { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(1100);
    await p.locator('[data-fold="prep"]').click();
    await p.waitForTimeout(400);
    const before = await p.locator('.wtable').innerText();

    await p.locator('[data-livecheck="weather"]').click();
    await p.waitForTimeout(900);
    ok('冇預報就唔會出套用掣', await p.locator('#livecheck-weather [data-apply]').count() === 0);
    ok('張表更加唔會俾人清空', (await p.locator('.wtable').innerText()) === before);
    ok('但照樣話返你知發生咩事', /攞唔到實時預報/.test(await p.locator('#livecheck-weather').innerText()));
    ok('冇 JS 錯誤', errs.length === 0, errs);
    await p.close();
  }

  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
