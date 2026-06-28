// draft-store.cjs — Customer draft persistence.
// Each customer has a JSON file on disk tracking their order state.
// All functions are synchronous (fs sync) for simplicity.

'use strict';

const fs = require('fs');
const path = require('path');

// ── Config ──────────────────────────────────────────────────────────
let _draftsDir = process.env.SBSR_DRAFTS_DIR || '/opt/sbsr/data/openclaw/.openclaw/workspace/drafts';

function init(opts = {}) {
  if (opts.draftsDir) _draftsDir = opts.draftsDir;
}

// ── Core CRUD ───────────────────────────────────────────────────────

function normalizePhone(phoneRaw) {
  return String(phoneRaw).replace(/[^0-9]/g, '').replace(/^62/, '0');
}

function draftPath(phoneRaw) {
  return path.join(_draftsDir, normalizePhone(phoneRaw) + '.json');
}

function load(phoneRaw) {
  try {
    const f = draftPath(phoneRaw);
    if (!fs.existsSync(f)) return null;
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) { return null; }
}

function save(phoneRaw, draft) {
  try {
    if (!fs.existsSync(_draftsDir)) fs.mkdirSync(_draftsDir, { recursive: true });
    const norm = normalizePhone(phoneRaw);
    fs.writeFileSync(
      path.join(_draftsDir, norm + '.json'),
      JSON.stringify({ ...draft, phone: norm, updated_at: new Date().toISOString() }, null, 2)
    );
  } catch (e) { /* fail silently */ }
}

// ── Bridge context ──────────────────────────────────────────────────

function setPendingBridgeContext(phoneRaw, contextBlock) {
  if (!contextBlock) return;
  const d = load(phoneRaw) || { phone: phoneRaw };
  save(phoneRaw, { ...d, pending_bridge_context: contextBlock });
}

function consumePendingBridgeContext(phoneRaw) {
  const d = load(phoneRaw);
  if (!d || !d.pending_bridge_context) return null;
  const ctx = d.pending_bridge_context;
  save(phoneRaw, { ...d, pending_bridge_context: null });
  return ctx;
}

// ── State checks ────────────────────────────────────────────────────

const CHECKOUT_COLLECTION_STATES = new Set([
  'awaiting_name', 'awaiting_addon', 'addon_offer', 'upsell_pending',
  'awaiting_delivery_method', 'awaiting_address_pin_confirm',
  'awaiting_address', 'awaiting_pin_confirm', 'awaiting_courier_choice',
  'awaiting_meeting_package_confirm', 'awaiting_location_retry',
]);

const CHECKOUT_LOCK_STATES = new Set([
  'awaiting_invoice_confirm', 'awaiting_proof', 'pending_finance',
  'approved', 'booked', 'delivered', 'cancelled',
  'awaiting_manual_payment_review', 'payment_verified_manual',
]);

function hasDestination(draft) {
  const dest = draft && draft.destination;
  if (!dest) return false;
  return (Number.isFinite(Number(dest.lat)) && Number.isFinite(Number(dest.lng)))
    || !!dest.postal_code;
}

function isCheckoutActive(draft) {
  if (!draft || !Array.isArray(draft.items) || draft.items.length === 0) return false;
  const s = String(draft.state || '').trim().toLowerCase();
  if (CHECKOUT_LOCK_STATES.has(s)) return false;
  if (CHECKOUT_COLLECTION_STATES.has(s)) return true;
  return !draft.invoice_sent_at;
}

module.exports = {
  init,
  normalizePhone,
  draftPath,
  load,
  save,
  setPendingBridgeContext,
  consumePendingBridgeContext,
  hasDestination,
  isCheckoutActive,
  CHECKOUT_COLLECTION_STATES,
  CHECKOUT_LOCK_STATES,
};
