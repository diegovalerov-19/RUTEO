const DEFAULT_CENTER = [4.711, -74.0721];
const STORAGE_KEY = "ruteo-routes-v1";

const map = L.map("map").setView(DEFAULT_CENTER, 12);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
}).addTo(map);

const state = { start: null, end: null, startMarker: null, endMarker: null, routeLine: null };
const form = document.querySelector("#route-form");
const startInput = document.querySelector("#start");
const endInput = document.querySelector("#end");
const dateInput = document.querySelector("#date");
const timeInput = document.querySelector("#time");
const message = document.querySelector("#message");
const calculateButton = document.querySelector("#calculate");

const now = new Date();
dateInput.value = now.toISOString().slice(0, 10);
timeInput.value = now.toTimeString().slice(0, 5);

function setMessage(text = "") { message.textContent = text; }

function setPoint(type, latlng, label) {
  const isStart = type === "start";
  const markerKey = isStart ? "startMarker" : "endMarker";
  if (state[markerKey]) map.removeLayer(state[markerKey]);
  state[type] = { lat: latlng.lat, lng: latlng.lng, label };
  state[markerKey] = L.marker(latlng).addTo(map).bindPopup(isStart ? "Punto de partida" : "Punto final");
  (isStart ? startInput : endInput).value = label;
}

map.on("click", async ({ latlng }) => {
  const type = !state.start || state.end ? "start" : "end";
  if (type === "start" && state.end) resetPoints();
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

document.querySelectorAll("[data-search]").forEach(button => {
  button.addEventListener("click", () => searchPlace(button.dataset.search));
});

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
    if (state.routeLine) map.removeLayer(state.routeLine);
    state.routeLine = L.geoJSON(route.geometry, { style: { color: "#d96035", weight: 6, opacity: .9 } }).addTo(map);
    map.fitBounds(state.routeLine.getBounds(), { padding: [35, 35] });
    const distanceKm = route.distance / 1000;
    const durationMin = Math.round(route.duration / 60);
    document.querySelector("#distance").textContent = `${distanceKm.toFixed(1)} km`;
    document.querySelector("#duration").textContent = durationMin >= 60 ? `${Math.floor(durationMin / 60)} h ${durationMin % 60} min` : `${durationMin} min`;
    saveRoute({ id: Date.now(), start: state.start.label, end: state.end.label, date: dateInput.value, time: timeInput.value, distanceKm, durationMin });
    setMessage("Ruta calculada y guardada.");
  } catch { setMessage("No se pudo calcular la ruta. Verifica los puntos e intenta de nuevo."); }
  finally { calculateButton.disabled = false; }
});

function resetPoints() {
  ["startMarker", "endMarker", "routeLine"].forEach(key => { if (state[key]) map.removeLayer(state[key]); state[key] = null; });
  state.start = null;
  state.end = null;
  startInput.value = "";
  endInput.value = "";
  document.querySelector("#distance").textContent = "—";
  document.querySelector("#duration").textContent = "—";
  setMessage("");
}

function getRoutes() { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"); }
function saveRoute(route) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify([route, ...getRoutes()].slice(0, 20)));
  renderHistory();
}
function renderHistory() {
  const routes = getRoutes();
  document.querySelector("#history").innerHTML = routes.length ? routes.map(route => `
    <article class="history-card">
      <p class="when">${new Date(`${route.date}T${route.time}`).toLocaleString("es-CO", { dateStyle: "medium", timeStyle: "short" })}</p>
      <p><strong>Desde:</strong> ${escapeHtml(route.start)}</p>
      <p><strong>Hasta:</strong> ${escapeHtml(route.end)}</p>
      <p>${route.distanceKm.toFixed(1)} km · ${route.durationMin} min aprox.</p>
    </article>`).join("") : '<p class="empty">Todavía no hay rutas guardadas.</p>';
}
function escapeHtml(value) {
  return value.replace(/[&<>'"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

document.querySelector("#reset").addEventListener("click", resetPoints);
document.querySelector("#clear-history").addEventListener("click", () => { localStorage.removeItem(STORAGE_KEY); renderHistory(); });
renderHistory();
