/* ==========================================================================
   KATEGORIEN (fix definiert — Artikel hängen per category-ID daran)
   ========================================================================== */
const CATEGORY_DEFS = [
  { id: "obst",     name: "Obst & Gemüse" },
  { id: "glas",     name: "Gläser & Konserven" },
  { id: "kraeuter", name: "Kräuter & Gewürze" },
  { id: "getreide", name: "Getreide" },
  { id: "milch",    name: "Milchprodukte" },
  { id: "tk",       name: "TK" },
];

const DEFAULT_WEEK = [
  { day_index: 0, day: "Montag",     meal: "Gelbes Kokos-Curry mit Süßkartoffel",      time: "35 Min", tag: "vegetarisch", recipe_id: null },
  { day_index: 1, day: "Dienstag",   meal: "Tomaten-Pasta mit Mozzarella & Basilikum", time: "20 Min", tag: "schnell",     recipe_id: null },
  { day_index: 2, day: "Mittwoch",   meal: "Gebratener Reis mit Frühlingsgemüse",      time: "25 Min", tag: "vegetarisch", recipe_id: null },
  { day_index: 3, day: "Donnerstag", meal: "Quinoa-Bowl mit Kichererbsen & Limette",   time: "20 Min", tag: "vegan",       recipe_id: null },
  { day_index: 4, day: "Freitag",    meal: "Restekochen — was der Vorrat hergibt",     time: "—",      tag: "frei",        recipe_id: null },
  { day_index: 5, day: "Samstag",    meal: "Pizza-Abend, selbst belegt",               time: "45 Min", tag: "zu zweit",    recipe_id: null },
  { day_index: 6, day: "Sonntag",    meal: "Brunch: Eier, Parmesan, frisches Brot",    time: "30 Min", tag: "gemütlich",   recipe_id: null },
];

const DEFAULT_SHOPPING = [
  { category: "obst", text: "1 Süßkartoffel" }, { category: "obst", text: "2 Brokkoli" },
  { category: "obst", text: "500 g Kirschtomaten" }, { category: "obst", text: "1 Limette" },
  { category: "glas", text: "800 ml Kokosmilch" }, { category: "glas", text: "250 g passierte Tomaten" },
  { category: "glas", text: "130 g Kichererbsen" },
  { category: "kraeuter", text: "1/2 Bund Petersilie" },
  { category: "getreide", text: "500 g Nudeln" }, { category: "getreide", text: "500 g Reis" },
  { category: "getreide", text: "100 g Quinoa" },
  { category: "milch", text: "1 Parmesan" }, { category: "milch", text: "350 ml Sahne" },
  { category: "milch", text: "125 g Mozzarella" },
  { category: "tk", text: "250 g Gemüsemischung" },
];

const DEFAULT_PANTRY = [
  "1 Zwiebel", "1 Knoblauchzehe", "2 Eier", "Basilikum, TK", "Olivenöl",
  "Kokosöl", "Sojasauce", "gelbe Currypaste", "Salz", "Pfeffer",
];

/* ==========================================================================
   DATENSCHICHT — Supabase (Echtzeit, geteilt) mit localStorage-Fallback
   ========================================================================== */
const cfg = window.APP_CONFIG || {};
let sb = null;
if (window.supabase && cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY) {
  try { sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY); }
  catch (e) { console.warn("Supabase-Init fehlgeschlagen, nutze Lokal-Modus:", e); }
}
const REMOTE = !!sb;
const STORAGE_KEY = "einkaufsliste_state_v3";

// In-Memory-State, aus dem gerendert wird
let state = { shopping: [], pantry: [], week: [], recipes: [] };
let currentImport = null;

/* ---------- Lokal-Modus ---------- */
function localLoad() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) { state = JSON.parse(raw); return; }
  } catch (e) { /* korrupten Speicher ignorieren */ }
  state = {
    shopping: DEFAULT_SHOPPING.map((s, i) => ({ id: "s" + i, ...s, checked: false })),
    pantry: DEFAULT_PANTRY.map((text, i) => ({ id: "p" + i, text, checked: false })),
    week: DEFAULT_WEEK.map(d => ({ ...d })),
    recipes: [],
  };
  localSave();
}
function localSave() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }

/* ---------- Supabase-Modus ---------- */
async function remoteFetchAll() {
  const [shop, pantry, week, recipes] = await Promise.all([
    sb.from("shopping_items").select("*").order("created_at"),
    sb.from("pantry_items").select("*").order("created_at"),
    sb.from("week_plan").select("*").order("day_index"),
    sb.from("recipes").select("*").order("created_at"),
  ]);
  const err = shop.error || pantry.error || week.error || recipes.error;
  if (err) throw err;
  state.shopping = shop.data;
  state.pantry = pantry.data;
  state.week = week.data.length ? week.data : DEFAULT_WEEK.map(d => ({ ...d }));
  state.recipes = recipes.data.map(r => ({ ...r, ingredients: r.ingredients || [] }));
}

let refreshTimer = null;
function scheduleRemoteRefresh() {
  // Debounce, damit mehrere Realtime-Events nicht x-fach neu laden
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    try { await remoteFetchAll(); renderAll(); } catch (e) { console.warn(e); }
  }, 150);
}

function remoteSubscribe() {
  sb.channel("app-realtime")
    .on("postgres_changes", { event: "*", schema: "public" }, scheduleRemoteRefresh)
    .subscribe();
}

/* ---------- Einheitliche Mutationen ---------- */
async function mutAddShopping(category, text) {
  if (REMOTE) { await sb.from("shopping_items").insert({ category, text }); await remoteFetchAll(); }
  else { state.shopping.push({ id: "s" + Date.now(), category, text, checked: false }); localSave(); }
  renderAll();
}
async function mutToggleShopping(id, checked) {
  if (REMOTE) { await sb.from("shopping_items").update({ checked }).eq("id", id); }
  else { const it = state.shopping.find(i => i.id === id); if (it) it.checked = checked; localSave(); }
}
async function mutAddPantry(text) {
  if (REMOTE) { await sb.from("pantry_items").insert({ text }); await remoteFetchAll(); }
  else { state.pantry.push({ id: "p" + Date.now(), text, checked: false }); localSave(); }
  renderAll();
}
async function mutTogglePantry(id, checked) {
  if (REMOTE) { await sb.from("pantry_items").update({ checked }).eq("id", id); }
  else { const it = state.pantry.find(i => i.id === id); if (it) it.checked = checked; localSave(); }
}
async function mutAssignDay(dayIndex, meal, recipeId) {
  if (REMOTE) { await sb.from("week_plan").update({ meal, recipe_id: recipeId }).eq("day_index", dayIndex); await remoteFetchAll(); }
  else { const d = state.week.find(w => w.day_index === dayIndex); if (d) { d.meal = meal; d.recipe_id = recipeId; } localSave(); }
  renderAll();
}
async function mutAddRecipe(recipe, ingredients, category, dayIndex) {
  if (REMOTE) {
    const { data, error } = await sb.from("recipes").insert(recipe).select().single();
    if (error) throw error;
    if (ingredients.length) {
      await sb.from("shopping_items").insert(ingredients.map(text => ({ category, text })));
    }
    if (dayIndex !== null) {
      await sb.from("week_plan").update({ meal: recipe.title, recipe_id: data.id }).eq("day_index", dayIndex);
    }
    await remoteFetchAll();
  } else {
    const id = "r" + Date.now();
    state.recipes.push({ id, ...recipe, ingredients });
    ingredients.forEach((text, i) => state.shopping.push({ id: "s" + Date.now() + "-" + i, category, text, checked: false }));
    if (dayIndex !== null) { const d = state.week.find(w => w.day_index === dayIndex); if (d) { d.meal = recipe.title; d.recipe_id = id; } }
    localSave();
  }
  renderAll();
}
async function mutDeleteRecipe(id) {
  if (REMOTE) {
    await sb.from("week_plan").update({ recipe_id: null }).eq("recipe_id", id);
    await sb.from("recipes").delete().eq("id", id);
    await remoteFetchAll();
  } else {
    state.recipes = state.recipes.filter(r => r.id !== id);
    state.week.forEach(d => { if (d.recipe_id === id) d.recipe_id = null; });
    localSave();
  }
  renderAll();
}
async function mutFinishWeek(leftoverItems) {
  if (REMOTE) {
    if (leftoverItems.length) {
      await sb.from("pantry_items").insert(leftoverItems.map(it => ({ text: it.text })));
    }
    await sb.from("shopping_items").delete().eq("checked", true);
    await remoteFetchAll();
  } else {
    leftoverItems.forEach(it => state.pantry.push({ id: "p" + Date.now() + it.id, text: it.text, checked: false }));
    state.shopping = state.shopping.filter(i => !i.checked);
    localSave();
  }
  renderAll();
}

