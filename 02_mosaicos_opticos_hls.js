/**
 * 02_mosaicos_opticos_hls.js
 * ============================================================================
 * QUÉ HACE
 *   Genera un mosaico óptico mensual con imágenes HLS (Harmonized Landsat
 *   Sentinel-2, NASA) y calcula índices espectrales. Por cada mes exporta la
 *   MEDIANA (y opcionalmente la MEDIA) con:
 *     - 6 bandas armonizadas: Blue, Green, Red, NIR, SWIR1, SWIR2
 *     - Índices: NDVI, NDWI, MNDWI, LSWI, SAVI, TCW (Tasseled Cap Wetness)
 *     - NDRE (solo con Sentinel-2, que es el único con banda de borde rojo)
 *
 * CÓMO USARLO
 *   1. Edita SOLO el bloque CONFIG.
 *   2. Ejecuta y lanza las tareas desde la pestaña "Tasks".
 *   3. Repite cambiando CONFIG.MES para los 12 meses.
 *
 * SALIDA
 *   Asset: <ASSET_SALIDA>/mediana_<mes>_<anio>
 *   Los scripts 04 y 05 esperan exactamente este nombre.
 *
 * NOTAS
 *   - Las nubes se enmascaran píxel a píxel con la banda Fmask (cirro, nube,
 *     nube adyacente y sombra). CLOUD_COVERAGE_MAX solo descarta escenas muy
 *     nubladas de entrada.
 *   - NDRE se calcula en una colección separada solo con Sentinel-2 (S30)
 *     para no mezclar sensores con distinto número de bandas.
 * ============================================================================
 */

// ============================ CONFIG ========================================
var CONFIG = {
  ROI_ASSET: 'projects/TU_PROYECTO/assets/cuenca_altiplano',
  ANIO: 2020,
  MES: 6,                       // 1 a 12
  DIAS_ANTES: 1,               // días extra antes del día 1 del mes
  NUBES_MAX: 70,               // % máximo de nubes por escena (metadato CLOUD_COVERAGE)
  ASSET_SALIDA: 'projects/TU_PROYECTO/assets/mosaicos_opticos',
  ESCALA: 30,                  // metros
  EXPORTAR_MEDIANA: true,
  EXPORTAR_MEDIA: false        // los scripts 04/05 solo usan la mediana
};
// ============================================================================

var NOMBRES_MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
                     'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
var nombreMes = NOMBRES_MESES[CONFIG.MES - 1];

// ROI y fechas
var roi = ee.FeatureCollection(CONFIG.ROI_ASSET).geometry();
var inicioMes = ee.Date.fromYMD(CONFIG.ANIO, CONFIG.MES, 1);
var startDate = inicioMes.advance(-CONFIG.DIAS_ANTES, 'day');
var endDate   = inicioMes.advance(1, 'month');

// Bandas comunes armonizadas (Landsat = L30, Sentinel-2 = S30)
var COMMON_BANDS = ['Blue', 'Green', 'Red', 'NIR', 'SWIR1', 'SWIR2'];
var L30_BANDS = ['B2', 'B3', 'B4', 'B5', 'B6', 'B7'];
var S30_BANDS = ['B2', 'B3', 'B4', 'B8A', 'B11', 'B12'];

// Máscara Fmask: bit 0 cirro, 1 nube, 2 nube adyacente, 3 sombra
function maskFmask(image) {
  var qa = image.select('Fmask');
  var cirrus   = qa.bitwiseAnd(1 << 0).eq(0);
  var cloud    = qa.bitwiseAnd(1 << 1).eq(0);
  var adjacent = qa.bitwiseAnd(1 << 2).eq(0);
  var shadow   = qa.bitwiseAnd(1 << 3).eq(0);
  return image.updateMask(cirrus.and(cloud).and(adjacent).and(shadow));
}

function prepL30(image) {
  return maskFmask(image).select(L30_BANDS, COMMON_BANDS)
      .copyProperties(image, image.propertyNames());
}
function prepS30(image) {
  return maskFmask(image).select(S30_BANDS, COMMON_BANDS)
      .copyProperties(image, image.propertyNames());
}

// Colecciones para el mosaico principal (Landsat + Sentinel-2)
var colL30 = ee.ImageCollection('NASA/HLS/HLSL30/v002')
    .filterBounds(roi).filterDate(startDate, endDate)
    .filter(ee.Filter.lte('CLOUD_COVERAGE', CONFIG.NUBES_MAX))
    .map(prepL30);
var colS30 = ee.ImageCollection('NASA/HLS/HLSS30/v002')
    .filterBounds(roi).filterDate(startDate, endDate)
    .filter(ee.Filter.lte('CLOUD_COVERAGE', CONFIG.NUBES_MAX))
    .map(prepS30);

var colHLS = colL30.merge(colS30);
print('N° escenas L30', colL30.size());
print('N° escenas S30', colS30.size());
print('N° escenas HLS combinadas', colHLS.size());

var media   = colHLS.mean().clip(roi);
var mediana = colHLS.median().clip(roi);

