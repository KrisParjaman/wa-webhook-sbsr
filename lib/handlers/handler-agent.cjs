// handler-agent.cjs — Agent handler (runs FIRST).
// Deterministic shortcuts for common intents, then LLM agent as fallback.

'use strict';

let _agentCore = null;
let _enabled = true;

function init(core) { _agentCore = core; }

const MENU_RE = /\b(?:menu|lihat\s*menu|mau\s*lihat|ada\s*apa\s*aja|daftar\s*harga|pricelist|katalog)\b/i;
const GREETING_RE = /^(?:hi|halo|hai|pagi|siang|sore|malam|assalam)\b/i;
const ORDER_RE = /\b(?:pesan|order|beli|mau\s+pesan|mau\s+order|mau\s+beli)\b/i;

function match(state, ctx) {
  if (!_enabled || !_agentCore) return false;
  const t = ctx.text.trim();
  if (!t || t.length < 2) return false;
  if (t.startsWith('/')) return false;
  return true;
}

async function handler(ctx) {
  const t = ctx.text.trim().toLowerCase();
  ctx.log('agent', 'text=' + t.slice(0, 50));

  // ── Deterministic shortcuts (no LLM needed) ──────────────────────

  // FAQ questions → get_faq tool directly
  if (/\b(?:halal|tahan\s*berapa|cara\s*goreng|pickup|minimum|order\s+minimal|reseller|pengiriman|air\s*fryer|cara\s+simpan)\b/i.test(t) && t.length < 50) {
    try {
      const tools = require('../agent/tools.cjs');
      const result = await tools.execute('get_faq', { query: t }, ctx);
      if (result.ok && result.result && result.result.found) {
        ctx.replyText = result.result.answer;
        ctx.handled = true;
        ctx.log('agent', 'faq_deterministic');
        return;
      }
    } catch (_) {}
  }

  // Product order → parse & add_to_cart directly (no LLM)
  const productRe = /(ayam\s*sayur|smoked\s*beef|ragout\s*creamy|mercon|chili\s*oil|ayam\s*pedas|original|creamy\s*chicken|mix)/i;
  const qtyRe = /(\d+)\s*pcs/i;
  const formRe = /(goreng|frozen|siap\s*makan|makan\s*langsung|mentah|stok)/i;

  if (productRe.test(t) && qtyRe.test(t)) {
    const variant = (t.match(productRe) || [])[1] || '';
    const qty = parseInt((t.match(qtyRe) || [])[1] || '6', 10);
    const formRaw = (t.match(formRe) || [])[1] || '';
    const form = /frozen|mentah|stok/i.test(formRaw) ? 'frozen' : 'goreng';

    // Count distinct products mentioned
    const products = t.match(new RegExp(productRe.source, 'gi')) || [];
    const qtys = t.match(new RegExp(qtyRe.source, 'gi')) || [];

    if (products.length === 1 && qtys.length === 1) {
      try {
        const tools = require('../agent/tools.cjs');
        const r = await tools.execute('add_to_cart', { variant, form, qty }, ctx);
        if (r.ok) {
          ctx.replyText = `Siap Kak! ${r.result.item?.name || variant} ${qty}pcs ${form} dicatat ya 🤍 Mau tambah apa lagi?`;
          ctx.handled = true;
          ctx.log('agent', 'add_to_cart_deterministic');
          return;
        }
      } catch (_) {}
    } else {
      // Multiple products — ask to specify one at a time
      ctx.replyText = `Mintu catat ya Kak: ${products.join(', ')}. Mau yang goreng (siap makan) atau frozen (stok rumah)? Dan berapa pcs masing-masing? 🤍`;
      ctx.handled = true;
      return;
    }
  }

  // Menu request → send menu immediately
  if (MENU_RE.test(t) && !ORDER_RE.test(t)) {
    try {
      const catalog = require('../catalog-manager.cjs');
      const menu = catalog.formatMenuText();
      ctx.replyText = menu;
      ctx.handled = true;
      ctx.log('agent', 'menu_sent_deterministic');
      return;
    } catch (_) {}
  }

  // Greeting → simple reply
  if (GREETING_RE.test(t) && t.length < 15 && !ORDER_RE.test(t)) {
    ctx.replyText = 'Halo Kak! Selamat datang di Sentuh Rasa — Risol Otentik! 🤍\n\nMintu siap bantu. Mau lihat menu, order langsung, atau tanya-tanya dulu?';
    ctx.handled = true;
    ctx.log('agent', 'greeting_deterministic');
    return;
  }

  // ── LLM Agent fallback (for complex messages) ────────────────────
  if (_agentCore) {
    try {
      await _agentCore.run(ctx);
    } catch (e) {
      ctx.log('agent', 'error: ' + e.message);
    }
  }

  // If agent didn't handle, let other pipeline handlers try
}

module.exports = { init, match, handler };
