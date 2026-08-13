const DEFAULT_CENTER = [4.711, -74.0721];
const STORAGE_KEY = "ruteo-routes-v2";
const ACTIVE_TRACK_KEY = "ruteo-active-track-v2";
const MIN_POINT_DISTANCE_METERS = 5;
const MAX_ACCEPTED_ACCURACY_METERS = 60;

const map = L.map("map", { zoomControl: false }).setView(DEFAULT_CENTER, 12);
L.control.zoom({ position: "topright" }).addTo(map);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
}).addTo(map);

const state = {
  mode: "capture",
  start: null,
  end: null,
  startMarker: null,
  endMarker: null,
  plannedLine: null,
  watchId: null,
  wakeLock: null,
  track: null,
  trackLine: L.polyline([], { color: "#e30613", weight: 7, opacity: 0.95 }).addTo(map),
  currentMarker: null,
  accuracyCircle: null,
  captureStartMarker: null,
  captureEndMarker: null,
  timerId: null,
  followLocation: true
};

const $ = selector => document.querySelector(selector);
const form = $("#route-form");
const startInput = $("#start");
const endInput = $("#end");
const dateInput = $("#date");
const timeInput = $("#time");
const message = $("#message");
const calculateButton = $("#calculate");
const startCaptureButton = $("#start-capture");
const pauseCaptureButton = $("#pause-capture");
const finishCaptureButton = $("#finish-capture");

const now = new Date();
dateInput.value = now.toISOString().slice(0, 10);
timeInput.value = now.toTimeString().slice(0, 5);

