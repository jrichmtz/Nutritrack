'use strict';
/*
  NutriTrack — Phase 1 (essential nutrition tracker)
  Local-first PWA: all personal data lives in this device's IndexedDB.
  Only barcode numbers / search words leave the device (sent to Open Food Facts).
*/
const APP_VERSION = '6.2.0';

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
const DEFAULT_SETTINGS = { key: 'settings', kcal: 2000, protein: 120, carbs: 200, fat: 65, fiber: 30, waterGoal: 64, sodiumLimit: 2300, satfatLimit: 20, addedSugarLimit: 36 };
const OFF_BASE = 'https://world.openfoodfacts.org';
const OFF_FIELDS = 'code,product_name,product_name_en,generic_name,brands,quantity,product_quantity,product_quantity_unit,serving_size,serving_quantity,serving_quantity_unit,nutriments,image_front_small_url,image_front_url,image_url';
const ZXING_LIBRARY_FALLBACK = 'https://unpkg.com/@zxing/library@0.21/umd/index.min.js';
const TESS = {
  script: 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js',
  worker: 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/worker.min.js',
  core: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5',
};

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
    'Nutrition-label photo with on-device text reading (OCR) and a review screen',
    'Recipes with per-serving nutrition',
    'Meal-photo workflow (photo + your foods or quick estimates)',
    'Weight log with 7-day average, 30-day trend, total and percent lost, goal',
    'Body measurements: waist, chest, neck, hips, thigh',
    'Medication journal: doses, side effects, appetite',
    'Apple Health import (steps, exercise, sleep, resting heart rate, weight)',
    'Food vs activity vs weight comparison and a shareable progress report',
    'Trend weight and estimated calorie burn (energy balance)',
    'Daily and weekly recaps with tips, plus “Ask Claude” sharing',
    'Type-a-food search: your foods, USDA common & restaurant foods, brands, quick calories',
    'Estimated Wegovy level chart and side-effect trends',
    'Progress photos with before/after compare',
    'Daily habit tracker (no streak pressure)',
    'Recommended targets from your stats and a weekly calorie check-in',
    'Health profile (conditions + medications) with personalized guidance',
    'Blood pressure log with categories and chart; lab results with trends',
    'Limits for sodium, saturated fat and added sugar',
  ],
  planned: [
    'Optional later: automatic sync between iPhone and Windows (needs a private server)',
    'Optional later: AI meal-photo recognition (paid, only with your approval)',
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
  // Newer Open Food Facts search service first, classic search as a fallback.
  try {
    const r = await fetch(`https://search.openfoodfacts.org/search?q=${encodeURIComponent(q)}&page_size=30&fields=${OFF_FIELDS}`, { headers: { Accept: 'application/json' } });
    if (r.ok) { const j = await r.json(); const hits = (j.hits || []).filter(p => p.code && p.nutriments); if (hits.length) return hits.map(p => mapOFF(p.code, p)); }
  } catch (e) { /* fall through */ }
  let r;
  try { r = await fetch(`${OFF_BASE}/cgi/search.pl?search_terms=${encodeURIComponent(q)}&search_simple=1&action=process&json=1&page_size=30&fields=${OFF_FIELDS}`); }
  catch (e) { throw new Error('Brand search is unavailable right now. Try scanning the barcode instead.'); }
  if (r.status === 429) throw new Error('Brand search is limited to about 10 per minute. Try again shortly.');
  if (!r.ok) throw new Error('Brand search failed (' + r.status + ')');
  const j = await r.json();
  return (j.products || []).filter(p => p.code).map(p => mapOFF(p.code, p));
}

