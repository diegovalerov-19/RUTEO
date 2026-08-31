# RUTEO

Aplicación web progresiva para grabar recorridos con el GPS del celular y planificar rutas con un punto de partida, un punto final, fecha y hora programadas.

## Funciones actuales

- Captura GPS continua del recorrido mientras el usuario avanza.
- Inicio, pausa, continuación y finalización de la grabación.
- Distancia, tiempo, precisión y puntos GPS en vivo.
- Recuperación de una captura sin finalizar y almacenamiento local.
- Simulación animada con controles verticales compactos en la esquina inferior izquierda, localización GPS manual y desplazamiento automático al mapa.
- Camión recolector blanco visto desde arriba como marcador de la simulación y botón grande para recuperar los controles en el lado izquierdo del mapa.
- Identificación visible del vehículo como camión de basuras y créditos de las personas que desarrollaron la aplicación.
- Puntos obligatorios ordenados para que una ruta planificada pase por coordenadas o direcciones intermedias antes de llegar al destino.
- Optimización de rutas por etapas que compara alternativas y aplica una penalización blanda de 5× a los tramos ya utilizados, respetando siempre el orden de los puntos obligatorios y permitiendo retornos por callejones sin salida.
- Créditos siempre visibles en la versión de escritorio y camión de simulación reducido para no ocultar el mapa.
- Adición directa de puntos obligatorios tocando el mapa después del origen y el destino, manteniendo su orden de selección.
- Camión de simulación reducido nuevamente a un tercio de su tamaño anterior.
- Panel compacto y desplegable en el lado izquierdo del mapa con distancia y tiempo estimado para cada tramo entre origen, puntos obligatorios y destino.
- En Android, los cuadros de tramos y simulación se muestran en una franja compacta debajo del mapa y encima del encabezado institucional para no ocultar la ruta.
- La franja mantiene ambos controles juntos también en pantallas anchas y el camión de simulación aumenta moderadamente de 13 px a 18 px.
- El origen y el destino aceptan direcciones o coordenadas, pueden reemplazarse tocando el mapa y el panel de tramos se puede cerrar.
- El camión de la simulación duplica su tamaño de 18 px a 36 px para facilitar su seguimiento.
- El origen y el destino incluyen un botón para usar la ubicación GPS actual del dispositivo tanto en Android como en el navegador web.
- Durante una grabación se pueden marcar puntos numerados con la ubicación GPS actual; se conservan en el mapa, el historial y las exportaciones CSV/KML.
- Al finalizar, abrir o simular una ruta, el trazado muestra un degradado progresivo de velocidad: rojo para 0–15 km/h, amarillo para 15–35 km/h y verde para más de 35 km/h.
- El cuadro desplegable **Velocidades**, ubicado debajo de **Tramos**, muestra la velocidad promedio total, el tiempo acumulado en cada rango y la leyenda de colores; inicia minimizado y puede cerrarse.
- La captura detecta pérdidas temporales de GPS, mantiene la velocidad promedio previa sin inventar coordenadas, reinicia la media al marcar una parada y suaviza las lecturas cuando regresa la señal.
- La velocidad actual se muestra durante la grabación y las lecturas atípicas se filtran antes de almacenarlas para evitar picos irreales.
- La simulación reproduce el recorrido en tiempo real al seleccionar 1×, sin límite de 90 segundos; también ofrece 2×, 4× y 10× para acelerar recorridos largos.
- Simulación animada de rutas planificadas usando toda la geometría calculada.
- Selección de origen y destino mediante búsqueda o clic sobre el mapa.
- Cálculo de distancia, duración y trazado de la ruta.
- Mapa oficial de Google Maps mediante una API key configurada en el dispositivo, con OpenStreetMap como respaldo.
- Descarga de coordenadas en CSV, KML y Shapefile (ZIP con SHP, SHX, DBF, PRJ y CPG).
- Importación desde el planificador de CSV, Excel, Shapefile ZIP, GeoJSON, GPX, KML y KMZ, con vista previa, mapeo de columnas y reporte de registros válidos u omitidos. Los CSV exportados por RUTEO reconstruyen las filas `TRAZA` como una línea continua y conservan únicamente las filas `MARCADO` como puntos visibles.
- Los recorridos CSV con `fecha_hora` y `velocidad_m_s` se pueden simular directamente desde el cargador; el camión avanza con la cronología y las velocidades originales de cada tramo.
- Dentro de **Cargue aquí su ruta**, el análisis GIS genera una capa de densidad de paradas con un radio preciso de 5 m: detecta automáticamente los puntos fijos o marcados de un archivo ya cargado, también permite usar los puntos obligatorios del planificador, crea una rejilla vectorizada, clasifica concentraciones Alta/Media/Baja y permite descargar `capa_raster_densidad_5m.geojson`.
- El panel compacto **Capas**, ubicado debajo de los controles del camión, permite minimizar y ocultar o mostrar independientemente el recorrido importado y el ráster sin borrar sus datos.
- Al calcular una ruta, la aplicación conserva activa la pestaña **Planificar ruta**. Al cargar puntos fijos, el ráster de 5 m enfoca automáticamente el hotspot principal con contraste reforzado para que sus celdas sean visibles.
- Registro de la fecha y hora del recorrido.
- Historial local de las últimas 20 rutas.
- Diseño adaptable para computador y teléfono.
- Instalación como PWA desde Chrome para Android.

