// Supabase Edge Function: place-local-name
//
// A place found through the app's own search only ever got Google's English
// name ("Hongik University Station"), so it had no local name for Naver, the
// copy button, or a taxi driver. This asks Place Details for the name in the
// destination's own language. It is its own small function rather than one
// more action in ai-assistant so it can be deployed without re-uploading that
// 60 KB file.
//
// POST { placeId, destinationLocal }  →  { ok, name }
// Secret: GOOGLE_PLACES_API_KEY (shared with ai-assistant)

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// Same rule as ai-assistant: the language follows the destination's script.
function langOfHint(h: string): string {
  if (/[가-힯]/.test(h)) return "ko";
  if (/[぀-ヿ]/.test(h)) return "ja";
  return "";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, message: "POST only" }, 405);
  let body: any = {};
  try { body = await req.json(); } catch { return json({ ok: false, message: "bad json" }, 400); }

  const key = Deno.env.get("GOOGLE_PLACES_API_KEY");
  if (!key) return json({ ok: false, message: "GOOGLE_PLACES_API_KEY not set" });
  const placeId = String(body?.placeId ?? "").trim();
  // The client sends the language it wants, since 「首爾」 alone does not say
  // Korean; fall back to reading the hint.
  const lang = String(body?.lang ?? "").trim() || langOfHint(String(body?.destinationLocal ?? ""));
  if (!placeId || !/^(ko|ja)$/.test(lang)) return json({ ok: true, name: null });

  // Places API (New): the name only, in the local language
  try {
    const res = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}?languageCode=${lang}`,
      { headers: { "X-Goog-Api-Key": key, "X-Goog-FieldMask": "displayName" } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) console.error(`Places (New) ${res.status}: ${String(data?.error?.message || "").slice(0, 200)}`);
    return json({ ok: res.ok, name: data?.displayName?.text ?? null });
  } catch (e) {
    return json({ ok: false, message: String(e).slice(0, 200) });
  }
});
