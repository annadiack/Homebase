/* ==========================================================================
   VIDEO-HINTERGRUND — geloopt, stumm, hinter allem
   Hochkant-Video (1080x1920) für scharfe Darstellung auf dem iPhone.
   Eigenständig: kein Eingriff in andere Dateien nötig.
   ========================================================================== */
(function () {
  var v = document.createElement("video");
  v.id = "bgVideo";
  v.src = "bg.mp4?v=2";
  v.poster = "bg-poster.jpg?v=2";
  v.muted = true; v.defaultMuted = true; v.loop = true; v.autoplay = true;
  v.preload = "auto";
  v.setAttribute("muted", ""); v.setAttribute("loop", ""); v.setAttribute("autoplay", "");
  v.setAttribute("playsinline", ""); v.setAttribute("webkit-playsinline", "");

  var s = document.createElement("style");
  s.textContent =
    "#bgVideo{ position:fixed; inset:0; width:100%; height:100%; object-fit:cover; z-index:-1; pointer-events:none; }" +
    "html,body{ background:#140E0A !important; }" +
    ".bg{ background:transparent !important; }" +
    ".bg img{ display:none !important; }";

  function start() {
    (document.head || document.documentElement).appendChild(s);
    document.body.appendChild(v);
    var p = v.play(); if (p && p.catch) p.catch(function () {});
    var kick = function () {
      v.play().catch(function () {});
      document.removeEventListener("touchstart", kick);
      document.removeEventListener("click", kick);
    };
    document.addEventListener("touchstart", kick, { passive: true });
    document.addEventListener("click", kick);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
