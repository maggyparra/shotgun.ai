import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
// LRM's bundle expects Leaflet on window.L (browserify-shim)
window.L = L;
import 'leaflet-routing-machine';
import 'leaflet-routing-machine/dist/leaflet-routing-machine.css';

// Fix default marker icons when using bundlers (Vite/Webpack)
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

const map = L.map('map').setView([40.7128, -74.006], 12);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© OpenStreetMap contributors',
  maxZoom: 19,
}).addTo(map);

// Follow mode: overhead zoom (local street view like Google/Apple)
const FOLLOW_ZOOM = 17;
let currentRouteCoordinates = [];
let currentRouteInstructions = [];
let cumulativeDist = []; // cumulative meters from start to each coord index (for GPS projection)
let myLocation = null; // set when user clicks "Use my location"
let positionMarker = null;
let geoWatchId = null;
let simulateAnimationId = null;

// OSRM public demo (rate limit 1 req/sec; use Mapbox/GraphHopper or self-host for production)
const routingControl = L.Routing.control({
  router: L.Routing.osrmv1({
    serviceUrl: 'https://router.project-osrm.org/route/v1',
    profile: 'driving',
    suppressDemoServerWarning: true,
  }),
  waypoints: [],
  show: false,
  addWaypoints: true,
  routeWhileDragging: false,
  fitSelectedRoutes: true,
  showAlternatives: false,
  line: { styles: [{ color: '#2563eb', weight: 6 }] },
  createMarker: () => null,
}).addTo(map);

routingControl.on('routingerror', () => {
  document.getElementById('instructions').innerHTML =
    '<p class="hint">Route not found. Try different addresses or check the OSRM demo server (1 req/sec limit).</p>';
});

routingControl.on('routeselected', (e) => {
  const route = e.route;
  currentRouteCoordinates = (route.coordinates || []).map((c) =>
    Array.isArray(c) ? L.latLng(c[0], c[1]) : c
  );
  currentRouteInstructions = route.instructions || [];
  // Precompute cumulative distances for GPS projection onto route
  cumulativeDist = [0];
  for (let i = 0; i < currentRouteCoordinates.length - 1; i++) {
    const a = currentRouteCoordinates[i];
    const b = currentRouteCoordinates[i + 1];
    cumulativeDist.push(cumulativeDist[i] + a.distanceTo(b));
  }
  stopSimulate();
  if (!document.getElementById('follow-toggle').checked) hideNextDirectionBanner();
  const instructionsEl = document.getElementById('instructions');
  instructionsEl.innerHTML = '';

  route.instructions.forEach((step, i) => {
    const div = document.createElement('div');
    div.className = 'instruction-step';
    const dist = step.distance > 1000
      ? `${(step.distance / 1000).toFixed(1)} km`
      : `${Math.round(step.distance)} m`;
    div.innerHTML = `
      <span class="step-num">${i + 1}</span>
      <span class="step-text">${step.text}</span>
      <span class="step-dist">${dist}</span>
    `;
    instructionsEl.appendChild(div);
  });

  const totalDist = (route.summary.totalDistance / 1000).toFixed(1);
  const totalTime = Math.round(route.summary.totalTime / 60);
  const summary = document.createElement('p');
  summary.className = 'route-summary';
  summary.textContent = `Total: ${totalDist} km · ~${totalTime} min`;
  instructionsEl.insertBefore(summary, instructionsEl.firstChild);

  document.getElementById('simulate-btn').disabled = currentRouteCoordinates.length < 2;
});

