/* ==========================================================================
   HOMEBASE — Mehrere Einkaufslisten · Kalender (mehrere Rezepte/Tag) · Backlog
   ========================================================================== */

const DEFAULT_CATS = ["Obst & Gemüse", "Gläser & Konserven", "Kräuter & Gewürze", "Getreide", "Milchprodukte", "TK", "Getränke"];

/* ---------- Helfer ---------- */
function uid(p) { return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function todayISO() { return new Date().toISOString().slice(0, 10); }
function addDaysISO(iso, n) { const d = new Date(iso + "T00:00:00"); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }
function shiftMonthISO(iso, n) { const d = new Date(iso + "T00:00:00"); d.setMonth(d.getMonth() + n); return d.toISOString().slice(0, 10); }
function firstOfMonthISO(iso) { const d = new Date(iso + "T00:00:00"); d.setDate(1); return d.toISOString().slice(0, 10); }
function mondayOfISO(iso) { const d = new Date(iso + "T00:00:00"); const off = (d.getDay() + 6) % 7; d.setDate(d.getDate() - off); return d.toISOString().slice(0, 10); }
function formatDayLabel(iso) {
  const d = new Date(iso + "T00:00:00");
  return `${d.toLocaleDateString("de-DE", { weekday: "long" })}, ${d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" })}`;
}
function formatDate(ts) { if (!ts) return ""; return new Date(ts).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" }); }

/* ==========================================================================
   DATENSCHICHT — Supabase (Echtzeit) mit localStorage-Fallback
   ========================================================================== */
const cfg = window.APP_CONFIG || {};
let sb = null;
if (window.supabase && cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY) {
  try { sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY); }
  catch (e) { console.warn("Supabase-Init fehlgeschlagen:", e); }
}
const REMOTE = !!sb;
const FUNCTIONS_BASE = cfg.SUPABASE_URL ? `${cfg.SUPABASE_URL}/functions/v1` : "";
const STORAGE_KEY = "homebase_state_v7";

let state = { lists: [], categories: [], shopping: [], backlog: [], calendar: [], recipes: [] };
let currentImport = null;
let currentReceiptItems = null;
let activeListId = null;
let showHistory = false;
let expandedRecipe = null;

/* Kalender-UI */
let calView = "week";
let calAnchor = todayISO();
let expandedCal = null;

/* View-Navigation (Eltern für Zurück-Button) */
const VIEW_PARENT = { lists: "dashboard", listdetail: "lists", calendar: "dashboard", backlog: "dashboard" };
let currentView = "dashboard";

/* ---------- Lokal-Modus ---------- */
function localLoad() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) { state = JSON.parse(raw); }
  } catch (e) { /* ignorieren */ }
  if (!state.lists || !state.lists.length) {
    const id = "list_default";
    state = { lists: [{ id, name: "Wocheneinkauf", sort_order: 1, completed_at: null }], categories: [], shopping: [], backlog: [], calendar: [], recipes: [] };
    DEFAULT_CATS.forEach((name, i) => state.categories.push({ id: uid("cat_"), list_id: id, name, sort_order: i + 1 }));
    localSave();
  }
  ["lists", "categories", "shopping", "backlog", "calendar", "recipes"].forEach(k => { if (!state[k]) state[k] = []; });
}
function localSave() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }

/* ---------- Supabase-Modus ---------- */
async function remoteFetchAll() {
  const [lists, cats, shop, backlog, cal, recipes] = await Promise.all([
    sb.from("shopping_lists").select("*").order("sort_order"),
    sb.from("categories").select("*").order("sort_order"),
    sb.from("shopping_items").select("*").order("created_at"),
    sb.from("backlog_items").select("*").order("created_at"),
    sb.from("calendar_entries").select("*").order("plan_date"),
    sb.from("recipes").select("*").order("created_at"),
  ]);
  const err = lists.error || cats.error || shop.error || backlog.error || cal.error || recipes.error;
  if (err) throw err;
  state.lists = lists.data || [];
  state.categories = cats.data || [];
  state.shopping = shop.data || [];
  state.backlog = backlog.data || [];
  state.calendar = cal.data || [];
  state.recipes = (recipes.data || []).map(r => ({ ...r, ingredients: r.ingredients || [] }));
}

let refreshTimer = null;
function scheduleRemoteRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => { try { await remoteFetchAll(); ensureActiveList(); renderAll(); } catch (e) { console.warn(e); } }, 150);
}
function remoteSubscribe() {
  sb.channel("app-realtime").on("postgres_changes", { event: "*", schema: "public" }, scheduleRemoteRefresh).subscribe();
}

/* ---------- Abgeleitete Daten ---------- */
function activeLists() { return state.lists.filter(l => !l.completed_at).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0)); }
function historyFor(name, excludeId) {
  return state.lists.filter(l => l.name === name && l.completed_at && l.id !== excludeId)
    .sort((a, b) => (a.completed_at < b.completed_at ? 1 : -1)).slice(0, 2);
}
function catsOfList(listId) { return state.categories.filter(c => c.list_id === listId).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0)); }
function itemsOfCat(catId) { return state.shopping.filter(i => i.category === catId); }
function itemsOfList(listId) { const ids = new Set(catsOfList(listId).map(c => c.id)); return state.shopping.filter(i => ids.has(i.category)); }
function getList(id) { return state.lists.find(l => l.id === id); }
function ensureActiveList() {
  const act = activeLists();
  if (!act.length) return;
  if (!activeListId || !act.find(l => l.id === activeListId)) activeListId = act[0].id;
}

