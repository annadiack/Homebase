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

/* Liste als Textdatei herunterladen (reiner Export, ändert nichts an der DB) */
function exportListText(listId) {
  const list = getList(listId); if (!list) return "";
  let out = list.name + " — " + new Date().toLocaleDateString("de-DE") + "\n" + "=".repeat(24) + "\n\n";
  catsOfList(listId).forEach(cat => {
    const items = itemsOfCat(cat.id);
    if (!items.length) return;
    out += cat.name.toUpperCase() + "\n";
    items.slice().sort((a, b) => (b.flagged ? 1 : 0) - (a.flagged ? 1 : 0)).forEach(it => {
      out += "  [" + (it.checked ? "x" : " ") + "] " + (it.flagged ? "! " : "") + it.text + (it.calories ? " (" + it.calories + " kcal)" : "") + "\n";
    });
    out += "\n";
  });
  return out;
}
function downloadText(filename, text) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

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

let state = { lists: [], categories: [], shopping: [], backlog: [], calendar: [], recipes: [], notes: [], locations: [] };
let noteQuery = "";
let expandedNote = null;
let currentImport = null;
let currentReceiptItems = null;
let activeListId = null;
let showHistory = false;
let expandedRecipe = null;
let importMsg = {};

/* Kalender-UI */
let calView = "week";
let calAnchor = todayISO();
let expandedCal = null;

/* View-Navigation (Eltern für Zurück-Button) */
const VIEW_PARENT = { lists: "dashboard", listdetail: "lists", calendar: "dashboard", backlog: "dashboard", notes: "dashboard", guide: "dashboard", prospekte: "dashboard", standort: "dashboard" };
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
  ["lists", "categories", "shopping", "backlog", "calendar", "recipes", "notes"].forEach(k => { if (!state[k]) state[k] = []; });
}
function localSave() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }

