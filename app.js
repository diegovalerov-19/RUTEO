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
  onGoogleAuthFailure: () => showMapBanner("Google rechazÃ³ la API key. Revisa sus restricciones o configura otra clave.", "error", 0)
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
  simulation: null
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
  if (state.mode !== mode) closeSimulation();
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
      showMapBanner("La API key no parece vÃ¡lida. Normalmente comienza con AIza.", "warning", 6000);
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
  showMapBanner("No fue posible activar Google Maps. Se cargÃ³ el mapa de respaldo; revisa tu API key y la conexiÃ³n.", "warning", 8000);
}

function updateConnectionStatus() {
  const online = navigator.onLine;
  const pill = $("#online-status");
  pill.textContent = online ? "En lÃ­nea" : "Sin conexiÃ³n";
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
    setGpsStatus("GPS no disponible", "Este navegador no permite obtener la ubicaciÃ³n.", "error");
    return;
  }

  stopWatchingPosition();
  closeSimulation();

  if (!state.track || state.track.status === "finished") {
    clearCaptureLayers();
    state.track = createTrack();
  } else if (state.track.status === "paused") {
    state.track.pausedMilliseconds += Date.now() - new Date(state.track.pausedAt).getTime();
    state.track.pausedAt = null;
    state.track.status = "recording";
  }

  setGpsStatus("Buscando seÃ±al GPSâ€¦", "Acepta el permiso de ubicaciÃ³n cuando Android lo solicite.", "searching");
  startCaptureButton.disabled = true;
  startCaptureButton.querySelector("span:last-child").textContent = "Buscando GPSâ€¦";

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
  $("#live-accuracy").textContent = `Â±${point.accuracy} m`;

  if (point.accuracy > MAX_ACCEPTED_ACCURACY_METERS) {
    setGpsStatus("SeÃ±al GPS dÃ©bil", `PrecisiÃ³n actual: Â±${point.accuracy} m. Esperando una mejor seÃ±al.`, "warning");
    return;
  }

  const previous = state.track.points.at(-1);
  const distanceFromPrevious = previous ? distanceBetween(previous, latlng) : Infinity;
  const secondsFromPrevious = previous ? (position.timestamp - new Date(previous.timestamp).getTime()) / 1000 : Infinity;
  if (previous && distanceFromPrevious < MIN_POINT_DISTANCE_METERS && secondsFromPrevious < 12) {
    setGpsStatus("Grabando recorrido", `UbicaciÃ³n activa Â· precisiÃ³n Â±${point.accuracy} m`, point.accuracy <= 30 ? "good" : "warning");
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

  setGpsStatus("Grabando recorrido", `UbicaciÃ³n activa Â· precisiÃ³n Â±${point.accuracy} m`, point.accuracy <= 30 ? "good" : "warning");
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
    1: ["Permiso de ubicaciÃ³n bloqueado", "En Android abre Ajustes â†’ Aplicaciones â†’ Chrome â†’ Permisos â†’ UbicaciÃ³n â†’ Permitir mientras se usa."],
    2: ["No se encuentra la ubicaciÃ³n", "Activa el GPS y el modo de ubicaciÃ³n de alta precisiÃ³n."],
    3: ["El GPS tardÃ³ demasiado", "Sal a un lugar abierto y vuelve a intentarlo."]
  };
  const [title, detail] = errors[error.code] || ["Error de ubicaciÃ³n", error.message];
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
  setGpsStatus("Recorrido pausado", "El GPS no estÃ¡ agregando puntos.", "paused");
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
  $("#live-accuracy").textContent = `Â±${last.accuracy} m`;
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
  $("#live-accuracy").textContent = "â€”";
  $("#live-points").textContent = "0";
}

async function requestWakeLock() {
  if (!("wakeLock" in navigator)) return;
  try { state.wakeLock = await navigator.wakeLock.request("screen"); } catch { /* Android puede denegarlo por ahorro de baterÃ­a. */ }
}

async function releaseWakeLock() {
  try { await state.wakeLock?.release(); } catch { /* Ya estaba liberado. */ }
  state.wakeLock = null;
}

