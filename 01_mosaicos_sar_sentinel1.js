/**
 * 01_mosaicos_sar_sentinel1.js
 * ============================================================================
 * QUÉ HACE
 *   Genera un mosaico mensual de radar (Sentinel-1, banda C) listo para
 *   clasificar. Por cada mes exporta la MEDIANA (y opcionalmente la MEDIA) de
 *   las bandas VV y VH en dB, con estos pasos:
 *     1. Filtra escenas (modo IW, una sola órbita, polarización elegida).
 *     2. Convierte de dB a escala lineal.
 *     3. Corrige el efecto del relieve (terrain flattening por coseno) y
 *        enmascara zonas de layover/shadow usando un DEM SRTM.
 *     4. Reduce el ruido "speckle" con un filtro de mediana.
 *     5. Vuelve a dB.
 *     6. Normaliza el ángulo de incidencia (diferencia near/far-range del
 *        swath) con una regresión lineal empírica.
 *     7. Compone (mediana / media) y exporta a Asset.
 *
 * CÓMO USARLO
 *   1. Edita SOLO el bloque CONFIG.
 *   2. Ejecuta el script y lanza las tareas desde la pestaña "Tasks".
 *   3. Repite cambiando CONFIG.MES para los 12 meses.
 *
 * SALIDA
 *   Asset: <ASSET_SALIDA>/mediana_S1__<mes>_<anio>   (bandas: VV, VH)
 *   Los scripts 04 y 05 esperan exactamente este nombre.
 *
 * REQUISITOS
 *   - ROI: FeatureCollection con el polígono de estudio.
 *   - Una carpeta de Assets propia donde escribir (ASSET_SALIDA).
 * ============================================================================
 */

// ============================ CONFIG ========================================
var CONFIG = {
  ROI_ASSET: 'projects/TU_PROYECTO/assets/cuenca_altiplano',
  ANIO: 2020,
  MES: 12,                      // 1 a 12
  DIAS_ANTES: 1,                // días extra antes del día 1 (evita perder escenas por huso horario)
  MODO_POLARIZACION: 'VVVH',    // 'VVVH' o 'HHHV'
  ORBITA: 'DESCENDING',         // 'DESCENDING' o 'ASCENDING' (no mezclar)
  ASSET_SALIDA: 'projects/TU_PROYECTO/assets/mosaicos_sar',
  CRS: 'EPSG:32719',            // UTM 19S (Altiplano boliviano)
  ESCALA: 30,                   // metros
  EXPORTAR_MEDIANA: true,
  EXPORTAR_MEDIA: false,        // los scripts 04/05 solo usan la mediana
  ANGULO_LIA_MIN: 5,            // grados: límites de la máscara layover/shadow
  ANGULO_LIA_MAX: 85,
  MUESTRA_PIXELES_POR_ESCENA: 150  // píxeles por escena para la regresión angular
};
// ============================================================================

var NOMBRES_MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
                     'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
var nombreMes = NOMBRES_MESES[CONFIG.MES - 1];

// 0. ROI Y RANGO DE FECHAS
var roi = ee.FeatureCollection(CONFIG.ROI_ASSET).geometry();
var inicioMes = ee.Date.fromYMD(CONFIG.ANIO, CONFIG.MES, 1);
var startDate = inicioMes.advance(-CONFIG.DIAS_ANTES, 'day');
var endDate   = inicioMes.advance(1, 'month');

var dem = ee.Image('USGS/SRTMGL1_003').clip(roi.buffer(5000));

// 1. MODO DE POLARIZACIÓN
var polMode = CONFIG.MODO_POLARIZACION;
var polBands = (polMode === 'VVVH') ? ['VV', 'VH'] : ['HH', 'HV'];
var coPolName = polBands[0];
var xPolName  = polBands[1];

// 2. COLECCIÓN SENTINEL-1
var orbitPass = CONFIG.ORBITA;

var colS1 = ee.ImageCollection('COPERNICUS/S1_GRD')
    .filterBounds(roi)
    .filterDate(startDate, endDate)
    .filter(ee.Filter.eq('instrumentMode', 'IW'))
    .filter(ee.Filter.eq('orbitProperties_pass', orbitPass))
    .filter(ee.Filter.listContains('transmitterReceiverPolarisation', polBands[0]))
    .filter(ee.Filter.listContains('transmitterReceiverPolarisation', polBands[1]))
    .select([polBands[0], polBands[1], 'angle']);

print('Escenas Sentinel-1 en ' + nombreMes + ' ' + CONFIG.ANIO, colS1.size());

// 3. UTILIDADES dB <-> POTENCIA (lineal)
function toNatural(img) {
  var linear = ee.Image(10.0).pow(img.select([coPolName, xPolName]).divide(10.0))
      .rename([coPolName, xPolName]);
  return linear.addBands(img.select('angle'))
      .copyProperties(img, img.propertyNames());
}
function toDB(img) {
  var db = ee.Image(10.0).multiply(img.select([coPolName, xPolName]).log10())
      .rename([coPolName, xPolName]);
  return db.addBands(img.select(['angle', 'LIA']))
      .copyProperties(img, img.propertyNames());
}

// 4. TERRENO: pendiente, orientación y heading del satélite
var slope  = ee.Terrain.slope(dem);
var aspect = ee.Terrain.aspect(dem);
var heading = (orbitPass === 'DESCENDING') ? 192.0 : -12.0;
var sensorAzimuth = ee.Image.constant(heading).add(90.0);

