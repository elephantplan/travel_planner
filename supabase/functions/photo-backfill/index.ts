// Supabase Edge Function: photo-backfill
//
// A one-off repair job, kept in the repo because it will be wanted again.
//
// Every picture in the Seoul trip was fetched while Google still handed out
// lh3.googleusercontent.com links, and those lapse after a few weeks. By
// September all 240 of them were dead. place-photo-store now copies the bytes
// into our own bucket so a link never expires again, but it only runs when
// somebody taps a button — this walks the whole itinerary and does it for
// every stop at once.
//
// It works in batches. An edge function has a wall-clock limit and 300-odd
// stops will not fit inside it, so each call takes a slice and returns the
// cursor to resume from. Progress is written out at the end of every batch,
// which means an interrupted run loses at most one batch and re-running is
// always safe: a stop that already has a stored picture is skipped, and
// place-photo-store serves anything already in the bucket without going near
// Google, so a retry costs nothing.
//
// POST { tripId?, cursor?, limit?, count? }
//   -> { done, cursor, scanned, attempted, updated, retired, failed, versionId }

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Five at a time keeps the batch inside the wall-clock limit without leaning
// on Google hard enough to get rate-limited.
const CONCURRENCY = 5;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// The service key on this project is an sb_secret_... value rather than a JWT,
// so it has to travel in apikey; an Authorization bearer alone is rejected.
function adminHeaders(key: string) {
  return { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

type Stop = Record<string, any>;

// Day stops and bookmark-board entries alike carry a photoUrl, and the family
// sees both, so both get repaired. Order must be stable for the cursor to mean
// anything between calls.
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

// A missing picture and a dead Google link both need the same treatment.
function needsPhoto(s: Stop): boolean {
  const u = String(s?.photoUrl ?? "");
  return !u || u.includes("lh3.googleusercontent.com");
}

function lookupKey(s: Stop): string {
  const id = plain(s?.placeId);
  return id ? "p:" + id : "q:" + (plain(s?.kr) || plain(s?.title)).toLowerCase();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, message: "POST only" }, 405);

  const base = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!base || !key) return json({ ok: false, message: "missing platform env" }, 500);

  let body: any = {};
  try { body = await req.json(); } catch { /* all fields optional */ }

  const tripId = Number(body?.tripId) || 1;
  const cursor = Math.max(0, Number(body?.cursor) || 0);
  const limit = Math.min(60, Math.max(1, Number(body?.limit) || 30));
  const count = Math.min(4, Math.max(1, Number(body?.count) || 1));

  // Always build on the newest version. The family may be editing while this
  // runs, and each batch writing from a stale copy would undo their work.
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
  const hint = plain(snapshot?.meta?.destinationLocal);

  // Collect this batch first, so repeated places cost one Google lookup
  // between them rather than one each.
  const picked: Stop[] = [];
  let i = cursor;
  for (; i < stops.length && picked.length < limit; i++) {
    if (needsPhoto(stops[i])) picked.push(stops[i]);
  }
  const nextCursor = i;

  const byKey = new Map<string, Stop[]>();
  for (const s of picked) {
    const k = lookupKey(s);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(s);
  }

  let updated = 0, retired = 0;
  const failed: Array<{ place: string; message: string }> = [];

  const groups = [...byKey.entries()];
  for (let g = 0; g < groups.length; g += CONCURRENCY) {
    await Promise.all(groups.slice(g, g + CONCURRENCY).map(async ([, group]) => {
      const s = group[0];
      const name = plain(s?.title) || plain(s?.kr) || "(冇名)";
      const reqBody: Record<string, unknown> = plain(s?.placeId)
        ? { placeId: plain(s.placeId) }
        : { query: plain(s?.kr) || plain(s?.title) };
      reqBody.locationHint = hint;
      reqBody.count = count;
      if (!reqBody.placeId && !reqBody.query) {
        failed.push({ place: name, message: "冇地點資料" });
        return;
      }

      let r: any;
      try {
        const res = await fetch(`${base}/functions/v1/place-photo-store`, {
          method: "POST",
          headers: adminHeaders(key),
          body: JSON.stringify(reqBody),
          signal: AbortSignal.timeout(45000),
        });
        r = await res.json();
      } catch (e) {
        failed.push({ place: name, message: String(e).slice(0, 120) });
        return;
      }

      if (r?.ok && r?.url) {
        // Only the chosen picture is stored on the stop. Any alternates are
        // already in the bucket, and the picker fetches them on demand, so
        // copying them into every snapshot would only inflate the history.
        for (const t of group) {
          t.photoUrl = r.url;
          delete t.noPhoto;
          updated++;
        }
        return;
      }
      // Only a genuine "this place has no pictures" is recorded. Anything else
      // is our problem or Google's, and marking it would hide the button for
      // a place that has perfectly good photos.
      if (r?.reason === "nophoto") {
        for (const t of group) {
          t.noPhoto = true;
          if (String(t.photoUrl ?? "").includes("lh3.googleusercontent.com")) t.photoUrl = "";
          retired++;
        }
        return;
      }
      for (const t of group) {
        if (String(t.photoUrl ?? "").includes("lh3.googleusercontent.com")) t.photoUrl = "";
      }
      failed.push({ place: name, message: String(r?.message ?? "unknown").slice(0, 160) });
    }));
  }

  let versionId: number | null = null;
  if (updated || retired || failed.length) {
    const ins = await fetch(`${base}/rest/v1/itinerary_versions`, {
      method: "POST",
      headers: { ...adminHeaders(key), Prefer: "return=representation" },
      body: JSON.stringify({
        trip_id: tripId,
        edited_by: "相片修復",
        // itinerary_versions.source is constrained to this fixed set; the run
        // is identified by edited_by and the summary instead.
        source: "manual",
        summary: `補返 ${updated} 個地點嘅相`,
        trivial: true,          // background upkeep, not somebody's edit
        snapshot,
      }),
    });
    if (!ins.ok) {
      return json({ ok: false, message: `write failed ${ins.status}: ${(await ins.text()).slice(0, 200)}` }, 500);
    }
    const back = await ins.json();
    versionId = back?.[0]?.id ?? null;
  }

  return json({
    ok: true,
    done: nextCursor >= stops.length,
    cursor: nextCursor,
    scanned: stops.length,
    attempted: picked.length,
    lookups: byKey.size,
    updated,
    retired,
    failed: failed.slice(0, 10),
    failedCount: failed.length,
    versionId,
  });
});