/* ==========================================================================
   RENDERING
   ========================================================================== */
function checkIconSVG() {
  return `<svg viewBox="0 0 12 12" fill="none"><path d="M2 6.2 4.8 9 10 3" stroke="#FFFFFF" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
function esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }
function platformLabel(p) { return { youtube: "YouTube", tiktok: "TikTok", instagram: "Instagram", sonstige: "Link" }[p] || "Link"; }

function renderWeek() {
  const rail = document.getElementById("dayRail");
  rail.innerHTML = state.week.map(d => {
    const recipe = d.recipe_id ? state.recipes.find(r => r.id === d.recipe_id) : null;
    return `
      <article class="day-card">
        <p class="day-card__day">${esc(d.day)}</p>
        <p class="day-card__meal">${esc(d.meal)}</p>
        <p class="day-card__meta">${esc(d.time)} · ${esc(d.tag)}</p>
        ${recipe ? `<a href="${esc(recipe.url)}" target="_blank" rel="noopener" class="day-card__link">Rezept ansehen ↗</a>` : ""}
      </article>`;
  }).join("");
}

function renderList() {
  const grid = document.getElementById("listGrid");
  grid.innerHTML = CATEGORY_DEFS.map(cat => {
    const items = state.shopping.filter(i => i.category === cat.id);
    return `
    <div class="category-card reveal is-visible" data-cat="${cat.id}">
      <span class="category-card__tag">${cat.name}</span>
      <ul>
        ${items.map(it => `
          <li class="item ${it.checked ? "is-checked" : ""}" data-id="${it.id}">
            <span class="check">${checkIconSVG()}</span>
            <span class="item__text">${esc(it.text)}</span>
          </li>`).join("")}
      </ul>
      <div class="add-row">
        <input type="text" placeholder="Hinzufügen…" aria-label="Neuen Artikel zu ${cat.name} hinzufügen" data-add="${cat.id}">
        <button type="button" data-add-btn="${cat.id}" aria-label="Hinzufügen">+</button>
      </div>
    </div>`;
  }).join("");

  grid.querySelectorAll(".item").forEach(li => {
    li.addEventListener("click", () => {
      const it = state.shopping.find(i => String(i.id) === li.dataset.id);
      if (!it) return;
      it.checked = !it.checked;
      li.classList.toggle("is-checked", it.checked);
      mutToggleShopping(it.id, it.checked);
    });
  });

  grid.querySelectorAll("[data-add-btn]").forEach(btn => {
    const catId = btn.dataset.addBtn;
    const input = grid.querySelector(`[data-add="${catId}"]`);
    const commit = () => {
      const val = input.value.trim();
      if (!val) return;
      input.value = "";
      mutAddShopping(catId, val);
    };
    btn.addEventListener("click", commit);
    input.addEventListener("keydown", e => { if (e.key === "Enter") commit(); });
  });
}

function renderPantry() {
  const grid = document.getElementById("pantryGrid");
  grid.innerHTML = state.pantry.map(it => `
    <div class="item ${it.checked ? "is-checked" : ""}" data-id="${it.id}">
      <span class="check">${checkIconSVG()}</span>
      <span class="item__text">${esc(it.text)}</span>
    </div>`).join("");

  grid.querySelectorAll(".item").forEach(el => {
    el.addEventListener("click", () => {
      const it = state.pantry.find(i => String(i.id) === el.dataset.id);
      if (!it) return;
      it.checked = !it.checked;
      el.classList.toggle("is-checked", it.checked);
      mutTogglePantry(it.id, it.checked);
    });
  });
}

function renderRecipeGallery() {
  const wrap = document.getElementById("recipeGallery");
  if (!state.recipes.length) { wrap.innerHTML = ""; wrap.hidden = true; return; }
  wrap.hidden = false;
  wrap.innerHTML = state.recipes.map(r => `
    <div class="recipe-card" data-id="${r.id}">
      ${r.thumbnail
        ? `<img src="${esc(r.thumbnail)}" alt="" class="recipe-card__thumb">`
        : `<div class="recipe-card__thumb recipe-card__thumb--placeholder">${platformLabel(r.platform)}</div>`}
      <div class="recipe-card__body">
        <span class="platform-tag">${platformLabel(r.platform)}</span>
        <p class="recipe-card__title">${esc(r.title)}</p>
        <select data-assign="${r.id}" aria-label="Tag zuweisen für ${esc(r.title)}">
          <option value="">Tag zuweisen…</option>
          ${state.week.map(d => `<option value="${d.day_index}">${esc(d.day)}</option>`).join("")}
        </select>
        <button type="button" class="recipe-card__remove" data-delete-recipe="${r.id}">Entfernen</button>
      </div>
    </div>`).join("");

  wrap.querySelectorAll("[data-assign]").forEach(sel => {
    sel.addEventListener("change", () => {
      if (sel.value === "") return;
      const recipe = state.recipes.find(r => String(r.id) === sel.dataset.assign);
      mutAssignDay(+sel.value, recipe.title, recipe.id);
    });
  });
  wrap.querySelectorAll("[data-delete-recipe]").forEach(btn => {
    btn.addEventListener("click", () => mutDeleteRecipe(btn.dataset.deleteRecipe));
  });
}

function renderAll() {
  renderWeek();
  renderList();
  renderPantry();
  renderRecipeGallery();
  if (window.__recalcScroll) window.__recalcScroll();
}

function renderSyncBadge(ok) {
  const badge = document.getElementById("syncBadge");
  const meta = document.getElementById("footerMeta");
  if (REMOTE && ok) {
    badge.textContent = "● Live-Sync aktiv";
    badge.classList.add("is-live");
    meta.textContent = "Echtzeit-Sync über Supabase — Änderungen erscheinen sofort auf beiden Geräten";
  } else if (REMOTE && !ok) {
    badge.textContent = "○ Sync-Fehler — lokal";
    meta.textContent = "Verbindung zu Supabase fehlgeschlagen — prüfe config.js";
  } else {
    badge.textContent = "○ Lokal (nur dieses Gerät)";
    meta.textContent = "Lokal-Modus: für gemeinsame Nutzung Supabase in config.js eintragen (siehe README)";
  }
}

/* ==========================================================================
   MODALS
   ========================================================================== */
const importModal = document.getElementById("importModal");
const reviewModal = document.getElementById("reviewModal");

function openModal(el) { el.hidden = false; document.documentElement.style.overflow = "hidden"; }
function closeModal(el) { el.hidden = true; document.documentElement.style.overflow = ""; }

function detectPlatform(url) {
  if (/tiktok\.com/i.test(url)) return "tiktok";
  if (/youtube\.com|youtu\.be/i.test(url)) return "youtube";
  if (/instagram\.com/i.test(url)) return "instagram";
  return "sonstige";
}

// Öffentliche oEmbed-Endpunkte (kein API-Key). YouTube: zuverlässig.
// TikTok: meistens. Instagram: seit 2020 nur mit eigenem Meta-App-Token
// → wird bewusst übersprungen, Titel/Zutaten von Hand.
async function fetchOEmbed(url, platform) {
  let endpoint;
  if (platform === "youtube") endpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
  else if (platform === "tiktok") endpoint = `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`;
  else throw new Error("unsupported-platform");
  const res = await fetch(endpoint);
  if (!res.ok) throw new Error("request-failed");
  return res.json();
}

function populateImportSelects() {
  document.getElementById("importCategory").innerHTML =
    CATEGORY_DEFS.map(c => `<option value="${c.id}">${c.name}</option>`).join("");
  document.getElementById("importDay").innerHTML =
    `<option value="">— keinem Tag —</option>` +
    state.week.map(d => `<option value="${d.day_index}">${esc(d.day)}</option>`).join("");
}

function resetImportForm() {
  currentImport = null;
  ["importUrl", "importIngredients", "previewTitle"].forEach(id => document.getElementById(id).value = "");
  document.getElementById("platformNote").textContent = "";
  document.getElementById("importPreview").hidden = true;
}

document.getElementById("openImportModal").addEventListener("click", () => {
  populateImportSelects(); resetImportForm(); openModal(importModal);
});
document.getElementById("closeImportModal").addEventListener("click", () => closeModal(importModal));
importModal.addEventListener("click", e => { if (e.target === importModal) closeModal(importModal); });

document.getElementById("loadPreview").addEventListener("click", async () => {
  const url = document.getElementById("importUrl").value.trim();
  const note = document.getElementById("platformNote");
  const preview = document.getElementById("importPreview");
  if (!url) { note.textContent = "Bitte zuerst einen Link einfügen."; return; }
  const platform = detectPlatform(url);

  if (platform === "instagram") {
    note.textContent = "Instagram erlaubt keine automatische Vorschau ohne eigenen API-Zugang — Titel bitte manuell eintragen.";
    preview.hidden = true; currentImport = { platform, url, thumbnail: "" }; return;
  }
  if (platform === "sonstige") {
    note.textContent = "Unbekannte Plattform — Titel bitte manuell eintragen.";
    preview.hidden = true; currentImport = { platform, url, thumbnail: "" }; return;
  }
  note.textContent = "Lade Vorschau…";
  try {
    const data = await fetchOEmbed(url, platform);
    document.getElementById("previewThumb").src = data.thumbnail_url || "";
    document.getElementById("previewTitle").value = data.title || "";
    document.getElementById("previewPlatform").textContent = platformLabel(platform);
    preview.hidden = false;
    note.textContent = "Vorschau geladen — Titel kannst du anpassen.";
    currentImport = { platform, url, thumbnail: data.thumbnail_url || "" };
  } catch (err) {
    note.textContent = "Vorschau konnte nicht geladen werden — Titel bitte manuell eintragen, der Rest funktioniert trotzdem.";
    preview.hidden = true; currentImport = { platform, url, thumbnail: "" };
  }
});

document.getElementById("saveImport").addEventListener("click", async () => {
  const url = document.getElementById("importUrl").value.trim();
  const title = document.getElementById("previewTitle").value.trim() || "Importiertes Rezept";
  const ingredients = document.getElementById("importIngredients").value.split("\n").map(s => s.trim()).filter(Boolean);
  const category = document.getElementById("importCategory").value;
  const dayVal = document.getElementById("importDay").value;
  if (!url) { document.getElementById("platformNote").textContent = "Ohne Link kein Rezept — bitte Link einfügen."; return; }

  const platform = (currentImport && currentImport.platform) || detectPlatform(url);
  const thumbnail = (currentImport && currentImport.thumbnail) || "";
  try {
    await mutAddRecipe({ title, url, platform, thumbnail }, ingredients, category, dayVal === "" ? null : +dayVal);
    closeModal(importModal);
  } catch (e) {
    document.getElementById("platformNote").textContent = "Speichern fehlgeschlagen — Verbindung prüfen.";
    console.warn(e);
  }
});

/* ---------- Woche abschließen ---------- */
document.getElementById("openReview").addEventListener("click", () => {
  const checkedItems = state.shopping
    .filter(i => i.checked)
    .map(i => ({ ...i, catName: (CATEGORY_DEFS.find(c => c.id === i.category) || {}).name || "" }));

  const list = document.getElementById("reviewList");
  const confirmBtn = document.getElementById("confirmReview");

  if (!checkedItems.length) {
    list.innerHTML = `<p class="modal-hint">Noch nichts abgehakt — erst einkaufen, dann abschließen. 🛒</p>`;
    confirmBtn.hidden = true;
  } else {
    confirmBtn.hidden = false;
    list.innerHTML = checkedItems.map(it => `
      <label class="review-item">
        <span class="review-item__text">${esc(it.text)}<small>${esc(it.catName)}</small></span>
        <span class="switch">
          <input type="checkbox" data-review="${it.id}">
          <span class="switch__track"></span>
        </span>
        <span class="review-item__caption">Rest übrig</span>
      </label>`).join("");
  }
  openModal(reviewModal);
});
document.getElementById("closeReviewModal").addEventListener("click", () => closeModal(reviewModal));
reviewModal.addEventListener("click", e => { if (e.target === reviewModal) closeModal(reviewModal); });

document.getElementById("confirmReview").addEventListener("click", async () => {
  const leftovers = [];
  document.querySelectorAll("#reviewList [data-review]").forEach(t => {
    if (t.checked) {
      const it = state.shopping.find(i => String(i.id) === t.dataset.review);
      if (it) leftovers.push(it);
    }
  });
  await mutFinishWeek(leftovers);
  closeModal(reviewModal);
});

/* ---------- Vorrat: hinzufügen ---------- */
(function initPantryAdd() {
  const input = document.getElementById("pantryInput");
  const commit = () => {
    const val = input.value.trim();
    if (!val) return;
    input.value = "";
    mutAddPantry(val);
  };
  document.getElementById("pantryAddBtn").addEventListener("click", commit);
  input.addEventListener("keydown", e => { if (e.key === "Enter") commit(); });
})();

/* ==========================================================================
   SMOOTH SCROLL (Lenis-Feeling) + PARALLAX
   Desktop: gelerpter Transform-Scroll für das butterweiche Gefühl,
   Touch/Reduced-Motion: nativer Scroll, Parallax läuft trotzdem.
   ========================================================================== */
const wrapper = document.getElementById("smoothWrapper");
const isTouch = matchMedia("(pointer: coarse)").matches;
const prefersReduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const SMOOTH = !isTouch && !prefersReduced;

let currentY = 0;

function setBodyHeight() {
  if (!SMOOTH) return;
  document.body.style.height = wrapper.scrollHeight + "px";
}
window.__recalcScroll = setBodyHeight;

function updateParallax() {
  document.querySelectorAll(".bg").forEach(bg => {
    const rect = bg.parentElement.getBoundingClientRect();
    const speed = parseFloat(bg.dataset.speed || 0.14);
    const offset = (rect.top + rect.height / 2 - innerHeight / 2) * speed;
    bg.style.transform = `translate3d(0, ${offset.toFixed(2)}px, 0)`;
  });
}

function updateScrollBarUI() {
  const max = (SMOOTH ? wrapper.scrollHeight : document.documentElement.scrollHeight) - innerHeight;
  const y = SMOOTH ? currentY : window.scrollY;
  document.getElementById("scrollBar").style.width = (max > 0 ? (y / max) * 100 : 0) + "%";
}

function rafLoop() {
  if (SMOOTH) {
    const target = window.scrollY;
    currentY += (target - currentY) * 0.082;
    if (Math.abs(target - currentY) < 0.05) currentY = target;
    wrapper.style.transform = `translate3d(0, ${-currentY.toFixed(2)}px, 0)`;
  }
  updateParallax();
  updateScrollBarUI();
  requestAnimationFrame(rafLoop);
}

function initSmoothScroll() {
  if (SMOOTH) {
    wrapper.style.position = "fixed";
    wrapper.style.top = "0";
    wrapper.style.left = "0";
    wrapper.style.width = "100%";
    wrapper.style.willChange = "transform";
    setBodyHeight();
    window.addEventListener("resize", setBodyHeight);
    // Bilder laden asynchron → Höhe nachziehen
    window.addEventListener("load", setBodyHeight);
  }
  requestAnimationFrame(rafLoop);

  // Anker-Links: Position im Wrapper berechnen, nativer Scroll-Sprung
  // wird vom Lerp weich abgefangen
  document.querySelectorAll('a[href^="#"]').forEach(a => {
    a.addEventListener("click", e => {
      const target = document.querySelector(a.getAttribute("href"));
      if (!target) return;
      e.preventDefault();
      const top = SMOOTH
        ? target.offsetTop
        : target.getBoundingClientRect().top + window.scrollY;
      window.scrollTo({ top, behavior: SMOOTH ? "auto" : "smooth" });
    });
  });
}

/* ==========================================================================
   SCROLL REVEAL
   ========================================================================== */
function observeReveals() {
  const obs = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) { entry.target.classList.add("is-visible"); obs.unobserve(entry.target); }
    });
  }, { threshold: 0.12 });
  document.querySelectorAll(".reveal:not(.is-visible)").forEach(el => obs.observe(el));
}

/* ==========================================================================
   INIT
   ========================================================================== */
async function init() {
  if (REMOTE) {
    try {
      await remoteFetchAll();
      remoteSubscribe();
      renderSyncBadge(true);
    } catch (e) {
      console.warn("Supabase nicht erreichbar, wechsle in Lokal-Modus:", e);
      localLoad();
      renderSyncBadge(false);
    }
  } else {
    localLoad();
    renderSyncBadge(false);
  }
  renderAll();
  observeReveals();
  initSmoothScroll();
}

document.addEventListener("DOMContentLoaded", init);
