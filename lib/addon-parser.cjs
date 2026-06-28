// addon-parser.cjs — extracted from server.js
// Addon parsing & merging logic for Sentuh Rasa WhatsApp Bridge.
// All functions are pure/deterministic — no I/O, no dependency injection.

'use strict';

const SBSR_ADDON_ACTIVE_STATES = new Set([
  "awaiting_addon", "awaiting_addon_reply", "awaiting_addon_signature_clarify",
  "addon_offer", "upsell_pending",
]);

const SBSR_ADDON_DECLINE_RE = /^(?:lanjut|cukup|no|nggak|ngga|gak|ga|skip|tidak|engga|enggak|g\s*a\s*k\s+u\s*s\s*a\s*h|gak\s+usah|ga\s+usah)(?:[\s,.]+(?:aja|ya|kak|kakak|deh|nih|dulu))?\s*[.!?,]*\s*$/i;

function isNormalizedAddonDecline(text) {
  const raw = String(text || "")
    .toLowerCase()
    .trim()
    .replace(/[.!?,]+$/g, "")
    .replace(/\s+/g, " ");
  if (!raw) return false;
  return /^(?:ga ada|gak ada|nggak ada|tidak ada|ga|gak|nggak|tidak|no|nope|skip|cukup|lanjut|udah|sudah|enough)$/.test(raw);
}

const SBSR_ADDON_SELECTIONS = [
  { sku: 'ADD-CHILI',    name: 'Homemade Signature Chili Sauce — 50ml pouch', unit_price: 4000,  match: /\b(?:chili(?:\s*sauce)?|chilli(?:\s*sauce)?|sauce|saus(?:\s+sambal|\s+chili)?|sambal|pouch(?:es)?|signature\s+chili(?:\s+sauce)?|signature\s+chilli(?:\s+sauce)?|signature\s+sauce)\b/i },
  { sku: 'ADD-THERMAL',  name: 'Thermal Bag Premium',                         unit_price: 30000, match: /\bthermal\s*(?:bag\s*)?(?:premium|30k)\b/i },
  { sku: 'ADD-THERMAL-REGULER',  name: 'Thermal Bag Reguler (max 3 pack)',  unit_price: 8000,  match: /\bthermal\s*(?:bag\s*)?(?:reguler|biasa|kecil|8k)\b/i },
  { sku: 'ADD-ICE-GEL',  name: 'Ice Gel',                                     unit_price: 3000,  match: /\bice\s*gel\b|\bcold\s*pack\b/i },
  { sku: 'ADD-ICE-TEA',  name: 'Iced Java Tea — 250ml',                       unit_price: 15000, match: /\b(?:java|ice\s*tea|java\s*tea|es\s*teh)\b/i },
  { sku: 'ADD-MATCHA',   name: 'Iced Matcha — 250ml',                         unit_price: 15000, match: /\bmatcha\b/i },
  { sku: 'ADD-MIKA-BAG', name: 'Mika Bag',                                    unit_price: 15000, match: /\b(?:mika\s*bag|mikabag|mika)\b/i },
  { sku: 'ADD-GREETING', name: 'Greeting Card (Printed)',                     unit_price: 3000,  match: /\bgreeting\s*card\b|\bkartu\s*ucapan\b/i },
];

function isAddonStateActive(state) {
  const s = String(state || "").trim().toLowerCase();
  return SBSR_ADDON_ACTIVE_STATES.has(s) || /(?:^|_)(addon|upsell)(?:$|_)/.test(s);
}

function extractAddonReplySelections(text) {
  const raw = String(text || "").trim();
  if (!raw) return [];
  const hits = [];
  // Extract quantity prefix pattern: "2 chili" or "chili 2" or "2x chili"
  for (const addon of SBSR_ADDON_SELECTIONS) {
    if (addon.match.test(raw)) {
      let qty = 1;
      const beforeQty = raw.match(new RegExp('(\\d+)\\s*x?\\s*' + addon.match.source.replace(/\^|\$/g, '').replace(/\\b/g, '').trim(), 'i'));
      const afterQty = raw.match(new RegExp(addon.match.source.replace(/\^|\$/g, '').replace(/\\b/g, '').trim() + '\\s*x?\\s*(\\d+)', 'i'));
      if (beforeQty) qty = Math.max(1, parseInt(beforeQty[1], 10) || 1);
      else if (afterQty) qty = Math.max(1, parseInt(afterQty[1], 10) || 1);
      hits.push({ ...addon, qty });
    }
  }
  return hits;
}

function mergeAddonItems(existingItems, existingAddons, addonSelections) {
  const merged = Array.isArray(existingItems) ? existingItems.map(it => ({ ...it })) : [];
  const addons = Array.isArray(existingAddons) ? existingAddons.map(it => ({ ...it })) : [];
  for (const addon of addonSelections) {
    const addonIdx = addons.findIndex(it => it && it.sku === addon.sku);
    if (addonIdx >= 0) {
      const prevAddonQty = Number(addons[addonIdx].qty) || 0;
      addons[addonIdx] = {
        ...addons[addonIdx],
        qty: prevAddonQty + addon.qty,
        unit_price: Number(addons[addonIdx].unit_price) || addon.unit_price,
        line_total: (prevAddonQty + addon.qty) * (Number(addons[addonIdx].unit_price) || addon.unit_price),
      };
    } else {
      addons.push({
        sku: addon.sku,
        name: addon.name,
        qty: addon.qty,
        unit_price: addon.unit_price,
        line_total: addon.unit_price * addon.qty,
      });
    }
    const idx = merged.findIndex(it => it && it.sku === addon.sku);
    if (idx >= 0) {
      const prevQty = Number(merged[idx].qty) || 0;
      merged[idx] = {
        ...merged[idx],
        qty: prevQty + addon.qty,
        unit_price: Number(merged[idx].unit_price) || addon.unit_price,
      };
    } else {
      merged.push({
        sku: addon.sku,
        name: addon.name,
        qty: addon.qty,
        unit_price: addon.unit_price,
        form: null,
        pack_size: null,
      });
    }
  }
  return {
    items: merged,
    addons,
    subtotal: merged.reduce((sum, it) => sum + ((Number(it.unit_price) || 0) * (Number(it.qty) || 0)), 0),
  };
}

module.exports = {
  SBSR_ADDON_ACTIVE_STATES,
  SBSR_ADDON_DECLINE_RE,
  SBSR_ADDON_SELECTIONS,
  isNormalizedAddonDecline,
  isAddonStateActive,
  extractAddonReplySelections,
  mergeAddonItems,
};
