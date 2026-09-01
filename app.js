const DEFAULT_CENTER = [4.711, -74.0721];
const STORAGE_KEY = "ruteo-routes-v2";
const ACTIVE_TRACK_KEY = "ruteo-active-track-v2";
const MIN_POINT_DISTANCE_METERS = 5;
const MAX_ACCEPTED_ACCURACY_METERS = 60;
const GOOGLE_MAPS_KEY = "ruteo-google-maps-key-v1";
const SPEED_COLORS = { low: "#E62020", medium: "#FFD700", high: "#00FF00" };
const SPEED_GRADIENT_MAX_LAYERS = 1200;
const GPS_SIGNAL_LOSS_TIMEOUT_MS = 18000;
const GPS_WATCHDOG_INTERVAL_MS = 3000;

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
  pointSelectionType: null,
  startMarker: null,
  endMarker: null,
  plannedLine: null,
  plannedDensityPath: [],
  watchId: null,
  gpsWatchdogId: null,
  wakeLock: null,
  track: null,
  trackLine: map.createPolyline([], { color: "#e30613", weight: 7, opacity: 0.95 }),
  currentMarker: null,
  accuracyCircle: null,
  captureStartMarker: null,
  captureEndMarker: null,
  capturePointMarkers: [],
  timerId: null,
  followLocation: true,
  simulation: null,
  routeSegments: [],
  speedProfile: null,
  speedGradientLayers: [],
  importedLayers: [],
  importedRouteVisible: true,
  densityLayers: [],
  densityResult: null,
  densityVisible: true,
  densitySource: null,
  densityStops: []
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
const markCapturePointButton = $("#mark-capture-point");
const finishCaptureButton = $("#finish-capture");
const routeImportFile = $("#route-import-file");
const routeImportCrs = $("#route-import-crs");
const routeImportStatus = $("#route-import-status");
const routeImportMapping = $("#route-import-mapping");
const routeImportReport = $("#route-import-report");
const applyImportedRouteButton = $("#apply-imported-route");
const simulateImportedRouteButton = $("#simulate-imported-route");
let waypointSequence = 0;
let importedTable = null;
let importedTableFormat = "";
let importedGeoJSON = null;

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
    hideSpeedPanel();
    clearSpeedGradient();
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
  const metricsStack = $("#map-metrics-stack");
  const layersPanel = $("#layers-panel");
  metricsStack.hidden = $("#route-segments-panel").hidden && $("#speed-panel").hidden;
  metricsStack.classList.toggle("expanded", $("#route-segments-panel").classList.contains("expanded") || $("#speed-panel").classList.contains("expanded"));
  dock.classList.toggle("has-layer-panel", !layersPanel.hidden);
  dock.classList.toggle("layers-expanded", !layersPanel.hidden && layersPanel.classList.contains("expanded"));
  dock.classList.toggle("has-visible-dashboard", !metricsStack.hidden || !$("#simulation-show").hidden || !$("#simulation-panel").hidden || !layersPanel.hidden);
}

function setLayersPanelExpanded(expanded) {
  const panel = $("#layers-panel");
  if (panel.hidden) return;
  panel.classList.toggle("expanded", expanded);
  $("#layers-panel-body").hidden = !expanded;
  $("#layers-panel-toggle").setAttribute("aria-expanded", String(expanded));
  if (expanded) {
    $("#route-segments-panel").classList.remove("expanded");
    $("#route-segments-body").hidden = true;
    $("#route-segments-toggle").setAttribute("aria-expanded", "false");
    $("#speed-panel").classList.remove("expanded");
    $("#speed-panel-body").hidden = true;
    $("#speed-panel-toggle").setAttribute("aria-expanded", "false");
    if (state.simulation) setSimulationPanelVisible(false);
  }
  syncDashboardDock();
}

function updateLayersPanelState() {
  const panel = $("#layers-panel");
  const importedAvailable = Boolean(importedGeoJSON?.features?.length);
  const densityAvailable = Boolean(state.densityResult?.capa_raster?.features?.length);
  const availableCount = Number(importedAvailable) + Number(densityAvailable);
  const visibleCount = Number(importedAvailable && state.importedRouteVisible) + Number(densityAvailable && state.densityVisible);
  panel.hidden = availableCount === 0;
  $("#layers-panel-summary").textContent = availableCount
    ? `${visibleCount}/${availableCount} ${visibleCount === 1 ? "visible" : "visibles"}`
    : "0 visibles";
  if (!availableCount) {
    panel.classList.remove("expanded");
    $("#layers-panel-body").hidden = true;
    $("#layers-panel-toggle").setAttribute("aria-expanded", "false");
  }
  syncDashboardDock();
}

