(function exposeRouteImport(global) {
  "use strict";

  const TARGET_CRS = "EPSG:4326";
  const MAX_FILE_SIZE = 50 * 1024 * 1024;
  const LIBRARY_URLS = Object.freeze({
    xlsx: "https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs",
    shp: "https://cdn.jsdelivr.net/npm/shpjs@6.2.0/+esm",
    proj4: "https://cdn.jsdelivr.net/npm/proj4@2.21.0/+esm",
    fflate: "https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js"
  });
  const libraryPromises = new Map();

  async function loadLibrary(name, dependencies = {}) {
    if (dependencies[name]) return dependencies[name];
    if (!LIBRARY_URLS[name]) throw new Error(`No existe una librería configurada para ${name}.`);
    if (!libraryPromises.has(name)) libraryPromises.set(name, import(LIBRARY_URLS[name]));
    const module = await libraryPromises.get(name);
    if (name === "shp" || name === "proj4") return module.default || module;
    return module;
  }

  function fileExtension(name = "") {
    const match = String(name).toLowerCase().match(/\.([a-z0-9]+)$/);
    return match ? match[1] : "";
  }

  function createReport(sourceName, format, sourceCrs = TARGET_CRS) {
    return { sourceName, format, sourceCrs, targetCrs: TARGET_CRS, processed: 0, failed: 0, errors: [] };
  }

  function addError(report, record, message) {
    report.failed += 1;
    if (report.errors.length < 30) report.errors.push({ record, message });
  }

  function validWgs84([lng, lat]) {
    return Number.isFinite(lng) && Number.isFinite(lat) && lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90;
  }

  function parseNumber(value) {
    if (typeof value === "number") return value;
    const text = String(value ?? "").trim();
    if (!text) return NaN;
    return Number(text.includes(",") && !text.includes(".") ? text.replace(",", ".") : text);
  }

  function normalizeCrsName(value) {
    const raw = String(value || "").trim();
    if (!raw || /^auto$/i.test(raw) || /CRS:?84/i.test(raw)) return TARGET_CRS;
    if (/^(?:PROJCS|GEOGCS|PROJCRS|GEODCRS)\s*\[/i.test(raw) || raw.startsWith("+proj=")) return raw;
    if (/^\d+$/.test(raw)) return `EPSG:${raw}`;
    const epsg = raw.match(/EPSG(?:\s*[:/]\s*|::)(\d+)/i);
    return epsg ? `EPSG:${epsg[1]}` : raw;
  }

  function detectedGeoJsonCrs(data) {
    return data?.crs?.properties?.name || data?.crs?.properties?.href || data?.crs?.name || "";
  }

  async function createTransformer(sourceCrs, dependencies = {}) {
    const normalized = normalizeCrsName(sourceCrs);
    if (normalized === TARGET_CRS) return { sourceCrs: TARGET_CRS, transform: coordinate => coordinate.slice() };
    const proj4 = await loadLibrary("proj4", dependencies);
    if (/^EPSG:\d+$/i.test(normalized) && typeof proj4.defs === "function" && !proj4.defs(normalized)) {
      const code = normalized.split(":")[1];
      const fetchFn = dependencies.fetchFn || global.fetch?.bind(global);
      if (typeof fetchFn !== "function") throw new Error(`No fue posible obtener la definición ${normalized}.`);
      const response = await fetchFn(`https://epsg.io/${code}.proj4`);
      const definition = response?.ok ? (await response.text()).trim() : "";
      if (!definition) throw new Error(`No se encontró una definición válida para ${normalized}.`);
      proj4.defs(normalized, definition);
    }
    return {
      sourceCrs: normalized,
      transform: coordinate => proj4(normalized, TARGET_CRS, coordinate)
    };
  }

  function detectDelimiter(text) {
    const firstLine = String(text).replace(/^\uFEFF/, "").split(/\r?\n/).find(line => line.trim()) || "";
    const candidates = [",", ";", "\t"];
    let quoted = false;
    const counts = Object.fromEntries(candidates.map(delimiter => [delimiter, 0]));
    for (let index = 0; index < firstLine.length; index += 1) {
      if (firstLine[index] === '"') quoted = !quoted;
      else if (!quoted && candidates.includes(firstLine[index])) counts[firstLine[index]] += 1;
    }
    return candidates.sort((left, right) => counts[right] - counts[left])[0];
  }

  function tableFromMatrix(matrix) {
    const nonEmpty = (Array.isArray(matrix) ? matrix : []).filter(row => Array.isArray(row) && row.some(value => String(value ?? "").trim()));
    if (!nonEmpty.length) throw new Error("El archivo tabular está vacío.");
    const used = new Set();
    const headers = nonEmpty[0].map((value, index) => {
      const base = String(value ?? "").trim() || `columna_${index + 1}`;
      let header = base;
      let suffix = 2;
      while (used.has(header)) header = `${base}_${suffix++}`;
      used.add(header);
      return header;
    });
    const rows = nonEmpty.slice(1).map(values => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
    return { headers, rows };
  }

  function parseCsv(text) {
    const source = String(text).replace(/^\uFEFF/, "");
    const delimiter = detectDelimiter(source);
    const matrix = [];
    let row = [];
    let cell = "";
    let quoted = false;
    for (let index = 0; index < source.length; index += 1) {
      const character = source[index];
      if (character === '"') {
        if (quoted && source[index + 1] === '"') { cell += '"'; index += 1; }
        else quoted = !quoted;
      } else if (character === delimiter && !quoted) {
        row.push(cell); cell = "";
      } else if ((character === "\n" || character === "\r") && !quoted) {
        if (character === "\r" && source[index + 1] === "\n") index += 1;
        row.push(cell); matrix.push(row); row = []; cell = "";
      } else cell += character;
    }
    if (cell.length || row.length) { row.push(cell); matrix.push(row); }
    return { ...tableFromMatrix(matrix), delimiter };
  }

  async function parseExcel(arrayBuffer, dependencies = {}) {
    const XLSX = await loadLibrary("xlsx", dependencies);
    const workbook = XLSX.read(arrayBuffer);
    const sheetName = workbook.SheetNames?.[0];
    if (!sheetName) throw new Error("El libro de Excel no contiene hojas.");
    return { ...tableFromMatrix(XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: "", raw: false })), sheetName };
  }

  function suggestedMapping(headers) {
    const normalized = headers.map(header => String(header).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, ""));
    const find = candidates => {
      const index = normalized.findIndex(header => candidates.includes(header));
      return index >= 0 ? headers[index] : "";
    };
    return {
      latitude: find(["latitud", "latitude", "lat", "y"]),
      longitude: find(["longitud", "longitude", "lon", "lng", "x"]),
      label: find(["etiqueta", "label", "nombre", "name", "descripcion", "direccion"]),
      order: find(["orden", "order", "secuencia", "sequence", "id"])
    };
  }

  async function tableToGeoJSON(table, mapping, options = {}) {
    if (!mapping?.latitude || !mapping?.longitude) throw new Error("Selecciona las columnas de latitud y longitud.");
    const sourceName = options.sourceName || "tabla";
    const format = options.format || "CSV";
    const transformer = await createTransformer(options.sourceCrs || TARGET_CRS, options.dependencies);
    const report = createReport(sourceName, format, transformer.sourceCrs);
    const features = [];
    table.rows.forEach((row, index) => {
      const x = parseNumber(row[mapping.longitude]);
      const y = parseNumber(row[mapping.latitude]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return addError(report, index + 2, "Coordenadas vacías o no numéricas.");
      let coordinate;
      try { coordinate = transformer.transform([x, y]); }
      catch { return addError(report, index + 2, "No fue posible reproyectar las coordenadas."); }
      if (!validWgs84(coordinate)) return addError(report, index + 2, "Latitud o longitud fuera del rango WGS84.");
      const rawOrder = mapping.order ? parseNumber(row[mapping.order]) : NaN;
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [coordinate[0], coordinate[1]] },
        properties: {
          label: mapping.label ? String(row[mapping.label] ?? "").trim() : `Punto ${index + 1}`,
          order: Number.isFinite(rawOrder) ? rawOrder : index + 1,
          sourceRow: index + 2
        }
      });
      report.processed += 1;
    });
    return { geojson: { type: "FeatureCollection", features, importReport: report }, report };
  }

  function sourceFeatures(data) {
    if (Array.isArray(data)) return data.flatMap(sourceFeatures);
    if (data?.type === "FeatureCollection") return Array.isArray(data.features) ? data.features : [];
    if (data?.type === "Feature") return [data];
    if (["Point", "LineString", "MultiLineString"].includes(data?.type)) return [{ type: "Feature", properties: {}, geometry: data }];
    return [];
  }

  async function normalizeGeoJSON(data, options = {}) {
    const sourceName = options.sourceName || "geometría";
    const format = options.format || "GeoJSON";
    const declaredCrs = options.sourceCrs && !/^auto$/i.test(options.sourceCrs) ? options.sourceCrs : detectedGeoJsonCrs(data) || TARGET_CRS;
    const transformer = await createTransformer(declaredCrs, options.dependencies);
    const report = createReport(sourceName, format, transformer.sourceCrs);
    const features = [];

    function position(value, record) {
      if (!Array.isArray(value) || value.length < 2) { addError(report, record, "Coordenada incompleta."); return null; }
      const raw = [Number(value[0]), Number(value[1])];
      if (!raw.every(Number.isFinite)) { addError(report, record, "Coordenada no numérica."); return null; }
      let transformed;
      try { transformed = transformer.transform(raw); }
      catch { addError(report, record, "No fue posible reproyectar la coordenada."); return null; }
      if (!validWgs84(transformed)) { addError(report, record, "Latitud o longitud fuera del rango WGS84."); return null; }
      return value.length > 2 ? [transformed[0], transformed[1], ...value.slice(2)] : [transformed[0], transformed[1]];
    }

    sourceFeatures(data).forEach((feature, featureIndex) => {
      const geometry = feature?.geometry;
      const record = `geometría ${featureIndex + 1}`;
      if (!geometry || !["Point", "LineString", "MultiLineString"].includes(geometry.type)) {
        return addError(report, record, `Tipo ${geometry?.type || "vacío"} no compatible.`);
      }
      let normalizedGeometry = null;
      if (geometry.type === "Point") {
        const coordinate = position(geometry.coordinates, record);
        if (coordinate) normalizedGeometry = { type: "Point", coordinates: coordinate };
      } else if (geometry.type === "LineString") {
        const coordinates = (geometry.coordinates || []).map((value, index) => position(value, `${record}, vértice ${index + 1}`)).filter(Boolean);
        if (coordinates.length >= 2) normalizedGeometry = { type: "LineString", coordinates };
        else addError(report, record, "La línea no conserva al menos dos coordenadas válidas.");
      } else {
        const lines = (geometry.coordinates || []).map((line, lineIndex) => (line || []).map((value, index) => position(value, `${record}, línea ${lineIndex + 1}, vértice ${index + 1}`)).filter(Boolean)).filter(line => line.length >= 2);
        if (lines.length) normalizedGeometry = { type: "MultiLineString", coordinates: lines };
        else addError(report, record, "La geometría múltiple no contiene líneas válidas.");
      }
      if (!normalizedGeometry) return;
      features.push({ type: "Feature", properties: { ...(feature.properties || {}) }, geometry: normalizedGeometry });
      report.processed += 1;
    });
    return { geojson: { type: "FeatureCollection", features, importReport: report }, report };
  }

  function xmlEntities(value = "") {
    return String(value).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  }

  function tagText(xml, name) {
    const match = String(xml).match(new RegExp(`<(?:[\\w.-]+:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${name}>`, "i"));
    return match ? xmlEntities(match[1].replace(/<[^>]+>/g, "").trim()) : "";
  }

  function tagBlocks(xml, name) {
    return [...String(xml).matchAll(new RegExp(`<(?:[\\w.-]+:)?${name}\\b([^>]*)>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${name}>`, "gi"))];
  }

  function pointTags(xml, name) {
    return [...String(xml).matchAll(new RegExp(`<(?:[\\w.-]+:)?${name}\\b([^>]*)>`, "gi"))];
  }

  function attribute(attributes, name) {
    const match = String(attributes).match(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, "i"));
    return match ? match[1] : "";
  }

  async function parseGpx(text, options = {}) {
    const features = [];
    pointTags(text, "wpt").forEach((match, index) => {
      const lat = parseNumber(attribute(match[1], "lat"));
      const lng = parseNumber(attribute(match[1], "lon"));
      features.push({ type: "Feature", geometry: { type: "Point", coordinates: [lng, lat] }, properties: { label: `Punto GPX ${index + 1}`, order: index + 1 } });
    });
    tagBlocks(text, "trkseg").forEach((segment, index) => {
      const coordinates = pointTags(segment[2], "trkpt").map(match => [parseNumber(attribute(match[1], "lon")), parseNumber(attribute(match[1], "lat"))]);
      features.push({ type: "Feature", geometry: { type: "LineString", coordinates }, properties: { label: `Track ${index + 1}` } });
    });
    tagBlocks(text, "rte").forEach((route, index) => {
      const coordinates = pointTags(route[2], "rtept").map(match => [parseNumber(attribute(match[1], "lon")), parseNumber(attribute(match[1], "lat"))]);
      features.push({ type: "Feature", geometry: { type: "LineString", coordinates }, properties: { label: tagText(route[2], "name") || `Ruta ${index + 1}` } });
    });
    return normalizeGeoJSON({ type: "FeatureCollection", features }, { ...options, format: "GPX", sourceCrs: TARGET_CRS });
  }

  function kmlCoordinates(value) {
    return String(value).trim().split(/\s+/).map(item => item.split(",").map(Number)).filter(coordinate => coordinate.length >= 2);
  }

  async function parseKml(text, options = {}) {
    const features = [];
    tagBlocks(text, "Placemark").forEach((placemark, index) => {
      const name = tagText(placemark[2], "name") || `Elemento ${index + 1}`;
      const points = tagBlocks(placemark[2], "Point").map(block => kmlCoordinates(tagText(block[2], "coordinates"))[0]).filter(Boolean);
      points.forEach((coordinates, pointIndex) => features.push({ type: "Feature", geometry: { type: "Point", coordinates }, properties: { label: points.length > 1 ? `${name} ${pointIndex + 1}` : name, order: features.length + 1 } }));
      const lines = tagBlocks(placemark[2], "LineString").map(block => kmlCoordinates(tagText(block[2], "coordinates"))).filter(line => line.length);
      if (lines.length === 1) features.push({ type: "Feature", geometry: { type: "LineString", coordinates: lines[0] }, properties: { label: name } });
      else if (lines.length > 1) features.push({ type: "Feature", geometry: { type: "MultiLineString", coordinates: lines }, properties: { label: name } });
    });
    return normalizeGeoJSON({ type: "FeatureCollection", features }, { ...options, format: options.format || "KML", sourceCrs: TARGET_CRS });
  }

  async function parseKmz(arrayBuffer, options = {}) {
    const fflate = await loadLibrary("fflate", options.dependencies);
    const files = fflate.unzipSync(new Uint8Array(arrayBuffer));
    const kmlName = Object.keys(files).find(name => name.toLowerCase().endsWith(".kml"));
    if (!kmlName) throw new Error("El archivo KMZ no contiene un documento KML.");
    return parseKml(new TextDecoder().decode(files[kmlName]), { ...options, format: "KMZ" });
  }

  function validateShapefileParts(files) {
    const groups = new Map();
    Object.keys(files).forEach(name => {
      const normalized = name.toLowerCase();
      const extension = normalized.match(/\.(shp|dbf|shx|prj)$/)?.[1];
      if (!extension) return;
      const base = normalized.replace(/\.(shp|dbf|shx|prj)$/, "");
      if (!groups.has(base)) groups.set(base, new Set());
      groups.get(base).add(extension);
    });
    const complete = [...groups.values()].some(parts => ["shp", "dbf", "shx", "prj"].every(extension => parts.has(extension)));
    if (!complete) throw new Error("El ZIP debe contener archivos .shp, .dbf, .shx y .prj con el mismo nombre base.");
  }

  async function parseShapefile(arrayBuffer, options = {}) {
    const fflate = await loadLibrary("fflate", options.dependencies);
    validateShapefileParts(fflate.unzipSync(new Uint8Array(arrayBuffer)));
    const shp = await loadLibrary("shp", options.dependencies);
    const data = await shp(arrayBuffer);
    return normalizeGeoJSON(data, { ...options, format: "Shapefile", sourceCrs: TARGET_CRS });
  }

  async function readFile(file, options = {}) {
    if (!file) throw new Error("Selecciona un archivo.");
    if (file.size > (options.maxFileSize || MAX_FILE_SIZE)) throw new Error("El archivo supera el límite de 50 MB para procesamiento en el dispositivo.");
    const extension = fileExtension(file.name);
    if (extension === "csv") return { kind: "table", format: "CSV", table: parseCsv(await file.text()) };
    if (extension === "xlsx") return { kind: "table", format: "Excel", table: await parseExcel(await file.arrayBuffer(), options.dependencies) };
    if (extension === "geojson" || extension === "json") return { kind: "geojson", ...(await normalizeGeoJSON(JSON.parse(await file.text()), { ...options, sourceName: file.name, format: "GeoJSON" })) };
    if (extension === "gpx") return { kind: "geojson", ...(await parseGpx(await file.text(), { ...options, sourceName: file.name })) };
    if (extension === "kml") return { kind: "geojson", ...(await parseKml(await file.text(), { ...options, sourceName: file.name })) };
    if (extension === "kmz") return { kind: "geojson", ...(await parseKmz(await file.arrayBuffer(), { ...options, sourceName: file.name })) };
    if (extension === "zip") return { kind: "geojson", ...(await parseShapefile(await file.arrayBuffer(), { ...options, sourceName: file.name })) };
    throw new Error("Formato no compatible. Usa CSV, XLSX, ZIP Shapefile, GeoJSON, GPX, KML o KMZ.");
  }

  function routingStops(geojson, options = {}) {
    const maxStops = Math.max(2, Number(options.maxStops) || 10);
    const pointFeatures = (geojson?.features || []).map((feature, index) => ({ feature, index })).filter(item => item.feature?.geometry?.type === "Point");
    if (pointFeatures.length >= 2) {
      if (pointFeatures.length > maxStops) throw new Error(`El planificador admite hasta ${maxStops} paradas por ruta. El archivo contiene ${pointFeatures.length}.`);
      const stops = pointFeatures.sort((left, right) => {
        const leftOrder = Number(left.feature.properties?.order);
        const rightOrder = Number(right.feature.properties?.order);
        return (Number.isFinite(leftOrder) ? leftOrder : left.index) - (Number.isFinite(rightOrder) ? rightOrder : right.index);
      }).map((item, index) => ({
        lng: item.feature.geometry.coordinates[0],
        lat: item.feature.geometry.coordinates[1],
        label: String(item.feature.properties?.label || item.feature.properties?.name || `Punto importado ${index + 1}`)
      }));
      return { stops, source: "points", sampled: false };
    }

    const vertices = [];
    (geojson?.features || []).forEach(feature => {
      const geometry = feature?.geometry;
      const lines = geometry?.type === "LineString" ? [geometry.coordinates] : geometry?.type === "MultiLineString" ? geometry.coordinates : [];
      lines.forEach(line => line.forEach(coordinate => {
        const point = { lng: coordinate[0], lat: coordinate[1] };
        const previous = vertices.at(-1);
        if (!previous || previous.lng !== point.lng || previous.lat !== point.lat) vertices.push(point);
      }));
    });
    if (vertices.length < 2) throw new Error("El archivo necesita al menos dos puntos o una línea válida para crear una ruta.");
    const sampled = vertices.length > maxStops;
    const selected = sampled
      ? Array.from({ length: maxStops }, (_, index) => vertices[Math.round(index * (vertices.length - 1) / (maxStops - 1))])
      : vertices;
    return { stops: selected.map((point, index) => ({ ...point, label: `Punto importado ${index + 1}` })), source: "geometry", sampled };
  }

  const api = {
    TARGET_CRS,
    MAX_FILE_SIZE,
    LIBRARY_URLS,
    fileExtension,
    validWgs84,
    normalizeCrsName,
    detectDelimiter,
    parseCsv,
    parseExcel,
    suggestedMapping,
    tableToGeoJSON,
    normalizeGeoJSON,
    parseGpx,
    parseKml,
    parseKmz,
    parseShapefile,
    validateShapefileParts,
    readFile,
    routingStops
  };

  global.RouteImport = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window === "undefined" ? globalThis : window);
