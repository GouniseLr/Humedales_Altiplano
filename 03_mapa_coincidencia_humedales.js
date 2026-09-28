/**
 * 03_mapa_coincidencia_humedales.js
 * ============================================================================
 * QUÉ HACE
 *   Combina 8 productos globales/regionales de cobertura y agua para obtener
 *   un mapa de referencia de humedales SIN mapear a mano:
 *     1. Convierte cada producto a binario (1 = humedal/agua, 0 = resto).
 *     2. Suma los 8 binarios -> "mapa de coincidencia" (0 a 8): cuántos
 *        productos coinciden en llamar humedal a cada píxel.
 *     3. Aplica un umbral: coincidencia >= UMBRAL_HUMEDAL => humedal;
 *        la zona intermedia (AMBIGUO_MIN a AMBIGUO_MAX) se descarta.
 *     4. (Opcional) Genera puntos de entrenamiento estratificados sobre ese
 *        mapa final.
 *
 * PARA QUÉ SIRVE
 *   El mapa final y sus puntos son las "etiquetas" con que se entrenan los
 *   clasificadores de los scripts 04 y 05.
 *
 * PRODUCTOS USADOS (todos se leen desde GEE, no hay que subir nada)
 *   ESRI 10m Land Cover, GLAD Surface Water v2, ESA WorldCover, GWL_FCS30,
 *   GLWD v2, JRC Global Surface Water, GLC_FCS30D y MapBiomas Bolivia.
 *   Varios están en el catálogo comunitario (projects/sat-io/...): si un
 *   asset no carga, revisa que tu cuenta tenga acceso a él.
 *
 * CÓMO USARLO
 *   1. Edita SOLO el bloque CONFIG.
 *   2. Ejecuta y lanza las exportaciones desde "Tasks".
 *   3. Para crear los puntos, pon GENERAR_PUNTOS = true (ver más abajo).
 *
 * NOTAS
 *   - ESA WorldCover v100 corresponde solo a 2020. Si cambias ANIO, revisa
 *     esa capa (y GLWD v2 y GLAD Dynamics, que son estáticos).
 *   - MapBiomas Bolivia y GLC_FCS30D tienen códigos propios: revisa las
 *     listas de códigos de humedal si adaptas el script a otra región.
 * ============================================================================
 */

// ============================ CONFIG ========================================
var CONFIG = {
  ROI_ASSET: 'projects/TU_PROYECTO/assets/cuenca_altiplano',
  ANIO: 2020,

  // Umbral de decisión (con 8 productos: 0 a 8 coincidencias)
  UMBRAL_HUMEDAL: 6,          // >= 6 coincidencias => humedal
  AMBIGUO_MIN: 3,             // 3, 4 y 5 => zona ambigua (se descarta)
  AMBIGUO_MAX: 5,

  // Salidas
  ESCALA: 30,
  CRS_COINCIDENCIA: 'EPSG:4326',
  CRS_FINAL: 'EPSG:32719',
  DRIVE_CARPETA: 'GEE_exports',
  ASSET_COINCIDENCIA: 'projects/TU_PROYECTO/assets/Coincidencia_Humedales_2020',
  ASSET_MAPA_FINAL:   'projects/TU_PROYECTO/assets/MapaFinal_Humedales_2020',

  // Puntos de entrenamiento
  GENERAR_PUNTOS: false,      // true = crea los puntos a partir del mapa final
  PUNTOS_POR_CLASE: 4000,     // puntos por clase (0 y 1); ajusta a tu área
  SEMILLA: 42,
  ASSET_PUNTOS: 'projects/TU_PROYECTO/assets/PuntosEntrenamiento_Humedales_2020'
  // Si GENERAR_PUNTOS = false, se leen desde ASSET_PUNTOS (debe existir).
};
// ============================================================================

var roi_fc = ee.FeatureCollection(CONFIG.ROI_ASSET);
var roi = roi_fc.geometry();
var inicioAnio = CONFIG.ANIO + '-01-01';
var finAnio    = (CONFIG.ANIO + 1) + '-01-01';

var visHumedal = {min: 0, max: 1, palette: ['white', '084594']};
var visConsenso = {
  min: 0, max: 8,
  palette: ['ffffff', 'c6dbef', '9ecae1', '6baed6', '4292c6', '2171b5', '08519c', '08306b', '000000']
};

// ---------------------------------------------------------------------------
// PARTE 1 — CARGA DE DATASETS (filtrados al año)
// ---------------------------------------------------------------------------

// 1. ESRI 10m Annual Land Cover
var esri_2020 = ee.ImageCollection('projects/sat-io/open-datasets/landcover/ESRI_Global-LULC_10m_TS')
  .filterDate(inicioAnio, finAnio).mosaic();

