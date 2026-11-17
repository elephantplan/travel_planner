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

// fast: a short list the model doesn't need to deliberate over (hotel names,
// areas) — it is told to think less, which is most of the wait. Every call
// gives up before Supabase's own limit (~150 s, which answers 546 and nothing
// the app can show), so the family gets a message instead of an empty page.
let noThinkingLevel = false;     // a model that rejects thinkingLevel, once seen
async function callGemini(parts: unknown[], search = false, opts: { fast?: boolean; ms?: number } = {}): Promise<string> {
  let last = "Gemini key 未設定";
  let firstErr = "";        // the configured model's own failure is the one worth reporting
  const models = [...new Set([model(), fallbackModel()])];
  const keys = geminiKeys();
  const started = Date.now();
  const budget = opts.ms || 115000;
  models: for (const m of models) for (const [ki, key] of keys.entries()) {
    const left = budget - (Date.now() - started);
    if (left < 5000) throw new Error("TIMEOUT");
    const gen: Record<string, unknown> = search ? {} : { responseMimeType: "application/json" };
    if (opts.fast && !noThinkingLevel) gen.thinkingConfig = { thinkingLevel: "low" };
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), left);
    let res: Response;
    try {
      res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${key}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: ac.signal,
          // Search grounding and JSON mode can't be combined, so a searched
          // answer comes back as text and is parsed the same forgiving way.
          body: JSON.stringify({ contents: [{ parts }], ...(search ? { tools: [{ google_search: {} }] } : {}),
            ...(Object.keys(gen).length ? { generationConfig: gen } : {}) }),
        },
      );
    } catch (e) {
      clearTimeout(timer);
      if (ac.signal.aborted) throw new Error("TIMEOUT");
      throw e;
    }
    clearTimeout(timer);
    if (!res.ok) {
      last = `Gemini error ${res.status} (model=${m}${search ? ", search" : ""}, key ${ki + 1}/${keys.length}): ${(await res.text()).slice(0, 300)}`;
      // a model without thinkingLevel: drop it and ask the same key again
      if (res.status === 400 && /thinking/i.test(last) && gen.thinkingConfig && !noThinkingLevel) {
        noThinkingLevel = true;
        return callGemini(parts, search, { ...opts, ms: budget - (Date.now() - started) });
      }
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
  if (/TIMEOUT/.test(m)) return "AI 今次諗得太耐（超過兩分鐘），再撳一次通常會快啲。";
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

// ---------- what Google said about a place, kept ----------
// Reviews, contact details and nearest stations don't change from one day
// to the next; once Google has answered, every trip reads the same answer
// from the place_cache table instead of paying for it again.
function sbAdmin() {
  const k = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  return { apikey: k, Authorization: `Bearer ${k}`, "Content-Type": "application/json" };
}
async function cacheGet(key: string, maxDays: number): Promise<any> {
  try {
    const res = await fetch(`${Deno.env.get("SUPABASE_URL")}/rest/v1/place_cache?key=eq.${encodeURIComponent(key)}&select=data,updated_at`, { headers: sbAdmin() });
    if (!res.ok) return null;
    const row = (await res.json())[0];
    if (!row || (Date.now() - new Date(row.updated_at).getTime()) / 86400000 > maxDays) return null;
    return row.data;
  } catch { return null; }
}
async function cachePut(key: string, data: unknown) {
  try {
    await fetch(`${Deno.env.get("SUPABASE_URL")}/rest/v1/place_cache?on_conflict=key`, {
      method: "POST", headers: { ...sbAdmin(), Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ key, data, updated_at: new Date().toISOString() }) });
  } catch { /* the answer is still returned */ }
}

// ---------- opening hours and ratings, kept ----------
// Hours only (Contact data) or rating only (Atmosphere data), never both in
// one ask, and each kept per place: a place Google has no hours for is
// remembered too, so it isn't asked again.
function summarizeHours(weekdayText: string[]): string {
  const parts = weekdayText.map(line => {
    const idx = line.indexOf(":");
    return idx < 0 ? { day: line.trim(), hours: "" } : { day: line.slice(0, idx).trim(), hours: line.slice(idx + 1).trim() };
  });
  const groups = new Map<string, string[]>();
  for (const p of parts) {
    const key = p.hours || "休息";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(p.day);
  }
  if (groups.size === 1) return `${[...groups.keys()][0]}（每日）`;
  if (groups.size > 3) return "每日時間唔同，詳情請睇 Google 地圖";
  return [...groups.entries()].sort((a, b) => b[1].length - a[1].length)
    .map(([hours, days]) => `${days.join("、")}：${hours}`).join("；");
}
async function placeHours(body: any) {
  const pid = str(body?.placeId, 200);
  if (!pid) return { ok: false, message: "冇地點資料，攞唔到營業時間。" };
  let hit = await cacheGet("hours:" + pid, 30);
  if (!hit) {
    const d = await gDetails(pid, "regularOpeningHours", "zh-TW");
    if (gRefused(d) && d.status !== "NOT_FOUND" && d.status !== "INVALID_REQUEST") return { ok: false, message: gRefused(d) };
    hit = { weekdayText: gWeekLines(d.result?.regularOpeningHours) };
    await cachePut("hours:" + pid, hit);
  }
  const wd = hit.weekdayText;
  return { ok: true, weekdayText: wd || null, summary: wd ? summarizeHours(wd) : "" };
}
async function placeRating(body: any) {
  let pid = str(body?.placeId, 200);
  // no place id yet: find it by name first (an id-only search costs nothing)
  if (!pid) {
    const q = [str(body?.query, 80), str(body?.destinationLocal, 40)].filter(Boolean).join(" ");
    if (!q) return { ok: false, message: "冇地點資料，攞唔到評分。" };
    const f = await gTextSearch(q, { fields: "places.id", max: 1 });
    if (gRefused(f)) return { ok: false, message: gRefused(f) };
    pid = f.results[0]?.place_id || "";
    if (!pid) return { ok: true, rating: null, ratingCount: null, placeId: "" };
  }
  let hit = await cacheGet("rating:" + pid, 30);
  if (!hit) {
    const d = await gDetails(pid, "rating,userRatingCount");
    if (gRefused(d) && d.status !== "NOT_FOUND" && d.status !== "INVALID_REQUEST") return { ok: false, message: gRefused(d) };
    const r = d.result || {};
    hit = { rating: typeof r.rating === "number" ? r.rating : null, ratingCount: typeof r.userRatingCount === "number" ? r.userRatingCount : null };
    await cachePut("rating:" + pid, hit);
  }
  return { ok: true, rating: hit.rating, ratingCount: hit.ratingCount, placeId: pid };
}

