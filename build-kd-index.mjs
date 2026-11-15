/**
 * build-kd-index.mjs — Kyiv Digital index builder for the KPT worker
 * Version: 1.0.0
 *
 * Builds the compact KD index JSON exactly in the shape worker.js (>= 3.2.0)
 * expects, from the official «Київ Digital» app API (kyiv.digital):
 *   GET /api/v4/transport/routes  (paginated, 30/page — 8 pages as of 11.2026)
 *   GET /api/v4/transport/stops   (single 912 KB response, all 2784 stops)
 *
 * Both endpoints are PUBLIC DATA of the official municipal app; they are used
 * only as a static mapping (route number <-> KD route id, stop <-> a-Id).
 * Auth: Bearer JWT in the KD_TOKEN env variable (never hard-coded).
 *
 * Usage:
 *   KD_TOKEN=<jwt> node build-kd-index.mjs [--out <file>]
 *
 *   --out <file>  output index path (env: KPT_OUT, default: ./assets/kd-index.json)
 *
 * Index shape (compact on purpose):
 *   fetchedAtMs: number
 *   routes: { kdRouteId: [number, routeType, destination] }   destination = text after "‣"
 *   stops:  [[aId, name, lat, lng, [kdRouteId, ...]], ...]
 *
 * routeType comes from the route name (matches GTFS route_type values used
 * by the worker's ROUTE_TYPE_CLASSES: 0 tram, 3 bus, 7 funicular, 1 metro, 2 rail).
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const BUILDER_VERSION = "1.0.0";
const BASE = "https://kyiv.digital";
// The backend rejects other User-Agents with HTTP 402: it expects the exact
// mobile-app format "KD/<app> Android/<ver> User/<id>". The id is decoded
// from the JWT itself (sub claim), nothing is hard-coded.
const args = process.argv.slice(2);
const argValue = name => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const OUT = resolve(argValue("--out") || process.env.KPT_OUT || "./assets/kd-index.json");
const TOKEN = process.env.KD_TOKEN;
if (!TOKEN || TOKEN.length < 40) {
  console.error("KD_TOKEN env variable with the app JWT is required (npx wrangler secret put KD_TOKEN uses the same value).");
  process.exit(1);
}

// The backend rejects other User-Agents with HTTP 402: it expects the exact
// mobile-app format "KD/<app> Android/<ver> User/<id>". The id is decoded
// from the JWT itself (sub claim), nothing is hard-coded.
const JWT_PARTS = TOKEN.split(".");
const SUB = (JSON.parse(Buffer.from(JWT_PARTS[1], "base64").toString("utf8")).sub) || "0";
const UA = "KD/4.1.0 Android/16 User/" + SUB;

const HDR = { "Authorization": "Bearer " + TOKEN, "Accept": "application/json", "User-Agent": UA };

async function getJson(url, timeoutMs = 30000) {
  const res = await fetch(url, { headers: HDR, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error("HTTP " + res.status + " for " + url);
  return res.json();
}

/** GET with rate-limit awareness (v4 endpoints allow 60 calls per window). */
async function getJsonLimited(url) {
  for (;;) {
    const res = await fetch(url, { headers: HDR, signal: AbortSignal.timeout(30000) });
    if (res.status === 402 || res.status === 429) {
      process.stdout.write(" w");
      await sleep(WINDOW_WAIT_MS);
      continue;
    }
    if (!res.ok) throw new Error("HTTP " + res.status + " for " + url);
    const remaining = res.headers.get("x-ratelimit-remaining");
    const j = await res.json();
    if (remaining === "0") {
      await sleep(WINDOW_WAIT_MS);
    }
    return j;
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const WINDOW_WAIT_MS = 35000;

function typeFromName(name) {
  const n = name.toLowerCase();
  if (n.includes("трамвай")) return 0;
  if (n.includes("тролейбус")) return 11;
  if (n.includes("метро")) return 1;
  if (n.includes("електричк")) return 2;
  if (n.includes("фунікул")) return 7;
  return 3; // автобус / маршрутка
}

const routes = [];
for (let page = 1; page <= 20; page++) {
  const j = await getJson(BASE + "/api/v4/transport/routes?page=" + page);
  const data = (j.routes && j.routes.data) || [];
  routes.push(...data);
  const links = j.routes && j.routes.meta && j.routes.meta.pagination && j.routes.meta.pagination.links;
  if (!links || !links.next) break;
}
if (routes.length < 100) throw new Error("suspiciously few routes: " + routes.length);

const routesOut = {};
for (const r of routes) {
  const dest = (r.description || "").split("‣").pop().trim() || r.name;
  routesOut[r.id] = [r.number, typeFromName(r.name), dest];
}

const stopsRaw = await getJson(BASE + "/api/v4/transport/stops");
const list = stopsRaw.list || [];
if (list.length < 1000) throw new Error("suspiciously few stops: " + list.length);
const stopsOut = list.map(s => [s.id, s.name, s.lat, s.lng, (s.route_ids || []).slice().sort((a, b) => a - b)]);

// ---------- full route paths (directions with ALL stops) ----------
// GET /api/v4/transport/routes/<id> returns directions.forward/backward with
// the complete ordered stop list of each direction. This fixes the departure
// timeline: the official GTFS export only carries CONTROL POINTS (max 8 stops
// per trip, avg 4.2), so a raw GTFS timeline is unavoidably incomplete.
// Raw responses are cached, so a rerun never re-downloads fetched routes.
const CACHE_DIR = resolve(argValue("--cache") || process.env.KPT_ROUTE_CACHE || join(tmpdir(), "kd_route_details"));
mkdirSync(CACHE_DIR, { recursive: true });
const rawPath = join(CACHE_DIR, "<id>.json");

function parseDirection(dir) {
  const stops = dir && Array.isArray(dir.stops) ? dir.stops : [];
  if (stops.length < 2) return null;
  return stops.map(s => [s.id, s.name, s.lat, s.lng]);
}

const paths = {};
let fetched = 0, cached = 0;
for (const r of routes) {
  const file = rawPath.replace("<id>", String(r.id));
  let detail = null;
  if (existsSync(file)) {
    detail = JSON.parse(readFileSync(file, "utf8"));
    cached++;
  } else {
    detail = await getJsonLimited(BASE + "/api/v4/transport/routes/" + r.id);
    writeFileSync(file, JSON.stringify(detail));
    fetched++;
    process.stdout.write(".");
  }
  const f = parseDirection(detail.directions && detail.directions.forward);
  const b = parseDirection(detail.directions && detail.directions.backward);
  if (f || b) paths[r.id] = Object.assign({}, f ? { f } : null, b ? { b } : null);
}
console.log("\nroute paths: cached " + cached + ", fetched " + fetched + ", with path: " + Object.keys(paths).length);

const index = { fetchedAtMs: Date.now(), routes: routesOut, stops: stopsOut, paths };
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(index));
const tracked = routes.filter(r => r.with_tracking).length;
console.log("routes: " + routes.length + " (tracked: " + tracked + "), stops: " + stopsOut.length);
console.log("written: " + OUT + " (" + (JSON.stringify(index).length / 1024).toFixed(0) + " KB)");
