'use strict';
/*
  NutriTrack — Phase 1 (essential nutrition tracker)
  Local-first PWA: all personal data lives in this device's IndexedDB.
  Only barcode numbers / search words leave the device (sent to Open Food Facts).
*/
const APP_VERSION = '1.0.0';

// ---------- Constants ----------
const NUTS = [
  ['kcal', 'Calories', 'kcal', 0],
  ['protein', 'Protein', 'g', 1],
  ['carbs', 'Carbohydrates', 'g', 1],
  ['fat', 'Total fat', 'g', 1],
  ['satfat', 'Saturated fat', 'g', 1],
  ['fiber', 'Fiber', 'g', 1],
  ['sugar', 'Total sugar', 'g', 1],
  ['addedSugar', 'Added sugar', 'g', 1],
  ['sodium', 'Sodium', 'mg', 0],
];
const CORE = ['kcal', 'protein', 'carbs', 'fat'];
const MEALS = [['breakfast', 'Breakfast'], ['lunch', 'Lunch'], ['dinner', 'Dinner'], ['snacks', 'Snacks']];
const MEAL_LABEL = Object.fromEntries(MEALS);
const DEFAULT_SETTINGS = { key: 'settings', kcal: 2000, protein: 120, carbs: 200, fat: 65, fiber: 30, waterGoal: 64 };
const OFF_BASE = 'https://world.openfoodfacts.org';
const OFF_FIELDS = 'code,product_name,product_name_en,generic_name,brands,quantity,product_quantity,product_quantity_unit,serving_size,serving_quantity,serving_quantity_unit,nutriments,image_front_small_url,image_front_url,image_url';
const ZXING_LIBRARY_FALLBACK = 'https://unpkg.com/@zxing/library@0.21/umd/index.min.js';

const FEATURES = {
  done: [
    'Live barcode scanning (UPC-A, UPC-E, EAN-13, EAN-8)',
    'Barcode from a photo, or typed by hand',
    'Open Food Facts lookup (product, brand, image, nutrition)',
    'Serving size, servings per container, quantity in servings or grams',
    'Daily diary: breakfast, lunch, dinner, snacks; edit or delete entries',
    'Saved foods, favorites, recents, custom foods, correcting records',
    'Copy previous day / repeat a meal',
    'Calorie, macro, fiber and water goals',
    'Encrypted backup & restore, CSV export, delete all data',
    'Works offline for your saved foods and diary',
  ],
  planned: [
    'Phase 2: Nutrition-label photo + on-device OCR, recipes, meal-photo workflow',
    'Phase 3: Weight & measurements, medication journal, Apple Health import, reports',
  ],
};