// ---------- one leg between two places ----------
// Google's Directions API returns no public transport at all in Japan, so the
// old lookup could only offer a 60-minute walk. Walking, driving and (where
// Google has it) transit come from Google; where it has no transit the leg
// says so and points at the Google Maps app instead of guessing. Legs to
// another city are flagged `long` so the app can offer the trip-advice mode.
function legRef(r: any, city = ""): string {
  if (!r || typeof r !== "object") return "";
  if (typeof r.placeId === "string" && r.placeId) return "place_id:" + r.placeId;
  if (Number.isFinite(r.lat) && Number.isFinite(r.lng)) return `${r.lat},${r.lng}`;
  // a name alone (a station) is looked up in the trip's city
  return typeof r.text === "string" && r.text.trim() ? (r.text.trim() + (city ? " " + city : "")).slice(0, 200) : "";
}
// Routes API (the Directions API's successor). The answer is put back into
// the old Directions shape (seconds, metres, transit steps) for rideOf.
function rWaypoint(ref: string): any {
  if (ref.startsWith("place_id:")) return { placeId: ref.slice(9) };
  const m = ref.match(/^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)$/);
  if (m) return { location: { latLng: { latitude: Number(m[1]), longitude: Number(m[2]) } } };
  return { address: ref };
}
async function gDirections(o: string, d: string, mode: string, lang: string) {
  const key = (Deno.env.get("GOOGLE_PLACES_API_KEY") || "").trim();
  if (!key) return { problem: "冇 Google key" };
  const travelMode = mode === "walking" ? "WALK" : mode === "driving" ? "DRIVE" : "TRANSIT";
  const body: Record<string, unknown> = { origin: rWaypoint(o), destination: rWaypoint(d), travelMode };
  if (lang) body.languageCode = lang;
  const mask = "routes.duration,routes.distanceMeters,routes.legs.startLocation,routes.legs.endLocation" +
    (travelMode === "TRANSIT" ? ",routes.legs.steps.travelMode,routes.legs.steps.transitDetails" : "");
  try {
    const res = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", { method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": mask }, body: JSON.stringify(body) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(`Routes ${travelMode} ${res.status}: ${String(j?.error?.message || "").slice(0, 200)}`);
      return { problem: String(j?.error?.status || res.status) };
    }
    const r = j?.routes?.[0], leg = r?.legs?.[0];
    if (!r) return { problem: "ZERO_RESULTS" };
    const ll = (x: any) => x?.latLng ? { lat: x.latLng.latitude, lng: x.latLng.longitude } : null;
    const steps = (leg?.steps || []).map((x: any) => {
      const t = x?.transitDetails;
      if (!t) return { travel_mode: x?.travelMode || "" };
      return { travel_mode: "TRANSIT", transit_details: {
        line: { short_name: t.transitLine?.nameShort || "", name: t.transitLine?.name || "", vehicle: { type: t.transitLine?.vehicle?.type || "" } },
        departure_stop: { name: t.stopDetails?.departureStop?.name || "" }, arrival_stop: { name: t.stopDetails?.arrivalStop?.name || "" },
        num_stops: Number(t.stopCount) || 0 } };
    });
    return { seconds: parseInt(String(r.duration || "0"), 10) || 0, meters: Number(r.distanceMeters) || 0, steps,
      start: ll(leg?.startLocation), end: ll(leg?.endLocation) };
  } catch (e) { return { problem: String(e) }; }
}
// Seoul's numbered lines read 「3號線」, and a few named Korean lines get the
// name a Cantonese reader knows; anything else is Google's own name.
const KO_LINES: Record<string, string> = {
  "경의중앙선": "京義中央線", "수인분당선": "水仁盆唐線", "분당선": "盆唐線", "신분당선": "新盆唐線", "경춘선": "京春線",
  "공항철도": "機場鐵路", "우이신설선": "牛耳新設線", "서해선": "西海線", "신림선": "新林線", "김포골드라인": "金浦金線",
};
function lineLabel(line: any): string {
  const t = line?.vehicle?.type;
  const short = String(line?.short_name || "").trim(), name = String(line?.name || "").trim();
  if (t === "BUS") return short ? `${short}號巴士` : "巴士";
  for (const pick of [short, name]) {
    if (!pick) continue;
    const num = pick.match(/^(\d+)\s*(호선|號線)$/);
    if (num) return `${num[1]}號線`;
    const known = KO_LINES[pick.replace(/\s/g, "")];
    if (known) return known;
  }
  return short || name;
}
function rideOf(steps: any[]) {
  const rides = steps.filter((x: any) => x.travel_mode === "TRANSIT" && x.transit_details);
  if (!rides.length) return null;
  let chain = "", subway = false;
  rides.forEach((x: any, i: number) => {
    const td = x.transit_details, t = td?.line?.vehicle?.type || "";
    if (t !== "BUS") subway = true;
    const label = lineLabel(td?.line) || (t === "BUS" ? "巴士" : "電車");
    if (i === 0) chain += td.departure_stop?.name || "";
    chain += ` ─${label}${td.num_stops ? `・${td.num_stops}站` : ""}─ ${td.arrival_stop?.name || ""}`;
  });
  return { chain, transfers: rides.length - 1, subway,
    from: rides[0].transit_details.departure_stop?.name || "", to: rides[rides.length - 1].transit_details.arrival_stop?.name || "" };
}
const mins = (sec: number) => Math.max(1, Math.round(sec / 60));

