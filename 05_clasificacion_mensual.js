/**
 * 05_clasificacion_mensual.js
 * ============================================================================
 * QUÉ HACE
 *   Clasifica humedal / no humedal para UN mes (el de CONFIG.MES) combinando
 *   el mosaico óptico y el radar VV de ese mes. Se prueban tres ramas:
 *     - ESPECTRAL: 6 bandas ópticas + VV
 *     - NDVI + VV
 *     - NDWI + VV
 *   con tres algoritmos por rama (RF, SVM y Ensemble): 9 mapas finales, con
 *   métricas de exactitud (Overall Accuracy y F1).
 *
 * REQUISITOS PREVIOS
 *   - Scripts 01 y 02 ejecutados para el mes elegido.
 *   - Puntos de entrenamiento/validación con la propiedad 'humedal_final'
 *     (0 = no humedal, 1 = humedal); ver script 03.
 *
 * CÓMO USARLO
 *   1. Edita SOLO el bloque CONFIG (para otro mes, cambia CONFIG.MES).
 *   2. Ejecuta, revisa las métricas y lanza las exportaciones en "Tasks".
 *
 * DIFERENCIAS CON EL SCRIPT 04
 *   - Trabaja con un solo mes (sin serie temporal).
 *   - El filtro "sal y pimienta" reproyecta primero a CONFIG.CRS para contar
 *     píxeles sobre la grilla correcta, y se aplica ANTES de validar.
 * ============================================================================
 */

// ============================ CONFIG ========================================
var CONFIG = {
  ROI_ASSET: 'projects/TU_PROYECTO/assets/cuenca_altiplano',
  ANIO: 2020,
  MES: 'febrero',     // enero, febrero, marzo, abril, mayo, junio, julio,
                      // agosto, septiembre, octubre, noviembre, diciembre

  // Carpetas de Assets con los mosaicos mensuales (scripts 01 y 02)
  ASSET_OPTICO: 'projects/TU_PROYECTO/assets/mosaicos_opticos',  // mediana_<mes>_<anio>
  ASSET_SAR:    'projects/TU_PROYECTO/assets/mosaicos_sar',      // mediana_S1__<mes>_<anio>
  // Opcional: rutas distintas para este mes. Ejemplo:
  // {optico: 'projects/otro/assets/mediana_febrero_2020', sar: 'projects/otro/assets/...'}
  RUTAS_ESPECIALES: {},

  PUNTOS_ENTRENAMIENTO: [
    'projects/TU_PROYECTO/assets/PuntosEntrenamiento_Humedales_2020'
    // , 'projects/TU_PROYECTO/assets/PuntosEntrenamiento_Nuevos_2020'
  ],
  PUNTOS_VALIDACION: 'projects/TU_PROYECTO/assets/PuntosValidacion_2020',
  CLASE: 'humedal_final',
  FRACCION_ENTRENAMIENTO: 0.9,
  SEMILLA: 42,

  ARBOLES_RF: 100,
  SVM_COSTO: 10,

  ESCALA: 30,
  CRS: 'EPSG:32719',
  ASSET_SALIDA: 'projects/TU_PROYECTO/assets/Clasificacion_Mensual_2020',

  UMM_FACTOR: 0.0002,
  UMM_ESCALA: 150000   // 900 m² = 1 píxel a 30 m
};
// ============================================================================

// ---------------------------------------------------------------------------
// 1) ROI
// ---------------------------------------------------------------------------
var roi = ee.FeatureCollection(CONFIG.ROI_ASSET).geometry();
var MES_A_PROCESAR = CONFIG.MES;

// ---------------------------------------------------------------------------
// 2) PUNTOS
// ---------------------------------------------------------------------------
var CLASS_PROPERTY = CONFIG.CLASE;

var puntosCombinados = ee.FeatureCollection(
  CONFIG.PUNTOS_ENTRENAMIENTO.map(function (a) { return ee.FeatureCollection(a); })
).flatten();
print('N° total de puntos combinados', puntosCombinados.size());

var withRandom = puntosCombinados.randomColumn('random', CONFIG.SEMILLA);
var trainSet = withRandom.filter(ee.Filter.lt('random', CONFIG.FRACCION_ENTRENAMIENTO));
var testSet  = withRandom.filter(ee.Filter.gte('random', CONFIG.FRACCION_ENTRENAMIENTO));
print('N° puntos entrenamiento', trainSet.size());
print('N° puntos test held-out', testSet.size());

var puntosValidacion = ee.FeatureCollection(CONFIG.PUNTOS_VALIDACION);
print('N° puntos de validación independiente', puntosValidacion.size());

