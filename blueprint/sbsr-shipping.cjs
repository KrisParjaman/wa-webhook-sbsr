/**
 * sbsr-shipping.cjs — CommonJS port of sbsr-shipping.mjs
 * DETERMINISTIC ongkir + invoice for Sentuh Rasa. No LLM touches money.
 *   quoteOngkir(lat,lng,cart) → { available, ongkir, eta, courier }
 *   invoiceText(order)        → warm invoice string with EXACT numbers
 *
 * NOTE: set ORIGIN to the real Sentuh Rasa store coords before going live (Cipinang
 * Muara, Jakarta Timur). The placeholder below is approximate.
 */
'use strict';

const { formatRupiah } = require('./sbsr-catalog.cjs');

const BITESHIP_KEY = process.env.BITESHIP_API_KEY || "";
const SIM = process.env.ROSALIE_SIM === "1" || process.env.SBSR_SIM === "1";
const ORIGIN = {
  lat: parseFloat(process.env.SBSR_ORIGIN_LAT || "-6.2253"),   // Cipinang Muara, Jakarta Timur (approx — set real value)
  lng: parseFloat(process.env.SBSR_ORIGIN_LNG || "106.8756"),
};

function subtotalOf(cart) { return (cart || []).reduce((s, i) => s + i.price * i.qty, 0); }

function haversineKm(a1, o1, a2, o2) {
  const R = 6371;
  const dLa = (a2 - a1) * Math.PI / 180;
  const dLo = (o2 - o1) * Math.PI / 180;
  const x = Math.sin(dLa / 2) ** 2 + Math.cos(a1 * Math.PI / 180) * Math.cos(a2 * Math.PI / 180) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

async function quoteOngkir(lat, lng, cart) {
  const distKm = haversineKm(ORIGIN.lat, ORIGIN.lng, lat, lng);
  if (SIM || !BITESHIP_KEY) {
    // offline: deterministic estimate so the flow is testable
    const ongkir = Math.max(10000, Math.round((10000 + distKm * 2500) / 1000) * 1000);
    return { available: true, ongkir, eta: "1-3 jam", courier: "Instant (estimasi)", distKm: +distKm.toFixed(1), _estimate: true };
  }
  try {
    const items = (cart || []).map(i => ({ name: i.name, value: i.price, quantity: i.qty, weight: 200 * (i.pack || 1) }));
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch("https://api.biteship.com/v1/rates/couriers", {
      method: "POST", headers: { Authorization: BITESHIP_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        origin_latitude: ORIGIN.lat, origin_longitude: ORIGIN.lng,
        destination_latitude: lat, destination_longitude: lng,
        couriers: "gojek,grab",
        items: items.length ? items : [{ name: "order", value: 50000, quantity: 1, weight: 500 }],
      }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) return { available: false, distKm: +distKm.toFixed(1) };
    const data = await res.json();
    const p = (data.pricing || []).filter(x => x.price > 0).sort((a, b) => a.price - b.price)[0];
    if (!p) return { available: false, distKm: +distKm.toFixed(1) };
    return { available: true, ongkir: p.price, eta: p.duration || p.shipment_duration_range || "", courier: (p.courier_name || "") + " " + (p.courier_service_name || ""), distKm: +distKm.toFixed(1) };
  } catch (e) { return { available: false, distKm: +distKm.toFixed(1) }; }
}

function buildInvoice(order) {
  const subtotal = subtotalOf(order.cart);
  const ongkir = order.fulfillment === "pickup" ? 0 : (order.ongkir || 0);
  const lines = (order.cart || []).map(i => `• ${i.name} ${i.form || ""} ${i.pack}pcs × ${i.qty} — ${formatRupiah(i.price * i.qty)}`).join("\n");
  return { subtotal, ongkir, grandTotal: subtotal + ongkir, lines };
}

function invoiceText(order) {
  const inv = buildInvoice(order);
  let t = "🧾 *Ringkasan Pesanan*\n\n" + inv.lines + "\n\n💰 Subtotal: " + formatRupiah(inv.subtotal);
  if (order.fulfillment === "pickup") t += "\n🏪 Pickup (ambil sendiri) — tanpa ongkir";
  else t += "\n🛵 Ongkir: " + formatRupiah(inv.ongkir) + (order.ongkir_eta ? " (est. " + order.ongkir_eta + ")" : "");
  t += "\n\n*TOTAL: " + formatRupiah(inv.grandTotal) + "*";
  return t;
}

module.exports = { quoteOngkir, invoiceText, buildInvoice, subtotalOf };
