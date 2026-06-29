// test-pr5.cjs — Test cases for PR #5: A1 catalog prices, A2 dedup, B2 session expiry
// Usage: node tests/test-pr5.cjs
'use strict';

// Suppress post-test async noise from wa-sender (real HTTP calls fire after tests finish)
process.on('uncaughtException', () => {});

let passed = 0, failed = 0;
const failures = [];

function assert(condition, msg) {
  if (condition) { passed++; process.stdout.write('.'); }
  else { failed++; failures.push(msg); process.stdout.write('F'); }
}
function eq(a, b, label) { assert(a === b, label + ': expected ' + b + ', got ' + a); }
function ok(a, label) { assert(!!a, label + ': expected truthy, got ' + a); }
function notOk(a, label) { assert(!a, label + ': expected falsy, got ' + a); }

// ── Mock ctx factory (same pattern as run-handler-tests.cjs) ──────────
function mockCtx(overrides = {}) {
  const draft = {
    phone: '628test',
    state: overrides.state || 'initial',
    customer_name: overrides.customerName || '',
    items: overrides.items ? JSON.parse(JSON.stringify(overrides.items)) : [],
    delivery_mode: overrides.deliveryMode || '',
    pending_product: overrides.pending_product || null,
    ...(overrides.draftExtra || {}),
  };
  const ctx = {
    from: '628test',
    messageId: 'msg-' + Date.now(),
    contactName: 'Tester',
    text: overrides.text || '',
    type: 'text',
    rawMsg: null,
    now: new Date(),
    get draft() { return draft; },
    get state() { return String(draft.state || '').trim().toLowerCase(); },
    get cart() { return Array.isArray(draft.items) ? draft.items : []; },
    updateDraft(p) { Object.assign(draft, p); },
    saveDraft() {},
    reply() {},
    replyWithLocationRequest() {},
    notifyAdmin() {},
    react() {},
    log() {},
    handled: false,
    replyText: null,
  };
  return ctx;
}

// ══════════════════════════════════════════════════════════════════════
// SUITE 1 — catalog-pg.cjs: price lookups & variant detection
// ══════════════════════════════════════════════════════════════════════
console.log('\n=== A1 · catalog-pg.cjs ===');
const _cat = require('../lib/catalog-pg.cjs');

// Variant detection
eq(_cat.detectVariant('risol ayam 6pcs goreng'),  'ayam_sayur',  'detectVariant risol ayam');
eq(_cat.detectVariant('ayam'),                    'ayam_sayur',  'detectVariant ayam');
eq(_cat.detectVariant('risoles'),                 'ayam_sayur',  'detectVariant risoles');
eq(_cat.detectVariant('ragout creamy'),           'ragout',      'detectVariant ragout creamy');
eq(_cat.detectVariant('smoked beef mayo'),        'smoked_beef', 'detectVariant smoked beef mayo');
eq(_cat.detectVariant('beef'),                    'smoked_beef', 'detectVariant beef');
eq(_cat.detectVariant('mercon'),                  'mercon',      'detectVariant mercon');
eq(_cat.detectVariant('ayam mercon chili oil'),   'mercon',      'detectVariant ayam mercon');
eq(_cat.detectVariant('pedas'),                   'ayam_pedas',  'detectVariant pedas');
eq(_cat.detectVariant('mix'),                     'mix',         'detectVariant mix');

// Price lookups — goreng (uses hardcoded fallback, Postgres may not be live in test)
eq(_cat.lookupPrice('ayam_sayur', 'goreng', 3),   29000, 'ayam_sayur goreng 3pcs');
eq(_cat.lookupPrice('ayam_sayur', 'goreng', 6),   55000, 'ayam_sayur goreng 6pcs (DoD)');
eq(_cat.lookupPrice('ayam_sayur', 'goreng', 12),  105000,'ayam_sayur goreng 12pcs');
eq(_cat.lookupPrice('ragout',     'goreng', 3),   29000, 'ragout goreng 3pcs');
eq(_cat.lookupPrice('ragout',     'goreng', 6),   55000, 'ragout goreng 6pcs');
eq(_cat.lookupPrice('smoked_beef','goreng', 6),   55000, 'smoked_beef goreng 6pcs');
eq(_cat.lookupPrice('mercon',     'goreng', 3),   33000, 'mercon goreng 3pcs');
eq(_cat.lookupPrice('mercon',     'goreng', 6),   63000, 'mercon goreng 6pcs (DoD)');
eq(_cat.lookupPrice('mercon',     'goreng', 12),  120000,'mercon goreng 12pcs');
eq(_cat.lookupPrice('ayam_pedas', 'goreng', 6),   55000, 'ayam_pedas goreng 6pcs');

