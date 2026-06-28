// handler-ooc.cjs — Out-of-context detection + smart reply.
// When customer sends an unrelated question/greeting during checkout,
// this handler intercepts and provides a helpful response.
//
// Two tiers:
//   Tier 1 (critical): awaiting_proof, awaiting_manual_payment_review,
//                      pending_finance, admin_handoff → escalate to admin
//   Tier 2 (non-critical): other checkout states → smart LLM reply or
//                          gentle redirect back to checkout flow

'use strict';

const OOC_STATES = new Set([
  'main_menu', 'welcome',
  'awaiting_usecase', 'awaiting_product_selection',
  'awaiting_addon_reply', 'awaiting_delivery_method',
  'awaiting_name', 'awaiting_address', 'awaiting_location',
  'awaiting_courier_choice', 'awaiting_address_pin_confirm',
  'awaiting_invoice_confirm', 'awaiting_proof',
  'awaiting_manual_payment_review', 'admin_handoff',
]);

const CRITICAL_STATES = new Set([
  'awaiting_proof', 'awaiting_manual_payment_review',
  'pending_finance', 'admin_handoff',
]);

const NON_CRITICAL_CHECKOUT_STATES = new Set([
  'awaiting_addon_reply', 'awaiting_delivery_method',
  'awaiting_name', 'awaiting_address', 'awaiting_location',
  'awaiting_courier_choice', 'awaiting_address_pin_confirm',
  'awaiting_invoice_confirm',
]);

const ADMIN_TRIGGER_RE = /\b(admin|cs|customer service|finance|orang|hubungkan|sambungkan|tolong)\b/i;

/**
 * Match: state is in OOC set AND text is non-empty.
 */
function match(state, ctx) {
  if (!OOC_STATES.has(state)) return false;
  const t = ctx.text.trim();
  return t.length > 0;
}

/**
 * Handle: detect intent type, reply appropriately.
 */
async function handler(ctx) {
  const state = ctx.state;
  const t = ctx.text.trim();
  ctx.log('ooc-v2', 'state=' + state + ' text=' + t.slice(0, 60));

  const hasAdminTrigger = ADMIN_TRIGGER_RE.test(t);

  // ── Tier 2: Non-critical states — detect OOC, use LLM ────────────
  if (NON_CRITICAL_CHECKOUT_STATES.has(state) && !hasAdminTrigger) {
    const isQuestion = /^(?:kenapa|bagaimana|apa|siapa|kapan|dimana|mengapa|bisa|apakah|kalo|kalau|ada|berapa|bagus|rekomendasi|rekomend|info|tanya)/i.test(t)
      || (t.includes('?') && t.length >= 10);
    const isGreeting = /^(?:hi|halo|hai|pagi|siang|sore|malam|permisi|maaf)/i.test(t);
    const isUnrelated = t.length > 15
      && !/\b(?:alamat|ongkir|pickup|ambil|harga|menu|order|pesan|bayar|add.?on|chili|sauce|thermal|ice|gel|lanjut|cukup|gak|tidak|nggak|iya|ya|oke|ok|gas|boleh|mau|nama|saya|aku|kirim|antar|gojek|grab|jne|jnt|sicepat|paxel)/i.test(t);
    const isRandomTopic = /\b(cuaca|makanan|enak|recommend|rekomend|tempat|wisata|film|musik|game|politik|berita|kabar|lucu|komedi|sehat|sakit|kerja|sekolah|hobi)/i.test(t);

    if (isQuestion || isGreeting || (isUnrelated && isRandomTopic)) {
      ctx.log('ooc-v2', 'detected_out_of_context');

      // Smart OOC: try LLM first
      let oocOk = false;
      try {
        const oocPrompt =
          'Kamu Mintu, CS Sentuh Rasa - Risoles Otentik.\n' +
          'Jawab BAHASA INDONESIA natural dan INFORMATIF.\n' +
          'Customer sedang di tahap: ' + state + '.\n' +
          'PERTANYAAN CUSTOMER:\n' + t;

        const oocR = await ctx.askLLM(oocPrompt, 'ooc');
        if (oocR && String(oocR).trim().length > 5
          && !/^(boleh|tolong|mohon|silahkan|kirim)\s+(kirim|isi|infokan|masukkan|share)\s*(alamat|pin|lokasi|nama)/i.test(oocR)) {
          ctx.replyText = String(oocR).trim();
          oocOk = true;

          // Auto-notify admin if LLM indicated handoff
          if (/(?:teruskan|sambungkan|hubungkan|forward|eskalasi|admin\s+kami)\s*(?:ke|sama|dengan)?\s*admin|admin\s*(?:akan|bakal|nanti|segera|lagi)\s*(?:bantu|cek|tinjau|review|proses|tindaklanjut)/i.test(oocR)) {
            const name = ctx.customerName || '?';
            ctx.notifyAdmin(
              '🚨 *LLM ADMIN HANDOFF (smart_ooc)*\nCustomer: ' + name + ' (+' + ctx.from + ')\nState: ' + state + '\nLLM reply: "' + String(oocR).slice(0, 200) + '"',
              'sbsr-llm-admin-handoff'
            );
          }
        }
      } catch (_) {
        ctx.log('ooc-v2', 'smart_ooc_err: ' + (_.message || '?'));
      }

      if (!oocOk) {
        ctx.replyText =
          'Maaf Kak, Mintu kurang paham pertanyaannya 🤍\n\n' +
          'Kalo Kakak mau tanya-tanya soal Sentuh Rasa, ketik *3* (Mau tanya-tanya) dari menu utama.\n' +
          'Kalo mau lanjutin pesanan, tinggal balas sesuai yang Mintu tanyain sebelumnya aja ya 🤍';
      }
      ctx.handled = true;
      return;
    }

    // Not clearly OOC — let other handlers try
    return;
  }

  // ── Critical state or admin trigger — escalate ────────────────────
  if (CRITICAL_STATES.has(state) || hasAdminTrigger) {
    const name = ctx.customerName || '?';
    const cartSummary = buildCartSummary(ctx);
    ctx.notifyAdmin(
      '🚨 *Out-of-context guard*\nCustomer: ' + name + ' (+' + ctx.from + ')\nState: ' + state + '\nLast text: "' + t.slice(0, 200) + '"\nCart: ' + cartSummary,
      'sbsr-admin-handoff'
    );
    ctx.log('ooc-v2', 'escalated_to_admin');
    ctx.replyText = 'Mintu sambungkan ke admin ya Kak, biar dicek lebih lanjut 🤍';
    ctx.handled = true;
    return;
  }

  // Non-critical, non-checkout state with no admin trigger — let other handlers try
}

function buildCartSummary(ctx) {
  const items = ctx.cart;
  if (!items.length) return '(empty)';
  return items.slice(0, 6).map(it => (it.name || 'item') + ' x' + (Number(it.qty) || 0)).join(', ');
}

module.exports = { match, handler };
