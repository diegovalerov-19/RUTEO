(function exposeMandatoryRouting(global) {
  "use strict";

  const MAX_STOPS = 100;
  const MAX_OPTIMIZED_STOPS = 12;
  const ENDPOINT = "https://router.project-osrm.org";

  function point(value, fallbackLabel) {
    if (value?.lat == null || value?.lng == null || value.lat === "" || value.lng === "") throw new Error(`Faltan las coordenadas de ${fallbackLabel}.`);
    const lat = Number(value.lat), lng = Number(value.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      throw new Error(`Las coordenadas de ${fallbackLabel} no son válidas.`);
    }
    return { ...value, lat, lng, label: String(value.label || fallbackLabel) };
  }

  function fromPlanner(planned = {}) {
    const start = point(planned.start, "origen del planificador");
    const end = point(planned.end, "destino del planificador");
    const required = (planned.waypoints || []).map((waypoint, index) => point({
      ...waypoint.point, label: waypoint.label,
      frequency: waypoint.frequency || 1, dwellMinutes: waypoint.dwellMinutes || 0
    }, `Punto obligatorio ${index + 1}`));
    return { source: "planned", start, end, required, endpointSource: "planner" };
  }

  function fromGeoJSON(geojson) {
    if (!geojson) throw new Error("Carga un archivo con puntos fijos en «Cargue aquí su ruta».");
    const features = geojson.features || [];
    const fixed = features.map((feature, index) => ({ feature, index }))
      .filter(({ feature }) => feature?.geometry?.type === "Point" && !["trace", "track-point"].includes(feature.properties?.role))
      .sort((a, b) => {
        const order = entry => {
          const raw = entry.feature.properties?.order ?? entry.feature.properties?.sequence ?? entry.feature.properties?.secuencia;
          return raw != null && raw !== "" && Number.isFinite(Number(raw)) ? Number(raw) : entry.index;
        };
        return order(a) - order(b) || a.index - b.index;
      }).map(({ feature }, index) => point({
        lng: feature.geometry.coordinates?.[0], lat: feature.geometry.coordinates?.[1],
        label: feature.properties?.label || feature.properties?.name,
        frequency: feature.properties?.frequency || 1,
        dwellMinutes: feature.properties?.dwellMinutes || 0
      }, `Punto fijo ${index + 1}`));
    if (!fixed.length) throw new Error("El archivo no contiene puntos fijos. Los vértices del trazado no se convierten en paradas obligatorias.");

    const lines = features.filter(feature => ["LineString", "MultiLineString"].includes(feature?.geometry?.type));
    const taggedRoutes = lines.filter(feature => feature.properties?.role === "route");
    let first, last;
    (taggedRoutes.length ? taggedRoutes : lines).forEach(feature => {
      const parts = feature.geometry.type === "LineString" ? [feature.geometry.coordinates] : feature.geometry.coordinates;
      (parts || []).forEach(coordinates => {
        if (!coordinates?.length) return;
        first ??= coordinates[0];
        last = coordinates.at(-1);
      });
    });
    if (first && last) {
      return {
        source: "imported", endpointSource: "trace", required: fixed,
        start: point({ lng: first[0], lat: first[1] }, "Inicio del recorrido cargado"),
        end: point({ lng: last[0], lat: last[1] }, "Final del recorrido cargado")
      };
    }
    if (fixed.length < 2) throw new Error("Sin trazado se necesitan al menos dos puntos: el primero será el origen y el último, el destino.");
    return { source: "imported", endpointSource: "first-last-points", start: fixed[0], end: fixed.at(-1), required: fixed.slice(1, -1) };
  }

  function context({ source = "auto", importedGeoJSON, planned } = {}) {
    return source === "imported" || (source === "auto" && importedGeoJSON)
      ? fromGeoJSON(importedGeoJSON) : fromPlanner(planned);
  }

  function validateContext(input, orderMode) {
    const stops = [point(input.start, "origen"), ...input.required.map((stop, index) => point(stop, `Punto obligatorio ${index + 1}`)), point(input.end, "destino")];
    if (stops.length > MAX_STOPS) throw new Error(`La consulta vial admite hasta ${MAX_STOPS} puntos en total. Divide el recorrido; no se descartará ninguna parada.`);
    if (orderMode !== "preserve" && input.required.length > MAX_OPTIMIZED_STOPS) {
      throw new Error(`Dijkstra optimiza hasta ${MAX_OPTIMIZED_STOPS} paradas. Selecciona «Conservar el orden actual» para incluir las ${input.required.length} paradas sin omitir ninguna.`);
    }
    return stops;
  }

  function orderFromMatrix(matrix, stopCount, dijkstra = global.DijkstraRouting) {
    if (!Array.isArray(matrix) || matrix.length !== stopCount || matrix.some(row => !Array.isArray(row) || row.length !== stopCount)) {
      throw new Error("El servicio devolvió una matriz de tiempos incompleta.");
    }
    const edges = [];
    matrix.forEach((row, from) => {
      // Zero self-loops retain isolated nodes; a missing road is never a zero-cost edge.
      edges.push({ from: String(from), to: String(from), weight: 0 });
      row.forEach((weight, to) => {
        if (weight === null) return;
        if (typeof weight !== "number" || !Number.isFinite(weight) || weight < 0) throw new Error("La matriz contiene tiempos viales inválidos.");
        if (from !== to && from !== stopCount - 1 && to !== 0) edges.push({ from: String(from), to: String(to), weight });
      });
    });
    const result = dijkstra.solve({ edges, start: "0", end: String(stopCount - 1), directed: true,
      requiredStops: Array.from({ length: stopCount - 2 }, (_, index) => String(index + 1)) });
    return { indices: result.path.map(Number), durationSeconds: result.total };
  }

  async function request(service, stops, query, options) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const timeout = setTimeout(abort, 30000);
    try {
      const params = new URLSearchParams({ ...query, radiuses: stops.map(() => "100").join(";") });
      const coordinates = stops.map(stop => `${stop.lng},${stop.lat}`).join(";");
      const response = await (options.fetchFn || global.fetch.bind(global))(`${ENDPOINT}/${service}/v1/driving/${coordinates}?${params}`, { signal: controller.signal });
      const data = await response.json();
      if (!response.ok || data.code !== "Ok") {
        if (data.code === "NoSegment") throw new Error("Un punto está a más de 100 m de una vía disponible. Revisa sus coordenadas.");
        if (data.code === "NoRoute" || data.code === "NoTable") throw new Error("No hay conexión vial entre todos los puntos obligatorios.");
        throw new Error("No se pudo consultar la red vial. Revisa la conexión e intenta nuevamente.");
      }
      return data;
    } catch (error) {
      if (controller.signal.aborted && !options.signal?.aborted) throw new Error("La consulta vial tardó demasiado. Inténtalo de nuevo.");
      throw error;
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
    }
  }

  async function calculate(input, options = {}) {
    const orderMode = options.orderMode === "preserve" ? "preserve" : "optimize";
    const stops = validateContext(input, orderMode);
    let order = { indices: stops.map((_, index) => index), durationSeconds: null };
    if (orderMode === "optimize" && input.required.length > 1) {
      const table = await request("table", stops, { annotations: "duration" }, options);
      order = orderFromMatrix(table.durations, stops.length, options.dijkstra || global.DijkstraRouting);
    }
    if (options.signal?.aborted) throw new DOMException("Cálculo cancelado", "AbortError");
    const orderedStops = order.indices.map(index => stops[index]);
    const data = await request("route", orderedStops, { overview: "full", geometries: "geojson", steps: "false", alternatives: "false", continue_straight: "false" }, options);
    const route = data.routes?.[0];
    if (!route || !Array.isArray(route.legs) || route.legs.length !== orderedStops.length - 1 || !Array.isArray(route.geometry?.coordinates) || route.geometry.coordinates.length < 2) {
      throw new Error("El servicio devolvió una ruta incompleta. No se guardaron cambios.");
    }
    const nonNegative = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
    if (!nonNegative(route.distance) || !nonNegative(route.duration) || route.legs.some(leg => !nonNegative(leg.distance) || !nonNegative(leg.duration))) {
      throw new Error("El servicio devolvió distancias o tiempos inválidos.");
    }
    const points = route.geometry.coordinates.map(([lng, lat]) => point({ lat, lng }, "trazado calculado"));
    return {
      orderedStops, indices: order.indices, points,
      distanceMeters: route.distance, durationSeconds: route.duration,
      legs: route.legs.map((leg, index) => ({ from: orderedStops[index].label, to: orderedStops[index + 1].label, distanceMeters: leg.distance, durationSeconds: leg.duration })),
      optimization: { strategy: orderMode === "optimize" ? "dijkstra-road-time" : "preserved-stop-order", matrixDurationSeconds: order.durationSeconds },
      maxSnapMeters: Math.max(0, ...(data.waypoints || []).map(stop => Number(stop.distance) || 0))
    };
  }

  const api = { MAX_STOPS, MAX_OPTIMIZED_STOPS, fromPlanner, fromGeoJSON, context, validateContext, orderFromMatrix, calculate };
  global.MandatoryRouting = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window === "undefined" ? globalThis : window);