/* ---------- Supabase-Modus ---------- */
async function remoteFetchAll() {
  const [lists, cats, shop, backlog, cal, recipes, notes, locations] = await Promise.all([
    sb.from("shopping_lists").select("*").order("sort_order"),
    sb.from("categories").select("*").order("sort_order"),
    sb.from("shopping_items").select("*").order("created_at"),
    sb.from("backlog_items").select("*").order("created_at"),
    sb.from("calendar_entries").select("*").order("plan_date"),
    sb.from("recipes").select("*").order("created_at"),
    sb.from("notes").select("*").order("updated_at", { ascending: false }),
    sb.from("locations").select("*"),
  ]);
  const err = lists.error || cats.error || shop.error || backlog.error || cal.error || recipes.error || notes.error || locations.error;
  if (err) throw err;
  state.locations = locations.data || [];
  state.lists = lists.data || [];
  state.categories = cats.data || [];
  state.shopping = shop.data || [];
  state.backlog = backlog.data || [];
  state.calendar = cal.data || [];
  state.recipes = (recipes.data || []).map(r => ({ ...r, ingredients: r.ingredients || [] }));
  state.notes = notes.data || [];
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
/* ---- Mengen zusammenfassen: 400g + 200g Tomaten = 600g Tomaten ---- */
const MERGE_UNITS = {
  g:["g",1], gr:["g",1], gramm:["g",1], kg:["g",1000], kilo:["g",1000],
  ml:["ml",1], cl:["ml",10], dl:["ml",100], l:["ml",1000], liter:["ml",1000],
  el:["el",1], tl:["tl",1], stk:["stk",1], "stück":["stk",1], stueck:["stk",1],
  dose:["dose",1], dosen:["dose",1], packung:["pack",1], packungen:["pack",1],
  pck:["pack",1], pkg:["pack",1], bund:["bund",1], prise:["prise",1], zehe:["zehe",1], zehen:["zehe",1]
};
function mNum(s) { return parseFloat(String(s).replace(",", ".")); }
function mFmt(n) { const r = Math.round(n * 100) / 100; return String(r).replace(".", ","); }
function mUnitKey(u) { return String(u || "").toLowerCase().replace(/\.$/, ""); }
function mKeyName(n) {
  let s = String(n || "").toLowerCase().trim().replace(/[^a-zäöüß\s]/g, "").replace(/\s+/g, " ").trim();
  if (s.length > 4) { if (s.endsWith("en")) s = s.slice(0, -2); else if (s.endsWith("n") || s.endsWith("s") || s.endsWith("e")) s = s.slice(0, -1); }
  return s;
}
function parseItemText(raw) {
  const s = String(raw || "").trim();
  let m = s.match(/^(\d+(?:[.,]\d+)?)\s*[x×]\s*(.+)$/i);
  if (m) return { qty: mNum(m[1]), unit: null, name: m[2].trim() };
  m = s.match(/^(\d+(?:[.,]\d+)?)\s*([a-zA-ZäöüÄÖÜß]+\.?)\s+(.+)$/);
  if (m && MERGE_UNITS[mUnitKey(m[2])]) return { qty: mNum(m[1]), unit: mUnitKey(m[2]), unitRaw: m[2].replace(/\.$/, ""), name: m[3].trim() };
  m = s.match(/^(.+?)\s+(\d+(?:[.,]\d+)?)\s*([a-zA-ZäöüÄÖÜß]+\.?)$/);
  if (m && MERGE_UNITS[mUnitKey(m[3])]) return { qty: mNum(m[2]), unit: mUnitKey(m[3]), unitRaw: m[3].replace(/\.$/, ""), name: m[1].trim() };
  m = s.match(/^(\d+(?:[.,]\d+)?)\s+(.+)$/);
  if (m) return { qty: mNum(m[1]), unit: null, name: m[2].trim() };
  return { qty: 1, unit: null, name: s };
}
function mergedText(a, b) {
  if (!a.name || mKeyName(a.name) !== mKeyName(b.name)) return null;
  if (!a.unit && !b.unit) {
    const t = a.qty + b.qty;
    return t > 1 ? mFmt(t) + "× " + a.name : a.name;
  }
  if (a.unit && b.unit) {
    const ua = MERGE_UNITS[a.unit], ub = MERGE_UNITS[b.unit];
    if (!ua || !ub || ua[0] !== ub[0]) return null;
    const base = a.qty * ua[1] + b.qty * ub[1];
    let unit = a.unitRaw || a.unit, total = base / ua[1];
    if (ua[0] === "g" && base >= 1000) { unit = "kg"; total = base / 1000; }
    else if (ua[0] === "g") { unit = "g"; total = base; }
    else if (ua[0] === "ml" && base >= 1000) { unit = "l"; total = base / 1000; }
    else if (ua[0] === "ml") { unit = "ml"; total = base; }
    return mFmt(total) + " " + unit + " " + a.name;
  }
  return null;
}
function findMergeTarget(text, listId) {
  const incoming = parseItemText(text);
  const items = itemsOfList(listId).filter(i => !i.checked);
  for (const it of items) {
    const merged = mergedText(parseItemText(it.text), incoming);
    if (merged) return { id: it.id, text: merged };
  }
  return null;
}
async function mutAddShopping(category, text, listId) {
  const hit = findMergeTarget(text, listId);
  if (hit) { await mutUpdateShopping(hit.id, hit.text); return; }
  if (REMOTE) { await sb.from("shopping_items").insert({ category, text, list_id: listId, calories: null }); await remoteFetchAll(); }
  else { state.shopping.push({ id: uid("s"), category, text, list_id: listId, calories: null, checked: false }); localSave(); }
  renderAll();
}
async function mutToggleShopping(id, checked) {
  if (REMOTE) { await sb.from("shopping_items").update({ checked }).eq("id", id); }
  else { const it = state.shopping.find(i => i.id === id); if (it) it.checked = checked; localSave(); }
}
async function mutToggleFlag(id, flagged) {
  if (REMOTE) { await sb.from("shopping_items").update({ flagged }).eq("id", id); }
  else { const it = state.shopping.find(i => i.id === id); if (it) it.flagged = flagged; localSave(); }
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
async function mutSetRecipeIngredients(id, ingredients) {
  const total = ingredients.reduce((s, i) => s + (i.calories || 0), 0) || null;
  if (REMOTE) { await sb.from("recipes").update({ ingredients, calories: total }).eq("id", id); await remoteFetchAll(); }
  else { const r = state.recipes.find(x => x.id === id); if (r) { r.ingredients = ingredients; r.calories = total; } localSave(); }
  renderAll();
}
async function mutDeleteRecipe(id) {
  if (REMOTE) { await sb.from("calendar_entries").delete().eq("recipe_id", id); await sb.from("recipes").delete().eq("id", id); await remoteFetchAll(); }
  else { state.recipes = state.recipes.filter(r => r.id !== id); state.calendar = state.calendar.filter(e => e.recipe_id !== id); localSave(); }
  renderAll();
}

/* ---------- Mutationen: Notizen ---------- */
async function mutAddNote() {
  if (REMOTE) {
    const { data, error } = await sb.from("notes").insert({ title: "", body: "" }).select().single();
    if (error) throw error;
    expandedNote = data.id;
    await remoteFetchAll();
  } else {
    const id = uid("n");
    state.notes.unshift({ id, title: "", body: "", updated_at: new Date().toISOString() });
    expandedNote = id; localSave();
  }
  renderNotes();
}
async function mutUpdateNote(id, title, body) {
  if (REMOTE) { await sb.from("notes").update({ title, body, updated_at: new Date().toISOString() }).eq("id", id); await remoteFetchAll(); }
  else { const n = state.notes.find(x => x.id === id); if (n) { n.title = title; n.body = body; n.updated_at = new Date().toISOString(); } localSave(); }
  renderNotes();
}
async function mutDeleteNote(id) {
  if (REMOTE) { await sb.from("notes").delete().eq("id", id); await remoteFetchAll(); }
  else { state.notes = state.notes.filter(n => n.id !== id); localSave(); }
  if (expandedNote === id) expandedNote = null;
  renderNotes();
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
async function callExtractIngredients(text) {
  const res = await fetch(`${FUNCTIONS_BASE}/extract-ingredients`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "apikey": cfg.SUPABASE_ANON_KEY, "Authorization": `Bearer ${cfg.SUPABASE_ANON_KEY}` },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error("extract-ingredients " + res.status);
  return res.json();
}
async function callSortItem(text, categories) {
  const res = await fetch(`${FUNCTIONS_BASE}/sort-item`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "apikey": cfg.SUPABASE_ANON_KEY, "Authorization": `Bearer ${cfg.SUPABASE_ANON_KEY}` },
    body: JSON.stringify({ text, categories }),
  });
  if (!res.ok) throw new Error("sort-item " + res.status);
  return res.json();
}
async function callSuggestRecipes(ingredients) {
  const res = await fetch(`${FUNCTIONS_BASE}/suggest-recipes`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "apikey": cfg.SUPABASE_ANON_KEY, "Authorization": `Bearer ${cfg.SUPABASE_ANON_KEY}` },
    body: JSON.stringify({ ingredients }),
  });
  if (!res.ok) throw new Error("suggest-recipes " + res.status);
  return res.json();
}
async function callSortItems(items, categories) {
  const res = await fetch(`${FUNCTIONS_BASE}/sort-items`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "apikey": cfg.SUPABASE_ANON_KEY, "Authorization": `Bearer ${cfg.SUPABASE_ANON_KEY}` },
    body: JSON.stringify({ items, categories }),
  });
  if (!res.ok) throw new Error("sort-items " + res.status);
  return res.json();
}
/* Rezept-Zutaten (sortiert) in eine gewählte Liste übernehmen */
async function mutImportToList(listId, ingredients, assignments) {
  const norm = s => (s || "").trim().toLowerCase();
  const catByName = {};
  catsOfList(listId).forEach(c => { catByName[norm(c.name)] = c; });
  let order = catsOfList(listId).reduce((m, c) => Math.max(m, c.sort_order || 0), 0);
  const assignFor = t => { const a = assignments.find(x => norm(x.text) === norm(t)); return a && a.category ? a.category.trim() : "Sonstiges"; };

  if (REMOTE) {
    const newCats = [];
    ingredients.forEach(ing => {
      const name = assignFor(ing.text);
      if (!catByName[norm(name)] && !newCats.find(c => norm(c.name) === norm(name))) {
        const c = { id: uid("cat_"), list_id: listId, name, sort_order: ++order };
        newCats.push(c); catByName[norm(name)] = c;
      }
    });
    if (newCats.length) await sb.from("categories").insert(newCats);
    const rows = ingredients.map(ing => {
      const cat = catByName[norm(assignFor(ing.text))];
      return cat ? { list_id: listId, category: cat.id, text: ing.text, calories: ing.calories ?? null } : null;
    }).filter(Boolean);
    if (rows.length) await sb.from("shopping_items").insert(rows);
    await remoteFetchAll();
  } else {
    ingredients.forEach(ing => {
      const name = assignFor(ing.text);
      let cat = catByName[norm(name)];
      if (!cat) { cat = { id: uid("cat_"), list_id: listId, name, sort_order: ++order }; state.categories.push(cat); catByName[norm(name)] = cat; }
      state.shopping.push({ id: uid("s"), list_id: listId, category: cat.id, text: ing.text, calories: ing.calories ?? null, checked: false });
    });
    localSave();
  }
  renderAll();
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
  if (name === "standort" && typeof initMap === "function") setTimeout(initMap, 80);
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
  document.getElementById("tileCalendarMeta").textContent = upcoming ? `${formatDayLabel(upcoming.plan_date)}: ${shortTitle(upcoming.meal)}` : "Noch nichts geplant";
  document.getElementById("tileBacklogMeta").textContent = state.backlog.length ? `${state.backlog.length} Artikel` : "Leer";
  const nt = document.getElementById("tileNotesMeta");
  if (nt) nt.textContent = state.notes.length ? `${state.notes.length} Notiz${state.notes.length > 1 ? "en" : ""}` : "Leer";
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
      <div class="list-card__actions">
        <button type="button" class="item-icon-btn" data-edit-list="${l.id}" aria-label="Umbenennen">✎</button>
        <button type="button" class="item-delete-btn" data-del-list="${l.id}" aria-label="Liste löschen">×</button>
      </div>
      <span class="list-card__icon">🛒</span>
      <span class="list-card__name" spellcheck="false" data-list-name="${l.id}">${esc(l.name)}</span>
      <span class="list-card__meta">${items.length} Artikel${open ? ` · ${open} offen` : ""}</span>
      ${hist ? `<span class="list-card__hist">Zuletzt abgeschlossen: ${formatDate(hist.completed_at)}</span>` : `<span class="list-card__hist">Noch nicht abgeschlossen</span>`}
    </div>`;
  }).join("") || `<p class="section__desc">Noch keine Liste — leg unten eine an.</p>`;

  grid.querySelectorAll("[data-open-list]").forEach(card => {
    card.addEventListener("click", e => {
      if (e.target.closest("[data-edit-list]") || e.target.closest("[data-del-list]") || e.target.isContentEditable) return;
      openList(card.dataset.openList);
    });
  });
  grid.querySelectorAll("[data-edit-list]").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const id = btn.dataset.editList, span = grid.querySelector(`[data-list-name="${id}"]`); if (!span) return;
      span.setAttribute("contenteditable", "true"); span.focus();
      const r = document.createRange(); r.selectNodeContents(span); r.collapse(false);
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
      const save = () => { span.removeAttribute("contenteditable"); const v = span.textContent.trim(); if (v) mutRenameList(id, v); span.removeEventListener("blur", save); };
      span.addEventListener("blur", save);
      span.addEventListener("keydown", ev => { if (ev.key === "Enter") { ev.preventDefault(); span.blur(); } });
    });
  });
  grid.querySelectorAll("[data-del-list]").forEach(btn => {
    btn.addEventListener("click", e => { e.stopPropagation(); if (confirm("Diese Liste inkl. Artikel wirklich löschen?")) mutDeleteList(btn.dataset.delList); });
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
              <div class="item ${it.checked ? "is-checked" : ""} ${it.flagged ? "is-flagged" : ""}" data-id="${it.id}">
                <span class="check" data-check="${it.id}">${checkIconSVG()}</span>
                <span class="item__text" data-text="${it.id}">${esc(it.text)}</span>
                ${calBadge(it.calories)}
                <button type="button" class="item-icon-btn item-flag ${it.flagged ? "is-on" : ""}" data-flag="${it.id}" aria-label="Zum Prüfen markieren" title="Zum Prüfen markieren – zuhause nachschauen, ob neue nötig">${it.flagged ? "⚑" : "⚐"}</button>
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
  // Löschen (nur × — kein Wischen mehr)
  grid.querySelectorAll("[data-delete-shopping]").forEach(btn => btn.addEventListener("click", e => { e.stopPropagation(); mutDeleteShopping(btn.dataset.deleteShopping); }));
  // Flagge (wichtig markieren)
  grid.querySelectorAll("[data-flag]").forEach(btn => btn.addEventListener("click", e => {
    e.stopPropagation();
    const it = state.shopping.find(i => String(i.id) === btn.dataset.flag); if (!it) return;
    it.flagged = !it.flagged;
    btn.classList.toggle("is-on", it.flagged);
    btn.textContent = it.flagged ? "⚑" : "⚐";
    const item = btn.closest(".item"); if (item) item.classList.toggle("is-flagged", it.flagged);
    mutToggleFlag(it.id, it.flagged);
  }));
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
  return `<select data-add-recipe="${iso}" aria-label="Rezept hinzufügen"><option value="">+ Rezept…</option>${state.recipes.map(r => `<option value="${r.id}">${esc(shortTitle(r.title))}</option>`).join("")}</select>`;
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
  const empty = document.getElementById("recipesEmpty");
  if (!state.recipes.length) { wrap.innerHTML = ""; wrap.hidden = true; if (empty) empty.hidden = false; return; }
  wrap.hidden = false; if (empty) empty.hidden = true;
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
          ${(r.ingredients && r.ingredients.length) ? `<ul class="recipe-ings">${r.ingredients.map(ing => `<li><span>${esc(ing.text)}</span>${ing.calories ? `<span class="item__calories">${ing.calories} kcal</span>` : ""}</li>`).join("")}</ul>` : `<p class="recipe-noings">Noch keine Zutaten.</p><button type="button" class="btn btn--outline btn--small" data-extract-recipe="${r.id}">✨ Zutaten automatisch erkennen</button>`}
          ${total ? `<p class="recipe-total-calories">Gesamt: ${total} kcal</p>` : ""}
          ${(r.ingredients && r.ingredients.length && activeLists().length) ? `
            <div class="recipe-import-row">
              <select data-import-list-for="${r.id}" aria-label="Zielliste wählen">${activeLists().map(l => `<option value="${l.id}">${esc(l.name)}</option>`).join("")}</select>
              <button type="button" class="btn btn--gold btn--small" data-import-ings="${r.id}">→ In Liste übernehmen</button>
            </div>
            ${importMsg[r.id] ? `<p class="modal-note">${esc(importMsg[r.id])}</p>` : ""}` : ""}
          <button type="button" class="recipe-card__remove" data-delete-recipe="${r.id}">Rezept entfernen</button>
        </div>` : ""}
    </div>`;
  }).join("");
  wrap.querySelectorAll("[data-toggle-recipe]").forEach(b => b.addEventListener("click", () => { expandedRecipe = expandedRecipe === b.dataset.toggleRecipe ? null : b.dataset.toggleRecipe; renderRecipeGallery(); }));
  wrap.querySelectorAll("[data-delete-recipe]").forEach(b => b.addEventListener("click", () => mutDeleteRecipe(b.dataset.deleteRecipe)));
  wrap.querySelectorAll("[data-extract-recipe]").forEach(b => b.addEventListener("click", async () => {
    const r = state.recipes.find(x => x.id === b.dataset.extractRecipe); if (!r) return;
    b.textContent = "Erkenne Zutaten…"; b.disabled = true;
    try { const result = await callExtractIngredients(r.title || r.url || ""); await mutSetRecipeIngredients(r.id, result.items || []); }
    catch (e) { b.textContent = "Fehlgeschlagen — nochmal tippen"; b.disabled = false; console.warn(e); }
  }));
  wrap.querySelectorAll("[data-import-ings]").forEach(b => b.addEventListener("click", async () => {
    const r = state.recipes.find(x => x.id === b.dataset.importIngs);
    if (!r || !(r.ingredients && r.ingredients.length)) return;
    const sel = wrap.querySelector(`[data-import-list-for="${r.id}"]`);
    const listId = sel ? sel.value : null;
    if (!listId) return;
    const listName = (getList(listId) || {}).name || "";
    importMsg[r.id] = "Sortiere Zutaten ein…"; renderRecipeGallery();
    try {
      const texts = r.ingredients.map(i => i.text);
      let assignments = [];
      if (FUNCTIONS_BASE) { const result = await callSortItems(texts, catsOfList(listId).map(c => c.name)); assignments = result.assignments || []; }
      await mutImportToList(listId, r.ingredients, assignments);
      importMsg[r.id] = `${r.ingredients.length} Zutaten in „${listName}" übernommen.`;
      renderRecipeGallery();
    } catch (e) { importMsg[r.id] = "Übernehmen fehlgeschlagen — bitte nochmal."; renderRecipeGallery(); console.warn(e); }
  }));
}

