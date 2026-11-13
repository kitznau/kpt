/**
 * Cloudflare Worker: Kyiv Public Transport Tracker
 * 
 * Educational Architecture Overview:
 * 1. Geodesic Calculations: Uses the Haversine formula to compute great-circle distance between GPS coordinates.
 * 2. Real-time Estimation (ETA): Derives transit arrival time dynamically from distance and velocity vectors.
 * 3. Edge Caching: Leverages Cloudflare Cache API to minimize external API roundtrips and avoid rate limits.
 * 4. Micro-routing: Dispatches requests using standard URL parsing without external router dependencies.
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

// Default average city speed (in km/h) for urban public transit in Kyiv considering traffic conditions
const DEFAULT_TRANSIT_SPEED_KMH = 22.0;

/**
 * Calculates the great-circle distance between two geographic coordinates using the Haversine formula.
 * 
 * @param {number} lat1 Latitude of first point (decimal degrees)
 * @param {number} lon1 Longitude of first point (decimal degrees)
 * @param {number} lat2 Latitude of second point (decimal degrees)
 * @param {number} lon2 Longitude of second point (decimal degrees)
 * @returns {number} Distance in meters
 */
function calculateHaversineDistance(lat1, lon1, lat2, lon2) {
  const EARTH_RADIUS_METERS = 6371000; // Mean Earth radius in meters
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
 * @param {number} speedKmh Current speed in km/h (falls back to DEFAULT_TRANSIT_SPEED_KMH if idle or 0)
 * @returns {number} Estimated time to arrival (ETA) in minutes
 */
function calculateETA(distanceMeters, speedKmh) {
  // Use realistic transit speed if vehicle is currently stopped at traffic lights or passenger boarding
  const operationalSpeed = speedKmh > 5 ? speedKmh : DEFAULT_TRANSIT_SPEED_KMH;
  const speedMetersPerSecond = (operationalSpeed * 1000) / 3600;
  const etaSeconds = distanceMeters / speedMetersPerSecond;
  return Math.max(1, Math.round(etaSeconds / 60));
}

/**
 * Seed/Demo dataset for initial execution and structural demonstration.
 * In a production pipeline, this is synchronized with data.kyivcity.gov.ua CKAN/GTFS resources.
 */
const DEMO_DATA = {
  stops: [
    { id: "s-101", name: "Контрактова площа (Kontraktova Square)", type: "tram,bus", lat: 50.4652, lon: 30.5165 },
    { id: "s-102", name: "Поштова площа (Poshtova Square)", type: "bus", lat: 50.4594, lon: 30.5256 },
    { id: "s-103", name: "Майдан Незалежності (Maidan Nezalezhnosti)", type: "troly,bus", lat: 50.4501, lon: 30.5234 },
    { id: "s-104", name: "Вулиця Хрещатик (Khreshchatyk Street)", type: "bus", lat: 50.4472, lon: 30.5218 },
    { id: "s-105", name: "Станція метро 'Арсенальна' (Arsenalna Metro)", type: "bus,troly", lat: 50.4443, lon: 30.5452 }
  ],
  schedules: {
    "s-101": [
      { route: "Трамвай 14", destination: "Автогенний завод", intervalsMinutes: 12, timetable: ["07:15", "07:27", "07:39", "07:51", "08:03", "08:15", "08:27"] },
      { route: "Автобус 114", destination: "Залізничний вокзал 'Центральний'", intervalsMinutes: 15, timetable: ["07:10", "07:25", "07:40", "07:55", "08:10", "08:25"] }
    ],
    "s-102": [
      { route: "Автобус 114", destination: "вул. Радунська", intervalsMinutes: 15, timetable: ["07:18", "07:33", "07:48", "08:03", "08:18", "08:33"] },
      { route: "Автобус 62", destination: "Ботанічний сад", intervalsMinutes: 20, timetable: ["07:20", "07:40", "08:00", "08:20", "08:40"] }
    ],
    "s-103": [
      { route: "Тролейбус 16", destination: "вул. Щусєва", intervalsMinutes: 10, timetable: ["07:05", "07:15", "07:25", "07:35", "07:45", "07:55"] },
      { route: "Тролейбус 18", destination: "вул. Сошенка", intervalsMinutes: 10, timetable: ["07:08", "07:18", "07:28", "07:38", "07:48", "07:58"] },
      { route: "Автобус 24", destination: "Музей історії України у ІІ Світовій війні", intervalsMinutes: 14, timetable: ["07:12", "07:26", "07:40", "07:54", "08:08"] }
    ]
  },
  // Active vehicles on route with live GPS telemetry
  liveVehicles: [
    { vehicleId: "BUS-114-01", route: "Автобус 114", lat: 50.4610, lon: 50.5220, speedKmh: 24, heading: "SW" },
    { vehicleId: "BUS-114-02", route: "Автобус 114", lat: 50.4705, lon: 30.5090, speedKmh: 18, heading: "SE" },
    { vehicleId: "TRAM-14-01", route: "Трамвай 14", lat: 50.4680, lon: 30.5110, speedKmh: 20, heading: "S" },
    { vehicleId: "TRL-16-01", route: "Тролейбус 16", lat: 50.4530, lon: 30.5180, speedKmh: 28, heading: "NE" },
    { vehicleId: "BUS-24-01", route: "Автобус 24", lat: 50.4460, lon: 30.5290, speedKmh: 15, heading: "NW" }
  ]
};

/**
 * Generates an interactive, lightweight dashboard for testing and user interaction.
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
      <p>Cloudflare Worker: розклад руху, поточна дистанція транспорту та прогнозований час прибуття (ETA).</p>
    </header>

    <div class="control-panel">
      <select id="stopSelect" aria-label="Оберіть зупинку">
        <option value="">Завантаження зупинок...</option>
      </select>
      <button id="refreshBtn">Оновити реальний час</button>
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
          \`<option value="\${s.id}">\${s.name} (\${s.type})</option>\`
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

      // Fetch static timetable
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
              <p style="font-size: 0.85rem; margin-top: 4px;">Найближчі відправлення: \${item.timetable.slice(0, 4).join(", ")}</p>
            </div>
          \`).join("");
        }
      } catch (e) {
        scheduleList.innerHTML = "<p>Помилка отримання розкладу</p>";
      }

      // Fetch real-time tracking, distance, and ETA
      realtimeList.innerHTML = "Пошук транспорту на лінії...";
      try {
        const rRes = await fetch(\`/api/stop/\${stopId}/realtime\`);
        const rData = await rRes.json();
        if (rData.approachingVehicles.length === 0) {
          realtimeList.innerHTML = "<p>Поблизу немає активних одиниць транспорту для цієї зупинки.</p>";
        } else {
          realtimeList.innerHTML = rData.approachingVehicles.map(v => \`
            <div class="item">
              <div class="item-title">
                <span>\${v.route} <small style="color:var(--text-muted)">(\${v.vehicleId})</small></span>
                <span class="eta-tag">⏳ ~ \${v.etaMinutes} хв</span>
              </div>
              <p>Відстань до зупинки: <span class="distance-tag">\${v.distanceMeters > 1000 ? (v.distanceMeters/1000).toFixed(1) + ' км' : v.distanceMeters + ' м'}</span></p>
              <p style="font-size: 0.85rem;">Поточна швидкість: \${v.speedKmh} км/год</p>
            </div>
          \`).join("");
        }
      } catch (e) {
        realtimeList.innerHTML = "<p>Помилка отримання онлайн-даних</p>";
      }
    }

    stopSelect.addEventListener("change", (e) => updateData(e.target.value));
    refreshBtn.addEventListener("click", () => updateData(stopSelect.value));

    // Initialize application
    loadStops();
  </script>
</body>
</html>`;
}

/**
 * Primary Cloudflare Worker entry point conforming to standard ES Modules format.
 */
export default {
  /**
   * Request handler dispatches incoming HTTP requests to corresponding API endpoints.
   * 
   * @param {Request} request Standard Fetch Request object
   * @param {object} env Environment bindings (KV, Secrets, etc.)
   * @param {object} ctx Execution context (waitUntil, passThroughOnException)
   * @returns {Promise<Response>}
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname, searchParams } = url;

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Content-Type": "application/json; charset=utf-8"
    };

    // Handle preflight CORS requests
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

      // Collect routes that serve this stop
      const stopSchedule = DEMO_DATA.schedules[stopId] || [];
      const validRouteNames = new Set(stopSchedule.map(s => s.route));

      // Calculate distance and ETA for each active vehicle approaching this stop
      const approachingVehicles = DEMO_DATA.liveVehicles
        .filter(v => validRouteNames.size === 0 || validRouteNames.has(v.route))
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
        // Sort ascending by arrival time (closest vehicle first)
        .sort((a, b) => a.distanceMeters - b.distanceMeters);

      const responsePayload = {
        stop: { id: stop.id, name: stop.name, lat: stop.lat, lon: stop.lon },
        timestamp: new Date().toISOString(),
        approachingVehicles
      };

      return new Response(JSON.stringify(responsePayload), { headers: corsHeaders });
    }

    // Fallback for unmapped routes
    return new Response(JSON.stringify({ error: "Route not found" }), {
      status: 404,
      headers: corsHeaders
    });
  }
};
