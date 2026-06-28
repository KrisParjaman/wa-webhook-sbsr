// catalog-manager.cjs — Product catalog management for Sentuh Rasa.
// Handles: Meta API catalog sync, product lookup, LLM context formatting.
//
// Dependency injection: init() with config + catalog map accessors.
// Catalog maps (catalogMap, catalogPrices, catalogAvailability) are
// mutated by refreshCatalogFromAPI() — the module stores getter fns
// that return the current live values.

'use strict';

const fs = require('fs');

// ── Injected ────────────────────────────────────────────────────────
let _cfg = {};
let _getCatalogMap, _getPrices, _getAvailability;
let _log, _notifyError;

function init(opts = {}) {
  _cfg = {
    apiToken: opts.apiToken || process.env.CATALOG_API_TOKEN || '',
    catalogId: opts.catalogId || process.env.WA_CATALOG_ID || '1477386560782761',
    productsJsonPath: opts.productsJsonPath || '/docker/wa-webhook-sbsr/products.json',
  };
  _getCatalogMap = opts.getCatalogMap || (() => ({}));
  _getPrices = opts.getPrices || (() => ({}));
  _getAvailability = opts.getAvailability || (() => ({}));
  _log = opts.log || (() => {});
  _notifyError = opts.notifyError || (() => {});
}

// ── Catalog sync (Meta API) ──────────────────────────────────────────

async function refreshFromAPI() {
  if (!_cfg.apiToken) return;
  try {
    const url = `https://graph.facebook.com/v22.0/${_cfg.catalogId}/products`
      + '?access_token=' + _cfg.apiToken
      + '&limit=50&fields=retailer_id,name,price,availability';
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const resp = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!resp.ok) return;
    const data = await resp.json();
    const products = Array.isArray(data?.data) ? data.data : [];
    let updated = 0;
    const map = _getCatalogMap();
    const prices = _getPrices();
    const avail = _getAvailability();
    for (const p of products) {
      const rid = p.retailer_id;
      if (!rid) continue;
      if (p.name) map[rid] = p.name;
      let price = parseInt(String(p.price || '0').replace(/[^0-9]/g, '')) || 0;
      const priceStr = String(p.price || '');
      if (priceStr.indexOf('.') === -1 && /^Rp/i.test(priceStr) && price > 0 && price <= 9999) {
        price = price * 100;
      }
      if (price > 0) prices[rid] = price;
      if (p.availability) avail[rid] = p.availability;
      updated++;
    }
    _log('catalog-api', `refreshed ${updated} products from Meta`);
  } catch (e) {
    _log('catalog-api', 'error: ' + e.message);
  }
}

// ── Product lookup ───────────────────────────────────────────────────

function lookupName(retailerId) {
  return _getCatalogMap()[retailerId] || retailerId;
}

function lookupPrice(retailerId) {
  return _getPrices()[retailerId] || null;
}

function lookupAvailability(retailerId) {
  return _getAvailability()[retailerId] || null;
}

// ── Static catalog (JSON fallback) ──────────────────────────────────

let _cached = null;

function loadStaticCatalog() {
  if (_cached) return _cached;
  try {
    _cached = JSON.parse(fs.readFileSync(_cfg.productsJsonPath, 'utf8'));
    return _cached;
  } catch (_) { return null; }
}

// ── LLM context formatters ──────────────────────────────────────────