// Japan: Google's API has no trains. The stations are real (the nearest
// ones Google knows to each end, with the walk to them); only the line
// between those two stations is asked of the AI, with web search, and it
// is shown as an estimate. A route that doesn't add up is not shown.
async function nearestStation(at: any): Promise<{ name: string; ref: string } | null> {
  const key = (Deno.env.get("GOOGLE_PLACES_API_KEY") || "").trim();
  if (!key || !at || !Number.isFinite(at.lat)) return null;
  const ck = `station:${Number(at.lat).toFixed(3)},${Number(at.lng).toFixed(3)}`;
  const hit = await cacheGet(ck, 180);
  if (hit) return hit.name ? hit : null;
  const found = await nearestStationFromGoogle(at, key);
  await cachePut(ck, found || { name: "" });
  return found;
}
async function nearestStationFromGoogle(at: any, _key: string): Promise<{ name: string; ref: string } | null> {
  for (const type of ["train_station", "subway_station"]) {
    const j = await gNearby({ lat: at.lat, lng: at.lng, radius: 2500, types: [type], rank: "DISTANCE", lang: "ja", max: 1,
      fields: "places.id,places.displayName" });
    const r = j.results?.[0];
    if (r?.place_id) return { name: String(r.name || ""), ref: "place_id:" + r.place_id };
  }
  return null;
}
async function trainEstimate(o: string, d: string, car: any, city: string, lang: string) {
  if (!car?.start || !car?.end) return null;
  const [a, b] = await Promise.all([nearestStation(car.start), nearestStation(car.end)]);
  if (!a || !b || a.name === b.name) return null;
  const [wa, wb] = await Promise.all([gDirections(o, a.ref, "walking", lang), gDirections(b.ref, d, "walking", lang)]) as any[];
  if (!wa.seconds || !wb.seconds || wa.seconds > 1500 || wb.seconds > 1500) return null;
  let j: any = null;
  try {
    j = parseJson(await callGemini([{ text:
      `日本${city ? "「" + city + "」" : ""}：由「${a.name}」站搭電車／地鐵去「${b.name}」站，平時點搭？上網查清楚路線。\n` +
      `只回 JSON：{"legs":[{"line":"路線名（日文原名）","from":"上車站","to":"落車站","stops":站數}],"minutes":車上大約分鐘（唔計行路同等車）}\n` +
      `如果兩個站之間冇合理嘅電車路線（例如要行好遠或者冇直接關係），回 {"none":true}。` }], true));
  } catch { return null; }
  const legs = Array.isArray(j?.legs) ? j.legs.filter((x: any) => x && x.line && x.from && x.to).slice(0, 4) : [];
  const ride = Math.round(Number(j?.minutes) || 0);
  if (j?.none || !legs.length || ride < 1) return null;
  const total = mins(wa.seconds) + ride + mins(wb.seconds) + 3 * legs.length;     // + waiting
  // a train trip that takes far longer than a taxi is a wrong guess
  if (car.seconds && total > Math.max(25, mins(car.seconds) * 3)) return null;
  let chain = `行${mins(wa.seconds)}分 → ` + str(legs[0].from, 30);
  legs.forEach((x: any) => { chain += ` ─${str(x.line, 30)}${Number(x.stops) > 0 ? `・${Math.round(x.stops)}站` : ""}─ ${str(x.to, 30)}`; });
  chain += ` → 行${mins(wb.seconds)}分`;
  return { ok: true, mode: "metro", estimated: true,
    text: `電車約 ${total} 分鐘${legs.length > 1 ? `・轉${legs.length - 1}次` : ""}（估計，車站係真嘅，路線出發前喺 Google 確認）`,
    route: chain, long: total >= 45 };
}
// The same two places, the same way of going: kept for a month, since a
// timetable and a walk don't change between one look and the next.
async function legBetween(body: any) {
  const o = legRef(body?.from, str(body?.city, 40)), d = legRef(body?.to, str(body?.city, 40));
  if (!o || !d) return { ok: false, message: "呢兩個地點冇足夠資料計交通。" };
  const ck = `leg:${str(body?.prefer, 10) || "auto"}:${str(body?.lang, 8)}:${o}|${d}`;
  const hit = await cacheGet(ck, 30);
  if (hit) return hit;
  const out = await legFresh(body, o, d);
  if (out && (out as any).ok) await cachePut(ck, out);
  return out;
}
async function legFresh(body: any, o: string, d: string) {
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
  // too far to walk: try the nearest real stations at each end
  if (!(w?.seconds && w.seconds <= 900)) {
    const est = await trainEstimate(o, d, c, str(body?.city, 40), lang).catch(() => null);
    if (est) return est;
  }
  const bits = [c.seconds ? `的士約 ${mins(c.seconds)} 分鐘` : "", w?.seconds && w.seconds <= 2700 ? `行路約 ${mins(w.seconds)} 分鐘` : ""].filter(Boolean);
  // a trip to another city (Osaka → Kyoto) is worth asking how to do it
  const long = (c.seconds || 0) >= 40 * 60 || (c.meters || 0) >= 25000;
  if (prefer === "transit" || c.seconds || w?.seconds)
    return { ok: true, mode: "metro", noTime: true, long, text: `電車／巴士：撳 Google 睇班次${bits.length ? "（" + bits.join("，") + "）" : ""}` };
  return { ok: false, message: "計唔到呢段交通。" };
}

// For the taxi card: the place's address and phone number in the local
// language, so a driver who doesn't know the name can still find it.
async function placeContact(body: any) {
  const lang = str(body?.lang, 8) || "ja";
  let pid = str(body?.placeId, 200);
  const ck = pid ? `contact:${lang}:${pid}` : "";
  if (ck) { const hit = await cacheGet(ck, 90); if (hit) return hit; }
  try {
    if (!pid) {
      const q = str(body?.query, 80);
      if (!q) return { ok: false };
      pid = (await gTextSearch(q, { fields: "places.id", max: 1, lang })).results?.[0]?.place_id || "";
      if (!pid) return { ok: false };
    }
    const r = (await gDetails(pid, "displayName,formattedAddress,nationalPhoneNumber,internationalPhoneNumber", lang)).result;
    if (!r) return { ok: false };
    const out = { ok: true, name: String(r.displayName?.text || ""), address: String(r.formattedAddress || "").replace(/^日本、?\s*/, "").replace(/^〒\d{3}-\d{4}\s*/, "").replace(/^대한민국\s*/, ""),
      phone: String(r.nationalPhoneNumber || ""), intl: String(r.internationalPhoneNumber || "") };
    if (ck) await cachePut(ck, out);
    return out;
  } catch { return { ok: false }; }
}