/* ---------- Notizen ---------- */
function renderNotes() {
  const grid = document.getElementById("notesGrid");
  if (!grid) return;
  const q = noteQuery.trim().toLowerCase();
  const notes = [...state.notes]
    .filter(n => !q || (n.title || "").toLowerCase().includes(q) || (n.body || "").toLowerCase().includes(q))
    .sort((a, b) => ((a.updated_at || "") < (b.updated_at || "") ? 1 : -1));
  grid.innerHTML = notes.map(n => {
    if (expandedNote === n.id) {
      return `
      <div class="note-card is-open" data-note="${n.id}">
        <input type="text" class="note-title-input" data-note-title="${n.id}" value="${esc(n.title)}" placeholder="Titel">
        <textarea class="note-body-input" data-note-body="${n.id}" rows="7" placeholder="Notiz schreiben…">${esc(n.body)}</textarea>
        <div class="note-actions">
          <button type="button" class="btn btn--gold btn--small" data-note-done="${n.id}">Fertig</button>
          <button type="button" class="btn btn--outline btn--small" data-note-del="${n.id}">Löschen</button>
        </div>
      </div>`;
    }
    const preview = (n.body || "").replace(/\n/g, " ").slice(0, 90);
    return `
      <div class="note-card" data-note-open="${n.id}">
        <p class="note-card__title">${esc(n.title) || "Ohne Titel"}</p>
        <p class="note-card__preview">${esc(preview) || "—"}</p>
        <p class="note-card__date">${formatDate(n.updated_at)}</p>
      </div>`;
  }).join("") || `<p class="section__desc">${q ? "Keine Notiz gefunden." : "Noch keine Notiz — leg oben eine an."}</p>`;

  grid.querySelectorAll("[data-note-open]").forEach(c => c.addEventListener("click", () => { expandedNote = c.dataset.noteOpen; renderNotes(); }));
  grid.querySelectorAll("[data-note-done]").forEach(b => b.addEventListener("click", () => { saveOpenNote(b.dataset.noteDone); expandedNote = null; renderNotes(); }));
  grid.querySelectorAll("[data-note-del]").forEach(b => b.addEventListener("click", () => mutDeleteNote(b.dataset.noteDel)));
}
function saveOpenNote(id) {
  const t = document.querySelector(`[data-note-title="${id}"]`);
  const b = document.querySelector(`[data-note-body="${id}"]`);
  const n = state.notes.find(x => x.id === id);
  if (!n || (!t && !b)) return;
  const title = t ? t.value : n.title;
  const body = b ? b.value : n.body;
  if (title !== n.title || body !== n.body) mutUpdateNote(id, title, body);
}