/* ---------- Mutationen: Listen ---------- */
async function mutAddList(name) {
  const id = uid("list_");
  const sort = state.lists.reduce((m, l) => Math.max(m, l.sort_order || 0), 0) + 1;
  if (REMOTE) {
    await sb.from("shopping_lists").insert({ id, name, sort_order: sort });
    await sb.from("categories").insert(DEFAULT_CATS.map((n, i) => ({ id: uid("cat_"), list_id: id, name: n, sort_order: i + 1 })));
    await remoteFetchAll();
  } else {
    state.lists.push({ id, name, sort_order: sort, completed_at: null });
    DEFAULT_CATS.forEach((n, i) => state.categories.push({ id: uid("cat_"), list_id: id, name: n, sort_order: i + 1 }));
    localSave();
  }
  renderAll();
}
async function mutRenameList(id, name) {
  if (REMOTE) { await sb.from("shopping_lists").update({ name }).eq("id", id); await remoteFetchAll(); }
  else { const l = getList(id); if (l) l.name = name; localSave(); }
  renderAll();
}
async function mutDeleteList(id) {
  if (REMOTE) {
    const catIds = catsOfList(id).map(c => c.id);
    if (catIds.length) await sb.from("shopping_items").delete().in("category", catIds);
    await sb.from("categories").delete().eq("list_id", id);
    await sb.from("shopping_lists").delete().eq("id", id);
    await remoteFetchAll();
  } else {
    const catIds = new Set(catsOfList(id).map(c => c.id));
    state.shopping = state.shopping.filter(i => !catIds.has(i.category));
    state.categories = state.categories.filter(c => c.list_id !== id);
    state.lists = state.lists.filter(l => l.id !== id);
    localSave();
  }
  if (activeListId === id) { activeListId = null; ensureActiveList(); }
  renderAll();
}
async function mutCompleteList(id) {
  const list = getList(id); if (!list) return;
  const newId = uid("list_");
  const cats = catsOfList(id);
  if (REMOTE) {
    await sb.from("shopping_lists").update({ completed_at: new Date().toISOString() }).eq("id", id);
    await sb.from("shopping_lists").insert({ id: newId, name: list.name, sort_order: list.sort_order });
    if (cats.length) await sb.from("categories").insert(cats.map(c => ({ id: uid("cat_"), list_id: newId, name: c.name, sort_order: c.sort_order })));
    await remoteFetchAll();
    // Historie auf 2 begrenzen
    const old = state.lists.filter(l => l.name === list.name && l.completed_at).sort((a, b) => (a.completed_at < b.completed_at ? 1 : -1)).slice(2);
    for (const l of old) {
      const cids = catsOfList(l.id).map(c => c.id);
      if (cids.length) await sb.from("shopping_items").delete().in("category", cids);
      await sb.from("categories").delete().eq("list_id", l.id);
      await sb.from("shopping_lists").delete().eq("id", l.id);
    }
    if (old.length) await remoteFetchAll();
  } else {
    list.completed_at = new Date().toISOString();
    state.lists.push({ id: newId, name: list.name, sort_order: list.sort_order, completed_at: null });
    cats.forEach(c => state.categories.push({ id: uid("cat_"), list_id: newId, name: c.name, sort_order: c.sort_order }));
    const old = state.lists.filter(l => l.name === list.name && l.completed_at).sort((a, b) => (a.completed_at < b.completed_at ? 1 : -1)).slice(2);
    old.forEach(l => {
      const cids = new Set(catsOfList(l.id).map(c => c.id));
      state.shopping = state.shopping.filter(i => !cids.has(i.category));
      state.categories = state.categories.filter(c => c.list_id !== l.id);
      state.lists = state.lists.filter(x => x.id !== l.id);
    });
    localSave();
  }
  activeListId = newId;
  renderAll();
}
async function mutCopyFromList(sourceId, targetId) {
  const items = itemsOfList(sourceId);
  let targetCats = catsOfList(targetId);
  for (const it of items) {
    const srcCat = state.categories.find(c => c.id === it.category);
    const name = srcCat ? srcCat.name : "Sonstiges";
    let tcat = targetCats.find(c => c.name === name);
    if (!tcat) {
      const nid = uid("cat_");
      const order = targetCats.reduce((m, c) => Math.max(m, c.sort_order || 0), 0) + 1;
      tcat = { id: nid, list_id: targetId, name, sort_order: order };
      if (REMOTE) await sb.from("categories").insert({ id: nid, list_id: targetId, name, sort_order: order });
      else state.categories.push(tcat);
      targetCats.push(tcat);
    }
    if (REMOTE) await sb.from("shopping_items").insert({ list_id: targetId, category: tcat.id, text: it.text, calories: it.calories ?? null });
    else state.shopping.push({ id: uid("s"), list_id: targetId, category: tcat.id, text: it.text, calories: it.calories ?? null, checked: false });
  }
  if (REMOTE) await remoteFetchAll(); else localSave();
  renderAll();
}

/* ---------- Mutationen: Artikel ---------- */
async function mutAddShopping(category, text, listId) {
  if (REMOTE) { await sb.from("shopping_items").insert({ category, text, list_id: listId, calories: null }); await remoteFetchAll(); }
  else { state.shopping.push({ id: uid("s"), category, text, list_id: listId, calories: null, checked: false }); localSave(); }
  renderAll();
}
async function mutToggleShopping(id, checked) {
  if (REMOTE) { await sb.from("shopping_items").update({ checked }).eq("id", id); }
  else { const it = state.shopping.find(i => i.id === id); if (it) it.checked = checked; localSave(); }
}
async function mutUpdateShopping(id, text) {
  if (REMOTE) { await sb.from("shopping_items").update({ text }).eq("id", id); await remoteFetchAll(); }
  else { const it = state.shopping.find(i => i.id === id); if (it) it.text = text; localSave(); }
  renderAll();
}
async function mutDeleteShopping(id) {
  if (REMOTE) { await sb.from("shopping_items").delete().eq("id", id); await remoteFetchAll(); }
  else { state.shopping = state.shopping.filter(i => i.id !== id); localSave(); }
  renderAll();
}

