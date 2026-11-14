/**
 * build-index.mjs — GTFS index builder for the KPT worker
 * Version: 1.1.0
 *
 * Builds the compact GTFS index JSON exactly in the shape worker.js (>= 3.1.0)
 * expects, from the official Kyivpastrans ZIP. Run it on a network the origin
 * does not 403 (e.g. a residential connection).
 *
 * Usage:
 *   node build-index.mjs [--fresh] [--zip <file>] [--out <file>]
 *
 *   --fresh        re-download the ZIP even if a cached copy exists
 *   --zip <file>   ZIP cache / input path   (env: KPT_ZIP_CACHE, default: <tmpdir>/kyiv_gtfs.zip)
 *   --out <file>   output index path        (env: KPT_OUT,       default: ./assets/gtfs-index.json)
 *
 * The default output lands in the worker's bundled assets directory, so
 * `wrangler deploy` ships it as the always-available fallback index.
 * Alternatively POST the file to /api/admin/import-index (x-admin-token header).
 *
 * Changelog 1.1.0
 *  - stop_times are sorted by stop_sequence per trip (destination + timeline order);
 *    1.0.0 relied on file row order.
 *  - departure_time falls back to arrival_time.
 *  - no hard-coded Windows paths; CLI args / env; default output is ./assets/gtfs-index.json.
 *  - download timeout + ZIP signature check; required members and result are validated.
 *  - removed unused imports.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const BUILDER_VERSION = "1.1.0";
const ZIP_URL = "http://193.23.225.211:8002/export-gtfs-static";
const DOWNLOAD_TIMEOUT_MS = 180000;

const args = process.argv.slice(2);
const argValue = name => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const OUT = resolve(argValue("--out") || process.env.KPT_OUT || "./assets/gtfs-index.json");
const ZIP_CACHE = resolve(argValue("--zip") || process.env.KPT_ZIP_CACHE || join(tmpdir(), "kyiv_gtfs.zip"));
const FRESH = args.includes("--fresh");

// ---------- ZIP reader ----------
function readZipEntries(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("EOCD not found (not a ZIP?)");
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const files = {};
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break;
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const commentLen = dv.getUint16(off + 32, true);
    const lho = dv.getUint32(off + 42, true);
    const name = new TextDecoder().decode(buf.subarray(off + 46, off + 46 + nameLen));
    files[name] = {
      method: dv.getUint16(off + 10, true),
      csize: dv.getUint32(off + 20, true),
      dataStart: lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true)
    };
    off += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

async function inflateRaw(u8) {
  const ds = new DecompressionStream("deflate-raw");
  return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(ds)).arrayBuffer());
}

async function readEntry(buf, entries, name, required) {
  const e = entries[name];
  if (!e) {
    if (required) throw new Error("required ZIP member missing: " + name);
    return "";
  }
  const slice = buf.subarray(e.dataStart, e.dataStart + e.csize);
  if (e.method === 0) return new TextDecoder().decode(slice);
  if (e.method === 8) return new TextDecoder().decode(await inflateRaw(slice));
  throw new Error("unsupported compression method " + e.method + " in " + name);
}

// ---------- CSV ----------
function csvObjects(text) {
  const results = [];
  let i = 0, field = "", row = [], inQ = false, header = null;
  if (text.charCodeAt(0) === 0xFEFF) i = 1;
  const flush = () => {
    row.push(field); field = "";
    if (header === null) header = row.map(h => h.trim());
    else if (row.length >= header.length && row.some(c => c !== "")) {
      const o = {};
      header.forEach((h, ix) => { o[h] = (row[ix] || "").trim(); });
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
    if (c === "\n") { flush(); i++; continue; }
    if (c === "\r") { i++; continue; }
    field += c; i++;
  }
  if (field.length || row.length) flush();
  return results;
}

// ---------- obtain ZIP ----------
let zipBuf;
if (FRESH || !existsSync(ZIP_CACHE)) {
  console.log("downloading", ZIP_URL, "...");
  const res = await fetch(ZIP_URL, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error("HTTP " + res.status);
  zipBuf = new Uint8Array(await res.arrayBuffer());
  if (zipBuf.length < 200000 || zipBuf[0] !== 0x50 || zipBuf[1] !== 0x4b) {
    throw new Error("downloaded payload is not a plausible GTFS ZIP (" + zipBuf.length + " bytes)");
  }
  mkdirSync(dirname(ZIP_CACHE), { recursive: true });
  writeFileSync(ZIP_CACHE, zipBuf);
} else {
  console.log("using cached ZIP", ZIP_CACHE);
  zipBuf = new Uint8Array(readFileSync(ZIP_CACHE));
}

// ---------- build ----------
const t0 = Date.now();
const entries = readZipEntries(zipBuf);
const [stopsTxt, routesTxt, tripsTxt, stopTimesTxt, calendarTxt, calDatesTxt, feedInfoTxt] = await Promise.all([
  readEntry(zipBuf, entries, "stops.txt", true),
  readEntry(zipBuf, entries, "routes.txt", true),
  readEntry(zipBuf, entries, "trips.txt", true),
  readEntry(zipBuf, entries, "stop_times.txt", true),
  readEntry(zipBuf, entries, "calendar.txt", true),
  readEntry(zipBuf, entries, "calendar_dates.txt", false),
  readEntry(zipBuf, entries, "feed_info.txt", false)
]);

const stops = csvObjects(stopsTxt).map(s => [s.stop_id, s.stop_name, parseFloat(s.stop_lat), parseFloat(s.stop_lon)]);

const routes = {};
csvObjects(routesTxt).forEach(r => {
  routes[r.route_id] = { n: r.route_short_name || r.route_id, t: parseInt(r.route_type, 10) || 0, l: r.route_long_name || "" };
});

const trips = {};
csvObjects(tripsTxt).forEach(t => { trips[t.trip_id] = { r: t.route_id, s: t.service_id }; });

// stop_times are NOT guaranteed to be ordered: sort every trip by stop_sequence.
const tripRows = {};
csvObjects(stopTimesTxt).forEach((st, rowNo) => {
  const p = (st.departure_time || st.arrival_time || "").split(":").map(Number);
  if (p.length !== 3 || p.some(Number.isNaN)) return;
  const dep = p[0] * 3600 + p[1] * 60 + p[2];
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
  (calDates[cd.exception_type === "1" ? "add" : "rem"][cd.date] ||= []).push(cd.service_id);
});

let version = "";
csvObjects(feedInfoTxt).forEach(fi => { version = fi.feed_version || version; });

// ---------- validate (same sanity rules as the worker) ----------
if (stops.length < 100) throw new Error("suspicious result: only " + stops.length + " stops");
if (Object.keys(trips).length === 0 || Object.keys(sched).length === 0) throw new Error("suspicious result: no trips/departures");

const index = { version, stops, routes, trips, dest, sched, tripStops, calendar, calDates, fetchedAtMs: Date.now(), builder: BUILDER_VERSION };
const json = JSON.stringify(index);
const parseMs = (() => { const t = Date.now(); JSON.parse(json); return Date.now() - t; })();
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, json);
console.log("built in", Date.now() - t0, "ms | stops:", stops.length, "| trips:", Object.keys(trips).length, "| version:", version || "-");
console.log("json size:", (json.length / 1048576).toFixed(1), "MB | JSON.parse roundtrip:", parseMs, "ms");
console.log("written to", OUT);