function renderAll() {
  renderDashboardTiles();
  renderListsOverview();
  renderListDetail();
  renderBacklog();
  renderCalendar();
  renderRecipeGallery();
  renderNotes();
  if (typeof renderLocationMarkers === "function") renderLocationMarkers();
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
  const dlBtn = document.getElementById("downloadListBtn");
  if (dlBtn) dlBtn.addEventListener("click", () => {
    if (!activeListId) return;
    const list = getList(activeListId);
    const safeName = (list && list.name ? list.name : "Liste").replace(/[^\wÄÖÜäöüß -]/g, "").trim() || "Liste";
    downloadText(safeName + "_" + todayISO() + ".txt", exportListText(activeListId));
  });
})();

/* ---------- Zutat automatisch in die richtige Kategorie einsortieren ---------- */
(function initQuickSort() {
  const input = document.getElementById("quickSortInput");
  const btn = document.getElementById("quickSortBtn");
  const note = document.getElementById("quickSortNote");
  if (!input || !btn) return;
  const commit = async () => {
    const text = input.value.trim();
    if (!text) return;
    if (!activeListId) { note.textContent = "Keine Liste geöffnet."; return; }
    const cats = catsOfList(activeListId);
    if (!cats.length) { note.textContent = "Leg zuerst eine Kategorie an."; return; }
    btn.disabled = true; input.disabled = true; note.textContent = "Sortiere ein…";
    try {
      let catId = cats[0].id, catName = cats[0].name;
      if (FUNCTIONS_BASE) {
        const result = await callSortItem(text, cats.map(c => c.name));
        const chosen = (result.category || "").trim();
        let match = cats.find(c => c.name.trim().toLowerCase() === chosen.toLowerCase());
        if (!match && chosen) {
          await mutAddCategory(chosen, activeListId);
          match = catsOfList(activeListId).find(c => c.name.trim().toLowerCase() === chosen.toLowerCase());
        }
        if (match) { catId = match.id; catName = match.name; }
      }
      await mutAddShopping(catId, text, activeListId);
      note.textContent = `„${text}" → ${catName}`;
      input.value = "";
    } catch (e) {
      note.textContent = "Konnte nicht automatisch einsortieren — bitte manuell.";
      console.warn(e);
    } finally { btn.disabled = false; input.disabled = false; input.focus(); }
  };
  btn.addEventListener("click", commit);
  input.addEventListener("keydown", e => { if (e.key === "Enter") commit(); });
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
function normalizeYouTube(url) {
  let m, id = "";
  if ((m = url.match(/youtube\.com\/shorts\/([A-Za-z0-9_-]{6,})/))) id = m[1];
  else if ((m = url.match(/youtu\.be\/([A-Za-z0-9_-]{6,})/))) id = m[1];
  else if ((m = url.match(/[?&]v=([A-Za-z0-9_-]{6,})/))) id = m[1];
  else if ((m = url.match(/youtube\.com\/embed\/([A-Za-z0-9_-]{6,})/))) id = m[1];
  return id ? `https://www.youtube.com/watch?v=${id}` : url;
}
async function fetchOEmbed(url, platform) {
  let endpoint;
  if (platform === "youtube") endpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent(normalizeYouTube(url))}&format=json`;
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

document.getElementById("autoExtractBtn").addEventListener("click", async () => {
  const note = document.getElementById("caloriesNote");
  const caption = document.getElementById("previewTitle").value.trim() || document.getElementById("importIngredients").value.trim();
  if (!caption) { note.textContent = "Bitte zuerst den Link laden (Vorschau) — das liefert die Beschreibung."; return; }
  if (!FUNCTIONS_BASE) { note.textContent = "Braucht eine Supabase-Verbindung."; return; }
  note.textContent = "Erkenne Zutaten…";
  try {
    const result = await callExtractIngredients(caption);
    const items = result.items || [];
    if (!items.length) { note.textContent = "Keine Zutaten erkannt — bitte manuell eintragen."; return; }
    document.getElementById("importIngredients").value = items.map(i => i.text).join("\n");
    lastEstimatedCalories = items;
    document.getElementById("ingredientCalories").innerHTML = items.map(it => `<div class="ingredient-calories__row"><span>${esc(it.text)}</span><span>${it.calories ?? "–"} kcal</span></div>`).join("");
    const totalEl = document.getElementById("recipeTotalCalories");
    totalEl.textContent = `Gesamt: ${result.total ?? 0} kcal`; totalEl.hidden = false;
    note.textContent = `${items.length} Zutaten erkannt.`;
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

/* ---------- Was kann ich kochen? (Rezeptvorschläge aus vorhandenen Zutaten) ---------- */
(function initCook() {
  const input = document.getElementById("cookInput");
  const btn = document.getElementById("cookBtn");
  const note = document.getElementById("cookNote");
  const box = document.getElementById("cookResults");
  if (!input || !btn) return;
  let lastSuggestions = [];
  function render() {
    box.innerHTML = lastSuggestions.map((r, i) => `
      <div class="cook-card">
        <p class="cook-card__title">${esc(r.title)}</p>
        <p class="cook-card__summary">${esc(r.summary || "")}</p>
        ${(r.uses && r.uses.length) ? `<p class="cook-card__meta"><b>Nutzt:</b> ${esc(r.uses.join(", "))}</p>` : ""}
        ${(r.missing && r.missing.length) ? `<p class="cook-card__meta"><b>Fehlt evtl.:</b> ${esc(r.missing.join(", "))}</p>` : ""}
        <button type="button" class="btn btn--outline btn--small cook-card__save" data-save-suggestion="${i}">+ Als Rezept speichern</button>
      </div>`).join("");
    box.querySelectorAll("[data-save-suggestion]").forEach(b => b.addEventListener("click", async () => {
      const r = lastSuggestions[+b.dataset.saveSuggestion]; if (!r) return;
      b.textContent = "Gespeichert ✓"; b.disabled = true;
      const ings = [].concat(r.uses || [], r.missing || []).map(t => ({ text: t, calories: null }));
      try { await mutAddRecipe({ title: r.title, url: "", platform: "sonstige", thumbnail: "", calories: null }, ings, null); }
      catch (e) { b.textContent = "+ Als Rezept speichern"; b.disabled = false; console.warn(e); }
    }));
  }
  const run = async () => {
    const text = input.value.trim();
    if (!text) { note.textContent = "Bitte ein paar Zutaten eingeben."; return; }
    if (!FUNCTIONS_BASE) { note.textContent = "Braucht eine Supabase-Verbindung."; return; }
    btn.disabled = true; note.textContent = "Suche passende Rezepte…";
    try {
      const result = await callSuggestRecipes(text);
      lastSuggestions = result.recipes || [];
      note.textContent = lastSuggestions.length ? `${lastSuggestions.length} Vorschläge:` : "Keine Vorschläge gefunden.";
      render();
    } catch (e) { note.textContent = "Fehlgeschlagen — prüfe ANTHROPIC_API_KEY in Supabase."; console.warn(e); }
    finally { btn.disabled = false; }
  };
  btn.addEventListener("click", run);
})();

/* ---------- Notizen: Suche + Neu ---------- */
(function initNotes() {
  const search = document.getElementById("noteSearch");
  const addBtn = document.getElementById("addNoteBtn");
  if (search) search.addEventListener("input", () => { noteQuery = search.value; renderNotes(); });
  if (addBtn) addBtn.addEventListener("click", () => mutAddNote());
})();

/* ==========================================================================
   PROSPEKTE (Direkt-Links, DE/CH)
   ========================================================================== */
const PROSPEKTE = {
  de: {
    maerkte: [
      { name: "Edeka", url: "https://www.edeka.de/angebote/angebote.jsp" },
      { name: "Rewe", url: "https://www.rewe.de/angebote/" },
      { name: "Lidl", url: "https://www.lidl.de/c/online-prospekte/s10007366" },
      { name: "Aldi Süd", url: "https://www.aldi-sued.de/de/angebote.html" },
      { name: "Aldi Nord", url: "https://www.aldi-nord.de/angebote.html" },
      { name: "Penny", url: "https://www.penny.de/angebote" },
      { name: "Kaufland", url: "https://www.kaufland.de/angebote/aktuelle-woche.html" },
      { name: "Netto", url: "https://www.netto-online.de/filialangebote" },
    ],
    aggregatoren: [
      { name: "Marktguru — alle Märkte, per PLZ", url: "https://www.marktguru.de/prospekte" },
      { name: "kaufDA — Prospekte per PLZ", url: "https://www.kaufda.de/" },
    ],
  },
  ch: {
    maerkte: [
      { name: "Migros", url: "https://www.migros.ch/de/aktionen" },
      { name: "Coop", url: "https://www.coop.ch/de/angebote.html" },
      { name: "Aldi Suisse", url: "https://www.aldi-suisse.ch/de/aktionen.html" },
      { name: "Lidl Schweiz", url: "https://www.lidl.ch/c/prospekte/s10020843" },
      { name: "Denner", url: "https://www.denner.ch/de/aktionen/" },
    ],
    aggregatoren: [
      { name: "Marktguru CH — alle Märkte, per PLZ", url: "https://www.marktguru.ch/prospekte" },
      { name: "Profital — Prospekte per Ort", url: "https://www.profital.ch/de" },
    ],
  },
};
let prospekteLand = localStorage.getItem("homebase_prospekte_land") || "de";
function renderProspekte() {
  const grid = document.getElementById("prospekteGrid");
  const aggr = document.getElementById("prospekteAggr");
  if (!grid) return;
  document.querySelectorAll("[data-land]").forEach(b => b.classList.toggle("is-active", b.dataset.land === prospekteLand));
  const data = PROSPEKTE[prospekteLand];
  grid.innerHTML = data.maerkte.map(m => `<a class="prospekt-card" href="${m.url}" target="_blank" rel="noopener"><span class="prospekt-card__name">${esc(m.name)}</span><span class="prospekt-card__go">Prospekt ansehen ↗</span></a>`).join("");
  if (aggr) aggr.innerHTML = data.aggregatoren.map(m => `<a class="prospekt-link" href="${m.url}" target="_blank" rel="noopener">${esc(m.name)} ↗</a>`).join("");
}
document.querySelectorAll("[data-land]").forEach(b => b.addEventListener("click", () => {
  prospekteLand = b.dataset.land; localStorage.setItem("homebase_prospekte_land", prospekteLand); renderProspekte();
  const input = document.getElementById("angebotInput");
  if (input && input.value.trim()) renderOfferResults(input.value);
}));

/* ---- Angebotssuche pro Anbieter + Merkliste (gerätelokal) ---- */
const OFFER_WATCH_KEY = "homebase_watch_offers";
function getWatch() { try { return JSON.parse(localStorage.getItem(OFFER_WATCH_KEY) || "[]"); } catch (e) { return []; } }
function saveWatch(arr) { localStorage.setItem(OFFER_WATCH_KEY, JSON.stringify(arr)); }
function offerProviders(q) {
  const g = prospekteLand === "ch" ? "https://www.google.ch/search?q=" : "https://www.google.de/search?q=";
  const e = s => encodeURIComponent(s);
  if (prospekteLand === "ch") {
    return [
      { label: "Marktguru", url: g + e("site:marktguru.ch " + q + " angebot") },
      { label: "Profital", url: g + e("site:profital.ch " + q) },
      { label: "Google Angebote", url: g + e(q + " angebot prospekt schweiz") },
    ];
  }
  return [
    { label: "Marktguru", url: g + e("site:marktguru.de " + q + " angebot") },
    { label: "kaufDA", url: g + e("site:kaufda.de " + q + " angebot") },
    { label: "Google Angebote", url: g + e(q + " angebot prospekt supermarkt") },
  ];
}
function renderOfferResults(q) {
  const box = document.getElementById("angebotResults");
  if (!box) return;
  q = (q || "").trim();
  if (!q) { box.hidden = true; box.innerHTML = ""; return; }
  const links = offerProviders(q).map(p => `<a href="${p.url}" target="_blank" rel="noopener noreferrer">${esc(p.label)} ↗</a>`).join("");
  box.hidden = false;
  box.innerHTML = `<span class="ar-label">Angebote für „${esc(q)}" öffnen:</span>` + links;
}
function renderOfferWatch() {
  const box = document.getElementById("angebotWatch");
  if (!box) return;
  const arr = getWatch();
  if (!arr.length) { box.innerHTML = ""; return; }
  box.innerHTML = `<span class="ar-label">Beobachtete Zutaten (auf diesem Gerät):</span>` + arr.map((q, i) =>
    `<span class="watch-chip"><span class="wc-name" data-watch-idx="${i}">${esc(q)}</span><button type="button" data-watch-del="${i}" aria-label="Entfernen">×</button></span>`
  ).join("");
  box.querySelectorAll("[data-watch-idx]").forEach(el => el.addEventListener("click", () => {
    const q = getWatch()[+el.dataset.watchIdx]; if (q == null) return;
    const input = document.getElementById("angebotInput"); if (input) input.value = q;
    renderOfferResults(q);
  }));
  box.querySelectorAll("[data-watch-del]").forEach(el => el.addEventListener("click", () => {
    const arr2 = getWatch(); arr2.splice(+el.dataset.watchDel, 1); saveWatch(arr2); renderOfferWatch();
  }));
}
(function initAngebotSearch() {
  const input = document.getElementById("angebotInput");
  const btn = document.getElementById("angebotBtn");
  const watchBtn = document.getElementById("angebotWatchBtn");
  if (!input || !btn) return;
  const search = () => { const q = input.value.trim(); if (!q) return; renderOfferResults(q); };
  const remember = () => {
    const q = input.value.trim(); if (!q) return;
    const arr = getWatch();
    if (!arr.some(x => x.toLowerCase() === q.toLowerCase())) { arr.push(q); saveWatch(arr); }
    renderOfferWatch(); renderOfferResults(q);
  };
  btn.addEventListener("click", search);
  input.addEventListener("keydown", e => { if (e.key === "Enter") search(); });
  if (watchBtn) watchBtn.addEventListener("click", remember);
  renderOfferWatch();
})();

/* ==========================================================================
   LIVE-STANDORT TEILEN (Browser-Standort + Karte)
   ========================================================================== */
function getPerson() {
  let p = null;
  try { p = JSON.parse(localStorage.getItem("homebase_person") || "null"); } catch (e) {}
  if (!p || !p.id) { p = { id: uid("loc_"), name: "" }; localStorage.setItem("homebase_person", JSON.stringify(p)); }
  return p;
}
function setPersonName(name) { const p = getPerson(); p.name = name; localStorage.setItem("homebase_person", JSON.stringify(p)); }
let leafletMap = null, mapMarkers = {}, watchId = null, lastLocPush = 0;
function initMap() {
  const el = document.getElementById("standortMap");
  if (!el || typeof L === "undefined") return;
  if (!leafletMap) {
    leafletMap = L.map(el, { zoomControl: true }).setView([51.1, 10.4], 6);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(leafletMap);
  }
  setTimeout(() => { try { leafletMap.invalidateSize(); } catch (e) {} }, 120);
  renderLocationMarkers();
  ensureMarkets();
}
function renderLocationMarkers() {
  if (!leafletMap || typeof L === "undefined") return;
  const cutoff = Date.now() - 10 * 60 * 1000;
  const active = (state.locations || []).filter(l => l.sharing && l.lat != null && l.lng != null && new Date(l.updated_at).getTime() > cutoff);
  Object.keys(mapMarkers).forEach(id => { if (!active.find(a => a.id === id)) { leafletMap.removeLayer(mapMarkers[id]); delete mapMarkers[id]; } });
  active.forEach(l => {
    const label = (esc(l.name) || "Jemand") + " · " + new Date(l.updated_at).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
    if (mapMarkers[l.id]) mapMarkers[l.id].setLatLng([l.lat, l.lng]).setPopupContent(label);
    else mapMarkers[l.id] = L.marker([l.lat, l.lng]).addTo(leafletMap).bindPopup(label);
  });
  if (active.length) {
    try { leafletMap.fitBounds(L.featureGroup(active.map(l => mapMarkers[l.id])).getBounds().pad(0.4), { maxZoom: 15 }); } catch (e) {}
  }
}
async function upsertMyLocation(lat, lng, sharing) {
  if (!REMOTE) return;
  const p = getPerson();
  try { await sb.from("locations").upsert({ id: p.id, name: p.name || "Ich", lat, lng, sharing, updated_at: new Date().toISOString() }); } catch (e) { console.warn(e); }
}
function geoErrMsg(err) {
  if (err && err.code === 1) return "Standort-Freigabe ist blockiert. iPhone: Einstellungen → Datenschutz & Sicherheit → Ortungsdienste einschalten und für Safari die Option 'Beim Verwenden der App' wählen. Danach die Seite neu laden.";
  if (err && err.code === 2) return "Position gerade nicht ermittelbar (kein GPS/WLAN-Signal). Kurz warten oder ins Freie gehen.";
  if (err && err.code === 3) return "Die Standort-Suche hat zu lange gedauert — bitte den Schalter nochmal aus- und einschalten.";
  return "Standort nicht verfügbar — bitte die Freigabe erlauben.";
}
function startSharing() {
  const note = document.getElementById("standortNote");
  if (!navigator.geolocation) { if (note) note.textContent = "Dein Browser unterstützt keinen Standort."; return; }
  const isStandalone = (window.navigator.standalone === true) || matchMedia("(display-mode: standalone)").matches;
  if (note) note.textContent = "Standort wird ermittelt … bitte die Freigabe erlauben." + (isStandalone ? " Falls nichts passiert: HomeBase direkt in Safari öffnen (nicht über das Home-Bildschirm-Symbol)." : "");
  const push = (pos, msg) => {
    const now = Date.now();
    if (now - lastLocPush < 12000) return;
    lastLocPush = now;
    upsertMyLocation(pos.coords.latitude, pos.coords.longitude, true);
    if (note) note.textContent = msg;
  };
  // Sofort-Fix (schnell, ungenau erlaubt) — löst zugleich den Berechtigungsdialog aus
  navigator.geolocation.getCurrentPosition(
    pos => push(pos, "Du teilst deinen Standort."),
    err => { if (note) note.textContent = geoErrMsg(err); },
    { enableHighAccuracy: false, maximumAge: 30000, timeout: 15000 }
  );
  // Laufende, genauere Updates
  watchId = navigator.geolocation.watchPosition(
    pos => push(pos, "Du teilst deinen Standort (aktualisiert alle paar Sekunden)."),
    err => { if (note) note.textContent = geoErrMsg(err); },
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 25000 }
  );
}
function stopSharing() {
  if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  lastLocPush = 0;
  upsertMyLocation(null, null, false);
  const note = document.getElementById("standortNote");
  if (note) note.textContent = "Standort-Teilen ist aus.";
}
(function initStandort() {
  const nameInput = document.getElementById("standortName");
  const toggle = document.getElementById("shareToggle");
  if (!toggle) return;
  const p = getPerson();
  if (nameInput) {
    nameInput.value = p.name || "";
    nameInput.addEventListener("blur", () => setPersonName(nameInput.value.trim()));
  }
  toggle.addEventListener("change", () => {
    const note = document.getElementById("standortNote");
    if (toggle.checked) {
      if (nameInput && !nameInput.value.trim()) { if (note) note.textContent = "Bitte zuerst deinen Namen eingeben."; toggle.checked = false; return; }
      setPersonName(nameInput ? nameInput.value.trim() : "");
      startSharing();
    } else { stopSharing(); }
  });
})();

