const assert = require("node:assert/strict");
const DijkstraRouting = require("../dijkstra-routing.js");
const MandatoryRouting = require("../mandatory-routing.js");
const RouteImport = require("../route-import.js");
const fs = require("node:fs");
const path = require("node:path");
const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
assert.match(html, /<details id="dijkstra-panel" class="dijkstra-planner">/, "El recuadro inicia cerrado con un desplegable nativo.");
assert.ok(html.indexOf('id="dijkstra-panel"') < html.indexOf('class="route-import"'));
assert.ok(!html.includes('id="apply-imported-route"'));
assert.ok(!html.includes('id="dijkstra-edges"'), "No exige volver a escribir conexiones ni paradas.");
assert.ok(!fs.readFileSync(path.join(__dirname, "../app.js"), "utf8").includes("applyImportedRouteButton"), "No quedan listeners de un botón eliminado.");

const feature = (label, lng, lat, order) => ({ type: "Feature", geometry: { type: "Point", coordinates: [lng, lat] }, properties: { label, order, role: "marked-point" } });
const trace = { type: "Feature", geometry: { type: "LineString", coordinates: [[-74.1, 4.5], [-74.05, 4.6], [-74, 4.7]] }, properties: { role: "route" } };
const input = { type: "FeatureCollection", features: [trace, feature("B", -74.03, 4.65, 2), feature("A", -74.07, 4.55, 1)] };
const imported = MandatoryRouting.fromGeoJSON(input);
assert.equal(imported.start.lng, -74.1);
assert.equal(imported.end.lng, -74);
assert.deepEqual(imported.required.map(p => p.label), ["A", "B"]);
assert.equal(imported.required.length, 2, "Los vértices GPS no se convierten en paradas.");
assert.deepEqual(input.features[1].properties.label, "B", "No se modifica el orden de los datos originales.");

const planned = { start: { lat: 1, lng: 1, label: "Inicio" }, end: { lat: 2, lng: 2, label: "Fin" }, waypoints: [{ point: { lat: 1.5, lng: 1.5 }, label: "Obligatorio" }] };
assert.equal(MandatoryRouting.context({ importedGeoJSON: input, planned }).source, "imported");
assert.equal(MandatoryRouting.context({ source: "planned", importedGeoJSON: input, planned }).required[0].label, "Obligatorio");
assert.equal(MandatoryRouting.context({ planned }).source, "planned");
assert.throws(() => MandatoryRouting.context({ source: "imported", planned }), /Carga un archivo/);
assert.throws(() => MandatoryRouting.fromPlanner({ ...planned, waypoints: [{ label: "Sin ubicar", point: null }] }), /Faltan las coordenadas/);

const pointsOnly = MandatoryRouting.fromGeoJSON({ features: [feature("Fin", 3, 3, 3), feature("Inicio", 1, 1, 1), feature("Medio", 2, 2, 2)] });
assert.equal(pointsOnly.start.label, "Inicio");
assert.equal(pointsOnly.end.label, "Fin");
assert.deepEqual(pointsOnly.required.map(p => p.label), ["Medio"]);
assert.throws(() => MandatoryRouting.fromGeoJSON({ features: [trace] }), /no contiene puntos fijos/);
assert.throws(() => MandatoryRouting.fromGeoJSON({ features: [trace, feature("Malo", 0, 91, 1)] }), /no son válidas/);
const duplicate = MandatoryRouting.fromGeoJSON({ features: [trace, feature("Visita 1", 1, 1, 1), feature("Visita 2", 1, 1, 2)] });
assert.equal(duplicate.required.length, 2, "Las visitas repetidas no se eliminan.");
const multiline = MandatoryRouting.fromGeoJSON({ features: [{ geometry: { type: "MultiLineString", coordinates: [[[-74.1, 4.5], [-74.07, 4.55]], [[-74.05, 4.6], [-74, 4.7]]] } }, feature("Fijo", -74.06, 4.59, 1)] });
assert.equal(multiline.start.lng, -74.1);
assert.equal(multiline.end.lng, -74);