// ---------- Google Places API (New) ----------
// The same block is pasted into each edge function that asks Google about
// places (trip-import, ai-assistant, place-photo-store, place-local-name), so
// each can be deployed on its own; change it here and copy it across.
//
// Answers come back in the shape the old (legacy) Places API used —
// place_id, name, geometry.location, rating, user_ratings_total — so the
// code that reads them did not have to change. Every request names exactly
// the fields it needs (X-Goog-FieldMask): Google bills by the dearest field
// asked for, so a list never asks for reviews or photos.
const PLACES = "https://places.googleapis.com/v1";
const G_OK = new Set(["OK", "ZERO_RESULTS"]);
const PRICE: Record<string, number> = { PRICE_LEVEL_FREE: 0, PRICE_LEVEL_INEXPENSIVE: 1, PRICE_LEVEL_MODERATE: 2,
  PRICE_LEVEL_EXPENSIVE: 3, PRICE_LEVEL_VERY_EXPENSIVE: 4 };
const PRICE_NAME = ["PRICE_LEVEL_FREE", "PRICE_LEVEL_INEXPENSIVE", "PRICE_LEVEL_MODERATE", "PRICE_LEVEL_EXPENSIVE", "PRICE_LEVEL_VERY_EXPENSIVE"];
// a list: who, where, what kind, open or shut for good, and how well rated
const LIST_FIELDS = "places.id,places.displayName,places.formattedAddress,places.location,places.types,places.businessStatus,places.rating,places.userRatingCount,places.priceLevel";
function gLegacy(p: any): any {
  if (!p) return null;
  return { place_id: p.id || "", name: p.displayName?.text || "", formatted_address: p.formattedAddress || "",
    vicinity: p.formattedAddress || "",
    geometry: p.location ? { location: { lat: p.location.latitude, lng: p.location.longitude } } : undefined,
    rating: typeof p.rating === "number" ? p.rating : undefined,
    user_ratings_total: typeof p.userRatingCount === "number" ? p.userRatingCount : undefined,
    types: Array.isArray(p.types) ? p.types : [], business_status: p.businessStatus || undefined,
    price_level: p.priceLevel in PRICE ? PRICE[p.priceLevel] : undefined };
}
// one request; a busy answer (429/5xx) is tried twice more. Refusals come
// back as { status, error_message } with the old API's status words.
async function gNew(path: string, mask: string, body?: unknown, lang = ""): Promise<any> {
  const key = (Deno.env.get("GOOGLE_PLACES_API_KEY") || "").trim();
  if (!key) return { status: "REQUEST_DENIED", error_message: "GOOGLE_PLACES_API_KEY not set" };
  const url = `${PLACES}/${path}${!body && lang ? (path.includes("?") ? "&" : "?") + "languageCode=" + encodeURIComponent(lang) : ""}`;
  for (let k = 0; k < 3; k++) {
    let res: Response | null = null, j: any = null;
    try {
      res = await fetch(url, { method: body ? "POST" : "GET",
        headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": mask },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      j = await res.json().catch(() => ({}));
    } catch (e) { j = { error: { status: "FETCH_FAILED", message: String(e) } }; }
    if (res && res.ok) return { status: "OK", data: j };
    const code = res?.status || 0, st = String(j?.error?.status || "");
    const busy = code === 429 || code >= 500 || /RESOURCE_EXHAUSTED|UNAVAILABLE|FETCH_FAILED|INTERNAL/.test(st);
    if (!busy || k === 2) {
      const status = code === 429 || /RESOURCE_EXHAUSTED/.test(st) ? "OVER_QUERY_LIMIT"
        : code === 404 || /NOT_FOUND/.test(st) ? "NOT_FOUND"
        : code === 403 || /PERMISSION_DENIED/.test(st) ? "REQUEST_DENIED"
        : code === 400 ? "INVALID_REQUEST" : st || "UNKNOWN_ERROR";
      const msg = String(j?.error?.message || "");
      console.error(`Places (New) ${path.split("?")[0].slice(0, 40)} ${status}: ${msg.slice(0, 200)}`);
      return { status, error_message: msg };
    }
    await new Promise(r => setTimeout(r, 900 * (k + 1)));
  }
  return { status: "UNKNOWN_ERROR", error_message: "" };
}
const gRefused = (d: any) => d && d.status && !G_OK.has(d.status)
  ? `Google 地點搜尋冇答（${d.status}${d.error_message ? "：" + String(d.error_message).slice(0, 80) : ""}）` : "";
// words → places; around a point when one is given (a bias, not a fence)
async function gTextSearch(q: string, o: { lat?: number; lng?: number; radius?: number; type?: string; lang?: string;
  max?: number; prices?: number[]; fields?: string } = {}): Promise<any> {
  const body: Record<string, unknown> = { textQuery: q, pageSize: Math.min(20, o.max || 10) };
  if (o.lang) body.languageCode = o.lang;
  if (Number.isFinite(o.lat) && Number.isFinite(o.lng))
    body.locationBias = { circle: { center: { latitude: o.lat, longitude: o.lng }, radius: Math.min(50000, o.radius || 3000) } };
  if (o.type) body.includedType = o.type;
  if (o.prices?.length) body.priceLevels = o.prices.map(p => PRICE_NAME[p]).filter(Boolean);
  const r = await gNew("places:searchText", o.fields || LIST_FIELDS, body);
  if (r.status !== "OK") return { status: r.status, error_message: r.error_message, results: [] };
  const results = (r.data?.places || []).map(gLegacy);
  return { status: results.length ? "OK" : "ZERO_RESULTS", results };
}
// what is around a point, of some kinds, most popular (or nearest) first
async function gNearby(o: { lat: number; lng: number; radius: number; types: string[]; rank?: "POPULARITY" | "DISTANCE";
  lang?: string; max?: number; fields?: string }): Promise<any> {
  const body: Record<string, unknown> = { includedTypes: o.types, maxResultCount: Math.min(20, o.max || 20),
    locationRestriction: { circle: { center: { latitude: o.lat, longitude: o.lng }, radius: Math.min(50000, o.radius) } },
    rankPreference: o.rank || "POPULARITY" };
  if (o.lang) body.languageCode = o.lang;
  const r = await gNew("places:searchNearby", o.fields || LIST_FIELDS, body);
  if (r.status !== "OK") return { status: r.status, error_message: r.error_message, results: [] };
  const results = (r.data?.places || []).map(gLegacy);
  return { status: results.length ? "OK" : "ZERO_RESULTS", results };
}
// one place, only the fields asked for (no "places." prefix here)
async function gDetails(id: string, fields: string, lang = ""): Promise<any> {
  if (!id) return { status: "INVALID_REQUEST", error_message: "no place id" };
  const r = await gNew(`places/${encodeURIComponent(id)}`, fields, undefined, lang);
  return r.status === "OK" ? { status: "OK", result: r.data } : r;
}
// The week's hours as seven lines, 24-hour clock, Monday first:
// 「星期一: 11:00 – 15:00, 17:00 – 22:00」, 「星期二: 休息」, 「…: 24 小時營業」.
function gWeekLines(h: any): string[] | null {
  const P = Array.isArray(h?.periods) ? h.periods : [];
  if (!P.length) return null;
  const NAMES = ["日", "一", "二", "三", "四", "五", "六"];
  if (P.length === 1 && P[0]?.open && !P[0]?.close) return [1, 2, 3, 4, 5, 6, 0].map(d => `星期${NAMES[d]}: 24 小時營業`);
  const pad = (n: unknown) => String(Number(n) || 0).padStart(2, "0");
  const by: string[][] = [[], [], [], [], [], [], []];
  for (const p of P) {
    if (!p?.open || !Number.isFinite(p.open.day)) continue;
    const close = p.close ? `${pad(p.close.hour)}:${pad(p.close.minute)}` : "24:00";
    by[p.open.day].push(`${pad(p.open.hour)}:${pad(p.open.minute)} – ${close}`);
  }
  return [1, 2, 3, 4, 5, 6, 0].map(d => `星期${NAMES[d]}: ${by[d].length ? by[d].join(", ") : "休息"}`);
}
// a photo's address: Google answers with a short-lived image URL
async function gPhotoUri(photoName: string, maxWidth = 800): Promise<string> {
  const key = (Deno.env.get("GOOGLE_PLACES_API_KEY") || "").trim();
  if (!key || !photoName) return "";
  try {
    const j = await (await fetch(`${PLACES}/${photoName}/media?maxWidthPx=${maxWidth}&skipHttpRedirect=true&key=${key}`)).json();
    return String(j?.photoUri || "");
  } catch { return ""; }
}

// A name typed by hand, looked up around a point — for chains (一蘭,
// Starbucks) Google then returns the branches close to the previous stop
// instead of the most famous ones, each with its distance in metres.
async function nearSearch(body: any) {
  const lat = Number(body?.lat), lng = Number(body?.lng);
  const q = str(body?.query, 80);
  if (!q || !Number.isFinite(lat) || !Number.isFinite(lng)) return { ok: false, places: [] };
  const R = 6371000, toR = (x: number) => x * Math.PI / 180;
  const dist = (g: any) => {
    const a = Math.sin(toR(g.lat - lat) / 2) ** 2 + Math.cos(toR(lat)) * Math.cos(toR(g.lat)) * Math.sin(toR(g.lng - lng) / 2) ** 2;
    return Math.round(2 * R * Math.asin(Math.sqrt(a)));
  };
  try {
    const data = await gTextSearch(q, { lat, lng, radius: 3000, lang: str(body?.lang, 8) || "zh-TW", max: 12 });
    if (gRefused(data)) return { ok: false, places: [], message: gRefused(data) };
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
  const lat = Number(body?.lat), lng = Number(body?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { ok: false, message: "冇位置資料。" };
  const eat = body?.kind === "eat";
  const lang = typeof body?.lang === "string" ? body.lang.slice(0, 8) : "";
  try {
    const data = await gNearby({ lat, lng, radius: eat ? 700 : 1500, types: [eat ? "restaurant" : "tourist_attraction"], lang });
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
  if (!placeId) return null;
  const hit = await cacheGet("facts:" + placeId, 60);
  if (hit) return hit;
  try {
    const r = (await gDetails(placeId, "id,displayName,types,formattedAddress,rating,userRatingCount,priceLevel,editorialSummary,reviews", "zh-TW")).result;
    if (!r) return null;
    const out = { placeId, name: String(r.displayName?.text || ""), address: String(r.formattedAddress || "").slice(0, 80), types: (r.types || []).slice(0, 5),
      rating: Number(r.rating) || null, ratingCount: Number(r.userRatingCount) || 0, price: r.priceLevel in PRICE ? PRICE[r.priceLevel] : null,
      summary: String(r.editorialSummary?.text || "").slice(0, 200),
      reviews: (r.reviews || []).slice(0, 4).map((v: any) => String(v?.text?.text || v?.originalText?.text || "").replace(/\s+/g, " ").slice(0, 220)).filter(Boolean) };
    await cachePut("facts:" + placeId, out);
    return out;
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
// Places worth adding between two stops, in one list that mixes two kinds of
// good: what Google rates highly right there, and what is famous (a 名店
// people travel for). Google gives the real places nearby; the model, which
// knows the names, says which of them are famous, orders the list for what
// was asked, and names up to three famous ones nearby that the list missed —
// each checked on Google (real, not shut for good, close enough) before it
// is shown. The whole answer is kept for a week, so asking again is free.
const FAMOUS_PROMPT = (items: string, kind: string, area: string, ask: string) => `你係熟悉當地嘅香港旅遊達人。下面係 Google 地圖喺「${area}」附近搵到嘅${kind === "eat" ? "餐廳" : kind === "shop" ? "購物地方" : "景點"}（JSON，有評分、幾多人評、行幾耐）。
${ask ? `佢哋嘅要求：${ask}。\n` : ""}請：
1. order：由最值得去排到最唔值得（placeId 陣列）。有名、口碑好、真係值得專程去嘅排前；${ask ? "唔啱要求嘅唔好放入去；" : ""}評分高但人評得少嘅要小心。
2. famous：入面邊幾間係出名嘅（例如食べログ百名店、米芝蓮、當地人或者遊客都會專程去），唔肯定就唔好寫（placeId 陣列）。
3. fit：每間一句講點解值得去（最多 24 字，廣東話），用 {"placeId":"一句"}。
4. extra：如果你知道附近（行 15 分鐘內）有更出名、而上面冇嘅${kind === "eat" ? "餐廳" : "地方"}，最多 3 間，寫當地語言原名 name 同一句 why；冇就空陣列。只寫你肯定存在嘅。
${items}
只回覆 JSON：{"order":[""],"famous":[""],"fit":{"placeId":""},"extra":[{"name":"","why":""}]}`;
async function suggestAdd(body: any) {
  const kind = ["eat", "see", "shop"].includes(body?.kind) ? body.kind : "see";
  const pts = (Array.isArray(body?.points) ? body.points : []).map((x: any) => ({ lat: Number(x?.lat), lng: Number(x?.lng), name: str(x?.name, 40) }))
    .filter((x: any) => Number.isFinite(x.lat) && Number.isFinite(x.lng)).slice(0, 2);
  if (!pts.length) return { ok: false, message: "冇位置資料，搵唔到附近。" };
  const R = 6371000, toR = (x: number) => x * Math.PI / 180;
  const dist = (a: any, b: any) => {
    const h = Math.sin(toR(b.lat - a.lat) / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(toR(b.lng - a.lng) / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  };
  const skip = new Set((Array.isArray(body?.skip) ? body.skip : []).map(String));
  const want = str(body?.want, 40);
  const pf = body?.prefs || {};
  const budget = [1, 2, 3].includes(Number(pf.budget)) ? Number(pf.budget) : 0;
  const near = pf.near === true;
  const ask = [want, budget ? ["", "平啲", "中價", "貴少少都得"][budget] : "", near ? "行 5 分鐘內" : "",
    pf.kids ? "啱小朋友" : "", pf.book ? "可以訂位或者唔使排太耐" : ""].filter(Boolean).join("、");
  const ck = `sug2:${kind}:${want}:${budget}:${near ? 1 : 0}:${pf.kids ? 1 : 0}:${pf.book ? 1 : 0}:` +
    pts.map((p: any) => `${p.lat.toFixed(3)},${p.lng.toFixed(3)}`).join("|");
  let places: any[] | null = (await cacheGet(ck, 7))?.places || null;
  if (!places) {
    const out = await suggestFresh(kind, pts, want, budget, near, ask, dist);
    if (!out.ok) return out;
    places = out.places;
    if (places!.length) await cachePut(ck, { places });
  }
  return { ok: true, places: places!.filter((x: any) => !skip.has(x.placeId)).slice(0, 8), ask, ranked: true };
}
async function suggestFresh(kind: string, pts: any[], want: string, budget: number, near: boolean, ask: string, dist: (a: any, b: any) => number) {
  const centres = [...pts];
  if (pts.length === 2 && dist(pts[0], pts[1]) > 1200) centres.push({ lat: (pts[0].lat + pts[1].lat) / 2, lng: (pts[0].lng + pts[1].lng) / 2, name: "" });
  const radius = near ? (kind === "eat" ? 450 : 700) : (kind === "eat" ? 800 : 1500);
  const seen = new Map<string, any>();
  const raw = new Map<string, any>();      // everything Google returned, for the looser second look
  const minCount = want ? 30 : kind === "eat" ? 80 : kind === "shop" ? 40 : 150;
  // convenience stores and supermarkets are "stores" too, but not what 購物 means
  const notShopping = (r: any) => kind === "shop" && !want &&
    (r.types || []).some((t: string) => /^(convenience_store|supermarket|grocery_or_supermarket|gas_station|car_|atm|bank)/.test(t));
  const priceOk = (r: any) => !(kind === "eat" && budget && Number.isFinite(r.price_level)) ||
    (budget === 1 ? r.price_level <= 1 : budget === 2 ? r.price_level <= 2 : r.price_level >= 2);
  const keep = (r: any, rating: number, count: number) =>
    r?.place_id && r.business_status !== "CLOSED_PERMANENTLY" && !notShopping(r) && priceOk(r)
    && Number(r.rating) >= rating && Number(r.user_ratings_total) >= count;
  const refused: string[] = [];
  await Promise.all(centres.map(async (c: any) => {
    try {
      // a kind of food is words, so a text search near here; otherwise what is around, most popular first
      const data = want
        ? await gTextSearch(want, { lat: c.lat, lng: c.lng, radius, type: KIND_TYPE[kind][0], lang: "zh-TW", max: 20,
            prices: kind === "eat" && budget ? (budget === 1 ? [0, 1] : budget === 2 ? [1, 2] : [2, 3, 4]) : undefined })
        : await gNearby({ lat: c.lat, lng: c.lng, radius, types: KIND_TYPE[kind], lang: "zh-TW", max: 20 });
      if (gRefused(data)) refused.push(gRefused(data));
      for (const r of data?.results || []) {
        if (!r?.geometry || dist(c, r.geometry.location) > radius * 1.6) continue;     // a bias, so fence it here
        if (r.place_id && !raw.has(r.place_id)) raw.set(r.place_id, r);
        if (!seen.has(r.place_id) && keep(r, 4, minCount)) seen.set(r.place_id, r);
      }
    } catch { /* one search failing leaves the others */ }
  }));
  if (!raw.size && refused.length) return { ok: false, places: [], message: refused[0] };
  if (seen.size < 3) for (const r of raw.values()) if (!seen.has(r.place_id) && keep(r, 3.7, 10)) seen.set(r.place_id, r);
  const direct = pts.length === 2 ? dist(pts[0], pts[1]) : 0;
  const shape = (r: any, extra: any = {}) => {
    const g = r.geometry.location, d = pts.map((p: any) => dist(p, g));
    const detour = pts.length === 2 ? d[0] + d[1] - direct : d[0];
    const nearIdx = d[0] <= (d[1] ?? Infinity) ? 0 : 1;
    return { name: String(r.name || ""), name_zh: "", placeId: r.place_id, lat: g.lat, lng: g.lng,
      rating: Number(r.rating) || null, ratingCount: Number(r.user_ratings_total) || 0, price: Number.isFinite(r.price_level) ? r.price_level : null,
      types: (r.types || []).slice(0, 5), walk: Math.max(1, Math.round(Math.min(...d) * 1.3 / 80)), nearName: pts[nearIdx]?.name || "",
      onTheWay: pts.length === 2 && detour < 600, what: "", mustTry: "", fit: "", famous: false,
      score: Number(r.rating) * Math.log(Number(r.user_ratings_total) + 1) - detour / 300, ...extra };
  };
  let list = [...seen.values()].map((r: any) => shape(r)).sort((a: any, b: any) => b.score - a.score).slice(0, 10);
  // the model's turn: famous ones marked, the order, and any famous ones missed
  if (geminiKeys().length) {
    try {
      const area = pts.map((p: any) => p.name).filter(Boolean).join("、") || "呢度";
      const items = JSON.stringify(list.map((x: any) => ({ placeId: x.placeId, name: x.name, types: x.types.slice(0, 3),
        rating: x.rating, ratingCount: x.ratingCount, walk: x.walk })));
      const j = parseJson(await callGemini([{ text: FAMOUS_PROMPT(items, kind, area, ask) }], false, { fast: true, ms: 30000 }));
      const famous = new Set((Array.isArray(j?.famous) ? j.famous : []).map(String));
      const fit = j?.fit && typeof j.fit === "object" ? j.fit : {};
      list.forEach((x: any) => { x.famous = famous.has(x.placeId); x.fit = str(fit[x.placeId], 40); });
      const order = (Array.isArray(j?.order) ? j.order : []).map(String);
      if (order.length) {
        const pos = new Map(order.map((id: string, i: number) => [id, i]));
        const ranked = list.filter((x: any) => pos.has(x.placeId)).sort((a: any, b: any) => (pos.get(a.placeId) as number) - (pos.get(b.placeId) as number));
        if (ranked.length >= Math.min(3, list.length)) list = ranked;
      }
      // famous ones Google's list missed, each looked up and kept only if real and close
      const extra = (Array.isArray(j?.extra) ? j.extra : []).slice(0, 3).filter((e: any) => str(e?.name, 60));
      const found = await Promise.all(extra.map(async (e: any) => {
        const r = (await gTextSearch(str(e.name, 60), { lat: pts[0].lat, lng: pts[0].lng, radius: 1500, lang: "zh-TW", max: 1 })).results?.[0];
        if (!r?.geometry || r.business_status === "CLOSED_PERMANENTLY" || !(Number(r.rating) >= 3.8)) return null;
        if (Math.min(...pts.map((p: any) => dist(p, r.geometry.location))) > (near ? 600 : 1500)) return null;
        if (list.some((x: any) => x.placeId === r.place_id)) { const x = list.find((y: any) => y.placeId === r.place_id); x.famous = true; return null; }
        return shape(r, { famous: true, fit: str(e.why, 40) });
      }));
      const add = found.filter(Boolean) as any[];
      // the famous extras go in after the first famous one already listed
      if (add.length) list = [...list.filter((x: any) => x.famous), ...add, ...list.filter((x: any) => !x.famous)];
    } catch (e) { console.error("famous", String(e)); }
  }
  return { ok: true, places: list.slice(0, 10) };
}
// Intros for a list already on screen: facts and reviews for each place,
// then one model call. With a request (ask) the order the model gives back,
// and which it leaves out, says which fit best.
async function briefMany(body: any) {
  const kind = ["eat", "see", "shop"].includes(body?.kind) ? body.kind : "see";
  // a list on screen: only ranked against the request, from what the
  // search already returned (name, kind, rating) — no review lookups, which
  // are the dearest Google call; the intro comes once a place is added
  if (Array.isArray(body?.places)) {
    const ask = str(body?.ask, 120);
    const facts = body.places.slice(0, 10).map((p: any) => ({ placeId: str(p?.placeId, 200), name: str(p?.name, 80),
      types: (Array.isArray(p?.types) ? p.types : []).slice(0, 5).map((t: unknown) => str(t, 30)),
      rating: Number(p?.rating) || null, ratingCount: Number(p?.ratingCount) || 0 })).filter((p: any) => p.placeId);
    if (!facts.length || !ask) return { ok: true, briefs: {} };
    return { ok: true, briefs: await briefs(facts, kind, ask) };
  }
  const ids = (Array.isArray(body?.placeIds) ? body.placeIds : []).map((x: unknown) => str(x, 200)).filter(Boolean).slice(0, 8);
  if (!ids.length) return { ok: false, briefs: {} };
  const facts = (await Promise.all(ids.map((id: string) => placeFacts(id)))).filter(Boolean) as any[];
  return { ok: true, briefs: await briefs(facts, kind, str(body?.ask, 120)) };
}
async function placeBrief(body: any) {
  const kind = ["eat", "see", "shop"].includes(body?.kind) ? body.kind : "see";
  const pid = str(body?.placeId, 200);
  const ck = `brief2:${kind}:${pid}`;
  const hit = pid ? await cacheGet(ck, 90) : null;
  if (hit) return { ok: true, brief: hit };
  const f = await placeFacts(pid);
  if (!f) return { ok: false, message: "搵唔到呢個地點嘅資料。" };
  const isFood = kind === "eat" || (f.types || []).some((t: string) => /restaurant|food|cafe|bakery|bar|meal/.test(t));
  const x = (await briefs([f], isFood ? "eat" : kind))[f.placeId] || {};
  const brief = { name_zh: x.name_zh || "", what: x.what || "", mustTry: x.mustTry || "", food: isFood,
    rating: f.rating, ratingCount: f.ratingCount, price: f.price };
  if (brief.what) await cachePut(ck, brief);
  return { ok: true, brief };
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

// Tabelog 百名店 near the plan: the model searches the web for the
// restaurants on Tabelog's 百名店 lists (any genre, any recent year) that
// are close to the places the family is going each day. The app then finds
// each on Google Maps and works out the day and stop it is nearest to.
const HYAKU_PROMPT = (q: string, today: string) => `你係香港人嘅日本美食顧問，今日係 ${today}，可以用 Google 搜尋。
下面 JSON 係一個日本行程：每日去邊幾個地方。
請搵出喺呢啲地方附近（行路大約 15 分鐘內）、真係入選咗「食べログ 百名店」（任何類別、近幾年）嘅餐廳，最多 15 間，盡量每日都有，唔好集中喺一日。
每間寫：
- name_jp：日文店名（同食べログ上面一樣）
- name_zh：中文名（冇就留空）
- genre：類別（例如 ラーメン、うどん、焼肉、寿司、喫茶店、パン）
- award：入選邊年邊類（例如「百名店 2025 ラーメン」）
- area：喺邊區（例如 道頓堀、梅田、祇園）
- day：近邊一日（數字）
- why：一句講點解值得去、大家推介食咩（最多 30 字，廣東話）
如果 JSON 有 genre，就淨係搵嗰類嘅百名店（例如 genre 係 ラーメン 就淨係搵「ラーメン 百名店」）。
只可以用搜尋到嘅資料，唔肯定係百名店就唔好寫。
${q}
只回覆一個 JSON（唔好有其他字、唔好 code fence）：
{"places":[{"name_jp":"","name_zh":"","genre":"","award":"","area":"","day":1,"why":""}]}`;
function cleanHyaku(p: any) {
  return (Array.isArray(p?.places) ? p.places : []).slice(0, 15).map((x: any) => ({
    name_jp: str(x?.name_jp, 60), name_zh: str(x?.name_zh, 40), genre: str(x?.genre, 20), award: str(x?.award, 40),
    area: str(x?.area, 30), day: Math.max(0, Math.floor(Number(x?.day) || 0)), why: str(x?.why, 80),
  })).filter((x: any) => x.name_jp || x.name_zh);
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

// Step one of a hotel search: only which areas suit the trip (and which
// nights where). Small and quick, so the page has something to show while
// each area's hotels are being picked, one request per area.
const STAY_AREAS_PROMPT = (trip: string, today: string) => `你係香港人嘅旅遊顧問。下面係一個家庭嘅行程（JSON），今日係 ${today}。
淨係答住宿區，唔使揀酒店：
1. areas：3 個最適合呢個行程嘅住宿區（如果 JSON 有「想住嘅區」就只寫嗰區）。每區寫 pros（一句）、cons（一句）、goodFor（啱咩人），最適合嗰個 best:true（得一個）。
2. plan：如果有幾晚喺第二個城市住會慳好多車程，寫邊幾晚（fromDay / toDay，第幾日，toDay 係退房嗰日）住邊區；全程住同一區就留空陣列。
全部用廣東話，每句最多 30 字。
行程：
${trip}
只回覆 JSON：{"areas":[{"area":"","best":true,"pros":"","cons":"","goodFor":""}],"plan":[{"fromDay":1,"toDay":3,"area":"","why":""}]}`;

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
  if (body?.mode === "place-contact") return json(await placeContact(body));
  if (body?.mode === "place-hours") return json(await placeHours(body));
  if (body?.mode === "place-rating") return json(await placeRating(body));
  // is Places API (New) and the Routes API switched on for the key?
  if (body?.mode === "google-check") {
    const [pl, ro] = await Promise.all([gTextSearch("Tokyo Station", { fields: "places.id", max: 1 }),
      gDirections("35.681,139.767", "35.690,139.700", "driving", "")]);
    return json({ ok: true, places: pl.status, placesMessage: pl.error_message || "", routes: (ro as any).problem || "OK" });
  }
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

  if (body?.mode === "stay-areas") {
    let raw = "";
    try { raw = await callGemini([{ text: STAY_AREAS_PROMPT(str(text, 12000), today) }], false, { fast: true, ms: 60000 }); }
    catch (e) { return json({ ok: false, message: whyFailed(String(e)) }); }
    const out = cleanStays(parseJson(raw));
    if (!out.areas.length) return json({ ok: false, message: "AI 今次諗唔到住邊區，再試一次。" });
    return json({ ok: true, stays: { areas: out.areas, plan: out.plan } });
  }

  if (body?.mode === "stay-suggest") {
    // quick: names, areas and nights only, from the model's own knowledge —
    // a few seconds instead of a web search; the app then checks each hotel
    // on Google and asks stay-check for its price, room and station
    const quick = body?.quick === true;
    const QUICK = "\n【快速模式】唔使上網搜尋。price、station、walk、roomSize、scoreWhy 留空字串，score 用 null。只寫你肯定真實存在、仲營業緊嘅酒店，唔肯定就唔好寫。";
    let raw = "";
    try { raw = await callGemini([{ text: STAY_PROMPT(str(text, 12000), today) + (quick ? QUICK : "") }], !quick, { fast: quick, ms: quick ? 90000 : 115000 }); }
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

  if (body?.mode === "hyakumeiten") {
    let raw = "";
    try { raw = await callGemini([{ text: HYAKU_PROMPT(str(text, 6000), today) }], true); }
    catch (e) { return json({ ok: false, message: whyFailed(String(e)) }); }
    const places = cleanHyaku(parseJson(raw));
    return json({ ok: true, places });
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
