/* Storymap: one fixed MapLibre map, one HTML section per chapter.
   Camera, markers and (later) GIS layers are read from data-* attributes. */
(() => {
  const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const STYLE_URL = "https://tiles.openfreemap.org/styles/positron";
  const ARC_STEPS = 48;

  const steps = [...document.querySelectorAll(".step")];
  const rail = document.getElementById("rail");

  /* ---------- config parsed from the HTML ---------- */
  const parseNums = (s) => (s ? s.split(",").map(Number) : null);

  const chapters = steps.map((el, i) => {
    const d = el.dataset;
    const bounds = parseNums(d.bounds);
    return {
      el,
      title: d.title || "",
      year: d.year || "",
      center: parseNums(d.center),
      zoom: d.zoom ? Number(d.zoom) : 5,
      pitch: d.pitch ? Number(d.pitch) : 0,
      bearing: d.bearing ? Number(d.bearing) : 0,
      bounds: bounds ? [[bounds[0], bounds[1]], [bounds[2], bounds[3]]] : null,
      points: d.points ? JSON.parse(d.points) : [],
      layers: d.layers ? JSON.parse(d.layers) : [],
      index: i,
    };
  });

  const card = (c) => c.el.querySelector(".card");
  chapters.forEach((c, i) => {
    const el = card(c);
    if (el && i > 0) el.dataset.n = String(i).padStart(2, "0");
  });

  /* ---------- helpers ---------- */
  const padding = () =>
    innerWidth >= 900
      ? { top: 80, bottom: 40, left: Math.min(560, Math.round(innerWidth * 0.44)), right: 70 }
      : { top: 80, bottom: Math.round(innerHeight * 0.55), left: 20, right: 20 };

  // Great-circle arc between two [lng, lat] points (so long hops curve on the globe).
  function arc([lng1, lat1], [lng2, lat2]) {
    const rad = Math.PI / 180;
    const [φ1, λ1, φ2, λ2] = [lat1 * rad, lng1 * rad, lat2 * rad, lng2 * rad];
    const d = 2 * Math.asin(Math.sqrt(
      Math.sin((φ2 - φ1) / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin((λ2 - λ1) / 2) ** 2));
    if (d === 0) return [[lng1, lat1], [lng2, lat2]];
    const out = [];
    for (let k = 0; k <= ARC_STEPS; k++) {
      const f = k / ARC_STEPS;
      const A = Math.sin((1 - f) * d) / Math.sin(d);
      const B = Math.sin(f * d) / Math.sin(d);
      const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
      const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
      const z = A * Math.sin(φ1) + B * Math.sin(φ2);
      out.push([Math.atan2(y, x) / rad, Math.atan2(z, Math.hypot(x, y)) / rad]);
    }
    return out;
  }

  const sameSpot = (a, b) => Math.abs(a[0] - b[0]) < 0.2 && Math.abs(a[1] - b[1]) < 0.2;

  /* ---------- map ---------- */
  const first = chapters[0];
  const map = new maplibregl.Map({
    container: "map",
    style: STYLE_URL,
    center: first.center,
    zoom: first.zoom,
    interactive: false,           // page scroll must never be hijacked by the map
    attributionControl: { compact: true },
  });

  let current = 0;
  const markers = []; // { chapterIndex, marker, pin, isPrimary }

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
        const marker = new maplibregl.Marker({ element: pin }).setLngLat(s.lngLat).addTo(map);
        markers.push({ chapterIndex: c.index, marker, pin });
      });
    });
  }

  function buildRoute() {
    const features = [];
    let prev = null;
    chapters.forEach((c) => {
      if (c.index === 0 || c.points.length) { if (c.points.length) prev = prev; return; }
      if (prev && !sameSpot(prev.center, c.center)) {
        features.push({
          type: "Feature",
          properties: { to: c.index },
          geometry: { type: "LineString", coordinates: arc(prev.center, c.center) },
        });
      }
      prev = c;
    });
    map.addSource("route", { type: "geojson", data: { type: "FeatureCollection", features } });
    map.addLayer({
      id: "route", type: "line", source: "route",
      filter: ["<=", ["get", "to"], 0],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#c4301c", "line-width": 2, "line-opacity": 0.85 },
    });
  }

  // GIS layers: <section data-layers='[{"id":"x","url":"assets/geo/x.geojson","type":"fill","paint":{...}}]'>
  const LAYER_DEFAULTS = {
    fill: { "fill-color": "#c4301c", "fill-opacity": 0.35 },
    line: { "line-color": "#12161c", "line-width": 1.5 },
    circle: { "circle-color": "#c4301c", "circle-radius": 5 },
  };
  function buildLayers() {
    chapters.forEach((c) => {
      c.layers.forEach((l) => {
        map.addSource(l.id, { type: "geojson", data: l.url });
        map.addLayer({
          id: l.id, type: l.type || "fill", source: l.id,
          layout: { visibility: "none" },
          paint: { ...LAYER_DEFAULTS[l.type || "fill"], ...(l.paint || {}) },
        });
      });
    });
  }

  function showLayers(index) {
    chapters.forEach((c) => c.layers.forEach((l) => {
      if (map.getLayer(l.id)) {
        map.setLayoutProperty(l.id, "visibility", c.index === index ? "visible" : "none");
      }
    }));
  }

  function fly(c) {
    const opts = {
      padding: padding(), pitch: c.pitch, bearing: c.bearing,
      duration: REDUCED ? 0 : 2600, essential: true,
    };
    if (c.bounds) map.fitBounds(c.bounds, { ...opts, maxZoom: c.zoom });
    else map.flyTo({ center: c.center, zoom: c.zoom, ...opts });
  }

  function activate(index) {
    if (index === current && steps[index].classList.contains("is-active")) return;
    current = index;
    steps.forEach((s, i) => s.classList.toggle("is-active", i === index));
    [...rail.children].forEach((b, i) => b.classList.toggle("is-active", i === index));
    markers.forEach((m) => {
      m.pin.style.display = m.chapterIndex <= index ? "" : "none";
      m.pin.classList.toggle("is-current", m.chapterIndex === index);
    });
    if (map.getLayer("route")) map.setFilter("route", ["<=", ["get", "to"], index]);
    showLayers(index);
    fly(chapters[index]);
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
    entries.forEach((e) => { if (e.isIntersecting) activate(Number(e.target.dataset.index)); });
  }, { rootMargin: "-45% 0px -45% 0px" });
  steps.forEach((s, i) => { s.dataset.index = i; io.observe(s); });

  /* ---------- lite YouTube embeds ---------- */
  document.querySelectorAll(".video").forEach((btn) => {
    const { id, start = "0", title = "Video" } = btn.dataset;
    btn.style.backgroundImage = `url(https://i.ytimg.com/vi/${id}/hqdefault.jpg)`;
    btn.setAttribute("aria-label", `Play video: ${title}`);
    btn.innerHTML = `<span class="play"></span><span class="cap">${title}</span>`;
    btn.addEventListener("click", () => {
      const f = document.createElement("iframe");
      f.src = `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&start=${start}`;
      f.title = title;
      f.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
      f.allowFullscreen = true;
      btn.replaceChildren(f);
    }, { once: true });
  });

  /* ---------- boot ---------- */
  map.on("style.load", () => {
    if (map.setProjection) map.setProjection({ type: "globe" });
  });
  map.on("load", () => {
    buildMarkers();
    buildRoute();
    buildLayers();
    activate(0);
  });
  addEventListener("resize", () => fly(chapters[current]));
})();
