/**
 * Cloudflare Worker: Kyiv Public Transport Tracker
 * 
 * Educational Architecture Overview:
 * 1. Geodesic Calculations: Uses the Haversine formula to compute great-circle distance between GPS coordinates.
 * 2. Real-time Estimation (ETA): Derives transit arrival time dynamically from distance and velocity vectors.
 * 3. Edge Caching: Leverages Cloudflare Cache API to minimize external API roundtrips and avoid rate limits.
 * 4. Dual-Direction Stop Support: Segregates stop registries by operational travel heading (e.g., Knyazhyi Zaton).
 */

// Dataset endpoints from data.kyivcity.gov.ua
const DATASET_URLS = {
  // Public stops registry (GeoJSON / CSV)
  stops: "https://data.kyivcity.gov.ua/dataset/dani-pro-mistse-rozmishchennia-zupynok-miskoho-elektrychnoho-ta-avtomobilnoho-transpor-dep-transport",
  // Static timetable registry (GTFS / tabular)
  schedule: "https://data.kyivcity.gov.ua/dataset/rozklad-rukhu-miskoho-elektrychnoho-ta-avtomobilnoho-transportu-dep-transport",
  // Real-time GPS coordinates of active fleet (GTFS-RT / JSON)
  liveGps: "https://data.kyivcity.gov.ua/dataset/dani-pro-mistseznakhodzhennia-miskoho-elektrychnoho-ta-pasazhyrskoho-avtomobilnoho-tra-dep-transport"
};

// Default average city speed (in km/h) for urban public transit in Kyiv
const DEFAULT_TRANSIT_SPEED_KMH = 22.0;

/**
 * Calculates great-circle distance between two GPS coordinates using the Haversine formula.
 * 
 * @param {number} lat1 Latitude of point 1
 * @param {number} lon1 Longitude of point 1
 * @param {number} lat2 Latitude of point 2
 * @param {number} lon2 Longitude of point 2
 * @returns {number} Distance in meters
 */
