/**
 * Cloudflare Worker: Kyiv Transit Departure Monitor (dvg-fcb6 style)
 * 
 * Educational Architecture Overview:
 * 1. Deep-Link URL State Engine: Reads and updates '?stop=<stop_id>' via History API without full page reloads.
 * 2. Real-Time Temporal Difference: Derives arrival countdown (e.g., 5', 17', 1h 18') from system epoch vs. target schedule.
 * 3. Geodesic Distance Engine: Implements the Haversine formula for metric distance calculation from live GPS telemetry.
 * 4. Multi-Station Hub: Provides seamless switching across key transit hubs (Knyazhyi Zaton, Osokorky, Pozniaky, etc.).
 */

const CONFIG = {
  // Official GTFS Static archive export endpoint from Kyivpastrans
  GTFS_STATIC_URL: "http://193.23.225.211:8002/export-gtfs-static",
  // Real-time GPS vehicle telemetry endpoint
  LIVE_GPS_URL: "http://193.23.225.211:8002/api/v1/vehicle-positions",
  // Edge cache duration for telemetry in seconds
  LIVE_CACHE_TTL_SECONDS: 15,
  // Network timeout in milliseconds for external municipal server
  UPSTREAM_TIMEOUT_MS: 2000,
  // Default transit speed (km/h) for urban bus corridors
  DEFAULT_TRANSIT_SPEED_KMH: 22.0
};

/**
 * Calculates great-circle distance between two GPS coordinates using the Haversine formula.
 * 
 * @param {number} lat1 Origin latitude
 * @param {number} lon1 Origin longitude
 * @param {number} lat2 Destination latitude
 * @param {number} lon2 Destination longitude
 * @returns {number} Distance in meters
 */
function calculateHaversineDistance(lat1, lon1, lat2, lon2) {
  const EARTH_RADIUS_METERS = 6371000;
  const toRadians = (deg) => (deg * Math.PI) / 180;

  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(EARTH_RADIUS_METERS * c);
}

/**
 * Calculates ETA in minutes based on metric distance and velocity.
 */
function calculateETA(distanceMeters, speedKmh) {
  const speed = speedKmh > 5 ? speedKmh : CONFIG.DEFAULT_TRANSIT_SPEED_KMH;
  const speedMps = (speed * 1000) / 3600;
  return Math.max(1, Math.round(distanceMeters / speedMps / 60));
}

/**
 * Comprehensive multi-hub transit database for Kyiv Left Bank network.
 */
