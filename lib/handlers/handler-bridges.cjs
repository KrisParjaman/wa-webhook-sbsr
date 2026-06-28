// handler-bridges.cjs — IG / PO / Saldo peripheral bridge handlers.
// These are specialized sub-flows triggered by /admin or specific text patterns.
// Each is simple: match pattern → reply acknowledgment → server.js handles actual spawn.

'use strict';

const IG_APPROVAL_RE = /\b(?:ig|instagram)\s*(?:approve|ok|confirm|acc)\b/i;
const PO_APPROVAL_RE = /\b(?:po|purchase\s*order)\s*(?:approve|ok|confirm|acc)\b/i;
const PO_CREATE_RE = /\b(?:buat\s*po|create\s*po|po\s*baru)\b/i;
const SALDO_RE = /\b(?:saldo|balance|cek\s*saldo)\b/i;
const IG_TOPIC_RE = /\b(?:ig\s*topic|instagram\s*topic|topik\s*ig)\b/i;
const IG_POST_RE = /\b(?:ig\s*post|post\s*ig|posting\s*ig|instagram\s*post)\b/i;

function match(state, ctx) {
  const t = ctx.text.trim().toLowerCase();
  if (IG_APPROVAL_RE.test(t)) return true;
  if (PO_APPROVAL_RE.test(t)) return true;
  if (PO_CREATE_RE.test(t)) return true;
  if (SALDO_RE.test(t)) return true;
  if (IG_TOPIC_RE.test(t)) return true;
  if (IG_POST_RE.test(t)) return true;
  return false;
}

async function handler(ctx) {
  const t = ctx.text.trim().toLowerCase();
  ctx.log('bridges-v2', 'text=' + t.slice(0, 50));

  if (IG_APPROVAL_RE.test(t)) {
    ctx.replyText = 'Siap Kak, IG approval diterima. Admin akan proses sebentar lagi ya 🤍';
    ctx.log('bridges-v2', 'ig_approval');
    ctx.handled = true; return;
  }
  if (PO_APPROVAL_RE.test(t)) {
    ctx.replyText = 'Siap Kak, PO approval diterima. Admin akan proses sebentar lagi ya 🤍';
    ctx.log('bridges-v2', 'po_approval');
    ctx.handled = true; return;
  }
  if (PO_CREATE_RE.test(t)) {
    ctx.replyText = 'Siap Kak, PO baru akan dibuatkan. Admin akan follow-up ya 🤍';
    ctx.log('bridges-v2', 'po_create');
    ctx.handled = true; return;
  }
  if (SALDO_RE.test(t)) {
    ctx.replyText = 'Mintu cek saldo dulu ya Kak, tunggu sebentar 🤍';
    ctx.log('bridges-v2', 'saldo_check');
    ctx.handled = true; return;
  }
  if (IG_TOPIC_RE.test(t) || IG_POST_RE.test(t)) {
    ctx.replyText = 'Siap Kak, untuk posting IG — Mintu sambungkan ke tim admin ya 🤍';
    ctx.log('bridges-v2', 'ig_topic_or_post');
    ctx.handled = true; return;
  }
}

module.exports = { match, handler };
