// handler-ongkir.cjs — Ongkir check + destination check handler.
// Detects "cek ongkir", "ongkir berapa?", "biaya kirim" intents.

'use strict';

const ONGKIR_HINT_RE = /\b(?:ongkir|ongkos\s*kirim|tarif\s*kirim|biaya\s*kirim|biaya\s*antar|harga\s*kirim|cek\s*ongkir|estimasi|berapa\s*ongkir|paxel|gojek|gosend|grab|lalamove|sicepat|jne|jnt)\b/i;
const ONGKIR_QUESTION_RE = /\b(?:berapa|cek|liat|tahu|info|mau\s*tanya|coba)\b/i;

function match(state, ctx) {
  if (!ctx.cart.length) return false;
  const t = ctx.text.trim().toLowerCase();
  // Must have both ongkir keyword AND question intent
  if (!ONGKIR_HINT_RE.test(t)) return false;
  if (!ONGKIR_QUESTION_RE.test(t)) return false;
  // Checks states to avoid interfering with active flows
  const lockStates = new Set(['awaiting_proof', 'pending_finance', 'approved', 'BOOKED', 'booked', 'delivered', 'cancelled']);
  if (lockStates.has(state)) return false;
  return true;
}

async function handler(ctx) {
  ctx.log('ongkir-v2', 'text=' + ctx.text.trim().slice(0, 60));

  const hasFrozen = ctx.cart.some(it => it.form === 'frozen');
  if (hasFrozen) {
    ctx.replyText = 'Pesanan ada item *frozen*, jadi pengiriman wajib pakai *Paxel cold-chain* ya Kak 🤍\n\nOngkir Paxel-nya udah Mintu cek di invoice yang tadi. Lanjut bayar atau ada yang mau diubah Kak?';
    ctx.handled = true;
    return;
  }

  // No destination yet — can't quote
  if (!ctx.draft.destination || (!ctx.draft.destination.lat && !ctx.draft.destination.postal_code)) {
    ctx.replyText = 'Mintu belum punya alamat lengkapnya nih Kak 🤍\n\nKirim alamat lengkap + share titik lokasi dulu ya, biar Mintu bisa cek ongkirnya.';
    ctx.handled = true;
    return;
  }

  // Has destination — let server.js handle quote comparison
  ctx.log('ongkir-v2', 'has destination — delegating to server.js');
  return; // server.js handles actual quote calculation
}

module.exports = { match, handler };
