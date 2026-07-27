// Supabase Edge Function: ai-assistant
// Proxies Gemini + Google Places calls so the browser never sees the API keys.
// Actions: 'status' | 'weather' | 'foliage' | 'suggest' | 'ask' | 'place-photo' | 'place-search' | 'place-rating' | 'transit' | 'board-ideas' | 'board-picks'

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

async function callGemini(apiKey: string, prompt: string): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini error ${res.status}: ${errText.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join("") ?? "";
  return text || "（AI冇回覆內容）";
}

function friendlyGeminiError(e: unknown): string {
  const msg = String(e);
  if (msg.includes("429")) {
    return "⏳ Gemini 免費額度暫時用晒（quota exceeded），一般幾分鐘至一日內會重置，請等陣再試。如果經常撞到，可能要去 Google AI Studio 檢查你個key嘅rate limit（ai.dev/rate-limit）。";
  }
  return "🔧 AI暫時無法回覆：" + msg.slice(0, 200);
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

// Look each AI-proposed name up on Google and keep only what actually exists
// with a real rating attached. This is what separates "high-rated" from
// "the model asserted it is high-rated" — the numbers come from Google, and
// anything Google can't find or hasn't rated simply drops out.
async function verifyPlaces(cands: any[], apiKey: string, limit = 12) {
  const out: any[] = [];
  for (const c of cands.slice(0, limit)) {
    const q = String(c?.kr || c?.title || "").trim();
    if (!q) continue;
    try {
      const hits = await searchPlaces(q, apiKey);
      const top = hits[0];
      if (!top || typeof top.rating !== "number") continue;
      out.push({
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
      });
    } catch (_) { /* one bad lookup must not sink the whole list */ }
  }
  return out;
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
  return { 酒店: it?.accommodation?.name ?? "", days };
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
          const prompt = `你係一個廣東話旅遊助理。根據以下首爾天氣資料，用廣東話（香港口語）寫一段簡短（3-4句）嘅穿搭同行程提示俾一家七口嘅家庭旅行團參考，包括姨姨（長者，唔可以行樓梯）：\n${summary}`;
          const aiText = await callGemini(apiKey, prompt);
          return json({ ok: true, raw: weather, summary, aiSummary: aiText });
        } catch (e) {
          return json({ ok: true, raw: weather, summary, aiSummary: null, aiNotice: friendlyGeminiError(e) });
        }
      }
      return json({ ok: true, raw: weather, summary, aiSummary: null, aiNotice: NOT_CONFIGURED_MSG });
    }

    if (action === "foliage") {
      if (!apiKey) return json({ ok: false, message: NOT_CONFIGURED_MSG });
      const prompt = `你係一個廣東話旅遊助理。用戶10月23-28日去首爾賞紅葉銀杏（包括南怡島、首爾林、曹溪寺）。請用廣東話（香港口語）簡短講吓：\n1. 一般嚟講呢段時間銀杏／楓葉大約去到咩程度（用你所知嘅歷年規律推斷，唔使假裝有即時數據）\n2. 提醒用戶你冇即時上網能力，實際情況要去南怡島官網／Naver Blog／首爾市公園局網站做最後確認\n3. 語氣親切，300字以內`;
      try {
        const aiText = await callGemini(apiKey, prompt);
        return json({ ok: true, aiSummary: aiText });
      } catch (e) {
        return json({ ok: false, message: friendlyGeminiError(e) });
      }
    }

    if (action === "ask") {
      if (!apiKey) return json({ ok: false, message: NOT_CONFIGURED_MSG });
      const itinerary = body?.itinerary;
      const question = (body?.question ?? "").toString().slice(0, 1000);
      const prompt = `你係一個廣東話（香港口語）旅遊助理，幫緊一個7人家庭（爸爸/媽媽/呀哥/姨姨/表妹/男友/我）睇緊佢哋10月23-28日嘅首爾行程JSON。姨姨唔可以行樓梯，主題係賞紅葉銀杏。\n\n用戶問：${question || "睇吓成個行程有冇邊度可以優化"}\n\n成6日行程（只供你參考現有內容，唔使全部覆述）：\n${JSON.stringify(compactItinerary(itinerary))?.slice(0, 20000)}\n\n請用廣東話回覆，回覆用純文字，唔使JSON。`;
      try {
        const aiText = await callGemini(apiKey, prompt);
        return json({ ok: true, aiSummary: aiText });
      } catch (e) {
        return json({ ok: false, message: friendlyGeminiError(e) });
      }
    }

    if (action === "suggest") {
      if (!apiKey) return json({ ok: false, message: NOT_CONFIGURED_MSG });
      const itinerary = body?.itinerary;
      const question = (body?.question ?? "").toString().slice(0, 1000);
      const stopSchema = `{"type":"normal|eat|rest","time":"約 14:00","title":"景點名","kr":"韓文名或留空","desc":"描述","transitBefore":"例如 🚶步行約10分鐘 或 🚇地鐵約15分鐘（由上一個景點點樣去到呢度）","eatboxHtml":"必點推介HTML或留空","mapUrl":"https://map.naver.com/p/search/關鍵字或留空","accessBadges":[{"text":"🟢 描述","cls":"badge"}],"niecepick":[],"eatMeta":[],"tip":""}`;
      const prompt = `你係一個廣東話（香港口語）旅遊助理，幫緊一個7人家庭（爸爸/媽媽/呀哥/姨姨/表妹/男友/我）調整佢哋10月23-28日嘅首爾行程。姨姨唔可以行樓梯，主題係賞紅葉銀杏。加景點時請確保同嗰日其他景點順路（唔好搞到要走返回頭路）。\n\n**你見到嘅係成個6日行程，請當成個trip一齊睇。** 除非用戶指明咗邊一日，否則唔好淨係執一日 —— 你嘅建議應該掃過6日，起碼掂到兩日以上，並且睇下有冇跨日嘅問題（例如同一個地方去咗兩日、某一日塞到爆而另一日好空、連續幾日都食同一種嘢）。\n\n**飲食規則**：麵包店／咖啡店只算早餐或下午茶小食，唔算一餐。每一日嘅午餐同晚餐都要係正餐（韓式或其他熟食），唔可以用麵包、吐司、蛋糕頂數。如果某一日由早到晚都冇一餐正餐，嗰日就係有問題，要提議加一餐。\n\n**唔好隨便叫人刪景點。** 呢個行程係人手排過㗎：\n- 每個景點嘅「已核實無障礙安排」欄係實地核實過嘅安排（例如南山塔已經寫明「循環巴士無台階＋塔內電梯直達展望台」）。當佢係真，唔好當睇唔到，更加唔好講一啲同佢相反嘅嘢。\n- 標住「表妹指定要去」嘅地方係家人講明要去，一律唔准提議刪。\n- 地標級景點（例如南山塔、景福宮、南怡島）唔好因為「可能辛苦」「可能人多」就叫人拎走。\n- 只有真係有硬衝突先至用 remove：嗰日休館、時間夾唔到、同一個地方行程入面去咗兩次、或者要走大幅回頭路。其餘一律用 edit 改時間／改交通方式，或者根本唔使改。\n- 唔好作具體數字（幾多米、幾多度斜、要排幾耐隊）。你冇即時資料，講唔準就唔好講。\n\n**"time" 好緊要**：系統會按你俾嘅時間自動插入去嗰日行程嘅正確位置，所以個時間一定要合理——要夾得返上一個同下一個景點嘅時間（例如上午景點就唔好寫 20:00），亦都要留返足夠時間俾之前嗰個景點，格式用「約 HH:MM」。交通時間我哋會自己向 Google 查，你唔使準確計，transitBefore 隨便寫個大概就得。\n\n**matchTitle 要照抄行程入面個 title 全個字**（連括號同分店名），唔好縮寫。\n\n用戶要求：${question || "掃一次成6日行程，建議2-4個調整，唔好集中喺同一日"}\n\n現有行程（dayId對應每一日）：\n${JSON.stringify(compactItinerary(itinerary))?.slice(0, 20000)}\n\n請只回覆一個JSON物件（唔好有其他文字、唔好用markdown code fence），格式如下：\n{"notes":"一句廣東話簡介你嘅建議","changes":[{"dayId":"day3","op":"add","matchTitle":null,"stop":${stopSchema},"reason":"廣東話講點解"}]}\nop可以係 "add"（新增，stop填滿）、"remove"（移除，matchTitle係現有stop嘅title，stop留null）、"edit"（修改，matchTitle係現有title，stop係新內容）。如果冇建議就 changes 用空陣列。`;
      let aiText: string;
      try {
        aiText = await callGemini(apiKey, prompt);
      } catch (e) {
        return json({ ok: false, message: friendlyGeminiError(e) });
      }
      let parsed: any = null;
      try {
        const cleaned = aiText.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
        parsed = JSON.parse(cleaned);
      } catch {
        parsed = null;
      }
      if (parsed && Array.isArray(parsed.changes)) {
        return json({ ok: true, notes: parsed.notes ?? "", changes: parsed.changes });
      }
      return json({ ok: true, aiSummary: aiText, changes: [] });
    }

    if (action === "board-ideas") {
      if (!apiKey) return json({ ok: false, message: NOT_CONFIGURED_MSG });
      const itinerary = body?.itinerary;
      const theme = (body?.theme ?? "").toString().trim().slice(0, 60);
      if (!theme) return json({ ok: false, message: "清單未改名，唔知幫你搵咩題材嘅資訊。" });
      const existing: string[] = Array.isArray(body?.existingTitles) ? body.existingTitles.slice(0, 30) : [];

      const validDayIds = new Set((itinerary?.days ?? []).map((d: any) => d.id));
      const dayIdList = [...validDayIds].join(", ");

      const prompt = `你係一個廣東話（香港口語）旅遊助理，幫緊一個7人家庭（爸爸/媽媽/呀哥/姨姨/表妹/男友/我）10月23-28日去首爾。姨姨唔可以行樓梯，主題係賞紅葉銀杏。\n\n用戶開咗一個叫「${theme}」嘅心水清單，想你根據呢個題材提供資訊。\n\n**先判斷呢個題材屬於邊一種：**\n\nA) **需要實時／官方資料先準嘅題材**（例如天氣、紅葉/銀杏情況、滙率、開放時間、車票預約）—— 你冇即時上網能力，唔好扮到自己知道最新情況。喺 resources 度俾2-4個「已知穩定」嘅官方或者常用網站，下面已經幫你列咗啲例子，揀啱題材嘅就用，唔啱就唔好亂作第啲URL：\n- 天氣：기상청 https://www.weather.go.kr 、Naver 날씨 https://weather.naver.com\n- 紅葉/銀杏：산림청（林務廳）https://www.forest.go.kr 、南怡島官網 https://namisum.com\n- 滙率：Naver 환율 https://finance.naver.com/marketindex/\n- 火車車票（南怡島/ITX）：Korail https://www.letskorail.com\n- 韓國旅遊官方：Visit Korea https://korean.visitkorea.or.kr 、Visit Seoul https://korean.visitseoul.net\n- 地圖／路線：Naver Map https://map.naver.com 、Kakao Map https://map.kakao.com\n只揀同「${theme}」相關嘅幾個，唔使全部列晒，唔啱題材就唔好列。\n\nB) **地點／推介類題材**（例如零食、手信、必去景點、咖啡店、美食）—— 喺 places 度俾8-10個具體建議（唔好同下面「已有」重複：${existing.length ? existing.join("、") : "（未有）"}）。每個建議都要對照返成個行程（見下面JSON），講低邊一日順路（例如靠近嗰日某個景點、唔使特登兜路），或者話明「冇特別順路日子，要特登去一次」。\n\n**dayId 好緊要**：如果嗰個建議真係啱擺入某一日（順路），dayId 要填返嗰日嘅真實 id，只可以用以下其中一個：${dayIdList || "（冇）"}。唔啱邊一日順路、或者要特登去一次嘅，dayId 填 null，唔好靠估亂填一個。dayHint 就係俾人睇嘅文字解釋（可以講埋dayId對應嗰日主題，例如「Day 3 南怡島程尾順路」），dayId 就係俾程式用嘅純ID。\n\n唔好作實體幾多蚊、幾多克呢啲你唔肯定嘅具體數字。\n\n兩種都可以同時出現（例如「必去景點」都可能想要多啲官方連結）。如果題材完全睇唔明係關於乜，intro 講返你嘅理解就得，resources／places 可以係空陣列。\n\n現有6日行程（參考用，唔使覆述）：\n${JSON.stringify(compactItinerary(itinerary))?.slice(0, 16000)}\n\n請只回覆一個JSON物件（唔好有其他文字、唔好用markdown code fence），格式：\n{"intro":"一句廣東話簡介你點理解呢個題材","resources":[{"name":"網站名","url":"https://...","note":"呢個網站可以查到咩"}],"places":[{"title":"地點名","kr":"韓文名或留空","desc":"簡短描述","dayHint":"俾人睇嘅文字，例如 Day 3 南怡島程尾順路，或者冇特別邊日順路就講明","dayId":"對應嘅day id或者null"}]}`;

      let aiText: string;
      try {
        aiText = await callGemini(apiKey, prompt);
      } catch (e) {
        return json({ ok: false, message: friendlyGeminiError(e) });
      }
      let parsed: any = null;
      try {
        const cleaned = aiText.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
        parsed = JSON.parse(cleaned);
      } catch {
        parsed = null;
      }
      if (parsed) {
        const places = (Array.isArray(parsed.places) ? parsed.places.slice(0, 12) : []).map((p: any) => ({
          ...p,
          // never trust a hallucinated day id — drop anything that isn't a real day in this trip
          dayId: validDayIds.has(p?.dayId) ? p.dayId : null,
        }));
        return json({
          ok: true,
          intro: parsed.intro ?? "",
          resources: Array.isArray(parsed.resources) ? parsed.resources.slice(0, 6) : [],
          places,
        });
      }
      return json({ ok: true, intro: aiText, resources: [], places: [] });
    }

    if (action === "board-picks") {
      if (!apiKey) return json({ ok: false, message: NOT_CONFIGURED_MSG });
      const placesKey = Deno.env.get("GOOGLE_PLACES_API_KEY");
      if (!placesKey) return json({ ok: false, message: PHOTO_NOT_CONFIGURED_MSG });
      const itinerary = body?.itinerary;
      const theme = (body?.theme ?? "").toString().trim().slice(0, 60);
      if (!theme) return json({ ok: false, message: "清單未改名，唔知幫你搵咩題材。" });
      const existing: string[] = Array.isArray(body?.existingTitles) ? body.existingTitles.slice(0, 30) : [];
      const validDayIds = new Set((itinerary?.days ?? []).map((d: any) => d.id));
      const dayIdList = [...validDayIds].join(", ");

      const prompt = `你係一個廣東話（香港口語）旅遊助理，幫緊一個7人家庭（爸爸/媽媽/呀哥/姨姨/表妹/男友/我）10月23-28日去首爾。姨姨唔可以行樓梯，主題係賞紅葉銀杏。\n\n用戶有個叫「${theme}」嘅清單，想要兩組唔同嘅推介。\n\n**第一組 candidates（Google 高分兼多人評）**：俾 12 個你認為評分高、評價人數多嘅候選。\n重要：**我哋收到之後會逐個攞去 Google Places 查真實評分同評價人數，查唔到、或者分數／人數唔夠嘅會自動篩走**，最後只會留低 5 個。所以\n- 唔好自己作評分或者評價人數（你寫幾多我哋都唔會用，一律以 Google 為準）\n- 寧願俾多幾個穩陣嘅、真係存在而且街知巷聞嘅老字號／人氣店，唔好俾啲查唔到嘅冷門名\n- 「kr」欄一定要填返準確嘅韓文店名，因為我哋係用韓文名去 Google 度搜\n\n**第二組 trending（社交平台近排紅）**：俾 5 個你印象中近排喺 Instagram／小紅書／Naver blog 紅嘅。\n重要：**你冇即時上網能力，呢一組我哋會明確標示做「AI 印象・未經核實」俾用戶睇**，所以\n- 唔好扮到自己知道呢一刻嘅熱度，唔好作「最近爆紅」「上個月開幕」呢啲你查唔到嘅講法\n- 淨係揀你訓練資料入面真係有印象嘅，如果諗唔到5個，寧願俾少啲\n- 「buzz」欄用一句講返點解你有印象佢紅（例如打卡位、某劇取景、排隊名物）\n\n兩組都唔好同下面「已有」重複：${existing.length ? existing.join("、") : "（未有）"}\n\n兩組每個都要對照返成個行程，講低邊一日順路。dayId 只可以用以下其中一個真實 id：${dayIdList || "（冇）"}；唔啱邊日順路就填 null，唔好靠估。dayHint 係俾人睇嘅文字。\n\n現有6日行程（參考用）：\n${JSON.stringify(compactItinerary(itinerary))?.slice(0, 14000)}\n\n請只回覆一個JSON物件（唔好有其他文字、唔好用markdown code fence）：\n{"intro":"一句廣東話簡介","candidates":[{"title":"地點名","kr":"準確韓文名","desc":"簡短描述","dayHint":"...","dayId":"dayX或null"}],"trending":[{"title":"地點名","kr":"韓文名","desc":"簡短描述","buzz":"點解你有印象佢紅","dayHint":"...","dayId":"dayX或null"}]}`;

      let aiText: string;
      try {
        aiText = await callGemini(apiKey, prompt);
      } catch (e) {
        return json({ ok: false, message: friendlyGeminiError(e) });
      }
      let parsed: any = null;
      try {
        const cleaned = aiText.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
        parsed = JSON.parse(cleaned);
      } catch { parsed = null; }
      if (!parsed) return json({ ok: true, intro: aiText, topRated: [], trending: [], checked: 0 });

      const clampDay = (p: any) => ({ ...p, dayId: validDayIds.has(p?.dayId) ? p.dayId : null });
      const cands = (Array.isArray(parsed.candidates) ? parsed.candidates : []).map(clampDay);

      // verified against Google, then ranked by how many people actually rated
      const verified = await verifyPlaces(cands, placesKey, 12);
      const strong = verified.filter(v => v.rating >= 4.0 && v.ratingCount >= 200);
      const pool = strong.length >= 5 ? strong : verified.filter(v => v.rating >= 3.8);
      const topRated = pool.sort((a, b) => b.ratingCount - a.ratingCount).slice(0, 5);

      const trending = (Array.isArray(parsed.trending) ? parsed.trending : []).slice(0, 5).map(clampDay);

      return json({
        ok: true,
        intro: parsed.intro ?? "",
        topRated,
        trending,
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
