// handler-use-case.cjs — Use case selection handler.
// State: awaiting_usecase
// Handles: customer choosing between 4 use cases:
//   1. Makan langsung (goreng)   2. Stock frozen (simpan di rumah)
//   3. Meeting/acara             4. Gift/hampers

'use strict';

const USECASE_INTENTS = [
  {
    id: 'makan-langsung',
    match: /\b(?:makan\s+langsung|makan\s+di\s+tempat|siap\s+makan|langsung\s+makan|goreng\s+aja|goreng\s+ya|goreng\s+kak)\b/i,
    reply: 'Kalau untuk makan langsung, Mintu rekomendasiin risoles goreng ya Kak 🤍\n\nPilihan favorit (bisa mix varian):\n• Ayam Sayur — 3pcs (29rb) / 6pcs (55rb) / 12pcs (105rb)\n• Smoked Beef Mayo — 3pcs (29rb) / 6pcs (55rb) / 12pcs (105rb)\n• Ragout Creamy — 3pcs (29rb) / 6pcs (55rb) / 12pcs (105rb)\n• Ayam Mercon Chili Oil 🔥 — 3pcs (33rb) / 6pcs (63rb) / 12pcs (120rb)\n• Ayam Sayur Pedas — 3pcs (29rb) / 6pcs (55rb) / 12pcs (105rb)\n• Mix Risol (bisa pilih varian) — 3pcs (29rb) / 6pcs (55rb) / 12pcs (105rb)\n\nBiasanya enak ditambah chili sauce pouch juga biar makin mantap 🌶️\nKalau mau, Kakak bisa langsung pilih varian / pack dari katalog ya.',
  },
  {
    id: 'stock-frozen',
    match: /\b(?:stock\s+frozen|stok\s+frozen|frozen\s+di\s+rumah|buat\s+stok|simpan\s+di\s+rumah|buat\s+freezer)\b/i,
    reply: 'buat stock frozen di rumah, mintu rekomen 1 pack masing2 varian biar bisa coba semua rasa untuk keluarga ya kak 😊\n\nPilihan varian frozen (6pcs/pack):\n• Ayam Sayur Frozen — 55rb\n• Smoked Beef Mayo Frozen — 55rb\n• Ragout Creamy Frozen — 55rb\n• Ayam Mercon Chili Oil Frozen 🔥 — 63rb\n• Ayam Sayur Pedas Frozen — 55rb\n• Mix Risol Frozen — 6pcs (55rb) / 12pcs (96rb)\n\n🍜 biar makin hemat, 1 paket frozen (6 varian @6pcs) cukup buat 1-2 minggu ke depan!\n\nmau pilih varian apa aja nih kak?',
  },
  {
    id: 'meeting-acara',
    match: /\b(?:meeting|acara|kantor|rapat|gathering|event)\b/i,
    reply: 'buat acara/meeting, mintu rekomen paket 2 box isi 12 + 4 minuman ya kak 😊\n\nmau lanjut dengan paket ini?',
  },
  {
    id: 'gift-hampers',
    match: /\b(?:gift|hampers|hadiah|parcel|kado)\b/i,
    reply: 'buat gift/hampers, mintu rekomen goreng atau frozen mix varian biar penerima bisa coba semua rasa ya kak 😊\n\nmau pilih varian apa aja nih kak?',
  },
];

const VARIANT_NAME_RE = /\b(?:ayam\s*sayur|smoked\s*beef|ragout\s*creamy|mercon|chili\s*oil|pedas|original|creamy\s*chicken|mix)\b/i;
const FORM_SIZE_RE = /\b(?:frozen|goreng|6\s*pcs|12\s*pcs|6pcs|12pcs)\b/i;

/**
 * Match: state is awaiting_usecase.
 */
function match(state, ctx) {
  return state === 'awaiting_usecase';
}

/**
 * Handle: parse use case choice, transition to next state.
 */
async function handler(ctx) {
  const t = ctx.text.trim();
  ctx.log('use-case-v2', 'text=' + t.slice(0, 60));

  // ── Numeric shortcuts (1, 2, 3, 4) ────────────────────────────────
  if (/^[1234][.)\s]?/.test(t) || /^(?:makan langsung|stock frozen dirumah|meeting(?:\/acara)?(?:\s+kak)?|gift\/?hampers?)$/i.test(t)) {
    let intent;
    if (/^1|makan langsung/i.test(t)) intent = USECASE_INTENTS[0];
    else if (/^2|stock|stok/i.test(t)) intent = USECASE_INTENTS[1];
    else if (/^3|meeting|acara/i.test(t)) intent = USECASE_INTENTS[2];
    else if (/^4|gift|hampers/i.test(t)) intent = USECASE_INTENTS[3];

    if (intent) {
      const id = intent.id;
      const nextState = id === 'meeting-acara' ? 'awaiting_meeting_package_confirm' : 'awaiting_product_selection';
      ctx.updateDraft({ use_case: id, state: nextState });
      ctx.saveDraft();
      ctx.log('use-case-v2', 'selected=' + id + ' next_state=' + nextState);
      ctx.replyText = intent.reply;
      ctx.handled = true;
      return;
    }
  }

  // ── Product name inference ─────────────────────────────────────────
  // Customer types "frozen", "goreng", "6pcs" instead of 1/2/3/4
  if (FORM_SIZE_RE.test(t)) {
    // Guard: if mentioning variant names, they're ORDERING, not selecting use-case
    if (VARIANT_NAME_RE.test(t)) {
      ctx.log('use-case-v2', 'product_name_inference=SKIPPED (variant_name_detected)');
      // Transition to product selection — let LLM handle the order
      ctx.updateDraft({ state: 'awaiting_product_selection', use_case: null });
      ctx.saveDraft();
      ctx.log('use-case-v2', 'transitioned to awaiting_product_selection');
      // Let product handler deal with it
      return; // not handled — fall through
    }

    const hasFrozen = /\bfrozen\b/i.test(t);
    const intent = hasFrozen ? USECASE_INTENTS[1] : USECASE_INTENTS[0];
    ctx.log('use-case-v2', 'product_name_inference=' + intent.id);
    ctx.updateDraft({ use_case: intent.id, state: 'awaiting_product_selection' });
    ctx.saveDraft();
    ctx.replyText = intent.reply;
    ctx.handled = true;
    return;
  }

  // ── Regex matching for natural language ────────────────────────────
  for (const intent of USECASE_INTENTS) {
    if (intent.match.test(t)) {
      const nextState = intent.id === 'meeting-acara' ? 'awaiting_meeting_package_confirm' : 'awaiting_product_selection';
      ctx.updateDraft({ use_case: intent.id, state: nextState });
      ctx.saveDraft();
      ctx.log('use-case-v2', 'matched=' + intent.id);
      ctx.replyText = intent.reply;
      ctx.handled = true;
      return;
    }
  }

  // ── No match — let next handler try ────────────────────────────────
}

module.exports = { match, handler };
