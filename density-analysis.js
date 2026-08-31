(function exposeDensityAnalysis(global) {
  "use strict";

  const DEFAULT_RADIUS_METERS = 5;
  const DEFAULT_CELL_SIZE_METERS = 2.5;
  const EARTH_METERS_PER_DEGREE = 111320;

  function validStop(value, index) {
    const lat = Number(value?.lat);
    const lng = Number(value?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    return {
      lat,
      lng,
      label: String(value?.label || `Punto obligatorio ${index + 1}`),
      frequency: Math.max(1, Number(value?.frequency) || 1),
      dwellMinutes: Math.max(0, Number(value?.dwellMinutes) || 0)
    };
  }

  function levelFor(intensity) {
    if (intensity >= 0.67) return "Alta";
    if (intensity >= 0.34) return "Media";
    return "Baja";
  }

  function stopsFromGeoJSON(geojson) {
    const pointFeatures = (geojson?.features || []).filter(feature => feature?.geometry?.type === "Point");
    const markedFeatures = pointFeatures.filter(feature => feature?.properties?.role === "marked-point");
    return (markedFeatures.length ? markedFeatures : pointFeatures).map((feature, index) => ({
      lat: Number(feature.geometry.coordinates[1]),
      lng: Number(feature.geometry.coordinates[0]),
      label: String(feature.properties?.label || feature.properties?.name || `Punto fijo ${index + 1}`),
      frequency: Math.max(1, Number(feature.properties?.frequency ?? feature.properties?.frecuencia) || 1),
      dwellMinutes: Math.max(0, Number(feature.properties?.dwellMinutes ?? feature.properties?.estancia_min ?? feature.properties?.estanciaMinutos) || 0)
    })).filter(stop => Number.isFinite(stop.lat) && Number.isFinite(stop.lng));
  }

  function highDensityZones(cells) {
    const high = new Set(cells.filter(cell => cell.level === "Alta").map(cell => `${cell.column}:${cell.row}`));
    let zones = 0;
    while (high.size) {
      zones += 1;
      const pending = [high.values().next().value];
      high.delete(pending[0]);
      while (pending.length) {
        const [column, row] = pending.pop().split(":").map(Number);
        [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([columnDelta, rowDelta]) => {
          const neighbor = `${column + columnDelta}:${row + rowDelta}`;
          if (high.delete(neighbor)) pending.push(neighbor);
        });
      }
    }
    return zones;
  }

  function analyze(inputStops, options = {}) {
    const stops = (inputStops || []).map(validStop).filter(Boolean);
    if (!stops.length) throw new Error("Agrega al menos un punto obligatorio válido para analizar la densidad.");
    const radiusMeters = Math.max(1, Number(options.radiusMeters) || DEFAULT_RADIUS_METERS);
    const cellSizeMeters = Math.max(1, Math.min(radiusMeters, Number(options.cellSizeMeters) || DEFAULT_CELL_SIZE_METERS));
    const referenceLat = stops.reduce((sum, stop) => sum + stop.lat, 0) / stops.length;
    const referenceLng = stops.reduce((sum, stop) => sum + stop.lng, 0) / stops.length;
    const longitudeScale = EARTH_METERS_PER_DEGREE * Math.max(0.05, Math.cos(referenceLat * Math.PI / 180));
    const projectedStops = stops.map(stop => ({
      ...stop,
      x: (stop.lng - referenceLng) * longitudeScale,
      y: (stop.lat - referenceLat) * EARTH_METERS_PER_DEGREE,
      weight: stop.frequency * (1 + stop.dwellMinutes / 60)
    }));
    const candidates = new Map();
    const cellReach = Math.ceil(radiusMeters / cellSizeMeters) + 1;
    projectedStops.forEach(stop => {
      const centerColumn = Math.floor(stop.x / cellSizeMeters);
      const centerRow = Math.floor(stop.y / cellSizeMeters);
      for (let column = centerColumn - cellReach; column <= centerColumn + cellReach; column += 1) {
        for (let row = centerRow - cellReach; row <= centerRow + cellReach; row += 1) {
          const centerX = (column + 0.5) * cellSizeMeters;
          const centerY = (row + 0.5) * cellSizeMeters;
          if (Math.hypot(centerX - stop.x, centerY - stop.y) <= radiusMeters + cellSizeMeters / Math.SQRT2) {
            candidates.set(`${column}:${row}`, { column, row, centerX, centerY });
          }
        }
      }
    });

    const rawCells = [...candidates.values()].map(cell => {
      let rawIntensity = 0;
      let pointsInInfluence = 0;
      let accumulatedFrequency = 0;
      let accumulatedDwell = 0;
      projectedStops.forEach(stop => {
        const distance = Math.hypot(cell.centerX - stop.x, cell.centerY - stop.y);
        if (distance > radiusMeters) return;
        const proximity = 1 - distance / radiusMeters;
        rawIntensity += stop.weight * proximity * proximity;
        pointsInInfluence += 1;
        accumulatedFrequency += stop.frequency;
        accumulatedDwell += stop.dwellMinutes;
      });
      return { ...cell, rawIntensity, pointsInInfluence, accumulatedFrequency, accumulatedDwell };
    }).filter(cell => cell.rawIntensity > 0);
    const maximumIntensity = Math.max(...rawCells.map(cell => cell.rawIntensity));
    const cells = rawCells.map(cell => ({
      ...cell,
      intensity: cell.rawIntensity / maximumIntensity,
      level: levelFor(cell.rawIntensity / maximumIntensity)
    }));

    const toCoordinate = (x, y) => [
      referenceLng + x / longitudeScale,
      referenceLat + y / EARTH_METERS_PER_DEGREE
    ];
    const features = cells.map(cell => {
      const minimumX = cell.column * cellSizeMeters;
      const minimumY = cell.row * cellSizeMeters;
      const maximumX = minimumX + cellSizeMeters;
      const maximumY = minimumY + cellSizeMeters;
      return {
        type: "Feature",
        geometry: {
          type: "Polygon",
          coordinates: [[
            toCoordinate(minimumX, minimumY),
            toCoordinate(maximumX, minimumY),
            toCoordinate(maximumX, maximumY),
            toCoordinate(minimumX, maximumY),
            toCoordinate(minimumX, minimumY)
          ]]
        },
        properties: {
          densidad_nivel: cell.level,
          valor_intensidad: Number(cell.intensity.toFixed(4)),
          puntos_influencia: cell.pointsInInfluence,
          frecuencia_acumulada: Number(cell.accumulatedFrequency.toFixed(2)),
          estancia_total_min: Number(cell.accumulatedDwell.toFixed(2)),
          radio_cobertura_m: radiusMeters,
          radio_cobertura_km: radiusMeters / 1000,
          tamano_celda_m: cellSizeMeters
        }
      };
    });
    const summary = {
      total_puntos_analizados: stops.length,
      zonas_alta_densidad: highDensityZones(cells),
      radio_cobertura_m: radiusMeters,
      radio_cobertura_km: radiusMeters / 1000,
      celdas_alta_densidad: cells.filter(cell => cell.level === "Alta").length,
      celdas_media_densidad: cells.filter(cell => cell.level === "Media").length,
      celdas_baja_densidad: cells.filter(cell => cell.level === "Baja").length
    };
    return {
      resumen_analisis: summary,
      capa_raster: { tipo: "FeatureCollection", type: "FeatureCollection", features },
      seccion_interfaz_usuario: {
        ubicacion_ui: "panel_cargue_ruta",
        componentes: [
          { tipo: "mapa_raster_preview", titulo: "Capa Ráster de Densidad (Radio 5 m)" },
          { tipo: "boton_descarga", label: "Descargar Capa Ráster (.geojson)", nombre_archivo: "capa_raster_densidad_5m.geojson", formato: "application/json" }
        ]
      }
    };
  }

  function downloadableGeoJSON(result) {
    return {
      type: "FeatureCollection",
      name: "capa_raster_densidad_5m",
      features: result?.capa_raster?.features || [],
      properties: { resumen_analisis: result?.resumen_analisis || {} }
    };
  }

  const api = { DEFAULT_RADIUS_METERS, DEFAULT_CELL_SIZE_METERS, analyze, downloadableGeoJSON, levelFor, stopsFromGeoJSON };
  global.DensityAnalysis = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window === "undefined" ? globalThis : window);