/* ---------- Mutationen: Backlog ---------- */
async function mutAddBacklog(text, calories, quantity, source) {
  if (REMOTE) { await sb.from("backlog_items").insert({ text, calories: calories ?? null, quantity: quantity || "", source: source || "manual" }); await remoteFetchAll(); }
  else { state.backlog.push({ id: uid("b"), text, calories: calories ?? null, quantity: quantity || "", source: source || "manual", checked: false }); localSave(); }
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

/* ---------- Mutationen: Kategorien ---------- */
async function mutAddCategory(name, listId) {
  const id = uid("cat_");
  const order = catsOfList(listId).reduce((m, c) => Math.max(m, c.sort_order || 0), 0) + 1;
  if (REMOTE) { await sb.from("categories").insert({ id, name, sort_order: order, list_id: listId }); await remoteFetchAll(); }
  else { state.categories.push({ id, name, sort_order: order, list_id: listId }); localSave(); }
  renderAll();
}
async function mutRenameCategory(id, name) {
  if (REMOTE) { await sb.from("categories").update({ name }).eq("id", id); await remoteFetchAll(); }
  else { const c = state.categories.find(c => c.id === id); if (c) c.name = name; localSave(); }
  renderAll();
}
async function mutReorderCategories(orderedIds) {
  orderedIds.forEach((id, i) => { const c = state.categories.find(c => c.id === id); if (c) c.sort_order = i + 1; });
  if (REMOTE) { await Promise.all(orderedIds.map((id, i) => sb.from("categories").update({ sort_order: i + 1 }).eq("id", id))); await remoteFetchAll(); }
  else localSave();
  renderAll();
}
async function mutDeleteCategory(id) {
  if (REMOTE) { await sb.from("shopping_items").delete().eq("category", id); await sb.from("categories").delete().eq("id", id); await remoteFetchAll(); }
  else { state.shopping = state.shopping.filter(i => i.category !== id); state.categories = state.categories.filter(c => c.id !== id); localSave(); }
  renderAll();
}

/* ---------- Mutationen: Kalender (mehrere Rezepte/Tag) ---------- */
function calEntriesOn(iso) { return state.calendar.filter(e => e.plan_date === iso); }
async function mutAddCalendarEntry(planDate, recipeId, meal) {
  if (REMOTE) { await sb.from("calendar_entries").insert({ plan_date: planDate, recipe_id: recipeId, meal }); await remoteFetchAll(); }
  else { state.calendar.push({ id: uid("c"), plan_date: planDate, recipe_id: recipeId, meal, time: "", tag: "" }); localSave(); }
  renderAll();
}
async function mutDeleteCalendarEntry(id) {
  if (REMOTE) { await sb.from("calendar_entries").delete().eq("id", id); await remoteFetchAll(); }
  else { state.calendar = state.calendar.filter(e => e.id !== id); localSave(); }
  renderAll();
}

/* ---------- Mutationen: Rezepte (ohne Zutaten-Import in die Liste) ---------- */
async function mutAddRecipe(recipe, ingredients, planDate) {
  if (REMOTE) {
    const { data, error } = await sb.from("recipes").insert({ ...recipe, ingredients }).select().single();
    if (error) throw error;
    if (planDate) await sb.from("calendar_entries").insert({ plan_date: planDate, meal: recipe.title, recipe_id: data.id });
    await remoteFetchAll();
  } else {
    const id = uid("r");
    state.recipes.push({ id, ...recipe, ingredients });
    if (planDate) state.calendar.push({ id: uid("c"), plan_date: planDate, meal: recipe.title, recipe_id: id, time: "", tag: "" });
    localSave();
  }
  renderAll();
}
async function mutDeleteRecipe(id) {
  if (REMOTE) { await sb.from("calendar_entries").delete().eq("recipe_id", id); await sb.from("recipes").delete().eq("id", id); await remoteFetchAll(); }
  else { state.recipes = state.recipes.filter(r => r.id !== id); state.calendar = state.calendar.filter(e => e.recipe_id !== id); localSave(); }
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
  if (!res.ok) throw new Error("scan-receipt " + res.status);
  return res.json();
}
async function callEstimateCalories(items) {
  const res = await fetch(`${FUNCTIONS_BASE}/estimate-calories`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "apikey": cfg.SUPABASE_ANON_KEY, "Authorization": `Bearer ${cfg.SUPABASE_ANON_KEY}` },
    body: JSON.stringify({ items }),
  });
  if (!res.ok) throw new Error("estimate-calories " + res.status);
  return res.json();
}

/* ==========================================================================
   SWIPE-TO-DELETE (Touch)
   ========================================================================== */
function makeSwipeToDelete(rowEl, contentEl, onDelete) {
  const THRESHOLD = 70;
  let startX = 0, startY = 0, dx = 0, isSwiping = false;
  rowEl.addEventListener("touchstart", e => { const t = e.touches[0]; startX = t.clientX; startY = t.clientY; dx = 0; isSwiping = false; contentEl.style.transition = "none"; }, { passive: true });
  rowEl.addEventListener("touchmove", e => {
    const t = e.touches[0], diffX = t.clientX - startX, diffY = t.clientY - startY;
    if (!isSwiping && Math.abs(diffX) > 8 && Math.abs(diffX) > Math.abs(diffY)) isSwiping = true;
    if (isSwiping) { dx = Math.min(0, diffX); contentEl.style.transform = `translateX(${dx}px)`; if (e.cancelable) e.preventDefault(); }
  }, { passive: false });
  rowEl.addEventListener("touchend", e => {
    if (!isSwiping) return;
    if (e.cancelable) e.preventDefault();
    if (dx < -THRESHOLD) {
      contentEl.style.transition = "transform .18s ease-in"; contentEl.style.transform = "translateX(-110%)";
      rowEl.style.overflow = "hidden"; rowEl.style.transition = "max-height .2s ease, opacity .2s ease"; rowEl.style.maxHeight = rowEl.offsetHeight + "px";
      requestAnimationFrame(() => { rowEl.style.maxHeight = "0px"; rowEl.style.opacity = "0"; });
      setTimeout(onDelete, 190);
    } else { contentEl.style.transition = "transform .18s ease"; contentEl.style.transform = "translateX(0)"; }
    isSwiping = false;
  });
}

/* Pointer-Drag zum Umsortieren (Maus + Touch) */
function initCategoryDragSort(grid) {
  grid.querySelectorAll("[data-drag-handle]").forEach(handle => {
    handle.addEventListener("pointerdown", e => {
      e.preventDefault();
      const row = handle.closest(".category-card-row"); if (!row) return;
      row.classList.add("is-dragging");
      const onMove = ev => {
        const el = document.elementFromPoint(ev.clientX, ev.clientY);
        const over = el && el.closest(".category-card-row");
        if (over && over !== row && over.parentElement === grid) {
          const rect = over.getBoundingClientRect();
          grid.insertBefore(row, ev.clientY > rect.top + rect.height / 2 ? over.nextSibling : over);
        }
      };
      const onUp = () => {
        document.removeEventListener("pointermove", onMove); document.removeEventListener("pointerup", onUp);
        row.classList.remove("is-dragging");
        mutReorderCategories([...grid.querySelectorAll("[data-cat-row]")].map(r => r.dataset.catRow));
      };
      document.addEventListener("pointermove", onMove); document.addEventListener("pointerup", onUp);
    });
  });
}

