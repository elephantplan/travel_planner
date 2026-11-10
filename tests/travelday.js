// The features for the trip itself: today's next stop, the taxi card, hours
// and tight-schedule warnings, 夾錢, the checklist, the read-only link and
// the offline copy.
//
//   node tests/travelday.js        (needs a static server on :8799)
const { chromium } = require('playwright');
const { snap } = require('./fixture.js');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c){ pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : '')); } };

const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const WD = ['日', '一', '二', '三', '四', '五', '六'];
const label = d => `${d.getMonth() + 1}月${d.getDate()}日（${WD[d.getDay()]}）`;

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  async function boot(patch, opts = {}){
    const ctx = opts.ctx || await b.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 1000 } });
    const p = await ctx.newPage();
    const errs = []; p.on('pageerror', e => errs.push(e.message));
    const cur = JSON.parse(JSON.stringify(snap));
    if (patch) patch(cur);
    const saved = [];
    await p.route('**/rest/v1/itinerary_versions**', r => {
      if (opts.offline) return r.abort();
      if (r.request().method() === 'POST'){ try { saved.push(JSON.parse(r.request().postData())); } catch (_){}
        return r.fulfill({ status: 201, contentType: 'application/json', body: '[]' }); }
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 1, created_at: '2026-09-20T00:00:00Z',
        edited_by: 'x', source: 'seed', summary: 's', snapshot: cur, has_snapshot: true }]) });
    });
    await p.route('**/rest/v1/ai_notes**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await p.route('**/functions/v1/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
    await p.route('**tile**', r => r.abort());
    await p.goto('http://localhost:8799/trip.html?trip=1' + (opts.query || ''), { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(1300);
    return { p, ctx, errs, saved, cur };
  }
  const lastSnap = saved => { const x = [...saved].reverse().find(v => v.snapshot); return x && x.snapshot; };

  let nextLabel = '', earlyHour = false;
  console.log('\nA. 今日模式');
  {
    // make day 2 today, with one stop still ahead later tonight
    const now = new Date(), start = new Date(now); start.setDate(now.getDate() - 1);
    const end = new Date(now); end.setDate(now.getDate() + 1);
    const { p, errs } = await boot(c => {
      c.meta.dateStart = iso(start); c.meta.dateEnd = iso(end);
      c.days.forEach((d, i) => { const x = new Date(start); x.setDate(start.getDate() + i); d.date = label(x); });
      const stops = c.days[1].items.filter(i => i.kind === 'stop');
      // times relative to now, so the test means the same at any hour:
      // the others an hour or more gone, the last one still ahead
      const nowMin = now.getHours() * 60 + now.getMinutes();
      const hm = m => `約 ${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
      stops.forEach(s => { s.time = hm(Math.max(0, nowMin - 90)); });
      stops[stops.length - 1].time = hm(Math.min(1439, nowMin + 60));
      // in the first 40 minutes after midnight nothing can be "long gone",
      // so the first stop is rightly still the next one
      earlyHour = nowMin < 40;
      nextLabel = (earlyHour ? hm(0) : hm(Math.min(1439, nowMin + 60))).replace('約 ', '');
    });
    ok('旅程中一開就喺今日嗰日', /Day\s*2/i.test(await p.locator('.dayhead').innerText()), await p.locator('.dayhead .dno').innerText());
    const nx = await p.locator('.todaynext').innerText();
    ok('講明下一站', /下一站/.test(nx) && nx.includes(nextLabel) && (earlyHour ? /景福宮/ : /韓牛燒肉/).test(nx), nx);
    ok('有導航掣', await p.locator('.todaynext a[href*="google.com/maps/dir"]').count() === 1);
    await p.evaluate(() => document.querySelector('[data-go="overview"]').click());
    await p.waitForTimeout(400);
    ok('總覽頂有今日卡', /今日/.test(await p.locator('.todaycard').innerText()));
    ok('冇 JS 錯誤', errs.length === 0, errs);
    await p.close();
  }

  console.log('\nB. 營業時間撞期同時間好趕');
  {
    const { p, errs } = await boot(c => {
      const st = c.days[1].items.filter(i => i.kind === 'stop');
      st[0].time = '約 19:00';
      st[0].weekdayText = ['星期一: 09:00 – 18:00','星期二: 09:00 – 18:00','星期三: 09:00 – 18:00','星期四: 09:00 – 18:00','星期五: 09:00 – 18:00','星期六: 09:00 – 18:00','星期日: 09:00 – 18:00'];
      // 北村 at 19:05, then a 40-minute ride, then 南山 at 19:20
      st[1].time = '約 19:05';
      st[2].time = '約 19:20';
      const at = c.days[1].items.indexOf(st[2]);
      c.days[1].items.splice(at, 0, { kind: 'connector', mode: 'metro', text: '地鐵約 40 分鐘', html: '地鐵約 40 分鐘' });
    });
    await p.evaluate(() => document.querySelector('.dayline[data-go="day2"]').click());
    await p.waitForTimeout(600);
    const t = await p.locator('#app').innerText();
    ok('講明到嗰陣已經關門', /19:00 到，佢 18:00 已經關門/.test(t), t.match(/你約[^\n]*/) && t.match(/你約[^\n]*/)[0]);
    ok('交通長過兩站相隔就警告', /時間好趕：交通要 40 分鐘，但兩個站只隔 15 分鐘/.test(t), t.match(/時間好趕[^\n]*/) && t.match(/時間好趕[^\n]*/)[0]);
    ok('冇 JS 錯誤', errs.length === 0, errs);
    await p.close();
  }

  console.log('\nC. 畀司機睇');
  {
    const { p, errs } = await boot(c => { c.stays[0].kr = '서울 중구 명동 L7 호텔'; });
    await p.evaluate(() => document.querySelector('[data-go="stays"]').click());
    await p.waitForTimeout(400);
    const btn = p.locator('[data-hskey="acc"] [data-taxi]');
    ok('酒店有「畀司機睇」', await btn.count() >= 1);
    await btn.first().click();
    await p.waitForTimeout(200);
    const card = await p.locator('.taxicard').innerText();
    ok('全螢幕顯示當地文字同一句請帶我去', /여기로 가 주세요/.test(card) && /[가-힣]/.test(card), card.slice(0, 60));
    await p.locator('.taxicard').click();
    ok('撳一下就收', await p.locator('.taxicard').count() === 0);
    ok('冇 JS 錯誤', errs.length === 0, errs);
    await p.close();
  }

  console.log('\nD. 夾錢');
  {
    const { p, errs, saved } = await boot(c => { c.money = { people: ['爸爸', '媽媽', '我'], items: [] }; });
    await p.locator('[data-fold="money"]').click();
    await p.waitForTimeout(300);
    await p.locator('[data-moneyadd]').click();
    await p.waitForTimeout(200);
    await p.fill('[data-mf="what"]', '晚餐');
    await p.fill('[data-mf="amount"]', '30000');
    await p.selectOption('[data-mf="paidBy"]', '爸爸');
    await p.locator('[data-esave]').click();
    await p.waitForTimeout(900);
    const t = await p.locator('[data-hskey="money"]').innerText();
    ok('記低咗', /晚餐/.test(t) && /30,000/.test(t), t.slice(0, 80));
    ok('計到邊個要比返幾多', /媽媽\s*→\s*爸爸\s*KRW 10,000/.test(t) && /我\s*→\s*爸爸\s*KRW 10,000/.test(t), t);
    const m = (lastSnap(saved) || {}).money;
    ok('存咗落 server', m && m.items.length === 1 && m.items[0].paidBy === '爸爸');
    ok('冇 JS 錯誤', errs.length === 0, errs);
    await p.close();
  }

  console.log('\nD2. 夾錢：由零開始加人');
  {
    const { p, errs, saved } = await boot();
    await p.locator('[data-fold="money"]').click();
    await p.waitForTimeout(300);
    await p.fill('#mp-inline', '爸爸 媽媽、我');
    await p.keyboard.press('Enter');
    await p.waitForTimeout(900);
    ok('一次打幾個名，撳 Enter 就加咗', await p.locator('[data-hskey="money"] .mn-p').count() === 3);
    let m = (lastSnap(saved) || {}).money;
    ok('一加即刻存，唔使記數先存到', m && m.people.join() === '爸爸,媽媽,我', m && m.people);
    await p.locator('[data-mp-del="1"]').click();
    await p.waitForTimeout(900);
    m = (lastSnap(saved) || {}).money;
    ok('撳 × 拎走一個人', m && m.people.join() === '爸爸,我', m && m.people);
    await p.locator('[data-moneyadd]').click();
    await p.waitForTimeout(300);
    ok('有人之後「記一筆」直接開記數', await p.locator('[data-mf="amount"]').count() === 1);
    ok('冇 JS 錯誤', errs.length === 0, errs);
    await p.close();
  }

  console.log('\nE. 出發前 checklist');
  {
    const { p, errs, saved } = await boot();
    await p.evaluate(k => { const b = document.querySelector(`[data-fold="${k}"]`); if (b && b.getAttribute("aria-expanded") !== "true") b.click(); }, "prep");
    await p.waitForTimeout(300);
    const blk = p.locator('[data-hskey="checklist"]');
    ok('有 checklist', await blk.count() === 1);
    ok('韓國行程有 K-ETA 同 T-money', /K-ETA/.test(await blk.innerText()) && /T-money/.test(await blk.innerText()));
    await blk.locator('[data-ck="0"]').check();
    await p.waitForTimeout(900);
    ok('剔咗會顯示進度', /搞掂咗 1／/.test(await p.locator('[data-hskey="checklist"]').innerText()));
    const cl = (lastSnap(saved) || {}).checklist;
    ok('存咗落 server', cl && cl[0].done === true);
    ok('冇 JS 錯誤', errs.length === 0, errs);
    await p.close();
  }

  console.log('\nF. 唯讀連結');
  {
    const { p, errs, saved } = await boot(null, { query: '&view=1' });
    ok('講明係唯讀', /唯讀/.test(await p.locator('.robar').innerText()));
    ok('冇改嘢嘅掣', await p.locator('.secedit:visible, .editbtn:visible').count() === 0);
    await p.evaluate(() => document.querySelector('.dayline[data-go="day1"]').click());
    await p.waitForTimeout(500);
    ok('日頁都冇改嘢嘅掣', await p.locator('.editbtn:visible, .addstop:visible, .insertrow:visible').count() === 0);
    await p.waitForTimeout(1500);
    ok('一筆都冇存過', saved.length === 0, saved.length);
    ok('冇 JS 錯誤', errs.length === 0, errs);
    await p.close();
  }

  console.log('\nG. 冇網絡都睇到');
  {
    const ctx = await b.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 1000 } });
    const first = await boot(null, { ctx });
    await first.p.close();
    const { p, errs } = await boot(null, { ctx, offline: true });
    ok('照樣顯示行程', /首爾秋楓銀杏行/.test(await p.locator('#app').innerText()));
    ok('講明係離線版本', /冇網絡/.test(await p.locator('.robar').innerText()));
    ok('離線時唔可以改', await p.locator('.secedit:visible').count() === 0);
    ok('冇 JS 錯誤', errs.length === 0, errs);
    await p.close();
  }

  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