const matrix = [[0, 10, 1, 20], [10, 0, 1, 1], [10, 1, 0, 10], [10, 10, 10, 0]];
assert.deepEqual(MandatoryRouting.orderFromMatrix(matrix, 4, DijkstraRouting).indices, [0, 2, 1, 3]);
assert.throws(() => MandatoryRouting.orderFromMatrix([[0, null, null], [null, 0, 1], [null, 1, 0]], 3, DijkstraRouting), /No existe una ruta/);
assert.throws(() => MandatoryRouting.orderFromMatrix([[0]], 3, DijkstraRouting), /incompleta/);
assert.throws(() => MandatoryRouting.orderFromMatrix([[0, -1], [1, 0]], 2, DijkstraRouting), /inválidos/);

(async () => {
  const requested = [];
  const fetchFn = async url => {
    requested.push(url);
    if (url.includes("/table/")) return { ok: true, json: async () => ({ code: "Ok", durations: matrix }) };
    const coordinates = new URL(url).pathname.split("/driving/")[1].split(";").map(pair => pair.split(",").map(Number));
    return { ok: true, json: async () => ({ code: "Ok", routes: [{ distance: 1234, duration: 345,
      geometry: { type: "LineString", coordinates }, legs: coordinates.slice(1).map(() => ({ distance: 10, duration: 20 })) }], waypoints: coordinates.map(location => ({ location, distance: 1 })) }) };
  };
  const result = await MandatoryRouting.calculate(imported, { fetchFn, dijkstra: DijkstraRouting });
  assert.deepEqual(result.orderedStops.map(p => p.label), [imported.start.label, "B", "A", imported.end.label]);
  assert.equal(result.distanceMeters, 1234);
  assert.equal(result.durationSeconds, 345);
  assert.equal(result.legs.length, 3);
  assert.equal(new URL(requested[0]).searchParams.get("fallback_speed"), null, "No se inventan conexiones rectas para huecos en la red.");
  assert.equal(new URL(requested[1]).searchParams.get("continue_straight"), "false", "Se permite regresar desde callejones sin salida.");

  const large = { ...imported, required: Array.from({ length: 27 }, (_, i) => ({ lat: 4.6 + i / 10000, lng: -74.1, label: `Fijo ${i + 1}` })) };
  await assert.rejects(MandatoryRouting.calculate(large, { fetchFn, dijkstra: DijkstraRouting }), /Conservar el orden actual/);
  requested.length = 0;
  const preserved = await MandatoryRouting.calculate(large, { fetchFn, orderMode: "preserve" });
  assert.equal(preserved.orderedStops.length, 29);
  assert.deepEqual(preserved.orderedStops.slice(1, -1), large.required);
  assert.equal(requested.length, 1, "Conservar el orden no solicita matriz ni omite puntos.");
  assert.equal(preserved.optimization.strategy, "preserved-stop-order");

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(MandatoryRouting.calculate(imported, { orderMode: "preserve", signal: controller.signal, fetchFn }), /cancelado/);
  await assert.rejects(MandatoryRouting.calculate(imported, { orderMode: "preserve", fetchFn: async () => ({ ok: false, json: async () => ({ code: "NoSegment" }) }) }), /100 m/);
  await assert.rejects(MandatoryRouting.calculate(imported, { orderMode: "preserve", fetchFn: async () => ({ ok: true, json: async () => ({ code: "Ok", routes: [{ legs: [] }] }) }) }), /incompleta/);

  const table = RouteImport.parseCsv("clase_punto,secuencia,latitud,longitud,nombre_punto\nTRAZA,1,4.5,-74.1,\nMARCADO,1,4.6,-74.05,Parada real\nTRAZA,2,4.7,-74,");
  const converted = await RouteImport.tableToGeoJSON(table, RouteImport.suggestedMapping(table.headers));
  const csvContext = MandatoryRouting.fromGeoJSON(converted.geojson);
  assert.equal(csvContext.required.length, 1);
  assert.equal(csvContext.required[0].label, "Parada real");
  console.log("mandatory-routing: fuentes, CSV marcado, orden Dijkstra, 27 paradas sin pérdidas, errores y cancelación aprobados");
})().catch(error => { console.error(error); process.exitCode = 1; });