// 5. ÁNGULO DE INCIDENCIA LOCAL (LIA) Y MÁSCARA LAYOVER/SHADOW
function addLocalIncidenceAngle(image) {
  var thetaIrad  = image.select('angle').multiply(Math.PI / 180);
  var slopeRad   = slope.multiply(Math.PI / 180);
  var aspectRad  = aspect.multiply(Math.PI / 180);
  var azimuthRad = sensorAzimuth.multiply(Math.PI / 180);

  var cosLia = thetaIrad.cos().multiply(slopeRad.cos())
      .add(thetaIrad.sin().multiply(slopeRad.sin())
          .multiply(azimuthRad.subtract(aspectRad).cos()));

  var lia = cosLia.acos().rename('LIA');

  return image.addBands(cosLia.rename('cosLIA')).addBands(lia)
      .addBands(thetaIrad.rename('thetaI_rad'));
}

function layoverShadowMask(image) {
  var lia = image.select('LIA').multiply(180 / Math.PI);
  var mask = lia.gt(CONFIG.ANGULO_LIA_MIN).and(lia.lt(CONFIG.ANGULO_LIA_MAX));
  return image.updateMask(mask);
}

// 6. TERRAIN FLATTENING (corrección de coseno) - efecto de PENDIENTE
function terrainFlatten(image) {
  var withLia = addLocalIncidenceAngle(image);
  var gamma0 = withLia.select([coPolName, xPolName])
      .multiply(withLia.select('thetaI_rad').cos())
      .divide(withLia.select('cosLIA').max(0.05));

  var out = gamma0.rename([coPolName, xPolName])
      .addBands(withLia.select('LIA'))
      .addBands(image.select('angle'))
      .copyProperties(image, image.propertyNames());
  return layoverShadowMask(ee.Image(out));
}

// 7. FILTRO DE SPECKLE (solo sobre bandas de backscatter, no angle/LIA)
function despeckle(image) {
  var kernel = ee.Kernel.square(1.5);
  var smoothed = image.select([coPolName, xPolName])
      .focal_median({kernel: kernel, iterations: 1});
  return smoothed.addBands(image.select(['angle', 'LIA']))
      .copyProperties(image, image.propertyNames());
}

// 8. PIPELINE: natural -> RTC (pendiente) -> speckle -> dB
var colS1_natural   = colS1.map(toNatural);
var colS1_flattened = colS1_natural.map(terrainFlatten);
var colS1_filtered  = colS1_flattened.map(despeckle);
var colS1_dB        = colS1_filtered.map(toDB);

// 9. NORMALIZACIÓN ANGULAR EMPÍRICA - efecto NEAR/FAR-RANGE del swath
//    Se ajusta una recta backscatter(dB) ~ ángulo y se resta su efecto
//    respecto a un ángulo de referencia (el promedio del ROI).
var stableRegion = roi;   // opcional: reemplazar por una zona estable (p. ej. desierto/salar seco)

function sampleBand(bandName) {
  return colS1_dB.map(function(img) {
    return img.select(['angle', bandName]).rename(['angle', 'val'])
        .sample({region: stableRegion, scale: 60,
                 numPixels: CONFIG.MUESTRA_PIXELES_POR_ESCENA,
                 seed: 1, geometries: false, dropNulls: true});
  }).flatten();
}

var samplesCo = sampleBand(coPolName);
var samplesX  = sampleBand(xPolName);

var fitCo = samplesCo.reduceColumns({
  reducer: ee.Reducer.linearFit(), selectors: ['angle', 'val']
});
var fitX = samplesX.reduceColumns({
  reducer: ee.Reducer.linearFit(), selectors: ['angle', 'val']
});

var refAngle = ee.Number(colS1.select('angle')
    .mean().reduceRegion({
      reducer: ee.Reducer.mean(), geometry: roi, scale: 200, maxPixels: 1e9
    }).get('angle'));

function angularNormalization(image) {
  var slopeCo = ee.Number(fitCo.get('scale'));
  var slopeX  = ee.Number(fitX.get('scale'));

  var deltaAngle = image.select('angle').subtract(refAngle);

  var coCorr = image.select(coPolName).subtract(deltaAngle.multiply(slopeCo));
  var xCorr  = image.select(xPolName).subtract(deltaAngle.multiply(slopeX));

  return coCorr.rename(coPolName)
      .addBands(xCorr.rename(xPolName))
      .copyProperties(image, image.propertyNames());
}

var colS1_normalized = colS1_dB.map(angularNormalization);

// 10. COMPUESTOS ESTADÍSTICOS: mediana y media (RTC + normalizado)
var mediana = colS1_normalized.median().reproject({crs: CONFIG.CRS, scale: CONFIG.ESCALA}).clip(roi);
var media   = colS1_normalized.mean().reproject({crs: CONFIG.CRS, scale: CONFIG.ESCALA}).clip(roi);

// 11. VISUALIZACIÓN RÁPIDA
Map.centerObject(roi, 8);
Map.addLayer(mediana.select(coPolName), {min: -25, max: 0}, 'Mediana ' + coPolName + ' (dB)');

// 12. EXPORTAR A ASSET
var sufijo = nombreMes + '_' + CONFIG.ANIO;

if (CONFIG.EXPORTAR_MEDIANA) {
  Export.image.toAsset({
    image: mediana,
    description: 'mediana_S1_RTC_angular_' + polMode + '_' + sufijo,
    assetId: CONFIG.ASSET_SALIDA + '/mediana_S1__' + sufijo,
    region: roi,
    crs: CONFIG.CRS,
    scale: CONFIG.ESCALA,
    maxPixels: 1e13
  });
}
if (CONFIG.EXPORTAR_MEDIA) {
  Export.image.toAsset({
    image: media,
    description: 'media_S1_RTC_angular_' + polMode + '_' + sufijo,
    assetId: CONFIG.ASSET_SALIDA + '/media_S1__' + sufijo,
    region: roi,
    crs: CONFIG.CRS,
    scale: CONFIG.ESCALA,
    maxPixels: 1e13
  });
}
