/**
 * sbsr-agent-bridge.mjs — production WhatsApp webhook for the Sentuh Rasa agent.
 *
 *   • text / button / catalog-order → runAgent (LLM brain + cart tools)
 *   • native location pin           → DETERMINISTIC ongkir → invoice + QRIS
 *   • payment image                 → ack + notify admin to verify
 *   • frustration/escalate          → admin ping + pause; admin RESUME/VERIFIED
 * State (messages + order) persisted per phone. Money is 100% deterministic.
 *
 * Env: WHATSAPP_ACCESS_TOKEN|WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_VERIFY_TOKEN,
 *      DEEPSEEK_API_KEY, BITESHIP_API_KEY, SBSR_ORIGIN_LAT/LNG, ADMIN_PHONES, QRIS_IMAGE_URL,
 *      AGENT_STATE_DIR, BRIDGE_PORT
 */
import http from "http";
import https from "https";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { runAgent } from "./sbsr-agent.mjs";
import { quoteOngkir, invoiceText } from "./sbsr-shipping.mjs";
import { formatRupiah } from "./sbsr-catalog.mjs";

const DIR = dirname(fileURLToPath(import.meta.url));
const SIM = process.env.ROSALIE_SIM === "1" || process.env.SBSR_SIM === "1";
const WA_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || process.env.WHATSAPP_TOKEN || "";
const WA_PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || "";
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || "sentuhrasa";
const ADMIN_PHONES = (process.env.ADMIN_PHONES || "").split(",").map(s => s.trim()).filter(Boolean);
const QRIS_IMAGE_URL = process.env.QRIS_IMAGE_URL || "";
const STATE_DIR = process.env.AGENT_STATE_DIR || join(DIR, "agent-state");
const MAPS_URL_RE = /(https?:\/\/)?(maps\.app\.goo\.gl\/[\w-]+|goo\.gl\/maps\/[\w-]+|(maps\.)?google\.[a-z.]+\/maps[^\s]*)/i;

// Dedup — ON by default (the bug in the old bot was this being OFF).
const PROCESSED = new Map();
function isDuplicate(id) { if (!id) return false; const now = Date.now(); for (const [k, t] of PROCESSED) if (now - t > 60000) PROCESSED.delete(k); if (PROCESSED.has(id)) return true; PROCESSED.set(id, now); return false; }

function norm(p) { return String(p).replace(/[^0-9]/g, ""); }
function statePath(p) { return join(STATE_DIR, norm(p) + ".json"); }
function loadState(p) { try { return JSON.parse(readFileSync(statePath(p), "utf8")); } catch { return { messages: [], order: { cart: [] } }; } }
function saveState(p, s) { try { if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true }); const m = s.messages && s.messages.length > 24 ? [s.messages[0], ...s.messages.slice(-22)] : (s.messages || []); writeFileSync(statePath(p), JSON.stringify({ ...s, messages: m }, null, 2)); } catch (e) { log("state_err " + e.message); } }
function log(...a) { console.log(new Date().toISOString(), ...a); }

function waPost(payload) {
  return new Promise((resolve) => {
    if (SIM) { console.log("\n🧀→ " + JSON.stringify(payload).slice(0, 320)); return resolve(true); }
    if (!WA_TOKEN || !WA_PHONE_ID) { log("no_wa_token"); return resolve(false); }
    const req = https.request({ hostname: "graph.facebook.com", path: "/v21.0/" + WA_PHONE_ID + "/messages", method: "POST", headers: { Authorization: "Bearer " + WA_TOKEN, "Content-Type": "application/json" } },
      (r) => { let d = ""; r.on("data", c => d += c); r.on("end", () => resolve(true)); });
    req.on("error", e => { log("wa_err " + e.message); resolve(false); });
    req.write(JSON.stringify(payload)); req.end();
  });
}
const sendText = (to, text) => waPost({ messaging_product: "whatsapp", to: norm(to), type: "text", text: { body: text } });
const sendImage = (to, url, caption) => waPost({ messaging_product: "whatsapp", to: norm(to), type: "image", image: { link: url, caption } });
const sendButtons = (to, text, btns) => waPost({ messaging_product: "whatsapp", to: norm(to), type: "interactive", interactive: { type: "button", body: { text }, action: { buttons: btns.map(b => ({ type: "reply", reply: { id: b.id, title: b.title } })) } } });

async function sendInvoiceAndQris(phone, order) {
  await sendText(phone, invoiceText(order));
  if (QRIS_IMAGE_URL) await sendImage(phone, QRIS_IMAGE_URL, "Scan QRIS ini buat bayar ya Kak 🤍 Setelah transfer, kirim foto buktinya di sini.");
  else await sendText(phone, "Silakan lanjut pembayaran QRIS ya Kak 🤍 (admin kirim QRIS). Setelah transfer, kirim foto buktinya.");
  order.flow = "awaiting_payment"; order.finalize = false;
}

