/**
 * sbsr-shipping.cjs — DETERMINISTIC ongkir + invoice for Sentuh Rasa.
 * No LLM touches money. Full delivery rules (20 rules implemented).
 *
 *   analyzeCart(cart)         → { gorengBox6, gorengBox12, frozenPacks, isMixed }
 *   pickCouriers(cart)        → courier string for Biteship (rules 1-10)
 *   quoteOngkir(lat,lng,cart,courierPreference)
 *     → { available, ongkir, eta, courier, distKm, needsFrozenChoice?, retries }
 *   validateStartup()         → { ok:bool, error?:string }
 *   buildInvoice(order)       → { subtotal, ongkir, grandTotal, lines }
 *   invoiceText(order)        → formatted WhatsApp message
 */
'use strict';

const { formatRupiah } = require('./sbsr-catalog.cjs');

const BITESHIP_KEY = process.env.BITESHIP_API_KEY || "";
const SIM = process.env.ROSALIE_SIM === "1" || process.env.SBSR_SIM === "1";
const ORIGIN = {
  lat: parseFloat(process.env.SBSR_ORIGIN_LAT || "-6.2253"),
  lng: parseFloat(process.env.SBSR_ORIGIN_LNG || "106.8756"),
};

// ═══ Cart Analysis (rules 1-10) ══════════════════════════════════════

function _countByForm(cart, form) {
  return (cart || []).filter(i => i.form === form).reduce((s, i) => s + (i.qty || 1), 0);
}

function _countFrozenPacks(cart) {
  return (cart || []).filter(i => i.form === 'frozen').reduce((s, i) => s + (i.qty || 1), 0);
}

function _countGorengBox12(cart) {
  return (cart || []).filter(i => i.form === 'goreng' && i.pack === 12).reduce((s, i) => s + (i.qty || 1), 0);
}

function _countGorengBox6(cart) {
  return (cart || []).filter(i => i.form === 'goreng' && i.pack === 6).reduce((s, i) => s + (i.qty || 1), 0);
}

function analyzeCart(cart) {
  if (!cart || !cart.length) return { gorengBox6: 0, gorengBox12: 0, frozenPacks: 0, isMixed: false, isEmpty: true };
  const gorengBox6 = _countGorengBox6(cart);
  const gorengBox12 = _countGorengBox12(cart);
  const frozenPacks = _countFrozenPacks(cart);
  const hasGoreng = _countByForm(cart, 'goreng') > 0;
  const hasFrozen = frozenPacks > 0;
  return {
    gorengBox6, gorengBox12, frozenPacks,
    hasGoreng, hasFrozen,
    isMixed: hasGoreng && hasFrozen,
    isFrozenOnly: hasFrozen && !hasGoreng,
    isGorengOnly: hasGoreng && !hasFrozen,
    isEmpty: false,
  };
}

/**
 * Pick courier string based on cart contents — RULES 1-10.
 * Returns { couriers: string, needsFrozenChoice: bool, frozenOptions: [] }
 */