/* ==========================================================================
   VIEW-ROUTING
   ========================================================================== */
function openView(name) {
  currentView = name;
  document.querySelectorAll(".view").forEach(v => v.classList.remove("is-active"));
  const target = document.getElementById("view-" + name);
  if (target) {
    target.classList.add("is-active");
    target.querySelectorAll(".reveal").forEach(el => el.classList.add("is-visible"));
    const bg = target.querySelector(".bg"); if (bg) bg.style.transform = "translate3d(0,0,0)";
  }
  const back = document.getElementById("backBtn");
  back.hidden = name === "dashboard";
  back.textContent = name === "listdetail" ? "← Listen" : "← Übersicht";
  window.scrollTo({ top: 0 });
}
function openList(id) { activeListId = id; showHistory = false; renderListDetail(); openView("listdetail"); }
document.querySelectorAll("[data-open-view]").forEach(el => el.addEventListener("click", () => openView(el.dataset.openView)));
document.getElementById("backBtn").addEventListener("click", () => openView(VIEW_PARENT[currentView] || "dashboard"));

/* ==========================================================================
   RENDER-HELFER
   ========================================================================== */
function checkIconSVG() { return `<svg viewBox="0 0 12 12" fill="none"><path d="M2 6.2 4.8 9 10 3" stroke="#FFFFFF" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`; }
function esc(s) { const d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; }
function platformLabel(p) { return { youtube: "YouTube", tiktok: "TikTok", instagram: "Instagram", sonstige: "Link" }[p] || "Link"; }
function calBadge(cal) { return (cal || cal === 0) ? `<span class="item__calories">${cal} kcal</span>` : ""; }

function renderDashboardTiles() {
  const act = activeLists();
  document.getElementById("tileListMeta").textContent = act.length ? `${act.length} Liste${act.length > 1 ? "n" : ""}` : "Keine Liste";
  const upcoming = state.calendar.filter(e => e.plan_date >= todayISO() && e.meal).sort((a, b) => a.plan_date < b.plan_date ? -1 : 1)[0];
  document.getElementById("tileCalendarMeta").textContent = upcoming ? `${formatDayLabel(upcoming.plan_date)}: ${upcoming.meal}` : "Noch nichts geplant";
  document.getElementById("tileBacklogMeta").textContent = state.backlog.length ? `${state.backlog.length} Artikel` : "Leer";
}

/* ==========================================================================
   EINKAUFSLISTEN-ÜBERSICHT
   ========================================================================== */
function renderListsOverview() {
  const grid = document.getElementById("listsGrid");
  const lists = activeLists();
  grid.innerHTML = lists.map(l => {
    const items = itemsOfList(l.id);
    const open = items.filter(i => !i.checked).length;
    const hist = historyFor(l.name, l.id)[0];
    return `
    <div class="list-card" data-open-list="${l.id}">
      <button type="button" class="item-delete-btn list-card__del" data-del-list="${l.id}" aria-label="Liste löschen">×</button>
      <span class="list-card__icon">🛒</span>
      <span class="list-card__name" contenteditable="true" spellcheck="false" data-list-name="${l.id}">${esc(l.name)}</span>
      <span class="list-card__meta">${items.length} Artikel${open ? ` · ${open} offen` : ""}</span>
      ${hist ? `<span class="list-card__hist">Zuletzt abgeschlossen: ${formatDate(hist.completed_at)}</span>` : `<span class="list-card__hist">Noch nicht abgeschlossen</span>`}
    </div>`;
  }).join("") || `<p class="section__desc">Noch keine Liste — leg unten eine an.</p>`;

  grid.querySelectorAll("[data-open-list]").forEach(card => {
    card.addEventListener("click", e => {
      if (e.target.closest("[data-del-list]") || e.target.closest("[data-list-name]")) return;
      openList(card.dataset.openList);
    });
  });
  grid.querySelectorAll("[data-list-name]").forEach(tag => {
    tag.addEventListener("click", e => e.stopPropagation());
    tag.addEventListener("blur", () => { const v = tag.textContent.trim(); if (v) mutRenameList(tag.dataset.listName, v); });
    tag.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); tag.blur(); } });
  });
  grid.querySelectorAll("[data-del-list]").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      if (confirm("Diese Liste inkl. Artikel wirklich löschen?")) mutDeleteList(btn.dataset.delList);
    });
  });
}

/* ==========================================================================
   LISTEN-DETAIL (eine Liste)
   ========================================================================== */
