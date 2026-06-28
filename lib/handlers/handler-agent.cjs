// handler-agent.cjs — Deterministic intent handler (runs FIRST).
// No LLM — pure regex pattern matching for reliability.

'use strict';

let _agentCore = null;
let _enabled = true;
function init(core) { _agentCore = core; }

// ── Patterns ─────────────────────────────────────────────────────────
const MENU_RE = /\b(?:m[eua]nu|lihat|daftar|ada\s*apa|catalog|katalog|pricelist|list\s*harga|menu[nya]*)\b/i;
const GREETING_RE = /^(?:hi|halo|hai|hallo|hello|pagi|siang|sore|malam|assalam)\b/i;
const ORDER_INTENT_RE = /\b(?:pesan|order|beli|mau|pesen|mesan|pengen|ingin|butuh|bikin)\b/i;
const RESET_RE = /\b(?:reset|mulai\s*(?:lagi|ulang)|batalkan|batalin|cancel)\b/i;
const FAQ_PICKUP_RE = /\b(?:dimana|alamat|pickup|pick\s*up|ambil\s*sendiri|mampir|lokasi|maps)\b/i;
const FAQ_HALAL_RE = /\bhalal\b/i;
const FAQ_SHELF_RE = /\b(?:tahan|awet|expired?|kadaluarsa|freezer|chiller|simpan)\b/i;
const FAQ_GORENG_RE = /\b(?:cara\s+goreng|gorengnya|masaknya|masak)\b/i;
const FAQ_RESELLER_RE = /\b(?:reseller|agen|jualan)\b/i;
const FAQ_MIN_RE = /\b(?:minimum|minimal|min\s+order)\b/i;
const FAQ_DELIVERY_RE = /\b(?:pengiriman|dikirim|kirimnya|delivery|diantar|ongkir)\b/i;
const FAQ_AIRFRYER_RE = /\b(?:air\s*fryer|airfryer)\b/i;

// Product matching
const PRODUCT_RE = /(ayam\s*sayur|smoked\s*beef|ragout\s*creamy|mercon|chili\s*oil|ayam\s*pedas|original|creamy\s*chicken|mix)/i;
const QTY_RE = /(\d+)\s*(?:pcs|pack|buah|biji|box|pc|pk)/i;
const FORM_GORENG_RE = /\b(?:goreng|siap\s*makan|makan\s*langsung|langsung\s*makan|matang|ready\s*to\s*eat)\b/i;
const FORM_FROZEN_RE = /\b(?:frozen|mentah|stok|beku|simpan|stock|freezer)\b/i;
const PICKUP_RE = /\b(?:pickup|pick\s*up|ambil\s*sendiri|mampir)\b/i;

function match(state, ctx) {
  if (!_enabled) return false;
  const t = ctx.text.trim();
  return t.length >= 2 && !t.startsWith('/');
}

