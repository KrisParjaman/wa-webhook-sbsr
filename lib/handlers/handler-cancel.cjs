// handler-cancel.cjs — Cancel / restart / reset handler.
// Escape hatch from any conversation state. Runs early in the pipeline
// so customers can always bail out, regardless of state.
//
// Priority order: manual reset > cancel > restart > menu request.

'use strict';

const RESTART_RE = /^(?:hi|hello|halo|hai|menu|mulai\s+lagi|restart|ulang|start|reset)\b/i;
const MANUAL_RESET_RE = /^(?:reset|mulai\s+lagi|start\s+over|test\s+ulang)\s*$/i;
const CANCEL_RE = /\b(?:cancel|batal|ga\s+jadi|gak\s+jadi|nggak\s+jadi|tidak\s+jadi|ulang|ulangi|order\s+ulang|mulai\s+ulang|reset\s+order|hapus\s+pesanan|batalin)\b/i;
const MENU_RE = /^(?:menu|katalog|catalog|pricelist|price\s*list|lihat\s+menu|kirim\s+menu|show\s+menu|mau\s+lihat\s+menu|order\s+lagi|mau\s+order\s+lagi)\b/i;

// States protected from restart (in final stages of checkout)
const RESTART_PROTECTED = new Set([
  'awaiting_invoice_confirm', 'awaiting_proof', 'awaiting_payment_proof',
  'awaiting_manual_payment_review', 'awaiting_admin_review',
]);

/**
 * Match: any cancel/restart/reset/menu intent in any state.
 */
function match(state, ctx) {
  const t = ctx.text.trim().toLowerCase();
  if (!t) return false;

  // Quick: manual reset or explicit cancel always matches
  if (MANUAL_RESET_RE.test(t)) return true;
  if (CANCEL_RE.test(t)) return true;

  // Restart intent (but not order-like greetings)
  if (RESTART_RE.test(t)) {
    if (/^halo\b/i.test(t) && /\b(?:beli|pesan|order|mau |butuh|tanya|ingin)\b/i.test(t)) return false;
    return true;
  }

  // Menu request during active checkout
  if (MENU_RE.test(t)) return true;

  return false;
}

/**
 * Handle: reset/clear state appropriately, send transition message.
 */
async function handler(ctx) {
  const t = ctx.text.trim().toLowerCase();
  const state = ctx.state;
  ctx.log('cancel-v2', 'state=' + (state || 'initial') + ' text=' + t.slice(0, 50));

  // ── Manual reset — nuke everything ────────────────────────────────
  if (MANUAL_RESET_RE.test(t)) {
    ctx.updateDraft({
      state: 'initial', items: [], addons: [],
      customer_name: '', address_text: '', destination: null,
      gmaps_link: '', delivery_mode: '', use_case: '',
    });
    ctx.saveDraft();
    ctx.replyText = 'Siap Kak! Mintu reset semua ya 🤍\n\nMau lihat menu atau langsung order? Ketik aja~';
    ctx.handled = true;
    return;
  }

  // ── Cancel during checkout ─────────────────────────────────────────
  if (CANCEL_RE.test(t) && state && state !== 'initial' && state !== 'main_menu') {
    ctx.updateDraft({
      state: 'initial', items: [], addons: [],
      customer_name: '', address_text: '', destination: null,
      gmaps_link: '', delivery_mode: '', use_case: '',
    });
    ctx.saveDraft();
    ctx.replyText =
      'Siap Kak, Mintu batalkan dulu ya 🤍\n\n' +
      'Mau mulai lagi? Ketik *MENU* untuk lihat katalog atau langsung sebut produk yang Kakak mau.';
    ctx.handled = true;
    return;
  }

  // ── Restart in protected state — block it ──────────────────────────
  if (RESTART_RE.test(t) && RESTART_PROTECTED.has(state)) {
    ctx.replyText =
      'Pesanan Kakak masih dalam proses ya 🤍\n' +
      'Ketik *OK* kalau mau lanjut, atau balas sesuai yang Mintu tanyain sebelumnya.';
    ctx.handled = true;
    return;
  }

  // ── Restart in non-protected state — clean start ───────────────────
  if (RESTART_RE.test(t)) {
    ctx.updateDraft({
      state: 'initial', items: [], addons: [],
      customer_name: '', address_text: '', destination: null,
      gmaps_link: '', delivery_mode: '', use_case: '',
    });
    ctx.saveDraft();
    ctx.replyText =
      'Halo Kak! Selamat datang di *Sentuh Rasa* 🤍\n\n' +
      'Mau...\n*1.* Lihat menu & harga\n*2.* Order langsung\n*3.* Tanya-tanya\n\n' +
      'Ketik aja ya Kak~';
    ctx.handled = true;
    return;
  }

  // ── Menu request during checkout — redirect ────────────────────────
  if (MENU_RE.test(t)) {
    ctx.replyText =
      'Mau lihat menu lagi Kak? 🤍\n\n' +
      'Tapi pesanan sebelumnya masih ada. Kalau mau lanjut pesanan, ketik *OK*.\n' +
      'Kalau mau mulai ulang, ketik *cancel*.';
    ctx.handled = true;
    return;
  }
}

module.exports = { match, handler };