// Geocoding via Nominatim (OSM, free; rate limit ~1 req/sec)
async function geocode(query) {
  if (!query || query.length < 3) return null;
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1`;
  const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
  const data = await res.json();
  if (!data?.[0]) return null;
  const { lat, lon } = data[0];
  return [parseFloat(lat), parseFloat(lon)];
}

// Reusable location error hint (browser blocks GPS without HTTPS or user permission)
function getLocationErrorHint() {
  const isSecure = typeof location !== 'undefined' && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1');
  let msg = 'Click <strong>Allow location</strong> below to trigger your browser\'s permission prompt. ';
  if (!isSecure) msg += 'Location only works on <strong>HTTPS</strong> or <strong>localhost</strong> — open this app via http://localhost:5173 or deploy over HTTPS.';
  return msg;
}

// UI: "Use my location" for From
document.getElementById('use-my-location-btn').addEventListener('click', () => {
  document.getElementById('instructions').innerHTML = '<p class="hint">Getting your location…</p>';
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      myLocation = [pos.coords.latitude, pos.coords.longitude];
      const latLng = L.latLng(myLocation[0], myLocation[1]);
      document.getElementById('from').value = 'My location';
      const wps = routingControl.getWaypoints();
      if (wps.length === 0) {
        routingControl.spliceWaypoints(0, 0, latLng);
      } else {
        routingControl.spliceWaypoints(0, 1, latLng);
      }
      document.getElementById('instructions').innerHTML = '<p class="hint">Start set to your location. Enter a destination and click Get route.</p>';
    },
    () => {
      document.getElementById('instructions').innerHTML = `<p class="hint">${getLocationErrorHint()}</p>`;
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
  );
});

// UI: route button
document.getElementById('route-btn').addEventListener('click', async () => {
  const fromInput = document.getElementById('from').value.trim();
  const toInput = document.getElementById('to').value.trim();
  if (!toInput) {
    document.getElementById('instructions').innerHTML = '<p class="hint">Enter a destination (To).</p>';
    return;
  }
  const useMyLocation = fromInput.toLowerCase() === 'my location' || (fromInput === '' && myLocation);
  if (!useMyLocation && !fromInput) {
    document.getElementById('instructions').innerHTML = '<p class="hint">Enter a start (From) or click "Use my location".</p>';
    return;
  }

  document.getElementById('instructions').innerHTML = '<p class="hint">Routing…</p>';
  let from;
  if (useMyLocation && myLocation) {
    from = myLocation;
  } else if (useMyLocation) {
    document.getElementById('instructions').innerHTML = '<p class="hint">Getting your location…</p>';
    try {
      const pos = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 10000 });
      });
      myLocation = [pos.coords.latitude, pos.coords.longitude];
      from = myLocation;
    } catch {
      document.getElementById('instructions').innerHTML = `<p class="hint">${getLocationErrorHint()}</p>`;
      return;
    }
  } else {
    from = await geocode(fromInput);
  }
  const to = await geocode(toInput);
  if (!from) {
    document.getElementById('instructions').innerHTML = '<p class="hint">Could not find start address.</p>';
    return;
  }
  if (!to) {
    document.getElementById('instructions').innerHTML = '<p class="hint">Could not find destination.</p>';
    return;
  }

  routingControl.setWaypoints([L.latLng(from), L.latLng(to)]);
});

// Allow location button — triggers the browser's permission prompt (must be a direct click)
document.getElementById('allow-location-btn').addEventListener('click', () => {
  const instructionsEl = document.getElementById('instructions');
  instructionsEl.innerHTML = '<p class="hint">Requesting location access… Check for a browser prompt (address bar or popup).</p>';
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      myLocation = [pos.coords.latitude, pos.coords.longitude];
      document.getElementById('from').value = 'My location';
      const latLng = L.latLng(myLocation[0], myLocation[1]);
      const wps = routingControl.getWaypoints();
      if (wps.length === 0) routingControl.spliceWaypoints(0, 0, latLng);
      else routingControl.spliceWaypoints(0, 1, latLng);
      instructionsEl.innerHTML = '<p class="hint">Location allowed. You can use <strong>Use my location</strong> and <strong>Follow my location</strong> now.</p>';
    },
    () => {
      instructionsEl.innerHTML = `<p class="hint">${getLocationErrorHint()}</p>`;
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
  );
});

// --- Follow mode: local overhead view (center on position + zoom) ---
function ensurePositionMarker() {
  if (positionMarker) return positionMarker;
  positionMarker = L.circleMarker([0, 0], {
    radius: 8,
    fillColor: '#2563eb',
    color: '#fff',
    weight: 2,
    fillOpacity: 1,
  }).addTo(map);
  return positionMarker;
}

function moveMapToPosition(latLng, duration = 0.3) {
  map.setView(latLng, FOLLOW_ZOOM, { animate: true, duration });
  const marker = ensurePositionMarker();
  marker.setLatLng(latLng);
}

function stopFollow() {
  if (geoWatchId != null) {
    navigator.geolocation.clearWatch(geoWatchId);
    geoWatchId = null;
  }
  document.getElementById('follow-toggle').checked = false;
  hideNextDirectionBanner();
  if (positionMarker) {
    map.removeLayer(positionMarker);
    positionMarker = null;
  }
}

function stopSimulate() {
  if (simulateAnimationId != null) {
    clearTimeout(simulateAnimationId);
    simulateAnimationId = null;
  }
  const btn = document.getElementById('simulate-btn');
  btn.textContent = 'Simulate drive';
  btn.classList.remove('active');
  hideNextDirectionBanner();
  if (positionMarker) {
    map.removeLayer(positionMarker);
    positionMarker = null;
  }
}

// Follow my location (GPS) — same banner behavior as simulate when a route is active
document.getElementById('follow-toggle').addEventListener('change', (e) => {
  if (e.target.checked) {
    stopSimulate();
    ensurePositionMarker();
    geoWatchId = navigator.geolocation.watchPosition(
      (pos) => {
        const latLng = L.latLng(pos.coords.latitude, pos.coords.longitude);
        moveMapToPosition(latLng);

        if (currentRouteCoordinates.length > 0 && cumulativeDist.length > 0 && currentRouteInstructions.length > 0) {
          const proj = projectOntoRoute(latLng, currentRouteCoordinates, cumulativeDist);
          if (proj) {
            const distAlong = proj.distanceAlongRoute;
            const nextInstr = currentRouteInstructions.find((instr) => {
              const idx = instr.index != null ? instr.index : 0;
              return cumulativeDist[idx] != null && cumulativeDist[idx] > distAlong;
            });
            showNextDirectionBanner();
            if (nextInstr) {
              const idx = nextInstr.index != null ? nextInstr.index : 0;
              const distToNext = cumulativeDist[idx] - distAlong;
              updateNextDirectionBanner(nextInstr.text || 'Continue', distToNext);
            } else {
              updateNextDirectionBanner('You have arrived.', null);
            }
          }
        } else {
          hideNextDirectionBanner();
        }
      },
      () => {
        document.getElementById('instructions').insertAdjacentHTML('afterbegin',
          `<p class="hint">${getLocationErrorHint()}</p>`);
      },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 5000 }
    );
  } else {
    stopFollow();
  }
});

// Simulate drive along route (overhead follow view)
document.getElementById('simulate-btn').addEventListener('click', () => {
  if (currentRouteCoordinates.length < 2) return;

  if (simulateAnimationId != null) {
    stopSimulate();
    return;
  }

  const btn = document.getElementById('simulate-btn');
  btn.textContent = 'Stop';
  btn.classList.add('active');
  document.getElementById('follow-toggle').checked = false;
  stopFollow();

  ensurePositionMarker();
  const coords = currentRouteCoordinates;
  const instructions = currentRouteInstructions;
  const stepMs = 1200; // ~10x slower than before (was 120)
  let index = 0;
  showNextDirectionBanner();

  function tick() {
    if (index >= coords.length) {
      updateNextDirectionBanner('You have arrived.', null);
      setTimeout(() => stopSimulate(), 2000);
      return;
    }
    const latLng = coords[index];
    moveMapToPosition(latLng, 0.15);

    // Next instruction: first instruction whose coordinate index is ahead of us
    const nextInstr = instructions.find((instr) => (instr.index != null ? instr.index : 0) > index);
    if (nextInstr) {
      const instrIndex = nextInstr.index != null ? nextInstr.index : 0;
      const distM = distanceAlongRoute(coords, index, instrIndex);
      updateNextDirectionBanner(nextInstr.text || 'Continue', distM);
    } else {
      updateNextDirectionBanner('You have arrived.', null);
    }

    index += 1;
    simulateAnimationId = setTimeout(tick, stepMs);
  }
  tick();
});

// Next-direction banner (top of screen, updates as you pass each instruction)
const bannerEl = document.getElementById('next-direction-banner');
const bannerInstructionEl = bannerEl.querySelector('.banner-instruction');
const bannerDistanceEl = bannerEl.querySelector('.banner-distance');

function hideNextDirectionBanner() {
  bannerEl.hidden = true;
}

function showNextDirectionBanner() {
  bannerEl.hidden = false;
}

function updateNextDirectionBanner(instructionText, distanceMeters) {
  bannerInstructionEl.textContent = instructionText || 'Continue';
  if (distanceMeters == null || distanceMeters < 0) {
    bannerDistanceEl.textContent = '';
  } else if (distanceMeters >= 1000) {
    bannerDistanceEl.textContent = `in ${(distanceMeters / 1000).toFixed(1)} km`;
  } else {
    bannerDistanceEl.textContent = `in ${Math.round(distanceMeters)} m`;
  }
}

// Distance along route (in meters) from coordinate index a to index b
function distanceAlongRoute(coords, fromIndex, toIndex) {
  if (fromIndex >= toIndex || fromIndex < 0 || toIndex > coords.length) return 0;
  let d = 0;
  for (let i = fromIndex; i < toIndex; i++) {
    const a = coords[i];
    const b = coords[i + 1];
    d += (a.lat != null ? a : L.latLng(a[0], a[1])).distanceTo(b.lat != null ? b : L.latLng(b[0], b[1]));
  }
  return d;
}

// Project a point onto the route polyline; return fractional index and distance along route (for GPS follow)
function projectOntoRoute(latlng, coords, cumulativeDist) {
  if (!coords.length || !cumulativeDist.length) return null;
  const p = latlng.lat != null ? latlng : L.latLng(latlng[0], latlng[1]);
  let best = { index: 0, distanceAlongRoute: 0, dist: Infinity };
  for (let i = 0; i < coords.length - 1; i++) {
    const A = coords[i];
    const B = coords[i + 1];
    const dlat = B.lat - A.lat;
    const dlng = B.lng - A.lng;
    const denom = dlat * dlat + dlng * dlng;
    const t = denom < 1e-18 ? 0 : Math.max(0, Math.min(1,
      ((p.lat - A.lat) * dlat + (p.lng - A.lng) * dlng) / denom
    ));
    const proj = L.latLng(A.lat + t * dlat, A.lng + t * dlng);
    const d = p.distanceTo(proj);
    const segLen = A.distanceTo(B);
    const distAlong = cumulativeDist[i] + t * segLen;
    if (d < best.dist) best = { index: i + t, distanceAlongRoute: distAlong, dist: d };
  }
  return best;
}

// Optional: click map to set waypoints (first click = start, second = destination)
let clickStep = 0;
map.on('click', (e) => {
  const latlng = e.latlng;
  if (clickStep === 0) {
    routingControl.spliceWaypoints(0, 0, latlng);
    document.getElementById('from').placeholder = `${latlng.lat.toFixed(4)}, ${latlng.lng.toFixed(4)}`;
    clickStep = 1;
  } else {
    routingControl.spliceWaypoints(1, 0, latlng);
    document.getElementById('to').placeholder = `${latlng.lat.toFixed(4)}, ${latlng.lng.toFixed(4)}`;
    clickStep = 0;
  }
});
