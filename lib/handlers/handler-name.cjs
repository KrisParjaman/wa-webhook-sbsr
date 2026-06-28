// handler-name.cjs — Customer name capture handler.
// Handles: awaiting_name state, name + address combo capture.
// Name extracted via regex patterns for common Indonesian name formats.

'use strict';

const NAME_PATTERNS = [
  // "nama: Budi Setiawan"
  /\b(?:nama|atas\s*nama|a\.?n\.?|nama\s*lengkap|nama\s*penerima|nama\s*saya)\s*[:=]?\s*([A-Za-z\s.'-]{3,40})\b/i,
  // "saya Budi", "aku Budi Setiawan"
  /\b(?:saya|aku|nama\s*saya|nama\s*aku|gue|gua)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})\b/,
  // "Budi Setiawan" — 2-3 capitalized words, no keywords
  /\b([A-Z][a-z]{2,20}(?:\s+[A-Z][a-z]{2,20}){1,3})\b/,
];

const NAME_BLOCKLIST = new Set([
  'saya', 'aku', 'gue', 'gua', 'nama', 'alamat', 'kirim', 'antar',
  'order', 'pesan', 'menu', 'cancel', 'batal', 'lanjut', 'ok',
  'cukup', 'tidak', 'gak', 'nggak', 'ya', 'iya', 'tambah',
]);

const ADDRESS_KEYWORDS = /\b(?:jl\.?|jalan|komplek|blok|blk|no\.?\s*\d+|rt\.?\s*\d+|rw\.?\s*\d+|kelurahan|kecamatan|kabupaten|kota|provinsi|kode\s*pos)\b/i;
const MAPS_URL_RE = /^https?:\/\/.*(?:google\.com\/maps|maps\.google|goo\.gl\/maps|maps\.app\.goo\.gl)/i;

/**
 * Match: state is awaiting_name, OR name-like text with items in cart.
 */
function match(state, ctx) {
  if (state === 'awaiting_name') return true;
  // Name in free text with active cart and no invoice
  const draft = ctx.draft;
  if (draft.invoice_sent_at) return false;
  if (!ctx.cart.length) return false;
  if (['awaiting_invoice_confirm', 'awaiting_proof', 'pending_finance', 'approved', 'BOOKED', 'booked', 'delivered', 'cancelled'].includes(state)) return false;
  // Check if text looks like a name
  const t = ctx.text.trim();
  if (t.length < 3 || t.length > 60) return false;
  if (MAPS_URL_RE.test(t)) return false;
  if (ADDRESS_KEYWORDS.test(t)) return false;
  if (/^(?:pouch|matcha|java|sambal|chili|chilli|lanjut|ok|ya|gas|lanjutkan)\b/i.test(t)) return false;
  const name = extractName(t);
  return !!name;
}

/**
 * Handle: capture name, optionally capture address if in same message.
 */
async function handler(ctx) {
  const t = ctx.text.trim();
  const state = ctx.state;
  ctx.log('name-v2', 'state=' + (state || '?') + ' text=' + t.slice(0, 50));

  const name = extractName(t);
  if (!name) {
    // Not a name — maybe address being sent instead of name (recovery)
    if (MAPS_URL_RE.test(t) || ADDRESS_KEYWORDS.test(t)) {
      if (ctx.draft.customer_name) {
        // Has name already, this is address → transition
        ctx.updateDraft({ state: 'awaiting_address' });
        ctx.saveDraft();
        ctx.log('name-v2', 'state_recover awaiting_name→awaiting_address');
        return; // let address handler take it
      }
    }
    return; // not handled
  }

  // ── Capture name ───────────────────────────────────────────────────
  ctx.updateDraft({
    customer_name: name,
    customer_name_set_at: new Date().toISOString(),
    state: 'awaiting_address',
  });
  ctx.saveDraft();
  ctx.log('name-v2', 'captured=' + name);

  ctx.replyText =
    'Hai Kak ' + name + '! 🤍\n\n' +
    'Sekarang Mintu butuh alamat lengkap pengiriman ya Kak.\n' +
    'Bisa ketik manual alamatnya atau share lokasi lewat WhatsApp / Google Maps biar lebih akurat 📍';
  ctx.handled = true;
}

/**
 * Extract a person name from text.
 */
function extractName(text) {
  const raw = String(text || '').replace(/[.!?,;:]+$/g, '').trim();
  if (raw.length < 3 || raw.length > 50) return null;

  for (const re of NAME_PATTERNS) {
    const m = raw.match(re);
    if (m && m[1]) {
      const candidate = m[1].trim();
      // Must be 3-40 chars, proper noun format
      if (candidate.length >= 3 && candidate.length <= 40) {
        const lower = candidate.toLowerCase();
        if (NAME_BLOCKLIST.has(lower)) continue;
        if (ADDRESS_KEYWORDS.test(candidate)) continue;
        if (/\b(?:makan|beli|pesan|order|cancel|menu)\b/i.test(candidate)) continue;
        return candidate;
      }
    }
  }
  return null;
}

module.exports = { match, handler };