## Ejecutar localmente

La aplicación no requiere instalación. Por las políticas del navegador para consultas externas, se recomienda servirla con un servidor local:

```bash
python -m http.server 8080
```

Después abre `http://localhost:8080`.

## Captura GPS en Android

La geolocalización requiere HTTPS, por lo que debe usarse la dirección publicada con GitHub Pages. Al iniciar una captura, acepta el permiso de ubicación y mantén la aplicación visible. Los navegadores móviles pueden suspender el GPS si se apaga la pantalla o la aplicación pasa a segundo plano; Ruteo solicita mantener la pantalla encendida cuando el dispositivo lo permite.

## Servicios cartográficos

La aplicación puede utilizar Google Maps como mapa base. Pulsa **Activar Google Maps**, pega una API key con **Maps JavaScript API** habilitada y restríngela al sitio `https://diegovalerov-19.github.io/*`. La clave se guarda solo en `localStorage` del navegador y no se publica en el repositorio.

Si no se configura una clave o Google Maps no carga, se utiliza OpenStreetMap como respaldo. El cálculo de rutas sigue usando el servidor público de OSRM; para producción se debe contratar o desplegar un servicio con capacidad y condiciones de uso apropiadas al tráfico esperado.

## Exportación de rutas

Cada recorrido con al menos dos coordenadas ofrece tres descargas:

- **CSV:** una fila por coordenada, incluyendo fecha/hora, precisión, altitud y velocidad cuando provienen del GPS.
- **KML:** línea compatible con Google Earth y programas SIG.
- **SHP:** archivo ZIP con el conjunto Shapefile completo en WGS 84 (EPSG:4326).

Las rutas planificadas creadas antes de esta actualización no contienen su geometría completa. Deben calcularse nuevamente para poder simularlas o descargarlas.

## Importación de rutas

El botón **Cargue aquí su ruta**, ubicado al final del planificador, procesa los archivos en el navegador y produce una colección GeoJSON en WGS 84. Los puntos importados se aplican como origen, paradas obligatorias ordenadas y destino. Las líneas con muchos vértices se resumen en hasta diez controles distribuidos sobre el trazado antes de calcular la ruta vial.

- CSV se analiza sin dependencias externas y Excel utiliza SheetJS 0.20.3.
- Los Shapefile ZIP se leen con shpjs 6.2.0, incluyendo la reproyección declarada en el archivo PRJ.
- GeoJSON usa su miembro `crs` cuando existe; CSV y Excel permiten escribir el EPSG de origen.
- GPX y KML se procesan con el analizador XML del módulo; KMZ se descomprime con fflate 0.8.2.
- Las reproyecciones adicionales usan Proj4js 2.21.0 y definiciones EPSG cuando sean necesarias.
- Cada importación valida longitud entre −180 y 180, latitud entre −90 y 90, omite registros corruptos y presenta un reporte sin interrumpir los demás registros.

Las librerías de Excel, Shapefile, KMZ y reproyección se cargan bajo demanda para no aumentar el peso inicial de la PWA.

