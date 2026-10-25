// Where Am I — live location with photos and facts about the place.
// Uses only free, key-less APIs: OpenStreetMap (tiles + Nominatim), Wikipedia, Open-Meteo.

const REFRESH_DISTANCE_M = 300; // re-fetch place info after moving this far
const NEARBY_RADIUS_M = 10000;  // Wikipedia geosearch max is 10 km
const WIKI_LANG = "en";

const $ = (id) => document.getElementById(id);

const map = L.map("map", { worldCopyJump: true }).setView([20, 0], 2);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);

const nearbyLayer = L.layerGroup().addTo(map);
let userMarker = null;
let accuracyCircle = null;
let exploreMarker = null;
let watchId = null;
let lastPosition = null;  // latest GPS fix
let lastLoaded = null;    // where place info was last loaded for live mode
let exploring = false;    // true while the user is looking at a clicked spot
let requestToken = 0;     // discards stale responses

// ---------- helpers ----------

function setStatus(text, isError = false) {
  const el = $("status");
  el.textContent = text;
  el.classList.toggle("error", isError);
}

function show(el, visible) {
  el.classList.toggle("hidden", !visible);
}

function distanceMeters(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function formatDistance(m) {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}

async function getJSON(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

const WEATHER_CODES = {
  0: "☀️ Clear", 1: "🌤️ Mostly clear", 2: "⛅ Partly cloudy", 3: "☁️ Overcast",
  45: "🌫️ Fog", 48: "🌫️ Fog", 51: "🌦️ Drizzle", 53: "🌦️ Drizzle", 55: "🌦️ Drizzle",
  56: "🌧️ Freezing drizzle", 57: "🌧️ Freezing drizzle",
  61: "🌧️ Rain", 63: "🌧️ Rain", 65: "🌧️ Heavy rain",
  66: "🌧️ Freezing rain", 67: "🌧️ Freezing rain",
  71: "🌨️ Snow", 73: "🌨️ Snow", 75: "❄️ Heavy snow", 77: "🌨️ Snow grains",
  80: "🌦️ Showers", 81: "🌦️ Showers", 82: "⛈️ Violent showers",
  85: "🌨️ Snow showers", 86: "🌨️ Snow showers",
  95: "⛈️ Thunderstorm", 96: "⛈️ Thunderstorm", 99: "⛈️ Thunderstorm",
};

// ---------- data sources ----------

function reverseGeocode(lat, lon, zoom) {
  const url =
    `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}` +
    `&zoom=${zoom}&addressdetails=1&extratags=1&accept-language=${WIKI_LANG}`;
  return getJSON(url);
}

function fetchWeather(lat, lon) {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,weather_code,wind_speed_10m`;
  return getJSON(url);
}

function fetchNearby(lat, lon) {
  const url =
    `https://${WIKI_LANG}.wikipedia.org/w/api.php?action=query&format=json&origin=*` +
    `&generator=geosearch&ggscoord=${lat}|${lon}&ggsradius=${NEARBY_RADIUS_M}&ggslimit=15` +
    `&prop=pageimages|extracts|coordinates&piprop=thumbnail&pithumbsize=400` +
    `&exintro=1&explaintext=1&exsentences=2&exlimit=max`;
  return getJSON(url).then((data) => Object.values(data.query?.pages || {}));
}

function fetchWikiSummary(title, lang = WIKI_LANG) {
  const url = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
  return getJSON(url);
}

async function wikidataTitle(id) {
  const url =
    `https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&origin=*` +
    `&ids=${encodeURIComponent(id)}&props=sitelinks&sitefilter=${WIKI_LANG}wiki`;
  const data = await getJSON(url);
  return data.entities?.[id]?.sitelinks?.[`${WIKI_LANG}wiki`]?.title || null;
}

// Find a Wikipedia article for the town/city: via Wikidata (in WIKI_LANG), then OSM's
// wikipedia tag (may be another language), then by name.
async function fetchAreaSummary(lat, lon) {
  const area = await reverseGeocode(lat, lon, 10);
  const tag = area.extratags?.wikipedia; // e.g. "fr:Paris"
  const wikidata = area.extratags?.wikidata; // e.g. "Q90"
  let summary = null;
  if (wikidata) {
    try {
      const title = await wikidataTitle(wikidata);
      if (title) summary = await fetchWikiSummary(title);
    } catch { /* fall through */ }
  }
  if (!summary && tag && tag.includes(":")) {
    const [lang, ...rest] = tag.split(":");
    try { summary = await fetchWikiSummary(rest.join(":"), lang); } catch { /* fall through */ }
  }
  if (!summary && area.name) {
    try { summary = await fetchWikiSummary(area.name); } catch { /* none found */ }
  }
  if (summary?.type === "disambiguation") summary = null;
  return { area, summary };
}

// ---------- rendering ----------

function renderPlace({ lat, lon, accuracy, detail, areaInfo, weather }) {
  const addr = detail?.address || {};
  const locality = addr.city || addr.town || addr.village || addr.hamlet || addr.county || "";
  const summary = areaInfo?.summary;

  $("placeName").textContent =
    detail?.name || locality || summary?.title || "Unknown place";
  $("placeAddress").textContent = detail?.display_name || "";
  $("coords").textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  $("accuracy").textContent = accuracy != null ? `± ${Math.round(accuracy)} m` : "— (explored spot)";
  $("updated").textContent = new Date().toLocaleTimeString();

  const cur = weather?.current;
  $("weather").textContent = cur
    ? `${WEATHER_CODES[cur.weather_code] || "—"}, ${Math.round(cur.temperature_2m)}°C, wind ${Math.round(cur.wind_speed_10m)} km/h`
    : "—";

  const img = $("placeImage");
  const imgSrc = summary?.originalimage?.source || summary?.thumbnail?.source;
  if (imgSrc) {
    img.src = imgSrc;
    img.alt = summary.title;
  }
  show(img, Boolean(imgSrc));

  $("placeSummary").textContent = summary?.extract || "No description found for this area.";
  const link = $("placeLink");
  const href = summary?.content_urls?.desktop?.page;
  if (href) {
    link.href = href;
    link.textContent = `Read more about ${summary.title} on Wikipedia →`;
  }
  show(link, Boolean(href));
  show($("placeCard"), true);
}

function renderNearby(pages, origin) {
  nearbyLayer.clearLayers();
  const list = $("nearbyList");
  list.replaceChildren();

  const items = pages
    .filter((p) => p.coordinates?.length)
    .map((p) => {
      const c = p.coordinates[0];
      return { ...p, lat: c.lat, lon: c.lon, dist: distanceMeters(origin, { lat: c.lat, lon: c.lon }) };
    })
    .sort((a, b) => a.dist - b.dist);

  for (const p of items) {
    const url = `https://${WIKI_LANG}.wikipedia.org/?curid=${p.pageid}`;

    // Map marker with photo popup
    const popup = document.createElement("div");
    popup.className = "popup";
    if (p.thumbnail) {
      const pi = document.createElement("img");
      pi.src = p.thumbnail.source;
      pi.alt = p.title;
      popup.append(pi);
    }
    const pt = document.createElement("strong");
    pt.textContent = p.title;
    const pa = document.createElement("a");
    pa.href = url;
    pa.target = "_blank";
    pa.rel = "noopener";
    pa.textContent = "Wikipedia →";
    popup.append(pt, document.createElement("br"), pa);
    const marker = L.circleMarker([p.lat, p.lon], {
      radius: 7, color: "#e8590c", fillColor: "#ff922b", fillOpacity: 0.9, weight: 2,
    }).bindPopup(popup);
    nearbyLayer.addLayer(marker);

    // Side-panel list item
    const li = document.createElement("li");
    if (p.thumbnail) {
      const img = document.createElement("img");
      img.src = p.thumbnail.source;
      img.alt = p.title;
      img.loading = "lazy";
      li.append(img);
    } else {
      const ph = document.createElement("div");
      ph.className = "noimg";
      ph.textContent = "🏛️";
      li.append(ph);
    }
    const info = document.createElement("div");
    info.className = "info";
    const title = document.createElement("strong");
    title.textContent = p.title;
    const dist = document.createElement("span");
    dist.className = "dist";
    dist.textContent = `${formatDistance(p.dist)} away`;
    const desc = document.createElement("p");
    desc.textContent = p.extract || "";
    info.append(title, dist, desc);
    li.append(info);
    li.addEventListener("click", () => {
      map.setView([p.lat, p.lon], Math.max(map.getZoom(), 16));
      marker.openPopup();
    });
    list.append(li);
  }

  show($("nearbySection"), items.length > 0);
}

// ---------- main flow ----------

async function loadPlace(lat, lon, accuracy) {
  const token = ++requestToken;
  setStatus("Looking up this place…");

  const [detail, areaInfo, weather, nearby] = await Promise.allSettled([
    reverseGeocode(lat, lon, 18),
    fetchAreaSummary(lat, lon),
    fetchWeather(lat, lon),
    fetchNearby(lat, lon),
  ]);
  if (token !== requestToken) return; // a newer request superseded this one

  const val = (r) => (r.status === "fulfilled" ? r.value : null);
  renderPlace({ lat, lon, accuracy, detail: val(detail), areaInfo: val(areaInfo), weather: val(weather) });
  renderNearby(val(nearby) || [], { lat, lon });

  const failed = [detail, areaInfo, weather, nearby].filter((r) => r.status === "rejected").length;
  if (exploring) {
    setStatus(lastPosition
      ? "Exploring a spot on the map. Press “Recenter” to return to your location."
      : "Exploring a spot on the map.");
  } else {
    setStatus(failed ? "Live — some info couldn't be loaded." : "Live — following your location.");
  }
}

function onPosition(pos) {
  const { latitude: lat, longitude: lon, accuracy } = pos.coords;
  const first = !lastPosition;
  lastPosition = { lat, lon, accuracy };

  if (!userMarker) {
    userMarker = L.marker([lat, lon], { title: "You are here" }).addTo(map).bindPopup("You are here");
    accuracyCircle = L.circle([lat, lon], { radius: accuracy, weight: 1, fillOpacity: 0.12 }).addTo(map);
  } else {
    userMarker.setLatLng([lat, lon]);
    accuracyCircle.setLatLng([lat, lon]).setRadius(accuracy);
  }
  $("recenterBtn").disabled = false;

  if (exploring) return;

  if (first) map.setView([lat, lon], 15);
  else map.panTo([lat, lon]);

  if (!lastLoaded || distanceMeters(lastLoaded, lastPosition) > REFRESH_DISTANCE_M) {
    lastLoaded = { lat, lon };
    loadPlace(lat, lon, accuracy);
  } else {
    $("accuracy").textContent = `± ${Math.round(accuracy)} m`;
    $("coords").textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    $("updated").textContent = new Date().toLocaleTimeString();
  }
}

function onPositionError(err) {
  const messages = {
    1: "Location permission was denied. Allow location access in your browser settings, or click the map to explore.",
    2: "Your location is unavailable right now. Click the map to explore instead.",
    3: "Getting your location timed out. Still trying…",
  };
  setStatus(messages[err.code] || `Location error: ${err.message}`, true);
  if (err.code === 1) stopTracking();
}

function startTracking() {
  if (!("geolocation" in navigator)) {
    setStatus("Your browser doesn't support geolocation. Click the map to explore.", true);
    return;
  }
  if (!window.isSecureContext) {
    setStatus("Location needs HTTPS (or localhost). Open this site over https://.", true);
    return;
  }
  setStatus("Finding you…");
  exploring = false;
  watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, {
    enableHighAccuracy: true,
    maximumAge: 10000,
    timeout: 20000,
  });
  $("locateBtn").textContent = "Stop tracking";
}

function stopTracking() {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  $("locateBtn").textContent = "Track my location";
}

$("locateBtn").addEventListener("click", () => {
  if (watchId === null) startTracking();
  else {
    stopTracking();
    setStatus("Tracking stopped.");
  }
});

$("recenterBtn").addEventListener("click", () => {
  if (!lastPosition) return;
  exploring = false;
  if (exploreMarker) { map.removeLayer(exploreMarker); exploreMarker = null; }
  map.setView([lastPosition.lat, lastPosition.lon], 15);
  lastLoaded = { lat: lastPosition.lat, lon: lastPosition.lon };
  loadPlace(lastPosition.lat, lastPosition.lon, lastPosition.accuracy);
});

map.on("click", (e) => {
  const lat = e.latlng.lat;
  const lon = L.Util.wrapNum(e.latlng.lng, [-180, 180], true);
  exploring = true;
  if (!exploreMarker) {
    exploreMarker = L.circleMarker([lat, lon], {
      radius: 9, color: "#7048e8", fillColor: "#9775fa", fillOpacity: 0.8, weight: 2,
    }).addTo(map);
  } else {
    exploreMarker.setLatLng([lat, lon]);
  }
  loadPlace(lat, lon, null);
});

// Start automatically if the user already granted permission before.
if (navigator.permissions?.query) {
  navigator.permissions
    .query({ name: "geolocation" })
    .then((p) => { if (p.state === "granted") startTracking(); })
    .catch(() => {});
}
