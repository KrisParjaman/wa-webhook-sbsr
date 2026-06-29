// catalog-pg.cjs — Single source of truth for SBSR product catalog.
// Prices loaded from PostgreSQL catalog_products; hardcoded fallback
// ensures correctness even when DB is unavailable at startup.
//
// SKU pattern in Postgres:
//   Goreng: RA-3, RA-6, RA-12  (Ayam Sayur)
//           RR-*, RM-*, RAM-*, RAP-*
//   Frozen: RA-FRZ, RR-FRZ, ...
'use strict';

// ── Variant key → Postgres SKU prefix ────────────────────────────────
const PREFIX = {
  ayam_sayur:  'RA',
  ragout:      'RR',
  smoked_beef: 'RM',
  mercon:      'RAM',
  ayam_pedas:  'RAP',
  mix:         'MIX',
};

// Hardcoded fallback — exact values from catalog_products (2026-06-29)
const FALLBACK = {
  'RA-3': 29000,  'RA-6': 55000,  'RA-12': 105000, 'RA-FRZ': 55000,
  'RR-3': 29000,  'RR-6': 55000,  'RR-12': 105000, 'RR-FRZ': 55000,
  'RM-3': 29000,  'RM-6': 55000,  'RM-12': 105000, 'RM-FRZ': 55000,
  'RAM-3': 33000, 'RAM-6': 63000, 'RAM-12': 120000, 'RAM-FRZ': 63000,
  'RAP-3': 29000, 'RAP-6': 55000, 'RAP-12': 105000, 'RAP-FRZ': 55000,
  'MIX-3': 29000, 'MIX-6': 55000, 'MIX-12': 105000,
};

const DISPLAY_NAMES = {
  ayam_sayur:  'Ayam Sayur',
  ragout:      'Ragout Creamy',
  smoked_beef: 'Smoked Beef Mayo',
  mercon:      'Ayam Mercon Chili Oil',
  ayam_pedas:  'Ayam Sayur Pedas',
  mix:         'Mix',
};

// ── In-memory cache populated from Postgres ──────────────────────────
let _priceCache = {};  // sku → price
let _loaded = false;
let _pool = null;

// ── Pool (lazy, uses POSTGRES_URL env) ───────────────────────────────
function _getPool() {
  if (!_pool) {
    try { _pool = new (require('pg').Pool)({ connectionString: process.env.POSTGRES_URL }); } catch (_) {}
  }
  return _pool;
}

async function reload(pgPool) {
  const pool = pgPool || _getPool();
  if (!pool) return;
  try {
    const res = await pool.query('SELECT retailer_id, price FROM catalog_products');
    const cache = {};
    for (const r of res.rows) cache[String(r.retailer_id)] = Number(r.price);
    _priceCache = cache;
    _loaded = true;
  } catch (_) {}
}

// Load at module init (best-effort, non-blocking)
reload().catch(() => {});

// ── Variant detection from free text ─────────────────────────────────
function detectVariant(text) {
  const t = String(text || '').toLowerCase();
  if (/mercon|chili\s*oil/.test(t))      return 'mercon';
  if (/ragout|rougut|ragut|ragu/.test(t)) return 'ragout';
  if (/smoked|beef|mayo/.test(t))         return 'smoked_beef';
  if (/pedas|spicy/.test(t))              return 'ayam_pedas';
  if (/mix\b/.test(t))                    return 'mix';
  if (/ayam|chicken|risol|risoles/.test(t)) return 'ayam_sayur';
  return null;
}

// ── SKU builder ───────────────────────────────────────────────────────
function buildSku(variant, form, qty) {
  const prefix = PREFIX[variant];
  if (!prefix) return null;
  if (form === 'frozen') return prefix + '-FRZ';
  const n = Number(qty);
  if ([3, 6, 12].includes(n)) return prefix + '-' + n;
  return null;
}

// ── Price lookup ──────────────────────────────────────────────────────
// Returns price for the given variant text, form, and qty.
// Falls back to hardcoded table if Postgres not loaded.
function lookupPrice(variantText, form, qty) {
  const variant = (typeof variantText === 'string' && variantText.includes('_'))
    ? variantText  // already a variant key
    : detectVariant(variantText);
  if (!variant) return null;
  const sku = buildSku(variant, form, qty);
  if (!sku) return null;
  if (_loaded && _priceCache[sku] !== undefined) return _priceCache[sku];
  return FALLBACK[sku] || null;
}

// ── Display name ──────────────────────────────────────────────────────
function lookupDisplayName(variantText, form) {
  const variant = (typeof variantText === 'string' && variantText.includes('_'))
    ? variantText
    : detectVariant(variantText);
  const base = (variant && DISPLAY_NAMES[variant]) || variantText;
  return form === 'frozen' ? base + ' Frozen' : base;
}

module.exports = { detectVariant, lookupPrice, lookupDisplayName, buildSku, reload };
