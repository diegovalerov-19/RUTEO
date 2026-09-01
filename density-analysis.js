(function exposeDensityAnalysis(global) {
  "use strict";

  const DEFAULT_RADIUS_METERS = 5;
  const DEFAULT_CELL_SIZE_METERS = 1.25;
  const EARTH_METERS_PER_DEGREE = 111320;
  const DENSITY_COLORS = {
    "Sin concentración": "#ADEEC5",
    Baja: "#FFFB7D",
    Alta: "#FFB23C",
    "Muy alta": "#B73225"
  };

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
    if (intensity >= 0.72) return "Muy alta";
    if (intensity >= 0.42) return "Alta";
    if (intensity >= 0.08) return "Baja";
    return "Sin concentración";
  }

  function stopsFromGeoJSON(geojson) {
    const pointFeatures = (geojson?.features || []).map((feature, index) => ({ feature, index }))
      .filter(item => item.feature?.geometry?.type === "Point");
    const markedFeatures = pointFeatures.filter(item => item.feature?.properties?.role === "marked-point");
    return (markedFeatures.length ? markedFeatures : pointFeatures).sort((left, right) => {
      const leftOrder = Number(left.feature.properties?.order ?? left.feature.properties?.sequence ?? left.feature.properties?.secuencia);
      const rightOrder = Number(right.feature.properties?.order ?? right.feature.properties?.sequence ?? right.feature.properties?.secuencia);
      return (Number.isFinite(leftOrder) ? leftOrder : left.index) - (Number.isFinite(rightOrder) ? rightOrder : right.index);
    }).map((item, index) => ({
      lat: Number(item.feature.geometry.coordinates[1]),
      lng: Number(item.feature.geometry.coordinates[0]),
      label: String(item.feature.properties?.label || item.feature.properties?.name || `Punto fijo ${index + 1}`),
      frequency: Math.max(1, Number(item.feature.properties?.frequency ?? item.feature.properties?.frecuencia) || 1),
      dwellMinutes: Math.max(0, Number(item.feature.properties?.dwellMinutes ?? item.feature.properties?.estancia_min ?? item.feature.properties?.estanciaMinutos) || 0)
    })).filter(stop => Number.isFinite(stop.lat) && Number.isFinite(stop.lng));
  }

  function pathFromGeoJSON(geojson) {
    const features = geojson?.features || [];
    const routes = features.filter(feature => ["LineString", "MultiLineString"].includes(feature?.geometry?.type) && feature?.properties?.role === "route");
    const lines = routes.length ? routes : features.filter(feature => ["LineString", "MultiLineString"].includes(feature?.geometry?.type));
    const points = [];
    lines.forEach(feature => {
      const coordinateLines = feature.geometry.type === "LineString" ? [feature.geometry.coordinates] : feature.geometry.coordinates;
      coordinateLines.forEach(line => line.forEach(coordinate => {
        const lng = Number(coordinate?.[0]);
        const lat = Number(coordinate?.[1]);
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return;
        const previous = points.at(-1);
        if (!previous || previous.lat !== lat || previous.lng !== lng) points.push({ lat, lng });
      }));
    });
    return points;
  }

  function segmentPolygon(start, end, halfWidth, overlap, toCoordinate) {
    const deltaX = end.x - start.x;
    const deltaY = end.y - start.y;
    const length = Math.hypot(deltaX, deltaY);
    if (!length) return null;
    const unitX = deltaX / length;
    const unitY = deltaY / length;
    const perpendicularX = -unitY * halfWidth;
    const perpendicularY = unitX * halfWidth;
    const startX = start.x - unitX * overlap;
    const startY = start.y - unitY * overlap;
    const endX = end.x + unitX * overlap;
    const endY = end.y + unitY * overlap;
    return [[
      toCoordinate(startX + perpendicularX, startY + perpendicularY),
      toCoordinate(endX + perpendicularX, endY + perpendicularY),
      toCoordinate(endX - perpendicularX, endY - perpendicularY),
      toCoordinate(startX - perpendicularX, startY - perpendicularY),
      toCoordinate(startX + perpendicularX, startY + perpendicularY)
    ]];
  }

  function interpolationCorridor(projectedStops, inputPath, options) {
    if (projectedStops.length < 2) return { segments: [], totalLength: 0 };
    const path = (inputPath?.length >= 2 ? inputPath : projectedStops).map(point => ({
      x: Number.isFinite(point.x) ? point.x : (Number(point.lng) - options.referenceLng) * options.longitudeScale,
      y: Number.isFinite(point.y) ? point.y : (Number(point.lat) - options.referenceLat) * EARTH_METERS_PER_DEGREE
    })).filter(point => Number.isFinite(point.x) && Number.isFinite(point.y));
    if (path.length < 2) return { segments: [], totalLength: 0 };

    const distances = [0];
    for (let index = 1; index < path.length; index += 1) {
      distances.push(distances[index - 1] + Math.hypot(path[index].x - path[index - 1].x, path[index].y - path[index - 1].y));
    }

    let minimumPathIndex = 0;
    const stopPositions = projectedStops.map(stop => {
      let bestIndex = minimumPathIndex;
      let bestDistance = Infinity;
      for (let index = minimumPathIndex; index < path.length; index += 1) {
        const distance = Math.hypot(path[index].x - stop.x, path[index].y - stop.y);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = index;
        }
      }
      minimumPathIndex = bestIndex;
      return distances[bestIndex];
    });
    const firstPosition = stopPositions[0];
    const lastPosition = stopPositions.at(-1);
    const bandwidths = stopPositions.map((position, index) => {
      const before = index ? position - stopPositions[index - 1] : 0;
      const after = index < stopPositions.length - 1 ? stopPositions[index + 1] - position : 0;
      return Math.max(options.radiusMeters, Math.max(before, after) * 0.6);
    });
    const maximumSegments = Math.max(250, Number(options.maximumInterpolationSegments) || 2000);
    const routeSpan = Math.max(0, lastPosition - firstPosition);
    const minimumSegmentLength = routeSpan > 0 ? routeSpan / maximumSegments : 0;
    const segments = [];
    let pendingStart = null;
    let pendingLength = 0;

    const appendSegment = (start, end, startDistance, endDistance) => {
      const midpoint = (startDistance + endDistance) / 2;
      let rawIntensity = 0;
      let pointsInInfluence = 0;
      let accumulatedFrequency = 0;
      let accumulatedDwell = 0;
      projectedStops.forEach((stop, index) => {
        const proximity = Math.max(0, 1 - Math.abs(midpoint - stopPositions[index]) / bandwidths[index]);
        if (!proximity) return;
        rawIntensity += stop.weight * proximity;
        pointsInInfluence += 1;
        accumulatedFrequency += stop.frequency;
        accumulatedDwell += stop.dwellMinutes;
      });
      segments.push({ start, end, rawIntensity, pointsInInfluence, accumulatedFrequency, accumulatedDwell, midpoint });
    };

    for (let index = 1; index < path.length; index += 1) {
      const segmentStartDistance = distances[index - 1];
      const segmentEndDistance = distances[index];
      if (segmentEndDistance < firstPosition || segmentStartDistance > lastPosition) continue;
      const length = segmentEndDistance - segmentStartDistance;
      if (!length) continue;
      if (!pendingStart) pendingStart = path[index - 1];
      pendingLength += length;
      const shouldFlush = pendingLength >= minimumSegmentLength || index === path.length - 1 || segmentEndDistance >= lastPosition;
      if (shouldFlush) {
        const clampedStart = Math.max(firstPosition, segmentEndDistance - pendingLength);
        const clampedEnd = Math.min(lastPosition, segmentEndDistance);
        appendSegment(pendingStart, path[index], clampedStart, clampedEnd);
        pendingStart = null;
        pendingLength = 0;
      }
      if (segmentEndDistance >= lastPosition) break;
    }
    return { segments, totalLength: routeSpan };
  }

  function highDensityZones(cells) {
    const high = new Set(cells.filter(cell => cell.level === "Alta" || cell.level === "Muy alta").map(cell => `${cell.column}:${cell.row}`));
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

  function median(values) {
    const ordered = values.filter(value => Number.isFinite(value)).sort((left, right) => left - right);
    if (!ordered.length) return 0;
    const middle = Math.floor(ordered.length / 2);
    return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
  }

  function convexHull(points) {
    const ordered = [...points].sort((left, right) => left.x - right.x || left.y - right.y);
    if (ordered.length <= 2) return ordered;
    const cross = (origin, left, right) => (left.x - origin.x) * (right.y - origin.y) - (left.y - origin.y) * (right.x - origin.x);
    const lower = [];
    ordered.forEach(point => {
      while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), point) <= 0) lower.pop();
      lower.push(point);
    });
    const upper = [];
    [...ordered].reverse().forEach(point => {
      while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), point) <= 0) upper.pop();
      upper.push(point);
    });
    lower.pop();
    upper.pop();
    return [...lower, ...upper];
  }

  function distanceToSegment(point, start, end) {
    const deltaX = end.x - start.x;
    const deltaY = end.y - start.y;
    const lengthSquared = deltaX * deltaX + deltaY * deltaY;
    if (!lengthSquared) return Math.hypot(point.x - start.x, point.y - start.y);
    const progress = Math.max(0, Math.min(1, ((point.x - start.x) * deltaX + (point.y - start.y) * deltaY) / lengthSquared));
    return Math.hypot(point.x - (start.x + progress * deltaX), point.y - (start.y + progress * deltaY));
  }

  function pointInsidePolygon(point, polygon) {
    if (polygon.length < 3) return false;
    let inside = false;
    for (let current = 0, previous = polygon.length - 1; current < polygon.length; previous = current++) {
      const currentPoint = polygon[current];
      const previousPoint = polygon[previous];
      const intersects = ((currentPoint.y > point.y) !== (previousPoint.y > point.y))
        && point.x < (previousPoint.x - currentPoint.x) * (point.y - currentPoint.y) / (previousPoint.y - currentPoint.y) + currentPoint.x;
      if (intersects) inside = !inside;
    }
    return inside;
  }

  function insideBufferedHull(point, hull, padding) {
    if (hull.length === 1) return Math.hypot(point.x - hull[0].x, point.y - hull[0].y) <= padding;
    if (hull.length === 2) return distanceToSegment(point, hull[0], hull[1]) <= padding;
    if (pointInsidePolygon(point, hull)) return true;
    return hull.some((start, index) => distanceToSegment(point, start, hull[(index + 1) % hull.length]) <= padding);
  }

  function analyzeSurface(inputStops, options = {}) {
    const stops = (inputStops || []).map(validStop).filter(Boolean);
    if (!stops.length) throw new Error("Agrega al menos un punto obligatorio válido para analizar la densidad.");
    const referenceLat = stops.reduce((sum, stop) => sum + stop.lat, 0) / stops.length;
    const referenceLng = stops.reduce((sum, stop) => sum + stop.lng, 0) / stops.length;
    const longitudeScale = EARTH_METERS_PER_DEGREE * Math.max(0.05, Math.cos(referenceLat * Math.PI / 180));
    const projectedStops = stops.map(stop => ({
      ...stop,
      x: (stop.lng - referenceLng) * longitudeScale,
      y: (stop.lat - referenceLat) * EARTH_METERS_PER_DEGREE,
      weight: stop.frequency * (1 + stop.dwellMinutes / 60)
    }));
    const neighborDistances = projectedStops.map((stop, index) => Math.min(...projectedStops
      .filter((_, candidateIndex) => candidateIndex !== index)
      .map(candidate => Math.hypot(candidate.x - stop.x, candidate.y - stop.y))));
    const typicalSpacing = median(neighborDistances.filter(distance => Number.isFinite(distance) && distance > 0)) || 25;
    const paddingMeters = Math.max(1, typicalSpacing * 0.65);
    const hull = convexHull(projectedStops);
    const minimumX = Math.min(...hull.map(point => point.x)) - paddingMeters;
    const maximumX = Math.max(...hull.map(point => point.x)) + paddingMeters;
    const minimumY = Math.min(...hull.map(point => point.y)) - paddingMeters;
    const maximumY = Math.max(...hull.map(point => point.y)) + paddingMeters;
    const maximumCells = Math.max(500, Number(options.maximumCells) || 4500);
    const boundingArea = Math.max(1, (maximumX - minimumX) * (maximumY - minimumY));
    const cellSizeMeters = Math.max(1, Math.sqrt(boundingArea / maximumCells));
    const bandwidthMeters = Math.max(typicalSpacing * 1.5, cellSizeMeters * 3);
    const columns = Math.max(1, Math.ceil((maximumX - minimumX) / cellSizeMeters));
    const rows = Math.max(1, Math.ceil((maximumY - minimumY) / cellSizeMeters));
    const rawCells = [];

    for (let column = 0; column < columns; column += 1) {
      for (let row = 0; row < rows; row += 1) {
        const centerX = minimumX + (column + 0.5) * cellSizeMeters;
        const centerY = minimumY + (row + 0.5) * cellSizeMeters;
        if (!insideBufferedHull({ x: centerX, y: centerY }, hull, paddingMeters)) continue;
        let rawIntensity = 0;
        let pointsInInfluence = 0;
        let weightedFrequency = 0;
        let weightedDwell = 0;
        projectedStops.forEach(stop => {
          const distance = Math.hypot(centerX - stop.x, centerY - stop.y);
          const influence = Math.exp(-0.5 * (distance / bandwidthMeters) ** 2);
          rawIntensity += stop.weight * influence;
          if (influence >= 0.05) pointsInInfluence += 1;
          weightedFrequency += stop.frequency * influence;
          weightedDwell += stop.dwellMinutes * influence;
        });
        rawCells.push({ column, row, centerX, centerY, rawIntensity, pointsInInfluence, weightedFrequency, weightedDwell });
      }
    }

    if (!rawCells.length) throw new Error("No fue posible construir la superficie de interpolación con estos puntos.");
    const minimumIntensity = Math.min(...rawCells.map(cell => cell.rawIntensity));
    const maximumIntensity = Math.max(...rawCells.map(cell => cell.rawIntensity));
    const intensityRange = maximumIntensity - minimumIntensity;
    const cells = rawCells.map(cell => {
      const intensity = intensityRange > 0 ? (cell.rawIntensity - minimumIntensity) / intensityRange : 1;
      return { ...cell, intensity, level: levelFor(intensity) };
    });
    const toCoordinate = (x, y) => [
      referenceLng + x / longitudeScale,
      referenceLat + y / EARTH_METERS_PER_DEGREE
    ];
    const features = cells.map(cell => {
      const left = minimumX + cell.column * cellSizeMeters;
      const bottom = minimumY + cell.row * cellSizeMeters;
      const right = left + cellSizeMeters;
      const top = bottom + cellSizeMeters;
      return {
        type: "Feature",
        geometry: {
          type: "Polygon",
          coordinates: [[
            toCoordinate(left, bottom),
            toCoordinate(right, bottom),
            toCoordinate(right, top),
            toCoordinate(left, top),
            toCoordinate(left, bottom)
          ]]
        },
        properties: {
          tipo_elemento: "celda_superficie_interpolada",
          densidad_nivel: cell.level,
          color_hex: DENSITY_COLORS[cell.level],
          valor_intensidad: Number(cell.intensity.toFixed(4)),
          puntos_influencia: cell.pointsInInfluence,
          frecuencia_ponderada: Number(cell.weightedFrequency.toFixed(3)),
          estancia_ponderada_min: Number(cell.weightedDwell.toFixed(3)),
          tamano_celda_m: Number(cellSizeMeters.toFixed(2)),
          ancho_banda_interpolacion_m: Number(bandwidthMeters.toFixed(2)),
          extension_automatica: true
        }
      };
    });
    const summary = {
      total_puntos_analizados: stops.length,
      zonas_alta_densidad: highDensityZones(cells),
      radio_cobertura_m: null,
      radio_cobertura_km: null,
      restriccion_radio: false,
      metodo_interpolacion: "densidad kernel gaussiana adaptativa sobre todos los puntos fijos",
      paleta_colores: { ...DENSITY_COLORS },
      celdas_generadas: cells.length,
      tamano_celda_m: Number(cellSizeMeters.toFixed(2)),
      ancho_banda_interpolacion_m: Number(bandwidthMeters.toFixed(2)),
      separacion_tipica_puntos_m: Number(typicalSpacing.toFixed(2)),
      area_modelada_m2: Number((cells.length * cellSizeMeters * cellSizeMeters).toFixed(2)),
      celdas_alta_densidad: cells.filter(cell => cell.level === "Alta").length,
      celdas_muy_alta_densidad: cells.filter(cell => cell.level === "Muy alta").length,
      celdas_baja_densidad: cells.filter(cell => cell.level === "Baja").length,
      celdas_sin_concentracion: cells.filter(cell => cell.level === "Sin concentración").length
    };
    return {
      resumen_analisis: summary,
      capa_raster: { tipo: "FeatureCollection", type: "FeatureCollection", features },
      seccion_interfaz_usuario: {
        ubicacion_ui: "panel_cargue_ruta",
        componentes: [
          { tipo: "mapa_raster_preview", titulo: "Superficie Ráster de Densidad" },
          { tipo: "boton_descarga", label: "Descargar Capa Ráster (.geojson)", nombre_archivo: "capa_raster_densidad.geojson", formato: "application/json" }
        ]
      }
    };
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
    const displayRadiusMeters = radiusMeters + cellSizeMeters;
    const cellReach = Math.ceil(displayRadiusMeters / cellSizeMeters) + 1;
    projectedStops.forEach(stop => {
      const centerColumn = Math.floor(stop.x / cellSizeMeters);
      const centerRow = Math.floor(stop.y / cellSizeMeters);
      for (let column = centerColumn - cellReach; column <= centerColumn + cellReach; column += 1) {
        for (let row = centerRow - cellReach; row <= centerRow + cellReach; row += 1) {
          const centerX = (column + 0.5) * cellSizeMeters;
          const centerY = (row + 0.5) * cellSizeMeters;
          if (Math.hypot(centerX - stop.x, centerY - stop.y) <= displayRadiusMeters) {
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
        rawIntensity += stop.weight * proximity;
        pointsInInfluence += 1;
        accumulatedFrequency += stop.frequency;
        accumulatedDwell += stop.dwellMinutes;
      });
      return { ...cell, rawIntensity, pointsInInfluence, accumulatedFrequency, accumulatedDwell };
    });
    const maximumIntensity = Math.max(0, ...rawCells.map(cell => cell.rawIntensity));

    const toCoordinate = (x, y) => [
      referenceLng + x / longitudeScale,
      referenceLat + y / EARTH_METERS_PER_DEGREE
    ];
    const corridor = interpolationCorridor(projectedStops, options.interpolationPath, {
      referenceLat,
      referenceLng,
      longitudeScale,
      radiusMeters,
      maximumInterpolationSegments: options.maximumInterpolationSegments
    });
    const corridorMaximumIntensity = Math.max(0, ...corridor.segments.map(segment => segment.rawIntensity));
    const combinedMaximumIntensity = Math.max(maximumIntensity, corridorMaximumIntensity);
    const normalizedCells = rawCells.map(cell => ({
      ...cell,
      intensity: combinedMaximumIntensity > 0 ? cell.rawIntensity / combinedMaximumIntensity : 0,
      level: levelFor(combinedMaximumIntensity > 0 ? cell.rawIntensity / combinedMaximumIntensity : 0)
    }));
    const outerCorridorFeatures = [];
    const interpolatedCorridorFeatures = [];
    corridor.segments.forEach((segment, index) => {
      const outerGeometry = segmentPolygon(segment.start, segment.end, displayRadiusMeters, cellSizeMeters * 0.75, toCoordinate);
      const innerGeometry = segmentPolygon(segment.start, segment.end, radiusMeters, cellSizeMeters * 0.75, toCoordinate);
      if (!outerGeometry || !innerGeometry) return;
      outerCorridorFeatures.push({
        type: "Feature",
        geometry: { type: "Polygon", coordinates: outerGeometry },
        properties: {
          tipo_elemento: "borde_interpolacion",
          densidad_nivel: "Sin concentración",
          color_hex: DENSITY_COLORS["Sin concentración"],
          valor_intensidad: 0,
          radio_cobertura_m: displayRadiusMeters,
          tamano_celda_m: cellSizeMeters,
          orden_segmento: index + 1
        }
      });
      const intensity = combinedMaximumIntensity > 0 ? segment.rawIntensity / combinedMaximumIntensity : 0;
      const level = levelFor(intensity);
      interpolatedCorridorFeatures.push({
        type: "Feature",
        geometry: { type: "Polygon", coordinates: innerGeometry },
        properties: {
          tipo_elemento: "interpolacion_entre_puntos",
          densidad_nivel: level,
          color_hex: DENSITY_COLORS[level],
          valor_intensidad: Number(intensity.toFixed(4)),
          puntos_influencia: segment.pointsInInfluence,
          frecuencia_acumulada: Number(segment.accumulatedFrequency.toFixed(2)),
          estancia_total_min: Number(segment.accumulatedDwell.toFixed(2)),
          radio_cobertura_m: radiusMeters,
          tamano_celda_m: cellSizeMeters,
          orden_segmento: index + 1
        }
      });
    });
    const cellFeatures = normalizedCells.map(cell => {
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
          tipo_elemento: "celda_punto_fijo",
          densidad_nivel: cell.level,
          color_hex: DENSITY_COLORS[cell.level],
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
    const features = [...outerCorridorFeatures, ...interpolatedCorridorFeatures, ...cellFeatures];
    const summary = {
      total_puntos_analizados: stops.length,
      zonas_alta_densidad: highDensityZones(normalizedCells),
      radio_cobertura_m: radiusMeters,
      radio_cobertura_km: radiusMeters / 1000,
      metodo_interpolacion: "núcleo lineal continuo entre todos los puntos fijos",
      paleta_colores: { ...DENSITY_COLORS },
      celdas_generadas: normalizedCells.length,
      segmentos_interpolados: interpolatedCorridorFeatures.length,
      longitud_interpolada_m: Number(corridor.totalLength.toFixed(2)),
      celdas_alta_densidad: normalizedCells.filter(cell => cell.level === "Alta").length,
      celdas_muy_alta_densidad: normalizedCells.filter(cell => cell.level === "Muy alta").length,
      celdas_baja_densidad: normalizedCells.filter(cell => cell.level === "Baja").length,
      celdas_sin_concentracion: normalizedCells.filter(cell => cell.level === "Sin concentración").length
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
      name: "capa_raster_densidad",
      features: result?.capa_raster?.features || [],
      properties: { resumen_analisis: result?.resumen_analisis || {} }
    };
  }

  const api = { DEFAULT_RADIUS_METERS, DEFAULT_CELL_SIZE_METERS, DENSITY_COLORS, analyze: analyzeSurface, downloadableGeoJSON, levelFor, pathFromGeoJSON, stopsFromGeoJSON };
  global.DensityAnalysis = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window === "undefined" ? globalThis : window);

