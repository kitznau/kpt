/**
 * Cloudflare Worker: Kyiv Public Transit Live Departure Monitor (KPT Abfahrtsmonitor)
 * Version: 3.1.0
 *
 * DATA ENGINE: Official Kyiv City Open Data (Департамент транспортної інфраструктури КМДА)
 *
 * Sources
 *  1. GTFS Static (КП «Київпастранс»)  — schedule index (stops, routes, trips, stop_times)
 *  2. GTFS Realtime (АСКДУ)            — live vehicle positions (protobuf)
 *  3. Vehicle registry (open data)     — brand / model / low-floor by board number
 *  4. ІАС «Майно» stop registry        — metro, funicular, city express, street names
 *
 * Changelog 3.1.0 (fixes over 3.0)
 *  HANG FIXES
 *   - SSR is time-boxed (SSR_BUDGET_MS); on overrun a shell page is returned and the
 *     client loads /api/hub itself. /api/hub is time-boxed too (pending:true on overrun).
 *   - GTFS index uses stale-while-revalidate: bundled asset / memo / cache is served
 *     immediately, the remote rebuild runs in the background (single-flight + backoff).
 *   - Realtime: relays are raced in parallel under one budget (REALTIME_BUDGET_MS).
 *   - Every outbound fetch has a timeout; failures are negatively cached (no retry storms).
 *   - Client: AbortController + timeout, stale-response guard, visible error banner,
 *     auto refresh.
 *  DATA FIXES
 *   - calendar weekday flags (mon..sun) were indexed with JS getUTCDay (sun=0).
 *   - Service days -1/0/+1 are evaluated (after-midnight trips, times >= 24:00).
 *   - stop_sequence is honoured (destination + timeline order).
 *   - Live vehicle is matched by tripId (was: first vehicle of the route for every trip).
 *   - Distance is the real straight-line vehicle->stop distance, or "—" (was minutes*380 m).
 *   - GTFS-RT Position: speed is field 5 (field 4 is the double odometer).
 *   - Payload sanity checks (ZIP / protobuf magic) so relay HTML error pages are rejected.
 *  SECURITY
 *   - ADMIN_TOKEN is read from env (wrangler secret), not from source.
 *   - /api/debug-sources requires the admin token; it reads only the first chunk.
 *   - HTML escaping everywhere; JSON embedded in <script> is escaped; no stack traces in 500s.
 *
 * NOTE: the Workers Cache API is a no-op on *.workers.dev. The code therefore also keeps
 * per-isolate memos; on workers.dev the bundled assets/gtfs-index.json is the durable source
 * (rebuild it with build-index.mjs and redeploy).
 */

const VERSION = "3.1.0";

const CONFIG = {
  TIMEZONE: "Europe/Kyiv",
  DEFAULT_STOP: "Позняки",

  GTFS_STATIC_URL: "http://193.23.225.211:8002/export-gtfs-static",
  REALTIME_URL: "http://193.23.225.214:732/api/realtime",
  VEHICLES_URL:
    "https://data.kyivcity.gov.ua/dataset/vidomosti-pro-transportni-zasoby-iaki-obsluhovuiut-pasazhyrski-avtobusni-troleibusni-t-dep-transport/resource/efad1f37-779d-4d8e-9d1e-3a6b345775d6/data/download",
  MAYNO_STOPS_URL:
    "https://data.kyivcity.gov.ua/dataset/dani-pro-mistse-rozmishchennia-zupynok-miskoho-elektrychnoho-ta-avtomobilnoho-transpor-dep-transport/resource/269ffb2e-dac0-4978-9552-10d29a30724b/data/download",

  GTFS_INDEX_TTL_SEC: 6 * 3600,   // index older than this is refreshed in the background
  GTFS_MEMO_TTL_SEC: 30 * 60,     // how long an isolate trusts its parsed index before re-checking
  VEHICLES_TTL_SEC: 24 * 3600,
  MAYNO_TTL_SEC: 24 * 3600,
  REALTIME_TTL_SEC: 30,
  HUB_TTL_SEC: 60,
  NEGATIVE_TTL_SEC: 120,          // failed auxiliary loads are not retried for this long

  // Time budgets (ms) — nothing on the request path may exceed these.
  SSR_BUDGET_MS: 5000,
  API_HUB_BUDGET_MS: 15000,
  REALTIME_BUDGET_MS: 2500,
  AUX_BUDGET_MS: 1500,            // vehicle registry on the hub path
  SEARCH_AUX_BUDGET_MS: 2000,     // Mayno registry on the search path
  MAYNO_RESOLVE_BUDGET_MS: 3000,
  REGISTRY_FETCH_TIMEOUT_MS: 8000,
  GTFS_DIRECT_TIMEOUT_MS: 20000,
  GTFS_RELAY_TIMEOUT_MS: 30000,
  GTFS_BLOCKING_BUILD_BUDGET_MS: 25000, // only when no usable index exists at all
  GTFS_BUILD_BACKOFF_MS: 5 * 60 * 1000,
  PROBE_TIMEOUT_MS: 15000,

  NEARBY_STOP_RADIUS_M: 250,
  DEPARTURE_WINDOW_SEC: 2 * 3600 + 1800,
  MAX_DEPARTURES_PER_CARD: 10,
  TIMELINE_STOPS_LIMIT: 8,
  PAGE_REFRESH_SEC: 30,

  USER_AGENT: "KPT-Departure-Monitor/3.1 (Kyiv City Open Data Engine)",

  // The municipal feeds (193.23.225.x) answer 403 to cloud-provider IPs.
  // Public relays are used only as fallback paths (same official URLs, relayed).
  RELAY_URLS: [
    "https://api.allorigins.win/raw?url=",
    "https://api.codetabs.com/v1/proxy?quest="
  ],
  BROWSER_UA: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  PORTAL_REFERER: "https://data.kyivcity.gov.ua/"
};

/* ============================================================
 * GENERIC ASYNC HELPERS
 * ============================================================ */

/** Keeps a promise alive after the response was sent (no-op without ctx). */
function waitUntil(ctx, promise) {
  try {
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(Promise.resolve(promise).catch(() => {}));
  } catch { /* ignore */ }
  return promise;
}

/** Resolves with `fallback` when the promise rejects or takes longer than `ms`. */
function withDeadline(promise, ms, fallback) {
  let timer;
  const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(fallback), ms); });
  const guarded = Promise.resolve(promise).catch(err => {
    console.error("withDeadline: operation failed:", (err && err.message) || err);
    return fallback;
  });
  return Promise.race([guarded, timeout]).finally(() => clearTimeout(timer));
}

const isZip = b => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b;            // "PK"
const looksLikeFeed = b => b.length > 2 && (b[0] === 0x0a || b[0] === 0x12);   // FeedMessage.header / .entity

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ============================================================
 * FETCH VARIANTS (direct vs browser-UA vs relay)
 * ============================================================ */

const FETCH_VARIANTS = [
  { id: "direct", timeoutMs: CONFIG.GTFS_DIRECT_TIMEOUT_MS, make: url => ({ url, headers: { "User-Agent": CONFIG.USER_AGENT } }) },
  { id: "browser-ua", timeoutMs: CONFIG.GTFS_DIRECT_TIMEOUT_MS, make: url => ({ url, headers: { "User-Agent": CONFIG.BROWSER_UA } }) },
  { id: "browser-ua+referer", timeoutMs: CONFIG.GTFS_DIRECT_TIMEOUT_MS, make: url => ({ url, headers: { "User-Agent": CONFIG.BROWSER_UA, "Referer": CONFIG.PORTAL_REFERER } }) },
  ...CONFIG.RELAY_URLS.map((relay, i) => ({
    id: "relay" + (i + 1),
    timeoutMs: CONFIG.GTFS_RELAY_TIMEOUT_MS,
    make: url => ({ url: relay + encodeURIComponent(url), headers: { "User-Agent": CONFIG.USER_AGENT } })
  }))
];

const GTFS_FETCH_VARIANTS = FETCH_VARIANTS.filter(v => v.id === "direct" || v.id.startsWith("relay"));
const REALTIME_FETCH_VARIANTS = GTFS_FETCH_VARIANTS;

/** Sequential download (large GTFS ZIP): first variant that returns a valid payload wins. */
async function fetchBytesSequential(url, variants, minBytes, validate) {
  for (const v of variants) {
    try {
      const opts = v.make(url);
      const res = await fetch(opts.url, { headers: opts.headers, signal: AbortSignal.timeout(v.timeoutMs || 30000) });
      if (!res.ok) { console.error("fetch variant", v.id, "HTTP", res.status); continue; }
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length < minBytes) { console.error("fetch variant", v.id, "too small:", buf.length); continue; }
      if (validate && !validate(buf)) { console.error("fetch variant", v.id, "payload failed validation"); continue; }
      return { buf, variantId: v.id };
    } catch (err) {
      console.error("fetch variant", v.id, "failed:", (err && err.message) || err);
    }
  }
  return null;
}

/** Parallel race (small, latency-sensitive payloads): first valid payload wins, rest are aborted. */
async function fetchBytesRace(url, variants, minBytes, validate, budgetMs) {
  const controllers = [];
  const attempts = variants.map(async v => {
    const ctrl = new AbortController();
    controllers.push(ctrl);
    const timer = setTimeout(() => ctrl.abort(), budgetMs);
    try {
      const opts = v.make(url);
      const res = await fetch(opts.url, { headers: opts.headers, signal: ctrl.signal });
      if (!res.ok) throw new Error(v.id + " HTTP " + res.status);
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length < minBytes || (validate && !validate(buf))) throw new Error(v.id + " invalid payload (" + buf.length + " B)");
      return { buf, variantId: v.id };
    } finally {
      clearTimeout(timer);
    }
  });
  try {
    return await Promise.any(attempts);
  } catch (err) {
    const reasons = err && err.errors ? err.errors.map(e => (e && e.message) || String(e)).join("; ") : String(err);
    console.error("fetchBytesRace: all variants failed:", reasons);
    return null;
  } finally {
    controllers.forEach(c => { try { c.abort(); } catch { /* ignore */ } });
  }
}

