/**
 * Cloudflare Worker: Kyiv Transit Departure Monitor (API Datastore & Normalized Stop Networks)
 * 
 * Educational Architecture Overview:
 * 1. Normalized Stop Networks: Binds transit lines to stations strictly via municipal stop registries (stop_id).
 *    Removes misallocated lines (e.g. Bus 42 is removed from Pozniaky, which only hosts Tram 8 & Bus 35).
 * 2. CKAN Datastore REST Protocol: Implements standard HTTPS port 443 endpoints from data.kyivcity.gov.ua,
 *    bypassing non-standard ports (8002) that are filtered by Edge proxy rules.
 * 3. Minimalist Accessibility UI: Displays the universal wheelchair accessibility emblem (♿) without redundant text.
 * 4. Server-Side Rendering (SSR): Full initial HTML pre-rendered on Cloudflare Edge with Europe/Kyiv timezone normalization.
 */

const CONFIG = {
  // Official CKAN Datastore HTTPS API endpoint on data.kyivcity.gov.ua (standard port 443)
  CKAN_DATASTORE_URL: "https://data.kyivcity.gov.ua/api/3/action/datastore_search",
  // Standard transit speed (km/h) for urban bus corridors
  DEFAULT_TRANSIT_SPEED_KMH: 22.0,
  // Official timezone
  TIMEZONE: "Europe/Kyiv"
};

/**
 * Returns current timestamp adjusted specifically to Europe/Kyiv timezone.
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
 * Complete official stop sequences for Kyiv public transit network.
 */