/* ==========================================================================
   SUPERMÄRKTE IN DER NÄHE (OpenStreetMap / Overpass)
   ========================================================================== */
let marketMarkers = [], marketsLoaded = false;
function clearMarketMarkers() {
  if (leafletMap) marketMarkers.forEach(m => { try { leafletMap.removeLayer(m); } catch (e) {} });
  marketMarkers = [];
}
function haversine(la1, lo1, la2, lo2) {
  const R = 6371000, toR = x => x * Math.PI / 180;
  const dLa = toR(la2 - la1), dLo = toR(lo2 - lo1);
  const a = Math.sin(dLa / 2) ** 2 + Math.cos(toR(la1)) * Math.cos(toR(la2)) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function fmtDist(m) { return m < 1000 ? (Math.round(m / 10) * 10) + " m" : (m / 1000).toFixed(1).replace(".", ",") + " km"; }
async function loadNearbyMarkets(lat, lng) {
  const listEl = document.getElementById("marketsList");
  const noteEl = document.getElementById("marketsNote");
  if (noteEl) noteEl.textContent = "Supermärkte werden gesucht…";
  const q = '[out:json][timeout:20];(node["shop"="supermarket"](around:2500,' + lat + ',' + lng + ');way["shop"="supermarket"](around:2500,' + lat + ',' + lng + '););out center 25;';
  try {
    const r = await fetch("https://overpass-api.de/api/interpreter?data=" + encodeURIComponent(q));
    const j = await r.json();
    const items = (j.elements || []).map(el => {
      const la = el.lat != null ? el.lat : (el.center && el.center.lat);
      const lo = el.lon != null ? el.lon : (el.center && el.center.lon);
      if (la == null || lo == null) return null;
      const name = (el.tags && (el.tags.name || el.tags.brand)) || "Supermarkt";
      return { name, lat: la, lng: lo, dist: haversine(lat, lng, la, lo) };
    }).filter(Boolean);
    items.sort((a, b) => a.dist - b.dist);
    const top = items.slice(0, 6);
    clearMarketMarkers();
    if (leafletMap && typeof L !== "undefined") {
      top.forEach(m => {
        const mk = L.circleMarker([m.lat, m.lng], { radius: 7, color: "#F6D9AC", weight: 2, fillColor: "#E5B074", fillOpacity: .9 })
          .addTo(leafletMap).bindPopup(esc(m.name) + " · " + fmtDist(m.dist));
        marketMarkers.push(mk);
      });
    }
    if (listEl) listEl.innerHTML = top.map(m =>
      `<div class="market-row"><span class="market-row__name"><span class="pin">📍</span><span>${esc(m.name)}</span></span><span class="market-row__dist">${fmtDist(m.dist)}</span></div>`
    ).join("");
    if (noteEl) noteEl.textContent = top.length ? "Quelle: OpenStreetMap · Entfernung als Luftlinie." : "Keine Supermärkte im Umkreis von 2,5 km gefunden.";
  } catch (e) {
    if (noteEl) noteEl.textContent = "Supermärkte konnten nicht geladen werden.";
  }
}
function ensureMarkets() {
  if (marketsLoaded) return;
  const go = (lat, lng) => { marketsLoaded = true; loadNearbyMarkets(lat, lng); };
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem("homebase_wx_coords") || "null"); } catch (e) {}
  if (cached && cached.lat != null) { go(cached.lat, cached.lng); return; }
  const noteEl = document.getElementById("marketsNote");
  if (navigator.geolocation) {
    if (noteEl) noteEl.textContent = "Standort wird ermittelt…";
    navigator.geolocation.getCurrentPosition(
      pos => { const c = { lat: pos.coords.latitude, lng: pos.coords.longitude }; localStorage.setItem("homebase_wx_coords", JSON.stringify(c)); go(c.lat, c.lng); },
      () => { if (noteEl) noteEl.textContent = "Für Supermärkte in der Nähe bitte den Standort freigeben."; },
      { enableHighAccuracy: false, maximumAge: 1800000, timeout: 15000 }
    );
  } else if (noteEl) { noteEl.textContent = "Standort wird von diesem Browser nicht unterstützt."; }
}

