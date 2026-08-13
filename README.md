# RUTEO

Aplicación web progresiva para grabar recorridos con el GPS del celular y planificar rutas con un punto de partida, un punto final, fecha y hora programadas.

## Funciones actuales

- Captura GPS continua del recorrido mientras el usuario avanza.
- Inicio, pausa, continuación y finalización de la grabación.
- Distancia, tiempo, precisión y puntos GPS en vivo.
- Recuperación de una captura sin finalizar y almacenamiento local.
- Selección de origen y destino mediante búsqueda o clic sobre el mapa.
- Cálculo de distancia, duración y trazado de la ruta.
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

Este MVP utiliza OpenStreetMap, Nominatim y el servidor público de OSRM. Para producción se deben configurar servicios con capacidad y condiciones de uso apropiadas al tráfico esperado.
