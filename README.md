# RUTEO

Aplicación web para planificar recorridos con un punto de partida, un punto final, fecha y hora programadas.

## Funciones actuales

- Selección de origen y destino mediante búsqueda o clic sobre el mapa.
- Cálculo de distancia, duración y trazado de la ruta.
- Registro de la fecha y hora del recorrido.
- Historial local de las últimas 20 rutas.
- Diseño adaptable para computador y teléfono.

## Ejecutar localmente

La aplicación no requiere instalación. Por las políticas del navegador para consultas externas, se recomienda servirla con un servidor local:

```bash
python -m http.server 8080
```

Después abre `http://localhost:8080`.

## Servicios cartográficos

Este MVP utiliza OpenStreetMap, Nominatim y el servidor público de OSRM. Para producción se deben configurar servicios con capacidad y condiciones de uso apropiadas al tráfico esperado.
