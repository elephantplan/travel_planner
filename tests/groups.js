// Top-level sections the family makes themselves. 行前準備 and 自己加嘅資料 were
// the only two places a section could live, which was an accident of how the
// feature grew — 「交通點畀錢」 is a block of exactly this kind, it just shipped
// with the app. These tests cover making one, naming it, filling it, and
// deleting it without losing what was inside.
//
//   node tests/groups.js        (needs a static server on :8799)
const { chromium } = require('playwright');
const { snap } = require('./fixture.js');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c){ pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : '')); } };

const sec = (title, where) => ({ icon: '', title, sub: '', lines: [title + ' 內容'],
  links: [], source: 'manual', topic: title, aiRefresh: false, where });

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

  async function boot(patch){
    const ctx = await b.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 1000 }, colorScheme: 'dark' });
    const p = await ctx.newPage();
    const errs = []; p.on('pageerror', e => errs.push(e.message));
    const cur = JSON.parse(JSON.stringify(snap));
    if (patch) patch(cur);
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
    await p.route('**/functions/v1/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
    await p.route('**tile**', r => r.abort());
    await p.goto('http://localhost:8799/trip.html?trip=1', { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(1200);
    return { p, errs, saved };
  }
  const lastSnap = saved => { for (let i = saved.length - 1; i >= 0; i--) if (saved[i] && saved[i].snapshot) return saved[i].snapshot; return null; };

  console.log('\nA. 自己開一個大段落');
  {
    const { p, errs, saved } = await boot();
    ok('主頁見到「加一個大段落」', await p.locator('#addgroup').isVisible());
    await p.locator('#addgroup').click();
    await p.waitForTimeout(400);
    await p.locator('input.input').first().fill('出發前搞掂佢');
    await p.locator('input.input').nth(1).fill('入境卡・換錢・上網卡');
    await p.locator('[data-esave]').click();
    await p.waitForTimeout(900);

    const page = await p.locator('#app').innerText();
    ok('主頁上面多咗佢', /出發前搞掂佢/.test(page));
    ok('摺埋嗰句都出埋', /入境卡・換錢・上網卡/.test(page));
    ok('一開就打開咗', await p.locator('.fold.open [data-fold^="g:"]').count() === 1);
    ok('入面有得加 section', await p.locator('[data-addusec^="g"]').count() === 1);
    const g = ((lastSnap(saved) || {}).groups || [])[0];
    ok('存低咗', g && g.title === '出發前搞掂佢', g);
    ok('冇 JS 錯誤', errs.length === 0, errs);
    await p.close();
  }

  console.log('\nB. 細 section 加得落去，擺喺邊揀得到佢');
  {
    const { p, errs, saved } = await boot(c => {
      c.groups = [{ id: 'gTEST', title: '出發前搞掂佢', hint: '' }];
      c.sections = [sec('手信買咩好', 'extra')];
    });
    const gfold = p.locator('[data-fold="g:gTEST"]');
    ok('見到個大段落', await gfold.count() === 1);
    await gfold.click();
    await p.waitForTimeout(400);
    await p.locator('[data-addusec="gTEST"]').click();
    await p.waitForTimeout(400);
    await p.locator('#usec-manual').click();
    await p.waitForTimeout(400);
    const sel = p.locator('select.input').last();
    ok('新 section 預設就擺喺呢個大段落', await sel.inputValue() === 'gTEST');
    const opts = await sel.locator('option').evaluateAll(o => o.map(x => x.textContent.trim()));
    ok('揀得返行前準備', opts.some(x => /行前準備/.test(x)), opts);
    ok('揀得返自己加嘅資料', opts.some(x => /自己加嘅資料/.test(x)), opts);
    ok('自己開嗰個都喺度揀得', opts.some(x => /出發前搞掂佢/.test(x)), opts);

    await p.locator('input.input').nth(1).fill('電子入境卡');
    await p.locator('[data-esave]').click();
    await p.waitForTimeout(900);
    ok('真係加咗落呢個大段落',
       /電子入境卡/.test(await p.locator('[data-usecorder="gTEST"]').innerText()));
    await p.locator('[data-fold="extra"]').click();   // folds only render when open
    await p.waitForTimeout(400);
    ok('唔會走咗落自己加嘅資料',
       !/電子入境卡/.test(await p.locator('[data-usecorder="extra"]').innerText()));
    ok('存低嘅 where 係個 group id',
       ((lastSnap(saved) || {}).sections || []).some(x => x.title === '電子入境卡' && x.where === 'gTEST'),
       ((lastSnap(saved) || {}).sections || []).map(x => [x.title, x.where]));
    ok('冇 JS 錯誤', errs.length === 0, errs);
    await p.close();
  }

  console.log('\nC. 改名');
  {
    const { p, errs, saved } = await boot(c => { c.groups = [{ id: 'gTEST', title: '舊名', hint: '' }]; });
    await p.locator('[data-fold="g:gTEST"]').click();
    await p.waitForTimeout(400);
    await p.locator('[data-groupedit="gTEST"]').click();
    await p.waitForTimeout(400);
    await p.locator('input.input').first().fill('新名');
    await p.locator('[data-esave]').click();
    await p.waitForTimeout(900);
    const page = await p.locator('#app').innerText();
    ok('改到名', /新名/.test(page));
    ok('舊名冇咗', !/舊名/.test(page));
    ok('存低咗', ((lastSnap(saved) || {}).groups || [])[0]?.title === '新名');
    ok('冇 JS 錯誤', errs.length === 0, errs);
    await p.close();
  }

  console.log('\nD. 刪走個大段落，入面啲嘢唔可以跟住冇埋');
  {
    const { p, errs, saved } = await boot(c => {
      c.groups = [{ id: 'gTEST', title: '出發前搞掂佢', hint: '' }];
      c.sections = [sec('電子入境卡', 'gTEST'), sec('手信買咩好', 'extra')];
    });
    await p.locator('[data-fold="g:gTEST"]').click();
    await p.waitForTimeout(400);
    let asked = '';
    p.once('dialog', d => { asked = d.message(); d.accept(); });
    await p.locator('[data-groupdel="gTEST"]').click();
    await p.waitForTimeout(1000);
    ok('刪之前講明入面啲嘢會點', /搬返落「自己加嘅資料」/.test(asked), asked);
    ok('個大段落冇咗', await p.locator('[data-fold="g:gTEST"]').count() === 0);

    await p.locator('[data-fold="extra"]').click();
    await p.waitForTimeout(400);
    const extra = await p.locator('[data-usecorder="extra"]').innerText();
    ok('入面嗰個 section 搬咗落自己加嘅資料', /電子入境卡/.test(extra), extra);
    ok('本來喺嗰度嗰個都仲喺度', /手信買咩好/.test(extra));
    const after = lastSnap(saved) || {};
    ok('資料入面冇刪錯 section', (after.sections || []).length === 2, (after.sections || []).length);
    ok('where 改返做 extra',
       (after.sections || []).every(x => x.where === 'extra'),
       (after.sections || []).map(x => [x.title, x.where]));
    ok('冇 JS 錯誤', errs.length === 0, errs);
    await p.close();
  }

  console.log('\nE. 個大段落唔見咗，入面啲 section 都唔可以人間蒸發');
  {
    // a snapshot where a section points at a group that no longer exists —
    // what an older phone sends back after somebody else deleted the group
    const { p, errs } = await boot(c => {
      c.groups = [];
      c.sections = [sec('孤兒 section', 'gGONE')];
    });
    await p.locator('[data-fold="extra"]').click();
    await p.waitForTimeout(400);
    ok('照樣喺主頁見到佢', /孤兒 section/.test(await p.locator('[data-usecorder="extra"]').innerText()));
    ok('冇 JS 錯誤', errs.length === 0, errs);
    await p.close();
  }

  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
