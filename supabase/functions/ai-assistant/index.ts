// Supabase Edge Function: ai-assistant
// Proxies Gemini + Google Places calls so the browser never sees the API keys.
// Actions: 'status' | 'weather' | 'foliage' | 'suggest' | 'ask' | 'place-photo' | 'place-search' | 'transit'

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

async function searchPlaces(query: string, apiKey: string): Promise<{ placeId: string; name: string; address: string; lat?: number; lng?: number }[]> {
  const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query + " 서울")}&key=${apiKey}`;
  const res = await fetch(url);
  const data = await res.json();
  return (data?.results ?? []).slice(0, 5).map((r: any) => ({
    placeId: r.place_id,
    name: r.name,
    address: r.formatted_address || r.vicinity || "",
    lat: r.geometry?.location?.lat,
    lng: r.geometry?.location?.lng,
  }));
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

async function directions(o: string, d: string, mode: string, apiKey: string) {
  const url = `https://maps.googleapis.com/maps/api/directions/json` +
    `?origin=${encodeURIComponent(o)}&destination=${encodeURIComponent(d)}` +
    `&mode=${mode}&language=zh-TW&region=kr&key=${apiKey}`;
  const res = await fetch(url);
  const data = await res.json();
  // Google reports failures in the body, not the HTTP status
  if (data?.status !== "OK") return { problem: problemHint(data?.status || "UNKNOWN", data?.error_message) };
  const leg = data?.routes?.[0]?.legs?.[0];
  if (!leg) return { problem: problemHint("ZERO_RESULTS") };
  return { seconds: leg.duration?.value ?? 0, steps: leg.steps ?? [] };
}

function lineLabel(line: any): string {
  const t = line?.vehicle?.type;
  const short = (line?.short_name || "").trim();
  const name = (line?.name || "").trim();
  if (t === "SUBWAY" || t === "HEAVY_RAIL" || t === "COMMUTER_TRAIN"){
    if (/^\d+$/.test(short)) return `${short}號線`;
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
      const prompt = `你係一個廣東話（香港口語）旅遊助理，幫緊一個7人家庭（爸爸/媽媽/呀哥/姨姨/表妹/男友/我）睇緊佢哋10月23-28日嘅首爾行程JSON。姨姨唔可以行樓梯，主題係賞紅葉銀杏。\n\n用戶問：${question || "睇吓成個行程有冇邊度可以優化"}\n\n行程JSON（節錄，只供你參考現有內容，唔使全部覆述）：\n${JSON.stringify(itinerary)?.slice(0, 6000)}\n\n請用廣東話回覆，回覆用純文字，唔使JSON。`;
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
      const prompt = `你係一個廣東話（香港口語）旅遊助理，幫緊一個7人家庭（爸爸/媽媽/呀哥/姨姨/表妹/男友/我）調整佢哋10月23-28日嘅首爾行程。姨姨唔可以行樓梯，主題係賞紅葉銀杏。加景點時請確保同嗰日其他景點順路（唔好搞到要走返回頭路）。\n\n**"time" 好緊要**：系統會按你俾嘅時間自動插入去嗰日行程嘅正確位置，所以個時間一定要合理——要夾得返上一個同下一個景點嘅時間（例如上午景點就唔好寫 20:00），亦都要留返足夠時間俾之前嗰個景點，格式用「約 HH:MM」。交通時間我哋會自己向 Google 查，你唔使準確計，transitBefore 隨便寫個大概就得。\n\n用戶要求：${question || "檢視成個行程，建議1-3個增加或移除景點的調整"}\n\n現有行程JSON（dayId對應每一日）：\n${JSON.stringify(itinerary)?.slice(0, 8000)}\n\n請只回覆一個JSON物件（唔好有其他文字、唔好用markdown code fence），格式如下：\n{"notes":"一句廣東話簡介你嘅建議","changes":[{"dayId":"day3","op":"add","matchTitle":null,"stop":${stopSchema},"reason":"廣東話講點解"}]}\nop可以係 "add"（新增，stop填滿）、"remove"（移除，matchTitle係現有stop嘅title，stop留null）、"edit"（修改，matchTitle係現有title，stop係新內容）。如果冇建議就 changes 用空陣列。`;
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
