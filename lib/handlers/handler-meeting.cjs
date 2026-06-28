// handler-meeting.cjs — Meeting package confirmation handler.
// State: awaiting_meeting_package_confirm

'use strict';

const YES_RE = /^(?:ya|y|ok|oke|okay|okey|lanjut|boleh|mau|gas|deal|setuju|siap)(?:[\s,.]+(?:ya|ok|oke|lanjut|boleh|mau|gas|deal|setuju|siap|kak|aja|deh|nih))*\s*[.!,?]*\s*$/i;
const NO_RE = /^(?:tidak|gak|ga|nggak|engga|batal|jangan|belum|nanti|ubah|ganti)(?:[\s,.]+(?:dulu|kak|aja|deh|nih))*\s*[.!,?]*\s*$/i;

const PACKAGE_ITEMS = [
  { sku: 'PKG-MEETING-2X12', name: 'Paket Meeting — 2 box isi 12', qty: 1, unit_price: 192000, form: 'goreng', pack_size: 12 },
  { sku: 'PKG-MEETING-DRINK', name: 'Paket Minuman Meeting', qty: 4, unit_price: 15000, form: null, pack_size: null },
];

function match(state, ctx) {
  return state === 'awaiting_meeting_package_confirm';
}

async function handler(ctx) {
  const t = ctx.text.trim();
  ctx.log('meeting-v2', 'text=' + t.slice(0, 40));

  if (YES_RE.test(t)) {
    const subtotal = PACKAGE_ITEMS.reduce((s, it) => s + it.unit_price * it.qty, 0);
    ctx.updateDraft({
      use_case: 'meeting_acara',
      items: PACKAGE_ITEMS,
      subtotal,
      state: 'awaiting_addon_reply',
      meeting_package_confirmed_at: new Date().toISOString(),
    });
    ctx.saveDraft();
    ctx.log('meeting-v2', 'package_confirmed subtotal=' + subtotal);
    ctx.replyText =
      'Siap! Paket meeting 2 box isi 12 + 4 minuman udah dicatat ya Kak 🤍\n\n' +
      'Total sementara: Rp ' + subtotal.toLocaleString('id-ID') + '\n\n' +
      'Mau tambah add-on? Balas:\n• *chili sauce* — Rp 4.000/pouch\n• *thermal bag* — Rp 8.000-30.000\n' +
      '• *ice gel* — Rp 3.000\n• *lanjut* — kalau udah cukup';
    ctx.handled = true;
    return;
  }

  if (NO_RE.test(t)) {
    ctx.replyText = 'Siap Kak, kalau mau ubah kebutuhan boleh pilih use-case lagi atau pilih produk dari katalog ya 🤍';
    ctx.handled = true;
    return;
  }

  // Re-prompt
  ctx.replyText = 'Kalau setuju paket meeting, balas *ya/ok/lanjut/boleh/mau* ya Kak 🤍';
  ctx.handled = true;
}

module.exports = { match, handler };