// ---------------------------------------------------------------------------
// 3) IMÁGENES DEL MES SELECCIONADO
// ---------------------------------------------------------------------------
var rutas = CONFIG.RUTAS_ESPECIALES || {};
var rutaOptico = rutas.optico || (CONFIG.ASSET_OPTICO + '/mediana_' + MES_A_PROCESAR + '_' + CONFIG.ANIO);
var rutaSAR    = rutas.sar    || (CONFIG.ASSET_SAR + '/mediana_S1__' + MES_A_PROCESAR + '_' + CONFIG.ANIO);

var imgOptico = ee.Image(rutaOptico);
var imgSAR_VV = ee.Image(rutaSAR).select('VV');

// ---------------------------------------------------------------------------
// 4) DEFINICIÓN DE LAS RAMAS
// ---------------------------------------------------------------------------
var BANDAS_ESPECTRAL = ['Blue', 'Green', 'Red', 'NIR', 'SWIR1', 'SWIR2'];
var BANDAS_SAR = ['VV'];

var imgRamaEspectral = imgOptico.select(BANDAS_ESPECTRAL).addBands(imgSAR_VV);
var BANDAS_RAMA_ESPECTRAL = BANDAS_ESPECTRAL.concat(BANDAS_SAR);

var imgRamaNDVI = imgOptico.select('NDVI').addBands(imgSAR_VV);
var BANDAS_RAMA_NDVI = ['NDVI'].concat(BANDAS_SAR);

var imgRamaNDWI = imgOptico.select('NDWI').addBands(imgSAR_VV);
var BANDAS_RAMA_NDWI = ['NDWI'].concat(BANDAS_SAR);

// ---------------------------------------------------------------------------
// 5) FUNCIÓN: entrenar RF, SVM y Ensemble para UNA rama
// ---------------------------------------------------------------------------
function procesarRama(imagen, bandas) {
  var trainSample = imagen.select(bandas).sampleRegions({
    collection: trainSet, properties: [CLASS_PROPERTY], scale: CONFIG.ESCALA, tileScale: 4
  });

  var rfClass = ee.Classifier.smileRandomForest(CONFIG.ARBOLES_RF)
      .train({features: trainSample, classProperty: CLASS_PROPERTY, inputProperties: bandas});
  var rfProb = ee.Classifier.smileRandomForest(CONFIG.ARBOLES_RF).setOutputMode('PROBABILITY')
      .train({features: trainSample, classProperty: CLASS_PROPERTY, inputProperties: bandas});

  var svmClass = ee.Classifier.libsvm({kernelType: 'RBF', cost: CONFIG.SVM_COSTO})
      .train({features: trainSample, classProperty: CLASS_PROPERTY, inputProperties: bandas});
  var svmProb = ee.Classifier.libsvm({kernelType: 'RBF', cost: CONFIG.SVM_COSTO}).setOutputMode('PROBABILITY')
      .train({features: trainSample, classProperty: CLASS_PROPERTY, inputProperties: bandas});

  var imgRFclass  = imagen.select(bandas).classify(rfClass);
  var imgRFprob   = imagen.select(bandas).classify(rfProb);
  var imgSVMclass = imagen.select(bandas).classify(svmClass);
  var imgSVMprob  = imagen.select(bandas).classify(svmProb);

  // Ensemble: si difieren, gana el SVM cuando su probabilidad de humedal
  // supera la de RF; en caso contrario se mantiene RF.
  var coincidenImg = imgRFclass.eq(imgSVMclass);
  var imgEnsemble = imgRFclass
      .where(coincidenImg.not().and(imgSVMprob.gt(imgRFprob)), imgSVMclass);

  return {rf: imgRFclass, svm: imgSVMclass, ensemble: imgEnsemble};
}

// ---------------------------------------------------------------------------
// 6) PROCESAR LAS RAMAS — el SAR solo se calcula UNA vez (respaldo común)
// ---------------------------------------------------------------------------
var resultadoSAR       = procesarRama(imgSAR_VV, BANDAS_SAR);
var resultadoEspectral = procesarRama(imgRamaEspectral, BANDAS_RAMA_ESPECTRAL);
var resultadoNDVI      = procesarRama(imgRamaNDVI, BANDAS_RAMA_NDVI);
var resultadoNDWI      = procesarRama(imgRamaNDWI, BANDAS_RAMA_NDWI);

// ---------------------------------------------------------------------------
// 7) MOSAICO FINAL (Fusión > Solo-SAR)
//    La ÚLTIMA imagen de la lista tiene prioridad donde ambas tienen dato.
// ---------------------------------------------------------------------------
function mosaicoFinal(resultadoFusion, resultadoSARLocal, algoritmo, etiquetaRama) {
  return ee.ImageCollection([
    resultadoSARLocal[algoritmo].rename('clase'),  // respaldo
    resultadoFusion[algoritmo].rename('clase')     // prioridad
  ]).mosaic().rename('humedal_' + MES_A_PROCESAR + '_' + etiquetaRama + '_' + algoritmo);
}