async function handler(ctx) {
  const t = ctx.text.trim().toLowerCase();
  ctx.log('det', 'text=' + t.slice(0,50));

  // ── 1. Reset / Cancel ─────────────────────────────────────────
  if (RESET_RE.test(t) && t.length < 15) {
    ctx.updateDraft({ state:'initial', items:[], addons:[], subtotal:0, customer_name:'', address_text:'', delivery_mode:'', use_case:'' });
    ctx.saveDraft();
    ctx.replyText = 'Siap Kak! Pesanan direset ya 🤍 Mau lihat menu atau langsung order?';
    ctx.handled = true; return;
  }

  // ── 2. Menu request (including typos like "manu") ──────────────
  if (MENU_RE.test(t) && !PRODUCT_RE.test(t)) {
    try {
      const cat = require('../catalog-manager.cjs');
      ctx.replyText = cat.formatMenuText();
      ctx.handled = true;
      ctx.log('det','menu'); return;
    } catch(_){}
  }

  // ── 3. FAQ ────────────────────────────────────────────────────
  if (t.length < 60) {
    if (FAQ_PICKUP_RE.test(t)) {
      ctx.replyText = '📍 Sentuh Rasa di Jl Nusa Indah Raya blok O no 10, Cipinang Muara, Kec Jatinegara, Jakarta Timur\n🗺️ Maps: https://share.google/ykWkdLTDJgG2UVfOQ\n📞 CP: +62 811 1321 166\n\nBisa pickup atau delivery 🤍';
      ctx.handled = true; ctx.log('det','faq-pickup'); return;
    }
    if (FAQ_HALAL_RE.test(t)) {
      ctx.replyText = 'InsyaAllah semua produk Sentuh Rasa halal ya Kak 🤍 Sertifikasi sedang dalam proses.';
      ctx.handled = true; ctx.log('det','faq-halal'); return;
    }
    if (FAQ_SHELF_RE.test(t)) {
      ctx.replyText = 'Frozen tahan 1-2 bulan di freezer, 1-2 hari di chiller. Suhu ruang 2-3 jam. Kalau udah digoreng langsung santap ya 🤍';
      ctx.handled = true; ctx.log('det','faq-shelf'); return;
    }
    if (FAQ_GORENG_RE.test(t)) {
      ctx.replyText = 'Goreng langsung dari frozen ya Kak. Minyak panas, api sedang, sampai golden brown. Gak perlu di-thaw 🤍';
      ctx.handled = true; ctx.log('det','faq-goreng'); return;
    }
    if (FAQ_RESELLER_RE.test(t)) {
      ctx.replyText = 'Untuk reseller: 4 pack Rp47rb/pack, 6 pack Rp46rb/pack, 10 pack Rp45rb/pack. Info lebih lanjut bisa chat admin ya 🤍';
      ctx.handled = true; ctx.log('det','faq-reseller'); return;
    }
    if (FAQ_MIN_RE.test(t)) {
      ctx.replyText = 'Minimum order Rp50.000 ya Kak 🤍';
      ctx.handled = true; ctx.log('det','faq-min'); return;
    }
    if (FAQ_DELIVERY_RE.test(t)) {
      ctx.replyText = 'Pengiriman dari Cipinang, Jakarta Timur. Bisa Gojek/Grab/Paxel. Ongkir dihitung setelah alamat lengkap + pin maps dikirim ya 🤍';
      ctx.handled = true; ctx.log('det','faq-delivery'); return;
    }
    if (FAQ_AIRFRYER_RE.test(t)) {
      ctx.replyText = 'Bisa pakai air fryer juga ya Kak 🤍 Sesuaikan suhu dan waktu sampai golden brown.';
      ctx.handled = true; ctx.log('det','faq-airfryer'); return;
    }
  }

  // ── 4. Product order ──────────────────────────────────────────
  if (PRODUCT_RE.test(t) && QTY_RE.test(t)) {
    const variant = (t.match(PRODUCT_RE)||[])[1]||'';
    const qty = parseInt((t.match(QTY_RE)||[])[1]||'6',10);
    const isFrozen = FORM_FROZEN_RE.test(t);
    const isGoreng = FORM_GORENG_RE.test(t);
    const form = isFrozen ? 'frozen' : (isGoreng ? 'goreng' : 'goreng');

    // Count distinct products
    const allProducts = t.match(new RegExp(PRODUCT_RE.source,'gi'))||[];
    const allQtys = t.match(new RegExp(QTY_RE.source,'gi'))||[];

    if (allProducts.length === 1 && allQtys.length === 1) {
      try {
        const tools = require('../agent/tools.cjs');
        const r = await tools.execute('add_to_cart',{variant,form,qty},ctx);
        if (r.ok) {
          const item = r.result.item||{};
          const price = (item.unit_price||0) * qty;
          ctx.replyText = `Siap! ${item.name||variant} ${qty}pcs ${form} dicatat ya 🤍${price>0?' Rp'+Number(price).toLocaleString('id-ID'):''}. Mau tambah apa lagi?`;
          ctx.handled = true; ctx.log('det','order-single'); return;
        }
      } catch(_){}
    } else {
      ctx.replyText = `Mintu catat: ${allProducts.join(', ')}. Mau ${isFrozen?'frozen':isGoreng?'goreng':'goreng atau frozen'}? Dan berapa pcs masing-masing? 🤍`;
      ctx.handled = true; ctx.log('det','order-multi'); return;
    }
  }

  // Product mentioned without qty
  if (PRODUCT_RE.test(t) && ORDER_INTENT_RE.test(t) && !QTY_RE.test(t)) {
    const p = (t.match(PRODUCT_RE)||[])[1]||'';
    ctx.replyText = `Mau ${p} berapa pcs ya Kak? Dan yang goreng (siap makan) atau frozen (stok rumah)? 🤍`;
    ctx.handled = true; ctx.log('det','order-noqty'); return;
  }

  // ── 5. Greeting ───────────────────────────────────────────────
  if (GREETING_RE.test(t) && t.length < 20) {
    ctx.replyText = 'Halo Kak! Selamat datang di *Sentuh Rasa — Risol Otentik* 🤍\n\nMintu siap bantu. Mau:\n• Lihat menu\n• Order langsung (sebut produk + qty)\n• Tanya-tanya\n\nKetik aja ya Kak~';
    ctx.handled = true; ctx.log('det','greeting'); return;
  }

  // ── 6. General order intent (no product specified) ────────────
  if (ORDER_INTENT_RE.test(t) && !PRODUCT_RE.test(t) && t.length < 30) {
    ctx.replyText = 'Siap Kak! Mau pesan varian apa? Ketik aja produknya, misal: "ayam sayur 6pcs goreng" 🤍\n\nAtau mau lihat *menu* dulu?';
    ctx.handled = true; ctx.log('det','order-intent'); return;
  }

  // ── 7. Pickup intent ──────────────────────────────────────────
  if (PICKUP_RE.test(t) && ctx.cart.length > 0) {
    ctx.updateDraft({delivery_mode:'pickup'});
    ctx.saveDraft();
    ctx.replyText = 'Siap Kak! Pickup di Jl Nusa Indah Raya blok O no 10, Cipinang Muara, Jatinegara ya 🤍\n\nKalau mau lanjut, balas *OK*.';
    ctx.handled = true; ctx.log('det','pickup'); return;
  }

  // ── 8. Fallback ───────────────────────────────────────────────
  // Let other pipeline handlers try
  ctx.log('det','fallthrough');
}
module.exports = { init, match, handler };