// ---------- Tiny helpers ----------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function uid() { return (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2); }
function dateStr(d = new Date()) { const z = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`; }
function parseD(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function addDays(s, n) { const d = parseD(s); d.setDate(d.getDate() + n); return dateStr(d); }
function niceDate(s) {
  const t = dateStr();
  if (s === t) return 'Today';
  if (s === addDays(t, -1)) return 'Yesterday';
  if (s === addDays(t, 1)) return 'Tomorrow';
  return parseD(s).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}
function longDate(s) { return parseD(s).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }); }
function fmt(v, dec = 0) {
  if (v == null || !isFinite(v)) return '—';
  return Number(v).toLocaleString(undefined, { maximumFractionDigits: dec, minimumFractionDigits: 0 });
}
function num(v) {
  if (v === '' || v == null) return null;
  const n = typeof v === 'string' ? parseFloat(v.replace(',', '.')) : v;
  return (typeof n === 'number' && isFinite(n)) ? n : null;
}
function defaultMeal() { const h = new Date().getHours(); return h < 11 ? 'breakfast' : h < 16 ? 'lunch' : h < 21 ? 'dinner' : 'snacks'; }
function hasAny(o) { return !!o && Object.values(o).some(v => v != null); }
function emptyNuts() { const o = {}; NUTS.forEach(([k]) => { o[k] = null; }); return o; }
function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = src; s.crossOrigin = 'anonymous';
    s.onload = res; s.onerror = () => rej(new Error('Could not load ' + src)); document.head.appendChild(s);
  });
}

// ---------- Nutrition math (never invents values) ----------
function canUseServing(f) { return hasAny(f.perServing) || (hasAny(f.per100) && !!f.servingGrams); }
function canUseGrams(f) { return hasAny(f.per100) || (hasAny(f.perServing) && !!f.servingGrams); }
function missingLabels(f) { return NUTS.filter(([k]) => f.per100?.[k] == null && f.perServing?.[k] == null).map(([, l]) => l); }
function isIncomplete(f) {
  if (!f.name || f.name === 'Unnamed product') return true;
  if (!canUseServing(f) && !canUseGrams(f)) return true;
  return CORE.some(k => f.per100?.[k] == null && f.perServing?.[k] == null);
}
function calcNutrients(food, amount, unit) {
  const out = emptyNuts();
  const a = Number(amount);
  if (!(a > 0)) return out;
  const sg = food.servingGrams;
  for (const [k] of NUTS) {
    const p100 = food.per100?.[k], ps = food.perServing?.[k];
    let v = null;
    if (unit === 'serving') {
      if (ps != null) v = ps * a;
      else if (p100 != null && sg) v = p100 * sg / 100 * a;
    } else {
      if (p100 != null) v = p100 * a / 100;
      else if (ps != null && sg) v = ps / sg * a;
    }
    out[k] = v;
  }
  return out;
}
function sumNuts(entries) {
  const t = {}, missing = {};
  NUTS.forEach(([k]) => { t[k] = 0; missing[k] = 0; });
  for (const e of entries) for (const [k] of NUTS) {
    const v = e.nutrients?.[k];
    if (v == null) missing[k]++; else t[k] += v;
  }
  return { t, missing };
}

// ---------- Barcodes ----------
function upcEtoA(e) {
  const ns = e[0], d = e.slice(1, 7), c = e[7], last = d[5];
  let m;
  if ('012'.includes(last)) m = d.slice(0, 2) + last + '0000' + d.slice(2, 5);
  else if (last === '3') m = d.slice(0, 3) + '00000' + d.slice(3, 5);
  else if (last === '4') m = d.slice(0, 4) + '00000' + d[4];
  else m = d.slice(0, 5) + '0000' + last;
  return ns + m + c;
}
function barcodeCandidates(code) {
  const c = [code];
  if (code.length === 12) c.push('0' + code);
  if (code.length === 13 && code[0] === '0') c.push(code.slice(1));
  if (code.length === 8 && (code[0] === '0' || code[0] === '1')) { const a = upcEtoA(code); c.push(a, '0' + a); }
  return [...new Set(c)];
}
const isBarcode = t => /^\d{8}$|^\d{12,14}$/.test(t);

// ---------- Open Food Facts ----------
function offNuts(n, suffix) {
  const g = k => num(n[k + suffix]);
  let kcal = g('energy-kcal');
  if (kcal == null) { const kj = g('energy-kj'); if (kj != null) kcal = kj / 4.184; } // unit conversion only
  const sod = g('sodium'); // grams in OFF
  const o = {
    kcal, protein: g('proteins'), carbs: g('carbohydrates'), fat: g('fat'), satfat: g('saturated-fat'),
    fiber: g('fiber'), sugar: g('sugars'), addedSugar: g('added-sugars'), sodium: sod != null ? sod * 1000 : null,
  };
  return hasAny(o) ? o : null;
}
function mapOFF(code, p) {
  const n = p.nutriments || {};
  const sg = num(p.serving_quantity);
  const su = String(p.serving_quantity_unit || 'g').toLowerCase() === 'ml' ? 'ml' : 'g';
  const pq = num(p.product_quantity);
  const pqu = String(p.product_quantity_unit || su).toLowerCase();
  let spc = null;
  if (sg && pq && pqu === su) spc = Math.round(pq / sg * 10) / 10;
  const now = Date.now();
  const food = {
    id: uid(), barcode: code,
    name: String(p.product_name || p.product_name_en || p.generic_name || '').trim() || 'Unnamed product',
    brand: String(p.brands || '').split(',')[0].trim(),
    packageSize: p.quantity || '',
    imageUrl: p.image_front_small_url || p.image_front_url || p.image_url || '',
    servingLabel: p.serving_size || '', servingGrams: sg || null, baseUnit: su,
    servingsPerContainer: spc, spcEstimated: spc != null,
    per100: offNuts(n, '_100g'), perServing: offNuts(n, '_serving'),
    source: 'Open Food Facts', favorite: false, useCount: 0, lastUsed: 0, createdAt: now, updatedAt: now,
  };
  food.incomplete = isIncomplete(food);
  return food;
}
async function lookupOFF(code) {
  const r = await fetch(`${OFF_BASE}/api/v2/product/${encodeURIComponent(code)}.json?fields=${OFF_FIELDS}`, { headers: { Accept: 'application/json' } });
  if (r.status === 404) return null;
  if (r.status === 429) throw new Error('Food database is busy (too many lookups). Wait a minute and try again.');
  if (!r.ok) throw new Error('Food database error (' + r.status + ')');
  const j = await r.json();
  if (j.status !== 1 || !j.product) return null;
  return mapOFF(code, j.product);
}
async function searchOFF(q) {
  const u = `${OFF_BASE}/cgi/search.pl?search_terms=${encodeURIComponent(q)}&search_simple=1&action=process&json=1&page_size=20&fields=${OFF_FIELDS}`;
  const r = await fetch(u, { headers: { Accept: 'application/json' } });
  if (r.status === 429) throw new Error('Online search is limited to about 10 per minute. Try again shortly.');
  if (!r.ok) throw new Error('Search failed (' + r.status + ')');
  const j = await r.json();
  return (j.products || []).filter(p => p.code).map(p => mapOFF(p.code, p));
}

// ---------- IndexedDB ----------
const DB = (() => {
  let dbp;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open('nutritrack', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('foods', { keyPath: 'id' }).createIndex('barcode', 'barcode', { unique: false });
        d.createObjectStore('entries', { keyPath: 'id' }).createIndex('date', 'date', { unique: false });
        d.createObjectStore('days', { keyPath: 'date' });
        d.createObjectStore('kv', { keyPath: 'key' });
        d.createObjectStore('pending', { keyPath: 'barcode' });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  async function tx(store, mode, fn) {
    const d = await open();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode);
      const req = fn(t.objectStore(store));
      let out;
      if (req) req.onsuccess = () => { out = req.result; };
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  }
  return {
    STORES: ['foods', 'entries', 'days', 'kv', 'pending'],
    get: (s, k) => tx(s, 'readonly', st => st.get(k)),
    put: (s, v) => tx(s, 'readwrite', st => st.put(v)),
    del: (s, k) => tx(s, 'readwrite', st => st.delete(k)),
    all: s => tx(s, 'readonly', st => st.getAll()),
    byIndex: (s, i, v) => tx(s, 'readonly', st => st.index(i).getAll(v)),
    clear: s => tx(s, 'readwrite', st => st.clear()),
  };
})();

// ---------- State ----------
const state = { tab: 'home', date: dateStr(), settings: { ...DEFAULT_SETTINGS }, pendingMeal: null };
async function loadSettings() { state.settings = Object.assign({}, DEFAULT_SETTINGS, (await DB.get('kv', 'settings')) || {}); }
async function entriesFor(date) { return (await DB.byIndex('entries', 'date', date)).sort((a, b) => a.createdAt - b.createdAt); }
async function getDay(date) { return (await DB.get('days', date)) || { date, waterOz: 0 }; }
function snapshot(f) {
  const { id, name, brand, barcode, servingLabel, servingGrams, baseUnit, servingsPerContainer, spcEstimated, per100, perServing, imageUrl, incomplete, source, packageSize } = f;
  return { id, name, brand, barcode, servingLabel, servingGrams, baseUnit, servingsPerContainer, spcEstimated, per100, perServing, imageUrl, incomplete, source, packageSize };
}

// ---------- Icons ----------
const ICON = {
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  barcode: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 8v8M10 8v8M13 8v8M16.5 8v8"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  camera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8a2 2 0 0 1 2-2h2l2-2h6l2 2h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><circle cx="12" cy="13" r="3.5"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9z"/></svg>',
  starOn: '<svg viewBox="0 0 24 24" fill="#ffb800" stroke="#ffb800" stroke-width="2" stroke-linejoin="round"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9z"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
};

// ---------- UI primitives ----------
const view = () => $('#view');
let toastTimer;
function toast(msg, ms = 2400) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
const sheets = [];
function openSheet(html, onClose) {
  if (state.tab === 'scan') Scanner.stop();
  const el = document.createElement('div');
  el.className = 'sheet'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true');
  el.innerHTML = `<div class="sheet-grab"></div>${html}`;
  document.body.appendChild(el);
  sheets.push({ el, onClose });
  $('#backdrop').hidden = false; document.body.classList.add('noscroll');
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('open')));
  return el;
}
function closeSheet() {
  const s = sheets.pop(); if (!s) return;
  s.el.classList.remove('open'); setTimeout(() => s.el.remove(), 260);
  if (!sheets.length) { $('#backdrop').hidden = true; document.body.classList.remove('noscroll'); }
  try { s.onClose && s.onClose(); } catch (e) { console.error(e); }
  if (!sheets.length && state.tab === 'scan') startCamera();
}
function closeAllSheets() { while (sheets.length) closeSheet(); }
function shareOrDownload(text, name, type) {
  const blob = new Blob([text], { type });
  const file = new File([blob], name, { type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    return navigator.share({ files: [file], title: name }).then(() => true).catch(e => { if (e.name === 'AbortError') return false; throw e; });
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  return Promise.resolve(true);
}
function thumb(url, cls = 'thumb') {
  return url ? `<img class="${cls}" src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<div class="${cls}"></div>`;
}
function amountLabel(e) {
  const a = Number(e.amount);
  return e.unit === 'serving' ? `${fmt(a, 2)} serving${a === 1 ? '' : 's'}` : `${fmt(a, 1)} ${e.baseUnit || 'g'}`;
}

// ---------- Navigation ----------
async function go(tab) {
  if (state.tab === 'scan' && tab !== 'scan') Scanner.stop();
  state.tab = tab;
  $$('#tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  window.scrollTo(0, 0);
  await render();
}
async function render() {
  const fn = { home: renderHome, diary: renderDiary, scan: renderScan, progress: renderProgress, health: renderHealth }[state.tab];
  try { await fn(); } catch (e) { console.error(e); view().innerHTML = `<div class="card">Something went wrong: ${esc(e.message)}</div>`; }
}

// ---------- Home ----------
function ring(pct, remaining) {
  const r = 54, c = 2 * Math.PI * r, over = remaining < 0;
  return `<div class="ring-wrap"><svg viewBox="0 0 128 128" class="ring"><circle cx="64" cy="64" r="${r}" class="ring-bg"/>
    <circle cx="64" cy="64" r="${r}" class="ring-fg ${over ? 'over' : ''}" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${(c * (1 - Math.max(0, Math.min(1, pct)))).toFixed(1)}" transform="rotate(-90 64 64)"/></svg>
    <div class="ring-center"><div class="big">${fmt(Math.abs(remaining))}</div><div class="lbl">${over ? 'over goal' : 'remaining'}</div></div></div>`;
}
function macroBar(label, v, goal, unit, color, missing) {
  const pct = goal ? Math.min(100, v / goal * 100) : 0;
  return `<div class="bar-row"><div class="spread"><span>${label}${missing ? ' <span class="pill warn">incomplete</span>' : ''}</span>
    <span class="muted"><b style="color:var(--text)">${fmt(v)}</b> / ${fmt(goal)} ${unit}</span></div>
    <div class="bar"><i style="width:${pct}%; --c:${color}"></i></div></div>`;
}
function waterCard(day) {
  const g = state.settings.waterGoal;
  return `<section class="card"><div class="spread"><h2 style="margin:0">Water</h2><span class="muted"><b style="color:var(--text)">${fmt(day.waterOz)}</b> / ${fmt(g)} oz</span></div>
    <div class="bar"><i style="width:${g ? Math.min(100, day.waterOz / g * 100) : 0}%; --c:var(--blue)"></i></div>
    <div class="row" style="margin-top:12px"><button class="btn" data-act="water" data-v="-8">− 8</button>
    <button class="btn secondary" style="flex:1" data-act="water" data-v="8">+ 8 oz</button>
    <button class="btn secondary" style="flex:1" data-act="water" data-v="16">+ 16 oz</button></div></section>`;
}
async function addWater(date, delta) {
  const day = await getDay(date);
  day.waterOz = Math.max(0, (day.waterOz || 0) + delta);
  await DB.put('days', day);
  render();
}
async function renderHome() {
  const date = dateStr(), s = state.settings;
  const entries = await entriesFor(date);
  const { t, missing } = sumNuts(entries);
  const day = await getDay(date);
  const foods = await DB.all('foods');
  const byRecent = (a, b) => (b.lastUsed || 0) - (a.lastUsed || 0);
  const favs = foods.filter(f => f.favorite).sort(byRecent).slice(0, 12);
  const recents = foods.filter(f => !f.favorite && f.lastUsed).sort(byRecent).slice(0, 8);
  const pending = await DB.all('pending');
  const lastBackup = (await DB.get('kv', 'lastBackup'))?.at;
  const remaining = s.kcal - t.kcal;
  const quick = [...favs.map(f => ({ f, star: true })), ...recents.map(f => ({ f }))];

  view().innerHTML = `
  <header class="topbar"><div><div class="eyebrow">${esc(longDate(date))}</div><h1>Today</h1></div>
    <button class="icon-btn" data-act="settings" aria-label="Settings">${ICON.gear}</button></header>

  <section class="card ring-card">${ring(s.kcal ? t.kcal / s.kcal : 0, remaining)}
    <div class="ring-stats"><div><span class="big">${fmt(t.kcal)}</span><span class="lbl">calories eaten${missing.kcal ? ' (some missing)' : ''}</span></div>
    <div><span class="big">${fmt(s.kcal)}</span><span class="lbl">daily goal</span></div></div></section>

  <section class="actions">
    <button class="action hero" data-act="scan">${ICON.barcode}Scan Barcode</button>
    <button class="action" data-act="add">${ICON.plus}Add Food</button>
    <button class="action" data-act="photo">${ICON.camera}Barcode Photo</button>
  </section>

  ${quick.length ? `<section class="card"><h2>Quick add</h2><div class="chips">${quick.map(q => `<button class="chip" data-act="quick" data-id="${q.f.id}">${q.star ? '★ ' : ''}${esc(q.f.name)}</button>`).join('')}</div>
    <p class="tiny muted" style="margin:8px 0 0">Tap a food, then “Add”. Star foods to keep them here.</p></section>` : ''}

  <section class="card"><h2>Nutrients today</h2>
    ${macroBar('Protein', t.protein, s.protein, 'g', 'var(--blue)', missing.protein)}
    ${macroBar('Carbs', t.carbs, s.carbs, 'g', 'var(--orange)', missing.carbs)}
    ${macroBar('Fat', t.fat, s.fat, 'g', 'var(--purple)', missing.fat)}
    ${macroBar('Fiber', t.fiber, s.fiber, 'g', 'var(--teal)', missing.fiber)}
  </section>

  ${waterCard(day)}

  ${pending.length ? `<section class="card"><h2>Scans waiting for internet</h2><p class="small muted">${pending.length} barcode${pending.length > 1 ? 's were' : ' was'} scanned offline.</p>
    <button class="btn secondary block" data-act="tab-scan">Look them up</button></section>` : ''}

  ${(!lastBackup || Date.now() - lastBackup > 7 * 864e5) && (entries.length || foods.length) ? `<div class="warnbox">${lastBackup ? 'Your last backup was over a week ago.' : 'You haven’t made a backup yet.'} Your data lives only on this device.
    <button class="link" data-act="settings">Back up now</button></div>` : ''}
  `;
  view().onclick = async e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const a = b.dataset.act;
    if (a === 'settings') openSettings();
    else if (a === 'scan' || a === 'tab-scan') go('scan');
    else if (a === 'add') openAddFood({ date: dateStr() });
    else if (a === 'photo') pickBarcodePhoto();
    else if (a === 'water') addWater(date, Number(b.dataset.v));
    else if (a === 'quick') { const f = await DB.get('foods', b.dataset.id); if (f) openLogSheet(f, { date: dateStr() }); }
  };
}

// ---------- Diary ----------
async function renderDiary() {
  const date = state.date;
  const entries = await entriesFor(date);
  const { t, missing } = sumNuts(entries);
  const day = await getDay(date);
  const anyMissing = CORE.some(k => missing[k]);
  const meal = m => {
    const list = entries.filter(e => e.meal === m);
    const kc = list.reduce((s, e) => s + (e.nutrients?.kcal || 0), 0);
    return `<section class="card"><div class="meal-head"><h2>${MEAL_LABEL[m]}</h2>
      <div class="row"><span class="muted small">${list.length ? fmt(kc) + ' kcal' : ''}</span>
      <button class="icon-btn" style="background:var(--accent-soft); color:var(--accent)" data-act="add" data-meal="${m}" aria-label="Add to ${MEAL_LABEL[m]}">${ICON.plus}</button></div></div>
      ${list.length ? `<ul class="list">${list.map(e => `<li><button class="item" data-act="entry" data-id="${e.id}">
        ${thumb(e.food?.imageUrl)}<div class="grow"><div class="t">${esc(e.food?.name || 'Food')}</div>
        <div class="s">${esc([e.food?.brand, amountLabel(e)].filter(Boolean).join(' · '))}</div></div>
        <div class="v">${e.nutrients?.kcal == null ? '<span class="pill warn">no kcal</span>' : fmt(e.nutrients.kcal)}</div></button></li>`).join('')}</ul>`
        : `<button class="link" data-act="copy-meal" data-meal="${m}">Repeat ${MEAL_LABEL[m].toLowerCase()} from ${esc(niceDate(addDays(date, -1)).toLowerCase())}</button>`}
    </section>`;
  };
  view().innerHTML = `
  <header class="topbar"><h1>Food Diary</h1></header>
  <div class="datebar"><button data-act="prev" aria-label="Previous day">‹</button>
    <button class="datelabel" data-act="today">${esc(niceDate(date))}</button>
    <button data-act="next" aria-label="Next day">›</button></div>
  <section class="card totals">
    ${[['kcal', 'kcal'], ['protein', 'protein'], ['carbs', 'carbs'], ['fat', 'fat'], ['fiber', 'fiber']].map(([k, l]) =>
      `<div><div class="big">${fmt(t[k])}</div><div class="lbl">${l}</div></div>`).join('')}
  </section>
  ${anyMissing ? `<div class="warnbox">Some entries are missing nutrition values, so these totals may be low. Tap an entry marked “no kcal” to correct it.</div>` : ''}
  ${MEALS.map(([m]) => meal(m)).join('')}
  ${waterCard(day)}
  ${entries.length ? '' : `<button class="btn secondary block" data-act="copy-all">Copy all meals from ${esc(niceDate(addDays(date, -1)).toLowerCase())}</button>`}
  `;
  view().onclick = async e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const a = b.dataset.act;
    if (a === 'prev') { state.date = addDays(state.date, -1); render(); }
    else if (a === 'next') { state.date = addDays(state.date, 1); render(); }
    else if (a === 'today') { state.date = dateStr(); render(); }
    else if (a === 'add') openAddFood({ meal: b.dataset.meal, date });
    else if (a === 'water') addWater(date, Number(b.dataset.v));
    else if (a === 'entry') { const en = await DB.get('entries', b.dataset.id); if (en) openLogSheet(en.food, { entry: en }); }
    else if (a === 'copy-meal') copyFromPrevious(date, b.dataset.meal);
    else if (a === 'copy-all') copyFromPrevious(date, null);
  };
}
async function copyFromPrevious(date, meal) {
  const prev = addDays(date, -1);
  const src = (await entriesFor(prev)).filter(e => !meal || e.meal === meal);
  if (!src.length) { toast(`Nothing logged ${meal ? 'for ' + MEAL_LABEL[meal].toLowerCase() + ' ' : ''}on ${niceDate(prev).toLowerCase()}`); return; }
  if (!confirm(`Copy ${src.length} item${src.length > 1 ? 's' : ''} from ${niceDate(prev).toLowerCase()} to ${niceDate(date).toLowerCase()}?`)) return;
  let i = 0;
  for (const e of src) await DB.put('entries', { ...e, id: uid(), date, createdAt: Date.now() + i++, updatedAt: Date.now() });
  toast('Copied'); render();
}

// ---------- Scanner ----------
const Scanner = {
  reader: null, controls: null, busy: false, gen: 0,
  async lib() {
    if (window.ZXingBrowser && ZXingBrowser.BrowserMultiFormatReader) return { kind: 'browser', R: ZXingBrowser.BrowserMultiFormatReader };
    if (!window.ZXing) { try { await loadScript(ZXING_LIBRARY_FALLBACK); } catch (e) { /* handled below */ } }
    if (window.ZXing && ZXing.BrowserMultiFormatReader) return { kind: 'library', R: ZXing.BrowserMultiFormatReader };
    throw new Error('The barcode scanner could not load. Open the app once while online so it can be saved for offline use. You can still type a barcode below.');
  },
  async start(video, onCode) {
    this.stop();
    const myGen = ++this.gen;
    const { kind, R } = await this.lib();
    if (myGen !== this.gen) return;
    this.busy = false;
    const reader = new R();
    this.reader = reader;
    const constraints = { audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } };
    const cb = result => {
      if (!result || this.busy || myGen !== this.gen) return;
      const text = String(result.getText()).trim();
      if (!isBarcode(text)) return;
      this.busy = true;
      this.stop();
      onCode(text);
    };
    if (kind === 'browser') {
      const controls = await reader.decodeFromConstraints(constraints, video, cb);
      this.controls = controls;
    } else {
      this.controls = { stop: () => reader.reset() };
      await reader.decodeFromConstraints(constraints, video, cb);
    }
    if (myGen !== this.gen) this.stopHard();
  },
  stop() { this.gen++; this.stopHard(); },
  stopHard() {
    try { this.controls && this.controls.stop(); } catch (e) { /* ignore */ }
    this.controls = null;
    const v = document.getElementById('scan-video');
    if (v && v.srcObject) { try { v.srcObject.getTracks().forEach(t => t.stop()); } catch (e) { /* ignore */ } v.srcObject = null; }
  },
  async decodeFile(file) {
    const { R } = await this.lib();
    for (const max of [1600, 1000, 2400]) {
      try {
        const url = await downscale(file, max);
        const res = await new R().decodeFromImageUrl(url);
        const text = String(res.getText()).trim();
        if (isBarcode(text)) return text;
      } catch (e) { /* try next size */ }
    }
    return null;
  },
};
function downscale(file, max) {
  return new Promise((res, rej) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url); res(c.toDataURL('image/jpeg', 0.92));
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Could not read that photo')); };
    img.src = url;
  });
}
function cameraErrorText(err) {
  const n = err && err.name;
  if (n === 'NotAllowedError') return 'Camera access was blocked. Allow the camera for this site (iPhone Settings → Apps → Safari → Camera, or the “aA” menu in Safari), then tap Restart camera.';
  if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'No usable camera was found. Use a photo or type the barcode instead.';
  if (!window.isSecureContext) return 'The camera only works over HTTPS. Open the app from its https:// address.';
  return (err && err.message) || 'Camera could not start.';
}
async function startCamera() {
  const v = document.getElementById('scan-video'), msg = document.getElementById('scan-msg');
  if (!v || sheets.length || document.hidden) return;
  msg.textContent = 'Starting camera…';
  try {
    await Scanner.start(v, code => { const m = document.getElementById('scan-msg'); if (m) m.textContent = 'Found ' + code + ' — looking it up…'; handleBarcode(code); });
    const m = document.getElementById('scan-msg'); if (m && !Scanner.busy && Scanner.controls) m.textContent = 'Point the camera at a barcode';
  } catch (err) {
    const m = document.getElementById('scan-msg'); if (m) m.textContent = cameraErrorText(err);
  }
}
function pickBarcodePhoto() {
  const inp = $('#photo-input');
  inp.value = '';
  inp.onchange = async () => {
    const f = inp.files && inp.files[0]; if (!f) return;
    toast('Reading barcode…', 6000);
    try {
      const code = await Scanner.decodeFile(f);
      if (code) { toast('Found ' + code); handleBarcode(code); }
      else toast('No barcode found in that photo. Try closer, flatter, and in good light.', 4000);
    } catch (e) { toast(e.message, 4000); }
  };
  inp.click();
}
async function renderScan() {
  const pending = await DB.all('pending');
  view().innerHTML = `
  <header class="topbar"><h1>Scan Food</h1></header>
  <div class="scanner"><video id="scan-video" playsinline muted autoplay></video><div class="scan-frame"></div>
    <div id="scan-msg" class="scan-msg">Starting camera…</div></div>
  <div class="row" style="margin-bottom:14px"><button class="btn secondary" style="flex:1" data-act="restart">Restart camera</button>
    <button class="btn secondary" style="flex:1" data-act="photo">Use a photo</button></div>
  <section class="card"><h2>Type a barcode</h2>
    <form id="manual-form" class="row" autocomplete="off"><input class="in" id="manual-code" inputmode="numeric" pattern="[0-9]*" placeholder="e.g. 012345678905" style="flex:1">
    <button class="btn primary" type="submit">Look up</button></form></section>
  ${pending.length ? `<section class="card"><h2>Scanned while offline</h2><ul class="list">${pending.map(p => `<li class="spread"><span class="item" style="flex:1">${esc(p.barcode)}</span>
    <button class="link" data-act="lookup" data-code="${esc(p.barcode)}">Look up</button><button class="link" style="color:var(--red)" data-act="drop" data-code="${esc(p.barcode)}">Remove</button></li>`).join('')}</ul></section>` : ''}
  <p class="small muted">Hold the barcode 4–8 inches away in good light. Supports UPC-A, UPC-E, EAN-13 and EAN-8. Foods you have scanned before open instantly, even offline.</p>
  `;
  view().onclick = e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const a = b.dataset.act;
    if (a === 'restart') startCamera();
    else if (a === 'photo') pickBarcodePhoto();
    else if (a === 'lookup') handleBarcode(b.dataset.code);
    else if (a === 'drop') DB.del('pending', b.dataset.code).then(render);
  };
  $('#manual-form').onsubmit = e => {
    e.preventDefault();
    const code = $('#manual-code').value.replace(/\D/g, '');
    if (!isBarcode(code)) { toast('Enter 8, 12, 13 or 14 digits'); return; }
    handleBarcode(code);
  };
  startCamera();
}
async function handleBarcode(code) {
  const cands = barcodeCandidates(code);
  for (const c of cands) {
    const local = await DB.byIndex('foods', 'barcode', c);
    if (local.length) { openLogSheet(local[0], {}); return; }
  }
  if (!navigator.onLine) { await queuePending(code); return; }
  toast('Looking up ' + code + '…', 8000);
  try {
    let food = null;
    for (const c of cands) { food = await lookupOFF(c); if (food) break; }
    $('#toast').hidden = true;
    if (food) {
      food.barcode = code;
      await DB.put('foods', food);
      await DB.del('pending', code);
      openLogSheet(food, {});
    } else {
      await DB.del('pending', code);
      openNotFound(code);
    }
  } catch (err) {
    if (err instanceof TypeError) { await queuePending(code); return; } // network failure
    toast(err.message, 4000);
    if (state.tab === 'scan' && !sheets.length) setTimeout(startCamera, 1500);
  }
}
async function queuePending(code) {
  await DB.put('pending', { barcode: code, at: Date.now() });
  toast('You’re offline. Barcode saved — look it up when you’re back online.', 4000);
  if (state.tab === 'scan') render();
}
function openNotFound(code) {
  const el = openSheet(`
    <div class="sheet-head"><button class="link" data-act="close">Close</button><div class="sheet-title">Not found</div><span style="width:50px"></span></div>
    <div class="card"><p style="margin-top:0"><b>${esc(code)}</b> isn’t in Open Food Facts yet.</p>
    <p class="small muted" style="margin-bottom:0">You can add it from the package’s Nutrition Facts label. It will be saved to your foods, so the next scan of this barcode finds it instantly.
    (Automatic label reading with the camera is planned for Phase 2.)</p></div>
    <div class="stack"><button class="btn primary big" data-act="create">Enter it from the label</button>
    <button class="btn secondary" data-act="again">Scan something else</button></div>`);
  el.onclick = e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    if (b.dataset.act === 'close' || b.dataset.act === 'again') closeSheet();
    if (b.dataset.act === 'create') { closeSheet(); openEditFood(null, { barcode: code, then: f => openLogSheet(f, {}) }); }
  };
}

// ---------- Log food sheet ----------
async function openLogSheet(foodIn, opts = {}) {
  const entry = opts.entry || null;
  const libFood = foodIn.id ? await DB.get('foods', foodIn.id) : null;
  const food = entry ? entry.food : (libFood || foodIn);
  const bu = food.baseUnit || 'g';
  const canS = canUseServing(food), canG = canUseGrams(food);
  let unit = entry ? entry.unit : (canS ? 'serving' : canG ? 'g' : 'serving');
  let amount = entry ? entry.amount : (unit === 'serving' ? 1 : (food.servingGrams || 100));
  let meal = entry?.meal || opts.meal || state.pendingMeal || defaultMeal();
  let date = entry?.date || opts.date || (state.tab === 'diary' ? state.date : dateStr());
  let fav = !!libFood?.favorite;
  const miss = missingLabels(food);

  const el = openSheet(`
    <div class="sheet-head"><button class="link" data-act="close">Cancel</button>
      <div class="sheet-title">${entry ? 'Edit entry' : 'Log food'}</div>
      ${libFood ? `<button class="icon-btn" data-act="fav" aria-label="Favorite">${fav ? ICON.starOn : ICON.star}</button>` : '<span style="width:44px"></span>'}</div>
    <div class="food-hero">${food.imageUrl ? `<img src="${esc(food.imageUrl)}" alt="" referrerpolicy="no-referrer">` : '<div class="ph">🍽</div>'}
      <div><div class="food-name">${esc(food.name)}</div><div class="food-brand">${esc(food.brand || '')}</div>
      <div class="row" style="margin-top:6px; gap:6px"><span class="pill">${esc(food.source || 'Custom')}</span>${food.incomplete ? '<span class="pill warn">Incomplete</span>' : '<span class="pill ok">Complete</span>'}</div></div></div>
    ${miss.length ? `<div class="warnbox">Not listed in this record: ${esc(miss.join(', '))}. These show as “—” and are not counted in totals.
      <button class="link" data-act="edit-food">Correct from the label</button></div>` : ''}
    <div class="card">
      <div class="kv" style="border-top:0"><span class="muted">Serving size</span><span>${esc(food.servingLabel || (food.servingGrams ? food.servingGrams + ' ' + bu : 'Not listed'))}</span></div>
      <div class="kv"><span class="muted">Servings per container</span><span>${food.servingsPerContainer ? (food.spcEstimated ? '≈ ' : '') + fmt(food.servingsPerContainer, 1) : 'Not listed'}</span></div>
      ${food.packageSize ? `<div class="kv"><span class="muted">Package</span><span>${esc(food.packageSize)}</span></div>` : ''}
      ${food.barcode ? `<div class="kv"><span class="muted">Barcode</span><span>${esc(food.barcode)}</span></div>` : ''}
    </div>
    ${!canS && !canG ? `<div class="warnbox">This record has no nutrition numbers. Enter them from the label so this food counts toward your totals.</div>` : ''}
    <label class="f">Amount eaten</label>
    <div class="seg" id="unit-seg">${canS ? '<button data-unit="serving">Servings</button>' : ''}${canG ? `<button data-unit="g">${bu === 'ml' ? 'Milliliters' : 'Grams'}</button>` : ''}</div>
    <div class="stepper"><button data-act="minus" aria-label="Less">−</button><input class="in" id="amt" type="number" inputmode="decimal" step="any" min="0"><button data-act="plus" aria-label="More">+</button></div>
    <div class="quick" id="quick"></div>
    <label class="f">Meal</label>
    <div class="seg" id="meal-seg">${MEALS.map(([m, l]) => `<button data-meal="${m}">${l}</button>`).join('')}</div>
    <label class="f">Date</label><input class="in" type="date" id="logdate">
    <label class="f">Nutrition for this amount</label>
    <div class="card" style="padding:6px 16px"><table class="nut" id="nut"></table></div>
    <div class="stack">
      <button class="btn primary big" data-act="save" id="save-btn"></button>
      <button class="btn secondary" data-act="edit-food">Edit food details</button>
      ${entry ? '<button class="btn danger" data-act="delete">Delete entry</button>' : ''}
    </div>`, opts.onClose);

  const amt = $('#amt', el);
  $('#logdate', el).value = date;
  function update() {
    amount = num(amt.value) ?? 0;
    $$('#unit-seg button', el).forEach(b => b.classList.toggle('on', b.dataset.unit === unit));
    $$('#meal-seg button', el).forEach(b => b.classList.toggle('on', b.dataset.meal === meal));
    const n = calcNutrients(food, amount, unit);
    $('#nut', el).innerHTML = NUTS.map(([k, l, u, d]) => `<tr class="${k === 'kcal' ? 'main' : ''}"><td>${l}</td><td>${n[k] == null ? '<span class="na">—</span>' : fmt(n[k], d) + (k === 'kcal' ? '' : ' ' + u)}</td></tr>`).join('');
    const qs = unit === 'serving' ? [0.5, 1, 1.5, 2] : (food.servingGrams ? [food.servingGrams / 2, food.servingGrams, food.servingGrams * 2, 100].map(x => Math.round(x)) : [50, 100, 150, 200]);
    $('#quick', el).innerHTML = [...new Set(qs)].map(q => `<button data-q="${q}">${unit === 'serving' ? (q === 0.5 ? '½' : q === 1.5 ? '1½' : q) : q + ' ' + bu}</button>`).join('');
    $('#save-btn', el).textContent = entry ? 'Update entry' : `Add to ${MEAL_LABEL[meal]}`;
    $('#save-btn', el).disabled = !(amount > 0);
  }
  amt.value = String(Math.round(amount * 100) / 100);
  amt.oninput = update;
  $('#logdate', el).onchange = e => { if (e.target.value) date = e.target.value; };
  update();

  el.onclick = async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.unit && b.dataset.unit !== unit) {
      // convert amount between units when we know the serving weight
      if (food.servingGrams) amount = b.dataset.unit === 'g' ? Math.round(amount * food.servingGrams) : Math.round(amount / food.servingGrams * 100) / 100;
      else amount = b.dataset.unit === 'g' ? 100 : 1;
      unit = b.dataset.unit; amt.value = String(amount); update(); return;
    }
    if (b.dataset.meal) { meal = b.dataset.meal; update(); return; }
    if (b.dataset.q) { amt.value = b.dataset.q; update(); return; }
    const a = b.dataset.act;
    const step = unit === 'serving' ? 0.5 : (food.servingGrams && food.servingGrams < 40 ? 5 : 10);
    if (a === 'close') closeSheet();
    else if (a === 'minus') { amt.value = String(Math.max(0, Math.round(((num(amt.value) || 0) - step) * 100) / 100)); update(); }
    else if (a === 'plus') { amt.value = String(Math.round(((num(amt.value) || 0) + step) * 100) / 100); update(); }
    else if (a === 'fav' && libFood) {
      fav = !fav; libFood.favorite = fav; await DB.put('foods', libFood);
      b.innerHTML = fav ? ICON.starOn : ICON.star; toast(fav ? 'Added to favorites' : 'Removed from favorites');
    } else if (a === 'edit-food') {
      const target = libFood || (await DB.get('foods', food.id)) || food;
      openEditFood(target, {
        then: async f => {
          closeSheet(); // close this log sheet; reopen with fresh data
          if (entry) { const fresh = await DB.get('entries', entry.id); openLogSheet(fresh ? fresh.food : f, { ...opts, entry: fresh || entry }); }
          else openLogSheet(f, opts);
        },
      });
    } else if (a === 'delete' && entry) {
      if (!confirm('Delete this entry?')) return;
      await DB.del('entries', entry.id); closeSheet(); toast('Entry deleted'); render();
    } else if (a === 'save') {
      if (!(amount > 0)) return;
      const nutrients = calcNutrients(food, amount, unit);
      const rec = entry ? { ...entry } : { id: uid(), createdAt: Date.now() };
      Object.assign(rec, { date, meal, foodId: food.id, food: snapshot(food), amount, unit, baseUnit: bu, nutrients, updatedAt: Date.now() });
      await DB.put('entries', rec);
      if (libFood && !entry) { libFood.useCount = (libFood.useCount || 0) + 1; libFood.lastUsed = Date.now(); await DB.put('foods', libFood); }
      state.pendingMeal = null;
      closeAllSheets();
      toast(entry ? 'Entry updated' : `Added to ${MEAL_LABEL[meal]}${date !== dateStr() ? ' · ' + niceDate(date) : ''}`);
      render();
    }
  };
}

// ---------- Create / edit food ----------
function openEditFood(food, opts = {}) {
  const isNew = !food;
  const f = food ? JSON.parse(JSON.stringify(food)) : {
    id: uid(), name: '', brand: '', barcode: opts.barcode || '', servingLabel: '', servingGrams: null, baseUnit: 'g',
    servingsPerContainer: null, per100: null, perServing: null, imageUrl: '', source: 'Custom', favorite: false,
    useCount: 0, lastUsed: 0, createdAt: Date.now(),
  };
  const v = x => (x == null ? '' : String(Math.round(x * 100) / 100));
  const el = openSheet(`
    <div class="sheet-head"><button class="link" data-act="close">Cancel</button><div class="sheet-title">${isNew ? 'New food' : 'Edit food'}</div>
      <button class="link" data-act="save">Save</button></div>
    <p class="small muted" style="margin:4px 0 0">Copy numbers exactly from the Nutrition Facts label. Leave a box blank if the label doesn’t list it — blanks are shown as missing, never guessed.</p>
    <label class="f">Name *</label><input class="in" id="ef-name" value="${esc(f.name === 'Unnamed product' ? '' : f.name)}" placeholder="e.g. Greek Yogurt, Plain">
    <label class="f">Brand</label><input class="in" id="ef-brand" value="${esc(f.brand)}">
    <label class="f">Barcode</label><input class="in" id="ef-barcode" inputmode="numeric" value="${esc(f.barcode || '')}">
    <label class="f">Serving size as printed</label><input class="in" id="ef-slabel" value="${esc(f.servingLabel)}" placeholder="e.g. 1 cup (227g)">
    <div class="grid2"><div><label class="f">Serving weight</label><input class="in" id="ef-sg" type="number" inputmode="decimal" step="any" value="${v(f.servingGrams)}"></div>
      <div><label class="f">Unit</label><select class="in" id="ef-unit"><option value="g"${f.baseUnit !== 'ml' ? ' selected' : ''}>grams</option><option value="ml"${f.baseUnit === 'ml' ? ' selected' : ''}>milliliters</option></select></div></div>
    <label class="f">Servings per container</label><input class="in" id="ef-spc" type="number" inputmode="decimal" step="any" value="${f.spcEstimated ? '' : v(f.servingsPerContainer)}" placeholder="${f.spcEstimated && f.servingsPerContainer ? '≈ ' + v(f.servingsPerContainer) + ' (estimated)' : ''}">
    <label class="f">Nutrition</label>
    <div class="card"><div class="nutgrid"><span class="h">Nutrient</span><span class="h">Per serving</span><span class="h">Per 100 <span id="ef-u">${f.baseUnit === 'ml' ? 'ml' : 'g'}</span></span>
      ${NUTS.map(([k, l, u]) => `<span>${l} <span class="muted tiny">${u}</span></span>
        <input class="in" data-ps="${k}" type="number" inputmode="decimal" step="any" value="${v(f.perServing?.[k])}">
        <input class="in" data-p100="${k}" type="number" inputmode="decimal" step="any" value="${v(f.per100?.[k])}">`).join('')}
    </div><p class="tiny muted" style="margin:10px 0 0">US labels list values per serving — fill the “Per serving” column and the serving weight. Sodium is in milligrams.</p></div>
    <div class="stack"><button class="btn primary big" data-act="save">Save food</button>
    ${!isNew ? '<button class="btn danger" data-act="delete">Delete from my foods</button>' : ''}</div>`);
  $('#ef-unit', el).onchange = e => { $('#ef-u', el).textContent = e.target.value; };
  el.onclick = async e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const a = b.dataset.act;
    if (a === 'close') { closeSheet(); return; }
    if (a === 'delete') {
      if (!confirm('Delete this food from your saved foods? Past diary entries keep their values.')) return;
      await DB.del('foods', f.id); closeAllSheets(); toast('Food deleted'); render(); return;
    }
    if (a !== 'save') return;
    const name = $('#ef-name', el).value.trim();
    if (!name) { toast('Please enter a name'); $('#ef-name', el).focus(); return; }
    const ps = {}, p100 = {};
    $$('[data-ps]', el).forEach(i => { ps[i.dataset.ps] = num(i.value); });
    $$('[data-p100]', el).forEach(i => { p100[i.dataset.p100] = num(i.value); });
    f.name = name;
    f.brand = $('#ef-brand', el).value.trim();
    f.barcode = $('#ef-barcode', el).value.replace(/\D/g, '') || null;
    f.servingLabel = $('#ef-slabel', el).value.trim();
    f.servingGrams = num($('#ef-sg', el).value);
    f.baseUnit = $('#ef-unit', el).value;
    const spc = num($('#ef-spc', el).value);
    if (spc != null) { f.servingsPerContainer = spc; f.spcEstimated = false; }
    f.perServing = hasAny(ps) ? ps : null;
    f.per100 = hasAny(p100) ? p100 : null;
    if (!isNew && f.source && !/edited|Custom/.test(f.source)) f.source += ' (edited)';
    f.incomplete = isIncomplete(f);
    f.updatedAt = Date.now();
    await DB.put('foods', f);
    if (f.barcode) await DB.del('pending', f.barcode);
    // Offer to fix diary entries that used this food
    const used = (await DB.all('entries')).filter(en => en.foodId === f.id);
    if (used.length && confirm(`Update ${used.length} diary entr${used.length > 1 ? 'ies' : 'y'} that used this food with the corrected values?`)) {
      for (const en of used) { en.food = snapshot(f); en.nutrients = calcNutrients(f, en.amount, en.unit); en.baseUnit = f.baseUnit; await DB.put('entries', en); }
    }
    closeSheet();
    toast(isNew ? 'Food saved' : 'Food updated');
    if (opts.then) opts.then(f); else render();
  };
}

// ---------- Add food (library + online search) ----------
async function openAddFood(opts = {}) {
  const foods = await DB.all('foods');
  const el = openSheet(`
    <div class="sheet-head"><button class="link" data-act="close">Close</button><div class="sheet-title">Add Food${opts.meal ? ' · ' + MEAL_LABEL[opts.meal] : ''}</div><span style="width:50px"></span></div>
    <input class="in" id="af-q" type="search" placeholder="Search my foods" autocomplete="off">
    <div class="row" style="margin:10px 0"><button class="btn secondary" style="flex:1" data-act="scan">${'Scan barcode'}</button>
      <button class="btn secondary" style="flex:1" data-act="custom">Custom food</button></div>
    <div id="af-list"></div>
    <div class="card" id="af-online-card"><button class="btn block" data-act="online">${'Search Open Food Facts online'}</button>
      <p class="tiny muted" style="margin:8px 0 0">Online search sends your search words to Open Food Facts. Scanning a barcode is more accurate than searching by name.</p><div id="af-online"></div></div>`);
  const listEl = $('#af-list', el), q = $('#af-q', el);
  const row = f => `<li><button class="item" data-food="${f.id}">${thumb(f.imageUrl)}<div class="grow"><div class="t">${f.favorite ? '★ ' : ''}${esc(f.name)}</div>
    <div class="s">${esc([f.brand, f.servingLabel].filter(Boolean).join(' · '))}${f.incomplete ? ' · <span style="color:var(--orange)">incomplete</span>' : ''}</div></div></button></li>`;
  function draw() {
    const s = q.value.trim().toLowerCase();
    let html = '';
    if (!foods.length) html = '<div class="card small muted">No saved foods yet. Scan a barcode or create a custom food — everything you log is remembered here.</div>';
    else if (s) {
      const m = foods.filter(f => [f.name, f.brand, f.barcode].some(x => String(x || '').toLowerCase().includes(s)))
        .sort((a, b) => (b.useCount || 0) - (a.useCount || 0)).slice(0, 60);
      html = m.length ? `<div class="card"><ul class="list">${m.map(row).join('')}</ul></div>` : '<div class="card small muted">No matches in your foods. Try searching online below.</div>';
    } else {
      const favs = foods.filter(f => f.favorite).sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
      const recent = foods.filter(f => f.lastUsed && !f.favorite).sort((a, b) => b.lastUsed - a.lastUsed).slice(0, 15);
      const freq = foods.filter(f => (f.useCount || 0) >= 3 && !f.favorite).sort((a, b) => b.useCount - a.useCount).slice(0, 8);
      const rest = foods.filter(f => !f.lastUsed && !f.favorite).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 40);
      if (favs.length) html += `<div class="card"><h2>Favorites</h2><ul class="list">${favs.map(row).join('')}</ul></div>`;
      if (freq.length) html += `<div class="card"><h2>Frequent</h2><ul class="list">${freq.map(row).join('')}</ul></div>`;
      if (recent.length) html += `<div class="card"><h2>Recent</h2><ul class="list">${recent.map(row).join('')}</ul></div>`;
      if (rest.length) html += `<div class="card"><h2>Saved, not yet logged</h2><ul class="list">${rest.map(row).join('')}</ul></div>`;
    }
    listEl.innerHTML = html;
  }
  q.oninput = draw; draw();
  let online = [];
  el.onclick = async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.food) {
      const f = foods.find(x => x.id === b.dataset.food) || online.find(x => x.id === b.dataset.food);
      if (!f) return;
      if (online.includes(f)) {
        const existing = f.barcode ? (await DB.byIndex('foods', 'barcode', f.barcode))[0] : null;
        if (existing) { openLogSheet(existing, opts); return; }
        await DB.put('foods', f);
      }
      openLogSheet(f, opts); return;
    }
    const a = b.dataset.act;
    if (a === 'close') closeSheet();
    else if (a === 'scan') { state.pendingMeal = opts.meal || null; closeAllSheets(); go('scan'); }
    else if (a === 'custom') openEditFood(null, { then: f => openLogSheet(f, opts) });
    else if (a === 'online') {
      const term = q.value.trim();
      if (term.length < 2) { toast('Type a food name in the search box first'); q.focus(); return; }
      if (!navigator.onLine) { toast('Online search needs internet'); return; }
      const out = $('#af-online', el); out.innerHTML = '<p class="muted small">Searching…</p>';
      try {
        online = await searchOFF(term);
        out.innerHTML = online.length ? `<ul class="list" style="margin-top:8px">${online.map(row).join('')}</ul>` : '<p class="muted small">No results.</p>';
      } catch (err) { out.innerHTML = `<p class="small" style="color:var(--red)">${esc(err.message)}</p>`; }
    }
  };
}

// ---------- Progress (real 7-day data) ----------
async function renderProgress() {
  const s = state.settings, today = dateStr();
  const days = [];
  for (let i = 6; i >= 0; i--) { const d = addDays(today, -i); const es = await entriesFor(d); days.push({ d, n: es.length, ...sumNuts(es).t }); }
  const logged = days.filter(x => x.n);
  const avg = k => logged.length ? logged.reduce((a, x) => a + x[k], 0) / logged.length : null;
  const max = Math.max(s.kcal, ...days.map(x => x.kcal)) * 1.1 || 1;
  view().innerHTML = `
  <header class="topbar"><h1>Progress</h1></header>
  <section class="card"><div class="spread"><h2 style="margin:0">Calories, last 7 days</h2><span class="pill">goal ${fmt(s.kcal)}</span></div>
    <div class="week"><div class="goal-line" style="bottom:${(s.kcal / max * 100).toFixed(1)}%"></div>
    ${days.map(x => `<div class="col"><div class="b ${x.n ? '' : 'empty'}" style="height:${x.n ? Math.max(2, x.kcal / max * 100) : 2}%"></div></div>`).join('')}</div>
    <div class="week-labels">${days.map(x => `<div>${parseD(x.d).toLocaleDateString(undefined, { weekday: 'narrow' })}</div>`).join('')}</div></section>
  <section class="card"><h2>Daily averages</h2>
    <p class="small muted" style="margin-top:0">Based on ${logged.length} day${logged.length === 1 ? '' : 's'} with entries this week (days with nothing logged are left out).</p>
    <div class="kv" style="border-top:0"><span>Calories</span><span>${fmt(avg('kcal'))}</span></div>
    <div class="kv"><span>Protein</span><span>${fmt(avg('protein'))} g</span></div>
    <div class="kv"><span>Carbohydrates</span><span>${fmt(avg('carbs'))} g</span></div>
    <div class="kv"><span>Fat</span><span>${fmt(avg('fat'))} g</span></div>
    <div class="kv"><span>Fiber</span><span>${fmt(avg('fiber'))} g</span></div></section>
  <section class="card"><h2>Coming in Phase 3 <span class="pill">planned</span></h2>
    <p class="small muted" style="margin:0">Weight log with 7-day average and 30-day trend, total and percent lost, body measurements (waist, chest, neck, hips, thigh), goals, and long-term graphs. Plateaus will only be flagged from the longer trend, not day-to-day swings.</p></section>`;
  view().onclick = null;
}

// ---------- Health (planned) ----------
async function renderHealth() {
  view().innerHTML = `
  <header class="topbar"><h1>Health</h1></header>
  <section class="card"><h2>Medication journal <span class="pill">planned · Phase 3</span></h2>
    <p class="small muted" style="margin:0">Medication name, prescribed dose, administration dates, side effects, appetite changes, nausea or constipation, and weight over time — organized as a report to share with your healthcare provider. It will record, not recommend, doses.</p></section>
  <section class="card"><h2>Apple Health <span class="pill">planned · Phase 3</span></h2>
    <p class="small muted" style="margin:0">Web apps can’t read Apple Health directly — Apple only allows that for native apps. Phase 3 will import the export file from the Health app (steps, weight, resting heart rate, exercise, sleep), and can use an iPhone Shortcut to send daily numbers here without a native app.</p></section>
  <section class="card"><h2>What works today</h2><ul class="status-list small">${FEATURES.done.map(x => `<li>${esc(x)}</li>`).join('')}</ul></section>`;
  view().onclick = null;
}

// ---------- Settings, backup, privacy ----------
function toB64(u8) { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }
function fromB64(s) { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
const KDF_ITER = 310000;
async function deriveKey(pass, salt, iterations = KDF_ITER) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function encryptBackup(pass) {
  const data = {};
  for (const s of DB.STORES) data[s] = await DB.all(s);
  const payload = new TextEncoder().encode(JSON.stringify({ app: 'nutritrack', version: APP_VERSION, exportedAt: new Date().toISOString(), data }));
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pass, salt);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, payload));
  return JSON.stringify({ format: 'nutritrack-encrypted-backup', v: 1, kdf: 'PBKDF2-SHA256', iterations: KDF_ITER, cipher: 'AES-256-GCM', salt: toB64(salt), iv: toB64(iv), ciphertext: toB64(ct) });
}
async function decryptBackup(text, pass) {
  const o = JSON.parse(text);
  if (o.format !== 'nutritrack-encrypted-backup') throw new Error('This isn’t a NutriTrack backup file.');
  const key = await deriveKey(pass, fromB64(o.salt), o.iterations || KDF_ITER);
  let pt;
  try { pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(o.iv) }, key, fromB64(o.ciphertext)); }
  catch (e) { throw new Error('Wrong passphrase, or the file is damaged.'); }
  return JSON.parse(new TextDecoder().decode(pt));
}
function askPassphrase({ title, confirmIt, note }) {
  return new Promise(resolve => {
    let done = false;
    const el = openSheet(`
      <div class="sheet-head"><button class="link" data-act="close">Cancel</button><div class="sheet-title">${esc(title)}</div><span style="width:50px"></span></div>
      <p class="small muted">${esc(note)}</p>
      <form id="pp-form" autocomplete="off"><label class="f">Passphrase</label><input class="in" id="pp1" type="password" autocomplete="new-password">
      ${confirmIt ? '<label class="f">Repeat passphrase</label><input class="in" id="pp2" type="password" autocomplete="new-password">' : ''}
      <div class="stack"><button class="btn primary big" type="submit">Continue</button></div></form>`, () => { if (!done) resolve(null); });
    setTimeout(() => $('#pp1', el).focus(), 300);
    el.onclick = e => { if (e.target.closest('[data-act="close"]')) closeSheet(); };
    $('#pp-form', el).onsubmit = e => {
      e.preventDefault();
      const p1 = $('#pp1', el).value;
      if (confirmIt) {
        if (p1.length < 8) { toast('Use at least 8 characters'); return; }
        if (p1 !== $('#pp2', el).value) { toast('Passphrases don’t match'); return; }
      }
      if (!p1) return;
      done = true; closeSheet(); resolve(p1);
    };
  });
}
async function doBackup() {
  const pass = await askPassphrase({ title: 'Encrypted backup', confirmIt: true, note: 'Choose a passphrase. The backup is encrypted on this phone before it is saved, so it’s safe in OneDrive or iCloud Drive. If you forget the passphrase, the backup cannot be opened — not even by you.' });
  if (!pass) return;
  try {
    toast('Encrypting…', 8000);
    const text = await encryptBackup(pass);
    const ok = await shareOrDownload(text, `nutritrack-backup-${dateStr()}.json`, 'application/json');
    $('#toast').hidden = true;
    if (ok) { await DB.put('kv', { key: 'lastBackup', at: Date.now() }); toast('Backup ready — choose “Save to Files” → OneDrive', 3500); }
  } catch (e) { toast('Backup failed: ' + e.message, 4000); }
}
function doRestore() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = '.json,application/json';
  inp.onchange = async () => {
    const file = inp.files && inp.files[0]; if (!file) return;
    const text = await file.text();
    const pass = await askPassphrase({ title: 'Restore backup', confirmIt: false, note: 'Enter the passphrase you used when you made this backup.' });
    if (!pass) return;
    try {
      const o = await decryptBackup(text, pass);
      const n = (o.data.entries || []).length, nf = (o.data.foods || []).length;
      if (!confirm(`Replace ALL data on this device with the backup from ${new Date(o.exportedAt).toLocaleString()}? (${n} diary entries, ${nf} foods)`)) return;
      for (const s of DB.STORES) { await DB.clear(s); for (const rec of (o.data[s] || [])) await DB.put(s, rec); }
      await loadSettings(); closeAllSheets(); toast('Backup restored'); render();
    } catch (e) { toast(e.message, 4000); }
  };
  inp.click();
}
async function exportCSV() {
  const all = (await DB.all('entries')).sort((a, b) => (a.date + a.createdAt).localeCompare(b.date + b.createdAt));
  const q = x => `"${String(x ?? '').replace(/"/g, '""')}"`;
  const head = ['date', 'meal', 'food', 'brand', 'amount', 'unit', ...NUTS.map(([k, , u]) => `${k}_${u}`)];
  const lines = [head.join(',')].concat(all.map(e => [e.date, e.meal, q(e.food?.name), q(e.food?.brand), e.amount, e.unit === 'serving' ? 'serving' : (e.baseUnit || 'g'),
    ...NUTS.map(([k]) => e.nutrients?.[k] == null ? '' : Math.round(e.nutrients[k] * 10) / 10)].join(',')));
  await shareOrDownload(lines.join('\n'), `nutritrack-diary-${dateStr()}.csv`, 'text/csv');
}
async function wipeAll() {
  if (!confirm('Delete ALL NutriTrack data on this device? This cannot be undone unless you have a backup.')) return;
  if (prompt('Type DELETE to confirm') !== 'DELETE') { toast('Nothing was deleted'); return; }
  for (const s of DB.STORES) await DB.clear(s);
  await loadSettings(); closeAllSheets(); toast('All data deleted'); go('home');
}
async function openSettings() {
  const s = state.settings;
  const lb = (await DB.get('kv', 'lastBackup'))?.at;
  let persisted = null; try { persisted = await navigator.storage?.persisted?.(); } catch (e) { /* ignore */ }
  const goal = (k, l, u) => `<div><label class="f">${l} (${u})</label><input class="in" type="number" inputmode="decimal" data-goal="${k}" value="${s[k]}"></div>`;
  const el = openSheet(`
    <div class="sheet-head"><button class="link" data-act="close">Done</button><div class="sheet-title">Settings</div><span style="width:50px"></span></div>
    <h3>Daily goals</h3>
    <div class="grid2">${goal('kcal', 'Calories', 'kcal')}${goal('protein', 'Protein', 'g')}${goal('carbs', 'Carbs', 'g')}${goal('fat', 'Fat', 'g')}${goal('fiber', 'Fiber', 'g')}${goal('waterGoal', 'Water', 'oz')}</div>
    <div class="stack"><button class="btn primary" data-act="save-goals">Save goals</button></div>
    <h3>Backup &amp; restore</h3>
    <p class="small muted">Last backup: ${lb ? new Date(lb).toLocaleString() : 'never'}. Backups are encrypted with your passphrase (AES-256) before they leave the app. Save them to OneDrive from the share sheet, and use Restore to move your data to another device, like your Windows PC.</p>
    <div class="stack"><button class="btn secondary" data-act="backup">Create encrypted backup</button>
    <button class="btn secondary" data-act="restore">Restore from backup</button>
    <button class="btn" data-act="csv">Export diary as spreadsheet (CSV, not encrypted)</button></div>
    <h3>Privacy</h3>
    <p class="small muted">Your diary, foods and settings are stored only on this device. No account, ads, analytics or trackers. The only data sent out is barcode numbers and search words, to Open Food Facts, to look up products.
    Storage: ${persisted ? 'protected from automatic cleanup.' : 'standard. Add NutriTrack to your Home Screen and open it from there to keep data safest.'}</p>
    <div class="stack"><button class="btn danger" data-act="wipe">Delete all data on this device</button></div>
    <h3>Feature status</h3>
    <p class="small" style="margin-bottom:4px"><b>Working now</b></p><ul class="status-list small">${FEATURES.done.map(x => `<li>${esc(x)}</li>`).join('')}</ul>
    <p class="small" style="margin-bottom:4px"><b>Planned</b></p><ul class="status-list small muted">${FEATURES.planned.map(x => `<li>${esc(x)}</li>`).join('')}</ul>
    <p class="tiny muted">NutriTrack ${APP_VERSION} · Food data © Open Food Facts contributors (ODbL)</p>`);
  el.onclick = async e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const a = b.dataset.act;
    if (a === 'close') closeSheet();
    else if (a === 'save-goals') {
      $$('[data-goal]', el).forEach(i => { const v = num(i.value); if (v != null && v >= 0) state.settings[i.dataset.goal] = v; });
      await DB.put('kv', state.settings); toast('Goals saved'); render();
    } else if (a === 'backup') doBackup();
    else if (a === 'restore') doRestore();
    else if (a === 'csv') exportCSV();
    else if (a === 'wipe') wipeAll();
  };
}

// ---------- Start ----------
async function init() {
  await loadSettings();
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) { /* ignore */ }
  $('#tabbar').onclick = e => { const b = e.target.closest('[data-tab]'); if (b) { closeAllSheets(); go(b.dataset.tab); } };
  $('#backdrop').onclick = () => closeSheet();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { Scanner.stop(); return; }
    if (state.tab === 'scan' && !sheets.length) startCamera();
    else if (state.tab === 'home' && !sheets.length) render(); // refresh if the day rolled over
  });
  window.addEventListener('online', async () => { const p = await DB.all('pending'); if (p.length) toast(`Back online — ${p.length} scan${p.length > 1 ? 's' : ''} ready to look up`); });
  await go('home');
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('./sw.js').catch(e => console.warn('SW', e));
}

if (typeof document !== 'undefined' && document.getElementById('view')) init();
if (typeof module !== 'undefined') module.exports = { calcNutrients, mapOFF, upcEtoA, barcodeCandidates, isIncomplete, canUseServing, canUseGrams, sumNuts, missingLabels };
