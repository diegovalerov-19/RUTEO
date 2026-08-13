const DEFAULT_CENTER = [4.711, -74.0721];
const STORAGE_KEY = "ruteo-routes-v2";
const ACTIVE_TRACK_KEY = "ruteo-active-track-v2";
const MIN_POINT_DISTANCE_METERS = 5;
const MAX_ACCEPTED_ACCURACY_METERS = 60;
const SIMULATION_MIN_DURATION_MS = 12000;
const SIMULATION_MAX_DURATION_MS = 90000;
const SIMULATION_COMPRESSION = 20;
const GOOGLE_MAPS_KEY = "ruteo-google-maps-key-v1";

async function initApp() {
const mapContainer = document.querySelector("#map");
const map = await window.createRuteoMap({
  container: mapContainer,
  center: DEFAULT_CENTER,
  zoom: 12,
  googleMapsKey: localStorage.getItem(GOOGLE_MAPS_KEY) || "",
  onGoogleAuthFailure: () => showMapBanner("Google rechazó la API key. Revisa sus restricciones o configura otra clave.", "error", 0)
});

if ("ResizeObserver" in window) {
  new ResizeObserver(() => map.resize()).observe(mapContainer);
}
window.addEventListener("load", () => window.setTimeout(() => map.resize(), 150));
window.addEventListener("orientationchange", () => window.setTimeout(() => map.resize(), 250));

const state = {
  mode: "capture",
  start: null,
  end: null,
  waypoints: [],
  waypointSelectionId: null,
  startMarker: null,
  endMarker: null,
  plannedLine: null,
  watchId: null,
  wakeLock: null,
  track: null,
  trackLine: map.createPolyline([], { color: "#e30613", weight: 7, opacity: 0.95 }),
  currentMarker: null,
  accuracyCircle: null,
  captureStartMarker: null,
  captureEndMarker: null,
  timerId: null,
  followLocation: true,
  simulation: null,
  routeSegments: []
};

const $ = selector => document.querySelector(selector);
const form = $("#route-form");
const startInput = $("#start");
const endInput = $("#end");
const dateInput = $("#date");
const timeInput = $("#time");
const waypointsList = $("#waypoints-list");
const message = $("#message");
const calculateButton = $("#calculate");
const startCaptureButton = $("#start-capture");
const pauseCaptureButton = $("#pause-capture");
const finishCaptureButton = $("#finish-capture");
let waypointSequence = 0;

const now = new Date();
dateInput.value = now.toISOString().slice(0, 10);
timeInput.value = now.toTimeString().slice(0, 5);

function setMode(mode) {
  if (state.track?.status === "recording" && mode !== "capture") {
    showMapBanner("Finaliza o pausa el recorrido antes de cambiar de modo.", "warning");
    return;
  }
  if (state.mode !== mode) {
    closeSimulation();
    hideRouteSegments();
  }
  state.mode = mode;
  document.querySelectorAll(".mode-tab").forEach(button => button.classList.toggle("active", button.dataset.mode === mode));
  $("#capture-mode").hidden = mode !== "capture";
  $("#plan-mode").hidden = mode !== "plan";
  setTimeout(() => map.resize(), 0);
}

document.querySelectorAll(".mode-tab").forEach(button => button.addEventListener("click", () => setMode(button.dataset.mode)));

function showMapBanner(text, type = "info", duration = 4500) {
  const banner = $("#map-banner");
  banner.textContent = text;
  banner.className = `map-banner ${type}`;
  banner.hidden = false;
  clearTimeout(showMapBanner.timer);
  if (duration) showMapBanner.timer = setTimeout(() => { banner.hidden = true; }, duration);
}

function syncDashboardDock() {
  const dock = $("#map-dashboard-dock");
  if (!dock) return;
  dock.classList.toggle("has-visible-dashboard", [...dock.children].some(control => !control.hidden));
}

function setRouteSegmentsExpanded(expanded) {
  const panel = $("#route-segments-panel");
  const body = $("#route-segments-body");
  const toggle = $("#route-segments-toggle");
  panel.classList.toggle("expanded", expanded);
  body.hidden = !expanded;
  toggle.setAttribute("aria-expanded", String(expanded));
  if (expanded && state.simulation) setSimulationPanelVisible(false);
}

function hideRouteSegments() {
  state.routeSegments = [];
  setRouteSegmentsExpanded(false);
  $("#route-segments-panel").hidden = true;
  syncDashboardDock();
}

function showRouteSegments(segments) {
  const cleanSegments = (Array.isArray(segments) ? segments : []).filter(segment => Number.isFinite(Number(segment.distanceMeters)) && Number.isFinite(Number(segment.durationSeconds)));
  if (!cleanSegments.length) {
    hideRouteSegments();
    return;
  }

  state.routeSegments = cleanSegments;
  $("#route-segments-list").innerHTML = cleanSegments.map((segment, index) => `<article class="route-segment">
    <div class="route-segment-name" title="${escapeHtml(`${String(segment.from)} → ${String(segment.to)}`)}">
      <span class="route-segment-number">${index + 1}</span>
      <span>${escapeHtml(String(segment.from))} → ${escapeHtml(String(segment.to))}</span>
    </div>
    <div class="route-segment-metrics">
      <span><small>Distancia</small><strong>${formatDistance(Number(segment.distanceMeters))}</strong></span>
      <span><small>Tiempo</small><strong>${formatSegmentDuration(Number(segment.durationSeconds))}</strong></span>
    </div>
  </article>`).join("");
  $("#route-segments-count").textContent = `${cleanSegments.length} ${cleanSegments.length === 1 ? "tramo" : "tramos"}`;
  $("#route-segments-panel").hidden = false;
  setRouteSegmentsExpanded(false);
  syncDashboardDock();
}

function segmentsForRoute(route) {
  if (!route) return [];
  if (Array.isArray(route.segments) && route.segments.length) return route.segments;
  const recorded = route.type === "recorded";
  const distanceMeters = Number(route.distanceMeters ?? (route.distanceKm * 1000));
  const durationMilliseconds = recorded ? getElapsedMilliseconds(route) : (route.durationMilliseconds ?? (route.durationMin * 60000));
  const durationSeconds = Number(durationMilliseconds / 1000);
  if (!Number.isFinite(distanceMeters) || !Number.isFinite(durationSeconds)) return [];
  return [{ from: recorded ? "Inicio" : "Origen", to: recorded ? "Fin" : "Destino", distanceMeters, durationSeconds }];
}

function setupMapProviderSettings() {
  const dialog = $("#map-settings");
  const keyInput = $("#google-maps-key");
  const providerButton = $("#map-provider-button");
  keyInput.value = localStorage.getItem(GOOGLE_MAPS_KEY) || "";
  providerButton.textContent = map.provider === "google" ? "Google Maps activo" : "Activar Google Maps";
  providerButton.classList.toggle("google-active", map.provider === "google");
  providerButton.addEventListener("click", () => dialog.showModal());
  $("#save-google-key").addEventListener("click", () => {
    const key = keyInput.value.trim();
    if (!/^AIza[\w-]{20,}$/.test(key)) {
      showMapBanner("La API key no parece válida. Normalmente comienza con AIza.", "warning", 6000);
      return;
    }
    localStorage.setItem(GOOGLE_MAPS_KEY, key);
    window.location.reload();
  });
  $("#remove-google-key").addEventListener("click", () => {
    localStorage.removeItem(GOOGLE_MAPS_KEY);
    window.location.reload();
  });
}

setupMapProviderSettings();
if (map.loadError) {
  showMapBanner("No fue posible activar Google Maps. Se cargó el mapa de respaldo; revisa tu API key y la conexión.", "warning", 8000);
}

function updateConnectionStatus() {
  const online = navigator.onLine;
  const pill = $("#online-status");
  pill.textContent = online ? "En línea" : "Sin conexión";
  pill.classList.toggle("offline", !online);
}

window.addEventListener("online", updateConnectionStatus);
window.addEventListener("offline", updateConnectionStatus);
updateConnectionStatus();

function setGpsStatus(title, detail, status = "idle") {
  $("#gps-title").textContent = title;
  $("#gps-detail").textContent = detail;
  $("#gps-status").dataset.status = status;
}

function createTrack() {
  return {
    id: Date.now(),
    type: "recorded",
    name: $("#track-name").value.trim() || `Recorrido ${new Date().toLocaleDateString("es-CO")}`,
    startedAt: new Date().toISOString(),
    endedAt: null,
    pausedAt: null,
    pausedMilliseconds: 0,
    status: "recording",
    distanceMeters: 0,
    points: []
  };
}

async function startCapture() {
  if (!navigator.geolocation) {
    setGpsStatus("GPS no disponible", "Este navegador no permite obtener la ubicación.", "error");
    return;
  }

  stopWatchingPosition();
  closeSimulation();
  hideRouteSegments();

  if (!state.track || state.track.status === "finished") {
    clearCaptureLayers();
    state.track = createTrack();
  } else if (state.track.status === "paused") {
    state.track.pausedMilliseconds += Date.now() - new Date(state.track.pausedAt).getTime();
    state.track.pausedAt = null;
    state.track.status = "recording";
  }

  setGpsStatus("Buscando señal GPS…", "Acepta el permiso de ubicación cuando Android lo solicite.", "searching");
  startCaptureButton.disabled = true;
  startCaptureButton.querySelector("span:last-child").textContent = "Buscando GPS…";

  state.watchId = navigator.geolocation.watchPosition(handlePosition, handlePositionError, {
    enableHighAccuracy: true,
    maximumAge: 1000,
    timeout: 15000
  });

  state.timerId = window.setInterval(updateLiveMetrics, 1000);
  pauseCaptureButton.hidden = false;
  finishCaptureButton.hidden = false;
  $("#recenter").disabled = false;
  await requestWakeLock();
  persistActiveTrack();
}

function handlePosition(position) {
  if (!state.track || state.track.status !== "recording") return;
  const point = {
    lat: position.coords.latitude,
    lng: position.coords.longitude,
    accuracy: Math.round(position.coords.accuracy),
    altitude: position.coords.altitude,
    speed: position.coords.speed,
    timestamp: new Date(position.timestamp).toISOString()
  };
  const latlng = { lat: point.lat, lng: point.lng };

  updateCurrentLocation(latlng, point.accuracy);
  $("#live-accuracy").textContent = `±${point.accuracy} m`;

  if (point.accuracy > MAX_ACCEPTED_ACCURACY_METERS) {
    setGpsStatus("Señal GPS débil", `Precisión actual: ±${point.accuracy} m. Esperando una mejor señal.`, "warning");
    return;
  }

  const previous = state.track.points.at(-1);
  const distanceFromPrevious = previous ? distanceBetween(previous, latlng) : Infinity;
  const secondsFromPrevious = previous ? (position.timestamp - new Date(previous.timestamp).getTime()) / 1000 : Infinity;
  if (previous && distanceFromPrevious < MIN_POINT_DISTANCE_METERS && secondsFromPrevious < 12) {
    setGpsStatus("Grabando recorrido", `Ubicación activa · precisión ±${point.accuracy} m`, point.accuracy <= 30 ? "good" : "warning");
    return;
  }

  if (previous) state.track.distanceMeters += distanceFromPrevious;
  state.track.points.push(point);
  state.trackLine.addPoint(latlng);

  if (!state.captureStartMarker) {
    state.captureStartMarker = map.createCircleMarker(latlng, {
      radius: 8, strokeColor: "#fff", strokeWeight: 3, fillColor: "#111111", fillOpacity: 1, title: "Inicio del recorrido"
    });
    map.setView(latlng, 17);
    navigator.vibrate?.(120);
  } else if (state.followLocation) {
    map.panTo(latlng, { animate: true });
  }

  setGpsStatus("Grabando recorrido", `Ubicación activa · precisión ±${point.accuracy} m`, point.accuracy <= 30 ? "good" : "warning");
  startCaptureButton.disabled = true;
  startCaptureButton.querySelector("span:last-child").textContent = "Recorrido en curso";
  updateLiveMetrics();
  persistActiveTrack();
}

function updateCurrentLocation(latlng, accuracy) {
  if (!state.currentMarker) {
    state.currentMarker = map.createCircleMarker(latlng, {
      radius: 9, strokeColor: "#fff", strokeWeight: 3, fillColor: "#111111", fillOpacity: 1
    });
    state.accuracyCircle = map.createCircle(latlng, { radius: accuracy, strokeColor: "#e30613", strokeWeight: 1, fillOpacity: 0.08 });
  } else {
    state.currentMarker.setPosition(latlng);
    state.accuracyCircle.setPosition(latlng);
    state.accuracyCircle.setRadius(accuracy);
  }
}

function handlePositionError(error) {
  const errors = {
    1: ["Permiso de ubicación bloqueado", "En Android abre Ajustes → Aplicaciones → Chrome → Permisos → Ubicación → Permitir mientras se usa."],
    2: ["No se encuentra la ubicación", "Activa el GPS y el modo de ubicación de alta precisión."],
    3: ["El GPS tardó demasiado", "Sal a un lugar abierto y vuelve a intentarlo."]
  };
  const [title, detail] = errors[error.code] || ["Error de ubicación", error.message];
  setGpsStatus(title, detail, "error");
  showMapBanner(detail, "error", 7000);
  stopWatchingPosition();
  if (state.track?.status === "recording") {
    state.track.status = "paused";
    state.track.pausedAt = new Date().toISOString();
    persistActiveTrack();
  }
  startCaptureButton.disabled = false;
  startCaptureButton.querySelector("span:last-child").textContent = state.track?.points.length ? "Continuar recorrido" : "Reintentar GPS";
  pauseCaptureButton.hidden = true;
}

function pauseCapture() {
  if (!state.track || state.track.status !== "recording") return;
  stopWatchingPosition();
  state.track.status = "paused";
  state.track.pausedAt = new Date().toISOString();
  setGpsStatus("Recorrido pausado", "El GPS no está agregando puntos.", "paused");
  startCaptureButton.disabled = false;
  startCaptureButton.querySelector("span:last-child").textContent = "Continuar recorrido";
  pauseCaptureButton.hidden = true;
  releaseWakeLock();
  persistActiveTrack();
}

function finishCapture() {
  if (!state.track || state.track.points.length < 2) {
    showMapBanner("Avanza unos metros para registrar al menos dos puntos GPS.", "warning");
    return;
  }
  stopWatchingPosition();
  if (state.track.pausedAt) {
    state.track.pausedMilliseconds += Date.now() - new Date(state.track.pausedAt).getTime();
    state.track.pausedAt = null;
  }
  state.track.status = "finished";
  state.track.endedAt = new Date().toISOString();
  const finalPoint = state.track.points.at(-1);
  state.captureEndMarker = map.createCircleMarker(finalPoint, {
    radius: 8, strokeColor: "#fff", strokeWeight: 3, fillColor: "#e30613", fillOpacity: 1, title: "Fin del recorrido"
  });
  saveRoute(state.track);
  localStorage.removeItem(ACTIVE_TRACK_KEY);
  navigator.vibrate?.([100, 70, 160]);
  setGpsStatus("Recorrido guardado", `${formatDistance(state.track.distanceMeters)} registrados correctamente.`, "good");
  startCaptureButton.disabled = false;
  startCaptureButton.querySelector("span:last-child").textContent = "Iniciar otro recorrido";
  pauseCaptureButton.hidden = true;
  finishCaptureButton.hidden = true;
  clearInterval(state.timerId);
  releaseWakeLock();
  if (state.trackLine.getPoints().length) map.fit(state.trackLine.getPoints(), 35);
  showRouteSegments(segmentsForRoute(state.track));
}

function stopWatchingPosition() {
  if (state.watchId !== null) navigator.geolocation.clearWatch(state.watchId);
  state.watchId = null;
  clearInterval(state.timerId);
  state.timerId = null;
}

function getElapsedMilliseconds(track) {
  const end = track.status === "finished" ? new Date(track.endedAt).getTime() : track.pausedAt ? new Date(track.pausedAt).getTime() : Date.now();
  return Math.max(0, end - new Date(track.startedAt).getTime() - track.pausedMilliseconds);
}

function updateLiveMetrics() {
  if (!state.track) return;
  $("#live-distance").textContent = formatDistance(state.track.distanceMeters);
  $("#live-duration").textContent = formatDuration(getElapsedMilliseconds(state.track));
  $("#live-points").textContent = state.track.points.length;
}

function persistActiveTrack() {
  if (state.track && state.track.status !== "finished") localStorage.setItem(ACTIVE_TRACK_KEY, JSON.stringify(state.track));
}

function restoreActiveTrack() {
  const saved = JSON.parse(localStorage.getItem(ACTIVE_TRACK_KEY) || "null");
  if (!saved?.points?.length) return;
  saved.status = "paused";
  saved.pausedAt = saved.points.at(-1).timestamp;
  state.track = saved;
  state.trackLine.setPoints(saved.points);
  const first = saved.points[0];
  const last = saved.points.at(-1);
  state.captureStartMarker = map.createCircleMarker(first, { radius: 8, strokeColor: "#fff", strokeWeight: 3, fillColor: "#111111", fillOpacity: 1 });
  updateCurrentLocation(last, last.accuracy);
  map.fit(state.trackLine.getPoints(), 35);
  $("#track-name").value = saved.name;
  $("#live-accuracy").textContent = `±${last.accuracy} m`;
  setGpsStatus("Recorrido recuperado", "Pulsa continuar para volver a grabar.", "paused");
  startCaptureButton.querySelector("span:last-child").textContent = "Continuar recorrido";
  finishCaptureButton.hidden = false;
  updateLiveMetrics();
}

function clearCaptureLayers() {
  state.trackLine.setPoints([]);
  ["currentMarker", "accuracyCircle", "captureStartMarker", "captureEndMarker"].forEach(key => {
    if (state[key]) map.remove(state[key]);
    state[key] = null;
  });
  $("#live-distance").textContent = "0 m";
  $("#live-duration").textContent = "00:00";
  $("#live-accuracy").textContent = "—";
  $("#live-points").textContent = "0";
}

async function requestWakeLock() {
  if (!("wakeLock" in navigator)) return;
  try { state.wakeLock = await navigator.wakeLock.request("screen"); } catch { /* Android puede denegarlo por ahorro de batería. */ }
}

async function releaseWakeLock() {
  try { await state.wakeLock?.release(); } catch { /* Ya estaba liberado. */ }
  state.wakeLock = null;
}

document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "visible" && state.track?.status === "recording") {
    await requestWakeLock();
    showMapBanner("Ruteo volvió al primer plano. Verifica que el GPS siga grabando.", "info");
  }
});

