/* Night-sky backdrop behind the globe: stars that fade in and out, and an
   occasional shooting star. Static when the reader prefers reduced motion. */
(() => {
  const canvas = document.getElementById("stars");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const TINTS = ["255,255,255", "255,255,255", "205,222,255", "255,236,212"];
  const rand = (a, b) => a + Math.random() * (b - a);

  let w = 0, h = 0, stars = [], shooters = [], nextShot = 0, last = 0;

  const spawn = (scatter) => {
    const life = rand(3, 9);
    return {
      x: rand(0, w), y: rand(0, h), r: rand(0.35, 1.5), life,
      t: scatter ? rand(0, life) : 0,
      peak: rand(0.45, 1),
      tint: TINTS[Math.floor(Math.random() * TINTS.length)],
    };
  };

  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    w = innerWidth; h = innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    stars = Array.from({ length: Math.round((w * h) / 6500) }, () => spawn(true));
    if (REDUCED) draw(0);
  }

  function shoot(now) {
    const fromLeft = Math.random() < 0.5;
    const speed = rand(520, 820);
    const angle = rand(0.35, 0.7);                       // radians below horizontal
    shooters.push({
      x: rand(w * 0.1, w * 0.9), y: rand(0, h * 0.4),
      vx: (fromLeft ? 1 : -1) * Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      t: 0, life: rand(0.7, 1.1),
    });
    nextShot = now + rand(5000, 12000);
  }

  function draw(dt) {
    ctx.clearRect(0, 0, w, h);
    for (const s of stars) {
      s.t += dt;
      if (s.t >= s.life) Object.assign(s, spawn(false));
      const phase = Math.sin(Math.PI * (s.t / s.life));       // 0 -> 1 -> 0: appears, then disappears
      ctx.fillStyle = `rgba(${s.tint},${(phase * phase * s.peak).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
    shooters = shooters.filter((s) => s.t < s.life);
    for (const s of shooters) {
      s.t += dt;
      s.x += s.vx * dt; s.y += s.vy * dt;
      const a = Math.sin(Math.PI * (s.t / s.life));
      const tail = 110, len = Math.hypot(s.vx, s.vy);
      const g = ctx.createLinearGradient(s.x, s.y, s.x - (s.vx / len) * tail, s.y - (s.vy / len) * tail);
      g.addColorStop(0, `rgba(255,255,255,${a})`);
      g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.strokeStyle = g; ctx.lineWidth = 1.4; ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(s.x - (s.vx / len) * tail, s.y - (s.vy / len) * tail);
      ctx.stroke();
    }
  }

  // The sky only animates while it can be seen and the map is still: during a flight, or when the map
  // covers the whole window, it holds still so every frame goes to the map (js/app.js calls starfield.run).
  let running = false, raf = 0;
  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    if (now >= nextShot) shoot(now);
    draw(dt);
    raf = requestAnimationFrame(frame);
  }
  window.starfield = {
    run(on) {
      if (REDUCED || on === running) return;
      running = on;
      cancelAnimationFrame(raf);
      if (on) raf = requestAnimationFrame((t) => { last = t; nextShot = Math.max(nextShot, t + 1500); frame(t); });
    },
  };

  addEventListener("resize", resize);
  resize();
  if (!REDUCED) {
    nextShot = performance.now() + rand(2500, 6000);
    window.starfield.run(true);
  }
})();
