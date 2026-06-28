// state-manager.cjs — Checkout state machine + session management.
// Handles: state validation, reset, cancel, restart intents.
// Depends on draftStore for persistence (injected via init).

'use strict';

// ── State sets ─────────────────────────────────────────────────────
const TRANSIENT_RESET_STATES = new Set([
  'awaiting_name', 'awaiting_addon_reply', 'awaiting_usecase',
  'awaiting_product_selection', 'awaiting_courier_choice',
  'awaiting_address', 'awaiting_location', 'awaiting_payment',
  'pending_invoice', 'pending_quote',
]);

const RESTART_PROTECTED = new Set([
  'awaiting_invoice_confirm', 'awaiting_proof', 'awaiting_payment_proof',
  'awaiting_manual_payment_review', 'awaiting_admin_review',
]);

const MENU_PROTECTED = new Set([
  'awaiting_invoice_confirm', 'pending_finance', 'awaiting_payment_proof',
  'awaiting_payment_review', 'awaiting_proof', 'awaiting_manual_payment_review',
  'awaiting_admin_review', 'payment_verified_manual', 'payment_rejected_manual',
]);

// ── Regex constants ─────────────────────────────────────────────────
const RESTART_INTENT_RE = /^(?:hi|hello|halo|hai|menu|mulai\s+lagi|restart|ulang|start|reset)\b/i;
const MANUAL_RESET_RE = /^(?:reset|mulai\s+lagi|start\s+over|test\s+ulang)\s*$/i;
const MENU_INTENT_RE = /^(?:menu|katalog|catalog|pricelist|price\s*list|lihat\s+menu|kirim\s+menu|show\s+menu|mau\s+lihat\s+menu|order\s+lagi|mau\s+order\s+lagi)\b/i;
const CANCEL_INTENT_RE = /\b(?:cancel|batal|ga\s+jadi|gak\s+jadi|nggak\s+jadi|tidak\s+jadi|ulang|ulangi|order\s+ulang|mulai\s+ulang|reset\s+order|hapus\s+pesanan|batalin)\b/i;
const ADD_MORE_INTENT_RE = /^(?:nambah|tambah|mau\s+tambah|tambah\s+pesanan|tambah\s+menu|tambah\s+lagi|add\s+more|menu\s+lagi|lihat\s+menu\s+lagi|pesan\s+lagi|mau\s+nambah)\b/i;
const SESSION_REENTRY_RE = /^(?:hi|halo|hello|helo|hai|pagi|siang|sore|malam|permisi|tes|test|menu|pricelist|order|mau\s+order|pesan|beli|reset)\b/i;

// ── Injected deps ──────────────────────────────────────────────────
let _loadDraft, _saveDraft, _log;

function init(opts = {}) {
  _loadDraft = opts.loadDraft || (() => null);
  _saveDraft = opts.saveDraft || (() => {});
  _log = opts.log || (() => {});
}

// ── Intent predicates (pure) ────────────────────────────────────────

function isRestartIntent(text, state) {
  const t = String(text || '').trim().toLowerCase();
  if (!RESTART_INTENT_RE.test(t)) return false;
  if (/^halo\b/i.test(t) && /\b(?:beli|pesan|order|mau |butuh|tanya|ingin)\b/i.test(t)) return false;
  return true;
}

function isMenuIntent(text) { return MENU_INTENT_RE.test(String(text || '').trim().toLowerCase()); }
function isManualResetIntent(text) { return MANUAL_RESET_RE.test(String(text || '').trim().toLowerCase()); }
function isCancelIntent(text) { return CANCEL_INTENT_RE.test(String(text || '').trim().toLowerCase()); }
function isAddMoreIntent(text) { return ADD_MORE_INTENT_RE.test(String(text || '').trim().toLowerCase()); }

function isOrderLikeText(text) {
  const t = String(text || '').toLowerCase();
  return /\b(?:ayam\s*sayur|smoked\s*beef|ragout\s*creamy|mercon|chili\s*oil|pedas|original|creamy\s*chicken|mix\s*risol)\b/i.test(t)
      || /\b(?:risol|risoles)\b.*\b(?:goreng|frozen|6\s*pcs|12\s*pcs|6pcs|12pcs)\b/i.test(t);
}

function shouldResetSessionOnReentry(text) {
  return SESSION_REENTRY_RE.test(String(text || '').trim());
}

function isCheckoutActive(state) {
  const s = String(state || '').trim().toLowerCase();
  return [
    'awaiting_invoice_confirm','awaiting_payment_proof','awaiting_proof',
    'awaiting_delivery_method','awaiting_name','awaiting_addon_reply',
    'awaiting_pin_confirm','awaiting_address_pin_confirm','payment_review_pending',
    'awaiting_manual_payment_review','awaiting_address','awaiting_location',
    'awaiting_usecase','awaiting_product_selection','awaiting_order_confirm',
  ].includes(s);
}

