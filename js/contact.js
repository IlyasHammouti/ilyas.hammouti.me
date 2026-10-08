/* Contact page: back link to the chapter the reader left from, copy-email button,
   and a short form that posts to a form-to-email service (falls back to a prefilled mail). */
(() => {
  const OWNER = "ilyas@hammouti.me";
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);

  /* back to the map, on the chapter the reader came from */
  const from = params.get("from");
  if (from && /^[a-z0-9-]+$/i.test(from)) $("back").href = "index.html#" + from;

  /* copy email */
  const copy = $("copy");
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(OWNER);
      copy.textContent = "Copied";
    } catch (_) {
      copy.textContent = "Select it";          // clipboard blocked: the address is selectable on screen
    }
    setTimeout(() => { copy.textContent = "Copy"; }, 1800);
  });

  /* prefill when a button on the map asks for something specific */
  const form = $("contact-form");
  const message = $("f-message");
  if (params.get("about") === "letter") {
    message.value = "Hello Ilyas, I'd like to receive the full letter of recommendation from Alex de Sá.";
  }

  /* submit */
  const status = $("status");
  const send = $("send");
  const say = (text, kind) => { status.textContent = text; status.dataset.kind = kind || ""; };

  const mailFallback = (data) => {
    const body = `${data.message || ""}\n\n${data.name ? data.name + "\n" : ""}${data.email}`;
    location.href = `mailto:${OWNER}?subject=${encodeURIComponent("Message from your portfolio")}&body=${encodeURIComponent(body)}`;
  };

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    if (data.botcheck) return;                                       // honeypot: bots tick it, people never see it
    if (!/^\S+@\S+\.\S+$/.test((data.email || "").trim())) {
      say("Please enter a valid email address.", "error");
      $("f-email").focus();
      return;
    }
    const { endpoint, key } = form.dataset;
    if (!endpoint || !key) { say("Opening your mail app…", "ok"); mailFallback(data); return; }

    send.disabled = true;
    say("Sending…");
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          access_key: key, subject: "Message from your portfolio", from_name: data.name || "Portfolio visitor",
          name: data.name || "", email: data.email.trim(), message: data.message || "",
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.success === false) throw new Error(json.message || res.statusText);
      window.trackEvent?.("contact-form-sent");
      form.reset();
      say("Thank you. I'll get back to you soon.", "ok");
    } catch (err) {
      console.warn("Contact form:", err);
      say(`Could not send. Please write to ${OWNER}.`, "error");
    } finally {
      send.disabled = false;
    }
  });
})();