function renderListDetail() {
  const list = getList(activeListId);
  const titleEl = document.getElementById("listDetailTitle");
  const grid = document.getElementById("listGrid");
  const histBox = document.getElementById("historyBox");
  if (!list) { if (titleEl) titleEl.textContent = "—"; if (grid) grid.innerHTML = ""; return; }
  titleEl.textContent = list.name;

  const cats = catsOfList(activeListId);
  grid.innerHTML = cats.map(cat => {
    const items = itemsOfCat(cat.id);
    return `
    <div class="category-card-row" data-cat-row="${cat.id}">
      <div class="category-card reveal is-visible" data-cat="${cat.id}">
        <div class="category-card__head" data-cat-head="${cat.id}">
          <button type="button" class="cat-drag-handle" data-drag-handle aria-label="Verschieben">⠿</button>
          <span class="category-card__tag" contenteditable="true" spellcheck="false" data-cat-name="${cat.id}">${esc(cat.name)}</span>
          <button type="button" class="item-delete-btn category-delete-btn" data-delete-category="${cat.id}" aria-label="Kategorie löschen">×</button>
        </div>
        <ul>
          ${items.map(it => `
            <li class="item-row" data-row-id="${it.id}">
              <div class="item ${it.checked ? "is-checked" : ""}" data-id="${it.id}">
                <span class="check" data-check="${it.id}">${checkIconSVG()}</span>
                <span class="item__text" data-text="${it.id}">${esc(it.text)}</span>
                ${calBadge(it.calories)}
                <button type="button" class="item-icon-btn" data-edit="${it.id}" aria-label="Bearbeiten">✎</button>
                <button type="button" class="item-delete-btn" data-delete-shopping="${it.id}" aria-label="Löschen">×</button>
              </div>
            </li>`).join("")}
        </ul>
        <div class="add-row">
          <input type="text" placeholder="Artikel hinzufügen…" aria-label="Neuen Artikel hinzufügen" data-add="${cat.id}">
          <button type="button" data-add-btn="${cat.id}" aria-label="Hinzufügen">+</button>
        </div>
      </div>
    </div>`;
  }).join("") || `<p class="section__desc">Noch keine Kategorien — leg oben eine an.</p>`;

  // Abhaken (Klick auf Kreis)
  grid.querySelectorAll("[data-check]").forEach(el => {
    el.addEventListener("click", e => {
      e.stopPropagation();
      const id = el.dataset.check, it = state.shopping.find(i => String(i.id) === id); if (!it) return;
      it.checked = !it.checked; el.closest(".item").classList.toggle("is-checked", it.checked); mutToggleShopping(it.id, it.checked);
    });
  });
  // Bearbeiten
  grid.querySelectorAll("[data-edit]").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const id = btn.dataset.edit, span = grid.querySelector(`[data-text="${id}"]`); if (!span) return;
      span.setAttribute("contenteditable", "true"); span.focus();
      const r = document.createRange(); r.selectNodeContents(span); r.collapse(false);
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
      const save = () => { span.removeAttribute("contenteditable"); const v = span.textContent.trim(); if (v) mutUpdateShopping(id, v); span.removeEventListener("blur", save); };
      span.addEventListener("blur", save);
      span.addEventListener("keydown", ev => { if (ev.key === "Enter") { ev.preventDefault(); span.blur(); } });
    });
  });
  // Löschen (× + Swipe)
  grid.querySelectorAll("[data-delete-shopping]").forEach(btn => btn.addEventListener("click", e => { e.stopPropagation(); mutDeleteShopping(btn.dataset.deleteShopping); }));
  grid.querySelectorAll("[data-row-id]").forEach(row => makeSwipeToDelete(row, row.querySelector(".item"), () => mutDeleteShopping(row.dataset.rowId)));
  // Kategorie löschen / umbenennen
  grid.querySelectorAll("[data-delete-category]").forEach(btn => btn.addEventListener("click", e => { e.stopPropagation(); mutDeleteCategory(btn.dataset.deleteCategory); }));
  grid.querySelectorAll("[data-cat-name]").forEach(tag => {
    tag.addEventListener("blur", () => { const v = tag.textContent.trim(); if (v) mutRenameCategory(tag.dataset.catName, v); });
    tag.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); tag.blur(); } });
  });
  // Artikel hinzufügen
  grid.querySelectorAll("[data-add-btn]").forEach(btn => {
    const catId = btn.dataset.addBtn, input = grid.querySelector(`[data-add="${catId}"]`);
    const commit = () => { const v = input.value.trim(); if (!v) return; input.value = ""; mutAddShopping(catId, v, activeListId); };
    btn.addEventListener("click", commit);
    input.addEventListener("keydown", e => { if (e.key === "Enter") commit(); });
  });
  initCategoryDragSort(grid);

  // Historie
  const hist = historyFor(list.name, list.id);
  document.getElementById("copyFromLast").hidden = !hist.length;
  document.getElementById("toggleHistory").hidden = !hist.length;
  if (showHistory && hist.length) {
    histBox.hidden = false;
    histBox.innerHTML = `<p class="hist-title">Historie (letzte ${hist.length})</p>` + hist.map(h => {
      const n = itemsOfList(h.id).length;
      return `<div class="hist-row"><span>Abgeschlossen ${formatDate(h.completed_at)} · ${n} Artikel</span><button type="button" class="btn btn--outline btn--small" data-copy-hist="${h.id}">Übernehmen</button></div>`;
    }).join("");
    histBox.querySelectorAll("[data-copy-hist]").forEach(b => b.addEventListener("click", () => mutCopyFromList(b.dataset.copyHist, activeListId)));
  } else { histBox.hidden = true; histBox.innerHTML = ""; }
}

/* ==========================================================================
   BACKLOG
   ========================================================================== */
function renderBacklog() {
  const grid = document.getElementById("pantryGrid");
  grid.innerHTML = state.backlog.map(it => `
    <div class="item-row" data-row-id="${it.id}">
      <div class="item ${it.checked ? "is-checked" : ""}" data-id="${it.id}">
        <span class="check" data-bcheck="${it.id}">${checkIconSVG()}</span>
        <span class="item__text">${esc(it.text)}${it.quantity ? ` <small>(${esc(it.quantity)})</small>` : ""}</span>
        ${calBadge(it.calories)}
        <button type="button" class="item-delete-btn" data-delete-pantry="${it.id}" aria-label="Löschen">×</button>
      </div>
    </div>`).join("");
  const total = state.backlog.reduce((s, it) => s + (it.calories || 0), 0);
  document.getElementById("backlogTotal").textContent = state.backlog.length ? `${state.backlog.length} Artikel · ${total} kcal gesamt` : "Backlog ist leer.";
  grid.querySelectorAll("[data-bcheck]").forEach(el => el.addEventListener("click", () => {
    const it = state.backlog.find(i => String(i.id) === el.dataset.bcheck); if (!it) return;
    it.checked = !it.checked; el.closest(".item").classList.toggle("is-checked", it.checked); mutToggleBacklog(it.id, it.checked);
  }));
  grid.querySelectorAll("[data-delete-pantry]").forEach(btn => btn.addEventListener("click", e => { e.stopPropagation(); mutDeleteBacklog(btn.dataset.deletePantry); }));
  grid.querySelectorAll("[data-row-id]").forEach(row => makeSwipeToDelete(row, row.querySelector(".item"), () => mutDeleteBacklog(row.dataset.rowId)));
}

/* ==========================================================================
   KALENDER
   ========================================================================== */
