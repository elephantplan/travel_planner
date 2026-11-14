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
// POST { mode: "prefs", endpoint, countdown?, freq? }    → { ok }
// POST { mode: "tick" }   (hourly, from the Netlify schedule) → { ok, … }
//   sends the merged change notifications that are due, and the 9am countdown
// POST { mode: "daily" }  the countdown on its own (kept for old schedules)
//
// Change notifications are never sent one per edit. Each phone collects them
// in push_subs.pending and is told at most once every 30 minutes ('batch'),
// or once a day at 9pm ('daily'), in one message that lists who changed what.
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
  // Apple refuses a signature whose contact is a made-up address (403
  // BadJwtToken), so it is the app's own site
  webpush.setVapidDetails(Deno.env.get("PUSH_CONTACT") || "https://timely-truffle-6514b7.netlify.app", keys.publicKey, keys.privateKey);
  return keys;
}

let lastError = "";
async function sendTo(subs: any[], payload: unknown) {
  await vapid();
  let sent = 0;
  lastError = "";
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(payload), { TTL: 60 * 60 * 24 });
      sent++;
    } catch (e: any) {
      // the phone turned notifications off or the app was removed
      if (e?.statusCode === 404 || e?.statusCode === 410)
        await db("push_subs?endpoint=eq." + encodeURIComponent(s.endpoint), { method: "DELETE" });
      else { lastError = `${e?.statusCode || ""} ${String(e?.body || e).slice(0, 120)}`.trim(); console.error("push", lastError); }
    }
  }));
  return sent;
}

const FREQS = ["batch", "daily"];
const GAP = 30 * 60e3;
// 'batch' phones hear straight away if the last message was over half an
// hour ago; otherwise the change waits for the hourly tick
const dueNow = (s: any) => s.freq !== "daily" && (!s.last_notified || Date.now() - Date.parse(s.last_notified) >= GAP);

// Everything a phone hasn't been told, as one message:
//   title 「Tiffany、Ivan 改咗大阪行程」  body 「加咗三嶋亭；改咗 Day 3 時間 等 5 項」
function digest(pending: any[]) {
  const who = [...new Set(pending.map((p) => p.who).filter(Boolean))];
  const items = [...new Set(pending.flatMap((p) => p.items || []))];
  const trip = pending[pending.length - 1]?.trip || "行程";
  const title = `${who.slice(0, 2).join("、") || "有人"}${who.length > 2 ? ` 等 ${who.length} 人` : ""} 改咗${trip}`;
  const body = items.length
    ? items.slice(0, 3).join("；") + (items.length > 3 ? ` 等 ${items.length} 項` : "")
    : "撳入去睇吓改咗咩";
  return { title: title.slice(0, 60), body: body.slice(0, 160), url: pending[pending.length - 1]?.url || "/" };
}
async function tell(s: any, pending: any[]) {
  if (!pending.length) return 0;
  const n = await sendTo([s], digest(pending));
  await db("push_subs?endpoint=eq." + encodeURIComponent(s.endpoint), { method: "PATCH",
    body: JSON.stringify({ pending: [], last_notified: new Date().toISOString() }) });
  return n;
}
// held-back changes whose wait is over; 'daily' ones only in the evening run
async function flushDue(evening: boolean) {
  const subs = await (await db("push_subs?select=endpoint,p256dh,auth,pending,last_notified,freq")).json();
  let n = 0;
  for (const s of Array.isArray(subs) ? subs : []) {
    if (!Array.isArray(s.pending) || !s.pending.length) continue;
    if (s.freq === "daily" ? evening : dueNow(s)) n += await tell(s, s.pending);
  }
  return n;
}

