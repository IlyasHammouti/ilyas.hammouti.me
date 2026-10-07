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
  const WARM_AHEAD = 3;           // chapters pre-loaded ahead of the one being read

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
    if (innerWidth < 900) return { top: 80, bottom: Math.round(innerHeight * 0.55), left: 20, right: 20 };
    const card = c.el.querySelector(".card");
    const reserved = card ? card.getBoundingClientRect().right + 24 : 0;
    const railRoom = innerWidth >= 1200 ? 190 : 80;
    return { top: 80, bottom: 40, left: Math.min(reserved, Math.round(innerWidth * 0.62)), right: railRoom };
  };

  const moveCamera = (m, c, duration) => m.flyTo({
    center: c.focus, zoom: c.zoom, pitch: c.pitch, bearing: c.bearing,
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
      id: "sat", type: "raster", source: "sat",
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
  }

  // Over imagery only the larger place names stay, small ones just add noise.
  const FINE_LABELS = ["label_village", "label_other", "label_town", "highway-name-minor", "highway-name-path", "highway-shield-non-us"];

  function applyChapter(m, c) {
    if (!m.getLayer("sat")) return;
    const projection = c.terrain ? "mercator" : "globe";
    if (m.__projection !== projection && m.setProjection) {
      m.setProjection({ type: projection });
      m.__projection = projection;
    }
    m.setPaintProperty("sat", "raster-opacity", c.satellite ? 1 : 0);
    FINE_LABELS.forEach((id) => m.getLayer(id) && m.setLayoutProperty(id, "visibility", c.satellite ? "none" : "visible"));
    m.setLayoutProperty("hillshade", "visibility", c.terrain ? "visible" : "none");
    m.setTerrain(c.terrain ? { source: "dem", exaggeration: c.terrain } : null);
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
    const before = firstSymbolId(m);
    m.addSource("spot-dim", { type: "geojson", data: empty });
    m.addSource("spot-line", { type: "geojson", data: empty, lineMetrics: true });
    m.addLayer({
      id: "spot-dim", type: "fill", source: "spot-dim",
      paint: { "fill-color": "#030a1c", "fill-opacity": 0, "fill-opacity-transition": { duration: 1000, delay: 0 } },
    }, before);
    m.addLayer({
      id: "spot-line", type: "line", source: "spot-line",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#c4301c", "line-width": 3, "line-opacity": 0, "line-opacity-transition": { duration: 400, delay: 0 } },
    }, before);
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
    if (!insetEl || innerWidth < 900) return;
    inset = new maplibregl.Map({
      container: insetEl, style: STYLE_URL, center: chapters[0].center, zoom: 1.5,
      interactive: false, attributionControl: false,
    });
    inset.on("error", () => {});
    inset.on("load", () => {
      // A clean locator: only country names stay.
      inset.getStyle().layers.forEach((l) => {
        if (l.type === "symbol" && !COUNTRY_LAYERS.includes(l.id)) inset.setLayoutProperty(l.id, "visibility", "none");
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
    attributionControl: { compact: true },
  });

  let current = -1;
  let scrubbing = false; // dragging along the chapter rail: shorter camera moves
  let ready = false; // scroll tracking waits for the map, markers and layers
  const markers = []; // { chapterIndex, pin }

  function buildMarkers() {
    chapters.forEach((c) => {
      const spots = c.points.length
        ? c.points.map((p) => ({ lngLat: [p.lng, p.lat], label: p.label }))
        : c.index === 0 || c.country ? [] : [{ lngLat: c.center }];
      spots.forEach((s) => {
        const pin = document.createElement("div");
        pin.className = "pin";
        if (s.label) {
          const l = document.createElement("span");
          l.className = "pin-label";
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
    scheduleWarm(index);
  }

  /* ---------- rolling pre-load: while chapter N is read, N+1.. load in the background ---------- */
  // A hidden twin map visits the upcoming chapters' views, so their tiles (vector, imagery,
  // relief, glyphs) are in the browser cache when the camera gets there.
  let twin = null;
  let warmToken = 0;
  let warmTimer = 0;

  async function ensureTwin() {
    if (twin) return twin;
    const host = document.createElement("div");
    host.setAttribute("aria-hidden", "true");
    host.style.cssText = `position:fixed;left:0;top:0;width:${innerWidth}px;height:${innerHeight}px;opacity:0;pointer-events:none;z-index:-2`;
    document.body.appendChild(host);
    const m = new maplibregl.Map({ container: host, style: STYLE_URL, interactive: false, attributionControl: false, fadeDuration: 0 });
    m.on("error", () => {}); // best effort: tile hiccups are irrelevant here
    await new Promise((r) => m.once("load", r));
    addExtras(m);
    twin = m;
    return m;
  }

  const settle = (m) => new Promise((resolve) => {
    const t = setTimeout(resolve, 7000);
    m.once("idle", () => { clearTimeout(t); resolve(); });
  });

  function scheduleWarm(from) {
    if (navigator.connection && navigator.connection.saveData) return;
    clearTimeout(warmTimer);
    const token = ++warmToken;
    warmTimer = setTimeout(async () => {
      try {
        const m = await ensureTwin();
        for (let k = 1; k <= WARM_AHEAD; k++) {
          const c = chapters[from + k];
          if (!c || token !== warmToken) return;
          applyChapter(m, c);
          moveCamera(m, c, 0);
          await settle(m);
        }
      } catch (err) {
        console.warn("Tile pre-load skipped:", err);
      }
    }, 1200);
  }

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
    chapters[i].el.scrollIntoView({ behavior: instant || REDUCED ? "auto" : "smooth", block: "center" });
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
  const io = new IntersectionObserver((entries) => {
    if (!ready) return;
    entries.forEach((e) => { if (e.isIntersecting) activate(Number(e.target.dataset.index)); });
  }, { rootMargin: "-45% 0px -45% 0px" });
  steps.forEach((s, i) => { s.dataset.index = i; io.observe(s); });

  /* ---------- portfolio links remember where the reader was ---------- */
  document.addEventListener("click", (e) => {
    const a = e.target.closest('a[href^="portfolio.html"]');
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
    btn.addEventListener("click", () => {
      const f = document.createElement("iframe");
      f.src = `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&start=${t}`;
      f.title = title;
      f.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
      f.referrerPolicy = "strict-origin-when-cross-origin";
      f.allowFullscreen = true;
      box.replaceChildren(f);
    }, { once: true });
    box.appendChild(btn);
  });


  // Fonts and images finishing after the first scroll can shift the page; until the reader
  // takes over, keep a deep-linked chapter (e.g. "Back to the map") centred.
  function keepDeepLinkInView(i) {
    let moved = false;
    ["wheel", "touchstart", "keydown", "pointerdown"].forEach((ev) =>
      addEventListener(ev, () => { moved = true; }, { once: true, passive: true }));
    const realign = () => { if (!moved) steps[i].scrollIntoView({ behavior: "instant", block: "center" }); };
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(realign);
    if (document.readyState !== "complete") addEventListener("load", realign, { once: true });
    setTimeout(realign, 1500);
  }

  /* ---------- scroll reminder: shown when the reader sits at the top, idle for 2 s ---------- */
  const hint = document.getElementById("scrollhint");
  if (hint) {
    let hintTimer = 0;
    const atTop = () => window.scrollY < 8;
    const armHint = () => {
      clearTimeout(hintTimer);
      hint.classList.remove("is-visible");
      if (atTop()) hintTimer = setTimeout(() => { if (atTop()) hint.classList.add("is-visible"); }, 2000);
    };
    ["pointermove", "pointerdown", "keydown", "wheel", "touchstart", "scroll"].forEach((ev) =>
      addEventListener(ev, armHint, { passive: true }));
    hint.addEventListener("click", () => chapters[1].el.scrollIntoView({ behavior: REDUCED ? "auto" : "smooth", block: "center" }));
    armHint();
  }

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
    if (i > 0) steps[i].scrollIntoView({ behavior: "instant", block: "center" });
    buildInset();
    ready = true;
    activate(i, true);
    if (i > 0) keepDeepLinkInView(i);
    await setupPlaceNames(map);
  });
  addEventListener("resize", () => moveCamera(map, chapters[Math.max(current, 0)], 0));
})();
