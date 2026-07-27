// Supabase Edge Function: ai-assistant
// Proxies Gemini + Google Places calls so the browser never sees the API keys.
// Actions: 'status' | 'weather' | 'foliage' | 'suggest' | 'ask' | 'place-photo' | 'place-search' | 'place-rating' | 'place-hours' | 'transit' | 'board-ai' | 'day-plan' | 'make-section'

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SEOUL_LAT = 37.5665;
const SEOUL_LON = 126.9780;
const TRIP_DATES = ["2026-10-23", "2026-10-24", "2026-10-25", "2026-10-26", "2026-10-27", "2026-10-28"];
const PHOTO_CACHE_MAX_AGE_DAYS = 90;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

async function fetchWeather() {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${SEOUL_LAT}&longitude=${SEOUL_LON}` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weathercode` +
    `&timezone=Asia%2FSeoul&start_date=${TRIP_DATES[0]}&end_date=${TRIP_DATES[TRIP_DATES.length - 1]}`;
  const res = await fetch(url);
  if (!res.ok) return { inForecastRange: false, daily: null };
  const data = await res.json();
  const inForecastRange = Array.isArray(data?.daily?.time) && data.daily.time.length > 0;
  return { inForecastRange, daily: data?.daily ?? null };
}

// NOTE: deliberately no maxOutputTokens. Setting one caps the model BELOW its
// own default, and since this model's thinking tokens are billed against the
// same budget, an explicit cap is what pushed the long board-ai answer into
// finishReason=MAX_TOKENS. Let the model use its full default budget; the
// prompts are instead written to ask for less.
async function callGemini(apiKey: string, prompt: string, opts?: { json?: boolean }): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${apiKey}`;
  const generationConfig: Record<string, unknown> = {};
  if (opts?.json) generationConfig.responseMimeType = "application/json";
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini error ${res.status}: ${errText.slice(0, 300)}`);
  }
  const data = await res.json();
  // A long structured ask (e.g. a dozen detailed candidates) can hit the output
  // token cap mid-JSON — the response is then guaranteed to fail JSON.parse.
  // Flagging this here lets callers give "the answer was too long, try again"
  // instead of silently showing a JSON.parse failure to the user.
  if (data?.candidates?.[0]?.finishReason === "MAX_TOKENS") {
    throw new Error("TRUNCATED: Gemini 回覆俾輸出上限截斷咗");
  }
  const text = data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join("") ?? "";
  return text || "（AI冇回覆內容）";
}

function friendlyGeminiError(e: unknown): string {
  const msg = String(e);
  if (msg.includes("429")) {
    return "⏳ Gemini 免費額度暫時用晒（quota exceeded），一般幾分鐘至一日內會重置，請等陣再試。如果經常撞到，可能要去 Google AI Studio 檢查你個key嘅rate limit（ai.dev/rate-limit）。";
  }
  if (msg.includes("TRUNCATED")) {
    return "✂️ AI 今次答案太長俾截斷咗，未夠格式完整。請再撳一次試多次（通常第二次就得）。";
  }
  return "🔧 AI暫時無法回覆：" + msg.slice(0, 200);
}

// Strip markdown fences, then also try the substring between the first "{"
// and the last "}" — Gemini occasionally wraps valid JSON in a stray leading
// or trailing sentence even when told not to. Returns null (never throws) so
// callers can fall back to a clean error instead of showing broken JSON.
function parseAiJson(aiText: string): any {
  const cleaned = aiText.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch { /* fall through to the braces-substring attempt below */ }
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch { /* genuinely malformed/truncated — give up */ }
  }
  return null;
}

// The trip's background facts (who's going, dates, constraints like "姨姨唔可以
// 行樓梯", the theme). Every prompt starts with this, so it used to be the one
// thing you could not change without redeploying the function. It now comes
// from the page — editable by the family — and falls back to the original text
// so an older client, or a snapshot saved before the field existed, still works.
const DEFAULT_BRIEF =
  "你係一個廣東話（香港口語）旅遊助理，幫緊一個7人家庭（爸爸/媽媽/呀哥/姨姨/表妹/男友/我）10月23-28日去首爾。姨姨唔可以行樓梯，主題係賞紅葉銀杏。";
function briefOf(body: any): string {
  const b = (body?.brief ?? "").toString().trim().slice(0, 800);
  return b || DEFAULT_BRIEF;
}

const NOT_CONFIGURED_MSG =
  "🔧 AI功能未啟用：仲未設定 GEMINI_API_KEY。呢個功能需要喺 Supabase Edge Function 嘅 secret 度加返個Gemini API Key先可以用（Dashboard → Project Settings → Edge Functions → Secrets）。";
const PHOTO_NOT_CONFIGURED_MSG =
  "📷 相片功能未啟用：仲未設定 GOOGLE_PLACES_API_KEY。加返做Edge Function嘅secret先可以搵真實地點相片。";

// ---------- Supabase REST helpers (service role, server-side only) ----------
function sbAdminHeaders() {
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}
async function getCachedPhotos(query: string) {
  const url = Deno.env.get("SUPABASE_URL");
  const res = await fetch(`${url}/rest/v1/place_photo_cache?query=eq.${encodeURIComponent(query)}&select=photos,fetched_at`, {
    headers: sbAdminHeaders(),
  });
  if (!res.ok) return null;
  const rows = await res.json();
  const row = rows[0];
  if (!row) return null;
  const ageDays = (Date.now() - new Date(row.fetched_at).getTime()) / 86400000;
  if (ageDays > PHOTO_CACHE_MAX_AGE_DAYS) return null;
  return row.photos;
}
async function saveCachedPhotos(query: string, photos: string[]) {
  const url = Deno.env.get("SUPABASE_URL");
  await fetch(`${url}/rest/v1/place_photo_cache?on_conflict=query`, {
    method: "POST",
    headers: { ...sbAdminHeaders(), Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ query, photos, fetched_at: new Date().toISOString() }),
  });
}