function setRouteSegmentsExpanded(expanded) {
  const panel = $("#route-segments-panel");
  const body = $("#route-segments-body");
  const toggle = $("#route-segments-toggle");
  panel.classList.toggle("expanded", expanded);
  body.hidden = !expanded;
  toggle.setAttribute("aria-expanded", String(expanded));
  if (expanded) {
    $("#speed-panel").classList.remove("expanded");
    $("#speed-panel-body").hidden = true;
    $("#speed-panel-toggle").setAttribute("aria-expanded", "false");
  }
  if (expanded && state.simulation) setSimulationPanelVisible(false);
  syncDashboardDock();
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

function speedZoneFor(speedKmh) {
  if (speedKmh > 35) return "high";
  if (speedKmh > 15) return "medium";
  return "low";
}

function speedProfileForRoute(route) {
  if (!route) return null;
  let segments = [];
  if (route.type === "recorded") {
    const points = window.RouteExport.routePoints(route);
    for (let index = 1; index < points.length; index += 1) {
      const from = points[index - 1];
      const to = points[index];
      const distanceMeters = distanceBetween(from, to);
      const elapsedSeconds = (new Date(to.timestamp).getTime() - new Date(from.timestamp).getTime()) / 1000;
      const gpsSpeedMs = Number(to.speed);
      const hasGpsSpeed = to.speed !== null && to.speed !== undefined && Number.isFinite(gpsSpeedMs) && gpsSpeedMs >= 0;
      const durationSeconds = Number.isFinite(elapsedSeconds) && elapsedSeconds > 0
        ? elapsedSeconds
        : hasGpsSpeed && gpsSpeedMs > 0 ? distanceMeters / gpsSpeedMs : 0;
      segments.push({ distanceMeters, durationSeconds, speedKmh: hasGpsSpeed ? gpsSpeedMs * 3.6 : null });
    }

    let pausedSeconds = Math.max(0, Number(route.pausedMilliseconds || 0) / 1000);
    [...segments.keys()].sort((left, right) => segments[right].durationSeconds - segments[left].durationSeconds).forEach(index => {
      if (pausedSeconds <= 0) return;
      const removable = Math.min(pausedSeconds, Math.max(0, segments[index].durationSeconds - 0.1));
      segments[index].durationSeconds -= removable;
      pausedSeconds -= removable;
    });
    segments = segments.map(segment => ({
      ...segment,
      speedKmh: Number.isFinite(segment.speedKmh) ? segment.speedKmh : segment.durationSeconds > 0 ? segment.distanceMeters / segment.durationSeconds * 3.6 : 0
    }));
  } else {
    segments = segmentsForRoute(route).map(segment => {
      const distanceMeters = Number(segment.distanceMeters) || 0;
      const durationSeconds = Number(segment.durationSeconds) || 0;
      return { distanceMeters, durationSeconds, speedKmh: durationSeconds > 0 ? distanceMeters / durationSeconds * 3.6 : 0 };
    });
  }

  segments = segments.filter(segment => Number.isFinite(segment.speedKmh) && Number.isFinite(segment.durationSeconds));
  if (!segments.length) return null;
  const totalDistanceMeters = segments.reduce((sum, segment) => sum + segment.distanceMeters, 0);
  const totalDurationSeconds = segments.reduce((sum, segment) => sum + segment.durationSeconds, 0);
  const averageSpeedKmh = totalDurationSeconds > 0 ? totalDistanceMeters / totalDurationSeconds * 3.6 : 0;
  const zoneSeconds = { low: 0, medium: 0, high: 0 };
  segments.forEach(segment => { zoneSeconds[speedZoneFor(segment.speedKmh)] += segment.durationSeconds; });
  return { averageSpeedKmh, totalDistanceMeters, totalDurationSeconds, zoneSeconds, segments };
}

function mixHexColors(from, to, ratio) {
  const read = value => [1, 3, 5].map(index => Number.parseInt(value.slice(index, index + 2), 16));
  const start = read(from);
  const end = read(to);
  return `#${start.map((value, index) => Math.round(value + (end[index] - value) * ratio).toString(16).padStart(2, "0")).join("")}`;
}

function speedColorPosition(speedKmh) {
  const zone = speedZoneFor(speedKmh);
  return zone === "low" ? 0 : zone === "medium" ? 0.5 : 1;
}

function speedGradientColor(position) {
  const safePosition = Math.min(1, Math.max(0, position));
  return safePosition <= 0.5
    ? mixHexColors(SPEED_COLORS.low, SPEED_COLORS.medium, safePosition * 2)
    : mixHexColors(SPEED_COLORS.medium, SPEED_COLORS.high, (safePosition - 0.5) * 2);
}

function interpolatePoint(from, to, ratio) {
  return { lat: from.lat + (to.lat - from.lat) * ratio, lng: from.lng + (to.lng - from.lng) * ratio };
}

function clearSpeedGradient() {
  state.speedGradientLayers.forEach(layer => map.remove(layer));
  state.speedGradientLayers = [];
}

function renderSpeedGradient(route, profile) {
  clearSpeedGradient();
  const points = window.RouteExport.routePoints(route);
  if (points.length < 2 || !profile) return;
  let speeds;
  if (route.type === "recorded" && profile.segments.length === points.length - 1) {
    speeds = profile.segments.map(segment => segment.speedKmh);
  } else if (profile.segments.length > 1) {
    const segmentLimits = [];
    profile.segments.reduce((distance, segment) => {
      segmentLimits.push(distance + segment.distanceMeters);
      return distance + segment.distanceMeters;
    }, 0);
    const geometryDistances = points.slice(1).map((point, index) => distanceBetween(points[index], point));
    const geometryDistance = geometryDistances.reduce((sum, distance) => sum + distance, 0);
    let travelled = 0;
    speeds = geometryDistances.map(pieceDistance => {
      const midpoint = travelled + pieceDistance / 2;
      travelled += pieceDistance;
      const proportionalDistance = geometryDistance > 0 ? midpoint / geometryDistance * profile.totalDistanceMeters : midpoint;
      const segmentIndex = segmentLimits.findIndex(limit => proportionalDistance <= limit);
      return profile.segments[segmentIndex < 0 ? profile.segments.length - 1 : segmentIndex].speedKmh;
    });
  } else {
    speeds = Array(points.length - 1).fill(profile.averageSpeedKmh);
  }
  const positions = speeds.map(speedColorPosition);
  const colors = positions.map(speedGradientColor);
  if (colors.every(color => color === colors[0])) {
    state.speedGradientLayers.push(map.createPolyline(points, { color: colors[0], weight: 7, opacity: 0.96 }));
    return;
  }

  const steps = Math.max(1, Math.min(6, Math.floor(SPEED_GRADIENT_MAX_LAYERS / colors.length)));
  colors.forEach((color, index) => {
    const startPosition = index ? (positions[index - 1] + positions[index]) / 2 : positions[index];
    const endPosition = index < positions.length - 1 ? (positions[index] + positions[index + 1]) / 2 : positions[index];
    for (let step = 0; step < steps; step += 1) {
      const startRatio = step / steps;
      const endRatio = (step + 1) / steps;
      state.speedGradientLayers.push(map.createPolyline([
        interpolatePoint(points[index], points[index + 1], startRatio),
        interpolatePoint(points[index], points[index + 1], endRatio)
      ], {
        color: speedGradientColor(startPosition + (endPosition - startPosition) * (startRatio + endRatio) / 2),
        weight: 7,
        opacity: 0.96
      }));
    }
  });
}

function setSpeedPanelExpanded(expanded) {
  const panel = $("#speed-panel");
  panel.classList.toggle("expanded", expanded);
  $("#speed-panel-body").hidden = !expanded;
  $("#speed-panel-toggle").setAttribute("aria-expanded", String(expanded));
  if (expanded) {
    $("#route-segments-panel").classList.remove("expanded");
    $("#route-segments-body").hidden = true;
    $("#route-segments-toggle").setAttribute("aria-expanded", "false");
    if (state.simulation) setSimulationPanelVisible(false);
  }
  syncDashboardDock();
}

function hideSpeedPanel() {
  state.speedProfile = null;
  setSpeedPanelExpanded(false);
  $("#speed-panel").hidden = true;
  syncDashboardDock();
}

function showSpeedPanelForRoute(route) {
  const profile = speedProfileForRoute(route);
  if (!profile) {
    hideSpeedPanel();
    clearSpeedGradient();
    return;
  }
  state.speedProfile = profile;
  $("#speed-panel-summary").textContent = `${profile.averageSpeedKmh.toFixed(1)} km/h`;
  $("#speed-average-value").textContent = `${profile.averageSpeedKmh.toFixed(1)} km/h`;
  $("#speed-low-time").textContent = formatDuration(profile.zoneSeconds.low * 1000);
  $("#speed-medium-time").textContent = formatDuration(profile.zoneSeconds.medium * 1000);
  $("#speed-high-time").textContent = formatDuration(profile.zoneSeconds.high * 1000);
  $("#speed-panel").hidden = false;
  setSpeedPanelExpanded(false);
  renderSpeedGradient(route, profile);
  syncDashboardDock();
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

function speedStateForTrack(track = state.track) {
  if (!track) return null;
  track.speedState = window.GpsSpeed.create(track.speedState);
  return track.speedState;
}

function updateLiveSpeed() {
  const speedState = speedStateForTrack();
  $("#live-speed").textContent = `${(speedState?.currentSpeedKmh || 0).toFixed(1)} km/h`;
}

function enterGpsSignalLoss(detail = "No se reciben ubicaciones nuevas del dispositivo.") {
  if (!state.track || state.track.status !== "recording") return;
  const speedState = speedStateForTrack();
  if (speedState.signal === "lost") return;
  const heldSpeedKmh = window.GpsSpeed.loseSignal(speedState);
  updateLiveSpeed();
  setGpsStatus(
    "Señal GPS perdida",
    heldSpeedKmh > 0
      ? `Manteniendo la velocidad promedio previa: ${heldSpeedKmh.toFixed(1)} km/h.`
      : "Velocidad en 0 km/h hasta recuperar una lectura válida.",
    "warning"
  );
  showMapBanner(`${detail} El recorrido sigue activo sin inventar coordenadas.`, "warning", 7000);
  persistActiveTrack();
}

function startGpsWatchdog() {
  stopGpsWatchdog();
  state.gpsWatchdogId = window.setInterval(() => {
    const speedState = speedStateForTrack();
    if (!speedState || state.track?.status !== "recording" || !speedState.lastSignalAt) return;
    if (Date.now() - speedState.lastSignalAt >= GPS_SIGNAL_LOSS_TIMEOUT_MS) {
      enterGpsSignalLoss("La señal GPS dejó de actualizarse.");
    }
  }, GPS_WATCHDOG_INTERVAL_MS);
}

function stopGpsWatchdog() {
  if (state.gpsWatchdogId !== null) window.clearInterval(state.gpsWatchdogId);
  state.gpsWatchdogId = null;
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
    points: [],
    markedPoints: [],
    speedState: window.GpsSpeed.create()
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
  const speedState = speedStateForTrack();
  speedState.lastSignalAt = Date.now();
  startGpsWatchdog();

  state.timerId = window.setInterval(updateLiveMetrics, 1000);
  pauseCaptureButton.hidden = false;
  markCapturePointButton.hidden = false;
  markCapturePointButton.disabled = !state.track.points.length;
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
    speed: null,
    rawSpeed: position.coords.speed,
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
  const reportedSpeedMs = Number(position.coords.speed);
  const hasReportedSpeed = position.coords.speed !== null && Number.isFinite(reportedSpeedMs) && reportedSpeedMs >= 0;
  const derivedSpeedKmh = previous && secondsFromPrevious > 0 ? distanceFromPrevious / secondsFromPrevious * 3.6 : 0;
  const rawSpeedKmh = hasReportedSpeed ? reportedSpeedMs * 3.6 : derivedSpeedKmh;
  const speedState = speedStateForTrack();
  const lostBeforeReading = speedState.signal === "lost";
  const speedResult = window.GpsSpeed.record(speedState, rawSpeedKmh, {
    timestamp: position.timestamp,
    accuracyMeters: point.accuracy
  });
  point.speed = speedResult.speedKmh / 3.6;
  point.rawSpeed = rawSpeedKmh / 3.6;
  point.speedSource = hasReportedSpeed ? "gps" : "distance-time";
  updateLiveSpeed();

  if (lostBeforeReading) {
    showMapBanner("Señal GPS recuperada. La velocidad se ajustará progresivamente.", "info", 5000);
  }
  const speedDetail = speedResult.signal === "recovering"
    ? `Reconexión estable · velocidad ${speedResult.speedKmh.toFixed(1)} km/h`
    : speedResult.spikeRejected
      ? `Lectura atípica filtrada · velocidad ${speedResult.speedKmh.toFixed(1)} km/h`
      : `Ubicación activa · velocidad ${speedResult.speedKmh.toFixed(1)} km/h`;
  if (previous && distanceFromPrevious < MIN_POINT_DISTANCE_METERS && secondsFromPrevious < 12) {
    setGpsStatus(lostBeforeReading ? "Señal GPS recuperada" : "Grabando recorrido", `${speedDetail} · precisión ±${point.accuracy} m`, point.accuracy <= 30 ? "good" : "warning");
    persistActiveTrack();
    return;
  }

  if (previous) state.track.distanceMeters += distanceFromPrevious;
  state.track.points.push(point);
  state.trackLine.addPoint(latlng);
  markCapturePointButton.disabled = false;

  if (!state.captureStartMarker) {
    state.captureStartMarker = map.createCircleMarker(latlng, {
      radius: 8, strokeColor: "#fff", strokeWeight: 3, fillColor: "#111111", fillOpacity: 1, title: "Inicio del recorrido"
    });
    map.setView(latlng, 17);
    navigator.vibrate?.(120);
  } else if (state.followLocation) {
    map.panTo(latlng, { animate: true });
  }

  setGpsStatus(lostBeforeReading ? "Señal GPS recuperada" : "Grabando recorrido", `${speedDetail} · precisión ±${point.accuracy} m`, point.accuracy <= 30 ? "good" : "warning");
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

function markedPointsForRoute(route) {
  return Array.isArray(route?.markedPoints) ? route.markedPoints.filter(point => Number.isFinite(Number(point.lat)) && Number.isFinite(Number(point.lng))) : [];
}

function clearCapturePointMarkers() {
  state.capturePointMarkers.forEach(marker => map.remove(marker));
  state.capturePointMarkers = [];
}

function renderCapturePointMarkers(points = []) {
  clearCapturePointMarkers();
  markedPointsForRoute({ markedPoints: points }).forEach((point, index) => {
    state.capturePointMarkers.push(map.createHtmlMarker(point, {
      className: "capture-point-icon-shell",
      size: 30,
      zIndex: 950,
      html: `<div class="capture-point-marker" aria-label="Punto marcado ${index + 1}">${index + 1}</div>`
    }));
  });
}

function markCurrentCapturePoint() {
  if (!state.track || state.track.status === "finished") return;
  const currentPoint = state.track.points.at(-1);
  if (!currentPoint) {
    showMapBanner("Espera a que el GPS registre la primera ubicación antes de marcar un punto.", "warning", 5000);
    return;
  }
  state.track.markedPoints = markedPointsForRoute(state.track);
  const number = state.track.markedPoints.length + 1;
  const markedPoint = {
    lat: Number(currentPoint.lat),
    lng: Number(currentPoint.lng),
    accuracy: currentPoint.accuracy ?? null,
    timestamp: new Date().toISOString(),
    name: `Punto marcado ${number}`
  };
  state.track.markedPoints.push(markedPoint);
  const speedState = speedStateForTrack();
  const stoppedWithoutSignal = speedState.signal === "lost";
  if (stoppedWithoutSignal) window.GpsSpeed.stop(speedState, { duringSignalLoss: true });
  renderCapturePointMarkers(state.track.markedPoints);
  updateLiveMetrics();
  persistActiveTrack();
  navigator.vibrate?.([70, 40, 70]);
  setGpsStatus(
    `Punto ${number} marcado`,
    stoppedWithoutSignal
      ? "Parada registrada sin señal · velocidad y promedio reiniciados a 0 km/h."
      : `${markedPoint.lat.toFixed(6)}, ${markedPoint.lng.toFixed(6)}`,
    stoppedWithoutSignal || state.track.status === "paused" ? "paused" : "good"
  );
  showMapBanner(stoppedWithoutSignal ? `Punto ${number} guardado como parada sin señal.` : `Punto ${number} guardado en el recorrido.`, "info", 3000);
}

function handlePositionError(error) {
  const errors = {
    1: ["Permiso de ubicación bloqueado", "En Android abre Ajustes → Aplicaciones → Chrome → Permisos → Ubicación → Permitir mientras se usa."],
    2: ["No se encuentra la ubicación", "Activa el GPS y el modo de ubicación de alta precisión."],
    3: ["El GPS tardó demasiado", "Sal a un lugar abierto y vuelve a intentarlo."]
  };
  const [title, detail] = errors[error.code] || ["Error de ubicación", error.message];
  if (error.code !== 1 && state.track?.status === "recording") {
    enterGpsSignalLoss(detail);
    return;
  }

  setGpsStatus(title, detail, "error");
  showMapBanner(detail, "error", 7000);
  stopWatchingPosition();
  if (state.track?.status === "recording") {
    window.GpsSpeed.stop(speedStateForTrack());
    updateLiveSpeed();
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
  window.GpsSpeed.stop(speedStateForTrack());
  updateLiveSpeed();
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
  window.GpsSpeed.stop(speedStateForTrack());
  updateLiveSpeed();
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
  markCapturePointButton.hidden = true;
  markCapturePointButton.disabled = true;
  finishCaptureButton.hidden = true;
  clearInterval(state.timerId);
  releaseWakeLock();
  const finishedPoints = [...state.track.points];
  state.trackLine.setPoints([]);
  if (finishedPoints.length) map.fit(finishedPoints, 35);
  showRouteSegments(segmentsForRoute(state.track));
  showSpeedPanelForRoute(state.track);
}

function stopWatchingPosition() {
  if (state.watchId !== null) navigator.geolocation.clearWatch(state.watchId);
  state.watchId = null;
  stopGpsWatchdog();
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
  $("#live-marked-points").textContent = markedPointsForRoute(state.track).length;
  updateLiveSpeed();
}

function persistActiveTrack() {
  if (state.track && state.track.status !== "finished") localStorage.setItem(ACTIVE_TRACK_KEY, JSON.stringify(state.track));
}

function restoreActiveTrack() {
  const saved = JSON.parse(localStorage.getItem(ACTIVE_TRACK_KEY) || "null");
  if (!saved?.points?.length) return;
  saved.status = "paused";
  saved.markedPoints = markedPointsForRoute(saved);
  saved.pausedAt = saved.points.at(-1).timestamp;
  saved.speedState = window.GpsSpeed.create(saved.speedState);
  window.GpsSpeed.stop(saved.speedState);
  state.track = saved;
  state.trackLine.setPoints(saved.points);
  const first = saved.points[0];
  const last = saved.points.at(-1);
  state.captureStartMarker = map.createCircleMarker(first, { radius: 8, strokeColor: "#fff", strokeWeight: 3, fillColor: "#111111", fillOpacity: 1 });
  renderCapturePointMarkers(saved.markedPoints);
  updateCurrentLocation(last, last.accuracy);
  map.fit(state.trackLine.getPoints(), 35);
  $("#track-name").value = saved.name;
  $("#live-accuracy").textContent = `±${last.accuracy} m`;
  setGpsStatus("Recorrido recuperado", "Pulsa continuar para volver a grabar.", "paused");
  startCaptureButton.querySelector("span:last-child").textContent = "Continuar recorrido";
  finishCaptureButton.hidden = false;
  markCapturePointButton.hidden = false;
  markCapturePointButton.disabled = false;
  updateLiveMetrics();
}

function clearCaptureLayers() {
  clearSpeedGradient();
  hideSpeedPanel();
  clearCapturePointMarkers();
  state.trackLine.setPoints([]);
  ["currentMarker", "accuracyCircle", "captureStartMarker", "captureEndMarker"].forEach(key => {
    if (state[key]) map.remove(state[key]);
    state[key] = null;
  });
  $("#live-distance").textContent = "0 m";
  $("#live-duration").textContent = "00:00";
  $("#live-accuracy").textContent = "—";
  $("#live-speed").textContent = "0.0 km/h";
  $("#live-points").textContent = "0";
  $("#live-marked-points").textContent = "0";
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
markCapturePointButton.addEventListener("click", markCurrentCapturePoint);
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
    <div class="waypoint-analysis-row">
      <label>Frecuencia de parada<input data-waypoint-frequency="${waypoint.id}" type="number" min="1" step="1" value="${Math.max(1, Number(waypoint.frequency) || 1)}"></label>
      <label>Estancia (minutos)<input data-waypoint-dwell="${waypoint.id}" type="number" min="0" step="1" value="${Math.max(0, Number(waypoint.dwellMinutes) || 0)}"></label>
    </div>
  </div>`).join("");

  document.querySelectorAll("[data-waypoint-input]").forEach(input => input.addEventListener("input", event => {
    const waypoint = getWaypoint(event.currentTarget.dataset.waypointInput);
    if (waypoint) waypoint.label = event.currentTarget.value;
  }));
  document.querySelectorAll("[data-search-waypoint]").forEach(button => button.addEventListener("click", () => searchPlace("waypoint", button.dataset.searchWaypoint)));
  document.querySelectorAll("[data-map-waypoint]").forEach(button => button.addEventListener("click", () => selectWaypointOnMap(button.dataset.mapWaypoint)));
  document.querySelectorAll("[data-remove-waypoint]").forEach(button => button.addEventListener("click", () => removeWaypoint(button.dataset.removeWaypoint)));
  document.querySelectorAll("[data-waypoint-frequency]").forEach(input => input.addEventListener("input", event => {
    const waypoint = getWaypoint(event.currentTarget.dataset.waypointFrequency);
    if (waypoint) waypoint.frequency = Math.max(1, Number(event.currentTarget.value) || 1);
    clearDensityAnalysis();
  }));
  document.querySelectorAll("[data-waypoint-dwell]").forEach(input => input.addEventListener("input", event => {
    const waypoint = getWaypoint(event.currentTarget.dataset.waypointDwell);
    if (waypoint) waypoint.dwellMinutes = Math.max(0, Number(event.currentTarget.value) || 0);
    clearDensityAnalysis();
  }));
}

function selectWaypointOnMap(id) {
  const waypoint = getWaypoint(id);
  if (!waypoint) return;
  state.waypointSelectionId = waypoint.id;
  state.pointSelectionType = null;
  const index = state.waypoints.indexOf(waypoint) + 1;
  setMessage(`Toca el mapa para colocar el punto obligatorio ${index}.`);
}

function selectPointOnMap(type) {
  state.pointSelectionType = type;
  state.waypointSelectionId = null;
  setMessage(`Toca el mapa para colocar el ${type === "start" ? "punto de partida" : "punto final"}.`);
  scrollToSimulationMap();
}

function useCurrentLocation(type) {
  const button = document.querySelector(`[data-current-location="${type}"]`);
  if (!navigator.geolocation) {
    setMessage("Este navegador o dispositivo no permite consultar la ubicación.");
    return;
  }

  button.disabled = true;
  button.textContent = "…";
  setMessage("Buscando tu ubicación actual… Acepta el permiso de ubicación del navegador.");
  navigator.geolocation.getCurrentPosition(position => {
    const point = { lat: position.coords.latitude, lng: position.coords.longitude };
    const label = `${point.lat.toFixed(6)}, ${point.lng.toFixed(6)}`;
    setPoint(type, point, label);
    state.pointSelectionType = null;
    state.waypointSelectionId = null;
    map.setView(point, Math.max(map.getZoom(), 17));
    button.disabled = false;
    button.textContent = "GPS";
    setMessage(`Tu ubicación actual se estableció como ${type === "start" ? "punto de partida" : "punto final"}.`);
  }, error => {
    const messages = {
      1: "Debes permitir el acceso a la ubicación para usar este botón.",
      2: "No fue posible encontrar tu ubicación. Activa el GPS del dispositivo.",
      3: "La ubicación tardó demasiado. Intenta nuevamente en un lugar abierto."
    };
    button.disabled = false;
    button.textContent = "GPS";
    setMessage(messages[error.code] || "No fue posible consultar tu ubicación actual.");
  }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 });
}

function addWaypoint(point = null, label = "", selectOnMap = true) {
  if (state.waypoints.length >= 8) return setMessage("Puedes agregar hasta 8 puntos obligatorios por ruta.");
  clearDensityAnalysis();
  const waypoint = { id: String(++waypointSequence), point, label, frequency: 1, dwellMinutes: 0, marker: null };
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
  clearDensityAnalysis();
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
  clearDensityAnalysis();
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
  if (state.pointSelectionType) {
    const type = state.pointSelectionType;
    setPoint(type, latlng, `${latlng.lat.toFixed(6)}, ${latlng.lng.toFixed(6)}`);
    state.pointSelectionType = null;
    setMessage(type === "start" ? "Punto de partida colocado en el mapa." : "Punto final colocado en el mapa.");
    return;
  }
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
  if (!query) {
    setMessage("Escribe una dirección o unas coordenadas para buscarla.");
    return false;
  }
  const assignPoint = (point, label) => {
    if (type === "waypoint") {
      setWaypoint(waypointId, point, label);
      state.waypointSelectionId = null;
    } else {
      setPoint(type, point, label);
      state.pointSelectionType = null;
    }
  };
  const coordinates = parseCoordinates(query);
  if (coordinates) {
    assignPoint(coordinates.point, coordinates.label);
    map.setView(coordinates.point, 16);
    setMessage(type === "waypoint" ? "Coordenadas del punto obligatorio guardadas." : "Coordenadas encontradas.");
    return true;
  }
  setMessage("Buscando ubicación…");
  try {
    let googleResult = null;
    try { googleResult = await map.geocode(query); } catch { /* Usa el buscador de respaldo. */ }
    if (googleResult) {
      assignPoint(googleResult.point, googleResult.label);
      map.setView(googleResult.point, 15);
      setMessage("Ubicación encontrada con Google Maps.");
      return true;
    }
    const response = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`, { headers: { "Accept-Language": "es" } });
    if (!response.ok) throw new Error();
    const [result] = await response.json();
    if (!result) {
      setMessage("No encontramos esa ubicación. Intenta ser más específico.");
      return false;
    }
    const latlng = { lat: Number(result.lat), lng: Number(result.lon) };
    assignPoint(latlng, result.display_name);
    map.setView(latlng, 15);
    setMessage("Ubicación encontrada.");
    return true;
  } catch {
    setMessage("No fue posible consultar la ubicación. Revisa tu conexión.");
    return false;
  }
}

document.querySelectorAll("[data-search]").forEach(button => button.addEventListener("click", () => searchPlace(button.dataset.search)));
document.querySelectorAll("[data-map-point]").forEach(button => button.addEventListener("click", () => selectPointOnMap(button.dataset.mapPoint)));
document.querySelectorAll("[data-current-location]").forEach(button => button.addEventListener("click", () => useCurrentLocation(button.dataset.currentLocation)));

form.addEventListener("submit", async event => {
  event.preventDefault();
  setMode("plan");
  if (!state.start || startInput.value.trim() !== state.start.label) {
    if (!await searchPlace("start")) return;
  }
  if (!state.end || endInput.value.trim() !== state.end.label) {
    if (!await searchPlace("end")) return;
  }
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
    const route = await window.RouteOptimizer.calculateRoute(routeStops, {
      penaltyFactor: 5,
      alternatives: 3
    });
    if (state.plannedLine) map.remove(state.plannedLine);
    clearSpeedGradient();
    const points = route.points;
    state.plannedDensityPath = points.map(point => ({ lat: Number(point.lat), lng: Number(point.lng) }));
    state.plannedLine = null;
    map.fit(points, 35);
    const stopNames = ["Origen", ...state.waypoints.map((_, index) => `Punto ${index + 1}`), "Destino"];
    const segments = route.legs.map((leg, index) => ({
      from: stopNames[index] || `Punto ${index}`,
      to: stopNames[index + 1] || `Punto ${index + 1}`,
      distanceMeters: leg.distanceMeters,
      durationSeconds: leg.durationSeconds
    }));
    const distanceKm = route.distanceMeters / 1000;
    const durationMin = Math.round(route.durationSeconds / 60);
    $("#distance").textContent = `${distanceKm.toFixed(1)} km`;
    $("#duration").textContent = durationMin >= 60 ? `${Math.floor(durationMin / 60)} h ${durationMin % 60} min` : `${durationMin} min`;
    const plannedRoute = {
      id: Date.now(),
      type: "planned",
      start: state.start.label,
      end: state.end.label,
      date: dateInput.value,
      time: timeInput.value,
      distanceKm,
      distanceMeters: route.distanceMeters,
      durationMin,
      durationMilliseconds: route.durationSeconds * 1000,
      waypoints: state.waypoints.map(waypoint => ({ ...waypoint.point, label: waypoint.label, frequency: waypoint.frequency || 1, dwellMinutes: waypoint.dwellMinutes || 0 })),
      segments,
      optimization: route.optimization,
      points
    };
    saveRoute(plannedRoute);
    showRouteSegments(segments);
    showSpeedPanelForRoute(plannedRoute);
    const repetitionMessage = route.optimization.repeatedEdgeTraversals
      ? ` Se reutilizaron ${route.optimization.repeatedEdgeTraversals} tramos cuando resultó necesario.`
      : " No fue necesario repetir tramos.";
    setMessage(state.waypoints.length
      ? `Ruta optimizada y guardada pasando por ${state.waypoints.length} puntos obligatorios en orden.${repetitionMessage}`
      : `Ruta optimizada y guardada.${repetitionMessage}`);
    if (state.waypoints.length) runDensityAnalysis();
    setMode("plan");
  } catch (error) {
    setMessage(error?.code === "NoRoute"
      ? "No existe una conexión vial entre dos de los puntos seleccionados. Revisa su ubicación."
      : "No se pudo calcular la ruta optimizada. Verifica los puntos y la conexión e intenta de nuevo.");
  }
  finally { calculateButton.disabled = false; }
});

function resetPlannedPoints() {
  clearSpeedGradient();
  hideSpeedPanel();
  state.waypoints.forEach(waypoint => { if (waypoint.marker) map.remove(waypoint.marker); });
  state.waypoints = [];
  state.plannedDensityPath = [];
  clearDensityAnalysis();
  state.waypointSelectionId = null;
  state.pointSelectionType = null;
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

function setImportStatus(text, type = "") {
  routeImportStatus.textContent = text;
  routeImportStatus.className = `import-status${type ? ` ${type}` : ""}`;
}

function clearImportedLayers() {
  state.importedLayers.forEach(layer => map.remove(layer));
  state.importedLayers = [];
}

function renderImportedGeoJSON(geojson, fitMap = true) {
  clearImportedLayers();
  if (!state.importedRouteVisible) return;
  const fitPoints = [];
  const maxPreviewLayers = 500;
  const addFitPoint = coordinate => {
    if (fitPoints.length < 5000) fitPoints.push({ lat: Number(coordinate[1]), lng: Number(coordinate[0]) });
  };

  (geojson?.features || []).forEach(feature => {
    const geometry = feature?.geometry;
    if (!geometry) return;
    if (geometry.type === "Point") {
      addFitPoint(geometry.coordinates);
      if (state.importedLayers.length >= maxPreviewLayers) return;
      state.importedLayers.push(map.createCircleMarker({ lat: geometry.coordinates[1], lng: geometry.coordinates[0] }, {
        radius: 5,
        strokeColor: "#111111",
        strokeWeight: 2,
        fillColor: "#FFD700",
        fillOpacity: 1,
        title: String(feature.properties?.label || feature.properties?.name || "Punto importado")
      }));
      return;
    }
    const lines = geometry.type === "LineString" ? [geometry.coordinates] : geometry.type === "MultiLineString" ? geometry.coordinates : [];
    lines.forEach(line => {
      line.forEach(addFitPoint);
      if (state.importedLayers.length >= maxPreviewLayers) return;
      state.importedLayers.push(map.createPolyline(line.map(([lng, lat]) => ({ lat, lng })), {
        color: "#e30613",
        weight: 5,
        opacity: 0.9,
        dashArray: feature.properties?.role === "route" ? undefined : "7 5"
      }));
    });
  });
  if (fitMap && fitPoints.length) map.fit(fitPoints, 35);
}

function updateImportedRouteLayerButton() {
  const button = $("#toggle-imported-route-layer");
  const available = Boolean(importedGeoJSON?.features?.length);
  button.disabled = !available;
  button.textContent = state.importedRouteVisible ? "Ocultar capa de recorrido" : "Mostrar capa de recorrido";
  button.setAttribute("aria-pressed", String(state.importedRouteVisible && available));
  updateLayersPanelState();
}

function setImportedRouteVisible(visible) {
  if (!importedGeoJSON?.features?.length) return;
  state.importedRouteVisible = Boolean(visible);
  if (state.importedRouteVisible) renderImportedGeoJSON(importedGeoJSON, false);
  else clearImportedLayers();
  updateImportedRouteLayerButton();
}

function renderImportReport(report) {
  $("#import-success-count").textContent = String(report.processed);
  $("#import-failure-count").textContent = String(report.failed);
  $("#import-crs-result").textContent = report.sourceCrs === report.targetCrs ? report.targetCrs : `${report.sourceCrs} → ${report.targetCrs}`;
  $("#import-crs-result").title = $("#import-crs-result").textContent;
  const errorList = $("#import-error-list");
  errorList.replaceChildren();
  report.errors.forEach(error => {
    const item = document.createElement("li");
    item.textContent = `${error.record}: ${error.message}`;
    errorList.appendChild(item);
  });
  routeImportReport.hidden = false;
}

function acceptImportedGeoJSON(geojson, report) {
  importedGeoJSON = geojson;
  state.importedRouteVisible = true;
  renderImportReport(report);
  renderImportedGeoJSON(geojson);
  updateImportedRouteLayerButton();
  applyImportedRouteButton.disabled = !(geojson.features || []).length;
  simulateImportedRouteButton.disabled = !window.RouteImport.simulationRoute(geojson);
  const traceSummary = report.tracePoints
    ? ` Trazado: 1 línea con ${report.tracePoints} coordenadas; puntos marcados: ${report.markedPoints || 0}; velocidades originales: ${report.speedSamples || 0}.`
    : "";
  setImportStatus(
    (report.failed
      ? `Carga finalizada con ${report.processed} registros correctos y ${report.failed} omitidos.`
      : `Carga finalizada: ${report.processed} registros correctos.`) + traceSummary,
    report.processed ? "success" : "error"
  );
  updateDensitySourceAvailability();
  const fixedPoints = window.DensityAnalysis.stopsFromGeoJSON(geojson);
  if (fixedPoints.length) {
    $("#density-point-source").value = "imported";
    runDensityAnalysis("imported");
  } else clearDensityAnalysis();
}

function fillColumnSelect(select, headers, selected, optional = false) {
  select.replaceChildren();
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = optional ? "No usar" : "Seleccionar…";
  select.appendChild(empty);
  headers.forEach(header => {
    const option = document.createElement("option");
    option.value = header;
    option.textContent = header;
    option.selected = header === selected;
    select.appendChild(option);
  });
}

function showColumnMapping(table) {
  const suggested = window.RouteImport.suggestedMapping(table.headers);
  fillColumnSelect($("#import-latitude-column"), table.headers, suggested.latitude);
  fillColumnSelect($("#import-longitude-column"), table.headers, suggested.longitude);
  fillColumnSelect($("#import-label-column"), table.headers, suggested.label, true);
  fillColumnSelect($("#import-order-column"), table.headers, suggested.order, true);
  fillColumnSelect($("#import-record-type-column"), table.headers, suggested.recordType, true);
  fillColumnSelect($("#import-timestamp-column"), table.headers, suggested.timestamp, true);
  fillColumnSelect($("#import-speed-column"), table.headers, suggested.speed, true);
  routeImportMapping.hidden = false;
  routeImportReport.hidden = true;
  setImportStatus(`Se encontraron ${table.rows.length} filas. Confirma qué columnas contienen las coordenadas.`);
}

async function processSelectedRouteFile() {
  const file = routeImportFile.files?.[0];
  importedTable = null;
  importedTableFormat = "";
  importedGeoJSON = null;
  applyImportedRouteButton.disabled = true;
  simulateImportedRouteButton.disabled = true;
  routeImportMapping.hidden = true;
  routeImportReport.hidden = true;
  clearImportedLayers();
  state.importedRouteVisible = true;
  updateImportedRouteLayerButton();
  clearDensityAnalysis();
  if (!file) return setImportStatus("Selecciona un archivo para comenzar.");
  setImportStatus(`Procesando ${file.name}…`);
  routeImportFile.disabled = true;
  try {
    const result = await window.RouteImport.readFile(file, { sourceCrs: routeImportCrs.value.trim() || "auto" });
    if (result.kind === "table") {
      importedTable = result.table;
      importedTableFormat = result.format;
      showColumnMapping(result.table);
    } else acceptImportedGeoJSON(result.geojson, result.report);
  } catch (error) {
    setImportStatus(error?.message || "No fue posible procesar el archivo.", "error");
  } finally {
    routeImportFile.disabled = false;
  }
}

async function processImportedColumns() {
  if (!importedTable || !routeImportFile.files?.[0]) return;
  const mapping = {
    latitude: $("#import-latitude-column").value,
    longitude: $("#import-longitude-column").value,
    label: $("#import-label-column").value,
    order: $("#import-order-column").value,
    recordType: $("#import-record-type-column").value,
    timestamp: $("#import-timestamp-column").value,
    speed: $("#import-speed-column").value
  };
  setImportStatus("Validando y reproyectando las filas…");
  try {
    const result = await window.RouteImport.tableToGeoJSON(importedTable, mapping, {
      sourceName: routeImportFile.files[0].name,
      format: importedTableFormat,
      sourceCrs: routeImportCrs.value.trim() || "EPSG:4326"
    });
    acceptImportedGeoJSON(result.geojson, result.report);
  } catch (error) {
    setImportStatus(error?.message || "No fue posible convertir las columnas.", "error");
  }
}

function applyImportedRoute() {
  if (!importedGeoJSON) return;
  try {
    const importedPlan = window.RouteImport.routingStops(importedGeoJSON, { maxStops: 10 });
    resetPlannedPoints();
    const stops = importedPlan.stops;
    setPoint("start", stops[0], stops[0].label);
    setPoint("end", stops.at(-1), stops.at(-1).label);
    state.waypoints = stops.slice(1, -1).map(stop => ({
      id: String(++waypointSequence),
      point: { lat: stop.lat, lng: stop.lng },
      label: stop.label,
      frequency: 1,
      dwellMinutes: 0,
      marker: null
    }));
    renderWaypointRows();
    refreshWaypointMarkers();
    map.fit(stops, 35);
    const samplingMessage = importedPlan.sampled ? " La geometría se resumió en 10 controles distribuidos sobre el trazado." : "";
    setMessage(`Ruta importada: origen, ${Math.max(0, stops.length - 2)} puntos obligatorios y destino.${samplingMessage} Pulsa “Calcular y guardar ruta”.`);
    if (window.DensityAnalysis.stopsFromGeoJSON(importedGeoJSON).length) runDensityAnalysis("imported");
    startInput.scrollIntoView({ behavior: "smooth", block: "center" });
  } catch (error) {
    setImportStatus(error?.message || "El archivo no contiene suficientes puntos para el planificador.", "error");
  }
}

function clearRouteImport() {
  routeImportFile.value = "";
  routeImportCrs.value = "";
  importedTable = null;
  importedTableFormat = "";
  importedGeoJSON = null;
  routeImportMapping.hidden = true;
  routeImportReport.hidden = true;
  applyImportedRouteButton.disabled = true;
  simulateImportedRouteButton.disabled = true;
  clearImportedLayers();
  state.importedRouteVisible = true;
  updateImportedRouteLayerButton();
  clearDensityAnalysis();
  updateDensitySourceAvailability();
  setImportStatus("Selecciona un archivo para comenzar.");
}

function clearDensityLayers() {
  state.densityLayers.forEach(layer => map.remove(layer));
  state.densityLayers = [];
}

function plannedDensityStops() {
  return state.waypoints.filter(waypoint => waypoint.point).map((waypoint, index) => ({
    lat: waypoint.point.lat,
    lng: waypoint.point.lng,
    label: waypoint.label || `Punto obligatorio ${index + 1}`,
    frequency: waypoint.frequency || 1,
    dwellMinutes: waypoint.dwellMinutes || 0
  }));
}

function importedDensityStops() {
  return window.DensityAnalysis.stopsFromGeoJSON(importedGeoJSON);
}

function updateDensitySourceAvailability() {
  const select = $("#density-point-source");
  if (!select) return;
  select.querySelector('option[value="imported"]').disabled = !importedDensityStops().length;
  select.querySelector('option[value="planned"]').disabled = !plannedDensityStops().length;
}

function updateDensityLayerButton() {
  const button = $("#toggle-density-layer");
  const available = Boolean(state.densityResult?.capa_raster?.features?.length);
  button.disabled = !available;
  button.textContent = state.densityVisible ? "Ocultar capa ráster" : "Mostrar capa ráster";
  button.setAttribute("aria-pressed", String(state.densityVisible && available));
  updateLayersPanelState();
}

function renderDensityLayers(result, fitMap = false, stops = []) {
  clearDensityLayers();
  if (!state.densityVisible || !result) return;
  const colors = window.DensityAnalysis.DENSITY_COLORS;
  result.capa_raster.features.forEach(feature => {
    const properties = feature.properties;
    const points = feature.geometry.coordinates[0].map(([lng, lat]) => ({ lat, lng }));
    state.densityLayers.push(map.createPolygon(points, {
      strokeColor: colors[properties.densidad_nivel],
      strokeWeight: 1,
      strokeOpacity: 0.92,
      fillColor: colors[properties.densidad_nivel],
      fillOpacity: 0.62 + properties.valor_intensidad * 0.28,
      title: `${properties.densidad_nivel} concentración · intensidad ${properties.valor_intensidad.toFixed(2)}`
    }));
  });
  if (fitMap) {
    const hotspot = [...result.capa_raster.features].sort((left, right) =>
      Number(right.properties?.valor_intensidad || 0) - Number(left.properties?.valor_intensidad || 0)
    )[0];
    const ring = hotspot?.geometry?.coordinates?.[0] || [];
    const vertices = ring.length > 1 ? ring.slice(0, -1) : ring;
    if (vertices.length) {
      const center = vertices.reduce((accumulator, [lng, lat]) => ({
        lat: accumulator.lat + Number(lat) / vertices.length,
        lng: accumulator.lng + Number(lng) / vertices.length
      }), { lat: 0, lng: 0 });
      map.setView(center, 19);
    } else if (stops.length) map.fit(stops, 45);
  }
}

function setDensityLayerVisible(visible) {
  if (!state.densityResult) return;
  state.densityVisible = Boolean(visible);
  if (state.densityVisible) renderDensityLayers(state.densityResult, false, state.densityStops);
  else clearDensityLayers();
  updateDensityLayerButton();
}

function clearDensityAnalysis() {
  clearDensityLayers();
  state.densityResult = null;
  state.densityVisible = true;
  state.densitySource = null;
  state.densityStops = [];
  const summary = $("#density-analysis-summary");
  if (summary) summary.hidden = true;
  const downloadButton = $("#download-density-geojson");
  if (downloadButton) downloadButton.disabled = true;
  updateDensityLayerButton();
  updateDensitySourceAvailability();
  const status = $("#density-analysis-status");
  if (status) status.textContent = importedDensityStops().length || plannedDensityStops().length
    ? "Hay puntos disponibles. Pulsa Analizar densidad para generar la capa."
    : "Carga una ruta con puntos fijos o agrega puntos obligatorios.";
}

function runDensityAnalysis(preferredSource = "") {
  if (typeof preferredSource !== "string") preferredSource = "";
  const selectedSource = preferredSource || $("#density-point-source").value;
  const importedStops = importedDensityStops();
  const plannedStops = plannedDensityStops();
  const resolvedSource = selectedSource === "auto" ? (importedStops.length ? "imported" : "planned") : selectedSource;
  const stops = resolvedSource === "imported" ? importedStops : plannedStops;
  try {
    if (!stops.length) throw new Error(resolvedSource === "imported"
      ? "El archivo cargado no contiene puntos fijos o marcados."
      : "Agrega puntos obligatorios en el planificador para analizar su densidad.");
    const interpolationPath = resolvedSource === "imported"
      ? window.DensityAnalysis.pathFromGeoJSON(importedGeoJSON)
      : state.plannedDensityPath;
    const result = window.DensityAnalysis.analyze(stops, {
      radiusMeters: 5,
      cellSizeMeters: 1.25,
      interpolationPath,
      maximumInterpolationSegments: 2000
    });
    state.densityResult = result;
    state.densityVisible = true;
    state.densitySource = resolvedSource;
    state.densityStops = stops;
    renderDensityLayers(result, true, stops);
    $("#density-total-points").textContent = String(result.resumen_analisis.total_puntos_analizados);
    $("#density-high-zones").textContent = String(result.resumen_analisis.zonas_alta_densidad);
    $("#density-total-cells").textContent = String(result.resumen_analisis.celdas_generadas);
    $("#density-analysis-summary").hidden = false;
    $("#download-density-geojson").disabled = false;
    updateDensityLayerButton();
    const sourceLabel = resolvedSource === "imported" ? "puntos fijos del archivo cargado" : "puntos obligatorios del planificador";
    $("#density-analysis-status").textContent = `Capa interpolada con ${sourceLabel}: ${result.resumen_analisis.celdas_generadas} celdas y ${result.resumen_analisis.segmentos_interpolados} tramos continuos entre todos los puntos fijos.`;
  } catch (error) {
    clearDensityAnalysis();
    $("#density-analysis-status").textContent = error?.message || "No fue posible generar la capa de densidad.";
  }
}

function downloadDensityGeoJSON() {
  if (!state.densityResult) return;
  const geojson = window.DensityAnalysis.downloadableGeoJSON(state.densityResult);
  const blob = new Blob([JSON.stringify(geojson, null, 2)], { type: "application/geo+json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "capa_raster_densidad_5m.geojson";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  $("#density-analysis-status").textContent = "Descarga GeoJSON preparada correctamente.";
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
    size: 36,
    zIndex: 1000,
    html: `<div class="vehicle-marker" aria-label="Camión de basuras de la simulación">
      <img src="garbage-truck-marker.png?v=33" alt="" aria-hidden="true">
    </div>`
  };
}

function startRouteSimulation(id) {
  startSimulationForRoute(getRoutes().find(item => item.id === id));
}

function startImportedRouteSimulation() {
  const route = window.RouteImport.simulationRoute(importedGeoJSON);
  if (!route) {
    setImportStatus("Para simular respetando la velocidad, la línea debe incluir fecha/hora válida en todas sus coordenadas.", "error");
    return;
  }
  startSimulationForRoute(route);
}

function startSimulationForRoute(route) {
  if (state.track?.status === "recording") {
    showMapBanner("Finaliza o pausa la captura actual antes de iniciar una simulación.", "warning");
    return;
  }

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
    renderCapturePointMarkers(markedPointsForRoute(route));
    pauseCaptureButton.hidden = true;
    markCapturePointButton.hidden = true;
    finishCaptureButton.hidden = true;
  } else {
    resetPlannedPoints();
  }

  const latlngs = points.map(point => ({ lat: point.lat, lng: point.lng }));
  const cumulativeDistances = [0];
  for (let index = 1; index < latlngs.length; index += 1) {
    cumulativeDistances.push(cumulativeDistances[index - 1] + distanceBetween(latlngs[index - 1], latlngs[index]));
  }

  const cumulativeTimes = route.type === "recorded" ? playbackTimeline(points, route.pausedMilliseconds, cumulativeDistances) : null;
  const originalDurationMs = Math.max(1000, cumulativeTimes?.at(-1) || (route.type === "recorded" ? getElapsedMilliseconds(route) : (route.durationMilliseconds || route.durationMin * 60000)));
  // En 1×, cada segundo de la grabación equivale a un segundo de reproducción.
  // Las opciones 2×, 4× y 10× aceleran esta misma línea de tiempo real.
  const animationDurationMs = originalDurationMs;
  showSpeedPanelForRoute(route);
  const pendingLine = map.createPolyline(latlngs, { color: "#777777", weight: 8, opacity: 0.16, dashArray: "8 8" });
  const completedLine = map.createPolyline([latlngs[0]], { color: "#ffffff", weight: 3, opacity: 0.22 });
  const marker = map.createHtmlMarker(latlngs[0], vehicleMarkerOptions());

  state.simulation = {
    route,
    points,
    latlngs,
    cumulativeDistances,
    cumulativeTimes,
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

  const simulatedDuration = simulation.originalDurationMs * safeFraction;
  if (simulation.cumulativeTimes?.length === simulation.latlngs.length) {
    while (
      segmentIndex < simulation.cumulativeTimes.length - 2 &&
      simulation.cumulativeTimes[segmentIndex + 1] < simulatedDuration
    ) segmentIndex += 1;
    const segmentStart = simulation.cumulativeTimes[segmentIndex];
    const segmentDuration = simulation.cumulativeTimes[segmentIndex + 1] - segmentStart;
    segmentFraction = segmentDuration ? (simulatedDuration - segmentStart) / segmentDuration : 0;
  } else if (simulation.geometryDistance > 0) {
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

  const routeDistance = simulation.route.distanceMeters || (simulation.route.distanceKm * 1000) || simulation.geometryDistance;
  const segmentDistance = simulation.cumulativeDistances[segmentIndex + 1] - simulation.cumulativeDistances[segmentIndex];
  const travelledDistance = simulation.cumulativeDistances[segmentIndex] + segmentDistance * segmentFraction;
  const originalSpeedMs = Number(simulation.points[segmentIndex + 1]?.speed);
  const segmentDurationMs = simulation.cumulativeTimes
    ? simulation.cumulativeTimes[segmentIndex + 1] - simulation.cumulativeTimes[segmentIndex]
    : 0;
  const currentSpeedKmh = Number.isFinite(originalSpeedMs) && originalSpeedMs >= 0
    ? originalSpeedMs * 3.6
    : segmentDurationMs > 0 ? segmentDistance / segmentDurationMs * 3600 : 0;
  $("#simulation-progress").value = String(Math.round(safeFraction * 1000));
  $("#simulation-time").textContent = `${formatDuration(simulatedDuration)} / ${formatDuration(simulation.originalDurationMs)}`;
  $("#simulation-distance").textContent = `${formatDistance(Math.min(routeDistance, travelledDistance))} / ${formatDistance(routeDistance)}`;
  $("#simulation-current-speed").textContent = `${currentSpeedKmh.toFixed(1)} km/h`;
}

function playbackTimeline(points, pausedMilliseconds = 0, cumulativeDistances = []) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const fallbackIndices = [];
  const durations = points.slice(1).map((point, index) => {
    const segmentDistance = Number(cumulativeDistances[index + 1]) - Number(cumulativeDistances[index]);
    const recordedSpeedMs = Number(point.speed);
    if (Number.isFinite(segmentDistance) && segmentDistance > 0 && Number.isFinite(recordedSpeedMs) && recordedSpeedMs > 0.05) {
      return segmentDistance / recordedSpeedMs * 1000;
    }
    fallbackIndices.push(index);
    const elapsed = Date.parse(point.timestamp) - Date.parse(points[index].timestamp);
    return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : NaN;
  });
  if (!durations.every(Number.isFinite) || !durations.some(duration => duration > 0)) return null;
  let paused = Math.max(0, Number(pausedMilliseconds) || 0);
  fallbackIndices.sort((left, right) => durations[right] - durations[left]).forEach(index => {
    if (paused <= 0) return;
    const removable = Math.min(paused, Math.max(0, durations[index] - 1));
    durations[index] -= removable;
    paused -= removable;
  });
  const cumulative = [0];
  durations.forEach(duration => cumulative.push(cumulative.at(-1) + duration));
  return cumulative.at(-1) > 0 ? cumulative : null;
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
  state.trackLine.setPoints([]);
  renderCapturePointMarkers(markedPointsForRoute(route));
  if (route.points.length) map.fit(route.points, 35);
  $("#live-distance").textContent = formatDistance(route.distanceMeters);
  $("#live-duration").textContent = formatDuration(getElapsedMilliseconds(route));
  $("#live-points").textContent = route.points.length;
  $("#live-marked-points").textContent = markedPointsForRoute(route).length;
  setGpsStatus("Recorrido guardado", route.name, "good");
  startCaptureButton.disabled = false;
  startCaptureButton.querySelector("span:last-child").textContent = "Iniciar otro recorrido";
  pauseCaptureButton.hidden = true;
  markCapturePointButton.hidden = true;
  finishCaptureButton.hidden = true;
  showRouteSegments(segmentsForRoute(route));
  showSpeedPanelForRoute(route);
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
    frequency: Math.max(1, Number(waypoint.frequency) || 1),
    dwellMinutes: Math.max(0, Number(waypoint.dwellMinutes) || 0),
    marker: null
  })).filter(waypoint => Number.isFinite(waypoint.point.lat) && Number.isFinite(waypoint.point.lng));
  renderWaypointRows();
  refreshWaypointMarkers();
  state.plannedLine = null;
  state.plannedDensityPath = points.map(point => ({ lat: Number(point.lat), lng: Number(point.lng) }));
  map.fit(points, 35);
  dateInput.value = route.date;
  timeInput.value = route.time;
  $("#distance").textContent = `${route.distanceKm.toFixed(1)} km`;
  $("#duration").textContent = `${route.durationMin} min`;
  showRouteSegments(segmentsForRoute(route));
  showSpeedPanelForRoute(route);
  if (state.waypoints.length) {
    $("#density-point-source").value = "planned";
    runDensityAnalysis("planned");
  } else {
    clearDensityAnalysis();
  }
  setMessage("Ruta planificada cargada desde el historial.");
}

