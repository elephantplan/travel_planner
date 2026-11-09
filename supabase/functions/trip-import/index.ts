// Supabase Edge Function: trip-import
//
// Most families don't start a trip from nothing: there's already a
// spreadsheet, a travel agent's PDF, a screenshot of someone's IG post. This
// reads whatever they have — the text of an Excel/CSV (converted in the
// browser) and/or photos and screenshots — and turns it into the app's own
// shape: which day, what time, which place, plus any hotel it mentions.
//
// It only transcribes. It never adds places that aren't in the source; the
// app finds each place on Google, fetches photos and works out the transit
// afterwards, exactly as it does for a place typed in by hand.
//
// POST { text?: string, images?: [{ mime, data(base64) }], today: "YYYY-MM-DD" }
//   → { ok, trip: { destination, title, dateStart, dateEnd, stays, days, notes } }
// Secrets: GEMINI_API_KEY (+ _2, _3 …), GEMINI_TEXT_MODEL — shared with ai-assistant.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

function geminiKeys(): string[] {
  const keys: string[] = [];
  const first = (Deno.env.get("GEMINI_API_KEY") || "").trim();
  if (first) keys.push(first);
  for (let i = 2; i <= 50; i++) {
    const v = (Deno.env.get(`GEMINI_API_KEY_${i}`) || "").trim();
    if (!v) break;
    keys.push(v);
  }
  return keys;
}
const model = () => (Deno.env.get("GEMINI_TEXT_MODEL") || "").trim() || "gemini-3.5-flash";
// When the main model is overloaded (503) or out of quota (429) — search
// grounding in particular has its own, smaller quota — one other model is
// tried before giving up. Google retires older models for new users (2.5
// answers 404 now), so the default is a current one; override with
// GEMINI_FALLBACK_MODEL.
const fallbackModel = () => (Deno.env.get("GEMINI_FALLBACK_MODEL") || "").trim() || "gemini-3.6-flash";
const retryable = (m: string) =>
  /429|RESOURCE_EXHAUSTED|quota|503|UNAVAILABLE|high demand|overloaded/i.test(m);

async function callGemini(parts: unknown[], search = false): Promise<string> {
  let last = "Gemini key 未設定";
  let firstErr = "";        // the configured model's own failure is the one worth reporting
  const models = [...new Set([model(), fallbackModel()])];
  models: for (const m of models) for (const key of geminiKeys()) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Search grounding and JSON mode can't be combined, so a searched
        // answer comes back as text and is parsed the same forgiving way.
        body: JSON.stringify(search
          ? { contents: [{ parts }], tools: [{ google_search: {} }] }
          : { contents: [{ parts }], generationConfig: { responseMimeType: "application/json" } }),
      },
    );
    if (!res.ok) {
      last = `Gemini error ${res.status} (model=${m}${search ? ", search" : ""}): ${(await res.text()).slice(0, 300)}`;
      console.error(last);
      if (!firstErr) firstErr = last;
      if (retryable(last)) continue;
      // a model that can't do this (e.g. no search grounding) won't on
      // another key either — but the fallback model might
      if (m !== models[models.length - 1]) continue models;
      throw new Error(firstErr || last);
    }
    const data = await res.json();
    if (data?.candidates?.[0]?.finishReason === "MAX_TOKENS") throw new Error("TRUNCATED");
    return data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join("") ?? "";
  }
  throw new Error(firstErr || last);
}

// The family needs to know whether to wait a minute or whether something is
// misconfigured, so the status and the model ride along in the message.
function whyFailed(m: string): string {
  const mod = (m.match(/model=([^,)]+)/) || [])[1] || "";
  const tag = mod ? `（${mod}）` : "";
  if (/\b503\b|UNAVAILABLE|high demand|overloaded/i.test(m)) return `AI 模型而家太多人用緊${tag}，後備模型都試過，等一兩分鐘再撳。`;
  if (/\b429\b|RESOURCE_EXHAUSTED|quota/i.test(m)) {
    if (/PerMinute/i.test(m)) return `一分鐘內撳得太密${tag}，等半分鐘再試。`;
    return `Gemini 免費額度用晒${tag}${/search/.test(m) ? "，網上搜尋有自己較細嘅額度" : ""}，通常聽日重置。`;
  }
  if (/\b404\b|not found|is not supported/i.test(m)) return `模型名唔啱或者唔支援呢個功能${tag}，檢查 GEMINI_TEXT_MODEL。`;
  return "AI 出錯：" + m.slice(0, 160);
}

function parseJson(t: string): any {
  const c = t.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
  try { return JSON.parse(c); } catch { /* try the braces */ }
  const a = c.indexOf("{"), b = c.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(c.slice(a, b + 1)); } catch { /* give up */ } }
  return null;
}