/* ==========================================================================
   MINI-KARTE (Dashboard) — Leuchtroute zum nächsten Supermarkt
   ========================================================================== */
let homeMiniMap = null, homeMapLoaded = false;
async function buildHomeMap(lat, lng) {
  const el = document.getElementById("homeMiniMap");
  const label = document.getElementById("homeMapLabel");
  if (!el || typeof L === "undefined") return;
  if (!homeMiniMap) {
    homeMiniMap = L.map(el, { zoomControl: false, attributionControl: false, dragging: false, scrollWheelZoom: false, doubleClickZoom: false, boxZoom: false, keyboard: false, touchZoom: false }).setView([lat, lng], 14);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", { maxZoom: 19 }).addTo(homeMiniMap);
  }
  setTimeout(() => { try { homeMiniMap.invalidateSize(); } catch (e) {} }, 140);
  L.circleMarker([lat, lng], { radius: 6, color: "#9CCBFF", weight: 2, fillColor: "#4C9BFF", fillOpacity: .95, className: "mk-glow-blue" }).addTo(homeMiniMap);
  try {
    const q = '[out:json][timeout:20];(node["shop"="supermarket"](around:3000,' + lat + ',' + lng + ');way["shop"="supermarket"](around:3000,' + lat + ',' + lng + '););out center 20;';
    const r = await fetch("https://overpass-api.de/api/interpreter?data=" + encodeURIComponent(q));
    const j = await r.json();
    const items = (j.elements || []).map(e2 => {
      const la = e2.lat != null ? e2.lat : (e2.center && e2.center.lat);
      const lo = e2.lon != null ? e2.lon : (e2.center && e2.center.lon);
      if (la == null || lo == null) return null;
      const name = (e2.tags && (e2.tags.name || e2.tags.brand)) || "Supermarkt";
      return { name, lat: la, lng: lo, dist: haversine(lat, lng, la, lo) };
    }).filter(Boolean).sort((a, b) => a.dist - b.dist);
    if (!items.length) { if (label) label.textContent = "Kein Supermarkt in der Nähe"; homeMiniMap.setView([lat, lng], 14); return; }
    const m = items[0];
    L.circleMarker([m.lat, m.lng], { radius: 7, color: "#F6D9AC", weight: 2, fillColor: "#E5B074", fillOpacity: .95, className: "mk-glow-gold" }).addTo(homeMiniMap);
    let line = null;
    try {
      const rr = await fetch("https://router.project-osrm.org/route/v1/walking/" + lng + "," + lat + ";" + m.lng + "," + m.lat + "?overview=full&geometries=geojson");
      const rj = await rr.json();
      if (rj.routes && rj.routes[0]) line = rj.routes[0].geometry.coordinates.map(c => [c[1], c[0]]);
    } catch (e) {}
    if (!line) line = [[lat, lng], [m.lat, m.lng]];
    L.polyline(line, { color: "#F6D9AC", weight: 8, opacity: .22, className: "route-glow" }).addTo(homeMiniMap);
    L.polyline(line, { color: "#FBE7C2", weight: 2.5, opacity: 1, className: "route-line" }).addTo(homeMiniMap);
    try { homeMiniMap.fitBounds(L.latLngBounds(line).pad(0.28)); } catch (e) {}
    if (label) label.textContent = m.name + " · " + fmtDist(m.dist);
  } catch (e) {
    if (label) label.textContent = "Karte konnte nicht geladen werden";
  }
}
function initHomeMap() {
  if (homeMapLoaded) return;
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem("homebase_wx_coords") || "null"); } catch (e) {}
  if (cached && cached.lat != null) { homeMapLoaded = true; buildHomeMap(cached.lat, cached.lng); return; }
  const label = document.getElementById("homeMapLabel");
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      pos => { const c = { lat: pos.coords.latitude, lng: pos.coords.longitude }; localStorage.setItem("homebase_wx_coords", JSON.stringify(c)); homeMapLoaded = true; buildHomeMap(c.lat, c.lng); },
      () => { if (label) label.textContent = "Standort freigeben für die Route"; },
      { enableHighAccuracy: false, maximumAge: 1800000, timeout: 15000 }
    );
  } else if (label) { label.textContent = "Standort nicht unterstützt"; }
}

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
   DASHBOARD-KOPF — Uhr, Datum, Wetter
   ========================================================================== */
