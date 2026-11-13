// Every morning at 9:00 Hong Kong time (01:00 UTC), ask the trip-push
// function to send the countdown to the next trip to every phone that ticked
// 「每日倒數」. The function itself decides whether there is a trip within 20
// days and never sends the same phone two in one day, so a retry is harmless.
// The key below is the app's public (anon) key, the same one every page uses.
const URL = "https://aczykqleoamxdekfsgqh.supabase.co/functions/v1/trip-push";
const KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFjenlrcWxlb2FteGRla2ZzZ3FoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ4ODU0MjUsImV4cCI6MjEwMDQ2MTQyNX0.Iv8diOTpiKO0LzAUMcDXaP_3HBAP4PyYGNgosGtgjCA";

export default async () => {
  const res = await fetch(URL, {
    method: "POST",
    headers: { apikey: KEY, Authorization: "Bearer " + KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "daily" }),
  });
  const text = await res.text();
  console.log("countdown", res.status, text.slice(0, 200));
  return new Response(text, { status: res.ok ? 200 : 502 });
};

export const config = { schedule: "0 1 * * *" };
