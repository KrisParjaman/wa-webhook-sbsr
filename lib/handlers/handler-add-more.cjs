// handler-add-more.cjs — Global add-more handler.
// Detects "nambah", "tambah", "tambah pesanan" intents from any active checkout state.

'use strict';

const ADD_MORE_RE = /^(?:nambah|tambah|mau\s+tambah|tambah\s+pesanan|tambah\s+menu|tambah\s+lagi|add\s+more|menu\s+lagi|lihat\s+menu\s+lagi|pesan\s+lagi|mau\s+nambah)\b/i;
const CONFIRM_YES = /^(?:1|ya|iya|ok|oke|lanjut)\b/i;
const CONFIRM_NO = /^(?:2|tidak|gak|ga|nggak|no|lanjut\s+pembayaran)\b/i;

function match(state, ctx) {
  if (!ctx.cart.length) return false;
  const t = ctx.text.trim().toLowerCase();
  if (ADD_MORE_RE.test(t)) return true;
  if (state === 'awaiting_add_more_confirm') return true;
  return false;
}

async function handler(ctx) {
  const t = ctx.text.trim().toLowerCase();
  const state = ctx.state;
  ctx.log('add-more-v2', 'state=' + (state || '?') + ' text=' + t.slice(0, 50));

  // ── Add-more intent ────────────────────────────────────────────────
  if (ADD_MORE_RE.test(t)) {
    ctx.updateDraft({ state: 'awaiting_add_more_confirm' });
    ctx.saveDraft();
    ctx.replyText =
      'Kak, pesanan sebelumnya masih ada nih 🤍\n\n' +
      'Mau:\n*1.* Tambah pesanan (cart sekarang tetap disimpan)\n*2.* Lanjut ke pembayaran\n\n' +
      'Balas *1* atau *2* ya Kak~';
    ctx.handled = true;
    return;
  }

  // ── Add-more confirmation ──────────────────────────────────────────
  if (state === 'awaiting_add_more_confirm') {
    if (CONFIRM_YES.test(t)) {
      ctx.updateDraft({ state: 'awaiting_product_selection', add_more_mode: true });
      ctx.saveDraft();
      ctx.replyText = 'Siap Kak, Mintu buka menu lagi ya. Pesanan sebelumnya tetap disimpan 🤍';
      ctx.handled = true;
      return;
    }
    if (CONFIRM_NO.test(t)) {
      // Restore previous state — go to delivery
      ctx.updateDraft({ state: 'awaiting_delivery_method' });
      ctx.saveDraft();
      ctx.replyText = 'Siap Kak, lanjut ke pengiriman ya 🤍\n\nMau dikirim (delivery) atau ambil sendiri (pickup)?';
      ctx.handled = true;
      return;
    }
    ctx.replyText = 'Balas *1* (tambah pesanan) atau *2* (lanjut pembayaran) ya Kak 🤍';
    ctx.handled = true;
    return;
  }
}

module.exports = { match, handler };