const iso = (s: unknown) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s ?? "")) ? String(s) : null);
const str = (s: unknown, n: number) => String(s ?? "").trim().slice(0, n);

const PROMPT = (today: string) => `你係一個幫香港家庭整理旅行行程嘅助手。下面係佢哋已經有嘅行程資料（可能係 Excel 轉出嚟嘅表、截圖、相、或者一段文字）。你嘅工作係**照抄**，將佢整理成固定格式，唔係重新設計行程。

規則：
1. **唔可以自己加地點**。來源冇寫嘅景點、餐廳、酒店一律唔好出現。睇唔清楚嘅字唔好估，喺 notes 講返。
2. 次序跟返來源。每一日由早到晚排。
3. 時間：來源有寫就用「約 HH:MM」格式（24 小時制）；冇寫就留空字串。
4. 日期：來源有寫就轉做 YYYY-MM-DD。冇寫年份就揀今日（${today}）之後最近嗰個。來源完全冇日期（例如只寫 Day 1、Day 2），date 就係 null。
5. 一行如果係地點／餐廳／景點 → kind "stop"；食飯嘅地方 type 用 "eat"，其他用 "normal"。純粹提醒、交通安排、自由活動（例如「自由活動」「買 T-money」「搭機場快線」）→ kind "note"，內容寫喺 title。
6. title 用來源嘅寫法（中文優先）；如果來源有當地語言名（韓文／日文），放喺 kr。
7. desc / tip：只抄來源寫咗嘅備註，冇就留空。
8. 酒店／住宿：抄去 stays，fromDay / toDay 係第幾日（1 開始），入住嗰日同退房嗰日。冇寫就空陣列。
9. destination：成個行程主要去嘅城市，用中文（例如 首爾、東京、台北）。
10. 航班：來源有寫航班（航班號、起飛／到達時間、機場）就抄去 flights，dir 係 "out"（去程）或者 "back"（回程），機場盡量用三字代號（香港 HKG、關西 KIX、成田 NRT、羽田 HND、仁川 ICN、桃園 TPE）。航班嘅「香港出發」「大阪落機」唔好再當 stop 抄入 days。冇就空陣列。
11. title：成個行程嘅名，來源冇就用「<城市> 行程」。每日嘅 title 係嗰日嘅主題（最多 12 字），來源冇就用嗰日主要去嘅區或者第一個景點。

只回覆一個 JSON（唔好有其他字）：
{"destination":"","title":"","dateStart":"YYYY-MM-DD 或 null","dateEnd":"YYYY-MM-DD 或 null","flights":[{"dir":"out","no":"CX506","date":"YYYY-MM-DD 或空","from":"HKG","to":"KIX","dep":"10:45","arr":"15:10","terminal":"","ref":""}],"stays":[{"name":"","kr":"","fromDay":1,"toDay":2}],"days":[{"date":"YYYY-MM-DD 或 null","title":"","items":[{"kind":"stop","type":"normal","time":"約 10:00","title":"","kr":"","desc":"","tip":""}]}],"notes":"讀唔清楚或者冇抄到嘅嘢（廣東話，冇就留空）"}`;

const FLIGHT_PROMPT = (today: string) => `下面係機票確認信／電郵／App 嘅截圖。抄低入面嘅航班資料，唔好估。
- dir：去程 "out"，回程 "back"（如果得一程，按日期判斷；第一程係去程）
- no：航班號（例如 CX506）
- date：YYYY-MM-DD（冇寫年份就揀今日 ${today} 之後最近嗰個）
- from / to：機場三字代號（例如 HKG、KIX）
- dep / arr：當地時間 HH:MM，24 小時制
- terminal：出發航廈（例如 T1），冇就留空
- ref：訂位編號（PNR／Booking reference），冇就留空
只回覆一個 JSON：{"flights":[{"dir":"out","no":"","date":"","from":"","to":"","dep":"","arr":"","terminal":"","ref":""}]}`;

// A flight number and a date are enough to find the scheduled times; the
// model searches the web for the timetable. Gates are only assigned on the
// day, so they are never guessed here.
const LOOKUP_PROMPT = (q: string, today: string) => `用 Google 搜尋查呢班機嘅定期班次資料：${q}（今日係 ${today}）。
要搵：出發機場、到達機場（三字代號）、預定起飛同到達時間（當地時間，24 小時制 HH:MM）、出發航廈。
只可以用搜尋到嘅資料，搵唔到嘅欄位留空，唔好估。閘口唔好填。
最後只回覆一個 JSON（唔好有其他字、唔好 code fence）：{"flights":[{"no":"","from":"","to":"","dep":"","arr":"","terminal":""}]}`;

