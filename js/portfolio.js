/* "Back to the map" returns to the chapter the reader left from (?from=<chapter id>). */
(() => {
  const back = document.getElementById("back");
  const from = new URLSearchParams(location.search).get("from");
  if (back && from && /^[a-z0-9-]+$/i.test(from)) back.href = "index.html#" + from;
})();
