/**
 * 04_clasificacion_anual_temporal.js
 * ============================================================================
 * QUÉ HACE
 *   Clasifica humedal / no humedal para TODO el año usando la serie de 12
 *   meses. Se prueban dos ramas de entrada:
 *     - NDVI (12 meses) + radar VV (12 meses)
 *     - NDWI (12 meses) + radar VV (12 meses)
 *   y tres algoritmos por rama: Random Forest (RF), SVM y un Ensemble.
 *   Resultado: 6 mapas finales, con métricas de exactitud (Overall Accuracy
 *   y F1) contra dos conjuntos de puntos independientes.
 *
 * REQUISITOS PREVIOS (ejecutar antes)
 *   - Script 01 para los 12 meses  -> <ASSET_SAR>/mediana_S1__<mes>_<anio>
 *   - Script 02 para los 12 meses  -> <ASSET_OPTICO>/mediana_<mes>_<anio>
 *   - Script 03 (o tus propios puntos) -> tablas de puntos con la propiedad
 *     'humedal_final' (0 = no humedal, 1 = humedal).
 *
 * CÓMO USARLO
 *   1. Edita SOLO el bloque CONFIG.
 *   2. Ejecuta: revisa las métricas en la consola y lanza las exportaciones
 *      desde "Tasks".
 *
 * NOTAS
 *   - Respaldo con radar: donde la fusión no tiene dato válido (por ejemplo,
 *     por nubes todo el año), se usa la clasificación solo con radar.
 *   - Ensemble: si RF y SVM coinciden se conserva la clase; si difieren, se
 *     toma la clase del SVM cuando su probabilidad de humedal supera la de RF
 *     (ver comentario en procesarRama).
 *   - Filtro "sal y pimienta": reemplaza grupos de píxeles menores a la
 *     Unidad Mínima de Mapeo (UMM) por la moda de su vecindario.
 * ============================================================================
 */

// ============================ CONFIG ========================================
var CONFIG = {
  ROI_ASSET: 'projects/TU_PROYECTO/assets/cuenca_altiplano',
  ANIO: 2020,

  // Carpetas de Assets con los mosaicos mensuales (scripts 01 y 02)
  ASSET_OPTICO: 'projects/TU_PROYECTO/assets/mosaicos_opticos',  // mediana_<mes>_<anio>
  ASSET_SAR:    'projects/TU_PROYECTO/assets/mosaicos_sar',      // mediana_S1__<mes>_<anio>
  // Opcional: si algún mes está en otra ruta, indícalo aquí. Ejemplo:
  // {febrero: {optico: 'projects/otro/assets/mediana_febrero_2020', sar: '...'}}
  RUTAS_ESPECIALES: {},

  // Puntos (propiedad CLASE = 0/1). Se pueden dar varias tablas de entrenamiento.
  PUNTOS_ENTRENAMIENTO: [
    'projects/TU_PROYECTO/assets/PuntosEntrenamiento_Humedales_2020'
    // , 'projects/TU_PROYECTO/assets/PuntosEntrenamiento_Nuevos_2020'
  ],
  PUNTOS_VALIDACION: 'projects/TU_PROYECTO/assets/PuntosValidacion_2020',  // independientes
  CLASE: 'humedal_final',
  FRACCION_ENTRENAMIENTO: 0.9,   // el resto queda como validación "held-out"
  SEMILLA: 42,

  // Clasificadores
  ARBOLES_RF: 100,
  SVM_COSTO: 10,                 // kernel RBF

  // Salidas
  ESCALA: 30,
  CRS: 'EPSG:32719',
  ASSET_SALIDA: 'projects/TU_PROYECTO/assets/Clasificacion_Temporal_2020',
  DRIVE_CARPETA: 'GEE_exports',
  EXPORTAR_DRIVE: true,
  EXPORTAR_ASSET: true,

  // Unidad Mínima de Mapeo: (0.0002 x denominador de escala)^2 en m²
  UMM_FACTOR: 0.0002,
  UMM_ESCALA: 150000             // 1:150.000 -> 30 m -> 900 m² (1 píxel a 30 m)
};
// ============================================================================

var NOMBRES_MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
                     'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

// ---------------------------------------------------------------------------
// 1) ROI
// ---------------------------------------------------------------------------
var roi = ee.FeatureCollection(CONFIG.ROI_ASSET).geometry();

