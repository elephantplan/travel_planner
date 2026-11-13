// Supabase Edge Function: trip-push
//
// Web push for the trip app (an installed PWA on iPhone, or any browser).
// A phone that switches notifications on sends its push subscription here;
// when someone saves a change to the trip, the app asks this function to
// tell every OTHER phone on that trip. The signing key (VAPID) is made here
// on first use and kept in a table only this function can read, so no
// secret ever has to be pasted anywhere.
//
// POST { mode: "key" }                                   → { ok, key }
// POST { mode: "subscribe", trip_id, sub, device, editor } → { ok }
// POST { mode: "unsubscribe", endpoint }                 → { ok }
// POST { mode: "test", endpoint }                        → { ok, sent }
// POST { mode: "notify", trip_id, title, body, url, except } → { ok, sent }
import webpush from "npm:web-push@3.6.7";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const str = (s: unknown, n: number) => String(s ?? "").trim().slice(0, n);

const DB = (Deno.env.get("SUPABASE_URL") || "") + "/rest/v1/";
const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const db = (path: string, init: RequestInit = {}) => fetch(DB + path, {
  ...init, headers: { apikey: SR, Authorization: "Bearer " + SR, "Content-Type": "application/json", ...(init.headers || {}) },
});

let keys: { publicKey: string; privateKey: string } | null = null;
async function vapid() {
  if (keys) return keys;
  const r = await (await db("push_keys?id=eq.1&select=public_key,private_jwk")).json();
  if (Array.isArray(r) && r[0]) keys = { publicKey: r[0].public_key, privateKey: r[0].private_jwk.privateKey };
  else {
    const k = webpush.generateVAPIDKeys();
    const ins = await db("push_keys", { method: "POST", headers: { Prefer: "resolution=ignore-duplicates" },
      body: JSON.stringify({ id: 1, public_key: k.publicKey, private_jwk: { privateKey: k.privateKey } }) });
    if (!ins.ok) throw new Error("save key " + ins.status);
    // two first calls at once: whichever row landed is the one to use
    const again = await (await db("push_keys?id=eq.1&select=public_key,private_jwk")).json();
    keys = { publicKey: again[0].public_key, privateKey: again[0].private_jwk.privateKey };
  }
  webpush.setVapidDetails("mailto:trip-planner@example.invalid", keys.publicKey, keys.privateKey);
  return keys;
}

async function sendTo(subs: any[], payload: unknown) {
  await vapid();
  let sent = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(payload), { TTL: 60 * 60 * 24 });
      sent++;
    } catch (e: any) {
      // the phone turned notifications off or the app was removed
      if (e?.statusCode === 404 || e?.statusCode === 410)
        await db("push_subs?endpoint=eq." + encodeURIComponent(s.endpoint), { method: "DELETE" });
      else console.error("push", e?.statusCode, String(e?.body || e).slice(0, 200));
    }
  }));
  return sent;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, message: "POST only" }, 405);
  let body: any = {};
  try { body = await req.json(); } catch { return json({ ok: false, message: "bad json" }, 400); }
  try {
    if (body.mode === "key") return json({ ok: true, key: (await vapid()).publicKey });

    if (body.mode === "subscribe") {
      const trip = Number(body.trip_id), s = body.sub || {};
      const endpoint = str(s.endpoint, 1000), p256dh = str(s.keys?.p256dh, 200), auth = str(s.keys?.auth, 100);
      if (!trip || !/^https:\/\//.test(endpoint) || !p256dh || !auth) return json({ ok: false, message: "未有齊資料" }, 400);
      const r = await db("push_subs?on_conflict=endpoint", { method: "POST", headers: { Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({ trip_id: trip, endpoint, p256dh, auth, device: str(body.device, 80), editor: str(body.editor, 40) }) });
      return json({ ok: r.ok });
    }

    if (body.mode === "unsubscribe") {
      const endpoint = str(body.endpoint, 1000);
      if (endpoint) await db("push_subs?endpoint=eq." + encodeURIComponent(endpoint), { method: "DELETE" });
      return json({ ok: true });
    }

    if (body.mode === "test") {
      const endpoint = str(body.endpoint, 1000);
      const subs = await (await db("push_subs?endpoint=eq." + encodeURIComponent(endpoint) + "&select=endpoint,p256dh,auth")).json();
      if (!Array.isArray(subs) || !subs.length) return json({ ok: false, message: "呢部機未開通知" });
      const sent = await sendTo(subs, { title: "旅行 App 通知測試", body: "收到呢個，即係通知開好咗。有人改行程就會通知你。", url: str(body.url, 300) });
      return json({ ok: sent > 0, sent });
    }

    if (body.mode === "notify") {
      const trip = Number(body.trip_id);
      if (!trip) return json({ ok: false }, 400);
      const except = str(body.except, 1000);
      const subs = ((await (await db("push_subs?trip_id=eq." + trip + "&select=endpoint,p256dh,auth")).json()) || [])
        .filter((s: any) => s.endpoint !== except);
      if (!subs.length) return json({ ok: true, sent: 0 });
      const sent = await sendTo(subs, { title: str(body.title, 60) || "行程更新咗", body: str(body.body, 160), url: str(body.url, 300) });
      return json({ ok: true, sent });
    }
    return json({ ok: false, message: "unknown mode" }, 400);
  } catch (e) {
    return json({ ok: false, message: String(e).slice(0, 200) }, 500);
  }
});
