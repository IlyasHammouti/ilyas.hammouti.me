/* Locator: the small "where is this" map. Drawn in 2D from a simplified world (assets/geo/world.json) instead of a
   second WebGL map: about a millisecond a frame, crisp at any pixel density, and it only redraws while it moves.
   Colours follow the main map (OpenFreeMap Positron). Zoom has the same meaning as in MapLibre (world = 512 * 2^z px). */
(() => {
  const COLORS = { water: "rgb(194,200,202)", land: "rgb(242,243,240)", border: "rgba(120,120,120,0.55)", text: "#2a2f36", halo: "#fff" };
  const FONT = '500 10px Inter, system-ui, sans-serif';
  const MOVE_MS = 1400;
  const MIN_LABEL_PX = 34;          // a country gets its name once it is about this wide on screen

  const clampLat = (lat) => Math.max(-85, Math.min(85, lat));
  const ux = (lng) => (lng + 180) / 360;
  const uy = (lat) => {
    const s = Math.sin((clampLat(lat) * Math.PI) / 180);
    return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  };
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  window.createLocator = (el, world) => {
    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    el.appendChild(canvas);
    const ctx = canvas.getContext("2d");

    // The whole world as one path in unit Mercator space [0..1]: one fill and one stroke a frame.
    const land = new Path2D();
    const labels = [];
    world.features.forEach((f) => {
      const g = f.geometry;
      const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
      polys.forEach((poly) => poly.forEach((ring) => {
        ring.forEach(([lng, lat], i) => (i ? land.lineTo(ux(lng), uy(lat)) : land.moveTo(ux(lng), uy(lat))));
        land.closePath();
      }));
      const { name, label, area } = f.properties;
      if (name && label) labels.push({ name, x: ux(label[0]), y: uy(label[1]), size: Math.sqrt(area || 0) / 360 });
    });
    labels.sort((a, b) => b.size - a.size);

    let W = 0, H = 0, dpr = 1;
    let cam = { x: 0.5, y: 0.5, z: 1.5 };
    let pins = [];
    let anim = null, raf = 0;

    function resize() {
      W = el.clientWidth; H = el.clientHeight;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      canvas.style.width = W + "px"; canvas.style.height = H + "px";
      draw();
    }

    function draw() {
      if (!W || !H) return;
      const s = 512 * 2 ** cam.z;                        // world size in css px
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = COLORS.water;
      ctx.fillRect(0, 0, W, H);
      const copies = [-1, 0, 1].filter((k) => {          // world copies needed around the antimeridian
        const left = W / 2 + (k - cam.x) * s;
        return left < W && left + s > 0;
      });
      copies.forEach((k) => {
        ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * (W / 2 + (k - cam.x) * s), dpr * (H / 2 - cam.y * s));
        ctx.fillStyle = COLORS.land;
        ctx.fill(land, "evenodd");
        ctx.lineWidth = 0.8 / s;
        ctx.strokeStyle = COLORS.border;
        ctx.stroke(land);
      });

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const toScreen = (x, y) => {
        let dx = x - cam.x;
        dx -= Math.round(dx);                             // nearest copy
        return [W / 2 + dx * s, H / 2 + (y - cam.y) * s];
      };

      // Country names, biggest first, skipping any that would overlap one already placed.
      ctx.font = FONT;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.lineJoin = "round"; ctx.lineWidth = 3;
      const placed = [[0, 0, 78, 20]];                    // the "Location" tag in the corner
      for (const l of labels) {
        if (l.size * s < MIN_LABEL_PX) break;
        const [px, py] = toScreen(l.x, l.y);
        if (px < -40 || px > W + 40 || py < 8 || py > H - 6) continue;
        const w = ctx.measureText(l.name).width + 6, h = 13;
        const box = [px - w / 2, py - h / 2, px + w / 2, py + h / 2];
        if (box[0] < 2 || box[2] > W - 2) continue;
        if (placed.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue;
        placed.push(box);
        ctx.strokeStyle = COLORS.halo; ctx.strokeText(l.name, px, py);
        ctx.fillStyle = COLORS.text; ctx.fillText(l.name, px, py);
        if (placed.length > 15) break;
      }

      // Pins: accent dot, white ring, ink outline (as on the main map).
      pins.forEach(([lng, lat]) => {
        const [px, py] = toScreen(ux(lng), uy(lat));
        ctx.beginPath(); ctx.arc(px, py, 6.5, 0, Math.PI * 2); ctx.fillStyle = "#12161c"; ctx.fill();
        ctx.beginPath(); ctx.arc(px, py, 5.5, 0, Math.PI * 2); ctx.fillStyle = "#fff"; ctx.fill();
        ctx.beginPath(); ctx.arc(px, py, 3.6, 0, Math.PI * 2); ctx.fillStyle = "#c4301c"; ctx.fill();
      });
    }

    function frame(now) {
      const t = Math.min(1, (now - anim.t0) / anim.ms);
      const k = ease(t);
      cam = {
        x: anim.from.x + (anim.to.x - anim.from.x) * k,
        y: anim.from.y + (anim.to.y - anim.from.y) * k,
        z: anim.from.z + (anim.to.z - anim.from.z) * k - anim.lift * Math.sin(Math.PI * k),
      };
      draw();
      if (t < 1) raf = requestAnimationFrame(frame);
      else { cam = { ...anim.to, x: ((anim.to.x % 1) + 1) % 1 }; anim = null; raf = 0; draw(); }
    }

    // Move to a view; long hops zoom out a little on the way, like the main map.
    function moveTo(lng, lat, z, points, instant) {
      pins = points;
      cancelAnimationFrame(raf);
      let x = ux(lng);
      const y = uy(lat);
      const dx = x - cam.x;
      x -= Math.round(dx);                                // shortest way round the globe
      const dist = Math.hypot(x - cam.x, y - cam.y) * 512 * 2 ** Math.min(cam.z, z);
      const lift = Math.min(1.2, Math.max(0, Math.log2(dist / Math.max(W, 1))));
      if (instant || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        anim = null; cam = { x: ((x % 1) + 1) % 1, y, z }; draw(); return;
      }
      anim = { from: { ...cam }, to: { x, y, z }, lift, t0: performance.now(), ms: MOVE_MS };
      raf = requestAnimationFrame(frame);
    }

    addEventListener("resize", resize);
    resize();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(draw);   // names in Inter once it is in
    return { moveTo };
  };
})();