async function fetchPhotosForPlaceId(placeId: string, apiKey: string): Promise<string[]> {
  const detailsUrl = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=photos&key=${apiKey}`;
  const detailsRes = await fetch(detailsUrl);
  const detailsData = await detailsRes.json();
  const photoRefs: string[] = (detailsData?.result?.photos ?? []).slice(0, 3).map((p: any) => p.photo_reference);

  const resolvedUrls: string[] = [];
  for (const ref of photoRefs) {
    const photoUrl = `https://maps.googleapis.com/maps/api/place/photo?maxwidth=640&photo_reference=${ref}&key=${apiKey}`;
    const photoRes = await fetch(photoUrl, { redirect: "follow" });
    if (photoRes.ok) resolvedUrls.push(photoRes.url); // final googleusercontent.com CDN URL, no key needed to view
    await photoRes.body?.cancel();
  }
  return resolvedUrls;
}

async function searchPlacePhotos(query: string, apiKey: string): Promise<string[]> {
  const findUrl = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${encodeURIComponent(query + " 서울")}&inputtype=textquery&fields=place_id&key=${apiKey}`;
  const findRes = await fetch(findUrl);
  const findData = await findRes.json();
  const placeId = findData?.candidates?.[0]?.place_id;
  if (!placeId) return [];
  return fetchPhotosForPlaceId(placeId, apiKey);
}

async function searchPlaces(query: string, apiKey: string) {
  const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query + " 서울")}&key=${apiKey}`;
  const res = await fetch(url);
  const data = await res.json();
  return (data?.results ?? []).slice(0, 5).map((r: any) => ({
    placeId: r.place_id,
    name: r.name,
    address: r.formatted_address || r.vicinity || "",
    lat: r.geometry?.location?.lat,
    lng: r.geometry?.location?.lng,
    // text search already carries these, so a rating costs no extra request
    rating: typeof r.rating === "number" ? r.rating : null,
    ratingCount: typeof r.user_ratings_total === "number" ? r.user_ratings_total : null,
  }));
}

// A "give me 5 more, different from before" request can't just rely on the
// prompt asking nicely — a narrow theme naturally has a small set of famous
// spots, so Gemini tends to reconverge on the same names even when told not
// to. This is the hard guarantee: normalize away spacing/punctuation/case and
// drop anything that matches (or is a substring of) something already saved.
function normPlaceName(s: string): string {
  return String(s || "").toLowerCase().replace(/[\s·・()（）\-–—,.，。]/g, "");
}
function isAlreadyOnList(title: string, kr: string, existingNorm: string[]): boolean {
  const a = normPlaceName(title), b = normPlaceName(kr);
  return existingNorm.some(e => {
    if (!e) return false;
    if (a && (e === a || (e.length >= 3 && a.length >= 3 && (e.includes(a) || a.includes(e))))) return true;
    if (b && (e === b || (e.length >= 3 && b.length >= 3 && (e.includes(b) || b.includes(e))))) return true;
    return false;
  });
}

// Look each AI-proposed name up on Google and keep only what actually exists
// with a real rating attached. This is what separates "high-rated" from
// "the model asserted it is high-rated" — the numbers come from Google, and
// anything Google can't find or hasn't rated simply drops out.
// Run the lookups concurrently. Done one-by-one these were the bulk of a
// 48-60s request (one already 502'd at 63s), which is the whole edge function
// budget spent waiting on independent calls that have no reason to be ordered.
async function verifyPlaces(cands: any[], apiKey: string, limit = 12) {
  const picked = cands.slice(0, limit).filter(c => String(c?.kr || c?.title || "").trim());
  const results = await Promise.all(picked.map(async (c) => {
    const q = String(c?.kr || c?.title || "").trim();
    try {
      const hits = await searchPlaces(q, apiKey);
      const top = hits[0];
      if (!top || typeof top.rating !== "number") return null;
      return {
        title: c.title || top.name,
        kr: c.kr || "",
        desc: c.desc || "",
        dayHint: c.dayHint || "",
        dayId: c.dayId ?? null,
        placeId: top.placeId,
        lat: top.lat,
        lng: top.lng,
        rating: top.rating,
        ratingCount: top.ratingCount ?? 0,
        // Google's API gives us none of this — it's always the model's own
        // impression, so it rides along unverified same as the rating is verified
        isFood: !!c.isFood,
        booking: c.booking || "unknown",
        bookingHow: c.bookingHow || "",
        queueNote: c.queueNote || "",
      };
    } catch (_) {
      return null;   // one bad lookup must not sink the whole list
    }
  }));
  return results.filter(Boolean) as any[];
}

// Rating for a place we already identified. Place Details is the accurate
// source once a place_id is known; fall back to a text search by name.
async function fetchRating(placeId: string, query: string, apiKey: string) {
  if (placeId) {
    const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(placeId)}` +
      `&fields=rating,user_ratings_total,name&language=zh-TW&key=${apiKey}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data?.status === "OK") {
      return {
        rating: typeof data.result?.rating === "number" ? data.result.rating : null,
        ratingCount: typeof data.result?.user_ratings_total === "number" ? data.result.user_ratings_total : null,
        placeId,
      };
    }
    if (data?.status !== "NOT_FOUND" && data?.status !== "ZERO_RESULTS") {
      return { problem: problemHint(data?.status || "UNKNOWN", data?.error_message) };
    }
  }
  if (!query) return { rating: null, ratingCount: null, placeId: "" };
  const hits = await searchPlaces(query, apiKey);
  const top = hits[0];
  if (!top) return { rating: null, ratingCount: null, placeId: "" };
  return { rating: top.rating, ratingCount: top.ratingCount, placeId: top.placeId };
}

