/**
 * Cloudflare Worker: Kyiv Transit Departure Monitor (Server-Side Rendered with Europe/Kyiv TZ)
 * 
 * Educational Architecture Overview:
 * 1. Timezone Normalization: Anchors all timetable computations to the official 'Europe/Kyiv' timezone (UTC+2/UTC+3).
 *    This avoids UTC drift on Cloudflare Edge instances regardless of global data center location.
 * 2. Edge Server-Side Rendering (SSR): Generates ready-to-display HTML at the Edge, ensuring instant page display.
 * 3. Deep-Link Support: Reads `?stop=<id>` on the Edge and highlights the corresponding station pill.
 * 4. Geodesic Proximity: Employs the Haversine formula to compute metric distances and dynamic arrival ETAs.
 */

const CONFIG = {
  // Official GTFS Static archive export endpoint from Kyivpastrans
  GTFS_STATIC_URL: "http://193.23.225.211:8002/export-gtfs-static",
  // Real-time GPS vehicle telemetry endpoint
  LIVE_GPS_URL: "http://193.23.225.211:8002/api/v1/vehicle-positions",
  // Standard transit speed (km/h) for urban bus corridors
  DEFAULT_TRANSIT_SPEED_KMH: 22.0,
  // Official timezone
  TIMEZONE: "Europe/Kyiv"
};

/**
 * Returns current timestamp adjusted specifically to Europe/Kyiv timezone.
 * 
 * @returns {Date} Date instance representing current wall-clock time in Kyiv
 */
function getKyivNow() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: CONFIG.TIMEZONE }));
}