async function fetchJsonWithTimeout(url, timeoutMs, label) {
  const res = await fetch(url, { headers: { "User-Agent": CONFIG.USER_AGENT }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(label + " download failed: HTTP " + res.status);
  return res.json();
}

/* ============================================================
 * SOURCE PROBE — /api/debug-sources (admin only)
 * ============================================================ */

async function probeVariant(url, variant) {
  const started = Date.now();
  try {
    const opts = variant.make(url);
    const res = await fetch(opts.url, { headers: opts.headers, signal: AbortSignal.timeout(CONFIG.PROBE_TIMEOUT_MS) });
    let firstChunkBytes = 0;
    try {
      if (res.body) {
        const reader = res.body.getReader();
        const chunk = await reader.read();
        firstChunkBytes = chunk.value ? chunk.value.length : 0;
        await reader.cancel();
      }
    } catch { /* ignore */ }
    return {
      variant: variant.id,
      status: res.status,
      contentType: res.headers.get("content-type") || "",
      contentLength: res.headers.get("content-length") || "",
      firstChunkBytes,
      ms: Date.now() - started
    };
  } catch (err) {
    return { variant: variant.id, status: 0, error: (err && err.message) || String(err), ms: Date.now() - started };
  }
}

async function probeSources() {
  const sources = [
    { name: "gtfs-static", url: CONFIG.GTFS_STATIC_URL },
    { name: "realtime", url: CONFIG.REALTIME_URL },
    { name: "mayno-stops", url: CONFIG.MAYNO_STOPS_URL },
    { name: "vehicles", url: CONFIG.VEHICLES_URL }
  ];
  const results = {};
  await Promise.all(sources.map(async s => {
    results[s.name] = await Promise.all(FETCH_VARIANTS.map(v => probeVariant(s.url, v)));
  }));
  return { probedAt: new Date().toISOString(), version: VERSION, results };
}

/* ============================================================
 * TIME HELPERS (Europe/Kyiv — computed arithmetically)
 * workerd's ICU may not resolve "Europe/Kyiv" and silently fall back to UTC,
 * so EET (UTC+2) / EEST (UTC+3) is computed manually.
 * ============================================================ */

/** Last Sunday of a month (monthIdx 0-based) as a UTC Date at 00:00 UTC. */
function lastSundayOf(y, monthIdx) {
  const last = new Date(Date.UTC(y, monthIdx + 1, 0));
  return new Date(Date.UTC(y, monthIdx + 1, 0 - last.getUTCDay()));
}

/** Kyiv offset vs UTC in seconds: EEST from last Sun of Mar 01:00 UTC to last Sun of Oct 01:00 UTC. */
function getKyivOffsetSec(d) {
  const y = d.getUTCFullYear();
  const start = lastSundayOf(y, 2); start.setUTCHours(1, 0, 0, 0);
  const end = lastSundayOf(y, 9); end.setUTCHours(1, 0, 0, 0);
  return (d >= start && d < end) ? 3 * 3600 : 2 * 3600;
}

/** Current Kyiv wall-clock parts (optionally shifted by N days for service days). */
function kyivParts(offsetDays = 0) {
  const now = new Date();
  const shifted = new Date(now.getTime() + (getKyivOffsetSec(now) + offsetDays * 86400) * 1000);
  return {
    hours: shifted.getUTCHours(),
    minutes: shifted.getUTCMinutes(),
    seconds: shifted.getUTCSeconds(),
    dateStr: shifted.getUTCFullYear() + String(shifted.getUTCMonth() + 1).padStart(2, "0") + String(shifted.getUTCDate()).padStart(2, "0"),
    dayIdx: shifted.getUTCDay() // JS: sunday = 0
  };
}

function kyivTimeString() {
  const p = kyivParts();
  return String(p.hours).padStart(2, "0") + ":" + String(p.minutes).padStart(2, "0");
}

function getKyivSecondsOfDay() {
  const p = kyivParts();
  return p.hours * 3600 + p.minutes * 60 + p.seconds;
}

/** {dateStr: "YYYYMMDD", dayIdx: 0..6 (sunday=0)} for the Kyiv service day shifted by offsetDays. */
function getKyivServiceDay(offsetDays = 0) {
  const p = kyivParts(offsetDays);
  return { dateStr: p.dateStr, dayIdx: p.dayIdx };
}

/** Formats seconds-after-midnight (may be >= 24h or slightly negative) into HH:MM (24h wrap). */
function formatGtfsTime(sec) {
  const h = (((Math.floor(sec / 3600)) % 24) + 24) % 24;
  const m = Math.floor(((((sec % 3600) + 3600) % 3600)) / 60);
  return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
}

/* ============================================================
 * ZIP + CSV + PROTOBUF PARSING
 * ============================================================ */

function readZipEntries(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("ZIP: EOCD not found");
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);

  const files = {};
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break;
    const method = dv.getUint16(off + 10, true);
    const csize = dv.getUint32(off + 20, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const commentLen = dv.getUint16(off + 32, true);
    const lho = dv.getUint32(off + 42, true);
    const name = new TextDecoder().decode(buf.subarray(off + 46, off + 46 + nameLen));
    const lnLen = dv.getUint16(lho + 26, true);
    const lExLen = dv.getUint16(lho + 28, true);
    files[name] = { method, csize, dataStart: lho + 30 + lnLen + lExLen };
    off += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

async function inflateRaw(u8) {
  const ds = new DecompressionStream("deflate-raw");
  const stream = new Blob([u8]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readZipEntry(buf, entry) {
  const slice = buf.subarray(entry.dataStart, entry.dataStart + entry.csize);
  if (entry.method === 0) return new TextDecoder().decode(slice);
  if (entry.method === 8) return new TextDecoder().decode(await inflateRaw(slice));
  throw new Error("ZIP: unsupported compression method " + entry.method);
}

/** RFC-4180-ish CSV parser; streams rows into objects (never keeps the raw row matrix). */
function csvObjects(text) {
  const results = [];
  let i = 0, field = "", row = [], inQ = false;
  if (text.charCodeAt(0) === 0xFEFF) i = 1;

  let header = null;
  const flushRow = () => {
    row.push(field);
    field = "";
    if (header === null) {
      header = row.map(h => h.trim());
    } else if (row.length >= header.length && row.some(c => c !== "")) {
      const o = {};
      header.forEach((h, idx) => { o[h] = (row[idx] || "").trim(); });
      results.push(o);
    }
    row = [];
  };

  while (i < text.length) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQ = true; i++; continue; }
    if (c === ",") { row.push(field); field = ""; i++; continue; }
    if (c === "\n") { flushRow(); i++; continue; }
    if (c === "\r") { i++; continue; }
    field += c; i++;
  }
  if (field.length || row.length) flushRow();
  return results;
}

/** Bounds-checked protobuf walker: cb(fieldNumber, wireType, value) for every field. */
function pbWalk(u8, cb) {
  const n = u8.length;
  let i = 0;
  const readVarint = () => {
    let v = 0, mul = 1, b;
    do {
      if (i >= n) return null;
      b = u8[i++];
      v += (b & 0x7f) * mul;
      mul *= 128;
    } while ((b & 0x80) && mul < 2 ** 63);
    return v;
  };
  while (i < n) {
    const key = readVarint();
    if (key === null) break;
    const field = Math.floor(key / 8), wire = key % 8;
    if (wire === 0) {
      const v = readVarint();
      if (v === null) break;
      cb(field, "varint", v);
    } else if (wire === 1) {
      if (i + 8 > n) break;
      cb(field, "fixed64", u8.subarray(i, i + 8)); i += 8;
    } else if (wire === 2) {
      const len = readVarint();
      if (len === null || i + len > n) break;
      cb(field, "bytes", u8.subarray(i, i + len)); i += len;
    } else if (wire === 5) {
      if (i + 4 > n) break;
      cb(field, "fixed32", u8.subarray(i, i + 4)); i += 4;
    } else {
      break; // unknown wire type — stop walking this message
    }
  }
}

function pbF32(u8) {
  return new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getFloat32(0, true);
}

/** Parses the Kyiv GTFS-RT VehiclePosition feed (protobuf) into plain vehicle objects. */
function parseRealtimeFeed(u8) {
  const td = new TextDecoder();
  const vehicles = [];
  pbWalk(u8, (f, t, v) => {
    if (f !== 2 || t !== "bytes") return; // FeedMessage.entity
    pbWalk(v, (f2, t2, v2) => {
      if (f2 !== 4 || t2 !== "bytes") return; // FeedEntity.vehicle
      const veh = {};
      pbWalk(v2, (f3, t3, v3) => {
        if (f3 === 1 && t3 === "bytes") { // TripDescriptor
          pbWalk(v3, (f4, t4, v4) => {
            if (f4 === 1 && t4 === "bytes") veh.tripId = td.decode(v4);
            if (f4 === 5 && t4 === "bytes") veh.routeId = td.decode(v4);
            if (f4 === 6 && t4 === "varint") veh.directionId = v4;
          });
        } else if (f3 === 2 && t3 === "bytes") { // Position (4 = odometer double, skipped)
          pbWalk(v3, (f4, t4, v4) => {
            if (f4 === 1 && t4 === "fixed32") veh.lat = pbF32(v4);
            if (f4 === 2 && t4 === "fixed32") veh.lon = pbF32(v4);
            if (f4 === 3 && t4 === "fixed32") veh.bearing = pbF32(v4);
            if (f4 === 5 && t4 === "fixed32") veh.speed = pbF32(v4);
          });
        } else if (f3 === 5 && t3 === "varint") {
          veh.timestamp = v3;
        } else if (f3 === 8 && t3 === "bytes") { // VehicleDescriptor
          pbWalk(v3, (f4, t4, v4) => {
            if (f4 === 1 && t4 === "bytes") veh.vehicleId = td.decode(v4);
            if (f4 === 2 && t4 === "bytes") veh.label = td.decode(v4);
            if (f4 === 3 && t4 === "bytes") veh.licensePlate = td.decode(v4);
          });
        }
      });
      if (veh.routeId || veh.lat !== undefined) vehicles.push(veh);
    });
  });
  return vehicles;
}

/* ============================================================
 * CACHES + GENERIC CACHED LOADER
 * ============================================================ */

const cacheStore = (typeof caches !== "undefined") ? caches.default : null;

const memoStore = new Map();      // key -> { data, until }
const inflightStore = new Map();  // key -> Promise (single-flight)

/**
 * memo (per isolate) -> Cache API (per colo) -> builder.
 * Builder failures are memoised as `fallback` for NEGATIVE_TTL_SEC (no retry storms).
 */
async function cachedJson(key, ttlSec, builder, fallback) {
  const memo = memoStore.get(key);
  if (memo && memo.until > Date.now()) return memo.data;

  if (cacheStore) {
    try {
      const hit = await cacheStore.match(new Request(key));
      if (hit) {
        const data = await hit.json();
        memoStore.set(key, { data, until: Date.now() + Math.min(ttlSec, 300) * 1000 });
        return data;
      }
    } catch { /* ignore */ }
  }

  if (inflightStore.has(key)) return inflightStore.get(key);

  const p = (async () => {
    try {
      const data = await builder();
      memoStore.set(key, { data, until: Date.now() + ttlSec * 1000 });
      if (cacheStore && data) {
        try {
          await cacheStore.put(new Request(key), new Response(JSON.stringify(data), {
            headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=" + ttlSec }
          }));
        } catch { /* ignore */ }
      }
      return data;
    } catch (err) {
      console.error("cachedJson: build failed:", key, (err && err.message) || err);
      memoStore.set(key, { data: fallback, until: Date.now() + CONFIG.NEGATIVE_TTL_SEC * 1000 });
      return fallback;
    } finally {
      inflightStore.delete(key);
    }
  })();
  inflightStore.set(key, p);
  return p;
}

/* ============================================================
 * GTFS INDEX
 * Index shape (compact on purpose):
 *   stops:     [[stopId, name, lat, lon], ...]
 *   routes:    { routeId: {n: shortName, t: routeType, l: longName} }
 *   trips:     { tripId: {r: routeId, s: serviceId} }
 *   dest:      { tripId: lastStopId }
 *   sched:     { stopId: [[depSec, tripId], ...] }
 *   tripStops: { tripId: [[stopId, depSec], ...] }  — ordered by stop_sequence
 *   calendar:  { serviceId: {s, e, d: "0111100"} }  — d = MONDAY..SUNDAY flags
 *   calDates:  { add: {date: [serviceId]}, rem: {date: [serviceId]} }
 * ============================================================ */

async function buildGtfsIndex() {
  const fetched = await fetchBytesSequential(CONFIG.GTFS_STATIC_URL, GTFS_FETCH_VARIANTS, 200000, isZip);
  if (!fetched) throw new Error("GTFS static unreachable from all fetch paths (origin 403s datacenter IPs; relays down)");
  const buf = fetched.buf;
  const entries = readZipEntries(buf);
  for (const name of ["stops.txt", "routes.txt", "trips.txt", "stop_times.txt", "calendar.txt"]) {
    if (!entries[name]) throw new Error("GTFS ZIP: " + name + " missing via " + fetched.variantId);
  }

  const [stopsTxt, routesTxt, tripsTxt, stopTimesTxt, calendarTxt, calDatesTxt, feedInfoTxt] = await Promise.all([
    readZipEntry(buf, entries["stops.txt"]),
    readZipEntry(buf, entries["routes.txt"]),
    readZipEntry(buf, entries["trips.txt"]),
    readZipEntry(buf, entries["stop_times.txt"]),
    readZipEntry(buf, entries["calendar.txt"]),
    entries["calendar_dates.txt"] ? readZipEntry(buf, entries["calendar_dates.txt"]) : Promise.resolve(""),
    entries["feed_info.txt"] ? readZipEntry(buf, entries["feed_info.txt"]) : Promise.resolve("")
  ]);

  const stops = csvObjects(stopsTxt).map(s => [s.stop_id, s.stop_name, parseFloat(s.stop_lat), parseFloat(s.stop_lon)]);
  const routes = {};
  csvObjects(routesTxt).forEach(r => {
    routes[r.route_id] = { n: r.route_short_name || r.route_id, t: parseInt(r.route_type, 10) || 0, l: r.route_long_name || "" };
  });

  const trips = {};
  csvObjects(tripsTxt).forEach(t => { trips[t.trip_id] = { r: t.route_id, s: t.service_id }; });

  // stop_times rows are NOT guaranteed to be ordered — sort every trip by stop_sequence.
  const tripRows = {};
  csvObjects(stopTimesTxt).forEach((st, rowNo) => {
    const parts = (st.departure_time || st.arrival_time || "").split(":").map(Number);
    if (parts.length !== 3 || parts.some(Number.isNaN)) return;
    const dep = parts[0] * 3600 + parts[1] * 60 + parts[2];
    const seq = parseInt(st.stop_sequence, 10);
    (tripRows[st.trip_id] ||= []).push([Number.isFinite(seq) ? seq : rowNo, st.stop_id, dep]);
  });

  const dest = {};
  const sched = {};
  const tripStops = {};
  for (const tripId of Object.keys(tripRows)) {
    const rows = tripRows[tripId];
    rows.sort((a, b) => a[0] - b[0]);
    const seq = new Array(rows.length);
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      seq[i] = [r[1], r[2]];
      (sched[r[1]] ||= []).push([r[2], tripId]);
    }
    tripStops[tripId] = seq;
    dest[tripId] = rows[rows.length - 1][1];
    delete tripRows[tripId];
  }

  const calendar = {};
  csvObjects(calendarTxt).forEach(c => {
    calendar[c.service_id] = {
      s: c.start_date,
      e: c.end_date,
      d: [c.monday, c.tuesday, c.wednesday, c.thursday, c.friday, c.saturday, c.sunday].map(x => x === "1" ? "1" : "0").join("")
    };
  });

  const calDates = { add: {}, rem: {} };
  csvObjects(calDatesTxt).forEach(cd => {
    const bucket = cd.exception_type === "1" ? calDates.add : calDates.rem;
    (bucket[cd.date] ||= []).push(cd.service_id);
  });

  let version = "";
  csvObjects(feedInfoTxt).forEach(fi => { version = fi.feed_version || version; });

  return { version, stops, routes, trips, dest, sched, tripStops, calendar, calDates };
}

let gtfsMemo = null;
let gtfsMemoAt = 0;
let gtfsBuildPromise = null;
let lastBuildFailMs = 0;

const GTFS_CACHE_KEY = "https://kpt-cache.internal/gtfs-index-envelope-v4";

function indexLooksValid(data) {
  return !!(data && Array.isArray(data.stops) && data.stops.length >= 100 && data.sched && data.trips && data.calendar && data.calDates);
}

/** True when the index has a service pattern for the given YYYYMMDD date. */
function indexCoversDate(data, dateStr) {
  try {
    if (data.calDates && data.calDates.add && data.calDates.add[dateStr]) return true;
    return Object.values(data.calendar).some(c => dateStr >= c.s && dateStr <= c.e);
  } catch {
    return false;
  }
}

function setGtfsMemo(data) {
  gtfsMemo = data;
  gtfsMemoAt = Date.now();
}

async function readEnvelope() {
  if (!cacheStore) return null;
  try {
    const hit = await cacheStore.match(new Request(GTFS_CACHE_KEY));
    if (!hit) return null;
    const envelope = await hit.json();
    return envelope && envelope.data ? envelope.data : null;
  } catch {
    return null;
  }
}

async function storeEnvelope(data) {
  if (!cacheStore) return;
  try {
    await cacheStore.put(new Request(GTFS_CACHE_KEY), new Response(JSON.stringify({ data, fetchedAt: Date.now() }), {
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=" + 7 * 24 * 3600 }
    }));
  } catch { /* ignore */ }
}

/** Bundled gtfs-index.json asset — available in every colo, zero network dependency. */
async function readAssetIndex(env) {
  try {
    if (!env || !env.ASSETS) return null;
    const res = await env.ASSETS.fetch(new Request("https://assets.internal/gtfs-index.json"));
    if (!res.ok) return null;
    const data = await res.json();
    return indexLooksValid(data) ? data : null;
  } catch (err) {
    console.error("asset index read failed:", (err && err.message) || err);
    return null;
  }
}

/** Single-flight remote rebuild with failure backoff. Resolves with the new index or null. */
function refreshGtfsIndex(force) {
  if (gtfsBuildPromise) return gtfsBuildPromise;
  gtfsBuildPromise = (async () => {
    try {
      if (!force && Date.now() - lastBuildFailMs < CONFIG.GTFS_BUILD_BACKOFF_MS) return null;
      const data = await buildGtfsIndex();
      if (!indexLooksValid(data)) throw new Error("rebuilt GTFS index failed validation");
      data.fetchedAtMs = Date.now();
      setGtfsMemo(data);
      await storeEnvelope(data);
      return data;
    } catch (err) {
      lastBuildFailMs = Date.now();
      console.error("GTFS index rebuild failed:", (err && err.message) || err);
      return null;
    } finally {
      gtfsBuildPromise = null;
    }
  })();
  return gtfsBuildPromise;
}

/**
 * Stale-while-revalidate loader:
 *   memo -> edge-cache envelope -> bundled asset  (served immediately, never blocked on the network)
 * A background rebuild is started when the data is older than GTFS_INDEX_TTL_SEC.
 * Only when NO index covers today does the request wait (bounded) for a rebuild,
 * then fall back to the freshest stale copy (flagged `stale: true`).
 */
async function loadGtfsIndex(ctx = null, env = null) {
  const today = getKyivServiceDay().dateStr;
  const memoTtlMs = CONFIG.GTFS_MEMO_TTL_SEC * 1000;
  const usable = d => indexLooksValid(d) && indexCoversDate(d, today);

  if (gtfsMemo && gtfsMemo.stale && Date.now() - gtfsMemoAt < memoTtlMs) return gtfsMemo;

  let best = usable(gtfsMemo) ? gtfsMemo : null;
  let envData = null;
  let assetData = null;

  if (!best || Date.now() - gtfsMemoAt > memoTtlMs) {
    envData = await readEnvelope();
    if (usable(envData) && (!best || (envData.fetchedAtMs || 0) > (best.fetchedAtMs || 0))) best = envData;
    if (!best) {
      assetData = await readAssetIndex(env);
      if (usable(assetData)) best = assetData;
    }
    if (best) setGtfsMemo(best);
  }

  if (best) {
    if (Date.now() - (best.fetchedAtMs || 0) > CONFIG.GTFS_INDEX_TTL_SEC * 1000) {
      waitUntil(ctx, refreshGtfsIndex(false));
    }
    return best;
  }

  // Nothing in hand covers today's service day: bounded wait for a rebuild, then stale fallback.
  const rebuild = waitUntil(ctx, refreshGtfsIndex(false));
  const rebuilt = await withDeadline(rebuild, CONFIG.GTFS_BLOCKING_BUILD_BUDGET_MS, null);
  if (rebuilt) return rebuilt;

  let stale = indexLooksValid(gtfsMemo) ? gtfsMemo : null;
  if (!stale) {
    const e = envData || await readEnvelope();
    if (indexLooksValid(e)) stale = e;
  }
  if (!stale) {
    const a = assetData || await readAssetIndex(env);
    if (indexLooksValid(a)) stale = a;
  }
  if (stale) {
    stale.stale = true;
    setGtfsMemo(stale);
  }
  return stale;
}

/* ============================================================
 * AUXILIARY REGISTRIES
 * ============================================================ */

/** Vehicle registry (open data): { "board no. digits": {model, lowFloor} } */
async function buildVehicleIndex() {
  const list = await fetchJsonWithTimeout(CONFIG.VEHICLES_URL, CONFIG.REGISTRY_FETCH_TIMEOUT_MS, "Vehicle registry");
  const map = {};
  if (Array.isArray(list)) {
    list.forEach(v => {
      const digits = String(v.vehicleNumber || "").match(/\d{3,}/);
      if (digits) {
        map[digits[0]] = {
          model: [v.brand, v.model].filter(Boolean).join(" ") || "—",
          lowFloor: String(v.isLowFloor) === "True" || v.wheelchairAccessible === 1
        };
      }
    });
  }
  return map;
}

function loadVehicleIndex() {
  return cachedJson("https://kpt-cache.internal/vehicle-registry", CONFIG.VEHICLES_TTL_SEC, buildVehicleIndex, {});
}

/** Official stop registry (ІАС «Майно»). Shape: [[label, lat, lon], ...] */
async function buildMaynoStops() {
  const list = await fetchJsonWithTimeout(CONFIG.MAYNO_STOPS_URL, CONFIG.REGISTRY_FETCH_TIMEOUT_MS, "Mayno stop registry");
  if (!Array.isArray(list)) return [];
  return list
    .filter(s => s && s.label && typeof s.lat === "number" && typeof s.lon === "number")
    .map(s => [s.label, s.lat, s.lon]);
}

function loadMaynoStops() {
  return cachedJson("https://kpt-cache.internal/mayno-stops", CONFIG.MAYNO_TTL_SEC, buildMaynoStops, []);
}

/* ============================================================
 * REALTIME
 * ============================================================ */

let rtMemo = null, rtMemoUntil = 0, rtInflight = null;
const RT_CACHE_KEY = "https://kpt-cache.internal/realtime-v1";

/**
 * Live vehicles (GTFS-RT). Relays are raced in parallel under REALTIME_BUDGET_MS;
 * on failure the board degrades to schedule-only for 15 s (never blocks, never crashes).
 */
function loadRealtime() {
  if (rtMemo && Date.now() < rtMemoUntil) return Promise.resolve(rtMemo);
  if (rtInflight) return rtInflight;
  rtInflight = (async () => {
    try {
      let vehicles = null;
      if (cacheStore) {
        try {
          const hit = await cacheStore.match(new Request(RT_CACHE_KEY));
          if (hit) vehicles = await hit.json();
        } catch { /* ignore */ }
      }
      if (!vehicles) {
        const fetched = await fetchBytesRace(CONFIG.REALTIME_URL, REALTIME_FETCH_VARIANTS, 20, looksLikeFeed, CONFIG.REALTIME_BUDGET_MS);
        if (fetched) {
          vehicles = parseRealtimeFeed(fetched.buf);
          if (cacheStore) {
            try {
              await cacheStore.put(new Request(RT_CACHE_KEY), new Response(JSON.stringify(vehicles), {
                headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=" + CONFIG.REALTIME_TTL_SEC }
              }));
            } catch { /* ignore */ }
          }
        }
      }
      if (vehicles) {
        rtMemo = vehicles;
        rtMemoUntil = Date.now() + CONFIG.REALTIME_TTL_SEC * 1000;
        return vehicles;
      }
    } catch (err) {
      console.error("realtime load failed:", (err && err.message) || err);
    } finally {
      rtInflight = null;
    }
    rtMemo = [];
    rtMemoUntil = Date.now() + 15 * 1000;
    return rtMemo;
  })();
  return rtInflight;
}

/** Active GTFS service ids for the Kyiv service day shifted by dayOffset (calendar + exceptions). */
function activeServiceIds(index, dayOffset = 0) {
  const day = getKyivServiceDay(dayOffset);
  const flagIdx = (day.dayIdx + 6) % 7; // calendar.d is MONDAY..SUNDAY, JS getUTCDay() is SUNDAY=0
  const set = new Set();
  Object.entries(index.calendar).forEach(([sid, c]) => {
    if (day.dateStr >= c.s && day.dateStr <= c.e && c.d[flagIdx] === "1") set.add(sid);
  });
  const add = index.calDates.add[day.dateStr];
  if (add) add.forEach(sid => set.add(sid));
  const rem = index.calDates.rem[day.dateStr];
  if (rem) rem.forEach(sid => set.delete(sid));
  return set;
}

const ROUTE_TYPE_LABELS = { 0: "ТРАМ", 11: "ТРОЛ", 3: "АВТ", 1: "МЕТРО", 2: "ПОЇЗД" };
const STOP_MODE_LABELS = { "1": "ТРАМ", "2": "ТРОЛ", "3": "АВТ" };

/* ============================================================
 * HUB RESOLVER — official schedule board for any stop
 * ============================================================ */

function normalizeName(str) {
  return String(str || "").toLowerCase().replace(/[«»"'„“]/g, "").replace(/\s+/g, " ").trim();
}

function distanceMeters(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * 111320;
  const dLon = (lon2 - lon1) * 111320 * Math.cos((lat1 + lat2) / 2 * Math.PI / 180);
  return Math.hypot(dLat, dLon);
}

/**
 * Free-text query -> { title, stopIds }:
 * 1. exact/substring name match in GTFS control points (busiest name wins),
 * 2. else ІАС «Майно» point -> all GTFS stops within 250 m (then 500 m).
 */
async function resolveTargetStops(index, query, ctx = null) {
  const q = normalizeName(query);
  if (!q) return null;

  const exactNames = {};
  const allNames = {};
  for (const s of index.stops) {
    const nameNorm = normalizeName(s[1]);
    if (nameNorm === q) (exactNames[s[1]] ||= []).push(s);
    if (nameNorm.includes(q)) (allNames[s[1]] ||= []).push(s);
  }

  const pickBusiest = pool => {
    let best = null, bestScore = -1;
    for (const [name, stops] of Object.entries(pool)) {
      const score = stops.reduce((acc, s) => acc + (index.sched[s[0]] || []).length, 0);
      if (score > bestScore) { bestScore = score; best = { title: name, stopIds: stops.map(s => s[0]) }; }
    }
    return best;
  };

  const exact = pickBusiest(exactNames);
  if (exact) return exact;
  const partial = pickBusiest(allNames);
  if (partial) return partial;

  const maynoPromise = waitUntil(ctx, loadMaynoStops());
  const mayno = await withDeadline(maynoPromise, CONFIG.MAYNO_RESOLVE_BUDGET_MS, []);
  const maynoMatch = mayno.find(m => normalizeName(m[0]) === q)
    || mayno.find(m => normalizeName(m[0]).includes(q));
  if (maynoMatch) {
    for (const radius of [CONFIG.NEARBY_STOP_RADIUS_M, 500]) {
      const nearby = index.stops
        .filter(s => s[2] && s[3] && distanceMeters(maynoMatch[1], maynoMatch[2], s[2], s[3]) <= radius);
      if (nearby.length > 0) return { title: maynoMatch[0], stopIds: nearby.map(s => s[0]) };
    }
  }
  return null;
}

const hubMemo = new Map();      // normalized stop -> { hub, until }
const hubInflight = new Map();  // normalized stop -> Promise<hub>

function hubMemoSet(key, hub) {
  if (hubMemo.size >= 100) hubMemo.delete(hubMemo.keys().next().value);
  hubMemo.set(key, { hub, until: Date.now() + CONFIG.HUB_TTL_SEC * 1000 });
}

/** Non-mutating: re-derives remaining minutes of a (possibly cached) hub and drops departed trips. */
function refreshHubTimes(hub) {
  const out = { ...hub, kyivTime: kyivTimeString() };
  if (!hub.directions || !hub.builtAtMs) return out;
  const nowRel = (hub.nowSecAtBuild || 0) + (Date.now() - hub.builtAtMs) / 1000;
  out.directions = hub.directions
    .map(dir => ({
      ...dir,
      departures: (dir.departures || [])
        .filter(d => d.depAbs >= nowRel - 60)
        .map(d => ({ ...d, remainingMinutes: Math.max(0, Math.round((d.depAbs - nowRel) / 60)) }))
    }))
    .filter(dir => dir.departures.length > 0);
  return out;
}

async function buildHub(hubKey, ctx, env) {
  const kyivTimeStr = kyivTimeString();
  const slug = hubKey.toLowerCase().replace(/\s+/g, "-");
  const index = await loadGtfsIndex(ctx, env);
  if (!index) {
    return { hubKey: slug, title: "Київ, " + hubKey, kyivTime: kyivTimeStr, directions: [], unavailable: true };
  }

  const target = await resolveTargetStops(index, hubKey, ctx);
  if (!target) {
    return { hubKey: slug, title: "Київ, " + hubKey, kyivTime: kyivTimeStr, directions: [], stale: !!index.stale };
  }

  const stopNameById = {};
  const stopPosById = {};
  index.stops.forEach(s => { stopNameById[s[0]] = s[1]; stopPosById[s[0]] = [s[2], s[3]]; });

  const nowSec = getKyivSecondsOfDay();
  // Yesterday (times >= 24:00), today, tomorrow (the window may cross midnight).
  const dayServices = [-1, 0, 1].map(off => ({ off, services: activeServiceIds(index, off) }));

  const vehiclePromise = waitUntil(ctx, loadVehicleIndex());
  const [rtVehicles, vehicleIndex] = await Promise.all([
    loadRealtime(),
    withDeadline(vehiclePromise, CONFIG.AUX_BUDGET_MS, {})
  ]);

  const rtByTrip = new Map();
  rtVehicles.forEach(v => { if (v.tripId && !rtByTrip.has(v.tripId)) rtByTrip.set(v.tripId, v); });

  // Upcoming departures over all resolved platforms. The same trip at two nearby
  // platforms counts once (earliest departure wins).
  const picked = new Map();
  for (const stopId of target.stopIds) {
    for (const pair of (index.sched[stopId] || [])) {
      const dep = pair[0], tripId = pair[1];
      const trip = index.trips[tripId];
      if (!trip) continue;
      for (const ds of dayServices) {
        if (!ds.services.has(trip.s)) continue;
        const abs = dep + ds.off * 86400;
        if (abs < nowSec - 60 || abs > nowSec + CONFIG.DEPARTURE_WINDOW_SEC) continue;
        const k = tripId + "@" + ds.off;
        const prev = picked.get(k);
        if (!prev || abs < prev.abs) picked.set(k, { abs, dep, tripId, trip, originStopId: stopId });
      }
    }
  }
  const upcoming = [...picked.values()].sort((a, b) => a.abs - b.abs);

  const groups = {};
  for (const d of upcoming) {
    const route = index.routes[d.trip.r] || { n: d.trip.r, t: -1, l: "" };
    const destStopId = index.dest[d.tripId] || "";
    const destName = stopNameById[destStopId] || route.l || "Кінцева зупинка";
    const key = d.trip.r + ">" + destStopId;

    if (!groups[key]) {
      const type = ROUTE_TYPE_LABELS[route.t] || "ТРАНЗ";
      groups[key] = {
        id: "plat-" + Object.keys(groups).length,
        key,
        title: "ПЛАТФОРМА · " + type + " (НАПРЯМОК: " + destName.toUpperCase() + ")",
        type,
        typeKey: route.t,
        departures: []
      };
    }

    // Live vehicle — only when the realtime feed reports THIS trip.
    let vehicle = null;
    const live = rtByTrip.get(d.tripId);
    if (live) {
      const plateDigits = String(live.licensePlate || live.label || "").match(/\d{3,}/);
      const registry = plateDigits ? vehicleIndex[plateDigits[0]] : null;
      const pos = stopPosById[d.originStopId];
      const hasPos = typeof live.lat === "number" && typeof live.lon === "number" && Number.isFinite(live.lat) && Number.isFinite(live.lon) && pos && Number.isFinite(pos[0]) && Number.isFinite(pos[1]);
      vehicle = {
        boardNumber: live.licensePlate || live.label || "—",
        licensePlate: live.label && live.label !== live.licensePlate ? live.label : "—",
        model: registry ? registry.model : "—",
        isLowFloor: registry ? !!registry.lowFloor : false,
        distanceM: hasPos ? Math.round(distanceMeters(live.lat, live.lon, pos[0], pos[1])) : null
      };
    }

    // Timeline: this platform + next stops of the trip (ordered by stop_sequence).
    const seq = index.tripStops[d.tripId] || [];
    let i0 = seq.findIndex(x => x[0] === d.originStopId && x[1] === d.dep);
    if (i0 < 0) i0 = seq.findIndex(x => x[0] === d.originStopId);
    const from = Math.max(i0, 0);
    const tail = seq.slice(from, from + CONFIG.TIMELINE_STOPS_LIMIT);
    const stopsTimeline = tail.map((entry, i) => ({
      name: stopNameById[entry[0]] || entry[0],
      time: formatGtfsTime(entry[1]),
      delayMin: 0,
      status: i === 0 ? "current" : (i === tail.length - 1 ? "destination" : "intermediate")
    }));

    groups[key].departures.push({
      tripId: d.tripId,
      route: route.n,
      destination: destName,
      time: formatGtfsTime(d.abs),
      depAbs: d.abs,
      delayMin: 0,
      remainingMinutes: Math.max(0, Math.round((d.abs - nowSec) / 60)),
      vehicle,
      stops: stopsTimeline
    });
  }

  const directions = Object.values(groups).map(g => {
    g.departures.sort((a, b) => a.depAbs - b.depAbs);
    g.departures = g.departures.slice(0, CONFIG.MAX_DEPARTURES_PER_CARD);
    return g;
  });

  return {
    hubKey: target.stopIds[0],
    title: "Київ, " + target.title,
    stopName: target.title,
    kyivTime: kyivTimeStr,
    directions,
    feedVersion: index.version,
    stale: !!index.stale,
    builtAtMs: Date.now(),
    nowSecAtBuild: nowSec
  };
}

async function resolveHubDepartures(query, ctx = null, env = null) {
  const hubKey = String(query || "").trim() || CONFIG.DEFAULT_STOP;
  const memoKey = normalizeName(hubKey);
  const cacheKey = new Request("https://kpt-cache.internal/api/hub/v6/" + encodeURIComponent(memoKey));

  const m = hubMemo.get(memoKey);
  if (m && m.until > Date.now()) return refreshHubTimes(m.hub);

  if (cacheStore) {
    try {
      const hit = await cacheStore.match(cacheKey);
      if (hit) {
        const hub = await hit.json();
        hubMemoSet(memoKey, hub);
        return refreshHubTimes(hub);
      }
    } catch { /* ignore */ }
  }

  if (hubInflight.has(memoKey)) return refreshHubTimes(await hubInflight.get(memoKey));

  const p = (async () => {
    try {
      const hub = await buildHub(hubKey, ctx, env);
      // Cache only productive boards — empty/unavailable ones stay cheap to rebuild.
      if (hub.directions && hub.directions.length > 0) {
        hubMemoSet(memoKey, hub);
        if (cacheStore) {
          try {
            await cacheStore.put(cacheKey, new Response(JSON.stringify(hub), {
              headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=" + CONFIG.HUB_TTL_SEC }
            }));
          } catch { /* ignore */ }
        }
      }
      return hub;
    } finally {
      hubInflight.delete(memoKey);
    }
  })();
  hubInflight.set(memoKey, p);
  return refreshHubTimes(await p);
}

/* ============================================================
 * SEARCH — official stop registry
 * ============================================================ */

async function searchStops(query, ctx = null, env = null) {
  const q = normalizeName(query);
  if (q.length < 2) return { results: [] };

  const index = await withDeadline(loadGtfsIndex(ctx, env), CONFIG.API_HUB_BUDGET_MS, null);
  const byName = {};

  if (index) {
    for (const s of index.stops) {
      const nameNorm = normalizeName(s[1]);
      if (!nameNorm.includes(q)) continue;
      const mode = STOP_MODE_LABELS[String(s[0]).split("_")[0]] || "ТРАНЗ";
      const entry = byName[s[1]] || (byName[s[1]] = { name: s[1], modeSet: new Set() });
      entry.modeSet.add(mode);
    }
  }

  // ІАС «Майно» — metro, funicular, city express and full street names (time-boxed).
  const maynoPromise = waitUntil(ctx, loadMaynoStops());
  const mayno = await withDeadline(maynoPromise, CONFIG.SEARCH_AUX_BUDGET_MS, []);
  const seenNames = new Set(Object.keys(byName).map(n => normalizeName(n)));
  for (const m of mayno) {
    const norm = normalizeName(m[0]);
    if (!norm.includes(q) || seenNames.has(norm)) continue;
    seenNames.add(norm);
    byName[m[0]] = { name: m[0], modeSet: new Set([maynoBadge(m[0])]) };
  }

  const results = Object.values(byName).map(e => ({
    name: e.name,
    modes: [...e.modeSet].join(", ") || "Київ"
  }));

  if (results.length === 0 && !index) return { results: [], unavailable: true };

  results.sort((a, b) => {
    const ap = normalizeName(a.name).startsWith(q) ? 0 : 1;
    const bp = normalizeName(b.name).startsWith(q) ? 0 : 1;
    return ap - bp || a.name.localeCompare(b.name, "uk");
  });

  return { results: results.slice(0, 12) };
}

/** Badge for official-registry stops (the registry has no machine-readable type). */
function maynoBadge(label) {
  const n = String(label).toLowerCase();
  if (n.includes("ст.м.") || n.includes("метро")) return "МЕТРО";
  if (n.includes("фунікул")) return "ФУНІКУЛЕР";
  if (n.includes("електричка") || n.includes("city express")) return "ЕЛЕКТРИЧКА";
  return "КИЇВ";
}

/* ============================================================
 * PAGE STYLES (unchanged layout from 3.0)
 * ============================================================ */
const PAGE_CSS =
    ':root {' +
      '--bg: #0d1117;' +
      '--card-bg: #161b22;' +
      '--border: #30363d;' +
      '--text: #c9d1d9;' +
      '--text-muted: #8b949e;' +
      '--route-cyan: #0284c7;' +
      '--bus-red: #dc2626;' +
      '--live-green: #3fb950;' +
      '--delay-red: #f85149;' +
      '--eta-white: #ffffff;' +
    '}' +
    '* { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }' +
    'body { background: var(--bg); color: var(--text); padding: 20px; }' +
    '.container { max-width: 1300px; margin: 0 auto; }' +
    '.top-header {' +
      'display: flex;' +
      'justify-content: space-between;' +
      'align-items: center;' +
      'margin-bottom: 16px;' +
      'flex-wrap: wrap;' +
      'gap: 12px;' +
    '}' +
    '.station-title {' +
      'font-size: 1.55rem;' +
      'font-weight: 800;' +
      'color: #f0f6fc;' +
      'letter-spacing: -0.02em;' +
    '}' +
    '.header-actions { display: flex; gap: 10px; align-items: center; }' +
    '.clock-badge {' +
      'background: #1f2937;' +
      'color: #38bdf8;' +
      'padding: 6px 14px;' +
      'border-radius: 6px;' +
      'font-weight: 700;' +
      'font-size: 0.95rem;' +
      'border: 1px solid #374151;' +
    '}' +
    '.btn-icon {' +
      'background: #21262d;' +
      'border: 1px solid var(--border);' +
      'color: #c9d1d9;' +
      'padding: 6px 12px;' +
      'border-radius: 6px;' +
      'cursor: pointer;' +
      'font-size: 0.9rem;' +
      'transition: background 0.15s;' +
    '}' +
    '.btn-icon:hover { background: #30363d; }' +
    '.btn-fav.active { color: #facc15; border-color: #ca8a04; }' +

    /* Universal Search Bar */
    '.search-bar-wrapper {' +
      'position: relative;' +
      'margin-bottom: 22px;' +
    '}' +
    '.search-input {' +
      'width: 100%;' +
      'background: #161b22;' +
      'border: 1px solid #30363d;' +
      'color: #f0f6fc;' +
      'padding: 14px 20px;' +
      'border-radius: 8px;' +
      'font-size: 1rem;' +
      'outline: none;' +
      'transition: border-color 0.2s, box-shadow 0.2s;' +
    '}' +
    '.search-input:focus {' +
      'border-color: #38bdf8;' +
      'box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.15);' +
    '}' +
    '.search-dropdown {' +
      'position: absolute;' +
      'top: 100%;' +
      'left: 0;' +
      'right: 0;' +
      'background: #1c2128;' +
      'border: 1px solid #30363d;' +
      'border-radius: 8px;' +
      'margin-top: 6px;' +
      'max-height: 320px;' +
      'overflow-y: auto;' +
      'z-index: 1000;' +
      'box-shadow: 0 10px 25px rgba(0,0,0,0.5);' +
    '}' +
    '.search-item {' +
      'padding: 12px 18px;' +
      'cursor: pointer;' +
      'border-bottom: 1px solid rgba(255,255,255,0.04);' +
      'font-size: 0.95rem;' +
      'display: flex;' +
      'justify-content: space-between;' +
      'align-items: center;' +
    '}' +
    '.search-item:hover { background: #262c36; color: #38bdf8; }' +
    '.search-item-badge {' +
      'font-size: 0.78rem;' +
      'background: #30363d;' +
      'color: #38bdf8;' +
      'padding: 2px 8px;' +
      'border-radius: 4px;' +
      'font-weight: 600;' +
    '}' +
    '.search-item-muted { color: #8b949e; cursor: default; }' +
    '.search-item-muted:hover { background: transparent; color: #8b949e; }' +

    '.departure-grid {' +
      'display: grid;' +
      'grid-template-columns: 1fr 1fr;' +
      'gap: 20px;' +
    '}' +
    '@media (max-width: 900px) {' +
      '.departure-grid { grid-template-columns: 1fr; }' +
    '}' +
    '.board-card {' +
      'background: var(--card-bg);' +
      'border: 1px solid var(--border);' +
      'border-radius: 10px;' +
      'overflow: hidden;' +
    '}' +
    '.card-header {' +
      'padding: 14px 18px;' +
      'display: flex;' +
      'align-items: center;' +
      'gap: 12px;' +
      'background: rgba(255, 255, 255, 0.02);' +
      'border-bottom: 1px solid var(--border);' +
    '}' +
    '.type-badge {' +
      'background: var(--bus-red);' +
      'color: #fff;' +
      'font-weight: 800;' +
      'font-size: 0.75rem;' +
      'padding: 3px 6px;' +
      'border-radius: 4px;' +
      'text-transform: uppercase;' +
      'letter-spacing: 0.05em;' +
    '}' +
    '.type-badge.tram { background: #d97706; }' +
    '.type-badge.bus { background: var(--bus-red); }' +
    '.type-badge.metro { background: #16a34a; }' +
    '.type-badge.train { background: #2563eb; }' +
    '.type-badge.trolley { background: #8b5cf6; }' +
    '.platform-title {' +
      'font-size: 1.12rem;' +
      'font-weight: 800;' +
      'letter-spacing: 0.03em;' +
      'text-transform: uppercase;' +
    '}' +
    '.table-columns {' +
      'display: grid;' +
      'grid-template-columns: 1fr 90px 70px 65px;' +
      'padding: 8px 18px;' +
      'font-size: 0.72rem;' +
      'font-weight: 700;' +
      'color: var(--text-muted);' +
      'letter-spacing: 0.06em;' +
      'border-bottom: 1px solid rgba(255, 255, 255, 0.04);' +
    '}' +
    '.table-columns div:nth-child(2),' +
    '.table-columns div:nth-child(3),' +
    '.table-columns div:nth-child(4) {' +
      'text-align: right;' +
    '}' +
    '.departure-list { display: flex; flex-direction: column; }' +
    '.departure-item-wrapper {' +
      'border-bottom: 1px solid rgba(255, 255, 255, 0.04);' +
    '}' +
    '.departure-item-wrapper:last-child { border-bottom: none; }' +
    '.departure-row {' +
      'display: grid;' +
      'grid-template-columns: 1fr 90px 70px 65px;' +
      'padding: 12px 18px;' +
      'align-items: center;' +
      'cursor: pointer;' +
      'user-select: none;' +
      'transition: background 0.15s;' +
    '}' +
    '.departure-row:hover { background: rgba(255, 255, 255, 0.03); }' +
    '.route-cell {' +
      'display: flex;' +
      'align-items: center;' +
      'gap: 12px;' +
      'overflow: hidden;' +
    '}' +
    '.route-badge {' +
      'background: var(--route-cyan);' +
      'color: #fff;' +
      'font-weight: 800;' +
      'font-size: 0.95rem;' +
      'padding: 4px 8px;' +
      'border-radius: 6px;' +
      'min-width: 48px;' +
      'text-align: center;' +
      'letter-spacing: -0.02em;' +
    '}' +
    '.route-badge.metro { background: #16a34a; }' +
    '.route-badge.train { background: #2563eb; }' +
    '.route-badge.tram { background: #d97706; }' +
    '.route-badge.trolley { background: #8b5cf6; }' +
    '.destination-name {' +
      'font-weight: 700;' +
      'font-size: 0.98rem;' +
      'white-space: nowrap;' +
      'overflow: hidden;' +
      'text-overflow: ellipsis;' +
      'color: var(--text);' +
    '}' +
    '.distance-cell {' +
      'text-align: right;' +
      'font-size: 0.85rem;' +
      'color: var(--live-green);' +
      'font-weight: 600;' +
    '}' +
    '.time-cell {' +
      'text-align: right;' +
      'font-size: 0.95rem;' +
      'font-weight: 700;' +
    '}' +
    '.time-scheduled { display: block; }' +
    '.eta-cell {' +
      'text-align: right;' +
      'font-size: 1rem;' +
      'font-weight: 800;' +
      'color: var(--eta-white);' +
    '}' +
    '.eta-cell.hours { color: var(--text-muted); font-size: 0.9rem; font-weight: 600; }' +

    /* Vehicle info line: "№ board | label | model | ♿" */
    '.vehicle-info-bar {' +
      'font-size: 0.88rem;' +
      'font-weight: 600;' +
      'color: #94a3b8;' +
      'padding: 4px 0 10px 0;' +
      'margin-bottom: 12px;' +
      'border-bottom: 1px solid rgba(255, 255, 255, 0.06);' +
      'display: flex;' +
      'align-items: center;' +
      'gap: 8px;' +
      'flex-wrap: wrap;' +
    '}' +
    '.vehicle-board { color: #38bdf8; font-weight: 700; }' +
    '.vehicle-plate { color: #f1f5f9; }' +
    '.vehicle-model { color: #cbd5e1; }' +
    '.vehicle-accessibility { color: #4ade80; font-size: 1.05rem; }' +

    /* Full Trip Timeline & Clickable Stops */
    '.trip-timeline-panel {' +
      'background: #0f151d;' +
      'padding: 14px 18px 18px 28px;' +
      'border-top: 1px solid rgba(255, 255, 255, 0.03);' +
    '}' +
    '.timeline-track {' +
      'position: relative;' +
      'border-left: 2px solid #283344;' +
      'padding-left: 18px;' +
      'display: flex;' +
      'flex-direction: column;' +
      'gap: 12px;' +
    '}' +
    '.timeline-stop-row {' +
      'position: relative;' +
      'display: flex;' +
      'align-items: center;' +
      'justify-content: space-between;' +
      'font-size: 0.92rem;' +
    '}' +
    '.timeline-bullet-col {' +
      'position: absolute;' +
      'left: -24px;' +
      'top: 50%;' +
      'transform: translateY(-50%);' +
    '}' +
    '.timeline-dot {' +
      'width: 10px;' +
      'height: 10px;' +
      'border-radius: 50%;' +
      'background: #475569;' +
    '}' +
    '.timeline-dot.dot-current {' +
      'background: #38bdf8;' +
      'box-shadow: 0 0 8px rgba(56, 189, 248, 0.6);' +
    '}' +
    '.timeline-dot.dot-intermediate { background: #64748b; }' +
    '.timeline-dot.dot-destination { background: #3fb950; }' +
    '.timeline-name-col { flex: 1; font-weight: 600; padding-right: 12px; }' +
    '.timeline-name-col.stop-clickable {' +
      'cursor: pointer;' +
      'transition: color 0.15s;' +
    '}' +
    '.timeline-name-col.stop-clickable:hover { color: #38bdf8; text-decoration: underline; }' +
    '.stop-nav-arrow { font-size: 0.75rem; opacity: 0.7; margin-left: 4px; }' +
    '.name-current { color: #38bdf8; font-weight: 700; }' +
    '.name-intermediate { color: #94a3b8; }' +
    '.name-destination { color: #3fb950; font-weight: 700; }' +
    '.timeline-time-col {' +
      'font-weight: 700;' +
      'color: #f1f5f9;' +
      'font-size: 0.9rem;' +
      'display: flex;' +
      'gap: 6px;' +
      'white-space: nowrap;' +
    '}' +
    '.card-footer {' +
      'padding: 10px 18px;' +
      'border-top: 1px solid var(--border);' +
      'text-align: center;' +
      'background: rgba(255, 255, 255, 0.01);' +
    '}' +
    '.show-all-btn {' +
      'background: none;' +
      'border: none;' +
      'color: var(--text-muted);' +
      'font-size: 0.85rem;' +
      'cursor: pointer;' +
      'display: inline-flex;' +
      'align-items: center;' +
      'gap: 6px;' +
    '}' +
    '.show-all-btn:hover { color: var(--text); }' +
  '';

const EXTRA_CSS = `
.status-banner { padding: 10px 14px; margin-bottom: 14px; border-radius: 8px; font-size: 0.9rem; border: 1px solid var(--border); background: var(--card-bg); color: var(--text); }
.status-banner.warn { border-color: #9e6a03; color: #d29922; }
.status-banner.error { border-color: #8e1519; color: var(--delay-red); }
.notice-card { grid-column: 1 / -1; padding: 40px 20px; text-align: center; background: #161b22; border: 1px solid #30363d; border-radius: 8px; color: #8b949e; }
.notice-card.error { color: #f85149; }
.btn-icon:disabled { opacity: 0.6; cursor: progress; }
`;

/* ============================================================
 * PAGE: one client-side renderer (no duplicated server-side card markup)
 * ============================================================ */

function escapeHtml(s) {
  return String(s === null || s === undefined ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** JSON that is safe to inline inside a <script> element. */
function jsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

const CLIENT_JS = String.raw`
(function () {
  "use strict";
  var BOOT = __BOOT__;
  var ROUTE_TYPE_CLASSES = { 0: "tram", 11: "trolley", 3: "bus", 1: "metro", 2: "train" };
  var HUB_TIMEOUT_MS = 20000;
  var SEARCH_TIMEOUT_MS = 8000;

  var stationTitle = document.getElementById("stationTitle");
  var departureGrid = document.getElementById("departureGrid");
  var refreshBtn = document.getElementById("refreshBtn");
  var favBtn = document.getElementById("favBtn");
  var clockBadge = document.getElementById("clockBadge");
  var statusBanner = document.getElementById("statusBanner");
  var searchInput = document.getElementById("stopSearchInput");
  var searchDropdown = document.getElementById("searchResults");

  var currentStop = BOOT.stop;
  var currentHub = BOOT.hub;
  var expanded = {};
  var openTrips = {};
  var hubSeq = 0;
  var hubCtrl = null;
  var searchSeq = 0;
  var searchCtrl = null;
  var searchDebounce = null;
  var retryTimer = null;
  var clockFormatter = null;

  function escapeHtml(s) {
    return String(s === null || s === undefined ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  /* ---------- clock ---------- */
  function makeClockFormatter() {
    var zones = ["Europe/Kyiv", "Europe/Kiev"];
    for (var i = 0; i < zones.length; i++) {
      try {
        return new Intl.DateTimeFormat("uk-UA", { timeZone: zones[i], hour: "2-digit", minute: "2-digit" });
      } catch (e) { /* try next */ }
    }
    return null;
  }

  function updateClock() {
    if (!clockBadge) return;
    if (clockFormatter) {
      try { clockBadge.textContent = clockFormatter.format(new Date()) + " (Київ)"; return; } catch (e) { /* fall through */ }
    }
    if (currentHub && currentHub.kyivTime) clockBadge.textContent = currentHub.kyivTime + " (Київ)";
  }

  /* ---------- status banner ---------- */
  function showStatus(msg, kind) {
    statusBanner.textContent = msg;
    statusBanner.className = "status-banner " + (kind || "warn");
    statusBanner.style.display = "block";
  }
  function hideStatus() { statusBanner.style.display = "none"; }

  /* ---------- rendering ---------- */
  function minutesHtml(m) {
    if (m <= 0) return "<span class=\"eta-cell\" style=\"color:#3fb950\">0'</span>";
    if (m >= 60) return "<span class=\"eta-cell hours\">" + Math.floor(m / 60) + "h " + (m % 60) + "'</span>";
    return "<span class=\"eta-cell\">" + m + "'</span>";
  }

  function distanceText(item) {
    var d = item.vehicle && typeof item.vehicle.distanceM === "number" ? item.vehicle.distanceM : null;
    if (d === null) return "—";
    return d >= 1000 ? (d / 1000).toFixed(1) + " км" : d + " м";
  }

  function vehicleBar(veh) {
    var v = veh || { boardNumber: "—", licensePlate: "—", model: "—", isLowFloor: false };
    return "<div class=\"vehicle-info-bar\">" +
      "<span class=\"vehicle-board\">№ " + escapeHtml(v.boardNumber) + "</span> | " +
      "<span class=\"vehicle-plate\">" + escapeHtml(v.licensePlate) + "</span> | " +
      "<span class=\"vehicle-model\">" + escapeHtml(v.model) + "</span>" +
      (v.isLowFloor ? " | <span class=\"vehicle-accessibility\" title=\"Низька підлога\">♿</span>" : "") +
      "</div>";
  }

  function timelineHtml(stops) {
    return (stops || []).map(function (st) {
      var dot = "dot-intermediate";
      var nameCls = "name-intermediate";
      if (st.status === "current") { dot = "dot-current"; nameCls = "name-current"; }
      else if (st.status === "destination") { dot = "dot-destination"; nameCls = "name-destination"; }
      return "<div class=\"timeline-stop-row\">" +
        "<div class=\"timeline-bullet-col\"><div class=\"timeline-dot " + dot + "\"></div></div>" +
        "<div class=\"timeline-name-col " + nameCls + " stop-clickable\" data-stop=\"" + escapeHtml(st.name) + "\" title=\"Перейти до табло зупинки: " + escapeHtml(st.name) + "\">" +
          escapeHtml(st.name) + " <span class=\"stop-nav-arrow\">↗</span></div>" +
        "<div class=\"timeline-time-col\">" + escapeHtml(st.time) + "</div>" +
        "</div>";
    }).join("");
  }

  function cardHtml(dir) {
    var deps = dir.departures || [];
    var isExp = !!expanded[dir.key];
    var visible = isExp ? deps : deps.slice(0, 3);
    var typeCls = ROUTE_TYPE_CLASSES[dir.typeKey] || "bus";
    var routeCls = "route-badge" + (typeCls !== "bus" ? " " + typeCls : "");
    var rows = visible.map(function (item) {
      var key = dir.key + "|" + item.tripId + "|" + item.depAbs;
      var open = !!openTrips[key];
      return "<div class=\"departure-item-wrapper\">" +
        "<div class=\"departure-row\" data-trip=\"" + escapeHtml(key) + "\">" +
          "<div class=\"route-cell\"><span class=\"" + routeCls + "\">" + escapeHtml(item.route) + "</span>" +
            "<span class=\"destination-name\">" + escapeHtml(item.destination) + "</span></div>" +
          "<div class=\"distance-cell\" title=\"По прямій від поточної позиції транспорту\">" + escapeHtml(distanceText(item)) + "</div>" +
          "<div class=\"time-cell\"><span class=\"time-scheduled\">" + escapeHtml(item.time) + "</span></div>" +
          minutesHtml(item.remainingMinutes) +
        "</div>" +
        "<div class=\"trip-timeline-panel\" style=\"display:" + (open ? "block" : "none") + ";\">" +
          vehicleBar(item.vehicle) +
          "<div class=\"timeline-track\">" + timelineHtml(item.stops) + "</div>" +
        "</div>" +
      "</div>";
    }).join("");
    return "<div class=\"board-card\">" +
      "<div class=\"card-header\"><span class=\"type-badge " + typeCls + "\">" + escapeHtml(dir.type) + "</span>" +
        "<span class=\"platform-title\">" + escapeHtml(dir.title) + "</span></div>" +
      "<div class=\"table-columns\"><div>МАРШРУТ · НАПРЯМОК</div><div>ВІДСТАНЬ</div><div>ЧАС</div><div>ХВ.</div></div>" +
      "<div class=\"departure-list\">" + (rows || "<div style=\"padding:20px;text-align:center;color:#8b949e;\">Немає рейсів у розкладі</div>") + "</div>" +
      "<div class=\"card-footer\"><button class=\"show-all-btn\" type=\"button\" data-expand=\"" + escapeHtml(dir.key) + "\">" +
        (isExp ? "∧ Згорнути рейси" : "∨ Показати всі рейси (" + deps.length + ")") +
      "</button></div>" +
    "</div>";
  }

  function noticeHtml(text, kind) {
    return "<div class=\"notice-card" + (kind ? " " + kind : "") + "\">" + escapeHtml(text) + "</div>";
  }

  function renderGrid() {
    var hub = currentHub;
    if (!hub) { departureGrid.innerHTML = noticeHtml("⏳ Завантаження розкладу КП «Київпастранс»..."); return; }
    if (hub.unavailable) {
      departureGrid.innerHTML = hub.pending
        ? noticeHtml("⏳ Розклад ще завантажується, зачекайте кілька секунд...")
        : noticeHtml("⚠ Розклад КП «Київпастранс» (GTFS) тимчасово недоступний. Спробуйте оновити сторінку за кілька хвилин.", "error");
      return;
    }
    if (!hub.directions || hub.directions.length === 0) {
      departureGrid.innerHTML = noticeHtml("За офіційним розкладом КП «Київпастранс» на цю зупинку рейсів у найближчі 2 години не знайдено. Спробуйте іншу зупинку через пошук.");
      return;
    }
    departureGrid.innerHTML = hub.directions.map(cardHtml).join("");
  }

  function renderAll() {
    if (currentHub) {
      stationTitle.textContent = currentHub.title || currentStop;
      document.title = (currentHub.title || currentStop) + " | Табло відправлень";
    }
    updateClock();
    syncFav();
    renderGrid();
  }

  /* ---------- favourites ---------- */
  function syncFav() {
    try { favBtn.classList.toggle("active", localStorage.getItem("kpt_fav_" + currentStop) === "1"); } catch (e) { /* storage blocked */ }
  }

  /* ---------- data loading ---------- */
  function scheduleRetry(ms) {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(function () { loadHub(currentStop, true); }, ms);
  }

  function loadHub(key, silent) {
    var seq = ++hubSeq;
    clearTimeout(retryTimer);
    if (hubCtrl) { try { hubCtrl.abort(); } catch (e) { /* ignore */ } }
    var ctrl = new AbortController();
    hubCtrl = ctrl;
    var timedOut = false;
    var timer = setTimeout(function () { timedOut = true; ctrl.abort(); }, HUB_TIMEOUT_MS);
    if (!silent) { refreshBtn.disabled = true; refreshBtn.textContent = "⟳ Оновлення..."; }

    return fetch("/api/hub?stop=" + encodeURIComponent(key), { signal: ctrl.signal, headers: { "Accept": "application/json" } })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (hub) {
        if (seq !== hubSeq) return;
        currentHub = hub;
        if (hub.pending) {
          showStatus("Розклад ще завантажується, повторюю спробу...", "warn");
          scheduleRetry(3000);
        } else if (hub.stale) {
          showStatus("Розклад може бути неактуальним: свіжу версію GTFS отримати не вдалося.", "warn");
        } else {
          hideStatus();
        }
        renderAll();
      })
      .catch(function (err) {
        if (seq !== hubSeq) return;
        showStatus(timedOut ? "Сервер не відповів вчасно. Показано останні відомі дані." : "Не вдалося оновити дані (" + ((err && err.message) || "помилка мережі") + ").", "error");
        if (!currentHub) renderGrid();
      })
      .then(function () {
        clearTimeout(timer);
        if (seq === hubSeq) { refreshBtn.disabled = false; refreshBtn.textContent = "⟳ Оновити табло"; }
      });
  }

  function selectStop(key, opts) {
    opts = opts || {};
    key = String(key || "").trim();
    if (!key) return;
    currentStop = key;
    var wanted = "?stop=" + encodeURIComponent(key);
    if (!opts.noHistory && window.location.search !== wanted) {
      try { window.history.pushState({ stop: key }, "", window.location.pathname + wanted); } catch (e) { /* ignore */ }
    }
    syncFav();
    loadHub(key, false);
  }

  /* ---------- search ---------- */
  function searchItemHtml(key, label, badge) {
    return "<div class=\"search-item\" data-key=\"" + escapeHtml(key) + "\"><span>" + label + "</span>" +
      "<span class=\"search-item-badge\">" + escapeHtml(badge) + "</span></div>";
  }

  function runSearch(val) {
    var seq = ++searchSeq;
    if (searchCtrl) { try { searchCtrl.abort(); } catch (e) { /* ignore */ } }
    var ctrl = new AbortController();
    searchCtrl = ctrl;
    var timer = setTimeout(function () { ctrl.abort(); }, SEARCH_TIMEOUT_MS);
    fetch("/api/search?q=" + encodeURIComponent(val), { signal: ctrl.signal })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        if (seq !== searchSeq) return;
        if (data.results && data.results.length > 0) {
          searchDropdown.innerHTML = data.results.map(function (s) {
            return searchItemHtml(s.name || val, escapeHtml(s.name || val), s.modes || "Київ");
          }).join("");
        } else if (data.unavailable) {
          searchDropdown.innerHTML = searchItemHtml(val, "⚠ Сервіс розкладу тимчасово недоступний", "Відкрити «" + val + "» ↗");
        } else {
          searchDropdown.innerHTML = searchItemHtml(val, "Нічого не знайдено: <b>" + escapeHtml(val) + "</b>", "Все одно відкрити табло ↗");
        }
        searchDropdown.style.display = "block";
      })
      .catch(function () {
        if (seq !== searchSeq) return;
        searchDropdown.innerHTML = searchItemHtml(val, "⚠ Сервіс розкладу тимчасово недоступний", "Відкрити «" + val + "» ↗");
        searchDropdown.style.display = "block";
      })
      .then(function () { clearTimeout(timer); });
  }

  searchInput.addEventListener("input", function () {
    clearTimeout(searchDebounce);
    var val = searchInput.value.trim();
    if (!val) { searchSeq++; searchDropdown.style.display = "none"; return; }
    searchDropdown.innerHTML = "<div class=\"search-item search-item-muted\"><span>⏳ Пошук зупинок у реєстрі КП «Київпастранс»...</span></div>";
    searchDropdown.style.display = "block";
    searchDebounce = setTimeout(function () { runSearch(val); }, 200);
  });

  searchDropdown.addEventListener("click", function (e) {
    var item = e.target.closest(".search-item");
    if (item && item.getAttribute("data-key")) {
      selectStop(item.getAttribute("data-key"));
      searchDropdown.style.display = "none";
      searchInput.value = "";
    }
  });

  searchInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && searchInput.value.trim()) {
      selectStop(searchInput.value.trim());
      searchDropdown.style.display = "none";
    } else if (e.key === "Escape") {
      searchDropdown.style.display = "none";
    }
  });

  document.addEventListener("click", function (e) {
    if (!e.target.closest(".search-bar-wrapper")) searchDropdown.style.display = "none";
  });

  /* ---------- board interactions (event delegation) ---------- */
  departureGrid.addEventListener("click", function (e) {
    var stopEl = e.target.closest("[data-stop]");
    if (stopEl) {
      selectStop(stopEl.getAttribute("data-stop"));
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    var expEl = e.target.closest("[data-expand]");
    if (expEl) {
      var dirKey = expEl.getAttribute("data-expand");
      expanded[dirKey] = !expanded[dirKey];
      renderGrid();
      return;
    }
    var tripEl = e.target.closest("[data-trip]");
    if (tripEl) {
      var panel = tripEl.nextElementSibling;
      if (!panel) return;
      var key = tripEl.getAttribute("data-trip");
      var open = panel.style.display === "none";
      panel.style.display = open ? "block" : "none";
      if (open) openTrips[key] = true; else delete openTrips[key];
    }
  });

  refreshBtn.addEventListener("click", function () { loadHub(currentStop, false); });
  favBtn.addEventListener("click", function () {
    var active = favBtn.classList.toggle("active");
    try { localStorage.setItem("kpt_fav_" + currentStop, active ? "1" : "0"); } catch (e) { /* storage blocked */ }
  });
  window.addEventListener("popstate", function () {
    var p = new URLSearchParams(window.location.search);
    selectStop(p.get("stop") || BOOT.defaultStop, { noHistory: true });
  });

  /* ---------- boot ---------- */
  clockFormatter = makeClockFormatter();
  setInterval(updateClock, 10000);

  setInterval(function () {
    if (!document.hidden) loadHub(currentStop, true);
  }, BOOT.refreshSec * 1000);
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) loadHub(currentStop, true);
  });

  if (currentHub && !currentHub.pending) {
    if (currentHub.stale) showStatus("Розклад може бути неактуальним: свіжу версію GTFS отримати не вдалося.", "warn");
    renderAll();
  } else {
    renderGrid();
    loadHub(currentStop, false);
  }
})();
`;

/**
 * Page shell. `hubData` may be null (SSR budget exceeded) — the client then loads /api/hub itself.
 */
function renderFullPageHtml(hubData, stopQuery) {
  const title = hubData ? hubData.title : "Київ, " + stopQuery;
  const kyivTime = hubData ? hubData.kyivTime : kyivTimeString();
  const boot = {
    hub: hubData || null,
    stop: (hubData && hubData.stopName) || stopQuery, // never the slug/hubKey: it is not a valid query
    defaultStop: CONFIG.DEFAULT_STOP,
    refreshSec: CONFIG.PAGE_REFRESH_SEC
  };
  const script = CLIENT_JS.replace("__BOOT__", () => jsonForScript(boot));

  return '<!DOCTYPE html>' +
'<html lang="uk">' +
'<head>' +
  '<meta charset="UTF-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
  '<title>' + escapeHtml(title) + ' | Табло відправлень</title>' +
  '<style>' + PAGE_CSS + EXTRA_CSS + '</style>' +
'</head>' +
'<body>' +
  '<div class="container">' +
    '<div class="top-header">' +
      '<div class="station-title" id="stationTitle">' + escapeHtml(title) + '</div>' +
      '<div class="header-actions">' +
        '<div class="clock-badge" id="clockBadge">' + escapeHtml(kyivTime) + ' (Київ)</div>' +
        '<button class="btn-icon btn-search" id="refreshBtn" type="button">⟳ Оновити табло</button>' +
        '<button class="btn-icon btn-fav" id="favBtn" type="button" title="Додати в обране">★</button>' +
      '</div>' +
    '</div>' +
    '<div class="status-banner" id="statusBanner" role="status" style="display:none;"></div>' +
    '<div class="search-bar-wrapper">' +
      '<input type="text" id="stopSearchInput" class="search-input" placeholder="🔍 Назва зупинки КП «Київпастранс» (напр. Позняки, Хрещатик, Контрактова площа, вул. Скляренка)..." autocomplete="off" />' +
      '<div id="searchResults" class="search-dropdown" style="display:none;"></div>' +
    '</div>' +
    '<div class="departure-grid" id="departureGrid"></div>' +
  '</div>' +
  '<script>' + script + '</script>' +
'</body>' +
'</html>';
}

/* ============================================================
 * Cloudflare Worker Export (Fetch + Scheduled Handlers)
 * ============================================================ */

export default {
  // Cron: refresh the GTFS index nightly so the first morning request is instant
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshGtfsIndex(true));
  },

  async fetch(request, env, ctx) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS, POST",
      "Access-Control-Allow-Headers": "Content-Type, x-admin-token",
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    };
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: corsHeaders });

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      const url = new URL(request.url);
      const { pathname, searchParams } = url;
      const isAdmin = () => !!(env && env.ADMIN_TOKEN) && safeEqual(request.headers.get("x-admin-token") || "", String(env.ADMIN_TOKEN));

      // 1. Root route: page shell (+ embedded hub when it is ready within the SSR budget)
      if (pathname === "/" || pathname === "/index.html") {
        const stopQuery = (searchParams.get("stop") || "").trim() || CONFIG.DEFAULT_STOP;
        const hubPromise = waitUntil(ctx, resolveHubDepartures(stopQuery, ctx, env));
        const hubData = await withDeadline(hubPromise, CONFIG.SSR_BUDGET_MS, null);
        return new Response(renderFullPageHtml(hubData, stopQuery), {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff"
          }
        });
      }

      // 2. Departure board API
      if (pathname === "/api/hub") {
        const stopQuery = (searchParams.get("stop") || "").trim() || CONFIG.DEFAULT_STOP;
        const hubPromise = waitUntil(ctx, resolveHubDepartures(stopQuery, ctx, env));
        const hubData = await withDeadline(hubPromise, CONFIG.API_HUB_BUDGET_MS, null);
        if (!hubData) {
          return json({
            hubKey: stopQuery.toLowerCase().replace(/\s+/g, "-"),
            title: "Київ, " + stopQuery,
            kyivTime: kyivTimeString(),
            directions: [],
            unavailable: true,
            pending: true
          });
        }
        return json(hubData);
      }

      // 3. Stop search API
      if (pathname === "/api/search") {
        return json(await searchStops(searchParams.get("q") || "", ctx, env));
      }

      // 4. Live fleet API (GTFS-RT positions)
      if (pathname === "/api/live") {
        const vehicles = await loadRealtime();
        return json({ vehicles, timestamp: new Date().toISOString() });
      }

      // 5. Source reachability probe (admin only — makes ~28 outbound requests)
      if (pathname === "/api/debug-sources") {
        if (!isAdmin()) return json({ error: "invalid admin token" }, 403);
        return json(await probeSources());
      }

      // 6. Admin import: receive a prebuilt GTFS index (build-index.mjs) and make it the live index.
      if (pathname === "/api/admin/import-index" && request.method === "POST") {
        if (!env || !env.ADMIN_TOKEN) return json({ error: "ADMIN_TOKEN secret is not configured" }, 503);
        if (!isAdmin()) return json({ error: "invalid admin token" }, 403);
        let data;
        try {
          data = JSON.parse(await request.text());
        } catch {
          return json({ error: "body is not valid JSON" }, 400);
        }
        if (!indexLooksValid(data)) {
          return json({ error: "payload does not look like a GTFS index" }, 400);
        }
        data.fetchedAtMs = Date.now();
        data.importedVia = "admin";
        delete data.stale;
        setGtfsMemo(data);
        await storeEnvelope(data);
        return json({
          imported: true,
          version: data.version || "",
          stops: data.stops.length,
          trips: Object.keys(data.trips).length,
          departures: Object.values(data.sched).reduce((a, r) => a + r.length, 0)
        });
      }

      return json({ error: "Endpoint not found" }, 404);
    } catch (err) {
      console.error("unhandled error:", (err && err.stack) || err);
      return json({ error: true, message: (err && err.message) ? err.message : String(err) }, 500);
    }
  }
};
