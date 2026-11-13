// 通知: switch notifications on (per phone), send a test, and tell the other
// phones once when this one saves changes. The browser's push machinery is
// faked here; what is checked is what the app asks the server to do.
//
//   node tests/push.js        (needs a static server on :8799)
const { chromium, devices } = require('playwright');
const { snap } = require('./fixture.js');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c){ pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : '')); } };

const FAKE = () => {
  const sub = { endpoint: 'https://push.example/me', toJSON(){ return { endpoint: this.endpoint, keys: { p256dh: 'P', auth: 'A' } }; } };
  let has = null;
  window.PushManager = window.PushManager || function(){};
  window.Notification = { permission: 'default', requestPermission: async () => 'granted' };
  const reg = { pushManager: { getSubscription: async () => has, subscribe: async (o) => { window.__subOpts = o; has = sub; return sub; } } };
  Object.defineProperty(navigator, 'serviceWorker', { value: { ready: Promise.resolve(reg), register: async () => reg, getRegistration: async () => reg, addEventListener(){} } });
};

async function setup(b, opts){
  const ctx = await b.newContext(Object.assign({ serviceWorkers: 'block', viewport: { width: 390, height: 900 } }, opts || {}));
  const p = await ctx.newPage();
  const errs = [], calls = [];
  p.on('pageerror', e => errs.push(e.message));
  await p.route('**/rest/v1/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await p.route('**/rest/v1/itinerary_versions**', r => {
    if (r.request().method() === 'POST') return r.fulfill({ status: 201, contentType: 'application/json', body: '[]' });
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 1, created_at: '2026-09-20T00:00:00Z', edited_by: 'x', source: 'seed', summary: 's', snapshot: snap, has_snapshot: true }]) });
  });
  await p.route('**/functions/v1/**', r => {
    const body = JSON.parse(r.request().postData() || '{}');
    if (/trip-push/.test(r.request().url())){ calls.push(body);
      if (body.mode === 'key') return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, key: 'BOrA' }) });
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, sent: 1 }) }); }
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await p.route('**tile**', r => r.abort());
  return { p, errs, calls };
}

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  {
    const { p, errs, calls } = await setup(b);
    await p.addInitScript(FAKE);
    await p.addInitScript(() => { try { localStorage.setItem('trip_editor_name', '阿媽'); } catch (_){} });
    await p.goto('http://localhost:8799/trip.html?trip=1', { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(1500);
    ok('主頁有「開通知」', /開通知/.test(await p.locator('#ov-push').innerText()));
    await p.click('#ov-push'); await p.waitForTimeout(300);
    await p.click('#push-on'); await p.waitForTimeout(800);
    const sub = calls.find(c => c.mode === 'subscribe');
    ok('登記呢部機（連埋行程同名）', sub && sub.trip_id === 1 && sub.sub.endpoint === 'https://push.example/me' && sub.sub.keys.p256dh === 'P' && sub.editor === '阿媽', sub);
    ok('一開就發測試通知', calls.some(c => c.mode === 'test' && c.endpoint === 'https://push.example/me'));
    ok('用伺服器嘅 key 登記', await p.evaluate(() => window.__subOpts && window.__subOpts.userVisibleOnly === true && window.__subOpts.applicationServerKey instanceof Uint8Array));
    ok('掣變咗「通知已開」', /通知已開/.test(await p.locator('#ov-push').innerText()));
    // a real change, then leave the app: the others get one notification
    await p.evaluate(() => document.querySelector('[data-go="day2"]').click());
    await p.waitForTimeout(800);
    await p.locator('[data-stopmenu]').first().click(); await p.waitForTimeout(200);
    p.once('dialog', d => d.accept());
    await p.locator('#stopdel').click(); await p.waitForTimeout(1500);
    ok('未離開之前唔會即刻發', !calls.some(c => c.mode === 'notify'));
    await p.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
    await p.waitForTimeout(500);
    const n = calls.find(c => c.mode === 'notify');
    ok('離開 app 就通知其他人', n && n.trip_id === 1 && /阿媽 改咗/.test(n.title) && /刪走咗/.test(n.body), n);
    ok('唔會通知返自己', n && n.except === 'https://push.example/me');
    ok('撳通知會開返呢個行程', n && /trip\.html\?trip=1/.test(n.url), n && n.url);
    // 「自己改都通知埋我」 includes this phone
    await p.evaluate(() => document.querySelector('[data-go="overview"], [data-go="ov"]') ? 0 : 0);
    await p.evaluate(() => localStorage.setItem('trip_push_on_1_me', '1'));
    await p.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); });
    await p.locator('[data-stopmenu]').first().click(); await p.waitForTimeout(200);
    p.once('dialog', d => d.accept());
    await p.locator('#stopdel').click(); await p.waitForTimeout(1500);
    await p.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
    await p.waitForTimeout(500);
    const n2 = calls.filter(c => c.mode === 'notify')[1];
    ok('揀咗「通知埋我」就唔會跳過自己', n2 && n2.except === '', n2);
    ok('冇 JS 錯誤', errs.length === 0, errs);
  }
  {
    // an iPhone in Safari (not added to the Home Screen) has no PushManager
    const { p, errs } = await setup(b, Object.assign({}, devices['iPhone 13']));
    await p.addInitScript(() => { delete window.PushManager; });
    await p.goto('http://localhost:8799/trip.html?trip=1', { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(1500);
    await p.click('#ov-push'); await p.waitForTimeout(300);
    const t = await p.locator('.sheet').innerText();
    ok('iPhone 未加主畫面就教點加', /加入主畫面/.test(t) && await p.locator('#push-on').isDisabled());
    ok('冇 JS 錯誤（iPhone）', errs.length === 0, errs);
  }
  {
    // a trip 20 days away: a countdown on the page and the number on the icon
    const future = JSON.parse(JSON.stringify(snap));
    const d0 = new Date(); d0.setDate(d0.getDate() + 20);
    const iso = x => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
    future.meta.dateStart = iso(d0); const d1 = new Date(d0); d1.setDate(d1.getDate() + 2); future.meta.dateEnd = iso(d1);
    const ctx = await b.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 900 } });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.addInitScript(() => { window.__badge = null; navigator.setAppBadge = async n => { window.__badge = n; }; navigator.clearAppBadge = async () => { window.__badge = 0; }; });
    await p.route('**/rest/v1/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await p.route('**/rest/v1/itinerary_versions**', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 1, created_at: '2026-09-20T00:00:00Z', edited_by: 'x', source: 'seed', summary: 's', snapshot: future, has_snapshot: true }]) }));
    await p.route('**/functions/v1/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
    await p.route('**tile**', r => r.abort());
    await p.goto('http://localhost:8799/trip.html?trip=1', { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(1500);
    ok('行程頁有倒數', /仲有\s*20\s*日出發/.test(await p.locator('.countdown').innerText().catch(() => '')));
    ok('app icon 上面顯示 20', await p.evaluate(() => window.__badge) === 20);
    ok('冇 JS 錯誤（倒數）', errs.length === 0, errs);
  }
  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