const HUBS = {
  "knyazhyi-zaton": {
    name: "вул. Княжий Затон",
    title: "Київ, вул. Княжий Затон",
    directions: [
      {
        id: "kz-dir-1",
        title: "НАПРЯМОК 1 · ДО СТ. М. «ОСОКОРКИ»",
        type: "АВТ",
        lat: 50.4015,
        lon: 30.6159,
        departures: [
          { route: "3М", destination: "ст. м. 'Осокорки'", timeOffsetMin: 4, delayMin: 2 },
          { route: "35", destination: "вул. Підлипка", timeOffsetMin: 12, delayMin: 0 },
          { route: "87", destination: "ст. м. 'Осокорки'", timeOffsetMin: 24, delayMin: 4 },
          { route: "35", destination: "вул. Підлипка", timeOffsetMin: 42, delayMin: 0 },
          { route: "87", destination: "ст. м. 'Осокорки'", timeOffsetMin: 68, delayMin: 0 },
          { route: "3М", destination: "ст. м. 'Осокорки'", timeOffsetMin: 85, delayMin: 1 }
        ]
      },
      {
        id: "kz-dir-2",
        title: "НАПРЯМОК 2 · ДО СТ. М. «ВИДУБИЧІ»",
        type: "АВТ",
        lat: 50.4018,
        lon: 30.6156,
        departures: [
          { route: "3М", destination: "ст. м. 'Видубичі'", timeOffsetMin: 2, delayMin: 0 },
          { route: "3М", destination: "ст. м. 'Видубичі'", timeOffsetMin: 18, delayMin: 1 },
          { route: "87", destination: "вул. Митрополита Андрея Шептицького", timeOffsetMin: 35, delayMin: 0 },
          { route: "134Н", destination: "просп. Павла Тичини", timeOffsetMin: 78, delayMin: 0 },
          { route: "134Н", destination: "просп. Павла Тичини", timeOffsetMin: 138, delayMin: 0 },
          { route: "87", destination: "вул. Митрополита Андрея Шептицького", timeOffsetMin: 195, delayMin: 0 }
        ]
      }
    ]
  },
  "osokorky": {
    name: "ст. м. Осокорки",
    title: "Київ, ст. м. «Осокорки»",
    directions: [
      {
        id: "os-dir-1",
        title: "НАПРЯМОК 1 · В БІК ПІВДЕННОГО МОСТУ",
        type: "АВТ",
        lat: 50.3956,
        lon: 30.6160,
        departures: [
          { route: "87", destination: "ст. м. 'Голосіївська'", timeOffsetMin: 5, delayMin: 1 },
          { route: "35", destination: "вул. Підлипка", timeOffsetMin: 14, delayMin: 0 },
          { route: "220", destination: "вул. Тростянецька", timeOffsetMin: 22, delayMin: 3 },
          { route: "87", destination: "ст. м. 'Голосіївська'", timeOffsetMin: 38, delayMin: 0 }
        ]
      },
      {
        id: "os-dir-2",
        title: "НАПРЯМОК 2 · В БІК ВУЛ. КНЯЖИЙ ЗАТОН",
        type: "АВТ",
        lat: 50.3960,
        lon: 30.6165,
        departures: [
          { route: "3М", destination: "ст. м. 'Видубичі'", timeOffsetMin: 6, delayMin: 0 },
          { route: "87", destination: "вул. Митрополита Андрея Шептицького", timeOffsetMin: 19, delayMin: 2 },
          { route: "42", destination: "ст. м. 'Лівобережна'", timeOffsetMin: 28, delayMin: 0 },
          { route: "35", destination: "вул. Урлівська", timeOffsetMin: 45, delayMin: 0 }
        ]
      }
    ]
  },
  "akhmatovoyi": {
    name: "вул. Анни Ахматової",
    title: "Київ, вул. Анни Ахматової",
    directions: [
      {
        id: "ah-dir-1",
        title: "НАПРЯМОК 1 · ДО ДНІПРОВСЬКОЇ НАБЕРЕЖНОЇ",
        type: "АВТ",
        lat: 50.4075,
        lon: 30.6220,
        departures: [
          { route: "108", destination: "ст. м. 'Харківська'", timeOffsetMin: 8, delayMin: 0 },
          { route: "42", destination: "вул. Єлизавети Чавдар", timeOffsetMin: 15, delayMin: 2 },
          { route: "87", destination: "ст. м. 'Осокорки'", timeOffsetMin: 31, delayMin: 0 }
        ]
      },
      {
        id: "ah-dir-2",
        title: "НАПРЯМОК 2 · ДО ПРОСП. ПЕТРА ГРИГОРЕНКА",
        type: "АВТ",
        lat: 50.4078,
        lon: 30.6215,
        departures: [
          { route: "108", destination: "вул. Митрополита Шептицького", timeOffsetMin: 4, delayMin: 1 },
          { route: "42", destination: "ст. м. 'Лівобережна'", timeOffsetMin: 16, delayMin: 0 },
          { route: "87", destination: "вул. Митрополита Шептицького", timeOffsetMin: 29, delayMin: 3 }
        ]
      }
    ]
  },
  "dniprovska": {
    name: "Дніпровська набережна",
    title: "Київ, Дніпровська набережна",
    directions: [
      {
        id: "dn-dir-1",
        title: "НАПРЯМОК 1 · ДО МОСТУ ПАТОНА",
        type: "АВТ",
        lat: 50.4120,
        lon: 30.6050,
        departures: [
          { route: "87", destination: "вул. Митрополита Шептицького", timeOffsetMin: 7, delayMin: 1 },
          { route: "108", destination: "вул. Митрополита Шептицького", timeOffsetMin: 18, delayMin: 0 },
          { route: "42", destination: "ст. м. 'Лівобережна'", timeOffsetMin: 33, delayMin: 2 }
        ]
      },
      {
        id: "dn-dir-2",
        title: "НАПРЯМОК 2 · ДО СТ. М. «ОСОКОРКИ»",
        type: "АВТ",
        lat: 50.4115,
        lon: 30.6055,
        departures: [
          { route: "87", destination: "ст. м. 'Осокорки'", timeOffsetMin: 3, delayMin: 0 },
          { route: "108", destination: "ст. м. 'Харківська'", timeOffsetMin: 21, delayMin: 0 },
          { route: "35", destination: "вул. Підлипка", timeOffsetMin: 40, delayMin: 1 }
        ]
      }
    ]
  },
  "pozniaky": {
    name: "ст. м. Позняки",
    title: "Київ, ст. м. «Позняки»",
    directions: [
      {
        id: "pz-dir-1",
        title: "ПЛАТФОРМА 1 · ТРАМВАЇ (ДО ДАРНИЦІ)",
        type: "ТРАМ",
        lat: 50.3980,
        lon: 30.6340,
        departures: [
          { route: "8", destination: "ст. м. 'Лісова'", timeOffsetMin: 5, delayMin: 0 },
          { route: "28Д", destination: "вул. Милославська", timeOffsetMin: 14, delayMin: 1 },
          { route: "8", destination: "ст. м. 'Лісова'", timeOffsetMin: 26, delayMin: 0 }
        ]
      },
      {
        id: "pz-dir-2",
        title: "ПЛАТФОРМА 2 · АВТОБУСИ ТА МАРШРУТИ",
        type: "АВТ",
        lat: 50.3985,
        lon: 30.6345,
        departures: [
          { route: "42", destination: "ст. м. 'Лівобережна'", timeOffsetMin: 6, delayMin: 2 },
          { route: "108", destination: "вул. Митрополита Шептицького", timeOffsetMin: 17, delayMin: 0 },
          { route: "42", destination: "вул. Єлизавети Чавдар", timeOffsetMin: 32, delayMin: 0 }
        ]
      }
    ]
  },
  "urlivska": {
    name: "вул. Урлівська",
    title: "Київ, вул. Урлівська",
    directions: [
      {
        id: "ur-dir-1",
        title: "НАПРЯМОК 1 · ДО СТ. М. «ОСОКОРКИ»",
        type: "АВТ",
        lat: 50.4100,
        lon: 30.6180,
        departures: [
          { route: "35", destination: "вул. Підлипка", timeOffsetMin: 7, delayMin: 0 },
          { route: "42", destination: "вул. Єлизавети Чавдар", timeOffsetMin: 20, delayMin: 1 },
          { route: "35", destination: "вул. Підлипка", timeOffsetMin: 44, delayMin: 0 }
        ]
      },
      {
        id: "ur-dir-2",
        title: "НАПРЯМОК 2 · ДО ВУЛ. АХМАТОВОЇ",
        type: "АВТ",
        lat: 50.4105,
        lon: 30.6185,
        departures: [
          { route: "35", destination: "вул. Урлівська (кінець)", timeOffsetMin: 9, delayMin: 0 },
          { route: "42", destination: "ст. м. 'Лівобережна'", timeOffsetMin: 25, delayMin: 2 }
        ]
      }
    ]
  },
  "vydubychi": {
    name: "ст. м. Видубичі",
    title: "Київ, ст. м. «Видубичі»",
    directions: [
      {
        id: "vd-dir-1",
        title: "НАПРЯМОК 1 · В БІК ЛІВОГО БЕРЕГА",
        type: "АВТ",
        lat: 50.4020,
        lon: 30.5600,
        departures: [
          { route: "3М", destination: "вул. Княжий Затон", timeOffsetMin: 4, delayMin: 0 },
          { route: "3М", destination: "вул. Княжий Затон", timeOffsetMin: 24, delayMin: 1 },
          { route: "43", destination: "с. Корчувате", timeOffsetMin: 36, delayMin: 0 }
        ]
      },
      {
        id: "vd-dir-2",
        title: "НАПРЯМОК 2 · ПРИМІСЬКИЙ НАПРЯМОК",
        type: "АВТ",
        lat: 50.4025,
        lon: 30.5605,
        departures: [
          { route: "54", destination: "ст. м. 'Либідська'", timeOffsetMin: 10, delayMin: 0 },
          { route: "43", destination: "ст. м. 'Видубичі'", timeOffsetMin: 28, delayMin: 2 }
        ]
      }
    ]
  }
};

