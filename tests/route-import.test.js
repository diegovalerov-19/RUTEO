const assert = require("node:assert/strict");
const RouteImport = require("../route-import.js");

const encoder = new TextEncoder();

(async () => {
  const csv = RouteImport.parseCsv([
    "orden;latitud;longitud;nombre",
    "2;4,6200;-74,0700;Parada B",
    "1;4,6100;-74,0800;Parada A",
    "3;dato-malo;-74,0600;Parada dañada"
  ].join("\n"));
  assert.deepEqual(csv.headers, ["orden", "latitud", "longitud", "nombre"]);
  const csvResult = await RouteImport.tableToGeoJSON(csv, {
    latitude: "latitud", longitude: "longitud", label: "nombre", order: "orden"
  }, { sourceName: "puntos.csv", format: "CSV" });
  assert.equal(csvResult.report.processed, 2);
  assert.equal(csvResult.report.failed, 1);
  assert.deepEqual(csvResult.geojson.features[0].geometry.coordinates, [-74.07, 4.62]);

  const recordedRoute = RouteImport.parseCsv([
    "recorrido,tipo,secuencia,latitud,longitud,clase_punto,nombre_punto",
    "Ruta ejemplo,GPS,3,4.63,-74.06,TRAZA,",
    "Ruta ejemplo,GPS,1,4.61,-74.08,TRAZA,",
    "Ruta ejemplo,MANUAL,1,4.615,-74.075,MARCADO,Punto marcado 1",
    "Ruta ejemplo,GPS,2,4.62,-74.07,TRAZA,"
  ].join("\n"));
  const recordedMapping = RouteImport.suggestedMapping(recordedRoute.headers);
  assert.equal(recordedMapping.recordType, "clase_punto");
  assert.equal(recordedMapping.label, "nombre_punto");
  const recordedResult = await RouteImport.tableToGeoJSON(recordedRoute, recordedMapping, { sourceName: "recorrido.csv", format: "CSV" });
  assert.deepEqual(recordedResult.geojson.features.map(feature => feature.geometry.type), ["LineString", "Point"]);
  assert.deepEqual(recordedResult.geojson.features[0].geometry.coordinates, [[-74.08, 4.61], [-74.07, 4.62], [-74.06, 4.63]]);
  assert.equal(recordedResult.geojson.features[0].properties.role, "route");
  assert.equal(recordedResult.geojson.features[1].properties.role, "marked-point");
  assert.equal(recordedResult.geojson.features[1].properties.label, "Punto marcado 1");
  assert.equal(recordedResult.report.tracePoints, 3);
  assert.equal(recordedResult.report.markedPoints, 1);
  const recordedStops = RouteImport.routingStops(recordedResult.geojson, { maxStops: 3 });
  assert.equal(recordedStops.source, "geometry");
  assert.deepEqual(recordedStops.stops.map(stop => [stop.lng, stop.lat]), [[-74.08, 4.61], [-74.07, 4.62], [-74.06, 4.63]]);

  const fakeXlsx = {
    read: () => ({ SheetNames: ["Rutas"], Sheets: { Rutas: {} } }),
    utils: { sheet_to_json: () => [["lat", "lng", "label"], [4.61, -74.08, "A"]] }
  };
  const excel = await RouteImport.parseExcel(new ArrayBuffer(2), { xlsx: fakeXlsx });
  assert.equal(excel.sheetName, "Rutas");
  assert.equal(excel.rows[0].label, "A");

  const geojsonResult = await RouteImport.normalizeGeoJSON({
    type: "FeatureCollection",
    features: [
      { type: "Feature", properties: { name: "Punto" }, geometry: { type: "Point", coordinates: [-74.08, 4.61] } },
      { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [[-74.08, 4.61], [-74.07, 4.62]] } },
      { type: "Feature", properties: {}, geometry: { type: "MultiLineString", coordinates: [[[-74.07, 4.62], [-74.06, 4.63]]] } },
      { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [-250, 95] } }
    ]
  }, { sourceName: "rutas.geojson" });
  assert.equal(geojsonResult.report.processed, 3);
  assert.ok(geojsonResult.report.failed >= 1);
  assert.deepEqual(geojsonResult.geojson.features.map(feature => feature.geometry.type), ["Point", "LineString", "MultiLineString"]);

  const gpxResult = await RouteImport.parseGpx(`<?xml version="1.0"?>
    <gpx><wpt lat="4.61" lon="-74.08"><name>A</name></wpt>
    <trk><trkseg><trkpt lat="4.61" lon="-74.08"></trkpt><trkpt lat="4.62" lon="-74.07"></trkpt></trkseg></trk></gpx>`, { sourceName: "ruta.gpx" });
  assert.deepEqual(gpxResult.geojson.features.map(feature => feature.geometry.type), ["Point", "LineString"]);

  const kmlText = `<?xml version="1.0"?><kml><Document>
    <Placemark><name>Inicio</name><Point><coordinates>-74.08,4.61,0</coordinates></Point></Placemark>
    <Placemark><name>Ruta</name><MultiGeometry>
      <LineString><coordinates>-74.08,4.61 -74.07,4.62</coordinates></LineString>
      <LineString><coordinates>-74.07,4.62 -74.06,4.63</coordinates></LineString>
    </MultiGeometry></Placemark></Document></kml>`;
  const kmlResult = await RouteImport.parseKml(kmlText, { sourceName: "ruta.kml" });
  assert.deepEqual(kmlResult.geojson.features.map(feature => feature.geometry.type), ["Point", "MultiLineString"]);

  const kmzResult = await RouteImport.parseKmz(new ArrayBuffer(3), {
    sourceName: "ruta.kmz",
    dependencies: { fflate: { unzipSync: () => ({ "doc.kml": encoder.encode(kmlText) }) } }
  });
  assert.equal(kmzResult.report.processed, 2);
  assert.equal(kmzResult.report.format, "KMZ");

  const shapefileGeoJSON = {
    type: "FeatureCollection",
    features: [{ type: "Feature", properties: { name: "SHP" }, geometry: { type: "Point", coordinates: [-74.08, 4.61] } }]
  };
  const shapefileResult = await RouteImport.parseShapefile(new ArrayBuffer(4), {
    sourceName: "rutas.zip",
    dependencies: {
      fflate: { unzipSync: () => ({ "rutas.shp": new Uint8Array(), "rutas.dbf": new Uint8Array(), "rutas.shx": new Uint8Array(), "rutas.prj": new Uint8Array() }) },
      shp: async () => shapefileGeoJSON
    }
  });
  assert.equal(shapefileResult.report.processed, 1);

  function fakeProj4(from, to, coordinate) { return [coordinate[0] / 100000, coordinate[1] / 100000]; }
  fakeProj4.defs = () => ({ configured: true });
  const projected = await RouteImport.tableToGeoJSON({ headers: ["x", "y"], rows: [{ x: -7400000, y: 461000 }] }, {
    latitude: "y", longitude: "x"
  }, { sourceCrs: "EPSG:3857", dependencies: { proj4: fakeProj4 } });
  assert.deepEqual(projected.geojson.features[0].geometry.coordinates, [-74, 4.61]);

  const orderedStops = RouteImport.routingStops({
    type: "FeatureCollection",
    features: [
      { type: "Feature", properties: { order: 2, label: "B" }, geometry: { type: "Point", coordinates: [-74.07, 4.62] } },
      { type: "Feature", properties: { order: 1, label: "A" }, geometry: { type: "Point", coordinates: [-74.08, 4.61] } }
    ]
  });
  assert.deepEqual(orderedStops.stops.map(stop => stop.label), ["A", "B"]);

  console.log("route-import: CSV, Excel, GeoJSON, GPX, KML, KMZ, Shapefile y reproyección aprobados");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

