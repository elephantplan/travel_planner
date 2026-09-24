// Supabase Edge Function: place-photo-store
//
// Why this exists as its own function:
// Google's Places photo endpoint never gives you a durable image address. It
// answers with a redirect to a temporary lh3.googleusercontent.com URL, and
// those lapse after a few weeks — which is why every picture fetched for the
// Seoul trip in July had turned into a broken image by September.
//
// So: fetch the bytes ONCE, put them in our own storage bucket, and hand back
// a permanent public URL. The itinerary then stores a short link that never
// expires, instead of a link with a shelf life (or megabytes of base64, which
// would have to be copied into every version snapshot).
//
// Secrets used (already set on this project):
//   GOOGLE_PLACES_API_KEY
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   (injected by the platform)

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const BUCKET = "trip-photos";
const MAX_WIDTH = 800;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// A place id is already stable and unique; a free-text query gets a short
// deterministic hash so the same search always lands on the same object.
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
function objectName(placeId: string, query: string, hint: string, i: number): string {
  const stem = placeId
    ? `p_${placeId.replace(/[^A-Za-z0-9_-]/g, "")}`
    : `q_${hash((query + "|" + hint).toLowerCase())}`;
  return `${stem}_${i}.jpg`;
}
function publicUrl(base: string, name: string): string {
  return `${base}/storage/v1/object/public/${BUCKET}/${name}`;
}

// Google reports failures in the BODY, not the HTTP status, so a refused key
// and a place that genuinely has no pictures both arrive as 200 with an empty
// list. Carrying the status back is what stops "your key is switched off"
// from being reported to the family as "this place has no photos".
async function findPlaceId(query: string, hint: string, key: string) {
  const input = hint ? `${query} ${hint}` : query;
  const url = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json` +
    `?input=${encodeURIComponent(input)}&inputtype=textquery&fields=place_id&key=${key}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const data = await res.json();
  return {
    id: data?.candidates?.[0]?.place_id ?? "",
    status: String(data?.status ?? `HTTP ${res.status}`),
    error: String(data?.error_message ?? ""),
  };
}

async function photoReferences(placeId: string, key: string, want: number) {
  const url = `https://maps.googleapis.com/maps/api/place/details/json` +
    `?place_id=${encodeURIComponent(placeId)}&fields=photos&key=${key}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const data = await res.json();
  return {
    refs: (data?.result?.photos ?? [])
      .slice(0, want)
      .map((p: any) => p?.photo_reference)
      .filter(Boolean) as string[],
    status: String(data?.status ?? `HTTP ${res.status}`),
    error: String(data?.error_message ?? ""),
  };
}

// Pull one picture out of Google and put it in our bucket. Returns the
// permanent URL, or "" if Google had nothing for it.
async function storeOne(ref: string, name: string, base: string, serviceKey: string,
                        placesKey: string): Promise<string> {
  // This is the redirect whose destination expires — follow it now and keep
  // the bytes, rather than keeping the address.
  const photoRes = await fetch(
    `https://maps.googleapis.com/maps/api/place/photo?maxwidth=${MAX_WIDTH}` +
    `&photo_reference=${encodeURIComponent(ref)}&key=${placesKey}`,
    { redirect: "follow", signal: AbortSignal.timeout(20000) },
  );
  if (!photoRes.ok) {
    console.error(`photo fetch failed ${photoRes.status} for ${name}`);
    return "";
  }
  const bytes = new Uint8Array(await photoRes.arrayBuffer());
  if (!bytes.length) {
    console.error(`photo fetch returned 0 bytes for ${name}`);
    return "";
  }

  const up = await fetch(`${base}/storage/v1/object/${BUCKET}/${name}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": photoRes.headers.get("content-type") || "image/jpeg",
      "x-upsert": "true",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
    body: bytes,
    signal: AbortSignal.timeout(20000),
  });
  if (!up.ok) {
    console.error(`storage upload failed ${up.status}: ${(await up.text()).slice(0, 300)}`);
    return "";
  }
  return publicUrl(base, name);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, message: "POST only" }, 405);

  const base = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const placesKey = Deno.env.get("GOOGLE_PLACES_API_KEY") ?? "";
  if (!placesKey) return json({ ok: false, reason: "nokey", message: "📷 未設定 GOOGLE_PLACES_API_KEY。" });
  if (!base || !serviceKey) return json({ ok: false, reason: "nokey", message: "🔧 呢個 function 攞唔到 Supabase 嘅內部設定。" });

  let body: any;
  try { body = await req.json(); } catch { return json({ ok: false, message: "Invalid JSON body" }, 400); }

  const placeId = (body?.placeId ?? "").toString().trim();
  const query = (body?.query ?? "").toString().trim();
  const hint = (body?.locationHint ?? "").toString().trim();
  if (!placeId && !query) return json({ ok: false, message: "冇地點資料，搵唔到相。" });

  // One picture is all a stop card shows; the editor asks for a few so someone
  // replacing a photo has something to choose from.
  const want = Math.min(4, Math.max(1, Number(body?.count) || 1));

  try {
    // Whatever is already in the bucket is permanent and costs nothing to
    // reuse, so check before going anywhere near Google.
    const known: string[] = [];
    for (let i = 0; i < want; i++) {
      const u = publicUrl(base, objectName(placeId, query, hint, i));
      const have = await fetch(u, { method: "HEAD", signal: AbortSignal.timeout(10000) });
      if (have.ok) known.push(u); else break;
    }
    if (known.length >= want) return json({ ok: true, url: known[0], urls: known, cached: true });

    let id = placeId;
    if (!id) {
      const found = await findPlaceId(query, hint, placesKey);
      id = found.id;
      if (!id) {
        console.error(`findplace "${query}" -> ${found.status} ${found.error}`);
        return json({ ok: false, reason: "lookup", googleStatus: found.status,
          message: `Google 搵唔到呢個地點（${found.status}）。${found.error}` });
      }
    }

    const got = await photoReferences(id, placesKey, want);
    if (!got.refs.length) {
      console.error(`details ${id} -> ${got.status} ${got.error}`);
      // ZERO_RESULTS / OK with an empty list really does mean "no pictures";
      // anything else is Google refusing us, which is not the place's fault
      // and must not be recorded as "this stop has no photo".
      const noneExist = got.status === "OK" || got.status === "ZERO_RESULTS";
      return json({
        ok: false,
        reason: noneExist ? "nophoto" : "google",
        googleStatus: got.status,
        message: noneExist
          ? "Google 冇呢個地點嘅相。"
          : `Google 唔肯俾相（${got.status}）。${got.error}`,
      });
    }

    const urls: string[] = [];
    for (let i = 0; i < got.refs.length; i++) {
      const stored = await storeOne(got.refs[i], objectName(placeId, query, hint, i),
                                    base, serviceKey, placesKey);
      if (stored) urls.push(stored);
    }
    if (!urls.length) return json({ ok: false, reason: "store", message: "攞到相但係存唔到落嚟，等陣再試。" });

    return json({ ok: true, url: urls[0], urls, cached: false });
  } catch (e) {
    const timedOut = (e as Error)?.name === "TimeoutError" || (e as Error)?.name === "AbortError";
    console.error(`place-photo-store threw: ${String(e).slice(0, 300)}`);
    return json({
      ok: false,
      reason: "error",
      message: timedOut ? "攞相攞咗好耐都未覆，等陣再試。" : "攞相失敗：" + String(e).slice(0, 200),
    });
  }
});
