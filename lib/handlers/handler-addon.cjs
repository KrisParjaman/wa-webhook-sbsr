// handler-addon.cjs — Addon reply handler.
// States: awaiting_addon_reply, awaiting_addon_signature_clarify, addon_offer, upsell_pending.
// Uses extracted lib/addon-parser.cjs for matching + merging.

'use strict';

const { isAddonStateActive, extractAddonReplySelections, mergeAddonItems, SBSR_ADDON_DECLINE_RE, isNormalizedAddonDecline } = require('../addon-parser.cjs');

function match(state, ctx) {
  if (!ctx.cart.length) return false;
  return isAddonStateActive(state);
}

async function handler(ctx) {
  const t = ctx.text.trim();
  const state = ctx.state;
  ctx.log('addon-v2', 'state=' + state + ' text=' + t.slice(0, 50));

  // ── Decline ─────────────────────────────────────────────────────────
  if (SBSR_ADDON_DECLINE_RE.test(t) || isNormalizedAddonDecline(t)) {
    ctx.updateDraft({ state: 'awaiting_delivery_method' });
    ctx.saveDraft();
    ctx.log('addon-v2', 'declined → awaiting_delivery_method');
    ctx.replyText = 'Siap Kak, langsung aja ya 🤍\n\nMau dikirim (delivery) atau ambil sendiri (pickup)?';
    ctx.handled = true;
    return;
  }

  // ── Signature clarification ────────────────────────────────────────
  if (state === 'awaiting_addon_signature_clarify') {
    if (/^(?:1|signature\s+chili\s+sauce|chili\s+sauce|signature\s+sauce|pouch)$/i.test(t)) {
      const forced = [{ sku: 'ADD-CHILI', name: 'Homemade Signature Chili Sauce — 50ml pouch', unit_price: 4000, qty: 1 }];
      const merged = mergeAddonItems(ctx.cart, ctx.draft.addons, forced);
      const subtotal = merged.subtotal;
      ctx.updateDraft({
        items: merged.items, addons: merged.addons, subtotal,
        state: 'awaiting_delivery_method',
        addon_selected_at: new Date().toISOString(),
      });
      ctx.saveDraft();
      ctx.log('addon-v2', 'signature=chili_sauce');
      ctx.replyText = 'Siap Kak, Mintu tambahin Homemade Signature Chili Sauce — 50ml pouch x1 ya 🤍\n\nSubtotal sementara jadi Rp ' + subtotal.toLocaleString('id-ID') + '.\n\nMau dikirim (delivery) atau ambil sendiri (pickup)?';
      ctx.handled = true;
      return;
    }
    if (/^(?:2|pilih\s+produk\s+dari\s+menu|menu|katalog)$/i.test(t)) {
      ctx.updateDraft({ add_more_mode: true, state: 'awaiting_product_selection' });
      ctx.saveDraft();
      ctx.replyText = 'Siap Kak, Mintu buka menu lagi ya. Pesanan yang sebelumnya tetap Mintu simpan, nanti totalnya Mintu gabungkan 🤍';
      // Catalog will be sent by server.js — signal handled
      ctx.handled = true;
      return;
    }
    ctx.replyText = 'Kak, maksudnya Signature Chili Sauce atau mau pilih varian produk Signature ya? 🤍\n\nBalas:\n1. Signature Chili Sauce\n2. Pilih produk dari menu';
    ctx.handled = true;
    return;
  }

  // ── Signature ambiguity ────────────────────────────────────────────
  if (state === 'awaiting_addon_reply' && t.toLowerCase().replace(/\s+/g, ' ') === 'signature') {
    ctx.updateDraft({ state: 'awaiting_addon_signature_clarify' });
    ctx.saveDraft();
    ctx.log('addon-v2', 'ambiguous_signature');
    ctx.replyText = 'Kak, maksudnya Signature Chili Sauce atau mau pilih varian produk Signature ya? 🤍\n\nBalas:\n1. Signature Chili Sauce\n2. Pilih produk dari menu';
    ctx.handled = true;
    return;
  }

  // ── Parse addon selections ──────────────────────────────────────────
  const selections = extractAddonReplySelections(t);
  if (selections.length > 0) {
    const merged = mergeAddonItems(ctx.cart, ctx.draft.addons, selections);
    ctx.updateDraft({
      items: merged.items, addons: merged.addons, subtotal: merged.subtotal,
      state: 'awaiting_delivery_method',
      addon_selected_at: new Date().toISOString(),
    });
    ctx.saveDraft();
    const names = selections.map(s => s.name).join(', ');
    ctx.log('addon-v2', 'selected=' + names);
    ctx.replyText = 'Siap Kak, Mintu tambahin ' + names + ' ya 🤍\n\nSubtotal sementara jadi Rp ' + merged.subtotal.toLocaleString('id-ID') + '.\n\nMau dikirim (delivery) atau ambil sendiri (pickup)?';
    ctx.handled = true;
    return;
  }

  // No match — allow fall through
}

module.exports = { match, handler };
