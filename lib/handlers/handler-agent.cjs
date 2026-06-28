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