// Where to sleep: which area for which nights, given where each day goes,
// and a few real hotels in each area. Prices and station walks come from a
// web search and are marked as estimates; the app checks every hotel on
// Google Maps and times the walk to the station itself.
const STAY_PROMPT = (trip: string, today: string) => `你係香港人嘅旅遊顧問。下面係一個家庭嘅行程（JSON），今日係 ${today}。
1. 列出 3–4 個適合呢個行程嘅熱門住宿區（例如大阪：梅田、心齋橋／難波、本町、天王寺），唔好淨係講一區。
   每區寫：pros（對呢個行程嘅好處，一句）、cons（要留意嘅地方，一句）、goodFor（啱咩人，例如「鍾意行街食嘢」「有長者」）。
   揀一個最適合嘅區做 best:true（得一個），其他 false。
2. 如果行程有幾日喺第二個城市（例如去京都住一兩晚會慳好多車程），喺 plan 度講邊幾晚住邊區；全程住同一個城市就 plan 留空陣列。
3. 每一區推介 2–3 間真實存在、評價好嘅酒店。用 Google 搜尋查價錢同最近嘅車站。價錢寫港幣大約範圍（例如「每晚約 HK$900–1,300」），查唔到就寫「出發前睇返訂房網」，唔好作。
   highlights 每間 2–3 點，每點最多 14 字。fromDay / toDay 係第幾日（1 開始），toDay 係退房嗰日。
4. 如果 JSON 入面有「住宿要求」，一定要跟；有「想住嘅區」就淨係喺嗰區揀；有「已經建議過」就唔好再推介嗰啲酒店（但區可以再列）。
全部用廣東話。
行程：
${trip}
只回覆一個 JSON（唔好有其他字、唔好 code fence）：
{"areas":[{"area":"梅田","best":true,"pros":"","cons":"","goodFor":""}],"plan":[{"fromDay":1,"toDay":3,"area":"梅田","why":""}],"hotels":[{"name":"中文名","local":"當地語言名","area":"梅田","fromDay":1,"toDay":3,"price":"每晚約 HK$900–1,300","highlights":["",""],"station":"最近車站名（當地語言）","walk":"步行約 5 分鐘"}]}`;

function cleanStays(p: any) {
  const n = (x: unknown, d: number) => Math.max(1, Math.floor(Number(x) || d));
  return {
    areas: (Array.isArray(p?.areas) ? p.areas : []).slice(0, 6).map((a: any) => ({
      area: str(a?.area, 30), best: a?.best === true, pros: str(a?.pros, 140), cons: str(a?.cons, 140), goodFor: str(a?.goodFor, 60),
    })).filter((a: any) => a.area),
    plan: (Array.isArray(p?.plan) ? p.plan : []).slice(0, 6).map((x: any) => ({
      fromDay: n(x?.fromDay, 1), toDay: n(x?.toDay, n(x?.fromDay, 1)), area: str(x?.area, 30), why: str(x?.why, 120),
    })).filter((x: any) => x.area),
    hotels: (Array.isArray(p?.hotels) ? p.hotels : []).slice(0, 14).map((h: any) => ({
      name: str(h?.name, 60), local: str(h?.local, 80), area: str(h?.area, 30),
      fromDay: n(h?.fromDay, 1), toDay: n(h?.toDay, n(h?.fromDay, 1)),
      price: str(h?.price, 60),
      highlights: (Array.isArray(h?.highlights) ? h.highlights : []).slice(0, 3).map((x: unknown) => str(x, 24)).filter(Boolean),
      station: str(h?.station, 40), walk: str(h?.walk, 30),
    })).filter((h: any) => h.name),
  };
}