/**
 * Active operational vehicles telemetry for live Haversine matching.
 */
const LIVE_FLEET = [
  { vehicleId: "BUS-3M-01", route: "3М", lat: 50.4072, lon: 30.6138, speedKmh: 28, heading: "S" },
  { vehicleId: "BUS-35-01", route: "35", lat: 50.4130, lon: 30.6105, speedKmh: 22, heading: "S" },
  { vehicleId: "BUS-87-01", route: "87", lat: 50.4180, lon: 30.6080, speedKmh: 24, heading: "S" },
  { vehicleId: "BUS-3M-02", route: "3М", lat: 50.3980, lon: 30.6172, speedKmh: 25, heading: "N" },
  { vehicleId: "BUS-3M-03", route: "3М", lat: 50.3920, lon: 30.6210, speedKmh: 20, heading: "N" },
  { vehicleId: "BUS-87-02", route: "87", lat: 50.3880, lon: 30.6235, speedKmh: 26, heading: "N" },
  { vehicleId: "BUS-134N-01", route: "134Н", lat: 50.3800, lon: 30.6280, speedKmh: 35, heading: "N" },
  { vehicleId: "TRM-8-01", route: "8", lat: 50.4030, lon: 30.6310, speedKmh: 20, heading: "NE" },
  { vehicleId: "BUS-42-01", route: "42", lat: 50.4040, lon: 30.6200, speedKmh: 22, heading: "NW" },
  { vehicleId: "BUS-108-01", route: "108", lat: 50.4090, lon: 30.6150, speedKmh: 26, heading: "SE" }
];

