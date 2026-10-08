/* Storymap: one fixed MapLibre map, one HTML section per chapter.
   Camera, markers, basemap options and (later) GIS layers come from data-* attributes:
     data-center / data-zoom / data-pitch / data-bearing   camera
     data-focus="lng,lat"                                  camera centre when it differs from the pin
     data-inset="lng,lat,zoom"                             framing of the locator map
     data-points='[{"lng":..,"lat":..,"label":".."}]'      extra labelled pins
     data-basemap="satellite"                              Sentinel-2 imagery under the labels
     data-terrain="1.6"                                    3D relief (exaggeration) + hillshade
     data-country="CH"                                     animated border spotlight on that country (ISO-2)
     data-layers='[{"id":..,"url":..,"type":..}]'          GIS layers, shown only on that chapter

   Smoothness rules this file keeps:
   - The map style is prepared once, before the map exists (names, place-name mask, extra layers). After that no
     filter or layout property ever changes, because each such change makes MapLibre re-read every tile.
   - A light raster base map covers the vector map while the camera moves, and leaves as soon as the view is drawn.
   - The locator is a 2D canvas (js/locator.js), the sky (js/stars.js) holds still during flights,
     and the card "lock" on desktop is native scroll snapping, run by the browser off the main thread. */
(() => {
  const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const STYLE_URL = "https://tiles.openfreemap.org/styles/positron";
  const WORLD_URL = "assets/geo/world.json";       // simplified countries: place-name mask, locator, border fallback
  const SAT_TILES = "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/{z}/{y}/{x}.jpg";
  const SAT_ATTRIBUTION =
    '<a href="https://s2maps.eu" target="_blank" rel="noopener">Sentinel-2 cloudless</a> by EOX (contains modified Copernicus Sentinel data 2024)';
  const DEM_TILES = "https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png";
  const DEM_ATTRIBUTION = "Terrain: Mapzen / AWS Terrain Tiles (SRTM, ASTER and others)";
  // Outside a few countries these tiles hold 30 m SRTM: level 12 already carries all of it, deeper levels are
  // the same data upsampled, at 4 to 16 times the decoding work.
  const DEM_MAX_ZOOM = 12;

  // Foreign place names (countries that are not in the CV) only show when they rank among the biggest.
  // Measured on every chapter, these match the earlier "biggest half in view" rule.
  const FOREIGN_CITY_RANK = 3;
  const FOREIGN_COUNTRY_RANK = 3;

  // Saved base map: small light-grey raster tiles (Esri) that cover the vector map whenever the camera moves, so a
  // flight never passes over a blank map. Their images are preloaded around the chapter being read and kept in the
  // browser cache. The vector map, with its names, shows through as soon as it is drawn.
  const BASE_TILES = "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}";
  const BASE_MAX_ZOOM = 12;
  const BASE_ATTRIBUTION = "Tiles © Esri";
  const BASE_REVEAL_MS = 220;
  const PRELOAD_TILES = { desktop: 3600, mobile: 600 };   // about 6 KB each: up to ~21 MB on desktop, ~3.5 MB on phones
  const PRELOAD_PARALLEL = 4;
  const FLIGHT_MS = 2600, SCRUB_MS = 700;
  const params = new URLSearchParams(location.search);
  const NOBASE = params.has("nobase");             // debug: vector map only

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

  // Where a chapter puts its pins (a world view without points has none).
  const pinsOf = (c) => (c.points.length
    ? c.points.map((p) => [p.lng, p.lat])
    : c.index === 0 || c.country || c.zoom < 3 ? [] : [c.center]);

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

  /* ---------- countries ---------- */
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

  // Countries that appear in the CV, derived from the pins, so a new chapter in a new country is picked up
  // without touching this file.
  function cvCountries(world) {
    const found = new Map();
    chapters.flatMap(pinsOf).forEach((pt) => {
      const f = world.features.find((x) => countryHas(x, pt));
      if (f) found.set(f.properties.a3, f);
    });
    return [...found.values()];
  }

  /* ---------- map style, prepared once before the map is created ---------- */
  const PLACE_LAYERS = ["label_state", "label_city", "label_city_capital", "label_town", "label_village", "label_other"];
  const COUNTRY_LAYERS = ["label_country_1", "label_country_2", "label_country_3"];
  const WATER_LABELS = ["water_name_point_label", "water_name_line_label"];
  const NAME_EN = ["coalesce", ["get", "name_en"], ["get", "name:latin"], ["get", "name"]];
  // Over imagery only the larger place names stay, small ones just add noise.
  const FINE_LABELS = ["label_village", "label_other", "label_town", "highway-name-minor", "highway-name-path", "highway-shield-non-us"];
  const LAYER_DEFAULTS = {
    fill: { "fill-color": "#c4301c", "fill-opacity": 0.35 },
    line: { "line-color": "#12161c", "line-width": 1.5 },
    circle: { "circle-color": "#c4301c", "circle-radius": 5 },
  };

  function buildStyle(style, world) {
    const layers = style.layers.map((l) => ({ ...l, layout: { ...(l.layout || {}) }, paint: { ...(l.paint || {}) } }));
    const byId = Object.fromEntries(layers.map((l) => [l.id, l]));
    const used = new Set(layers.map((l) => l.source).filter(Boolean));
    const sources = Object.fromEntries(Object.entries(style.sources).filter(([id]) => used.has(id)));

    // International names only (no local script next to them); no ocean or sea names.
    [...PLACE_LAYERS, ...COUNTRY_LAYERS, ...WATER_LABELS].forEach((id) => { if (byId[id]) byId[id].layout["text-field"] = NAME_EN; });
    WATER_LABELS.forEach((id) => {
      const l = byId[id];
      if (l) l.filter = ["all", l.filter || true, ["!", ["in", ["get", "class"], ["literal", ["ocean", "sea"]]]]];
    });

    // Place names: in full in the CV countries, only the biggest elsewhere. Fixed once, never updated.
    if (world) {
      const cv = cvCountries(world);
      const rank = ["coalesce", ["get", "rank"], 99];
      const cityKeep = ["any", ["within", { type: "FeatureCollection", features: cv }], ["<=", rank, FOREIGN_CITY_RANK]];
      const iso = cv.map((f) => f.properties.iso2);
      const countryKeep = ["any", ["in", ["get", "iso_a2"], ["literal", iso]], ["<=", rank, FOREIGN_COUNTRY_RANK]];
      PLACE_LAYERS.forEach((id) => { const l = byId[id]; if (l) l.filter = ["all", l.filter || true, cityKeep]; });
      COUNTRY_LAYERS.forEach((id) => { const l = byId[id]; if (l) l.filter = ["all", l.filter || true, countryKeep]; });
    }

    // Satellite imagery and relief shading sit under the names; both stay hidden until a chapter asks for them.
    const firstSymbol = layers.findIndex((l) => l.type === "symbol");
    const demSource = { type: "raster-dem", tiles: [DEM_TILES], tileSize: 256, maxzoom: DEM_MAX_ZOOM, encoding: "terrarium" };
    sources.sat = { type: "raster", tiles: [SAT_TILES], tileSize: 256, maxzoom: 13, attribution: SAT_ATTRIBUTION };
    sources.dem = { ...demSource, attribution: DEM_ATTRIBUTION };   // 3D terrain
    sources["dem-shade"] = demSource;                                 // hillshade (separate source for quality)
    layers.splice(firstSymbol < 0 ? layers.length : firstSymbol, 0, {
      id: "sat", type: "raster", source: "sat", layout: { visibility: "none" },
      paint: { "raster-opacity": 0, "raster-opacity-transition": { duration: REDUCED ? 0 : 900, delay: 0 } },
    }, {
      id: "hillshade", type: "hillshade", source: "dem-shade", layout: { visibility: "none" },
      paint: {
        "hillshade-exaggeration": 0.28,   // half the shading: the imagery shows through
        "hillshade-shadow-color": "#000000",
        "hillshade-highlight-color": "rgba(255,255,255,0)",   // shadows only: acts like a multiply over the imagery
        "hillshade-accent-color": "rgba(0,0,0,0)",
      },
    });

    // The saved base map goes above the vector layers and their names, below the spotlight and chapter layers.
    if (!NOBASE) {
      sources.base = { type: "raster", tiles: [BASE_TILES], tileSize: 256, maxzoom: BASE_MAX_ZOOM, attribution: BASE_ATTRIBUTION };
      layers.push({ id: "base", type: "raster", source: "base", paint: { "raster-fade-duration": 0, "raster-opacity": 1 } });
    }

    // Country spotlight: the rest of the world dims, the border draws itself.
    const empty = { type: "FeatureCollection", features: [] };
    sources["spot-dim"] = { type: "geojson", data: empty };
    sources["spot-line"] = { type: "geojson", data: empty, lineMetrics: true };
    layers.push({
      id: "spot-dim", type: "fill", source: "spot-dim",
      paint: { "fill-color": "#030a1c", "fill-opacity": 0, "fill-opacity-transition": { duration: 1000, delay: 0 } },
    }, {
      id: "spot-line", type: "line", source: "spot-line",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#c4301c", "line-width": 3, "line-opacity": 0, "line-opacity-transition": { duration: 400, delay: 0 } },
    });

    // GIS layers of the chapters, hidden until their chapter.
    chapters.forEach((c) => c.layers.forEach((l) => {
      sources[l.id] = { type: "geojson", data: l.url };
      layers.push({
        id: l.id, type: l.type || "fill", source: l.id, layout: { visibility: "none" },
        paint: { ...LAYER_DEFAULTS[l.type || "fill"], ...(l.paint || {}) },
      });
    }));

    return { ...style, sources, layers, projection: { type: "globe" } };
  }

  /* ---------- chapter look: imagery, relief, label colours (paint changes only) ---------- */
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

  // Place names over imagery: plain white, no outline, small ones hidden. Original paints are remembered.
  const LABEL_PAINT = ["text-color", "text-halo-width", "text-halo-blur", "text-opacity", "icon-opacity"];
  let savedPaint = null;
  function setLabelStyle(m, onImagery) {
    if (!savedPaint) {
      savedPaint = {};
      m.getStyle().layers.forEach((l) => {
        if (l.type === "symbol") savedPaint[l.id] = LABEL_PAINT.map((k) => m.getPaintProperty(l.id, k));
      });
    }
    Object.entries(savedPaint).forEach(([id, original]) => {
      const fine = FINE_LABELS.includes(id);
      const values = onImagery ? ["#ffffff", 0, 0, fine ? 0 : original[3], fine ? 0 : original[4]] : original;
      LABEL_PAINT.forEach((k, i) => m.setPaintProperty(id, k, values[i]));
    });
  }

  function applyChapter(m, c) {
    setLabelStyle(m, c.satellite);
    setImagery(m, c.satellite);
  }

  /* ---------- relief: switched on and off behind a still frame ---------- */
  // Relief is drawn on the globe itself (a switch to a flat projection reloaded every tile and showed the sky
  // mid-flight). Flights are flown flat. Switching relief on or off moves the camera height by kilometres and leaves
  // the ground blank until its elevation tiles are read, so it happens behind a still frame of the map: on landing,
  // the 3D view dissolves in once fully drawn; on take-off, the 3D view dissolves into the flight.
  const RELIEF_IN_MS = 700, RELIEF_OUT_MS = 700, RELIEF_MAX_WAIT = 5000;
  const still = document.createElement("canvas");
  still.className = "still";
  still.setAttribute("aria-hidden", "true");
  let reliefToken = 0;

  function setRelief(value) {
    if ((map.__terrain || 0) === value) return;
    map.__terrain = value;
    map.setTerrain(value ? { source: "dem", exaggeration: value } : null);
    map.setLayoutProperty("hillshade", "visibility", value ? "visible" : "none");
  }

  // Copy the map's next frame onto the still canvas and show it. The copy is made inside MapLibre's "render"
  // event, while the WebGL frame is still readable.
  const holdFrame = () => new Promise((resolve) => {
    map.once("render", () => {
      const src = map.getCanvas();
      if (still.width !== src.width || still.height !== src.height) { still.width = src.width; still.height = src.height; }
      still.getContext("2d").drawImage(src, 0, 0);
      still.style.transition = "none";
      still.style.opacity = "1";
      resolve();
    });
    map.triggerRepaint();
  });
  const releaseFrame = (ms) => {
    still.style.transition = `opacity ${ms}ms cubic-bezier(0.4, 0, 0.2, 1)`;
    still.style.opacity = "0";
  };

  // Landing on a relief chapter: hold the landed frame, raise the relief underneath, dissolve once all is drawn.
  function raiseRelief(c) {
    const token = ++reliefToken;
    if (REDUCED) { setRelief(c.terrain); map.jumpTo({ elevation: 0 }); return; }
    holdFrame().then(() => {
      if (token !== reliefToken) { releaseFrame(RELIEF_OUT_MS); return; }   // the reader moved on meanwhile
      setRelief(c.terrain);
      // MapLibre lifts the view centre onto the summit when relief comes on; keeping it at sea level keeps the camera
      // exactly where it landed, so the held frame and the 3D view match and the chapter keeps its designed framing.
      map.jumpTo({ elevation: 0 });
      let done = false;
      const release = () => {
        if (done || token !== reliefToken) return;
        done = true;
        releaseFrame(RELIEF_IN_MS);
      };
      map.once("idle", release);
      setTimeout(release, RELIEF_MAX_WAIT);
    });
  }

  // Leaving it: hold the 3D frame, drop the relief underneath, then start the flight and dissolve into it.
  function leaveRelief(start) {
    const token = ++reliefToken;
    if (REDUCED) { setRelief(0); start(); return; }
    holdFrame().then(() => {
      if (token === reliefToken) setRelief(0);
      start();
      releaseFrame(RELIEF_OUT_MS);
    });
  }

  /* ---------- country spotlight: the border draws itself, the rest of the world dims ---------- */
  const WORLD_RECT = [[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]];
  const spot = { raf: 0, country: "" };

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

  /* ---------- locator: a small 2D map of where the chapter is (desktop) ---------- */
  const insetEl = document.getElementById("inset");
  let locator = null;
  const insetZoom = (c) => Math.min(4, Math.max(1.3, c.zoom * 0.35));

  function updateInset(c, instant = false) {
    if (!insetEl || !locator) return;
    insetEl.classList.toggle("is-visible", c.index > 0);
    const [lng, lat, z] = c.inset || [c.center[0], c.center[1], insetZoom(c)];
    const pins = c.points.length ? c.points.map((p) => [p.lng, p.lat]) : [c.center];
    locator.moveTo(lng, lat, z, pins, instant);
  }

  /* ---------- state ---------- */
  let map = null;
  let world = null;
  let current = -1;
  let scrubbing = false; // dragging along the chapter rail: shorter camera moves
  let ready = false; // scroll tracking waits for the map, markers and layers
  const markers = []; // { chapterIndex, pin, marker, on }

  // Pins are only attached to the map from their chapter on: each attached marker is repositioned every frame.
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
        markers.push({ chapterIndex: c.index, pin, marker: new maplibregl.Marker({ element: pin }).setLngLat(s.lngLat), on: false });
      });
    });
  }

  const showLayers = (index) => chapters.forEach((c) => c.layers.forEach((l) => {
    const want = c.index === index ? "visible" : "none";
    if (map.getLayer(l.id) && map.getLayoutProperty(l.id, "visibility") !== want) map.setLayoutProperty(l.id, "visibility", want);
  }));

  function activate(index, instant = false) {
    if (!ready || index === current) return;
    current = index;
    const c = chapters[index];
    steps.forEach((s, i) => s.classList.toggle("is-active", i === index));
    [...rail.children].forEach((b, i) => {
      b.classList.toggle("is-active", i === index);
      b.setAttribute("aria-current", i === index ? "true" : "false");
    });
    markers.forEach((m) => {
      const on = m.chapterIndex <= index;
      if (on !== m.on) { if (on) m.marker.addTo(map); else m.marker.remove(); m.on = on; }
      m.pin.classList.toggle("is-current", m.chapterIndex === index);
    });
    const flightMs = REDUCED || instant ? 0 : scrubbing ? SCRUB_MS : FLIGHT_MS;
    applyChapter(map, c);
    showLayers(index);
    spotlight(c);
    warmUp([c]);
    const fly = () => moveCamera(map, c, flightMs);
    if (map.__terrain && !c.terrain) {
      if (flightMs > 0) leaveRelief(fly);
      else { ++reliefToken; setRelief(0); fly(); }
    } else {
      if (!c.terrain) ++reliefToken;                  // a pending landing on the relief is no longer wanted
      fly();
    }
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

  // Background downloads give way to the map's own requests while the camera moves.
  function pumpPreload() {
    while (preload.inflight.size < PRELOAD_PARALLEL && preload.queue.length && !(map && map.isMoving())) {
      const url = preload.queue.shift();
      preload.inflight.add(url);
      fetch(url, { mode: "cors", credentials: "omit", priority: "low" })
        .then((r) => (r.ok ? r.arrayBuffer() : null))           // read it fully so the browser stores it
        .then((ok) => { if (ok) preload.done.add(url); })
        .catch(() => {})
        .finally(() => { preload.inflight.delete(url); pumpPreload(); });
    }
  }

  /* ---------- arrival warm-up ---------- */
  // MapLibre only reads the vector tiles of the view it is showing, so a long flight used to land on tiles that were
  // still being read. Now the vector map stops loading during flights (the base map covers it anyway), the arrival
  // view's tiles are read in the background at take-off, and they are handed to MapLibre the moment it asks for them.
  // This relies on MapLibre internals (version pinned in index.html): on any surprise it simply does nothing.
  const warm = { tiles: new Map(), tm: null, hits: 0, misses: 0 };

  const dropTile = (tm, t) => {
    try { t.aborted = true; tm._abortTile(t); tm._unloadTile(t); } catch (_) { /* already gone */ }
  };

  function vectorManager() {
    if (warm.tm) return warm.tm;
    const tm = map.style && map.style.tileManagers && map.style.tileManagers.openmaptiles;
    if (!tm || typeof tm._addTile !== "function" || !tm._outOfViewCache || !tm._inViewTiles || typeof tm.pause !== "function") return null;
    const addTile = tm._addTile.bind(tm);
    tm._addTile = (id) => {
      const t = warm.tiles.get(id.key);
      if (!t && !tm._inViewTiles.getTileById(id.key) && !tm._outOfViewCache.has(id)) {
        warm.misses++;
        if (params.has("debug")) warm.missed = [...(warm.missed || []).slice(-40), `${id.canonical.z}/${id.canonical.x}/${id.canonical.y}`];
      }
      if (t && !tm._inViewTiles.getTileById(id.key)) {
        warm.hits++;
        warm.tiles.delete(id.key);
        if (t.state === "loaded") tm._outOfViewCache.add(id, t);   // picked up below as a cached tile
        else if (t.state === "loading") { t.uses++; tm._inViewTiles.setTile(id.key, t); return t; }
        else dropTile(tm, t);
      }
      return addTile(id);
    };
    return (warm.tm = tm);
  }

  // Vector tiles (512 px) covering a chapter's arrival view, from its zoom, padding, tilt and rotation.
  // A tilted camera sees a trapezoid of ground: its near edge (towards the camera) and far edge are found by casting
  // the top and bottom screen rays (MapLibre's camera: field of view 36.87°, distance 1.5 x the window height).
  // Finer tiles are used near the camera, coarser ones towards the horizon.
  function arrivalTiles(c, maxzoom) {
    const box = map.getContainer(), W = box.clientWidth, H = box.clientHeight;
    const zoom = zoomFor(c), z = Math.max(0, Math.min(maxzoom, Math.floor(zoom)));
    const pad = padding(c);
    const cx = mercX(c.focus[0], zoom) - (pad.left - pad.right) / 2;
    const cy = mercY(c.focus[1], zoom) - (pad.top - pad.bottom) / 2;
    const pitch = (Math.min(c.pitch, map.getMaxPitch()) * Math.PI) / 180;
    const D = 1.5 * H, halfFov = Math.atan(1 / 3), h = D * Math.cos(pitch), back = D * Math.sin(pitch);
    const ground = (a) => {                  // a: angle of a screen ray from the centre ray, towards the top
      const ang = Math.min(pitch + a, (84 * Math.PI) / 180);
      return { s: h * Math.tan(ang) - back, w: ((W / 2) * (h / Math.cos(ang))) / D };
    };
    const near = ground(-halfFov), far = ground(halfFov);
    if (c.terrain) { near.s *= 1.8; far.s *= 1.6; }   // centred on a summit: the ground around lies lower, so further
    const b = (c.bearing * Math.PI) / 180;
    const fwd = [Math.sin(b), -Math.cos(b)], side = [Math.cos(b), Math.sin(b)];   // mercator px: x east, y south
    const at = (s) => near.w + ((far.w - near.w) * (s - near.s)) / (far.s - near.s || 1);
    const band = (s0, s1) => {               // bounding box of the ground between two distances from the centre
      const pts = [s0, s1].flatMap((s) => [-1, 1].map((k) => [cx + fwd[0] * s + side[0] * k * at(s), cy + fwd[1] * s + side[1] * k * at(s)]));
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      return [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    };
    const out = [];
    const cover = (zz, [x0, x1, y0, y1], margin) => {
      if (zz < 0 || zz > maxzoom) return;
      const ts = 512 * 2 ** (zoom - zz), n = 2 ** zz;
      for (let x = Math.floor(x0 / ts) - margin; x <= Math.floor(x1 / ts) + margin; x++) {
        for (let y = Math.max(0, Math.floor(y0 / ts) - margin); y <= Math.min(n - 1, Math.floor(y1 / ts) + margin); y++) {
          out.push([zz, ((x % n) + n) % n, y]);
        }
      }
    };
    if (c.pitch <= 0) { cover(z, band(near.s, far.s), 1); return out; }
    const mid = far.s * 0.35;
    if (c.pitch > 45) cover(z + 1, band(near.s, 0), 0);
    cover(z, band(near.s, c.pitch > 45 ? mid : far.s), c.pitch > 45 ? 0 : 1);
    cover(z - 1, band(0, far.s), 0);
    if (c.pitch > 45) cover(z - 2, band(mid, far.s), 0);
    return out;
  }

  // Read the arrival tiles of these chapters in the background; tiles warmed for other chapters are released.
  function warmUp(list) {
    const tm = vectorManager();
    if (!tm) return;
    try {
      const sample = tm._inViewTiles.getAllTiles()[0];
      if (!sample) return;
      const Tile = sample.constructor, TileID = sample.tileID.constructor, src = tm._source;
      const wanted = new Set();
      list.forEach((c) => arrivalTiles(c, src.maxzoom).forEach(([z, x, y]) => {
        const id = new TileID(z, 0, z, x, y);
        wanted.add(id.key);
        if (warm.tiles.has(id.key) || tm._inViewTiles.getTileById(id.key) || tm._outOfViewCache.has(id)) return;
        const t = new Tile(id, src.tileSize * id.overscaleFactor());
        warm.tiles.set(id.key, t);
        src.loadTile(t)
          .then((res) => { if (!t.aborted) tm._tileLoaded(t, id.key, "loading", res); })
          .catch(() => { t.state = "errored"; if (warm.tiles.get(id.key) === t) warm.tiles.delete(id.key); });
      }));
      warm.tiles.forEach((t, key) => { if (!wanted.has(key)) { warm.tiles.delete(key); dropTile(tm, t); } });
    } catch (_) { /* MapLibre internals changed: no warm-up */ }
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
        if (z <= DEM_MAX_ZOOM) out.push(DEM_TILES.replace("{z}", z).replace("{x}", xx).replace("{y}", y));
        if (c.satellite) out.push(SAT_TILES.replace("{z}", z).replace("{x}", xx).replace("{y}", y));
      }
    }
    return out;
  }

  // Nearest flights first: the one just taken and the next one, then outwards. Re-ordered at every chapter change.
  function preloadAround(index) {
    if (NOBASE || (navigator.connection && navigator.connection.saveData)) return;
    const first = [];     // the relief of terrain chapters goes before the base map
    chapters.forEach((c) => { if (c.terrain) first.push(...terrainTilesFor(c)); });
    const lead = [...new Set(first)].filter((u) => !preload.done.has(u) && !preload.inflight.has(u));
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
  // "instant" is explicit: the page has scroll-behavior: smooth, which would turn "auto" into an animation.
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
    reveal(i, instant || REDUCED ? "instant" : "smooth");
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
    // Cards rest centred in the window through CSS scroll snapping (see css); the chapter changes when its card
    // crosses the middle band.
    const io = new IntersectionObserver((entries) => {
      if (!ready) return;
      entries.forEach((e) => { if (e.isIntersecting) activate(Number(e.target.dataset.index)); });
    }, { rootMargin: "-45% 0px -45% 0px" });
    steps.forEach((el) => io.observe(el));

    // Up / Down arrows step from chapter to chapter (instead of nudging the page a few pixels).
    addEventListener("keydown", (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      if (/^(INPUT|TEXTAREA|SELECT|IFRAME)$/.test((e.target && e.target.tagName) || "")) return;
      const i = Math.min(chapters.length - 1, Math.max(0, current + (e.key === "ArrowDown" ? 1 : -1)));
      e.preventDefault();
      if (i !== current) reveal(i, REDUCED ? "instant" : "smooth");
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
    hint.addEventListener("click", () => reveal(1, REDUCED ? "instant" : "smooth"));
    armHint();
  }

  /* ---------- while the camera moves: base map on, sky still, downloads paused ---------- */
  function watchMotion() {
    // Opaque while the camera moves; it leaves as soon as every tile of the view is loaded (not at "idle",
    // which waits much longer). A timer guarantees it never stays on.
    // Only real changes reach the style: any paint change repaints the map, and repainting on "idle" would
    // start an endless render loop.
    let baseTimer = 0, baseOpacity = 1;
    const setBase = (opacity, ms) => {
      if (opacity === baseOpacity || !map.getLayer("base")) return;
      baseOpacity = opacity;
      map.setPaintProperty("base", "raster-opacity-transition", { duration: ms, delay: 0 });
      map.setPaintProperty("base", "raster-opacity", opacity);
    };
    // Once the reader has landed, the arrival views of the chapters before and after are read in the background.
    const warmNeighbours = () => warmUp([chapters[current - 1], chapters[current + 1]].filter(Boolean));
    const revealWhenLoaded = () => {
      if (map.isMoving() || !map.areTilesLoaded()) return;
      map.off("render", revealWhenLoaded);
      clearTimeout(baseTimer);
      requestAnimationFrame(() => requestAnimationFrame(() => {   // let the names settle for two frames first
        if (map.isMoving()) return;
        setBase(0, BASE_REVEAL_MS);
        warmNeighbours();
      }));
    };
    // The vector map rests while the camera flies under the base map; it resumes on landing.
    const vectorRest = (on) => {
      const tm = vectorManager();
      if (!tm) return;
      try { if (on) tm.pause(); else tm.resume(); } catch (_) { /* keep loading normally */ }
    };
    // The sky can only be seen around the globe: once the globe is wider than the window it can rest.
    const skyVisible = () => {
      const radius = (512 * 2 ** map.getZoom()) / (2 * Math.PI);
      const box = map.getContainer();
      return radius < Math.hypot(box.clientWidth, box.clientHeight) * 0.75;
    };
    const sky = (on) => window.starfield && window.starfield.run(on);

    map.on("movestart", () => {
      clearTimeout(baseTimer);
      map.off("render", revealWhenLoaded);
      setBase(1, 0);
      if (!NOBASE) vectorRest(true);
      sky(false);
    });
    // A reload (label colours switching over imagery, for instance) wakes the vector map up: rest again.
    map.on("move", () => { if (!NOBASE && warm.tm && !warm.tm._paused && map.isMoving()) vectorRest(true); });
    map.on("moveend", () => {
      clearTimeout(baseTimer);
      const c = chapters[current];
      if (c && c.terrain && !map.__terrain) raiseRelief(c);
      vectorRest(false);
      map.on("render", revealWhenLoaded);
      baseTimer = setTimeout(() => { if (!map.isMoving()) setBase(0, 700); }, 6000);
      revealWhenLoaded();
      map.triggerRepaint();
      sky(skyVisible());
      pumpPreload();
    });
    map.on("idle", () => { if (!map.isMoving()) { clearTimeout(baseTimer); setBase(0, BASE_REVEAL_MS); } });
  }

  /* ---------- boot ---------- */
  // The style and the world outline are fetched together, the style is prepared, then the map is created once.
  async function boot() {
    const [style, w] = await Promise.all([
      fetch(STYLE_URL).then((r) => r.json()),
      fetch(WORLD_URL).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    world = w;
    // Tiles are read in background workers; MapLibre starts only one. Two to four read arrivals in parallel.
    try {
      if (maplibregl.setWorkerCount) maplibregl.setWorkerCount(Math.min(4, Math.max(2, Math.floor((navigator.hardwareConcurrency || 4) / 2))));
    } catch (_) { /* already started */ }
    const start = chapters[initialIndex()];
    map = new maplibregl.Map({
      container: "map",
      style: buildStyle(style, world),
      center: start.center,
      zoom: zoomFor(start),
      interactive: false,           // page scroll must never be hijacked by the map
      attributionControl: isMobile() ? false : { compact: true },
      maxTileCacheSize: 300,        // revisited chapters keep their tiles
      fadeDuration: 0,              // names and symbols appear with their tiles, no fade-in delay
      pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
    });
    map.on("error", (e) => console.warn("Map:", (e && e.error && e.error.message) || e));
    map.getContainer().after(still);
    if (map.setCenterClampedToGround) map.setCenterClampedToGround(false);   // relief never moves the camera (see raiseRelief)
    if (params.has("debug")) window.__storymap = { map, preload: () => preload, warm: () => warm };

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

    if (insetEl && !isMobile() && world && window.createLocator) locator = window.createLocator(insetEl, world);
    watchMotion();

    map.on("load", () => {
      buildMarkers();
      const i = initialIndex();
      if (i > 0) reveal(i, "instant");
      ready = true;
      activate(i, true);
      if (i > 0) keepDeepLinkInView(i);
    });
    addEventListener("resize", () => { if (ready) moveCamera(map, chapters[Math.max(current, 0)], 0); });
  }

  boot().catch((err) => console.warn("Map unavailable:", err));
})();
