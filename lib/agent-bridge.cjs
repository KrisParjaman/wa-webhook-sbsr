/**
 * agent-bridge.cjs — Integration bridge between server.js and the blueprint single-agent.
 *
 * Responsibilities:
 *   • Load/save per-phone state in blueprint format ({ messages, order })
 *   • Dedup (60s TTL, ON by default)
 *   • Route messages: text → runAgent(); location → quoteOngkir() → invoice;
 *     image/doc → payment ack + admin notify
 *   • Post-process agent output: escalate → notify admin; fulfillment choice →
 *     interactive buttons; finalize → invoice + QRIS
 *   • Admin commands: RESUME <phone>, VERIFIED <phone>
 *
 * Dependency injection via init(opts) — all WhatsApp send functions and security
 * modules are provided by server.js so the bridge stays framework-agnostic.
 */
'use strict';

const path = require('path');
const fs = require('fs');

// ── Injected services ──────────────────────────────────────────
let _sendText = null;
let _sendImage = null;
let _sendButtons = null;
let _sendLocationRequest = null;
let _sendCatalogImage = null;
let _resolveGmapsUrl = null;
let _notifyAdmin = null;
let _log = null;
let _sanitizeUserText = null;
let _costGuard = null;
let _costEstimate = 0.005;
let _adminPhones = [];
let _qrisImageUrl = '';
let _agentStateDir = '';

// ── Lazy-loaded blueprint modules ──────────────────────────────
let _runAgent = null;
let _quoteOngkir = null;
let _invoiceText = null;
let _buildInvoice = null;
let _formatRupiah = null;
let _subtotalOf = null;

// ── Dedup map (60s TTL, ON by default) ─────────────────────────
const PROCESSED = new Map();

// ── Maps URL regex ─────────────────────────────────────────────
const MAPS_URL_RE = /(https?:\/\/)?(maps\.app\.goo\.gl\/[\w-]+|goo\.gl\/maps\/[\w-]+|(maps\.)?google\.[a-z.]+\/maps[^\s]*)/i;

/**
 * Initialize the bridge with production services from server.js.
 * Call once at startup (inside _initEngine).
 */
function init(opts) {
  _sendText = opts.sendText;
  _sendImage = opts.sendImage;
  _sendButtons = opts.sendButtons;
  _sendLocationRequest = opts.sendLocationRequest;
  _sendCatalogImage = opts.sendCatalogImage;
  _resolveGmapsUrl = opts.resolveGmapsUrl;
  _notifyAdmin = opts.notifyAdmin;
  _log = opts.log || (() => {});
  _sanitizeUserText = opts.sanitizeUserText || ((t) => ({ clean: t, flags: [], blocked: false }));
  _costGuard = opts.costGuard || null;
  _costEstimate = opts.perRequestCostUsd || 0.005;
  _adminPhones = opts.adminPhones || [];
  _qrisImageUrl = opts.qrisImageUrl || '';
  _agentStateDir = opts.agentStateDir || path.join(__dirname, '..', 'agent-state');
}

// ── Lazy-load blueprint modules ────────────────────────────────
function _loadModules() {
  if (_runAgent) return;
  const agent = require('../blueprint/sbsr-agent.cjs');
  const shipping = require('../blueprint/sbsr-shipping.cjs');
  const catalog = require('../blueprint/sbsr-catalog.cjs');
  _runAgent = agent.runAgent;
  _quoteOngkir = shipping.quoteOngkir;
  _invoiceText = shipping.invoiceText;
  _buildInvoice = shipping.buildInvoice;
  _formatRupiah = catalog.formatRupiah;
  _subtotalOf = shipping.subtotalOf;
}

// ── State persistence ──────────────────────────────────────────
function norm(phone) { return String(phone).replace(/[^0-9]/g, ''); }

function _statePath(phone) { return path.join(_agentStateDir, norm(phone) + '.json'); }

