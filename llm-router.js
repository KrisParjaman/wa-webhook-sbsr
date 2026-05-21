// ============================================================
// llmFirstRouter — LLM-first message handler for Sentuh Rasa
// Called before deterministic handlers. If LLM returns valid
// intent (confidence >= 0.6), its response is used.
// Otherwise falls through to existing deterministic logic.
// ============================================================

const LLM_FIRST_STATES = new Set([
  null, 'none', 'initial', '',  // new/empty state
  'awaiting_usecase', 'awaiting_product_selection', 'awaiting_addon_reply',
  'awaiting_delivery_method', 'awaiting_name', 'awaiting_address',
  'awaiting_pin_confirmation', 'awaiting_pickup_time', 'awaiting_invoice_confirm',
  'awaiting_proof', 'awaiting_addon_selection',
]);

function buildLlmContext(from, text, draft) {
  const state = draft?.state || 'initial';
  const cart = draft?.cart || [];
  const customerName = draft?.customer_name || '';
  const usecase = draft?.usecase || '';

  let ctx = 'Kamu adalah Mintu, CS ramah dari Sentuh Rasa (risoles frozen & goreng).\n';
  ctx += 'Tugasmu membantu customer memesan risol dengan natural.\n\n';
  ctx += 'STATUS PESANAN SAAT INI:\n';
  ctx += '- State: ' + state + '\n';
  ctx += '- Nama: ' + (customerName || '(belum ada)') + '\n';
  ctx += '- Use case: ' + (usecase || '(belum dipilih)') + '\n';
  ctx += '- Cart: ' + (cart.length ? JSON.stringify(cart) : '(kosong)') + '\n';
  ctx += '\nRESPON FORMAT JSON:\n';
  ctx += '{\n';
  ctx += '  "intent": "greeting|order_product|add_addon|choose_delivery|provide_info|ask_question|confirm|unknown",\n';
  ctx += '  "response_text": "balasan natural dalam Bahasa Indonesia",\n';
  ctx += '  "extracted_data": {},\n';
  ctx += '  "state_transition": null,\n';
  ctx += '  "confidence": 0.0 - 1.0\n';
  ctx += '}\n\n';
  ctx += 'Pesan customer: ' + text;
  return ctx;
}

async function llmFirstRouter(from, text, draft) {
  const state = (draft?.state || '').toLowerCase();

  // Only handle our known states
  if (!LLM_FIRST_STATES.has(state) && !LLM_FIRST_STATES.has(draft?.state)) return null;

  // Skip short confirmation words
  if (/^(ok|ya|sudah|lanjut|iya|done|siap|yes|no|enggak|ga|gak)$/i.test(text.trim())) return null;

  try {
    const ctx = buildLlmContext(from, text, draft);
    console.log('[llm-router] sending to LLM state=' + state);
    const result = await sendToOpenClaw(from, ctx);
    if (!result) {
      console.log('[llm-router] no result from LLM');
      return null;
    }

    let parsed;
    try {
      const cleaned = result.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.log('[llm-router] JSON parse failed: ' + e.message);
      return null;
    }

    if (!parsed || !parsed.intent || (parsed.confidence || 0) < 0.6) {
      console.log('[llm-router] low confidence: ' + (parsed?.confidence || 0));
      return null;
    }

    console.log('[llm-router] HANDLED intent=' + parsed.intent + ' conf=' + parsed.confidence);
    return parsed;
  } catch (err) {
    console.log('[llm-router] error: ' + err.message);
    return null;
  }
}

module.exports = { llmFirstRouter, buildLlmContext };
