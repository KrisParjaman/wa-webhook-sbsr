// handler-faq.cjs — FAQ matcher.
// Deterministic regex patterns for common questions. No LLM needed.
// Runs early in the pipeline — cheaper than LLM, instant reply.
//
// FAQ disabled during these states (customer is entering info):
//   awaiting_name, awaiting_location, awaiting_address, awaiting_invoice_confirm

'use strict';

const FAQ_DISABLED_STATES = new Set([
  'awaiting_name', 'awaiting_location', 'awaiting_address', 'awaiting_invoice_confirm',
]);

const FAQ_INTENTS = [
  {
    id: 'halal',
    match: /\bhalal\b|\bsertifikasi\s+halal\b/i,
    reply: 'Untuk sertifikasi halal, Sentuh Rasa saat ini sedang dalam proses ya Kak 🤍',
  },
  {
    id: 'tahan-berapa-lama',
    match: /\b(?:tahan|awet|expired?|kadaluarsa|kadaluwarsa|umur\s+simpan|shelf\s*life|simpan\s+berapa|tahan\s+berapa|berapa\s+hari|(?:bisa|aman)\s+dimakan\s+\d+\s*hari|freezer|chiller|kulkas)\b/i,
    reply: 'Untuk frozen Sentuh Rasa Kak:\n• Suhu ruang: 2–3 jam\n• Chiller (kulkas bawah): 1–2 hari, lalu langsung digoreng\n• Freezer: 1–2 bulan tergantung kondisi freezer\n\nKalau sudah digoreng, paling enak langsung disantap ya 🤍',
  },
  {
    id: 'cara-goreng',
    match: /\b(?:cara\s+goreng|goreng(?:nya)?\s+gimana|masak(?:nya)?\s+gimana|menggoreng|langsung\s+goreng)\b/i,
    reply: 'Cara goreng frozen Sentuh Rasa ya Kak:\n1. Keluarkan dari freezer, tidak perlu di-thaw sampai lembek.\n2. Panaskan minyak sampai benar-benar panas.\n3. Goreng dengan api sedang sampai golden brown.\n4. Tiriskan sebentar sebelum disajikan.\n\nKalau dari chiller, bisa langsung digoreng ya 🤍',
  },
  {
    id: 'pickup',
    match: /\b(?:pickup|pick\s*up|ambil\s+sendiri|mampir|datang\s+langsung|ambil\s+di\s+toko)\b/i,
    reply: 'Bisa pickup di:\nJl Nusa Indah Raya blok O no 10, Cipinang Muara, Kec Jatinegara\nGoogle Maps: https://share.google/ykWkdLTDJgG2UVfOQ\nCP: +62 811 1321 166\n\nKalau mau pickup, disarankan chat/PO dulu ya Kak biar pesanannya siap dan nggak kehabisan 🤍',
  },
  {
    id: 'reseller',
    match: /\b(?:reseller|agen|jualan\s+lagi|titip\s+jual|harga\s+reseller)\b/i,
    reply: 'Untuk reseller ya Kak:\n• 4 pack: Rp 47.000 / pack\n• 6 pack: Rp 46.000 / pack\n• 10 pack: Rp 45.000 / pack\n\nKalau mau lanjut reseller, boleh info estimasi kebutuhannya ya 🤍',
  },
  {
    id: 'minimum-order',
    match: /\b(?:minimum|minimal|min)\s*(?:order|pembelian|beli|pesan)|order\s+minimal/i,
    reply: 'Minimum order Sentuh Rasa Rp 50.000 ya Kak 🤍',
  },
  {
    id: 'pengiriman',
    match: /\b(?:pengiriman|dikirim|kirimnya|delivery|diantar|antar)\b/i,
    reply: 'Pengiriman Sentuh Rasa berangkat dari Cipinang ya Kak 🤍\nBoleh kirim alamat lengkap + share titik lokasi Maps atau Share Location WhatsApp, nanti Mintu bantu cek ongkir dan estimasinya.',
  },
  {
    id: 'air-fryer',
    match: /\b(?:air\s*fryer|airfryer)\b/i,
    reply: 'Bisa digoreng pakai air fryer juga ya Kak 🤍\nTinggal sesuaikan waktu dan suhu dengan alat masing-masing sampai warnanya golden brown.',
  },
  {
    id: 'cara-simpan',
    match: /\b(?:cara\s+simpan|simpan(?:nya)?\s+gimana|penyimpanan|simpan\s+frozen|taruh\s+di\s+freezer|masuk\s+kulkas)\b/i,
    reply: 'Untuk frozen Sentuh Rasa Kak:\n• Suhu ruang: 2–3 jam\n• Chiller (kulkas bawah): 1–2 hari, lalu langsung digoreng\n• Freezer: 1–2 bulan tergantung kondisi freezer 🤍',
  },
];

/**
 * Match: text contains FAQ-like questions AND state is not FAQ-disabled.
 */
function match(state, ctx) {
  if (FAQ_DISABLED_STATES.has(state)) return false;
  const t = ctx.text.trim().toLowerCase();
  if (!t || t.length < 3) return false;
  for (const faq of FAQ_INTENTS) {
    if (faq.match.test(t)) return true;
  }
  return false;
}

/**
 * Handle: find matching FAQ, reply with pre-written answer.
 */
async function handler(ctx) {
  const t = ctx.text.trim().toLowerCase();
  for (const faq of FAQ_INTENTS) {
    if (faq.match.test(t)) {
      ctx.log('faq-v2', 'hit=' + faq.id);
      ctx.replyText = faq.reply;
      ctx.handled = true;
      return;
    }
  }
  // No match — shouldn't happen since match() already checked
}

module.exports = { match, handler };