function deleteRoute(id) {
  if (state.simulation?.route.id === id) closeSimulation();
  hideRouteSegments();
  hideSpeedPanel();
  clearSpeedGradient();
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
        <p>${formatDistance(route.distanceMeters)} · ${formatDuration(getElapsedMilliseconds(route))} · ${route.points.length} puntos GPS</p>
        ${markedPointsForRoute(route).length ? `<p><strong>Puntos marcados:</strong> ${markedPointsForRoute(route).length}</p>` : ""}
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
$("#route-import-toggle").addEventListener("click", event => {
  const panel = $("#route-import-panel");
  const expanded = event.currentTarget.getAttribute("aria-expanded") !== "true";
  event.currentTarget.setAttribute("aria-expanded", String(expanded));
  panel.hidden = !expanded;
  event.currentTarget.closest(".route-import").classList.toggle("open", expanded);
});
routeImportFile.addEventListener("change", processSelectedRouteFile);
routeImportCrs.addEventListener("change", () => {
  if (routeImportFile.files?.[0] && !importedTable) processSelectedRouteFile();
});
$("#process-import-columns").addEventListener("click", processImportedColumns);
applyImportedRouteButton.addEventListener("click", applyImportedRoute);
simulateImportedRouteButton.addEventListener("click", startImportedRouteSimulation);
$("#clear-route-import").addEventListener("click", clearRouteImport);
$("#run-density-analysis").addEventListener("click", runDensityAnalysis);
$("#download-density-geojson").addEventListener("click", downloadDensityGeoJSON);
$("#toggle-imported-route-layer").addEventListener("click", () => setImportedRouteVisible(!state.importedRouteVisible));
$("#toggle-density-layer").addEventListener("click", () => setDensityLayerVisible(!state.densityVisible));
$("#density-point-source").addEventListener("change", () => runDensityAnalysis());
$("#layers-panel-toggle").addEventListener("click", event => {
  setLayersPanelExpanded(event.currentTarget.getAttribute("aria-expanded") !== "true");
});
$("#clear-history").addEventListener("click", () => {
  if (!getRoutes().length || confirm("¿Borrar todos los recorridos guardados en este dispositivo?")) {
    localStorage.removeItem(STORAGE_KEY);
    hideRouteSegments();
    hideSpeedPanel();
    clearSpeedGradient();
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
$("#route-segments-close").addEventListener("click", hideRouteSegments);
$("#speed-panel-toggle").addEventListener("click", event => {
  setSpeedPanelExpanded(event.currentTarget.getAttribute("aria-expanded") !== "true");
});
$("#speed-panel-close").addEventListener("click", hideSpeedPanel);
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

