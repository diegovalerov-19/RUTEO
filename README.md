# RUTEO

Aplicación web progresiva para grabar recorridos con el GPS del celular y planificar rutas con un punto de partida, un punto final, fecha y hora programadas.

## Funciones actuales

- Captura GPS continua del recorrido mientras el usuario avanza.
- Inicio, pausa, continuación y finalización de la grabación.
- Distancia, tiempo, precisión y puntos GPS en vivo.
- Recuperación de una captura sin finalizar y almacenamiento local.
- Simulación animada de recorridos guardados con vehículo, progreso y controles compactos; la descripción larga permanece recogida y la página se desplaza automáticamente al mapa.
- Simulación animada de rutas planificadas usando toda la geometría calculada.
- Selección de origen y destino mediante búsqueda o clic sobre el mapa.
- Cálculo de distancia, duración y trazado de la ruta.
- Mapa oficial de Google Maps mediante una API key configurada en el dispositivo, con OpenStreetMap como respaldo.
- Descarga de coordenadas en CSV, KML y Shapefile (ZIP con SHP, SHX, DBF, PRJ y CPG).
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