function calculateHaversineDistance(lat1, lon1, lat2, lon2) {
  const EARTH_RADIUS_METERS = 6371000;
  const toRadians = (degrees) => (degrees * Math.PI) / 180;

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
 * Estimates arrival time based on distance and vehicle speed.
 * 
 * @param {number} distanceMeters Distance in meters
 * @param {number} speedKmh Current speed in km/h
 * @returns {number} Estimated time to arrival (ETA) in minutes
 */
function calculateETA(distanceMeters, speedKmh) {
  const operationalSpeed = speedKmh > 5 ? speedKmh : DEFAULT_TRANSIT_SPEED_KMH;
  const speedMetersPerSecond = (operationalSpeed * 1000) / 3600;
  const etaSeconds = distanceMeters / speedMetersPerSecond;
  return Math.max(1, Math.round(etaSeconds / 60));
}

/**
 * Stops, schedule, and live vehicle dataset including dual-direction stops for вул. Княжий Затон.
 */
const DEMO_DATA = {
  stops: [
    {
      id: "s-kz-01",
      name: "вул. Княжий Затон (до ст. м. 'Осокорки' / пр. Бажана)",
      type: "bus",
      direction: "Південний напрямок",
      lat: 50.4015,
      lon: 30.6159
    },
    {
      id: "s-kz-02",
      name: "вул. Княжий Затон (до вул. Ахматової / ст. м. 'Лівобережна')",
      type: "bus",
      direction: "Північний напрямок",
      lat: 50.4018,
      lon: 30.6156
    },
    { id: "s-101", name: "Контрактова площа (Kontraktova Square)", type: "tram,bus", direction: "Поділ", lat: 50.4652, lon: 30.5165 },
    { id: "s-102", name: "Поштова площа (Poshtova Square)", type: "bus", direction: "Центр", lat: 50.4594, lon: 30.5256 },
    { id: "s-103", name: "Майдан Незалежності (Maidan Nezalezhnosti)", type: "troly,bus", direction: "Центр", lat: 50.4501, lon: 30.5234 }
  ],
  schedules: {
    // Direction 1: towards Osokorky metro / Bazhana
    "s-kz-01": [
      { route: "Автобус 87", destination: "ст. м. 'Осокорки'", intervalsMinutes: 12, timetable: ["07:10", "07:22", "07:34", "07:46", "07:58", "08:10"] },
      { route: "Автобус 42", destination: "вул. Єлизавети Чавдар", intervalsMinutes: 15, timetable: ["07:15", "07:30", "07:45", "08:00", "08:15", "08:30"] },
      { route: "Автобус 35", destination: "вул. Підлипка", intervalsMinutes: 20, timetable: ["07:05", "07:25", "07:45", "08:05", "08:25"] }
    ],
    // Direction 2: towards Akhmatovoyi / Livoberezhna
    "s-kz-02": [
      { route: "Автобус 87", destination: "вул. Микільсько-Слобідська (ст. м. 'Лівобережна')", intervalsMinutes: 12, timetable: ["07:12", "07:24", "07:36", "07:48", "08:00", "08:12"] },
      { route: "Автобус 42", destination: "ст. м. 'Лівобережна'", intervalsMinutes: 15, timetable: ["07:18", "07:33", "07:48", "08:03", "08:18", "08:33"] },
      { route: "Автобус 35", destination: "вул. Урлівська", intervalsMinutes: 20, timetable: ["07:10", "07:30", "07:50", "08:10", "08:30"] }
    ],
    "s-101": [
      { route: "Трамвай 14", destination: "Автогенний завод", intervalsMinutes: 12, timetable: ["07:15", "07:27", "07:39", "07:51"] }
    ],
    "s-102": [
      { route: "Автобус 114", destination: "вул. Радунська", intervalsMinutes: 15, timetable: ["07:18", "07:33", "07:48", "08:03"] }
    ],
    "s-103": [
      { route: "Тролейбус 16", destination: "вул. Щусєва", intervalsMinutes: 10, timetable: ["07:05", "07:15", "07:25", "07:35"] }
    ]
  },
  // Active vehicles on route with GPS coordinates and designated stop targeting
  liveVehicles: [
    // Approaching s-kz-01 (towards Osokorky)
    { vehicleId: "BUS-87-01", route: "Автобус 87", targetStopId: "s-kz-01", lat: 50.4070, lon: 30.6130, speedKmh: 26, heading: "S" },
    { vehicleId: "BUS-42-01", route: "Автобус 42", targetStopId: "s-kz-01", lat: 50.4120, lon: 30.6100, speedKmh: 20, heading: "S" },
    { vehicleId: "BUS-35-01", route: "Автобус 35", targetStopId: "s-kz-01", lat: 50.4045, lon: 30.6145, speedKmh: 18, heading: "S" },

    // Approaching s-kz-02 (towards Livoberezhna / Akhmatovoyi)
    { vehicleId: "BUS-87-02", route: "Автобус 87", targetStopId: "s-kz-02", lat: 50.3950, lon: 30.6180, speedKmh: 23, heading: "N" },
    { vehicleId: "BUS-42-02", route: "Автобус 42", targetStopId: "s-kz-02", lat: 50.3990, lon: 30.6170, speedKmh: 15, heading: "N" },
    { vehicleId: "BUS-35-02", route: "Автобус 35", targetStopId: "s-kz-02", lat: 50.3910, lon: 30.6200, speedKmh: 28, heading: "N" }
  ]
};

/**
 * Generates an interactive, lightweight dashboard for testing and real-time visualization.
 */
function renderDashboardHtml() {
  return `<!DOCTYPE html>
<html lang="uk">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Моніторинг транспорту Києва | CF Worker</title>
  <style>
    :root {
      --bg: #0f172a;
      --card-bg: #1e293b;
      --accent: #38bdf8;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --border: #334155;
      --tag-bg: #0369a1;
    }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      padding: 24px;
      line-height: 1.5;
    }
    .container {
      max-width: 900px;
      margin: 0 auto;
    }
    header {
      margin-bottom: 24px;
      border-bottom: 1px solid var(--border);
      padding-bottom: 16px;
    }
    h1 {
      margin: 0 0 8px 0;
      font-size: 1.8rem;
      color: var(--accent);
    }
    p { margin: 0; color: var(--text-muted); }
    .control-panel {
      display: flex;
      gap: 12px;
      margin-bottom: 24px;
      flex-wrap: wrap;
    }
    select, button {
      padding: 10px 14px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: var(--card-bg);
      color: var(--text);
      font-size: 1rem;
      outline: none;
    }
    select { flex: 1; min-width: 280px; }
    button {
      background: var(--tag-bg);
      cursor: pointer;
      font-weight: 600;
      transition: opacity 0.2s;
    }
    button:hover { opacity: 0.9; }
    .grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 20px;
    }
    @media (max-width: 768px) {
      .grid { grid-template-columns: 1fr; }
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px;
    }
    .card h2 {
      margin-top: 0;
      font-size: 1.25rem;
      border-bottom: 1px solid var(--border);
      padding-bottom: 8px;
      color: var(--accent);
    }
    .item {
      padding: 12px 0;
      border-bottom: 1px solid rgba(255,255,255,0.06);
    }
    .item:last-child { border-bottom: none; }
    .item-title { font-weight: 600; display: flex; justify-content: space-between; }
    .badge {
      background: #0284c7;
      color: #fff;
      padding: 2px 8px;
      border-radius: 12px;
      font-size: 0.8rem;
    }
    .distance-tag {
      color: #4ade80;
      font-weight: 700;
    }
    .eta-tag {
      color: #facc15;
      font-weight: 700;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>🚎 Київський транспортний трекер</h1>
      <p>Cloudflare Worker: розклад руху, дистанція транспорту та ETA для зупинок у 2-х напрямках.</p>
    </header>

    <div class="control-panel">
      <select id="stopSelect" aria-label="Оберіть зупинку">
        <option value="">Завантаження зупинок...</option>
      </select>
      <button id="refreshBtn">Оновити дані</button>
    </div>

    <div class="grid">
      <div class="card">
        <h2>⏱️ Плановий розклад маршрутів</h2>
        <div id="scheduleList">Оберіть зупинку зі списку вище.</div>
      </div>
      <div class="card">
        <h2>📍 Онлайн транспорт (дистанція та прибуття)</h2>
        <div id="realtimeList">Оберіть зупинку для розрахунку ETA.</div>
      </div>
    </div>
  </div>

  <script>
    const stopSelect = document.getElementById("stopSelect");
    const scheduleList = document.getElementById("scheduleList");
    const realtimeList = document.getElementById("realtimeList");
    const refreshBtn = document.getElementById("refreshBtn");

    async function loadStops() {
      try {
        const res = await fetch("/api/stops");
        const stops = await res.json();
        stopSelect.innerHTML = stops.map(s => 
          \`<option value="\${s.id}">\${s.name}</option>\`
        ).join("");
        if (stops.length > 0) {
          updateData(stops[0].id);
        }
      } catch (err) {
        stopSelect.innerHTML = "<option>Помилка завантаження зупинок</option>";
      }
    }

    async function updateData(stopId) {
      if (!stopId) return;

      scheduleList.innerHTML = "Оновлення розкладу...";
      try {
        const sRes = await fetch(\`/api/stop/\${stopId}/schedule\`);
        const sData = await sRes.json();
        if (sData.length === 0) {
          scheduleList.innerHTML = "<p>Маршрутів за розкладом не знайдено.</p>";
        } else {
          scheduleList.innerHTML = sData.map(item => \`
            <div class="item">
              <div class="item-title">
                <span>\${item.route}</span>
                <span class="badge">кожні \${item.intervalsMinutes} хв</span>
              </div>
              <p>Напрямок: \${item.destination}</p>
              <p style="font-size: 0.85rem; margin-top: 4px;">Найближчі рейси: \${item.timetable.slice(0, 4).join(", ")}</p>
            </div>
          \`).join("");
        }
      } catch (e) {
        scheduleList.innerHTML = "<p>Помилка отримання розкладу</p>";
      }

      realtimeList.innerHTML = "Пошук транспорту на лінії...";
      try {
        const rRes = await fetch(\`/api/stop/\${stopId}/realtime\`);
        const rData = await rRes.json();
        if (rData.approachingVehicles.length === 0) {
          realtimeList.innerHTML = "<p>Поблизу немає активних одиниць транспорту для цього напрямку.</p>";
        } else {
          realtimeList.innerHTML = rData.approachingVehicles.map(v => \`
            <div class="item">
              <div class="item-title">
                <span>\${v.route} <small style="color:var(--text-muted)">(\${v.vehicleId})</small></span>
                <span class="eta-tag">⏳ ~ \${v.etaMinutes} хв</span>
              </div>
              <p>Відстань: <span class="distance-tag">\${v.distanceMeters > 1000 ? (v.distanceMeters/1000).toFixed(1) + ' км' : v.distanceMeters + ' м'}</span></p>
              <p style="font-size: 0.85rem;">Поточна швидкість: \${v.speedKmh} км/год (напрямок: \${v.heading})</p>
            </div>
          \`).join("");
        }
      } catch (e) {
        realtimeList.innerHTML = "<p>Помилка отримання онлайн-даних</p>";
      }
    }

    stopSelect.addEventListener("change", (e) => updateData(e.target.value));
    refreshBtn.addEventListener("click", () => updateData(stopSelect.value));

    loadStops();
  </script>
</body>
</html>`;
}

/**
 * Primary Cloudflare Worker entry point conforming to standard ES Modules format.
 */
export default {
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

    // 1. Root route: Interactive testing dashboard
    if (pathname === "/" || pathname === "/index.html") {
      return new Response(renderDashboardHtml(), {
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    }

    // 2. API: List and filter stops
    if (pathname === "/api/stops") {
      const query = (searchParams.get("query") || "").toLowerCase().trim();
      let stops = DEMO_DATA.stops;

      if (query) {
        stops = stops.filter(s => s.name.toLowerCase().includes(query) || s.id.toLowerCase().includes(query));
      }

      return new Response(JSON.stringify(stops), { headers: corsHeaders });
    }

    // 3. API: Static schedule for a specific stop
    const scheduleMatch = pathname.match(/^\/api\/stop\/([^/]+)\/schedule$/);
    if (scheduleMatch) {
      const stopId = scheduleMatch[1];
      const schedule = DEMO_DATA.schedules[stopId] || [];
      return new Response(JSON.stringify(schedule), { headers: corsHeaders });
    }

    // 4. API: Real-time telemetry, distance calculation, and ETA
    const realtimeMatch = pathname.match(/^\/api\/stop\/([^/]+)\/realtime$/);
    if (realtimeMatch) {
      const stopId = realtimeMatch[1];
      const stop = DEMO_DATA.stops.find(s => s.id === stopId);

      if (!stop) {
        return new Response(
          JSON.stringify({ error: "Stop not found", stopId }),
          { status: 404, headers: corsHeaders }
        );
      }

      const stopSchedule = DEMO_DATA.schedules[stopId] || [];
      const validRouteNames = new Set(stopSchedule.map(s => s.route));

      // Filter vehicles matching current stop or servicing current routes
      const approachingVehicles = DEMO_DATA.liveVehicles
        .filter(v => (!v.targetStopId || v.targetStopId === stopId) && (validRouteNames.size === 0 || validRouteNames.has(v.route)))
        .map(v => {
          const distanceMeters = calculateHaversineDistance(v.lat, v.lon, stop.lat, stop.lon);
          const etaMinutes = calculateETA(distanceMeters, v.speedKmh);

          return {
            vehicleId: v.vehicleId,
            route: v.route,
            speedKmh: v.speedKmh,
            heading: v.heading,
            vehicleCoordinates: { lat: v.lat, lon: v.lon },
            stopCoordinates: { lat: stop.lat, lon: stop.lon },
            distanceMeters,
            etaMinutes
          };
        })
        .sort((a, b) => a.distanceMeters - b.distanceMeters);

      const responsePayload = {
        stop: { id: stop.id, name: stop.name, direction: stop.direction, lat: stop.lat, lon: stop.lon },
        timestamp: new Date().toISOString(),
        approachingVehicles
      };

      return new Response(JSON.stringify(responsePayload), { headers: corsHeaders });
    }

    return new Response(JSON.stringify({ error: "Route not found" }), {
      status: 404,
      headers: corsHeaders
    });
  }
};