function pickCouriers(cart) {
  const a = analyzeCart(cart);
  if (a.isEmpty) return { couriers: "gojek,grab", needsFrozenChoice: false, rule: 20 };

  // ── Rules 1-4: Goreng-only ──────────────────────────
  if (a.isGorengOnly) {
    const total12 = a.gorengBox12;
    const total6 = a.gorengBox6;
    if (total12 > 4)    return { couriers: "gosend", needsFrozenChoice: false, rule: 2, vehicle: "mobil" };
    if (total6 > 8)     return { couriers: "gosend", needsFrozenChoice: false, rule: 4, vehicle: "mobil" };
    if (total12 <= 4 && total12 > 0) return { couriers: "gosend", needsFrozenChoice: false, rule: 1, vehicle: "motor" };
    if (total6 <= 8 && total6 > 0)   return { couriers: "gosend", needsFrozenChoice: false, rule: 3, vehicle: "motor" };
    return { couriers: "gosend", needsFrozenChoice: false, rule: "1-4", vehicle: "motor" };
  }

  // ── Rules 5-8: Frozen-only ──────────────────────────
  if (a.isFrozenOnly) {
    const fp = a.frozenPacks;
    if (fp > 8)  return { couriers: "paxel,gosend", needsFrozenChoice: true, frozenOptions: ["Paxel Custom", "Gosend Mobil"], rule: 8 };
    if (fp > 6)  return { couriers: "paxel,gosend", needsFrozenChoice: true, frozenOptions: ["Paxel L", "Gosend Motor"], rule: 7 };
    if (fp > 3)  return { couriers: "paxel,gosend", needsFrozenChoice: true, frozenOptions: ["Paxel M", "Gosend Motor"], rule: 6 };
    return { couriers: "paxel,gosend", needsFrozenChoice: true, frozenOptions: ["Paxel S", "Gosend Motor"], rule: 5 };
  }

  // ── Rules 9-10: Mixed ───────────────────────────────
  if (a.isMixed) {
    if (a.gorengBox12 <= 4 && a.frozenPacks <= 8)
      return { couriers: "gosend", needsFrozenChoice: false, rule: 9, vehicle: "motor" };
    return { couriers: "gosend", needsFrozenChoice: false, rule: 10, vehicle: "mobil" };
  }

  return { couriers: "gojek,grab", needsFrozenChoice: false, rule: "default" };
}

// ═══ Distance ═══════════════════════════════════════════════════════

