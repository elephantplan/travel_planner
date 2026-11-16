// Two people editing at once: someone else's save is noticed and shown, and
// a save made after theirs merges day by day instead of writing over them.
//
//   node tests/coedit.js        (needs a static server on :8799)
const { chromium } = require('playwright');
const { snap } = require('./fixture.js');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c){ pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : '')); } };
// the database gives keys back in its own order
const shuffle = o => Array.isArray(o) ? o.map(shuffle) : o && typeof o === 'object'
  ? Object.keys(o).reverse().reduce((a, k) => (a[k] = shuffle(o[k]), a), {}) : o;

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const p = await (await b.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 900 } })).newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.addInitScript(() => setInterval(() => { const y = document.querySelector('[role=alertdialog] [data-yes]'); if (y) y.click(); }, 50));
  let n = 1, cur = { id: 1, created_at: '2026-09-20T00:00:00Z', edited_by: '阿明', source: 'seed', summary: 's', snapshot: JSON.parse(JSON.stringify(snap)), has_snapshot: true };
  const saved = [];
  await p.route('**/rest/v1/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await p.route('**/rest/v1/itinerary_versions**', r => {
    const req = r.request();
    if (req.method() === 'POST'){
      const body = JSON.parse(req.postData()); saved.push(body);
      cur = { id: ++n, created_at: new Date().toISOString(), edited_by: body.edited_by, snapshot: body.snapshot, has_snapshot: true };
      return r.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify([{ id: cur.id }]) });
    }
    if (/select=id,edited_by,created_at/.test(req.url())) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: cur.id, edited_by: cur.edited_by, created_at: cur.created_at }]) });
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([Object.assign({}, cur, { snapshot: shuffle(cur.snapshot) })]) });
  });
  await p.route('**/functions/v1/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
  await p.route('**tile**', r => r.abort());
  await p.goto('http://localhost:8799/trip.html?trip=1', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1200);
  const theirs = mutate => { const s2 = JSON.parse(JSON.stringify(cur.snapshot)); mutate(s2); cur = { id: ++n, created_at: new Date().toISOString(), edited_by: '阿明', snapshot: s2, has_snapshot: true }; };

  // 1. they change Day 1 while we look at the page: it shows up by itself
  theirs(s2 => { s2.days[0].title = '阿明改咗嘅第一日'; });
  await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await p.waitForTimeout(1500);
  ok('有人改咗會自己更新', /阿明改咗嘅第一日/.test(await p.locator('body').innerText()));
  ok('講明邊個改咗', /阿明 啱啱改咗行程/.test(await p.locator('#savestate, .savestate, body').first().innerText()));

  // 2. they change Day 1 again; we, not knowing, delete a stop on Day 2
  theirs(s2 => { s2.days[0].title = '阿明第二次改'; });
  await p.evaluate(() => document.querySelector('[data-go="day2"]').click());
  await p.waitForTimeout(800);
  await p.locator('#selstart').click(); await p.waitForTimeout(200);
  await p.locator('[data-select="0"]').click(); await p.waitForTimeout(150);
  await p.locator('#seldel').click(); await p.waitForTimeout(2500);
  const last = saved[saved.length - 1].snapshot;
  ok('我哋刪嘅保留咗', !last.days[1].items.some(i => i.title === '景福宮'), last.days[1].items.map(i => i.title));
  ok('佢哋改嘅冇俾蓋過', last.days[0].title === '阿明第二次改', last.days[0].title);

  // 3. both change the same day: ours kept, and we're told
  theirs(s2 => { s2.days[1].title = '阿明改 Day 2'; });
  await p.locator('.dayhead h2').waitFor();
  await p.locator('#clearday').click(); await p.waitForTimeout(2500);
  const last2 = saved[saved.length - 1].snapshot;
  ok('兩個都改同一日：用自己嘅', !last2.days[1].items.some(i => i.kind === 'stop'), last2.days[1].title);
  ok('冇 JS error', !errs.length, errs);
  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
