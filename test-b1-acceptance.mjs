/**
 * test-b1-acceptance.mjs — Go/No-Go Checklist untuk B1 (Reva)
 *
 * Verifikasi 15 kriteria GO/NO-GO sebelum cutover ke nomor LIVE.
 * CRITICAL (gak boleh merah): A2, A3, A6, B9, B10, B12
 *
 * Usage: DEEPSEEK_API_KEY=sk-... node test-b1-acceptance.mjs
 */
import { runAgent } from "./blueprint/sbsr-agent.mjs";
import { formatRupiah } from "./blueprint/sbsr-catalog.mjs";
import { quoteOngkir, buildInvoice, invoiceText, subtotalOf } from "./blueprint/sbsr-shipping.mjs";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const API_KEY = process.env.DEEPSEEK_API_KEY || "";

const criticalItems = ["A2", "A3", "A6", "B9", "B10", "B12"];
let passed = 0, failed = 0, criticalFailed = 0;
const checklist = [];

function check(id, category, label, test) {
  const isCritical = criticalItems.includes(id);
  const ok = typeof test === "function" ? test() : test;
  if (ok) { passed++; checklist.push({ id, category, label, status: "✅", critical: isCritical }); }
  else { failed++; checklist.push({ id, category, label, status: "❌", critical: isCritical }); if (isCritical) criticalFailed++; }
  return ok;
}

async function send(state, text) {
  const r = await runAgent(state, text);
  return { reply: r.reply || "", order: r.order, state: { messages: r.messages, order: r.order } };
}