document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "visible" && state.track?.status === "recording") {
    await requestWakeLock();
    showMapBanner("Ruteo volviÃ³ al primer plano. Verifica que el GPS siga grabando.", "info");
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

map.on("dragstart", () => { if (state.track?.status === "Ûmø¶‰žËkºwµçUÑ”¹‘ÕÉ…Ñ¥½¹5¥¸€¨€ØÀÀÀÀ¤¤ì(€½¹ÍÐ…¹¥µ…Ñ¥½¹ÕÉ…Ñ¥½¹5Ì€ô5…Ñ ¹µ¥¸ (€€€M%5U1Q%=9}5a}UIQ%=9}5L°(€€€5…Ñ ¹µ…à¡M%5U1Q%=9}5%9}UIQ%=9}5L°½É¥¥¹…±ÕÉ…Ñ¥½¹5Ì€¼M%5U1Q%=9}=5AIMM%=8¤(€€¤ì(€½¹ÍÐÁ•¹‘¥¹1¥¹”€ôµ…À¹É•…Ñ•A½±å±¥¹”¡±…Ñ±¹Ì°ì½±½Èè€ˆŒÜÜÜÜÜÜˆ°Ý•¥¡Ðè€Ø°½Á…¥Ñäè€À¸Ðà°‘…Í¡ÉÉ…äè€ˆà€àˆô¤ì(€½¹ÍÐ½µÁ±•Ñ•‘1¥¹”€ôµ…À¹É•…Ñ•A½±å±¥¹”¡m±…Ñ±¹ÍlÁut°ì½±½Èè€ˆ”ÌÀØÄÌˆ°Ý•¥¡Ðè€Ü°½Á…¥Ñäè€À¸äàô¤ì(€½¹ÍÐµ…É­•È€ôµ…À¹É•…Ñ•!Ñµ±5…É­•È¡±…Ñ±¹ÍlÁt°Ù•¡¥±•5…É­•É=ÁÑ¥½¹Ì ¤¤ì((€ÍÑ…Ñ”¹Í¥µÕ±…Ñ¥½¸€ôì(€€€É½ÕÑ”°(€€€Á½¥¹ÑÌ°(€€€±…Ñ±¹Ì°(€€€ÕµÕ±…Ñ¥Ù•¥ÍÑ…¹•Ì°(€€€•½µ•ÑÉå¥ÍÑ…¹”èÕµÕ±…Ñ¥Ù•¥ÍÑ…¹•Ì¹…Ð ´Ä¤°(€€€½É¥¥¹…±ÕÉ…Ñ¥½¹5Ì°(€€€…¹¥µ…Ñ¥½¹ÕÉ…Ñ¥½¹5Ì°(€€€•±…ÁÍ•‘¹¥µ…Ñ¥½¹5Ìè€À°(€€€ÍÁ••è9Õµ‰•È  ˆÍ¥µÕ±…Ñ¥½¸µÍÁ••ˆ¤¹Ù…±Õ”¤ñð€Ä°(€€€Á±…å¥¹œèÑÉÕ”°(€€€±…ÍÑÉ…µ•Q¥µ”è¹Õ±°°(€€€±…ÍÑA…¹Q¥µ”è€À°(€€€™É…µ•%è¹Õ±°°(€€€Á•¹‘¥¹1¥¹”°(€€€½µÁ±•Ñ•‘1¥¹”°(€€€µ…É­•È(€ôì((€½¹ÍÐÍ¥µÕ±…Ñ¥½¹9…µ”€ôÉ½ÕÑ”¹ÑåÁ”€ôôô€‰É•½É‘•ˆ€üÉ½ÕÑ”¹¹…µ”€è€‘íÉ½ÕÑ”¹ÍÑ…ÉÑôƒŠH€‘íÉ½ÕÑ”¹•¹‘õ€ì(€€ ˆÍ¥µÕ±…Ñ¥½¸µÑ¥Ñ±”ˆ¤¹Ñ•áÑ½¹Ñ•¹Ð€ôÍ¥µÕ±…Ñ¥½¹9…µ”ì(€€ ˆÍ¥µÕ±…Ñ¥½¸µÁ…¹•°ˆ¤¹¡¥‘‘•¸€ô™…±Í”ì(€€ ˆÍ¥µÕ±…Ñ¥½¸µÑ½±”ˆ¤¹Ñ•áÑ½¹Ñ•¹Ð€ô€‹ŠvkŠvhA…ÕÍ…Èˆì(€€ ˆÍ¥µÕ±…Ñ¥½¸µÁÉ½É•ÍÌˆ¤¹Ù…±Õ”€ô€ˆÀˆì(€€ ˆÍ¥µÕ±…Ñ¥½¸µÍÁ••ˆ¤¹Ù…±Õ”€ô€ˆÄˆì(€ÍÑ…Ñ”¹Í¥µÕ±…Ñ¥½¸¹ÍÁ••€ô€Äì(€¥˜€¡É½ÕÑ”¹ÑåÁ”€ôôô€‰É•½É‘•ˆ¤Í•ÑÁÍMÑ…ÑÕÌ ‰M¥µÕ±…¹‘¼É•½ÉÉ¥‘¼ˆ°Í¥µÕ±…Ñ¥½¹9…µ”°€‰½½ˆ¤ì(€•±Í”Í•Ñ5•ÍÍ…” ‰M¥µÕ±…¹‘¼±„ÉÕÑ„Á±…¹¥™¥…‘„¸ˆ¤ì(€µ…À¹™¥Ð¡±…Ñ±¹Ì°€ÔÔ¤ì(€É•¹‘•ÉM¥µÕ±…Ñ¥½¸ À°™…±Í”¤ì(€ÍÑ…Ñ”¹Í¥µÕ±…Ñ¥½¸¹™É…µ•%€ôÉ•ÅÕ•ÍÑ¹¥µ…Ñ¥½¹É…µ”¡Í¥µÕ±…Ñ¥½¹É…µ”¤ì)ô()™Õ¹Ñ¥½¸Í¥µÕ±…Ñ¥½¹É…µ”¡Ñ¥µ•ÍÑ…µÀ¤ì(€½¹ÍÐÍ¥µÕ±…Ñ¥½¸€ôÍÑ…Ñ”¹Í¥µÕ±…Ñ¥½¸ì(€¥˜€ …Í¥µÕ±…Ñ¥½¸ü¹Á±…å¥¹œ¤É•ÑÕÉ¸ì(€¥˜€¡Í¥µÕ±…Ñ¥½¸¹±…ÍÑÉ…µ•Q¥µ”€ôôô¹Õ±°¤Í¥µÕ±…Ñ¥½¸¹±…ÍÑÉ…µ•Q¥µ”€ôÑ¥µ•ÍÑ…µÀì(€½¹ÍÐ‘•±Ñ„€ôÑ¥µ•ÍÑ…µÀ€´Í¥µÕ±…Ñ¥½¸¹±…ÍÑÉ…µ•Q¥µ”ì(€Í¥µÕ±…Ñ¥½¸¹±…ÍÑÉ…µ•Q¥µ”€ôÑ¥µ•ÍÑ…µÀì(€Í¥µÕ±…Ñ¥½¸¹•±…ÁÍ•‘¹¥µ…Ñ¥½¹5Ì€ô5…Ñ ¹µ¥¸ (€€€Í¥µÕ±…Ñ¥½¸¹…¹¥µ…Ñ¥½¹ÕÉ…Ñ¥½¹5Ì°(€€€Í¥µÕ±…Ñ¥½¸¹•±…ÁÍ•‘¹¥µ…Ñ¥½¹5Ì€¬‘•±Ñ„€¨Í¥µÕ±…Ñ¥½¸¹ÍÁ••(€€¤ì(€½¹ÍÐ™É…Ñ¥½¸€ôÍ¥µÕ±…Ñ¥½¸¹•±…ÁÍ•‘¹¥µ…Ñ¥½¹5Ì€¼Í¥µÕ±…Ñ¥½¸¹…¹¥µ…Ñ¥½¹ÕÉ…Ñ¥½¹5Ìì(€É•¹‘•ÉM¥µÕ±…Ñ¥½¸¡™É…Ñ¥½¸°Ñ¥µ•ÍÑ…µÀ€´Í¥µÕ±…Ñ¥½¸¹±…ÍÑA…¹Q¥µ”€ø€ÐÔÀ¤ì(€¥˜€¡Ñ¥µ•ÍÑ…µÀ€´Í¥µÕ±…Ñ¥½¸¹±…ÍÑA…¹Q¥µ”€ø€ÐÔÀ¤Í¥µÕ±…Ñ¥½¸¹±…ÍÑA…¹Q¥µ”€ôÑ¥µ•ÍÑ…µÀì((€¥˜€¡™É…Ñ¥½¸€øô€Ä¤ì(€€€Í¥µÕ±…Ñ¥½¸¹Á±…å¥¹œ€ô™…±Í”ì(€€€Í¥µÕ±…Ñ¥½¸¹±…ÍÑÉ…µ•Q¥µ”€ô¹Õ±°ì(€€€€ ˆÍ¥µÕ±…Ñ¥½¸µÑ½±”ˆ¤¹Ñ•áÑ½¹Ñ•¹Ð€ô€‹ŠZØI•Á•Ñ¥Èˆì(€€€¥˜€¡Í¥µÕ±…Ñ¥½¸¹É½ÕÑ”¹ÑåÁ”€ôôô€‰É•½É‘•ˆ¤Í•ÑÁÍMÑ…ÑÕÌ ‰M¥µÕ±…§Í¸™¥¹…±¥é…‘„ˆ°Í¥µÕ±…Ñ¥½¸¹É½ÕÑ”¹¹…µ”°€‰½½ˆ¤ì(€€€•±Í”Í•Ñ5•ÍÍ…” ‰M¥µÕ±…§Í¸‘”±„ÉÕÑ„Á±…¹¥™¥…‘„™¥¹…±¥é…‘„¸ˆ¤ì(€€€É•ÑÕÉ¸ì(€ô(€Í¥µÕ±…Ñ¥½¸¹™É…µ•%€ôÉ•ÅÕ•ÍÑ¹¥µ…Ñ¥½¹É…µ”¡Í¥µÕ±…Ñ¥½¹É…µ”¤ì)ô()™Õ¹Ñ¥½¸É•¹‘•ÉM¥µÕ±…Ñ¥½¸¡™É…Ñ¥½¸°™½±±½ÝY•¡¥±”€ôÑÉÕ”¤ì(€½¹ÍÐÍ¥µÕ±…Ñ¥½¸€ôÍÑ…Ñ”¹Í¥µÕ±…Ñ¥½¸ì(€¥˜€ …Í¥µÕ±…Ñ¥½¸¤É•ÑÕÉ¸ì(€½¹ÍÐÍ…™•É…Ñ¥½¸€ô5…Ñ ¹µ¥¸ Ä°5…Ñ ¹µ…à À°™É…Ñ¥½¸¤¤ì(€±•ÐÍ•µ•¹Ñ%¹‘•à€ô€Àì(€±•ÐÍ•µ•¹ÑÉ…Ñ¥½¸€ô€Àì((€¥˜€¡Í¥µÕ±…Ñ¥½¸¹•½µ•ÑÉå¥ÍÑ…¹”€ø€À¤ì(€€€½¹ÍÐÑ…É•Ñ¥ÍÑ…¹”€ôÍ¥µÕ±…Ñ¥½¸¹•½µ•ÑÉå¥ÍÑ…¹”€¨Í…™•É…Ñ¥½¸ì(€€€Ý¡¥±”€ (€€€€€Í•µ•¹Ñ%¹‘•à€ðÍ¥µÕ±…Ñ¥½¸¹ÕµÕ±…Ñ¥Ù•¥ÍÑ…¹•Ì¹±•¹Ñ €´€È€˜˜(€€€€€Í¥µÕ±…Ñ¥½¸¹ÕµÕ±…Ñ¥Ù•¥ÍÑ…¹•ÍmÍ•µ•¹Ñ%¹‘•à€¬€Åt€ðÑ…É•Ñ¥ÍÑ…¹”(€€€€¤Í•µ•¹Ñ%¹‘•à€¬ô€Äì(€€€½¹ÍÐÍ•µ•¹ÑMÑ…ÉÐ€ôÍ¥µÕ±…Ñ¥½¸¹ÕµÕ±…Ñ¥Ù•¥ÍÑ…¹•ÍmÍ•µ•¹Ñ%¹‘•átì(€€€½¹ÍÐÍ•µ•¹Ñ1•¹Ñ €ôÍ¥µÕ±…Ñ¥½¸¹ÕµÕ±…Ñ¥Ù•¥ÍÑ…¹•ÍmÍ•µ•¹Ñ%¹‘•à€¬€Åt€´Í•µ•¹ÑMÑ…ÉÐì(€€€Í•µ•¹ÑÉ…Ñ¥½¸€ôÍ•µ•¹Ñ1•¹Ñ €ü€¡Ñ…É•Ñ¥ÍÑ…¹”€´Í•µ•¹ÑMÑ…ÉÐ¤€¼Í•µ•¹Ñ1•¹Ñ €è€Àì(€ô•±Í”ì(€€€½¹ÍÐÍ…±•‘%¹‘•à€ôÍ…™•É…Ñ¥½¸€¨€¡Í¥µÕ±…Ñ¥½¸¹±…Ñ±¹Ì¹±•¹Ñ €´€Ä¤ì(€€€Í•µ•¹Ñ%¹‘•à€ô5…Ñ ¹µ¥¸¡Í¥µÕ±…Ñ¥½¸¹±…Ñ±¹Ì¹±•¹Ñ €´€È°5…Ñ ¹™±½½È¡Í…±•‘%¹‘•à¤¤ì(€€€Í•µ•¹ÑÉ…Ñ¥½¸€ôÍ…±•‘%¹‘•à€´Í•µ•¹Ñ%¹‘•àì(€ô((€½¹ÍÐ™É½´€ôÍ¥µÕ±…Ñ¥½¸¹±…Ñ±¹ÍmÍ•µ•¹Ñ%¹‘•átì(€½¹ÍÐÑ¼€ôÍ¥µÕ±…Ñ¥½¸¹±…Ñ±¹ÍmÍ•µ•¹Ñ%¹‘•à€¬€Åtì(€½¹ÍÐÕÉÉ•¹Ð€ôì(€€€±…Ðè™É½´¹±…Ð€¬€¡Ñ¼¹±…Ð€´™É½´¹±…Ð¤€¨Í•µ•¹ÑÉ…Ñ¥½¸°(€€€±¹œè™É½´¹±¹œ€¬€¡Ñ¼¹±¹œ€´™É½´¹±¹œ¤€¨Í•µ•¹ÑÉ…Ñ¥½¸(€ôì(€½¹ÍÐ½µÁ±•Ñ•‘A½¥¹ÑÌ€ôÍ¥µÕ±…Ñ¥½¸¹±…Ñ±¹Ì¹Í±¥” À°Í•µ•¹Ñ%¹‘•à€¬€Ä¤¹½¹…Ð¡ÕÉÉ•¹Ð¤ì(€½¹ÍÐÁ•¹‘¥¹A½¥¹ÑÌ€ômÕÉÉ•¹Ñt¹½¹…Ð¡Í¥µÕ±…Ñ¥½¸¹±…Ñ±¹Ì¹Í±¥”¡Í•µ•¹Ñ%¹‘•à€¬€Ä¤¤ì(€Í¥µÕ±…Ñ¥½¸¹½µÁ±•Ñ•‘1¥¹”¹Í•ÑA½¥¹ÑÌ¡½µÁ±•Ñ•‘A½¥¹ÑÌ¤ì(€Í¥µÕ±…Ñ¥½¸¹Á•¹‘¥¹1¥¹”¹Í•ÑA½¥¹ÑÌ¡Á•¹‘¥¹A½¥¹ÑÌ¤ì(€Í¥µÕ±…Ñ¥½¸¹µ…É­•È¹Í•ÑA½Í¥Ñ¥½¸¡ÕÉÉ•¹Ð¤ì((€½¹ÍÐÙ•¡¥±”€ôÍ¥µÕ±…Ñ¥½¸¹µ…É­•È¹•Ñ±•µ•¹Ð ¤ü¹ÅÕ•ÉåM•±•Ñ½È ˆ¹Ù•¡¥±”µµ…É­•Èˆ¤ì(€¥˜€¡Ù•¡¥±”¤Ù•¡¥±”¹ÍÑå±”¹Í•ÑAÉ½Á•ÉÑä ˆ´µÙ•¡¥±”µÉ½Ñ…Ñ¥½¸ˆ°€‘í‰•…É¥¹	•ÑÝ••¸¡™É½´°Ñ¼¥õ‘•€¤ì(€¥˜€¡™½±±½ÝY•¡¥±”¤µ…À¹Á…¹Q¼¡ÕÉÉ•¹Ð¤ì((€½¹ÍÐÍ¥µÕ±…Ñ•‘ÕÉ…Ñ¥½¸€ôÍ¥µÕ±…Ñ¥½¸¹½É¥¥¹…±ÕÉ…Ñ¥½¹5Ì€¨Í…™•É…Ñ¥½¸ì(€½¹ÍÐÉ½ÕÑ•¥ÍÑ…¹”€ôÍ¥µÕ±…Ñ¥½¸¹É½ÕÑ”¹‘¥ÍÑ…¹•5•Ñ•ÉÌñð€¡Í¥µÕ±…Ñ¥½¸¹É½ÕÑ”¹‘¥ÍÑ…¹•-´€¨€ÄÀÀÀ¤ñðÍ¥µÕ±…Ñ¥½¸¹•½µ•ÑÉå¥ÍÑ…¹”ì(€€ ˆÍ¥µÕ±…Ñ¥½¸µÁÉ½É•ÍÌˆ¤¹Ù…±Õ”€ôMÑÉ¥¹œ¡5…Ñ ¹É½Õ¹¡Í…™•É…Ñ¥½¸€¨€ÄÀÀÀ¤¤ì(€€ ˆÍ¥µÕ±…Ñ¥½¸µÑ¥µ”ˆ¤¹Ñ•áÑ½¹Ñ•¹Ð€ô€‘í™½Éµ…ÑÕÉ…Ñ¥½¸¡Í¥µÕ±…Ñ•‘ÕÉ…Ñ¥½¸¥ô€¼€‘í™½Éµ…ÑÕÉ…Ñ¥½¸¡Í¥µÕ±…Ñ¥½¸¹½É¥¥¹…±ÕÉ…Ñ¥½¹5Ì¥õ€ì(€€ ˆÍ¥µÕ±…Ñ¥½¸µ‘¥ÍÑ…¹”ˆ¤¹Ñ•áÑ½¹Ñ•¹Ð€ô€‘í™½Éµ…Ñ¥ÍÑ…¹”¡É½ÕÑ•¥ÍÑ…¹”€¨Í…™•É…Ñ¥½¸¥ô€¼€‘í™½Éµ…Ñ¥ÍÑ…¹”¡É½ÕÑ•¥ÍÑ…¹”¥õ€ì)ô()™Õ¹Ñ¥½¸‰•…É¥¹	•ÑÝ••¸¡™É½´°Ñ¼¤ì(€½¹ÍÐÍÑ…ÉÑ1…Ð€ô™É½´¹±…Ð€¨5…Ñ ¹A$€¼€ÄàÀì(€½¹ÍÐ•¹‘1…Ð€ôÑ¼¹±…Ð€¨5…Ñ ¹A$€¼€ÄàÀì(€½¹ÍÐ±½¹¥ÑÕ‘••±Ñ„€ô€¡Ñ¼¹±¹œ€´™É½´¹±¹œ¤€¨5…Ñ ¹A$€¼€ÄàÀì(€½¹ÍÐä€ô5…Ñ ¹Í¥¸¡±½¹¥ÑÕ‘••±Ñ„¤€¨5…Ñ ¹½Ì¡•¹‘1…Ð¤ì(€½¹ÍÐà€ô5…Ñ ¹½Ì¡ÍÑ…ÉÑ1…Ð¤€¨5…Ñ ¹Í¥¸¡•¹‘1…Ð¤€´5…Ñ ¹Í¥¸¡ÍÑ…ÉÑ1…Ð¤€¨5…Ñ ¹½Ì¡•¹‘1…Ð¤€¨5…Ñ ¹½Ì¡±½¹¥ÑÕ‘••±Ñ„¤ì(€É•ÑÕÉ¸€¡5…Ñ ¹…Ñ…¸È¡ä°à¤€¨€ÄàÀ€¼5…Ñ ¹A$€¬€ÌØÀ¤€”€ÌØÀì)ô()™Õ¹Ñ¥½¸Ñ½±•M¥µÕ±…Ñ¥½¸ ¤ì(€½¹ÍÐÍ¥µÕ±…Ñ¥½¸€ôÍÑ…Ñ”¹Í¥µÕ±…Ñ¥½¸ì(€¥˜€ …Í¥µÕ±…Ñ¥½¸¤É•ÑÕÉ¸ì(€¥˜€¡Í¥µÕ±…Ñ¥½¸¹Á±…å¥¹œ¤ì(€€€Í¥µÕ±…Ñ¥½¸¹Á±…å¥¹œ€ô™…±Í”ì(€€€Í¥µÕ±…Ñ¥½¸¹±…ÍÑÉ…µ•Q¥µ”€ô¹Õ±°ì(€€€…¹•±¹¥µ…Ñ¥½¹É…µ”¡Í¥µÕ±…Ñ¥½¸¹™É…µ•%¤ì(€€€€ ˆÍ¥µÕ±…Ñ¥½¸µÑ½±”ˆ¤¹Ñ•áÑ½¹Ñ•¹Ð€ô€‹ŠZØ½¹Ñ¥¹Õ…Èˆì(€€€É•ÑÕÉ¸ì(€ô(€¥˜€¡Í¥µÕ±…Ñ¥½¸¹•±…ÁÍ•‘¹¥µ…Ñ¥½¹5Ì€øôÍ¥µÕ±…Ñ¥½¸¹…¹¥µ…Ñ¥½¹ÕÉ…Ñ¥½¹5Ì¤ì(€€€Í¥µÕ±…Ñ¥½¸¹•±…ÁÍ•‘¹¥µ…Ñ¥½¹5Ì€ô€Àì(€€€É•¹‘•ÉM¥µÕ±…Ñ¥½¸ À°ÑÉÕ”¤ì(€ô(€Í¥µÕ±…Ñ¥½¸¹Á±…å¥¹œ€ôÑÉÕ”ì(€Í¥µÕ±…Ñ¥½¸¹±…ÍÑÉ…µ•Q¥µ”€ô¹Õ±°ì(€€ ˆÍ¥µÕ±…Ñ¥½¸µÑ½±”ˆ¤¹Ñ•áÑ½¹Ñ•¹Ð€ô€‹ŠvkŠvhA…ÕÍ…Èˆì(€Í¥µÕ±…Ñ¥½¸¹™É…µ•%€ôÉ•ÅÕ•ÍÑ¹¥µ…Ñ¥½¹É…µ”¡Í¥µÕ±…Ñ¥½¹É…µ”¤ì)ô()™Õ¹Ñ¥½¸É•ÍÑ…ÉÑM¥µÕ±…Ñ¥½¸ ¤ì(€½¹ÍÐÍ¥µÕ±…Ñ¥½¸€ôÍÑ…Ñ”¹Í¥µÕ±…Ñ¥½¸ì(€¥˜€ …Í¥µÕ±…Ñ¥½¸¤É•ÑÕÉ¸ì(€…¹•±¹¥µ…Ñ¥½¹É…µ”¡Í¥µÕ±…Ñ¥½¸¹™É…µ•%¤ì(€Í¥µÕ±…Ñ¥½¸¹•±…ÁÍ•‘¹¥µ…Ñ¥½¹5Ì€ô€Àì(€Í¥µÕ±…Ñ¥½¸¹±…ÍÑÉ…µ•Q¥µ”€ô¹Õ±°ì(€Í¥µÕ±…Ñ¥½¸¹Á±…å¥¹œ€ôÑÉÕ”ì(€É•¹‘•ÉM¥µÕ±…Ñ¥½¸ À°ÑÉÕ”¤ì(€€ ˆÍ¥µÕ±…Ñ¥½¸µÑ½±”ˆ¤¹Ñ•áÑ½¹Ñ•¹Ð€ô€‹ŠvkŠvhA…ÕÍ…Èˆì(€Í¥µÕ±…Ñ¥½¸¹™É…µ•%€ôÉ•ÅÕ•ÍÑ¹¥µ…Ñ¥½¹É…µ”¡Í¥µÕ±…Ñ¥½¹É…µ”¤ì)ô()™Õ¹Ñ¥½¸±½Í•M¥µÕ±…Ñ¥½¸ ¤ì(€½¹ÍÐÍ¥µÕ±…Ñ¥½¸€ôÍÑ…Ñ”¹Í¥µÕ±…Ñ¥½¸ì(€¥˜€¡Í¥µÕ±…Ñ¥½¸¤ì(€€€…¹•±¹¥µ…Ñ¥½¹É…µ”¡Í¥µÕ±…Ñ¥½¸¹™É…µ•%¤ì(€€€mÍ¥µÕ±…Ñ¥½¸¹Á•¹‘¥¹1¥¹”°Í¥µÕ±…Ñ¥½¸¹½µÁ±•Ñ•‘1¥¹”°Í¥µÕ±…Ñ¥½¸¹µ…É­•Ét¹™½É… ¡±…å•È€ôøì(€€€€€¥˜€¡±…å•È€˜˜µ…À¹½¹Ñ…¥¹Ì¡±…å•È¤¤µ…À¹É•µ½Ù”¡±…å•È¤ì(€€€ô¤ì(€ô(€ÍÑ…Ñ”¹Í¥µÕ±…Ñ¥½¸€ô¹Õ±°ì(€½¹ÍÐÁ…¹•°€ô€ ˆÍ¥µÕ±…Ñ¥½¸µÁ…¹•°ˆ¤ì(€¥˜€¡Á…¹•°¤Á…¹•°¹¡¥‘‘•¸€ôÑÉÕ”ì)ô()™Õ¹Ñ¥½¸Í¡½ÝI•½É‘•‘I½ÕÑ”¡¥¤ì(€½¹ÍÐÉ½ÕÑ”€ô•ÑI½ÕÑ•Ì ¤¹™¥¹¡¥Ñ•´€ôø¥Ñ•´¹¥€ôôô¥€˜˜¥Ñ•´¹ÑåÁ”€ôôô€‰É•½É‘•ˆ¤ì(€¥˜€ …É½ÕÑ”¤É•ÑÕÉ¸ì(€±½Í•M¥µÕ±…Ñ¥½¸ ¤ì(€Í•Ñ5½‘” ‰…ÁÑÕÉ”ˆ¤ì(€±•…É…ÁÑÕÉ•1…å•ÉÌ ¤ì(€ÍÑ…Ñ”¹ÑÉ…¬€ôÉ½ÕÑ”ì(€ÍÑ…Ñ”¹ÑÉ…­1¥¹”¹Í•ÑA½¥¹ÑÌ¡É½ÕÑ”¹Á½¥¹ÑÌ¤ì(€¥˜€¡ÍÑ…Ñ”¹ÑÉ…­1¥¹”¹•ÑA½¥¹ÑÌ ¤¹±•¹Ñ ¤µ…À¹™¥Ð¡ÍÑ…Ñ”¹ÑÉ…­1¥¹”¹•ÑA½¥¹ÑÌ ¤°€ÌÔ¤ì(€€ ˆ±¥Ù”µ‘¥ÍÑ…¹”ˆ¤¹Ñ•áÑ½¹Ñ•¹Ð€ô™½Éµ…Ñ¥ÍÑ…¹”¡É½ÕÑ”¹‘¥ÍÑ…¹•5•Ñ•ÉÌ¤ì(€€ ˆ±¥Ù”µ‘ÕÉ…Ñ¥½¸ˆ¤¹Ñ•áÑ½¹Ñ•¹Ð€ô™½Éµ…ÑÕÉ…Ñ¥½¸¡•Ñ±…ÁÍ•‘5¥±±¥Í•½¹‘Ì¡É½ÕÑ”¤¤ì(€€ ˆ±¥Ù”µÁ½¥¹ÑÌˆ¤¹Ñ•áÑ½¹Ñ•¹Ð€ôÉ½ÕÑ”¹Á½¥¹ÑÌ¹±•¹Ñ ì(€Í•ÑÁÍMÑ…ÑÕÌ ‰I•½ÉÉ¥‘¼Õ…É‘…‘¼ˆ°É½ÕÑ”¹¹…µ”°€‰½½ˆ¤ì(€ÍÑ…ÉÑ…ÁÑÕÉ•	ÕÑÑ½¸¹‘¥Í…‰±•€ô™…±Í”ì(€ÍÑ…ÉÑ…ÁÑÕÉ•	ÕÑÑ½¸¹ÅÕ•ÉåM•±•Ñ½È ‰ÍÁ…¸é±…ÍÐµ¡¥±ˆ¤¹Ñ•áÑ½¹Ñ•¹Ð€ô€‰%¹¥¥…È½ÑÉ¼É•½ÉÉ¥‘¼ˆì)ô()™Õ¹Ñ¥½¸Í¡½ÝA±…¹¹•‘I½ÕÑ”¡¥¤ì(€½¹ÍÐÉ½ÕÑ”€ô•ÑI½ÕÑ•Ì ¤¹™¥¹¡¥Ñ•´€ôø¥Ñ•´¹¥€ôôô¥€˜˜¥Ñ•´¹ÑåÁ”€ôôô€‰Á±…¹¹•ˆ¤ì(€½¹ÍÐÁ½¥¹ÑÌ€ôÝ¥¹‘½Ü¹I½ÕÑ•áÁ½ÉÐ¹É½ÕÑ•A½¥¹ÑÌ¡É½ÕÑ”¤ì(€¥˜€ …É½ÕÑ”ñðÁ½¥¹ÑÌ¹±•¹Ñ €ð€È¤ì(€€€Í¡½Ý5…Á	…¹¹•È ‰ÍÑ„ÉÕÑ„Á±…¹¥™¥…‘„•Ì…¹Ñ¥Õ„ä¹¼Ñ¥•¹”½½É‘•¹…‘…ÌÕ…É‘…‘…Ì¸…±é±…±„¹Õ•Ù…µ•¹Ñ”¸ˆ°€‰Ý…É¹¥¹œˆ°€ÜÀÀÀ¤ì(€€€É•ÑÕÉ¸ì(€ô(€±½Í•M¥µÕ±…Ñ¥½¸ ¤ì(€Í•Ñ5½‘” ‰Á±…¸ˆ¤ì(€É•Í•ÑA±…¹¹•‘A½¥¹ÑÌ ¤ì(€ÍÑ…Ñ”¹ÍÑ…ÉÐ€ôì€¸¸¹Á½¥¹ÑÍlÁt°±…‰•°èÉ½ÕÑ”¹ÍÑ…ÉÐôì(€ÍÑ…Ñ”¹•¹€ôì€¸¸¹Á½¥¹ÑÌ¹…Ð ´Ä¤°±…‰•°èÉ½ÕÑ”¹•¹ôì(€Í•ÑA½¥¹Ð ‰ÍÑ…ÉÐˆ°ÍÑ…Ñ”¹ÍÑ…ÉÐ°É½ÕÑ”¹ÍÑ…ÉÐ¤ì(€Í•ÑA½¥¹Ð ‰•¹ˆ°ÍÑ…Ñ”¹•¹°É½ÕÑ”¹•¹¤ì(€ÍÑ…Ñ”¹Á±…¹¹•‘1¥¹”€ôµ…À¹É•…Ñ•A½±å±¥¹”¡Á½¥¹ÑÌ°ì½±½Èè€ˆŒÄÄÄÄÄÄˆ°Ý•¥¡Ðè€Ø°½Á…¥Ñäè€À¸äô¤ì(€µ…À¹™¥Ð¡Á½¥¹ÑÌ°€ÌÔ¤ì(€‘…Ñ•%¹ÁÕÐ¹Ù…±Õ”€ôÉ½ÕÑ”¹‘…Ñ”ì(€Ñ¥µ•%¹ÁÕÐ¹Ù…±Õ”€ôÉ½ÕÑ”¹Ñ¥µ”ì(€€ ˆ‘¥ÍÑ…¹”ˆ¤¹Ñ•áÑ½¹Ñ•¹Ð€ô€‘íÉ½ÕÑ”¹‘¥ÍÑ…¹•-´¹Ñ½¥á• Ä¥ô­µ€ì(€€ ˆ‘ÕÉ…Ñ¥½¸ˆ¤¹Ñ•áÑ½¹Ñ•¹Ð€ô€‘íÉ½ÕÑ”¹‘ÕÉ…Ñ¥½¹5¥¹ôµ¥¹€ì(€Í•Ñ5•ÍÍ…” ‰IÕÑ„Á±…¹¥™¥…‘„…É…‘„‘•Í‘”•°¡¥ÍÑ½É¥…°¸ˆ¤ì)ô()™Õ¹Ñ¥½¸‘•±•Ñ•I½ÕÑ”¡¥¤ì(€¥˜€¡ÍÑ…Ñ”¹Í¥µÕ±…Ñ¥½¸ü¹É½ÕÑ”¹¥€ôôô¥¤±½Í•M¥µÕ±…Ñ¥½¸ ¤ì(€±½…±MÑ½É…”¹Í•Ñ%Ñ•´¡MQ=I}-d°)M=8¹ÍÑÉ¥¹¥™ä¡•ÑI½ÕÑ•Ì ¤¹™¥±Ñ•È¡É½ÕÑ”€ôøÉ½ÕÑ”¹¥€„ôô¥¤¤¤ì(€É•¹‘•É!¥ÍÑ½Éä ¤ì)ô()™Õ¹Ñ¥½¸•áÁ½ÉÑI½ÕÑ”¡¥°™½Éµ…Ð¤ì(€½¹ÍÐÉ½ÕÑ”€ô•ÑI½ÕÑ•Ì ¤¹™¥¹¡¥Ñ•´€ôø¥Ñ•´¹¥€ôôô¥¤ì(€¥˜€ …É½ÕÑ”¤É•ÑÕÉ¸ì(€ÑÉäì(€€€Ý¥¹‘½Ü¹I½ÕÑ•áÁ½ÉÐ¹‘½Ý¹±½…¡É½ÕÑ”°™½Éµ…Ð¤ì(€€€Í¡½Ý5…Á	…¹¹•È¡•Í…É„€‘í™½Éµ…Ð¹Ñ½UÁÁ•É…Í” ¥ôÁÉ•Á…É…‘„½ÉÉ•Ñ…µ•¹Ñ”¹€°€‰¥¹™¼ˆ°€ÌÔÀÀ¤ì(€ô…Ñ €¡•ÉÉ½È¤ì(€€€Í¡½Ý5…Á	…¹¹•È¡•ÉÉ½È¹µ•ÍÍ…”°€‰Ý…É¹¥¹œˆ°€ÜÀÀÀ¤ì(€ô)ô()™Õ¹Ñ¥½¸•áÁ½ÉÑ5•¹Ô¡É½ÕÑ”¤ì(€É•ÑÕÉ¸€ñ‘•Ñ…¥±Ì±…ÍÌô‰•áÁ½ÉÐµµ•¹Ôˆø(€€€€ñÍÕµµ…Éäù•Í…É…ÈƒŠZøð½ÍÕµµ…Éäø(€€€€ñ‘¥Ø±…ÍÌô‰•áÁ½ÉÐµ½ÁÑ¥½¹Ìˆ…É¥„µ±…‰•°ô‰½Éµ…Ñ½Ì‘”‘•Í…É„ˆø(€€€€€€ñ‰ÕÑÑ½¸ÑåÁ”ô‰‰ÕÑÑ½¸ˆ‘…Ñ„µ•áÁ½ÉÐôˆ‘íÉ½ÕÑ”¹¥‘ôˆ‘…Ñ„µ™½Éµ…Ðô‰ÍØˆùMXð½‰ÕÑÑ½¸ø(€€€€€€ñ‰ÕÑÑ½¸ÑåÁ”ô‰‰ÕÑÑ½¸ˆ‘…Ñ„µ•áÁ½ÉÐôˆ‘íÉ½ÕÑ”¹¥‘ôˆ‘…Ñ„µ™½Éµ…Ðô‰­µ°ˆù-50ð½‰ÕÑÑ½¸ø(€€€€€€ñ‰ÕÑÑ½¸ÑåÁ”ô‰‰ÕÑÑ½¸ˆ‘…Ñ„µ•áÁ½ÉÐôˆ‘íÉ½ÕÑ”¹¥‘ôˆ‘…Ñ„µ™½Éµ…Ðô‰Í¡ÀˆùM!@ð½‰ÕÑÑ½¸ø(€€€€ð½‘¥Øø(€€ð½‘•Ñ…¥±Ìù€ì)ô()™Õ¹Ñ¥½¸É•¹‘•É!¥ÍÑ½Éä ¤ì(€½¹ÍÐÉ½ÕÑ•Ì€ô•ÑI½ÕÑ•Ì ¤ì(€€ ˆ¡¥ÍÑ½Éäˆ¤¹¥¹¹•É!Q50€ôÉ½ÕÑ•Ì¹±•¹Ñ €üÉ½ÕÑ•Ì¹µ…À¡É½ÕÑ”€ôøì(€€€¥˜€¡É½ÕÑ”¹ÑåÁ”€ôôô€‰É•½É‘•ˆ¤ì(€€€€€É•ÑÕÉ¸€ñ…ÉÑ¥±”±…ÍÌô‰¡¥ÍÑ½Éäµ…ÉÉ•½É‘•ˆø(€€€€€€€€ñ‘¥Ø±…ÍÌô‰¡¥ÍÑ½Éäµ¡•…‘¥¹œˆøñÍÁ…¸±…ÍÌô‰­¥¹ˆùALð½ÍÁ…¸øñÍÑÉ½¹œø‘í•Í…Á•!Ñµ°¡É½ÕÑ”¹¹…µ”¥ôð½ÍÑÉ½¹œøð½‘¥Øø(€€€€€€€€ñÀ±…ÍÌô‰Ý¡•¸ˆø‘í™½Éµ…Ñ…Ñ•Q¥µ”¡É½ÕÑ”¹ÍÑ…ÉÑ•‘Ð¥ôð½Àø(€€€€€€€€ñÀø‘í™½Éµ…Ñ¥ÍÑ…¹”¡É½ÕÑ”¹‘¥ÍÑ…¹•5•Ñ•ÉÌ¥ôƒ
Ü€‘í™½Éµ…ÑÕÉ…Ñ¥½¸¡•Ñ±…ÁÍ•‘5¥±±¥Í•½¹‘Ì¡É½ÕÑ”¤¥ôƒ
Ü€‘íÉ½ÕÑ”¹Á½¥¹ÑÌ¹±•¹Ñ¡ôÁÕ¹Ñ½Ìð½Àø(€€€€€€€€ñ‘¥Ø±…ÍÌô‰…Éµ…Ñ¥½¹Ìˆøñ‰ÕÑÑ½¸‘…Ñ„µÍ¥µÕ±…Ñ”ôˆ‘íÉ½ÕÑ”¹¥‘ôˆûŠZØM¥µÕ±…Èð½‰ÕÑÑ½¸øñ‰ÕÑÑ½¸‘…Ñ„µÙ¥•ÜµÉ•½É‘•ôˆ‘íÉ½ÕÑ”¹¥‘ôˆùY•È•¸µ…Á„ð½‰ÕÑÑ½¸ø‘í•áÁ½ÉÑ5•¹Ô¡É½ÕÑ”¥ôñ‰ÕÑÑ½¸±…ÍÌô‰‘•±•Ñ”µÉ½ÕÑ”ˆ‘…Ñ„µ‘•±•Ñ”ôˆ‘íÉ½ÕÑ”¹¥‘ôˆù±¥µ¥¹…Èð½‰ÕÑÑ½¸øð½‘¥Øø(€€€€€€ð½…ÉÑ¥±”ù€ì(€€€ô(€€€É•ÑÕÉ¸€ñ…ÉÑ¥±”±…ÍÌô‰¡¥ÍÑ½Éäµ…ÉÁ±…¹¹•ˆø(€€€€€€ñ‘¥Ø±…ÍÌô‰¡¥ÍÑ½Éäµ¡•…‘¥¹œˆøñÍÁ…¸±…ÍÌô‰­¥¹ˆùA18ð½ÍÁ…¸øñÍÑÉ½¹œùIÕÑ„ÁÉ½É…µ…‘„ð½ÍÑÉ½¹œøð½‘¥Øø(€€€€€€ñÀ±…ÍÌô‰Ý¡•¸ˆø‘í¹•Ü…Ñ”¡€‘íÉ½ÕÑ”¹‘…Ñ•õP‘íÉ½ÕÑ”¹Ñ¥µ•õ€¤¹Ñ½1½…±•MÑÉ¥¹œ ‰•Ìµ<ˆ°ì‘…Ñ•MÑå±”è€‰µ•‘¥Õ´ˆ°Ñ¥µ•MÑå±”è€‰Í¡½ÉÐˆô¥ôð½Àø(€€€€€€ñÀøñÍÑÉ½¹œù•Í‘”èð½ÍÑÉ½¹œø€‘í•Í…Á•!Ñµ°¡É½ÕÑ”¹ÍÑ…ÉÐ¥ôð½Àø(€€€€€€ñÀøñÍÑÉ½¹œù!…ÍÑ„èð½ÍÑÉ½¹œø€‘í•Í…Á•!Ñµ°¡É½ÕÑ”¹•¹¥ôð½Àø(€€€€€€ñÀø‘íÉ½ÕÑ”¹‘¥ÍÑ…¹•-´¹Ñ½¥á• Ä¥ô­´ƒ
Ü€‘íÉ½ÕÑ”¹‘ÕÉ…Ñ¥½¹5¥¹ôµ¥¸…ÁÉ½à¸ð½Àø(€€€€€€€€ñ‘¥Ø±…ÍÌô‰…Éµ…Ñ¥½¹Ìˆøñ‰ÕÑÑ½¸‘…Ñ„µÍ¥µÕ±…Ñ”ôˆ‘íÉ½ÕÑ”¹¥‘ôˆûŠZØM¥µÕ±…Èð½‰ÕÑÑ½¸øñ‰ÕÑÑ½¸‘…Ñ„µÙ¥•ÜµÁ±…¹¹•ôˆ‘íÉ½ÕÑ”¹¥‘ôˆùY•È•¸µ…Á„ð½‰ÕÑÑ½¸ø‘í•áÁ½ÉÑ5•¹Ô¡É½ÕÑ”¥ôñ‰ÕÑÑ½¸±…ÍÌô‰‘•±•Ñ”µÉ½ÕÑ”ˆ‘…Ñ„µ‘•±•Ñ”ôˆ‘íÉ½ÕÑ”¹¥‘ôˆù±¥µ¥¹…Èð½‰ÕÑÑ½¸øð½‘¥Øø(€€€€ð½…ÉÑ¥±”ù€ì(€ô¤¹©½¥¸ ˆˆ¤€è€œñÀ±…ÍÌô‰•µÁÑäˆùQ½‘…Ûµ„¹¼¡…äÉ•½ÉÉ¥‘½ÌÕ…É‘…‘½Ì¸ð½Àøœì((€‘½Õµ•¹Ð¹ÅÕ•ÉåM•±•Ñ½É±° ‰m‘…Ñ„µÍ¥µÕ±…Ñ•tˆ¤¹™½É… ¡‰ÕÑÑ½¸€ôø‰ÕÑÑ½¸¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°€ ¤€ôøÍÑ…ÉÑI½ÕÑ•M¥µÕ±…Ñ¥½¸¡9Õµ‰•È¡‰ÕÑÑ½¸¹‘…Ñ…Í•Ð¹Í¥µÕ±…Ñ”¤¤¤¤ì(€‘½Õµ•¹Ð¹ÅÕ•ÉåM•±•Ñ½É±° ‰m‘…Ñ„µÙ¥•ÜµÉ•½É‘•‘tˆ¤¹™½É… ¡‰ÕÑÑ½¸€ôø‰ÕÑÑ½¸¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°€ ¤€ôøÍ¡½ÝI•½É‘•‘I½ÕÑ”¡9Õµ‰•È¡‰ÕÑÑ½¸¹‘…Ñ…Í•Ð¹Ù¥•ÝI•½É‘•¤¤¤¤ì(€‘½Õµ•¹Ð¹ÅÕ•ÉåM•±•Ñ½É±° ‰m‘…Ñ„µÙ¥•ÜµÁ±…¹¹•‘tˆ¤¹™½É… ¡‰ÕÑÑ½¸€ôø‰ÕÑÑ½¸¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°€ ¤€ôøÍ¡½ÝA±…¹¹•‘I½ÕÑ”¡9Õµ‰•È¡‰ÕÑÑ½¸¹‘…Ñ…Í•Ð¹Ù¥•ÝA±…¹¹•¤¤¤¤ì(€‘½Õµ•¹Ð¹ÅÕ•ÉåM•±•Ñ½É±° ‰m‘…Ñ„µ•áÁ½ÉÑtˆ¤¹™½É… ¡‰ÕÑÑ½¸€ôø‰ÕÑÑ½¸¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°€ ¤€ôø•áÁ½ÉÑI½ÕÑ”¡9Õµ‰•È¡‰ÕÑÑ½¸¹‘…Ñ…Í•Ð¹•áÁ½ÉÐ¤°‰ÕÑÑ½¸¹‘…Ñ…Í•Ð¹™½Éµ…Ð¤¤¤ì(€‘½Õµ•¹Ð¹ÅÕ•ÉåM•±•Ñ½É±° ‰m‘…Ñ„µ‘•±•Ñ•tˆ¤¹™½É… ¡‰ÕÑÑ½¸€ôø‰ÕÑÑ½¸¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°€ ¤€ôø‘•±•Ñ•I½ÕÑ”¡9Õµ‰•È¡‰ÕÑÑ½¸¹‘…Ñ…Í•Ð¹‘•±•Ñ”¤¤¤¤ì)ô()™Õ¹Ñ¥½¸‘¥ÍÑ…¹•	•ÑÝ••¸¡™É½´°Ñ¼¤ì(€½¹ÍÐ•…ÉÑ¡I…‘¥ÕÌ€ô€ØÌÜÄÀÀà¸àì(€½¹ÍÐ±…Ñ¥ÑÕ‘”Ä€ô™É½´¹±…Ð€¨5…Ñ ¹A$€¼€ÄàÀì(€½¹ÍÐ±…Ñ¥ÑÕ‘”È€ôÑ¼¹±…Ð€¨5…Ñ ¹A$€¼€ÄàÀì(€½¹ÍÐ±…Ñ¥ÑÕ‘••±Ñ„€ô€¡Ñ¼¹±…Ð€´™É½´¹±…Ð¤€¨5…Ñ ¹A$€¼€ÄàÀì(€½¹ÍÐ±½¹¥ÑÕ‘••±Ñ„€ô€¡Ñ¼¹±¹œ€´™É½´¹±¹œ¤€¨5…Ñ ¹A$€¼€ÄàÀì(€½¹ÍÐÙ…±Õ”€ô5…Ñ ¹Í¥¸¡±…Ñ¥ÑÕ‘••±Ñ„€¼€È¤€¨¨€È€¬5…Ñ ¹½Ì¡±…Ñ¥ÑÕ‘”Ä¤€¨5…Ñ ¹½Ì¡±…Ñ¥ÑÕ‘”È¤€¨5…Ñ ¹Í¥¸¡±½¹¥ÑÕ‘••±Ñ„€¼€È¤€¨¨€Èì(€É•ÑÕÉ¸•…ÉÑ¡I…‘¥ÕÌ€¨€È€¨5…Ñ ¹…Ñ…¸È¡5…Ñ ¹ÍÅÉÐ¡Ù…±Õ”¤°5…Ñ ¹ÍÅÉÐ Ä€´Ù…±Õ”¤¤ì)ô()™Õ¹Ñ¥½¸™½Éµ…Ñ¥ÍÑ…¹”¡µ•Ñ•ÉÌ¤ìÉ•ÑÕÉ¸µ•Ñ•ÉÌ€øô€ÄÀÀÀ€ü€‘ì¡µ•Ñ•ÉÌ€¼€ÄÀÀÀ¤¹Ñ½¥á• È¥ô­µ€€è€‘í5…Ñ ¹É½Õ¹¡µ•Ñ•ÉÌ¥ôµ€ìô)™Õ¹Ñ¥½¸™½Éµ…ÑÕÉ…Ñ¥½¸¡µ¥±±¥Í•½¹‘Ì¤ì(€½¹ÍÐÑ½Ñ…±M•½¹‘Ì€ô5…Ñ ¹™±½½È¡µ¥±±¥Í•½¹‘Ì€¼€ÄÀÀÀ¤ì(€½¹ÍÐ¡½ÕÉÌ€ô5…Ñ ¹™±½½È¡Ñ½Ñ…±M•½¹‘Ì€¼€ÌØÀÀ¤ì(€½¹ÍÐµ¥¹ÕÑ•Ì€ô5…Ñ ¹™±½½È ¡Ñ½Ñ…±M•½¹‘Ì€”€ÌØÀÀ¤€¼€ØÀ¤ì(€½¹ÍÐÍ•½¹‘Ì€ôÑ½Ñ…±M•½¹‘Ì€”€ØÀì(€É•ÑÕÉ¸¡½ÕÉÌ€ü€‘í¡½ÕÉÍôè‘íMÑÉ¥¹œ¡µ¥¹ÕÑ•Ì¤¹Á…‘MÑ…ÉÐ È°€ˆÀˆ¥ôè‘íMÑÉ¥¹œ¡Í•½¹‘Ì¤¹Á…‘MÑ…ÉÐ È°€ˆÀˆ¥õ€€è€‘íMÑÉ¥¹œ¡µ¥¹ÕÑ•Ì¤¹Á…‘MÑ…ÉÐ È°€ˆÀˆ¥ôè‘íMÑÉ¥¹œ¡Í•½¹‘Ì¤¹Á…‘MÑ…ÉÐ È°€ˆÀˆ¥õ€ì)ô)™Õ¹Ñ¥½¸™½Éµ…Ñ…Ñ•Q¥µ”¡Ù…±Õ”¤ìÉ•ÑÕÉ¸¹•Ü…Ñ”¡Ù…±Õ”¤¹Ñ½1½…±•MÑÉ¥¹œ ‰•Ìµ<ˆ°ì‘…Ñ•MÑå±”è€‰µ•‘¥Õ´ˆ°Ñ¥µ•MÑå±”è€‰Í¡½ÉÐˆô¤ìô)™Õ¹Ñ¥½¸•Í…Á•!Ñµ°¡Ù…±Õ”€ô€ˆˆ¤ìÉ•ÑÕÉ¸Ù…±Õ”¹É•Á±…” ½l˜ðøœ‰t½œ°¡…É…Ñ•È€ôø€¡ì€ˆ˜ˆè€ˆ™…µÀìˆ°€ˆðˆè€ˆ™±Ðìˆ°€ˆøˆè€ˆ™Ðìˆ°€ˆœˆè€ˆ˜ŒÌäìˆ°€œˆœè€ˆ™ÅÕ½Ðìˆô¥m¡…É…Ñ•Ét¤ìô(( ˆÉ•Í•Ðˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°É•Í•ÑA±…¹¹•‘A½¥¹ÑÌ¤ì( ˆ±•…Èµ¡¥ÍÑ½Éäˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°€ ¤€ôøì(€¥˜€ …•ÑI½ÕÑ•Ì ¤¹±•¹Ñ ñð½¹™¥É´ ‹
ý	½ÉÉ…ÈÑ½‘½Ì±½ÌÉ•½ÉÉ¥‘½ÌÕ…É‘…‘½Ì•¸•ÍÑ”‘¥ÍÁ½Í¥Ñ¥Ù¼üˆ¤¤ì(€€€±½…±MÑ½É…”¹É•µ½Ù•%Ñ•´¡MQ=I}-d¤ì(€€€É•¹‘•É!¥ÍÑ½Éä ¤ì(€ô)ô¤ì(( ˆÍ¥µÕ±…Ñ¥½¸µÑ½±”ˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°Ñ½±•M¥µÕ±…Ñ¥½¸¤ì( ˆÍ¥µÕ±…Ñ¥½¸µÉ•ÍÑ…ÉÐˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°É•ÍÑ…ÉÑM¥µÕ±…Ñ¥½¸¤ì( ˆÍ¥µÕ±…Ñ¥½¸µ±½Í”ˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°±½Í•M¥µÕ±…Ñ¥½¸¤ì( ˆÍ¥µÕ±…Ñ¥½¸µÍÁ••ˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰¡…¹”ˆ°•Ù•¹Ð€ôøì(€¥˜€¡ÍÑ…Ñ”¹Í¥µÕ±…Ñ¥½¸¤ÍÑ…Ñ”¹Í¥µÕ±…Ñ¥½¸¹ÍÁ••€ô9Õµ‰•È¡•Ù•¹Ð¹Ñ…É•Ð¹Ù…±Õ”¤ñð€Äì)ô¤ì( ˆÍ¥µÕ±…Ñ¥½¸µÁÉ½É•ÍÌˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰¥¹ÁÕÐˆ°•Ù•¹Ð€ôøì(€½¹ÍÐÍ¥µÕ±…Ñ¥½¸€ôÍÑ…Ñ”¹Í¥µÕ±…Ñ¥½¸ì(€¥˜€ …Í¥µÕ±…Ñ¥½¸¤É•ÑÕÉ¸ì(€Í¥µÕ±…Ñ¥½¸¹Á±…å¥¹œ€ô™…±Í”ì(€Í¥µÕ±…Ñ¥½¸¹±…ÍÑÉ…µ•Q¥µ”€ô¹Õ±°ì(€…¹•±¹¥µ…Ñ¥½¹É…µ”¡Í¥µÕ±…Ñ¥½¸¹™É…µ•%¤ì(€½¹ÍÐ™É…Ñ¥½¸€ô9Õµ‰•È¡•Ù•¹Ð¹Ñ…É•Ð¹Ù…±Õ”¤€¼€ÄÀÀÀì(€Í¥µÕ±…Ñ¥½¸¹•±…ÁÍ•‘¹¥µ…Ñ¥½¹5Ì€ôÍ¥µÕ±…Ñ¥½¸¹…¹¥µ…Ñ¥½¹ÕÉ…Ñ¥½¹5Ì€¨™É…Ñ¥½¸ì(€É•¹‘•ÉM¥µÕ±…Ñ¥½¸¡™É…Ñ¥½¸°ÑÉÕ”¤ì(€€ ˆÍ¥µÕ±…Ñ¥½¸µÑ½±”ˆ¤¹Ñ•áÑ½¹Ñ•¹Ð€ô™É…Ñ¥½¸€øô€Ä€ü€‹ŠZØI•Á•Ñ¥Èˆ€è€‹ŠZØ½¹Ñ¥¹Õ…Èˆì)ô¤ì()¥˜€ ‰Í•ÉÙ¥•]½É­•Èˆ¥¸¹…Ù¥…Ñ½È¤Ý¥¹‘½Ü¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±½…ˆ°€ ¤€ôø¹…Ù¥…Ñ½È¹Í•ÉÙ¥•]½É­•È¹É•¥ÍÑ•È ‰ÍÜ¹©Ìˆ¤¹…Ñ   ¤€ôøíô¤¤ì)É•ÍÑ½É•Ñ¥Ù•QÉ…¬ ¤ì)É•¹‘•É!¥ÍÑ½Éä ¤ì)ô()¥¹¥ÑÁÀ ¤¹…Ñ ¡•ÉÉ½È€ôøì(€½¹Í½±”¹•ÉÉ½È¡•ÉÉ½È¤ì(€½¹ÍÐ‰…¹¹•È€ô‘½Õµ•¹Ð¹ÅÕ•ÉåM•±•Ñ½È ˆµ…Àµ‰…¹¹•Èˆ¤ì(€¥˜€¡‰…¹¹•È¤ì(€€€‰…¹¹•È¹Ñ•áÑ½¹Ñ•¹Ð€ô€‰9¼™Õ”Á½Í¥‰±”¥¹¥¥…È•°µ…Á„¸I•…É„±„…Á±¥…§Í¸¼É•Ù¥Í„±„½¹•á§Í¸¸ˆì(€€€‰…¹¹•È¹±…ÍÍ9…µ”€ô€‰µ…Àµ‰…¹¹•È•ÉÉ½Èˆì(€€€‰…¹¹•È¹¡¥‘‘•¸€ô™…±Í”ì(€ô)ô¤ì(