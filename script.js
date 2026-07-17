/* ==========================================================================
   HOMEBASE — Dashboard, Kategorien, Backlog, Kalorien, Kalender (Tag/Woche/Monat)
   ========================================================================== */

/* ---------- Kategorien-Fallback (Lokal-Modus / falls DB leer) ---------- */
const CATEGORY_DEFS = [
  { id: "obst",      name: "Obst & Gemüse",       sort_order: 1 },
  { id: "glas",      name: "Gläser & Konserven",  sort_order: 2 },
  { id: "kraeuter",  name: "Kräuter & Gewürze",   sort_order: 3 },
  { id: "getreide",  name: "Getreide",            sort_order: 4 },
  { id: "milch",     name: "Milchprodukte",       sort_order: 5 },
  { id: "tk",        name: "TK",                  sort_order: 6 },
  { id: "getraenke", name: "Getränke",            sort_order: 7 },
];

/* ---------- Datums-Helfer ---------- */
function todayISO() { return new Date().toISOString().slice(0, 10); }
function addDaysISO(iso, n) {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
function shiftMonthISO(iso, n) {
  const d = new Date(iso + "T00:00:00");
  d.setMonth(d.getMonth() + n);
  return d.toISOString().slice(0, 10);
}
function firstOfMonthISO(iso) {
  const d = new Date(iso + "T00:00:00");
  d.setDate(1);
  return d.toISOString().slice(0, 10);
}
function mondayOfISO(iso) {
  const d = new Date(iso + "T00:00:00");
  const off = (d.getDay() + 6) % 7; // Mo=0 … So=6
  d.setDate(d.getDate() - off);
  return d.toISOString().slice(0, 10);
}
function formatDayLabel(iso) {
  const d = new Date(iso + "T00:00:00");
  const wd = d.toLocaleDateString("de-DE", { weekday: "long" });
  const dm = d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });
  return `${wd}, ${dm}`;
}

/* ==========================================================================
   DATENSCHICHT — Supabase (Echtzeit) mit localStorage-Fallback
   ========================================================================== */
const cfg = window.APP_CONFIG || {};
let sb = null;
if (window.supabase && cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY) {
  try { sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY); }
  catch (e) { console.warn("Supabase-Init fehlgeschlagen, nutze Lokal-Modus:", e); }
}
const REMOTE = !!sb;
const FUNCTIONS_BASE = cfg.SUPABASE_URL ? `${cfg.SUPABASE_URL}/functions/v1` : "";
const STORAGE_KEY = "homebase_state_v6";

let state = { shopping: [], backlog: [], calendarMap: {}, recipes: [], categories: [] };
let currentImport = null;
let currentReceiptItems = null;

/* Kalender-UI-Zustand */
let calView = "week";     // "day" | "week" | "month"
let calAnchor = todayISO();

/* ---------- Lokal-Modus ---------- */
function localLoad() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      state = JSON.parse(raw);
      if (!state.categories || !state.categories.length) state.categories = CATEGORY_DEFS.map(c => ({ ...c }));
      if (!state.calendarMap) state.calendarMap = {};
      return;
    }
  } catch (e) { /* korrupten Speicher ignorieren */ }
  state = { shopping: [], backlog: [], calendarMap: {}, recipes: [], categories: CATEGORY_DEFS.map(c => ({ ...c })) };
  localSave();
}
function localSave() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }

/* ---------- Supabase-Modus ---------- */
async function remoteFetchAll() {
  const [shop, backlog, calendar, recipes, categories] = await Promise.all([
    sb.from("shopping_items").select("*").order("created_at"),
    sb.from("backlog_items").select("*").order("created_at"),
    sb.from("calendar_entries").select("*").order("plan_date"),
    sb.from("recipes").select("*").order("created_at"),
    sb.from("categories").select("*").order("sort_order"),
  ]);
  const err = shop.error || backlog.error || calendar.error || recipes.error || categories.error;
  if (err) throw err;

  state.shopping = shop.data;
  state.backlog = backlog.data;
  state.recipes = (recipes.data || []).map(r => ({ ...r, ingredients: r.ingredients || [] }));
  state.categories = categories.data && categories.data.length ? categories.data : CATEGORY_DEFS.map(c => ({ ...c }));

  state.calendarMap = {};
  (calendar.data || []).forEach(c => { state.calendarMap[c.plan_date] = c; });
}

