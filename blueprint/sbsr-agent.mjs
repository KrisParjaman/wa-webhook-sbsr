/**
 * sbsr-agent.mjs — the SMART brain for Sentuh Rasa (mirror of Rosalie's rearch/agent).
 *
 * LLM agent that converses, knows the products (sells!), and calls DETERMINISTIC tools
 * for the cart. The LLM never computes a price/total/pack — tools do, from sbsr-catalog.
 * Persona = customer-service-excellence.md.
 *
 *   const { reply, order, messages } = await runAgent({ messages, order }, "risol ayam 6pcs goreng");
 */
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { CATALOG, resolveProduct, formatRupiah, catalogForPrompt } from "./sbsr-catalog.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
let CS_SKILL = "";
try { CS_SKILL = readFileSync(join(__dir, "customer-service-excellence.md"), "utf8").replace(/^---[\s\S]*?---\s*/, "").trim(); } catch {}

const DS_KEY = process.env.DEEPSEEK_API_KEY || process.env.OPENROUTER_API_KEY || "";
const DS_URL = process.env.DEEPSEEK_API_KEY ? "https://api.deepseek.com/chat/completions" : "https://openrouter.ai/api/v1/chat/completions";
const MODEL  = process.env.AGENT_MODEL || (process.env.DEEPSEEK_API_KEY ? "deepseek-chat" : "deepseek/deepseek-chat");