// Índices que NO requieren borde rojo
function addCoreIndices(img) {
  var ndvi  = img.normalizedDifference(['NIR', 'Red']).rename('NDVI');
  var ndwi  = img.normalizedDifference(['Green', 'NIR']).rename('NDWI');
  var mndwi = img.normalizedDifference(['Green', 'SWIR1']).rename('MNDWI');
  var lswi  = img.normalizedDifference(['NIR', 'SWIR1']).rename('LSWI');

  var L = 0.5;
  var savi = img.expression(
    '((NIR - RED) / (NIR + RED + L)) * (1 + L)', {
      'NIR': img.select('NIR'), 'RED': img.select('Red'), 'L': L
  }).rename('SAVI');

  // Tasseled Cap Wetness (coeficientes de Crist, 1985, reflectancia)
  var tcw = img.expression(
    '0.0315*BLUE + 0.2021*GREEN + 0.3102*RED + 0.1594*NIR - 0.6806*SWIR1 - 0.6109*SWIR2', {
      'BLUE': img.select('Blue'), 'GREEN': img.select('Green'), 'RED': img.select('Red'),
      'NIR': img.select('NIR'), 'SWIR1': img.select('SWIR1'), 'SWIR2': img.select('SWIR2')
  }).rename('TCW');

  return img.addBands([ndvi, ndwi, mndwi, lswi, savi, tcw]);
}

media   = addCoreIndices(media);
mediana = addCoreIndices(mediana);

// NDRE: colección separada SOLO Sentinel-2 (no se mezcla con Landsat)
function prepS30_NDRE(image) {
  var masked  = maskFmask(image);
  var nir     = masked.select('B8A').rename('NIR');
  var redEdge = masked.select('B6').rename('RedEdge2');
  return nir.addBands(redEdge)
      .normalizedDifference(['NIR', 'RedEdge2']).rename('NDRE')
      .copyProperties(image, image.propertyNames());
}

var colS30_NDRE = ee.ImageCollection('NASA/HLS/HLSS30/v002')
    .filterBounds(roi).filterDate(startDate, endDate)
    .filter(ee.Filter.lte('CLOUD_COVERAGE', CONFIG.NUBES_MAX))
    .map(prepS30_NDRE);

media   = media.addBands(colS30_NDRE.mean().clip(roi));
mediana = mediana.addBands(colS30_NDRE.median().clip(roi));

print('Bandas del mosaico (mediana)', mediana.bandNames());

// Visualización
var indexVisParams = {
  NDVI:  {min: -0.6, max: 0.8,  palette: ['#a50026','#fdae61','#ffffbf','#66bd63','#1a9850']},
  NDWI:  {min: -0.5, max: 0.5,  palette: ['#8c510a','#f6e8c3','#c7eae5','#01665e']},
  MNDWI: {min: -0.5, max: 0.5,  palette: ['#8c510a','#f6e8c3','#c7eae5','#01665e']},
  LSWI:  {min: -0.5, max: 0.5,  palette: ['#a50026','#fee08b','#66c2a5','#3288bd']},
  SAVI:  {min: -0.2, max: 0.8,  palette: ['#a50026','#fdae61','#ffffbf','#66bd63','#1a9850']},
  TCW:   {min: -0.3, max: 0.3,  palette: ['#8c510a','#f6e8c3','#c7eae5','#01665e']},
  NDRE:  {min: -0.2, max: 0.6,  palette: ['#a50026','#fdae61','#ffffbf','#66bd63','#1a9850']}
};
var visRGB = {bands: ['Red', 'Green', 'Blue'], min: 0.01, max: 0.3};
var etiqueta = nombreMes + ' ' + CONFIG.ANIO;

Map.centerObject(roi, 7);
Map.addLayer(media,   visRGB, 'RGB - Media - ' + etiqueta, false);
Map.addLayer(mediana, visRGB, 'RGB - Mediana - ' + etiqueta);
Object.keys(indexVisParams).forEach(function(key) {
  Map.addLayer(mediana.select(key), indexVisParams[key], key + ' - Mediana', false);
});

var roiOutline = ee.Image().byte().paint({
  featureCollection: ee.FeatureCollection([ee.Feature(roi)]), color: 1, width: 2
});
Map.addLayer(roiOutline, {palette: ['ff00ff']}, 'ROI', true);

// Exportar a Asset
var sufijo = nombreMes + '_' + CONFIG.ANIO;

if (CONFIG.EXPORTAR_MEDIANA) {
  Export.image.toAsset({
    image: mediana,
    description: 'mediana_' + sufijo,
    assetId: CONFIG.ASSET_SALIDA + '/mediana_' + sufijo,
    region: roi,
    scale: CONFIG.ESCALA,
    maxPixels: 1e13
  });
}
if (CONFIG.EXPORTAR_MEDIA) {
  Export.image.toAsset({
    image: media,
    description: 'media_' + sufijo,
    assetId: CONFIG.ASSET_SALIDA + '/media_' + sufijo,
    region: roi,
    scale: CONFIG.ESCALA,
    maxPixels: 1e13
  });
}