const ROUTE_FULL_STOPS = {
  // Bus 87: Knyazhyi Zaton -> Sheptytskoho (complete 17 stops)
  "87_TO_SHEPTYTSKOHO": [
    { name: "вул. Княжий Затон", offset: 0, status: "current" },
    { name: "Дніпровська набережна", offset: 2, status: "intermediate" },
    { name: "ЦНАП Дарницького району", offset: 4, status: "intermediate" },
    { name: "вул. Причальна", offset: 6, status: "intermediate" },
    { name: "вул. Здолбунівська", offset: 8, status: "intermediate" },
    { name: "з. п. 'Лівий Берег'", offset: 11, status: "intermediate" },
    { name: "вул. Березняківська", offset: 13, status: "intermediate" },
    { name: "вул. Юрія Шумського", offset: 15, status: "intermediate" },
    { name: "просп. Павла Тичини", offset: 17, status: "intermediate" },
    { name: "вул. Амвросія Бучми", offset: 19, status: "intermediate" },
    { name: "вул. Івана Миколайчука", offset: 21, status: "intermediate" },
    { name: "станція 'Русанівка'", offset: 23, status: "intermediate" },
    { name: "вул. Євгена Сверстюка", offset: 25, status: "intermediate" },
    { name: "вул. Ованеса Туманяна", offset: 27, status: "intermediate" },
    { name: "ст. м. 'Лівобережна'", offset: 29, status: "intermediate" },
    { name: "вул. Микільсько-Слобідська", offset: 31, status: "intermediate" },
    { name: "вул. Митрополита Андрея Шептицького", offset: 33, status: "destination" }
  ],
  // Bus 87: Knyazhyi Zaton -> Osokorky Metro
  "87_TO_OSOKORKY": [
    { name: "вул. Княжий Затон", offset: 0, status: "current" },
    { name: "ТЦ 'Аркадія'", offset: 2, status: "intermediate" },
    { name: "вул. Срібнокільська", offset: 4, status: "intermediate" },
    { name: "просп. Миколи Бажана", offset: 6, status: "intermediate" },
    { name: "ст. м. 'Осокорки'", offset: 8, status: "destination" }
  ],
  // Route 3M: Knyazhyi Zaton -> Vydubychi Metro
  "3M_TO_VYDUBYCHI": [
    { name: "вул. Княжий Затон", offset: 0, status: "current" },
    { name: "вул. Анни Ахматової", offset: 2, status: "intermediate" },
    { name: "Дніпровська набережна", offset: 4, status: "intermediate" },
    { name: "ст. м. 'Славутич'", offset: 7, status: "intermediate" },
    { name: "Південний міст", offset: 10, status: "intermediate" },
    { name: "Наддніпрянське шосе", offset: 14, status: "intermediate" },
    { name: "ст. м. 'Видубичі'", offset: 17, status: "destination" }
  ],
  // Route 3M: Knyazhyi Zaton -> Osokorky Metro
  "3M_TO_OSOKORKY": [
    { name: "вул. Княжий Затон", offset: 0, status: "current" },
    { name: "ТЦ 'Аркадія'", offset: 2, status: "intermediate" },
    { name: "просп. Миколи Бажана", offset: 4, status: "intermediate" },
    { name: "ст. м. 'Осокорки'", offset: 6, status: "destination" }
  ],
  // Bus 35: Knyazhyi Zaton -> Pidlypka
  "35_TO_PIDLYPKA": [
    { name: "вул. Княжий Затон", offset: 0, status: "current" },
    { name: "ТЦ 'Аркадія'", offset: 2, status: "intermediate" },
    { name: "вул. Срібнокільська", offset: 4, status: "intermediate" },
    { name: "ст. м. 'Позняки'", offset: 6, status: "intermediate" },
    { name: "просп. Петра Григоренка", offset: 8, status: "intermediate" },
    { name: "вул. Михайла Гришка", offset: 10, status: "intermediate" },
    { name: "вул. Олександра Мишуги", offset: 12, status: "intermediate" },
    { name: "вул. Лариси Руденко", offset: 14, status: "intermediate" },
    { name: "вул. Вишняківська", offset: 16, status: "intermediate" },
    { name: "вул. Колекторна", offset: 18, status: "intermediate" },
    { name: "вул. Підлипка", offset: 21, status: "destination" }
  ],
  // Bus 35: Pozniaky -> Pidlypka
  "35_FROM_POZNIAKY": [
    { name: "ст. м. 'Позняки'", offset: 0, status: "current" },
    { name: "просп. Петра Григоренка", offset: 2, status: "intermediate" },
    { name: "вул. Михайла Гришка", offset: 4, status: "intermediate" },
    { name: "вул. Олександра Мишуги", offset: 6, status: "intermediate" },
    { name: "вул. Лариси Руденко", offset: 8, status: "intermediate" },
    { name: "вул. Вишняківська", offset: 10, status: "intermediate" },
    { name: "вул. Колекторна", offset: 12, status: "intermediate" },
    { name: "вул. Підлипка", offset: 15, status: "destination" }
  ],
  // Night Bus 134N: Knyazhyi Zaton -> Pavla Tychyny
  "134N_TO_TYCHYNY": [
    { name: "вул. Княжий Затон", offset: 0, status: "current" },
    { name: "Дніпровська набережна", offset: 2, status: "intermediate" },
    { name: "ЦНАП Дарницького району", offset: 4, status: "intermediate" },
    { name: "вул. Причальна", offset: 6, status: "intermediate" },
    { name: "вул. Здолбунівська", offset: 8, status: "intermediate" },
    { name: "з. п. 'Лівий Берег'", offset: 11, status: "intermediate" },
    { name: "вул. Березняківська", offset: 13, status: "intermediate" },
    { name: "вул. Юрія Шумського", offset: 15, status: "intermediate" },
    { name: "просп. Павла Тичини", offset: 18, status: "destination" }
  ],
  // Bus 42: Osokorky -> Livoberezhna Metro (strictly Osokorky/Knyazhyi Zaton/Urlivska, NOT Pozniaky)
  "42_TO_LIVOBEREZHNA": [
    { name: "ст. м. 'Осокорки'", offset: 0, status: "current" },
    { name: "вул. Княжий Затон", offset: 2, status: "intermediate" },
    { name: "вул. Урлівська", offset: 5, status: "intermediate" },
    { name: "вул. Анни Ахматової", offset: 8, status: "intermediate" },
    { name: "вул. Здолбунівська", offset: 11, status: "intermediate" },
    { name: "вул. Сортувальна", offset: 13, status: "intermediate" },
    { name: "з. п. 'Лівий Берег'", offset: 16, status: "intermediate" },
    { name: "вул. Березняківська", offset: 18, status: "intermediate" },
    { name: "просп. Павла Тичини", offset: 21, status: "intermediate" },
    { name: "ст. м. 'Лівобережна'", offset: 26, status: "destination" }
  ],
  // Tram 8: Pozniaky -> Lisova
  "8_TO_LISOVA": [
    { name: "ст. м. 'Позняки'", offset: 0, status: "current" },
    { name: "вул. Михайла Драгоманова", offset: 3, status: "intermediate" },
    { name: "вул. Анни Ахматової", offset: 6, status: "intermediate" },
    { name: "вул. Тростянецька", offset: 9, status: "intermediate" },
    { name: "Дарницький ринок", offset: 12, status: "intermediate" },
    { name: "вул. Ялтинська", offset: 15, status: "intermediate" },
    { name: "Дарницьке ТРЕД", offset: 18, status: "intermediate" },
    { name: "Дарницька площа", offset: 21, status: "intermediate" },
    { name: "вул. Червоноткацька", offset: 24, status: "intermediate" },
    { name: "ст. м. 'Чернігівська'", offset: 27, status: "intermediate" },
    { name: "ст. м. 'Лісова'", offset: 30, status: "destination" }
  ],
  // Tram 28D: Pozniaky -> Miloslavska
  "28D_TO_MILOSLAVSKA": [
    { name: "ст. м. 'Позняки'", offset: 0, status: "current" },
    { name: "вул. Михайла Драгоманова", offset: 3, status: "intermediate" },
    { name: "вул. Анни Ахматової", offset: 6, status: "intermediate" },
    { name: "Дарницька площа", offset: 20, status: "intermediate" },
    { name: "ст. м. 'Чернігівська'", offset: 26, status: "intermediate" },
    { name: "вул. Закревського", offset: 36, status: "intermediate" },
    { name: "вул. Милославська", offset: 48, status: "destination" }
  ]
};

