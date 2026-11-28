// 問 AI (one entry for everything AI does), 「AI 做好咗」 notifications,
// 要訂位／買飛 in the checklist, and 易睇模式 (big text, 只睇唔改).
//
//   node tests/easyai.js        (needs a static server on :8799)
const { chromium } = require('playwright');
const { snap } = require('./fixture.js');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c){ pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : '')); } };

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  async function boot(patch, opts = {}){
    const ctx = opts.ctx || await b.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 900 } });
    const p = await ctx.newPage();
    const errs = []; p.on('pageerror', e => errs.push(e.message));
    const cur = JSON.parse(JSON.stringify(snap));
    if (patch) patch(cur);
    const saved = [], calls = [];
    if (opts.push) await p.addInitScript(() => {
      const sub = { endpoint: 'https://push.example/abc', toJSON(){ return { endpoint: this.endpoint }; } };
      const reg = { pushManager: { getSubscription: async () => sub } };
      Object.defineProperty(Navigator.prototype, 'serviceWorker', { configurable: true, get: () => ({
        ready: Promise.resolve(reg), controller: null, register: async () => reg, addEventListener(){}, getRegistration: async () => reg }) });
      window.PushManager = window.PushManager || function(){};
      localStorage.setItem('trip_push_on_1', '1');
    });
    await p.route('**/rest/v1/itinerary_versions**', r => {
      if (r.request().method() === 'POST'){ try { saved.push(JSON.parse(r.request().postData())); } catch (_){}
        return r.fulfill({ status: 201, contentType: 'application/json', body: '[]' }); }
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 1, created_at: '2026-09-20T00:00:00Z',
        edited_by: 'x', source: 'seed', summary: 's', snapshot: cur, has_snapshot: true }]) });
    });
    await p.route('**/rest/v1/ai_notes**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await p.route('**/functions/v1/**', async r => {
      let body = {}; try { body = JSON.parse(r.request().postData() || '{}'); } catch (_){}
      calls.push({ url: r.request().url(), body });
      if (body.action === 'ask'){ await new Promise(res => setTimeout(res, 300));
        return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, aiSummary: '可以去廣藏市場。' }) }); }
      return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    });
    await p.route('**tile**', r => r.abort());
    await p.goto('http://localhost:8799/trip.html?trip=1' + (opts.query || ''), { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(1300);
    return { p, ctx, errs, saved, calls, cur };
  }
  const lastSnap = saved => { const x = [...saved].reverse().find(v => v.snapshot); return x && x.snapshot; };

  console.log('\nA. 問 AI：一個入口');
  {
    const { p, errs } = await boot();
    ok('底部個掣叫「問 AI」', /問 AI/.test(await p.locator('#btn-ai').innerText()));
    // on the overview (not during the trip): pick a day to plan
    await p.locator('#btn-ai').click(); await p.waitForTimeout(300);
    ok('總覽：冇日子嘅 tile', await p.locator('.sheet [data-hub]').count() === 0);
    ok('總覽：有揀日子諗行程', await p.locator('.sheet [data-hub-day]').count() === 3);
    ok('總覽：天氣、季節、執行程都喺度', await p.locator('.sheet [data-ai="weather"]').count() === 1 && await p.locator('.sheet [data-ai="foliage"]').count() === 1 && await p.locator('.sheet [data-ai="suggest"]').count() === 1);
    await p.locator('.sheet [data-hub-day="day3"]').click(); await p.waitForTimeout(400);
    ok('揀 Day 3 → 開 AI 諗行程', /AI 諗行程/.test(await p.locator('.sheet h3').innerText()) && /聖水洞/.test(await p.locator('.sheet').innerText()));
    ok('同時跳咗去 Day 3', await p.evaluate(() => !!document.querySelector('#dayai')) && /聖水洞/.test(await p.locator('#app').innerText()));
    await p.keyboard.press('Escape'); await p.waitForTimeout(300);
    if (await p.locator('.sheet').count()) { await p.locator('.sheet-close, [data-close]').first().click().catch(() => {}); await p.waitForTimeout(300); }

    // on a day: the first two tiles are about that day
    await p.locator('#btn-ai').click(); await p.waitForTimeout(300);
    ok('喺 Day 3：講明係邊日', /Day 3/.test(await p.locator('.sheet .aihub-ctx').innerText()));
    ok('喺 Day 3：有「幫 Day 3 諗行程」同「Day 3 加一個地點」', await p.locator('.sheet [data-hub="plan"]').count() === 1 && /Day 3 加一個地點/.test(await p.locator('.sheet [data-hub="add"]').innerText()));
    await p.locator('.sheet [data-hub="add"]').click(); await p.waitForTimeout(400);
    const h = await p.locator('.sheet h3').innerText();
    ok('加一個地點 → 開加地點', /加地點/.test(h), h);
    errs.length && ok('冇 JS 錯誤', false, errs);
    await p.context().close();
  }
  {
    // Day 2 has stops with coordinates, so 加地點 has its AI tab: it opens there
    const { p, errs } = await boot(c => { c.days[1].items.filter(i => i.kind === 'stop').forEach((s, k) => { s.lat = 37.57 + k * 0.01; s.lng = 126.98; }); });
    await p.evaluate(() => document.querySelector('.dayline[data-go="day2"]').click());
    await p.waitForTimeout(500);
    await p.locator('#btn-ai').click(); await p.waitForTimeout(300);
    const hasAdd = await p.locator('.sheet [data-hub="add"]').count();
    ok('喺 Day 2 有加地點 tile', hasAdd === 1);
    if (hasAdd){
      await p.locator('.sheet [data-hub="add"]').click(); await p.waitForTimeout(400);
      ok('直接開 AI 建議嗰頁', await p.locator('.sheet [data-instab="ai"].on').count() === 1);
    }
    ok('冇 JS 錯誤', !errs.length, errs);
    await p.context().close();
  }

  console.log('\nB. AI 做好咗通知');
  {
    const { p, calls, errs } = await boot();
    await p.locator('#btn-ai').click(); await p.waitForTimeout(300);
    await p.locator('#ai-q').fill('有咩好食？'); await p.locator('[data-ai="ask"]').click(); await p.waitForTimeout(1200);
    const ask = calls.find(c => c.body.action === 'ask' && /有咩好食/.test(c.body.question || ''));
    ok('冇開通知：問 AI 唔會帶 notify', ask && !ask.body.notify);
    await p.context().close();
  }
  {
    const { p, calls, errs } = await boot(null, { push: true });
    await p.locator('#btn-ai').click(); await p.waitForTimeout(300);
    await p.locator('#ai-q').fill('有咩好食？'); await p.locator('[data-ai="ask"]').click(); await p.waitForTimeout(1500);
    const ask = calls.find(c => c.body.action === 'ask' && /有咩好食/.test(c.body.question || ''));
    ok('開咗通知：帶埋 notify（job、endpoint、標題）', ask && ask.body.notify && ask.body.notify.job && ask.body.notify.endpoint === 'https://push.example/abc' && /AI 答咗你/.test(ask.body.notify.title), ask && ask.body.notify);
    const ack = calls.find(c => c.body.mode === 'job-ack');
    ok('喺畫面見到答案 → 話返 server 收到（唔使通知）', ack && ack.body.job === (ask && ask.body.notify && ask.body.notify.job));
    // switched off in the notification sheet → no ticket
    await p.evaluate(() => localStorage.setItem('trip_push_ai', '0'));
    await p.locator('#ai-q').fill('仲有呢？'); await p.locator('[data-ai="ask"]').click(); await p.waitForTimeout(1200);
    const ask2 = calls.find(c => c.body.action === 'ask' && /仲有呢/.test(c.body.question || ''));
    ok('熄咗「AI 做完通知我」就唔帶', ask2 && !ask2.body.notify);
    ok('冇 JS 錯誤', !errs.length, errs);
    await p.context().close();
  }

  console.log('\nC. 要訂位／買飛');
  {
    const { p, saved, errs } = await boot(c => {
      const st = c.days[1].items.filter(i => i.kind === 'stop');
      const bbq = st.find(s => /韓牛/.test(s.title));
      Object.assign(bbq, { isFood: true, booking: 'online', bookingHow: '一個月前喺 Catchtable 開放預約' });
      st.find(s => /南山塔/.test(s.title)).tip = '展望台要預約，網上買飛';
      const g = st.find(s => /景福宮/.test(s.title)); g.tip = '';
    });
    await p.evaluate(k => { const b = document.querySelector(`[data-fold="${k}"]`); if (b && b.getAttribute("aria-expanded") !== "true") b.click(); }, "prep");
    await p.waitForTimeout(300);
    let txt = await p.locator('[data-hskey="checklist"]').innerText().catch(() => '');
    ok('checklist 有「要訂位／買飛」', /要訂位／買飛/.test(txt), txt.slice(0, 200));
    ok('列出要預約嘅餐廳同景點', /韓牛/.test(txt) && /南山塔/.test(txt));
    ok('冇要訂嘅唔會出', !/景福宮/.test(txt));
    ok('寫明點訂', /Catchtable/.test(txt));
    const before = (txt.match(/搞掂咗 (\d+)／(\d+)/) || []).slice(1).map(Number);
    await p.locator('[data-bk]').first().check(); await p.waitForTimeout(1500);
    const s2 = lastSnap(saved);
    const booked = s2 && s2.days[1].items.filter(i => i.booked).map(i => i.title);
    ok('剔咗就記低已訂', booked && booked.length === 1, booked);
    txt = await p.locator('[data-hskey="checklist"]').innerText();
    const after = (txt.match(/搞掂咗 (\d+)／(\d+)/) || []).slice(1).map(Number);
    ok('進度計埋訂位', after[0] === before[0] + 1 && after[1] === before[1], [before, after]);
    ok('冇 JS 錯誤', !errs.length, errs);
    await p.context().close();
  }

  console.log('\nD. 易睇模式');
  {
    const ctx = await b.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 900 } });
    let { p, errs } = await boot(null, { ctx });
    await p.locator('#btn-text').click(); await p.waitForTimeout(300);
    ok('開到易睇模式', /易睇模式/.test(await p.locator('.sheet h3').innerText()));
    await p.locator('.sheet [data-size="huge"]').click(); await p.waitForTimeout(200);
    ok('揀特大 → 成頁放大', await p.evaluate(() => document.documentElement.dataset.text === 'huge' && getComputedStyle(document.getElementById('app')).zoom === '1.3'));
    await p.locator('#easy-view').click(); await p.waitForTimeout(2000);
    ok('只睇唔改：重新載入之後變唯讀', await p.evaluate(() => document.body.classList.contains('readonly')));
    ok('字嘅大細記得', await p.evaluate(() => document.documentElement.dataset.text === 'huge'));
    ok('底部講明點熄', /只睇模式/.test(await p.locator('.robar').innerText()));
    ok('問 AI 收埋', !(await p.locator('#btn-ai').isVisible()));
    await p.locator('#btn-text').click(); await p.waitForTimeout(300);
    await p.locator('#easy-view').click(); await p.waitForTimeout(2000);
    ok('熄咗只睇 → 改得返', await p.evaluate(() => !document.body.classList.contains('readonly')));
    await p.screenshot({ path: '/tmp/claude-0/easy.png' });
    ok('冇 JS 錯誤', !errs.length, errs);
    await ctx.close();
  }

  console.log('\nE. 出發前必讀海報：自己加嘅段落有自己個名');
  {
    const ctx = await b.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
    const { p, errs } = await boot(c => {
      c.sections = [{ id: 'u1', icon: '', title: '去到要做', sub: '', lines: ['飲益力多', '食布甸'], links: [], source: 'manual', topic: '', aiRefresh: false, where: 'prep' }];
    }, { ctx });
    await p.locator('#btn-export').click(); await p.waitForTimeout(400);
    await p.locator('#ex-prep').click(); await p.waitForTimeout(400);
    const txt = await p.evaluate(() => navigator.clipboard.readText());
    ok('有「## 去到要做」', /## 去到要做\n・飲益力多\n・食布甸/.test(txt), txt.slice(-200));
    ok('唔會撈入出發前準備', !/## 出發前準備[^#]*飲益力多/.test(txt));
    ok('講明有 4 個區塊，去到要做獨立一格', /只有 4 個區塊/.test(txt) && /・去到要做：獨立一個區塊/.test(txt));
    ok('冇 JS 錯誤', !errs.length, errs);
    await ctx.close();
  }

  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
