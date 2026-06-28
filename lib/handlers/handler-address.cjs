// handler-address.cjs — Address text capture + maps URL detection.
// Handles: awaiting_address, awaiting_location, bare address text.
// Complex orchestration (address+quote, geocoding) stays in server.js.

'use strict';

const MAPS_URL_RE = /^https?:\/\/.*(?:google\.com\/maps|maps\.google|goo\.gl\/maps|maps\.app\.goo\.gl)/i;
const ADDRESS_KEYWORDS = /\b(?:jl\.?|jalan|komplek|blok|blk|no\.?\s*\d+|rt\.?\s*\d+|rw\.?\s*\d+|kelurahan|kecamatan|kabupaten|kota|provinsi|kode\s*pos|gg\.?|gang|perum|cluster|apartemen|tower|lt\.?\s*\d+|lantai\s*\d+)\b/i;

function looksLikeAddress(text) {
  const t = String(text || '').trim();
  if (t.length < 10) return false;
  if (MAPS_URL_RE.test(t)) return false;
  // Must have at least 1 address keyword
  if (!ADDRESS_KEYWORDS.test(t)) return false;
  // Must not be pure numbers or greetings
  if (/^\d+$/.test(t.replace(/\s/g, ''))) return false;
  if (/^(?:hi|halo|hai|pagi|siang|sore|malam|ok|ya|cancel|batal)\b/i.test(t)) return false;
  return true;
}

/**
 * Match: address states or address-like text with active cart.
 */
function match(state, ctx) {
  if (state === 'awaiting_address' || state === 'awaiting_location') return true;
  // Bare maps URL from any state
  if (MAPS_URL_RE.test(ctx.text.trim()) && ctx.cart.length > 0) return true;
  // Address-like text with cart and no invoice
  const draft = ctx.draft;
  if (!draft.invoice_sent_at && ctx.cart.length > 0 && looksLikeAddress(ctx.text)) {
    if (!['awaiting_invoice_confirm', 'awaiting_proof', 'pending_finance', 'approved', 'BOOKED', 'booked', 'delivered', 'cancelled'].includes(state)) {
      return true;
    }
  }
  return false;
}

/**
 * Handle: capture address, set up for quote.
 */
async function handler(ctx) {
  const t = ctx.text.trim();
  const state = ctx.state;
  ctx.log('address-v2', 'state=' + (state || '?') + ' text=' + t.slice(0, 60));

  // ── Maps URL ───────────────────────────────────────────────────────
  if (MAPS_URL_RE.test(t)) {
    ctx.updateDraft({
      gmaps_link: t,
      pending_gmaps_link: t,
      pending_gmaps_link_at: new Date().toISOString(),
    });
    ctx.saveDraft();
    ctx.log('address-v2', 'maps_url_captured');
    // Let server.js handle geocoding → return not handled
    return;
  }

  // ── Address text ───────────────────────────────────────────────────
  if (looksLikeAddress(t)) {
    const captured = t.replace(/\s+/g, ' ');
    ctx.updateDraft({
      address_text: captured,
      pending_address_text: captured,
      pending_address_text_at: new Date().toISOString(),
      state: 'awaiting_address', // ensure we're in address state
      destination: {
        ...(ctx.draft.destination || {}),
        address_text: captured,
      },
    });
    ctx.saveDraft();
    ctx.log('address-v2', 'captured=' + captured.slice(0, 60));

    // If ready for quote (has name + maps), let server.js handle
    if (ctx.customerName && (ctx.draft.gmaps_link || (ctx.draft.destination && ctx.draft.destination.gmaps_link))) {
      ctx.log('address-v2', 'ready for quote — delegating to server.js');
      return; // server.js will fire address-and-quote
    }

    // Need maps/location — prompt
    ctx.replyText =
      'Alamat diterima ya Kak! 🤍\n\n' +
      'Sekarang Mintu butuh *titik lokasi* biar lebih akurat ngitung ongkirnya.\n' +
      'Bisa share lokasi lewat:\n' +
      '• *Share Location* (attach → location di WhatsApp)\n' +
      '• *Google Maps link* (copy-paste link-nya)\n\n' +
      'Mana aja yang gampang buat Kakak~';
    ctx.handled = true;
    return;
  }

  // ── Still awaiting address, not address-like — prompt ──────────────
  if (state === 'awaiting_address' || state === 'awaiting_location') {
    ctx.replyText =
      'Mintu tunggu alamatnya ya Kak 🤍\n' +
      'Bisa ketik alamat lengkap atau share lokasi WhatsApp / Google Maps.';
    ctx.handled = true;
    return;
  }
}

module.exports = { match, handler };
