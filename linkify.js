/* ==========================================================================
   AUTO-LINKS — macht jede URL in Freitexten anklickbar
   Eigenständig: kein Eingriff in script.js nötig.
   ========================================================================== */
(function () {
  // http(s)://… oder www.… bis zum nächsten Leerzeichen; abschließende Satzzeichen werden nicht mitgenommen
  var URL_RE = /((?:https?:\/\/|www\.)[^\s<]+[^\s<.,;:!?)\]}"'])/gi;

  // Styling der erzeugten Links (passt zum Gold-Design)
  var style = document.createElement("style");
  style.textContent =
    "a.auto-link{ color:#F6D9AC; text-decoration:underline; text-underline-offset:2px; " +
    "text-decoration-color:rgba(246,217,172,.5); word-break:break-word; }" +
    "a.auto-link:hover{ color:#FFF; text-decoration-color:#F6D9AC; }";
  (document.head || document.documentElement).appendChild(style);

  function skip(node) {
    var p = node.parentNode;
    if (!p || p.nodeType !== 1) return true;
    var tag = p.nodeName;
    if (tag === "A" || tag === "SCRIPT" || tag === "STYLE" || tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT" || tag === "BUTTON") return true;
    if (p.closest && p.closest('a, input, textarea, select, button, [contenteditable="true"], .leaflet-container, .home-map, #standortMap, #homeMiniMap')) return true;
    return false;
  }

  function process(root) {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        if (skip(node)) return NodeFilter.FILTER_REJECT;
        if (node.nodeValue.indexOf("http") === -1 && node.nodeValue.indexOf("www.") === -1) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var nodes = [], n;
    while ((n = walker.nextNode())) nodes.push(n);
    nodes.forEach(function (node) {
      var text = node.nodeValue;
      URL_RE.lastIndex = 0;
      if (!URL_RE.test(text)) return;
      URL_RE.lastIndex = 0;
      var frag = document.createDocumentFragment();
      var last = 0, m;
      while ((m = URL_RE.exec(text))) {
        if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        var raw = m[0];
        var a = document.createElement("a");
        a.href = /^https?:\/\//i.test(raw) ? raw : "https://" + raw;
        a.textContent = raw;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.className = "auto-link";
        frag.appendChild(a);
        last = m.index + raw.length;
      }
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      node.parentNode.replaceChild(frag, node);
    });
  }

  var timer = null, obs = null;
  function run() {
    if (obs) obs.disconnect();
    try { process(document.body); } catch (e) {}
    if (obs) obs.observe(document.body, { childList: true, subtree: true });
  }
  function schedule() { clearTimeout(timer); timer = setTimeout(run, 300); }

  // Klick auf einen Auto-Link soll nicht zugleich die Karte/Notiz öffnen
  document.addEventListener("click", function (e) {
    var a = e.target.closest ? e.target.closest("a.auto-link") : null;
    if (a) e.stopPropagation();
  }, true);

  function start() {
    run();
    obs = new MutationObserver(schedule);
    obs.observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
