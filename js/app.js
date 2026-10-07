/* Storymap: one fixed MapLibre map, one HTML section per chapter.
   Camera, markers, basemap options and (later) GIS layers come from data-* attributes:
     data-center / data-zoom / data-pitch / data-bearing   camera
     data-points='[{"lng":..,"lat":..,"label":".."}]'      extra labelled pins
     data-basemap="satellite"                              Sentinel-2 imagery under the labels
     data-terrain="1.6"                                    3D relief (exaggeration) + hillshade
     data-buildings="true"                                 3D buildings
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
      zoom: d.zoom ? Number(d.zoom) : 5,
      pitch: d.pitch ? Number(d.pitch) : 0,
      bearing: d.bearing ? Number(d.bearing) : 0,
      satellite: d.basemap === "satellite",
      terrain: d.terrain ? Number(d.terrain) : 0,
      buildings: d.buildings === "true",
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
    center: c.center, zoom: c.zoom, pitch: c.pitch, bearing: c.bearing,
    padding: padding(c), duration, essential: true,
  });

  const initialIndex = () => {
    const i = chapters.findIndex((c) => c.id === location.hash.slice(1));
    return i > 0 ? i : 0;
  };

  /* ---------- optional basemap layers: satellite, relief, 3D buildings ---------- */
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
      paint: { "hillshade-exaggeration": 0.45, "hillshade-shadow-color": "#05080c", "hillshade-highlight-color": "#ffffff" },
    }, before);

    m.addLayer({
      id: "buildings-3d", type: "fill-extrusion", source: "openmaptiles", "source-layer": "building",
      minzoom: 13, layout: { visibility: "none" },
      paint: {
        "fill-extrusion-color": ["interpolate", ["linear"], ["coalesce", ["get", "render_height"], 6],
          0, "#e6e1d6", 40, "#d3cdc0", 120, "#bdb5a5"],
        "fill-extrusion-height": ["coalesce", ["get", "render_height"], 6],
        "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
        "fill-extrusion-opacity": 0.92,
        "fill-extrusion-vertical-gradient": true,
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
    m.setLayoutProperty("buildings-3d", "visibility", c.buildings ? "visible" : "none");
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

    let world;
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
  let ready = false; // scroll tracking waits for the map, markers and layers
  const markers = []; // { chapterIndex, pin }

  function buildMarkers() {
    chapters.forEach((c) => {
      const spots = c.points.length
        ? c.points.map((p) => ({ lngLat: [p.lng, p.lat], label: p.label }))
        : c.index === 0 ? [] : [{ lngLat: c.center }];
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
    moveCamera(map, c, REDUCED || instant ? 0 : 2600);
    try { history.replaceState(null, "", index === 0 ? location.pathname : "#" + c.id); } catch (_) { /* ignore */ }
    scheduleWarm(index);
  }

  /* ---------- rolling pre-load: while chapter N is read, N+1.. load in the background ---------- */
  // A hidden twin map visits the upcoming chapters' views, so their tiles (vector, imagery,
  // relief, 3D buildings, glyphs) are in the browser cache when the camera gets there.
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
    b.addEventListener("click", () => c.el.scrollIntoView({ behavior: REDUCED ? "auto" : "smooth", block: "center" }));
    rail.appendChild(b);
  });

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

  /* ---------- boot ---------- */
  map.on("error", (e) => console.warn("Map:", (e && e.error && e.error.message) || e));
  map.on("style.load", () => {
    if (map.setProjection) { map.setProjection({ type: "globe" }); map.__projection = "globe"; }
  });
  map.on("load", async () => {
    addExtras(map);
    buildMarkers();
    buildLayers();
    const i = initialIndex();
    if (i > 0) steps[i].scrollIntoView({ behavior: "instant", block: "center" });
    ready = true;
    activate(i, true);
    await setupPlaceNames(map);
  });
  addEventListener("resize", () => moveCamera(map, chapters[Math.max(current, 0)], 0));
})();
