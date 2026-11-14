// AI 諗行程 asked to find a restaurant gives several choices for the slot:
// pick one, the rest can be its backups. AI 助手 answers mark the places they
// recommend, and each gets a 「加去行程」 button.
//
//   node tests/aichoices.js        (needs a static server on :8799)
const { chromium } = require('playwright');
const { snap } = require('./fixture.js');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c){ pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : '')); } };

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const p = await (await b.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 900 } })).newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  const saved = [];
  const stops = sn => sn.days[1].items.filter(i => i.kind !== 'connector' && i.kind !== 'note' && i.title).map(s => s.title);
  const orig = stops(snap);
  await p.route('**/rest/v1/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await p.route('**/rest/v1/itinerary_versions**', r => {
    if (r.request().method() === 'POST'){ try { saved.push(JSON.parse(r.request().postData())); } catch (_){}
      return r.fulfill({ status: 201, contentType: 'application/json', body: '[]' }); }
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 1, created_at: '2026-09-20T00:00:00Z',
      edited_by: 'x', source: 'seed', summary: 's', snapshot: snap, has_snapshot: true }]) });
  });
  const asked = [];
  await p.route('**/functions/v1/**', r => {
    let body = {}; try { body = JSON.parse(r.request().postData() || '{}'); } catch (_){}
    const j = o => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (body.action === 'day-plan'){ asked.push(body.question);
      return j({ ok: true, notes: '', changes: ['甲', '乙', '丙'].map((n, k) => ({ op: 'add', dayId: 'day2', stop: { title: '餐廳' + n, time: '約 19:00', type: 'eat' }, reason: `選擇${k + 1}：好食` })) }); }
    if (body.action === 'ask'){ asked.push(body.question);
      return j({ ok: true, aiSummary: '可以試吓呢兩間：\n【推介】喫茶丁｜喫茶ティー｜老派咖啡店\n【推介】麵包戊｜パン戊｜早餐好\n記得早啲去。' }); }
    if (body.mode === 'near-search') return j({ ok: true, places: [] });
    return j({ ok: true });
  });
  await p.route('**tile**', r => r.abort());
  await p.goto('http://localhost:8799/trip.html?trip=1', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1200);
  await p.evaluate(() => document.querySelector('[data-go="day2"]').click());
  await p.waitForTimeout(1000);
  const last = () => { const x = [...saved].reverse().find(v => v.snapshot); return x && x.snapshot; };

  await p.locator('#dayai').click();
  await p.waitForTimeout(300);
  await p.fill('#dayai-q', '搵間晚餐餐廳');
  await p.locator('#dayai-go').click();
  await p.waitForTimeout(1000);
  ok('叫佢搵餐廳會叫 AI 俾幾個選擇', asked.some(q => /搵間晚餐/.test(q) && /3 至 5 個/.test(q)), asked);
  ok('同一時間嘅幾間變成一組選擇', await p.locator('.ai-opt').count() === 3 && await p.locator('.ai-optshead').count() === 1);
  ok('選擇唔會被「全部套用」一次過加晒', await p.locator('[data-applyall]').count() === 0);
  await p.locator('.ai-opt [data-apply]').nth(1).click();
  await p.waitForTimeout(2000);
  let d2 = last().days[1].items.filter(i => i.title && /^餐廳/.test(i.title));
  ok('揀咗嗰間加咗落去', d2.length === 1 && d2[0].title === '餐廳乙', d2.map(x => x.title));
  ok('其他變成「加做後備」', /後備/.test(await p.locator('.ai-opt [data-apply]').nth(0).innerText()));
  await p.locator('.ai-opt [data-apply]').nth(0).click();
  await p.waitForTimeout(2000);
  d2 = last().days[1].items.filter(i => i.title && /^餐廳/.test(i.title));
  ok('第二個做咗後備', d2.length === 1 && (d2[0].alts || []).some(a => a.title === '餐廳甲'), d2.map(x => [x.title, (x.alts || []).map(a => a.title)]));
  await p.keyboard.press('Escape'); await p.waitForTimeout(300);
  await p.evaluate(() => { document.querySelectorAll('.layer, .sheet-layer').forEach(x => x.remove()); });

  // AI 助手
  await p.locator('#btn-ai').click(); await p.waitForTimeout(300);
  await p.fill('#ai-q', '附近有咩好咖啡店？');
  await p.locator('[data-ai="ask"]').click();
  await p.waitForTimeout(1000);
  ok('問嘢會叫 AI 標住推介地點', asked.some(q => /咖啡店？/.test(q) && /【推介】/.test(q)), asked);
  ok('每個推介地點都有「加去行程」', await p.locator('#ai-out [data-askadd]').count() === 2, await p.locator('#ai-out').innerText());
  await p.locator('#ai-out [data-askadd]').first().click();
  await p.waitForTimeout(400);
  await p.locator('[data-addto="day2"]').click();
  await p.waitForTimeout(2000);
  const got = last().days[1].items.find(i => i.title === '喫茶丁');
  ok('加咗去 Day 2，連當地名', got && got.kr === '喫茶ティー', got);
  ok('冇 JS error', !errs.length, errs);
  await b.close();
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