function cleanFlights(list: unknown): any[] {
  const hhmm = (x: unknown) => { const m = String(x ?? "").match(/(\d{1,2})\s*[:：]\s*(\d{2})/); return m ? `${m[1].padStart(2, "0")}:${m[2]}` : ""; };
  return (Array.isArray(list) ? list : []).slice(0, 4).map((f: any) => ({
    dir: f?.dir === "back" ? "back" : "out",
    no: str(f?.no, 12).toUpperCase().replace(/\s+/g, ""),
    date: iso(f?.date) || "",
    from: str(f?.from, 20), to: str(f?.to, 20),
    dep: hhmm(f?.dep), arr: hhmm(f?.arr),
    terminal: str(f?.terminal, 10), ref: str(f?.ref, 12),
  })).filter((f: any) => f.no || f.dep || f.arr);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, message: "POST only" }, 405);
  let body: any = {};
  try { body = await req.json(); } catch { return json({ ok: false, message: "bad json" }, 400); }
  if (!geminiKeys().length) return json({ ok: false, message: "AI 功能未設定（冇 GEMINI_API_KEY）。" });

  const text = str(body?.text, 60000);
  const images = (Array.isArray(body?.images) ? body.images : [])
    .filter((im: any) => /^image\/(jpeg|png|webp|heic|heif)$/.test(String(im?.mime)) && typeof im?.data === "string")
    .slice(0, 8);
  if (!text && !images.length) return json({ ok: false, message: "冇收到任何檔案或者文字。" });
  const today = iso(body?.today) || new Date().toISOString().slice(0, 10);

  if (body?.mode === "stay-suggest") {
    let raw = "";
    try { raw = await callGemini([{ text: STAY_PROMPT(str(text, 12000), today) }], true); }
    catch (e) { return json({ ok: false, message: whyFailed(String(e)) }); }
    const out = cleanStays(parseJson(raw));
    if (!out.hotels.length) return json({ ok: false, message: "AI 今次冇建議到酒店，再試一次。" });
    return json({ ok: true, stays: out });
  }

  if (body?.mode === "flight-lookup") {
    const q = str(text, 60);
    const no = (q.match(/[A-Za-z0-9]{2}\s?\d{1,4}[A-Za-z]?/) || [""])[0].replace(/\s+/g, "").toUpperCase();
    if (!no) return json({ ok: false, message: "睇唔出航班號。" });
    let raw = "";
    try { raw = await callGemini([{ text: LOOKUP_PROMPT(q, today) }], true); }
    catch (e) { return json({ ok: false, message: whyFailed(String(e)) }); }
    const f = cleanFlights(parseJson(raw)?.flights).map((x: any) => ({ ...x, no: x.no || no }))[0];
    if (!f || (!f.dep && !f.from)) return json({ ok: false, message: `網上搵唔到 ${no} 嘅班次時間，可以自己打或者用機票截圖。` });
    return json({ ok: true, trip: { flights: [f] } });
  }

  const flightOnly = body?.mode === "flight";
  const parts: unknown[] = [{ text: flightOnly ? FLIGHT_PROMPT(today) : PROMPT(today) }];
  if (text) parts.push({ text: "【文字／表格內容】\n" + text });
  images.forEach((im: any, i: number) => {
    parts.push({ text: `【第 ${i + 1} 張圖】` });
    parts.push({ inline_data: { mime_type: im.mime, data: im.data } });
  });

  let raw: string;
  try { raw = await callGemini(parts); }
  catch (e) {
    const m = String(e);
    return json({ ok: false, message: m.includes("TRUNCATED")
      ? "行程太長，AI 一次讀唔晒。試吓分開幾次導入（例如每次幾日）。"
      : whyFailed(m) });
  }
  const p = parseJson(raw);
  if (flightOnly) {
    const flights = cleanFlights(p?.flights);
    return json(flights.length ? { ok: true, trip: { flights } } : { ok: false, message: "喺張圖度搵唔到航班資料。" });
  }
  if (!p || !Array.isArray(p.days)) return json({ ok: false, message: "AI 今次整理唔到，再試一次。" });

  // Never trust the shape; clamp every field to what the app expects.
  const days = p.days.slice(0, 30).map((d: any) => ({
    date: iso(d?.date),
    title: str(d?.title, 24),
    items: (Array.isArray(d?.items) ? d.items : []).slice(0, 40).map((it: any) => ({
      kind: it?.kind === "note" ? "note" : "stop",
      type: it?.type === "eat" ? "eat" : "normal",
      time: str(it?.time, 20),
      title: str(it?.title, 80),
      kr: str(it?.kr, 80),
      desc: str(it?.desc, 400),
      tip: str(it?.tip, 300),
    })).filter((it: any) => it.title),
  }));
  const stays = (Array.isArray(p.stays) ? p.stays : []).slice(0, 10).map((s: any) => ({
    name: str(s?.name, 80), kr: str(s?.kr, 120),
    fromDay: Math.max(1, Math.floor(Number(s?.fromDay) || 1)),
    toDay: Math.max(1, Math.floor(Number(s?.toDay) || Number(s?.fromDay) || 1)),
  })).filter((s: any) => s.name);

  return json({ ok: true, trip: {
    destination: str(p.destination, 40),
    title: str(p.title, 40),
    dateStart: iso(p.dateStart) || days.find((d: any) => d.date)?.date || null,
    dateEnd: iso(p.dateEnd) || [...days].reverse().find((d: any) => d.date)?.date || null,
    stays, days, flights: cleanFlights(p.flights),
    notes: str(p.notes, 600),
  } });
});
