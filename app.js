const DEFAULT_CENTER = [4.711, -74.0721];
const STORAGE_KEY = "ruteo-routes-v2";
const ACTIVE_TRACK_KEY = "ruteo-active-track-v2";
const MIN_POINT_DISTANCE_METERS = 5;
const MAX_ACCEPTED_ACCURACY_METERS = 60;
const SIMULATION_MIN_DURATION_MS = 12000;
const SIMULATION_MAX_DURATION_MS = 90000;
const SIMULATION_COMPRESSION = 20;
const GOOGLE_MAPS_KEY = "ruteo-google-maps-key-v1";
const SPEED_COLORS = { low: "#E62020", medium: "#FFD700", high: "#00FF00" };
const SPEED_GRADIENT_MAX_LAYERS = 1200;

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
  watchId: null,
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
  speedGradientLayers: []
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
  metricsStack.hidden = $("#route-segments-panel").hidden && $("#speed-panel").hidden;
  metricsStack.classList.toggle("expanded", $("#route-segments-panel").classList.contains("expanded") || $("#speed-panel").classList.contains("expanded"));
  dock.classList.toggle("has-visible-dashboard", !metricsStack.hidden || !$("#simulation-show").hidden || !$("#simulation-panel").hidden);
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
  const colors = speeds.map(speed => SPEED_COLORS[speedZoneFor(speed)]);
  if (colors.every(color => color === colors[0])) {
    state.speedGradientLayers.push(map.createPolyline(points, { color: colors[0], weight: 7, opacity: 0.96 }));
    return;
  }

  const steps = Math.max(1, Math.min(6, Math.floor(SPEED_GRADIENT_MAX_LAYERS / colors.length)));
  colors.forEach((color, index) => {
    const startColor = index ? mixHexColors(colors[index - 1], color, 0.5) : color;
    const endColor = index < colors.length - 1 ? mixHexColors(color, colors[index + 1], 0.5) : color;
    for (let step = 0; step < steps; step += 1) {
      const startRatio = step / steps;
      const endRatio = (step + 1) / steps;
      state.speedGradientLayers.push(map.createPolyline([
        interpolatePoint(points[index], points[index + 1], startRatio),
        interpolatePoint(points[index], points[index + 1], endRatio)
      ], {
        color: mixHexColors(startColor, endColor, (startRatio + endRatio) / 2),
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
    markedPoints: []
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
   …6427 tokens truncated… = simulationName;
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
    marker: null
  })).filter(waypoint => Number.isFinite(waypoint.point.lat) && Number.isFinite(waypoint.point.lng));
  renderWaypointRows();
  refreshWaypointMarkers();
  state.plannedLine = null;
  map.fit(points, 35);
  dateInput.value = route.date;
  timeInput.value = route.time;
  $("#distance").textContent = `${route.distanceKm.toFixed(1)} km`;
  $("#duration").textContent = `${route.durationMin} min`;
  showRouteSegments(segmentsForRoute(route));
  showSpeedPanelForRoute(route);
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