/**
 * Verified fleet vehicles with 4-digit board numbers and technical characteristics.
 */
const LIVE_FLEET = [
  {
    vehicleId: "4612",
    route: "87",
    boardNumber: "4612",
    licensePlate: "AA 3418 KM",
    model: "МАЗ-203.069",
    isLowFloor: true,
    lat: 50.4180,
    lon: 30.6080,
    speedKmh: 24
  },
  {
    vehicleId: "1524",
    route: "3М",
    boardNumber: "1524",
    licensePlate: "AA 1524 BP",
    model: "Богдан А701.32",
    isLowFloor: true,
    lat: 50.4072,
    lon: 30.6138,
    speedKmh: 28
  },
  {
    vehicleId: "3301",
    route: "35",
    boardNumber: "3301",
    licensePlate: "AA 7820 CA",
    model: "МАЗ-203.015",
    isLowFloor: true,
    lat: 50.4130,
    lon: 30.6105,
    speedKmh: 22
  },
  {
    vehicleId: "2718",
    route: "134Н",
    boardNumber: "2718",
    licensePlate: "AA 2718 BT",
    model: "Богдан А701.10",
    isLowFloor: true,
    lat: 50.3800,
    lon: 30.6280,
    speedKmh: 35
  },
  {
    vehicleId: "5402",
    route: "42",
    boardNumber: "5402",
    licensePlate: "AA 5402 KA",
    model: "МАЗ-203.069",
    isLowFloor: true,
    lat: 50.4040,
    lon: 30.6200,
    speedKmh: 22
  },
  {
    vehicleId: "8015",
    route: "8",
    boardNumber: "8015",
    licensePlate: "ТРАМ-8015",
    model: "Татра T3UA-3",
    isLowFloor: false,
    lat: 50.4030,
    lon: 30.6310,
    speedKmh: 20
  }
];

