// Finding out that a newer version exists. The refresh button and the pull
// gesture only ever re-read the itinerary; the page itself — the app code —
// was never reloaded, so an installed app ran whatever it was installed with
// until somebody deleted it off the home screen. These tests are about the
// app noticing, saying so, and actually reloading when asked.
//
//   node tests/update.js        (needs a static server on :8799)
const { chromium } = require('playwright');
const { snap } = require('./fixture.js');
const fs = require('fs');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c){ pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : '')); } };

const SRC = fs.readFileSync(__dirname + '/../trip.html', 'utf8');
const BUILD = (SRC.match(/const BUILD = "([^"]+)"/) || [])[1];

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

  // `serveBuild` is what the SERVER hands back for trip.html on a re-fetch —
  // null means "serve the real file", i.e. no new version exists.
  async function boot(serveBuild, standalone){
    const ctx = await b.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 1000 }, colorScheme: 'dark' });
    if (standalone){
      // the reload button only exists in the installed app, so the browser
      // has to be told it is one before that path can be driven at all
      await ctx.addInitScript(() => {
        Object.defineProperty(window.navigator, 'standalone', { get: () => true, configurable: true });
      });
    }
    const p = await ctx.newPage();
    const errs = []; p.on('pageerror', e => errs.push(e.message));
    const cur = JSON.parse(JSON.stringify(snap));
    let navigations = 0;
    await p.route('**/rest/v1/itinerary_versions**', r => r.request().method() === 'POST'
      ? r.fulfill({ status: 201, contentType: 'application/json', body: '[]' })
      : r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 1,
          created_at: '2026-09-20T00:00:00Z', edited_by: 'x', source: 'seed', summary: 's',
          snapshot: cur, has_snapshot: true }]) }));
    await p.route('**/rest/v1/ai_notes**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await p.route('**/functions/v1/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
    await p.route('**tile**', r => r.abort());
    // the page re-fetching itself: hand back a doctored copy with a different
    // BUILD so the running copy believes a deploy has happened
    await p.route('**/trip.html**', async r => {
      if (r.request().resourceType() === 'document'){ navigations++; return r.continue(); }
      if (serveBuild == null) return r.continue();
      return r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8',
        body: SRC.replace(/const BUILD = "[^"]+"/, `const BUILD = "${serveBuild}"`) });
    });
    await p.goto('http://localhost:8799/trip.html?trip=1', { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(1300);
    return { p, errs, nav: () => navigations };
  }

  console.log('\nA. 版本冇變就唔好嘈');
  {
    const { p, errs } = await boot(null);
    ok('冇新版本就唔會彈嘢出嚟', await p.locator('#updatebar').isVisible() === false);
    ok('footer 講得出而家行緊邊個版本',
       new RegExp('版本 ' + BUILD).test(await p.locator('footer').innerText()),
       await p.locator('footer').innerText());
    ok('冇 JS 錯誤', errs.length === 0, errs);
    await p.close();
  }

  console.log('\nB. 一開 app 就自己發現有新版本');
  {
    const { p, errs } = await boot('9999-12-31-99');
    await p.waitForTimeout(600);
    ok('唔使撳任何嘢都會彈', await p.locator('#updatebar').isVisible());
    ok('講得明係咩事', /有新版本/.test(await p.locator('#updatebar').innerText()));
    ok('同埋話你知撳得', /撳嚟更新/.test(await p.locator('#updatebar').innerText()));
    ok('冇 JS 錯誤', errs.length === 0, errs);
    await p.close();
  }

  console.log('\nC. 撳落去係真係 reload 個頁面，唔淨係攞資料');
  {
    const { p, errs, nav } = await boot('9999-12-31-99');
    await p.waitForTimeout(600);
    const before = nav();
    await p.locator('#updatebar').click();
    await p.waitForLoadState('domcontentloaded');
    await p.waitForTimeout(1200);
    ok('個頁面真係再載入咗一次', nav() > before, { before, after: nav() });
    ok('冇 JS 錯誤', errs.length === 0, errs);
    await p.close();
  }

  console.log('\nD. 向下拉／重新載入都會順手 check 版本');
  {
    const { p, errs } = await boot('9999-12-31-99', true);
    ok('裝咗 app 先見到重新載入掣', await p.locator('#btn-reload').isVisible());
    // hide it again so the only thing that can bring it back is the refresh
    await p.evaluate(() => { document.querySelector('#updatebar').hidden = true; });
    ok('暫時收埋咗', await p.locator('#updatebar').isVisible() === false);
    await p.locator('#btn-reload').click();
    await p.waitForTimeout(1600);
    ok('refresh 完會自己彈返出嚟', await p.locator('#updatebar').isVisible());
    ok('冇 JS 錯誤', errs.length === 0, errs);
    await p.close();
  }

  console.log('\nE. Service worker 唔會再釘住舊版');
  {
    const sw = fs.readFileSync(__dirname + '/../sw.js', 'utf8');
    ok('navigate 會同 server 對一對', /cache: "no-cache"/.test(sw));
    ok('shell cache 版本有 bump', /const VERSION = "v3"/.test(sw));
    ok('Supabase 資料照樣唔准 cache', /isSupabaseData\(url\)\) return;/.test(sw));
  }

  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