// ---------------------------------------------------------------------------
// 2) MESES -> RUTAS DE ASSETS (óptico y SAR)
// ---------------------------------------------------------------------------
var MESES = NOMBRES_MESES.map(function (nombre) {
  var esp = CONFIG.RUTAS_ESPECIALES[nombre] || {};
  return {
    clave: nombre,
    optico: esp.optico || (CONFIG.ASSET_OPTICO + '/mediana_' + nombre + '_' + CONFIG.ANIO),
    sar:    esp.sar    || (CONFIG.ASSET_SAR + '/mediana_S1__' + nombre + '_' + CONFIG.ANIO)
  };
});

var mosaicosOpticos = {};
var mosaicosSAR = {};
MESES.forEach(function (m) {
  mosaicosOpticos[m.clave] = ee.Image(m.optico);
  mosaicosSAR[m.clave]     = ee.Image(m.sar);
});

// ---------------------------------------------------------------------------
// 3) PUNTOS — entrenamiento (90%), validación held-out (10%) e independiente
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
// 4) STACKS TEMPORALES (12 meses) — NDVI, NDWI, SAR-VV
// ---------------------------------------------------------------------------
var stackNDVI = ee.Image.cat(
  MESES.map(function (m) { return mosaicosOpticos[m.clave].select('NDVI').rename('NDVI_' + m.clave); })
);
var stackNDWI = ee.Image.cat(
  MESES.map(function (m) { return mosaicosOpticos[m.clave].select('NDWI').rename('NDWI_' + m.clave); })
);
var stackSAR_VV = ee.Image.cat(
  MESES.map(function (m) { return mosaicosSAR[m.clave].select('VV').rename('VV_' + m.clave); })
);

var BANDAS_SAR_TEMPORAL = stackSAR_VV.bandNames();

var imgFusionNDVI = stackNDVI.addBands(stackSAR_VV);
var BANDAS_FUSION_NDVI = imgFusionNDVI.bandNames();

var imgFusionNDWI = stackNDWI.addBands(stackSAR_VV);
var BANDAS_FUSION_NDWI = imgFusionNDWI.bandNames();

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
  var imgRFprob   = imagen.select(bandas).classify(rfProb);   // probabilidad de la clase 1 (humedal)
  var imgSVMclass = imagen.select(bandas).classify(svmClass);
  var imgSVMprob  = imagen.select(bandas).classify(svmProb);  // probabilidad de la clase 1 (humedal)

  // Ensemble: si RF y SVM difieren, gana el SVM cuando su probabilidad de
  // humedal es mayor que la de RF; en caso contrario se mantiene RF.
  var coincidenImg = imgRFclass.eq(imgSVMclass);
  var imgEnsemble = imgRFclass
      .where(coincidenImg.not().and(imgSVMprob.gt(imgRFprob)), imgSVMclass);

  return {rf: imgRFclass, svm: imgSVMclass, ensemble: imgEnsemble};
}

// ---------------------------------------------------------------------------
// 6) PROCESAR LAS RAMAS — el SAR temporal se calcula UNA vez y sirve de
//    respaldo para las dos ramas ópticas (NDVI y NDWI)
// ---------------------------------------------------------------------------
var resultadoSARTemporal = procesarRama(stackSAR_VV, BANDAS_SAR_TEMPORAL);
var resultadoFusionNDVI  = procesarRama(imgFusionNDVI, BANDAS_FUSION_NDVI);
var resultadoFusionNDWI  = procesarRama(imgFusionNDWI, BANDAS_FUSION_NDWI);

// ---------------------------------------------------------------------------
// 7) MOSAICO FINAL (Fusión > Solo-SAR)
//    En ee.ImageCollection([...]).mosaic(), la ÚLTIMA imagen de la lista tiene
//    prioridad donde ambas tienen dato válido.
// ---------------------------------------------------------------------------
function mosaicoFinal(resultadoFusion, resultadoSARLocal, algoritmo, etiquetaIndice) {
  return ee.ImageCollection([
    resultadoSARLocal[algoritmo].rename('clase'),  // respaldo
    resultadoFusion[algoritmo].rename('clase')     // prioridad
  ]).mosaic().rename('humedal_temporal_' + CONFIG.ANIO + '_' + etiquetaIndice + '_' + algoritmo);
}

// ---------------------------------------------------------------------------
// 8) POST-PROCESAMIENTO — FILTRO "SAL Y PIMIENTA" (UMM)
// ---------------------------------------------------------------------------
var UMM_M2 = Math.pow(CONFIG.UMM_FACTOR * CONFIG.UMM_ESCALA, 2);           // 900 m²
var TAMANO_MINIMO_PIXELES = UMM_M2 / (CONFIG.ESCALA * CONFIG.ESCALA);      // 1 píxel