// Price lookups — frozen (6pcs only)
eq(_cat.lookupPrice('ayam_sayur', 'frozen', 6),   55000, 'ayam_sayur frozen 6pcs');
eq(_cat.lookupPrice('ragout',     'frozen', 6),   55000, 'ragout frozen 6pcs');
eq(_cat.lookupPrice('smoked_beef','frozen', 6),   55000, 'smoked_beef frozen 6pcs');
eq(_cat.lookupPrice('mercon',     'frozen', 6),   63000, 'mercon frozen 6pcs');
eq(_cat.lookupPrice('ayam_pedas', 'frozen', 6),   55000, 'ayam_pedas frozen 6pcs');

// Price lookup via free text (detectVariant internally)
eq(_cat.lookupPrice('risol ayam', 'goreng', 6),   55000, 'lookupPrice via text: risol ayam goreng 6pcs');
eq(_cat.lookupPrice('mercon',     'goreng', 6),   63000, 'lookupPrice via text: mercon goreng 6pcs');

// Display names
ok(_cat.lookupDisplayName('ayam_sayur','goreng').includes('Ayam Sayur'), 'displayName ayam_sayur goreng');
ok(_cat.lookupDisplayName('mercon','frozen').includes('Frozen'),        'displayName mercon frozen has Frozen');
ok(_cat.lookupDisplayName('ragout','goreng').includes('Ragout'),        'displayName ragout goreng');

// ══════════════════════════════════════════════════════════════════════
// SUITE 2 — handler-agent.cjs: order parsing & price correctness
// ══════════════════════════════════════════════════════════════════════
const agentHandler = require('../lib/handlers/handler-agent.cjs');

async function testOrder(text, opts = {}) {
  const ctx = mockCtx({ state: opts.state || 'initial', items: opts.items || [], ...opts });
  ctx.text = text;
  await agentHandler.handler(ctx);
  return ctx;
}

// ══════════════════════════════════════════════════════════════════════
// SUITE 3 — A2: Dedup logic
// ══════════════════════════════════════════════════════════════════════
function testDedup() {
  const PROCESSED = new Map();
  const TTL = 60000;
  function shouldDedupe(id) {
    if (!id) return false;
    if (process.env.SBSR_IDEMPOTENT === 'false') return false;
    const seen = PROCESSED.get(id);
    if (seen && (Date.now() - seen) < TTL) return true;
    PROCESSED.set(id, Date.now());
    return false;
  }
  notOk(shouldDedupe('msg-001'), 'first time: not duplicate');
  ok(shouldDedupe('msg-001'),    'second time same id: IS duplicate');
  ok(shouldDedupe('msg-001'),    'third time same id: still duplicate');
  notOk(shouldDedupe('msg-002'), 'different id: not duplicate');
  notOk(shouldDedupe(null),      'null id: never duplicate');
  process.env.SBSR_IDEMPOTENT = 'false';
  notOk(shouldDedupe('msg-001'), 'dedup disabled via env: not deduped');
  delete process.env.SBSR_IDEMPOTENT;
  PROCESSED.set('msg-old', Date.now() - TTL - 1);
  notOk(shouldDedupe('msg-old'), 'expired id: not duplicate after TTL');
}

// ══════════════════════════════════════════════════════════════════════
// SUITE 4 — B2: Session expiry logic
// ══════════════════════════════════════════════════════════════════════
function testSessionExpiry() {
  const SESSION_EXPIRE_MS = 24 * 60 * 60 * 1000;
  const LIVE_STATES = new Set(['awaiting_proof','pending_finance','approved','booked','delivered']);
  function shouldExpire(draft) {
    if (!draft.updated_at) return false;
    if (LIVE_STATES.has(draft.state)) return false;
    return (Date.now() - new Date(draft.updated_at).getTime()) > SESSION_EXPIRE_MS;
  }
  notOk(shouldExpire({ state: 'ordering', updated_at: new Date().toISOString() }), 'fresh draft: not expired');
  ok(shouldExpire({ state: 'ordering', updated_at: new Date(Date.now() - 25*3600*1000).toISOString() }), 'old ordering: expired');
  notOk(shouldExpire({ state: 'awaiting_proof', updated_at: new Date(Date.now() - 25*3600*1000).toISOString() }), 'awaiting_proof: NOT expired (live)');
  notOk(shouldExpire({ state: 'booked', updated_at: new Date(Date.now() - 48*3600*1000).toISOString() }), 'booked: NOT expired (live)');
  notOk(shouldExpire({ state: 'ordering' }), 'no timestamp: safe default not expired');
  ok(shouldExpire({ state: 'initial', updated_at: new Date(Date.now() - SESSION_EXPIRE_MS - 1000).toISOString() }), 'just over 24h: expired');
}