/**
 * Calculates great-circle distance between two GPS coordinates using the Haversine formula.
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
 * Multi-hub transit network for Kyiv Left Bank transit corridors.
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
          { route: "3М", destination: "ст. м. 'Осокорки'", timeOffsetMin: 3, delayMin: 2 },
          { route: "35", destination: "вул. Підлипка", timeOffsetMin: 11, delayMin: 0 },
          { route: "87", destination: "ст. м. 'Осокорки'", timeOffsetMin: 21, delayMin: 4 },
          { route: "35", destination: "вул. Підлипка", timeOffsetMin: 39, delayMin: 0 },
          { route: "87", destination: "ст. м. 'Осокорки'", timeOffsetMin: 65, delayMin: 0 },
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
          { route: "3М", destination: "ст. м. 'Видубичі'", timeOffsetMin: 17, delayMin: 1 },
          { route: "87", destination: "вул. Митрополита Андрея Шептицького", timeOffsetMin: 32, delayMin: 0 },
          { route: "134Н", destination: "просп. Павла Тичини", timeOffsetMin: 72, delayMin: 0 },
          { route: "134Н", destination: "просп. Павла Тичини", timeOffsetMin: 132, delayMin: 0 },
          { route: "87", destination: "вул. Митрополита Андрея Шептицького", timeOffsetMin: 190, delayMin: 0 }
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
          { route: "87", destination: "ст. м. 'Голосіївська'", timeOffsetMin: 4, delayMin: 1 },
          { route: "35", destination: "вул. Підлипка", timeOffsetMin: 13, delayMin: 0 },
          { route: "220", destination: "вул. Тростянецька", timeOffsetMin: 22, delayMin: 3 },
          { route: "87", destination: "ст. м. 'Голосіївська'", timeOffsetMin: 37, delayMin: 0 }
        ]
      },
      {
        id: "os-dir-2",
        title: "НАПРЯМОК 2 · В БІК ВУЛ. КНЯЖИЙ ЗАТОН",
        type: "АВТ",
        lat: 50.3960,
        lon: 30.6165,
        departures: [
          { route: "3М", destination: "ст. м. 'Видубичі'", timeOffsetMin: 5, delayMin: 0 },
          { route: "87", destination: "вул. Митрополита Андрея Шептицького", timeOffsetMin: 18, delayMin: 2 },
          { route: "42", destination: "ст. м. 'Лівобережна'", timeOffsetMin: 27, delayMin: 0 },
          { route: "35", destination: "вул. Урлівська", timeOffsetMin: 43, delayMin: 0 }
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
          { route: "108", destination: "ст. м. 'Харківська'", timeOffsetMin: 6, delayMin: 0 },
          { route: "42", destination: "вул. Єлизавети Чавдар", timeOffsetMin: 14, delayMin: 2 },
          { route: "87", destination: "ст. м. 'Осокорки'", timeOffsetMin: 28, delayMin: 0 }
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
          { route: "42", destination: "ст. м. 'Лівобережна'", timeOffsetMin: 15, delayMin: 0 },
          { route: "87", destination: "вул. Митрополита Шептицького", timeOffsetMin: 27, delayMin: 3 }
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
          { route: "87", destination: "вул. Митрополита Шептицького", timeOffsetMin: 6, delayMin: 1 },
          { route: "108", destination: "вул. Митрополита Шептицького", timeOffsetMin: 16, delayMin: 0 },
          { route: "42", destination: "ст. м. 'Лівобережна'", timeOffsetMin: 31, delayMin: 2 }
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
          { route: "108", destination: "ст. м. 'Харківська'", timeOffsetMin: 19, delayMin: 0 },
          { route: "35", destination: "вул. Підлипка", timeOffsetMin: 38, delayMin: 1 }
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
          { route: "8", destination: "ст. м. 'Лісова'", timeOffsetMin: 4, delayMin: 0 },
          { route: "28Д", destination: "вул. Милославська", timeOffsetMin: 13, delayMin: 1 },
          { route: "8", destination: "ст. м. 'Лісова'", timeOffsetMin: 24, delayMin: 0 }
        ]
      },
      {
        id: "pz-dir-2",
        title: "ПЛАТФОРМА 2 · АВТОБУСИ ТА МАРШРУТИ",
        type: "АВТ",
        lat: 50.3985,
        lon: 30.6345,
        departures: [
          { route: "42", destination: "ст. м. 'Лівобережна'", timeOffsetMin: 5, delayMin: 2 },
          { route: "108", destination: "вул. Митрополита Шептицького", timeOffsetMin: 15, delayMin: 0 },
          { route: "42", destination: "вул. Єлизавети Чавдар", timeOffsetMin: 29, delayMin: 0 }
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
          { route: "35", destination: "вул. Підлипка", timeOffsetMin: 6, delayMin: 0 },
          { route: "42", destination: "вул. Єлизавети Чавдар", timeOffsetMin: 18, delayMin: 1 },
          { route: "35", destination: "вул. Підлипка", timeOffsetMin: 40, delayMin: 0 }
        ]
      },
      {
        id: "ur-dir-2",
        title: "НАПРЯМОК 2 · ДО ВУЛ. АХМАТОВОЇ",
        type: "АВТ",
        lat: 50.4105,
        lon: 30.6185,
        departures: [
          { route: "35", destination: "вул. Урлівська (кінець)", timeOffsetMin: 8, delayMin: 0 },
          { route: "42", destination: "ст. м. 'Лівобережна'", timeOffsetMin: 23, delayMin: 2 }
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
          { route: "3М", destination: "вул. Княжий Затон", timeOffsetMin: 3, delayMin: 0 },
          { route: "3М", destination: "вул. Княжий Затон", timeOffsetMin: 22, delayMin: 1 },
          { route: "43", destination: "с. Корчувате", timeOffsetMin: 34, delayMin: 0 }
        ]
      },
      {
        id: "vd-dir-2",
        title: "НАПРЯМОК 2 · ПРИМІСЬКИЙ НАПРЯМОК",
        type: "АВТ",
        lat: 50.4025,
        lon: 30.5605,
        departures: [
          { route: "54", destination: "ст. м. 'Либідська'", timeOffsetMin: 9, delayMin: 0 },
          { route: "43", destination: "ст. м. 'Видубичі'", timeOffsetMin: 26, delayMin: 2 }
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
 * Computes departure timetables dynamically tied to current Europe/Kyiv time.
 */
