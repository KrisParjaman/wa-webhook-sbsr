require("dotenv").config({ path: __dirname + "/.env" });
const express = require("express");
const crypto = require("crypto");
const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

// ── PostgreSQL (catalog + conversation storage) ─────────────────────
let pgPool = null;
try {
  const { Pool } = require("pg");
  pgPool = new Pool({ connectionString: process.env.POSTGRES_URL });
  console.error("[pg] pool created");
} catch (e) {
  console.error("[pg] pg module not available — running without PostgreSQL:", e.message);
}

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
let llmClassifier = null;
let addressHandler = null;
let mediaUtils = null;
let ocrUtils = null;
let textUtils = null;
let msgProcessor = null;
let agentCore = null;
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
  llmClassifier = require("./lib/llm-classifier.cjs");
  addressHandler = require("./lib/address-handler.cjs");
  mediaUtils = require("./lib/media-utils.cjs");
  ocrUtils = require("./lib/ocr-utils.cjs");
  textUtils = require("./lib/text-utils.cjs");
  msgProcessor = require("./lib/process-message.cjs");
  agentCore = require("./lib/agent/core.cjs");
} catch (e) {
  console.error("[engine] failed to load modules — running legacy mode:", e.message);
}

// --- Admin inbox module (chat log + /admin panel). Never allow to break bot. ---
let admin;
try { admin = require("./admin.js"); }
catch (e) {
  console.error("[admin] failed to load, using no-op stubs:", e.message);
  admin = { logIncoming:()=>{}, logOutgoing:()=>{}, isPaused:()=>false, setPaused:()=>{}, listChats:()=>[], getChat:()=>({}), stats:()=>({}), safePhone:(p)=>String(p||"").replace(/[^0-9]/g,""), mount:()=>{}, init:()=>{} };
}
// Inject PG pool into admin for dual-write to wa_messages table
if (admin && admin.init && pgPool) admin.init(pgPool);
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

// ── Conversation message retention (PostgreSQL) ─────────────────────
const WA_MSG_RETENTION_DAYS = parseInt(process.env.WA_MSG_RETENTION_DAYS || "90");
const WA_MSG_MAX_PER_PHONE  = parseInt(process.env.WA_MSG_MAX_PER_PHONE  || "500");