// ---------------------------------------------------------------------------
// 8) POST-PROCESAMIENTO — FILTRO "SAL Y PIMIENTA"
//    UMM = (0.0002 x 150.000)² = 900 m² = 1 píxel a 30 m. Se reproyecta a
//    CONFIG.CRS para contar sobre la grilla correcta, ANTES de validar.
// ---------------------------------------------------------------------------
var UMM_M2 = Math.pow(CONFIG.UMM_FACTOR * CONFIG.UMM_ESCALA, 2);
var TAMANO_MINIMO_PIXELES = UMM_M2 / (CONFIG.ESCALA * CONFIG.ESCALA);

function filtroSalPimienta(imagenClasificada, tamanoMinimo) {
  var img_utm = imagenClasificada.reproject({crs: CONFIG.CRS, scale: CONFIG.ESCALA});
  var conteoGrupo = img_utm.connectedPixelCount(tamanoMinimo + 1, true);
  var esGrupoChico = conteoGrupo.lte(tamanoMinimo);
  var moda = img_utm.focal_mode(1, 'square', 'pixels');
  return img_utm.where(esGrupoChico, moda).rename(imagenClasificada.bandNames());
}

// ---------------------------------------------------------------------------
// 9) LOS 9 PRODUCTOS FINALES
// ---------------------------------------------------------------------------
var ramas = [
  {res: resultadoEspectral, nombre: 'espectral', etiqueta: 'ESPECTRAL'},
  {res: resultadoNDVI,      nombre: 'ndvi',      etiqueta: 'NDVI'},
  {res: resultadoNDWI,      nombre: 'ndwi',      etiqueta: 'NDWI'}
];
var algoritmos = [
  {clave: 'rf', etiqueta: 'RF'}, {clave: 'svm', etiqueta: 'SVM'}, {clave: 'ensemble', etiqueta: 'ENSEMBLE'}
];

var productos = [];
ramas.forEach(function (r) {
  algoritmos.forEach(function (a) {
    productos.push({
      img: filtroSalPimienta(mosaicoFinal(r.res, resultadoSAR, a.clave, r.nombre), TAMANO_MINIMO_PIXELES),
      banda: 'humedal_' + MES_A_PROCESAR + '_' + r.nombre + '_' + a.clave,
      etiqueta: r.etiqueta + ' + ' + a.etiqueta
    });
  });
});

// ---------------------------------------------------------------------------
// 10) VALIDACIÓN — Overall Accuracy y F1
// ---------------------------------------------------------------------------
function calcularF1(errorMatrix) {
  var precisionT = errorMatrix.consumersAccuracy().transpose();
  var recall = errorMatrix.producersAccuracy();
  return precisionT.multiply(recall).multiply(2).divide(precisionT.add(recall));
}

function validar(imagenFinal, nombreBanda, etiqueta, coleccionValidacion, etiquetaSet) {
  var muestra = imagenFinal.sampleRegions({
    collection: coleccionValidacion, properties: [CLASS_PROPERTY], scale: CONFIG.ESCALA, tileScale: 4
  });
  var errorMatrix = muestra.errorMatrix(CLASS_PROPERTY, nombreBanda);
  var f1 = calcularF1(errorMatrix);

  print('=== ' + etiqueta + ' [' + etiquetaSet + '] ===');
  print('Overall Accuracy', errorMatrix.accuracy());
  print('F1-score [no-humedal, humedal]', f1);
}

productos.forEach(function (p) {
  validar(p.img, p.banda, p.etiqueta, testSet, '10% held-out');
  validar(p.img, p.banda, p.etiqueta, puntosValidacion, 'validación independiente');
});

// ---------------------------------------------------------------------------
// 11) VISUALIZACIÓN
// ---------------------------------------------------------------------------
var visClasificacion = {min: 0, max: 1, palette: ['d9d9d9', '2166ac']};
Map.centerObject(roi, 9);
productos.forEach(function (p, i) {
  Map.addLayer(p.img.clip(roi), visClasificacion, 'FINAL - ' + p.etiqueta, i === 0);
});

// ---------------------------------------------------------------------------
// 12) EXPORTAR LOS 9 PRODUCTOS A ASSET
// ---------------------------------------------------------------------------
productos.forEach(function (p) {
  Export.image.toAsset({
    image: p.img.clip(roi),
    description: 'export_' + p.banda,
    assetId: CONFIG.ASSET_SALIDA + '/' + p.banda,
    region: roi,
    scale: CONFIG.ESCALA,
    crs: CONFIG.CRS,
    maxPixels: 1e13
  });
});
