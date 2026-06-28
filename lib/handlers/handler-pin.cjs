// handler-pin.cjs — Pin/address confirmation handler.
// State: awaiting_address_pin_confirm, awaiting_pin_confirmation.
// Customer confirms whether to use typed address or Maps pin.

'use strict';

function match(state, ctx) {
  return state === 'awaiting_address_pin_confirm' || state === 'awaiting_pin_confirmation';
}

async function handler(ctx) {
  const t = ctx.text.trim().toLowerCase();
  ctx.log('pin-v2', 'state=' + ctx.state + ' text=' + t.slice(0, 50));

  // ── Cancel escape hatch ────────────────────────────────────────────
  const cancelRe = /\b(?:cancel|batal|ga\s*jadi|gak\s*jadi|nggak\s*jadi|tidak\s+jadi|batalin)\b/i;
  const restartRe = /\b(?:reset|mulai\s*(?:lagi|ulang|dari\s*awal)|ulangi|start\s*over)\b/i;
  const isOpt2 = /^(?:2|2[\).\s]|kirim ulang|ulang|pakai pin|pin maps|pin)\b/i.test(t);

  if ((cancelRe.test(t) || restartRe.test(t)) && !isOpt2) {
    ctx.log('pin-v2', 'cancel_escape');
    ctx.updateDraft({ state: 'initial', items: [], addons: [], customer_name: '', address_text: '' });
    ctx.saveDraft();
    ctx.replyText =
      'Siap Kak, Mintu batalkan dulu ya 🤍\n\n' +
      'Mau mulai lagi? Ketik *MENU* untuk lihat katalog atau pilih:\n' +
      '1. Kirimkan menu/pricelist\n2. Mau langsung order\n3. Mau tanya-tanya';
    ctx.handled = true;
    return;
  }

  // ── Option 1: Use typed address ────────────────────────────────────
  if (/^(?:1|1[\).\s]|pakai alamat|alamat|alamat tertulis)\b/i.test(t)) {
    const draft = ctx.draft;
    const addrText = draft.pending_address_text || draft.address_text || '';
    const confirm = draft.address_pin_confirm || {};
    ctx.updateDraft({
      address_text: addrText,
      destination: { ...(draft.destination || {}), address_text: addrText, lat: confirm.typed_lat, lng: confirm.typed_lng },
      state: 'awaiting_courier_choice',
    });
    ctx.saveDraft();
    ctx.log('pin-v2', 'opt1=typed_address');
    // Let server.js fire quote calculation
    return; // not handled — delegate to server.js for quote
  }

  // ── Option 2: Use Maps pin ─────────────────────────────────────────
  if (/^(?:2|2[\).\s]|kirim ulang|pakai pin|pin maps|pin|kirim ulang titik maps)\b/i.test(t)) {
    ctx.log('pin-v2', 'opt2=use_pin — delegating to server.js');
    return; // server.js handles pin-based geocoding
  }

  // ── Option 3: Re-send both ─────────────────────────────────────────
  if (/^(?:3|3[\).\s]|kirim ulang|ulang|keduanya)\b/i.test(t)) {
    ctx.replyText = 'Mintu kirim ulang ya Kak 🤍 Coba dicek lagi~';
    ctx.handled = true;
    return;
  }

  // ── Re-prompt ──────────────────────────────────────────────────────
  ctx.replyText = 'Kak, pilih ya:\n*1.* Pakai alamat tertulis\n*2.* Pakai titik Maps\n*3.* Kirim ulang keduanya';
  ctx.handled = true;
}

module.exports = { match, handler };