let refreshTimer = null;
function scheduleRemoteRefresh() {
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

function entryFor(iso) {
  return state.calendarMap[iso] || { plan_date: iso, meal: "", time: "", tag: "", recipe_id: null };
}

/* ---------- Mutationen: Einkaufsliste ---------- */
async function mutAddShopping(category, text, calories) {
  if (REMOTE) { await sb.from("shopping_items").insert({ category, text, calories: calories ?? null }); await remoteFetchAll(); }
  else { state.shopping.push({ id: "s" + Date.now(), category, text, calories: calories ?? null, checked: false }); localSave(); }
  renderAll();
}
async function mutToggleShopping(id, checked) {
  if (REMOTE) { await sb.from("shopping_items").update({ checked }).eq("id", id); }
  else { const it = state.shopping.find(i => i.id === id); if (it) it.checked = checked; localSave(); }
}
async function mutDeleteShopping(id) {
  if (REMOTE) { await sb.from("shopping_items").delete().eq("id", id); await remoteFetchAll(); }
  else { state.shopping = state.shopping.filter(i => i.id !== id); localSave(); }
  renderAll();
}

/* ---------- Mutationen: Backlog ---------- */
async function mutAddBacklog(text, calories, quantity, source) {
  if (REMOTE) { await sb.from("backlog_items").insert({ text, calories: calories ?? null, quantity: quantity || "", source: source || "manual" }); await remoteFetchAll(); }
  else { state.backlog.push({ id: "b" + Date.now(), text, calories: calories ?? null, quantity: quantity || "", source: source || "manual", checked: false }); localSave(); }
  renderAll();
}
async function mutToggleBacklog(id, checked) {
  if (REMOTE) { await sb.from("backlog_items").update({ checked }).eq("id", id); }
  else { const it = state.backlog.find(i => i.id === id); if (it) it.checked = checked; localSave(); }
}
async function mutDeleteBacklog(id) {
  if (REMOTE) { await sb.from("backlog_items").delete().eq("id", id); await remoteFetchAll(); }
  else { state.backlog = state.backlog.filter(i => i.id !== id); localSave(); }
  renderAll();
}

/* ---------- Mutationen: Kategorien (anlegen, umbenennen, sortieren, löschen) ---------- */
async function mutAddCategory(name) {
  const id = "cat_" + Date.now().toString(36);
  const nextOrder = (state.categories.reduce((m, c) => Math.max(m, c.sort_order || 0), 0)) + 1;
  if (REMOTE) { await sb.from("categories").insert({ id, name, sort_order: nextOrder }); await remoteFetchAll(); }
  else { state.categories.push({ id, name, sort_order: nextOrder }); localSave(); }
  renderAll();
}
async function mutRenameCategory(id, name) {
  if (REMOTE) { await sb.from("categories").update({ name }).eq("id", id); await remoteFetchAll(); }
  else { const c = state.categories.find(c => c.id === id); if (c) c.name = name; localSave(); }
  renderAll();
}
async function mutReorderCategories(orderedIds) {
  state.categories = orderedIds.map((id, i) => {
    const c = state.categories.find(c => c.id === id);
    return { ...c, sort_order: i + 1 };
  });
  if (REMOTE) {
    await Promise.all(state.categories.map(c => sb.from("categories").update({ sort_order: c.sort_order }).eq("id", c.id)));
    await remoteFetchAll();
  } else { localSave(); }
  renderAll();
}
async function mutDeleteCategory(id) {
  if (REMOTE) {
    await sb.from("shopping_items").delete().eq("category", id);
    await sb.from("categories").delete().eq("id", id);
    await remoteFetchAll();
  } else {
    state.shopping = state.shopping.filter(i => i.category !== id);
    state.categories = state.categories.filter(c => c.id !== id);
    localSave();
  }
  renderAll();
}

/* ---------- Mutationen: Kalender ---------- */
async function mutAssignDay(planDate, meal, recipeId, time, tag) {
  if (REMOTE) {
    await sb.from("calendar_entries").upsert({ plan_date: planDate, meal, recipe_id: recipeId, time: time || "", tag: tag || "" });
    await remoteFetchAll();
  } else {
    state.calendarMap[planDate] = { plan_date: planDate, meal, recipe_id: recipeId, time: time || "", tag: tag || "" };
    localSave();
  }
  renderAll();
}

/* ---------- Mutationen: Rezepte ---------- */
async function mutAddRecipe(recipe, ingredients, category, planDate) {
  if (REMOTE) {
    const { data, error } = await sb.from("recipes").insert(recipe).select().single();
    if (error) throw error;
    if (ingredients.length) {
      await sb.from("shopping_items").insert(ingredients.map(ing => ({ category, text: ing.text, calories: ing.calories ?? null })));
    }
    if (planDate) {
      await sb.from("calendar_entries").upsert({ plan_date: planDate, meal: recipe.title, recipe_id: data.id });
    }
    await remoteFetchAll();
  } else {
    const id = "r" + Date.now();
    state.recipes.push({ id, ...recipe, ingredients });
    ingredients.forEach((ing, i) => state.shopping.push({ id: "s" + Date.now() + "-" + i, category, text: ing.text, calories: ing.calories ?? null, checked: false }));
    if (planDate) state.calendarMap[planDate] = { plan_date: planDate, meal: recipe.title, recipe_id: id, time: "", tag: "" };
    localSave();
  }
  renderAll();
}
async function mutDeleteRecipe(id) {
  if (REMOTE) {
    await sb.from("calendar_entries").update({ recipe_id: null }).eq("recipe_id", id);
    await sb.from("recipes").delete().eq("id", id);
    await remoteFetchAll();
  } else {
    state.recipes = state.recipes.filter(r => r.id !== id);
    Object.values(state.calendarMap).forEach(e => { if (e.recipe_id === id) e.recipe_id = null; });
    localSave();
  }
  renderAll();
}

/* ---------- Mutationen: Woche abschließen ---------- */
async function mutFinishWeek(leftoverItems) {
  if (REMOTE) {
    if (leftoverItems.length) {
      await sb.from("backlog_items").insert(leftoverItems.map(it => ({ text: it.text, calories: it.calories ?? null, quantity: "", source: "week" })));
    }
    await sb.from("shopping_items").delete().eq("checked", true);
    await remoteFetchAll();
  } else {
    leftoverItems.forEach(it => state.backlog.push({ id: "b" + Date.now() + it.id, text: it.text, calories: it.calories ?? null, quantity: "", source: "week", checked: false }));
    state.shopping = state.shopping.filter(i => !i.checked);
    localSave();
  }
  renderAll();
}

/* ==========================================================================
   KI-FUNKTIONEN (Kassenzettel-Scan + Kalorienschätzung, via Claude)
   ========================================================================== */
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result.split(",")[1]) || "");
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
async function callScanReceipt(base64, mimeType) {
  const res = await fetch(`${FUNCTIONS_BASE}/scan-receipt`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "apikey": cfg.SUPABASE_ANON_KEY, "Authorization": `Bearer ${cfg.SUPABASE_ANON_KEY}` },
    body: JSON.stringify({ image: base64, mimeType }),
  });
  if (!res.ok) throw new Error("scan-receipt fehlgeschlagen (" + res.status + ")");
  return res.json();
}
async function callEstimateCalories(items) {
  const res = await fetch(`${FUNCTIONS_BASE}/estimate-calories`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "apikey": cfg.SUPABASE_ANON_KEY, "Authorization": `Bearer ${cfg.SUPABASE_ANON_KEY}` },
    body: JSON.stringify({ items }),
  });
  if (!res.ok) throw new Error("estimate-calories fehlgeschlagen (" + res.status + ")");
  return res.json();
}

