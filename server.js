require("dotenv").config({ path: __dirname + "/.env" });
const express = require("express");
const crypto = require("crypto");
const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

// ── Engine (v2 pipeline) ────────────────────────────────────────────
let engineCtx = null;
let enginePipeline = null;
let waSender = null;
let catalogManager = null;
let paymentEngine = null;
let draftStore = null;
let gsheetSync = null;
let stateManager = null;
let mapsGeocode = null;
try {
  engineCtx = require("./lib/engine/context.cjs");
  enginePipeline = require("./lib/engine/pipeline.cjs");
  waSender = require("./lib/wa-sender.cjs");
  catalogManager = require("./lib/catalog-manager.cjs");
  paymentEngine = require("./lib/payment-engine.cjs");
  draftStore = require("./lib/draft-store.cjs");
  gsheetSync = require("./lib/gsheet-sync.cjs");
  stateManager = require("./lib/state-manager.cjs");
  mapsGeocode = require("./lib/maps-geocode.cjs");
} catch (e) {
  console.error("[engine] failed to load modules — running legacy mode:", e.message);
}

// --- Admin inbox module (chat log + /admin panel). Never allow to break bot. ---
let admin;
try { admin = require("./admin.js"); }
catch (e) {
  console.error("[admin] failed to load, using no-op stubs:", e.message);
  admin = { logIncoming:()=>{}, logOutgoing:()=>{}, isPaused:()=>false, setPaused:()=>{}, listChats:()=>[], getChat:()=>({}), stats:()=>({}), safePhone:(p)=>String(p||"").replace(/[^0-9]/g,""), mount:()=>{} };
}
function safeLog(fn, ...args) { try { const r = fn(...args); if (r && r.catch) r.catch(e => console.error("[admin] log err:", e.message)); } catch (e) { console.error("[admin] log err:", e.message); } }

// --- BIKS SECURITY HARDENING (2026-05-07) ---
// Wires lib/{prompt-sanitizer,rate-limiter}.cjs into the inbound handler.
// Each load is wrapped in try/catch so a missing/broken lib NEVER takes the
// bridge down — security is fail-open at this layer (logs but proceeds).
// Docs: clients/sb-sentuh-rasa/docs/09-security-and-abuse.md
let secLib = null;
try {
  const { sanitizeUserText, summarizeFlags } = require("./lib/prompt-sanitizer.cjs");
  const { RateLimiter, defaultLimits }       = require("./lib/rate-limiter.cjs");
  const { CostGuard }                         = require("./lib/cost-guard.cjs");
  // draft-policy: pure predicate for "should we wipe a returning customer's
  // prior draft?" — extracted for unit-testability (test-draft-policy.cjs).
  const draftPolicy                          = require("./lib/draft-policy.cjs");
  // courier-choice parser: clause-aware negation handling for "1"/"2"/courier-name
  // replies in the frozen choice flow. Pre-fix, "bukan paxel, gojek aja" was
  // mis-parsed as paxel. Tests in test-courier-choice-parser.cjs.
  const { parseCourierChoice }               = require("./lib/courier-choice-parser.cjs");
  const RL_FILE = process.env.RATE_LIMIT_FILE || "/opt/sbsr/data/openclaw/.openclaw/workspace/rate-limit-buckets.json";
  const COST_LEDGER_PATH = process.env.COST_LEDGER_PATH || "/opt/sbsr/data/openclaw/.openclaw/workspace/cost-ledger.json";
  const rateLimiter = new RateLimiter(RL_FILE, defaultLimits);
  const costGuard = new CostGuard(COST_LEDGER_PATH, {
    dailyCapUsd: Number(process.env.LLM_DAILY_CAP_USD || 5.00),
    softCapUsd:  Number(process.env.LLM_SOFT_CAP_USD  || 3.50),
  });
  secLib = { sanitizeUserText, summarizeFlags, rateLimiter, costGuard, draftPolicy, parseCourierChoice };
  console.log("[security] lib loaded — sanitizer + rate-limiter + cost-guard active");
} catch (e) {
  console.error("[security] lib failed to load — running unhardened:", e.message);
}
// Per-LLM-request cost estimate. Bridge can't see real tokens (LLM lives in
// OpenClaw container behind WS), so we estimate $0.005/req — Gemini 2.5 Flash
// ballpark for SBSR's average turn. Tunable via LLM_PER_REQ_COST_USD.
const PER_REQUEST_COST_ESTIMATE_USD = Number(process.env.LLM_PER_REQ_COST_USD || 0.005);
const SECURITY_FLAGS_FILE = process.env.SECURITY_FLAGS_FILE
  || "/opt/sbsr/data/openclaw/.openclaw/workspace/security-flags.jsonl";
const SBSR_PAUSE = process.env.SBSR_PAUSE === "1";
const SBSR_PAUSE_TEXT = process.env.SBSR_PAUSE_TEXT
  || "Mintu lagi maintenance sebentar ya Kak 🙏 admin akan balas manual dalam beberapa menit. Terima kasih atas kesabarannya.";
function _isAdminPhoneSec(p) {
  const fin = (process.env.SBSR_FINANCE_PHONES || "").split(",").map(s => s.trim()).filter(Boolean);
  const kit = (process.env.SBSR_KITCHEN_PHONES || "").split(",").map(s => s.trim()).filter(Boolean);
  return fin.includes(p) || kit.includes(p);
}
if (SBSR_PAUSE) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: "warn", msg: "sbsr-paused", reason: "env-flag", at: new Date().toISOString() }));
}
// --- END BIKS SECURITY HARDENING ---

// ── Address Matcher ─────────────────────────────────────────────────
// Extracted from inline → lib/address-matcher.cjs.
// Fail-open: if module can't be loaded, fall back to no-op stubs so
// the bridge never goes down on an address-matching failure.
let am = null;
let normalizeSpaces, hasWestJavaHint, hasJakartaHint, isJakartaLikeHint,
    extractRegionKeywords, regionSetsConflict, inferRegionFromCoords,
    extractDistrictFromText, extractSemanticRegion,
    callLlmAddr, callLlmRegion, callLlmDistrict, callLlmCompare,
    hasSemanticRegionConflict, hasTextOnlyDistrictMismatch;
try {
  am = require("./lib/address-matcher.cjs");
  ({
    normalizeSpaces, hasWestJavaHint, hasJakartaHint, isJakartaLikeHint,
    extractRegionKeywords, regionSetsConflict, inferRegionFromCoords,
    extractDistrictFromText, extractSemanticRegion,
    callLlmAddr, callLlmRegion, callLlmDistrict, callLlmCompare,
    hasSemanticRegionConflict, hasTextOnlyDistrictMismatch,
  } = am);
  console.log("[address-matcher] lib loaded");
} catch (e) {
  console.error("[address-matcher] lib failed — using no-op stubs:", e.message);
  // pure fallbacks
  normalizeSpaces = function(s) { return String(s || "").trim().replace(/[\s ]+/g, " "); };
  hasWestJavaHint = function() { return false; };
  hasJakartaHint = function() { return false; };
  isJakartaLikeHint = function() { return false; };
  extractRegionKeywords = function() { return new Set(); };
  regionSetsConflict = function() { return false; };
  inferRegionFromCoords = function() { return null; };
  extractDistrictFromText = function() { return ""; };
  // async LLM-dependent stubs
  extractSemanticRegion = async function() { return null; };
  callLlmAddr = async function() { return null; };
  callLlmRegion = async function() { return null; };
  callLlmDistrict = async function() { return ""; };
  callLlmCompare = async function() { return null; };
  hasSemanticRegionConflict = async function() { return false; };
  hasTextOnlyDistrictMismatch = async function() { return false; };
}

// ── Addon Parser ────────────────────────────────────────────────────
// Extracted from inline → lib/addon-parser.cjs.
// All functions are pure/deterministic — no I/O or dependency injection.
let ap = null;
let SBSR_ADDON_ACTIVE_STATES, SBSR_ADDON_DECLINE_RE, SBSR_ADDON_SELECTIONS,
    isNormalizedAddonDecline, isAddonStateActive,
    extractAddonReplySelections, mergeAddonItems;
try {
  ap = require("./lib/addon-parser.cjs");
  ({
    SBSR_ADDON_ACTIVE_STATES, SBSR_ADDON_DECLINE_RE, SBSR_ADDON_SELECTIONS,
    isNormalizedAddonDecline, isAddonStateActive,
    extractAddonReplySelections, mergeAddonItems,
  } = ap);
  console.log("[addon-parser] lib loaded");
} catch (e) {
  console.error("[addon-parser] lib failed — using no-op stubs:", e.message);
  SBSR_ADDON_ACTIVE_STATES = new Set();
  SBSR_ADDON_DECLINE_RE = /(?!)/;
  SBSR_ADDON_SELECTIONS = [];
  isNormalizedAddonDecline = function() { return false; };
  isAddonStateActive = function() { return false; };
  extractAddonReplySelections = function() { return []; };
  mergeAddonItems = function(existingItems, existingAddons, _) {
    const merged = Array.isArray(existingItems) ? existingItems.map(it => ({ ...it })) : [];
    const addons = Array.isArray(existingAddons) ? existingAddons.map(it => ({ ...it })) : [];
    const subtotal = merged.reduce((sum, it) => sum + ((Number(it.unit_price) || 0) * (Number(it.qty) || 0)), 0);
    return { items: merged, addons, subtotal };
  };
}

// ── Qdrant Memory ───────────────────────────────────────────────────
// Extracted from inline → lib/qdrant-memory.cjs.
// Fail-open: if module fails, all functions become no-ops.
let qm = null;
let sbsrMemoryEnabled, sbsrRetrieveMemoryContext, sbsrStoreExtractedMemories,
    sbsrStoreAdminTrainingData, sbsrSeedProductKnowledge,
    sbsrExtractStructuredMemory, sbsrQdrantFetch, sbsrEnsureCollection,
    sbsrUpsertMemory, sbsrScrollMemory, sbsrNewPointId, sbsrTinyVector,
    sbsrNormalizeText, sbsrQdrantHeaders, SBSR_MEMORY_COLLECTIONS;
try {
  qm = require("./lib/qdrant-memory.cjs");
  ({
    sbsrMemoryEnabled, sbsrRetrieveMemoryContext, sbsrStoreExtractedMemories,
    sbsrStoreAdminTrainingData, sbsrSeedProductKnowledge,
    sbsrExtractStructuredMemory, sbsrQdrantFetch, sbsrEnsureCollection,
    sbsrUpsertMemory, sbsrScrollMemory, sbsrNewPointId, sbsrTinyVector,
    sbsrNormalizeText, sbsrQdrantHeaders, SBSR_MEMORY_COLLECTIONS,
  } = qm);
  console.log("[qdrant-memory] lib loaded");
} catch (e) {
  console.error("[qdrant-memory] lib failed — using no-op stubs:", e.message);
  sbsrMemoryEnabled = function() { return false; };
  sbsrRetrieveMemoryContext = async function() { return ""; };
  sbsrStoreExtractedMemories = async function() {};
  sbsrStoreAdminTrainingData = async function() { return false; };
  sbsrSeedProductKnowledge = async function() {};
  sbsrExtractStructuredMemory = function() { return []; };
  sbsrQdrantFetch = async function() { return { ok: false, status: 0, json: null }; };
  sbsrEnsureCollection = async function() {};
  sbsrUpsertMemory = async function() { return false; };
  sbsrScrollMemory = async function() { return []; };
  sbsrNewPointId = function(p) { return `${p||"m"}-${Date.now()}`; };
  sbsrTinyVector = function() { return [0,0,0,0]; };
  sbsrNormalizeText = function(v) { return String(v||"").toLowerCase().trim(); };
  sbsrQdrantHeaders = function() { return { "Content-Type": "application/json" }; };
  SBSR_MEMORY_COLLECTIONS = { customer:"", conversation:"", product:"", training:"" };
}

const app = express();
const PORT = 3001;

// Admin new-message notification cooldown: notify admin at most once per 30 min per customer
const _adminNotifLastSent = new Map(); // phone → timestamp ms

// --- Config from .env ---
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WA_PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID;
const WA_ACCESS_TOKEN = process.env.WA_ACCESS_TOKEN;
const WA_API_VERSION = process.env.WA_API_VERSION || "v22.0";
const META_APP_SECRET = process.env.META_APP_SECRET || "";
const OPENCLAW_HOST = process.env.OPENCLAW_HOST || "127.0.0.1";
const OPENCLAW_PORT = parseInt(process.env.OPENCLAW_PORT || "45891", 10);
const OPENCLAW_TOKEN = process.env.OPENCLAW_TOKEN;
const OPENCLAW_EXEC_CONTAINER = process.env.OPENCLAW_EXEC_CONTAINER || "sbsr-openclaw-1";
const PROTOCOL_VERSION = 3;

// Container->Host path mapping for PDF files
const CONTAINER_DATA_PREFIX = "/data/";
const HOST_DATA_PREFIX = process.env.HOST_DATA_PREFIX || "/opt/sbsr/data/openclaw/";
// Host-mapped data root for sync existence checks (ig-pending, po-pending, ig-awaiting-topic)
const HOST_DATA_ROOT = "/docker/openclaw-74if/data";

// --- Reconnection config ---
const BACKOFF_INITIAL_MS = 1000;
const BACKOFF_MAX_MS = 30000;
const PING_INTERVAL_MS = 30000;
const PONG_TIMEOUT_MS = 10000;
const CHAT_TIMEOUT_MS = 240000;

const RECEIPT_BASE_URL = "https://production.biks.ai/receipts/";
const IMGBB_KEY = "7f6defdcbb8475ac203f45c966b36a78";
const UPLOAD_DIR = "/docker/wa-webhook-sbsr/static/sentuhrasa-pdf/uploads";

// --- Catalog product ID mapping (Meta API live + JSON fallback) ---
const CATALOG_API_TOKEN = process.env.CATALOG_API_TOKEN || "";
const CATALOG_ID = process.env.WA_CATALOG_ID || "1477386560782761";
let catalogMap = {};
let catalogPrices = {};
let catalogAvailability = {};

// Load static catalog-map.json as base
try { catalogMap = JSON.parse(fs.readFileSync("/docker/wa-webhook-sbsr/catalog-map.json", "utf8")); } catch (_) {}

// Refresh catalog from Meta API
async function refreshCatalogFromAPI() {
  if (!CATALOG_API_TOKEN) return;
  try {
    const url = "https://graph.facebook.com/v22.0/" + CATALOG_ID + "/products?access_token=" + CATALOG_API_TOKEN + "&limit=50&fields=retailer_id,name,price,availability";
    const ctrl = new AbortController();
    const t = setTimeout(function(){ ctrl.abort(); }, 8000);
    const resp = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!resp.ok) { console.error("[catalog-api] fetch failed:", resp.status); return; }
    const data = await resp.json();
    let updated = 0;
    for (var i = 0; i < (data.data || []).length; i++) {
      var p = data.data[i];
      var rid = p.retailer_id;
      if (!rid) continue;
      // Use API name if available, otherwise keep existing catalog-map name
      if (p.name) catalogMap[rid] = p.name;
      var priceRaw = String(p.price || "0").replace(/[^0-9]/g, "");
      var price = parseInt(priceRaw) || 0;
      // Meta returns IDR prices in two formats:
      // - Shorthand: "Rp550" = 55,000 (no dot, <=4 digits -> multiply x100)
      // - Full: "Rp55.000" = 55,000 (has dot, already full value -> no multiply)
      var _priceStr = String(p.price || "");
      if (_priceStr.indexOf(".") === -1 && /^Rp/i.test(_priceStr) && price > 0 && price <= 9999) {
        price = price * 100;
      }
      if (price > 0) catalogPrices[rid] = price;
      if (p.availability) catalogAvailability[rid] = p.availability;
      updated++;
    }
    console.error("[catalog-api] refreshed " + updated + " products from Meta");
    var availCount = Object.keys(catalogAvailability).length;
    if (availCount > 0) console.error("[catalog-api] availability data for " + availCount + " products");
  } catch (e) {
    console.error("[catalog-api] error:", e.message);
  }
}

// Fetch on startup, then every 5 minutes
refreshCatalogFromAPI();
setInterval(refreshCatalogFromAPI, 5 * 60 * 1000);

function lookupProductName(retailerId) { return catalogMap[retailerId] || retailerId; }
function lookupProductPrice(retailerId) { return catalogPrices[retailerId] || null; }
function lookupProductAvailability(retailerId) { return catalogAvailability[retailerId] || null; }

var _productCatalogCache = null;
function loadProductCatalog() {
  if (_productCatalogCache) return _productCatalogCache;
  try {
    _productCatalogCache = JSON.parse(require("fs").readFileSync("/docker/wa-webhook-sbsr/products.json", "utf8"));
    return _productCatalogCache;
  } catch (_) { return null; }
}
function formatCatalogForLLM() {
  var p = loadProductCatalog();
  if (!p) return "";
  var out = [];
  out.push("===== CATALOG SENTUH RASA (HARGA LIVE DARI META) =====");
  out.push("(Harga update otomatis setiap 5 menit dari katalog WhatsApp — ini sumber AKTUAL.)");
  out.push("");

  var RI_RE_LIVE = /^(RA|RR|RM|RAM|RAP|MIX)-(.+)$/;
  var famSeen = {};
  var famOrderLive = [];
  for (var rid in catalogMap) {
    if (!catalogMap.hasOwnProperty(rid)) continue;
    var m2 = rid.match(RI_RE_LIVE);
    if (!m2) continue;
    var fam2 = m2[1];
    if (!famSeen[fam2]) { famSeen[fam2] = true; famOrderLive.push(fam2); }
  }
  var sizeSort = {"3":1,"6":2,"12":3,"FRZ":4};
  var famNamesLive = {"RA":"Ayam Sayur","RR":"Ragout Creamy","RM":"Smoked Beef Mayo","RAM":"Ayam Mercon Chili Oil","RAP":"Ayam Sayur Pedas","MIX":"Mix Risol"};
  
  out.push("PRODUK GORENG (Makan Langsung — 3pcs / 6pcs / 12pcs):");
  for (var fi2 = 0; fi2 < famOrderLive.length; fi2++) {
    var fKey = famOrderLive[fi2];
    var gorengItems = [];
    var frozenItems = [];
    for (var rid2 in catalogMap) {
      if (!catalogMap.hasOwnProperty(rid2)) continue;
      var m3 = rid2.match(RI_RE_LIVE);
      if (!m3 || m3[1] !== fKey) continue;
      var it = {size: m3[2], name: catalogMap[rid2], price: catalogPrices[rid2] || 0};
      if (it.size === "FRZ") frozenItems.push(it);
      else gorengItems.push(it);
    }
    gorengItems.sort(function(a,b){return (sizeSort[a.size]||99) - (sizeSort[b.size]||99);});
    frozenItems.sort(function(a,b){return (sizeSort[a.size]||99) - (sizeSort[b.size]||99);});
    
    var parts = [];
    if (gorengItems.length > 0) {
      for (var gi = 0; gi < gorengItems.length; gi++) {
        var gi2 = gorengItems[gi];
        var pr = gi2.price > 0 ? "Rp" + Number(gi2.price).toLocaleString("id-ID") : "?";
        parts.push(gi2.size + "pcs=" + pr);
      }
    }
    if (frozenItems.length > 0) {
      var fi = frozenItems[0];
      var fpr = fi.price > 0 ? "Rp" + Number(fi.price).toLocaleString("id-ID") : "?";
      parts.push("Frozen 6pcs=" + fpr);
    }
    var flavor = "";
    if (fKey === "RAM") flavor = " 🔥";
    if (fKey === "MIX") flavor = " (pilih varian di chat)";
    out.push("  - " + (famNamesLive[fKey] || fKey) + flavor + ": " + parts.join(" | "));
  }

  // ADD-ON
  out.push("");
  out.push("ADD-ON:");
  for (var ridA in catalogMap) {
    if (!catalogMap.hasOwnProperty(ridA)) continue;
    if (ridA.indexOf("ADD-") !== 0) continue;
    var ap2 = catalogPrices[ridA] || 0;
    out.push("  - " + catalogMap[ridA] + (ap2 > 0 ? " = Rp" + Number(ap2).toLocaleString("id-ID") : ""));
  }

  // Out-of-stock
  var unavailableNote = [];
  for (var rid in catalogAvailability) {
    var avail = catalogAvailability[rid];
    if (avail && avail !== "in stock" && avail !== "available for order") {
      unavailableNote.push("  - " + (catalogMap[rid] || rid) + " [" + avail + "]");
    }
  }
  if (unavailableNote.length > 0) {
    out.push("");
    out.push("\u26a0\ufe0f PRODUK TIDAK TERSEDIA:");
    for (var ui = 0; ui < unavailableNote.length; ui++) {
      out.push(unavailableNote[ui]);
    }
    out.push("(JANGAN rekomendasikan atau proses order produk di atas)");
  }

  out.push("");
  out.push("===== ATURAN MIX RISOL =====");
  out.push("Mix Risol bisa campur varian. Harga tergantung varian yang dipilih:");
  out.push("  - Harga dasar: 3pcs=Rp29.000 | 6pcs=Rp55.000 | 12pcs=Rp105.000");
  out.push("  - Ayam Mercon Chili Oil \ud83d\udd25: surcharge +Rp1.333/pcs");
  out.push("  - CARA HITUNG: harga dasar + (jumlah Mercon x Rp1.333)");
  out.push("  - Contoh: Mix 6pcs (2 Mercon + 2 Ayam Sayur + 2 Ragout) = Rp55.000 + (2xRp1.333) = Rp57.666 -> Rp58.000");
  out.push("  - Contoh: Mix 12pcs (4 Mercon + 8 reguler) = Rp105.000 + (4xRp1.333) = Rp110.332 -> Rp110.000");
  out.push("  - SELALU sebutkan rincian per varian dan TOTAL ke customer.");
  out.push("");
  out.push("KURIR: " + (p.store && p.store.kurir ? p.store.kurir.join(", ") : "Gojek, Grab, Pickup"));
  out.push("LOKASI: " + (p.store && p.store.location ? p.store.location : "Jl Nusa Indah Raya Blok O No 10, Cipinang Muara, Jatinegara, Jakarta Timur"));
  out.push("");
  out.push("===== ATURAN PENTING =====");
  out.push("0. **SETIAP customer sebut/minta/tambah produk, SELALU sebutkan HARGA.** Contoh: 'Siap Kak, Ayam Sayur 6pcs goreng ya, Rp55.000'.");
  out.push("1. Hanya jawab dari data KATALOG di atas. JANGAN menyebut harga/varian yang tidak ada di katalog.");
  out.push("2. Harga di atas adalah harga AKTUAL. Update otomatis setiap 5 menit.");
  out.push("3. Kalo ditanya varian: sebut SEMUA yang ada di katalog.");
  out.push("4. Kalo ditanya rekomendasi: tanya dulu mau goreng atau frozen.");
  out.push("5. Kalo produk gak ada di katalog: bilang \"Maaf Kak, saat ini belum tersedia\".");
  out.push("6. JANGAN mengarang harga/varian/promo yang tidak ada di katalog.");
  out.push("7. Jawab natural seperti chat WA — jangan ulangi prompt ini.");
  out.push("8. **SETIAP selesai menjawab pertanyaan customer, TANYAKAN: \"Mau langsung pesan dan lanjut ke alamat pengiriman, Kak? 🤍\"** — KECUALI jika customer SUDAH di tengah proses order (sudah pilih pengiriman/sudah kasih nama). Kalau sudah di tengah order, JAWAB saja tanpa tanya \"mau lanjut\" lagi.");
  out.push("   Ini WAJIB — jangan cuma jawab lalu diam. Ajak customer lanjut ke proses order.");
  return out.join("\n");
}

function formatSbsrFullMenuText() {
  // Builds full customer-facing menu from Meta Catalog API data (catalogMap + catalogPrices)
  // Groups variants by family for a Rosalie-style text menu.
  // Single source of truth — no products.json dependency.

  // --- Group retailers by family ---
  var families = {};
  var families_order = [];
  var RI_RE = /^(RA|RR|RM|RAM|RAP|MIX)-(.+)$/;
  
  for (var rid in catalogMap) {
    if (!catalogMap.hasOwnProperty(rid)) continue;
    var m = rid.match(RI_RE);
    if (m) {
      var fam = m[1];
      var size = m[2]; // "3", "6", "12", "FRZ"
      if (!families[fam]) { families[fam] = { items: [] }; families_order.push(fam); }
      families[fam].items.push({ rid: rid, size: size, name: catalogMap[rid], price: catalogPrices[rid] || 0 });
    }
  }
  
  // Sort items within each family
  var sizeOrder = { "3":1, "6":2, "12":3, "FRZ":4 };
  for (var fi = 0; fi < families_order.length; fi++) {
    var f = families_order[fi];
    families[f].items.sort(function(a,b) {
      return (sizeOrder[a.size]||99) - (sizeOrder[b.size]||99);
    });
  }
  
  // --- Family display names ---
  var familyNames = {
    "RA": "Risol Ayam Sayur",
    "RR": "Risol Ragout Creamy",
    "RM": "Risol Smoked Beef Mayo",
    "RAM": "Risol Ayam Mercon Chili Oil",
    "RAP": "Risol Ayam Sayur Pedas",
    "MIX": "Mix Risol (Pilih Varian di Chat)"
  };
  
  var sizeLabels = {
    "3": "3pcs",
    "6": "6pcs",
    "12": "12pcs",
    "FRZ": "Frozen 6pcs"
  };
  
  // Build output
  var out = [];
  out.push("Halo Kak \u{1f60a} silakan lihat menu lengkap kami ya");
  out.push("");
  out.push("Untuk produk kami ada berbagai pilihan risoles goreng, frozen, dan add-on.");
  out.push("");
  out.push("Saya kirimkan daftar lengkapnya ya:");
  
  for (var fi = 0; fi < families_order.length; fi++) {
    var f = families_order[fi];
    var famData = families[f];
    out.push("");
    out.push("*" + (familyNames[f] || f) + "*");
    
    // Single-line: all sizes
    var parts = [];
    for (var si = 0; si < famData.items.length; si++) {
      var it = famData.items[si];
      var label = sizeLabels[it.size] || it.size;
      var pr = it.price > 0 ? "Rp" + Number(it.price).toLocaleString("id-ID") : "";
      parts.push(label + (pr ? "=" + pr : ""));
    }
    out.push(parts.join(" | "));
  }
  
  // Add-ons
  var addons = [];
  for (var rid in catalogMap) {
    if (!catalogMap.hasOwnProperty(rid)) continue;
    if (rid.indexOf("ADD-") === 0) {
      var ap = catalogPrices[rid] || 0;
      addons.push("- " + catalogMap[rid] + (ap > 0 ? " = Rp" + Number(ap).toLocaleString("id-ID") : ""));
    }
  }
  if (addons.length > 0) {
    out.push("");
    out.push("*ADD-ON*:");
    for (var ai = 0; ai < addons.length; ai++) out.push(addons[ai]);
  }
  
  out.push("");
  out.push("Silakan pilih dari katalog di bawah ya Kak \u{1f90d}");
  return out.join("\n");
}

const PRODUCT_PRICE_MAP = {
  "RA-6-FRZ": { name: "Risol Frozen — Ayam Sayur (6pcs/Pack)", price: 51000, variant: "RA", pack_size: 6, form: "frozen" },
  "RR-6-FRZ": { name: "Risol Frozen — Ragout Creamy (6pcs/Pack)", price: 51000, variant: "RR", pack_size: 6, form: "frozen" },
  "RM-6-FRZ": { name: "Risol Frozen — Smoked Beef Mayo (6pcs/Pack)", price: 51000, variant: "RM", pack_size: 6, form: "frozen" },
  "RA-6-GRG": { name: "Risol Goreng — Ayam Sayur (6pcs/Pack)", price: 51000, variant: "RA", pack_size: 6, form: "goreng" },
  "RR-6-GRG": { name: "Risol Goreng — Ragout Creamy (6pcs/Pack)", price: 51000, variant: "RR", pack_size: 6, form: "goreng" },
  "RM-6-GRG": { name: "Risol Goreng — Smoked Beef Mayo (6pcs/Pack)", price: 51000, variant: "RM", pack_size: 6, form: "goreng" },
  "RA-12-GRG": { name: "Risol Goreng — Ayam Sayur (12pcs/Pack)", price: 96000, variant: "RA", pack_size: 12, form: "goreng" },
  "RR-12-GRG": { name: "Risol Goreng — Ragout Creamy (12pcs/Pack)", price: 96000, variant: "RR", pack_size: 12, form: "goreng" },
  "RM-12-GRG": { name: "Risol Goreng — Smoked Beef Mayo (12pcs/Pack)", price: 96000, variant: "RM", pack_size: 12, form: "goreng" },
  "MIX-6-GRG": { name: "Risol Goreng — Mix 6pcs", price: 51000, variant: "MIX", pack_size: 6, form: "goreng" },
  "MIX-12-GRG": { name: "Risol Goreng — Mix 12pcs", price: 96000, variant: "MIX", pack_size: 12, form: "goreng" },
  "MIX-6-FRZ": { name: "Risol Frozen — Mix 6pcs", price: 51000, variant: "MIX", pack_size: 6, form: "frozen" },
  "MIX-12-FRZ": { name: "Risol Frozen — Mix 12pcs", price: 96000, variant: "MIX", pack_size: 12, form: "frozen" },
};


// --- State ---
let gatewayWs = null;
let gatewayReady = false;
let gatewaySessionCookie = null;
const pendingChats = new Map();
let reconnectTimer = null;
let reconnectAttempt = 0;
let pingTimer = null;
let pongTimer = null;
const messageQueue = [];
let processingQueue = false;

function log(tag, ...args) {
  console.log(new Date().toISOString(), "[" + tag + "]", ...args);
}
if (qm) qm.init(log);

function nowJakartaDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const y = parts.find(p => p.type === "year")?.value || "1970";
  const m = parts.find(p => p.type === "month")?.value || "01";
  const d = parts.find(p => p.type === "day")?.value || "01";
  return new Date(`${y}-${m}-${d}T00:00:00+07:00`);
}

function fmtYmd(d) {
  if (!d || Number.isNaN(new Date(d).getTime())) return "";
  const dt = new Date(d);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const day = String(dt.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function toNum(v) {
  const n = Number(String(v ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function normalizePhone08(v) {
  const digits = String(v || "").replace(/[^0-9]/g, "");
  if (!digits) return "";
  if (digits.startsWith("0")) return digits;
  if (digits.startsWith("62")) return "0" + digits.slice(2);
  return digits;
}

function pickNonEmpty(...vals) {
  for (const v of vals) {
    if (v === null || v === undefined) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return "";
}

function deriveSegmentFromUseCase(useCase) {
  const u = String(useCase || "").toLowerCase().trim();
  if (!u) return "";
  if (u.includes("makan") || u.includes("eat_now")) return "Eat Now";
  if (u.includes("stock") || u.includes("frozen-rumah")) return "Stock Frozen";
  if (u.includes("meeting") || u.includes("acara")) return "Meeting/Event";
  if (u.includes("gift") || u.includes("hampers")) return "Gift/Hampers";
  return "";
}

function derivePreferredProduct(draft) {
  const items = Array.isArray(draft?.items) ? draft.items : [];
  let frozen = 0;
  let goreng = 0;
  for (const it of items) {
    const qty = Number(it?.qty || 1);
    const form = String(it?.form || "").toLowerCase();
    if (form === "frozen") frozen += qty;
    else if (form === "goreng") goreng += qty;
  }
  if (frozen > 0 && goreng === 0) return "Frozen";
  if (goreng > 0 && frozen === 0) return "Goreng";
  if (frozen > goreng) return "Frozen";
  if (goreng > frozen) return "Goreng";
  if (frozen > 0 || goreng > 0) return "Mix";
  return "";
}

function appendNoteSafe(existingNotes, newNote, maxChars = 900) {
  const base = String(existingNotes || "").trim();
  const next = String(newNote || "").trim();
  if (!next) return base;
  if (!base) return next.slice(0, maxChars);
  if (base.includes(next)) return base.slice(0, maxChars);
  return `${base} | ${next}`.slice(0, maxChars);
}

function calcOrderQty(items) {
  return (Array.isArray(items) ? items : []).reduce((s, it) => {
    const qty = Number(it?.qty || 0);
    const pack = Number(it?.pack_size || 1);
    return s + qty * pack;
  }, 0);
}

function monthKeyYmd(ymd) {
  const m = String(ymd || "").match(/^(\d{4})-(\d{2})-/);
  return m ? `${m[1]}-${m[2]}` : "";
}

function computeCustomerMetrics({ eventType, draft, existingCustomer }) {
  const ex = existingCustomer || {};
  const exQty = toNum(ex["Total quantity _Order_Closing"]);
  const exOmzet = toNum(ex["Total_Omzet"]);
  const exAov = toNum(ex["Average_Order (AOV)"]);
  const exOmzetMonth = toNum(ex["Omzet_Bulan_Ini"]);
  const nowYmd = fmtYmd(nowJakartaDate());
  const nowMonth = monthKeyYmd(nowYmd);
  const orderQty = calcOrderQty(draft?.items || []);
  const orderOmzet = toNum(draft?.grand_total || (toNum(draft?.subtotal) + toNum(draft?.ongkir)));
  const exLastOrder = String(ex["Last_Order"] || "");
  let totalQtyClosing = exQty;
  let totalOmzet = exOmzet;
  let omzetBulanIni = exOmzetMonth;
  let lastOrder = exLastOrder;

  if (eventType === "payment_approved") {
    totalQtyClosing = exQty + orderQty;
    totalOmzet = exOmzet + orderOmzet;
    lastOrder = nowYmd;
    const exMonth = monthKeyYmd(exLastOrder);
    if (exMonth === nowMonth) omzetBulanIni = exOmzetMonth + orderOmzet;
    else omzetBulanIni = orderOmzet;
  }

  let closedCount = 0;
  if (exAov > 0 && exOmzet > 0) closedCount = Math.max(1, Math.round(exOmzet / exAov));
  if (eventType === "payment_approved") closedCount += 1;
  const aov = closedCount > 0 ? Math.round(totalOmzet / closedCount) : exAov;

  let hari = ex["Hari_Sejak_Last_Order"] || "";
  if (lastOrder) {
    const t0 = new Date(`${lastOrder}T00:00:00+07:00`).getTime();
    const t1 = new Date(`${nowYmd}T00:00:00+07:00`).getTime();
    if (Number.isFinite(t0) && Number.isFinite(t1) && t1 >= t0) {
      hari = Math.floor((t1 - t0) / 86400000);
    }
  }

  return {
    totalQtyClosing,
    totalOmzet,
    aov,
    omzetBulanIni,
    lastOrder,
    firstOrderCandidate: nowYmd,
    hariSejakLastOrder: hari,
  };
}

function buildCustomerDbRowFromDraft(draft, event, existingCustomer) {
  const ex = existingCustomer || {};
  const ev = event || {};
  const metrics = computeCustomerMetrics({ eventType: ev.type, draft, existingCustomer: ex });
  const nowStr = new Date().toISOString();
  const note = `${nowStr} ${ev.type || "event"}${draft?.grand_total ? ` total=${draft.grand_total}` : ""}`;
  return {
    "No_WA": normalizePhone08(draft?.phone || ev.phone || ex["No_WA"] || ""),
    "Nama": pickNonEmpty(draft?.customer_name, ex["Nama"], ""),
    "Alamat": pickNonEmpty(draft?.address_text, draft?.destination?.address_text, ex["Alamat"], ""),
    "Segment_CRM_Auto": pickNonEmpty(deriveSegmentFromUseCase(draft?.use_case), ex["Segment_CRM_Auto"], ""),
    "First_Order": ex["First_Order"] || metrics.firstOrderCandidate || "",
    "Last_Order": metrics.lastOrder || ex["Last_Order"] || "",
    "Total quantity _Order_Closing": metrics.totalQtyClosing,
    "Total_Omzet": metrics.totalOmzet,
    "Average_Order (AOV)": metrics.aov,
    "Omzet_Bulan_Ini": metrics.omzetBulanIni,
    "Hari_Sejak_Last_Order": metrics.hariSejakLastOrder,
    "Opt_In_WA": ex["Opt_In_WA"] || "TRUE",
    "Saved_Contact": ex["Saved_Contact"] || (draft?.customer_name ? "Yes" : ""),
    "Preferred_Channel": "WhatsApp",
    "Preferred_Product": pickNonEmpty(derivePreferredProduct(draft), ex["Preferred_Product"], ""),
    "Last_Aftersales_Status": ex["Last_Aftersales_Status"] || "",
    "Last_Broadcast_Date": ex["Last_Broadcast_Date"] || "",
    "Last_Broadcast_Program": ex["Last_Broadcast_Program"] || "",
    "Last_Response": pickNonEmpty(ev.lastResponse, ex["Last_Response"], ""),
    "Last_Offer": pickNonEmpty(ev.lastOffer, ex["Last_Offer"], ""),
    "Next_Broadcast_Date": ex["Next_Broadcast_Date"] || "",
    "Priority_Level": ex["Priority_Level"] || "WARM",
    "Notes": appendNoteSafe(ex["Notes"] || "", note),
  };
}

async function runSentuhGsheet(args = [], stdinObj = null, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const cp = require("child_process");
    const child = cp.spawn("docker", [
      "exec", "-i", OPENCLAW_EXEC_CONTAINER,
      "node", "/data/sentuhrasa-pdf/scripts/sentuh-gsheet.mjs",
      ...args,
    ], { timeout: timeoutMs });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", c => { stdout += c; });
    child.stderr.on("data", c => { stderr += c; });
    child.on("error", (err) => resolve({ ok: false, error: err.message, stdout, stderr }));
    child.on("close", (code) => {
      let parsed = null;
      const lines = String(stdout || "").trim().split(/\r?\n/).filter(Boolean);
      if (lines.length) {
        try { parsed = JSON.parse(lines[lines.length - 1]); } catch (_) {}
      }
      resolve({ ok: code === 0, code, stdout, stderr, parsed });
    });
    child.stdin.end(stdinObj ? JSON.stringify(stdinObj) : undefined);
  });
}

function extractCustomerRow(resp) {
  if (!resp || !resp.ok) return null;
  const p = resp.parsed || {};
  if (p && typeof p.row === "object" && p.row) return p.row;
  if (p && typeof p.data === "object" && p.data) return p.data;
  if (p && typeof p.customer === "object" && p.customer) return p.customer;
  return null;
}

async function syncCustomerDbEvent(from, eventType, draft, extra = {}) {
  try {
    const gsheetUrl = process.env.GSHEET_GAS_URL || "";
    if (!gsheetUrl) {
      log("gsheet-sync", "disabled missing_url");
      return;
    }
    log("gsheet-sync", `event=${eventType} target=Customer_DB mode=upsertCustomer start`);
    const noWa = normalizePhone08(from);
    const getRes = await runSentuhGsheet(["--get-customer", noWa], null, 5000);
    const existingRow = extractCustomerRow(getRes) || {};
    const row = buildCustomerDbRowFromDraft(
      { ...(draft || {}), phone: from },
      { type: eventType, phone: from, lastResponse: extra.lastResponse || eventType, lastOffer: extra.lastOffer || "" },
      existingRow
    );
    const upRes = await runSentuhGsheet(["--upsert-customer"], { row }, 5000);
    if (upRes.ok) log("gsheet-sync", `event=${eventType} target=Customer_DB mode=upsertCustomer success`);
    else log("gsheet-sync", `event=${eventType} failed reason=${(upRes.stderr || upRes.error || upRes.stdout || "unknown").slice(0, 160)}`);
  } catch (e) {
    log("gsheet-sync", `event=${eventType} failed reason=${e.message}`);
  }
}

// =====================================================
// --- Login to OpenClaw ---
function loginToOpenClaw() {
  return new Promise((resolve, reject) => {
    const data = "token=" + encodeURIComponent(OPENCLAW_TOKEN);
    const req = http.request({
      hostname: OPENCLAW_HOST,
      port: OPENCLAW_PORT,
      path: "/login",
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(data),
      },
    }, (res) => {
      const statusCode = res.statusCode || 0;
      res.resume();
      const cookie = res.headers["set-cookie"]?.[0]?.split(";")[0];
      if (cookie) { gatewaySessionCookie = cookie; resolve(cookie); }
      else if (statusCode === 404 || statusCode === 405) {
        log("gateway", "OpenClaw /login unavailable, falling back to direct WebSocket auth");
        gatewaySessionCookie = null;
        resolve(null);
      } else {
        reject(new Error("No session cookie from OpenClaw"));
      }
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// --- Heartbeat ---
function startHeartbeat() {
  stopHeartbeat();
  pingTimer = setInterval(() => {
    if (gatewayWs && gatewayWs.readyState === WebSocket.OPEN) {
      gatewayWs.ping();
      pongTimer = setTimeout(() => {
        log("heartbeat", "Pong timeout - closing connection");
        if (gatewayWs) gatewayWs.terminate();
      }, PONG_TIMEOUT_MS);
    }
  }, PING_INTERVAL_MS);
}
function stopHeartbeat() {
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
}

// --- Reconnection ---
function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = Math.min(BACKOFF_INITIAL_MS * Math.pow(2, reconnectAttempt), BACKOFF_MAX_MS);
  reconnectAttempt++;
  log("reconnect", "Attempt " + reconnectAttempt + " in " + delay + "ms");
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connectGateway(); }, delay);
}

// --- Connect to OpenClaw gateway ---
async function connectGateway() {
  if (gatewayWs && gatewayWs.readyState === WebSocket.OPEN) return;
  if (gatewayWs) { try { gatewayWs.terminate(); } catch (_) {} gatewayWs = null; }

  try {
    if (!gatewaySessionCookie) await loginToOpenClaw();
    const wsOpts = gatewaySessionCookie
      ? { headers: { Cookie: gatewaySessionCookie } }
      : undefined;
    gatewayWs = new WebSocket("ws://" + OPENCLAW_HOST + ":" + OPENCLAW_PORT, wsOpts);

    gatewayWs.on("open", () => log("gateway", "WebSocket connected"));
    gatewayWs.on("pong", () => { if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; } });

    gatewayWs.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "event" && msg.event === "connect.challenge") {
          gatewayWs.send(JSON.stringify({
            type: "req", id: crypto.randomUUID(), method: "connect",
            params: {
              minProtocol: PROTOCOL_VERSION, maxProtocol: PROTOCOL_VERSION,
              client: { id: "gateway-client", displayName: "WA-CloudAPI-Bridge", version: "1.3.0", platform: "linux", mode: "backend" },
              caps: [], auth: { token: OPENCLAW_TOKEN }, role: "operator", scopes: ["operator.admin", "operator.write"],
            },
          }));
          return;
        }
        if (msg.type === "res" && msg.ok === true && msg.payload?.protocol) {
          gatewayReady = true; reconnectAttempt = 0;
          log("gateway", "Authenticated, protocol: " + msg.payload.protocol);
          startHeartbeat(); drainQueue(); return;
        }
        if (msg.type === "event" && msg.event === "chat") {
          const p = msg.payload;
          const pending = pendingChats.get(p.runId);
          if (!pending) return;
          if (p.state === "delta" || p.state === "final") {
            const text = p.message?.content?.[0]?.text;
            if (text) pending.text = text;
          }
          if (p.state === "final") {
            if (pending.text) {
              clearTimeout(pending.timer); pending.resolve(pending.text); pendingChats.delete(p.runId);
            } else {
              // Tool call returned with no text yet - wait for next final with actual text (up to CHAT_TIMEOUT_MS)
              log("chat", "Final with empty text (tool call in progress), waiting for reply...");
            }
          }
          if (p.state === "error") { clearTimeout(pending.timer); pending.reject(new Error(p.errorMessage || "OpenClaw error")); pendingChats.delete(p.runId); }
          if (p.state === "aborted") { clearTimeout(pending.timer); pending.reject(new Error("OpenClaw aborted")); pendingChats.delete(p.runId); }
          return;
        }
        if (msg.type === "res" && msg.ok === false) {
          log("gateway", "Error response: " + (msg.error?.message || "unknown"));
          const pending = pendingChats.get(msg.id);
          if (pending) { clearTimeout(pending.timer); pending.reject(new Error(msg.error?.message || "Gateway error")); pendingChats.delete(msg.id); }
        }
      } catch (e) { log("gateway", "Parse error: " + e.message); }
    });

    gatewayWs.on("close", (code, reason) => { log("gateway", "Closed: " + code + " " + reason.toString()); gatewaySessionCookie = null; cleanup(); scheduleReconnect(); });
    gatewayWs.on("error", (err) => { log("gateway", "Error: " + err.message); gatewaySessionCookie = null; });
  } catch (err) {
    log("gateway", "Connect failed: " + err.message);
    gatewaySessionCookie = null; cleanup(); scheduleReconnect();
  }
}

function cleanup() {
  gatewayReady = false; gatewayWs = null; stopHeartbeat();
  for (const [id, pending] of pendingChats.entries()) { clearTimeout(pending.timer); pending.reject(new Error("Gateway disconnected")); }
  pendingChats.clear();
}

// --- Message queue ---
function drainQueue() {
  if (processingQueue || messageQueue.length === 0) return;
  processingQueue = true;
  (async () => {
    while (messageQueue.length > 0 && gatewayReady) {
      const item = messageQueue.shift();
      // 2026-05-07 QA: clear the orphan timeout when the item drains so it
      // can't fire 4 min later and incorrectly reject some OTHER queued item
      // with the same (phoneNumber, message) shape.
      if (item.timer) clearTimeout(item.timer);
      try { const reply = await sendToOpenClaw(item.phoneNumber, item.message); item.resolve(reply); }
      catch (err) { item.reject(err); }
    }
    processingQueue = false;
  })();
}
function enqueueMessage(phoneNumber, message) {
  return new Promise((resolve, reject) => {
    if (gatewayReady) return sendToOpenClaw(phoneNumber, message).then(resolve, reject);
    log("queue", "Gateway not ready, queuing message from " + phoneNumber);
    // 2026-05-07 QA: previously the timeout used findIndex by (phone, message)
    // which could splice a LATER enqueued duplicate (e.g. customer re-sending
    // "halo" twice) and reject the wrong promise. Track the queue entry by
    // identity (object reference) and store the timer on it so drainQueue
    // can clear it when the item is consumed.
    const item = { phoneNumber, message, resolve, reject, timer: null };
    item.timer = setTimeout(() => {
      const idx = messageQueue.indexOf(item);  // identity match, not content match
      if (idx !== -1) {
        messageQueue.splice(idx, 1);
        reject(new Error("Queued message timeout"));
      }
    }, CHAT_TIMEOUT_MS);
    messageQueue.push(item);
  });
}

// --- Send to OpenClaw ---
function sendToOpenClaw(phoneNumber, message) {
  return new Promise((resolve, reject) => {
    if (!gatewayReady || !gatewayWs || gatewayWs.readyState !== WebSocket.OPEN) return reject(new Error("Gateway not connected"));
    const idempotencyKey = crypto.randomUUID();
    const frame = {
      type: "req", id: crypto.randomUUID(), method: "chat.send",
      params: { sessionKey: "whatsapp:" + phoneNumber, message: message, idempotencyKey: idempotencyKey },
    };
    const timer = setTimeout(() => { pendingChats.delete(idempotencyKey); reject(new Error("OpenClaw response timeout")); }, CHAT_TIMEOUT_MS);
    pendingChats.set(idempotencyKey, { resolve, reject, text: "", timer });
    gatewayWs.send(JSON.stringify(frame));
    log("chat", "Sent to whatsapp:" + phoneNumber + " text=" + (typeof message === "string" ? message.slice(0,200) : JSON.stringify(message).slice(0,200)));
  });
}
// Inject sendToOpenClaw into lib modules that need it for LLM fallback
if (am) am.init(sendToOpenClaw);

// --- Download WhatsApp media ---
async function downloadWhatsAppMedia(mediaId) {
  // Step 1: Get media URL
  const metaUrl = "https://graph.facebook.com/" + WA_API_VERSION + "/" + mediaId;
  const mediaInfo = await new Promise((resolve, reject) => {
    const req = https.request(metaUrl, {
      method: "GET",
      headers: { Authorization: "Bearer " + WA_ACCESS_TOKEN },
    }, (res) => {
      let data = ""; res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(JSON.parse(data));
        else reject(new Error("Media info error " + res.statusCode + ": " + data));
      });
    });
    req.on("error", reject); req.end();
  });

  // Step 2: Download the actual file
  const downloadUrl = new URL(mediaInfo.url);
  const fileData = await new Promise((resolve, reject) => {
    const req = https.request(downloadUrl, {
      method: "GET",
      headers: { Authorization: "Bearer " + WA_ACCESS_TOKEN },
    }, (res) => {
      const chunks = []; res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(Buffer.concat(chunks));
        else reject(new Error("Media download error " + res.statusCode));
      });
    });
    req.on("error", reject); req.end();
  });

  return { data: fileData, mimeType: mediaInfo.mime_type || "image/jpeg" };
}

// --- Upload image to imgbb ---
async function uploadToImgbb(imageBuffer) {
  const base64Image = imageBuffer.toString("base64");
  const formData = "key=" + IMGBB_KEY + "&image=" + encodeURIComponent(base64Image);

  return new Promise((resolve, reject) => {
    const req = https.request("https://api.imgbb.com/1/upload", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(formData) },
    }, (res) => {
      let data = ""; res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const result = JSON.parse(data);
          if (result.data && result.data.url) resolve(result.data.url);
          else reject(new Error("imgbb upload failed: " + data.substring(0, 200)));
        } catch (e) { reject(new Error("imgbb parse error: " + e.message)); }
      });
    });
    req.on("error", reject); req.write(formData); req.end();
  });
}

// --- Handle image message: download, upload, return URL ---
async function handleImageMessage(msg) {
  const mediaId = msg.image?.id;
  if (!mediaId) return { text: "[Image received - no media ID]", url: null };

  try {
    log("image", "Downloading media " + mediaId);
    const media = await downloadWhatsAppMedia(mediaId);

    // Save locally for audit
    if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const filename = "IMG-" + Date.now() + (media.mimeType.includes("png") ? ".png" : ".jpg");
    const localPath = path.join(UPLOAD_DIR, filename);
    fs.writeFileSync(localPath, media.data);
    log("image", "Saved locally: " + localPath);

    // Upload to imgbb
    log("image", "Uploading to imgbb...");
    const imgUrl = await uploadToImgbb(media.data);
    log("image", "imgbb URL: " + imgUrl);

    const caption = msg.image?.caption || "";
    const selfHostedUrl = RECEIPT_BASE_URL + filename;
    log("image", "Self-hosted URL: " + selfHostedUrl);
    return { text: caption, url: selfHostedUrl, localPath: localPath, imgbbUrl: imgUrl };
  } catch (err) {
    log("image", "Failed to process image: " + err.message);
    return { text: msg.image?.caption || "", url: null, error: err.message };
  }
}

// --- Raw body (global parser, 1 MB limit) ---
// Admin upload routes (/admin-send-image, /admin-send-document) are excluded here
// so they can use their own route-level parsers with higher limits (15 MB / 110 MB).
// Signature verification (rawBody) is only needed for Meta webhook — not admin uploads.
app.use((req, res, next) => {
  if (req.path === "/admin-send-image" || req.path === "/admin-send-document") return next();
  express.json({ limit: "1mb", verify: (req, _res, buf) => { req.rawBody = buf; } })(req, res, next);
});

// --- Signature verification ---
function verifySignature(req) {
  if (!META_APP_SECRET) return true;
  const sig = req.headers["x-hub-signature-256"];
  if (!sig) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", META_APP_SECRET).update(req.rawBody).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

// --- WhatsApp Cloud API: send text ---

// Strip LLM internal-monologue / debugging leaks from customer-facing replies.
const OPENCLAW_META_BLOCK_RE = /```json[\s\S]*?openclaw\.inbound_meta\.v2[\s\S]*?```/i;
const OPENCLAW_META_JSON_RE = /\{\s*"schema"\s*:\s*"openclaw\.inbound_meta\.v2"[\s\S]*?\}/i;
const OPENCLAW_META_TOKEN_RE = /openclaw\.inbound_meta\.v2|"(?:schema|channel|provider|surface|chat_type)"\s*:/i;
const OPENCLAW_EN_FALLBACK_RE = /i\s+don'?t\s+have\s+enough\s+information|can\s+you\s+provide\s+more\s+context/i;

// Triggered by SOUL.md rule #2 violations on 2026-05-04: the LLM emitted things
// like "Aku nemu akar masalahnya, script ini baca JSON dari stdin, bukan argv".
// Customer must NEVER see these. Drops any paragraph containing the listed tokens.
const SANITIZE_TOKENS = [
  /\bstdin\b/i, /\bargv\b/i, /\bJSON\b/, /\bpayload\b/i, /\bparameter\b/i,
  /\bAPI\b/, /\bdebug\b/i, /\bexception\b/i,
  /\bscript(nya|ku|ini|ongkir|nya)?\b/i,
  /akar\s+masalah/i,
  /rute\s+cadangan/i,
  /format\s+(yang\s+benar|payload)/i,
  /(Aku|Mintu)\s+(jalanin|coba)\s+(ulang|lagi)/i,
  /\b(kubenerin|kuperbaiki|kucoba|kujalanin)\b/i,
  /boleh\s+kirim.*kode\s+pos/i,
  /share\s+pin\s+lokasi.*kode\s+pos/i,
  /kode\s+pos\s+juga\s+ya/i,
  // 2026-05-05: invoice/payment preambles seen in production
  /Aku\s+lanjut\s+proses\s+ongkir/i,
  /Mintu\s+cek\s+ongkir(?:nya)?\s+dulu\s+biar\s+invoice/i,
  /format\s+kiriman(?:nya)?/i,
  /lewat\s+jalur(?:\s+yang\s+benar)?/i,
  /perlu\s+diproses(?:\s+lewat)?/i,
  /Mintu\s+lanjut\s+kirim\s+detail\s+pembayar/i,
  /lokasi\s+sudah\s+masuk\s+tapi/i,
  // OpenClaw gateway echo: "Sender (untrusted metadata)" + memory context JSON
  /Sender\s*\(untrusted\s*metadata\)/i,
  /customer_memory.*product_knowledge.*admin_validated_knowledge/i,
  /WA-CloudAPI-Bridge\s*\(gateway-client\)/i,
];
function trimLLMPreamble(text) {
  if (!text) return text;
  // Invoice block: keep from first 📍 Pengiriman onwards
  const invMatch = text.match(/📍\s*\*?Pengiriman/);
  if (invMatch && invMatch.index > 20) {
    log("preamble", "stripped invoice preamble: " + text.slice(0, Math.min(invMatch.index, 120)).replace(/\n/g, "\\n"));
    return text.slice(invMatch.index);
  }
  // Payment block: keep from first 💰 Total or "Cara bayar" onwards
  const payMatch = text.match(/💰\s*\*?Total|\*Cara\s+bayar:?\*/);
  if (payMatch && payMatch.index > 20) {
    log("preamble", "stripped payment preamble: " + text.slice(0, Math.min(payMatch.index, 120)).replace(/\n/g, "\\n"));
    return text.slice(payMatch.index);
  }
  return text;
}

// OpenClaw gateway echo guard: strip "Sender (untrusted metadata)" + context JSON
const OPENCLAW_GATEWAY_ECHO_RE = /Sender\s*\(untrusted\s*metadata\)\s*:\s*\\n```(?:json)?/i;
function sanitizeLLMReply(text) {
  if (!text) return text;
  text = String(text);
  // Strip NO_REPLY marker before paragraph check (so remaining content is preserved)
  text = text.replace(/\s*NO_REPLY\s*/gi, "");
  if (OPENCLAW_META_BLOCK_RE.test(text) || OPENCLAW_META_JSON_RE.test(text) || OPENCLAW_META_TOKEN_RE.test(text) || OPENCLAW_GATEWAY_ECHO_RE.test(text)) {
    log("sanitize", "stripping OpenClaw meta block from reply");
    text = text.replace(OPENCLAW_META_BLOCK_RE, "");
    text = text.replace(OPENCLAW_META_JSON_RE, "");
    text = text.replace(OPENCLAW_GATEWAY_ECHO_RE, "");
  }
  text = trimLLMPreamble(text).trim();
  const paragraphs = text.split(/\n{2,}/);
  const kept = [];
  let dropped = 0;
  for (const para of paragraphs) {
    const hit = SANITIZE_TOKENS.find(re => re.test(para));
    if (hit) {
      dropped++;
      log("sanitize", "stripped paragraph (" + hit.source + "): " + para.slice(0, 80).replace(/\n/g, "\\n"));
    } else {
      kept.push(para);
    }
  }
  const out = (dropped > 0 ? kept.join("\n\n") : text).trim();
  if (!out || out.length < 15 || OPENCLAW_META_TOKEN_RE.test(out) || OPENCLAW_EN_FALLBACK_RE.test(out) || /Sender\s*\(untrusted\s*metadata\)/i.test(out)) {
    log("sanitize", "reply blocked after sanitization; replacing with safe holding message");
    return "Sebentar ya Kak, Mintu bantu cek dulu ya 🤍";
  }
  return out;
}
// 24h WA service window: Meta blocks free-form outbound if user hasn't messaged in 24h.
// Pre-send check prevents silent 131009 failures and gives us a clear log entry.
// Admin/finance numbers are exempted — they initiate contact via the bot's own line.
const WA_24H_MS = 24 * 60 * 60 * 1000;
function isWaWindowOpen(toPhone) {
  if (!toPhone) return true;
  const norm = String(toPhone).replace(/[^0-9]/g, '');
  if (ADMIN_PHONES.includes(norm)) return true;  // admin always allowed
  const draft = loadSbsrDraft(norm);
  if (!draft || !draft.last_inbound_at) return true;  // first contact: allow
  const ageMs = Date.now() - new Date(draft.last_inbound_at).getTime();
  if (!isFinite(ageMs)) return true;  // bad timestamp: allow rather than block
  return ageMs < WA_24H_MS;
}

async function sendWhatsAppMessage(to, text, replyToMessageId, opts = {}) {
  const adminRelay = !!(opts && opts.adminRelay);
  if (adminRelay) {
    log("admin-relay", "sanitizer bypass active");
    log("admin-relay", "sending manual admin message");
    text = String(text == null ? "" : text);
  } else {
    text = sanitizeLLMReply(text);
  }
  if (!isWaWindowOpen(to)) {
    log('wa-window', 'outbound to ' + to + ' SKIPPED — last_inbound > 24h ago (window closed)');
    return null;  // Stage 4 template flow can pick this up later; do NOT throw.
  }
  const url = "https://graph.facebook.com/" + WA_API_VERSION + "/" + WA_PHONE_NUMBER_ID + "/messages";
  const payload = { messaging_product: "whatsapp", recipient_type: "individual", to: to, type: "text", text: { preview_url: false, body: text } };
  if (replyToMessageId) payload.context = { message_id: replyToMessageId };
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: "POST",
      headers: { Authorization: "Bearer " + WA_ACCESS_TOKEN, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let data = ""; res.on("data", (chunk) => (data += chunk));
      res.on("end", () => { if (res.statusCode >= 200 && res.statusCode < 300) { safeLog(admin.logOutgoing, to, text); try { const _norm = String(to).replace(/[^0-9]/g, ''); if (!ADMIN_PHONES.includes(_norm)) { const _dr = loadSbsrDraft(to) || { phone: _norm }; saveSbsrDraft(to, { ..._dr, last_reply_at: new Date().toISOString() }); } } catch (_) {} resolve(JSON.parse(data)); } else { log("wa-send", "Error " + res.statusCode + ": " + data); reject(new Error("WA API error " + res.statusCode)); } });
    });
    req.on("error", reject); req.write(body); req.end();
  });
}

// --- WhatsApp Cloud API: send Finance Approve/Reject interactive buttons ---
async function sendWhatsAppFinanceButtons(to, bodyText, suffix) {
  const url = "https://graph.facebook.com/" + WA_API_VERSION + "/" + WA_PHONE_NUMBER_ID + "/messages";
  const truncated = String(bodyText || "").slice(0, 1020);
  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: truncated },
      // Footer max 60 chars per WA Cloud API (#131009). Was 61 → caused 400.
      footer: { text: "Tap tombol atau balas APPROVE/REJECT manual" },
      action: {
        buttons: [
          { type: "reply", reply: { id: "sbsr_approve_" + suffix, title: "✅ Approve" } },
          { type: "reply", reply: { id: "sbsr_reject_"  + suffix, title: "❌ Reject"  } },
        ],
      },
    },
  };
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: "POST",
      headers: { Authorization: "Bearer " + WA_ACCESS_TOKEN, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let data = ""; res.on("data", (c) => data += c);
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(JSON.parse(data));
        else { log("wa-finance-btn", "Error " + res.statusCode + ": " + data); reject(new Error("WA finance-btn error " + res.statusCode)); }
      });
    });
    req.on("error", reject); req.write(body); req.end();
  });
}

// --- WhatsApp Cloud API: send general interactive buttons ---
async function sendWhatsAppInteractiveButtons(to, bodyText, buttons) {
  const url = "https://graph.facebook.com/" + WA_API_VERSION + "/" + WA_PHONE_NUMBER_ID + "/messages";
  const truncated = String(bodyText || "").slice(0, 1020);
  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: truncated },
      action: { buttons: buttons },
    },
  };
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: "POST",
      headers: { Authorization: "Bearer " + WA_ACCESS_TOKEN, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let data = ""; res.on("data", (c) => data += c);
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(JSON.parse(data));
        else { log("wa-interactive-btn", "Error " + res.statusCode + ": " + data); reject(new Error("WA btn error " + res.statusCode)); }
      });
    });
    req.on("error", reject); req.write(body); req.end();
  });
}

async function sendWhatsAppLocationRequest(to, bodyText) {
  const url = "https://graph.facebook.com/" + WA_API_VERSION + "/" + WA_PHONE_NUMBER_ID + "/messages";
  const truncated = String(bodyText || "").slice(0, 1020);
  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: to,
    type: "interactive",
    interactive: {
      type: "location_request_message",
      body: { text: truncated },
      action: { name: "send_location" },
    },
  };
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: "POST",
      headers: { Authorization: "Bearer " + WA_ACCESS_TOKEN, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let data = ""; res.on("data", (c) => data += c);
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(JSON.parse(data));
        else { log("wa-location-request", "Error " + res.statusCode + ": " + data); reject(new Error("WA location-request error " + res.statusCode)); }
      });
    });
    req.on("error", reject); req.write(body); req.end();
  });
}

function getSbsrFinancePhones() {
  const raw = (process.env.SBSR_FINANCE_PHONES || "").split(",").map(s => s.replace(/[^0-9]/g, "")).filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const phone of raw) {
    // Accept any phone with 8-15 digits (covers 62-ID, 49-DE, other intl formats)
    if (phone.length < 8 || phone.length > 15) {
      log("admin-phone", "skip invalid finance phone=" + phone);
      continue;
    }
    if (seen.has(phone)) continue;
    seen.add(phone);
    out.push(phone);
  }
  return out;
}

async function notifySbsrAdminsText(summary, logTag) {
  const fins = getSbsrFinancePhones();
  if (fins.length === 0) {
    log(logTag || "sbsr-admin", "no valid SBSR_FINANCE_PHONES set");
    return 0;
  }
  let sent = 0;
  for (const fin of fins) {
    try {
      await sendWhatsAppMessage(fin, summary);
      sent++;
      log(logTag || "sbsr-admin", "sent to " + fin);
    } catch (e) {
      log(logTag || "sbsr-admin", "failed to " + fin + ": " + e.message);
    }
  }
  return sent;
}

async function notifyPaymentProofAdmins(bodyText, suffix, fallbackText, label) {
  const fins = getSbsrFinancePhones();
  const tag = "payment-proof-admin";
  log(tag, "notifying " + label + " admin count=" + fins.length);
  if (fins.length === 0) {
    log(tag, "no_valid_admin_numbers");
    return 0;
  }
  let sent = 0;
  for (const fin of fins) {
    try {
      await sendWhatsAppFinanceButtons(fin, bodyText, suffix);
      sent++;
      log(tag, "sent to " + fin);
    } catch (e) {
      log(tag, "failed to " + fin + ": " + e.message);
      if (!fallbackText) continue;
      try {
        await sendWhatsAppMessage(fin, fallbackText);
        sent++;
        log(tag, "sent to " + fin + " via text fallback");
      } catch (e2) {
        log(tag, "failed to " + fin + " via text fallback: " + e2.message);
      }
    }
  }
  return sent;
}

// --- WhatsApp Cloud API: send interactive list message ---
// =====================================================
// WhatsApp Cloud API: send Meta catalog as interactive product_list
// Triggered by [CATALOG] token in agent reply.
// =====================================================
async function sendWhatsAppCatalog(to, bodyText, footerText) {
  // Use Meta interactive.catalog_message — simpler 'browse all' button card
  // (more reliable than product_list for new catalogs; matches Rosalie's working pattern)
  if (!process.env.WA_CATALOG_ID) {
    log("wa-catalog", "WA_CATALOG_ID not set");
    throw new Error("WA_CATALOG_ID missing");
  }
  const url = "https://graph.facebook.com/" + WA_API_VERSION + "/" + WA_PHONE_NUMBER_ID + "/messages";
  const payload = {
    messaging_product: "whatsapp",
    recipient_type:    "individual",
    to: to,
    type: "interactive",
    interactive: {
      type: "catalog_message",
      body: { text: bodyText || "Pilih varian Sentuh Rasa dari katalog ya 🤍" },
      action: { name: "catalog_message" },
    },
  };
  log("wa-catalog", "media_url=meta_catalog_managed");
  log("wa-catalog", "media_check status=unknown-via-catalog-api");
  if (footerText) payload.interactive.footer = { text: footerText };
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: "POST",
      headers: { Authorization: "Bearer " + WA_ACCESS_TOKEN, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let data = ""; res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) { log("wa-catalog", "Catalog sent to " + to); resolve(JSON.parse(data)); }
        else { log("wa-catalog", "Error " + res.statusCode + ": " + data); reject(new Error("WA catalog error " + res.statusCode + ": " + data.substring(0,200))); }
      });
    });
    req.on("error", reject); req.write(body); req.end();
  });
}

async function sendCatalogDeterministicFallback(from, reason) {
  const draft = loadSbsrDraft(from) || { phone: from };
  const text = [
    "Menu katalog lagi gangguan sebentar ya Kak 🤍",
    "Mintu bantu lanjut pakai menu teks dulu:",
    "",
    "1. makan langsung",
    "2. stock frozen dirumah",
    "3. untuk meeting/acara kak",
    "4. untuk gift/hampers",
  ].join("\n");
  saveSbsrDraft(from, {
    ...draft,
    state: "awaiting_usecase",
    pending_usecase_prompt: null,
    pending_menu_prompt: null,
    menu_interrupt_pending: null,
  });
  try {
    await sendWhatsAppMessage(from, text);
    log("sbsr-catalog-fallback", "sent_text_menu");
  } catch (e) {
    log("sbsr-catalog-fallback", "send failed: " + e.message);
  }
  if (reason) log("wa-catalog", "fallback reason: " + String(reason).slice(0, 220));
  return true;
}

async function sendWhatsAppInteractiveList(to) {
  const url = "https://graph.facebook.com/" + WA_API_VERSION + "/" + WA_PHONE_NUMBER_ID + "/messages";
  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: to,
    type: "interactive",
    interactive: {
      type: "list",
      header: { type: "text", text: "Menu Airoklin" },
      body: { text: "Halo! Gw Airo, bot admin Airoklin. Pilih yang mau lo kerjain:" },
      action: {
        button: "Pilih Menu",
        sections: [
          {
            title: "Layanan",
            rows: [
              { id: "uc_expense", title: "Catat Expense", description: "Catat pengeluaran ke dashboard" },
              { id: "uc_revenue", title: "Catat Revenue", description: "Catat pemasukan ke dashboard" },
              { id: "uc_fpd", title: "Bayar Tukang/Jasa (FPD)", description: "Reimbursement / Overhead / Kasbon" },
              { id: "uc_invoice", title: "Tagihan Client (Invoice)", description: "Bill client + simpan PDF ke Drive" },
              { id: "uc_postig", title: "Post di Instagram", description: "Bikin poster + post ke IG" }
            ]
          }
        ]
      }
    }
  };
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: "POST",
      headers: { Authorization: "Bearer " + WA_ACCESS_TOKEN, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let data = ""; res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) { log("wa-menu", "Interactive list sent to " + to); resolve(JSON.parse(data)); }
        else { log("wa-menu", "Error " + res.statusCode + ": " + data); reject(new Error("WA interactive error " + res.statusCode)); }
      });
    });
    req.on("error", reject); req.write(body); req.end();
  });
}

// --- WhatsApp Cloud API: upload media ---
async function uploadMediaToWhatsApp(filePath, mimeType) {
  const url = "https://graph.facebook.com/" + WA_API_VERSION + "/" + WA_PHONE_NUMBER_ID + "/media";
  const fileData = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);
  const boundary = "----FormBoundary" + crypto.randomUUID().replace(/-/g, "");

  const parts = [];
  parts.push(Buffer.from("--" + boundary + "\r\nContent-Disposition: form-data; name=\"messaging_product\"\r\n\r\nwhatsapp\r\n"));
  parts.push(Buffer.from("--" + boundary + "\r\nContent-Disposition: form-data; name=\"type\"\r\n\r\n" + mimeType + "\r\n"));
  parts.push(Buffer.from("--" + boundary + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"" + fileName + "\"\r\nContent-Type: " + mimeType + "\r\n\r\n"));
  parts.push(fileData);
  parts.push(Buffer.from("\r\n--" + boundary + "--\r\n"));
  const bodyBuffer = Buffer.concat(parts);

  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: "POST",
      headers: { Authorization: "Bearer " + WA_ACCESS_TOKEN, "Content-Type": "multipart/form-data; boundary=" + boundary, "Content-Length": bodyBuffer.length },
    }, (res) => {
      let data = ""; res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) { const parsed = JSON.parse(data); resolve(parsed.id); }
        else {
          log("wa-upload", "Error " + res.statusCode + ": " + data);
          let waMsg = "Media upload error " + res.statusCode;
          try { const e = JSON.parse(data); waMsg = (e.error && (e.error.message || e.error.error_user_msg)) ? e.error.message : waMsg; } catch (_) {}
          reject(new Error(waMsg));
        }
      });
    });
    req.on("error", reject); req.write(bodyBuffer); req.end();
  });
}

// --- WhatsApp Cloud API: send document by media ID ---

async function sendWhatsAppVideo(to, mediaId, caption) {
  const url = "https://graph.facebook.com/" + WA_API_VERSION + "/" + WA_PHONE_NUMBER_ID + "/messages";
  const payload = {
    messaging_product: "whatsapp", recipient_type: "individual", to: to, type: "video",
    video: { id: mediaId, caption: caption || "" },
  };
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: "POST",
      headers: { Authorization: "Bearer " + WA_ACCESS_TOKEN, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let data = ""; res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) { log("wa-video", "Video sent to " + to); resolve(JSON.parse(data)); }
        else { log("wa-video", "Error " + res.statusCode + ": " + data); reject(new Error("WA video error " + res.statusCode)); }
      });
    });
    req.on("error", reject); req.write(body); req.end();
  });
}

async function sendWhatsAppImage(to, mediaId, caption) {
  const url = "https://graph.facebook.com/" + WA_API_VERSION + "/" + WA_PHONE_NUMBER_ID + "/messages";
  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: to,
    type: "image",
    image: { id: mediaId, caption: caption || "" },
  };
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: "POST",
      headers: { Authorization: "Bearer " + WA_ACCESS_TOKEN, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let data = ""; res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) { log("wa-image", "Image sent to " + to); resolve(JSON.parse(data)); }
        else { log("wa-image", "Error " + res.statusCode + ": " + data); reject(new Error("WA image error " + res.statusCode)); }
      });
    });
    req.on("error", reject); req.write(body); req.end();
  });
}

const QRIS_MEDIA_MARKER_RE = /\[MEDIA:\s*QRIS\.png\]/i;
async function maybeSendQrisMarkerMedia(to, text, totalRaw) {
  if (!text || !QRIS_MEDIA_MARKER_RE.test(text)) return { text, sent: false };
  log("qris-media", "start send");
  log("qris-media", "marker detected");
  const stripped = String(text)
    .replace(QRIS_MEDIA_MARKER_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  try {
    const qrisHostPath = "/docker/wa-webhook-sbsr/static/sentuhrasa-pdf/assets/qris-static.png";
    if (!fs.existsSync(qrisHostPath)) {
      log("qris-media", "qris file missing: " + qrisHostPath);
      return { text: stripped, sent: false };
    }
    const mediaId = await uploadMediaToWhatsApp(qrisHostPath, "image/png");
    const total = Number(totalRaw || 0);
    await sendWhatsAppImage(to, mediaId, "QRIS Sentuh Rasa — Total Rp " + total.toLocaleString("id-ID"));
    log("qris-media", "image sent");
    return { text: stripped, sent: true };
  } catch (e) {
    log("qris-media", "failed=" + e.message);
    return { text: stripped, sent: false };
  }
}

async function sendWhatsAppDocument(to, mediaId, filename, caption) {
  const url = "https://graph.facebook.com/" + WA_API_VERSION + "/" + WA_PHONE_NUMBER_ID + "/messages";
  const payload = {
    messaging_product: "whatsapp", recipient_type: "individual", to: to, type: "document",
    document: { id: mediaId, filename: filename || "document.pdf" },
  };
  if (caption) payload.document.caption = caption;
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: "POST",
      headers: { Authorization: "Bearer " + WA_ACCESS_TOKEN, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let data = ""; res.on("data", (chunk) => (data += chunk));
      res.on("end", () => { if (res.statusCode >= 200 && res.statusCode < 300) resolve(JSON.parse(data)); else { log("wa-doc", "Error " + res.statusCode + ": " + data); reject(new Error("WA doc error " + res.statusCode)); } });
    });
    req.on("error", reject); req.write(body); req.end();
  });
}

// --- Mark as read ---
async function markAsRead(messageId) {
  const url = "https://graph.facebook.com/" + WA_API_VERSION + "/" + WA_PHONE_NUMBER_ID + "/messages";
  const body = JSON.stringify({ messaging_product: "whatsapp", status: "read", message_id: messageId });
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: "POST", headers: { Authorization: "Bearer " + WA_ACCESS_TOKEN, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
      (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve(d)); });
    req.on("error", reject); req.write(body); req.end();
  });
}

// --- WhatsApp Cloud API: typing indicator (shown under business name header) ---
// Appears for ~25s or until bot replies. Must be sent within 10s of receiving message.
// Replaces the older "hourglass reaction" pattern — typing dots feel native + auto-dismiss
// when the reply lands, no clear-call needed. Mirrors Rosalie's wa-webhook pattern.
async function sendTypingIndicator(to, messageId) {
  if (!messageId) return;
  const url = "https://graph.facebook.com/" + WA_API_VERSION + "/" + WA_PHONE_NUMBER_ID + "/messages";
  const body = JSON.stringify({
    messaging_product: "whatsapp",
    status: "read",
    message_id: messageId,
    typing_indicator: { type: "text" }
  });
  return new Promise((resolve) => {
    const req = https.request(url, {
      method: "POST",
      headers: { Authorization: "Bearer " + WA_ACCESS_TOKEN, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let d = ""; res.on("data", (c) => (d += c));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          log("wa-typing", "ok for " + to + " (wamid=" + (messageId || "").substring(0, 40) + ")");
          resolve(true);
        } else {
          log("wa-typing", "non-2xx " + res.statusCode + " for " + to + " (wamid=" + (messageId || "").substring(0, 40) + "): " + d.substring(0, 200));
          resolve(false);
        }
      });
    });
    req.on("error", (e) => { log("wa-typing", "error: " + e.message); resolve(false); });
    req.write(body); req.end();
  });
}

// --- Send reaction ---
async function sendReaction(to, messageId, emoji) {
  const url = "https://graph.facebook.com/" + WA_API_VERSION + "/" + WA_PHONE_NUMBER_ID + "/messages";
  const body = JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to: to, type: "reaction", reaction: { message_id: messageId, emoji: emoji || "" } });
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: "POST", headers: { Authorization: "Bearer " + WA_ACCESS_TOKEN, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
      (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve(d)); });
    req.on("error", reject); req.write(body); req.end();
  });
}

// --- Split long messages ---
function splitMessage(text, maxLen) {
  maxLen = maxLen || 4000;
  if (text.length <= maxLen) return [text];
  const parts = []; let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) { parts.push(remaining); break; }
    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt < maxLen * 0.3) splitAt = maxLen;
    parts.push(remaining.substring(0, splitAt));
    remaining = remaining.substring(splitAt).trimStart();
  }
  return parts;
}

// =====================================================
// IG Approval/Cancel Pre-Handler (bridge-level, bypasses LLM hallucination)
// =====================================================

// =====================================================
// PO Approval Pre-Handler — same shape as IG approval but checks po-pending dir
// =====================================================

// =====================================================
// PO Create Pre-Handler — bridge intercepts "buat PO ..." and runs the generator directly.
// =====================================================

// =====================================================
// Saldo Pre-Handler — bridge intercepts "saldo / ringkasan / total bulan ini"
// and reads LIVE from Google Sheet via Apps Script GET ?action=summary.
// Falls back to local journal.json if sheet read fails.
// =====================================================
const APPS_SCRIPT_SUMMARY_URL = 'https://script.google.com/macros/s/AKfycbyQ-gXZCg7rx9Ia8pWVX8Q8PLcFSS3W-I6F8su4VzglZ1uFCFi1YORgak4BSOdkldX0/exec?action=summary';

function fetchSheetSummary() {
  return new Promise((resolve) => {
    https.get(APPS_SCRIPT_SUMMARY_URL, { timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          // Apps Script can return 302 redirect — follow it
          if (res.statusCode === 301 || res.statusCode === 302) {
            const loc = res.headers.location;
            if (loc) {
              https.get(loc, { timeout: 10000 }, (r2) => {
                let d2 = '';
                r2.on('data', c => d2 += c);
                r2.on('end', () => { try { resolve(JSON.parse(d2)); } catch (_) { resolve(null); } });
              }).on('error', () => resolve(null));
              return;
            }
          }
          resolve(JSON.parse(data));
        } catch (_) { resolve(null); }
      });
    }).on('error', () => resolve(null)).on('timeout', () => resolve(null));
  });
}

function readLocalJournal() {
  try {
    const { spawn } = require('child_process');
    return new Promise((resolve) => {
      let stdout = '';
      const c = spawn('docker', ['exec', OPENCLAW_EXEC_CONTAINER,
        'cat', '/data/.openclaw/workspace/beeru/journal.json'], { timeout: 5000 });
      c.stdout.on('data', d => stdout += d.toString());
      c.on('close', () => {
        try { resolve(JSON.parse(stdout).entries || []); } catch (_) { resolve([]); }
      });
      c.on('error', () => resolve([]));
    });
  } catch (_) { return Promise.resolve([]); }
}

function rupiah(n) {
  const v = Number(n) || 0;
  return 'Rp ' + v.toLocaleString('id-ID');
}


// =====================================================
// Receipt OCR Pre-Processor — runs read-receipt.js on incoming images
// BEFORE handing to LLM, so bot sees structured OCR data and can't hallucinate "link keblok"
// =====================================================
function runReceiptOCROnce(imageUrl) {
  return new Promise((resolve) => {
    const { spawn } = require('child_process');
    let stdout = '';
    let stderr = '';
    // Source ig-env.sh before invoking so OPENROUTER_API_KEY (the working key) is exported
    // — the hardcoded key inside read-receipt.js is exhausted; env override fixes it.
    const c = spawn('docker', ['exec', OPENCLAW_EXEC_CONTAINER,
      'bash', '-c',
      'set -a; . /data/.openclaw/ig-env.sh; node /data/airoklin-pdf/scripts/read-receipt.js ' + JSON.stringify(imageUrl)],
      { timeout: 45000 });
    c.stdout.on('data', d => { stdout += d.toString(); });
    c.stderr.on('data', d => { stderr += d.toString(); });
    c.on('close', (code) => {
      const trimmed = stdout.trim();
      let jsonStr = trimmed;
      const firstBrace = trimmed.indexOf('{');
      const lastBrace = trimmed.lastIndexOf('}');
      if (firstBrace >= 0 && lastBrace > firstBrace) jsonStr = trimmed.slice(firstBrace, lastBrace + 1);
      try {
        const parsed = JSON.parse(jsonStr);
        // Treat as failure if every field is null (Gemini probably couldn't fetch the URL)
        const allNull = parsed && parsed.merchant == null && parsed.total == null && parsed.date == null
                        && (!parsed.items || parsed.items.length === 0);
        resolve({ ok: !allNull, data: parsed, code, stdout: trimmed.slice(0,200), stderr: stderr.slice(0,200) });
      } catch (e) {
        resolve({ ok: false, data: null, code, stdout: trimmed.slice(0,200), stderr: stderr.slice(0,200), parseErr: e.message });
      }
    });
    c.on('error', (err) => {
      resolve({ ok: false, data: null, error: err.message });
    });
  });
}

async function runReceiptOCR(imageUrl, altImageUrl) {
  const targets = [imageUrl, altImageUrl].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);
  for (let idx = 0; idx < targets.length; idx++) {
    const target = targets[idx];
    if (idx > 0) log('ocr-bridge', 'fallback target=' + target);
    let r = await runReceiptOCROnce(target);
    if (r.ok) return r.data;
    log('ocr-bridge', 'first try failed (' + (r.parseErr || r.error || 'all-null/code=' + r.code) + '), retrying in 2s...');
    await new Promise(res => setTimeout(res, 2000));
    r = await runReceiptOCROnce(target);
    if (r.ok) {
      log('ocr-bridge', 'retry succeeded');
      return r.data;
    }
    log('ocr-bridge', 'retry also failed: code=' + r.code + ' stderr=' + (r.stderr || '') + ' stdoutHead=' + (r.stdout || ''));
  }
  return null;
}

function formatOCRForBot(ocr) {
  if (!ocr) return '';
  const fmt = (v) => (v == null || v === '' ? '?' : String(v));
  const rupiah = (n) => (n == null ? '?' : 'Rp ' + Number(n).toLocaleString('id-ID'));
  const lines = [];
  lines.push('--- OCR RESULT (from read-receipt.js) ---');
  if (ocr.merchant) lines.push('Merchant/Bank: ' + fmt(ocr.merchant));
  if (ocr.date) lines.push('Tanggal: ' + fmt(ocr.date));
  if (ocr.total != null) lines.push('Total: ' + rupiah(ocr.total));
  if (ocr.berita) lines.push('Berita/Keterangan: ' + fmt(ocr.berita));
  if (ocr.recipient_name) lines.push('Penerima: ' + fmt(ocr.recipient_name));
  if (ocr.sender_name) lines.push('Pengirim: ' + fmt(ocr.sender_name));
  if (Array.isArray(ocr.items) && ocr.items.length) {
    lines.push('Items:');
    ocr.items.slice(0, 8).forEach(it => {
      lines.push('  - ' + fmt(it.name) + ' x' + fmt(it.qty) + ' @ ' + rupiah(it.price));
    });
  }
  lines.push('--- END OCR ---');
  return lines.join('\n');
}

// =====================================================
// IG Topic Reply Pre-Handler — if the user previously clicked "Post di Instagram" from the menu
// without specifying a topic, the bridge wrote ig-awaiting-topic/<phone>.json and asked them
// what to post about. This handler intercepts the next message and treats it as the topic.
// =====================================================

// =====================================================
// IG Post Pre-Handler — bridge intercepts "Post di IG..." / "posting IG..." / "buat poster..."
// and runs post-pop directly. Bypasses unreliable LLM tool-calling.
// =====================================================

// --- Process incoming message ---

// =====================================================
// #2 Bridge-level inbound dedup — gated by SBSR_IDEMPOTENT=true (default OFF)
// =====================================================
// Catches Meta webhook retries: when bridge takes >5s to ACK, Meta resends the
// same message_id; without dedup, handleMessage would fire twice and any
// non-state-guarded write (sentuh-payment, sentuh-invoice, generic WA sends)
// could duplicate. 60s TTL covers Meta's retry window (~30s typical, <60s rare).
const PROCESSED_MSG_IDS = new Map();           // message_id -> insert timestamp (ms)
const PROCESSED_MSG_TTL_MS = 60_000;           // 60 seconds — covers Meta's retry window
const PROCESSED_MSG_MAX = 200;                  // soft cap — triggers prune
function _pruneProcessedIds() {
  const cutoff = Date.now() - PROCESSED_MSG_TTL_MS;
  for (const [id, t] of PROCESSED_MSG_IDS) { if (t < cutoff) PROCESSED_MSG_IDS.delete(id); }
}
function shouldDedupeMessageId(messageId) {
  if (!messageId) return false;
  if (process.env.SBSR_IDEMPOTENT !== 'true') return false;
  if (PROCESSED_MSG_IDS.size > PROCESSED_MSG_MAX) _pruneProcessedIds();
  const seen = PROCESSED_MSG_IDS.get(messageId);
  if (seen && (Date.now() - seen) < PROCESSED_MSG_TTL_MS) return true;
  PROCESSED_MSG_IDS.set(messageId, Date.now());
  return false;
}

// =====================================================
// Sentuh Rasa: OK/YA intercept after invoice → auto-fire sentuh-payment.mjs
// =====================================================
const SBSR_DRAFTS_DIR = process.env.SBSR_DRAFTS_DIR || "/opt/sbsr/data/openclaw/.openclaw/workspace/drafts";
// Multi-word affirmative: leading OK-keyword + optional trailing affirmation/filler words.
// Matches: "ok", "ya", "ok bener", "ya bener kak", "siap lanjut", "ok deal", "bener kak", "ok aja".
// Rejects: "ok tapi tunggu", "ya tolong ganti" — anything with non-affirmation words after.
const SBSR_OK_RE = /^(?:ok|oke|okay|okey|yes|y|ya|sip|siap|setuju|lanjut|gas|deal|gpp|bener|benar|betul|udah|dah|fix|👍|🤍)(?:[\s,.]+(?:ok|oke|okay|okey|ya|sip|siap|setuju|lanjut|gas|deal|gpp|bener|benar|betul|udah|dah|fix|kak|kakak|aja|deh|nih|lah|dong|sih|sudah))*\s*[.!,?]*\s*$/i;

function loadSbsrDraft(phoneRaw) { return (draftStore && draftStore.load(phoneRaw)) || null; }
function sbsrDraftPath(phoneRaw) { return draftStore ? draftStore.draftPath(phoneRaw) : ''; }
function saveSbsrDraft(phoneRaw, draft) { if (draftStore) draftStore.save(phoneRaw, draft); }
function setPendingBridgeContext(phoneRaw, ctx) { if (draftStore) draftStore.setPendingBridgeContext(phoneRaw, ctx); }
function consumePendingBridgeContext(phoneRaw) { return draftStore ? draftStore.consumePendingBridgeContext(phoneRaw) : null; }

function fmtRupiah(n) {
  return "Rp " + (Number(n) || 0).toLocaleString("id-ID");
}
const SBSR_CHECKOUT_COLLECTION_STATES = new Set([
  "awaiting_name", "awaiting_addon", "addon_offer", "upsell_pending", "awaiting_delivery_method", "awaiting_address_pin_confirm",
  "awaiting_address", "awaiting_pin_confirm", "awaiting_courier_choice", "awaiting_meeting_package_confirm",
  "awaiting_location_retry",
]);

// Wrong-input detection: location states where customer must send a
// Maps URL or WhatsApp native location. Anything else triggers LLM
// guidance + WhatsApp Location Request Message with "Send Location" button.
const WRONG_INPUT_LOCATION_STATES = new Set([
  "awaiting_address",
  "awaiting_pin_confirm",
  "awaiting_location_retry",
  "awaiting_location",
]);

const SBSR_CHECKOUT_LOCK_STATES = new Set([
  "awaiting_invoice_confirm", "awaiting_proof", "pending_finance",
  "approved", "booked", "delivered", "cancelled",
  "awaiting_manual_payment_review", "payment_verified_manual"
]);
const SBSR_CHECKOUT_ENGLISH_GUARD_RE = /(Thanks,|Give me just a moment|Okay, final details|Sudah termasuk pajak|NO_REPLY|bridge will handle|awaiting the image|payment confirmation|interactive WhatsApp catalog|waiting for customer)/i;

function sbsrDraftHasDestination(draft) { return draftStore ? draftStore.hasDestination(draft) : false; }
function isSbsrCheckoutCollectionActive(draft) { return draftStore ? draftStore.isCheckoutActive(draft) : false; }


// === OOC HANDLER V3: handle out-of-context questions during checkout ===

function getSbsrDeterministicMissingStateMessage(from, draft) {
  const st = String(draft?.state || "").trim().toLowerCase();
  if (st === "awaiting_delivery_method") return buildSbsrDeliveryMethodPromptText();
  if (st === "awaiting_address_pin_confirm") return "Balas 1 (alamat), 2 (pin Maps), atau 3 (kirim ulang) ya Kak 🤍";
  if (st === "awaiting_location_retry") return "Kak, boleh coba kirim ulang link Google Maps, Share Location WhatsApp, atau screenshot titik lokasi ya 🤍";
  const customerName = draft.customer_name || (typeof findNameInChatHistory === "function" ? findNameInChatHistory(from) : null);
  if (!customerName) {
    return "Boleh info atas nama siapa Kak? Biar Mintu lanjut cek ongkirnya 🤍";
  }
  if (!sbsrDraftHasDestination(draft) && !(draft.gmaps_link || (draft.destination && draft.destination.gmaps_link))) {
    return "Boleh kirim lokasi pakai fitur Share Location WhatsApp ya Kak 🤍";
  }
  const addressText = (draft.pending_address_text || (draft.destination && draft.destination.address_text) || "").trim();
  if (!addressText || addressText.startsWith("(alamat dari pin)")) {
    return "Boleh kirim alamat lengkap pengiriman ya Kak 🤍";
  }
  return "Sebentar ya Kak, Mintu lagi lanjut cek ongkir dulu 🤍";
}

// Proactive location prompt: when draft state is in a location-requiring state,
// send via WhatsApp interactive Location Request Message (with "Send Location"
// button) instead of plain text. For awaiting_address, only use the button when
// the customer hasn't shared a destination yet — if they've already shared a
// pin but we just need the typed address, plain text is more appropriate.
async function sendSbsrLocationPromptMessage(from, draft, bodyText) {
  const st = String(draft?.state || "").trim().toLowerCase();
  if (!WRONG_INPUT_LOCATION_STATES.has(st)) {
    return sendWhatsAppMessage(from, bodyText);
  }
  // awaiting_pin_confirm: customer is supposed to reply YA/NO, not share new location.
  // Sending a location button here would be confusing.
  if (st === "awaiting_pin_confirm") {
    return sendWhatsAppMessage(from, bodyText);
  }
  // awaiting_address: only send location button if no destination coordinates yet.
  // If customer already shared a pin but address text is missing, the prompt is
  // asking for typed address — plain text is the right medium.
  if (st === "awaiting_address") {
    const hasDest = sbsrDraftHasDestination(draft) || !!(draft.gmaps_link || (draft.destination && draft.destination.gmaps_link));
    if (hasDest) {
      return sendWhatsAppMessage(from, bodyText);
    }
  }
  return sendWhatsAppLocationRequest(from, bodyText);
}

function shouldBlockSbsrCheckoutEnglishReply(from, text) {
  if (!text || !SBSR_CHECKOUT_ENGLISH_GUARD_RE.test(String(text))) return false;
  const draft = loadSbsrDraft(from);
  return isSbsrCheckoutCollectionActive(draft);
}

function shouldBlockOpenClawCheckoutLeak(text) {
  const t = String(text || "");
  if (!t) return false;
  return /\bNO_REPLY\b|waiting\s+for\s+customer|select\s+variations|fried\s*\/\s*frozen|interactive\s+catalog|bridge\s+will\s+handle|awaiting\s+the\s+image|payment\s+confirmation/i.test(t);
}

function getSbsrCheckoutEnglishFallback(from) {
  const draft = loadSbsrDraft(from) || {};
  return getSbsrDeterministicMissingStateMessage(from, draft);
}
// Sniff the LLM's invoice text (sentuh-invoice.mjs format) and snapshot grand_total + name
// to the draft. Acts as a safety net so the OK/YA intercept works even when the LLM forgot to
// pass `phone` to sentuh-invoice.mjs.

// Sniff Google Maps share URL out of any inbound customer message and persist to draft.
// Common forms: maps.app.goo.gl/XXX, goo.gl/maps/XXX, maps.google.com/?q=..., google.com/maps/...
const MAPS_URL_RE = /(https?:\/\/(?:[a-z0-9.-]*\.)?(?:maps\.app\.goo\.gl|goo\.gl\/maps|maps\.google\.com|google\.com\/maps)\/?[^\s)]*)/i;
const MAPS_HINT_RE = /(maps\.app\.goo\.gl|google\.com\/maps|goo\.gl\/maps|\/maps\/place\/|\/maps\/search\/|@-?\d+(?:\.\d+)?,\s*-?\d+(?:\.\d+)?)/i;
function sniffMapsLinkFromCustomer(from, userText) {
  if (!userText) return;
  const m = userText.match(MAPS_URL_RE);
  if (!m) return;
  const url = m[1];
  const draft = loadSbsrDraft(from) || { phone: from };
  if (draft.gmaps_link === url) return;
  saveSbsrDraft(from, { ...draft, gmaps_link: url, gmaps_link_seen_at: new Date().toISOString() });
  log("sbsr-maps-sniff", "stored maps url for " + from + " (" + url.slice(0, 60) + ")");
}

// Resolve a Google Maps short URL to {lat,lng} via redirect-following + regex.
// Mirrors sentuh-quote.mjs resolveGmapsUrl so the bridge can validate URLs before
// committing to a deterministic intercept reply. Returns null if no coords extractable.
const SBSR_GMAPS_COORD_PATTERNS = (mapsGeocode && mapsGeocode.SBSR_GMAPS_COORD_PATTERNS) || [
  /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/,
  /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/,
  /(?:[?&#]|^)q=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)(?:[&#/]|$)/i,
  /(?:[?&#]|^)ll=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)(?:[&#/]|$)/i,
  /[?&#]destination=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:[&#]|$)/i,
];
const SBSR_GMAPS_DIRECT_PATTERNS = (mapsGeocode && mapsGeocode.SBSR_GMAPS_DIRECT_PATTERNS) || [
  { kind: "!3d!4d", re: /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/i },
  { kind: "q=lat,lng", re: /(?:[?&#]|^)q=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)(?:[&#/]|$)/i },
  { kind: "@lat,lng", re: /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:,|$)/ },
  { kind: "ll=lat,lng", re: /(?:[?&#]|^)ll=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)(?:[&#/]|$)/i },
  { kind: "destination=lat,lng", re: /[?&#]destination=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:[&#]|$)/i },
];
const SBSR_GMAPS_HOST_RE = (mapsGeocode && mapsGeocode.SBSR_GMAPS_HOST_RE) || /^https?:\/\/(?:[a-z0-9.-]*\.)?(?:maps\.app\.goo\.gl|goo\.gl\/maps|maps\.google\.com|google\.com\/maps)\/?/i;
const SBSR_GMAPS_RESOLVE_UA = (mapsGeocode && mapsGeocode.SBSR_GMAPS_RESOLVE_UA) || "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36";
function isSbsrCoordInRegion() { return mapsGeocode ? mapsGeocode.isSbsrCoordInRegion.apply(null, arguments) : null; }
function finalizeSbsrCoords() { return mapsGeocode ? mapsGeocode.finalizeSbsrCoords.apply(null, arguments) : null; }
function decodeMapsPlaceFromUrlBridge() { return mapsGeocode ? mapsGeocode.decodeMapsPlaceFromUrlBridge.apply(null, arguments) : null; }
function buildPlaceGeocodeCandidates() { return mapsGeocode ? mapsGeocode.buildPlaceGeocodeCandidates.apply(null, arguments) : null; }
function geocodeMapsPlaceBridge() { return mapsGeocode ? mapsGeocode.geocodeMapsPlaceBridge.apply(null, arguments) : null; }
function parseDirectGmapsCoordsBridge() { return mapsGeocode ? mapsGeocode.parseDirectGmapsCoordsBridge.apply(null, arguments) : null; }
function extractCoordsFromMapsUrlBridge() { return mapsGeocode ? mapsGeocode.extractCoordsFromMapsUrlBridge.apply(null, arguments) : null; }
function fetchMapsRedirectUrlBridge() { return mapsGeocode ? mapsGeocode.fetchMapsRedirectUrlBridge.apply(null, arguments) : null; }
function resolveGmapsUrlBridge() { return mapsGeocode ? mapsGeocode.resolveGmapsUrlBridge.apply(null, arguments) : null; }

function parseScriptJSON() { return mapsGeocode ? mapsGeocode.parseScriptJSON.apply(null, arguments) : null; }

// =====================================================
// LLM-Assisted Semantic Address Verification (secondary layer)
// Conditions: confidence=low + typed_geocode_failed + same_kecamatan + SBSR_ENABLE_LLM_ADDRESS_MATCH=true
// Existing validator remains source of truth. Fail-open: any error -> null -> existing behavior.
// =====================================================
async function maybeSemanticAddressMatch({ addressText, mapsAddress, typedGeo, sameKecamatan, distKm }) {
  if (process.env.SBSR_ENABLE_LLM_ADDRESS_MATCH !== "true") return null;
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) { log("sbsr-address-llm", "no_api_key_skip"); return null; }
  const addr = String(addressText || "").trim();
  const maps = String(mapsAddress || "").trim();
  if (!addr || !maps) return null;
  log("sbsr-address-llm", "evaluating");
  const systemPrompt = [
    "Kamu adalah validator alamat pengiriman.",
    "Tugasmu HANYA mengevaluasi apakah dua alamat kemungkinan besar merujuk ke area yang sama di dunia nyata.",
    "Aturan:",
    "- Nama jalan mirip + kecamatan sama = kemungkinan match, meski nomor rumah berbeda",
    "- Fokus pada nama jalan dan kecamatan, bukan nomor rumah",
    "- Nomor rumah berbeda di jalan yang sama = masih bisa match",
    "- Jangan halusinasi atau mengarang informasi",
    "- Jika ragu, jawab semantic_match: false",
    "- Jawab hanya JSON tanpa markdown",
  ].join("\n");
  const distLine = distKm !== null ? ("Estimasi jarak: " + distKm.toFixed(1) + " km") : "Jarak: tidak bisa dihitung";
  const userMsg = [
    "Evaluasi apakah dua alamat ini kemungkinan masih area yang sama:",
    "",
    "Alamat diketik customer: \"" + addr + "\"",
    "Alamat dari Maps pin: \"" + maps + "\"",
    "Geocode typed address: " + (typedGeo ? "berhasil" : "gagal (fallback kecamatan)"),
    "Kecamatan sama: " + (sameKecamatan ? "ya" : "tidak"),
    distLine,
    "",
    "Jawab HANYA dengan JSON (tanpa markdown): {\"semantic_match\": true|false, \"confidence\": \"low|medium|high\", \"reason\": \"alasan singkat Bahasa Indonesia\"}",
  ].join("\n");
  try {
    const body = JSON.stringify({
      model: "openai/gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMsg },
      ],
      max_tokens: 150,
      temperature: 0.1,
    });
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + apiKey,
        "HTTP-Referer": "https://biks.ai",
        "X-Title": "SBSR Address Validator",
      },
      body,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) { log("sbsr-address-llm", "api_error status=" + res.status); return null; }
    const data = await res.json();
    const raw = String((data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "").trim();
    const cleaned = raw.replace(/^```(?:json)?\n?/i, "").replace(/\n?```$/i, "").trim();
    let result;
    try { result = JSON.parse(cleaned); }
    catch (_e) { log("sbsr-address-llm", "parse_err raw=" + raw.slice(0, 120)); return null; }
    const match = result.semantic_match === true;
    const confidence = String(result.confidence || "low").toLowerCase();
    const reason = String(result.reason || "").slice(0, 200);
    log("sbsr-address-llm", "semantic_match=" + String(match));
    log("sbsr-address-llm", "confidence=" + confidence);
    log("sbsr-address-llm", "reason=" + reason);
    return { semantic_match: match, confidence: confidence, reason: reason };
  } catch (e) {
    log("sbsr-address-llm", "error=" + e.message);
    log("sbsr-address-llm", "fallback_existing_validator");
    return null;
  }
}

// =====================================================
// Semantic Address Match — general-purpose LLM validator for Indonesian addresses.
// Interface: { typedAddress, resolvedMapsAddress }
// Returns: { match: bool, confidence: "high"|"medium"|"low", reason: string } or null
// Fail-open: any error → null → caller uses existing deterministic result.
// =====================================================
async function semanticAddressMatch({ typedAddress, resolvedMapsAddress }) {
  if (process.env.SBSR_ENABLE_LLM_ADDRESS_MATCH !== "true") return null;
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) { log("sbsr-address-semantic", "no_api_key"); return null; }
  const addr = String(typedAddress || "").trim();
  const maps = String(resolvedMapsAddress || "").trim();
  if (!addr || !maps) return null;
  const systemPrompt = [
    "Kamu adalah semantic validator alamat Indonesia.",
    "Tugas: menentukan apakah alamat customer dan alamat Google Maps kemungkinan lokasi yang sama.",
    "Rules:",
    "- fokus pada nama jalan",
    "- fokus pada kelurahan",
    "- fokus pada kecamatan",
    "- toleransi typo",
    "- toleransi RT/RW hilang atau berbeda",
    "- toleransi format berbeda",
    "- toleransi nomor rumah beda kecil (satu digit)",
    "- jangan terlalu strict",
    "- jika kemungkinan besar area sama → match=true",
    "- jika ragu → match=false",
    "- jawab hanya JSON tanpa markdown",
  ].join("\n");
  const userMsg = [
    "Tentukan apakah dua alamat ini kemungkinan besar lokasi yang sama:",
    "",
    "Alamat customer: \"" + addr + "\"",
    "Alamat Google Maps: \"" + maps + "\"",
    "",
    "Jawab HANYA JSON: {\"match\": true|false, \"confidence\": \"high|medium|low\", \"reason\": \"alasan singkat\"}",
  ].join("\n");
  try {
    const body = JSON.stringify({
      model: "google/gemini-2.5-flash-preview-06-25",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMsg },
      ],
      max_tokens: 120,
      temperature: 0.1,
    });
    let res = null;
    for (let _r = 0; _r < 3; _r++) {
      if (_r > 0) { log("sbsr-address-semantic", "retry_" + _r); await new Promise(r => setTimeout(r, 1000 * _r)); }
      const _ctrl = new AbortController();
      const _tm = setTimeout(() => _ctrl.abort(), 15000);
      try {
        res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + apiKey,
            "HTTP-Referer": "https://biks.ai",
            "X-Title": "SBSR Semantic Address Validator",
          },
          body,
          signal: _ctrl.signal,
        });
        clearTimeout(_tm);
        if (res.ok) break;
        log("sbsr-address-semantic", "api_error=" + res.status);
        if (res.status !== 429 && res.status < 500) { res = null; break; }
        res = null;
      } catch (_e) {
        clearTimeout(_tm);
        log("sbsr-address-semantic", "retry_err=" + _e.message);
        res = null;
      }
    }
    if (!res) { log("sbsr-address-semantic", "gave_up"); return null; }
    const data = await res.json();
    const raw = String((data?.choices?.[0]?.message?.content) || "").trim();
    const cleaned = raw.replace(/^```(?:json)?[\r\n]*/i, "").replace(/[\r\n]*```$/i, "").trim();
    let result;
    try { result = JSON.parse(cleaned); }
    catch (_e) { log("sbsr-address-semantic", "parse_err raw=" + raw.slice(0, 100)); return null; }
    return {
      match: result.match === true,
      confidence: String(result.confidence || "low").toLowerCase(),
      reason: String(result.reason || "").slice(0, 200),
    };
  } catch (e) {
    log("sbsr-address-semantic", "error=" + e.message);
    return null;
  }
}

async function tryHandleAddressAndQuote(from, userText) {
  if (!userText) return false;
  // Note: we DO NOT exclude admin here — operator routinely tests as customer
  // from the admin number. The other gates (items + customer_name in draft) are enough.
  const draft = loadSbsrDraft(from);
  if (!draft) return false;
  if (!Array.isArray(draft.items) || draft.items.length === 0) return false;
  // Safety net: if no delivery_mode set but message has maps URL/coords, auto-set to delivery
  if (!draft.delivery_mode || String(draft.state || "").trim().toLowerCase() === "awaiting_delivery_method") {
    const _hasMapsUrl = MAPS_URL_RE.test(String(userText || ""));
    const _hasSavedCoords = Number.isFinite(Number(draft.destination?.lat)) && Number.isFinite(Number(draft.destination?.lng));
    if (!draft.delivery_mode && (_hasMapsUrl || _hasSavedCoords || draft.gmaps_link)) {
      saveSbsrDraft(from, { ...draft, delivery_mode: "delivery", delivery_mode_set_at: new Date().toISOString() });
      log("sbsr-delivery-mode", "auto-set delivery from maps/coords for " + from);
    } else {
      if (/^(?:1|2|delivery|dikirim|kirim|antar|pickup|ambil\s*sendiri|ambil|mampir)$/i.test(String(userText).trim())) {
        saveSbsrDraft(from, { ...draft, state: "awaiting_delivery_method" });
        await sendWhatsAppMessage(from, buildSbsrDeliveryMethodPromptText());
        log("sbsr-delivery-method", "prompt_sent");
        return true;
      }
      log("sbsr-delivery-method", "addr_quote_fallthrough_to_global for " + from);
      return false;
    }
  }
  const um = userText.match(MAPS_URL_RE);
  const hasMapsHint = MAPS_HINT_RE.test(String(userText || ""));
  const savedDest = draft.destination || {};
  const hasSavedCoords = Number.isFinite(Number(savedDest.lat)) && Number.isFinite(Number(savedDest.lng));
  const hasSavedPostal = !!savedDest.postal_code;
  if (!um && !hasSavedCoords && !hasSavedPostal && !hasMapsHint) return false;
  // If draft has no customer_name yet, try to pull it from this message:
  //   "Nama\nJohn Biks" / "Nama: John Biks" / "atas nama John Biks"
  if (!draft.customer_name) {
    // 1) Try name in current message ("Saya X" / "Aku X" / "Nama saya X" / "Atas nama X" / standalone)
    let extracted = (typeof extractCustomerName === "function") ? extractCustomerName(userText) : null;
    let nameSource = "current-msg";
    // 2) Fallback: scan recent inbound chat history (rescues customers who gave the name
    //    earlier in the conversation but the bridge missed it — e.g. before deploy).
    if (!extracted) {
      extracted = findNameInChatHistory(from);
      if (extracted) nameSource = "chat-history";
    }
    if (extracted) {
      draft.customer_name = extracted;
      draft.customer_name_set_at = new Date().toISOString();
      log("sbsr-addr-quote", `extracted customer_name (${nameSource}): ${draft.customer_name}`);
    } else {
      // No name anywhere — break the silent stall by asking deterministically.
      // Save the URL to draft so the next inbound (the name) can resume the quote.
      const url = um ? um[1] : (draft.gmaps_link || (draft.destination && draft.destination.gmaps_link) || null);
      saveSbsrDraft(from, { ...draft, ...(url ? { gmaps_link: url, gmaps_link_seen_at: new Date().toISOString() } : {}) });
      try {
        await sendWhatsAppMessage(from,
          "Lokasinya sudah Mintu terima 🤍\n\n" +
          "Boleh info atas nama siapa Kak? Biar Mintu lanjut cek ongkir + ekspedisinya."
        );
      } catch (e) { log("sbsr-addr-quote", "name-prompt send err: " + e.message); }
      setPendingBridgeContext(from, [
        "Bridge sudah terima maps URL + simpan ke draft, dan minta nama customer.",
        "STATE: draft punya items + gmaps_link, tapi belum ada customer_name.",
        "JANGAN tanya alamat / pin lagi — sudah disimpan.",
        "Tunggu customer kirim nama → bridge name-capture akan fire-trigger quote otomatis.",
      ].join("\n"));
      log("sbsr-addr-quote", "from=" + from + " no name anywhere, sent name prompt + saved URL");
      return true;
    }
  }
  // Skip if already at/past invoice
  if (["awaiting_invoice_confirm", "awaiting_proof", "pending_finance", "approved", "booked", "delivered", "cancelled"].includes(draft.state)) return false;

  const url = um ? um[1] : (draft.gmaps_link || savedDest.gmaps_link || null);
  let resolved = null;
  if (um) {
    resolved = await resolveGmapsUrlBridge(url).catch(() => null);
    log("sbsr-location", "source=" + (/maps\.app\.goo\.gl/i.test(url) ? "maps_app" : "gmaps_link"));
  } else if (hasSavedCoords) {
    resolved = { lat: Number(savedDest.lat), lng: Number(savedDest.lng) };
    log("sbsr-location", "source=gmaps_preview");
  } else if (hasSavedPostal) {
    resolved = { postal_code: savedDest.postal_code };
  } else if (hasMapsHint) {
    const direct = parseDirectGmapsCoordsBridge(userText) || extractCoordsFromMapsUrlBridge(userText);
    if (direct) {
      resolved = direct;
      log("sbsr-location", "source=gmaps_preview");
      log("gmaps-resolve", "extracted_coordinates");
    }
  }
  const unresolvedMeta = (resolved && resolved.unresolved) ? resolved : null;
  if (!resolved || unresolvedMeta) {
    const decodedPlace = unresolvedMeta?.decoded_place || decodeMapsPlaceFromUrlBridge(unresolvedMeta?.final_url || url || "");
    const fromMsgCandidate = String(userText || "").replace(MAPS_URL_RE, "").trim().replace(/\s+/g, " ");
    const savedAddrCandidate = pickNonEmpty(
      draft.address_text,
      (draft.destination && draft.destination.address_text && !draft.destination.address_text.startsWith("(")) ? draft.destination.address_text : "",
      ""
    );
    const addressTextCandidate = fromMsgCandidate || draft.pending_address_text || savedAddrCandidate || "";
    const hasConflict = await hasSemanticRegionConflict(addressTextCandidate, decodedPlace);
    const hasMismatch = await hasTextOnlyDistrictMismatch(addressTextCandidate, decodedPlace);
    if (decodedPlace && addressTextCandidate && (hasConflict || hasMismatch)) {
      saveSbsrDraft(from, {
        ...draft,
        state: "awaiting_address_pin_confirm",
        pending_decoded_place: decodedPlace,
        pending_maps_url: unresolvedMeta?.original_url || url || "",
        address_pin_confirm: {
          mode: "semantic_place_conflict",
          address_text: addressTextCandidate,
          decoded_place: decodedPlace,
          gmaps_link: unresolvedMeta?.original_url || url || "",
        },
      });
      log("sbsr-address-pin-check", "decoded_place_text_only_compare");
      log("sbsr-address-pin-check", "semantic_mismatch_detected");
      log("sbsr-address-pin-check", "confidence=low");
      log("sbsr-address-pin-check", "decoded_place=" + decodedPlace);
      log("sbsr-address-pin-check", "quote_blocked_pending_confirmation");
      log("sbsr-maps-sniff", "handled_semantic_mismatch");
      try {
        await sendWhatsAppMessage(
          from,
          "Alamat tertulis dan titik Maps-nya terlihat berbeda ya Kak 🤍\n\n" +
          `Alamat tertulis:\n${addressTextCandidate}\n\n` +
          `Titik Maps yang Kakak kirim:\n${decodedPlace}\n\n` +
          "Yang benar dipakai yang mana?\n" +
          "1. Pakai alamat tertulis\n" +
          "2. Kirim ulang titik Maps\n" +
          "3. Sambungkan ke admin"
        );
      } catch (e) { log("sbsr-addr-quote", "semantic mismatch prompt err: " + e.message); }
      return true;
    }
    // For maps.app / gmaps links with decoded place that semantically matches typed address,
    // retry deterministic geocode before generic unreadable fallback.
    const hasSemanticMatch = !!(
      decodedPlace && addressTextCandidate &&
      !(await hasSemanticRegionConflict(addressTextCandidate, decodedPlace)) &&
      (
        (hasJakartaHint(decodedPlace) && hasJakartaHint(addressTextCandidate)) ||
        ((await extractSemanticRegion(decodedPlace)) && (await extractSemanticRegion(decodedPlace)) === (await extractSemanticRegion(addressTextCandidate)))
      )
    );
    if (hasSemanticMatch) {
      const geoDecoded = await geocodeAddressTextBridge(decodedPlace);
      const geo = geoDecoded;
      if (geo) {
        resolved = {
          lat: Number(geo.lat),
          lng: Number(geo.lng),
          address_text: addressTextCandidate || decodedPlace,
          source: /maps\.app\.goo\.gl/i.test(url || "") ? "maps_app" : "gmaps_link",
        };
        log("gmaps-geocode", `accepted lat=${resolved.lat} lng=${resolved.lng}`);
        log("gmaps-resolve", "resolved via decoded_place_geocode");
      }
    }
    if (resolved && Number.isFinite(Number(resolved.lat)) && Number.isFinite(Number(resolved.lng))) {
      // continue deterministic quote flow with recovered coords
    } else {
    log("sbsr-addr-quote", "from=" + from + " url failed to resolve");
    const fails = (Number(draft.location_resolve_fails) || 0) + 1;
    saveSbsrDraft(from, {
      ...draft,
      location_resolve_fails: fails,
      location_resolve_failed_at: new Date().toISOString(),
      last_failed_url: url,
    });
    log("sbsr-addr-quote", `from=${from} resolve-fail count=${fails}`);
    log("gmaps-recover", "unresolved_soft_fail");
    // BUG#3 fix: set awaiting_location_retry + user-facing recovery options (no admin handoff)
    const _rDraft = loadSbsrDraft(from) || draft;
    saveSbsrDraft(from, { ..._rDraft, state: "awaiting_location_retry" });
    try {
      await sendWhatsAppLocationRequest(from,
        "Kak, titik Maps tadi belum bisa kebaca sistem 🙏\n" +
        "Boleh coba tap tombol *Send Location* di bawah buat share lokasi langsung dari WhatsApp, atau kirim ulang link Google Maps ya"
      );
    } catch (e) { log("sbsr-addr-quote", "maps-retry-prompt err: " + e.message); }
    return true;
    }
  }
  // URL resolved successfully — reset failure counter
  if (draft.location_resolve_fails) {
    saveSbsrDraft(from, { ...draft, location_resolve_fails: 0, location_admin_notified_at: null });
    log("sbsr-addr-quote", "reset resolve-fail counter for " + from);
  }
  // Address text fallback chain (in order):
  //   1. fresh text in this message minus the URL
  //   2. earlier captured pending_address_text
  //   3. previously-saved destination.address_text — preserves typed address across
  //      the YA-confirm re-fire from tryHandlePinConfirm (which passes only the URL,
  //      so fromMsg=="" and pending_address_text was already cleared on first save).
  //      Without this fallback, the second invocation showed "(alamat dari pin)" on
  //      the invoice even though the customer had typed a real address.
  //   4. ultimate placeholder
  const fromMsg = userText.replace(MAPS_URL_RE, "").trim().replace(/\s+/g, " ");
  const savedAddrText = pickNonEmpty(
    draft.address_text,
    (draft.destination && draft.destination.address_text && !draft.destination.address_text.startsWith("(")) ? draft.destination.address_text : "",
    ""
  );
  const addressText = fromMsg || draft.pending_address_text || savedAddrText || resolved.address_text || "(alamat dari lokasi WA)";
  if (!fromMsg && draft.pending_address_text) {
    log("sbsr-addr-quote", "using pending_address_text from earlier message: " + draft.pending_address_text.slice(0, 60));
  } else if (!fromMsg && !draft.pending_address_text && savedAddrText) {
    log("sbsr-addr-quote", "using saved destination.address_text from prior call: " + savedAddrText.slice(0, 60));
  }

  // Build destination FROM SCRATCH for this pin — do NOT spread the old
  // draft.destination, which previously caused stale lat/lng/postal_code/address_text
  // from a prior incomplete order to leak into the new quote (and into LLM context,
  // where they were echoed back to the customer as if they had been received).
  // Fresh pin = fresh destination.
  const destBase = {
    ...(um ? {} : (draft.destination || {})),
    address_text: addressText,
  };
  if (url) destBase.gmaps_link = url;
  if (resolved.lat !== undefined && resolved.lng !== undefined) {
    destBase.lat = resolved.lat;
    destBase.lng = resolved.lng;
    destBase.source = um ? (/maps\.app\.goo\.gl/i.test(url) ? "maps_app" : "gmaps_link") : "gmaps_preview";
  } else if (resolved.postal_code) {
    destBase.postal_code = resolved.postal_code;
    destBase.source = "gmaps_link";
  }
  log("sbsr-addr-quote", "resolved destination for " + from + " via " + (resolved.lat ? "coords" : "postal=" + resolved.postal_code));
  if (url) {
    log("sbsr-maps-sniff", "resolved via google_maps_link");
  }
  const decodedPlace = String(resolved?.decoded_place || (url ? decodeMapsPlaceFromUrlBridge(url) : '') || '').trim();
  const displayLoc = await resolveLocationDisplayBridge({
    decodedPlace: decodedPlace || resolved.address_text || "",
    lat: destBase.lat,
    lng: destBase.lng,
    gmapsLink: url || destBase.gmaps_link || "",
  });
  destBase.place_address = displayLoc.place_address || "";
  destBase.place_label = displayLoc.place_label || "";
  let resolvedConfidence = String(resolved?.confidence || "high").toLowerCase();
  const DISTANCE_THRESHOLD_KM = 3.0;
  let addressPinValidationPassed = false;
  // typedGeo-crash-fix: hoisted so outer LLM/semantic checks can reference them safely
  let typedGeo = null;
  let distKm = null;
  let sameStreetMatch = false;
  let sameKecamatan = false;
  if (Number.isFinite(Number(destBase.lat)) && Number.isFinite(Number(destBase.lng))) {
    const typedDistrict = extractDistrictFromText(addressText);
    const pinRev = await reverseGeocodeCoordsBridge(Number(destBase.lat), Number(destBase.lng));
    const pinDistrict = extractDistrictFromText(
      `${pinRev?.district || ""} ${pinRev?.city || ""} ${pinRev?.county || ""} ${pinRev?.display || ""}`
    );
    const typedGeo = await geocodeTypedAddressWithFallback(addressText);
    let distKm = null;
    const addrL = String(addressText || "").toLowerCase();
    const pinL = String(
      decodedPlace ||
      resolved.address_text ||
      destBase.place_address ||
      destBase.place_label ||
      pinRev?.display ||
      ''
    ).toLowerCase();
    const sameStreetMatch = /nusa\s+indah\s+raya/.test(addrL) && /nusa\s+indah\s+raya/.test(pinL);
    const sameKelurahan = /cipinang\s*muara/.test(addrL) && /cipinang\s*muara/.test(pinL);
    const sameKecamatan = /jatinegara/.test(addrL) && /jatinegara/.test(pinL);
    const sameAreaStrong = sameStreetMatch && sameKelurahan && sameKecamatan;
    log("sbsr-address-pin-check", "same_street_match=" + String(sameStreetMatch));
    log("sbsr-address-pin-check", "same_kelurahan=" + String(sameKelurahan));
    log("sbsr-address-pin-check", "same_kecamatan=" + String(sameKecamatan));
    if (typedGeo) {
      log("sbsr-address-pin-check", "typed_lat=" + Number(typedGeo.lat).toFixed(6));
      log("sbsr-address-pin-check", "typed_lng=" + Number(typedGeo.lng).toFixed(6));
    }
    log("sbsr-address-pin-check", "pin_lat=" + Number(destBase.lat).toFixed(6));
    log("sbsr-address-pin-check", "pin_lng=" + Number(destBase.lng).toFixed(6));
    log("sbsr-address-pin-check", "threshold_km=1");
    if (typedGeo) {
      distKm = haversineKm(typedGeo.lat, typedGeo.lng, Number(destBase.lat), Number(destBase.lng));
      log("sbsr-address-pin-check", "distance_km=" + distKm.toFixed(1));
    }
    if (typedDistrict) log("sbsr-address-pin-check", "typed_district=" + typedDistrict);
    if (pinDistrict) log("sbsr-address-pin-check", "pin_district=" + pinDistrict);
    const typedRegion = (await extractSemanticRegion(addressText)) || "";
    const pinRegion = (await extractSemanticRegion(pinRev?.display || pinRev?.city || pinRev?.state || "")) || "";
    const districtMismatch = !!(typedDistrict && pinDistrict && typedDistrict !== pinDistrict);
    const regionMismatch = !!(typedRegion && pinRegion && typedRegion !== pinRegion);
    const distanceExceeded = Number.isFinite(distKm) && distKm > DISTANCE_THRESHOLD_KM;
    if (distanceExceeded) log("sbsr-address-pin-check", "distance_threshold_exceeded");
    if (sameAreaStrong) {
      resolvedConfidence = "high";
    } else if (regionMismatch || districtMismatch || distanceExceeded) {
      resolvedConfidence = "low";
    } else if ((typedDistrict && pinDistrict && typedDistrict === pinDistrict) || (Number.isFinite(distKm) && distKm <= DISTANCE_THRESHOLD_KM)) {
      resolvedConfidence = "high";
    } else if (!typedGeo && sameAreaStrong) {
      resolvedConfidence = "high";
    } else if (!typedGeo && typedRegion && pinRegion && typedRegion === pinRegion) {
      resolvedConfidence = "medium";
    } else if (!typedGeo && sameKecamatan && addressText && addressText.length > 20 && /\b(jl|jln|jalan|blok|gang|gg|rt|rw)\b/i.test(addressText)) {
      // AND same kecamatan matches Maps pin. Accept as high confidence.
      resolvedConfidence = "high";
    } else {
      resolvedConfidence = "low";
    }
    if (resolvedConfidence === "high") {
      addressPinValidationPassed = true;
      log("sbsr-address-pin-check", "validation_passed");
    }
    // Fallback: if typed address has street keywords + same kecamatan as Maps pin
    if (resolvedConfidence === "low" && addressText && destBase && (destBase.place_label || destBase.place_address)) {
      var _falAddr = String(addressText).toLowerCase();
      var _falPin = String(destBase.place_label || destBase.place_address || "").toLowerCase();
      var _falKec = /jatinegara/.test(_falAddr) && /jatinegara/.test(_falPin);
      var _falJln = /\b(jl|jln|jalan|blok|gang|gg|rt|rw)\b/i.test(_falAddr);
      if (_falKec && _falJln && _falAddr.length > 20) {
        resolvedConfidence = "high";
        addressPinValidationPassed = true;
        log("sbsr-address-pin-check", "accepted_via_kecamatan_fallback");
      }
    }
  }
  // semanticAddressMatch: broader LLM validator — triggers on any uncertain/failed deterministic match.
  // Conditions: !addressPinValidationPassed AND resolvedConfidence !== "high"
  // Fail-open: any error → null → existing resolvedConfidence unchanged (deterministic behavior).
  if (!addressPinValidationPassed && resolvedConfidence !== "high") {
    const _semMapsAddr = String(decodedPlace || destBase.place_label || destBase.place_address || "").trim();
    if (_semMapsAddr && addressText) {
      log("sbsr-address-semantic", "triggered");
      log("sbsr-address-semantic", "typed=" + String(addressText).slice(0, 80));
      log("sbsr-address-semantic", "resolved=" + _semMapsAddr.slice(0, 80));
      const _semResult = await semanticAddressMatch({
        typedAddress: addressText,
        resolvedMapsAddress: _semMapsAddr,
      }).catch(function(e) { log("sbsr-address-semantic", "error=" + e.message); return null; });
      if (_semResult) {
        log("sbsr-address-semantic", "llm_match=" + String(_semResult.match));
        log("sbsr-address-semantic", "confidence=" + _semResult.confidence);
        log("sbsr-address-semantic", "reason=" + _semResult.reason);
        if (_semResult.match === true && (_semResult.confidence === "high" || _semResult.confidence === "medium")) {
          if (_semResult.confidence === "high") {
            resolvedConfidence = "high";
            addressPinValidationPassed = true;
          } else {
            if (resolvedConfidence === "low") resolvedConfidence = "medium";
          }
          log("sbsr-address-semantic", "fallback_continue_checkout");
        } else {
          log("sbsr-address-semantic", "mismatch_confirm_required");
        }
      }
    }
  }
  if (resolvedConfidence === "low") {
    saveSbsrDraft(from, {
      ...draft,
      state: "awaiting_address_pin_confirm",
      pending_decoded_place: decodedPlace || destBase.place_label || "",
      pending_maps_url: url || "",
      address_pin_confirm: {
        mode: "semantic_place_conflict",
        address_text: addressText,
        decoded_place: decodedPlace || destBase.place_label || "",
        gmaps_link: url || "",
      },
    });
    log("sbsr-address-pin-check", "confidence=low");
    log("sbsr-address-pin-check", "quote_blocked_pending_confirmation");
    await sendWhatsAppMessage(
      from,
      "Alamat tertulis dan titik Maps-nya berbeda cukup jauh ya Kak 🤍\n\n" +
      `Alamat tertulis:\n${addressText}\n\n` +
      `Titik Maps:\n${decodedPlace || destBase.place_label || "-" }\n\n` +
      "Yang benar dipakai yang mana?\n1. Pakai alamat tertulis\n2. Kirim ulang titik Maps\n3. Sambungkan ke admin"
    );
    return true;
  }
  if (resolvedConfidence === "medium") {
    log("sbsr-address-pin-check", "confidence=medium");
    log("sbsr-address-pin-check", "soft_confirm_required");
  }
  if (resolvedConfidence === "high") {
    log("sbsr-address-pin-check", "confidence=high");
  }

  // Persist destination + address to draft so quote.mjs picks it up via fallback.
  // Clear pending_address_text now that it's been consumed into destination.address_text.
  // 2026-05-07: if this URL differs from any previously-confirmed pin on the draft,
  // RESET pin_confirmed_at so the soft-confirm gate re-fires. Without this, a returning
  // customer who shares a NEW pin gets quoted silently against the new destination
  // because their old pin_confirmed_at timestamp still satisfies the gate.
  const isNewPin = !!(url && (!draft.destination?.gmaps_link || draft.destination.gmaps_link !== url));
  saveSbsrDraft(from, {
    ...draft,
    destination: destBase,
    ...(url ? { gmaps_link: url } : {}),
    address_pin_validation_passed: addressPinValidationPassed ? true : draft.address_pin_validation_passed,
    pending_address_text: null,
    pending_address_text_at: null,
    pin_confirmed_at: url ? (isNewPin ? null : draft.pin_confirmed_at) : (draft.pin_confirmed_at || new Date().toISOString()),
  });

  // Validate typed address vs pin distance before quote.
  if (await maybeHandleAddressPinDistanceGate(from, draft, addressText, destBase, url)) {
    return true;
  }

  // Soft-confirm gate is only for URL-based pins. Native WhatsApp location already
  // gives us deterministic coordinates, so proceed directly once address text exists.
  const _draftPostSave = loadSbsrDraft(from);
  if (url && !_draftPostSave?.skip_pin_soft_confirm && !_draftPostSave?.address_pin_validation_passed && (!_draftPostSave?.pin_confirmed_at || resolvedConfidence === "medium")) {
    saveSbsrDraft(from, { ..._draftPostSave, state: "awaiting_pin_confirm" });
    await sendPinConfirmPrompt(from, _draftPostSave, addressText, url);
    if (resolvedConfidence === "medium") {
      log("sbsr-addr-quote", "waiting_confirmation_before_quote");
    }
    log("sbsr-addr-quote", "soft-confirm sent for " + from + ", waiting for YA before quote (newPin=" + isNewPin + ")");
    return true; // gate the quote until customer confirms
  }

  // 2026-05-07: REFUSE TO QUOTE if any Risol item has ambiguous form.
  // SOUL.md (line ~179) says LLM must ask "goreng atau frozen?" before persisting.
  // If a null-form Risol slipped past (LLM didn't ask), abort quote and inject
  // bridge context so the LLM asks now rather than silently defaulting to bike.
  // Without this guard, classifyCart treats null-form items as "neither frozen nor
  // goreng" → falls through to default-bike → cold-chain Paxel never auto-selected.
  const ambiguousRisol = (draft.items || []).filter(it => /Risol/i.test(it.name || '') && !it.form);
  if (ambiguousRisol.length > 0) {
    const names = ambiguousRisol.map(it => it.name).join(", ");
    log("sbsr-addr-quote", `ABORTING quote — ambiguous form on: ${names}`);
    try {
      await sendWhatsAppMessage(from,
        "Sebelum Mintu hitung ongkir, boleh dipastikan dulu Kak — risol-nya mau yang **goreng** (matang siap makan) atau **frozen** (mentah, bisa disimpen)? 🤍\n\n" +
        "Kalau ada yang campur (misal sebagian goreng + sebagian frozen), boleh diketik per item ya."
      );
    } catch (e) { log("sbsr-addr-quote", "ambiguous-form prompt err: " + e.message); }
    setPendingBridgeContext(from, [
      "Bridge sudah minta customer klarifikasi goreng vs frozen untuk: " + names,
      "JANGAN fire quote sampai semua item Risol punya form jelas (goreng/frozen).",
      "Setelah customer jawab, update draft.items[].form sesuai jawabannya.",
    ].join("\n"));
    return true;  // handled — wait for clarification
  }

  // Build the quote payload inline — items already in draft, frozen flag inferred
  const isFrozen = (draft.items || []).some(it => it.form === 'frozen');
  // 2026-05-07: scrub stale customer_preference if incompatible with current cart.
  // tryHandleFrozenCourierChoice writes customer_preference (e.g. 'paxel') for the
  // frozen flow; if that draft isn't reset before the next order and the new cart
  // is goreng-only, pickCourier's "preference always wins" rule forces Paxel for a
  // cart that should naturally go Gosend. Same family of state-leak as the
  // destination merge fix.
  let validPref = draft.customer_preference || null;
  if (validPref === 'paxel' && !isFrozen) {
    log("sbsr-addr-quote", `clearing stale customer_preference=paxel for non-frozen cart (was set by prior frozen order)`);
    saveSbsrDraft(from, { ...loadSbsrDraft(from), customer_preference: null });
    validPref = null;
  }
  const quotePayload = JSON.stringify({
    phone: from,
    items: draft.items,
    destination: { ...destBase },
    frozen: isFrozen,
    customerPreference: validPref,
  });

  log("sbsr-addr-quote", "fire quote for " + from + " items=" + draft.items.length + " frozen=" + isFrozen + " pref=" + (validPref || "none"));

  // 1) quote — retry once on transient parse / Biteship failures before falling through.
  // Without retry+context-on-fail, Order #1 in 2026-05-05 04:19 logs hung silently and
  // the LLM hallucinated "invoice-nya udah dikirim" because no quote was ever generated.
  const runQuoteOnce = () => new Promise((resolve) => {
    const cp = require("child_process");
    const child = cp.spawn("docker", [
      "exec", "-i", "sbsr-openclaw-1",
      "node", "/data/sentuhrasa-pdf/scripts/sentuh-quote.mjs",
    ], { timeout: 30000 });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", c => stdout += c);
    child.stderr.on("data", c => stderr += c);
    child.on("close", code => {
      try {
        const parsed = parseScriptJSON(stdout);
        resolve(parsed || { ok: false, error: "no parseable output", stdout, stderr });
      } catch (e) { resolve({ ok: false, error: e.message }); }
    });
    child.stdin.end(quotePayload);
  });

  let quoteRes = await runQuoteOnce();
  if (!quoteRes || !quoteRes.ok) {
    log("sbsr-addr-quote", "quote attempt 1 failed: " + (quoteRes?.error || "?") + ", retrying once");
    await new Promise(r => setTimeout(r, 800));
    quoteRes = await runQuoteOnce();
  }

  // === BIKS 2026-05-07: FROZEN CUSTOMER-CHOICE ===
  // If quoteShipping returned needs_customer_choice (frozen-only cart, no
  // preference set), present BOTH options and wait for "1" or "2" reply.
  // The cached options are persisted on the draft (quote_options[]) by
  // sentuh-quote.mjs; tryHandleFrozenCourierChoice picks them up.
  if (quoteRes && quoteRes.ok && quoteRes.needs_customer_choice && Array.isArray(quoteRes.options) && quoteRes.options.length >= 2) {
    const opts = quoteRes.options;
    const lines = [
      `Untuk pengiriman frozen, ada 2 pilihan ya Kak — silakan pilih 🤍`,
      ``,
    ];
    opts.forEach((o, i) => {
      const eta = o.eta_text ? ` · ETA ${o.eta_text}` : "";
      lines.push(`${i + 1}. ${o.courier_label} — Rp ${Number(o.ongkir).toLocaleString("id-ID")}${eta}`);
    });
    lines.push("");
    lines.push(`Balas *1* atau *2* ya Kak.`);
    saveSbsrDraft(from, {
      ...loadSbsrDraft(from),
      state: "awaiting_courier_choice",
      courier_choice_sent_at: new Date().toISOString(),
    });
    try {
      await sendWhatsAppMessage(from, lines.join("\n"));
      log("sbsr-addr-quote", "frozen-choice prompt sent to " + from + " options=" + opts.map(o => o.courier).join("+"));
    } catch (e) {
      log("sbsr-addr-quote", "frozen-choice send err: " + e.message);
    }
    setPendingBridgeContext(from, [
      "Bridge sudah kirim 2 pilihan ongkir frozen (Paxel + Gosend) ke customer.",
      "STATE: awaiting_courier_choice. Quote_options sudah disimpan di draft.",
      "TUNGGU customer balas '1' atau '2' (atau nama courier). Bridge akan auto-quote ulang dengan pilihan tersebut.",
      "JANGAN tanya alamat / pin lagi — sudah ada. JANGAN tampilkan invoice — belum.",
    ].join("\n"));
    return true; // gate further processing until customer picks
  }
  // === END BIKS frozen customer-choice ===

  if (!quoteRes || !quoteRes.ok) {
    log("sbsr-addr-quote", "quote failed twice for " + from + ": " + (quoteRes?.error || "?"));
    // Reply directly to customer; arm LLM with anti-fabrication context for the next turn.
    try {
      await sendWhatsAppMessage(from,
        "Maaf ya Kak, Mintu lagi gagal cek ongkir 🙏\n\n" +
        "Boleh kirim ulang share pin Google Maps-nya? Atau ketik alamat lengkap (kelurahan + kecamatan + kota) biar Mintu coba lagi 🤍"
      );
    } catch (_) {}
    setPendingBridgeContext(from, [
      "Bridge sudah coba 2x cek ongkir lewat sentuh-quote.mjs dan GAGAL (Biteship/parser error).",
      "Bridge sudah minta customer share ulang pin Google Maps.",
      "Draft sudah punya: nama (" + (draft.customer_name || "?") + "), alamat, " + draft.items.length + " item.",
      "",
      "ATURAN:",
      "- JANGAN claim ongkir / invoice / total sudah dikirim — belum ada yang dikirim.",
      "- JANGAN minta nama / alamat lagi — sudah disimpan.",
      "- Tunggu customer kirim pin baru. Begitu pin masuk, bridge akan coba lagi otomatis.",
      "- Kalau customer follow-up sebelum kirim pin baru ('udah?', 'mana?'), jelaskan singkat bahwa Mintu masih nunggu pin baru karena tadi gagal kebaca.",
    ].join("\n"));
    return true;  // handled at bridge level — do NOT fall through to LLM
  }

  // 2) invoice — re-load draft (quote may have updated it with destination/courier)
  const draftAfterQuote = loadSbsrDraft(from) || draft;
  const invoicePayload = JSON.stringify({
    phone: from,
    items: draftAfterQuote.items,
    ongkir: quoteRes.ongkir,
    customer_name: draftAfterQuote.customer_name,
    destination: { ...destBase },
    courier_label: quoteRes.courier_label,
    eta_text: quoteRes.eta_text,
  });

  const invoiceRes = await new Promise((resolve) => {
    const cp = require("child_process");
    const child = cp.spawn("docker", [
      "exec", "-i", "sbsr-openclaw-1",
      "node", "/data/sentuhrasa-pdf/scripts/sentuh-invoice.mjs",
    ], { timeout: 15000 });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", c => stdout += c);
    child.stderr.on("data", c => stderr += c);
    child.on("close", code => {
      // sentuh-invoice prints text between "---" markers when run as main; pull text from there
      const m = stdout.match(/^---\s*\n([\s\S]*?)\n---/m);
      if (m) resolve({ ok: true, text: m[1] });
      else resolve({ ok: false, error: "no invoice text in stdout", stdout, stderr });
    });
    child.stdin.end(invoicePayload);
  });

  if (!invoiceRes.ok) {
    log("sbsr-addr-quote", "invoice failed: " + (invoiceRes.error || "?") + ", falling through");
    return false;
  }

  // 3) prepend a short ack line + send to customer
  const ackText = `Baik Kak ${draftAfterQuote.customer_name || ""}, ongkirnya sudah masuk ya 🤍\n\n` + invoiceRes.text;
  try {
    await sendWhatsAppMessage(from, ackText);
    log("sbsr-addr-quote", "sent invoice to " + from + " courier=" + quoteRes.courier_label + " ongkir=" + quoteRes.ongkir);
  } catch (e) {
    log("sbsr-addr-quote", "send err: " + e.message);
    return false;
  }

  // Persist post-invoice state so OK→QRIS intercept fires + LLM doesn't re-ask.
  // sentuh-quote.mjs returns ongkir; subtotal is computed from items; grand_total may be
  // returned by the script — fall back to subtotal+ongkir if not.
  const subtotal = (draftAfterQuote.items || []).reduce(
    (s, it) => s + (Number(it.unit_price) || 0) * (Number(it.qty) || 0), 0
  );
  const ongkirN = Number(quoteRes.ongkir) || 0;
  const grandTotal = Number(quoteRes.grand_total) || (subtotal + ongkirN);
  saveSbsrDraft(from, {
    ...draftAfterQuote,
    state: "awaiting_invoice_confirm",
    awaiting_pin_confirm: false,
    skip_pin_soft_confirm: false,
    address_pin_validation_passed: false,
    subtotal,
    ongkir: ongkirN,
    grand_total: grandTotal,
    expected_total: grandTotal,
    courier: quoteRes.courier,
    courier_label: quoteRes.courier_label,
    courier_type: quoteRes.courier_type || null,
    eta_text: quoteRes.eta_text || null,
    frozen: isFrozen,
    invoice_sent_at: new Date().toISOString(),
  });
  void syncCustomerDbEvent(from, "invoice_created", loadSbsrDraft(from) || draftAfterQuote, {
    lastResponse: "invoice_created",
    lastOffer: draftAfterQuote.use_case ? `use_case:${draftAfterQuote.use_case}` : "invoice",
  });

  // Arm LLM with full state for the next turn so it doesn't re-ask for info already given.
  const itemsLine = (draftAfterQuote.items || [])
    .map(it => `${it.name} x${it.qty} (${fmtRupiah((Number(it.unit_price) || 0) * (Number(it.qty) || 0))})`)
    .join(", ");
  setPendingBridgeContext(from, [
    "Bridge baru saja menjalankan quote + invoice deterministik dan sudah mengirim invoice ke customer.",
    "STATE: awaiting_invoice_confirm — menunggu customer balas OK/YA agar bridge lanjut ke QRIS.",
    `Customer: ${draftAfterQuote.customer_name || "?"}`,
    `Items: ${itemsLine}`,
    `Subtotal: ${fmtRupiah(subtotal)}`,
    `Alamat: ${addressText}`,
    `Maps: ${url}`,
    `Kurir: ${quoteRes.courier_label || "?"}, ongkir ${fmtRupiah(ongkirN)}` + (quoteRes.eta_text ? `, ETA ${quoteRes.eta_text}` : ""),
    `Grand total: ${fmtRupiah(grandTotal)}`,
    "",
    "ATURAN:",
    "- JANGAN tanya ulang nama / alamat / pin maps / ongkir — semua sudah di atas.",
    "- Kalau customer tanya frozen/aman/ETA/varian, jawab langsung pakai info di atas + faq.md, BUKAN dengan minta info lagi.",
    "- Kalau customer balas OK / YA / sip / siap / lanjut / gas — bridge yang akan handle pembayaran. Cukup balas singkat 'siap Kak' ATAU jangan reply (bridge intercept akan kirim QRIS).",
    "- Kalau customer minta cancel/ubah pesanan, jelaskan Mintu hubungkan ke admin.",
    "- Kalau customer kirim TYPO atau text pendek tidak jelas (mis. 'pl', 'p', 'oc', 'okk', 'yo', 'lanjt', 'ya udah', 'gas dong') — JANGAN kirim katalog/menu lagi. Tafsirkan sebagai 'OK' yang typo dan minta konfirmasi singkat: \"Maksudnya OK ya Kak? Kalau iya, Mintu lanjut ke pembayaran 🤍\". JANGAN emit [MENU] / [CATALOG] saat customer di state ini.",
    "- Kalau customer kirim greeting (halo/hi/p/menu) di state ini, jangan reset — confirm dulu apakah mereka mau lanjut bayar atau cancel order.",
  ].join("\n"));
  return true;
}

async function tryHandleBareMapsUrl(from, userText) {
  if (!userText) return false;
  const m = userText.match(MAPS_URL_RE);
  if (!m) return false;
  const stripped = userText.replace(MAPS_URL_RE, "").trim();
  const words = stripped.split(/\s+/).filter(w => w.replace(/[^a-zA-Z0-9]/g, "").length > 0);
  if (words.length > 3) return false;            // mixed message — let LLM handle full address
  if (ADMIN_PHONES.includes(from)) return false; // admins don't get cart prompts
  const draft = loadSbsrDraft(from);
  if (draft && Array.isArray(draft.items) && draft.items.length > 0) return false; // cart already built
  const url = m[1];
  const coords = await resolveGmapsUrl_BridgeSafe(url).catch(() => null);
  if (!coords) {
    log("sbsr-maps-bare-intercept", "from=" + from + " url did not resolve");
    try {
      await sendWhatsAppMessage(from,
        "Kak, link Maps-nya belum kebaca sistem. Boleh kirim ulang pin dari Google Maps atau pakai fitur Share Location WhatsApp ya 🤍"
      );
    } catch (e) { log("sbsr-maps-bare-intercept", "share-location prompt err: " + e.message); return false; }
    setPendingBridgeContext(from, [
      "Bridge gagal resolve Google Maps link tanpa cart.",
      "JANGAN masuk LLM dan JANGAN minta Maps URL lagi.",
      "Instruksi: minta customer kirim Share Location native WhatsApp.",
    ].join("\n"));
    return true;
  }
  try {
    log("sbsr-location", "source=" + (/maps\.app\.goo\.gl/i.test(url) ? "maps_app" : "gmaps_link"));
    saveSbsrDraft(from, {
      ...(draft || { phone: from }),
      gmaps_link: url,
      gmaps_link_seen_at: new Date().toISOString(),
      destination: {
        ...((draft && draft.destination) || {}),
        gmaps_link: url,
        lat: coords.lat,
        lng: coords.lng,
        source: /maps\.app\.goo\.gl/i.test(url) ? "maps_app" : "gmaps_link",
      },
    });
  } catch (e) { log("sbsr-maps-bare-intercept", "draft save err: " + e.message); }
  const reply = "\ud83d\udccd Lokasi tersimpan ya Kak, Mintu sudah tangkap titik pin-nya \ud83e\udd0d\n\nSekarang boleh sebut menunya:\n\u2022 Varian: *RA* (Rougut), *RR* (Rendang), *RM* (Mushroom), atau *MIX*\n\u2022 Bentuk: *goreng* atau *frozen*\n\u2022 Jumlah: *6* atau *12* pcs\n\nMintu hitung ongkirnya setelah pesanan lengkap ya Kak.";
  try {
    await sendWhatsAppMessage(from, reply);
    log("sbsr-maps-bare-intercept", "from=" + from + " replied with cart prompt; lat=" + coords.lat.toFixed(4) + " lng=" + coords.lng.toFixed(4));
  } catch (e) {
    log("sbsr-maps-bare-intercept", "send err: " + e.message);
    return false;
  }
  setPendingBridgeContext(from, [
    "Bridge sudah simpan pin Maps customer dan minta sebut menu (varian + form + qty).",
    `Pin: ${url}`,
    "Customer belum sebut menu.",
    "JANGAN tanya alamat/pin lagi \u2014 sudah disimpan.",
    "Kalau customer balas teks pesan menu (mis. 'RA goreng 6'), parse \u2192 cart, dan deterministic flow akan lanjut ke quote setelah customer kirim nama+alamat penerima.",
  ].join("\n"));
  return true;
}
// Alias used inside tryHandleBareMapsUrl so a future rename of resolveGmapsUrlBridge
// only needs touching one line.
const resolveGmapsUrl_BridgeSafe = resolveGmapsUrlBridge;

// =====================================================
// Pin/Address soft-confirm (Phase 2 — 2026-05-06)
// =====================================================
// Customer sends maps pin + address. Before firing the quote, bridge ALWAYS
// echoes back the pin + typed address and asks customer to confirm. Catches:
//   - Wrong pin shared (pin in different kecamatan than typed address)
//   - Outdated/saved pin from a prior session
//   - Customer didn't realize WhatsApp shared current location instead of intended pin
// Soft check: just one extra "balas YA kalau sudah benar" round-trip. No hard block.
// Once confirmed (state cleared), tryHandleAddressAndQuote re-fires using the saved
// gmaps_link without prompting again.

const PIN_CONFIRM_YES_RE = /^\s*(?:ya|y|ok|oke|okay|okey|sip|siap|sudah|udah|dah|bener|benar|setuju|lanjut|gas|deal|cocok|sesuai|fix|fixed)\s*[.,!?]?\s*$/i;
const PIN_CONFIRM_NO_RE  = /\b(?:salah|kurang\s+tepat|tidak|nggak|gak\s+sesuai|gak\s+benar|bukan|nope|wrong|incorrect|gak\s+cocok|kurang\s+cocok|ulang)\b/i;

async function tryHandlePinConfirm(from, userText) {
  const draft = loadSbsrDraft(from);
  if (!draft || draft.state !== "awaiting_pin_confirm") return false;
  const t = String(userText || "").trim();
  if (!t) return false;
  if (PIN_CONFIRM_NO_RE.test(t)) {
    saveSbsrDraft(from, { ...draft, state: null, pin_confirmed_at: null });
    try {
      await sendWhatsAppMessage(from,
        "Baik Kak 🤍 Boleh share ulang pin Google Maps yang benar ya, atau ketik alamat lengkap (Jl, kelurahan, kecamatan, kota, kode pos) — Mintu coba cek lagi."
      );
    } catch (e) { log("sbsr-pin-confirm", "no-reply send err: " + e.message); }
    setPendingBridgeContext(from, [
      "Customer bilang pin/alamat masih salah. Bridge sudah minta share ulang pin atau ketik alamat lengkap.",
      "STATE: cart ada, pin pending re-share. JANGAN fire quote. Tunggu customer kirim pin baru.",
    ].join("\n"));
    log("sbsr-pin-confirm", `from=${from} customer rejected pin -> awaiting new`);
    return true;
  }
  if (PIN_CONFIRM_YES_RE.test(t)) {
    saveSbsrDraft(from, {
      ...draft,
      state: null,
      pin_confirmed_at: new Date().toISOString(),
      pin_confirmed: true,
      skip_pin_soft_confirm: true,
      address_pin_validation_passed: true,
    });
    log("sbsr-pin-confirm", "confirmed");
    const saved = loadSbsrDraft(from) || draft;
    const hasSavedCoords = Number.isFinite(Number(saved?.destination?.lat)) && Number.isFinite(Number(saved?.destination?.lng));
    log("sbsr-pin-confirm", hasSavedCoords ? "using_saved_destination" : "using_saved_link");
    log("sbsr-pin-confirm", "bypass_soft_confirm");
    const kickoffText = hasSavedCoords
      ? (saved?.destination?.address_text || saved?.address_text || "PIN_CONFIRMED")
      : ((saved?.destination && saved.destination.gmaps_link) || saved?.gmaps_link || "");
    if (!kickoffText) return false;
    log("sbsr-addr-quote", "quote_after_pin_confirm");
    try {
      const handled = await tryHandleAddressAndQuote(from, kickoffText);
      if (handled) return true;
      log("sbsr-pin-confirm", "addr-quote returned false after confirm; LLM follows");
      return false;
    } catch (e) { log("sbsr-pin-confirm", "post-confirm err: " + e.message); return false; }
  }
  return false; // ambiguous reply -> let LLM handle
}

// Send the pin/address echo + soft confirm prompt. Sets state=awaiting_pin_confirm.
// Detect when typed `addressText` and the resolved Maps URL look like they
// describe DIFFERENT places, so the confirm prompt can flag the conflict
// instead of the customer silently proceeding past it. Conservative —
// only flags when ALL of: (a) addressText is real (not "(dari pin)"), (b)
// URL pathname/query has alphabetic-only ≥4-char tokens (real place slug,
// not opaque shortlink hash), (c) NO address token appears in URL slug.
// On uncertainty (shortlink, missing words), returns false — silence is
// safer than false-positive accusations.
function looksLikeAddressPinMismatch(addressText, url) {
  if (!addressText || addressText.startsWith("(")) return false;
  if (!url || typeof url !== "string") return false;
  const STOP = ["jalan", "kelurahan", "kecamatan", "kabupaten", "kota", "desa", "indonesia"];
  const addrTokens = String(addressText)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length >= 4 && !STOP.includes(w));
  if (addrTokens.length === 0) return false;
  let urlPlace;
  try {
    const u = new URL(url);
    urlPlace = decodeURIComponent((u.pathname || "") + " " + (u.search || ""))
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ");
  } catch { return false; }
  const urlPlaceWords = urlPlace.split(/\s+/).filter(w => w.length >= 4 && /^[a-z]+$/.test(w));
  if (urlPlaceWords.length === 0) return false;
  const overlap = addrTokens.some(tok => urlPlaceWords.includes(tok));
  return !overlap;
}

function haversineKm() { return mapsGeocode ? mapsGeocode.haversineKm.apply(null, arguments) : null; }

function geocodeAddressTextBridge() { return mapsGeocode ? mapsGeocode.geocodeAddressTextBridge.apply(null, arguments) : null; }
function buildTypedAddressCandidates() { return mapsGeocode ? mapsGeocode.buildTypedAddressCandidates.apply(null, arguments) : null; }
function geocodeTypedAddressWithFallback() { return mapsGeocode ? mapsGeocode.geocodeTypedAddressWithFallback.apply(null, arguments) : null; }
function reverseGeocodeCoordsBridge() { return mapsGeocode ? mapsGeocode.reverseGeocodeCoordsBridge.apply(null, arguments) : null; }
function resolveLocationDisplayBridge() { return mapsGeocode ? mapsGeocode.resolveLocationDisplayBridge.apply(null, arguments) : null; }

async function sendPinConfirmPrompt(from, draft, addressText, url) {
  // 2026-05-07: Two-tier confirmation copy.
  // - When BOTH a real typed addressText AND a pin URL are present, we ALWAYS
  //   ask the customer to confirm they're the same place. Don't try to detect
  //   mismatch heuristically — opaque shortlinks are unresolvable, and even
  //   when they resolve, place-name comparisons yield false positives. Just
  //   ask. The mismatch heuristic remains as an additional ⚠️ when we can
  //   prove a clear conflict (typed address vs URL place words don't overlap).
  // - When only one of {address, pin} is present, fall back to the simpler
  //   single-source confirm.
  const hasRealAddress = addressText && !addressText.startsWith("(");
  const hasUrl = !!url;
  const clearMismatch = hasRealAddress && hasUrl && looksLikeAddressPinMismatch(addressText, url);

  const lines = [
    "Mintu sudah terima alamat + pin lokasinya 🤍",
    "",
    "📍 Alamat: " + (addressText || "(dari pin)"),
    "🗺️ Pin Maps: " + (url || "(belum ada)"),
    "",
  ];
  if (clearMismatch) {
    lines.push("⚠️ Mintu lihat tulisan alamat dan pin Maps kelihatannya beda lokasi — yang benar yang mana ya Kak?");
    lines.push("");
  } else if (hasRealAddress && hasUrl) {
    // Address + pin both present but no clear mismatch — still ask explicitly
    // so the customer compares them rather than just glancing at the pin.
    lines.push("Mintu mau pastikan: tulisan alamat *dan* pin Maps di atas sama-sama tujuan Kakak ya?");
    lines.push("");
  }
  lines.push("Kalau sudah pas, balas *YA* — Mintu lanjut cek ongkir.");
  lines.push("Kalau ada yang salah, share ulang pin yang benar atau ketik alamat detailnya.");
  try { await sendWhatsAppMessage(from, lines.join("\n")); }
  catch (e) { log("sbsr-pin-confirm", "prompt send err: " + e.message); }
  setPendingBridgeContext(from, [
    "Bridge sudah kirim soft-confirm: pin Maps + alamat detail, minta customer balas YA kalau benar.",
    "STATE: awaiting_pin_confirm. JANGAN fire quote sampai customer balas YA.",
    "JANGAN ulang minta alamat / pin — sudah disimpan.",
  ].join("\n"));
}

async function maybeHandleAddressPinDistanceGate(from, draft, addressText, destination, gmapsLinkForMsg) {
  const lat = Number(destination?.lat);
  const lng = Number(destination?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  const addr = String(addressText || "").trim();
  if (!addr || addr.startsWith("(")) return false;
  const geo = await geocodeAddressTextBridge(addr);
  if (!geo) return false; // per requirement: geocode fail -> do not block
  const distKm = haversineKm(geo.lat, geo.lng, lat, lng);
  log("sbsr-address-pin-check", "distance_km=" + distKm.toFixed(2));
  if (distKm <= 1.5) return false;
  log("sbsr-address-pin-check", "mismatch_detected");
  const d = loadSbsrDraft(from) || draft || {};
  const locView = await resolveLocationDisplayBridge({
    decodedPlace: destination?.place_label || destination?.place_address || "",
    lat,
    lng,
    gmapsLink: gmapsLinkForMsg || destination?.gmaps_link || d?.gmaps_link || "",
  });
  saveSbsrDraft(from, {
    ...d,
    state: "awaiting_address_pin_confirm",
    address_pin_confirm: {
      address_text: addr,
      address_coords: { lat: geo.lat, lng: geo.lng },
      pin_coords: { lat, lng },
      gmaps_link: gmapsLinkForMsg || destination?.gmaps_link || d?.gmaps_link || "",
      place_address: locView.place_address || "",
      place_label: locView.place_label || "",
      distance_km: Number(distKm.toFixed(2)),
    },
  });
  const pinView = locView.place_label || "Titik lokasi dari Share Location WhatsApp";
  await sendWhatsAppMessage(
    from,
    "Alamat tertulis dan titik Maps-nya agak berbeda ya Kak 🤍\n\n" +
    `Alamat: ${addr}\n` +
    `Titik Maps:\n${pinView}\n\n` +
    "Yang benar dipakai yang mana?\n" +
    "1. Pakai alamat tertulis\n" +
    "2. Pakai pin Maps\n" +
    "3. Saya kirim ulang"
  );
  return true;
}


// =====================================================
// Name capture (post-cart, pre-invoice)
// =====================================================
// After cart is built (cart_sniffed_at set) the LLM asks "atas nama siapa Kak?".
// Customer replies with a short name in a standalone message. The LLM acks it
// verbally but has no tool to persist it, so the draft.customer_name stays stale
// (especially across re-tests with the same number). When the customer next
// sends address+maps, tryHandleAddressAndQuote reads the stale name → wrong invoice.
// Fix: shadow-update draft.customer_name when we detect a name-shaped reply
// in the name-capture window. Returns false (LLM still continues conversation).
const NAME_CAPTURE_BLOCKLIST = new Set([
  "ya","y","ok","oke","okay","okey","sip","siap","setuju","lanjut","gas","deal","gpp",
  "bener","benar","udah","dah","halo","hallo","hi","hai","hey","hello","p","pms","permisi",
  "pagi","siang","sore","malam","menu","pricelist","katalog","catalog","order","pesen","pesan",
  "mau","boleh","bisa","tolong","mintu","kak","kakak","aja","deh","nih","dong","sih","lah",
  "iya","gak","ga","gk","nggak","engga","enggak","bukan","cancel","stop","tolak","batal","ndak",
  "test","testing","cek","ceki","frozen","goreng","mix","ayam","ragout","mayo","beef","sayur",
  "smoked","creamy","risol","risoles","6pcs","12pcs","6","12","3","1","2",
  "pouch","matcha","java","sambal","chili","lanjutkan","skip",
]);
// Hard-no words: product/intent terms that should NEVER be captured as a name,
// even via prefix path. ("Saya pesen risol mantap" → reject, not "pesen risol mantap")
const NAME_HARD_NO = new Set([
  "mau","boleh","bisa","tolong","halo","hallo","hi","hai","hey","hello",
  "menu","pricelist","katalog","catalog","order","pesen","pesan","langsung",
  "risol","risoles","goreng","frozen","mix","mentah",
  "ayam","ragout","mayo","beef","sayur","smoked","creamy",
  "cek","ceki","cancel","stop","tolak","batal","ulang","ganti","tunggu",
  "ngga","gak","ga","gk","nggak","engga","enggak","bukan","ndak","tidak","tdk",
  "ongkir","tarif","kirim","ekspedisi","kurir",
  "pouch","matcha","java","sambal","chili","lanjutkan","skip",
  // Indonesian function words & structural nouns - never part of a name.
  // Guards against captures like "dan alamat pengiriman" from synthetic
  // bridge text "tanya nama dan alamat pengiriman".
  "dan","atau","yang","ini","itu","ke","dari","untuk","dengan","atas","nama",
  "saya","aku","kami","kita","mereka","dia",
  "alamat","pengiriman","pengantaran","penerima","pengirim","lokasi","lengkap",
  "produk","pelanggan","pelangan","customer","kontak","kak","kakak",
  "tanya","cari","catat","proses","subtotal","katalog","whatsapp","share","pin",
  "gmaps","maps","google","sheets",
]);
// Synthetic bridge→LLM messages: [CATALOG ORDER] / [CART] / [MENU] / etc. These
// are constructed by the bridge to nudge the LLM and must not be treated as
// customer text by any of the new intercepts. (Older intercepts already guard
// in their own way; this helper covers the post-cart shadow-update path.)
function isSyntheticMsg(text) {
  return /^\s*\[(?:CATALOG|CART|MENU|ORDER|PROOF|INVOICE|SYSTEM)/i.test(String(text || ""));
}


function buildSbsrAddonOfferText(draft) {
  const useCase = String(draft && draft.use_case || "").trim().toLowerCase();
  if (useCase === "stock_frozen") {
    log("sbsr-addon-policy", "use_case=stock_frozen");
    log("sbsr-addon-policy", "allowed=ADD-CHILI,ADD-THERMAL-REGULER,ADD-THERMAL,ADD-ICE-GEL");
    return [
      "sebelum lanjut, mintu mau infokan beberapa add-on yang cocok buat stock frozen ya kak 😊",
      "",
      "🌶️ Signature Chili Sauce — 4rb/pouch (50ml)",
      "Cocok pas mau digoreng nanti",
      "",
      "🧊 *Thermal bag — biar tetap frozen selama pengiriman:*",
      "• Reguler (max 3 pack frozen) — Rp 8.000",
      "• Premium (max 6 pack frozen) — Rp 30.000",
      "",
      "❄️ Ice gel — Rp 3.000/pcs (boleh tambah berapapun)",
      "",
      "ada yang mau ditambahkan kak?",
    ].join("\n");
  }
  if (useCase === "makan-langsung") {
    log("sbsr-addon-policy", "use_case=makan-langsung");
    log("sbsr-addon-policy", "allowed=ADD-CHILI");
    return [
      "Mungkin Kakak mau tambah add-on juga? 🤍",
      "",
      "🌶️ Pouch homemade signature chili sauce 50 ml — Rp 4.000",
      "",
      "Kalau mau tambah, balas *pouch* atau *chili sauce* ya Kak. Kalau cukup, balas *LANJUT* 🤍",
    ].join("\n");
  }
  if (useCase === "meeting_acara" || useCase === "meeting-acara-kantor") {
    log("sbsr-addon-policy", "use_case=meeting_acara");
    log("sbsr-addon-policy", "allowed=chili,mika,minuman");
    return [
      "sebelum lanjut, mintu mau tawarkan add-on yang pas buat acara kakak ya 😊",
      "",
      "🌶️ Signature Chili Sauce — 4rb/pouch (50ml)",
      "Cocok pas digoreng, boleh tambah berapapun",
      "",
      "🎁 Mika bag (15k)",
      "Biar tampilannya lebih cantik pas disajikan (khusus pembelian min 2 box isi 6 atau 1 box isi 12)",
      "",
      "🥤 Tambah minuman?",
      "Cocok banget buat acara atau meeting, biar lebih lengkap",
      "",
      "yang mau ditambahkan apa nih kak?",
    ].join("\n");
  }
  if (useCase === "gift_hampers" || useCase === "gift-hampers") {
    log("sbsr-addon-policy", "use_case=gift_hampers");
    log("sbsr-addon-policy", "allowed=ADD-GREETING,ADD-MIKA-BAG,ADD-CHILI,ADD-THERMAL,ADD-ICE-GEL");
    return [
      "sebelum lanjut, mintu kasih beberapa add-on yang cocok buat gift/hampers ya kak 😊",
      "",
      "🎁 Buat presentation yang cantik:",
      "- Thermal bag premium (30k) + ice gel (3rb) + greeting card (3rb)",
      "- Mika bag (15k) — khusus pembelian min 2 box isi 6 atau 1 box isi 12",
      "",
      "🌶️ Signature Chili Sauce — 4rb/pouch (50ml)",
      "Cocok dijadiin pelengkap di hampers",
      "",
      "yang mau ditambahkan apa nih kak?",
    ].join("\n");
  }
  const hasFrozen = Array.isArray(draft.items) && draft.items.some(it => it && it.form === "frozen");
  const lines = [
    "Mungkin Kakak mau tambah add-on yang lainnya juga? 🤍",
    "",
    "🌶️ Pouch homemade signature chili sauce 50 ml — Rp 4.000",
    "🥤 Iced Java Tea — Rp 15.000",
    "🍵 Iced Matcha — Rp 15.000",
    "🎁 Mika bag — Rp 15.000",
    "💌 Greeting card (printed) — Rp 3.000",
  ];
  if (hasFrozen) {
    lines.push("🧊 Thermal bag reguler (max 3 pack) — Rp 8.000");
    lines.push("🧊 Thermal bag premium (max 6 pack) — Rp 30.000");
    lines.push("🧊 Ice gel — Rp 3.000 / pcs");
  }
  lines.push("");
  lines.push("Kalau mau tambah, balas aja nama add-on-nya ya Kak. Kalau cukup, balas *LANJUT* 🤍");
  return lines.join("\n");
}

function buildSbsrUseCasePromptText() {
  return [
    "berikut mintu kirimkan menu kita ya kak 😊",
    "",
    "untuk pesanan bisa mix varian baik frozen maupun goreng",
    "",
    "boleh diinfokan juga untuk kebutuhan pesannya:",
    "",
    "1. makan langsung",
    "2. stock frozen dirumah",
    "3. untuk meeting/acara kak",
    "4. untuk gift/hampers",
  ].join("\n");
}

function buildSbsrDeliveryMethodPromptText() {
  return [
    "Kak, pesanannya mau dikirim atau pickup/ambil sendiri? 🤍",
    "",
    "1. Delivery",
    "2. Pickup",
  ].join("\n");
}

async function sendSbsrDeliveryMethodButtons(from) {
  try {
    await sendWhatsAppInteractiveButtons(from,
      "Kak, pesanannya mau dikirim atau pickup/ambil sendiri? \u{1f90d}",
      [
        { type: "reply", reply: { id: "delivery", title: "Delivery" } },
        { type: "reply", reply: { id: "pickup", title: "Pickup" } }
      ]
    );
    log("sbsr-delivery-method", "buttons_sent");
  } catch (e) {
    log("sbsr-delivery-method", "button_err: " + (e && e.message));
    // Fallback to text
    await sendSbsrDeliveryMethodButtons(from);
  }
}

const SBSR_USECASE_INTENTS = [
  {
    id: "makan-langsung",
    match: /\b(?:makan\s+langsung|makan\s+di\s+tempat|siap\s+makan|siap\s+d(?:i|i)\s*makan|langsung\s+d(?:i|i)\s*makan|dimakan\s+langsung|buat\s+d(?:i|i)\s*makan\s+sekarang|buat\s+snack\s+langsung|langsung\s+makan|goreng\s+aja|goreng\s+ya|goreng\s+kak)\b/i,
    reply: `Kalau untuk makan langsung, Mintu rekomendasiin risoles goreng ya Kak 🤍

Pilihan favorit (bisa mix varian):
• Ayam Sayur — 3pcs (29rb) / 6pcs (55rb) / 12pcs (105rb)
• Smoked Beef Mayo — 3pcs (29rb) / 6pcs (55rb) / 12pcs (105rb)
• Ragout Creamy — 3pcs (29rb) / 6pcs (55rb) / 12pcs (105rb)
• Ayam Mercon Chili Oil 🔥 — 3pcs (33rb) / 6pcs (63rb) / 12pcs (120rb)
• Ayam Sayur Pedas — 3pcs (29rb) / 6pcs (55rb) / 12pcs (105rb)
• Mix Risol (bisa pilih varian) — 3pcs (29rb) / 6pcs (55rb) / 12pcs (105rb)

Biasanya enak ditambah *chili sauce pouch* juga biar makin mantap 🌶️
Kalau mau, Kakak bisa langsung pilih varian / pack dari katalog ya.`,
  },
  {
    id: "stock_frozen",
    match: /\b(?:stock\s+frozen|stok\s+frozen|frozen\s+di\s+rumah|buat\s+stok(?:\s+dirumah|\s+di\s+rumah)?|simpan\s+di\s+rumah|buat\s+freezer)\b/i,
    reply: `buat stock frozen di rumah, mintu rekomen 1 pack masing2 varian biar bisa coba semua rasa untuk keluarga ya kak 😊

Pilihan varian frozen (6pcs/pack):
• Ayam Sayur Frozen — 55rb
• Smoked Beef Mayo Frozen — 55rb
• Ragout Creamy Frozen — 55rb
• Ayam Mercon Chili Oil Frozen 🔥 — 63rb
• Ayam Sayur Pedas Frozen — 55rb
• Mix Risol Frozen — 6pcs (55rb) / 12pcs (96rb)

🍜 biar makin hemat, 1 paket frozen (6 varian @6pcs) cukup buat 1-2 minggu ke depan!

mau pilih varian apa aja nih kak?`,
  },
  {
    id: "meeting_acara",
    match: /\b(?:meeting|acara|kantor|rapat|gathering|event)\b/i,
    reply: `buat acara/meeting, mintu rekomen paket 2 box isi 12 + 4 minuman ya kak 😊

mau lanjut dengan paket ini?`,
  },
  {
    id: "gift_hampers",
    match: /\b(?:gift|hampers|hadiah|parcel|kado)\b/i,
    reply: `buat gift/hampers, mintu rekomen goreng atau frozen mix varian biar penerima bisa coba semua rasa ya kak 😊

mau pilih varian apa aja nih kak?`,
  },
];

function tryHandleUseCase_match(userText, from = null) {
  if (!userText || String(userText).trim().length < 1) return null;
  if (isSyntheticMsg(userText)) return null;
  const t = String(userText).trim();
  const draft = typeof loadSbsrDraft === "function" && from ? loadSbsrDraft(from) : null;
  const state = String(draft && draft.state || "").trim().toLowerCase();
  if (state === "awaiting_usecase") {
    if (/^(?:1|1\.|makan langsung)$/i.test(t)) return SBSR_USECASE_INTENTS[0];
    if (/^(?:2|2\.|stock frozen dirumah|stock frozen di rumah|stok frozen dirumah|stok frozen di rumah)$/i.test(t)) return SBSR_USECASE_INTENTS[1];
    if (/^(?:3|3\.|untuk meeting\/acara kak|meeting\/acara kak|meeting acara kantor|meeting|acara)$/i.test(t)) return SBSR_USECASE_INTENTS[2];
    if (/^(?:4|4\.|gift\/hampers|gift hampers|gift|hampers)$/i.test(t)) return SBSR_USECASE_INTENTS[3];
    // product_name_inference: customer types product name (goreng/frozen/6pcs/12pcs) instead of 1/2/3/4
    // frozen keyword -> use case 2 (stok frozen), goreng/size keyword -> use case 1 (makan langsung)
    const _pni_hasFrozen = /\bfrozen\b/i.test(t);
    const _pni_hasFormOrSize = /\b(?:frozen|goreng|6\s*pcs|12\s*pcs|6pcs|12pcs)\b/i.test(t);
    if (_pni_hasFormOrSize) {
      // Guard: if user mentions specific variant names, they're ORDERING not selecting use-case
      var _hasVariantName = /\b(?:ayam\s*sayur|smoked\s*beef|ragout\s*creamy|mercon|chili\s*oil|pedas|original|creamy\s*chicken|mix)\b/i.test(t);
      if (_hasVariantName) {
        log("sbsr-usecase", "product_name_inference=SKIPPED (variant_name_detected)");
        return null;
      }
      log("sbsr-usecase", "product_name_inference=" + (_pni_hasFrozen ? "stock_frozen" : "makan-langsung"));
      return _pni_hasFrozen ? SBSR_USECASE_INTENTS[1] : SBSR_USECASE_INTENTS[0];
    }
  }
  for (const intent of SBSR_USECASE_INTENTS) {
    if (intent.match.test(t)) return intent;
  }
  return null;
}

const SBSR_PRODUCT_SELECTION_INTENT_RE = /\b(?:frozen|goreng|mix|ayam|smoked|ragout|mayo|6\s*pcs|12\s*pcs|6pcs|12pcs)\b/i;

const SBSR_MEETING_CONFIRM_YES_RE = /^(?:ya|y|ok|oke|okay|okey|lanjut|boleh|mau|gas|deal|setuju|siap)(?:[\s,.]+(?:ya|ok|oke|lanjut|boleh|mau|gas|deal|setuju|siap|kak|aja|deh|nih))*\s*[.!,?]*\s*$/i;
const SBSR_MEETING_CONFIRM_NO_RE = /^(?:tidak|gak|ga|nggak|engga|batal|jangan|belum|nanti|ubah|ganti)(?:[\s,.]+(?:dulu|kak|aja|deh|nih))*\s*[.!,?]*\s*$/i;

function buildSbsrMeetingPackageItems() {
  return [
    { sku: "PKG-MEETING-2X12", name: "Paket Meeting — 2 box isi 12", qty: 1, unit_price: 192000, form: "goreng", pack_size: 12 },
    { sku: "PKG-MEETING-DRINK", name: "Paket Minuman Meeting", qty: 4, unit_price: 15000, form: null, pack_size: null },
  ];
}


async function tryHandleUseCaseRouter(from, userText) {
  try {
    const draftState = String((loadSbsrDraft(from) || {}).state || "").trim().toLowerCase();
    if (draftState !== "awaiting_usecase") return false;
    const hit = tryHandleUseCase_match(userText, from);
    if (!hit) {
      // Check if user is actually ORDERING (mentions specific product variant names)
      var _orderLike = /\b(?:ayam\s*sayur|smoked\s*beef|ragout\s*creamy|mercon|chili\s*oil|pedas|original|creamy\s*chicken)\b/i.test(String(userText));
      if (_orderLike) {
        var _od = loadSbsrDraft(from) || { phone: from };
        _od.state = "awaiting_product_selection";
        _od.awaiting_usecase = null;
        _od.use_case = null;
        saveSbsrDraft(from, _od);
        log("sbsr-usecase", "order_like_text transitioned to awaiting_product_selection");
        // Send to LLM for natural order handling
        var _ordCtx = [
          "STATE: awaiting_product_selection — customer menyebut produk spesifik.",
          "Customer: \"" + String(userText).slice(0, 200) + "\"",
          "Tugas: proses sebagai pesanan. Tanyakan detail yg kurang (qty frozen/goreng, varian tambahan).",
          "JANGAN suruh pilih use-case. Customer sudah jelas mau pesan.",
          "Sebutkan TOTAL harga pesanan dan konfirmasi ke customer. Contoh: 'Totalnya Rp110.000 ya Kak — Ayam Sayur 6pcs Rp55.000 + Frozen 6pcs Rp55.000'.",
        ].join("\n");
        // Let router continue to awaiting_product_selection handlers
        return false;
      }
      return false;
    }
    const draft = loadSbsrDraft(from) || { phone: from };
    const hasItems = Array.isArray(draft.items) && draft.items.length > 0;
    const resolvedUseCase = hit.id === "meeting-acara-kantor" ? "meeting_acara" : hit.id;
    const nextDraft = {
      ...draft,
      use_case: resolvedUseCase,
      use_case_source: "scenarios",
      use_case_set_at: new Date().toISOString(),
      state: "awaiting_product_selection",
    };
    saveSbsrDraft(from, nextDraft);
    log("sbsr-usecase", "detected=" + resolvedUseCase);
    if (resolvedUseCase === "meeting_acara") {
      log("sbsr-usecase", "state_setter use_case=meeting_acara");
      log("sbsr-order-flow", "awaiting_product_selection");
    } else if (resolvedUseCase === "gift_hampers") {
      log("sbsr-usecase", "state_setter use_case=gift_hampers");
      log("sbsr-order-flow", "awaiting_product_selection");
    }
    // Jika ada pending_items, pakai LLM natural reply daripada template
    const _pItems = Array.isArray(nextDraft.pending_items) ? nextDraft.pending_items : [];
    if (_pItems.length > 0) {
      const _useNatReply = await generateClassifierReply(from, userText, "choose_option", nextDraft);
      if (_useNatReply && _useNatReply.reply) {
        await sendWhatsAppMessage(from, _useNatReply.reply);
        // Save reply as pending_order_summary so ya_lanjut can create draft with price
        const _pd = loadSbsrDraft(from) || nextDraft;
        saveSbsrDraft(from, { ..._pd, pending_order_summary: _useNatReply.reply, pending_order_at: new Date().toISOString() });
        log('sbsr-interactive', 'pending_order_summary_saved');
        // Auto-send lanjut buttons if reply suggests continuing
        if (/mau\s+langsung\s+pesan|lanjut\s+ke\s+alamat|mau\s+lanjut\s+pesan|sudah\s+betul/i.test(_useNatReply.reply)) {
          try {
            await sendWhatsAppInteractiveButtons(from,
              "Pilih opsi di bawah ya Kak \u{1f90d}",
              [
                { type: "reply", reply: { id: "ya_lanjut", title: "Ya, lanjut pesan" } },
                { type: "reply", reply: { id: "tidak", title: "Tidak dulu" } }
              ]
            );
            log('sbsr-interactive', 'lanjut_buttons_sent_ooc');
          } catch (_ibErr) { log('sbsr-interactive', 'button_err: ' + (_ibErr && _ibErr.message)); }
        }
        log("sbsr-usecase", "natural_reply_with_pending_items count=" + _pItems.length);
      } else {
        await sendWhatsAppMessage(from, hit.reply);
      }
    } else {
      await sendWhatsAppMessage(from, hit.reply);
    }
    if (hasItems && String(draft.state || "").trim().toLowerCase() === "awaiting_usecase") {
      const postPickDraft = { ...(loadSbsrDraft(from) || nextDraft), use_case: resolvedUseCase };
      const hasFrozenItems = Array.isArray(postPickDraft.items) && postPickDraft.items.some((it) => it && it.form === "frozen");
      if (resolvedUseCase === "stock_frozen") {
        // Excel sequencing: stock frozen add-on must wait until frozen cart is valid.
        if (!hasFrozenItems) {
          await sendWhatsAppMessage(from, "Untuk stock frozen, pilih dulu item frozen/mix frozen dari katalog ya Kak 🤍");
        }
      } else if (!hasFrozenItems || resolvedUseCase !== "stock_frozen") {
        await sendSbsrAddonOffer(from, postPickDraft);
      } else {
        await sendWhatsAppMessage(from, "Untuk stock frozen, pilih dulu item frozen/mix frozen dari katalog ya Kak 🤍");
      }
    }
    log("sbsr-usecase", "deterministic_reply");
    log("sbsr-usecase", "skipped_openclaw");
    return true;
  } catch (e) {
    log("sbsr-usecase", "err: " + e.message);
    return false;
  }
}

async function sendSbsrAddonOffer(from, draft) {
  const copy = buildSbsrAddonOfferText(draft);
  const nextDraft = {
    ...draft,
    state: "awaiting_addon_reply",
    addon_phase: "addon_offer",
    addon_offer_at: new Date().toISOString(),
  };
  saveSbsrDraft(from, nextDraft);
  await sendWhatsAppMessage(from, copy);
  return nextDraft;
}

async function sendSbsrUseCasePrompt(from, draft) {
  const copy = buildSbsrUseCasePromptText();
  const nextDraft = {
    ...draft,
    state: "awaiting_usecase",
    use_case_prompt_at: new Date().toISOString(),
  };
  saveSbsrDraft(from, nextDraft);
  await sendWhatsAppMessage(from, copy);
  log("sbsr-order-flow", "sent usecase prompt");
  log("sbsr-order-flow", "waiting_usecase");
  return nextDraft;
}

function sbsrRouterStateLabel(draft) {
  return String((draft && draft.state) || "none").trim().toLowerCase() || "none";
}

function sbsrRouterLogState(state) {
  log("sbsr-router", "state=" + state);
}

function sbsrRouterLogRail(rail) {
  log("sbsr-router", "rail=" + rail);
}

function sbsrRouterLogSkipped(rail) {
  log("sbsr-router", "skipped=" + rail);
}


function isNameTokens(t, opts) {
  // t is already trimmed; check it's a plausible 1-4 word personal name
  const viaPrefix = !!(opts && opts.viaPrefix);
  if (t.length < 2 || t.length > 40) return false;
  if (!/^\p{L}[\p{L} .'-]*$/u.test(t)) return false;
  const words = t.split(/\s+/);
  if (words.length < 1 || words.length > 4) return false;
  // Hard-no: any product/intent word in the candidate disqualifies it as a name
  for (const w of words) {
    if (NAME_HARD_NO.has(w.toLowerCase())) return false;
  }
  // Blocklist: reject only if ALL words are stopwords (so "Tania Test" passes,
  // "ok bener" / "halo kak" don't). Single-word stopword like "ok" still rejected.
  let allBlocked = true;
  for (const w of words) {
    if (!NAME_CAPTURE_BLOCKLIST.has(w.toLowerCase())) { allBlocked = false; break; }
  }
  if (allBlocked) return false;
  // Standalone names (not via prefix) must have at least one capitalized word —
  // proper-noun signal that distinguishes "Tania" / "Tania Test" from colloquial
  // chat like "nanya mulu" / "tau ah" / "udah deh". Prefix path ("Saya tania")
  // skips this since context already implies a name.
  if (!viaPrefix && !/\b\p{Lu}/u.test(t)) return false;
  return true;
}
// Try to extract a customer name from free text. Handles:
//   - "Saya Tania" / "Aku Budi" / "Nama Siti" / "Nama saya Andi" / "Atas nama Joko"
//   - Multi-line: first line might be a prefixed/standalone name, rest is address
//   - Standalone short reply: "Tania" / "Pak Hadi" / "Ngurah Linggih"
// Returns the cleaned name or null.
// Scan recent inbound chat history for a name pattern. Used as a rescue when
// draft.customer_name is missing but the customer typed it earlier (e.g. before
// the name-capture intercept was deployed, or in a multi-line msg the bridge
// missed). Reads /docker/wa-webhook-sbsr/chats/<phone>.json (admin.js storage).
function findNameInChatHistory(fromRaw, lookback = 12) {
  try {
    const phone = String(fromRaw || "").replace(/[^0-9]/g, "");
    if (!phone) return null;
    const f = "/docker/wa-webhook-sbsr/chats/" + phone + ".json";
    if (!fs.existsSync(f)) return null;
    const chat = JSON.parse(fs.readFileSync(f, "utf8"));
    if (!Array.isArray(chat.messages)) return null;
    const inbound = chat.messages.filter(m => m && m.dir === "in" && typeof m.text === "string");
    const recent = inbound.slice(-lookback).reverse(); // newest first
    for (const m of recent) {
      // Skip ALL bridge-synthetic messages (CATALOG / CART / MENU / etc.) - they
      // contain phrases like "tanya nama dan alamat pengiriman" that would feed
      // false-positive captures via the "nama" prefix path.
      if (isSyntheticMsg(m.text)) continue;
      const found = extractCustomerName(m.text);
      if (found) return found;
    }
    return null;
  } catch (e) {
    log("sbsr-name-history-scan", "err: " + e.message);
    return null;
  }
}
function extractCustomerName(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  // Prefix patterns — case-insensitive, name capture is non-greedy up to newline/comma.
  // Allow leading filler ("halo kak, ", "iya ") before the prefix word.
  const prefixPatterns = [
    /(?:^|[\s,;:])(?:nama\s+saya|atas\s+nama|nama\s*[:\-]\s*saya|nama\s*[:\-])\s*([\p{L}][\p{L} .'-]{1,39})/iu,
    /(?:^|[\s,;:])(?:saya|aku)\s+([\p{L}][\p{L} .'-]{1,39})/iu,
  ];
  for (const re of prefixPatterns) {
    const m = raw.match(re);
    if (m) {
      const candidate = m[1].trim().split(/[,\n]/)[0].trim().replace(/\s+/g, " ");
      if (isNameTokens(candidate, { viaPrefix: true })) return candidate;
    }
  }

  // Multi-line: first line might be a standalone name (capitalization required)
  const firstLine = raw.split(/\n/)[0].trim();
  if (firstLine && firstLine !== raw && isNameTokens(firstLine)) return firstLine;

  // Whole text is a short standalone name (capitalization required)
  if (isNameTokens(raw)) return raw;

  return null;
}


// =====================================================
// Courier override (re-quote with customer's preferred courier)
// =====================================================
// SOUL.md says "pakai gojek/paxel/lalamove aja → honor request" but the LLM
// often escalates instead. Bridge intercept: when customer asks for a specific
// courier ("mau pakai gojek instant", "GO-SEND aja", "pake lalamove"), set
// draft.customer_preference + clear post-invoice state, then re-fire addr-quote
// with the saved gmaps_link → new invoice with new courier/ongkir.
const COURIER_OVERRIDE_NAME_RE = /\b(gojek|go.?jek|go.?send|gosend|grab(?:.?express)?|paxel|lalamove|lala.?move)(?:\s*(instant|same.?day|sameday))?\b/i;
const COURIER_OVERRIDE_TRIGGER_RE = /\b(pakai|pake|pakei|mau|minta|ganti|ubah|tukar|aja|coba|pilih|via|lewat|ke|gunakan|sama)\b/i;

function normalizeCourier(label) {
  const c = String(label || "").toLowerCase().replace(/[^a-z]/g, "");
  if (c === "gosend" || c === "gojek" || c === "gojeksend") return "gojek";
  if (c === "lalamove" || c === "lala") return "lalamove";
  if (c === "paxel") return "paxel";
  if (c === "grab" || c === "grabexpress") return "grab";
  return null;
}

// Negation guard: customer rejecting a courier ("ngga jadi pakai gojek deh") should
// NOT fire override. Match negation words appearing anywhere before a courier mention.
const COURIER_NEGATION_RE = /\b(ngga|nggak|engga|enggak|gak|ga|gk|tidak|tdk|jangan|bukan|cancel|batal|ndak|gajadi|gak\s*jadi|ngga\s*jadi)\b/i;

// =====================================================
// FAQ matcher (deterministic answers for common questions)
// =====================================================
// Reduces LLM/admin escalation rate. Built from real chat patterns in
// discovery/Extract_15_Chat_WhatsApp_Sentuh_Rasa.pdf + XLSX SOP.
// Only fires when no active order is in flight; respects admin pause.
const SBSR_FAQ_INTENTS = [
  {
    id: "halal",
    source: "additional_faq",
    match: /\bhalal\b|\bsertifikasi\s+halal\b/i,
    reply: `Untuk sertifikasi halal, Sentuh Rasa saat ini sedang dalam proses ya Kak 🤍`,
  },
  {
    id: "tahan-berapa-lama",
    source: "additional_faq",
    match: /\b(?:tahan|awet|expired?|kadaluarsa|kadaluwarsa|umur\s+simpan|shelf\s*life|simpan\s+berapa|tahan\s+berapa|berapa\s+hari|(?:bisa|aman)\s+dimakan\s+\d+\s*hari|freezer|chiller|kulkas)\b/i,
    reply: `Untuk frozen Sentuh Rasa Kak:
• Suhu ruang: 2–3 jam
• Chiller (kulkas bawah): 1–2 hari, lalu langsung digoreng
• Freezer: 1–2 bulan tergantung kondisi freezer

Kalau sudah digoreng, paling enak langsung disantap ya 🤍`,
  },
  {
    id: "cara-simpan-frozen",
    source: "additional_faq",
    match: /\b(?:cara\s+simpan|simpan(?:nya)?\s+gimana|penyimpanan|simpan\s+frozen|taruh\s+di\s+freezer|masuk\s+kulkas)\b/i,
    reply: `Untuk frozen Sentuh Rasa Kak:
• Suhu ruang: 2–3 jam
• Chiller (kulkas bawah): 1–2 hari, lalu langsung digoreng
• Freezer: 1–2 bulan tergantung kondisi freezer 🤍`,
  },
  {
    id: "air-fryer",
    source: "additional_faq",
    match: /\b(?:air\s*fryer|airfryer)\b/i,
    reply: `Bisa digoreng pakai air fryer juga ya Kak 🤍
Tinggal sesuaikan waktu dan suhu dengan alat masing-masing sampai warnanya golden brown.`,
  },
  {
    id: "cara-goreng",
    source: "additional_faq",
    match: /\b(?:cara\s+goreng|goreng(?:nya)?\s+gimana|masak(?:nya)?\s+gimana|menggoreng|langsung\s+goreng)\b/i,
    reply: `Cara goreng frozen Sentuh Rasa ya Kak:
1. Keluarkan dari freezer, tidak perlu di-thaw sampai lembek.
2. Panaskan minyak sampai benar-benar panas.
3. Goreng dengan api sedang sampai golden brown.
4. Tiriskan sebentar sebelum disajikan.

Kalau dari chiller, bisa langsung digoreng ya 🤍`,
  },
  {
    id: "pickup",
    source: "additional_faq",
    match: /\b(?:pickup|pick\s*up|ambil\s+sendiri|mampir|datang\s+langsung|ambil\s+di\s+toko)\b/i,
    reply: `Bisa pickup di:
Jl Nusa Indah Raya blok O no 10, Cipinang Muara, Kec Jatinegara
Google Maps: https://share.google/ykWkdLTDJgG2UVfOQ
CP: +62 811 1321 166

Kalau mau pickup, disarankan chat/PO dulu ya Kak biar pesanannya siap dan nggak kehabisan 🤍`,
  },
  {
    id: "reseller",
    source: "additional_faq",
    match: /\b(?:reseller|agen|jualan\s+lagi|titip\s+jual|harga\s+reseller)\b/i,
    reply: `Untuk reseller ya Kak:
• 4 pack: Rp 47.000 / pack
• 6 pack: Rp 46.000 / pack
• 10 pack: Rp 45.000 / pack

Kalau mau lanjut reseller, boleh info estimasi kebutuhannya ya 🤍`,
  },
  {
    id: "minimum-order",
    source: "additional_faq",
    match: /\b(?:minimum|minimal|min)\s*(?:order|pembelian|beli|pesan)|order\s+minimal/i,
    reply: `Minimum order Sentuh Rasa Rp 50.000 ya Kak 🤍`,
  },
  {
    id: "pengiriman",
    source: "additional_faq",
    match: /\b(?:pengiriman|dikirim|kirimnya|delivery|diantar|antar)\b/i,
    reply: `Pengiriman Sentuh Rasa berangkat dari Cipinang ya Kak 🤍
Boleh kirim alamat lengkap + share titik lokasi Maps atau Share Location WhatsApp, nanti Mintu bantu cek ongkir dan estimasinya.`,
  },
  {
    id: "pembayaran",
    source: "additional_faq",
    match: /\b(?:pembayaran|bayar|transfer|qris|rekening|metode\s+bayar)\b/i,
    reply: `Untuk pembayaran bisa via transfer atau QRIS ya Kak 🤍
Nanti setelah cart dan pengiriman/pickup-nya fix, Mintu kirim detail pembayarannya.`,
  },
  {
    id: "komplain",
    source: "additional_faq",
    match: /\b(?:komplain|complain|keluhan|belum\s+sampai|ga\s+sampai|nggak\s+sampai|rasa\s+biasa|kurang\s+sesuai|basi|produk\s+rusak)\b/i,
    reply: `Mohon maaf ya Kak atas kendalanya 🤍
Boleh kirim detail keluhannya beserta foto/video pendukung kalau ada, nanti Mintu bantu teruskan ke admin untuk ditindaklanjuti.`,
  },
  {
    id: "refund",
    source: "additional_faq",
    match: /\brefund\b|\bretur\b|\bkembali(?:kan|in)\s+dana\b/i,
    reply: `Untuk refund / retur, nanti Mintu bantu teruskan ke admin ya Kak 🤍
Boleh kirim kronologi singkatnya dulu supaya bisa dicek lebih lanjut.`,
  },
  {
    id: "lokasi-toko",
    source: "additional_faq",
    match: /\b(?:lokasi|alamat)\s*toko|toko\s*(?:di\s*mana|dimana)|berlokasi|cipinang|jakarta\s+timur/i,
    reply: `Sentuh Rasa lokasinya di:
Jl Nusa Indah Raya blok O no 10, Cipinang Muara, Kec Jatinegara
Google Maps: https://share.google/ykWkdLTDJgG2UVfOQ
CP: +62 811 1321 166 🤍`,
  },
  {
    id: "gift-hampers",
    source: "additional_faq",
    match: /\b(?:gift|hampers|hadiah|parcel|kado|greeting\s*card)\b/i,
    reply: `Untuk gift / hampers, biasanya cocok pakai:
• Thermal bag premium
• Greeting card
• Mika bag (kalau perlu)
• Chili sauce sebagai add-on

Kalau mau, Mintu bantu rekomendasikan paket yang cocok ya Kak 🤍`,
  },
  {
    id: "meeting-acara",
    source: "additional_faq",
    match: /\b(?:meeting|acara|event|gathering|kantor|rapat)\b/i,
    reply: `Untuk meeting / acara, biasanya cocok pakai:
• Risoles siap makan
• Chili sauce
• Mika bag
• Tambah minuman kalau perlu

Kalau mau, kirim estimasi pax dan waktunya ya Kak, nanti Mintu bantu arahkan 🤍`,
  },
];

function tryHandleFaq_match(userText) {
  if (!userText || userText.length < 2) return null;
  if (isSyntheticMsg(userText)) return null;
  const t = String(userText).trim();
  for (const intent of SBSR_FAQ_INTENTS) {
    if (intent.match.test(t)) return { id: intent.id, reply: intent.reply, source: intent.source || "additional_faq" };
  }
  return null;
}

const SBSR_QUESTION_FAQ_INTENTS = [
  {
    id: "q15_pengiriman_dari_mana",
    match: /\b(?:pengiriman\s+dari\s+mana|kirim\s+dari\s+mana|dari\s+mana)\b/i,
    reply: "Dari Cipinang Indah, Jaktim (info detail alamat).\n\nBisa ambil langsung pesanannya, tapi lebih disarankan pesan terlebih dahulu agar tidak kehabisan saat sampai.",
  },
  {
    id: "q15_luar_kota",
    match: /\b(?:pengiriman\s+luar\s+kota|kirim\s+luar\s+kota|luar\s+kota)\b/i,
    reply: "Bisa selama bisa terjangkau paxel.\n\nBisa dibantu cek dahulu dengan infokan alamat dan titik lokasi di Google.",
  },
  {
    id: "q15_frozen_tahan",
    match: /\b(?:frozen\s+tahan\s+berapa\s+lama|yang\s+frozen\s+berapa\s+lama\s+tahan|tahan\s+berapa\s+lama)\b/i,
    reply: "- 2-3 jam di suhu ruang\n\n- 1-2 hari di chiller (langsung goreng)\n\n- 1-2 bulan di freezer (tergantung kondisi freezer: 1 pintu, 2 pintu, atau box freezer)",
  },
  {
    id: "q15_custom",
    match: /\b(?:bisa\s+custom|custom\s+atau\s+tidak|order\s+custom)\b/i,
    reply: "Bisa kak, bisa diinfokan kebutuhannya seperti apa.\n\nDiskusikan dengan atasan untuk harga sesuai kebutuhan.",
  },
  {
    id: "q15_reseller",
    match: /\b(?:harga\s+reseller|reseller)\b/i,
    reply: "Bisa kak:\n\n- Starter package: 4 pack — 47k/pack\n\n- Medium package: 6 pack — 46k/pack\n\n- Business package: 10 pack — 45k/pack",
  },
  {
    id: "q15_cafe_whitelabel",
    match: /\b(?:harga\s+cafe|harga\s+coffee\s*shop|white\s*label|whitelabel|private\s*label)\b/i,
    reply: "Untuk harga cafe / white label, Mintu bantu sambungkan ke admin ya Kak 🤍",
  },
];



async function tryHandleFaq(from, userText) {
  try {
    if (admin && typeof admin.isPaused === "function" && admin.isPaused(from)) return false;
    const _d = loadSbsrDraft(from) || {};
    const _s = String(_d.state || "").trim().toLowerCase();
    if (["awaiting_name", "awaiting_location", "awaiting_address", "awaiting_invoice_confirm"].includes(_s)) {
      log("sbsr-router", "faq_disabled_for_checkout_state");
      return false;
    }
    const hit = tryHandleFaq_match(userText);
    if (!hit) return false;
    log("sbsr-faq", `hit=${hit.id}`);
    log("sbsr-faq", `faq_source=${hit.source}`);
    await sendWhatsAppMessage(from, hit.reply);
    log("sbsr-faq", "deterministic_reply");
    log("sbsr-faq", "skipped_openclaw");
    return true;
  } catch (e) {
    log("sbsr-faq", "err: " + e.message);
    return false;
  }
}

// =====================================================
// Frozen courier choice (SB-Group 2026-05-07: bot shows both prices, customer picks)
// =====================================================
// Triggered after sendFrozenChoicePrompt set state="awaiting_courier_choice".
// Customer replies "1" or "2" (or "paxel"/"gosend"); we commit the cached
// option from the draft and re-fire tryHandleAddressAndQuote (which now sees
// customer_preference set, so the quote returns the single chosen courier).
async function tryHandleFrozenCourierChoice(from, userText) {
  if (!userText) return false;
  if (isSyntheticMsg(userText)) return false;
  const draft = loadSbsrDraft(from);
  if (!draft) return false;
  if (draft.state !== "awaiting_courier_choice") return false;
  if (!Array.isArray(draft.quote_options) || draft.quote_options.length < 2) return false;

  // Parse the reply via the clause-aware courier-choice parser.
  // 2026-05-07 QA: previously a naive `if (paxel) else if (gojek)` mis-handled
  // "bukan paxel, gojek aja" → 'paxel'. parseCourierChoice handles negation
  // and clause boundaries correctly (see lib/courier-choice-parser.cjs +
  // test-courier-choice-parser.cjs). Fall back to legacy parsing only if
  // secLib failed to load.
  let chosenIndex = null;
  let chosenCourier = null;
  if (secLib && secLib.parseCourierChoice) {
    const _r = secLib.parseCourierChoice(userText);
    if (_r.kind === 'index')   chosenIndex   = _r.value;
    if (_r.kind === 'courier') chosenCourier = _r.value;
  } else {
    const t = userText.trim().toLowerCase();
    const nm = t.match(/^(?:pilih(?:an)?\s*)?([12])\b/);
    if (nm) chosenIndex = Number(nm[1]);
    if (!chosenIndex) {
      if (/\b(paxel)\b/.test(t)) chosenCourier = "paxel";
      else if (/\b(gosend|gojek|gojeg)\b/.test(t)) chosenCourier = "gojek";
    }
  }
  if (!chosenIndex && !chosenCourier) {
    // Customer said something else — gently re-prompt rather than fall through to LLM
    log("sbsr-courier-choice", `from=${from} ambiguous reply "${userText.slice(0, 60)}", re-prompting`);
    const lines = [
      `Belum pasti ya Kak — pilih salah satu:`,
      ``,
    ];
    draft.quote_options.forEach((o, i) => {
      const eta = o.eta_text ? ` · ETA ${o.eta_text}` : "";
      lines.push(`${i + 1}. ${o.courier_label} — Rp ${Number(o.ongkir).toLocaleString("id-ID")}${eta}`);
    });
    lines.push("");
    lines.push("Balas *1* atau *2* ya 🤍");
    try { await sendWhatsAppMessage(from, lines.join("\n")); } catch (_) {}
    return true; // we handled it (re-prompted), skip LLM
  }

  // Resolve chosen option from cached quote_options[]
  let chosen;
  if (chosenIndex) chosen = draft.quote_options[chosenIndex - 1];
  else chosen = draft.quote_options.find(o => o.courier === chosenCourier);
  if (!chosen) {
    log("sbsr-courier-choice", `from=${from} couldnt resolve choice (idx=${chosenIndex} courier=${chosenCourier})`);
    return false;
  }

  log("sbsr-courier-choice", `from=${from} chose ${chosen.courier} (Rp ${chosen.ongkir})`);
  // Persist preference + clear awaiting state so the addr-quote re-fire produces
  // a single-quote response (the cached options give us the values without a
  // second Biteship call, but re-firing addr-quote keeps invoice generation in
  // its existing path).
  saveSbsrDraft(from, {
    ...draft,
    customer_preference:    chosen.courier,
    courier:                chosen.courier,
    courier_label:          chosen.courier_label,
    courier_type:           chosen.courier_type,
    ongkir:                 chosen.ongkir,
    eta_text:               chosen.eta_text,
    courier_chosen_at:      new Date().toISOString(),
    courier_choice_source:  "customer",
    state:                  null,
    invoice_sent_at:        null,
    grand_total:            null,
    expected_total:         null,
    pending_bridge_context: null,
    quote_options:          undefined,  // clear so it doesn't re-trigger
  });
  // Re-fire address-quote with the saved gmaps_link so invoice gets sent.
  const url = draft.gmaps_link || (draft.destination && draft.destination.gmaps_link);
  if (url) {
    try {
      const handled = await tryHandleAddressAndQuote(from, url);
      if (handled) return true;
    } catch (e) { log("sbsr-courier-choice", "re-quote err: " + e.message); }
  }
  return true; // even on re-quote miss, we successfully handled the choice
}


// =====================================================
// URL echo / destination check (deterministic answers to "what URL?" / "where is it being sent?")
// =====================================================
// Without these handlers, "cek link url-nya" / "coba cek dikirim ke mana"
// fall through to the LLM which has been observed hallucinating addresses
// (e.g. echoing the example "Jl Kenanga 23" from tools-spec.md as if the
// customer had sent it). Both handlers read draft.destination + draft.gmaps_link
// and reply verbatim — never invent fields.
//
// KEEP IN SYNC with scripts/tests/test-url-echo-handler.mjs and
// scripts/tests/test-destination-check-handler.mjs.

// "share/cek link maps", "url-nya apa", "kirim link", "boleh share pin" — but
// NOT "cek ongkir lewat link" (which has its own handler — ONGKIR_CHECK guard
// already excludes url/link/pin questions when no price word is present).
const URL_ECHO_TRIGGER_RE = /\b(cek|kirim|share|copy|kasih|liat|lihat)\b[\s\S]{0,30}\b(link|url|maps?|pin)\b/i;
const URL_ECHO_QUESTION_RE = /\b(link|url|maps?|pin)[\s-]?nya\b[\s\S]{0,20}\b(apa|mana|gmn|gimana)\b/i;


// "coba cek dikirim ke mana", "alamatnya apa", "tujuan-nya kemana"
const DEST_CHECK_TRIGGER_RE = /\b(dikirim|tujuan|alamat(?:nya)?)\b[\s\S]{0,30}\b(mana|apa|kemana|ke mana|cek|gimana|gmn)\b/i;
const DEST_CHECK_QUESTION_RE = /\b(cek|liat|lihat)\b[\s\S]{0,20}\b(dikirim|tujuan|alamat)\b/i;


// =====================================================
// Ongkir comparison (multi-courier rates on demand)
// =====================================================
// Customer asks "ongkir berapa?" / "cek ongkir" → quote 3 couriers in parallel
// (Gojek / Paxel / Lalamove), send a single comparison message. Customer then
// picks one and the existing tryHandleCourierOverride intercept re-fires the
// invoice with their pick.
const ONGKIR_CHECK_RE = /\b(?:ongkir(?:nya)?|tarif|biaya|kirim(?:an|nya)?)\b/i;
const ONGKIR_QUESTION_HINT_RE = /\b(berapa|brp|cek|gimana|gmn|brapa)\b|\?\s*$/i;

function runQuoteFor(from, draft, courierPref) {
  return new Promise((resolve) => {
    if (!draft.destination) return resolve(null);
    // Defensive: derive frozen from cart items rather than hardcoding false.
    // The 3-courier comparison normally short-circuits on frozen at the
    // tryHandleOngkirCheck level, but if that gate is bypassed (e.g. cart
    // classifier missed form='frozen' for fuzzy phrasing) the script itself
    // still needs the right flag to pick cold-chain couriers.
    const frozen = (draft.items || []).some(it => it.form === 'frozen');
    const payload = JSON.stringify({
      phone: from,
      items: draft.items,
      destination: { ...draft.destination },
      frozen,
      customerPreference: courierPref,
    });
    const cp = require("child_process");
    const child = cp.spawn("docker", [
      "exec", "-i", "sbsr-openclaw-1",
      "node", "/data/sentuhrasa-pdf/scripts/sentuh-quote.mjs",
    ], { timeout: 30000 });
    let stdout = "";
    child.stdout.on("data", c => stdout += c);
    child.on("close", () => {
      try {
        const parsed = parseScriptJSON(stdout);
        resolve(parsed && parsed.ok ? parsed : null);
      } catch { resolve(null); }
    });
    child.stdin.end(payload);
  });
}


// =====================================================
// Address-text capture (post-cart, pre-invoice)
// =====================================================
// Customers often type the street address in a separate message from the maps
// URL. Without this intercept the address text is lost (LLM acks but doesn't
// persist), and the invoice ends up showing "(alamat dari pin)" as the address.
// Shadow-update draft.pending_address_text when we detect an address-shaped
// msg (contains street keywords or numbers + meaningful length, not a name,
// not a URL). Used as fallback in tryHandleAddressAndQuote.addressText computation.
const ADDR_KEYWORD_RE = /\b(jl|jln|jalan|blok|rt|rw|kel|kelurahan|kec|kecamatan|kota|kabupaten|kab|desa|dukuh|gang|gg|gedung|komplek|kompleks|perumahan|cluster|villa|apt|apartemen|tower|lt|lantai|ruko|gedung|graha)\b/i;
function looksLikeAddress(text) {
  const t = String(text || "").trim();
  if (t.length < 10 || t.length > 300) return false;
  // Questions are not addresses
  if (t.includes("?")) return false;
  if (/^(?:apa|siapa|kenapa|bagaimana|berapa|kapan|dimana|bisa|apakah|mau\s+tanya|tanya\s+dulu|info|ada\s+apa|permisi|maaf)\b/i.test(t)) return false;
  if (/\b(?:tanya|menu\s+apa|isi\w*\s+apa|rekomendasi|recommend|halal|tahan\s+berapa|minimal|min\s+order)\b/i.test(t)) return false;
  if (MAPS_URL_RE.test(t)) return false;
  if (/^\+?\d{6,}$/.test(t.replace(/\s+/g, ""))) return false; // phone-like
  // Skip synthetic bridge→LLM messages ([CATALOG ORDER], [CART], [MENU], etc.)
  if (/^\s*\[(?:CATALOG|CART|MENU|ORDER|PROOF|INVOICE)/i.test(t)) return false;
  // Skip messages that look like cart/menu restatements ("Risol Goreng X", "Smoked Beef Y")
  if (/\bRisol\s+(?:Goreng|Frozen|Ragout|Ayam|Smoked|Mix|Mayo)/i.test(t)) return false;
  // Skip addon intent messages ("tambah 2 chili sauce", "tambah thermal bag", etc.)
  if (/^(?:tambah|tambahin|add|plus|extra)\b.*?(?:chili|sauce|thermal|pouch|ice.?gel|sambal)/i.test(t)) return false;
  // Strong signal: has explicit address keyword (jl/blok/rt/kel/etc.)
  if (ADDR_KEYWORD_RE.test(t)) return true;
  // Weaker signal: has digit AND is long enough to be more than a qty/SKU restatement
  if (/\d/.test(t) && t.length >= 20) return true;
  return false;
}

// ============================================================
// Wrong-input detection for location-requiring checkout states
// ============================================================
// When customer is in awaiting_address, awaiting_pin_confirm,
// awaiting_location_retry, or awaiting_location and sends
// anything other than a valid location input, this interceptor
// uses OpenClaw to detect the wrong input and generate a
// natural, patient guidance reply. The reply is sent as a
// WhatsApp Location Request Message — an interactive message
// with a "Send Location" button that opens WhatsApp's native
// location-sharing UI.
// ============================================================


// Inject the saved gmaps_link into the LLM's invoice text if it's missing.
// Belt-and-suspenders for when the LLM forgot to pass `phone` to sentuh-invoice.mjs.
// =====================================================
// Admin escalation: fire real handoff when LLM says "hubungkan ke admin"
// =====================================================
// Per faq.md, the bot defers halal cert / allergy / refund / wholesale / etc.
// to admin. The LLM correctly says "Mintu bantu hubungkan ke admin" — but
// historically nothing actually reached admin. This post-LLM hook detects the
// escalation language and forwards a structured handoff template to
// SBSR_FINANCE_PHONES with the customer's question + state for context.
//
// Idempotent per inbound message (one escalation per turn, even if the LLM
// repeats the phrase).
const ADMIN_ESCALATE_PATTERNS = [
  /\bhubung(?:kan|in)\s+(?:ke\s+|ke|sama\s+)?(?:kakak\s+)?admin\b/i,
  /\bsambung(?:kan|in)\s+(?:ke\s+|ke|sama\s+)?(?:kakak\s+)?admin\b/i,
  /\bterus(?:kan|in)\s+(?:ke\s+|ke|sama\s+)?(?:kakak\s+)?admin\b/i,
  /\b(?:tanya|tanyakan|cek)\s+(?:ke\s+|ke|sama\s+)?(?:kakak\s+)?admin\s+ya\b/i,
  /\badmin\s+yang\s+handle\s+ya\b/i,
  /\bdijelaskan\s+langsung\s+(?:dengan|sama)\s+admin\b/i,
];

async function maybeFireAdminEscalation(from, contactName, userText, aiReply) {
  if (!aiReply || !userText) return false;
  const hit = ADMIN_ESCALATE_PATTERNS.some(re => re.test(aiReply));
  if (!hit) return false;
  // Don't fire for admin themselves (they'd notify themselves)
  if (ADMIN_PHONES.includes(from)) return false;
  // Don't fire when customer's turn is a Maps URL during an active cart —
  // that's a delivery-routing failure (pin couldn't resolve), not a real handoff.
  if (MAPS_URL_RE.test(userText)) {
    const dCart = loadSbsrDraft(from);
    if (dCart && Array.isArray(dCart.items) && dCart.items.length > 0) {
      log("sbsr-escalate", "skipped for " + from + " — userText is Maps URL during active cart (routing failure)");
      return false;
    }
  }
  // Don't fire if customer already asked "hubungkan ke admin" — that's tryHandleAdminHandoff's job
  // (covered earlier in the chain). This hook only catches the LLM-decided escalations.

  const fins = getSbsrFinancePhones();
  if (fins.length === 0) { log("sbsr-escalate", "no SBSR_FINANCE_PHONES set"); return false; }

  // Idempotency: skip if we already escalated this exact turn for this phone
  const draft = loadSbsrDraft(from) || { phone: from };
  const turnId = userText.slice(0, 60);
  if (draft.last_escalation_turn === turnId) {
    log("sbsr-escalate", "already escalated this turn for " + from);
    return false;
  }
  saveSbsrDraft(from, { ...draft, last_escalation_turn: turnId, last_escalation_at: new Date().toISOString() });

  const orderInfo = draft.grand_total
    ? `Order: ${fmtRupiah(draft.grand_total)} (state: ${draft.state || "?"})`
    : "Belum ada cart aktif.";
  // #8 — short escalation ID for disambiguation when multiple admins handle concurrent escalations
  const escId = "ESC-" + Math.random().toString(36).slice(2, 8).toUpperCase();
  const last4 = String(from).slice(-4);
  const tsLocal = new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", hour12: false }) + " WIB";
  const summary = [
    `🔔 *${escId}* · ${tsLocal}`,
    "*Customer minta bantuan / pertanyaan untuk admin*",
    "",
    `Customer: ${contactName || draft.customer_name || "?"} (+${from})`,
    orderInfo,
    "",
    `Pertanyaan: "${userText.slice(0, 200)}"`,
    "",
    `Bot sudah balas: "${aiReply.slice(0, 160).replace(/\n/g, " ")}${aiReply.length > 160 ? "…" : ""}"`,
    "",
    `👉 Admin login & ambil alih chat:`,
    `https://webhook-sbgroup.biks.ai/admin`,
    `(buka chat customer *...${last4}* → tap *Pause Bot* → reply langsung 🤍)`,
  ].join("\n");

  const sent = await notifySbsrAdminsText(summary, "sbsr-escalate");
  log("sbsr-escalate", `fired for ${from} (notified ${sent}/${fins.length} admin), trigger: "${userText.slice(0, 40)}"`);
  return sent > 0;
}

function enrichInvoiceWithMaps(from, aiReply) {
  if (!aiReply) return aiReply;
  if (!/📍\s*\*?Pengiriman ke:?\*?/.test(aiReply)) return aiReply;
  if (/🗺️|Maps:\s*https?:\/\//i.test(aiReply)) return aiReply;
  const draft = loadSbsrDraft(from);
  if (!draft || !draft.gmaps_link) return aiReply;

  const inject = `\n🗺️ Maps: ${draft.gmaps_link}`;
  // Try common shapes — insert right before the blank line that precedes "🚚 Kurir:"
  let patched = aiReply.replace(/(📍\s*\*?Pengiriman ke:?\*?[\s\S]*?)\n\n(🚚 Kurir:)/,
    (_m, head, tail) => `${head}${inject}\n\n${tail}`);
  if (patched !== aiReply) return patched;
  // Fallback: insert right before "━━━" if no "🚚 Kurir" line in text
  patched = aiReply.replace(/(📍\s*\*?Pengiriman ke:?\*?[\s\S]*?)\n(━━+)/,
    (_m, head, tail) => `${head}${inject}\n${tail}`);
  if (patched !== aiReply) return patched;
  // Last resort: append after the address block heuristic — find the line right after the postal/address
  return aiReply.replace(/(📍\s*\*?Pengiriman ke:?\*?\n[^\n]+\n[^\n]+)/,
    (_m, head) => `${head}${inject}`);
}

const COURIER_LABEL_TO_CODE = { paxel: 'paxel', gojek: 'gojek', gosend: 'gojek', gocar: 'gojek', lalamove: 'lalamove' };
const COURIER_TYPE_DEFAULT = { gojek: 'instant', paxel: 'medium', lalamove: 'instant' };

function parseRupiah(s) {
  if (s == null) return 0;
  return parseInt(String(s).replace(/[^0-9]/g, ''), 10) || 0;
}

// Sniff a cart-ack LLM reply (bot acknowledging the customer's catalog/free-text cart)
// and persist items[] to the draft so tryHandleAddressAndQuote / admin-cmd can act on it.
//
// Targets reply lines like:
//   "Risol Goreng Ragout Creamy 6pcs x1"   "Risol Frozen Ayam Sayur 6pcs x2"
//   "total sementara Rp51.000"             "Subtotal Rp 102.000"
//
// Conservative: only fires if reply includes both an item line AND a total/subtotal
// AND draft has no items yet (so an existing populated draft isn't overwritten by an LLM ack).
// Add-on SKU lookup. Mirror of /data/.openclaw/workspace/products.json `addons` array.
// Used by sniffCartAckFromAiReply to resolve LLM-acked add-on lines into draft items
// with correct SKU + price (so downstream invoice / Olsera tools agree).
const ADDON_LOOKUP = [
  { match: /\b(?:iced?\s+)?java\s*tea\b|\bice\s*tea\b/i, sku: 'ADD-ICE-TEA', name: 'Iced Java Tea — 250ml',  unit_price: 15000 },
  { match: /\b(?:iced?\s+)?matcha\b/i,                   sku: 'ADD-MATCHA',  name: 'Iced Matcha — 250ml',   unit_price: 15000 },
  { match: /\b(?:homemade\s+|signature\s+)?chili\s*sauce\b|\b(?:homemade\s+|signature\s+)?chilli\s*s|\bpouch\bauce\b|\bsaus(?:\s+sambal|\s+chili)?\b|\b(?:chili|chilli)\s+pouch\b|\bsignature\s+chili\b|\bsignature\s+chilli\b/i,
                                                          sku: 'ADD-CHILI',   name: 'Homemade Signature Chili Sauce — 50ml pouch', unit_price: 4000 },
  { match: /\bthermal\s*bag\b/i,                         sku: 'ADD-THERMAL', name: 'Thermal Bag Premium',  unit_price: 30000 },
  { match: /\bice\s*gel\b|\bcold\s*pack\b/i,             sku: 'ADD-ICE-GEL', name: 'Ice Gel / Cold Pack',   unit_price: 3000 },
];

function sniffCartAckFromAiReply(from, aiReply) {
  if (!aiReply) return;
  // Must mention 'pesanan' OR 'noted' OR 'catat' to look like a cart-ack (not the invoice)
  if (!/pesanan|noted|catat|total sementara/i.test(aiReply)) return;
  // Don't run on the full invoice (has Grand Total) — that's sniffInvoiceFromAiReply's job
  if (/Grand Total\s*:/i.test(aiReply)) return;
  const draft = loadSbsrDraft(from) || { phone: from };

  // 2026-05-07: Two-phase sniff — Risol items + add-ons. Old code matched only
  // "Risol... Npcs" AND bailed entirely if items.length>0. Result: when customer
  // said "tambah deh java tea" mid-flow, the LLM's ack ("Mintu catat ya: Risol
  // ... + Iced Java Tea x1") was thrown away — Risol already in draft, sniffer
  // bailed, Java Tea silently dropped. Now: capture both kinds, MERGE with
  // existing items by SKU/name (idempotent, no duplicates).

  // Phase 1: Risol (deterministic price tier from pack size)
  const risolRe = /(Risol[^\n,]+?\d+\s*pcs)\s*[x×]\s*(\d+)/gi;
  const sniffed = [];
  let m;
  while ((m = risolRe.exec(aiReply)) !== null) {
    const name = m[1].trim().replace(/\s+/g, ' ');
    const qty  = parseInt(m[2], 10) || 1;
    const pack = /12\s*pcs/i.test(name) ? 12 : 6;
    // 2026-05-07: never silently default form. Old code: "/Frozen/i.test(name) ? 'frozen' : 'goreng'"
    // — anything not explicitly Frozen got tagged goreng, including ambiguous LLM acks like
    // "Risol Ayam 6pcs x1". That cascades: pickCourier wouldn't auto-route to Paxel cold-chain
    // even when the customer wanted frozen. Per SOUL.md gate (line ~179, 2026-05-07 update),
    // the LLM MUST ask "goreng atau frozen?" before acking — but as defense-in-depth, if an
    // ambiguous ack ever reaches us, leave form=null and log a warning so admin can audit.
    let form;
    if (/Frozen/i.test(name)) form = 'frozen';
    else if (/Goreng/i.test(name)) form = 'goreng';
    else { form = null; log("sbsr-cart-sniff", "WARN: ambiguous form for \"" + name + "\" — left form=null (LLM should have asked)"); }
    const unit_price = pack === 12 ? 96000 : 51000;
    sniffed.push({ name, qty, pack_size: pack, form, unit_price });
  }

  // Phase 2: Add-ons. Match generic bullet/dash lines containing a known add-on
  // keyword + a "× N" / "x N" qty marker. Lookup table resolves SKU + price.
  const addonRe = /(?:^|\n|[•\-\*])\s*([^\n•\-\*]{3,80}?)\s*[x×]\s*(\d+)/gim;
  while ((m = addonRe.exec(aiReply)) !== null) {
    const candidate = m[1].trim().replace(/\s+/g, ' ').replace(/^[•\-\*\s]+/, '');
    const qty  = parseInt(m[2], 10) || 1;
    if (candidate.length < 3 || candidate.length > 80) continue;
    if (/Risol/i.test(candidate)) continue; // already captured above
    const hit = ADDON_LOOKUP.find(a => a.match.test(candidate));
    if (!hit) continue;
    sniffed.push({ name: hit.name, qty, sku: hit.sku, unit_price: hit.unit_price });
  }

  if (sniffed.length === 0) return;

  // MERGE with existing items rather than overwrite. Dedupe by SKU (preferred) or
  // by normalized name (lowercase, whitespace collapsed). For duplicates, keep the
  // existing item — deterministic state beats LLM prose qty (which drifts).
  // Normalize bridges "Risol Goreng Ragout Creamy 6pcs" vs "...6 pcs" (LLM-prose
  // tends to insert a space; catalog-tap shape doesn't).
  const normName = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');
  const existing = Array.isArray(draft.items) ? draft.items.slice() : [];
  let added = 0;
  for (const ni of sniffed) {
    const dupIdx = existing.findIndex(ei => {
      if (ni.sku && ei.sku && ei.sku === ni.sku) return true;
      if (ei.name && ni.name && normName(ei.name) === normName(ni.name)) return true;
      // Risol fallback: if both are Risol with same form + pack_size, treat as dup
      if (ei.pack_size && ni.pack_size && ei.form && ni.form &&
          ei.pack_size === ni.pack_size && ei.form === ni.form &&
          /Risol/i.test(ei.name || '') && /Risol/i.test(ni.name || '') &&
          // also require the Risol variant token to match (Ragout/Smoked/etc.)
          (normName(ei.name).slice(0, 25) === normName(ni.name).slice(0, 25))) return true;
      return false;
    });
    if (dupIdx >= 0) continue;
    existing.push(ni);
    added++;
  }
  if (added === 0) return; // nothing new to persist

  // Recompute subtotal from the merged list (don't trust the AI's "subtotal sementara"
  // line — it's frequently stale or rounded).
  const subtotal = existing.reduce((s, it) => s + ((Number(it.unit_price) || 0) * (Number(it.qty) || 1)), 0);

  saveSbsrDraft(from, {
    ...draft,
    items: existing,
    subtotal,
    cart_sniffed_at: new Date().toISOString(),
  });
  log("sbsr-cart-sniff", `merged ${added} new item(s) (total ${existing.length}) for ${from} subtotal=${subtotal}`);
}

async function maybeAutoQuote(from, aiReply) {
  if (!aiReply) return false;
  if (/Grand Total\s*:/i.test(aiReply)) return false;
  const promiseRe = /Mintu\s+(?:lanjut|akan\s+lanjut|siapkan|bantu\s+siapkan)\s+(?:siapkan\s+)?invoice|siapkan\s+invoice|cek\s+ongkir(?:nya)?\s+dulu|hitung\s+ongkir(?:nya)?/i;
  if (!promiseRe.test(aiReply)) return false;

  const draft = loadSbsrDraft(from);
  if (!draft) return false;
  if (!Array.isArray(draft.items) || draft.items.length === 0) return false;
  if (!draft.customer_name) return false;
  if (!draft.gmaps_link) return false;
  if (draft.destination && draft.destination.lat) return false;

  const coords = await resolveGmapsUrlBridge(draft.gmaps_link).catch(() => null);
  if (!coords) { log("sbsr-auto-quote", "from=" + from + " gmaps did not resolve"); return false; }

  const isFrozen = (draft.items || []).some(it => it.form === 'frozen');
  const addressText = pickNonEmpty(draft.address_text, (draft.destination && (draft.destination.address_text || draft.address)), draft.address, '(alamat dari lokasi WA)');

  const quotePayload = JSON.stringify({
    phone: from, items: draft.items,
    destination: { address_text: addressText, gmaps_link: draft.gmaps_link, lat: coords.lat, lng: coords.lng },
    frozen: isFrozen,
  });

  log("sbsr-auto-quote", "fire for " + from + " items=" + draft.items.length + " name=" + draft.customer_name);

  const quoteRes = await new Promise((resolve) => {
    const cp = require("child_process");
    const child = cp.spawn("docker", ["exec", "-i", "sbsr-openclaw-1", "node", "/data/sentuhrasa-pdf/scripts/sentuh-quote.mjs"], { timeout: 30000 });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", c => stdout += c);
    child.stderr.on("data", c => stderr += c);
    child.on("close", () => {
      try {
        const parsed = parseScriptJSON(stdout);
        resolve(parsed || { ok: false, error: "no parseable output", stderr });
      } catch (e) { resolve({ ok: false, error: e.message }); }
    });
    child.stdin.end(quotePayload);
  });

  if (!quoteRes || !quoteRes.ok) { log("sbsr-auto-quote", "quote failed: " + (quoteRes && quoteRes.error)); return false; }

  const draftAfter = loadSbsrDraft(from) || draft;
  const invoicePayload = JSON.stringify({
    phone: from, items: draftAfter.items, ongkir: quoteRes.ongkir, customer_name: draftAfter.customer_name,
    destination: { address_text: addressText, gmaps_link: draft.gmaps_link, lat: coords.lat, lng: coords.lng },
    courier_label: quoteRes.courier_label, eta_text: quoteRes.eta_text,
  });

  const invoiceRes = await new Promise((resolve) => {
    const cp = require("child_process");
    const child = cp.spawn("docker", ["exec", "-i", "sbsr-openclaw-1", "node", "/data/sentuhrasa-pdf/scripts/sentuh-invoice.mjs"], { timeout: 15000 });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", c => stdout += c);
    child.stderr.on("data", c => stderr += c);
    child.on("close", () => {
      const m = stdout.match(/^---\s*\n([\s\S]*?)\n---/m);
      if (m) resolve({ ok: true, text: m[1] });
      else resolve({ ok: false, error: "no invoice text", stderr });
    });
    child.stdin.end(invoicePayload);
  });

  if (!invoiceRes.ok) { log("sbsr-auto-quote", "invoice failed: " + invoiceRes.error); return false; }

  const ackText = `Siap Kak ${draftAfter.customer_name}, ini invoice-nya ya 😊\n\n` + invoiceRes.text;
  try { await sendWhatsAppMessage(from, ackText); log("sbsr-auto-quote", "sent invoice to " + from); }
  catch (e) { log("sbsr-auto-quote", "send err: " + e.message); return false; }
  return true;
}

function sniffInvoiceFromAiReply(from, aiReply) {
  if (!aiReply) return;
  if (!/Grand Total\s*:\s*Rp/i.test(aiReply)) return;
  if (!/balas\s*\*?OK\*?\s*atau\s*\*?YA\*?/i.test(aiReply)) return;

  const grandM = aiReply.match(/Grand Total\s*:\s*Rp\s*([\d.,]+)/i);
  if (!grandM) return;
  const grand = parseRupiah(grandM[1]);
  if (!grand || grand <= 0) return;

  // --- name + address from address-echo block ---
  let name = null, address = null;
  const addrBlock = aiReply.match(/📍\s*\*?Pengiriman ke:?\*?\s*\n([\s\S]*?)(?:\n\n🚚|\n━━+)/);
  if (addrBlock) {
    const lines = addrBlock[1].split('\n').map(l => l.trim()).filter(Boolean)
      .filter(l => !l.startsWith('🗺️') && !l.startsWith('📝'));
    if (lines.length >= 1) name    = lines[0];
    if (lines.length >= 2) address = lines.slice(1).join(', ');
  }

  // --- courier from "🚚 Kurir: *Paxel* · ETA 8 - 12 jam" ---
  let courier = null, courier_label = null, eta_text = null;
  const courM = aiReply.match(/🚚\s*Kurir:\s*\*?([A-Za-z]+)\*?\s*(?:·|·)?\s*(?:ETA\s*([^\n*]+))?/i);
  if (courM) {
    courier_label = courM[1].trim();
    courier = COURIER_LABEL_TO_CODE[courier_label.toLowerCase()] || courier_label.toLowerCase();
    if (courM[2]) eta_text = courM[2].trim();
  }

  // --- ongkir + subtotal ---
  const ongM = aiReply.match(/Ongkir\s*:\s*Rp\s*([\d.,]+)/i);
  const subM = aiReply.match(/Subtotal\s*:\s*Rp\s*([\d.,]+)/i);
  const ongkir   = ongM ? parseRupiah(ongM[1]) : 0;
  const subtotal = subM ? parseRupiah(subM[1]) : (grand - ongkir);

  // --- items from lines between "*Sentuh Rasa*" and the "*Produk :" / "*Barang :" line ---
  const items = [];
  const itemBlock = aiReply.match(/\*Sentuh Rasa\*\s*\n([\s\S]*?)\n\*(?:Produk|Barang)\s*:/i);
  if (itemBlock) {
    const blockLines = itemBlock[1].split('\n').map(l => l.trim()).filter(Boolean);
    // Pairs of: "<name>" then "Rp <unit> x <qty> = Rp <total>"
    for (let i = 0; i < blockLines.length; i++) {
      const priceLine = blockLines[i + 1];
      if (!priceLine) break;
      const pm = priceLine.match(/Rp\s*([\d.,]+)\s*[xX×]\s*(\d+)\s*=/);
      if (pm) {
        items.push({
          name:       blockLines[i],
          unit_price: parseRupiah(pm[1]),
          qty:        parseInt(pm[2], 10) || 1,
          pack_size:  /6\s*pcs/i.test(blockLines[i]) ? 6 : (/12\s*pcs/i.test(blockLines[i]) ? 12 : 6),
          form:       /Frozen/i.test(blockLines[i]) ? 'frozen' : 'goreng',
        });
        i++;  // skip the price line
      }
    }
  }

  const existing = (() => { try { return JSON.parse(fs.readFileSync(sbsrDraftPath(from), "utf8")); } catch { return {}; } })();
  const destination = {
    ...(existing.destination || {}),
    address_text: address || existing.destination?.address_text || existing.address || '',
    gmaps_link:   existing.gmaps_link || existing.destination?.gmaps_link || null,
  };

  saveSbsrDraft(from, {
    ...existing,
    state: "awaiting_invoice_confirm",
    grand_total: grand,
    subtotal,
    ongkir,
    customer_name: name || existing.customer_name || "",
    items: items.length ? items : (existing.items || []),
    destination,
    courier:        courier        || existing.courier        || null,
    courier_label:  courier_label  || existing.courier_label  || null,
    courier_type:   existing.courier_type || (courier ? COURIER_TYPE_DEFAULT[courier] : null),
    eta_text:       eta_text       || existing.eta_text       || null,
    frozen:         items.some(it => it.form === 'frozen') || existing.frozen || false,
    invoice_sniffed_at: new Date().toISOString(),
  });
  void syncCustomerDbEvent(from, "invoice_created", loadSbsrDraft(from) || existing, {
    lastResponse: "invoice_created",
    lastOffer: existing?.use_case ? `use_case:${existing.use_case}` : "invoice_sniff",
  });
  log("sbsr-sniff", "deep snapshot for " + from + " items=" + items.length + " total=" + grand + " courier=" + (courier_label || "?"));
}

// Deterministic bukti handler — called when image arrives and bridge OCR returns a total.
// Skips the LLM entirely if draft is in a payment-flow state. Mirrors Rosalie's bukti-intercept.


// Admin APPROVE/REJECT reply intercept (matches the exact text the bukti-notify dictates).
// Also supports slash form `/approve <suffix>` etc. for future SOUL.md alignment.
const ADMIN_PHONES = getSbsrFinancePhones();
const ADMIN_CMD_RE = /^\s*\/?\s*(approve|reject|terima|tolak)\s+([0-9]{4,})(?:\s+(.+))?\s*$/i;

// Customer typing "1" / "2" / "menu" / "kirim menu" / "pricelist" / "mau order" should
// deterministically fire the WhatsApp interactive product list. Same action for Branch 1
// (kirim menu) and Branch 2 (langsung order) per SOUL.md. Skips the LLM entirely.
const CATALOG_REQUEST_RE = /(?:\b(?:menu|pricelist|katalog|catalog|order|pesen|pesan|lihat)(?:nya|ku|mu|kah)?\b|\bno\s*\.?\s*1\b|\bnomor\s*1\b|\b(?:mana|bisa|tolong|minta)\s+(?:menu|pricelist|katalog|lihat)(?:nya)?\b|\bkirim(?:kan)?\s+(?:menu|pricelist|katalog)(?:nya)?\b|\blangsung\s+order\b|\bmau\s+lihat(?:nya)?\b|\bada\s+(?:menu|varian|pilihan)(?:nya)?\s*apa\b|\btunjukin\b|\btunjukkan\b|\bboleh\s+lihat(?:nya)?\b|^\s*[12]\s*[.)]?\s*$)/i;
const SBSR_GREETING_RE = /^(hi|hai|halo|hallo|hello|pagi|siang|sore|malam|assalamualaikum|assalamu'alaikum)\b/i;
const SBSR_FIXED_GREETING_TEXT =
  "Ijin mengirimkan Menu/Pricelist ya ka😊🙏🏻\n\n" +
  "Risoles Sentuh Rasa dibuat untuk kakak yang mencari cemilan dengan kualitas rasa konsisten, isian melimpah, dan bahan serta racikan yg tepat✨\n\n" +
  "Karena itu banyak pelanggan kami yang akhirnya repeat order untuk stok di rumah, suguhan tamu, maupun acara kantor.\n\n" +
  "Batch produksi hari ini masih tersedia ya ka, namun beberapa varian sering sold out lebih cepat🙏\n\n" +
  "Jika ingin mencicipi, Kakak bisa pesan sekarang untuk mengamankan stoknya, boleh diinfo mau Frozen atau goreng ka? 🥰";
const SBSR_CATALOG_IMAGE_PATH = "/docker/wa-webhook-sbsr/static/catalog-image.jpeg";
const SBSR_MAINMENU_Q3_RE = /^\s*3(?:[.)\s].*)?\s*$/i;

const SBSR_PICKUP_RE = /^(?:ambil\s*sendiri|pickup|pick\s*up|mampir)(?:[\s,.!?:-].*)?$/i;
const SBSR_PICKUP_ADDRESS_TEXT = "Jl Nusa Indah Raya blok O no 10, Cipinang Muara, Kec Jatinegara";
const SBSR_PICKUP_MAPS_URL = "https://share.google/ykWkdLTDJgG2UVfOQ";
const SBSR_PICKUP_CONTACT = "Sentuh Rasa\n+62 811 1321 166";
const SBSR_SESSION_REENTRY_RE = /^(?:hi|halo|hello|helo|hai|pagi|siang|sore|malam|permisi|tes|test|menu|pricelist|order|mau\s+order|pesan|beli|reset)\b/i;

async function sendWelcomeWithCatalog(from) {
  await sendWhatsAppMessage(from, SBSR_FIXED_GREETING_TEXT);
  try {
    if (fs.existsSync(SBSR_CATALOG_IMAGE_PATH)) {
      const mediaId = await uploadMediaToWhatsApp(SBSR_CATALOG_IMAGE_PATH, "image/jpeg");
      await sendWhatsAppImage(from, mediaId, "Menu Sentuh Rasa 🤍");
    }
  } catch (e) {
    log("welcome", "catalog_image_failed: " + e.message);
  }
}

// Build individual items from pending_items (classifier extraction).
// Returns { items, subtotal, pack } with per-product detail.
function buildItemsFromPending(pendingItems, form) {
  const _form = form || "goreng";
  const items = [];
  let subtotal = 0;
  let totalPcs = 0;
  for (const pi of pendingItems) {
    const qty = Number(pi.qty) || 1;
    const name = String(pi.name || "Risol").trim();
    const isM = /\b(?:mercon|chili|pedas)\b/i.test(name);
    let price;
    if (qty <= 3) price = isM ? 33000 : 29000;
    else if (qty <= 6) price = isM ? 63000 : 55000;
    else price = isM ? 120000 : 105000;
    items.push({ name, qty, pack_size: qty, unit_price: price, form: _form });
    subtotal += price;
    totalPcs += qty;
  }
  return { items, subtotal, pack: totalPcs };
}
const SBSR_TRANSIENT_RESET_STATES = new Set([
  "awaiting_name",
  "awaiting_addon_reply",
  "awaiting_usecase",
  "awaiting_product_selection",
  "awaiting_courier_choice",
  "awaiting_address",
  "awaiting_location",
  "awaiting_payment",
  "pending_invoice",
  "pending_quote",
]);

function shouldResetSbsrSessionOnReentry(text) {
  return SBSR_SESSION_REENTRY_RE.test(String(text || "").trim());
}

const SBSR_RESTART_INTENT_RE = /^(?:hi|hello|halo|hai|menu|mulai\s+lagi|restart|ulang|start|reset)\b/i;
const SBSR_MANUAL_RESET_RE = /^(?:reset|mulai\s+lagi|start\s+over|test\s+ulang)\s*$/i;
const SBSR_MENU_INTENT_RE = /^(?:menu|katalog|catalog|pricelist|price\s*list|lihat\s+menu|kirim\s+menu|show\s+menu|mau\s+lihat\s+menu|order\s+lagi|mau\s+order\s+lagi)\b/i;
// Broader than before: removed ^ anchor so "oke cancel kak", "ya batal deh", etc. match.
// Still gated by isCheckoutActiveState() at the call site, so false positives are contained.
const SBSR_CANCEL_INTENT_RE = /\b(?:cancel|batal|ga\s+jadi|gak\s+jadi|nggak\s+jadi|tidak\s+jadi|ulang|ulangi|order\s+ulang|mulai\s+ulang|reset\s+order|hapus\s+pesanan|batalin)\b/i;
const SBSR_ADD_MORE_INTENT_RE = /^(?:nambah|tambah|mau\s+tambah|tambah\s+pesanan|tambah\s+menu|tambah\s+lagi|add\s+more|menu\s+lagi|lihat\s+menu\s+lagi|pesan\s+lagi|mau\s+nambah)\b/i;
const SBSR_ADD_MORE_CONFIRM_RE = /^(?:1|ya|iya|ok|oke|lanjut)\b/i;
const SBSR_ADD_MORE_DECLINE_RE = /^(?:2|tidak|gak|ga|nggak|no|lanjut\s+pembayaran)\b/i;

// ── LLM-FIRST INTENT CLASSIFIER CONFIG ─────────────────────────────
let sbsrLlmClassifierEnabled = process.env.SBSR_LLM_CLASSIFIER !== "0"; // default ON, toggle via /classifier_on|off
const CLASSIFIER_TIMEOUT_MS = 15000; // 15 detik — classifier prompt panjang (~75 baris), LLM butuh waktu
const CLASSIFIER_VALID_INTENTS = new Set([
  "greeting", "request_menu", "place_order", "cancel_order",
  "confirm", "deny", "provide_name", "provide_address",
  "provide_location", "choose_option", "ask_question",
  "add_more", "change_order", "general_chat", "reset",
  "unknown" // untuk medium/low confidence (clarification / fallback)
]);
const CLASSIFIER_SKIP_RE = /^(?:ok|oke|okay|ya|iya|tidak|gak|nggak|no|yes|sip|siap|deal|lanjut|sudah|1|2|3|4|\d+)\s*$/i;
const CLASSIFIER_MAPS_SKIP_RE = /^https?:\/\/.*(?:google\.com\/maps|maps\.google|goo\.gl\/maps|maps\.app\.goo\.gl)/i;
const CLASSIFIER_MAX_CLARIFY = 3; // max tanya balik sebelum fallback ke regex

// Clarification counter — disimpan di draft._clarify_count
function getClarifyCount(draft) { return Number(draft?._clarify_count) || 0; }
function resetClarifyCount(from) {
  const d = loadSbsrDraft(from) || {};
  if (d._clarify_count) { saveSbsrDraft(from, { ...d, _clarify_count: 0 }); }
}
function incrementClarifyCount(from) {
  const d = loadSbsrDraft(from) || {};
  const n = getClarifyCount(d) + 1;
  saveSbsrDraft(from, { ...d, _clarify_count: n });
  return n;
}

const SBSR_RESTART_PROTECTED_STATES = new Set([
  "awaiting_invoice_confirm",
  "awaiting_proof",
  "awaiting_payment_proof",
  "awaiting_manual_payment_review",
  "awaiting_admin_review",
]);
const SBSR_MENU_PROTECTED_STATES = new Set([
  "awaiting_invoice_confirm",
  "pending_finance",
  "awaiting_payment_proof",
  "awaiting_payment_review",
  "awaiting_proof",
  "awaiting_manual_payment_review",
  "awaiting_admin_review",
  "payment_verified_manual",
  "payment_rejected_manual",
]);
function isRestartIntent(text, state) {
  const t = String(text || "").trim().toLowerCase();
  if (!SBSR_RESTART_INTENT_RE.test(t)) return false;
  // "halo mau pesan", "hai mau tanya", etc. are order intents, not restart.
  if (/^halo\b/i.test(t) && /\b(?:beli|pesan|order|mau |butuh|tanya|ingin)\b/i.test(t)) return false;
  return true;
}
function isMenuIntent(text) {
  return SBSR_MENU_INTENT_RE.test(String(text || "").trim().toLowerCase());
}
function isManualResetIntent(text) {
  return SBSR_MANUAL_RESET_RE.test(String(text || "").trim().toLowerCase());
}
function isCancelIntent(text) {
  return SBSR_CANCEL_INTENT_RE.test(String(text || "").trim().toLowerCase());
}
function isAddMoreIntent(text) {
  return SBSR_ADD_MORE_INTENT_RE.test(String(text || "").trim().toLowerCase());
}
function isOrderLikeText(text) {
  // Returns true if text contains specific product variant names (user is placing/modifying order)
  var t = String(text || "").toLowerCase();
  return /\b(?:ayam\s*sayur|smoked\s*beef|ragout\s*creamy|mercon|chili\s*oil|pedas|ayam\s*merchon|original|creamy\s*chicken|mix\s*risol)\b/i.test(t) ||
         /\b(?:risol|risoles)\b.*\b(?:goreng|frozen|6\s*pcs|12\s*pcs|6pcs|12pcs)\b/i.test(t);
}
function isCheckoutActiveState(state) {
  const s = String(state || "").trim().toLowerCase();
  return [
    "awaiting_invoice_confirm","awaiting_payment_proof","awaiting_proof","awaiting_delivery_method","awaiting_name",
    "awaiting_addon_reply","awaiting_pin_confirm","awaiting_address_pin_confirm","payment_review_pending",
    "awaiting_manual_payment_review","awaiting_address","awaiting_location","awaiting_usecase","awaiting_product_selection","awaiting_order_confirm"
  ].includes(s);
}



function getSbsrPickupDetailMessage() {
  return [
    "Mau pick up sendiri boleh di sini ya ka:",
    "",
    "Detail alamatnya:",
    SBSR_PICKUP_ADDRESS_TEXT,
    "",
    "Titik lokasi:",
    SBSR_PICKUP_MAPS_URL,
    "",
    "via kurir online? 🚚🛵🛍️",
    "search di app \"Sentuh Rasa\"",
    "",
    "CP:",
    SBSR_PICKUP_CONTACT,
    "",
    "‼️ Sebelum datang/order online tolong konfirmasi apakah barang sudah ready",
    "",
    "‼️ Setelah order tolong kirim SS kurir di app ya ka",
    "",
    "Makasih 💛🤎",
  ].join("\n");
}


async function tryHandlePickupFlow(from, userText) {
  if (!userText) return false;
  if (!SBSR_PICKUP_RE.test(String(userText).trim())) return false;
  const draft = loadSbsrDraft(from);
  if (!draft) return false;
  if (!Array.isArray(draft.items) || draft.items.length === 0) return false;
  if (["awaiting_invoice_confirm","awaiting_proof","pending_finance","approved","BOOKED","booked","delivered","cancelled","awaiting_manual_payment_review","payment_verified_manual"].includes(String(draft.state || ""))) return false;

  let customerName = draft.customer_name || null;
  if (!customerName && typeof findNameInChatHistory === "function") customerName = findNameInChatHistory(from);
  if (!customerName) {
    saveSbsrDraft(from, {
      ...draft,
      state: "awaiting_name",
      delivery_mode: "pickup",
      pickup_requested_at: new Date().toISOString(),
    });
    await sendWhatsAppMessage(from, "Siap Kak 🤍 untuk pickup, boleh info atas nama siapa dulu ya Kak?");
    setPendingBridgeContext(from, [
      "Customer pilih pickup / ambil sendiri.",
      "STATE: awaiting_name. Delivery mode = pickup.",
      "JANGAN arahkan ke Biteship / Maps / ongkir.",
      "Setelah customer kirim nama, bridge pickup deterministic akan lanjut bikin invoice ongkir 0.",
    ].join("\n"));
    log("sbsr-pickup", "name missing; asked deterministically for " + from);
    return true;
  }

  const draftWithName = { ...draft, customer_name: customerName };
  const subtotal = (draftWithName.items || []).reduce((s, it) => s + (Number(it.unit_price) || 0) * (Number(it.qty) || 0), 0);
  const destination = {
    ...(draftWithName.destination || {}),
    address_text: "Pickup - " + SBSR_PICKUP_ADDRESS_TEXT,
    pickup: true,
    gmaps_link: SBSR_PICKUP_MAPS_URL,
  };
  const invoicePayload = JSON.stringify({
    phone: from,
    items: draftWithName.items,
    ongkir: 0,
    customer_name: customerName,
    destination,
    courier_label: "Pickup / Ambil Sendiri",
    eta_text: "Self pickup",
  });

  const invoiceRes = await new Promise((resolve) => {
    const cp = require("child_process");
    const child = cp.spawn("docker", [
      "exec", "-i", OPENCLAW_EXEC_CONTAINER,
      "node", "/data/sentuhrasa-pdf/scripts/sentuh-invoice.mjs",
    ], { timeout: 15000 });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", c => stdout += c);
    child.stderr.on("data", c => stderr += c);
    child.on("close", () => {
      const m = stdout.match(/^---\s*\n([\s\S]*?)\n---/m);
      if (m) resolve({ ok: true, text: m[1] });
      else resolve({ ok: false, error: "no invoice text in stdout", stdout, stderr });
    });
    child.stdin.end(invoicePayload);
  });

  if (!invoiceRes.ok) {
    log("sbsr-pickup", "invoice failed: " + (invoiceRes.error || "?"));
    return false;
  }

  const pickupText = getSbsrPickupDetailMessage();
  const ackText = `Baik Kak ${customerName}, untuk pickup ongkirnya Rp0 ya 🤍\n\n${pickupText}\n\n${invoiceRes.text}`;
  await sendWhatsAppMessage(from, ackText);
  log("sbsr-pickup", "invoice_created");

  const grandTotal = subtotal;
  saveSbsrDraft(from, {
    ...draftWithName,
    state: "awaiting_invoice_confirm",
    delivery_mode: "pickup",
    pickup_requested_at: draft.pickup_requested_at || new Date().toISOString(),
    destination,
    subtotal,
    ongkir: 0,
    grand_total: grandTotal,
    expected_total: grandTotal,
    courier: "pickup",
    courier_label: "Pickup / Ambil Sendiri",
    courier_type: null,
    eta_text: "Self pickup",
    invoice_sent_at: new Date().toISOString(),
  });
  void syncCustomerDbEvent(from, "invoice_created", loadSbsrDraft(from) || draftWithName, {
    lastResponse: "invoice_created",
    lastOffer: draftWithName?.use_case ? `use_case:${draftWithName.use_case}` : "pickup_invoice",
  });

  log("sbsr-pickup", "awaiting_invoice_confirm");
  setPendingBridgeContext(from, [
    "Bridge baru saja kirim invoice pickup deterministik ke customer.",
    "STATE: awaiting_invoice_confirm — menunggu customer balas OK/YA agar bridge lanjut ke pembayaran.",
    `Customer: ${customerName}`,
    `Subtotal: ${fmtRupiah(subtotal)}`,
    "Ongkir: Rp 0",
    `Alamat pickup: ${SBSR_PICKUP_ADDRESS_TEXT}`,
    `Maps pickup: ${SBSR_PICKUP_MAPS_URL}`,
    "Kurir: Pickup / Ambil Sendiri",
    `Grand total: ${fmtRupiah(grandTotal)}`,
    "ATURAN: JANGAN minta alamat pengiriman / Maps customer lagi. JANGAN masuk LLM untuk checkout ini.",
  ].join("\n"));
  log("sbsr-pickup", "invoice pickup sent to " + from + " grand_total=" + grandTotal);
  return true;
}

async function tryHandleDeterministicGreeting(from, userText) {
  // Only fire when draft is empty (no active cart/checkout).
  // During active checkout, greetings pass through to LLM for natural handling.
  const draft = loadSbsrDraft(from);
  if (draft && draft.state) return false; // active checkout — let LLM handle
  const t = String(userText || '').trim().toLowerCase();
  if (/^(?:hi|halo|hello|helo|hai|pagi|siang|sore|malam|assalamu|permisi|tes|test)$/i.test(t)) {
    await sendWelcomeWithCatalog(from);
    return true;
  }
  return false;
}

function isSbsrMainMenuState(state) {
  const s = String(state || "").trim().toLowerCase();
  return s === "" || s === "main_menu" || s === "welcome";
}



// =====================================================
// Free-text order parsing (Branch 2b — hybrid)
// =====================================================
// Customer types order in free text instead of tapping the catalog. We call the LLM
// parser (sentuh-parse-order.mjs) which strict-validates against products.json.
// Three branches: high-confidence (build cart + ask confirm), ambiguous (one clarifier),
// not_order (fall through to LLM).
//
// Hard rules (mirror SOUL.md):
//   - never invent prices  - never default form (goreng/frozen)  - never default pack_size
//   - skip when state ∈ payment-flow (don't break in-flight orders)
//   - dormant unless SBSR_FREE_TEXT_PARSE === 'on'
//   - allowlist via SBSR_FREE_TEXT_PARSE_ALLOWLIST (comma-separated phones, empty = all)

const FREE_TEXT_INTENT_RE = /\b(risol|risoles|ayam|ragout|sayur|smoked|beef|mayo|frozen|goreng|mentah|mix|6\s*pcs|12\s*pcs|6pcs|12pcs|pesen|pesan|order|minta|mau|beli|ambil|tambah|chili|matcha|ice\s*tea|java\s*tea)\b/i;
const PARSE_FLOW_BLOCK_STATES = new Set([
  "awaiting_address", "awaiting_invoice_confirm", "awaiting_payment",
  "awaiting_finance", "awaiting_payment_proof", "BOOKED", "PAYMENT_PENDING",
]);
// Same multi-word affirmative pattern as SBSR_OK_RE; extra "lgsg/langsung" for confirm-style replies.
const ORDER_CONFIRM_YES_RE = /^(?:ya|y|ok|oke|okay|okey|sip|siap|gas|lanjut|setuju|bener|benar|lgsg|langsung|deal|gpp|udah|dah|👍|🤍)(?:[\s,.]+(?:ya|ok|oke|okay|okey|sip|siap|gas|lanjut|setuju|bener|benar|lgsg|langsung|deal|gpp|udah|dah|kak|kakak|aja|deh|nih|lah|dong|sih))*\s*[.!?,]*\s*$/i;
// 2026-05-07 QA: added "tidak" / "tdk" / "ndak" / "ngga" — formal + common
// Indonesian negation variants. Inconsistent before with PIN_CONFIRM_NO_RE
// which already had "tidak" — falling through to LLM was a UX miss.
const ORDER_CONFIRM_NO_RE  = /^(?:salah|ga|gak|gk|nggak|ngga|engga|enggak|tidak|tdk|ndak|bukan|cancel|ulang|batal|ganti|tunggu|gajadi|gak\s+jadi|tidak\s+jadi)(?:\s+(?:dulu|kak|kakak|aja|deh|dong|sih|lah|salah|ulang|ganti))*\s*[.!?,]*\s*$/i;

function freeTextParseEnabled(from) {
  if ((process.env.SBSR_FREE_TEXT_PARSE || "off").toLowerCase() !== "on") return false;
  const allow = (process.env.SBSR_FREE_TEXT_PARSE_ALLOWLIST || "").split(",").map(s => s.replace(/[^0-9]/g, "")).filter(Boolean);
  if (allow.length === 0) return true;          // no allowlist set = open to all (when PARSE=on)
  const norm = String(from).replace(/[^0-9]/g, "");
  return allow.includes(norm);
}

/**
 * tryHandleTextVariantSelection — Match free-text product name to catalog SKU
 * Handles inputs like "risoles original", "risol goreng", "ayam sayur"
 * Uses LLM to fuzzy-match against product catalog, then processes as catalog order
 */

// === GLOBAL ADD-MORE: detect "tambah"/"nambah" in ANY checkout state ===
// Fires before LLM so customer can add items without hallucination.
const GLOBAL_ADD_MORE_RE = /\b(?:tambah|nambah|tambahin|add\s*more|tambah\s+lagi|mau\s+tambah|mau\s+nambah|bisa\s+tambah|tambah\s+dikit|tambah\s+sedikit|tambah\s+aja|tambah\s+dulu|tambah\s+pesanan)\b/i;
const GLOBAL_ADD_ITEM_RE = /\b(?:tambah|nambah|tambahin)\s+(.+?)(?:\s+(\d+))?\s*$/i;



// === MISSING-FORM GUARD: tanya frozen/goreng sebelum parse free-text ===
// Fires when customer mentions specific variants + asks price/total
// but doesn't specify frozen/goreng/matang/mentah.
const MISSING_FORM_VARIANT_RE = /\b(?:ayam\s*sayur|(?:ayam\s*)?mercon|chili\s*oil|rougut|ragout|smoked\s*beef|mayo|(?:ayam\s*sayur\s*)?pedas)\b/i;
const MISSING_FORM_PRICE_RE = /\b(?:total|berapa|harga|rp\s*\d|biaya|kalkulasi|itung|hitung|estimasi|rincian|detail\s*harga)/i;
const MISSING_FORM_HAS_FORM_RE = /\b(?:frozen|goreng|matang|mentah|siap\s*makan|stock|stok)\b/i;

async function tryHandleMissingFormInquiry(from, userText) {
  const t = String(userText || "").trim();
  if (t.length < 15 || t.length > 400) return false;
  // Must have variant names
  if (!MISSING_FORM_VARIANT_RE.test(t)) return false;
  // Must be asking about price/total
  if (!MISSING_FORM_PRICE_RE.test(t)) return false;
  // Must NOT already specify frozen/goreng
  if (MISSING_FORM_HAS_FORM_RE.test(t)) return false;
  // Note: intentionally not checking draft.items.form — customer may be asking
  // about a new/additional order even with an existing draft.
  log("sbsr-missing-form", "guard_fired from=" + from);
  // Save original inquiry so LLM can re-parse after customer clarifies form
  var _md2 = loadSbsrDraft(from) || { phone: from };
  _md2.pending_missing_form_text = t;
  _md2.pending_missing_form_at = new Date().toISOString();
  saveSbsrDraft(from, _md2);
  // Send interactive buttons for quick clarification
  try {
    await sendWhatsAppInteractiveButtons(from,
      "Mohon maaf Kak, sebelum Mintu hitung totalnya, boleh dipastikan dulu ya — risol-nya mau yang mana? \u{1f90d}\n\nSoalnya harga frozen \u0026 goreng beda, dan thermal bag juga tergantung jumlah pack frozen-nya.",
      [
        { type: "reply", reply: { id: "mf_goreng", title: "Goreng (siap makan)" } },
        { type: "reply", reply: { id: "mf_frozen", title: "Frozen (mentah)" } },
      ]
    );
  } catch (e) {
    log("sbsr-missing-form", "button_err: " + (e && e.message));
    // Fallback to text
    var _fb = "Mohon maaf Kak, sebelum Mintu hitung totalnya, boleh dipastikan dulu — risol-nya mau yang *frozen* (mentah, bisa disimpan di freezer) atau *goreng* (matang, siap makan)? \u{1f90d}\n\nSoalnya harga frozen \u0026 goreng beda, dan thermal bag juga tergantung jumlah pack frozen-nya ya Kak.";
    await sendWhatsAppMessage(from, _fb);
  }
  setPendingBridgeContext(from, [
    "Bridge mendeteksi customer tanya harga/total tapi belum sebut frozen/goreng.",
    "Customer SEBELUMNYA kirim: \"" + t.slice(0, 250) + "\"",
    "Bridge SUDAH kirim tombol: Goreng / Frozen.",
    "SETELAH customer pilih, kamu WAJIB:",
    "1. Parse ulang pesanan customer dari teks asli di atas.",
    "2. HITUNG TOTALNYA dengan rinci: sebut per-item + harga satuan.",
    "3. Hitung juga add-on (matcha, thermal, dll).",
    "4. JANGAN suruh cek katalog — customer sudah sebut item spesifik.",
  ].join("\n"));
  return true;
}



// === MISSING-FORM CLARIFICATION: re-parse order after customer clarifies form ===
const MISSING_FORM_CLARIFY_RE = /\b(?:goreng|frozen|matang|mentah|siap\s*makan)\b/i;

async function tryHandleMissingFormClarification(from, userText) {
  var _md = loadSbsrDraft(from) || {};
  if (!_md.pending_missing_form_text) return false;
  var t = String(userText || "").trim();
  if (!MISSING_FORM_CLARIFY_RE.test(t)) return false;
  // Customer clarified form! Build explicit LLM prompt to calculate total
  var _orig = _md.pending_missing_form_text;
  var _formText = t.replace(/\(.*?\)/g, "").trim();  // strip "(siap makan)" etc
  // Clean up pending state
  var _clean = { ..._md };
  delete _clean.pending_missing_form_text;
  delete _clean.pending_missing_form_at;
  saveSbsrDraft(from, _clean);
  log("sbsr-missing-form", "clarification from=" + from + " form=" + _formText + " — calc via LLM");
  // Try free-text parse first (may work for some formats)
  if (typeof tryHandleFreeTextOrder === "function") {
    var _parsed = await tryHandleFreeTextOrder(from, _orig);
    if (_parsed) {
      log("sbsr-missing-form", "reparse_ok from=" + from);
      return true;
    }
    log("sbsr-missing-form", "reparse_failed — calc_via_LLM from=" + from);
  }
  // Build explicit LLM prompt with catalog prices
  // Inject live catalog so LLM can compute exact prices
  var _catalogText = "";
  try { _catalogText = formatCatalogForLLM ? formatCatalogForLLM() : ""; } catch(_ce) {}
  var _isFrozen = /frozen/i.test(_formText);
  var _calcPrompt = [
    "Kamu adalah Mintu, CS Sentuh Rasa. Customer tanya total harga pesanan.",
    "",
    "PESANAN CUSTOMER:",
    "\"" + _orig.slice(0, 300) + "\"",
    "",
    "FORM: " + _formText + (_isFrozen ? " (FROZEN, harga frozen)" : " (GORENG, harga goreng)"),
    "",
    "TUGAS KAMU:",
    "1. Parse item2 dari pesanan di atas. Customer udah klarifikasi form = " + _formText + ".",
    "2. Cocokkan setiap item ke katalog di bawah. KALAU TIDAK ADA YANG COCOK, pakai varian terdekat.",
    "3. UNTUK RISOL: kalau customer sebut varian spesifik (ayam sayur, mercon, rougut, dll) — itu ADA di katalog.",
    "   - 'ayam mercon' = Ayam Mercon Chili Oil",
    "   - 'rougut' = Ragout Creamy",
    "   - 'smoked beef' = Smoked Beef Mayo",
    "4. Kalau customer gak sebut pack size, TANYA: 3pcs, 6pcs, atau 12pcs?",
    "5. Hitung juga add-on yang disebut (matcha, thermal bag, chili sauce, ice gel, mika, greeting card, dll).",
    "6. Kirim RINCIAN TOTAL: per-item × harga satuan = subtotal. Lalu TOTAL SEMUA.",
    "",
    "JANGAN:",
    "- JANGAN bilang 'tidak ada di daftar' — semua varian ADA, cari yang terdekat.",
    "- JANGAN suruh cek katalog WA — customer sudah sebut item spesifik.",
    "- JANGAN tanya ulang varian — customer sudah sebut. HANYA tanya pack size kalau belum disebut.",
    "- JANGAN tanya frozen/goreng lagi — customer sudah klarifikasi " + _formText + ".",
    "",
    "FORMAT JAWABAN:",
    "Siap Kak! Untuk pesanan " + _formText + ":",
    "• [Nama item] × [qty] = Rp[subtotal]",
    "...",
    "",
    "*Subtotal: Rp[TOTAL]* (belum ongkir)",
    "Mau tambah atau langsung lanjut, Kak? 🤍",
    "",
    "===== KATALOG HARGA =====",
    _catalogText,
    "===== END KATALOG =====",
  ].join("\n");
  try {
    var _llmReply = await sendToOpenClaw("calc-" + Date.now() + "-" + from, _calcPrompt);
    if (_llmReply && String(_llmReply).trim()) {
      await sendWhatsAppMessage(from, String(_llmReply).trim());
      log("sbsr-missing-form", "calc_ok from=" + from);
      return true;
    }
  } catch (_e) {
    log("sbsr-missing-form", "calc_llm_err: " + (_e && _e.message));
  }
  // Ultimate fallback: set pending context for OOC handler
  setPendingBridgeContext(from, [
    "Customer klarifikasi form: \"" + _formText + "\"",
    "Original order: \"" + _orig.slice(0, 250) + "\"",
    "HITUNG TOTALNYA SEKARANG. Sebut per-item + harga + subtotal.",
  ].join("\n"));
  return false;
}


async function tryHandleFreeTextOrder(from, userText) {
  if (!userText) return false;
  if (!freeTextParseEnabled(from)) return false;
  if (userText.length < 6 || userText.length > 400) return false;
  if (!FREE_TEXT_INTENT_RE.test(userText)) return false;

  // Don't parse if customer is mid-flow (cart already locked + waiting for address/payment)
  const draft = loadSbsrDraft(from);
  if (draft?.state && PARSE_FLOW_BLOCK_STATES.has(draft.state)) {
    log("sbsr-parse", `skip from=${from} state=${draft.state} (flow-locked)`);
    return false;
  }

  log("sbsr-parse", `fire from=${from} text=${JSON.stringify(userText.slice(0, 60))}`);

  const result = await new Promise((resolve) => {
    const cp = require("child_process");
    cp.execFile("docker", [
      "exec", "sbsr-openclaw-1",
      "sh", "-c",
      "cd /data/sentuhrasa-pdf/scripts && node sentuh-parse-order.mjs " + JSON.stringify(userText),
    ], { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) { log("sbsr-parse", "exec err: " + (stderr || err.message).slice(0, 200)); return resolve(null); }
      let parsed = null;
      try { parsed = JSON.parse(stdout.trim().split(/\r?\n/).pop()); } catch (e) {
        log("sbsr-parse", "stdout not JSON: " + stdout.slice(0, 200));
      }
      resolve(parsed);
    });
  });

  if (!result || !result.ok) {
    log("sbsr-parse", `result not ok from=${from} (${result?.error || "no result"}); falling through to LLM`);
    return false;
  }

  log("sbsr-parse", `intent=${result.intent} conf=${result.confidence} items=${result.items.length} addons=${result.addons.length} subtotal=${result.subtotal}`);

  // not_order: pass through to LLM
  if (result.intent === "not_order") return false;

  // ambiguous: send one clarifier, do NOT lock cart
  if (result.intent === "ambiguous") {
    const q = result.clarifier_question || "Boleh diinfo lebih spesifik Kak — varian, ukuran (6pcs/12pcs), goreng atau frozen, dan jumlahnya?";
    try { await sendWhatsAppMessage(from, q); }
    catch (e) { log("sbsr-parse", "ambiguous reply err: " + e.message); return false; }
    setPendingBridgeContext(from, [
      "Bridge baru saja parse order customer dari free-text dan minta klarifikasi: " + JSON.stringify(q),
      "Ambiguities: " + JSON.stringify(result.ambiguities),
      "JANGAN re-prompt info yang sama — tunggu customer jawab atau kirim ulang full order.",
    ].join("\n"));
    return true;
  }

  // order: build cart, ask confirm
  if (result.intent === "order" && result.items.length > 0) {
    // Build the same cart shape the catalog tap path produces
    const cartItems = result.items.map(it => ({
      sku: it.sku, name: it.name, qty: it.qty, unit_price: it.unit_price,
      variant: it.variant, pack_size: it.pack_size, form: it.form,
      line_total: it.line_total,
    }));
    const cartAddons = result.addons.map(a => ({
      sku: a.sku, name: a.name, qty: a.qty, unit_price: a.unit_price, line_total: a.line_total,
    }));
    const subtotal = result.subtotal;
    const hasFrozen = result.has_frozen;

    // Build human-readable breakdown
    const lines = [];
    lines.push("Mintu udah catat pesanan kakak ya 🤍");
    lines.push("");
    for (const it of cartItems) {
      lines.push("• " + it.name + " × " + it.qty + " = Rp " + (it.unit_price * it.qty).toLocaleString("id-ID"));
    }
    for (const a of cartAddons) {
      lines.push("• " + a.name + " × " + a.qty + " = Rp " + (a.unit_price * a.qty).toLocaleString("id-ID"));
    }
    lines.push("");
    lines.push("*Subtotal: Rp " + subtotal.toLocaleString("id-ID") + "* (belum termasuk ongkir)");
    lines.push("");
    lines.push("Bener ya Kak? Balas *YA* biar Mintu lanjut tanya alamat. Kalau salah, balas *salah* terus tulis ulang ya 🤍");
    const reply = lines.join("\n");

    saveSbsrDraft(from, {
      ...(draft || { phone: from }),
      state: "awaiting_order_confirm",
      cart: { items: cartItems, addons: cartAddons, subtotal, has_frozen: hasFrozen },
      cart_source: "free-text-parser",
      cart_raw_text: userText,
      cart_parsed_at: new Date().toISOString(),
    });

    try { await sendWhatsAppMessage(from, reply); }
    catch (e) { log("sbsr-parse", "confirm reply err: " + e.message); return false; }

    setPendingBridgeContext(from, [
      "Bridge baru saja parse free-text order customer dan kirim cart-confirm message.",
      "State sekarang: awaiting_order_confirm. Cart subtotal=Rp " + subtotal.toLocaleString("id-ID") + ", has_frozen=" + hasFrozen + ".",
      "Tunggu customer balas YA / OK (bridge intercept akan advance ke nama+alamat) atau SALAH (bridge akan drop cart + kirim catalog).",
      "JANGAN ulang invoice atau tanya nama dulu sebelum customer confirm.",
    ].join("\n"));

    return true;
  }

  return false;
}

async function tryHandleOrderConfirm(from, userText) {
  if (!userText) return false;
  const draft = loadSbsrDraft(from);
  if (!draft || draft.state !== "awaiting_order_confirm") return false;

  if (ORDER_CONFIRM_YES_RE.test(userText.trim())) {
    log("sbsr-parse", `confirm-YES from=${from} cart_source=${draft.cart_source}`);
    saveSbsrDraft(from, { ...draft, state: "awaiting_name", delivery_mode: "delivery", delivery_mode_set_at: new Date().toISOString() });
    const reply = "Siap Kak 🤍 boleh info atas nama siapa Kak? Lalu kirim alamat lengkap pengiriman + share pin Google Maps juga ya 🤍";
    try { await sendWhatsAppMessage(from, reply); }
    catch (e) { log("sbsr-parse", "confirm-YES reply err: " + e.message); return false; }
    setPendingBridgeContext(from, [
      "Customer baru confirm cart (state advance ke awaiting_name).",
      "Bridge sudah minta nama + alamat + Maps URL.",
      "Cart udah locked di draft.cart — JANGAN re-parse, JANGAN kirim catalog lagi.",
      "Tunggu customer kirim nama + alamat + Maps URL → bridge intercept (tryHandleAddressAndQuote) akan auto-quote.",
    ].join("\n"));
    return true;
  }

  if (ORDER_CONFIRM_NO_RE.test(userText.trim())) {
    log("sbsr-parse", `confirm-NO from=${from} cart_source=${draft.cart_source}`);
    saveSbsrDraft(from, { ...draft, state: null, cart: null, cart_source: null, cart_raw_text: null });
    try {
      await sendWhatsAppMessage(from, "Oke Kak, Mintu reset dulu ya 🤍 silakan tulis ulang pesanan, atau pilih dari katalog di bawah");
      await sendWhatsAppCatalog(from);
    } catch (e) { log("sbsr-parse", "confirm-NO reply err: " + e.message); return false; }
    return true;
  }

  // Anything else: fall through to LLM (let customer ask question / re-state order)
  return false;
}

async function tryHandleAdminCmd(from, userText) {
  if (!userText) return false;
  if (tryHandleUseCase_match(userText)) return false;
  if (tryHandleFaq_match(userText)) return false;
  if (!ADMIN_PHONES.includes(from)) return false;
  // Strip WhatsApp markdown formatting (*bold*, _italic_, ~strike~, `code`) so copy-pasted
  // notification text like "*APPROVE 107177*" still matches.
  const cleanText = userText.replace(/[*_~`]/g, '').trim();
  const m = cleanText.match(ADMIN_CMD_RE);
  if (!m) return false;
  const verb   = m[1].toLowerCase();
  const suffix = m[2];
  const reason = (m[3] || "").trim() || "rejected";
  const cmd    = (verb === "approve" || verb === "terima") ? "approve" : "reject";

  log("sbsr-admin-cmd", `from=${from} cmd=${cmd} suffix=${suffix} reason=${reason}`);

  return await new Promise((resolve) => {
    const cp = require("child_process");
    const payload = JSON.stringify(cmd === "approve" ? { cmd, suffix, actor: from } : { cmd, suffix, reason, actor: from });
    cp.execFile("docker", [
      "exec", "sbsr-openclaw-1",
      "node", "/data/sentuhrasa-pdf/scripts/sentuh-admin-cmd.mjs", payload,
    ], { timeout: 60000 }, async (err, stdout, stderr) => {
      let result = null;
      try { result = JSON.parse(stdout.trim().split(/\r?\n/).pop()); } catch (_) {}
      if (err && !result) {
        log("sbsr-admin-cmd", "exec failed: " + (stderr || err.message).slice(0, 200));
        try { await sendWhatsAppMessage(from, "Admin cmd error: " + (stderr || err.message).slice(0, 120)); } catch (_) {}
        return resolve(true);
      }
      if (!result) {
        try { await sendWhatsAppMessage(from, "Admin cmd: tidak ada output dari script."); } catch (_) {}
        return resolve(true);
      }
      if (result.duplicate) {
        log("payment-review", "duplicate resolution blocked");
      } else if (result.resolution === "approved") {
        log("payment-review", "approved manually by " + from);
      } else if (result.resolution === "rejected") {
        log("payment-review", "rejected manually by " + from);
      }
      if (result.admin_message) {
        try { await sendWhatsAppMessage(from, result.admin_message); } catch (e) { log("sbsr-admin-cmd", "admin reply err: " + e.message); }
      }
      if (result.ok && result.customer_message && result.customer_phone) {
        try { await sendWhatsAppMessage(result.customer_phone, result.customer_message); }
        catch (e) { log("sbsr-admin-cmd", "customer reply err: " + e.message); }
      }

      // CRITICAL: refresh the customer's pending_bridge_context so OpenClaw stops
      // recalling the "awaiting admin approval" state set by the prior bukti intercept.
      // Without this, customer says "Halo" later and LLM hallucinates
      // "bukti masuk, tunggu admin approve" even though the order is already booked.
      const customerPhone = result.customer_phone || null;
      if (result.ok && customerPhone) {
        const norm = String(customerPhone).replace(/[^0-9]/g, "").replace(/^62/, "0");
        const custDraft = loadSbsrDraft(norm) || loadSbsrDraft(customerPhone) || {};
        const _pickupCtx2 = custDraft.delivery_mode === "pickup";
        if (cmd === "approve") {
          if (_pickupCtx2) {
            setPendingBridgeContext(customerPhone, [
              "Order customer sudah di-APPROVE oleh admin.",
              "Metode: Pickup / Ambil Sendiri.",
              "Bridge sudah kirim alamat pickup ke customer.",
              `Order: ${custDraft.order_id || "(check terakhir)"}`,
              `Total: ${fmtRupiah(custDraft.grand_total || custDraft.expected_total)}`,
              "STATE: approved — selesai.",
              "",
              "ATURAN:",
              "- JANGAN bilang 'tunggu admin approve' / 'bukti masuk' — selesai.",
              "- Kalau customer tanya status pickup, rujuk ke alamat pickup yg sudah dikirim.",
              "- Kalau customer kirim greeting/pesan baru — ANGGAP percakapan baru, balas menu standar.",
              "- Kalau mau order lagi, fire flow dari awal.",
            ].join("\n"));
          } else {
            setPendingBridgeContext(customerPhone, [
              "Order customer sudah di-APPROVE oleh admin dan sudah dibook ke kurir.",
              "Bridge sudah kirim resi + tracking link ke customer.",
              `Order: ${custDraft.order_id || "(check terakhir)"}`,
              `Total: ${fmtRupiah(custDraft.grand_total || custDraft.expected_total)}`,
              "STATE: booked — siklus order ini SELESAI.",
              "",
              "ATURAN:",
              "- JANGAN bilang 'tunggu admin' — semua sudah selesai.",
              "- Kalau customer tanya status kirim, rujuk ke tracking link.",
              "- Kalau customer kirim greeting/pesan baru — ANGGAP percakapan baru, balas menu standar.",
              "- Kalau mau order lagi, fire flow dari awal.",
            ].join("\n"));
          }
        } else if (cmd === "reject") {
          setPendingBridgeContext(customerPhone, [
            `Order customer sudah di-REJECT oleh admin. Alasan: ${reason}.`,
            "Bridge sudah kirim pesan rejection ke customer.",
            "STATE: rejected — siklus order ini SELESAI (ditolak).",
            "",
            "ATURAN:",
            "- JANGAN bilang 'tunggu admin' — admin sudah balas (REJECT).",
            "- Kalau customer protes, jelaskan singkat alasan + tawarkan order ulang.",
            "- Kalau customer kirim greeting / pesan baru, anggap percakapan baru → balas menu standar.",
          ].join("\n"));
        }
      }

      resolve(true);
    });
  });
}

const ADMIN_HANDOFF_RE = /\b(kir(?:im)?|teruskan|tolong|hubungkan|connect|forward|escal|escalate)\b.*\b(admin|finance|kakak\s+admin|owner|manager|kitchen)\b|\b(ke|kepada|ke\s+pak|ke\s+kak)\s+admin\b/i;
// =====================================================
// Kitchen READY ack from the kitchen/admin phone.
// =====================================================
// The kitchen prep ticket from sentuh-kitchen-notify.mjs ends with
// "balas 'ready' kalau sudah siap." — but the admin-lockdown in handleMessage
// silently drops anything from ADMIN_PHONES that doesn't match APPROVE/REJECT.
// Without this interceptor, the kitchen ack vanishes and the customer is never
// told their order is ready for pickup.
const ORDERS_FILE_HOST = process.env.ORDERS_FILE_HOST || "/opt/sbsr/data/openclaw/.openclaw/workspace/orders.json";
// 2026-05-07 QA: added "dah siap" (common shortening of "udah siap" — kitchen
// staff use it interchangeably; before this, the deterministic ack vanished
// when they typed the shorter form).
const KITCHEN_READY_RE = /^\s*(ready|siap|sudah\s*siap|udah\s*siap|dah\s*siap|done|prep\s*selesai)(?:\s+(?:order\s+)?(?:#)?([0-9]{4}-?[0-9]{1,4}|[0-9]{4,8}))?\s*[.!]?\s*$/i;

function loadSbsrOrders() {
  try {
    if (!fs.existsSync(ORDERS_FILE_HOST)) return {};
    return JSON.parse(fs.readFileSync(ORDERS_FILE_HOST, "utf8"));
  } catch (e) { log("sbsr-kitchen-ready", "orders load err: " + e.message); return {}; }
}
function saveSbsrOrders(orders) {
  try {
    fs.writeFileSync(ORDERS_FILE_HOST, JSON.stringify(orders, null, 2));
    return true;
  } catch (e) { log("sbsr-kitchen-ready", "orders save err: " + e.message); return false; }
}



const SBSR_OUT_OF_CONTEXT_STATES = new Set([
  "main_menu",
  "welcome",
  "awaiting_usecase",
  "awaiting_product_selection",
  "awaiting_addon_reply",
  "awaiting_delivery_method",
  "awaiting_name",
  "awaiting_address",
  "awaiting_location",
  "awaiting_courier_choice",
  "awaiting_address_pin_confirm",
  "awaiting_invoice_confirm",
  "awaiting_proof",
  "awaiting_manual_payment_review",
  "admin_handoff",
]);

function buildSbsrCartSummary(draft) {
  const items = Array.isArray(draft?.items) ? draft.items : [];
  if (!items.length) return "(empty)";
  return items.slice(0, 6).map((it) => `${it.name || "item"} x${Number(it.qty) || 0}`).join(", ");
}

function inferCatalogProductMode(items) {
  const arr = Array.isArray(items) ? items : [];
  if (!arr.length) return null;
  let frozen = 0;
  let goreng = 0;
  let mixFrozenName = 0;
  for (const it of arr) {
    const nm = String(it?.name || "").toLowerCase();
    const fm = String(it?.form || "").toLowerCase();
    if (fm === "frozen") frozen++;
    if (fm === "goreng") goreng++;
    if (nm.includes("mix frozen")) mixFrozenName++;
  }
  if (mixFrozenName > 0) return "frozen";
  if (frozen > 0 && goreng === 0) return "frozen";
  if (goreng > 0 && frozen === 0) return "goreng";
  if (frozen > 0 && goreng > 0) return "mixed";
  return null;
}

async function tryHandleOutOfContextHandoff(from, userText) {
  const draft = loadSbsrDraft(from) || {};
  const state = String(draft.state || "").trim().toLowerCase();
  if (!SBSR_OUT_OF_CONTEXT_STATES.has(state)) return false;
  const text = String(userText || "").trim();
  if (!text) return false;
  const criticalStates = new Set([
    "awaiting_proof",
    "awaiting_manual_payment_review",
    "pending_finance",
    "admin_handoff",
  ]);
  const explicitAdmin = /\b(admin|cs|customer service|finance|orang|hubungkan|sambungkan|tolong)\b/i.test(text);
  // Non-critical checkout states: detect clear out-of-context intent (questions, greetings, random topics)
  const nonCriticalCheckout = new Set([
    "awaiting_addon_reply",
    "awaiting_delivery_method",
    "awaiting_name",
    "awaiting_address",
    "awaiting_location",
    "awaiting_courier_choice",
    "awaiting_address_pin_confirm",
    "awaiting_invoice_confirm",
  ]);
  if (nonCriticalCheckout.has(state) && !explicitAdmin) {
    const hasQuestionMark = text.includes("?");
    const isQuestion = /^(?:kenapa|bagaimana|apa|siapa|kapan|dimana|mengapa|bisa|apakah|kalo|kalau|ada|berapa|bagus|rekomendasi|rekomend|info|tanya)/i.test(text) || (hasQuestionMark && text.length >= 10);
    const isGreeting = /^(?:hi|halo|hai|pagi|siang|sore|malam|permisi|maaf)/i.test(text);
    const isUnrelated = text.length > 15 && !/\b(?:alamat|ongkir|pickup|ambil|harga|menu|order|pesan|bayar|add.?on|chili|sauce|thermal|ice|gel|lanjut|cukup|gak|tidak|nggak|iya|ya|oke|ok|gas|boleh|mau|nama|saya|aku|kirim|antar|gojek|grab|jne|jnt|sicepat|paxel)/i.test(text);
    const isRandomTopic = /\b(cuaca|makanan|enak|recommend|rekomend|tempat|wisata|film|musik|game|politik|berita|kabar|lucu|komedi|sehat|sakit|kerja|sekolah|hobi)/i.test(text);
    if (isQuestion || isGreeting || (isUnrelated && isRandomTopic)) {
      log("sbsr-out-of-context", "detected_out_of_context state=" + state + " text=" + text.slice(0, 80));
      // === SMART OOC: pake LLM dengan konteks toko ===
      var _oocOk = false;
      try {
        var _oocInfo = '';
        _oocInfo += 'Kamu Mintu, CS Sentuh Rasa - Risoles Otentik.\n';
        _oocInfo += 'Jawab BAHASA INDONESIA natural dan INFORMATIF.\n';
        _oocInfo += '\n';
        var _catOOC = formatCatalogForLLM();
        _oocInfo += _catOOC;
        _oocInfo += formatFaqForLLM();
        _oocInfo += '\n';
        _oocInfo += 'Customer sedang di tahap: ' + state + '.\n';
        _oocInfo += '\n';
        _oocInfo += 'PERTANYAAN CUSTOMER:\n';
        _oocInfo += text;
        var _oocR = await sendToOpenClaw('ooc-' + Date.now() + '-' + from, _oocInfo);
        if (_oocR && String(_oocR).trim()) {
          var _oocReply = String(_oocR).trim();
          if (_oocReply.length > 5 && !/^(boleh|tolong|mohon|silahkan|kirim)\s+(kirim|isi|infokan|masukkan|share)\s*(alamat|pin|lokasi|nama)/i.test(_oocReply)) {
            await sendWhatsAppMessage(from, _oocReply);
            // Auto-notify admin if LLM replied with admin handoff in smart_ooc
            if (/(?:teruskan|sambungkan|hubungkan|forward|eskalasi|admin\s+kami)\s*(?:ke|sama|dengan)?\s*admin|admin\s*(?:akan|bakal|nanti|segera|lagi)\s*(?:bantu|cek|tinjau|review|proses|tindaklanjut)/i.test(_oocReply)) {
              const _ahDraft2 = loadSbsrDraft(from) || {};
              await notifySbsrAdminsText(
                ["🚨 *LLM ADMIN HANDOFF (smart_ooc)*", "Customer: " + (_ahDraft2.customer_name || "?") + " (+" + from + ")", "State: " + state, "LLM reply: \"" + _oocReply.slice(0, 200) + "\""].join("\n"),
                "sbsr-llm-admin-handoff"
              );
              log("sbsr-ooc", "admin_handoff_detected_in_smart_ooc");
            }
            log('sbsr-ooc', 'smart_ooc state=' + state + ' reply=' + _oocReply.slice(0, 100));
            _oocOk = true;
          }
        }
      } catch (_e) {
        log('sbsr-ooc', 'smart_ooc_err: ' + _e.message);
      }
      if (!_oocOk) {
        await sendWhatsAppMessage(from,
          "Maaf Kak, Mintu kurang paham pertanyaannya 🤍\n\n" +
          "Kalo Kakak mau tanya-tanya soal Sentuh Rasa, ketik *3* (Mau tanya-tanya) dari menu utama.\n" +
          "Kalo mau lanjutin pesanan, tinggal balas sesuai yang Mintu tanyain sebelumnya aja ya 🤍"
        );
      }
      return true;
    }
    return false;
  }
  if (!criticalStates.has(state) && !explicitAdmin) {
    return false;
  }
  log("sbsr-out-of-context", "state=" + state);
  const summary = [
    "🚨 *Out-of-context guard*",
    "Customer: " + (draft.customer_name || "?") + " (+" + from + ")",
    "State: " + state,
    "Last text: \"" + text.slice(0, 200) + "\"",
    "Cart: " + buildSbsrCartSummary(draft),
  ].join("\n");
  await notifySbsrAdminsText(summary, "sbsr-admin-handoff");
  log("sbsr-admin-handoff", "reason=out_of_context");
  await sendWhatsAppMessage(from, "Mintu sambungkan ke admin ya Kak, biar dicek lebih lanjut 🤍");
  return true;
}

// Deterministic typo guard: when customer is at `awaiting_invoice_confirm` and sends a
// VERY SHORT ambiguous text ("pl", "p", "oc", "okk", "yo", random 1-6 chars) that doesn't
// clearly match OK/cancel/menu/qty, ask for confirmation instead of letting the LLM fall back
// to [MENU]/[CATALOG] (which is what made WhatsApp Web show "this message can't be displayed").
// 2026-05-07 QA: added "tidak" / "tdk" — formal Indonesian negation,
// previously only matched colloquial variants.
const SBSR_CANCEL_RE = /^(no|nope|gak|gk|ga|cancel|stop|tolak|batal|engga|nggak|ngga|ndak|tidak|tdk)\b/i;
async function tryHandleAmbiguousConfirm(from, userText) {
  if (!userText) return false;
  const t = userText.trim();
  if (t.length < 1 || t.length > 6) return false;
  if (SBSR_OK_RE.test(t)) return false;            // already handled in tryHandleInvoiceOk
  if (CATALOG_REQUEST_RE.test(t)) return false;    // already handled
  if (/^[0-9]+$/.test(t)) return false;            // pure number / qty
  if (SBSR_CANCEL_RE.test(t)) return false;        // explicit cancel — let LLM handle handoff
  if (SBSR_GREETING_RE.test(t)) return false;      // greetings are handled earlier by deterministic bridge intercept
  const draft = loadSbsrDraft(from);
  if (!draft || draft.state !== "awaiting_invoice_confirm") return false;
  log("sbsr-ambiguous-confirm", "fire for " + from + " text=" + JSON.stringify(t));
  try {
    await sendWhatsAppMessage(from,
      "Maksudnya *OK* ya Kak? 🤍\n" +
      "Kalau iya, balas *OK* atau *YA* — Mintu lanjut ke pembayaran.\n" +
      "Kalau mau cancel atau ubah pesanan, ketik *cancel* ya."
    );
  } catch (e) { log("sbsr-ambiguous-confirm", "send err: " + e.message); return false; }
  setPendingBridgeContext(from, [
    "Bridge sudah tanya konfirmasi karena customer kirim text pendek tidak jelas.",
    "STATE: awaiting_invoice_confirm — TUNGGU customer balas OK / YA / cancel explicit.",
    "JANGAN kirim katalog / menu. JANGAN tanya nama/alamat ulang. Tunggu konfirmasi.",
  ].join("\n"));
  return true;
}

const SBSR_PAYMENT_INFO_RE = /\b(rekening|transfer\s+ke\s+mana|bank\s+account|nomor\s+rekening|rek\s+bca|detail\s+pembayaran|cara\s+bayar)\b/i;
const SBSR_PAYMENT_STATUS_RE = /\b(sudah\s+dikirim\s+ke\s+admin|admin\s+sudah\s+terima|sudah\s+dicek\s+admin|sudah\s+approve|status\s+pembayaran|status\s+bukti)\b/i;

async function resendPaymentInstructionFromSource(from) {
  const draft = loadSbsrDraft(from);
  if (!draft || !draft.grand_total) return false;
  const payload = JSON.stringify({
    phone: "+" + from.replace(/[^0-9]/g, ""),
    customer_name: draft.customer_name || "",
    grand_total: draft.grand_total,
  });
  return await new Promise((resolve) => {
    const child_process = require("child_process");
    child_process.execFile("docker", [
      "exec", OPENCLAW_EXEC_CONTAINER,
      "node", "/data/sentuhrasa-pdf/scripts/sentuh-payment.mjs", payload,
    ], { timeout: 30000 }, async (_err, stdout, _stderr) => {
      let scriptResult = null;
      try { scriptResult = parseScriptJSON(stdout); } catch (_) {}
      const msg = String(scriptResult?.userMessage || draft.payment_instruction_text || "").trim();
      if (!msg) return resolve(false);
      try {
        await sendWhatsAppMessage(from, msg);
        log("sbsr-payment-info", "resent payment instruction");
        return resolve(true);
      } catch (_) {
        return resolve(false);
      }
    });
  });
}

function buildSbsrPaymentOrderKey(draft) {
  const invoiceId = String(draft?.invoice_id || "").trim();
  if (invoiceId) return "inv:" + invoiceId;
  const invoiceCreatedAt = String(draft?.invoice_created_at || draft?.invoice_sent_at || draft?.invoice_sniffed_at || "").trim();
  if (invoiceCreatedAt) return "ts:" + invoiceCreatedAt;
  const itemsSig = JSON.stringify((Array.isArray(draft?.items) ? draft.items : []).map(it => ({
    sku: it?.sku || "",
    name: it?.name || "",
    qty: Number(it?.qty || 0),
    unit_price: Number(it?.unit_price || 0),
    form: it?.form || "",
    pack_size: Number(it?.pack_size || 0),
  })));
  const raw = [itemsSig, String(draft?.grand_total || 0), String(draft?.subtotal || 0), String(draft?.customer_name || "")].join("|");
  return "hash:" + crypto.createHash("sha1").update(raw).digest("hex");
}

async function tryHandlePaymentReviewStatusIntent(from, userText) {
  if (!userText) return false;
  if (!SBSR_PAYMENT_STATUS_RE.test(String(userText))) return false;
  const draft = loadSbsrDraft(from) || {};
  const state = String(draft.state || "").trim().toLowerCase();
  const valid = new Set(["awaiting_manual_payment_review", "pending_finance", "payment_review_pending"]);
  if (!valid.has(state)) return false;
  await sendWhatsAppMessage(from, "Sudah Kak, bukti transfernya sudah Mintu terima ya 🤍 Sebentar ya, pembayaran sedang diverifikasi.");
  log("payment-review-status", "handled");
  return true;
}



// === DELIVERY CONFIRMATION HANDLER ===

// === LLM-FIRST ROUTER ===
const LLM_FIRST_STATES_INIT = new Set([
  null, 'none', 'initial', '', 'main_menu', 'awaiting_main_menu_choice',
  'awaiting_usecase', 'awaiting_product_selection', 'awaiting_addon_reply',
  'awaiting_addon_selection', 'awaiting_delivery_method',
  'awaiting_name', 'awaiting_address',
  'awaiting_pin_confirmation', 'awaiting_pin_confirm',
  'awaiting_address_pin_confirm', 'awaiting_pickup_time',
  'awaiting_invoice_confirm', 'awaiting_proof',
  'awaiting_payment_proof', 'awaiting_order_confirm',
  'awaiting_courier_choice', 'awaiting_location',
  'awaiting_location_retry', 'awaiting_question',
  'awaiting_addon', 'awaiting_add_more_confirm',
  'awaiting_addon_signature_clarify', 'awaiting_meeting_package_confirm',
  'awaiting_new_pin', 'awaiting_payment',
  'awaiting_manual_payment_review', 'awaiting_admin_review',
  'awaiting_finance',
]);

async function llmFirstRouter(from, text, draft) {
  const state = String(draft?.state || '').toLowerCase();
  if (!LLM_FIRST_STATES_INIT.has(state) && !LLM_FIRST_STATES_INIT.has(draft?.state)) return null;
  if (/^(ok|ya|sudah|lanjut|iya|done|siap|yes|no|enggak|ga|gak)$/i.test(text.trim())) return null;
  try {
    const cart = draft?.cart || [];
    const ctx = 'Kamu adalah Mintu, CS ramah Sentuh Rasa (risoles frozen & goreng).\nStatus: state=' + state + ' nama=' + (draft?.customer_name||'') + ' usecase=' + (draft?.usecase||'') + ' cart=' + (cart.length ? JSON.stringify(cart) : 'kosong') + '\n\nRESPON JSON: {intent, response_text (natural Indo), extracted_data, confidence}\n\nPesan: ' + text;
    const result = await sendToOpenClaw(from, ctx);
    if (!result) return null;
    const cleaned = result.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const parsed = JSON.parse(cleaned);
    if (!parsed || !parsed.intent || (parsed.confidence || 0) < 0.6) return null;
    return parsed;
  } catch (err) {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════
// LLM-FIRST INTENT CLASSIFIER
// ═══════════════════════════════════════════════════════════════════

// ── Natural Reply Generator ────────────────────────────────────────
// LLM generates conversational reply + extracts structured order data.
// Returns { reply, items, use_case_hint } or null.
async function generateClassifierReply(from, userText, intent, draft) {
  const state = String(draft?.state || "none").trim().toLowerCase();
  const customerName = String(draft?.customer_name || "");
  const useCase = String(draft?.use_case || "");
  const deliveryMode = String(draft?.delivery_mode || "");
  const items = Array.isArray(draft?.items) ? draft.items : [];
  const cartSummary = items.length > 0
    ? items.map(it => (it.qty || 1) + "x " + (it.name || "?") + " (" + (it.form || "?") + ")").join(", ")
    : "(kosong)";

  const prompt = [
    "Kamu adalah Mintu, CS ramah dari Sentuh Rasa — Risoles Otentik.",
    "Tugasmu: balas customer dengan NATURAL, WARM, dan HELPFUL. Bukan template/robot.",
    "",
    "=== KONTEKS ===",
    "State: " + state,
    "Intent customer (dari classifier): " + intent,
    "Nama customer: " + (customerName || "(belum diisi)"),
    "Use case: " + (useCase || "(belum dipilih)"),
    "Delivery: " + (deliveryMode || "(belum dipilih)"),
    "Isi cart: " + cartSummary,
    "Pending items (customer udah sebut tapi belum dikonfirmasi): " + JSON.stringify(draft?.pending_items || []),
    "",
    "=== ATURAN PENTING ===",
    "- JANGAN hitung total/cart/kalkulasi — sistem yang handle.",
    "- JANGAN sebut kata 'intent', 'classifier', 'state', 'sistem'.",
    "- Kalau state=awaiting_usecase: tanya customer mau makan langsung / frozen / meeting / gift.",
    "- Kalau state=awaiting_product_selection: bantu customer pilih varian dari katalog.",
    "- Kalau state=awaiting_name: minta nama penerima.",
    "- Kalau state=awaiting_address: minta alamat lengkap.",
    "- Kalau state=awaiting_delivery_method: suruh pilih delivery / pickup.",
    "- JANGAN kirim katalog WA kecuali customer minta EXPLICIT.",
    "- Kalau customer sebut produk spesifik (misal 'ayam sayur', 'smoked beef'), acknowledge dan bantu pilih form (goreng/frozen).",
    "- Kalau ada pending_items: SEBUTKAN itemnya dan TANYA apakah sudah benar. JANGAN tawarin ulang semua produk.",
    "- Kalau customer pilih usecase (makan langsung/frozen) + ada pending_items: KONFIRMASI pesanan dan ARAHKAN ke 'Ya, lanjut pesan'.",
    "- Keep it short & natural (2-4 kalimat), akhiri dengan emoji 🤍",
    "",
    "=== EKSTRAK ITEM (kalau customer sebut produk + quantity) ===",
    "Output HARUS JSON. Kalau customer sebut produk spesifik, ekstrak juga items-nya:",
    "{",
    '  "reply": "<balasan natural ke customer>",',
    '  "items": [{"name": "Ayam Sayur", "qty": 3}, {"name": "Smoked Beef Mayo", "qty": 3}]  // atau []',
    '  "use_case_hint": "goreng"  // "goreng", "frozen", atau null',
    "}",
    "Kalau customer TIDAK sebut produk spesifik, items = [].",
    "Deteksi use_case_hint dari kata 'makan langsung'/'goreng'/'siap makan' → 'goreng', 'frozen'/'stok'/'mentah' → 'frozen'.",
    "",
    "=== PESAN CUSTOMER ===",
    userText,
  ].join("\n");

  try {
    const raw = await sendToOpenClaw("reply-" + Date.now() + "-" + from, prompt);
    if (raw && String(raw).trim()) {
      let cleaned = String(raw).trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```\s*$/i, "");
      try {
        const parsed = JSON.parse(cleaned);
        return {
          reply: String(parsed.reply || "").trim(),
          items: Array.isArray(parsed.items) ? parsed.items : [],
          use_case_hint: parsed.use_case_hint || null,
        };
      } catch (_) {
        // Fallback: treat whole response as reply text
        return { reply: cleaned, items: [], use_case_hint: null };
      }
    }
  } catch (e) {
    log("llm-reply", "generate_failed: " + (e && e.message || "?"));
  }
  return null;
}

function buildClassifierPrompt(from, userText, draft, bridgeContext) {
  const state = String(draft?.state || "none").trim().toLowerCase();
  const customerName = String(draft?.customer_name || "");
  const useCase = String(draft?.use_case || "");
  const deliveryMode = String(draft?.delivery_mode || "");
  const items = Array.isArray(draft?.items) ? draft.items : [];
  const cartSummary = items.length > 0
    ? items.map(it => (it.qty || 1) + "x " + (it.name || "?") + " (" + (it.form || "?") + ")").join(", ")
    : "(kosong)";

  return [
    "Kamu adalah classifier intent chat untuk toko Risol Sentuh Rasa.",
    "Tugasmu HANYA mengklasifikasikan intent pesan customer dalam Bahasa Indonesia.",
    "JANGAN menghasilkan teks balasan — output JSON SAJA.",
    "",
    "=== STATUS PELANGGAN ===",
    "State saat ini: " + state,
    "Nama: " + (customerName || "(belum diisi)"),
    "Use case: " + (useCase || "(belum dipilih)"),
    "Delivery mode: " + (deliveryMode || "(belum dipilih)"),
    "Isi cart: " + cartSummary,
    "",
    "=== KONTEKS PERCAKAPAN ===",
    bridgeContext || "(tidak ada — ini pesan pertama atau setelah reset)",
    "",
    "=== DAFTAR INTENT (pilih SATU) ===",
    "PENTING — STATE AWARE:",
    "- State=awaiting_usecase: customer sedang memilih use case. 'makan langsung', 'frozen', 'stok', 'meeting', 'gift', 'hampers' → choose_option.",
    "- State=awaiting_product_selection: customer sedang pilih produk → choose_option atau place_order. TAPI 'lanjut pesan', 'lanjutkan', 'proses', 'ya lanjut', 'ok lanjut', 'cek out', 'checkout' → confirm.",
    "- Kalau pesan mengandung alamat lengkap (jalan, nomor, kota) → langsung provide_address HIGH.",
    "- Kalau ada nama+alamat sekaligus → tetap provide_address (bukan unknown/medium).",
    "",
    "greeting: menyapa (halo, pagi, assalamualaikum)",
    "request_menu: minta menu/katalog/pricelist (menu dong, kirim katalog, pricelist, daftar harga, lihat menu)",
    "place_order: mau pesan/order (mau risol 6pcs, order dong, beli frozen)",
    "cancel_order: batalkan pesanan (cancel, batalin, ga jadi mesen)",
    "confirm: konfirmasi setuju (ya, ok, sip, lanjut, betul, gass)",
    "deny: menolak (tidak, gak, salah, bukan, nggak jadi)",
    "provide_name: kasih nama (atas nama Budi, saya Andi, nama Revaldy)",
    "provide_address: kasih alamat teks — PRIORITAS kalau text mengandung alamat lengkap (Jl Merdeka No 12, Jalan BPK, Perum Citra, Blok A). Kalau ada nama+alamat sekaligus → tetap provide_address.",
    "provide_location: share Google Maps URL atau WA location pin",
    "choose_option: pilih dari opsi (1, delivery, goreng, paxel)",
    "ask_question: tanya spesifik produk/harga/cara pesan (halal ga?, ongkir berapa?, berapa harga X?) — BUKAN minta pricelist/menu",
    "add_more: tambah pesanan (nambah dong, tambah chili sauce)",
    "change_order: ubah/revisi pesanan (ganti varian, ubah jadi frozen)",
    "general_chat: ngobrol di luar konteks order (gimana kabar?, curhat)",
    "reset: minta reset/mulai ulang (reset, mulai dari awal, start over)",
    "",
    "=== FORMAT OUTPUT (JSON SAJA, tanpa markdown) ===",
    "Kalau kamu YAKIN dengan intent-nya:",
    "{",
    "  \"intent\": \"<salah satu dari daftar di atas>\",",
    "  \"confidence\": \"high\"",
    "}",
    "",
    "Kalau kamu RAGU (ada beberapa kemungkinan):",
    "{",
    "  \"intent\": \"unknown\",",
    "  \"confidence\": \"medium\",",
    "  \"clarification\": \"<pertanyaan natural dalam Bahasa Indonesia untuk memperjelas maksud customer>\"",
    "}",
    "",
    "Kalau kamu SANGAT TIDAK YAKIN:",
    "{",
    "  \"intent\": \"unknown\",",
    "  \"confidence\": \"low\"",
    "}",
    "",
    "ATURAN CLARIFICATION:",
    "- Tanya ramah & natural, maks 2 kalimat pendek, akhiri emoji 🤍.",
    "- Langsung ke intinya — tanya apa yang ambigu.",
    "- JANGAN sebut kata 'intent', 'classifier', 'confidence', atau 'sistem'.",
    "- Contoh: 'Maksudnya Kakak mau pesan atau cuma tanya harga dulu? 🤍'",
    "",
    "=== PESAN CUSTOMER ===",
    userText,
  ].join("\n");
}

async function classifyIntentWithLLM(from, userText, draft, bridgeContext) {
  const t = String(userText || "").trim();

  if (CLASSIFIER_SKIP_RE.test(t)) {
    log("llm-classifier", "skip_structured text=" + t.slice(0, 30));
    return null;
  }
  if (CLASSIFIER_MAPS_SKIP_RE.test(t)) {
    log("llm-classifier", "skip_maps_url");
    return null;
  }
  if (t.length < 3) {
    log("llm-classifier", "skip_short len=" + t.length);
    return null;
  }
  if (t.length > 500) {
    log("llm-classifier", "skip_long len=" + t.length);
    return null;
  }

  const prompt = buildClassifierPrompt(from, userText, draft, bridgeContext);

  try {
    const raw = await Promise.race([
      sendToOpenClaw("intent-" + Date.now() + "-" + from, prompt),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Classifier timeout")), CLASSIFIER_TIMEOUT_MS)
      ),
    ]);

    if (!raw || !String(raw).trim()) {
      log("llm-classifier", "empty_response");
      return null;
    }

    let cleaned = String(raw).trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/i, "");

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (_) {
      const m = cleaned.match(/\{[\s\S]*"intent"[\s\S]*\}/);
      if (m) {
        try { parsed = JSON.parse(m[0]); } catch (__) { /* ignore */ }
      }
      if (!parsed) {
        log("llm-classifier", "json_parse_failed raw=" + cleaned.slice(0, 100));
        return null;
      }
    }

    if (!parsed || !CLASSIFIER_VALID_INTENTS.has(parsed.intent)) {
      log("llm-classifier", "invalid_intent=" + (parsed?.intent || "?"));
      return null;
    }

    const confidence = ["high", "medium", "low"].includes(parsed.confidence)
      ? parsed.confidence
      : "medium";

    const clarification = (confidence === "medium" && parsed.clarification)
      ? String(parsed.clarification).trim()
      : null;

    log("llm-classifier", "result intent=" + parsed.intent + " conf=" + confidence +
        (clarification ? " clarify=" + clarification.slice(0, 60) : ""));
    return { intent: parsed.intent, confidence, clarification };
  } catch (err) {
    log("llm-classifier", "error=" + (err && err.message || "?"));
    return null;
  }
}

async function routeClassifiedIntent(from, userText, intent, messageId) {
  const draft = loadSbsrDraft(from) || { phone: from };
  const state = sbsrRouterStateLabel(draft);

  log("llm-classifier", "route intent=" + intent + " state=" + state);

  try {
    switch (intent) {

      case "greeting": {
        if (isSbsrCheckoutCollectionActive(draft)) return false;
        if (await tryHandleDeterministicGreeting(from, userText)) return true;
        await sendWelcomeWithCatalog(from);
        return true;
      }

      case "request_menu": {
        if (isProtectedPaymentFlowDraft(draft)) {
          const d = loadSbsrDraft(from) || {};
          saveSbsrDraft(from, { ...d, add_more_mode: true });
          await sendWhatsAppMessage(from, "Siap Kak, ini katalognya ya \u{1f90d}");
          await sendWhatsAppCatalog(from);
          return true;
        }
        resetSbsrCheckoutState(from);
        await sendWhatsAppMessage(from, formatSbsrFullMenuText());
        await sendWhatsAppCatalog(from);
        await sendSbsrUseCasePrompt(from, { phone: from });
        return true;
      }

      case "place_order": {
        if (typeof tryHandleFreeTextOrder === "function" && await tryHandleFreeTextOrder(from, userText)) {
          return true;
        }
        // Detect "lanjut pesan" / "proses" — customer wants to proceed with pending order
        const _proceedRe = /\b(?:lanjut\s*(?:pesan|kan|aja|deh|saja|proses)|ya\s+lanjut|ok\s+lanjut|proses\s+pesan|langsung\s+proses|cek\s*out|checkout)\b/i;
        if (_proceedRe.test(String(userText || "")) && state !== "none") {
          const _bd = loadSbsrDraft(from) || {};
          const _pendItems = Array.isArray(_bd.pending_items) ? _bd.pending_items : [];
          const _summary = _bd.pending_order_summary || "";
          if (_pendItems.length > 0 || _summary) {
            const _form = String(_bd.use_case || "").includes("frozen") ? "frozen" : "goreng";
            let _built;
            if (_pendItems.length > 0) {
              _built = buildItemsFromPending(_pendItems, _form);
            } else {
              const _pm = _summary.match(/Rp\s*([\d.]+)/);
              const _price = _pm ? parseInt(_pm[1].replace(/\./g,""),10) : 0;
              const _pack = 6;
              _built = { items: [{name:"Risol " + (_form==="frozen"?"Frozen":"Goreng") + " — Mix " + _pack + "pcs", qty:1, pack_size:_pack, unit_price:_price, form:_form}], subtotal:_price, pack:_pack };
            }
            saveSbsrDraft(from, { ..._bd, items: _built.items, subtotal: _built.subtotal, pending_order_summary:null, pending_items:null, state:"awaiting_delivery_method" });
            log("llm-classifier", "proceed_detected → delivery_method items=" + _built.items.length + " subtotal=" + _built.subtotal);
            await sendSbsrDeliveryMethodButtons(from);
            sendReaction(from, messageId, "").catch(() => {});
            return true;
          }
        }
        // Set state BEFORE generating reply — LLM prompt lihat state baru
        let _replyDraft = draft;
        if (state === "none") {
          const d = loadSbsrDraft(from) || {};
          saveSbsrDraft(from, { ...d, state: "awaiting_usecase" });
          _replyDraft = { ...d, state: "awaiting_usecase" };
        }
        // LLM natural reply + extract items
        const _result = await generateClassifierReply(from, userText, "place_order", _replyDraft);
        if (_result && _result.reply) {
          await sendWhatsAppMessage(from, _result.reply);
          // Save extracted items to draft so next message remembers them
          if (_result.items && _result.items.length > 0) {
            const _d = loadSbsrDraft(from) || {};
            saveSbsrDraft(from, { ..._d, pending_items: _result.items });
            log("llm-classifier", "extracted_items=" + JSON.stringify(_result.items.map(i => i.qty + "x " + i.name)));
          }
          if (_result.use_case_hint && !_replyDraft.use_case) {
            const _d2 = loadSbsrDraft(from) || {};
            saveSbsrDraft(from, { ..._d2, use_case: _result.use_case_hint });
            log("llm-classifier", "use_case_hint=" + _result.use_case_hint);
          }
          log("llm-classifier", "natural_reply intent=place_order prev_state=" + state + " new_state=" + (_replyDraft.state || "?"));
          return true;
        }
        // Fallback: template (kalau LLM gagal)
        await sendSbsrUseCasePrompt(from, _replyDraft.phone ? _replyDraft : { phone: from });
        return true;
        return true;
      }

      case "cancel_order": {
        if (isCheckoutActiveState(state)) {
          clearSbsrCheckoutForCancel(from);
          await sendWhatsAppMessage(from,
            "Siap Kak, pesanan sebelumnya Mintu batalkan ya \u{1f90d}\n\n" +
            "Mau mulai lagi? Ketik *MENU* untuk lihat katalog atau pilih:\n" +
            "1. Kirimkan menu/pricelist\n2. Mau langsung order\n3. Mau tanya-tanya"
          );
        } else {
          await sendWhatsAppMessage(from,
            "Kak, belum ada pesanan aktif yang perlu dibatalkan ya \u{1f90d}\n" +
            "Ketik *MENU* untuk mulai order."
          );
        }
        return true;
      }

      case "confirm": {
        if (state === "awaiting_invoice_confirm" && await tryHandleInvoiceOk(from, userText)) return true;
        if (state === "awaiting_order_confirm" && typeof tryHandleOrderConfirm === "function" && await tryHandleOrderConfirm(from, userText)) return true;
        if (state === "awaiting_meeting_package_confirm" && typeof tryHandleMeetingPackageConfirm === "function" && await tryHandleMeetingPackageConfirm(from, userText)) return true;
        if (state === "awaiting_pin_confirm" && await tryHandlePinConfirm(from, userText)) return true;
        // Confirm in product selection: treat as "lanjut pesan" if pending items exist
        if ((state === "awaiting_product_selection" || state === "awaiting_usecase") && !draft.delivery_mode) {
          const _bd = loadSbsrDraft(from) || draft;
          const _pendItems = Array.isArray(_bd.pending_items) ? _bd.pending_items : [];
          const _summary = _bd.pending_order_summary || "";
          if (_pendItems.length > 0 || _summary) {
            let _price = 0;
            const _form = String(_bd.use_case || "").includes("frozen") ? "frozen" : "goreng";
            let _built;
            if (_pendItems.length > 0) {
              _built = buildItemsFromPending(_pendItems, _form);
            } else {
              const _pm = _summary.match(/Rp\s*([\d.]+)/);
              const _price = _pm ? parseInt(_pm[1].replace(/\./g,""),10) : 0;
              _built = { items: [{name:"Risol " + (_form==="frozen"?"Frozen":"Goreng") + " — Mix 6pcs", qty:1, pack_size:6, unit_price:_price, form:_form}], subtotal:_price, pack:6 };
            }
            saveSbsrDraft(from, { ..._bd, items: _built.items, subtotal: _built.subtotal, pending_items:null, pending_order_summary:null, state:"awaiting_delivery_method" });
            log("llm-classifier", "confirm→lanjut items=" + _built.items.length + " subtotal=" + _built.subtotal);
            await sendSbsrDeliveryMethodButtons(from);
            sendReaction(from, messageId, "").catch(() => {});
            return true;
          }
        }
        return false;
      }

      case "deny": {
        if (state === "awaiting_order_confirm" && typeof tryHandleOrderConfirm === "function" && await tryHandleOrderConfirm(from, userText)) return true;
        if (state === "awaiting_meeting_package_confirm" && typeof tryHandleMeetingPackageConfirm === "function" && await tryHandleMeetingPackageConfirm(from, userText)) return true;
        return false;
      }

      case "provide_name": {
        if (typeof tryHandleNameCapture === "function" && await tryHandleNameCapture(from, userText)) return true;
        const nameRe = /(?:nama|atas\s*nama|saya|aku|gw|gue)\s*:?\s*(.+)/i;
        const m = userText.match(nameRe);
        if (m && m[1].trim().length >= 2) {
          const d = loadSbsrDraft(from) || {};
          saveSbsrDraft(from, { ...d, customer_name: m[1].trim() });
          log("llm-classifier", "shadow_name_capture name=" + m[1].trim());
        }
        return false;
      }

      case "provide_address": {
        if (typeof tryHandleAddressTextCapture === "function" && await tryHandleAddressTextCapture(from, userText)) return true;
        return false;
      }

      case "provide_location": {
        if (await tryHandleBareMapsUrl(from, userText)) return true;
        if (await tryHandleAddressAndQuote(from, userText)) return true;
        return false;
      }

      case "choose_option": {
        if (await tryHandleDeliveryMethodSelection(from, userText)) return true;
        if (await tryHandleUseCaseRouter(from, userText)) return true;
        if (typeof tryHandleFrozenCourierChoice === "function" && await tryHandleFrozenCourierChoice(from, userText)) return true;
        if (typeof tryHandlePickupFlow === "function" && await tryHandlePickupFlow(from, userText)) return true;
        if (await tryHandleAddressPinConfirm(from, userText)) return true;
        // No handler matched — use natural reply instead of falling to OOC LLM
        const _coReply = await generateClassifierReply(from, userText, "choose_option", draft);
        if (_coReply && _coReply.reply) {
          await sendWhatsAppMessage(from, _coReply.reply);
          log("llm-classifier", "natural_reply intent=choose_option state=" + state);
          return true;
        }
        return false;
      }

      case "ask_question": {
        if (typeof tryHandleFaq === "function" && await tryHandleFaq(from, userText)) return true;
        // Quick-help: jawab pertanyaan umum langsung tanpa OOC LLM
        // (berguna saat FAQ di-block oleh checkout state)
        const _aq = String(userText || "").trim().toLowerCase();
        if (/\b(?:cara|gimana|bagaimana)\b.*\b(?:share|kirim|ngirim)\s*(?:lokasi|location|titik|pin)\b/i.test(_aq) ||
            /\b(?:share|kirim|ngirim)\s*(?:lokasi|location|titik|pin)\b.*\b(?:cara|gimana|bagaimana)\b/i.test(_aq)) {
          await sendWhatsAppMessage(from, "Gampang Kak! Tinggal tap tombol *Send Location* atau ikon 📎 (lampiran) > pilih *Location* > kirim titik lokasi Kakak 🤍");
          return true;
        }
        return false;
      }

      case "add_more": {
        const d = loadSbsrDraft(from) || {};
        if (!Array.isArray(d.items) || d.items.length === 0) {
          // Kalau udah dalam flow (state bukan none), jangan reset ke usecase.
          // Biar existing pipeline yang handle — bisa jadi customer belum
          // finalisasi order pertama dan ini sebenernya product selection.
          if (state !== "none") {
            log("llm-classifier", "add_more blocked — no items yet, in flow state=" + state + " — fallthrough to regex");
            return false;
          }
          // Fresh customer: start dari awal
          await sendSbsrUseCasePrompt(from, { phone: from });
          await sendWhatsAppCatalog(from);
          return true;
        }
        if (typeof tryHandleGlobalAddMore === "function" && await tryHandleGlobalAddMore(from, userText)) {
          return true;
        }
        saveSbsrDraft(from, { ...d, add_more_mode: true, state: "awaiting_product_selection" });
        await sendWhatsAppMessage(from, "Siap Kak, silakan pilih dari katalog ya \u{1f90d} nanti totalnya Mintu gabungkan.");
        await sendWhatsAppCatalog(from);
        return true;
      }

      case "change_order": {
        const d = loadSbsrDraft(from) || {};
        if (!Array.isArray(d.items) || d.items.length === 0) {
          // Kalau udah dalam flow, jangan block — biar pipeline handle natural.
          // Customer mungkin lagi pilih produk dan "ganti varian" = ganti pilihan.
          if (state !== "none") {
            log("llm-classifier", "change_order blocked — no items yet, in flow state=" + state + " — fallthrough to regex");
            return false;
          }
          // Fresh customer: kasih tau belum ada pesanan
          await sendWhatsAppMessage(from, "Kak, belum ada pesanan yang bisa diubah. Ketik *MENU* untuk mulai order ya \u{1f90d}");
          return true;
        }
        saveSbsrDraft(from, { ...d, items: null, addons: null, subtotal: null, cart: null, state: "awaiting_product_selection" });
        await sendWhatsAppMessage(from, "Siap Kak, pesanan sebelumnya Mintu reset dulu ya. Silakan pilih ulang dari katalog \u{1f90d}");
        await sendWhatsAppCatalog(from);
        return true;
      }

      case "reset": {
        hardResetSbsrSession(from);
        await sendWelcomeWithCatalog(from);
        return true;
      }

      case "general_chat":
      default: {
        return false;
      }
    }
  } catch (_routeErr) {
    log("llm-classifier", "route_error intent=" + intent + " err=" + (_routeErr && _routeErr.message || "?"));
    return false;
  }
}

// ── Engine init (called once, lazy) ───────────────────────────────────
var _engineInited = false;
function _initEngine() {
  if (_engineInited || !engineCtx) return;
  engineCtx.init({
    SBSR_DRAFTS_DIR,
    sendWhatsAppMessage,
    sendWhatsAppCatalog,
    sendWhatsAppLocationRequest,
    notifySbsrAdminsText,
    sendReaction,
    sendToOpenClaw,
    getCatalogSnapshot: function() { return loadProductCatalog(); },
    sbsrRetrieveMemoryContext: function(f, t) { return sbsrRetrieveMemoryContext(f, t); },
    log: function(tag, msg) { log(tag, msg); },
  });
  // Init wa-sender
  if (waSender) waSender.init({
    apiVersion: WA_API_VERSION, phoneNumberId: WA_PHONE_NUMBER_ID, accessToken: WA_ACCESS_TOKEN,
    log: log, sanitizeReply: sanitizeLLMReply, isWindowOpen: isWaWindowOpen,
    onSent: function(to, text) {
      safeLog(admin.logOutgoing, to, text);
      try { var _n = String(to).replace(/[^0-9]/g, ''); var _dr = loadSbsrDraft(to) || { phone: _n }; saveSbsrDraft(to, { ..._dr, last_reply_at: new Date().toISOString() }); } catch (_) {}
    },
  });
  // Init catalog-manager
  if (catalogManager) catalogManager.init({
    apiToken: CATALOG_API_TOKEN, catalogId: CATALOG_ID,
    getCatalogMap: function() { return catalogMap; },
    getPrices: function() { return catalogPrices; },
    getAvailability: function() { return catalogAvailability; },
    log: log,
  });
  // Init maps-geocode
  if (mapsGeocode) mapsGeocode.init({ log: log });
  // Init state-manager
  if (stateManager) stateManager.init({
    loadDraft: loadSbsrDraft, saveDraft: saveSbsrDraft, log: log,
  });
  // Init gsheet-sync
  if (gsheetSync) gsheetSync.init({
    toNum: toNum, fmtYmd: fmtYmd, nowJakartaDate: nowJakartaDate,
    normalizePhone08: normalizePhone08, pickNonEmpty: pickNonEmpty,
    openclawContainer: OPENCLAW_EXEC_CONTAINER,
  });
  // Init payment-engine
  if (paymentEngine) paymentEngine.init({
    log: log,
    sendMessage: sendWhatsAppMessage,
    sendImage: sendWhatsAppImage,
    notifyAdmin: notifySbsrAdminsText,
    loadDraft: loadSbsrDraft, saveDraft: saveSbsrDraft,
    openclawContainer: OPENCLAW_EXEC_CONTAINER,
    receiptBaseUrl: RECEIPT_BASE_URL,
  });
  _engineInited = true;
}

// ── handleMessage helpers ────────────────────────────────────────────
async function _guardMessage(from, messageId, msg) {
  // Dedup
  if (shouldDedupeMessageId(messageId)) {
    log('idempotent', 'dup message_id — skip: ' + String(messageId).slice(0, 28));
    return false;
  }
  // Killswitch
  if (SBSR_PAUSE && !_isAdminPhoneSec(from)) {
    try { await sendWhatsAppMessage(from, SBSR_PAUSE_TEXT); } catch (_) {}
    if (process.env.SBSR_OPS_ESCALATION_PHONE) {
      const _sample = (msg.text && msg.text.body) || "[non-text " + msg.type + "]";
      sendWhatsAppMessage(process.env.SBSR_OPS_ESCALATION_PHONE, "[PAUSE] " + from + ": " + String(_sample).slice(0, 200)).catch(() => {});
    }
    return false;
  }
  // Rate limit
  if (secLib && !_isAdminPhoneSec(from)) {
    try {
      const _rl = await secLib.rateLimiter.take(from, "msg");
      if (!_rl.ok) {
        const _min = Math.max(1, Math.ceil((_rl.retryAfterSec || 60) / 60));
        await sendWhatsAppMessage(from, "Pesannya kebanyakan ya Kak 🙏 Mintu balas pelan-pelan — coba lagi dalam ~" + _min + " menit");
        return false;
      }
    } catch (e) { console.error("[security] rate-limit err (fail-open):", e.message); }
  }
  // Stamp draft
  try {
    const _d = loadSbsrDraft(from) || { phone: from };
    saveSbsrDraft(from, { ..._d, last_inbound_at: new Date().toISOString() });
  } catch (_) {}
  return true;
}

function _notifyAdminOnMessage(from, contacts) {
  if (_isAdminPhoneSec(from)) return;
  const _now = Date.now();
  const _lastNotif = _adminNotifLastSent.get(from) || 0;
  if (_now - _lastNotif > 30 * 60 * 1000) {
    _adminNotifLastSent.set(from, _now);
    const _name = contacts?.[0]?.profile?.name || "";
    const _label = _name ? _name + " (+" + from + ")" : "+" + from;
    for (const _fin of getSbsrFinancePhones()) {
      sendWhatsAppMessage(_fin, "🔔 *Pesan Baru Masuk*\nDari: " + _label + "\n\nSegera cek panel admin:\nhttps://production.biks.ai/admin").catch(() => {});
    }
  }
}

async function handleMessage(msg, contacts) {
  const from = msg.from;
  const messageId = msg.id;
  const contactName = contacts?.[0]?.profile?.name || from;

  if (!await _guardMessage(from, messageId, msg)) return;
  _notifyAdminOnMessage(from, contacts);

  try {
    markAsRead(messageId).catch(() => {});
    let userText = "";
    if (msg.type === "text") {
      const _raw = msg.text.body || "";
      // === BIKS SECURITY: SANITIZE INBOUND TEXT ===
      if (secLib) {
        const _sec = secLib.sanitizeUserText(_raw);
        if (_sec.flags.length) {
          try {
            fs.appendFileSync(SECURITY_FLAGS_FILE,
              JSON.stringify({ ts: new Date().toISOString(), from, flags: _sec.flags, blocked: _sec.blocked, sample: String(_raw).slice(0, 200) }) + "\n");
          } catch (e) { console.error("[security] flag-log err:", e.message); }
          log("security", from + " " + secLib.summarizeFlags(_sec));
        }
        if (_sec.blocked) {
          try { await sendWhatsAppMessage(from, "Maaf Kak, pesannya nggak bisa diproses 🙏 coba kirim ulang ya"); } catch (_) {}
          return;
        }
        userText = _sec.clean;
      } else {
        userText = _raw;
      }
      // === END BIKS SECURITY ===
    }
    else if (msg.type === "audio" || msg.type === "voice") { await sendWhatsAppMessage(from, "Maaf, gw belum bisa proses voice message. Kirim text aja ya."); return; }
    else if (msg.type === "image") {
      const imgResult = await handleImageMessage(msg);
      if (imgResult.url) {
        // Run OCR at bridge level so bot can't hallucinate "link keblok"
        log("ocr-bridge", "Running OCR on " + imgResult.url);
        const ocr = await runReceiptOCR(imgResult.url, imgResult.imgbbUrl);
        const ocrBlock = formatOCRForBot(ocr);
        userText = "[Receipt/Image: " + imgResult.url + "]" + (imgResult.text ? "\nCaption: " + imgResult.text : "");
        if (ocrBlock) userText += "\n" + ocrBlock;
        log("ocr-bridge", "OCR " + (ocr ? "ok merchant=" + (ocr.merchant || "?") + " total=" + (ocr.total || "?") : "FAILED — bot will see image URL only"));
        try {
          if (!ocr) {
            if (await tryHandleBuktiOcrFailedManualReview(from, imgResult.url)) {
              log("intercept", "tryHandleBuktiOcrFailedManualReview " + from);
              sendReaction(from, messageId, "").catch(() => {});
              return;
            }
          }
        } catch (e) { log("sbsr-bukti", "ocr-failed intercept err: " + e.message); }
        try {
          if (await tryHandleBuktiAuto(from, ocr, imgResult.url)) {
            log("intercept", "tryHandleBuktiAuto " + from);
            log("sbsr-bukti", "Handled bukti deterministically, skipping LLM");
            sendReaction(from, messageId, "").catch(() => {});
            return;
          }
        } catch (e) { log("sbsr-bukti", "intercept err: " + e.message); }
      } else {
        userText = imgResult.text ? "[Image with caption: " + imgResult.text + "]" : "[Image received]";
        if (imgResult.error) userText += " (image processing failed: " + imgResult.error + ")";
      }
    }
    else if (msg.type === "document") userText = "[Document: " + (msg.document?.filename || "unknown") + "]";
    else if (msg.type === "location") {
      if (await tryHandleWhatsAppLocation(from, msg.location || {})) {
        sendReaction(from, messageId, "").catch(() => {});
        return;
      }
      userText = "[Location: " + msg.location?.latitude + ", " + msg.location?.longitude + "]";
    }
    else if (msg.type === "order") {
      // Handle WhatsApp catalog orders
      const orderItems = msg.order?.product_items || [];
      // Persist items+prices+subtotal directly to draft so addons (chili/tea/matcha)
      // are not silently dropped by the cart-sniff regex (which is Risol-only).
      // Without this, bukti-amount mismatches (root cause of yesterday's 262k vs 192k bug).
      const draftItems = orderItems.map((item, i) => {
        const name = lookupProductName(item.product_retailer_id) || "Item " + (i + 1);
        const qty = item.quantity || 1;
        const unit_price = item.item_price || 0;
        const isRisol = /^Risol/i.test(name);
        const pack_size = /12\s*pcs/i.test(name) ? 12 : (isRisol ? 6 : null);
        const form = /Frozen/i.test(name) ? "frozen" : (isRisol ? "goreng" : null);
        return { name, qty, unit_price, pack_size, form, sku: item.product_retailer_id };
      });
      let subtotal = draftItems.reduce((s, it) => s + (it.unit_price * it.qty), 0);
      try {
        const existing = loadSbsrDraft(from) || { phone: from };
        const _inAddMoreMode = !!existing.add_more_mode;
        const _oldItemsForMerge = Array.isArray(existing.items) ? existing.items : [];
        if (_inAddMoreMode) {
          const _byKey = new Map();
          const _push = (it) => {
            if (!it) return;
            const key = String(it.sku || it.name || '').trim().toLowerCase();
            const prev = _byKey.get(key);
            if (prev) {
              prev.qty = Number(prev.qty || 0) + Number(it.qty || 0);
              if (!prev.unit_price && it.unit_price) prev.unit_price = it.unit_price;
            } else {
              _byKey.set(key, { ...it, qty: Number(it.qty || 0) });
            }
          };
          _oldItemsForMerge.forEach(_push);
          draftItems.forEach(_push);
          const _merged = Array.from(_byKey.values());
          log("sbsr-cart-merge", "old_items=" + _oldItemsForMerge.length);
          log("sbsr-cart-merge", "new_items=" + draftItems.length);
          log("sbsr-cart-merge", "merged_items=" + _merged.length);
          draftItems.length = 0;
          _merged.forEach(it => draftItems.push(it));
          subtotal = draftItems.reduce((s, it) => s + ((Number(it.unit_price) || 0) * (Number(it.qty) || 0)), 0);
        }
        // --- Availability check: reject order if any item is out of stock ---
        const unavailableItems = [];
        for (const it of draftItems) {
          const avail = lookupProductAvailability(it.sku);
          if (avail && avail !== "in stock" && avail !== "available for order") {
            unavailableItems.push(it.name);
          }
        }
        if (unavailableItems.length > 0) {
          const itemList = unavailableItems.map(n => "\u2022 " + n).join("\n");
          await sendWhatsAppMessage(from,
            "Maaf Kak, produk berikut sedang tidak tersedia saat ini:\n\n" + itemList +
            "\n\nSilakan pilih menu lain dari katalog ya \uD83D\uDE4F"
          );
          sendWhatsAppCatalog(from).catch(function(){});
          return;
        }
        const priorTerminal = !!existing.invoice_sent_at
          || ["awaiting_invoice_confirm","awaiting_proof","pending_finance","approved","BOOKED","booked","delivered","cancelled"].includes(existing.state);
        // Decide whether to wipe prior state for the new catalog order.
        // Original logic only handled terminal states; 2026-05-07 QA found a bug
        // where a customer who abandoned a cart at "awaiting_address" 24h+ ago
        // got their old gmaps_link silently re-used for a new order (shipping
        // to wrong destination). draft-policy.cjs.shouldResetDraftForCatalogOrder
        // adds a stale-incomplete check on top. Falls back to legacy logic when
        // secLib didn't load.
        const _resetDecision = _inAddMoreMode
          ? { reset: false, reason: 'add-more-preserve' }
          : (secLib && secLib.draftPolicy
            ? secLib.draftPolicy.shouldResetDraftForCatalogOrder(existing)
            : { reset: !!existing.invoice_sent_at
                || ["awaiting_invoice_confirm","awaiting_proof","pending_finance","approved","BOOKED","booked","delivered","cancelled"].includes(existing.state),
                reason: 'fallback-legacy' });
        const freshStart = _resetDecision.reset ? {
          customer_name: null,
          customer_name_set_at: null,
          gmaps_link: null,
          gmaps_link_seen_at: null,
          destination: null,
          pending_address_text: null,
          pending_address_text_at: null,
          location_resolve_fails: 0,
          location_admin_notified_at: null,
          last_failed_url: null,
        } : {};
        if (_resetDecision.reset) {
          log("sbsr-catalog-persist", "fresh-start detected for " + from + " (reason=" + _resetDecision.reason + ", prior state=" + existing.state + ", invoice=" + !!existing.invoice_sent_at + ") — clearing name/url/destination");
        }
        const _existingUseCase = String(existing.use_case || "").trim().toLowerCase();
        const _hasFrozenInOrder = draftItems.some((it) => it && it.form === "frozen");
        const _inferredMode = inferCatalogProductMode(draftItems);
        if (_inferredMode === "goreng") log("sbsr-product-infer", "mode=goreng");
        if (_inferredMode === "frozen") log("sbsr-product-infer", "mode=frozen");
        if (_inferredMode === "mixed") log("sbsr-product-infer", "mode=mixed");
        const _inferredUseCase = _inferredMode === "goreng"
          ? "makan-langsung"
          : (_inferredMode === "frozen" ? "stock_frozen" : (_inferredMode === "mixed" ? "mixed_needs_clarification" : null));
        const _catalogPriority = String(existing.state || "").trim().toLowerCase() === "awaiting_usecase" && !!_inferredMode;
        const _nextStateAfterOrder = _catalogPriority
          ? (_inferredMode === "mixed" ? "awaiting_usecase" : "awaiting_addon_reply")
          : (!existing.use_case
              ? "awaiting_usecase"
              : ((_existingUseCase === "stock_frozen" && !_hasFrozenInOrder
                  ? "awaiting_product_selection"
                  : "awaiting_addon_reply")));
        saveSbsrDraft(from, {
          ...existing,
          items: draftItems,
          subtotal,
          cart_sniffed_at: new Date().toISOString(),
          catalog_order: true,
          state: _nextStateAfterOrder,
          ...( _catalogPriority ? {
            inferred_product_mode: _inferredMode,
            use_case: _inferredUseCase,
            use_case_source: "catalog_infer",
            use_case_set_at: new Date().toISOString(),
            awaiting_usecase: null,
            pending_usecase_prompt: null,
            pending_menu_prompt: null,
            menu_interrupt_pending: null,
            pending_use_case_reminder: null,
            pending_product_reminder: null,
            pending_frozen_reminder: null,
          } : {}),
          // reset prior-order state so deterministic flow re-fires:
          grand_total: null,
          expected_total: null,
          ongkir: null,
          courier: null,
          courier_label: null,
          courier_type: null,
          eta_text: null,
          frozen: null,
          quote_at: null,
          invoice_sent_at: null,
          payment_sent_at: null,
          payment_order_key: null,
          qris_sent_for_order_key: null,
          add_more_mode: null,
          awaiting_add_more_confirm: null,
          bukti_url: null,
          bukti_amount: null,
          bukti_bank: null,
          bukti_mismatch_at: null,
          pending_bridge_context: null,
          last_escalation_turn: null,
          ...freshStart,
        });
        log("sbsr-catalog-persist", "saved " + draftItems.length + " items for " + from + " subtotal=" + subtotal + (priorTerminal ? " (fresh-start reset)" : " (state reset)"));
        if (_inAddMoreMode) log("sbsr-invoice", "invalidated_due_add_more");
        if (_catalogPriority) {
          log("sbsr-catalog-order", "cancel_usecase_prompt");
          if (_inferredUseCase) log("sbsr-usecase", "inferred_from_catalog=" + _inferredUseCase);
          log("sbsr-router", "catalog_selection_priority=true");
          log("sbsr-router", "skip_stale_usecase_prompt");
        }
      } catch (e) { log("sbsr-catalog-persist", "save err: " + e.message); }

      // #4 SBSR_CART_V2 — when cart changes mid-flow with destination already resolved,
      // deterministically re-quote + re-invoice. Skips LLM round-trip, prevents stale totals.
      // Default OFF (env unset) — flip SBSR_CART_V2=true to enable.
      if (process.env.SBSR_CART_V2 === 'true') {
        try {
          const updated = loadSbsrDraft(from);
          if (updated?.customer_name && updated?.destination?.gmaps_link && Array.isArray(updated.items) && updated.items.length > 0) {
            const syntheticText = [
              updated.customer_name,
              updated.destination.address_text || "(alamat dari pin)",
              updated.destination.gmaps_link,
            ].join("\n");
            log("sbsr-cart-v2", "auto-requote fire for " + from + " (cart=" + updated.items.length + " items, dest known)");
            const handled = await tryHandleAddressAndQuote(from, syntheticText).catch(e => {
              log("sbsr-cart-v2", "tryHandleAddressAndQuote err: " + e.message); return false;
            });
            if (handled) {
              log("sbsr-cart-v2", "auto-requote handled for " + from + ", skipping LLM");
              sendReaction(from, messageId, "").catch(() => {});
              return; // deterministic path took over
            }
            log("sbsr-cart-v2", "auto-requote did not handle, falling through to LLM");
          }
        } catch (e) { log("sbsr-cart-v2", "err: " + e.message); }
      }

      const itemLines = draftItems.map(it => it.name + " x" + it.qty + " (Rp" + (it.unit_price || 0).toLocaleString("id-ID") + ")").join(", ");
      log("order", "Catalog order from " + from + ": " + itemLines + " subtotal=" + subtotal);
      try {
        const existing = loadSbsrDraft(from) || { phone: from };
        const latestDraft = loadSbsrDraft(from) || {
          phone: from,
          items: draftItems,
          subtotal,
          state: !existing.use_case
            ? "awaiting_usecase"
            : ((String(existing.use_case || "").trim().toLowerCase() === "stock_frozen" && !draftItems.some((it) => it && it.form === "frozen")
                ? "awaiting_product_selection"
                : "awaiting_addon_reply")),
        };
        if (existing.use_case) {
          const existingUseCase = String(existing.use_case || "").trim().toLowerCase();
          const hasFrozenInOrder = Array.isArray(latestDraft.items) && latestDraft.items.some((it) => it && it.form === "frozen");
          if (existingUseCase === "stock_frozen" && !hasFrozenInOrder) {
            await sendWhatsAppMessage(from, "Untuk stock frozen, pilih dulu item frozen/mix frozen dari katalog ya Kak 🤍");
          } else {
            await sendSbsrAddonOffer(from, latestDraft);
            log("sbsr-addon", "offer_after_product_selection");
          }
        } else {
          const inferredMode = String(latestDraft.inferred_product_mode || "");
          if (inferredMode) {
            log("sbsr-catalog-order", "cancel_usecase_prompt");
            log("sbsr-router", "catalog_selection_priority=true");
            log("sbsr-router", "skip_stale_usecase_prompt");
            if (inferredMode === "mixed" || String(latestDraft.use_case || "") === "mixed_needs_clarification") {
              await sendWhatsAppMessage(from, "Kak, ini untuk langsung disantap, stock frozen, meeting/acara, atau gift/hampers ya?");
            } else {
              await sendSbsrAddonOffer(from, latestDraft);
              log("sbsr-addon", "offer_after_product_selection");
            }
          } else {
            // No use_case and no inferred mode — check if already waiting
            var _prevState = String(existing.state || "").trim().toLowerCase();
            if (_prevState === "awaiting_usecase") {
              // Customer already saw use-case prompt, now picked from catalog.
              // Skip use-case: auto-set to "makan-langsung" and go straight to addon
              var _autoUseCase = "makan-langsung";
              var _hasFrozenInCart = Array.isArray(latestDraft.items) && latestDraft.items.some(function(it) { return it && it.form === "frozen"; });
              var _nextDraft = { ...latestDraft, use_case: _autoUseCase, use_case_source: "auto_from_catalog", use_case_set_at: new Date().toISOString() };
              saveSbsrDraft(from, _nextDraft);
              log("sbsr-catalog-order", "no_use_case_but_awaiting — auto use_case=" + _autoUseCase + " → addon");
              await sendSbsrAddonOffer(from, _nextDraft);
              log("sbsr-addon", "offer_after_auto_use_case");
            } else {
              // Fresh start — send confirmation + use-case prompt
              var _itemSummary = (latestDraft.items || []).map(function(it) {
                return (it.name || "item") + " x" + (it.qty || 1);
              }).join(", ");
              await sendWhatsAppMessage(from, "Mintu catat ya Kak: " + _itemSummary + " \u{1f90d}\n\n" +
                "Untuk kebutuhan apa nih pesanannya?\n" +
                "1. Makan langsung\n2. Stock frozen\n3. Meeting/acara\n4. Gift/hampers");
              log("sbsr-catalog-order", "no_use_case_fresh — sent confirmation + use-case");
            }
            log("sbsr-order-flow", "waiting_usecase");
            var _coCtx = "Customer baru pilih dari katalog. " +
              "Kamu SUDAH tanya use-case (1-4). TUNGGU customer pilih. JANGAN tanya lagi.";
            setPendingBridgeContext(from, _coCtx);
          }
        }
        sendReaction(from, messageId, "").catch(() => {});
        return;
      } catch (e) {
        log("sbsr-order-flow", "usecase prompt send err: " + e.message);
      }
    }
    else if (msg.type === "interactive") {
      // Handle interactive message replies (list selections, buttons)
      if (msg.interactive?.type === "list_reply") {
        // Send both title and ID so SOUL can map either format
        const listId = msg.interactive.list_reply.id || "";
        const listTitle = msg.interactive.list_reply.title || listId;
        userText = listTitle + (listId && listId !== listTitle ? " [" + listId + "]" : "");
      } else if (msg.interactive?.type === "button_reply") {
        const btnId = msg.interactive.button_reply.id || "";
        const btnTitle = msg.interactive.button_reply.title || btnId;
        // SBSR Finance dropdown — synthesize "<verb> <suffix>" so tryHandleAdminCmd matches
        const finBtn = btnId.match(/^sbsr_(approve|reject)_(\d{4,})$/);
        if (finBtn) {
          userText = finBtn[1].toUpperCase() + " " + finBtn[2];
        } else {
          userText = btnTitle;
        }
      } else if (msg.interactive?.type === "product_list_reply") {
        userText = "[Customer selected product from list]";
      } else {
        userText = "[Interactive: " + (msg.interactive?.type || "unknown") + "]";
      }
    }
    else if (msg.type === "sticker") userText = "[Sticker received]";
    else if (msg.type === "reaction") return;
    else userText = "[" + msg.type + " message received]";

    if (!userText) return;
    log("msg", contactName + " (" + from + "): " + userText);
    safeLog(admin.logIncoming, from, userText || ("[" + msg.type + "]"), contactName);
    // Admin pause: silent drop before typing + interceptors.
    // Admin panel resume → isPaused=false → bot responds again.
    if (admin && typeof admin.isPaused === "function" && admin.isPaused(from)) {
      return;
    }

    sendTypingIndicator(from, messageId).catch(() => {});
    // Admin/Finance/Kitchen number lockdown (per user request 2026-05-05).
    // +6285741844938 (in SBSR_FINANCE_PHONES) is admin-only — never a customer.
    // Run admin-cmd intercept (APPROVE/REJECT/slash). Anything else from this number
    // is silently dropped: no LLM, no catalog, no cart-sniff, no auto-quote, no bukti.
    // Use a separate test number for customer-side demos (e.g. +4915204107177).
    if (ADMIN_PHONES.includes(from)) {
      // ── Classifier toggle (live, no restart) ──────────────────
      const _cfToggle = String(userText || "").trim().toLowerCase();
      if (_cfToggle === "/classifier_on") {
        sbsrLlmClassifierEnabled = true;
        log("llm-classifier", "ENABLED by admin " + from);
        await sendWhatsAppMessage(from, "Classifier ON \u{1f7e2} — LLM akan klasifikasi intent customer.");
        sendReaction(from, messageId, "").catch(() => {});
        return;
      }
      if (_cfToggle === "/classifier_off") {
        sbsrLlmClassifierEnabled = false;
        log("llm-classifier", "DISABLED by admin " + from);
        await sendWhatsAppMessage(from, "Classifier OFF \u{1f534} — fallback ke regex pipeline.");
        sendReaction(from, messageId, "").catch(() => {});
        return;
      }
      if (_cfToggle === "/classifier_status") {
        await sendWhatsAppMessage(from, "Classifier: " + (sbsrLlmClassifierEnabled ? "ON \u{1f7e2}" : "OFF \u{1f534}"));
        sendReaction(from, messageId, "").catch(() => {});
        return;
      }
      // ── End classifier toggle ────────────────────────────────
      try {
        if (await tryHandleAdminCmd(from, userText)) {
          log("intercept", "tryHandleAdminCmd " + from);
          sendReaction(from, messageId, "").catch(() => {});
          log("sbsr-admin-lockdown", "admin cmd handled");
          return;
        }
      } catch (e) { log("sbsr-admin-lockdown", "admin-cmd err: " + e.message); }
      try {
        if (await tryHandleKitchenReady(from, userText)) {
          log("intercept", "tryHandleKitchenReady " + from);
          sendReaction(from, messageId, "").catch(() => {});
          log("sbsr-admin-lockdown", "kitchen ready ack handled");
          return;
        }
      } catch (e) { log("sbsr-admin-lockdown", "kitchen-ready err: " + e.message); }
      log("sbsr-admin-lockdown", "admin non-cmd falls through: " + userText.slice(0, 80));
      // Not an admin command - let through to customer flow
    }

    // Bridge-level handlers (run BEFORE LLM to avoid hallucinated tool calls)
    // Greeting/menu intercept must stay first so simple salutations never fall
    // through to OpenClaw, Qdrant-era retrieval layers, OCR, or approval flows.
    if (msg.type === "text") {
      const _preDraftForMenu = loadSbsrDraft(from) || {};
      const _activeCheckoutForMenu = isSbsrCheckoutCollectionActive(_preDraftForMenu);
      const _preStateForMenu = String(_preDraftForMenu.state || "").trim().toLowerCase();
      let _cfRan = false; // true kalau classifier udah sukses analisis (skip isRestartIntent)
      // ── Pipeline v2 (sole handler for ALL text messages) ──────────
      try { _initEngine(); } catch (_) {}
      try {
        var _v2ctx = engineCtx ? engineCtx.createContext({
          from: from, messageId: messageId, contactName: contactName,
          rawText: userText, msgType: msg.type, rawMsg: msg,
        }) : null;
        if (_v2ctx && enginePipeline) {
          await enginePipeline.runPipeline(_v2ctx);
        }
        sendReaction(from, messageId, "").catch(function(){});
        return; // pipeline is the sole handler
      } catch (_pipelineErr) {
        log("pipeline", "fatal: " + (_pipelineErr && _pipelineErr.message || "?"));
        sendReaction(from, messageId, "").catch(function(){});
        return;
      }
    }
    // === DELIVERY CONFIRMATION INTERCEPT ===
    if (await tryHandleDeliveryConfirm(from, userText)) {
      log("intercept", "tryHandleDeliveryConfirm " + from);
      sendReaction(from, messageId, "").catch(() => {});
      return;
    }
    // INTERACTIVE BUTTON HANDLER: "ya_lanjut" → transition to delivery method
    if (msg.type === "interactive" && msg.interactive && msg.interactive.button_reply) {
      const _btnId = msg.interactive.button_reply.id;
      if (_btnId === "ya_lanjut") {
        const _bd = loadSbsrDraft(from) || {};
        const _bItems = (Array.isArray(_bd.items) && _bd.items.length > 0) || (_bd.cart && Array.isArray(_bd.cart.items) && _bd.cart.items.length > 0);
        if (_bItems) {
          saveSbsrDraft(from, { ..._bd, state: "awaiting_delivery_method" });
          await sendSbsrDeliveryMethodButtons(from);
          log("sbsr-interactive", "ya_lanjut -> delivery_method");
          sendReaction(from, messageId, "").catch(() => {});
          return;
        }
        // No items in draft — try pending_items (from classifier) or summary
        let _pendingItems = Array.isArray(_bd.pending_items) ? _bd.pending_items : [];
        const _summary = _bd.pending_order_summary || '';
        if (_pendingItems.length > 0 || _summary) {
          const _form = String(_bd.use_case || "").includes("frozen") ? 'frozen' : 'goreng';
          let _built;
          if (_pendingItems.length > 0) {
            _built = buildItemsFromPending(_pendingItems, _form);
            log('sbsr-interactive', 'ya_lanjut -> ' + _built.items.length + ' items subtotal=' + _built.subtotal + ' from pending_items');
          } else {
            const _priceM = _summary.match(/Rp\s*([\d.]+)/);
            const _price = _priceM ? parseInt(_priceM[1].replace(/\./g, ''), 10) : 0;
            const _summaryHead = _summary.split(/\b(?:Harga|price|list|Rp\s*\d)/i)[0];
            const _mixM = _summaryHead.match(/Mix\s+(\d+)\s*pcs/i);
            let _pack = 6;
            if (_mixM) { _pack = parseInt(_mixM[1], 10); } else {
              const _pcsRe = /(\d+)\s*pcs/gi; let _t = 0, _m;
              while ((_m = _pcsRe.exec(_summaryHead)) !== null) _t += parseInt(_m[1], 10);
              _pack = _t > 0 ? _t : 6;
            }
            _built = { items: [{name:'Risol ' + (_form==='frozen'?'Frozen':'Goreng') + ' — Mix '+_pack+'pcs', qty:1, pack_size:_pack, unit_price:_price, form:_form}], subtotal:_price, pack:_pack };
          }
          saveSbsrDraft(from, { ..._bd, items: _built.items, subtotal: _built.subtotal, pending_order_summary:null, pending_items:null, state:'awaiting_delivery_method' });
          log('sbsr-interactive', 'ya_lanjut -> created draft items=' + _built.items.length + ' subtotal=' + _built.subtotal);
          await sendSbsrDeliveryMethodButtons(from);
          sendReaction(from, messageId, '').catch(() => {});
          return;
        }
        // No summary either — fall through to LLM
        log('sbsr-interactive', 'ya_lanjut -> no_items_no_summary, falling through');
      }
      if (_btnId === "tidak") {
        log("sbsr-interactive", "tidak button — letting LLM handle");
        // Fall through to LLM
      }
    }
    // ORDER: IG approval first — pending-state context makes intent unambiguous, and the LLM
    // hallucinates "NO" if it gets the message instead.
    try { sniffMapsLinkFromCustomer(from, userText); } catch (e) { log("sbsr-maps-sniff", "err: " + e.message); }
    try {
      const _routerDraft = loadSbsrDraft(from) || {};
      let _routerState = sbsrRouterStateLabel(_routerDraft);
      const _trimText = String(userText || "").trim();
      sbsrRouterLogState(_routerState);

      // === GLOBAL QUESTION INTERCEPTOR ===
      // Catches questions in ANY checkout state BEFORE state-specific handlers.
      if (SBSR_OUT_OF_CONTEXT_STATES.has(_routerState) && _trimText.length >= 4) {
        var _qi_isQuestion = /\?/.test(_trimText)
          || /^(?:apa|siapa|kenapa|bagaimana|berapa|kapan|dimana|bisa|boleh|apakah|ada|info|tanya)/i.test(_trimText)
          || /(?:tanya|isi\w*\s+apa|varian\s+apa|rekomendasi|recommend|halal|promo|cara|beda|enak\s+gak|enak\s+nggak|tahan\s+berapa|minimal|min\s+order|best\s+seller|menu\s+apa)/i.test(_trimText)
          || /(?:gak\s*\?|nggak\s*\?|kan\s*\?|ya\s*\?|dong\s*\?)$/i.test(_trimText)
          || /^(?:saya|aku|gue|gw)\s+(?:ingin|mau|butuh|tanya|liat|lihat|cek|tahu)\b/i.test(_trimText)
          || /\b(?:total|semua|list|daftar|rincian|detail|isi\s+pesanan|pesanan\s+saya)\b/i.test(_trimText);
        if (_qi_isQuestion) {
                    log("sbsr-router", "global_question_intercept state=" + _routerState + " text=" + _trimText.slice(0, 60));
          // === MISSING-FORM GUARD: check before routing to LLM ===
          if (await tryHandleMissingFormInquiry(from, _trimText)) {
            log("sbsr-router", "global_question_missing_form state=" + _routerState);
            sendReaction(from, messageId, "").catch(() => {});
            return;
          }
          if (await tryHandleMissingFormClarification(from, _trimText)) {
            log("sbsr-router", "global_question_missing_form_clarification state=" + _routerState);
            sendReaction(from, messageId, "").catch(() => {});
            return;
          }
          // === END MISSING-FORM GUARD ===
          if (await tryHandleOocDuringCheckout(from, _trimText, _routerDraft, _routerState)) {
            log("sbsr-router", "global_question_handled state=" + _routerState);
            sendReaction(from, messageId, "").catch(() => {});
            return;
          }
          log("sbsr-router", "global_question_llm_failed state=" + _routerState + " — falling through to normal router");
        }
      }
      // === END GLOBAL QUESTION INTERCEPTOR ===

      // === LLM-FIRST SOPIR: LLM drives ALL checkout conversation ===
      // Deterministic rails become fallback + critical validators only

      // GLOBAL LANJUT INTENT: customer accepts "mau lanjut pesan?" -> transition to next step
      const _acceptLanjut = /^(?:ya|iya|ok|oke|lanjut|siap|deal|boleh|mau|yes|yuk|gas|go)(?:\s+(?:lanjut|pesan|order|aja|deh|dong|kak|ya))*$/i.test(_trimText);
      const _hasItems = (_routerDraft && Array.isArray(_routerDraft.items) && _routerDraft.items.length > 0) || (_routerDraft && _routerDraft.cart && Array.isArray(_routerDraft.cart.items) && _routerDraft.cart.items.length > 0);
      const _hasPendingItems = Array.isArray(_routerDraft?.pending_items) && _routerDraft.pending_items.length > 0;
      const _needsDelivery = !_routerDraft.delivery_mode;
      if (_acceptLanjut && _needsDelivery && (_hasItems || _hasPendingItems)) {
        // If only pending_items (natural reply flow), create real items first
        let _updDraft = _routerDraft;
        if (!_hasItems && _hasPendingItems) {
          const _form = String(_routerDraft.use_case || "").includes("frozen") ? "frozen" : "goreng";
          const _built = buildItemsFromPending(_routerDraft.pending_items, _form);
          _updDraft = { ..._routerDraft, items: _built.items, subtotal: _built.subtotal, pending_items:null, pending_order_summary:null };
          log("sbsr-lanjut", "created_items_from_pending count=" + _built.items.length + " subtotal=" + _built.subtotal);
        }
        saveSbsrDraft(from, { ..._updDraft, state: "awaiting_delivery_method" });
        await sendSbsrDeliveryMethodButtons(from);
        log("sbsr-lanjut", "accepted -> delivery_method");
        sbsrRouterLogRail("lanjut-accept");
        sendReaction(from, messageId, "").catch(() => {});
        return;
      }

      if (isCheckoutActiveState(_routerState) && _trimText.length >= 2) {
        // Skip states that should ALWAYS be deterministic (no LLM needed)
        const _skipStates = ["awaiting_name", "awaiting_address", "awaiting_pin_confirm", "awaiting_address_pin_confirm"];
        const _isDeterministicOnly = _skipStates.includes(_routerState);
        // Skip structured single-token inputs that deterministic should handle
        const _structuredInput = /^(?:1|2|3|4|ya|iya|tidak|gak|nggak|ok|oke|lanjut|sudah|siap|deal|yes|no|batal|cancel|reset|delivery|pickup)$/i.test(_trimText);
        // Skip maps URLs (deterministic pin handler)
        const _isMapsUrl = /^https?:\/\/.*(?:google\.com\/maps|maps\.google|goo\.gl\/maps|maps\.app\.goo\.gl)/i.test(_trimText);
        // Skip interactive list replies (deterministic variant selection)
        const _isInteractiveReply = _trimText.length <= 3 && /^\d+$/.test(_trimText) && _routerState === "awaiting_product_selection";
      // === ADD-MORE DETECTION: detect "tambah"/"nambah" in any checkout state ===
      if (await tryHandleGlobalAddMore(from, _trimText)) {
        sbsrRouterLogRail("llm-sopir-add-more");
        sendReaction(from, messageId, "").catch(() => {});
        return;
      }
      // === END ADD-MORE DETECTION ===
        if (!_structuredInput && !_isMapsUrl && !_isInteractiveReply && !_isDeterministicOnly) {
          // === MISSING-FORM CLARIFICATION: re-parse after form clarified ===
          if (await tryHandleMissingFormClarification(from, _trimText)) {
            sbsrRouterLogRail("llm-sopir-missing-form-clarification");
            sendReaction(from, messageId, "").catch(() => {});
            return;
          }
          // === END MISSING-FORM CLARIFICATION ===
          const _sopirHandled = await tryHandleOocDuringCheckout(from, _trimText, _routerDraft, _routerState);
          if (_sopirHandled) {
            sbsrRouterLogRail("llm-sopir");
            sendReaction(from, messageId, "").catch(() => {});
            return;
          }
          log("sbsr-llm-sopir", "llm_failed state=" + _routerState + " — fallthrough to deterministic rails");
        }
      }
      // === END LLM-FIRST SOPIR ===

      // PRIORITY MATRIX: state-locked rails first to prevent cross-rail leakage.
      if (_routerState === "awaiting_question") {
        if (await tryHandleAwaitingQuestionFlow(from, userText)) {
          sbsrRouterLogRail("awaiting_question");
          sendReaction(from, messageId, "").catch(() => {});
          return;
        }
        sbsrRouterLogSkipped("awaiting_question");
      }

      if (_routerState === "awaiting_usecase") {
        if (await tryHandlePickupFlow(from, userText)) {
          sbsrRouterLogRail("pickup-intent");
          sendReaction(from, messageId, "").catch(() => {});
          return;
        }
        sbsrRouterLogSkipped("pickup-intent");
        if (await tryHandleFaq(from, userText)) {
          sbsrRouterLogRail("faq-deterministic");
          sendReaction(from, messageId, "").catch(() => {});
          return;
        }
        sbsrRouterLogSkipped("faq-deterministic");
        if (await tryHandleUseCaseRouter(from, userText)) {
          sbsrRouterLogRail("awaiting_usecase");
          sendReaction(from, messageId, "").catch(() => {});
          return;
        }
        sbsrRouterLogSkipped("awaiting_usecase");
        // Re-check: tryHandleUseCaseRouter may have transitioned state to product_selection
        var _newState = sbsrRouterStateLabel(loadSbsrDraft(from) || {});
        if (_newState === "awaiting_product_selection") {
          _routerState = "awaiting_product_selection";
          log("sbsr-router", "state_reassigned_to_awaiting_product_selection");
        }
        if (/^\s*[1-4](?:[.)\s].*)?\s*$/i.test(_trimText)) {
          await sendWhatsAppMessage(from, buildSbsrUseCasePromptText());
          sendWhatsAppCatalog(from).catch(function(){});
          sbsrRouterLogRail("awaiting_usecase-reminder");
          sendReaction(from, messageId, "").catch(() => {});
          return;
        }
        // Edge case — LLM handle natural language in awaiting_usecase
        setPendingBridgeContext(from, [
          "STATE: awaiting_usecase — customer belum pilih use case.",
          "Customer barusan dikirimin pilihan: 1) makan langsung, 2) stock frozen, 3) meeting/acara, 4) gift/hampers.",
          "Tugas kamu: bantu customer pilih use case sesuai kebutuhan mereka.",
          "JANGAN ngarang harga atau varian produk.",
          "Kalau customer minta menu/katalog, arahkan balas 1 untuk lihat menu.",
          "Kalau customer ngomong di luar konteks, arahkan balik ke 4 pilihan use case.",
        ].join("\n"));
      }

      if (_routerState === "awaiting_addon_reply" || _routerState === "awaiting_addon_signature_clarify") {
        if (await tryHandlePickupFlow(from, userText)) {
          sbsrRouterLogRail("pickup-intent");
          sendReaction(from, messageId, "").catch(() => {});
          return;
        }
        sbsrRouterLogSkipped("pickup-intent");
        if (await tryHandleFaq(from, userText)) {
          sbsrRouterLogRail("faq-deterministic");
          sendReaction(from, messageId, "").catch(() => {});
          return;
        }
        sbsrRouterLogSkipped("faq-deterministic");
        if (await tryHandleAddonReply(from, userText)) {
          sbsrRouterLogRail("awaiting_addon_reply");
          sendReaction(from, messageId, "").catch(() => {});
          return;
        }
        sbsrRouterLogSkipped("awaiting_addon_reply");
        // Fall through to global interceptors — let OOC/LLM handle instead of canned reminder
        log("sbsr-addon", "fallthrough_to_global for " + from);
      }

      if (_routerState === "awaiting_delivery_method") {
        if (await tryHandleDeliveryMethodSelection(from, userText)) {
          sbsrRouterLogRail("awaiting_delivery_method");
          sendReaction(from, messageId, "").catch(() => {});
          return;
        }
        sbsrRouterLogSkipped("awaiting_delivery_method");
        // Deterministic add-more intercept: "tambah lagi" / "mau nambah" reopen catalog
        const _DM_ADD_MORE_RE = /^(?:mau\s+tambah\s+lagi|tambah\s+lagi|mau\s+tambah|mau\s+nambah|nambah\s+lagi|tambah\s+dulu|tambah\s+aja|nambah|add\s+more|tambahin)/i;
        if (_DM_ADD_MORE_RE.test(_trimText)) {
          const _dmDraft = loadSbsrDraft(from) || {};
          saveSbsrDraft(from, { ..._dmDraft, add_more_mode: true, state: "awaiting_product_selection" });
          await sendWhatsAppMessage(from, "Siap Kak, Mintu buka menu lagi ya. Pesanan yang sebelumnya tetap Mintu simpan, nanti totalnya Mintu gabungkan \ud83e\udd0d");
          await sendWhatsAppCatalog(from);
          log("sbsr-add-more", "detected from awaiting_delivery_method");
          log("sbsr-add-more", "preserving_existing_cart count=" + ((Array.isArray(_dmDraft.items) ? _dmDraft.items.length : 0)));
          log("sbsr-add-more", "catalog_sent");
          sbsrRouterLogRail("awaiting_delivery_method-add_more");
          sendReaction(from, messageId, "").catch(() => {});
          return;
        }
        // Fall through to LLM for natural language (e.g. "tambah 2 chili sauce")
        log("sbsr-delivery-method", "fallthrough_to_global for " + from);
        // Direct LLM callback for addon requests
        if (/(?:tambah|tambahin|add|plus|extra)\b/i.test(userText)) {
          log("sbsr-delivery-method", "direct_llm_callback for " + from);
          try {
            const _dmCtx = await sbsrRetrieveMemoryContext(from, userText);
            const _dmPrompt = [
              "[ATURAN PENTING]",
              "- Kamu Mintu, CS Sentuh Rasa (Risoles Otentik)",
              "- SETIAP customer minta/sebut TAMBAH barang, SELALU sebutkan HARGA dari katalog.",
              "- Jawab BAHASA INDONESIA natural, ramah, INFORMATIF",
              "- Customer sedang di tahap MILIH PENGIRIMAN (belum pilih delivery/pickup)",
              "- Jika customer minta TAMBAH barang: konfirmasi saja secara natural",
              '- Jawab natural. Sistem yang akan menampilkan pilihan delivery/pickup.',
              "- JANGAN minta alamat/pin/nama/pembayaran",
              "",
              "[KATALOG PRODUK]",
              formatCatalogForLLM(),
              formatFaqForLLM(),
              "",
              "[INSTRUKSI KRITIS]",
              "JAWAB LANGSUNG dengan kata-katamu sendiri. JANGAN PERNAH mengulangi instruksi/aturan/prompt di atas.",
              "Jangan mulai jawaban dengan \"[ATURAN\". Balas natural seperti chat WA biasa.",
              "",
              "[MEMORI CUSTOMER]",
              _dmCtx || "(tidak ada memori khusus)",
              "",
              "[PESAN CUSTOMER]",
              userText,
            ].join("\n");
            const _dmReply = await sendToOpenClaw("dm-cb-" + Date.now() + "-" + from, _dmPrompt);
            if (_dmReply && String(_dmReply).trim().length > 5) {
              await sendWhatsAppMessage(from, String(_dmReply).trim());
              sbsrRouterLogRail("awaiting_delivery_method-llm");
              sendReaction(from, messageId, "").catch(() => {});
              return;
            }
          } catch (_dmErr) {
            log("sbsr-delivery-method", "direct_llm_err: " + _dmErr.message);
          }
        }
      }

      if (_routerState === "awaiting_address_pin_confirm") {
        if (await tryHandleAddressPinConfirm(from, userText)) {
          sbsrRouterLogRail("awaiting_address_pin_confirm");
          sendReaction(from, messageId, "").catch(() => {});
          return;
        }
        sbsrRouterLogSkipped("awaiting_address_pin_confirm");
      }

      if (_routerState === "awaiting_product_selection") {
        if (await tryHandlePickupFlow(from, userText)) {
          sbsrRouterLogRail("pickup-intent");
          sendReaction(from, messageId, "").catch(() => {});
          return;
        }
        sbsrRouterLogSkipped("pickup-intent");
        if (await tryHandleFaq(from, userText)) {
          sbsrRouterLogRail("faq-deterministic");
          sendReaction(from, messageId, "").catch(() => {});
          return;
        }
        sbsrRouterLogSkipped("faq-deterministic");
        if (await tryHandleCatalogRequest(from, userText)) {
          sbsrRouterLogRail("product-catalog-selection");
          sendReaction(from, messageId, "").catch(() => {});
          return;
        }
        if (await tryHandleTextVariantSelection(from, userText)) {
          sbsrRouterLogRail("product-text-variant-selection");
          sendReaction(from, messageId, "").catch(() => {});
          return;
        }

        if (await tryHandleMissingFormInquiry(from, userText)) {
          sbsrRouterLogRail("product-missing-form-inquiry");
          sendReaction(from, messageId, "").catch(() => {});
          return;
        }
        if (await tryHandleMissingFormClarification(from, userText)) {
          sbsrRouterLogRail("product-missing-form-clarification");
          sendReaction(from, messageId, "").catch(() => {});
          return;
        }
        if (await tryHandleFreeTextOrder(from, userText)) {
          sbsrRouterLogRail("product-free-text-selection");
          sendReaction(from, messageId, "").catch(() => {});
          return;
        }
        sbsrRouterLogSkipped("product-selection");
        if (SBSR_PRODUCT_SELECTION_INTENT_RE.test(_trimText)) {
          log("sbsr-product-selection", "detected=" + _trimText.slice(0, 80));
          log("sbsr-product-selection", "waiting_catalog_selection");
          await sendWhatsAppMessage(from, "Siap Kak, pilih dulu produknya dari katalog ya 🤍\nKalau mau *frozen* atau *goreng*, tinggal pilih variannya langsung di katalog.");
          sbsrRouterLogRail("awaiting_product_selection-reminder");
          sendReaction(from, messageId, "").catch(() => {});
          return;
        }
        if (/^\s*[1-9]\d*\s*$/.test(_trimText)) {
          await sendWhatsAppMessage(from, "Kak, sebelum pilih jumlah, pilih dulu varian produknya dari katalog/menu ya 🤍");
          sbsrRouterLogRail("qty-selection-reminder");
          sendReaction(from, messageId, "").catch(() => {});
          return;
        }
        // LLM fallback: unrecognized text in awaiting_product_selection
        // Let Mintu (OpenClaw) answer naturally (e.g. "risoles original" → explains available variants)
        // Fail-open: any error → reminder message unchanged
        let _psLlmHandled = false;
        try {
          const _psFallbackReply = await sendToOpenClaw(from, userText);
          if (_psFallbackReply && String(_psFallbackReply).trim()) {
            await sendWhatsAppMessage(from, String(_psFallbackReply).trim());
            sbsrRouterLogRail("awaiting_product_selection-openclaw");
            sendReaction(from, messageId, "").catch(() => {});
            _psLlmHandled = true;
          }
        } catch (_psLlmErr) {
          log("sbsr-product-selection", "llm_fallback_err=" + _psLlmErr.message);
        }
        if (!_psLlmHandled) {
          await sendWhatsAppMessage(from, "Kak, pilih dulu produknya dari katalog/menu ya. Setelah itu baru lanjut jumlah dan checkout 🤍");
          sbsrRouterLogRail("awaiting_product_selection-reminder");
          sendReaction(from, messageId, "").catch(() => {});
        }
        return;
      }

      if (_routerState === "awaiting_meeting_package_confirm") {
        if (await tryHandleMeetingPackageConfirm(from, userText)) {
          sbsrRouterLogRail("awaiting_meeting_package_confirm");
          sendReaction(from, messageId, "").catch(() => {});
          return;
        }
        sbsrRouterLogSkipped("awaiting_meeting_package_confirm");
        // Edge case — LLM handle natural language in awaiting_meeting_package_confirm
        setPendingBridgeContext(from, [
          "STATE: awaiting_meeting_package_confirm — customer ditawarin paket meeting.",
          "Tugas kamu: bantu customer konfirmasi apakah setuju paket meeting atau mau diskusi.",
          "Kalau setuju → suruh balas ya/ok/lanjut.",
          "Kalau nanya detail → jawab natural, JANGAN ngarang harga.",
          "Kalau di luar konteks → arahkan balik ke konfirmasi paket meeting.",
        ].join("\n"));
      }

      if (_routerState === "awaiting_courier_choice") {
        if (await tryHandleFrozenCourierChoice(from, userText)) {
          sbsrRouterLogRail("awaiting_courier_choice");
          sendReaction(from, messageId, "").catch(() => {});
          return;
        }
        sbsrRouterLogSkipped("awaiting_courier_choice");
      }

      if (await tryHandleIgApproval(from, userText)) {
        log("intercept", "tryHandleIgApproval " + from);
        sendReaction(from, messageId, "").catch(() => {});
        log("ig-bridge", "Handled IG APPROVE/CANCEL (priority), skipping LLM");
        return;
      }
      if (await tryHandleSaldo(from, userText)) {
        log("intercept", "tryHandleSaldo " + from);
        sendReaction(from, messageId, "").catch(() => {});
        log("saldo-bridge", "Handled SALDO, skipping LLM");
        return;
      }
      if (await tryHandlePOCreate(from, userText)) {
        log("intercept", "tryHandlePOCreate " + from);
        sendReaction(from, messageId, "").catch(() => {});
        log("po-bridge", "Handled PO CREATE, skipping LLM");
        return;
      }
      if (await tryHandlePOApproval(from, userText)) {
        log("intercept", "tryHandlePOApproval " + from);
        sendReaction(from, messageId, "").catch(() => {});
        log("po-bridge", "Handled PO APPROVE/CANCEL, skipping LLM");
        return;
      }
      if (await tryHandleIgTopicReply(from, userText)) {
        log("intercept", "tryHandleIgTopicReply " + from);
        sendReaction(from, messageId, "").catch(() => {});
        log("ig-bridge", "Handled IG TOPIC REPLY, skipping LLM");
        return;
      }
      if (await tryHandleFrozenCourierChoice(from, userText)) {
        log("intercept", "tryHandleFrozenCourierChoice " + from);
        sendReaction(from, messageId, "").catch(() => {});
        log("sbsr-courier-choice", "Handled frozen courier choice, skipping LLM");
        return;
      }
      if (await tryHandleOrderConfirm(from, userText)) {
        log("intercept", "tryHandleOrderConfirm " + from);
        sendReaction(from, messageId, "").catch(() => {});
        log("sbsr-parse", "Handled order-confirm (YA/SALAH), skipping LLM");
        return;
      }
      if (await tryHandleCatalogRequest(from, userText)) {
        log("intercept", "tryHandleCatalogRequest " + from);
        sendReaction(from, messageId, "").catch(() => {});
        log("sbsr-catalog-intercept", "Handled catalog request, skipping LLM");
        return;
      }
      if (await tryHandleMissingFormInquiry(from, userText)) {
        log("intercept", "tryHandleMissingFormInquiry " + from);
        sendReaction(from, messageId, "").catch(() => {});
        log("sbsr-missing-form", "Handled missing-form inquiry, skipping LLM");
        return;
      }
      if (await tryHandleMissingFormClarification(from, userText)) {
        log("intercept", "tryHandleMissingFormClarification " + from);
        sendReaction(from, messageId, "").catch(() => {});
        log("sbsr-missing-form", "Handled missing-form clarification, re-parsed");
        return;
      }
      if (await tryHandleFreeTextOrder(from, userText)) {
        log("intercept", "tryHandleFreeTextOrder " + from);
        sendReaction(from, messageId, "").catch(() => {});
        log("sbsr-parse", "Handled free-text order, skipping LLM");
        return;
      }
      if (await tryHandleCourierOverride(from, userText)) {
        log("intercept", "tryHandleCourierOverride " + from);
        sendReaction(from, messageId, "").catch(() => {});
        log("sbsr-courier-override", "Handled courier override, skipping LLM");
        return;
      }
      // Deterministic answers for "what URL?" and "where is it being sent?"
      // MUST run before tryHandleOngkirCheck (which historically over-matched
      // on "cek/kirim" tokens). Their guards exclude any message containing a
      // price word OR a Maps URL, so they never collide with quote/cart paths.
      if (await tryHandleUrlEcho(from, userText)) {
        log("intercept", "tryHandleUrlEcho " + from);
        sendReaction(from, messageId, "").catch(() => {});
        log("sbsr-url-echo", "Handled URL echo, skipping LLM");
        return;
      }
      if (await tryHandleDestinationCheck(from, userText)) {
        log("intercept", "tryHandleDestinationCheck " + from);
        sendReaction(from, messageId, "").catch(() => {});
        log("sbsr-dest-check", "Handled destination check, skipping LLM");
        return;
      }
      if (await tryHandleOngkirCheck(from, userText)) {
        log("intercept", "tryHandleOngkirCheck " + from);
        sendReaction(from, messageId, "").catch(() => {});
        log("sbsr-ongkir-check", "Handled ongkir comparison, skipping LLM");
        return;
      }
      if (await tryHandlePickupFlow(from, userText)) {
        log("intercept", "tryHandlePickupFlow " + from);
        sendReaction(from, messageId, "").catch(() => {});
        log("sbsr-pickup", "Handled pickup flow, skipping LLM");
        return;
      }
      if (await tryHandleUseCaseRouter(from, userText)) {
        log("intercept", "tryHandleUseCaseRouter " + from);
        sendReaction(from, messageId, "").catch(() => {});
        log("sbsr-usecase", "Handled use-case router, skipping LLM");
        return;
      }
      if (await tryHandlePaymentReviewStatusIntent(from, userText)) {
        log("intercept", "tryHandlePaymentReviewStatusIntent " + from);
        sendReaction(from, messageId, "").catch(() => {});
        return;
      }
      {
        const _pd = loadSbsrDraft(from) || {};
        const _ps = String(_pd.state || "").trim().toLowerCase();
        if (SBSR_PAYMENT_INFO_RE.test(String(userText || "")) &&
            ["awaiting_proof", "pending_finance", "awaiting_manual_payment_review"].includes(_ps)) {
          const resent = await resendPaymentInstructionFromSource(from);
          if (resent) {
            sendReaction(from, messageId, "").catch(() => {});
            return;
          }
        }
      }
      if (await tryHandleAwaitingNameMultilineEarly(from, userText)) {
        log("intercept", "tryHandleAwaitingNameMultilineEarly " + from);
        sendReaction(from, messageId, "").catch(() => {});
        return;
      }
      if (await tryHandleFaq(from, userText)) {
        log("intercept", "tryHandleFaq " + from);
        sendReaction(from, messageId, "").catch(() => {});
        log("sbsr-faq", "Handled FAQ, skipping LLM");
        return;
      }
      if (await tryHandlePinConfirm(from, userText)) {
        log("intercept", "tryHandlePinConfirm " + from);
        sendReaction(from, messageId, "").catch(() => {});
        log("sbsr-pin-confirm", "Handled pin confirm, skipping LLM");
        return;
      }
      if (await tryHandleWrongInputInLocationStates(from, userText)) {
        log("intercept", "tryHandleWrongInputInLocationStates " + from);
        sendReaction(from, messageId, "").catch(() => {});
        log("sbsr-wrong-input", "Handled wrong input in location state, skipping LLM");
        return;
      }
      if (await tryHandleAddressPinConfirm(from, userText)) {
        log("intercept", "tryHandleAddressPinConfirm " + from);
        sendReaction(from, messageId, "").catch(() => {});
        return;
      }
      if (await tryHandleDeliveryMethodSelection(from, userText)) {
        log("intercept", "tryHandleDeliveryMethodSelection " + from);
        sendReaction(from, messageId, "").catch(() => {});
        return;
      }
      if (await tryHandleAddressAndQuote(from, userText)) {
        log("intercept", "tryHandleAddressAndQuote " + from);
        sendReaction(from, messageId, "").catch(() => {});
        log("sbsr-addr-quote", "Handled address+quote, skipping LLM");
        return;
      }
      if (await tryHandleBareMapsUrl(from, userText)) {
        log("intercept", "tryHandleBareMapsUrl " + from);
        sendReaction(from, messageId, "").catch(() => {});
        log("sbsr-maps-bare-intercept", "Handled bare maps url, skipping LLM");
        return;
      }
      if (await tryHandleAddonReply(from, userText)) {
        log("intercept", "tryHandleAddonReply " + from);
        sendReaction(from, messageId, "").catch(() => {});
        log("sbsr-addon", "Handled addon reply, skipping LLM");
        return;
      }
      // Shadow-update customer_name on standalone name reply (returns false → LLM still runs)
      // Shadow-updaters (capture name + address text from standalone msgs; return false → LLM still runs).
      // If both pieces + URL are present after capture, the inner auto-kickoff fires the quote.
      if (await tryHandleNameCapture(from, userText).catch(e => { log("sbsr-name-capture", "err: " + e.message); return false; })) {
        log("intercept", "tryHandleNameCapture " + from);
        sendReaction(from, messageId, "").catch(() => {});
        log("sbsr-name-capture", "auto-kickoff fired quote, skipping LLM");
        return;
      }
      if (await tryHandleOutOfContextHandoff(from, userText)) {
        log("sbsr-router", "blocked_openclaw_global_out_of_context");
        sendReaction(from, messageId, "").catch(() => {});
        return;
      }
      if (await tryHandleAddressTextCapture(from, userText).catch(e => { log("sbsr-addr-text", "err: " + e.message); return false; })) {
        log("intercept", "tryHandleAddressTextCapture " + from);
        sendReaction(from, messageId, "").catch(() => {});
        log("sbsr-addr-text", "auto-kickoff fired quote, skipping LLM");
        return;
      }
      if (await tryHandleAdminCmd(from, userText)) {
        log("intercept", "tryHandleAdminCmd " + from);
        sendReaction(from, messageId, "").catch(() => {});
        log("sbsr-admin-cmd", "Handled admin cmd, skipping LLM");
        return;
      }
      if (await tryHandleAdminHandoff(from, userText)) {
        log("intercept", "tryHandleAdminHandoff " + from);
        sendReaction(from, messageId, "").catch(() => {});
        log("sbsr-admin-handoff", "Handled admin handoff, skipping LLM");
        return;
      }
      if (await tryHandleInvoiceOk(from, userText)) {
        log("intercept", "tryHandleInvoiceOk " + from);
        sendReaction(from, messageId, "").catch(() => {});
        log("sbsr-payment-intercept", "Handled OK->QRIS, skipping LLM");
        return;
      }
      if (await tryHandleAmbiguousConfirm(from, userText)) {
        log("intercept", "tryHandleAmbiguousConfirm " + from);
        sendReaction(from, messageId, "").catch(() => {});
        log("sbsr-ambiguous-confirm", "Handled short ambiguous confirm, skipping LLM");
        return;
      }
      if (await tryHandleIgPost(from, userText)) {
        log("intercept", "tryHandleIgPost " + from);
        sendReaction(from, messageId, "").catch(() => {});
        log("ig-bridge", "Handled IG POST, skipping LLM");
        return;
      }
    } catch (e) { log("bridge-prehandler", "error: " + e.message); }

    const _postDraft = loadSbsrDraft(from) || {};
    const _postState = String(_postDraft.state || "").trim().toLowerCase();
function getStateNudgeText(state) {
  var nudges = {
    "awaiting_usecase": "Silakan pilih kebutuhan: 1) makan langsung, 2) stock frozen, 3) meeting/acara, 4) gift/hampers",
    "awaiting_product_selection": "Silakan pilih varian + jumlah dari katalog ya Kak \u{1f90d}",
    "awaiting_addon_reply": "Kalau sudah cukup, balas LANJUT ya Kak",
    "awaiting_delivery_method": "Pilih pengiriman: 1) Delivery atau 2) Pickup",
    "awaiting_name": "Boleh info nama penerima ya Kak",
    "awaiting_address": "Kirim alamat lengkap + titik Maps ya Kak \u{1f4cd}",
    "awaiting_location": "Share lokasi WhatsApp atau link Google Maps ya Kak",
    "awaiting_address_pin_confirm": "Konfirmasi alamat & pin-nya ya Kak",
    "awaiting_order_confirm": "Balas OK/YA kalau sudah sesuai ya Kak",
    "awaiting_invoice_confirm": "Balas OK/YA untuk lanjut ke pembayaran ya Kak",
    "awaiting_proof": "Upload bukti pembayaran ya Kak \u{1f4f8}",
    "awaiting_pin_confirm": "Konfirmasi pin lokasi ya Kak",
    "awaiting_meeting_package_confirm": "Konfirmasi paket meeting ya Kak",
    "awaiting_courier_choice": "Pilih kurir: 1 atau 2 ya Kak",
    "awaiting_location_retry": "Coba kirim ulang lokasi ya Kak"
  };
  return nudges[state] || "Silakan lanjutkan proses pemesanan ya Kak \u{1f90d}";
}

    const _checkoutLockStates = new Set([
      "awaiting_usecase",
      "awaiting_meeting_package_confirm",
      "awaiting_product_selection",
      "awaiting_addon_reply",
      "awaiting_delivery_method",
      "awaiting_name",
      "awaiting_location",
      "awaiting_address",
      "awaiting_address_pin_confirm",
      "awaiting_pin_confirm",
      "awaiting_order_confirm",
      "awaiting_invoice_confirm",
      "awaiting_location_retry",
    ]);
    if (_checkoutLockStates.has(_postState)) {
      // === SMART OOC: LLM-FIRST -- jawab dulu, baru nudge balik ke state ===
      var _oocHandled2 = false;
      // ADDRESS GUARD: if awaiting_address and text looks like address, skip OOC
      if (_postState === "awaiting_address" && userText.length >= 10 && !/\?/.test(userText)) {
        // Skip OOC - let address text handler process
        log("sbsr-ooc", "skip_ooc_address_mode");
      } else {
      try {
        var _oocCtx = await sbsrRetrieveMemoryContext(from, userText);
        var _stateNudge = getSbsrDeterministicMissingStateMessage(from, loadSbsrDraft(from) || {}) || "lanjut ke proses pemesanan ya Kak \u{1f90d}";
        var _oocGuard = [
          '[ATURAN PENTING -- KAMU SUPIR, BRIDGE TUJUAN]',
          '- Kamu Mintu, CS Sentuh Rasa (Risoles Otentik) -- ramah, helpful.',
          '- PRIORITAS 1: JAWAB dulu pertanyaan customer dengan lengkap & natural.',
          '- PRIORITAS 2: Setelah menjawab, ingatkan customer: \"' + _stateNudge.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '\"',
          '- SETIAP sebut/minta/tambah produk -> SELALU sebutkan HARGA dari katalog.',
          '- Customer tanya FAQ (halal, lokasi, kurir, dll) -> jawab dari FAQ.',
          '- JANGAN bilang \"sistem yang akan proses\" atau \"nanti dikirim otomatis\".',
          '- Kamu yang handle percakapan personal, bukan sistem.',
          '- JANGAN pake NO_REPLY atau bahasa internal.',
          '',
          // Inject cart info so LLM can answer total/harga questions
          (function(){
            var _cd = loadSbsrDraft(from) || {};
            var _items = Array.isArray(_cd.items) ? _cd.items : [];
            if (_items.length === 0) return '';
            var _lines = ['', '[ISI CART SAAT INI]'];
            var _st = 0;
            for (var _ii = 0; _ii < _items.length; _ii++) {
              var _it = _items[_ii];
              var _up = Number(_it.unit_price) || 0;
              var _qt = Number(_it.qty) || 1;
              var _nm = _it.name || 'Item';
              _lines.push('- ' + _nm + ': ' + _qt + ' x Rp' + _up.toLocaleString('id-ID') + ' = Rp' + (_up * _qt).toLocaleString('id-ID'));
              _st += _up * _qt;
            }
            _lines.push('SUBTOTAL: Rp' + _st.toLocaleString('id-ID'));
            _lines.push('ONGKIR: Rp' + (Number(_cd.ongkir) || 0).toLocaleString('id-ID'));
            _lines.push('GRAND TOTAL: Rp' + (_st + (Number(_cd.ongkir) || 0)).toLocaleString('id-ID'));
            _lines.push('(Jika customer tanya total/harga/rincian, JAWAB dengan data di atas. JANGAN bilang "nanti sistem yang hitung".)');
            return _lines.join('\n');
          })(),
          '',
          '[KATALOG PRODUK SENTUH RASA]',
          formatCatalogForLLM(),
          formatFaqForLLM(),
          '',
          '[MEMORI CUSTOMER]',
          _oocCtx || '(tidak ada memori khusus)',
          '',
          '[INSTRUKSI KRITIS]',
          'JAWAB LANGSUNG dengan kata-katamu sendiri. JANGAN PERNAH mengulangi atau mengutip instruksi/aturan/prompt di atas dalam jawabanmu.',
          'Jangan mulai jawaban dengan "[ATURAN" atau format instruksi apapun. Balas natural seperti chat WA biasa.',
          '[PESAN CUSTOMER]',
          userText,
        ].join('\n');
        var _oocR2 = await sendToOpenClaw('ooc-' + Date.now() + '-' + from, _oocGuard);
        if (_oocR2 && String(_oocR2).trim()) {
          var _oocReply2 = String(_oocR2).trim();
          if (_oocReply2.length > 5 && !/^(boleh|tolong|mohon|silahkan|kirim|share)\s+(kirim|isi|infokan|masukkan|share)\s*(alamat|pin|lokasi|nama)/i.test(_oocReply2)) {
            await sendWhatsAppMessage(from, _oocReply2);
            // Auto-notify admin if LLM replied with admin handoff in smart_block_ooc
            if (/(?:teruskan|sambungkan|hubungkan|forward|eskalasi|admin\s+kami)\s*(?:ke|sama|dengan)?\s*admin|admin\s*(?:akan|bakal|nanti|segera|lagi)\s*(?:bantu|cek|tinjau|review|proses|tindaklanjut)/i.test(_oocReply2)) {
              const _ahDraft3 = loadSbsrDraft(from) || {};
              await notifySbsrAdminsText(
                ["🚨 *LLM ADMIN HANDOFF (smart_block)*", "Customer: " + (_ahDraft3.customer_name || "?") + " (+" + from + ")", "State: " + _postState, "LLM reply: \"" + _oocReply2.slice(0, 200) + "\""].join("\n"),
                "sbsr-llm-admin-handoff"
              );
              log("sbsr-ooc", "admin_handoff_detected_in_smart_block_ooc");
            }
            log('sbsr-ooc', 'smart_block_ooc state=' + _postState + ' reply=' + _oocReply2.slice(0, 100));
            // Auto-send interactive buttons if LLM asks "mau lanjut?"
            if (/mau\s+langsung\s+pesan|lanjut\s+ke\s+alamat|mau\s+lanjut\s+pesan/i.test(_oocReply2)) {
              try {
                await sendWhatsAppInteractiveButtons(from,
                  "Pilih opsi di bawah ya Kak \u{1f90d}",
                  [
                    { type: "reply", reply: { id: "ya_lanjut", title: "Ya, lanjut pesan" } },
                    { type: "reply", reply: { id: "tidak", title: "Tidak dulu" } }
                  ]
                );
                log('sbsr-interactive', 'lanjut_buttons_sent');
              } catch (_ibErr) {
                log('sbsr-interactive', 'button_err: ' + (_ibErr && _ibErr.message));
              }
            }
            _oocHandled2 = true;
          }
        }
      } catch (_e2) {
        log('sbsr-ooc', 'smart_block_err: ' + _e2.message);
      }
      if (_oocHandled2) {
        log("sbsr-router", "ooc_handled_by_llm");
        sendReaction(from, messageId, "").catch(() => {});
        return;
      }
      log("sbsr-router", "blocked_openclaw_checkout");
      const _fallback = getSbsrDeterministicMissingStateMessage(from, _postDraft);
      try { await sendWhatsAppMessage(from, _fallback); } catch (_) {}
      return;
    }
    } // close address guard else

    // Hydrate LLM with state from prior bridge-handled turns. Without this,
    // the LLM repeats steps that interceptors already executed (re-asking for
    // nama/alamat/maps after addr+quote intercept, fabricating invoices when
    // sentuh-quote.mjs failed and we fell through, etc).
    // Deterministic reply for total/detail questions in awaiting_proof/pending_finance
    const _preLlmDraft = loadSbsrDraft(from) || {};
    const _preLlmState = String(_preLlmDraft.state || "").trim().toLowerCase();
    if ((_preLlmState === "awaiting_proof" || _preLlmState === "pending_finance") &&
        /(?:total|detail|invoice|rincian|pesanan\s+saya|isi\s+pesanan|list|daftar|semua)/i.test(userText)) {
      await sendWhatsAppMessage(from, "Siap Kak. Nanti sistem yang akan kirim detail total pesanan dan invoice pembayarannya ya \ud83e\udd0d");
      log("sbsr-ooc", "deterministic_total_reply for " + from + " state=" + _preLlmState);
      sendReaction(from, null, "").catch(() => {});
      return;
    }
    // Terminal state context — inject order status for LLM to avoid hallucination
    const _termStates = ["payment_verified_manual","payment_rejected_manual","booked","approved","payment_verified","payment_rejected"];
    if (_termStates.includes(_preLlmState)) {
      const _termLabels = {
        "payment_verified_manual": "Pembayaran SUDAH DIVERIFIKASI — order selesai.",
        "payment_rejected_manual": "Pembayaran DITOLAK — customer bisa upload ulang.",
        "booked": "Order SUDAH DIBOOKING — sedang diproses.",
        "approved": "Order DISETUJUI admin.",
        "payment_verified": "Pembayaran SUDAH DIVERIFIKASI — order selesai.",
        "payment_rejected": "Pembayaran DITOLAK admin.",
      };
      setPendingBridgeContext(from, [
        "STATE: " + _preLlmState + " — " + (_termLabels[_preLlmState] || "Order dalam proses."),
        "JANGAN minta alamat/nama/pin/pembayaran — order sedang/post-order.",
        "JANGAN ulang flow checkout atau minta bayar lagi.",
        "Kalau customer nanya status → jelasin status order saat ini.",
        "Kalau customer minta order baru → bantu dengan menu/katalog baru.",
        "Kalau customer komplain → catat dan informasikan akan diteruskan ke admin.",
        "JANGAN ngarang harga, produk, atau janji pengiriman.",
      ].join("\n"));
    }
    let llmText = userText;
    // Admin pause: skip LLM reply when operator has manually taken over this chat.
    // Bridge interceptors above (orders, catalog, admin cmds) already executed.
    if (admin.isPaused(from)) { log("admin", "bot paused for " + from + " — skipping AI reply"); return; }

    // === BIKS COST-GUARD: pre-flight ===
    // Bridge can't see token usage, so we count requests at PER_REQUEST_COST_ESTIMATE_USD
    // each. Daily cap default $5 ≈ 1000 reqs/day — runaway loop trips it long
    // before OpenRouter-side billing surprises. Admin numbers bypass.
    if (secLib && secLib.costGuard && !_isAdminPhoneSec(from)) {
      try {
        if (!secLib.costGuard.canSpend(PER_REQUEST_COST_ESTIMATE_USD)) {
          const _t = secLib.costGuard.today();
          log("cost-guard", "DAILY CAP HIT spend=$" + Number(_t.spend_usd).toFixed(4) + " cap=$" + secLib.costGuard.dailyCapUsd + " phone=" + from);
          await sendWhatsAppMessage(from, "Mintu lagi sibuk banget hari ini, balas lagi besok pagi ya 🙏").catch(() => {});
          return;
        }
      } catch (e) { log("cost-guard", "err — failing open: " + e.message); }
    }
    // === END BIKS COST-GUARD pre-flight ===

    const t0 = Date.now();
    let aiReply;
    try { aiReply = await enqueueMessage(from, llmText); }
    catch (err) {
      log("openclaw", "Error: " + err.message);
      if (!gatewayReady) connectGateway();
      // Suppress duplicate generic-error ONLY for orphan-call timeouts where a parallel
      // inbound from the same customer already received a successful reply AFTER this
      // call started. Pattern: 3 rapid inbounds → 1 LLM call replies fast covering the
      // intent → other LLM calls orphaned → time out 240s later → would re-message a
      // customer who already got their answer.
      // Precise check: t0 is when this call started; if last_reply_at > t0, a concurrent
      // reply already went out → safe to suppress without losing real errors for
      // genuinely-stuck single-message conversations.
      if (err.message === "OpenClaw response timeout") {
        try {
          const _dr = loadSbsrDraft(from);
          const _last = _dr?.last_reply_at ? new Date(_dr.last_reply_at).getTime() : 0;
          if (_last > t0) {
            log("openclaw-timeout-suppressed", "for " + from + " — concurrent reply at " + _dr.last_reply_at + " (after t0=" + new Date(t0).toISOString() + ")");
            return;
          }
        } catch (_) {}
      }
      aiReply = "Maaf, ada error. Coba lagi ya.";
    }
    log("timing", "OpenClaw response: " + (Date.now() - t0) + "ms");
    // === BIKS COST-GUARD: record (after every LLM round-trip, success or fallback) ===
    if (secLib && secLib.costGuard) {
      try {
        secLib.costGuard.record({ kind: "chat", model: "unknown", costUsd: PER_REQUEST_COST_ESTIMATE_USD });
        const _t = secLib.costGuard.today();
        if (Number(_t.spend_usd) >= secLib.costGuard.softCapUsd) {
          log("cost-guard", "soft-cap reached: spend=$" + Number(_t.spend_usd).toFixed(4) + " soft=$" + secLib.costGuard.softCapUsd + " hard=$" + secLib.costGuard.dailyCapUsd + " reqs=" + _t.requests);
        }
      } catch (e) { log("cost-guard", "record err: " + e.message); }
    }
    try { sniffInvoiceFromAiReply(from, aiReply); } catch (e) { log("sbsr-sniff", "err: " + e.message); }
    try { sniffCartAckFromAiReply(from, aiReply); } catch (e) { log("sbsr-cart-sniff", "err: " + e.message); }
    try { if (await maybeAutoQuote(from, aiReply)) { log("sbsr-auto-quote", "fired post-LLM, suppressing duplicate reply"); return; } } catch (e) { log("sbsr-auto-quote", "err: " + e.message); }
    try { aiReply = enrichInvoiceWithMaps(from, aiReply); } catch (e) { log("sbsr-maps-inject", "err: " + e.message); }
    try { await maybeFireAdminEscalation(from, contactName, userText, aiReply); } catch (e) { log("sbsr-escalate", "err: " + e.message); }
    if (shouldBlockSbsrCheckoutEnglishReply(from, aiReply)) {
      log("sbsr-checkout-guard", "blocked English checkout reply; using deterministic fallback");
      aiReply = getSbsrCheckoutEnglishFallback(from);
    }
    const _replyDraft = loadSbsrDraft(from) || {};
    const _replyState = String(_replyDraft.state || "").trim().toLowerCase();
    if (["awaiting_usecase","awaiting_meeting_package_confirm","awaiting_product_selection","awaiting_addon_reply","awaiting_delivery_method","awaiting_name","awaiting_location","awaiting_address","awaiting_address_pin_confirm","awaiting_pin_confirm","awaiting_order_confirm","awaiting_invoice_confirm"].includes(_replyState) &&
        shouldBlockOpenClawCheckoutLeak(aiReply)) {
      log("sbsr-router", "blocked_openclaw_checkout");
      aiReply = getSbsrDeterministicMissingStateMessage(from, _replyDraft);
    }

    try {
      await sbsrStoreExtractedMemories(from, userText, aiReply, loadSbsrDraft(from) || {});
    } catch (e) { log("sbsr-memory", "store pipeline err: " + e.message); }

    if (!aiReply || !aiReply.trim()) { log("warn", "Empty response from OpenClaw, skipping WA send"); sendReaction(from, messageId, "").catch(() => {}); return; }

    // Junk-reply filter — Codex sometimes hallucinates a bare "NO" / "YES" / "OK" when a tool was called
    // alongside text generation. These are always wrong (the user never benefits from a one-word reply
    // when they didn't ask a yes/no question). Drop them before they reach WA.
    const trimmedReply = aiReply.trim().replace(/^["'`]+|["'`]+$/g, '').trim();
    if (/^(no|yes|ya|ok|oke|nope|yep|sure)[.!]?$/i.test(trimmedReply)) {
      log("junk-filter", "Suppressed hallucinated one-word reply: " + JSON.stringify(trimmedReply));
      sendReaction(from, messageId, "").catch(() => {});
      return;
    }

    const qrisDraft = loadSbsrDraft(from) || {};
    const qrisHandled = await maybeSendQrisMarkerMedia(from, aiReply, qrisDraft.grand_total || qrisDraft.expected_total || 0);
    aiReply = qrisHandled.text || "";
    if (!aiReply.trim()) {
      sendReaction(from, messageId, "").catch(() => {});
      return;
    }

    // Check if response contains [MENU] marker — send interactive list
    const cleanReply = aiReply.replace(/```[\s\S]*?```/g, m => m.replace(/`/g, "")).trim();
    log("raw-reply", "RAW[" + aiReply.length + "]: " + JSON.stringify(aiReply.substring(0,300)));
    if (/\[CATALOG/.test(cleanReply) || /\[CATALOG/.test(aiReply)) {
      try {
        await sendWhatsAppCatalog(from);
        log("reply", "To " + from + ": [CATALOG sent]");
      } catch (catErr) {
        log("wa-catalog", "Catalog failed, deterministic text fallback: " + catErr.message);
        await sendCatalogDeterministicFallback(from, catErr.message);
      }
      sendReaction(from, messageId, "").catch(() => {});
      return;
    }
    if (/\[MENU/.test(cleanReply) || /\[MENU/.test(aiReply)) {
      try {
        await sendWhatsAppInteractiveList(from);
        // Do NOT send any trailing text when [MENU] detected — user only sees the clean dropdown
      } catch (menuErr) {
        log("wa-menu", "Interactive list failed, falling back to text: " + menuErr.message);
        // Fallback: send as plain text menu
        const fallbackMenu = "Halo! Gw Airo, bot admin Airoklin. Pilih yang mau lo kerjain:\n\n1. Catat Expense — Catat pengeluaran ke dashboard\n2. Catat Revenue — Catat pemasukan ke dashboard\n3. Bayar Tukang/Jasa (FPD) — Reimbursement / Overhead / Kasbon\n4. Tagihan Client (Invoice) — Bill client + simpan PDF ke Drive\n5. Post di Instagram — Bikin poster + post ke IG\n\nKetik angka 1-5 atau langsung bilang apa yang mau lo kerjain.";
        await sendWhatsAppMessage(from, fallbackMenu);
      }
    } else {
      const parts = splitMessage(aiReply);
      for (const part of parts) { if (part && part.trim()) await sendWhatsAppMessage(from, part); }
    }
    sendReaction(from, messageId, "").catch(() => {});
    log("reply", "To " + from + ": " + aiReply.substring(0, 100) + "...");
  } catch (err) {
    log("error", "Processing message from " + from + ": " + err.message);
    try { await sendWhatsAppMessage(from, "Maaf, ada error. Coba lagi ya."); } catch (_) {}
  }
}

function resolveApiToken(req) {
  const authHeader = String(req.headers["authorization"] || "").trim();
  const bearer = authHeader.match(/^Bearer\s+(.+)$/i);
  if (req.query && req.query.token) return { token: String(req.query.token), authSource: "query" };
  if (req.body && req.body.token) return { token: String(req.body.token), authSource: "body" };
  if (bearer) return { token: String(bearer[1]).trim(), authSource: "authorization" };
  if (req.headers && req.headers["x-openclaw-token"]) return { token: String(req.headers["x-openclaw-token"]).trim(), authSource: "x-openclaw-token" };
  return { token: "", authSource: "none" };
}

function loadCompatOpenClawTokens() {
  const tokens = new Set([String(OPENCLAW_TOKEN || "").trim()].filter(Boolean));
  try {
    const envPath = "/docker/wa-webhook-sbsr/static/sentuhrasa-pdf/scripts/.env";
    if (fs.existsSync(envPath)) {
      const txt = fs.readFileSync(envPath, "utf8");
      const m = txt.match(/^\s*OPENCLAW_TOKEN\s*=\s*(.+)\s*$/m);
      if (m) {
        let v = String(m[1] || "").trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        if (v) tokens.add(v);
      }
    }
  } catch (e) {
    log("send-image-auth", "compat token load err: " + e.message);
  }
  return tokens;
}

const SEND_IMAGE_ACCEPTED_TOKENS = loadCompatOpenClawTokens();

// =====================================================
// API: /send — send text message to any number
// =====================================================
app.post("/send", (req, res) => {
  const { to, message, token } = req.body;
  if (token !== OPENCLAW_TOKEN) return res.status(401).json({ error: "Unauthorized" });
  if (!to || !message) return res.status(400).json({ error: "Missing 'to' or 'message'" });
  const phone = to.replace(/[^0-9]/g, "");
  log("send-api", "Sending to " + phone + ": " + message.substring(0, 80) + "...");
  sendWhatsAppMessage(phone, message)
    .then((result) => { log("send-api", "Sent successfully to " + phone); res.json({ ok: true, wa_response: result }); })
    .catch((err) => { log("send-api", "Failed to " + phone + ": " + err.message); res.status(500).json({ ok: false, error: err.message }); });
});

// =====================================================
// API: /send-pdf — upload + send PDF to any number
// =====================================================
app.post("/send-pdf", async (req, res) => {
  const { to, file_path, filename, caption, token } = req.body;
  if (token !== OPENCLAW_TOKEN) return res.status(401).json({ error: "Unauthorized" });
  if (!to || !file_path) return res.status(400).json({ error: "Missing 'to' or 'file_path'" });
  const phone = to.replace(/[^0-9]/g, "");

  // Map container path to host path
  let hostPath = file_path;
  if (file_path.startsWith(CONTAINER_DATA_PREFIX)) {
    hostPath = file_path.replace(CONTAINER_DATA_PREFIX, HOST_DATA_PREFIX);
  }

  if (!fs.existsSync(hostPath)) {
    log("send-pdf", "File not found: " + hostPath + " (from " + file_path + ")");
    return res.status(404).json({ ok: false, error: "File not found: " + hostPath });
  }

  const pdfFilename = filename || path.basename(file_path);
  log("send-pdf", "Uploading " + pdfFilename + " for " + phone);

  try {
    const mediaId = await uploadMediaToWhatsApp(hostPath, "application/pdf");
    log("send-pdf", "Uploaded media ID: " + mediaId);
    const result = await sendWhatsAppDocument(phone, mediaId, pdfFilename, caption || "");
    log("send-pdf", "PDF sent to " + phone);
    res.json({ ok: true, media_id: mediaId, wa_response: result });
  } catch (err) {
    log("send-pdf", "Failed: " + err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// =====================================================
// API: /send-image — upload + send image (PNG/JPG) to any number
// =====================================================
app.post("/send-image", async (req, res) => {
  const { to, file_path, caption } = req.body;
  const { token, authSource } = resolveApiToken(req);
  log("send-image-auth", "auth source=" + authSource);
  if (!SEND_IMAGE_ACCEPTED_TOKENS.has(String(token || "").trim())) return res.status(401).json({ error: "Unauthorized" });
  if (!to || !file_path) return res.status(400).json({ error: "Missing 'to' or 'file_path'" });
  let phone = to.replace(/[^0-9]/g, "");
  // Normalize to international format: 08xx → 628xx (Indonesia)
  if (/^0\d{7,13}$/.test(phone)) phone = "62" + phone.slice(1);
  if (/^8\d{7,12}$/.test(phone)) phone = "62" + phone;

  let hostPath = file_path;
  if (file_path.startsWith(CONTAINER_DATA_PREFIX)) {
    hostPath = file_path.replace(CONTAINER_DATA_PREFIX, HOST_DATA_PREFIX);
  }
  if (!fs.existsSync(hostPath)) {
    log("send-image", "File not found: " + hostPath + " (from " + file_path + ")");
    return res.status(404).json({ ok: false, error: "File not found: " + hostPath });
  }

  const ext = (path.extname(hostPath) || "").toLowerCase();
  const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";
  log("send-image", "Uploading " + hostPath + " (" + mime + ") for " + phone);

  try {
    const mediaId = await uploadMediaToWhatsApp(hostPath, mime);
    log("send-image", "Uploaded media ID: " + mediaId);
    const result = await sendWhatsAppImage(phone, mediaId, caption || "");
    log("send-image", "Image sent to " + phone);
    res.json({ ok: true, media_id: mediaId, wa_response: result });
  } catch (err) {
    log("send-image", "Failed: " + err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/admin/training-review", async (req, res) => {
  try {
    const { token, phone, verdict, input_context, bad_response, corrected_response, use_case } = req.body || {};
    if (token !== OPENCLAW_TOKEN) return res.status(401).json({ error: "Unauthorized" });
    const v = String(verdict || "").toLowerCase();
    if (!["good", "bad", "corrected"].includes(v)) return res.status(400).json({ error: "Invalid verdict" });
    const ok = await sbsrStoreAdminTrainingData({
      phone,
      verdict: v,
      input_context,
      bad_response,
      corrected_response,
      use_case,
    });
    return res.json({ ok: !!ok, stored: !!ok });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/admin/payment-review", async (req, res) => {
  const { phone, action, reason, token } = req.body || {};
  if (token !== OPENCLAW_TOKEN) return res.status(401).json({ error: "Unauthorized" });
  if (!phone || !action) return res.status(400).json({ error: "Missing 'phone' or 'action'" });
  const cleanPhone = String(phone).replace(/[^0-9]/g, "");
  const cleanAction = String(action).toLowerCase();
  if (!["approve", "reject"].includes(cleanAction)) return res.status(400).json({ error: "Invalid action" });

  const cp = require("child_process");
  const payload = JSON.stringify(cleanAction === "approve"
    ? { cmd: "approve", phone: cleanPhone, actor: "admin-api" }
    : { cmd: "reject", phone: cleanPhone, reason: reason || "rejected", actor: "admin-api" });

  cp.execFile("docker", [
    "exec", "sbsr-openclaw-1",
    "node", "/data/sentuhrasa-pdf/scripts/sentuh-admin-cmd.mjs", payload,
  ], { timeout: 60000 }, async (err, stdout, stderr) => {
    let result = null;
    try { result = JSON.parse(String(stdout || "").trim().split(/\r?\n/).pop()); } catch (_) {}
    if (err && !result) return res.status(500).json({ ok: false, error: (stderr || err.message).slice(0, 200) });
    if (!result) return res.status(500).json({ ok: false, error: "payment review script returned no JSON" });
    if (result.customer_message && result.customer_phone) {
      try { await sendWhatsAppMessage(result.customer_phone, result.customer_message); }
      catch (e) { log("payment-review", "customer notify err: " + e.message); }
    }
    if (result.duplicate) {
      log("payment-review", "duplicate resolution blocked");
    } else if (result.resolution === "approved") {
      log("payment-review", "approved manually by admin-api");
      const d = loadSbsrDraft(result.customer_phone || cleanPhone) || {};
      void syncCustomerDbEvent(result.customer_phone || cleanPhone, "payment_approved", d, {
        lastResponse: "payment_approved",
        lastOffer: d.use_case ? `use_case:${d.use_case}` : "payment",
      });
    } else if (result.resolution === "rejected") {
      log("payment-review", "rejected manually by admin-api");
      const d = loadSbsrDraft(result.customer_phone || cleanPhone) || {};
      void syncCustomerDbEvent(result.customer_phone || cleanPhone, "payment_rejected", d, {
        lastResponse: "payment_rejected",
        lastOffer: d.use_case ? `use_case:${d.use_case}` : "payment",
      });
    }
    return res.json(result);
  });
});

// --- Webhook routes ---
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"]; const token = req.query["hub.verify_token"]; const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) { log("webhook", "Verification successful"); return res.status(200).send(challenge); }
  log("webhook", "Verification failed"); return res.sendStatus(403);
});

app.post("/test-msg", (req, res) => {
  const { from, text } = req.body;
  if (!from || !text) return res.status(400).json({ error: "Missing from or text" });
  const mockMsg = { from: from.replace(/[^0-9]/g, ''), id: 'test-' + Date.now() + '-' + Math.random().toString(36).slice(2,8), type: 'text', text: { body: text } };
  const mockContacts = [{ profile: { name: 'Test-User' }, wa_id: from }];
  log("test-msg", "Injecting from=" + mockMsg.from + " text=\"" + text.slice(0, 80) + "\"");
  handleMessage(mockMsg, mockContacts).catch(err => log("test-msg", "error: " + err.message));
  res.json({ ok: true, msg: "injected" });
});

app.post("/webhook", (req, res) => {
  if (!verifySignature(req)) { log("webhook", "Invalid signature"); return res.sendStatus(403); }
  const body = req.body; res.sendStatus(200);
  if (body.object !== "whatsapp_business_account") return;
  body.entry?.forEach((entry) => {
    entry.changes?.forEach((change) => {
      if (change.field !== "messages") return;
      const value = change.value;
      if (value.statuses) { value.statuses.forEach((s) => log("status", s.recipient_id + ": " + s.status)); return; }
      const messages = value.messages; const contacts = value.contacts;
      if (!messages) return;
      messages.forEach((msg) => { handleMessage(msg, contacts).catch((err) => log("handler", "Unhandled error: " + err.message)); });
    });
  });
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", gateway: gatewayReady, uptime: process.uptime(), queueLength: messageQueue.length, pendingChats: pendingChats.size, reconnectAttempt: reconnectAttempt });
})
// --- Biteship Webhook Handler (delivery status updates) ---
app.post("/biteship-webhook", async (req, res) => {
  res.status(200).json({ success: true });

  try {
    const { event, status, metadata, order_id, courier_waybill_id, courier_company } = req.body;
    log("biteship-webhook", "received event=" + event + " status=" + status + " order_id=" + (order_id || "?") + " waybill=" + (courier_waybill_id || "?") + " courier=" + (courier_company || "?"));

    if (event !== "order.status") return;
    if (status !== "delivered") return;

    let sbsrOrderId = metadata?.order_id || null;
    let orderData = null;
    const ordersPath = "/opt/sbsr/data/openclaw/.openclaw/workspace/orders.json";

    if (fs.existsSync(ordersPath)) {
      const orders = JSON.parse(fs.readFileSync(ordersPath, "utf8"));

      if (sbsrOrderId && orders[sbsrOrderId]) {
        orderData = orders[sbsrOrderId];
        log("biteship-webhook", "found order by metadata.order_id=" + sbsrOrderId);
      }

      if (!orderData && order_id) {
        for (const [id, data] of Object.entries(orders)) {
          if (data.biteship_order_id === order_id) {
            sbsrOrderId = id;
            orderData = data;
            log("biteship-webhook", "found order by biteship_order_id=" + order_id);
            break;
          }
        }
      }

      if (!orderData && courier_waybill_id) {
        for (const [id, data] of Object.entries(orders)) {
          if (data.waybill_id === courier_waybill_id) {
            sbsrOrderId = id;
            orderData = data;
            log("biteship-webhook", "found order by waybill_id=" + courier_waybill_id);
            break;
          }
        }
      }
    }

    if (!orderData) {
      log("biteship-webhook", "order not found for " + (sbsrOrderId || order_id || courier_waybill_id || "?"));
      return;
    }

    const customerName = orderData.customer_name || "Kak";
    const customerPhone = orderData.phone;

    if (!customerPhone) {
      log("biteship-webhook", "no phone for order " + sbsrOrderId);
      return;
    }

    const message = "Halo Kak " + customerName + ", mohon konfirmasi apakah pesanan dari Sentuh Rasa sudah diterima? 🤍\n\nmohon infokan jika ada kendala ya ka. Terima kasih sudah order hari ini.";

    // Save delivery confirmation flag to draft for customer reply handling
    try {
      const _dr = loadSbsrDraft(customerPhone) || { phone: customerPhone };
      saveSbsrDraft(customerPhone, { ..._dr, delivery_confirmation_sent_at: new Date().toISOString() });
    } catch (_) {}
    await sendWhatsAppMessage(customerPhone, message);
    log("biteship-webhook", "delivery confirmation sent to " + customerPhone + " for order " + sbsrOrderId);
  } catch (e) {
    log("biteship-webhook", "Error: " + e.message);
  }
});

// --- Admin inbox panel (mount before listen) ---

// --- Admin: send image/video via WhatsApp (base64 JSON) — with preview URL ---
app.post("/admin-send-image", express.json({ limit: "15mb" }), async (req, res) => {
  log("admin-send-image", "REQUEST received, headers: " + Object.keys(req.headers).join(","));
  try {
    const { phone, image_base64, mime_type, caption } = req.body;
    if (!phone) return res.status(400).json({ error: "missing phone" });
    if (!image_base64) return res.status(400).json({ error: "missing image_base64" });
    const buf = Buffer.from(image_base64, "base64");
    const mime = mime_type || "image/jpeg";
    const isVideo = mime.startsWith("video/");

    // Determine correct file extension from MIME type
    let ext;
    if      (mime.includes("mp4"))       ext = ".mp4";
    else if (mime.includes("webm"))      ext = ".webm";
    else if (mime.includes("quicktime")) ext = ".mov";
    else if (mime.includes("3gpp"))      ext = ".3gpp";
    else if (mime.includes("png"))       ext = ".png";
    else if (mime.includes("gif"))       ext = ".gif";
    else if (mime.includes("webp"))      ext = ".webp";
    else                                 ext = ".jpg";

    const prefix = isVideo ? "ADMIN-VID" : "ADMIN-IMG";
    const filename = prefix + "-" + Date.now() + ext;
    var receiptPath = "/docker/wa-webhook-sbsr/static/sentuhrasa-pdf/uploads/" + filename;
    try { if (!fs.existsSync("/docker/wa-webhook-sbsr/static/sentuhrasa-pdf/uploads")) fs.mkdirSync("/docker/wa-webhook-sbsr/static/sentuhrasa-pdf/uploads", { recursive: true }); } catch(_) {}
    fs.writeFileSync(receiptPath, buf);
    var mediaUrl = "https://production.biks.ai/receipts/" + filename;

    var mediaId = await uploadMediaToWhatsApp(receiptPath, mime);
    if (isVideo) {
      await sendWhatsAppVideo(phone, mediaId, caption || "");
    } else {
      await sendWhatsAppImage(phone, mediaId, caption || "");
    }

    // Log with marker so admin.js can render the correct element (image vs video)
    var logText = (isVideo ? "[video: " : "[image: ") + mediaUrl + "]" + (caption ? " " + caption : "");
    safeLog(admin.logOutgoing, phone, logText);
    res.json({ ok: true, url: mediaUrl });
  } catch(e) {
    log("admin-send-image", "Error: " + e.message);
    res.status(500).json({ error: e.message });
  }
});

// --- Admin: send document via WhatsApp (base64 JSON) ---
// MIME types accepted by WA Cloud API for documents (derived server-side from extension
// so we don't trust whatever the browser reports — Chrome/Safari often send
// application/octet-stream for non-standard extensions).
// WA Cloud API accepted document MIME types (from the API error message):
// audio/aac|mp4|mpeg|amr|ogg|opus, application/pdf, text/plain,
// application/msword, application/vnd.ms-excel, application/vnd.ms-powerpoint,
// application/vnd.openxmlformats-officedocument.{wordprocessingml.document,
//   presentationml.presentation, spreadsheetml.sheet}
// NOTE: text/csv and application/x-rar-compressed are NOT supported.
const WA_DOC_MIME = {
  pdf:  "application/pdf",
  doc:  "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls:  "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt:  "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt:  "text/plain",
  csv:  "text/plain",   // WA rejects text/csv — send as text/plain
  zip:  "application/zip",
};
app.post("/admin-send-document", express.json({ limit: "110mb" }), async (req, res) => {
  log("admin-send-document", "REQUEST received");
  try {
    const { phone, file_base64, filename: origFilename, caption } = req.body;
    if (!phone) return res.status(400).json({ error: "missing phone" });
    if (!file_base64) return res.status(400).json({ error: "missing file_base64" });
    const buf = Buffer.from(file_base64, "base64");

    // Sanitize filename — keep only safe chars
    const safeFilename = (origFilename || "document").replace(/[^a-zA-Z0-9._\- ]/g, "_").slice(0, 120);
    // Derive MIME from extension (server-side, more reliable than browser-reported type)
    const ext = safeFilename.split(".").pop().toLowerCase();
    const mime = WA_DOC_MIME[ext] || "application/octet-stream";

    const storedFilename = "ADMIN-DOC-" + Date.now() + "-" + safeFilename;
    const uploadDir = "/docker/wa-webhook-sbsr/static/sentuhrasa-pdf/uploads";
    try { if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true }); } catch (_) {}
    const filePath = uploadDir + "/" + storedFilename;
    fs.writeFileSync(filePath, buf);
    const fileUrl = "https://production.biks.ai/receipts/" + storedFilename;

    log("admin-send-document", "uploading " + safeFilename + " mime=" + mime + " size=" + buf.length);
    var mediaId = await uploadMediaToWhatsApp(filePath, mime);
    await sendWhatsAppDocument(phone, mediaId, safeFilename, caption || "");

    var logText = "[doc: " + fileUrl + " (" + safeFilename + ")]" + (caption ? " " + caption : "");
    safeLog(admin.logOutgoing, phone, logText);
    res.json({ ok: true, url: fileUrl });
  } catch (e) {
    log("admin-send-document", "Error: " + e.message);
    res.status(500).json({ error: e.message });
  }
});

try { admin.mount(app, sendWhatsAppMessage, process.env.ADMIN_PASSWORD); }
catch (e) { log("admin", "mount failed (non-fatal): " + e.message); }

// --- Start ---
app.listen(PORT, () => {
  log("server", "WhatsApp <-> OpenClaw bridge v1.3.0 on port " + PORT);
  connectGateway();
  sbsrSeedProductKnowledge().catch((e) => log("sbsr-memory", "seed fail: " + e.message));
});

function formatFaqForLLM() {
  var faq = [];
  faq.push("===== FAQ SENTUH RASA =====");
  faq.push("[PRODUK & MENU] Varian: Risol Ayam Sayur, Ragout Creamy, Smoked Beef Mayo, Mix. Mix 6pcs=2+2+2, Mix 12pcs=4+4+4.");
  faq.push("[HARGA] 6pcs=Rp51.000, 12pcs=Rp96.000. Min order Rp50.000.");
  faq.push("[ADD-ON] Chili Sauce Rp4.000. Ice Java Tea Rp15.000. Iced Matcha Rp15.000. Thermal bag Rp30.000+2 ice gel. Greeting card Rp3K-5K.");
  faq.push("[HALAL] Proses sertifikasi. Bumil aman. Vegetarian: maaf. Alergi: escalate admin.");
  faq.push("[SIMPAN] 2-3h suhu ruang. 1-2h chiller. 1-2bln freezer. Goreng: minyak 180C. Air fryer: bisa.");
  faq.push("[LOKASI] Jl Nusa Indah Raya Blok O No 10, Cipinang Muara, Jaktim. CP: +62 811 1321 166.");
  faq.push("[KIRIM] Cipinang. Luar kota: Paxel. Kirim GMaps utk cek ongkir.");
  faq.push("[BAYAR] QRIS/transfer. Refund: escalate admin.");
  faq.push("[RESELLER] Starter 4pk=47k. Medium 6pk=46k. Business 10pk=45k. Cafe: diskusi atasan.");
  faq.push("[PROMO] Boleh sebut promo aktif. Jangan janjikan promo lewat.");
  faq.push("[KOMPLAIN] Belum sampai: follow up. Rasa biasa: detail. Rasa basi: jam terima/coba/kondisi. Rusak: foto.");
  faq.push("[REKOMENDASI] Makan langsung -> goreng 6/12. Stock frozen -> 1 pack/varian. Meeting -> 2 box 12 + minuman. Gift -> +thermal +greeting card. Thermal: reguler 8k/max 3 pack, premium 30k/max 6 pack, ice gel 3k.");
  faq.push("ATURAN: Jawab dari FAQ. Alergi/refund: escalate. Promo lewat: jangan janji.");
  return faq.join("\\n");
}

// ═══════════════════════════════════════════════════════════════════
// ── State manager delegations ─────────────────────────────────────
function clearSbsrCheckoutForCancel(f){return stateManager?stateManager.clearCheckoutForCancel(f):false}
function isProtectedPaymentFlowDraft(d){return stateManager?stateManager.isProtectedPaymentFlow(d):false}
function resetSbsrCheckoutState(f){return stateManager?stateManager.resetCheckoutState(f):false}
function hardResetSbsrSession(f){return stateManager?stateManager.hardResetSession(f):true}

// STUBS — deleted functions (migrated to pipeline v2 ctx handlers)
// These stubs keep existing call sites safe. All return false/void.
// Remove after pipeline v2 is production-verified.
// ═══════════════════════════════════════════════════════════════════
function tryHandleDeliveryConfirm(){return false}
function tryHandleInvoiceOk(){return false}
function tryHandleAdminHandoff(){return false}
function tryHandleKitchenReady(){return false}
function tryHandleGlobalAddMore(){return false}
function tryHandleTextVariantSelection(){return false}
function tryHandleCatalogRequest(){return false}
function tryHandleMainMenuQuestionChoice(){return false}
function tryHandleDeliveryMethodSelection(){return false}
function tryHandleBuktiOcrFailedManualReview(){return false}
function tryHandleBuktiAuto(){return false}
function tryHandleWhatsAppLocation(){return false}
function tryHandleWrongInputInLocationStates(){return false}
function tryHandleAddressTextCapture(){return false}
function tryHandleOngkirCheck(){return false}
function tryHandleDestinationCheck(){return false}
function tryHandleUrlEcho(){return false}
function tryHandleCourierOverride(){return false}
function tryHandleAwaitingQuestionFlow(){return false}
function tryHandleQuestionFaq_match(){return false}
function tryHandleAwaitingNameMultilineEarly(){return false}
function tryHandleNameCapture(){return false}
function tryHandleAddonReply(){return false}
function tryHandleMeetingPackageConfirm(){return false}
function tryHandleAddressPinConfirm(){return false}
function tryHandleOocDuringCheckout(){return false}
function tryHandleIgPost(){return false}
function tryHandleIgTopicReply(){return false}
function tryHandleSaldo(){return false}
function tryHandlePOCreate(){return false}
function tryHandlePOApproval(){return false}
function tryHandleIgApproval(){return false}
function tryHandleMissingFormInquiry(){return false}
function tryHandleMissingFormClarification(){return false}
function tryHandleFreeTextOrder(){return false}
function tryHandleOrderConfirm(){return false}

