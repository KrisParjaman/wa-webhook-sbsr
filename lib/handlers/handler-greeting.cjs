// handler-greeting.cjs — Greeting & menu handler (ctx pattern).
// Handles: initial, main_menu, welcome states.
// Catches: greetings (hi, halo), menu requests, restart intents.
//
// This is the first handler in the pipeline. If it matches, it sends
// the welcome catalog and marks ctx.handled = true.

'use strict';

const GREETING_RE = /^(hi|hai|halo|hallo|hello|pagi|siang|sore|malam|assalamualaikum|assalamu'alaikum|permisi|tes|test)\b/i;
const MENU_RE = /^(?:menu|katalog|catalog|pricelist|price\s*list|lihat\s+menu|kirim\s+menu|show\s+menu|mau\s+lihat\s+menu|order\s+lagi|mau\s+order\s+lagi)\b/i;
const RESTART_RE = /^(?:hi|hello|halo|hai|menu|mulai\s+lagi|restart|ulang|start|reset)\b/i;
const MANUAL_RESET_RE = /^(?:reset|mulai\s+lagi|start\s+over|test\s+ulang)\s*$/i;
const CANCEL_RE = /\b(?:cancel|batal|ga\s+jadi|gak\s+jadi|nggak\s+jadi|tidak\s+jadi|ulang|ulangi|order\s+ulang|mulai\s+ulang|reset\s+order|hapus\s+pesanan|batalin)\b/i;

/**
 * Match: handler runs for initial/main_menu states OR greeting-like text.
 */
function match(state, ctx) {
  // Always catch greetings, menu requests, restart, cancel in any state
  const text = ctx.text.trim();
  if (GREETING_RE.test(text)) return true;
  if (MENU_RE.test(text)) return true;
  if (RESTART_RE.test(text) && (state === 'initial' || state === 'main_menu' || !state)) return true;
  if (MANUAL_RESET_RE.test(text)) return true;
  if (CANCEL_RE.test(text) && (state === 'initial' || state === 'main_menu' || !state)) return true;

  // Also match for empty/initial states with any text
  if (!state || state === 'initial' || state === 'none' || state === '') return true;

  return false;
}

/**
 * Handle: send welcome catalog, set state to main_menu.
 */
async function handler(ctx) {
  const text = ctx.text.trim().toLowerCase();
  ctx.log('greeting-v2', 'state=' + (ctx.state || 'initial') + ' text=' + text.slice(0, 50));

  // Manual reset — clear all state
  if (MANUAL_RESET_RE.test(text) || CANCEL_RE.test(text)) {
    ctx.updateDraft({ state: 'initial', items: [], addons: [], customer_name: '', address_text: '' });
    ctx.saveDraft();
    ctx.replyText =
      'Siap Kak, Mintu mulai dari awal ya 🤍\n\n' +
      'Selamat datang di Sentuh Rasa — Risoles Otentik!\n\n' +
      'Mintu siap bantu. Mau...\n' +
      '*1.* Lihat menu & harga\n' +
      '*2.* Order langsung — sebut aja produknya\n' +
      '*3.* Tanya-tanya dulu\n\n' +
      'Ketik aja ya Kak~';
    ctx.handled = true;
    return;
  }

  // Greeting or menu request — send welcome
  if (GREETING_RE.test(text) || MENU_RE.test(text) || !text || ctx.state === 'initial' || ctx.state === 'main_menu' || !ctx.state) {
    // For text containing product references, let product handler take over
    if (text.length > 3 && /\b(?:frozen|goreng|ayam\s*sayur|smoked\s*beef|creamy|original|mix|risol)\b/i.test(text)) {
      return; // let product handler take it
    }

    ctx.updateDraft({ state: 'main_menu' });
    ctx.saveDraft();

    ctx.replyText =
      'Halo Kak! Selamat datang di *Sentuh Rasa* — Risoles Otentik! 🤍\n\n' +
      'Mintu siap bantu Kakak. Mau...\n' +
      '*1.* Lihat menu & harga\n' +
      '*2.* Order langsung — sebut aja produk yang diinginkan\n' +
      '*3.* Tanya-tanya dulu\n\n' +
      'Ketik aja ya Kak, ngobrol santai aja sama Mintu.';
    ctx.handled = true;
    return;
  }

  // Not a greeting — let next handler try
}

module.exports = { match, handler };
