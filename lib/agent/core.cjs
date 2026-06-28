// core.cjs — Single-brain agent loop.
// Flow: understand (LLM) → tools (deterministic) → reply (LLM).
// One brain, one state. LLM never touches money/state directly.

'use strict';

const promptBuilder = require('./prompt.cjs');
const toolRegistry = require('./tools.cjs');

// ── Injected services ──────────────────────────────────────────────
let _sendToLLM, _sendReply, _log, _loadDraft, _saveDraft, _catalogRef;

function init(opts) {
  _sendToLLM = opts.sendToLLM;
  _sendReply = opts.sendReply;
  _log = opts.log || (() => {});
  _loadDraft = opts.loadDraft;
  _saveDraft = opts.saveDraft;
  _catalogRef = opts.catalogRef;
}

// ── Agent loop ─────────────────────────────────────────────────────

async function run(ctx) {
  const MAX_TOOL_ROUNDS = 3;
  let toolRounds = 0;

  while (toolRounds < MAX_TOOL_ROUNDS) {
    // Build prompt with current state
    ctx._catalogSnapshot = _catalogRef ? _catalogRef() : {};
    const prompt = promptBuilder.build(ctx);
    const fullPrompt = prompt + '\nCustomer: ' + ctx.text;

    _log('agent', 'round=' + toolRounds + ' state=' + ctx.state);

    // Call LLM
    let llmResponse;
    try {
      llmResponse = await _sendToLLM('agent-' + Date.now(), fullPrompt);
      if (!llmResponse) throw new Error('no response');
    } catch (e) {
      _log('agent', 'LLM error: ' + e.message);
      ctx.replyText = 'Maaf Kak, Mintu lagi mikir sebentar ya 🤍 Coba kirim ulang pesannya.';
      ctx.handled = true;
      return ctx;
    }

    // Parse response for tool calls
    const { toolCalls, replyText } = parseResponse(llmResponse);
    _log('agent', 'tools=' + toolCalls.length + ' reply=' + (replyText ? replyText.slice(0, 50) : 'none'));

    // Execute tools
    if (toolCalls.length > 0) {
      for (const call of toolCalls) {
        const result = await toolRegistry.execute(call.tool, call.args, ctx);
        _log('agent', 'tool=' + call.tool + ' ok=' + result.ok);
        if (call.tool === 'send_menu' && result.ok && result.result && result.result.menu) {
          // send_menu result goes directly as reply
          replyText = result.result.menu;
        }
        if (!result.ok) {
          _log('agent', 'tool error: ' + result.error);
        }
      }
      toolRounds++;
      // After tool execution, loop back with updated state (don't reply yet)
      if (!replyText) continue;
    }

    // Send reply
    if (replyText) {
      ctx.replyText = replyText;
      ctx.handled = true;
      return ctx;
    }

    toolRounds++;
  }

  // Max rounds reached — force reply
  ctx.replyText = 'Maaf Kak, Mintu agak bingung nih 🤍 Bisa diulangi pesannya?';
  ctx.handled = true;
  return ctx;
}

// ── Response parser ─────────────────────────────────────────────────

function parseResponse(text) {
  const toolCalls = [];
  let replyText = text || '';

  const KNOWN_TOOLS = ['add_to_cart','set_form','remove_from_cart','clear_cart','set_customer_name','set_address','set_delivery','confirm_order','cancel_order','get_faq','get_catalog','add_addon','send_menu'];

  // Extract ```tool ... ``` blocks
  const toolRe = /```tool\s*\n([\s\S]*?)```/g;
  let m;
  while ((m = toolRe.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(m[1].trim());
      if (parsed.tool && parsed.args && KNOWN_TOOLS.includes(parsed.tool)) {
        toolCalls.push({ tool: parsed.tool, args: parsed.args });
      }
    } catch (_) {}
  }

  // Remove tool blocks from reply text
  replyText = replyText.replace(/```tool[\s\S]*?```/g, '').trim();

  // Also try inline JSON (for models that don't use code blocks) - but only KNOWN tools
  if (toolCalls.length === 0) {
    const jsonRe = /\{"tool"\s*:\s*"[^"]+"\s*,\s*"args"\s*:\s*\{[^}]+\}\}/g;
    while ((m = jsonRe.exec(text)) !== null) {
      try {
        const parsed = JSON.parse(m[0]);
        if (parsed.tool && parsed.args && KNOWN_TOOLS.includes(parsed.tool)) {
          toolCalls.push({ tool: parsed.tool, args: parsed.args });
          replyText = replyText.replace(m[0], '').trim();
        }
      } catch (_) {}
    }
  }

  return { toolCalls, replyText: replyText || null };
}

module.exports = { init, run };