function loadState(phone) {
  try { return JSON.parse(fs.readFileSync(_statePath(phone), 'utf8')); }
  catch (_e) { return { messages: [], order: { cart: [] } }; }
}

function saveState(phone, s) {
  try {
    if (!fs.existsSync(_agentStateDir)) { fs.mkdirSync(_agentStateDir, { recursive: true }); }
    // Cap messages at 24 to prevent unbounded growth (keep system prompt + recent)
    const msgs = s.messages || [];
    const capped = msgs.length > 24 ? [msgs[0], ...msgs.slice(-22)] : msgs;
    fs.writeFileSync(_statePath(phone), JSON.stringify({ ...s, messages: capped }, null, 2));
  } catch (e) { _log('agent_state_err', e.message); }
}

// ── Dedup ──────────────────────────────────────────────────────
function _isDuplicate(id) {
  if (!id) return false;
  const now = Date.now();
  for (const [k, t] of PROCESSED) { if (now - t > 60000) PROCESSED.delete(k); }
  if (PROCESSED.has(id)) return true;
  PROCESSED.set(id, now);
  return false;
}

function isPaused(phone) {
  const state = loadState(phone);
  return !!(state.order && state.order.paused);
}

// ── Text extraction from WhatsApp message ──────────────────────
function _extractText(msg, userText) {
  if (msg.type === 'text') return userText || (msg.text && msg.text.body) || '';
  if (msg.type === 'interactive') {
    if (msg.interactive && msg.interactive.button_reply) {
      return msg.interactive.button_reply.id || msg.interactive.button_reply.title || '';
    }
    if (msg.interactive && msg.interactive.list_reply) {
      return msg.interactive.list_reply.id || msg.interactive.list_reply.title || '';
    }
  }
  return userText || '';
}

// ── Helpers ─────────────────────────────────────────────────────

/**
 * Build a compact state context so the agent always knows current order state.
 * Injected before every agent turn — "super state awareness".
 */
function _buildStateContext(order) {
  var parts = ['[KONTEKS PESANAN SAAT INI]'];

  // Cart
  var cart = order.cart || [];
  if (cart.length === 0) {
    parts.push('Keranjang: KOSONG');
  } else {
    parts.push('Keranjang:');
    var _sub = 0;
    for (var i = 0; i < cart.length; i++) {
      var it = cart[i];
      _sub += it.price * it.qty;
      parts.push('  ' + (i + 1) + '. ' + it.name + ' ' + (it.form || '') + ' ' + it.pack + 'pcs ×' + it.qty + ' = ' + _formatRupiah(it.price * it.qty));
    }
    parts.push('  Subtotal: ' + _formatRupiah(_sub));
  }

  // Fulfillment
  if (order.fulfillment) {
    parts.push('Pengiriman: ' + (order.fulfillment === 'delivery' ? 'DIKIRIM (delivery)' : 'AMBIL SENDIRI (pickup)'));
  } else {
    parts.push('Pengiriman: BELUM dipilih');
  }

  // Recipient
  if (order.name) parts.push('Nama penerima: ' + order.name);
  else if (order.fulfillment) parts.push('Nama penerima: BELUM ada');

  if (order.address) parts.push('Alamat: ' + order.address);
  else if (order.fulfillment === 'delivery') parts.push('Alamat: BELUM ada');

  // Location + ongkir
  if (order.pin) {
    parts.push('Lokasi: SUDAH diterima (lat=' + order.pin.lat + ', lng=' + order.pin.lng + ')');
    if (order.ongkir && order.ongkir > 0) parts.push('Ongkir: ' + _formatRupiah(order.ongkir) + (order.ongkir_courier ? ' via ' + order.ongkir_courier : ''));
    else parts.push('Ongkir: BELUM dihitung');
  } else if (order.fulfillment === 'delivery') {
    parts.push('Lokasi: BELUM diterima (WAJIB minta share location!)');
  }

  // Flow state
  if (order.flow) parts.push('Status: ' + order.flow);
  if (order.paused) parts.push('⚠️ PAUSED — menunggu admin');
  if (order.escalate) parts.push('⚠️ ESCALATED: ' + order.escalate);
  if (order.courierPreference) parts.push('Preferensi kurir: ' + order.courierPreference);

  return parts.join('\n');
}

