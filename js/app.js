/* Storymap: one fixed MapLibre map, one HTML section per chapter.
   Camera, markers, basemap and (later) GIS layers are read from data-* attributes. */
(() => {
  const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const STYLE_URL = "https://tiles.openfreemap.org/styles/positron";
  const SAT_TILES = "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/{z}/{y}/{x}.jpg";
  const SAT_ATTRIBUTION =
    '<a href="https://s2maps.eu" target="_blank" rel="noopener">Sentinel-2 cloudless</a> by EOX (contains modified Copernicus Sentinel data 2024)';
  const DEFAULT_BASEMAP = "map"; // "map" | "satellite"; override per chapter with data-basemap

  // Countries whose place names stay visible; everything else is masked.
  const KEPT_COUNTRIES = ["France", "Switzerland", "Indonesia", "Nepal", "Italy", "Latvia"];

  const steps = [...document.querySelectorAll(".step")];
  const rail = document.getElementById("rail");

  /* ---------- config parsed from the HTML ---------- */
  const parseNums = (s) => (s ? s.split(",").map(Number) : null);

  const chapters = steps.map((el, i) => {
    const d = el.dataset;
    const bounds = parseNums(d.bounds);
    return {
      el,
      id: el.id,
      title: d.title || "",
      year: d.year || "",
      center: parseNums(d.center),
      zoom: d.zoom ? Number(d.zoom) : 5,
      pitch: d.pitch ? Number(d.pitch) : 0,
      bearing: d.bearing ? Number(d.bearing) : 0,
      bounds: bounds ? [[bounds[0], bounds[1]], [bounds[2], bounds[3]]] : null,
      basemap: d.basemap || DEFAULT_BASEMAP,
      points: d.points ? JSON.parse(d.points) : [],
      layers: d.layers ? JSON.parse(d.layers) : [],
      index: i,
    };
  });

  chapters.forEach((c, i) => {
    const card = c.el.querySelector(".card");
    if (card && i > 0) card.dataset.n = String(i).padStart(2, "0");
  });

  /* ---------- helpers ---------- */
  // Keep the focus point clear of the card: reserve the card's real width on desktop,
  // the lower half of the screen on mobile.
  const padding = (c) => {
    if (innerWidth < 900) return { top: 80, bottom: Math.round(innerHeight * 0.55), left: 20, right: 20 };
    const card = c.el.querySelector(".card");
    const reserved = card ? card.getBoundingClientRect().right + 24 : 0;
    return { top: 80, bottom: 40, left: Math.min(reserved, Math.round(innerWidth * 0.62)), right: 110 };
  };

  const cameraOptions = (c, duration) => ({
    padding: padding(c), pitch: c.pitch, bearing: c.bearing, duration, essential: true,
  });

  function moveCamera(m, c, duration) {
    const o = cameraOptions(c, duration);
    if (c.bounds) {
      try {
        m.fitBounds(c.bounds, { ...o, maxZoom: c.zoom });
        return;
      } catch (err) {
        console.warn("fitBounds failed, centring on the bounds instead:", err);
      }
      const [[w, s], [e, n]] = c.bounds;
      m.flyTo({ center: [(w + e) / 2, (s + n) / 2], zoom: c.zoom, ...o });
      return;
    }
    m.flyTo({ center: c.center, zoom: c.zoom, ...o });
  }

  const initialIndex = () => {
    const i = chapters.findIndex((c) => c.id === location.hash.slice(1));
    return i > 0 ? i : 0;
  };

  /* ---------- basemap: satellite layer + toponym mask ---------- */
  function addSatellite(m) {
    m.addSource("sat", { type: "raster", tiles: [SAT_TILES], tileSize: 256, maxzoom: 13, attribution: SAT_ATTRIBUTION });
    const firstSymbol = m.getStyle().layers.find((l) => l.type === "symbol");
    m.addLayer({
      id: "sat", type: "raster", source: "sat",
      paint: { "raster-opacity": 0, "raster-opacity-transition": { duration: REDUCED ? 0 : 900, delay: 0 } },
    }, firstSymbol && firstSymbol.id);
  }

  // Over imagery only the larger place names stay, small ones just add noise.
  const FINE_LABELS = ["label_village", "label_other", "label_town", "highway-name-minor", "highway-name-path", "highway-shield-non-us"];
  function setSatellite(m, on) {
    if (!m.getLayer("sat")) return;
    m.setPaintProperty("sat", "raster-opacity", on ? 1 : 0);
    FINE_LABELS.forEach((id) => m.getLayer(id) && m.setLayoutProperty(id, "visibility", on ? "none" : "visible"));
  }

  // Keep only the place names of countries that appear in the CV.
  async function maskToponyms(m) {
    let countries;
    try {
      countries = await (await fetch("assets/geo/countries.json")).json();
    } catch (err) {
      console.warn("Toponym mask unavailable:", err);
      return;
    }
    const inside = ["within", countries];
    const keepCountry = ["in", ["coalesce", ["get", "name_en"], ["get", "name"]], ["literal", KEPT_COUNTRIES]];
    const mask = {
      label_country_1: keepCountry, label_country_2: keepCountry, label_country_3: keepCountry,
      label_state: inside, label_city: inside, label_city_capital: inside,
      label_town: inside, label_village: inside, label_other: inside,
      water_name_point_label: ["!", ["in", ["get", "class"], ["literal", ["ocean", "sea"]]]],
      water_name_line_label: ["!", ["in", ["get", "class"], ["literal", ["ocean", "sea"]]]],
    };
    Object.entries(mask).forEach(([id, extra]) => {
      if (!m.getLayer(id)) return;
      const orig = m.getFilter(id);
      m.setFilter(id, orig ? ["all", orig, extra] : extra);
    });
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

  // GIS layers: <section data-layers='[{"id":"x","url":"assets/geo/x.geojson","type":"fill","paint":{...}}]'>
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
    [...rail.children].forEach((b, i) => b.classList.toggle("is-active", i === index));
    markers.forEach((m) => {
      m.pin.style.display = m.chapterIndex <= index ? "" : "none";
      m.pin.classList.toggle("is-current", m.chapterIndex === index);
    });
    setSatellite(map, c.basemap === "satellite");
    showLayers(index);
    moveCamera(map, c, REDUCED || instant ? 0 : 2600);
    try { history.replaceState(null, "", index === 0 ? location.pathname : "#" + c.id); } catch (_) { /* ignore */ }
  }

  /* ---------- warm the tile cache for every chapter ---------- */
  // A hidden twin map visits each chapter's view once, so tiles are already in the
  // browser cache when the reader gets there.
  async function warmCache() {
    if (navigator.connection && navigator.connection.saveData) return;
    const host = document.createElement("div");
    host.setAttribute("aria-hidden", "true");
    host.style.cssText = `position:fixed;left:0;top:0;width:${innerWidth}px;height:${innerHeight}px;opacity:0;pointer-events:none;z-index:-1`;
    document.body.appendChild(host);
    const twin = new maplibregl.Map({ container: host, style: STYLE_URL, interactive: false, attributionControl: false, fadeDuration: 0 });
    twin.on("error", () => {}); // best-effort warm-up: tile hiccups are irrelevant here
    await new Promise((r) => twin.once("load", r));
    addSatellite(twin);
    for (const c of chapters) {
      setSatellite(twin, c.basemap === "satellite");
      moveCamera(twin, c, 0);
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 6000);
        twin.once("idle", () => { clearTimeout(t); resolve(); });
      });
    }
    twin.remove();
    host.remove();
  }

  /* ---------- rail ---------- */
  chapters.forEach((c, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("aria-label", c.title || `Chapter ${i}`);
    b.innerHTML = `<span>${c.year ? c.year + " · " : ""}${c.title}</span>`;
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
    if (map.setProjection) map.setProjection({ type: "globe" });
  });
  map.on("load", async () => {
    addSatellite(map);
    buildMarkers();
    buildLayers();
    const i = initialIndex();
    if (i > 0) steps[i].scrollIntoView({ behavior: "instant", block: "center" });
    ready = true;
    activate(i, true);
    await maskToponyms(map);
    map.once("idle", () => setTimeout(() => warmCache().catch((err) => console.warn("Tile warm-up skipped:", err)), 800));
  });
  addEventListener("resize", () => moveCamera(map, chapters[Math.max(current, 0)], 0));
})();