// ---------- IndexedDB ----------
const DB = (() => {
  let dbp;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open('nutritrack', 5);
      r.onupgradeneeded = e => {
        const d = r.result;
        if (e.oldVersion < 1) {
          d.createObjectStore('foods', { keyPath: 'id' }).createIndex('barcode', 'barcode', { unique: false });
          d.createObjectStore('entries', { keyPath: 'id' }).createIndex('date', 'date', { unique: false });
          d.createObjectStore('days', { keyPath: 'date' });
          d.createObjectStore('kv', { keyPath: 'key' });
          d.createObjectStore('pending', { keyPath: 'barcode' });
        }
        if (e.oldVersion < 2) d.createObjectStore('photos', { keyPath: 'id' });
        if (e.oldVersion < 3) {
          d.createObjectStore('weights', { keyPath: 'id' });
          d.createObjectStore('measurements', { keyPath: 'id' });
          d.createObjectStore('meds', { keyPath: 'id' });
          d.createObjectStore('health', { keyPath: 'date' });
        }
        if (e.oldVersion < 4) d.createObjectStore('pphotos', { keyPath: 'id' });
        if (e.oldVersion < 5) { d.createObjectStore('bp', { keyPath: 'id' }); d.createObjectStore('labs', { keyPath: 'id' }); }
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
    STORES: ['foods', 'entries', 'days', 'kv', 'pending', 'photos', 'weights', 'measurements', 'meds', 'health', 'pphotos', 'bp', 'labs'],
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
  const { id, name, brand, barcode, servingLabel, servingGrams, baseUnit, servingsPerContainer, spcEstimated, per100, perServing, imageUrl, incomplete, source, packageSize, portions } = f;
  return { id, name, brand, barcode, servingLabel, servingGrams, baseUnit, servingsPerContainer, spcEstimated, per100, perServing, imageUrl, incomplete, source, packageSize, portions };
}

// ---------- Icons ----------
const ICON = {
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  barcode: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 8v8M10 8v8M13 8v8M16.5 8v8"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  camera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8a2 2 0 0 1 2-2h2l2-2h6l2 2h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><circle cx="12" cy="13" r="3.5"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9z"/></svg>',
  starOn: '<svg viewBox="0 0 24 24" fill="#ffb800" stroke="#ffb800" stroke-width="2" stroke-linejoin="round"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9z"/></svg>',
  label: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 7h8M8 11h8M8 15h5"/></svg>',
  recipe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11h16a8 8 0 0 1-16 0zM8 7c0-1.5 1-2 1-3.5M12 7c0-1.5 1-2 1-3.5M16 7c0-1.5 1-2 1-3.5"/></svg>',
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
  if (e.portion) {
    const c = fmt(e.portion.count, 2), L = e.portion.label;
    return /^(oz|fl oz|cup|tbsp|tsp)$/.test(L) ? `${c} ${L}` : /^1\s/.test(L) ? `${c} × ${L.replace(/^1\s+/, '')}` : `${c} × ${L}`;
  }
  const a = Number(e.amount);
  return e.unit === 'serving' ? `${fmt(a, 2)} serving${a === 1 ? '' : 's'}` : `${fmt(a, 1)} ${e.baseUnit || 'g'}`;
}
// All the ways an amount can be entered for a food: servings, named portions (1 large egg, 1 cup…), weight and volume units.
function unitOptions(food) {
  const bu = food.baseUnit || 'g', canS = canUseServing(food), canG = canUseGrams(food), out = [];
  if (canS) out.push({ key: 'serving', label: food.servingLabel ? `Serving · ${food.servingLabel}` : 'Servings', base: 'serving', per: 1, step: 0.5 });
  if (canG) {
    for (const p of food.portions || []) if (p.g > 0 && !(food.servingGrams && Math.abs(p.g - food.servingGrams) < 0.01 && /serving/i.test(p.label))) out.push({ key: 'p:' + p.label, label: p.label, base: 'g', per: p.g, step: 0.5, portion: true });
    if (bu === 'ml') {
      out.push({ key: 'cup', label: 'cup', base: 'g', per: 240, step: 0.25 }, { key: 'floz', label: 'fl oz', base: 'g', per: 29.57, step: 1 }, { key: 'tbsp', label: 'tbsp', base: 'g', per: 15, step: 1 });
      out.push({ key: 'g', label: 'ml', base: 'g', per: 1, step: 10 });
    } else {
      out.push({ key: 'oz', label: 'oz', base: 'g', per: 28.35, step: 1 }, { key: 'g', label: 'grams', base: 'g', per: 1, step: 10 });
    }
  }
  if (!out.length) out.push({ key: 'serving', label: 'Servings', base: 'serving', per: 1, step: 0.5 });
  return out;
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
  const today = dateStr(), s = state.settings;
  const date = state.homeDate && state.homeDate <= today ? state.homeDate : today;
  const isToday = date === today;
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
  // Week strip (Mon–Sun containing the selected day)
  const dow = (parseD(date).getDay() + 6) % 7, monday = addDays(date, -dow);
  const week = [];
  for (let i = 0; i < 7; i++) { const d = addDays(monday, i); const es = await entriesFor(d); week.push({ d, n: es.length, kcal: sumNuts(es).t.kcal }); }
  const tips = await buildInsights(date);
  const R = (pct, color, size, stroke) => { const r = (size - stroke) / 2, c = 2 * Math.PI * r, p = Math.max(0, Math.min(1, pct || 0));
    return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="transform:rotate(-90deg)"><circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="rgba(255,255,255,.22)" stroke-width="${stroke}"/>
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${(c * (1 - p)).toFixed(1)}"/></svg>`; };
  const macro = (k, label, color) => `<div class="mini"><div class="mini-ring">${R(s[k] ? t[k] / s[k] : 0, color, 58, 7)}<span>${fmt(t[k])}</span></div><div class="mini-l">${label}</div><div class="mini-g">/ ${fmt(s[k])} g${missing[k] ? ' *' : ''}</div></div>`;
  const limit = (k, label, unit, lim) => { const v = t[k], pct = lim ? v / lim * 100 : 0; return `<div class="bar-row"><div class="spread"><span>${label}</span><span class="muted"><b style="color:${pct > 100 ? 'var(--orange)' : 'var(--text)'}">${fmt(v)}</b> / ${fmt(lim)} ${unit}</span></div><div class="bar"><i style="width:${Math.min(100, pct)}%; --c:${pct > 100 ? 'var(--orange)' : 'var(--muted)'}"></i></div></div>`; };
  view().innerHTML = `
  <header class="topbar"><div><div class="eyebrow">${esc(longDate(date))}</div><h1>${isToday ? greeting() : esc(niceDate(date))}</h1></div>
    <button class="icon-btn" data-act="settings" aria-label="Settings">${ICON.gear}</button></header>
  <div class="weekstrip">${week.map(w => { const p = s.kcal && w.n ? Math.min(1, w.kcal / s.kcal) : 0; const r = 15, c = 2 * Math.PI * r;
    return `<button class="wday ${w.d === date ? 'sel' : ''} ${w.d > today ? 'future' : ''}" data-day="${w.d}" ${w.d > today ? 'disabled' : ''}><span class="wl">${parseD(w.d).toLocaleDateString(undefined, { weekday: 'narrow' })}</span>
      <span class="wr"><svg width="36" height="36" viewBox="0 0 36 36" style="transform:rotate(-90deg)"><circle cx="18" cy="18" r="${r}" fill="none" stroke="var(--line)" stroke-width="3"/>${w.n ? `<circle cx="18" cy="18" r="${r}" fill="none" stroke="var(--accent)" stroke-width="3" stroke-linecap="round" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${(c * (1 - p)).toFixed(1)}"/>` : ''}</svg><b>${parseD(w.d).getDate()}</b></span></button>`; }).join('')}</div>

  <section class="hero">
    <div class="hero-top"><div class="hero-ring">${R(s.kcal ? t.kcal / s.kcal : 0, remaining < 0 ? '#ffd27a' : '#ffffff', 150, 13)}
      <div class="hero-c"><div class="hero-big">${fmt(Math.abs(remaining))}</div><div class="hero-sub">${remaining < 0 ? 'over goal' : 'kcal left'}</div></div></div>
      <div class="hero-stats"><div><b>${fmt(t.kcal)}</b><span>eaten${missing.kcal ? ' *' : ''}</span></div><div><b>${fmt(s.kcal)}</b><span>goal</span></div>
      <div><b>${fmt(day.waterOz)}<small> oz</small></b><span>water</span></div></div></div>
    <div class="hero-macros">${macro('protein', 'Protein', '#9fd7ff')}${macro('carbs', 'Carbs', '#ffd27a')}${macro('fat', 'Fat', '#d7b8ff')}${macro('fiber', 'Fiber', '#a8f0d0')}</div>
    ${CORE.some(k => missing[k]) ? '<div class="hero-note">* some foods don’t list this value</div>' : ''}
  </section>

  <section class="actions">
    <button class="action hero-btn" data-act="scan">${ICON.barcode}Scan Barcode</button>
    <button class="action" data-act="add"><span class="ai" style="--c:#1f9d55">${ICON.plus}</span>Add Food</button>
    <button class="action" data-act="label"><span class="ai" style="--c:#0a84ff">${ICON.label}</span>Label Photo</button>
    <button class="action" data-act="meal"><span class="ai" style="--c:#ff9f0a">${ICON.camera}</span>Meal Photo</button>
    <button class="action" data-act="recipe"><span class="ai" style="--c:#8e5cf7">${ICON.recipe}</span>Recipes</button>
  </section>

  ${!s.targetsSetAt ? `<section class="card recap"><h2>Set targets for you</h2><p class="small muted" style="margin-top:0">Your goals are still generic defaults. Get calories and macros based on your height, weight, age and activity.</p>
    <button class="btn primary block" data-act="targets">Recommend my targets</button></section>` : ''}
  ${quick.length ? `<section class="card"><div class="spread"><h2 style="margin:0">Quick add</h2><span class="tiny muted">tap · then Add</span></div><div class="chips" style="margin-top:10px">${quick.map(q => `<button class="chip" data-act="quick" data-id="${q.f.id}">${q.star ? '★ ' : ''}${esc(q.f.name)}</button>`).join('')}</div></section>` : ''}

  <section class="card recap"><div class="spread"><h2 style="margin:0">${isToday ? 'Today’s recap' : 'Day recap'}</h2><span class="pill ok">${entries.length} item${entries.length === 1 ? '' : 's'}</span></div>
    <ul class="tips">${tips.map(x => `<li class="tip ${x.kind}"><span class="ti">${x.icon}</span><span>${x.text}</span></li>`).join('')}</ul>
    <button class="btn secondary block" data-act="ask-day">✨ Ask Claude about ${isToday ? 'today' : 'this day'}</button></section>

  ${await habitCard(date)}

  <section class="card"><h2>Limits</h2>
    ${limit('sodium', 'Sodium', 'mg', s.sodiumLimit)}${limit('satfat', 'Saturated fat', 'g', s.satfatLimit)}${limit('addedSugar', 'Added sugar', 'g', s.addedSugarLimit)}
    <p class="tiny muted" style="margin:6px 0 0">Daily upper limits — change them in Settings. Foods that don’t list a value aren’t counted.</p></section>

  ${waterCard(day)}

  ${pending.length ? `<section class="card"><h2>Scans waiting for internet</h2><p class="small muted">${pending.length} barcode${pending.length > 1 ? 's were' : ' was'} scanned offline.</p>
    <button class="btn secondary block" data-act="tab-scan">Look them up</button></section>` : ''}
  ${(!lastBackup || Date.now() - lastBackup > 7 * 864e5) && (entries.length || foods.length) ? `<div class="warnbox">${lastBackup ? 'Your last backup was over a week ago.' : 'You haven’t made a backup yet.'} Your data lives only on this device.
    <button class="link" data-act="settings">Back up now</button></div>` : ''}`;
  view().onclick = async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.day) { state.homeDate = b.dataset.day; render(); return; }
    if (b.dataset.habit) { toggleHabit(date, b.dataset.habit); return; }
    if (b.dataset.act === 'habits-edit') { openHabitsEdit(); return; }
    const a = b.dataset.act;
    if (a === 'settings') openSettings();
    else if (a === 'scan' || a === 'tab-scan') go('scan');
    else if (a === 'add') openAddFood({ date });
    else if (a === 'label') labelPhotoFlow({ then: f => openLogSheet(f, { date }) });
    else if (a === 'meal') mealPhotoFlow({ date });
    else if (a === 'recipe') openRecipesList();
    else if (a === 'water') addWater(date, Number(b.dataset.v));
    else if (a === 'quick') { const f = await DB.get('foods', b.dataset.id); if (f) openLogSheet(f, { date }); }
    else if (a === 'ask-day') shareText(await buildDayRecap(date), 'Day recap');
    else if (a === 'targets') openTargets();
  };
}
function greeting() { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; }

// ---------- Insights & recaps (rule-based, free, on-device) ----------
async function proteinPicks(n = 3) {
  const foods = (await DB.all('foods')).filter(f => !f.isRecipe || f.perServing);
  const scored = foods.map(f => { const x = calcNutrients(f, 1, canUseServing(f) ? 'serving' : 'g'); const y = canUseServing(f) ? x : calcNutrients(f, 100, 'g');
    return { f, p: y.protein, k: y.kcal }; }).filter(o => o.p != null && o.k && o.p >= 8 && o.p * 4 / o.k >= 0.25)
    .sort((a, b) => (b.p * 4 / b.k) - (a.p * 4 / a.k) || (b.f.useCount || 0) - (a.f.useCount || 0));
  return scored.slice(0, n).map(o => `${esc(o.f.name)} (${fmt(o.p)} g protein, ${fmt(o.k)} kcal)`);
}
async function fiberPicks(n = 3) {
  const foods = await DB.all('foods');
  return foods.map(f => { const x = canUseServing(f) ? calcNutrients(f, 1, 'serving') : calcNutrients(f, 100, 'g'); return { f, fi: x.fiber }; })
    .filter(o => o.fi != null && o.fi >= 3).sort((a, b) => b.fi - a.fi).slice(0, n).map(o => `${esc(o.f.name)} (${fmt(o.fi)} g)`);
}
async function buildInsights(date) {
  const s = state.settings, today = dateStr(), isToday = date === today;
  const entries = await entriesFor(date), { t, missing } = sumNuts(entries), day = await getDay(date);
  const h = new Date().getHours(), meals = new Set(entries.map(e => e.meal)).size;
  const out = [];
  if (!entries.length) {
    out.push({ kind: 'info', icon: '🍽️', text: isToday ? 'Nothing logged yet. Scanning a barcode is the fastest start.' : 'Nothing was logged this day.' });
    return out;
  }
  const late = !isToday || h >= 18;
  const pr = s.protein ? t.protein / s.protein : 1;
  if (pr >= 0.9) out.push({ kind: 'good', icon: '💪', text: `Protein ${fmt(t.protein)} g — ${pr >= 1 ? 'goal reached' : 'nearly there'}. That helps protect muscle while losing weight.` });
  else if (late || meals >= 2) {
    const picks = await proteinPicks();
    out.push({ kind: 'act', icon: '🥩', text: `Protein is ${fmt(s.protein - t.protein)} g under goal.${picks.length ? ' High-protein options from your foods: ' + picks.join(', ') + '.' : ''}` });
  }
  if (late && s.fiber && t.fiber < s.fiber * 0.6) {
    const picks = await fiberPicks();
    out.push({ kind: 'act', icon: '🥦', text: `Fiber ${fmt(t.fiber)} g of ${fmt(s.fiber)} g. Fiber and water can help with constipation.${picks.length ? ' Higher-fiber foods you have: ' + picks.join(', ') + '.' : ''}` });
  }
  if (s.sodiumLimit && t.sodium > s.sodiumLimit) out.push({ kind: 'warn', icon: '🧂', text: `Sodium ${fmt(t.sodium)} mg is over your ${fmt(s.sodiumLimit)} mg limit${hasCond('htn') ? ', which matters for your blood pressure' : ''}. Expect a temporary water-weight bump on the scale tomorrow.` });
  if (s.waterGoal && (late || h >= 15) && day.waterOz < s.waterGoal * 0.5) out.push({ kind: 'act', icon: '💧', text: `Water ${fmt(day.waterOz)} of ${fmt(s.waterGoal)} oz — hydration matters more on a GLP-1 medication.` });
  const rem = s.kcal - t.kcal;
  if (late && rem < -150) out.push({ kind: 'info', icon: '📊', text: `${fmt(-rem)} kcal over goal. One day doesn’t move the trend — the weekly average is what counts.` });
  else if (late && rem > s.kcal * 0.4 && meals >= 2) out.push({ kind: 'info', icon: '📊', text: `Only ${fmt(t.kcal)} kcal logged. If that’s complete, very low days can make it harder to keep muscle — if not, add what’s missing so the trend stays accurate.` });
  if (CORE.some(k => missing[k])) out.push({ kind: 'info', icon: '⚠️', text: 'Some foods are missing values, so totals may read low.' });
  if (isToday) {
    const ws = await DB.all('weights'); const lastW = ws.map(w => w.date).sort().pop();
    if (!lastW || daysBetween(lastW, today) >= 7) out.push({ kind: 'act', icon: '⚖️', text: `No weigh-in ${lastW ? 'for ' + daysBetween(lastW, today) + ' days' : 'yet'}. A few weigh-ins a week make your trend reliable.` });
  }
  if (isToday && hasCond('htn')) { const bpl = (await DB.all('bp')).map(r => r.date).sort().pop(); if (!bpl || daysBetween(bpl, today) >= 7) out.push({ kind: 'act', icon: '🩺', text: 'No blood pressure reading this week — log one in the Health tab.' }); }
  if (!out.some(x => x.kind === 'act' || x.kind === 'warn')) out.push({ kind: 'good', icon: '✅', text: 'Solid day so far — nothing needs attention.' });
  return out;
}
const plain = html => String(html).replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
async function buildDayRecap(date) {
  const s = state.settings, entries = await entriesFor(date), { t } = sumNuts(entries), day = await getDay(date);
  const lines = [`NutriTrack recap — ${longDate(date)}`, '', `Goals: ${fmt(s.kcal)} kcal, protein ${fmt(s.protein)} g, carbs ${fmt(s.carbs)} g, fat ${fmt(s.fat)} g, fiber ${fmt(s.fiber)} g, water ${fmt(s.waterGoal)} oz`,
    `Totals: ${fmt(t.kcal)} kcal, protein ${fmt(t.protein)} g, carbs ${fmt(t.carbs)} g, fat ${fmt(t.fat)} g, fiber ${fmt(t.fiber)} g, sodium ${fmt(t.sodium)} mg, sat fat ${fmt(t.satfat)} g, added sugar ${fmt(t.addedSugar)} g, water ${fmt(day.waterOz)} oz`, ''];
  for (const [m, l] of MEALS) { const es = entries.filter(e => e.meal === m); if (!es.length) continue;
    lines.push(`${l}:`); for (const e of es) lines.push(`- ${e.food?.name || 'Food'}${e.food?.brand ? ' (' + e.food.brand + ')' : ''}, ${amountLabel(e)}: ${fmt(e.nutrients?.kcal)} kcal, ${fmt(e.nutrients?.protein)} g protein${e.estimate ? ' [estimate]' : ''}`); }
  const meds = (await DB.all('meds')).filter(m => m.date === date);
  for (const m of meds) lines.push(m.type === 'dose' ? `Dose: ${m.med} ${m.dose}` : `Check-in: appetite ${APPETITE[m.appetite]}, nausea ${SEVERITY[m.nausea]}, constipation ${SEVERITY[m.constipation]}${m.other ? ', ' + m.other : ''}`);
  const w = (await DB.all('weights')).filter(x => x.date === date).pop(); if (w) lines.push(`Weight: ${fmt(w.lb, 1)} lb`);
  const h = await DB.get('health', date); if (h) lines.push(`Activity: ${fmt(h.steps)} steps, sleep ${h.sleepHrs ?? '—'} h, resting HR ${h.restingHR ?? '—'}`);
  const hc = healthContextLines(); if (hc.length) lines.push('', 'Health context:', ...hc);
  lines.push('', 'Please give me a short recap of this day and 2–3 practical food suggestions for tomorrow, based on what I actually eat. Don’t suggest medication changes.');
  return lines.join('\n');
}
async function buildWeekRecap() {
  const s = state.settings, today = dateStr(), lines = [`NutriTrack weekly recap — ${longDate(addDays(today, -6))} to ${longDate(today)}`, ''];
  let logged = 0; const sums = { kcal: 0, protein: 0, fiber: 0, sodium: 0 };
  for (let i = 6; i >= 0; i--) { const d = addDays(today, -i); const es = await entriesFor(d); const { t } = sumNuts(es); const h = await DB.get('health', d) || {}; const day = await getDay(d);
    if (es.length) { logged++; for (const k in sums) sums[k] += t[k]; }
    lines.push(`${parseD(d).toLocaleDateString(undefined, { weekday: 'short', month: 'numeric', day: 'numeric' })}: ${es.length ? `${fmt(t.kcal)} kcal, ${fmt(t.protein)} g protein, ${fmt(t.fiber)} g fiber, ${fmt(t.sodium)} mg sodium, ${fmt(day.waterOz)} oz water` : 'not logged'}${h.steps != null ? `, ${fmt(h.steps)} steps` : ''}${h.sleepHrs != null ? `, ${h.sleepHrs} h sleep` : ''}`); }
  lines.push('', `Logged ${logged} of 7 days. Averages on logged days: ${logged ? fmt(sums.kcal / logged) : '—'} kcal, ${logged ? fmt(sums.protein / logged) : '—'} g protein, ${logged ? fmt(sums.fiber / logged) : '—'} g fiber (goals ${fmt(s.kcal)} / ${fmt(s.protein)} / ${fmt(s.fiber)}).`);
  const days = lastPerDay(await DB.all('weights'), 'lb'), ws = weightStats(days, s), tr = trendSeries(days);
  if (ws) lines.push(`Weight: latest ${fmt(ws.last.v, 1)} lb (${ws.last.date}), trend ${fmt(tr[tr.length - 1].v, 1)} lb, ${fmt(ws.lost, 1)} lb lost since ${fmt(ws.start, 1)} lb. ${ws.trend.text}`);
  const ex = await expenditureEstimate(); if (ex.ok) lines.push(`Estimated expenditure: about ${fmt(ex.tdee)} kcal/day (from ${ex.loggedDays} logged days and weight trend).`);
  const meds = (await DB.all('meds')).filter(m => m.date > addDays(today, -7)).sort((a, b) => a.date.localeCompare(b.date));
  for (const m of meds) lines.push(m.type === 'dose' ? `Dose ${m.date}: ${m.med} ${m.dose}` : `Check-in ${m.date}: appetite ${APPETITE[m.appetite]}, nausea ${SEVERITY[m.nausea]}, constipation ${SEVERITY[m.constipation]}${m.other ? ', ' + m.other : ''}`);
  const bpw = (await DB.all('bp')).filter(r => r.date > addDays(today, -7)); if (bpw.length) lines.push(`Blood pressure this week: ${bpw.map(r => `${r.sys}/${r.dia}${r.dizzy ? ' (dizzy)' : ''}`).join(', ')}`);
  const hc = healthContextLines(); if (hc.length) lines.push('', 'Health context:', ...hc);
  lines.push('', 'Please give me a weekly recap: what went well, patterns you notice, and 3 practical changes for next week based on the foods I actually eat. Flag anything worth discussing with my doctor, but don’t suggest medication changes.');
  return lines.join('\n');
}
async function shareText(text, title) {
  try {
    if (navigator.share) { await navigator.share({ title, text }); return; }
  } catch (e) { if (e.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(text); toast('Copied — paste it into your chat with Claude', 3500); }
  catch (e) {
    const el = openSheet(`<div class="sheet-head"><button class="link" data-act="close">Done</button><div class="sheet-title">Copy this recap</div><span style="width:50px"></span></div><textarea class="in" style="height:60vh; font-size:14px">${esc(text)}</textarea>`);
    el.onclick = ev => { if (ev.target.closest('[data-act="close"]')) closeSheet(); };
  }
}

// ---------- Trend weight & expenditure (MacroFactor-style, simplified) ----------
// Exponentially smoothed weight: each weigh-in moves the trend 10% per day elapsed, so single-day swings barely move it.
function trendSeries(days) {
  const out = []; let tr = null, prev = null;
  for (const d of days) {
    if (tr == null) tr = d.v;
    else { const gap = Math.max(1, daysBetween(prev, d.date)); const a = 1 - Math.pow(0.9, gap); tr = tr + a * (d.v - tr); }
    prev = d.date; out.push({ date: d.date, v: tr });
  }
  return out;
}
function trendAt(tr, date) { const p = tr.filter(x => x.date <= date).pop(); return p ? p.v : null; }
async function expenditureEstimate(windowDays = 28) {
  const today = dateStr(), start = addDays(today, -(windowDays - 1));
  const days = lastPerDay(await DB.all('weights'), 'lb'), tr = trendSeries(days);
  const inWin = days.filter(d => d.date >= start);
  let logged = 0, kcal = 0;
  for (let i = 0; i < windowDays; i++) { const es = await entriesFor(addDays(start, i)); if (es.length) { logged++; kcal += sumNuts(es).t.kcal; } }
  const need = Math.ceil(windowDays * 0.7);
  if (logged < need || inWin.length < 4) return { ok: false, loggedDays: logged, needDays: need, weighIns: inWin.length };
  const w0 = trendAt(tr, inWin[0].date), w1 = trendAt(tr, inWin[inWin.length - 1].date);
  const span = Math.max(7, daysBetween(inWin[0].date, inWin[inWin.length - 1].date));
  const tdee = kcal / logged - (w1 - w0) * 3500 / span;
  return { ok: true, tdee, intake: kcal / logged, loggedDays: logged, rate: (w1 - w0) / span * 7 };
}

// ---------- Diary ----------
async function renderDiary() {
  const date = state.date;
  const entries = await entriesFor(date);
  const { t, missing } = sumNuts(entries);
  const day = await getDay(date);
  const anyMissing = CORE.some(k => missing[k]);
  const photos = {};
  for (const id of new Set(entries.map(e => e.photoId).filter(Boolean))) { const ph = await DB.get('photos', id); if (ph) photos[id] = ph.dataUrl; }
  const meal = m => {
    const list = entries.filter(e => e.meal === m);
    const kc = list.reduce((s, e) => s + (e.nutrients?.kcal || 0), 0);
    return `<section class="card meal m-${m}"><div class="meal-head"><h2><span class="meal-ic">${{ breakfast: '🍳', lunch: '🥗', dinner: '🍽️', snacks: '🍎' }[m]}</span>${MEAL_LABEL[m]}</h2>
      <div class="row"><span class="muted small">${list.length ? fmt(kc) + ' kcal' : ''}</span>
      <button class="icon-btn" style="background:var(--accent-soft); color:var(--accent)" data-act="add" data-meal="${m}" aria-label="Add to ${MEAL_LABEL[m]}">${ICON.plus}</button></div></div>
      ${list.length ? `<ul class="list">${list.map(e => `<li><button class="item" data-act="entry" data-id="${e.id}">
        ${thumb(photos[e.photoId] || e.food?.imageUrl)}<div class="grow"><div class="t">${esc(e.food?.name || 'Food')}${e.estimate ? ' <span class="pill warn">estimate</span>' : ''}</div>
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
  ${anyMissing ? `<div class="warnbox">Some entries don’t list every nutrient (calories, protein, carbs or fat), so these totals may be low. Tap an entry to see what’s missing.</div>` : ''}
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
function downscale(file, max, quality = 0.92) {
  return new Promise((res, rej) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url); res(c.toDataURL('image/jpeg', quality));
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
function pickPhoto() {
  return new Promise(resolve => {
    const inp = $('#photo-input');
    inp.value = '';
    inp.onchange = () => resolve((inp.files && inp.files[0]) || null);
    inp.click();
  });
}
async function pickBarcodePhoto() {
  const f = await pickPhoto(); if (!f) return;
  toast('Reading barcode…', 6000);
  try {
    const code = await Scanner.decodeFile(f);
    if (code) { toast('Found ' + code); handleBarcode(code); }
    else toast('No barcode found in that photo. Try closer, flatter, and in good light.', 4000);
  } catch (e) { toast(e.message, 4000); }
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
    The app reads the label on your phone; you check the numbers before saving.</p></div>
    <div class="stack"><button class="btn primary big" data-act="photo-label">Photograph the Nutrition Facts label</button>
    <button class="btn secondary" data-act="create">Type it in from the label</button>
    <button class="btn secondary" data-act="again">Scan something else</button></div>`);
  el.onclick = e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    if (b.dataset.act === 'close' || b.dataset.act === 'again') closeSheet();
    if (b.dataset.act === 'create') { closeSheet(); openEditFood(null, { barcode: code, then: f => openLogSheet(f, {}) }); }
    if (b.dataset.act === 'photo-label') { closeSheet(); labelPhotoFlow({ barcode: code, then: f => openLogSheet(f, {}) }); }
  };
}

// ---------- Log food sheet ----------
async function openLogSheet(foodIn, opts = {}) {
  const entry = opts.entry || null;
  const libFood = foodIn.id ? await DB.get('foods', foodIn.id) : null;
  const food = entry ? entry.food : (libFood || foodIn);
  const bu = food.baseUnit || 'g';
  const canS = canUseServing(food), canG = canUseGrams(food);
  let units = unitOptions(food);
  let u, amount;
  if (entry) {
    u = (entry.portion && units.find(x => x.label === entry.portion.label)) || units.find(x => x.key === (entry.unit === 'serving' ? 'serving' : 'g')) || units[0];
    amount = entry.portion && u.label === entry.portion.label ? entry.portion.count : entry.amount / (u.base === 'serving' ? 1 : u.per);
  } else {
    u = units.find(x => x.key === 'serving') || units.find(x => x.portion) || units.find(x => x.key === 'g') || units[0];
    amount = u.key === 'g' ? (food.servingGrams || 100) : 1;
  }
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
      <div class="row"><button class="link" data-act="edit-food">Type corrections</button>${food.isRecipe || entry ? '' : '<button class="link" data-act="label-fix">Photograph the label</button>'}</div></div>` : ''}
    ${food.partial && food.partial.length ? `<div class="warnbox">Partial recipe values for ${esc(food.partial.join(', '))}: some ingredients don’t list them, so the real amount may be higher.</div>` : ''}
    <div class="card">
      <div class="kv" style="border-top:0"><span class="muted">Serving size</span><span>${esc(food.servingLabel || (food.servingGrams ? food.servingGrams + ' ' + bu : 'Not listed'))}</span></div>
      <div class="kv"><span class="muted">Servings per container</span><span>${food.servingsPerContainer ? (food.spcEstimated ? '≈ ' : '') + fmt(food.servingsPerContainer, 1) : 'Not listed'}</span></div>
      ${food.packageSize ? `<div class="kv"><span class="muted">Package</span><span>${esc(food.packageSize)}</span></div>` : ''}
      ${food.barcode ? `<div class="kv"><span class="muted">Barcode</span><span>${esc(food.barcode)}</span></div>` : ''}
    </div>
    ${!canS && !canG ? `<div class="warnbox">This record has no nutrition numbers. Enter them from the label so this food counts toward your totals.</div>` : ''}
    <label class="f">Amount eaten</label>
    <div class="unit-chips" id="unit-seg"></div>
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
  if (food.isRecipe) $$('[data-act="edit-food"]', el).forEach(x => { x.textContent = x.classList.contains('link') ? 'Edit recipe' : 'Edit recipe'; });

  const amt = $('#amt', el);
  $('#logdate', el).value = date;
  const base = () => ({ unit: u.base, amount: u.base === 'serving' ? amount : amount * u.per });
  function drawUnits() {
    $('#unit-seg', el).innerHTML = units.map(x => `<button data-unit="${esc(x.key)}" class="${x.key === u.key ? 'on' : ''}">${esc(x.label)}${x.portion || x.key === 'serving' ? '' : ''}</button>`).join('') + (canG ? '<button data-act="add-unit" class="add">+ unit</button>' : '');
  }
  function update() {
    amount = num(amt.value) ?? 0;
    $$('#unit-seg button[data-unit]', el).forEach(b => b.classList.toggle('on', b.dataset.unit === u.key));
    $$('#meal-seg button', el).forEach(b => b.classList.toggle('on', b.dataset.meal === meal));
    const bs = base(), n = calcNutrients(food, bs.amount, bs.unit);
    $('#nut', el).innerHTML = NUTS.map(([k, l, u, d]) => `<tr class="${k === 'kcal' ? 'main' : ''}"><td>${l}</td><td>${n[k] == null ? '<span class="na">—</span>' : fmt(n[k], d) + (k === 'kcal' ? '' : ' ' + u)}</td></tr>`).join('');
    const frac = q => q === 0.5 ? '½' : q === 1.5 ? '1½' : q === 0.25 ? '¼' : String(q);
    let qs, lab;
    if (u.key === 'g') { qs = food.servingGrams ? [food.servingGrams / 2, food.servingGrams, food.servingGrams * 2, 100].map(x => Math.round(x)) : [50, 100, 150, 200]; lab = q => q + ' ' + (bu === 'ml' ? 'ml' : 'g'); }
    else if (u.key === 'oz' || u.key === 'floz') { qs = [2, 4, 6, 8]; lab = q => q + ' ' + u.label; }
    else if (u.key === 'cup') { qs = [0.25, 0.5, 1, 1.5]; lab = frac; }
    else { qs = u.portion ? [1, 2, 3, 4] : [0.5, 1, 1.5, 2]; lab = frac; }
    $('#quick', el).innerHTML = [...new Set(qs)].map(q => `<button data-q="${q}">${lab(q)}</button>`).join('');
    $('#save-btn', el).textContent = entry ? 'Update entry' : `Add to ${MEAL_LABEL[meal]}`;
    $('#save-btn', el).disabled = !(amount > 0);
  }
  amt.value = String(Math.round(amount * 100) / 100);
  amt.oninput = update;
  drawUnits();
  $('#logdate', el).onchange = e => { if (e.target.value) date = e.target.value; };
  update();

  el.onclick = async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.unit && b.dataset.unit !== u.key) {
      // keep the same quantity of food when switching units, when the weights are known
      const nu = units.find(x => x.key === b.dataset.unit); if (!nu) return;
      const grams = u.base === 'serving' ? (food.servingGrams ? amount * food.servingGrams : null) : amount * u.per;
      let na;
      if (grams != null && (nu.base === 'g' || food.servingGrams)) na = nu.base === 'serving' ? grams / food.servingGrams : grams / nu.per;
      else na = nu.key === 'g' ? (food.servingGrams || 100) : 1;
      na = nu.key === 'g' ? Math.round(na) : Math.round(na * 4) / 4 || (nu.key === 'g' ? 1 : 0.25);
      u = nu; amount = na; amt.value = String(na); update(); return;
    }
    if (b.dataset.act === 'add-unit') {
      const sh = openSheet(`<div class="sheet-head"><button class="link" data-act="close">Cancel</button><div class="sheet-title">Add a unit</div><span style="width:50px"></span></div>
        <p class="small muted">Save a unit you use for this food, like “1 egg”, “1 slice” or “1 bowl”. Weigh it once or use the package info.</p>
        <label class="f">Unit name</label><input class="in" id="nu-l" placeholder="e.g. 1 egg">
        <label class="f">Weight of one (${bu === 'ml' ? 'ml' : 'grams'})</label><input class="in" id="nu-g" type="number" inputmode="decimal" step="any" placeholder="e.g. 50">
        <div class="stack"><button class="btn primary big" data-act="ok">Save unit</button></div>`);
      sh.onclick = async ev => {
        const bb = ev.target.closest('button'); if (!bb) return;
        if (bb.dataset.act === 'close') closeSheet();
        if (bb.dataset.act === 'ok') {
          let label = $('#nu-l', sh).value.trim(); const g = num($('#nu-g', sh).value);
          if (!label || !(g > 0)) { toast('Enter a name and a weight'); return; }
          if (!/^\d/.test(label)) label = '1 ' + label;
          food.portions = [...(food.portions || []).filter(p => p.label !== label), { label, g }];
          if (libFood) { libFood.portions = food.portions; await DB.put('foods', libFood); }
          closeSheet();
          units = unitOptions(food); u = units.find(x => x.label === label) || u; amount = 1; amt.value = '1'; drawUnits(); update();
        }
      };
      return;
    }
    if (b.dataset.meal) { meal = b.dataset.meal; update(); return; }
    if (b.dataset.q) { amt.value = b.dataset.q; update(); return; }
    const a = b.dataset.act;
    const step = u.key === 'g' ? (food.servingGrams && food.servingGrams < 40 ? 5 : 10) : u.step;
    if (a === 'close') closeSheet();
    else if (a === 'minus') { amt.value = String(Math.max(0, Math.round(((num(amt.value) || 0) - step) * 100) / 100)); update(); }
    else if (a === 'plus') { amt.value = String(Math.round(((num(amt.value) || 0) + step) * 100) / 100); update(); }
    else if (a === 'fav' && libFood) {
      fav = !fav; libFood.favorite = fav; await DB.put('foods', libFood);
      b.innerHTML = fav ? ICON.starOn : ICON.star; toast(fav ? 'Added to favorites' : 'Removed from favorites');
    } else if (a === 'label-fix') {
      const target = libFood || food;
      labelPhotoFlow({ food: target, then: f => { closeSheet(); openLogSheet(f, opts); } });
    } else if (a === 'edit-food') {
      const target = libFood || (food.id && await DB.get('foods', food.id)) || food;
      if (target.isRecipe) { openRecipe(target, { then: f => { closeSheet(); if (!entry) openLogSheet(f, opts); else render(); } }); return; }
      openEditFood(target, {
        then: async f => {
          closeSheet(); // close this log sheet; reopen with fresh data
          if (entry) { const fresh = await DB.get('entries', entry.id); openLogSheet(fresh ? fresh.food : f, { ...opts, entry: fresh || entry }); }
          else openLogSheet(f, opts);
        },
      });
    } else if (a === 'delete' && entry) {
      if (!confirm('Delete this entry?')) return;
      await DB.del('entries', entry.id);
      if (entry.photoId && !(await DB.all('entries')).some(x => x.photoId === entry.photoId)) await DB.del('photos', entry.photoId);
      closeSheet(); toast('Entry deleted'); render();
    } else if (a === 'save') {
      if (!(amount > 0)) return;
      const bs = base(), nutrients = calcNutrients(food, bs.amount, bs.unit);
      const rec = entry ? { ...entry } : { id: uid(), createdAt: Date.now() };
      const portion = u.key === 'serving' || u.key === 'g' ? null : { label: u.label, g: u.per, count: amount };
      Object.assign(rec, { date, meal, foodId: food.id, food: snapshot(food), amount: bs.amount, unit: bs.unit, portion, baseUnit: bu, nutrients, updatedAt: Date.now() });
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
  const isNew = opts.isNew != null ? opts.isNew : !food;
  const f = food ? JSON.parse(JSON.stringify(food)) : {
    id: uid(), name: '', brand: '', barcode: opts.barcode || '', servingLabel: '', servingGrams: null, baseUnit: 'g',
    servingsPerContainer: null, per100: null, perServing: null, imageUrl: '', source: 'Custom', favorite: false,
    useCount: 0, lastUsed: 0, createdAt: Date.now(),
  };
  const v = x => (x == null ? '' : String(Math.round(x * 100) / 100));
  const el = openSheet(`
    <div class="sheet-head"><button class="link" data-act="close">Cancel</button><div class="sheet-title">${isNew ? 'New food' : 'Edit food'}</div>
      <button class="link" data-act="save">Save</button></div>
    ${opts.ocr ? `<div class="warnbox"><b>Check every number against the label.</b> The app read ${opts.ocr.found} of ${NUTS.length} nutrients from your photo. Text reading can mix up digits (like 0 and 8, or “g” read as 9), so anything it wasn’t sure about is left blank for you to fill in.
      ${opts.ocr.text ? `<details style="margin-top:8px"><summary>Show the text it read</summary><pre style="white-space:pre-wrap; font-size:12px; margin:6px 0 0">${esc(opts.ocr.text)}</pre></details>` : ''}</div>`
      : `<p class="small muted" style="margin:4px 0 0">Copy numbers exactly from the Nutrition Facts label. Leave a box blank if the label doesn’t list it — blanks are shown as missing, never guessed.</p>`}
    ${f.imageUrl && f.imageUrl.startsWith('data:') ? `<div class="row" style="margin-top:12px"><img src="${f.imageUrl}" alt="" style="width:72px;height:72px;object-fit:cover;border-radius:12px">
      <label class="row small" style="gap:8px"><input type="checkbox" id="ef-keepimg" checked style="width:22px;height:22px"> Save this photo with the food</label></div>` : ''}
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
    const keep = $('#ef-keepimg', el); if (keep && !keep.checked) f.imageUrl = '';
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
  const meal = opts.meal || state.pendingMeal || null;
  const el = openSheet(`
    <div class="sheet-head"><button class="link" data-act="close">Close</button><div class="sheet-title">Add Food${meal ? ' · ' + MEAL_LABEL[meal] : ''}</div><span style="width:50px"></span></div>
    <form id="af-form" autocomplete="off"><div class="searchbox">${ICON.search}<input id="af-q" type="search" enterkeyhint="search" placeholder="Type a food — egg, Cheerios, Big Mac…"></div></form>
    <div id="af-list"></div>
    <div class="grid2" style="margin:12px 0"><button class="btn secondary" data-act="scan">Scan barcode</button>
      <button class="btn secondary" data-act="label">Label photo</button>
      <button class="btn secondary" data-act="custom">Custom food</button>
      <button class="btn secondary" data-act="recipe">New recipe</button></div>
    <button class="btn block" style="margin-bottom:10px" data-act="meal">Meal photo</button>`);
  const listEl = $('#af-list', el), q = $('#af-q', el);
  const row = (f) => { const tag = foods.includes(f) ? '' : /^USDA/.test(f.source || '') ? 'USDA' : /Open Food Facts/.test(f.source || '') ? 'OFF' : /^fatsecret/.test(f.source || '') ? 'FS' : ''; return `<li><button class="item" data-food="${f.id}">${thumb(f.imageUrl)}<div class="grow"><div class="t">${f.favorite ? '★ ' : ''}${esc(f.name)}</div>
    <div class="s">${/restaurant/.test(f.source || '') ? '🍴 ' : ''}${esc([f.brand, f.servingLabel].filter(Boolean).join(' · '))}${tag ? ` <span class="src">${tag}</span>` : ''}${f.incomplete ? ' · <span style="color:var(--orange)">incomplete</span>' : ''}</div></div>
    <div class="v small">${(() => { const n = canUseServing(f) ? calcNutrients(f, 1, 'serving') : calcNutrients(f, 100, 'g'); return n.kcal == null ? '' : fmt(n.kcal) + '<span class="tiny muted"> kcal</span>'; })()}</div></button></li>`; };
  let online = { usda: null, off: null, fs: fsOn() ? null : [], err: {} }, lastQ = '', timer = null, pool = [];
  const sec = (title, items, note) => `<div class="card"><div class="spread"><h2 style="margin:0">${title}</h2>${note ? `<span class="tiny muted">${note}</span>` : ''}</div><ul class="list" style="margin-top:6px">${items}</ul></div>`;
  function draw() {
    const s = q.value.trim().toLowerCase();
    let html = '';
    if (!s) {
      if (!foods.length) html = '<div class="card small muted">Type any food above. Everything you log is remembered here for one-tap logging next time.</div>';
      const byR = (a, b) => (b.lastUsed || 0) - (a.lastUsed || 0);
      const favs = foods.filter(f => f.favorite).sort(byR), recs = foods.filter(f => f.isRecipe && !f.favorite);
      const recent = foods.filter(f => f.lastUsed && !f.favorite).sort(byR).slice(0, 15);
      if (favs.length) html += sec('Favorites', favs.map(f => row(f)).join(''));
      if (recent.length) html += sec('Recent', recent.map(f => row(f)).join(''));
      if (recs.length) html += sec('Recipes', recs.map(f => row(f)).join(''));
      pool = foods; listEl.innerHTML = html; return;
    }
    const mine = foods.filter(f => matchScore(s, f) >= 50 || String(f.barcode || '').includes(s)).sort((a, b) => matchScore(s, b) - matchScore(s, a) || (b.useCount || 0) - (a.useCount || 0)).slice(0, 20);
    pool = [...foods, ...(online.usda || []), ...(online.off || []), ...(online.fs || [])];
    if (mine.length) html += sec('My foods', mine.map(f => row(f)).join(''));
    const st = k => online.err[k] ? `<li class="small" style="padding:10px 0; color:var(--red)">${esc(online.err[k])}</li>` : online[k] == null ? '<li class="small muted" style="padding:10px 0">Searching…</li>' : online[k].length ? online[k].map(f => row(f)).join('') : '<li class="small muted" style="padding:10px 0">No results.</li>';
    if (s.length >= 2) {
      const loading = online.usda == null || online.off == null || online.fs == null;
      const ranked = rankResults(q.value.trim(), [...(online.fs || []), ...(online.usda || []), ...(online.off || [])]);
      const errs = Object.values(online.err).filter(x => x && x.trim());
      const body = ranked.length ? ranked.map(f => row(f)).join('') + (loading ? '<li class="small muted" style="padding:10px 0">Still searching…</li>' : '')
        : loading ? '<li class="small muted" style="padding:10px 0">Searching…</li>' : '<li class="small muted" style="padding:10px 0">No matches. Try fewer words (e.g. “chobani creamer”), scan the barcode, or use Quick add.</li>';
      html += sec('Best matches', body + errs.map(e => `<li class="small" style="padding:8px 0; color:var(--red)">${esc(e)}</li>`).join(''), fsOn() ? 'fatsecret + USDA + OFF' : 'USDA + Open Food Facts');
      if (fsOn()) html += '<p class="tiny muted" style="margin:-6px 4px 12px">Restaurant & brand data <a href="https://www.fatsecret.com" target="_blank" rel="noopener" style="color:var(--accent)">Powered by fatsecret</a></p>';
      else html += '<p class="tiny muted" style="margin:-6px 4px 12px">Want more restaurants & brands? Connect the free fatsecret database in Settings → Food search.</p>';
    }
    html += `<div class="card"><button class="item" data-act="quickcal"><div class="ai2">⚡</div><div class="grow"><div class="t">Quick add “${esc(q.value.trim())}”</div><div class="s">Restaurant or homemade? Type the calories — many chains post nutrition on their website</div></div></button></div>`;
    listEl.innerHTML = html;
  }
  async function runOnline(term) {
    if (term.length < 2 || term === lastQ) return;
    lastQ = term; online = { usda: null, off: null, fs: fsOn() ? null : [], err: {} }; draw();
    if (fsOn()) searchFatSecret(term).then(r => { if (lastQ === term) { online.fs = r; draw(); } }).catch(e => { if (lastQ === term) { online.err.fs = e.message; online.fs = []; draw(); } });
    if (!navigator.onLine) { online.err = { usda: 'You’re offline — showing your saved foods only.', off: ' ' }; online.usda = []; online.off = []; draw(); return; }
    searchUSDA(term).then(r => { if (lastQ === term) { online.usda = r; draw(); } }).catch(e => { if (lastQ === term) { online.err.usda = e.message; online.usda = []; draw(); } });
    searchOFF(term).then(r => { if (lastQ === term) { online.off = r; draw(); } }).catch(e => { if (lastQ === term) { online.err.off = e.message; online.off = []; draw(); } });
  }
  q.oninput = () => { clearTimeout(timer); if (!q.value.trim()) { lastQ = ''; } draw(); timer = setTimeout(() => runOnline(q.value.trim()), 700); };
  $('#af-form', el).onsubmit = e => { e.preventDefault(); clearTimeout(timer); q.blur(); runOnline(q.value.trim()); };
  draw();
  setTimeout(() => q.focus(), 350);
  el.onclick = async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.food) {
      let f = pool.find(x => x.id === b.dataset.food); if (!f) return;
      if (f.fsPartial) { toast('Loading serving sizes…', 4000); f = await fsComplete(f); $('#toast').hidden = true; }
      if (!foods.includes(f)) {
        const dup = foods.find(x => (f.fdcId && x.fdcId === f.fdcId) || (f.fsId && x.fsId === f.fsId) || (f.barcode && x.barcode === f.barcode));
        if (dup) f = dup; else { await DB.put('foods', f); foods.push(f); }
      }
      openLogSheet(f, { ...opts, meal }); return;
    }
    const a = b.dataset.act;
    if (a === 'close') closeSheet();
    else if (a === 'scan') { state.pendingMeal = meal; closeAllSheets(); go('scan'); }
    else if (a === 'custom') openEditFood(null, { then: f => openLogSheet(f, { ...opts, meal }) });
    else if (a === 'label') labelPhotoFlow({ then: f => openLogSheet(f, { ...opts, meal }) });
    else if (a === 'recipe') openRecipe(null, { then: f => openLogSheet(f, { ...opts, meal }) });
    else if (a === 'meal') { closeAllSheets(); mealPhotoFlow({ ...opts, meal }); }
    else if (a === 'quickcal') openQuickEstimate(async it => {
      const m = meal || defaultMeal(), d = opts.date || (state.tab === 'diary' ? state.date : dateStr());
      await DB.put('entries', { ...it, id: uid(), date: d, meal: m, createdAt: Date.now(), updatedAt: Date.now() });
      closeAllSheets(); toast(`Added to ${MEAL_LABEL[m]}`); render();
    }, q.value.trim());
  };
}


// ---------- fatsecret (restaurant + brand foods) via your private relay ----------
const fsOn = () => !!(state.settings.fsUrl || '').trim();
async function fsGet(path) {
  const base = state.settings.fsUrl.trim().replace(/\/+$/, '');
  const h = { Accept: 'application/json' }; if ((state.settings.fsToken || '').trim()) h['X-App-Token'] = state.settings.fsToken.trim();
  let r; try { r = await fetch(base + path, { headers: h }); } catch (e) { throw new Error('Couldn’t reach your restaurant & brand relay.'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error('Restaurant & brand search: ' + ((j.error && (j.error.message || j.error)) || r.status));
  return j;
}
const arr = x => x == null ? [] : Array.isArray(x) ? x : [x];
// "Per 1 cup - Calories: 186kcal | Fat: 9.95g | Carbs: 12.04g | Protein: 11.38g"
function parseFsDesc(d) {
  const m = String(d || '').match(/^Per\s+(.+?)\s+-\s+(.*)$/i); if (!m) return null;
  const g = k => { const x = m[2].match(new RegExp(k + ':\\s*([\\d.]+)', 'i')); return x ? num(x[1]) : null; };
  const n = emptyNuts(); n.kcal = g('Calories'); n.fat = g('Fat'); n.carbs = g('Carbs'); n.protein = g('Protein');
  return { per: m[1].trim(), n };
}
function mapFsSearch(x) {
  const d = parseFsDesc(x.food_description); if (!d || d.n.kcal == null) return null;
  const per100 = /^100\s*(g|ml)$/i.test(d.per);
  const f = { id: uid(), fsId: String(x.food_id), fsPartial: true, name: x.food_name, brand: x.brand_name || '', servingLabel: per100 ? '' : d.per, servingGrams: null,
    baseUnit: /ml$/i.test(d.per) ? 'ml' : 'g', per100: per100 ? d.n : null, perServing: per100 ? null : d.n, imageUrl: '',
    source: x.food_type === 'Brand' ? 'fatsecret · brand' : 'fatsecret', favorite: false, useCount: 0, lastUsed: 0, createdAt: Date.now() };
  f.incomplete = isIncomplete(f);
  return f;
}
async function searchFatSecret(q) {
  const j = await fsGet('/search?q=' + encodeURIComponent(q));
  return arr(j.foods && j.foods.food).map(mapFsSearch).filter(Boolean);
}
// Full record: every serving size fatsecret lists becomes a unit you can pick (e.g. "1 sandwich", "1 cup", "100 g").
function mapFsFood(x, base) {
  const sv = arr(x.servings && x.servings.serving);
  const nOf = s => { const n = emptyNuts(); n.kcal = num(s.calories); n.protein = num(s.protein); n.carbs = num(s.carbohydrate); n.fat = num(s.fat); n.satfat = num(s.saturated_fat);
    n.fiber = num(s.fiber); n.sugar = num(s.sugar); n.addedSugar = num(s.added_sugars); n.sodium = num(s.sodium); return n; };
  const metric = s => { const a = num(s.metric_serving_amount), u = String(s.metric_serving_unit || '').toLowerCase(); if (!a) return null; return u === 'g' || u === 'ml' ? { g: a, u } : u === 'oz' ? { g: a * 28.35, u: 'g' } : null; };
  const def = sv.find(s => String(s.is_default) === '1') || sv[0];
  if (!def) return base;
  const dm = metric(def), withM = sv.find(s => metric(s) && num(s.calories) != null);
  const f = { ...base, fsPartial: false, name: x.food_name || base.name, brand: x.brand_name || base.brand || '',
    servingLabel: def.serving_description || base.servingLabel, servingGrams: dm ? dm.g : null, baseUnit: dm ? dm.u : (withM ? metric(withM).u : 'g'),
    perServing: nOf(def), per100: null,
    portions: sv.filter(s => s !== def && metric(s) && !/^100\s*(g|ml)$/i.test(s.serving_description || '')).map(s => ({ label: s.serving_description, g: metric(s).g })) };
  if (withM) { const m = metric(withM), n = nOf(withM); f.per100 = Object.fromEntries(NUTS.map(([k]) => [k, n[k] == null ? null : n[k] / m.g * 100])); }
  f.incomplete = isIncomplete(f);
  return f;
}
async function fsComplete(f) {
  if (!f.fsPartial) return f;
  try { const j = await fsGet('/food?id=' + encodeURIComponent(f.fsId)); return j.food ? mapFsFood(j.food, f) : f; }
  catch (e) { toast(e.message, 3500); return f; }
}

// ---------- USDA FoodData Central (free, government-verified) ----------
const USDA_N = { kcal: [1008, 2047, 2048], protein: [1003], carbs: [1005], fat: [1004], satfat: [1258], fiber: [1079], sugar: [2000, 1063], addedSugar: [1235], sodium: [1093] };
function niceName(s) {
  s = String(s || '').trim();
  const letters = s.replace(/[^A-Za-z]/g, ''), upper = s.replace(/[^A-Z]/g, '');
  if (letters.length && upper.length / letters.length > 0.7) s = s.toLowerCase().replace(/(^|[\s,(/-])([a-z])/g, (m, p, c) => p + c.toUpperCase()).replace(/\bMc([a-z])/g, (m, c) => 'Mc' + c.toUpperCase());
  return s;
}
function mapUSDA(x) {
  const per100 = emptyNuts();
  for (const [k, ids] of Object.entries(USDA_N)) {
    for (const id of ids) { const n = (x.foodNutrients || []).find(n => n.nutrientId === id); if (n && n.value != null) { per100[k] = n.unitName === 'kJ' ? n.value / 4.184 : n.value; break; } }
  }
  if (per100.sodium != null && /^g$/i.test(((x.foodNutrients || []).find(n => n.nutrientId === 1093) || {}).unitName || '')) per100.sodium *= 1000;
  let servingGrams = null, servingLabel = '', baseUnit = 'g';
  const meas = (x.foodMeasures || []).filter(m => m.gramWeight > 0 && !/quantity not specified/i.test(m.disseminationText || ''));
  if (x.dataType === 'Branded' && x.servingSize && /^(g|grm|ml|mlt)$/i.test(x.servingSizeUnit || '')) {
    servingGrams = x.servingSize; baseUnit = /^(ml|mlt)$/i.test(x.servingSizeUnit) ? 'ml' : 'g';
    servingLabel = `${x.householdServingFullText ? x.householdServingFullText + ' ' : ''}(${fmt(servingGrams)} ${baseUnit})`;
  } else if (meas.length) {
    const m = meas.sort((a, b) => (a.rank || 99) - (b.rank || 99))[0];
    servingGrams = m.gramWeight; servingLabel = `${m.disseminationText} (${fmt(m.gramWeight)} g)`;
  }
  const portions = meas.map(m => ({ label: m.disseminationText, g: m.gramWeight }));
  const f = {
    id: uid(), fdcId: x.fdcId, portions, barcode: x.gtinUpc || null, name: niceName(x.description), brand: niceName(x.brandName || x.brandOwner || ''),
    servingLabel, servingGrams, baseUnit, servingsPerContainer: null, per100: hasAny(per100) ? per100 : null, perServing: null,
    imageUrl: '', source: /restaurant|fast food/i.test(x.foodCategory || '') ? 'USDA · restaurant' : x.dataType === 'Branded' ? 'USDA (brand)' : 'USDA', favorite: false, useCount: 0, lastUsed: 0, createdAt: Date.now(),
  };
  f.incomplete = isIncomplete(f);
  return f;
}
async function usdaFetch(q, types, size) {
  const key = (state.settings.usdaKey || '').trim() || 'DEMO_KEY';
  const u = `https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${encodeURIComponent(key)}&query=${encodeURIComponent(q)}&pageSize=${size}&dataType=${encodeURIComponent(types)}`;
  let r;
  try { r = await fetch(u, { headers: { Accept: 'application/json' } }); } catch (e) { throw new Error('Couldn’t reach the USDA food database. Check your connection.'); }
  if (r.status === 429 || r.status === 403) throw new Error(key === 'DEMO_KEY' ? 'The shared free USDA limit was reached. Get your own free key (Settings → Food search) for unlimited everyday use.' : 'USDA key not accepted or limit reached — check it in Settings.');
  if (!r.ok) throw new Error('USDA search failed (' + r.status + ')');
  const j = await r.json();
  return (j.foods || []).map(mapUSDA).filter(f => f.per100);
}
// Plain foods and restaurant items, plus the USDA brand-name database (Chobani, Kraft, etc.)
async function searchUSDA(q) {
  const [gen, br] = await Promise.allSettled([usdaFetch(q, 'Foundation,SR Legacy,Survey (FNDDS)', 12), usdaFetch(q, 'Branded', 30)]);
  if (gen.status === 'rejected' && br.status === 'rejected') throw gen.reason;
  return [...(gen.value || []), ...(br.value || [])];
}
// Relevance: how many of your words appear in the name + brand, favoring full matches and brand matches.
const STOP = new Set(['with', 'and', 'the', 'of', 'a', 'an', 'in', 'or', 'for']);
function matchScore(q, f) {
  const words = String(q).toLowerCase().split(/[^a-z0-9%]+/).filter(w => w.length > 1 && !STOP.has(w));
  if (!words.length) return 0;
  const name = String(f.name || '').toLowerCase(), brand = String(f.brand || '').toLowerCase(), text = name + ' ' + brand;
  const has = w => text.includes(w) || (w.endsWith('s') && text.includes(w.slice(0, -1))) || text.includes(w + 's');
  const hit = words.filter(has).length, cov = hit / words.length;
  let sc = cov * 100;
  if (cov === 1) sc += 25;
  if (words.some(w => brand.includes(w))) sc += 10;
  if (name.startsWith(words[0])) sc += 5;
  if (cov === 1 && words.length <= 2 && (/^USDA($| ·)/.test(f.source || '') || f.source === 'fatsecret')) sc += 8;
  if (/^fatsecret/.test(f.source || '')) sc += 3; // curated restaurant & brand data // plain "egg" → generic egg first
  if (f.incomplete) sc -= 6;
  sc -= Math.min(15, name.length / 12);
  return sc;
}
function rankResults(q, list) {
  const seen = new Set(), out = [];
  for (const f of list.map(f => ({ f, s: matchScore(q, f) })).sort((a, b) => b.s - a.s)) {
    const key = (f.f.barcode && f.f.barcode.replace(/^0+/, '')) || (f.f.name + '|' + f.f.brand).toLowerCase();
    if (seen.has(key)) continue; seen.add(key); out.push(f);
  }
  const best = out.length ? out[0].s : 0;
  return out.filter(x => x.s >= Math.min(60, best - 45)).slice(0, 25).map(x => x.f);
}

// ---------- Phase 2: label photo + OCR ----------
async function ocrImage(dataUrl, onProgress) {
  if (!window.Tesseract) await loadScript(TESS.script);
  if (!window.Tesseract) throw new Error('The text reader could not load. Check your internet connection.');
  const worker = await Tesseract.createWorker('eng', 1, {
    workerPath: TESS.worker, corePath: TESS.core,
    logger: m => { try { onProgress(m); } catch (e) { /* ignore */ } },
  });
  try { const { data } = await worker.recognize(dataUrl); return (data && data.text) || ''; }
  finally { try { await worker.terminate(); } catch (e) { /* ignore */ } }
}
// Reads a US-style Nutrition Facts panel. Only fills a value when the text clearly matches; otherwise leaves it blank.
function parseLabel(raw) {
  let t = String(raw || '').replace(/\r/g, '').replace(/[|]/g, ' ');
  t = t.replace(/\bO\s?(m?g)\b/g, '0$1')          // "Og" -> "0g"
       .replace(/(\d)\s+(m?g)\b/g, '$1$2')           // "12 g" -> "12g"
       .replace(/(\d),(\d)/g, '$1.$2');              // "1,5g" -> "1.5g"
  const flat = t.replace(/\s+/g, ' ');
  const grab = re => { const m = flat.match(re); return m ? num(m[1]) : null; };
  const N = '(\\d+(?:\\.\\d+)?)';
  const out = { perServing: emptyNuts(), servingLabel: '', servingGrams: null, baseUnit: 'g', servingsPerContainer: null };
  const ss = t.match(/serving\s*size\s*[:\-]?\s*([^\n]+)/i);
  if (ss) {
    out.servingLabel = ss[1].replace(/\s+/g, ' ').trim().slice(0, 60);
    const g = ss[1].match(/(\d+(?:\.\d+)?)\s*(g|ml|mL)\b/);
    if (g) { out.servingGrams = num(g[1]); out.baseUnit = g[2].toLowerCase() === 'ml' ? 'ml' : 'g'; }
  }
  out.servingsPerContainer = grab(new RegExp(N + '\\s*servings?\\s*per\\s*(?:container|package)', 'i'))
    ?? grab(new RegExp('servings?\\s*per\\s*(?:container|package)\\s*[:\\-]?\\s*(?:about\\s*)?' + N, 'i'));
  const P = out.perServing;
  P.kcal = grab(/calories(?!\s*from)\s*[:\-]?\s*(\d{1,4})\b/i);
  P.fat = grab(new RegExp('total\\s*fat\\s*' + N + 'g', 'i'));
  P.satfat = grab(new RegExp('sat(?:urated|\\.)?\\s*fat\\s*' + N + 'g', 'i'));
  P.sodium = grab(new RegExp('sodium\\s*' + N + 'mg', 'i'));
  P.carbs = grab(new RegExp('total\\s*carb\\w*\\.?\\s*' + N + 'g', 'i'));
  P.fiber = grab(new RegExp('fib(?:er|re)\\s*' + N + 'g', 'i'));
  P.addedSugar = grab(new RegExp('includes\\s*' + N + 'g\\s*added', 'i'));
  P.sugar = grab(new RegExp('total\\s*sugars?\\s*' + N + 'g', 'i')) ?? grab(new RegExp('(?:^|[^d]\\s)sugars?\\s*' + N + 'g', 'i'));
  P.protein = grab(new RegExp('protein\\s*' + N + 'g', 'i'));
  out.found = Object.values(P).filter(v => v != null).length;
  return out;
}
function progressSheet(title) {
  const el = openSheet(`<div class="sheet-head"><span style="width:50px"></span><div class="sheet-title">${esc(title)}</div><span style="width:50px"></span></div>
    <div class="card" style="text-align:center"><div class="big" id="pg-pct">…</div><p class="muted small" id="pg-msg">Starting…</p>
    <div class="bar"><i id="pg-bar" style="width:0%"></i></div>
    <p class="tiny muted">The first time, the text reader downloads about 15 MB, then it’s saved on your phone. Your photo is processed on this phone and not uploaded.</p></div>`);
  return {
    set(m) {
      const pct = m.status === 'recognizing text' ? Math.round((m.progress || 0) * 100) : null;
      const msg = { 'loading tesseract core': 'Loading text reader…', 'loading language traineddata': 'Loading English reading data…', 'initializing api': 'Getting ready…', 'recognizing text': 'Reading the label…' }[m.status] || 'Working…';
      const a = $('#pg-msg', el), b = $('#pg-pct', el), c = $('#pg-bar', el);
      if (a) a.textContent = msg;
      if (b) b.textContent = pct != null ? pct + '%' : '…';
      if (c && pct != null) c.style.width = pct + '%';
    },
  };
}
async function labelPhotoFlow(opts = {}) {
  const file = await pickPhoto(); if (!file) return;
  let ocrUrl, thumbUrl;
  try { ocrUrl = await downscale(file, 2000); thumbUrl = await downscale(file, 480, 0.8); }
  catch (e) { toast(e.message); return; }
  const pg = progressSheet('Reading label');
  let text = '', failed = null;
  try { text = await ocrImage(ocrUrl, m => pg.set(m)); } catch (e) { failed = e; }
  closeSheet();
  if (failed) toast(navigator.onLine ? 'Couldn’t read the label automatically. You can type the numbers instead.' : 'The label reader needs internet the first time. You can type the numbers instead.', 5000);
  const parsed = parseLabel(text);
  const base = opts.food ? JSON.parse(JSON.stringify(opts.food)) : null;
  const ps = {};
  for (const [k] of NUTS) ps[k] = parsed.perServing[k] ?? base?.perServing?.[k] ?? null;
  const prefill = base || {
    id: uid(), name: '', brand: '', barcode: opts.barcode || null, per100: null, source: 'Label photo',
    favorite: false, useCount: 0, lastUsed: 0, createdAt: Date.now(),
  };
  prefill.perServing = hasAny(ps) ? ps : null;
  if (parsed.servingLabel) prefill.servingLabel = parsed.servingLabel;
  if (parsed.servingGrams) { prefill.servingGrams = parsed.servingGrams; prefill.baseUnit = parsed.baseUnit; }
  if (parsed.servingsPerContainer) { prefill.servingsPerContainer = parsed.servingsPerContainer; prefill.spcEstimated = false; }
  if (!prefill.imageUrl) prefill.imageUrl = thumbUrl;
  openEditFood(prefill, { isNew: !base, ocr: { found: parsed.found, text: text.trim() }, then: opts.then });
}

// ---------- Pickers shared by recipes and meal photos ----------
async function openFoodPicker(onPick, title = 'Choose a food') {
  const foods = (await DB.all('foods')).sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0) || a.name.localeCompare(b.name));
  const el = openSheet(`
    <div class="sheet-head"><button class="link" data-act="close">Cancel</button><div class="sheet-title">${esc(title)}</div><span style="width:50px"></span></div>
    <input class="in" id="fp-q" type="search" placeholder="Search my foods" autocomplete="off">
    <div class="row" style="margin:10px 0"><button class="btn secondary" style="flex:1" data-act="custom">New custom food</button>
      <button class="btn secondary" style="flex:1" data-act="label">Label photo</button></div>
    <div class="card"><ul class="list" id="fp-list"></ul></div>`);
  const draw = () => {
    const s = $('#fp-q', el).value.trim().toLowerCase();
    const m = foods.filter(f => !s || [f.name, f.brand].some(x => String(x || '').toLowerCase().includes(s))).slice(0, 80);
    $('#fp-list', el).innerHTML = m.length ? m.map(f => `<li><button class="item" data-food="${f.id}">${thumb(f.imageUrl)}<div class="grow"><div class="t">${esc(f.name)}</div>
      <div class="s">${esc([f.brand, f.servingLabel].filter(Boolean).join(' · '))}</div></div></button></li>`).join('')
      : '<li class="small muted" style="padding:12px 0">No saved foods match. Scan items first, or create a custom food.</li>';
  };
  $('#fp-q', el).oninput = draw; draw();
  el.onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.food) { const f = foods.find(x => x.id === b.dataset.food); closeSheet(); onPick(f); return; }
    if (b.dataset.act === 'close') closeSheet();
    if (b.dataset.act === 'custom') { closeSheet(); openEditFood(null, { then: onPick }); }
    if (b.dataset.act === 'label') { closeSheet(); labelPhotoFlow({ then: onPick }); }
  };
}
function openAmountSheet(food, cb) {
  const bu = food.baseUnit || 'g', canS = canUseServing(food), canG = canUseGrams(food);
  let unit = canS ? 'serving' : 'g';
  const el = openSheet(`
    <div class="sheet-head"><button class="link" data-act="close">Cancel</button><div class="sheet-title">How much?</div><span style="width:50px"></span></div>
    <div class="food-name" style="margin:6px 0 2px">${esc(food.name)}</div><div class="muted small">${esc(food.servingLabel || '')}</div>
    ${!canS && !canG ? '<div class="warnbox" style="margin-top:10px">This food has no nutrition numbers yet, so it will add nothing to the totals.</div>' : ''}
    <div class="seg" style="margin-top:12px">${canS ? '<button data-unit="serving">Servings</button>' : ''}${canG ? `<button data-unit="g">${bu === 'ml' ? 'Milliliters' : 'Grams'}</button>` : ''}</div>
    <input class="in" id="am-v" type="number" inputmode="decimal" step="any" style="margin-top:10px; font-size:22px; text-align:center">
    <p class="muted" id="am-k" style="text-align:center"></p>
    <div class="stack"><button class="btn primary big" data-act="ok">Add</button></div>`);
  const v = $('#am-v', el);
  const draw = () => {
    $$('[data-unit]', el).forEach(b => b.classList.toggle('on', b.dataset.unit === unit));
    const n = calcNutrients(food, num(v.value) || 0, unit);
    $('#am-k', el).textContent = n.kcal == null ? 'Calories: not listed' : fmt(n.kcal) + ' kcal';
  };
  v.value = unit === 'serving' ? '1' : String(food.servingGrams || 100); v.oninput = draw; draw();
  el.onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.unit) { unit = b.dataset.unit; v.value = unit === 'serving' ? '1' : String(food.servingGrams || 100); draw(); return; }
    if (b.dataset.act === 'close') closeSheet();
    if (b.dataset.act === 'ok') { const a = num(v.value); if (!(a > 0)) { toast('Enter an amount'); return; } closeSheet(); cb({ amount: a, unit }); }
  };
}