function _isMapsUrl(text) { return MAPS_URL_RE.test(text || ''); }

function _isFulfillmentChoiceReply(reply) {
  return /dikirim.*ambil sendiri|ambil sendiri.*dikirim/i.test(reply || '');
}

async function _sendInvoiceAndQris(phone, order) {
  const text = typeof _invoiceText === 'function' ? _invoiceText(order) : '';
  await _sendText(phone, text);
  if (_qrisImageUrl) {
    await _sendImage(phone, _qrisImageUrl,
      'Scan QRIS ini buat bayar ya Kak 🤍 Setelah transfer, kirim foto buktinya di sini.');
  } else {
    await _sendText(phone, 'Silakan lanjut pembayaran QRIS ya Kak 🤍 (admin kirim QRIS). Setelah transfer, kirim foto buktinya.');
  }
  order.flow = 'awaiting_payment';
  order.finalize = false;
}

// ── Message type handlers ──────────────────────────────────────

async function _handleLocation(phone, msg, text, state, order) {
  let lat = null, lng = null;
  if (msg.type === 'location' && msg.location) {
    lat = msg.location.latitude;
    lng = msg.location.longitude;
  }
  // Try resolving Google Maps URL if no native location pin (rule 18)
  if (lat == null && text && typeof _resolveGmapsUrl === 'function') {
    try {
      const resolved = await _resolveGmapsUrl(text);
      if (resolved && resolved.lat != null && resolved.lng != null) {
        lat = resolved.lat;
        lng = resolved.lng;
        _log('agent', 'gmaps_resolved lat=' + lat + ' lng=' + lng + ' confidence=' + (resolved.confidence || '?'));
      }
    } catch (_e) { _log('agent', 'gmaps_resolve_err ' + (_e.message || _e)); }
  }
  // Rule 18: Pin unresolvable — track retries, escalate after 2 fails
  if (lat == null) {
    order._pinRetries = (order._pinRetries || 0) + 1;
    if (order._pinRetries >= 2) {
      order.escalate = 'pin_unresolvable_after_2_retries';
      await _sendText(phone, 'Mohon maaf Kak 🙏 Mintu kesulitan membaca lokasinya. Sebentar ya, Mintu sambungkan ke admin buat bantu.');
      if (typeof _notifyAdmin === 'function') {
        await _notifyAdmin('📍 Pin unresolvable — ' + norm(phone) + ' (' + (order.name || '?') + '). Butuh bantuan manual.', 'pin_fail');
      }
      order.paused = true;
      saveState(phone, state);
      return true;
    }
    await _sendText(phone, 'Paling akurat pakai *Share Location WhatsApp* ya Kak 📍 (klik 📎 → Location → Send your current location)');
    saveState(phone, state);
    return true;
  }
  // Reset retry counter on success
  order._pinRetries = 0;

  order.pin = { lat, lng };

  // Rule 11: Pickup → skip Biteship entirely
  if (order.fulfillment === 'pickup') {
    await _sendText(phone, 'Lokasi diterima Kak 😊');
    var _pReady = order.cart.length && order.name;
    if (_pReady) { await _sendInvoiceAndQris(phone, order); }
    else { await _sendText(phone, 'Tinggal lengkapi nama ya Kak 🤍'); }
    state.messages.push({ role: 'assistant', content: '[sistem: lokasi diterima untuk pickup]' });
    saveState(phone, state);
    return true;
  }

  // Delivery: calculate ongkir with smart courier selection (rules 1-10, 12-15)
  const courierOverride = order.courierPreference || null;
  const q = await _quoteOngkir(lat, lng, order.cart, courierOverride);

  // Rule 16: Outside coverage or all retries failed → escalate to admin
  if (!q.available && q.needsEscalate) {
    order.escalate = 'outside_coverage_or_biteship_failed';
    await _sendText(phone, 'Mohon maaf Kak 🙏 untuk titik ini kurir belum tersedia. Sebentar ya, Mintu sambungkan ke admin buat bantu.');
    if (typeof _notifyAdmin === 'function') {
      await _notifyAdmin('📍 Outside coverage — ' + norm(phone) + ' (' + (order.name || '?') + '). ' + (q.error || ''), 'no_coverage');
    }
    order.paused = true;
    saveState(phone, state);
    return true;
  }

  if (!q.available) {
    await _sendText(phone, 'Mohon maaf Kak 🙏 untuk titik ini kurir belum tersedia. Boleh share lokasi lain, atau pilih ambil sendiri (pickup)?');
    saveState(phone, state);
    return true;
  }

  // Rules 5-8: Frozen courier choice — present Paxel+Gosend options
  if (q.courierInfo && q.courierInfo.needsFrozenChoice && q.frozenOptions && q.frozenOptions.length >= 2) {
    order.ongkir = q.ongkir;
    order.ongkir_eta = q.eta;
    order.ongkir_courier = q.courier;
    order._frozenOptions = q.frozenOptions;
    var _opts = q.frozenOptions;
    var _optText = 'Karena ada frozen di pesanan, Mintu kasih 2 pilihan kurir:\n\n'
      + '1️⃣ ' + _opts[0].courier + ' — ' + _formatRupiah(_opts[0].ongkir) + ' (cold-chain ' + (_opts[0].eta || '') + ')\n'
      + '2️⃣ ' + _opts[1].courier + ' — ' + _formatRupiah(_opts[1].ongkir) + ' (' + (_opts[1].eta || '') + ')\n\n'
      + 'Mau pilih yang 1 atau 2, Kak?';
    await _sendText(phone, 'Lokasi diterima Kak 😊');
    await _sendText(phone, _optText);
    if (typeof _sendButtons === 'function') {
      await _sendButtons(phone, 'Pilih kurir ya Kak 🤍', [
        { type: 'reply', reply: { id: 'courier_1', title: '🐧 ' + _opts[0].courier + ' ' + _formatRupiah(_opts[0].ongkir) } },
        { type: 'reply', reply: { id: 'courier_2', title: '🛵 ' + _opts[1].courier + ' ' + _formatRupiah(_opts[1].ongkir) } },
      ]);
    }
    order.flow = 'awaiting_courier_choice';
    state.messages.push({ role: 'assistant', content: '[sistem: frozen courier options sent — ongkir ' + _formatRupiah(q.ongkir) + ']' });
    saveState(phone, state);
    return true;
  }

  // Standard delivery: ongkir calculated
  order.ongkir = q.ongkir;
  order.ongkir_eta = q.eta;
  order.ongkir_courier = q.courier;

  await _sendText(phone, 'Lokasi diterima Kak 😊 ongkir udah dihitung ya.');
  // Guard: for delivery, address is REQUIRED before invoice (money = deterministic)
  var _readyForInvoice = order.cart.length && order.fulfillment && order.name
    && (order.fulfillment === 'pickup' || !!order.address);
  if (_readyForInvoice) {
    await _sendInvoiceAndQris(phone, order);
  } else {
    var _missing = [];
    if (!order.name) _missing.push('nama');
    if (order.fulfillment === 'delivery' && !order.address) _missing.push('alamat');
    await _sendText(phone, 'Tinggal lengkapi ' + (_missing.length ? _missing.join(' & ') : 'data') + ' ya Kak 🤍');
  }
  state.messages.push({ role: 'assistant', content: '[sistem: lokasi diterima, ongkir ' + _formatRupiah(order.ongkir || 0) + ', rule=' + (q.courierInfo ? q.courierInfo.rule : '?') + ']' });
  saveState(phone, state);
  return true;
}