function updateHomeClock() {
  const t = document.getElementById("homeTime");
  const d = document.getElementById("homeDate");
  if (!t || !d) return;
  const now = new Date();
  t.textContent = now.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  d.textContent = now.toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long" });
}
const WX_CODES = {
  0: ["☀️", "Klar"], 1: ["🌤️", "Meist klar"], 2: ["⛅", "Teils bewölkt"], 3: ["☁️", "Bewölkt"],
  45: ["🌫️", "Nebel"], 48: ["🌫️", "Reifnebel"],
  51: ["🌦️", "Leichter Niesel"], 53: ["🌦️", "Niesel"], 55: ["🌦️", "Starker Niesel"],
  56: ["🌧️", "Gefrierender Niesel"], 57: ["🌧️", "Gefrierender Niesel"],
  61: ["🌧️", "Leichter Regen"], 63: ["🌧️", "Regen"], 65: ["🌧️", "Starker Regen"],
  66: ["🌧️", "Gefrierender Regen"], 67: ["🌧️", "Gefrierender Regen"],
  71: ["🌨️", "Leichter Schnee"], 73: ["🌨️", "Schnee"], 75: ["🌨️", "Starker Schnee"], 77: ["🌨️", "Schneegriesel"],
  80: ["🌦️", "Regenschauer"], 81: ["🌦️", "Regenschauer"], 82: ["⛈️", "Heftige Schauer"],
  85: ["🌨️", "Schneeschauer"], 86: ["🌨️", "Schneeschauer"],
  95: ["⛈️", "Gewitter"], 96: ["⛈️", "Gewitter, Hagel"], 99: ["⛈️", "Gewitter, Hagel"]
};
async function fetchWeather(lat, lng) {
  const icon = document.getElementById("homeWxIcon");
  const temp = document.getElementById("homeWxTemp");
  const desc = document.getElementById("homeWxDesc");
  if (!temp) return;
  try {
    const r = await fetch("https://api.open-meteo.com/v1/forecast?latitude=" + lat + "&longitude=" + lng + "&current=temperature_2m,weather_code&timezone=auto");
    const j = await r.json();
    const c = j.current || {};
    const info = WX_CODES[c.weather_code] || ["🌡️", "—"];
    if (icon) icon.textContent = info[0];
    if (temp && c.temperature_2m != null) temp.textContent = Math.round(c.temperature_2m) + "°";
    if (desc) desc.textContent = info[1];
  } catch (e) {
    if (desc) desc.textContent = "Wetter nicht verfügbar";
  }
}
function initWeather() {
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem("homebase_wx_coords") || "null"); } catch (e) {}
  if (cached && cached.lat != null) { fetchWeather(cached.lat, cached.lng); return; }
  const c = (prospekteLand === "ch") ? { lat: 47.37, lng: 8.54 } : { lat: 52.52, lng: 13.40 };
  fetchWeather(c.lat, c.lng);
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      pos => {
        const coords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        localStorage.setItem("homebase_wx_coords", JSON.stringify(coords));
        fetchWeather(coords.lat, coords.lng);
      },
      () => {},
      { enableHighAccuracy: false, maximumAge: 1800000, timeout: 12000 }
    );
  }
}
function initHomeHead() {
  updateHomeClock();
  setInterval(updateHomeClock, 20000);
  initWeather();
  initHomeMap();
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
  renderProspekte();
  openView("dashboard");
  initScrollFX();
  initHomeHead();
}
document.addEventListener("DOMContentLoaded", init);