const SYSTEM_PROMPT = `Kamu adalah Mintu, sales & customer-service WhatsApp untuk Sentuh Rasa — Risoles Otentik (Jakarta Timur). KAMU HANYA MENJUAL RISOLES. JANGAN PERNAH menyebut produk lain seperti dimsum, siomay, hakao, lumpia, batagor, pangsit, xiao long bao, ceker, atau makanan non-risol lainnya. Nama brand HANYA "Sentuh Rasa" — JANGAN mengarang nama brand lain (Dimsumkuy, Risolku, dll). Kalau ada yang tanya produk di luar risoles, bilang: "Kita spesialis risoles aja Kak 😊".

Kerjamu PERSIS seperti agen CS & sales terbaik di dunia. Patuhi prinsip di bawah ini SETIAP balasan, tapi dalam BAHASA INDONESIA santai, gaya WhatsApp (1-3 kalimat, hangat, manusiawi, BUKAN robot, JANGAN kasih daftar bernomor kaku kecuali diminta). Panggil customer "Kak". PENTING: gambar katalog (menu + harga) dikirim otomatis oleh sistem — kamu gak perlu deskripsiin produk panjang-panjang, fokus ke ngobrol & bantu order.

╔═══ SKILL: CUSTOMER SERVICE EXCELLENCE (cara kamu berperilaku) ═══╗
${CS_SKILL || "(skill file tidak terbaca — tetap: baca emosi dulu, akui lalu bantu, jujur, jangan robot, jangan ngarang harga.)"}
╚════════════════════════════════════════════════════════════════╝

═══ KONTEKS OPERASIONAL SENTUH RASA (aturan keras) ═══

GREETING & FIRST IMPRESSION:
- Saat customer baru kirim "halo/hai/pagi/test/menu" → sambut SINGKAT (1-2 kalimat WA maximum). JANGAN panjang lebar — gambar katalog yang sudah dikirim sistem yang menjelaskan produk. Kamu cukup:
  • Salam hangat + tanya "mau goreng (makan langsung) atau frozen (stok)?"
- Variasikan kata-kata tiap greeting, tapi TETAP SINGKAT. Contoh: "Halo Kak! 👋 Mau risol goreng (makan langsung) atau frozen (stok di rumah)?"
- JANGAN ulangi marketing pitch panjang (rasa konsisten, repeat order, acara kantor, dll) — itu udah ada di gambar katalog. Simpan detail itu buat kalau customer TANYA spesifik.
- JANGAN sebut harga di greeting. JANGAN ngarang diskon/promo.

PRODUK (Trait #4):
- CATALOG di bawah = SATU-SATUNYA sumber produk & harga. Jangan sebut produk/harga/ukuran di luar itu. Risoles GORENG ada 3/6/12 pcs; FROZEN cuma 6 pcs. Jangan ngarang ukuran/harga/stok/promo.
- ⛔ ANTI-HALUCINATION: Kamu HANYA jual RISOLES. JANGAN PERNAH sebut dimsum, siomay, hakao, lumpia, batagor, pangsit, ceker, xiao long bao, mie, nasi, atau makanan apapun selain yang ADA DI CATALOG di bawah. Kalau customer minta produk di luar catalog, bilang: "Kita spesialis risoles aja Kak 😊, bisa dicek di menu ya."
- Ditanya "favorit / enak / rekomen / buat acara / buat oleh-oleh" → WAJIB kasih saran hangat by use-case dari katalog (Trait #9/#10). JANGAN balas dengan template sapaan. Contoh: "Buat makan langsung, Ayam Sayur goreng paling laris Kak 😋. Kalau buat stok di rumah, frozen Smoked Beef Mayo enak."

UANG & KERANJANG (jangan hitung sendiri):
- Apa pun yang ubah pesanan → WAJIB panggil TOOL (add_to_cart / update_qty / remove_from_cart / view_cart). Harga & total dari tool.
- Kalau customer tanya "pesanan saya apa aja / cart-nya apa" → panggil view_cart, lalu sebutkan isinya dengan jelas. JANGAN bilang "kurang yakin".

KLARIFIKASI (Trait #2, sekali aja, jangan muter):
- Kalau varian/bentuk/jumlah belum jelas, add_to_cart akan balikin "needs". Tanya SATU hal yang kurang dengan ramah (mis. "Mau yang goreng (makan langsung) atau frozen (stok)?" atau "Mau 3, 6, atau 12 pcs Kak?"). Setelah dijawab, langsung add. Jangan tanya hal yang sama dua kali.

CHECKOUT (pakai tools — WAJIB TIAP LANGKAH):
1. Customer cukup → tanya dikirim atau ambil sendiri. Kalau customer jawab "dikirim"/"delivery" atau "ambil sendiri"/"pickup" → WAJIB panggil set_fulfillment.
2. DELIVERY: setiap customer kasih NAMA → WAJIB panggil set_recipient DULU baru ngomong. Setiap customer kasih ALAMAT → WAJIB panggil set_recipient LAGI. JANGAN cuma bilang "terima kasih [nama]" atau "oke Kak" — SIMPAN DULU nama/alamatnya ke tool, BARU lanjut ngomong.
3. SETELAH nama + alamat disimpan untuk delivery → WAJIB minta SHARE LOCATION WhatsApp dulu (sistem yang hitung ongkir). JANGAN panggil finalize_order sebelum lokasi diterima dan ongkir dihitung. JANGAN bilang "mau lanjut bayar?" — ongkir BELUM dihitung! Bilang: "share lokasi Kak, biar dihitung ongkirnya dulu 📍".
4. PICKUP: customer kasih nama → WAJIB set_recipient dulu, baru finalize_order.
5. FINALIZE_ORDER HANYA dipanggil kalau SEMUA ini terpenuhi: cart TIDAK kosong + fulfillment SUDAH set + nama SUDAH disimpan + (delivery: alamat SUDAH ada DAN ongkir SUDAH dihitung DAN lokasi SUDAH diterima). Kalau delivery dan ongkir masih 0 → JANGAN finalize, minta lokasi dulu. Sistem yang kirim invoice + QRIS setelah finalize.

PENTING: Kalau customer kirim pesan pendek yang terlihat seperti nama (1-3 kata, tanpa kata kunci menu/makanan/pesanan) saat kamu lagi nunggu nama → itu NAMA, panggil set_recipient. JANGAN tanya "ada yang bisa dibantu?" — itu bukan pertanyaan, itu data yang harus disimpan.

HARD SITUATIONS: customer kesal/insult/minta manusia → akui dulu, bantu tulus; kalau tetap minta manusia → escalate_to_human. Nggak tau pasti → "Mintu cek admin dulu ya Kak 😊", jangan ngarang.

## CATALOG (harga pasti)
${catalogForPrompt()}`;

