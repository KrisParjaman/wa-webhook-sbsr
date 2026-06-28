// handler-wa-location.cjs — WhatsApp native location share handler.
// Triggered by msg.type === 'location'. Extracts lat/lng, stores in draft.

'use strict';

function match(state, ctx) {
  return ctx.type === 'location';
}

async function handler(ctx) {
  const loc = ctx.rawMsg?.location;
  if (!loc) return;
  const lat = Number(loc.latitude);
  const lng = Number(loc.longitude);
  if (!isFinite(lat) || !isFinite(lng)) return;

  ctx.log('wa-loc-v2', 'lat=' + lat + ' lng=' + lng);

  // If has cart but no delivery mode yet — prompt delivery method first
  if (ctx.cart.length > 0 && !ctx.deliveryMode) {
    ctx.updateDraft({ state: 'awaiting_delivery_method' });
    ctx.saveDraft();
    ctx.replyText = 'Mintu terima lokasinya Kak! 🤍\n\nMau dikirim (delivery) atau ambil sendiri (pickup)?';
    ctx.handled = true;
    return;
  }

  // Store location in destination
  const locName = String(loc.name || '').trim();
  const locAddr = String(loc.address || '').trim();
  const addressText = ctx.draft.address_text || locAddr || locName || '(dari lokasi WA)';

  ctx.updateDraft({
    destination: {
      ...(ctx.draft.destination || {}),
      lat, lng,
      source: 'wa_location',
      address_text: addressText,
    },
    pending_gmaps_link: null,
    pending_address_text: addressText,
    address_text: addressText,
  });
  ctx.saveDraft();
  ctx.replyText = 'Mintu terima lokasinya ya Kak! 🤍 Sekarang kirim alamat lengkap + nama penerima ya.';
  ctx.handled = true;
}

module.exports = { match, handler };
