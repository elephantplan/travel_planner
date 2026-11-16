// Google login and share links, shared by index.html and trip.html.
//
// The session is Supabase Auth's (GoTrue), kept in localStorage and
// refreshed before it runs out, without the supabase-js library: the pages
// already talk to the REST API with plain fetch, so they only need the
// right Authorization header (TripAuth.headers()).
//
// A share link carries the trip's token (trip.html?trip=12&s=…). It is kept
// per trip on this device and sent as the x-share-token header on database
// requests only (the edge functions' CORS does not allow extra headers).
(function(){
  "use strict";
  const URL_ = "https://aczykqleoamxdekfsgqh.supabase.co";
  const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFjenlrcWxlb2FteGRla2ZzZ3FoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ4ODU0MjUsImV4cCI6MjEwMDQ2MTQyNX0.Iv8diOTpiKO0LzAUMcDXaP_3HBAP4PyYGNgosGtgjCA";
  const KEY = "trip_auth_v1", SHARES = "trip_shares_v1", SEEN = "trip_seen_v1";
  const get = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || "null") || d; } catch (_){ return d; } };
  const put = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (_){} };

  let session = get(KEY, null);
  let lastError = "";

  function userOf(u){
    const m = (u && u.user_metadata) || {};
    return u ? { id: u.id, email: u.email || "", name: m.full_name || m.name || (u.email || "").split("@")[0], avatar: m.avatar_url || m.picture || "" } : null;
  }
  function save(s){ session = s; put(KEY, s); }

  // back from Google: the tokens arrive in the address's #fragment
  function takeFromHash(){
    const h = location.hash.replace(/^#/, "");
    if (!/access_token=|error=/.test(h)) return null;
    const p = new URLSearchParams(h);
    history.replaceState(null, "", location.pathname + location.search);
    if (p.get("error")){ lastError = p.get("error_description") || p.get("error"); return null; }
    return { access_token: p.get("access_token"), refresh_token: p.get("refresh_token"),
      expires_at: Math.floor(Date.now() / 1000) + Number(p.get("expires_in") || 3600) };
  }
  async function fetchUser(tok){
    const r = await fetch(URL_ + "/auth/v1/user", { headers: { apikey: ANON, Authorization: "Bearer " + tok } });
    return r.ok ? r.json() : null;
  }
  async function refresh(){
    if (!session || !session.refresh_token) return false;
    try {
      const r = await fetch(URL_ + "/auth/v1/token?grant_type=refresh_token", { method: "POST",
        headers: { apikey: ANON, "Content-Type": "application/json" }, body: JSON.stringify({ refresh_token: session.refresh_token }) });
      if (!r.ok){ if (r.status === 400 || r.status === 401) save(null); return false; }
      const j = await r.json();
      save({ access_token: j.access_token, refresh_token: j.refresh_token, expires_at: j.expires_at || Math.floor(Date.now() / 1000) + (j.expires_in || 3600), user: userOf(j.user) || (session && session.user) });
      return true;
    } catch (_){ return false; }
  }
  const fresh = () => session && session.expires_at - Math.floor(Date.now() / 1000) > 90;

  const ready = (async () => {
    const back = takeFromHash();
    if (back && back.access_token){
      const u = await fetchUser(back.access_token).catch(() => null);
      save(Object.assign(back, { user: userOf(u) }));
    }
    if (session && !fresh()) await refresh();
    if (session) loadProfile();                     // not awaited: the cached one shows meanwhile
  })();
  // keep it fresh while the page is open, and when it comes back
  setInterval(() => { if (session && !fresh()) refresh(); }, 60000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && session && !fresh()) refresh(); });

  // database requests carry the share token of the trip being looked at
  let shareFor = null;
  const realFetch = window.fetch.bind(window);
  window.fetch = function(input, init){
    try {
      const url = typeof input === "string" ? input : input.url;
      const tok = shareFor && getShare(shareFor);
      if (tok && url.indexOf(URL_ + "/rest/v1/") === 0){
        init = Object.assign({}, init);
        const h = new Headers(init.headers || (typeof input !== "string" ? input.headers : undefined) || {});
        h.set("x-share-token", tok);
        init.headers = h;
      }
    } catch (_){}
    return realFetch(input, init);
  };
  function getShare(tripId){ return (get(SHARES, {}) || {})[String(tripId)] || ""; }
  function setShare(tripId, tok){ const m = get(SHARES, {}); if (tok) m[String(tripId)] = tok; else delete m[String(tripId)]; put(SHARES, m); }

  // The name and picture the person chose (else Google's). Kept on the
  // device so pages can show them at once; refreshed from the database.
  const PROFILE = "trip_profile_v1";
  let profile = get(PROFILE, null);
  function me(){
    const u = (session && session.user) || null;
    if (!u) return null;
    const p = profile && profile.user_id === u.id ? profile : null;
    return Object.assign({}, u, { name: (p && p.display_name) || u.name, avatar: (p && p.avatar) || u.avatar, custom: !!(p && (p.display_name || p.avatar)) });
  }
  async function loadProfile(){
    const u = session && session.user;
    if (!u) return null;
    try {
      const r = await realFetch(URL_ + "/rest/v1/trip_profiles?user_id=eq." + u.id + "&select=*", { headers: window.TripAuth.headers() });
      if (!r.ok) return null;                       // accounts not switched on yet
      const row = (await r.json())[0] || { user_id: u.id, display_name: "", avatar: "" };
      const changed = JSON.stringify(profile) !== JSON.stringify(row);
      profile = row; put(PROFILE, row);
      // a device that has not seen this account's name and picture yet
      if (changed) window.dispatchEvent(new Event("tripauth:profile"));
      return row;
    } catch (_){ return null; }
  }
  async function saveProfile(name, avatar){
    const u = session && session.user;
    if (!u) throw new Error("未登入");
    const row = { user_id: u.id, display_name: String(name || "").trim().slice(0, 40), avatar: avatar || "", updated_at: new Date().toISOString() };
    const r = await realFetch(URL_ + "/rest/v1/trip_profiles?on_conflict=user_id", { method: "POST",
      headers: Object.assign({ "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" }, window.TripAuth.headers()), body: JSON.stringify(row) });
    if (!r.ok) throw new Error("儲唔到 " + r.status);
    profile = row; put(PROFILE, row);
    return row;
  }
  // a chosen photo, cropped square and shrunk, as a data: URL small enough for a row
  function shrinkImage(file, size){
    return new Promise((res, rej) => {
      const img = new Image(), url = URL.createObjectURL(file);
      img.onload = () => {
        const n = size || 128, c = document.createElement("canvas"); c.width = c.height = n;
        const s = Math.min(img.width, img.height);
        c.getContext("2d").drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, n, n);
        URL.revokeObjectURL(url);
        res(c.toDataURL("image/jpeg", 0.8));
      };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error("讀唔到張相")); };
      img.src = url;
    });
  }

  window.TripAuth = {
    ready,
    loadProfile, saveProfile, shrinkImage,
    async isAdmin(){ if (!session) return false; try { return (await this.rpc("is_trip_admin", {})) === true; } catch (_){ return false; } },
    user: me,
    loggedIn: () => !!(session && session.access_token),
    error: () => lastError,
    headers(){
      return { apikey: ANON, Authorization: "Bearer " + (session && session.access_token ? session.access_token : ANON) };
    },
    signIn(){
      const back = location.origin + location.pathname + location.search;
      location.href = URL_ + "/auth/v1/authorize?provider=google&prompt=select_account&redirect_to=" + encodeURIComponent(back);
    },
    async signOut(){
      try { if (session) await realFetch(URL_ + "/auth/v1/logout", { method: "POST", headers: this.headers() }); } catch (_){}
      save(null); profile = null; put(PROFILE, null);
    },
    // the trip this page is about, so its share token rides along
    useTrip(tripId, tokFromLink){
      shareFor = tripId;
      if (tokFromLink) setShare(tripId, tokFromLink);
      const seen = get(SEEN, []); if (!seen.includes(String(tripId))){ seen.push(String(tripId)); put(SEEN, seen.slice(-200)); }
    },
    shareToken: getShare,
    seen: () => get(SEEN, []),
    async rpc(name, args){
      const r = await window.fetch(URL_ + "/rest/v1/rpc/" + name, { method: "POST",
        headers: Object.assign({ "Content-Type": "application/json" }, this.headers()), body: JSON.stringify(args || {}) });
      if (!r.ok) throw new Error(name + " " + r.status + " " + (await r.text()).slice(0, 160));
      return r.json();
    },
  };
})();
