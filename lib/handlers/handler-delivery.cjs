// handler-delivery.cjs — Delivery method + pickup flow handler.
// Handles two states:
//   awaiting_delivery_method → customer picks delivery (1) or pickup (2)
//   pickup flow              → shortcut for "ambil sendiri" intent from any state

'use strict';

const PICKUP_RE = /^(?:ambil\s*sendiri|pickup|pick\s*up|mampir)(?:[\s,.!?:-].*)?$/i;
const PICKUP_ADDRESS = 'Jl Nusa Indah Raya blok O no 10, Cipinang Muara, Kec Jatinegara';
const PICKUP_MAPS_URL = 'https://share.google/ykWkdLTDJgG2UVfOQ';
const PICKUP_CONTACT = 'Sentuh Rasa\n+62 811 1321 166';

/**
 * Match: delivery method selection state OR pickup intent with items in cart.
 */
function match(state, ctx) {
  if (state === 'awaiting_delivery_method') return true;
  // Pickup intent from any state (with cart)
  if (PICKUP_RE.test(ctx.text.trim()) && ctx.cart.length > 0) return true;
  return false;
}

/**
 * Handle: delivery method selection or pickup flow.
 */
async function handler(ctx) {
  const t = ctx.text.trim().toLowerCase();
  const state = ctx.state;
  ctx.log('delivery-v2', 'state=' + (state || '?') + ' text=' + t.slice(0, 50));

  // ── Pickup from any state (with cart) ──────────────────────────────
  if (PICKUP_RE.test(t) && ctx.cart.length > 0) {
    return _handlePickup(ctx);
  }

  // ── Delivery method selection ──────────────────────────────────────
  if (state === 'awaiting_delivery_method') {
    const deliveryRe = /^(?:1|delivery|dikirim|kirim|antar)\b/i;
    const pickupRe = /^(?:2|pickup|pick\s*up|ambil\s*sendiri|ambil|mampir)$/i;

    if (deliveryRe.test(t)) {
      ctx.updateDraft({
        delivery_mode: 'delivery',
        state: 'awaiting_name',
        delivery_mode_set_at: new Date().toISOString(),
      });
      ctx.saveDraft();
      ctx.log('delivery-v2', 'selected=delivery');
      ctx.replyText = 'Siap Kak 🤍 boleh info atas nama siapa Kak? Lalu kirim alamat lengkap pengiriman + share titik lokasi Maps juga ya 🤍';
      ctx.handled = true;
      return;
    }

    if (pickupRe.test(t)) {
      ctx.updateDraft({
        delivery_mode: 'pickup',
        delivery_mode_set_at: new Date().toISOString(),
      });
      ctx.saveDraft();
      ctx.log('delivery-v2', 'selected=pickup');
      return _handlePickup(ctx);
    }

    ctx.log('delivery-v2', 'unrecognized');
    return; // not handled — fall through
  }
}

function _handlePickup(ctx) {
  ctx.log('delivery-v2', 'pickup_flow');
  ctx.replyText =
    '📦 *PICKUP SENTUH RASA*\n\n' +
    '📍 ' + PICKUP_ADDRESS + '\n' +
    '🗺️ Maps: ' + PICKUP_MAPS_URL + '\n' +
    '📞 CP: ' + PICKUP_CONTACT + '\n\n' +
    'Mau Mintu bantu siapkan pesanannya dulu? Balas *OK* ya Kak 🤍';
  ctx.handled = true;
}

module.exports = { match, handler };