// 2. GLAD Global Surface Water Dynamics v2 (% de agua anual)
var glad_2020 = ee.ImageCollection('projects/glad/water/C2/annual')
  .filter(ee.Filter.calendarRange(CONFIG.ANIO, CONFIG.ANIO, 'year')).mosaic();

// 2b. GLAD Interannual Dynamics Classes (1999-2025): solo capa de CONTEXTO
var glad_dynamics = ee.Image('projects/glad/water/C2/dynamic_classes_99_25');
var visGladDynamics = {
  min: 0, max: 12,
  palette: ['000000', '4d4d4d', 'ffffff', '2b83ba', 'fdae61', 'ff00ff', '1a9850',
            'bababa', '8c6d31', '000000', '2d2d2d', 'e0e0e0', '000000']
  // 1 Land, 2 Permanent water, 3 Water gain, 4 Water loss, 5 Dry period,
  // 6 Wet period, 7 Stable seasonal, 8 High frequency, 10 Prob. land,
  // 11 Prob. water, 12 Sparse data
};

// 3. ESA WorldCover (v100 = 2020 exacto)
var esa_2020 = ee.Image('ESA/WorldCover/v100/2020');

// 4. GWL_FCS30
var gwl_2020 = ee.ImageCollection('projects/sat-io/open-datasets/GWL_FCS30')
  .filterDate(inicioAnio, finAnio).mosaic();

// 5. GLWD v2 — síntesis estática multiépoca, sin filtro de fecha
var glwd_v2 = ee.Image(
  'projects/earthengine-legacy/assets/projects/sat-io/open-datasets/GLWD/GLWD_V2_DELTA_MAIN_CLASS');

// 6. JRC Global Surface Water (historial anual)
var jrc_2020 = ee.ImageCollection('JRC/GSW1_4/YearlyHistory')
  .filter(ee.Filter.eq('year', CONFIG.ANIO)).mosaic();

// 7. GLC_FCS30D — mosaico y una banda por año (2000-2022)
var glc_annual_raw = ee.ImageCollection('projects/sat-io/open-datasets/GLC-FCS30D/annual');
var glc_yearsList = ee.List.sequence(2000, 2022).map(function (y) {
  return ee.Number(y).format('%04d');
});
var glc_annualMosaic = glc_annual_raw.mosaic().rename(glc_yearsList);
var glc_yearlyImgs = glc_yearsList.map(function (year) {
  var date = ee.Date.fromYMD(ee.Number.parse(year), 1, 1);
  return glc_annualMosaic.select([year]).rename('classification')
    .set({'system:time_start': date.millis(), 'year': ee.Number.parse(year)});
});
var glc_2020 = ee.ImageCollection.fromImages(glc_yearlyImgs)
  .filter(ee.Filter.eq('year', CONFIG.ANIO)).mosaic();

// 8. MapBiomas Bolivia LULC
var mbbo_2020 = ee.ImageCollection('projects/mapbiomas-public/assets/bolivia/lulc/v1')
  .filter(ee.Filter.eq('year', CONFIG.ANIO)).mosaic();

// ---------------------------------------------------------------------------
// PARTE 2 — RECORTE A LA CUENCA
// ---------------------------------------------------------------------------
var esri_c = esri_2020.clip(roi);
var glad_c = glad_2020.clip(roi);
var glad_dynamics_c = glad_dynamics.clip(roi);
var esa_c  = esa_2020.clip(roi);
var gwl_c  = gwl_2020.clip(roi);
var glwd_c = glwd_v2.clip(roi);
var jrc_c  = jrc_2020.clip(roi);
var glc_c  = glc_2020.clip(roi);
var mbbo_c = mbbo_2020.clip(roi);

// ---------------------------------------------------------------------------
// PARTE 3 — RECLASIFICACIÓN BINARIA (Humedal = 1, No humedal = 0)
// ---------------------------------------------------------------------------

// ESRI — 1 Water, 4 Flooded vegetation
var b_esri = esri_c.select('b1').eq(1).or(esri_c.select('b1').eq(4))
  .unmask(0).rename('humedal').toByte().clip(roi);

// GLAD v2 — cualquier píxel con % de agua > 0
var b_glad = glad_c.select(0).gt(0).unmask(0).rename('humedal').toByte();

// ESA WorldCover — 80 Permanent water, 90 Herbaceous wetland, 95 Mangroves
var b_esa = esa_c.eq(80).or(esa_c.eq(90)).or(esa_c.eq(95))
  .unmask(0).rename('humedal').toByte();