function formatForLLM() {
  const map = _getCatalogMap();
  const prices = _getPrices();
  const avail = _getAvailability();

  const RI_RE = /^(RA|RR|RM|RAM|RAP|MIX)-(.+)$/;
  const famSeen = {};
  const famOrder = [];
  for (const rid in map) {
    if (!Object.prototype.hasOwnProperty.call(map, rid)) continue;
    const m = rid.match(RI_RE);
    if (!m) continue;
    if (!famSeen[m[1]]) { famSeen[m[1]] = true; famOrder.push(m[1]); }
  }

  const sizeSort = { '3': 1, '6': 2, '12': 3, 'FRZ': 4 };
  const famNames = { 'RA': 'Ayam Sayur', 'RR': 'Ragout Creamy', 'RM': 'Smoked Beef Mayo', 'RAM': 'Ayam Mercon Chili Oil', 'RAP': 'Ayam Sayur Pedas', 'MIX': 'Mix Risol' };

  const out = [];
  out.push('===== CATALOG SENTUH RASA (HARGA LIVE DARI META) =====');
  out.push('(Harga update otomatis setiap 5 menit dari katalog WhatsApp — ini sumber AKTUAL.)');
  out.push('');
  out.push('PRODUK GORENG (Makan Langsung — 3pcs / 6pcs / 12pcs):');

  for (const fKey of famOrder) {
    const gorengItems = [], frozenItems = [];
    for (const rid in map) {
      if (!Object.prototype.hasOwnProperty.call(map, rid)) continue;
      const m = rid.match(RI_RE);
      if (!m || m[1] !== fKey) continue;
      const it = { size: m[2], name: map[rid], price: prices[rid] || 0 };
      if (it.size === 'FRZ') frozenItems.push(it);
      else gorengItems.push(it);
    }
    gorengItems.sort((a, b) => (sizeSort[a.size] || 99) - (sizeSort[b.size] || 99));
    frozenItems.sort((a, b) => (sizeSort[a.size] || 99) - (sizeSort[b.size] || 99));

    const parts = [];
    for (const gi of gorengItems) {
      parts.push(gi.size + 'pcs=' + (gi.price > 0 ? 'Rp' + Number(gi.price).toLocaleString('id-ID') : '?'));
    }
    if (frozenItems.length > 0) {
      const fi = frozenItems[0];
      parts.push('Frozen 6pcs=' + (fi.price > 0 ? 'Rp' + Number(fi.price).toLocaleString('id-ID') : '?'));
    }
    const flavor = fKey === 'RAM' ? ' 🔥' : fKey === 'MIX' ? ' (pilih varian di chat)' : '';
    out.push('  - ' + (famNames[fKey] || fKey) + flavor + ': ' + parts.join(' | '));
  }

  // Add-ons
  out.push('');
  out.push('ADD-ON:');
  for (const rid in map) {
    if (!Object.prototype.hasOwnProperty.call(map, rid)) continue;
    if (rid.indexOf('ADD-') !== 0) continue;
    const ap = prices[rid] || 0;
    out.push('  - ' + map[rid] + (ap > 0 ? ' = Rp' + Number(ap).toLocaleString('id-ID') : ''));
  }

  // Unavailable
  const unavailable = [];
  for (const rid in avail) {
    const a = avail[rid];
    if (a && a !== 'in stock' && a !== 'available for order') {
      unavailable.push('  - ' + (map[rid] || rid) + ' [' + a + ']');
    }
  }
  if (unavailable.length > 0) {
    out.push('');
    out.push('⚠️ PRODUK TIDAK TERSEDIA:');
    out.push(...unavailable);
    out.push('(JANGAN rekomendasikan atau proses order produk di atas)');
  }

  return out.join('\n');
}

function formatMenuText() {
  const p = loadStaticCatalog();
  if (!p) return 'Menu sedang tidak tersedia. Ketik *menu* lagi nanti ya Kak 🤍';

  const out = [];
  out.push('📋 *Menu Sentuh Rasa*');
  out.push('');

  const cat = p.categories || [];
  for (const c of cat) {
    out.push('*' + c.name + '*');
    const vars = c.variants || [];
    for (const v of vars) {
      const prices = v.prices || {};
      const priceStr = Object.entries(prices)
        .map(([qty, price]) => qty + 'pcs Rp' + Number(price).toLocaleString('id-ID'))
        .join(' / ');
      out.push('• ' + v.name + ' — ' + priceStr);
    }
    out.push('');
  }

  out.push('*Add-On:*');
  const addons = p.store?.addons || [];
  for (const a of addons) {
    out.push('• ' + a.name + ' — Rp' + Number(a.price).toLocaleString('id-ID'));
  }

  return out.join('\n');
}

function formatFaqText() {
  const p = loadStaticCatalog();
  if (!p) return '';
  const faq = p.faq || [];
  if (faq.length === 0) return '';
  const out = [];
  out.push('');
  out.push('===== FAQ SENTUH RASA =====');
  for (const item of faq) {
    out.push('Q: ' + item.q);
    out.push('A: ' + item.a);
    out.push('');
  }
  return out.join('\n');
}

module.exports = {
  init,
  refreshFromAPI, refreshCatalogFromAPI: refreshFromAPI,
  lookupName, lookupProductName: lookupName,
  lookupPrice, lookupProductPrice: lookupPrice,
  lookupAvailability, lookupProductAvailability: lookupAvailability,
  loadStaticCatalog, loadProductCatalog: loadStaticCatalog,
  formatForLLM, formatCatalogForLLM: formatForLLM,
  formatMenuText, formatSbsrFullMenuText: formatMenuText,
  formatFaqText, formatFaqForLLM: formatFaqText,
};