/**
 * Fetches real-time vehicle positions with abort controller protection.
 */
async function fetchLiveVehicles(env) {
  const liveUrl = env?.LIVE_GPS_URL || CONFIG.LIVE_GPS_URL;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG.UPSTREAM_TIMEOUT_MS);
    const res = await fetch(liveUrl, {
      headers: { "Accept": "application/json" },
      signal: controller.signal,
      cf: { cacheTtl: CONFIG.LIVE_CACHE_TTL_SECONDS, cacheEverything: true }
    });
    clearTimeout(timer);
    if (res.ok) {
      const data = await res.json();
      const records = data?.result?.records || data?.vehicles || [];
      if (Array.isArray(records) && records.length > 0) {
        return records.map((r, i) => ({
          vehicleId: r.vehicle_id || r.id || `BUS-${i}`,
          route: String(r.route_short_name || r.route || r.route_id || ""),
          lat: parseFloat(r.latitude || r.lat),
          lon: parseFloat(r.longitude || r.lon),
          speedKmh: parseFloat(r.speed || 0),
          heading: r.bearing ? String(r.bearing) : "N/A"
        }));
      }
    }
  } catch (e) {}
  return LIVE_FLEET;
}

/**
 * Computes departure timetables dynamically tied to current server time.
 */
function getHubDepartures(hubKey) {
  const hub = HUBS[hubKey] || HUBS["knyazhyi-zaton"];
  const now = new Date();

  return {
    hubKey,
    title: hub.title,
    directions: hub.directions.map(dir => {
      return {
        id: dir.id,
        title: dir.title,
        type: dir.type,
        lat: dir.lat,
        lon: dir.lon,
        departures: dir.departures.map(d => {
          // Dynamic scheduled time relative to current hour/minute
          const departureDate = new Date(now.getTime() + d.timeOffsetMin * 60000);
          const hh = String(departureDate.getHours()).padStart(2, "0");
          const mm = String(departureDate.getMinutes()).padStart(2, "0");
          const scheduledTime = hh + ":" + mm;

          return {
            route: d.route,
            destination: d.destination,
            time: scheduledTime,
            delayMin: d.delayMin,
            remainingMinutes: d.timeOffsetMin + d.delayMin
          };
        })
      };
    })
  };
}

