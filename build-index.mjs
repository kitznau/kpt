/**
 * Builds the compact GTFS index JSON exactly in the shape the worker
 * expects, from the official Kyivpastrans ZIP (downloaded over the local
 * residential network, where the origin does not 403).
 * Output: gtfs-index.json (goes to POST /api/admin/import-index)
 */
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";

const ZIP_URL = "http://193.23.225.211:8002/export-gtfs-static";
const OUT = "C:/test/kpt/gtfs-index.json";
const ZIP_CACHE = "C:/Users/Admin/AppData/Local/Temp/opencode/kyiv_gtfs.zip";

// ---------- ZIP reader ----------
function readZipEntries(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("EOCD not found");
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const files = {};
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break;
    files[new TextDecoder().decode(buf.subarray(off + 46, off + 46 + dv.getUint16(off + 28, true)))] = {
      method: dv.getUint16(off + 10, true),
      csize: dv.getUint32(off + 20, true),
      dataStart: dv.getUint32(off + 42, true) + 30 + dv.getUint16(dv.getUint32(off + 42, true) + 26, true) + dv.getUint16(dv.getUint32(off + 42, true) + 28, true)
    };
    off += 46 + dv.getUint16(off + 28, true) + dv.getUint16(off + 30, true) + dv.getUint16(off + 32, true);
  }
  return files;
}

async function inflateRaw(u8) {
  const ds = new DecompressionStream("deflate-raw");
  return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(ds)).arrayBuffer());
}

function csvObjects(text) {
  const results = [];
  let i = 0, field = "", row = [], inQ = false, header = null;
  if (text.charCodeAt(0) === 0xFEFF) i = 1;
  const flush = () => {
    row.push(field); field = "";
    if (header === null) header = row.map(h => h.trim());
    else if (row.length >= header.length && row.some(c => c !== "")) {
      const o = {}; header.forEach((h, ix) => o[h] = (row[ix] || "").trim()); results.push(o);
    }
    row = [];
  };
  while (i < text.length) {
    const c = text[i];
    if (inQ) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } inQ = false; i++; continue; } field += c; i++; continue; }
    if (c === '"') { inQ = true; i++; continue; }
    if (c === ",") { row.push(field); field = ""; i++; continue; }
    if (c === "\n") { flush(); i++; continue; }
    if (c === "\r") { i++; continue; }
    field += c; i++;
  }
  if (field.length || row.length) flush();
  return results;
}

// ---------- main ----------
let zipBuf;
if (process.argv.includes("--fresh") || !existsSync(ZIP_CACHE)) {
  console.log("downloading", ZIP_URL, "...");
  const res = await fetch(ZIP_URL);
  if (!res.ok) throw new Error("HTTP " + res.status);
  zipBuf = new Uint8Array(await res.arrayBuffer());
  writeFileSync(ZIP_CACHE, zipBuf);
} else {
  zipBuf = new Uint8Array(readFileSync(ZIP_CACHE));
}
const t0 = Date.now();
const entries = readZipEntries(zipBuf);
const [stopsTxt, routesTxt, tripsTxt, stopTimesTxt, calendarTxt, calDatesTxt, feedInfoTxt] = await Promise.all([
  inflateRaw(zipBuf.subarray(entries["stops.txt"].dataStart, entries["stops.txt"].dataStart + entries["stops.txt"].csize)).then(u8 => new TextDecoder().decode(u8)),
  inflateRaw(zipBuf.subarray(entries["routes.txt"].dataStart, entries["routes.txt"].dataStart + entries["routes.txt"].csize)).then(u8 => new TextDecoder().decode(u8)),
  inflateRaw(zipBuf.subarray(entries["trips.txt"].dataStart, entries["trips.txt"].dataStart + entries["trips.txt"].csize)).then(u8 => new TextDecoder().decode(u8)),
  inflateRaw(zipBuf.subarray(entries["stop_times.txt"].dataStart, entries["stop_times.txt"].dataStart + entries["stop_times.txt"].csize)).then(u8 => new TextDecoder().decode(u8)),
  inflateRaw(zipBuf.subarray(entries["calendar.txt"].dataStart, entries["calendar.txt"].dataStart + entries["calendar.txt"].csize)).then(u8 => new TextDecoder().decode(u8)),
  entries["calendar_dates.txt"] ? inflateRaw(zipBuf.subarray(entries["calendar_dates.txt"].dataStart, entries["calendar_dates.txt"].dataStart + entries["calendar_dates.txt"].csize)).then(u8 => new TextDecoder().decode(u8)) : Promise.resolve(""),
  entries["feed_info.txt"] ? inflateRaw(zipBuf.subarray(entries["feed_info.txt"].dataStart, entries["feed_info.txt"].dataStart + entries["feed_info.txt"].csize)).then(u8 => new TextDecoder().decode(u8)) : Promise.resolve("")
]);

const stops = csvObjects(stopsTxt).map(s => [s.stop_id, s.stop_name, parseFloat(s.stop_lat), parseFloat(s.stop_lon)]);
const routes = {};
csvObjects(routesTxt).forEach(r => { routes[r.route_id] = { n: r.route_short_name || r.route_id, t: parseInt(r.route_type, 10) || 0, l: r.route_long_name || "" }; });
const trips = {};
csvObjects(tripsTxt).forEach(t => { trips[t.trip_id] = { r: t.route_id, s: t.service_id }; });
const dest = {}, sched = {}, tripStops = {};
csvObjects(stopTimesTxt).forEach(st => {
  const p = st.departure_time.split(":").map(Number);
  if (p.length !== 3 || Number.isNaN(p[0])) return;
  const dep = p[0] * 3600 + p[1] * 60 + p[2];
  (sched[st.stop_id] ||= []).push([dep, st.trip_id]);
  (tripStops[st.trip_id] ||= []).push([st.stop_id, dep]);
  dest[st.trip_id] = st.stop_id;
});
const calendar = {};
csvObjects(calendarTxt).forEach(c => {
  calendar[c.service_id] = { s: c.start_date, e: c.end_date, d: [c.monday, c.tuesday, c.wednesday, c.thursday, c.friday, c.saturday, c.sunday].map(x => x === "1" ? "1" : "0").join("") };
});
const calDates = { add: {}, rem: {} };
csvObjects(calDatesTxt).forEach(cd => { (calDates[cd.exception_type === "1" ? "add" : "rem"][cd.date] ||= []).push(cd.service_id); });
let version = "";
csvObjects(feedInfoTxt).forEach(fi => version = fi.feed_version || version);

const index = { version, stops, routes, trips, dest, sched, tripStops, calendar, calDates, fetchedAtMs: Date.now() };
const json = JSON.stringify(index);
const parseMs = (() => { const t = Date.now(); JSON.parse(json); return Date.now() - t; })();
writeFileSync(OUT, json);
console.log("built in", Date.now() - t0, "ms | stops:", stops.length, "| trips:", Object.keys(trips).length, "| version:", version);
console.log("json size:", (json.length / 1048576).toFixed(1), "MB | JSON.parse roundtrip:", parseMs, "ms");
