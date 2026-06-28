// text-utils.cjs — Text parsing utilities: name extraction, address detection.
'use strict';

// ── Name extraction ─────────────────────────────────────────────────
const NAME_BLOCKLIST = new Set(['saya','aku','gue','gua','nama','alamat','kirim','antar','order','pesan','menu','cancel','batal','lanjut','ok','cukup','tidak','gak','nggak','ya','iya','tambah']);
const NAME_PATTERNS = [
  /\b(?:nama|atas\s*nama|a\.?n\.?|nama\s*lengkap|nama\s*penerima|nama\s*saya)\s*[:=]?\s*([A-Za-z\s.'-]{3,40})\b/i,
  /\b(?:saya|aku|nama\s*saya|nama\s*aku|gue|gua)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})\b/,
  /\b([A-Z][a-z]{2,20}(?:\s+[A-Z][a-z]{2,20}){1,3})\b/,
];

function extractCustomerName(text) {
  const raw = String(text || '').replace(/[.!?,;:]+$/g, '').trim();
  if (raw.length < 3 || raw.length > 50) return null;
  for (const re of NAME_PATTERNS) {
    const m = raw.match(re);
    if (m && m[1]) {
      const c = m[1].trim();
      if (c.length >= 3 && c.length <= 40) {
        const lower = c.toLowerCase();
        if (NAME_BLOCKLIST.has(lower)) continue;
        if (/\b(?:makan|beli|pesan|order|cancel|menu|jl\.?|jalan|blok|no\.?\s*\d)\b/i.test(c)) continue;
        return c;
      }
    }
  }
  return null;
}

function isNameTokens(t, opts) {
  const s = String(t || '').trim();
  if (s.length < 3 || s.length > 50) return false;
  if (NAME_BLOCKLIST.has(s.toLowerCase())) return false;
  const words = s.split(/\s+/);
  if (words.length < 1 || words.length > 4) return false;
  return words.every(w => /^[A-Z][a-z]{1,20}$/.test(w) || /^[A-Z]\.$/.test(w));
}

function findNameInChatHistory(fromRaw, lookback) {
  return null; // simplified — original requires chat history access
}

// ── Address detection ───────────────────────────────────────────────
const MAPS_URL_RE = /^https?:\/\/.*(?:google\.com\/maps|maps\.google|goo\.gl\/maps|maps\.app\.goo\.gl)/i;
const ADDR_KEYWORDS = /\b(?:jl\.?|jalan|komplek|blok|blk|no\.?\s*\d+|rt\.?\s*\d+|rw\.?\s*\d+|kelurahan|kecamatan|kabupaten|kota|provinsi|kode\s*pos|gg\.?|gang|perum|cluster|apartemen|tower|lt\.?\s*\d+|lantai\s*\d+)\b/i;

function looksLikeAddress(text) {
  const t = String(text || '').trim();
  if (t.length < 10) return false;
  if (MAPS_URL_RE.test(t)) return false;
  if (!ADDR_KEYWORDS.test(t)) return false;
  if (/^\d+$/.test(t.replace(/\s/g, ''))) return false;
  if (/^(?:hi|halo|hai|pagi|siang|sore|malam|ok|ya|cancel|batal)\b/i.test(t)) return false;
  return true;
}

function looksLikeAddressPinMismatch(addrText, url) {
  if (!addrText || !url) return false;
  const addr = String(addrText).toLowerCase();
  const u = String(url).toLowerCase();
  const addrWords = new Set(addr.split(/[\s,.-]+/).filter(w => w.length > 2));
  const placeWords = new Set(u.split(/[\s,./?=&-]+/).filter(w => w.length > 2));
  const overlap = [...addrWords].filter(w => placeWords.has(w));
  return overlap.length === 0;
}

module.exports = { extractCustomerName, isNameTokens, findNameInChatHistory, looksLikeAddress, looksLikeAddressPinMismatch };