// ── Clarify count ──────────────────────────────────────────────────

function getClarifyCount(draft) { return Number(draft?._clarify_count) || 0; }

function resetClarifyCount(from) {
  const d = _loadDraft(from) || {};
  if (d._clarify_count) { _saveDraft(from, { ...d, _clarify_count: 0 }); }
}

function incrementClarifyCount(from) {
  const d = _loadDraft(from) || {};
  const n = getClarifyCount(d) + 1;
  _saveDraft(from, { ...d, _clarify_count: n });
  return n;
}

// ── State mutations ────────────────────────────────────────────────

function isProtectedPaymentFlow(draft) {
  const d = draft || {};
  const s = String(d.state || '').trim().toLowerCase();
  const terminal = new Set(['approved','booked','delivered','cancelled','payment_verified_manual','payment_rejected_manual']);
  if (MENU_PROTECTED.has(s)) return true;
  if (d.payment_sent_at && !terminal.has(s)) return true;
  return false;
}

function clearCheckoutForCancel(from) {
  const draft = _loadDraft(from) || { phone: from };
  const next = {
    ...draft,
    state: null, use_case: null, use_case_source: null, use_case_set_at: null,
    items: null, addons: null, subtotal: null, cart: null,
    destination: null, gmaps_link: null,
    pending_address_text: null, pending_address_text_at: null,
    grand_total: null, expected_total: null, ongkir: null,
    courier: null, courier_label: null, courier_type: null, eta_text: null,
    quote_at: null, invoice_sent_at: null, payment_sent_at: null,
    payment_order_key: null, payment_text_sent_at: null,
    qris_sent_for_order_key: null, add_more_mode: null,
    awaiting_add_more_confirm: null, pending_bridge_context: null,
  };
  _saveDraft(from, next);
  return true;
}

function resetCheckoutState(from) {
  const draft = _loadDraft(from) || { phone: from };
  const state = String(draft.state || '').trim().toLowerCase();
  if (!TRANSIENT_RESET_STATES.has(state)) return false;
  if (Array.isArray(draft.items) && draft.items.length > 0) return false;
  const next = {
    ...draft,
    state: null, use_case: null, use_case_source: null, use_case_set_at: null,
    items: null, addons: null, subtotal: null, cart: null,
    cart_source: null, cart_raw_text: null, cart_parsed_at: null, cart_sniffed_at: null,
    catalog_order: null, destination: null, gmaps_link: null, gmaps_link_seen_at: null,
    pending_address_text: null, pending_address_text_at: null,
    customer_name: null, customer_name_set_at: null,
    grand_total: null, expected_total: null, ongkir: null,
    courier: null, courier_label: null, courier_type: null, eta_text: null,
    quote_at: null, invoice_sent_at: null, payment_sent_at: null,
    pending_bridge_context: null, location_resolve_fails: 0,
  };
  _saveDraft(from, next);
  _log('sbsr-session', 'reset_checkout_state');
  return true;
}

function hardResetSession(from) {
  const draft = _loadDraft(from) || { phone: from };
  const next = {
    ...draft,
    state: null, use_case: null, use_case_source: null, use_case_set_at: null,
    items: null, addons: null, subtotal: null, cart: null,
    cart_source: null, cart_raw_text: null, cart_parsed_at: null, cart_sniffed_at: null,
    catalog_order: null, destination: null, gmaps_link: null, gmaps_link_seen_at: null,
    pending_address_text: null, pending_address_text_at: null,
    customer_name: null, customer_name_set_at: null,
    grand_total: null, expected_total: null, ongkir: null,
    courier: null, courier_label: null, courier_type: null, eta_text: null,
    quote_at: null, invoice_sent_at: null, payment_sent_at: null,
    payment_order_key: null, payment_text_sent_at: null,
    qris_sent_for_order_key: null, add_more_mode: null,
    pending_bridge_context: null, location_resolve_fails: 0,
  };
  _saveDraft(from, next);
  _log('sbsr-session', 'hard_reset');
  return true;
}

module.exports = {
  init,
  // State sets
  TRANSIENT_RESET_STATES, RESTART_PROTECTED, MENU_PROTECTED,
  // Regex
  RESTART_INTENT_RE, MANUAL_RESET_RE, MENU_INTENT_RE,
  CANCEL_INTENT_RE, ADD_MORE_INTENT_RE, SESSION_REENTRY_RE,
  // Predicates
  isRestartIntent, isMenuIntent, isManualResetIntent, isCancelIntent,
  isAddMoreIntent, isOrderLikeText, shouldResetSessionOnReentry, isCheckoutActive,
  // Clarify
  getClarifyCount, resetClarifyCount, incrementClarifyCount,
  // Mutations
  isProtectedPaymentFlow, clearCheckoutForCancel, resetCheckoutState, hardResetSession,
};
