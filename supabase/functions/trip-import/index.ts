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

// ---------- one leg between two places ----------
// Google's Directions API returns no public transport at all in Japan, so the
// old lookup could only offer a 60-minute walk. Walking, driving and (where
// Google has it) transit come from Google; where it has no transit the leg
// says so and points at the Google Maps app instead of guessing. Legs to
// another city are flagged `long` so the app can offer the trip-advice mode.
function legRef(r: any): string {
  if (!r || typeof r !== "object") return "";
  if (typeof r.placeId === "string" && r.placeId) return "place_id:" + r.placeId;
  if (Number.isFinite(r.lat) && Number.isFinite(r.lng)) return `${r.lat},${r.lng}`;
  return typeof r.text === "string" ? r.text.slice(0, 200) : "";
}
async function gDirections(o: string, d: string, mode: string, lang: string) {
  const key = (Deno.env.get("GOOGLE_PLACES_API_KEY") || "").trim();
  if (!key) return { problem: "冇 Google key" };
  const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(o)}` +
    `&destination=${encodeURIComponent(d)}&mode=${mode}${lang ? "&language=" + encodeURIComponent(lang) : ""}&key=${key}`;
  try {
    const data = await (await fetch(url)).json();
    const leg = data?.status === "OK" && data?.routes?.[0]?.legs?.[0];
    if (!leg) return { problem: String(data?.status || "UNKNOWN") };
    return { seconds: Number(leg.duration?.value) || 0, meters: Number(leg.distance?.value) || 0, steps: leg.steps || [] };
  } catch (e) { return { problem: String(e) }; }
}
function rideOf(steps: any[]) {
  const rides = steps.filter((x: any) => x.travel_mode === "TRANSIT" && x.transit_details);
  if (!rides.length) return null;
  let chain = "", subway = false;
  rides.forEach((x: any, i: number) => {
    const td = x.transit_details, t = td?.line?.vehicle?.type || "";
    if (t !== "BUS") subway = true;
    const label = (td?.line?.short_name || td?.line?.name || (t === "BUS" ? "巴士" : "電車")).trim();
    if (i === 0) chain += td.departure_stop?.name || "";
    chain += ` ─${label}${td.num_stops ? `・${td.num_stops}站` : ""}─ ${td.arrival_stop?.name || ""}`;
  });
  return { chain, transfers: rides.length - 1, subway,
    from: rides[0].transit_details.departure_stop?.name || "", to: rides[rides.length - 1].transit_details.arrival_stop?.name || "" };
}
const mins = (sec: number) => Math.max(1, Math.round(sec / 60));
async function legBetween(body: any) {
  const o = legRef(body?.from), d = legRef(body?.to);
  if (!o || !d) return { ok: false, message: "呢兩個地點冇足夠資料計交通。" };
  const prefer = ["walk", "drive", "transit"].includes(body?.prefer) ? body.prefer : "auto";
  const lang = typeof body?.lang === "string" ? body.lang.slice(0, 8) : "";
  const walkOut = (w: any) => ({ ok: true, mode: "walk", text: `步行約 ${mins(w.seconds)} 分鐘` });
  if (prefer === "walk") {
    const w: any = await gDirections(o, d, "walking", lang);
    return w.seconds ? walkOut(w) : { ok: false, message: "Google 計唔到行路路線。" };
  }
  if (prefer === "drive") {
    const c: any = await gDirections(o, d, "driving", lang);
    return c.seconds ? { ok: true, mode: "taxi", text: `揸車／的士約 ${mins(c.seconds)} 分鐘` } : { ok: false, message: "Google 計唔到車程。" };
  }
  let w: any = null;
  if (prefer === "auto") {
    w = await gDirections(o, d, "walking", lang);
    if (w.seconds && w.seconds <= 900) return walkOut(w);
  }
  const t: any = await gDirections(o, d, "transit", lang);
  if (t.seconds) {
    const r = rideOf(t.steps);
    if (r) return { ok: true, mode: r.subway ? "metro" : "bus",
      text: `${r.subway ? "電車" : "巴士"}約 ${mins(t.seconds)} 分鐘${r.transfers ? `・轉${r.transfers}次` : ""}`,
      route: r.chain, long: t.seconds >= 45 * 60 };
  }
  // No transit from Google's API (all of Japan). A guessed train route was
  // wrong too often to show, so say what is known for sure — the taxi and
  // walking times — and leave the trains to the Google Maps app, which does
  // have Japanese timetables.
  const c: any = await gDirections(o, d, "driving", lang);
  if (!w) w = await gDirections(o, d, "walking", lang);
  const bits = [c.seconds ? `的士約 ${mins(c.seconds)} 分鐘` : "", w?.seconds && w.seconds <= 2700 ? `行路約 ${mins(w.seconds)} 分鐘` : ""].filter(Boolean);
  // a trip to another city (Osaka → Kyoto) is worth asking how to do it
  const long = (c.seconds || 0) >= 40 * 60 || (c.meters || 0) >= 25000;
  if (prefer === "transit" || c.seconds || w?.seconds)
    return { ok: true, mode: "metro", noTime: true, long, text: `電車／巴士：撳 Google 睇班次${bits.length ? "（" + bits.join("，") + "）" : ""}` };
  return { ok: false, message: "計唔到呢段交通。" };
}

// A name typed by hand, looked up around a point — for chains (一蘭,
// Starbucks) Google then returns the branches close to the previous stop
// instead of the most famous ones, each with its distance in metres.
async function nearSearch(body: any) {
  const key = (Deno.env.get("GOOGLE_PLACES_API_KEY") || "").trim();
  const lat = Number(body?.lat), lng = Number(body?.lng);
  const q = str(body?.query, 80);
  if (!key || !q || !Number.isFinite(lat) || !Number.isFinite(lng)) return { ok: false, places: [] };
  const R = 6371000, toR = (x: number) => x * Math.PI / 180;
  const dist = (g: any) => {
    const a = Math.sin(toR(g.lat - lat) / 2) ** 2 + Math.cos(toR(lat)) * Math.cos(toR(g.lat)) * Math.sin(toR(g.lng - lng) / 2) ** 2;
    return Math.round(2 * R * Math.asin(Math.sqrt(a)));
  };
  const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(q)}` +
    `&location=${lat},${lng}&radius=3000&language=${encodeURIComponent(str(body?.lang, 8) || "zh-TW")}&key=${key}`;
  try {
    const data = await (await fetch(url)).json();
    const places = (data?.results || [])
      .filter((r: any) => r?.place_id && r?.geometry?.location && r.business_status !== "CLOSED_PERMANENTLY")
      .map((r: any) => ({ placeId: r.place_id, name: String(r.name || ""), address: String(r.formatted_address || "").slice(0, 120),
        lat: r.geometry.location.lat, lng: r.geometry.location.lng,
        rating: typeof r.rating === "number" ? r.rating : null,
        ratingCount: typeof r.user_ratings_total === "number" ? r.user_ratings_total : null,
        types: (Array.isArray(r.types) ? r.types : []).slice(0, 5), meters: dist(r.geometry.location) }))
      .slice(0, 12);
    return { ok: true, places };
  } catch (e) { return { ok: false, places: [], message: String(e) }; }
}