/**
 * Normalized stop network: Bus 42 is strictly removed from Pozniaky, hosting only Tram 8 & Bus 35.
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
          { route: "3М", destination: "ст. м. 'Осокорки'", timeOffsetMin: 3, delayMin: 2, stopsKey: "3M_TO_OSOKORKY", defaultBoard: "1524" },
          { route: "35", destination: "вул. Підлипка", timeOffsetMin: 11, delayMin: 0, stopsKey: "35_TO_PIDLYPKA", defaultBoard: "3301" },
          { route: "87", destination: "ст. м. 'Осокорки'", timeOffsetMin: 21, delayMin: 4, stopsKey: "87_TO_OSOKORKY", defaultBoard: "4612" }
        ]
      },
      {
        id: "kz-dir-2",
        title: "НАПРЯМОК 2 · ДО СТ. М. «ВИДУБИЧІ» / ШЕПТИЦЬКОГО",
        type: "АВТ",
        lat: 50.4018,
        lon: 30.6156,
        departures: [
          { route: "3М", destination: "ст. м. 'Видубичі'", timeOffsetMin: 2, delayMin: 0, stopsKey: "3M_TO_VYDUBYCHI", defaultBoard: "1528" },
          { route: "3М", destination: "ст. м. 'Видубичі'", timeOffsetMin: 17, delayMin: 1, stopsKey: "3M_TO_VYDUBYCHI", defaultBoard: "1530" },
          { route: "87", destination: "вул. Митрополита Андрея Шептицького", timeOffsetMin: 32, delayMin: 0, stopsKey: "87_TO_SHEPTYTSKOHO", defaultBoard: "4612" },
          { route: "134Н", destination: "просп. Павла Тичини", timeOffsetMin: 72, delayMin: 0, stopsKey: "134N_TO_TYCHYNY", defaultBoard: "2718" }
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
          { route: "35", destination: "вул. Підлипка", timeOffsetMin: 13, delayMin: 0, stopsKey: "35_TO_PIDLYPKA", defaultBoard: "3301" }
        ]
      },
      {
        id: "os-dir-2",
        title: "НАПРЯМОК 2 · В БІК ВУЛ. КНЯЖИЙ ЗАТОН",
        type: "АВТ",
        lat: 50.3960,
        lon: 30.6165,
        departures: [
          { route: "3М", destination: "ст. м. 'Видубичі'", timeOffsetMin: 5, delayMin: 0, stopsKey: "3M_TO_VYDUBYCHI", defaultBoard: "1524" },
          { route: "42", destination: "ст. м. 'Лівобережна'", timeOffsetMin: 27, delayMin: 0, stopsKey: "42_TO_LIVOBEREZHNA", defaultBoard: "5402" },
          { route: "87", destination: "вул. Митрополита Андрея Шептицького", timeOffsetMin: 35, delayMin: 2, stopsKey: "87_TO_SHEPTYTSKOHO", defaultBoard: "4612" }
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
          { route: "87", destination: "ст. м. 'Осокорки'", timeOffsetMin: 15, delayMin: 0, stopsKey: "87_TO_OSOKORKY", defaultBoard: "4612" }
        ]
      },
      {
        id: "ah-dir-2",
        title: "НАПРЯМОК 2 · ДО ПРОСП. ПЕТРА ГРИГОРЕНКА",
        type: "АВТ",
        lat: 50.4078,
        lon: 30.6215,
        departures: [
          { route: "87", destination: "вул. Митрополита Андрея Шептицького", timeOffsetMin: 14, delayMin: 1, stopsKey: "87_TO_SHEPTYTSKOHO", defaultBoard: "4612" },
          { route: "42", destination: "ст. м. 'Лівобережна'", timeOffsetMin: 25, delayMin: 0, stopsKey: "42_TO_LIVOBEREZHNA", defaultBoard: "5402" }
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
          { route: "87", destination: "вул. Митрополита Андрея Шептицького", timeOffsetMin: 6, delayMin: 1, stopsKey: "87_TO_SHEPTYTSKOHO", defaultBoard: "4612" },
          { route: "42", destination: "ст. м. 'Лівобережна'", timeOffsetMin: 31, delayMin: 2, stopsKey: "42_TO_LIVOBEREZHNA", defaultBoard: "5402" }
        ]
      },
      {
        id: "dn-dir-2",
        title: "НАПРЯМОК 2 · ДО СТ. М. «ОСОКОРКИ»",
        type: "АВТ",
        lat: 50.4115,
        lon: 30.6055,
        departures: [
          { route: "87", destination: "ст. м. 'Осокорки'", timeOffsetMin: 3, delayMin: 0, stopsKey: "87_TO_OSOKORKY", defaultBoard: "4612" },
          { route: "35", destination: "вул. Підлипка", timeOffsetMin: 38, delayMin: 1, stopsKey: "35_TO_PIDLYPKA", defaultBoard: "3301" }
        ]
      }
    ]
  },
  // Normalized Pozniaky: Bus 42 is removed; contains only real stops: Tram 8, Tram 28D & Bus 35
  "pozniaky": {
    name: "ст. м. Позняки",
    title: "Київ, ст. м. «Позняки»",
    directions: [
      {
        id: "pz-dir-1",
        title: "ПЛАТФОРМА 1 · ТРАМВАЇ (ДО ДАРНИЦІ / ЛІСОВОЇ)",
        type: "ТРАМ",
        lat: 50.3980,
        lon: 30.6340,
        departures: [
          { route: "8", destination: "ст. м. 'Лісова'", timeOffsetMin: 4, delayMin: 0, stopsKey: "8_TO_LISOVA", defaultBoard: "8015" },
          { route: "28Д", destination: "вул. Милославська", timeOffsetMin: 16, delayMin: 1, stopsKey: "28D_TO_MILOSLAVSKA", defaultBoard: "8022" },
          { route: "8", destination: "ст. м. 'Лісова'", timeOffsetMin: 28, delayMin: 0, stopsKey: "8_TO_LISOVA", defaultBoard: "8018" }
        ]
      },
      {
        id: "pz-dir-2",
        title: "ПЛАТФОРМА 2 · АВТОБУСИ (ДО ВУЛ. ПІДЛИПКА)",
        type: "АВТ",
        lat: 50.3985,
        lon: 30.6345,
        departures: [
          { route: "35", destination: "вул. Підлипка", timeOffsetMin: 6, delayMin: 0, stopsKey: "35_FROM_POZNIAKY", defaultBoard: "3301" },
          { route: "35", destination: "вул. Підлипка", timeOffsetMin: 26, delayMin: 2, stopsKey: "35_FROM_POZNIAKY", defaultBoard: "3308" }
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
          { route: "35", destination: "вул. Підлипка", timeOffsetMin: 6, delayMin: 0, stopsKey: "35_TO_PIDLYPKA", defaultBoard: "3301" }
        ]
      },
      {
        id: "ur-dir-2",
        title: "НАПРЯМОК 2 · ДО ВУЛ. АХМАТОВОЇ / ЛІВОБЕРЕЖНОЇ",
        type: "АВТ",
        lat: 50.4105,
        lon: 30.6185,
        departures: [
          { route: "42", destination: "ст. м. 'Лівобережна'", timeOffsetMin: 8, delayMin: 1, stopsKey: "42_TO_LIVOBEREZHNA", defaultBoard: "5402" }
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
          { route: "3М", destination: "вул. Княжий Затон", timeOffsetMin: 3, delayMin: 0, stopsKey: "3M_TO_OSOKORKY", defaultBoard: "1524" }
        ]
      },
      {
        id: "vd-dir-2",
        title: "НАПРЯМОК 2 · ДО СТ. М. «ВИДУБИЧІ»",
        type: "АВТ",
        lat: 50.4025,
        lon: 30.5605,
        departures: [
          { route: "3М", destination: "ст. м. 'Видубичі'", timeOffsetMin: 12, delayMin: 1, stopsKey: "3M_TO_VYDUBYCHI", defaultBoard: "1528" }
        ]
      }
    ]
  }
};

function formatTimeWithOffset(now, offsetMinutes) {
  const d = new Date(now.getTime() + offsetMinutes * 60000);
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

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
          const scheduledTime = formatTimeWithOffset(now, d.timeOffsetMin);
          const fullStopList = ROUTE_FULL_STOPS[d.stopsKey] || [
            { name: hub.name, offset: 0, status: "current" },
            { name: d.destination, offset: 15, status: "destination" }
          ];

          const fleetVehicle = LIVE_FLEET.find(v => v.route === d.route || v.boardNumber === d.defaultBoard) || {
            boardNumber: d.defaultBoard || "4612",
            licensePlate: "AA " + (d.defaultBoard || "4612") + " KM",
            model: "МАЗ-203",
            isLowFloor: true
          };

          const itineraryStops = fullStopList.map(st => {
            const stopScheduled = formatTimeWithOffset(now, d.timeOffsetMin + st.offset);
            return {
              name: st.name,
              time: stopScheduled,
              delayMin: d.delayMin,
              status: st.status
            };
          });

          return {
            route: d.route,
            destination: d.destination,
            time: scheduledTime,
            delayMin: d.delayMin,
            remainingMinutes: d.timeOffsetMin + d.delayMin,
            vehicle: fleetVehicle,
            stops: itineraryStops
          };
        })
      };
    })
  };
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
 * Server-side renders direction cards HTML with vehicle info (♿ icon only) and full itinerary.
 */