// ---------- Recipes ----------
function recipeTotals(r) {
  const total = emptyNuts(), partial = [];
  if (!r.ingredients.length) return { total, perServing: emptyNuts(), partial };
  for (const [k, l] of NUTS) {
    let sum = 0, any = false, miss = false;
    for (const ing of r.ingredients) {
      const v = calcNutrients(ing.food, ing.amount, ing.unit)[k];
      if (v == null) miss = true; else { sum += v; any = true; }
    }
    total[k] = any ? sum : null;
    if (any && miss) partial.push(l);
  }
  const sv = num(r.servings) || 1, perServing = emptyNuts();
  for (const [k] of NUTS) perServing[k] = total[k] == null ? null : total[k] / sv;
  return { total, perServing, partial };
}
async function openRecipesList() {
  const recipes = (await DB.all('foods')).filter(f => f.isRecipe).sort((a, b) => a.name.localeCompare(b.name));
  const el = openSheet(`
    <div class="sheet-head"><button class="link" data-act="close">Close</button><div class="sheet-title">Recipes</div><button class="link" data-act="new">New</button></div>
    ${recipes.length ? `<div class="card"><ul class="list">${recipes.map(r => `<li><button class="item" data-id="${r.id}"><div class="grow"><div class="t">${esc(r.name)}</div>
      <div class="s">${r.servings} servings · ${fmt(r.perServing?.kcal)} kcal each</div></div></button></li>`).join('')}</ul></div>`
      : '<div class="card small muted">No recipes yet. Add the ingredients once, and the app works out the nutrition per serving.</div>'}
    <div class="stack"><button class="btn primary big" data-act="new">New recipe</button></div>`);
  el.onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.id) { const r = recipes.find(x => x.id === b.dataset.id); closeSheet(); openLogSheet(r, { date: state.tab === 'diary' ? state.date : dateStr() }); return; }
    if (b.dataset.act === 'close') closeSheet();
    if (b.dataset.act === 'new') { closeSheet(); openRecipe(null, { then: f => openLogSheet(f, {}) }); }
  };
}
function openRecipe(recipe, opts = {}) {
  const r = recipe ? JSON.parse(JSON.stringify(recipe)) : {
    id: uid(), isRecipe: true, name: '', servings: 4, cookedWeight: null, ingredients: [], source: 'Recipe',
    favorite: false, useCount: 0, lastUsed: 0, createdAt: Date.now(), baseUnit: 'g',
  };
  const el = openSheet(`
    <div class="sheet-head"><button class="link" data-act="close">Cancel</button><div class="sheet-title">${recipe ? 'Edit recipe' : 'New recipe'}</div><button class="link" data-act="save">Save</button></div>
    <label class="f">Recipe name *</label><input class="in" id="rc-name" value="${esc(r.name)}" placeholder="e.g. Chicken casserole">
    <div class="grid2"><div><label class="f">Servings it makes *</label><input class="in" id="rc-sv" type="number" inputmode="decimal" step="any" value="${r.servings}"></div>
      <div><label class="f">Cooked weight (g)</label><input class="in" id="rc-wt" type="number" inputmode="decimal" step="any" value="${r.cookedWeight ?? ''}" placeholder="optional"></div></div>
    <p class="tiny muted">Weigh the finished dish if you can — then you can log it by grams too.</p>
    <label class="f">Ingredients</label><div class="card"><ul class="list" id="rc-list"></ul>
      <button class="btn secondary block" style="margin-top:10px" data-act="add">+ Add ingredient</button></div>
    <label class="f">Nutrition</label><div class="card" style="padding:6px 16px"><table class="nut" id="rc-tot"></table></div>
    <div id="rc-partial"></div>
    <div class="stack"><button class="btn primary big" data-act="save">Save recipe</button>
    ${recipe ? '<button class="btn danger" data-act="delete">Delete recipe</button>' : ''}</div>`);
  const draw = () => {
    r.servings = num($('#rc-sv', el).value) || r.servings;
    $('#rc-list', el).innerHTML = r.ingredients.length ? r.ingredients.map((ing, i) => {
      const n = calcNutrients(ing.food, ing.amount, ing.unit);
      return `<li class="spread"><div class="item" style="flex:1"><div class="grow"><div class="t">${esc(ing.food.name)}</div><div class="s">${esc(amountLabel(ing))} · ${n.kcal == null ? 'kcal not listed' : fmt(n.kcal) + ' kcal'}</div></div></div>
        <button class="link" style="color:var(--red)" data-rm="${i}" aria-label="Remove">Remove</button></li>`;
    }).join('') : '<li class="small muted" style="padding:8px 0">No ingredients yet.</li>';
    const { total, perServing, partial } = recipeTotals(r);
    $('#rc-tot', el).innerHTML = `<tr><td class="muted small">Nutrient</td><td class="muted small" style="text-align:right">Whole recipe · Per serving</td></tr>` +
      NUTS.map(([k, l, u, d]) => `<tr class="${k === 'kcal' ? 'main' : ''}"><td>${l}</td><td>${total[k] == null ? '<span class="na">—</span>' : fmt(total[k], d) + ' · ' + fmt(perServing[k], d) + (k === 'kcal' ? '' : ' ' + u)}</td></tr>`).join('');
    $('#rc-partial', el).innerHTML = partial.length ? `<div class="warnbox">Partial: some ingredients don’t list ${esc(partial.join(', '))}, so those totals may be low.</div>` : '';
  };
  $('#rc-sv', el).oninput = draw; draw();
  el.onclick = async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.rm != null) { r.ingredients.splice(Number(b.dataset.rm), 1); draw(); return; }
    const a = b.dataset.act;
    if (a === 'close') closeSheet();
    else if (a === 'add') openFoodPicker(f => openAmountSheet(f, ({ amount, unit }) => { r.ingredients.push({ food: snapshot(f), amount, unit, baseUnit: f.baseUnit || 'g' }); draw(); }), 'Add ingredient');
    else if (a === 'delete') { if (!confirm('Delete this recipe? Past diary entries keep their values.')) return; await DB.del('foods', r.id); closeAllSheets(); toast('Recipe deleted'); render(); }
    else if (a === 'save') {
      r.name = $('#rc-name', el).value.trim();
      r.servings = num($('#rc-sv', el).value);
      r.cookedWeight = num($('#rc-wt', el).value);
      if (!r.name) { toast('Please name the recipe'); return; }
      if (!(r.servings > 0)) { toast('Enter how many servings it makes'); return; }
      if (!r.ingredients.length) { toast('Add at least one ingredient'); return; }
      const { total, perServing, partial } = recipeTotals(r);
      r.perServing = hasAny(perServing) ? perServing : null;
      r.servingGrams = r.cookedWeight ? r.cookedWeight / r.servings : null;
      r.per100 = r.cookedWeight && hasAny(total) ? Object.fromEntries(NUTS.map(([k]) => [k, total[k] == null ? null : total[k] / r.cookedWeight * 100])) : null;
      r.servingLabel = `1 of ${fmt(r.servings, 1)} servings` + (r.servingGrams ? ` (${fmt(r.servingGrams)} g)` : '');
      r.partial = partial;
      r.incomplete = isIncomplete(r) || CORE.some(k => partial.includes(NUTS.find(n => n[0] === k)[1]));
      r.updatedAt = Date.now();
      await DB.put('foods', r);
      closeSheet(); toast(recipe ? 'Recipe updated' : 'Recipe saved');
      if (opts.then) opts.then(r); else render();
    }
  };
}

