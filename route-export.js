(function (global) {
  "use strict";

  const textEncoder = new TextEncoder();

  function routePoints(route) {
    return (route?.points || []).filter(point => Number.isFinite(point?.lat) && Number.isFinite(point?.lng));
  }

  function routeName(route) {
    return route.type === "recorded" ? route.name : `${route.start} - ${route.end}`;
  }

  function safeBaseName(value) {
    return String(value || "recorrido")
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "recorrido";
  }

  function csvCell(value) {
    const text = value === null || value === undefined ? "" : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function buildCsv(route) {
    const headers = ["recorrido", "tipo", "secuencia", "latitud", "longitud", "fecha_hora", "precision_m", "altitud_m", "velocidad_m_s"];
    const rows = routePoints(route).map((point, index) => [
      routeName(route), route.type === "recorded" ? "GPS" : "PLANIFICADA", index + 1,
      Number(point.lat).toFixed(7), Number(point.lng).toFixed(7), point.timestamp || "",
      point.accuracy ?? "", point.altitude ?? "", point.speed ?? ""
    ]);
    return `\uFEFF${[headers, ...rows].map(row => row.map(csvCell).join(",")).join("\r\n")}`;
  }

  function xmlEscape(value) {
    return String(value ?? "").replace(/[&<>'"]/g, character => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&apos;", '"': "&quot;"
    })[character]);
  }

  function buildKml(route) {
    const points = routePoints(route);
    const coordinates = points.map(point => `${Number(point.lng).toFixed(7)},${Number(point.lat).toFixed(7)},${Number(point.altitude) || 0}`).join("\n          ");
    const startedAt = route.startedAt || (route.date && route.time ? `${route.date}T${route.time}:00` : "");
    const distanceMeters = route.distanceMeters ?? (Number(route.distanceKm) * 1000);
    return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${xmlEscape(routeName(route))}</name>
    <Style id="ruta-upc"><LineStyle><color>ff1306e3</color><width>5</width></LineStyle></Style>
    <Placemark>
      <name>${xmlEscape(routeName(route))}</name>
      <description>${xmlEscape(`Tipo: ${route.type === "recorded" ? "GPS" : "Planificada"}`)}</description>
      <ExtendedData>
        <Data name="fecha_hora"><value>${xmlEscape(startedAt)}</value></Data>
        <Data name="distancia_m"><value>${Number.isFinite(distanceMeters) ? Math.round(distanceMeters) : ""}</value></Data>
        <Data name="puntos"><value>${points.length}</value></Data>
      </ExtendedData>
      <styleUrl>#ruta-upc</styleUrl>
      <LineString><tessellate>1</tessellate><altitudeMode>clampToGround</altitudeMode>
        <coordinates>
          ${coordinates}
        </coordinates>
      </LineString>
    </Placemark>
  </Document>
</kml>`;
  }

  function writeShapeHeader(view, fileLengthWords, bounds) {
    view.setInt32(0, 9994, false);
    view.setInt32(24, fileLengthWords, false);
    view.setInt32(28, 1000, true);
    view.setInt32(32, 3, true);
    view.setFloat64(36, bounds.xmin, true);
    view.setFloat64(44, bounds.ymin, true);
    view.setFloat64(52, bounds.xmax, true);
    view.setFloat64(60, bounds.ymax, true);
  }

  function buildShpFiles(route) {
    const points = routePoints(route);
    if (points.length < 2) throw new Error("La ruta necesita al menos dos coordenadas para crear un Shapefile.");
    const bounds = {
      xmin: Math.min(...points.map(point => point.lng)),
      ymin: Math.min(...points.map(point => point.lat)),
      xmax: Math.max(...points.map(point => point.lng)),
      ymax: Math.max(...points.map(point => point.lat))
    };
    const contentLength = 48 + points.length * 16;
    const shp = new ArrayBuffer(108 + contentLength);
    const shpView = new DataView(shp);
    writeShapeHeader(shpView, shp.byteLength / 2, bounds);
    shpView.setInt32(100, 1, false);
    shpView.setInt32(104, contentLength / 2, false);
    shpView.setInt32(108, 3, true);
    shpView.setFloat64(112, bounds.xmin, true);
    shpView.setFloat64(120, bounds.ymin, true);
    shpView.setFloat64(128, bounds.xmax, true);
    shpView.setFloat64(136, bounds.ymax, true);
    shpView.setInt32(144, 1, true);
    shpView.setInt32(148, points.length, true);
    shpView.setInt32(152, 0, true);
    points.forEach((point, index) => {
      shpView.setFloat64(156 + index * 16, point.lng, true);
      shpView.setFloat64(164 + index * 16, point.lat, true);
    });

    const shx = new ArrayBuffer(108);
    const shxView = new DataView(shx);
    writeShapeHeader(shxView, shx.byteLength / 2, bounds);
    shxView.setInt32(100, 50, false);
    shxView.setInt32(104, contentLength / 2, false);

    const startedAt = route.startedAt || (route.date && route.time ? `${route.date} ${route.time}` : "");
    const distanceKm = route.distanceKm ?? ((route.distanceMeters || 0) / 1000);
    const durationMin = route.durationMin ?? ((route.durationMilliseconds || 0) / 60000);
    const fields = [
      { name: "NOMBRE", type: "C", length: 80, decimals: 0, value: routeName(route) },
      { name: "TIPO", type: "C", length: 12, decimals: 0, value: route.type === "recorded" ? "GPS" : "PLANIFICADA" },
      { name: "FECHA_HORA", type: "C", length: 24, decimals: 0, value: startedAt },
      { name: "DIST_KM", type: "N", length: 12, decimals: 3, value: Number(distanceKm || 0).toFixed(3) },
      { name: "DUR_MIN", type: "N", length: 12, decimals: 2, value: Number(durationMin || 0).toFixed(2) },
      { name: "PUNTOS", type: "N", length: 8, decimals: 0, value: String(points.length) }
    ];
    const headerLength = 32 + fields.length * 32 + 1;
    const recordLength = 1 + fields.reduce((sum, field) => sum + field.length, 0);
    const dbf = new Uint8Array(headerLength + recordLength + 1);
    const dbfView = new DataView(dbf.buffer);
    const today = new Date();
    dbf[0] = 0x03;
    dbf[1] = today.getFullYear() - 1900;
    dbf[2] = today.getMonth() + 1;
    dbf[3] = today.getDate();
    dbfView.setUint32(4, 1, true);
    dbfView.setUint16(8, headerLength, true);
    dbfView.setUint16(10, recordLength, true);
    dbf[29] = 0x57;
    fields.forEach((field, index) => {
      const offset = 32 + index * 32;
      const name = textEncoder.encode(field.name.slice(0, 10));
      dbf.set(name, offset);
      dbf[offset + 11] = field.type.charCodeAt(0);
      dbf[offset + 16] = field.length;
      dbf[offset + 17] = field.decimals;
    });
    dbf[headerLength - 1] = 0x0d;
    dbf[headerLength] = 0x20;
    let recordOffset = headerLength + 1;
    fields.forEach(field => {
      const asciiValue = String(field.value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7E]/g, " ");
      const fitted = field.type === "N" ? asciiValue.slice(0, field.length).padStart(field.length, " ") : asciiValue.slice(0, field.length).padEnd(field.length, " ");
      dbf.set(textEncoder.encode(fitted), recordOffset);
      recordOffset += field.length;
    });
    dbf[dbf.length - 1] = 0x1a;

    const prj = 'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433],AXIS["Latitude",NORTH],AXIS["Longitude",EAST]]';
    return { shp: new Uint8Array(shp), shx: new Uint8Array(shx), dbf, prj: textEncoder.encode(prj), cpg: textEncoder.encode("UTF-8") };
  }

  let crcTable;
  function crc32(bytes) {
    if (!crcTable) {
      crcTable = Array.from({ length: 256 }, (_, number) => {
        let value = number;
        for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
        return value >>> 0;
      });
    }
    let crc = 0xffffffff;
    for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function concatBytes(chunks) {
    const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    let offset = 0;
    chunks.forEach(chunk => { output.set(chunk, offset); offset += chunk.length; });
    return output;
  }

  function dosDateTime(date = new Date()) {
    return {
      time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
      date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
    };
  }

  function makeZip(entries) {
    const localChunks = [];
    const centralChunks = [];
    let localOffset = 0;
    const stamp = dosDateTime();
    Object.entries(entries).forEach(([name, value]) => {
      const nameBytes = textEncoder.encode(name);
      const data = value instanceof Uint8Array ? value : new Uint8Array(value);
      const crc = crc32(data);
      const local = new Uint8Array(30 + nameBytes.length);
      const localView = new DataView(local.buffer);
      localView.setUint32(0, 0x04034b50, true);
      localView.setUint16(4, 20, true);
      localView.setUint16(6, 0x0800, true);
      localView.setUint16(10, stamp.time, true);
      localView.setUint16(12, stamp.date, true);
      localView.setUint32(14, crc, true);
      localView.setUint32(18, data.length, true);
      localView.setUint32(22, data.length, true);
      localView.setUint16(26, nameBytes.length, true);
      local.set(nameBytes, 30);
      localChunks.push(local, data);

      const central = new Uint8Array(46 + nameBytes.length);
      const centralView = new DataView(central.buffer);
      centralView.setUint32(0, 0x02014b50, true);
      centralView.setUint16(4, 20, true);
      centralView.setUint16(6, 20, true);
      centralView.setUint16(8, 0x0800, true);
      centralView.setUint16(12, stamp.time, true);
      centralView.setUint16(14, stamp.date, true);
      centralView.setUint32(16, crc, true);
      centralView.setUint32(20, data.length, true);
      centralView.setUint32(24, data.length, true);
      centralView.setUint16(28, nameBytes.length, true);
      centralView.setUint32(42, localOffset, true);
      central.set(nameBytes, 46);
      centralChunks.push(central);
      localOffset += local.length + data.length;
    });

    const centralDirectory = concatBytes(centralChunks);
    const end = new Uint8Array(22);
    const endView = new DataView(end.buffer);
    endView.setUint32(0, 0x06054b50, true);
    endView.setUint16(8, centralChunks.length, true);
    endView.setUint16(10, centralChunks.length, true);
    endView.setUint32(12, centralDirectory.length, true);
    endView.setUint32(16, localOffset, true);
    return concatBytes([...localChunks, centralDirectory, end]);
  }

  function buildShapefileZip(route) {
    const base = safeBaseName(routeName(route));
    const files = buildShpFiles(route);
    return makeZip({
      [`${base}.shp`]: files.shp,
      [`${base}.shx`]: files.shx,
      [`${base}.dbf`]: files.dbf,
      [`${base}.prj`]: files.prj,
      [`${base}.cpg`]: files.cpg
    });
  }

  function triggerDownload(data, filename, mimeType) {
    const blob = data instanceof Blob ? data : new Blob([data], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    global.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function download(route, format) {
    const points = routePoints(route);
    if (points.length < 2) throw new Error("Esta ruta no contiene suficientes coordenadas para descargarla.");
    const base = safeBaseName(routeName(route));
    if (format === "csv") return triggerDownload(buildCsv(route), `${base}.csv`, "text/csv;charset=utf-8");
    if (format === "kml") return triggerDownload(buildKml(route), `${base}.kml`, "application/vnd.google-earth.kml+xml;charset=utf-8");
    if (format === "shp") return triggerDownload(buildShapefileZip(route), `${base}-shapefile.zip`, "application/zip");
    throw new Error("Formato de descarga no reconocido.");
  }

  global.RouteExport = { download, buildCsv, buildKml, buildShapefileZip, routePoints };
})(typeof window === "undefined" ? globalThis : window);
