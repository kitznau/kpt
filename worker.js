/**
 * Cloudflare Worker: Kyiv Public Transit Live Departure Monitor (KPT Abfahrtsmonitor)
 *
 * DATA ENGINE: Official Kyiv City Open Data (Департамент транспортної інфраструктури КМДА)
 * — overpass / OSM is no longer used.
 *
 * Educational Architecture Overview:
 * 1. GTFS Static (КП «Київпастранс», updated daily):
 *    https://193.23.225.211:8002/export-gtfs-static (ZIP)
 *    - stops.txt   → 1738 stops with names + coordinates (stop_id prefix: 1=tram, 2=trolleybus, 3=bus)
 *    - routes.txt  → 192 routes (route_type: 0=tram, 11=trolleybus, 3=bus)
 *    - trips.txt   → 27 424 trips (route, service day)
 *    - stop_times  → 115 271 schedule rows → real departures per stop
 *    Parsed on demand via DecompressionStream, cached at the edge (6h) and refreshed by cron.
 * 2. GTFS Realtime vehicle feed (АСКДУ КП «Київпастранс»):
 *    http://193.23.225.214:732/api/realtime (protobuf, refreshed every 30s)
 *    - live vehicles: route id, board number, position → real fleet shown on the board.
 * 3. Vehicle registry (open data, monthly):
 *    - brand/model/low-floor/accessibility per vehicle, joined by board number digits.
 * 4. High-Performance Edge Caching (caches.default):
 *    - GTFS index: 6h | vehicle registry: 24h | realtime: 30s | rendered hub: 60s.
 * 5. Interactive Transit Graph:
 *    - Search queries the official stop registry; every timeline stop is clickable (↗).
 */

const CONFIG = {
  TIMEZONE: "Europe/Kyiv",
  DEFAULT_STOP: "Позняки",

  GTFS_STATIC_URL: "http://193.23.225.211:8002/export-gtfs-static",
  REALTIME_URL: "http://193.23.225.214:732/api/realtime",
  VEHICLES_URL:
    "https://data.kyivcity.gov.ua/dataset/vidomosti-pro-transportni-zasoby-iaki-obsluhovuiut-pasazhyrski-avtobusni-troleibusni-t-dep-transport/resource/efad1f37-779d-4d8e-9d1e-3a6b345775d6/data/download",
  MAYNO_STOPS_URL:
    "https://data.kyivcity.gov.ua/dataset/dani-pro-mistse-rozmishchennia-zupynok-miskoho-elektrychnoho-ta-avtomobilnoho-transpor-dep-transport/resource/269ffb2e-dac0-4978-9552-10d29a30724b/data/download",

  GTFS_INDEX_TTL_SEC: 6 * 3600,   // schedule is refreshed daily by the city — 6h edge cache
  VEHICLES_TTL_SEC: 24 * 3600,    // vehicle registry updates monthly
  MAYNO_TTL_SEC: 24 * 3600,       // official stop registry (ІАС «Майно»)
  REALTIME_TTL_SEC: 30,           // GTFS-RT feed refresh
  HUB_TTL_SEC: 60,                // rendered departure board

  NEARBY_STOP_RADIUS_M: 250,      // Mayno point → nearby GTFS control points

  MAX_DEPARTURES_PER_CARD: 10,
  TIMELINE_STOPS_LIMIT: 8,

  USER_AGENT: "KPT-Departure-Monitor/3.0 (Kyiv City Open Data Engine)",

  // The municipal feeds (193.23.225.x) answer 403 to requests coming from
  // cloud-provider IPs (incl. Cloudflare egress) while serving residential
  // IPs normally. These public CORS relays are used ONLY as fallback paths
  // and for the /api/debug-sources probe — the URLs themselves are the same
  // official feeds, just relayed.
  RELAY_URLS: [
    "https://api.allorigins.win/raw?url=",
    "https://api.codetabs.com/v1/proxy?quest="
  ],
  BROWSER_UA: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  PORTAL_REFERER: "https://data.kyivcity.gov.ua/"
};

/* ============================================================
 * SOURCE PROBE — used by /api/debug-sources to find a fetch path
 * that works from the edge (direct vs browser-UA vs relay).
 * ============================================================ */

const FETCH_VARIANTS = [
  { id: "direct", make: url => ({ url, headers: { "User-Agent": CONFIG.USER_AGENT } }) },
  { id: "browser-ua", make: url => ({ url, headers: { "User-Agent": CONFIG.BROWSER_UA } }) },
  { id: "browser-ua+referer", make: url => ({ url: url, headers: { "User-Agent": CONFIG.BROWSER_UA, "Referer": CONFIG.PORTAL_REFERER } }) },
  ...CONFIG.RELAY_URLS.map((relay, i) => ({
    id: "relay" + (i + 1),
    make: url => ({ url: relay + encodeURIComponent(url), headers: { "User-Agent": CONFIG.USER_AGENT } })
  }))
];

