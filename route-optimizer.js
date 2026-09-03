(function exposeRouteOptimizer(global) {
  "use strict";

  const DEFAULT_OPTIONS = Object.freeze({
    endpoint: "https://router.project-osrm.org",
    profile: "driving",
    penaltyFactor: 5,
    alternatives: 3
  });

  function finiteNonNegative(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
  }

  function normalizedOptions(options = {}) {
    return {
      endpoint: String(options.endpoint || DEFAULT_OPTIONS.endpoint).replace(/\/$/, ""),
      profile: String(options.profile || DEFAULT_OPTIONS.profile),
      penaltyFactor: Math.max(1, finiteNonNegative(options.penaltyFactor, DEFAULT_OPTIONS.penaltyFactor)),
      alternatives: Math.max(1, Math.min(5, Math.round(finiteNonNegative(options.alternatives, DEFAULT_OPTIONS.alternatives)))),
      fetchFn: options.fetchFn || global.fetch?.bind(global),
      signal: options.signal
    };
  }

  function normalizedPoint(point) {
    const lat = Number(point?.lat);
    const lng = Number(point?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new TypeError("El punto de la ruta no contiene coordenadas válidas.");
    return { lat, lng };
  }

  function edgeKey(fromNode, toNode) {
    const from = String(fromNode);
    const to = String(toNode);
    return from < to ? `${from}:${to}` : `${to}:${from}`;
  }

  function coordinateNode([lng, lat]) {
    return `${Number(lat).toFixed(5)},${Number(lng).toFixed(5)}`;
  }

  function routeEdges(route) {
    const annotation = route?.legs?.[0]?.annotation || {};
    const nodes = Array.isArray(annotation.nodes) ? annotation.nodes : [];
    const weights = Array.isArray(annotation.weight) ? annotation.weight : [];
    const durations = Array.isArray(annotation.duration) ? annotation.duration : [];
    const distances = Array.isArray(annotation.distance) ? annotation.distance : [];
    const edgeCount = Math.max(0, nodes.length - 1);
    const routeFallback = finiteNonNegative(route?.weight, finiteNonNegative(route?.duration, finiteNonNegative(route?.distance, 1)));

    if (edgeCount) {
      return Array.from({ length: edgeCount }, (_, index) => ({
        key: edgeKey(nodes[index], nodes[index + 1]),
        baseCost: finiteNonNegative(weights[index], finiteNonNegative(durations[index], finiteNonNegative(distances[index], routeFallback / edgeCount)))
      }));
    }

    const coordinates = Array.isArray(route?.geometry?.coordinates) ? route.geometry.coordinates : [];
    if (coordinates.length < 2) return [];
    const geometryEdgeCount = coordinates.length - 1;
    return Array.from({ length: geometryEdgeCount }, (_, index) => ({
      key: edgeKey(coordinateNode(coordinates[index]), coordinateNode(coordinates[index + 1])),
      baseCost: routeFallback / geometryEdgeCount
    }));
  }

  function usageCount(usedEdges, key) {
    if (usedEdges instanceof Map) return finiteNonNegative(usedEdges.get(key));
    return usedEdges?.has?.(key) ? 1 : 0;
  }

  function cloneUsage(usedEdges) {
    if (usedEdges instanceof Map) return new Map(usedEdges);
    const copy = new Map();
    usedEdges?.forEach?.(key => copy.set(key, 1));
    return copy;
  }

  function scoreCandidate(route, usedEdges = new Map(), penaltyFactor = DEFAULT_OPTIONS.penaltyFactor) {
    const factor = Math.max(1, finiteNonNegative(penaltyFactor, DEFAULT_OPTIONS.penaltyFactor));
    const simulatedUsage = cloneUsage(usedEdges);
    let cost = 0;
    let repeatedEdgeTraversals = 0;

    routeEdges(route).forEach(edge => {
      const previousUses = usageCount(simulatedUsage, edge.key);
      const repeated = previousUses > 0;
      cost += edge.baseCost * (repeated ? factor : 1);
      if (repeated) repeatedEdgeTraversals += 1;
      simulatedUsage.set(edge.key, previousUses + 1);
    });

    return {
      cost,
      repeatedEdgeTraversals,
      baseCost: finiteNonNegative(route?.weight, finiteNonNegative(route?.duration, route?.distance))
    };
  }

  function chooseCandidate(candidates, usedEdges = new Map(), penaltyFactor = DEFAULT_OPTIONS.penaltyFactor) {
    if (!Array.isArray(candidates) || !candidates.length) throw new Error("No hay rutas candidatas para evaluar.");
    return candidates
      .map((route, index) => ({ route, index, ...scoreCandidate(route, usedEdges, penaltyFactor) }))
      .sort((left, right) => left.cost - right.cost || left.baseCost - right.baseCost || left.index - right.index)[0];
  }

  function registerRouteEdges(route, usedEdges) {
    routeEdges(route).forEach(edge => usedEdges.set(edge.key, usageCount(usedEdges, edge.key) + 1));
    return usedEdges;
  }

  async function requestLegAlternatives(from, to, options = {}) {
    const settings = normalizedOptions(options);
    if (typeof settings.fetchFn !== "function") throw new Error("El navegador no permite consultar el servicio de rutas.");
    const start = normalizedPoint(from);
    const end = normalizedPoint(to);
    const coordinates = `${start.lng},${start.lat};${end.lng},${end.lat}`;
    const query = new URLSearchParams({
      alternatives: String(settings.alternatives),
      overview: "full",
      geometries: "geojson",
      steps: "false",
      annotations: "nodes,weight,distance,duration",
      radiuses: "100;100",
      continue_straight: "false"
    });
    const response = await settings.fetchFn(`${settings.endpoint}/route/v1/${settings.profile}/${coordinates}?${query}`, { signal: settings.signal });
    const data = await response.json();
    if (!response?.ok || data?.code !== "Ok" || !Array.isArray(data.routes) || !data.routes.length) {
      const message = data?.code === "NoSegment"
        ? "Un punto está a más de 100 m de una vía disponible. Revisa sus coordenadas."
        : data?.code === "NoRoute"
          ? "No existe una conexión vial entre los puntos."
          : data?.message || (response?.ok ? "No existe una conexión vial entre los puntos." : "El servicio de rutas no respondió correctamente.");
      const error = new Error(message);
      error.code = data?.code || `HTTP_${response?.status || "ERROR"}`;
      throw error;
    }
    return data.routes;
  }

  function mergeSelectedLegs(selectedLegs, settings) {
    const points = [];
    const legs = [];
    let distanceMeters = 0;
    let durationSeconds = 0;
    let repeatedEdgeTraversals = 0;

    selectedLegs.forEach((selection, index) => {
      const route = selection.route;
      const coordinates = Array.isArray(route?.geometry?.coordinates) ? route.geometry.coordinates : [];
      const legPoints = coordinates.map(([lng, lat]) => ({ lat: Number(lat), lng: Number(lng) }));
      points.push(...(index ? legPoints.slice(1) : legPoints));
      distanceMeters += finiteNonNegative(route.distance);
      durationSeconds += finiteNonNegative(route.duration);
      repeatedEdgeTraversals += selection.repeatedEdgeTraversals;
      legs.push({
        distanceMeters: finiteNonNegative(route.distance),
        durationSeconds: finiteNonNegative(route.duration),
        selectedAlternative: selection.index,
        alternativesEvaluated: selection.alternativesEvaluated,
        repeatedEdgeTraversals: selection.repeatedEdgeTraversals
      });
    });

    return {
      points,
      legs,
      distanceMeters,
      durationSeconds,
      optimization: {
        strategy: "soft-edge-penalty",
        penaltyFactor: settings.penaltyFactor,
        repeatedEdgeTraversals,
        legsWithSingleCandidate: selectedLegs.filter(selection => selection.alternativesEvaluated === 1).length
      }
    };
  }

  async function calculateRoute(stops, options = {}) {
    if (!Array.isArray(stops) || stops.length < 2) throw new Error("La ruta necesita un origen y un destino.");
    const settings = normalizedOptions(options);
    const normalizedStops = stops.map(normalizedPoint);
    const usedEdges = new Map();
    const selectedLegs = [];

    for (let index = 0; index < normalizedStops.length - 1; index += 1) {
      const candidates = await requestLegAlternatives(normalizedStops[index], normalizedStops[index + 1], settings);
      const selected = chooseCandidate(candidates, usedEdges, settings.penaltyFactor);
      selected.alternativesEvaluated = candidates.length;
      registerRouteEdges(selected.route, usedEdges);
      selectedLegs.push(selected);
    }

    return mergeSelectedLegs(selectedLegs, settings);
  }

  const api = {
    DEFAULT_OPTIONS,
    edgeKey,
    routeEdges,
    scoreCandidate,
    chooseCandidate,
    registerRouteEdges,
    requestLegAlternatives,
    calculateRoute
  };

  global.RouteOptimizer = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window === "undefined" ? globalThis : window);
