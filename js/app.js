/* Storymap: one fixed MapLibre map, one HTML section per chapter.
   Camera, markers, basemap options and (later) GIS layers come from data-* attributes:
     data-center / data-zoom / data-pitch / data-bearing   camera
     data-focus="lng,lat"                                  camera centre when it differs from the pin
     data-inset="lng,lat,zoom"                             framing of the locator map
     data-points='[{"lng":..,"lat":..,"label":".."}]'      extra labelled pins
     data-basemap="satellite"                              Sentinel-2 imagery under the labels
     data-terrain="1.6"                                    3D relief (exaggeration) + hillshade
     data-country="CH"                                     animated border spotlight on that country (ISO-2)
     data-layers='[{"id":..,"url":..,"type":..}]'          GIS layers, shown only on that chapter */
(() => {
  const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const STYLE_URL = "https://tiles.openfreemap.org/styles/positron";
  const SAT_TILES = "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/{z}/{y}/{x}.jpg";
  const SAT_ATTRIBUTION =
    '<a href="https://s2maps.eu" target="_blank" rel="noopener">Sentinel-2 cloudless</a> by EOX (contains modified Copernicus Sentinel data 2024)';
  const DEM_TILES = "https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png";
  const DEM_ATTRIBUTION = "Terrain: Mapzen / AWS Terrain Tiles (SRTM, ASTER and others)";

  const FOREIGN_SHARE = 0.5;      // share of the biggest foreign place names kept in view

  // Saved base map: small light-grey raster tiles (Esri) that cover the vector map whenever the camera moves, so a
  // flight never passes over a blank map. Their images are preloaded around the chapter being read and kept in the
  // browser cache. The vector map, with its names, shows through once it is fully drawn.
  const BASE_TILES = "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}";
  const BASE_MAX_ZOOM = 12;
  const BASE_ATTRIBUTION = "Tiles © Esri";
  const PRELOAD_TILES = { desktop: 3600, mobile: 600 };   // about 6 KB each: up to ~21 MB on desktop, ~3.5 MB on phones
  const PRELOAD_PARALLEL = 4;
  const NOBASE = new URLSearchParams(location.search).has("nobase");   // debug: vector map only


  // Phones and small tablets: chapters are a horizontal strip of cards (see css, max-width 899px).
  // Everything above that width keeps the vertical scroll.
  const MOBILE_MQ = matchMedia("(max-width: 899px)");
  const isMobile = () => MOBILE_MQ.matches;
  MOBILE_MQ.addEventListener("change", () => location.reload());   // rotation / resize across the breakpoint

  const steps = [...document.querySelectorAll(".step")];
  const rail = document.getElementById("rail");

  /* ---------- config parsed from the HTML ---------- */
  const parseNums = (s) => (s ? s.split(",").map(Number) : null);

  const chapters = steps.map((el, i) => {
    const d = el.dataset;
    return {
      el,
      id: el.id,
      title: d.title || "",
      year: d.year || "",
      center: parseNums(d.center),
      focus: parseNums(d.focus) || parseNums(d.center),
      inset: parseNums(d.inset),
      zoom: d.zoom ? Number(d.zoom) : 5,
      pitch: d.pitch ? Number(d.pitch) : 0,
      bearing: d.bearing ? Number(d.bearing) : 0,
      satellite: d.basemap === "satellite",
      terrain: d.terrain ? Number(d.terrain) : 0,
      country: d.country || "",
      points: d.points ? JSON.parse(d.points) : [],
      layers: d.layers ? JSON.parse(d.layers) : [],
      index: i,
    };
  });

  chapters.forEach((c, i) => {
    const card = c.el.querySelector(".card");
    if (card && i > 0) card.dataset.n = String(i).padStart(2, "0");
  });

  /* ---------- camera ---------- */
  // Keep the focus point clear of the card: reserve the card's real width on desktop,
  // the lower half of the screen on mobile.
  const padding = (c) => {
    if (isMobile()) {
      const card = c.el.querySelector(".card");
      const h = card ? card.offsetHeight : 0;   // already capped by the css max-height
      return { top: 70, bottom: Math.round(h + 44), left: 16, right: 16 };
    }
    const card = c.el.querySelector(".card");
    const reserved = card ? card.getBoundingClientRect().right + 24 : 0;
    const railRoom = innerWidth >= 1200 ? 190 : 80;
    return { top: 80, bottom: 40, left: Math.min(reserved, Math.round(innerWidth * 0.62)), right: railRoom };
  };

  // A phone shows about a quarter of the area a desktop does at the same zoom, so regional and
  // local views are pulled back to keep each point readable against its city.
  const zoomFor = (c) => (isMobile() ? c.zoom - (c.zoom >= 4 ? 1.2 : 0.9) : c.zoom);

  const moveCamera = (m, c, duration) => m.flyTo({
    center: c.focus, zoom: zoomFor(c), pitch: c.pitch, bearing: c.bearing,
    padding: padding(c), duration, essential: true,
  });

  const initialIndex = () => {
    const i = chapters.findIndex((c) => c.id === location.hash.slice(1));
    return i > 0 ? i : 0;
  };

  /* ---------- optional basemap layers: satellite imagery, relief ---------- */
  const firstSymbolId = (m) => {
    const l = m.getStyle().layers.find((x) => x.type === "symbol");
    return l && l.id;
  };

  function addExtras(m) {
    const before = firstSymbolId(m);
    m.addSource("sat", { type: "raster", tiles: [SAT_TILES], tileSize: 256, maxzoom: 13, attribution: SAT_ATTRIBUTION });
    m.addLayer({
      id: "sat", type: "raster", source: "sat", layout: { visibility: "none" },
      paint: { "raster-opacity": 0, "raster-opacity-transition": { duration: REDUCED ? 0 : 900, delay: 0 } },
    }, before);

    const demSource = { type: "raster-dem", tiles: [DEM_TILES], tileSize: 256, maxzoom: 14, encoding: "terrarium" };
    m.addSource("dem", { ...demSource, attribution: DEM_ATTRIBUTION });   // 3D terrain
    m.addSource("dem-shade", demSource);                                   // hillshade (separate source for quality)
    m.addLayer({
      id: "hillshade", type: "hillshade", source: "dem-shade", layout: { visibility: "none" },
      paint: {
        "hillshade-exaggeration": 0.55,
        "hillshade-shadow-color": "#000000",
        "hillshade-highlight-color": "rgba(255,255,255,0)",   // shadows only: acts like a multiply over the imagery
        "hillshade-accent-color": "rgba(0,0,0,0)",
      },
    }, before);

    // The saved base map goes last: above the vector layers and their names, below the pins and the spotlight.
    if (!NOBASE) {
      m.addSource("base", { type: "raster", tiles: [BASE_TILES], tileSize: 256, maxzoom: BASE_MAX_ZOOM, attribution: BASE_ATTRIBUTION });
      m.addLayer({ id: "base", type: "raster", source: "base", paint: { "raster-fade-duration": 0, "raster-opacity": 1 } });
    }
  }

  // Over imagery only the larger place names stay, small ones just add noise.
  const FINE_LABELS = ["label_village", "label_other", "label_town", "highway-name-minor", "highway-name-path", "highway-shield-non-us"];

  // Imagery is only switched on where a chapter asks for it: an opacity-0 raster layer would still
  // download tiles at every stop. Fading out first, then removing the layer from the render.
  function setImagery(m, on) {
    clearTimeout(m.__imageryTimer);
    if (on) {
      m.setLayoutProperty("sat", "visibility", "visible");
      m.setPaintProperty("sat", "raster-opacity", 1);
      return;
    }
    m.setPaintProperty("sat", "raster-opacity", 0);
    m.__imageryTimer = setTimeout(() => m.getLayer("sat") && m.setLayoutProperty("sat", "visibility", "none"), REDUCED ? 0 : 1000);
  }

  // Place names over imagery: plain white, no outline. Original paints are remembered to restore them.
  const textPaint = new WeakMap();
  function setLabelStyle(m, onImagery) {
    if (!textPaint.has(m)) {
      const saved = {};
      m.getStyle().layers.forEach((l) => {
        if (l.type === "symbol" && l.layout && l.layout["text-field"]) {
          saved[l.id] = ["text-color", "text-halo-width", "text-halo-blur"].map((k) => m.getPaintProperty(l.id, k));
        }
      });
      textPaint.set(m, saved);
    }
    const props = ["text-color", "text-halo-width", "text-halo-blur"];
    Object.entries(textPaint.get(m)).forEach(([id, original]) => {
      if (!m.getLayer(id)) return;
      const values = onImagery ? ["#ffffff", 0, 0] : original;
      props.forEach((k, i) => m.setPaintProperty(id, k, values[i]));
    });
  }

  // Relief only works on a flat projection, so it is switched on after / off before the projection.
  function applyChapter(m, c, part = "all") {
    if (!m.getLayer("sat")) return;
    const projection = () => {
      const want = c.terrain ? "mercator" : "globe";
      if (m.__projection !== want && m.setProjection) { m.setProjection({ type: want }); m.__projection = want; }
    };
    const terrain = () => {
      m.setLayoutProperty("hillshade", "visibility", c.terrain ? "visible" : "none");
      m.setTerrain(c.terrain ? { source: "dem", exaggeration: c.terrain } : null);
    };
    const style = () => {
      setLabelStyle(m, c.satellite);
      setImagery(m, c.satellite);
      FINE_LABELS.forEach((id) => m.getLayer(id) && m.setLayoutProperty(id, "visibility", c.satellite ? "none" : "visible"));
    };
    if (part === "projection") projection();
    else if (part === "terrain") terrain();
    else if (part === "style") style();
    else if (part === "rest") { terrain(); style(); }
    else if (c.terrain) { projection(); terrain(); style(); }
    else { terrain(); projection(); style(); }
  }

  /* ---------- place names ---------- */
  // Countries that appear in the CV are derived from the chapters' coordinates, so a new
  // chapter in a new country is picked up without touching this file.
  // Their place names show in full; elsewhere only the biggest ~50% in view are kept.
  const PLACE_LAYERS = ["label_state", "label_city", "label_city_capital", "label_town", "label_village", "label_other"];
  const COUNTRY_LAYERS = ["label_country_1", "label_country_2", "label_country_3"];
  const NAME_EN = ["coalesce", ["get", "name_en"], ["get", "name:latin"], ["get", "name"]];

  const ringHas = (pt, ring) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  const polyHas = (pt, poly) => ringHas(pt, poly[0]) && !poly.slice(1).some((h) => ringHas(pt, h));
  const countryHas = (f, pt) => (f.geometry.type === "Polygon"
    ? polyHas(pt, f.geometry.coordinates)
    : f.geometry.coordinates.some((p) => polyHas(pt, p)));

  let world = null;      // simplified world countries (assets/geo/countries.json)
  const original = {};   // layer id -> filter before masking
  const mask = { polys: null, iso: [], foreignCity: 3, foreignCountry: 1 };

  function cvCountries(world) {
    const pts = chapters.flatMap((c) => [...(c.center ? [c.center] : []), ...c.points.map((p) => [p.lng, p.lat])]);
    const found = new Map();
    pts.forEach((pt) => {
      const f = world.features.find((x) => countryHas(x, pt));
      if (f) found.set(f.properties.a3, f);
    });
    return [...found.values()];
  }

  function applyMask(m) {
    const inCv = ["within", mask.polys];
    const rank = ["coalesce", ["get", "rank"], 99];
    const cityKeep = ["any", inCv, ["<=", rank, mask.foreignCity]];
    const countryKeep = ["any", ["in", ["get", "iso_a2"], ["literal", mask.iso]], ["<=", rank, mask.foreignCountry]];
    PLACE_LAYERS.forEach((id) => m.getLayer(id) && m.setFilter(id, ["all", original[id], cityKeep]));
    COUNTRY_LAYERS.forEach((id) => m.getLayer(id) && m.setFilter(id, ["all", original[id], countryKeep]));
  }

  // Keep the top FOREIGN_SHARE of the foreign place names currently in view (by importance rank).
  function updateForeignThresholds(m) {
    if (!mask.polys) return;
    const bounds = m.getBounds();
    const cvFeatures = mask.polys.features;
    const cities = new Map(), countries = new Map();
    m.querySourceFeatures("openmaptiles", { sourceLayer: "place" }).forEach((f) => {
      const p = f.properties, g = f.geometry;
      if (!p || g.type !== "Point" || !bounds.contains(g.coordinates)) return;
      const key = p.name_en || p.name;
      if (p.class === "country") {
        if (!mask.iso.includes(p.iso_a2)) countries.set(key, p.rank ?? 99);
      } else if (["city", "town", "state"].includes(p.class)) {
        if (!cities.has(key) && !cvFeatures.some((cf) => countryHas(cf, g.coordinates))) cities.set(key, p.rank ?? 99);
      }
    });
    const cut = (set) => {
      const r = [...set.values()].sort((a, b) => a - b);
      return r.length ? r[Math.max(0, Math.ceil(r.length * FOREIGN_SHARE) - 1)] : 99;
    };
    const next = { city: cut(cities), country: cut(countries) };
    if (next.city !== mask.foreignCity || next.country !== mask.foreignCountry) {
      mask.foreignCity = next.city;
      mask.foreignCountry = next.country;
      applyMask(m);
    }
  }

  async function setupPlaceNames(m) {
    // International names only (no local script next to them).
    [...PLACE_LAYERS, ...COUNTRY_LAYERS, "water_name_point_label", "water_name_line_label"].forEach((id) => {
      if (m.getLayer(id)) m.setLayoutProperty(id, "text-field", NAME_EN);
    });
    ["water_name_point_label", "water_name_line_label"].forEach((id) => {
      if (!m.getLayer(id)) return;
      m.setFilter(id, ["all", m.getFilter(id), ["!", ["in", ["get", "class"], ["literal", ["ocean", "sea"]]]]]);
    });
    [...PLACE_LAYERS, ...COUNTRY_LAYERS].forEach((id) => { if (m.getLayer(id)) original[id] = m.getFilter(id); });

    try {
      world = await (await fetch("assets/geo/countries.json")).json();
    } catch (err) {
      console.warn("Place-name mask unavailable:", err);
      return;
    }
    const cv = cvCountries(world);
    mask.polys = { type: "FeatureCollection", features: cv };
    mask.iso = cv.map((f) => f.properties.iso2);
    applyMask(m);
    m.on("idle", () => updateForeignThresholds(m));
    if (current >= 0) spotlight(chapters[current]);
  }


  /* ---------- country spotlight: the border draws itself, the rest of the world dims ---------- */
  const WORLD_RECT = [[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]];
  const spot = { raf: 0, country: "" };

  function addSpot(m) {
    const empty = { type: "FeatureCollection", features: [] };
    m.addSource("spot-dim", { type: "geojson", data: empty });
    m.addSource("spot-line", { type: "geojson", data: empty, lineMetrics: true });
    m.addLayer({
      id: "spot-dim", type: "fill", source: "spot-dim",
      paint: { "fill-color": "#030a1c", "fill-opacity": 0, "fill-opacity-transition": { duration: 1000, delay: 0 } },
    });
    m.addLayer({
      id: "spot-line", type: "line", source: "spot-line",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#c4301c", "line-width": 3, "line-opacity": 0, "line-opacity-transition": { duration: 400, delay: 0 } },
    });
  }

  // Precise borders live in assets/geo/borders/<ISO2>.json (OpenStreetMap, the same data as the
  // basemap). Without such a file the simplified world outline is used.
  const borders = {};
  async function getBorder(iso) {
    if (borders[iso]) return borders[iso];
    try {
      const r = await fetch(`assets/geo/borders/${iso}.json`);
      if (r.ok) return (borders[iso] = await r.json());
    } catch (_) { /* fall back below */ }
    const f = world && world.features.find((x) => x.properties.iso2 === iso);
    if (f) borders[iso] = f;
    return f || null;
  }

  let spotToken = 0;
  async function spotlight(c) {
    if (!map.getSource("spot-dim")) return;
    const token = ++spotToken;
    cancelAnimationFrame(spot.raf);
    const fade = () => {
      map.setPaintProperty("spot-dim", "fill-opacity", 0);
      map.setPaintProperty("spot-line", "line-opacity", 0);
    };
    if (!c.country) { fade(); return; }
    const feature = await getBorder(c.country);
    if (token !== spotToken) return;           // the reader has moved on
    if (!feature) { fade(); return; }
    const polys = feature.geometry.type === "Polygon" ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    if (spot.country !== c.country) {
      const islands = polys.flatMap((p) => p.slice(1));           // enclaves stay dimmed
      map.getSource("spot-dim").setData({
        type: "FeatureCollection",
        features: [
          { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [WORLD_RECT, ...polys.map((p) => p[0])] } },
          ...islands.map((ring) => ({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring] } })),
        ],
      });
      map.getSource("spot-line").setData({
        type: "FeatureCollection",
        features: polys.flatMap((p) => p).map((ring) => ({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: ring } })),
      });
      spot.country = c.country;
    }
    map.setPaintProperty("spot-dim", "fill-opacity", 0.5);
    map.setPaintProperty("spot-line", "line-opacity", 1);
    if (REDUCED) return;
    // Draw the border once, then let it breathe while the chapter is on screen.
    const t0 = performance.now();
    const DRAW_MS = 1800;
    let trimOk = true;
    const tick = (now) => {
      const k = Math.min((now - t0) / DRAW_MS, 1);
      const eased = 1 - Math.pow(1 - k, 3);
      if (trimOk) {
        try { map.setPaintProperty("spot-line", "line-trim-offset", [eased, 1]); } catch (_) { trimOk = false; }
      }
      map.setPaintProperty("spot-line", "line-width", 3 + (k === 1 ? Math.sin((now - t0 - DRAW_MS) / 450) * 0.9 : 0));
      spot.raf = requestAnimationFrame(tick);
    };
    try { map.setPaintProperty("spot-line", "line-trim-offset", [0, 1]); } catch (_) { trimOk = false; }
    spot.raf = requestAnimationFrame(tick);
  }

  /* ---------- locator inset: a small map of where the chapter is ---------- */
  const insetEl = document.getElementById("inset");
  let inset = null;
  const insetPins = [];
  const insetZoom = (c) => Math.min(4, Math.max(1.3, c.zoom * 0.35));

  function buildInset() {
    if (!insetEl || isMobile()) return;
    inset = new maplibregl.Map({
      container: insetEl, style: STYLE_URL, center: chapters[0].center, zoom: 1.5,
      interactive: false, attributionControl: false,
    });
    inset.on("error", () => {});
    inset.on("load", () => {
      // A clean locator: only country names stay.
      inset.getStyle().layers.forEach((l) => {
        if (l.type !== "symbol") return;
        if (COUNTRY_LAYERS.includes(l.id)) inset.setLayoutProperty(l.id, "text-field", NAME_EN);
        else inset.setLayoutProperty(l.id, "visibility", "none");
      });
      if (current >= 0) updateInset(chapters[current], true);
    });
  }

  function updateInset(c, instant = false) {
    if (!insetEl || !inset) return;
    insetEl.classList.toggle("is-visible", c.index > 0);
    insetPins.splice(0).forEach((m) => m.remove());
    const spots = c.points.length ? c.points.map((p) => [p.lng, p.lat]) : [c.center];
    spots.forEach((lngLat) => {
      const el = document.createElement("div");
      el.className = "inset-pin";
      insetPins.push(new maplibregl.Marker({ element: el }).setLngLat(lngLat).addTo(inset));
    });
    const [lng, lat, z] = c.inset || [c.center[0], c.center[1], insetZoom(c)];
    inset.flyTo({ center: [lng, lat], zoom: z, duration: REDUCED || instant ? 0 : 1600, essential: true });
  }

  /* ---------- main map ---------- */
  const start = chapters[initialIndex()];
  const map = new maplibregl.Map({
    container: "map",
    style: STYLE_URL,
    center: start.center,
    zoom: start.zoom,
    interactive: false,           // page scroll must never be hijacked by the map
    attributionControl: isMobile() ? false : { compact: true },
    maxTileCacheSize: 300,        // revisited chapters keep their tiles
    fadeDuration: 0,              // names and symbols appear with their tiles, no fade-in delay
    ...(isMobile() ? { pixelRatio: Math.min(window.devicePixelRatio || 1, 2) } : {}),
  });

  // Phones: the sources live at the very top (under the header, away from the cards), folded to the "i".
  if (isMobile()) {
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "top-right");
    const fold = () => {
      const el = map.getContainer().querySelector(".maplibregl-ctrl-attrib");
      if (el) { el.classList.remove("maplibregl-compact-show"); el.removeAttribute("open"); }
    };
    map.on("load", fold);
    map.on("idle", fold);
  }

  // Debug handle for measuring (open the page with ?debug).
  if (new URLSearchParams(location.search).has("debug")) window.__storymap = { map, preload: () => preload };

  let current = -1;
  let scrubbing = false; // dragging along the chapter rail: shorter camera moves
  let ready = false; // scroll tracking waits for the map, markers and layers
  const markers = []; // { chapterIndex, pin }

  function buildMarkers() {
    chapters.forEach((c) => {
      const spots = c.points.length
        ? c.points.map((p) => ({ lngLat: [p.lng, p.lat], label: p.label, side: p.side }))
        : c.index === 0 || c.country ? [] : [{ lngLat: c.center }];
      spots.forEach((s) => {
        const pin = document.createElement("div");
        pin.className = "pin";
        if (s.label) {
          const l = document.createElement("span");
          l.className = s.side === "left" ? "pin-label pin-label-left" : "pin-label";
          l.textContent = s.label;
          pin.appendChild(l);
        }
        new maplibregl.Marker({ element: pin }).setLngLat(s.lngLat).addTo(map);
        markers.push({ chapterIndex: c.index, pin });
      });
    });
  }

  const LAYER_DEFAULTS = {
    fill: { "fill-color": "#c4301c", "fill-opacity": 0.35 },
    line: { "line-color": "#12161c", "line-width": 1.5 },
    circle: { "circle-color": "#c4301c", "circle-radius": 5 },
  };
  function buildLayers() {
    chapters.forEach((c) => c.layers.forEach((l) => {
      map.addSource(l.id, { type: "geojson", data: l.url });
      map.addLayer({
        id: l.id, type: l.type || "fill", source: l.id,
        layout: { visibility: "none" },
        paint: { ...LAYER_DEFAULTS[l.type || "fill"], ...(l.paint || {}) },
      });
    }));
  }

  const showLayers = (index) => chapters.forEach((c) => c.layers.forEach((l) => {
    if (map.getLayer(l.id)) map.setLayoutProperty(l.id, "visibility", c.index === index ? "visible" : "none");
  }));

  function activate(index, instant = false) {
    if (index === current) return;
    current = index;
    const c = chapters[index];
    steps.forEach((s, i) => s.classList.toggle("is-active", i === index));
    [...rail.children].forEach((b, i) => {
      b.classList.toggle("is-active", i === index);
      b.setAttribute("aria-current", i === index ? "true" : "false");
    });
    markers.forEach((m) => {
      m.pin.style.display = m.chapterIndex <= index ? "" : "none";
      m.pin.classList.toggle("is-current", m.chapterIndex === index);
    });
    applyChapter(map, c);
    showLayers(index);
    spotlight(c);
    moveCamera(map, c, REDUCED || instant ? 0 : scrubbing ? 700 : 2600);
    updateInset(c, instant);
    try { history.replaceState(null, "", index === 0 ? location.pathname : "#" + c.id); } catch (_) { /* ignore */ }
    preloadAround(index);
  }

  /* ---------- saved base map: preload the images of the flights around the chapter being read ---------- */
  const mercX = (lng, z) => ((lng + 180) / 360) * 512 * 2 ** z;
  const mercY = (lat, z) => {
    const sn = Math.sin((lat * Math.PI) / 180);
    return (0.5 - Math.log((1 + sn) / (1 - sn)) / (4 * Math.PI)) * 512 * 2 ** z;
  };
  const unMerc = (x, y, z) => {
    const ws = 512 * 2 ** z, n = Math.PI - (2 * Math.PI * y) / ws;
    return [(x / ws) * 360 - 180, (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))];
  };

  // Camera positions along MapLibre's flyTo curve (van Wijk), to know which tiles a flight crosses.
  function flightSamples(a, b, W, H, n = 40) {
    const rho = 1.42, rho2 = rho * rho, w0 = Math.max(W, H);
    const scale = 2 ** (b.zoom - a.zoom), w1 = w0 / scale;
    const fx = mercX(a.focus[0], a.zoom), fy = mercY(a.focus[1], a.zoom);
    const dx = mercX(b.focus[0], a.zoom) - fx, dy = mercY(b.focus[1], a.zoom) - fy, u1 = Math.hypot(dx, dy);
    const out = [];
    if (u1 < 1e-6) {
      for (let k = 0; k <= n; k++) out.push({ center: a.focus, zoom: a.zoom + ((b.zoom - a.zoom) * k) / n });
      return out;
    }
    const sinh = (v) => (Math.exp(v) - Math.exp(-v)) / 2, cosh = (v) => (Math.exp(v) + Math.exp(-v)) / 2;
    const tanh = (v) => sinh(v) / cosh(v);
    const r = (i) => {
      const bb = (w1 * w1 - w0 * w0 + (i ? -1 : 1) * rho2 * rho2 * u1 * u1) / (2 * (i ? w1 : w0) * rho2 * u1);
      return Math.log(Math.sqrt(bb * bb + 1) - bb);
    };
    const r0 = r(0), S = (r(1) - r0) / rho;
    for (let k = 0; k <= n; k++) {
      const sk = (k / n) * S, sc = cosh(r0 + rho * sk) / cosh(r0);
      const u = (w0 * ((cosh(r0) * tanh(r0 + rho * sk) - sinh(r0)) / rho2)) / u1;
      const z = a.zoom + Math.log2(sc);
      out.push({ center: unMerc((fx + dx * u) * sc, (fy + dy * u) * sc, z), zoom: z });
    }
    return out;
  }

  const tileUrl = (z, x, y) => BASE_TILES.replace("{z}", z).replace("{x}", x).replace("{y}", y);

  // Every base tile one flight between chapters i and i+1 can show, in either direction (generous margin).
  function tilesForFlight(i) {
    const box = map.getContainer(), W = box.clientWidth, H = box.clientHeight;
    const urls = new Set();
    const a = { focus: chapters[i].focus, zoom: zoomFor(chapters[i]) };
    const b = { focus: chapters[i + 1].focus, zoom: zoomFor(chapters[i + 1]) };
    flightSamples(a, b, W, H).forEach(({ center, zoom }) => {
      const tz = Math.max(0, Math.min(BASE_MAX_ZOOM, Math.floor(zoom + 1)));
      const n = 2 ** tz;
      if (zoom <= 3.2) {                                        // a globe view shows the whole world
        for (let x = 0; x < n; x++) for (let y = 0; y < n; y++) urls.add(tileUrl(tz, x, y));
        return;
      }
      const E = Math.max(W, H) * 0.6, ws = 512 * 2 ** zoom;
      const cx = mercX(center[0], zoom), cy = mercY(center[1], zoom);
      const x0 = Math.max(0, Math.floor(((cx - E) / ws) * n)), x1 = Math.min(n - 1, Math.floor(((cx + E) / ws) * n));
      const y0 = Math.max(0, Math.floor(((cy - E) / ws) * n)), y1 = Math.min(n - 1, Math.floor(((cy + E) / ws) * n));
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) urls.add(tileUrl(tz, x, y));
    });
    return [...urls];
  }

  const preload = { done: new Set(), inflight: new Set(), queue: [] };

  function pumpPreload() {
    while (preload.inflight.size < PRELOAD_PARALLEL && preload.queue.length) {
      const url = preload.queue.shift();
      preload.inflight.add(url);
      fetch(url, { mode: "cors", credentials: "omit", priority: "low" })
        .then((r) => (r.ok ? r.arrayBuffer() : null))           // read it fully so the browser stores it
        .then((ok) => { if (ok) preload.done.add(url); })
        .catch(() => {})
        .finally(() => { preload.inflight.delete(url); pumpPreload(); });
    }
  }

  const tileXY = (lng, lat, z) => [Math.floor(mercX(lng, z) / 512), Math.floor(mercY(lat, z) / 512)];

  // Vector tiles of a chapter's arrival view (and the level above), so they come from cache when the camera lands.
  function vectorTilesFor(c) {
    const id = Object.keys(map.getStyle().sources).find((k) => map.getStyle().sources[k].type === "vector");
    const src = id && map.getSource(id);
    if (!src || !src.tiles || !src.tiles[0]) return [];
    const box = map.getContainer();
    const rx = Math.ceil(box.clientWidth / 1024) + 1, ry = Math.ceil(box.clientHeight / 1024) + 1;
    const out = [];
    const top = Math.min(src.maxzoom || 14, Math.floor(zoomFor(c)));
    [[top, rx, ry], [top - 1, 1, 1]].forEach(([z, dx, dy]) => {
      if (z < 0) return;
      const n = 2 ** z, [cx, cy] = tileXY(c.focus[0], c.focus[1], z);
      for (let x = cx - dx; x <= cx + dx; x++) for (let y = Math.max(0, cy - dy); y <= Math.min(n - 1, cy + dy); y++) {
        out.push(src.tiles[0].replace("{z}", z).replace("{x}", ((x % n) + n) % n).replace("{y}", y));
      }
    });
    return out;
  }

  // Relief (and its satellite imagery) of every terrain chapter, from the world down to the arrival view.
  function terrainTilesFor(c) {
    const box = map.getContainer(), E = Math.max(box.clientWidth, box.clientHeight) * 0.5;
    const top = Math.min(13, Math.floor(zoomFor(c)) + 1), out = [];
    for (let z = 5; z <= top; z++) {
      const n = 2 ** z, r = Math.max(2, Math.ceil((E / 256) / 2 ** (top - z)));
      const [cx, cy] = [Math.floor(mercX(c.focus[0], z - 1) / 256), Math.floor(mercY(c.focus[1], z - 1) / 256)];
      for (let x = cx - r; x <= cx + r; x++) for (let y = Math.max(0, cy - r); y <= Math.min(n - 1, cy + r); y++) {
        const xx = ((x % n) + n) % n;
        out.push(DEM_TILES.replace("{z}", z).replace("{x}", xx).replace("{y}", y));
        if (c.satellite) out.push(SAT_TILES.replace("{z}", z).replace("{x}", xx).replace("{y}", y));
      }
    }
    return out;
  }

  // Nearest flights first: the one just taken and the next one, then outwards. Re-ordered at every chapter change.
  function preloadAround(index) {
    if (NOBASE || (navigator.connection && navigator.connection.saveData)) return;
    const first = [];     // arrival views of the neighbours, then the relief of terrain chapters, go before the base map
    [index + 1, index - 1].forEach((k) => { if (chapters[k]) first.push(...vectorTilesFor(chapters[k])); });
    chapters.forEach((c) => { if (c.terrain) first.push(...terrainTilesFor(c)); });
    const lead = first.filter((u, i) => first.indexOf(u) === i && !preload.done.has(u) && !preload.inflight.has(u));
    const budget = isMobile() ? PRELOAD_TILES.mobile : PRELOAD_TILES.desktop;
    const flights = chapters.length - 1;
    const order = [];
    [index - 1, index].forEach((f) => { if (f >= 0 && f < flights) order.push(f); });
    for (let d = 1; d < chapters.length; d++) {
      [index + d, index - 1 - d].forEach((f) => { if (f >= 0 && f < flights) order.push(f); });
    }
    const urls = [];
    const seen = new Set();
    for (const f of order) {
      for (const url of tilesForFlight(f)) {
        if (seen.has(url) || preload.done.has(url) || preload.inflight.has(url)) continue;
        if (preload.done.size + preload.inflight.size + urls.length >= budget) break;
        seen.add(url);
        urls.push(url);
      }
    }
    preload.queue = [...lead, ...urls];
    pumpPreload();
  }

  // Bring a chapter into view: scroll the page (desktop) or the card strip (mobile).
  const reveal = (i, behavior) => (isMobile() ? steps[i] : steps[i].querySelector(".card") || steps[i]).scrollIntoView(
    isMobile() ? { behavior, inline: "center", block: "nearest" } : { behavior, block: "center" });

  /* ---------- rail ---------- */
  chapters.forEach((c, i) => {
    const b = document.createElement("button");
    b.type = "button";
    const label = [c.year, c.title].filter(Boolean).join(" · ") || `Chapter ${i}`;
    b.setAttribute("aria-label", label);
    b.innerHTML = '<span class="lbl"></span><i class="dot"></i>';
    b.querySelector(".lbl").textContent = label;
    b.addEventListener("click", (e) => {
      if (e.detail === 0) goTo(i, false);          // keyboard activation; pointer input is handled below
    });
    rail.appendChild(b);
  });

  /* Press on the rail and drag up or down to flip through chapters, like a scroller. */
  function goTo(i, instant) {
    reveal(i, instant || REDUCED ? "auto" : "smooth");
  }
  const railIndexAt = (y) => {
    let best = 0, dist = Infinity;
    [...rail.children].forEach((b, i) => {
      const r = b.getBoundingClientRect();
      const d = Math.abs(y - (r.top + r.height / 2));
      if (d < dist) { dist = d; best = i; }
    });
    return best;
  };
  const drag = { on: false, moved: false, y: 0, index: -1 };
  rail.addEventListener("pointerdown", (e) => {
    drag.on = true; drag.moved = false; drag.y = e.clientY;
    drag.index = railIndexAt(e.clientY);
    rail.setPointerCapture(e.pointerId);
  });
  rail.addEventListener("pointermove", (e) => {
    if (!drag.on) return;
    if (!drag.moved && Math.abs(e.clientY - drag.y) < 5) return;
    drag.moved = true; scrubbing = true;
    rail.classList.add("is-scrubbing");
    const i = railIndexAt(e.clientY);
    if (i !== current) { goTo(i, true); activate(i); }
  });
  const endDrag = () => {
    if (!drag.on) return;
    drag.on = false;
    rail.classList.remove("is-scrubbing");
    if (!drag.moved && drag.index >= 0) goTo(drag.index, false);   // a plain click
    setTimeout(() => { scrubbing = false; }, 900);
  };
  rail.addEventListener("pointerup", endDrag);
  rail.addEventListener("pointercancel", endDrag);

  /* ---------- scroll tracking ---------- */
  steps.forEach((el, i) => { el.dataset.index = i; });
  if (isMobile()) {
    // The active chapter is the card nearest the middle of the strip. Waiting for the strip to stop
    // means a fast swipe across several cards makes one flight, to the card it lands on.
    const strip = document.getElementById("story");
    let settle = 0;
    const nearest = () => {
      const mid = strip.scrollLeft + strip.clientWidth / 2;
      let best = 0, dist = Infinity;
      steps.forEach((el, i) => {
        const d = Math.abs(el.offsetLeft + el.offsetWidth / 2 - mid);
        if (d < dist) { dist = d; best = i; }
      });
      return best;
    };
    strip.addEventListener("scroll", () => {
      if (!ready) return;
      clearTimeout(settle);
      settle = setTimeout(() => activate(nearest()), 90);
    }, { passive: true });
  } else {
    const io = new IntersectionObserver((entries) => {
      if (!ready) return;
      entries.forEach((e) => { if (e.isIntersecting) activate(Number(e.target.dataset.index)); });
    }, { rootMargin: "-45% 0px -45% 0px" });
    steps.forEach((el) => io.observe(el));

    // Resting place: when scrolling stops with a card close to the vertical middle of the window, ease it into place.
    const SETTLE_RANGE = 180, SETTLE_IDLE = 120;
    const cards = steps.map((s) => s.querySelector(".card")).filter(Boolean);
    const middleOffset = (el) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2 - innerHeight / 2; };
    let settleTimer = 0;
    addEventListener("scroll", () => {
      if (REDUCED) return;
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        if (!ready || rail.classList.contains("is-scrubbing")) return;
        const best = cards.reduce((a, b) => (Math.abs(middleOffset(b)) < Math.abs(middleOffset(a)) ? b : a));
        const off = middleOffset(best);
        if (best.offsetHeight > innerHeight * 0.88 || Math.abs(off) < 2 || Math.abs(off) > SETTLE_RANGE) return;
        scrollBy({ top: off, behavior: "smooth" });
      }, SETTLE_IDLE);
    }, { passive: true });

    // Up / Down arrows step from chapter to chapter (instead of nudging the page a few pixels).
    addEventListener("keydown", (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      if (/^(INPUT|TEXTAREA|SELECT|IFRAME)$/.test((e.target && e.target.tagName) || "")) return;
      const i = Math.min(chapters.length - 1, Math.max(0, current + (e.key === "ArrowDown" ? 1 : -1)));
      e.preventDefault();
      if (i !== current) reveal(i, REDUCED ? "auto" : "smooth");
    });
  }

  /* ---------- portfolio and contact links remember where the reader was ---------- */
  document.addEventListener("click", (e) => {
    const a = e.target.closest('a[href^="portfolio.html"], a[href^="contact.html"]');
    if (!a || current < 0) return;
    const url = new URL(a.getAttribute("href"), location.href);
    url.searchParams.set("from", chapters[current].id);
    a.href = url.href;
  });

  /* ---------- lite YouTube embeds ---------- */
  document.querySelectorAll(".video").forEach((box) => {
    const { id, start: t = "0", title = "Video" } = box.dataset;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "launch";
    btn.style.backgroundImage = `url(https://i.ytimg.com/vi/${id}/hqdefault.jpg)`;
    btn.setAttribute("aria-label", `Play video: ${title}`);
    btn.innerHTML = '<span class="play"></span><span class="cap"></span>';
    btn.querySelector(".cap").textContent = title;
    const label = document.createElement("span");      // shown instead of the overlay caption on phones
    label.className = "vt";
    label.textContent = title;
    box.addEventListener("click", () => {
      const f = document.createElement("iframe");
      f.src = `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&start=${t}`;
      f.title = title;
      f.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
      f.referrerPolicy = "strict-origin-when-cross-origin";
      f.allowFullscreen = true;
      box.classList.add("is-playing");
      box.replaceChildren(f);
    }, { once: true });
    box.append(btn, label);
  });

  // Fonts and images finishing after the first scroll can shift the page; until the reader
  // takes over, keep a deep-linked chapter (e.g. "Back to the map") centred.
  function keepDeepLinkInView(i) {
    let moved = false;
    ["wheel", "touchstart", "keydown", "pointerdown"].forEach((ev) =>
      addEventListener(ev, () => { moved = true; }, { once: true, passive: true }));
    const realign = () => { if (!moved) reveal(i, "instant"); };
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(realign);
    if (document.readyState !== "complete") addEventListener("load", realign, { once: true });
    setTimeout(realign, 1500);
  }

  /* ---------- scroll reminder: shown when the reader sits at the top, idle for 2 s ---------- */
  const hint = document.getElementById("scrollhint");
  if (hint && !isMobile()) {
    let hintTimer = 0;
    const atTop = () => window.scrollY < 8;
    const armHint = () => {
      clearTimeout(hintTimer);
      hint.classList.remove("is-visible");
      if (atTop()) hintTimer = setTimeout(() => { if (atTop()) hint.classList.add("is-visible"); }, 2000);
    };
    ["pointermove", "pointerdown", "keydown", "wheel", "touchstart", "scroll"].forEach((ev) =>
      addEventListener(ev, armHint, { passive: true }));
    hint.addEventListener("click", () => reveal(1, REDUCED ? "auto" : "smooth"));
    armHint();
  }

  /* ---------- base map visibility ---------- */
  // Opaque while the camera moves (and until the vector map is fully drawn); then it fades out, revealing the
  // vector map and its names. A timer guarantees it never stays on if the map never reports idle.
  // It leaves as soon as every tile of the view is loaded (not at "idle", which waits much longer).
  const BASE_REVEAL_MS = 220;
  let baseTimer = 0;
  const setBase = (opacity, ms) => {
    if (!map.getLayer("base")) return;
    map.setPaintProperty("base", "raster-opacity-transition", { duration: ms, delay: 0 });
    map.setPaintProperty("base", "raster-opacity", opacity);
  };
  const revealWhenLoaded = () => {
    if (map.isMoving() || !map.areTilesLoaded()) return;
    map.off("render", revealWhenLoaded);
    clearTimeout(baseTimer);
    requestAnimationFrame(() => requestAnimationFrame(() => {   // let the names settle for two frames first
      if (!map.isMoving()) setBase(0, BASE_REVEAL_MS);
    }));
  };
  map.on("movestart", () => { clearTimeout(baseTimer); map.off("render", revealWhenLoaded); setBase(1, 0); });
  map.on("moveend", () => {
    clearTimeout(baseTimer);
    map.on("render", revealWhenLoaded);
    baseTimer = setTimeout(() => { if (!map.isMoving()) setBase(0, 700); }, 6000);
    revealWhenLoaded();
    map.triggerRepaint();
  });
  map.on("idle", () => { if (!map.isMoving()) { clearTimeout(baseTimer); setBase(0, BASE_REVEAL_MS); } });

  /* ---------- boot ---------- */
  map.on("error", (e) => console.warn("Map:", (e && e.error && e.error.message) || e));
  map.on("style.load", () => {
    if (map.setProjection) { map.setProjection({ type: "globe" }); map.__projection = "globe"; }
  });
  map.on("load", async () => {
    addExtras(map);
    addSpot(map);
    buildMarkers();
    buildLayers();
    const i = initialIndex();
    if (i > 0) reveal(i, "instant");
    buildInset();
    ready = true;
    activate(i, true);
    if (i > 0) keepDeepLinkInView(i);
    await setupPlaceNames(map);
  });
  addEventListener("resize", () => moveCamera(map, chapters[Math.max(current, 0)], 0));
})();