function filtroSalPimienta(imagenClasificada, tamanoMinimo) {
  var conteoGrupo = imagenClasificada.connectedPixelCount(tamanoMinimo + 1, true);
  var esGrupoChico = conteoGrupo.lte(tamanoMinimo);
  var moda = imagenClasificada.focal_mode(1, 'square', 'pixels');
  return imagenClasificada.where(esGrupoChico, moda).rename(imagenClasificada.bandNames());
}

// ---------------------------------------------------------------------------
// 9) LOS 6 PRODUCTOS FINALES (enteros tipo Byte, compatibles con ArcGIS/QGIS)
// ---------------------------------------------------------------------------
function prepararResultadoFinal(mosaico, nombreBanda) {
  return filtroSalPimienta(mosaico, TAMANO_MINIMO_PIXELES)
    .toInt()
    .toByte()
    .rename(nombreBanda);
}

var anio = CONFIG.ANIO;
var final_NDVI_RF = prepararResultadoFinal(
  mosaicoFinal(resultadoFusionNDVI, resultadoSARTemporal, 'rf', 'ndvi'), 'humedal_temporal_' + anio + '_ndvi_rf');
var final_NDVI_SVM = prepararResultadoFinal(
  mosaicoFinal(resultadoFusionNDVI, resultadoSARTemporal, 'svm', 'ndvi'), 'humedal_temporal_' + anio + '_ndvi_svm');
var final_NDVI_Ensemble = prepararResultadoFinal(
  mosaicoFinal(resultadoFusionNDVI, resultadoSARTemporal, 'ensemble', 'ndvi'), 'humedal_temporal_' + anio + '_ndvi_ensemble');
var final_NDWI_RF = prepararResultadoFinal(
  mosaicoFinal(resultadoFusionNDWI, resultadoSARTemporal, 'rf', 'ndwi'), 'humedal_temporal_' + anio + '_ndwi_rf');
var final_NDWI_SVM = prepararResultadoFinal(
  mosaicoFinal(resultadoFusionNDWI, resultadoSARTemporal, 'svm', 'ndwi'), 'humedal_temporal_' + anio + '_ndwi_svm');
var final_NDWI_Ensemble = prepararResultadoFinal(
  mosaicoFinal(resultadoFusionNDWI, resultadoSARTemporal, 'ensemble', 'ndwi'), 'humedal_temporal_' + anio + '_ndwi_ensemble');

// ---------------------------------------------------------------------------
// 10) VALIDACIÓN — Overall Accuracy y F1 con el 10% held-out y con los
//     puntos de validación independientes
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

var productos = [
  {img: final_NDVI_RF,       banda: 'humedal_temporal_' + anio + '_ndvi_rf',       etiqueta: 'NDVI TEMPORAL + RF'},
  {img: final_NDVI_SVM,      banda: 'humedal_temporal_' + anio + '_ndvi_svm',      etiqueta: 'NDVI TEMPORAL + SVM'},
  {img: final_NDVI_Ensemble, banda: 'humedal_temporal_' + anio + '_ndvi_ensemble', etiqueta: 'NDVI TEMPORAL + ENSEMBLE'},
  {img: final_NDWI_RF,       banda: 'humedal_temporal_' + anio + '_ndwi_rf',       etiqueta: 'NDWI TEMPORAL + RF'},
  {img: final_NDWI_SVM,      banda: 'humedal_temporal_' + anio + '_ndwi_svm',      etiqueta: 'NDWI TEMPORAL + SVM'},
  {img: final_NDWI_Ensemble, banda: 'humedal_temporal_' + anio + '_ndwi_ensemble', etiqueta: 'NDWI TEMPORAL + ENSEMBLE'}
];

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
// 12) EXPORTAR LOS 6 PRODUCTOS FINALES
// ---------------------------------------------------------------------------
productos.forEach(function (p) {
  if (CONFIG.EXPORTAR_DRIVE) {
    Export.image.toDrive({
      image: p.img.clip(roi),
      description: 'export_' + p.banda,
      folder: CONFIG.DRIVE_CARPETA,
      fileNamePrefix: p.banda,
      region: roi,
      scale: CONFIG.ESCALA,
      crs: CONFIG.CRS,
      maxPixels: 1e13
    });
  }
  if (CONFIG.EXPORTAR_ASSET) {
    Export.image.toAsset({
      image: p.img.clip(roi),
      description: 'export_' + p.banda + '_asset',
      assetId: CONFIG.ASSET_SALIDA + '/' + p.banda,
      region: roi,
      scale: CONFIG.ESCALA,
      crs: CONFIG.CRS,
      maxPixels: 1e13,
      pyramidingPolicy: {'.default': 'mode'}
    });
  }
});
