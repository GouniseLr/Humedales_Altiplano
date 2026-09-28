# Mapeo de humedales del Altiplano boliviano con Google Earth Engine

**Autor:** Gonzalo López Romero · Escuela Militar de Ingeniería

Scripts de **Google Earth Engine (GEE)** para mapear humedales en la cuenca del Altiplano boliviano combinando imágenes ópticas (Landsat + Sentinel-2) y de radar (Sentinel-1). Nacieron de un Trabajo de Grado sobre cartografía de humedales y están pensados para adaptarse a otras cuencas.

## ¿Qué hace este proyecto?

1. Junta varios mapas globales de agua y humedales para crear un **mapa de referencia**.
2. Prepara **mosaicos mensuales** de radar y de imágenes ópticas.
3. Entrena clasificadores para decidir, píxel a píxel, si hay **humedal o no**, ya sea para **un mes** o para **todo el año**.
4. Mide qué tan buenos son los mapas resultantes.

## Scripts

| # | Script | Para qué sirve | Salida |
|---|--------|----------------|--------|
| 03 | `03_mapa_coincidencia_humedales.js` | Cruza 8 mapas globales y crea el mapa de referencia y los puntos de entrenamiento | Mapa de coincidencia (0–8), mapa final, puntos |
| 01 | `01_mosaicos_sar_sentinel1.js` | Mosaico mensual de radar (VV y VH) | `mediana_S1__<mes>_<año>` |
| 02 | `02_mosaicos_opticos_hls.js` | Mosaico mensual óptico con índices (NDVI, NDWI, etc.) | `mediana_<mes>_<año>` |
| 04 | `04_clasificacion_anual_temporal.js` | Clasificación de todo el año (12 meses juntos) | 6 mapas |
| 05 | `05_clasificacion_mensual.js` | Clasificación de un solo mes | 9 mapas |

## Los scripts, explicados brevemente

**03 · Mapa de coincidencia.** Hay varios mapas globales que dicen dónde hay agua y humedales, pero no siempre coinciden. Este script los pone juntos y cuenta, para cada punto del terreno, cuántos de los 8 mapas marcan humedal. Donde coinciden casi todos, se considera humedal seguro; donde hay dudas, se descarta. El resultado sirve como "respuesta de ejemplo" para enseñar a los clasificadores.

**01 · Mosaicos de radar.** Toma las imágenes de radar de Sentinel-1 de un mes y las convierte en una sola imagen limpia: corrige el efecto de las montañas, reduce el ruido y compensa las diferencias de ángulo. El radar atraviesa las nubes, por lo que aporta información donde las imágenes ópticas fallan.

**02 · Mosaicos ópticos.** Toma las imágenes de Landsat y Sentinel-2 de un mes, quita nubes y sombras, y las resume en una sola imagen. Además calcula índices que resaltan la vegetación (NDVI) y el agua (NDWI), entre otros.

**04 · Clasificación anual.** Usa los 12 meses a la vez para decidir si cada píxel es humedal o no. Mirar todo el año ayuda a distinguir un humedal, que cambia con las estaciones, de un suelo seco. Genera 6 mapas y calcula qué tan acertados son.

**05 · Clasificación mensual.** Hace lo mismo, pero para un solo mes. Sirve para ver cómo cambian los humedales durante el año. Genera 9 mapas y calcula qué tan acertados son.

## Orden recomendado

```
03  →  01 y 02 (repetir para los 12 meses)  →  04 (año) y/o 05 (mes)
```

## Cómo empezar

1. Necesitas una cuenta de [Google Earth Engine](https://earthengine.google.com/) y una carpeta de Assets propia.
2. Sube tu **zona de estudio** como Asset (un polígono, `FeatureCollection`).
3. Abre un script en el [Code Editor](https://code.earthengine.google.com/) (copia y pega el contenido).
4. Edita **solo el bloque `CONFIG`** del inicio: reemplaza `TU_PROYECTO` por tu proyecto y ajusta año, mes y rutas.
5. Ejecuta y lanza las exportaciones desde la pestaña **Tasks**.

> Cada script se puede usar por separado, pero los scripts 04 y 05 dependen de que los Assets de los scripts 01, 02 y 03 ya existan.

## Nombres de Assets esperados

Los scripts 04 y 05 buscan los mosaicos con estos nombres, por eso conviene no cambiarlos:

```
<ASSET_OPTICO>/mediana_enero_2020, mediana_febrero_2020, ... mediana_diciembre_2020
<ASSET_SAR>/mediana_S1__enero_2020, mediana_S1__febrero_2020, ... (con doble guion bajo)
```

Si algún mes está en otra carpeta, se indica en `CONFIG.RUTAS_ESPECIALES`.

## Puntos de entrenamiento y validación

Son tablas (`FeatureCollection`) con puntos y una propiedad llamada `humedal_final`:

- `1` = humedal
- `0` = no humedal

El script 03 puede generar los puntos de entrenamiento (`GENERAR_PUNTOS = true`). Los puntos de **validación independiente** conviene etiquetarlos a mano (por ejemplo, con imágenes de alta resolución o datos de campo), para que la evaluación sea honesta.

## Mini glosario

- **Sentinel-1 (SAR):** satélite de radar; "ve" a través de las nubes y detecta agua en la superficie.
- **HLS:** imágenes ópticas de Landsat y Sentinel-2 combinadas para que se parezcan entre sí.
- **NDVI:** indica cuánta vegetación verde hay.
- **NDWI:** resalta el agua.
- **Random Forest y SVM:** dos métodos de aprendizaje automático que aprenden de ejemplos para clasificar.
- **Ensemble:** combina las respuestas de Random Forest y SVM.
- **Mediana:** valor central de todas las imágenes de un mes; reduce el efecto de nubes y ruido.

## Datos que se usan (todos vía GEE)

ESRI 10m Land Cover · GLAD Global Surface Water Dynamics v2 · ESA WorldCover · GWL_FCS30 · GLWD v2 · JRC Global Surface Water · GLC_FCS30D · MapBiomas Bolivia · NASA HLS (L30/S30) · Copernicus Sentinel-1 GRD · SRTM (USGS).

Algunos están en el catálogo comunitario (`projects/sat-io/...`). Consulta la licencia y la forma de citar de cada producto antes de publicar resultados.

## Limitaciones conocidas

- Las rutas de Assets son ejemplos: hay que reemplazarlas por las tuyas.
- El mapa de referencia depende de 8 productos externos; sus errores se heredan.
- En radar, el relieve de la Cordillera y la mezcla de órbitas pueden dejar costuras visibles.
- Con el tiempo, GEE puede cambiar nombres o versiones de datasets: si un Asset no carga, revisa su página en el catálogo.

## Estructura del repositorio

```
├── README.md
├── LICENSE
├── .gitignore
└── scripts/
    ├── 01_mosaicos_sar_sentinel1.js
    ├── 02_mosaicos_opticos_hls.js
    ├── 03_mapa_coincidencia_humedales.js
    ├── 04_clasificacion_anual_temporal.js
    └── 05_clasificacion_mensual.js
```

## Cómo citar

Si usas estos scripts, cita el repositorio y el trabajo asociado:

> López Romero, G. (2026). *Mapeo de humedales del Altiplano boliviano con Google Earth Engine.* Trabajo de Grado, Escuela Militar de Ingeniería. Repositorio: https://github.com/GouniseLr/Humedales_Altiplano

## Licencia

MIT (ver `LICENSE`).
