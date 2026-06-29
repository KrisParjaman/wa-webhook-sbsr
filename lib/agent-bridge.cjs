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
  if (lat == null) {
    await _sendText(phone, 'Paling akurat pakai *Share Location WhatsApp* ya Kak 📍 (klik 📎 → Location → Send your current location)');
    saveState(phone, state);
    return true;
  }
  order.pin = { lat, lng };
  if (order.fulfillment !== 'pickup') {
    const q = await _quoteOngkir(lat, lng, order.cart);
    if (!q.available) {
      await _sendText(phone, 'Mohon maaf Kak 🙏 untuk titik ini kurir belum tersedia. Boleh share lokasi lain, atau pilih ambil sendiri (pickup)?');
      saveState(phone, state);
      return true;
    }
    order.ongkir = q.ongkir;
    order.ongkir_eta = q.eta;
  }
  await _sendText(phone, 'Lokasi diterima Kak 😊 ongkir udah dihitung ya.');
  if (order.cart.length && order.fulfillment && order.name) {
    await _sendInvoiceAndQris(phone, order);
  } else {
    await _sendText(phone, 'Tinggal lengkapi nama' + (order.address ? '' : ' & alamat') + ' ya Kak 🤍');
  }
  state.messages.push({ role: 'assistant', content: '[sistem: lokasi diterima, ongkir ' + _formatRupiah(order.ongkir || 0) + ']' });
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

  // 4) Cost guard check
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

  // 5) Everything else → the agent
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

  // 7) If agent finalized, send invoice + QRIS
  if (o.finalize) {
    await _sendInvoiceAndQris(phone, o);
  }

  // 8) Persist state
  saveState(phone, { messages: r.messages, order: o });

  return true;
}

module.exports = { init, processTurn, isPaused, loadState, saveState };