/* ==========================================================================
   SWIPE-TO-DELETE (native Touch-Events) — für Artikel & Backlog
   ========================================================================== */
function makeSwipeToDelete(rowEl, contentEl, onDelete) {
  const THRESHOLD = 70;
  let startX = 0, startY = 0, dx = 0, isSwiping = false;
  rowEl.addEventListener("touchstart", e => {
    const t = e.touches[0];
    startX = t.clientX; startY = t.clientY; dx = 0; isSwiping = false;
    contentEl.style.transition = "none";
  }, { passive: true });
  rowEl.addEventListener("touchmove", e => {
    const t = e.touches[0];
    const diffX = t.clientX - startX, diffY = t.clientY - startY;
    if (!isSwiping && Math.abs(diffX) > 8 && Math.abs(diffX) > Math.abs(diffY)) isSwiping = true;
    if (isSwiping) {
      dx = Math.min(0, diffX);
      contentEl.style.transform = `translateX(${dx}px)`;
      if (e.cancelable) e.preventDefault();
    }
  }, { passive: false });
  rowEl.addEventListener("touchend", e => {
    if (!isSwiping) return;
    if (e.cancelable) e.preventDefault();
    if (dx < -THRESHOLD) {
      contentEl.style.transition = "transform .18s ease-in";
      contentEl.style.transform = "translateX(-110%)";
      rowEl.style.overflow = "hidden";
      rowEl.style.transition = "max-height .2s ease, opacity .2s ease";
      rowEl.style.maxHeight = rowEl.offsetHeight + "px";
      requestAnimationFrame(() => { rowEl.style.maxHeight = "0px"; rowEl.style.opacity = "0"; });
      setTimeout(onDelete, 190);
    } else {
      contentEl.style.transition = "transform .18s var(--ease, ease)";
      contentEl.style.transform = "translateX(0)";
    }
    isSwiping = false;
  });
}

/* ==========================================================================
   POINTER-DRAG SORT (Maus + Touch) — Kategorien per Ziehpunkt umsortieren
   ========================================================================== */
function initCategoryDragSort(grid) {
  grid.querySelectorAll("[data-drag-handle]").forEach(handle => {
    handle.addEventListener("pointerdown", e => {
      e.preventDefault();
      const row = handle.closest(".category-card-row");
      if (!row) return;
      row.classList.add("is-dragging");

      const onMove = ev => {
        const el = document.elementFromPoint(ev.clientX, ev.clientY);
        const over = el && el.closest(".category-card-row");
        if (over && over !== row && over.parentElement === grid) {
          const rect = over.getBoundingClientRect();
          const after = ev.clientY > rect.top + rect.height / 2;
          grid.insertBefore(row, after ? over.nextSibling : over);
        }
      };
      const onUp = () => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        row.classList.remove("is-dragging");
        const ids = [...grid.querySelectorAll("[data-cat-row]")].map(r => r.dataset.catRow);
        mutReorderCategories(ids);
      };
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
    });
  });
}

/* ==========================================================================
   VIEW-ROUTING (Dashboard ↔ Vollansichten)
   ========================================================================== */