// ---------- Meal photo (no-cost workflow) ----------
async function mealPhotoFlow(opts = {}) {
  const file = await pickPhoto(); if (!file) return;
  let photo;
  try { photo = await downscale(file, 900, 0.8); } catch (e) { toast(e.message); return; }
  const items = [];
  let meal = opts.meal || defaultMeal(), date = opts.date || dateStr();
  const el = openSheet(`
    <div class="sheet-head"><button class="link" data-act="close">Cancel</button><div class="sheet-title">Meal photo</div><span style="width:50px"></span></div>
    <img src="${photo}" alt="Your meal" style="width:100%; max-height:280px; object-fit:cover; border-radius:16px; margin:4px 0 10px">
    <div class="warnbox">Photos are estimates. Hidden oils, sauces and exact weights can’t be seen in a picture, so pick each item and adjust the portion before saving.</div>
    <label class="f">What’s on the plate</label><div class="card"><ul class="list" id="mp-items"></ul>
      <div class="row" style="margin-top:10px"><button class="btn secondary" style="flex:1" data-act="food">+ From my foods</button>
      <button class="btn secondary" style="flex:1" data-act="est">+ Quick estimate</button></div></div>
    <label class="f">Meal</label><div class="seg" id="mp-meal">${MEALS.map(([m, l]) => `<button data-meal="${m}">${l}</button>`).join('')}</div>
    <label class="f">Date</label><input class="in" type="date" id="mp-date" value="${date}">
    <div class="card" style="margin-top:14px"><div class="spread"><b>Total</b><b id="mp-tot">0 kcal</b></div></div>
    <p class="tiny muted">Free AI tip: share this photo with Claude, ask for a portion and calorie estimate, then enter it with “Quick estimate”. Automatic in-app recognition would need a paid AI service, which isn’t turned on.</p>
    <div class="stack"><button class="btn primary big" data-act="save" id="mp-save">Save meal</button></div>`);
  const draw = () => {
    $$('#mp-meal button', el).forEach(b => b.classList.toggle('on', b.dataset.meal === meal));
    $('#mp-items', el).innerHTML = items.length ? items.map((it, i) => `<li class="spread"><div class="item" style="flex:1"><div class="grow"><div class="t">${esc(it.food.name)}${it.estimate ? ' <span class="pill warn">estimate</span>' : ''}</div>
      <div class="s">${esc(it.estimate ? (it.food.servingLabel || 'estimate') : amountLabel(it))} · ${it.nutrients.kcal == null ? 'kcal —' : fmt(it.nutrients.kcal) + ' kcal'}</div></div></div>
      <button class="link" style="color:var(--red)" data-rm="${i}">Remove</button></li>`).join('') : '<li class="small muted" style="padding:8px 0">Add each food you see.</li>';
    $('#mp-tot', el).textContent = fmt(items.reduce((s, it) => s + (it.nutrients.kcal || 0), 0)) + ' kcal';
    $('#mp-save', el).disabled = !items.length;
  };
  $('#mp-date', el).onchange = e => { if (e.target.value) date = e.target.value; };
  draw();
  el.onclick = async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.meal) { meal = b.dataset.meal; draw(); return; }
    if (b.dataset.rm != null) { items.splice(Number(b.dataset.rm), 1); draw(); return; }
    const a = b.dataset.act;
    if (a === 'close') { if (!items.length || confirm('Discard this meal?')) closeSheet(); }
    else if (a === 'food') openFoodPicker(f => openAmountSheet(f, ({ amount, unit }) => {
      items.push({ food: snapshot(f), foodId: f.id, amount, unit, baseUnit: f.baseUnit || 'g', nutrients: calcNutrients(f, amount, unit) }); draw();
    }), 'Add a food');
    else if (a === 'est') openQuickEstimate(it => { items.push(it); draw(); });
    else if (a === 'save') {
      if (!items.length) return;
      const photoId = uid();
      await DB.put('photos', { id: photoId, dataUrl: photo, date, createdAt: Date.now() });
      let i = 0;
      for (const it of items) {
        await DB.put('entries', { ...it, id: uid(), date, meal, photoId, createdAt: Date.now() + i++, updatedAt: Date.now() });
        if (it.foodId) { const f = await DB.get('foods', it.foodId); if (f) { f.useCount = (f.useCount || 0) + 1; f.lastUsed = Date.now(); await DB.put('foods', f); } }
      }
      closeAllSheets(); toast(`Saved to ${MEAL_LABEL[meal]}`); render();
    }
  };
}
function openQuickEstimate(cb, prefill = '') {
  const fields = [['kcal', 'Calories', 'kcal'], ['protein', 'Protein', 'g'], ['carbs', 'Carbs', 'g'], ['fat', 'Fat', 'g'], ['fiber', 'Fiber', 'g']];
  const el = openSheet(`
    <div class="sheet-head"><button class="link" data-act="close">Cancel</button><div class="sheet-title">Quick estimate</div><span style="width:50px"></span></div>
    <p class="small muted">For foods without a label, like a restaurant dish. It’s saved and shown as an estimate. Leave anything you don’t know blank.</p>
    <label class="f">Food *</label><input class="in" id="qe-name" value="${esc(prefill)}" placeholder="e.g. Chicken fajitas">
    <label class="f">Portion</label><input class="in" id="qe-por" placeholder="e.g. about 1½ cups">
    <div class="grid2">${fields.map(([k, l, u]) => `<div><label class="f">${l} (${u})</label><input class="in" data-k="${k}" type="number" inputmode="decimal" step="any"></div>`).join('')}</div>
    <label class="row small" style="gap:10px; margin-top:14px"><input type="checkbox" id="qe-save" style="width:22px;height:22px"> Save to my foods for next time (great for your regular restaurant orders)</label>
    <p class="tiny muted">No nutrition info? Snap a photo of the meal or menu and ask Claude for an estimate, then enter it here.</p>
    <div class="stack"><button class="btn primary big" data-act="ok">Add</button></div>`);
  el.onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.act === 'close') closeSheet();
    if (b.dataset.act === 'ok') {
      const name = $('#qe-name', el).value.trim(); if (!name) { toast('Name the food'); return; }
      const ps = emptyNuts(); $$('[data-k]', el).forEach(i => { ps[i.dataset.k] = num(i.value); });
      const portion = $('#qe-por', el).value.trim();
      const food = { id: uid(), name, brand: '', servingLabel: portion || 'estimated portion', servingGrams: null, baseUnit: 'g', per100: null, perServing: ps, source: 'Estimate', incomplete: true };
      const save = $('#qe-save', el).checked;
      if (save) { food.incomplete = isIncomplete(food); food.favorite = false; food.useCount = 1; food.lastUsed = Date.now(); food.createdAt = Date.now(); DB.put('foods', food); }
      closeSheet();
      cb({ food, foodId: save ? food.id : null, amount: 1, unit: 'serving', baseUnit: 'g', nutrients: calcNutrients(food, 1, 'serving'), estimate: true });
    }
  };
}

// ---------- Phase 3: weight, measurements ----------
const MEASURES = [['waist', 'Waist (at navel)'], ['chest', 'Chest'], ['neck', 'Neck'], ['hips', 'Hips'], ['thigh', 'Thigh']];
function lastPerDay(list, key) {
  const m = {};
  for (const r of list.slice().sort((a, b) => (a.date + (a.createdAt || 0)).localeCompare(b.date + (b.createdAt || 0)))) m[r.date] = r[key];
  return Object.keys(m).sort().map(d => ({ date: d, v: m[d] }));
}
function avgWindow(days, endDate, n = 7) {
  const start = addDays(endDate, -(n - 1));
  const w = days.filter(x => x.date >= start && x.date <= endDate);
  return w.length ? w.reduce((s, x) => s + x.v, 0) / w.length : null;
}
function daysBetween(a, b) { return Math.round((parseD(b) - parseD(a)) / 864e5); }
// Trend is judged from 7-day averages over weeks, never from a single weigh-in.
function weightStats(days, settings) {
  if (!days.length) return null;
  const first = days[0], last = days[days.length - 1];
  const avg7 = avgWindow(days, last.date);
  const start = num(settings.startWeight) ?? first.v;
  const span = daysBetween(first.date, last.date);
  const avg7ago30 = span >= 30 ? avgWindow(days, addDays(last.date, -30)) : null;
  const avg7ago21 = span >= 28 ? avgWindow(days, addDays(last.date, -21)) : null;
  let trend;
  const recent = days.filter(d => d.date > addDays(last.date, -28)).length;
  const ref = days.filter(d => d.date <= addDays(last.date, -56)).pop();
  const Dl = d => parseD(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  if (recent < 8 && ref) {
    // Weigh-ins are spaced out: compare actual weigh-ins at least 8 weeks apart instead of 7-day averages.
    const wks = daysBetween(ref.date, last.date) / 7, ch = last.v - ref.v, rate = ch / wks;
    trend = Math.abs(rate) < 0.25
      ? { kind: 'steady', text: `${fmt(last.v, 1)} lb on ${Dl(last.date)} vs ${fmt(ref.v, 1)} lb on ${Dl(ref.date)}: under ¼ lb a week over ${fmt(wks, 0)} weeks, so weight has leveled off. Weigh-ins are spread out, so weighing a few times a week will make this more reliable.` }
      : { kind: ch < 0 ? 'down' : 'up', text: `${fmt(last.v, 1)} lb on ${Dl(last.date)} vs ${fmt(ref.v, 1)} lb on ${Dl(ref.date)}: ${ch < 0 ? 'down' : 'up'} ${fmt(Math.abs(ch), 1)} lb over ${fmt(wks, 0)} weeks (about ${fmt(Math.abs(rate), 1)} lb/week). Weigh-ins are spread out, so weighing a few times a week will make this more reliable.` };
  } else if (span < 14 || days.length < 5) trend = { kind: 'early', text: 'Keep logging — a reliable trend needs about 2 weeks of weigh-ins.' };
  else if (avg7ago21 != null && avg7 != null) {
    const ch = avg7 - avg7ago21, perWk = ch / 3;
    if (Math.abs(ch) < 0.5) trend = { kind: 'steady', text: `Your 7-day average has changed less than 0.5 lb over the last 3 weeks. That’s a true leveling-off, not a day-to-day swing — worth mentioning to your provider if it continues.` };
    else trend = { kind: ch < 0 ? 'down' : 'up', text: `7-day average is ${ch < 0 ? 'down' : 'up'} ${fmt(Math.abs(ch), 1)} lb over 3 weeks (about ${fmt(Math.abs(perWk), 1)} lb/week).` };
  } else {
    const a14 = avgWindow(days, addDays(last.date, -14));
    trend = a14 != null && avg7 != null ? { kind: 'short', text: `7-day average ${avg7 <= a14 ? 'down' : 'up'} ${fmt(Math.abs(avg7 - a14), 1)} lb vs 2 weeks ago. A longer view needs 4+ weeks of data.` } : { kind: 'early', text: 'Keep logging to see a trend.' };
  }
  return {
    first, last, avg7, start, lost: start - last.v, pctLost: start ? (start - last.v) / start * 100 : null,
    change30: avg7ago30 != null && avg7 != null ? avg7 - avg7ago30 : null, trend,
    toGoal: num(settings.goalWeight) != null ? last.v - num(settings.goalWeight) : null,
  };
}
function movingAvg(days) { return days.map(d => ({ date: d.date, v: avgWindow(days, d.date) })); }
function lineChart(series, opts = {}) {
  const W = 340, H = opts.h || 170, L = 34, R = 8, T = 10, B = 22;
  const pts = series.flatMap(s => s.pts);
  if (pts.length < 1) return '<p class="small muted">No data yet.</p>';
  const ts = pts.map(p => parseD(p.date).getTime());
  let minT = Math.min(...ts), maxT = Math.max(...ts); if (minT === maxT) { minT -= 864e5; maxT += 864e5; }
  const ys = pts.map(p => p.v).concat(opts.goal != null ? [opts.goal] : []);
  let minY = Math.min(...ys), maxY = Math.max(...ys); const pad = Math.max(1, (maxY - minY) * 0.12); minY -= pad; maxY += pad;
  const X = d => L + (parseD(d).getTime() - minT) / (maxT - minT) * (W - L - R);
  const Y = v => T + (maxY - v) / (maxY - minY) * (H - T - B);
  const ticks = [maxY - pad, (minY + maxY) / 2, minY + pad];
  const lab = d => parseD(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const sorted = pts.slice().sort((a, b) => a.date.localeCompare(b.date));
  let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${esc(opts.label || 'chart')}" style="display:block">`;
  for (const t of ticks) svg += `<line x1="${L}" x2="${W - R}" y1="${Y(t).toFixed(1)}" y2="${Y(t).toFixed(1)}" stroke="#8884" stroke-width=".5"/><text x="${L - 4}" y="${(Y(t) + 3).toFixed(1)}" font-size="9" text-anchor="end" fill="#888">${fmt(t, 0)}</text>`;
  if (opts.goal != null) svg += `<line x1="${L}" x2="${W - R}" y1="${Y(opts.goal).toFixed(1)}" y2="${Y(opts.goal).toFixed(1)}" stroke="#ff9f0a" stroke-dasharray="4 3" stroke-width="1.2"/><text x="${W - R}" y="${(Y(opts.goal) - 3).toFixed(1)}" font-size="9" text-anchor="end" fill="#ff9f0a">goal</text>`;
  for (const s of series) {
    const p = s.pts.filter(x => x.v != null).sort((a, b) => a.date.localeCompare(b.date));
    if (s.type === 'line' && p.length > 1) svg += `<polyline fill="none" stroke="${s.color}" stroke-width="2.2" stroke-linejoin="round" points="${p.map(x => X(x.date).toFixed(1) + ',' + Y(x.v).toFixed(1)).join(' ')}"/>`;
    if (s.type === 'dots') svg += p.map(x => `<circle cx="${X(x.date).toFixed(1)}" cy="${Y(x.v).toFixed(1)}" r="2.6" fill="${s.color}" opacity=".55"/>`).join('');
  }
  svg += `<text x="${L}" y="${H - 6}" font-size="9" fill="#888">${lab(sorted[0].date)}</text><text x="${W - R}" y="${H - 6}" font-size="9" text-anchor="end" fill="#888">${lab(sorted[sorted.length - 1].date)}</text></svg>`;
  return svg;
}
function openWeightSheet() {
  const el = openSheet(`
    <div class="sheet-head"><button class="link" data-act="close">Cancel</button><div class="sheet-title">Log weight</div><span style="width:50px"></span></div>
    <label class="f">Weight (lb)</label><input class="in" id="wt-v" type="number" inputmode="decimal" step="any" style="font-size:24px; text-align:center">
    <label class="f">Date</label><input class="in" id="wt-d" type="date" value="${dateStr()}">
    <label class="f">Note</label><input class="in" id="wt-n" placeholder="optional">
    <p class="tiny muted">Tip: weigh at the same time each day, like first thing in the morning. The app watches the 7-day average, so daily ups and downs won’t mislead you.</p>
    <div class="stack"><button class="btn primary big" data-act="ok">Save</button></div>
    <h3>Recent</h3><div class="card"><ul class="list" id="wt-list"></ul></div>`);
  const drawList = async () => {
    const list = (await DB.all('weights')).sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 30);
    $('#wt-list', el).innerHTML = list.length ? list.map(w => `<li class="spread"><div class="item" style="flex:1"><div class="grow"><div class="t">${fmt(w.lb, 1)} lb</div>
      <div class="s">${esc(niceDate(w.date))}${w.source ? ' · ' + esc(w.source) : ''}${w.note ? ' · ' + esc(w.note) : ''}</div></div></div><button class="link" style="color:var(--red)" data-del="${w.id}">Delete</button></li>`).join('')
      : '<li class="small muted" style="padding:8px 0">No weigh-ins yet.</li>';
  };
  drawList();
  setTimeout(() => $('#wt-v', el).focus(), 300);
  el.onclick = async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.del) { if (confirm('Delete this weigh-in?')) { await DB.del('weights', b.dataset.del); drawList(); render(); } return; }
    if (b.dataset.act === 'close') closeSheet();
    if (b.dataset.act === 'ok') {
      const v = num($('#wt-v', el).value);
      if (!(v > 40 && v < 1000)) { toast('Enter your weight in pounds'); return; }
      await DB.put('weights', { id: uid(), date: $('#wt-d', el).value || dateStr(), lb: v, note: $('#wt-n', el).value.trim(), createdAt: Date.now() });
      closeSheet(); toast('Weight saved'); render();
    }
  };
}
function openMeasureSheet() {
  const el = openSheet(`
    <div class="sheet-head"><button class="link" data-act="close">Cancel</button><div class="sheet-title">Measurements</div><span style="width:50px"></span></div>
    <p class="small muted">Inches. Fill in only what you measured today.</p>
    <label class="f">Date</label><input class="in" id="ms-d" type="date" value="${dateStr()}">
    <div class="grid2">${MEASURES.map(([k, l]) => `<div><label class="f">${l}</label><input class="in" data-m="${k}" type="number" inputmode="decimal" step="any"></div>`).join('')}</div>
    <div class="stack"><button class="btn primary big" data-act="ok">Save</button></div>`);
  el.onclick = async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.act === 'close') closeSheet();
    if (b.dataset.act === 'ok') {
      const rec = { id: uid(), date: $('#ms-d', el).value || dateStr(), createdAt: Date.now() };
      let any = false; $$('[data-m]', el).forEach(i => { const v = num(i.value); rec[i.dataset.m] = v; if (v != null) any = true; });
      if (!any) { toast('Enter at least one measurement'); return; }
      await DB.put('measurements', rec); closeSheet(); toast('Measurements saved'); render();
    }
  };
}
function measureSummary(list) {
  return MEASURES.map(([k, l]) => {
    const d = lastPerDay(list.filter(r => r[k] != null), k);
    if (!d.length) return null;
    return { k, l, first: d[0], last: d[d.length - 1], change: d[d.length - 1].v - d[0].v };
  }).filter(Boolean);
}

