// A trip link pasted into WhatsApp, iMessage, Telegram, LINE… shows a card
// with the trip's name, its dates and its cover picture.
//
// Those chat apps send a robot to read the page's <meta property="og:…">
// tags, and the robot runs no JavaScript, so the tags have to be in the
// HTML as it leaves Netlify. This edge function puts them there, for those
// robots only — the family's own phones get the page untouched and
// without waiting on an extra lookup.
//
// The lookup goes through trip_preview(), which answers only with the
// link's own share token and only with the name, dates and cover.
import type { Context } from "https://edge.netlify.com";

const SUPABASE_URL = "https://aczykqleoamxdekfsgqh.supabase.co";
// the app's public (anon) key, the same one every page uses
const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFjenlrcWxlb2FteGRla2ZzZ3FoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ4ODU0MjUsImV4cCI6MjEwMDQ2MTQyNX0.Iv8diOTpiKO0LzAUMcDXaP_3HBAP4PyYGNgosGtgjCA";

// link-preview robots, by the name they give themselves
const PREVIEW_BOT = /WhatsApp|facebookexternalhit|Facebot|Twitterbot|TelegramBot|Slackbot|Discordbot|LinkedInBot|SkypeUriPreview|\bLine\/|LINE-|KAKAOTALK|kakaotalk-scrap|Viber|Signal|Pinterest|redditbot|Iframely|Embedly|vkShare|MicroMessenger|Googlebot|bingbot|Applebot/i;

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

// 「12月24日 – 1月2日・10 日」
function when(a?: string, b?: string): string {
  if (!a) return "";
  const d = (s: string) => { const [, m, day] = s.split("-").map(Number); return `${m}月${day}日`; };
  if (!b || b === a) return d(a);
  const days = Math.round((Date.parse(b) - Date.parse(a)) / 86400000) + 1;
  return `${d(a)} – ${d(b)}・${days} 日`;
}

export default async (req: Request, context: Context) => {
  const url = new URL(req.url);
  const tid = url.searchParams.get("trip") || "";
  const tok = url.searchParams.get("s") || "";
  if (!PREVIEW_BOT.test(req.headers.get("user-agent") || "") || !/^\d+$/.test(tid) || !tok) return;

  let info: any = null;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/trip_preview`, {
      method: "POST",
      headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, "Content-Type": "application/json" },
      body: JSON.stringify({ tid: Number(tid), tok }),
      signal: AbortSignal.timeout(3000),
    });
    if (r.ok) info = await r.json();
  } catch { /* no card beats no page */ }
  if (!info || !info.name) return;

  const res = await context.next();
  const html = await res.text();
  const title = String(info.name);
  const desc = [info.destination && !title.includes(info.destination) ? info.destination : "", when(info.date_start, info.date_end)]
    .filter(Boolean).join("・") || "一齊睇、一齊改嘅旅行行程";
  const image = /^https:\/\//.test(info.cover_url || "") ? info.cover_url : `${url.origin}/icons/icon-512-v2.png`;
  const tags = `<!--og-->
<meta property="og:type" content="website">
<meta property="og:site_name" content="DumboFly">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:url" content="${esc(url.href)}">
<meta name="twitter:card" content="${info.cover_url ? "summary_large_image" : "summary"}">
<title>${esc(title)}・DumboFly</title>
<!--/og-->`;
  const out = html.replace(/<!--og-->[\s\S]*?<!--\/og-->/, tags);
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  headers.set("cache-control", "public, max-age=0, must-revalidate");
  return new Response(out, { status: res.status, headers });
};

export const config = { path: "/trip.html" };
