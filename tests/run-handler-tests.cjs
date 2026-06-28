// run-handler-tests.cjs — Runtime test harness for ctx-based handlers.
// Each handler is tested with mock ctx objects (no WhatsApp, no LLM, no disk).
// Usage: node tests/run-handler-tests.cjs

'use strict';

let passed = 0, failed = 0;
const failures = [];

function assert(condition, msg) {
  if (condition) { passed++; }
  else { failed++; failures.push(msg); }
}

// ── Mock ctx factory ─────────────────────────────────────────────────
function mockCtx(overrides = {}) {
  const draft = {
    phone: '6281234567890',
    state: overrides.state || 'initial',
    customer_name: overrides.customerName || '',
    items: overrides.items || [],
    addons: overrides.addons || [],
    use_case: overrides.useCase || '',
    delivery_mode: overrides.deliveryMode || '',
    destination: overrides.destination || null,
    gmaps_link: overrides.gmapsLink || '',
    address_text: overrides.addressText || '',
    quote_options: overrides.quoteOptions || null,
    invoice_sent_at: overrides.invoiceSentAt || null,
    add_more_mode: overrides.addMoreMode || false,
    address_pin_confirm: overrides.pinConfirm || null,
    pending_address_text: overrides.pendingAddressText || '',
    ...overrides.draftExtra || {},
  };

  const ctx = {
    from: '6281234567890',
    messageId: 'test-msg-' + Date.now(),
    contactName: 'Test Customer',
    text: overrides.text || '',
    type: overrides.type || 'text',
    rawMsg: overrides.rawMsg || null,
    now: new Date(),
    nowISO: new Date().toISOString(),

    get draft() { return draft; },
    get state() { return String(draft.state || '').trim().toLowerCase(); },
    get cart() { return Array.isArray(draft.items) ? draft.items : []; },
    get customerName() { return draft.customer_name || ''; },
    get useCase() { return draft.use_case || ''; },
    get deliveryMode() { return draft.delivery_mode || ''; },
    get destination() { return draft.destination || null; },

    updateDraft(patch) { Object.assign(draft, patch); },
    saveDraft() {},
    reply(text) {},
    replyWithCatalog() {},
    replyWithLocationRequest() {},
    notifyAdmin() {},
    react() {},
    async askLLM(prompt, tag) { return 'LLM reply for: ' + (prompt || '').slice(0, 50); },
    get catalog() { return { categories: [], addons: [], faq: [] }; },
    async memory() { return ''; },
    log(tag, msg) {},
    handled: false,
    replyText: null,
  };
  return ctx;
}

// ── Test runner ──────────────────────────────────────────────────────
async function testHandler(name, handlerModule, testCases) {
  console.log('\n=== ' + name + ' ===');
  for (const tc of testCases) {
    const ctx = mockCtx(tc.ctx || {});
    if (tc.draft) Object.assign(ctx.draft, tc.draft);
    ctx.text = tc.text || '';
    ctx.type = tc.type || 'text';

    const matched = handlerModule.match(ctx.state, ctx);
    assert(matched === tc.expectMatch,
      name + ': match(' + ctx.state + ', "' + tc.text.slice(0,40) + '") expected=' + tc.expectMatch + ' got=' + matched);

    if (matched) {
      ctx.handled = false;
      ctx.replyText = null;
      await handlerModule.handler(ctx);

      if (tc.expectHandled !== undefined) {
        assert(ctx.handled === tc.expectHandled,
          name + ': handled expected=' + tc.expectHandled + ' got=' + ctx.handled + ' text="' + tc.text.slice(0,40) + '"');
      }
      if (tc.expectReplyContains) {
        const reply = ctx.replyText || '';
        assert(reply.includes(tc.expectReplyContains),
          name + ': reply should contain "' + tc.expectReplyContains + '" got "' + reply.slice(0,80) + '"');
      }
      if (tc.expectState) {
        assert(ctx.state === tc.expectState,
          name + ': state expected=' + tc.expectState + ' got=' + ctx.state);
      }
    }
  }
}