// GWL_FCS30 — 180-187 subtipos de humedal
var gwl_wetlandCodes = [180, 181, 182, 183, 184, 185, 186, 187];
var b_gwl = gwl_c.select(0)
  .remap(gwl_wetlandCodes, ee.List.repeat(1, gwl_wetlandCodes.length), 0)
  .unmask(0).rename('humedal').toByte();

// GLWD v2 — 0 Dryland, 1-33 tipos de humedal/agua
var b_glwd = glwd_c.select(0).gt(0)
  .reproject({crs: 'EPSG:4326', scale: CONFIG.ESCALA})
  .unmask(0).rename('humedal').toByte().clip(roi);

// JRC GSW — waterClass: 2 = agua
var b_jrc = jrc_c.select('waterClass').eq(2).unmask(0).rename('humedal').toByte();

// GLC_FCS30D — 181-187 subtipos de humedal, 210 cuerpo de agua
var glc_wetlandCodes = [181, 182, 183, 184, 185, 186, 187, 210];
var b_glc = glc_c.select('classification')
  .remap(glc_wetlandCodes, ee.List.repeat(1, glc_wetlandCodes.length), 0)
  .unmask(0).rename('humedal').toByte();

// MapBiomas Bolivia — clases de humedal/agua
var mbbo_wetlandCodes = [6, 11, 26, 33, 82];
var b_mbbo = mbbo_c.select('classification')
  .remap(mbbo_wetlandCodes, ee.List.repeat(1, mbbo_wetlandCodes.length), 0)
  .unmask(0).rename('humedal').toByte();

// ---------------------------------------------------------------------------
// PARTE 4 — MAPA DE COINCIDENCIA (0-8)
// ---------------------------------------------------------------------------
var coincidencia = ee.Image(0)
  .add(b_esri).add(b_glad).add(b_esa).add(b_gwl)
  .add(b_glwd).add(b_jrc).add(b_glc).add(b_mbbo)
  .uint8();

Map.centerObject(roi, 9);
var binarios = [
  [b_esri, 'Humedal ESRI'], [b_glad, 'Humedal GLAD v2 (>0% agua)'],
  [b_esa, 'Humedal ESA WorldCover'], [b_gwl, 'Humedal GWL_FCS30'],
  [b_glwd, 'Humedal GLWD v2 (estático)'], [b_jrc, 'Humedal JRC GSW'],
  [b_glc, 'Humedal GLC_FCS30D'], [b_mbbo, 'Humedal MapBiomas Bolivia']
];
binarios.forEach(function (b) { Map.addLayer(b[0], visHumedal, b[1] + ' ' + CONFIG.ANIO, false); });

Map.addLayer(glad_dynamics_c, visGladDynamics, 'GLAD Dynamics 1999-2025 (contexto)', false);
Map.addLayer(coincidencia, visConsenso, 'Mapa de Coincidencia (0-8)', true);

// ---------------------------------------------------------------------------
// PARTE 5 — EXPORTAR EL MAPA DE COINCIDENCIA
// ---------------------------------------------------------------------------
Export.image.toDrive({
  image: coincidencia,
  description: 'DRIVE_Coincidencia_Humedales_' + CONFIG.ANIO,
  folder: CONFIG.DRIVE_CARPETA,
  scale: CONFIG.ESCALA, crs: CONFIG.CRS_COINCIDENCIA,
  region: roi, maxPixels: 1e12
});
Export.image.toAsset({
  image: coincidencia,
  description: 'ASSET_Coincidencia_Humedales_' + CONFIG.ANIO,
  assetId: CONFIG.ASSET_COINCIDENCIA,
  scale: CONFIG.ESCALA, crs: CONFIG.CRS_COINCIDENCIA,
  region: roi, maxPixels: 1e12
});

// ---------------------------------------------------------------------------
// PARTE 6 — UMBRAL DE DECISIÓN (descarta la zona de empate/ambigüedad)
// ---------------------------------------------------------------------------
var zonaAmbigua = coincidencia.gte(CONFIG.AMBIGUO_MIN).and(coincidencia.lte(CONFIG.AMBIGUO_MAX));

var mapaFinal = coincidencia.gte(CONFIG.UMBRAL_HUMEDAL)   // 1 = humedal confirmado
  .updateMask(zonaAmbigua.not())                           // enmascara la zona ambigua
  .rename('humedal_final');

// Rojo = no humedal confirmado, verde = humedal confirmado (ambigua: transparente)
var visFinal = {min: 0, max: 1, palette: ['d73027', '1a9850']};
Map.addLayer(mapaFinal, visFinal, 'Mapa Final Humedal (descarta zona ambigua)', true);
Map.addLayer(zonaAmbigua.selfMask(), {palette: ['ff7f00']}, 'Zona descartada (ambigua)', false);