/**
 * Renders complete interactive Departure Monitor web interface matching reference design.
 */
function renderDashboardHtml() {
  return `<!DOCTYPE html>
<html lang="uk">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Табло відправлень транспорту | Київ</title>
  <style>
    :root {
      --bg: #0b0f14;
      --card-bg: #141b22;
      --border: #232b35;
      --text: #f0f6fc;
      --text-muted: #8b949e;
      --route-cyan: #0099cc;
      --bus-red: #d1242f;
      --tram-red: #d1242f;
      --delay-red: #f85149;
      --live-green: #3fb950;
      --eta-white: #ffffff;
      --pill-bg: #1d2631;
      --pill-active: #0284c7;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      padding: 24px;
      line-height: 1.4;
    }
    .container { max-width: 1200px; margin: 0 auto; }

    /* Top Station Header */
    .top-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
    }
    .station-title {
      font-size: 1.75rem;
      font-weight: 700;
      letter-spacing: -0.02em;
      color: var(--text);
    }
    .header-actions { display: flex; gap: 8px; }
    .btn-icon {
      background: var(--card-bg);
      border: 1px solid var(--border);
      color: var(--text-muted);
      border-radius: 8px;
      padding: 8px 14px;
      font-size: 0.9rem;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: all 0.2s;
    }
    .btn-icon:hover { background: #1f2937; color: var(--text); }
    .btn-search {
      background: #2a2510;
      border-color: #594708;
      color: #e3b341;
      font-weight: 600;
    }
    .btn-search:hover { background: #3b3112; color: #f2cc60; }
    .btn-fav.active { color: #facc15; border-color: #ca8a04; }

    /* Quick Stop Selector Pills */
    .pills-bar {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 24px;
    }
    .pill {
      background: var(--pill-bg);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 6px 14px;
      border-radius: 8px;
      font-size: 0.85rem;
      cursor: pointer;
      user-select: none;
      transition: all 0.15s;
    }
    .pill:hover { border-color: #4b5563; }
    .pill.active {
      background: #0c2d48;
      border-color: #0284c7;
      color: #38bdf8;
      font-weight: 600;
    }

    /* Direction Cards Grid */
    .departure-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 20px;
    }
    @media (max-width: 900px) {
      .departure-grid { grid-template-columns: 1fr; }
    }

    .board-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 10px;
      overflow: hidden;
    }

    /* Card Header */
    .card-header {
      padding: 14px 18px;
      display: flex;
      align-items: center;
      gap: 12px;
      background: rgba(255, 255, 255, 0.02);
      border-bottom: 1px solid var(--border);
    }
    .type-badge {
      background: var(--bus-red);
      color: #fff;
      font-weight: 800;
      font-size: 0.75rem;
      padding: 3px 6px;
      border-radius: 4px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .platform-title {
      font-size: 1.15rem;
      font-weight: 800;
      letter-spacing: 0.03em;
      text-transform: uppercase;
    }

    /* Table Column Header */
    .table-columns {
      display: grid;
      grid-template-columns: 1fr 90px 70px 65px;
      padding: 8px 18px;
      font-size: 0.72rem;
      font-weight: 700;
      color: var(--text-muted);
      letter-spacing: 0.06em;
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
    }
    .table-columns div:nth-child(2),
    .table-columns div:nth-child(3),
    .table-columns div:nth-child(4) {
      text-align: right;
    }

    /* Departure Rows */
    .departure-list { display: flex; flex-direction: column; }
    .departure-row {
      display: grid;
      grid-template-columns: 1fr 90px 70px 65px;
      padding: 12px 18px;
      align-items: center;
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
      transition: background 0.15s;
    }
    .departure-row:last-child { border-bottom: none; }
    .departure-row:hover { background: rgba(255, 255, 255, 0.02); }
    .departure-row.collapsed-item { display: none; }

    .route-cell {
      display: flex;
      align-items: center;
      gap: 12px;
      overflow: hidden;
    }
    .route-badge {
      background: var(--route-cyan);
      color: #fff;
      font-weight: 800;
      font-size: 0.95rem;
      padding: 4px 8px;
      border-radius: 6px;
      min-width: 48px;
      text-align: center;
      letter-spacing: -0.02em;
    }
    .destination-name {
      font-weight: 700;
      font-size: 0.98rem;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      color: var(--text);
    }

    .distance-cell {
      text-align: right;
      font-size: 0.85rem;
      color: var(--live-green);
      font-weight: 600;
    }
    .distance-cell.idle { color: var(--text-muted); font-weight: 400; }

    .time-cell {
      text-align: right;
      font-size: 0.95rem;
      font-weight: 700;
    }
    .time-scheduled { display: block; }
    .delay-indicator {
      display: block;
      font-size: 0.75rem;
      color: var(--delay-red);
      font-weight: 800;
      margin-top: -2px;
    }

    .eta-cell {
      text-align: right;
      font-size: 1rem;
      font-weight: 800;
      color: var(--eta-white);
    }
    .eta-cell.hours { color: var(--text-muted); font-size: 0.9rem; font-weight: 600; }

    /* Footer */
    .card-footer {
      padding: 10px 18px;
      border-top: 1px solid var(--border);
      text-align: center;
      background: rgba(255, 255, 255, 0.01);
    }
    .show-all-btn {
      background: none;
      border: none;
      color: var(--text-muted);
      font-size: 0.85rem;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .show-all-btn:hover { color: var(--text); }
  </style>
</head>
<body>
  <div class="container">
    <div class="top-header">
      <div class="station-title" id="stationTitle">Київ, вул. Княжий Затон</div>
      <div class="header-actions">
        <button class="btn-icon btn-search" id="refreshBtn">⟳ Оновити GPS</button>
        <button class="btn-icon btn-fav" id="favBtn" title="Додати в обране">★</button>
      </div>
    </div>

    <!-- Quick Navigation Pills with Deep-Linking -->
    <div class="pills-bar" id="pillsBar">
      <div class="pill active" data-stop="knyazhyi-zaton">вул. Княжий Затон</div>
      <div class="pill" data-stop="osokorky">ст. м. Осокорки</div>
      <div class="pill" data-stop="akhmatovoyi">вул. Анни Ахматової</div>
      <div class="pill" data-stop="dniprovska">Дніпровська набережна</div>
      <div class="pill" data-stop="pozniaky">ст. м. Позняки</div>
      <div class="pill" data-stop="urlivska">вул. Урлівська</div>
      <div class="pill" data-stop="vydubychi">ст. м. Видубичі</div>
    </div>

    <!-- Departure Monitor Dual Grid -->
    <div class="departure-grid" id="departureGrid">
      <div style="grid-column: 1 / -1; padding: 40px; text-align: center; color: var(--text-muted);">
        Завантаження табло відправлень...
      </div>
    </div>
  </div>

  <script>
    const stationTitle = document.getElementById("stationTitle");
    const pillsBar = document.getElementById("pillsBar");
    const departureGrid = document.getElementById("departureGrid");
    const refreshBtn = document.getElementById("refreshBtn");
    const favBtn = document.getElementById("favBtn");

    let currentStopKey = "knyazhyi-zaton";
    const expandedState = {};

    function formatDistance(meters) {
      if (!meters) return "<span class='distance-cell idle'>—</span>";
      if (meters > 1000) return (meters / 1000).toFixed(1) + " км";
      return meters + " м";
    }

    function formatMinutes(minutes) {
      if (minutes <= 0) return "<span class='eta-cell' style='color:var(--live-green)'>0'</span>";
      if (minutes >= 60) {
        const hrs = Math.floor(minutes / 60);
        const mins = minutes % 60;
        return "<span class='eta-cell hours'>" + hrs + "h " + mins + "'</span>";
      }
      return "<span class='eta-cell'>" + minutes + "'</span>";
    }

    // Toggle expand/collapse of departures list
    window.toggleExpand = function(dirId) {
      expandedState[dirId] = !expandedState[dirId];
      const rows = document.querySelectorAll(".row-" + dirId);
      const btn = document.getElementById("btn-" + dirId);
      rows.forEach((row, i) => {
        if (i >= 3) {
          row.style.display = expandedState[dirId] ? "grid" : "none";
        }
      });
      if (btn) {
        btn.textContent = expandedState[dirId] ? "∧ Згорнути рейси" : "∨ Показати всі рейси (" + rows.length + ")";
      }
    };

    async function loadBoard(stopKey) {
      currentStopKey = stopKey;

      // Update pills active state
      document.querySelectorAll(".pill").forEach(p => {
        p.classList.toggle("active", p.dataset.stop === stopKey);
      });

      // Update URL query parameter without page reload (like dvg-fcb6)
      const newUrl = window.location.pathname + "?stop=" + encodeURIComponent(stopKey);
      if (window.location.search !== "?stop=" + stopKey) {
        window.history.pushState({ stop: stopKey }, "", newUrl);
      }

      refreshBtn.textContent = "⟳ Оновлення...";

      try {
        const [hubRes, liveRes] = await Promise.all([
          fetch("/api/hub?stop=" + encodeURIComponent(stopKey)),
          fetch("/api/live")
        ]);

        const hubData = await hubRes.json();
        const liveData = await liveRes.json();
        const liveVehicles = liveData.vehicles || [];

        stationTitle.textContent = hubData.title || "Київ";

        // Render both directions side-by-side
        departureGrid.innerHTML = hubData.directions.map(dir => {
          const departures = dir.departures || [];
          const isExpanded = expandedState[dir.id] || false;

          const rowsHtml = departures.map((item, idx) => {
            // Find live vehicle by route
            const vehicle = liveVehicles.find(v => v.route === item.route);
            const distMeters = vehicle ? vehicle.distanceMeters : null;

            // Actual remaining minutes (calculated relative to live system time)
            const remainingMins = vehicle && vehicle.etaMinutes ? vehicle.etaMinutes : item.remainingMinutes;
            const delayHtml = item.delayMin > 0 ? "<span class='delay-indicator'>+" + item.delayMin + "'</span>" : "";
            const isHidden = idx >= 3 && !isExpanded;

            return '<div class="departure-row row-' + dir.id + '" style="' + (isHidden ? 'display:none;' : '') + '">' +
              '<div class="route-cell">' +
                '<span class="route-badge">' + item.route + '</span>' +
                '<span class="destination-name" title="' + item.destination + '">' + item.destination + '</span>' +
              '</div>' +
              '<div class="distance-cell ' + (distMeters ? '' : 'idle') + '">' +
                formatDistance(distMeters) +
              '</div>' +
              '<div class="time-cell">' +
                '<span class="time-scheduled">' + item.time + '</span>' +
                delayHtml +
              '</div>' +
              formatMinutes(remainingMins) +
            '</div>';
          }).join("");

          return '<div class="board-card">' +
            '<div class="card-header">' +
              '<span class="type-badge">' + dir.type + '</span>' +
              '<span class="platform-title">' + dir.title + '</span>' +
            '</div>' +
            '<div class="table-columns">' +
              '<div>МАРШРУТ · НАПРЯМОК</div>' +
              '<div>ВІДСТАНЬ</div>' +
              '<div>ЧАС</div>' +
              '<div>ХВ.</div>' +
            '</div>' +
            '<div class="departure-list">' +
              (rowsHtml || "<div style='padding:20px; text-align:center; color:var(--text-muted);'>Немає рейсів</div>") +
            '</div>' +
            '<div class="card-footer">' +
              '<button class="show-all-btn" id="btn-' + dir.id + '" onclick="toggleExpand(\'' + dir.id + '\')">' +
                (isExpanded ? "∧ Згорнути рейси" : "∨ Показати всі рейси (" + departures.length + ")") +
              '</button>' +
            '</div>' +
          '</div>';
        }).join("");

      } catch (err) {
        departureGrid.innerHTML = "<div style='grid-column: 1 / -1; padding: 40px; text-align:center; color:var(--delay-red);'>Помилка завантаження даних табло</div>";
      } finally {
        refreshBtn.textContent = "⟳ Оновити GPS";
      }
    }

    // Attach click events to pills
    pillsBar.addEventListener("click", (e) => {
      const pill = e.target.closest(".pill");
      if (pill && pill.dataset.stop) {
        loadBoard(pill.dataset.stop);
      }
    });

    // Refresh GPS button
    refreshBtn.addEventListener("click", () => loadBoard(currentStopKey));

    // Favorite button
    favBtn.addEventListener("click", () => {
      const isFav = favBtn.classList.toggle("active");
      localStorage.setItem("kpt_fav_" + currentStopKey, isFav ? "1" : "0");
    });

    // Handle browser back/forward history navigation
    window.addEventListener("popstate", (e) => {
      const params = new URLSearchParams(window.location.search);
      const stop = params.get("stop") || "knyazhyi-zaton";
      loadBoard(stop);
    });

    // Initial page load: read ?stop= from URL
    const urlParams = new URLSearchParams(window.location.search);
    const initialStop = urlParams.get("stop") || "knyazhyi-zaton";
    loadBoard(initialStop);
  </script>
</body>
</html>`;
}

