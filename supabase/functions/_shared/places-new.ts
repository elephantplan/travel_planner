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