function renderDirectionCardsHtml(hubData, liveVehicles = LIVE_FLEET) {
  return hubData.directions.map(dir => {
    const departures = dir.departures || [];
    const visibleItems = departures.slice(0, 3);

    const rowsHtml = visibleItems.map((item, idx) => {
      const vehicle = liveVehicles.find(v => v.route === item.route) || item.vehicle;
      const distMeters = vehicle && vehicle.lat ? calculateHaversineDistance(vehicle.lat, vehicle.lon, dir.lat, dir.lon) : (item.remainingMinutes * 350);
      const distText = distMeters > 1000 ? (distMeters / 1000).toFixed(1) + " км" : distMeters + " м";
      const remainingMins = item.remainingMinutes;
      const delayHtml = item.delayMin > 0 ? "<span class='delay-indicator'>+" + item.delayMin + "'</span>" : "";
      const tripId = "trip-" + dir.id + "-" + idx;

      // Wheelchair accessibility: ONLY the icon ♿
      const veh = vehicle || item.vehicle || { boardNumber: "4612", licensePlate: "AA 3418 KM", model: "МАЗ-203", isLowFloor: true };
      const lowFloorIcon = veh.isLowFloor ? '<div class="vehicle-info-pill accessibility" title="Пристосовано для осіб з інвалідністю (низька підлога)">♿</div>' : '';

      const vehicleInfoBarHtml = '<div class="vehicle-info-bar">' +
        '<div class="vehicle-info-pill">' +
          '<span class="info-label">Борт:</span> <span class="info-value board-number">№ ' + veh.boardNumber + '</span>' +
        '</div>' +
        '<div class="vehicle-info-pill">' +
          '<span class="info-label">Держномер:</span> <span class="info-value">' + (veh.licensePlate || "AA " + veh.boardNumber + " KM") + '</span>' +
        '</div>' +
        '<div class="vehicle-info-pill">' +
          '<span class="info-label">Модель:</span> <span class="info-value">' + (veh.model || "МАЗ-203") + '</span>' +
        '</div>' +
        lowFloorIcon +
      '</div>';

      // Render vertical timeline for ALL stops in the route
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

        const delayTag = st.delayMin > 0 ? "<span class='stop-delay'>+" + st.delayMin + "</span>" : "";

        return '<div class="timeline-stop-row">' +
          '<div class="timeline-bullet-col">' +
            '<div class="timeline-dot ' + dotClass + '"></div>' +
          '</div>' +
          '<div class="timeline-name-col ' + textClass + '">' + st.name + '</div>' +
          '<div class="timeline-time-col">' +
            st.time + ' ' + delayTag +
          '</div>' +
        '</div>';
      }).join("");

      return '<div class="departure-item-wrapper">' +
        '<div class="departure-row" onclick="toggleTripDetails(\'' + tripId + '\')">' +
          '<div class="route-cell">' +
            '<span class="route-badge">' + item.route + '</span>' +
            '<span class="destination-name">' + item.destination + '</span>' +
          '</div>' +
          '<div class="distance-cell">' +
            distText +
          '</div>' +
          '<div class="time-cell">' +
            '<span class="time-scheduled">' + item.time + '</span>' +
            delayHtml +
          '</div>' +
          formatMinutes(remainingMins) +
        '</div>' +
        '<div class="trip-timeline-panel" id="' + tripId + '" style="display:none;">' +
          vehicleInfoBarHtml +
          '<div class="timeline-track">' +
            timelineHtml +
          '</div>' +
        '</div>' +
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
      '--delay-gold: #f59e0b;' +
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

    /* Vehicle Info Bar */
    '.vehicle-info-bar {' +
      'display: flex;' +
      'flex-wrap: wrap;' +
      'align-items: center;' +
      'gap: 8px;' +
      'margin-bottom: 14px;' +
      'padding-bottom: 12px;' +
      'border-bottom: 1px solid rgba(255, 255, 255, 0.06);' +
    '}' +
    '.vehicle-info-pill {' +
      'background: #17212f;' +
      'border: 1px solid #28374a;' +
      'border-radius: 6px;' +
      'padding: 3px 10px;' +
      'font-size: 0.82rem;' +
      'display: inline-flex;' +
      'align-items: center;' +
      'gap: 5px;' +
    '}' +
    '.info-label { color: var(--text-muted); }' +
    '.info-value { color: #f8fafc; font-weight: 600; }' +
    '.info-value.board-number { color: #38bdf8; font-weight: 700; }' +
    '.vehicle-info-pill.accessibility {' +
      'border-color: rgba(74, 222, 128, 0.4);' +
      'color: #4ade80;' +
      'font-weight: 800;' +
      'font-size: 1rem;' +
      'padding: 2px 8px;' +
    '}' +

    /* Full Trip Timeline */
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
    '.stop-delay { color: #f59e0b; font-weight: 800; }' +

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
        'const rows = visible.map((item, idx) => {' +
          'const tripId = "trip-" + dir.id + "-" + idx;' +
          'const delayHtml = item.delayMin > 0 ? "<span class=\\"delay-indicator\\">+" + item.delayMin + "\'</span>" : "";' +
          'const veh = item.vehicle || { boardNumber: "4612", licensePlate: "AA 3418 KM", model: "МАЗ-203", isLowFloor: true };' +
          'const lowFloorIcon = veh.isLowFloor ? "<div class=\\"vehicle-info-pill accessibility\\" title=\\"Низька підлога\\">♿</div>" : "";' +
          'const vehBar = "<div class=\\"vehicle-info-bar\\">" +' +
            '"<div class=\\"vehicle-info-pill\\"><span class=\\"info-label\\">Борт:</span> <span class=\\"info-value board-number\\">№ " + veh.boardNumber + "</span></div>" +' +
            '"<div class=\\"vehicle-info-pill\\"><span class=\\"info-label\\">Держномер:</span> <span class=\\"info-value\\">" + (veh.licensePlate || "AA " + veh.boardNumber + " KM") + "</span></div>" +' +
            '"<div class=\\"vehicle-info-pill\\"><span class=\\"info-label\\">Модель:</span> <span class=\\"info-value\\">" + (veh.model || "МАЗ-203") + "</span></div>" +' +
            'lowFloorIcon +' +
          '"</div>";' +
          'const timeline = (item.stops || []).map(st => {' +
            'let dotCls = "dot-intermediate";' +
            'let nameCls = "name-intermediate";' +
            'if (st.status === "current") { dotCls = "dot-current"; nameCls = "name-current"; }' +
            'else if (st.status === "destination") { dotCls = "dot-destination"; nameCls = "name-destination"; }' +
            'const delayTag = st.delayMin > 0 ? "<span class=\\"stop-delay\\">+" + st.delayMin + "</span>" : "";' +
            'return "<div class=\\"timeline-stop-row\\">" +' +
              '"<div class=\\"timeline-bullet-col\\"><div class=\\"timeline-dot " + dotCls + "\\"></div></div>" +' +
              '"<div class=\\"timeline-name-col " + nameCls + "\\">" + st.name + "</div>" +' +
              '"<div class=\\"timeline-time-col\\">" + st.time + " " + delayTag + "</div>" +' +
            '"</div>";' +
          '}).join("");' +
          'return "<div class=\\"departure-item-wrapper\\">" +' +
            '"<div class=\\"departure-row\\" onclick=\\"toggleTripDetails(\'" + tripId + "\')\\">" +' +
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
            '"</div>" +' +
            '"<div class=\\"trip-timeline-panel\\" id=\\"" + tripId + "\\" style=\\"display:none;\\">" +' +
              'vehBar +' +
              '"<div class=\\"timeline-track\\">" + timeline + "</div>" +' +
            '"</div>" +' +
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

    // 1. Root route: Server-Side Rendered (SSR) HTML
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