// What is worth a stop near a place already on the day: Google's own
// well-rated restaurants or sights within a short walk, so a suggestion is
// a real place with a real rating, not something a model made up.
async function nearbyPlaces(body: any) {
  const key = (Deno.env.get("GOOGLE_PLACES_API_KEY") || "").trim();
  const lat = Number(body?.lat), lng = Number(body?.lng);
  if (!key || !Number.isFinite(lat) || !Number.isFinite(lng)) return { ok: false, message: "冇位置資料。" };
  const eat = body?.kind === "eat";
  const lang = typeof body?.lang === "string" ? body.lang.slice(0, 8) : "";
  const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}` +
    `&radius=${eat ? 700 : 1500}&type=${eat ? "restaurant" : "tourist_attraction"}${lang ? "&language=" + encodeURIComponent(lang) : ""}&key=${key}`;
  try {
    const data = await (await fetch(url)).json();
    const R = 6371000, toR = (x: number) => x * Math.PI / 180;
    const dist = (g: any) => {
      const a = Math.sin(toR(g.lat - lat) / 2) ** 2 + Math.cos(toR(lat)) * Math.cos(toR(g.lat)) * Math.sin(toR(g.lng - lng) / 2) ** 2;
      return 2 * R * Math.asin(Math.sqrt(a));
    };
    const skip = new Set((Array.isArray(body?.skip) ? body.skip : []).map(String));
    const places = (data?.results || [])
      .filter((r: any) => r?.place_id && !skip.has(r.place_id) && r.business_status !== "CLOSED_PERMANENTLY"
        && Number(r.rating) >= 4 && Number(r.user_ratings_total) >= (eat ? 80 : 150))
      .map((r: any) => {
        const m = dist(r.geometry.location);
        return { name: String(r.name || ""), placeId: r.place_id, lat: r.geometry.location.lat, lng: r.geometry.location.lng,
          rating: Number(r.rating), ratingCount: Number(r.user_ratings_total) || 0, walk: Math.max(1, Math.round(m * 1.3 / 80)),
          price: Number.isFinite(r.price_level) ? r.price_level : null, area: String(r.vicinity || "").slice(0, 60),
          types: (Array.isArray(r.types) ? r.types : []).slice(0, 5) };
      })
      .sort((a: any, b: any) => b.rating * Math.log(b.ratingCount + 1) - a.rating * Math.log(a.ratingCount + 1))
      .slice(0, 6);
    return { ok: true, places };
  } catch (e) { return { ok: false, message: String(e) }; }
}

// ---------- what a place is, from Google, in a sentence ----------
// Google's own summary and a few real reviews go to the model, which writes
// a line on what the place is and — for food — what people say to order.
// Grounded in the reviews, so it describes this place, not a generic one.
async function placeFacts(placeId: string) {
  const key = (Deno.env.get("GOOGLE_PLACES_API_KEY") || "").trim();
  if (!key || !placeId) return null;
  try {
    const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(placeId)}` +
      `&fields=name,types,formatted_address,rating,user_ratings_total,price_level,editorial_summary,reviews&reviews_sort=most_relevant&language=zh-TW&key=${key}`;
    const r = (await (await fetch(url)).json())?.result;
    if (!r) return null;
    return { placeId, name: String(r.name || ""), address: String(r.formatted_address || "").slice(0, 80), types: (r.types || []).slice(0, 5), rating: Number(r.rating) || null,
      ratingCount: Number(r.user_ratings_total) || 0, price: Number.isFinite(r.price_level) ? r.price_level : null,
      summary: String(r.editorial_summary?.overview || "").slice(0, 200),
      reviews: (r.reviews || []).slice(0, 4).map((v: any) => String(v.text || "").replace(/\s+/g, " ").slice(0, 220)).filter(Boolean) };
  } catch { return null; }
}
const BRIEF_PROMPT = (items: string, kind: string, ask = "") => `下面係一啲 Google 地圖上面嘅地點，有 Google 自己嘅簡介同真實評論（JSON）。
${ask ? `佢哋嘅要求：${ask}。按幾啱佢哋要求由最啱排到最唔啱，明顯唔啱嘅唔好放入去；每個加 fit：一句講點解啱（最多 30 字）。\n` : ""}幫一個香港家庭用廣東話寫：
- name_zh：中文名（有通用中文名就用，冇就照抄原名）
- what：一句介紹佢係咩地方、有咩特色（最多 40 字）
- mustTry：${kind === "eat" ? "根據評論，大家推介食咩（寫具體菜式，最多 40 字）" : kind === "shop" ? "根據評論，值得買乜或者有咩店（最多 40 字）" : "根據評論，最值得睇乜或者玩乜（最多 40 字）"}
只可以根據提供嘅簡介同評論寫，評論冇講就留空，唔好作。
菜系同國籍要睇店名、地址（喺邊個國家）同評論先寫，唔肯定就唔好寫國籍：例如喺日本嘅「焼肉」係日式燒肉，唔好寫成韓式；「焼鳥」係日式串燒。
菜式名用中文寫，日文／韓文名可以喺後面括號（例如「牛肋肉（カルビ）」）。
${items}
只回覆 JSON：{"places":[{"placeId":"","name_zh":"","what":"","mustTry":""${ask ? `,"fit":""` : ""}}]}`;
async function briefs(facts: any[], kind: string, ask = "") {
  if (!facts.length || !geminiKeys().length) return {};
  try {
    const p = parseJson(await callGemini([{ text: BRIEF_PROMPT(JSON.stringify(facts), kind, ask) }]));
    const out: Record<string, any> = {};
    (p?.places || []).forEach((x: any, i: number) => { if (x?.placeId) out[x.placeId] = {
      name_zh: str(x.name_zh, 40), what: str(x.what, 80), mustTry: str(x.mustTry, 80), fit: str(x.fit, 60), rank: i }; });
    return out;
  } catch (e) { console.error("brief", String(e)); return {}; }
}
// Shops on a shopping street are mostly small "store"s, not malls, so all three count.
const KIND_TYPE: Record<string, string[]> = { eat: ["restaurant"], see: ["tourist_attraction"], shop: ["store", "shopping_mall", "department_store"] };
// Places worth adding between two stops: candidates from Google around both
// (and the middle), ranked by rating, how many rated it and how far off the
// way it is; then the best few are described from their reviews.
async function suggestAdd(body: any) {
  const key = (Deno.env.get("GOOGLE_PLACES_API_KEY") || "").trim();
  const kind = ["eat", "see", "shop"].includes(body?.kind) ? body.kind : "see";
  const pts = (Array.isArray(body?.points) ? body.points : []).map((x: any) => ({ lat: Number(x?.lat), lng: Number(x?.lng), name: str(x?.name, 40) }))
    .filter((x: any) => Number.isFinite(x.lat) && Number.isFinite(x.lng)).slice(0, 2);
  if (!key || !pts.length) return { ok: false, message: "冇位置資料，搵唔到附近。" };
  const R = 6371000, toR = (x: number) => x * Math.PI / 180;
  const dist = (a: any, b: any) => {
    const h = Math.sin(toR(b.lat - a.lat) / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(toR(b.lng - a.lng) / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  };
  const centres = [...pts];
  if (pts.length === 2 && dist(pts[0], pts[1]) > 1200) centres.push({ lat: (pts[0].lat + pts[1].lat) / 2, lng: (pts[0].lng + pts[1].lng) / 2, name: "" });
  const skip = new Set((Array.isArray(body?.skip) ? body.skip : []).map(String));
  const want = str(body?.want, 40);
  const pf = body?.prefs || {};
  const budget = [1, 2, 3].includes(Number(pf.budget)) ? Number(pf.budget) : 0;
  const near = pf.near === true;
  // what they asked for, in words the model can rank by
  const ask = [want, budget ? ["", "平啲", "中價", "貴少少都得"][budget] : "", near ? "行 5 分鐘內" : "",
    pf.kids ? "啱小朋友" : "", pf.book ? "可以訂位或者唔使排太耐" : ""].filter(Boolean).join("、");
  const seen = new Map<string, any>();
  const raw = new Map<string, any>();      // everything Google returned, for the looser second look
  const minCount = want ? 30 : kind === "eat" ? 80 : kind === "shop" ? 40 : 150;
  // convenience stores and supermarkets are "stores" too, but not what 購物 means
  const notShopping = (r: any) => kind === "shop" && !want &&
    (r.types || []).some((t: string) => /^(convenience_store|supermarket|grocery_or_supermarket|gas_station|car_|atm|bank)/.test(t));
  const keep = (r: any, rating: number, count: number) =>
    r?.place_id && !skip.has(r.place_id) && r.business_status !== "CLOSED_PERMANENTLY" && !notShopping(r)
    && Number(r.rating) >= rating && Number(r.user_ratings_total) >= count;
  await Promise.all(centres.flatMap((c: any) => KIND_TYPE[kind].map(async (type) => {
    try {
      const radius = near ? (kind === "eat" ? 450 : 700) : (kind === "eat" ? 800 : 1500);
      const price = kind === "eat" && budget ? `&minprice=${budget === 3 ? 2 : 0}&maxprice=${budget === 1 ? 1 : budget === 2 ? 2 : 4}` : "";
      const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${c.lat},${c.lng}` +
        `&radius=${radius}&type=${type}${want ? "&keyword=" + encodeURIComponent(want) : ""}${price}&language=zh-TW&key=${key}`;
      for (const r of (await (await fetch(url)).json())?.results || []) {
        if (r?.place_id && !raw.has(r.place_id)) raw.set(r.place_id, r);
        if (!seen.has(r?.place_id) && keep(r, 4, minCount)) seen.set(r.place_id, r);
      }
    } catch { /* one search failing leaves the others */ }
  })));
  // too few? take what Google has with a lower bar rather than say "nothing nearby"
  if (seen.size < 3) for (const r of raw.values()) if (!seen.has(r.place_id) && keep(r, 3.7, 10)) seen.set(r.place_id, r);
  const direct = pts.length === 2 ? dist(pts[0], pts[1]) : 0;
  const cands = [...seen.values()].map((r: any) => {
    const g = r.geometry.location, d = pts.map((p: any) => dist(p, g));
    const detour = pts.length === 2 ? d[0] + d[1] - direct : d[0];
    const near = d[0] <= (d[1] ?? Infinity) ? 0 : 1;
    return { r, detour, near, walk: Math.max(1, Math.round(Math.min(...d) * 1.3 / 80)),
      score: Number(r.rating) * Math.log(Number(r.user_ratings_total) + 1) - detour / 300 };
  }).sort((a: any, b: any) => b.score - a.score).slice(0, ask ? 8 : 6);
  // fast: Google's list straight away; the intros come from brief-many after
  const fast = body?.brief === false;
  const facts = fast ? [] : (await Promise.all(cands.map((c: any) => placeFacts(c.r.place_id)))).filter(Boolean) as any[];
  const b: Record<string, any> = fast ? {} : await briefs(facts, kind, ask);
  // with a request, the model's order (and its leaving out) decides
  const ranked = ask && Object.keys(b).length
    ? cands.filter((c: any) => b[c.r.place_id]).sort((x: any, y: any) => b[x.r.place_id].rank - b[y.r.place_id].rank)
    : cands;
  const places = ranked.slice(0, fast ? 8 : 6).map((c: any) => {
    const r = c.r, x = b[r.place_id] || {};
    return { name: String(r.name || ""), name_zh: x.name_zh || "", placeId: r.place_id, lat: r.geometry.location.lat, lng: r.geometry.location.lng,
      rating: Number(r.rating), ratingCount: Number(r.user_ratings_total) || 0, price: Number.isFinite(r.price_level) ? r.price_level : null,
      types: (r.types || []).slice(0, 5), walk: c.walk, nearName: pts[c.near]?.name || "", onTheWay: pts.length === 2 && c.detour < 600,
      what: x.what || "", mustTry: x.mustTry || "", fit: x.fit || "" };
  });
  return { ok: true, places, ask };
}
// Intros for a list already on screen: facts and reviews for each place,
// then one model call. With a request (ask) the order the model gives back,
// and which it leaves out, says which fit best.
async function briefMany(body: any) {
  const kind = ["eat", "see", "shop"].includes(body?.kind) ? body.kind : "see";
  const ids = (Array.isArray(body?.placeIds) ? body.placeIds : []).map((x: unknown) => str(x, 200)).filter(Boolean).slice(0, 8);
  if (!ids.length) return { ok: false, briefs: {} };
  const facts = (await Promise.all(ids.map((id: string) => placeFacts(id)))).filter(Boolean) as any[];
  return { ok: true, briefs: await briefs(facts, kind, str(body?.ask, 120)) };
}
async function placeBrief(body: any) {
  const kind = ["eat", "see", "shop"].includes(body?.kind) ? body.kind : "see";
  const f = await placeFacts(str(body?.placeId, 200));
  if (!f) return { ok: false, message: "搵唔到呢個地點嘅資料。" };
  const isFood = kind === "eat" || (f.types || []).some((t: string) => /restaurant|food|cafe|bakery|bar|meal/.test(t));
  const x = (await briefs([f], isFood ? "eat" : kind))[f.placeId] || {};
  return { ok: true, brief: { name_zh: x.name_zh || "", what: x.what || "", mustTry: x.mustTry || "", food: isFood,
    rating: f.rating, ratingCount: f.ratingCount, price: f.price } };
}

// A long leg — another city, an airport — asked the way a travel agent
// would answer: which train, whether to buy ahead and how, how often it
// runs, when to set off for the next stop, and whether the plan is too tight.
const ADVICE_PROMPT = (q: string, today: string) => `你係香港人嘅旅遊交通顧問，今日係 ${today}，可以用 Google 搜尋查最新資料。
下面 JSON 係一家人要行嘅一段長途交通：由邊度去邊度、日子、星期幾、幾多人，同埋（如果有）要幾點到。
請答：
1. options：2–3 個搭法（例如大阪去京都：JR 京都線新快速、阪急京都線、京阪本線），每個寫：
   name（搭咩車）、route（喺邊個站上車 → 邊個站落車，有轉車寫埋）、minutes（車程大約幾多分鐘，數字）、
   price（每位大人大約幾錢，用當地貨幣，例如 ¥580）、freq（大約幾耐一班，例如「每 15 分鐘一班」）、
   book（要唔要預先買飛或者訂位，例如「唔使，入閘拍 IC 卡就得」或者「建議提早喺官網訂指定席」）、
   howToBuy（點買，例如「車站售票機」「ICOCA 拍卡」「Klook／官網」）。最適合佢哋嗰個 best:true（得一個）。
2. depart：按佢哋要到嘅時間，建議大約幾點喺邊個站上車（冇講要幾點到就寫一般建議）。
3. feasible：一句講時間夠唔夠、會唔會太趕、有冇繁忙時間或者季節人多要留意。
4. tips：最多 3 點實用提示（每點最多 30 字）。
只可以用搜尋到嘅資料，唔肯定嘅寫「要自己再 check」，唔好作。全部用廣東話。
${q}
只回覆一個 JSON（唔好有其他字、唔好 code fence）：
{"options":[{"name":"","route":"","minutes":30,"price":"","freq":"","book":"","howToBuy":"","best":true}],"depart":"","feasible":"","tips":[""]}`;
function cleanAdvice(p: any) {
  const opts = (Array.isArray(p?.options) ? p.options : []).slice(0, 3).map((o: any) => {
    const m = Math.round(Number(o?.minutes));
    return { name: str(o?.name, 40), route: str(o?.route, 80), minutes: m > 0 && m < 600 ? m : null,
      price: str(o?.price, 30), freq: str(o?.freq, 30), book: str(o?.book, 80), howToBuy: str(o?.howToBuy, 80), best: o?.best === true };
  }).filter((o: any) => o.name);
  if (opts.length && !opts.some((o: any) => o.best)) opts[0].best = true;
  return { options: opts, depart: str(p?.depart, 100), feasible: str(p?.feasible, 140),
    tips: (Array.isArray(p?.tips) ? p.tips : []).slice(0, 3).map((x: unknown) => str(x, 60)).filter(Boolean) };
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
   price 要按佢哋嘅人數同房數計（例如 2 間房就寫兩間房加埋每晚大約幾錢）。roomSize 寫房間大約幾大同啱幾多人（例如「約 25㎡，3 人住得落」），查唔到就留空。
   score 係 1–10 嘅推介指數：按呢個行程（每日去邊、交通方唔方便、搬唔搬酒店）同佢哋嘅要求打分；scoreWhy 一句講點解。
4. 如果 JSON 入面有「住宿要求」，一定要跟；有「想住嘅區」就淨係喺嗰區揀；有「已經建議過」就唔好再推介嗰啲酒店（但區可以再列）。
全部用廣東話。
行程：
${trip}
只回覆一個 JSON（唔好有其他字、唔好 code fence）：
{"areas":[{"area":"梅田","best":true,"pros":"","cons":"","goodFor":""}],"plan":[{"fromDay":1,"toDay":3,"area":"梅田","why":""}],"hotels":[{"name":"中文名","local":"當地語言名","area":"梅田","fromDay":1,"toDay":3,"price":"每晚約 HK$900–1,300","highlights":["",""],"station":"最近車站名（當地語言）","walk":"步行約 5 分鐘","roomSize":"約 25㎡，3 人住得落","score":8,"scoreWhy":"一句"}]}`;

// One hotel the family found themselves, given the same analysis as the
// AI's own picks so they compare like for like.
const STAY_CHECK_PROMPT = (q: string, today: string) => `你係香港人嘅旅遊顧問，今日係 ${today}。下面 JSON 有一間佢哋自己揀嘅酒店（hotel）同佢哋嘅行程、人數、要求。
用 Google 搜尋查呢間酒店，答：
- area：喺邊區
- local：當地語言名
- price：按佢哋嘅人數同房數，每晚大約幾錢（港幣範圍）；查唔到就寫「出發前睇返訂房網」
- roomSize：房間大約幾大、啱幾多人；查唔到留空
- station：最近車站（當地語言）；walk：步行大約幾耐
- highlights：2–3 點好處或者要留意（每點最多 14 字）
- convenience：一句講對呢個行程方唔方便（例如去京都、去機場、每日嘅景點）
- score：1–10 推介指數，scoreWhy 一句講點解
只可以用搜尋到嘅資料，唔好作。全部用廣東話。
${q}
只回覆一個 JSON（唔好有其他字、唔好 code fence）：
{"hotel":{"area":"","local":"","price":"","roomSize":"","station":"","walk":"","highlights":[""],"convenience":"","score":7,"scoreWhy":""}}`;

function cleanHotel(h: any) {
  const sc = Math.round(Number(h?.score));
  return {
    area: str(h?.area, 30), local: str(h?.local, 80), price: str(h?.price, 80), roomSize: str(h?.roomSize, 40),
    station: str(h?.station, 40), walk: str(h?.walk, 30), convenience: str(h?.convenience, 120),
    highlights: (Array.isArray(h?.highlights) ? h.highlights : []).slice(0, 3).map((x: unknown) => str(x, 24)).filter(Boolean),
    score: sc >= 1 && sc <= 10 ? sc : null, scoreWhy: str(h?.scoreWhy, 100),
  };
}

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
      roomSize: str(h?.roomSize, 40), score: (() => { const v = Math.round(Number(h?.score)); return v >= 1 && v <= 10 ? v : null; })(),
      scoreWhy: str(h?.scoreWhy, 100),
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
  if (body?.mode === "leg") return json(await legBetween(body));
  if (body?.mode === "nearby") return json(await nearbyPlaces(body));
  if (body?.mode === "near-search") return json(await nearSearch(body));
  if (body?.mode === "suggest-add") return json(await suggestAdd(body));
  if (body?.mode === "place-brief") return json(await placeBrief(body));
  if (body?.mode === "brief-many") return json(await briefMany(body));
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

  if (body?.mode === "stay-check") {
    let raw = "";
    try { raw = await callGemini([{ text: STAY_CHECK_PROMPT(str(text, 12000), today) }], true); }
    catch (e) { return json({ ok: false, message: whyFailed(String(e)) }); }
    const p = parseJson(raw);
    if (!p?.hotel) return json({ ok: false, message: "查唔到呢間酒店嘅資料。" });
    return json({ ok: true, hotel: cleanHotel(p.hotel) });
  }

  if (body?.mode === "trip-advice") {
    let raw = "";
    try { raw = await callGemini([{ text: ADVICE_PROMPT(str(text, 4000), today) }], true); }
    catch (e) { return json({ ok: false, message: whyFailed(String(e)) }); }
    const a = cleanAdvice(parseJson(raw));
    if (!a.options.length) return json({ ok: false, message: "AI 今次查唔到呢段點去，再試一次。" });
    return json({ ok: true, advice: a });
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