Export.image.toDrive({
  image: mapaFinal,
  description: 'DRIVE_MapaFinal_Humedales_' + CONFIG.ANIO,
  folder: CONFIG.DRIVE_CARPETA,
  scale: CONFIG.ESCALA, crs: CONFIG.CRS_FINAL,
  region: roi, maxPixels: 1e12
});
Export.image.toAsset({
  image: mapaFinal,
  description: 'ASSET_MapaFinal_Humedales_' + CONFIG.ANIO,
  assetId: CONFIG.ASSET_MAPA_FINAL,
  scale: CONFIG.ESCALA, crs: CONFIG.CRS_FINAL,
  region: roi, maxPixels: 1e12
});

// ---------------------------------------------------------------------------
// PARTE 7 — PUNTOS DE ENTRENAMIENTO
//   La tabla de puntos debe tener una propiedad 'humedal_final' (0 o 1).
//   Es la misma que usan los scripts 04 y 05 (CONFIG.CLASE).
// ---------------------------------------------------------------------------
var puntosEntrenamiento;

if (CONFIG.GENERAR_PUNTOS) {
  // Muestreo estratificado: mismo número de puntos por clase sobre el mapa final
  puntosEntrenamiento = mapaFinal.stratifiedSample({
    numPoints: 0,
    classBand: 'humedal_final',
    region: roi,
    scale: CONFIG.ESCALA,
    seed: CONFIG.SEMILLA,
    classValues: [0, 1],
    classPoints: [CONFIG.PUNTOS_POR_CLASE, CONFIG.PUNTOS_POR_CLASE],
    geometries: true,
    tileScale: 4
  });
  Export.table.toAsset({
    collection: puntosEntrenamiento,
    description: 'PuntosEntrenamiento_Humedales_' + CONFIG.ANIO,
    assetId: CONFIG.ASSET_PUNTOS
  });
} else {
  puntosEntrenamiento = ee.FeatureCollection(CONFIG.ASSET_PUNTOS);
}

var puntosHumedal   = puntosEntrenamiento.filter(ee.Filter.eq('humedal_final', 1));
var puntosNoHumedal = puntosEntrenamiento.filter(ee.Filter.eq('humedal_final', 0));
Map.addLayer(puntosNoHumedal, {color: 'd73027'}, 'Puntos entrenamiento - No Humedal', false);
Map.addLayer(puntosHumedal,   {color: '1a9850'}, 'Puntos entrenamiento - Humedal', false);

var roiBorde = ee.Image().byte().paint({featureCollection: roi_fc, color: 1, width: 2});
Map.addLayer(roiBorde, {palette: ['ff0000']}, 'Límite ROI', true);

// ---------------------------------------------------------------------------
// PARTE 8 — DATASETS ORIGINALES (SIN BINARIZAR), para inspección
// ---------------------------------------------------------------------------
var capasOriginales = [
  {img: esri_c.select('b1'), nombre: 'ESRI (original)',
   vis: {min: 1, max: 11, palette: ['1A5BAB','358221','87D19E','FFDB5C','ED022A','EDE9E4','F2FAFF','C8C8C8','C6AD8D','000000','E3D192']}},
  {img: glad_c.select(0), nombre: 'GLAD v2 (original, % agua)',
   vis: {min: 0, max: 100, palette: ['ffffff','9ecae1','2171b5','08306b']}},
  {img: esa_c, nombre: 'ESA WorldCover (original)',
   vis: {min: 10, max: 100, palette: ['006400','ffbb22','ffff4c','f096ff','fa0000','b4b4b4','f0f0f0','0064c8','0096a0','00cf75','fae6a0']}},
  {img: gwl_c.select(0), nombre: 'GWL_FCS30 (original)',
   vis: {min: 0, max: 210, palette: ['ffffff','fee391','fe9929','d95f0e','993404','000000']}},
  {img: glwd_c.select(0), nombre: 'GLWD v2 (original, estático)',
   vis: {min: 0, max: 33, palette: ['ffffff','c6dbef','6baed6','2171b5','08306b']}},
  {img: jrc_c.select('waterClass'), nombre: 'JRC GSW (original, waterClass)',
   vis: {min: 0, max: 2, palette: ['000000','d9d9d9','0000ff']}},
  {img: glc_c.select('classification'), nombre: 'GLC_FCS30D (original)',
   vis: {min: 0, max: 220, palette: ['ffffff','a1d99b','fdae6b','de2d26','000000']}},
  {img: mbbo_c.select('classification'), nombre: 'MapBiomas Bolivia (original)',
   vis: {min: 0, max: 33, palette: ['ffffff','1f8d49','7dc975','04381d','d4271e']}}
];
capasOriginales.forEach(function (c) {
  Map.addLayer(c.img, c.vis, c.nombre + ' ' + CONFIG.ANIO, false);
});