function haversineKm(a1, o1, a2, o2) {
  const R = 6371;
  const dLa = (a2 - a1) * Math.PI / 180;
  const dLo = (o2 - o1) * Math.PI / 180;
  const x = Math.sin(dLa / 2) ** 2 + Math.cos(a1 * Math.PI / 180) * Math.cos(a2 * Math.PI / 180) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

// ═══ Quote (rules 16-18) ════════════════════════════════════════════

/**
 * Quote ongkir from Biteship with smart courier selection + 2-retry with backoff.
 * @param {number} lat
 * @param {number} lng
 * @param {Array} cart
 * @param {string} [courierOverride] - customer's courier preference (rules 12-15)
 * @returns {Promise<object>}
 */
async function quoteOngkir(lat, lng, cart, courierOverride) {
  const distKm = haversineKm(ORIGIN.lat, ORIGIN.lng, lat, lng);

  // Sim mode or no key: deterministic estimate
  if (SIM || !BITESHIP_KEY) {
    const ongkir = Math.max(10000, Math.round((10000 + distKm * 2500) / 1000) * 1000);
    const courierInfo = pickCouriers(cart);
    return { available: true, ongkir, eta: "1-3 jam", courier: courierInfo.couriers + " (estimasi)", distKm: +distKm.toFixed(1), _estimate: true, courierInfo };
  }

  const courierInfo = pickCouriers(cart);
  const couriers = courierOverride || courierInfo.couriers; // Rules 12-15: customer override

  // Build items payload
  const items = (cart || []).map(i => ({
    name: i.name, value: i.price, quantity: i.qty || 1, weight: 200 * (i.pack || 1),
  }));
  if (!items.length) {
    items.push({ name: "order", value: 50000, quantity: 1, weight: 500 }); // Rule 20: default
  }

  // ═══ Rule 17: Biteship 5xx → 2 retries with backoff ═══
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      const res = await fetch("https://api.biteship.com/v1/rates/couriers", {
        method: "POST",
        headers: { Authorization: BITESHIP_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          origin_latitude: ORIGIN.lat,
          origin_longitude: ORIGIN.lng,
          destination_latitude: lat,
          destination_longitude: lng,
          couriers: couriers,
          items: items,
        }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        lastError = { status: res.status, body: await res.text().catch(() => "").slice(0, 100) };
        if (res.status >= 500) {
          // Backoff before retry
          if (attempt === 0) await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        return { available: false, distKm: +distKm.toFixed(1), error: "Biteship " + res.status, courierInfo };
      }

      const data = await res.json();
      const pricing = (data.pricing || []).filter(x => x.price > 0);

      // For frozen choice: return top 2 options instead of just cheapest
      if (courierInfo.needsFrozenChoice && pricing.length >= 2) {
        const sorted = pricing.sort((a, b) => a.price - b.price);
        return {
          available: true,
          ongkir: sorted[0].price, // default = cheapest
          eta: sorted[0].duration || sorted[0].shipment_duration_range || "",
          courier: (sorted[0].courier_name || "") + " " + (sorted[0].courier_service_name || ""),
          distKm: +distKm.toFixed(1),
          courierInfo,
          frozenOptions: sorted.slice(0, 2).map(p => ({
            courier: (p.courier_name || "") + " " + (p.courier_service_name || ""),
            ongkir: p.price,
            eta: p.duration || p.shipment_duration_range || "",
          })),
        };
      }

      const p = pricing.sort((a, b) => a.price - b.price)[0];
      if (!p) return { available: false, distKm: +distKm.toFixed(1), error: "no_courier_available", courierInfo };

      return {
        available: true,
        ongkir: p.price,
        eta: p.duration || p.shipment_duration_range || "",
        courier: (p.courier_name || "") + " " + (p.courier_service_name || ""),
        distKm: +distKm.toFixed(1),
        courierInfo,
        retries: attempt,
      };
    } catch (e) {
      lastError = { message: e.message };
      if (attempt === 0) await new Promise(r => setTimeout(r, 1000));
    }
  }

  // ═══ Rule 16 + 18: Out of coverage or all retries failed ═══
  return {
    available: false,
    distKm: +distKm.toFixed(1),
    error: lastError ? (lastError.message || lastError.status || "biteship_failed") : "biteship_failed",
    courierInfo,
    needsEscalate: true, // Rule 16: escalate to admin
  };
}

// ═══ Startup validation (rule 19) ════════════════════════════════════

function validateStartup() {
  if (!BITESHIP_KEY) {
    return { ok: false, error: "BITESHIP_API_KEY missing — ongkir will use estimates only" };
  }
  if (!ORIGIN.lat || !ORIGIN.lng) {
    return { ok: false, error: "SBSR_ORIGIN_LAT/LNG not set — shipping origin unknown" };
  }
  return { ok: true };
}

// ═══ Invoice ═════════════════════════════════════════════════════════

function subtotalOf(cart) { return (cart || []).reduce((s, i) => s + i.price * i.qty, 0); }

function buildInvoice(order) {
  const subtotal = subtotalOf(order.cart);
  const ongkir = order.fulfillment === "pickup" ? 0 : (order.ongkir || 0);
  const lines = (order.cart || []).map(i =>
    `• ${i.name} ${i.form || ""} ${i.pack}pcs × ${i.qty} — ${formatRupiah(i.price * i.qty)}`
  ).join("\n");
  return { subtotal, ongkir, grandTotal: subtotal + ongkir, lines };
}

function invoiceText(order) {
  const inv = buildInvoice(order);
  let t = "🧾 *Ringkasan Pesanan*\n\n" + inv.lines + "\n\n💰 Subtotal: " + formatRupiah(inv.subtotal);
  if (order.fulfillment === "pickup") {
    t += "\n🏪 Pickup (ambil sendiri) — tanpa ongkir";
  } else {
    t += "\n🛵 Ongkir: " + formatRupiah(inv.ongkir)
      + (order.ongkir_eta ? " (est. " + order.ongkir_eta + ")" : "");
    if (order.ongkir_courier) t += "\n🚚 Kurir: " + order.ongkir_courier;
  }
  t += "\n\n*TOTAL: " + formatRupiah(inv.grandTotal) + "*";
  return t;
}

module.exports = {
  analyzeCart, pickCouriers,
  quoteOngkir, validateStartup,
  buildInvoice, invoiceText, subtotalOf,
  haversineKm,
};