startCaptureButton.addEventListener("click", startCapture);
pauseCaptureButton.addEventListener("click", pauseCapture);
finishCaptureButton.addEventListener("click", finishCapture);
$("#recenter").addEventListener("click", () => {
  const last = state.track?.points.at(-1);
  if (!last) return;
  state.followLocation = true;
  map.setView(last, Math.max(map.getZoom(), 17));
});

map.on("dragstart", () => { if (state.track?.status === "recording") state.followLocation = false; });

function setMessage(text = "") { message.textContent = text; }

function parseCoordinates(query) {
  const match = query.trim().replace(/[()]/g, "").match(/^(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const lat = Number(match[1]);
  const lng = Number(match[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { point: { lat, lng }, label: `${lat.toFixed(6)}, ${lng.toFixed(6)}` };
}

function getWaypoint(id) {
  return state.waypoints.find(waypoint => waypoint.id === String(id));
}

function refreshWaypointMarkers() {
  state.waypoints.forEach((waypoint, index) => {
    if (waypoint.marker) map.remove(waypoint.marker);
    waypoint.marker = null;
    if (!waypoint.point) return;
    waypoint.marker = map.createHtmlMarker(waypoint.point, {
      className: "waypoint-icon-shell",
      size: 30,
      zIndex: 900,
      html: `<div class="waypoint-map-marker" aria-label="Punto obligatorio ${index + 1}">${index + 1}</div>`
    });
  });
}

function renderWaypointRows() {
  waypointsList.innerHTML = state.waypoints.map((waypoint, index) => `<div class="waypoint-row">
    <label for="waypoint-${waypoint.id}">Punto obligatorio ${index + 1}</label>
    <div class="waypoint-input-row">
      <input id="waypoint-${waypoint.id}" data-waypoint-input="${waypoint.id}" value="${escapeHtml(waypoint.label || "")}" placeholder="Latitud, longitud o dirección">
      <button type="button" data-search-waypoint="${waypoint.id}" aria-label="Buscar punto obligatorio ${index + 1}">⌕</button>
      <button type="button" data-map-waypoint="${waypoint.id}" aria-label="Colocar punto obligatorio ${index + 1} en el mapa">◎</button>
      <button class="remove-waypoint" type="button" data-remove-waypoint="${waypoint.id}" aria-label="Eliminar punto obligatorio ${index + 1}">×</button>
    </div>
  </div>`).join("");

  document.querySelectorAll("[data-waypoint-input]").forEach(input => input.addEventListener("input", event => {
    const waypoint = getWaypoint(event.currentTarget.dataset.waypointInput);
    if (waypoint) waypoint.label = event.currentTarget.value;
  }));
  document.querySelectorAll("[data-search-waypoint]").forEach(button => button.addEventListener("click", () => searchPlace("waypoint", button.dataset.searchWaypoint)));
  document.querySelectorAll("[data-map-waypoint]").forEach(button => button.addEventListener("click", () => selectWaypointOnMap(button.dataset.mapWaypoint)));
  document.querySelectorAll("[data-remove-waypoint]").forEach(button => button.addEventListener("click", () => removeWaypoint(button.dataset.removeWaypoint)));
}

function selectWaypointOnMap(id) {
  const waypoint = getWaypoint(id);
  if (!waypoint) return;
  state.waypointSelectionId = waypoint.id;
  const index = state.waypoints.indexOf(waypoint) + 1;
  setMessage(`Toca el mapa para colocar el punto obligatorio ${index}.`);
}

function addWaypoint(point = null, label = "", selectOnMap = true) {
  if (state.waypoints.length >= 8) return setMessage("Puedes agregar hasta 8 puntos obligatorios por ruta.");
  const waypoint = { id: String(++waypointSequence), point, label, marker: null };
  state.waypoints.push(waypoint);
  renderWaypointRows();
  refreshWaypointMarkers();
  if (selectOnMap) selectWaypointOnMap(waypoint.id);
  return waypoint;
}

function removeWaypoint(id) {
  const waypoint = getWaypoint(id);
  if (!waypoint) return;
  if (waypoint.marker) map.remove(waypoint.marker);
  state.waypoints = state.waypoints.filter(item => item.id !== waypoint.id);
  if (state.waypointSelectionId === waypoint.id) state.waypointSelectionId = null;
  renderWaypointRows();
  refreshWaypointMarkers();
  setMessage(state.waypoints.length ? "Puntos obligatorios reordenados." : "Ya no hay puntos obligatorios.");
}

function setWaypoint(id, latlng, label) {
  const waypoint = getWaypoint(id);
  if (!waypoint) return;
  waypoint.point = { lat: Number(latlng.lat), lng: Number(latlng.lng) };
  waypoint.label = label;
  renderWaypointRows();
  refreshWaypointMarkers();
}

function setPoint(type, latlng, label) {
  const isStart = type === "start";
  const markerKey = isStart ? "startMarker" : "endMarker";
  if (state[markerKey]) map.remove(state[markerKey]);
  state[type] = { lat: latlng.lat, lng: latlng.lng, label };
  state[markerKey] = map.createCircleMarker(latlng, {
    radius: 9,
    strokeColor: "#ffffff",
    strokeWeight: 3,
    fillColor: isStart ? "#111111" : "#e30613",
    fillOpacity: 1,
    title: isStart ? "Punto de partida" : "Punto final"
  });
  (isStart ? startInput : endInput).value = label;
}

map.on("click", latlng => {
  if (state.mode !== "plan") return;
  if (state.waypointSelectionId) {
    const waypoint = getWaypoint(state.waypointSelectionId);
    const index = state.waypoints.indexOf(waypoint) + 1;
    setWaypoint(state.waypointSelectionId, latlng, `${latlng.lat.toFixed(6)}, ${latlng.lng.toFixed(6)}`);
    state.waypointSelectionId = null;
    setMessage(`Punto obligatorio ${index} colocado. La ruta respetará este orden.`);
    return;
  }
  const type = !state.start ? "start" : !state.end ? "end" : null;
  if (!type) {
    const label = `${latlng.lat.toFixed(6)}, ${latlng.lng.toFixed(6)}`;
    const waypoint = addWaypoint(latlng, label, false);
    if (waypoint) {
      const index = state.waypoints.indexOf(waypoint) + 1;
      setMessage(`Punto obligatorio ${index} agregado desde el mapa. Toca otro lugar para añadir el siguiente.`);
    }
    return;
  }
  setPoint(type, latlng, `${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}`);
  setMessage(type === "start" ? "Ahora selecciona el punto final." : "Puntos listos para calcular.");
});

async function searchPlace(type, waypointId = null) {
  const input = type === "waypoint" ? document.querySelector(`[data-waypoint-input="${waypointId}"]`) : type === "start" ? startInput : endInput;
  const query = input.value.trim();
  if (!query) return setMessage("Escribe una dirección para buscarla.");
  const assignPoint = (point, label) => {
    if (type === "waypoint") {
      setWaypoint(waypointId, point, label);
      state.waypointSelectionId = null;
    } else {
      setPoint(type, point, label);
    }
  };
  const coordinates = parseCoordinates(query);
  if (coordinates) {
    assignPoint(coordinates.point, coordinates.label);
    map.setView(coordinates.point, 16);
    setMessage(type === "waypoint" ? "Coordenadas del punto obligatorio guardadas." : "Coordenadas encontradas.");
    return;
  }
  setMessage("Buscando ubicación…");
  try {
    let googleResult = null;
    try { googleResult = await map.geocode(query); } catch { /* Usa el buscador de respaldo. */ }
    if (googleResult) {
      assignPoint(googleResult.point, googleResult.label);
      map.setView(googleResult.point, 15);
      setMessage("Ubicación encontrada con Google Maps.");
      return;
    }
    const response = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`, { headers: { "Accept-Language": "es" } });
    if (!response.ok) throw new Error();
    const [result] = await response.json();
    if (!result) return setMessage("No encontramos esa ubicación. Intenta ser más específico.");
    const latlng = { lat: Number(result.lat), lng: Number(result.lon) };
    assignPoint(latlng, result.display_name);
    map.setView(latlng, 15);
    setMessage("Ubicación encontrada.");
  } catch { setMessage("No fue posible consultar la ubicación. Revisa tu conexión."); }
}

document.querySelectorAll("[data-search]").forEach(button => button.addEventListener("click", () => searchPlace(button.dataset.search)));

form.addEventListener("submit", async event => {
  event.preventDefault();
  if (!state.start || !state.end) return setMessage("Busca o selecciona en el mapa los dos puntos.");
  const incompleteWaypoint = state.waypoints.find(waypoint => !waypoint.point);
  if (incompleteWaypoint) {
    const index = state.waypoints.indexOf(incompleteWaypoint) + 1;
    return setMessage(`Falta colocar el punto obligatorio ${index}. Escribe coordenadas, busca una dirección o usa el mapa.`);
  }
  calculateButton.disabled = true;
  setMessage("Calculando la mejor ruta…");
  try {
    const routeStops = [state.start, ...state.waypoints.map(waypoint => waypoint.point), state.end];
    const coords = routeStops.map(point => `${point.lng},${point.lat}`).join(";");
    const response = await fetch(`https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson`);
    if (!response.ok) throw new Error();
    const data = await response.json();
    const route = data.routes?.[0];
    if (!route) throw new Error();
    if (state.plannedLine) map.remove(state.plannedLine);
    const points = route.geometry.coordinates.map(([lng, lat]) => ({ lat, lng }));
    state.plannedLine = map.createPolyline(points, { color: "#111111", weight: 6, opacity: 0.9 });
    map.fit(points, 35);
    const stopNames = ["Origen", ...state.waypoints.map((_, index) => `Punto ${index + 1}`), "Destino"];
    const segments = (route.legs || []).map((leg, index) => ({
      from: stopNames[index] || `Punto ${index}`,
      to: stopNames[index + 1] || `Punto ${index + 1}`,
      distanceMeters: leg.distance,
      durationSeconds: leg.duration
    }));
    const distanceKm = route.distance / 1000;
    const durationMin = Math.round(route.duration / 60);
    $("#distance").textContent = `${distanceKm.toFixed(1)} km`;
    $("#duration").textContent = durationMin >= 60 ? `${Math.floor(durationMin / 60)} h ${durationMin % 60} min` : `${durationMin} min`;
    saveRoute({
      id: Date.now(),
      type: "planned",
      start: state.start.label,
      end: state.end.label,
      date: dateInput.value,
      time: timeInput.value,
      distanceKm,
      distanceMeters: route.distance,
      durationMin,
      durationMilliseconds: route.duration * 1000,
      waypoints: state.waypoints.map(waypoint => ({ ...waypoint.point, label: waypoint.label })),
      segments,
      points
    });
    showRouteSegments(segments);
    setMessage(state.waypoints.length ? `Ruta calculada y guardada pasando por ${state.waypoints.length} puntos obligatorios en orden.` : "Ruta calculada y guardada.");
  } catch { setMessage("No se pudo calcular la ruta. Verifica los puntos e intenta de nuevo."); }
  finally { calculateButton.disabled = false; }
});

function resetPlannedPoints() {
  state.waypoints.forEach(waypoint => { if (waypoint.marker) map.remove(waypoint.marker); });
  state.waypoints = [];
  state.waypointSelectionId = null;
  renderWaypointRows();
  ["startMarker", "endMarker", "plannedLine"].forEach(key => {
    if (state[key]) map.remove(state[key]);
    state[key] = null;
  });
  state.start = null;
  state.end = null;
  startInput.value = "";
  endInput.value = "";
  $("#distance").textContent = "—";
  $("#duration").textContent = "—";
  hideRouteSegments();
  setMessage("");
}

function getRoutes() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"); } catch { return []; }
}

function saveRoute(route) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify([route, ...getRoutes()].slice(0, 20)));
  renderHistory();
}

function vehicleMarkerOptions() {
  return {
    className: "vehicle-icon-shell",
    size: 13,
    zIndex: 1000,
    html: `<div class="vehicle-marker" aria-label="Camión de basuras de la simulación">
      <img src="garbage-truck-marker.png?v=16" alt="" aria-hidden="true">
    </div>`
  };
}

function startRouteSimulation(id) {
  if (state.track?.status === "recording") {
    showMapBanner("Finaliza o pausa la captura actual antes de iniciar una simulación.", "warning");
    return;
  }

  const route = getRoutes().find(item => item.id === id);
  const points = window.RouteExport.routePoints(route);
  if (!route || points.length < 2) {
    showMapBanner("Esta ruta no contiene suficientes coordenadas para simularla. Vuelve a calcularla si fue creada en una versión anterior.", "warning", 7000);
    return;
  }

  closeSimulation();
  setMode(route.type === "planned" ? "plan" : "capture");
  if (route.type === "recorded") {
    clearCaptureLayers();
    state.track = route;
  } else {
    resetPlannedPoints();
  }

  const latlngs = points.map(point => ({ lat: point.lat, lng: point.lng }));
  const cumulativeDistances = [0];
  for (let index = 1; index < latlngs.length; index += 1) {
    cumulativeDistances.push(cumulativeDistances[index - 1] + distanceBetween(latlngs[index - 1], latlngs[index]));
  }

  const originalDurationMs = Math.max(1000, route.type === "recorded" ? getElapsedMilliseconds(route) : (route.durationMilliseconds || route.durationMin * 60000));
  const animationDurationMs = Math.min(
    SIMULATION_MAX_DURATION_MS,
    Math.max(SIMULATION_MIN_DURATION_MS, originalDurationMs / SIMULATION_COMPRESSION)
  );
  const pendingLine = map.createPolyline(latlngs, { color: "#777777", weight: 6, opacity: 0.48, dashArray: "8 8" });
  const completedLine = map.createPolyline([latlngs[0]], { color: "#e30613", weight: 7, opacity: 0.98 });
  const marker = map.createHtmlMarker(latlngs[0], vehicleMarkerOptions());

  state.simulation = {
    route,
    points,
    latlngs,
    cumulativeDistances,
    geometryDistance: cumulativeDistances.at(-1),
    originalDurationMs,
    animationDurationMs,
    elapsedAnimationMs: 0,
    speed: Number($("#simulation-speed").value) || 1,
    playing: true,
    lastFrameTime: null,
    lastPanTime: 0,
    frameId: null,
    pendingLine,
    completedLine,
    marker
  };

  showRouteSegments(segmentsForRoute(route));

  const simulationName = route.type === "recorded" ? route.name : `${route.start} → ${route.end}`;
  $("#simulation-title").textContent = simulationName;
  setSimulationDetailsVisible(false);
  setSimulationPanelVisible(true);
  $("#simulation-progress").value = "0";
  $("#simulation-speed").value = "1";
  state.simulation.speed = 1;
  updateSimulationPlaybackControls();
  if (route.type === "recorded") setGpsStatus("Simulando recorrido", simulationName, "good");
  else setMessage("Simulando la ruta planificada.");
  map.fit(latlngs, 55);
  scrollToSimulationMap();
  renderSimulation(0, false);
  state.simulation.frameId = requestAnimationFrame(simulationFrame);
}

function simulationFrame(timestamp) {
  const simulation = state.simulation;
  if (!simulation?.playing) return;
  if (simulation.lastFrameTime === null) simulation.lastFrameTime = timestamp;
  const delta = timestamp - simulation.lastFrameTime;
  simulation.lastFrameTime = timestamp;
  simulation.elapsedAnimationMs = Math.min(
    simulation.animationDurationMs,
    simulation.elapsedAnimationMs + delta * simulation.speed
  );
  const fraction = simulation.elapsedAnimationMs / simulation.animationDurationMs;
  renderSimulation(fraction, timestamp - simulation.lastPanTime > 450);
  if (timestamp - simulation.lastPanTime > 450) simulation.lastPanTime = timestamp;

  if (fraction >= 1) {
    simulation.playing = false;
    simulation.lastFrameTime = null;
    updateSimulationPlaybackControls();
    if (simulation.route.type === "recorded") setGpsStatus("Simulación finalizada", simulation.route.name, "good");
    else setMessage("Simulación de la ruta planificada finalizada.");
    return;
  }
  simulation.frameId = requestAnimationFrame(simulationFrame);
}

function renderSimulation(fraction, followVehicle = true) {
  const simulation = state.simulation;
  if (!simulation) return;
  const safeFraction = Math.min(1, Math.max(0, fraction));
  let segmentIndex = 0;
  let segmentFraction = 0;

  if (simulation.geometryDistance > 0) {
    const targetDistance = simulation.geometryDistance * safeFraction;
    while (
      segmentIndex < simulation.cumulativeDistances.length - 2 &&
      simulation.cumulativeDistances[segmentIndex + 1] < targetDistance
    ) segmentIndex += 1;
    const segmentStart = simulation.cumulativeDistances[segmentIndex];
    const segmentLength = simulation.cumulativeDistances[segmentIndex + 1] - segmentStart;
    segmentFraction = segmentLength ? (targetDistance - segmentStart) / segmentLength : 0;
  } else {
    const scaledIndex = safeFraction * (simulation.latlngs.length - 1);
    segmentIndex = Math.min(simulation.latlngs.length - 2, Math.floor(scaledIndex));
    segmentFraction = scaledIndex - segmentIndex;
  }

  const from = simulation.latlngs[segmentIndex];
  const to = simulation.latlngs[segmentIndex + 1];
  const current = {
    lat: from.lat + (to.lat - from.lat) * segmentFraction,
    lng: from.lng + (to.lng - from.lng) * segmentFraction
  };
  const completedPoints = simulation.latlngs.slice(0, segmentIndex + 1).concat(current);
  const pendingPoints = [current].concat(simulation.latlngs.slice(segmentIndex + 1));
  simulation.completedLine.setPoints(completedPoints);
  simulation.pendingLine.setPoints(pendingPoints);
  simulation.marker.setPosition(current);

  const vehicle = simulation.marker.getElement()?.querySelector(".vehicle-marker");
  if (vehicle) vehicle.style.setProperty("--vehicle-rotation", `${bearingBetween(from, to)}deg`);
  if (followVehicle) map.panTo(current);

  const simulatedDuration = simulation.originalDurationMs * safeFraction;
  const routeDistance = simulation.route.distanceMeters || (simulation.route.distanceKm * 1000) || simulation.geometryDistance;
  $("#simulation-progress").value = String(Math.round(safeFraction * 1000));
  $("#simulation-time").textContent = `${formatDuration(simulatedDuration)} / ${formatDuration(simulation.originalDurationMs)}`;
  $("#simulation-distance").textContent = `${formatDistance(routeDistance * safeFraction)} / ${formatDistance(routeDistance)}`;
}

function bearingBetween(from, to) {
  const startLat = from.lat * Math.PI / 180;
  const endLat = to.lat * Math.PI / 180;
  const longitudeDelta = (to.lng - from.lng) * Math.PI / 180;
  const y = Math.sin(longitudeDelta) * Math.cos(endLat);
  const x = Math.cos(startLat) * Math.sin(endLat) - Math.sin(startLat) * Math.cos(endLat) * Math.cos(longitudeDelta);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function updateSimulationPlaybackControls() {
  const simulation = state.simulation;
  const playButton = $("#simulation-play");
  const pauseButton = $("#simulation-pause");
  if (!simulation) {
    playButton.disabled = true;
    pauseButton.disabled = true;
    playButton.textContent = "▶ Iniciar";
    return;
  }
  playButton.disabled = simulation.playing;
  pauseButton.disabled = !simulation.playing;
  playButton.textContent = simulation.elapsedAnimationMs >= simulation.animationDurationMs
    ? "▶ Repetir"
    : simulation.elapsedAnimationMs > 0 ? "▶ Continuar" : "▶ Iniciar";
}

function playSimulation() {
  const simulation = state.simulation;
  if (!simulation || simulation.playing) return;
  if (simulation.elapsedAnimationMs >= simulation.animationDurationMs) {
    simulation.elapsedAnimationMs = 0;
    renderSimulation(0, true);
  }
  simulation.playing = true;
  simulation.lastFrameTime = null;
  updateSimulationPlaybackControls();
  simulation.frameId = requestAnimationFrame(simulationFrame);
}

function pauseSimulation() {
  const simulation = state.simulation;
  if (!simulation || !simulation.playing) return;
  simulation.playing = false;
  simulation.lastFrameTime = null;
  cancelAnimationFrame(simulation.frameId);
  updateSimulationPlaybackControls();
}

function restartSimulation() {
  const simulation = state.simulation;
  if (!simulation) return;
  cancelAnimationFrame(simulation.frameId);
  simulation.elapsedAnimationMs = 0;
  simulation.lastFrameTime = null;
  simulation.playing = true;
  renderSimulation(0, true);
  updateSimulationPlaybackControls();
  simulation.frameId = requestAnimationFrame(simulationFrame);
}

function locateSimulationUser() {
  const button = $("#simulation-locate");
  if (!navigator.geolocation) {
    showMapBanner("Este dispositivo no permite consultar la ubicación.", "warning", 6000);
    return;
  }

  pauseSimulation();
  button.disabled = true;
  button.textContent = "Buscando GPS…";
  showMapBanner("Buscando tu ubicación actual…", "info", 0);
  navigator.geolocation.getCurrentPosition(position => {
    const point = { lat: position.coords.latitude, lng: position.coords.longitude };
    const accuracy = Math.max(5, Math.round(position.coords.accuracy) || 20);
    updateCurrentLocation(point, accuracy);
    map.setView(point, Math.max(map.getZoom(), 17));
    button.disabled = false;
    button.textContent = "◎ Mi ubicación";
    showMapBanner(`Ubicación encontrada con precisión aproximada de ±${accuracy} m. Pulsa continuar para reanudar.`, "info", 6000);
  }, error => {
    const messages = {
      1: "Debes permitir el acceso a la ubicación para usar este botón.",
      2: "No fue posible encontrar tu ubicación. Activa el GPS.",
      3: "El GPS tardó demasiado. Intenta nuevamente en un lugar abierto."
    };
    button.disabled = false;
    button.textContent = "◎ Mi ubicación";
    showMapBanner(messages[error.code] || "No fue posible consultar tu ubicación.", "warning", 7000);
  }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 });
}

function setSimulationPanelVisible(visible) {
  const panel = $("#simulation-panel");
  const showButton = $("#simulation-show");
  panel.hidden = !visible;
  showButton.hidden = visible || !state.simulation;
  showButton.setAttribute("aria-expanded", String(visible));
  if (visible) setRouteSegmentsExpanded(false);
  syncDashboardDock();
}

function setSimulationDetailsVisible(visible) {
  const description = $("#simulation-description");
  const toggle = $("#simulation-details-toggle");
  description.hidden = !visible;
  $("#simulation-panel").classList.toggle("details-open", visible);
  toggle.setAttribute("aria-expanded", String(visible));
  toggle.setAttribute("aria-label", visible ? "Ocultar descripción del recorrido" : "Mostrar descripción del recorrido");
}

function scrollToSimulationMap() {
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  window.requestAnimationFrame(() => {
    window.scrollTo({ top: 0, left: 0, behavior: reducedMotion ? "auto" : "smooth" });
    window.setTimeout(() => map.resize(), reducedMotion ? 0 : 350);
  });
}

function closeSimulation() {
  const simulation = state.simulation;
  if (simulation) {
    cancelAnimationFrame(simulation.frameId);
    [simulation.pendingLine, simulation.completedLine, simulation.marker].forEach(layer => {
      if (layer && map.contains(layer)) map.remove(layer);
    });
  }
  state.simulation = null;
  const panel = $("#simulation-panel");
  if (panel) panel.hidden = true;
  const showButton = $("#simulation-show");
  if (showButton) {
    showButton.hidden = true;
    showButton.setAttribute("aria-expanded", "false");
  }
  const description = $("#simulation-description");
  if (description) description.hidden = true;
  panel?.classList.remove("details-open");
  const locateButton = $("#simulation-locate");
  if (locateButton) {
    locateButton.disabled = false;
    locateButton.textContent = "◎ Mi ubicación";
  }
  updateSimulationPlaybackControls();
  syncDashboardDock();
}

function showRecordedRoute(id) {
  const route = getRoutes().find(item => item.id === id && item.type === "recorded");
  if (!route) return;
  closeSimulation();
  setMode("capture");
  clearCaptureLayers();
  state.track = route;
  state.trackLine.setPoints(route.points);
  if (state.trackLine.getPoints().length) map.fit(state.trackLine.getPoints(), 35);
  $("#live-distance").textContent = formatDistance(route.distanceMeters);
  $("#live-duration").textContent = formatDuration(getElapsedMilliseconds(route));
  $("#live-points").textContent = route.points.length;
  setGpsStatus("Recorrido guardado", route.name, "good");
  startCaptureButton.disabled = false;
  startCaptureButton.querySelector("span:last-child").textContent = "Iniciar otro recorrido";
  showRouteSegments(segmentsForRoute(route));
}

function showPlannedRoute(id) {
  const route = getRoutes().find(item => item.id === id && item.type === "planned");
  const points = window.RouteExport.routePoints(route);
  if (!route || points.length < 2) {
    showMapBanner("Esta ruta planificada es antigua y no tiene coordenadas guardadas. Calcúlala nuevamente.", "warning", 7000);
    return;
  }
  closeSimulation();
  setMode("plan");
  resetPlannedPoints();
  state.start = { ...points[0], label: route.start };
  state.end = { ...points.at(-1), label: route.end };
  setPoint("start", state.start, route.start);
  setPoint("end", state.end, route.end);
  state.waypoints = (Array.isArray(route.waypoints) ? route.waypoints : []).map(waypoint => ({
    id: String(++waypointSequence),
    point: { lat: Number(waypoint.lat), lng: Number(waypoint.lng) },
    label: waypoint.label || `${Number(waypoint.lat).toFixed(6)}, ${Number(waypoint.lng).toFixed(6)}`,
    marker: null
  })).filter(waypoint => Number.isFinite(waypoint.point.lat) && Number.isFinite(waypoint.point.lng));
  renderWaypointRows();
  refreshWaypointMarkers();
  state.plannedLine = map.createPolyline(points, { color: "#111111", weight: 6, opacity: 0.9 });
  map.fit(points, 35);
  dateInput.value = route.date;
  timeInput.value = route.time;
  $("#distance").textContent = `${route.distanceKm.toFixed(1)} km`;
  $("#duration").textContent = `${route.durationMin} min`;
  showRouteSegments(segmentsForRoute(route));
  setMessage("Ruta planificada cargada desde el historial.");
}

function deleteRoute(id) {
  if (state.simulation?.route.id === id) closeSimulation();
  hideRouteSegments();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(getRoutes().filter(route => route.id !== id)));
  renderHistory();
}

function exportRoute(id, format) {
  const route = getRoutes().find(item => item.id === id);
  if (!route) return;
  try {
    window.RouteExport.download(route, format);
    showMapBanner(`Descarga ${format.toUpperCase()} preparada correctamente.`, "info", 3500);
  } catch (error) {
    showMapBanner(error.message, "warning", 7000);
  }
}

function exportMenu(route) {
  return `<details class="export-menu">
    <summary>Descargar ▾</summary>
    <div class="export-options" aria-label="Formatos de descarga">
      <button type="button" data-export="${route.id}" data-format="csv">CSV</button>
      <button type="button" data-export="${route.id}" data-format="kml">KML</button>
      <button type="button" data-export="${route.id}" data-format="shp">SHP</button>
    </div>
  </details>`;
}

function renderHistory() {
  const routes = getRoutes();
  $("#history").innerHTML = routes.length ? routes.map(route => {
    if (route.type === "recorded") {
      return `<article class="history-card recorded">
        <div class="history-heading"><span class="kind">GPS</span><strong>${escapeHtml(route.name)}</strong></div>
        <p class="when">${formatDateTime(route.startedAt)}</p>
        <p>${formatDistance(route.distanceMeters)} · ${formatDuration(getElapsedMilliseconds(route))} · ${route.points.length} puntos</p>
        <div class="card-actions"><button data-simulate="${route.id}">▶ Simular</button><button data-view-recorded="${route.id}">Ver en mapa</button>${exportMenu(route)}<button class="delete-route" data-delete="${route.id}">Eliminar</button></div>
      </article>`;
    }
    return `<article class="history-card planned">
      <div class="history-heading"><span class="kind">PLAN</span><strong>Ruta programada</strong></div>
      <p class="when">${new Date(`${route.date}T${route.time}`).toLocaleString("es-CO", { dateStyle: "medium", timeStyle: "short" })}</p>
      <p><strong>Desde:</strong> ${escapeHtml(route.start)}</p>
      <p><strong>Hasta:</strong> ${escapeHtml(route.end)}</p>
      ${route.waypoints?.length ? `<p><strong>Puntos obligatorios:</strong> ${route.waypoints.length} · ${route.waypoints.map(waypoint => escapeHtml(waypoint.label || `${waypoint.lat}, ${waypoint.lng}`)).join(" → ")}</p>` : ""}
      <p>${route.distanceKm.toFixed(1)} km · ${route.durationMin} min aprox.</p>
        <div class="card-actions"><button data-simulate="${route.id}">▶ Simular</button><button data-view-planned="${route.id}">Ver en mapa</button>${exportMenu(route)}<button class="delete-route" data-delete="${route.id}">Eliminar</button></div>
    </article>`;
  }).join("") : '<p class="empty">Todavía no hay recorridos guardados.</p>';

  document.querySelectorAll("[data-simulate]").forEach(button => button.addEventListener("click", () => startRouteSimulation(Number(button.dataset.simulate))));
  document.querySelectorAll("[data-view-recorded]").forEach(button => button.addEventListener("click", () => showRecordedRoute(Number(button.dataset.viewRecorded))));
  document.querySelectorAll("[data-view-planned]").forEach(button => button.addEventListener("click", () => showPlannedRoute(Number(button.dataset.viewPlanned))));
  document.querySelectorAll("[data-export]").forEach(button => button.addEventListener("click", () => exportRoute(Number(button.dataset.export), button.dataset.format)));
  document.querySelectorAll("[data-delete]").forEach(button => button.addEventListener("click", () => deleteRoute(Number(button.dataset.delete))));
}

function distanceBetween(from, to) {
  const earthRadius = 6371008.8;
  const latitude1 = from.lat * Math.PI / 180;
  const latitude2 = to.lat * Math.PI / 180;
  const latitudeDelta = (to.lat - from.lat) * Math.PI / 180;
  const longitudeDelta = (to.lng - from.lng) * Math.PI / 180;
  const value = Math.sin(latitudeDelta / 2) ** 2 + Math.cos(latitude1) * Math.cos(latitude2) * Math.sin(longitudeDelta / 2) ** 2;
  return earthRadius * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function formatDistance(meters) { return meters >= 1000 ? `${(meters / 1000).toFixed(2)} km` : `${Math.round(meters)} m`; }
function formatSegmentDuration(seconds) {
  const minutes = Math.max(1, Math.round(seconds / 60));
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
}
function formatDuration(milliseconds) {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}` : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
function formatDateTime(value) { return new Date(value).toLocaleString("es-CO", { dateStyle: "medium", timeStyle: "short" }); }
function escapeHtml(value = "") { return value.replace(/[&<>'"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]); }

$("#add-waypoint").addEventListener("click", () => addWaypoint());
$("#reset").addEventListener("click", resetPlannedPoints);
$("#clear-history").addEventListener("click", () => {
  if (!getRoutes().length || confirm("¿Borrar todos los recorridos guardados en este dispositivo?")) {
    localStorage.removeItem(STORAGE_KEY);
    hideRouteSegments();
    renderHistory();
  }
});

$("#simulation-play").addEventListener("click", playSimulation);
$("#simulation-pause").addEventListener("click", pauseSimulation);
$("#simulation-restart").addEventListener("click", restartSimulation);
$("#simulation-locate").addEventListener("click", locateSimulationUser);
$("#simulation-show").addEventListener("click", () => setSimulationPanelVisible(true));
$("#route-segments-toggle").addEventListener("click", event => {
  setRouteSegmentsExpanded(event.currentTarget.getAttribute("aria-expanded") !== "true");
});
$("#simulation-hide").addEventListener("click", () => setSimulationPanelVisible(false));
$("#simulation-details-toggle").addEventListener("click", event => {
  setSimulationDetailsVisible(event.currentTarget.getAttribute("aria-expanded") !== "true");
});
$("#simulation-close").addEventListener("click", closeSimulation);
$("#simulation-speed").addEventListener("change", event => {
  if (state.simulation) state.simulation.speed = Number(event.target.value) || 1;
});
$("#simulation-progress").addEventListener("input", event => {
  const simulation = state.simulation;
  if (!simulation) return;
  pauseSimulation();
  const fraction = Number(event.target.value) / 1000;
  simulation.elapsedAnimationMs = simulation.animationDurationMs * fraction;
  renderSimulation(fraction, true);
  updateSimulationPlaybackControls();
});

if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
restoreActiveTrack();
renderHistory();
}

initApp().catch(error => {
  console.error(error);
  const banner = document.querySelector("#map-banner");
  if (banner) {
    banner.textContent = "No fue posible iniciar el mapa. Recarga la aplicación o revisa la conexión.";
    banner.className = "map-banner error";
    banner.hidden = false;
  }
});