function recipeAddSelect(iso) {
  if (!state.recipes.length) return "";
  return `<select data-add-recipe="${iso}" aria-label="Rezept hinzufügen"><option value="">+ Rezept…</option>${state.recipes.map(r => `<option value="${r.id}">${esc(r.title)}</option>`).join("")}</select>`;
}
function shortTitle(s) {
  // Titel nur bis zum ersten Sonderzeichen / Emoji / Satzende verwenden
  const raw = (s || "").replace(/\r/g, "");
  let out = "";
  for (const ch of raw) {
    if ("!?.,:;#|/\n\t".indexOf(ch) !== -1) break;
    if (ch.codePointAt(0) >= 0x2190) break; // Pfeile, Symbole, Emojis
    out += ch;
  }
  out = out.trim();
  if (!out) out = raw.split("\n")[0].trim();
  if (out.length > 60) out = out.slice(0, 60).trim() + "…";
  return out || "Rezept";
}
function dayEntriesHTML(iso) {
  return calEntriesOn(iso).map(e => `
    <span class="cal-chip ${e.id === expandedCal ? "is-open" : ""}">
      <button type="button" class="cal-chip__label" data-cal-toggle="${e.id}">${esc(shortTitle(e.meal))}</button>
      <button type="button" class="cal-chip__x" data-del-cal="${e.id}" aria-label="Entfernen">×</button>
    </span>`).join("");
}
function calDetailHTML(iso) {
  const e = calEntriesOn(iso).find(x => x.id === expandedCal);
  if (!e) return "";
  const r = e.recipe_id ? state.recipes.find(x => x.id === e.recipe_id) : null;
  const total = r ? ((r.ingredients || []).reduce((s, ing) => s + (ing.calories || 0), 0) || r.calories || 0) : 0;
  return `
    <div class="cal-detail">
      <p class="cal-detail__title">${esc(e.meal)}</p>
      ${r && r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener" class="day-card__link">Rezept öffnen ↗</a>` : ""}
      ${(r && r.ingredients && r.ingredients.length) ? `<ul class="recipe-ings">${r.ingredients.map(ing => `<li><span>${esc(ing.text)}</span>${ing.calories ? `<span class="item__calories">${ing.calories} kcal</span>` : ""}</li>`).join("")}</ul>` : `<p class="recipe-noings">Keine Zutaten hinterlegt.</p>`}
      ${total ? `<p class="recipe-total-calories">Gesamt: ${total} kcal</p>` : ""}
    </div>`;
}
function dayRowHTML(iso) {
  const d = new Date(iso + "T00:00:00");
  return `
    <div class="cal-day-row ${iso === todayISO() ? "is-today" : ""}">
      <div class="cal-day-row__date"><span class="cal-dow">${d.toLocaleDateString("de-DE", { weekday: "short" })}</span><span class="cal-dom">${d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" })}</span></div>
      <div class="cal-day-row__body">
        <div class="cal-chips">${dayEntriesHTML(iso) || `<span class="cal-empty">—</span>`}</div>
        ${calDetailHTML(iso)}
        ${recipeAddSelect(iso)}
      </div>
    </div>`;
}
function wireCalBody(container) {
  container.querySelectorAll("[data-add-recipe]").forEach(sel => sel.addEventListener("change", () => {
    if (sel.value === "") return;
    const r = state.recipes.find(x => String(x.id) === sel.value);
    if (r) mutAddCalendarEntry(sel.dataset.addRecipe, r.id, r.title);
  }));
  container.querySelectorAll("[data-del-cal]").forEach(b => b.addEventListener("click", () => mutDeleteCalendarEntry(b.dataset.delCal)));
  container.querySelectorAll("[data-cal-toggle]").forEach(b => b.addEventListener("click", () => { expandedCal = expandedCal === b.dataset.calToggle ? null : b.dataset.calToggle; renderCalendar(); }));
}
function renderCalWeek(body, title) {
  const start = mondayOfISO(calAnchor);
  const days = Array.from({ length: 7 }, (_, i) => addDaysISO(start, i));
  const s = new Date(start + "T00:00:00"), e = new Date(addDaysISO(start, 6) + "T00:00:00");
  title.textContent = `${s.toLocaleDateString("de-DE", { day: "2-digit", month: "short" })} – ${e.toLocaleDateString("de-DE", { day: "2-digit", month: "short", year: "numeric" })}`;
  body.className = "cal-body cal-week"; body.innerHTML = days.map(dayRowHTML).join(""); wireCalBody(body);
}
function renderCalDay(body, title) {
  title.textContent = new Date(calAnchor + "T00:00:00").toLocaleDateString("de-DE", { weekday: "long", day: "2-digit", month: "long", year: "numeric" });
  body.className = "cal-body cal-day"; body.innerHTML = dayRowHTML(calAnchor); wireCalBody(body);
}
function renderCalMonth(body, title) {
  const fom = firstOfMonthISO(calAnchor), gridStart = mondayOfISO(fom), anchorMonth = new Date(fom + "T00:00:00").getMonth();
  title.textContent = new Date(fom + "T00:00:00").toLocaleDateString("de-DE", { month: "long", year: "numeric" });
  body.className = "cal-body cal-month";
  let html = `<div class="cal-month__head">${["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"].map(x => `<span>${x}</span>`).join("")}</div><div class="cal-month__grid">`;
  for (let i = 0; i < 42; i++) {
    const iso = addDaysISO(gridStart, i), dd = new Date(iso + "T00:00:00"), meals = calEntriesOn(iso);
    html += `<button type="button" class="cal-cell ${dd.getMonth() === anchorMonth ? "" : "is-out"} ${iso === todayISO() ? "is-today" : ""}" data-cal-day="${iso}">
      <span class="cal-cell__num">${dd.getDate()}</span>${meals.slice(0, 3).map(m => `<span class="cal-cell__meal">${esc(shortTitle(m.meal))}</span>`).join("")}</button>`;
  }
  html += `</div>`; body.innerHTML = html;
  body.querySelectorAll("[data-cal-day]").forEach(c => c.addEventListener("click", () => { calAnchor = c.dataset.calDay; calView = "day"; renderCalendar(); }));
}
function renderCalendar() {
  const body = document.getElementById("calBody"), title = document.getElementById("calTitle");
  if (!body || !title) return;
  document.querySelectorAll("[data-cal-view]").forEach(b => b.classList.toggle("is-active", b.dataset.calView === calView));
  if (calView === "day") renderCalDay(body, title);
  else if (calView === "month") renderCalMonth(body, title);
  else renderCalWeek(body, title);
}
function shiftAnchor(dir) { if (calView === "day") return addDaysISO(calAnchor, dir); if (calView === "month") return shiftMonthISO(calAnchor, dir); return addDaysISO(calAnchor, dir * 7); }
document.getElementById("calPrev").addEventListener("click", () => { calAnchor = shiftAnchor(-1); renderCalendar(); });
document.getElementById("calNext").addEventListener("click", () => { calAnchor = shiftAnchor(1); renderCalendar(); });
document.getElementById("calToday").addEventListener("click", () => { calAnchor = todayISO(); renderCalendar(); });
document.querySelectorAll("[data-cal-view]").forEach(b => b.addEventListener("click", () => { calView = b.dataset.calView; renderCalendar(); }));

/* ---------- Rezept-Galerie (aufklappbar) ---------- */
function renderRecipeGallery() {
  const wrap = document.getElementById("recipeGallery");
  if (!state.recipes.length) { wrap.innerHTML = ""; wrap.hidden = true; return; }
  wrap.hidden = false;
  wrap.innerHTML = state.recipes.map(r => {
    const open = expandedRecipe === r.id;
    const total = (r.ingredients || []).reduce((s, ing) => s + (ing.calories || 0), 0) || r.calories || 0;
    return `
    <div class="recipe-card ${open ? "is-open" : ""}" data-id="${r.id}">
      <button type="button" class="recipe-card__toggle" data-toggle-recipe="${r.id}">
        ${r.thumbnail ? `<img src="${esc(r.thumbnail)}" alt="" class="recipe-card__thumb">` : `<div class="recipe-card__thumb recipe-card__thumb--placeholder">${platformLabel(r.platform)}</div>`}
        <span class="recipe-card__title">${esc(shortTitle(r.title))}</span>
      </button>
      ${open ? `
        <div class="recipe-card__detail">
          <span class="platform-tag">${platformLabel(r.platform)}</span>
          ${r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener" class="day-card__link">Rezept öffnen ↗</a>` : ""}
          ${(r.ingredients && r.ingredients.length) ? `<ul class="recipe-ings">${r.ingredients.map(ing => `<li><span>${esc(ing.text)}</span>${ing.calories ? `<span class="item__calories">${ing.calories} kcal</span>` : ""}</li>`).join("")}</ul>` : `<p class="recipe-noings">Keine Zutaten hinterlegt.</p>`}
          ${total ? `<p class="recipe-total-calories">Gesamt: ${total} kcal</p>` : ""}
          <button type="button" class="recipe-card__remove" data-delete-recipe="${r.id}">Rezept entfernen</button>
        </div>` : ""}
    </div>`;
  }).join("");
  wrap.querySelectorAll("[data-toggle-recipe]").forEach(b => b.addEventListener("click", () => { expandedRecipe = expandedRecipe === b.dataset.toggleRecipe ? null : b.dataset.toggleRecipe; renderRecipeGallery(); }));
  wrap.querySelectorAll("[data-delete-recipe]").forEach(b => b.addEventListener("click", () => mutDeleteRecipe(b.dataset.deleteRecipe)));
}