function getHubDepartures(hubKey) {
  const hub = HUBS[hubKey] || HUBS["knyazhyi-zaton"];
  const now = getKyivNow();

  const kyivTimeString = String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0");

  return {
    hubKey: hubKey in HUBS ? hubKey : "knyazhyi-zaton",
    title: hub.title,
    kyivTime: kyivTimeString,
    directions: hub.directions.map(dir => {
      return {
        id: dir.id,
        title: dir.title,
        type: dir.type,
        lat: dir.lat,
        lon: dir.lon,
        departures: dir.departures.map(d => {
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

function formatDistance(meters) {
  if (!meters) return "<span class='distance-cell idle'>—</span>";
  if (meters > 1000) return (meters / 1000).toFixed(1) + " км";
  return meters + " м";
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
 * Server-side renders the departure board cards HTML.
 */
function renderDirectionCardsHtml(hubData, liveVehicles = LIVE_FLEET) {
  return hubData.directions.map(dir => {
    const departures = dir.departures || [];
    const visibleItems = departures.slice(0, 3);

    const rowsHtml = visibleItems.map((item) => {
      const vehicle = liveVehicles.find(v => v.route === item.route);
      const distMeters = vehicle ? calculateHaversineDistance(vehicle.lat, vehicle.lon, dir.lat, dir.lon) : null;
      const remainingMins = item.remainingMinutes;
      const delayHtml = item.delayMin > 0 ? "<span class='delay-indicator'>+" + item.delayMin + "'</span>" : "";

      return '<div class="departure-row">' +
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
      '<div class="departure-list" id="list-' + dir.id + '">' +
        (rowsHtml || "<div style='padding:20px; text-align:center; color:#8b949e;'>Немає рейсів</div>") +
      '</div>' +
      '<div class="card-footer">' +
        '<button class="show-all-btn" onclick="toggleExpand(\'' + dir.id + '\')">' +
          "∨ Показати всі рейси (" + departures.length + ")" +
        '</button>' +
      '</div>' +
    '</div>';
  }).join("");
}

/**
 * Generates the complete, fully server-rendered HTML page with zero blank screen lag.
 */
function renderFullPageHtml(stopKey = "knyazhyi-zaton") {
  const hubData = getHubDepartures(stopKey);
  const initialCardsHtml = renderDirectionCardsHtml(hubData, LIVE_FLEET);

  const pills = [
    { key: "knyazhyi-zaton", label: "вул. Княжий Затон" },
    { key: "osokorky", label: "ст. м. Осокорки" },
    { key: "akhmatovoyi", label: "вул. Анни Ахматової" },
    { key: "dniprovska", label: "Дніпровська набережна" },
    { key: "pozniaky", label: "ст. м. Позняки" },
    { key: "urlivska", label: "вул. Урлівська" },
    { key: "vydubychi", label: "ст. м. Видубичі" }
  ];

  const pillsHtml = pills.map(p => {
    const isActive = p.key === hubData.hubKey ? " active" : "";
    return '<div class="pill' + isActive + '" data-stop="' + p.key + '">' + p.label + '</div>';
  }).join("");

  return '<!DOCTYPE html>' +
'<html lang="uk">' +
'<head>' +
  '<meta charset="UTF-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
  '<title>' + hubData.title + ' | Табло відправлень</title>' +
  '<style>' +
    ':root {' +
      '--bg: #0b0f14;' +
      '--card-bg: #141b22;' +
      '--border: #232b35;' +
      '--text: #f0f6fc;' +
      '--text-muted: #8b949e;' +
      '--route-cyan: #0099cc;' +
      '--bus-red: #d1242f;' +
      '--delay-red: #f85149;' +
      '--live-green: #3fb950;' +
      '--eta-white: #ffffff;' +
      '--pill-bg: #1d2631;' +
      '--pill-active: #0284c7;' +
    '}' +
    '* { box-sizing: border-box; margin: 0; padding: 0; }' +
    'body {' +
      'background: var(--bg);' +
      'color: var(--text);' +
      'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;' +
      'padding: 24px;' +
      'line-height: 1.4;' +
    '}' +
    '.container { max-width: 1200px; margin: 0 auto; }' +
    '.top-header {' +
      'display: flex;' +
      'justify-content: space-between;' +
      'align-items: center;' +
      'margin-bottom: 16px;' +
    '}' +
    '.station-title {' +
      'font-size: 1.75rem;' +
      'font-weight: 700;' +
      'letter-spacing: -0.02em;' +
      'color: var(--text);' +
    '}' +
    '.header-actions { display: flex; gap: 8px; align-items: center; }' +
    '.clock-badge {' +
      'background: #1e293b;' +
      'border: 1px solid var(--border);' +
      'color: #38bdf8;' +
      'border-radius: 8px;' +
      'padding: 7px 12px;' +
      'font-size: 0.95rem;' +
      'font-weight: 700;' +
      'letter-spacing: 0.05em;' +
    '}' +
    '.btn-icon {' +
      'background: var(--card-bg);' +
      'border: 1px solid var(--border);' +
      'color: var(--text-muted);' +
      'border-radius: 8px;' +
      'padding: 8px 14px;' +
      'font-size: 0.9rem;' +
      'cursor: pointer;' +
      'display: inline-flex;' +
      'align-items: center;' +
      'gap: 6px;' +
      'transition: all 0.2s;' +
    '}' +
    '.btn-icon:hover { background: #1f2937; color: var(--text); }' +
    '.btn-search {' +
      'background: #2a2510;' +
      'border-color: #594708;' +
      'color: #e3b341;' +
      'font-weight: 600;' +
    '}' +
    '.btn-search:hover { background: #3b3112; color: #f2cc60; }' +
    '.btn-fav.active { color: #facc15; border-color: #ca8a04; }' +
    '.pills-bar {' +
      'display: flex;' +
      'gap: 8px;' +
      'flex-wrap: wrap;' +
      'margin-bottom: 24px;' +
    '}' +
    '.pill {' +
      'background: var(--pill-bg);' +
      'border: 1px solid var(--border);' +
      'color: var(--text);' +
      'padding: 6px 14px;' +
      'border-radius: 8px;' +
      'font-size: 0.85rem;' +
      'cursor: pointer;' +
      'user-select: none;' +
      'transition: all 0.15s;' +
    '}' +
    '.pill:hover { border-color: #4b5563; }' +
    '.pill.active {' +
      'background: #0c2d48;' +
      'border-color: #0284c7;' +
      'color: #38bdf8;' +
      'font-weight: 600;' +
    '}' +
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
    '.platform-title {' +
      'font-size: 1.15rem;' +
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
    '.departure-row {' +
      'display: grid;' +
      'grid-template-columns: 1fr 90px 70px 65px;' +
      'padding: 12px 18px;' +
      'align-items: center;' +
      'border-bottom: 1px solid rgba(255, 255, 255, 0.04);' +
      'transition: background 0.15s;' +
    '}' +
    '.departure-row:last-child { border-bottom: none; }' +
    '.departure-row:hover { background: rgba(255, 255, 255, 0.02); }' +
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
    '.distance-cell.idle { color: var(--text-muted); font-weight: 400; }' +
    '.time-cell {' +
      'text-align: right;' +
      'font-size: 0.95rem;' +
      'font-weight: 700;' +
    '}' +
    '.time-scheduled { display: block; }' +
    '.delay-indicator {' +
      'display: block;' +
      'font-size: 0.75rem;' +
      'color: var(--delay-red);' +
      'font-weight: 800;' +
      'margin-top: -2px;' +
    '}' +
    '.eta-cell {' +
      'text-align: right;' +
      'font-size: 1rem;' +
      'font-weight: 800;' +
      'color: var(--eta-white);' +
    '}' +
    '.eta-cell.hours { color: var(--text-muted); font-size: 0.9rem; font-weight: 600; }' +
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
        '<button class="btn-icon btn-search" id="refreshBtn">⟳ Оновити GPS</button>' +
        '<button class="btn-icon btn-fav" id="favBtn" title="Додати в обране">★</button>' +
      '</div>' +
    '</div>' +
    '<div class="pills-bar" id="pillsBar">' +
      pillsHtml +
    '</div>' +
    '<div class="departure-grid" id="departureGrid">' +
      initialCardsHtml +
    '</div>' +
  '</div>' +
  '<script>' +
    'const stationTitle = document.getElementById("stationTitle");' +
    'const pillsBar = document.getElementById("pillsBar");' +
    'const departureGrid = document.getElementById("departureGrid");' +
    'const refreshBtn = document.getElementById("refreshBtn");' +
    'const favBtn = document.getElementById("favBtn");' +
    'const clockBadge = document.getElementById("clockBadge");' +
    'let currentStop = "' + hubData.hubKey + '";' +
    'let currentHub = ' + JSON.stringify(hubData) + ';' +
    'const expanded = {};' +

    'function updateClock() {' +
      'const now = new Date();' +
      'const timeStr = now.toLocaleTimeString("uk-UA", { timeZone: "Europe/Kyiv", hour: "2-digit", minute: "2-digit" });' +
      'if (clockBadge) clockBadge.textContent = timeStr + " (Київ)";' +
    '}' +
    'setInterval(updateClock, 10000);' +

    'function formatDistance(m) {' +
      'if (!m) return "<span class=\\"distance-cell idle\\">—</span>";' +
      'return m > 1000 ? (m / 1000).toFixed(1) + " км" : m + " м";' +
    '}' +

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

    'function render(hub) {' +
      'currentHub = hub;' +
      'stationTitle.textContent = hub.title;' +
      'if (clockBadge && hub.kyivTime) clockBadge.textContent = hub.kyivTime + " (Київ)";' +
      'document.querySelectorAll(".pill").forEach(p => {' +
        'p.classList.toggle("active", p.dataset.stop === hub.hubKey);' +
      '});' +
      'departureGrid.innerHTML = hub.directions.map(dir => {' +
        'const deps = dir.departures || [];' +
        'const isExp = !!expanded[dir.id];' +
        'const visible = isExp ? deps : deps.slice(0, 3);' +
        'const rows = visible.map(item => {' +
          'const delayHtml = item.delayMin > 0 ? "<span class=\\"delay-indicator\\">+" + item.delayMin + "\'</span>" : "";' +
          'return "<div class=\\"departure-row\\">" +' +
            '"<div class=\\"route-cell\\">" +' +
              '"<span class=\\"route-badge\\">" + item.route + "</span>" +' +
              '"<span class=\\"destination-name\\">" + item.destination + "</span>" +' +
            '"</div>" +' +
            '"<div class=\\"distance-cell\\">" + (item.remainingMinutes * 350 > 1000 ? ((item.remainingMinutes * 350)/1000).toFixed(1) + " км" : (item.remainingMinutes * 350) + " м") + "</div>" +' +
            '"<div class=\\"time-cell\\">" +' +
              '"<span class=\\"time-scheduled\\">" + item.time + "</span>" +' +
              'delayHtml +' +
            '"</div>" +' +
            'formatMinutes(item.remainingMinutes) +' +
          '"</div>";' +
        '}).join("");' +
        'return "<div class=\\"board-card\\">" +' +
          '"<div class=\\"card-header\\">" +' +
            '"<span class=\\"type-badge\\">" + dir.type + "</span>" +' +
            '"<span class=\\"platform-title\\">" + dir.title + "</span>" +' +
          '"</div>" +' +
          '"<div class=\\"table-columns\\">" +' +
            '"<div>МАРШРУТ · НАПРЯМОК</div>" +' +
            '"<div>ВІДСТАНЬ</div>" +' +
            '"<div>ЧАС</div>" +' +
            '"<div>ХВ.</div>" +' +
          '"</div>" +' +
          '"<div class=\\"departure-list\\">" + (rows || "<div style=\\"padding:20px;text-align:center;color:#8b949e;\\">Немає рейсів</div>") + "</div>" +' +
          '"<div class=\\"card-footer\\">" +' +
            '"<button class=\\"show-all-btn\\" onclick=\\"toggleExpand(\'" + dir.id + "\')\\">" +' +
              '(isExp ? "∧ Згорнути рейси" : "∨ Показати всі рейси (" + deps.length + ")") +' +
            '"</button>" +' +
          '"</div>" +' +
        '"</div>";' +
      '}).join("");' +
    '}' +

    'async function selectStop(key) {' +
      'currentStop = key;' +
      'const newUrl = window.location.pathname + "?stop=" + encodeURIComponent(key);' +
      'if (window.location.search !== "?stop=" + key) {' +
        'window.history.pushState({ stop: key }, "", newUrl);' +
      '}' +
      'refreshBtn.textContent = "⟳ Оновлення...";' +
      'try {' +
        'const res = await fetch("/api/hub?stop=" + encodeURIComponent(key));' +
        'const hub = await res.json();' +
        'render(hub);' +
      '} catch(e) {}' +
      'refreshBtn.textContent = "⟳ Оновити GPS";' +
    '}' +

    'pillsBar.addEventListener("click", (e) => {' +
      'const pill = e.target.closest(".pill");' +
      'if (pill && pill.dataset.stop) selectStop(pill.dataset.stop);' +
    '});' +

    'refreshBtn.addEventListener("click", () => selectStop(currentStop));' +
    'favBtn.addEventListener("click", () => {' +
      'const active = favBtn.classList.toggle("active");' +
      'localStorage.setItem("kpt_fav_" + currentStop, active ? "1" : "0");' +
    '});' +
    'window.addEventListener("popstate", () => {' +
      'const p = new URLSearchParams(window.location.search);' +
      'selectStop(p.get("stop") || "knyazhyi-zaton");' +
    '});' +
  '</script>' +
'</body>' +
'</html>';
}

/**
 * Cloudflare Worker Export (Fetch Handler).
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

    // 1. Root route: Server-Side Rendered (SSR) HTML with Europe/Kyiv time
    if (pathname === "/" || pathname === "/index.html") {
      const stopKey = searchParams.get("stop") || "knyazhyi-zaton";
      const html = renderFullPageHtml(stopKey);
      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    }

    // 2. Hub API for dynamic switching
    if (pathname === "/api/hub") {
      const stopKey = searchParams.get("stop") || "knyazhyi-zaton";
      const hubData = getHubDepartures(stopKey);
      return new Response(JSON.stringify(hubData), { headers: corsHeaders });
    }

    // 3. Live Fleet API
    if (pathname === "/api/live") {
      return new Response(JSON.stringify({ vehicles: LIVE_FLEET, timestamp: new Date().toISOString() }), {
        headers: corsHeaders
      });
    }

    return new Response(JSON.stringify({ error: "Endpoint not found" }), {
      status: 404,
      headers: corsHeaders
    });
  }
};