// ── Load all handlers ────────────────────────────────────────────────
async function main() {
  const handlers = {
    'cancel':   require('../lib/handlers/handler-cancel.cjs'),
    'faq':      require('../lib/handlers/handler-faq.cjs'),
    'ooc':      require('../lib/handlers/handler-ooc.cjs'),
    'use-case': require('../lib/handlers/handler-use-case.cjs'),
    'product':  require('../lib/handlers/handler-product.cjs'),
    'addon':    require('../lib/handlers/handler-addon.cjs'),
    'meeting':  require('../lib/handlers/handler-meeting.cjs'),
    'add-more': require('../lib/handlers/handler-add-more.cjs'),
    'delivery': require('../lib/handlers/handler-delivery.cjs'),
    'name':     require('../lib/handlers/handler-name.cjs'),
    'address':  require('../lib/handlers/handler-address.cjs'),
    'maps':     require('../lib/handlers/handler-maps.cjs'),
    'courier':  require('../lib/handlers/handler-courier.cjs'),
    'pin':      require('../lib/handlers/handler-pin.cjs'),
    'ongkir':   require('../lib/handlers/handler-ongkir.cjs'),
    'bridges':  require('../lib/handlers/handler-bridges.cjs'),
    'misc':     require('../lib/handlers/handler-misc.cjs'),
    'internal': require('../lib/handlers/handler-internal.cjs'),
    'greeting': require('../lib/handlers/handler-greeting.cjs'),
  };

  // ── CANCEL handler tests ───────────────────────────────────────────
  await testHandler('cancel', handlers['cancel'], [
    { text: 'cancel', expectMatch: true, expectHandled: true, expectReplyContains: 'Mau lihat menu' },
    { text: 'batal', expectMatch: true, expectHandled: true },
    { text: 'reset', expectMatch: true, expectHandled: true },
    { text: 'ga jadi', expectMatch: true, expectHandled: true },
    { text: 'menu', expectMatch: true, expectHandled: true },
    { text: 'halo', expectMatch: true, expectHandled: true, expectState: 'initial' },
    { text: 'pesan ayam sayur 6', expectMatch: false }, // order-like greeting
  ]);

  // ── FAQ handler tests ──────────────────────────────────────────────
  await testHandler('faq', handlers['faq'], [
    { text: 'ini halal gak?', expectMatch: true, expectHandled: true, expectReplyContains: 'sertifikasi halal' },
    { text: 'cara gorengnya gimana?', expectMatch: true, expectHandled: true, expectReplyContains: 'Cara goreng' },
    { text: 'pickup dimana?', expectMatch: true, expectHandled: true, expectReplyContains: 'Cipinang' },
    { text: 'minimal order berapa?', expectMatch: true, expectHandled: true, expectReplyContains: '50.000' },
    { text: 'ongkir berapa?', expectMatch: false }, // handled by ongkir handler, not FAQ
    { text: 'ok', expectMatch: false }, // not a FAQ
    { text: 'halo', expectMatch: false }, // greeting, not FAQ
    { ctx: { state: 'awaiting_name' }, text: 'pickup dimana?', expectMatch: false }, // FAQ blocked in this state
  ]);

  // ── GREETING handler tests ─────────────────────────────────────────
  await testHandler('greeting', handlers['greeting'], [
    { text: 'halo', expectMatch: true, expectHandled: true, expectReplyContains: 'Selamat datang' },
    { text: 'hi', expectMatch: true, expectHandled: true },
    { text: 'menu', expectMatch: true, expectHandled: true },
    { text: 'pagi', expectMatch: true, expectHandled: true },
    { text: '', expectMatch: true, expectHandled: true }, // empty text in initial state
    { text: 'ayam sayur 6', expectMatch: true, expectHandled: false }, // product → fall through
  ]);

  // ── USE-CASE handler tests ─────────────────────────────────────────
  await testHandler('use-case', handlers['use-case'], [
    { ctx: { state: 'awaiting_usecase' }, text: '1', expectMatch: true, expectHandled: true, expectReplyContains: 'makan langsung' },
    { ctx: { state: 'awaiting_usecase' }, text: '2', expectMatch: true, expectHandled: true, expectReplyContains: 'stock frozen' },
    { ctx: { state: 'awaiting_usecase' }, text: 'makan langsung', expectMatch: true, expectHandled: true },
    { ctx: { state: 'awaiting_usecase' }, text: 'buat stok di rumah', expectMatch: true, expectHandled: true },
    { ctx: { state: 'initial' }, text: '1', expectMatch: false },
  ]);

  // ── DELIVERY handler tests ─────────────────────────────────────────
  await testHandler('delivery', handlers['delivery'], [
    { ctx: { state: 'awaiting_delivery_method' }, text: '1', expectMatch: true, expectHandled: true, expectState: 'awaiting_name' },
    { ctx: { state: 'awaiting_delivery_method' }, text: '2', expectMatch: true, expectHandled: true, expectReplyContains: 'PICKUP' },
    { ctx: { state: 'awaiting_delivery_method' }, text: 'delivery', expectMatch: true, expectHandled: true },
    { ctx: { state: 'initial' }, text: '1', expectMatch: false },
    // Pickup from any state with cart
    { ctx: { state: 'awaiting_name', items: [{name:'test',qty:1}] }, text: 'pickup', expectMatch: true, expectReplyContains: 'PICKUP' },
  ]);

  // ── NAME handler tests ─────────────────────────────────────────────
  await testHandler('name', handlers['name'], [
    { ctx: { state: 'awaiting_name' }, text: 'Budi Setiawan', expectMatch: true, expectHandled: true, expectState: 'awaiting_address' },
    { ctx: { state: 'awaiting_name' }, text: 'nama: Siti Nurhaliza', expectMatch: true, expectHandled: true },
    { ctx: { state: 'awaiting_name' }, text: 'saya Andi', expectMatch: true, expectHandled: true },
    { ctx: { state: 'initial' }, text: 'Budi', expectMatch: false },
  ]);

  // ── ADDRESS handler tests ──────────────────────────────────────────
  await testHandler('address', handlers['address'], [
    { ctx: { state: 'awaiting_address' }, text: 'Jl Nusa Indah No 10, Cipinang', expectMatch: true, expectHandled: true },
    { ctx: { state: 'awaiting_address' }, text: 'halo', expectMatch: true, expectHandled: true, expectReplyContains: 'tunggu alamat' },
    { ctx: { state: 'initial' }, text: 'https://maps.app.goo.gl/xxxx', expectMatch: false },
  ]);

  // ── MAPS handler tests ─────────────────────────────────────────────
  await testHandler('maps', handlers['maps'], [
    { text: 'https://maps.app.goo.gl/abcd1234', expectMatch: true, expectHandled: true },
    { text: 'https://maps.google.com/?q=jakarta', expectMatch: true, expectHandled: true },
    { text: 'halo', expectMatch: false },
  ]);

  // ── COURIER handler tests ──────────────────────────────────────────
  await testHandler('courier', handlers['courier'], [
    { ctx: { state: 'awaiting_courier_choice', quoteOptions: [{courier:'paxel',courier_label:'Paxel',ongkir:15000},{courier:'gojek',courier_label:'Gojek',ongkir:12000}] },
      text: '1', expectMatch: true, expectHandled: true },
    { ctx: { state: 'awaiting_courier_choice', quoteOptions: [{courier:'paxel',courier_label:'Paxel',ongkir:15000},{courier:'gojek',courier_label:'Gojek',ongkir:12000}] },
      text: 'paxel', expectMatch: true, expectHandled: true },
    { ctx: { state: 'initial' }, text: '1', expectMatch: false },
  ]);

  // ── PIN handler tests ──────────────────────────────────────────────
  await testHandler('pin', handlers['pin'], [
    { ctx: { state: 'awaiting_address_pin_confirm' }, text: '1', expectMatch: true },
    { ctx: { state: 'awaiting_address_pin_confirm' }, text: '3', expectMatch: true, expectHandled: true, expectReplyContains: 'kirim ulang' },
    { ctx: { state: 'awaiting_address_pin_confirm' }, text: 'cancel', expectMatch: true, expectHandled: true, expectReplyContains: 'batalkan' },
    { ctx: { state: 'initial' }, text: '1', expectMatch: false },
  ]);

  // ── ADD-MORE handler tests ─────────────────────────────────────────
  await testHandler('add-more', handlers['add-more'], [
    { ctx: { state: 'awaiting_name', items: [{name:'test',qty:1}] }, text: 'tambah pesanan', expectMatch: true, expectHandled: true },
    { ctx: { state: 'awaiting_add_more_confirm', items: [{name:'test',qty:1}] }, text: '1', expectMatch: true, expectHandled: true, expectState: 'awaiting_product_selection' },
    { ctx: { state: 'awaiting_add_more_confirm', items: [{name:'test',qty:1}] }, text: '2', expectMatch: true, expectHandled: true, expectState: 'awaiting_delivery_method' },
  ]);

  // ── MEETING handler tests ──────────────────────────────────────────
  await testHandler('meeting', handlers['meeting'], [
    { ctx: { state: 'awaiting_meeting_package_confirm' }, text: 'ya', expectMatch: true, expectHandled: true, expectState: 'awaiting_addon_reply' },
    { ctx: { state: 'awaiting_meeting_package_confirm' }, text: 'tidak', expectMatch: true, expectHandled: true },
    { ctx: { state: 'initial' }, text: 'ya', expectMatch: false },
  ]);

  // ── BRIDGES handler tests ──────────────────────────────────────────
  await testHandler('bridges', handlers['bridges'], [
    { text: 'saldo berapa?', expectMatch: true, expectHandled: true },
    { text: 'ig approve', expectMatch: true, expectHandled: true },
    { text: 'halo', expectMatch: false },
  ]);

  // ── MISC handler tests ─────────────────────────────────────────────
  await testHandler('misc', handlers['misc'], [
    { ctx: { state: 'awaiting_location' }, text: 'halo', expectMatch: true, expectHandled: true },
    { ctx: { state: 'initial' }, text: 'mau pesan ayam sayur 6 ya', expectMatch: true },
  ]);

  // ── INTERNAL handler tests ─────────────────────────────────────────
  await testHandler('internal', handlers['internal'], [
    { ctx: { state: 'awaiting_order_confirm' }, text: 'ya', expectMatch: true, expectHandled: true, expectState: 'awaiting_delivery_method' },
    { ctx: { state: 'awaiting_order_confirm' }, text: 'cancel', expectMatch: true, expectHandled: true },
    { ctx: { state: 'initial' }, text: 'siap diambil', expectMatch: true, expectHandled: true },
  ]);

  // ── OOC handler tests ──────────────────────────────────────────────
  await testHandler('ooc', handlers['ooc'], [
    { ctx: { state: 'awaiting_name' }, text: 'kenapa harga naik?', expectMatch: true, expectHandled: true },
    { ctx: { state: 'awaiting_address' }, text: 'halo', expectMatch: true, expectHandled: true },
    { ctx: { state: 'awaiting_delivery_method' }, text: 'cuaca hari ini gimana?', expectMatch: true, expectHandled: true },
    { ctx: { state: 'initial' }, text: 'kenapa?', expectMatch: false },
  ]);

  // ── RESULTS ─────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════');
  console.log('RESULTS: ' + passed + ' passed, ' + failed + ' failed');
  if (failures.length > 0) {
    console.log('\nFAILURES:');
    failures.forEach(f => console.log('  ❌ ' + f));
    process.exit(1);
  }
  console.log('✅ ALL TESTS PASSED');
}

main().catch(err => {
  console.error('Test error:', err.message);
  process.exit(1);
});