function openView(name) {
  document.querySelectorAll(".view").forEach(v => v.classList.remove("is-active"));
  const target = document.getElementById("view-" + name);
  if (target) {
    target.classList.add("is-active");
    target.querySelectorAll(".reveal").forEach(el => el.classList.add("is-visible"));
    const bg = target.querySelector(".bg");
    if (bg) bg.style.transform = "translate3d(0,0,0)";
  }
  document.getElementById("backBtn").hidden = name === "dashboard";
  window.scrollTo({ top: 0 });
}
document.querySelectorAll("[data-open-view]").forEach(el => {
  el.addEventListener("click", () => openView(el.dataset.openView));
});
document.getElementById("backBtn").addEventListener("click", () => openView("dashboard"));

/* ==========================================================================
   RENDERING
   ========================================================================== */
function checkIconSVG() {
  return `<svg viewBox="0 0 12 12" fill="none"><path d="M2 6.2 4.8 9 10 3" stroke="#FFFFFF" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
function esc(s) { const d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; }
function platformLabel(p) { return { youtube: "YouTube", tiktok: "TikTok", instagram: "Instagram", sonstige: "Link" }[p] || "Link"; }
function calBadge(cal) { return (cal || cal === 0) ? `<span class="item__calories">${cal} kcal</span>` : ""; }

function renderDashboardTiles() {
  const openCount = state.shopping.filter(i => !i.checked).length;
  document.getElementById("tileListMeta").textContent = openCount ? `${openCount} offen` : "Alles erledigt";

  let next = null;
  for (let i = 0; i < 60; i++) {
    const iso = addDaysISO(todayISO(), i);
    const e = state.calendarMap[iso];
    if (e && e.meal) { next = { plan_date: iso, meal: e.meal }; break; }
  }
  document.getElementById("tileCalendarMeta").textContent = next
    ? `${formatDayLabel(next.plan_date)}: ${next.meal}`
    : "Noch nichts geplant";

  document.getElementById("tileBacklogMeta").textContent = state.backlog.length ? `${state.backlog.length} Artikel` : "Leer";
}

/* ---------- Einkaufsliste ---------- */
function renderList() {
  const grid = document.getElementById("listGrid");
  const cats = [...state.categories].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));

  grid.innerHTML = cats.map(cat => {
    const items = state.shopping.filter(i => i.category === cat.id);
    return `
    <div class="category-card-row" data-cat-row="${cat.id}">
      <div class="category-card reveal is-visible" data-cat="${cat.id}">
        <div class="category-card__head" data-cat-head="${cat.id}">
          <button type="button" class="cat-drag-handle" data-drag-handle aria-label="Kategorie verschieben">⠿</button>
          <span class="category-card__tag" contenteditable="true" spellcheck="false" data-cat-name="${cat.id}">${esc(cat.name)}</span>
          <button type="button" class="item-delete-btn category-delete-btn" data-delete-category="${cat.id}" aria-label="Kategorie löschen">×</button>
        </div>
        <ul>
          ${items.map(it => `
            <li class="item-row" data-row-id="${it.id}">
              <div class="item ${it.checked ? "is-checked" : ""}" data-id="${it.id}">
                <span class="check">${checkIconSVG()}</span>
                <span class="item__text">${esc(it.text)}</span>
                ${calBadge(it.calories)}
                <button type="button" class="item-delete-btn" data-delete-shopping="${it.id}" aria-label="Löschen">×</button>
              </div>
            </li>`).join("")}
        </ul>
        <div class="add-row">
          <input type="text" placeholder="Artikel hinzufügen…" aria-label="Neuen Artikel zu ${esc(cat.name)} hinzufügen" data-add="${cat.id}">
          <button type="button" data-add-btn="${cat.id}" aria-label="Hinzufügen">+</button>
        </div>
      </div>
    </div>`;
  }).join("");

  // Abhaken
  grid.querySelectorAll(".item").forEach(el => {
    el.addEventListener("click", e => {
      if (e.target.closest("[data-delete-shopping]")) return;
      const it = state.shopping.find(i => String(i.id) === el.dataset.id);
      if (!it) return;
      it.checked = !it.checked;
      el.classList.toggle("is-checked", it.checked);
      mutToggleShopping(it.id, it.checked);
    });
  });

  // Artikel löschen: × + Swipe
  grid.querySelectorAll("[data-delete-shopping]").forEach(btn => {
    btn.addEventListener("click", e => { e.stopPropagation(); mutDeleteShopping(btn.dataset.deleteShopping); });
  });
  grid.querySelectorAll("[data-row-id]").forEach(row => {
    makeSwipeToDelete(row, row.querySelector(".item"), () => mutDeleteShopping(row.dataset.rowId));
  });

  // Kategorie löschen (× Button)
  grid.querySelectorAll("[data-delete-category]").forEach(btn => {
    btn.addEventListener("click", e => { e.stopPropagation(); mutDeleteCategory(btn.dataset.deleteCategory); });
  });

  // Kategorie umbenennen
  grid.querySelectorAll("[data-cat-name]").forEach(tag => {
    tag.addEventListener("blur", () => {
      const val = tag.textContent.trim();
      if (val) mutRenameCategory(tag.dataset.catName, val);
    });
    tag.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); tag.blur(); } });
  });

  // Artikel hinzufügen
  grid.querySelectorAll("[data-add-btn]").forEach(btn => {
    const catId = btn.dataset.addBtn;
    const input = grid.querySelector(`[data-add="${catId}"]`);
    const commit = () => { const v = input.value.trim(); if (!v) return; input.value = ""; mutAddShopping(catId, v, null); };
    btn.addEventListener("click", commit);
    input.addEventListener("keydown", e => { if (e.key === "Enter") commit(); });
  });

  // Umsortieren per Ziehpunkt (Maus + Touch)
  initCategoryDragSort(grid);
}

/* ---------- Backlog ---------- */
function renderBacklog() {
  const grid = document.getElementById("pantryGrid");
  grid.innerHTML = state.backlog.map(it => `
    <div class="item-row" data-row-id="${it.id}">
      <div class="item ${it.checked ? "is-checked" : ""}" data-id="${it.id}">
        <span class="check">${checkIconSVG()}</span>
        <span class="item__text">${esc(it.text)}${it.quantity ? ` <small>(${esc(it.quantity)})</small>` : ""}</span>
        ${calBadge(it.calories)}
        <button type="button" class="item-delete-btn" data-delete-pantry="${it.id}" aria-label="Löschen">×</button>
      </div>
    </div>`).join("");

  const total = state.backlog.reduce((sum, it) => sum + (it.calories || 0), 0);
  document.getElementById("backlogTotal").textContent = state.backlog.length
    ? `${state.backlog.length} Artikel · ${total} kcal gesamt` : "Backlog ist leer.";

  grid.querySelectorAll(".item").forEach(el => {
    el.addEventListener("click", e => {
      if (e.target.closest("[data-delete-pantry]")) return;
      const it = state.backlog.find(i => String(i.id) === el.dataset.id);
      if (!it) return;
      it.checked = !it.checked;
      el.classList.toggle("is-checked", it.checked);
      mutToggleBacklog(it.id, it.checked);
    });
  });
  grid.querySelectorAll("[data-delete-pantry]").forEach(btn => {
    btn.addEventListener("click", e => { e.stopPropagation(); mutDeleteBacklog(btn.dataset.deletePantry); });
  });
  grid.querySelectorAll("[data-row-id]").forEach(row => {
    makeSwipeToDelete(row, row.querySelector(".item"), () => mutDeleteBacklog(row.dataset.rowId));
  });
}

/* ---------- Kalender (Tag / Woche / Monat) ---------- */
function recipeOptions(selectedId) {
  return `<option value="">— Rezept —</option>` +
    state.recipes.map(r => `<option value="${r.id}" ${r.id === selectedId ? "selected" : ""}>${esc(r.title)}</option>`).join("");
}
function dayRowHTML(iso) {
  const en = entryFor(iso);
  const recipe = en.recipe_id ? state.recipes.find(r => r.id === en.recipe_id) : null;
  const d = new Date(iso + "T00:00:00");
  const dow = d.toLocaleDateString("de-DE", { weekday: "short" });
  const dom = d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });
  return `
    <div class="cal-day-row ${iso === todayISO() ? "is-today" : ""}">
      <div class="cal-day-row__date"><span class="cal-dow">${dow}</span><span class="cal-dom">${dom}</span></div>
      <div class="cal-day-row__body">
        <p class="cal-meal">${esc(en.meal) || "—"}</p>
        ${recipe ? `<a href="${esc(recipe.url)}" target="_blank" rel="noopener" class="day-card__link">Rezept ↗</a>` : ""}
        <select data-assign-day="${iso}" aria-label="Rezept für ${esc(dom)} zuweisen">${recipeOptions(en.recipe_id)}</select>
      </div>
    </div>`;
}
function wireDaySelects(container) {
  container.querySelectorAll("[data-assign-day]").forEach(sel => {
    sel.addEventListener("change", () => {
      const planDate = sel.dataset.assignDay;
      if (sel.value === "") { mutAssignDay(planDate, "", null, "", ""); return; }
      const r = state.recipes.find(x => String(x.id) === sel.value);
      if (r) mutAssignDay(planDate, r.title, r.id, "", "");
    });
  });
}
function renderCalWeek(body, title) {
  const start = mondayOfISO(calAnchor);
  const days = Array.from({ length: 7 }, (_, i) => addDaysISO(start, i));
  const s = new Date(start + "T00:00:00"), e = new Date(addDaysISO(start, 6) + "T00:00:00");
  title.textContent = `${s.toLocaleDateString("de-DE", { day: "2-digit", month: "short" })} – ${e.toLocaleDateString("de-DE", { day: "2-digit", month: "short", year: "numeric" })}`;
  body.className = "cal-body cal-week";
  body.innerHTML = days.map(dayRowHTML).join("");
  wireDaySelects(body);
}
function renderCalDay(body, title) {
  title.textContent = new Date(calAnchor + "T00:00:00").toLocaleDateString("de-DE", { weekday: "long", day: "2-digit", month: "long", year: "numeric" });
  body.className = "cal-body cal-day";
  body.innerHTML = dayRowHTML(calAnchor);
  wireDaySelects(body);
}
function renderCalMonth(body, title) {
  const fom = firstOfMonthISO(calAnchor);
  const gridStart = mondayOfISO(fom);
  const anchorMonth = new Date(fom + "T00:00:00").getMonth();
  title.textContent = new Date(fom + "T00:00:00").toLocaleDateString("de-DE", { month: "long", year: "numeric" });
  body.className = "cal-body cal-month";
  const dows = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
  let html = `<div class="cal-month__head">${dows.map(x => `<span>${x}</span>`).join("")}</div><div class="cal-month__grid">`;
  for (let i = 0; i < 42; i++) {
    const iso = addDaysISO(gridStart, i);
    const en = entryFor(iso);
    const dd = new Date(iso + "T00:00:00");
    const inMonth = dd.getMonth() === anchorMonth;
    html += `
      <button type="button" class="cal-cell ${inMonth ? "" : "is-out"} ${iso === todayISO() ? "is-today" : ""}" data-cal-day="${iso}">
        <span class="cal-cell__num">${dd.getDate()}</span>
        ${en.meal ? `<span class="cal-cell__meal">${esc(en.meal)}</span>` : ""}
      </button>`;
  }
  html += `</div>`;
  body.innerHTML = html;
  body.querySelectorAll("[data-cal-day]").forEach(c => {
    c.addEventListener("click", () => { calAnchor = c.dataset.calDay; calView = "day"; renderCalendar(); });
  });
}
function renderCalendar() {
  const body = document.getElementById("calBody");
  const title = document.getElementById("calTitle");
  if (!body || !title) return;
  document.querySelectorAll("[data-cal-view]").forEach(b => b.classList.toggle("is-active", b.dataset.calView === calView));
  if (calView === "day") renderCalDay(body, title);
  else if (calView === "month") renderCalMonth(body, title);
  else renderCalWeek(body, title);
}
function shiftAnchor(dir) {
  if (calView === "day") return addDaysISO(calAnchor, dir);
  if (calView === "month") return shiftMonthISO(calAnchor, dir);
  return addDaysISO(calAnchor, dir * 7);
}
// Kalender-Navigation (Buttons existieren dauerhaft im DOM)
document.getElementById("calPrev").addEventListener("click", () => { calAnchor = shiftAnchor(-1); renderCalendar(); });
document.getElementById("calNext").addEventListener("click", () => { calAnchor = shiftAnchor(1); renderCalendar(); });
document.getElementById("calToday").addEventListener("click", () => { calAnchor = todayISO(); renderCalendar(); });
document.querySelectorAll("[data-cal-view]").forEach(b => {
  b.addEventListener("click", () => { calView = b.dataset.calView; renderCalendar(); });
});

/* ---------- Rezept-Galerie ---------- */
function renderRecipeGallery() {
  const wrap = document.getElementById("recipeGallery");
  if (!state.recipes.length) { wrap.innerHTML = ""; wrap.hidden = true; return; }
  wrap.hidden = false;
  wrap.innerHTML = state.recipes.map(r => {
    const total = (r.ingredients || []).reduce((s, ing) => s + (ing.calories || 0), 0) || r.calories || 0;
    return `
    <div class="recipe-card" data-id="${r.id}">
      ${r.thumbnail ? `<img src="${esc(r.thumbnail)}" alt="" class="recipe-card__thumb">`
        : `<div class="recipe-card__thumb recipe-card__thumb--placeholder">${platformLabel(r.platform)}</div>`}
      <div class="recipe-card__body">
        <span class="platform-tag">${platformLabel(r.platform)}</span>
        <p class="recipe-card__title">${esc(r.title)}</p>
        ${total ? `<p class="item__calories">${total} kcal gesamt</p>` : ""}
        <button type="button" class="recipe-card__remove" data-delete-recipe="${r.id}">Entfernen</button>
      </div>
    </div>`;
  }).join("");
  wrap.querySelectorAll("[data-delete-recipe]").forEach(btn => {
    btn.addEventListener("click", () => mutDeleteRecipe(btn.dataset.deleteRecipe));
  });
}

function renderAll() {
  renderDashboardTiles();
  renderList();
  renderBacklog();
  renderCalendar();
  renderRecipeGallery();
}

function renderSyncBadge(ok) {
  const badge = document.getElementById("syncBadge");
  if (REMOTE && ok) { badge.textContent = "● Live-Sync aktiv"; badge.classList.add("is-live"); }
  else if (REMOTE && !ok) { badge.textContent = "○ Sync-Fehler — lokal"; badge.classList.remove("is-live"); }
  else { badge.textContent = "○ Lokal (nur dieses Gerät)"; badge.classList.remove("is-live"); }
}

/* ==========================================================================
   NEUE KATEGORIE ANLEGEN
   ========================================================================== */
(function initAddCategory() {
  const input = document.getElementById("newCategoryInput");
  const btn = document.getElementById("addCategoryBtn");
  if (!input || !btn) return;
  const commit = () => { const v = input.value.trim(); if (!v) return; input.value = ""; mutAddCategory(v); };
  btn.addEventListener("click", commit);
  input.addEventListener("keydown", e => { if (e.key === "Enter") commit(); });
})();

/* ==========================================================================
   MODAL: REZEPT IMPORTIEREN
   ========================================================================== */
const importModal = document.getElementById("importModal");
const receiptModal = document.getElementById("receiptModal");
const reviewModal = document.getElementById("reviewModal");

function openModal(el) { el.hidden = false; document.documentElement.style.overflow = "hidden"; }
function closeModal(el) { el.hidden = true; document.documentElement.style.overflow = ""; }

function detectPlatform(url) {
  if (/tiktok\.com/i.test(url)) return "tiktok";
  if (/youtube\.com|youtu\.be/i.test(url)) return "youtube";
  if (/instagram\.com/i.test(url)) return "instagram";
  return "sonstige";
}
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
  const cats = [...state.categories].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  document.getElementById("importCategory").innerHTML = cats.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
  const days = Array.from({ length: 14 }, (_, i) => addDaysISO(todayISO(), i));
  document.getElementById("importDay").innerHTML =
    `<option value="">— keinem Tag —</option>` + days.map(d => `<option value="${d}">${esc(formatDayLabel(d))}</option>`).join("");
}
function resetImportForm() {
  currentImport = null;
  ["importUrl", "importIngredients", "previewTitle"].forEach(id => document.getElementById(id).value = "");
  document.getElementById("platformNote").textContent = "";
  document.getElementById("importPreview").hidden = true;
  document.getElementById("caloriesNote").textContent = "";
  document.getElementById("ingredientCalories").innerHTML = "";
  document.getElementById("recipeTotalCalories").hidden = true;
  document.getElementById("recipeTotalCalories").textContent = "";
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
  if (platform === "instagram" || platform === "sonstige") {
    note.textContent = platform === "instagram"
      ? "Instagram erlaubt keine automatische Vorschau ohne eigenen API-Zugang — Titel bitte manuell eintragen."
      : "Unbekannte Plattform — Titel bitte manuell eintragen.";
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

let lastEstimatedCalories = null;
document.getElementById("estimateCaloriesBtn").addEventListener("click", async () => {
  const note = document.getElementById("caloriesNote");
  const lines = document.getElementById("importIngredients").value.split("\n").map(s => s.trim()).filter(Boolean);
  if (!lines.length) { note.textContent = "Bitte zuerst Zutaten eintragen."; return; }
  if (!FUNCTIONS_BASE) { note.textContent = "Kalorienschätzung braucht eine Supabase-Verbindung."; return; }
  note.textContent = "Schätze Kalorien…";
  try {
    const result = await callEstimateCalories(lines);
    lastEstimatedCalories = result.items || [];
    document.getElementById("ingredientCalories").innerHTML = lastEstimatedCalories.map(it => `
      <div class="ingredient-calories__row"><span>${esc(it.text)}</span><span>${it.calories ?? "–"} kcal</span></div>`).join("");
    const totalEl = document.getElementById("recipeTotalCalories");
    totalEl.textContent = `Gesamt: ${result.total ?? 0} kcal`;
    totalEl.hidden = false;
    note.textContent = "Kalorien geschätzt.";
  } catch (e) {
    note.textContent = "Kalorienschätzung fehlgeschlagen — prüfe ANTHROPIC_API_KEY in Supabase.";
    console.warn(e);
  }
});

document.getElementById("saveImport").addEventListener("click", async () => {
  const url = document.getElementById("importUrl").value.trim();
  const title = document.getElementById("previewTitle").value.trim() || "Importiertes Rezept";
  const rawLines = document.getElementById("importIngredients").value.split("\n").map(s => s.trim()).filter(Boolean);
  const category = document.getElementById("importCategory").value;
  const planDate = document.getElementById("importDay").value;
  if (!url) { document.getElementById("platformNote").textContent = "Ohne Link kein Rezept — bitte Link einfügen."; return; }

  const ingredients = rawLines.map(text => {
    const match = lastEstimatedCalories && lastEstimatedCalories.find(i => i.text === text);
    return { text, calories: match ? match.calories : null };
  });
  const totalCalories = ingredients.reduce((s, i) => s + (i.calories || 0), 0) || null;
  const platform = (currentImport && currentImport.platform) || detectPlatform(url);
  const thumbnail = (currentImport && currentImport.thumbnail) || "";
  try {
    await mutAddRecipe({ title, url, platform, thumbnail, calories: totalCalories }, ingredients, category, planDate || null);
    lastEstimatedCalories = null;
    closeModal(importModal);
  } catch (e) {
    document.getElementById("platformNote").textContent = "Speichern fehlgeschlagen — Verbindung prüfen.";
    console.warn(e);
  }
});

/* ==========================================================================
   MODAL: KASSENZETTEL SCANNEN
   ========================================================================== */
document.getElementById("openReceiptModal").addEventListener("click", () => {
  currentReceiptItems = null;
  document.getElementById("receiptFile").value = "";
  document.getElementById("receiptNote").textContent = "";
  document.getElementById("receiptResults").innerHTML = "";
  document.getElementById("receiptResults").hidden = true;
  document.getElementById("saveReceiptItems").hidden = true;
  openModal(receiptModal);
});
document.getElementById("closeReceiptModal").addEventListener("click", () => closeModal(receiptModal));
receiptModal.addEventListener("click", e => { if (e.target === receiptModal) closeModal(receiptModal); });

document.getElementById("receiptFile").addEventListener("change", async e => {
  const file = e.target.files[0];
  const note = document.getElementById("receiptNote");
  if (!file) return;
  if (!FUNCTIONS_BASE) { note.textContent = "Kassenzettel-Scan braucht eine Supabase-Verbindung."; return; }
  note.textContent = "Lese Kassenzettel…";
  try {
    const base64 = await fileToBase64(file);
    const result = await callScanReceipt(base64, file.type || "image/jpeg");
    currentReceiptItems = (result.items || []).map(it => ({ text: it.text, quantity: it.quantity || "", calories: it.calories ?? null }));
    renderReceiptResults();
    note.textContent = currentReceiptItems.length ? "Zutaten erkannt — vor dem Speichern prüfen." : "Keine Artikel erkannt.";
    document.getElementById("saveReceiptItems").hidden = !currentReceiptItems.length;
  } catch (err) {
    note.textContent = "Scan fehlgeschlagen — prüfe ANTHROPIC_API_KEY in Supabase.";
    console.warn(err);
  }
});

function renderReceiptResults() {
  const box = document.getElementById("receiptResults");
  if (!currentReceiptItems || !currentReceiptItems.length) { box.hidden = true; box.innerHTML = ""; return; }
  box.hidden = false;
  box.innerHTML = currentReceiptItems.map((it, i) => `
    <div class="receipt-item-row" data-idx="${i}">
      <input type="text" data-field="text" value="${esc(it.text)}">
      <input type="text" data-field="quantity" value="${esc(it.quantity)}" placeholder="Menge">
      <input type="number" data-field="calories" value="${it.calories ?? ""}" placeholder="kcal">
    </div>`).join("");
  box.querySelectorAll(".receipt-item-row").forEach(row => {
    const idx = +row.dataset.idx;
    row.querySelectorAll("input").forEach(input => {
      input.addEventListener("change", () => {
        const field = input.dataset.field;
        currentReceiptItems[idx][field] = field === "calories" ? (input.value === "" ? null : +input.value) : input.value;
      });
    });
  });
}

document.getElementById("saveReceiptItems").addEventListener("click", async () => {
  if (!currentReceiptItems || !currentReceiptItems.length) return;
  for (const it of currentReceiptItems) {
    if (!it.text.trim()) continue;
    await mutAddBacklog(it.text.trim(), it.calories, it.quantity, "receipt");
  }
  currentReceiptItems = null;
  closeModal(receiptModal);
});

/* ==========================================================================
   MODAL: WOCHE ABSCHLIESSEN
   ========================================================================== */
document.getElementById("openReview").addEventListener("click", () => {
  const cats = state.categories;
  const checkedItems = state.shopping.filter(i => i.checked)
    .map(i => ({ ...i, catName: (cats.find(c => c.id === i.category) || {}).name || "" }));
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
        <span class="switch"><input type="checkbox" data-review="${it.id}"><span class="switch__track"></span></span>
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
    if (t.checked) { const it = state.shopping.find(i => String(i.id) === t.dataset.review); if (it) leftovers.push(it); }
  });
  await mutFinishWeek(leftovers);
  closeModal(reviewModal);
});

/* ---------- Backlog: manuell hinzufügen ---------- */
(function initPantryAdd() {
  const input = document.getElementById("pantryInput");
  const commit = () => { const v = input.value.trim(); if (!v) return; input.value = ""; mutAddBacklog(v, null, "", "manual"); };
  document.getElementById("pantryAddBtn").addEventListener("click", commit);
  input.addEventListener("keydown", e => { if (e.key === "Enter") commit(); });
})();

/* ==========================================================================
   SCROLL-EFFEKTE — Fortschrittsbalken + sanfte Parallax
   ========================================================================== */
function initScrollFX() {
  const bar = document.getElementById("scrollBar");
  const prefersReduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let ticking = false;
  function apply() {
    ticking = false;
    const max = document.documentElement.scrollHeight - innerHeight;
    if (bar) bar.style.width = (max > 0 ? (window.scrollY / max) * 100 : 0) + "%";
    if (!prefersReduced) {
      const active = document.querySelector(".view.is-active .bg");
      if (active) active.style.transform = `translate3d(0, ${(window.scrollY * 0.12).toFixed(1)}px, 0)`;
    }
  }
  window.addEventListener("scroll", () => { if (!ticking) { requestAnimationFrame(apply); ticking = true; } }, { passive: true });
  apply();
}

/* ==========================================================================
   INIT
   ========================================================================== */
async function init() {
  if (REMOTE) {
    try { await remoteFetchAll(); remoteSubscribe(); renderSyncBadge(true); }
    catch (e) { console.warn("Supabase nicht erreichbar, Lokal-Modus:", e); localLoad(); renderSyncBadge(false); }
  } else { localLoad(); renderSyncBadge(false); }
  renderAll();
  openView("dashboard");
  initScrollFX();
}
document.addEventListener("DOMContentLoaded", init);