function setMode(mode) {
  if (state.track?.status === "recording" && mode !== "capture") {
    showMapBanner("Finaliza o pausa el recorrido antes de cambiar de modo.", "warning");
    return;
  }
  state.mode = mode;
  document.querySelectorAll(".mode-tab").forEach(button => button.classList.toggle("active", button.dataset.mode === mode));
  $("#capture-mode").hidden = mode !== "capture";
  $("#plan-mode").hidden = mode !== "plan";
  setTimeout(() => map.invalidateSize(), 0);
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
  const latlng = L.latLng(point.lat, point.lng);

  updateCurrentLocation(latlng, point.accuracy);
  $("#live-accuracy").textContent = `±${point.accuracy} m`;

  if (point.accuracy > MAX_ACCEPTED_ACCURACY_METERS) {
    setGpsStatus("Señal GPS débil", `Precisión actual: ±${point.accuracy} m. Esperando una mejor señal.`, "warning");
    return;
  }

  const previous = state.track.points.at(-1);
  const distanceFromPrevious = previous ? latlng.distanceTo([previous.lat, previous.lng]) : Infinity;
  const secondsFromPrevious = previous ? (position.timestamp - new Date(previous.timestamp).getTime()) / 1000 : Infinity;
  if (previous && distanceFromPrevious < MIN_POINT_DISTANCE_METERS && secondsFromPrevious < 12) {
    setGpsStatus("Grabando recorrido", `Ubicación activa · precisión ±${point.accuracy} m`, point.accuracy <= 30 ? "good" : "warning");
    return;
  }

  if (previous) state.track.distanceMeters += distanceFromPrevious;
  state.track.points.push(point);
  state.trackLine.addLatLng(latlng);

  if (!state.captureStartMarker) {
    state.captureStartMarker = L.circleMarker(latlng, {
      radius: 8, color: "#fff", weight: 3, fillColor: "#111111", fillOpacity: 1
    }).addTo(map).bindPopup("Inicio del recorrido");
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
    state.currentMarker = L.circleMarker(latlng, {
      radius: 9, color: "#fff", weight: 3, fillColor: "#111111", fillOpacity: 1
    }).addTo(map);
    state.accuracyCircle = L.circle(latlng, { radius: accuracy, color: "#e30613", weight: 1, fillOpacity: 0.08 }).addTo(map);
  } else {
    state.currentMarker.setLatLng(latlng);
    state.accuracyCircle.setLatLng(latlng).setRadius(accuracy);
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
  state.captureEndMarker = L.circleMarker([finalPoint.lat, finalPoint.lng], {
    radius: 8, color: "#fff", weight: 3, fillColor: "#e30613", fillOpacity: 1
  }).addTo(map).bindPopup("Fin del recorrido");
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
  if (state.trackLine.getLatLngs().length) map.fitBounds(state.trackLine.getBounds(), { padding: [35, 35] });
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
  state.trackLine.setLatLngs(saved.points.map(point => [point.lat, point.lng]));
  const first = saved.points[0];
  const last = saved.points.at(-1);
  state.captureStartMarker = L.circleMarker([first.lat, first.lng], { radius: 8, color: "#fff", weight: 3, fillColor: "#111111", fillOpacity: 1 }).addTo(map);
  updateCurrentLocation(L.latLng(last.lat, last.lng), last.accuracy);
  map.fitBounds(state.trackLine.getBounds(), { padding: [35, 35] });
  $("#track-name").value = saved.name;
  $("#live-accuracy").textContent = `±${last.accuracy} m`;
  setGpsStatus("Recorrido recuperado", "Pulsa continuar para volver a grabar.", "paused");
  startCaptureButton.querySelector("span:last-child").textContent = "Continuar recorrido";
  finishCaptureButton.hidden = false;
  updateLiveMetrics();
}

function clearCaptureLayers() {
  state.trackLine.setLatLngs([]);
  ["currentMarker", "accuracyCircle", "captureStartMarker", "captureEndMarker"].forEach(key => {
    if (state[key]) map.removeLayer(state[key]);
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
  map.setView([last.lat, last.lng], Math.max(map.getZoom(), 17));
});

map.on("dragstart", () => { if (state.track?.status === "recording") state.followLocation = false; });

function setMessage(text = "") { message.textContent = text; }

function setPoint(type, latlng, label) {
  const isStart = type === "start";
  const markerKey = isStart ? "startMarker" : "endMarker";
  if (state[markerKey]) map.removeLayer(state[markerKey]);
  state[type] = { lat: latlng.lat, lng: latlng.lng, label };
  state[markerKey] = L.marker(latlng).addTo(map).bindPopup(isStart ? "Punto de partida" : "Punto final");
  (isStart ? startInput : endInput).value = label;
}

map.on("click", ({ latlng }) => {
  if (state.mode !== "plan") return;
  const type = !state.start || state.end ? "start" : "end";
  if (type === "start" && state.end) resetPlannedPoints();
  setPoint(type, latlng, `${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}`);
  setMessage(type === "start" ? "Ahora selecciona el punto final." : "Puntos listos para calcular.");
});

async function searchPlace(type) {
  const input = type === "start" ? startInput : endInput;
  const query = input.value.trim();
  if (!query) return setMessage("Escribe una dirección para buscarla.");
  setMessage("Buscando ubicación…");
  try {
    const response = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`, { headers: { "Accept-Language": "es" } });
    if (!response.ok) throw new Error();
    const [result] = await response.json();
    if (!result) return setMessage("No encontramos esa ubicación. Intenta ser más específico.");
    const latlng = L.latLng(Number(result.lat), Number(result.lon));
    setPoint(type, latlng, result.display_name);
    map.setView(latlng, 15);
    setMessage("Ubicación encontrada.");
  } catch { setMessage("No fue posible consultar la ubicación. Revisa tu conexión."); }
}

document.querySelectorAll("[data-search]").forEach(button => button.addEventListener("click", () => searchPlace(button.dataset.search)));

form.addEventListener("submit", async event => {
  event.preventDefault();
  if (!state.start || !state.end) return setMessage("Busca o selecciona en el mapa los dos puntos.");
  calculateButton.disabled = true;
  setMessage("Calculando la mejor ruta…");
  try {
    const coords = `${state.start.lng},${state.start.lat};${state.end.lng},${state.end.lat}`;
    const response = await fetch(`https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson`);
    if (!response.ok) throw new Error();
    const data = await response.json();
    const route = data.routes?.[0];
    if (!route) throw new Error();
    if (state.plannedLine) map.removeLayer(state.plannedLine);
    state.plannedLine = L.geoJSON(route.geometry, { style: { color: "#111111", weight: 6, opacity: 0.9 } }).addTo(map);
    map.fitBounds(state.plannedLine.getBounds(), { padding: [35, 35] });
    const distanceKm = route.distance / 1000;
    const durationMin = Math.round(route.duration / 60);
    $("#distance").textContent = `${distanceKm.toFixed(1)} km`;
    $("#duration").textContent = durationMin >= 60 ? `${Math.floor(durationMin / 60)} h ${durationMin % 60} min` : `${durationMin} min`;
    saveRoute({ id: Date.now(), type: "planned", start: state.start.label, end: state.end.label, date: dateInput.value, time: timeInput.value, distanceKm, durationMin });
    setMessage("Ruta calculada y guardada.");
  } catch { setMessage("No se pudo calcular la ruta. Verifica los puntos e intenta de nuevo."); }
  finally { calculateButton.disabled = false; }
});

function resetPlannedPoints() {
  ["startMarker", "endMarker", "plannedLine"].forEach(key => {
    if (state[key]) map.removeLayer(state[key]);
    state[key] = null;
  });
  state.start = null;
  state.end = null;
  startInput.value = "";
  endInput.value = "";
  $("#distance").textContent = "—";
  $("#duration").textContent = "—";
  setMessage("");
}

function getRoutes() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"); } catch { return []; }
}

function saveRoute(route) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify([route, ...getRoutes()].slice(0, 20)));
  renderHistory();
}

function showRecordedRoute(id) {
  const route = getRoutes().find(item => item.id === id && item.type === "recorded");
  if (!route) return;
  setMode("capture");
  clearCaptureLayers();
  state.track = route;
  state.trackLine.setLatLngs(route.points.map(point => [point.lat, point.lng]));
  if (state.trackLine.getLatLngs().length) map.fitBounds(state.trackLine.getBounds(), { padding: [35, 35] });
  $("#live-distance").textContent = formatDistance(route.distanceMeters);
  $("#live-duration").textContent = formatDuration(getElapsedMilliseconds(route));
  $("#live-points").textContent = route.points.length;
  setGpsStatus("Recorrido guardado", route.name, "good");
  startCaptureButton.disabled = false;
  startCaptureButton.querySelector("span:last-child").textContent = "Iniciar otro recorrido";
}

function deleteRoute(id) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(getRoutes().filter(route => route.id !== id)));
  renderHistory();
}

function renderHistory() {
  const routes = getRoutes();
  $("#history").innerHTML = routes.length ? routes.map(route => {
    if (route.type === "recorded") {
      return `<article class="history-card recorded">
        <div class="history-heading"><span class="kind">GPS</span><strong>${escapeHtml(route.name)}</strong></div>
        <p class="when">${formatDateTime(route.startedAt)}</p>
        <p>${formatDistance(route.distanceMeters)} · ${formatDuration(getElapsedMilliseconds(route))} · ${route.points.length} puntos</p>
        <div class="card-actions"><button data-view="${route.id}">Ver en mapa</button><button data-delete="${route.id}">Eliminar</button></div>
      </article>`;
    }
    return `<article class="history-card planned">
      <div class="history-heading"><span class="kind">PLAN</span><strong>Ruta programada</strong></div>
      <p class="when">${new Date(`${route.date}T${route.time}`).toLocaleString("es-CO", { dateStyle: "medium", timeStyle: "short" })}</p>
      <p><strong>Desde:</strong> ${escapeHtml(route.start)}</p>
      <p><strong>Hasta:</strong> ${escapeHtml(route.end)}</p>
      <p>${route.distanceKm.toFixed(1)} km · ${route.durationMin} min aprox.</p>
      <div class="card-actions"><button data-delete="${route.id}">Eliminar</button></div>
    </article>`;
  }).join("") : '<p class="empty">Todavía no hay recorridos guardados.</p>';

  document.querySelectorAll("[data-view]").forEach(button => button.addEventListener("click", () => showRecordedRoute(Number(button.dataset.view))));
  document.querySelectorAll("[data-delete]").forEach(button => button.addEventListener("click", () => deleteRoute(Number(button.dataset.delete))));
}

function formatDistance(meters) { return meters >= 1000 ? `${(meters / 1000).toFixed(2)} km` : `${Math.round(meters)} m`; }
function formatDuration(milliseconds) {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}` : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
function formatDateTime(value) { return new Date(value).toLocaleString("es-CO", { dateStyle: "medium", timeStyle: "short" }); }
function escapeHtml(value = "") { return value.replace(/[&<>'"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]); }

$("#reset").addEventListener("click", resetPlannedPoints);
$("#clear-history").addEventListener("click", () => {
  if (!getRoutes().length || confirm("¿Borrar todos los recorridos guardados en este dispositivo?")) {
    localStorage.removeItem(STORAGE_KEY);
    renderHistory();
  }
});

if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
restoreActiveTrack();
renderHistory();
