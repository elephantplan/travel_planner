// Every hour, ask the trip-push function to send what is due: change
// notifications it held back so they could be merged (at most one every 30
// minutes per phone, or a 9pm summary), and from 9:00 Hong Kong time the
// countdown to the next trip for every phone that ticked 「每日倒數」. The
// function never sends the same thing twice, so a retry is harmless.
// The key below is the app's public (anon) key, the same one every page uses.
const URL = "https://aczykqleoamxdekfsgqh.supabase.co/functions/v1/trip-push";
const KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFjenlrcWxlb2FteGRla2ZzZ3FoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ4ODU0MjUsImV4cCI6MjEwMDQ2MTQyNX0.Iv8diOTpiKO0LzAUMcDXaP_3HBAP4PyYGNgosGtgjCA";

export default async () => {
  const res = await fetch(URL, {
    method: "POST",
    headers: { apikey: KEY, Authorization: "Bearer " + KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "tick" }),
  });
  const text = await res.text();
  console.log("tick", res.status, text.slice(0, 200));
  return new Response(text, { status: res.ok ? 200 : 502 });
};

export const config = { schedule: "5 * * * *" };
