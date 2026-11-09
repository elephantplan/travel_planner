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
const retryable = (m: string) =>
  /429|RESOURCE_EXHAUSTED|quota|503|UNAVAILABLE|high demand|overloaded/i.test(m);

async function callGemini(parts: unknown[]): Promise<string> {
  let last = "Gemini key 未設定";
  for (const key of geminiKeys()) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model()}:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseMimeType: "application/json" } }),
      },
    );
    if (!res.ok) {
      last = `Gemini error ${res.status}: ${(await res.text()).slice(0, 300)}`;
      if (retryable(last)) continue;
      throw new Error(last);
    }
    const data = await res.json();
    if (data?.candidates?.[0]?.finishReason === "MAX_TOKENS") throw new Error("TRUNCATED");
    return data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join("") ?? "";
  }
  throw new Error(last);
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
      : retryable(m) ? "AI 而家太忙或者用晒額度，等一陣再試。" : "AI 讀唔到：" + m.slice(0, 160) });
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
