// Supabase Edge Function: place-geo-backfill
//
// Naver's directions URLs are built from coordinates, so a stop without a
// lat/lng gets no Naver route button — and because a leg needs BOTH ends, one
// missing coordinate silently kills the button on two legs. In the Seoul trip
// that was why 南怡島, 景福宮, 首爾林 and friends showed only a Google link:
// they carried a Google place id but never got coordinates stored alongside it.
//
// This fills them in, and deliberately does no guessing:
//
//   * a stop with a placeId is resolved through Place Details, which returns
//     that exact place's geometry — there is nothing to get wrong;
//   * rows that are not places at all ("自由漫遊／拍照時光", "飛返香港") are
//     left exactly as they are, because inventing a coordinate for them would
//     produce a route link that points somewhere the family is not going;
//   * "leaving the hotel" rows are the one exception, and even they are not
//     inferred here: the caller passes their exact titles in hotelRows, and
//     they take the coordinates of the trip's own accommodation entry.
//
// POST { tripId?, hotelRows?: string[] }
//   -> { ok, scanned, needed, fixedByPlaceId, fixedByHotel, skipped, failed }

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const CONCURRENCY = 5;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// This project's service key is an sb_secret_... value, not a JWT, so it has
// to travel in apikey — an Authorization bearer alone is rejected.
function adminHeaders(key: string) {
  return { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

type Stop = Record<string, any>;

function allStops(snap: any): Stop[] {
  const out: Stop[] = [];
  for (const d of snap?.days ?? []) {
    for (const it of d?.items ?? []) if (it?.kind === "stop") out.push(it);
  }
  for (const b of snap?.boards ?? []) {
    for (const it of b?.items ?? []) out.push(it);
  }
  return out;
}

function plain(v: unknown): string {
  return String(v ?? "").replace(/<[^>]*>/g, "").trim();
}

// The client tests coordinates with Number.isFinite, so a string "37.5" would
// pass here and still fail there. Match the client exactly.
function hasCoord(s: Stop): boolean {
  return Number.isFinite(s?.lat) && Number.isFinite(s?.lng);
}

// For a row that is a real destination but was never linked to a Google place
// ("前往仁川國際機場"), the caller supplies the search text explicitly. The
// coordinates still come from Google rather than from anyone's memory.
async function geometryOfQuery(query: string, hint: string, key: string) {
  const input = hint ? `${query} ${hint}` : query;
  const url = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json` +
    `?input=${encodeURIComponent(input)}&inputtype=textquery` +
    `&fields=geometry,place_id,name&key=${key}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const data = await res.json();
  const c = data?.candidates?.[0];
  const loc = c?.geometry?.location;
  return {
    lat: typeof loc?.lat === "number" ? loc.lat : null,
    lng: typeof loc?.lng === "number" ? loc.lng : null,
    placeId: String(c?.place_id ?? ""),
    matched: String(c?.name ?? ""),
    status: String(data?.status ?? `HTTP ${res.status}`),
    error: String(data?.error_message ?? ""),
  };
}

async function geometryOf(placeId: string, key: string) {
  const url = `https://maps.googleapis.com/maps/api/place/details/json` +
    `?place_id=${encodeURIComponent(placeId)}&fields=geometry&key=${key}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const data = await res.json();
  const loc = data?.result?.geometry?.location;
  return {
    lat: typeof loc?.lat === "number" ? loc.lat : null,
    lng: typeof loc?.lng === "number" ? loc.lng : null,
    status: String(data?.status ?? `HTTP ${res.status}`),
    error: String(data?.error_message ?? ""),
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, message: "POST only" }, 405);

  const base = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const placesKey = Deno.env.get("GOOGLE_PLACES_API_KEY") ?? "";
  if (!base || !key) return json({ ok: false, message: "missing platform env" }, 500);
  if (!placesKey) return json({ ok: false, message: "missing GOOGLE_PLACES_API_KEY" }, 500);

  let body: any = {};
  try { body = await req.json(); } catch { /* all fields optional */ }
  const tripId = Number(body?.tripId) || 1;
  const hotelRows: string[] = Array.isArray(body?.hotelRows)
    ? body.hotelRows.map((t: unknown) => plain(t)).filter(Boolean) : [];
  // [{ title, query }] — an exact row title paired with what to look up.
  const named: Array<{ title: string; query: string }> = Array.isArray(body?.named)
    ? body.named.map((n: any) => ({ title: plain(n?.title), query: plain(n?.query) }))
        .filter((n: any) => n.title && n.query)
    : [];

  const readRes = await fetch(
    `${base}/rest/v1/itinerary_versions?trip_id=eq.${tripId}&has_snapshot=is.true` +
    `&select=id,snapshot&order=created_at.desc&limit=1`,
    { headers: adminHeaders(key) },
  );
  if (!readRes.ok) {
    return json({ ok: false, message: `read failed ${readRes.status}: ${(await readRes.text()).slice(0, 200)}` }, 500);
  }
  const rows = await readRes.json();
  if (!rows?.length) return json({ ok: false, message: "no snapshot for this trip" }, 404);

  const snapshot = rows[0].snapshot;
  const stops = allStops(snapshot);
  const missing = stops.filter(s => !hasCoord(s));

  // The accommodation entry is the only place a "leaving the hotel" row can
  // honestly borrow a position from.
  const stay = (snapshot?.stays ?? []).find((st: any) => Number.isFinite(st?.lat) && Number.isFinite(st?.lng));

  let fixedByPlaceId = 0, fixedByHotel = 0;
  const skipped: string[] = [];
  const failed: Array<{ place: string; message: string }> = [];
  const touched: Array<{ place: string; how: string; lat: number; lng: number }> = [];

  // Hotel rows first — no network needed.
  for (const s of missing) {
    const title = plain(s?.title);
    if (!hotelRows.includes(title)) continue;
    if (!stay) { failed.push({ place: title, message: "行程冇住宿座標" }); continue; }
    s.lat = stay.lat; s.lng = stay.lng;
    fixedByHotel++;
    touched.push({ place: title, how: "hotel", lat: stay.lat, lng: stay.lng });
  }

  const viaGoogle = missing.filter(s => !hasCoord(s) && plain(s?.placeId));
  for (let g = 0; g < viaGoogle.length; g += CONCURRENCY) {
    await Promise.all(viaGoogle.slice(g, g + CONCURRENCY).map(async (s) => {
      const title = plain(s?.title) || plain(s?.kr) || "(冇名)";
      try {
        const geo = await geometryOf(plain(s.placeId), placesKey);
        if (geo.lat === null || geo.lng === null) {
          failed.push({ place: title, message: `${geo.status} ${geo.error}`.trim() });
          return;
        }
        s.lat = geo.lat; s.lng = geo.lng;
        fixedByPlaceId++;
        touched.push({ place: title, how: "placeId", lat: geo.lat, lng: geo.lng });
      } catch (e) {
        failed.push({ place: title, message: String(e).slice(0, 120) });
      }
    }));
  }

  let fixedByName = 0;
  for (const n of named) {
    const targets = missing.filter(s => !hasCoord(s) && plain(s?.title) === n.title);
    if (!targets.length) continue;
    try {
      const geo = await geometryOfQuery(n.query, plain(snapshot?.meta?.destinationLocal), placesKey);
      if (geo.lat === null || geo.lng === null) {
        failed.push({ place: n.title, message: `${geo.status} ${geo.error}`.trim() });
        continue;
      }
      for (const s of targets) {
        s.lat = geo.lat; s.lng = geo.lng;
        if (geo.placeId && !plain(s.placeId)) s.placeId = geo.placeId;
        fixedByName++;
        touched.push({ place: `${n.title} → ${geo.matched}`, how: "query", lat: geo.lat, lng: geo.lng });
      }
    } catch (e) {
      failed.push({ place: n.title, message: String(e).slice(0, 120) });
    }
  }

  for (const s of missing) {
    if (!hasCoord(s)) skipped.push(plain(s?.title) || plain(s?.kr) || "(冇名)");
  }

  let versionId: number | null = null;
  if (fixedByPlaceId || fixedByHotel || fixedByName) {
    const ins = await fetch(`${base}/rest/v1/itinerary_versions`, {
      method: "POST",
      headers: { ...adminHeaders(key), Prefer: "return=representation" },
      body: JSON.stringify({
        trip_id: tripId,
        edited_by: "座標修復",
        source: "manual",     // the column is constrained to a fixed set
        summary: `補返 ${fixedByPlaceId + fixedByHotel + fixedByName} 個地點嘅座標（Naver 路線用）`,
        trivial: true,
        snapshot,
      }),
    });
    if (!ins.ok) {
      return json({ ok: false, message: `write failed ${ins.status}: ${(await ins.text()).slice(0, 200)}` }, 500);
    }
    versionId = (await ins.json())?.[0]?.id ?? null;
  }

  return json({
    ok: true,
    scanned: stops.length,
    needed: missing.length,
    fixedByPlaceId,
    fixedByHotel,
    fixedByName,
    skipped,
    failed,
    touched,
    versionId,
  });
});