// Opening hours for a place we already have a place_id for. Unlike the
// booking/queue impression the model gives, Google Places actually carries
// this as real structured data — so it rides along with the rating chip as
// something Google-verified, not a guess.
async function fetchOpeningHours(placeId: string, apiKey: string): Promise<string[] | null> {
  const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(placeId)}` +
    `&fields=opening_hours&language=zh-TW&key=${apiKey}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data?.status !== "OK") return null;
  const wd = data?.result?.opening_hours?.weekday_text;
  return Array.isArray(wd) && wd.length === 7 ? wd : null;
}

// Google returns one line per day ("星期一: 上午9:00 – 下午6:00"); most places
// repeat the same hours most days with one or two exceptions, so group
// identical lines together rather than showing all 7 — a stop card has no
// room for a 7-line schedule. If the week is too irregular to summarize
// cleanly, say so plainly rather than guessing at something shorter.
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

// One endpoint of a journey: a Google place id when we have one, otherwise
// coordinates, otherwise the place's name as free text.
function dmRef(p: any): string | null {
  if (!p) return null;
  if (p.placeId) return `place_id:${p.placeId}`;
  if (Number.isFinite(p.lat) && Number.isFinite(p.lng)) return `${p.lat},${p.lng}`;
  if (p.text) return p.text + " 서울";
  return null;
}

function problemHint(status: string, msg?: string): string {
  const full = `${status}${msg ? ": " + msg : ""}`;
  if (status === "REQUEST_DENIED") {
    return `Google 拒絕咗呢個請求（${full}）。通常係個 API key 冇批准用 Directions API：` +
           `去 Google Cloud Console → APIs & Services → Credentials → 揀返條 key → API restrictions，加埋「Directions API」，` +
           `同埋喺 Enabled APIs 度確認 Directions API 已經開咗。`;
  }
  if (status === "OVER_QUERY_LIMIT") return "Directions API 用量超咗限額，或者未開啟計費。";
  if (status === "ZERO_RESULTS") return "Google 搵唔到呢兩點之間嘅路線（可能太遠或者跨海）。";
  return full;
}

// Station and bus-stop names come back in Korean on purpose. Asking Google for
// zh-TW gave Simplified Chinese for Korean stops ("龙岩小学入口"), which is both
// wrong for the page and useless on the ground — the signs, the announcements
// and Kakao/Naver are all in Korean.
async function directions(o: string, d: string, mode: string, apiKey: string) {
  const url = `https://maps.googleapis.com/maps/api/directions/json` +
    `?origin=${encodeURIComponent(o)}&destination=${encodeURIComponent(d)}` +
    `&mode=${mode}&language=ko&region=kr&key=${apiKey}`;
  const res = await fetch(url);
  const data = await res.json();
  // Google reports failures in the body, not the HTTP status
  if (data?.status !== "OK") return { problem: problemHint(data?.status || "UNKNOWN", data?.error_message) };
  const leg = data?.routes?.[0]?.legs?.[0];
  if (!leg) return { problem: problemHint("ZERO_RESULTS") };
  return { seconds: leg.duration?.value ?? 0, steps: leg.steps ?? [] };
}

// Named lines Google returns in Korean, spelled the way a Cantonese reader
// expects. Numbered lines are handled by the pattern below instead.
const KO_LINES: Record<string, string> = {
  "경의중앙선": "京義中央線",
  "수인분당선": "水仁盆唐線",
  "분당선": "盆唐線",
  "신분당선": "新盆唐線",
  "경춘선": "京春線",
  "공항철도": "機場鐵路",
  "우이신설선": "牛耳新設線",
  "서해선": "西海線",
  "신림선": "新林線",
  "김포골드라인": "金浦金線",
};
function lineLabel(line: any): string {
  const t = line?.vehicle?.type;
  const short = (line?.short_name || "").trim();
  const name = (line?.name || "").trim();
  if (t === "SUBWAY" || t === "HEAVY_RAIL" || t === "COMMUTER_TRAIN"){
    for (const pick of [short, name]){
      if (!pick) continue;
      const num = pick.match(/^(\d+)\s*(호선|號線)?$/);   // "3" or "3호선"
      if (num) return `${num[1]}號線`;
      const known = KO_LINES[pick.replace(/\s/g, "")];
      if (known) return known;
    }
    return short || name || "地鐵";
  }
  if (t === "BUS") return short ? `${short}號巴士` : "巴士";
  return short || name || "";
}

// Turn Google's steps into "安國 ─3號線─ 忠武路 ─4號線─ 明洞"
function describeRide(steps: any[]) {
  const rides = steps.filter(s => s.travel_mode === "TRANSIT" && s.transit_details);
  if (!rides.length) return null;
  let chain = "";
  let sawSubway = false;
  rides.forEach((s, i) => {
    const td = s.transit_details;
    if (s.transit_details?.line?.vehicle?.type === "SUBWAY") sawSubway = true;
    const from = td.departure_stop?.name || "";
    const to = td.arrival_stop?.name || "";
    const label = lineLabel(td.line);
    const stops = td.num_stops ? `・${td.num_stops}站` : "";
    if (i === 0) chain += from;
    chain += ` ─${label}${stops}─ ${to}`;
  });
  return { chain, transfers: rides.length - 1, sawSubway };
}