// ---------- Progress tab ----------
async function renderProgress() {
  const s = state.settings, today = dateStr();
  const range = state.wRange || 90;
  const weights = await DB.all('weights');
  const days = lastPerDay(weights, 'lb');
  const ws = weightStats(days, s);
  const tr = trendSeries(days);
  const ex = await expenditureEstimate();
  const shown = range === 'all' ? days : days.filter(d => d.date >= addDays(today, -range));
  const meas = measureSummary(await DB.all('measurements'));
  const health = Object.fromEntries((await DB.all('health')).map(h => [h.date, h]));
  const cal = [];
  for (let i = 13; i >= 0; i--) { const d = addDays(today, -i); const es = await entriesFor(d); cal.push({ d, n: es.length, ...sumNuts(es).t }); }
  const last7 = cal.slice(-7), logged = last7.filter(x => x.n);
  const avg = k => logged.length ? logged.reduce((a, x) => a + x[k], 0) / logged.length : null;
  const max = Math.max(s.kcal, ...last7.map(x => x.kcal)) * 1.1 || 1;
  const wDay = Object.fromEntries(days.map(d => [d.date, d.v]));
  const hasHealth = cal.some(x => health[x.d]);
  view().innerHTML = `
  <header class="topbar"><h1>Progress</h1><button class="icon-btn" data-act="report" aria-label="Report">${ICON.label}</button></header>
  <section class="card"><div class="spread"><h2 style="margin:0">Weight</h2><button class="btn secondary" data-act="weight">+ Log weight</button></div>
    ${ws ? `<div class="totals" style="grid-template-columns:repeat(3,1fr); margin-top:12px">
      <div><div class="big">${fmt(ws.last.v, 1)}</div><div class="lbl">latest (lb)</div></div>
      <div><div class="big">${fmt(tr[tr.length - 1].v, 1)}</div><div class="lbl">trend weight</div></div>
      <div><div class="big">${ws.lost >= 0 ? '−' : '+'}${fmt(Math.abs(ws.lost), 1)}</div><div class="lbl">${fmt(Math.abs(ws.pctLost), 1)}% ${ws.lost >= 0 ? 'lost' : 'gained'}</div></div></div>
      <div class="seg" style="margin:14px 0 6px">${[[30, '30 days'], [90, '90 days'], ['all', 'All']].map(([v, l]) => `<button data-range="${v}" class="${String(range) === String(v) ? 'on' : ''}">${l}</button>`).join('')}</div>
      ${lineChart([{ pts: shown.map(d => ({ date: d.date, v: d.v })), type: 'dots', color: '#1f9d55' }, { pts: tr.filter(d => shown.some(x => x.date === d.date)), type: 'line', color: '#0a84ff' }], { goal: num(s.goalWeight), label: 'Weight chart' })}
      <p class="tiny muted" style="margin:4px 0 10px">Dots: weigh-ins · Blue line: trend weight (smoothed so single days don’t mislead)${num(s.goalWeight) != null ? ' · Dashed: goal' : ''}</p>
      <div class="kv" style="border-top:0"><span class="muted">Starting weight</span><span>${fmt(ws.start, 1)} lb${num(s.startWeight) == null ? ' (first weigh-in, ' + esc(niceDate(ws.first.date)) + ')' : ''}</span></div>
      <div class="kv"><span class="muted">30-day change (7-day avg)</span><span>${ws.change30 == null ? 'needs 30 days' : (ws.change30 <= 0 ? '−' : '+') + fmt(Math.abs(ws.change30), 1) + ' lb'}</span></div>
      ${num(s.heightIn) ? `<div class="kv"><span class="muted">BMI (latest · at start)</span><span>${fmt(703 * ws.last.v / num(s.heightIn) ** 2, 1)} · ${fmt(703 * ws.start / num(s.heightIn) ** 2, 1)}</span></div>` : ''}
      ${ws.toGoal != null ? `<div class="kv"><span class="muted">To goal (${fmt(num(s.goalWeight), 1)} lb)</span><span>${ws.toGoal > 0 ? fmt(ws.toGoal, 1) + ' lb to go' : 'Goal reached'}</span></div>` : ''}
      <div class="warnbox" style="margin:12px 0 0">${esc(ws.trend.text)}</div>`
      : `<p class="small muted">Log your first weigh-in to start tracking. Set a goal and starting weight in Settings (gear on Home).</p>`}
  </section>
  <section class="card"><h2>Energy balance</h2>
    ${ex.ok ? `<div class="totals" style="grid-template-columns:repeat(3,1fr)"><div><div class="big">${fmt(ex.tdee, 0)}</div><div class="lbl">est. burn / day</div></div>
      <div><div class="big">${fmt(ex.intake)}</div><div class="lbl">avg eaten</div></div><div><div class="big">${ex.rate <= 0 ? '−' : '+'}${fmt(Math.abs(ex.rate), 1)}</div><div class="lbl">lb / week</div></div></div>
      <p class="tiny muted" style="margin:10px 0 0">Estimated from your last 28 days of logged food and your trend weight (like MacroFactor). It’s only as accurate as your logging — skipped snacks make it read low.</p>
      ${(() => { const c = checkinSuggestion(ex, s); if (!c) return '';
        return c.same ? `<div class="tip good" style="margin-top:10px"><span class="ti">✅</span><span>Weekly check-in: your ${fmt(s.kcal)} kcal target fits your ${c.pace} lb/week pace. No change needed.</span></div>`
          : `<div class="tip act" style="margin-top:10px"><span class="ti">🎯</span><span>Weekly check-in: to lose about ${c.pace} lb/week, your measured burn suggests ~${fmt(c.target)} kcal. Suggested step: <b>${fmt(c.kcal)} kcal</b> (carbs ${c.carbs} g, fat ${c.fat} g; protein stays ${s.protein} g).</span></div>
            <button class="btn primary block" style="margin-top:8px" data-act="checkin" data-k="${c.kcal}" data-c="${c.carbs}" data-f="${c.fat}">Apply new target</button>`; })()}`
      : `<p class="small muted" style="margin:0">Once you’ve logged food on ${ex.needDays} of the last 28 days and weighed in at least 4 times, the app estimates how many calories you actually burn — the best way to see if a plateau is real. So far: ${ex.loggedDays} logged days, ${ex.weighIns} weigh-ins.</p>`}
  </section>
  <section class="card recap"><h2>Weekly recap</h2><p class="small muted" style="margin-top:0">A summary of your last 7 days — food, weight trend, doses and activity — ready to paste into your chat with Claude for patterns and suggestions.</p>
    <button class="btn secondary block" data-act="ask-week">✨ Ask Claude about this week</button></section>
  <section class="card"><div class="spread"><h2 style="margin:0">Measurements</h2><button class="btn secondary" data-act="measure">+ Log</button></div>
    ${meas.length ? meas.map(m => { const fd = esc(parseD(m.first.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));
      return `<div class="kv"><span>${m.l}</span><span>${fmt(m.last.v, 2)} in <span class="muted small">(${m.first.date === m.last.date ? 'measured ' + fd : (m.change <= 0 ? '−' : '+') + fmt(Math.abs(m.change), 2) + ' since ' + fd})</span></span></div>`; }).join('')
      : '<p class="small muted">Waist, chest, neck, hips and thigh, in inches.</p>'}
  </section>
  ${await (async () => { const ph = (await DB.all('pphotos')).sort((a, b) => b.date.localeCompare(a.date));
    return `<section class="card"><div class="spread"><h2 style="margin:0">Progress photos</h2><button class="btn secondary" data-act="photo-add">+ Add</button></div>
      ${ph.length ? `<div class="photo-strip">${ph.slice(0, 8).map(p => `<img src="${p.dataUrl}" alt="">`).join('')}</div><button class="btn block" style="margin-top:10px" data-act="photo-compare">Compare before &amp; after</button>`
        : '<p class="small muted">Photos often show progress the scale doesn’t — especially during a plateau. They stay private on this phone.</p>'}</section>`; })()}
  <section class="card"><div class="spread"><h2 style="margin:0">Calories, last 7 days</h2><span class="pill">goal ${fmt(s.kcal)}</span></div>
    <div class="week"><div class="goal-line" style="bottom:${(s.kcal / max * 100).toFixed(1)}%"></div>
    ${last7.map(x => `<div class="col"><div class="b ${x.n ? '' : 'empty'}" style="height:${x.n ? Math.max(2, x.kcal / max * 100) : 2}%"></div></div>`).join('')}</div>
    <div class="week-labels">${last7.map(x => `<div>${parseD(x.d).toLocaleDateString(undefined, { weekday: 'narrow' })}</div>`).join('')}</div>
    <p class="small muted">7-day averages (${logged.length} logged day${logged.length === 1 ? '' : 's'}): ${fmt(avg('kcal'))} kcal · ${fmt(avg('protein'))} g protein · ${fmt(avg('fiber'))} g fiber</p></section>
  <section class="card"><h2>Food, activity &amp; weight — 14 days</h2>
    ${hasHealth ? '' : '<p class="small muted" style="margin-top:0">Steps and sleep appear after you import Apple Health data (Health tab).</p>'}
    <div style="overflow-x:auto"><table class="nut" style="font-size:14px; min-width:420px"><tr class="muted"><td>Day</td><td style="text-align:right">kcal</td><td style="text-align:right">Protein</td><td style="text-align:right">Steps</td><td style="text-align:right">Sleep</td><td style="text-align:right">Weight</td></tr>
    ${cal.slice().reverse().map(x => { const h = health[x.d] || {}; return `<tr><td>${esc(parseD(x.d).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric', weekday: 'short' }))}</td>
      <td style="text-align:right">${x.n ? fmt(x.kcal) : '—'}</td><td style="text-align:right">${x.n ? fmt(x.protein) + 'g' : '—'}</td>
      <td style="text-align:right">${fmt(h.steps)}</td><td style="text-align:right">${h.sleepHrs != null ? fmt(h.sleepHrs, 1) + 'h' : '—'}</td><td style="text-align:right">${wDay[x.d] != null ? fmt(wDay[x.d], 1) : '—'}</td></tr>`; }).join('')}
    </table></div></section>
  <div class="stack"><button class="btn primary big" data-act="report">Create progress report</button></div>`;
  view().onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.range) { state.wRange = b.dataset.range === 'all' ? 'all' : Number(b.dataset.range); render(); return; }
    const a = b.dataset.act;
    if (a === 'weight') openWeightSheet();
    else if (a === 'measure') openMeasureSheet();
    else if (a === 'report') openReportSheet();
    else if (a === 'ask-week') buildWeekRecap().then(t => shareText(t, 'Weekly recap'));
    else if (a === 'checkin') applyCheckin({ kcal: Number(b.dataset.k), carbs: Number(b.dataset.c), fat: Number(b.dataset.f) });
    else if (a === 'photo-add') addProgressPhoto();
    else if (a === 'photo-compare') openPhotoCompare();
  };
}

