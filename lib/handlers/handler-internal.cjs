// handler-internal.cjs — Internal/admin/kitchen flow handlers.
// Handles: order confirm, admin commands, admin handoff, kitchen ready notifications.
// These are admin-only or system-internal flows.

'use strict';

const ORDER_CONFIRM_RE = /^(?:ya|iya|ok|oke|lanjut|gas|deal|setuju|siap|confirm)\b/i;
const ORDER_CANCEL_RE = /^(?:cancel|batal|tidak|gak|nggak|no|ga\s+jadi)\b/i;
const KITCHEN_READY_RE = /\b(?:siap\s+diambil|ready\s+pickup|udah\s+siap|dah\s+siap|pesanan\s+siap)\b/i;
const DELIVERY_CONFIRM_RE = /\b(?:sudah\s+dikirim|udah\s+dikirim|dah\s+jalan|dah\s+berangkat|dah\s+dikirim|paket\s+sudah\s+dikirim)\b/i;

function match(state, ctx) {
  // Order confirmation state
  if (state === 'awaiting_order_confirm') return true;
  // Kitchen ready
  if (KITCHEN_READY_RE.test(ctx.text)) return true;
  // Delivery confirm
  if (DELIVERY_CONFIRM_RE.test(ctx.text)) return true;
  return false;
}

async function handler(ctx) {
  const t = ctx.text.trim().toLowerCase();
  const state = ctx.state;
  ctx.log('internal-v2', 'state=' + (state || '?') + ' text=' + t.slice(0, 50));

  // ── Order confirmation ──────────────────────────────────────────────
  if (state === 'awaiting_order_confirm') {
    if (ORDER_CONFIRM_RE.test(t)) {
      ctx.updateDraft({ state: 'awaiting_delivery_method' });
      ctx.saveDraft();
      ctx.log('internal-v2', 'order_confirmed');
      ctx.replyText = 'Siap Kak, pesanan dikonfirmasi! 🤍\n\nMau dikirim (delivery) atau ambil sendiri (pickup)?';
      ctx.handled = true;
      return;
    }
    if (ORDER_CANCEL_RE.test(t)) {
      ctx.updateDraft({ state: 'initial', items: [], addons: [] });
      ctx.saveDraft();
      ctx.log('internal-v2', 'order_cancelled');
      ctx.replyText = 'Siap Kak, pesanan dibatalkan 🤍\n\nKetik *menu* kalau mau lihat katalog lagi.';
      ctx.handled = true;
      return;
    }
    ctx.replyText = 'Kak, jadi lanjut pesan? Balas *ya/ok/lanjut* ya 🤍';
    ctx.handled = true;
    return;
  }

  // ── Kitchen ready ───────────────────────────────────────────────────
  if (KITCHEN_READY_RE.test(t)) {
    ctx.replyText = 'Mantap! Pesanan siap diambil ya Kak 🤍\n\n📍 Jl Nusa Indah Raya blok O no 10, Cipinang Muara\n📞 +62 811 1321 166';
    ctx.handled = true;
    return;
  }

  // ── Delivery confirm ────────────────────────────────────────────────
  if (DELIVERY_CONFIRM_RE.test(t)) {
    ctx.replyText = 'Siap Kak, terima kasih infonya! Pesanan dalam perjalanan ya 🤍';
    ctx.handled = true;
    return;
  }
}

module.exports = { match, handler };