function renderAll() {
  renderDashboardTiles();
  renderListsOverview();
  renderListDetail();
  renderBacklog();
  renderCalendar();
  renderRecipeGallery();
}
function renderSyncBadge(ok) {
  const b = document.getElementById("syncBadge");
  if (REMOTE && ok) { b.textContent = "● Live-Sync aktiv"; b.classList.add("is-live"); }
  else if (REMOTE && !ok) { b.textContent = "○ Sync-Fehler — lokal"; b.classList.remove("is-live"); }
  else { b.textContent = "○ Lokal (nur dieses Gerät)"; b.classList.remove("is-live"); }
}

/* ==========================================================================
   AKTIONEN: neue Liste, Kategorie, Liste abschließen, Übernehmen, Historie
   ========================================================================== */
(function initListActions() {
  const nl = document.getElementById("newListInput"), nlb = document.getElementById("addListBtn");
  const commitL = () => { const v = nl.value.trim(); if (!v) return; nl.value = ""; mutAddList(v); };
  nlb.addEventListener("click", commitL);
  nl.addEventListener("keydown", e => { if (e.key === "Enter") commitL(); });

  const nc = document.getElementById("newCategoryInput"), ncb = document.getElementById("addCategoryBtn");
  const commitC = () => { const v = nc.value.trim(); if (!v || !activeListId) return; nc.value = ""; mutAddCategory(v, activeListId); };
  ncb.addEventListener("click", commitC);
  nc.addEventListener("keydown", e => { if (e.key === "Enter") commitC(); });

  document.getElementById("completeList").addEventListener("click", () => {
    if (activeListId && confirm("Liste abschließen? Sie wird mit heutigem Datum archiviert und eine frische Liste startet.")) mutCompleteList(activeListId);
  });
  document.getElementById("copyFromLast").addEventListener("click", () => {
    const list = getList(activeListId); if (!list) return;
    const h = historyFor(list.name, list.id)[0];
    if (h) mutCopyFromList(h.id, activeListId);
  });
  document.getElementById("toggleHistory").addEventListener("click", () => { showHistory = !showHistory; renderListDetail(); });
})();

/* ==========================================================================
   MODAL: REZEPT IMPORTIEREN (ohne Zutaten-Übernahme in die Liste)
   ========================================================================== */
const importModal = document.getElementById("importModal");
const receiptModal = document.getElementById("receiptModal");
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
  else throw new Error("unsupported");
  const res = await fetch(endpoint); if (!res.ok) throw new Error("failed"); return res.json();
}
function populateImportDays() {
  const days = Array.from({ length: 14 }, (_, i) => addDaysISO(todayISO(), i));
  document.getElementById("importDay").innerHTML = `<option value="">— keinem Tag —</option>` + days.map(d => `<option value="${d}">${esc(formatDayLabel(d))}</option>`).join("");
}
function resetImportForm() {
  currentImport = null;
  ["importUrl", "importIngredients", "previewTitle"].forEach(id => document.getElementById(id).value = "");
  document.getElementById("platformNote").textContent = "";
  document.getElementById("importPreview").hidden = true;
  document.getElementById("caloriesNote").textContent = "";
  document.getElementById("ingredientCalories").innerHTML = "";
  document.getElementById("recipeTotalCalories").hidden = true;
}
document.getElementById("openImportModal").addEventListener("click", () => { populateImportDays(); resetImportForm(); openModal(importModal); });
document.getElementById("closeImportModal").addEventListener("click", () => closeModal(importModal));
importModal.addEventListener("click", e => { if (e.target === importModal) closeModal(importModal); });