async function _handlePaymentProof(phone, state, order) {
  await _sendText(phone, 'Makasih Kak 🤍 Bukti pembayaran sudah Mintu terima, lagi dicek admin ya. Nanti dikabari kalau sudah diverifikasi 😊');
  if (typeof _notifyAdmin === 'function') {
    await _notifyAdmin('🧾 Bukti bayar dari ' + norm(phone) + ' (' + (order.name || '?') + '). Cek & verifikasi.', 'payment-proof');
  }
  order.flow = 'awaiting_admin';
  saveState(phone, state);
  return true;
}

async function _handleCatalogOrder(phone, msg, state, order) {
  const items = (msg.order && msg.order.product_items) || [];
  if (!items.length) return false;
  const itemDescs = items.map(it => (it.product_retailer_id || 'produk') + ' x' + (it.quantity || 1));
  const syntheticText = '[CATALOG ORDER] ' + itemDescs.join(', ');
  state.messages.push({ role: 'user', content: syntheticText });
  // Recurse: process as text through the agent
  return await processTurn(phone, syntheticText, { type: 'text', text: { body: syntheticText } }, msg.id, '');
}

async function _handleAdmin(phone, userText) {
  const text = userText || '';

  // RESUME <phone> — unpause a customer
  const resumeM = text.match(/^resume[_\s]+(\d{8,15})/i);
  if (resumeM) {
    const target = norm(resumeM[1]);
    const s = loadState(target);
    s.order.paused = false;
    s.order.flow = '';
    saveState(target, s);
    await _sendText(phone, '✅ Bot aktif lagi untuk ' + target);
    await _sendText(target, 'Halo Kak 😊 Mintu lanjut bantu ya 🤍');
    return true;
  }

  // VERIFIED/APPROVE <phone> — notify customer payment verified
  const verifyM = text.match(/^(verified|approve)[_\s]+(\d{8,15})/i);
  if (verifyM) {
    const target = norm(verifyM[2]);
    await _sendText(target, 'Pembayaran terverifikasi Kak ✅ Pesanan diproses ya. Makasih banyak! 🍴🤍');
    await _sendText(phone, '✅ Customer ' + target + ' dikabari.');
    return true;
  }

  // Not an admin command — let admin test the bot naturally
  return false;
}