async function ensureWaMessagesTable() {
  if (!pgPool) return;
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS wa_messages (
      id         BIGSERIAL PRIMARY KEY,
      phone      TEXT NOT NULL,
      dir        TEXT NOT NULL CHECK (dir IN ('in', 'out')),
      text       TEXT NOT NULL DEFAULT '',
      ts         BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pgPool.query("CREATE INDEX IF NOT EXISTS wa_messages_phone_created ON wa_messages (phone, created_at DESC)");
  console.error("[wa-messages] table ready");
}

async function pruneOldMessages() {
  if (!pgPool) return;
  try {
    const r1 = await pgPool.query(
      "DELETE FROM wa_messages WHERE created_at < now() - ($1 || ' days')::interval",
      [WA_MSG_RETENTION_DAYS]
    );
    const r2 = await pgPool.query(
      `DELETE FROM wa_messages WHERE id IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY phone ORDER BY ts DESC) AS rn
          FROM wa_messages
        ) ranked WHERE rn > $1
      )`,
      [WA_MSG_MAX_PER_PHONE]
    );
    if (r1.rowCount > 0 || r2.rowCount > 0)
      console.error("[wa-messages] pruned: " + r1.rowCount + " expired, " + r2.rowCount + " excess");
  } catch (e) { console.error("[wa-messages] prune error:", e.message); }
}

// Start PG services
if (pgPool) {
  ensureWaMessagesTable()
    .then(function() { pruneOldMessages(); setInterval(pruneOldMessages, 24 * 60 * 60 * 1000); })
    .catch(function(e) { console.error("[wa-messages] init error:", e.message); });
}

// --- Catalog product ID mapping (PostgreSQL + Meta API live sync) ---
const CATALOG_API_TOKEN = process.env.CATALOG_API_TOKEN || "";
const CATALOG_ID = process.env.WA_CATALOG_ID || "1477386560782761";
let catalogMap = {};
let catalogPrices = {};
let catalogAvailability = {};

// Load static catalog-map.json as base
try { catalogMap = JSON.parse(fs.readFileSync("/docker/wa-webhook-sbsr/catalog-map.json", "utf8")); } catch (_) {}

// Refresh catalog from Meta API
function refreshCatalogFromAPI() { return catalogManager ? catalogManager.refreshCatalogFromAPI.apply(null, arguments) : null; }

// Fetch on startup, then every 5 minutes
refreshCatalogFromAPI();
setInterval(refreshCatalogFromAPI, 5 * 60 * 1000);

function lookupProductName() { return catalogManager ? catalogManager.lookupProductName.apply(null, arguments) : null; }
function lookupProductPrice() { return catalogManager ? catalogManager.lookupProductPrice.apply(null, arguments) : null; }
function lookupProductAvailability() { return catalogManager ? catalogManager.lookupProductAvailability.apply(null, arguments) : null; }

var _productCatalogCache = null;
function loadProductCatalog() { return catalogManager ? catalogManager.loadProductCatalog.apply(null, arguments) : null; }
function formatCatalogForLLM() { return catalogManager ? catalogManager.formatCatalogForLLM.apply(null, arguments) : null; }

function formatSbsrFullMenuText() { return catalogManager ? catalogManager.formatSbsrFullMenuText.apply(null, arguments) : null; }

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

function deriveSegmentFromUseCase() { return gsheetSync ? gsheetSync.deriveSegment.apply(null, arguments) : null; }

function derivePreferredProduct() { return gsheetSync ? gsheetSync.derivePreferredProduct.apply(null, arguments) : null; }

function appendNoteSafe() { return gsheetSync ? gsheetSync.appendNote.apply(null, arguments) : null; }

function calcOrderQty() { return gsheetSync ? gsheetSync.calcOrderQty.apply(null, arguments) : null; }

function monthKeyYmd() { return gsheetSync ? gsheetSync.monthKey.apply(null, arguments) : null; }

function computeCustomerMetrics() { return gsheetSync ? gsheetSync.computeMetrics.apply(null, arguments) : null; }

function buildCustomerDbRowFromDraft() { return gsheetSync ? gsheetSync.buildRow.apply(null, arguments) : null; }

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
function downloadWhatsAppMedia() { return mediaUtils ? mediaUtils.downloadMedia.apply(null, arguments) : null; }

// --- Upload image to imgbb ---
function uploadToImgbb() { return mediaUtils ? mediaUtils.uploadToImgbb.apply(null, arguments) : null; }

// --- Handle image message: download, upload, return URL ---
function handleImageMessage() { return mediaUtils ? mediaUtils.handleImage.apply(null, arguments) : null; }

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
function runReceiptOCROnce(){return ocrUtils?ocrUtils.runOnce.apply(null,arguments):null}

function runReceiptOCR(){return ocrUtils?ocrUtils.runOCR.apply(null,arguments):null}

function formatOCRForBot(){return ocrUtils?ocrUtils.formatForBot.apply(null,arguments):null}

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
  if (process.env.SBSR_IDEMPOTENT === 'false') return false; // dedup ON by default
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

function sbsrDraftHasDestination() { return draftStore ? draftStore.hasDestination.apply(null, arguments) : null; }
function isSbsrCheckoutCollectionActive() { return draftStore ? draftStore.isCheckoutActive.apply(null, arguments) : null; }


// === OOC HANDLER V3: handle out-of-context questions during checkout ===

function getSbsrDeterministicMissingStateMessage() { return null; }

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
function sniffMapsLinkFromCustomer() { return false; }

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

// =====================================================
// Semantic Address Match — general-purpose LLM validator for Indonesian addresses.
// Interface: { typedAddress, resolvedMapsAddress }
// Returns: { match: bool, confidence: "high"|"medium"|"low", reason: string } or null
// Fail-open: any error → null → caller uses existing deterministic result.
// =====================================================

function tryHandleAddressAndQuote() { return addressHandler ? addressHandler.tryHandleAddressAndQuote.apply(null, arguments) : null; }

function tryHandleBareMapsUrl() { return null; }
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

function tryHandlePinConfirm() { return false; }

// Send the pin/address echo + soft confirm prompt. Sets state=awaiting_pin_confirm.
// Detect when typed `addressText` and the resolved Maps URL look like they
// describe DIFFERENT places, so the confirm prompt can flag the conflict
// instead of the customer silently proceeding past it. Conservative —
// only flags when ALL of: (a) addressText is real (not "(dari pin)"), (b)
// URL pathname/query has alphabetic-only ≥4-char tokens (real place slug,
// not opaque shortlink hash), (c) NO address token appears in URL slug.
// On uncertainty (shortlink, missing words), returns false — silence is
// safer than false-positive accusations.
function looksLikeAddressPinMismatch(){return textUtils?textUtils.looksLikeAddressPinMismatch.apply(null,arguments):null}

function haversineKm() { return mapsGeocode ? mapsGeocode.haversineKm.apply(null, arguments) : null; }

function geocodeAddressTextBridge() { return mapsGeocode ? mapsGeocode.geocodeAddressTextBridge.apply(null, arguments) : null; }
function buildTypedAddressCandidates() { return mapsGeocode ? mapsGeocode.buildTypedAddressCandidates.apply(null, arguments) : null; }
function geocodeTypedAddressWithFallback() { return mapsGeocode ? mapsGeocode.geocodeTypedAddressWithFallback.apply(null, arguments) : null; }
function reverseGeocodeCoordsBridge() { return mapsGeocode ? mapsGeocode.reverseGeocodeCoordsBridge.apply(null, arguments) : null; }
function resolveLocationDisplayBridge() { return mapsGeocode ? mapsGeocode.resolveLocationDisplayBridge.apply(null, arguments) : null; }




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


function buildSbsrAddonOfferText() { return null; }

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

function tryHandleUseCase_match() { return false; }

const SBSR_PRODUCT_SELECTION_INTENT_RE = /\b(?:frozen|goreng|mix|ayam|smoked|ragout|mayo|6\s*pcs|12\s*pcs|6pcs|12pcs)\b/i;

const SBSR_MEETING_CONFIRM_YES_RE = /^(?:ya|y|ok|oke|okay|okey|lanjut|boleh|mau|gas|deal|setuju|siap)(?:[\s,.]+(?:ya|ok|oke|lanjut|boleh|mau|gas|deal|setuju|siap|kak|aja|deh|nih))*\s*[.!,?]*\s*$/i;
const SBSR_MEETING_CONFIRM_NO_RE = /^(?:tidak|gak|ga|nggak|engga|batal|jangan|belum|nanti|ubah|ganti)(?:[\s,.]+(?:dulu|kak|aja|deh|nih))*\s*[.!,?]*\s*$/i;

function buildSbsrMeetingPackageItems() {
  return [
    { sku: "PKG-MEETING-2X12", name: "Paket Meeting — 2 box isi 12", qty: 1, unit_price: 192000, form: "goreng", pack_size: 12 },
    { sku: "PKG-MEETING-DRINK", name: "Paket Minuman Meeting", qty: 4, unit_price: 15000, form: null, pack_size: null },
  ];
}


function tryHandleUseCaseRouter() { return false; }

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


function isNameTokens(){return textUtils?textUtils.isNameTokens.apply(null,arguments):null}
// Try to extract a customer name from free text. Handles:
//   - "Saya Tania" / "Aku Budi" / "Nama Siti" / "Nama saya Andi" / "Atas nama Joko"
//   - Multi-line: first line might be a prefixed/standalone name, rest is address
//   - Standalone short reply: "Tania" / "Pak Hadi" / "Ngurah Linggih"
// Returns the cleaned name or null.
// Scan recent inbound chat history for a name pattern. Used as a rescue when
// draft.customer_name is missing but the customer typed it earlier (e.g. before
// the name-capture intercept was deployed, or in a multi-line msg the bridge
// missed). Reads /docker/wa-webhook-sbsr/chats/<phone>.json (admin.js storage).
function findNameInChatHistory(){return textUtils?textUtils.findNameInChatHistory.apply(null,arguments):null}
function extractCustomerName(){return textUtils?textUtils.extractCustomerName.apply(null,arguments):null}


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

function tryHandleFaq_match() { return false; }

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



function tryHandleFaq() { return false; }

// =====================================================
// Frozen courier choice (SB-Group 2026-05-07: bot shows both prices, customer picks)
// =====================================================
// Triggered after sendFrozenChoicePrompt set state="awaiting_courier_choice".
// Customer replies "1" or "2" (or "paxel"/"gosend"); we commit the cached
// option from the draft and re-fire tryHandleAddressAndQuote (which now sees
// customer_preference set, so the quote returns the single chosen courier).
function tryHandleFrozenCourierChoice() { return false; }


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
function looksLikeAddress(){return textUtils?textUtils.looksLikeAddress.apply(null,arguments):null}

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

function maybeFireAdminEscalation() { return false; }

function enrichInvoiceWithMaps() { return false; }

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

function sniffCartAckFromAiReply() { return false; }

function maybeAutoQuote() { return false; }

function sniffInvoiceFromAiReply() { return false; }

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

function shouldResetSbsrSessionOnReentry() { return stateManager ? stateManager.shouldResetSessionOnReentry.apply(null, arguments) : null; }

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
function getClarifyCount() { return llmClassifier ? llmClassifier.getClarifyCount.apply(null, arguments) : null; }
function resetClarifyCount() { return llmClassifier ? llmClassifier.resetClarifyCount.apply(null, arguments) : null; }
function incrementClarifyCount() { return llmClassifier ? llmClassifier.incrementClarifyCount.apply(null, arguments) : null; }

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
function isCheckoutActiveState() { return stateManager ? stateManager.isCheckoutActive.apply(null, arguments) : null; }



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


function tryHandlePickupFlow() { return false; }

function tryHandleDeterministicGreeting() { return false; }

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

function tryHandleMissingFormInquiry() { return false; }



// === MISSING-FORM CLARIFICATION: re-parse order after customer clarifies form ===
const MISSING_FORM_CLARIFY_RE = /\b(?:goreng|frozen|matang|mentah|siap\s*makan)\b/i;

function tryHandleMissingFormClarification() { return false; }


function tryHandleFreeTextOrder() { return false; }

function tryHandleOrderConfirm() { return false; }

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

function tryHandleOutOfContextHandoff() { return false; }

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

function llmFirstRouter() { return llmClassifier ? llmClassifier.llmFirstRouter.apply(null, arguments) : null; }

// ═══════════════════════════════════════════════════════════════════
// LLM-FIRST INTENT CLASSIFIER
// ═══════════════════════════════════════════════════════════════════

// ── Natural Reply Generator ────────────────────────────────────────
// LLM generates conversational reply + extracts structured order data.
// Returns { reply, items, use_case_hint } or null.
function generateClassifierReply() { return llmClassifier ? llmClassifier.generateClassifierReply.apply(null, arguments) : null; }

function buildClassifierPrompt() { return llmClassifier ? llmClassifier.buildClassifierPrompt.apply(null, arguments) : null; }

function classifyIntentWithLLM() { return llmClassifier ? llmClassifier.classifyIntentWithLLM.apply(null, arguments) : null; }

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
        if (false /* tryHandleFreeTextOrder stubbed */) {
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
        if (state === "awaiting_order_confirm" && false /* tryHandleOrderConfirm stubbed */) return true;
        if (state === "awaiting_meeting_package_confirm" && false /* tryHandleMeetingPackageConfirm stubbed */) return true;
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
        if (state === "awaiting_order_confirm" && false /* tryHandleOrderConfirm stubbed */) return true;
        if (state === "awaiting_meeting_package_confirm" && false /* tryHandleMeetingPackageConfirm stubbed */) return true;
        return false;
      }

      case "provide_name": {
        if (false /* tryHandleNameCapture stubbed */) return true;
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
        if (false /* tryHandleAddressTextCapture stubbed */) return true;
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
        if (false /* tryHandleFrozenCourierChoice stubbed */) return true;
        if (false /* tryHandlePickupFlow stubbed */) return true;
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
        if (false /* tryHandleFaq stubbed */) return true;
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
    pgPool: pgPool,
    log: log,
  });
  // Warm catalog from PostgreSQL, then start Meta API sync
  if (catalogManager && pgPool) {
    catalogManager.warmStoreConfig().catch(function(e) { console.error("[store-config] startup load failed:", e.message); });
    catalogManager.loadFromDB()
      .then(function() {
        catalogManager.refreshCatalogFromAPI();
        setInterval(function() { catalogManager.refreshCatalogFromAPI(); }, 5 * 60 * 1000);
      })
      .catch(function(e) {
        console.error("[catalog-db] startup load failed:", e.message);
        catalogManager.refreshCatalogFromAPI();
        setInterval(function() { catalogManager.refreshCatalogFromAPI(); }, 5 * 60 * 1000);
      });
  }
  // Init agent-core
  if (agentCore) {
    agentCore.init({ sendToLLM: sendToOpenClaw, sendReply: sendWhatsAppMessage, log: log, loadDraft: loadSbsrDraft, saveDraft: saveSbsrDraft, catalogRef: function() { return loadProductCatalog(); } });
    try { require('./lib/handlers/handler-agent.cjs').init(agentCore); } catch (_) {}
  }
  // Init msg-processor
  if (msgProcessor) msgProcessor.init({ sendToOpenClaw: sendToOpenClaw, sendMessage: sendWhatsAppMessage, log: log, loadDraft: loadSbsrDraft, saveDraft: saveSbsrDraft, secLib: secLib, admin: admin, engineCtx: engineCtx, enginePipeline: enginePipeline, sbsrLlmClassifierEnabled: sbsrLlmClassifierEnabled, ADMIN_PHONES: ADMIN_PHONES, sendReaction: sendReaction, sendTypingIndicator: sendTypingIndicator, sendSbsrDeliveryMethodButtons: sendSbsrDeliveryMethodButtons, sendSbsrAddonOffer: sendSbsrAddonOffer });
  // Init ocr-utils
  if (ocrUtils) ocrUtils.init({ log: log });
  // Init media-utils
  if (mediaUtils) mediaUtils.init({ log: log, waApiVersion: WA_API_VERSION, waAccessToken: WA_ACCESS_TOKEN, imgbbKey: IMGBB_KEY });
  // Init address-handler
  if (addressHandler) addressHandler.init({ sendToOpenClaw: sendToOpenClaw, sendMessage: sendWhatsAppMessage, log: log, loadDraft: loadSbsrDraft, saveDraft: saveSbsrDraft });
  // Init llm-classifier
  if (llmClassifier) llmClassifier.init({ log: log, sendToOpenClaw: sendToOpenClaw, loadDraft: loadSbsrDraft, saveDraft: saveSbsrDraft });
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


// ── Message processor (extracted from handleMessage) ──────────────
function _processMessage(msg, from, messageId, contactName) {
  return msgProcessor ? msgProcessor.processMessage(msg, from, messageId, contactName) : Promise.resolve();
}

async function handleMessage(msg, contacts) {
  const from = msg.from;
  const messageId = msg.id;
  const contactName = contacts?.[0]?.profile?.name || from;

  if (!await _guardMessage(from, messageId, msg)) return;
  _notifyAdminOnMessage(from, contacts);

  try {
    _initEngine();
    await _processMessage(msg, from, messageId, contactName);
  } catch (err) {
    log("error", "Processing message from " + from + ": " + err.message + " (stack: " + (err.stack || "").split("\n")[1]?.trim() + ")");
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

function formatFaqForLLM() { return catalogManager ? catalogManager.formatFaqForLLM.apply(null, arguments) : null; }

// ═══════════════════════════════════════════════════════════════════
// ── State manager delegations ─────────────────────────────────────
function clearSbsrCheckoutForCancel(f){return stateManager?stateManager.clearCheckoutForCancel(f):false}
function isProtectedPaymentFlowDraft() { return stateManager ? stateManager.isProtectedPaymentFlow.apply(null, arguments) : null; }
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

