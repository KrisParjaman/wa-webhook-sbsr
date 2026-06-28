// llm-classifier.cjs — LLM intent classifier for Sentuh Rasa.
// Sends user message + draft context to LLM, gets back intent + confidence.
// Three paths based on confidence: high→execute, medium→clarify, low→fallthrough.

'use strict';

// ── Constants ──────────────────────────────────────────────────────
const CLASSIFIER_TIMEOUT_MS = 15000;
const CLASSIFIER_VALID_INTENTS = new Set([
  'greeting', 'request_menu', 'place_order', 'cancel_order',
  'confirm', 'deny', 'provide_name', 'provide_address',
  'provide_location', 'choose_option', 'ask_question',
  'add_more', 'change_order', 'general_chat', 'reset', 'unknown',
]);
const CLASSIFIER_SKIP_RE = /^(?:ok|oke|okay|ya|iya|tidak|gak|nggak|no|yes|sip|siap|deal|lanjut|sudah|1|2|3|4|\d+)\s*$/i;
const CLASSIFIER_MAPS_SKIP_RE = /^https?:\/\/.*(?:google\.com\/maps|maps\.google|goo\.gl\/maps|maps\.app\.goo\.gl)/i;
const CLASSIFIER_MAX_CLARIFY = 3;

// ── Injected ──────────────────────────────────────────────────────
let _log, _sendToOpenClaw, _loadDraft, _saveDraft;

function init(opts) {
  _log = opts.log || (() => {});
  _sendToOpenClaw = opts.sendToOpenClaw || (async () => '');
  _loadDraft = opts.loadDraft || (() => ({}));
  _saveDraft = opts.saveDraft || (() => {});
}

// ── Prompt builders ────────────────────────────────────────────────

function buildClassifierPrompt(from, userText, draft, bridgeContext) {
  const state = String(draft?.state || 'none').trim().toLowerCase();
  const customerName = String(draft?.customer_name || '');
  const useCase = String(draft?.use_case || '');
  const deliveryMode = String(draft?.delivery_mode || '');
  const items = Array.isArray(draft?.items) ? draft.items : [];
  const cartSummary = items.length > 0
    ? items.map(it => (it.qty || 1) + 'x ' + (it.name || '?') + ' (' + (it.form || '?') + ')').join(', ')
    : '(kosong)';

  let prompt = [
    'Kamu adalah classifier intent untuk bot WhatsApp Sentuh Rasa — Risoles Otentik.',
    'Tugasmu: KLASIFIKASI intent customer ke salah satu kategori di bawah.',
    '',
    '=== KONTEKS ===',
    'State: ' + state,
    'Nama customer: ' + (customerName || '(belum diisi)'),
    'Use case: ' + (useCase || '(belum dipilih)'),
    'Delivery: ' + (deliveryMode || '(belum dipilih)'),
    'Isi cart: ' + cartSummary,
    'Pending items: ' + JSON.stringify(draft?.pending_items || []),
  ];

  if (bridgeContext) prompt.push('Bridge context: ' + bridgeContext.slice(0, 400));

  prompt.push(
    '',
    '=== KATEGORI INTENT ===',
    'greeting — customer menyapa (halo, hai, pagi, dll)',
    'request_menu — customer minta menu/katalog/pricelist',
    'place_order — customer mau pesan (sebut produk spesifik, qty, varian)',
    'cancel_order — customer mau cancel/batal',
    'confirm — customer konfirmasi (ok, ya, lanjut, setuju)',
    'deny — customer menolak (tidak, gak, nggak)',
    'provide_name — customer kasih nama',
    'provide_address — customer kasih alamat',
    'provide_location — customer share lokasi/pin/maps',
    'choose_option — customer pilih opsi (1, 2, paxel, gojek, dll)',
    'ask_question — customer tanya (FAQ, info produk, dll)',
    'add_more — customer mau nambah pesanan',
    'change_order — customer mau ubah pesanan',
    'general_chat — obrolan santai (bukan order)',
    'reset — customer mau mulai ulang',
    'unknown — gak jelas intentnya',
    '',
    '=== ATURAN ===',
    '- Kalau state=awaiting_usecase: prefer place_order kalau customer sebut produk',
    '- Kalau state=awaiting_invoice_confirm: prefer confirm (customer mau bayar)',
    '- Kalau ada pending_items: prefer confirm/deny (customer konfirmasi pesanan)',
    '- JANGAN classify sebagai greeting kalau customer sebut produk spesifik',
    '',
    'OUTPUT: HANYA JSON, tanpa markdown:',
    '{"intent": "...", "confidence": "high|medium|low", "reasoning": "..."}',
    '',
    'Pesan customer: ' + userText
  );

  return prompt.join('\n');
}

// ── Reply generator ────────────────────────────────────────────────

