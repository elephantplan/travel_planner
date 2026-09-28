// Supabase Edge Function: fold-alts
//
// A one-off tidy-up, kept in the repo because the same thing will be wanted
// again next trip. The app can fold one stop under another by hand, but Day 2
// of the Seoul trip had FIVE restaurants between 13:00 and 13:45, and doing
// that on a phone is five trips through a picker.
//
// It decides nothing. The caller names the day, the exact title of the stop
// that stays, and the exact titles of the ones to fold under it — because
// which restaurant the family actually wants is not something a clock or a
// star rating can answer. Anything that does not match EXACTLY one stop in
// that day aborts the whole run rather than folding a guess.
//
// POST { tripId?, folds: [{ day, target, fold: [title, ...] }], dryRun? }

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// These belong to the row, not to the place. A backup for lunch happens
// whenever lunch happens, so the folded stop drops its own time and type.
const SLOT_KEYS = ["kind", "time", "type", "alts"];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// This project's service key is an sb_secret_... value, not a JWT, so it has
// to travel in apikey; an Authorization bearer alone is rejected.
function adminHeaders(key: string) {
  return { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

function plain(v: unknown): string {
  return String(v ?? "").replace(/<[^>]*>/g, "").trim();
}

type Item = Record<string, any>;
type Unit = { seg: Item | null; stop: Item | null; note?: Item };

// Mirrors the client exactly: a connector immediately before a stop describes
// the trip INTO that stop, so the two travel together as one unit.
function toUnits(items: Item[]): Unit[] {
  const units: Unit[] = [];
  for (let i = 0; i < items.length; i++) {
    if (items[i]?.kind === "connector" && items[i + 1] && items[i + 1].kind === "stop") {
      units.push({ seg: items[i], stop: items[i + 1] });
      i++;
    } else if (items[i]?.kind === "stop") {
      units.push({ seg: null, stop: items[i] });
    } else if (items[i]?.kind === "note") {
      units.push({ seg: null, stop: null, note: items[i] });
    } else {
      units.push({ seg: items[i], stop: null });
    }
  }
  return units;
}
function fromUnits(units: Unit[]): Item[] {
  const out: Item[] = [];
  for (const u of units) {
    if (u.seg) out.push(u.seg);
    if (u.note) out.push(u.note);
    if (u.stop) out.push(u.stop);
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, message: "POST only" }, 405);

  const base = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!base || !key) return json({ ok: false, message: "missing platform env" }, 500);

  let body: any = {};
  try { body = await req.json(); } catch { /* validated below */ }
  const tripId = Number(body?.tripId) || 1;
  const dryRun = body?.dryRun === true;
  const folds = Array.isArray(body?.folds) ? body.folds : [];
  if (!folds.length) return json({ ok: false, message: "nothing to fold" }, 400);

  const readRes = await fetch(
    `${base}/rest/v1/itinerary_versions?trip_id=eq.${tripId}&has_snapshot=is.true` +
    `&select=id,snapshot&order=created_at.desc&limit=1`,
    { headers: adminHeaders(key) },
  );
  if (!readRes.ok) {
    return json({ ok: false, message: `read failed ${readRes.status}` }, 500);
  }
  const rows = await readRes.json();
  if (!rows?.length) return json({ ok: false, message: "no snapshot" }, 404);

  const snapshot = rows[0].snapshot;
  const report: any[] = [];

  for (const f of folds) {
    const dayId = plain(f?.day);
    const day = (snapshot?.days ?? []).find((d: any) => d?.id === dayId);
    if (!day) return json({ ok: false, message: `no day "${dayId}"` }, 400);

    const units = toUnits(day.items ?? []);
    // Exactly one match or nothing happens — two stops sharing a title would
    // otherwise make this fold whichever one it met first.
    const findOne = (title: string) => {
      const hits: number[] = [];
      units.forEach((u, j) => { if (u.stop && plain(u.stop.title) === title) hits.push(j); });
      return hits;
    };

    const targetTitle = plain(f?.target);
    const tHits = findOne(targetTitle);
    if (tHits.length !== 1) {
      return json({ ok: false, message: `"${targetTitle}" matched ${tHits.length} stops in ${dayId}` }, 400);
    }
    const targetUi = tHits[0];
    const target = units[targetUi].stop!;

    const foldTitles: string[] = (Array.isArray(f?.fold) ? f.fold : []).map(plain).filter(Boolean);
    const foldIdx: number[] = [];
    for (const t of foldTitles) {
      const hits = findOne(t);
      if (hits.length !== 1) {
        return json({ ok: false, message: `"${t}" matched ${hits.length} stops in ${dayId}` }, 400);
      }
      if (hits[0] === targetUi) {
        return json({ ok: false, message: `"${t}" is the target itself in ${dayId}` }, 400);
      }
      foldIdx.push(hits[0]);
    }

    // Keep the itinerary's own order for the backups — the caller stated a
    // first choice, not a ranking for the rest.
    foldIdx.sort((a, b) => a - b);

    if (!Array.isArray(target.alts)) target.alts = [];
    for (const j of foldIdx) {
      const src = units[j].stop!;
      const place: Item = {};
      for (const k of Object.keys(src)) if (!SLOT_KEYS.includes(k)) place[k] = src[k];
      target.alts.push(place);
    }

    // The leg into whatever now follows each removed row describes a journey
    // from a stop that is no longer there. Mark it for re-checking rather than
    // leaving a confidently wrong duration on screen.
    for (const j of foldIdx) {
      const next = units[j + 1];
      if (next && next.seg && !foldIdx.includes(j + 1)) next.seg.stale = true;
    }

    for (const j of [...foldIdx].sort((a, b) => b - a)) units.splice(j, 1);
    day.items = fromUnits(units);

    report.push({
      day: dayId,
      kept: targetTitle,
      folded: foldTitles,
      backupsNow: target.alts.length,
      stopsLeftInDay: units.filter(u => u.stop).length,
    });
  }

  if (dryRun) return json({ ok: true, dryRun: true, report });

  const ins = await fetch(`${base}/rest/v1/itinerary_versions`, {
    method: "POST",
    headers: { ...adminHeaders(key), Prefer: "return=representation" },
    body: JSON.stringify({
      trip_id: tripId,
      edited_by: "整理後備",
      source: "manual",          // the column is constrained to a fixed set
      summary: report.map(r => `${r.day}：留低「${r.kept}」，摺埋 ${r.folded.length} 間做後備`).join("；"),
      trivial: false,            // a real change to the plan — it belongs in history
      snapshot,
    }),
  });
  if (!ins.ok) {
    return json({ ok: false, message: `write failed ${ins.status}: ${(await ins.text()).slice(0, 200)}` }, 500);
  }
  const versionId = (await ins.json())?.[0]?.id ?? null;
  return json({ ok: true, report, versionId });
});
