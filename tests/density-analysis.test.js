const assert = require("node:assert/strict");
const DensityAnalysis = require("../density-analysis.js");

const result = DensityAnalysis.analyze([
  { lat: 4.60971, lng: -74.08175, frequency: 3, dwellMinutes: 30, label: "A" },
  { lat: 4.611, lng: -74.0805, frequency: 2, dwellMinutes: 15, label: "B" },
  { lat: 4.612, lng: -74.082, frequency: 1, dwellMinutes: 5, label: "C" },
  { lat: 4.64, lng: -74.06, frequency: 1, dwellMinutes: 0, label: "D" }
]);

assert.equal(result.resumen_analisis.total_puntos_analizados, 4);
assert.equal(result.resumen_analisis.radio_cobertura_m, 5);
assert.equal(result.resumen_analisis.radio_cobertura_km, 0.005);
assert.ok(result.resumen_analisis.zonas_alta_densidad >= 1);
assert.equal(result.capa_raster.tipo, "FeatureCollection");
assert.ok(result.capa_raster.features.length > 0);
assert.ok(result.capa_raster.features.every(feature => feature.geometry.type === "Polygon"));
assert.ok(result.capa_raster.features.every(feature => feature.properties.valor_intensidad >= 0 && feature.properties.valor_intensidad <= 1));
assert.ok(result.capa_raster.features.some(feature => feature.properties.densidad_nivel === "Alta"));
assert.ok(result.capa_raster.features.some(feature => feature.properties.densidad_nivel === "Muy alta"));
assert.ok(result.capa_raster.features.some(feature => feature.properties.densidad_nivel === "Baja"));
assert.ok(result.capa_raster.features.some(feature => feature.properties.densidad_nivel === "Sin concentración"));
assert.ok(result.resumen_analisis.celdas_sin_concentracion > 0);
assert.equal(result.resumen_analisis.metodo_interpolacion, "núcleo lineal continuo");
assert.deepEqual(result.resumen_analisis.paleta_colores, {
  "Sin concentración": "#ADEEC5",
  Baja: "#FFFB7D",
  Alta: "#FFB23C",
  "Muy alta": "#B73225"
});
assert.ok(result.capa_raster.features.every(feature => feature.properties.color_hex === DensityAnalysis.DENSITY_COLORS[feature.properties.densidad_nivel]));
assert.equal(result.seccion_interfaz_usuario.ubicacion_ui, "panel_cargue_ruta");
const downloadable = DensityAnalysis.downloadableGeoJSON(result);
assert.equal(downloadable.type, "FeatureCollection");
assert.equal(downloadable.name, "capa_raster_densidad_5m");
assert.equal(downloadable.features.length, result.capa_raster.features.length);

assert.throws(() => DensityAnalysis.analyze([]), /punto obligatorio/i);
assert.equal(DensityAnalysis.levelFor(0.72), "Muy alta");
assert.equal(DensityAnalysis.levelFor(0.42), "Alta");
assert.equal(DensityAnalysis.levelFor(0.08), "Baja");
assert.equal(DensityAnalysis.levelFor(0.01), "Sin concentración");

const importedStops = DensityAnalysis.stopsFromGeoJSON({
  type: "FeatureCollection",
  features: [
    { type: "Feature", geometry: { type: "Point", coordinates: [-74.08, 4.61] }, properties: { role: "stop", label: "Ignorado si hay marcados" } },
    { type: "Feature", geometry: { type: "Point", coordinates: [-74.07, 4.62] }, properties: { role: "marked-point", label: "Fijo", frecuencia: 4, estancia_min: 20 } }
  ]
});
assert.equal(importedStops.length, 1);
assert.deepEqual(importedStops[0], { lat: 4.62, lng: -74.07, label: "Fijo", frequency: 4, dwellMinutes: 20 });

console.log("density-analysis: rejilla, buffers, intensidad, categorías y GeoJSON aprobados");