export async function handleInbound(phone, msg) {
  if (ADMIN_PHONES.includes(norm(phone))) return handleAdmin(phone, msg);
  const state = loadState(phone);
  const order = state.order || (state.order = { cart: [] });
  order.cart ||= [];
  const text = (msg.text && msg.text.body) || (msg.interactive && msg.interactive.button_reply && msg.interactive.button_reply.id) || "";

  // 1) location → deterministic ongkir + (if ready) invoice + QRIS
  if (msg.type === "location" || (text && MAPS_URL_RE.test(text))) {
    let lat = null, lng = null;
    if (msg.type === "location") { lat = msg.location.latitude; lng = msg.location.longitude; }
    if (lat == null) { await sendText(phone, "Paling akurat pakai *Share Location WhatsApp* ya Kak 📍 (klik 📎 → Location → Send your current location)"); return; }
    order.pin = { lat, lng };
    if (order.fulfillment !== "pickup") {
      const q = await quoteOngkir(lat, lng, order.cart);
      if (!q.available) { await sendText(phone, "Mohon maaf Kak 🙏 untuk titik ini kurir belum tersedia. Boleh share lokasi lain, atau pilih ambil sendiri (pickup)?"); saveState(phone, state); return; }
      order.ongkir = q.ongkir; order.ongkir_eta = q.eta;
    }
    await sendText(phone, "Lokasi diterima Kak 😊 ongkir udah dihitung ya.");
    if (order.cart.length && order.fulfillment && order.name) await sendInvoiceAndQris(phone, order);
    else await sendText(phone, "Tinggal lengkapi nama" + (order.address ? "" : " & alamat") + " ya Kak 🤍");
    state.messages.push({ role: "assistant", content: "[sistem: lokasi diterima, ongkir " + formatRupiah(order.ongkir || 0) + ", invoice+QRIS dikirim]" });
    saveState(phone, state); return;
  }

  // 2) payment image → ack + admin
  if (msg.type === "image" || msg.type === "document") {
    await sendText(phone, "Makasih Kak 🤍 Bukti pembayaran sudah Mintu terima, lagi dicek admin ya. Nanti dikabari kalau sudah diverifikasi 😊");
    for (const a of ADMIN_PHONES) await sendText(a, "🧾 Bukti bayar dari " + norm(phone) + " (" + (order.name || "?") + "). Cek & verifikasi.");
    order.flow = "awaiting_admin"; saveState(phone, state); return;
  }

  // 3) everything else → the agent
  const r = await runAgent(state, text || "(pesan tidak didukung)");
  const o = r.order;
  if (o.escalate) {
    await sendText(phone, r.reply || "Mohon maaf ya Kak 🙏 Mintu panggilkan admin (manusia) untuk bantu langsung.");
    for (const a of ADMIN_PHONES) await sendText(a, "🚨 Butuh admin — " + norm(phone) + ": " + o.escalate);
    o.paused = true;
  } else if (r.reply) {
    if (/dikirim.*ambil sendiri|ambil sendiri.*dikirim/i.test(r.reply) && !o.fulfillment) await sendButtons(phone, r.reply, [{ id: "delivery", title: "🛵 Dikirim" }, { id: "pickup", title: "🏪 Ambil sendiri" }]);
    else await sendText(phone, r.reply);
  }
  if (o.finalize) await sendInvoiceAndQris(phone, o);
  saveState(phone, { messages: r.messages, order: o });
}

async function handleAdmin(phone, msg) {
  const text = (msg.text && msg.text.body) || "";
  const m = text.match(/^resume[_\s]+(\d{8,15})/i);
  if (m) { const t = norm(m[1]); const s = loadState(t); s.order.paused = false; s.order.flow = ""; saveState(t, s); await sendText(phone, "✅ Bot aktif lagi untuk " + t); await sendText(t, "Halo Kak 😊 Mintu lanjut bantu ya 🤍"); return; }
  const v = text.match(/^(verified|approve)[_\s]+(\d{8,15})/i);
  if (v) { const t = norm(v[2]); await sendText(t, "Pembayaran terverifikasi Kak ✅ Pesanan diproses ya. Makasih banyak! 🍴🤍"); await sendText(phone, "✅ Customer " + t + " dikabari."); return; }
  await sendText(phone, "Admin cmd: RESUME <phone> | VERIFIED <phone>");
}

function parseWebhook(body) { try { const m = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]; return m ? { phone: m.from, msg: m, id: m.id } : null; } catch { return null; } }

if (!SIM && process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const PORT = parseInt(process.env.BRIDGE_PORT || "3020", 10);
  http.createServer((req, res) => {
    if (req.method === "GET") { const u = new URL(req.url, "http://x"); if (u.searchParams.get("hub.verify_token") === VERIFY_TOKEN) { res.writeHead(200); return res.end(u.searchParams.get("hub.challenge") || ""); } res.writeHead(403); return res.end("no"); }
    let raw = ""; req.on("data", c => raw += c);
    req.on("end", async () => {
      res.writeHead(200); res.end("OK"); // fast ack
      try { const info = parseWebhook(JSON.parse(raw)); if (!info || isDuplicate(info.id)) return; const s = loadState(info.phone); if (s.order?.paused && !ADMIN_PHONES.includes(norm(info.phone))) return; await handleInbound(info.phone, info.msg); }
      catch (e) { log("handler_err " + (e.message || e)); }
    });
  }).listen(PORT, () => log("sbsr-agent-bridge on :" + PORT));
}
