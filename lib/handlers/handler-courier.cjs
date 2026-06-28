// handler-courier.cjs — Courier choice handler (frozen flow).
// State: awaiting_courier_choice
// Customer picks "1" (paxel) or "2" (gojek/go-send).
// Complex quote resolution stays in server.js.

'use strict';

function match(state, ctx) {
  return state === 'awaiting_courier_choice';
}

async function handler(ctx) {
  const t = ctx.text.trim();
  ctx.log('courier-v2', 'text=' + t.slice(0, 50));

  const draft = ctx.draft;
  const options = draft.quote_options;
  if (!Array.isArray(options) || options.length < 2) {
    // No quote options loaded — let server.js handle
    ctx.log('courier-v2', 'no quote_options — delegating');
    return;
  }

  // Parse choice using clause-aware parser from lib
  let chosenIndex = null;
  let chosenCourier = null;
  try {
    const { parseCourierChoice } = require('../courier-choice-parser.cjs');
    const result = parseCourierChoice(t);
    if (result.kind === 'index') chosenIndex = result.value;
    if (result.kind === 'courier') chosenCourier = result.value;
  } catch (_) {
    // Fallback: basic regex
    const nm = t.match(/^(?:pilih(?:an)?\s*)?([12])\b/);
    if (nm) chosenIndex = Number(nm[1]);
    if (!chosenIndex) {
      if (/\b(paxel)\b/.test(t)) chosenCourier = 'paxel';
      else if (/\b(gosend|gojek|gojeg)\b/.test(t)) chosenCourier = 'gojek';
    }
  }

  // ── Ambiguous — re-prompt ──────────────────────────────────────────
  if (!chosenIndex && !chosenCourier) {
    const lines = ['Belum pasti ya Kak — pilih salah satu:', ''];
    options.forEach((o, i) => {
      const eta = o.eta_text ? ' · ETA ' + o.eta_text : '';
      lines.push((i + 1) + '. ' + o.courier_label + ' — Rp ' + Number(o.ongkir).toLocaleString('id-ID') + eta);
    });
    lines.push('');
    lines.push('Balas *1* atau *2* ya 🤍');
    ctx.replyText = lines.join('\n');
    ctx.handled = true;
    return;
  }

  // ── Resolve choice ─────────────────────────────────────────────────
  let chosen;
  if (chosenIndex) chosen = options[chosenIndex - 1];
  else chosen = options.find(o => o.courier === chosenCourier);

  if (!chosen) {
    ctx.log('courier-v2', 'couldnt resolve choice — delegating');
    return; // server.js fallback
  }

  ctx.log('courier-v2', 'chose=' + chosen.courier + ' ongkir=' + chosen.ongkir);
  ctx.updateDraft({
    customer_preference: chosen.courier,
    courier: chosen.courier,
    courier_label: chosen.courier_label,
    ongkir: chosen.ongkir,
    state: 'awaiting_name', // or wherever the flow goes next
  });
  ctx.saveDraft();

  ctx.replyText =
    'Siap Kak! Pilih *' + chosen.courier_label + '* — Rp ' + Number(chosen.ongkir).toLocaleString('id-ID') + ' 🤍\n\n' +
    'Sekarang Mintu butuh data pengiriman:\n' +
    'Boleh info *atas nama siapa* + *alamat lengkap* ya Kak?';
  ctx.handled = true;
}

module.exports = { match, handler };