// ── Main entry point ───────────────────────────────────────────

/**
 * Process one incoming turn through the agent.
 *
 * @param {string} phone         - WhatsApp phone number (raw, with or without country code)
 * @param {string} userText      - Already-sanitized text content (empty for non-text messages)
 * @param {object} msg           - Raw WhatsApp message object from the webhook
 * @param {string} messageId     - WhatsApp message ID (for dedup)
 * @param {string} contactName   - WhatsApp profile name
 * @returns {Promise<boolean>}   - true if the bridge handled this message
 */
async function processTurn(phone, userText, msg, messageId, contactName) {
  _loadModules();

  // Dedup
  if (_isDuplicate(messageId)) {
    _log('agent', 'dup message_id — skip: ' + String(messageId).slice(0, 28));
    return true; // handled (by dropping)
  }

  // Admin phones → check for admin commands
  if (_adminPhones.includes(norm(phone))) {
    const adminHandled = await _handleAdmin(phone, userText);
    if (adminHandled) return true;
    // Fall through — admin can also chat with the bot
  }

  const state = loadState(phone);
  const order = state.order || (state.order = { cart: [] });
  order.cart ||= [];

  const text = _extractText(msg, userText);

  // 1) Location → deterministic ongkir
  if (msg.type === 'location' || _isMapsUrl(text)) {
    return await _handleLocation(phone, msg, text, state, order);
  }

  // 2) Payment image → ack + admin
  if (msg.type === 'image' || msg.type === 'document') {
    return await _handlePaymentProof(phone, state, order);
  }

  // 3) Catalog/order message (Meta product_list)
  if (msg.type === 'order') {
    return await _handleCatalogOrder(phone, msg, state, order);
  }

  // 4) Deterministic fulfillment button reply — no LLM needed
  //    Customer clicks "🛵 Dikirim" or "🏪 Ambil sendiri" from interactive buttons
  if ((text === 'delivery' || text === 'pickup') && (order.cart || []).length > 0 && !order.fulfillment) {
    order.fulfillment = text;
    state.messages.push({ role: 'user', content: text });
    state.messages.push({ role: 'assistant', content: '[sistem: fulfillment = ' + text + ' — deterministik, tanpa LLM]' });
    // Inject prompt so the agent asks the next question
    const _nextPrompt = text === 'delivery'
      ? '[sistem: customer pilih dikirim. Minta nama + alamat lengkap dengan ramah.]'
      : '[sistem: customer pilih pickup / ambil sendiri. Minta nama penerima saja (tanpa alamat).]';
    state.messages.push({ role: 'user', content: _nextPrompt });
  }

  // Guard: "qris"/"ulang kirim qris"/"bisa ulang kirim" when cart empty (finished order)
  if (/\b(?:qris|ulang\s*kirim|kirim\s*ulang|scan\s*qris|bayar)\b/i.test(text || '') && (order.cart || []).length === 0) {
    await _sendText(phone, 'Pesanan sebelumnya udah selesai Kak ✅ Mau pesan lagi? Bisa langsung sebut varian dan jumlahnya ya 🤍');
    saveState(phone, state);
    return true;
  }

  // Guard: "delivery"/"pickup" button clicked again when already set → don't confuse agent
  if ((text === 'delivery' || text === 'pickup') && order.fulfillment) {
    var _already = order.fulfillment === 'delivery' ? 'dikirim' : 'ambil sendiri';
    await _sendText(phone, 'Udah dicatat Kak ✅ pesanan ini ' + _already + '. ' + (order.fulfillment === 'delivery' && !order.pin ? 'Tinggal kirim lokasi ya biar ongkir dihitung 📍' : 'Lanjut ya Kak 🤍'));
    saveState(phone, state);
    return true;
  }

  // 4b) Courier override detection (rules 12-15)
  // Pre-invoice: customer picks frozen courier choice (courier_1 / courier_2)
  if (order.flow === 'awaiting_courier_choice' && /^courier_[12]$/.test(text)) {
    var _idx = text === 'courier_1' ? 0 : 1;
    var _frozenOpts = order._frozenOptions || [];
    if (_frozenOpts[_idx]) {
      order.courierPreference = _frozenOpts[_idx].courier;
      order.ongkir = _frozenOpts[_idx].ongkir;
      order.ongkir_eta = _frozenOpts[_idx].eta;
      order.ongkir_courier = _frozenOpts[_idx].courier;
      order.flow = '';
      delete order._frozenOptions;
      state.messages.push({ role: 'user', content: text });
      state.messages.push({ role: 'assistant', content: '[sistem: customer pilih ' + _frozenOpts[_idx].courier + ' — ongkir ' + _formatRupiah(_frozenOpts[_idx].ongkir) + ']' });
      // Now send invoice if ready
      if (order.cart.length && order.name && order.address) {
        await _sendInvoiceAndQris(phone, order);
      } else {
        await _sendText(phone, 'Pilihan kurir dicatat Kak ✅ Tinggal lengkapi data lainnya ya.');
      }
      saveState(phone, state);
      return true;
    }
  }
  // Rule 12-13: Customer types courier name pre-invoice
  if (/^(paxel|gosend|gojek|grab)\b/i.test(text) && !order.ongkir && order.fulfillment === 'delivery' && order.pin) {
    order.courierPreference = text.toLowerCase().trim();
    state.messages.push({ role: 'user', content: text });
    state.messages.push({ role: 'assistant', content: '[sistem: courier preference = ' + order.courierPreference + ']' });
    // Re-fire quote with new preference
    var _requote = await _quoteOngkir(order.pin.lat, order.pin.lng, order.cart, order.courierPreference);
    if (_requote.available) {
      order.ongkir = _requote.ongkir;
      order.ongkir_eta = _requote.eta;
      order.ongkir_courier = _requote.courier;
      await _sendText(phone, 'Kurir diupdate Kak ✅ Ongkir jadi ' + _formatRupiah(_requote.ongkir) + '.');
      if (order.cart.length && order.name && order.address) {
        await _sendInvoiceAndQris(phone, order);
      }
    } else {
      await _sendText(phone, 'Maaf Kak, kurir itu belum tersedia untuk titik ini 🙏');
    }
    saveState(phone, state);
    return true;
  }
  // Rule 14: Post-invoice override — "pakai gojek" / "ganti ke paxel"
  if (/^(pakai|ganti|pake)\s+(paxel|gosend|gojek|grab)\b/i.test(text) && order.ongkir && order.pin) {
    var _m2 = text.match(/(?:pakai|ganti|pake)\s+(paxel|gosend|gojek|grab)/i);
    if (_m2) {
      order.courierPreference = _m2[1].toLowerCase();
      var _requote2 = await _quoteOngkir(order.pin.lat, order.pin.lng, order.cart, order.courierPreference);
      if (_requote2.available) {
        order.ongkir = _requote2.ongkir;
        order.ongkir_eta = _requote2.eta;
        order.ongkir_courier = _requote2.courier;
        await _sendText(phone, 'Kurir diganti Kak ✅ Ongkir jadi ' + _formatRupiah(_requote2.ongkir) + '.');
        // Re-send updated invoice
        if (order.cart.length && order.name && order.address) {
          await _sendInvoiceAndQris(phone, order);
        }
      } else {
        await _sendText(phone, 'Maaf Kak, kurir itu belum tersedia 🙏');
      }
      saveState(phone, state);
      return true;
    }
  }
  // Rule 15: Speed override — "secepatnya" / "instant"
  if (/secepatnya|instant|sekarang juga|urgent|express/i.test(text) && order.fulfillment === 'delivery' && order.pin) {
    order.courierPreference = 'gojek'; // Force Gojek Instant
    state.messages.push({ role: 'user', content: text });
    var _requote3 = await _quoteOngkir(order.pin.lat, order.pin.lng, order.cart, 'gojek');
    if (_requote3.available) {
      order.ongkir = _requote3.ongkir;
      order.ongkir_eta = _requote3.eta;
      order.ongkir_courier = _requote3.courier;
      await _sendText(phone, 'Siap Kak! 🚀 Pakai ' + _requote3.courier + ' — ongkir ' + _formatRupiah(_requote3.ongkir) + '.');
      if (order.cart.length && order.name && order.address) {
        await _sendInvoiceAndQris(phone, order);
      }
    } else {
      await _sendText(phone, 'Maaf Kak, belum ada Gojek Instant untuk titik ini 🙏');
    }
    saveState(phone, state);
    return true;
  }

  // 5) Cost guard check
  if (_costGuard) {
    try {
      if (!_costGuard.canSpend(_costEstimate)) {
        const t = _costGuard.today();
        _log('cost-guard', 'AGENT DAILY CAP HIT spend=$' + Number(t.spend_usd || 0).toFixed(4));
        await _sendText(phone, 'Mintu lagi sibuk banget hari ini, balik lagi besok pagi ya 🙏');
        return true;
      }
    } catch (_e) { /* cost guard non-critical */ }
  }

  // 5b) Pre-processing: if waiting for name and customer sends short message → inject hint
  if (order.fulfillment && !order.name && text && typeof text === 'string') {
    const _words = text.trim().split(/\s+/).filter(Boolean);
    const _looksLikeName = _words.length <= 3
      && !/pesan|menu|harga|cart|keranjang|checkout|risol|ayam|favorit|frozen|goreng|pcs|dikirim|pickup|order|catalog/i.test(text)
      && !/halo|hai|test|help/i.test(text);
    if (_looksLikeName) {
      state.messages.push({ role: 'user', content: '[sistem: customer kirim nama "' + text + '". WAJIB panggil set_recipient dengan name="' + text + '" sekarang juga. JANGAN cuma bilang terima kasih.]' });
    }
  }
  // If waiting for address (delivery, name set, no address), similar guard
  if (order.fulfillment === 'delivery' && order.name && !order.address && text && typeof text === 'string') {
    const _looksLikeAddress = text.length > 10
      && /jalan|jl\.?|no\.?|gg\.?|rt\.?|rw\.?|kampung|desa|kelurahan|kecamatan|kota|kabupaten|blok|cluster|apartemen|tower/i.test(text);
    if (_looksLikeAddress) {
      state.messages.push({ role: 'user', content: '[sistem: customer kirim alamat "' + text + '". WAJIB panggil set_recipient dengan address="' + text + '" sekarang juga. JANGAN cuma bilang oke.]' });
    }
  }

  // 5c) Super State Awareness — inject current state into every turn
  // Agent always knows exactly what's going on without guessing
  (state.messages || []).push({ role: 'user', content: _buildStateContext(order) });

  // 6) Everything else → the agent
  const r = await _runAgent(state, text || '(pesan tidak didukung)');
  const o = r.order;

  // Cost-guard record
  if (_costGuard) {
    try { _costGuard.record({ kind: 'agent', model: 'deepseek-chat', costUsd: _costEstimate }); } catch (_e) { /* non-critical */ }
  }

  // 6) Post-process agent output
  if (o.escalate) {
    await _sendText(phone, r.reply || 'Mohon maaf ya Kak 🙏 Mintu panggilkan admin (manusia) untuk bantu langsung.');
    if (typeof _notifyAdmin === 'function') {
      await _notifyAdmin('🚨 Butuh admin — ' + norm(phone) + ': ' + o.escalate, 'escalate');
    }
    o.paused = true;
  } else if (r.reply) {
    if (_isFulfillmentChoiceReply(r.reply) && !order.fulfillment) {
      await _sendButtons(phone, r.reply, [
        { type: 'reply', reply: { id: 'delivery', title: '🛵 Dikirim' } },
        { type: 'reply', reply: { id: 'pickup', title: '🏪 Ambil sendiri' } },
      ]);
    } else {
      await _sendText(phone, r.reply);
    }
  }

  // 7) If delivery mode: name+address set but no location → force location request
  if (o.fulfillment === 'delivery' && o.name && o.address && !o.pin && !o.escalate && !o.finalize) {
    // Safety: agent skipped location step → inject location request + system prompt
    if (typeof _sendLocationRequest === 'function') {
      await _sendLocationRequest(phone, '📍 Kirim Lokasi Kak, biar Mintu hitung ongkirnya ya');
    }
    // Also inject a system message so agent doesn't finalize without location
    o.finalize = false; // Block finalize until location received
    r.messages.push({ role: 'assistant', content: '[sistem: lokasi belum diterima — tolong minta customer share lokasi WhatsApp. JANGAN finalize sebelum ongkir dihitung.]' });
  }

  // 7b) First greeting → send catalog image after agent's warm welcome
  // Only on first interaction (new state) or explicit menu/pricelist request
  var _greetingRe = /^(?:hi|halo|hello|helo|hai|pagi|siang|sore|malam|permisi|tes|test|menu|pricelist)\b/i;
  var _isNewSession = (state.messages && state.messages.length <= 3) && (order.cart || []).length === 0;
  if (!order._catalogSent && typeof _sendCatalogImage === 'function' && _greetingRe.test(text || '') && _isNewSession) {
    await _sendCatalogImage(phone, 'Menu Sentuh Rasa 🤍');
    order._catalogSent = true;
  }

  // 8) If agent finalized, send invoice + QRIS
  if (o.finalize) {
    await _sendInvoiceAndQris(phone, o);
  }

  // 8) Persist state
  saveState(phone, { messages: r.messages, order: o });

  return true;
}

module.exports = { init, processTurn, isPaused, loadState, saveState };