const TOOLS = [
  { type: "function", function: { name: "add_to_cart", description: "Tambah produk. Sebut variant (mis. 'Ayam Sayur'), form ('goreng'/'frozen'), pack (3/6/12; frozen selalu 6). Kalau belum lengkap, tool balikin 'needs' — tanya itu ke customer.", parameters: { type: "object", properties: { product: { type: "string", description: "deskripsi/varian, mis. 'ayam sayur', 'smoked beef mayo'" }, form: { type: "string", enum: ["goreng", "frozen"] }, pack: { type: "integer", enum: [3, 6, 12] }, qty: { type: "integer", description: "jumlah pack, default 1" } }, required: ["product"] } } },
  { type: "function", function: { name: "update_qty", description: "Ubah jumlah pack item di keranjang.", parameters: { type: "object", properties: { product: { type: "string" }, form: { type: "string" }, pack: { type: "integer" }, qty: { type: "integer" } }, required: ["product", "qty"] } } },
  { type: "function", function: { name: "remove_from_cart", description: "Hapus item dari keranjang.", parameters: { type: "object", properties: { product: { type: "string" }, form: { type: "string" }, pack: { type: "integer" } }, required: ["product"] } } },
  { type: "function", function: { name: "view_cart", description: "Lihat isi keranjang + subtotal.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "set_fulfillment", description: "Set: dikirim (delivery) atau ambil sendiri (pickup).", parameters: { type: "object", properties: { method: { type: "string", enum: ["delivery", "pickup"] } }, required: ["method"] } } },
  { type: "function", function: { name: "set_recipient", description: "WAJIB dipanggil SETIAP customer memberikan nama atau alamat. Customer kasih nama → panggil dengan name. Customer kasih alamat → panggil lagi dengan address. JANGAN skip — simpan dulu baru lanjut ngomong.", parameters: { type: "object", properties: { name: { type: "string", description: "Nama penerima. Kalau customer kirim 1-3 kata yang terlihat seperti nama orang, itu name." }, address: { type: "string", description: "Alamat lengkap. Hanya untuk delivery." } }, required: ["name"] } } },
  { type: "function", function: { name: "finalize_order", description: "Customer siap bayar. HARUS: cart tidak kosong + fulfillment set + nama ada + (delivery: alamat DAN ongkir SUDAH dihitung DAN lokasi SUDAH diterima). Kalau delivery dan ongkir=0 atau lokasi belum ada → JANGAN finalize, minta lokasi dulu.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "escalate_to_human", description: "Serahkan ke admin manusia.", parameters: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] } } },
];

function subtotal(cart) { return (cart || []).reduce((s, i) => s + i.price * i.qty, 0); }
function cartView(cart) {
  if (!cart || !cart.length) return { items: [], subtotal: 0, text: "keranjang kosong" };
  return { items: cart, subtotal: subtotal(cart), text: cart.map(i => `${i.name} ${i.form || ""} ${i.pack}pcs × ${i.qty} = ${formatRupiah(i.price * i.qty)}`).join("\n") + `\nSubtotal: ${formatRupiah(subtotal(cart))}` };
}

function runTool(name, args, order) {
  order.cart ||= [];
  switch (name) {
    case "add_to_cart": {
      const r = resolveProduct(args);
      if (r.needs) return JSON.stringify({ ok: false, needs: r.needs, note: r.needs === "form" ? "tanya: goreng (makan langsung) atau frozen (stok)?" : r.needs === "pack" ? "tanya: 3, 6, atau 12 pcs?" : "tanya varian apa" });
      const p = r.product, qty = Math.max(1, parseInt(args.qty) || 1);
      const ex = order.cart.find(i => i.sku === p.sku);
      if (ex) ex.qty += qty; else order.cart.push({ sku: p.sku, name: p.name, form: p.form, pack: p.pack, price: p.price, qty });
      return JSON.stringify({ ok: true, added: `${p.name} ${p.form || ""} ${p.pack}pcs ×${qty} @ ${formatRupiah(p.price)}`, ...cartView(order.cart) });
    }
    case "update_qty": {
      const r = resolveProduct(args); const it = r.product && order.cart.find(i => i.sku === r.product.sku);
      if (!it) return JSON.stringify({ ok: false, error: "item belum ada di keranjang" });
      const q = parseInt(args.qty); if (q <= 0) { order.cart = order.cart.filter(i => i.sku !== r.product.sku); return JSON.stringify({ ok: true, removed: r.product.name, ...cartView(order.cart) }); }
      it.qty = q; return JSON.stringify({ ok: true, ...cartView(order.cart) });
    }
    case "remove_from_cart": {
      const r = resolveProduct(args); if (!r.product) return JSON.stringify({ ok: false, error: "item tidak ketemu" });
      order.cart = order.cart.filter(i => i.sku !== r.product.sku);
      return JSON.stringify({ ok: true, removed: r.product.name, ...cartView(order.cart) });
    }
    case "view_cart": return JSON.stringify({ ok: true, ...cartView(order.cart) });
    case "set_fulfillment": order.fulfillment = args.method; return JSON.stringify({ ok: true, fulfillment: args.method, next: args.method === "pickup" ? "minta nama" : "minta nama + alamat" });
    case "set_recipient": if (args.name) order.name = String(args.name).trim(); if (args.address) order.address = String(args.address).trim(); return JSON.stringify({ ok: true, name: order.name || null, address: order.address || null });
    case "finalize_order":
      if (!order.cart || !order.cart.length) return JSON.stringify({ ok: false, error: "keranjang kosong" });
      if (!order.fulfillment) return JSON.stringify({ ok: false, error: "belum pilih dikirim/ambil sendiri" });
      if (!order.name) return JSON.stringify({ ok: false, error: "belum ada nama" });
      if (order.fulfillment === "delivery" && !order.address) return JSON.stringify({ ok: false, error: "belum ada alamat" });
      order.finalize = true; return JSON.stringify({ ok: true, note: "sistem kirim invoice + QRIS." });
    case "escalate_to_human": order.escalate = args.reason || "frustration"; return JSON.stringify({ ok: true, escalated: true });
    default: return JSON.stringify({ ok: false, error: "unknown tool" });
  }
}

async function callLLM(messages) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 30000);
  const res = await fetch(DS_URL, { method: "POST", headers: { Authorization: "Bearer " + DS_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ model: MODEL, messages, tools: TOOLS, temperature: 0.5, max_tokens: 500 }), signal: ctrl.signal });
  clearTimeout(t);
  if (!res.ok) throw new Error("LLM " + res.status + ": " + (await res.text().catch(() => "")).slice(0, 200));
  return (await res.json()).choices[0].message;
}

const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const GEMINI_MODEL = "gemini-2.0-flash";

async function callGeminiLLM(messages) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 30000);
  const res = await fetch(GEMINI_URL, { method: "POST", headers: { Authorization: "Bearer " + GEMINI_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ model: GEMINI_MODEL, messages, tools: TOOLS, temperature: 0.5, max_tokens: 500 }), signal: ctrl.signal });
  clearTimeout(t);
  if (!res.ok) throw new Error("Gemini " + res.status + ": " + (await res.text().catch(() => "")).slice(0, 200));
  return (await res.json()).choices[0].message;
}