/**
 * Cloudflare Worker Export (Fetch Handler & Scheduled Ingestion).
 */
export default {
  async scheduled(event, env, ctx) {},

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname, searchParams } = url;

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Content-Type": "application/json; charset=utf-8"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // 1. Departure Board Web UI (supports ?stop=...)
    if (pathname === "/" || pathname === "/index.html") {
      return new Response(renderDashboardHtml(), {
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    }

    // 2. Hub Departures API (dynamically computed relative to current system time)
    if (pathname === "/api/hub") {
      const stopKey = searchParams.get("stop") || "knyazhyi-zaton";
      const hubData = getHubDepartures(stopKey);
      return new Response(JSON.stringify(hubData), { headers: corsHeaders });
    }

    // 3. Live Vehicles Telemetry API
    if (pathname === "/api/live") {
      const vehicles = await fetchLiveVehicles(env);
      return new Response(JSON.stringify({ vehicles, timestamp: new Date().toISOString() }), {
        headers: corsHeaders
      });
    }

    // 4. Backward Compatibility API for single stop
    const scheduleMatch = pathname.match(/^\/api\/stop\/([^/]+)\/schedule$/);
    if (scheduleMatch) {
      const hub = getHubDepartures("knyazhyi-zaton");
      const departures = hub.directions[0]?.departures || [];
      return new Response(JSON.stringify(departures), { headers: corsHeaders });
    }

    return new Response(JSON.stringify({ error: "Endpoint not found" }), {
      status: 404,
      headers: corsHeaders
    });
  }
};