// Every morning: the nearest trip that starts within 20 days (or today),
// to every phone that ticked the countdown and has not had it today.
// Safe to call more than once a day.
async function countdown() {
  const hk = new Date(Date.now() + 8 * 3600e3), today = hk.toISOString().slice(0, 10);
  const until = new Date(hk.getTime() + 20 * 864e5).toISOString().slice(0, 10);
  const trips = await (await db(`trips?select=id,name,destination_local,date_start&date_start=gte.${today}&date_start=lte.${until}&order=date_start.asc&limit=1`)).json();
  const t = Array.isArray(trips) && trips[0];
  if (!t) return { sent: 0, note: "冇 20 日內出發嘅行程" };
  const subs = await (await db(`push_subs?countdown=eq.true&or=(last_countdown.is.null,last_countdown.lt.${today})&select=endpoint,p256dh,auth`)).json();
  if (!Array.isArray(subs) || !subs.length) return { sent: 0 };
  const n = Math.round((new Date(t.date_start + "T00:00:00Z").getTime() - new Date(today + "T00:00:00Z").getTime()) / 864e5);
  const where = str(t.destination_local, 20) || str(t.name, 30);
  const md = `${+t.date_start.slice(5, 7)}/${+t.date_start.slice(8, 10)}`;
  const sent = await sendTo(subs, {
    title: n === 0 ? `今日出發去${where}！` : `仲有 ${n} 日去${where}`,
    body: n === 0 ? `「${str(t.name, 40)}」今日開始，一路順風！` : n === 1 ? `聽日出發！「${str(t.name, 40)}」，記得執埋行李。` : `「${str(t.name, 40)}」${md} 出發。`,
    url: "/trip.html?trip=" + t.id,
  });
  // marked even if one phone failed, so the schedule never repeats itself
  await db(`push_subs?countdown=eq.true&or=(last_countdown.is.null,last_countdown.lt.${today})`, { method: "PATCH", body: JSON.stringify({ last_countdown: today }) });
  return { sent, trip: t.id, days: n };
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
        body: JSON.stringify({ trip_id: trip, endpoint, p256dh, auth, device: str(body.device, 80), editor: str(body.editor, 40),
          ...(typeof body.countdown === "boolean" ? { countdown: body.countdown } : {}),
          ...(FREQS.includes(body.freq) ? { freq: body.freq } : {}) }) });
      return json({ ok: r.ok });
    }

    if (body.mode === "prefs") {
      const endpoint = str(body.endpoint, 1000);
      if (!endpoint) return json({ ok: false }, 400);
      const patch: Record<string, unknown> = {};
      if (typeof body.countdown === "boolean") patch.countdown = body.countdown;
      if (FREQS.includes(body.freq)) patch.freq = body.freq;
      if (!Object.keys(patch).length) return json({ ok: false }, 400);
      const r = await db("push_subs?endpoint=eq." + encodeURIComponent(endpoint), { method: "PATCH", body: JSON.stringify(patch) });
      return json({ ok: r.ok });
    }

    // Hourly: held-back change notifications that are now due, then the
    // morning countdown (from 9am, once a day per phone).
    if (body.mode === "tick") {
      const hk = new Date(Date.now() + 8 * 3600e3);
      const flushed = await flushDue(hk.getUTCHours() === 21);
      const cd = hk.getUTCHours() >= 9 ? await countdown() : { sent: 0 };
      return json({ ok: true, flushed, countdown: cd });
    }

    if (body.mode === "daily") return json({ ok: true, ...(await countdown()) });

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
      return json({ ok: sent > 0, sent, message: sent ? "" : "發唔到：" + (lastError || "呢部機嘅通知登記過期咗，熄咗再開過") });
    }

    if (body.mode === "notify") {
      const trip = Number(body.trip_id);
      if (!trip) return json({ ok: false }, 400);
      const except = str(body.except, 1000);
      const subs = ((await (await db("push_subs?trip_id=eq." + trip + "&select=endpoint,p256dh,auth,pending,last_notified,freq")).json()) || [])
        .filter((s: any) => s.endpoint !== except);
      if (!subs.length) return json({ ok: true, sent: 0 });
      const entry = { who: str(body.editor, 30) || str(body.title, 60).replace(/\s*改咗.*$/, ""), trip: str(body.trip_name, 40),
        items: (Array.isArray(body.items) ? body.items : [str(body.body, 160)]).map((x: unknown) => str(x, 60)).filter(Boolean).slice(0, 8),
        url: str(body.url, 300), at: new Date().toISOString() };
      let sent = 0, held = 0;
      for (const s of subs) {
        const pending = [...(Array.isArray(s.pending) ? s.pending : []), entry].slice(-40);
        if (dueNow(s)) { sent += await tell(s, pending); }
        else { held++; await db("push_subs?endpoint=eq." + encodeURIComponent(s.endpoint), { method: "PATCH", body: JSON.stringify({ pending }) }); }
      }
      return json({ ok: true, sent, held });
    }
    return json({ ok: false, message: "unknown mode" }, 400);
  } catch (e) {
    return json({ ok: false, message: String(e).slice(0, 200) }, 500);
  }
});