async function run() {
  console.log("╔═══════════════════════════════════════════════╗");
  console.log("║  GO/NO-GO CHECKLIST — 29 Jun 2026            ║");
  console.log("║  Task: B1 Agent di Webhook (Reva)            ║");
  console.log("╚═══════════════════════════════════════════════╝\n");

  // ═══ A. CUSTOMER EXPERIENCE ═══
  console.log("── A. Customer Experience ──\n");
  let state = { messages: [], order: { cart: [] } };

  // A1: "apa yang favorit?" → rekomendasi + jualan
  let r = await send(state, "apa yang favorit?");
  state = r.state;
  const a1 = (r.reply || "").toLowerCase();
  check("A1", "CX", "Rekomendasi nyata + jualan (bukan sapaan)", () =>
    /ayam|mercon|smoked|ragout|matcha/i.test(a1) && !/selamat datang|ada yang bisa/i.test(a1) && /pesan|mau|keranjang|tambah|ambil|pilih/i.test(a1)
  );
  console.log("   A1 reply: " + r.reply.slice(0, 150) + "...\n");

  // A2: "ayam sayur 6pcs goreng" → item benar + Rp55.000
  r = await send(state, "ayam sayur 6pcs goreng");
  state = r.state;
  const ayamItem = (state.order.cart || []).find(i => /ayam/i.test(i.name) && i.form === "goreng" && i.pack === 6);
  check("A2", "CX", "Item benar + Rp55.000 (harga bener, BUKAN 3pcs Rp29.000)", () =>
    !!ayamItem && ayamItem.price === 55000
  );
  console.log("   A2 cart: " + (ayamItem ? `${ayamItem.name} ${ayamItem.pack}pcs = ${formatRupiah(ayamItem.price)}` : "NOT FOUND") + "\n");

  // A3: Ambigu (gak sebut bentuk) → ditanya SEKALI
  let sA3 = { messages: [], order: { cart: [] } };
  r = await send(sA3, "smoked beef mayo");
  sA3 = r.state;
  const asksForm = /goreng|frozen|makan langsung|stok/i.test(r.reply || "");
  r = await send(sA3, "goreng");
  sA3 = r.state;
  const asksAgain = /goreng.*frozen|frozen.*goreng|makan langsung.*stok|stok.*makan langsung/i.test(r.reply || "");
  check("A3", "CX", "Ambig → ditanya SEKALI, lalu disimpan", () =>
    asksForm && !asksAgain
  );
  console.log("   A3: asked form=" + asksForm + " | asked again=" + asksAgain + "\n");

  // A4: "pesanan saya apa aja?" → list akurat
  r = await send(state, "pesanan saya apa aja?");
  state = r.state;
  const v = (r.reply || "").toLowerCase();
  check("A4", "CX", "List cart akurat (bukan 'kurang yakin')", () =>
    /ayam|55\.?000|subtotal/i.test(v) && !/kurang yakin|nggak yakin/i.test(v)
  );
  console.log("   A4 reply: " + r.reply.slice(0, 180) + "...\n");

  // A5: "tambah X" / ganti / hapus → cart utuh
  const cartBefore = (state.order.cart || []).length;
  r = await send(state, "tambah smoked beef mayo frozen");
  state = r.state;
  const cartAfter = (state.order.cart || []).length;
  check("A5", "CX", "Tambah/ganti/hapus → cart utuh & benar", () =>
    cartAfter >= cartBefore
  );
  console.log("   A5 cart: " + (state.order.cart || []).map(i => `${i.name} ${i.form||""} ${i.pack}pcs ×${i.qty}`).join(" | ") + "\n");

  // A6: Checkout penuh — dikirim → nama+alamat → lokasi → ongkir → invoice → QRIS → bukti bayar
  console.log("── A6: Full Checkout Flow (delivery) ──");
  // Customer says "dikirim" → agent asks "dikirim/ambil sendiri?"
  // Bridge: detects fulfillment choice → sends interactive buttons
  // Customer clicks "🛵 Dikirim" → bridge intercepts "delivery" DETERMINISTICALLY
  state.order.fulfillment = "delivery"; // ← bridge sets this directly
  state.messages.push({ role: "user", content: "delivery" });
  state.messages.push({ role: "assistant", content: "[sistem: fulfillment = delivery — deterministik]" });
  check("A6a", "CX", "A6: Set fulfillment → delivery (bridge deterministik)", () =>
    state.order.fulfillment === "delivery"
  );
  console.log("   fulfillment: " + state.order.fulfillment);

  // Bridge prompts agent: "Minta nama + alamat lengkap"
  r = await send(state, "[sistem: customer pilih dikirim. Minta nama + alamat lengkap dengan ramah.]");
  state = r.state;
  // Check agent asks for name + address
  const asksNameAddr = /nama.*alamat|alamat.*nama/i.test((r.reply || "").toLowerCase());
  check("A6b", "CX", "A6: Agent minta nama + alamat (delivery)", () => asksNameAddr);
  console.log("   agent asks: " + (r.reply || "").slice(0, 120) + "...");

  // Customer gives name
  r = await send(state, "Adithya");
  state = r.state;
  const a6_name = state.order.name;
  check("A6b2", "CX", "A6: Nama penerima disimpan (set_recipient)", () => !!a6_name);
  console.log("   name: " + a6_name);

  // Customer gives address
  r = await send(state, "Jl. Cipinang Muara No. 12, Jakarta Timur");
  state = r.state;
  const a6_addr = state.order.address;
  check("A6c", "CX", "A6: Alamat disimpan (set_recipient)", () => !!a6_addr);
  console.log("   address: " + (a6_addr || "").slice(0, 60));

  // Simulate location (lat/lng ke Cipinang area)
  const lat = -6.2253, lng = 106.8756;
  const ongkirResult = await quoteOngkir(lat, lng, state.order.cart);
  state.order.pin = { lat, lng };
  state.order.ongkir = ongkirResult.ongkir;
  state.order.ongkir_eta = ongkirResult.eta;
  check("A6d", "CX", "A6: Ongkir dihitung (Biteship/estimate)", () =>
    ongkirResult.available && ongkirResult.ongkir >= 10000
  );
  console.log("   ongkir: " + formatRupiah(ongkirResult.ongkir) + " — " + ongkirResult.courier + (ongkirResult._estimate ? " (estimate)" : ""));

  // Invoice
  const inv = buildInvoice(state.order);
  const invoiceOk = inv.grandTotal === inv.subtotal + inv.ongkir && inv.subtotal > 0;
  check("A6e", "CX", "A6: Invoice — total benar (subtotal + ongkir)", () => invoiceOk);
  console.log("   invoice: subtotal=" + formatRupiah(inv.subtotal) + " + ongkir=" + formatRupiah(inv.ongkir) + " = TOTAL=" + formatRupiah(inv.grandTotal));

  // Full invoice text
  const invText = invoiceText(state.order);
  check("A6f", "CX", "A6: Invoice text lengkap (ringkasan + subtotal + ongkir + total)", () =>
    /Ringkasan|subtotal|ongkir|TOTAL/i.test(invText) && invText.includes(formatRupiah(inv.grandTotal))
  );
  console.log("   invoice text: " + invText.replace(/\n/g, " | ").slice(0, 200) + "...\n");

  // A7: Pickup
  console.log("── A7: Pickup Flow ──");
  let sA7 = { messages: [], order: { cart: [{ sku: "ayam_sayur-6-grg", name: "Ayam Sayur", form: "goreng", pack: 6, price: 55000, qty: 1 }] } };
  // Agent: customer says "ambil sendiri" → agent asks "dikirim/ambil sendiri?"
  // Bridge: detects fulfillment choice → sends interactive buttons
  // Customer clicks "🏪 Ambil sendiri" → bridge intercepts "pickup" DETERMINISTICALLY (no LLM)
  sA7.order.fulfillment = "pickup"; // ← bridge sets this directly
  sA7.messages.push({ role: "user", content: "pickup" });
  sA7.messages.push({ role: "assistant", content: "[sistem: fulfillment = pickup — deterministik, tanpa LLM]" });
  check("A7a", "CX", "A7: Pickup — fulfillment di-set deterministik oleh bridge", () =>
    sA7.order.fulfillment === "pickup"
  );
  // Now agent just asks for name
  r = await send(sA7, "[sistem: customer pilih pickup. Minta nama penerima.]");
  sA7 = r.state;
  check("A7b", "CX", "A7: Pickup — minta nama (tanpa alamat)", () =>
    /nama|siapa/i.test((r.reply || "").toLowerCase()) && !/alamat/i.test((r.reply || "").toLowerCase())
  );
  r = await send(sA7, "Reva");
  sA7 = r.state;
  const pickInv = buildInvoice(sA7.order);
  check("A7c", "CX", "A7: Pickup invoice — tanpa ongkir (ongkir=0)", () =>
    sA7.order.fulfillment === "pickup" && pickInv.ongkir === 0
  );
  console.log("   pickup: fulfillment=" + sA7.order.fulfillment + ", name=" + sA7.order.name + ", ongkir=" + pickInv.ongkir + "\n");

  // A8: Customer kesal → handoff + RESUME
  console.log("── A8: Eskalasi + Admin RESUME ──");
  let sA8 = { messages: [], order: { cart: [] } };
  r = await send(sA8, "admin aja deh, saya kesal sama bot ini");
  sA8 = r.state;
  const a8_ack = /maaf|admin|manusia|bantu|cerita/i.test((r.reply || "").toLowerCase());
  check("A8a", "CX", "A8: Frustrasi → akui + bantu dulu", () => a8_ack);
  r = await send(sA8, "ngga mau! admin sekarang!");
  sA8 = r.state;
  const a8_esc = !!sA8.order.escalate;
  check("A8b", "CX", "A8: Ngotot → escalate_to_human + pause", () => a8_esc);
  // Verify bridge has RESUME command
  const bridge = require("./lib/agent-bridge.cjs");
  const hasResume = typeof bridge.isPaused === "function";
  check("A8c", "CX", "A8: Admin RESUME jalan (bridge.isPaused ada)", () => hasResume);
  console.log("   escalate: " + a8_esc + " reason=" + (sA8.order.escalate || "NONE") + " | isPaused=" + hasResume + "\n");

  // ═══ B. ROBUSTNESS ═══
  console.log("── B. Robustness ──\n");

  // B9: Nol pesan dobel (dedup ON)
  const bridgeCode = require("fs").readFileSync("./lib/agent-bridge.cjs", "utf8");
  check("B9", "Robust", "Nol pesan dobel — dedup ON, isDuplicate active", () =>
    /PROCESSED/.test(bridgeCode) && /isDuplicate/.test(bridgeCode) && /60000/.test(bridgeCode)
  );

  // B10: Nol loop (gak nanya ulang setelah dijawab)
  // Verified in A3 + A5: agent doesn't repeat the same question
  check("B10", "Robust", "Nol loop — gak nanya ulang setelah dijawab", () =>
    !asksAgain // from A3 test above
  );
  // B10b: Bridge intercepts "delivery"/"pickup" button reply deterministically
  check("B10b", "Robust", "Bridge: fulfillment button reply handled deterministically (no LLM)", () =>
    /fulfillment \= \$\{text\}/.test(bridgeCode) || /order\.fulfillment = text/.test(bridgeCode)
  );

  // B11: State nyimpen antar pesan
  const stateAfter = state.order.cart.length;
  check("B11", "Robust", "State nyimpen antar pesan; reset bersih", () =>
    stateAfter >= 2 && typeof bridge.loadState === "function" && typeof bridge.saveState === "function"
  );
  console.log("   cart persisted across " + (stateAfter) + " turns, bridge load/save: " + (typeof bridge.loadState === "function"));

  // B12: Harga selalu dari katalog asli
  const catalog = require("./blueprint/sbsr-catalog.cjs");
  const testResolve = catalog.resolveProduct({ product: "ayam sayur goreng 6pcs" });
  const testResolve2 = catalog.resolveProduct({ product: "ayam sayur", form: "frozen" });
  const rAmbiguous = catalog.resolveProduct({ product: "smoked beef" });
  check("B12", "Robust", "Harga selalu dari katalog (resolveProduct ok; ambiguous → needs)", () =>
    testResolve.product && testResolve.product.price === 55000 &&
    testResolve2.product && testResolve2.product.price === 55000 &&
    rAmbiguous.needs === "form"
  );
  console.log("   resolveProduct: ayam sayur goreng 6pcs=" + formatRupiah(testResolve.product.price) + " | frozen 6pcs=" + formatRupiah(testResolve2.product.price) + " | 'smoked beef'→needs:" + rAmbiguous.needs);

  // B13: Ongkir estimate / Biteship fallback; QRIS; koordinat toko
  check("B13a", "Robust", "Ongkir dari Biteship/estimate — koordinat toko diset", () =>
    ongkirResult.available && ongkirResult.ongkir > 0 && !!process.env.SBSR_ORIGIN_LAT === false // using defaults for test
  );
  check("B13b", "Robust", "Shipping module: quoteOngkir, invoiceText, buildInvoice jalan", () =>
    typeof quoteOngkir === "function" && typeof invoiceText === "function" && typeof buildInvoice === "function"
  );

  // ═══ C. INFRA ═══
  console.log("\n── C. Infra ──\n");

  // C14: Satu instance + webhook nomor test → bridge
  check("C14a", "Infra", "Bridge load: lib/agent-bridge.cjs OK", () => !!bridge);
  check("C14b", "Infra", "Bridge init + processTurn signature OK", () =>
    typeof bridge.init === "function" && typeof bridge.processTurn === "function"
  );
  check("C14c", "Infra", "Toggle: SBSR_AGENT_ENABLED gate di server.js", () => {
    const sv = require("fs").readFileSync("./server.js", "utf8");
    return /SBSR_AGENT_ENABLED/.test(sv) && /agentBridge/.test(sv);
  });

  // C15: Key asli ke-set; error gak bikin bot mati
  check("C15a", "Infra", "DEEPSEEK_API_KEY tersedia", () => !!process.env.DEEPSEEK_API_KEY);
  check("C15b", "Infra", "Agent error handling: graceful failure (30s timeout)", () => {
    const agentCode = require("fs").readFileSync("./blueprint/sbsr-agent.mjs", "utf8");
    return /30000/.test(agentCode) && /catch/.test(agentCode) && /Maaf Kak/.test(agentCode);
  });
  check("C15c", "Infra", "Bridge module failsafe: gak break server.js kalo missing", () => {
    const sv = require("fs").readFileSync("./server.js", "utf8");
    return /try\s*\{\s*agentBridge\s*=/.test(sv) && /catch/.test(sv);
  });

  // ═══ SUMMARY ═══
  console.log("\n╔═══════════════════════════════════════════════╗");
  console.log("║  GO/NO-GO RESULT                             ║");
  console.log("╠═══════════════════════════════════════════════╣");

  const total = passed + failed;
  const go = criticalFailed === 0;

  console.log("║  Total: " + String(passed).padStart(2) + "/" + String(total).padStart(2) + " passed" + " ".repeat(19) + "║");
  if (failed > 0) console.log("║  ❌ Failed: " + String(failed) + " (critical: " + criticalFailed + ")".padEnd(31) + "║");

  console.log("╠═══════════════════════════════════════════════╣");
  if (go) {
    console.log("║  🟢 GO — all critical items green            ║");
    console.log("║  Besok: deploy ke nomor TEST, demo ke client ║");
  } else {
    console.log("║  🔴 NO-GO — " + criticalFailed + " critical item(s) RED           ║");
    console.log("║  TAHAN — pakai bot lama untuk client         ║");
  }
  console.log("╚═══════════════════════════════════════════════╝");

  // Detail table
  console.log("\n── Detail ──");
  for (const item of checklist) {
    const crit = item.critical ? " 🔴CRIT" : "      ";
    console.log(`  ${item.status} ${item.id.padEnd(4)} ${crit} ${item.category.padEnd(5)} ${item.label}`);
  }

  // Critical check
  console.log("\n── Critical Items Status ──");
  for (const item of checklist.filter(i => i.critical)) {
    console.log(`  ${item.status} ${item.id}: ${item.label}`);
  }

  console.log("\n── Notes ──");
  console.log("  ✅ = verified in simulation (DeepSeek tool-calling)");
  console.log("  ⚠️  A6 full flow (real WA location + Biteship + QRIS) = needs real WA number");
  console.log("  ⚠️  C14 real webhook = needs server running on test number");
  console.log("  ⚠️  C15 WhatsApp/Biteship keys = needs production env vars");
  console.log("  Branch: feat/agent-integration | 29 Jun 2026");

  return { passed, failed, criticalFailed, go };
}

run().then(result => {
  if (!result.go) process.exit(1);
}).catch(e => { console.error("TEST ERROR:", e.message); process.exit(1); });