async function generateClassifierReply(from, userText, intent, draft) {
  const state = String(draft?.state || 'none').trim().toLowerCase();
  const customerName = String(draft?.customer_name || '');
  const useCase = String(draft?.use_case || '');
  const deliveryMode = String(draft?.delivery_mode || '');
  const items = Array.isArray(draft?.items) ? draft.items : [];
  const cartSummary = items.length > 0
    ? items.map(it => (it.qty || 1) + 'x ' + (it.name || '?') + ' (' + (it.form || '?') + ')').join(', ')
    : '(kosong)';

  const prompt = [
    'Kamu adalah Mintu, CS ramah dari Sentuh Rasa — Risoles Otentik.',
    'Tugasmu: balas customer dengan NATURAL, WARM, dan HELPFUL. Bukan template/robot.',
    '',
    '=== KONTEKS ===',
    'State: ' + state,
    'Intent customer (dari classifier): ' + intent,
    'Nama customer: ' + (customerName || '(belum diisi)'),
    'Use case: ' + (useCase || '(belum dipilih)'),
    'Delivery: ' + (deliveryMode || '(belum dipilih)'),
    'Isi cart: ' + cartSummary,
    'Pending items: ' + JSON.stringify(draft?.pending_items || []),
    '',
    '=== ATURAN PENTING ===',
    '- JANGAN hitung total/cart/kalkulasi — sistem yang handle.',
    '- JANGAN sebut kata "intent", "classifier", "state", "sistem".',
    '- Kalau state=awaiting_usecase: tanya customer mau makan langsung / frozen / meeting / gift.',
    '- Kalau state=awaiting_product_selection: bantu customer pilih varian dari katalog.',
    '- Kalau state=awaiting_name: minta nama penerima.',
    '- Kalau state=awaiting_address: minta alamat lengkap.',
    '- Kalau state=awaiting_delivery_method: suruh pilih delivery / pickup.',
    '- Kalau customer sebut produk spesifik: acknowledge dan bantu pilih form (goreng/frozen).',
    '- Kalau ada pending_items: SEBUTKAN itemnya dan TANYA apakah sudah benar.',
    '- Keep it short & natural (2-4 kalimat), akhiri dengan emoji 🤍',
    '',
    'Pesan customer: ' + userText,
  ].join('\n');

  try {
    const raw = await _sendToOpenClaw('reply-' + Date.now() + '-' + from, prompt);
    const cleaned = (raw || '').replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    return String(cleaned || '').slice(0, 2000);
  } catch (_) {
    return null;
  }
}

// ── Classify intent ────────────────────────────────────────────────

async function classifyIntent(from, userText, draft, bridgeContext) {
  const state = String(draft?.state || '').trim().toLowerCase();

  // Skip classifier for short confirmation words
  if (CLASSIFIER_SKIP_RE.test(String(userText || '').trim())) {
    return null;
  }
  // Skip maps URLs
  if (CLASSIFIER_MAPS_SKIP_RE.test(String(userText || '').trim())) {
    return null;
  }

  const prompt = buildClassifierPrompt(from, userText, draft, bridgeContext);

  try {
    const raw = await _sendToOpenClaw('intent-' + Date.now() + '-' + from, prompt);
    const cleaned = (raw || '').replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

    let parsed;
    try { parsed = JSON.parse(cleaned); } catch (_) { return null; }

    if (!parsed || !parsed.intent || !CLASSIFIER_VALID_INTENTS.has(parsed.intent)) {
      return null;
    }

    const conf = String(parsed.confidence || '').toLowerCase();
    if (!['high', 'medium', 'low'].includes(conf)) {
      return { ...parsed, confidence: 'low' };
    }

    return parsed;
  } catch (_) {
    return null;
  }
}

// ── Clarify count ──────────────────────────────────────────────────

function getClarifyCount(draft) { return Number(draft?._clarify_count) || 0; }

function resetClarifyCount(from) {
  const d = _loadDraft(from) || {};
  if (d._clarify_count) _saveDraft(from, { ...d, _clarify_count: 0 });
}

function incrementClarifyCount(from) {
  const d = _loadDraft(from) || {};
  const n = getClarifyCount(d) + 1;
  _saveDraft(from, { ...d, _clarify_count: n });
  return n;
}

module.exports = {
  init,
  CLASSIFIER_TIMEOUT_MS, CLASSIFIER_VALID_INTENTS, CLASSIFIER_SKIP_RE,
  CLASSIFIER_MAPS_SKIP_RE, CLASSIFIER_MAX_CLARIFY,
  buildClassifierPrompt, generateClassifierReply,
  classifyIntentWithLLM: classifyIntent,
  getClarifyCount, resetClarifyCount, incrementClarifyCount,
  llmFirstRouter: async function(from, text, draft) { return classifyIntent(from, text, draft, null); },
};