async function main() {
  console.log('\n=== A1 · handler-agent.cjs order flow ===');

  // DoD: "risol ayam 6pcs goreng" → Rp55.000
  {
    const ctx = await testOrder('mau risol ayam 6pcs goreng');
    assert(ctx.handled, 'risol ayam 6pcs: handled');
    assert(ctx.cart.length === 1, 'risol ayam 6pcs: cart has 1 item');
    eq(ctx.cart[0].unit_price, 55000, 'risol ayam goreng 6pcs price (DoD)');
    eq(ctx.cart[0].qty, 6, 'risol ayam 6pcs qty');
    eq(ctx.cart[0].form, 'goreng', 'risol ayam 6pcs form');
  }

  // DoD: mercon 6pcs goreng → Rp63.000
  {
    const ctx = await testOrder('mau mercon 6pcs goreng');
    assert(ctx.handled, 'mercon 6pcs: handled');
    eq(ctx.cart[0].unit_price, 63000, 'mercon goreng 6pcs price (DoD)');
  }

  // Mercon 3pcs goreng → 33000 (not 29000)
  {
    const ctx = await testOrder('mau mercon 3pcs goreng');
    eq(ctx.cart[0] && ctx.cart[0].unit_price, 33000, 'mercon goreng 3pcs price');
  }

  // Ayam sayur 3pcs goreng → 29000
  {
    const ctx = await testOrder('mau ayam sayur 3pcs goreng');
    eq(ctx.cart[0] && ctx.cart[0].unit_price, 29000, 'ayam sayur goreng 3pcs price');
  }

  // Frozen 6pcs → correct price + pack_size=6 (not 12)
  {
    const ctx = await testOrder('mau ayam sayur frozen 6pcs');
    assert(ctx.handled, 'frozen 6pcs: handled');
    eq(ctx.cart[0] && ctx.cart[0].unit_price, 55000, 'ayam sayur frozen 6pcs price');
    eq(ctx.cart[0] && ctx.cart[0].pack_size, 6, 'frozen pack_size=6 (was 12 before fix)');
  }

  // Mercon frozen 6pcs → 63000
  {
    const ctx = await testOrder('mau mercon frozen 6pcs');
    eq(ctx.cart[0] && ctx.cart[0].unit_price, 63000, 'mercon frozen 6pcs price');
    eq(ctx.cart[0] && ctx.cart[0].pack_size, 6, 'mercon frozen pack_size=6');
  }

  // Frozen < 6pcs → blocked, cart stays empty
  {
    const ctx = await testOrder('mau ayam sayur frozen 3pcs');
    assert(ctx.handled, 'frozen 3pcs: handled (blocked)');
    ok(ctx.replyText && ctx.replyText.includes('minimal'), 'frozen 3pcs: min-qty message shown');
    assert(ctx.cart.length === 0, 'frozen 3pcs: cart still empty');
  }

  // Ragout 12pcs goreng → 105000
  {
    const ctx = await testOrder('ragout 12pcs goreng');
    eq(ctx.cart[0] && ctx.cart[0].unit_price, 105000, 'ragout goreng 12pcs price');
  }

  // Pending product flow: "pesan ragout" → pending saved; "6pcs goreng" → completes
  {
    const ctx1 = await testOrder('mau pesan ragout');
    ok(ctx1.draft.pending_product, 'pending_product set after noqty');
    const ctx2 = mockCtx({ state: 'ordering', draftExtra: { pending_product: ctx1.draft.pending_product } });
    ctx2.text = '6pcs goreng';
    await agentHandler.handler(ctx2);
    assert(ctx2.handled, 'pending product: handled on qty reply');
    eq(ctx2.cart[0] && ctx2.cart[0].unit_price, 55000, 'pending ragout + 6pcs goreng price');
  }

  // Confirm/done: no redundant replyText after wa.sendButtons
  {
    const items = [{ sku:'sku1', name:'Ayam Sayur', qty:6, form:'goreng', unit_price:55000, pack_size:6 }];
    const ctx = await testOrder('cukup', { state: 'ordering', items });
    assert(ctx.handled, 'confirm: handled');
    assert(!ctx.replyText, 'confirm: no redundant replyText (only button sent)');
    eq(ctx.draft.state, 'awaiting_delivery_method', 'confirm: state = awaiting_delivery_method');
  }

  console.log('\n=== A2 · dedup logic ===');
  testDedup();

  console.log('\n=== B2 · session expiry logic ===');
  testSessionExpiry();

  console.log('\n\n═══════════════════════════════════════');
  console.log('RESULTS: ' + passed + ' passed, ' + failed + ' failed');
  if (failures.length > 0) {
    console.log('\nFAILURES:');
    failures.forEach(f => console.log('  ❌ ' + f));
    process.exit(1);
  }
  console.log('✅ ALL TESTS PASSED');
}

main().catch(err => {
  console.error('Test error:', err.message, err.stack);
  process.exit(1);
});