// ---------- Medication journal ----------
const APPETITE = ['Much less', 'Less', 'Normal', 'More'];
const SEVERITY = ['None', 'Mild', 'Moderate', 'Severe'];
function openMedProfile() {
  const s = state.settings;
  const el = openSheet(`
    <div class="sheet-head"><button class="link" data-act="close">Cancel</button><div class="sheet-title">My medication</div><button class="link" data-act="ok">Save</button></div>
    <p class="small muted">Enter what your prescription says. This journal records; it never suggests dose changes.</p>
    <label class="f">Medication</label><input class="in" id="mp-n" value="${esc(s.medName || '')}" placeholder="e.g. Wegovy">
    <label class="f">Current prescribed dose</label><input class="in" id="mp-d" value="${esc(s.medDose || '')}" placeholder="e.g. 0.5 mg">
    <label class="f">Schedule</label><select class="in" id="mp-s">${[['weekly', 'Once a week'], ['daily', 'Daily'], ['other', 'Other / as prescribed']].map(([v, l]) => `<option value="${v}"${(s.medSchedule || 'weekly') === v ? ' selected' : ''}>${l}</option>`).join('')}</select>
    <div class="stack"><button class="btn primary big" data-act="ok">Save</button></div>`);
  el.onclick = async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.act === 'close') closeSheet();
    if (b.dataset.act === 'ok') {
      Object.assign(state.settings, { medName: $('#mp-n', el).value.trim(), medDose: $('#mp-d', el).value.trim(), medSchedule: $('#mp-s', el).value });
      await DB.put('kv', state.settings); closeSheet(); toast('Saved'); render();
    }
  };
}
function openDoseSheet(rec) {
  const s = state.settings, r = rec || { id: uid(), type: 'dose', date: dateStr(), med: s.medName || '', dose: s.medDose || '', site: '', notes: '', createdAt: Date.now() };
  const el = openSheet(`
    <div class="sheet-head"><button class="link" data-act="close">Cancel</button><div class="sheet-title">${rec ? 'Edit dose' : 'Log dose'}</div><span style="width:50px"></span></div>
    <label class="f">Medication</label><input class="in" id="ds-m" value="${esc(r.med)}">
    <label class="f">Dose taken</label><input class="in" id="ds-d" value="${esc(r.dose)}" placeholder="e.g. 0.5 mg">
    <label class="f">Date</label><input class="in" id="ds-dt" type="date" value="${r.date}">
    <label class="f">Notes</label><input class="in" id="ds-n" value="${esc(r.notes)}">
    <div class="stack"><button class="btn primary big" data-act="ok">Save</button>${rec ? '<button class="btn danger" data-act="del">Delete</button>' : ''}</div>`);
  el.onclick = async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.act === 'close') closeSheet();
    if (b.dataset.act === 'del') { if (confirm('Delete this dose record?')) { await DB.del('meds', r.id); closeSheet(); render(); } }
    if (b.dataset.act === 'ok') {
      Object.assign(r, { med: $('#ds-m', el).value.trim(), dose: $('#ds-d', el).value.trim(), date: $('#ds-dt', el).value || dateStr(), notes: $('#ds-n', el).value.trim() });
      if (!r.med) { toast('Enter the medication name'); return; }
      await DB.put('meds', r); closeSheet(); toast('Dose logged'); render();
    }
  };
}
function openSymptomSheet(rec) {
  const r = rec || { id: uid(), type: 'symptom', date: dateStr(), nausea: 0, constipation: 0, appetite: 2, other: '', notes: '', createdAt: Date.now() };
  const seg = (k, opts) => `<div class="seg" data-seg="${k}">${opts.map((l, i) => `<button data-v="${i}" class="${r[k] === i ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  const el = openSheet(`
    <div class="sheet-head"><button class="link" data-act="close">Cancel</button><div class="sheet-title">How I feel</div><span style="width:50px"></span></div>
    <label class="f">Date</label><input class="in" id="sy-dt" type="date" value="${r.date}">
    <label class="f">Appetite</label>${seg('appetite', APPETITE)}
    <label class="f">Nausea</label>${seg('nausea', SEVERITY)}
    <label class="f">Constipation</label>${seg('constipation', SEVERITY)}
    <label class="f">Other side effects</label><input class="in" id="sy-o" value="${esc(r.other)}" placeholder="e.g. heartburn, fatigue, headache">
    <label class="f">Notes</label><input class="in" id="sy-n" value="${esc(r.notes)}">
    <p class="tiny muted">For severe or worrying symptoms, contact your healthcare provider — don’t wait for a report.</p>
    <div class="stack"><button class="btn primary big" data-act="ok">Save</button>${rec ? '<button class="btn danger" data-act="del">Delete</button>' : ''}</div>`);
  el.onclick = async e => {
    const b = e.target.closest('button'); if (!b) return;
    const sg = b.closest('[data-seg]');
    if (sg) { r[sg.dataset.seg] = Number(b.dataset.v); $$('button', sg).forEach(x => x.classList.toggle('on', x === b)); return; }
    if (b.dataset.act === 'close') closeSheet();
    if (b.dataset.act === 'del') { if (confirm('Delete this entry?')) { await DB.del('meds', r.id); closeSheet(); render(); } }
    if (b.dataset.act === 'ok') {
      Object.assign(r, { date: $('#sy-dt', el).value || dateStr(), other: $('#sy-o', el).value.trim(), notes: $('#sy-n', el).value.trim() });
      await DB.put('meds', r); closeSheet(); toast('Saved'); render();
    }
  };
}

// ---------- Apple Health import (export.zip or export.xml, read on the phone) ----------
async function zipEntryStream(file, match) {
  const tailLen = Math.min(file.size, 65557);
  const tail = new DataView(await file.slice(file.size - tailLen).arrayBuffer());
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('That file isn’t a zip. Choose export.zip from the Health app.');
  let count = tail.getUint16(eocd + 10, true), cdSize = tail.getUint32(eocd + 12, true), cdOff = tail.getUint32(eocd + 16, true);
  if (cdOff === 0xFFFFFFFF || count === 0xFFFF || cdSize === 0xFFFFFFFF) {
    const loc = eocd - 20;
    if (loc >= 0 && tail.getUint32(loc, true) === 0x07064b50) {
      const e64 = Number(tail.getBigUint64(loc + 8, true));
      const e = new DataView(await file.slice(e64, e64 + 56).arrayBuffer());
      count = Number(e.getBigUint64(32, true)); cdSize = Number(e.getBigUint64(40, true)); cdOff = Number(e.getBigUint64(48, true));
    }
  }
  const cd = new DataView(await file.slice(cdOff, cdOff + cdSize).arrayBuffer());
  const td = new TextDecoder();
  let p = 0;
  for (let n = 0; n < count && p + 46 <= cd.byteLength; n++) {
    if (cd.getUint32(p, true) !== 0x02014b50) break;
    const method = cd.getUint16(p + 10, true);
    let csize = cd.getUint32(p + 20, true), usize = cd.getUint32(p + 24, true), lho = cd.getUint32(p + 42, true);
    const nl = cd.getUint16(p + 28, true), xl = cd.getUint16(p + 30, true), cl = cd.getUint16(p + 32, true);
    const name = td.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nl));
    let q = p + 46 + nl; const xe = q + xl;
    while (q + 4 <= xe) {
      const id = cd.getUint16(q, true), sz = cd.getUint16(q + 2, true);
      if (id === 1) { let r = q + 4; if (usize === 0xFFFFFFFF) { usize = Number(cd.getBigUint64(r, true)); r += 8; } if (csize === 0xFFFFFFFF) { csize = Number(cd.getBigUint64(r, true)); r += 8; } if (lho === 0xFFFFFFFF) { lho = Number(cd.getBigUint64(r, true)); } }
      q += 4 + sz;
    }
    if (match(name)) {
      const lh = new DataView(await file.slice(lho, lho + 30).arrayBuffer());
      const start = lho + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
      const blob = file.slice(start, start + csize);
      if (method === 0) return { stream: blob.stream(), size: usize };
      if (method === 8) {
        if (typeof DecompressionStream === 'undefined') throw new Error('This iPhone’s software is too old to open the zip. Update iOS, or unzip it in Files and choose export.xml.');
        return { stream: blob.stream().pipeThrough(new DecompressionStream('deflate-raw')), size: usize };
      }
      throw new Error('Unsupported zip compression.');
    }
    p += 46 + nl + xl + cl;
  }
  return null;
}
function hkTime(s) { const m = String(s).match(/^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) ([+-]\d\d)(\d\d)$/); return m ? Date.parse(`${m[1]}T${m[2]}${m[3]}:${m[4]}`) : Date.parse(s); }
function makeHealthParser(since) {
  const agg = {};
  const day = d => (agg[d] = agg[d] || { steps: {}, active: {}, exercise: {}, sleep: {}, rhr: [0, 0], weight: null });
  const attr = (tag, n) => { const i = tag.indexOf(' ' + n + '="'); if (i < 0) return null; const s = i + n.length + 3; return tag.slice(s, tag.indexOf('"', s)); };
  const WANT = /HK(?:Quantity|Category)TypeIdentifier(StepCount|ActiveEnergyBurned|AppleExerciseTime|RestingHeartRate|BodyMass|SleepAnalysis)"/;
  let carry = '', records = 0;
  function handle(tag) {
    const m = tag.match(WANT); if (!m) return;
    const T = m[1], startS = attr(tag, 'startDate'); if (!startS) return;
    const endS = attr(tag, 'endDate') || startS, src = attr(tag, 'sourceName') || '?';
    if (T === 'SleepAnalysis') {
      const v = attr(tag, 'value') || ''; if (!/Asleep/.test(v)) return;
      const d = endS.slice(0, 10); if (d < since) return;
      const hrs = (hkTime(endS) - hkTime(startS)) / 36e5; if (!(hrs > 0 && hrs < 24)) return;
      const o = day(d).sleep; o[src] = (o[src] || 0) + hrs; records++; return;
    }
    const d = startS.slice(0, 10); if (d < since) return;
    const v = parseFloat(attr(tag, 'value')); if (!isFinite(v)) return;
    const unit = attr(tag, 'unit'), o = day(d); records++;
    if (T === 'StepCount') o.steps[src] = (o.steps[src] || 0) + v;
    else if (T === 'ActiveEnergyBurned') o.active[src] = (o.active[src] || 0) + (unit === 'kJ' ? v / 4.184 : v);
    else if (T === 'AppleExerciseTime') o.exercise[src] = (o.exercise[src] || 0) + v;
    else if (T === 'RestingHeartRate') { o.rhr[0] += v; o.rhr[1]++; }
    else if (T === 'BodyMass') { const lb = unit === 'kg' ? v * 2.20462 : unit === 'lb' ? v : null; if (lb == null) return; const t = hkTime(startS); if (!o.weight || t >= o.weight.t) o.weight = { v: lb, t }; }
  }
  return {
    feed(text, final) {
      carry += text;
      const cut = final ? carry.length : carry.lastIndexOf('\n');
      if (cut < 0) return;
      const part = carry.slice(0, cut); carry = carry.slice(cut);
      const re = /<Record\s[^>]*>/g; let mm;
      while ((mm = re.exec(part))) handle(mm[0]);
    },
    // Several devices (iPhone + Watch) can record the same steps; using the largest single source avoids double counting.
    result() {
      const mx = o => { const v = Object.values(o); return v.length ? Math.max(...v) : null; };
      return Object.keys(agg).sort().map(d => { const a = agg[d]; return {
        date: d, steps: mx(a.steps) != null ? Math.round(mx(a.steps)) : null, activeKcal: mx(a.active) != null ? Math.round(mx(a.active)) : null,
        exerciseMin: mx(a.exercise) != null ? Math.round(mx(a.exercise)) : null, sleepHrs: mx(a.sleep) != null ? Math.round(mx(a.sleep) * 10) / 10 : null,
        restingHR: a.rhr[1] ? Math.round(a.rhr[0] / a.rhr[1]) : null, weightLb: a.weight ? Math.round(a.weight.v * 10) / 10 : null };
      }).filter(r => r.steps != null || r.activeKcal != null || r.exerciseMin != null || r.sleepHrs != null || r.restingHR != null || r.weightLb != null);
    },
    get records() { return records; },
  };
}
async function importAppleHealth(file, sinceDays, onProgress) {
  const since = sinceDays ? addDays(dateStr(), -sinceDays) : '0000-00-00';
  let src;
  if (/\.xml$/i.test(file.name)) src = { stream: file.stream(), size: file.size };
  else src = await zipEntryStream(file, n => /(^|\/)export\.xml$/.test(n));
  if (!src) throw new Error('No export.xml inside that zip. Choose the export.zip made by the Health app.');
  const parser = makeHealthParser(since), dec = new TextDecoder(), reader = src.stream.getReader();
  let read = 0, lastTick = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    read += value.length;
    parser.feed(dec.decode(value, { stream: true }), false);
    if (Date.now() - lastTick > 250) { lastTick = Date.now(); onProgress(src.size ? Math.min(0.99, read / src.size) : null); await new Promise(r => setTimeout(r, 0)); }
  }
  parser.feed(dec.decode(), true);
  return { days: parser.result(), records: parser.records };
}
function openHealthImport() {
  const el = openSheet(`
    <div class="sheet-head"><button class="link" data-act="close">Cancel</button><div class="sheet-title">Import Apple Health</div><span style="width:50px"></span></div>
    <div class="card"><b>First, export from the Health app</b>
      <ol class="small" style="padding-left:20px; margin:8px 0 0"><li>Open <b>Health</b> → tap your picture (top right).</li><li>Tap <b>Export All Health Data</b> → <b>Export</b>. It can take a few minutes.</li><li>Choose <b>Save to Files</b>.</li></ol></div>
    <label class="f">How far back</label><select class="in" id="hi-r"><option value="90">Last 90 days</option><option value="365" selected>Last year</option><option value="0">Everything</option></select>
    <label class="row small" style="gap:10px; margin-top:14px"><input type="checkbox" id="hi-w" checked style="width:22px;height:22px"> Add Apple Health weights to my weight log (days I didn’t log one)</label>
    <p class="tiny muted">Imported: steps, active calories, exercise minutes, sleep, resting heart rate and weight. The file is read on this phone and never uploaded. Large exports can take a minute or two.</p>
    <div class="stack"><button class="btn primary big" data-act="pick">Choose export file</button></div>`);
  el.onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.act === 'close') closeSheet();
    if (b.dataset.act !== 'pick') return;
    const sinceDays = Number($('#hi-r', el).value), addW = $('#hi-w', el).checked;
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.zip,.xml,application/zip,text/xml,application/xml';
    inp.onchange = async () => {
      const file = inp.files && inp.files[0]; if (!file) return;
      closeSheet();
      const pg = openSheet(`<div class="sheet-head"><span></span><div class="sheet-title">Importing</div><span></span></div>
        <div class="card" style="text-align:center"><div class="big" id="hi-p">0%</div><p class="small muted">Reading your Health export on this phone…</p><div class="bar"><i id="hi-b" style="width:0%"></i></div></div>`);
      try {
        const res = await importAppleHealth(file, sinceDays, p => { if (p != null) { $('#hi-p', pg).textContent = Math.round(p * 100) + '%'; $('#hi-b', pg).style.width = (p * 100) + '%'; } });
        for (const d of res.days) await DB.put('health', d);
        let added = 0;
        if (addW) {
          const have = new Set((await DB.all('weights')).map(w => w.date));
          for (const d of res.days) if (d.weightLb != null && !have.has(d.date)) { await DB.put('weights', { id: uid(), date: d.date, lb: d.weightLb, source: 'Apple Health', createdAt: Date.now() }); added++; }
        }
        await DB.put('kv', { key: 'lastHealthImport', at: Date.now(), days: res.days.length });
        closeSheet();
        toast(res.days.length ? `Imported ${res.days.length} days${added ? `, ${added} weigh-ins` : ''}` : 'No matching data found for that period', 4000);
        render();
      } catch (err) { closeSheet(); toast('Import failed: ' + err.message, 5000); }
    };
    inp.click();
  };
}

// ---------- v5: Wegovy level estimate, side-effect trends, injection sites, progress photos, habits ----------
// Rough illustration only: semaglutide's half-life is about one week; absorption peaks ~1–3 days after a dose.
const SEMA = { ke: Math.LN2 / 165, ka: 0.06 };
function doseMg(s) { const m = String(s || '').match(/(\d+(?:\.\d+)?)\s*mg/i) || String(s || '').match(/(\d+(?:\.\d+)?)/); return m ? num(m[1]) : null; }
function medLevelSeries(doses, fromDate, toDate) {
  const pts = [], ds = doses.map(d => ({ t: parseD(d.date).getTime(), mg: doseMg(d.dose) })).filter(d => d.mg);
  const { ke, ka } = SEMA, norm = 1 / (Math.exp(-ke * Math.log(ka / ke) / (ka - ke)) - Math.exp(-ka * Math.log(ka / ke) / (ka - ke)));
  for (let d = fromDate; d <= toDate; d = addDays(d, 1)) {
    const t = parseD(d).getTime() + 12 * 36e5; let v = 0;
    for (const x of ds) { const h = (t - x.t) / 36e5; if (h > 0) v += x.mg * norm * (Math.exp(-ke * h) - Math.exp(-ka * h)); }
    pts.push({ date: d, v: Math.round(v * 100) / 100 });
  }
  return pts;
}
// ---- Progress photos ----
async function addProgressPhoto() {
  const file = await pickPhoto(); if (!file) return;
  let dataUrl; try { dataUrl = await downscale(file, 1100, 0.82); } catch (e) { toast(e.message); return; }
  const el = openSheet(`<div class="sheet-head"><button class="link" data-act="close">Cancel</button><div class="sheet-title">Progress photo</div><span style="width:50px"></span></div>
    <img src="${dataUrl}" alt="" style="width:100%; max-height:46vh; object-fit:contain; border-radius:16px; background:#000">
    <label class="f">Pose</label><div class="seg" id="pp-pose">${['Front', 'Side', 'Back'].map((p, i) => `<button data-p="${p}" class="${i === 0 ? 'on' : ''}">${p}</button>`).join('')}</div>
    <label class="f">Date</label><input class="in" type="date" id="pp-d" value="${dateStr()}">
    <p class="tiny muted">Same spot, lighting and time of day each time makes comparisons fair. Photos stay on this phone (and in your encrypted backups).</p>
    <div class="stack"><button class="btn primary big" data-act="ok">Save photo</button></div>`);
  let pose = 'Front';
  el.onclick = async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.p) { pose = b.dataset.p; $$('#pp-pose button', el).forEach(x => x.classList.toggle('on', x === b)); return; }
    if (b.dataset.act === 'close') closeSheet();
    if (b.dataset.act === 'ok') { await DB.put('pphotos', { id: uid(), date: $('#pp-d', el).value || dateStr(), pose, dataUrl, createdAt: Date.now() }); closeSheet(); toast('Photo saved'); render(); }
  };
}
async function openPhotoCompare() {
  const all = (await DB.all('pphotos')).sort((a, b) => a.date.localeCompare(b.date));
  const poses = [...new Set(all.map(p => p.pose))];
  let pose = poses.includes('Front') ? 'Front' : poses[0];
  const el = openSheet(`<div class="sheet-head"><button class="link" data-act="close">Close</button><div class="sheet-title">Compare photos</div><span style="width:50px"></span></div>
    <div class="seg" id="pc-pose">${poses.map(p => `<button data-p="${p}">${p}</button>`).join('')}</div>
    <div class="grid2" style="margin-top:12px"><div><label class="f">Before</label><select class="in" id="pc-a"></select></div><div><label class="f">After</label><select class="in" id="pc-b"></select></div></div>
    <div class="grid2" style="margin-top:10px" id="pc-imgs"></div><div id="pc-w" class="small muted" style="text-align:center; margin-top:8px"></div>
    <h3>All photos</h3><div class="photo-grid" id="pc-all"></div>`);
  const weights = lastPerDay(await DB.all('weights'), 'lb');
  const wNear = d => { const w = weights.slice().sort((a, b) => Math.abs(daysBetween(a.date, d)) - Math.abs(daysBetween(b.date, d)))[0]; return w && Math.abs(daysBetween(w.date, d)) <= 7 ? w.v : null; };
  const draw = () => {
    const list = all.filter(p => p.pose === pose);
    $$('#pc-pose button', el).forEach(b => b.classList.toggle('on', b.dataset.p === pose));
    const opt = sel => list.map(p => `<option value="${p.id}"${p.id === sel ? ' selected' : ''}>${esc(parseD(p.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }))}</option>`).join('');
    const a = $('#pc-a', el), b = $('#pc-b', el);
    const aId = list.some(p => p.id === a.value) ? a.value : list[0]?.id, bId = list.some(p => p.id === b.value) ? b.value : list[list.length - 1]?.id;
    a.innerHTML = opt(aId); b.innerHTML = opt(bId);
    const pa = list.find(p => p.id === aId), pb = list.find(p => p.id === bId);
    $('#pc-imgs', el).innerHTML = [pa, pb].map(p => p ? `<img src="${p.dataUrl}" alt="" style="width:100%; aspect-ratio:3/4; object-fit:cover; border-radius:14px">` : '<div></div>').join('');
    const wa = pa && wNear(pa.date), wb = pb && wNear(pb.date);
    $('#pc-w', el).textContent = wa != null && wb != null ? `${fmt(wa, 1)} lb → ${fmt(wb, 1)} lb (${wb - wa <= 0 ? '−' : '+'}${fmt(Math.abs(wb - wa), 1)} lb)` : '';
    $('#pc-all', el).innerHTML = all.slice().reverse().map(p => `<div class="ph-cell"><img src="${p.dataUrl}" alt=""><span>${esc(parseD(p.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))} · ${esc(p.pose)}</span><button class="link" style="color:var(--red)" data-del="${p.id}">Delete</button></div>`).join('');
  };
  draw();
  $('#pc-a', el).onchange = draw; $('#pc-b', el).onchange = draw;
  el.onclick = async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.p) { pose = b.dataset.p; $('#pc-a', el).value = ''; $('#pc-b', el).value = ''; draw(); return; }
    if (b.dataset.del) { if (confirm('Delete this photo?')) { await DB.del('pphotos', b.dataset.del); const i = all.findIndex(p => p.id === b.dataset.del); all.splice(i, 1); if (!all.length) { closeSheet(); render(); } else draw(); } return; }
    if (b.dataset.act === 'close') { closeSheet(); render(); }
  };
}

// ---- Habits ----
const DEFAULT_HABITS = [{ id: 'h-protein', name: 'Protein at every meal' }, { id: 'h-walk', name: 'Walked 20+ minutes' }, { id: 'h-strength', name: 'Strength workout' }, { id: 'h-cpap', name: 'Used CPAP all night' }, { id: 'h-veg', name: 'Vegetables at 2 meals' }];
function habitsList() { return state.settings.habits || DEFAULT_HABITS; }
async function habitCard(date) {
  const day = await getDay(date), done = day.habits || {}, hs = habitsList();
  if (!hs.length) return '';
  const counts = {};
  for (let i = 0; i < 7; i++) { const d = await getDay(addDays(date, -i)); for (const h of hs) if ((d.habits || {})[h.id]) counts[h.id] = (counts[h.id] || 0) + 1; }
  return `<section class="card"><div class="spread"><h2 style="margin:0">Habits</h2><button class="link" data-act="habits-edit">Edit</button></div>
    <div class="habits">${hs.map(h => `<button class="habit ${done[h.id] ? 'on' : ''}" data-habit="${h.id}"><span class="hc">${done[h.id] ? '✓' : ''}</span><span class="hn">${esc(h.name)}</span><span class="hw">${counts[h.id] || 0}/7</span></button>`).join('')}</div>
    <p class="tiny muted" style="margin:8px 0 0">Tap to check off. The number is how many of the last 7 days — no streaks to break.</p></section>`;
}
async function toggleHabit(date, id) {
  const day = await getDay(date); day.habits = day.habits || {};
  if (day.habits[id]) delete day.habits[id]; else day.habits[id] = true;
  await DB.put('days', day); render();
}
function openHabitsEdit() {
  const hs = habitsList().map(h => ({ ...h }));
  const el = openSheet(`<div class="sheet-head"><button class="link" data-act="close">Cancel</button><div class="sheet-title">Habits</div><button class="link" data-act="save">Save</button></div>
    <p class="small muted">Small daily actions that support your goals. Keep it to a handful.</p><div class="card"><ul class="list" id="hb-list"></ul></div>
    <div class="row"><input class="in" id="hb-new" placeholder="New habit, e.g. 8,000 steps" style="flex:1"><button class="btn secondary" data-act="add">Add</button></div>
    <div class="stack"><button class="btn primary big" data-act="save">Save</button></div>`);
  const draw = () => { $('#hb-list', el).innerHTML = hs.length ? hs.map((h, i) => `<li class="spread"><span class="item" style="flex:1">${esc(h.name)}</span><button class="link" style="color:var(--red)" data-rm="${i}">Remove</button></li>`).join('') : '<li class="small muted" style="padding:8px 0">No habits.</li>'; };
  draw();
  el.onclick = async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.rm != null) { hs.splice(Number(b.dataset.rm), 1); draw(); return; }
    if (b.dataset.act === 'add') { const v = $('#hb-new', el).value.trim(); if (v) { hs.push({ id: 'h-' + uid().slice(0, 8), name: v }); $('#hb-new', el).value = ''; draw(); } }
    if (b.dataset.act === 'close') closeSheet();
    if (b.dataset.act === 'save') { state.settings.habits = hs; await DB.put('kv', state.settings); closeSheet(); toast('Habits saved'); render(); }
  };
}


// ---------- Personal targets & weekly check-in ----------
const ACTIVITY = [[1.2, 'Mostly sitting (under ~4,000 steps)'], [1.25, 'Light (~4,000–7,000 steps)'], [1.35, 'Moderate (~7,000–10,000 steps or regular workouts)'], [1.5, 'Very active (10,000+ steps and workouts)']];
const r5 = x => Math.round(x / 5) * 5, r50 = x => Math.round(x / 50) * 50;
// Mifflin–St Jeor BMR × activity; protein 1.5 g/kg of adjusted body weight when BMI ≥ 30 (1.2–1.6 g/kg is the commonly cited range on GLP-1 medications).
function recommendTargets({ sex, age, heightIn, weightLb, activity, pace, conditions = [] }) {
  const kg = weightLb / 2.20462, cm = heightIn * 2.54;
  const bmr = 10 * kg + 6.25 * cm - 5 * age + (sex === 'female' ? -161 : 5);
  const tdee = bmr * activity;
  const floor = sex === 'female' ? 1200 : 1500;
  const kcal = Math.max(floor, r50(tdee - Math.min(1000, pace * 500)));
  const ibw = (sex === 'female' ? 45.5 : 50) + 2.3 * Math.max(0, heightIn - 60);
  const bmi = 703 * weightLb / heightIn ** 2;
  const refKg = bmi >= 30 ? ibw + 0.4 * (kg - ibw) : kg;
  const ckd = conditions.includes('ckd');
  const protein = ckd ? r5(0.8 * refKg) : r5(Math.min(1.5 * refKg, kcal * 0.35 / 4));
  const fat = r5(kcal * 0.30 / 9);
  const carbs = r5((kcal - protein * 4 - fat * 9) / 4);
  const fiber = Math.max(25, r5(14 * kcal / 1000));
  const sodiumLimit = conditions.includes('htn') || conditions.includes('ckd') ? 2000 : 2300;
  return { bmr, tdee, kcal, protein, carbs, fat, fiber, sodiumLimit, ckd, floorHit: kcal === floor && tdee - pace * 500 < floor };
}
// Weekly check-in: uses the measured burn (food log + trend weight) instead of formulas. Protein stays fixed; carbs and fat absorb the change.
function checkinSuggestion(ex, s) {
  if (!ex.ok) return null;
  const pace = num(s.pace) || 1, floor = s.sex === 'female' ? 1200 : 1500;
  const target = Math.max(floor, r50(ex.tdee - Math.min(1000, pace * 500)));
  const delta = target - s.kcal;
  if (Math.abs(delta) < 100) return { same: true, target, pace };
  const step = Math.max(-250, Math.min(250, delta)); // change gradually, at most 250 kcal per check-in
  const kcal = r50(s.kcal + step), fat = r5(kcal * 0.30 / 9), carbs = r5((kcal - s.protein * 4 - fat * 9) / 4);
  return { same: false, target, pace, kcal, fat, carbs, step };
}
async function openTargets() {
  const s = state.settings;
  const days = lastPerDay(await DB.all('weights'), 'lb'), tr = trendSeries(days);
  const w = tr.length ? Math.round(tr[tr.length - 1].v * 10) / 10 : '';
  const el = openSheet(`
    <div class="sheet-head"><button class="link" data-act="close">Cancel</button><div class="sheet-title">Recommended targets</div><span style="width:50px"></span></div>
    <p class="small muted">A science-based starting point from your stats. The weekly check-in on the Progress tab fine-tunes it from your real results.</p>
    <div class="grid2"><div><label class="f">Sex</label><select class="in" id="tg-sex"><option value="male"${s.sex !== 'female' ? ' selected' : ''}>Male</option><option value="female"${s.sex === 'female' ? ' selected' : ''}>Female</option></select></div>
      <div><label class="f">Age</label><input class="in" id="tg-age" type="number" inputmode="numeric" value="${s.age ?? ''}"></div>
      <div><label class="f">Height (in)</label><input class="in" id="tg-h" type="number" inputmode="decimal" value="${s.heightIn ?? ''}"></div>
      <div><label class="f">Weight (lb)</label><input class="in" id="tg-w" type="number" inputmode="decimal" value="${w}"></div></div>
    <label class="f">Daily activity</label><select class="in" id="tg-act">${ACTIVITY.map(([v, l]) => `<option value="${v}"${(num(s.activity) || 1.25) === v ? ' selected' : ''}>${l}</option>`).join('')}</select>
    <label class="f">Weight-loss pace</label><div class="seg" id="tg-pace">${[[0.5, '½ lb/wk'], [1, '1 lb/wk'], [1.5, '1½ lb/wk'], [2, '2 lb/wk']].map(([v, l]) => `<button data-p="${v}">${l}</button>`).join('')}</div>
    <div class="card" style="margin-top:14px" id="tg-out"></div>
    <div class="stack"><button class="btn primary big" data-act="apply">Use these targets</button></div>
    <p class="tiny muted">Calories never go below ${'1,500'} (men) or 1,200 (women) here. With your medications and conditions, it’s worth reviewing targets with your doctor or a dietitian.</p>`);
  let pace = num(s.pace) || 1, res = null;
  const calc = () => {
    $$('#tg-pace button', el).forEach(b => b.classList.toggle('on', Number(b.dataset.p) === pace));
    const inp = { sex: $('#tg-sex', el).value, age: num($('#tg-age', el).value), heightIn: num($('#tg-h', el).value), weightLb: num($('#tg-w', el).value), activity: Number($('#tg-act', el).value), pace, conditions: state.settings.conditions || [] };
    if (!(inp.age > 12 && inp.heightIn > 48 && inp.weightLb > 70)) { res = null; $('#tg-out', el).innerHTML = '<p class="small muted" style="margin:0">Enter age, height and weight.</p>'; return; }
    res = { ...recommendTargets(inp), inp };
    $('#tg-out', el).innerHTML = `<div class="kv" style="border-top:0"><span class="muted">Estimated burn</span><span>~${fmt(r50(res.tdee))} kcal/day</span></div>
      <div class="kv"><span><b>Calories</b></span><span><b>${fmt(res.kcal)}</b></span></div><div class="kv"><span>Protein</span><span>${res.protein} g</span></div>
      <div class="kv"><span>Carbs</span><span>${res.carbs} g</span></div><div class="kv"><span>Fat</span><span>${res.fat} g</span></div><div class="kv"><span>Fiber</span><span>${res.fiber} g</span></div><div class="kv"><span>Sodium limit</span><span>${fmt(res.sodiumLimit)} mg</span></div>
      ${(() => { const notes = []; const c = state.settings.conditions || [];
        if (c.includes('htn')) notes.push('Sodium limit lowered for high blood pressure.');
        if (res.ckd) notes.push('Protein kept moderate for kidney disease — confirm with your doctor.');
        if (c.includes('prediabetes') || c.includes('t2d')) notes.push('Carbs kept moderate for blood-sugar control; choose high-fiber carbs.');
        if (onMed(MEDRX.glp1)) notes.push('Protein set high to protect muscle on Wegovy.');
        return notes.length ? `<p class="small muted" style="margin:8px 0 0">Personalized: ${notes.join(' ')}</p>` : (c.length ? '' : '<p class="small muted" style="margin:8px 0 0">Tip: add your conditions in Health → Health profile to personalize these.</p>'); })()}
      ${res.floorHit ? '<p class="small" style="color:var(--orange)">That pace would go below the safe minimum, so calories are held at the floor.</p>' : ''}`;
  };
  $$('input,select', el).forEach(i => { i.oninput = calc; i.onchange = calc; });
  calc();
  el.onclick = async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.p) { pace = Number(b.dataset.p); calc(); return; }
    if (b.dataset.act === 'close') closeSheet();
    if (b.dataset.act === 'apply') {
      if (!res) { toast('Enter age, height and weight'); return; }
      Object.assign(state.settings, { kcal: res.kcal, protein: res.protein, carbs: res.carbs, fat: res.fat, fiber: res.fiber, sodiumLimit: res.sodiumLimit, sex: res.inp.sex, age: res.inp.age, heightIn: res.inp.heightIn, activity: res.inp.activity, pace, targetsSetAt: Date.now() });
      await DB.put('kv', state.settings); closeAllSheets(); toast('Targets updated'); render();
    }
  };
}
async function applyCheckin(sug) {
  Object.assign(state.settings, { kcal: sug.kcal, carbs: sug.carbs, fat: sug.fat, lastCheckin: Date.now() });
  await DB.put('kv', state.settings); toast(`Calorie target now ${fmt(sug.kcal)}`); render();
}
// ---------- v6: health profile, blood pressure, labs, personalized guidance ----------
const CONDITIONS = [['htn', 'High blood pressure'], ['osa', 'Sleep apnea (CPAP)'], ['lipids', 'High cholesterol'], ['prediabetes', 'Prediabetes'], ['t2d', 'Type 2 diabetes'], ['ckd', 'Chronic kidney disease'], ['gerd', 'Acid reflux / GERD'], ['anxiety', 'Anxiety or depression']];
const COND_LABEL = Object.fromEntries(CONDITIONS);
const hasCond = k => (state.settings.conditions || []).includes(k);
const activeMeds = () => (state.settings.medList || []).filter(m => m.status !== 'stopped');
const onMed = re => activeMeds().some(m => re.test(m.name));
const MEDRX = { arbace: /losartan|valsartan|olmesartan|irbesartan|telmisartan|candesartan|lisinopril|enalapril|ramipril|benazepril|quinapril/i, diuretic: /hydrochlorothiazide|hctz|chlorthalidone|furosemide|bumetanide|torsemide|indapamide/i,
  beta: /carvedilol|metoprolol|atenolol|propranolol|bisoprolol|nebivolol|labetalol/i, statin: /rosuvastatin|atorvastatin|simvastatin|pravastatin|lovastatin|pitavastatin/i, metformin: /metformin/i,
  ppi: /pantoprazole|omeprazole|esomeprazole|lansoprazole|rabeprazole|famotidine/i, glp1: /semaglutide|wegovy|ozempic|rybelsus|tirzepatide|zepbound|mounjaro|liraglutide|saxenda/i,
  bp: /losartan|valsartan|olmesartan|irbesartan|telmisartan|candesartan|lisinopril|enalapril|ramipril|benazepril|hydrochlorothiazide|hctz|chlorthalidone|carvedilol|metoprolol|atenolol|amlodipine|nifedipine|diltiazem|hydralazine|clonidine|spironolactone|doxazosin|labetalol/i };
function bpMedCount() { return activeMeds().filter(m => MEDRX.bp.test(m.name)).length; }
// ACC/AHA blood pressure categories
function bpCategory(sys, dia) {
  if (sys > 180 || dia > 120) return { k: 'crisis', label: 'Very high', color: '#ff3b30' };
  if (sys < 90 || dia < 60) return { k: 'low', label: 'Low', color: '#0a84ff' };
  if (sys >= 140 || dia >= 90) return { k: 's2', label: 'Stage 2 high', color: '#ff3b30' };
  if (sys >= 130 || dia >= 80) return { k: 's1', label: 'Stage 1 high', color: '#ff9f0a' };
  if (sys >= 120) return { k: 'elev', label: 'Elevated', color: '#ffcc00' };
  return { k: 'normal', label: 'Normal', color: '#1f9d55' };
}
const LAB_TESTS = [['a1c', 'A1c', '%'], ['glucose', 'Fasting glucose', 'mg/dL'], ['ldl', 'LDL cholesterol', 'mg/dL'], ['hdl', 'HDL cholesterol', 'mg/dL'], ['tg', 'Triglycerides', 'mg/dL'], ['tc', 'Total cholesterol', 'mg/dL'],
  ['egfr', 'eGFR (kidney)', 'mL/min'], ['creat', 'Creatinine', 'mg/dL'], ['k', 'Potassium', 'mmol/L'], ['na', 'Sodium', 'mmol/L'], ['alt', 'ALT (liver)', 'U/L'], ['ast', 'AST (liver)', 'U/L'], ['b12', 'Vitamin B12', 'pg/mL']];
const LAB = Object.fromEntries(LAB_TESTS.map(([k, l, u]) => [k, { l, u }]));
// Common reference ranges (labs vary; your report's ranges win)
function labFlag(t, v) {
  const R = { a1c: v >= 6.5 ? ['Diabetes range', 'bad'] : v >= 5.7 ? ['Prediabetes range', 'warn'] : ['Normal', 'ok'], glucose: v >= 126 ? ['Diabetes range', 'bad'] : v >= 100 ? ['Prediabetes range', 'warn'] : ['Normal', 'ok'],
    ldl: v >= 160 ? ['High', 'bad'] : v >= 130 ? ['Borderline high', 'warn'] : v >= 100 ? ['Near optimal', 'ok'] : ['Optimal', 'ok'], hdl: v < 40 ? ['Low', 'warn'] : ['OK', 'ok'], tg: v >= 200 ? ['High', 'bad'] : v >= 150 ? ['Borderline high', 'warn'] : ['Normal', 'ok'],
    tc: v >= 240 ? ['High', 'bad'] : v >= 200 ? ['Borderline', 'warn'] : ['Desirable', 'ok'], egfr: v < 60 ? ['Reduced', 'bad'] : v < 90 ? ['Mildly reduced', 'warn'] : ['Normal', 'ok'],
    k: v > 5.0 ? ['High', 'bad'] : v < 3.5 ? ['Low', 'bad'] : ['Normal', 'ok'], na: v < 135 ? ['Low', 'bad'] : v > 145 ? ['High', 'bad'] : ['Normal', 'ok'],
    alt: v > 55 ? ['Above typical range', 'warn'] : ['Typical', 'ok'], ast: v > 48 ? ['Above typical range', 'warn'] : ['Typical', 'ok'], b12: v < 200 ? ['Low', 'bad'] : v < 300 ? ['Borderline', 'warn'] : ['Normal', 'ok'] };
  return R[t] || null;
}
const dLabel = r => r.approx ? parseD(r.date).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }) : parseD(r.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

function openProfileSheet() {
  const s = state.settings, conds = new Set(s.conditions || []), meds = (s.medList || []).map(m => ({ ...m }));
  const el = openSheet(`<div class="sheet-head"><button class="link" data-act="close">Cancel</button><div class="sheet-title">Health profile</div><button class="link" data-act="save">Save</button></div>
    <p class="small muted">Used to personalize your targets, tips and recaps. Stays on this phone.</p>
    <label class="f">Conditions</label><div class="chips wrap" id="pf-c">${CONDITIONS.map(([k, l]) => `<button class="chip ${conds.has(k) ? 'on' : ''}" data-c="${k}">${l}</button>`).join('')}</div>
    <label class="f">Medications</label><div class="card"><ul class="list" id="pf-m"></ul><button class="btn secondary block" style="margin-top:10px" data-act="add-med">+ Add medication</button></div>
    <p class="tiny muted">“Confirm” marks medicines you need to double-check with your doctor or pharmacy. Never start, stop or change a prescription based on this app.</p>
    <div class="stack"><button class="btn primary big" data-act="save">Save profile</button></div>`);
  const draw = () => {
    $$('#pf-c .chip', el).forEach(b => b.classList.toggle('on', conds.has(b.dataset.c)));
    $('#pf-m', el).innerHTML = meds.length ? meds.map((m, i) => `<li><button class="item" data-m="${i}"><div class="grow"><div class="t">${esc(m.name)} ${m.status === 'confirm' ? '<span class="pill warn">confirm</span>' : m.status === 'stopped' ? '<span class="pill">stopped</span>' : ''}</div>
      <div class="s">${esc([m.dose, m.purpose].filter(Boolean).join(' · '))}</div></div></button></li>`).join('') : '<li class="small muted" style="padding:8px 0">No medications added.</li>';
  };
  const editMed = (i) => {
    const m = i == null ? { name: '', dose: '', purpose: '', status: 'active' } : meds[i];
    const sh = openSheet(`<div class="sheet-head"><button class="link" data-act="close">Cancel</button><div class="sheet-title">${i == null ? 'Add' : 'Edit'} medication</div><span style="width:50px"></span></div>
      <label class="f">Name</label><input class="in" id="md-n" value="${esc(m.name)}" placeholder="e.g. Losartan / HCTZ">
      <label class="f">Dose & schedule</label><input class="in" id="md-d" value="${esc(m.dose)}" placeholder="e.g. 100/25 mg daily">
      <label class="f">For</label><input class="in" id="md-p" value="${esc(m.purpose)}" placeholder="e.g. Blood pressure">
      <label class="f">Status</label><div class="seg" id="md-s">${[['active', 'Taking'], ['confirm', 'Confirm'], ['stopped', 'Stopped']].map(([v, l]) => `<button data-s="${v}" class="${m.status === v ? 'on' : ''}">${l}</button>`).join('')}</div>
      <div class="stack"><button class="btn primary big" data-act="ok">Save</button>${i != null ? '<button class="btn danger" data-act="rm">Remove</button>' : ''}</div>`);
    let st = m.status;
    sh.onclick = e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.s) { st = b.dataset.s; $$('#md-s button', sh).forEach(x => x.classList.toggle('on', x === b)); return; }
      if (b.dataset.act === 'close') closeSheet();
      if (b.dataset.act === 'rm') { meds.splice(i, 1); closeSheet(); draw(); }
      if (b.dataset.act === 'ok') { const n = $('#md-n', sh).value.trim(); if (!n) { toast('Enter a name'); return; }
        const rec = { name: n, dose: $('#md-d', sh).value.trim(), purpose: $('#md-p', sh).value.trim(), status: st };
        if (i == null) meds.push(rec); else meds[i] = rec; closeSheet(); draw(); }
    };
  };
  draw();
  el.onclick = async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.c) { conds.has(b.dataset.c) ? conds.delete(b.dataset.c) : conds.add(b.dataset.c); draw(); return; }
    if (b.dataset.m != null) { editMed(Number(b.dataset.m)); return; }
    if (b.dataset.act === 'add-med') editMed(null);
    if (b.dataset.act === 'close') closeSheet();
    if (b.dataset.act === 'save') { state.settings.conditions = [...conds]; state.settings.medList = meds; await DB.put('kv', state.settings); closeSheet(); toast('Profile saved'); render(); }
  };
}
function openBpSheet(rec) {
  const r = rec || { id: uid(), date: dateStr(), sys: '', dia: '', pulse: '', dizzy: false, note: '', createdAt: Date.now() };
  const el = openSheet(`<div class="sheet-head"><button class="link" data-act="close">Cancel</button><div class="sheet-title">Blood pressure</div><span style="width:50px"></span></div>
    <div class="grid2"><div><label class="f">Top (systolic)</label><input class="in big-in" id="bp-s" type="number" inputmode="numeric" value="${r.sys}"></div>
      <div><label class="f">Bottom (diastolic)</label><input class="in big-in" id="bp-d" type="number" inputmode="numeric" value="${r.dia}"></div>
      <div><label class="f">Pulse (optional)</label><input class="in" id="bp-p" type="number" inputmode="numeric" value="${r.pulse ?? ''}"></div>
      <div><label class="f">Date</label><input class="in" id="bp-dt" type="date" value="${r.date}"></div></div>
    <label class="row small" style="gap:10px; margin-top:14px"><input type="checkbox" id="bp-z" ${r.dizzy ? 'checked' : ''} style="width:22px;height:22px"> Felt dizzy or lightheaded</label>
    <label class="f">Note</label><input class="in" id="bp-n" value="${esc(r.note || '')}" placeholder="e.g. morning, before meds">
    <p class="tiny muted">Sit quietly for 5 minutes, feet flat, arm supported at heart level. Morning and evening readings give the best picture.</p>
    <div id="bp-cat"></div>
    <div class="stack"><button class="btn primary big" data-act="ok">Save</button>${rec ? '<button class="btn danger" data-act="del">Delete</button>' : ''}</div>`);
  const cat = () => { const s = num($('#bp-s', el).value), d = num($('#bp-d', el).value);
    $('#bp-cat', el).innerHTML = s && d ? (() => { const c = bpCategory(s, d); return `<div class="tip" style="margin-top:12px; background:color-mix(in srgb, ${c.color} 15%, transparent)"><span class="ti">●</span><span><b>${c.label}</b>${c.k === 'crisis' ? ' — if you have chest pain, shortness of breath, vision changes, weakness or severe headache, call 911. Otherwise recheck in a few minutes and contact your doctor today.' : c.k === 'low' ? ' — especially with dizziness, let your doctor know; your BP medicines may need review as you lose weight.' : ''}</span></div>`; })() : ''; };
  $('#bp-s', el).oninput = cat; $('#bp-d', el).oninput = cat; cat();
  el.onclick = async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.act === 'close') closeSheet();
    if (b.dataset.act === 'del') { if (confirm('Delete this reading?')) { await DB.del('bp', r.id); closeSheet(); render(); } }
    if (b.dataset.act === 'ok') {
      const s = num($('#bp-s', el).value), d = num($('#bp-d', el).value);
      if (!(s > 60 && s < 260 && d > 30 && d < 160)) { toast('Enter both numbers'); return; }
      Object.assign(r, { sys: s, dia: d, pulse: num($('#bp-p', el).value), date: $('#bp-dt', el).value || dateStr(), dizzy: $('#bp-z', el).checked, note: $('#bp-n', el).value.trim() });
      await DB.put('bp', r); closeSheet(); toast('Reading saved'); render();
    }
  };
}
function openLabSheet() {
  const el = openSheet(`<div class="sheet-head"><button class="link" data-act="close">Cancel</button><div class="sheet-title">Add lab results</div><span style="width:50px"></span></div>
    <p class="small muted">Copy from your lab report. Fill in only the tests you had.</p>
    <label class="f">Date of the test</label><input class="in" id="lb-d" type="date" value="${dateStr()}">
    <div class="card">${LAB_TESTS.map(([k, l, u]) => `<div class="spread" style="padding:6px 0"><span>${l} <span class="tiny muted">${u}</span></span><input class="in" data-lab="${k}" type="number" inputmode="decimal" step="any" style="width:110px; min-height:42px"></div>`).join('')}</div>
    <div class="stack"><button class="btn primary big" data-act="ok">Save results</button></div>`);
  el.onclick = async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.act === 'close') closeSheet();
    if (b.dataset.act === 'ok') {
      const date = $('#lb-d', el).value || dateStr(); let n = 0;
      for (const i of $$('[data-lab]', el)) { const v = num(i.value); if (v != null) { await DB.put('labs', { id: uid(), date, test: i.dataset.lab, value: v, createdAt: Date.now() }); n++; } }
      if (!n) { toast('Enter at least one result'); return; }
      closeSheet(); toast(`Saved ${n} result${n > 1 ? 's' : ''}`); render();
    }
  };
}
async function openLabHistory(test) {
  const rows = (await DB.all('labs')).filter(r => r.test === test).sort((a, b) => a.date.localeCompare(b.date));
  const el = openSheet(`<div class="sheet-head"><button class="link" data-act="close">Close</button><div class="sheet-title">${esc(LAB[test].l)}</div><span style="width:50px"></span></div>
    ${rows.length > 1 ? lineChart([{ pts: rows.map(r => ({ date: r.date, v: r.value })), type: 'line', color: '#0a84ff' }, { pts: rows.map(r => ({ date: r.date, v: r.value })), type: 'dots', color: '#0a84ff' }], { h: 160, label: LAB[test].l }) : ''}
    <div class="card"><ul class="list">${rows.slice().reverse().map(r => { const f = labFlag(test, r.value); return `<li class="spread"><div class="item" style="flex:1"><div class="grow"><div class="t">${fmt(r.value, 1)} ${esc(LAB[test].u)} ${f ? `<span class="pill ${f[1] === 'ok' ? 'ok' : 'warn'}">${f[0]}</span>` : ''}</div><div class="s">${esc(dLabel(r))}${r.note ? ' · ' + esc(r.note) : ''}</div></div></div><button class="link" style="color:var(--red)" data-del="${r.id}">Delete</button></li>`; }).join('')}</ul></div>
    <p class="tiny muted">Ranges shown are common reference values; your lab’s report and your doctor’s targets take priority.</p>`);
  el.onclick = async e => { const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.del) { if (confirm('Delete this result?')) { await DB.del('labs', b.dataset.del); closeSheet(); render(); } return; }
    if (b.dataset.act === 'close') closeSheet(); };
}
// Personalized guidance from conditions, medications and your own data. Informational — never changes medicines.
async function personalGuidance() {
  const s = state.settings, out = [], today = dateStr();
  const bp = (await DB.all('bp')).sort((a, b) => a.date.localeCompare(b.date));
  const labs = await DB.all('labs'), latest = t => labs.filter(r => r.test === t).sort((a, b) => a.date.localeCompare(b.date)).pop();
  const recentBp = bp.filter(r => r.date > addDays(today, -14));
  const ws = weightStats(lastPerDay(await DB.all('weights'), 'lb'), s);
  if (hasCond('htn') || onMed(MEDRX.bp)) {
    const n = bpMedCount();
    out.push({ icon: '🩺', title: 'Blood pressure & weight loss', text: `${n >= 3 ? `You take ${n} blood-pressure prescriptions. ` : ''}As you lose weight, blood pressure often falls, and medicines may need lowering. Log readings a few times a week and tell your doctor about readings under 90/60 or any dizziness or lightheadedness.${ws && ws.lost > 20 ? ` You’re down ${fmt(ws.lost, 0)} lb since you started — a good time to have your doctor review your BP medicines.` : ''}` });
    if (recentBp.some(r => r.dizzy || r.sys < 90 || r.dia < 60)) out.push({ icon: '⚠️', title: 'Low readings or dizziness logged', kind: 'warn', text: 'You logged a low reading or dizziness in the last 2 weeks. Contact your doctor — don’t change or skip medicines on your own.' });
    if (recentBp.length >= 3) { const as = recentBp.reduce((a, r) => a + r.sys, 0) / recentBp.length, ad = recentBp.reduce((a, r) => a + r.dia, 0) / recentBp.length;
      if (as >= 130 || ad >= 80) out.push({ icon: '📈', title: 'Recent average above target', kind: 'warn', text: `Your 2-week average is ${fmt(as)}/${fmt(ad)}. Share your log with your doctor.` }); }
    if (!bp.length || bp[bp.length - 1].date < addDays(today, -7)) out.push({ icon: '📝', title: 'Log your blood pressure', text: 'No reading in the last week. Home readings help your doctor adjust medicines safely as your weight changes.' });
    out.push({ icon: '🧂', title: 'Sodium', text: `Your sodium limit is ${fmt(s.sodiumLimit)} mg/day. The American Heart Association’s ideal for high blood pressure is 1,500 mg. Restaurant and packaged foods are the main sources.` });
  }
  if (onMed(MEDRX.arbace)) out.push({ icon: '🚫', title: 'Avoid potassium salt substitutes', kind: 'warn', text: 'With losartan (or similar), salt substitutes like NoSalt or Morton Lite Salt contain potassium chloride and can push potassium too high. Use herbs, garlic, lemon and spices instead. Potassium-rich foods are usually fine with normal kidney function — ask your doctor.' });
  if (onMed(MEDRX.diuretic) && onMed(MEDRX.glp1)) out.push({ icon: '💧', title: 'Hydration matters more for you', text: 'A water pill plus Wegovy’s nausea or diarrhea can dehydrate you faster. Keep up fluids, and call your doctor if you can’t keep fluids down for a day, feel faint, or urinate much less.' });
  if (onMed(MEDRX.glp1)) out.push({ icon: '💉', title: 'Getting the most from Wegovy', text: 'Eat protein first at each meal, keep meals smaller, and go easy on greasy or very rich foods — they worsen nausea. Pair resistance training with your protein target to protect muscle.' });
  if (onMed(MEDRX.beta)) out.push({ icon: '❤️', title: 'Exercise intensity with carvedilol', text: 'Beta blockers keep your heart rate lower, so heart-rate zones underestimate effort. Use how hard it feels instead: you should be able to talk, but not sing, during moderate exercise.' });
  if (onMed(MEDRX.statin)) out.push({ icon: '🏋️', title: 'Starting strength training on a statin', text: 'Some soreness is normal when you start lifting. Unexplained muscle pain or weakness, especially with dark urine, should be reported to your doctor.' });
  if (onMed(MEDRX.metformin)) out.push({ icon: '💊', title: 'Metformin', text: `Metformin and Wegovy can both upset the stomach — take metformin with food. Long-term metformin can lower vitamin B12; it’s reasonable to ask if a B12 check is due.${latest('b12') ? '' : ' (No B12 result logged.)'}` });
  if (onMed(MEDRX.ppi) || hasCond('gerd')) out.push({ icon: '🔥', title: 'Reflux', text: 'Wegovy slows stomach emptying, which can worsen reflux. Smaller meals, finishing eating 3 hours before bed, and less fried food usually help.' });
  if (hasCond('osa')) out.push({ icon: '😴', title: 'Sleep apnea', text: 'Use CPAP every night (it’s in your habits). Poor sleep raises hunger. As you lose weight, your CPAP pressure needs can change — mention big weight changes to your sleep doctor.' });
  if (hasCond('prediabetes') || hasCond('t2d')) { const a = latest('a1c');
    out.push({ icon: '🩸', title: hasCond('t2d') ? 'Blood sugar' : 'Prediabetes', text: `${a ? `Last A1c ${fmt(a.value, 1)}% (${dLabel(a)})${daysBetween(a.date, today) > 365 ? ' — over a year ago; ask about rechecking' : ''}. ` : 'No A1c logged yet. '}Pair carbs with protein and fiber, and favor whole-grain, high-fiber carbs.` }); }
  if (hasCond('ckd')) out.push({ icon: '⚠️', title: 'Kidney disease', kind: 'warn', text: 'High-protein targets may not suit kidney disease. Your protein target is set conservatively — confirm it with your doctor or a renal dietitian.' });
  if (hasCond('lipids')) { const l = latest('ldl'); out.push({ icon: '🫀', title: 'Cholesterol', text: `${l ? `Last LDL ${fmt(l.value)} mg/dL (${dLabel(l)}). ` : ''}Keep saturated fat under ${fmt(s.satfatLimit)} g/day and aim for your fiber goal — soluble fiber (oats, beans) helps LDL.` }); }
  const egfr = latest('egfr'), k = latest('k');
  if (egfr && egfr.value < 60) out.push({ icon: '⚠️', title: 'Reduced kidney function on file', kind: 'warn', text: `Your last eGFR was ${fmt(egfr.value)}. Ask your doctor whether your protein and potassium intake should be limited.` });
  if (k && k.value > 5.0 && onMed(MEDRX.arbace)) out.push({ icon: '⚠️', title: 'High potassium on file', kind: 'warn', text: `Last potassium ${fmt(k.value, 1)} while on an ARB/ACE inhibitor — follow your doctor’s advice on potassium.` });
  const confirm = (s.medList || []).filter(m => m.status === 'confirm');
  if (confirm.length) out.push({ icon: '📋', title: 'Medicines to confirm', text: `Double-check with your doctor or pharmacy: ${confirm.map(m => m.name).join(', ')}.` });
  return out;
}
function healthContextLines() {
  const s = state.settings, L = [];
  if ((s.conditions || []).length) L.push(`Conditions: ${s.conditions.map(k => COND_LABEL[k]).join(', ')}`);
  const m = activeMeds(); if (m.length) L.push(`Medications: ${m.map(x => `${x.name}${x.dose ? ' ' + x.dose : ''}${x.status === 'confirm' ? ' (needs confirming)' : ''}`).join('; ')}`);
  return L;
}

// ---------- Health tab ----------
async function renderHealth() {
  const s = state.settings, today = dateStr();
  const meds = (await DB.all('meds')).sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0));
  const doses = meds.filter(m => m.type === 'dose'), symptoms = meds.filter(m => m.type === 'symptom');
  const lastDose = doses[0];
  const since = lastDose ? daysBetween(lastDose.date, today) : null;
  const next = lastDose && (s.medSchedule || 'weekly') === 'weekly' ? addDays(lastDose.date, 7) : null;
  const days = lastPerDay(await DB.all('weights'), 'lb');
  const firstDose = doses[doses.length - 1];
  let wSinceMed = null;
  if (firstDose && days.length) {
    // Use the weigh-in closest to the first dose, and only if it is within 2 weeks of it.
    const near = days.slice().sort((a, b) => Math.abs(daysBetween(a.date, firstDose.date)) - Math.abs(daysBetween(b.date, firstDose.date)))[0];
    const last = days[days.length - 1];
    if (near && Math.abs(daysBetween(near.date, firstDose.date)) <= 14 && last.date > near.date) wSinceMed = { from: near, to: last, ch: last.v - near.v };
  }
  const health = (await DB.all('health')).sort((a, b) => a.date.localeCompare(b.date));
  const recentH = health.filter(h => h.date > addDays(today, -7));
  const havg = k => { const v = recentH.map(h => h[k]).filter(x => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const lastImp = await DB.get('kv', 'lastHealthImport');
  const hist = meds.slice(0, 12);
  const conds = s.conditions || [], ml = s.medList || [];
  const bpAll = (await DB.all('bp')).sort((a, b) => a.date.localeCompare(b.date) || (a.createdAt || 0) - (b.createdAt || 0));
  const bpLast = bpAll[bpAll.length - 1], bp30 = bpAll.filter(r => r.date > addDays(today, -30));
  const labsAll = await DB.all('labs'), labLatest = {};
  for (const r of labsAll.sort((a, b) => a.date.localeCompare(b.date))) labLatest[r.test] = r;
  const guide = await personalGuidance();
  view().innerHTML = `
  <header class="topbar"><h1>Health</h1></header>
  <section class="card"><div class="spread"><h2 style="margin:0">Health profile</h2><button class="link" data-act="hprofile">${conds.length || ml.length ? 'Edit' : 'Set up'}</button></div>
    ${conds.length || ml.length ? `<div class="chips wrap" style="margin-top:10px">${conds.map(k => `<span class="chip on">${esc(COND_LABEL[k])}</span>`).join('')}</div>
      <p class="small muted" style="margin:10px 0 0">${ml.filter(m => m.status !== 'stopped').length} medications${ml.some(m => m.status === 'confirm') ? ` · ${ml.filter(m => m.status === 'confirm').length} to confirm` : ''}</p>`
      : '<p class="small muted">Add your conditions and medications so targets, tips and recaps fit your situation.</p>'}</section>
  ${guide.length ? `<section class="card"><h2>Your personalized guidance</h2><ul class="tips">${guide.slice().sort((a, b) => (b.kind === 'warn') - (a.kind === 'warn')).map((g, i) => `<li class="tip ${g.kind || ''} ${i >= 4 && !state.showAllGuide ? 'hidden-tip' : ''}"><span class="ti">${g.icon}</span><span><b>${esc(g.title)}.</b> ${esc(g.text)}</span></li>`).join('')}</ul>
    ${guide.length > 4 ? `<button class="btn block" style="margin-bottom:8px" data-act="guide-all">${state.showAllGuide ? 'Show less' : `Show all ${guide.length}`}</button>` : ''}
    <p class="tiny muted" style="margin:0">General information based on your profile — not medical advice. Your doctor’s instructions come first.</p></section>` : ''}
  <section class="card"><div class="spread"><h2 style="margin:0">Blood pressure</h2><button class="btn secondary" data-act="bp">+ Log</button></div>
    ${bpLast ? (() => { const c = bpCategory(bpLast.sys, bpLast.dia); const as = bp30.length ? bp30.reduce((a, r) => a + r.sys, 0) / bp30.length : null, ad = bp30.length ? bp30.reduce((a, r) => a + r.dia, 0) / bp30.length : null;
      return `<div class="totals" style="grid-template-columns:repeat(2,1fr); margin-top:12px"><div><div class="big" style="color:${c.color}">${bpLast.sys}/${bpLast.dia}</div><div class="lbl">latest · ${esc(c.label)} · ${esc(dLabel(bpLast))}</div></div>
        <div><div class="big">${as ? fmt(as) + '/' + fmt(ad) : '—'}</div><div class="lbl">30-day average (${bp30.length})</div></div></div>
        ${bpAll.length > 1 ? lineChart([{ pts: bpAll.slice(-60).map(r => ({ date: r.date, v: r.sys })), type: 'line', color: '#ff3b30' }, { pts: bpAll.slice(-60).map(r => ({ date: r.date, v: r.dia })), type: 'line', color: '#0a84ff' }], { h: 140, label: 'Blood pressure' }) + '<p class="tiny muted" style="margin:2px 0 0"><span style="color:#ff3b30">■</span> Top · <span style="color:#0a84ff">■</span> Bottom</p>' : ''}
        <ul class="list" style="margin-top:6px">${bpAll.slice(-3).reverse().map(r => `<li><button class="item" data-bp="${r.id}"><div class="grow"><div class="t">${r.sys}/${r.dia}${r.pulse ? ` · pulse ${r.pulse}` : ''}${r.dizzy ? ' · dizzy' : ''}</div><div class="s">${esc(dLabel(r))}${r.note ? ' · ' + esc(r.note) : ''}</div></div></button></li>`).join('')}</ul>`; })()
      : '<p class="small muted">Track home readings — useful for your doctor as your weight and medicines change.</p>'}</section>
  <section class="card"><div class="spread"><h2 style="margin:0">Lab results</h2><button class="btn secondary" data-act="lab">+ Add</button></div>
    ${Object.keys(labLatest).length ? `<ul class="list" style="margin-top:6px">${LAB_TESTS.filter(([k]) => labLatest[k]).map(([k, l, u]) => { const r = labLatest[k], f = labFlag(k, r.value), prev = labsAll.filter(x => x.test === k && x.date < r.date).pop();
      return `<li><button class="item" data-labt="${k}"><div class="grow"><div class="t">${esc(l)}</div><div class="s">${esc(dLabel(r))}${prev ? ` · was ${fmt(prev.value, 1)}` : ''}</div></div>
        <div style="text-align:right"><div class="v">${fmt(r.value, 1)} <span class="tiny muted">${esc(u)}</span></div>${f ? `<span class="pill ${f[1] === 'ok' ? 'ok' : 'warn'}">${f[0]}</span>` : ''}</div></button></li>`; }).join('')}</ul>`
      : '<p class="small muted">A1c, cholesterol, kidney and liver tests — see trends over time.</p>'}</section>
  <section class="card"><div class="spread"><h2 style="margin:0">${esc(s.medName || 'Medication journal')}</h2><button class="link" data-act="profile">${s.medName ? 'Edit' : 'Set up'}</button></div>
    ${s.medName ? `<p class="small muted" style="margin:4px 0 8px">Prescribed: ${esc(s.medDose || '—')} · ${esc({ weekly: 'once a week', daily: 'daily', other: 'as prescribed' }[s.medSchedule || 'weekly'])}</p>` : '<p class="small muted">Add your medication and prescribed dose to start the journal.</p>'}
    ${lastDose ? `<div class="kv" style="border-top:0"><span class="muted">Last dose</span><span>${esc(lastDose.dose || '')} · ${esc(niceDate(lastDose.date))} (${since === 0 ? 'today' : since + ' day' + (since === 1 ? '' : 's') + ' ago'})</span></div>
      ${next && next >= today ? `<div class="kv"><span class="muted">Next on weekly schedule</span><span>${esc(longDate(next))}</span></div>` : ''}
      ${next && next < today ? `<p class="small muted" style="margin:6px 0 0">No dose logged since ${esc(niceDate(lastDose.date))}. Log any recent doses to keep the journal current.</p>` : ''}` : ''}
    ${wSinceMed ? `<div class="kv"><span class="muted">Weight since starting (${esc(parseD(wSinceMed.from.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))} weigh-in)</span><span>${wSinceMed.ch <= 0 ? '−' : '+'}${fmt(Math.abs(wSinceMed.ch), 1)} lb</span></div>` : ''}
    <div class="row" style="margin-top:12px"><button class="btn primary" style="flex:1" data-act="dose">Log dose</button><button class="btn secondary" style="flex:1" data-act="symptom">How I feel</button></div>
    <p class="tiny muted" style="margin-bottom:0">For tracking and sharing with your provider. It never changes or recommends doses.</p></section>
  ${doses.length ? (() => { const from = addDays(today, -89), lv = medLevelSeries(doses, addDays(from, -60), today).filter(p => p.date >= from);
    return `<section class="card"><h2>Estimated medication level</h2>${lineChart([{ pts: lv, type: 'line', color: '#8e5cf7' }], { h: 150, label: 'Estimated medication level' })}
    <p class="tiny muted" style="margin:4px 0 0">Last 90 days, in estimated mg in your body, from your logged doses. A rough illustration using semaglutide’s ~1-week half-life — not a measured blood level. Gaps in dosing show as dips; missing logged doses will too.</p></section>`; })() : ''}
  ${symptoms.length >= 2 ? (() => { const from = addDays(today, -89), sy = symptoms.filter(x => x.date >= from);
    return sy.length >= 2 ? `<section class="card"><h2>Side effects over time</h2>${lineChart([{ pts: sy.map(x => ({ date: x.date, v: x.nausea })), type: 'line', color: '#ff3b30' }, { pts: sy.map(x => ({ date: x.date, v: x.constipation })), type: 'line', color: '#ff9f0a' }, { pts: sy.map(x => ({ date: x.date, v: 3 - x.appetite })), type: 'dots', color: '#0a84ff' }], { h: 150, label: 'Side effects' })}
    <p class="tiny muted" style="margin:4px 0 0"><span style="color:#ff3b30">■</span> Nausea · <span style="color:#ff9f0a">■</span> Constipation (0 none – 3 severe) · <span style="color:#0a84ff">●</span> Appetite suppression (0 more – 3 much less)</p></section>` : ''; })() : ''}
  ${hist.length ? `<section class="card"><h2>Journal</h2><ul class="list">${hist.map(m => `<li><button class="item" data-med="${m.id}"><div class="grow">
    <div class="t">${m.type === 'dose' ? '💉 ' + esc([m.med, m.dose].filter(Boolean).join(' ')) : '📝 Appetite: ' + APPETITE[m.appetite] + (m.nausea ? ' · Nausea: ' + SEVERITY[m.nausea] : '') + (m.constipation ? ' · Constipation: ' + SEVERITY[m.constipation] : '')}</div>
    <div class="s">${esc(niceDate(m.date))}${m.other ? ' · ' + esc(m.other) : ''}${m.notes ? ' · ' + esc(m.notes) : ''}</div></div></button></li>`).join('')}</ul></section>` : ''}
  <section class="card"><div class="spread"><h2 style="margin:0">Apple Health</h2><button class="btn secondary" data-act="import">Import</button></div>
    ${recentH.length ? `<p class="small muted" style="margin:6px 0">Last 7 days of imported data (daily average):</p>
      <div class="kv" style="border-top:0"><span>Steps</span><span>${fmt(havg('steps'))}</span></div>
      <div class="kv"><span>Exercise</span><span>${havg('exerciseMin') != null ? fmt(havg('exerciseMin')) + ' min' : '—'}</span></div>
      <div class="kv"><span>Sleep</span><span>${havg('sleepHrs') != null ? fmt(havg('sleepHrs'), 1) + ' h' : '—'}</span></div>
      <div class="kv"><span>Resting heart rate</span><span>${havg('restingHR') != null ? fmt(havg('restingHR')) + ' bpm' : '—'}</span></div>
      <div class="kv"><span>Active calories</span><span>${fmt(havg('activeKcal'))}</span></div>`
      : `<p class="small muted">${health.length ? 'No imported data from the last 7 days — import a fresh export to update.' : 'Import your Health app export to see steps, exercise, sleep, resting heart rate and weight next to your food log.'}</p>`}
    <p class="tiny muted" style="margin-bottom:0">${lastImp ? 'Last import: ' + esc(new Date(lastImp.at).toLocaleDateString()) + '. ' : ''}Web apps can’t read Apple Health directly (Apple allows that only for App Store apps), so re-import an export whenever you want fresher numbers.</p></section>`;
  view().onclick = async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.med) { const m = meds.find(x => x.id === b.dataset.med); if (m) (m.type === 'dose' ? openDoseSheet : openSymptomSheet)(m); return; }
    if (b.dataset.bp) { const r = bpAll.find(x => x.id === b.dataset.bp); if (r) openBpSheet(r); return; }
    if (b.dataset.labt) { openLabHistory(b.dataset.labt); return; }
    if (b.dataset.act === 'hprofile') { openProfileSheet(); return; }
    if (b.dataset.act === 'guide-all') { state.showAllGuide = !state.showAllGuide; render(); return; }
    if (b.dataset.act === 'bp') { openBpSheet(); return; }
    if (b.dataset.act === 'lab') { openLabSheet(); return; }
    const a = b.dataset.act;
    if (a === 'profile') openMedProfile();
    else if (a === 'dose') openDoseSheet();
    else if (a === 'symptom') openSymptomSheet();
    else if (a === 'import') openHealthImport();
  };
}

// ---------- Progress report (for you or your provider) ----------
async function buildReport(rangeDays) {
  const s = state.settings, today = dateStr();
  const from = rangeDays ? addDays(today, -(rangeDays - 1)) : '0000-00-00';
  const inR = d => d >= from && d <= today;
  const allDays = lastPerDay(await DB.all('weights'), 'lb');
  const wDays = allDays.filter(d => inR(d.date));
  const ws = weightStats(allDays, s);
  const meds = (await DB.all('meds')).filter(m => inR(m.date)).sort((a, b) => a.date.localeCompare(b.date));
  const doses = meds.filter(m => m.type === 'dose'), sym = meds.filter(m => m.type === 'symptom');
  const measAll = await DB.all('measurements');
  const meas = measureSummary(measAll.filter(m => inR(m.date)));
  const health = (await DB.all('health')).filter(h => inR(h.date));
  const entries = (await DB.all('entries')).filter(e => inR(e.date));
  const byDay = {}; for (const e of entries) (byDay[e.date] = byDay[e.date] || []).push(e);
  const dayTotals = Object.values(byDay).map(es => sumNuts(es).t);
  const navg = k => dayTotals.length ? dayTotals.reduce((a, t) => a + t[k], 0) / dayTotals.length : null;
  const havg = k => { const v = health.map(h => h[k]).filter(x => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const firstDate = rangeDays ? from : [wDays[0]?.date, meds[0]?.date, Object.keys(byDay).sort()[0]].filter(Boolean).sort()[0] || today;
  const D = d => parseD(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const symAvg = k => sym.length ? sym.reduce((a, x) => a + (x[k] || 0), 0) / sym.length : null;
  const appCounts = APPETITE.map((l, i) => [l, sym.filter(x => x.appetite === i).length]).filter(x => x[1]);
  const notes = meds.filter(m => m.other || m.notes);
  const row = (a, b) => `<tr><td>${a}</td><td style="text-align:right">${b}</td></tr>`;
  const chart = lineChart([{ pts: wDays, type: 'dots', color: '#1f9d55' }, { pts: trendSeries(allDays).filter(d => inR(d.date)), type: 'line', color: '#0a84ff' }], { goal: num(s.goalWeight), h: 190, label: 'Weight' });
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NutriTrack report ${today}</title>
<style>body{font:15px/1.45 -apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#111;max-width:760px;margin:0 auto;padding:20px;background:#fff}
h1{font-size:24px;margin:0}h2{font-size:17px;margin:22px 0 8px;border-bottom:2px solid #1f9d55;padding-bottom:4px}table{width:100%;border-collapse:collapse}td,th{padding:6px 4px;border-bottom:1px solid #e3e3e3;text-align:left;font-size:14px}
.muted{color:#666}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.box{border:1px solid #e3e3e3;border-radius:10px;padding:10px;text-align:center}.box b{display:block;font-size:20px}
@media print{body{padding:0}}</style></head><body>
<h1>Health &amp; nutrition summary</h1>
<p class="muted">${esc(D(firstDate))} – ${esc(D(today))} · Created ${esc(new Date().toLocaleString())} with NutriTrack (personal log, self-reported)</p>
<h2>Weight</h2>
${wDays.length ? `<div class="grid"><div class="box"><b>${fmt(wDays[0].v, 1)} → ${fmt(wDays[wDays.length - 1].v, 1)}</b>lb this period</div>
<div class="box"><b>${(wDays[wDays.length - 1].v - wDays[0].v) <= 0 ? '−' : '+'}${fmt(Math.abs(wDays[wDays.length - 1].v - wDays[0].v), 1)} lb</b>change this period</div>
<div class="box"><b>${ws ? (ws.lost >= 0 ? '−' : '+') + fmt(Math.abs(ws.lost), 1) + ' lb' : '—'}</b>${ws ? fmt(Math.abs(ws.pctLost), 1) + '% since start (' + fmt(ws.start, 1) + ' lb)' : ''}</div></div>
${chart}<p class="muted" style="font-size:12px">Dots: weigh-ins (${wDays.length}) · Line: trend weight${num(s.goalWeight) != null ? ' · Dashed: goal ' + fmt(num(s.goalWeight), 1) + ' lb' : ''}</p>
${ws ? `<p>${esc(ws.trend.text)}</p>` : ''}` : '<p class="muted">No weigh-ins in this period.</p>'}
${meas.length ? `<h2>Body measurements (inches)</h2><table><tr><th>Site</th><th>First</th><th>Latest</th><th>Change</th></tr>${meas.map(m => `<tr><td>${m.l}</td><td>${fmt(m.first.v, 2)} <span class="muted">(${esc(D(m.first.date))})</span></td><td>${fmt(m.last.v, 2)} <span class="muted">(${esc(D(m.last.date))})</span></td><td>${m.first.date === m.last.date ? '—' : (m.change <= 0 ? '−' : '+') + fmt(Math.abs(m.change), 2)}</td></tr>`).join('')}</table>` : ''}
<h2>Medication</h2>
${s.medName ? `<p>Prescribed: <b>${esc(s.medName)}</b> ${esc(s.medDose || '')} (${esc({ weekly: 'once a week', daily: 'daily', other: 'as prescribed' }[s.medSchedule || 'weekly'])})</p>` : ''}
${doses.length ? `<table><tr><th>Date</th><th>Medication</th><th>Dose</th></tr>${doses.map(d => `<tr><td>${esc(D(d.date))}</td><td>${esc(d.med)}</td><td>${esc(d.dose)}</td></tr>`).join('')}</table>` : '<p class="muted">No doses logged in this period.</p>'}
${(s.medList || []).length ? `<h2>Medication list (self-reported)</h2><table><tr><th>Medication</th><th>Dose</th><th>For</th><th>Status</th></tr>${s.medList.map(m => `<tr><td>${esc(m.name)}</td><td>${esc(m.dose || '')}</td><td>${esc(m.purpose || '')}</td><td>${m.status === 'confirm' ? 'Needs confirming' : m.status === 'stopped' ? 'Stopped' : 'Taking'}</td></tr>`).join('')}</table>` : ''}
${await (async () => { const bpR = (await DB.all('bp')).filter(r => inR(r.date)).sort((a, b) => a.date.localeCompare(b.date)); if (!bpR.length) return '';
  const as = bpR.reduce((a, r) => a + r.sys, 0) / bpR.length, ad = bpR.reduce((a, r) => a + r.dia, 0) / bpR.length;
  return `<h2>Blood pressure</h2><p>${bpR.length} readings · average ${fmt(as)}/${fmt(ad)} mmHg · ${bpR.filter(r => r.dizzy).length} with dizziness</p><table><tr><th>Date</th><th>Reading</th><th>Pulse</th><th>Notes</th></tr>${bpR.slice(-20).map(r => `<tr><td>${esc(dLabel(r))}</td><td>${r.sys}/${r.dia}</td><td>${r.pulse ?? ''}</td><td>${r.dizzy ? 'dizzy ' : ''}${esc(r.note || '')}</td></tr>`).join('')}</table>`; })()}
${await (async () => { const lb = (await DB.all('labs')).sort((a, b) => a.date.localeCompare(b.date)); if (!lb.length) return '';
  return `<h2>Lab results (all on file)</h2><table><tr><th>Test</th><th>Date</th><th>Result</th></tr>${LAB_TESTS.flatMap(([k, l, u]) => lb.filter(r => r.test === k).map(r => `<tr><td>${esc(l)}</td><td>${esc(dLabel(r))}</td><td>${fmt(r.value, 1)} ${esc(u)}</td></tr>`)).join('')}</table>`; })()}
<h2>Side effects &amp; appetite</h2>
${sym.length ? `<table>${row('Days with check-ins', sym.length)}${row('Average nausea (0 none – 3 severe)', fmt(symAvg('nausea'), 1))}${row('Average constipation (0 none – 3 severe)', fmt(symAvg('constipation'), 1))}${row('Days with moderate/severe nausea', sym.filter(x => x.nausea >= 2).length)}${row('Days with moderate/severe constipation', sym.filter(x => x.constipation >= 2).length)}${row('Appetite', appCounts.map(([l, n]) => `${esc(l)}: ${n}`).join(', '))}</table>` : '<p class="muted">No check-ins logged in this period.</p>'}
${notes.length ? `<p><b>Notes</b></p><table>${notes.map(m => `<tr><td style="white-space:nowrap">${esc(D(m.date))}</td><td>${esc([m.other, m.notes].filter(Boolean).join(' — '))}</td></tr>`).join('')}</table>` : ''}
<h2>Nutrition (daily averages on ${dayTotals.length} logged days)</h2>
${dayTotals.length ? `<table>${row('Calories', fmt(navg('kcal')) + ' kcal')}${row('Protein', fmt(navg('protein')) + ' g')}${row('Carbohydrates', fmt(navg('carbs')) + ' g')}${row('Fat', fmt(navg('fat')) + ' g')}${row('Fiber', fmt(navg('fiber')) + ' g')}${row('Sodium', fmt(navg('sodium')) + ' mg')}</table>
<p class="muted" style="font-size:12px">Averages include only days with food logged. Some foods may be missing values, so totals can be low.</p>` : '<p class="muted">No food logged in this period.</p>'}
${health.length ? `<h2>Activity &amp; sleep (Apple Health, daily averages)</h2><table>${row('Steps', fmt(havg('steps')))}${row('Exercise minutes', fmt(havg('exerciseMin')))}${row('Active calories', fmt(havg('activeKcal')))}${row('Sleep', havg('sleepHrs') != null ? fmt(havg('sleepHrs'), 1) + ' h' : '—')}${row('Resting heart rate', havg('restingHR') != null ? fmt(havg('restingHR')) + ' bpm' : '—')}</table>` : ''}
<p class="muted" style="font-size:12px; margin-top:24px">Self-tracked information for discussion with a healthcare provider. Not a medical record or medical advice.</p>
</body></html>`;
}
function openReportSheet() {
  const el = openSheet(`
    <div class="sheet-head"><button class="link" data-act="close">Close</button><div class="sheet-title">Progress report</div><span style="width:50px"></span></div>
    <div class="seg" id="rp-r">${[[30, '30 days'], [90, '90 days'], [0, 'All time']].map(([v, l], i) => `<button data-r="${v}" class="${i === 1 ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div class="card" style="padding:0; overflow:hidden; margin-top:12px"><iframe id="rp-f" title="Report preview" style="width:100%; height:60vh; border:0; background:#fff"></iframe></div>
    <div class="stack"><button class="btn primary big" data-act="share">Share or save report</button></div>
    <p class="tiny muted">Shares a file you can save to Files or OneDrive, print, or send to your provider’s portal. It isn’t encrypted, so share it only where you intend to.</p>`);
  let range = 90, html = '';
  const draw = async () => { html = await buildReport(range); $('#rp-f', el).srcdoc = html; };
  draw();
  el.onclick = async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.r != null) { range = Number(b.dataset.r); $$('#rp-r button', el).forEach(x => x.classList.toggle('on', x === b)); draw(); return; }
    if (b.dataset.act === 'close') closeSheet();
    if (b.dataset.act === 'share') { try { await shareOrDownload(html, `nutritrack-report-${dateStr()}.html`, 'text/html'); } catch (err) { toast('Could not share: ' + err.message); } }
  };
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
// Adds dated history (weights, measurements, doses) without replacing anything already in the app.
function doHistoryImport() {
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.json,application/json';
  inp.onchange = async () => {
    const f = inp.files && inp.files[0]; if (!f) return;
    try {
      const o = JSON.parse(await f.text());
      if (o.format !== 'nutritrack-history') throw new Error('This isn’t a NutriTrack history file.');
      const W = await DB.all('weights'), M = await DB.all('measurements'), D = await DB.all('meds');
      let nw = 0, nm = 0, nd = 0;
      for (const w of o.weights || []) if (w.date && num(w.lb) && !W.some(x => x.date === w.date && Math.abs(x.lb - w.lb) < 0.05)) { await DB.put('weights', { id: uid(), date: w.date, lb: num(w.lb), note: w.note || '', source: w.source || 'History', createdAt: Date.now() }); nw++; }
      for (const m of o.measurements || []) if (m.date && !M.some(x => x.date === m.date)) { const r = { id: uid(), date: m.date, createdAt: Date.now() }; MEASURES.forEach(([k]) => { r[k] = num(m[k]); }); await DB.put('measurements', r); nm++; }
      for (const d of o.meds || []) if (d.date && !D.some(x => x.type === (d.type || 'dose') && x.date === d.date && (x.dose || '') === (d.dose || ''))) { await DB.put('meds', { id: uid(), type: d.type || 'dose', date: d.date, med: d.med || '', dose: d.dose || '', site: d.site || '', notes: d.notes || '', nausea: d.nausea ?? 0, constipation: d.constipation ?? 0, appetite: d.appetite ?? 2, other: d.other || '', createdAt: Date.now() }); nd++; }
      const LB = await DB.all('labs'), BP = await DB.all('bp'); let nl = 0, nb = 0;
      for (const r of o.labs || []) if (r.date && r.test && num(r.value) != null && !LB.some(x => x.test === r.test && x.date === r.date)) { await DB.put('labs', { id: uid(), date: r.date, test: r.test, value: num(r.value), approx: !!r.approx, note: r.note || '', createdAt: Date.now() }); nl++; }
      for (const r of o.bp || []) if (r.date && r.sys && !BP.some(x => x.date === r.date && x.sys === r.sys && x.dia === r.dia)) { await DB.put('bp', { id: uid(), date: r.date, sys: r.sys, dia: r.dia, pulse: r.pulse ?? null, approx: !!r.approx, note: r.note || '', dizzy: false, createdAt: Date.now() }); nb++; }
      let ns = 0;
      for (const [k, v] of Object.entries(o.settings || {})) if (state.settings[k] == null || state.settings[k] === '') { state.settings[k] = v; ns++; }
      if (ns) await DB.put('kv', state.settings);
      closeAllSheets(); toast(`Added ${nw} weigh-ins, ${nm} measurements, ${nd} doses, ${nl} lab results, ${nb} BP readings`, 4500); render();
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
  const goal = (k, l, u) => `<div><label class="f">${l} (${u})</label><input class="in" type="number" inputmode="decimal" step="any" data-goal="${k}" value="${s[k] ?? ''}"></div>`;
  const el = openSheet(`
    <div class="sheet-head"><button class="link" data-act="close">Done</button><div class="sheet-title">Settings</div><span style="width:50px"></span></div>
    <h3>Daily goals</h3>
    <button class="btn secondary block" data-act="targets">✨ Recommend targets from my stats</button>
    <div class="grid2">${goal('kcal', 'Calories', 'kcal')}${goal('protein', 'Protein', 'g')}${goal('carbs', 'Carbs', 'g')}${goal('fat', 'Fat', 'g')}${goal('fiber', 'Fiber', 'g')}${goal('waterGoal', 'Water', 'oz')}${goal('goalWeight', 'Goal weight', 'lb')}${goal('startWeight', 'Starting weight', 'lb')}${goal('heightIn', 'Height', 'inches')}${goal('sodiumLimit', 'Sodium limit', 'mg')}${goal('satfatLimit', 'Sat. fat limit', 'g')}${goal('addedSugarLimit', 'Added sugar limit', 'g')}</div>
    <p class="tiny muted">Leave starting weight blank to use your first weigh-in.</p>
    <div class="stack"><button class="btn primary" data-act="save-goals">Save goals</button></div>
    <h3>Food search</h3>
    <p class="small muted">Plain-food and restaurant search uses the USDA database. It works with a shared free key; for unlimited everyday use, get your own free key at <b>api.data.gov/signup</b> (takes a minute — it’s emailed to you) and paste it here. It stays on this phone.</p>
    <input class="in" id="usda-key" placeholder="USDA API key (optional)" value="${esc(s.usdaKey || '')}" autocomplete="off" autocapitalize="off" spellcheck="false">
    <div class="stack"><button class="btn secondary" data-act="save-key">Save key</button></div>
    <label class="f" style="margin-top:18px">Restaurant & brand database (fatsecret)</label>
    <p class="small muted" style="margin-top:0">Optional, free. Adds a much larger restaurant and brand-name database through your own private relay. See the setup guide in the README, or ask Claude to walk you through it.</p>
    <input class="in" id="fs-url" placeholder="Relay address, e.g. https://nutritrack-food.yourname.workers.dev" value="${esc(s.fsUrl || '')}" autocomplete="off" autocapitalize="off" spellcheck="false">
    <input class="in" id="fs-token" style="margin-top:8px" placeholder="App token (if you set one)" value="${esc(s.fsToken || '')}" autocomplete="off" autocapitalize="off" spellcheck="false">
    <div class="row" style="margin-top:10px"><button class="btn secondary" style="flex:1" data-act="save-fs">Save</button><button class="btn" style="flex:1" data-act="test-fs">Test connection</button></div>
    <h3>Backup &amp; restore</h3>
    <p class="small muted">Last backup: ${lb ? new Date(lb).toLocaleString() : 'never'}. Backups are encrypted with your passphrase (AES-256) before they leave the app. Save them to OneDrive from the share sheet, and use Restore to move your data to another device, like your Windows PC.</p>
    <div class="stack"><button class="btn secondary" data-act="backup">Create encrypted backup</button>
    <button class="btn secondary" data-act="restore">Restore from backup</button>
    <button class="btn" data-act="csv">Export diary as spreadsheet (CSV, not encrypted)</button>
    <button class="btn" data-act="history">Import history file (adds, doesn’t replace)</button></div>
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
    else if (a === 'targets') openTargets();
    else if (a === 'save-goals') {
      $$('[data-goal]', el).forEach(i => { const k = i.dataset.goal, v = num(i.value); if (k === 'goalWeight' || k === 'startWeight' || k === 'heightIn') state.settings[k] = v != null && v > 0 ? v : null; else if (v != null && v >= 0) state.settings[k] = v; });
      await DB.put('kv', state.settings); toast('Goals saved'); render();
    } else if (a === 'save-fs' || a === 'test-fs') {
      state.settings.fsUrl = $('#fs-url', el).value.trim(); state.settings.fsToken = $('#fs-token', el).value.trim(); await DB.put('kv', state.settings);
      if (a === 'save-fs') { toast('Saved'); return; }
      if (!state.settings.fsUrl) { toast('Enter your relay address first'); return; }
      toast('Testing…', 6000);
      try { const r = await searchFatSecret('big mac'); toast(r.length ? `Connected ✓ — found ${r.length} results for “big mac”` : 'Connected, but no results came back', 4000); }
      catch (err) { toast(err.message, 5000); }
    } else if (a === 'save-key') { state.settings.usdaKey = $('#usda-key', el).value.trim(); await DB.put('kv', state.settings); toast('Key saved'); }
    else if (a === 'backup') doBackup();
    else if (a === 'restore') doRestore();
    else if (a === 'csv') exportCSV();
    else if (a === 'history') doHistoryImport();
    else if (a === 'wipe') wipeAll();
  };
}

// ---------- Start ----------
async function init() {
  await loadSettings();
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) { /* ignore */ }
  $('#tabbar').onclick = e => { const b = e.target.closest('[data-tab]'); if (b) { closeAllSheets(); if (b.dataset.tab === 'home') state.homeDate = null; go(b.dataset.tab); } };
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
if (typeof module !== 'undefined') module.exports = { parseFsDesc, mapFsSearch, mapFsFood, matchScore, rankResults, bpCategory, labFlag, unitOptions, amountLabel, recommendTargets, checkinSuggestion, medLevelSeries, doseMg, mapUSDA, niceName, trendSeries, weightStats, lastPerDay, makeHealthParser, avgWindow, parseLabel, recipeTotals, calcNutrients, mapOFF, upcEtoA, barcodeCandidates, isIncomplete, canUseServing, canUseGrams, sumNuts, missingLabels };
