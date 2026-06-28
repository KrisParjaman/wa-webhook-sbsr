// handler-maps.cjs — Google Maps URL handler.
// Detects bare maps.google.com / maps.app.goo.gl links sent by customer.
// Stores URL in draft, lets server.js handle geocoding + quote.

'use strict';

const MAPS_URL_RE = /^https?:\/\/.*(?:google\.com\/maps|maps\.google|goo\.gl\/maps|maps\.app\.goo\.gl)/i;

function match(state, ctx) {
  const t = ctx.text.trim();
  // Bare maps URL — only match if short (just the URL, no other text)
  if (MAPS_URL_RE.test(t) && t.length <= 200) return true;
  // Also match awaiting_address with a maps link in the message
  if ((state === 'awaiting_address' || state === 'awaiting_location') && MAPS_URL_RE.test(t)) return true;
  return false;
}

async function handler(ctx) {
  const t = ctx.text.trim();
  ctx.log('maps-v2', 'detected=' + t.slice(0, 80));

  // Store maps URL
  ctx.updateDraft({
    gmaps_link: t,
    pending_gmaps_link: t,
    pending_gmaps_link_at: new Date().toISOString(),
  });
  ctx.saveDraft();

  // If we have name + address too, let server.js fire quote
  if (ctx.customerName && ctx.draft.address_text) {
    ctx.log('maps-v2', 'all pieces ready — delegating to server.js');
    return; // server.js handles address-and-quote
  }

  // Need more info
  if (!ctx.customerName) {
    ctx.replyText = 'Mintu terima titik lokasinya ya Kak 🤍 Sekarang boleh info atas nama siapa?';
  } else {
    ctx.replyText = 'Mintu terima titik lokasinya ya Kak 🤍 Sekarang kirim alamat lengkapnya ya.';
  }
  ctx.handled = true;
}

module.exports = { match, handler };