async function transitBetween(from: any, to: any, apiKey: string) {
  const o = dmRef(from), d = dmRef(to);
  if (!o || !d) return { error: "呢兩個地點冇足夠資料（冇 Google 地點或座標）去計交通。" };

  const walk = await directions(o, d, "walking", apiKey);
  // under ~15 minutes on foot, walking is simply the better answer
  if (!("problem" in walk) && walk.seconds && walk.seconds <= 900) {
    return { mode: "walk", text: `步行約 ${Math.max(1, Math.round(walk.seconds / 60))} 分鐘` };
  }

  const tr = await directions(o, d, "transit", apiKey);
  if (!("problem" in tr) && tr.seconds) {
    const mins = Math.max(1, Math.round(tr.seconds / 60));
    const ride = describeRide(tr.steps);
    if (ride) {
      const kind = ride.sawSubway ? "地鐵" : "巴士";
      const xfer = ride.transfers > 0 ? `・轉${ride.transfers}次` : "";
      return { mode: ride.sawSubway ? "metro" : "bus", text: `${kind}約 ${mins} 分鐘${xfer}`, route: ride.chain };
    }
    return { mode: "metro", text: `大眾運輸約 ${mins} 分鐘` };
  }

  if (!("problem" in walk) && walk.seconds) {
    return { mode: "walk", text: `步行約 ${Math.max(1, Math.round(walk.seconds / 60))} 分鐘` };
  }
  return { error: (tr as any).problem || (walk as any).problem || "Google 冇俾到路線資料" };
}

