(function (global) {
  "use strict";

  function asPoint(value) {
    if (Array.isArray(value)) return { lat: Number(value[0]), lng: Number(value[1]) };
    if (value?.lat instanceof Function) return { lat: Number(value.lat()), lng: Number(value.lng()) };
    return { lat: Number(value.lat), lng: Number(value.lng) };
  }

  function validPoints(points) {
    return (points || []).map(asPoint).filter(point => Number.isFinite(point.lat) && Number.isFinite(point.lng));
  }

  function loadGoogleMaps(apiKey, onAuthFailure) {
    if (global.google?.maps) return Promise.resolve(global.google.maps);
    if (global.__ruteoGoogleMapsPromise) return global.__ruteoGoogleMapsPromise;

    global.__ruteoGoogleMapsPromise = new Promise((resolve, reject) => {
      const callbackName = `__ruteoGoogleMapsReady${Date.now()}`;
      const script = document.createElement("script");
      const timeout = global.setTimeout(() => reject(new Error("Google Maps tardó demasiado en responder.")), 15000);

      global.gm_authFailure = () => {
        onAuthFailure?.();
        reject(new Error("La clave de Google Maps fue rechazada."));
      };
      global[callbackName] = () => {
        global.clearTimeout(timeout);
        delete global[callbackName];
        resolve(global.google.maps);
      };
      script.async = true;
      script.defer = true;
      script.onerror = () => {
        global.clearTimeout(timeout);
        reject(new Error("No fue posible cargar Google Maps."));
      };
      script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&loading=async&v=weekly&language=es&region=CO&callback=${callbackName}`;
      document.head.appendChild(script);
    });

    return global.__ruteoGoogleMapsPromise;
  }

  class LeafletPolyline {
    constructor(map, points, options) {
      this.map = map;
      this.layer = global.L.polyline(validPoints(points).map(point => [point.lat, point.lng]), {
        color: options.color,
        weight: options.weight,
        opacity: options.opacity,
        dashArray: options.dashArray
      }).addTo(map.raw);
    }
    addPoint(point) { const value = asPoint(point); this.layer.addLatLng([value.lat, value.lng]); }
    setPoints(points) { this.layer.setLatLngs(validPoints(points).map(point => [point.lat, point.lng])); }
    getPoints() { return this.layer.getLatLngs().map(asPoint); }
    remove() { this.map.raw.removeLayer(this.layer); }
    isVisible() { return this.map.raw.hasLayer(this.layer); }
  }

  class LeafletCircleMarker {
    constructor(map, point, options) {
      this.map = map;
      this.layer = global.L.circleMarker(asPoint(point), {
        radius: options.radius || 8,
        color: options.strokeColor || "#ffffff",
        weight: options.strokeWeight || 3,
        fillColor: options.fillColor || "#111111",
        fillOpacity: options.fillOpacity ?? 1
      }).addTo(map.raw);
      if (options.title) this.layer.bindPopup(options.title);
    }
    setPosition(point) { this.layer.setLatLng(asPoint(point)); }
    remove() { this.map.raw.removeLayer(this.layer); }
    isVisible() { return this.map.raw.hasLayer(this.layer); }
  }

  class LeafletCircle {
    constructor(map, point, options) {
      this.map = map;
      this.layer = global.L.circle(asPoint(point), {
        radius: options.radius || 1,
        color: options.strokeColor,
        weight: options.strokeWeight ?? 1,
        fillColor: options.fillColor || options.strokeColor,
        fillOpacity: options.fillOpacity ?? 0.08
      }).addTo(map.raw);
    }
    setPosition(point) { this.layer.setLatLng(asPoint(point)); }
    setRadius(radius) { this.layer.setRadius(radius); }
    remove() { this.map.raw.removeLayer(this.layer); }
    isVisible() { return this.map.raw.hasLayer(this.layer); }
  }

  class LeafletHtmlMarker {
    constructor(map, point, options) {
      this.map = map;
      const size = options.size || 44;
      this.layer = global.L.marker(asPoint(point), {
        keyboard: false,
        zIndexOffset: options.zIndex || 1000,
        icon: global.L.divIcon({
          className: options.className || "",
          iconSize: [size, size],
          iconAnchor: [size / 2, size / 2],
          html: options.html || ""
        })
      }).addTo(map.raw);
    }
    setPosition(point) { this.layer.setLatLng(asPoint(point)); }
    getElement() { return this.layer.getElement(); }
    remove() { this.map.raw.removeLayer(this.layer); }
    isVisible() { return this.map.raw.hasLayer(this.layer); }
  }

  class LeafletMapAdapter {
    constructor(container, center, zoom) {
      this.provider = "openstreetmap";
      this.raw = global.L.map(container, { zoomControl: false }).setView(asPoint(center), zoom);
      global.L.control.zoom({ position: "bottomright" }).addTo(this.raw);
      global.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
      }).addTo(this.raw);
    }
    on(eventName, callback) {
      this.raw.on(eventName, event => callback(event?.latlng ? asPoint(event.latlng) : event));
    }
    setView(point, zoom) { const value = asPoint(point); this.raw.setView([value.lat, value.lng], zoom); }
    panTo(point) { const value = asPoint(point); this.raw.panTo([value.lat, value.lng], { animate: true }); }
    getZoom() { return this.raw.getZoom(); }
    resize() { this.raw.invalidateSize({ pan: false }); }
    fit(points, padding = 35) {
      const values = validPoints(points);
      if (!values.length) return;
      if (values.length === 1) return this.setView(values[0], Math.max(this.getZoom(), 16));
      this.raw.fitBounds(global.L.latLngBounds(values.map(point => [point.lat, point.lng])), { padding: [padding, padding] });
    }
    createPolyline(points, options = {}) { return new LeafletPolyline(this, points, options); }
    createCircleMarker(point, options = {}) { return new LeafletCircleMarker(this, point, options); }
    createCircle(point, options = {}) { return new LeafletCircle(this, point, options); }
    createHtmlMarker(point, options = {}) { return new LeafletHtmlMarker(this, point, options); }
    remove(layer) { layer?.remove(); }
    contains(layer) { return Boolean(layer?.isVisible()); }
    async geocode() { return null; }
  }

  class GooglePolyline {
    constructor(map, points, options) {
      this.map = map;
      this.layer = new global.google.maps.Polyline({
        map: map.raw,
        path: validPoints(points),
        strokeColor: options.color,
        strokeWeight: options.weight,
        strokeOpacity: options.opacity,
        icons: options.dashArray ? [{ icon: { path: "M 0,-1 0,1", strokeColor: options.color, strokeOpacity: 1, strokeWeight: 2, scale: 3 }, offset: "0", repeat: "14px" }] : undefined
      });
      if (options.dashArray) this.layer.setOptions({ strokeOpacity: 0, strokeColor: options.color });
    }
    addPoint(point) { this.layer.getPath().push(asPoint(point)); }
    setPoints(points) { this.layer.setPath(validPoints(points)); }
    getPoints() { return this.layer.getPath().getArray().map(asPoint); }
    remove() { this.layer.setMap(null); }
    isVisible() { return Boolean(this.layer.getMap()); }
  }

  class GoogleCircleMarker {
    constructor(map, point, options) {
      this.layer = new global.google.maps.Circle({
        map: map.raw,
        center: asPoint(point),
        radius: Math.max(2, options.radius || 8),
        strokeColor: options.strokeColor || "#ffffff",
        strokeWeight: options.strokeWeight || 3,
        strokeOpacity: 1,
        fillColor: options.fillColor || "#111111",
        fillOpacity: options.fillOpacity ?? 1,
        clickable: Boolean(options.title)
      });
      this.map = map;
      if (options.title) {
        this.info = new global.google.maps.InfoWindow({ content: options.title });
        this.layer.addListener("click", () => this.info.open({ map: map.raw, position: this.layer.getCenter() }));
      }
    }
    setPosition(point) { this.layer.setCenter(asPoint(point)); }
    remove() { this.info?.close(); this.layer.setMap(null); }
    isVisible() { return Boolean(this.layer.getMap()); }
  }

  class GoogleCircle {
    constructor(map, point, options) {
      this.layer = new global.google.maps.Circle({
        map: map.raw,
        center: asPoint(point),
        radius: options.radius || 1,
        strokeColor: options.strokeColor,
        strokeWeight: options.strokeWeight ?? 1,
        strokeOpacity: 1,
        fillColor: options.fillColor || options.strokeColor,
        fillOpacity: options.fillOpacity ?? 0.08,
        clickable: false
      });
    }
    setPosition(point) { this.layer.setCenter(asPoint(point)); }
    setRadius(radius) { this.layer.setRadius(radius); }
    remove() { this.layer.setMap(null); }
    isVisible() { return Boolean(this.layer.getMap()); }
  }

  class GoogleHtmlMarker {
    constructor(map, point, options) {
      const element = document.createElement("div");
      const MarkerOverlay = class extends global.google.maps.OverlayView {
        constructor() {
          super();
          this.position = asPoint(point);
          this.element = element;
          this.element.className = options.className || "";
          this.element.innerHTML = options.html || "";
          this.element.style.position = "absolute";
          this.element.style.zIndex = String(options.zIndex || 1000);
        }
        onAdd() { this.getPanes().overlayMouseTarget.appendChild(this.element); }
        draw() {
          const pixel = this.getProjection().fromLatLngToDivPixel(this.position);
          if (!pixel) return;
          this.element.style.left = `${pixel.x}px`;
          this.element.style.top = `${pixel.y}px`;
          this.element.style.transform = "translate(-50%, -50%)";
        }
        onRemove() { this.element.remove(); }
      };
      this.overlay = new MarkerOverlay();
      this.overlay.setMap(map.raw);
    }
    setPosition(point) { this.overlay.position = asPoint(point); this.overlay.draw(); }
    getElement() { return this.overlay.element; }
    remove() { this.overlay.setMap(null); }
    isVisible() { return Boolean(this.overlay.getMap()); }
  }

  class GoogleMapAdapter {
    constructor(container, center, zoom) {
      this.provider = "google";
      this.raw = new global.google.maps.Map(container, {
        center: asPoint(center),
        zoom,
        clickableIcons: false,
        fullscreenControl: false,
        mapTypeControl: false,
        streetViewControl: false,
        zoomControlOptions: { position: global.google.maps.ControlPosition.RIGHT_BOTTOM }
      });
    }
    on(eventName, callback) {
      this.raw.addListener(eventName, event => callback(event?.latLng ? asPoint(event.latLng) : event));
    }
    setView(point, zoom) { this.raw.setCenter(asPoint(point)); if (Number.isFinite(zoom)) this.raw.setZoom(zoom); }
    panTo(point) { this.raw.panTo(asPoint(point)); }
    getZoom() { return this.raw.getZoom() || 12; }
    resize() { global.google.maps.event.trigger(this.raw, "resize"); }
    fit(points, padding = 35) {
      const values = validPoints(points);
      if (!values.length) return;
      if (values.length === 1) return this.setView(values[0], Math.max(this.getZoom(), 16));
      const bounds = new global.google.maps.LatLngBounds();
      values.forEach(point => bounds.extend(point));
      this.raw.fitBounds(bounds, padding);
    }
    createPolyline(points, options = {}) { return new GooglePolyline(this, points, options); }
    createCircleMarker(point, options = {}) { return new GoogleCircleMarker(this, point, options); }
    createCircle(point, options = {}) { return new GoogleCircle(this, point, options); }
    createHtmlMarker(point, options = {}) { return new GoogleHtmlMarker(this, point, options); }
    remove(layer) { layer?.remove(); }
    contains(layer) { return Boolean(layer?.isVisible()); }
    async geocode(query) {
      const geocoder = new global.google.maps.Geocoder();
      const response = await geocoder.geocode({ address: query, region: "CO", language: "es" });
      const result = response.results?.[0];
      if (!result) return null;
      return { point: asPoint(result.geometry.location), label: result.formatted_address };
    }
  }

  async function createRuteoMap(options) {
    const { container, center, zoom = 12, googleMapsKey, onGoogleAuthFailure } = options;
    if (googleMapsKey) {
      try {
        await loadGoogleMaps(googleMapsKey, onGoogleAuthFailure);
        await Promise.all([
          global.google.maps.importLibrary("maps"),
          global.google.maps.importLibrary("geocoding")
        ]);
        return new GoogleMapAdapter(container, center, zoom);
      } catch (error) {
        const fallback = new LeafletMapAdapter(container, center, zoom);
        fallback.loadError = error;
        return fallback;
      }
    }
    return new LeafletMapAdapter(container, center, zoom);
  }

  global.createRuteoMap = createRuteoMap;
})(window);
