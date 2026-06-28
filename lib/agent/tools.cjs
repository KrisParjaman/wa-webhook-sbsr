// tools.cjs — Agent tool registry.
// Each tool is a deterministic function that reads/writes ctx state.
// LLM never computes money — tools are the single source of truth.

'use strict';

const TOOLS = {};

function register(name, description, parameters, handler) {
  TOOLS[name] = { name, description, parameters, handler };
}

function list() { return Object.values(TOOLS); }

async function execute(name, args, ctx) {
  const tool = TOOLS[name];
  if (!tool) return { error: 'unknown tool: ' + name };
  try {
    const result = await tool.handler(args, ctx);
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ═══════════════════════════════════════════════════════════════════
// TOOL DEFINITIONS
// ═══════════════════════════════════════════════════════════════════

// ── Cart management ─────────────────────────────────────────────────

register('add_to_cart', 'Tambah item ke keranjang. Panggil setelah customer sebut produk + qty.',
  { variant: 'string (ayam_sayur, smoked_beef, ragout_creamy, mercon_chili, ayam_pedas, mix)',
    form: 'string (goreng atau frozen)',
    qty: 'number (jumlah pieces: 3, 6, atau 12)',
    notes: 'string? (catatan tambahan)' },
  (args, ctx) => {
    const { variant, form, qty } = args;
    const catalog = ctx._catalogSnapshot || {};
    const categories = catalog.categories || [];

    // Find product
    let product = null;
    for (const cat of categories) {
      if (cat.id !== (form === 'frozen' ? 'frozen' : 'goreng')) continue;
      for (const v of cat.variants || []) {
        if (v.aliases && v.aliases.some(a => variant.toLowerCase().includes(a.toLowerCase()))) {
          product = v; break;
        }
      }
      if (product) break;
    }

    if (!product) return { error: 'produk tidak ditemukan: ' + variant + ' ' + form };

    const price = product.prices?.[String(qty)] || product.prices?.['6'] || 55000;
    const item = {
      sku: product.id + '_' + form,
      name: product.name + (form === 'frozen' ? ' Frozen' : ''),
      variant: product.slug,
      form, qty,
      unit_price: price,
      pack_size: form === 'frozen' ? 12 : qty,
    };

    const items = [...(ctx.cart || []), item];
    const subtotal = items.reduce((s, i) => s + (i.unit_price * i.qty / (i.pack_size || 1)), 0);
    ctx.updateDraft({ items, subtotal, state: 'cart_built' });
    ctx.saveDraft();

    return { item, subtotal, cart_count: items.length, state: 'cart_built' };
  }
);

register('set_form', 'Set form (goreng/frozen) untuk SEMUA item di cart. Panggil saat customer menjawab pertanyaan goreng/frozen.',
  { form: 'string ("goreng" atau "frozen")' },
  (args, ctx) => {
    const form = args.form.toLowerCase();
    if (form !== 'goreng' && form !== 'frozen') return { error: 'form harus goreng atau frozen' };
    const items = ctx.cart.map(it => ({ ...it, form }));
    const hasItems = items.length > 0;
    ctx.updateDraft({ items, ...(hasItems ? { state: 'cart_built' } : {}) });
    ctx.saveDraft();
    return { updated: items.length, form, state: hasItems ? 'cart_built' : ctx.state };
  }
);

register('remove_from_cart', 'Hapus item dari keranjang.',
  { index: 'number (index item, mulai dari 0)' },
  (args, ctx) => {
    const items = [...ctx.cart];
    const removed = items.splice(args.index, 1);
    const subtotal = items.reduce((s, i) => s + (i.unit_price * i.qty / (i.pack_size || 1)), 0);
    ctx.updateDraft({ items, subtotal });
    ctx.saveDraft();
    return { removed: removed[0]?.name, cart_count: items.length };
  }
);

register('clear_cart', 'Kosongkan seluruh keranjang.',
  {},
  (args, ctx) => {
    ctx.updateDraft({ items: [], addons: [], subtotal: 0 });
    ctx.saveDraft();
    return { cleared: true };
  }
);

// ── Customer info ───────────────────────────────────────────────────

register('set_customer_name', 'Simpan nama customer.',
  { name: 'string (nama lengkap)' },
  (args, ctx) => {
    ctx.updateDraft({ customer_name: args.name, state: 'awaiting_address' });
    ctx.saveDraft();
    return { name: args.name };
  }
);

register('set_address', 'Simpan alamat pengiriman.',
  { address: 'string (alamat lengkap)', maps_url: 'string? (google maps link)' },
  (args, ctx) => {
    const patch = { address_text: args.address, state: 'awaiting_delivery_method' };
    if (args.maps_url) patch.gmaps_link = args.maps_url;
    ctx.updateDraft(patch);
    ctx.saveDraft();
    return { address: args.address };
  }
);

// ── Order flow ──────────────────────────────────────────────────────

register('set_delivery', 'Set metode pengiriman.',
  { method: 'string ("delivery" atau "pickup")' },
  (args, ctx) => {
    const method = args.method.toLowerCase();
    ctx.updateDraft({ delivery_mode: method, state: method === 'pickup' ? 'awaiting_payment' : 'awaiting_name' });
    ctx.saveDraft();
    return { method };
  }
);

register('confirm_order', 'Konfirmasi pesanan dan lanjut ke pembayaran. Panggil saat customer bilang ok/ya/lanjut.',
  {},
  (args, ctx) => {
    const cart = ctx.cart;
    if (!cart.length) return { error: 'keranjang kosong' };
    const hasFrozen = cart.some(it => it.form === 'frozen');
    const hasGoreng = cart.some(it => it.form === 'goreng');
    const subtotal = cart.reduce((s, i) => s + (i.unit_price * i.qty / (i.pack_size || 1)), 0);

    ctx.updateDraft({
      state: 'awaiting_delivery_method',
      subtotal,
      use_case: hasFrozen && !hasGoreng ? 'stock_frozen' : 'makan_langsung',
    });
    ctx.saveDraft();

    return {
      confirmed: true,
      items: cart.length,
      subtotal,
      has_frozen: hasFrozen,
      needs_courier_choice: hasFrozen,
    };
  }
);

register('cancel_order', 'Batalkan pesanan dan reset state.',
  {},
  (args, ctx) => {
    ctx.updateDraft({
      state: 'initial', items: [], addons: [], subtotal: 0,
      customer_name: '', address_text: '', delivery_mode: '',
      gmaps_link: '', destination: null, use_case: '',
    });
    ctx.saveDraft();
    return { cancelled: true };
  }
);

// ── FAQ / Info ──────────────────────────────────────────────────────

register('get_faq', 'Cari jawaban FAQ.',
  { query: 'string (pertanyaan customer)' },
  (args, ctx) => {
    const catalog = ctx._catalogSnapshot || {};
    const faqs = catalog.faq || [];
    const q = (args.query || '').toLowerCase();
    for (const faq of faqs) {
      if (faq.q.toLowerCase().includes(q) || q.includes(faq.q.toLowerCase().slice(0, 10))) {
        return { found: true, answer: faq.a };
      }
    }
    return { found: false };
  }
);

register('get_catalog', 'Dapatkan katalog produk lengkap dengan harga.',
  {},
  (args, ctx) => {
    const catalog = ctx._catalogSnapshot || {};
    const out = [];
    for (const cat of catalog.categories || []) {
      out.push(cat.name + ':');
      for (const v of cat.variants || []) {
        const prices = Object.entries(v.prices || {}).map(([q, p]) => q + 'pcs=Rp' + Number(p).toLocaleString('id-ID')).join(' | ');
        out.push('  • ' + v.name + ' — ' + prices);
      }
    }
    return { catalog: out.join('\n') };
  }
);

// ── Add-ons ─────────────────────────────────────────────────────────

register('add_addon', 'Tambah add-on ke pesanan.',
  { addon: 'string (chili_sauce, thermal_bag, ice_gel, greeting_card, mika_bag, iced_tea, matcha)' },
  (args, ctx) => {
    const addonMap = {
      chili_sauce: { sku: 'ADD-CHILI', name: 'Chili Sauce 50ml', price: 4000 },
      thermal_bag: { sku: 'ADD-THERMAL-REGULER', name: 'Thermal Bag Reguler', price: 8000 },
      thermal_premium: { sku: 'ADD-THERMAL', name: 'Thermal Bag Premium', price: 30000 },
      ice_gel: { sku: 'ADD-ICE-GEL', name: 'Ice Gel', price: 3000 },
      greeting_card: { sku: 'ADD-GREETING', name: 'Greeting Card', price: 3000 },
      mika_bag: { sku: 'ADD-MIKA-BAG', name: 'Mika Bag', price: 15000 },
      iced_tea: { sku: 'ADD-ICE-TEA', name: 'Iced Java Tea', price: 15000 },
      matcha: { sku: 'ADD-MATCHA', name: 'Iced Matcha', price: 15000 },
    };
    const addon = addonMap[args.addon];
    if (!addon) return { error: 'addon tidak dikenal: ' + args.addon };
    const addons = [...(ctx.draft.addons || []), { ...addon, qty: 1, unit_price: addon.price }];
    ctx.updateDraft({ addons });
    ctx.saveDraft();
    return { added: addon.name, price: addon.price };
  }
);

// ── Menu ──────────────────────────────────────────────────────────

register('send_menu', 'Kirim daftar menu lengkap ke customer. Panggil saat customer minta lihat menu/daftar harga/katalog.',
  {},
  (args, ctx) => {
    try {
      const catalog = require('../catalog-manager.cjs');
      const menu = catalog.formatMenuText();
      const faq = catalog.formatFaqText();
      return { menu: menu + '\n' + faq };
    } catch (_) {
      return { menu: '*Menu Sentuh Rasa — Risol Otentik*\n\n*RISOLES GORENG (Makan Langsung)*\n• Ayam Sayur — 3pcs 29k / 6pcs 55k / 12pcs 105k\n• Smoked Beef Mayo — 3pcs 29k / 6pcs 55k / 12pcs 105k\n• Ragout Creamy — 3pcs 29k / 6pcs 55k / 12pcs 105k\n• Ayam Mercon Chili Oil 🔥 — 3pcs 33k / 6pcs 63k / 12pcs 120k\n• Mix Risol — 3pcs 29k / 6pcs 55k / 12pcs 105k\n\n*RISOLES FROZEN (Stok — 6pcs/pack)*\n• Ayam Sayur Frozen — 55k\n• Smoked Beef Frozen — 55k\n• Ragout Creamy Frozen — 55k\n• Ayam Mercon Chili Oil Frozen 🔥 — 63k\n• Mix Frozen — 55k\n\n*ADD-ON*\n• Chili Sauce 50ml — 4k\n• Thermal Bag Reguler — 8k | Premium — 30k\n• Ice Gel — 3k\n• Mika Bag — 15k\n• Greeting Card — 3k' };
    }
  }
);

module.exports = { register, list, execute, TOOLS };
