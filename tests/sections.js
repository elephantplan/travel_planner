// Custom sections, and the choice of where one lives. A section used to have
// exactly one home — the 自己加嘅資料 fold at the bottom — but most of what
// people write down before a trip belongs next to the weather, not below it.
//
//   node tests/sections.js        (needs a static server on :8799)
const { chromium } = require('playwright');
const { snap } = require('./fixture.js');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c){ pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : '')); } };

const sec = (title, where) => ({ icon: '', title, sub: '', lines: [title + ' 內容'],
  links: [], source: 'manual', topic: title, aiRefresh: false, ...(where ? { where } : {}) });

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

  async function boot(sections){
    const ctx = await b.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 1000 }, colorScheme: 'dark' });
    const p = await ctx.newPage();
    const errs = []; p.on('pageerror', e => errs.push(e.message));
    const cur = JSON.parse(JSON.stringify(snap));
    if (sections) cur.sections = sections;
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
    await p.waitForTimeout(1100);
    return { p, errs, saved };
  }
  const openFold = async (p, k) => { await p.locator(`[data-fold="${k}"]`).click(); await p.waitForTimeout(350); };
  const lastSnap = saved => { for (let i = saved.length - 1; i >= 0; i--) if (saved[i] && saved[i].snapshot) return saved[i].snapshot; return null; };

  console.log('\nA. 一個 section 擺得入「行前準備」');
  {
    const { p, errs } = await boot([sec('換錢攻略', 'prep'), sec('手信買咩好', 'extra')]);
    await openFold(p, 'prep');
    const prep = await p.locator('[data-fold="prep"]').locator('xpath=..').innerText();
    ok('行前準備入面見到佢', /換錢攻略/.test(prep), prep.slice(0, 120));
    ok('行前準備唔會順手拉埋第二個入嚟', !/手信買咩好/.test(prep));
    ok('同天氣擺埋一齊', /天氣/.test(prep) && /換錢攻略/.test(prep));

    await openFold(p, 'extra');
    const extra = await p.locator('[data-fold="extra"]').locator('xpath=..').innerText();
    ok('自己加嘅資料入面係另一個', /手信買咩好/.test(extra));
    ok('唔會兩邊都出一次', !/換錢攻略/.test(extra), extra.slice(0, 120));
    ok('冇 JS 錯誤', errs.length === 0, errs);
    await p.close();
  }

  console.log('\nB. 以前寫落嘅 section 唔會自己走位');
  {
    // no `where` at all — exactly what every section saved before this change
    const { p, errs } = await boot([sec('行李清單'), sec('上網卡')]);
    await openFold(p, 'prep');
    ok('舊 section 唔會突然彈咗上行前準備',
       !/行李清單/.test(await p.locator('[data-fold="prep"]').locator('xpath=..').innerText()));
    await openFold(p, 'extra');
    const extra = await p.locator('[data-fold="extra"]').locator('xpath=..').innerText();
    ok('照舊喺自己加嘅資料度', /行李清單/.test(extra) && /上網卡/.test(extra));
    ok('冇 JS 錯誤', errs.length === 0, errs);
    await p.close();
  }

  console.log('\nC. 改嗰度揀得到擺喺邊，揀完真係搬');
  {
    const { p, errs, saved } = await boot([sec('手信買咩好', 'extra')]);
    await openFold(p, 'extra');
    await p.locator('[data-usecedit]').first().click();
    await p.waitForTimeout(400);
    const sel = p.locator('select.input').last();
    ok('編輯版有「擺喺邊」', await sel.count() === 1);
    ok('而家揀住自己加嘅資料', await sel.inputValue() === 'extra');

    await sel.selectOption('prep');
    await p.locator('[data-esave]').click();
    await p.waitForTimeout(900);

    await openFold(p, 'prep');
    ok('搬咗去行前準備', /手信買咩好/.test(await p.locator('[data-fold="prep"]').locator('xpath=..').innerText()));
    ok('存低嘅資料記住咗位置', ((lastSnap(saved) || {}).sections || [])[0]?.where === 'prep',
       ((lastSnap(saved) || {}).sections || [])[0]);
    ok('其他嘢冇蝕', /手信買咩好 內容/.test(await p.locator('[data-fold="prep"]').locator('xpath=..').innerText()));
    ok('冇 JS 錯誤', errs.length === 0, errs);
    await p.close();
  }

  console.log('\nD. 兩邊各有自己嘅「加一個」掣，加落正確嗰邊');
  {
    const { p, errs } = await boot([sec('手信買咩好', 'extra')]);
    await openFold(p, 'prep');
    const prepAdd = p.locator('[data-fold="prep"]').locator('xpath=..').locator('[data-addusec="prep"]');
    ok('行前準備有自己粒加掣', await prepAdd.count() === 1);
    await prepAdd.click();
    await p.waitForTimeout(400);
    await p.locator('#usec-manual').click();
    await p.waitForTimeout(400);
    ok('開新 section 預設就係行前準備', await p.locator('select.input').last().inputValue() === 'prep');
    ok('冇 JS 錯誤', errs.length === 0, errs);
    await p.close();
  }

  console.log('\nE. 刪同改係搵啱嗰個，唔係搵錯位');
  {
    // the edit/delete buttons address d.sections by real index — a filtered
    // list would quietly point them at the section one slot over
    const { p, errs, saved } = await boot([sec('A 喺行前準備', 'prep'), sec('B 喺下面', 'extra'), sec('C 喺行前準備', 'prep')]);
    await openFold(p, 'prep');
    const box = p.locator('[data-fold="prep"]').locator('xpath=..');
    const second = box.locator('.usec').nth(1);
    ok('行前準備入面有兩個', await box.locator('.usec').count() === 2);
    ok('第二個係 C', /C 喺行前準備/.test(await second.innerText()));

    await second.locator('[data-usecedit]').click();
    await p.waitForTimeout(400);
    const title = p.locator('input.input').nth(1);
    ok('撳改開到嘅真係 C，唔係隔籬嗰個', (await title.inputValue()) === 'C 喺行前準備',
       await title.inputValue());
    await p.locator('[data-ecancel]').click();
    await p.waitForTimeout(300);

    p.once('dialog', d => d.accept());
    await second.locator('[data-usecdel]').click();
    await p.waitForTimeout(900);
    const left = ((lastSnap(saved) || {}).sections || []).map(x => x.title);
    ok('刪走嘅係 C', JSON.stringify(left) === JSON.stringify(['A 喺行前準備', 'B 喺下面']), left);
    ok('冇 JS 錯誤', errs.length === 0, errs);
    await p.close();
  }

  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