function sanitizeMessages(msgs) {
  // Remove orphan tool messages that have no preceding assistant message with tool_calls.
  // DeepSeek 400s if role:"tool" appears without a matching tool_calls in the prior message.
  const out = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role === "tool") {
      const prev = out[out.length - 1];
      if (!prev || prev.role !== "assistant" || !prev.tool_calls || !prev.tool_calls.length) continue;
    }
    out.push(m);
  }
  return out;
}

export async function runAgent(state, userText) {
  const order = state.order || { cart: [] };
  let messages = state.messages && state.messages.length && state.messages[0]?.role === "system"
    ? state.messages
    : [{ role: "system", content: SYSTEM_PROMPT }, ...(state.messages || [])];
  messages = sanitizeMessages(messages);
  if (userText) messages.push({ role: "user", content: userText });
  if (!DS_KEY && !GEMINI_KEY) return { reply: "Maaf Kak, sistem lagi gangguan sebentar 🙏", order, messages };
  for (let i = 0; i < 5; i++) {
    let msg;
    try {
      msg = DS_KEY ? await callLLM(messages) : await callGeminiLLM(messages);
    } catch (e) {
      console.error('[sbsr-agent] DeepSeek error (attempt ' + i + '):', String(e));
      if (GEMINI_KEY) {
        try {
          console.error('[sbsr-agent] falling back to Gemini...');
          msg = await callGeminiLLM(messages);
        } catch (e2) {
          console.error('[sbsr-agent] Gemini fallback also failed:', String(e2));
          return { reply: "Maaf Kak, koneksi lagi lambat 🙏 boleh diulang?", order, messages, error: String(e2).slice(0, 120) };
        }
      } else {
        return { reply: "Maaf Kak, koneksi lagi lambat 🙏 boleh diulang?", order, messages, error: String(e).slice(0, 120) };
      }
    }
    messages.push(msg);
    if (msg.tool_calls && msg.tool_calls.length) {
      for (const tc of msg.tool_calls) { let a = {}; try { a = JSON.parse(tc.function.arguments || "{}"); } catch {} messages.push({ role: "tool", tool_call_id: tc.id, content: runTool(tc.function.name, a, order) }); }
      continue;
    }
    return { reply: (msg.content || "").trim(), order, messages };
  }
  return { reply: cartView(order.cart).text, order, messages };
}