// A snapshot is ~29 KB, most of it photo URLs, HTML blobs and map coordinates
// the planner has no use for. Slicing that to fit the prompt cut the trip off
// after Day 2 — which is why suggestions only ever touched the first day or two.
// Keep the planning facts, drop the rest, and the whole 6 days fits easily.
function compactItinerary(it: any) {
  const days = (it?.days ?? []).map((d: any) => ({
    dayId: d.id,
    date: d.date,
    title: d.title,
    stops: (d.items ?? []).filter((i: any) => i.kind === "stop").map((s: any) => {
      const o: any = { time: s.time, title: s.title, type: s.type };
      if (s.desc) o.desc = String(s.desc).slice(0, 140);
      const access = (s.accessBadges ?? []).map((b: any) => b?.text).filter(Boolean);
      if (access.length) o.已核實無障礙安排 = access;
      if ((s.niecepick ?? []).length) o.表妹指定要去 = true;
      return o;
    }),
  }));
  // A trip can change hotels partway through, and "which day is this on the way
  // for" only makes sense against the hotel you're at THAT night — passing just
  // the first one would quietly misjudge the back half of the trip.
  const stays = (Array.isArray(it?.stays) ? it.stays : [])
    .filter((s: any) => s?.name)
    .map((s: any) => ({ 住邊度: s.name, 由邊日: s.from ?? "", 住到邊日: s.to ?? "" }));
  return { 酒店: stays.length ? stays : (it?.accommodation?.name ?? ""), days };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const action = body?.action;
  const apiKey = Deno.env.get("GEMINI_API_KEY");

  try {
    if (action === "status") {
      return json({
        ok: true,
        geminiConfigured: !!apiKey,
        placesConfigured: !!Deno.env.get("GOOGLE_PLACES_API_KEY"),
        geminiNotice: apiKey ? null : NOT_CONFIGURED_MSG,
      });
    }

    if (action === "weather") {
      const brief = briefOf(body);
      const weather = await fetchWeather();
      let summary = "";
      if (weather.inForecastRange) {
        const lines = weather.daily.time.map((d: string, i: number) =>
          `${d}: ${weather.daily.temperature_2m_min[i]}–${weather.daily.temperature_2m_max[i]}°C，降雨機率${weather.daily.precipitation_probability_max[i]}%`
        );
        summary = "首爾未來預報（真實數據）：\n" + lines.join("\n");
      } else {
        summary = "而家距離出發日仲遠，Open-Meteo暫時未有呢幾日嘅短期預報（一般得16日內），下面沿用歷史同期平均值作參考，出發前一週請再check。";
      }
      if (apiKey) {
        try {
          const prompt = `${brief}\n\n根據以下天氣資料，用廣東話（香港口語）寫一段簡短（3-4句）嘅穿搭同行程提示俾佢哋參考：\n${summary}`;
          const aiText = await callGemini(apiKey, prompt);
          return json({ ok: true, raw: weather, summary, aiSummary: aiText });
        } catch (e) {
          return json({ ok: true, raw: weather, summary, aiSummary: null, aiNotice: friendlyGeminiError(e) });
        }
      }
      return json({ ok: true, raw: weather, summary, aiSummary: null, aiNotice: NOT_CONFIGURED_MSG });
    }

    if (action === "foliage") {
      const brief = briefOf(body);
      if (!apiKey) return json({ ok: false, message: NOT_CONFIGURED_MSG });
      const prompt = `${brief}\n\n請用廣東話（香港口語）簡短講吓佢哋今次去嗰陣賞紅葉銀杏嘅情況：\n1. 一般嚟講呢段時間銀杏／楓葉大約去到咩程度（用你所知嘅歷年規律推斷，唔使假裝有即時數據）\n2. 提醒用戶你冇即時上網能力，實際情況要去南怡島官網／Naver Blog／首爾市公園局網站做最後確認\n3. 語氣親切，300字以內`;
      try {
        const aiText = await callGemini(apiKey, prompt);
        return json({ ok: true, aiSummary: aiText });
      } catch (e) {
        return json({ ok: false, message: friendlyGeminiError(e) });
      }
    }

    if (action === "ask") {
      const brief = briefOf(body);
      if (!apiKey) return json({ ok: false, message: NOT_CONFIGURED_MSG });
      const itinerary = body?.itinerary;
      const question = (body?.question ?? "").toString().slice(0, 1000);
      const prompt = `${brief}\n\n你而家睇緊佢哋個行程JSON。\n\n用戶問：${question || "睇吓成個行程有冇邊度可以優化"}\n\n成6日行程（只供你參考現有內容，唔使全部覆述）：\n${JSON.stringify(compactItinerary(itinerary))?.slice(0, 20000)}\n\n請用廣東話回覆，回覆用純文字，唔使JSON。`;
      try {
        const aiText = await callGemini(apiKey, prompt);
        return json({ ok: true, aiSummary: aiText });
      } catch (e) {
        return json({ ok: false, message: friendlyGeminiError(e) });
      }
    }

    if (action === "suggest") {
      const brief = briefOf(body);
      if (!apiKey) return json({ ok: false, message: NOT_CONFIGURED_MSG });
      const itinerary = body?.itinerary;
      const question = (body?.question ?? "").toString().slice(0, 1000);
      const stopSchema = `{"type":"normal|eat|rest","time":"約 14:00","title":"景點名","kr":"韓文名或留空","desc":"描述","transitBefore":"例如 🚶步行約10分鐘 或 🚇地鐵約15分鐘（由上一個景點點樣去到呢度）","eatboxHtml":"必點推介HTML或留空","mapUrl":"https://map.naver.com/p/search/關鍵字或留空","accessBadges":[{"text":"🟢 描述","cls":"badge"}],"niecepick":[],"eatMeta":[],"tip":""}`;
      const prompt = `${brief}\n\n你而家幫佢哋調整呢個行程。加景點時請確保同嗰日其他景點順路（唔好搞到要走返回頭路）。\n\n**你見到嘅係成個6日行程，請當成個trip一齊睇。** 除非用戶指明咗邊一日，否則唔好淨係執一日 —— 你嘅建議應該掃過6日，起碼掂到兩日以上，並且睇下有冇跨日嘅問題（例如同一個地方去咗兩日、某一日塞到爆而另一日好空、連續幾日都食同一種嘢）。\n\n**飲食規則**：麵包店／咖啡店只算早餐或下午茶小食，唔算一餐。每一日嘅午餐同晚餐都要係正餐（韓式或其他熟食），唔可以用麵包、吐司、蛋糕頂數。如果某一日由早到晚都冇一餐正餐，嗰日就係有問題，要提議加一餐。\n\n**唔好隨便叫人刪景點。** 呢個行程係人手排過㗎：\n- 每個景點嘅「已核實無障礙安排」欄係實地核實過嘅安排（例如南山塔已經寫明「循環巴士無台階＋塔內電梯直達展望台」）。當佢係真，唔好當睇唔到，更加唔好講一啲同佢相反嘅嘢。\n- 標住「表妹指定要去」嘅地方係家人講明要去，一律唔准提議刪。\n- 地標級景點（例如南山塔、景福宮、南怡島）唔好因為「可能辛苦」「可能人多」就叫人拎走。\n- 只有真係有硬衝突先至用 remove：嗰日休館、時間夾唔到、同一個地方行程入面去咗兩次、或者要走大幅回頭路。其餘一律用 edit 改時間／改交通方式，或者根本唔使改。\n- 唔好作具體數字（幾多米、幾多度斜、要排幾耐隊）。你冇即時資料，講唔準就唔好講。\n\n**"time" 好緊要**：系統會按你俾嘅時間自動插入去嗰日行程嘅正確位置，所以個時間一定要合理——要夾得返上一個同下一個景點嘅時間（例如上午景點就唔好寫 20:00），亦都要留返足夠時間俾之前嗰個景點，格式用「約 HH:MM」。交通時間我哋會自己向 Google 查，你唔使準確計，transitBefore 隨便寫個大概就得。\n\n**matchTitle 要照抄行程入面個 title 全個字**（連括號同分店名），唔好縮寫。\n\n用戶要求：${question || "掃一次成6日行程，建議2-4個調整，唔好集中喺同一日"}\n\n現有行程（dayId對應每一日）：\n${JSON.stringify(compactItinerary(itinerary))?.slice(0, 20000)}\n\n請只回覆一個JSON物件（唔好有其他文字、唔好用markdown code fence），格式如下：\n{"notes":"一句廣東話簡介你嘅建議","changes":[{"dayId":"day3","op":"add","matchTitle":null,"stop":${stopSchema},"reason":"廣東話講點解"}]}\nop可以係 "add"（新增，stop填滿）、"remove"（移除，matchTitle係現有stop嘅title，stop留null）、"edit"（修改，matchTitle係現有title，stop係新內容）。如果冇建議就 changes 用空陣列。`;
      let aiText: string;
      try {
        aiText = await callGemini(apiKey, prompt, { json: true });
      } catch (e) {
        return json({ ok: false, message: friendlyGeminiError(e) });
      }
      const parsed = parseAiJson(aiText);
      if (parsed && Array.isArray(parsed.changes)) {
        return json({ ok: true, notes: parsed.notes ?? "", changes: parsed.changes });
      }
      // Never surface the raw (possibly truncated/malformed) JSON text as if
      // it were a normal AI reply — that reads as garbage to the user.
      return json({ ok: false, message: "🔧 AI 今次冇整到有效嘅建議格式，麻煩再試一次（通常第二次就得）。" });
    }

    // One button on the board page does everything: understand the theme, hand
    // back official links when the theme needs live/official data, and propose
    // places that then get verified against Google. This used to be two separate
    // actions behind two buttons, which meant two waits and two result panels
    // that overwrote each other.
    if (action === "board-ai") {
      const brief = briefOf(body);
      if (!apiKey) return json({ ok: false, message: NOT_CONFIGURED_MSG });
      const placesKey = Deno.env.get("GOOGLE_PLACES_API_KEY");
      if (!placesKey) return json({ ok: false, message: PHOTO_NOT_CONFIGURED_MSG });
      const itinerary = body?.itinerary;
      const theme = (body?.theme ?? "").toString().trim().slice(0, 120);
      if (!theme) return json({ ok: false, message: "清單未改名，唔知幫你搵咩題材。" });
      // most-recent-first: if the list has grown past the cap, a repeat of
      // something just added is far more likely than a repeat of the oldest
      // entry, so keep the tail (most recently added) when trimming
      const existing: string[] = Array.isArray(body?.existingTitles) ? body.existingTitles.slice(-60) : [];
      const existingNorm = existing.map(normPlaceName).filter(Boolean);
      const validDayIds = new Set((itinerary?.days ?? []).map((d: any) => d.id));
      const dayIdList = [...validDayIds].join(", ");

      const prompt = `${brief}\n\n用戶有個叫「${theme}」嘅心水清單。請做三樣嘢：\n\n**1) analysis（最重要）**：用2-4句廣東話講你點理解「${theme}」呢個題材，同埋針對佢哋呢個行程俾實際建議（例如擺喺邊一日最順路、有咩伏位、要唔要預約、姨姨行唔行到）。呢段會存低做紀錄一直留喺清單頂，所以要有實質內容，唔好求其。\n\n**2) resources**：如果呢個題材需要實時／官方資料先準（天氣、紅葉/銀杏情況、滙率、開放時間、車票預約），俾2-4個官方網站。你冇即時上網能力，唔好扮到自己知道最新情況，亦都唔好亂作URL，只可以喺下面呢堆揀：\n- 天氣：기상청 https://www.weather.go.kr 、Naver 날씨 https://weather.naver.com\n- 紅葉/銀杏：산림청 https://www.forest.go.kr 、南怡島官網 https://namisum.com\n- 滙率：Naver 환율 https://finance.naver.com/marketindex/\n- 火車車票：Korail https://www.letskorail.com\n- 旅遊官方：Visit Korea https://korean.visitkorea.or.kr 、Visit Seoul https://korean.visitseoul.net\n- 地圖：Naver Map https://map.naver.com 、Kakao Map https://map.kakao.com\n唔啱題材就俾空陣列，唔好夾硬列。\n\n**3) candidates**：俾 12 個同「${theme}」相關、你認為評分高兼多人評嘅地點。\n重要：**我哋收到之後會逐個攞去 Google Places 查真實評分同人數，查唔到或者分數唔夠嘅會自動篩走**，最後只留 5 個。所以：\n- 唔好自己作評分或者評價人數（一律以 Google 為準）\n- 「kr」欄一定要填準確韓文名，因為我哋用韓文名去搜\n- **如果下面「已有」個list好長，即係問過幾次，請特登諗第二層次、無咁出名但真係高分嘅選擇**\n- 如果呢個題材根本唔關地點事（例如只係問天氣），candidates 可以係空陣列\n\n**如果嗰個地方係食肆（餐廳／cafe／小食店）**，請額外填低：\n- 「isFood」：true\n- 「booking」："online"、"phone"、"walkin"、"unknown" 四選一\n- 「bookingHow」：一句講點樣訂位\n- 「queueNote」：大概要排幾耐。**你冇即時資料，唔肯定就寫「唔清楚，建議出發前確認」，唔好作實體幾多分鐘**\n唔係食肆就留空或者false。\n\n**一定唔可以**同下面「已有」重複（名稱好相似、明顯同一間舖都算）：${existing.length ? existing.join("、") : "（未有）"}\n\n每個地點都要對照返成個行程，講低邊一日順路。dayId 只可以用以下其中一個真實 id：${dayIdList || "（冇）"}；唔啱邊日就填 null，唔好靠估。dayHint 係俾人睇嘅文字。\n\n**要寫得短**：回覆太長會俾系統截斷，然後乜都顯示唔到。analysis 最多 4 句；每個地方嘅 desc 最多 25 字、dayHint 最多 20 字、bookingHow 同 queueNote 各最多 25 字。\n\n現有6日行程（參考用）：\n${JSON.stringify(compactItinerary(itinerary))?.slice(0, 14000)}\n\n請只回覆一個JSON物件（唔好有其他文字、唔好用markdown code fence）：\n{"analysis":"2-4句廣東話分析同建議","resources":[{"name":"網站名","url":"https://...","note":"可以查到咩"}],"candidates":[{"title":"地點名","kr":"準確韓文名","desc":"簡短描述","dayHint":"...","dayId":"dayX或null","isFood":true,"booking":"online","bookingHow":"...","queueNote":"..."}]}`;

      let aiText: string;
      try {
        aiText = await callGemini(apiKey, prompt, { json: true });
      } catch (e) {
        return json({ ok: false, message: friendlyGeminiError(e) });
      }
      const parsed = parseAiJson(aiText);
      // Never surface the raw (possibly truncated/malformed) JSON text as if
      // it were a normal AI reply — that reads as garbage to the user.
      if (!parsed) return json({ ok: false, message: "🔧 AI 今次冇整到有效嘅格式，麻煩再試一次（通常第二次就得）。" });

      const clampDay = (p: any) => ({ ...p, dayId: validDayIds.has(p?.dayId) ? p.dayId : null });
      const notDup = (p: any) => !isAlreadyOnList(p?.title, p?.kr, existingNorm);
      const cands = (Array.isArray(parsed.candidates) ? parsed.candidates : []).map(clampDay).filter(notDup);

      // verified against Google, then ranked by how many people actually rated
      const verified = await verifyPlaces(cands, placesKey, 12);
      const strong = verified.filter(v => v.rating >= 4.0 && v.ratingCount >= 200);
      const pool = strong.length >= 5 ? strong : verified.filter(v => v.rating >= 3.8);
      const topRated = pool.sort((a, b) => b.ratingCount - a.ratingCount).slice(0, 5);

      return json({
        ok: true,
        analysis: parsed.analysis ?? "",
        resources: Array.isArray(parsed.resources) ? parsed.resources.slice(0, 4) : [],
        topRated,
        checked: cands.length,
        verifiedCount: verified.length,
      });
    }

    if (action === "place-photo") {
      const placeId = (body?.placeId ?? "").toString().trim();
      const query = (body?.query ?? "").toString().trim();
      const cacheKey = placeId || query;
      if (!cacheKey) return json({ error: "Missing query or placeId" }, 400);

      const cached = await getCachedPhotos(cacheKey);
      if (cached) return json({ ok: true, photos: cached, cached: true });

      const placesKey = Deno.env.get("GOOGLE_PLACES_API_KEY");
      if (!placesKey) return json({ ok: false, message: PHOTO_NOT_CONFIGURED_MSG });

      try {
        const photos = placeId
          ? await fetchPhotosForPlaceId(placeId, placesKey)
          : await searchPlacePhotos(query, placesKey);
        if (photos.length) await saveCachedPhotos(cacheKey, photos);
        return json({ ok: true, photos, cached: false });
      } catch (e) {
        return json({ ok: false, message: "搵相片失敗：" + String(e) });
      }
    }

    if (action === "transit") {
      const placesKey = Deno.env.get("GOOGLE_PLACES_API_KEY");
      if (!placesKey) return json({ ok: false, message: PHOTO_NOT_CONFIGURED_MSG });
      try {
        const r = await transitBetween(body?.from, body?.to, placesKey);
        if (!r || (r as any).error) return json({ ok: false, message: (r as any)?.error || "計唔到呢兩點之間嘅交通。" });
        return json({ ok: true, mode: (r as any).mode, text: (r as any).text, route: (r as any).route || "" });
      } catch (e) {
        return json({ ok: false, message: "計交通失敗：" + String(e) });
      }
    }

    if (action === "place-rating") {
      const placesKey = Deno.env.get("GOOGLE_PLACES_API_KEY");
      if (!placesKey) return json({ ok: false, message: PHOTO_NOT_CONFIGURED_MSG });
      const placeId = (body?.placeId ?? "").toString().trim();
      const query = (body?.query ?? "").toString().trim();
      if (!placeId && !query) return json({ ok: false, message: "冇地點資料，攞唔到評分。" });
      try {
        const r = await fetchRating(placeId, query, placesKey);
        if ((r as any).problem) return json({ ok: false, message: (r as any).problem });
        return json({ ok: true, ...r });
      } catch (e) {
        return json({ ok: false, message: "攞評分失敗：" + String(e) });
      }
    }

    if (action === "place-hours") {
      const placesKey = Deno.env.get("GOOGLE_PLACES_API_KEY");
      if (!placesKey) return json({ ok: false, message: PHOTO_NOT_CONFIGURED_MSG });
      const placeId = (body?.placeId ?? "").toString().trim();
      if (!placeId) return json({ ok: false, message: "冇地點資料，攞唔到營業時間。" });
      try {
        const weekdayText = await fetchOpeningHours(placeId, placesKey);
        if (!weekdayText) return json({ ok: true, weekdayText: null, summary: "" });
        return json({ ok: true, weekdayText, summary: summarizeHours(weekdayText) });
      } catch (e) {
        return json({ ok: false, message: "攞營業時間失敗：" + String(e) });
      }
    }

    // One day at a time. `suggest` deliberately sweeps all six days, which is
    // the wrong shape when you are standing on Day 4 with an empty page and
    // want THAT day filled — and it kept proposing places already booked on
    // another day, because nothing told it to look sideways.
    if (action === "day-plan") {
      const brief = briefOf(body);
      if (!apiKey) return json({ ok: false, message: NOT_CONFIGURED_MSG });
      const itinerary = body?.itinerary;
      const dayId = (body?.dayId ?? "").toString().trim();
      const want = (body?.question ?? "").toString().slice(0, 1000);
      const day = (itinerary?.days ?? []).find((d: any) => d.id === dayId);
      if (!day) return json({ ok: false, message: "搵唔到呢一日。" });

      const stops = (day.items ?? []).filter((i: any) => i.kind === "stop");
      const isEmpty = stops.length === 0;
      // every place already spoken for on ANOTHER day — the single most useful
      // thing to hand the model, since repeats are the usual failure
      const elsewhere: string[] = [];
      (itinerary?.days ?? []).forEach((d: any) => {
        if (d.id === dayId) return;
        (d.items ?? []).forEach((i: any) => {
          if (i.kind === "stop" && i.title) elsewhere.push(`${d.id}:${i.title}`);
        });
      });
      // which hotel they sleep at that night, so "順路" means something
      const dayIdx = (itinerary?.days ?? []).findIndex((d: any) => d.id === dayId);
      const idxOf = (id: string) => (itinerary?.days ?? []).findIndex((d: any) => d.id === id);
      const stay = (Array.isArray(itinerary?.stays) ? itinerary.stays : []).find((s: any) => {
        const a = idxOf(s?.from), b = idxOf(s?.to);
        return a >= 0 && b >= 0 && dayIdx >= Math.min(a, b) && dayIdx <= Math.max(a, b);
      });

      const stopSchema = `{"type":"normal|eat|rest","time":"約 14:00","title":"景點名","kr":"韓文名或留空","desc":"描述","transitBefore":"例如 🚶步行約10分鐘","eatboxHtml":"","mapUrl":"https://map.naver.com/p/search/關鍵字或留空","accessBadges":[{"text":"🟢 描述","cls":"badge"}],"niecepick":[],"eatMeta":[],"tip":""}`;
      const prompt = `${brief}\n\n你而家淨係負責 **${day.title}（${day.date}，${dayId}）** 呢一日，唔好去改其他日。\n\n${
        isEmpty
          ? "呢一日而家係完全空白嘅，請由零幫佢哋砌一日出嚟：早餐、上午景點、午餐、下午景點、晚餐，大約 4-6 個站，時間由早到晚順住排。"
          : `呢一日已經有 ${stops.length} 個站，請睇清楚先，補返唔夠嘅嘢（例如冇正餐、上晝或者下晝太空、兩個站之間爭一個順路嘅點），唔好推翻佢哋已經排好嘅嘢。`
      }\n\n${stay?.name ? `佢哋嗰晚住「${stay.name}」，所以最後一個站唔好離酒店太遠。\n\n` : ""}**唔可以推介以下地方**——呢啲喺其他日子已經去緊，重複咗就白行一次：\n${elsewhere.length ? elsewhere.join("、") : "（其他日暫時未有）"}\n\n**飲食規則**：麵包店／咖啡店只算早餐或下午茶，唔算一餐。午餐同晚餐要係正餐。\n**無障礙**：姨姨行唔到樓梯呢類限制寫咗喺上面背景度，揀地方同寫 accessBadges 嗰陣要當真。\n**唔好作數字**（幾多米、幾多度斜、排幾耐隊）。唔肯定就寫「建議出發前確認」。\n**time 好緊要**：系統會照你俾嘅時間插入去嗰日正確位置，所以要順住已有嘅時間排，格式「約 HH:MM」。交通時間我哋會自己向 Google 查，transitBefore 求其寫個大概就得。\n\n用戶想點：${want || "（冇特別要求，你自己睇住辦）"}\n\n呢一日而家嘅內容：\n${JSON.stringify({ dayId, date: day.date, title: day.title, desc: day.desc, stops: stops.map((s: any) => ({ time: s.time, title: s.title, type: s.type })) }).slice(0, 6000)}\n\n其他日子概況（只係俾你避開重複同睇路線走向）：\n${JSON.stringify(compactItinerary(itinerary))?.slice(0, 10000)}\n\n請只回覆一個JSON物件（唔好有其他文字、唔好用markdown code fence）：\n{"notes":"1-2句廣東話講你點砌呢一日","changes":[{"dayId":"${dayId}","op":"add","matchTitle":null,"stop":${stopSchema},"reason":"廣東話講點解"}]}\nop 只可以用 "add"（新增）或者 "edit"（改現有嘅，matchTitle 照抄全個 title）。唔好用 "remove"。dayId 一律填 "${dayId}"。`;

      let aiText: string;
      try {
        aiText = await callGemini(apiKey, prompt, { json: true });
      } catch (e) {
        return json({ ok: false, message: friendlyGeminiError(e) });
      }
      const parsed = parseAiJson(aiText);
      if (!parsed || !Array.isArray(parsed.changes)) {
        return json({ ok: false, message: "🔧 AI 今次冇整到有效嘅建議格式，麻煩再試一次（通常第二次就得）。" });
      }
      // the model was told to stay on this day; enforce it rather than trust it
      const changes = parsed.changes
        .filter((c: any) => c?.op === "add" || c?.op === "edit")
        .map((c: any) => ({ ...c, dayId }));
      return json({ ok: true, notes: parsed.notes ?? "", changes });
    }

    // Free-form sections for the home page ("手信買咩好", "換錢攻略"…). The page
    // used to have a fixed set of panels baked into the markup, so anything the
    // family wanted to keep together that wasn't 天氣/穿搭 had nowhere to live.
    if (action === "make-section") {
      const brief = briefOf(body);
      if (!apiKey) return json({ ok: false, message: NOT_CONFIGURED_MSG });
      const topic = (body?.topic ?? "").toString().trim().slice(0, 200);
      if (!topic) return json({ ok: false, message: "未講低想開咩題目。" });
      const itinerary = body?.itinerary;
      const prompt = `${brief}\n\n幫佢哋喺行程主頁開一個新 section，題目係「${topic}」。\n\n寫成一份佢哋出發前／喺當地真係用得着嘅筆記：\n- 6 至 10 條重點，每條一行，唔好過 40 字，可以喺開頭用一個 emoji\n- 講得實在啲（買咩、去邊度買、幾錢上落、幾時做、要注意乜），唔好講廢話同客套說話\n- **唔好作數字或者價錢**如果你唔肯定；唔肯定就寫「出發前 check 返」\n- 如果呢個題目要實時／官方資料先準（天氣、紅葉情況、滙率、車票），喺 links 度俾 1-3 個官方網站，唔好亂作 URL\n- 全部用廣東話（香港口語）\n\n佢哋個行程概況（參考，唔使覆述）：\n${JSON.stringify(compactItinerary(itinerary))?.slice(0, 8000)}\n\n請只回覆一個JSON物件（唔好有其他文字、唔好用markdown code fence）：\n{"title":"section 標題（短，最多 10 字）","icon":"一個 emoji","sub":"一句副標題","lines":["重點一","重點二"],"links":[{"name":"網站名","url":"https://..."}]}`;
      let aiText: string;
      try {
        aiText = await callGemini(apiKey, prompt, { json: true });
      } catch (e) {
        return json({ ok: false, message: friendlyGeminiError(e) });
      }
      const parsed = parseAiJson(aiText);
      if (!parsed || !Array.isArray(parsed.lines)) {
        return json({ ok: false, message: "🔧 AI 今次冇整到有效嘅格式，麻煩再試一次（通常第二次就得）。" });
      }
      return json({
        ok: true,
        section: {
          title: (parsed.title ?? topic).toString().slice(0, 40),
          icon: (parsed.icon ?? "📌").toString().slice(0, 4),
          sub: (parsed.sub ?? "").toString().slice(0, 120),
          lines: parsed.lines.map((l: any) => String(l).slice(0, 200)).slice(0, 12),
          links: (Array.isArray(parsed.links) ? parsed.links : [])
            .filter((l: any) => /^https?:\/\//.test(l?.url ?? ""))
            .map((l: any) => ({ name: String(l.name ?? l.url).slice(0, 60), url: String(l.url).slice(0, 300) }))
            .slice(0, 3),
        },
      });
    }

    if (action === "place-search") {
      const query = (body?.query ?? "").toString().trim();
      if (!query) return json({ ok: true, places: [] });

      const placesKey = Deno.env.get("GOOGLE_PLACES_API_KEY");
      if (!placesKey) return json({ ok: false, message: PHOTO_NOT_CONFIGURED_MSG });

      try {
        const places = await searchPlaces(query, placesKey);
        return json({ ok: true, places });
      } catch (e) {
        return json({ ok: false, message: "搜尋地點失敗：" + String(e) });
      }
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
