// draft-policy.cjs — pure predicates for draft-reset decisions.
//
// Extracted from server.js so the rules can be unit-tested in isolation.
// Used by the catalog-order persist block to decide whether to wipe stale
// name/url/destination from a returning customer's prior draft.

'use strict';

// Anything past invoice-confirm is "post-cart-build" — re-using customer_name /
// gmaps_link is wrong because the customer has explicitly closed that order.
const TERMINAL_STATES = Object.freeze([
  'awaiting_invoice_confirm',
  'awaiting_proof',
  'pending_finance',
  'approved',
  'BOOKED',
  'booked',
  'in_transit',
  'delivered',
  'cancelled',
]);

// 2026-05-07 QA — addition: an INCOMPLETE draft (state still null or e.g.
// awaiting_address) older than this threshold is also treated as stale and
// reset on a new catalog order. Without this, a customer who abandoned a
// cart yesterday gets their *old* gmaps_link reused when they place a fresh
// order today — silently shipping to the wrong destination.
const STALE_INCOMPLETE_HOURS = 6;

/**
 * Decide whether a returning customer's existing draft should be reset
 * (name + url + destination wiped) when a new catalog order arrives.
 *
 * @param {object|null} existing - the draft loaded from disk (or null if none)
 * @param {object} [opts]
 * @param {number} [opts.staleIncompleteHours=6] - override the staleness window
 * @param {() => number} [opts.now=Date.now] - injectable clock for tests
 * @returns {{ reset: boolean, reason: string }}
 */
function shouldResetDraftForCatalogOrder(existing, opts = {}) {
  if (!existing) return { reset: false, reason: 'no-prior-draft' };

  // Terminal: invoice already sent OR state explicitly past cart-build.
  if (existing.invoice_sent_at) {
    return { reset: true, reason: 'prior-invoice-sent' };
  }
  if (existing.state && TERMINAL_STATES.includes(existing.state)) {
    return { reset: true, reason: 'prior-terminal-state:' + existing.state };
  }

  // Stale incomplete: customer left mid-flow long ago. Use last_inbound_at as
  // the freshness signal (set on every inbound message — see handleMessage).
  // If absent, fall back to updated_at (saveDraft writes this) so we still
  // catch ancient drafts that pre-date the last_inbound_at convention.
  const staleHours = Number(opts.staleIncompleteHours ?? STALE_INCOMPLETE_HOURS);
  const now = (opts.now || Date.now)();
  const cutoffMs = staleHours * 3600 * 1000;
  const lastTouch = existing.last_inbound_at || existing.updated_at;
  if (lastTouch) {
    const ageMs = now - new Date(lastTouch).getTime();
    if (Number.isFinite(ageMs) && ageMs >= cutoffMs) {
      // Only treat as "stale incomplete" if there's actually some content to
      // reset — a brand-new draft with just a phone field doesn't need it.
      const hasContent = existing.gmaps_link
        || existing.customer_name
        || (existing.destination && Object.keys(existing.destination || {}).length > 0)
        || (existing.items && existing.items.length > 0);
      if (hasContent) {
        return { reset: true, reason: `stale-incomplete:${Math.round(ageMs / 3600000)}h` };
      }
    }
  }

  return { reset: false, reason: 'mid-cart-build' };
}

module.exports = { shouldResetDraftForCatalogOrder, TERMINAL_STATES, STALE_INCOMPLETE_HOURS };
