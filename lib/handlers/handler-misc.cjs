// handler-misc.cjs — Miscellaneous edge case handlers.
// Covers: wrong input in location states, WhatsApp location share,
// URL echo, free-text order (entry point), form clarification.

'use strict';

const LOCATION_STATES = new Set(['awaiting_location', 'awaiting_address', 'awaiting_location_retry']);
const FORM_STATES = new Set(['awaiting_missing_form_inquiry', 'awaiting_missing_form_clarify']);

function match(state, ctx) {
  // Wrong input in location states
  if (LOCATION_STATES.has(state)) return true;
  // Missing form clarification
  if (FORM_STATES.has(state)) return true;
  // Free-text order (product-like keywords in initial states)
  if (!state || state === 'initial' || state === 'main_menu' || state === 'awaiting_usecase') {
    const t = ctx.text.trim().toLowerCase();
    if (t.length > 10 && /\b(?:order|pesan|beli|mau|pengen|ingin)\b.*\b(?:risol|ayam|smoked|ragout|creamy|frozen|goreng|mix)\b/i.test(t)) return true;
  }
  return false;
}

async function handler(ctx) {
  const t = ctx.text.trim().toLowerCase();
  const state = ctx.state;
  ctx.log('misc-v2', 'state=' + (state || '?') + ' text=' + t.slice(0, 50));

  // ── Wrong input in location states ──────────────────────────────────
  if (LOCATION_STATES.has(state)) {
    if (/^(?:ok|ya|iya|cancel|batal|menu)\b/i.test(t)) return; // let other handlers take it
    ctx.replyText =
      'Mintu masih tunggu alamat atau titik lokasi ya Kak 🤍\n\n' +
      'Bisa:\n• Share lokasi lewat WhatsApp (attach → location)\n• Kirim link Google Maps\n• Ketik alamat lengkap\n\n' +
      'Kalau mau cancel, ketik *cancel*.';
    ctx.handled = true;
    return;
  }

  // ── Form clarification ──────────────────────────────────────────────
  if (FORM_STATES.has(state)) {
    ctx.replyText = 'Kak, mau yang *goreng* (makan langsung) atau *frozen* (simpan di rumah)? 🤍';
    ctx.handled = true;
    return;
  }

  // ── Free-text order entry ──────────────────────────────────────────
  if (!state || state === 'initial' || state === 'main_menu' || state === 'awaiting_usecase') {
    ctx.updateDraft({ state: 'awaiting_product_selection' });
    ctx.saveDraft();
    ctx.log('misc-v2', 'free_text_order → awaiting_product_selection');
    // Let product handler + LLM handle the actual order parsing
    return;
  }
}

module.exports = { match, handler };