document.getElementById("loadPreview").addEventListener("click", async () => {
  const url = document.getElementById("importUrl").value.trim();
  const note = document.getElementById("platformNote"), preview = document.getElementById("importPreview");
  if (!url) { note.textContent = "Bitte zuerst einen Link einfügen."; return; }
  const platform = detectPlatform(url);
  if (platform === "instagram" || platform === "sonstige") {
    note.textContent = platform === "instagram" ? "Instagram erlaubt keine automatische Vorschau — Titel bitte manuell." : "Unbekannte Plattform — Titel bitte manuell.";
    preview.hidden = true; currentImport = { platform, url, thumbnail: "" }; return;
  }
  note.textContent = "Lade Vorschau…";
  try {
    const data = await fetchOEmbed(url, platform);
    document.getElementById("previewThumb").src = data.thumbnail_url || "";
    document.getElementById("previewTitle").value = data.title || "";
    document.getElementById("previewPlatform").textContent = platformLabel(platform);
    preview.hidden = false; note.textContent = "Vorschau geladen.";
    currentImport = { platform, url, thumbnail: data.thumbnail_url || "" };
  } catch (err) { note.textContent = "Vorschau nicht ladbar — Titel bitte manuell."; preview.hidden = true; currentImport = { platform, url, thumbnail: "" }; }
});

let lastEstimatedCalories = null;
document.getElementById("estimateCaloriesBtn").addEventListener("click", async () => {
  const note = document.getElementById("caloriesNote");
  const lines = document.getElementById("importIngredients").value.split("\n").map(s => s.trim()).filter(Boolean);
  if (!lines.length) { note.textContent = "Bitte zuerst Zutaten eintragen."; return; }
  if (!FUNCTIONS_BASE) { note.textContent = "Braucht eine Supabase-Verbindung."; return; }
  note.textContent = "Schätze Kalorien…";
  try {
    const result = await callEstimateCalories(lines);
    lastEstimatedCalories = result.items || [];
    document.getElementById("ingredientCalories").innerHTML = lastEstimatedCalories.map(it => `<div class="ingredient-calories__row"><span>${esc(it.text)}</span><span>${it.calories ?? "–"} kcal</span></div>`).join("");
    const totalEl = document.getElementById("recipeTotalCalories");
    totalEl.textContent = `Gesamt: ${result.total ?? 0} kcal`; totalEl.hidden = false;
    note.textContent = "Kalorien geschätzt.";
  } catch (e) { note.textContent = "Fehlgeschlagen — prüfe ANTHROPIC_API_KEY in Supabase."; console.warn(e); }
});

document.getElementById("saveImport").addEventListener("click", async () => {
  const url = document.getElementById("importUrl").value.trim();
  const title = document.getElementById("previewTitle").value.trim() || "Importiertes Rezept";
  const rawLines = document.getElementById("importIngredients").value.split("\n").map(s => s.trim()).filter(Boolean);
  const planDate = document.getElementById("importDay").value;
  if (!url) { document.getElementById("platformNote").textContent = "Ohne Link kein Rezept."; return; }
  const ingredients = rawLines.map(text => {
    const m = lastEstimatedCalories && lastEstimatedCalories.find(i => i.text === text);
    return { text, calories: m ? m.calories : null };
  });
  const totalCalories = ingredients.reduce((s, i) => s + (i.calories || 0), 0) || null;
  const platform = (currentImport && currentImport.platform) || detectPlatform(url);
  const thumbnail = (currentImport && currentImport.thumbnail) || "";
  try {
    await mutAddRecipe({ title, url, platform, thumbnail, calories: totalCalories }, ingredients, planDate || null);
    lastEstimatedCalories = null; closeModal(importModal);
  } catch (e) { document.getElementById("platformNote").textContent = "Speichern fehlgeschlagen."; console.warn(e); }
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
  const file = e.target.files[0], note = document.getElementById("receiptNote");
  if (!file) return;
  if (!FUNCTIONS_BASE) { note.textContent = "Braucht eine Supabase-Verbindung."; return; }
  note.textContent = "Lese Kassenzettel…";
  try {
    const base64 = await fileToBase64(file);
    const result = await callScanReceipt(base64, file.type || "image/jpeg");
    currentReceiptItems = (result.items || []).map(it => ({ text: it.text, quantity: it.quantity || "", calories: it.calories ?? null }));
    renderReceiptResults();
    note.textContent = currentReceiptItems.length ? "Zutaten erkannt — vor dem Speichern prüfen." : "Keine Artikel erkannt.";
    document.getElementById("saveReceiptItems").hidden = !currentReceiptItems.length;
  } catch (err) { note.textContent = "Scan fehlgeschlagen — prüfe ANTHROPIC_API_KEY in Supabase."; console.warn(err); }
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
    row.querySelectorAll("input").forEach(input => input.addEventListener("change", () => {
      const f = input.dataset.field;
      currentReceiptItems[idx][f] = f === "calories" ? (input.value === "" ? null : +input.value) : input.value;
    }));
  });
}
document.getElementById("saveReceiptItems").addEventListener("click", async () => {
  if (!currentReceiptItems || !currentReceiptItems.length) return;
  for (const it of currentReceiptItems) { if (!it.text.trim()) continue; await mutAddBacklog(it.text.trim(), it.calories, it.quantity, "receipt"); }
  currentReceiptItems = null; closeModal(receiptModal);
});

/* ---------- Backlog: manuell hinzufügen ---------- */
(function initPantryAdd() {
  const input = document.getElementById("pantryInput");
  const commit = () => { const v = input.value.trim(); if (!v) return; input.value = ""; mutAddBacklog(v, null, "", "manual"); };
  document.getElementById("pantryAddBtn").addEventListener("click", commit);
  input.addEventListener("keydown", e => { if (e.key === "Enter") commit(); });
})();

/* ==========================================================================
   SCROLL-EFFEKTE
   ========================================================================== */
function initScrollFX() {
  const bar = document.getElementById("scrollBar");
  const prefersReduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let ticking = false;
  function apply() {
    ticking = false;
    const max = document.documentElement.scrollHeight - innerHeight;
    if (bar) bar.style.width = (max > 0 ? (window.scrollY / max) * 100 : 0) + "%";
    if (!prefersReduced) { const a = document.querySelector(".view.is-active .bg"); if (a) a.style.transform = `translate3d(0, ${(window.scrollY * 0.12).toFixed(1)}px, 0)`; }
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
  ensureActiveList();
  renderAll();
  openView("dashboard");
  initScrollFX();
}
document.addEventListener("DOMContentLoaded", init);
