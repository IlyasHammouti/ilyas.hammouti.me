/* Umami events. One delegated listener, so the markup carries no tracking attributes.
   Analytics must never break the page: every call is guarded. */
(() => {
  const CHAPTER_DWELL_MS = 1500;     // a chapter only counts once the reader stays on it

  const send = (name, data) => {
    try { if (window.umami) window.umami.track(name, data); } catch (_) { /* ignore */ }
  };
  window.trackEvent = send;

  /* which chapters get read: one event per chapter and per visit, not while scrubbing past */
  const seen = new Set();
  let dwell;
  window.trackChapter = (id) => {
    clearTimeout(dwell);
    if (seen.has(id)) return;
    dwell = setTimeout(() => { seen.add(id); send("chapter-view", { chapter: id }); }, CHAPTER_DWELL_MS);
  };

  const where = (el) => (el.closest("header") ? "header" : el.closest("footer") ? "footer" : el.closest("[id]")?.id || "page");

  /* capture phase: runs before the page handlers that rewrite links or replace the video button */
  document.addEventListener("click", (e) => {
    const video = e.target.closest(".video");
    if (video && !video.classList.contains("is-playing")) {
      send("video-play", { title: video.dataset.title || video.dataset.id });
      return;
    }
    if (e.target.closest("#copy")) { send("email-copy"); return; }

    const a = e.target.closest("a[href]");
    if (!a) return;
    const href = a.getAttribute("href");
    if (/Resume\.pdf$/i.test(href)) send("download-resume", { from: where(a) });
    else if (href.startsWith("contact.html")) send(href.includes("about=letter") ? "request-letter" : "contact-click", { from: where(a) });
    else if (href.startsWith("portfolio.html")) send("portfolio-click", { from: where(a) });
    else if (href.startsWith("mailto:")) send("email-click");
    else if (a.hostname && a.hostname !== location.hostname) send("outbound-click", { site: a.hostname + a.pathname });
  }, true);
})();