async function probeVariant(url, variant) {
  const started = Date.now();
  try {
    const opts = variant.make(url);
    const res = await fetch(opts.url, { headers: opts.headers, signal: AbortSignal.timeout(20000) });
    let bytes = 0;
    try { const ab = await res.arrayBuffer(); bytes = ab.byteLength; } catch (_) {}
    return {
      variant: variant.id,
      status: res.status,
      contentType: res.headers.get("content-type") || "",
      bytes,
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
  return { probedAt: new Date().toISOString(), results };
}

/* ============================================================
 * TIME HELPERS (Europe/Kyiv — computed arithmetically)
 * IMPORTANT: workerd's ICU may not resolve the "Europe/Kyiv" timeZone
 * (modern spelling; older data has "Europe/Kiev") and silently falls
 * back to UTC. Never use toLocaleString for Kyiv conversion here —
 * compute EET (UTC+2) / EEST (UTC+3) manually instead.
 * ============================================================ */

/** Last Sunday of a month (monthIdx 0-based) as a UTC Date at 00:00 UTC. */
function lastSundayOf(y, monthIdx) {
  const last = new Date(Date.UTC(y, monthIdx + 1, 0)); // last day of that month
  return new Date(Date.UTC(y, monthIdx + 1, 0 - last.getUTCDay()));
}

/** Kyiv offset vs UTC in seconds: EEST (UTC+3) from last Sun of Mar 01:00 UTC
 *  to last Sun of Oct 01:00 UTC, otherwise EET (UTC+2). */
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
    dayIdx: shifted.getUTCDay()
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

/** Returns {dateStr: "YYYYMMDD", dayIdx: 0..6 (sunday=0)} for the current Kyiv service day. */
function getKyivServiceDay(offsetDays = 0) {
  const p = kyivParts(offsetDays);
  return { dateStr: p.dateStr, dayIdx: p.dayIdx };
}

/** Formats seconds-after-midnight (may exceed 24h) into HH:MM (24h wrap). */
function formatGtfsTime(sec) {
  const h = Math.floor(sec / 3600) % 24;
  const m = Math.floor((sec % 3600) / 60);
  return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
}

/* ============================================================
 * ZIP + CSV + PROTOBUF PARSING (validated against real feeds)
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

/** RFC-4180-ish CSV parser (handles quoted fields with embedded commas/quotes).
 *  Streams rows into objects one by one — never retains the raw row matrix,
 *  which matters on the 115k-row stop_times table (isolate memory limit). */
function csvObjects(text) {
  const results = [];
  let i = 0, field = "", row = [], inQ = false;
  // Strip BOM if present
  if (text.charCodeAt(0) === 0xFEFF) i = 1;

  let header = null;
  const flushRow = () => {
    row.push(field);
    field = "";
    if (header === null) {
      header = row.map(h => h.trim());
    } else if (row.length >= header.length && row.some(c => c !== "")) {
      const o = {};
      header.forEach((h, idx) => o[h] = (row[idx] || "").trim());
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

/** Generic protobuf walker: calls cb(fieldNumber, wireType, value) for every field. */
function pbWalk(u8, cb) {
  const td = new TextDecoder();
  let i = 0;
  while (i < u8.length) {
    let key = 0, shift = 0, b;
    do { b = u8[i++]; key |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
    const field = key >>> 3, wire = key & 7;
    if (wire === 0) {
      let v = 0, sh = 0;
      do { b = u8[i++]; v |= (b & 0x7f) << sh; sh += 7; } while (b & 0x80);
      cb(field, "varint", v);
    } else if (wire === 1) {
      cb(field, "fixed64", u8.subarray(i, i + 8)); i += 8;
    } else if (wire === 2) {
      let v = 0, sh = 0;
      do { b = u8[i++]; v |= (b & 0x7f) << sh; sh += 7; } while (b & 0x80);
      cb(field, "bytes", u8.subarray(i, i + v)); i += v;
    } else if (wire === 5) {
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
      if (f2 !== 4 || t2 !== "bytes") return; // FeedEntity.vehicle (VehiclePosition)
      const veh = {};
      pbWalk(v2, (f3, t3, v3) => {
        if (f3 === 1 && t3 === "bytes") { // TripDescriptor
          pbWalk(v3, (f4, t4, v4) => {
            if (f4 === 1 && t4 === "bytes") veh.tripId = td.decode(v4);
            if (f4 === 5 && t4 === "bytes") veh.routeId = td.decode(v4);
            if (f4 === 6 && t4 === "varint") veh.directionId = v4;
          });
        } else if (f3 === 2 && t3 === "bytes") { // Position
          pbWalk(v3, (f4, t4, v4) => {
            if (f4 === 1 && t4 === "fixed32") veh.lat = pbF32(v4);
            if (f4 === 2 && t4 === "fixed32") veh.lon = pbF32(v4);
            if (f4 === 3 && t4 === "fixed32") veh.bearing = pbF32(v4);
            if (f4 === 4 && t4 === "fixed32") veh.speed = pbF32(v4);
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
 * EDGE-CACHED DATA LOADERS
 * ============================================================ */

const cacheStore = (typeof caches !== "undefined") ? caches.default : null;

async function cachedJson(key, ttlSec, builder) {
  const cacheKey = new Request(key);
  if (cacheStore) {
    try {
      const hit = await cacheStore.match(cacheKey);
      if (hit) return await hit.json();
    } catch (_) {}
  }
  const data = await builder();
  if (cacheStore && data) {
    try {
      await cacheStore.put(cacheKey, new Response(JSON.stringify(data), {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "public, max-age=" + ttlSec
        }
      }));
    } catch (_) {}
  }
  return data;
}

/**
 * Builds the compact GTFS schedule index from the official ZIP export.
 *
 * The municipal origin (193.23.225.211:8002) answers 403 to datacenter
 * egress IPs — including every Cloudflare worker — so on production the
 * direct fetch is attempted first (works in `wrangler dev` and from any
 * residential network) and public relays of the SAME official URL are
 * tried next. The resulting index is cached and served stale when every
 * path fails, so one successful build keeps the board alive for days.
 *
 * Index shape (kept compact on purpose — the raw feed is ~10 MB decompressed):
 *   stops:     [[stopId, name, lat, lon], ...]
 *   routes:    { routeId: {n: shortName, t: routeType, l: longName} }
 *   trips:     { tripId: {r: routeId, s: serviceId} }
 *   dest:      { tripId: lastStopId }               — trip destination
 *   sched:     { stopId: [[depSec, tripId], ...] }  — all departures per stop
 *   tripStops: { tripId: [[stopId, depSec], ...] }  — ordered stop sequence per trip
 *   calendar:  { serviceId: {s, e, d: "0111100"} } — d = mon..sun flags
 *   calDates:  { add: {date: [serviceId]}, rem: {date: [serviceId]} }
 */
const GTFS_FETCH_VARIANTS = [
  FETCH_VARIANTS[0], // direct
  ...CONFIG.RELAY_URLS.map((relay, i) => ({
    id: "relay" + (i + 1),
    make: url => ({ url: relay + encodeURIComponent(url), headers: { "User-Agent": CONFIG.USER_AGENT } })
  }))
];

const REALTIME_FETCH_VARIANTS = GTFS_FETCH_VARIANTS.map(v => ({
  id: v.id,
  make: v.make,
  timeoutMs: v.id === "direct" ? 8000 : 12000
}));

/** Tries each fetch variant until one returns enough bytes; null when all fail. */
async function fetchBytesWithFallback(url, variants, minBytes) {
  for (const v of variants) {
    try {
      const opts = v.make(url);
      const res = await fetch(opts.url, {
        headers: opts.headers,
        signal: AbortSignal.timeout(v.timeoutMs || 30000)
      });
      if (!res.ok) { console.error("fetch variant", v.id, "HTTP", res.status, url); continue; }
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length < minBytes) { console.error("fetch variant", v.id, "too small:", buf.length); continue; }
      return { buf, variantId: v.id };
    } catch (err) {
      console.error("fetch variant", v.id, "failed:", (err && err.message) || err);
    }
  }
  return null;
}

async function buildGtfsIndex() {
  const fetched = await fetchBytesWithFallback(CONFIG.GTFS_STATIC_URL, GTFS_FETCH_VARIANTS, 200000);
  if (!fetched) throw new Error("GTFS static unreachable from all fetch paths (origin 403s datacenter IPs; relays down)");
  const buf = fetched.buf;
  const entries = readZipEntries(buf);
  if (!entries["stops.txt"] || !entries["stop_times.txt"]) throw new Error("GTFS ZIP: required members missing via " + fetched.variantId);

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
  csvObjects(tripsTxt).forEach(t => {
    trips[t.trip_id] = { r: t.route_id, s: t.service_id };
  });

  const dest = {};
  const sched = {};
  const tripStops = {};
  csvObjects(stopTimesTxt).forEach(st => {
    const parts = st.departure_time.split(":").map(Number);
    if (parts.length !== 3 || Number.isNaN(parts[0])) return;
    const dep = parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (!sched[st.stop_id]) sched[st.stop_id] = [];
    sched[st.stop_id].push([dep, st.trip_id]);
    if (!tripStops[st.trip_id]) tripStops[st.trip_id] = [];
    tripStops[st.trip_id].push([st.stop_id, dep]);
    dest[st.trip_id] = st.stop_id; // rows come in stop_sequence order — last wins
  });

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
  csvObjects(feedInfoTxt).forEach(fi => version = fi.feed_version || version);

  return { version, stops, routes, trips, dest, sched, tripStops, calendar, calDates };
}

let gtfsMemo = null;

const GTFS_CACHE_KEY = "https://kpt-cache.internal/gtfs-index-envelope-v4";

/**
 * Loads the GTFS index with serve-stale self-healing:
 * module memo → edge cache (envelope with fetchedAt) → fresh build.
 * A failed rebuild falls back to the previously cached index (stale flag),
 * so a single successful build keeps the board alive across outages.
 */
async function loadGtfsIndex(ctx = null, force = false) {
  if (!force && gtfsMemo) return gtfsMemo;

  let envelope = null;
  if (cacheStore) {
    try {
      const hit = await cacheStore.match(new Request(GTFS_CACHE_KEY));
      if (hit) envelope = await hit.json();
    } catch (_) {}
  }

  const FRESH_MS = CONFIG.GTFS_INDEX_TTL_SEC * 1000;
  if (envelope && envelope.data && (Date.now() - envelope.fetchedAt) < FRESH_MS) {
    gtfsMemo = envelope.data;
    return gtfsMemo;
  }

  try {
    const data = await buildGtfsIndex();
    data.fetchedAtMs = Date.now();
    gtfsMemo = data;
    if (cacheStore) {
      try {
        await cacheStore.put(new Request(GTFS_CACHE_KEY), new Response(JSON.stringify({
          data, fetchedAt: Date.now()
        }), {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "public, max-age=" + 7 * 24 * 3600
          }
        }));
      } catch (_) {}
    }
    return data;
  } catch (err) {
    console.error("GTFS index rebuild failed:", (err && err.message) || err);
    if (envelope && envelope.data) {
      envelope.data.stale = true;
      gtfsMemo = envelope.data;
      return gtfsMemo;
    }
    return null;
  }
}

/** Vehicle registry (open data): { "4-digit board no.": {model, lowFloor} } */
async function buildVehicleIndex() {
  const res = await fetch(CONFIG.VEHICLES_URL, { headers: { "User-Agent": CONFIG.USER_AGENT } });
  if (!res.ok) throw new Error("Vehicle registry download failed: HTTP " + res.status);
  const list = await res.json();
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

async function loadVehicleIndex(ctx = null) {
  return cachedJson("https://kpt-cache.internal/vehicle-registry", CONFIG.VEHICLES_TTL_SEC, buildVehicleIndex);
}

/**
 * Official stop registry (ІАС «Майно», includes metro, funicular and city express points
 * that are missing from the Kyivpastrans GTFS control points).
 * Shape: [[label, lat, lon], ...]
 */
async function buildMaynoStops() {
  const res = await fetch(CONFIG.MAYNO_STOPS_URL, { headers: { "User-Agent": CONFIG.USER_AGENT } });
  if (!res.ok) throw new Error("Mayno stop registry download failed: HTTP " + res.status);
  const list = await res.json();
  if (!Array.isArray(list)) return [];
  return list
    .filter(s => s && s.label && typeof s.lat === "number" && typeof s.lon === "number")
    .map(s => [s.label, s.lat, s.lon]);
}

async function loadMaynoStops(ctx = null) {
  return cachedJson("https://kpt-cache.internal/mayno-stops", CONFIG.MAYNO_TTL_SEC, buildMaynoStops);
}

let rtMemo = null, rtMemoUntil = 0;

/**
 * Live vehicles from the GTFS-RT feed (30s in-isolate memo).
 * The origin 403s datacenter IPs, so on the edge this relies on the
 * relay fallbacks; on total failure the board degrades to
 * schedule-only mode (honest, never crashes).
 */
async function loadRealtime(ctx = null) {
  const nowMs = Date.now();
  if (rtMemo && nowMs < rtMemoUntil) return rtMemo;
  try {
    const fetched = await fetchBytesWithFallback(CONFIG.REALTIME_URL, REALTIME_FETCH_VARIANTS, 20);
    if (!fetched) throw new Error("realtime unreachable from all paths");
    const vehicles = parseRealtimeFeed(fetched.buf);
    rtMemo = vehicles;
    rtMemoUntil = nowMs + CONFIG.REALTIME_TTL_SEC * 1000;
    return vehicles;
  } catch (_) {
    rtMemo = [];
    rtMemoUntil = nowMs + 10 * 1000;
    return rtMemo;
  }
}

/** Active GTFS service ids for the current Kyiv service day (calendar + exceptions). */
function activeServiceIds(index) {
  const today = getKyivServiceDay();
  const set = new Set();
  Object.entries(index.calendar).forEach(([sid, c]) => {
    if (today.dateStr >= c.s && today.dateStr <= c.e && c.d[today.dayIdx] === "1") set.add(sid);
  });
  const add = index.calDates.add[today.dateStr];
  if (add) add.forEach(sid => set.add(sid));
  const rem = index.calDates.rem[today.dateStr];
  if (rem) rem.forEach(sid => set.delete(sid));
  return set;
}

const ROUTE_TYPE_LABELS = { 0: "ТРАМ", 11: "ТРОЛ", 3: "АВТ", 1: "МЕТРО", 2: "ПОЇЗД" };
const ROUTE_TYPE_CLASSES = { 0: "tram", 11: "trolley", 3: "bus", 1: "metro", 2: "train" };
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
 * Resolves a free-text query into a hub target:
 * 1. exact/substring name match in the GTFS control points (all stops with that name),
 * 2. otherwise — official registry (ІАС «Майно») point → all GTFS stops within 250 m,
 *    so a metro vestibule or "вул. Хрещатик" resolves to the real nearby platforms.
 * Returns { title, stopIds } or null.
 */
async function resolveTargetStops(index, query) {
  const q = normalizeName(query);
  if (!q) return null;

  // 1. GTFS name match — group stops by exact name, pick the busiest name
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

  // 2. Mayno registry match → nearby GTFS control points (two-step radius:
  //    tight 250 m first; Khreshchatyk-type pedestrian zones need the 500 m fallback)
  const mayno = await loadMaynoStops().catch(() => []);
  const maynoMatch = mayno.find(m => normalizeName(m[0]) === q)
    || mayno.find(m => normalizeName(m[0]).includes(q));
  if (maynoMatch) {
    for (const radius of [250, 500]) {
      const nearby = index.stops
        .filter(s => s[2] && s[3] && distanceMeters(maynoMatch[1], maynoMatch[2], s[2], s[3]) <= radius);
      if (nearby.length > 0) {
        return { title: maynoMatch[0], stopIds: nearby.map(s => s[0]) };
      }
    }
  }

  return null;
}

async function resolveHubDepartures(query, ctx = null) {
  const hubKey = (query || CONFIG.DEFAULT_STOP).trim();
  const kyivTimeStr = kyivTimeString();
  const cacheKey = new Request("https://kpt-cache.internal/api/hub/v5/" + encodeURIComponent(normalizeName(hubKey)));

  async function buildHub() {
      const index = await loadGtfsIndex(ctx);
      if (!index) {
        return {
          hubKey: hubKey.toLowerCase().replace(/\s+/g, "-"),
          title: "Київ, " + hubKey,
          kyivTime: kyivTimeStr,
          directions: [],
          unavailable: true
        };
      }

      const target = await resolveTargetStops(index, hubKey || CONFIG.DEFAULT_STOP);
      if (!target) {
        return {
          hubKey: hubKey.toLowerCase().replace(/\s+/g, "-"),
          title: "Київ, " + hubKey,
          kyivTime: kyivTimeStr,
          directions: []
        };
      }

      const stopNameById = {};
      index.stops.forEach(s => stopNameById[s[0]] = s[1]);

      const services = activeServiceIds(index);
      const nowSec = getKyivSecondsOfDay();

      // Live fleet grouped by route (realtime feed)
      const rtVehicles = await loadRealtime(ctx);
      const rtByRoute = {};
      rtVehicles.forEach(v => {
        if (v.routeId) (rtByRoute[v.routeId] ||= []).push(v);
      });
      const vehicleIndex = await loadVehicleIndex(ctx).catch(() => ({}));

      // All upcoming departures across the resolved platforms of this hub.
      // The same trip stopping at two nearby platforms counts once (earliest departure).
      const upcoming = [];
      const seenTrips = new Set();
      for (const stopId of target.stopIds) {
        for (const pair of (index.sched[stopId] || [])) {
          const dep = pair[0], tripId = pair[1];
          if (seenTrips.has(tripId)) continue;
          const trip = index.trips[tripId];
          if (!trip || !services.has(trip.s)) continue;
          if (dep < nowSec - 60 || dep > nowSec + 2 * 3600 + 1800) continue;
          seenTrips.add(tripId);
          upcoming.push({ dep, tripId, trip, originStopId: stopId });
        }
      }
      upcoming.sort((a, b) => a.dep - b.dep);

      // Group into platform cards: route + destination direction
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
            title: "ПЛАТФОРМА · " + type + " (НАПРЯМОК: " + destName.toUpperCase() + ")",
            type: type,
            typeKey: route.t,
            departures: []
          };
        }

        // Live vehicle on this route → real municipal vehicle line
        let vehicle = null;
        const live = (rtByRoute[d.trip.r] || [])[0];
        if (live) {
          const plateDigits = String(live.licensePlate || "").match(/\d{3,}/);
          const registry = plateDigits ? vehicleIndex[plateDigits[0]] : null;
          vehicle = {
            boardNumber: live.licensePlate || live.label || "—",
            licensePlate: live.label && live.label !== live.licensePlate ? live.label : "—",
            model: registry ? registry.model : "—",
            isLowFloor: registry ? !!registry.lowFloor : false
          };
        }

        // Timeline: this platform + next stops of the trip (official stop sequence)
        const seq = index.tripStops[d.tripId] || [];
        const i0 = seq.findIndex(x => x[0] === d.originStopId);
        const tail = seq.slice(Math.max(i0, 0), Math.max(i0, 0) + CONFIG.TIMELINE_STOPS_LIMIT);
        const stopsTimeline = tail.map((entry, i) => ({
          name: stopNameById[entry[0]] || entry[0],
          time: formatGtfsTime(entry[1]),
          delayMin: 0,
          status: i === 0 ? "current" : (i === tail.length - 1 ? "destination" : "intermediate")
        }));

        groups[key].departures.push({
          route: route.n,
          destination: destName,
          time: formatGtfsTime(d.dep),
          delayMin: 0,
          remainingMinutes: Math.max(0, Math.round((d.dep - nowSec) / 60)),
          vehicle: vehicle,
          stops: stopsTimeline
        });
      }

      const directions = Object.values(groups).map(g => {
        g.departures.sort((a, b) => a.remainingMinutes - b.remainingMinutes);
        g.departures = g.departures.slice(0, CONFIG.MAX_DEPARTURES_PER_CARD);
        return g;
      });

      return {
        hubKey: target.stopIds[0],
        title: "Київ, " + target.title,
        stopName: target.title,
        kyivTime: kyivTimeStr,
        directions,
        feedVersion: index.version
      };
    }

  if (cacheStore) {
    try {
      const hit = await cacheStore.match(cacheKey);
      if (hit) {
        const hub = await hit.json();
        hub.kyivTime = kyivTimeStr;
        return hub;
      }
    } catch (_) {}
  }

  const hub = await buildHub();

  // Cache only productive boards — empty hubs stay cheap to rebuild and never mask new data
  if (cacheStore && hub.directions && hub.directions.length > 0) {
    try {
      await cacheStore.put(cacheKey, new Response(JSON.stringify(hub), {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "public, max-age=" + CONFIG.HUB_TTL_SEC
        }
      }));
    } catch (_) {}
  }

  hub.kyivTime = kyivTimeStr;
  return hub;
}

/* ============================================================
 * SEARCH — official stop registry
 * ============================================================ */

async function searchStops(query, ctx = null) {
  const index = await loadGtfsIndex(ctx);
  if (!index) return { results: [], unavailable: true };

  const q = normalizeName(query);
  if (q.length < 2) return { results: [] };

  // 1. GTFS control points (departures available)
  const byName = {};
  for (const s of index.stops) {
    const nameNorm = normalizeName(s[1]);
    if (!nameNorm.includes(q)) continue;
    const mode = STOP_MODE_LABELS[s[0].split("_")[0]] || "ТРАНЗ";
    const entry = byName[s[1]] || (byName[s[1]] = { name: s[1], modeSet: new Set(), source: "gtfs" });
    entry.modeSet.add(mode);
  }

  // 2. Official registry (ІАС «Майно») — metro, funicular, city express and full street names
  const mayno = await loadMaynoStops().catch(() => []);
  const seenNames = new Set(Object.keys(byName).map(n => normalizeName(n)));
  for (const m of mayno) {
    if (!normalizeName(m[0]).includes(q)) continue;
    if (seenNames.has(normalizeName(m[0]))) continue;
    seenNames.add(normalizeName(m[0]));
    byName[m[0]] = { name: m[0], modeSet: new Set([maynoBadge(m[0])]), source: "mayno" };
  }

  const results = Object.values(byName).map(e => ({
    name: e.name,
    modes: [...e.modeSet].join(", ") || "Київ"
  }));

  // Rank: prefix matches first, then alphabetical
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
 * SERVER-SIDE RENDER — departure board UI (unchanged layout)
 * ============================================================ */

function renderDirectionCardsHtml(hubData) {
  if (hubData.unavailable) {
    return "<div style='grid-column: 1 / -1; padding: 40px 20px; text-align: center; color: #f85149; background: #161b22; border: 1px solid #30363d; border-radius: 8px;'>⚠ Розклад КП «Київпастранс» (GTFS) тимчасово недоступний. Спробуйте оновити сторінку за кілька хвилин.</div>";
  }
  if (!hubData.directions || hubData.directions.length === 0) {
    return "<div style='grid-column: 1 / -1; padding: 40px 20px; text-align: center; color: #8b949e; background: #161b22; border: 1px solid #30363d; border-radius: 8px;'>За офіційним розкладом КП «Київпастранс» на цю зупинку рейсів у найближчі 2 години не знайдено. Спробуйте іншу зупинку через пошук.</div>";
  }
  return hubData.directions.map(dir => {
    const departures = dir.departures || [];
    const visibleItems = departures.slice(0, 3);

    const rowsHtml = visibleItems.map((item, idx) => {
      const distMeters = item.remainingMinutes * 380;
      const distText = distMeters > 1000 ? (distMeters / 1000).toFixed(1) + " км" : distMeters + " м";
      const tripId = "trip-" + dir.id + "-" + idx;

      // Municipal vehicle line: "№ 8648 | 131Н | Е249 МАЗ | ♿" — real data or honest dashes
      const veh = item.vehicle || { boardNumber: "—", licensePlate: "—", model: "—", isLowFloor: false };
      const lowFloorTag = veh.isLowFloor ? ' | <span class="vehicle-accessibility" title="Низька підлога">♿</span>' : '';
      const vehicleInfoBarHtml = '<div class="vehicle-info-bar">' +
        '<span class="vehicle-board">№ ' + veh.boardNumber + '</span> | ' +
        '<span class="vehicle-plate">' + veh.licensePlate + '</span> | ' +
        '<span class="vehicle-model">' + veh.model + '</span>' +
        lowFloorTag +
      '</div>';

      const timelineHtml = (item.stops || []).map(st => {
        let dotClass = "dot-intermediate";
        let textClass = "name-intermediate";
        if (st.status === "current") {
          dotClass = "dot-current";
          textClass = "name-current";
        } else if (st.status === "destination") {
          dotClass = "dot-destination";
          textClass = "name-destination";
        }

        const cleanStopName = st.name.replace(/'/g, "\\'");

        return '<div class="timeline-stop-row">' +
          '<div class="timeline-bullet-col">' +
            '<div class="timeline-dot ' + dotClass + '"></div>' +
          '</div>' +
          '<div class="timeline-name-col ' + textClass + ' stop-clickable" onclick="event.stopPropagation(); selectStopByName(\'' + cleanStopName + '\')" title="Перейти до табло зупинки: ' + st.name + '">' +
            st.name + ' <span class="stop-nav-arrow">↗</span>' +
          '</div>' +
          '<div class="timeline-time-col">' +
            st.time +
          '</div>' +
        '</div>';
      }).join("");

      const typeClass = ROUTE_TYPE_CLASSES[dir.typeKey] || "bus";
      const routeClass = "route-badge " + (typeClass !== "bus" ? typeClass : "");

      return '<div class="departure-item-wrapper">' +
        '<div class="departure-row" onclick="toggleTripDetails(\'' + tripId + '\')">' +
          '<div class="route-cell">' +
            '<span class="' + routeClass + '">' + item.route + '</span>' +
            '<span class="destination-name">' + item.destination + '</span>' +
          '</div>' +
          '<div class="distance-cell">' +
            distText +
          '</div>' +
          '<div class="time-cell">' +
            '<span class="time-scheduled">' + item.time + '</span>' +
          '</div>' +
          formatMinutes(item.remainingMinutes) +
        '</div>' +
        '<div class="trip-timeline-panel" id="' + tripId + '" style="display:none;">' +
          vehicleInfoBarHtml +
          '<div class="timeline-track">' +
            timelineHtml +
          '</div>' +
        '</div>' +
      '</div>';
    }).join("");

    const typeClass = ROUTE_TYPE_CLASSES[dir.typeKey] || "bus";

    return '<div class="board-card">' +
      '<div class="card-header">' +
        '<span class="type-badge ' + typeClass + '">' + dir.type + '</span>' +
        '<span class="platform-title">' + dir.title + '</span>' +
      '</div>' +
      '<div class="table-columns">' +
        '<div>МАРШРУТ · НАПРЯМОК</div>' +
        '<div>ВІДСТАНЬ</div>' +
        '<div>ЧАС</div>' +
        '<div>ХВ.</div>' +
      '</div>' +
      '<div class="departure-list" id="list-' + dir.id + '">' +
        (rowsHtml || "<div style='padding:20px; text-align:center; color:#8b949e;'>Немає рейсів у розкладі</div>") +
      '</div>' +
      '<div class="card-footer">' +
        '<button class="show-all-btn" onclick="toggleExpand(\'' + dir.id + '\')">' +
          "∨ Показати всі рейси (" + departures.length + ")" +
        '</button>' +
      '</div>' +
    '</div>';
  }).join("");
}

function formatMinutes(minutes) {
  if (minutes <= 0) return "<span class='eta-cell' style='color:#3fb950'>0'</span>";
  if (minutes >= 60) {
    const hrs = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return "<span class='eta-cell hours'>" + hrs + "h " + mins + "'</span>";
  }
  return "<span class='eta-cell'>" + minutes + "'</span>";
}

/**
 * Server-Side Render: full page with universal search bar over the official stop registry.
 */
function renderFullPageHtml(hubData) {
  const initialCardsHtml = renderDirectionCardsHtml(hubData);
  // typeKey is needed by the client-side renderer, inject it next to each direction
  const hubPayload = { ...hubData };
  if (hubPayload.directions) {
    hubPayload.directions = hubPayload.directions.map(d => ({ ...d, typeKey: typeKeyOf(d.type) }));
  }

  return '<!DOCTYPE html>' +
'<html lang="uk">' +
'<head>' +
  '<meta charset="UTF-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
  '<title>' + hubData.title + ' | Табло відправлень</title>' +
  '<style>' +
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
  '</style>' +
'</head>' +
'<body>' +
  '<div class="container">' +
    '<div class="top-header">' +
      '<div class="station-title" id="stationTitle">' + hubData.title + '</div>' +
      '<div class="header-actions">' +
        '<div class="clock-badge" id="clockBadge">' + hubData.kyivTime + ' (Київ)</div>' +
        '<button class="btn-icon btn-search" id="refreshBtn">⟳ Оновити табло</button>' +
        '<button class="btn-icon btn-fav" id="favBtn" title="Додати в обране">★</button>' +
      '</div>' +
    '</div>' +
    '<div class="search-bar-wrapper">' +
      '<input type="text" id="stopSearchInput" class="search-input" placeholder="🔍 Назва зупинки КП «Київпастранс» (напр. Позняки, Хрещатик, Контрактова площа, вул. Скляренка)..." autocomplete="off" />' +
      '<div id="searchResults" class="search-dropdown" style="display:none;"></div>' +
    '</div>' +
    '<div class="departure-grid" id="departureGrid">' +
      initialCardsHtml +
    '</div>' +
  '</div>' +
  '<script>' +
    'const stationTitle = document.getElementById("stationTitle");' +
    'const departureGrid = document.getElementById("departureGrid");' +
    'const refreshBtn = document.getElementById("refreshBtn");' +
    'const favBtn = document.getElementById("favBtn");' +
    'const clockBadge = document.getElementById("clockBadge");' +
    'const searchInput = document.getElementById("stopSearchInput");' +
    'const searchDropdown = document.getElementById("searchResults");' +
    'let currentStop = "' + (hubData.stopName || hubData.hubKey).replace(/"/g, '\\"') + '";' +
    'let currentHub = ' + JSON.stringify(hubPayload) + ';' +
    'const expanded = {};' +

    'function updateClock() {' +
      'const now = new Date();' +
      'const timeStr = now.toLocaleTimeString("uk-UA", { timeZone: "Europe/Kyiv", hour: "2-digit", minute: "2-digit" });' +
      'if (clockBadge) clockBadge.textContent = timeStr + " (Київ)";' +
    '}' +
    'setInterval(updateClock, 10000);' +

    'window.toggleTripDetails = function(tripId) {' +
      'const panel = document.getElementById(tripId);' +
      'if (panel) {' +
        'panel.style.display = panel.style.display === "none" ? "block" : "none";' +
      '}' +
    '};' +

    'function formatMinutes(m) {' +
      'if (m <= 0) return "<span class=\\"eta-cell\\" style=\\"color:#3fb950\\">0\'</span>";' +
      'if (m >= 60) {' +
        'const h = Math.floor(m / 60);' +
        'const min = m % 60;' +
        'return "<span class=\\"eta-cell hours\\">" + h + "h " + min + "\'</span>";' +
      '}' +
      'return "<span class=\\"eta-cell\\">" + m + "\'</span>";' +
    '}' +

    'window.toggleExpand = function(dirId) {' +
      'expanded[dirId] = !expanded[dirId];' +
      'if (currentHub) render(currentHub);' +
    '};' +

    'window.selectStopByName = function(stopName) {' +
      'selectStop(stopName);' +
      'window.scrollTo({ top: 0, behavior: "smooth" });' +
    '};' +

    'function escapeHtml(s) {' +
      'return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");' +
    '}' +

    'function render(hub) {' +
      'currentHub = hub;' +
      'stationTitle.textContent = hub.title;' +
      'if (clockBadge && hub.kyivTime) clockBadge.textContent = hub.kyivTime + " (Київ)";' +
      'departureGrid.innerHTML = hub.directions.map(dir => {' +
        'const deps = dir.departures || [];' +
        'const isExp = !!expanded[dir.id];' +
        'const visible = isExp ? deps : deps.slice(0, 3);' +
        'const rows = visible.map((item, idx) => {' +
          'const tripId = "trip-" + dir.id + "-" + idx;' +
          'const veh = item.vehicle || { boardNumber: "—", licensePlate: "—", model: "—", isLowFloor: false };' +
          'const lowFloorTag = veh.isLowFloor ? " | <span class=\\"vehicle-accessibility\\" title=\\"Низька підлога\\">♿</span>" : "";' +
          'const vehBar = "<div class=\\"vehicle-info-bar\\">" +' +
            '"<span class=\\"vehicle-board\\">№ " + escapeHtml(veh.boardNumber) + "</span> | " +' +
            '"<span class=\\"vehicle-plate\\">" + escapeHtml(veh.licensePlate) + "</span> | " +' +
            '"<span class=\\"vehicle-model\\">" + escapeHtml(veh.model) + "</span>" +' +
            'lowFloorTag +' +
          '"</div>";' +
          'const timeline = (item.stops || []).map(st => {' +
            'let dotCls = "dot-intermediate";' +
            'let nameCls = "name-intermediate";' +
            'if (st.status === "current") { dotCls = "dot-current"; nameCls = "name-current"; }' +
            'else if (st.status === "destination") { dotCls = "dot-destination"; nameCls = "name-destination"; }' +
            'const safeName = st.name.replace(/\'/g, "\\\\\'");' +
            'return "<div class=\\"timeline-stop-row\\">" +' +
              '"<div class=\\"timeline-bullet-col\\"><div class=\\"timeline-dot " + dotCls + "\\"></div></div>" +' +
              '"<div class=\\"timeline-name-col " + nameCls + " stop-clickable\\" onclick=\\"event.stopPropagation(); selectStopByName(\\\'" + safeName + "\\\')\\" title=\\"Перейти до зупинки: " + st.name + "\\">" + st.name + " <span class=\\"stop-nav-arrow\\">↗</span></div>" +' +
              '"<div class=\\"timeline-time-col\\">" + st.time + "</div>" +' +
            '"</div>";' +
          '}).join("");' +
          'let routeCls = "route-badge";' +
          'const tc = ROUTE_TYPE_CLASSES[dir.typeKey] || "bus";' +
          'if (tc !== "bus") routeCls = "route-badge " + tc;' +
          'return "<div class=\\"departure-item-wrapper\\">" +' +
            '"<div class=\\"departure-row\\" onclick=\\"toggleTripDetails(\\\'" + tripId + "\\\')\\">" +' +
              '"<div class=\\"route-cell\\">" +' +
                '"<span class=\\"" + routeCls + "\\">" + item.route + "</span>" +' +
                '"<span class=\\"destination-name\\">" + item.destination + "</span>" +' +
              '"</div>" +' +
              '"<div class=\\"distance-cell\\">" + (item.remainingMinutes * 380 > 1000 ? ((item.remainingMinutes * 380)/1000).toFixed(1) + " км" : (item.remainingMinutes * 380) + " м") + "</div>" +' +
              '"<div class=\\"time-cell\\">" +' +
                '"<span class=\\"time-scheduled\\">" + item.time + "</span>" +' +
              '"</div>" +' +
              'formatMinutes(item.remainingMinutes) +' +
            '"</div>" +' +
            '"<div class=\\"trip-timeline-panel\\" id=\\"" + tripId + "\\" style=\\"display:none;\\">" +' +
              'vehBar +' +
              '"<div class=\\"timeline-track\\">" + timeline + "</div>" +' +
            '"</div>" +' +
          '"</div>";' +
        '}).join("");' +
        'const tCls = ROUTE_TYPE_CLASSES[dir.typeKey] || "bus";' +
        'return "<div class=\\"board-card\\">" +' +
          '"<div class=\\"card-header\\">" +' +
            '"<span class=\\"type-badge " + tCls + "\\">" + dir.type + "</span>" +' +
            '"<span class=\\"platform-title\\">" + dir.title + "</span>" +' +
          '"</div>" +' +
          '"<div class=\\"table-columns\\">" +' +
            '"<div>МАРШРУТ · НАПРЯМОК</div>" +' +
            '"<div>ВІДСТАНЬ</div>" +' +
            '"<div>ЧАС</div>" +' +
            '"<div>ХВ.</div>" +' +
          '"</div>" +' +
          '"<div class=\\"departure-list\\">" + (rows || "<div style=\\"padding:20px;text-align:center;color:#8b949e;\\">Немає рейсів у розкладі</div>") + "</div>" +' +
          '"<div class=\\"card-footer\\">" +' +
            '"<button class=\\"show-all-btn\\" onclick=\\"toggleExpand(\\\'" + dir.id + "\\\')\\">" +' +
              '(isExp ? "∧ Згорнути рейси" : "∨ Показати всі рейси (" + deps.length + ")") +' +
            '"</button>" +' +
          '"</div>" +' +
        '"</div>";' +
      '}).join("") || "<div style=\'grid-column: 1 / -1; padding: 40px 20px; text-align: center; color: #8b949e; background: #161b22; border: 1px solid #30363d; border-radius: 8px;\'>За офіційним розкладом КП «Київпастранс» рейсів на цю зупинку в найближчі 2 години не знайдено.</div>";' +
    '}' +

    'async function selectStop(key) {' +
      'currentStop = key;' +
      'const newUrl = window.location.pathname + "?stop=" + encodeURIComponent(key);' +
      'if (window.location.search !== "?stop=" + encodeURIComponent(key)) {' +
        'window.history.pushState({ stop: key }, "", newUrl);' +
      '}' +
      'refreshBtn.textContent = "⟳ Оновлення...";' +
      'try {' +
        'const res = await fetch("/api/hub?stop=" + encodeURIComponent(key));' +
        'if (!res.ok) throw new Error("HTTP " + res.status);' +
        'const hub = await res.json();' +
        'render(hub);' +
      '} catch(e) {}' +
      'refreshBtn.textContent = "⟳ Оновити табло";' +
    '}' +

    'let searchDebounce = null;' +
    'searchInput.addEventListener("input", () => {' +
      'clearTimeout(searchDebounce);' +
      'const val = searchInput.value.trim();' +
      'if (!val) { searchDropdown.style.display = "none"; return; }' +
      'searchDropdown.innerHTML = "<div class=\\"search-item search-item-muted\\"><span>⏳ Пошук зупинок у реєстрі КП «Київпастранс»...</span></div>";' +
      'searchDropdown.style.display = "block";' +
      'searchDebounce = setTimeout(async () => {' +
        'try {' +
          'const res = await fetch("/api/search?q=" + encodeURIComponent(val));' +
          'if (!res.ok) throw new Error("HTTP " + res.status);' +
          'const data = await res.json();' +
          'if (data.results && data.results.length > 0) {' +
            'searchDropdown.innerHTML = data.results.map(s => {' +
              'const name = s.name || val;' +
              'const badge = "<span class=\\"search-item-badge\\">" + (s.modes || "Київ") + "</span>";' +
              'return "<div class=\\"search-item\\" data-key=\\"" + encodeURIComponent(name) + "\\"><span>" + escapeHtml(name) + "</span>" + badge + "</div>";' +
            '}).join("");' +
          '} else {' +
            'searchDropdown.innerHTML = "<div class=\\"search-item\\" data-key=\\"" + encodeURIComponent(val) + "\\"><span>Нічого не знайдено: <b>" + escapeHtml(val) + "</b></span><span class=\\"search-item-badge\\">Все одно відкрити табло ↗</span></div>";' +
          '}' +
          'searchDropdown.style.display = "block";' +
        '} catch(_) {' +
          'searchDropdown.innerHTML = "<div class=\\"search-item\\" data-key=\\"" + encodeURIComponent(val) + "\\"><span>⚠ Сервіс розкладу тимчасово недоступний</span><span class=\\"search-item-badge\\">Відкрити «" + escapeHtml(val) + "» ↗</span></div>";' +
          'searchDropdown.style.display = "block";' +
        '}' +
      '}, 200);' +
    '});' +

    'searchDropdown.addEventListener("click", (e) => {' +
      'const item = e.target.closest(".search-item");' +
      'if (item && item.dataset.key) {' +
        'selectStop(decodeURIComponent(item.dataset.key));' +
        'searchDropdown.style.display = "none";' +
        'searchInput.value = "";' +
      '}' +
    '});' +

    'searchInput.addEventListener("keydown", (e) => {' +
      'if (e.key === "Enter" && searchInput.value.trim()) {' +
        'selectStop(searchInput.value.trim());' +
        'searchDropdown.style.display = "none";' +
      '}' +
    '});' +

    'document.addEventListener("click", (e) => {' +
      'if (!e.target.closest(".search-bar-wrapper")) searchDropdown.style.display = "none";' +
    '});' +

    'refreshBtn.addEventListener("click", () => selectStop(currentStop));' +
    'favBtn.addEventListener("click", () => {' +
      'const active = favBtn.classList.toggle("active");' +
      'localStorage.setItem("kpt_fav_" + currentStop, active ? "1" : "0");' +
    '});' +
    'window.addEventListener("popstate", () => {' +
      'const p = new URLSearchParams(window.location.search);' +
      'selectStop(p.get("stop") || "' + CONFIG.DEFAULT_STOP + '");' +
    '});' +
    'const ROUTE_TYPE_CLASSES = { 0: "tram", 11: "trolley", 3: "bus", 1: "metro", 2: "train" };' +
    'updateClock();' +
  '</script>' +
'</body>' +
'</html>';
}

function typeKeyOf(typeLabel) {
  const entry = Object.entries(ROUTE_TYPE_LABELS).find(([, label]) => label === typeLabel);
  return entry ? Number(entry[0]) : 3;
}

/* ============================================================
 * Cloudflare Worker Export (Fetch + Scheduled Handlers)
 * ============================================================ */

export default {
  // Cron: refresh the GTFS index nightly so the first morning request is instant
  async scheduled(event, env, ctx) {
    ctx.waitUntil(loadGtfsIndex(null, true).catch(() => {}));
  },

  async fetch(request, env, ctx) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Content-Type": "application/json; charset=utf-8"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // Any unexpected failure must surface as a readable 500 JSON diagnostic
    // (message + stack) instead of the opaque Cloudflare "Error 1101" page.
    try {
      const url = new URL(request.url);
      const { pathname, searchParams } = url;

      // 1. Root route: Server-Side Rendered HTML board
      if (pathname === "/" || pathname === "/index.html") {
        const stopQuery = searchParams.get("stop") || CONFIG.DEFAULT_STOP;
        const hubData = await resolveHubDepartures(stopQuery, ctx);
        const html = renderFullPageHtml(hubData);
        return new Response(html, {
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      }

      // 2. Departure board API
      if (pathname === "/api/hub") {
        const stopQuery = searchParams.get("stop") || CONFIG.DEFAULT_STOP;
        const hubData = await resolveHubDepartures(stopQuery, ctx);
        return new Response(JSON.stringify(hubData), { headers: corsHeaders });
      }

      // 3. Stop search API over the official stop registry
      if (pathname === "/api/search") {
        const data = await searchStops(searchParams.get("q") || "", ctx);
        return new Response(JSON.stringify(data), { headers: corsHeaders });
      }

      // 4. Live fleet API (GTFS-RT positions)
      if (pathname === "/api/live") {
        const vehicles = await loadRealtime(ctx);
        return new Response(JSON.stringify({ vehicles, timestamp: new Date().toISOString() }), {
          headers: corsHeaders
        });
      }

      // 5. Source reachability probe (diagnostics for the edge network path)
      if (pathname === "/api/debug-sources") {
        const probe = await probeSources();
        return new Response(JSON.stringify(probe), { headers: corsHeaders });
      }

      return new Response(JSON.stringify({ error: "Endpoint not found" }), {
        status: 404,
        headers: corsHeaders
      });
    } catch (err) {
      return new Response(JSON.stringify({
        error: true,
        message: (err && err.message) ? err.message : String(err),
        stack: (err && err.stack) ? err.stack : ""
      }), { status: 500, headers: corsHeaders });
    }
  }
};
