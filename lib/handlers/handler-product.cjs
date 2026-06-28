// handler-product.cjs — Catalog request + product selection entry.
// Handles: customer asking for catalog/menu, simple product selection.
// Complex LLM-based variant matching stays in server.js for now.

'use strict';

const CATALOG_RE = /(?:\b(?:menu|pricelist|katalog|catalog|order|pesen|pesan|lihat)(?:nya|ku|mu|kah)?\b|\bno\s*\.?\s*1\b|\bnomor\s*1\b|\b(?:mana|bisa|tolong|minta)\s+(?:menu|pricelist|katalog|lihat)(?:nya)?\b|\bkirim(?:kan)?\s+(?:menu|pricelist|katalog)(?:nya)?\b|\blangsung\s+order\b|\bmau\s+lihat(?:nya)?\b|\bada\s+(?:menu|varian|pilihan)(?:nya)?\s*apa\b|\btunjukin\b|\btunjukkan\b|\bboleh\s+lihat(?:nya)?\b)/i;

const PRODUCT_KEYWORDS = /\b(?:frozen|goreng|mix|ayam|smoked|ragout|mayo|creamy|mercon|pedas|original|risol)\b/i;

/**
 * Match: catalog requests, or state is awaiting_product_selection.
 */
function match(state, ctx) {
  const t = ctx.text.trim().toLowerCase();
  if (CATALOG_RE.test(t)) return true;
  if (state === 'awaiting_product_selection' && t.length > 3) return true;
  return false;
}

/**
 * Handle: send catalog or route to product selection.
 */
async function handler(ctx) {
  const t = ctx.text.trim().toLowerCase();
  const state = ctx.state;
  ctx.log('product-v2', 'state=' + (state || '?') + ' text=' + t.slice(0, 60));

  // ── Catalog request ────────────────────────────────────────────────
  if (CATALOG_RE.test(t) && !PRODUCT_KEYWORDS.test(t)) {
    ctx.updateDraft({ state: 'main_menu' });
    ctx.saveDraft();
    ctx.replyText =
      '📋 *Sentuh Rasa — Menu*\n\n' +
      '*RISOLES GORENG (Makan Langsung)*\n' +
      '• Ayam Sayur — 3pcs 29k / 6pcs 55k / 12pcs 105k\n' +
      '• Smoked Beef Mayo — 3pcs 29k / 6pcs 55k / 12pcs 105k\n' +
      '• Ragout Creamy — 3pcs 29k / 6pcs 55k / 12pcs 105k\n' +
      '• Ayam Mercon Chili Oil 🔥 — 3pcs 33k / 6pcs 63k / 12pcs 120k\n' +
      '• Ayam Sayur Pedas — 3pcs 29k / 6pcs 55k / 12pcs 105k\n' +
      '• Mix Risol — 3pcs 29k / 6pcs 55k / 12pcs 105k\n\n' +
      '*RISOLES FROZEN (Stock — 6pcs/pack)*\n' +
      '• Ayam Sayur Frozen — 55k\n' +
      '• Smoked Beef Frozen — 55k\n' +
      '• Ragout Creamy Frozen — 55k\n' +
      '• Ayam Mercon Chili Oil Frozen 🔥 — 63k\n' +
      '• Ayam Sayur Pedas Frozen — 55k\n' +
      '• Mix Frozen — 55k\n\n' +
      '*ADD-ON*\n' +
      '• Chili Sauce 50ml — 4k\n' +
      '• Thermal Bag (Reguler) — 8k\n' +
      '• Ice Gel — 3k\n' +
      '• Mika Bag — 15k\n' +
      '• Greeting Card — 3k\n\n' +
      'Ketik langsung produk yang Kakak mau ya 🤍';
    ctx.handled = true;
    return;
  }

  // ── Product selection state ────────────────────────────────────────
  if (state === 'awaiting_product_selection') {
    // Has product keywords — likely an order
    if (PRODUCT_KEYWORDS.test(t)) {
      ctx.updateDraft({ state: 'awaiting_product_selection' });
      ctx.saveDraft();
      // Return not handled — let next handler (LLM/text-variant) process the order
      ctx.log('product-v2', 'delegating to LLM/legacy handler');
      return;
    }
    // Question-like — let FAQ handle it
  }
}

module.exports = { match, handler };
